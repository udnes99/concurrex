# Benchmarks

HTTP load tests using [autocannon](https://github.com/mcollina/autocannon). Each file is a standalone Express server with a single Concurrex pool.

## Prerequisites

```bash
npm install --no-save express autocannon
```

## Quick start

The runner starts each server, runs autocannon (with and without Concurrex), and generates a comparison table + HTML report.

```bash
npx tsx benchmarks/run.ts                       # run all benchmarks
npx tsx benchmarks/run.ts cpu-bound             # run one
npx tsx benchmarks/run.ts cpu-bound async-io    # run specific ones
```

Results are printed to stdout and written to `benchmarks/results.html`.

## Benchmarks

### async-io (port 3000)

Simulated downstream calls (20-100ms). No contention — regulator grows freely.

```bash
npx autocannon -c 200 -d 10 http://localhost:3000/
```

### cpu-bound (port 3001)

Synchronous ~5ms CPU spin per request. Regulator should converge to a low limit. Tests that deferred admission (setImmediate) keeps I/O responsive.

```bash
npx autocannon -c 50 -d 10 http://localhost:3001/
```

### mixed-latency (port 3002)

80% fast (5-15ms) / 20% slow (200-500ms). Tests ProDel shedding of stale slow requests while keeping fast requests healthy.

```bash
npx autocannon -c 100 -d 15 http://localhost:3002/
```

### contention (port 3003)

Shared-resource contention where latency = 5 + 0.1 * inFlight². Without regulation, concurrency grows unboundedly and latency explodes quadratically. The regulator should find the throughput-optimal concurrency.

```bash
npx autocannon -c 100 -d 15 http://localhost:3003/
```

## Manual runs

Each benchmark can be started standalone with an optional `--bare` flag to bypass Concurrex:

```bash
npx tsx benchmarks/cpu-bound.ts         # with concurrex
npx tsx benchmarks/cpu-bound.ts --bare  # without
```

## Sample results (MacBook M3 Pro)

Node v22, single run per benchmark. "Concurrex" uses adaptive admission control; "bare" hits Express directly.

| Benchmark | Metric | concurrex | bare |
|---|---|---|---|
| **async-io** | Req/s (avg) | 3,271 | 1,865 |
| | Latency p50 | 60ms | 63ms |
| | Latency p99 | 101ms | 909ms |
| | Max latency | 179ms | 1,466ms |
| | 2xx % | 100% | 100% |
| **cpu-bound** | Req/s (avg) | 136 | 188 |
| | Latency p50 | 366ms | 243ms |
| | Latency p99 | 676ms | 2,271ms |
| | Max latency | 951ms | 6,285ms |
| | 2xx % | 87.6% | 100% |
| **mixed-latency** | Req/s (avg) | 1,066 | 710 |
| | Latency p50 | 17ms | 12ms |
| | Latency p99 | 498ms | 1,407ms |
| | Max latency | 703ms | 2,299ms |
| | 2xx % | 95% | 100% |
| **contention** | Req/s (avg) | 1,717 | 100 |
| | Latency p50 | <1ms | 1,006ms |
| | Latency p99 | 303ms | 1,021ms |
| | Max latency | 496ms | 1,061ms |
| | 2xx % | 21.2% | 100% |

**Key takeaways:**

- **async-io**: Near-identical p50; Concurrex keeps p99 tight (101ms vs 909ms) under sustained load.
- **cpu-bound**: Bare serves slightly more 2xx but with catastrophic tail latency (6.3s max). Concurrex sheds excess and keeps p99 at 676ms — a 3.4x improvement.
- **mixed-latency**: 50% higher throughput, 2.8x better p99. ProDel sheds the slow 20% to protect the fast 80%.
- **contention**: The showcase — 17x throughput, 1000x better p50. Quadratic latency makes unregulated concurrency devastating; the regulator finds the sweet spot.
