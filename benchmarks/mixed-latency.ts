/**
 * Benchmark: mixed fast and slow tasks sharing a pool.
 *
 * 80% of requests are fast (5-15ms), 20% are slow (200-500ms).
 * Tests whether ProDel sheds stale slow requests while the regulator
 * finds a concurrency limit that keeps fast requests healthy.
 *
 * Run with concurrex:    npx tsx benchmarks/mixed-latency.ts
 * Run without concurrex: npx tsx benchmarks/mixed-latency.ts --bare
 *
 * Then in another terminal:
 *   npx autocannon -c 100 -d 15 http://localhost:3002/
 *   curl http://localhost:3002/health
 */

import express from "express";
import { Executor, ResourceExhaustedError } from "../src/index.js";

const bare = process.argv.includes("--bare");
const app = express();
const executor = new Executor();

executor.registerPool("mixed", {
    baselineConcurrency: 30,
    delayThreshold: 150,
    minimumConcurrency: 5,
});
executor.start();

async function handleRequest(): Promise<string> {
    const slow = Math.random() < 0.2;
    const latency = slow ? 200 + Math.random() * 300 : 5 + Math.random() * 10;
    await new Promise((r) => setTimeout(r, latency));
    return slow ? "slow" : "fast";
}

app.get("/", async (_req, res) => {
    if (bare) {
        res.send(await handleRequest());
        return;
    }
    try {
        const result = await executor.run("mixed", () => handleRequest());
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
        overloaded: executor.isOverloaded("mixed"),
        degraded: executor.isThroughputDegraded("mixed"),
        inFlight: executor.getInFlight("mixed"),
        queueLength: executor.getQueueLength("mixed"),
        concurrencyLimit: executor.getConcurrencyLimit("mixed"),
    });
});

const port = 3002;
app.listen(port, () => {
    console.log(`[mixed-latency${bare ? " BARE" : ""}] listening on http://localhost:${port}`);
    console.log(`Health: http://localhost:${port}/health`);
});

process.on("SIGINT", () => {
    executor.stop();
    process.exit(0);
});
