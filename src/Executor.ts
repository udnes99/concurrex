import type { Logger } from "./logger.js";
import { ArgumentError, ResourceExhaustedError, ExecutorNotRunningError } from "./errors.js";
import { type Callback, createCallback } from "./callback.js";
import {
    type AdmitInfo,
    type CompletionInfo,
    type EvaluateInfo,
    type RegulatorContext,
    type BaseSignal,
    type RegulatorSignal,
    type AdmissionSignal,
    type SignalContext,
    LatencyDrift,
    EarlyShed
} from "./signals.js";
import { Statistics } from "./statistics.js";

/** Throughput regulator phase — tracks the current regulation direction. */
enum RegulationPhase {
    /** At baseline, no active regulation. */
    Idle = 0,
    /** Growing above baseline due to queue pressure. */
    Increasing = 1,
    /** Walking back a previous increase sequence in reverse order. */
    Retracting = 2,
    /** Fresh decrease ramp after retraction is exhausted (or no prior increase). */
    Decreasing = 3,
    /** Converging back toward baseline (gravity). */
    Restoring = 4
}

export enum DebounceMode {
    /** Deduplicate until the task has started executing. */
    BeforeExecution = "beforeExecution",

    /** Deduplicate until the task has completed with a result. */
    BeforeResult = "beforeResult"
}

type QueueEntry = {
    callback: Callback<void>;
    enqueuedAt: number;
};

type Lane = {
    entries: QueueEntry[];
    inFlight: number;
    key: string;
    prev: Lane | null;
    next: Lane | null;
};

type DebouncedEntry<T = unknown> = {
    callback: Callback<T>;
    mode: DebounceMode;
    lane: string;
};

type Parameters = {
    zScoreThreshold: number;
    timeConstant: number;
    z2: number;
};

type Pool = {
    name: string;
    parameters: Parameters | null; // null = use executor default
    delayThreshold: number;
    baselineConcurrency: number;
    minimumConcurrency: number;
    maximumConcurrency: number;
    concurrencyLimit: number;
    controlWindow: number;
    inFlight: number;
    queueLength: number;
    lanes: Map<string, Lane>;
    laneHead: Lane | null; // oldest lane (ProDel drops here)
    laneTail: Lane | null; // newest lane (admission starts here)
    debounceMap: Map<string, DebouncedEntry>;

    // ProDel state (queue management)
    firstAboveTime: number | null;
    dropping: boolean;
    dropCount: number;
    dropNext: number;

    // Throughput monitor state (capacity regulation)
    windowStart: number;
    completionsThisWindow: number;
    /** Admissions this window — tasks that entered in-flight. */
    admissionsThisWindow: number;
    admissionRateEwma: number | null;
    completionRateEwma: number | null;
    dropsThisWindow: number;
    dropRateEwma: number | null;
    elapsedWindows: number;

    // EWMA of in-flight count (for observability).
    inFlightEwma: number | null;

    // ── Statistical heartbeat ──
    // Computed once per window evaluation. Exposed to signals via
    // RegulatorContext. Single source of truth for the control loop's
    // statistical parameters — derived from the pool's zScoreThreshold.
    currentAlpha: number;          // 1 − exp(−Δt/(τ·CW))
    bayesianShrinkage: number;     // r / (r + z²) for current window
    ewmaSumW2: number;             // Σw² (ESS tracker; seeded at 1 = one effective observation)

    // Convergent throughput regulator state
    regulationDepth: number;
    regulationPhase: RegulationPhase;
    /** Bisection damping: halves on each increase→retract→cooling cycle.
     *  Allows convergence to within ±1 of true equilibrium. */
    stepScale: number;

    // Deferred re-evaluation timer
    processQueueTimer: ReturnType<typeof setTimeout> | null;

    // Pluggable signals — per-pool clones of the executor/pool templates,
    // each owning its own per-pool state. Regulator signals decide
    // concurrency; admission signals decide enqueue-time shedding.
    // `lifecycleSignals` is the union (regulator ++ admission), held
    // separately so per-task hook dispatch needs no allocation.
    regulatorSignals: ReadonlyArray<RegulatorSignal>;
    admissionSignals: ReadonlyArray<AdmissionSignal>;
    lifecycleSignals: ReadonlyArray<BaseSignal>;
};

export type PoolOptions = {
    /** Override the z-score threshold for this pool. When omitted, inherits the executor-level default. */
    zScoreThreshold?: number;
    /** Maximum acceptable sojourn time (ms) before ProDel considers the queue overloaded. Default: 100. */
    delayThreshold?: number;
    /** Minimum concurrency limit — the throughput regulator will never decrease below this. Default: 1. */
    minimumConcurrency?: number;
    /** Starting concurrency limit. The throughput regulator adjusts from this baseline. Default: 100. */
    baselineConcurrency?: number;
    /** Absolute maximum concurrency limit — the throughput regulator will never increase above this. Default: Infinity. */
    maximumConcurrency?: number;
    /** Time window (ms) for both ProDel grace period and throughput measurement interval. Default: 100. */
    controlWindow?: number;
    /** Concurrency-policy signals for this pool (see {@link RegulatorSignal}).
     *  Each is checked once per regulator evaluation cycle; if any returns
     *  `triggered() === true`, the regulator decreases concurrency.
     *
     *  When omitted, the pool inherits the executor-level regulator signals.
     *  When provided (even as an empty array), the pool's signals **replace**
     *  the executor defaults entirely — no merge. An empty array means "never
     *  auto-decrease on backpressure" (gravity and queue pressure still apply).
     *
     *  Templates are cloned via `clone()` per pool, so one instance can be
     *  registered with many pools without state interleaving.
     *
     *  Default: `[new LatencyDrift()]`. */
    regulatorSignals?: RegulatorSignal[];
    /** Admission-policy signals for this pool (see {@link AdmissionSignal}).
     *  Each is queried at enqueue with the target lane; if any returns
     *  `shouldShed() === true`, the request is rejected immediately (counted
     *  as a drop).
     *
     *  When omitted, the pool inherits the executor-level admission signals.
     *  When provided (even as an empty array), replaces them entirely. An
     *  empty array disables enqueue-time shedding (ProDel still drops stale
     *  queued entries).
     *
     *  Default: `[new EarlyShed()]` — probabilistic early shedding. Add
     *  `new LaneErrorShed()` to opt into per-lane error shedding. */
    admissionSignals?: AdmissionSignal[];
};

/**
 * General-purpose regulator metrics for a pool. Signal-specific state
 * (latency-test internals, custom signal statistics) is exposed separately
 * via {@link Executor.getSignalState}.
 *
 * The `overloadDetected` flag is true if any configured signal is
 * currently triggered. To inspect *which* signal and its internals, use
 * `executor.getSignalState(pool, signalName)`.
 */
