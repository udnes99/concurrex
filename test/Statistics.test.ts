import { Statistics } from "../src/statistics.js";

/**
 * Reference one-sided Student-t quantiles at upper-tail p = Φ(−z),
 * computed independently via bisection on the regularized incomplete
 * beta CDF (500 iterations, cross-checked against scipy.stats.t.isf).
 */
const TRUE_QUANTILES: Array<{ z: number; df: number; q: number }> = [
    { z: 1.5, df: 5, q: 1.7891312 },
    { z: 1.5, df: 12.4, q: 1.6051458 },
    { z: 1.5, df: 17, q: 1.575293 },
    { z: 2, df: 5, q: 2.6486495 },
    { z: 2, df: 12.4, q: 2.2231112 },
    { z: 2, df: 17, q: 2.1582605 },
    { z: 3, df: 5, q: 5.5070797 },
    { z: 3, df: 12.4, q: 3.7346224 },
    { z: 3, df: 17, q: 3.507498 }
];

describe("Statistics", () => {
    describe("tScore", () => {
        it("upper-bounds the true t-quantile at every df ≥ 5", () => {
            for (const { z, df, q } of TRUE_QUANTILES) {
                const t = Statistics.tScore(z, df);
                expect(t).toBeGreaterThanOrEqual(q);
            }
        });

        it("is tight at df ≥ 5 — within 2.5% of the true quantile (truncation-bound margin)", () => {
            for (const { z, df, q } of TRUE_QUANTILES) {
                const t = Statistics.tScore(z, df);
                expect(t / q).toBeLessThan(1.025);
            }
        });

        it("returns Infinity below df 5 — outside the series' certified domain", () => {
            for (const df of [4.999, 3, 2, 1, 0.94, 0.7, 0, -1, Number.NaN]) {
                expect(Statistics.tScore(2, df)).toBe(Number.POSITIVE_INFINITY);
            }
        });

        it("Infinity critical value can never fire the trend test", () => {
            const tCritical = Statistics.tScore(2, 1);
            // finite SE: threshold is Infinity
            expect(1e9 > tCritical * 0.001).toBe(false);
            // SE = 0: threshold is NaN, comparison still false
            expect(1e9 > tCritical * 0).toBe(false);
        });

        it("converges to z as df grows", () => {
            expect(Statistics.tScore(2, 1e9)).toBeCloseTo(2, 6);
        });
    });

    describe("mssdEffectiveDf", () => {
        it("gives df ≈ 12.4 at the default steady state (α ≈ 0.105, Σw² ≈ 0.0555)", () => {
            const alpha = 1 - Math.exp(-1 / 9);
            const sumW2 = alpha / (2 - alpha);
            const df = Statistics.mssdEffectiveDf(alpha, sumW2);
            expect(df).toBeGreaterThan(12.3);
            expect(df).toBeLessThan(12.5);
        });

        it("is smaller than the mean-type ESS df (overlap penalty c > 1)", () => {
            const alpha = 1 - Math.exp(-1 / 9);
            const sumW2 = alpha / (2 - alpha);
            expect(Statistics.mssdEffectiveDf(alpha, sumW2)).toBeLessThan(1 / sumW2 - 1);
        });
    });

    describe("studentTTrendSE", () => {
        it("computes √(σ̂²·Σw²·(1+Σw²)/2)", () => {
            const se = Statistics.studentTTrendSE({ sigmaSqEstimate: 1, ewmaSumW2: 0.0555 });
            expect(se).toBeCloseTo(Math.sqrt((0.0555 * 1.0555) / 2), 10);
        });

        it("clamps negative σ̂² to zero", () => {
            expect(Statistics.studentTTrendSE({ sigmaSqEstimate: -1, ewmaSumW2: 0.5 })).toBe(0);
        });
    });

    describe("deriveTimeConstant", () => {
        it("gives H = 9 at the default z = 2", () => {
            expect(Statistics.deriveTimeConstant(2)).toBe(9);
        });
    });

    describe("timeWeightedAlpha", () => {
        it("clamps negative elapsed time to α = 0", () => {
            expect(Statistics.timeWeightedAlpha(-100, 9, 100)).toBe(0);
        });

        it("gives α = 1 − e^(−1/9) for an on-time window", () => {
            expect(Statistics.timeWeightedAlpha(100, 9, 100)).toBeCloseTo(1 - Math.exp(-1 / 9), 12);
        });
    });

    describe("bayesianShrinkage", () => {
        it("matches n/(n + z²)", () => {
            expect(Statistics.bayesianShrinkage(1, 4)).toBeCloseTo(0.2, 12);
            expect(Statistics.bayesianShrinkage(4, 4)).toBeCloseTo(0.5, 12);
            expect(Statistics.bayesianShrinkage(0, 0)).toBe(0);
        });
    });
});
