/**
 * Pluggable backpressure signals.
 *
 * The throughput regulator does not implement detection logic itself —
 * it only orchestrates raw task events (admissions, completions, window
 * boundaries) and asks each pool's signals whether they want a decrease.
 *
 * Every detection statistic lives inside a `Signal` implementation. The
 * built-in `LatencyDrift` carries the full operational-Little's-Law +
 * EWMA + δ² + Student-t pipeline; users can write any custom signal that
 * fits their workload (deadline pressure, memory limits, downstream
 * health, etc.).
 *
 * # Signal lifecycle
 *
 *   1. Constructed by the user with options.
 *   2. Cloned by the executor at `registerPool` — the user's instance is
 *      a template; the cloned instance owns the per-pool state.
 *   3. Receives lifecycle hooks: `onAdmit`, `onComplete`, `onEvaluate`.
 *   4. Asked `triggered(ctx)` once per regulator evaluation cycle.
 *
 * # Why clone?
 *
 * Stateful signals must not share state across pools — two pools sharing
 * a `LatencyDrift` instance would interleave their EWMAs into garbage.
 * The `clone()` contract resets all accumulated state while preserving
 * options, so the same template can be safely registered with multiple
 * pools.
 */

import { ArgumentError } from "./errors.js";

// ── Types ────────────────────────────────────────────────────────────

/** Snapshot of pool state passed to every signal hook. Frozen — must not be mutated. */
export interface SignalContext {
    readonly pool: string;
    readonly concurrencyLimit: number;
    readonly inFlight: number;
    readonly queueLength: number;
    /** General-purpose regulator metrics (rate EWMAs, regulation phase, etc.).
     *  Signal-specific state lives inside the signal itself, not here. */
    readonly regulator: RegulatorContext;
}

/** General-purpose regulator metrics shared across all signals. */
export interface RegulatorContext {
    readonly completionRateEwma: number | null;
    readonly admissionRateEwma: number | null;
    readonly dropRateEwma: number | null;
    readonly errorRateEwma: number | null;
    readonly inFlightEwma: number | null;
    readonly regulationPhase: string;
    readonly regulationDepth: number;
    readonly elapsedWindows: number;
    readonly zScoreThreshold: number;
    readonly timeConstant: number;
    readonly controlWindow: number;
}

export interface AdmitInfo {
    readonly lane: string;
    readonly admitTime: number;
}

export interface CompletionInfo {
    readonly lane: string;
    readonly admitTime: number;
    readonly completionTime: number;
    readonly serviceTime: number;
    readonly errored: boolean;
}

export interface EvaluateInfo {
    readonly windowStart: number;
    readonly windowEnd: number;
    /** Elapsed wall-clock time since `windowStart`. May exceed `controlWindow`
     *  on idle pools where evaluation is delayed until the next event. */
    readonly elapsed: number;
    readonly completions: number;
    readonly admissions: number;
}

/**
 * A pluggable backpressure signal.
 *
 * The regulator iterates each pool's signals once per evaluation cycle.
 * If any returns `triggered() === true`, the regulator applies a
 * concurrency decrease. Composition is implicit OR — wrap inside a
 * custom `Signal` to express AND or weighted combinations.
 */
export interface Signal {
    /** Stable identifier — used in diagnostics and `getSignalState(pool, name)`. */
    readonly name: string;

    /** Create a fresh, stateless copy.
     *
     *  The clone must:
     *    - retain configuration (constructor options) of the original
     *    - reset all accumulated state (EWMAs, counters, internal buffers)
     *
     *  Called by the executor when binding the signal to a pool. The user's
     *  original instance is a template; the cloned instance receives all
     *  lifecycle hooks. */
    clone(): Signal;

    /** Called once per task admission, just after `inFlight++`. */
    onAdmit?(ctx: SignalContext, info: AdmitInfo): void;

    /** Called once per task completion, just after `inFlight--` (success or error). */
    onComplete?(ctx: SignalContext, info: CompletionInfo): void;

    /** Called at every control-window boundary. The signal's window-aggregated
     *  computations (EWMA updates, derivative computation) typically live here. */
    onEvaluate?(ctx: SignalContext, info: EvaluateInfo): void;

    /** Decide whether the signal is currently triggered. Called every
     *  `timeConstant` regulation cycles. */
    triggered(ctx: SignalContext): boolean;

    /** Optional: expose internal state for diagnostics. Returned by
     *  `executor.getSignalState(pool, name)`. */
    state?(): Record<string, unknown>;
}

