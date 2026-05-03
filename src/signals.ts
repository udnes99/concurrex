import type { RegulatorState } from "./Executor.js";

/**
 * Snapshot of pool state passed to a signal's `triggered()` method.
 * Frozen view — signals must not mutate this object.
 */
export interface SignalContext {
    readonly pool: string;
    readonly concurrencyLimit: number;
    readonly inFlight: number;
    readonly queueLength: number;
    readonly regulator: RegulatorState;
}

/**
 * A pluggable backpressure signal. The throughput regulator iterates over
 * a pool's signals once per evaluation cycle (every `timeConstant` windows).
 * If any signal returns `true` from `triggered()`, the regulator applies
 * a decrease.
 *
 * Custom signals let users encode application-specific backpressure
 * conditions: deadline pressure, memory usage, downstream health checks,
 * etc. The signal interface is intentionally minimal:
 *
 *   - `name`: stable identifier for diagnostics and logs
 *   - `triggered(ctx)`: yes/no — should the regulator decrease now?
 *
 * Signals are *detectors*, not actuators. They report whether their
 * condition is met. The regulator decides how to respond (typically by
 * calling `applyDecrease()`).
 */
export interface Signal {
    /** Stable identifier for this signal instance. Used in diagnostics. */
    readonly name: string;
    /**
     * Decide whether this signal is currently triggered.
     *
     * @param ctx Frozen snapshot of pool state at the evaluation moment.
     * @returns `true` if the signal wants the regulator to decrease, `false` otherwise.
     */
    triggered(ctx: SignalContext): boolean;
}

// ── Built-in signals ─────────────────────────────────────────────────

/**
 * Triggers when the latency-trend Student-t test fires (the v1.2 mechanism).
 * Wraps `regulator.degrading` directly. This is the default signal —
 * pools that don't specify `signals` get `[new LatencyDrift()]`.
 */
export class LatencyDrift implements Signal {
    public readonly name = "latency-drift";
    triggered(ctx: SignalContext): boolean {
        return ctx.regulator.degrading;
    }
}

/**
 * Triggers when `errorRateEwma` exceeds a hard threshold ∈ [0, 1].
 *
 * Useful for "if 50% of work is failing, back off concurrency". Unlike
 * the probabilistic variant, this fires deterministically once the
 * threshold is crossed.
 */
export class ErrorRateThreshold implements Signal {
    public readonly name = "error-rate-threshold";
    private readonly threshold: number;

    constructor(options: { threshold: number }) {
        if (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 1) {
            throw new Error("ErrorRateThreshold: threshold must be in [0, 1]");
        }
        this.threshold = options.threshold;
    }

    triggered(ctx: SignalContext): boolean {
        const rate = ctx.regulator.errorRateEwma;
        return rate !== null && rate > this.threshold;
    }
}

/**
 * Triggers probabilistically with `P = errorRateEwma`. Preserves the v1.2
 * default behavior — at 2% aggregate errors, decreases on ~2% of evaluations;
 * at 80%, decreases on most evaluations.
 *
 * Self-scaling response to systemic errors. Per-lane shedding keeps the
 * aggregate rate low for localized failures, so this only fires frequently
 * for issues spread across many lanes.
 *
 * Opt-in for v1.3: users who want v1.2 behavior should add this to their
 * pool's `signals` list.
 */
export class ProbabilisticErrorRate implements Signal {
    public readonly name = "probabilistic-error-rate";
    triggered(ctx: SignalContext): boolean {
        const rate = ctx.regulator.errorRateEwma;
        if (rate === null || rate <= 0) return false;
        return Math.random() < rate;
    }
}
