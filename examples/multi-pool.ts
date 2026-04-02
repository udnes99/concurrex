/**
 * Multi-pool setup with per-pool tuning.
 *
 * Demonstrates separate pools for commands, queries, and background work
 * with different concurrency limits and detection sensitivity.
 *
 * Run:
 *   npx tsx examples/multi-pool.ts
 */

import { Executor, ResourceExhaustedError } from "concurrex";

const executor = new Executor();

// User-facing commands — tight limits, sensitive detection
executor.registerPool("commands", {
    baselineConcurrency: 20,
    minimumConcurrency: 3,
    maximumConcurrency: 100,
    delayThreshold: 100,
    zScoreThreshold: 1.5,  // detect degradation quickly
});

// Read queries — higher throughput, standard detection
executor.registerPool("queries", {
    baselineConcurrency: 50,
    maximumConcurrency: 200,
    delayThreshold: 200,
});

// Background jobs — generous limits, relaxed detection
executor.registerPool("background", {
    baselineConcurrency: 10,
    maximumConcurrency: 30,
    delayThreshold: 1000,
    zScoreThreshold: 3,  // tolerate more noise
});

executor.start();

// Simulate work
async function simulateWork(pool: string, count: number) {
    const results = { ok: 0, rejected: 0 };

    const tasks = Array.from({ length: count }, async (_, i) => {
        try {
            await executor.run(pool, async () => {
                const latency = 10 + Math.random() * 50;
                await new Promise((r) => setTimeout(r, latency));
                return `${pool}-${i}`;
            }, { lane: `user-${i % 5}` });  // 5 users sharing the pool
            results.ok++;
        } catch (err) {
            if (err instanceof ResourceExhaustedError) {
                results.rejected++;
            } else {
                throw err;
            }
        }
    });

    await Promise.all(tasks);
    return results;
}

async function main() {
    console.log("Running 100 tasks across each pool...\n");

    const [commands, queries, background] = await Promise.all([
        simulateWork("commands", 100),
        simulateWork("queries", 100),
        simulateWork("background", 100),
    ]);

    console.log("Commands:", commands);
    console.log("Queries:", queries);
    console.log("Background:", background);

    console.log("\nPool states:");
    for (const pool of ["commands", "queries", "background"]) {
        console.log(`  ${pool}: limit=${executor.getConcurrencyLimit(pool)}, ` +
            `inFlight=${executor.getInFlight(pool)}, ` +
            `queue=${executor.getQueueLength(pool)}, ` +
            `overloaded=${executor.isOverloaded(pool)}`);
    }

    executor.stop();
}

main().catch(console.error);
