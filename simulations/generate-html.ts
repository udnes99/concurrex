#!/usr/bin/env npx tsx
/**
 * Generates an HTML visualization from a simulation JSON file.
 *
 * Auto-detects which charts to render based on the time series fields
 * present in the JSON. Can be run standalone or imported.
 *
 * Usage:
 *   npx tsx simulations/generate-html.ts simulations/simulation-live.json
 *   npx tsx simulations/generate-html.ts simulations/*.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// ── Types (mirror output.ts) ───────────────────────────────────────

type TimeSeriesOutput = { [field: string]: (number | string | boolean | null)[] };

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
        codelDropsOccurred: boolean;
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

// ── Feature detection ──────────────────────────────────────────────

function has(ts: TimeSeriesOutput, ...fields: string[]): boolean {
    return fields.every((f) => f in ts && ts[f].some((v) => v !== null));
}

// ── Chart rendering (client-side JS) ──────────────────────────────

/**
 * Builds the <script> block that renders all charts client-side.
 * Uses the columnar timeSeries format from the JSON directly.
 */
function chartScript(scenarios: ScenarioOutput[]): string {
    // Detect features from first scenario (all scenarios in a file share the same schema)
    const ts0 = scenarios[0]?.timeSeries ?? {};
    const hasRps = has(ts0, "requestsPerSec");
    const hasErrorRate = has(ts0, "errorRate");
    const hasEwma = has(ts0, "logW", "logWBar");
    const hasZTest = has(ts0, "dLogWBarEwma", "se");
    const hasUncertainty = has(ts0, "ewmaSumW2", "threshold");
    const hasVariance = has(ts0, "dLogWBarSM");
    const hasPhases = scenarios.some((s) => s.phases && s.phases.length > 0);

    return `
const scenarios = ${JSON.stringify(scenarios)};

const COLORS = {
    queue: '#d29922',
    inFlight: '#3fb950',
    limit: '#58a6ff',
    rps: '#bc8cff',
    errorRate: '#f85149',
    dropping: 'rgba(248, 81, 73, 0.15)',
    degraded: 'rgba(210, 153, 34, 0.10)',
    logW: 'rgba(139, 148, 158, 0.5)',
    logWBar: '#58a6ff',
    dLogWBarEwma: '#3fb950',
    se: '#f78166',
    threshold: '#ff7b72',
    sumW2: '#bc8cff',
    completionRate: '#d29922',
    variance: '#bc8cff',
};

const CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
        legend: { labels: { color: '#8b949e', usePointStyle: true, pointStyle: 'line', font: { size: 11 } } },
        tooltip: {
            backgroundColor: '#1c2128',
            titleColor: '#f0f6fc',
            bodyColor: '#c9d1d9',
            borderColor: '#30363d',
            borderWidth: 1,
        },
    },
};

function xScale() {
    return {
        title: { display: true, text: 'Time (ms)', color: '#484f58' },
        ticks: { color: '#484f58', maxTicksLimit: 20 },
        grid: { color: '#21262d' },
    };
}

function yScale(label, color) {
    return {
        position: 'left',
        title: { display: true, text: label, color: color || '#484f58' },
        ticks: { color: color || '#484f58' },
        grid: { color: '#21262d' },
        suggestedMin: 0,
    };
}

function yScaleRight(label, color) {
    return {
        position: 'right',
        title: { display: true, text: label, color },
        ticks: { color },
        grid: { drawOnChartArea: false },
        suggestedMin: 0,
    };
}

${hasPhases ? `
function phaseAnnotations(phases) {
    if (!phases) return {};
    const annotations = {};
    phases.forEach((p, i) => {
        annotations['phase' + i] = {
            type: 'line',
            xMin: p.timeMs,
            xMax: p.timeMs,
            borderColor: 'rgba(139, 148, 158, 0.4)',
            borderWidth: 1,
            borderDash: [4, 4],
            label: {
                display: true,
                content: p.label,
                position: 'start',
                backgroundColor: 'rgba(22, 27, 34, 0.9)',
                color: '#8b949e',
                font: { size: 10 },
                padding: 3,
            },
        };
    });
    return annotations;
}
` : ""}

scenarios.forEach((scenario, i) => {
    const ts = scenario.timeSeries;
    const labels = ts.time;
    ${hasPhases ? "const annotations = phaseAnnotations(scenario.phases);" : ""}

    // ── Main chart: Queue / In-Flight / Concurrency Limit ──
    const mainDatasets = [
        {
            label: 'Queue Length',
            data: ts.queueLength,
            borderColor: COLORS.queue,
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1,
            fill: false,
            order: 3,
        },
        {
            label: 'In-Flight',
            data: ts.inFlight,
            borderColor: COLORS.inFlight,
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.1,
            fill: false,
            order: 2,
        },
        {
            label: 'Concurrency Limit',
            data: ts.concurrencyLimit,
            borderColor: COLORS.limit,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.1,
            fill: false,
            order: 1,
        },
        {
            label: 'CoDel Dropping',
            data: ts.dropping.map(v => v ? 1 : null),
            backgroundColor: COLORS.dropping,
            borderWidth: 0,
            pointRadius: 0,
            fill: 'origin',
            spanGaps: false,
            yAxisID: 'yBand',
            order: 5,
        },
        {
            label: 'Throughput Degraded',
            data: ts.throughputDegraded.map(v => v ? 1 : null),
            backgroundColor: COLORS.degraded,
            borderWidth: 0,
            pointRadius: 0,
            fill: 'origin',
            spanGaps: false,
            yAxisID: 'yBand',
            order: 4,
        },
    ];

    const mainScales = {
        x: xScale(),
        y: yScale('Count'),
        yBand: { display: false, min: 0, max: 1 },
    };

${hasRps ? `
    mainDatasets.push({
        label: 'Requests/sec',
        data: ts.requestsPerSec,
        borderColor: COLORS.rps,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: false,
        yAxisID: 'yRps',
        order: 0,
    });
    mainScales.yRps = yScaleRight('Requests/sec', '#bc8cff');
` : ""}

${hasErrorRate ? `
    mainDatasets.push({
        label: 'Error Rate',
        data: ts.errorRate,
        borderColor: COLORS.errorRate,
        borderWidth: 1.5,
        borderDash: [4, 2],
        pointRadius: 0,
        tension: 0.2,
        fill: false,
        yAxisID: 'yErrorRate',
        order: 0,
    });
    mainScales.yErrorRate = { display: false, min: 0, max: 1 };
` : ""}

    new Chart(document.getElementById('chart-' + i + '-main').getContext('2d'), {
        type: 'line',
        data: { labels, datasets: mainDatasets },
        options: {
            ...CHART_DEFAULTS,
            ${hasPhases ? "plugins: { ...CHART_DEFAULTS.plugins, annotation: { annotations } }," : ""}
            scales: mainScales,
        },
    });

${hasEwma ? `
    // ── EWMA chart: raw log(W) vs filtered logWBar ──
    new Chart(document.getElementById('chart-' + i + '-ewma').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'log(W) raw',
                    data: ts.logW,
                    borderColor: COLORS.logW,
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                    ${hasVariance ? "" : "borderDash: [3, 3],"}
                },
                {
                    label: 'logW\\u0304 (EWMA-filtered)',
                    data: ts.logWBar,
                    borderColor: COLORS.logWBar,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
${hasVariance ? `
                {
                    label: 'dLogW\\u0304 EWMA (trend)',
                    data: ts.dLogWBarEwma,
                    borderColor: COLORS.dLogWBarEwma,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    yAxisID: 'yTrend',
                },
                {
                    label: 'Variance (SM)',
                    data: ts.dLogWBarSM,
                    borderColor: COLORS.variance,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    yAxisID: 'yTrend',
                },
` : ""}
            ],
        },
        options: {
            ...CHART_DEFAULTS,
            ${hasPhases ? "plugins: { ...CHART_DEFAULTS.plugins, annotation: { annotations } }," : ""}
            scales: {
                x: xScale(),
                y: {
                    position: 'left',
                    title: { display: true, text: 'log(W)', color: '#58a6ff' },
                    ticks: { color: '#58a6ff' },
                    grid: { color: '#21262d' },
                },
${hasVariance ? `
                yTrend: yScaleRight('Trend / Variance', '#3fb950'),
` : ""}
            },
        },
    });