// ── Base class for ergonomic custom signals ──────────────────────────

/**
 * Convenience base for `Signal` implementations. Captures `options` and
 * implements `clone()` automatically by re-instantiating with the same options.
 *
 * @example
 * class MySignal extends BaseSignal<{ threshold: number }> {
 *     name = "my-signal";
 *     private count = 0;
 *
 *     onComplete(ctx, info) {
 *         if (info.serviceTime > this.options.threshold) this.count++;
 *     }
 *
 *     triggered() { return this.count > 5; }
 * }
 *
 * // clone() is inherited; uses `new MySignal(this.options)`.
 */
export abstract class BaseSignal<O = unknown> implements Signal {
    public abstract readonly name: string;

    constructor(protected readonly options: O) {}

    public clone(): Signal {
        // The constructor of the concrete subclass is invoked with the
        // same options. Subclasses with non-trivial state should reset
        // it in their own constructor.
        const Ctor = this.constructor as new (o: O) => Signal;
        return new Ctor(this.options);
    }

    public abstract triggered(ctx: SignalContext): boolean;
}

// ── LatencyDrift: the v1.x trend test, now self-contained ────────────

/**
 * Options for {@link LatencyDrift}. Defaults are derived from the pool's
 * `zScoreThreshold` (`ctx.regulator.zScoreThreshold`) when not specified.
 */
export interface LatencyDriftOptions {
    /** Override the pool's zScoreThreshold for this signal's noise floor.
     *  When omitted, the signal reads it from `ctx.regulator.zScoreThreshold`
     *  on first use (so most users set it once at the pool level). */
    zScoreThreshold?: number;
}

/**
 * Latency-trend hypothesis test (the v1.x mechanism).
 *
 * **Pipeline (per `docs/THEORY.md` §4.2)**:
 *   1. Operational Little's Law: W̃ = ∫N(t)dt / r per window
 *   2. Log transform: m_k = log W̃_k
 *   3. Level EWMA on logW with Bayesian shrinkage
 *   4. dt-normalized derivative dLogW
 *   5. Trend EWMA with asymmetric shrinkage on input
 *   6. von Neumann's δ² noise estimator (drift-invariant)
 *   7. Effective sample size via exact W² recursion
 *
 * **Test**: `t = v̂ / SE` against the Cornish-Fisher Student-t critical
 * value at df = 1/W² − 1. SE² = δ² · W² · (1+W²) / (2·(1+α/2)).
 *
 * **State** (all reset on `clone()`):
 *   - `inFlightMs`, `lastInFlightChangeTime`, `inFlight` — operational LL integral
 *   - `windowStart` — current window's start time
 *   - `logWBar`, `dLogWBarEwma`, `dLogWBarVarianceEstimate`, `lastDLogWBarRate`
 *   - `ewmaSumW2`, `alpha`
 */
export class LatencyDrift implements Signal {
    public readonly name = "latency-drift";
    private readonly options: LatencyDriftOptions;

    // Operational Little's Law integral state
    private inFlight = 0;
    private inFlightMs = 0;
    private lastInFlightChangeTime: number | null = null;

    // Window tracking
    private windowStart: number | null = null;

    // Latency-trend pipeline state
    private lastLogW: number | null = null;
    private logWBar: number | null = null;
    private dLogWBarEwma: number | null = null;
    private dLogWBarVarianceEstimate = 0;
    private lastDLogWBarRate: number | null = null;
    private ewmaSumW2 = 0;
    private alpha: number | null = null;

    // Cached test outputs (computed in onEvaluate; read by triggered())
    private currentSe = 0;
    private currentZScore = 0;
    private currentTCritical = 0;
    private currentThreshold = 0;
    private currentlyDegrading = false;

    // Derived parameters (resolved on first hook from ctx.regulator)
    private resolvedZ: number | null = null;
    private resolvedZ2 = 0;
    private resolvedTimeConstant = 0;

    constructor(options: LatencyDriftOptions = {}) {
        if (options.zScoreThreshold !== undefined) {
            if (!Number.isFinite(options.zScoreThreshold) || options.zScoreThreshold <= 0) {
                throw new ArgumentError("LatencyDrift.zScoreThreshold must be a finite number > 0.");
            }
            this.resolvedZ = options.zScoreThreshold;
            this.resolvedZ2 = options.zScoreThreshold * options.zScoreThreshold;
            this.resolvedTimeConstant = computeTimeConstant(options.zScoreThreshold);
        }
        this.options = { ...options };
    }

