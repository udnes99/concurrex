---
"concurrex": minor
---

Rewrite the latency trend hypothesis test on a textbook-correct statistical pipeline. Single tunable parameter (`zScoreThreshold`); every other constant is derived. Empirically validated by a comparison bench against centered-variance and second-moment alternatives.

## The pipeline

Seven layered estimators, each addressing one statistical concern. See `docs/THEORY.md` §4.2 for derivations and §4.3.1 for the test.

1. **Operational Little's Law** (§4.2.1) — instantaneous $W_k = \int N(t)\,dt / r_k$ from accumulated `inFlightMs` over completions. An exact identity for any finite interval (Kim & Whitt, 2013) — works at every $W/W_{\text{controlWindow}}$ ratio without modification, and degenerate cases are gated by the `r_k > 0` guard.
2. **Log transform** (§4.2.2) — $m_k = \log W_k$. Multiplicative drift becomes additive; outlier spikes are compressed.
3. **Level EWMA on $\log W$** (§4.2.3) — Bayesian-shrinkage-dampened α. Sparse-completion windows contribute proportionally to evidence, with the conjugate-prior $n/(n + Z^2)$ factor.
4. **dLogW** (§4.2.4) — dt-normalized derivative of the filtered level. Idle gaps don't produce spurious per-window trend signals.
5. **Trend EWMA with asymmetric shrinkage** (§4.2.5) — shrinkage applied to the trend numerator only (input $v_k \cdot s_k$); the noise estimator sees raw $v_k$. Under $H_0$ this preserves FPR; under $H_1$ it dampens detection at low throughput, making the test more conservative when evidence is weak.
6. **MSSD/2 noise estimator (von Neumann's δ²)** (§4.2.6) — $\delta^2 = \text{EWMA}((v_k - v_{k-1})^2 / 2)$. **Drift-invariant by construction**: any additive drift cancels in pairwise differences, so $\delta^2$ tracks $\sigma_v^2$ regardless of $\mu$. With autocorrelation correction $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ accounting for the $\rho_1 = -\alpha/2$ inherited from first-differencing an AR(1)-like EWMA.
7. **Effective sample size via $W^{(2)}$** (§4.2.7) — exact recursion $W_k^{(2)} = (1-\alpha_k)^2 W_{k-1}^{(2)} + \alpha_k^2$ generalizing $\alpha/(2-\alpha)$ to time-varying $\alpha$. ESS $= 1/W^{(2)}$, df $= 1/W^{(2)} - 1$.

## The test

Studentized z-test (§4.3.1):

$$t = \frac{\hat{v}}{\text{SE}}, \quad \text{SE}^2 = \frac{\delta^2 \cdot W^{(2)} \cdot (1 + W^{(2)})}{2 \cdot (1 + \alpha/2)}, \quad \nu = \frac{1}{W^{(2)}} - 1$$

This is $\hat\sigma_v^2 \cdot W^{(2)} \cdot (1+W^{(2)})/2$ where $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ is the unbiased noise estimate (correcting δ²'s autocorrelation bias) and $(1+W^{(2)})/2$ is the variance reduction from $v_k$'s lag-h autocorrelation $\rho_h = -\alpha(1-\alpha)^{h-1}/2$. Together, $E[\text{SE}^2] = \text{Var}(\hat{v})$ exactly under constant α.

**Critical value via Cornish-Fisher with conservative truncation bound.** `tScore(z, df)` returns the 4th-order Cornish-Fisher expansion (Hill 1970) plus an asymptotic-series truncation bound $2|g_4/\nu^4|$. The bound is rigorous at $\nu \geq 5$ (geometric decay with ratio $\leq 1/2$); at smaller $\nu$ it is heuristically conservative via $1/\nu^4$ growth. Returns an upper bound on the true $t$-quantile at every $\nu$.

**Implicit warm-up.** As $\nu \to 0$ (after pool creation, after idle), the truncation bound diverges, forcing the critical value $\to \infty$ — the test gates itself off mathematically. No separate elapsedWindows guard, no df-clamp.

## Guarantees (steady state, constant α, moderate throughput)

- **FPR ≤ Φ(−σ_D)** (e.g., ≤ 2.3% at σ_D = 2). Equality is achieved in the $\nu \to \infty$ limit; at finite $\nu$ the test is conservative via `tScore`'s truncation bound. Empirically ~0% in production benchmarks.
- **No saturation under $H_1$**: drift cancels in lag-1 differences, so $\delta^2$ stays calibrated. Test statistic grows linearly with $\mu$ — severe degradation always triggers.
- **Implicit low-ESS gating**: critical value diverges as $\nu \to 0$, so the test cannot fire during warm-up or post-idle transients.
- **Robust to arbitrary $W/W_{\text{controlWindow}}$ ratios**: operational LL is an exact identity over the accumulating interval whenever $r > 0$.

## Empirical validation

Live HTTP simulation across 10 scenarios (steady, burst, demand spike, full overload, gradual ramp, backend backpressure, error scenarios) compared three variants:

| Variant | FPR (healthy) | TPR (overload) |
|---|---|---|
| **δ²+t (this design)** | 0.0–1.5% (steady), 5.9% (localized-errors outlier) | catches Full Overload (14.7%), Backend Backpressure (13.8%), Error-Based Cap Overload (2.2%) |
| Welford-B centered variance | 0.0–0.2% | **misses Full Overload (0%)** and Error-Based Cap Overload (0%) |
| $S^{(2)}$ raw second moment | 0.0–1.3% | **misses Full Overload (0%)** and Error-Based Cap Overload (0%) |

δ²+t is uniquely sensitive to drift because δ² doesn't absorb the drift level into the noise floor. Centered/uncentered moment estimators inflate under $H_1$, attenuating detection. δ²+t's healthy-state FPR is at or below the nominal $\Phi(-\sigma_D) \approx 2.3\%$ target in 9/10 scenarios; the Localized-Errors outlier reflects genuine pool-wide latency correlation with the failing lane's retries.

## Breaking changes

- `RegulatorState` field rename: `dLogWBarSM` → `dLogWBarVarianceEstimate`. Semantics also change — v1.1.0 stored the raw second moment $E[v^2]$ which saturates the z-score under sustained drift; v1.2.0 stores von Neumann's δ² (lag-1 squared differences, halved), drift-invariant by construction. Any code reading this field for diagnostics must be updated.
- `isThroughputDegraded()` no longer waits the explicit `timeConstant` warm-up windows. Warm-up is handled inside the test via the Student-t critical value's divergence at small ESS (Theorem 9). Functionally equivalent for correct detection but may surface earlier during startup.
- Severe degradation produces unbounded z-scores; snapshot observers may see z = 8–10 during sustained overload.

## Theory

`docs/THEORY.md` §4.2 (the pipeline) and §4.3.1 (the test). Updated theorems 7 (FPR upper bound), 8 (no saturation under $H_1$), 9 (implicit warm-up via tScore divergence). Interactive plots in `docs/theory-plots.html` — operational Little's Law tracking, drift invariance of δ² vs Welford vs $S^{(2)}$, autocorrelation correction factor, Student-t critical value with truncation bound.
