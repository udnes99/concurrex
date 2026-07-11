/**
 * Pluggable signals — the policy layer of the executor.
 *
 * The executor owns the *engine* (the queue, lanes, the statistical
 * heartbeat, and the concurrency/admission actuators) but delegates
 * *policy* to two kinds of pluggable signal:
 *
 * - **{@link RegulatorSignal}** decides *concurrency* — it observes task
 *   events and, once per evaluation cycle, returns whether the regulator
 *   should decrease the concurrency limit. The built-in default is
 *   {@link LatencyDrift}.
 * - **{@link AdmissionSignal}** decides *admission* — it is queried at
 *   enqueue with the target lane and returns whether to shed (reject) the
 *   request. The built-in default is {@link EarlyShed}; {@link LaneErrorShed}
 *   is an exported opt-in.
 *
 * Both share {@link BaseSignal}: a stable `name`, optional lifecycle hooks
 * (`onAdmit`, `onComplete`, `onEvaluate`, `onLaneRemoved`), and optional
 * `state()` for diagnostics. Signals own their per-pool state — they are
 * cloned per pool at `registerPool`, so one template can be registered
 * with many pools without state interleaving.
 *
 * The statistical heartbeat (α, ESS, df, shrinkage — all from the pool's
 * single `zScoreThreshold`) is exposed to every signal via
 * `ctx.regulator`, so custom statistical signals get the framework's
 * rigor for free. Use the `Statistics.*` utilities to compose tests.
 */

import { Statistics } from "./statistics.js";

// ── Context + event payloads ─────────────────────────────────────────

/** Frozen snapshot of pool state passed to every signal hook. */
export interface SignalContext {
    readonly pool: string;
    readonly concurrencyLimit: number;
    readonly inFlight: number;
    readonly queueLength: number;
    /** True while ProDel is actively shedding stale queued entries. */
    readonly dropping: boolean;
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

// ── Signal interfaces ────────────────────────────────────────────────

/**
 * Shared base of every pluggable signal: a stable identifier, optional
 * lifecycle hooks, and optional diagnostic state. Concrete signals
 * extend either {@link RegulatorSignal} (concurrency policy) or
 * {@link AdmissionSignal} (admission policy).
 *
 * Stateful signals must not share state across pools — they are cloned
 * per pool via `clone()` (declared on the leaf interfaces so the return
 * type is precise). Stateless signals can `return this` from `clone()`.
 *
 * The executor catches and logs any exception thrown from a hook or
 * decision method, so a buggy signal cannot break admission, completion,
 * or regulation.
 *
 * The type parameter `S` is the shape returned by `state()`; defaults to
 * `unknown`. Callers reading diagnostics via `executor.getSignalState<S>`
 * pass `S` to get a typed result.
 *
 * @remarks
 * Tasks rejected at enqueue (ProDel drops, admission sheds) and queued
 * tasks rejected by `stop()` fire neither `onAdmit` nor `onComplete`. A
 * task that was already admitted when `stop()` landed (but had not yet
 * started) fires `onAdmit` without a matching `onComplete` — the
 * executor corrects the in-flight count itself, so integral-style
 * signals reading `ctx.inFlight` stay consistent. Per-lane state should
 * be cleaned up in `onLaneRemoved`, which fires when a lane is dropped
 * from the pool (no queued entries and nothing in flight) — including at
 * `stop()` for idle lanes, and at last-task completion for lanes that
 * still had work in flight when the executor stopped.
 */
export interface BaseSignal<S = unknown> {
    /** Stable identifier — used in diagnostics, logs, `getSignalState`.
     *  Must be unique across all of a pool's signals. */
    readonly name: string;

    /** Optional: called once per task admission, just after `inFlight++`. */
    onAdmit?(ctx: SignalContext, info: AdmitInfo): void;

    /** Optional: called once per task completion, just after `inFlight--`. */
    onComplete?(ctx: SignalContext, info: CompletionInfo): void;

    /** Optional: called at every control-window boundary. Window-
     *  aggregated computations (EWMA updates, derivative computation,
     *  noise-floor updates) typically live here. */
    onEvaluate?(ctx: SignalContext, info: EvaluateInfo): void;

    /** Optional: called when a lane is removed from the pool (no queued
     *  entries, nothing in flight). Signals holding per-lane state should
     *  delete the lane's entry here to keep memory bounded — this fires
     *  for transient (per-request) lanes too. Takes only the lane key;
     *  no context, since teardown needs none. */
    onLaneRemoved?(laneKey: string): void;

