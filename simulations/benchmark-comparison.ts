/**
 * Comparative overload benchmark + blog-figure traces.
 *
 * Everything runs on a deterministic virtual clock — `performance.now`
 * AND `setTimeout` are virtualized into one event heap — so minutes of
 * simulated traffic per strategy run in seconds of wall time with a
 * seeded, exactly reproducible arrival stream. All four strategies face
 * the identical arrival times and per-request service noise.
 *
 * Backend model: a capacity-C contention server. Service time inflates
 * as (active/C)^CONTENTION_EXP once concurrency exceeds capacity — the
 * classic congestion-collapse shape (throughput *falls* as concurrency
 * grows past C, because contention grows superlinearly). Clients have a
 * hard deadline; completions slower than the deadline are wasted work,
 * not goodput.
 *
 * Modes (`npx tsx simulations/benchmark-comparison.ts [--mode all|compare|anatomy|burst|knee|warmup]`):
 *
 *   compare — one 3× overload incident (60s) against four front-ends:
 *     unbounded      no limiter — every arrival goes straight to the backend
 *     fixed-queue    static semaphore + unbounded FIFO queue, no shedding
 *     timeout-shed   static semaphore + hard queue-sojourn cutoff (the
 *                    step-function comparator to ProDel's P = 1 − τ/s)
 *     concurrex      the executor: ProDel + EarlyShed + PowerDegraded
 *
 *   anatomy — a capacity-loss incident (backend loses 70% of its
 *     capacity for 25s) traced per control window: W̃, test statistic vs
 *     critical value, concurrency limit, regulation phase, goodput.
 *
 *   warmup — the first 30 windows after cold start: the critical value
 *     is Infinity until the test df crosses 5 (~1.2 time constants after
 *     start), then converges toward its steady-state value. No warm-up
 *     branches in the code — the math gates itself.
 *
 * Output: console tables + `simulations/benchmark-comparison.json`
 * (gitignored) containing the raw per-second / per-window traces for
 * plotting.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Executor } from "../src/Executor.js";
import { PowerDegraded, type PowerDegradedState } from "../src/signals.js";
import type { Logger } from "../src/logger.js";

// ── CLI ──────────────────────────────────────────────────────────────

function argStr(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}
function argNum(name: string, fallback: number): number {
    const v = Number(argStr(name, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
}

const MODE = argStr("mode", "all");
const SEED = argNum("seed", 42);

const logger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

// ── Deterministic randomness ─────────────────────────────────────────

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussian(rng: () => number): number {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ── Virtual clock + event heap (performance.now AND setTimeout) ──────

type VirtualEvent = { at: number; seq: number; fn: () => void; cancelled: boolean };

class VirtualScheduler {
    now = 0;
    private heap: VirtualEvent[] = [];
    private seq = 0;

    schedule(at: number, fn: () => void): VirtualEvent {
        const ev: VirtualEvent = { at, seq: this.seq++, fn, cancelled: false };
        const h = this.heap;
        h.push(ev);
        let i = h.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.before(h[i], h[p])) {
                [h[i], h[p]] = [h[p], h[i]];
                i = p;
            } else break;
        }
        return ev;
    }

    next(): VirtualEvent | null {
        for (;;) {
            const h = this.heap;
            if (h.length === 0) return null;
            const top = h[0];
            const last = h.pop()!;
            if (h.length > 0) {
                h[0] = last;
                let i = 0;
                for (;;) {
                    const l = 2 * i + 1;
                    const r = l + 1;
                    let m = i;
                    if (l < h.length && this.before(h[l], h[m])) m = l;
                    if (r < h.length && this.before(h[r], h[m])) m = r;
                    if (m === i) break;
                    [h[i], h[m]] = [h[m], h[i]];
                    i = m;
                }
            }
            if (!top.cancelled) return top;
        }
    }

    private before(a: VirtualEvent, b: VirtualEvent): boolean {
        return a.at < b.at || (a.at === b.at && a.seq < b.seq);
    }
}

let scheduler = new VirtualScheduler();

// The executor reads time exclusively through performance.now(), and
// schedules ProDel drop rounds through setTimeout — virtualize both.
(globalThis.performance as { now: () => number }).now = () => scheduler.now;
const realSetImmediate = setImmediate;
(globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, delay = 0) =>
    scheduler.schedule(scheduler.now + Math.max(0, delay), fn);
(globalThis as { clearTimeout: unknown }).clearTimeout = (t: unknown) => {
    if (t && typeof t === "object" && "cancelled" in t) (t as VirtualEvent).cancelled = true;
};

/** Let deferred admissions (setImmediate) and promise chains settle. */
const flush = () => new Promise<void>((r) => realSetImmediate(r));

/** Run the event loop until the heap is empty or virtual time passes `until`. */
async function drive(until: number): Promise<void> {
    for (;;) {
        const ev = scheduler.next();
        if (!ev) return;
        if (ev.at > until) {
            ev.cancelled = true; // beyond the horizon — drop it
            continue;
        }
        scheduler.now = Math.max(scheduler.now, ev.at);
        ev.fn();
        await flush();
    }
}

// ── Backend: capacity-C contention server ────────────────────────────

const BASE_MS = 50;
const CAPACITY = 20;
const CONTENTION_EXP = argNum("exp", 1.3);

class Backend {
    active = 0;
    /** Exogenous service-time multiplier — a backend souring / noisy-neighbour
     *  incident that raises latency independent of *our* concurrency. Default
     *  1 (no incident). Used by the clamp scenario to degrade latency while
     *  our in-flight stays demand-limited (below the limit → real headroom). */
    slowdown = 1;
    constructor(
        public capacity: number = CAPACITY,
        private readonly exponent: number = CONTENTION_EXP
    ) {}

    /** Service time given current concurrency (self included) and this
     *  request's multiplicative noise factor. */
    call(noise: number): Promise<void> {
        this.active++;
        const load = Math.max(1, this.active / this.capacity);
        const serviceMs = BASE_MS * Math.pow(load, this.exponent) * noise * this.slowdown;
        return new Promise((resolve) =>
            scheduler.schedule(scheduler.now + serviceMs, () => {
                this.active--;
                resolve();
            })
        );
    }
}

// ── Traffic ──────────────────────────────────────────────────────────

const HEALTHY_RPS = 300;
const OVERLOAD_RPS = 1200;
const OVERLOAD_START = 30_000;
const OVERLOAD_END = 90_000;
const DURATION = 120_000;
const DRAIN = 30_000; // post-run window in which late completions may still land
const DEADLINE = 1_000;

type Request = { at: number; noise: number };

function buildRequests(seed: number, profile: (t: number) => number, duration: number): Request[] {
    const arrivalRng = mulberry32(seed);
    const noiseRng = mulberry32(seed ^ 0x9e3779b9);
    const out: Request[] = [];
    let t = 0;
    for (;;) {
        const rps = profile(t);
        t += (-Math.log(1 - arrivalRng()) / rps) * 1000;
        if (t >= duration) return out;
        out.push({ at: t, noise: Math.exp(0.25 * gaussian(noiseRng)) });
    }
}

// ── Metrics ──────────────────────────────────────────────────────────

type Bucket = { good: number; late: number; shed: number; shedLatencyMs: number; latencies: number[] };

class Metrics {
    buckets: Bucket[] = [];

    private bucket(t: number): Bucket {
        const i = Math.min(Math.floor(t / 1000), 10_000);
        while (this.buckets.length <= i) {
            this.buckets.push({ good: 0, late: 0, shed: 0, shedLatencyMs: 0, latencies: [] });
        }
        return this.buckets[i];
    }

