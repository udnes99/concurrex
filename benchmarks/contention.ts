/**
 * Benchmark: shared-resource contention (quadratic latency degradation).
 *
 * Simulates a shared resource (e.g. database, lock) where latency grows
 * with the square of concurrent requests: latency = base + k * inFlight².
 * The regulator should find the sweet spot where throughput is maximized
 * without latency exploding.
 *
 * Run with concurrex:    npx tsx benchmarks/contention.ts
 * Run without concurrex: npx tsx benchmarks/contention.ts --bare
 *
 * Then in another terminal:
 *   npx autocannon -c 100 -d 15 http://localhost:3003/
 *   curl http://localhost:3003/health
 */

import express from "express";
import { Executor, ResourceExhaustedError } from "../src/index.js";

const bare = process.argv.includes("--bare");
const app = express();
const executor = new Executor();

executor.registerPool("shared", {
    baselineConcurrency: 20,
    delayThreshold: 200,
    minimumConcurrency: 1,
});
executor.start();

let inFlight = 0;
const BASE_LATENCY = 5;   // ms at zero contention
const K = 0.1;             // quadratic coefficient

async function handleRequest(): Promise<string> {
    inFlight++;
    const latency = BASE_LATENCY + K * inFlight * inFlight;
    await new Promise((r) => setTimeout(r, latency));
    inFlight--;
    return "ok";
}

app.get("/", async (_req, res) => {
    if (bare) {
        res.send(await handleRequest());
        return;
    }
    try {
        const result = await executor.run("shared", () => handleRequest());
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
    res.json(bare ? { mode: "bare", inFlight } : {
        overloaded: executor.isOverloaded("shared"),
        degraded: executor.isThroughputDegraded("shared"),
        inFlight: executor.getInFlight("shared"),
        queueLength: executor.getQueueLength("shared"),
        concurrencyLimit: executor.getConcurrencyLimit("shared"),
        actualInFlight: inFlight,
    });
});

const port = 3003;
app.listen(port, () => {
    console.log(`[contention${bare ? " BARE" : ""}] listening on http://localhost:${port}`);
    console.log(`  latency = ${BASE_LATENCY} + ${K} * inFlight²`);
    console.log(`Health: http://localhost:${port}/health`);
});

process.on("SIGINT", () => {
    executor.stop();
    process.exit(0);
});