export type RegulatorState = {
    /** EWMA of in-flight count. */
    inFlightEwma: number | null;
    /** EWMA of completion rate (completions per window). */
    completionRateEwma: number | null;
    /** EWMA of admission rate (admissions per window). */
    admissionRateEwma: number | null;
    /** EWMA of drop rate (drops per window). */
    dropRateEwma: number | null;
    /** Current regulation phase. */
    regulationPhase: string;
    /** Current regulation depth. */
    regulationDepth: number;
    /** Number of elapsed control windows. */
    elapsedWindows: number;
    /** Whether any configured signal is currently triggered. Equivalent to
     *  `executor.isThroughputDegraded(pool)`. */
    overloadDetected: boolean;
};

export type TaskRunOptions = {
    /** Fair scheduling key. Requests with the same lane get round-robin fairness. When omitted, a transient lane is created per request. */
    lane?: string;
};

export type TaskRunDebouncedOptions = TaskRunOptions & {
    mode?: DebounceMode;
};

/** Default ProDel interval — sustained overload window before drops begin (ms). */
const DEFAULT_CONTROL_WINDOW = 100;

/** Default z-score threshold when none is provided to the constructor. */
const DEFAULT_Z_SCORE_THRESHOLD = 2;

/**
 * A ProDel-based executor with adaptive concurrency.
 *
 * Four independent mechanisms cooperate:
 *
 * **ProDel** (Probabilistic Delay Load-shedding): manages queue health using
 * sojourn-proportional probabilistic load shedding. Each stale entry
 * (sojourn > threshold) is dropped with probability P = 1 - threshold/sojourn.
 * Admission is adaptive: FIFO when healthy, LIFO when dropping.
 * `isOverloaded()` returns true during dropping state for upstream back-pressure.
 *
 * **Probabilistic early shedding**: when ProDel is dropping and the pool is at
 * capacity, new arrivals are rejected at enqueue with P = dropRate / (dropRate +
 * completionRate) × shrinkage. Provides instant rejection for upstream callers
 * without paying queue cost.
 *
 * **Convergent throughput regulator**: regulates the concurrency limit based
 * on pluggable backpressure `Signal`s. The default signal is `LatencyDrift`
 * (Little's Law over a window, log/EWMA pipeline, Student-t trend test).
 * Pools can compose multiple signals; any triggered signal drives a decrease.
 * The regulator itself owns only the statistical heartbeat (α, ESS, df,
 * shrinkage — derived from a single `zScoreThreshold`) and the concurrency
 * actuator; signals own their per-pool observation state.
 *
 * **Admission signals** decide enqueue-time shedding (see `AdmissionSignal`).
 * The default is `EarlyShed` — probabilistic early rejection when ProDel is
 * dropping and the pool is at capacity (queue-health based, domain-agnostic).
 * `LaneErrorShed` (per-lane error shedding) is an exported opt-in. Pool-wide
 * error response is not built in; users define their own signal if they want
 * errors to drive concurrency (see `examples/express-server.ts`).
 *
 * The single constant `zScoreThreshold` controls all detection thresholds,
 * EWMA time constant, shrinkage strength, and warm-up period.
 *
 * Both increase and decrease use the same convergent step formula:
 *   step = ceil(L × (1 - e^(-depth/TIME_CONSTANT)) × stepScale)
 *
 * The step converges to L×stepScale over TIME_CONSTANT evaluations. Bisection
 * damping: each increase→retract→cooling cycle halves stepScale, so subsequent
 * cycles use finer steps — converging to within ±1 of equilibrium in O(log L)
 * cycles. stepScale resets to 1 on Restoring or Decreasing. At convergence,
 * increase doubles the limit; retraction halves it (multiplicative inverse
 * f/(1+f)); fresh decrease drives toward L_min (unscaled, full strength).
 *
 * Five regulation phases (see RegulationPhase):
 *   - Idle: at baseline, no active regulation.
 *   - Increasing: growing above baseline due to queue pressure.
 *   - Retracting: walking back previous increases in reverse order.
 *   - Decreasing: fresh decrease ramp after retraction exhausted.
 *   - Restoring: converging toward baseline via gradual convergent steps.
 *
 * **Five branches per TIME_CONSTANT evaluation** (every TIME_CONSTANT windows after warmup):
 *   1. Any configured signal triggered → decrease (retract or fresh ramp).
 *   2. Cooling (after decrease) → reset to Idle, one-eval pause.
 *   3. Queue pressure → increase (only when not in decrease sequence).
 *   4. Restoring → gradual convergent steps toward baseline.
 *   5. Idle → at baseline, depth = 0.
 *
 * Fair across lanes using round-robin scheduling. When no lane is specified,
 * each request gets its own transient lane for maximum fairness.
 */
export class Executor {
    /** Default z-score threshold (used by pools that don't override). */
    public readonly zScoreThreshold: number;
    /** Default EWMA time constant in control windows. */
    public readonly timeConstant: number;

    private readonly defaults: Parameters;
    private readonly defaultRegulatorSignals: ReadonlyArray<RegulatorSignal>;
    private readonly defaultAdmissionSignals: ReadonlyArray<AdmissionSignal>;
    private readonly logger: Logger;
    private running = false;

    private readonly pools = new Map<string, Pool>();
    private transientLaneCounter = 0;

    constructor(options?: {
        logger?: Logger;
        zScoreThreshold?: number;
        /** Default regulator (concurrency) signals for pools that do not
         *  override. Templates are cloned per pool — one instance can be
         *  safely registered with multiple executors/pools.
         *
         *  When omitted, defaults to `[new LatencyDrift()]`. */
        regulatorSignals?: RegulatorSignal[];
        /** Default admission (enqueue-shedding) signals for pools that do not
         *  override. Templates are cloned per pool.
         *
         *  When omitted, defaults to `[new EarlyShed()]`. */
        admissionSignals?: AdmissionSignal[];
    }) {
        this.logger = options?.logger ?? console;
        const z = options?.zScoreThreshold ?? DEFAULT_Z_SCORE_THRESHOLD;
        if (!Number.isFinite(z) || z <= 0) {
            throw new ArgumentError("zScoreThreshold must be a finite number > 0.");
        }
        this.defaults = Executor.deriveParameters(z);
        this.zScoreThreshold = this.defaults.zScoreThreshold;
        this.timeConstant = this.defaults.timeConstant;
        this.defaultRegulatorSignals = Object.freeze(
            (options?.regulatorSignals ?? [new LatencyDrift()]).slice()
        );
        this.defaultAdmissionSignals = Object.freeze(
            (options?.admissionSignals ?? [new EarlyShed()]).slice()
        );
    }

    /** Get parameters for a pool — pool-level override if set, else executor default. */
    private params(pool: Pool): Parameters {
        return pool.parameters ?? this.defaults;
    }

    public run<T extends Promise<unknown>>(
        pool: string,
        task: () => T,
        options?: TaskRunOptions
    ): T;

    public run<T>(pool: string, task: () => T, options?: TaskRunOptions): Promise<T>;

