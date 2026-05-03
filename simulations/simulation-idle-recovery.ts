/**
 * Simulation demonstrating idle recovery and variance behavior.
 *
 * Shows that after an idle gap:
 *   - SE (z-test threshold) widens — the system knows its estimates are stale
 *   - ewmaSumW2 resets toward 1 (few effective samples)
 *   - When observations resume, the EWMA catches up quickly (high alpha)
 *
 * Run with:
 *   npx tsx test/simulations/simulation-idle-recovery.ts
 *
 * Then open the generated simulation-idle-recovery.html file.
 */
import { Executor } from "../src/Executor.js";
import { generateJsonOutput } from "./output.js";
import { generateHtmlFromJson } from "./generate-html.js";

// ── Seeded PRNG (xorshift128+) ──────────────────────────────────────

class SeededRandom {
    private s0: number;
    private s1: number;

    constructor(seed: number) {
        this.s0 = seed;
        this.s1 = seed ^ 0xdeadbeef;
        for (let i = 0; i < 20; i++) this.next();
    }

    public next(): number {
        let s1 = this.s0;
        const s0 = this.s1;
        this.s0 = s0;
        s1 ^= s1 << 23;
        s1 ^= s1 >> 17;
        s1 ^= s0;
        s1 ^= s0 >> 26;
        this.s1 = s1;
        return ((this.s0 + this.s1) >>> 0) / 0x100000000;
    }

    public erlang(mean: number, k = 3): number {
        let sum = 0;
        for (let i = 0; i < k; i++) sum += (-mean / k) * Math.log(1 - this.next());
        return sum;
    }
}

// ── Fake time infrastructure ────────────────────────────────────────

type Timer = { callback: () => void; fireAt: number };

let currentTime = 0;
let timers: Timer[] = [];
const originalPerformanceNow = performance.now.bind(performance);

function installFakeTime(): void {
    currentTime = 0;
    timers = [];
    performance.now = () => currentTime;
    // @ts-expect-error — override for simulation
    globalThis.setTimeout = (cb: () => void, ms: number) => {
        const timer: Timer = { callback: cb, fireAt: currentTime + ms };
        timers.push(timer);
        return timer as unknown as ReturnType<typeof setTimeout>;
    };
    globalThis.clearTimeout = (timer: unknown) => {
        const idx = timers.indexOf(timer as Timer);
        if (idx >= 0) timers.splice(idx, 1);
    };
}

function restoreFakeTime(): void {
    performance.now = originalPerformanceNow;
}

async function advance(ms: number): Promise<void> {
    const target = currentTime + ms;
    while (true) {
        let earliest: Timer | null = null;
        let earliestIdx = -1;
        for (let i = 0; i < timers.length; i++) {
            if (timers[i].fireAt <= target && (!earliest || timers[i].fireAt < earliest.fireAt)) {
                earliest = timers[i];
                earliestIdx = i;
            }
        }
        if (!earliest) break;
        timers.splice(earliestIdx, 1);
        currentTime = earliest.fireAt;
        earliest.callback();
        // Pump setImmediate too — Executor defers admission via setImmediate.
        await new Promise<void>((r) => setImmediate(r));
    }
    currentTime = target;
    await new Promise<void>((r) => setImmediate(r));
}

function simulationWait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ── Snapshot types ──────────────────────────────────────────────────

type Snapshot = {
    time: number;
    concurrencyLimit: number;
    inFlight: number;
    queueLength: number;
    dropping: boolean;
    throughputDegraded: boolean;
    logW: number | null;
    logWBar: number | null;
    dLogWBarEwma: number | null;
    dLogWBarVarianceEstimate: number;
    ewmaSumW2: number;
    se: number;
    zScore: number;
    completionRateEwma: number | null;
    regulationPhase: string;
    threshold: number; // tCritical × SE — actual firing boundary (use this not Z × SE for plots)
};

type Scenario = {
    name: string;
    description: string;
    data: Snapshot[];
    phases: { time: number; label: string }[];
};

const logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => logger
} as any;

function captureSnapshot(executor: Executor, pool: string, _zScoreThreshold: number): Snapshot {
    const rs = executor.getRegulatorState(pool);
    return {
        time: Math.round(currentTime),
        concurrencyLimit: executor.getConcurrencyLimit(pool),
        inFlight: executor.getInFlight(pool),
        queueLength: executor.getQueueLength(pool),
        dropping: executor.isOverloaded(pool),
        throughputDegraded: executor.isThroughputDegraded(pool),
        logW: rs.logW,
        logWBar: rs.logWBar,
        dLogWBarEwma: rs.dLogWBarEwma,
        dLogWBarVarianceEstimate: rs.dLogWBarVarianceEstimate,
        ewmaSumW2: rs.ewmaSumW2,
        se: rs.se,
        zScore: rs.zScore,
        completionRateEwma: rs.completionRateEwma,
        regulationPhase: rs.regulationPhase,
        threshold: rs.threshold
    };
}

