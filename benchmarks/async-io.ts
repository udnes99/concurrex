/**
 * Benchmark: async I/O tasks with variable latency.
 *
 * Simulates a downstream service call (20-100ms random delay).
 * The regulator should grow concurrency freely since tasks don't
 * contend — higher concurrency = higher throughput.
 *
 * Run with concurrex:    npx tsx benchmarks/async-io.ts
 * Run without concurrex: npx tsx benchmarks/async-io.ts --bare
 *
 * Then in another terminal:
 *   npx autocannon -c 200 -d 10 -p 10 http://localhost:3000/
 *   curl http://localhost:3000/health
 */

import express from "express";
import { Executor, ResourceExhaustedError } from "../src/index.js";

const bare = process.argv.includes("--bare");
const app = express();
const executor = new Executor();

executor.registerPool("http", {
    baselineConcurrency: 1000,
    delayThreshold: 200,
    minimumConcurrency: 5,
});
executor.start();

async function handleRequest(): Promise<string> {
    const latency = 20 + Math.random() * 80;
    await new Promise((r) => setTimeout(r, latency));
    return "ok";
}

app.get("/", async (_req, res) => {
    if (bare) {
        res.send(await handleRequest());
        return;
    }
    try {
        const result = await executor.run("http", () => handleRequest());
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
        overloaded: executor.isOverloaded("http"),
        degraded: executor.isThroughputDegraded("http"),
        inFlight: executor.getInFlight("http"),
        queueLength: executor.getQueueLength("http"),
        concurrencyLimit: executor.getConcurrencyLimit("http"),
    });
});

const port = 3000;
app.listen(port, () => {
    console.log(`[async-io${bare ? " BARE" : ""}] listening on http://localhost:${port}`);
    console.log(`Health: http://localhost:${port}/health`);
});

process.on("SIGINT", () => {
    executor.stop();
    process.exit(0);
});