    /**
     * Schedules and runs a task under the given pool's admission control.
     *
     * @param pool - The registered pool name.
     * @param task - The task function to execute.
     * @param options - Lane options.
     * @returns The task's return value.
     *
     * @throws {ExecutorNotRunningError} if the executor is stopped.
     * @throws {ResourceExhaustedError} if the task is rejected by ProDel.
     */
    public async run<T>(pool: string, task: () => T, options?: TaskRunOptions): Promise<T> {
        if (!this.running) throw new ExecutorNotRunningError();
        const p = this.getPool(pool);
        if (options?.lane != null && options.lane.startsWith("_t_")) {
            throw new ArgumentError(
                `Lane names starting with "_t_" are reserved for transient lanes. Got: "${options.lane}"`
            );
        }
        const laneKey = options?.lane ?? `_t_${this.transientLaneCounter++}`;

        await this.enqueueAndWait(p, laneKey);
        return this.executeTask(p, laneKey, task);
    }

    /**
     * Registers a pool with ProDel-based admission control.
     *
     * @param name - Unique identifier for this pool (e.g. "command", "query").
     * @param options - ProDel configuration for this pool.
     */
    public registerPool(name: string, options?: PoolOptions): void {
        if (this.pools.has(name)) {
            throw new ArgumentError(`A pool with the name "${name}" already exists.`);
        }

        const delayThreshold = options?.delayThreshold ?? 100;
        const controlWindow = options?.controlWindow ?? DEFAULT_CONTROL_WINDOW;
        const minimumConcurrency = options?.minimumConcurrency ?? 1;
        const maximumConcurrency = options?.maximumConcurrency ?? Number.POSITIVE_INFINITY;
        const baselineConcurrency =
            options?.baselineConcurrency ?? Math.min(100, maximumConcurrency);

        if (!Number.isFinite(delayThreshold) || delayThreshold <= 0) {
            throw new ArgumentError("delayThreshold must be a finite number > 0.");
        }
        if (!Number.isFinite(minimumConcurrency) || minimumConcurrency < 1) {
            throw new ArgumentError("minimumConcurrency must be a finite number >= 1.");
        }
        // maximumConcurrency may be Infinity (default), but must not be NaN.
        if (Number.isNaN(maximumConcurrency) || maximumConcurrency < minimumConcurrency) {
            throw new ArgumentError("maximumConcurrency must be a number >= minimumConcurrency.");
        }
        if (
            !Number.isFinite(baselineConcurrency) ||
            baselineConcurrency < minimumConcurrency ||
            baselineConcurrency > maximumConcurrency
        ) {
            throw new ArgumentError(
                "baselineConcurrency must be a finite number between minimumConcurrency and maximumConcurrency."
            );
        }
        if (!Number.isFinite(controlWindow) || controlWindow <= 0) {
            throw new ArgumentError("controlWindow must be a finite number > 0.");
        }
        if (options?.zScoreThreshold != null && (!Number.isFinite(options.zScoreThreshold) || options.zScoreThreshold <= 0)) {
            throw new ArgumentError("zScoreThreshold must be a finite number > 0.");
        }

        const parameters = options?.zScoreThreshold != null
            ? Executor.deriveParameters(options.zScoreThreshold)
            : null;

        // Pool-level signals replace executor defaults entirely (no merge).
        // Each template is cloned to a fresh per-pool instance so state never
        // interleaves across pools. Names must be unique across BOTH lists —
        // `getSignalState` looks up by name across regulator + admission.
        const seenNames = new Set<string>();
        const regulatorSignals = Executor.cloneSignals(
            options?.regulatorSignals ?? this.defaultRegulatorSignals,
            "triggered",
            name,
            seenNames
        ) as ReadonlyArray<RegulatorSignal>;
        const admissionSignals = Executor.cloneSignals(
            options?.admissionSignals ?? this.defaultAdmissionSignals,
            "shouldShed",
            name,
            seenNames
        ) as ReadonlyArray<AdmissionSignal>;
        const lifecycleSignals = Object.freeze([...regulatorSignals, ...admissionSignals]);

        this.pools.set(name, {
            name,
            parameters,
            delayThreshold,
            baselineConcurrency,
            minimumConcurrency,
            maximumConcurrency,
            concurrencyLimit: baselineConcurrency,
            controlWindow,
            inFlight: 0,
            queueLength: 0,
            lanes: new Map(),
            laneHead: null,
            laneTail: null,
            debounceMap: new Map(),
            firstAboveTime: null,
            dropping: false,
            dropCount: 0,
            dropNext: 0,
            windowStart: performance.now(),
            completionsThisWindow: 0,
            admissionsThisWindow: 0,
            admissionRateEwma: null,
            completionRateEwma: null,
            dropsThisWindow: 0,
            dropRateEwma: null,
            elapsedWindows: 0,
            inFlightEwma: null,
            currentAlpha: 0,
            bayesianShrinkage: 0,
            // Seed Σw² at 1: a just-seeded EWMA has all weight on a single
            // observation (ESS = 1, df = 0), which makes the Cornish-Fisher
            // Student-t critical value diverge and gates every statistical
            // signal off until real evidence accumulates — the warm-up gate.
            // Starting from 0 would claim infinite effective samples (the
            // maximally overconfident prior) and arm the test at first data.
            ewmaSumW2: 1,
            regulationDepth: 0,
            regulationPhase: RegulationPhase.Idle,
            stepScale: 1,
            processQueueTimer: null,
            regulatorSignals,
            admissionSignals,
            lifecycleSignals
        });
    }

    /** Validate and clone a list of signal templates into fresh per-pool
     *  instances. `decisionMethod` is the required method name for the kind
     *  (`triggered` for regulator signals, `shouldShed` for admission). Names
     *  must be unique across the shared `seenNames` set. */
    private static cloneSignals(
        templates: ReadonlyArray<BaseSignal>,
        decisionMethod: "triggered" | "shouldShed",
        poolName: string,
        seenNames: Set<string>
    ): ReadonlyArray<BaseSignal> {
        for (const s of templates) {
            if (typeof s?.name !== "string" || s.name.length === 0) {
                throw new ArgumentError(`Signal in pool "${poolName}" must have a non-empty string \`name\`.`);
            }
            const members = s as unknown as Record<string, unknown>;
            if (typeof members[decisionMethod] !== "function") {
                throw new ArgumentError(`Signal "${s.name}" in pool "${poolName}" must implement \`${decisionMethod}\`.`);
            }
            if (typeof members.clone !== "function") {
                throw new ArgumentError(`Signal "${s.name}" in pool "${poolName}" must implement \`clone\`.`);
            }
            if (seenNames.has(s.name)) {
                throw new ArgumentError(
                    `Duplicate signal name "${s.name}" in pool "${poolName}". Each signal must have a unique name (\`getSignalState\` looks up by name).`
                );
            }
            seenNames.add(s.name);
        }
        return Object.freeze(
            templates.map((s) => {
                const cloned = (s as unknown as { clone(): BaseSignal }).clone();
                if (cloned == null || typeof cloned !== "object") {
                    throw new ArgumentError(`Signal "${s.name}".clone() must return a signal, got ${cloned}.`);
                }
                return cloned;
            })
        );
    }