// ── Scenarios ───────────────────────────────────────────────────────

const rng = new SeededRandom(42);

/**
 * Scenario 1: Idle gap recovery
 *
 * Phase 1: Steady traffic — establish variance baseline
 * Phase 2: Complete idle — no traffic at all
 * Phase 3: Resume with slightly higher latency
 *
 * Shows: SE/threshold widen during idle (few effective samples),
 * EWMA catches up quickly when observations resume (high alpha).
 */
async function scenarioIdleGap(): Promise<Scenario> {
    installFakeTime();
    const Z = 2;
    const executor = new Executor({ logger, zScoreThreshold: Z });
    executor.start();

    const pool = "idle-gap";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        maximumConcurrency: 50,
        delayThreshold: 200,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];
    const phases: { time: number; label: string }[] = [];

    // Phase 1: Steady traffic — 200 tasks at ~15ms each, arrival ~8ms
    // Runs for ~1600ms (200 × 8ms), well past timeConstant (9 windows = 900ms)
    phases.push({ time: 0, label: "Steady state" });
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(15);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(8));
        if (i % 4 === 0) data.push(captureSnapshot(executor, pool, Z));
    }

    // Let remaining tasks drain
    await advance(200);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, Z));

    // Phase 2: Complete idle — no traffic for 3000ms (~30 control windows)
    const idleStart = currentTime;
    phases.push({ time: Math.round(idleStart), label: "Idle (no traffic)" });
    for (let i = 0; i < 30; i++) {
        await advance(100);
        data.push(captureSnapshot(executor, pool, Z));
    }

    // Phase 3: Resume with moderately higher latency (25ms vs 15ms baseline)
    const resumeStart = currentTime;
    phases.push({ time: Math.round(resumeStart), label: "Resume (25ms latency)" });
    const catchAll2: Promise<unknown>[] = [];
    for (let i = 0; i < 150; i++) {
        const duration = rng.erlang(25);
        catchAll2.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(8));
        if (i % 4 === 0) data.push(captureSnapshot(executor, pool, Z));
    }

    await advance(500);
    await Promise.allSettled(catchAll2);
    data.push(captureSnapshot(executor, pool, Z));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Idle Gap Recovery",
        description:
            "Baseline: 10, controlWindow: 100ms, zScoreThreshold: 2. " +
            "Phase 1 (0\u2013~1800ms): steady traffic at ~15ms latency, variance converges. " +
            "Phase 2 (~1800\u2013~4800ms): complete idle \u2014 no traffic for 3 seconds. " +
            "ewmaSumW2 stays constant (no updates), but after idle alpha \u2192 1, resetting effective sample size. " +
            "SE and threshold widen \u2014 the system knows its estimates are stale. " +
            "Phase 3 (~4800ms+): traffic resumes at slightly higher latency (25ms). " +
            "High alpha \u2192 EWMA catches up to the new latency level quickly.",
        data,
        phases
    };
}

/**
 * Scenario 2: Sparse bursts
 *
 * Alternating periods of traffic and silence, with varying latency.
 * Shows the system correctly handling sporadic workloads.
 */
async function scenarioSparseBursts(): Promise<Scenario> {
    installFakeTime();
    const Z = 2;
    const executor = new Executor({ logger, zScoreThreshold: Z });
    executor.start();

    const pool = "sparse";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        maximumConcurrency: 50,
        delayThreshold: 200,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const phases: { time: number; label: string }[] = [];

    async function burst(count: number, latency: number, interArrival: number): Promise<void> {
        const promises: Promise<unknown>[] = [];
        for (let i = 0; i < count; i++) {
            const duration = rng.erlang(latency);
            promises.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
            await advance(rng.erlang(interArrival));
            if (i % 3 === 0) data.push(captureSnapshot(executor, pool, Z));
        }
        await advance(latency * 2);
        await Promise.allSettled(promises);
        data.push(captureSnapshot(executor, pool, Z));
    }

    async function idle(ms: number): Promise<void> {
        const steps = Math.max(1, Math.floor(ms / 100));
        for (let i = 0; i < steps; i++) {
            await advance(ms / steps);
            data.push(captureSnapshot(executor, pool, Z));
        }
    }

    // Burst 1: establish baseline (15ms latency)
    phases.push({ time: 0, label: "Burst 1 (15ms)" });
    await burst(100, 15, 8);

    // Idle 1
    phases.push({ time: Math.round(currentTime), label: "Idle 1" });
    await idle(2000);

    // Burst 2: same latency — should not trigger degradation
    phases.push({ time: Math.round(currentTime), label: "Burst 2 (15ms)" });
    await burst(50, 15, 8);

    // Idle 2
    phases.push({ time: Math.round(currentTime), label: "Idle 2" });
    await idle(2000);

    // Burst 3: higher latency — should the system react?
    phases.push({ time: Math.round(currentTime), label: "Burst 3 (50ms)" });
    await burst(80, 50, 8);

    // Idle 3
    phases.push({ time: Math.round(currentTime), label: "Idle 3" });
    await idle(1500);

    // Burst 4: back to normal
    phases.push({ time: Math.round(currentTime), label: "Burst 4 (15ms)" });
    await burst(80, 15, 8);

    executor.stop();
    restoreFakeTime();

    return {
        name: "Sparse Bursts with Varying Latency",
        description:
            "Baseline: 10, controlWindow: 100ms. Alternating bursts and idle periods. " +
            "Burst 1: 100 tasks at 15ms (baseline). Idle 2s. " +
            "Burst 2: 50 tasks at 15ms (same \u2014 no degradation). Idle 2s. " +
            "Burst 3: 80 tasks at 50ms (3\u00d7 slower). Idle 1.5s. " +
            "Burst 4: 80 tasks at 15ms (recovery). " +
            "Key: after each idle, alpha resets high and SE widens. The system doesn\u2019t false-positive " +
            "on burst 2 (same latency) and correctly adapts to burst 3 (real change) " +
            "without a stale-variance feedback loop.",
        data,
        phases
    };
}

