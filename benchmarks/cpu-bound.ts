/**
 * Benchmark: synchronous CPU-bound tasks.
 *
 * Each request does a tight loop (~5ms of CPU work). Since tasks block
 * the event loop, the regulator should detect latency degradation and
 * converge to a low concurrency limit. The deferred admission
 * (setImmediate) ensures I/O still gets serviced between tasks.
 *
 * Run with concurrex:    npx tsx benchmarks/cpu-bound.ts
 * Run without concurrex: npx tsx benchmarks/cpu-bound.ts --bare
 *
 * Then in another terminal:
 *   npx autocannon -c 50 -d 10 http://localhost:3001/
 *   curl http://localhost:3001/health
 */

import express from "express";
import { Executor, ResourceExhaustedError } from "../src/index.js";

const bare = process.argv.includes("--bare");
const app = express();
const executor = new Executor();

executor.registerPool("compute", {
    baselineConcurrency: 10,
    delayThreshold: 100,
    minimumConcurrency: 1,
});
executor.start();

/** Burn ~5ms of CPU, yielding to the event loop first so Express can accept connections. */
function cpuWork(): Promise<string> {
    return new Promise((resolve) => {
        setImmediate(() => {
            const start = performance.now();
            while (performance.now() - start < 5) {
                // spin
            }
            resolve("ok");
        });
    });
}

app.get("/", async (_req, res) => {
    if (bare) {
        res.send(await cpuWork());
        return;
    }
    try {
        const result = await executor.run("compute", () => cpuWork());
        res.send(result);
    } catch (err) {
        if (err instanceof ResourceExhaustedError) {
            res.status(503).send("Service busy");
        } else {
            res.status(500).send("Internal error");
        }
    }
});

app.get("/health", (_req, res) => {
    res.json(bare ? { mode: "bare" } : {
        overloaded: executor.isOverloaded("compute"),
        degraded: executor.isThroughputDegraded("compute"),
        inFlight: executor.getInFlight("compute"),
        queueLength: executor.getQueueLength("compute"),
        concurrencyLimit: executor.getConcurrencyLimit("compute"),
    });
});

const port = 3001;
app.listen(port, () => {
    console.log(`[cpu-bound${bare ? " BARE" : ""}] listening on http://localhost:${port}`);
    console.log(`Health: http://localhost:${port}/health`);
});

process.on("SIGINT", () => {
    executor.stop();
    process.exit(0);
});