    complete(arrival: number, end: number): void {
        const latency = end - arrival;
        const b = this.bucket(arrival);
        if (latency <= DEADLINE) {
            b.good++;
            b.latencies.push(latency);
        } else {
            b.late++;
        }
    }

    shed(arrival: number, end: number): void {
        const b = this.bucket(arrival);
        b.shed++;
        b.shedLatencyMs += end - arrival;
    }

    /** Aggregate over arrival-time range [fromMs, toMs). */
    phase(fromMs: number, toMs: number) {
        const from = Math.floor(fromMs / 1000);
        const to = Math.min(Math.ceil(toMs / 1000), this.buckets.length);
        let good = 0,
            late = 0,
            shed = 0,
            shedLatencyMs = 0;
        const latencies: number[] = [];
        for (let i = from; i < to; i++) {
            const b = this.buckets[i];
            if (!b) continue;
            good += b.good;
            late += b.late;
            shed += b.shed;
            shedLatencyMs += b.shedLatencyMs;
            latencies.push(...b.latencies);
        }
        latencies.sort((a, b) => a - b);
        const q = (p: number) => (latencies.length === 0 ? NaN : latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]);
        const seconds = (to - from) || 1;
        return {
            goodPerSec: good / seconds,
            latePerSec: late / seconds,
            shedPerSec: shed / seconds,
            p50: q(0.5),
            p99: q(0.99),
            meanShedLatency: shed > 0 ? shedLatencyMs / shed : 0
        };
    }
}

// ── Strategies ───────────────────────────────────────────────────────

type Strategy = {
    name: string;
    submit(req: Request): void;
    limitTrace?(): number;
    teardown?(): void;
};

function unbounded(backend: Backend, m: Metrics): Strategy {
    return {
        name: "unbounded",
        submit: (req) => {
            void backend.call(req.noise).then(() => m.complete(req.at, scheduler.now));
        }
    };
}

function fixedQueue(backend: Backend, m: Metrics, limit: number): Strategy {
    let inFlight = 0;
    const queue: Request[] = [];
    const start = (req: Request): void => {
        inFlight++;
        void backend.call(req.noise).then(() => {
            m.complete(req.at, scheduler.now);
            inFlight--;
            pump();
        });
    };
    const pump = (): void => {
        while (inFlight < limit && queue.length > 0) start(queue.shift()!);
    };
    return {
        name: "fixed-queue",
        submit: (req) => {
            queue.push(req);
            pump();
        }
    };
}

function timeoutShed(backend: Backend, m: Metrics, limit: number, cutoffMs: number): Strategy {
    let inFlight = 0;
    const queue: Request[] = [];
    const start = (req: Request): void => {
        inFlight++;
        void backend.call(req.noise).then(() => {
            m.complete(req.at, scheduler.now);
            inFlight--;
            pump();
        });
    };
    const pump = (): void => {
        while (inFlight < limit && queue.length > 0) {
            const req = queue.shift()!;
            if (scheduler.now - req.at > cutoffMs) {
                m.shed(req.at, scheduler.now); // rejected only after it has already waited
                continue;
            }
            start(req);
        }
    };
    return {
        name: "timeout-shed",
        submit: (req) => {
            queue.push(req);
            pump();
        }
    };
}

function concurrex(backend: Backend, m: Metrics): Strategy {
    const executor = new Executor({ logger });
    executor.registerPool("web", {
        baselineConcurrency: 30,
        minimumConcurrency: 5,
        maximumConcurrency: 400,
        delayThreshold: 250,
        controlWindow: 100
    });
    executor.start();
    return {
        name: "concurrex",
        submit: (req) => {
            executor.run("web", () => backend.call(req.noise), { lane: "shared" }).then(
                () => m.complete(req.at, scheduler.now),
                () => m.shed(req.at, scheduler.now)
            );
        },
        limitTrace: () => executor.getConcurrencyLimit("web"),
        teardown: () => executor.stop()
    };
}

/** Research variant: the identical PowerDegraded pipeline with the
 *  latch bypassed — `triggered()` is the instantaneous trend test. The
 *  reproducible latched-vs-trend proof. */
class UnlatchedPowerDegraded extends PowerDegraded {
    public override triggered(): boolean {
        return (this.state() as { degrading: boolean }).degrading;
    }
    public override clone(): UnlatchedPowerDegraded {
        return new UnlatchedPowerDegraded({ name: this.name });
    }
}

function concurrexTrend(backend: Backend, m: Metrics): Strategy {
    const executor = new Executor({ logger });
    executor.registerPool("web", {
        baselineConcurrency: 30,
        minimumConcurrency: 5,
        maximumConcurrency: 400,
        delayThreshold: 250,
        controlWindow: 100,
        regulatorSignals: [new UnlatchedPowerDegraded()]
    });
    executor.start();
    return {
        name: "concurrex-trend",
        submit: (req) => {
            executor.run("web", () => backend.call(req.noise), { lane: "shared" }).then(
                () => m.complete(req.at, scheduler.now),
                () => m.shed(req.at, scheduler.now)
            );
        },
        limitTrace: () => executor.getConcurrencyLimit("web"),
        teardown: () => executor.stop()
    };
}

// ── Industry comparators (Netflix concurrency-limits-style deployment:
//    acquire-or-reject at the adaptive limit, no internal queue) ──────

/** TCP-Reno-style AIMD: +1 per "round" of completions while utilized,
 *  halve when a completion breaches the latency threshold (same 250ms
 *  budget concurrex gets as delayThreshold), with a one-breach-per-RTT
 *  cooldown. */
function aimd(backend: Backend, m: Metrics): Strategy {
    let limit = 30;
    let inFlight = 0;
    let lastBackoff = -Infinity;
    return {
        name: "aimd",
        submit: (req) => {
            if (inFlight >= limit) {
                m.shed(req.at, scheduler.now);
                return;
            }
            inFlight++;
            const start = scheduler.now;
            void backend.call(req.noise).then(() => {
                const latency = scheduler.now - start;
                inFlight--;
                if (latency > 250 && scheduler.now - lastBackoff > latency) {
                    limit = Math.max(5, Math.floor(limit / 2));
                    lastBackoff = scheduler.now;
                } else if (inFlight >= limit - 2) {
                    limit = Math.min(400, limit + 1 / limit);
                }
                m.complete(req.at, scheduler.now);
            });
        },
        limitTrace: () => Math.round(limit)
    };
}

/** TCP-Vegas-style (Netflix VegasLimit form): per epoch of `limit`
 *  completions, estimate the queue Q = limit·(1 − minRTT/avgRTT) and
 *  nudge the limit ±1 against α = 3·log10(limit), β = 6·log10(limit).
 *  minRTT re-probes every 30 epochs (the classic staleness fix). */
function vegas(backend: Backend, m: Metrics): Strategy {
    let limit = 30;
    let inFlight = 0;
    let minRtt = Infinity;
    let epochSum = 0;
    let epochCount = 0;
    let epochs = 0;
    return {
        name: "vegas",
        submit: (req) => {
            if (inFlight >= limit) {
                m.shed(req.at, scheduler.now);
                return;
            }
            inFlight++;
            const start = scheduler.now;
            void backend.call(req.noise).then(() => {
                const rtt = scheduler.now - start;
                inFlight--;
                minRtt = Math.min(minRtt, rtt);
                epochSum += rtt;
                epochCount++;
                if (epochCount >= Math.max(5, Math.round(limit))) {
                    const avg = epochSum / epochCount;
                    const queueEst = limit * (1 - minRtt / avg);
                    const alphaT = 3 * Math.log10(Math.max(10, limit));
                    const betaT = 6 * Math.log10(Math.max(10, limit));
                    if (queueEst < alphaT) limit = Math.min(400, limit + 1);
                    else if (queueEst > betaT) limit = Math.max(5, limit - 1);
                    epochSum = 0;
                    epochCount = 0;
                    epochs++;
                    if (epochs % 30 === 0) minRtt = rtt; // probe
                }
                m.complete(req.at, scheduler.now);
            });
        },
        limitTrace: () => Math.round(limit)
    };
}

