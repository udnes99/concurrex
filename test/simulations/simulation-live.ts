/**
 * Live Executor simulation against a real HTTP backend.
 * No fake timers — real network calls, real concurrency, real time.
 *
 * Run with:
 *   npx tsx libs/kernel/test/Infrastructure/Executor/simulation-live.ts
 *
 * Then open the generated executor-simulation-live.html file.
 *
 * Timing notes:
 *   ESS = 9, controlWindow = 100ms → one ESS evaluation every ~900ms.
 *   Each phase should run ≥10s to show ≥10 ESS evaluations and let
 *   the convergent slow start pattern become visible.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Executor } from "../../src/Executor.js";

// ── Configuration ────────────────────────────────────────────────────

const PORT = 9877;
const SAMPLE_INTERVAL = 50; // ms between metric snapshots

// ── Types ────────────────────────────────────────────────────────────

type Snapshot = {
    time: number;
    concurrencyLimit: number;
    inFlight: number;
    queueLength: number;
    dropping: boolean;
    throughputDegraded: boolean;
    requestsPerSec: number;
    errorRate: number;
    // WoLF filter state
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

// ── Logger stub ──────────────────────────────────────────────────────

const logger = {
    trace: () => {},
    debug: () => {},
    info: (...args: unknown[]) => console.log("  [executor]", ...args),
    warn: (...args: unknown[]) => console.warn("  [executor]", ...args),
    error: () => {},
    fatal: () => {},
    child: () => logger
    // biome-ignore lint/suspicious/noExplicitAny: logger mock
} as any;

// ── Backend server ───────────────────────────────────────────────────
// A simple HTTP server where latency is controlled per-request via
// a query parameter, or falls back to a global default.

let globalDelay = 20; // ms — can be changed mid-scenario
let backpressureEnabled = false; // when true, latency scales with concurrent requests
let backpressureBase = 10; // base latency when backpressure is enabled
let globalErrorProbability = 0; // 0–1: probability of returning a 500 error
let activeConnections = 0;

function createBackend(): Promise<ReturnType<typeof createServer>> {
    return new Promise((resolve) => {
        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            activeConnections++;
            const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

            let delay: number;
            if (backpressureEnabled) {
                // Model real-world backpressure: latency = base * (1 + connections/10)²
                // At 10 connections: 4x base. At 20: 9x. At 50: 36x.
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

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared completion counter — reset per scenario. */
let completionCount = 0;

let errorCount = 0;

async function callBackend(delay?: number): Promise<void> {
    const url =
        delay != null ? `http://localhost:${PORT}/?delay=${delay}` : `http://localhost:${PORT}/`;
    const res = await fetch(url);
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

/** Sample metrics at regular intervals for the given duration. */
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
        const dt = (now - lastTime) / 1000; // seconds
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

/** Submit tasks at a given arrival rate for a duration. Returns all promises. */
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

// ── Scenarios ────────────────────────────────────────────────────────

async function scenarioSteadyState(): Promise<Scenario> {
    console.log("\n  Running: Steady State");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "steady";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 1,
        maximumConcurrency: 50,
        delayThreshold: 200,
        controlWindow: 100
    });

    completionCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Steady arrival for 15s: ~1 task every 10ms, each taking ~20ms.
    // Well within baseline capacity (10 slots / 20ms = 500/sec >> 100/sec arrival).
    // Expect: limit stays at baseline, no regulator activation, no CoDel.
    globalDelay = 20;
    const tasks: Promise<unknown>[] = [];
    await submitAtRate(executor, pool, 10, 15_000, tasks);
    await Promise.allSettled(tasks);
    await sleep(300);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Steady State",
        description:
            "Baseline: 10, max: 50, delayThreshold: 200ms, controlWindow: 100ms. " +
            "1500 tasks arrive every ~10ms over 15s, each taking ~20ms. " +
            "Arrival rate (100/sec) well within capacity (500/sec at baseline). " +
            "Expect: limit stays at baseline, gravity pulls down any drift. " +
            "~16 ESS evaluations. No CoDel, no regulator activation.",
        data
    };
}

