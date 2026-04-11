---
"concurrex": minor
---

Defer admission via setImmediate to yield between CPU-bound tasks.

Admission control now schedules `callback.resolve()` via `setImmediate` (Node) or `queueMicrotask` (browser fallback) instead of resolving synchronously. This yields to the event loop between admitted tasks, preventing sequences of CPU-bound work from starving I/O and blocking regulator timers.

Includes a shutdown guard: if the executor is stopped before the deferred callback fires, the admission is silently dropped.

Also adds an autocannon benchmark suite (async-io, cpu-bound, mixed-latency, contention) with a CLI runner that generates comparison tables, HTML reports, and CSV output.
