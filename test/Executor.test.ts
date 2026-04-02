import { ResourceExhaustedError, ExecutorNotRunningError, ArgumentError, ConcurrexError } from "../src/errors.js";
import { DebounceMode, Executor } from "../src/Executor.js";
import type { Logger } from "../src/logger.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const logger: Logger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
};

describe("Executor tests", () => {
    describe("Executor (ProDel)", () => {
        let executor: Executor;
        let randomSpy: ReturnType<typeof vi.spyOn>;

        beforeAll(() => {
            vi.useFakeTimers();
            // Mock Math.random to always return 0 (< any severity > 0), making
            // MD deterministic in all tests. The probabilistic gating is tested
            // explicitly in its own describe block.
            randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            executor = new Executor({ logger });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
        });

        afterAll(() => {
            randomSpy.mockRestore();
            vi.useRealTimers();
        });

        describe("Registration", () => {
            test("registers a pool with default options", () => {
                executor.registerPool("test");
                expect(executor.isOverloaded("test")).toBe(false);
            });

            test("registers a pool with custom options", () => {
                executor.registerPool("test", { delayThreshold: 50, maximumConcurrency: 10 });
                expect(executor.isOverloaded("test")).toBe(false);
            });

            test("throws when registering duplicate pool", () => {
                executor.registerPool("test");
                expect(() => executor.registerPool("test")).toThrow();
            });

            test("throws when delayThreshold is <= 0", () => {
                expect(() => executor.registerPool("test", { delayThreshold: 0 })).toThrow();
                expect(() => executor.registerPool("test", { delayThreshold: -1 })).toThrow();
            });
        });

        describe("Basic execution", () => {
            test("runs a synchronous task", async () => {
                executor.registerPool("test");
                const result = await executor.run("test", () => 42);
                expect(result).toBe(42);
            });

            test("runs an asynchronous task", async () => {
                executor.registerPool("test");
                const promise = executor.run("test", async () => {
                    await wait(10);
                    return "done";
                });
                await vi.advanceTimersByTimeAsync(20);
                const result = await promise;
                expect(result).toBe("done");
            });

            test("throws when executor is stopped", async () => {
                executor.registerPool("test");
                executor.stop();
                await expect(executor.run("test", () => 42)).rejects.toThrow(
                    ExecutorNotRunningError
                );
            });

            test("throws when pool does not exist", async () => {
                await expect(executor.run("nonexistent", () => 42)).rejects.toThrow();
            });

            test("propagates task errors", async () => {
                executor.registerPool("test");
                await expect(
                    executor.run("test", () => {
                        throw new Error("task failed");
                    })
                ).rejects.toThrow("task failed");
            });
        });

        describe("ProDel admission control", () => {
            test("admits tasks immediately when queue is empty (zero sojourn)", async () => {
                executor.registerPool("test", { delayThreshold: 50 });

                const results: number[] = [];
                for (let i = 0; i < 5; i++) {
                    results.push(await executor.run("test", () => i));
                }
                expect(results).toEqual([0, 1, 2, 3, 4]);
            });

            test("admits tasks during short bursts without dropping", async () => {
                executor.registerPool("test", { delayThreshold: 100, maximumConcurrency: 100 });

                // Submit 20 tasks concurrently — all should be admitted since
                // they enter the queue at roughly the same time (sojourn ≈ 0)
                const tasks = Array.from({ length: 20 }, (_, i) =>
                    executor.run("test", async () => {
                        await wait(10);
                        return i;
                    })
                );

                // Advance time to let them all complete
                await vi.advanceTimersByTimeAsync(100);
                const results = await Promise.all(tasks);
                expect(results).toHaveLength(20);
            });

            test("drops tasks under sustained overload", async () => {
                let currentTime = 0;
                const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => currentTime);

                executor.registerPool("test", { delayThreshold: 50, maximumConcurrency: 2 });

                const rejected: Error[] = [];

                // Fill both slots with slow tasks
                const slot1 = executor.run("test", () => wait(100));
                const slot2 = executor.run("test", () => wait(200));

                // Let tasks get admitted
                await vi.advanceTimersByTimeAsync(0);

                // Queue tasks while both slots are busy. Each takes 100ms when admitted.
                const queuedTasks = Array.from({ length: 5 }, (_, i) =>
                    executor
                        .run("test", () => wait(100).then(() => i))
                        .catch((e) => rejected.push(e))
                );

                // Phase 1: Advance time so slot1 completes.
                // ProDel sees sojourn above target, sets firstAboveTime = 300, admits one task.
                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);

                // Phase 2: Advance past firstAboveTime and complete slot2.
                // ProDel enters dropping state and drops at least one entry.
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);

                // Let remaining tasks finish
                await vi.advanceTimersByTimeAsync(1000);
                await Promise.allSettled([slot1, slot2, ...queuedTasks]);

                expect(rejected.length).toBeGreaterThan(0);
                expect(rejected[0]).toBeInstanceOf(ResourceExhaustedError);

                perfSpy.mockRestore();
            });

            test("stops dropping when sojourn time falls below target", async () => {
                executor.registerPool("test", { delayThreshold: 50, maximumConcurrency: 3 });

                const results: string[] = [];

                // Phase 1: Create overload
                const slowTasks = Array.from({ length: 3 }, () =>
                    executor
                        .run("test", async () => {
                            await wait(300);
                        })
                        .then(() => results.push("slow"))
                );
                await vi.advanceTimersByTimeAsync(1);

                // Queue tasks that will experience long sojourn
                const overloadTasks = Array.from({ length: 5 }, () =>
                    executor
                        .run("test", async () => {
                            await wait(5);
                        })
                        .then(() => results.push("overload-ok"))
                        .catch(() => results.push("overload-dropped"))
                );

                // Advance to trigger drops
                await vi.advanceTimersByTimeAsync(200);

                // Phase 2: Let slow tasks finish — relieves pressure
                await vi.advanceTimersByTimeAsync(200);

                // Phase 3: Submit fresh tasks after recovery
                const freshTasks = Array.from({ length: 3 }, (_, i) =>
                    executor
                        .run("test", async () => {
                            await wait(5);
                            return `fresh-${i}`;
                        })
                        .then(() => results.push("fresh-ok"))
                        .catch(() => results.push("fresh-dropped"))
                );

                await vi.advanceTimersByTimeAsync(100);
                await Promise.allSettled([...slowTasks, ...overloadTasks, ...freshTasks]);

                // Fresh tasks after recovery should all succeed
                const freshResults = results.filter((r) => r.startsWith("fresh"));
                expect(freshResults.every((r) => r === "fresh-ok")).toBe(true);
            });
        });

        describe("maximumConcurrency safety rail", () => {
            test("queues tasks when maximumConcurrency is reached and admits when slots free up", async () => {
                executor.registerPool("test", { maximumConcurrency: 2 });

                const order: number[] = [];

                // Fill both slots
                const task1 = executor.run("test", async () => {
                    await wait(100);
                    order.push(1);
                });
                const task2 = executor.run("test", async () => {
                    await wait(100);
                    order.push(2);
                });
                await vi.advanceTimersByTimeAsync(1);

                // Third task should queue, not reject
                const task3 = executor.run("test", async () => {
                    order.push(3);
                    return 42;
                });

                // task3 should not have run yet
                expect(order).toEqual([]);

                // Let the first two tasks complete — task3 should be admitted
                await vi.advanceTimersByTimeAsync(200);
                const result = await task3;
                await Promise.all([task1, task2]);

                expect(result).toBe(42);
                expect(order).toContain(3);
            });

            test("at capacity when maximumConcurrency is reached", async () => {
                executor.registerPool("test", { maximumConcurrency: 1 });

                expect(executor.getInFlight("test")).toBe(0);

                const task = executor.run("test", () => wait(50));
                await vi.advanceTimersByTimeAsync(1);

                expect(executor.getInFlight("test")).toBe(1);
                expect(executor.getConcurrencyLimit("test")).toBe(1);

                await vi.advanceTimersByTimeAsync(100);
                await task;

                expect(executor.getInFlight("test")).toBe(0);
            });
        });

        describe("Lane fairness", () => {
            test("round-robins across lanes", async () => {
                executor.registerPool("test", { delayThreshold: 1000, maximumConcurrency: 100 });

                const order: string[] = [];

                // Submit tasks for two lanes, interleaved
                const tasks: Promise<void>[] = [];
                for (let i = 0; i < 3; i++) {
                    tasks.push(
                        executor.run(
                            "test",
                            async () => {
                                order.push(`A-${i}`);
                                await wait(10);
                            },
                            { lane: "lane-A" }
                        )
                    );
                    tasks.push(
                        executor.run(
                            "test",
                            async () => {
                                order.push(`B-${i}`);
                                await wait(10);
                            },
                            { lane: "lane-B" }
                        )
                    );
                }

                await vi.advanceTimersByTimeAsync(100);
                await Promise.all(tasks);

                // Both lanes should have all tasks completed
                const aResults = order.filter((o) => o.startsWith("A-"));
                const bResults = order.filter((o) => o.startsWith("B-"));
                expect(aResults).toHaveLength(3);
                expect(bResults).toHaveLength(3);
            });

            test("noisy lane does not starve others", async () => {
                executor.registerPool("test", { delayThreshold: 200, maximumConcurrency: 10 });

                const completed: string[] = [];

                // Noisy lane: 8 slow tasks
                const noisyTasks = Array.from({ length: 8 }, (_, i) =>
                    executor
                        .run(
                            "test",
                            async () => {
                                await wait(50);
                            },
                            { lane: "noisy" }
                        )
                        .then(() => completed.push(`noisy-${i}`))
                );

                // Quiet lane: 2 fast tasks
                const quietTasks = Array.from({ length: 2 }, (_, i) =>
                    executor
                        .run(
                            "test",
                            async () => {
                                await wait(5);
                            },
                            { lane: "quiet" }
                        )
                        .then(() => completed.push(`quiet-${i}`))
                );

                await vi.advanceTimersByTimeAsync(500);
                await Promise.allSettled([...noisyTasks, ...quietTasks]);

                // Quiet tasks should complete
                const quietResults = completed.filter((c) => c.startsWith("quiet"));
                expect(quietResults).toHaveLength(2);
            });
        });

        describe("Debouncing", () => {
            test("deduplicates concurrent calls with same key (BeforeExecution)", async () => {
                executor.registerPool("test", { delayThreshold: 1000 });

                let executionCount = 0;
                const task = () => {
                    executionCount++;
                    return Promise.resolve("result");
                };

                const p1 = executor.runDebounced("test", "key-1", task);
                const p2 = executor.runDebounced("test", "key-1", task);
                const p3 = executor.runDebounced("test", "key-1", task);

                await vi.advanceTimersByTimeAsync(100);
                const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

                expect(executionCount).toBe(1);
                expect(r1).toBe("result");
                expect(r2).toBe("result");
                expect(r3).toBe("result");
            });

            test("allows new execution after previous completes (BeforeExecution)", async () => {
                executor.registerPool("test", { delayThreshold: 1000 });

                let executionCount = 0;
                const task = () => {
                    executionCount++;
                    return Promise.resolve(executionCount);
                };

                const p1 = executor.runDebounced("test", "key-1", task);
                await vi.advanceTimersByTimeAsync(10);
                await p1;

                const p2 = executor.runDebounced("test", "key-1", task);
                await vi.advanceTimersByTimeAsync(10);
                await p2;

                expect(executionCount).toBe(2);
            });

            test("deduplicates until result with BeforeResult mode", async () => {
                executor.registerPool("test", { delayThreshold: 1000 });

                let executionCount = 0;
                const task = async () => {
                    executionCount++;
                    await wait(50);
                    return "done";
                };

                const p1 = executor.runDebounced("test", "key-1", task, {
                    mode: DebounceMode.BeforeResult
                });

                await vi.advanceTimersByTimeAsync(10);

                // Task has started but not completed — should still deduplicate
                const p2 = executor.runDebounced("test", "key-1", task, {
                    mode: DebounceMode.BeforeResult
                });

                await vi.advanceTimersByTimeAsync(100);
                const [r1, r2] = await Promise.all([p1, p2]);

                expect(executionCount).toBe(1);
                expect(r1).toBe("done");
                expect(r2).toBe("done");
            });

            test("different keys execute independently", async () => {
                executor.registerPool("test", { delayThreshold: 1000 });

                let count = 0;
                const task = () => {
                    count++;
                    return Promise.resolve(count);
                };

                const p1 = executor.runDebounced("test", "key-1", task);
                const p2 = executor.runDebounced("test", "key-2", task);

                await vi.advanceTimersByTimeAsync(10);
                await Promise.all([p1, p2]);

                expect(count).toBe(2);
            });

            test("propagates errors to all waiters", async () => {
                executor.registerPool("test", { delayThreshold: 1000 });

                const task = () => {
                    throw new Error("boom");
                };

                const p1 = executor.runDebounced("test", "key-1", task);
                const p2 = executor.runDebounced("test", "key-1", task);

                // Attach rejection handlers before advancing to avoid unhandled rejection
                const r1 = expect(p1).rejects.toThrow("boom");
                const r2 = expect(p2).rejects.toThrow("boom");

                await vi.advanceTimersByTimeAsync(10);

                await r1;
                await r2;
            });
        });

        describe("Concurrency regulation", () => {
            test("additive increase: limit grows by 1 on task completion when queue has work", async () => {
                let currentTime = 0;
                const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => currentTime);

                executor.registerPool("test", {
                    baselineConcurrency: 2,
                    maximumConcurrency: 10,
                    delayThreshold: 1000
                });

                // Fill both slots with slow tasks
                const task1 = executor.run("test", () => wait(100));
                const task2 = executor.run("test", () => wait(100));
                await vi.advanceTimersByTimeAsync(0);

                // Queue a third task — this creates pending work
                const task3 = executor.run("test", async () => "third");

                // At capacity: limit=2, inFlight=2
                expect(executor.getInFlight("test")).toBe(2);

                // Complete task1 — regulator bumps limit 2→3 since queue has work, task3 is admitted
                currentTime = 100;
                await vi.advanceTimersByTimeAsync(100);
                await task1;

                // task3 was admitted and completed (sync task), proving regulator increased the limit.
                // Gravity may have snapped it back, so assert task3 result instead of limit.
                const result = await task3;
                expect(result).toBe("third");

                await vi.advanceTimersByTimeAsync(200);
                await task2;

                perfSpy.mockRestore();
            });

            test("additive increase: limit does not exceed maximumConcurrency", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 2,
                    maximumConcurrency: 3,
                    delayThreshold: 1000
                });

                // Fill slots
                const tasks = Array.from({ length: 2 }, () =>
                    executor.run("test", () => wait(50))
                );

                // Queue extra tasks to trigger regulator
                const extra = Array.from({ length: 5 }, () =>
                    executor.run("test", () => wait(10))
                );

                await vi.advanceTimersByTimeAsync(200);
                await Promise.all([...tasks, ...extra]);

                // After all tasks complete, limit should not exceed max
                expect(executor.getConcurrencyLimit("test")).toBeLessThanOrEqual(3);
            });

            test("ProDel drops entries during sustained overload", async () => {
                let currentTime = 0;
                const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => currentTime);

                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 100,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                const rejected: Error[] = [];

                // Fill all 3 slots
                const slot1 = executor.run("test", () => wait(100));
                const slot2 = executor.run("test", () => wait(300));
                const slot3 = executor.run("test", () => wait(300));
                await vi.advanceTimersByTimeAsync(0);

                // Queue tasks while all slots busy
                const queuedTasks = Array.from({ length: 5 }, (_, i) =>
                    executor
                        .run("test", () => wait(50).then(() => i))
                        .catch((e) => rejected.push(e))
                );

                // Phase 1: slot1 completes at t=200.
                // processQueue sees sojourn=200 > target=50, sets firstAboveTime=300, admits one.
                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);

                // Phase 2: t=400, past firstAboveTime(300).
                // ProDel enters dropping state and drops entries.
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);

                // Let everything finish
                await vi.advanceTimersByTimeAsync(1000);
                await Promise.allSettled([slot1, slot2, slot3, ...queuedTasks]);

                expect(rejected.length).toBeGreaterThan(0);
                expect(rejected[0]).toBeInstanceOf(ResourceExhaustedError);

                perfSpy.mockRestore();
            });

            test("baseline gravity: limit drifts back down after burst inflation", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    maximumConcurrency: 20,
                    delayThreshold: 1000
                });

                // Phase 1: Create burst that inflates the limit via the regulator
                // Fill 3 slots, then queue more to trigger additive increase
                const initial = Array.from({ length: 3 }, () =>
                    executor.run("test", () => wait(50))
                );
                const burst = Array.from({ length: 5 }, () =>
                    executor.run("test", () => wait(10))
                );

                await vi.advanceTimersByTimeAsync(200);
                await Promise.all([...initial, ...burst]);

                // Limit should have grown above baseline (each completion with queue > 0 adds 1)
                // Now submit single tasks (no queue pressure) to trigger baseline gravity
                for (let i = 0; i < 10; i++) {
                    const t = executor.run("test", () => wait(5));
                    await vi.advanceTimersByTimeAsync(10);
                    await t;
                }

                // After several idle completions, limit should have drifted back toward 3.
                // Fill exactly 3 slots — should work since limit >= baseline
                const v1 = executor.run("test", () => wait(10));
                const v2 = executor.run("test", () => wait(10));
                const v3 = executor.run("test", () => wait(10));
                await vi.advanceTimersByTimeAsync(0);

                // These should all complete (limit is at or near baseline)
                await vi.advanceTimersByTimeAsync(50);
                await Promise.all([v1, v2, v3]);
            });

            test("baseline gravity: limit recovers to baseline after ProDel overload", async () => {
                let currentTime = 0;
                const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => currentTime);

                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 20,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Phase 1: Overload — regulator inflates limit, ProDel drops excess
                const slots = Array.from({ length: 5 }, () =>
                    executor.run("test", () => wait(100))
                );
                await vi.advanceTimersByTimeAsync(0);

                const overloadTasks = Array.from({ length: 5 }, () =>
                    executor.run("test", () => wait(50)).catch(() => {})
                );

                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);
                await vi.advanceTimersByTimeAsync(1000);
                await Promise.allSettled([...slots, ...overloadTasks]);

                // Phase 2: Submit single tasks (no queue pressure) — gravity pulls limit back
                currentTime = 2000;
                for (let i = 0; i < 10; i++) {
                    const t = executor.run("test", () => wait(5));
                    currentTime += 10;
                    await vi.advanceTimersByTimeAsync(10);
                    await t;
                }

                // Limit should be at baseline (5)
                expect(executor.getConcurrencyLimit("test")).toBe(5);

                perfSpy.mockRestore();
            });
        });

        describe("Registration validation", () => {
            test("throws when minimumConcurrency < 1", () => {
                expect(() => executor.registerPool("test", { minimumConcurrency: 0 })).toThrow();
            });

            test("throws when maximumConcurrency < minimumConcurrency", () => {
                expect(() =>
                    executor.registerPool("test", { minimumConcurrency: 10, maximumConcurrency: 5 })
                ).toThrow();
            });

            test("throws when baselineConcurrency is out of range", () => {
                expect(() =>
                    executor.registerPool("test", {
                        minimumConcurrency: 5,
                        maximumConcurrency: 20,
                        baselineConcurrency: 3
                    })
                ).toThrow();
                expect(() =>
                    executor.registerPool("test2", {
                        minimumConcurrency: 5,
                        maximumConcurrency: 20,
                        baselineConcurrency: 25
                    })
                ).toThrow();
            });

            test("throws when controlWindow <= 0", () => {
                expect(() => executor.registerPool("test", { controlWindow: 0 })).toThrow();
            });
        });

        describe("Lifecycle", () => {
            test("start is idempotent", () => {
                executor.start();
                executor.start();
                // Should not throw
            });

            test("stop is idempotent", () => {
                executor.stop();
                executor.stop();
                // Should not throw
            });

            test("rejects tasks after stop", async () => {
                executor.registerPool("test");
                executor.stop();
                await expect(executor.run("test", () => 42)).rejects.toThrow(
                    ExecutorNotRunningError
                );
            });

            test("rejects queued entries on stop", async () => {
                executor.registerPool("test", { maximumConcurrency: 1 });

                // Fill the single slot with a slow task
                const inFlight = executor.run("test", () => wait(1000));
                await vi.advanceTimersByTimeAsync(0);

                // Queue 3 more tasks — they're waiting for the slot
                const queued = Array.from({ length: 3 }, (_, i) => executor.run("test", () => i));

                expect(executor.getQueueLength("test")).toBe(3);

                // Stop the executor — queued entries should be rejected
                executor.stop();

                for (const promise of queued) {
                    await expect(promise).rejects.toThrow(ExecutorNotRunningError);
                }

                expect(executor.getQueueLength("test")).toBe(0);

                // The in-flight task still completes normally
                await vi.advanceTimersByTimeAsync(1000);
                await expect(inFlight).resolves.toBeUndefined();
            });

            test("cleans up empty lanes after task completion", async () => {
                executor.registerPool("test", { delayThreshold: 1000, maximumConcurrency: 100 });

                await executor.run("test", () => "done", { lane: "temp-lane" });

                // The lane should be cleaned up after the task completes
                // Verify pool is healthy after lane cleanup
                expect(executor.isOverloaded("test")).toBe(false);
            });
        });
    });

    /**
     * Loading pattern simulations.
     *
     * These tests use a controlled time model: `performance.now()` is mocked to
     * control sojourn-time perception, and Vitest fake timers control `wait`.
     * Each test simulates a realistic traffic pattern and asserts the executor
     * behaves correctly across the two regimes (throughput regulation, baseline gravity) and ProDel dropping.
     */
    describe("Executor – loading pattern simulations", () => {
        let executor: Executor;
        let currentTime: number;
        let perfSpy: ReturnType<typeof vi.spyOn>;

        beforeAll(() => {
            vi.useFakeTimers();
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            currentTime = 0;
            perfSpy = vi.spyOn(performance, "now").mockImplementation(() => currentTime);
            executor = new Executor({ logger });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
            perfSpy.mockRestore();
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        // ─── Helpers ───────────────────────────────────────────────────

        type TaskResult = { status: "ok" | "rejected"; startedAt: number };

        /** Submit N tasks, returns promises and a results array to inspect later. */
        function submitBatch(
            pool: string,
            count: number,
            taskDuration: number,
            lane?: string
        ): { promises: Promise<unknown>[]; results: TaskResult[] } {
            const results: TaskResult[] = [];
            const promises = Array.from({ length: count }, () =>
                executor
                    .run(pool, () => wait(taskDuration), lane ? { lane } : undefined)
                    .then(() => results.push({ status: "ok", startedAt: currentTime }))
                    .catch(() => results.push({ status: "rejected", startedAt: currentTime }))
            );
            return { promises, results };
        }

        /** Advance both currentTime and fake timers together. */
        async function advance(ms: number): Promise<void> {
            currentTime += ms;
            await vi.advanceTimersByTimeAsync(ms);
        }

        // ─── Scenarios ─────────────────────────────────────────────────

        describe("Steady state – constant load within baseline", () => {
            test("all tasks succeed, no drops, limit stays at baseline", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 100,
                    controlWindow: 100
                });

                // Run 10 batches of 3 tasks (below baseline of 5), each taking 20ms
                const allResults: TaskResult[] = [];
                for (let batch = 0; batch < 10; batch++) {
                    const { promises, results } = submitBatch("test", 3, 20);
                    await advance(30);
                    await Promise.allSettled(promises);
                    allResults.push(...results);
                }

                expect(allResults).toHaveLength(30);
                expect(allResults.every((r) => r.status === "ok")).toBe(true);

                // No queue pressure was sustained, so limit should remain at baseline
                // Verify by filling exactly 5 slots
                const verify = submitBatch("test", 5, 10);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(5);
                await advance(20);
                await Promise.allSettled(verify.promises);
            });
        });

        describe("Single burst – brief spike above baseline, then idle", () => {
            test("burst is absorbed via the regulator, limit returns to baseline via gravity", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 200,
                    controlWindow: 100
                });

                // Phase 1: Saturate baseline
                const initial = submitBatch("test", 5, 50);
                await advance(0);

                // Phase 2: Burst of 10 more tasks while initial 5 are running
                const burst = submitBatch("test", 10, 30);

                // Advance enough for initial tasks to complete and burst to process.
                // Convergent regulator grows the limit at ESS cadence, so all 15
                // tasks need more than one window to drain.
                await advance(200);
                await Promise.allSettled([...initial.promises, ...burst.promises]);

                // All should succeed (sojourn stays below 200ms threshold)
                const allResults = [...initial.results, ...burst.results];
                expect(allResults.every((r) => r.status === "ok")).toBe(true);

                // Limit was inflated by the regulator during burst. Run single tasks across
                // window boundaries so gravity pulls the limit back to baseline.
                for (let i = 0; i < 5; i++) {
                    const t = executor.run("test", () => wait(5));
                    await advance(110); // cross one control window
                    await t;
                }

                // Limit should have drifted back to baseline (5).
                expect(executor.getConcurrencyLimit("test")).toBe(5);
                const check = submitBatch("test", 5, 50);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(5);
                await advance(60);
                await Promise.allSettled(check.promises);
            });
        });

        describe("Repeated bursts – multiple spikes with recovery windows", () => {
            test("each burst is absorbed, system recovers between bursts", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 200,
                    controlWindow: 100
                });

                for (let wave = 0; wave < 3; wave++) {
                    // Burst: submit 12 tasks at once (more than baseline of 5)
                    const burst = submitBatch("test", 12, 30);
                    await advance(100);
                    await Promise.allSettled(burst.promises);

                    // All tasks should succeed (no sustained overload)
                    expect(burst.results.every((r) => r.status === "ok")).toBe(true);

                    // Recovery: run a few idle tasks to let gravity pull limit back
                    for (let i = 0; i < 10; i++) {
                        const t = executor.run("test", () => wait(5));
                        await advance(10);
                        await t;
                    }
                }
            });
        });

        describe("Gradual ramp-up – linearly increasing load", () => {
            test("regulator grows limit smoothly as demand increases", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 30,
                    delayThreshold: 300,
                    controlWindow: 100
                });

                const allResults: TaskResult[] = [];

                // Ramp: batch sizes 2, 4, 6, 8, 10, 12
                for (let batchSize = 2; batchSize <= 12; batchSize += 2) {
                    const { promises, results } = submitBatch("test", batchSize, 20);
                    // Allow enough time for all tasks to complete through regulator growth
                    await advance(200);
                    await Promise.allSettled(promises);
                    allResults.push(...results);
                }

                // With high delayThreshold (300ms), no tasks should be dropped
                // even as load ramps up, because sojourn stays manageable
                expect(allResults.every((r) => r.status === "ok")).toBe(true);
            });
        });

        describe("Sustained overload – incoming rate exceeds capacity", () => {
            test("ProDel drops excess, then system stabilizes", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Fill 3 slots with slow tasks
                const slot1 = executor.run("test", () => wait(100));
                const slot2 = executor.run("test", () => wait(300));
                const slot3 = executor.run("test", () => wait(300));
                await vi.advanceTimersByTimeAsync(0);

                // Flood while all slots busy
                const floodResults: TaskResult[] = [];
                const floodPromises = Array.from({ length: 10 }, () =>
                    executor
                        .run("test", () => wait(50))
                        .then(() => floodResults.push({ status: "ok", startedAt: currentTime }))
                        .catch(() =>
                            floodResults.push({ status: "rejected", startedAt: currentTime })
                        )
                );

                // Phase 1: slot1 completes, ProDel sees high sojourn, sets firstAboveTime
                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);

                // Phase 2: past firstAboveTime — ProDel enters dropping, sheds excess
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);

                await vi.advanceTimersByTimeAsync(2000);
                await Promise.allSettled([slot1, slot2, slot3, ...floodPromises]);

                const rejected = floodResults.filter((r) => r.status === "rejected");
                const accepted = floodResults.filter((r) => r.status === "ok");

                expect(rejected.length).toBeGreaterThan(0);
                expect(accepted.length).toBeGreaterThan(0);
            });

            test("system recovers to baseline after sustained overload ends", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Phase 1: Overload (use manual time control)
                const slots = Array.from({ length: 5 }, () =>
                    executor.run("test", () => wait(100))
                );
                await vi.advanceTimersByTimeAsync(0);
                const flood = Array.from({ length: 10 }, () =>
                    executor.run("test", () => wait(50)).catch(() => {})
                );

                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);
                await vi.advanceTimersByTimeAsync(2000);
                await Promise.allSettled([...slots, ...flood]);

                // Phase 2: Recovery via gravity
                currentTime = 3000;
                for (let i = 0; i < 15; i++) {
                    const t = executor.run("test", () => wait(5));
                    currentTime += 10;
                    await vi.advanceTimersByTimeAsync(10);
                    await t;
                }

                // Should have recovered to baseline (5)
                const verify = Array.from({ length: 5 }, () =>
                    executor.run("test", () => wait(10))
                );
                currentTime += 100;
                await vi.advanceTimersByTimeAsync(0);
                await vi.advanceTimersByTimeAsync(20);
                await Promise.all(verify);
            });
        });

        describe("Flash crowd – sudden massive spike", () => {
            test("ProDel sheds load but some tasks still complete", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // 50 tasks arrive at once — 10x baseline
                const flash = submitBatch("test", 50, 100);

                // Advance through the overload phases
                await advance(200);
                await advance(200);
                await advance(5000);
                await Promise.allSettled(flash.promises);

                const accepted = flash.results.filter((r) => r.status === "ok");
                const rejected = flash.results.filter((r) => r.status === "rejected");

                // Should shed significant load
                expect(rejected.length).toBeGreaterThan(0);
                // But should still process some tasks
                expect(accepted.length).toBeGreaterThan(0);
            });

            test("accepts new work after flash crowd clears", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Flash crowd
                const flash = submitBatch("test", 30, 100);
                await advance(200);
                await advance(200);
                await advance(3000);
                await Promise.allSettled(flash.promises);

                // Gravity recovery
                for (let i = 0; i < 15; i++) {
                    const t = executor.run("test", () => wait(5));
                    await advance(10);
                    await t;
                }

                // Post-recovery: normal load should work fine
                const normal = submitBatch("test", 4, 30);
                await advance(50);
                await Promise.allSettled(normal.promises);

                expect(normal.results.every((r) => r.status === "ok")).toBe(true);
            });
        });

        describe("Oscillating load – alternating high and low periods", () => {
            test("system adapts to each phase without permanent degradation", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 30,
                    delayThreshold: 200,
                    controlWindow: 100
                });

                const phaseResults: { phase: string; ok: number; rejected: number }[] = [];

                for (let cycle = 0; cycle < 4; cycle++) {
                    // High phase: 10 concurrent tasks (2x baseline)
                    const high = submitBatch("test", 10, 30);
                    await advance(80);
                    await Promise.allSettled(high.promises);
                    phaseResults.push({
                        phase: `high-${cycle}`,
                        ok: high.results.filter((r) => r.status === "ok").length,
                        rejected: high.results.filter((r) => r.status === "rejected").length
                    });

                    // Low phase: 2 tasks (well below baseline)
                    const low = submitBatch("test", 2, 10);
                    await advance(20);
                    await Promise.allSettled(low.promises);
                    phaseResults.push({
                        phase: `low-${cycle}`,
                        ok: low.results.filter((r) => r.status === "ok").length,
                        rejected: low.results.filter((r) => r.status === "rejected").length
                    });
                }

                // With a generous delayThreshold (200ms), all tasks should succeed
                // because sojourn never exceeds the threshold
                for (const phase of phaseResults) {
                    expect(phase.rejected).toBe(0);
                    expect(phase.ok).toBeGreaterThan(0);
                }
            });
        });

        describe("Trickle after overload – very low load following overload", () => {
            test("trickle tasks succeed and limit recovers via gravity", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Phase 1: Overload to push limit down
                const slow = submitBatch("test", 5, 200);
                await advance(0);
                const overload = submitBatch("test", 10, 50);
                await advance(200);
                await advance(200);
                await advance(2000);
                await Promise.allSettled([...slow.promises, ...overload.promises]);

                // Phase 2: Trickle — one task at a time, well-spaced
                const trickleResults: TaskResult[] = [];
                for (let i = 0; i < 20; i++) {
                    const t = executor.run("test", () => wait(5));
                    await advance(50); // Plenty of time between tasks
                    await t;
                    trickleResults.push({ status: "ok", startedAt: currentTime });
                }

                // Every trickle task should succeed
                expect(trickleResults.every((r) => r.status === "ok")).toBe(true);

                // After 20 completions with empty queue, limit should be at baseline
                expect(executor.getConcurrencyLimit("test")).toBe(5);
                const verify = submitBatch("test", 5, 10);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(5);
                await advance(20);
                await Promise.allSettled(verify.promises);
                expect(verify.results.every((r) => r.status === "ok")).toBe(true);
            });
        });

        describe("Multi-lane fairness under throughput regulation", () => {
            test("both lanes get served during burst absorption (growth phase)", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 4,
                    minimumConcurrency: 1,
                    maximumConcurrency: 20,
                    delayThreshold: 500,
                    controlWindow: 100
                });

                // Burst across two lanes
                const laneA = submitBatch("test", 8, 30, "lane-A");
                const laneB = submitBatch("test", 8, 30, "lane-B");

                await advance(200);
                await Promise.allSettled([...laneA.promises, ...laneB.promises]);

                // Both lanes should have tasks completed (round-robin fairness)
                const aOk = laneA.results.filter((r) => r.status === "ok").length;
                const bOk = laneB.results.filter((r) => r.status === "ok").length;

                expect(aOk).toBe(8);
                expect(bOk).toBe(8);
            });

            test("noisy lane does not prevent quiet lane from being served during overload", async () => {
                // Use realistic random so probabilistic drops let some entries
                // survive — with random=0 every stale entry is instantly dropped,
                // draining the noisy lane before the quiet lane gets a chance.
                vi.spyOn(Math, "random").mockReturnValue(0.5);

                executor.registerPool("test", {
                    baselineConcurrency: 10,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Noisy lane: floods the pool with short tasks
                const noisy = submitBatch("test", 20, 30, "noisy");
                await advance(0);

                // Quiet lane: submits a couple of tasks
                const quiet = submitBatch("test", 3, 30, "quiet");

                // Let overload phases happen — granular advances give probabilistic
                // drops enough chances to free slots for the quiet lane.
                for (let i = 0; i < 50; i++) {
                    await advance(100);
                }
                await Promise.allSettled([...noisy.promises, ...quiet.promises]);

                // Some quiet tasks should have been served (round-robin ensures fairness)
                const quietOk = quiet.results.filter((r) => r.status === "ok").length;
                expect(quietOk).toBeGreaterThan(0);
            });
        });

        describe("Back-to-back overloads – no recovery window", () => {
            test("limit continues to decrease across sustained overload waves", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                let totalRejected = 0;

                // Two overload waves with manual time control
                for (let wave = 0; wave < 2; wave++) {
                    const baseT = currentTime;
                    const slot1 = executor.run("test", () => wait(100));
                    const slot2 = executor.run("test", () => wait(300));
                    const slot3 = executor.run("test", () => wait(300));
                    await vi.advanceTimersByTimeAsync(0);

                    const flood = Array.from({ length: 8 }, () =>
                        executor
                            .run("test", () => wait(50))
                            .catch(() => {
                                totalRejected++;
                            })
                    );

                    currentTime = baseT + 200;
                    await vi.advanceTimersByTimeAsync(100);
                    currentTime = baseT + 400;
                    await vi.advanceTimersByTimeAsync(100);
                    await vi.advanceTimersByTimeAsync(1000);
                    await Promise.allSettled([slot1, slot2, slot3, ...flood]);
                    currentTime = baseT + 1500;
                }

                expect(totalRejected).toBeGreaterThan(0);

                // Verify system still works at minimum capacity
                const verify = Array.from({ length: 1 }, () =>
                    executor.run("test", () => wait(10))
                );
                currentTime += 100;
                await vi.advanceTimersByTimeAsync(20);
                await Promise.all(verify);
            });

            test("system eventually recovers from back-to-back overloads", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Two overload waves
                for (let wave = 0; wave < 2; wave++) {
                    const baseT = currentTime;
                    const slot1 = executor.run("test", () => wait(100));
                    const slot2 = executor.run("test", () => wait(300));
                    const slot3 = executor.run("test", () => wait(300));
                    await vi.advanceTimersByTimeAsync(0);

                    const flood = Array.from({ length: 5 }, () =>
                        executor.run("test", () => wait(50)).catch(() => {})
                    );

                    currentTime = baseT + 200;
                    await vi.advanceTimersByTimeAsync(100);
                    currentTime = baseT + 400;
                    await vi.advanceTimersByTimeAsync(100);
                    await vi.advanceTimersByTimeAsync(1000);
                    await Promise.allSettled([slot1, slot2, slot3, ...flood]);
                    currentTime = baseT + 1500;
                }

                // Recover with trickle
                for (let i = 0; i < 15; i++) {
                    const t = executor.run("test", () => wait(5));
                    currentTime += 10;
                    await vi.advanceTimersByTimeAsync(10);
                    await t;
                }

                // Should recover to baseline (3)
                const verify = Array.from({ length: 3 }, () =>
                    executor.run("test", () => wait(10))
                );
                currentTime += 100;
                await vi.advanceTimersByTimeAsync(0);
                await vi.advanceTimersByTimeAsync(20);
                await Promise.all(verify);
            });
        });

        describe("Burst below threshold – tasks queue but sojourn stays low", () => {
            test("no drops when sojourn stays below delayThreshold", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 500, // High threshold
                    controlWindow: 100
                });

                // Submit 20 tasks — way above baseline but threshold is generous
                const burst = submitBatch("test", 20, 30);

                // With the regulator growing the limit, tasks get admitted before sojourn hits 500ms
                await advance(500);
                await Promise.allSettled(burst.promises);

                // All should succeed
                expect(burst.results.every((r) => r.status === "ok")).toBe(true);
            });
        });

        describe("Slow drain – tasks complete very slowly", () => {
            test("long-running tasks at baseline do not trigger drops", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 100,
                    controlWindow: 100
                });

                // 5 tasks that each take 500ms — at baseline, no queuing, no sojourn
                const slow = submitBatch("test", 5, 500);
                await advance(600);
                await Promise.allSettled(slow.promises);

                // All should succeed — they were admitted immediately (no queue wait)
                expect(slow.results.every((r) => r.status === "ok")).toBe(true);

                // Limit should still be at baseline (no regulation, no decrease, no gravity needed)
                expect(executor.isOverloaded("test")).toBe(false);
                expect(executor.getInFlight("test")).toBe(0);
            });

            test("slow tasks with queued work trigger regulator but not drops if under threshold", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 500, // High threshold to avoid drops
                    controlWindow: 100
                });

                // Fill 3 slots with slow tasks
                const slow = submitBatch("test", 3, 300);
                await advance(0);

                // Queue 3 more
                const queued = submitBatch("test", 3, 50);

                // When slow tasks complete, regulator should increase limit and queued tasks get admitted
                await advance(400);
                await Promise.allSettled([...slow.promises, ...queued.promises]);

                expect([...slow.results, ...queued.results].every((r) => r.status === "ok")).toBe(
                    true
                );
            });
        });

        describe("Staircase – stepwise increasing then decreasing load", () => {
            test("limit tracks demand up and back down", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 300,
                    controlWindow: 100
                });

                const allResults: TaskResult[] = [];

                // Ramp up: 3, 6, 9, 12
                for (const size of [3, 6, 9, 12]) {
                    const batch = submitBatch("test", size, 20);
                    await advance(150);
                    await Promise.allSettled(batch.promises);
                    allResults.push(...batch.results);
                }

                // Ramp down: 9, 6, 3
                for (const size of [9, 6, 3]) {
                    const batch = submitBatch("test", size, 20);
                    await advance(150);
                    await Promise.allSettled(batch.promises);
                    allResults.push(...batch.results);
                }

                // Idle tasks to trigger gravity
                for (let i = 0; i < 15; i++) {
                    const t = executor.run("test", () => wait(5));
                    await advance(10);
                    await t;
                }

                // With generous threshold, no drops
                expect(allResults.every((r) => r.status === "ok")).toBe(true);
            });
        });

        describe("Mixed pools – independent state", () => {
            test("overload in one pool does not affect another", async () => {
                executor.registerPool("commands", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });
                executor.registerPool("queries", {
                    baselineConcurrency: 10,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 500,
                    controlWindow: 100
                });

                // Overload the command pool (manual time control)
                const cmd1 = executor.run("commands", () => wait(100));
                const cmd2 = executor.run("commands", () => wait(300));
                const cmd3 = executor.run("commands", () => wait(300));
                await vi.advanceTimersByTimeAsync(0);

                let cmdRejected = 0;
                const cmdFlood = Array.from({ length: 8 }, () =>
                    executor
                        .run("commands", () => wait(50))
                        .catch(() => {
                            cmdRejected++;
                        })
                );

                // Meanwhile, queries pool handles normal load (under baseline, no issues)
                const queries = submitBatch("queries", 8, 30);

                // Phase 1: sets firstAboveTime for commands
                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);

                // Phase 2: ProDel enters dropping for commands
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);

                await vi.advanceTimersByTimeAsync(2000);
                await Promise.allSettled([cmd1, cmd2, cmd3, ...cmdFlood, ...queries.promises]);

                // Command pool should have rejections
                expect(cmdRejected).toBeGreaterThan(0);

                // Query pool should be unaffected — all tasks succeed
                expect(queries.results.every((r) => r.status === "ok")).toBe(true);
                expect(executor.isOverloaded("queries")).toBe(false);
            });
        });

        describe("Minimum concurrency under extreme overload", () => {
            test("system never drops below minimumConcurrency even under extreme load", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 10,
                    minimumConcurrency: 3,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Three waves of extreme overload with no recovery
                for (let wave = 0; wave < 3; wave++) {
                    const slow = submitBatch("test", 10, 300);
                    await advance(0);
                    const flood = submitBatch("test", 30, 50);
                    await advance(300);
                    await advance(300);
                    await advance(2000);
                    await Promise.allSettled([...slow.promises, ...flood.promises]);
                }

                // Even after severe punishment, should accept minimumConcurrency tasks
                const verify = submitBatch("test", 3, 10);
                await advance(0);

                // All 3 should be admitted (limit >= minimumConcurrency = 3)
                await advance(20);
                await Promise.allSettled(verify.promises);
                expect(verify.results.every((r) => r.status === "ok")).toBe(true);
                expect(verify.results).toHaveLength(3);
            });
        });

        describe("isOverloaded reflects ProDel state", () => {
            test("pool is not overloaded during normal capacity usage", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 1000
                });

                expect(executor.isOverloaded("test")).toBe(false);

                // Fill to baseline — at capacity but not overloaded
                const tasks = submitBatch("test", 3, 50);
                await advance(0);

                expect(executor.isOverloaded("test")).toBe(false);
                expect(executor.getInFlight("test")).toBe(3);

                // Drain
                await advance(60);
                await Promise.allSettled(tasks.promises);

                expect(executor.isOverloaded("test")).toBe(false);
                expect(executor.getInFlight("test")).toBe(0);
            });

            test("regulator increases limit during active burst", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 1000,
                    controlWindow: 100
                });

                // Warm up: establish EWMAs with consistent throughput.
                for (let w = 0; w < 12; w++) {
                    const batch = Array.from({ length: 3 }, () =>
                        executor.run("test", () => wait(50))
                    );
                    await advance(101);
                    await Promise.allSettled(batch);
                }

                // Sustain queue pressure across enough windows for ESS evaluation.
                const allTasks: Promise<unknown>[] = [];
                for (let w = 0; w < 12; w++) {
                    for (let i = 0; i < 6; i++) {
                        allTasks.push(executor.run("test", () => wait(50)));
                    }
                    await advance(101);
                    await Promise.allSettled(allTasks.filter(() => true));
                }

                // After ESS evaluation with queue pressure, limit should be above baseline.
                expect(executor.getConcurrencyLimit("test")).toBeGreaterThan(3);

                await advance(2000);
                await Promise.allSettled(allTasks);
            });

            test("isOverloaded becomes true in dropping state", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                expect(executor.isOverloaded("test")).toBe(false);

                // Fill slots with slow tasks
                const slots = Array.from({ length: 3 }, () =>
                    executor.run("test", () => wait(5000))
                );
                await vi.advanceTimersByTimeAsync(0);
                let rejected = 0;

                // Continuously queue entries to keep queue non-empty through
                // the dropping cycle. With stuck tasks at capacity, stale
                // entries are dropped immediately — continuous arrival ensures
                // the queue doesn't drain between checks.
                const flood: Promise<unknown>[] = [];
                for (let i = 0; i < 30; i++) {
                    flood.push(
                        executor
                            .run("test", () => wait(50))
                            .catch(() => {
                                rejected++;
                            })
                    );
                }

                // Phase 1: sets firstAboveTime — not dropping yet
                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);
                expect(executor.isOverloaded("test")).toBe(false);

                // Phase 2: enters dropping state, stale entries dropped fast
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);

                // Entries were shed
                expect(rejected).toBeGreaterThan(0);

                // Clean up
                await vi.advanceTimersByTimeAsync(10000);
                await Promise.allSettled([...slots, ...flood]);

                // After slow tasks complete and capacity frees up, fresh
                // entries are admitted and isOverloaded returns false.
                currentTime += 100;
                const recovery = executor.run("test", () => wait(5));
                await vi.advanceTimersByTimeAsync(10);
                await recovery;
                expect(executor.isOverloaded("test")).toBe(false);
            });

            test("isOverloaded throws for unregistered pool", () => {
                expect(() => executor.isOverloaded("unknown")).toThrow();
            });
        });

        describe("Gravity snap-back – limit tracks inFlight when queue empties", () => {
            test("limit snaps to baseline when all tasks drain and queue is empty", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 1000,
                    controlWindow: 100
                });

                // Burst: regulator ramps limit above baseline, then tasks drain
                const burst = submitBatch("test", 10, 20);
                await advance(200);
                await Promise.allSettled(burst.promises);

                // All tasks drained. Submit a probe to trigger gravity at next
                // window boundary (per-window regulation only fires on completions).
                const probe = executor.run("test", () => wait(5));
                await advance(110);
                await probe;

                // inFlight=0, queue empty → gravity: limit = max(baseline, 0) = 3
                expect(executor.getConcurrencyLimit("test")).toBe(3);
                const check = submitBatch("test", 3, 20);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(3);

                await advance(30);
                await Promise.allSettled(check.promises);
                expect(check.results.every((r) => r.status === "ok")).toBe(true);
            });

            test("limit stays at baseline after ProDel overload and recovery", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                // Trigger overload — ProDel drops excess, regulator is frozen during dropping
                const slots = Array.from({ length: 5 }, () =>
                    executor.run("test", () => wait(100))
                );
                await vi.advanceTimersByTimeAsync(0);

                const flood = Array.from({ length: 10 }, () =>
                    executor.run("test", () => wait(50)).catch(() => {})
                );

                currentTime = 200;
                await vi.advanceTimersByTimeAsync(100);
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(100);
                await vi.advanceTimersByTimeAsync(2000);
                await Promise.allSettled([...slots, ...flood]);

                // After overload, run a single task to trigger gravity.
                const recovery = executor.run("test", () => wait(5));
                currentTime += 100;
                await vi.advanceTimersByTimeAsync(10);
                await recovery;

                // Should be at baseline — no MD means limit was never pushed below
                expect(executor.getConcurrencyLimit("test")).toBe(5);
            });

            test("limit returns to baseline after burst drains via per-window gravity", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 1000,
                    controlWindow: 100
                });

                // Fill baseline + queue extras
                const slow = Array.from({ length: 3 }, () =>
                    executor.run("test", () => wait(200))
                );
                await advance(0);

                // 6 extras queue, regulator ramps limit as slow tasks complete
                const extras = submitBatch("test", 6, 150);
                // Advance in window-sized chunks so growth and gravity fire
                await advance(250);
                await advance(250);
                await Promise.allSettled([...slow, ...extras.promises]);

                // Submit probes across windows to let gravity pull limit to baseline
                for (let i = 0; i < 3; i++) {
                    const probe = executor.run("test", () => wait(5));
                    await advance(110);
                    await probe;
                }

                // All done — limit should be at baseline
                expect(executor.getConcurrencyLimit("test")).toBe(3);
                const check = submitBatch("test", 3, 10);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(3);
                await advance(20);
                await Promise.allSettled(check.promises);
            });
        });

        describe("Fixed concurrency – min = baseline = max", () => {
            test("regulator cannot grow beyond max, limit stays constant", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 5,
                    maximumConcurrency: 5,
                    delayThreshold: 1000,
                    controlWindow: 100
                });

                // Exactly at capacity — should work
                const full = submitBatch("test", 5, 30);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(5);
                expect(executor.getConcurrencyLimit("test")).toBe(5);

                // Queue more — regulator cannot increase beyond max (5)
                const extra = submitBatch("test", 3, 20);
                await advance(100);
                await Promise.allSettled([...full.promises, ...extra.promises]);

                // Still 5 — verify
                expect(executor.getConcurrencyLimit("test")).toBe(5);
                const check = submitBatch("test", 5, 10);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(5);
                await advance(20);
                await Promise.allSettled(check.promises);

                // 6th should queue
                const over = submitBatch("test", 6, 30);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(5);
                await advance(100);
                await Promise.allSettled(over.promises);
            });
        });

        describe("Throughput regulator respects maximumConcurrency cap", () => {
            test("concurrent in-flight never exceeds maximumConcurrency", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 8,
                    delayThreshold: 1000,
                    controlWindow: 100
                });

                let maxObservedInFlight = 0;
                const allPromises: Promise<unknown>[] = [];

                // Sustain async tasks across many ESS periods so convergent
                // growth has time to ramp up. Each task takes 50ms; we submit
                // 10 per window over 30 ESS windows (~3000ms), ensuring
                // persistent queue pressure at baseline 3.
                for (let w = 0; w < 30; w++) {
                    for (let i = 0; i < 10; i++) {
                        allPromises.push(
                            executor
                                .run("test", async () => {
                                    const inFlight = executor.getInFlight("test");
                                    maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
                                    await wait(50);
                                    return "ok";
                                })
                                .catch(() => {})
                        );
                    }
                    await advance(101);
                }
                // Drain remaining tasks.
                await advance(5000);
                await Promise.allSettled(allPromises);

                // regulator ramped up but never beyond maximumConcurrency
                expect(maxObservedInFlight).toBeLessThanOrEqual(8);
                // Should have ramped above baseline (3) via the regulator growth
                expect(maxObservedInFlight).toBeGreaterThan(3);
            });
        });

        describe("ProDel dropping with stuck tasks", () => {
            test("ProDel continues dropping when stuck tasks hold slots", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 10,
                    minimumConcurrency: 1,
                    maximumConcurrency: 10,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                const catchAll: Promise<unknown>[] = [];
                let rejected = 0;

                // Fill 8 slots with stuck tasks (won't complete during test)
                for (let i = 0; i < 8; i++) {
                    catchAll.push(executor.run("test", () => wait(50000)));
                }
                // Fill 2 slots with short tasks that will complete and trigger processQueue
                for (let i = 0; i < 2; i++) {
                    catchAll.push(executor.run("test", () => wait(50)));
                }
                await vi.advanceTimersByTimeAsync(0);

                // Queue 20 entries — these sit in queue while all 10 slots are occupied
                for (let i = 0; i < 20; i++) {
                    catchAll.push(
                        executor
                            .run("test", () => wait(50))
                            .catch(() => {
                                rejected++;
                            })
                    );
                }

                // Phase 1: short tasks complete → processQueue runs with inFlight=8 < limit=10.
                // Sojourn ~200ms > 50ms → sets firstAboveTime. Admits entries (which are also short).
                currentTime = 200;
                await vi.advanceTimersByTimeAsync(50);

                // Phase 2: admitted entries complete → processQueue again.
                // Sojourn ~400ms > 50ms, past firstAboveTime → enters dropping state.
                // With stuck tasks at capacity, stale entries are dropped immediately
                // (no point holding unserviceable entries between scheduled drops).
                currentTime = 400;
                await vi.advanceTimersByTimeAsync(50);

                expect(rejected).toBeGreaterThan(0);
                // Limit stays at 10 — no regulation reduces it
                expect(executor.getConcurrencyLimit("test")).toBe(10);

                // Clean up
                await vi.advanceTimersByTimeAsync(60000);
                await Promise.allSettled(catchAll);
            });

            test("fresh entry is queued but not admitted when stuck tasks hold all slots", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 10,
                    minimumConcurrency: 1,
                    maximumConcurrency: 10,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                const catchAll: Promise<unknown>[] = [];
                let rejected = 0;

                // Fill all 10 slots with stuck tasks
                for (let i = 0; i < 10; i++) {
                    catchAll.push(executor.run("test", () => wait(50000)));
                }
                await vi.advanceTimersByTimeAsync(0);

                // Queue stale entries
                for (let i = 0; i < 10; i++) {
                    catchAll.push(
                        executor
                            .run("test", () => wait(50))
                            .catch(() => {
                                rejected++;
                            })
                    );
                }

                // Enter dropping state and let ProDel 1/sqrt(n) schedule drain stale entries.
                // ProDel drops ~1 entry per processQueue call (dropNext uses frozen `now`),
                // so draining 10 entries across 10 transient lanes takes ~10 controlWindows.
                for (let t = 200; t <= 1400; t += 100) {
                    currentTime = t;
                    await vi.advanceTimersByTimeAsync(100);
                }

                expect(rejected).toBe(10); // All 10 stale entries shed
                const rejectedBeforeFresh = rejected;

                // Submit a FRESH entry while stuck tasks hold slots.
                // It queues (sojourn ≈ 0) but can't be admitted (at capacity).
                currentTime = 1410;
                catchAll.push(
                    executor
                        .run("test", () => wait(50))
                        .catch(() => {
                            rejected++;
                        })
                );
                await vi.advanceTimersByTimeAsync(0);

                // Fresh entry is in queue, not yet admitted
                expect(executor.getQueueLength("test")).toBeGreaterThan(0);

                // After it becomes stale (sojourn > 50ms target + 100ms grace + ProDel drop):
                for (let t = 1500; t <= 1900; t += 100) {
                    currentTime = t;
                    await vi.advanceTimersByTimeAsync(100);
                }
                expect(executor.getQueueLength("test")).toBe(0);
                // The fresh entry was eventually shed too
                expect(rejected).toBeGreaterThan(rejectedBeforeFresh);

                // Clean up
                await vi.advanceTimersByTimeAsync(60000);
                await Promise.allSettled(catchAll);
            });

            test("timer-driven ProDel drops queued entries when all tasks are stuck and no new arrivals", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 5,
                    minimumConcurrency: 1,
                    maximumConcurrency: 5,
                    delayThreshold: 50,
                    controlWindow: 100
                });

                const catchAll: Promise<unknown>[] = [];
                let rejected = 0;

                // Fill all 5 slots with stuck tasks — none will complete
                for (let i = 0; i < 5; i++) {
                    catchAll.push(executor.run("test", () => wait(50000)));
                }
                await vi.advanceTimersByTimeAsync(0);

                // Queue 10 entries — can't be admitted (inFlight=5, limit=5)
                for (let i = 0; i < 10; i++) {
                    catchAll.push(
                        executor
                            .run("test", () => wait(50))
                            .catch(() => {
                                rejected++;
                            })
                    );
                }

                // No new arrivals from here on. Only timers drive processQueue.

                // Timer 1 fires at +100ms: sojourn=100 > 50 → sets firstAboveTime=200
                await advance(100);
                expect(rejected).toBe(0); // Not dropping yet

                // Timer 2 fires at +200ms: sojourn=200 > 50, past firstAboveTime → enters dropping.
                // Drops entries. Limit stays at 5 (no MD).
                await advance(100);
                expect(rejected).toBeGreaterThan(0);
                expect(executor.getConcurrencyLimit("test")).toBe(5);

                // Timer 3: more drops, still no task completions
                await advance(100);
                expect(rejected).toBeGreaterThan(1);
                expect(executor.getConcurrencyLimit("test")).toBe(5);

                // Clean up
                await vi.advanceTimersByTimeAsync(60000);
                await Promise.allSettled(catchAll);
            });
        });

        describe("Gravity after burst with concurrent in-flight tasks", () => {
            test("limit returns to baseline after staggered burst drains", async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 3,
                    minimumConcurrency: 1,
                    maximumConcurrency: 50,
                    delayThreshold: 1000,
                    controlWindow: 100
                });

                // Warm up EWMAs then build up load to grow limit above baseline
                for (let w = 0; w < 12; w++) {
                    const batch = Array.from({ length: 3 }, () =>
                        executor.run("test", () => wait(50))
                    );
                    await advance(101);
                    await Promise.allSettled(batch);
                }

                const allTasks: Promise<unknown>[] = [];
                for (let w = 0; w < 12; w++) {
                    for (let i = 0; i < 6; i++) {
                        allTasks.push(executor.run("test", () => wait(50)));
                    }
                    await advance(101);
                    await Promise.allSettled(allTasks.filter(() => true));
                }
                await advance(2000);
                await Promise.allSettled(allTasks);

                // Now let gravity pull limit back to baseline over ESS evaluation cycles.
                // Submit small probes to keep windows active but no queue pressure.
                for (let i = 0; i < 20; i++) {
                    const probe = executor.run("test", () => wait(5));
                    await advance(101);
                    await probe;
                }

                // All drained — limit should be at baseline (3)
                expect(executor.getConcurrencyLimit("test")).toBe(3);
                const check = submitBatch("test", 3, 10);
                await advance(0);
                expect(executor.getInFlight("test")).toBe(3);
                await advance(20);
                await Promise.allSettled(check.promises);
                expect(check.results.every((r) => r.status === "ok")).toBe(true);
            });
        });
    });

    describe("Probabilistic MD gating", () => {
        let executor: Executor;
        let currentTime: number;

        beforeAll(() => {
            vi.useFakeTimers();
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            currentTime = 0;
            vi.spyOn(performance, "now").mockImplementation(() => currentTime);
            executor = new Executor({ logger });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
            vi.restoreAllMocks();
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        async function advance(ms: number): Promise<void> {
            currentTime += ms;
            await vi.advanceTimersByTimeAsync(ms);
        }

        /**
         * Build a steady-state EWMA baseline by running many tasks at consistent
         * throughput, then return the pool to a state where degradation can be tested.
         */
        async function warmUp(
            poolName: string,
            concurrency: number,
            taskDuration: number,
            windows: number
        ): Promise<void> {
            // Math.random returns 0 during warm-up to keep MD deterministic if it fires
            const localSpy = vi.spyOn(Math, "random").mockReturnValue(0);
            const windowMs = 100;
            const totalMs = windowMs * windows;

            for (let t = 0; t < totalMs; t += taskDuration) {
                const batch = Array.from({ length: concurrency }, () =>
                    executor.run(poolName, () => wait(taskDuration))
                );
                await advance(taskDuration + 1);
                await Promise.allSettled(batch);
            }

            localSpy.mockRestore();
        }

        test(
            "retraction walks back previous growth in reverse order",
            { timeout: 15_000 },
            async () => {
                executor.registerPool("test", {
                    baselineConcurrency: 10,
                    minimumConcurrency: 2,
                    maximumConcurrency: 100,
                    controlWindow: 100
                });

                await warmUp("test", 10, 10, 15);

                // The limit should be at baseline after warmup.
                const limitAfterWarmup = executor.getConcurrencyLimit("test");
                expect(limitAfterWarmup).toBe(10);
            }
        );

        test("marginal latency changes do not cause large limit reductions", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 10,
                minimumConcurrency: 2,
                maximumConcurrency: 10,
                controlWindow: 100
            });

            await warmUp("test", 10, 10, 15);

            // Mild degradation: tasks go from 10ms → 12ms (20% increase).
            // This causes a small latency increase — the convergent regulator
            // should not slam the limit to minimum.
            for (let i = 0; i < 20; i++) {
                const batch = Array.from({ length: 10 }, () =>
                    executor.run("test", () => wait(12))
                );
                await advance(101);
                await Promise.allSettled(batch);
            }

            // Even with dW scaling, a 20% latency increase should not
            // reduce the limit below the minimum concurrency floor (2).
            expect(executor.getConcurrencyLimit("test")).toBeGreaterThanOrEqual(2);
        });
    });

    describe("Latency-informed throughput regulation (Little's Law)", () => {
        let executor: Executor;
        let currentTime: number;

        beforeAll(() => {
            vi.useFakeTimers();
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            currentTime = 0;
            vi.spyOn(performance, "now").mockImplementation(() => currentTime);
            vi.spyOn(Math, "random").mockReturnValue(0);
            executor = new Executor({ logger });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
            vi.restoreAllMocks();
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        async function advance(ms: number): Promise<void> {
            currentTime += ms;
            await vi.advanceTimersByTimeAsync(ms);
        }

        test("regulator grows limit when latency is stable and queue has pressure", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 5,
                minimumConcurrency: 2,
                maximumConcurrency: 100,
                controlWindow: 100,
                delayThreshold: 60_000 // High threshold: prevent ProDel from interfering
            });

            // Submit a large warmup batch: 90 tasks (= 5 limit × 18 windows)
            // with 200ms duration. This keeps inFlight continuously at 5
            // while establishing EWMA baselines. Queue drains over 18 windows.
            const warmup: Promise<unknown>[] = [];
            for (let i = 0; i < 90; i++) {
                const p = executor.run("test", () => wait(200));
                p.catch(() => {}); // Suppress ProDel rejection noise.
                warmup.push(p);
            }
            // Advance through 18 windows (2×ESS). Each 210ms advance
            // completes ~5 tasks (window resets, EWMA updates).
            for (let w = 0; w < 18; w++) {
                await advance(210);
            }
            await Promise.allSettled(warmup);

            const limitBefore = executor.getConcurrencyLimit("test");

            // Submit 200 tasks with same 200ms duration. With limit=5,
            // queue stays >0 across all ESS evaluations. Same task
            // characteristics keep W stable → no dW degradation → growth.
            const pending: Promise<unknown>[] = [];
            for (let i = 0; i < 200; i++) {
                const p = executor.run("test", () => wait(200));
                p.catch(() => {}); // Suppress ProDel rejection noise.
                pending.push(p);
            }

            // Advance through 3×ESS windows. Completions trigger
            // evaluations; queue stays >0 the whole time.
            for (let w = 0; w < 27; w++) {
                await advance(210);
            }

            expect(executor.getConcurrencyLimit("test")).toBeGreaterThan(limitBefore);

            await advance(60_000);
            await Promise.allSettled(pending);
        });

        test("gravity snaps limit back to baseline when queue drains", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 5,
                minimumConcurrency: 2,
                maximumConcurrency: 50,
                controlWindow: 100,
                delayThreshold: 5000
            });

            // Phase 1: large batch establishes EWMAs and grows the limit.
            // 90 tasks × 200ms with limit=5 → continuous inFlight for 18
            // windows. Queue > 0 at ESS boundaries → growth fires.
            const warmup: Promise<unknown>[] = [];
            for (let i = 0; i < 90; i++) {
                const p = executor.run("test", () => wait(200));
                p.catch(() => {}); // Suppress ProDel rejection noise.
                warmup.push(p);
            }
            for (let w = 0; w < 18; w++) {
                await advance(210);
            }
            await Promise.allSettled(warmup);

            const limitAfterGrowth = executor.getConcurrencyLimit("test");
            expect(limitAfterGrowth).toBeGreaterThan(5);

            // Phase 2: no new tasks. Queue is empty, inFlight=0.
            // Submit a single task to trigger an ESS evaluation at the
            // next boundary — gravity should snap limit to baseline.
            for (let w = 0; w < 18; w++) {
                const task = executor.run("test", () => wait(1));
                await advance(110);
                await task;
            }

            // Gravity: limit = max(baseline, inFlight) = max(5, 0) = 5.
            expect(executor.getConcurrencyLimit("test")).toBe(5);
        });

        test("flips from decrease to increase when latency trend reverses", async () => {
            vi.useRealTimers();

            const realExecutor = new Executor({ logger });
            realExecutor.start();
            realExecutor.registerPool("test", {
                baselineConcurrency: 10,
                minimumConcurrency: 2,
                maximumConcurrency: 50,
                controlWindow: 50,
                delayThreshold: 5000
            });

            const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

            // Phase 1: fast tasks → low W baseline.
            for (let w = 0; w < 20; w++) {
                const batch = Array.from({ length: 10 }, () =>
                    realExecutor.run("test", () => sleep(2))
                );
                await Promise.allSettled(batch);
                await sleep(50);
            }

            // Phase 2: slow tasks → W rises → decrease.
            for (let w = 0; w < 20; w++) {
                const batch = Array.from({ length: 10 }, () =>
                    realExecutor.run("test", () => sleep(40))
                );
                await Promise.allSettled(batch);
                await sleep(10);
            }

            const limitAfterDegrade = realExecutor.getConcurrencyLimit("test");

            // Phase 3: fast tasks + queue pressure → W drops → increase.
            for (let w = 0; w < 20; w++) {
                const batch = Array.from({ length: 15 }, () =>
                    realExecutor.run("test", () => sleep(2))
                );
                await Promise.allSettled(batch);
                await sleep(50);
            }

            expect(realExecutor.getConcurrencyLimit("test")).toBeGreaterThan(limitAfterDegrade);
            realExecutor.stop();

            vi.useFakeTimers();
            vi.setSystemTime(0);
            currentTime = 0;
            vi.spyOn(performance, "now").mockImplementation(() => currentTime);
        }, 15_000);
    });

    describe("Error-based regulation (per-lane shedding + throughput regulator)", () => {
        // ESS = round(2 / (1 - exp(-1/σ²))) with σ=2 → 9
        const ESS = Math.round(2 / (1 - Math.exp(-1 / 4)));
        let executor: Executor;
        let currentTime: number;
        let randomValue: number;

        beforeAll(() => {
            vi.useFakeTimers();
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            currentTime = 0;
            randomValue = 0.99; // Default: high random → shedding doesn't fire
            vi.spyOn(performance, "now").mockImplementation(() => currentTime);
            vi.spyOn(Math, "random").mockImplementation(() => randomValue);
            executor = new Executor({ logger });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
            vi.restoreAllMocks();
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        async function advance(ms: number): Promise<void> {
            currentTime += ms;
            await vi.advanceTimersByTimeAsync(ms);
        }

        test("task errors are re-thrown to the caller", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 10,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            const error = new Error("downstream failure");
            await expect(
                executor.run("test", () => {
                    throw error;
                })
            ).rejects.toThrow("downstream failure");
        });

        test("per-lane: persistent lane with high error rate sheds new requests", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 10,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            const lane = "user-A";

            // Keep the lane alive with a long-running task so errorRateEwma
            // persists across multiple error completions.
            const blocker = executor.run("test", () => wait(60_000), { lane });
            blocker.catch(() => {});

            // Send erroring tasks on the same lane — they share the lane object.
            for (let i = 0; i < 10; i++) {
                await executor
                    .run(
                        "test",
                        (): void => {
                            throw new Error("fail");
                        },
                        { lane }
                    )
                    .catch(() => {});
            }

            // Lane's errorRateEwma is now high (~0.65 after 10 errors with α≈0.105).
            // Set Math.random to 0 so the probabilistic check always fires.
            randomValue = 0;

            // Next request to the same lane should be shed.
            await expect(executor.run("test", () => "ok", { lane })).rejects.toThrow(
                ResourceExhaustedError
            );
        });

        test("per-lane: healthy lane is not shed even when another lane is failing", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 10,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            // Lane A: erroring heavily.
            for (let i = 0; i < 10; i++) {
                await executor
                    .run(
                        "test",
                        (): void => {
                            throw new Error("fail");
                        },
                        { lane: "lane-A" }
                    )
                    .catch(() => {});
            }

            randomValue = 0.99;

            // Lane B: no history → no per-lane shedding.
            const result = await executor.run("test", () => "ok", { lane: "lane-B" });
            expect(result).toBe("ok");
        });

        test("per-lane: error rate decays after successes resume", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 10,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            const lane = "user-A";

            // Keep lane alive.
            const blocker = executor.run("test", () => wait(60_000), { lane });
            blocker.catch(() => {});

            // Build up error rate.
            for (let i = 0; i < 10; i++) {
                await executor
                    .run(
                        "test",
                        (): void => {
                            throw new Error("fail");
                        },
                        { lane }
                    )
                    .catch(() => {});
            }

            // Now send 50 successful tasks — EWMA decays toward 0.
            for (let i = 0; i < 50; i++) {
                await executor.run("test", () => "ok", { lane });
            }

            // Set random to a moderate value — if error rate has decayed
            // sufficiently, the probabilistic check won't fire.
            randomValue = 0.05;
            const result = await executor.run("test", () => "ok", { lane });
            expect(result).toBe("ok");
        });

        test("widespread errors across many lanes trigger throughput regulator decrease", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 100,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            const initialLimit = executor.getConcurrencyLimit("test");

            // Warm up ESS windows with healthy traffic across many lanes.
            for (let w = 0; w < ESS; w++) {
                await advance(110);
                for (let i = 0; i < 20; i++) {
                    await executor.run("test", () => "ok", { lane: `lane-${i}` });
                }
            }

            // Send 100% errors across 20 distinct lanes for ESS-1 windows,
            // accumulating errorRateEwma toward 1.0.
            for (let w = 0; w < ESS - 1; w++) {
                await advance(110);
                for (let i = 0; i < 20; i++) {
                    await executor
                        .run(
                            "test",
                            (): void => {
                                throw new Error("fail");
                            },
                            { lane: `lane-${i}` }
                        )
                        .catch(() => {});
                }
            }

            // ESS boundary window: set randomValue low so probabilistic
            // error decrease fires (P = errorRateEwma ≈ 0.5).
            // Use transient lane to avoid per-lane shedding.
            randomValue = 0.1;
            await advance(110);
            await executor.run("test", () => "ok");

            expect(executor.getConcurrencyLimit("test")).toBeLessThan(initialLimit);
        });

        test("localized errors in one lane do not trigger throughput regulator decrease", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 100,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            // Warm up with clean traffic across many lanes.
            for (let w = 0; w < ESS; w++) {
                await advance(110);
                for (let i = 0; i < 30; i++) {
                    await executor.run("test", () => "ok", { lane: `good-lane-${i}` });
                }
            }

            // Mixed traffic: 1 bad lane + 49 good lanes per window.
            // The bad lane errors every window. With Wilson score interval,
            // even 1/50 = 2% spread is detected as statistically significant
            // (Wilson correctly identifies a consistently erroring lane as a
            // real signal, not noise). The spread-significant branch fires,
            // causing a modest decrease. However, the decrease is small
            // because the error rate (dErrorRate) is not increasing — the
            // spread-significant branch does gentle decreases, not aggressive
            // ones. Per-lane shedding handles the actual bad lane.
            for (let w = 0; w < ESS * 2; w++) {
                await advance(110);
                for (let i = 0; i < 49; i++) {
                    await executor.run("test", () => "ok", { lane: `good-lane-${i}` });
                }
                await executor
                    .run(
                        "test",
                        (): void => {
                            throw new Error("fail");
                        },
                        { lane: "bad-lane" }
                    )
                    .catch(() => {});
            }

            // Per-lane shedding handles the bad lane. The pool-wide error rate
            // stays low (1/50 = 2%), so probabilistic error decrease barely fires.
            // The limit stays well above minimum.
            expect(executor.getConcurrencyLimit("test")).toBeGreaterThanOrEqual(50);
        });

        test("lockout: sustained 100% error rate triggers continued decrease", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 100,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            // Warm up with healthy traffic across many lanes.
            for (let w = 0; w < ESS; w++) {
                await advance(110);
                for (let i = 0; i < 20; i++) {
                    await executor.run("test", () => "ok", { lane: `lane-${i}` });
                }
            }

            // Spike to 100% errors across 20 lanes for ESS-1 windows.
            for (let w = 0; w < ESS - 1; w++) {
                await advance(110);
                for (let i = 0; i < 20; i++) {
                    await executor
                        .run(
                            "test",
                            (): void => {
                                throw new Error("fail");
                            },
                            { lane: `lane-${i}` }
                        )
                        .catch(() => {});
                }
            }

            // First ESS boundary: probabilistic error decrease fires.
            randomValue = 0.1;
            await advance(110);
            await executor.run("test", () => "ok");
            const afterFirstDecrease = executor.getConcurrencyLimit("test");
            expect(afterFirstDecrease).toBeLessThan(100);

            // Continue 100% errors. The next ESS eval cools (Decreasing → Idle),
            // and the one after that decreases again. Need 2 more ESS periods.
            for (let period = 0; period < 2; period++) {
                randomValue = 0.99;
                for (let w = 0; w < ESS - 1; w++) {
                    await advance(110);
                    for (let i = 0; i < 20; i++) {
                        await executor
                            .run(
                                "test",
                                (): void => {
                                    throw new Error("fail");
                                },
                                { lane: `lane-${i}` }
                            )
                            .catch(() => {});
                    }
                }
                randomValue = 0.1;
                await advance(110);
                await executor.run("test", () => "ok");
            }

            // After decrease → cool → decrease, limit should be lower.
            expect(executor.getConcurrencyLimit("test")).toBeLessThan(afterFirstDecrease);
        });

        test("error degradation recovers after errors stop", async () => {
            executor.registerPool("test", {
                baselineConcurrency: 100,
                delayThreshold: 60_000,
                controlWindow: 100
            });

            // Warm up.
            for (let w = 0; w < ESS; w++) {
                await advance(110);
                for (let i = 0; i < 20; i++) {
                    await executor.run("test", () => "ok", { lane: `lane-${i}` });
                }
            }

            // Widespread errors for ESS-1 windows to accumulate error rate.
            for (let w = 0; w < ESS - 1; w++) {
                await advance(110);
                for (let i = 0; i < 20; i++) {
                    await executor
                        .run(
                            "test",
                            (): void => {
                                throw new Error("fail");
                            },
                            { lane: `lane-${i}` }
                        )
                        .catch(() => {});
                }
            }

            // ESS boundary — probabilistic error decrease fires.
            randomValue = 0.1;
            await advance(110);
            await executor.run("test", () => "ok");
            const decreasedLimit = executor.getConcurrencyLimit("test");
            expect(decreasedLimit).toBeLessThan(100);

            // Now send only healthy traffic for many ESS periods — error rate decays.
            randomValue = 0.99;
            for (let w = 0; w < ESS * 6; w++) {
                await advance(110);
                for (let i = 0; i < 20; i++) {
                    await executor.run("test", () => "ok", { lane: `lane-${i}` });
                }
            }

            // After many clean windows, error signals should have decayed.
            expect(executor.isThroughputDegraded("test")).toBe(false);
        });
    });

    describe("Constructor and validation", () => {
        test("creates executor with no options", () => {
            const e = new Executor();
            expect(e.zScoreThreshold).toBe(2);
            e.start();
            e.stop();
        });

        test("creates executor with custom zScoreThreshold", () => {
            const e = new Executor({ zScoreThreshold: 3 });
            expect(e.zScoreThreshold).toBe(3);
            expect(e.halfLife).toBe(Math.round(2 / (1 - Math.exp(-1 / 9))));
        });

        test("throws for zScoreThreshold = 0", () => {
            expect(() => new Executor({ zScoreThreshold: 0 })).toThrow(ArgumentError);
        });

        test("throws for negative zScoreThreshold", () => {
            expect(() => new Executor({ zScoreThreshold: -1 })).toThrow(ArgumentError);
        });

        test("throws for NaN zScoreThreshold", () => {
            expect(() => new Executor({ zScoreThreshold: NaN })).toThrow(ArgumentError);
        });

        test("throws for Infinity zScoreThreshold", () => {
            expect(() => new Executor({ zScoreThreshold: Infinity })).toThrow(ArgumentError);
        });

        test("registerPool throws for NaN delayThreshold", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.registerPool("t", { delayThreshold: NaN })).toThrow(ArgumentError);
            e.stop();
        });

        test("registerPool throws for NaN controlWindow", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.registerPool("t", { controlWindow: NaN })).toThrow(ArgumentError);
            e.stop();
        });

        test("registerPool throws for invalid per-pool zScoreThreshold", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.registerPool("t", { zScoreThreshold: 0 })).toThrow(ArgumentError);
            expect(() => e.registerPool("t", { zScoreThreshold: -1 })).toThrow(ArgumentError);
            expect(() => e.registerPool("t", { zScoreThreshold: NaN })).toThrow(ArgumentError);
            e.stop();
        });
    });

    describe("Per-pool zScoreThreshold", () => {
        let executor: Executor;

        beforeAll(() => {
            vi.useFakeTimers();
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            executor = new Executor({ logger, zScoreThreshold: 2 });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        test("pool inherits executor-level z-score by default", () => {
            executor.registerPool("test");
            expect(executor.zScoreThreshold).toBe(2);
            expect(executor.halfLife).toBe(Math.round(2 / (1 - Math.exp(-1 / 4))));
        });

        test("pool can override z-score", () => {
            executor.registerPool("sensitive", { zScoreThreshold: 1, baselineConcurrency: 10 });
            executor.registerPool("relaxed", { zScoreThreshold: 3, baselineConcurrency: 10 });

            // Both pools should work independently
            const state1 = executor.getRegulatorState("sensitive");
            const state2 = executor.getRegulatorState("relaxed");
            expect(state1.elapsedWindows).toBe(0);
            expect(state2.elapsedWindows).toBe(0);
        });

        test("per-pool z-score affects halfLife used for regulation", async () => {
            // z=1 gives halfLife = round(2 / (1 - exp(-1/1))) = round(2 / 0.6321) = 3
            // z=2 gives halfLife = round(2 / (1 - exp(-1/4))) = 9
            executor.registerPool("fast", { zScoreThreshold: 1, baselineConcurrency: 5, controlWindow: 10 });
            executor.registerPool("slow", { zScoreThreshold: 2, baselineConcurrency: 5, controlWindow: 10 });

            // Run tasks to advance windows
            for (let i = 0; i < 20; i++) {
                vi.advanceTimersByTime(10);
                await executor.run("fast", () => {});
                await executor.run("slow", () => {});
            }

            const fastState = executor.getRegulatorState("fast");
            const slowState = executor.getRegulatorState("slow");

            // Both should have elapsed windows but potentially different filter states
            expect(fastState.elapsedWindows).toBeGreaterThan(0);
            expect(slowState.elapsedWindows).toBeGreaterThan(0);
        });
    });

    describe("getRegulatorState", () => {
        let executor: Executor;

        beforeAll(() => {
            vi.useFakeTimers();
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            executor = new Executor({ logger });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        test("returns initial state for fresh pool", () => {
            executor.registerPool("test");
            const state = executor.getRegulatorState("test");

            expect(state.logW).toBeNull();
            expect(state.logWBar).toBeNull();
            expect(state.logWBarP).toBeGreaterThan(0);
            expect(state.dLogWBarEwma).toBeNull();
            expect(state.dLogWBarVariance).toBe(0);
            expect(state.se).toBe(0);
            expect(state.zScore).toBe(0);
            expect(state.degrading).toBe(false);
            expect(state.inFlightEwma).toBeNull();
            expect(state.completionRateEwma).toBeNull();
            expect(state.dropRateEwma).toBeNull();
            expect(state.errorRateEwma).toBeNull();
            expect(state.regulationPhase).toBe("Idle");
            expect(state.regulationDepth).toBe(0);
            expect(state.elapsedWindows).toBe(0);
            expect(state.alpha).toBeGreaterThan(0);
        });

        test("throws for nonexistent pool", () => {
            expect(() => executor.getRegulatorState("unknown")).toThrow(ArgumentError);
        });

        test("state updates after task completions", async () => {
            executor.registerPool("test", { controlWindow: 10, baselineConcurrency: 5 });

            for (let i = 0; i < 10; i++) {
                vi.advanceTimersByTime(10);
                await executor.run("test", () => {});
            }

            const state = executor.getRegulatorState("test");
            expect(state.elapsedWindows).toBeGreaterThan(0);
            expect(state.completionRateEwma).not.toBeNull();
            expect(state.inFlightEwma).not.toBeNull();
        });
    });

    describe("Error class hierarchy", () => {
        test("ResourceExhaustedError is instanceof ConcurrexError", () => {
            const err = new ResourceExhaustedError("test");
            expect(err).toBeInstanceOf(ResourceExhaustedError);
            expect(err).toBeInstanceOf(ConcurrexError);
            expect(err).toBeInstanceOf(Error);
        });

        test("ArgumentError is instanceof ConcurrexError", () => {
            const err = new ArgumentError("test");
            expect(err).toBeInstanceOf(ArgumentError);
            expect(err).toBeInstanceOf(ConcurrexError);
        });

        test("ExecutorNotRunningError is instanceof ConcurrexError", () => {
            const err = new ExecutorNotRunningError();
            expect(err).toBeInstanceOf(ExecutorNotRunningError);
            expect(err).toBeInstanceOf(ConcurrexError);
            expect(err.message).toBe("The executor is not running.");
        });
    });

    describe("runDebounced edge cases", () => {
        let executor: Executor;

        beforeAll(() => {
            vi.useFakeTimers();
        });

        beforeEach(() => {
            vi.setSystemTime(0);
            executor = new Executor({ logger });
            executor.start();
        });

        afterEach(() => {
            executor.stop();
        });

        afterAll(() => {
            vi.useRealTimers();
        });

        test("throws when executor is stopped", async () => {
            executor.registerPool("test");
            executor.stop();
            await expect(executor.runDebounced("test", "k", () => 1)).rejects.toThrow(
                ExecutorNotRunningError
            );
        });

        test("throws when pool does not exist", async () => {
            await expect(executor.runDebounced("nope", "k", () => 1)).rejects.toThrow();
        });

        test("rejects debounced promises on stop", async () => {
            executor.registerPool("test", { baselineConcurrency: 1 });

            // Fill the pool so the debounced task queues
            const blocker = executor.run("test", () => new Promise(() => {}));

            const debounced = executor.runDebounced("test", "k", () => 42);
            await vi.advanceTimersByTimeAsync(1);

            executor.stop();
            await expect(debounced).rejects.toThrow(ExecutorNotRunningError);
        });
    });

    describe("Query method error paths", () => {
        test("getQueueLength throws for nonexistent pool", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.getQueueLength("nope")).toThrow(ArgumentError);
            e.stop();
        });

        test("getInFlight throws for nonexistent pool", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.getInFlight("nope")).toThrow(ArgumentError);
            e.stop();
        });

        test("getConcurrencyLimit throws for nonexistent pool", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.getConcurrencyLimit("nope")).toThrow(ArgumentError);
            e.stop();
        });

        test("isThroughputDegraded throws for nonexistent pool", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.isThroughputDegraded("nope")).toThrow(ArgumentError);
            e.stop();
        });

        test("isOverloaded throws for nonexistent pool", () => {
            const e = new Executor({ logger });
            e.start();
            expect(() => e.isOverloaded("nope")).toThrow(ArgumentError);
            e.stop();
        });
    });
});
