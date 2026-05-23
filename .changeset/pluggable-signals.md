---
"concurrex": major
---

**v2.0**: Pluggable backpressure signals with a shared statistical foundation.

The throughput regulator no longer implements detection logic itself. It computes a single statistical *heartbeat* (α, ESS, df, shrinkage — all derived from the pool's `zScoreThreshold`) and exposes it to signals. Each signal observes raw task events via lifecycle hooks and decides whether to fire. The latency-trend hypothesis test is now a built-in `LatencyDrift` signal that composes the heartbeat with its own inline EWMAs and δ² noise estimator.

## What's new

```typescript
import { Executor, LatencyDrift, ErrorRateThreshold, ProbabilisticErrorRate, Statistics } from "concurrex";

// Default behavior: identical to v1.x — just LatencyDrift
const exec = new Executor();

// Compose: latency + opt-in error threshold
const exec2 = new Executor({
    signals: [
        new LatencyDrift(),
        new ErrorRateThreshold({ threshold: 0.5 })
    ]
});

// Per-pool override (replaces executor defaults entirely)
exec.registerPool("api", {
    signals: [new LatencyDrift(), new ProbabilisticErrorRate()]
});

// Custom signal — implement the Signal interface inline
exec.registerPool("ingest", {
    signals: [new LatencyDrift(), {
        name: "memory-pressure",
        onAdmit() {}, onComplete() {}, onEvaluate() {},
        triggered: () => process.memoryUsage().heapUsed > 1_000_000_000,
        clone() { return this; }
    }]
});
```

### Signal interface

```typescript
interface Signal {
    readonly name: string;
    onAdmit(ctx: SignalContext, info: AdmitInfo): void;
    onComplete(ctx: SignalContext, info: CompletionInfo): void;
    onEvaluate(ctx: SignalContext, info: EvaluateInfo): void;
    triggered(ctx: SignalContext): boolean;
    clone(): Signal;
    state?(): Record<string, unknown>;
}
```

Signals own their per-pool observation state and use `Statistics.*` utilities (tScore, timeWeightedAlpha, bayesianShrinkage, studentTTrendSE) to compose their hypothesis test. The pool's heartbeat is the single source of truth for the control loop's statistical parameters — every signal on a pool reads the same `currentAlpha`, `ewmaSumW2`, `df`, `zScoreThreshold` via `ctx.regulator`.

### Built-in signals

- **`LatencyDrift`** — the v1.x latency-trend Student-t test, now a first-class signal. Default for every pool. Composes the heartbeat with its own operational-LL integral, log/EWMA/δ²/SE pipeline.
- **`ErrorRateThreshold({ threshold })`** — fires when `errorRateEwma > threshold`. Deterministic, stateless.
- **`ProbabilisticErrorRate`** — fires with `P = errorRateEwma`. Preserves v1.2 default behavior; opt-in for v2.0+.

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
- `dLogWBarEwma`, `dLogWBarVarianceEstimate`
- `ewmaSumW2`, `se`, `zScore`, `tCritical`, `threshold`
- `alpha`

Inspect them via:

```typescript
const latency = executor.getSignalState("api", "latency-drift");
console.log(latency.dLogWBarEwma, latency.zScore, latency.tCritical);
```

The `degrading` field on `RegulatorState` is preserved but its semantics changed: it now means "any configured signal is currently triggered" (equivalent to `isThroughputDegraded`), not specifically the latency test.

### Hardcoded probabilistic-error-decrease is gone

The v1.2 regulator branch that fired with `P = errorRateEwma` is removed. Pools that relied on it must opt in:

```typescript
new Executor({
    signals: [new LatencyDrift(), new ProbabilisticErrorRate()]
});
```

Default behavior is now `[new LatencyDrift()]` only — the regulator decreases on sustained latency drift, but errors don't drive concurrency unless you opt in.

### `getRegulatorState` field removals

Code reading the removed fields will fail to type-check. Migration is one line per field:

```typescript
// v1.x
const state = executor.getRegulatorState("api");
const zScore = state.zScore;

// v2.0
const latency = executor.getSignalState("api", "latency-drift");
const zScore = latency?.zScore as number;
```

## Why this design

The v1.x framework had a unique property: everything derived from a single `zScoreThreshold`. v2.0 preserves this:

- Pool has one `zScoreThreshold` (the heartbeat's source)
- All signals on a pool share the heartbeat — same α, ESS, df
- Adding multiple statistical signals is bounded by Bonferroni: joint FPR ≤ N · Φ(−z)
- Custom signals get the framework's rigor for free if they read the heartbeat

The split between *what's observed* (signal-local state) and *how the test works* (shared heartbeat + Statistics primitives) lets users compose detection logic without re-implementing the framework.

## Theorems extended

Theorem 7' (Joint FPR bound): under H₀ for a pool with N signals participating in the statistical framework (i.e., signals that use `Statistics.*` with the pool's `zScoreThreshold`), the joint FPR is bounded by Bonferroni:

$$P(\text{any signal fires} \mid H_0) \leq \sum_{i=1}^{N} \Phi(-z_i) = N \cdot \Phi(-z)$$

where all signals share the same z = `zScoreThreshold` via the heartbeat. v1.x is the N=1 special case. See `docs/THEORY.md` §4.3.1 for the full proof.

## Migration

If you used v1.x with default settings: **no migration needed** — the default `LatencyDrift` signal preserves v1.x latency-test behavior identically.

If you read `RegulatorState.zScore` (or similar latency fields): migrate to `executor.getSignalState(pool, "latency-drift")`.

If you relied on v1.2's default probabilistic-error-decrease: add `new ProbabilisticErrorRate()` to your signals.

## Tests

116/116 tests pass. New tests added for the Signal interface, signal cloning, OR-composition, and per-signal state inspection.