async function scenarioBurstAbsorption(): Promise<Scenario> {
    console.log("\n  Running: Burst Absorption");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "burst";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 1,
        maximumConcurrency: 200,
        delayThreshold: 30_000,
        controlWindow: 100
    });

    completionCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Phase 1 (0–12s): Steady load to warm up EWMAs. ~13 ESS evaluations.
    // 100ms backend, 50/sec arrival. Capacity at baseline 10: 100/sec > 50/sec. No queue.
    globalDelay = 100;
    const allTasks: Promise<unknown>[] = [];
    await submitAtRate(executor, pool, 20, 12_000, allTasks);

    // Phase 2: Sudden burst — 2000 tasks dumped at once on top of steady load.
    // Backend 100ms, baseline 10 → capacity = 100/sec → takes ~20s to drain 2000 tasks.
    // Convergent growth should ramp limit up significantly to absorb faster.
    // High delayThreshold (30s) prevents CoDel from dropping — shows pure regulator growth.
    console.log("    Burst: 2000 tasks at once...");
    for (let i = 0; i < 2000; i++) {
        allTasks.push(executor.run(pool, () => callBackend()).catch(() => {}));
    }

    // Phase 3 (after burst): Continue steady for 15s to show gravity recovery.
    await submitAtRate(executor, pool, 20, 15_000, allTasks);
    await Promise.allSettled(allTasks);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Burst Absorption",
        description:
            "Baseline: 10, max: 200, delayThreshold: 30s, controlWindow: 100ms. " +
            "Phase 1 (0–12s): steady load at 50/sec, 100ms latency — warms up EWMAs (~13 ESS evals). " +
            "Phase 2: 2000 tasks dumped at once, backend still 100ms. " +
            "At baseline 10, draining 2000 takes ~20s — convergent growth should ramp up to absorb faster. " +
            "Phase 3 (burst+15s): steady load continues — gravity snaps limit back to baseline. " +
            "CoDel disabled (30s threshold) — shows pure regulator growth without interference.",
        data
    };
}

async function scenarioThroughputDegradation(): Promise<Scenario> {
    console.log("\n  Running: Throughput Degradation & Recovery");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "degrade";
    executor.registerPool(pool, {
        baselineConcurrency: 20,
        minimumConcurrency: 2,
        maximumConcurrency: 100,
        delayThreshold: 200,
        controlWindow: 100
    });

    completionCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    const allTasks: Promise<unknown>[] = [];

    // Phase 1 (0–12s): Healthy — tasks take ~10ms, arrival at ~200/sec.
    // Capacity at baseline 20: 20/10ms × 1000 = 2000/sec >> 200/sec. No queue.
    // ~13 ESS evaluations. EWMAs well established.
    globalDelay = 10;
    console.log("    Phase 1: Healthy (10ms, 200 req/sec, 12s)...");
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    // Phase 2 (12–24s): Backend degrades — tasks take ~500ms.
    // Capacity at 20 slots: 20/500ms × 1000 = 40/sec << 200/sec arrival.
    // Queue explodes, W rises, regulator detects and decreases.
    // ~13 ESS evaluations. Shows retraction of any prior growth, then fresh decrease.
    console.log("    Phase 2: Backend degrading (500ms, 12s)...");
    globalDelay = 500;
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    // Phase 3 (24–36s): Recovery — tasks back to ~10ms.
    // regulator detects stable dW, queue pressure → convergent growth restarts.
    // ~13 ESS evaluations. Shows recovery to baseline.
    console.log("    Phase 3: Backend recovering (10ms, 12s)...");
    globalDelay = 10;
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    await Promise.allSettled(allTasks);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Throughput Degradation & Recovery",
        description:
            "Baseline: 20, min: 2, max: 100, delayThreshold: 200ms, controlWindow: 100ms. " +
            "Continuous arrival at 200 req/sec for 36s, no gaps between phases. " +
            "Phase 1 (0–12s): backend 10ms — healthy, ~13 ESS evals. " +
            "Phase 2 (12–24s): backend 500ms — capacity collapses, regulator decreases (retraction + fresh ramp). " +
            "Phase 3 (24–36s): backend 10ms — regulator re-grows cautiously. CoDel sheds stale entries.",
        data
    };
}