/** Netflix Gradient2-style: short vs long RTT EWMAs; per epoch,
 *  gradient = clamp(longRTT/shortRTT, 0.5, 1) and
 *  limit ← smoothed(limit·gradient + √limit). */
function gradient2(backend: Backend, m: Metrics): Strategy {
    let limit = 30;
    let inFlight = 0;
    let shortRtt: number | null = null;
    let longRtt: number | null = null;
    let epochCount = 0;
    return {
        name: "gradient2",
        submit: (req) => {
            if (inFlight >= limit) {
                m.shed(req.at, scheduler.now);
                return;
            }
            inFlight++;
            const start = scheduler.now;
            void backend.call(req.noise).then(() => {
                const rtt = scheduler.now - start;
                inFlight--;
                shortRtt = shortRtt === null ? rtt : 0.8 * shortRtt + 0.2 * rtt;
                longRtt = longRtt === null ? rtt : 0.995 * longRtt + 0.005 * rtt;
                epochCount++;
                if (epochCount >= Math.max(5, Math.round(limit)) && shortRtt !== null && longRtt !== null) {
                    const gradient = Math.max(0.5, Math.min(1.0, longRtt / shortRtt));
                    const target = limit * gradient + Math.sqrt(limit);
                    limit = Math.max(5, Math.min(400, 0.8 * limit + 0.2 * target));
                    epochCount = 0;
                }
                m.complete(req.at, scheduler.now);
            });
        },
        limitTrace: () => Math.round(limit)
    };
}

// ── Mode: compare ────────────────────────────────────────────────────

async function runCompare(): Promise<object> {
    const profile = (t: number) => (t >= OVERLOAD_START && t < OVERLOAD_END ? OVERLOAD_RPS : HEALTHY_RPS);
    const requests = buildRequests(SEED, profile, DURATION);
    console.log(
        `── Compare: ${HEALTHY_RPS} rps baseline, ${OVERLOAD_RPS} rps for ${(OVERLOAD_END - OVERLOAD_START) / 1000}s ` +
            `(backend capacity ≈ ${Math.round((CAPACITY / BASE_MS) * 1000)} rps), ${DEADLINE}ms client deadline ──`
    );
    console.log(`${requests.length} identical seeded arrivals per strategy\n`);

    const factories: Array<(b: Backend, m: Metrics) => Strategy> = [
        (b, m) => unbounded(b, m),
        (b, m) => fixedQueue(b, m, 30),
        (b, m) => timeoutShed(b, m, 30, 250),
        (b, m) => aimd(b, m),
        (b, m) => vegas(b, m),
        (b, m) => gradient2(b, m),
        (b, m) => concurrexTrend(b, m),
        (b, m) => concurrex(b, m)
    ];

    const phases = [
        { name: "healthy", from: 5_000, to: OVERLOAD_START },
        { name: "overload", from: OVERLOAD_START, to: OVERLOAD_END },
        { name: "recovery", from: OVERLOAD_END, to: DURATION }
    ];

    const header =
        "strategy         phase      goodput/s   late/s   shed/s   p50(ok)    p99(ok)    mean 503 latency";
    console.log(header);
    const traces: object[] = [];

    for (const factory of factories) {
        scheduler = new VirtualScheduler();
        const backend = new Backend();
        const metrics = new Metrics();
        const strategy = factory(backend, metrics);

        const limitSamples: Array<{ t: number; limit: number; active: number }> = [];
        for (const req of requests) scheduler.schedule(req.at, () => strategy.submit(req));
        for (let t = 500; t <= DURATION; t += 500) {
            scheduler.schedule(t, () =>
                limitSamples.push({ t, limit: strategy.limitTrace?.() ?? NaN, active: backend.active })
            );
        }

        await drive(DURATION + DRAIN);
        strategy.teardown?.();

        for (const phase of phases) {
            const r = metrics.phase(phase.from, phase.to);
            console.log(
                `${strategy.name.padEnd(16)} ${phase.name.padEnd(10)} ` +
                    `${r.goodPerSec.toFixed(0).padStart(6)}      ${r.latePerSec.toFixed(0).padStart(5)}   ` +
                    `${r.shedPerSec.toFixed(0).padStart(5)}    ${isNaN(r.p50) ? "   —  " : `${r.p50.toFixed(0)}ms`.padStart(6)}    ` +
                    `${isNaN(r.p99) ? "   —  " : `${r.p99.toFixed(0)}ms`.padStart(6)}     ${r.shedPerSec > 0 ? `${r.meanShedLatency.toFixed(0)}ms` : "—"}`
            );
        }
        console.log("");

        traces.push({
            strategy: strategy.name,
            buckets: metrics.buckets.map((b, i) => ({
                t: i,
                good: b.good,
                late: b.late,
                shed: b.shed,
                p99: b.latencies.length ? b.latencies.sort((x, y) => x - y)[Math.floor(0.99 * b.latencies.length)] : null
            })),
            limitTrace: limitSamples
        });
    }

    console.log(
        "Reading guide: goodput = completions within the deadline. 'late' completions consumed backend\n" +
            "capacity but missed the deadline (wasted work). 'mean 503 latency' is how long a rejected\n" +
            "caller waited before being told no — instant for admission-time shedding, one full cutoff\n" +
            "for dequeue-time shedding, and never for strategies that don't shed at all.\n"
    );
    return { requestsPerStrategy: requests.length, phases, traces };
}

// ── Mode: anatomy ────────────────────────────────────────────────────