/**
 * Scenario 3: The feedback loop (before fix would spiral to minimum)
 *
 * Sustained load, then a genuine latency increase that should trigger
 * ONE reduction, not a spiral to minimumConcurrency.
 */
async function scenarioFeedbackLoop(): Promise<Scenario> {
    installFakeTime();
    const Z = 2;
    const executor = new Executor({ logger, zScoreThreshold: Z });
    executor.start();

    const pool = "feedback";
    executor.registerPool(pool, {
        baselineConcurrency: 15,
        minimumConcurrency: 2,
        maximumConcurrency: 50,
        delayThreshold: 200,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];
    const phases: { time: number; label: string }[] = [];

    // Phase 1: Steady high throughput — establish low variance
    phases.push({ time: 0, label: "High throughput (10ms)" });
    for (let i = 0; i < 300; i++) {
        const duration = rng.erlang(10);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(5));
        if (i % 5 === 0) data.push(captureSnapshot(executor, pool, Z));
    }

    await advance(100);
    data.push(captureSnapshot(executor, pool, Z));

    // Phase 2: Moderate latency increase — should trigger proportional response
    const degradeStart = currentTime;
    phases.push({ time: Math.round(degradeStart), label: "Latency increase (30ms)" });
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(30);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(5));
        if (i % 3 === 0) data.push(captureSnapshot(executor, pool, Z));
    }

    // Phase 3: Latency recovers
    const recoverStart = currentTime;
    phases.push({ time: Math.round(recoverStart), label: "Recovery (10ms)" });
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(10);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(5));
        if (i % 5 === 0) data.push(captureSnapshot(executor, pool, Z));
    }

    await advance(2000);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, Z));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Feedback Loop Prevention",
        description:
            "Baseline: 15, min: 2, controlWindow: 100ms. " +
            "Phase 1: 300 tasks at 10ms, high throughput \u2014 variance converges to a low value. " +
            "Phase 2: latency increases to 30ms (3\u00d7). The regulator should reduce concurrency " +
            "proportionally, NOT spiral to minimum. Drift-invariant von Neumann \u03b4\u00b2 noise estimator with " +
            "autocorrelation-corrected SE keeps the z-test properly calibrated, preventing the runaway loop. " +
            "Phase 3: latency recovers to 10ms \u2014 concurrency should restore toward baseline.",
        data,
        phases
    };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("Running idle recovery & noise-estimator simulations...\n");

    const scenarios: Scenario[] = [
        await scenarioIdleGap(),
        await scenarioSparseBursts(),
        await scenarioFeedbackLoop()
    ];

    for (const s of scenarios) {
        const maxSumW2 = Math.max(...s.data.map((d) => d.ewmaSumW2));
        const maxSE = Math.max(...s.data.map((d) => d.se));
        const maxThreshold = Math.max(...s.data.map((d) => d.threshold));
        const hadDegradation = s.data.some((d) => d.throughputDegraded);
        console.log(`  ${s.name}`);
        console.log(
            `    Snapshots: ${s.data.length}, Duration: ${s.data[s.data.length - 1].time}ms`
        );
        console.log(
            `    Peak sumW2: ${maxSumW2.toFixed(4)}, Peak SE: ${maxSE.toFixed(4)}, Peak threshold: ${maxThreshold.toFixed(4)}`
        );
        console.log(`    Degradation detected: ${hadDegradation ? "yes" : "no"}`);
    }

    const jsonPath = generateJsonOutput(import.meta.url, "simulation-idle-recovery", scenarios, {
        title: "Idle Recovery & Variance Simulation",
        subtitle: "Demonstrates idle recovery, drift-invariant δ² noise estimation, and feedback loop prevention"
    });
    generateHtmlFromJson(jsonPath);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
