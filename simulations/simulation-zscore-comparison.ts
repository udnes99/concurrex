/**
 * Z-Score comparison simulation.
 * Runs the same throughput-degradation scenario with z=0.5, 1, 2, 3
 * to visualize how detection sensitivity changes.
 *
 * Run with:
 *   npx tsx libs/kernel/test/Infrastructure/Executor/simulation-zscore-comparison.ts
 *
 * Then open the generated executor-zscore-comparison.html file.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Executor } from "../src/Executor.js";

const PORT = 9878;
const SAMPLE_INTERVAL = 50;

type Snapshot = {
    time: number;
    concurrencyLimit: number;
    inFlight: number;
    queueLength: number;
    dropping: boolean;
    throughputDegraded: boolean;
    requestsPerSec: number;
    errorRate: number;
    logW: number | null;
    logWBar: number | null;
    dLogWBarEwma: number | null;
    se: number;
    zScore: number;
    regulationPhase: string;
    regulationDepth: number;
};

type Scenario = {
    name: string;
    description: string;
    data: Snapshot[];
};

const logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => console.warn("  [executor]", ...args),
    error: () => {},
    fatal: () => {},
    child: () => logger
    // biome-ignore lint/suspicious/noExplicitAny: logger mock
} as any;

let globalDelay = 20;
let activeConnections = 0;
let backpressureEnabled = false;
const backpressureBase = 10;
let globalErrorProbability = 0;

function createBackend(): Promise<ReturnType<typeof createServer>> {
    return new Promise((resolve) => {
        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            activeConnections++;
            const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

            let delay: number;
            if (backpressureEnabled) {
                const load = 1 + activeConnections / 10;
                delay = Math.round(backpressureBase * load * load);
            } else {
                delay = Number(url.searchParams.get("delay")) || globalDelay;
            }

            setTimeout(() => {
                activeConnections--;
                if (Math.random() < globalErrorProbability) {
                    res.writeHead(500, { "Content-Type": "text/plain" });
                    res.end("error");
                } else {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end("ok");
                }
            }, delay);
        });
        server.listen(PORT, () => resolve(server));
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let completionCount = 0;
let errorCount = 0;

async function callBackend(): Promise<void> {
    const res = await fetch(`http://localhost:${PORT}/`);
    await res.text();
    completionCount++;
    if (!res.ok) {
        errorCount++;
        throw new Error(`Backend returned ${res.status}`);
    }
}

function captureSnapshot(
    executor: Executor,
    pool: string,
    startTime: number,
    requestsPerSec: number,
    windowErrorRate: number
): Snapshot {
    const rs = executor.getRegulatorState(pool);
    return {
        time: Math.round(performance.now() - startTime),
        concurrencyLimit: executor.getConcurrencyLimit(pool),
        inFlight: executor.getInFlight(pool),
        queueLength: executor.getQueueLength(pool),
        dropping: executor.isOverloaded(pool),
        throughputDegraded: executor.isThroughputDegraded(pool),
        requestsPerSec: Math.round(requestsPerSec),
        errorRate: Math.round(windowErrorRate * 100) / 100,
        logW: rs.logW,
        logWBar: rs.logWBar,
        dLogWBarEwma: rs.dLogWBarEwma,
        se: rs.se,
        zScore: rs.zScore,
        regulationPhase: rs.regulationPhase,
        regulationDepth: rs.regulationDepth
    };
}

function startSampling(
    executor: Executor,
    pool: string,
    startTime: number,
    data: Snapshot[]
): NodeJS.Timeout {
    let lastCount = completionCount;
    let lastErrorCount = errorCount;
    let lastTime = performance.now();
    return setInterval(() => {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        const dc = completionCount - lastCount;
        const de = errorCount - lastErrorCount;
        const rps = dt > 0 ? dc / dt : 0;
        const windowErrorRate = dc > 0 ? de / dc : 0;
        lastCount = completionCount;
        lastErrorCount = errorCount;
        lastTime = now;
        data.push(captureSnapshot(executor, pool, startTime, rps, windowErrorRate));
    }, SAMPLE_INTERVAL);
}

async function submitAtRate(
    executor: Executor,
    pool: string,
    arrivalIntervalMs: number,
    durationMs: number,
    tasks: Promise<unknown>[]
): Promise<void> {
    const count = Math.floor(durationMs / arrivalIntervalMs);
    for (let i = 0; i < count; i++) {
        tasks.push(executor.run(pool, () => callBackend()).catch(() => {}));
        await sleep(arrivalIntervalMs);
    }
}

async function runDegradationScenario(zScore: number): Promise<Scenario> {
    console.log(
        `\n  Running: z=${zScore} (TIME_CONSTANT=${Math.round(2 / (1 - Math.exp(-1 / (zScore * zScore))))})`
    );
    const executor = new Executor({ logger, zScoreThreshold: zScore });
    executor.start();
    const pool = "test";
    executor.registerPool(pool, {
        baselineConcurrency: 20,
        minimumConcurrency: 2,
        maximumConcurrency: 100,
        delayThreshold: 200,
        controlWindow: 100
    });

    // Warm-up: run 2×TIME_CONSTANT windows of steady traffic so all EWMAs
    // and the second moment reach statistical steady state before
    // the actual test phases begin. Not recorded in charts.
    globalDelay = 10;
    backpressureEnabled = false;
    globalErrorProbability = 0;
    const warmupMs = Math.max(5_000, 2 * executor.timeConstant * 100 + 2_000);
    console.log(`    Warm-up: ${warmupMs}ms (2×TIME_CONSTANT + buffer)...`);
    completionCount = 0;
    errorCount = 0;
    const allTasks: Promise<unknown>[] = [];
    await submitAtRate(executor, pool, 5, warmupMs, allTasks);
    // Don't await allTasks — let warm-up traffic flow seamlessly into
    // Phase 1. Awaiting would create a gap (no arrivals → inFlight drops
    // → log(W) shifts), which z=3's extreme sensitivity detects as a
    // false transient.

    // Start recording after warm-up — charts begin at t=0 with converged state.
    completionCount = 0;
    errorCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Phase 1 (0–12s): Healthy — tasks take ~10ms, arrival at ~200/sec.
    console.log("    Phase 1: Healthy (10ms, 200 req/sec, 12s)...");
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    // Phase 2 (12–24s): Backend degrades — tasks take ~500ms.
    console.log("    Phase 2: Backend degrading (500ms, 12s)...");
    globalDelay = 500;
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    // Phase 3 (24–36s): Recovery — tasks back to ~10ms.
    console.log("    Phase 3: Backend recovering (10ms, 12s)...");
    globalDelay = 10;
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    await Promise.allSettled(allTasks);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    const tc = executor.timeConstant;
    return {
        name: `z = ${zScore} (TIME_CONSTANT = ${tc}, false-positive ≈ ${(100 * (1 - normalCdf(zScore))).toFixed(1)}%)`,
        description:
            `zScoreThreshold=${zScore}, TIME_CONSTANT=${tc}. ` +
            `Baseline: 20, min: 2, max: 100, delayThreshold: 200ms. ` +
            `Warm-up: ${warmupMs}ms (not shown). ` +
            `Phase 1 (0–12s): 10ms backend. Phase 2 (12–24s): 500ms backend. Phase 3 (24–36s): 10ms recovery.`,
        data
    };
}

/** Standard normal CDF approximation (Abramowitz & Stegun). */
function normalCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804014327; // 1/sqrt(2π)
    const p =
        d *
        Math.exp((-x * x) / 2) *
        (t *
            (0.31938153 +
                t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))));
    return x >= 0 ? 1 - p : p;
}

