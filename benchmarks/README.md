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
| **async-io** | Req/s (avg) | 3,327 | 3,310 |
| | Latency p50 | 59ms | 60ms |
| | Latency p99 | 99ms | 99ms |
| | Max latency | 117ms | 122ms |
| | 2xx % | 100% | 100% |
| **cpu-bound** | Req/s (avg) | 334 | 195 |
| | Latency p50 | 153ms | 249ms |
| | Latency p99 | 313ms | 1,111ms |
| | Max latency | 574ms | 5,014ms |
| | 2xx % | 57% | 100% |
| **mixed-latency** | Req/s (avg) | 1,256 | 1,296 |
| | Latency p50 | 13ms | 11ms |
| | Latency p99 | 489ms | 484ms |
| | Max latency | 767ms | 502ms |
| | 2xx % | 82.6% | 100% |
| **contention** | Req/s (avg) | 1,933 | 100 |
| | Latency p50 | <1ms | 1,006ms |
| | Latency p99 | 291ms | 1,010ms |
| | Max latency | 412ms | 1,019ms |
| | 2xx % | 16.8% | 100% |

**Key takeaways:**

- **async-io**: Identical throughput and latency — Concurrex adds no measurable overhead when the baseline is tuned correctly.
- **cpu-bound**: 71% higher throughput, 3.5x better p99, 8.7x better max latency. Bare serves all requests but with catastrophic tail latency (5s). Concurrex sheds excess and keeps tails tight.
- **mixed-latency**: Similar throughput. The 80/20 fast/slow split doesn't create enough contention for the regulator to improve on bare Express.
- **contention**: The showcase — 19x throughput, 1000x better p50. Quadratic latency makes unregulated concurrency devastating; the regulator finds the sweet spot.
