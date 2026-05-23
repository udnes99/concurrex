/**
 * Pluggable backpressure signals.
 *
 * The throughput regulator does not implement detection logic itself —
 * it computes the statistical heartbeat (α, ESS, df, shrinkage from the
 * pool's `zScoreThreshold`) and exposes it via `RegulatorContext`.
 * Each signal observes raw task events through lifecycle hooks and
 * decides whether to fire via `triggered()`.
 *
 * Signals own their per-pool state (cloned at `registerPool`) and use
 * `Statistics.*` utilities for shared mathematical building blocks
 * (tScore, time-weighted α, Bayesian shrinkage, autocorrelation-
 * corrected SE).
 *
 * # Built-in signals
 *
 * - `LatencyDrift` — the v1.x latency-trend Student-t test, now a
 *   first-class signal that composes the framework's primitives.
 * - `ErrorRateThreshold` — fires when `errorRateEwma > threshold`.
 * - `ProbabilisticErrorRate` — fires with `P = errorRateEwma`. Preserves
 *   the v1.2 default behavior; opt-in for v2.0+.
 *
 * # Custom signals
 *
 * Implement `Signal` directly. The simplest signal is a predicate; the
 * richest is a statistical hypothesis test using the framework's
 * heartbeat — see `LatencyDrift` for the canonical pattern.
 */

import { ArgumentError } from "./errors.js";
import { Statistics } from "./statistics.js";

// ── Types ────────────────────────────────────────────────────────────

/** Frozen snapshot of pool state passed to every signal hook. */
export interface SignalContext {
    readonly pool: string;
    readonly concurrencyLimit: number;
    readonly inFlight: number;
    readonly queueLength: number;
    /** General-purpose metrics + the statistical framework's heartbeat. */
    readonly regulator: RegulatorContext;
}

/**
 * General-purpose regulator metrics + the heartbeat of the statistical
 * framework. The heartbeat is computed once per evaluation by the
 * executor and is the same for every signal on the pool — there is one
 * α, one ESS, one df, one shrinkage per pool, derived from the pool's
 * single `zScoreThreshold`.
 *
 * Signals use these to compose their own hypothesis test (typically
 * a Student-t trend test on a signal-specific observation stream).
 */
export interface RegulatorContext {
    // ── General-purpose metrics ──
    readonly completionRateEwma: number | null;
    readonly admissionRateEwma: number | null;
    readonly dropRateEwma: number | null;
    readonly errorRateEwma: number | null;
    readonly inFlightEwma: number | null;
    readonly regulationPhase: string;
    readonly regulationDepth: number;
    readonly elapsedWindows: number;

    // ── Statistical heartbeat ──
    /** Single z-score threshold for the whole control loop. */
    readonly zScoreThreshold: number;
    /** z² — the Bayesian prior strength in pseudo-observations. */
    readonly z2: number;
    /** EWMA time constant in control windows. Also the regulator's
     *  decision cadence (decisions are made every `timeConstant` windows). */
    readonly timeConstant: number;
    /** Control window length in milliseconds. */
    readonly controlWindow: number;
    /** Time-weighted α for the current evaluation: α = 1 − exp(−Δt/(τ·CW)). */
    readonly currentAlpha: number;
    /** Bayesian shrinkage for the current window: r / (r + z²). */
    readonly bayesianShrinkage: number;
    /** Effective sample size tracker: Σw² updated via the EWMA-weights
     *  recursion (1−α)²·prev + α². */
    readonly ewmaSumW2: number;
    /** Satterthwaite degrees of freedom: 1/W^(2) − 1. */
    readonly df: number;
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
    /** Elapsed wall-clock time since `windowStart`. */
    readonly elapsed: number;
    readonly completions: number;
    readonly admissions: number;
}

/**
 * A pluggable backpressure signal.
 *
 * The regulator iterates each pool's signals once per evaluation cycle
 * (every `timeConstant` windows). If any signal returns `triggered() ===
 * true`, the regulator applies a concurrency decrease. Multiple signals
 * compose with OR semantics.
 *
 * Stateful signals must not share state across pools — implement
 * `clone()` to return a fresh, stateless copy. The user's original
 * instance is a template; the executor clones it per pool.
 */
export interface Signal {
    /** Stable identifier — used in diagnostics, logs, `getSignalState`. */
    readonly name: string;

    /** Called once per task admission, just after `inFlight++`. */
    onAdmit(ctx: SignalContext, info: AdmitInfo): void;

    /** Called once per task completion, just after `inFlight--`. */
    onComplete(ctx: SignalContext, info: CompletionInfo): void;

    /** Called at every control-window boundary. The signal's window-
     *  aggregated computations (EWMA updates, derivative computation,
     *  noise floor updates) typically live here. */
    onEvaluate(ctx: SignalContext, info: EvaluateInfo): void;

