import type { Logger } from "./logger.js";
import { ArgumentError, ResourceExhaustedError, ExecutorNotRunningError } from "./errors.js";
import { type Callback, createCallback } from "./callback.js";

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
    /** Per-lane error rate EWMA — updated on each completion. */
    errorRateEwma: number;
    /** Timestamp of last completion — for time-weighted lane alpha. */
    lastCompletionTime: number;
    /** Cumulative completions — for confidence scaling of error rate EWMA. */
    completions: number;
};

type DebouncedEntry<T = unknown> = {
    callback: Callback<T>;
    mode: DebounceMode;
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

    // Operational Little's Law integral: ∫N(t)dt (Kim & Whitt, 2013).
    // Accumulated every time inFlight changes. W = ∫N(t)dt / C.
    inFlightMs: number;
    lastInFlightChangeTime: number;

    // Throughput monitor state (capacity regulation)
    windowStart: number;
    completionsThisWindow: number;
    completionRateEwma: number | null;
    dropsThisWindow: number;
    dropRateEwma: number | null;
    elapsedWindows: number;

    // Error tracking (downstream health) — pool-wide error rate is tracked
    // for observability. Per-lane shedding handles error response; pool-wide
    // concurrency regulation is driven solely by latency.
    errorsThisWindow: number;
    errorRateEwma: number | null;

    // Last computed EWMA alpha — stored so query methods can use the
    // same time-weighted alpha as the control loop.
    alpha: number;

    // Latency detection: EWMA on log(W) + trend z-test.
    // W = ∫N(t)dt / C (operational Little's Law). Shrinkage-dampened
    // EWMA smooths log(W). Z-test on trend detects degradation.
    inFlightEwma: number | null;
    lastLogW: number | null; // Raw log(W) from the last completed window
    logWBar: number | null; // EWMA-filtered log(W) level
    dLogWBarEwma: number | null; // EWMA of dLogWBar rate (trend per window)
    dLogWBarSM: number; // Second moment of dLogWBar rate (EWMA of x²)
    ewmaSumW2: number; // Sum of squared EWMA weights (effective sample size)

    // Convergent throughput regulator state
    regulationDepth: number;
    regulationPhase: RegulationPhase;
    /** Bisection damping: halves on each increase→retract→cooling cycle.
     *  Allows convergence to within ±1 of true equilibrium. */
    stepScale: number;

    // Deferred re-evaluation timer
    processQueueTimer: ReturnType<typeof setTimeout> | null;
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
};