async function runAnatomy(): Promise<object> {
    const INCIDENT_START = 20_000;
    const INCIDENT_END = 45_000;
    const ANATOMY_DURATION = 70_000;
    const DEGRADED_CAPACITY = 6;

    console.log(
        `── Anatomy: capacity-loss incident (backend capacity ${CAPACITY} → ${DEGRADED_CAPACITY} ` +
            `at t=${INCIDENT_START / 1000}s, restored at t=${INCIDENT_END / 1000}s), ${HEALTHY_RPS} rps throughout ──\n`
    );

    const requests = buildRequests(SEED + 1, () => HEALTHY_RPS, ANATOMY_DURATION);
    const samples: Array<Record<string, number | string | boolean | null>> = [];

    scheduler = new VirtualScheduler();
    const backend2 = new Backend();
    const metrics2 = new Metrics();
    const ex = new Executor({ logger });
    ex.registerPool("web", {
        baselineConcurrency: 30,
        minimumConcurrency: 2,
        maximumConcurrency: 400,
        delayThreshold: 250,
        controlWindow: 100
    });
    ex.start();
    for (const req of requests) {
        scheduler.schedule(req.at, () => {
            ex.run("web", () => backend2.call(req.noise), { lane: "shared" }).then(
                () => metrics2.complete(req.at, scheduler.now),
                () => metrics2.shed(req.at, scheduler.now)
            );
        });
    }
    scheduler.schedule(INCIDENT_START, () => (backend2.capacity = DEGRADED_CAPACITY));
    scheduler.schedule(INCIDENT_END, () => (backend2.capacity = CAPACITY));
    for (let t = 100; t <= ANATOMY_DURATION; t += 100) {
        scheduler.schedule(t + 1, () => {
            const s = ex.getSignalState<PowerDegradedState>("web", "power-degraded");
            const reg = ex.getRegulatorState("web");
            samples.push({
                t,
                wTildeMs: s?.logWBar != null ? Math.exp(s.logWBar) : null,
                zScore: s?.zScore ?? null,
                tCritical: s?.tCritical == null ? null : Number.isFinite(s.tCritical) ? s.tCritical : "Infinity",
                degrading: s?.degrading ?? false,
                limit: ex.getConcurrencyLimit("web"),
                phase: reg.regulationPhase,
                dropping: ex.isOverloaded("web"),
                backendActive: backend2.active
            });
        });
    }

    await drive(ANATOMY_DURATION + DRAIN);
    ex.stop();

    // Console digest: one row per second around the incident.
    console.log("t(s)   W̃(ms)    z-stat    critical   limit  phase        dropping  goodput/s");
    for (let sec = 15; sec <= 55; sec++) {
        const s = samples.filter((x) => (x.t as number) > (sec - 1) * 1000 && (x.t as number) <= sec * 1000).pop();
        if (!s) continue;
        const b = metrics2.buckets[sec];
        console.log(
            `${String(sec).padEnd(6)} ${s.wTildeMs == null ? "—" : (s.wTildeMs as number).toFixed(0).padStart(5)}    ` +
                `${s.zScore == null ? "    —" : (s.zScore as number).toFixed(2).padStart(6)}    ` +
                `${s.tCritical === "Infinity" ? "     ∞" : s.tCritical == null ? "     —" : (s.tCritical as number).toFixed(2).padStart(6)}    ` +
                `${String(s.limit).padStart(4)}   ${String(s.phase).padEnd(12)} ${s.dropping ? "yes" : "no "}       ${b ? b.good : 0}`
        );
    }
    const healthy = metrics2.phase(5_000, INCIDENT_START);
    const incident = metrics2.phase(INCIDENT_START, INCIDENT_END);
    const restored = metrics2.phase(INCIDENT_END + 5_000, ANATOMY_DURATION);
    console.log(
        `\nhealthy: ${healthy.goodPerSec.toFixed(0)}/s good, p99 ${healthy.p99.toFixed(0)}ms · ` +
            `incident: ${incident.goodPerSec.toFixed(0)}/s good, ${incident.shedPerSec.toFixed(0)}/s shed (fast 503s, mean ${incident.meanShedLatency.toFixed(0)}ms) · ` +
            `restored: ${restored.goodPerSec.toFixed(0)}/s good, p99 ${restored.p99.toFixed(0)}ms\n`
    );
    return {
        incident: { start: INCIDENT_START, end: INCIDENT_END, degradedCapacity: DEGRADED_CAPACITY },
        samples,
        buckets: metrics2.buckets.map((b, i) => ({ t: i, good: b.good, shed: b.shed }))
    };
}

// ── Mode: burst (headroom scale-up — the anti-trap regression) ──────
//
// The backend has ample headroom (capacity 100); the pool's baseline is
// deliberately low (10). A hot influx arrives that needs L ≈ 40 — well
// within backend capacity, so growing the limit is the correct response
// and produces NO latency degradation. The failure mode this guards
// against: a regulator that refuses to scale up while ProDel is dropping
// gets trapped at baseline, shedding traffic the backend could serve.

async function runBurst(): Promise<object> {
    const BURST_START = 15_000;
    const BURST_END = 55_000;
    const BURST_DURATION = 75_000;
    const BURST_RPS = 700;
    const CALM_RPS = 100;

    console.log(
        `── Burst: headroom scale-up — baseline L=10, backend capacity 100, ` +
            `${CALM_RPS}→${BURST_RPS} rps at t=${BURST_START / 1000}s (needs L ≈ ${Math.ceil((BURST_RPS * BASE_MS) / 1000)}) ──\n`
    );

    scheduler = new VirtualScheduler();
    const backend = new Backend(100);
    const metrics = new Metrics();
    const ex = new Executor({ logger });
    ex.registerPool("web", {
        baselineConcurrency: 10,
        minimumConcurrency: 2,
        maximumConcurrency: 400,
        delayThreshold: 250,
        controlWindow: 100
    });
    ex.start();

    const requests = buildRequests(
        SEED + 3,
        (t) => (t >= BURST_START && t < BURST_END ? BURST_RPS : CALM_RPS),
        BURST_DURATION
    );
    for (const req of requests) {
        scheduler.schedule(req.at, () => {
            ex.run("web", () => backend.call(req.noise), { lane: "shared" }).then(
                () => metrics.complete(req.at, scheduler.now),
                () => metrics.shed(req.at, scheduler.now)
            );
        });
    }

    const samples: Array<{ t: number; limit: number; dropping: boolean; active: number }> = [];
    for (let t = 500; t <= BURST_DURATION; t += 500) {
        scheduler.schedule(t, () =>
            samples.push({
                t,
                limit: ex.getConcurrencyLimit("web"),
                dropping: ex.isOverloaded("web"),
                active: backend.active
            })
        );
    }

    await drive(BURST_DURATION + DRAIN);
    ex.stop();

    console.log("t(s)   limit  dropping  backendActive  good/s  shed/s");
    for (let sec = 10; sec <= 70; sec += 2) {
        const s = samples.filter((x) => x.t <= sec * 1000).pop();
        const b = metrics.buckets[sec];
        if (!s) continue;
        console.log(
            `${String(sec).padEnd(6)} ${String(s.limit).padStart(4)}   ${s.dropping ? "yes" : "no "}       ` +
                `${String(s.active).padStart(6)}        ${String(b?.good ?? 0).padStart(4)}    ${String(b?.shed ?? 0).padStart(4)}`
        );
    }
    const burst = metrics.phase(BURST_START + 5_000, BURST_END);
    console.log(
        `\nburst steady state: ${burst.goodPerSec.toFixed(0)}/s good of ${BURST_RPS} offered, ` +
            `${burst.shedPerSec.toFixed(0)}/s shed, p99 ${isNaN(burst.p99) ? "—" : burst.p99.toFixed(0) + "ms"} ` +
            `(backend could serve all of it: needs L ≈ 40 of capacity 100)\n`
    );
    return { samples, burstSteadyState: burst, buckets: metrics.buckets.map((b, i) => ({ t: i, good: b.good, shed: b.shed })) };
}

// ── Mode: knee (climb crosses the contention knee mid-run) ──────────
//
// Demand needs L ≈ 35 but the backend's knee is at 30: the queue-pressure
// climb from baseline 10 is healthy until ~30, then latency degrades.
// The design question this scenario decides: after the trend test fires
// near 35, where does the walk-back stop?
//   stop-on-signal-clear  → stops ~34 (trend flattens at the plateau) → ratchet
//   committed retraction  → unwinds all the way to 10 (run start) → deep dip
//   degradation latch     → holds until the LEVEL recovers → stops right at ~30

