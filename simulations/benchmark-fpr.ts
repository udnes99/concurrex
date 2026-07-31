/**
 * False-positive-rate calibration benchmark.
 *
 * Validates the framework's central statistical claim empirically:
 *
 *   Under H0 (no drift), each statistical signal's per-evaluation
 *   false-trigger rate is bounded by Φ(−z), and N signals composed
 *   with OR semantics are jointly bounded by Bonferroni: N·Φ(−z).
 *
 * Two modes, run back to back:
 *
 *   A. **PowerDegraded end-to-end** — a real Executor pool driven with a
 *      stationary (drift-free) log-normal latency workload, across
 *      several zScoreThreshold values. Every `degrading` window after
 *      warm-up is a false positive.
 *
 *   B. **Bonferroni composition** — N independent `NoiseTrend` signals
 *      (the canonical PowerDegraded pipeline applied to independent
 *      synthetic N(0,1) observation streams, using the pool's shared
 *      `ctx.inference` state) on one pool. Measures each signal's
 *      marginal rate and the joint any-signal rate vs. N·Φ(−z).
 *
 * Methodology notes:
 *   - A virtual clock (performance.now override) drives the executor,
 *     so 10k+ control windows run in seconds of wall time.
 *   - Concurrency is pinned (min = baseline = max) so a false trigger
 *     cannot perturb the workload — H0 stays exactly stationary under
 *     the feedback loop.
 *   - The first 5·timeConstant evaluations are excluded (warm-up gate;
 *     including them would flatter the result).
 *   - Trigger observations are serially correlated with horizon ≈ τ
 *     windows, so confidence intervals use an effective sample size of
 *     n/(2τ), not n.
 *   - Expect empirical rates *below* the bound: Bayesian shrinkage
 *     (s = r/(r+z²)) scales the trend numerator, giving an effective
 *     threshold of roughly z/s — reported as the shrinkage-adjusted
 *     prediction alongside the hard bound.
 *
 * Run:
 *   npx tsx simulations/benchmark-fpr.ts
 *   npx tsx simulations/benchmark-fpr.ts --windows 20000 --batch 25 --seed 7
 */
import { Executor } from "../src/Executor.js";
import { Statistics } from "../src/statistics.js";
import {
    PowerDegraded,
    type PowerDegradedState,
    type RegulatorSignal,
    type SignalContext,
    type EvaluateInfo
} from "../src/signals.js";

// ── CLI ──────────────────────────────────────────────────────────────

function argNum(name: string, fallback: number): number {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1 || i + 1 >= process.argv.length) return fallback;
    const v = Number(process.argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
}

const WINDOWS = argNum("windows", 8000); // control windows per configuration
const BATCH = argNum("batch", 25);       // tasks (completions) per window
const SEED = argNum("seed", 42);
const CONTROL_WINDOW = 100;              // virtual ms

