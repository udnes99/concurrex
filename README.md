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

The executor owns the *engine* — the queue, lanes, the statistical heartbeat, and the concurrency/admission actuators — and delegates *policy* to pluggable signals. Four mechanisms cooperate:

1. **ProDel** (Probabilistic Delay Load-shedding) — the core queue engine. Sojourn-based AQM: drop probability `P = 1 - threshold/sojourn`. Adaptive LIFO/FIFO admission (FIFO when healthy, LIFO when dropping to protect fresh work).
2. **Regulator signals** — decide *concurrency*. Each pool runs a list of `RegulatorSignal`s; once per evaluation cycle, if any returns `triggered()`, the regulator decreases the limit (OR semantics). The built-in default is `PowerDegraded` — a two-channel signal that protects Kleinrock's power knee: a calibrated Student-t latency-trend test (`dW/dt`, operational Little's Law) *arms* a degradation latch, and an elasticity test (`dW/dL`, measured while the limit moves) *attributes* the degradation to concurrency and releases when it's exogenous. FPR is upper-bounded by Φ(−Z) per statistical signal; joint FPR across N signals is bounded by Bonferroni `N · Φ(−Z)`. Concurrency adjusted via a convergent step formula with bisection damping for O(log L) equilibrium convergence.
3. **Admission signals** — decide *enqueue-time shedding*. Each pool runs a list of `AdmissionSignal`s queried per request with the target lane; if any returns `shouldShed()`, the request is rejected instantly (OR semantics). The built-in default is `EarlyShed` — probabilistic early rejection (`P = dropRate/(dropRate+completionRate) * shrinkage`) when ProDel is dropping and the pool is at capacity. `LaneErrorShed` (per-lane error shedding) is an exported opt-in. Error-driven backpressure is domain-specific (HTTP 5xx vs business errors vs timeouts) — see `examples/express-server.ts`.
4. **Fair lane scheduling** — round-robin across lanes (per-tenant, per-user, or shared). Prevents noisy neighbors from monopolizing capacity.

