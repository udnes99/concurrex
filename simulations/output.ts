/**
 * Shared JSON output generator for simulations.
 *
 * Each simulation calls `generateJsonOutput()` after running to produce
 * a columnar JSON file with time series data, summary statistics, and
 * metadata — suitable for blog posts and external analysis.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ── Types ───────────────────────────────────────────────────────────

type BaseSnapshot = {
    time: number;
    concurrencyLimit: number;
    inFlight: number;
    queueLength: number;
    dropping: boolean;
    throughputDegraded: boolean;
    [key: string]: unknown;
};

type Scenario = {
    name: string;
    description: string;
    data: BaseSnapshot[];
    phases?: { time: number; label: string }[];
};

type TimeSeriesOutput = {
    /** Field name → array of values, one per snapshot */
    [field: string]: (number | string | boolean | null)[];
};

type ScenarioOutput = {
    name: string;
    description: string;
    summary: {
        durationMs: number;
        snapshotCount: number;
        peakQueueLength: number;
        peakInFlight: number;
        concurrencyLimitMin: number;
        concurrencyLimitMax: number;
        prodelDropsOccurred: boolean;
        throughputDegradationOccurred: boolean;
    };
    phases?: { timeMs: number; label: string }[];
    timeSeries: TimeSeriesOutput;
};

type SimulationOutput = {
    simulation: string;
    title: string;
    subtitle: string;
    generatedAt: string;
    scenarios: ScenarioOutput[];
};

// ── Implementation ──────────────────────────────────────────────────

function buildTimeSeries(data: BaseSnapshot[]): TimeSeriesOutput {
    if (data.length === 0) return {};

    // Discover all fields from the first snapshot
    const fields = Object.keys(data[0]);
    const ts: TimeSeriesOutput = {};
    for (const field of fields) {
        ts[field] = data.map((d) => {
            const v = d[field];
            if (v === undefined) return null;
            if (typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v === null)
                return v;
            return null;
        });
    }
    return ts;
}

function buildScenarioOutput(scenario: Scenario): ScenarioOutput {
    const { data } = scenario;
    const limits = data.map((d) => d.concurrencyLimit);

    const output: ScenarioOutput = {
        name: scenario.name,
        description: scenario.description,
        summary: {
            durationMs: data.length > 0 ? (data[data.length - 1].time as number) : 0,
            snapshotCount: data.length,
            peakQueueLength: Math.max(0, ...data.map((d) => d.queueLength)),
            peakInFlight: Math.max(0, ...data.map((d) => d.inFlight)),
            concurrencyLimitMin: Math.min(...limits),
            concurrencyLimitMax: Math.max(...limits),
            prodelDropsOccurred: data.some((d) => d.dropping),
            throughputDegradationOccurred: data.some((d) => d.throughputDegraded)
        },
        timeSeries: buildTimeSeries(data)
    };

    if (scenario.phases && scenario.phases.length > 0) {
        output.phases = scenario.phases.map((p) => ({ timeMs: p.time, label: p.label }));
    }

    return output;
}

type OutputOptions = {
    /** Page title for HTML generation */
    title: string;
    /** Page subtitle for HTML generation */
    subtitle: string;
};

/**
 * Generate a JSON output file from simulation results.
 *
 * @param callerUrl  - Pass `import.meta.url` so the output lands next to the simulation file.
 * @param name       - Simulation name, used as the output filename stem (e.g. "simulation-live").
 * @param scenarios  - The collected scenario data.
 * @param options    - Title and subtitle for HTML page generation.
 */
export function generateJsonOutput(
    callerUrl: string,
    name: string,
    scenarios: Scenario[],
    options: OutputOptions
): string {
    const output: SimulationOutput = {
        simulation: name,
        title: options.title,
        subtitle: options.subtitle,
        generatedAt: new Date().toISOString(),
        scenarios: scenarios.map(buildScenarioOutput)
    };

    const __dirname = dirname(new URL(callerUrl).pathname);
    const outPath = join(__dirname, `${name}.json`);
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`JSON output written to:\n  ${outPath}`);
    return outPath;
}