async function scenarioDemandSpike(): Promise<Scenario> {
    console.log("\n  Running: Demand Spike (Healthy Processing)");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "demand";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        maximumConcurrency: 100,
        delayThreshold: 5000,
        controlWindow: 100
    });

    completionCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Backend is 50ms THROUGHOUT — no latency change, only arrival rate changes.
    // This isolates pure exponential growth from degradation detection.
    globalDelay = 50;

    // Phase 1 (0–10s): Establish baseline with steady load.
    // 50ms backend, 50/sec arrival. Capacity at baseline 10: 200/sec >> 50/sec. No queue.
    const warmup: Promise<unknown>[] = [];
    console.log("    Phase 1: Baseline warmup (50ms backend, 50 req/sec, 10s)...");
    await submitAtRate(executor, pool, 20, 10_000, warmup);
    await Promise.allSettled(warmup);

    // Phase 2 (10–30s): Sustained high demand — 1000 req/sec, 50ms latency.
    // At baseline 10: capacity = 10/50ms × 1000 = 200/sec. Arrival = 1000/sec.
    // Must grow to ~50 concurrent to keep up.
    // 20s = ~22 ESS evaluations. Shows full convergent slow start growth.
    // High delayThreshold prevents CoDel from interfering with the growth display.
    console.log("    Phase 2: Sustained high demand (1000 req/sec, 50ms backend, 20s)...");
    const spike: Promise<unknown>[] = [];
    await submitAtRate(executor, pool, 1, 20_000, spike);

    // Phase 3 (30–40s): Demand drops back to normal.
    // Shows gravity pulling the limit back to baseline.
    console.log("    Phase 3: Normal demand (50 req/sec, 10s)...");
    const recovery: Promise<unknown>[] = [];
    await submitAtRate(executor, pool, 20, 10_000, recovery);

    await Promise.allSettled([...spike, ...recovery]);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Demand Spike (Healthy Processing)",
        description:
            "Baseline: 10, max: 100, delayThreshold: 5000ms, controlWindow: 100ms. " +
            "Backend is 50ms THROUGHOUT — only arrival rate changes, isolating pure growth. " +
            "Phase 1 (0–10s): 50 req/sec warmup (~11 ESS evals). " +
            "Phase 2 (10–30s): sustained 1000 req/sec — must grow from 10 to ~50 (~22 ESS evals). " +
            "Shows convergent slow start: step(1), step(2), ..., accelerating toward exponential doubling. " +
            "Phase 3 (30–40s): demand drops — gravity pulls limit back to baseline.",
        data
    };
}

async function scenarioFullOverload(): Promise<Scenario> {
    console.log("\n  Running: Full Overload (CoDel + Regulator Decrease)");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "overload";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        maximumConcurrency: 20,
        delayThreshold: 100,
        controlWindow: 100
    });

    completionCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Phase 1 (0–12s): Healthy baseline with warm-up.
    globalDelay = 15;
    const phase1: Promise<unknown>[] = [];
    console.log("    Phase 1: Baseline warmup (12s)...");
    await submitAtRate(executor, pool, 10, 12_000, phase1);
    await Promise.allSettled(phase1);

    // Phase 2 (12–30s): Sustained backend degradation + high arrival rate.
    // Backend 400ms, arrival every 10ms = 100/sec.
    // Capacity at 10 slots: 10/400ms × 1000 = 25/sec << 100/sec.
    // Both CoDel and the regulator activate: CoDel sheds stale entries, regulator decreases concurrency.
    // 18s = ~20 ESS evaluations. Shows retraction then fresh decrease.
    console.log("    Phase 2: Backend degrading (400ms, 18s)...");
    globalDelay = 400;
    const phase2: Promise<unknown>[] = [];
    await submitAtRate(executor, pool, 10, 18_000, phase2);
    await Promise.allSettled(phase2);

    // Phase 3 (30–42s): Recovery.
    console.log("    Phase 3: Backend recovering (15ms, 12s)...");
    globalDelay = 15;
    const phase3: Promise<unknown>[] = [];
    await submitAtRate(executor, pool, 10, 12_000, phase3);
    await Promise.allSettled(phase3);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Full Overload (CoDel + Regulator Decrease)",
        description:
            "Baseline: 10, min: 2, max: 20, delayThreshold: 100ms, controlWindow: 100ms. " +
            "Phase 1 (0–12s): 100 req/sec at 15ms — EWMA warm-up (~13 ESS evals). " +
            "Phase 2 (12–30s): backend 400ms, 100 req/sec — both mechanisms fire (~20 ESS evals). " +
            "CoDel drops stale entries, regulator decreases concurrency via retraction then fresh ramp. " +
            "Phase 3 (30–42s): backend 15ms — system restores. Shows recovery growth.",
        data
    };
}

async function scenarioGradualRamp(): Promise<Scenario> {
    console.log("\n  Running: Gradual Ramp-Up");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "ramp";
    executor.registerPool(pool, {
        baselineConcurrency: 5,
        minimumConcurrency: 1,
        maximumConcurrency: 100,
        delayThreshold: 500,
        controlWindow: 100
    });

    completionCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Backend delay = 50ms throughout.
    // At baseline 5: capacity = 5/50ms × 1000 = 100/sec.
    // Ramp through arrival rates, each sustained for 10s (~11 ESS evals per step).
    // This shows how the regulator tracks a gradually increasing load.
    globalDelay = 50;
    const allPromises: Promise<unknown>[] = [];

    for (const [interval, label] of [
        [20, "50/sec"], // 50/sec — within baseline capacity
        [10, "100/sec"], // 100/sec — at baseline capacity, queue starts forming
        [5, "200/sec"], // 200/sec — 2× baseline, regulator must grow to ~10
        [3, "333/sec"], // 333/sec — needs ~17 concurrent
        [2, "500/sec"] // 500/sec — needs ~25 concurrent
    ] as const) {
        console.log(`    Arrival rate: ${label} (${interval}ms interval, 10s)...`);
        await submitAtRate(executor, pool, interval, 10_000, allPromises);
    }

    // Phase 6: Cool-down — low arrival rate so queue drains and gravity kicks in.
    console.log("    Cool-down: 20/sec (50ms interval, 10s)...");
    await submitAtRate(executor, pool, 50, 10_000, allPromises);
    await Promise.allSettled(allPromises);
    await sleep(2000);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Gradual Ramp-Up & Recovery",
        description:
            "Baseline: 5, max: 100, delayThreshold: 500ms, controlWindow: 100ms. " +
            "Backend delay: 50ms throughout. Arrival rate increases in 10s steps: " +
            "50/sec → 100/sec → 200/sec → 333/sec → 500/sec, then drops to 20/sec for 10s. " +
            "Each step runs ~11 ESS evaluations. regulator tracks the increasing load, " +
            "growing the limit in convergent slow start steps. " +
            "Cool-down shows gravity pulling limit back to baseline.",
        data
    };
}