// ── Deterministic RNG ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Standard normal via Box-Muller. */
function gaussian(rng: () => number): number {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Standard normal CDF Φ(x) via Abramowitz–Stegun 7.1.26 erf approximation. */
function phi(x: number): number {
    const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
    const y =
        t *
        (0.254829592 +
            t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
        Math.exp((-x * x) / 2);
    return x >= 0 ? 1 - y / 2 : y / 2;
}

// ── Virtual clock ────────────────────────────────────────────────────

const clock = { now: 0 };
// The executor reads time exclusively through performance.now().
(globalThis.performance as { now: () => number }).now = () => clock.now;

const flushImmediates = () => new Promise<void>((r) => setImmediate(r));

const logger = { info() {}, warn() {}, error() {}, debug() {} };

// ── NoiseTrend: the canonical statistical signal on a synthetic stream ─

interface NoiseTrendState {
    degrading: boolean;
}

/**
 * PowerDegraded's exact pipeline (level EWMA → dt-normalized derivative →
 * trend EWMA with shrinkage → von Neumann δ² → Student-t test), applied
 * to an independent i.i.d. N(0,1) observation stream instead of latency.
 * Under H0 by construction — every trigger is a false positive. All
 * statistical parameters come from the pool's shared `ctx.inference`.
 */
class NoiseTrend implements RegulatorSignal<NoiseTrendState> {
    private level: number | null = null;
    private lastUpdate: number | null = null;
    private trend: number | null = null;
    private varEst = 0;
    private lastRate: number | null = null;
    private degrading = false;

    constructor(
        public readonly name: string,
        private readonly rng: () => number
    ) {}

    onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        const { currentAlpha, bayesianShrinkage, controlWindow, ewmaSumW2, df, zScoreThreshold } =
            ctx.inference;

        const x = gaussian(this.rng); // independent H0 observation
        const levelAlpha = currentAlpha * bayesianShrinkage;
        const previousLevel = this.level;
        const previousUpdate = this.lastUpdate;
        this.level = this.level === null ? x : (1 - levelAlpha) * this.level + levelAlpha * x;
        this.lastUpdate = info.windowEnd;

        if (previousLevel !== null && previousUpdate !== null) {
            const dt = (info.windowEnd - previousUpdate) / controlWindow;
            if (dt > 0) {
                const rate = (this.level - previousLevel) / dt;
                this.trend =
                    this.trend === null
                        ? rate * bayesianShrinkage
                        : (1 - currentAlpha) * this.trend + currentAlpha * (rate * bayesianShrinkage);
                if (this.lastRate !== null) {
                    const diff = rate - this.lastRate;
                    this.varEst = (1 - currentAlpha) * this.varEst + (currentAlpha * diff * diff) / 2;
                }
                this.lastRate = rate;
            }
        }

        this.degrading = false;
        if (this.trend !== null && this.varEst > 0 && ewmaSumW2 > 0) {
            const sigmaSqEstimate = this.varEst / (1 + currentAlpha / 2);
            const se = Statistics.studentTTrendSE({ sigmaSqEstimate, ewmaSumW2 });
            if (se > 0) {
                this.degrading = this.trend > Statistics.tScore(zScoreThreshold, df) * se;
            }
        }
    }

    triggered(): boolean {
        return this.degrading;
    }

    state(): NoiseTrendState {
        return { degrading: this.degrading };
    }

    clone(): NoiseTrend {
        return new NoiseTrend(this.name, this.rng);
    }
}

// ── BlockNoise: decision-timescale noise floor (batch means) ─────────

interface BlockNoiseState {
    degrading: boolean;
}

/**
 * PROTOTYPE — PowerDegraded's exact signal path (Little's-law integral,
 * level EWMA, trend EWMA) with ONE change: the noise floor is estimated
 * at the DECISION timescale instead of the sampling timescale.
 *
 * Rates are aggregated into blocks of length m = timeConstant windows;
 * the block rate b_j = Σ(rate·dt)/Σdt telescopes to (level change over
 * the block)/duration, so successive block rates are drift-invariant.
 * δ²_B = EWMA[MSSD/2] of block rates estimates Var(τ-scale rate) —
 * which prices ALL correlation at scales below τ into the noise floor,
 * with no correlation model and no flag. Correlation persisting beyond
 * τ is treated as signal, matching the actuator's decision semantics.
 * df comes from the block-estimator's own ESS (Σw² over block updates,
 * seeded at 1), so warm-up gating is inherited at block granularity.
 */
class BlockNoisePowerDegraded implements RegulatorSignal<BlockNoiseState> {
    public readonly name = "block-power-degraded";

    private inFlightMs = 0;
    private lastInFlightChange: number | null = null;
    private logWBar: number | null = null;
    private lastLevelUpdateTime: number | null = null;
    private trend: number | null = null;

    // Block accumulation (dt in controlWindow units).
    private blockRateSum = 0;
    private blockDtSum = 0;
    private lastBlockRate: number | null = null;
    private blockVarEst = 0; // δ²_B — EWMA[MSSD/2] of block rates
    private blockSumW2 = 1;  // ESS tracker of the block estimator (seed 1)
    private blockUpdates = 0;
    private degrading = false;

    onAdmit(ctx: SignalContext, info: { admitTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight - 1) * (info.admitTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.admitTime;
    }

    onComplete(ctx: SignalContext, info: { completionTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight + 1) * (info.completionTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.completionTime;
    }

    onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        const { currentAlpha, bayesianShrinkage, controlWindow, timeConstant, ewmaSumW2, zScoreThreshold } =
            ctx.inference;

        if (this.lastInFlightChange !== null) {
            this.inFlightMs += ctx.inFlight * (info.windowEnd - this.lastInFlightChange);
            this.lastInFlightChange = info.windowEnd;
        }
        if (info.completions === 0 || this.inFlightMs === 0) return;

        const logInstantW = Math.log(this.inFlightMs / info.completions);
        const levelAlpha = currentAlpha * bayesianShrinkage;
        const previousLevel = this.logWBar;
        const previousUpdate = this.lastLevelUpdateTime;
        this.logWBar =
            this.logWBar === null
                ? logInstantW
                : (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;
        this.lastLevelUpdateTime = info.windowEnd;

        if (previousLevel !== null && previousUpdate !== null) {
            const dt = (info.windowEnd - previousUpdate) / controlWindow;
            if (dt > 0) {
                const rate = (this.logWBar - previousLevel) / dt;
                this.trend =
                    this.trend === null
                        ? rate * bayesianShrinkage
                        : (1 - currentAlpha) * this.trend + currentAlpha * (rate * bayesianShrinkage);

                // ── Block accumulation at the decision timescale ──
                this.blockRateSum += rate * dt;
                this.blockDtSum += dt;
                if (this.blockDtSum >= timeConstant) {
                    const blockRate = this.blockRateSum / this.blockDtSum;
                    if (this.lastBlockRate !== null) {
                        const diff = blockRate - this.lastBlockRate;
                        this.blockVarEst =
                            (1 - currentAlpha) * this.blockVarEst +
                            (currentAlpha * diff * diff) / 2;
                        this.blockSumW2 =
                            (1 - currentAlpha) * (1 - currentAlpha) * this.blockSumW2 +
                            currentAlpha * currentAlpha;
                        this.blockUpdates++;
                    }
                    this.lastBlockRate = blockRate;
                    this.blockRateSum = 0;
                    this.blockDtSum = 0;
                }
            }
        }
        this.inFlightMs = 0;

        // ── Test: trend vs noise floor priced at the decision scale ──
        // δ²_B estimates Var(block rate) = σ²_eff/m, so the per-window
        // long-run variance (incl. sub-τ correlation) is m·δ²_B.
        this.degrading = false;
        if (this.trend !== null && this.blockVarEst > 0 && this.blockUpdates >= 2) {
            const df = 1 / this.blockSumW2 - 1;
            if (df > 0) {
                const sigmaSqEstimate = timeConstant * this.blockVarEst;
                const se = Statistics.studentTTrendSE({ sigmaSqEstimate, ewmaSumW2 });
                if (se > 0) {
                    this.degrading = this.trend > Statistics.tScore(zScoreThreshold, df) * se;
                }
            }
        }
    }

    triggered(): boolean {
        return this.degrading;
    }

    state(): BlockNoiseState {
        return { degrading: this.degrading };
    }

    clone(): BlockNoisePowerDegraded {
        return new BlockNoisePowerDegraded();
    }
}

// ── EProcess: anytime-valid arming via a mixture test martingale ─────

/** Φ(x) — standard normal CDF (Abramowitz–Stegun 26.2.17). Used to map the
 *  σ_D constant to the e-process rejection threshold 1/α, α = Φ(−σ_D). */
function normalCdf(x: number): number {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422804 * Math.exp((-x * x) / 2);
    const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
}

interface EProcessState {
    degrading: boolean;
    wealth: number;
    blocks: number;
}

/**
 * PROTOTYPE — the PowerDegraded arming channel reformulated as an
 * ANYTIME-VALID sequential test. Same front end (Little's-law residence,
 * level EWMA, τ-block accumulation as in the batch-means floor), but the
 * fixed-σ_D Student-t crossing is replaced by a **mixture test martingale**
 * over the drift-invariant block rates b_j.
 *
 * Under H0 (E[b_j]=0) the block rates are ~independent N(0, σ²_B). The
 * likelihood-ratio martingale for a fixed per-block drift ν is
 * exp(ν·s/σ²_B − Jν²/(2σ²_B)) with s=Σb_j; mixing over ν~N(0,τ²) gives the
 * closed form below. By Ville's inequality, rejecting when wealth ≥ 1/α
 * bounds P(EVER fire | H0) ≤ α at *every* stopping time — no fixed-sample
 * assumption, no latch needed to manage repeated looks. The prior width is
 * self-scaling (τ²=σ²_B, "detect drifts of order one block-noise SD"), so no
 * absolute constant is added; α=Φ(−σ_D) reuses the one σ_D knob. σ²_B is the
 * drift-invariant batch-means estimate. Latches on (never resets) so its
 * anytime-valid FPR is "fraction of runs that ever fire".
 */
class EProcessPowerDegraded implements RegulatorSignal<EProcessState> {
    public readonly name = "eprocess-power-degraded";

    private inFlightMs = 0;
    private lastInFlightChange: number | null = null;
    private logWBar: number | null = null;
    private lastLevelUpdateTime: number | null = null;

    private blockRateSum = 0;
    private blockDtSum = 0;
    private lastBlockRate: number | null = null;
    private blockVarEst = 0; // σ²_B (drift-invariant)
    private s = 0; // Σ b_j
    private blocks = 0; // J
    private wealth = 1;
    private everFired = false;

    onAdmit(ctx: SignalContext, info: { admitTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight - 1) * (info.admitTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.admitTime;
    }

    onComplete(ctx: SignalContext, info: { completionTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight + 1) * (info.completionTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.completionTime;
    }

    onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        const { currentAlpha, bayesianShrinkage, controlWindow, timeConstant, zScoreThreshold } =
            ctx.inference;

        if (this.lastInFlightChange !== null) {
            this.inFlightMs += ctx.inFlight * (info.windowEnd - this.lastInFlightChange);
            this.lastInFlightChange = info.windowEnd;
        }
        if (info.completions === 0 || this.inFlightMs === 0) return;

        const logInstantW = Math.log(this.inFlightMs / info.completions);
        const levelAlpha = currentAlpha * bayesianShrinkage;
        const prevLevel = this.logWBar;
        const prevUpdate = this.lastLevelUpdateTime;
        this.logWBar =
            this.logWBar === null ? logInstantW : (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;
        this.lastLevelUpdateTime = info.windowEnd;

        if (prevLevel !== null && prevUpdate !== null) {
            const dt = (info.windowEnd - prevUpdate) / controlWindow;
            if (dt > 0) {
                const rate = (this.logWBar - prevLevel) / dt;
                this.blockRateSum += rate * dt;
                this.blockDtSum += dt;
                if (this.blockDtSum >= timeConstant) {
                    const b = this.blockRateSum / this.blockDtSum;
                    if (this.lastBlockRate !== null) {
                        const diff = b - this.lastBlockRate;
                        this.blockVarEst =
                            (1 - currentAlpha) * this.blockVarEst + (currentAlpha * diff * diff) / 2;
                        // Update the martingale once σ²_B is estimable. The
                        // variance used is the estimate BEFORE this block's own
                        // contribution — predictable, so the martingale property
                        // holds to first order.
                        if (this.blockVarEst > 0) {
                            this.s += b;
                            this.blocks++;
                            const v0 = this.blockVarEst;
                            const tau2 = v0; // self-scaling prior
                            const J = this.blocks;
                            this.wealth =
                                Math.sqrt(v0 / (v0 + J * tau2)) *
                                Math.exp((tau2 * this.s * this.s) / (2 * v0 * (v0 + J * tau2)));
                            const alpha = normalCdf(-zScoreThreshold);
                            if (this.s > 0 && this.wealth >= 1 / alpha) this.everFired = true;
                        }
                    }
                    this.lastBlockRate = b;
                    this.blockRateSum = 0;
                    this.blockDtSum = 0;
                }
            }
        }
        this.inFlightMs = 0;
    }

    triggered(): boolean {
        return this.everFired;
    }

    state(): EProcessState {
        return { degrading: this.everFired, wealth: this.wealth, blocks: this.blocks };
    }

    clone(): EProcessPowerDegraded {
        return new EProcessPowerDegraded();
    }
}

// ── RhoCorrected: rejected research variant (kept for the ablation) ──

interface RhoCorrectedState {
    degrading: boolean;
    rhoHat: number;
}

/**
 * RESEARCH ARTIFACT — the lag-1 ρ̂ *correction* investigated for the
 * library and rejected (THEORY.md §4.2.6): ρ̂ = 1 + 2·corr(Δv_k, Δv_{k−1}),
 * σ̂² inflated by 1/(1−ρ̂), ESS deflated by (1−ρ̂)/(1+ρ̂). Restores the FPR
 * bound under AR(1) noise, but a level step's smooth transient reads as
 * correlation and suppresses step detection. Kept here so the Mode D
 * ablation documents the rejection empirically.
 */
class RhoCorrectedPowerDegraded implements RegulatorSignal<RhoCorrectedState> {
    public readonly name = "power-degraded-corrected";

    private inFlightMs = 0;
    private lastInFlightChange: number | null = null;
    private logWBar: number | null = null;
    private lastLevelUpdateTime: number | null = null;
    private trend: number | null = null;
    private varEst = 0; // δ² = EWMA[Δ²]/2
    private lagEst: number | null = null; // EWMA[Δ_k·Δ_{k−1}]/2
    private lastRate: number | null = null;
    private lastDiff: number | null = null;
    private degrading = false;
    private rhoHat = 0;

    onAdmit(ctx: SignalContext, info: { admitTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight - 1) * (info.admitTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.admitTime;
    }

    onComplete(ctx: SignalContext, info: { completionTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight + 1) * (info.completionTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.completionTime;
    }

    onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        const { currentAlpha, bayesianShrinkage, controlWindow, ewmaSumW2, zScoreThreshold } =
            ctx.inference;

        if (this.lastInFlightChange !== null) {
            this.inFlightMs += ctx.inFlight * (info.windowEnd - this.lastInFlightChange);
            this.lastInFlightChange = info.windowEnd;
        }
        if (info.completions === 0 || this.inFlightMs === 0) return;

        const logInstantW = Math.log(this.inFlightMs / info.completions);
        const levelAlpha = currentAlpha * bayesianShrinkage;
        const previousLevel = this.logWBar;
        const previousUpdate = this.lastLevelUpdateTime;
        this.logWBar =
            this.logWBar === null
                ? logInstantW
                : (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;
        this.lastLevelUpdateTime = info.windowEnd;

        if (previousLevel !== null && previousUpdate !== null) {
            const dt = (info.windowEnd - previousUpdate) / controlWindow;
            if (dt > 0) {
                const rate = (this.logWBar - previousLevel) / dt;
                this.trend =
                    this.trend === null
                        ? rate * bayesianShrinkage
                        : (1 - currentAlpha) * this.trend + currentAlpha * (rate * bayesianShrinkage);
                if (this.lastRate !== null) {
                    const diff = rate - this.lastRate;
                    this.varEst = (1 - currentAlpha) * this.varEst + (currentAlpha * diff * diff) / 2;
                    if (this.lastDiff !== null) {
                        this.lagEst =
                            (1 - currentAlpha) * (this.lagEst ?? 0) +
                            (currentAlpha * diff * this.lastDiff) / 2;
                    }
                    this.lastDiff = diff;
                }
                this.lastRate = rate;
            }
        }
        this.inFlightMs = 0;

        this.degrading = false;
        if (this.trend !== null && this.varEst > 0 && ewmaSumW2 > 0) {
            if (this.lagEst !== null) {
                const c = this.lagEst / this.varEst;
                const cShrunk = bayesianShrinkage * c + (1 - bayesianShrinkage) * -0.5;
                this.rhoHat = Math.min(Math.max(1 + 2 * cShrunk, 0), 1 - 1e-3);
            } else {
                this.rhoHat = 0;
            }
            const sigmaSqEstimate = this.varEst / (1 + currentAlpha / 2) / (1 - this.rhoHat);
            const effSumW2 = ewmaSumW2 * ((1 + this.rhoHat) / (1 - this.rhoHat));
            const df = 1 / effSumW2 - 1;
            if (df > 0) {
                const se = Statistics.studentTTrendSE({ sigmaSqEstimate, ewmaSumW2: effSumW2 });
                if (se > 0) {
                    this.degrading = this.trend > Statistics.tScore(zScoreThreshold, df) * se;
                }
            }
        }
    }

    triggered(): boolean {
        return this.degrading;
    }

    state(): RhoCorrectedState {
        return { degrading: this.degrading, rhoHat: this.rhoHat };
    }

    clone(): RhoCorrectedPowerDegraded {
        return new RhoCorrectedPowerDegraded();
    }
}

// ── Welford: centered-variance noise floor (saturation comparator) ──

interface WelfordState {
    degrading: boolean;
}

/**
 * RESEARCH ARTIFACT — the same pipeline as `PowerDegraded` but with a
 * *centered* variance noise floor (EWMA mean + EWMA of squared
 * residuals, Welford-style) instead of von Neumann's δ² (MSSD/2).
 *
 * The failure mode this exhibits is the reason δ² ships (THEORY.md
 * Theorem 8): a level step's transient enters the residuals, so the
 * noise floor inflates with the *square* of the step magnitude while the
 * trend numerator grows only linearly — the test statistic saturates,
 * and larger incidents become harder to detect, not easier. δ² sees only
 * successive differences, which the transient leaves quickly, so its
 * detection delay is flat in magnitude.
 */
class WelfordPowerDegraded implements RegulatorSignal<WelfordState> {
    public readonly name = "welford-power-degraded";

    private inFlightMs = 0;
    private lastInFlightChange: number | null = null;
    private logWBar: number | null = null;
    private lastLevelUpdateTime: number | null = null;
    private trend: number | null = null;
    private rateMean: number | null = null; // centered-variance mean tracker
    private varEst = 0; // EWMA[(rate − mean)²]
    private degrading = false;

    onAdmit(ctx: SignalContext, info: { admitTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight - 1) * (info.admitTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.admitTime;
    }

    onComplete(ctx: SignalContext, info: { completionTime: number }): void {
        if (this.lastInFlightChange !== null) {
            this.inFlightMs += (ctx.inFlight + 1) * (info.completionTime - this.lastInFlightChange);
        }
        this.lastInFlightChange = info.completionTime;
    }

    onEvaluate(ctx: SignalContext, info: EvaluateInfo): void {
        const { currentAlpha, bayesianShrinkage, controlWindow, ewmaSumW2, zScoreThreshold } =
            ctx.inference;

        if (this.lastInFlightChange !== null) {
            this.inFlightMs += ctx.inFlight * (info.windowEnd - this.lastInFlightChange);
            this.lastInFlightChange = info.windowEnd;
        }
        if (info.completions === 0 || this.inFlightMs === 0) return;

        const logInstantW = Math.log(this.inFlightMs / info.completions);
        const levelAlpha = currentAlpha * bayesianShrinkage;
        const previousLevel = this.logWBar;
        const previousUpdate = this.lastLevelUpdateTime;
        this.logWBar =
            this.logWBar === null
                ? logInstantW
                : (1 - levelAlpha) * this.logWBar + levelAlpha * logInstantW;
        this.lastLevelUpdateTime = info.windowEnd;

        if (previousLevel !== null && previousUpdate !== null) {
            const dt = (info.windowEnd - previousUpdate) / controlWindow;
            if (dt > 0) {
                const rate = (this.logWBar - previousLevel) / dt;
                this.trend =
                    this.trend === null
                        ? rate * bayesianShrinkage
                        : (1 - currentAlpha) * this.trend + currentAlpha * (rate * bayesianShrinkage);
                // Centered variance: residual against the *previous* mean
                // (standard EWMA-Welford update order).
                if (this.rateMean !== null) {
                    const residual = rate - this.rateMean;
                    this.varEst = (1 - currentAlpha) * this.varEst + currentAlpha * residual * residual;
                }
                this.rateMean =
                    this.rateMean === null ? rate : (1 - currentAlpha) * this.rateMean + currentAlpha * rate;
            }
        }
        this.inFlightMs = 0;

        this.degrading = false;
        if (this.trend !== null && this.varEst > 0 && ewmaSumW2 > 0) {
            const df = 1 / ewmaSumW2 - 1;
            if (df > 0) {
                const se = Statistics.studentTTrendSE({ sigmaSqEstimate: this.varEst, ewmaSumW2 });
                if (se > 0) {
                    this.degrading = this.trend > Statistics.tScore(zScoreThreshold, df) * se;
                }
            }
        }
    }

    triggered(): boolean {
        return this.degrading;
    }

    state(): WelfordState {
        return { degrading: this.degrading };
    }

    clone(): WelfordPowerDegraded {
        return new WelfordPowerDegraded();
    }
}

// ── Workloads (all H0: stationary, zero drift) ───────────────────────

type WindowLoad = {
    batch: number;
    serviceTime: number;
    /** Start a long-running task this window, completing after this many
     *  windows (0 = none). Models idiosyncratic stragglers — the Little's
     *  law integral should amortize them at ≤ CW per window. */
    stragglerWindows?: number;
};
type Workload = { name: string; description: string; next: (rng: () => number) => WindowLoad };

const lognormalService = (rng: () => number) =>
    Math.min(20 * Math.exp(0.3 * gaussian(rng)), 0.9 * CONTROL_WINDOW);

/** Baseline: i.i.d. log-normal window latency, constant arrivals. */
function iidWorkload(batch: number): Workload {
    return {
        name: "iid",
        description: "i.i.d. log-normal latency, constant arrivals",
        next: (rng) => ({ batch, serviceTime: lognormalService(rng) })
    };
}

/** AR(1)-correlated log-latency (same marginal distribution as iid).
 *  Violates the independent-window-noise assumption behind δ² — the
 *  honest stress test for the calibration. */
function ar1Workload(batch: number, rho: number): Workload {
    let level = 0;
    return {
        name: `ar1(ρ=${rho})`,
        description: "AR(1)-correlated log-latency, constant arrivals",
        next: (rng) => {
            level = rho * level + Math.sqrt(1 - rho * rho) * 0.3 * gaussian(rng);
            return { batch, serviceTime: Math.min(20 * Math.exp(level), 0.9 * CONTROL_WINDOW) };
        }
    };
}

/** Bursty arrivals: two-state Markov burst/lull (batch 40 vs 5) plus
 *  occasional idle windows with no completions at all. Stresses the
 *  per-window shrinkage and the time-weighted α under irregular
 *  evaluation cadence. Latency itself is i.i.d. */
function burstyWorkload(): Workload {
    let bursting = false;
    return {
        name: "bursty",
        description: "Markov burst/lull arrivals (40/5 per window) + 5% idle windows",
        next: (rng) => {
            if (rng() < 0.1) bursting = !bursting;
            if (rng() < 0.05) return { batch: 0, serviceTime: 0 }; // idle window
            return { batch: bursting ? 40 : 5, serviceTime: lognormalService(rng) };
        }
    };
}

/** Heavy-tail spikes: 3% of windows jump to 4× median latency (still
 *  stationary — spike probability is constant). Exercises the log
 *  transform's outlier-compression claim. */
function spikyWorkload(batch: number): Workload {
    return {
        name: "spikes",
        description: "3% of windows at 4× median latency (stationary heavy tail)",
        next: (rng) => ({
            batch,
            serviceTime: rng() < 0.03 ? 0.9 * CONTROL_WINDOW : lognormalService(rng)
        })
    };
}

/** Straggler pattern: baseline iid latency plus sporadic 100× tasks
 *  (spanning ~20 windows each, ~0.4 concurrently on average). Stationary.
 *  Tests the Little's-law amortization property: a long task contributes
 *  at most CW per window to the residence integral, diluted by the full
 *  completion rate — so idiosyncratic stragglers should NOT trigger. */
function stragglerWorkload(batch: number): Workload {
    return {
        name: "stragglers",
        description: "iid latency + sporadic 100x tasks amortized over ~20 windows",
        next: (rng) => ({
            batch,
            serviceTime: lognormalService(rng),
            stragglerWindows: rng() < 1 / 50 ? 20 : 0
        })
    };
}

/** GC-pause pattern: sporadic multi-window latency pulses — bounded
 *  excursions to `factor`× lasting 2–4 consecutive windows, starting
 *  with probability 1/40 per window. Stationary (the episode process is
 *  time-invariant), so every trigger is a false positive. This is
 *  short-term *correlated* noise with correlation time ≪ τ — the
 *  realistic shape of GC/compaction pauses. */
function gcWorkload(batch: number, factor: number): Workload {
    let remaining = 0;
    return {
        name: `gc(${factor}x)`,
        description: `sporadic 2-4 window pulses at ${factor}x latency (~7% of windows)`,
        next: (rng) => {
            if (remaining === 0 && rng() < 1 / 40) remaining = 2 + Math.floor(rng() * 3);
            const scale = remaining > 0 ? factor : 1;
            if (remaining > 0) remaining--;
            return {
                batch,
                serviceTime: Math.min(scale * 20 * Math.exp(0.3 * gaussian(rng)), 0.9 * CONTROL_WINDOW)
            };
        }
    };
}

/** H1 workload: stationary, then an instantaneous latency level step of
 *  `factor`× at `startWindow`. The step's smooth transient through the
 *  level filter is curvature — the ρ̂ estimator's blind spot. */
function stepWorkload(batch: number, startWindow: number, factor: number, noiseSd = 0.3): Workload {
    let k = 0;
    return {
        name: `step(${factor}x)`,
        description: `stationary, then ${factor}x latency step at window ${startWindow}`,
        next: (rng) => {
            const scale = k >= startWindow ? factor : 1;
            k++;
            return {
                batch,
                serviceTime: Math.min(scale * 20 * Math.exp(noiseSd * gaussian(rng)), 0.9 * CONTROL_WINDOW)
            };
        }
    };
}

/** H1 workload: stationary until `startWindow`, then genuine compounding
 *  latency drift (`perWindow` log-units per window). Optional AR(1)
 *  correlation on the noise. Used for detection-delay measurement. */
function driftingWorkload(batch: number, startWindow: number, perWindow: number, rho = 0): Workload {
    let k = 0;
    let level = 0;
    return {
        name: rho > 0 ? `drift+ar1(${rho})` : "drift",
        description: `stationary, then +${(100 * perWindow).toFixed(1)}%/window drift from window ${startWindow}`,
        next: (rng) => {
            level = rho * level + Math.sqrt(1 - rho * rho) * 0.3 * gaussian(rng);
            const drift = Math.max(0, k - startWindow) * perWindow;
            k++;
            return {
                batch,
                serviceTime: Math.min(20 * Math.exp(level + drift), 0.9 * CONTROL_WINDOW)
            };
        }
    };
}

// ── Workload driver ──────────────────────────────────────────────────

type WindowSample = { evaluated: boolean; firing: boolean[] };

/**
 * Drives one pool for WINDOWS control windows under a stationary
 * log-normal window-latency workload (H0: zero drift) and samples each
 * named signal's `degrading` state after every batch. Concurrency is
 * pinned so triggers cannot perturb the workload.
 */
async function runScenario(opts: {
    z: number;
    signalNames: string[];
    regulatorSignals: RegulatorSignal[];
    rng: () => number;
    workload?: Workload;
    controlWindow?: number;
}): Promise<WindowSample[]> {
    const cw = opts.controlWindow ?? CONTROL_WINDOW;
    const workload = opts.workload ?? iidWorkload(BATCH);
    clock.now = 0; // before registerPool, which stamps the pool's windowStart
    const executor = new Executor({ logger, zScoreThreshold: opts.z });
    const capacity = Math.max(BATCH, 40) * 4;
    executor.registerPool("bench", {
        baselineConcurrency: capacity,
        minimumConcurrency: capacity,
        maximumConcurrency: capacity,
        delayThreshold: 1e12,
        controlWindow: cw,
        regulatorSignals: opts.regulatorSignals,
        admissionSignals: []
    });
    executor.start();

    const samples: WindowSample[] = [];
    let lastElapsedWindows = 0;
    // Long-running injected tasks: { due window, resolve gate, task promise }.
    const stragglers: Array<{ due: number; release: () => void; task: Promise<unknown> }> = [];

    for (let w = 0; w < WINDOWS; w++) {
        const windowStart = w * cw;
        clock.now = windowStart;

        // Complete any stragglers due this window (residence stamped now).
        while (stragglers.length > 0 && stragglers[0].due <= w) {
            const s = stragglers.shift()!;
            s.release();
            await s.task;
        }

        const { batch: batchSize, serviceTime, stragglerWindows } = workload.next(opts.rng);

        if (stragglerWindows && stragglerWindows > 0) {
            const gate = { resolve: () => {} };
            const gatePromise = new Promise<void>((r) => (gate.resolve = r));
            const task = executor.run("bench", () => gatePromise, { lane: "shared" });
            await flushImmediates(); // admit at windowStart
            stragglers.push({ due: w + stragglerWindows, release: gate.resolve, task });
            stragglers.sort((a, b) => a.due - b.due);
        }

        if (batchSize > 0) {
            const gate = { resolve: () => {} };
            const gatePromise = new Promise<void>((r) => (gate.resolve = r));
            const batch = Array.from({ length: batchSize }, () =>
                executor.run("bench", () => gatePromise, { lane: "shared" })
            );
            await flushImmediates(); // admissions stamp onAdmit at windowStart
            clock.now = windowStart + serviceTime;
            gate.resolve();
            await Promise.all(batch); // completions stamp at windowStart + serviceTime
        }

        const elapsedWindows = executor.getRegulatorState("bench").elapsedWindows;
        samples.push({
            evaluated: elapsedWindows > lastElapsedWindows,
            firing: opts.signalNames.map((n) => {
                // For the real PowerDegraded the operative firing state
                // is the latch (what triggered() reports); research variants
                // expose only the per-evaluation test outcome.
                const s = executor.getSignalState<
                    (NoiseTrendState | PowerDegradedState) & { latched?: boolean }
                >("bench", n);
                return (s?.latched ?? s?.degrading ?? false) === true;
            })
        });
        lastElapsedWindows = elapsedWindows;
    }

    // Release any outstanding stragglers so nothing dangles.
    for (const s of stragglers) {
        s.release();
        await s.task;
    }
    executor.stop();
    return samples;
}

// ── Measurement ──────────────────────────────────────────────────────

type Rates = { perSignal: number[]; joint: number; n: number; ci95: number };

function measure(samples: WindowSample[], warmupWindows: number, tau: number): Rates {
    const counted = samples.filter((s, i) => s.evaluated && i >= warmupWindows);
    const k = counted[0]?.firing.length ?? 0;
    const perSignal = Array.from({ length: k }, (_, j) =>
        counted.filter((s) => s.firing[j]).length / counted.length
    );
    const joint = counted.filter((s) => s.firing.some(Boolean)).length / counted.length;
    // Serial correlation horizon ≈ τ windows → effective sample size n/(2τ).
    const nEff = counted.length / (2 * tau);
    const ci95 = 1.96 * Math.sqrt((joint * (1 - joint)) / Math.max(1, nEff));
    return { perSignal, joint, n: counted.length, ci95 };
}

const pct = (x: number) => `${(100 * x).toFixed(3)}%`;

// ── Main ─────────────────────────────────────────────────────────────

/**
 * E-process evaluation (--eprocess): measures the anytime-valid arming
 * variant's two defining properties — P(ever fire | H0) ≤ α (Ville), and its
 * detection delay vs the shipped fixed-σ_D latch (the conservatism cost).
 */
async function runEProcess(): Promise<void> {
    const z = 2;
    const alpha = normalCdf(-z);
    const N = argNum("eseeds", 30);
    console.log("── E-process (anytime-valid arming): mixture test martingale ──\n");
    console.log("Anytime-valid FPR — P(EVER fire | H0), which Ville bounds at α (a whole-run guarantee,");
    console.log("not a per-window rate):");
    const h0: Array<[string, Workload]> = [
        ["iid", iidWorkload(BATCH)],
        ["ar1(0.8)", ar1Workload(BATCH, 0.8)],
        ["gc(5x)", gcWorkload(BATCH, 5)]
    ];
    for (const [name, wl] of h0) {
        let ever = 0;
        for (let i = 0; i < N; i++) {
            const rng = mulberry32(SEED + 4242 + i);
            const samples = await runScenario({
                z,
                signalNames: ["eprocess-power-degraded"],
                regulatorSignals: [new EProcessPowerDegraded()],
                rng,
                workload: wl
            });
            if (samples.some((s) => s.firing[0])) ever++;
        }
        console.log(
            `  ${name.padEnd(10)} P(ever fire) = ${((100 * ever) / N).toFixed(1)}%   ` +
                `vs α = Φ(−${z}) = ${(100 * alpha).toFixed(2)}%   (${ever}/${N} runs)`
        );
    }

    console.log("\nDetection delay (windows after a +0.5%/window drift onset at window 100), median/N:");
    const variants: Array<[string, string, () => RegulatorSignal]> = [
        ["e-process (anytime-valid)", "eprocess-power-degraded", () => new EProcessPowerDegraded()],
        ["PowerDegraded (fixed-σ_D)", "power-degraded", () => new PowerDegraded()]
    ];
    for (const [label, sname, mk] of variants) {
        const delays: number[] = [];
        for (let i = 0; i < N; i++) {
            const rng = mulberry32(SEED + 7373 + i);
            const samples = await runScenario({
                z,
                signalNames: [sname],
                regulatorSignals: [mk()],
                rng,
                workload: driftingWorkload(BATCH, 100, 0.005)
            });
            const first = samples.findIndex((s, k) => k >= 100 && s.firing[0]);
            if (first >= 0) delays.push(first - 100);
        }
        delays.sort((a, b) => a - b);
        const med = delays.length ? delays[Math.floor(delays.length / 2)] : NaN;
        console.log(
            `  ${label.padEnd(26)} median = ${isNaN(med) ? "never" : med + " windows"}   ` +
                `(fired in ${delays.length}/${N})`
        );
    }
    console.log(
        "\nRead: the e-process trades detection speed for a whole-run validity guarantee that holds\n" +
            "under arbitrary peeking — the fixed-σ_D latch is faster but its guarantee is per-evaluation.\n"
    );
}

async function main(): Promise<void> {
    if (process.argv.includes("--eprocess")) {
        await runEProcess();
        return;
    }
    console.log(`FPR calibration benchmark — ${WINDOWS} windows/config, ${BATCH} tasks/window, seed ${SEED}`);
    console.log(`Shrinkage at this batch size: s = r/(r+z²) with r = ${BATCH}\n`);

    // ── Mode A: PowerDegraded end-to-end under stationary latency ──
    console.log("── Mode A: PowerDegraded on a drift-free latency stream ──");
    console.log("z      bound Φ(−z)   shrink-adj Φ(−z/s)   empirical      ±CI95      windows");
    for (const z of [1.5, 2, 3]) {
        const tau = Statistics.deriveTimeConstant(z);
        const rng = mulberry32(SEED + z * 1000);
        const samples = await runScenario({
            z,
            signalNames: ["power-degraded"],
            regulatorSignals: [new PowerDegraded()],
            rng
        });
        const r = measure(samples, 5 * tau, tau);
        const s = BATCH / (BATCH + z * z);
        console.log(
            `${z.toFixed(1).padEnd(6)} ${pct(phi(-z)).padEnd(13)} ${pct(phi(-z / s)).padEnd(20)} ${pct(r.joint).padEnd(14)} ${pct(r.ci95).padEnd(10)} ${r.n}`
        );
    }

    // ── Mode B: N independent signals, Bonferroni composition ──
    const z = 2;
    const tau = Statistics.deriveTimeConstant(z);
    const s = BATCH / (BATCH + z * z);
    console.log(`\n── Mode B: N independent NoiseTrend signals at z = ${z} (OR composition) ──`);
    console.log("N      Bonferroni N·Φ(−z)   shrink-adj N·Φ(−z/s)   joint empirical   ±CI95      per-signal");
    for (const n of [1, 2, 4, 8]) {
        const names = Array.from({ length: n }, (_, i) => `noise-${i}`);
        const signals = names.map((name, i) => new NoiseTrend(name, mulberry32(SEED + 77 * (i + 1))));
        const rng = mulberry32(SEED + 555 + n);
        const samples = await runScenario({ z, signalNames: names, regulatorSignals: signals, rng });
        const r = measure(samples, 5 * tau, tau);
        console.log(
            `${String(n).padEnd(6)} ${pct(Math.min(1, n * phi(-z))).padEnd(21)} ${pct(Math.min(1, n * phi(-z / s))).padEnd(22)} ${pct(r.joint).padEnd(17)} ${pct(r.ci95).padEnd(10)} [${r.perSignal.map(pct).join(", ")}]`
        );
    }

    // ── Mode C: robustness under realistic (still drift-free) traffic ──
    console.log(`\n── Mode C: PowerDegraded at z = ${z} under realistic H0 traffic ──`);
    console.log("workload      bound Φ(−z)   empirical      ±CI95      windows    notes");
    const robustness: Workload[] = [
        iidWorkload(BATCH),
        ar1Workload(BATCH, 0.5),
        ar1Workload(BATCH, 0.8),
        burstyWorkload(),
        spikyWorkload(BATCH),
        gcWorkload(BATCH, 5),
        stragglerWorkload(BATCH)
    ];
    for (const [i, workload] of robustness.entries()) {
        const rng = mulberry32(SEED + 9000 + i);
        const samples = await runScenario({
            z,
            signalNames: ["power-degraded"],
            regulatorSignals: [new PowerDegraded()],
            rng,
            workload
        });
        const r = measure(samples, 5 * tau, tau);
        console.log(
            `${workload.name.padEnd(13)} ${pct(phi(-z)).padEnd(13)} ${pct(r.joint).padEnd(14)} ${pct(r.ci95).padEnd(10)} ${String(r.n).padEnd(10)} ${workload.description}`
        );
    }

    // ── Mitigation: window ≥ correlation time restores the calibration ──
    // Latency noise with a fixed *continuous-time* correlation length
    // T_c has per-window correlation ρ = exp(−CW/T_c). Widening the
    // control window whitens the window-level noise — the practical
    // knob when latency autocorrelation is suspected.
    const TC = 250; // ms — noise correlation time
    console.log(`\n── Mitigation: same noise (T_c = ${TC}ms), wider control window ──`);
    console.log("controlWindow  per-window ρ   bound Φ(−z)   empirical      ±CI95      windows");
    for (const [i, cw] of [100, 500, 1000].entries()) {
        const rho = Math.exp(-cw / TC);
        const rng = mulberry32(SEED + 9500 + i);
        const samples = await runScenario({
            z,
            signalNames: ["power-degraded"],
            regulatorSignals: [new PowerDegraded()],
            rng,
            workload: ar1Workload(BATCH, rho),
            controlWindow: cw
        });
        const r = measure(samples, 5 * tau, tau);
        console.log(
            `${`${cw}ms`.padEnd(14)} ${rho.toFixed(3).padEnd(14)} ${pct(phi(-z)).padEnd(13)} ${pct(r.joint).padEnd(14)} ${pct(r.ci95).padEnd(10)} ${r.n}`
        );
    }

    // ── Mode D: noise-estimator ablation (paired comparison) ──
    // Three noise-floor estimators share one pool and identical events:
    // the shipped default (lag-1 δ²), the REJECTED ρ̂ correction (kept as
    // a research artifact — restores the bound under correlated noise
    // but a level step's smooth transient reads as correlation and
    // suppresses step detection), and the block (decision-timescale)
    // candidate designated to replace the default once its detection-
    // delay tail is characterized.
    console.log(`\n── Mode D: noise-estimator ablation — default vs rejected ρ̂ vs block candidate, z = ${z} ──`);
    console.log("workload      bound Φ(−z)   default        ρ̂ (rejected)   block          windows");
    const pairNames = ["power-degraded", "power-degraded-corrected", "block-power-degraded"];
    for (const [i, workload] of [iidWorkload(BATCH), ar1Workload(BATCH, 0.5), ar1Workload(BATCH, 0.8), gcWorkload(BATCH, 5)].entries()) {
        const rng = mulberry32(SEED + 9800 + i);
        const samples = await runScenario({
            z,
            signalNames: pairNames,
            regulatorSignals: [new PowerDegraded(), new RhoCorrectedPowerDegraded(), new BlockNoisePowerDegraded()],
            rng,
            workload
        });
        const r = measure(samples, 5 * tau, tau);
        console.log(
            `${workload.name.padEnd(13)} ${pct(phi(-z)).padEnd(13)} ${pct(r.perSignal[0]).padEnd(14)} ${pct(r.perSignal[1]).padEnd(14)} ${pct(r.perSignal[2]).padEnd(14)} ${r.n}`
        );
    }

    // Power: detection delay on genuine degradations (H1). The drift rows
    // verify drift-invariance (no self-blinding on constant-rate drift);
    // the step row exposes the ρ̂ variant's curvature blind spot — the
    // reason it was rejected — and checks the block candidate keeps it.
    const DRIFT_START = Math.floor(WINDOWS / 2);
    const DRIFT_PER_WINDOW = 0.005; // +0.5%/window → latency doubles in ~140 windows
    console.log("\npower (windows from onset to first trigger; lower = faster):");
    console.log("workload           default      ρ̂ (rejected) block");
    const powerCases: Array<{ name: string; workload: Workload }> = [
        { name: "drift (iid noise)", workload: driftingWorkload(BATCH, DRIFT_START, DRIFT_PER_WINDOW, 0) },
        { name: "drift+ar1(0.5)", workload: driftingWorkload(BATCH, DRIFT_START, DRIFT_PER_WINDOW, 0.5) },
        { name: "step (4x latency)", workload: stepWorkload(BATCH, DRIFT_START, 4) }
    ];
    for (const [i, pc] of powerCases.entries()) {
        const rng = mulberry32(SEED + 9900 + i);
        const samples = await runScenario({
            z,
            signalNames: pairNames,
            regulatorSignals: [new PowerDegraded(), new RhoCorrectedPowerDegraded(), new BlockNoisePowerDegraded()],
            rng,
            workload: pc.workload
        });
        const delay = (j: number) => {
            const idx = samples.findIndex((s, w) => w >= DRIFT_START && s.evaluated && s.firing[j]);
            return idx === -1 ? "none" : String(idx - DRIFT_START);
        };
        console.log(`${pc.name.padEnd(18)} ${delay(0).padEnd(12)} ${delay(1).padEnd(12)} ${delay(2)}`);
    }

    // ── Mode E: no-saturation ablation — δ² (MSSD/2) vs centered variance ──
    // A step's transient inflates a centered noise floor by the *square*
    // of the magnitude while the trend numerator grows only linearly, so
    // the Welford statistic saturates: bigger incidents get *harder* to
    // detect. δ² sees only successive differences — flat delay in
    // magnitude (Theorem 8's drift invariance, measured).
    console.log(
        `\n── Mode E: noise-floor ablation — δ² (MSSD/2) vs centered variance (Welford), z = ${z} ──`
    );
    {
        const names = ["power-degraded", "welford-power-degraded"];
        const h0 = await runScenario({
            z,
            signalNames: names,
            regulatorSignals: [new PowerDegraded(), new WelfordPowerDegraded()],
            rng: mulberry32(SEED + 12000)
        });
        const r0 = measure(h0, 5 * tau, tau);
        console.log(
            `H0 calibration (iid): δ² ${pct(r0.perSignal[0])}, welford ${pct(r0.perSignal[1])} — bound ${pct(phi(-z))} (fair comparison)`
        );
        // Magnitude sweep. For δ² the delay should *shrink* with severity
        // (test statistic grows ∝ μ — Theorem 8). A centered noise floor
        // inflates with ~μ² during the transient, so its statistic hits a
        // magnitude-independent ceiling — the delay floors instead.
        console.log("\nscenario                    δ² (MSSD/2)   welford      (windows from onset to first trigger)");
        const sweep: Array<{ label: string; workload: Workload }> = [
            ...[0.002, 0.005, 0.02, 0.05].map((perWindow) => ({
                label: `drift +${(100 * perWindow).toFixed(1)}%/window`,
                workload: driftingWorkload(BATCH, DRIFT_START, perWindow, 0)
            })),
            { label: "step 2x", workload: stepWorkload(BATCH, DRIFT_START, 2) },
            { label: "step 4x", workload: stepWorkload(BATCH, DRIFT_START, 4) }
        ];
        for (const [i, item] of sweep.entries()) {
            const rng = mulberry32(SEED + 12100 + i);
            const samples = await runScenario({
                z,
                signalNames: names,
                regulatorSignals: [new PowerDegraded(), new WelfordPowerDegraded()],
                rng,
                workload: item.workload
            });
            const delayE = (j: number) => {
                const idx = samples.findIndex((s, w) => w >= DRIFT_START && s.evaluated && s.firing[j]);
                return idx === -1 ? "none" : String(idx - DRIFT_START);
            };
            console.log(item.label.padEnd(28) + delayE(0).padEnd(14) + delayE(1));
        }
    }

    console.log(
        "\nPass criterion: every empirical rate ≤ its bound. The shrink-adjusted column is" +
            "\nthe sharper prediction accounting for Bayesian shrinkage on the trend numerator;" +
            "\nempirical rates should land near or below it. CIs use n/(2τ) effective samples to" +
            "\naccount for EWMA serial correlation." +
            "\n\nMode C interpretation: the calibration derives from an independent-window-noise" +
            "\nmodel, and its single failure axis is MULTI-WINDOW CORRELATED EXCURSIONS, with" +
            "\nseverity monotone in amplitude × duration: ar1(0.8) sustained wander (~22%) >" +
            "\ngc 5x pulses (~7%) > straggler micro-plateaus (+CW/r for ~20 windows, ~3%) >" +
            "\nanything single-window ≤ bound. Idiosyncratic 100x stragglers are damped ~1000x" +
            "\nby the residence integral (≤ CW/window, diluted by r) — their residual is the" +
            "\nsame correlation axis, not outlier pollution. All violations reduce to handled" +
            "\nshapes once controlWindow exceeds the correlation/pulse duration (the mitigation" +
            "\ntable demonstrates this for AR(1)). Guidance: size controlWindow above your GC" +
            "\npause duration; higher throughput (larger r) shrinks the straggler residual." +
            "\n\nMode D compares noise-floor estimators. The ρ̂ correction (REJECTED, kept for the" +
            "\nablation) restores the bound under correlated noise but can miss latency level" +
            "\nSTEPS, whose smooth transient is indistinguishable from correlated noise — the" +
            "\nidentifiability limit. The block (decision-timescale) estimator is calibrated on" +
            "\nevery workload AND keeps step detection; it is the designated successor once its" +
            "\noccasional drift-detection lag is characterized. Shipped guidance: size" +
            "\ncontrolWindow above routine pause durations and noise correlation times."
    );
}

void main();
