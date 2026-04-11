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
