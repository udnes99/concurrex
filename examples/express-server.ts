/**
 * Express server with Concurrex admission control.
 *
 * Demonstrates two signals working together:
 *   - `LatencyDrift` (built-in) — fires on sustained latency degradation
 *   - `HttpErrorRate` (defined here) — fires when 5xx EWMA crosses a
 *     user-defined threshold
 *
 * Error semantics are domain-specific (4xx vs 5xx, retryable vs terminal,
 * business vs infrastructure) so concurrex ships no built-in error signal.
 * Define your own that observes `info.errored` and decides the response.
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
import {
    Executor,
    LatencyDrift,
    ResourceExhaustedError,
    Statistics,
    type CompletionInfo,
    type LatencyDriftState,
    type RegulatorSignal,
    type SignalContext
} from "concurrex";

/**
 * Custom regulator signal: decreases concurrency when the EWMA of
 * `info.errored` rises above a user-defined threshold. Defines "error" as
 * anything the handler surfaced as `errored: true` (here, HTTP 5xx) — the
 * caller controls the semantics by deciding what counts as an error.
 *
 * This drives *concurrency* (a `RegulatorSignal`). If instead you wanted to
 * reject requests to a failing lane at enqueue, use the built-in
 * `LaneErrorShed` admission signal, or write your own `AdmissionSignal`.
 */
interface HttpErrorRateState {
    errorRateEwma: number | null;
    lastUpdate: number | null;
}

class HttpErrorRate implements RegulatorSignal<HttpErrorRateState> {
    readonly name = "http-error-rate";
    private readonly threshold: number;
    private errorRateEwma: number | null = null;
    private lastUpdate: number | null = null;

    constructor(threshold: number = 0.1) {
        this.threshold = threshold;
    }

    onComplete(ctx: SignalContext, info: CompletionInfo): void {
        // Per-event time-weighted EWMA. `Statistics.timeWeightedAlpha` is
        // typically used by per-window signals (like LatencyDrift's
        // `onEvaluate`); here we use it per completion event so the EWMA
        // tracks recent error rate with continuous-time decay. Half-life
        // scales with traffic — sparse traffic gives larger per-event α
        // (more time elapsed), bursty traffic gives smaller per-event α.
        // For a window-cadence error signal, do this update in `onEvaluate`
        // instead and feed `info.elapsed` to `timeWeightedAlpha`.
        const sample = info.errored ? 1 : 0;
        if (this.errorRateEwma === null) {
            // First sample seeds the EWMA. No alpha update — there's no
            // prior to blend against.
            this.errorRateEwma = sample;
        } else {
            const { timeConstant, controlWindow } = ctx.regulator;
            const elapsed = info.completionTime - (this.lastUpdate ?? info.completionTime);
            const alpha = Statistics.timeWeightedAlpha(elapsed, timeConstant, controlWindow);
            this.errorRateEwma = (1 - alpha) * this.errorRateEwma + alpha * sample;
        }
        this.lastUpdate = info.completionTime;
    }

    triggered(): boolean {
        return this.errorRateEwma !== null && this.errorRateEwma > this.threshold;
    }

    state(): HttpErrorRateState {
        return { errorRateEwma: this.errorRateEwma, lastUpdate: this.lastUpdate };
    }

    clone(): HttpErrorRate {
        return new HttpErrorRate(this.threshold);
    }
}

const app = express();
const executor = new Executor();

executor.registerPool("http", {
    baselineConcurrency: 50,
    delayThreshold: 200,
    minimumConcurrency: 5,
    regulatorSignals: [new LatencyDrift(), new HttpErrorRate(0.1)] // 10% 5xx rate triggers backoff
});
executor.start();

// Simulate a downstream call that occasionally fails.
async function handleRequest(): Promise<{ ok: boolean; body: string }> {
    const latency = 20 + Math.random() * 80;
    await new Promise((r) => setTimeout(r, latency));
    if (Math.random() < 0.02) return { ok: false, body: "downstream error" };
    return { ok: true, body: "ok" };
}

app.get("/", async (_req, res) => {
    try {
        const result = await executor.run("http", async () => {
            const response = await handleRequest();
            if (!response.ok) {
                // Throw *inside* the task so the executor records
                // `errored: true` for HttpErrorRate — resolving with
                // { ok: false } would count as a successful completion.
                throw new Error(response.body);
            }
            return response;
        });
        res.send(result.body);
    } catch (err) {
        if (err instanceof ResourceExhaustedError) {
            res.status(503).send("Service busy — try again later");
        } else {
            res.status(500).send("Internal error");
        }
    }
});

app.get("/health", (_req, res) => {
    const latency = executor.getSignalState<LatencyDriftState>("http", "latency-drift");
    const errors = executor.getSignalState<HttpErrorRateState>("http", "http-error-rate");
    res.json({
        overloaded: executor.isOverloaded("http"),
        overloadDetected: executor.getRegulatorState("http").overloadDetected,
        inFlight: executor.getInFlight("http"),
        queueLength: executor.getQueueLength("http"),
        concurrencyLimit: executor.getConcurrencyLimit("http"),
        latencyZScore: latency?.zScore,
        errorRateEwma: errors?.errorRateEwma
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
