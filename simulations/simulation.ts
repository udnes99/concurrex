/**
 * Executor simulation that captures time-series data and generates
 * JSON + HTML visualizations with charts. This is a standalone script, not a test.
 *
 * Run with:
 *   npx tsx simulations/simulation.ts
 *
 * Then open the generated simulation.html file.
 */
import { Executor } from "../src/Executor.js";
import { generateJsonOutput } from "./output.js";
import { generateHtmlFromJson } from "./generate-html.js";

// ── Seeded PRNG (xorshift128+) ──────────────────────────────────────
// Deterministic random numbers so charts look the same every run.

class SeededRandom {
    private s0: number;
    private s1: number;

    constructor(seed: number) {
        this.s0 = seed;
        this.s1 = seed ^ 0xdeadbeef;
        // Warm up
        for (let i = 0; i < 20; i++) this.next();
    }

    /** Exponential distribution with given mean. */
    public exponential(mean: number): number {
        return -mean * Math.log(1 - this.next());
    }
    /** Returns a value in [0, 1). */
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

    /** Erlang-k distribution: sum of k exponentials, same overall mean.
     *  Higher k → lower variance (k=1 is exponential, k→∞ is deterministic). */
    public erlang(mean: number, k = 3): number {
        let sum = 0;
        for (let i = 0; i < k; i++) sum += this.exponential(mean / k);
        return sum;
    }
}

// ── Fake time infrastructure ────────────────────────────────────────
// Simulates time advancement without relying on vitest fake timers.

type Timer = { callback: () => void; fireAt: number };

let currentTime = 0;
let timers: Timer[] = [];
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
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
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}

async function advance(ms: number): Promise<void> {
    const target = currentTime + ms;
    while (true) {
        // Find next timer that fires before or at target
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
        // Yield to microtask queue (resolve pending promises)
        await new Promise<void>((r) => {
            r();
        });
    }
    currentTime = target;
    // Yield once more at target time
    await new Promise<void>((r) => {
        r();
    });
}

// ── Simulation wait (replaces Time.wait) ────────────────────────────

function simulationWait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
}

// ── Snapshot & scenario types ───────────────────────────────────────

type Snapshot = {
    time: number;
    concurrencyLimit: number;
    inFlight: number;
    queueLength: number;
    dropping: boolean;
    throughputDegraded: boolean;
};

type Scenario = {
    name: string;
    description: string;
    data: Snapshot[];
};

function captureSnapshot(executor: Executor, pool: string, time: number): Snapshot {
    return {
        time: Math.round(time),
        concurrencyLimit: executor.getConcurrencyLimit(pool),
        inFlight: executor.getInFlight(pool),
        queueLength: executor.getQueueLength(pool),
        dropping: executor.isOverloaded(pool),
        throughputDegraded: executor.isThroughputDegraded(pool)
    };
}

// ── Logger stub ─────────────────────────────────────────────────────

const logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => logger
} as any;

// ── Scenarios ───────────────────────────────────────────────────────

const rng = new SeededRandom(42);

async function scenarioSteadyState(): Promise<Scenario> {
    installFakeTime();
    const executor = new Executor({ logger });
    executor.start();

    const pool = "steady";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 1,
        maximumConcurrency: 50,
        delayThreshold: 100,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];

    // Run tasks at a steady rate: ~1 task every 5ms, each takes ~20ms (Erlang-3 for low variance)
    for (let i = 0; i < 400; i++) {
        const duration = rng.erlang(20);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(5));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    await advance(500);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, currentTime));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Steady State",
        description:
            "Baseline: 10, delayThreshold: 100ms, controlWindow: 100ms. " +
            "0\u20132000ms: 400 tasks arrive (mean inter-arrival 5ms) each taking ~20ms. " +
            "Load stays within baseline capacity \u2014 in-flight hovers around 4\u20138, queue stays at 0. " +
            "No CoDel activation, no throughput degradation. This is what normal operation looks like.",
        data
    };
}

async function scenarioBurstAbsorption(): Promise<Scenario> {
    installFakeTime();
    const executor = new Executor({ logger });
    executor.start();

    const pool = "burst";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 1,
        delayThreshold: 100,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];

    // Phase 1: normal load (0-1000ms)
    for (let i = 0; i < 100; i++) {
        const duration = rng.erlang(20);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 2: sudden burst — 200 tasks dumped at once
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(20);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
    }
    await advance(0);
    data.push(captureSnapshot(executor, pool, currentTime));

    // Let the burst drain gradually
    for (let i = 0; i < 20; i++) {
        await advance(5);
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 3: no new tasks — let the burst drain
    for (let i = 0; i < 60; i++) {
        await advance(50);
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    await advance(2000);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, currentTime));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Burst Absorption",
        description:
            "Baseline: 10, delayThreshold: 100ms, controlWindow: 100ms. " +
            "0\u20131000ms: normal load, 100 tasks arriving every ~10ms, each taking ~20ms. " +
            "~1000ms: sudden burst \u2014 200 tasks dumped at once. Queue spikes to ~190. " +
            "AI grows the concurrency limit (+1 per completion while queue has work) to absorb the burst. " +
            "1000\u20136000ms: burst drains, no new arrivals. Baseline gravity snaps the limit back down as in-flight tasks complete. " +
            "Key point: a long queue with fast processing is healthy \u2014 no CoDel drops, no MD.",
        data
    };
}