    /** Decide whether the signal is currently triggered. Called every
     *  `timeConstant` regulation cycles. */
    triggered(ctx: SignalContext): boolean;

    /** Create a fresh, stateless copy. The clone must retain
     *  configuration but reset accumulated state. Called by the executor
     *  when binding the signal to a pool. */
    clone(): Signal;

    /** Optional: expose internal state for diagnostics. Returned by
     *  `executor.getSignalState(pool, name)`. */
    state?(): Record<string, unknown>;
}

// ── LatencyDrift — the canonical statistical signal ──────────────────

/**
 * Latency-trend Student-t hypothesis test (the v1.x detection mechanism,
 * now a first-class signal).
 *
 * **Pipeline** (per `docs/THEORY.md` §4.2):
 *   1. Operational Little's Law: W̃ = ∫N(t)dt / r per window
 *   2. Log transform: m_k = log W̃_k
 *   3. Level EWMA on logW with Bayesian shrinkage
 *   4. dt-normalized derivative dLogW
 *   5. Trend EWMA with asymmetric shrinkage on input
 *   6. von Neumann's δ² noise estimator (drift-invariant)
 *
 * Uses the pool's heartbeat (α, ESS, df, shrinkage from `ctx.regulator`)
 * — no signal-local statistical parameters.
 *
 * **Test**: `t = v̂ / SE` against the Cornish-Fisher Student-t critical
 * value at df = 1/W^(2) − 1.
 *
 * **State** (all reset on `clone()`):
 *   - `inFlight`, `inFlightMs`, `lastInFlightChange` — operational LL integral
 *   - `logWBar`, `dLogWBarEwma`, `dLogWBarVarEst`, `lastDLogWBarRate`
 */
export class LatencyDrift implements Signal {
    public readonly name = "latency-drift";

    // ── Operational Little's Law integral ──
    private inFlight = 0;
    private inFlightMs = 0;
    private lastInFlightChange: number | null = null;

    // ── Latency-trend pipeline state ──
    private logWBar: number | null = null;
    private dLogWBarEwma: number | null = null;
    private dLogWBarVarEst = 0;
    private lastDLogWBarRate: number | null = null;

    public onAdmit(_ctx: SignalContext, info: AdmitInfo): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += this.inFlight * (info.admitTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.admitTime;
        this.inFlight++;
    }

    public onComplete(_ctx: SignalContext, info: CompletionInfo): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += this.inFlight * (info.completionTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.completionTime;
        this.inFlight--;
    }

    public onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        const { currentAlpha, bayesianShrinkage, controlWindow } = ctx.regulator;