    /**
     * Returns true if the pool is in ProDel dropping state (confirmed sustained
     * overload). Used for back-pressure signaling when consumers should stop
     * fetching work entirely — being at capacity is normal operation that the
     * queue handles, but dropping means the system is actively shedding load.
     */
    public isOverloaded(pool: string): boolean {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        return p.dropping;
    }

    /** Returns true if any of the pool's configured regulator signals is
     *  currently triggered. The default is `LatencyDrift` (the v1.x Student-t
     *  trend test); pools may add any custom `RegulatorSignal`. Note this
     *  reflects *concurrency* signals only, not admission shedding. */
    public isThroughputDegraded(pool: string): boolean {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        return this.anySignalTriggered(p);
    }

    /** Returns the current state snapshot of a named signal on a pool, or
     *  `undefined` if the signal is not configured on the pool or doesn't
     *  expose state. Searches both regulator and admission signals. Use this
     *  to inspect signal-specific metrics (e.g. `LatencyDrift`'s zScore,
     *  dLogWBarVarEst, tCritical; `LaneErrorShed`'s per-lane rates).
     *
     *  Pass the signal's state type as `S` to get a typed result back:
     *  `getSignalState<LatencyDriftState>(pool, "latency-drift")`. */
    public getSignalState<S = unknown>(
        pool: string,
        signalName: string
    ): S | undefined {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        const signal = p.lifecycleSignals.find((s) => s.name === signalName);
        return signal?.state?.() as S | undefined;
    }

    /** Iterate the pool's regulator signals; return true on the first
     *  triggered one. Exceptions are caught so a buggy signal cannot stall
     *  regulation. */
    private anySignalTriggered(pool: Pool): boolean {
        if (pool.regulatorSignals.length === 0) return false;
        const ctx = this.buildSignalContext(pool);
        for (const s of pool.regulatorSignals) {
            try {
                if (s.triggered(ctx)) return true;
            } catch (err) {
                this.logger.error?.(`Signal "${s.name}" threw in triggered:`, err);
            }
        }
        return false;
    }

    /** Build a frozen SignalContext snapshot for a pool. */
    private buildSignalContext(pool: Pool): SignalContext {
        const params = pool.parameters ?? this.defaults;
        const df = pool.ewmaSumW2 > 0 ? 1 / pool.ewmaSumW2 - 1 : 0;
        const regulator: RegulatorContext = Object.freeze({
            completionRateEwma: pool.completionRateEwma,
            admissionRateEwma: pool.admissionRateEwma,
            dropRateEwma: pool.dropRateEwma,
            inFlightEwma: pool.inFlightEwma,
            regulationPhase: RegulationPhase[pool.regulationPhase],
            regulationDepth: pool.regulationDepth,
            elapsedWindows: pool.elapsedWindows,
            // Statistical heartbeat — single source of truth
            zScoreThreshold: params.zScoreThreshold,
            z2: params.z2,
            timeConstant: params.timeConstant,
            controlWindow: pool.controlWindow,
            currentAlpha: pool.currentAlpha,
            bayesianShrinkage: pool.bayesianShrinkage,
            ewmaSumW2: pool.ewmaSumW2,
            df
        });
        return Object.freeze({
            pool: pool.name,
            concurrencyLimit: pool.concurrencyLimit,
            inFlight: pool.inFlight,
            queueLength: pool.queueLength,
            dropping: pool.dropping,
            regulator
        });
    }

    /** Dispatch a lifecycle hook to every signal on the pool, catching and
     *  logging any exception so a buggy signal cannot break the engine. */
    private dispatchLifecycle(
        pool: Pool,
        invoke: (signal: BaseSignal, ctx: SignalContext) => void
    ): void {
        if (pool.lifecycleSignals.length === 0) return;
        const ctx = this.buildSignalContext(pool);
        for (const s of pool.lifecycleSignals) {
            try {
                invoke(s, ctx);
            } catch (err) {
                this.logger.error?.(`Signal "${s.name}" threw in a lifecycle hook:`, err);
            }
        }
    }

    /** Returns the number of tasks waiting in the queue for a pool. */
    public getQueueLength(pool: string): number {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        return p.queueLength;
    }

    /** Returns the current number of in-flight tasks for a pool. */
    public getInFlight(pool: string): number {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        return p.inFlight;
    }

    /** Returns the current throughput-regulated concurrency limit for a pool. */
    public getConcurrencyLimit(pool: string): number {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        return p.concurrencyLimit;
    }

    /** Returns a snapshot of the pool's general-purpose regulator metrics.
     *  Signal-specific state (latency-test internals, custom signal counters)
     *  is exposed via {@link Executor.getSignalState}. */
    public getRegulatorState(pool: string): RegulatorState {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        return {
            inFlightEwma: p.inFlightEwma,
            completionRateEwma: p.completionRateEwma,
            admissionRateEwma: p.admissionRateEwma,
            dropRateEwma: p.dropRateEwma,
            regulationPhase: RegulationPhase[p.regulationPhase],
            regulationDepth: p.regulationDepth,
            elapsedWindows: p.elapsedWindows,
            overloadDetected: this.anySignalTriggered(p)
        };
    }

    /**
     * Run a task with per-pool debouncing.
     *
     * - `BeforeExecution`: deduplicate until the task is admitted to run.
     * - `BeforeResult`: deduplicate until the task finishes (success or error).
     *
     * **First caller wins.** When multiple callers share a key, only the first
     * caller's `task` function is ever executed — duplicates receive a promise
     * wired to the first call's result. To catch accidental misuse, a duplicate
     * call that passes a different `mode` or `lane` than the original throws
     * `ArgumentError`. If `mode` and `lane` match, duplicates are silently
     * merged (the expected debounce behavior).
     */
    public async runDebounced<T>(
        pool: string,
        key: string,
        task: () => Promise<T> | T,
        options?: TaskRunDebouncedOptions
    ): Promise<T> {
        if (!this.running) throw new ExecutorNotRunningError();
        const p = this.getPool(pool);
        if (options?.lane != null && options.lane.startsWith("_t_")) {
            throw new ArgumentError(
                `Lane names starting with "_t_" are reserved for transient lanes. Got: "${options.lane}"`
            );
        }
        const mode = options?.mode ?? DebounceMode.BeforeExecution;

        const existing = p.debounceMap.get(key) as DebouncedEntry<T> | undefined;
        if (existing) {
            // Detect conflicting mode/lane on duplicate call — silent divergence
            // would be a footgun (user thinks they set BeforeResult but gets
            // BeforeExecution because someone else got in first).
            if (existing.mode !== mode) {
                throw new ArgumentError(
                    `runDebounced: conflicting mode for key "${key}" — existing entry uses ${existing.mode}, new call requested ${mode}. Wait for the existing call to settle or use a different key.`
                );
            }
            if (options?.lane != null && options.lane !== existing.lane) {
                throw new ArgumentError(
                    `runDebounced: conflicting lane for key "${key}" — existing entry uses lane "${existing.lane}", new call requested "${options.lane}". Wait for the existing call to settle or use a different key.`
                );
            }
            return existing.callback.promise;
        }

        const laneKey = options?.lane ?? `_t_${this.transientLaneCounter++}`;
        const entry: DebouncedEntry<T> = {
            callback: createCallback<T>(),
            mode,
            lane: laneKey
        };
        p.debounceMap.set(key, entry as DebouncedEntry);

        setTimeout(() => {
            void (async () => {
                try {
                    if (!this.running) throw new ExecutorNotRunningError();
                    await this.enqueueAndWait(p, laneKey);

                    if (mode === DebounceMode.BeforeExecution) {
                        p.debounceMap.delete(key);
                    }

                    const result = await this.executeTask(p, laneKey, task);
                    if (mode === DebounceMode.BeforeResult) {
                        p.debounceMap.delete(key);
                    }
                    entry.callback.resolve(result);
                } catch (err) {
                    entry.callback.reject(err);
                    p.debounceMap.delete(key);
                }
            })();
        });

        return entry.callback.promise;
    }

