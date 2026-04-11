---
"concurrex": patch
---

Add autocannon benchmark suite with runner.

Four benchmarks (async-io, cpu-bound, mixed-latency, contention) with a CLI runner that generates comparison tables and HTML reports. Each supports `--bare` flag for A/B comparison against bare Express.
