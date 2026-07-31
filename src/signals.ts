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
 *   {@link PowerDegraded}.
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
 * The pool's shared statistical inference state (α, ESS, df, shrinkage —
 * all from the pool's single `zScoreThreshold`) is exposed to every
 * signal via `ctx.inference`, so custom statistical signals get the
 * framework's rigor for free. Use the `Statistics.*` utilities to
 * compose tests.
 */

import { Statistics } from "./statistics.js";

// ── Context + event payloads ─────────────────────────────────────────

/** Frozen snapshot of pool state passed to every signal hook. */
export interface SignalContext {
    readonly pool: string;
    readonly concurrencyLimit: number;
    readonly inFlight: number;
    /** Peak in-flight this window (high-water mark of actual concurrency).
     *  Equals `concurrencyLimit` when the limit binds, below it when slack —
     *  so `concurrencyLimit ≤ maxInFlight` is the binding-transition signal. */
    readonly maxInFlight: number;
    readonly queueLength: number;
    /** True while ProDel is actively shedding stale queued entries. */
    readonly dropping: boolean;
    /** The pool's shared statistical inference state — informally, its
     *  "heartbeat". Everything a signal needs to run a calibrated
     *  hypothesis test. */
    readonly inference: Inference;
    /** The concurrency controller's state and smoothed observations. */
    readonly regulator: RegulatorContext;
}

/**
 * The pool's shared statistical inference state, computed once per
 * window evaluation by the executor and identical for every signal on
 * the pool — one α, one ESS, one df, one shrinkage per pool, all
 * derived from the pool's single `zScoreThreshold`.
 *
 * It describes the *sampling process* (when windows close, how fast the
 * pool forgets, how much evidence arrived), never the observed values —
 * which is why it is reusable across signals: any EWMA updated on the
 * pool's window boundaries with `currentAlpha` shares this weight
 * vector, and therefore this effective sample size and df. Signals
 * combine these fields with the `Statistics.*` primitives to compose
 * their own hypothesis test (typically a Student-t trend test on a
 * signal-specific observation stream); see `PowerDegraded` for the
 * canonical pattern.
 *
 * Constants (fixed at pool registration): `zScoreThreshold`, `z2`,
 * `timeConstant`, `controlWindow`. All other fields evolve per window.
 */
export interface Inference {
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
     *  recursion (1−α)²·prev + α². Seeded at 1 (one effective
     *  observation), which gates statistical tests off during warm-up. */
    readonly ewmaSumW2: number;
    /** Satterthwaite degrees of freedom: 1/W^(2) − 1. */
    readonly df: number;
    /** Number of control windows evaluated since pool registration. */
    readonly elapsedWindows: number;
}

/**
 * The concurrency controller's state (regulation phase and depth) and
 * its smoothed rate observations. Distinct from {@link Inference}: this
 * describes what the *regulator* is doing and observing; `Inference`
 * describes the statistical basis every signal shares.
 */
