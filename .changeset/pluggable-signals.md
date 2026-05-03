---
"concurrex": minor
---

Pluggable backpressure signals — replace the hardcoded "errors trigger pool-wide concurrency reduction" with a generic `Signal` interface that users compose at the executor or pool level.

## Why

In v1.2, the regulator's `evaluateControlWindow` had two hardcoded decrease branches: the latency-trend Student-t test and a probabilistic-error-decrease branch (`P = errorRateEwma`). Errors-driving-concurrency is an *application-semantics* decision that the executor was making for users — different applications mean different things by "error" (input validation vs downstream outage vs systemic failure). One-size-fits-all isn't right.

This release decouples *signal detection* from *regulator response*. The trend test, error-rate response, and any future or custom signals all become pluggable `Signal` instances that users compose to fit their application.

## The contract

```typescript
interface Signal {
    readonly name: string;
    triggered(ctx: SignalContext): boolean;
}

interface SignalContext {
    readonly pool: string;
    readonly concurrencyLimit: number;
    readonly inFlight: number;
    readonly queueLength: number;
    readonly regulator: RegulatorState;
}
```

The regulator iterates a pool's signals once per evaluation cycle (every `timeConstant` windows). If *any* signal returns `triggered() === true`, the regulator applies a decrease. OR semantics — composition of richer logic (AND, weighted votes) is left to user-defined `CompositeSignal`s.

## Built-in signals

- **`LatencyDrift`** — wraps the v1.2 latency-trend Student-t test. Default for every pool.
- **`ErrorRateThreshold({ threshold })`** — fires when `errorRateEwma > threshold`. Deterministic.
- **`ProbabilisticErrorRate()`** — fires with `P = errorRateEwma`. Preserves v1.2 default behavior; opt-in for v1.3+.

## Configuration

Executor-level default applies to every pool that does not override:

```typescript
const executor = new Executor({
    signals: [new LatencyDrift(), new ErrorRateThreshold({ threshold: 0.5 })]
});
```

Pool-level signals **replace** executor defaults entirely (no merge):

```typescript
executor.registerPool("api", {
    signals: [new LatencyDrift(), new ProbabilisticErrorRate()]
});

// Empty array = "never auto-decrease on backpressure"
executor.registerPool("debug", { signals: [] });

// No signals key = inherits executor defaults
executor.registerPool("background");
```

## Behavior change vs v1.2

The hardcoded probabilistic-error-decrease branch is **removed**. Default behavior is now `[LatencyDrift]` only — the regulator decreases on sustained latency drift, but not automatically on systemic errors. Users who relied on v1.2's auto error response should opt in:

```typescript
new Executor({
    signals: [new LatencyDrift(), new ProbabilisticErrorRate()]
});
```

This is the **only** observable behavior change — pools using the default `[LatencyDrift]` have v1.2 latency semantics unchanged.

## Custom signals

Encode application-specific backpressure conditions:

```typescript
const memoryPressure: Signal = {
    name: "memory-pressure",
    triggered: () => process.memoryUsage().heapUsed > 1_000_000_000
};

const deadlinePressure: Signal = {
    name: "deadline-pressure",
    triggered: (ctx) => ctx.queueLength > 0 && ctx.regulator.errorRateEwma! > 0.1
};

executor.registerPool("ingest", {
    signals: [new LatencyDrift(), memoryPressure, deadlinePressure]
});
```

Signals are *detectors*, not actuators. They report whether their condition is met; the regulator decides how to respond (always: `applyDecrease`).

## API additions

- `Signal` interface and `SignalContext` type, exported from `concurrex`
- `LatencyDrift`, `ErrorRateThreshold`, `ProbabilisticErrorRate` classes
- `signals?: Signal[]` option on `Executor` constructor
- `signals?: Signal[]` option on `PoolOptions`

## API semantics changes

- `isThroughputDegraded(pool)` now returns `true` if **any** configured signal is triggered, not just the latency test. For pools with default signals (`[LatencyDrift]`), behavior is identical to v1.2.
- `RegulatorState.degrading` continues to reflect *only* the latency-trend test result. The `LatencyDrift` signal reads this field.