    public clone(): LatencyDrift {
        return new LatencyDrift(this.options);
    }

    public state(): Record<string, unknown> {
        return {
            logW: this.lastLogW,
            logWBar: this.logWBar,
            dLogWBarEwma: this.dLogWBarEwma,
            dLogWBarVarianceEstimate: this.dLogWBarVarianceEstimate,
            ewmaSumW2: this.ewmaSumW2,
            alpha: this.alpha,
            se: this.currentSe,
            zScore: this.currentZScore,
            tCritical: this.currentTCritical,
            threshold: this.currentThreshold,
            degrading: this.currentlyDegrading
        };
    }

    public onAdmit(_ctx: SignalContext, info: AdmitInfo): void {
        this.advanceIntegral(info.admitTime);
        this.inFlight++;
    }

    public onComplete(_ctx: SignalContext, info: CompletionInfo): void {
        this.advanceIntegral(info.completionTime);
        this.inFlight--;
    }

    public onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        // Resolve parameters from the context on first call.
        if (this.resolvedZ === null) {
            this.resolvedZ = ctx.regulator.zScoreThreshold;
            this.resolvedZ2 = this.resolvedZ * this.resolvedZ;
            this.resolvedTimeConstant = ctx.regulator.timeConstant;
        }

        // Initialize windowStart on first call.
        if (this.windowStart === null) {
            this.windowStart = info.windowStart;
        }

        // Time-weighted EWMA alpha.
        const cw = ctx.regulator.controlWindow;
        const alpha = 1 - Math.exp(-info.elapsed / (this.resolvedTimeConstant * cw));
        this.alpha = alpha;

        // Close out the in-flight integral at the window boundary.
        this.advanceIntegral(info.windowEnd);

        // Compute instantW per Little's Law and update the trend pipeline.
        if (info.completions > 0 && this.inFlightMs > 0) {
            const instantW = this.inFlightMs / info.completions;
            const logInstantW = Math.log(instantW);
            this.lastLogW = logInstantW;

            // Bayesian shrinkage on the level update.
            const shrinkage = info.completions / (info.completions + this.resolvedZ2);

            if (this.logWBar === null) {
                this.logWBar = logInstantW;
            } else {
                const previousLogWBar = this.logWBar;
                const levelAlpha = alpha * shrinkage;
                this.logWBar = (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;

                // dt-normalized derivative.
                const dt = info.elapsed / cw;
                const dLogWBarRate = (this.logWBar - previousLogWBar) / dt;

                if (this.dLogWBarEwma === null) {
                    // First sample: seed the trend EWMA with shrunk derivative.
                    this.dLogWBarEwma = dLogWBarRate * shrinkage;
                    this.ewmaSumW2 = 1;
                } else {
                    // Asymmetric shrinkage on the trend numerator.
                    this.dLogWBarEwma =
                        (1 - alpha) * this.dLogWBarEwma + alpha * (dLogWBarRate * shrinkage);

                    // δ² = MSSD/2: drift-invariant via pairwise differences.
                    if (this.lastDLogWBarRate !== null) {
                        const diff = dLogWBarRate - this.lastDLogWBarRate;
                        this.dLogWBarVarianceEstimate =
                            (1 - alpha) * this.dLogWBarVarianceEstimate +
                            (alpha * diff * diff) / 2;
                    }

                    // Effective sample size: Σw² recursion.
                    this.ewmaSumW2 = (1 - alpha) * (1 - alpha) * this.ewmaSumW2 + alpha * alpha;
                }
                this.lastDLogWBarRate = dLogWBarRate;
            }
        }

        // Reset for next window.
        this.inFlightMs = 0;
        this.windowStart = info.windowEnd;

        // Refresh cached test outputs.
        this.recomputeTestOutputs();
    }

    public triggered(_ctx: SignalContext): boolean {
        return this.currentlyDegrading;
    }

    /** Update inFlightMs integral up to `now` using the current `inFlight`. */
    private advanceIntegral(now: number): void {
        if (this.lastInFlightChangeTime === null) {
            this.lastInFlightChangeTime = now;
            return;
        }
        this.inFlightMs += this.inFlight * (now - this.lastInFlightChangeTime);
        this.lastInFlightChangeTime = now;
    }