export interface RegulatorContext {
    readonly completionRateEwma: number | null;
    readonly admissionRateEwma: number | null;
    readonly dropRateEwma: number | null;
    readonly inFlightEwma: number | null;
    readonly regulationPhase: string;
    readonly regulationDepth: number;
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

// ── PowerDegraded — the canonical statistical regulator signal ─────────

/** Diagnostic state exposed by {@link PowerDegraded.state}. */
export interface PowerDegradedState {
    /** Level EWMA of log-W̃ with Bayesian shrinkage on input. */
    logWBar: number | null;
    /** Trend EWMA of the dt-normalized derivative of `logWBar`. */
    dLogWBarEwma: number | null;
    /** δ² noise estimator (von Neumann's MSSD/2) on the rate stream. */
    dLogWBarVarEst: number;
    /** Batch-means (decision-scale) noise estimator δ²_B on the τ-block rate
     *  stream — the shipped steady-state noise floor (§4.2.6). 0 until the
     *  first block closes; the lag-1 δ² above is the warm-up fallback. */
    blockVarEst: number;
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
    /** Trend-test outcome from the last evaluation (entry evidence). */
    degrading: boolean;
    /** Degradation latch — what `triggered()` reports: high from a
     *  trend-test fire until the level recovers to the reference. */
    latched: boolean;
    /** Pre-excursion reference level — a downward-only second EWMA of
     *  `logWBar` (stationary during excursions by construction; upward
     *  re-basing only via the knee-test release). */
    referenceLevel: number | null;
    /** Recovery margin — the level resolution m = z·SE(logW̄), in log-W
     *  units. The latch releases when `logWBar ≤ referenceLevel + m`.
     *  While latched this reports the episode's frozen yardstick m₀
     *  (snapshotted at onset, re-snapshotted on deepening); between
     *  episodes, the live resolution. */
    recoveryMargin: number | null;
    /** The ε test's signed log-changes since the crossing origin (null
     *  between episodes): ε̂ = dLogW/dLogL. The saturation residual
     *  D = dLogW − dLogL is the shortfall against the saturation null
     *  ε = 1 (by Little's law, identically the log-throughput cost so
     *  far). The knee release fires when D ≥ √(m₀² + m²) — z·SE(D) under
     *  the two-epoch ruler, equivalent to ε̂ + z·SE(ε̂) ≤ 1 — with
     *  excitation −dLogL above the floor √(m₀² + m²)/√2, and only if the
     *  binding-premise check |dLogX − (dLogL − dLogW)| ≤ z·√(2κ_f/r̂)
     *  passes. Diagnostic detail scoped to this signal's state only. */
    epsilon: { dLogL: number; dLogW: number } | null;
}

/** One complete test evaluation — the outputs of a single window's
 *  hypothesis test, stored atomically (see `PowerDegraded.lastTest`). */
type PowerDegradedTest = Pick<
    PowerDegradedState,
    "se" | "zScore" | "tCritical" | "threshold" | "degrading"
>;

/** Configuration for {@link PowerDegraded}. */
export interface PowerDegradedOptions {
    /** Signal name — must be unique within a pool. Override to run two
     *  differently-configured instances side by side. Default:
     *  `"power-degraded"`. */
    name?: string;
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
 * Uses the pool's shared inference state (α, ESS, df, shrinkage from
 * `ctx.inference`) — no signal-local statistical parameters.
 *
 * **Test**: `t = v̂ / SE` against the Cornish-Fisher Student-t critical
 * value at the δ² estimator's effective df = 1/(Σw²·c)
 * (`Statistics.mssdEffectiveDf`, ≈ 12.4 at steady state); the heartbeat
 * df = 1/Σw² − 1 gates evaluability only. The critical value is finite
 * only at df ≥ 5 — `tScore` returns Infinity below, the implicit
 * warm-up gate (~1.2 time constants after cold start or idle reset).
 *
 * **Independence assumption**: the calibration corrects exactly for the
 * correlation the pipeline itself induces (a derived function of α) and
 * assumes window-to-window noise is otherwise independent. Latency noise
 * correlated *across* windows — GC pauses or noise correlation times
 * exceeding `controlWindow` — understates the noise floor and over-fires
 * the test. The remedy is configuration, not correction: size
 * `controlWindow` above the longest routine pause / noise correlation
 * time. See `docs/THEORY.md` §4.2.6 for the measured boundary, why
 * estimated corrections were investigated and rejected, and the planned
 * decision-timescale noise estimator.
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
export class PowerDegraded implements RegulatorSignal<PowerDegradedState> {
    public readonly name: string;

    // ── Operational Little's Law integral ──
    private inFlightMs = 0;
    private lastInFlightChange: number | null = null;

    // ── Latency-trend pipeline state ──
    private logWBar: number | null = null;
    /** Σw² of the LEVEL filter's own weight vector (the α·s recursion).
     *  The heartbeat's `ewmaSumW2` tracks the raw-α vector and overstates
     *  the filters' effective sample size at low throughput; the margin
     *  and the binding tolerance use this matched κ_f instead. The trend
     *  test keeps the shared heartbeat κ — its asymmetric-shrinkage
     *  conservatism is the v1-proven calibration and is not re-tuned. */
    private levelSumW2 = 1;
    private lastLevelUpdateTime: number | null = null;
    private dLogWBarEwma: number | null = null;
    private dLogWBarVarEst = 0;
    private lastDLogWBarRate: number | null = null;

