---
"concurrex": major
---

**v2.0**: Pluggable policy signals with a shared statistical foundation.

The executor no longer hardcodes detection or shedding logic. It owns the *engine* — the queue (ProDel), lanes, the statistical *heartbeat* (α, ESS, df, shrinkage — all derived from the pool's single `zScoreThreshold`), and the concurrency/admission actuators — and delegates *policy* to two kinds of pluggable signal:

- **`RegulatorSignal`** decides *concurrency*: `triggered()` is checked once per evaluation cycle; if any fires, the regulator decreases the limit. Default: `PowerDegraded` (a latency-trend Student-t test that arms a degradation latch, plus an elasticity test that attributes the degradation to concurrency and releases when it's exogenous).
- **`AdmissionSignal`** decides *admission*: `shouldShed(ctx, laneKey)` is queried per request at enqueue; if any returns `true`, the request is rejected instantly. Default: `EarlyShed` (the v1.x probabilistic early shedding). `LaneErrorShed` (the v1.x per-lane error shedding) is an exported opt-in.

## What's new

```typescript
import { Executor, PowerDegraded, EarlyShed, LaneErrorShed } from "concurrex";

// Default behavior: PowerDegraded (concurrency) + EarlyShed (admission)
const exec = new Executor();

// Per-pool override — each list replaces the executor defaults entirely
exec.registerPool("api", {
    regulatorSignals: [new PowerDegraded()],
    admissionSignals: [new EarlyShed(), new LaneErrorShed()] // opt into per-lane shedding
});

// Custom signals — implement the interface inline
exec.registerPool("ingest", {
    regulatorSignals: [new PowerDegraded(), {
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

Both kinds share lifecycle hooks (all optional) and a generic `state()`. Built-ins declare their state type — `PowerDegraded implements RegulatorSignal<PowerDegradedState>` — and the matching state interfaces (`PowerDegradedState`, `LaneErrorShedState`) are exported for typed diagnostics:

```typescript
const latency = executor.getSignalState<PowerDegradedState>("api", "power-degraded");
latency?.zScore;  // number, no cast needed
```

Signals own their per-pool state (cloned per pool) and use `Statistics.*` utilities to compose their decision. The pool's shared inference state (the `Inference` interface — informally, its "heartbeat") is the single source of truth: every signal on a pool reads the same `currentAlpha`, `ewmaSumW2`, `df`, `zScoreThreshold` via `ctx.inference`. Controller state and smoothed rate observations are exposed separately via `ctx.regulator` (`RegulatorContext`). The executor catches and logs exceptions from any hook or decision method, so a buggy signal cannot break the engine.

### Built-in signals

- **`PowerDegraded`** (regulator, default) — protects Kleinrock's power knee via two channels: a calibrated Student-t **latency-trend** test (`dW/dt`, operational-LL integral + log/EWMA/δ²/SE pipeline) *arms* a degradation latch; an **elasticity** test (`dW/dL`, measured while the limit moves) *attributes and releases* — throttling continues only while concurrency is the cause and the actuator helps, re-basing when latency is exogenous. The calibration assumes window-to-window noise independence: size `controlWindow` above routine pause durations (GC) and latency-noise correlation times — the measured robustness boundary and its guidance are in `docs/THEORY.md` §4.2.6, with autocorrelation-corrected variants investigated, rejected (a level step's smooth transient is indistinguishable from correlated noise, so corrections suppress step detection), and retained as research artifacts in `simulations/benchmark-fpr.ts` Mode D. A `name` constructor option allows multiple `PowerDegraded` instances per pool.
- **`EarlyShed`** (admission, default) — the v1.x probabilistic early shedding (`P = dropRate/(dropRate+completionRate) × shrinkage` when ProDel is dropping and at capacity). Queue-health based, domain-agnostic, stateless.
- **`LaneErrorShed`** (admission, opt-in) — the v1.x per-lane error shedding. Tracks each lane's error-rate EWMA in its own map and sheds new requests to a failing lane. **Off by default** — an "error" is domain-specific (a 404, a validation failure, or a business rejection is not an infrastructure failure).

There is no built-in *pool-wide* error signal. To make errors drive concurrency, write a `RegulatorSignal` that observes `info.errored` in `onComplete` — see `examples/express-server.ts`.

### Statistics namespace

All shared mathematical primitives are exposed via the `Statistics` namespace class with pure static methods:

```typescript
Statistics.tScore(z, df);                        // Student-t critical value (Fisher–Cornish, df ≥ 5; Infinity below)
Statistics.timeWeightedAlpha(elapsed, τ, cw);    // α = 1 − exp(−Δt/(τ·CW))
Statistics.bayesianShrinkage(n, z2);              // n / (n + z²)
Statistics.deriveTimeConstant(z);                 // round(2 / (1 − exp(−1/z²)))
Statistics.studentTTrendSE({ sigmaSqEstimate, ewmaSumW2 });
Statistics.mssdEffectiveDf(alpha, ewmaSumW2);     // δ² effective df = 1/(Σw²·c) — the df used for the critical value
```

## Breaking changes

### The default regulator signal is `PowerDegraded` — latched and knee-attributed

The v1.x latency-trend signal (`LatencyDrift`) is renamed to **`PowerDegraded`** (signal name `"latency-drift"` → `"power-degraded"`, state/options types renamed accordingly) and is the default regulator signal. The rename reflects a semantic change: `triggered()` now reports "the pool is **degraded** at the power knee", not merely "latency is currently worsening". (An earlier, separate `PowerDegraded` prototype — a passive `dlogThroughput − dlogLatency` *time-trend* — was removed: at a binding limit it collapses to the latency-trend test rescaled, it carries no attribution machinery, and its borrowed δ² calibration overshoots the FPR bound. The name is reused for the real, attributed mechanism.)

Mechanically, a **degradation latch** separates entry from exit. The calibrated Student-t trend test *arms* the latch (unchanged entry FPR ≤ Φ(−z)); the latch *releases* when the latency level recovers to within z standard errors of a pre-excursion reference (a second EWMA of logW̄ with the same α·shrinkage — no new constants; the margin derives from δ², α, and Σw², THEORY §4.3.1 "The degradation latch"). An ε test bounds the latch using plant state only (`ctx.concurrencyLimit`): with signed log-changes Δℓ, Δw since arming, the latch releases when −Δℓ ≥ m and Δw − Δℓ ≥ m — the change in L is resolvable and the latency response fell resolvably short of proportional — so the degradation isn't attributable to the pool's own concurrency; the reference re-bases (a stall backstop covers a floor-clamped limit or a pool with no decrease actuator). An exogenous slowdown therefore costs one or two regulation ticks rather than a grind to `minimumConcurrency`. The signal never reads the regulator's phase machine, so it stays actuator-agnostic and composes with custom regulator signals. The reference tracks downward only; upward re-basing happens exclusively through that evidence-gated futility path, so an elevated plateau is never silently absorbed as the new normal.

The decrease actuator also gained an **operating-concurrency clamp**: on a decrease it clamps the limit to the peak in-flight observed that window (`L ← max(L_min, min(maxInFlight, L − Δ))`). When the limit sits on inert headroom — a baseline configured far above the actual concurrency, or a limit not yet reduced into the binding region — it *snaps* to the binding point in one move instead of walking down dead space, so the elasticity experiment starts where the actuator can act (the signal re-anchors its origin on the resulting slack→binding transition, keeping the binding-premise check exact). The snap cuts no live concurrency (in-flight ≤ maxInFlight) and fires on the decrease path only, so burst-absorption headroom is preserved while healthy and reclaimed only on evidence. See `docs/THEORY.md` §4.4.2 and the `clamp` mode in `simulations/benchmark-comparison.ts` (L snaps 300 → ≈40 in ~1s under an exogenous slowdown, then releases as the check finds the latency exogenous).

Why: a trend detector goes quiet at any stable operating point — including a degraded plateau — so the previous behavior stopped the regulator's walk-back as soon as latency stopped *worsening* rather than when it *recovered*, stranding the limit above the contention knee; under sustained saturation those residues compounded into an unbounded upward ratchet of individually-undetectable steps. Measured in `simulations/benchmark-comparison.ts` (contention-model backend, seeded `--randomSeed 0xc0ffee` — deterministic and reproducible): the basic latency-trend signal (`concurrex-trend`, unlatched) vs `PowerDegraded` (`concurrex`, latched) on identical 3× overload. Trend ratchets — during overload goodput 321/s at p50 178ms, and after overload it *never heals*: recovery holds at only 240/s while still shedding 59/s at p99 933ms. Latch recovers — during overload the limit holds at the contention knee (goodput 374/s at p50 84ms), and recovery completes within one time constant (299/s, p99 108ms, ~0 shed). Headroom bursts scale up unimpeded (`burst` mode: baseline 10 → L ≈ 40 in ~4s, 697/700 rps served); a mid-run knee crossing walks back exactly to the knee instead of unwinding the whole climb (`knee` mode: min limit 26 vs run start 10). Cost: under H₀ the calibrated *entry* rate stays under the bound (≈ 1.4% ≤ 2.275% at z = 2, i.i.d.), but latched-state *occupancy* is a larger, τ-dependent quantity (≈ 4.4%, i.i.d.) since a false latch holds ~1–2 extra evaluations before releasing; correlated window noise (AR(1), multi-window GC pauses) inflates both — size `controlWindow` above the noise correlation time (`docs/THEORY.md` §4.2.6).

### `RegulatorState` shape

Latency-test internals moved from `RegulatorState` into `PowerDegraded`'s per-signal state. Removed fields:

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
const latency = executor.getSignalState("api", "power-degraded");
console.log(latency.dLogWBarEwma, latency.zScore, latency.tCritical);
```

### `signals` option → `regulatorSignals` + `admissionSignals`

The single `signals` option (executor and per-pool) is split into two: `regulatorSignals` (concurrency) and `admissionSignals` (admission). Each replaces the corresponding executor default entirely when provided. The `Signal` type is renamed `RegulatorSignal`; `AdmissionSignal` and `BaseSignal` are new.

```typescript
// v1.x / earlier v2 preview
new Executor({ signals: [new PowerDegraded()] });
// v2.0
new Executor({ regulatorSignals: [new PowerDegraded()], admissionSignals: [new EarlyShed()] });
```

### Hardcoded probabilistic-error-decrease is gone — and so is the pool-wide error EWMA

The v1.2 regulator branch that fired concurrency decreases with `P = errorRateEwma` is removed. The pool-level `errorRateEwma` field that fed it is also removed — both from `RegulatorState` (observability) and the signal context (signal input).

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

See `examples/express-server.ts` for a complete example. Default behavior is now `[new PowerDegraded()]` (regulator) + `[new EarlyShed()]` (admission); errors don't drive concurrency unless you wire up a signal.

### `getRegulatorState` field removals

Code reading the removed fields will fail to type-check. Migration is one line per field:

```typescript
// v1.x
const state = executor.getRegulatorState("api");
const zScore = state.zScore;

// v2.0 — pass the state type for a typed result
const latency = executor.getSignalState<PowerDegradedState>("api", "power-degraded");
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

where all signals share the same z = `zScoreThreshold` via the heartbeat. v1.x is the N=1 special case. See `docs/THEORY.md` §4.3.2 for the full proof.

## Migration

**If you used v1.x with default settings:** no code changes are required, but two default behaviors changed:

- **Per-lane error shedding is now opt-in.** v1.x unconditionally rejected new requests to lanes with a high error-rate EWMA. To restore it, add the signal explicitly: `registerPool("api", { admissionSignals: [new EarlyShed(), new LaneErrorShed()] })`.
- **Error-driven concurrency decrease is removed.** The v1.2 regulator branch that decreased concurrency with `P = errorRateEwma` is gone. To make errors drive concurrency, write a `RegulatorSignal` that observes `info.errored` in `onComplete` — see `examples/express-server.ts`.

The latency test (`PowerDegraded`) and early shedding (`EarlyShed`) are preserved with the same statistics and parameters. `PowerDegraded` is now opt-in because the default regulator is `PowerDegraded`.

If you passed `signals: [...]`: rename to `regulatorSignals: [...]` (and add `admissionSignals: [...]` if you customize shedding). The `Signal` type is now `RegulatorSignal`.

If you read `RegulatorState.zScore` (or similar latency fields): migrate to `executor.getSignalState<PowerDegradedState>(pool, "power-degraded")`.

If you read `RegulatorState.errorRateEwma`: that field is gone. Track the EWMA inside your custom error signal (or `LaneErrorShed`'s `state()` for the per-lane rates).

## Tests

136/136 tests pass. New tests added for the regulator/admission signal interfaces, signal cloning, OR-composition, per-signal state inspection, hook + decision-method exception safety, custom admission signals, opt-in `LaneErrorShed` (on and off), `stop()` lifecycle cleanup (`onLaneRemoved` teardown, no in-flight leak across stop/start), and the statistical warm-up gate (`ewmaSumW2` seeded at 1). Tests for the removed probabilistic-error-decrease branch were dropped along with the feature.