` : ""}

${hasZTest && !hasVariance ? `
    // ── z-Test chart: dLogWBar trend with SE bands ──
    new Chart(document.getElementById('chart-' + i + '-ztest').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'dLogW\\u0304 EWMA (trend)',
                    data: ts.dLogWBarEwma,
                    borderColor: '#3fb950',
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
                {
                    label: '+SE band',
                    data: ts.se.map(v => v > 0 ? v : null),
                    borderColor: 'rgba(210, 153, 34, 0.6)',
                    borderWidth: 1,
                    borderDash: [4, 2],
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
                {
                    label: '\\u2212SE band',
                    data: ts.se.map(v => v > 0 ? -v : null),
                    borderColor: 'rgba(210, 153, 34, 0.3)',
                    borderWidth: 1,
                    borderDash: [4, 2],
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    spanGaps: true,
                },
                {
                    label: 'Zero',
                    data: ts.time.map(() => 0),
                    borderColor: 'rgba(139, 148, 158, 0.3)',
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                },
                {
                    label: 'DEGRADING',
                    data: ts.throughputDegraded.map((v, j) => v ? ts.dLogWBarEwma[j] : null),
                    backgroundColor: 'rgba(248, 81, 73, 0.2)',
                    borderColor: '#f85149',
                    borderWidth: 0,
                    pointRadius: 4,
                    pointBackgroundColor: '#f85149',
                    fill: false,
                    spanGaps: false,
                    showLine: false,
                },
            ],
        },
        options: {
            ...CHART_DEFAULTS,
            ${hasPhases ? "plugins: { ...CHART_DEFAULTS.plugins, annotation: { annotations } }," : ""}
            scales: {
                x: xScale(),
                y: {
                    position: 'left',
                    title: { display: true, text: 'dLogW\\u0304', color: '#484f58' },
                    ticks: { color: '#484f58' },
                    grid: { color: '#21262d' },
                },
            },
        },
    });