    // ── Batch-means noise floor (decision-timescale) ──
    // The lag-1 δ² above prices the pipeline-manufactured correlation but
    // *understates* the noise floor when the DATA is correlation at scales
    // below the decision horizon (AR(1) latency, multi-window GC pauses),
    // over-firing. The batch-means floor estimates the noise at the τ
    // (decision) scale instead: window rates are accumulated into blocks
    // of length τ; the block rate telescopes to (level change over the
    // block)/duration, so successive block rates stay drift-invariant while
    // pricing ALL sub-τ correlation into δ²_B — no correlation model, no
    // new constant. Correlation persisting past τ is treated as signal,
    // matching the actuator's decision semantics. Used once the block
    // estimator's own df matures (§4.2.6); until then the lag-1 δ² floor is
    // the warm-up fallback, so cold-start detection is unchanged.
    private blockRateSum = 0;
    private blockDtSum = 0;
    private lastBlockRate: number | null = null;
    private blockVarEst = 0; // δ²_B — EWMA[MSSD/2] of block rates
    private blockSumW2 = 1; // ESS tracker of the block estimator (seed 1)

    // ── Degradation latch ──
    // The trend test is the *entry* evidence (calibrated FPR ≤ Φ(−z));
    // the latch holds `triggered()` high until the *level* recovers to
    // the pre-excursion reference — "degraded", not merely "degrading".
    // A trend detector goes quiet at any stable operating point,
    // including a degraded plateau; without the latch the regulator's
    // the elasticity test concludes as soon as latency stops worsening, stranding the
    // limit above the knee (and compounding into an upward ratchet under
    // sustained saturation).
    //
    // `referenceLevel` is a second EWMA of `logWBar` (same α·shrinkage —
    // no new constants): double smoothing lags the level by about one
    // time constant, so when the trend test fires (within a few windows
    // of onset) the reference still holds the pre-excursion level.
    // Tracking is downward-only (min), so it stays pinned during an
    // excursion by construction; the only upward move is the ε release's
    // explicit re-base.
    private referenceLevel: number | null = null;
    private latched = false;
    /** Last computed recovery margin (z·SE of the level estimator), for
     *  observability — the latch's release band is `referenceLevel +
     *  recoveryMargin` in log-W space. */
    private lastMargin: number | null = null;
    /** Matched-filtered log-limit: the same EWMA (α·s, same windows) as
     *  `logWBar`, so Δℓ and Δw share one transfer function and filter
     *  lag cancels identically in the ε test. */
    private logLBar: number | null = null;
    /** Matched-filtered log-throughput — the ε test's binding-premise
     *  check (Little's law: Δx = Δℓ − Δw iff the limit binds). */
    private logXBar: number | null = null;
    /** Point-of-crossing snapshots, taken at latch onset: (logW̄₀, logL̄₀,
     *  logX̄₀) — the common origin for the signed filtered differences
     *  Δw, Δℓ, Δx that the elasticity test compares (plant state only;
     *  the signal never reads the regulator's phase machine). Always
     *  re-snapshotted together — Little's identity Δx = Δℓ − Δw only
     *  holds for differences taken from one origin. */
    private logWBar0: number | null = null;
    private logLBar0: number | null = null;
    private logXBar0: number | null = null;
    /** Whether the concurrency limit was binding (L ≤ maxInFlight) when the
     *  origin was snapshotted. If the crossing happened on inert headroom
     *  (limit far above the operating concurrency), the origin's Δℓ is
     *  fictional until the decrease actuator snaps the limit down to the
     *  binding point — at which transition the experiment is re-anchored. */
    private originIsBinding = false;
    /** Resolution snapshot m₀, taken at latch onset and re-snapshotted on
     *  deepening alongside the origins: the onset-epoch component of the
     *  ε test's two-epoch thresholds (√(m₀² + m²)). The saturation
     *  residual D compares endpoints from two epochs, so its uncertainty
     *  carries both — a
     *  ruler frozen entirely at onset goes stale when ambient noise
     *  shifts mid-episode; a purely live ruler lets the excursion's own
     *  transient widen the episode's thresholds. */
    private resolution0: number | null = null;
    /** Wall-clock time of the last evidence: the trend test firing, or
     *  the limit moving (an experiment in progress). The latch may not
     *  outlive its evidence: the filters forget by elapsed time
     *  (α = 1 − e^(−Δt/(τ·CW))), so evidence ages by elapsed time too —
     *  after one full time constant with neither evidence nor experiment,
     *  the entry evidence has aged out of every estimator, and the only
     *  remaining support for "degraded" is an absolute
     *  level-vs-old-reference comparison, which this framework never
     *  acts on. Release without re-base. */
    private lastEvidenceTime: number | null = null;
    private lastSeenLimit: number | null = null;