async function runKnee(baseline = argNum("baseline", 10)): Promise<object> {
    const RAMP_START = 15_000;
    const KNEE_DURATION = argNum("kneeDuration", 90_000);
    const DEMAND_RPS = 700;
    const CALM_RPS = 100;
    const KNEE_CAPACITY = 30;
    // When baseline ≫ knee, the limit starts on inert headroom: the
    // operating-concurrency clamp should SNAP it down to the binding point in
    // one decision rather than walking down dead space for several ticks.
    const highBaseline = baseline > KNEE_CAPACITY;

    console.log(
        `── Knee: baseline L=${baseline}${highBaseline ? " (HIGH — exercises the operating-concurrency clamp)" : ""}, ` +
            `backend knee at ${KNEE_CAPACITY}, demand ${DEMAND_RPS} rps needs L ≈ ${Math.ceil((DEMAND_RPS * BASE_MS) / 1000)} ──\n`
    );

    scheduler = new VirtualScheduler();
    const backend = new Backend(KNEE_CAPACITY);
    const metrics = new Metrics();
    const ex = new Executor({ logger });
    ex.registerPool("web", {
        baselineConcurrency: baseline,
        minimumConcurrency: 2,
        maximumConcurrency: 400,
        delayThreshold: 250,
        controlWindow: 100
    });
    ex.start();

    const requests = buildRequests(SEED + 4, (t) => (t >= RAMP_START ? DEMAND_RPS : CALM_RPS), KNEE_DURATION);
    for (const req of requests) {
        scheduler.schedule(req.at, () => {
            ex.run("web", () => backend.call(req.noise), { lane: "shared" }).then(
                () => metrics.complete(req.at, scheduler.now),
                () => metrics.shed(req.at, scheduler.now)
            );
        });
    }

    type KneeSample = {
        t: number;
        limit: number;
        latched: boolean;
        active: number;
        wTildeMs: number | null;
        referenceMs: number | null;
        bandUpperMs: number | null;
        dLogL: number | null;
        dLogW: number | null;
        resolution: number | null;
    };
    const samples: KneeSample[] = [];
    for (let t = 500; t <= KNEE_DURATION; t += 500) {
        scheduler.schedule(t + 1, () => {
            const s = ex.getSignalState<PowerDegradedState>("web", "power-degraded");
            samples.push({
                t,
                limit: ex.getConcurrencyLimit("web"),
                latched: s?.latched ?? false,
                active: backend.active,
                wTildeMs: s?.logWBar != null ? Math.exp(s.logWBar) : null,
                referenceMs: s?.referenceLevel != null ? Math.exp(s.referenceLevel) : null,
                bandUpperMs:
                    s?.referenceLevel != null && s?.recoveryMargin != null
                        ? Math.exp(s.referenceLevel + s.recoveryMargin)
                        : null,
                dLogL: s?.epsilon?.dLogL ?? null,
                dLogW: s?.epsilon?.dLogW ?? null,
                resolution: s?.recoveryMargin ?? null
            });
        });
    }

    await drive(KNEE_DURATION + DRAIN);
    ex.stop();

    // The "range test" made visible: the latch releases when W̃ falls back
    // inside [—, band] where band = reference · e^(z·SE_level).
    console.log("t(s)   limit  latched  W̃(ms)   ref(ms)  band(ms)  active  good/s  shed/s");
    for (let sec = 12; sec <= 88; sec += 2) {
        const s = samples.filter((x) => x.t <= sec * 1000).pop();
        const b = metrics.buckets[sec];
        if (!s) continue;
        const f = (x: number | null) => (x == null ? "  —" : x.toFixed(0).padStart(5));
        console.log(
            `${String(sec).padEnd(6)} ${String(s.limit).padStart(4)}   ${s.latched ? "yes" : "no "}     ` +
                `${f(s.wTildeMs)}   ${f(s.referenceMs)}   ${f(s.bandUpperMs)}    ${String(s.active).padStart(4)}   ` +
                `${String(b?.good ?? 0).padStart(4)}    ${String(b?.shed ?? 0).padStart(4)}`
        );
    }
    const bandWidths = samples
        .filter((s) => s.referenceMs != null && s.bandUpperMs != null && s.t > 10_000)
        .map((s) => (s.bandUpperMs! - s.referenceMs!) / s.referenceMs!);
    if (bandWidths.length > 0) {
        bandWidths.sort((a, b) => a - b);
        const q = (p: number) => bandWidths[Math.floor(p * (bandWidths.length - 1))];
        console.log(
            `\nrecovery band width (bandUpper/ref − 1): median ${(100 * q(0.5)).toFixed(1)}%, ` +
                `p10 ${(100 * q(0.1)).toFixed(1)}%, p90 ${(100 * q(0.9)).toFixed(1)}%`
        );
    }
    const steady = metrics.phase(RAMP_START + 20_000, KNEE_DURATION);
    const minLimitAfterClimb = Math.min(...samples.filter((s) => s.t > 30_000).map((s) => s.limit));

    // Clamp-descent metric (only meaningful when baseline ≫ knee): how long
    // after demand ramps up does the limit first reach the operating-
    // concurrency neighbourhood (≤ 1.5× knee)? With the snap, this is ~one
    // decision (≈ timeConstant · controlWindow after detection); without it,
    // a bisection walk from L=baseline takes O(log(baseline/knee)) decisions.
    let descentMs: number | null = null;
    if (highBaseline) {
        const target = 1.5 * KNEE_CAPACITY;
        const hit = samples.find((s) => s.t >= RAMP_START && s.limit <= target);
        descentMs = hit ? hit.t - RAMP_START : null;
        console.log(
            `\nclamp descent: L started at ${baseline}, first reached ≤ ${target.toFixed(0)} (operating ` +
                `concurrency) ${descentMs == null ? "NOT within the run" : `${(descentMs / 1000).toFixed(1)}s after demand onset`} ` +
                `— the snap collapses inert headroom in one decision instead of walking it down.`
        );
    }
    console.log(
        `\nsteady state: ${steady.goodPerSec.toFixed(0)}/s good, ${steady.shedPerSec.toFixed(0)}/s shed, ` +
            `p99 ${isNaN(steady.p99) ? "—" : steady.p99.toFixed(0) + "ms"} · min limit after climb: ${minLimitAfterClimb} ` +
            `(the latch should hold near ${KNEE_CAPACITY})\n`
    );
    return {
        baseline,
        samples,
        steady,
        minLimitAfterClimb,
        descentMs,
        buckets: metrics.buckets.map((b, i) => ({ t: i, good: b.good, shed: b.shed }))
    };
}

