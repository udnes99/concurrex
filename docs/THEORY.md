# Executor: Formal Analysis

A formal treatment of the mechanisms in the Executor: **ProDel** (Probabilistic Delay Load-shedding — the core queue engine), the **throughput regulator** driven by pluggable **regulator signals** (concurrency policy; default `PowerDegraded`), and pluggable **admission signals** (enqueue-time shedding; default `EarlyShed`, opt-in `LaneErrorShed`). ProDel is a sojourn-based active queue management algorithm where drop probability is proportional to entry staleness. All theorem numbers, definitions, and proofs reference the implementation in `src/Executor.ts`, `src/signals.ts`, and `src/statistics.ts`.

> **Interactive plots:** See [`theory-plots.html`](theory-plots.html) for Chart.js visualizations of every curve in this document — compare theory against the [live simulation](../simulations/simulation-live.html).

---

## 1. Definitions and System Model

**Pool state.** A pool maintains:

- $L$ — concurrency limit (`concurrencyLimit`), $L \in [L_{\min}, L_{\max}]$
- $F$ — in-flight count (`inFlight`)
- $\hat{N}_{\max}$ — peak in-flight this window (`maxInFlight`); $\hat{N}_{\max} \leq L$, with equality when the limit binds (used by the operating-concurrency clamp, §4.4.2)
- $Q$ — queue length (`queueLength`)
- $CW$ — control window duration in ms (`controlWindow`)
- $\tau$ — delay threshold in ms (`delayThreshold`)
- $B$ — baseline concurrency (`baselineConcurrency`)

**Task lifecycle.** A task is enqueued at time $t_e$, admitted at time $t_a$ (sojourn $= t_a - t_e$), and completes at time $t_c$. On admission $F \leftarrow F+1, Q \leftarrow Q-1$. On completion $F \leftarrow F-1$.

**Throughput monitor state.** Per window:

- $r_k$ — completions in window $k$
- $\hat\mu_k$ — EWMA of completion rate (`completionRateEwma`)
- $d_k$ — drops in window $k$
- $\hat{D}_k$ — EWMA of drop rate (`dropRateEwma`)
- $n_w$ — total elapsed windows (`elapsedWindows`)

**EWMA state (latency detection).** Per window:

- $\hat{L}_k$ — EWMA of in-flight count (`inFlightEwma`)
- $\bar{m}_k$ — shrinkage-dampened EWMA of $\log(W)$ (`logWBar`)
- $\hat{v}_k$ — EWMA of shrunk derivative $v_k \cdot s_k$ (`dLogWBarEwma`); asymmetric shrinkage on input
- $\delta^2_k$ — von Neumann's lag-1 squared-difference noise estimator $\text{EWMA}((v_k - v_{k-1})^2 / 2)$ (`dLogWBarVarEst`); drift-invariant
- $\kappa_k$ — sum of squared EWMA weights (`ewmaSumW2`); encodes effective sample size

**Per-lane state:**

- $\hat{p}_\ell$ — per-lane error rate EWMA (`errorRateEwma`)
- $t_\ell$ — timestamp of last completion (`lastCompletionTime`)
- $c_\ell$ — cumulative completions (`completions`) — used as observation count for Bayesian shrinkage scaling

**Throughput Regulator state:**

- $\alpha$ — last computed EWMA smoothing factor (`currentAlpha`)
- $d$ — current regulation depth (`regulationDepth`)
- $\Phi$ — regulation phase: $\texttt{Idle}$, $\texttt{Increasing}$, $\texttt{Retracting}$, $\texttt{Decreasing}$, or $\texttt{Restoring}$ (`regulationPhase`)
- $\beta$ — bisection damping scale (`stepScale`), initially 1. Halved on each increase→retract→cooling cycle (floored at $1/L$). Reset to 1 on Restoring or Decreasing.

**Constants:**

- $\sigma_D$ — `zScoreThreshold` (default: 2, configurable globally and per-pool). Number of standard errors for significance. The single tunable constant from which all other statistical parameters are derived.
- $Z^2 = \sigma_D^2$ — `z2`. The Bayesian prior strength in pseudo-observations. At $\sigma_D = 2$: $Z^2 = 4$.
- $H = \text{round}(2 / (1 - e^{-1/\sigma_D^2}))$ — `timeConstant`. EWMA time constant in control windows: decay constant and evaluation cadence. Warm-up is handled implicitly by the Student-t critical value via effective sample size (§4.3.1). At $\sigma_D = 2$: $H = 9$.

---

## 2. ProDel: Probabilistic Delay Load-shedding

### 2.1 Adaptive LIFO/FIFO Admission

Admission order adapts to the pool's health state:

- **Healthy/grace (not dropping):** FIFO both among lanes (oldest lane first) and within each lane (oldest request first). Fair, predictable ordering — no request is unfairly delayed by later arrivals.
- **Dropping:** LIFO both among lanes (newest lane first) and within each lane (newest request first). Fresh requests get the lowest possible latency; stale entries age at the head of older lanes and get ProDel-dropped.

**Rationale.** During normal operation, the queue is typically short or empty — FIFO fairness costs nothing. During overload, the system switches to LIFO to protect fresh work: the newest requests reflect the most current caller intent, while old requests are likely stale (callers may have already timed out). ProDel always checks the oldest entry's sojourn for health detection, independent of which entry gets admitted.

**Lane data structure.** Lanes are maintained in an intrinsic doubly-linked list (`prev`/`next` pointers on each lane) alongside a `Map` for O(1) key lookup. New lanes are appended at the tail. Traversal direction depends on state: from `laneHead` (→ `next`) when healthy; from `laneTail` (→ `prev`) when dropping. All operations (append, remove, traverse) are O(1).

**Properties:**

- During normal operation: FIFO fairness. Requests served in arrival order. Per-user lanes provide round-robin across users.
- During overload: LIFO freshness. Fresh requests get near-zero sojourn. Stale requests age at the head and get shed.
- ProDel health detection is unaffected — always checks the oldest (head) entry regardless of admission order.
- Under moderate load (queue drains between bursts), LIFO and FIFO are equivalent (queue depth ~0).

### 2.2 State Machine

ProDel is a 3-state automaton over pool state $(S, t_f, n_d, t_d)$ where:

- $S \in \{\texttt{IDLE}, \texttt{GRACE}, \texttt{DROPPING}\}$
- $t_f$ = `firstAboveTime` (grace deadline)
- $n_d$ = `dropCount` (cumulative drops since entering DROPPING)
- $t_d$ = `dropNext` (next scheduled drop evaluation round)

Transitions on evaluating head-of-queue entry with sojourn $s$ at time $t$:

| From | Condition | Action | To |
|------|-----------|--------|----|
| Any | $s < \tau$ | FIFO admit (head) | IDLE |
| IDLE | $s \geq \tau$ | $t_f \leftarrow t + CW$; FIFO admit (head) | GRACE |
| GRACE | $s \geq \tau \land t < t_f$ | FIFO admit (head) | GRACE |
| GRACE | $s \geq \tau \land t \geq t_f$ | $n_d \leftarrow 0; t_d \leftarrow t$ | DROPPING |
| DROPPING | $t < t_d$ | LIFO admit (tail) if $F < L$ | DROPPING |
| DROPPING | $t \geq t_d$ | Drop round: iterate all stale entries (§2.3) | DROPPING |
| DROPPING | no lane has a stale head after a full traversal | $t_f \leftarrow \bot$; exit | IDLE |

### 2.3 Sojourn-Proportional Probabilistic Drop

In DROPPING state, drop evaluation occurs in **rounds** gated by a $1/\sqrt{n_d}$ schedule (where $n_d$ = cumulative drops since entering DROPPING). Each round iterates ALL stale entries in each lane from head (oldest, highest P) toward tail. Each entry gets one probabilistic check per round with drop probability:

$$P(s) = 1 - \frac{\tau}{s}, \quad s \geq \tau$$

where $s$ is the entry's sojourn time and $\tau$ is the delay threshold. The iteration stops at the first fresh entry ($s < \tau$) — all remaining entries are fresher.

**Schedule:** After a round completes, the next round fires at $t + CW / \sqrt{\max(1, n_d)}$. The first round fires immediately on entering DROPPING ($t_d = t$). More drops → shorter interval → faster next round. Between rounds, `processQueue` fires on every task completion but only performs LIFO admission — no stale entry iteration, keeping overhead minimal.

**Properties:**
- At $s = \tau$: $P = 0$ — entry just crossed the threshold, give it a chance.
- At $s = 2\tau$: $P = 0.5$ — coin flip for an entry twice as old as acceptable.
- At $s = 10\tau$: $P = 0.9$ — almost certainly dropped.
- As $s \to \infty$: $P \to 1$ — guaranteed drop.

**Three-part design:** The schedule controls WHEN we evaluate (cadence). Full lane iteration controls WHAT we evaluate (all stale entries, not just the head). The probability controls WHETHER to drop (gradient based on staleness). Each part serves one purpose.

**Why probabilistic, not a hard cutoff?** A deterministic drop (P = 1 for all s > τ) is a step function — every stale entry is treated identically regardless of how far past the threshold it is. This causes two problems:

1. **Burst synchronization.** During a spike, many entries cross the threshold simultaneously. A hard cutoff drops ALL of them in one round — a mass-drop that spikes the drop rate EWMA, inflates early shedding probability, and destabilizes the throughput regulator. The probabilistic approach spreads drops: barely-stale entries survive, very stale ones drop.

2. **Threshold sensitivity.** An entry at sojourn = 101ms (threshold = 100ms) is essentially serviceable — it's 1ms past the threshold. A hard cutoff drops it with the same certainty as an entry at 5000ms. The probabilistic formula gives it P ≈ 1% (likely survives and gets served) vs P ≈ 98% for the 5000ms entry.

**Pool-wide recovery.** ProDel exits DROPPING only when NO lane has stale entries. A fresh head in one lane does not reset dropping — other lanes may still have stale entries. The `staleLanes` counter tracks this during the main traversal loop, avoiding a redundant post-loop scan.

### 2.4 Invariants and Proofs

**Theorem 1 (No fresh drops).** *ProDel never drops an entry with sojourn $< \tau$.*

*Proof.* The drop probability is $P(s) = 1 - \tau/s$. For $s < \tau$: $P < 0$, so the entry is never evaluated for dropping — it enters the admission path instead. For $s = \tau$: $P = 0$. Only entries with $s > \tau$ have $P > 0$. $\square$

**Theorem 2 (Grace period guarantee).** *No drops occur within $CW$ ms of the first observed overload.*

*Proof.* On first observation of $s \geq \tau$ in IDLE, we set $t_f = t + CW$ and transition to GRACE. In GRACE, entries are admitted while $t < t_f$. DROPPING is only entered when $t \geq t_f = t_{\text{first}} + CW$. Probabilistic drops only occur in DROPPING state. Therefore the minimum time between first overload observation and first possible drop is $CW$. $\square$

**Theorem 3 (Drop rate increases with staleness).** *In DROPPING state, the expected number of entries dropped per round increases as entries age.*

*Proof.* For a queue of $n$ entries with sojourns $s_1 \geq s_2 \geq \ldots \geq s_n$ (head is oldest), the expected drops per round is $\sum_{i: s_i > \tau} (1 - \tau/s_i)$. As entries age (sojourns increase between rounds), each $P(s_i)$ increases monotonically. Additionally, the $1/\sqrt{n_d}$ schedule fires faster as cumulative drops grow. Both mechanisms reinforce: older entries → higher P per entry AND shorter intervals between rounds. $\square$

**Theorem 4 (Pool-wide self-recovery).** *ProDel exits DROPPING when no lane has stale entries.*

*Proof.* During the traversal loop, a `staleLanes` counter increments for each lane with a stale head ($s \geq \tau$). After the loop, if `staleLanes === 0`, then `dropping = false` and `firstAboveTime = null`, resetting to IDLE. Additionally, if $Q = 0$ (queue fully drained), recovery is implied. Recovery requires ALL lanes to be healthy — a fresh head in one lane does not reset dropping while other lanes remain stale. $\square$

---

## 3. Probabilistic Early Shedding

### 3.1 Mechanism

When ProDel is in dropping state and the pool is at capacity ($F \geq L$), new arrivals are likely doomed to queue, age past the sojourn threshold, and be dropped. Probabilistic early shedding rejects them **at enqueue time** with probability:

$$P = \frac{\hat{D}}{\hat{D} + \hat\mu} \times \text{shrinkage}(\hat\mu)$$

where $\hat{D}$ is the EWMA drop rate, $\hat\mu$ is the EWMA completion rate, and $\text{shrinkage}(\hat\mu) = \hat\mu / (\hat\mu + Z^2)$ dampens the probability at low throughput where the rate EWMAs are based on few observations.

**Conditions for early shed (all must hold):**
1. Pool is in dropping state (`dropping = true`)
2. Pool is at capacity ($F \geq L$)
3. Drop rate EWMA is positive ($\hat{D} > 0$)
4. Completion rate EWMA is positive ($\hat\mu > 0$)

### 3.2 Properties of the Probability Function

**Theorem 5a (Bounded probability).** *$P \in (0, 1)$ when conditions hold.*

*Proof.* When $\hat{D} > 0$ and $\hat\mu > 0$: $\hat{D} / (\hat{D} + \hat\mu) \in (0, 1)$ and $\text{shrinkage}(\hat\mu) = \hat\mu/(\hat\mu + Z^2) \in (0, 1)$. The product of two values in $(0, 1)$ is in $(0, 1)$. $\square$

**Theorem 5b (Self-regulating).** *Early shedding dampens its own intensity.*

