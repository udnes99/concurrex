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
import { Executor } from "../src/Executor.js";
import { generateJsonOutput } from "./output.js";
import { generateHtmlFromJson } from "./generate-html.js";

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

    const jsonPath = generateJsonOutput(import.meta.url, "simulation-zscore-comparison", scenarios, {
        title: "Z-Score Threshold Comparison",
        subtitle: "Same scenario (throughput degradation + recovery) with different zScoreThreshold values. Lower z = more sensitive, higher false-positive rate."
    });
    generateHtmlFromJson(jsonPath);

    server.close();
    console.log("\nDone.");
}

main().catch(console.error);