// ── Mode: clamp (operating-concurrency clamp under real headroom) ────
//
// The knee scenario fills in-flight up to the limit, so the limit *is* the
// operating concurrency (no headroom) and the clamp is inert. To exercise
// the clamp we need in-flight to stay BELOW the limit while latency still
// degrades — i.e. an EXOGENOUS slowdown (backend souring / noisy neighbour)
// with demand-limited traffic. Baseline is set far above the operating
// concurrency; when the incident hits, the limit should SNAP to the peak
// in-flight in one decision (instead of walking ~log(baseline/inflight)
// bisection steps through dead space), the binding-premise check should then
// find that throttling doesn't recover the exogenous latency, and release.
async function runClamp(): Promise<object> {
    const BASELINE = 300;
    const DEMAND_RPS = 120;
    const INCIDENT_START = 20_000;
    const INCIDENT_END = 45_000;
    const CLAMP_DURATION = 70_000;
    const SLOWDOWN = 6;

    console.log(
        `── Clamp: baseline L=${BASELINE} (far above operating concurrency), demand ${DEMAND_RPS} rps ` +
            `(in-flight ≈ ${Math.ceil((DEMAND_RPS * BASE_MS) / 1000)} healthy, ` +
            `${Math.ceil((DEMAND_RPS * BASE_MS * SLOWDOWN) / 1000)} during a ${SLOWDOWN}× exogenous slowdown), ` +
            `backend capacity 100 (our load never self-contends) ──\n`
    );

    scheduler = new VirtualScheduler();
    const backend = new Backend(100); // high capacity → our in-flight never self-contends
    const metrics = new Metrics();
    const ex = new Executor({ logger });
    ex.registerPool("web", {
        baselineConcurrency: BASELINE,
        minimumConcurrency: 2,
        maximumConcurrency: 400,
        delayThreshold: 250,
        controlWindow: 100
    });
    ex.start();

    const requests = buildRequests(SEED + 7, () => DEMAND_RPS, CLAMP_DURATION);
    for (const req of requests) {
        scheduler.schedule(req.at, () => {
            ex.run("web", () => backend.call(req.noise), { lane: "shared" }).then(
                () => metrics.complete(req.at, scheduler.now),
                () => metrics.shed(req.at, scheduler.now)
            );
        });
    }
    scheduler.schedule(INCIDENT_START, () => (backend.slowdown = SLOWDOWN));
    scheduler.schedule(INCIDENT_END, () => (backend.slowdown = 1));

    const samples: Array<{ t: number; limit: number; latched: boolean; active: number; wMs: number | null }> = [];
    for (let t = 500; t <= CLAMP_DURATION; t += 500) {
        scheduler.schedule(t + 1, () => {
            const s = ex.getSignalState<PowerDegradedState>("web", "power-degraded");
            samples.push({
                t,
                limit: ex.getConcurrencyLimit("web"),
                latched: s?.latched ?? false,
                active: backend.active,
                wMs: s?.logWBar != null ? Math.exp(s.logWBar) : null
            });
        });
    }

    await drive(CLAMP_DURATION + DRAIN);
    ex.stop();

    console.log("t(s)   limit  latched  in-flight  W̃(ms)");
    for (let sec = 16; sec <= 60; sec += 2) {
        const s = samples.filter((x) => x.t <= sec * 1000).pop();
        if (!s) continue;
        console.log(
            `${String(sec).padEnd(6)} ${String(s.limit).padStart(4)}   ${s.latched ? "yes" : "no "}     ` +
                `${String(s.active).padStart(4)}       ${s.wMs == null ? "  —" : s.wMs.toFixed(0).padStart(4)}`
        );
    }

    // Descent: with real headroom the limit should snap to the peak in-flight
    // in ~one decision after detection; the un-clamped walk-back would take
    // O(log(baseline/inflight)) bisection steps through inert headroom.
    const preIncidentLimit = samples.filter((s) => s.t < INCIDENT_START).pop()?.limit ?? BASELINE;
    const target = 3 * Math.ceil((DEMAND_RPS * BASE_MS * SLOWDOWN) / 1000); // ~3× the incident in-flight
    const hit = samples.find((s) => s.t >= INCIDENT_START && s.limit <= target);
    const descentMs = hit ? hit.t - INCIDENT_START : null;
    const minLimit = Math.min(...samples.filter((s) => s.t >= INCIDENT_START && s.t <= INCIDENT_END).map((s) => s.limit));
    const restored = samples.filter((s) => s.t > INCIDENT_END + 15_000).pop()?.limit ?? null;
    console.log(
        `\nclamp snap: L=${preIncidentLimit} before the incident → first reached ≤ ${target} ` +
            `${descentMs == null ? "NOT within the incident" : `${(descentMs / 1000).toFixed(1)}s after onset`} ` +
            `(min L during incident: ${minLimit}). The peak in-flight was ≈ ${Math.max(...samples.map((s) => s.active))}, ` +
            `so the limit snapped past ~${Math.max(0, preIncidentLimit - minLimit)} of inert headroom.`
    );
    console.log(
        `post-incident restore: L returned toward baseline (${restored ?? "—"}) once the exogenous ` +
            `slowdown cleared — throttling never recovered the latency, so the binding-premise check released.\n`
    );
    return { baseline: BASELINE, samples, descentMs, minLimit, restored };
}

// ── Mode: kneesweep (knee sharpness = contention exponent p = ε) ────
//
// Above the knee, log W = const + p·log L, so the backend exponent p IS
// the elasticity ε the signal measures. Sweep p from sharp (1.3) through
// the Little's-law boundary (1.0) to soft (0.3). The oracle switches
// strategy at exactly p = 1: for p ≥ 1 throughput is capped at the knee
// (hold L = capacity, shed the excess); for p < 1 throughput keeps
// growing past the knee, all demand is servable, and the correct move
// is to push THROUGH the knee. The ε test's null is ε = 1 — this sweep
// measures whether the system switches strategies at the right boundary.

async function runKneeSweep(): Promise<object> {
    const RAMP_START = 15_000;
    const SWEEP_DURATION = 90_000;
    const DEMAND_RPS = 700;
    const CALM_RPS = 100;
    const CAP = 30;
    const exponents = [1.3, 1.0, 0.7, 0.5, 0.3];

    console.log("── Knee sweep: contention exponent p (= ε above the knee), sharp → soft ──\n");
    console.log("p      oracle L*  oracle good/s   L(steady)  latched%   good/s  shed/s  p99(ok)");

    const rows: object[] = [];
    for (const p of exponents) {
        scheduler = new VirtualScheduler();
        const backend = new Backend(CAP, p);
        const metrics = new Metrics();
        const ex = new Executor({ logger });
        ex.registerPool("web", {
            baselineConcurrency: 10,
            minimumConcurrency: 2,
            maximumConcurrency: 400,
            delayThreshold: 250,
            controlWindow: 100
        });
        ex.start();

        const requests = buildRequests(SEED + 5, (t) => (t >= RAMP_START ? DEMAND_RPS : CALM_RPS), SWEEP_DURATION);
        for (const req of requests) {
            scheduler.schedule(req.at, () => {
                ex.run("web", () => backend.call(req.noise), { lane: "shared" }).then(
                    () => metrics.complete(req.at, scheduler.now),
                    () => metrics.shed(req.at, scheduler.now)
                );
            });
        }
        const samples: Array<{ t: number; limit: number; latched: boolean }> = [];
        for (let t = 500; t <= SWEEP_DURATION; t += 500) {
            scheduler.schedule(t + 1, () => {
                const st = ex.getSignalState<PowerDegradedState>("web", "power-degraded");
                samples.push({ t, limit: ex.getConcurrencyLimit("web"), latched: st?.latched ?? false });
            });
        }

        await drive(SWEEP_DURATION + DRAIN);
        ex.stop();

        // Oracle: X(L) = L / (base · max(1, L/CAP)^p); serve all demand if
        // possible, else max throughput (at the knee for p ≥ 1).
        const X = (L: number) => L / ((BASE_MS / 1000) * Math.pow(Math.max(1, L / CAP), p));
        let oracleL = CAP;
        let oracleGood = X(CAP);
        for (let L = CAP; L <= 400; L++) {
            if (X(L) >= DEMAND_RPS) {
                oracleL = L;
                oracleGood = DEMAND_RPS;
                break;
            }
            if (X(L) > oracleGood * (1 + 1e-9)) {
                oracleGood = X(L);
                oracleL = L;
            }
        }

        const steady = samples.filter((x) => x.t >= 45_000);
        const meanL = steady.reduce((a, x) => a + x.limit, 0) / Math.max(1, steady.length);
        const latchedPct = (100 * steady.filter((x) => x.latched).length) / Math.max(1, steady.length);
        const st = metrics.phase(45_000, SWEEP_DURATION);
        console.log(
            `${p.toFixed(1).padEnd(6)} ${String(oracleL).padStart(6)}     ${oracleGood.toFixed(0).padStart(6)}          ` +
                `${meanL.toFixed(0).padStart(5)}      ${latchedPct.toFixed(1).padStart(5)}%   ` +
                `${st.goodPerSec.toFixed(0).padStart(5)}   ${st.shedPerSec.toFixed(0).padStart(5)}   ${isNaN(st.p99) ? "—" : st.p99.toFixed(0) + "ms"}`
        );
        rows.push({ p, oracleL, oracleGood, meanL, latchedPct, goodPerSec: st.goodPerSec, shedPerSec: st.shedPerSec, p99: st.p99 });
    }
    console.log(
        "\nReading guide: for p ≥ 1 the oracle holds L at the knee and sheds; for p < 1 all demand is\n" +
            "servable above the knee and the oracle pushes through. The ε test's null is ε = 1 — the\n" +
            "system should switch strategies at that boundary.\n"
    );
    return { rows };
}