    public start(): void {
        if (this.running) return;
        this.running = true;
    }

    public stop(): void {
        if (!this.running) return;
        this.running = false;
        for (const pool of this.pools.values()) {
            if (pool.processQueueTimer) {
                clearTimeout(pool.processQueueTimer);
                pool.processQueueTimer = null;
            }

            // Reject all queued entries so callers don't hang forever.
            // Idle lanes are torn down via removeLane so signals get their
            // onLaneRemoved notification; lanes with in-flight tasks stay
            // registered — the normal completion path removes them (and
            // notifies signals) once their last task finishes.
            for (const lane of [...pool.lanes.values()]) {
                for (const entry of lane.entries) {
                    entry.callback.reject(new ExecutorNotRunningError());
                }
                pool.queueLength -= lane.entries.length;
                lane.entries = [];
                if (lane.inFlight === 0) {
                    this.removeLane(pool, lane);
                }
            }

            // Reject debounced entries so their promises don't hang.
            for (const entry of pool.debounceMap.values()) {
                entry.callback.reject(new ExecutorNotRunningError());
            }
            pool.debounceMap.clear();
        }
    }

    private getPool(name: string): Pool {
        const pool = this.pools.get(name);
        if (!pool) throw new ArgumentError(`Pool "${name}" does not exist.`);
        return pool;
    }

    /** Append a lane to the tail of the linked list (newest). O(1). */
    private appendLane(pool: Pool, lane: Lane): void {
        lane.prev = pool.laneTail;
        lane.next = null;
        if (pool.laneTail) pool.laneTail.next = lane;
        else pool.laneHead = lane;
        pool.laneTail = lane;
    }

    /** Remove a lane from the linked list. O(1). */
    private unlinkLane(pool: Pool, lane: Lane): void {
        if (lane.prev) lane.prev.next = lane.next;
        else pool.laneHead = lane.next;
        if (lane.next) lane.next.prev = lane.prev;
        else pool.laneTail = lane.prev;
        lane.prev = null;
        lane.next = null;
    }

    /** Remove lane from both map and linked list, and notify signals so they
     *  can release per-lane state. `onLaneRemoved` takes only the lane key
     *  (teardown needs no context), keeping it cheap under transient-lane churn. */
    private removeLane(pool: Pool, lane: Lane): void {
        this.unlinkLane(pool, lane);
        pool.lanes.delete(lane.key);
        for (const s of pool.lifecycleSignals) {
            if (!s.onLaneRemoved) continue;
            try {
                s.onLaneRemoved(lane.key);
            } catch (err) {
                this.logger.error?.(`Signal "${s.name}" threw in onLaneRemoved:`, err);
            }
        }
    }

    private enqueueAndWait(pool: Pool, laneKey: string): Promise<void> {
        // Admission signals decide enqueue-time shedding. Any signal returning
        // `shouldShed === true` rejects the request immediately (counted as a
        // drop) — the default `EarlyShed` rejects arrivals likely to queue and
        // be dropped; opt-in `LaneErrorShed` fences off a failing lane.
        // Exceptions are caught so a buggy signal cannot break admission.
        if (pool.admissionSignals.length > 0) {
            const ctx = this.buildSignalContext(pool);
            for (const s of pool.admissionSignals) {
                let shed = false;
                try {
                    shed = s.shouldShed(ctx, laneKey);
                } catch (err) {
                    this.logger.error?.(`Signal "${s.name}" threw in shouldShed:`, err);
                }
                if (shed) {
                    pool.dropsThisWindow++;
                    return Promise.reject(
                        new ResourceExhaustedError(
                            `Pool "${pool.name}" shed at admission by signal "${s.name}" (lane "${laneKey}")`
                        )
                    );
                }
            }
        }

        const entry: QueueEntry = {
            callback: createCallback<void>(),
            enqueuedAt: performance.now()
        };

        let lane = pool.lanes.get(laneKey);
        if (!lane) {
            lane = {
                entries: [],
                inFlight: 0,
                key: laneKey,
                prev: null,
                next: null
            };
            pool.lanes.set(laneKey, lane);
            this.appendLane(pool, lane);
        }
        lane.entries.push(entry);
        pool.queueLength++;

        this.processQueue(pool);
        return entry.callback.promise;
    }

