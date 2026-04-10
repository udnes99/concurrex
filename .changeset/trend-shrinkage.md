---
"concurrex": patch
---

Trend shrinkage: conservative z-test at low throughput.

Apply Bayesian shrinkage to the trend EWMA input (`v × s`) while the second moment sees the raw derivative (`v²`). This intentionally breaks the shrinkage cancellation: at low throughput the signal is dampened while the SE stays honest, giving `z ~ N(0, s²)` under H₀ where `s ≤ 1`.

False positive rate scales from ~0% at 2 completions/window to the nominal 2.3% at high throughput. Eliminates spurious degradation signals during drain periods without any additional gating logic. No new state, no new parameters (reuses existing `z²`).

Also normalizes all EWMA updates to canonical `(1-α)·old + α·new` form.