All statistical parameters in the framework — α, ESS, df, Bayesian shrinkage, time constant — derive from a single `zScoreThreshold` per pool. The pool computes this shared inference state (informally, its "heartbeat") once per evaluation and exposes it to every signal via `SignalContext.inference`. The framework's rigor is preserved when composing multiple signals.

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
| `regulatorSignals` | (inherit) | Concurrency-policy signals (replaces executor's defaults entirely) |
| `admissionSignals` | (inherit) | Admission-policy signals (replaces executor's defaults entirely) |

## Signals

Policy is pluggable through two kinds of signal, both sharing lifecycle hooks (`onAdmit`, `onComplete`, `onEvaluate`, `onLaneRemoved`) and optional `state()`:

- **`RegulatorSignal`** decides *concurrency* — `triggered()` is checked once per evaluation cycle; if any signal fires, the regulator decreases the limit. Default: `[new PowerDegraded()]`.
- **`AdmissionSignal`** decides *admission* — `shouldShed(ctx, laneKey)` is queried per request at enqueue; if any returns `true`, the request is rejected instantly. Default: `[new EarlyShed()]`.

```typescript
import { Executor, PowerDegraded, EarlyShed, LaneErrorShed } from "concurrex";

// Defaults: PowerDegraded (concurrency) + EarlyShed (admission)
const executor = new Executor();

// Per-pool override — each list replaces the executor defaults entirely (no merge)
executor.registerPool("api", {
    regulatorSignals: [new PowerDegraded()],
    admissionSignals: [new EarlyShed(), new LaneErrorShed()] // opt into per-lane shedding
});

// Empty arrays disable that policy (ProDel queue management still applies)
executor.registerPool("debug", { regulatorSignals: [], admissionSignals: [] });
```

### Built-in signals

- **`PowerDegraded`** (regulator, default) — protects Kleinrock's power knee (the operating point where more concurrency stops buying throughput). Two channels: a calibrated Student-t **latency-trend** test (`dW/dt` on an operational-Little's-Law residence pipeline) *arms* the degradation latch; an **elasticity** test (`dW/dL`, measured while the regulator's own limit moves) then *attributes and releases* — it keeps throttling only while concurrency is the cause and the actuator is helping, re-basing to the new normal when latency is exogenous. Uses the pool's shared inference state (α, ESS, df from `zScoreThreshold`) and composes matched EWMAs + δ² inline. FPR upper-bounded by Φ(−Z).
- **`EarlyShed`** (admission, default) — sheds an arrival when ProDel is dropping and the pool is at capacity, with `P = dropRate/(dropRate+completionRate) * shrinkage`. Queue-health based, domain-agnostic.
- **`LaneErrorShed`** (admission, opt-in) — tracks each lane's error-rate EWMA and sheds new requests to a failing lane (`P = lane.errorRateEwma`). Off by default — an "error" is domain-specific (a 404, a validation failure, or a business rejection is not an infrastructure failure), so the executor does not assume errors should shed work.

There is no built-in *pool-wide* error signal. To make errors drive concurrency, write a `RegulatorSignal` that observes `info.errored` in `onComplete` — see `examples/express-server.ts`.

### Custom signals

Implement `RegulatorSignal` or `AdmissionSignal`. The pool's shared inference state (α, ESS, df, shrinkage) is exposed via `ctx.inference` — use it (with `Statistics.*` utilities) to build statistically rigorous detectors, or just write a predicate. Controller state and smoothed rate observations are separate, under `ctx.regulator`.

```typescript
import type { RegulatorSignal, AdmissionSignal } from "concurrex";

// Predicate regulator signal — decreases concurrency under memory pressure.
const memorySignal: RegulatorSignal = {
    name: "memory-pressure",
    triggered: () => process.memoryUsage().heapUsed > 1_000_000_000,
    clone() { return this; }
};

// Predicate admission signal — sheds at enqueue when a breaker is open.
const breaker: AdmissionSignal = {
    name: "circuit-breaker",
    shouldShed: () => myBreaker.isOpen(),
    clone() { return this; }
};

executor.registerPool("ingest", {
    regulatorSignals: [new PowerDegraded(), memorySignal],
    admissionSignals: [new EarlyShed(), breaker]
});
```

Lifecycle hooks are optional — a minimal signal is just `{ name, triggered|shouldShed, clone }`. Signals holding per-lane state populate it in `onComplete(info.lane, …)` and release it in `onLaneRemoved(laneKey)`. For a statistically rigorous signal, follow `PowerDegraded`'s pattern (compose `Statistics.tScore`, `Statistics.studentTTrendSE`, etc. with inline EWMA state). See `src/signals.ts`.

### Inspecting signal state

```typescript
// General regulator state (rate EWMAs, regulation phase, etc.)
executor.getRegulatorState("api");

// Per-signal internal state (PowerDegraded's logWBar, zScore, tCritical, etc.)
executor.getSignalState<PowerDegradedState>("api", "power-degraded");
```

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
executor.getRegulatorState("commands");    // controller state + rate EWMAs
```

`isOverloaded` returns `true` only during confirmed sustained overload (dropping state). Use this to pause upstream work fetching.

`getRegulatorState` returns a `RegulatorState` with general regulator metrics: `inFlightEwma`, `completionRateEwma`, `admissionRateEwma`, `dropRateEwma`, `regulationPhase`, `regulationDepth`, `elapsedWindows`, `overloadDetected` (= "any regulator signal is currently triggered").

For signal-specific state (e.g. `PowerDegraded`'s `logWBar`, `dLogWBarEwma`, `dLogWBarVarEst`, `se`, `zScore`, `tCritical`, `threshold`), use `executor.getSignalState<S>(pool, signalName)`. Pass the signal's state type (e.g. `PowerDegradedState`) to get a typed result back. See `docs/THEORY.md` §4.2 for the derivation of the latency-trend Student-t test and its components.

## Error Handling

```typescript
import { Executor, ResourceExhaustedError, ConcurrexError } from 'concurrex';

try {
    await executor.run("commands", () => handleCommand());
} catch (err) {
    if (err instanceof ResourceExhaustedError) {
        // Task rejected — ProDel drop or an admission signal shed
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
- **`ResourceExhaustedError`** — task rejected due to overload (ProDel drop, or an admission signal shedding at enqueue).
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
    constructor(options?: {
        logger?: Logger;
        zScoreThreshold?: number;
        regulatorSignals?: RegulatorSignal[];   // default: [new PowerDegraded()]
        admissionSignals?: AdmissionSignal[];   // default: [new EarlyShed()]
    });

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
    isOverloaded(pool: string): boolean;          // ProDel `dropping` state
    isThroughputDegraded(pool: string): boolean;  // any regulator signal triggered
    getInFlight(pool: string): number;
    getQueueLength(pool: string): number;
    getConcurrencyLimit(pool: string): number;
    getRegulatorState(pool: string): RegulatorState;
    getSignalState<S = unknown>(pool: string, signalName: string): S | undefined;

    // Derived constants (read-only, executor-level defaults)
    readonly zScoreThreshold: number;
    readonly timeConstant: number;
}
```

> `isOverloaded` and `isThroughputDegraded` (alias: `RegulatorState.overloadDetected`) report orthogonal conditions: the former is ProDel's sustained-queue-overload state; the latter is "any configured regulator signal currently fires". A pool can be one without the other.

## Theory

See [THEORY.md](https://github.com/udnes99/concurrex/blob/main/docs/THEORY.md) for the formal analysis — theorems and proofs covering convergence guarantees, stability bounds, and the FPR calibration of the statistical framework.

## License

MIT