async function scenarioThroughputDegradation(): Promise<Scenario> {
    installFakeTime();
    const executor = new Executor({ logger });
    executor.start();

    const pool = "degrade";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        delayThreshold: 500,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];

    // Phase 1: healthy — tasks take ~15ms each (0-1500ms)
    for (let i = 0; i < 150; i++) {
        const duration = rng.erlang(15);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 2: degradation — tasks start taking ~200ms each (sustained slowdown)
    for (let i = 0; i < 50; i++) {
        const duration = rng.erlang(200);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(40));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 3: recovery — tasks back to ~15ms
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(15);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    await advance(2000);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, currentTime));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Latency Step Change & Recovery",
        description:
            "Baseline: 10, min: 2, delayThreshold: 500ms, controlWindow: 100ms. " +
            "0\u20131500ms: healthy phase \u2014 150 tasks arriving every ~10ms, each taking ~15ms. EWMA warms up. " +
            "~1500\u20133500ms: backend degrades \u2014 tasks slow to ~200ms (arrival slows to ~40ms). " +
            "Z-test detects the latency step change and the regulator decreases concurrency. " +
            "~3500\u20136000ms: backend recovers \u2014 tasks return to ~15ms. Queue drains, baseline gravity restores the limit. " +
            "CoDel may activate briefly if capacity drops below arrival rate.",
        data
    };
}

async function scenarioDemandSpikeHealthy(): Promise<Scenario> {
    installFakeTime();
    const executor = new Executor({ logger });
    executor.start();

    const pool = "demand";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        delayThreshold: 50,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];

    // Phase 1: establish baseline (0-500ms)
    for (let i = 0; i < 50; i++) {
        const duration = rng.erlang(10);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 2: massive demand spike — 500 tasks, processing speed UNCHANGED
    for (let i = 0; i < 500; i++) {
        const duration = rng.erlang(10);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
    }
    await advance(0);
    data.push(captureSnapshot(executor, pool, currentTime));

    // Phase 3: let it drain
    for (let i = 0; i < 100; i++) {
        await advance(50);
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    await advance(5000);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, currentTime));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Demand Spike (Healthy Processing)",
        description:
            "Baseline: 10, min: 2, delayThreshold: 50ms, controlWindow: 100ms. " +
            "0\u2013500ms: baseline established with 50 tasks arriving every ~10ms, each taking ~10ms. " +
            "~500ms: 500 tasks dumped at once. Queue spikes to ~490. Processing speed unchanged (~10ms). " +
            "500\u201310000ms: AI grows the limit as tasks complete with queue work. CoDel drops stale entries whose sojourn exceeds 50ms. " +
            "Key point: z-test does NOT fire \u2014 throughput (completions/window) stays healthy. " +
            "A long queue is a demand problem, not a processing problem. The cashier doesn't slow down because the line is long.",
        data
    };
}

async function scenarioActualDegradationUnderLoad(): Promise<Scenario> {
    installFakeTime();
    const executor = new Executor({ logger });
    executor.start();

    const pool = "real-degrade";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        delayThreshold: 50,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];

    // Phase 1: establish baseline (0-500ms)
    for (let i = 0; i < 50; i++) {
        const duration = rng.erlang(10);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 2: same demand spike — but NOW tasks are slow (~150ms each)
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(150);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
    }
    await advance(0);
    data.push(captureSnapshot(executor, pool, currentTime));

    // Phase 3: observe the system react — CoDel drops stale entries
    for (let i = 0; i < 100; i++) {
        await advance(50);
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 4: recovery — tasks back to ~10ms
    for (let i = 0; i < 100; i++) {
        const duration = rng.erlang(10);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    await advance(5000);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, currentTime));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Degraded Burst (CoDel Only)",
        description:
            "Baseline: 10, min: 2, delayThreshold: 50ms, controlWindow: 100ms. " +
            "0\u2013500ms: baseline established with 50 tasks, same as the healthy demand spike. " +
            "~500ms: 200 slow tasks (~150ms each) dumped at once. Queue spikes to ~190. " +
            "500\u20135500ms: AI grows the limit (tasks complete with queue work), CoDel drops stale entries. " +
            "z-test does NOT fire \u2014 the short baseline phase (~5 windows) doesn't accumulate enough variance samples for detection (requires ESS \u2248 9). " +
            "This is a one-shot burst, not sustained degradation. Compare with the healthy demand spike: same shape, but slower processing means CoDel drops more aggressively. " +
            "5500\u201311000ms: 100 fast recovery tasks (~10ms) drain remaining queue.",
        data
    };
}

