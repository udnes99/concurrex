import { describe, expect, it } from "vitest";
import { PowerDegraded, type SignalContext } from "../src/index.js";

/**
 * Deterministic synthetic drives of the PowerDegraded latch: the
 * signal is exercised directly through its public hooks with a fabricated
 * SignalContext — no executor, no timers. The drive controls the plant
 * exactly (instant W via the residence integral, L via the context, X via
 * per-window completions), so latch transitions are reproducible to the
 * window.
 *
 * Shared inference state models a steady pool: constant α, shrinkage 1,
 * Σw² at its constant-α fixed point α/(2−α) (heartbeat df ≈ 8, δ²-test
 * df ≈ 6.4 — past the tScore df ≥ 5 warm-up gate).
 */
const ALPHA = 0.2;
const SUMW2 = ALPHA / (2 - ALPHA);

function makeCtx(
    limit: number,
    inFlight: number,
    timeConstant: number,
    maxInFlight: number = limit
): SignalContext {
    return {
        pool: "p",
        concurrencyLimit: limit,
        inFlight,
        // Default maxInFlight = limit = binding regime (limit ≤ maxInFlight), so
        // the decrease clamp's headroom re-anchor stays inert. Pass an explicit
        // maxInFlight < limit to drive the slack (inert-headroom) regime.
        maxInFlight,
        queueLength: 0,
        dropping: false,
        inference: {
            zScoreThreshold: 2,
            z2: 4,
            timeConstant,
            controlWindow: 1000,
            currentAlpha: ALPHA,
            bayesianShrinkage: 1,
            ewmaSumW2: SUMW2,
            df: 1 / SUMW2 - 1,
            elapsedWindows: 0
        },
        regulator: {
            completionRateEwma: 20,
            admissionRateEwma: null,
            dropRateEwma: null,
            inFlightEwma: null,
            regulationPhase: "Stable",
            regulationDepth: 0
        }
    };
}

function makeDriver(timeConstant: number) {
    const signal = new PowerDegraded();
    let t = 0;
    signal.onAdmit(makeCtx(1, 1, timeConstant), { lane: "l", admitTime: 0 });
    /** Evaluate one window with instant log-residence `logWms` (ms), the
     *  given concurrency limit, and `completions` served — the in-flight
     *  count is derived so the residence integral yields exactly W. */
    const step = (logWms: number, limit: number, completions: number, maxInFlight?: number) => {
        const W = Math.exp(logWms);
        const inFlight = (W * completions) / 1000;
        t += 1000;
        signal.onEvaluate(makeCtx(limit, inFlight, timeConstant, maxInFlight ?? limit), {
            windowStart: t - 1000,
            windowEnd: t,
            elapsed: 1000,
            completions,
            admissions: completions
        });
        return signal.state();
    };
    return { signal, step };
}

/** Tiny alternating log-space wiggle so δ² (and hence the resolution m)
 *  stays strictly positive on otherwise-clean segments. */
const wiggle = (k: number) => (k % 2 === 0 ? 1 : -1) * 0.002;