` : ""}

${hasUncertainty ? `
    // ── Uncertainty chart: ewmaSumW2, SE, threshold, completionRate ──
    new Chart(document.getElementById('chart-' + i + '-uncertainty').getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label: 'ewmaSumW2',
                    data: ts.ewmaSumW2,
                    borderColor: COLORS.sumW2,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    yAxisID: 'yP',
                },
                {
                    label: 'SE',
                    data: ts.se,
                    borderColor: COLORS.se,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    yAxisID: 'ySE',
                },
                {
                    label: 'Threshold (Z \\u00d7 SE)',
                    data: ts.threshold,
                    borderColor: COLORS.threshold,
                    borderWidth: 2,
                    borderDash: [5, 3],
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    yAxisID: 'ySE',
                },
                ...(ts.completionRateEwma ? [{
                    label: 'Completion Rate EWMA',
                    data: ts.completionRateEwma,
                    borderColor: COLORS.completionRate,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false,
                    yAxisID: 'yRate',
                }] : []),
            ],
        },
        options: {
            ...CHART_DEFAULTS,
            ${hasPhases ? "plugins: { ...CHART_DEFAULTS.plugins, annotation: { annotations } }," : ""}
            scales: {
                x: xScale(),
                yP: {
                    position: 'left',
                    title: { display: true, text: 'ewmaSumW2', color: '#bc8cff' },
                    ticks: { color: '#bc8cff' },
                    grid: { color: '#21262d' },
                    suggestedMin: 0,
                },
                ySE: {
                    position: 'right',
                    title: { display: true, text: 'SE / Threshold', color: '#f78166' },
                    ticks: { color: '#f78166' },
                    grid: { drawOnChartArea: false },
                    suggestedMin: 0,
                },
                yRate: { display: false, suggestedMin: 0 },
            },
        },
    });
` : ""}
});`;
}

// ── HTML template ──────────────────────────────────────────────────