// ── Mode: warmup ─────────────────────────────────────────────────────

async function runWarmup(): Promise<object> {
    console.log("── Warm-up: cold start under healthy load — the critical value gates itself ──\n");
    scheduler = new VirtualScheduler();
    const backend = new Backend();
    const metrics = new Metrics();
    const ex = new Executor({ logger });
    ex.registerPool("web", { baselineConcurrency: 30, delayThreshold: 250, controlWindow: 100 });
    ex.start();

    const requests = buildRequests(SEED + 2, () => HEALTHY_RPS, 3_500);
    for (const req of requests) {
        scheduler.schedule(req.at, () => {
            ex.run("web", () => backend.call(req.noise), { lane: "shared" }).then(
                () => metrics.complete(req.at, scheduler.now),
                () => metrics.shed(req.at, scheduler.now)
            );
        });
    }

    const rows: Array<{ window: number; tCritical: number | string | null; zScore: number | null }> = [];
    for (let t = 100; t <= 3_200; t += 100) {
        scheduler.schedule(t + 1, () => {
            const s = ex.getSignalState<PowerDegradedState>("web", "power-degraded");
            rows.push({
                window: Math.round(t / 100),
                tCritical: s?.tCritical == null ? null : Number.isFinite(s.tCritical) ? s.tCritical : "Infinity",
                zScore: s?.zScore ?? null
            });
        });
    }
    await drive(4_000);
    ex.stop();

    console.log("window  critical value   z-statistic");
    for (const r of rows) {
        const crit =
            r.tCritical == null || r.tCritical === 0
                ? "(not evaluable — δ² warm-up)"
                : r.tCritical === "Infinity"
                  ? "∞  (df < 5)"
                  : (r.tCritical as number).toFixed(3);
        console.log(`${String(r.window).padEnd(7)} ${crit.padEnd(30)} ${r.zScore == null ? "—" : r.zScore.toFixed(3)}`);
    }
    console.log(
        "\nThe test cannot fire until the critical value becomes finite — df crosses 5 roughly 1.2\n" +
            "time constants (~11 windows) after cold start. No warm-up counters exist in the code.\n"
    );
    return { rows };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    // Determinism: the executor's shedding (ProDel drops, EarlyShed) rides the
    // global Math.random. Seed it so every run — and every regenerated graph —
    // is byte-for-byte reproducible (override with --randomSeed). Restored in
    // the finally below so nothing leaks past this process.
    const origRandom = Math.random;
    Math.random = mulberry32(argNum("randomSeed", 0xc0ffee));
    try {
        await run();
    } finally {
        Math.random = origRandom;
    }
}

async function run(): Promise<void> {
    const out: Record<string, object> = {};
    if (MODE === "all" || MODE === "compare") out.compare = await runCompare();
    if (MODE === "all" || MODE === "anatomy") out.anatomy = await runAnatomy();
    if (MODE === "all" || MODE === "burst") out.burst = await runBurst();
    if (MODE === "all" || MODE === "knee") out.knee = await runKnee();
    // Clamp: high baseline + exogenous slowdown + demand-limited in-flight →
    // real headroom, so the operating-concurrency clamp snaps the limit down.
    if (MODE === "all" || MODE === "clamp") out.clamp = await runClamp();
    if (MODE === "all" || MODE === "kneesweep") out.kneesweep = await runKneeSweep();
    if (MODE === "all" || MODE === "warmup") out.warmup = await runWarmup();

    const dir = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(dir, "benchmark-comparison.json");
    writeFileSync(jsonPath, JSON.stringify(out, null, 1));
    const htmlPath = join(dir, "benchmark-comparison.html");
    writeFileSync(htmlPath, htmlReport(out));
    console.log(`Raw traces written to ${jsonPath}`);
    console.log(`Charts written to ${htmlPath} — open in a browser.`);
}


// ── Self-contained HTML chart report (Chart.js, same pattern as docs/theory-plots.html) ──

