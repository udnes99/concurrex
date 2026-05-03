# Concurrex

Fully adaptive task executor for Node.js and browsers. Self-regulates concurrency limits, sheds load under pressure, and schedules fairly across lanes — no manual tuning, no environment-specific configuration. Automatically derives detection thresholds, filter parameters, and convergence rates.

Zero dependencies. ESM-only. Works in Node.js (>=18), Deno, Bun, and browsers.

## Install

```
npm install concurrex
```

## Quick Start

```typescript
import { Executor } from 'concurrex';

const executor = new Executor();
executor.registerPool("http", { baselineConcurrency: 50 });
executor.start();

await executor.run("http", () => handleRequest(), { lane: "tenant-123" });

executor.stop(); // rejects queued tasks, cleans up timers
```

## Use Cases

Concurrex wraps any async operation — if it can saturate, overload, or fail under pressure, Concurrex can manage it.

- **HTTP servers** — admission control for Express, Fastify, Koa. Shed excess requests with instant 503s instead of letting the entire server slow down.
- **Database access** — cap concurrent queries to Postgres, MySQL, Redis. Prevent connection pool exhaustion and protect downstream capacity.
- **External API calls** — rate-limit outbound requests to third-party services. Per-lane fairness ensures one tenant cannot monopolize API quota.
- **Message processing** — throttle Kafka, RabbitMQ, or SQS consumers. Back-pressure signal (`isOverloaded`) tells the consumer when to pause fetching.
- **Background jobs** — manage parallel execution of cron jobs, data pipelines, or batch imports without overwhelming shared resources.
- **AI/LLM inference** — control concurrent requests to model endpoints with automatic latency-based backoff.
- **File I/O and uploads** — limit parallel disk or network operations to avoid thrashing.
- **Multi-tenant systems** — lane-based fairness prevents noisy neighbors. Each tenant gets equal access regardless of request volume.

Multiple pools let you isolate different workloads (e.g. user-facing commands vs background sync) with independent limits and detection sensitivity.

## How It Works

Six mechanisms cooperate:

1. **ProDel** (Probabilistic Delay Load-shedding) — sojourn-based AQM. Drop probability `P = 1 - threshold/sojourn`. Adaptive LIFO/FIFO admission (FIFO when healthy, LIFO when dropping to protect fresh work).
2. **Probabilistic early shedding** — rejects new arrivals at enqueue time with `P = dropRate/(dropRate+completionRate) * shrinkage` when ProDel is dropping and pool is at capacity. Instant rejections.
3. **EWMA throughput regulator** — latency detection via operational Little's Law (`W = integral N(t)dt / completions`), log-transformed, smoothed by a shrinkage-dampened level EWMA. A Student-t hypothesis test on the trend detects sustained upward drift, with SE formula `√(δ² × W² × (1+W²) / (2 × (1+α/2)))` derived from von Neumann's lag-1 squared-difference noise estimator (drift-invariant) plus an autocorrelation variance-reduction factor for the EWMA. False-positive rate is upper-bounded by Φ(−Z) at steady state (≤2.3% at Z=2); small-sample conservatism comes from the Student-t critical value widening as effective sample size shrinks. Concurrency adjusted via a convergent step formula with bisection damping for O(log L) equilibrium convergence.
4. **Pluggable backpressure signals** — pools auto-decrease concurrency when any configured signal triggers. The default is `LatencyDrift` (the trend test from #3). Opt-in built-ins include `ErrorRateThreshold`, `ProbabilisticErrorRate`, and users can implement custom `Signal`s for application-specific conditions (deadline pressure, memory usage, downstream health). Configurable globally on the executor and overridable per-pool.
5. **Per-lane error shedding** — each lane tracks its own error rate EWMA. High-error lanes probabilistically reject new requests without affecting pool-wide concurrency.
6. **Fair lane scheduling** — round-robin across lanes (per-tenant, per-user, or shared). Prevents noisy neighbors from monopolizing capacity.

## Single-Constant Design

All statistical parameters derive from one constant: `zScoreThreshold` (default: 2). This determines TIME_CONSTANT (EWMA decay), Bayesian shrinkage strength, warm-up period, evaluation cadence, and detection sensitivity. Configurable globally and per-pool.

```typescript
// Global default
const executor = new Executor({ zScoreThreshold: 2 });

// Per-pool override — tighter detection for user-facing, looser for background
executor.registerPool("commands", { zScoreThreshold: 1.5 });
executor.registerPool("background", { zScoreThreshold: 3 });
executor.registerPool("queries"); // inherits global z=2
```

## Pool Configuration

```typescript
executor.registerPool("commands", {
    delayThreshold: 100,       // Max acceptable sojourn time (ms) before ProDel reacts
    controlWindow: 100,        // Time window for ProDel grace period and throughput measurement
    baselineConcurrency: 50,   // Starting concurrency limit; gravity target during recovery
    minimumConcurrency: 5,     // Floor — limit never decreases below this
    maximumConcurrency: 200,   // Ceiling — regulator never increases above this
    zScoreThreshold: 1.5,      // Override detection sensitivity for this pool
});
```

| Parameter | Default | Description |
|---|---|---|
| `delayThreshold` | 100ms | Sojourn time above which ProDel considers the queue unhealthy |
| `controlWindow` | 100ms | Time window for ProDel grace period and throughput measurement |
| `baselineConcurrency` | 100 | Starting limit; gravity pulls back to this during recovery |
| `minimumConcurrency` | 1 | Absolute floor for the concurrency limit |
| `maximumConcurrency` | Infinity | Absolute ceiling for the concurrency limit |
| `zScoreThreshold` | (inherit) | Detection sensitivity; overrides the executor-level default |
| `signals` | (inherit) | Backpressure signals; replaces the executor-level list when specified |

## Backpressure Signals

Pools auto-decrease concurrency when any of their configured `Signal`s is triggered. The default is `[new LatencyDrift()]` — the v1.2 latency-trend test. Add or replace signals at the executor or pool level:

```typescript
import { Executor, LatencyDrift, ErrorRateThreshold, ProbabilisticErrorRate } from 'concurrex';

// Executor-level default applies to every pool that doesn't override
const executor = new Executor({
    signals: [
        new LatencyDrift(),                       // default
        new ErrorRateThreshold({ threshold: 0.5 }) // also fire above 50% error rate
    ]
});

// Per-pool override — replaces executor defaults entirely
executor.registerPool("api", {
    signals: [new LatencyDrift(), new ProbabilisticErrorRate()]
});

// Empty array = "never auto-decrease on backpressure"
executor.registerPool("debug", { signals: [] });

// Custom signal — implement the Signal interface
const memoryPressure: Signal = {
    name: "memory-pressure",
    triggered: () => process.memoryUsage().heapUsed > 1_000_000_000
};
executor.registerPool("ingest", {
    signals: [new LatencyDrift(), memoryPressure]
});
```

Built-in signals:
- **`LatencyDrift`** — fires when the trend test detects sustained upward latency drift. Default for every pool.
- **`ErrorRateThreshold({ threshold })`** — fires when `errorRateEwma` exceeds the threshold ∈ [0, 1].
- **`ProbabilisticErrorRate()`** — fires probabilistically with `P = errorRateEwma`. Self-scaling response to systemic errors. Preserves v1.2 default behavior; opt-in for v1.3+.

Custom signals implement:

```typescript
interface Signal {
    readonly name: string;
    triggered(ctx: SignalContext): boolean;
}
```

`SignalContext` exposes pool size, in-flight, queue length, and the full `RegulatorState` snapshot. Multiple signals are combined with OR semantics — any signal triggering causes a decrease.

## Lanes

```typescript
// Per-user lane — fairness across users
await executor.run("commands", handleCommand, { lane: "tenant-123" });

// No lane — each call gets a unique transient lane (maximum fairness)
await executor.run("commands", handleCommand);

// Shared lane — all requests compete in one queue
await executor.run("http", handleRequest, { lane: "shared" });
```

## Debouncing

```typescript
import { Executor, DebounceMode } from 'concurrex';

// Only executes once even if called 3 times concurrently
const p1 = executor.runDebounced("queries", "user-123", () => fetchUser("123"));
const p2 = executor.runDebounced("queries", "user-123", () => fetchUser("123"));
const p3 = executor.runDebounced("queries", "user-123", () => fetchUser("123"));
// p1, p2, p3 all resolve to the same result

// BeforeResult mode — deduplicate until the task completes
executor.runDebounced("queries", "user-123", () => fetchUser("123"), {
    mode: DebounceMode.BeforeResult
});
```

Two modes:
- **`DebounceMode.BeforeExecution`** (default): Deduplicate until the task starts running.
- **`DebounceMode.BeforeResult`**: Deduplicate until the task completes.

## Back-Pressure and Inspection

```typescript
executor.isOverloaded("commands");         // true when in DROPPING state
executor.isThroughputDegraded("commands"); // latency degradation detected
executor.getInFlight("commands");          // current in-flight count
executor.getQueueLength("commands");       // current queue depth
executor.getConcurrencyLimit("commands");  // current regulated limit
executor.getRegulatorState("commands");    // full filter state snapshot
```

`isOverloaded` returns `true` only during confirmed sustained overload (dropping state). Use this to pause upstream work fetching.

`getRegulatorState` returns a `RegulatorState` with the filter internals: `logW`, `logWBar`, `dLogWBarEwma`, `dLogWBarVarianceEstimate`, `ewmaSumW2`, `se`, `zScore`, `tCritical`, `threshold`, `degrading`, `inFlightEwma`, `completionRateEwma`, `admissionRateEwma`, `dropRateEwma`, `errorRateEwma`, `regulationPhase`, `regulationDepth`, `elapsedWindows`, `alpha`. Use `threshold` (= `tCritical × se`) to plot the actual firing boundary — NOT `zScoreThreshold × se`, which is only correct at steady-state df.

`dLogWBarVarianceEstimate` is von Neumann's δ² — an EWMA of `(v_k − v_{k-1})²/2`, where `v` is the trend signal `dLogWBar`. It's a drift-invariant noise estimator: pairwise differences cancel any sustained drift, so δ² stays calibrated to the actual noise level even under sustained latency degradation. See `docs/THEORY.md` §4.2.6 for the derivation.

## Error Handling

```typescript
import { Executor, ResourceExhaustedError, ConcurrexError } from 'concurrex';

try {
    await executor.run("commands", () => handleCommand());
} catch (err) {
    if (err instanceof ResourceExhaustedError) {
        // Task rejected — overloaded, early shed, or per-lane shed
        return res.status(503).send("Service busy");
    }
    throw err; // re-throw application errors
}

// Or catch all concurrex errors
try { ... } catch (err) {
    if (err instanceof ConcurrexError) { /* any concurrex error */ }
}
```

**Error classes:**
- **`ConcurrexError`** — base class for all concurrex errors. Use for catch-all.
- **`ResourceExhaustedError`** — task rejected due to overload (ProDel drop, early shed, or per-lane shed).
- **`ExecutorNotRunningError`** — `run()` called after `stop()`.
- **`ArgumentError`** — invalid configuration (duplicate pool, bad parameters).

## Logger

Defaults to `console`. Pass any object with `info`, `warn`, `error`, and `debug` methods (pino, winston, etc.).

```typescript
const executor = new Executor(); // uses console
const executor2 = new Executor({ logger: myPinoLogger });
```

## API

```typescript
class Executor {
    constructor(options?: { logger?: Logger; zScoreThreshold?: number });

    // Lifecycle
    start(): void;
    stop(): void;

    // Configuration
    registerPool(name: string, options?: PoolOptions): void;

    // Task execution
    run<T>(pool: string, task: () => T, options?: TaskRunOptions): Promise<T>;
    runDebounced<T>(pool: string, key: string, task: () => Promise<T> | T,
                    options?: TaskRunDebouncedOptions): Promise<T>;

    // Inspection
    isOverloaded(pool: string): boolean;
    isThroughputDegraded(pool: string): boolean;
    getInFlight(pool: string): number;
    getQueueLength(pool: string): number;
    getConcurrencyLimit(pool: string): number;
    getRegulatorState(pool: string): RegulatorState;

    // Derived constants (read-only, executor-level defaults)
    readonly zScoreThreshold: number;
    readonly timeConstant: number;
}
```

## Theory

See [THEORY.md](https://github.com/udnes99/concurrex/blob/main/docs/THEORY.md) for formal analysis with 17 theorems and proofs covering convergence guarantees, stability bounds, and fairness properties.

## License

MIT