describe("PowerDegraded latch (synthetic drive)", () => {
    it("evidence-expiry backstop releases only a full time constant after the last evidence (and does not re-base)", () => {
        // The latch may not outlive its evidence: with the limit pinned
        // (monitoring-only pool), release comes from the expiry backstop —
        // timeConstant consecutive windows with the trend test quiet and
        // the limit unmoved, counted from the LAST firing window, not from
        // onset. (Corollary: release can never precede timeConstant
        // windows post-onset, so any responder with decision cadence
        // ≤ timeConstant is guaranteed an opportunity to act first —
        // the original onset-window race.)
        const TAU = 30;
        const { step } = makeDriver(TAU);
        const flat = Math.log(50);
        let idx = 0;
        let onsetIdx = -1;
        let quietIdx = -1;
        let releaseIdx = -1;
        let releaseRef: number | null = null;
        const track = (s: ReturnType<typeof step>) => {
            idx++;
            if (onsetIdx < 0 && s.latched) onsetIdx = idx;
            if (onsetIdx > 0 && quietIdx < 0 && !s.degrading) quietIdx = idx;
            if (onsetIdx > 0 && releaseIdx < 0 && !s.latched) {
                releaseIdx = idx;
                releaseRef = s.referenceLevel;
            }
        };

        // Establish the reference at a flat 50ms level.
        for (let k = 0; k < 30; k++) track(step(flat + wiggle(k), 50, 20));
        // Climb: +0.3 log/window for 5 windows — the trend test fires and
        // the latch onsets mid-climb.
        for (let k = 0; k < 5; k++) track(step(flat + 0.3 * (k + 1) + wiggle(k), 50, 20));
        expect(onsetIdx).toBeGreaterThan(0);
        // Elevated plateau with a slight decline: the trend goes quiet
        // well inside the expiry window (measured: ~20 windows
        // post-onset), the level stays far above the reference band, and
        // the limit never moves — the backstop is the only reachable exit.
        for (let k = 0; k < 80 && releaseIdx < 0; k++) {
            track(step(flat + 1.4 - 0.02 * (k + 1) + wiggle(k), 50, 20));
        }

        // The backstop must release (monitoring-only pools cannot latch
        // forever) — but only once the evidence has expired: a full time
        // constant after the trend last fired, and therefore also a full
        // time constant after onset.
        expect(releaseIdx).toBeGreaterThan(0);
        expect(quietIdx).toBeGreaterThan(0);
        expect(releaseIdx - quietIdx).toBeGreaterThanOrEqual(TAU - 1);
        expect(releaseIdx - onsetIdx).toBeGreaterThanOrEqual(TAU);
        // Expiry is the absence of evidence: the reference must NOT have
        // been re-based to the elevated level.
        expect(releaseRef).not.toBeNull();
        expect(releaseRef!).toBeLessThan(flat + 0.2);
    });

    it("re-firing (deepening) resets the evidence-expiry clock", () => {
        // The expiry clock counts windows since the LAST evidence, not
        // since onset. A latch that has been quiet for a while and then
        // re-fires (incident deepening) must hold for a further full time
        // constant after the new evidence goes quiet — releasing on an
        // onset-anchored clock would drop the latch one window after
        // fresh evidence arrived.
        const TAU = 9;
        const { step } = makeDriver(TAU);
        const flat = Math.log(50);
        let logW = flat;
        let idx = 0;
        const state = (s: ReturnType<typeof step>) => {
            idx++;
            return s;
        };

        // Reference, then climb until the latch onsets.
        for (let k = 0; k < 30; k++) state(step(flat + wiggle(k), 50, 20));
        let s = state(step(flat, 50, 20));
        let guard = 0;
        logW = flat;
        while (!s.latched && guard++ < 8) {
            logW += 0.3;
            s = state(step(logW + wiggle(idx), 50, 20));
        }
        expect(s.latched).toBe(true);

        // Quiet phase 1: decline gently until the trend stops firing. The
        // latch must hold throughout — under an onset-anchored clock the
        // pinned limit would have expired the latch during/right after
        // this phase (it lasts longer than TAU windows).
        guard = 0;
        while (s.degrading && guard++ < 40) {
            logW -= 0.03;
            s = state(step(logW + wiggle(idx), 50, 20));
            expect(s.latched).toBe(true);
        }
        expect(s.degrading).toBe(false);
        // A few more quiet windows — still latched (clock below TAU).
        for (let k = 0; k < 4; k++) {
            logW -= 0.03;
            s = state(step(logW + wiggle(idx), 50, 20));
            expect(s.latched).toBe(true);
        }

        // Deepening: climb again until the trend re-fires — fresh
        // evidence, clock resets.
        guard = 0;
        while (!s.degrading && guard++ < 8) {
            logW += 0.3;
            s = state(step(logW + wiggle(idx), 50, 20));
        }
        expect(s.degrading).toBe(true);
        expect(s.latched).toBe(true);

        // Quiet phase 2: the release must come no sooner than a full time
        // constant after the LAST firing window of the deepening.
        let lastFiringIdx = idx;
        let releaseIdx = -1;
        guard = 0;
        while (releaseIdx < 0 && guard++ < 60) {
            logW -= 0.03;
            s = state(step(logW + wiggle(idx), 50, 20));
            if (s.degrading) lastFiringIdx = idx;
            if (!s.latched) releaseIdx = idx;
        }
        expect(releaseIdx).toBeGreaterThan(0);
        expect(releaseIdx - lastFiringIdx).toBeGreaterThanOrEqual(TAU - 1);
    });

    it("walk-back ε release survives incident deepening (origins re-snapshot together, binding check stays exact)", () => {
        // Regression for the origin-mismatch bug: deepening used to ratchet
        // only the Δw origin, leaving Δℓ and Δx measured from the initial
        // onset — the binding-premise check |Δx − (Δℓ − Δw)| then carried a
        // systematic bias equal to the deepening amount and blocked the
        // below-knee release for the rest of the episode (walk-back ground
        // on forever; verified against the pre-fix code, which never
        // releases in this scenario).
        const TAU = 9;
        const { step } = makeDriver(TAU);
        const flat = Math.log(50);
        // Exact plant law X = 10·L/W at every window: the filtered Little
        // identity Δx = Δℓ − Δw then holds exactly, so the binding check
        // must pass whenever the origins are consistent.
        const comp = (L: number, logWms: number) => (10 * L) / Math.exp(logWms);
        let idx = 0;
        let onsetIdx = -1;
        let releaseIdx = -1;
        let releaseState: ReturnType<typeof step> | null = null;
        const track = (s: ReturnType<typeof step>) => {
            idx++;
            if (onsetIdx < 0 && s.latched) onsetIdx = idx;
            if (onsetIdx > 0 && releaseIdx < 0 && !s.latched) {
                releaseIdx = idx;
                releaseState = s;
            }
        };

        // Reference at 50ms, L = 100.
        for (let k = 0; k < 30; k++) {
            const lw = flat + wiggle(k);
            track(step(lw, 100, comp(100, lw)));
        }
        // Climb +1.5 log total: onset happens early in the climb, and each
        // further climb window deepens the incident well past the binding
        // tolerance z·√(2κ/r̂) ≈ 0.21 — the regression trigger.
        for (let k = 0; k < 6; k++) {
            const lw = flat + 0.25 * (k + 1) + wiggle(k);
            track(step(lw, 100, comp(100, lw)));
        }
        expect(onsetIdx).toBeGreaterThan(0);
        // Exogenous plateau + walk-back: W holds at the peak while L is
        // stepped down 8%/window and X follows the plant law. The response
        // is flat (ε ≈ 0), so once the trend quiets and the filtered
        // excitation accrues, the ε test must conclude below-knee and
        // release.
        const peak = flat + 1.5;
        let L = 100;
        for (let k = 0; k < 45 && releaseIdx < 0; k++) {
            L = 100 * Math.exp(-0.08 * (k + 1));
            const lw = peak + wiggle(k);
            track(step(lw, L, comp(L, lw)));
        }

        expect(releaseIdx).toBeGreaterThan(0);
        // The release must be the evidence-gated ε exit, not the stall
        // backstop: the limit moved every window (stall unreachable), and
        // the reference must have been re-based to the new normal near the
        // peak level.
        const ref = (releaseState as unknown as { referenceLevel: number | null }).referenceLevel;
        expect(ref).not.toBeNull();
        expect(ref!).toBeGreaterThan(flat + 1.0);
    });
});