async function scenarioBackpressure(): Promise<Scenario> {
    console.log("\n  Running: Backend Backpressure");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "backpressure";
    executor.registerPool(pool, {
        baselineConcurrency: 20,
        minimumConcurrency: 2,
        maximumConcurrency: 100,
        delayThreshold: 200,
        controlWindow: 100
    });

    completionCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Backpressure model: latency = base * (1 + connections/10)²
    // At 20 connections (baseline): 10 * (1+2)² = 90ms → capacity ~222/sec
    // At 50 connections: 10 * (1+5)² = 360ms → capacity ~139/sec
    // At 100 connections: 10 * (1+10)² = 1210ms → capacity ~83/sec
    // More concurrency → worse throughput. regulator should detect and decrease.
    backpressureEnabled = true;
    backpressureBase = 10;

    const allTasks: Promise<unknown>[] = [];

    // Phase 1 (0–20s): moderate load — 200 req/sec. Backend handles at baseline.
    // At 20 concurrent + 90ms latency: capacity ~222/sec > 200/sec. Slight queue.
    // ~22 ESS evaluations. Long warm-up to establish stable EWMAs and variance.
    console.log("    Phase 1: Moderate load (200 req/sec, 20s)...");
    await submitAtRate(executor, pool, 5, 20_000, allTasks);

    // Phase 2 (20–40s): heavy load — 500 req/sec. Backend buckles.
    // Queue builds, regulator tries to grow, but more concurrency = worse latency.
    // dW goes positive → regulator detects and retracts/decreases.
    // 20s = ~22 ESS evaluations. Shows the growth→retraction→decrease pattern.
    console.log("    Phase 2: Heavy load (500 req/sec, 20s)...");
    await submitAtRate(executor, pool, 2, 20_000, allTasks);

    // Phase 3 (40–55s): load drops back — 100 req/sec.
    // At reduced concurrency + lower load: backend latency drops.
    // regulator detects stable dW, queue pressure → cautious growth.
    // ~16 ESS evaluations. Shows recovery.
    console.log("    Phase 3: Load dropping (100 req/sec, 15s)...");
    await submitAtRate(executor, pool, 10, 15_000, allTasks);

    await Promise.allSettled(allTasks);
    await sleep(500);

    backpressureEnabled = false;

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Backend Backpressure",
        description:
            "Baseline: 20, min: 2, max: 100, delayThreshold: 200ms, controlWindow: 100ms. " +
            "Backend models backpressure: latency = base × (1 + connections/10)². " +
            "At 20 connections: ~90ms. At 50: ~360ms. At 100: ~1210ms. " +
            "Phase 1 (0–12s): 200 req/sec — baseline handles it (~13 ESS evals). " +
            "Phase 2 (12–27s): 500 req/sec — regulator may try to grow, but more concurrency = worse latency. " +
            "dW goes positive → regulator retracts growth then decreases (~16 ESS evals). " +
            "Phase 3 (27–39s): 100 req/sec — system recovers (~13 ESS evals). " +
            "Key: growing concurrency is the wrong move — it makes things worse.",
        data
    };
}

// ── Error scenarios ──────────────────────────────────────────────────

