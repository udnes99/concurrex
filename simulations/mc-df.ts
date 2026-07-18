/** Throwaway Monte Carlo: effective df of the pipeline's δ² estimator.
 *  Simulates the exact pipeline (level EWMA of iid noise → rate diffs →
 *  δ² EWMA), measures df_eff = 2·E[δ²]²/Var(δ²) across replications, and
 *  compares against: naive ESS (1/Σw²), our c-corrected 1/(Σw²·1.45),
 *  and Gemini's ESS/3. */
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
function gaussian(rng: () => number): number {
    let u = 0;
    while (u === 0) u = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const ALPHA = 0.105; // steady-state pool alpha at z = 2
const STEPS = 800;   // enough to reach EWMA steady state
const TRIALS = 30000;

const samples: number[] = [];
for (let t = 0; t < TRIALS; t++) {
    const rng = mulberry32(1000 + t);
    let level: number | null = null;
    let prevLevel: number | null = null;
    let lastRate: number | null = null;
    let d2 = 0;
    for (let k = 0; k < STEPS; k++) {
        const m = gaussian(rng); // iid window noise (H0)
        level = level === null ? m : (1 - ALPHA) * level + ALPHA * m;
        if (prevLevel !== null) {
            const rate = level - prevLevel; // dt = 1
            if (lastRate !== null) {
                const diff = rate - lastRate;
                d2 = (1 - ALPHA) * d2 + (ALPHA * diff * diff) / 2;
            }
            lastRate = rate;
        }
        prevLevel = level;
    }
    samples.push(d2);
}

const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / (samples.length - 1);
const dfMeasured = (2 * mean * mean) / variance;

const sumW2 = ALPHA / (2 - ALPHA); // steady-state Σw²
const rho1 = -(1 + ALPHA / 2 + (ALPHA * ALPHA) / 2) / (2 * (1 + ALPHA / 2));
const c = 1 + 2 * (1 - ALPHA) * rho1 * rho1;

console.log("── constant α ──");
console.log(`measured df_eff (Monte Carlo, ${TRIALS} reps):  ${dfMeasured.toFixed(2)}`);
console.log(`ours    1/(Σw²·c), c=${c.toFixed(3)}:              ${(1 / (sumW2 * c)).toFixed(2)}`);
console.log(`naive   1/Σw² (mean-type ESS):                ${(1 / sumW2).toFixed(2)}`);
console.log(`Gemini  ESS/3:                                ${(1 / sumW2 / 3).toFixed(2)}`);

// ── Time-varying α: elapsed ~ Uniform(0.5, 1.5)·CW per window ──
// Tracks the exact Σw² recursion AND the exact adjacent cross-sum S₁
// (S₁ ← (1−α)²S₁ + α(1−α)·α_prev) to compare three predictions:
// shipped constant-α formula, exact S₁ form, and measured truth.
const TAU = 9;
const samplesTV: number[] = [];
let sumW2End = 0;
let s1End = 0;
let alphaEnd = 0;
for (let t = 0; t < TRIALS; t++) {
    const rng = mulberry32(500000 + t);
    let level: number | null = null;
    let prevLevel: number | null = null;
    let lastRate: number | null = null;
    let d2 = 0;
    let w2 = 1;
    let s1 = 0;
    let aPrev = 0;
    let a = 0;
    for (let k = 0; k < STEPS; k++) {
        const dt = 0.5 + rng(); // elapsed in CW units, U(0.5, 1.5)
        a = 1 - Math.exp(-dt / TAU);
        const m = gaussian(rng);
        level = level === null ? m : (1 - a) * level + a * m;
        if (prevLevel !== null) {
            const rate = (level - prevLevel) / dt; // dt-normalized, as in the pipeline
            if (lastRate !== null) {
                const diff = rate - lastRate;
                d2 = (1 - a) * d2 + (a * diff * diff) / 2;
                w2 = (1 - a) * (1 - a) * w2 + a * a;
                s1 = (1 - a) * (1 - a) * s1 + a * (1 - a) * aPrev;
                aPrev = a;
            } else {
                aPrev = a;
            }
            lastRate = rate;
        }
        prevLevel = level;
    }
    samplesTV.push(d2);
    sumW2End += w2;
    s1End += s1;
    alphaEnd += a;
}
const meanTV = samplesTV.reduce((s, x) => s + x, 0) / samplesTV.length;
const varTV = samplesTV.reduce((s, x) => s + (x - meanTV) ** 2, 0) / (samplesTV.length - 1);
const dfTV = (2 * meanTV * meanTV) / varTV;
const w2Bar = sumW2End / TRIALS;
const s1Bar = s1End / TRIALS;
const aBar = alphaEnd / TRIALS;
const rho1TV = -(1 + aBar / 2 + (aBar * aBar) / 2) / (2 * (1 + aBar / 2));
const cTV = 1 + 2 * (1 - aBar) * rho1TV * rho1TV;
console.log("── time-varying α (elapsed ~ U(0.5, 1.5)·CW) ──");
console.log(`measured df_eff:                              ${dfTV.toFixed(2)}`);
console.log(`shipped 1/(Σw²·c(ᾱ)) [constant-α approx]:     ${(1 / (w2Bar * cTV)).toFixed(2)}`);
console.log(`exact   1/(Σw² + 2ρ₁²·S₁):                    ${(1 / (w2Bar + 2 * rho1TV * rho1TV * s1Bar)).toFixed(2)}`);