    // ── Last test evaluation ──
    // Atomic snapshot, replaced wholesale at each window boundary by
    // `onEvaluate`. `null` means the test was not evaluable (insufficient
    // data or warm-up df gate) — partial staleness is unrepresentable.
    private lastTest: PowerDegradedTest | null = null;

    constructor(options?: PowerDegradedOptions) {
        this.name = options?.name ?? "power-degraded";
    }

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
        const { currentAlpha, bayesianShrinkage, controlWindow, timeConstant } = ctx.inference;

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
            this.levelSumW2 = 1;
        } else {
            this.logWBar = (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;
            this.levelSumW2 =
                (1 - levelAlpha) * (1 - levelAlpha) * this.levelSumW2 + levelAlpha * levelAlpha;
        }
        this.lastLevelUpdateTime = info.windowEnd;

        // Matched filter for the ε test: log L through the IDENTICAL EWMA
        // (same α·s, same update windows) as the level. The ε test then
        // differences two signals with the same transfer function, so the
        // sensor lag cancels identically at every window — comparing a raw
        // (instant) Δℓ against the filtered Δw would register the
        // unabsorbed transient of every limit step as a spurious residual
        // (~0.9·step one window after a tick) and falsely conclude
        // "below the knee" at any true ε.
        const logInstantL = Math.log(Math.max(1, ctx.concurrencyLimit));
        if (this.logLBar === null) {
            this.logLBar = logInstantL;
        } else {
            this.logLBar = (1 - levelAlpha) * this.logLBar + levelAlpha * logInstantL;
        }

        // Third matched filter: log throughput (completions per normalized
        // window span), for the ε test's binding-premise check. Under a
        // binding limit, Little's law forces Δx = Δℓ − Δw exactly; a
        // resolvable disagreement means the limit was not binding during
        // the concurrency-falling probe (demand slack), so Δℓ was not a real change in
        // served concurrency and no
        // below-knee conclusion may be drawn.
        const dtNormX =
            previousLevelUpdateTime !== null
                ? Math.max(1e-9, (info.windowEnd - previousLevelUpdateTime) / controlWindow)
                : 1;
        const logInstantX = Math.log(Math.max(1e-9, info.completions / dtNormX));
        if (this.logXBar === null) {
            this.logXBar = logInstantX;
        } else {
            this.logXBar = (1 - levelAlpha) * this.logXBar + levelAlpha * logInstantX;
        }

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

                // ── Batch-means accumulation at the decision timescale ──
                // Accumulate the (unshrunk) window rate over dt into a block;
                // close the block once it spans τ control windows. The block
                // rate b = Σ(rate·dt)/Σdt telescopes to the level change
                // across the block over its duration, so successive block
                // rates are drift-invariant. δ²_B is their lag-1 MSSD/2, and
                // its ESS (blockSumW2) tracks the block estimator's own df.
                this.blockRateSum += dLogWBarRate * dt;
                this.blockDtSum += dt;
                if (this.blockDtSum >= timeConstant) {
                    const blockRate = this.blockRateSum / this.blockDtSum;
                    if (this.lastBlockRate !== null) {
                        const bdiff = blockRate - this.lastBlockRate;
                        this.blockVarEst =
                            (1 - currentAlpha) * this.blockVarEst +
                            (currentAlpha * bdiff * bdiff) / 2;
                        this.blockSumW2 =
                            (1 - currentAlpha) * (1 - currentAlpha) * this.blockSumW2 +
                            currentAlpha * currentAlpha;
                    }
                    this.lastBlockRate = blockRate;
                    this.blockRateSum = 0;
                    this.blockDtSum = 0;
                }
            }
        }

        // Reset integral only after a successful W computation.
        this.inFlightMs = 0;

        // Atomically replace the last test snapshot for triggered()/state().
        this.lastTest = this.evaluateTest(ctx);

        // ── Degradation latch — an elasticity test run as directed experiments ──
        //
        // ε = dlogW/dlogL defines the contention knee (≈0 below, ≥1 above).
        // ε is only measurable while L moves, so it is tested during the two
        // directed experiments (the climb latches; falling concurrency releases) and
        // the latch holds the last evidenced answer in between. All three
        // comparisons below are against the same yardstick: the level
        // RESOLUTION m = z·SE(logW̄) — the smallest log-latency difference
        // distinguishable from this pool's own noise at confidence z.
        const firing = this.lastTest?.degrading ?? false;
        const gap =
            this.logWBar !== null && this.referenceLevel !== null
                ? this.logWBar - this.referenceLevel
                : null;
        const liveResolution = this.levelMargin(ctx);
        const onsetWindow = firing && !this.latched;
        if (onsetWindow) {
            this.latched = true;
            // Point of crossing: ε > 0 was just evidenced on the climb.
            // Snapshot (logW̄₀, logL̄₀, logX̄₀) — the common origin for the
            // differences Δw, Δℓ, Δx below — and the resolution m₀, the
            // onset-epoch component of the ε test's two-epoch thresholds.
            this.snapshotExperimentOrigin(ctx, liveResolution);
        } else if (
            firing &&
            this.latched &&
            this.logWBar !== null &&
            this.logWBar0 !== null &&
            this.logWBar > this.logWBar0
        ) {
            // Incident deepening while latched — restart the experiment at
            // the worst level reached by re-snapshotting ALL THREE origins
            // together (Little's identity Δx = Δℓ − Δw only holds from a
            // common origin; moving only the Δw origin would bias the
            // binding-premise check by the deepening amount) plus the
            // yardstick m₀ (a new experiment gets a fresh ruler).
            this.snapshotExperimentOrigin(ctx, liveResolution);
        } else if (
            this.latched &&
            !this.originIsBinding &&
            ctx.concurrencyLimit <= ctx.maxInFlight
        ) {
            // Slack→binding transition. The crossing origin was taken on
            // inert headroom (limit far above the operating concurrency), so
            // its Δℓ was fictional; the decrease actuator has now snapped the
            // limit down to the binding point. The limit filter still carries
            // the pre-snap headroom (it lags the raw step), so reset it to the
            // now-binding limit — clearing dead-space memory — and re-anchor
            // the experiment here, so Δℓ measures the real dose from where the
            // actuator can act. W and X are untouched (the snap removed only
            // headroom, no live concurrency, so no plant response). Keeping
            // the concurrency variable = raw limit (never inFlight) is what
            // preserves the binding-premise check: log L diverges from log N
            // only while slack, which is the signal the check reads.
            this.logLBar = Math.log(Math.max(1, ctx.concurrencyLimit));
            this.snapshotExperimentOrigin(ctx, liveResolution);
        }
        // The exposed margin is always the live level ruler — the level
        // release compares the CURRENT estimate against the long-memory
        // reference, so its uncertainty is the current noise; m₀ enters
        // only the ε test's two-epoch thresholds below.
        this.lastMargin = liveResolution;
        if (this.latched) {
            // Evidence-expiry clock: refreshed whenever the test fires
            // (new evidence) or the limit moves (an experiment is
            // running). The onset window itself fires, so the clock
            // starts strictly after onset. (Corollary: any responder with
            // decision cadence ≤ timeConstant is guaranteed at least one
            // opportunity to act before the backstop can conclude.)
            if (
                firing ||
                this.lastSeenLimit !== ctx.concurrencyLimit ||
                this.lastEvidenceTime === null
            ) {
                this.lastEvidenceTime = info.windowEnd;
            }
            this.lastSeenLimit = ctx.concurrencyLimit;
            const resolution = liveResolution;
            if (resolution === null) {
                // Defensive: no resolution yardstick available (empty δ²) —
                // release rather than hold without a measure.
                this.latched = false;
            } else if (gap !== null && gap <= resolution) {
                // Level release: statistically back at the pre-excursion
                // reference — no experiment needed.
                this.latched = false;
            } else if (
                !firing &&
                this.logWBar0 !== null &&
                this.logLBar0 !== null &&
                this.logWBar !== null &&
                this.logLBar !== null
            ) {
                // The elasticity test. With signed changes since the
                // crossing origin, Δℓ = Δlog L̄ and Δw = Δlog W̄:
                //
                //   release when  −Δℓ ≥ z·SE(D)/√2  ∧  D = Δw − Δℓ ≥ z·SE(D)
                //
                // (resolvable excitation was applied, and the response
                // fell short of proportional by a resolvable amount).
                // D ≈ 0 ⟺ ε ≈ 1 (above the knee — reducing L buys latency
                // one-for-one, keep firing); D resolvable ⟺ ε resolvably
                // below 1 (at/below the knee, or the latency is
                // exogenous). "Release once paying throughput stopped
                // buying latency." On release, re-base the reference to
                // the new normal: explicitly, once, on evidence.
                const dLogL = this.logLBar - this.logLBar0;
                const dLogW = this.logWBar - this.logWBar0;
                // D — the residual from the saturation null H₀: ε = 1.
                // Under a binding limit Little's law forces Δw = Δℓ
                // exactly, so any shortfall is evidence against
                // saturation; by the same identity D ≡ −Δx, the
                // log-throughput cost of the concurrency reduction so far.
                const saturationResidual = dLogW - dLogL;
                // z·SE(D) under the two-epoch ruler: D differences two
                // noisy level endpoints — origin (resolution m₀) and now
                // (resolution m) — so z·SE(D) = √(m₀² + m²) (√2·m is the
                // equal-epoch special case; derived, not tuned).
                // NOTE: `saturationResidual ≥ residualThreshold` is
                // exactly the release rule ε̂ + z·SE(ε̂) ≤ 1 with the
                // denominator cleared: with excitation d = −Δℓ and
                // SE(ε̂) = SE(D)/d, multiplying through by d gives
                // Δw − Δℓ ≥ z·SE(D). Division-free: no 0/0 guard, no sign
                // special-cases.
                const residualThreshold = Math.hypot(this.resolution0 ?? resolution, resolution);
                // Excitation floor (the persistent-excitation condition):
                // the rejection above is calibrated at ANY excitation —
                // even zero — so this is NOT for type-I control. It exists
                // because this is the only exit that RE-BASES the
                // reference: without resolvable excitation, D can clear
                // its threshold on level noise alone (Δℓ = 0 ⇒ D = Δw) or
                // on sub-resolvable upward creep plus a token change in L
                // — absorbing an elevated level as the new normal without
                // evidence. The floor makes every re-base certify both
                // halves of the experiment: resolvable excitation was
                // applied AND the response fell resolvably short. Δℓ
                // itself is filtered but noise-free (L is our own
                // actuator).
                const excitationFloor = residualThreshold / Math.SQRT2;
                // Binding-premise check (Little's law integrity): under a
                // binding limit the measured throughput change must equal
                // Δℓ − Δw. Tolerance is z standard errors of the filtered
                // log-throughput difference (Poisson: Var(log X) ≈ 1/r per
                // window; two endpoints; filtered by κ) — derived, no
                // constants. On disagreement the limit was not binding
                // (demand slack — the measured Δℓ was not a real change in
                // served concurrency): draw no below-knee conclusion.
                const rHat = Math.max(1, ctx.regulator.completionRateEwma ?? 1);
                const bindingTolerance =
                    ctx.inference.zScoreThreshold *
                    Math.sqrt((2 * this.levelSumW2) / rHat);
                const dLogX =
                    this.logXBar !== null && this.logXBar0 !== null
                        ? this.logXBar - this.logXBar0
                        : null;
                const bindingOk =
                    dLogX === null || Math.abs(dLogX - (dLogL - dLogW)) <= bindingTolerance;
                const belowKnee =
                    bindingOk &&
                    -dLogL >= excitationFloor &&
                    saturationResidual >= residualThreshold;
                // Evidence-expiry backstop: a full time constant of
                // wall-clock has passed with the test quiet and the limit
                // unmoved — no new evidence, no running experiment. The
                // entry evidence has aged out of the pool's own filters
                // (which forget by elapsed time, exactly like this clock),
                // and holding further would rest solely on an absolute
                // level-vs-reference comparison. Release rather than
                // assert.
                const stalled =
                    this.lastEvidenceTime !== null &&
                    info.windowEnd - this.lastEvidenceTime >=
                        ctx.inference.timeConstant * ctx.inference.controlWindow &&
                    gap !== null &&
                    gap > resolution;
                if (belowKnee) {
                    // Evidence-gated release: re-base the reference to the
                    // new normal.
                    this.latched = false;
                    this.referenceLevel = this.logWBar;
                } else if (stalled) {
                    // No experiment could be run — release WITHOUT re-basing:
                    // the stall is the absence of evidence, and a higher
                    // level must never be absorbed as normal without it.
                    this.latched = false;
                }
            }
            if (!this.latched) {
                this.logWBar0 = null;
                this.logLBar0 = null;
                this.logXBar0 = null;
                this.resolution0 = null;
                this.originIsBinding = false;
                this.lastEvidenceTime = null;
                this.lastSeenLimit = null;
            }
        }
        // Reference tracking: a second EWMA of the level, DOWNWARD-ONLY.
        // Improvements are absorbed immediately; a higher level is never
        // silently accepted as the new normal (re-tracking an elevated
        // plateau would legitimize one band-width of degradation per
        // cycle — a slow residual ratchet). The only upward move is the
        // evidence-gated knee-test re-base above. Note there is no
        // separate "freeze while latched" rule: during an excursion the
        // level sits above the reference, so the EWMA update points up
        // and min() rejects it — stationarity during episodes is a
        // property of downward-only tracking, not an extra mechanism.
        if (this.logWBar !== null) {
            if (this.referenceLevel === null) {
                this.referenceLevel = this.logWBar;
            } else {
                const tracked =
                    (1 - levelAlpha) * this.referenceLevel + levelAlpha * this.logWBar;
                this.referenceLevel = Math.min(this.referenceLevel, tracked);
            }
        }
    }

    public triggered(_ctx: SignalContext): boolean {
        // Latched semantics: high from the calibrated trend-test fire
        // until level recovery (or futility) — "the pool is degraded",
        // not "latency is currently worsening".
        return this.latched;
    }

    /** Recovery margin / resolution: z standard errors of the level
     *  estimator. σ_x² is recovered from δ² via Var(v) = ᾱ²σ_x²(1+κ_f)
     *  (THEORY Appendix A) evaluated at the LEVEL filter's own effective
     *  ᾱ = α·s and its own weight vector κ_f = `levelSumW2`, so
     *  SE_level = √(κ_f · δ² / ((1+ᾱ/2)·ᾱ²·(1+κ_f))). The shared
     *  heartbeat κ describes the raw-α vector and would overstate the
     *  filter's effective sample size (understating the margin) exactly
     *  when throughput — and therefore evidence — is scarce. Every input
     *  is existing machinery; the only free parameter is z. */
    /** Snapshot the common experiment origin (logW̄₀, logL̄₀, logX̄₀) and the
     *  onset-epoch resolution m₀, and record whether the limit is binding at
     *  the origin. Taken together so Little's identity Δx = Δℓ − Δw holds from
     *  one origin; used at onset, on deepening, and on the slack→binding
     *  re-anchor. */
    private snapshotExperimentOrigin(ctx: SignalContext, liveResolution: number | null): void {
        this.logWBar0 = this.logWBar;
        this.logLBar0 = this.logLBar;
        this.logXBar0 = this.logXBar;
        this.resolution0 = liveResolution;
        this.originIsBinding = ctx.concurrencyLimit <= ctx.maxInFlight;
    }

    private levelMargin(ctx: SignalContext): number | null {
        const { currentAlpha, bayesianShrinkage, zScoreThreshold } = ctx.inference;
        const levelAlpha = currentAlpha * bayesianShrinkage;
        if (this.dLogWBarVarEst === 0 || levelAlpha === 0) return null;
        const sigmaVSq = this.dLogWBarVarEst / (1 + levelAlpha / 2);
        const sigmaXSq = sigmaVSq / (levelAlpha * levelAlpha * (1 + this.levelSumW2));
        return zScoreThreshold * Math.sqrt(this.levelSumW2 * sigmaXSq);
    }

    public state(): PowerDegradedState {
        // Test fields are zero until the test is evaluable (warm-up).
        const test = this.lastTest ?? {
            se: 0,
            zScore: 0,
            tCritical: 0,
            threshold: 0,
            degrading: false
        };
        return {
            logWBar: this.logWBar,
            dLogWBarEwma: this.dLogWBarEwma,
            dLogWBarVarEst: this.dLogWBarVarEst,
            blockVarEst: this.blockVarEst,
            inFlightMs: this.inFlightMs,
            latched: this.latched,
            referenceLevel: this.referenceLevel,
            recoveryMargin: this.lastMargin,
            // Live ε readouts, derived on demand — the origins and filters
            // already carry them (null unless an episode is in progress).
            epsilon:
                this.latched &&
                this.logLBar !== null &&
                this.logWBar !== null &&
                this.logLBar0 !== null &&
                this.logWBar0 !== null
                    ? {
                          dLogL: this.logLBar - this.logLBar0,
                          dLogW: this.logWBar - this.logWBar0
                      }
                    : null,
            ...test
        };
    }

    public clone(): PowerDegraded {
        return new PowerDegraded({ name: this.name });
    }

    /** Evaluate the hypothesis test against the current shared inference
     *  state. Reads pipeline state, mutates nothing — returns a complete
     *  snapshot, or `null` when the test cannot be evaluated (insufficient
     *  data, or the warm-up df gate). */
    private evaluateTest(ctx: SignalContext): PowerDegradedTest | null {
        if (this.dLogWBarEwma === null || this.dLogWBarVarEst === 0) return null;
        const { currentAlpha, ewmaSumW2, df, zScoreThreshold, timeConstant } = ctx.inference;
        // df ≤ 0: not enough effective evidence to reject (warm-up gate).
        if (ewmaSumW2 === 0 || df <= 0) return null;

        // Noise floor: the batch-means (decision-scale) estimator once its
        // own df has matured, else the lag-1 δ² floor (warm-up fallback).
        // δ²_B estimates Var(block rate) = σ²_LR / τ, so σ²_LR = τ · δ²_B is
        // the per-window long-run variance INCLUDING sub-τ correlation; the
        // δ² floor is δ²/(1+α/2) = σ²_window, which equals σ²_LR only when
        // the data is uncorrelated. Both are drift-invariant. The t-critical
        // uses whichever estimator supplied the floor (its overlapping-δ²
        // effective df). The heartbeat κ (ewmaSumW2) still shapes the SE of
        // the trend EWMA — the block floor changes the *variance level*, not
        // the trend EWMA's weight structure.
        const blockDfEff = Statistics.mssdEffectiveDf(currentAlpha, this.blockSumW2);
        const blockTCritical =
            this.blockVarEst > 0
                ? Statistics.tScore(zScoreThreshold, blockDfEff)
                : Number.POSITIVE_INFINITY;

        let sigmaSqEstimate: number;
        let tCritical: number;
        if (Number.isFinite(blockTCritical)) {
            sigmaSqEstimate = timeConstant * this.blockVarEst;
            tCritical = blockTCritical;
        } else {
            sigmaSqEstimate = this.dLogWBarVarEst / (1 + currentAlpha / 2);
            tCritical = Statistics.tScore(
                zScoreThreshold,
                Statistics.mssdEffectiveDf(currentAlpha, ewmaSumW2)
            );
        }
        const se = Statistics.studentTTrendSE({ sigmaSqEstimate, ewmaSumW2 });
        if (se === 0) return null;

        const threshold = tCritical * se;
        return {
            se,
            zScore: this.dLogWBarEwma / se,
            tCritical,
            threshold,
            degrading: this.dLogWBarEwma > threshold
        };
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
        const { dropRateEwma, completionRateEwma } = ctx.regulator;
        const { z2 } = ctx.inference;
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
        const { timeConstant, controlWindow, z2 } = ctx.inference;
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
