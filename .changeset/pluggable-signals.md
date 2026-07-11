---
"concurrex": major
---

**v2.0**: Pluggable policy signals with a shared statistical foundation.

The executor no longer hardcodes detection or shedding logic. It owns the *engine* — the queue (ProDel), lanes, the statistical *heartbeat* (α, ESS, df, shrinkage — all derived from the pool's single `zScoreThreshold`), and the concurrency/admission actuators — and delegates *policy* to two kinds of pluggable signal:

- **`RegulatorSignal`** decides *concurrency*: `triggered()` is checked once per evaluation cycle; if any fires, the regulator decreases the limit. Default: `LatencyDrift` (the v1.x latency-trend Student-t test, now a first-class signal).
- **`AdmissionSignal`** decides *admission*: `shouldShed(ctx, laneKey)` is queried per request at enqueue; if any returns `true`, the request is rejected instantly. Default: `EarlyShed` (the v1.x probabilistic early shedding). `LaneErrorShed` (the v1.x per-lane error shedding) is an exported opt-in.

## What's new

```typescript
import { Executor, LatencyDrift, EarlyShed, LaneErrorShed } from "concurrex";

// Default behavior: LatencyDrift (concurrency) + EarlyShed (admission)
const exec = new Executor();

// Per-pool override — each list replaces the executor defaults entirely
exec.registerPool("api", {
    regulatorSignals: [new LatencyDrift()],
    admissionSignals: [new EarlyShed(), new LaneErrorShed()] // opt into per-lane shedding
});

// Custom signals — implement the interface inline
exec.registerPool("ingest", {
    regulatorSignals: [new LatencyDrift(), {
        name: "memory-pressure",
        triggered: () => process.memoryUsage().heapUsed > 1_000_000_000,
        clone() { return this; }
    }],
    admissionSignals: [new EarlyShed(), {
        name: "circuit-breaker",
        shouldShed: () => myBreaker.isOpen(),
        clone() { return this; }
    }]
});
```

### Signal interfaces

```typescript
interface BaseSignal<S = unknown> {
    readonly name: string;
    onAdmit?(ctx: SignalContext, info: AdmitInfo): void;
    onComplete?(ctx: SignalContext, info: CompletionInfo): void;
    onEvaluate?(ctx: SignalContext, info: EvaluateInfo): void;
    onLaneRemoved?(laneKey: string): void;   // release per-lane state
    state?(): S;
}
interface RegulatorSignal<S = unknown> extends BaseSignal<S> {
    triggered(ctx: SignalContext): boolean;
    clone(): RegulatorSignal<S>;
}
interface AdmissionSignal<S = unknown> extends BaseSignal<S> {
    shouldShed(ctx: SignalContext, laneKey: string): boolean;
    clone(): AdmissionSignal<S>;
}
```

Both kinds share lifecycle hooks (all optional) and a generic `state()`. Built-ins declare their state type — `LatencyDrift implements RegulatorSignal<LatencyDriftState>` — and the matching state interfaces (`LatencyDriftState`, `LaneErrorShedState`) are exported for typed diagnostics:

```typescript
const latency = executor.getSignalState<LatencyDriftState>("api", "latency-drift");
latency?.zScore;  // number, no cast needed
```

Signals own their per-pool state (cloned per pool) and use `Statistics.*` utilities to compose their decision. The pool's heartbeat is the single source of truth — every signal on a pool reads the same `currentAlpha`, `ewmaSumW2`, `df`, `zScoreThreshold` via `ctx.regulator`. The executor catches and logs exceptions from any hook or decision method, so a buggy signal cannot break the engine.

### Built-in signals

- **`LatencyDrift`** (regulator, default) — the v1.x latency-trend Student-t test. Composes the heartbeat with its own operational-LL integral, log/EWMA/δ²/SE pipeline.
- **`EarlyShed`** (admission, default) — the v1.x probabilistic early shedding (`P = dropRate/(dropRate+completionRate) × shrinkage` when ProDel is dropping and at capacity). Queue-health based, domain-agnostic, stateless.
- **`LaneErrorShed`** (admission, opt-in) — the v1.x per-lane error shedding. Tracks each lane's error-rate EWMA in its own map and sheds new requests to a failing lane. **Off by default** — an "error" is domain-specific (a 404, a validation failure, or a business rejection is not an infrastructure failure).

There is no built-in *pool-wide* error signal. To make errors drive concurrency, write a `RegulatorSignal` that observes `info.errored` in `onComplete` — see `examples/express-server.ts`.

### Statistics namespace

All shared mathematical primitives are exposed via the `Statistics` namespace class with pure static methods:

```typescript
Statistics.tScore(z, df);                        // Cornish-Fisher Student-t quantile
Statistics.timeWeightedAlpha(elapsed, τ, cw);    // α = 1 − exp(−Δt/(τ·CW))
Statistics.bayesianShrinkage(n, z2);              // n / (n + z²)
Statistics.deriveTimeConstant(z);                 // round(2 / (1 − exp(−1/z²)))
Statistics.studentTTrendSE({ sigmaSqEstimate, ewmaSumW2 });
```

## Breaking changes

### `RegulatorState` shape

Latency-test internals moved from `RegulatorState` into `LatencyDrift`'s per-signal state. Removed fields:

- `logW`, `logWBar`
- `dLogWBarEwma`, `dLogWBarVarianceEstimate` (formerly `dLogWBarSM` in v1.1)
- `ewmaSumW2`, `se`, `zScore`, `tCritical`, `threshold`
- `alpha`
- `errorRateEwma` — pool-wide error tracking removed (see "Hardcoded probabilistic-error-decrease is gone")

Renamed:

- `degrading` → `overloadDetected` (new semantics: "any configured regulator signal triggered", not specifically the latency test)

Added:

- `admissionRateEwma` — admission-rate observability counterpart to `completionRateEwma`/`dropRateEwma`.

Inspect the removed latency-test fields via:

```typescript
const latency = executor.getSignalState("api", "latency-drift");
console.log(latency.dLogWBarEwma, latency.zScore, latency.tCritical);
```

### `signals` option → `regulatorSignals` + `admissionSignals`

The single `signals` option (executor and per-pool) is split into two: `regulatorSignals` (concurrency) and `admissionSignals` (admission). Each replaces the corresponding executor default entirely when provided. The `Signal` type is renamed `RegulatorSignal`; `AdmissionSignal` and `BaseSignal` are new.

```typescript
// v1.x / earlier v2 preview
new Executor({ signals: [new LatencyDrift()] });
// v2.0
new Executor({ regulatorSignals: [new LatencyDrift()], admissionSignals: [new EarlyShed()] });
```

### Hardcoded probabilistic-error-decrease is gone — and so is the pool-wide error EWMA

The v1.2 regulator branch that fired concurrency decreases with `P = errorRateEwma` is removed. The pool-level `errorRateEwma` field that fed it is also removed — both from `RegulatorState` (observability) and `RegulatorContext` (signal input).

Per-lane error shedding (rejecting new requests to a recently-failing lane at enqueue) still exists but is now the **opt-in `LaneErrorShed` admission signal**, off by default. Add it to a pool's `admissionSignals` to restore the v1.x behavior:

```typescript
exec.registerPool("api", { admissionSignals: [new EarlyShed(), new LaneErrorShed()] });
```

It was unconditional in v1.x; in v2.0 the library no longer assumes a task failure means a lane should be fenced off.

To make errors drive *concurrency*, define your own `RegulatorSignal`:

```typescript
class HttpErrorRate implements RegulatorSignal {
    readonly name = "http-error-rate";
    private rateEwma: number | null = null;
    constructor(private threshold = 0.1) {}
    onComplete(ctx: SignalContext, info: CompletionInfo) {
        const alpha = Statistics.timeWeightedAlpha(/* … */);
        const sample = info.errored ? 1 : 0;
        this.rateEwma = this.rateEwma === null
            ? sample
            : (1 - alpha) * this.rateEwma + alpha * sample;
    }
    triggered() { return this.rateEwma !== null && this.rateEwma > this.threshold; }
    clone() { return new HttpErrorRate(this.threshold); }
}
```

See `examples/express-server.ts` for a complete example. Default behavior is now `[new LatencyDrift()]` (regulator) + `[new EarlyShed()]` (admission); errors don't drive concurrency unless you wire up a signal.

### `getRegulatorState` field removals

Code reading the removed fields will fail to type-check. Migration is one line per field:

```typescript
// v1.x
const state = executor.getRegulatorState("api");
const zScore = state.zScore;

// v2.0 — pass the state type for a typed result
const latency = executor.getSignalState<LatencyDriftState>("api", "latency-drift");
const zScore = latency?.zScore;
```

## Why this design

The v1.x framework had a unique property: everything derived from a single `zScoreThreshold`. v2.0 preserves this:

- Pool has one `zScoreThreshold` (the heartbeat's source)
- All signals on a pool share the heartbeat — same α, ESS, df
- Adding multiple statistical signals is bounded by Bonferroni: joint FPR ≤ N · Φ(−z)
- Custom signals get the framework's rigor for free if they read the heartbeat

The split between *what's observed* (signal-local state) and *how the test works* (shared heartbeat + Statistics primitives) lets users compose detection logic without re-implementing the framework.

## Theorems extended

Theorem 7' (Joint FPR bound): under H₀ for a pool with N regulator signals participating in the statistical framework (i.e., signals that use `Statistics.*` with the pool's `zScoreThreshold`), the joint FPR is bounded by Bonferroni:

$$P(\text{any signal fires} \mid H_0) \leq \sum_{i=1}^{N} \Phi(-z_i) = N \cdot \Phi(-z)$$

where all signals share the same z = `zScoreThreshold` via the heartbeat. v1.x is the N=1 special case. See `docs/THEORY.md` §4.3.1 for the full proof.

## Migration

**If you used v1.x with default settings:** no code changes are required, but two default behaviors changed:

- **Per-lane error shedding is now opt-in.** v1.x unconditionally rejected new requests to lanes with a high error-rate EWMA. To restore it, add the signal explicitly: `registerPool("api", { admissionSignals: [new EarlyShed(), new LaneErrorShed()] })`.
- **Error-driven concurrency decrease is removed.** The v1.2 regulator branch that decreased concurrency with `P = errorRateEwma` is gone. To make errors drive concurrency, write a `RegulatorSignal` that observes `info.errored` in `onComplete` — see `examples/express-server.ts`.

The latency test (`LatencyDrift`) and early shedding (`EarlyShed`) are preserved: same statistics, same parameters, same defaults.

If you passed `signals: [...]`: rename to `regulatorSignals: [...]` (and add `admissionSignals: [...]` if you customize shedding). The `Signal` type is now `RegulatorSignal`.

If you read `RegulatorState.zScore` (or similar latency fields): migrate to `executor.getSignalState<LatencyDriftState>(pool, "latency-drift")`.

If you read `RegulatorState.errorRateEwma`: that field is gone. Track the EWMA inside your custom error signal (or `LaneErrorShed`'s `state()` for the per-lane rates).

## Tests

133/133 tests pass. New tests added for the regulator/admission signal interfaces, signal cloning, OR-composition, per-signal state inspection, hook + decision-method exception safety, custom admission signals, opt-in `LaneErrorShed` (on and off), `stop()` lifecycle cleanup (`onLaneRemoved` teardown, no in-flight leak across stop/start), and the statistical warm-up gate (`ewmaSumW2` seeded at 1). Tests for the removed probabilistic-error-decrease branch were dropped along with the feature.
