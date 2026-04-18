# concurrex

## 1.1.0

### Minor Changes

- 87c7a58: Defer admission via setImmediate to yield between CPU-bound tasks.

  Admission control now schedules `callback.resolve()` via `setImmediate` (Node) or `queueMicrotask` (browser fallback) instead of resolving synchronously. This yields to the event loop between admitted tasks, preventing sequences of CPU-bound work from starving I/O and blocking regulator timers.

  Includes a shutdown guard: if the executor is stopped before the deferred callback fires, the admission is silently dropped.

  Also adds an autocannon benchmark suite (async-io, cpu-bound, mixed-latency, contention) with a CLI runner that generates comparison tables, HTML reports, and CSV output.

- 6bc4972: Rewrite latency trend detection: replace Kalman filter with shrinkage-dampened EWMA and null-hypothesis z-test.

  **Problem:** The WoLF Kalman filter (IMQ-weighted) used `trendAlpha = alpha * shrinkage` for both the dLogWBar EWMA mean and Welford variance. At low throughput, both froze — the variance stayed at its stale low value, producing artificially low SE. The z-test fired too easily, creating a feedback loop that spiralled concurrency to the minimum. The Kalman also required two unjustifiable parameters: `wolfR = Z²` (observation noise, actually a tuning parameter) and `c = Z` (IMQ outlier threshold, a magic number).

  **Fix:** Replace the entire Kalman + IMQ + Welford pipeline with a simpler, statistically rigorous approach:

  1. **Replace Kalman filter with shrinkage-dampened EWMA** — `logWBar += (alpha * shrinkage) * (logInstantW - logWBar)`. Bayesian shrinkage `n/(n+Z²)` dampens at low throughput (fewer completions = noisier W = trust prior more). No wolfR, wolfQ, P, K, IMQ, or outlier threshold. Zero magic numbers beyond the single `zScoreThreshold` parameter.

  2. **Replace Welford EWMS with second moment** — track `EWMA(dLogWBarRate²)` instead of `(1-α)(V + α·δ²)`. Under the null hypothesis H0 (latency stable, `E[dLogWBarRate] = 0`), the second moment equals the variance: `E[X²] = Var(X)`. The EWMS collapsed at `α → 1` (after idle) because its Bessel-like `(1-α)` factor drives one-sample variance to zero. The second moment formula `(1-α)V + α·x²` gives `V → x²` (nonzero).

  3. **Track sum of squared EWMA weights** — `sumW2 = (1-α)²·sumW2 + α²` exactly tracks `Σw²`, generalizing the constant-α formula `α/(2-α)` to time-varying α. After idle (α → 1), sumW2 → 1 (one effective sample, wide SE). Prevents false positives on sparse pools and after idle gaps.

  4. **dt-normalize the derivative** — `dLogWBarRate = ΔlogWBar / Δt` prevents idle gaps from producing spurious trend signals.

  The z-test is a null-hypothesis test: under H0, `E[v] = 0`, so `E[v²] = σ²`. The z-statistic `z = EWMA(v) / sqrt(SM × sumW2) ~ N(0,1)` regardless of throughput — Bayesian shrinkage scales both signal and noise equally, so it cancels in the ratio.

  **Breaking change:** `RegulatorState` fields renamed — `logWBarP` removed, `dLogWBarVariance` → `dLogWBarSM`, added `ewmaSumW2`.

### Patch Changes

- ebfb3df: Rename `halfLife` to `timeConstant` across the codebase. The parameter is a time constant (tau), not a half-life: after `timeConstant` windows the EWMA absorbs 63.2% (1 - 1/e) of a step change, not 50%. No logic changes.
- 10caed9: Trend shrinkage: conservative z-test at low throughput.

  Apply Bayesian shrinkage to the trend EWMA input (`v × s`) while the second moment sees the raw derivative (`v²`). This intentionally breaks the shrinkage cancellation: at low throughput the signal is dampened while the SE stays honest, giving `z ~ N(0, s²)` under H₀ where `s ≤ 1`.

  False positive rate scales from ~0% at 2 completions/window to the nominal 2.3% at high throughput. Eliminates spurious degradation signals during drain periods without any additional gating logic. No new state, no new parameters (reuses existing `z²`).

  Also normalizes all EWMA updates to canonical `(1-α)·old + α·new` form.