*Proof.* Early-shed entries increment `dropsThisWindow`, which increases $\hat{D}$. However, early shedding prevents entries from entering the queue, which:
1. Reduces queue depth → fewer entries for ProDel to drop → $\hat{D}$ falls
2. Reduces competition for slots → more successful admissions → $\hat\mu$ rises
3. Both effects reduce $P$

The equilibrium: $P$ stabilizes at the value where the combined early-shed + ProDel rate matches the excess arrival rate beyond capacity. $\square$

**Theorem 5c (No starvation).** *Early shedding cannot starve the pool of work.*

*Proof.* Early shedding only fires when $F \geq L$ (at capacity). The pool already has $L$ tasks executing. Shed entries would have queued and waited for a slot — shedding them frees queue space without reducing in-flight work. When tasks complete ($F < L$), the at-capacity condition fails and early shedding stops, allowing new entries to be admitted. $\square$

**Semantic interpretation:** $P = \hat{D} / (\hat{D} + \hat\mu)$ is the fraction of total throughput (drops + completions) that ends up dropped. When drops equal completions ($P = 0.5$), half of new arrivals are rejected immediately. When drops dominate ($P \to 1$), almost all are rejected. When completions dominate ($P \to 0$), almost none are rejected.

### 3.3 Interaction with ProDel

Early shedding and ProDel are complementary:

| Mechanism | When it fires | Latency of 503 | Queue effect |
|-----------|--------------|-----------------|--------------|
| **Early shed** | At enqueue, probabilistic | ~0ms (instant) | Prevents entry from joining queue |
| **ProDel** | In processQueue, probabilistic | sojourn time (≥ τ) | Removes stale entries from queue |

Early shed handles the **flow rate** (preventing queue growth); ProDel handles the **stock** (draining entries already queued). Together they produce instant 503s for most rejected requests while ProDel's sojourn-proportional probability manages the residual queue.

---

## 4. Throughput Regulator

The throughput regulator does not implement detection logic itself. The pool computes a single shared statistical inference state (informally, its *heartbeat*) — `currentAlpha`, `ewmaSumW2`, `df`, `bayesianShrinkage` — derived from the pool's `zScoreThreshold`, and exposes it via `SignalContext.inference` (the `Inference` interface). Pluggable *signals* observe raw task events through lifecycle hooks (`onAdmit`, `onComplete`, `onEvaluate`) and decide when to fire (`triggered`). When any signal fires, the regulator applies a concurrency decrease.

The architecture is two layers:

- **Pool / Executor**: computes the heartbeat (§4.1) and provides shared `Statistics.*` primitives (§4.1.1). One heartbeat per pool — every signal sees the same α, ESS, df, derived from the same single `zScoreThreshold`.
- **Signal**: owns its observation stream (per-pool state, cloned via `signal.clone()` at registration). Implements `triggered(ctx)` by composing the heartbeat + `Statistics.*` primitives.

The built-in `PowerDegraded` signal is the v1.x trend test now expressed as a first-class signal. It composes the heartbeat with its own operational-Little's-Law integral and inline EWMAs (§4.2). Multiple signals on the same pool combine with OR semantics; joint FPR is bounded by Bonferroni (§4.3.2).

### 4.1 EWMA with Time-Weighted Smoothing

**Definition.** The smoothing factor for window $k$ with actual elapsed time $\Delta t_k$ is:

$$\alpha_k = 1 - \exp\left(\frac{-\Delta t_k}{H \cdot CW}\right)$$

where $H = \text{round}(2 / (1 - e^{-1/\sigma_D^2}))$ is the EWMA time constant and $\sigma_D = 2$ (zScoreThreshold).

For $\sigma_D = 2$: $H = \text{round}(2/(1-e^{-1/4})) = \text{round}(2/0.2212) = 9$.

For an on-time window ($\Delta t_k = CW$):

$$\alpha = 1 - e^{-1/9} \approx 0.1052$$

**Motivation for time-weighting.** If a window runs long (e.g., under low throughput, $\Delta t_k = 3\,CW$), the older EWMA is staler. An exponential decay model gives:

$$\text{weight of old data} = e^{-\Delta t / (H \cdot CW)}$$

so $\alpha_k = 1 - e^{-\Delta t_k/(H \cdot CW)}$ is the complement — the fraction of trust placed on the new observation. This is the continuous-time equivalent of discrete EWMA with parameter $\lambda = e^{-1/H}$.

**Lemma 1 (Alpha bounds).** $\alpha_k \in (0, 1)$ for all $\Delta t_k > 0$.

*Proof.* $\exp(-x) \in (0,1)$ for $x > 0$. Thus $1 - \exp(-\Delta t_k / (H \cdot CW)) \in (0,1)$. $\square$

### 4.1.1 Bayesian Shrinkage

All EWMA updates for rate and ratio signals use a shrinkage-scaled alpha:

$$\alpha_{\text{eff}} = \alpha_k \times \text{shrinkage}(n) = \alpha_k \times \frac{n}{n + Z^2}$$

where $n$ is the observation count backing the current window's measurement, and $Z^2 = \sigma_D^2 = 4$.

**Interpretation.** The shrinkage factor $n/(n+Z^2)$ is the optimal Bayesian weight for combining a prior of $Z^2$ pseudo-observations with $n$ new observations. When $n$ is small, the prior dominates and the EWMA update is dampened. When $n$ is large, the observation dominates and the EWMA tracks the signal closely.

**Connection to Wilson score interval (proportions only).** When the signal is a binomial proportion (the per-lane error rate), the shrunk center estimator $(n\hat{p} + 0.5 Z^2)/(n+Z^2)$ is *exactly* the Wilson (1927) interval's center under prior $p_0 = 0.5$. For our other shrunk signals (rates, level $\bar{m}$), the denominator $n + Z^2$ has the same algebraic shape but the underlying conjugate-prior is different (Gamma-Poisson for rates, Normal for the log-W level). So Wilson is the precise frequentist counterpart for the proportion case; for other signals, the connection is "same shrinkage shape, different prior."

**Representative values:**

| $n$ | $\text{shrinkage}(n)$ |
|-----|----------------------|
| 1 | 0.20 |
| 4 | 0.50 |
| 10 | 0.71 |
| 50 | 0.93 |
| 100 | 0.96 |

**Where applied:** completion rate, drop rate, log(W) level EWMA, early shedding probability, and the per-lane error rate (opt-in `LaneErrorShed`). Shrinkage is used for *parameter estimation* only; the trend hypothesis test uses Student-t instead (see §4.3.1.1 for the audit). The relevant $n$ differs per signal:

| Signal | $n$ |
|--------|-----|
| Completion rate, drop rate | `completionsThisWindow` |
| log(W) level EWMA | `completionsThisWindow` (shrinkage-scaled alpha dampens noisy low-throughput windows) |
| Early shedding | `completionRateEwma` (smoothed throughput) |
| Per-lane error rate | $c_\ell$ (lane's cumulative completions) |

### 4.2 The PowerDegraded Detection Pipeline

This is the sensing core of the default regulator signal, **`PowerDegraded`** — named for the operating point it protects, Kleinrock's power knee, where paying more concurrency stops buying throughput. The signal has two channels: a *latency-trend* channel that **arms** (detects *that* latency is degrading, `dW/dt` — this section and §4.3.1's test) and an *elasticity* channel that **attributes and releases** (decides *whether concurrency is the cause and the actuator can fix it*, `dW/dL` — §4.3.1's degradation latch). Detection is temporal and needs no actuator; attribution is interventional and rides the regulator's own limit changes. The pipeline below is, mechanically, the latency-trend arming test.

The latency-trend hypothesis test composes seven layered estimators, each addressing a distinct statistical concern. Stages run in this order every window:

1. **Operational Little's Law**: instantaneous $W_k$ from accumulated in-flight integral (§4.2.1).
2. **Log transform**: $m_k = \log W_k$, robust to multiplicative spikes (§4.2.2).
3. **Level EWMA on $\log W$** with Bayesian-shrinkage-dampened α (§4.2.3).
4. **dLogW** — dt-normalized derivative of the filtered level (§4.2.4).
5. **Trend EWMA** with asymmetric shrinkage on the input (§4.2.5).
6. **MSSD/2 noise estimator** (von Neumann's δ²) — drift-invariant by construction (§4.2.6).
7. **Effective sample size** via exact $\kappa = \sum w_j^2$ recursion (§4.2.7).

The test itself is in §4.3.1: a Student-t z-test using $\hat{v}/\text{SE}$ against a Cornish-Fisher critical value at the δ² estimator's effective df (§4.2.7).

#### 4.2.1 Stage 1 — Operational Little's Law

**Definition.** For window $k$ with elapsed time $\Delta t_k$ and completion count $r_k > 0$, the instantaneous mean-residence estimator is

$$W_k = \frac{\int_{0}^{\Delta t_k} N(t)\, dt}{r_k} = \frac{\texttt{inFlightMs}_k}{r_k}$$

The integral $\int N(t)\,dt$ is accumulated in `inFlightMs` and updated on every in-flight change (admission, completion, evaluation): `inFlightMs += inFlight × (now − lastChange)`.

**Why this is correct (Kim & Whitt, 2013).** Operational Little's Law is an *identity*, not a steady-state asymptotic. For any finite interval $[0, T]$:

$$\int_0^T N(t)\,dt = \sum_{i \in \mathcal{I}_T} R_i^{(T)}$$

where $\mathcal{I}_T$ is the set of tasks present in the interval and $R_i^{(T)} = \min(c_i, T) - \max(a_i, 0)$ is task $i$'s residence time *clipped to the interval*. Dividing by completions $r_k = |\{i : c_i \in [0,T]\}|$ gives a sample-average residence time over the window — exact, no approximation, no stationarity assumption.

The estimator is unbiased for the mean residence time $W$ whenever in-rate equals out-rate over the interval. Under transient flow imbalance (more arrivals than completions, or vice versa) the estimator is biased *high* (more in-flight integral, fewer completions to divide by) — but the bias is bounded by the in-flight integral, which is itself bounded by `inFlight × Δt`. The trend test is robust to this transient bias because (a) the bias is non-negative, so it cannot mask real degradation, and (b) §4.2.5's shrinkage dampens single-completion-per-window spikes proportionally to evidence.

**Why this is not just $L/\hat\mu$.** A naïve estimate $W \approx \hat{L} / \hat\mu$ multiplies two EWMAs of different signals — their estimation errors compound. Operational LL produces a single window-level sample with one source of variance ($r_k$ is an integer count, $\int N$ is exact), avoiding compounded errors.

**Robustness to the cap.** When $W \gg CW$ (long tasks span multiple windows), most windows have $r_k = 0$ and are skipped via the gate `r_k > 0 ∧ inFlightMs > 0`. When a completion eventually arrives, `inFlightMs` has accumulated the integral *across all those skipped windows*, so $W_k = \text{(multi-window integral)} / r_k$ is still the correct sample-average residence by the same identity. The estimator handles arbitrary $W/CW$ ratios without modification.

#### 4.2.2 Stage 2 — Log Transform

$$m_k = \log W_k$$

**Why log-space.** Latency degradations are typically multiplicative (a slow downstream makes everything 2× slower), and outlier spikes inflate $W$ by orders of magnitude. In linear space, a single outlier dominates an EWMA and corrupts variance estimates for many windows. The log transform converts multiplicative drift to additive drift and compresses spikes — a 10× outlier becomes $+\log 10 \approx 2.3$ instead of an arbitrary multiplier.

#### 4.2.3 Stage 3 — Level EWMA on $\log W$

The level estimator $\bar{m}_k$ is a Bayesian-shrinkage-dampened EWMA:

$$\alpha_{\text{level}} = \alpha_k \cdot s_k, \quad s_k = \frac{r_k}{r_k + Z^2}, \quad \bar{m}_k = (1 - \alpha_{\text{level}})\, \bar{m}_{k-1} + \alpha_{\text{level}}\, m_k$$

**Why shrinkage applies here.** This is *parameter estimation* — we want a point estimate of $\log W$ at the current operating point. Bayesian shrinkage is the conjugate-prior treatment: $s_k = r_k/(r_k + Z^2)$ weights the new observation worth $r_k$ samples against a prior worth $Z^2 = 4$ pseudo-observations. At low throughput (sparse completions), the prior dominates; at high throughput, the observation dominates. Same mathematics as the Wilson score interval and the Gamma–Poisson posterior mean.

**Where this matters.** Without shrinkage, a single-completion window after a stall produces a wildly inflated $m_k$ (because $W_k = \text{multi-window integral}/1$). The shrinkage $s_k = 1/(1+4) = 0.2$ caps the level update at 20% of full strength on that window — dampened to a fraction of one full EWMA step.

#### 4.2.4 Stage 4 — dLogW (filtered derivative)

The trend signal is the dt-normalized rate of change in the filtered level:

$$v_k = \frac{\bar{m}_k - \bar{m}_{k-1}}{\widetilde{\Delta t}_k}, \quad \widetilde{\Delta t}_k = \frac{\Delta t_k}{CW}$$

where $CW$ is `controlWindow` and $\widetilde{\Delta t}_k$ is the window-normalized elapsed time (dimensionless, $\approx 1$ per on-time window).

**Why dt-normalize.** A one-time level shift accumulated over $N$ idle windows is *not* a sustained per-window trend. Dividing by $\widetilde{\Delta t}$ converts the level diff to a per-window rate — the same "trend per window" semantics regardless of how long the elapsed gap was.

**Why the filtered level rather than raw $m_k$.** Using $v_k = m_k - m_{k-1}$ would inherit the full per-window noise of $m_k$, which is large at sparse completions. Using $v_k = \Delta \bar{m}_k$ inherits only the *EWMA-smoothed* fluctuations, which scale with $\sqrt{\kappa}$ — the right amount of noise dampening for the test statistic.

#### 4.2.5 Stage 5 — Trend EWMA (asymmetric shrinkage)

$$\hat{v}_k = (1 - \alpha_k)\, \hat{v}_{k-1} + \alpha_k\, (v_k \cdot s_k)$$

The derivative $v_k$ is multiplied by the per-window shrinkage $s_k = r_k/(r_k + Z^2)$ before entering the trend EWMA. The MSSD/2 noise estimator (§4.2.6) sees the *unshrunk* $v_k$. This is **asymmetric**: shrinkage on the numerator, raw signal on the denominator.

**Why asymmetric.** Under $H_0$ ($E[v_k] = 0$), shrinking the numerator while leaving δ² unshrunk can only *lower* FPR: the numerator's variance shrinks while the SE stays calibrated to the raw noise. (Strictly, $E[v_k s_k] = 0$ requires $s_k$ — a function of $r_k$ — to be mean-independent of $v_k$; $r_k$ and $W_k$ are coupled through Little's law, so this is an approximation. The measured net effect of the coupling is small and dominated by the shrinkage conservatism; see Theorem 7's caveats.) Under $H_1$ ($E[v_k] = \mu_v > 0$), low-throughput windows have small $s_k$, so the trend numerator $E[\hat{v}] = \mu_v \cdot \bar{s}$ is dampened — the test is *more conservative* at low throughput, requiring stronger evidence per window before firing. Detection delay grows at low throughput; FPR does not.

**Why MSSD/2 is unshrunk.** δ² is a noise-floor estimator, and we want it calibrated to actual noise (so SE is right). Shrinking δ² inputs would underestimate noise at low throughput, producing too-easy fires.

#### 4.2.6 Stage 6 — MSSD/2 Noise Estimator (von Neumann's δ²)

$$\delta^2_k = (1 - \alpha_k)\, \delta^2_{k-1} + \alpha_k \cdot \frac{(v_k - v_{k-1})^2}{2}$$

This is the **mean squared successive difference**, halved — also known as von Neumann's δ². It estimates $\sigma_v^2$ via lag-1 squared differences.

**Why δ² (and why halved).** For a stationary sequence with finite variance and small autocorrelation, $E[(v_k - v_{k-1})^2] = 2\,\text{Var}(v) - 2\,\text{Cov}(v_k, v_{k-1}) = 2\sigma_v^2(1 - \rho_1)$. Dividing by $2$ gives an unbiased estimator of $\sigma_v^2$ when $\rho_1 = 0$, and remains close to unbiased for moderate autocorrelation. The factor $1/2$ is what makes it called "δ²" rather than "MSSD".

**Why it's drift-invariant.** A pure drift component $v_k = \mu + \epsilon_k$ has differences $v_k - v_{k-1} = \epsilon_k - \epsilon_{k-1}$ — the drift $\mu$ cancels exactly. So under $H_1$, δ² still tracks the noise of $\epsilon_k$, not the drift level. This is the **key property** that distinguishes δ² from any centered-variance estimator like Welford's: drift does not inflate the noise floor under $H_1$, so the test statistic $\hat{v}/\text{SE}$ grows linearly with $\mu$ — there is no saturation ceiling. Empirically validated against Welford-B and second-moment alternatives in v1.2.0 benchmarking (`.changeset/statistical-rigor.md`); a reproducible in-repo comparison is `benchmark-fpr.ts` Mode E — against a centered-variance (Welford-style) noise floor, δ² is never slower, and on slow drifts (+0.2%/window) detects ~4× sooner (50 vs 218 windows). At large magnitudes both fire promptly in that harness — the centered statistic saturates at a ceiling rather than growing with $\mu_v$, but the ceiling still clears the threshold there; the practical gap concentrates on subtle degradations.

**Autocorrelation correction.** Since $v_k$ is the first difference of an AR(1)-like EWMA, it carries known lag-1 negative autocorrelation $\rho_1 = -\alpha/2$. This causes the lag-1 squared difference to *overestimate* $\sigma_v^2$ by factor $(1 + \alpha/2)$:

$$E[\delta^2] = \sigma_v^2 \cdot (1 - \rho_1) = \sigma_v^2 \cdot (1 + \alpha/2)$$

The unbiased $\sigma^2$ estimator divides out this factor:

$$\hat\sigma_v^2 = \frac{\delta^2}{1 + \alpha/2}$$

Under constant $\alpha$ this is exact; under smooth time-varying $\alpha$ it is a first-order approximation, accurate at steady state.

**Batch-means noise floor (data autocorrelation).** The lag-1 δ² above prices the correlation the pipeline itself *manufactures* (the $(1+\alpha/2)$ factor — a data-independent function of $\alpha$), but it *understates* the floor when the **data** carries correlation at scales below the decision horizon (AR(1) latency, GC pauses): a correlated excursion inflates $\hat v$ but not the lag-1 δ², so the test over-fires. concurrex prices this at the **decision timescale** instead. Window rates are accumulated into non-overlapping blocks of length $\tau = H$ windows; the block rate $b_j = \sum(\text{rate}\cdot dt)/\sum dt$ telescopes to the level change across the block over its duration, so successive block rates stay **drift-invariant** while their lag-1 estimator $\delta^2_B = \text{EWMA}[\text{MSSD}/2]$ prices *all* correlation at scales below $\tau$ into the noise floor — $\sigma^2_{\text{LR}} = \tau\,\delta^2_B$ is the per-window long-run variance including that correlation. There is **no correlation model and no new constant**: correlation persisting *past* $\tau$ is deliberately treated as signal, matching the actuator's decision semantics, and the identifiability trap of an online $\hat\rho$ correction (a latency step's smooth transient reads as correlated noise and suppresses the detection it should trigger) is avoided because the block estimator *absorbs* correlation rather than *estimating* it. The floor is used once the block estimator's own overlapping-δ² df matures (§4.2.7); until then the lag-1 δ² is the warm-up fallback, so cold-start detection is unchanged. Under i.i.d. inputs the two agree ($\sigma^2_{\text{LR}} = \sigma^2_{\text{window}}$); a *sharp* incident is still caught in ~1 window because $\delta^2_B$ has not yet absorbed the fresh block, so the floor only inflates for *sustained* correlation.

The measured consequences (`simulations/benchmark-fpr.ts`):

Two distinct quantities are reported below (`--randomSeed`-free but deterministic — the bench seeds its own noise RNGs). The **entry rate** — the fraction of *evaluations* that fire — is what the Φ(−σ_D) bound governs; the **latched-state occupancy** — the fraction of *windows* spent latched — is a strictly larger, τ-dependent quantity (a false latch holds ~1–2 extra evaluations before releasing), *not* bounded by Φ(−σ_D). The numbers here are latched-state occupancy unless stated.

All numbers below are latched-state occupancy with the batch-means floor active (before → after, where "before" is the lag-1-δ²-only floor).

- **i.i.d., bursty** noise: well under the bound (i.i.d. ≈ 0.8%, down from 4.4%; bursty ≈ 0.35%). Under i.i.d. the block floor equals the δ² floor in expectation, so calibration is preserved — the slight reduction is the block estimator's mild conservatism.
- **AR(1)** correlated noise — the former headline failure — now **holds the bound**: ≈ 2.2% at $\rho = 0.5$ and ≈ 2.0% at $\rho = 0.8$, down from **22.7%** and **42.2%**. This is *without* widening the window: the batch-means floor prices the correlation directly. (Window-sizing — $CW \geq 2T_c$ — remains available and further reduces the residual, but is no longer required.)
- **GC-style pauses.** A pause spanning 2–4 windows is *sub-τ* correlation the block floor mostly absorbs: ≈ 11.9% at 5× (down from 22.9%) — halved, but still above the bound because such a pulse is a large fraction of a single τ-block, so part of it lands in the trend before its block closes. Guidance stands: size `controlWindow` above the longest routine pause, which pushes the pulse fully inside the sub-τ regime the floor handles.
- **Sporadic 100× stragglers**: ≈ 3.3% (down from 10.7%) — the residence integral dilutes a lone straggler and the block floor prices its micro-plateau.
- **Single-window 4× spikes** (3% of windows, stationary heavy tail): ≈ 6.5%. This is the one row the block floor does *not* help — a spike contained in one window is not sub-τ correlation, it's a point heavy-tail event the log transform and shrinkage must absorb on their own.

The remaining failure axis is therefore narrow: correlation at scales **at or above** $\tau$ (multi-window pulses approaching the block length) and single-window heavy tails. Both are addressed by window sizing — a wider `controlWindow` pushes multi-window pulses into the sub-τ regime the batch-means floor prices automatically.

#### 4.2.7 Stage 7 — Effective Sample Size ($\kappa$ recursion)

For an EWMA with time-varying weights $w_j$, the standard $\alpha/(2-\alpha)$ formula does not apply. Instead, $\kappa = \sum_j w_j^2$ is tracked exactly:

$$\kappa_k = (1 - \alpha_k)^2\, \kappa_{k-1} + \alpha_k^2$$

**Properties.**
- $\kappa$ is seeded at 1 — a one-observation prior (one weighted sample, full uncertainty); it decays below 1 from the first window update.
- After idle ($\alpha \to 1$), $\kappa \to 1$ — the EWMA effectively resets, and the system reports only one effective sample, widening SE.
- At steady state under constant $\alpha$, $\kappa \to \alpha/(2-\alpha) \approx 0.055$ at $\alpha = 0.105$.

**Why this is the right ESS.** $\text{Var}(\hat{v}) = \sigma^2 \cdot \kappa$ for an EWMA of independent $v_k$. The Satterthwaite ESS — the equivalent number of equally-weighted observations — is $1/\kappa$, and df $= 1/\kappa - 1$ (Welch–Satterthwaite, equal-variance case). This mean-type df gates evaluability.

**The t-quantile's df is the variance estimator's, and it is smaller.** Student's construction requires the df of $\hat\sigma^2$, not of the mean: by variance matching, $\text{df}_{\delta^2} = 2\,E[\delta^2]^2/\text{Var}(\delta^2) = 1/(\kappa c)$. Because successive squared differences overlap ($\Delta_k$ and $\Delta_{k+1}$ share $v_k$), δ² carries fewer independent observations than its weight count: with Gaussian fourth moments (Isserlis: $\text{Cov}(X^2,Y^2) = 2\,\text{Cov}(X,Y)^2$) and the derived ARMA(1,1) autocovariances of the difference stream,

$$c = 1 + 2\sum_{h\ge1}(1-\alpha)^h \rho_\Delta(h)^2 \approx 1 + 2(1-\alpha)\rho_\Delta(1)^2, \qquad \rho_\Delta(1) = -\frac{1+\alpha/2+\alpha^2/2}{2(1+\alpha/2)}$$

(lags $\ge 2$ are $O(\alpha^6)$). At $\alpha \approx 0.105$: $c \approx 1.45$, so df $\approx 12.4$ instead of $17$ at steady state — a $\approx 3\%$ higher critical value (`Statistics.mssdEffectiveDf`). Monte Carlo confirmation (`simulations/mc-df.ts`, 30k replications of the exact pipeline): measured df$_{\text{eff}}$ = 12.43 vs predicted 12.43; the equal-weight classical analogue is df $= 2m^2/(3m-1)$, a cut to $2/3$.

**Time-varying α.** The $1/\kappa$ factor is exact under any α sequence (the recursion tracks true $\Sigma w^2$); the correction $c$ evaluates $\rho_\Delta(1)$ and the cross-weight factor $(1-\alpha)$ at the *current* α — exact at constant α, first-order otherwise, the same status as the $(1+\alpha/2)$ divisor. The exact time-varying form replaces $(1-\alpha)\kappa$ with the tracked adjacent cross-sum $S_1 = \sum_j w_j w_{j+1}$ (recursion: $S_1 \leftarrow (1-\alpha)^2 S_1 + \alpha(1-\alpha)\alpha_{\text{prev}}$), giving df $= 1/(\kappa + 2\rho_\Delta(1)^2 S_1)$. Measured under aggressive window jitter (elapsed $\sim U(0.5, 1.5)\cdot CW$): true df 11.94, shipped approximation 11.54 ($-3.3\%$, conservative side, $\approx 0.4\%$ on the threshold), exact $S_1$ form 11.83. The shipped form is retained; the $S_1$ recursion is the drop-in refinement if a deployment's window cadence is far more irregular than this. Note $\rho_\Delta(1) \approx -0.503$ is the same lag-1 difference correlation that anchors the identifiability analysis of §4.2.6 — one constant, three roles.

#### 4.2.8 Other EWMA Updates (rates and counts)

The remaining EWMAs are not part of the trend-test pipeline; they support observability and other regulator branches. All use the time-weighted $\alpha_k$ from §4.1, with shrinkage applied for parameter-estimation signals:

**Rate signals** (Bayesian shrinkage on $\alpha$ scaled by per-window count $n_k = r_k$):

$$\alpha_c = \alpha_k \cdot \frac{r_k}{r_k + Z^2}$$

$$\hat\mu_k = (1 - \alpha_c) \hat\mu_{k-1} + \alpha_c r_k \quad (\text{completion rate})$$

$$\hat{D}_k = (1 - \alpha_c) \hat{D}_{k-1} + \alpha_c d_k \quad (\text{drop rate})$$

**Counts** (raw $\alpha_k$ — admissions are not rate-shrunk because they are exact admission events):

$$\hat{a}_k = (1 - \alpha_k) \hat{a}_{k-1} + \alpha_k a_k \quad (\text{admission rate})$$

$$\hat{L}_k = (1 - \alpha_k) \hat{L}_{k-1} + \alpha_k F_k \quad (\text{in-flight count})$$

**Per-lane error rate** (computed inside the opt-in `LaneErrorShed` admission signal — time-weighted, with Bayesian shrinkage on the lane's cumulative completion count $c_\ell$):

$$\alpha_\ell^{\text{time}} = 1 - \exp\left(\frac{-\max(1, t - t_\ell)}{H \cdot CW}\right), \quad \alpha_\ell = \alpha_\ell^{\text{time}} \cdot \frac{c_\ell}{c_\ell + Z^2}$$

$$\hat{p}_\ell \leftarrow (1 - \alpha_\ell) \hat{p}_\ell + \alpha_\ell\,[e]$$

where $[e] = 1$ if the task errored, $0$ otherwise. The $\max(1, \cdot)$ floor ensures rapid same-tick completions still contribute weight. The Bayesian shrinkage $c_\ell/(c_\ell + Z^2)$ dampens noisy early estimates (1 completion: 20%, 4 completions: 50%, 10 completions: 71%), preventing aggressive shedding before a lane has enough history. `LaneErrorShed` is **not** registered by default — the pool-wide error EWMA was removed in v2.0 and this lane-level mechanism is opt-in for the same reason (errors are domain-specific). The signal owns its per-lane state (a `Map`), populated in `onComplete` and released in `onLaneRemoved`.

### 4.3 Detection Thresholds

#### 4.3.1 Latency Detection (Student-t Hypothesis Test)

**Null hypothesis $H_0$:** latency is stable. $E[v] = 0$.

**Alternative hypothesis $H_1$:** latency is degrading. $E[v] > 0$.

**Philosophy: shrinkage for estimation, Student-t for the test.** Bayesian shrinkage and Student-t address distinct sources of small-sample uncertainty:

- **Shrinkage** (`n/(n + n_0)`) attenuates a parameter estimate toward a prior — the correct Bayesian treatment under a conjugate prior. Used for every *estimation* signal in the system: level, rates, proportions, lane error rates.
- **Student-t** (critical value grows as df decreases) is the exact sampling distribution of a z-like statistic when $\sigma^2$ is replaced by an estimate $\hat\sigma^2$. Used for the one *hypothesis test* in the system.

They solve different problems and are complementary, not substitutes. See §4.3.1.1 for the full audit.

##### Test statistic and SE formula

The test statistic is

$$t = \frac{\hat{v}}{\text{SE}}, \quad \text{SE}^2 = \hat\sigma_v^2 \cdot \kappa \cdot \frac{1 + \kappa}{2}, \quad \hat\sigma_v^2 = \frac{\delta^2}{1 + \alpha/2}$$

This expression has four components. In the idealized single-$\alpha$ model ($s_k = 1$, analyzed in Appendix A), $E[\text{SE}^2] = \text{Var}(\hat{v})$ exactly at steady state under $H_0$. In the shipped pipeline the level EWMA uses $\alpha \cdot s_k$ while the trend EWMA and $\delta^2$ use raw $\alpha$; this mixed-$\alpha$ deviation biases SE² low relative to the variance of an *unshrunk* trend EWMA, but the actual numerator is the *shrunk* trend EWMA, whose variance is smaller still — the net test is conservative (measured $E[\text{SE}^2]/\text{Var}(\hat v)$ ranges from 1.24 at $r = 25$ to 2.97 at $r = 4$).

**(a) δ² noise estimator with autocorrelation bias.** $v_k$ carries filter-induced $\rho_1 = -\alpha/2$, so $E[\delta^2] = \sigma_v^2(1 + \alpha/2)$ under $H_0$, and $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ is unbiased (derivation: §4.2.6 and Appendix A.5).

**(b) Variance of an EWMA on autocorrelated $v$.** For an EWMA of $v_k$ with weights $w_j$, the standard formula $\text{Var}(\hat{v}) = \sigma_v^2 \sum_j w_j^2$ assumes independence. Under our actual lag-h autocorrelation $\rho_h = -\alpha(1-\alpha)^{h-1}/2$ (extending $\rho_1$ to higher lags), cross terms reduce the variance:

$$\text{Var}(\hat{v}) = \sigma_v^2 \left[\sum_j w_j^2 + 2\sum_{h \geq 1} \rho_h \sum_j w_j w_{j+h}\right]$$

Working through with $\sum_j w_j w_{j+h} = \alpha(1-\alpha)^h/(2-\alpha)$ at steady state and the closed-form $\rho_h$ above:

$$\text{Var}(\hat{v}) = \sigma_v^2 \cdot \kappa \cdot \frac{1 + \kappa}{2}$$

The $(1+\kappa)/2$ factor is the **autocorrelation variance-reduction** — negative autocorrelation suppresses the EWMA's variance below the i.i.d. baseline. At steady state $\alpha \approx 0.105$ (so $\kappa \approx 0.055$), the factor is $\approx 0.527$ — `Var(ĥ)` is about half what it would be under independence.

**(c) Tracking $\kappa$ exactly.** $\kappa_k = (1-\alpha_k)^2 \kappa_{k-1} + \alpha_k^2$ generalizes the constant-$\alpha$ formula $\alpha/(2-\alpha)$ to time-varying $\alpha$. The same tracked $\kappa$ appears twice in the SE formula: once as $\kappa$ (sum-of-squared-weights) and once inside $(1+\kappa)/2$ (autocorrelation factor). Both are exact in tracked state under constant $\alpha$, and degenerate gracefully under varying $\alpha$ — when $\kappa \to 1$ (one effective sample, post-idle), the autocorrelation factor approaches 1, so SE² → σ̂² (no autocorrelation correction when there's effectively one sample).

**(d) Drift invariance.** Constant drift cancels in lag-1 differences, so $\delta^2$ stays calibrated to the noise under $H_1$ and the test statistic grows without a saturation ceiling. The formal statement and proof are Theorem 8; the contrast with centered-variance estimators (Welford etc.) is in §4.2.6.

**Putting it together.** Combining (a), (b), (c), (d):

$$\text{SE}^2 = \hat\sigma_v^2 \cdot \kappa \cdot \frac{1+\kappa}{2} = \frac{\delta^2 \cdot \kappa \cdot (1 + \kappa)}{2 \cdot (1 + \alpha/2)}$$

Under constant $\alpha$ this is exact under both $H_0$ and $H_1$. Under smooth time-varying $\alpha$ it is a first-order approximation, accurate at steady state.

##### Degrees of freedom and Student-t critical value

Because $\sigma_v^2$ is estimated (not known), the studentized ratio $\hat{v}/\text{SE}$ follows a Student-t distribution rather than a standard normal. Student's construction requires the df of the *variance estimator*, which for the overlapping-differences δ² is (§4.2.7)

$$t = \frac{\hat{v}}{\text{SE}} \sim t_\nu, \quad \nu = \frac{1}{\kappa\, c}$$

This is the df the implementation passes to `tScore` (`Statistics.mssdEffectiveDf`). Two related quantities:

- $1/\kappa$ is the mean-type **effective sample size** — the equivalent number of equally-weighted samples that would produce the same $\text{Var}(\hat{v})$. The heartbeat df $= 1/\kappa - 1$ (Satterthwaite ESS − 1) is exposed as `Inference.df` and gates evaluability.
- $c \approx 1.45$ corrects for the overlap of successive squared differences in δ² (§4.2.7), cutting the test df below the weight count.

At steady state under $\alpha \approx 0.105$: $\kappa \approx 0.055$, so ESS $\approx 18$, heartbeat df $\approx 17$, and test df $\nu = 1/(\kappa c) \approx 12.4$. After idle: $\kappa \approx 1$, $\nu \approx 0.7$ — the test is gated off (see Theorem 9).

**Critical value via Cornish-Fisher with conservative truncation bound.** Computing the exact Student-t quantile $t_{1-\Phi(-\sigma_D),\,\nu}$ requires the inverse incomplete beta function, which is expensive and has tricky edge cases at small $\nu$. concurrex uses the classical 4th-order Fisher–Cornish inverse-t series (Abramowitz & Stegun 26.7.5; cf. Hill 1970), plus an asymptotic-series truncation bound:

$$t_{1-p,\,\nu} \approx z_p + \frac{g_1}{\nu} + \frac{g_2}{\nu^2} + \frac{g_3}{\nu^3} + \frac{g_4}{\nu^4} \;+\; 2 \left|\frac{g_4}{\nu^4}\right|$$

where $z_p = \Phi^{-1}(1-p) = \sigma_D$ for our test, and $g_1, g_2, g_3, g_4$ are polynomials in $z_p$:

$$g_1 = \frac{z(z^2 + 1)}{4}, \quad g_2 = \frac{z(5z^4 + 16z^2 + 3)}{96}, \quad \ldots$$

The truncation bound $2|g_4/\nu^4|$ is a one-sided upper bound on the geometric-tail residual: at $\nu \geq 5$, the series coefficients decay with ratio $\leq 1/2$ between successive terms, so the truncation error is bounded by twice the last included term.

**Net effect.** `tScore(z, df)` returns a finite value only where the truncation bound is certified — $\nu \geq 5$, where the series terms decay geometrically with ratio $\leq 1/2$ (numerically verified for $z \leq 4$) — and $+\infty$ below. Every value it returns therefore upper-bounds the true $t$-quantile at every $\nu$: by the truncation bound at $\nu \geq 5$, trivially below. A finite bound below $\nu = 5$ is not achievable by this series or any refinement of it: the true quantile grows exponentially in $1/\nu$ and outruns any polynomial in $1/\nu$ — the limitation is structural, not a matter of adding terms. As $\nu \to \infty$ the bound converges to $z = \sigma_D$ and FPR converges to $\Phi(-\sigma_D)$. Below $\nu = 5$ the infinite critical value gates the test off; the test df reaches 5 about $1.2H$ windows after cold start or an idle reset (Theorem 9), and steady state sits at $\nu \approx 12.4$, so normal operation never sees the gate.

**Test rule.** Latency is degrading when

$$\hat{v} > \text{tScore}(\sigma_D,\, \nu) \cdot \text{SE}$$

At $\sigma_D = 2$, nominal FPR $\leq \Phi(-2) \approx 2.3\%$ at all $\nu$ (Theorem 7), with the measured i.i.d. **entry** rate below it ($\approx 1.4\%$, `benchmark-fpr.ts`) — the conservatism comes mainly from the asymmetric shrinkage on the trend numerator (§4.2.5); the truncation bound itself adds only $\approx 0.007\%$ at the steady-state df. (Latched-state *occupancy* is a larger, τ-dependent quantity — §4.2.6, §4.3.1.)

##### Idle and sparse traffic handling

Three mechanisms cooperate to gate the test off when evidence is insufficient — all *implicit* through the math, no special-case code:

1. **Time-weighted alpha** $\alpha_k = 1 - e^{-\Delta t / (H \cdot CW)}$ approaches 1 after long idle gaps, so the first observation after idle dominates the EWMA — but $\kappa$ resets to ≈ 1 simultaneously.
2. **$\kappa$ correctly tracks ESS** under time-varying $\alpha$. After idle, $\kappa \approx 1$ (ESS = 1), so the test df $\nu = 1/(\kappa c) \approx 0.7$.
3. **The critical value is infinite below $\nu = 5$** — `tScore` certifies no finite bound outside the series' domain — so the test cannot fire until $\approx 1.2H$ windows of effective evidence have accumulated (steady state is $\nu \approx 12.4$).

There are no warm-up counters or clamps in the signal code — the gate is the certified domain of the critical-value bound, a property of the mathematics rather than of control flow.

##### The degradation latch — an elasticity test run as directed experiments

The quantity that defines the contention knee is the elasticity $\varepsilon = d\log W / d\log L$: $\approx 0$ below the knee (concurrency buys throughput, not latency), $\geq 1$ above it. `triggered()` should report "above the knee" — but $\varepsilon$ is a slope, and slopes are only measurable when $L$ moves: at any stable operating point (including a degraded plateau) $\Delta\log L = 0$ and $\varepsilon$ is unidentifiable from passive data; moreover $L$ moves *because of* $W$ (feedback), so a continuous regression of $\Delta\log W$ on $\Delta\log L$ is the classical closed-loop identification trap. The latch is the resolution: **measure $\varepsilon$ during the two directed experiments where causality is known — the climb and the walk-back — and hold the last evidenced conclusion in between.**

Every comparison below uses one yardstick, the **level resolution** $m = \sigma_D \cdot \text{SE}_{\bar{m}}$ — the smallest log-latency difference distinguishable from this pool's own noise at confidence $\sigma_D$ (derivation of $\text{SE}_{\bar{m}}$ under the level exit below).

1. **Arming (the climb):** during an increase run, $\Delta\ell > 0$ by deliberate steps. The calibrated trend test firing is the detection that the level responded — $\varepsilon > 0$ evidenced on the way up, at entry FPR $\leq \Phi(-\sigma_D)$ per evaluation. On fire, the signal snapshots the *point of crossing* $(\log \bar{m}_0,\, \log L_0)$.
2. **Signed changes since crossing, matched-filtered:** $\Delta w = \bar{m} - \bar{m}_0$, and $\Delta\ell = \bar{\ell} - \bar{\ell}_0$ where $\bar{\ell}$ is $\log L$ passed through the *identical* level EWMA (same $\alpha \cdot s_k$, same update windows). Both differences then share one transfer function, so sensor lag cancels identically at every window — comparing an instant $\Delta\log L$ against the filtered $\Delta w$ would register the unabsorbed transient of every limit step ($\approx 0.9\times$ the step one window after a tick) as a spurious deficit and falsely reject $\varepsilon = 1$ at any true elasticity. Cumulative differencing additionally avoids per-window ratios (0/0 gaps, smoothing-horizon constants). While the trend test keeps firing, the crossing origin $\bar{m}_0$ is max-ratcheted to the worst level reached, so the walk-back is measured against the excursion's peak.
3. **Firing is decided by $\varepsilon$ (the walk-back test):** the latch releases when

$$-\Delta\ell \geq m \quad \wedge \quad D \geq \sqrt{2}\,m, \qquad D = \Delta w - \Delta\ell$$

   — the (filtered) change in $L$ since arming is resolvable, and the response fell short of proportional by a resolvable amount ($D$ differences two noisy level endpoints, hence the $\sqrt{2}$ on its threshold — derived, not tuned; the dose side is noise-free, $L$ being our own actuator). Writing $d = -\Delta\ell$, this is algebraically identical to $\hat\varepsilon = \Delta w / \Delta\ell \leq 1 - m/d$ (with $d \geq m$): since $L$ is exactly known (our own actuator) and only $\Delta w$ is noisy with noise $m$, the measurement uncertainty of $\hat\varepsilon$ is $m/d$ — so the rule is simply *release when $\hat\varepsilon$ is $\sigma_D$-resolvably below 1*, with a threshold $1 - m/d$ that sharpens automatically as $|\Delta\ell|$ grows, and the condition $d \geq m$ ensuring the test can distinguish $\varepsilon = 0$ from $\varepsilon = 1$ at all before concluding. The reference point is 1, not 0, because **the knee test's null hypothesis — $\varepsilon = 1$ — is a *sharp* null**: under saturation Little's law makes it an identity ($W = \bar{N}/X$ with $X$ capped), not a model. The deficit $D$ is the division-free form: $D \approx 0 \Leftrightarrow \varepsilon \approx 1$ (above the knee — reducing $L$ buys latency one-for-one, keep firing); $D \geq m \Leftrightarrow \varepsilon \approx 0$ (at or below the knee, or the latency is exogenous). By Little's law ($\log \widetilde{W} = \log \bar{N} - \log X$), $D$ is *identically the log-throughput cost of the concurrency reduction* — the release rule reads "stop once paying throughput stopped buying latency." (Implementing directly on measured throughput would confound with demand changes; the $\Delta w - \Delta\ell$ form is the throughput interpretation with demand and slack handled automatically.) The verdict additionally requires the **binding-premise check**: a third matched filter tracks $\log \bar{X}$ (throughput), and under a binding limit Little's law forces $\Delta x = \Delta\ell - \Delta w$ exactly — if the measured $\Delta x$ disagrees beyond $\sigma_D$ standard errors of the throughput noise (Poisson, $\mathrm{Var}(\log X) \approx 1/r$ per window — derived), the limit was not binding during the walk-back (demand slack), the dose was fictional, and no below-knee conclusion is drawn. On release, re-base the reference to the new normal — explicitly, once, on evidence. Because each episode's stopping point is knee-anchored (where the response flattens), no drift can accumulate across episodes.

Two auxiliary rules complete the case analysis:

- **Level exit (recovery band).** $L$ only changes at regulation ticks, so the $\varepsilon$ test cannot conclude sooner; false fires and self-healing blips usually resolve first. The signal tracks a *reference level* — a second EWMA of $\bar{m}$, same $\alpha \cdot s_k$, **downward-only** (`ref ← min(ref, update)`): improvements are absorbed immediately, a higher level is never silently absorbed, and upward re-basing happens only through the evidence-gated release in step 3. There is no separate "freeze while latched" rule — during an excursion the level sits above the reference, so the EWMA update points up and the min rejects it: stationarity during episodes is a *property* of downward-only tracking, not a mechanism. The latch releases without any experiment when $\bar{m} \leq \text{ref} + \sigma_D \cdot \text{SE}_{\bar{m}}$, with $\text{SE}_{\bar{m}} = \sqrt{\kappa\,\sigma_x^2}$, $\sigma_x^2 = \hat\sigma_v^2/(\alpha^2(1+\kappa))$ (Appendix A.1) — statistically indistinguishable from the pre-excursion level. This is the cheap path; the $\varepsilon$ test is the decisive one.
- **No-experiment backstop (stall).** If $L$ cannot change — clamped at $L_{\min}$, or no decrease actuator at all — the $\varepsilon$ question is unanswerable; after one full regulation cycle ($H$ windows) with the limit unmoved and the level still elevated, release rather than assert — **without re-basing the reference**: a stall is the absence of evidence, and a higher level is never absorbed as normal without it.

The signal is thus **three one-sided hypothesis tests sharing one $\sigma_D$**, each against a sharp null judged at $\sigma_D$ of its own measured noise: *fire* when "flat" ($E[v] = 0$) is rejected upward; *stay fired* until either "normal" (level = reference) can no longer be rejected, or "saturated" ($\varepsilon = 1$, exact by Little's law) is rejected downward — the latter re-basing "normal." All thresholds reuse the recovery margin; the only free parameter remains $\sigma_D$. Under $H_0$ a false latch releases within a window or two (the level never left the reference band), so latched-state occupancy is a small multiple of the entry rate: measured $\approx 3\times$ under i.i.d. traffic (`benchmark-fpr.ts` Mode A/C — latched occupancy $\approx 4.4\%$ vs an entry rate $\approx 1.4\% \leq$ the 2.28% bound at $\sigma_D = 2$; the correlated-noise rows of §4.2.6 inflate both). The exit criterion is CUSUM-flavored persistence — the level-minus-reference gap is the *integral* of the trend (Page 1954) — assembled from the pipeline's existing parts.

**Why the mean is the only observable (dispersion rejected).** A second-moment channel — the trend test run on $\log(1+CV^2)$ of residence times — was designed and rejected on a *completeness* argument: contention is monotone in individual residence times (it lengthens some, shortens none), so every concurrency-caused degradation of any shape moves the log-mean; the mean channel misses nothing, eventually. Dispersion therefore adds no coverage — only detection *speed*, and only in one corner of plant space: a small fraction $p$ of tasks slowed severely (factor $c$), where the mean's evidence is diluted to $\sim p(c-1)$ while the second moment is amplified by $\sim p c^2$. Against that stands a structural blindness — $CV^2$ is scale-free, hence exactly invariant under uniform (multiplicative) contention, the default plant — and a worse resolution floor (fourth-moment noise). A channel whose information content is conditional on plant structure does not belong beside one that is unconditional and identity-anchored; fast convoy detection under an explicit tail SLO is the one workload that would revisit this, alongside the deferred `latencyBudget` option. (An earlier objection — that completion-weighted shape statistics confound contention with served-mix composition — turns out not to bind here: admission is size-blind, lane-round-robin with sojourn-based shedding, so the served mix is $L$-invariant to first order and the pool's own statistics are probe-valid. Blind admission is what makes directed experiments on completion statistics measure the plant rather than the sampler.)

##### 4.3.1.1 Shrinkage vs Student-t: audit of concurrex signals

Each signal is classified by whether it's an *estimation* problem (shrinkage) or a *hypothesis test* (Student-t):

| Signal | Role | Mechanism |
|---|---|---|
| $\bar{m}$ (logWBar) | Estimate mean of $\log(W)$ | Shrinkage on level EWMA alpha |
| $\hat{v}$ (trend numerator) | Estimation input to the test | **Asymmetric** shrinkage on input ($v_k \cdot s_k$); δ² sees raw $v_k$ |
| Completion / drop rate EWMAs | Estimate rate parameters | Shrinkage (Gamma-Poisson conjugate) |
| Per-lane error rate (opt-in `LaneErrorShed`, §4.2.8) | Estimate proportion | Shrinkage (Beta-Binomial / Wilson) |
| Early-shed probability | Confidence-weighted shed rate | Shrinkage (credibility scaling) |
| **Trend test (is $\mu_v > 0$?)** | **Hypothesis test** | **Student-t critical value with truncation bound** |

Only one signal in the system is a hypothesis test, and Student-t applies there alone. Bayesian shrinkage applies wherever a *parameter* is estimated — including the trend numerator (asymmetrically: numerator dampened, denominator δ² unshrunk).

#### 4.3.2 Composing Multiple Signals — Joint FPR Bound (Bonferroni)

When a pool has $N$ signals participating in the statistical framework (each individually satisfying FPR $\leq \Phi(-\sigma_D)$ under $H_0$), and the regulator fires whenever *any* signal triggers (OR composition), the joint FPR is upper-bounded by Bonferroni:

$$P(\text{any signal fires} \mid H_0) \leq \sum_{i=1}^{N} \Phi(-\sigma_{D,i}) \leq N \cdot \Phi(-\sigma_D)$$

For independent signals, the exact joint FPR is given by Šidák:

$$P(\text{any signal fires} \mid H_0) = 1 - \prod_{i=1}^{N}\bigl(1 - \Phi(-\sigma_{D,i})\bigr) \leq N \cdot \Phi(-\sigma_D)$$

(Bonferroni is the union bound; Šidák is tighter for independent tests. Both reduce to $\Phi(-\sigma_D)$ at $N=1$.)

**At the framework's default $\sigma_D = 2$**:
- $N=1$ signal: joint FPR $\leq 0.023$
- $N=2$: joint FPR $\leq 0.046$
- $N=3$: joint FPR $\leq 0.069$

If users want a target joint FPR $\leq p^*$ across $N$ statistical signals, they Bonferroni-correct by setting per-signal $\sigma_{D,i} = \Phi^{-1}(1 - p^*/N)$. For target $p^* = 0.023$ with $N=3$: $\sigma_D = 2.42$.

**Caveat — "statistical" vs heuristic signals.** The joint FPR bound applies only to signals that participate in the framework (i.e., compose their hypothesis test using the pool's heartbeat). Heuristic signals (predicate-only, e.g., `MemoryPressure`) fire whenever their condition is met — they have no inherent FPR guarantee and are not included in the Bonferroni count.

**Error response is user-defined.** v1.x had a hardcoded probabilistic-error decrease branch firing with $P = \texttt{errorRateEwma}$. In v2.0 the pool-level error EWMA is removed entirely — what counts as an "error" is domain-specific (HTTP status, business vs infrastructure, retryable vs terminal). To drive *concurrency* from errors, implement a `RegulatorSignal` that observes `info.errored` in `onComplete`. To *shed at admission* on a per-lane basis, register the built-in `LaneErrorShed` admission signal (or write your own `AdmissionSignal`). Both are **opt-in** — errors do not necessarily mean a resource is unhealthy.

**Theorem 7 (Upper-bounded false positive rate).** *Under the following assumptions:*
- *constant $\alpha$ at steady state (or smooth time-varying $\alpha$ as a first-order approximation),*
- *shrinkage weights $s_k$ mean-independent of the noise $v_k$ (an approximation — both derive from $r_k$; see caveats),*
- *CLT normality of $v_k$ (excellent at moderate throughput; mild deviation at very low throughput is partially absorbed by the Student-t's heavier tails),*
- *variance-matching df $\nu = 1/(\kappa c)$ for the δ² estimator (§4.2.7),*
- *critical value from the Fisher–Cornish 4th-order series with truncation bound $2|g_4/\nu^4|$, finite only in its certified domain $\nu \geq 5$ ($+\infty$ below, where the test cannot fire),*

*the Student-t test using $\text{SE}^2 = \hat\sigma_v^2 \cdot \kappa \cdot (1+\kappa)/2$ with $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ and critical value $\text{tScore}(\sigma_D, \nu)$ satisfies*

$$P(\text{false positive} \mid H_0) \leq \Phi(-\sigma_D)$$

*at every $\nu$. At $\sigma_D = 2$: FPR $\leq 0.0228$. Equality is achieved in the limit $\nu \to \infty$.*

*Proof.* Under $H_0$, $E[v] = 0$ and $v_k$ is zero-mean noise. The first difference $v_k - v_{k-1}$ has variance $2\sigma_v^2(1 - \rho_1)$ where $\rho_1 = -\alpha/2$ (from first-differencing an AR(1)-like EWMA). Therefore

$$E[\delta^2] = E\left[\frac{(v_k - v_{k-1})^2}{2}\right] = \sigma_v^2(1 + \alpha/2)$$

*so $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ is unbiased for $\sigma_v^2$. For the EWMA $\hat{v}$ of an autocorrelated process with $\rho_h = -\alpha(1-\alpha)^{h-1}/2$, the variance is*

$$\text{Var}(\hat{v}) = \sigma_v^2 \cdot \kappa \cdot \frac{1 + \kappa}{2}$$

*(autocorrelation reduces the variance below the i.i.d. baseline by factor $(1+\kappa)/2$). Therefore*

$$\text{SE}^2 = \hat\sigma_v^2 \cdot \kappa \cdot \frac{1+\kappa}{2} = \frac{\delta^2 \cdot \kappa \cdot (1+\kappa)}{2 \cdot (1 + \alpha/2)}$$

*so $E[\text{SE}^2] = \text{Var}(\hat{v})$ exactly under constant $\alpha$ (in the single-$\alpha$ model; see caveats). By CLT, $\hat{v}$ is approximately normal; since $\sigma_v^2$ is replaced by an estimate, the studentized ratio $\hat{v}/\text{SE}$ is approximately $t_\nu$ with $\nu = 1/(\kappa c)$, the variance-matching df of the δ² estimator (§4.2.7) — the df the implementation passes to `tScore`. For $\nu \geq 5$, `tScore` returns $t_{1-\Phi(-\sigma_D),\,\nu}$ plus an asymptotic-series truncation bound that is zero in the $\nu \to \infty$ limit and strictly positive otherwise; for $\nu < 5$ it returns $+\infty$ and the test cannot fire. Thresholding at this upper bound yields $P(\text{FP} \mid H_0) \leq \Phi(-\sigma_D)$, with equality only in the $\nu \to \infty$ limit. $\square$

*Caveats (approximations in the proof):*
- *Constant $\alpha$: true only at steady state; smooth time-varying $\alpha$ gives a first-order approximation.*
- *Mixed $\alpha$: the shipped level EWMA uses $\alpha \cdot s_k$ while the trend EWMA, δ², and both correction factors use raw $\alpha$; SE calibration is exact only at $s_k = 1$. The deviation biases SE low against an unshrunk numerator, but the actual (shrunk) numerator has smaller variance still — net conservative (§4.3.1, "Test statistic and SE formula").*
- *Shrinkage–noise independence: $E[v_k s_k] = 0$ requires $s_k \perp v_k$; both derive from $r_k$, which is coupled to $W_k$ through Little's law. The measured impact of the coupling is small and dominated by the shrinkage conservatism (§4.2.5).*
- *CLT for $v_k$: excellent at moderate throughput (≥ 5 completions/window); mild heavy-tail deviation at very low throughput is partially absorbed by the Student-t's heavier tails.*
- *df: variance-matching df for the δ² EWMA under Gaussian fourth moments; exact at constant $\alpha$, first-order under time-varying $\alpha$ (§4.2.7).*
- *$t_{1-p,\,\nu}$ approximation: 4th-order Fisher–Cornish series plus the one-sided truncation bound $2\,|g_4/\nu^4|$, applied only in its certified domain $\nu \geq 5$ (geometric term decay; numerically verified for $\sigma_D \leq 4$). Below $\nu = 5$ the critical value is $+\infty$ and no approximation is invoked. Realized FPR at steady state remains at or below nominal $\Phi(-\sigma_D)$; equality in the limit $\nu \to \infty$.*

**Theorem 8 (Detection power under $H_1$: no saturation).** *Under $H_1$ with constant drift ($E[v] = \mu_v > 0$) and $s_k$ independent of the noise, $\delta^2$ retains its $H_0$ expectation:*

$$E[\delta^2 \mid H_1] = E[\delta^2 \mid H_0] = \sigma_v^2 (1 + \alpha/2)$$

*and the expected test statistic grows without bound as $\mu_v \to \infty$:*

$$E[t] \approx \frac{\bar{s} \cdot \mu_v}{\sqrt{\sigma_v^2 \cdot \kappa \cdot (1+\kappa)/2}}$$

*where $\bar{s} = E[s_k]$ is the steady-state shrinkage. Severe degradation triggers the test at any positive throughput.*

*Proof.* The drift component of $v_k = \mu_v + \epsilon_k$ cancels exactly in lag-1 differences:

$$v_k - v_{k-1} = (\mu_v + \epsilon_k) - (\mu_v + \epsilon_{k-1}) = \epsilon_k - \epsilon_{k-1}$$

*so $\delta^2 = \text{EWMA}((\epsilon_k - \epsilon_{k-1})^2/2)$ — independent of $\mu_v$. Therefore $E[\text{SE}^2 \mid H_1] = E[\text{SE}^2 \mid H_0] = \sigma_v^2 \cdot \kappa \cdot (1+\kappa)/2$, and $E[\hat{v} \mid H_1] = \bar{s} \mu_v$ (the asymmetric shrinkage on the trend numerator, under the independence assumption). The test statistic*

$$t = \frac{\hat{v}}{\text{SE}} = \frac{\bar{s}\mu_v + O(\sigma_v / \sqrt{\nu})}{\sigma_v \cdot \sqrt{\kappa \cdot (1+\kappa)/2}}$$

*grows linearly in $\mu_v$ with no saturation ceiling. This is the **drift invariance** property of von Neumann's δ²: drift cancels in pairwise differences, so the noise floor stays calibrated to the actual noise level under any $\mu_v$. $\square$

*Transient behavior.* Before $\hat{v}$ has absorbed the new $\mu_v$, the test fires once $\hat{v}$ reaches roughly $\sigma_D \cdot \text{SE}$ — typically within $\sim 2/\alpha$ windows after onset (the EWMA time constant). During the onset transient the *curvature* of the level shift also inflates δ² temporarily (correlated successive differences), which delays firing slightly but cannot prevent it — once the drift is established, differences re-collapse to the noise. Detection latency = O(time constant), not O(time constant × magnitude).

**Theorem 9 (Implicit warm-up via the critical value's certified domain).** *The test cannot fire at low effective sample size: `tScore` returns a finite critical value only for $\nu \geq 5$, and the test df $\nu = 1/(\kappa c)$ reaches 5 only after $\approx 1.2H$ windows of effective evidence following pool creation or an idle reset. No separate $n_w \geq H$ elapsed-windows guard is needed, at any configured $\sigma_D$.*

*Proof.* Three independent mechanisms cooperate:*

1. *At pool creation, $\delta^2 = 0$ — `PowerDegraded.testOutputs` returns null on the explicit $\delta^2 = 0$ guard, and `triggered()` returns false.*
2. *Before two observations have been seen, the lag-1 difference cannot be computed and $\delta^2$ remains 0 — gated as in (1).*
3. *After two observations, $\kappa \approx 1$ initially, giving $\nu = 1/(\kappa c) \approx 0.7 < 5$ — `tScore` returns $+\infty$ and the test cannot fire. $\kappa$ decays geometrically toward $\alpha/(2-\alpha) \approx 0.055$; $\nu$ crosses 5 at $\kappa = 1/(5c) \approx 0.14$, about $1.2H$ windows in, after which the critical value is finite and shrinks smoothly toward its steady-state value $\approx 2.22$ at $\nu \approx 12.4$.*

*The warm-up gate is thus the certified domain of the quantile bound — a property of the mathematics, not a counter or clamp in the signal's control flow. Every finite critical value the test ever uses lies in the regime where the truncation bound is valid, so Theorem 7's premise holds unconditionally, at every configured $\sigma_D$. $\square$

### 4.4 Regulation Phases and Step Formula

**Definition (Step formula).** Given regulation depth $d \geq 1$, current concurrency limit $L$, and bisection scale $\beta$ (`stepScale`):

$$f(d) = 1 - e^{-d/H}$$

$$\Delta(d) = \max\!\bigl(1,\; \lceil L \cdot f(d) \cdot \beta \rceil\bigr)$$

The factor $f(d)$ is the EWMA absorption fraction after $d$ steps with time constant $H$. It converges to 1 as $d \to \infty$, so the step converges to $L \cdot \beta$. The bisection scale $\beta$ starts at 1 and halves on each increase→retract→cooling cycle (floored at $1/L$ so the minimum step stays meaningful), allowing the system to converge to within $\pm 1$ of the true equilibrium in $O(\log L)$ oscillation cycles. $\beta$ resets to 1 when entering Restoring (operating point changed) or Decreasing (genuine degradation).

**Severity through persistence:** The formula has no explicit acceleration parameter. Instead, sustained signal → depth keeps incrementing → steps grow naturally. A brief spike triggers 1-2 small steps before cooling or recovery kicks in. A persistent degradation accumulates depth, producing increasingly aggressive correction. This is inherently self-damping: the moment the signal disappears, growth stops and restoring reclaims the excess.

**Definition (Regulation phase).** The regulator operates in one of five phases:

| Phase | Depth behavior | Purpose |
|-------|---------------|---------|
| $\texttt{Idle}$ | $d = 0$ | At baseline, no active regulation |
| $\texttt{Increasing}$ | $d$ increments: $1, 2, \ldots$ | Increase concurrency via convergent slow start |
| $\texttt{Retracting}$ | $d$ decrements: $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ | Walk back a previous increase sequence in reverse |
| $\texttt{Decreasing}$ | $d$ increments: $1, 2, \ldots$ | Fresh decrease ramp after retraction exhausted |
| $\texttt{Restoring}$ | $d$ increments: $1, 2, \ldots$ | Converge back toward baseline from either direction |

#### 4.4.1 Per-Time-Constant Evaluation

Every $H$ windows (when $n_w > 0$ and $n_w \bmod H = 0$), the regulator evaluates five branches in priority order. Warm-up is handled implicitly by the Student-t critical value in branch 1 (Theorem 9) — no separate $n_w \geq H$ guard is needed.

1. **Any signal triggered** → `applyDecrease`. Retract previous increase or start fresh decrease ramp. With the latched default signal (§4.3.1, "The degradation latch"), *triggered* means the pool is **degraded** — not merely that latency is currently worsening — so a walk-back continues exactly as long as the level remains above the pre-excursion reference, and stops early the moment it recovers.
2. **Cooling** ($\Phi \in \{\texttt{Retracting}, \texttt{Decreasing}\}$, no signal triggered) → Reset to $\texttt{Idle}$, $d = 0$, $\beta \leftarrow \max(\beta/2, 1/L)$ (bisection damping). One time constant evaluation pause after a decrease sequence before allowing increases. Acts as natural momentum — prevents immediate flip-flop between decrease and queue-increase. The halved $\beta$ ensures the next increase cycle uses finer steps.
3. **Queue pressure** ($Q > 0$, not in a decrease sequence — $\Phi \in \{\texttt{Idle}, \texttt{Increasing}, \texttt{Restoring}\}$) → `applyIncrease`. Convergent slow start.
4. **Restoring** ($L \neq B$) → Convergent step toward baseline from current position. Uses the same step formula $\Delta(d)$ with incrementing depth. If $L < B$: cautious probe upward (signals can react before overshoot). If $L > B$: shed excess capacity. Phase set to $\texttt{Restoring}$.
5. **Idle** ($L = B$, no queue, no signal triggered) → $d = 0$, $\Phi = \texttt{Idle}$.

#### 4.4.2 Decrease (any signal triggered)

When any of the pool's configured signals fires:

**Case 1: $\Phi = \texttt{Increasing}$ and $d > 0$.** Transition to Retracting. The current depth $d$ becomes the starting point for retraction. Retraction uses the scaled multiplicative inverse $f\beta/(1+f\beta)$ to exactly undo the corresponding increase (which used $f \cdot \beta$):

$$f = 1 - e^{-d/H}, \quad g = f \cdot \beta, \quad \Delta = \max(1, \lceil L \cdot g/(1+g) \rceil), \quad d \leftarrow d - 1, \quad \Phi \leftarrow \texttt{Retracting}$$

**Case 2: $\Phi = \texttt{Retracting}$ and $d > 0$.** Continue retraction with the scaled multiplicative inverse:

$$f = 1 - e^{-d/H}, \quad g = f \cdot \beta, \quad \Delta = \max(1, \lceil L \cdot g/(1+g) \rceil), \quad d \leftarrow d - 1$$

**Case 3: $\Phi = \texttt{Increasing}$ with $d = 0$, or $\Phi = \texttt{Retracting}$ with $d = 0$, or $\Phi = \texttt{Decreasing}$.** No prior increase to retract (or retraction exhausted). Fresh decrease ramp — reset $\beta = 1$ and increment depth:

$$\beta \leftarrow 1, \quad d \leftarrow d + 1, \quad \Delta = \Delta(d), \quad \Phi \leftarrow \texttt{Decreasing}$$

**Apply (operating-concurrency clamp):**

$$L \leftarrow \max\bigl(L_{\min},\; \min(\hat{N}_{\max},\; L - \Delta)\bigr)$$

where $\hat{N}_{\max}$ is the peak in-flight observed this window (`maxInFlight`). Because in-flight $\leq L$ always, $\hat{N}_{\max} = L$ when the limit binds and $\hat{N}_{\max} < L$ when it is slack. When the limit sits on **inert headroom** ($\hat{N}_{\max} \ll L$ — a baseline configured far above the operating concurrency, or a limit not yet reduced into the binding region), the bisection step $L - \Delta$ would still land inside dead space, and the walk-back would spend $O(\log(L/\hat{N}_{\max}))$ evaluations descending headroom before the limit begins to bite. The clamp **snaps** $L$ to $\hat{N}_{\max}$ in one move instead.

**Properties of the snap.**

- **It cuts no live concurrency.** In-flight $\leq \hat{N}_{\max}$ by definition, so setting $L = \hat{N}_{\max}$ removes only slack the demand was not using — no running task is throttled, and the plant sees no change at the instant of the snap. A large snap happens *only* when $\hat{N}_{\max} \ll L$, i.e. when the workload is demand-limited (the peak *is* the demand).
- **Decrease path only.** The clamp lives in `applyDecrease`; growth and restoring never clamp. Headroom is burst-absorption insurance — a demand spike is admitted immediately into slack rather than queued — so it is kept absent evidence of harm and reclaimed only when a signal fires — the design's standing asymmetry (quick to grant capacity, slow to reclaim it, and only on evidence; cf. the downward-only reference of §4.3.1).
- **Not a bisection step.** The jump is a re-anchoring, not a convergent step, so the bisection bookkeeping is reset ($\beta \leftarrow 1$, $d \leftarrow 0$, $\Phi \leftarrow \texttt{Decreasing}$) and the next evaluation begins a fresh decrease from the binding point.

**Origin re-anchor (signal side).** The snap creates a subtlety for the elasticity test (§4.3.1's latch), which measures the dose $\Delta\ell = \log L - \log L_0$ from the crossing origin $L_0$. If the crossing happened while slack ($L_0$ far above the operating concurrency), that $\Delta\ell$ is *fictional* — the limit moved but in-flight did not. The signal detects the resulting slack→binding transition ($L \leq \hat{N}_{\max}$ for the first time after arming), resets its lagged $\log L$ filter to the now-binding limit, and re-anchors all three origins there — so $\Delta\ell$ subsequently measures the *real* dose from where the actuator can act. Crucially the concurrency variable stays the **raw limit** $L$, never in-flight: by Little's law $\bar N \equiv X\overline{W}$, so if the dose were measured on in-flight the binding-premise check $\Delta x = \Delta\ell - \Delta w$ would become a vacuous identity — the check has teeth *only* because $\log L$ diverges from $\log\bar N$ precisely when the limit is slack, which is the signal it reads.

**Standard apply (no clamp, when $\hat{N}_{\max} \geq L - \Delta$):**

$$L \leftarrow \max(L_{\min},\; L - \Delta)$$

#### 4.4.3 Increase (convergent slow start)

When $Q > 0$, no signal fired, and $\Phi \in \{\texttt{Idle}, \texttt{Increasing}, \texttt{Restoring}\}$:

**Phase transition.** If $\Phi \neq \texttt{Increasing}$ and $\Phi \neq \texttt{Restoring}$, reset and start cautious growth:

$$d \leftarrow 0, \quad \Phi \leftarrow \texttt{Increasing}$$

Unlike the decrease case, there is no retraction here. The previous decrease was correcting real latency degradation — undoing it would re-add capacity that caused the problem.

**Apply convergent step (scaled by $\beta$):**

$$d \leftarrow d + 1, \quad \Delta = \max(1, \lceil L \cdot f(d) \cdot \beta \rceil)$$

$$L \leftarrow \min(L_{\max},\; L + \Delta)$$

**Convergent slow start progression.** The factor $1 - e^{-d/H}$ converges to 1, so the step converges to $L$:

| Depth $d$ | Factor $1 - e^{-d/9}$ | Step ($L = 10$) | New $L$ |
|-----------|------------------------|-----------------|---------|
| 1 | 0.105 | 2 | 12 |
| 2 | 0.199 | 3 | 15 |
| 3 | 0.283 | 5 | 20 |
| 4 | 0.359 | 8 | 28 |
| 5 | 0.427 | 12 | 40 |
| 6 | 0.487 | 20 | 60 |
| 7 | 0.541 | 33 | 93 |
| 8 | 0.588 | 55 | 100 |

At convergence ($d \to \infty$), $\Delta \to L$: each time constant evaluation doubles (or halves) the limit — **true exponential adjustment** directly in the concurrency limit.

#### 4.4.4 Restoring (gravity)

When $Q = 0$, no signal triggered, and $L \neq B$. On phase transition into Restoring (from any other phase), reset $\beta = 1$ and $d = 0$ (operating point has changed; next search starts fresh):

$$\text{if } \Phi \neq \texttt{Restoring}: \quad \beta \leftarrow 1, \quad d \leftarrow 0$$
$$\Phi \leftarrow \texttt{Restoring}, \quad d \leftarrow d + 1$$
$$\Delta = \Delta(d)$$

If $L < B$: $L \leftarrow \min(B, L + \Delta)$

If $L > B$: $L \leftarrow \max(B, L - \Delta)$

Converges gradually toward baseline using the convergent step formula at $\beta = 1$ (no bisection damping — Restoring is returning to a known target, not searching for an unknown equilibrium). Restoring uses convergent steps that start small and grow with depth — no large discontinuous jumps when the limit is far from baseline, while still converging in bounded time.

**Convergence from both directions.** After a decrease sequence pushes $L$ below $B$, restoring cautiously probes upward — the latency signal can react before overshoot occurs. After an increase sequence pushes $L$ above $B$, restoring sheds excess capacity gradually. In both cases, reaching $B$ exactly terminates the phase and transitions to Idle.

#### 4.4.5 Design Rationale — Retraction

When the system was Increasing and latency starts worsening, the most recent increases likely contributed to the problem. Retraction walks back the growth in reverse order: the largest step (most recent, highest depth) is undone first, then progressively smaller steps. This provides a proportional first response — if the growth was aggressive (high depth), the first retraction is large; if the growth was cautious (low depth), the retraction is small. Once retraction is exhausted ($d = 0$), the system transitions to Decreasing with a fresh ramp for further reduction if needed.

**Retraction example.** Suppose the system increased through depths 1–5, then latency worsens. The retraction sequence (with $L$ decreasing each step):

| Retraction step | Depth $d$ | $f/(1+f)$ | Step | Effect |
|----------------|-----------|-----------|------|--------|
| 1st | 5 | 0.299 | $\lceil L \cdot 0.299 \rceil$ | Undo depth 5 |
| 2nd | 4 | 0.264 | $\lceil L \cdot 0.264 \rceil$ | Undo depth 4 |
| 3rd | 3 | 0.221 | $\lceil L \cdot 0.221 \rceil$ | Undo depth 3 |
| 4th | 2 | 0.166 | $\lceil L \cdot 0.166 \rceil$ | Undo depth 2 |
| 5th | 1 | 0.095 | $\lceil L \cdot 0.095 \rceil$ | Undo depth 1 |
| 6th+ | 1, 2, ... | fresh ramp | increasing | Fresh decrease |

Note: the table shows factors at $\beta = 1$ (first oscillation cycle). The retraction steps use the scaled multiplicative inverse $f\beta/(1+f\beta)$, which exactly undoes the corresponding increase step (which used $f \cdot \beta$). If increase multiplied $L$ by $(1+f\beta)$, retraction divides by $(1+f\beta)$. Ceiling rounding introduces at most $\pm 1$ per step, so a full retraction returns $L$ to a tight neighborhood of its original value. After cooling, $\beta$ is halved — the next increase cycle uses finer steps (bisection convergence).

### 4.5 Key Properties

1. **Single formula.** Both increase and decrease use $\Delta(d) = \max(1, \lceil L \cdot f(d) \cdot \beta \rceil)$ where $f(d) = 1 - e^{-d/H}$. The system has no inherent bias toward growth or shrinkage — the direction is determined solely by the regulator signals and the regulation phase. Severity is encoded through persistence: sustained signal → depth keeps incrementing → steps grow naturally.

2. **Self-scaling.** The step is proportional to the *current* limit $L$, not a lagging EWMA. A pool at $L = 50$ takes steps of $\sim 32$ at convergence; a pool at $L = 10$ takes steps of $\sim 6$.

3. **Bounded by limit.** $\Delta \leq L$ always (Theorem 10 below) — the limit never more than doubles or halves in a single evaluation.

4. **Sensor-actuator lockstep.** The convergence rate $1/H$ matches the EWMA sensor's absorption rate. After each time constant evaluation, the dLogWBar sensor has absorbed $\sim 63\%$ of the previous adjustment's effect before the next decision. The actuator never outpaces the sensor.

5. **Asymmetric phase transitions.** Increasing→Retracting: walk back growth in reverse (proportional correction). Retracting/Decreasing→Increasing: no retraction, start cautious growth from depth 0 (the decrease was warranted).

6. **Retraction is the exact inverse of growth — held by the latch.** Retraction uses $f/(1+f)$ — the multiplicative inverse of the increase factor $f$. If increase multiplied $L$ by $(1+f)$, retraction divides by $(1+f)$. The degradation latch keeps the walk-back going while the pool remains above the pre-excursion level and releases it the moment the level recovers — so retraction undoes exactly as much of the run as was harmful: all of it if the whole run was above the knee, only the excess if the knee was crossed mid-run.

7. **Persistence-based severity.** No explicit acceleration parameter. A brief latency spike triggers 1-2 small steps before cooling kicks in. Persistent degradation accumulates depth, producing increasingly aggressive correction. The moment the signal disappears, growth stops and restoring converges gradually toward baseline.

8. **Gradual restoring.** When $L \neq B$ and no other condition applies, restoring uses convergent steps toward baseline from either direction. No snapping — the convergent step formula starts small and grows, allowing the latency signal to detect problems before overshooting baseline.

9. **Bisection convergence.** Each increase→retract→cooling cycle halves $\beta$ (`stepScale`), floored at $1/L$. The next increase cycle uses finer steps: if the first cycle overshot by $\Delta_1$, the second cycle's maximum step is $\Delta_1/2$. After $k$ cycles, the search band is $\Delta_1/2^k$ (until the $1/L$ floor binds), converging to within $\max(1, \cdot)$ of the true equilibrium in $O(\log L)$ cycles. $\beta$ resets to 1 on Restoring (operating point changed) or Decreasing (genuine degradation needs full strength).

### 4.6 Theorems

**Theorem 10 (Convergent step is bounded).** *$\Delta(d) \leq L$ for all $d \geq 1$ and $L \geq 1$.*

*Proof.* $1 - e^{-d/H} \leq 1$ for all $d \geq 0$, with equality only at $d = \infty$. Therefore $L \cdot (1 - e^{-d/H}) \leq L$, so $\lceil L \cdot (1 - e^{-d/H}) \rceil \leq L$. Since $L \geq L_{\min} \geq 1$, the $\max(1, \cdot)$ floor preserves $\Delta \leq L$. Equality ($\Delta = L$) is possible at very high $d$ when the product approaches $L$ from below and ceiling rounds up. $\square$

**Theorem 11 (Exponential adjustment at convergence).** *Under sustained directional pressure, after a one-time ramp phase of $\approx H^2 \cdot CW$ ms, the limit doubles (or halves) every $H \cdot CW$ ms.*

*Proof.* At convergence ($d \gg H$), $1 - e^{-d/H} \to 1$. The behavior depends on the phase:

**Increase:** $\Delta \approx L$, so $L_{k+1} \approx 2L_k$ — true doubling.

**Retraction:** Uses $f/(1+f)$ where $f \to 1$, so $\Delta \approx L/2$, giving $L_{k+1} \approx L_k/2$ — true halving (multiplicative inverse of doubling).

**Fresh decrease:** $\Delta \approx L$, so $L_{k+1} \approx \max(L_{\min}, 0)$ — drives to floor in one step.

Time constant evaluations occur every $H \cdot CW$ ms, and it takes $\sim H$ depths to reach convergence — a one-time ramp of $H \cdot H \cdot CW = H^2 \cdot CW$ wall-clock time. Thereafter each evaluation doubles (or halves) the limit, so the doubling time is $H \cdot CW$ ms.

For $H = 9$ and $CW = 100\text{ms}$: the ramp takes $\sim 8.1\text{s}$; after the ramp, each doubling takes $\sim 900\text{ms}$. $\square$

**Theorem 12 (Retraction mirrors growth in reverse order).** *If the system increased through depths $1, 2, \ldots, d_{\text{peak}}$ in Increasing phase, transitioning to Retracting on latency degradation produces decrease steps at depths $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ — the mirror image of the increase sequence.*

*Proof.* When a regulator signal fires and $\Phi = \texttt{Increasing}$ with $d = d_{\text{peak}} > 0$:

1. The regulator transitions to $\Phi = \texttt{Retracting}$.
2. It computes $\Delta(d_{\text{peak}})$ and applies $L \leftarrow L - \Delta$. Sets $d \leftarrow d_{\text{peak}} - 1$.
3. On the next time constant evaluation (the latch holds `triggered()` while the pool remains degraded — §4.3.1, "The degradation latch"), $\Phi = \texttt{Retracting}$ and $d = d_{\text{peak}} - 1 > 0$. It computes $\Delta(d_{\text{peak}} - 1)$ and sets $d \leftarrow d_{\text{peak}} - 2$.
4. This continues: $\Delta(d_{\text{peak}} - 2), \Delta(d_{\text{peak}} - 3), \ldots$
5. When $d = 1$: computes $\Delta(1)$, sets $d \leftarrow 0$.
6. When $d = 0$: if a signal still fires, transitions to $\Phi = \texttt{Decreasing}$ with $d \leftarrow 1$ (fresh ramp); otherwise cooling.

The decrease depths are exactly $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$, mirroring the increase sequence $1, 2, \ldots, d_{\text{peak}}$ in reverse — provided the pool remains degraded throughout, which the latch guarantees until the level recovers. Recovery mid-walk-back ends retraction early *by design*: the remaining steps were below the knee and harmless. $\square$

**Theorem 13 (Retraction exactly undoes growth, absent a clamp snap).** *If the system increased through depths $1, 2, \ldots, d_{\text{peak}}$ in Increasing phase, a full retraction through depths $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ returns $L$ to its original value, with cumulative error $O(d_{\text{peak}}/L)$ from ceiling rounding (bounded by $\pm 1$ per step) — unless the operating-concurrency clamp (§4.4.2) snaps first, in which case retraction ends at the binding point $\hat{N}_{\max}$ instead. The clamp only fires when the grown capacity is inert headroom (in-flight $< L$), so it supersedes retraction exactly when the growth being unwound was never used; when the growth carried real load ($\hat{N}_{\max} \approx L$) the clamp is inert and the exact-inverse property below holds.*

*Proof.* At each increase step at depth $d$, the actual update is $L_{\text{new}} = L + \max(1, \lceil L \cdot f(d) \cdot \beta \rceil)$ where $f(d) = 1 - e^{-d/H}$. In the continuous limit (no ceiling), this multiplies $L$ by $(1 + f \cdot \beta)$. The retraction step uses the multiplicative inverse $f \cdot \beta / (1 + f \cdot \beta)$, so the continuous-limit factor is $1/(1 + f \cdot \beta)$ — the exact inverse. Each step's ceiling rounding contributes at most $\pm 1$ to the actual change, so a full retraction through $d_{\text{peak}}$ steps differs from the original $L$ by at most $\pm d_{\text{peak}}$. For $L \gg d_{\text{peak}}$, the relative error is $O(d_{\text{peak}}/L)$; for small $L$ (e.g., $L = 2$, $d_{\text{peak}} = 5$), the bound is loose and convergence should be verified empirically. $\square$

**Theorem 14 (Finite convergence to $L_{\min}$ under persistent degradation).** *Starting from any $L_0$, there exists a finite $N$ such that after $N$ consecutive decrease evaluations, $L \leq L_{\min}$.*

*Proof.* Since $\Delta \geq 1$ always (the $\max(1, \cdot)$ floor), $L$ decreases by at least 1 per evaluation. Starting from $L_0$, at most $L_0 - L_{\min}$ evaluations reach $L_{\min}$. In practice, convergence is much faster due to accelerating step sizes. $\square$

**Theorem 15 (Invariant: $L \in [L_{\min}, L_{\max}]$).** *The concurrency limit is always within bounds.*

*Proof.* By exhaustive case analysis: decrease uses $\max(L_{\min}, L - \Delta)$; increase uses $\min(L_{\max}, L + \Delta)$; restoring clamps toward $B$ using $\min(B, L + \Delta)$ or $\max(B, L - \Delta)$ where $B \in [L_{\min}, L_{\max}]$ by registration validation. $\square$

**Theorem 16 (System converges to sustainable concurrency).** *If the backend has a sustainable capacity $C$ at concurrency $L_C$ (and degrades above $L_C$), the system converges to a neighborhood of $L_C$.*

*Proof sketch.* Each overshoot-correction cycle narrows the oscillation band via bisection damping: (1) retraction exactly undoes recent growth (Theorem 13), (2) cooling halves $\beta$, (3) the next increase cycle uses finer steps. After $k$ cycles, the maximum step is $\Delta_1 / 2^k$ where $\Delta_1 = \max(1, \lceil L_C \cdot f(1) \rceil)$. The oscillation amplitude converges geometrically to within $\max(1, \cdot)$ of $L_C$ — bisection provides $O(\log L)$ convergence instead of perpetual oscillation at the minimum step size. $\square$

*Caveat.* The sketch assumes each increase step above $L_C$ produces a *detectable* latency trend within one evaluation period. Under sustained saturation with bisected (small) steps this fails per-step — but the degradation latch (§4.3.1) closes the loophole: the *cumulative* trend of a run is detectable even when its individual steps are not, and once armed the signal holds until the *level* recovers, so the walk-back cannot strand the limit at a degraded plateau and undetected steps cannot accumulate across cycles. Measured in `simulations/benchmark-comparison.ts`: with a trend-only (unlatched) signal, sustained 3× overload ratchets the limit monotonically and recovery never completes; with the latch, the limit holds near the contention knee throughout and restores within one time constant of the overload ending — and in the knee-crossing scenario the walk-back stops at the knee rather than unwinding the whole run.

---

## 5. Independence of Mechanisms

**Theorem 17 (Orthogonality).** *ProDel (the queue engine), admission signals, and the throughput regulator (driven by regulator signals) operate on disjoint state and trigger on different conditions.*

| Property | ProDel | Admission signals | Throughput regulator |
|----------|-------|-------------------|----------------------|
| **Trigger** | Sojourn $\geq \tau$ | any `AdmissionSignal.shouldShed(ctx, lane)` — e.g. `EarlyShed`: `dropping` ∧ $F \geq L$ ∧ $P > \text{rand}()$; `LaneErrorShed`: $\text{rand}() < \hat{p}_\ell$ | any `RegulatorSignal.triggered(ctx)` — e.g. `PowerDegraded` |
| **Action** | Drop head / admit (FIFO or LIFO) | Reject at enqueue (counted as a drop) | Adjust $L$ |
| **State** | `dropping`, `dropCount` | per-signal (stateless `EarlyShed`; `LaneErrorShed`'s per-lane map) | `concurrencyLimit`, `regulationDepth`, `regulationPhase`, `stepScale`; per-signal state |
| **Execution point** | `processQueue()` | `enqueueAndWait()` | `evaluateControlWindow()` |

ProDel never writes to regulator state; the regulator never writes to ProDel state. The orthogonality is of *writes and actuators*, not of reads — the mechanisms share sensors where disclosed: `EarlyShed` conditions on `dropping` and the drop-rate EWMA, and ProDel's admission checks read $L$. Admission signals are queried at enqueue and read a frozen `ctx` (pool metrics + heartbeat) plus their own per-lane state; `EarlyShed` reads `dropping` and the drop/completion-rate EWMAs but the only shared write is `dropsThisWindow` (incremented by the executor when any admission signal sheds). The throughput regulator's input is the OR of the regulator signals' `triggered()`; all of them share the same heartbeat and the single `applyDecrease` actuator — separate triggers, shared actuator. The mechanisms converge independently to the appropriate response.

---

## 6. Summary of Safety Properties

| Property | Guarantee |
|----------|-----------|
| **No premature drops** | ProDel waits $\geq CW$ ms before first drop (Theorem 2) |
| **No fresh drops** | Entries with sojourn $< \tau$ are never dropped (Theorem 1) |
| **Bounded limit** | $L \in [L_{\min}, L_{\max}]$ always (Theorem 15) |
| **FPR upper bound** | $P(\text{FP} \mid H_0) \leq \Phi(-\sigma_D)$ at every $\nu$ (Theorem 7) |
| **No saturation under H₁** | Drift-invariant δ² → test statistic grows linearly with $\mu_v$ (Theorem 8) |
| **No false positives during warm-up** | Critical value is infinite until df ≥ 5 (Theorem 9) |
| **Conservative at low throughput** | Asymmetric shrinkage on trend numerator + Student-t at small df (§4.2.5, §4.3.1) |
| **Arbitrary $W/CW$ ratio** | Operational LL is exact for any finite interval (§4.2.1) |
| **Step bounded** | Each step $\leq L$ (Theorem 10) |
| **Retraction is exact inverse** | Full retraction returns L to original value (Theorem 13) |
| **Finite convergence to floor** | Decrease reaches $L_{\min}$ in $O(L_0)$ steps (Theorem 14) |
| **Self-recovery** | ProDel exits dropping when no lane has stale entries (pool-wide check after all lanes processed) (Theorem 4) |
| **System convergence** | Regulator converges to sustainable $L_C$ via bisection in $O(\log L)$ cycles (Theorem 16) |
| **Early shed is self-regulating** | Shedding dampens its own intensity (Theorem 5b) |
| **No starvation from early shed** | Only fires at capacity; completing tasks re-enable admission (Theorem 5c) |
| **Admission signals are independent** | `LaneErrorShed` (opt-in) and other admission signals reject at enqueue without affecting pool-wide regulation (Theorem 17) |
| **Pluggable regulator decrease** | Any configured `RegulatorSignal.triggered()` drives the convergent decrease actuator; joint FPR is bounded by Bonferroni across statistical signals (Theorem 7, §4.3.2) |

---

## Appendix A. Derivation of the Autocorrelation Structure of $v_k$

This appendix derives the autocorrelation $\rho_h$ used in §4.3.1 and the variance reduction factor $(1+\kappa)/2$ in the SE formula.

**Setup.** Let $x_k$ be i.i.d. zero-mean noise with variance $\sigma_x^2$ (the per-window log-W observations under $H_0$). The level EWMA is

$$\bar{m}_k = (1-\alpha)\bar{m}_{k-1} + \alpha x_k$$

The trend signal is the first difference

$$v_k = \bar{m}_k - \bar{m}_{k-1} = \alpha(x_k - \bar{m}_{k-1})$$

(The dt-normalization in §4.2.4 is suppressed here; it doesn't affect autocorrelation structure.)

**A.1 Variance of $v_k$ at steady state.**

$$\text{Var}(v_k) = \alpha^2\,\text{Var}(x_k - \bar{m}_{k-1}) = \alpha^2[\sigma_x^2 + \sigma_x^2 \kappa] = \alpha^2 \sigma_x^2 (1 + \kappa)$$

(using $\text{Var}(\bar{m}) = \sigma_x^2 \kappa$ and independence of $x_k$ from past $\bar{m}$). With $\kappa = \alpha/(2-\alpha)$ at steady state, this simplifies to $2\alpha^2\sigma_x^2/(2-\alpha)$.

**A.2 Lag-1 autocorrelation $\rho_1 = -\alpha/2$.**

$$\text{Cov}(v_k, v_{k-1}) = \alpha^2\,\text{Cov}(x_k - \bar{m}_{k-1}, x_{k-1} - \bar{m}_{k-2})$$

Expanding the covariance using independence of $x$ from past $\bar{m}$:

$$= \alpha^2[0 - 0 - \alpha\sigma_x^2 + (1-\alpha)\sigma_x^2 \kappa]$$

(The $-\alpha\sigma_x^2$ term comes from $\text{Cov}(\bar{m}_{k-1}, x_{k-1}) = \alpha\sigma_x^2$ since $\bar{m}_{k-1} = \alpha x_{k-1} + (1-\alpha)\bar{m}_{k-2}$. The $(1-\alpha)\sigma_x^2 \kappa$ comes from $\text{Cov}(\bar{m}_{k-1}, \bar{m}_{k-2}) = (1-\alpha)\text{Var}(\bar{m})$.)

Substituting $\kappa = \alpha/(2-\alpha)$ and simplifying:

$$\text{Cov}(v_k, v_{k-1}) = \alpha^2 \sigma_x^2 \cdot \frac{(1-\alpha)\alpha - \alpha(2-\alpha)}{2-\alpha} = -\frac{\alpha^3 \sigma_x^2}{2-\alpha}$$

Therefore

$$\rho_1 = \frac{\text{Cov}(v_k, v_{k-1})}{\text{Var}(v_k)} = \frac{-\alpha^3/(2-\alpha)}{2\alpha^2/(2-\alpha)} = -\frac{\alpha}{2}$$

**A.3 Lag-h generalization $\rho_h = -\alpha(1-\alpha)^{h-1}/2$.**

By the same expansion at lag $h$, the EWMA's geometric decay propagates: $\bar{m}_{k-1}$'s correlation with $\bar{m}_{k-h-1}$ is $(1-\alpha)^{h-1}$ times its lag-1 correlation. The result $\rho_h = -\alpha(1-\alpha)^{h-1}/2$ follows.

**A.4 Variance reduction factor $(1+\kappa)/2$.**

The variance of an EWMA over an autocorrelated sequence is

$$\text{Var}(\hat{v}) = \sigma_v^2\left[\sum_j w_j^2 + 2\sum_{h\geq 1}\rho_h \sum_j w_j w_{j+h}\right]$$

For EWMA weights $w_j = \alpha(1-\alpha)^j$ at steady state:

$$\sum_j w_j^2 = \kappa = \frac{\alpha}{2-\alpha}, \qquad \sum_j w_j w_{j+h} = \frac{\alpha(1-\alpha)^h}{2-\alpha}$$

Substituting $\rho_h$ from A.3:

$$2\sum_{h\geq 1} \rho_h \cdot \frac{\alpha(1-\alpha)^h}{2-\alpha} = -\frac{\alpha^2}{2-\alpha} \sum_{h\geq 1}(1-\alpha)^{2h-1} = -\frac{\alpha(1-\alpha)}{(2-\alpha)^2}$$

Combining:

$$\text{Var}(\hat{v}) = \sigma_v^2\left[\frac{\alpha}{2-\alpha} - \frac{\alpha(1-\alpha)}{(2-\alpha)^2}\right] = \frac{\sigma_v^2 \cdot \alpha}{(2-\alpha)^2}$$

Converting via $\kappa = \alpha/(2-\alpha)$, so $\alpha = 2\kappa/(1+\kappa)$ and $2-\alpha = 2/(1+\kappa)$:

$$\frac{\alpha}{(2-\alpha)^2} = \frac{2\kappa/(1+\kappa)}{4/(1+\kappa)^2} = \frac{\kappa(1+\kappa)}{2}$$

Therefore

$$\text{Var}(\hat{v}) = \sigma_v^2 \cdot \kappa \cdot \frac{1+\kappa}{2}$$

This is the autocorrelation-corrected variance used in §4.3.1's SE formula.

**A.5 δ²'s bias under autocorrelation.**

$$E[\delta^2] = E\left[\frac{(v_k - v_{k-1})^2}{2}\right] = \frac{2\sigma_v^2 - 2\text{Cov}(v_k, v_{k-1})}{2} = \sigma_v^2(1 - \rho_1) = \sigma_v^2(1 + \alpha/2)$$

So $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ is unbiased for $\sigma_v^2$ under both $H_0$ and $H_1$ (drift cancels in pairwise differences — see Theorem 8).

## Appendix B. Reproducibility of the v1.2.0 Empirical Bench

The bench numbers cited in `.changeset/statistical-rigor.md` and §4.2.6 were produced by:

```
npx tsx simulations/simulation-live.ts
```

This runs an HTTP backend on `localhost:9877` and exercises 10 workload scenarios against the executor (steady state, burst absorption, latency step change, demand spike, full overload, gradual ramp, backend backpressure, error scenarios). Output is `simulations/simulation-live.json` and `.html` (gitignored — re-generated each run).

Run-to-run variance is significant (~5pp on healthy-state FPR per scenario) due to OS scheduling, GC, and HTTP queueing on localhost. The cited numbers are representative single runs; for definitive comparisons, average 5–10 runs.