        // Close out the in-flight integral at the window boundary.
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += this.inFlight * (info.windowEnd - this.lastInFlightChange);
            this.lastInFlightChange = info.windowEnd;
        }

        // Operational Little's Law: W̃ = ∫N(t)dt / r — skipped on
        // empty windows. inFlightMs resets either way.
        if (info.completions === 0 || this.inFlightMs === 0) {
            this.inFlightMs = 0;
            return;
        }

        const W = this.inFlightMs / info.completions;
        const logInstantW = Math.log(W);

        // Level EWMA on logW with Bayesian shrinkage on input.
        const levelAlpha = currentAlpha * bayesianShrinkage;
        const previousLogWBar = this.logWBar;
        if (this.logWBar === null) {
            this.logWBar = logInstantW;
        } else {
            this.logWBar = (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;
        }

        // dt-normalized derivative + trend EWMA + δ² update.
        if (previousLogWBar !== null) {
            const dt = info.elapsed / controlWindow;
            const dLogWBarRate = (this.logWBar - previousLogWBar) / dt;

            if (this.dLogWBarEwma === null) {
                // Seed the trend EWMA with the shrunk derivative.
                this.dLogWBarEwma = dLogWBarRate * bayesianShrinkage;
            } else {
                // Asymmetric shrinkage on the trend numerator.
                this.dLogWBarEwma =
                    (1 - currentAlpha) * this.dLogWBarEwma +
                    currentAlpha * (dLogWBarRate * bayesianShrinkage);
            }

            // δ² = EWMA((v_n − v_{n−1})²/2) — von Neumann's lag-1 variance estimator.
            // Drift-invariant: pairwise differences cancel sustained drift.
            if (this.lastDLogWBarRate !== null) {
                const diff = dLogWBarRate - this.lastDLogWBarRate;
                this.dLogWBarVarEst =
                    (1 - currentAlpha) * this.dLogWBarVarEst +
                    (currentAlpha * diff * diff) / 2;
            }
            this.lastDLogWBarRate = dLogWBarRate;
        }

        this.inFlightMs = 0;

        // Refresh cached test outputs so state() reflects the latest window.
        this.testOutputs(ctx);
    }

    public triggered(ctx: SignalContext): boolean {
        const r = this.testOutputs(ctx);
        return r !== null && r.zScore > r.tCritical;
    }

    public state(): Record<string, unknown> {
        return {
            logWBar: this.logWBar,
            dLogWBarEwma: this.dLogWBarEwma,
            dLogWBarVarEst: this.dLogWBarVarEst,
            inFlight: this.inFlight,
            inFlightMs: this.inFlightMs,
            // Cached test outputs from the last triggered()/state() call.
            // null when there's insufficient data to run the test.
            se: this.cachedSe,
            zScore: this.cachedZScore,
            tCritical: this.cachedTCritical,
            threshold: this.cachedThreshold,
            degrading: this.cachedDegrading
        };
    }

    private cachedSe = 0;
    private cachedZScore = 0;
    private cachedTCritical = 0;
    private cachedThreshold = 0;
    private cachedDegrading = false;

    /** Computes SE, zScore, tCritical, threshold using the current pool heartbeat.
     *  Caches the values for later inspection via state(). Returns null when
     *  the test cannot be evaluated (insufficient data). */
    private testOutputs(ctx: SignalContext): { zScore: number; tCritical: number } | null {
        if (this.dLogWBarEwma === null || this.dLogWBarVarEst === 0) {
            this.cachedSe = 0;
            this.cachedZScore = 0;
            this.cachedTCritical = 0;
            this.cachedThreshold = 0;
            this.cachedDegrading = false;
            return null;
        }
        const { currentAlpha, ewmaSumW2, df, zScoreThreshold } = ctx.regulator;
        if (ewmaSumW2 === 0) return null;

        const sigmaSqEstimate = this.dLogWBarVarEst / (1 + currentAlpha / 2);
        const se = Statistics.studentTTrendSE({ sigmaSqEstimate, ewmaSumW2 });
        if (se === 0) return null;

        const tCritical = Statistics.tScore(zScoreThreshold, df);
        const threshold = tCritical * se;
        const zScore = this.dLogWBarEwma / se;

        this.cachedSe = se;
        this.cachedZScore = zScore;
        this.cachedTCritical = tCritical;
        this.cachedThreshold = threshold;
        this.cachedDegrading = this.dLogWBarEwma > threshold;
        return { zScore, tCritical };
    }

    public clone(): LatencyDrift {
        return new LatencyDrift();
    }
}

// ── ErrorRateThreshold — deterministic threshold predicate ───────────

export interface ErrorRateThresholdOptions {
    /** Threshold ∈ [0, 1]. Triggers when `regulator.errorRateEwma > threshold`. */
    threshold: number;
}

/**
 * Triggers deterministically when the pool's error rate EWMA exceeds a
 * fixed threshold. Useful for "if 50% of work is failing, back off".
 * Stateless — reads `regulator.errorRateEwma`.
 */
export class ErrorRateThreshold implements Signal {
    public readonly name = "error-rate-threshold";
    private readonly threshold: number;

    constructor(options: ErrorRateThresholdOptions) {
        if (
            !Number.isFinite(options.threshold) ||
            options.threshold < 0 ||
            options.threshold > 1
        ) {
            throw new ArgumentError("ErrorRateThreshold.threshold must be in [0, 1].");
        }
        this.threshold = options.threshold;
    }

    public onAdmit(): void {}
    public onComplete(): void {}
    public onEvaluate(): void {}

    public triggered(ctx: SignalContext): boolean {
        const rate = ctx.regulator.errorRateEwma;
        return rate !== null && rate > this.threshold;
    }

    public clone(): ErrorRateThreshold {
        return new ErrorRateThreshold({ threshold: this.threshold });
    }
}

// ── ProbabilisticErrorRate — v1.2 default behavior, opt-in for v2.0 ──

/**
 * Triggers probabilistically with `P = errorRateEwma`. Self-scaling
 * response to systemic errors: at 2% aggregate errors, fires on ~2% of
 * evaluations; at 80%, fires on most.
 *
 * Stateless. Preserves the v1.2 default behavior; opt-in for v2.0+.
 */
export class ProbabilisticErrorRate implements Signal {
    public readonly name = "probabilistic-error-rate";

    public onAdmit(): void {}
    public onComplete(): void {}
    public onEvaluate(): void {}

    public triggered(ctx: SignalContext): boolean {
        const rate = ctx.regulator.errorRateEwma;
        if (rate === null || rate <= 0) return false;
        return Math.random() < rate;
    }

    public clone(): ProbabilisticErrorRate {
        return new ProbabilisticErrorRate();
    }
}
