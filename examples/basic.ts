/**
 * Basic usage — single pool, no framework.
 *
 * Run:
 *   npx tsx examples/basic.ts
 */

import { Executor, ResourceExhaustedError } from "concurrex";

const executor = new Executor();
executor.registerPool("default", { baselineConcurrency: 5 });
executor.start();

async function fetchData(id: number): Promise<string> {
    const latency = 50 + Math.random() * 100;
    await new Promise((r) => setTimeout(r, latency));
    return `result-${id}`;
}

async function main() {
    // Run 20 tasks through the executor
    const promises = Array.from({ length: 20 }, (_, i) =>
        executor.run("default", () => fetchData(i))
            .then((result) => ({ id: i, result }))
            .catch((err) => {
                if (err instanceof ResourceExhaustedError) {
                    return { id: i, result: "rejected" };
                }
                throw err;
            })
    );

    const results = await Promise.all(promises);
    console.log("Results:", results);
    console.log("Concurrency limit:", executor.getConcurrencyLimit("default"));

    executor.stop();
}

main().catch(console.error);
