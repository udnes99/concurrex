#!/usr/bin/env npx tsx
/**
 * Benchmark runner — starts each server, runs autocannon, collects results.
 *
 * Usage:
 *   npx tsx benchmarks/run.ts                         # all benchmarks, both modes
 *   npx tsx benchmarks/run.ts cpu-bound               # one benchmark, both modes
 *   npx tsx benchmarks/run.ts cpu-bound async-io      # specific benchmarks
 *   npx tsx benchmarks/run.ts --bare                  # all benchmarks, bare only
 *   npx tsx benchmarks/run.ts --concurrex cpu-bound   # one benchmark, concurrex only
 *
 * Results are printed as a comparison table and written to benchmarks/results.html.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

// ── Benchmark registry ───────────────────────────────────────────────

const BENCHMARKS: Record<string, { file: string; port: number; connections: number; duration: number }> = {
    "async-io":      { file: "async-io.ts",      port: 3000, connections: 200, duration: 10 },
    "cpu-bound":     { file: "cpu-bound.ts",      port: 3001, connections: 50,  duration: 10 },
    "mixed-latency": { file: "mixed-latency.ts",  port: 3002, connections: 100, duration: 15 },
    "contention":    { file: "contention.ts",     port: 3003, connections: 100, duration: 15 },
};

// ── Types ────────────────────────────────────────────────────────────

interface AutocannonResult {
    requests: { average: number; total: number };
    latency: { p50: number; p99: number; average: number; max: number };
    "2xx": number;
    non2xx: number;
    errors: number;
}

type Mode = "concurrex" | "bare";

interface BenchmarkRun {
    concurrex?: AutocannonResult;
    bare?: AutocannonResult;
}

// ── Helpers ──────────────────────────────────────────────────────────

const root = path.resolve(import.meta.dirname, "..");

function startServer(file: string, bare: boolean): ChildProcess {
    const args = [path.join("benchmarks", file)];
    if (bare) args.push("--bare");
    const proc = spawn("npx", ["tsx", ...args], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
    });
    return proc;
}

async function waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://localhost:${port}/health`);
            if (res.ok) return;
        } catch { /* not ready yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Server on port ${port} did not become healthy within ${timeoutMs}ms`);
}

function runAutocannon(port: number, connections: number, duration: number): AutocannonResult {
    const out = execFileSync("npx", [
        "autocannon", "-c", String(connections), "-d", String(duration),
        "-j", `http://localhost:${port}/`,
    ], { cwd: root, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" });
    return JSON.parse(out);
}

async function killServer(proc: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
        proc.on("exit", () => resolve());
        proc.kill("SIGINT");
        setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
            resolve();
        }, 5_000);
    });
}

// ── Comparison table ─────────────────────────────────────────────────

function pct2xx(r: AutocannonResult): number {
    const total = r["2xx"] + r.non2xx;
    return total > 0 ? (r["2xx"] / total) * 100 : 0;
}

function fmt(n: number, decimals = 0): string {
    return n.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

function printTable(results: Map<string, BenchmarkRun>, modes: Mode[]) {
    const rows: string[] = [];
    const hasBoth = modes.length === 2;
    const w = hasBoth ? [20, 20, 14, 14] : [20, 20, 14];
    const sep = `├${w.map((n) => "─".repeat(n)).join("┼")}┤`;
    const top = `┌${w.map((n) => "─".repeat(n)).join("┬")}┐`;
    const bot = `└${w.map((n) => "─".repeat(n)).join("┴")}┘`;
    const pad = (s: string, n: number) => (" " + s).padEnd(n);
    const padr = (s: string, n: number) => (s + " ").padStart(n);

    rows.push(top);
    const header = `│${pad("Benchmark", w[0])}│${pad("Metric", w[1])}│${modes.map((m, i) => padr(m, w[i + 2])).join("│")}│`;
    rows.push(header);

    const val = (r: AutocannonResult | undefined, fn: (r: AutocannonResult) => string) => r ? fn(r) : "—";

    for (const [name, run] of results) {
        rows.push(sep);
        const metrics: [string, ...string[]][] = [
            ["Req/s (avg)",      ...modes.map((m) => val(run[m], (r) => fmt(r.requests.average)))],
            ["Latency p50 (ms)", ...modes.map((m) => val(run[m], (r) => fmt(r.latency.p50)))],
            ["Latency p99 (ms)", ...modes.map((m) => val(run[m], (r) => fmt(r.latency.p99)))],
            ["Max latency (ms)", ...modes.map((m) => val(run[m], (r) => fmt(r.latency.max)))],
            ["2xx %",            ...modes.map((m) => val(run[m], (r) => fmt(pct2xx(r), 1) + "%"))],
            ["Errors",           ...modes.map((m) => val(run[m], (r) => fmt(r.errors)))],
        ];
        for (let i = 0; i < metrics.length; i++) {
            const [metric, ...vals] = metrics[i];
            const label = i === 0 ? name : "";
            rows.push(`│${pad(label, w[0])}│${pad(metric, w[1])}│${vals.map((v, j) => padr(v, w[j + 2])).join("│")}│`);
        }
    }
    rows.push(bot);
    console.log(rows.join("\n"));
}

// ── CSV report ───────────────────────────────────────────────────────

function generateCsv(results: Map<string, BenchmarkRun>, modes: Mode[]): string {
    const header = ["benchmark", "mode", "req_s_avg", "latency_p50_ms", "latency_p99_ms", "latency_max_ms", "2xx_pct", "errors"];
    const rows: string[] = [header.join(",")];

    for (const [name, run] of results) {
        for (const mode of modes) {
            const r = run[mode];
            if (!r) continue;
            rows.push([
                name,
                mode,
                r.requests.average,
                r.latency.p50,
                r.latency.p99,
                r.latency.max,
                pct2xx(r).toFixed(1),
                r.errors,
            ].join(","));
        }
    }
    return rows.join("\n") + "\n";
}

// ── HTML report ──────────────────────────────────────────────────────

function generateHtml(results: Map<string, BenchmarkRun>, modes: Mode[]): string {
    const sections: string[] = [];

    for (const [name, run] of results) {
        type MetricDef = { label: string; get: (r: AutocannonResult) => number; unit: string; lowerBetter: boolean };
        const metricDefs: MetricDef[] = [
            { label: "Avg Req/s",   get: (r) => r.requests.average, unit: "",   lowerBetter: false },
            { label: "Latency p50", get: (r) => r.latency.p50,      unit: "ms", lowerBetter: true },
            { label: "Latency p99", get: (r) => r.latency.p99,      unit: "ms", lowerBetter: true },
            { label: "Max Latency", get: (r) => r.latency.max,      unit: "ms", lowerBetter: true },
            { label: "2xx %",       get: (r) => pct2xx(r),          unit: "%",  lowerBetter: false },
        ];

        const bars = metricDefs.map(({ label, get, unit, lowerBetter }) => {
            const values = modes.map((m) => ({ mode: m, val: run[m] ? get(run[m]!) : 0 }));
            const max = Math.max(...values.map((v) => v.val), 1);
            const best = lowerBetter
                ? Math.min(...values.map((v) => v.val))
                : Math.max(...values.map((v) => v.val));

            const barRows = values.map(({ mode, val }) => {
                const w = (val / max) * 100;
                const cls = mode === "concurrex" ? "cx" : "bare";
                const winner = modes.length > 1 && val === best ? " winner" : "";
                return `
            <div class="bar-row">
              <span class="bar-label">${mode}</span>
              <div class="bar ${cls}${winner}" style="width:${w}%"></div>
              <span class="val">${fmt(val, unit === "%" ? 1 : 0)}${unit}</span>
            </div>`;
            }).join("\n");

            return `
        <div class="metric">
          <div class="label">${label}</div>
          <div class="bars">${barRows}
          </div>
        </div>`;
        }).join("\n");

        sections.push(`<div class="benchmark"><h2>${name}</h2>${bars}</div>`);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Concurrex Benchmark Results</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { margin-bottom: 2rem; }
  .benchmark { margin-bottom: 3rem; }
  .benchmark h2 { margin-bottom: 1rem; font-size: 1.3rem; border-bottom: 2px solid #e0e0e0; padding-bottom: .5rem; }
  .metric { margin-bottom: 1.2rem; }
  .metric .label { font-weight: 600; margin-bottom: .3rem; font-size: .95rem; }
  .bars { display: flex; flex-direction: column; gap: 4px; }
  .bar-row { display: flex; align-items: center; gap: 8px; height: 28px; }
  .bar-label { width: 80px; font-size: .8rem; text-align: right; color: #666; }
  .bar { height: 100%; border-radius: 4px; min-width: 2px; transition: width .3s; }
  .bar.cx { background: #4a90d9; }
  .bar.bare { background: #aaa; }
  .bar.winner { outline: 2px solid #2d6cb4; outline-offset: 1px; }
  .bar.bare.winner { outline-color: #666; }
  .val { font-size: .85rem; white-space: nowrap; }
  .timestamp { color: #999; font-size: .85rem; margin-top: 2rem; }
</style>
</head>
<body>
<h1>Concurrex Benchmark Results</h1>
${sections.join("\n")}
<p class="timestamp">Generated ${new Date().toISOString()}</p>
</body>
</html>`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    const flags = new Set(argv.filter((a) => a.startsWith("-")));
    const names = argv.filter((a) => !a.startsWith("-"));
    const selected = names.length > 0 ? names : Object.keys(BENCHMARKS);

    const modes: Mode[] =
        flags.has("--bare") ? ["bare"] :
        flags.has("--concurrex") ? ["concurrex"] :
        ["concurrex", "bare"];

    for (const name of selected) {
        if (!(name in BENCHMARKS)) {
            console.error(`Unknown benchmark: "${name}". Available: ${Object.keys(BENCHMARKS).join(", ")}`);
            process.exit(1);
        }
    }

    const results = new Map<string, BenchmarkRun>();

    for (const name of selected) {
        const bench = BENCHMARKS[name];
        const run: BenchmarkRun = {};

        for (const mode of modes) {
            const bare = mode === "bare";
            console.log(`\n▶ ${name} [${mode}] — starting server on port ${bench.port}...`);

            const proc = startServer(bench.file, bare);
            try {
                await waitForHealth(bench.port);
                console.log(`  Server ready. Running autocannon -c ${bench.connections} -d ${bench.duration}...`);
                const result = runAutocannon(bench.port, bench.connections, bench.duration);
                run[mode] = result;
                console.log(`  Done: ${fmt(result.requests.average)} req/s, p50=${result.latency.p50}ms, p99=${result.latency.p99}ms, 2xx=${result["2xx"]}`);
            } finally {
                await killServer(proc);
            }
        }

        results.set(name, run);
    }

    console.log("\n");
    printTable(results, modes);

    const outDir = path.join(root, "benchmarks");
    const htmlPath = path.join(outDir, "results.html");
    writeFileSync(htmlPath, generateHtml(results, modes));
    console.log(`\nHTML report: ${htmlPath}`);

    const csvPath = path.join(outDir, "results.csv");
    writeFileSync(csvPath, generateCsv(results, modes));
    console.log(`CSV report:  ${csvPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