export type RegulatorState = {
    /** Raw log(W) from the most recent window (before EWMA smoothing). */
    logW: number | null;
    /** EWMA-filtered log(W) level (shrinkage-dampened). */
    logWBar: number | null;
    /** EWMA of dLogWBar rate (trend signal per window). */
    dLogWBarEwma: number | null;
    /** Second moment of dLogWBar rate (EWMA of x²) — variance estimate under H0. */
    dLogWBarSM: number;
    /** Sum of squared EWMA weights — effective sample size for time-varying alpha. */
    ewmaSumW2: number;
    /** Standard error: sqrt(dLogWBarSM × ewmaSumW2). */
    se: number;
    /** Current z-score: dLogWBarEwma / SE. Degrading when > zScoreThreshold. */
    zScore: number;
    /** Whether the z-test currently detects latency degradation. */
    degrading: boolean;
    /** EWMA of in-flight count. */
    inFlightEwma: number | null;
    /** EWMA of completion rate (completions per window). */
    completionRateEwma: number | null;
    /** EWMA of drop rate (drops per window). */
    dropRateEwma: number | null;
    /** EWMA of error ratio (errors / completions). */
    errorRateEwma: number | null;
    /** Current regulation phase. */
    regulationPhase: string;
    /** Current regulation depth. */
    regulationDepth: number;
    /** Number of elapsed control windows. */
    elapsedWindows: number;
    /** Last computed EWMA alpha. */
    alpha: number;
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
 * Three independent mechanisms cooperate:
 *
 * **ProDel** (Probabilistic Delay Load-shedding): manages queue health using
 * sojourn-proportional probabilistic load shedding. Each stale entry
 * (sojourn > threshold) is dropped with probability P = 1 - threshold/sojourn.
 * Admission is adaptive: FIFO when healthy, LIFO when dropping.
 * `isOverloaded()` returns true during dropping state for upstream back-pressure.
 *
 * **Convergent throughput regulator**: regulates the concurrency limit using
 * shrinkage-dampened EWMA on log-latency as the degradation signal. W = ∫N(t)dt / C
 * per window (finite-interval Little's Law). A shrinkage-dampened EWMA smooths
 * log(W), with throughput-aware dampening at low observation counts. The z-test
 * on dLogWBar (change in filtered log-latency) detects sustained latency trends.
 * Systemic errors are handled by probabilistic decrease (P = errorRateEwma) in
 * the gravity branch.
 *
 * **Per-lane error shedding**: each lane tracks its own error rate EWMA.
 * Lanes with high error rates probabilistically reject new requests at enqueue,
 * preventing wasted work on failing resources without affecting other lanes.
 * Per-lane shedding keeps aggregate error rates low for localized failures,
 * so the probabilistic error decrease only fires for systemic issues.
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
 * **Six branches per TIME_CONSTANT evaluation** (every TIME_CONSTANT windows after warmup):
 *   1. Latency degrading → decrease (retract or fresh ramp).
 *   2. Cooling (after decrease) → reset to Idle, one-eval pause.
 *   3. Queue pressure → increase (only when not in decrease sequence).
 *   4. Probabilistic error decrease → P = errorRateEwma.
 *   5. Restoring → gradual convergent steps toward baseline.
 *   6. Idle → at baseline, depth = 0.
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
    private readonly logger: Logger;
    private running = false;

    private readonly pools = new Map<string, Pool>();
    private transientLaneCounter = 0;

    constructor(options?: { logger?: Logger; zScoreThreshold?: number }) {
        this.logger = options?.logger ?? console;
        const z = options?.zScoreThreshold ?? DEFAULT_Z_SCORE_THRESHOLD;
        if (!Number.isFinite(z) || z <= 0) {
            throw new ArgumentError("zScoreThreshold must be a finite number > 0.");
        }
        this.defaults = Executor.deriveParameters(z);
        this.zScoreThreshold = this.defaults.zScoreThreshold;
        this.timeConstant = this.defaults.timeConstant;
    }

    /** Derive all statistical parameters from a single z-score threshold. */
    private static deriveParameters(zScoreThreshold: number): Parameters {
        const z2 = zScoreThreshold * zScoreThreshold;
        const timeConstant = Math.round(2 / (1 - Math.exp(-1 / z2)));
        return { zScoreThreshold, timeConstant, z2 };
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
        if (maximumConcurrency < minimumConcurrency) {
            throw new ArgumentError("maximumConcurrency must be >= minimumConcurrency.");
        }
        if (baselineConcurrency < minimumConcurrency || baselineConcurrency > maximumConcurrency) {
            throw new ArgumentError(
                "baselineConcurrency must be between minimumConcurrency and maximumConcurrency."
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
        const zc = parameters ?? this.defaults;

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
            inFlightMs: 0,
            lastInFlightChangeTime: performance.now(),
            windowStart: performance.now(),
            completionsThisWindow: 0,
            completionRateEwma: null,
            dropsThisWindow: 0,
            dropRateEwma: null,
            elapsedWindows: 0,
            errorsThisWindow: 0,
            errorRateEwma: null,
            alpha: 1 - Math.exp(-1 / zc.timeConstant),
            inFlightEwma: null,
            lastLogW: null,
            logWBar: null,
            dLogWBarEwma: null,
            dLogWBarSM: 0,
            ewmaSumW2: 0,
            regulationDepth: 0,
            regulationPhase: RegulationPhase.Idle,
            stepScale: 1,
            processQueueTimer: null
        });
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

    /** Returns whether throughput is degraded (latency worsening).
     *  Only meaningful after TIME_CONSTANT windows. */
    public isThroughputDegraded(pool: string): boolean {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);
        if (p.elapsedWindows < this.params(p).timeConstant) return false;
        return this.isLatencyDegrading(p);
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

    /** Returns a snapshot of the regulator's internal filter state for debugging
     *  and visualization. Includes raw and filtered latency signals, z-test
     *  components, EWMAs, and regulation phase. */
    public getRegulatorState(pool: string): RegulatorState {
        const p = this.pools.get(pool);
        if (!p) throw new ArgumentError(`Pool "${pool}" does not exist.`);

        let se = 0;
        let zScore = 0;
        if (p.dLogWBarEwma !== null && p.dLogWBarSM > 0) {
            se = Math.sqrt(p.dLogWBarSM * p.ewmaSumW2);
            zScore = se > 0 ? p.dLogWBarEwma / se : 0;
        }

        return {
            logW: p.lastLogW,
            logWBar: p.logWBar,
            dLogWBarEwma: p.dLogWBarEwma,
            dLogWBarSM: p.dLogWBarSM,
            ewmaSumW2: p.ewmaSumW2,
            se,
            zScore,
            degrading: this.isLatencyDegrading(p),
            inFlightEwma: p.inFlightEwma,
            completionRateEwma: p.completionRateEwma,
            dropRateEwma: p.dropRateEwma,
            errorRateEwma: p.errorRateEwma,
            regulationPhase: RegulationPhase[p.regulationPhase],
            regulationDepth: p.regulationDepth,
            elapsedWindows: p.elapsedWindows,
            alpha: p.alpha
        };
    }

    /**
     * Run a task with per-pool debouncing.
     *
     * - `BeforeExecution`: deduplicate until the task is admitted to run.
     * - `BeforeResult`: deduplicate until the task finishes (success or error).
     */
    public async runDebounced<T>(
        pool: string,
        key: string,
        task: () => Promise<T> | T,
        options?: TaskRunDebouncedOptions
    ): Promise<T> {
        if (!this.running) throw new ExecutorNotRunningError();
        const p = this.getPool(pool);
        const laneKey = options?.lane ?? `_t_${this.transientLaneCounter++}`;
        const mode = options?.mode ?? DebounceMode.BeforeExecution;

        const existing = p.debounceMap.get(key) as DebouncedEntry<T> | undefined;
        if (existing) {
            return existing.callback.promise;
        }

        const entry: DebouncedEntry<T> = {
            callback: createCallback<T>(),
            mode
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
            for (const lane of pool.lanes.values()) {
                for (const entry of lane.entries) {
                    entry.callback.reject(new ExecutorNotRunningError());
                }
                lane.entries = [];
            }
            pool.lanes.clear();
            pool.laneHead = null;
            pool.laneTail = null;
            pool.queueLength = 0;

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

    /** Remove lane from both map and linked list. */
    private removeLane(pool: Pool, lane: Lane): void {
        this.unlinkLane(pool, lane);
        pool.lanes.delete(lane.key);
    }

    private enqueueAndWait(pool: Pool, laneKey: string): Promise<void> {
        // Probabilistic early shedding: when ProDel is actively dropping and
        // the pool is at capacity, new arrivals are likely doomed to queue and
        // be dropped. Reject early with P = shrinkage × dropRate / (dropRate +
        // completionRate) so they get an instant 503 instead of waiting in
        // queue. Only at capacity — if there's room to admit, let the request
        // through.
        if (
            pool.dropping &&
            pool.inFlight >= pool.concurrencyLimit &&
            pool.dropRateEwma !== null &&
            pool.dropRateEwma > 0 &&
            pool.completionRateEwma !== null &&
            pool.completionRateEwma > 0
        ) {
            // Bayesian shrinkage dampens the probability at low throughput
            // where the drop/completion rate EWMAs are based on few observations.
            const P =
                (pool.dropRateEwma / (pool.dropRateEwma + pool.completionRateEwma)) *
                this.shrinkage(pool.completionRateEwma, this.params(pool).z2);
            if (Math.random() < P) {
                pool.dropsThisWindow++;
                return Promise.reject(
                    new ResourceExhaustedError(
                        `Pool "${pool.name}" is overloaded (early shed, P=${P.toFixed(2)})`
                    )
                );
            }
        }

        // Per-lane error shedding: if this lane has been failing recently,
        // probabilistically shed to avoid wasting a slot on a likely failure.
        // Only applies to persistent lanes (transient lanes have no history).
        const existingLane = pool.lanes.get(laneKey);
        if (
            existingLane &&
            existingLane.errorRateEwma > 0 &&
            Math.random() < existingLane.errorRateEwma
        ) {
            return Promise.reject(
                new ResourceExhaustedError(
                    `Pool "${pool.name}" lane "${laneKey}" is failing (error rate: ${(existingLane.errorRateEwma * 100).toFixed(0)}%)`
                )
            );
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
                next: null,
                errorRateEwma: 0,
                lastCompletionTime: performance.now(),
                completions: 0
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
        pool.inFlightMs += pool.inFlight * (now - pool.lastInFlightChangeTime);
        pool.lastInFlightChangeTime = now;
        pool.inFlight++;
        lane.inFlight++;
        entry.callback.resolve();
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
     * **Six branches per TIME_CONSTANT evaluation:**
     *   1. latency degrading → decrease (retract or fresh ramp)
     *   2. cooling (Retracting/Decreasing → Idle) → one-eval pause
     *   3. queue pressure → increase (only when not in decrease sequence)
     *   4. probabilistic error decrease (P = errorRateEwma)
     *   5. restoring → gradual convergent steps toward baseline
     *   6. idle → at baseline, depth = 0
     */
    private evaluateControlWindow(pool: Pool): void {
        const now = performance.now();

        // ── Window evaluation ──
        const elapsed = now - pool.windowStart;
        if (elapsed < pool.controlWindow) return;

        const rate = pool.completionsThisWindow;
        const { timeConstant, z2 } = this.params(pool);

        // Time-weighted EWMA: alpha derived from elapsed time.
        const alpha = 1 - Math.exp(-elapsed / (timeConstant * pool.controlWindow));
        pool.alpha = alpha;

        // Bayesian shrinkage: n/(n+z²) weights the observation against a prior
        // of strength z² = 4 pseudo-observations. At n=1: 20% weight (sparse
        // window, mostly trust the prior). At n=10: 71%. At n=100: 96%.
        const windowShrinkage = this.shrinkage(pool.completionsThisWindow, z2);
        const countAlpha = alpha * windowShrinkage;

        // Update completion rate EWMA.
        if (pool.completionRateEwma === null) {
            pool.completionRateEwma = rate;
        } else {
            pool.completionRateEwma = (1 - countAlpha) * pool.completionRateEwma + countAlpha * rate;
        }

        // Update drop rate EWMA (for probabilistic early shedding).
        const drops = pool.dropsThisWindow;
        if (pool.dropRateEwma === null) {
            pool.dropRateEwma = drops;
        } else {
            pool.dropRateEwma = (1 - countAlpha) * pool.dropRateEwma + countAlpha * drops;
        }
        pool.dropsThisWindow = 0;

        // Update error rate EWMA (errors/completions) and its rate of change.
        // Error rate EWMA — tracked for observability / per-lane context only.
        // Pool-wide concurrency regulation is driven solely by latency;
        // per-lane shedding handles error response independently.
        if (pool.completionsThisWindow > 0) {
            const instantErrorRate = pool.errorsThisWindow / pool.completionsThisWindow;
            const errorAlpha = alpha * windowShrinkage;

            if (pool.errorRateEwma === null) {
                pool.errorRateEwma = instantErrorRate;
            } else {
                pool.errorRateEwma = (1 - errorAlpha) * pool.errorRateEwma + errorAlpha * instantErrorRate;
            }
        }

        pool.errorsThisWindow = 0;
        pool.elapsedWindows++;

        // ── Little's Law latency trend ──
        pool.inFlightEwma =
            pool.inFlightEwma === null
                ? pool.inFlight
                : (1 - alpha) * pool.inFlightEwma + alpha * pool.inFlight;

        // ── Pure finite-interval Little's Law: W = ∫N(t)dt / C ──
        // Exact operational Little's Law (Kim & Whitt, 2013).
        const evalNow = performance.now();
        pool.inFlightMs += pool.inFlight * (evalNow - pool.lastInFlightChangeTime);
        pool.lastInFlightChangeTime = evalNow;

        if (pool.completionsThisWindow > 0 && pool.inFlightMs > 0) {
            const instantW = pool.inFlightMs / pool.completionsThisWindow;
            const logInstantW = Math.log(instantW);
            pool.lastLogW = logInstantW;

            // ── Shrinkage-dampened EWMA on log(W) ──
            // Smooths log-latency with throughput-aware dampening.
            // At low throughput, shrinkage reduces the update weight
            // (fewer completions → noisier W → trust prior more).
            const shrinkageFactor = this.shrinkage(pool.completionsThisWindow, z2);

            if (pool.logWBar === null) {
                pool.logWBar = logInstantW;
            } else {
                const previousState = pool.logWBar;
                const levelAlpha = alpha * shrinkageFactor;
                pool.logWBar = (1 - levelAlpha) * pool.logWBar + levelAlpha * logInstantW;

                // dLogWBar = change in filtered state, normalized by dt.
                // The EWMA decorrelates consecutive derivatives (vs raw
                // differencing which has ρ = -0.5 autocorrelation).
                const dt = elapsed / pool.controlWindow;
                const dLogWBarRate = (pool.logWBar - previousState) / dt;
                if (pool.dLogWBarEwma === null) {
                    pool.dLogWBarEwma = dLogWBarRate * shrinkageFactor;
                    pool.ewmaSumW2 = 1; // first observation has weight 1
                } else {
                    // Shrink the derivative before feeding it into the trend
                    // EWMA, but let the second moment see the raw value.
                    // This intentionally breaks the shrinkage cancellation:
                    // at low throughput, the signal is dampened while the SE
                    // stays honest → z is conservative → fewer false positives.
                    pool.dLogWBarEwma = (1 - alpha) * pool.dLogWBarEwma + alpha * (dLogWBarRate * shrinkageFactor);
                    pool.dLogWBarSM =
                        (1 - alpha) * pool.dLogWBarSM + alpha * dLogWBarRate * dLogWBarRate;
                    pool.ewmaSumW2 =
                        (1 - alpha) * (1 - alpha) * pool.ewmaSumW2 + alpha * alpha;
                }
            }
        }

        pool.inFlightMs = 0;

        // ── Periodic convergent throughput regulation + gravity ──
        // Fires every TIME_CONSTANT windows so dW has time (~63% absorption) to
        // reflect the previous adjustment before the next decision.
        //
        // Step formula: step = ceil(L × (1 - e^(-depth/TIME_CONSTANT)))
        // Severity encoded through persistence: sustained signal →
        // depth keeps incrementing → steps grow naturally.
        //
        // Phase transitions: Increasing→Retracting (walk back growth),
        // Retracting→Decreasing (fresh ramp), any→Idle (cooling).
        if (pool.elapsedWindows >= timeConstant && pool.elapsedWindows % timeConstant === 0) {
            if (this.isLatencyDegrading(pool)) {
                this.applyDecrease(pool);
            } else if (
                pool.regulationPhase === RegulationPhase.Retracting ||
                pool.regulationPhase === RegulationPhase.Decreasing
            ) {
                // Cooling: one TIME_CONSTANT eval after a decrease sequence before
                // allowing increases. The phase acts as natural momentum —
                // prevents immediate flip-flop between latency-decrease and
                // queue-increase. Reset to Idle so the next action starts
                // cautiously from depth 0. Bisection: halve stepScale so the
                // next increase cycle uses finer steps, converging to within
                // ±1 of the true equilibrium over O(log L) cycles.
                pool.regulationPhase = RegulationPhase.Idle;
                pool.regulationDepth = 0;
                pool.stepScale *= 0.5;
            } else if (pool.queueLength > 0) {
                // Queue pressure: increase to meet demand. Only fires when
                // not in a decrease sequence (Idle, Increasing, or Restoring).
                this.applyIncrease(pool);
            } else if (
                pool.errorRateEwma !== null &&
                pool.errorRateEwma > 0 &&
                Math.random() < pool.errorRateEwma
            ) {
                // Probabilistic error decrease: fires with P = errorRate.
                // At low rates (5% localized): barely fires, gravity recovers.
                // At high rates (80% systemic): fires most evals, aggressive.
                // Per-lane shedding keeps aggregate error rate low for
                // localized failures, so this only fires for systemic issues.
                this.applyDecrease(pool);
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
        pool.windowStart = now;
    }

    private async executeTask<T>(pool: Pool, laneKey: string, task: () => T): Promise<T> {
        let errored = false;
        try {
            return await task();
        } catch (err) {
            errored = true;
            throw err;
        } finally {
            if (errored) {
                pool.errorsThisWindow++;
            }
            pool.completionsThisWindow++;

            // Accumulate Little's Law integral before changing inFlight.
            const completionNow = performance.now();
            pool.inFlightMs += pool.inFlight * (completionNow - pool.lastInFlightChangeTime);
            pool.lastInFlightChangeTime = completionNow;
            pool.inFlight--;
            const lane = pool.lanes.get(laneKey);
            if (lane) {
                lane.inFlight--;

                // Update per-lane error rate EWMA, time-weighted by elapsed
                // time since last completion. Rapid completions → small alpha
                // (each sample less weight). Long gaps → large alpha (old data stale).
                const now = performance.now();
                // Ensure at least 1ms elapsed so rapid completions at the
                // same tick still contribute weight to the EWMA.
                lane.completions++;
                const laneElapsed = Math.max(1, now - lane.lastCompletionTime);
                const { timeConstant: hl, z2: z2_ } = this.params(pool);
                const timeAlpha = 1 - Math.exp(-laneElapsed / (hl * pool.controlWindow));
                // Bayesian shrinkage: dampens updates for lanes with few
                // completions — prevents noisy early estimates from causing
                // aggressive per-lane shedding.
                const laneAlpha = timeAlpha * this.shrinkage(lane.completions, z2_);
                lane.errorRateEwma = (1 - laneAlpha) * lane.errorRateEwma + laneAlpha * (errored ? 1 : 0);
                lane.lastCompletionTime = now;

                if (lane.entries.length === 0 && lane.inFlight === 0) {
                    this.removeLane(pool, lane);
                }
            }

            this.evaluateControlWindow(pool);
            this.processQueue(pool);
        }
    }

    /** Bayesian shrinkage factor: n/(n+z²). Weights an observation of n samples
     *  against a prior of z² pseudo-observations. At z=2, n=1: 0.20, n=10: 0.71,
     *  n=100: 0.96. Connected to Wilson (same denominator). */
    private shrinkage(n: number, z2: number): number {
        return n / (n + z2);
    }

    /**
     * Trend z-test: is latency trending upward?
     *
     * Uses EWMA of dLogWBar (trend) and its second moment for the SE
     * denominator. Degrading when trend / SE > zScoreThreshold.
     */
    private isLatencyDegrading(pool: Pool): boolean {
        if (pool.dLogWBarEwma === null || pool.dLogWBarSM === 0) return false;
        const { zScoreThreshold } = this.params(pool);
        // SE = sqrt(SM × sumW2). SM estimates σ² under H0. sumW2 is the
        // exact sum of squared EWMA weights — generalizes α/(2-α) to
        // time-varying α, giving correct effective sample size after
        // idle gaps and irregular window timing.
        const se = Math.sqrt(pool.dLogWBarSM * pool.ewmaSumW2);
        return pool.dLogWBarEwma > zScoreThreshold * se;
    }

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
}