    /** Recompute SE, zScore, tCritical, threshold, degrading. */
    private recomputeTestOutputs(): void {
        if (
            this.dLogWBarEwma === null ||
            this.dLogWBarVarianceEstimate === 0 ||
            this.ewmaSumW2 === 0 ||
            this.alpha === null ||
            this.resolvedZ === null
        ) {
            this.currentSe = 0;
            this.currentZScore = 0;
            this.currentTCritical = 0;
            this.currentThreshold = 0;
            this.currentlyDegrading = false;
            return;
        }
        const sigmaSqEstimate = this.dLogWBarVarianceEstimate / (1 + this.alpha / 2);
        const se = Math.sqrt(
            (sigmaSqEstimate * this.ewmaSumW2 * (1 + this.ewmaSumW2)) / 2
        );
        this.currentSe = se;
        this.currentZScore = se > 0 ? this.dLogWBarEwma / se : 0;
        const df = 1 / this.ewmaSumW2 - 1;
        this.currentTCritical = tScore(this.resolvedZ, df);
        this.currentThreshold = this.currentTCritical * se;
        this.currentlyDegrading = this.dLogWBarEwma > this.currentThreshold;
    }
}

// ── ErrorRateThreshold ───────────────────────────────────────────────

export interface ErrorRateThresholdOptions {
    /** Threshold ∈ [0, 1]. Triggers when `regulator.errorRateEwma > threshold`. */
    threshold: number;
}

/**
 * Triggers deterministically when the pool's error rate EWMA exceeds a
 * fixed threshold. Useful for "if 50% of work is failing, back off".
 *
 * Stateless — the executor tracks `errorRateEwma`; this signal just reads it.
 */
export class ErrorRateThreshold extends BaseSignal<ErrorRateThresholdOptions> {
    public readonly name = "error-rate-threshold";

    constructor(options: ErrorRateThresholdOptions) {
        if (
            !Number.isFinite(options.threshold) ||
            options.threshold < 0 ||
            options.threshold > 1
        ) {
            throw new ArgumentError("ErrorRateThreshold.threshold must be in [0, 1].");
        }
        super(options);
    }

    public triggered(ctx: SignalContext): boolean {
        const rate = ctx.regulator.errorRateEwma;
        return rate !== null && rate > this.options.threshold;
    }
}

// ── ProbabilisticErrorRate ───────────────────────────────────────────

/**
 * Triggers probabilistically with `P = errorRateEwma`. Self-scaling response
 * to systemic errors: at 2% aggregate errors, fires on ~2% of evaluations;
 * at 80%, fires on most.
 *
 * Stateless. Preserves the v1.2 default behavior; opt-in for v2.0+.
 */
export class ProbabilisticErrorRate implements Signal {
    public readonly name = "probabilistic-error-rate";

    public clone(): ProbabilisticErrorRate {
        return new ProbabilisticErrorRate();
    }

    public triggered(ctx: SignalContext): boolean {
        const rate = ctx.regulator.errorRateEwma;
        if (rate === null || rate <= 0) return false;
        return Math.random() < rate;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Compute the EWMA time constant from a z-score threshold. */
function computeTimeConstant(zScoreThreshold: number): number {
    const z2 = zScoreThreshold * zScoreThreshold;
    return Math.round(2 / (1 - Math.exp(-1 / z2)));
}

/** One-sided Student-t critical value (safe upper bound) at upper-tail
 *  probability Φ(-z), df ν.
 *
 *  4th-order Cornish-Fisher inverse-t series (Hill, G. W. "Algorithm 396:
 *  Student's t-quantiles." Communications of the ACM 13.10 (1970): 619–620)
 *  plus an asymptotic-series truncation bound 2·|g₄/ν⁴|. As ν → 0 the bound
 *  diverges, naturally gating the test off — no clamp needed. */
function tScore(z: number, df: number): number {
    const z2 = z * z;
    const z4 = z2 * z2;
    const z6 = z4 * z2;
    const z8 = z4 * z4;
    const g1 = (z * (z2 + 1)) / 4;
    const g2 = (z * (5 * z4 + 16 * z2 + 3)) / 96;
    const g3 = (z * (3 * z6 + 19 * z4 + 17 * z2 - 15)) / 384;
    const g4 = (z * (79 * z8 + 776 * z6 + 1482 * z4 - 1920 * z2 - 945)) / 92160;
    const df2 = df * df;
    const df3 = df2 * df;
    const df4 = df3 * df;
    const tApprox = z + g1 / df + g2 / df2 + g3 / df3 + g4 / df4;
    const errorBound = 2 * Math.abs(g4 / df4);
    return tApprox + errorBound;
}