    /**
     * ProDel queue processing with adaptive lane traversal.
     *
     * Traversal direction adapts to health state: FIFO from head (oldest lane first)
     * when healthy — fair round-robin; LIFO from tail (newest lane first) when
     * dropping — protects fresh work while ProDel drops stale entries from older lanes.
     * Combined with per-user lanes, every user gets a fast response — either a fast
     * 200 (admitted from a recent lane) or a fast 503 (ProDel-dropped from a stale lane).
     *
     * For each lane's head entry, measures sojourn time and decides:
     *
     *   sojourn < target → admit, reset ProDel state
     *   sojourn ≥ target, not yet dropping:
     *     - Start the overload clock (firstAboveTime) on first observation.
     *     - Admit during the grace period (now < firstAboveTime).
     *     - If still above target after the full controlWindow → enter dropping state.
     *   dropping:
     *     - Evaluate all stale entries probabilistically: P = 1 - threshold/sojourn.
     *     - Admit survivors if capacity allows (LIFO — protect fresh work).
     *
     * ProDel handles queue management (load shedding) only. Concurrency regulation
     * is handled independently by the throughput monitor in executeTask.
     */
    private processQueue(pool: Pool): void {
        const target = pool.delayThreshold;
        const now = performance.now();

        // Note: at capacity + non-empty queue, this walk visits every lane
        // computing sojourn even when we can't admit. This is intentional —
        // the walk detects the grace → dropping transition, and skipping it
        // delays drop evaluation. High-tenancy pools (thousands of lanes)
        // with sustained at-capacity load will pay O(lanes) per call here.

        // Adaptive traversal: LIFO among lanes when dropping (newest first —
        // protect fresh traffic), FIFO when healthy (oldest first — fair).
        let current = pool.dropping ? pool.laneTail : pool.laneHead;

        // Track stale lanes during traversal. When this reaches 0 during
        // dropping, all lanes are healthy and we can exit dropping — no
        // redundant post-loop scan needed.
        let staleLanes = 0;

        // 1/sqrt(n) schedule: gates when a drop evaluation round fires.
        // Between rounds, processQueue still fires on completions but only
        // performs admission — no stale entry iteration, minimal overhead.
        // Mutable: set to true when entering dropping state mid-loop.
        let dropRound = pool.dropping && now >= pool.dropNext;

        while (
            current !== null &&
            (pool.dropping || pool.inFlight < pool.concurrencyLimit || pool.queueLength > 0)
        ) {
            const lane = current;
            const step = pool.dropping ? lane.prev : lane.next;

            if (lane.entries.length === 0) {
                if (lane.inFlight === 0) this.removeLane(pool, lane);
                current = step;
                continue;
            }

            const headSojourn = now - lane.entries[0].enqueuedAt;

            // ── This lane's head is fresh ──
            // Don't reset firstAboveTime or dropping here — other lanes
            // may still be stale. Pool-wide reset after the loop.
            if (headSojourn < target) {
                if (pool.inFlight < pool.concurrencyLimit) {
                    this.admit(pool, lane);
                    if (lane.entries.length === 0 && lane.inFlight === 0) {
                        this.removeLane(pool, lane);
                    }
                }
                current = step;
                continue;
            }

            // ── Sojourn ≥ target ──
            staleLanes++;

            if (!pool.dropping) {
                if (pool.firstAboveTime === null) {
                    pool.firstAboveTime = now + pool.controlWindow;
                }
                if (now < pool.firstAboveTime) {
                    // Grace period: admit if capacity allows.
                    if (pool.inFlight < pool.concurrencyLimit) {
                        this.admit(pool, lane);
                        if (lane.entries.length === 0 && lane.inFlight === 0) {
                            this.removeLane(pool, lane);
                        }
                    }
                    current = step;
                    continue;
                }
                // Sustained overload confirmed — enter dropping state.
                pool.dropping = true;
                pool.dropCount = 0;
                pool.dropNext = now;
                dropRound = true; // First round fires immediately.
                // Note: traversal direction stays FIFO for the rest of this
                // invocation (captured at loop entry). Next processQueue call
                // will use LIFO direction. One iteration's worth of direction
                // mismatch is harmless — admission still respects capacity,
                // and ProDel drops apply regardless of lane visit order.
                this.logger.warn("Queue shedding stale entries — tasks waited too long", {
                    pool: pool.name,
                    sojournMs: Math.round(headSojourn),
                    thresholdMs: Math.round(target),
                    queueLength: pool.queueLength,
                    inFlight: pool.inFlight,
                    concurrencyLimit: pool.concurrencyLimit
                });
            }

            // ── Dropping: between rounds → admit only ──
            if (!dropRound) {
                if (pool.inFlight < pool.concurrencyLimit) {
                    this.admit(pool, lane);
                    if (lane.entries.length === 0 && lane.inFlight === 0) {
                        this.removeLane(pool, lane);
                    }
                }
                // Correct staleLanes if admission drained the lane or
                // left only fresh entries at the head.
                if (lane.entries.length === 0 || now - lane.entries[0].enqueuedAt < target) {
                    staleLanes--;
                }
                current = step;
                continue;
            }

            // ── Dropping: drop round → iterate all stale entries ──
            // Each entry gets one probabilistic check per round.
            // P = 1 - threshold/sojourn: head (oldest) has highest P.
            // No confidence scaling — sojourn is an exact measurement
            // (timestamp difference), not an estimated ratio.
            // Stop at the first fresh entry (remaining are fresher).
            let i = 0;
            while (i < lane.entries.length) {
                const entry = lane.entries[i];
                const sojourn = now - entry.enqueuedAt;
                if (sojourn < target) break;

                if (Math.random() < 1 - target / sojourn) {
                    lane.entries.splice(i, 1);
                    pool.queueLength--;
                    pool.dropCount++;
                    pool.dropsThisWindow++;
                    entry.callback.reject(
                        new ResourceExhaustedError(
                            `Pool "${pool.name}" is overloaded (sojourn: ${Math.round(sojourn)}ms, target: ${Math.round(target)}ms)`
                        )
                    );
                } else {
                    i++;
                }
            }

            // After drops, admit from tail (LIFO) if capacity allows.
            while (pool.inFlight < pool.concurrencyLimit && lane.entries.length > 0) {
                this.admit(pool, lane);
            }
            if (lane.entries.length === 0 && lane.inFlight === 0) {
                this.removeLane(pool, lane);
            }

            // Correct staleLanes if this lane is no longer stale after
            // drops and admissions (all stale entries shed, or lane drained).
            if (lane.entries.length === 0 || now - lane.entries[0].enqueuedAt < target) {
                staleLanes--;
            }

            current = step;
        }

        // Advance drop schedule after the round completes (all lanes processed).
        if (dropRound && pool.dropping) {
            pool.dropNext = now + pool.controlWindow / Math.sqrt(Math.max(1, pool.dropCount));
        }

        // Pool-wide state reset: only when NO lane has stale entries.
        if (staleLanes === 0) {
            pool.firstAboveTime = null;
            if (pool.dropping) {
                this.logger.info("Queue recovered — no stale entries remain", {
                    pool: pool.name,
                    entriesDropped: pool.dropCount,
                    queueLength: pool.queueLength,
                    inFlight: pool.inFlight
                });
                pool.dropping = false;
            }
        }

        // Schedule re-evaluation for queued entries waiting for slots.
        if (pool.queueLength > 0) {
            this.scheduleProcessQueue(pool);
        }
    }

    /**
     * Schedule a deferred processQueue call so ProDel can re-evaluate queued entries
     * whose sojourn time will have grown.
     */
    private scheduleProcessQueue(pool: Pool): void {
        if (pool.processQueueTimer) return;
        pool.processQueueTimer = setTimeout(() => {
            pool.processQueueTimer = null;
            if (pool.queueLength > 0) {
                this.processQueue(pool);
            }
        }, pool.controlWindow);
    }

    /** Adaptive admit: LIFO (newest first) when dropping, FIFO (oldest first) when healthy. */
    private admit(pool: Pool, lane: Lane): void {
        const entry = (pool.dropping ? lane.entries.pop() : lane.entries.shift())!;
        pool.queueLength--;
        const now = performance.now();
        // CONTRACT: signal `onAdmit` hooks MUST fire *after* `pool.inFlight++`.
        // LatencyDrift derives the pre-change count as `ctx.inFlight − 1`.
        pool.inFlight++;
        lane.inFlight++;
        pool.admissionsThisWindow++;

        // Notify signals after the inFlight count is updated. Exceptions
        // from a buggy user signal must not corrupt admission state.
        const info: AdmitInfo = { lane: lane.key, admitTime: now };
        this.dispatchLifecycle(pool, (s, ctx) => s.onAdmit?.(ctx, info));

        // If stop() is called between here and the scheduled callback firing,
        // reject with ExecutorNotRunningError rather than silently dropping the
        // promise — and undo the admission bookkeeping, since the task will
        // never run and inFlight is only ever decremented in executeTask's
        // finally. Without the undo, the pool permanently loses a concurrency
        // slot across stop()/start(), and signals integrate a phantom task.
        this.schedule(() => {
            if (this.running) {
                entry.callback.resolve();
                return;
            }
            pool.inFlight--;
            lane.inFlight--;
            if (
                lane.entries.length === 0 &&
                lane.inFlight === 0 &&
                pool.lanes.get(lane.key) === lane
            ) {
                this.removeLane(pool, lane);
            }
            entry.callback.reject(new ExecutorNotRunningError());
        });
    }