async function scenarioWidespreadErrors(): Promise<Scenario> {
    console.log("\n  Running: Widespread Errors (dErrorRate + Lockout)");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "errors";
    executor.registerPool(pool, {
        baselineConcurrency: 20,
        minimumConcurrency: 2,
        maximumConcurrency: 50,
        delayThreshold: 200,
        controlWindow: 100
    });

    completionCount = 0;
    errorCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    const allTasks: Promise<unknown>[] = [];

    // Phase 1 (0–12s): Healthy — no errors, 200 req/sec, 20ms latency.
    // Warms up EWMAs. Error rate = 0, spread = 0.
    globalDelay = 20;
    globalErrorProbability = 0;
    console.log("    Phase 1: Healthy (0% errors, 12s)...");
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    // Phase 2 (12–24s): Widespread errors — 80% failure rate.
    // Backend responds fast (20ms) but 80% of responses are 500s.
    // dErrorRate should spike → decrease. Error spread across all transient lanes.
    console.log("    Phase 2: Widespread errors (80% failure, 12s)...");
    globalErrorProbability = 0.8;
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    // Phase 3 (24–30s): Total lockout — 100% failure.
    // dErrorRate ≈ 0 (rate stopped changing). Lockout test should sustain decrease.
    console.log("    Phase 3: Total lockout (100% failure, 6s)...");
    globalErrorProbability = 1.0;
    await submitAtRate(executor, pool, 5, 6_000, allTasks);

    // Phase 4 (30–42s): Recovery — errors stop.
    // Error rate drops, concurrency should recover via gravity/growth.
    console.log("    Phase 4: Recovery (0% errors, 12s)...");
    globalErrorProbability = 0;
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    await Promise.allSettled(allTasks);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Widespread Errors (dErrorRate + Lockout)",
        description:
            "Baseline: 20, min: 2, max: 50, delayThreshold: 200ms. Backend 20ms throughout. " +
            "Phase 1 (0–12s): healthy, 200 req/sec — EWMA warm-up. " +
            "Phase 2 (12–24s): 80% errors — dErrorRate spikes, regulator decreases. " +
            "Phase 3 (24–30s): 100% errors — dErrorRate ≈ 0 but lockout test sustains decrease. " +
            "Phase 4 (30–42s): errors stop — error rate decays, concurrency recovers. " +
            "Shows dErrorRate for onset, lockout for sustained total failure.",
        data
    };
}

async function scenarioLocalizedErrors(): Promise<Scenario> {
    console.log("\n  Running: Localized Errors (Per-Lane Shedding)");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "localized";
    executor.registerPool(pool, {
        baselineConcurrency: 20,
        minimumConcurrency: 2,
        maximumConcurrency: 50,
        delayThreshold: 200,
        controlWindow: 100
    });

    completionCount = 0;
    errorCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    // Production-like: 50 lanes at high arrival rate (2ms interval = 500 req/sec).
    // Backend 20ms → at baseline 20: capacity = 1000/sec > 500/sec. No queue.
    // 1 bad lane out of 50 → 2% error rate. With ~10 concurrent tasks,
    // the bad lane's instant failures are a small fraction of completions.
    // Concurrency should NOT decrease — per-lane shedding handles it.
    globalDelay = 20;
    globalErrorProbability = 0;

    const allTasks: Promise<unknown>[] = [];
    const LANE_COUNT = 50;

    // Phase 1 (0–12s): Healthy warm-up across 50 lanes.
    console.log("    Phase 1: Healthy warm-up (50 lanes, 500 req/sec, 12s)...");
    for (let t = 0; t < 12_000; t += 2) {
        const lane = `lane-${t % LANE_COUNT}`;
        allTasks.push(executor.run(pool, () => callBackend(), { lane }).catch(() => {}));
        await sleep(2);
    }

    // Phase 2 (12–30s): 1 lane fails, 49 succeed. Mixed traffic.
    // Global error rate ��� 2% (1/50). With high throughput, the bad lane's
    // instant failures barely affect W. Per-lane shedding handles the bad lane.
    console.log("    Phase 2: 1 bad lane + 49 good lanes (18s)...");
    for (let t = 0; t < 18_000; t += 2) {
        const laneIndex = t % LANE_COUNT;
        const lane = `lane-${laneIndex}`;
        if (laneIndex === 0) {
            // Bad lane: always throws
            allTasks.push(
                executor
                    .run(
                        pool,
                        (): void => {
                            throw new Error("lane failure");
                        },
                        { lane }
                    )
                    .catch(() => {})
            );
        } else {
            allTasks.push(executor.run(pool, () => callBackend(), { lane }).catch(() => {}));
        }
        await sleep(2);
    }

    // Phase 3 (30–42s): All lanes healthy again.
    console.log("    Phase 3: All lanes healthy (12s)...");
    for (let t = 0; t < 12_000; t += 2) {
        const lane = `lane-${t % LANE_COUNT}`;
        allTasks.push(executor.run(pool, () => callBackend(), { lane }).catch(() => {}));
        await sleep(2);
    }

    await Promise.allSettled(allTasks);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Localized Errors (Per-Lane Shedding)",
        description:
            "Baseline: 20, min: 2, max: 50, delayThreshold: 200ms. Backend 20ms, healthy. " +
            "Phase 1 (0–12s): 50 persistent lanes, 500 req/sec — EWMA warm-up. " +
            "Phase 2 (12–30s): lane-0 always fails, lanes 1–49 succeed. " +
            "Global error rate ≈ 2% (1/50 lanes). High throughput dilutes contamination. " +
            "Regulator should NOT decrease. Per-lane shedding handles lane-0. " +
            "Phase 3 (30–42s): all lanes healthy — system stable. " +
            "Shows that localized errors don't trigger pool-wide regulation at production load.",
        data
    };
}

