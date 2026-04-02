/**
 * Express server with Concurrex admission control.
 *
 * Run:
 *   npx tsx examples/express-server.ts
 *
 * Test:
 *   curl http://localhost:3000/
 *   # Under load:
 *   ab -n 1000 -c 200 http://localhost:3000/
 */

import express from "express";
import { Executor, ResourceExhaustedError } from "concurrex";

const app = express();
const executor = new Executor();

executor.registerPool("http", {
    baselineConcurrency: 50,
    delayThreshold: 200,
    minimumConcurrency: 5,
    maximumConcurrency: 200,
});
executor.start();

// Simulate a downstream call with variable latency
async function handleRequest(): Promise<string> {
    const latency = 20 + Math.random() * 80;
    await new Promise((r) => setTimeout(r, latency));
    return "ok";
}

app.get("/", async (_req, res) => {
    try {
        const result = await executor.run("http", () => handleRequest());
        res.send(result);
    } catch (err) {
        if (err instanceof ResourceExhaustedError) {
            res.status(503).send("Service busy — try again later");
        } else {
            res.status(500).send("Internal error");
        }
    }
});

app.get("/health", (_req, res) => {
    res.json({
        overloaded: executor.isOverloaded("http"),
        degraded: executor.isThroughputDegraded("http"),
        inFlight: executor.getInFlight("http"),
        queueLength: executor.getQueueLength("http"),
        concurrencyLimit: executor.getConcurrencyLimit("http"),
    });
});

const port = 3000;
app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
    console.log(`Health: http://localhost:${port}/health`);
});

process.on("SIGINT", () => {
    executor.stop();
    process.exit(0);
});