    /** Optional: expose internal state for diagnostics. Returned by
     *  `executor.getSignalState(pool, name)`. */
    state?(): S;
}

/**
 * A concurrency-policy signal. The regulator queries each pool's
 * regulator signals once per evaluation cycle (every `timeConstant`
 * windows); if any returns `triggered() === true`, the regulator applies
 * a concurrency decrease. Multiple signals compose with OR semantics.
 *
 * @example
 * ```typescript
 * // Minimal predicate regulator signal — name, triggered, clone.
 * const memoryPressure: RegulatorSignal = {
 *     name: "memory-pressure",
 *     triggered: () => process.memoryUsage().heapUsed > 1_000_000_000,
 *     clone() { return this; }
 * };
 * ```
 */
export interface RegulatorSignal<S = unknown> extends BaseSignal<S> {
    /** Decide whether concurrency should decrease. Called every
     *  `timeConstant` regulation cycles. */
    triggered(ctx: SignalContext): boolean;

    /** Create a fresh per-pool copy (config retained, accumulated state
     *  reset). Stateless signals can `return this`. */
    clone(): RegulatorSignal<S>;
}

/**
 * An admission-policy signal. The executor queries each pool's admission
 * signals at enqueue, before the request joins the queue; if any returns
 * `shouldShed() === true`, the request is rejected immediately with a
 * {@link ResourceExhaustedError} (counted as a drop). Multiple signals
 * compose with OR semantics.
 *
 * `shouldShed` receives the target lane key, so a signal can make
 * per-lane decisions (e.g. fence off one failing downstream). Signals
 * holding per-lane state populate it from `onComplete(info.lane, …)` and
 * release it in `onLaneRemoved(laneKey)`.
 *
 * @example
 * ```typescript
 * // Reject when an external circuit breaker is open.
 * const breaker: AdmissionSignal = {
 *     name: "circuit-breaker",
 *     shouldShed: () => myBreaker.isOpen(),
 *     clone() { return this; }
 * };
 * ```
 */
export interface AdmissionSignal<S = unknown> extends BaseSignal<S> {
    /** Decide whether to shed (reject) a request to `laneKey` at enqueue.
     *  `true` rejects; `false` admits to the queue. Called once per
     *  request. */
    shouldShed(ctx: SignalContext, laneKey: string): boolean;

    /** Create a fresh per-pool copy (config retained, accumulated state
     *  reset). Stateless signals can `return this`. */
    clone(): AdmissionSignal<S>;
}

// ── LatencyDrift — the canonical statistical regulator signal ─────────

/** Diagnostic state exposed by {@link LatencyDrift.state}. */
export interface LatencyDriftState {
    /** Level EWMA of log-W̃ with Bayesian shrinkage on input. */
    logWBar: number | null;
    /** Trend EWMA of the dt-normalized derivative of `logWBar`. */
    dLogWBarEwma: number | null;
    /** δ² noise estimator (von Neumann's MSSD/2) on the rate stream. */
    dLogWBarVarEst: number;
    /** Open ∫N(t)dt accumulator since the window start, in ms. */
    inFlightMs: number;
    /** Autocorrelation-corrected standard error of the trend EWMA. */
    se: number;
    /** Test statistic: `dLogWBarEwma / se`. */
    zScore: number;
    /** Cornish-Fisher Student-t critical value at the pool's df. */
    tCritical: number;
    /** Decision threshold on the trend: `tCritical * se`. */
    threshold: number;
    /** Cached `triggered()` outcome from the last evaluation. */
    degrading: boolean;
}

/**
 * Latency-trend Student-t hypothesis test (the v1.x detection mechanism,
 * now a first-class regulator signal). Default regulator signal for every
 * pool.
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
 *   - `inFlightMs`, `lastInFlightChange` — operational LL integral
 *   - `logWBar`, `lastLevelUpdateTime`, `dLogWBarEwma`, `dLogWBarVarEst`, `lastDLogWBarRate`
 *
 * The instantaneous in-flight count is read from `ctx.inFlight`. The
 * executor calls `onAdmit` after `pool.inFlight++` and `onComplete`
 * after `pool.inFlight--`, so the count *before* the change is
 * `ctx.inFlight − 1` and `ctx.inFlight + 1` respectively — that's the
 * value that applies to the elapsed slice we're integrating.
 *
 * Empty windows (zero completions) accumulate into `inFlightMs` rather
 * than discarding it, so a task that spans N windows contributes its
 * full residence integral to the eventual W̃ at completion time.
 * The derivative is normalized by time since the last level update
 * (`lastLevelUpdateTime`) so empty windows don't inflate the rate.
 */
export class LatencyDrift implements RegulatorSignal<LatencyDriftState> {
    public readonly name = "latency-drift";