    /**
     * Updates throughput statistics and applies convergent throughput regulation.
     *
     * **Per-window:** EWMA updates for completion rate, inFlight, W, dW.
     *
     * **Per-TIME_CONSTANT:** concurrency adjustment based on degradation signals.
     * Both increase and decrease use the same convergent formula:
     *   step = ceil(L × (1 - e^(-depth/TIME_CONSTANT)))
     * converging to L over TIME_CONSTANT evaluations. Severity is encoded through
     * persistence: sustained degradation increments depth each TIME_CONSTANT period,
     * producing ever-larger steps naturally.
     *
     * **Regulation phases:**
     *   Idle       → at baseline, depth = 0, no active regulation
     *   Increasing → depth increments: step(1), step(2), ..., step(n)
     *   Retracting → depth decrements: step(n), step(n-1), ..., step(1)
     *                (mirrors prior growth in reverse to undo it)
     *   Decreasing → depth increments: step(1), step(2), ..., step(n)
     *                (fresh ramp after retraction exhausted or no prior growth)
     *   Restoring  → depth increments, converges toward baseline from either
     *                direction using the same convergent step formula
     *
     * Flip from Increasing → Retracting: start at current depth, walk back.
     * Flip from Retracting/Decreasing → Idle: one-eval cooling pause.
     *
     * **Bayesian shrinkage (source-side):**
     * All EWMA updates use n/(n+z²) shrinkage where n = observations per
     * window and z² = zScoreThreshold². The prior (current EWMA) is worth
     * z² = 4 pseudo-observations. At low throughput, the shrinkage dampens
     * updates from sparse windows. Detection uses a uniform σ × SE threshold.
     *
     * **Five branches per TIME_CONSTANT evaluation:**
     *   1. any signal triggered → decrease (retract or fresh ramp)
     *   2. cooling (Retracting/Decreasing → Idle) → one-eval pause
     *   3. queue pressure → increase (only when not in decrease sequence)
     *   4. restoring → gradual convergent steps toward baseline
     *   5. idle → at baseline, depth = 0
     *
     * **Completion-driven.** This function is only invoked from `executeTask`'s
     * `finally` block. A pool whose tasks are all stuck (no completions) will
     * not advance its window state, which means:
     *   - `elapsedWindows` does not increment.
     *   - EWMAs (completion rate, drop rate, sumW2) do not decay.
     *   - Each signal's cached `triggered()` reflects its last-computed state.
     *   - The regulator cannot decrease concurrency on a stuck pool.
     * This is the intended behavior — without data, there's no signal to
     * regulate on — but callers relying on `isThroughputDegraded` for
     * backpressure should be aware it won't flip while the pool is fully
     * stuck. ProDel continues to drop stale queued entries via a separate
     * timer (`scheduleProcessQueue`).
     */
    private evaluateControlWindow(pool: Pool): void {
        const now = performance.now();

        // ── Window evaluation ──
        const elapsed = now - pool.windowStart;
        if (elapsed < pool.controlWindow) return;

        const rate = pool.completionsThisWindow;
        const { timeConstant, z2 } = this.params(pool);

        // ── Heartbeat: compute the statistical framework's pulse ──
        // Single source of truth for the control loop's parameters. Signals
        // read these via ctx.regulator — no signal-local α or shrinkage.
        const alpha = Statistics.timeWeightedAlpha(elapsed, timeConstant, pool.controlWindow);
        const windowShrinkage = Statistics.bayesianShrinkage(pool.completionsThisWindow, z2);

        // Effective sample size: exact Σw² recursion under time-varying α.
        pool.ewmaSumW2 = (1 - alpha) * (1 - alpha) * pool.ewmaSumW2 + alpha * alpha;
        pool.currentAlpha = alpha;
        // Hold the last non-zero shrinkage across empty windows so signals
        // reading `ctx.regulator.bayesianShrinkage` mid-window (e.g. from an
        // onComplete hook) don't see a transient 0 that would silently
        // disable any input multiplied by it.
        if (pool.completionsThisWindow > 0) {
            pool.bayesianShrinkage = windowShrinkage;
        }

        const countAlpha = alpha * windowShrinkage;

        // Update completion rate EWMA.
        if (pool.completionRateEwma === null) {
            pool.completionRateEwma = rate;
        } else {
            pool.completionRateEwma = (1 - countAlpha) * pool.completionRateEwma + countAlpha * rate;
        }

        // Update admission rate EWMA.
        const admissions = pool.admissionsThisWindow;
        if (pool.admissionRateEwma === null) {
            pool.admissionRateEwma = admissions;
        } else {
            pool.admissionRateEwma = (1 - alpha) * pool.admissionRateEwma + alpha * admissions;
        }

        // Update drop rate EWMA (for probabilistic early shedding).
        const drops = pool.dropsThisWindow;
        if (pool.dropRateEwma === null) {
            pool.dropRateEwma = drops;
        } else {
            pool.dropRateEwma = (1 - countAlpha) * pool.dropRateEwma + countAlpha * drops;
        }
        pool.dropsThisWindow = 0;

        pool.elapsedWindows++;

        // Update in-flight count EWMA (observability).
        pool.inFlightEwma =
            pool.inFlightEwma === null
                ? pool.inFlight
                : (1 - alpha) * pool.inFlightEwma + alpha * pool.inFlight;

        // ── Notify signals at window boundary ──
        // Each signal updates its own derived state (e.g., LatencyDrift's
        // operational-LL integral, log/EWMA/dLogW/δ²/SE pipeline).
        const evalInfo: EvaluateInfo = {
            windowStart: pool.windowStart,
            windowEnd: now,
            elapsed,
            completions: pool.completionsThisWindow,
            admissions
        };
        this.dispatchLifecycle(pool, (s, ctx) => s.onEvaluate?.(ctx, evalInfo));

        // ── Periodic convergent throughput regulation + gravity ──
        // Fires every TIME_CONSTANT windows so signals have time (~63%
        // absorption) to reflect the previous adjustment before the next
        // decision. Phase transitions: Increasing→Retracting (walk back
        // growth), Retracting→Decreasing (fresh ramp), any→Idle (cooling).
        if (pool.elapsedWindows > 0 && pool.elapsedWindows % timeConstant === 0) {
            if (this.anySignalTriggered(pool)) {
                // A backpressure signal fired — decrease.
                this.applyDecrease(pool);
            } else if (
                pool.regulationPhase === RegulationPhase.Retracting ||
                pool.regulationPhase === RegulationPhase.Decreasing
            ) {
                // Cooling: one TIME_CONSTANT eval pause after a decrease sequence
                // before allowing increases. Bisection: halve stepScale so the
                // next increase cycle uses finer steps.
                pool.regulationPhase = RegulationPhase.Idle;
                pool.regulationDepth = 0;
                pool.stepScale = Math.max(pool.stepScale * 0.5, 1 / pool.concurrencyLimit);
            } else if (pool.queueLength > 0) {
                // Queue pressure: increase to meet demand.
                this.applyIncrease(pool);
            } else if (pool.concurrencyLimit !== pool.baselineConcurrency) {
                // Restoring: converge toward baseline from either direction.
                // Uses convergent steps — small initially, growing with depth.
                // Below baseline: cautious probe upward (latency signal can
                // react before overshoot). Above baseline: shed excess capacity.
                if (pool.regulationPhase !== RegulationPhase.Restoring) {
                    pool.regulationDepth = 0;
                    pool.stepScale = 1;
                }
                pool.regulationPhase = RegulationPhase.Restoring;
                pool.regulationDepth++;
                const step = Math.max(
                    1,
                    Math.ceil(
                        pool.concurrencyLimit *
                            (1 - Math.exp(-pool.regulationDepth / timeConstant))
                    )
                );
                if (pool.concurrencyLimit < pool.baselineConcurrency) {
                    pool.concurrencyLimit = Math.min(
                        pool.baselineConcurrency,
                        pool.concurrencyLimit + step
                    );
                } else {
                    pool.concurrencyLimit = Math.max(
                        pool.baselineConcurrency,
                        pool.concurrencyLimit - step
                    );
                }
            } else {
                // At baseline, no queue, no degradation, no errors — idle.
                pool.regulationDepth = 0;
                pool.regulationPhase = RegulationPhase.Idle;
            }
        }

        // Reset window.
        pool.completionsThisWindow = 0;
        pool.admissionsThisWindow = 0;
        pool.windowStart = now;
    }