function htmlReport(out: Record<string, object>): string {
    const head = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>concurrex: comparative benchmarks</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
    body { font-family: system-ui, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; background: #0d1117; color: #e6edf3; }
    h1 { margin-bottom: 4px; color: #e6edf3; }
    h2 { margin-top: 48px; border-bottom: 2px solid #30363d; padding-bottom: 4px; color: #e6edf3; }
    .subtitle { color: #8b949e; margin-top: 0; }
    .chart-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .description { color: #8b949e; font-size: 14px; margin: 8px 0 16px 0; line-height: 1.5; }
    code { background: #21262d; padding: 2px 6px; border-radius: 3px; font-size: 13px; color: #e6edf3; }
    canvas { max-height: 320px; }
</style>
</head>
<body>
<h1>concurrex: comparative benchmarks</h1>
<p class="subtitle">Generated by <code>simulations/benchmark-comparison.ts</code> — deterministic virtual-clock simulation, seeded arrivals.</p>

<div id="sec-compare">
<h2>Head-to-head: 3&times; overload</h2>
<p class="description">Identical seeded arrival stream against four front-ends. Goodput = completions within the 1s deadline.</p>
<div class="chart-container"><canvas id="cmp-goodput"></canvas></div>
<div class="chart-container"><canvas id="cmp-p99"></canvas></div>
</div>

<div id="sec-anatomy">
<h2>Incident anatomy: capacity loss</h2>
<p class="description">Backend loses 70% of capacity at t=20s, restored at t=45s. Top: measured residence W&#771; and the concurrency limit reacting. Bottom: the test statistic crossing its critical value (detection), and goodput.</p>
<div class="chart-container"><canvas id="ana-latency"></canvas></div>
<div class="chart-container"><canvas id="ana-test"></canvas></div>
</div>

<div id="sec-burst">
<h2>Headroom burst: scale-up is unimpeded</h2>
<p class="description">Baseline L=10, backend capacity 100, demand jumps to need L&asymp;40. A healthy climb produces no latency trend, so nothing holds the regulator back.</p>
<div class="chart-container"><canvas id="burst-limit"></canvas></div>
</div>

<div id="sec-knee">
<h2>The range test: knee crossing</h2>
<p class="description">Demand needs L&asymp;35 but the backend knee is at 30. The ribbon is the latch's release band [reference, reference&middot;e^(z&middot;SE)]; the latch (shaded 0/1) holds while W&#771; is above the band and releases when it re-enters — the walk-back stops at the knee, not at the run start.</p>
<div class="chart-container"><canvas id="knee-band"></canvas></div>
<div class="chart-container"><canvas id="knee-epsilon"></canvas></div>
<div class="chart-container"><canvas id="knee-limit"></canvas></div>
</div>

<script>
const DATA = `;
    const tail = `;
Chart.defaults.color = "#8b949e";
Chart.defaults.borderColor = "#21262d";
function line(label, pts, color, extra) {
    return Object.assign(
        { label: label, data: pts, borderColor: color, backgroundColor: color,
          pointRadius: 0, borderWidth: 2, tension: 0.15, spanGaps: false },
        extra || {});
}
function mk(id, datasets, extraOpts) {
    new Chart(document.getElementById(id), {
        type: "line",
        data: { datasets: datasets },
        options: Object.assign({
            animation: false,
            interaction: { mode: "index", intersect: false },
            scales: { x: { type: "linear", title: { display: true, text: "t (s)" } } }
        }, extraOpts || {})
    });
}
function hide(id) { document.getElementById(id).style.display = "none"; }
const COLORS = { concurrex: "#3fb950", "concurrex-trend": "#7ee787", unbounded: "#f85149", "fixed-queue": "#d29922", "timeout-shed": "#58a6ff", aimd: "#ffa657", vegas: "#79c0ff", gradient2: "#f778ba" };

if (DATA.compare) {
    const traces = DATA.compare.traces;
    mk("cmp-goodput", traces.map(function (tr) {
        return line(tr.strategy, tr.buckets.map(function (b) { return { x: b.t, y: b.good }; }), COLORS[tr.strategy] || "#888");
    }), { plugins: { title: { display: true, text: "Goodput (completions within deadline, per second)" } } });
    mk("cmp-p99", traces.map(function (tr) {
        return line(tr.strategy, tr.buckets.map(function (b) { return { x: b.t, y: b.p99 }; }), COLORS[tr.strategy] || "#888");
    }), { plugins: { title: { display: true, text: "p99 latency of successful requests (ms)" } },
          scales: { x: { type: "linear", title: { display: true, text: "t (s)" } }, y: { type: "logarithmic" } } });
} else hide("sec-compare");

if (DATA.anatomy) {
    const sm = DATA.anatomy.samples;
    const t = function (x) { return x.t / 1000; };
    mk("ana-latency", [
        line("W\u0303 (ms)", sm.map(function (x) { return { x: t(x), y: x.wTildeMs }; }), "#e6edf3"),
        line("limit L", sm.map(function (x) { return { x: t(x), y: x.limit }; }), "#a371f7", { yAxisID: "y1" }),
        line("backend active", sm.map(function (x) { return { x: t(x), y: x.backendActive }; }), "#bbb", { yAxisID: "y1", borderDash: [4, 3] })
    ], { plugins: { title: { display: true, text: "Latency and the limit's response" } },
         scales: { x: { type: "linear", title: { display: true, text: "t (s)" } },
                   y: { title: { display: true, text: "ms" } },
                   y1: { position: "right", grid: { drawOnChartArea: false } } } });
    mk("ana-test", [
        line("z statistic", sm.map(function (x) { return { x: t(x), y: x.zScore }; }), "#e6edf3"),
        line("critical value", sm.map(function (x) { return { x: t(x), y: typeof x.tCritical === "number" ? x.tCritical : null }; }), "#c33", { borderDash: [6, 4] }),
        line("goodput/s", (DATA.anatomy.buckets || []).map(function (b) { return { x: b.t, y: b.good }; }), "#0a7", { yAxisID: "y1" })
    ], { plugins: { title: { display: true, text: "Detection: test statistic vs critical value" } },
         scales: { x: { type: "linear", title: { display: true, text: "t (s)" } },
                   y: { min: -25, max: 25 },
                   y1: { position: "right", grid: { drawOnChartArea: false } } } });
} else hide("sec-anatomy");

if (DATA.burst) {
    const sm = DATA.burst.samples;
    mk("burst-limit", [
        line("limit L", sm.map(function (x) { return { x: x.t / 1000, y: x.limit }; }), "#95c"),
        line("backend active", sm.map(function (x) { return { x: x.t / 1000, y: x.active }; }), "#bbb", { borderDash: [4, 3] }),
        line("goodput/s", (DATA.burst.buckets || []).map(function (b) { return { x: b.t, y: b.good }; }), "#0a7", { yAxisID: "y1" }),
        line("shed/s", (DATA.burst.buckets || []).map(function (b) { return { x: b.t, y: b.shed }; }), "#c33", { yAxisID: "y1", borderDash: [2, 2] })
    ], { plugins: { title: { display: true, text: "Burst: limit scales 10 \u2192 ~40 in seconds" } },
         scales: { x: { type: "linear", title: { display: true, text: "t (s)" } },
                   y: { title: { display: true, text: "concurrency" } },
                   y1: { position: "right", grid: { drawOnChartArea: false } } } });
} else hide("sec-burst");

if (DATA.knee) {
    const sm = DATA.knee.samples;
    const t = function (x) { return x.t / 1000; };
    mk("knee-band", [
        line("W\u0303 (ms)", sm.map(function (x) { return { x: t(x), y: x.wTildeMs }; }), "#e6edf3"),
        line("reference", sm.map(function (x) { return { x: t(x), y: x.referenceMs }; }), "#3fb950", { borderWidth: 1 }),
        line("release band", sm.map(function (x) { return { x: t(x), y: x.bandUpperMs }; }), "rgba(0,170,119,0.25)", { borderWidth: 1, fill: "-1", backgroundColor: "rgba(0,170,119,0.15)" }),
        line("latched", sm.map(function (x) { return { x: t(x), y: x.latched ? 1 : 0 }; }), "#c33", { yAxisID: "y1", stepped: true, borderWidth: 1 })
    ], { plugins: { title: { display: true, text: "The range test: level vs release band, latch state" } },
         scales: { x: { type: "linear", title: { display: true, text: "t (s)" } },
                   y: { title: { display: true, text: "ms" } },
                   y1: { position: "right", min: 0, max: 1.05, grid: { drawOnChartArea: false }, ticks: { stepSize: 1 } } } });
    mk("knee-epsilon", [
        line("\u2212\u0394\u2113 (log-concurrency change)", sm.map(function (x) { return { x: t(x), y: x.dLogL == null ? null : -x.dLogL }; }), "#a371f7", { stepped: true }),
        line("D = \u0394w \u2212 \u0394\u2113 (log-throughput cost)", sm.map(function (x) { return { x: t(x), y: (x.dLogL == null || x.dLogW == null) ? null : x.dLogW - x.dLogL }; }), "#ff7b72"),
        line("resolution m = z\u00b7SE", sm.map(function (x) { return { x: t(x), y: x.resolution }; }), "#3fb950", { borderDash: [5, 4], borderWidth: 1 })
    ], { plugins: { title: { display: true, text: "The \u03b5 test: release when \u2212\u0394\u2113 \u2265 m and D \u2265 m" } },
         scales: { x: { type: "linear", title: { display: true, text: "t (s)" } },
                   y: { title: { display: true, text: "log units" } } } });
    mk("knee-limit", [
        line("limit L", sm.map(function (x) { return { x: t(x), y: x.limit }; }), "#95c"),
        line("backend active", sm.map(function (x) { return { x: t(x), y: x.active }; }), "#bbb", { borderDash: [4, 3] }),
        line("goodput/s", (DATA.knee.buckets || []).map(function (b) { return { x: b.t, y: b.good }; }), "#0a7", { yAxisID: "y1" }),
        line("shed/s", (DATA.knee.buckets || []).map(function (b) { return { x: b.t, y: b.shed }; }), "#c33", { yAxisID: "y1", borderDash: [2, 2] })
    ], { plugins: { title: { display: true, text: "Limit holds the knee (capacity 30); min after climb stays near the knee" } },
         scales: { x: { type: "linear", title: { display: true, text: "t (s)" } },
                   y: { title: { display: true, text: "concurrency" } },
                   y1: { position: "right", grid: { drawOnChartArea: false } } } });
} else hide("sec-knee");
</script>
</body>
</html>`;
    return head + JSON.stringify(out) + tail;
}

void main();