function scenarioHtml(scenario: ScenarioOutput, index: number, ts0: TimeSeriesOutput): string {
    const hasRps = has(ts0, "requestsPerSec");
    const hasErrorRate = has(ts0, "errorRate");
    const hasEwma = has(ts0, "logW", "logWBar");
    const hasZTest = has(ts0, "dLogWBarEwma", "se");
    const hasUncertainty = has(ts0, "ewmaSumW2", "threshold");
    const hasVariance = has(ts0, "dLogWBarSM");

    const legendParts = [
        "Shaded red = CoDel dropping",
        "Shaded orange = throughput degraded",
    ];
    if (hasErrorRate) legendParts.push("Dashed red = error rate");

    const charts = [`
        <div class="chart-container"><canvas id="chart-${index}-main"></canvas></div>
        <div class="legend-note">${legendParts.join(" &middot; ")}</div>`];

    if (hasEwma) {
        const label = hasVariance
            ? "Latency Signal (logW, logW\u0304, trend, variance)"
            : "EWMA Filter State";
        charts.push(`
        <div class="chart-label">${label}</div>
        <div class="chart-container-sm"><canvas id="chart-${index}-ewma"></canvas></div>`);
    }

    if (hasZTest && !hasVariance) {
        charts.push(`
        <div class="chart-label">Latency Trend z-Test</div>
        <div class="chart-container-sm"><canvas id="chart-${index}-ztest"></canvas></div>`);
    }

    if (hasUncertainty) {
        charts.push(`
        <div class="chart-label">Effective Sample Size &amp; SE / Threshold</div>
        <div class="chart-container-sm"><canvas id="chart-${index}-uncertainty"></canvas></div>`);
    }

    // Summary stats line
    const s = scenario.summary;
    const stats = [
        `${s.snapshotCount} snapshots`,
        `${(s.durationMs / 1000).toFixed(1)}s`,
        `limit ${s.concurrencyLimitMin}\u2013${s.concurrencyLimitMax}`,
        `peak queue ${s.peakQueueLength}`,
        `peak in-flight ${s.peakInFlight}`,
    ];
    if (s.codelDropsOccurred) stats.push("CoDel drops");
    if (s.throughputDegradationOccurred) stats.push("degradation detected");

    return `
<div class="scenario">
    <h2>${scenario.name}</h2>
    <p>${scenario.description}</p>
    <div class="stats">${stats.join(" &middot; ")}</div>
    ${charts.join("\n")}
</div>`;
}

function generateHtmlString(data: SimulationOutput): string {
    const ts0 = data.scenarios[0]?.timeSeries ?? {};
    const hasPhases = data.scenarios.some((s) => s.phases && s.phases.length > 0);
    const needsAnnotation = hasPhases;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${data.title}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
${needsAnnotation ? '<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@3"></script>' : ""}
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #f0f6fc; }
    .subtitle { font-size: 14px; color: #8b949e; margin-bottom: 32px; }
    .scenario { margin-bottom: 48px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 24px; }
    .scenario h2 { font-size: 18px; color: #f0f6fc; margin-bottom: 4px; }
    .scenario p { font-size: 13px; color: #8b949e; margin-bottom: 8px; line-height: 1.5; }
    .stats { font-size: 11px; color: #58a6ff; margin-bottom: 16px; font-family: 'SF Mono', 'Fira Code', monospace; }
    .chart-container { position: relative; height: 300px; }
    .chart-container-sm { position: relative; height: 200px; margin-top: 16px; }
    .chart-label { font-size: 12px; color: #8b949e; margin-top: 16px; margin-bottom: 4px; font-weight: 500; }
    .legend-note { font-size: 11px; color: #484f58; margin-top: 8px; }
    .generated { font-size: 11px; color: #484f58; margin-top: 32px; text-align: center; }
</style>
</head>
<body>
<h1>${data.title}</h1>
<p class="subtitle">${data.subtitle}</p>

${data.scenarios.map((s, i) => scenarioHtml(s, i, ts0)).join("\n")}

<p class="generated">Generated ${data.generatedAt} from ${data.simulation}.json</p>

<script>
${chartScript(data.scenarios)}
</script>
</body>
</html>`;
}

// ── Public API ─────────────────────────────────────────────────────

export function generateHtmlFromJson(jsonPath: string): string {
    const raw = readFileSync(jsonPath, "utf-8");
    const data: SimulationOutput = JSON.parse(raw);
    const html = generateHtmlString(data);
    const htmlPath = jsonPath.replace(/\.json$/, ".html");
    writeFileSync(htmlPath, html);
    console.log(`HTML written to:\n  ${htmlPath}`);
    return htmlPath;
}

// ── CLI entry point ────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length > 0) {
    for (const jsonPath of args) {
        generateHtmlFromJson(jsonPath);
    }
}