async function scenarioErrorCapacityOverload(): Promise<Scenario> {
    console.log("\n  Running: Error-Based Capacity Overload");
    const executor = new Executor({ logger });
    executor.start();
    const pool = "errcap";
    executor.registerPool(pool, {
        baselineConcurrency: 30,
        minimumConcurrency: 2,
        maximumConcurrency: 50,
        delayThreshold: 500,
        controlWindow: 100
    });

    completionCount = 0;
    errorCount = 0;
    const data: Snapshot[] = [];
    const startTime = performance.now();
    const sampler = startSampling(executor, pool, startTime, data);

    const allTasks: Promise<unknown>[] = [];

    // Phase 1 (0–12s): Healthy baseline. Backend fast, no errors.
    globalDelay = 10;
    globalErrorProbability = 0;
    console.log("    Phase 1: Healthy (10ms, 0% errors, 12s)...");
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    // Phase 2 (12–30s): Backend starts failing under load — 50% errors, fast response.
    // This simulates "baseline concurrency set too high" — the downstream can't handle
    // 30 concurrent requests. Error rate + spread trigger decrease.
    // As concurrency drops, error rate should also drop (capacity-related).
    console.log("    Phase 2: Capacity overload (50% errors, 10ms, 18s)...");
    globalErrorProbability = 0.5;
    await submitAtRate(executor, pool, 5, 18_000, allTasks);

    // Phase 3 (30–42s): Downstream recovers — errors stop.
    console.log("    Phase 3: Recovery (0% errors, 12s)...");
    globalErrorProbability = 0;
    await submitAtRate(executor, pool, 5, 12_000, allTasks);

    await Promise.allSettled(allTasks);
    await sleep(500);

    clearInterval(sampler);
    data.push(captureSnapshot(executor, pool, startTime, 0, 0));
    executor.stop();

    return {
        name: "Error-Based Capacity Overload",
        description:
            "Baseline: 30, min: 2, max: 50, delayThreshold: 500ms. Backend 10ms throughout. " +
            "Phase 1 (0–12s): healthy — warm-up. " +
            "Phase 2 (12–30s): 50% errors, fast response (10ms). " +
            "Simulates capacity overload where baseline is too high. " +
            "dErrorRate fires, regulator decreases. Sawtooth oscillates toward equilibrium. " +
            "Phase 3 (30–42s): errors stop — system recovers. " +
            "Shows error-driven regulation for capacity-related failures.",
        data
    };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("Starting backend server on port", PORT);
    const server = await createBackend();

    console.log("Running live Executor simulations...\n");

    const scenarios: Scenario[] = [];

    scenarios.push(await scenarioSteadyState());
    scenarios.push(await scenarioBurstAbsorption());
    scenarios.push(await scenarioThroughputDegradation());
    scenarios.push(await scenarioDemandSpike());
    scenarios.push(await scenarioFullOverload());
    scenarios.push(await scenarioGradualRamp());
    scenarios.push(await scenarioBackpressure());
    scenarios.push(await scenarioWidespreadErrors());
    scenarios.push(await scenarioLocalizedErrors());
    scenarios.push(await scenarioErrorCapacityOverload());

    for (const s of scenarios) {
        const maxQueue = Math.max(...s.data.map((d) => d.queueLength));
        const maxInFlight = Math.max(...s.data.map((d) => d.inFlight));
        const maxLimit = Math.max(...s.data.map((d) => d.concurrencyLimit));
        const hadDrops = s.data.some((d) => d.dropping);
        const hadDegradation = s.data.some((d) => d.throughputDegraded);
        console.log(`\n  ${s.name}`);
        console.log(`    Snapshots: ${s.data.length}, Duration: ${s.data.at(-1)?.time}ms`);
        const minLimit = Math.min(...s.data.map((d) => d.concurrencyLimit));
        console.log(
            `    Peak queue: ${maxQueue}, Peak in-flight: ${maxInFlight}, Limit: ${minLimit}–${maxLimit}`
        );
        console.log(
            `    CoDel drops: ${hadDrops ? "yes" : "no"}, Latency degraded: ${hadDegradation ? "yes" : "no"}`
        );
    }

    generateHtml(scenarios);

    server.close();
    console.log("\nDone.");
}

// ── HTML generation ──────────────────────────────────────────────────

