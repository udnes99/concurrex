---
"concurrex": patch
---

Rename `halfLife` to `timeConstant` across the codebase. The parameter is a time constant (tau), not a half-life: after `timeConstant` windows the EWMA absorbs 63.2% (1 - 1/e) of a step change, not 50%. No logic changes.