async function scenarioFullOverload(): Promise<Scenario> {
    installFakeTime();
    const executor = new Executor({ logger });
    executor.start();

    const pool = "full-overload";
    executor.registerPool(pool, {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        maximumConcurrency: 15, // Capped so AI can't fully compensate for 300ms tasks
        delayThreshold: 100,
        controlWindow: 100
    });

    const data: Snapshot[] = [];
    const catchAll: Promise<unknown>[] = [];

    // Phase 1: healthy baseline — long enough for EWMA warm-up (ESS ≈ 9 windows ≈ 900ms)
    // Tasks ~15ms, arrival ~10ms. Capacity 667/sec >> arrival 100/sec. Queue stays at 0.
    for (let i = 0; i < 150; i++) {
        const duration = rng.erlang(15);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 2: sustained backend degradation — same arrival rate, tasks now take ~300ms
    // Capacity: 10 slots / 300ms ≈ 33/sec. Arrival 100/sec >> capacity.
    // Queue grows rapidly → entries age past 100ms threshold → CoDel activates.
    // Completion rate drops from ~10/window to ~3/window → z-test fires.
    // Both mechanisms cooperate: regulator reduces concurrency to protect the backend,
    // CoDel sheds excess demand from the queue.
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(300);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    // Phase 3: backend recovers — tasks back to ~15ms
    for (let i = 0; i < 200; i++) {
        const duration = rng.erlang(15);
        catchAll.push(executor.run(pool, () => simulationWait(duration)).catch(() => {}));
        await advance(rng.erlang(10));
        data.push(captureSnapshot(executor, pool, currentTime));
    }

    await advance(5000);
    await Promise.allSettled(catchAll);
    data.push(captureSnapshot(executor, pool, currentTime));

    executor.stop();
    restoreFakeTime();

    return {
        name: "Full Overload (CoDel + Regulator Decrease)",
        description:
            "Baseline: 10, min: 2, max: 15, delayThreshold: 100ms, controlWindow: 100ms. " +
            "0\u20131500ms: healthy phase \u2014 150 tasks arriving every ~10ms, each taking ~15ms. EWMA warms up (~15 windows). " +
            "~1500\u20133500ms: sustained backend degradation \u2014 tasks slow to ~300ms, arrival unchanged at ~10ms. " +
            "Capacity drops well below arrival (100/sec). AI grows the limit but hits the cap (15) \u2014 not enough to compensate. " +
            "Queue grows, entries age past 100ms. " +
            "Both mechanisms activate: z-test detects the latency change and cuts concurrency to reduce backend pressure. " +
            "CoDel detects stale queue entries and sheds excess demand. " +
            "~3500\u20135500ms: backend recovers \u2014 tasks return to ~15ms. CoDel exits dropping, " +
            "baseline gravity and AI restore the concurrency limit.",
        data
    };
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log("Running Executor simulations...\n");

    const scenarios: Scenario[] = [
        await scenarioSteadyState(),
        await scenarioBurstAbsorption(),
        await scenarioThroughputDegradation(),
        await scenarioDemandSpikeHealthy(),
        await scenarioActualDegradationUnderLoad(),
        await scenarioFullOverload()
    ];

    for (const s of scenarios) {
        const maxQueue = Math.max(...s.data.map((d) => d.queueLength));
        const maxInFlight = Math.max(...s.data.map((d) => d.inFlight));
        const maxLimit = Math.max(...s.data.map((d) => d.concurrencyLimit));
        const hadDrops = s.data.some((d) => d.dropping);
        const hadDegradation = s.data.some((d) => d.throughputDegraded);
        console.log(`  ${s.name}`);
        console.log(
            `    Snapshots: ${s.data.length}, Duration: ${s.data[s.data.length - 1].time}ms`
        );
        console.log(
            `    Peak queue: ${maxQueue}, Peak in-flight: ${maxInFlight}, Peak limit: ${maxLimit}`
        );
        console.log(
            `    CoDel drops: ${hadDrops ? "yes" : "no"}, Degradation detected: ${hadDegradation ? "yes" : "no"}\n`
        );
    }

    const jsonPath = generateJsonOutput(import.meta.url, "simulation", scenarios, {
        title: "Executor \u2013 Adaptive Concurrency Simulation",
        subtitle: "CoDel queue management + throughput-driven AIMD concurrency regulation"
    });
    generateHtmlFromJson(jsonPath);
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});