    private async executeTask<T>(pool: Pool, laneKey: string, task: () => T): Promise<T> {
        // Capture admit time at task entry so signals can compute service time.
        // This is a tiny offset (~1 microqueue tick) from the actual admit() call.
        const admitTime = performance.now();
        let errored = false;
        try {
            return await task();
        } catch (err) {
            errored = true;
            throw err;
        } finally {
            pool.completionsThisWindow++;

            const completionNow = performance.now();
            // CONTRACT: signal `onComplete` hooks MUST fire *after* `pool.inFlight--`.
            // LatencyDrift derives the pre-change count as `ctx.inFlight + 1`.
            pool.inFlight--;

            // Notify signals after the inFlight count is decremented. A
            // throwing user signal must not replace the task's own result —
            // this runs inside the caller's `finally`, so any uncaught throw
            // would overwrite both the resolution and the error path.
            // `dispatchLifecycle` catches per-signal exceptions.
            const info: CompletionInfo = {
                lane: laneKey,
                admitTime,
                completionTime: completionNow,
                serviceTime: completionNow - admitTime,
                errored
            };
            this.dispatchLifecycle(pool, (s, ctx) => s.onComplete?.(ctx, info));

            const lane = pool.lanes.get(laneKey);
            if (lane) {
                lane.inFlight--;
                if (lane.entries.length === 0 && lane.inFlight === 0) {
                    this.removeLane(pool, lane);
                }
            }

            this.evaluateControlWindow(pool);
            this.processQueue(pool);
        }
    }

    // Note: tScore and isLatencyDegrading have been moved into the
    // LatencyDrift signal class (see src/signals.ts). The executor no
    // longer implements detection logic — signals own their state.

    /**
     * Convergent decrease: retract previous growth first, then fresh ramp.
     * Phase transitions: Increasing→Retracting (walk back), Retracting→Decreasing
     * (fresh ramp when growth fully unwound).
     */
    private applyDecrease(pool: Pool): void {
        let stepIndex: number;
        let retraction = false;
        if (pool.regulationPhase === RegulationPhase.Increasing && pool.regulationDepth > 0) {
            // Flip: start retracting the growth in reverse.
            pool.regulationPhase = RegulationPhase.Retracting;
            stepIndex = pool.regulationDepth;
            pool.regulationDepth--;
            retraction = true;
        } else if (
            pool.regulationPhase === RegulationPhase.Retracting &&
            pool.regulationDepth > 0
        ) {
            // Continue retracting: step(n-1), step(n-2), ...
            stepIndex = pool.regulationDepth;
            pool.regulationDepth--;
            retraction = true;
        } else {
            // Growth fully unwound (or none existed).
            // Fresh decrease ramp: step(1), step(2), ... Full strength —
            // reset stepScale so genuine degradation gets full-strength response.
            pool.regulationPhase = RegulationPhase.Decreasing;
            pool.stepScale = 1;
            pool.regulationDepth++;
            stepIndex = pool.regulationDepth;
        }
        const f = 1 - Math.exp(-stepIndex / this.params(pool).timeConstant);
        // Retraction uses f/(1+f) — the multiplicative inverse of increase.
        // If increase multiplied L by (1+f×s), retraction divides by (1+f×s).
        // stepScale provides bisection damping: each increase→retract cycle
        // halves the scale, converging to equilibrium in O(log L) cycles.
        // Fresh decrease uses unscaled f for aggressive correction.
        const sf = retraction ? f * pool.stepScale : f;
        const step = Math.max(
            1,
            Math.ceil(pool.concurrencyLimit * (retraction ? sf / (1 + sf) : sf))
        );
        pool.concurrencyLimit = Math.max(pool.minimumConcurrency, pool.concurrencyLimit - step);
    }

    /** Convergent increase: queue pressure with stable latency. */
    private applyIncrease(pool: Pool): void {
        if (
            pool.regulationPhase !== RegulationPhase.Increasing &&
            pool.regulationPhase !== RegulationPhase.Restoring
        ) {
            // Was idle/retracting/decreasing — start fresh growth.
            pool.regulationDepth = 0;
        }
        pool.regulationPhase = RegulationPhase.Increasing;
        pool.regulationDepth++;
        const f = 1 - Math.exp(-pool.regulationDepth / this.params(pool).timeConstant);
        const step = Math.max(1, Math.ceil(pool.concurrencyLimit * f * pool.stepScale));
        pool.concurrencyLimit = Math.min(pool.maximumConcurrency, pool.concurrencyLimit + step);
    }

    /** Yield to the event loop between admitted tasks so CPU-bound work doesn't block I/O. */
    private schedule(fn: () => void): void {
        const g = globalThis as Record<string, unknown>;
        typeof g.setImmediate === "function" ? (g.setImmediate as (fn: () => void) => void)(fn) : queueMicrotask(fn);
    }

    /** Derive all statistical parameters from a single z-score threshold. */
    private static deriveParameters(zScoreThreshold: number): Parameters {
        const z2 = zScoreThreshold * zScoreThreshold;
        const timeConstant = Math.round(2 / (1 - Math.exp(-1 / z2)));
        return { zScoreThreshold, timeConstant, z2 };
    }
}