function generateHtml(scenarios: Scenario[]): void {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Executor Live Simulation</title>
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
</style>
</head>
<body>
<h1>Executor &ndash; Live Simulation</h1>
<p class="subtitle">Real HTTP backend, real concurrency, real time. CoDel + Convergent Throughput Regulator (Little's Law + Error Rate).</p>

${scenarios
    .map(
        (s, i) => `
<div class="scenario">
    <h2>${s.name}</h2>
    <p>${s.description}</p>
    <div class="chart-container"><canvas id="chart-${i}"></canvas></div>
    <div class="legend-note">
        Shaded red = CoDel dropping &middot; Shaded orange = throughput degraded (latency or error) &middot; Dashed red = error rate
    </div>
    <div class="chart-label">WoLF-EWMA Filter State</div>
    <div class="chart-container-sm"><canvas id="wolf-${i}"></canvas></div>
    <div class="chart-label">Latency Trend z-Test</div>
    <div class="chart-container-sm"><canvas id="ztest-${i}"></canvas></div>
</div>
`
    )
    .join("\n")}

<script>
const scenarios = ${JSON.stringify(scenarios)};

const COLORS = {
    queue: '#d29922',
    inFlight: '#3fb950',
    limit: '#58a6ff',
    rps: '#bc8cff',
    errorRate: '#f85149',
    dropping: 'rgba(248, 81, 73, 0.15)',
    degraded: 'rgba(210, 153, 34, 0.10)',
};

scenarios.forEach((scenario, i) => {
    const ctx = document.getElementById('chart-' + i).getContext('2d');
    const labels = scenario.data.map(d => d.time);

    new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'Queue Length',
                    data: scenario.data.map(d => d.queueLength),
                    borderColor: COLORS.queue,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    order: 3,
                },
                {
                    label: 'In-Flight',
                    data: scenario.data.map(d => d.inFlight),
                    borderColor: COLORS.inFlight,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    order: 2,
                },
                {
                    label: 'Concurrency Limit',
                    data: scenario.data.map(d => d.concurrencyLimit),
                    borderColor: COLORS.limit,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    order: 1,
                },
                {
                    label: 'Requests/sec',
                    data: scenario.data.map(d => d.requestsPerSec),
                    borderColor: COLORS.rps,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.2,
                    fill: false,
                    yAxisID: 'yRps',
                    order: 0,
                },
                {
                    label: 'Error Rate',
                    data: scenario.data.map(d => d.errorRate),
                    borderColor: COLORS.errorRate,
                    borderWidth: 1.5,
                    borderDash: [4, 2],
                    pointRadius: 0,
                    tension: 0.2,
                    fill: false,
                    yAxisID: 'yErrorRate',
                    order: 0,
                },
                {
                    label: 'CoDel Dropping',
                    data: scenario.data.map(d => d.dropping ? 1 : null),
                    backgroundColor: COLORS.dropping,
                    borderWidth: 0,
                    pointRadius: 0,
                    fill: 'origin',
                    spanGaps: false,
                    yAxisID: 'yBand',
                    order: 5,
                },
                {
                    label: 'Latency Degraded',
                    data: scenario.data.map(d => d.throughputDegraded ? 1 : null),
                    backgroundColor: COLORS.degraded,
                    borderWidth: 0,
                    pointRadius: 0,
                    fill: 'origin',
                    spanGaps: false,
                    yAxisID: 'yBand',
                    order: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { color: '#8b949e', usePointStyle: true, pointStyle: 'line', font: { size: 11 } },
                },
                tooltip: {
                    backgroundColor: '#1c2128',
                    titleColor: '#f0f6fc',
                    bodyColor: '#c9d1d9',
                    borderColor: '#30363d',
                    borderWidth: 1,
                    callbacks: {
                        title: (items) => 't = ' + items[0].label + 'ms',
                        label: (item) => {
                            if (item.datasetIndex === 5) return item.raw ? '\\u{1F534} CoDel dropping' : null;
                            if (item.datasetIndex === 6) return item.raw ? '\\u{1F7E1} Latency degraded' : null;
                            if (item.datasetIndex === 3) return item.dataset.label + ': ' + item.formattedValue + ' req/s';
                            if (item.datasetIndex === 4) return item.dataset.label + ': ' + (item.raw * 100).toFixed(0) + '%';
                            return item.dataset.label + ': ' + item.formattedValue;
                        },
                    },
                },
            },
            scales: {
                x: {
                    title: { display: true, text: 'Time (ms)', color: '#484f58' },
                    ticks: { color: '#484f58', maxTicksLimit: 20 },
                    grid: { color: '#21262d' },
                },
                y: {
                    position: 'left',
                    title: { display: true, text: 'Count', color: '#484f58' },
                    ticks: { color: '#484f58' },
                    grid: { color: '#21262d' },
                    suggestedMin: 0,
                },
                yRps: {
                    position: 'right',
                    title: { display: true, text: 'Requests/sec', color: '#bc8cff' },
                    ticks: { color: '#bc8cff' },
                    grid: { drawOnChartArea: false },
                    suggestedMin: 0,
                },
                yErrorRate: {
                    display: false,
                    min: 0,
                    max: 1,
                },
                yBand: {
                    display: false,
                    min: 0,
                    max: 1,
                },
            },
        },
    });

    // ── WoLF filter chart: raw log(W) vs filtered logW̄ ──
    const wolfCtx = document.getElementById('wolf-' + i).getContext('2d');
    new Chart(wolfCtx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'log(W) raw',
                    data: scenario.data.map(d => d.logW),
                    borderColor: 'rgba(139, 148, 158, 0.5)',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
                {
                    label: 'logW̄ (WoLF-filtered)',
                    data: scenario.data.map(d => d.logWBar),
                    borderColor: '#58a6ff',
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { color: '#8b949e', usePointStyle: true, pointStyle: 'line', font: { size: 11 } },
                },
                tooltip: {
                    backgroundColor: '#1c2128',
                    titleColor: '#f0f6fc',
                    bodyColor: '#c9d1d9',
                    borderColor: '#30363d',
                    borderWidth: 1,
                    callbacks: {
                        title: (items) => 't = ' + items[0].label + 'ms',
                        label: (item) => item.dataset.label + ': ' + (item.raw != null ? Number(item.raw).toFixed(4) : '—'),
                    },
                },
            },
            scales: {
                x: {
                    ticks: { color: '#484f58', maxTicksLimit: 20 },
                    grid: { color: '#21262d' },
                },
                y: {
                    position: 'left',
                    title: { display: true, text: 'log(W)', color: '#484f58' },
                    ticks: { color: '#484f58' },
                    grid: { color: '#21262d' },
                },
            },
        },
    });

    // ── z-test chart: dLogW̄ EWMA with ±Z×SE threshold bands ──
    const Z = 2;
    const zCtx = document.getElementById('ztest-' + i).getContext('2d');
    new Chart(zCtx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'dLogW̄ EWMA (trend)',
                    data: scenario.data.map(d => d.dLogWBarEwma),
                    borderColor: '#3fb950',
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
                {
                    label: '+Z×SE threshold',
                    data: scenario.data.map(d => d.se > 0 ? Z * d.se : null),
                    borderColor: 'rgba(248, 81, 73, 0.6)',
                    borderWidth: 1,
                    borderDash: [4, 2],
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
                {
                    label: '−Z×SE threshold',
                    data: scenario.data.map(d => d.se > 0 ? -Z * d.se : null),
                    borderColor: 'rgba(248, 81, 73, 0.3)',
                    borderWidth: 1,
                    borderDash: [4, 2],
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
                {
                    label: 'Zero',
                    data: scenario.data.map(() => 0),
                    borderColor: 'rgba(139, 148, 158, 0.3)',
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                },
                {
                    label: 'Degrading',
                    data: scenario.data.map(d => d.zScore > Z ? d.dLogWBarEwma : null),
                    backgroundColor: 'rgba(248, 81, 73, 0.2)',
                    borderColor: '#f85149',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointBackgroundColor: '#f85149',
                    fill: false,
                    spanGaps: false,
                    showLine: false,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { color: '#8b949e', usePointStyle: true, pointStyle: 'line', font: { size: 11 } },
                },
                tooltip: {
                    backgroundColor: '#1c2128',
                    titleColor: '#f0f6fc',
                    bodyColor: '#c9d1d9',
                    borderColor: '#30363d',
                    borderWidth: 1,
                    callbacks: {
                        title: (items) => 't = ' + items[0].label + 'ms',
                        label: (item) => {
                            if (item.datasetIndex === 3) return null;
                            if (item.datasetIndex === 4) return item.raw != null ? 'DEGRADING (z=' + Number(scenario.data[item.dataIndex].zScore).toFixed(2) + ')' : null;
                            return item.dataset.label + ': ' + (item.raw != null ? Number(item.raw).toFixed(6) : '—');
                        },
                    },
                },
            },
            scales: {
                x: {
                    ticks: { color: '#484f58', maxTicksLimit: 20 },
                    grid: { color: '#21262d' },
                },
                y: {
                    position: 'left',
                    title: { display: true, text: 'dLogW̄', color: '#484f58' },
                    ticks: { color: '#484f58' },
                    grid: { color: '#21262d' },
                },
            },
        },
    });
});
</script>
</body>
</html>`;

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const outPath = join(__dirname, "executor-simulation-live.html");
    writeFileSync(outPath, html);
    console.log(`\nChart written to:\n  ${outPath}`);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