    // ── Operational Little's Law integral ──
    private inFlightMs = 0;
    private lastInFlightChange: number | null = null;

    // ── Latency-trend pipeline state ──
    private logWBar: number | null = null;
    private lastLevelUpdateTime: number | null = null;
    private dLogWBarEwma: number | null = null;
    private dLogWBarVarEst = 0;
    private lastDLogWBarRate: number | null = null;

    // ── Cached test outputs (refreshed by testOutputs()) ──
    private cachedSe = 0;
    private cachedZScore = 0;
    private cachedTCritical = 0;
    private cachedThreshold = 0;
    private cachedDegrading = false;

    public onAdmit(ctx: SignalContext, info: AdmitInfo): void {
        if (this.lastInFlightChange !== null) {
            // ctx.inFlight is post-admit; the slice we're closing ran at
            // the pre-admit count.
            const previousInFlight = ctx.inFlight - 1;
            this.inFlightMs += previousInFlight * (info.admitTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.admitTime;
    }

    public onComplete(ctx: SignalContext, info: CompletionInfo): void {
        if (this.lastInFlightChange !== null) {
            // ctx.inFlight is post-completion; the slice ran at the
            // pre-completion count.
            const previousInFlight = ctx.inFlight + 1;
            this.inFlightMs += previousInFlight * (info.completionTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.completionTime;
    }

    public onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        const { currentAlpha, bayesianShrinkage, controlWindow } = ctx.regulator;

        // Close out the in-flight integral at the window boundary. No
        // task event happened — the slice ran at `ctx.inFlight`.
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += ctx.inFlight * (info.windowEnd - this.lastInFlightChange);
            this.lastInFlightChange = info.windowEnd;
        }

        // Operational Little's Law: W̃ = ∫N(t)dt / r. On empty windows
        // we *keep* `inFlightMs` so a task that spans multiple windows
        // contributes its full residence integral at eventual completion.
        if (info.completions === 0 || this.inFlightMs === 0) {
            return;
        }

        const W = this.inFlightMs / info.completions;
        const logInstantW = Math.log(W);

        // Level EWMA on logW with Bayesian shrinkage on input.
        const levelAlpha = currentAlpha * bayesianShrinkage;
        const previousLogWBar = this.logWBar;
        const previousLevelUpdateTime = this.lastLevelUpdateTime;
        if (this.logWBar === null) {
            this.logWBar = logInstantW;
        } else {
            this.logWBar = (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;
        }
        this.lastLevelUpdateTime = info.windowEnd;

        // dt-normalized derivative + trend EWMA + δ² update. `dt` is
        // the elapsed time since the *previous* level update — not just
        // the current window — so empty windows in between don't inflate
        // the rate.
        if (previousLogWBar !== null && previousLevelUpdateTime !== null) {
            const dt = (info.windowEnd - previousLevelUpdateTime) / controlWindow;
            if (dt > 0) {
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
        }

        // Reset integral only after a successful W computation.
        this.inFlightMs = 0;

        // Refresh cached test outputs so state() reflects the latest window.
        this.testOutputs(ctx);
    }

    public triggered(_ctx: SignalContext): boolean {
        // `onEvaluate` refreshes the cache at every window boundary; the
        // regulator calls `triggered` immediately after the heartbeat tick,
        // so the cached value is current.
        return this.cachedDegrading;
    }

    public state(): LatencyDriftState {
        return {
            logWBar: this.logWBar,
            dLogWBarEwma: this.dLogWBarEwma,
            dLogWBarVarEst: this.dLogWBarVarEst,
            inFlightMs: this.inFlightMs,
            // Cached test outputs from the last evaluation. Zero until
            // there's enough data to run the test.
            se: this.cachedSe,
            zScore: this.cachedZScore,
            tCritical: this.cachedTCritical,
            threshold: this.cachedThreshold,
            degrading: this.cachedDegrading
        };
    }

    public clone(): LatencyDrift {
        return new LatencyDrift();
    }

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
}

// ── EarlyShed — the default admission signal (queue-health based) ─────

/**
 * Probabilistic early shedding. When ProDel is actively dropping and the
 * pool is at capacity, a new arrival is likely doomed to queue and then
 * be dropped — so reject it immediately with
 *
 *   P = shrinkage(completionRate) × dropRate / (dropRate + completionRate)
 *
 * giving the caller an instant rejection instead of a wasted queue wait.
 * Domain-agnostic (keys off queue health, not errors), so it is the
 * built-in default admission signal. Stateless.
 */
export class EarlyShed implements AdmissionSignal {
    public readonly name = "early-shed";

    public shouldShed(ctx: SignalContext, _laneKey: string): boolean {
        if (!ctx.dropping || ctx.inFlight < ctx.concurrencyLimit) return false;
        const { dropRateEwma, completionRateEwma, z2 } = ctx.regulator;
        if (
            dropRateEwma === null ||
            dropRateEwma <= 0 ||
            completionRateEwma === null ||
            completionRateEwma <= 0
        ) {
            return false;
        }
        // Bayesian shrinkage dampens the probability at low throughput
        // where the drop/completion-rate EWMAs are based on few observations.
        const P =
            (dropRateEwma / (dropRateEwma + completionRateEwma)) *
            Statistics.bayesianShrinkage(completionRateEwma, z2);
        return Math.random() < P;
    }

    public clone(): EarlyShed {
        return this;
    }
}

// ── LaneErrorShed — opt-in per-lane error shedding ────────────────────

/** Diagnostic state exposed by {@link LaneErrorShed.state}: the tracked
 *  per-lane error-rate EWMAs. */
export interface LaneErrorShedState {
    laneErrorRates: Record<string, number>;
}

/** Per-lane error-tracking record (internal to {@link LaneErrorShed}). */
interface LaneErrorEntry {
    errorRateEwma: number;
    lastCompletionTime: number;
    completions: number;
}

/**
 * Opt-in per-lane error shedding. Tracks each lane's error-rate EWMA and
 * probabilistically rejects new requests to a lane that has been failing
 * (`P = lane.errorRateEwma`), fencing off a broken downstream without
 * affecting other lanes. This is the v1.x per-lane shedding behavior,
 * now an explicit signal you opt into:
 *
 * ```typescript
 * executor.registerPool("api", {
 *     admissionSignals: [new EarlyShed(), new LaneErrorShed()]
 * });
 * ```
 *
 * **Off by default** — an "error" is domain-specific (a 404, a validation
 * failure, or a business rejection is not an infrastructure failure), so
 * the executor does not assume errors should shed work. Enable this only
 * when a task failure genuinely signals the lane's backend cannot serve.
 *
 * The EWMA is time-weighted (alpha grows with the gap since the lane's
 * last completion) and Bayesian-shrunk by the lane's cumulative
 * completion count, so a lane with little history sheds conservatively.
 * Per-lane state is created lazily on first completion and released in
 * `onLaneRemoved`, keeping memory bounded under transient-lane churn.
 */
export class LaneErrorShed implements AdmissionSignal<LaneErrorShedState> {
    public readonly name = "lane-error-shed";

    private readonly lanes = new Map<string, LaneErrorEntry>();

    public onComplete(ctx: SignalContext, info: CompletionInfo): void {
        const { timeConstant, controlWindow, z2 } = ctx.regulator;
        let entry = this.lanes.get(info.lane);
        if (entry === undefined) {
            entry = { errorRateEwma: 0, lastCompletionTime: info.completionTime, completions: 0 };
            this.lanes.set(info.lane, entry);
        }
        entry.completions++;
        // Time-weighted alpha: rapid completions → small alpha (each sample
        // less weight); long gaps → large alpha (old data stale). The
        // max(1, ·) floor lets same-tick completions still contribute weight.
        const elapsed = Math.max(1, info.completionTime - entry.lastCompletionTime);
        const timeAlpha = Statistics.timeWeightedAlpha(elapsed, timeConstant, controlWindow);
        // Bayesian shrinkage dampens updates for lanes with few completions,
        // preventing noisy early estimates from causing aggressive shedding.
        const laneAlpha = timeAlpha * Statistics.bayesianShrinkage(entry.completions, z2);
        entry.errorRateEwma =
            (1 - laneAlpha) * entry.errorRateEwma + laneAlpha * (info.errored ? 1 : 0);
        entry.lastCompletionTime = info.completionTime;
    }

    public onLaneRemoved(laneKey: string): void {
        this.lanes.delete(laneKey);
    }

    public shouldShed(_ctx: SignalContext, laneKey: string): boolean {
        const entry = this.lanes.get(laneKey);
        return entry !== undefined && entry.errorRateEwma > 0 && Math.random() < entry.errorRateEwma;
    }

    public state(): LaneErrorShedState {
        const laneErrorRates: Record<string, number> = {};
        for (const [key, entry] of this.lanes) {
            laneErrorRates[key] = entry.errorRateEwma;
        }
        return { laneErrorRates };
    }

    public clone(): LaneErrorShed {
        return new LaneErrorShed();
    }
}