async function main(): Promise<void> {
    console.log("Starting backend server on port", PORT);
    const server = await createBackend();

    console.log("Running Z-Score comparison simulations...\n");

    const scenarios: Scenario[] = [];
    for (const z of [0.5, 1, 2, 3, 5]) {
        scenarios.push(await runDegradationScenario(z));
    }

    for (const s of scenarios) {
        const minLimit = Math.min(...s.data.map((d) => d.concurrencyLimit));
        const maxLimit = Math.max(...s.data.map((d) => d.concurrencyLimit));
        const hadDegradation = s.data.some((d) => d.throughputDegraded);
        console.log(`\n  ${s.name}`);
        console.log(`    Snapshots: ${s.data.length}, Duration: ${s.data.at(-1)?.time}ms`);
        console.log(
            `    Limit range: ${minLimit}–${maxLimit}, Degraded: ${hadDegradation ? "yes" : "no"}`
        );
    }

    generateHtml(scenarios);

    server.close();
    console.log("\nDone.");
}

function generateHtml(scenarios: Scenario[]): void {
    const scenarioBlocks = scenarios
        .map(
            (s, i) =>
                '<div class="scenario">' +
                "<h2>" +
                s.name +
                "</h2>" +
                "<p>" +
                s.description +
                "</p>" +
                '<div class="chart-container"><canvas id="chart-' +
                i +
                '"></canvas></div>' +
                '<div class="legend-note">Shaded red = ProDel dropping &middot; Shaded orange = throughput degraded &middot; Dashed red = error rate</div>' +
                '<div class="chart-label">EWMA Filter State &mdash; log(W) where W = &int;N(t)dt / completions (Little&rsquo;s Law latency)</div>' +
                '<div class="chart-description">Gray dashed = raw log(W) per window (noisy). Blue = EWMA-filtered level (shrinkage-dampened). ' +
                "When the backend degrades, raw log(W) jumps; the filter tracks the genuine shift while dampening noise.</div>" +
                '<div class="chart-container-sm"><canvas id="ewma-' +
                i +
                '"></canvas></div>' +
                '<div class="chart-label">Latency Trend z-Test &mdash; dLogW&#x0304; (change in filtered state per window)</div>' +
                '<div class="chart-description">Green = EWMA of dLogW&#x0304; (trend signal). Gold dashed = &plusmn;1 SE band (second-moment noise level). ' +
                "Red dashed = z &times; SE threshold. Red dots = DEGRADING (z-test fires). " +
                "The test detects sustained upward trends in the EWMA output &mdash; transient spikes are dampened by the filter before reaching this stage.</div>" +
                '<div class="chart-container-sm"><canvas id="ztest-' +
                i +
                '"></canvas></div>' +
                "</div>"
        )
        .join("\n");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Z-Score Comparison</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { font-size: 14px; color: #8b949e; margin-bottom: 32px; }
    .scenario { margin-bottom: 48px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; }
    .scenario h2 { font-size: 18px; color: #f0f6fc; margin-bottom: 4px; }
    .scenario p { font-size: 13px; color: #8b949e; margin-bottom: 16px; line-height: 1.5; }
    .chart-container { position: relative; height: 300px; }
    .chart-container-sm { position: relative; height: 200px; margin-top: 16px; }
    .chart-label { font-size: 12px; color: #8b949e; margin-top: 16px; margin-bottom: 4px; font-weight: 500; }
    .legend-note { font-size: 11px; color: #484f58; margin-top: 8px; }
    .chart-description { font-size: 11px; color: #6e7681; margin-bottom: 8px; line-height: 1.5; }
</style>
</head>
<body>
<h1>Z-Score Threshold Comparison</h1>
<p class="subtitle">Same scenario (throughput degradation + recovery) with different zScoreThreshold values. Lower z = more sensitive, higher false-positive rate.</p>
${scenarioBlocks}
<script>
const scenarios = ${JSON.stringify(scenarios)};
const COLORS = { queue: '#d29922', inFlight: '#3fb950', limit: '#58a6ff', rps: '#bc8cff', errorRate: '#f85149', dropping: 'rgba(248, 81, 73, 0.15)', degraded: 'rgba(210, 153, 34, 0.10)' };
scenarios.forEach((scenario, i) => {
    const labels = scenario.data.map(d => d.time);
    new Chart(document.getElementById('chart-' + i).getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [
            { label: 'Queue Length', data: scenario.data.map(d => d.queueLength), borderColor: COLORS.queue, borderWidth: 1.5, pointRadius: 0, yAxisID: 'y' },
            { label: 'In-Flight', data: scenario.data.map(d => d.inFlight), borderColor: COLORS.inFlight, borderWidth: 1.5, pointRadius: 0, yAxisID: 'y' },
            { label: 'Concurrency Limit', data: scenario.data.map(d => d.concurrencyLimit), borderColor: COLORS.limit, borderWidth: 2, pointRadius: 0, yAxisID: 'y' },
            { label: 'Throughput', data: scenario.data.map(d => d.requestsPerSec), borderColor: COLORS.rps, borderWidth: 1, pointRadius: 0, borderDash: [4, 2], yAxisID: 'y2' },
            { label: 'Error Rate', data: scenario.data.map(d => d.errorRate), borderColor: COLORS.errorRate, borderWidth: 1, pointRadius: 0, borderDash: [2, 2], yAxisID: 'y3' },
            { label: 'Dropping', data: scenario.data.map(d => d.dropping ? 1 : null), backgroundColor: COLORS.dropping, fill: true, borderWidth: 0, pointRadius: 0, yAxisID: 'y4' },
            { label: 'Degraded', data: scenario.data.map(d => d.throughputDegraded ? 1 : null), backgroundColor: COLORS.degraded, fill: true, borderWidth: 0, pointRadius: 0, yAxisID: 'y4' },
        ]},
        options: {
            responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
            scales: {
                x: { ticks: { color: '#8b949e', maxTicksLimit: 20, callback: v => scenario.data[v]?.time + 'ms' }, grid: { color: '#21262d' } },
                y: { position: 'left', title: { display: true, text: 'Tasks', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
                y2: { position: 'right', title: { display: true, text: 'req/s', color: '#8b949e' }, ticks: { color: '#8b949e' }, grid: { display: false } },
                y3: { display: false, min: 0, max: 1 }, y4: { display: false, min: 0, max: 1 },
            },
            plugins: { legend: { labels: { color: '#c9d1d9', usePointStyle: true, pointStyle: 'line' } } },
        },
    });
    new Chart(document.getElementById('ewma-' + i).getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [
            { label: 'log(W) raw', data: scenario.data.map(d => d.logW), borderColor: '#8b949e', borderWidth: 1, pointRadius: 0, borderDash: [3, 3] },
            { label: 'logWBar (filtered)', data: scenario.data.map(d => d.logWBar), borderColor: '#58a6ff', borderWidth: 2, pointRadius: 0 },
        ]},
        options: {
            responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
            scales: { x: { ticks: { color: '#8b949e', maxTicksLimit: 20, callback: v => scenario.data[v]?.time + 'ms' }, grid: { color: '#21262d' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } } },
            plugins: { legend: { labels: { color: '#c9d1d9', usePointStyle: true, pointStyle: 'line' } } },
        },
    });
    new Chart(document.getElementById('ztest-' + i).getContext('2d'), {
        type: 'line',
        data: { labels, datasets: [
            { label: 'dLogWBar EWMA', data: scenario.data.map(d => d.dLogWBarEwma), borderColor: '#3fb950', borderWidth: 1.5, pointRadius: 0 },
            { label: '+SE band', data: scenario.data.map(d => d.se > 0 ? d.se : null), borderColor: '#d29922', borderWidth: 1, pointRadius: 0, borderDash: [4, 2] },
            { label: '-SE band', data: scenario.data.map(d => d.se > 0 ? -d.se : null), borderColor: '#d29922', borderWidth: 1, pointRadius: 0, borderDash: [4, 2] },
            { label: 'DEGRADING', data: scenario.data.map(d => d.throughputDegraded ? d.dLogWBarEwma : null), borderColor: '#f85149', borderWidth: 0, pointRadius: 4, pointBackgroundColor: '#f85149' },
        ]},
        options: {
            responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
            scales: { x: { ticks: { color: '#8b949e', maxTicksLimit: 20, callback: v => scenario.data[v]?.time + 'ms' }, grid: { color: '#21262d' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } } },
            plugins: { legend: { labels: { color: '#c9d1d9', usePointStyle: true, pointStyle: 'line' } } },
        },
    });
});
</script>
</body>
</html>`;

    const dir = dirname(fileURLToPath(import.meta.url));
    const outPath = join(dir, "executor-zscore-comparison.html");
    writeFileSync(outPath, html);
    console.log(`\n  Output: ${outPath}`);
}

main().catch(console.error);
