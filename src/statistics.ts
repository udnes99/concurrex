/**
 * Pure mathematical utilities for the concurrex statistical framework.
 *
 * Stateless — these functions are the building blocks every signal uses
 * to compose its hypothesis test. State (EWMAs, integrals, δ², etc.)
 * lives inside the signal itself.
 *
 * The control loop's "heartbeat" — α, ESS, df, shrinkage — is computed
 * by the executor using these primitives and exposed to signals via
 * `RegulatorContext`. Signals read the heartbeat and apply their own
 * inline math to derive a test statistic and threshold.
 */
export class Statistics {
    private constructor() {} // namespace only — not instantiable

    /** Time-weighted EWMA smoothing factor: α = 1 − exp(−Δt / (τ · CW)).
     *  Continuous-time analog of the discrete EWMA λ = exp(−1/τ). */
    static timeWeightedAlpha(elapsedMs: number, timeConstant: number, controlWindow: number): number {
        return 1 - Math.exp(-elapsedMs / (timeConstant * controlWindow));
    }

    /** Bayesian shrinkage factor: n/(n + z²).
     *
     *  Optimal weight for combining n new observations against a prior
     *  of strength z² pseudo-observations. Same denominator as the
     *  Wilson score interval. */
    static bayesianShrinkage(n: number, z2: number): number {
        return n / (n + z2);
    }

    /** Derive the EWMA time constant from a z-score threshold:
     *  τ = round(2 / (1 − exp(−1/z²))).
     *
     *  Chosen so that at steady-state under nominal α, the effective
     *  sample size W^(2) gives a Student-t critical value close to z. */
    static deriveTimeConstant(zScoreThreshold: number): number {
        const z2 = zScoreThreshold * zScoreThreshold;
        return Math.round(2 / (1 - Math.exp(-1 / z2)));
    }

    /** Autocorrelation-corrected standard error of an EWMA trend on
     *  first-differences of an AR(1)-like EWMA:
     *
     *    SE² = σ̂² · W^(2) · (1 + W^(2)) / 2
     *
     *  The (1+W²)/2 factor is the variance-reduction from lag-h
     *  autocorrelation ρ_h = −α(1−α)^(h−1)/2 (see THEORY.md §4.3.1).
     *  The caller must pass an unbiased σ̂² estimate (typically δ²/(1+α/2)). */
    static studentTTrendSE(args: { sigmaSqEstimate: number; ewmaSumW2: number }): number {
        return Math.sqrt(args.sigmaSqEstimate * args.ewmaSumW2 * (1 + args.ewmaSumW2) / 2);
    }

    /** One-sided Student-t critical value (safe upper bound) at upper-tail
     *  probability Φ(−z), degrees of freedom ν.
     *
     *  4th-order Cornish-Fisher inverse-t series (Hill, G. W. "Algorithm 396:
     *  Student's t-quantiles." Communications of the ACM 13.10 (1970): 619–620)
     *  plus an asymptotic-series truncation bound 2·|g₄/ν⁴|. As ν → 0 the bound
     *  diverges, naturally gating the test off — no clamp needed. */
    static tScore(z: number, df: number): number {
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
}
