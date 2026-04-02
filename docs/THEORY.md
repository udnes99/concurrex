# Executor: Formal Analysis

A formal treatment of the mechanisms in the Executor: **ProDel** (Probabilistic Delay Load-shedding — queue management), **probabilistic early shedding**, and the **throughput regulator** (concurrency regulation). ProDel is a sojourn-based active queue management algorithm where drop probability is proportional to entry staleness. All theorem numbers, definitions, and proofs reference the implementation in `Executor.ts`.

> **Interactive plots:** See [`theory-plots.html`](theory-plots.html) for Chart.js visualizations of every curve in this document — compare theory against the [live simulation](../test/simulations/simulation-live.html).

---

## 1. Definitions and System Model

**Pool state.** A pool maintains:

- $L$ — concurrency limit (`concurrencyLimit`), $L \in [L_{\min}, L_{\max}]$
- $F$ — in-flight count (`inFlight`)
- $Q$ — queue length (`queueLength`)
- $W$ — control window duration in ms (`controlWindow`)
- $\tau$ — delay threshold in ms (`delayThreshold`)
- $B$ — baseline concurrency (`baselineConcurrency`)

**Task lifecycle.** A task is enqueued at time $t_e$, admitted at time $t_a$ (sojourn $= t_a - t_e$), and completes at time $t_c$. On admission $F \leftarrow F+1, Q \leftarrow Q-1$. On completion $F \leftarrow F-1$.

**Throughput monitor state.** Per window:

- $r_k$ — completions in window $k$
- $\hat\mu_k$ — EWMA of completion rate (`completionRateEwma`)
- $d_k$ — drops in window $k$
- $\hat\delta_k$ — EWMA of drop rate (`dropRateEwma`)
- $n_w$ — total elapsed windows (`elapsedWindows`)

**WoLF-EWMA state (latency detection).** Per window:

- $\hat{L}_k$ — EWMA of in-flight count (`inFlightEwma`)
- $\bar{m}_k$ — WoLF-filtered $\log(W)$ level (`logWBar`)
- $P_k$ — Kalman state uncertainty (`logWBarP`)
- $\widehat{\text{d}\bar{m}}_k$ — EWMA of $\text{d}\bar{m} = \bar{m}_k - \bar{m}_{k-1}$ (`dLogWBarEwma`)
- $\hat\sigma^2_{\text{d}\bar{m},k}$ — Welford variance of $\text{d}\bar{m}$ (`dLogWBarVariance`)

**Error tracking state.** Per window:

- $e_k$ — errors in window $k$ (`errorsThisWindow`)
- $\hat{E}_k$ — EWMA of error ratio $e_k / r_k$ (`errorRateEwma`) — used for probabilistic error decrease

**Per-lane state:**

- $\hat{p}_\ell$ — per-lane error rate EWMA (`errorRateEwma`)
- $t_\ell$ — timestamp of last completion (`lastCompletionTime`)
- $c_\ell$ — cumulative completions (`completions`) — used as observation count for Bayesian shrinkage scaling

**Throughput Regulator state:**

- $\alpha$ — last computed EWMA smoothing factor (`alpha`)
- $d$ — current regulation depth (`regulationDepth`)
- $\Phi$ — regulation phase: $\texttt{Idle}$, $\texttt{Increasing}$, $\texttt{Retracting}$, $\texttt{Decreasing}$, or $\texttt{Restoring}$ (`regulationPhase`)
- $s$ — bisection damping scale (`stepScale`), initially 1. Halved on each increase→retract→cooling cycle. Reset to 1 on Restoring or Decreasing.

**Constants:**

- $\sigma_D$ — `zScoreThreshold` (default: 2, configurable globally and per-pool). Number of standard errors for significance. The single tunable constant from which all other statistical parameters are derived.
- $Z^2 = \sigma_D^2$ — `z2`. The Bayesian prior strength in pseudo-observations. Also the IMQ soft threshold ($c^2$) for WoLF outlier downweighting in log-space. At $\sigma_D = 2$: $Z^2 = 4$.
- $H = \text{round}(2 / (1 - e^{-1/\sigma_D^2}))$ — `halfLife`. EWMA half-life in control windows: decay constant, warm-up threshold, and evaluation cadence. At $\sigma_D = 2$: $H = 9$.

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
| Any | $s < \tau$ | FIFO admit (head); $t_f \leftarrow \bot$ | IDLE |
| IDLE | $s \geq \tau$ | $t_f \leftarrow t + W$; FIFO admit (head) | GRACE |
| GRACE | $s \geq \tau \land t < t_f$ | FIFO admit (head) | GRACE |
| GRACE | $s \geq \tau \land t \geq t_f$ | $n_d \leftarrow 0; t_d \leftarrow t$ | DROPPING |
| DROPPING | $t < t_d$ | LIFO admit (tail) if $F < L$ | DROPPING |
| DROPPING | $t \geq t_d$ | Drop round: iterate all stale entries (§2.3) | DROPPING |
| DROPPING | $s < \tau \land F < L$ | Admit; exit to IDLE | IDLE |

### 2.3 Sojourn-Proportional Probabilistic Drop

In DROPPING state, drop evaluation occurs in **rounds** gated by a $1/\sqrt{n_d}$ schedule (where $n_d$ = cumulative drops since entering DROPPING). Each round iterates ALL stale entries in each lane from head (oldest, highest P) toward tail. Each entry gets one probabilistic check per round with drop probability:

$$P(s) = 1 - \frac{\tau}{s}, \quad s \geq \tau$$

where $s$ is the entry's sojourn time and $\tau$ is the delay threshold. The iteration stops at the first fresh entry ($s < \tau$) — all remaining entries are fresher.

**Schedule:** After a round completes, the next round fires at $t + W / \sqrt{\max(1, n_d)}$. The first round fires immediately on entering DROPPING ($t_d = t$). More drops → shorter interval → faster next round. Between rounds, `processQueue` fires on every task completion but only performs LIFO admission — no stale entry iteration, keeping overhead minimal.

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

**Theorem 2 (Grace period guarantee).** *No drops occur within $W$ ms of the first observed overload.*

*Proof.* On first observation of $s \geq \tau$ in IDLE, we set $t_f = t + W$ and transition to GRACE. In GRACE, entries are admitted while $t < t_f$. DROPPING is only entered when $t \geq t_f = t_{\text{first}} + W$. Probabilistic drops only occur in DROPPING state. Therefore the minimum time between first overload observation and first possible drop is $W$. $\square$

**Theorem 3 (Drop rate increases with staleness).** *In DROPPING state, the expected number of entries dropped per round increases as entries age.*

*Proof.* For a queue of $n$ entries with sojourns $s_1 \geq s_2 \geq \ldots \geq s_n$ (head is oldest), the expected drops per round is $\sum_{i: s_i > \tau} (1 - \tau/s_i)$. As entries age (sojourns increase between rounds), each $P(s_i)$ increases monotonically. Additionally, the $1/\sqrt{n_d}$ schedule fires faster as cumulative drops grow. Both mechanisms reinforce: older entries → higher P per entry AND shorter intervals between rounds. $\square$

**Theorem 4 (Pool-wide self-recovery).** *ProDel exits DROPPING when no lane has stale entries.*

*Proof.* During the traversal loop, a `staleLanes` counter increments for each lane with a stale head ($s \geq \tau$). After the loop, if `staleLanes === 0`, then `dropping = false` and `firstAboveTime = null`, resetting to IDLE. Additionally, if $Q = 0$ (queue fully drained), recovery is implied. Recovery requires ALL lanes to be healthy — a fresh head in one lane does not reset dropping while other lanes remain stale. $\square$

---

## 3. Probabilistic Early Shedding

### 3.1 Mechanism

When ProDel is in dropping state and the pool is at capacity ($F \geq L$), new arrivals are likely doomed to queue, age past the sojourn threshold, and be dropped. Probabilistic early shedding rejects them **at enqueue time** with probability:

$$P = \frac{\hat\delta}{\hat\delta + \hat\mu} \times \text{shrinkage}(\hat\mu)$$

where $\hat\delta$ is the EWMA drop rate, $\hat\mu$ is the EWMA completion rate, and $\text{shrinkage}(\hat\mu) = \hat\mu / (\hat\mu + Z^2)$ dampens the probability at low throughput where the rate EWMAs are based on few observations.

**Conditions for early shed (all must hold):**
1. Pool is in dropping state (`dropping = true`)
2. Pool is at capacity ($F \geq L$)
3. Drop rate EWMA is positive ($\hat\delta > 0$)
4. Completion rate EWMA is positive ($\hat\mu > 0$)

### 3.2 Properties of the Probability Function

**Theorem 5a (Bounded probability).** *$P \in (0, 1)$ when conditions hold.*

*Proof.* When $\hat\delta > 0$ and $\hat\mu > 0$: $\hat\delta / (\hat\delta + \hat\mu) \in (0, 1)$ and $\text{shrinkage}(\hat\mu) = \hat\mu/(\hat\mu + Z^2) \in (0, 1)$. The product of two values in $(0, 1)$ is in $(0, 1)$. $\square$

**Theorem 5b (Self-regulating).** *Early shedding dampens its own intensity.*

*Proof.* Early-shed entries increment `dropsThisWindow`, which increases $\hat\delta$. However, early shedding prevents entries from entering the queue, which:
1. Reduces queue depth → fewer entries for ProDel to drop → $\hat\delta$ falls
2. Reduces competition for slots → more successful admissions → $\hat\mu$ rises
3. Both effects reduce $P$

The equilibrium: $P$ stabilizes at the value where the combined early-shed + ProDel rate matches the excess arrival rate beyond capacity. $\square$

**Theorem 5c (No starvation).** *Early shedding cannot starve the pool of work.*

*Proof.* Early shedding only fires when $F \geq L$ (at capacity). The pool already has $L$ tasks executing. Shed entries would have queued and waited for a slot — shedding them frees queue space without reducing in-flight work. When tasks complete ($F < L$), the at-capacity condition fails and early shedding stops, allowing new entries to be admitted. $\square$

**Semantic interpretation:** $P = \hat\delta / (\hat\delta + \hat\mu)$ is the fraction of total throughput (drops + completions) that ends up dropped. When drops equal completions ($P = 0.5$), half of new arrivals are rejected immediately. When drops dominate ($P \to 1$), almost all are rejected. When completions dominate ($P \to 0$), almost none are rejected.

### 3.3 Interaction with ProDel

Early shedding and ProDel are complementary:

| Mechanism | When it fires | Latency of 503 | Queue effect |
|-----------|--------------|-----------------|--------------|
| **Early shed** | At enqueue, probabilistic | ~0ms (instant) | Prevents entry from joining queue |
| **ProDel** | In processQueue, probabilistic | sojourn time (≥ τ) | Removes stale entries from queue |

Early shed handles the **flow rate** (preventing queue growth); ProDel handles the **stock** (draining entries already queued). Together they produce instant 503s for most rejected requests while ProDel's sojourn-proportional probability manages the residual queue.

---

## 4. Throughput Regulator

### 4.1 EWMA with Time-Weighted Smoothing

**Definition.** The smoothing factor for window $k$ with actual elapsed time $\Delta t_k$ is:

$$\alpha_k = 1 - \exp\!\left(\frac{-\Delta t_k}{H \cdot W}\right)$$

where $H = \text{round}(2 / (1 - e^{-1/\sigma_D^2}))$ is the EWMA half-life and $\sigma_D = 2$ (zScoreThreshold).

For $\sigma_D = 2$: $H = \text{round}(2/(1-e^{-1/4})) = \text{round}(2/0.2212) = 9$.

For an on-time window ($\Delta t_k = W$):

$$\alpha = 1 - e^{-1/9} \approx 0.1052$$

**Motivation for time-weighting.** If a window runs long (e.g., under low throughput, $\Delta t_k = 3W$), the older EWMA is staler. An exponential decay model gives:

$$\text{weight of old data} = e^{-\Delta t / (H \cdot W)}$$

so $\alpha_k = 1 - e^{-\Delta t_k/(H \cdot W)}$ is the complement — the fraction of trust placed on the new observation. This is the continuous-time equivalent of discrete EWMA with parameter $\lambda = e^{-1/H}$.

**Lemma 1 (Alpha bounds).** $\alpha_k \in (0, 1)$ for all $\Delta t_k > 0$.

*Proof.* $\exp(-x) \in (0,1)$ for $x > 0$. Thus $1 - \exp(-\Delta t_k / (H \cdot W)) \in (0,1)$. $\square$

### 4.1.1 Bayesian Shrinkage

All EWMA updates for rate and ratio signals use a shrinkage-scaled alpha:

$$\alpha_{\text{eff}} = \alpha_k \times \text{shrinkage}(n) = \alpha_k \times \frac{n}{n + Z^2}$$

where $n$ is the observation count backing the current window's measurement, and $Z^2 = \sigma_D^2 = 4$.

**Interpretation.** The shrinkage factor $n/(n+Z^2)$ is the optimal Bayesian weight for combining a prior of $Z^2$ pseudo-observations with $n$ new observations. When $n$ is small, the prior dominates and the EWMA update is dampened. When $n$ is large, the observation dominates and the EWMA tracks the signal closely.

**Connection to Wilson score interval.** The Wilson interval's denominator is $n + z^2$ — the same expression. The shrinkage factor is the fraction of the Wilson denominator attributable to data (vs. prior).

**Representative values:**

| $n$ | $\text{shrinkage}(n)$ |
|-----|----------------------|
| 1 | 0.20 |
| 4 | 0.50 |
| 10 | 0.71 |
| 50 | 0.93 |
| 100 | 0.96 |

**Where applied:** completion rate, drop rate, error rate, WoLF Kalman gain, dLogWBar trend, and early shedding probability. The relevant $n$ differs per signal:

| Signal | $n$ |
|--------|-----|
| Completion rate, drop rate, error rate | `completionsThisWindow` |
| WoLF Kalman gain | via $R_\text{effective} = R / (w \times \text{shrinkage})$ — power-likelihood weighting; fewer completions → higher noise → lower gain |
| dLogWBar trend | `completionsThisWindow` (shrinkage-scaled alpha on trend EWMA) |
| Early shedding | `completionRateEwma` (smoothed throughput) |
| Per-lane error rate | $c_\ell$ (lane's cumulative completions) |

### 4.2 EWMA Update Equations

Given completion count $r_k$ and drop count $d_k$ for window $k$, and $\alpha_c = \alpha_k \times n_k / (n_k + Z^2)$ where $n_k = r_k$ (Bayesian shrinkage-scaled alpha):

**Completion rate update:**

$$\delta_k = r_k - \hat\mu_{k-1}$$
$$\hat\mu_k = \hat\mu_{k-1} + \alpha_c \delta_k$$

**Drop rate update:**

$$\hat\delta_k = \hat\delta_{k-1} + \alpha_c (d_k - \hat\delta_{k-1})$$

**In-flight EWMA update:**

$$\hat{L}_k = \hat{L}_{k-1} + \alpha_k (F_k - \hat{L}_{k-1})$$

**Operational Little's Law latency (Kim & Whitt, 2013):**

$$W_k = \frac{\int_0^{\Delta t_k} N(t)\,dt}{r_k} \quad (\text{when } r_k > 0)$$

where $\int N(t)\,dt$ is the accumulated in-flight-milliseconds (`inFlightMs`) over the window and $r_k$ is completions. This is the exact finite-interval operational Little's Law — no approximation. The integral is updated on every in-flight change (admission and completion), so it captures the true area under the in-flight curve.

**WoLF-EWMA on $\log(W)$:**

The WoLF (Weighted-Observation Likelihood Filter) robustly smooths $\log(W)$ using IMQ-weighted Kalman updates. Outlier observations (error spikes that inflate $W$) are automatically downweighted. The z-test on $\text{d}\bar{m}$ (change in filtered state) detects sustained trends on the already-clean signal. All parameters derive from `zScoreThreshold`.

Instantaneous log-latency per window:

$$m_k = \log(W_k) = \log\!\left(\frac{\int N(t)\,dt}{r_k}\right)$$

WoLF Kalman predict step:

$$\hat{m}_k^- = \bar{m}_{k-1}, \quad P_k^- = P_{k-1} + Q$$

Innovation and IMQ weight ($c^2 = Z^2$):

$$\nu_k = m_k - \hat{m}_k^-, \quad w_k = \frac{1}{\sqrt{1 + \nu_k^2 / Z^2}}$$

Effective measurement noise (power-likelihood weighting + shrinkage):

$$R_{\text{eff},k} = \frac{R}{w_k \times \text{shrinkage}(r_k)}$$

Kalman update:

$$S_k = P_k^- + R_{\text{eff},k}, \quad K_k = \frac{P_k^-}{S_k}$$

$$\bar{m}_k = \hat{m}_k^- + K_k \nu_k, \quad P_k = (1 - K_k) P_k^-$$

**Trend on filtered state (dLogWBar):**

$$\text{d}\bar{m}_k = \bar{m}_k - \bar{m}_{k-1}$$

EWMA of $\text{d}\bar{m}$ with shrinkage-scaled alpha:

$$\alpha_t = \alpha_k \times \text{shrinkage}(r_k)$$
$$\widehat{\text{d}\bar{m}}_k = \widehat{\text{d}\bar{m}}_{k-1} + \alpha_t (\text{d}\bar{m}_k - \widehat{\text{d}\bar{m}}_{k-1})$$

**dLogWBar variance (Welford / Roberts 1959 EWMS):**

$$\hat\sigma^2_{\text{d}\bar{m},k} = (1 - \alpha_t)\bigl(\hat\sigma^2_{\text{d}\bar{m},k-1} + \alpha_t (\text{d}\bar{m}_k - \widehat{\text{d}\bar{m}}_{k-1})^2\bigr)$$

**Why WoLF on log-space?** Error spikes cause a few tasks to complete very slowly (or not at all within the window), inflating $W$ by orders of magnitude. In linear space, a single outlier $W$ contaminates the EWMA and inflates the variance tracker, desensitizing the z-test for many windows. Log-space compresses these spikes, and the IMQ weight further downweights any remaining outliers. The result: the Welford variance on $\text{d}\bar{m}$ stays stable (not contaminated by error-induced latency spikes), and the standard z-test can detect genuine capacity degradation reliably.

**Kalman constants.** $Q$, $R$, and the IMQ threshold $c^2$ are all derived from `zScoreThreshold`:

- Base alpha: $\alpha_0 = 1 - e^{-1/H}$ (same time constant as all other EWMAs)
- $R = Z^2$, $Q = \alpha_0^2 R / (1 - \alpha_0)$ — chosen so steady-state gain $K \to \alpha_0$
- $c^2 = Z^2$ — innovations within $Z$ log-units get full weight; outliers beyond are suppressed

**Error rate (error ratio — errors/completions):**

$$\hat{E}_k = \hat{E}_{k-1} + \alpha_c \bigl(\tfrac{e_k}{r_k} - \hat{E}_{k-1}\bigr)$$

where $\alpha_c = \alpha_k \times r_k / (r_k + Z^2)$ (Bayesian shrinkage-scaled alpha on completions).

**Per-lane error rate (time-weighted with Bayesian shrinkage):**

Each lane's error rate is updated on completion with a time-weighted alpha based on elapsed time since the lane's last completion, scaled by Bayesian shrinkage:

$$\alpha_\ell^{\text{time}} = 1 - \exp\!\left(\frac{-\max(1, t - t_\ell)}{H \cdot W}\right)$$

$$\alpha_\ell = \alpha_\ell^{\text{time}} \times \frac{c_\ell}{c_\ell + Z^2}$$

$$\hat{p}_\ell \leftarrow \hat{p}_\ell + \alpha_\ell \bigl([e] - \hat{p}_\ell\bigr)$$

where $[e] = 1$ if the task errored, $0$ otherwise, and $c_\ell$ is the lane's cumulative completion count. The $\max(1, \cdot)$ ensures rapid completions at the same timestamp still contribute weight. The Bayesian shrinkage factor $c_\ell/(c_\ell + Z^2)$ dampens the update for lanes with few completions — a lane with 1 completion gets only 20% of the full alpha, a lane with 4 completions gets 50%, and a lane with 10 gets 71%, preventing noisy early estimates from causing aggressive per-lane shedding. This uses the same Bayesian framework as all other signals.

**Theorem 6 (Variance steady-state bias).** *For a stationary process with true variance $\sigma^2$ and constant $\alpha$, the steady-state expectation of $\hat\sigma^2$ is:*

$$E[\hat\sigma^2_\infty] = \frac{2(1-\alpha)}{2-\alpha}\sigma^2$$

*Proof.* For a stationary process with $E[\text{d}\bar{m}_k] = 0$, the EWMA is unbiased: $E[\widehat{\text{d}\bar{m}}_\infty] = 0$. The prediction-error variance is:

$$E[(\text{d}\bar{m}_k - \widehat{\text{d}\bar{m}}_{k-1})^2] = \text{Var}(\text{d}\bar{m}_k) + \text{Var}(\widehat{\text{d}\bar{m}}_{k-1})$$

The EWMA variance: $\text{Var}(\widehat{\text{d}\bar{m}}) = \frac{\alpha}{2 - \alpha}\sigma^2$ (standard result for geometric weighted average).

Therefore $E[\delta^2] = \sigma^2(1 + \frac{\alpha}{2-\alpha}) = \sigma^2 \cdot \frac{2}{2-\alpha}$.

At steady state: $\hat\sigma^2_\infty = (1-\alpha)\hat\sigma^2_\infty + \alpha(1-\alpha)E[\delta^2]$

$$\alpha\hat\sigma^2_\infty = \alpha(1-\alpha)\sigma^2 \cdot \frac{2}{2-\alpha}$$

$$\hat\sigma^2_\infty = \frac{2(1-\alpha)}{2-\alpha}\sigma^2$$

For $\alpha = 0.105$: $E[\hat\sigma^2_\infty] \approx 0.945\sigma^2$. The ~5.5% variance underestimate makes the SE $\approx 2.8\%$ smaller, producing a slightly tighter detection threshold than the nominal $\sigma_D = 2$ implies. The effective false-positive rate is marginally above $\Phi(-2) \approx 2.3\%$ — a negligible difference in practice. The code corrects for this by using $2(1-\alpha)$ instead of $(2-\alpha)$ in the SE denominator. $\square$

### 4.3 Detection Thresholds

All detection thresholds use the same framework: $\text{signal} > \sigma_D \times \text{SE}(\text{signal})$, where SE is the standard error of the EWMA derived from its tracked variance. This produces an **adaptive threshold**: stable systems get tight thresholds; noisy systems get loose ones.

#### 4.3.1 Latency Detection (WoLF-EWMA + dLogWBar z-test)

$$\text{SE}(\widehat{\text{d}\bar{m}}) = \sqrt{\frac{\hat\sigma^2_{\text{d}\bar{m}} \cdot \alpha}{2(1 - \alpha) \cdot \text{shrinkage}(n_w / H)}}$$

where $n_w$ is `elapsedWindows` and $H$ is `halfLife`. The shrinkage factor $\text{shrinkage}(n_w/H) = (n_w/H) / (n_w/H + Z^2)$ inflates SE when the Welford variance has few effective observations. The variance converges slower than the EWMA mean (~$H$ half-lives), so early evaluations would otherwise produce artificially tight thresholds. After a few half-lives, shrinkage $\to 1$ and the correction vanishes.

Latency is degrading when $\widehat{\text{d}\bar{m}} > \sigma_D \cdot \text{SE}(\widehat{\text{d}\bar{m}})$.

**Two-stage design.** The detection operates in two stages. First, the WoLF filter cleans the $\log(W)$ signal: outlier observations (caused by error spikes, GC pauses, or transient network hiccups) receive near-zero Kalman gain via the IMQ weight, so they barely move the filtered state $\bar{m}$. Second, the standard z-test on $\text{d}\bar{m}$ detects sustained upward trends in the clean signal.

**Why this works.** Without WoLF, a single error spike inflating $W$ by 10x would inject a large positive $\text{d}W$ into the trend EWMA and inflate the Welford variance for many subsequent windows. The inflated variance desensitizes the z-test, masking genuine capacity degradation that follows. WoLF prevents this: the IMQ weight ($w = 1/\sqrt{1 + \nu^2/Z^2}$) suppresses outlier innovations, so neither the filtered state $\bar{m}$ nor its derivative $\text{d}\bar{m}$ are contaminated. The Welford variance on $\text{d}\bar{m}$ stays tight, and the z-test retains full sensitivity.

**Source-side noise control.** Bayesian shrinkage enters through the Kalman gain, not as a separate alpha correction. At low throughput ($r_k$ small), the shrinkage factor is small, which inflates $R_\text{eff}$ (measurement noise), which reduces $K$ (Kalman gain). The filter trusts the prior state over a noisy observation. At high throughput, $R_\text{eff} \approx R$ and the filter tracks closely. This is mathematically equivalent to source-side dampening but flows through the Kalman equations correctly — $K$ remains the MMSE-optimal gain for the adjusted noise level.

##### 4.3.1.1 Per-lane error rate: Bayesian shrinkage

Per-lane error rate uses Bayesian shrinkage (same as pool-wide signals), scaled by the lane's cumulative completions:

$$\alpha_\ell = \alpha_\ell^{\text{time}} \times \frac{c_\ell}{c_\ell + Z^2}$$

where $c_\ell$ is the lane's cumulative completion count. At 1 completion: 20% weight. At 4 completions: 50% weight. At 10 completions: 71% weight. At 100 completions: 96% weight. This prevents noisy early estimates from causing aggressive per-lane shedding, using the same Bayesian framework as all other signals in the system.

#### 4.3.2 Probabilistic Error Decrease

Pool-wide error detection (error spread significance, dErrorRate z-test) has been removed. Error response is now handled by two independent mechanisms:

1. **Per-lane shedding** (§4.3.1.1): filters localized errors at the lane level. One bad downstream dependency causes its lane's error rate EWMA to rise, shedding requests to that lane without affecting pool-wide concurrency.

2. **Probabilistic error decrease** (§4.4.1, branch 4): when the pool-wide `errorRateEwma` $\hat{E} > 0$ and $\text{rand}() < \hat{E}$, the regulator applies a decrease step. Per-lane shedding keeps the aggregate error rate low for localized failures, so `errorRateEwma` only rises significantly for systemic issues (errors across many lanes). At 2% aggregate errors, the decrease fires on ~2% of halfLife evaluations — barely noticeable. At 80% errors, it fires on most evaluations — aggressive correction. The probability self-scales to match error severity.

**Why this replaces pool-wide error detection.** The previous design used error spread (proportion of lanes with errors) and dErrorRate (trend in error ratio) to detect systemic errors. This required tracking `laneKeysCompletedThisWindow`, `laneKeysErroredThisWindow`, `errorSpreadEwma`, `activeLanesEwma`, `dErrorRateEwma`, and `dErrorRateVariance`. The new design achieves the same goal — decreasing concurrency for systemic errors while ignoring localized ones — with zero additional state. Per-lane shedding naturally filters localized errors, so the aggregate `errorRateEwma` is already a reliable systemic signal.

**Theorem 7 (False positive rate).** *For a stationary process where $\text{d}\bar{m}_k$ is approximately normally distributed:*
- *At high $L$: $P(\text{false positive}) \approx \Phi(-\sigma_D) \approx 0.0228$ per halfLife evaluation.*
- *At low $L$: $P(\text{false positive}) < 0.0228$ due to the WoLF Kalman gain reduction at low throughput (§4.3.1).*

**Theorem 8 (Warm-up guard prevents early false positives).** *No concurrency adjustment occurs for the first $H$ windows after pool creation.*

*Proof.* The halfLife evaluation requires $n_w \geq H$. $n_w$ starts at 0 and increments once per window evaluation. Therefore at least halfLife windows ($\geq H \cdot W$ ms) must pass before the first evaluation. During this period, the dLogWBar EWMA and variance accumulate halfLife data points, providing a reliable baseline. $\square$

### 4.4 Regulation Phases and Step Formula

**Definition (Step formula).** Given regulation depth $d \geq 1$, current concurrency limit $L$, and bisection scale $s$ (`stepScale`):

$$f(d) = 1 - e^{-d/H}$$

$$\Delta(d) = \max\!\bigl(1,\; \lceil L \cdot f(d) \cdot s \rceil\bigr)$$

The factor $f(d)$ is the EWMA absorption fraction after $d$ steps with time constant halfLife. It converges to 1 as $d \to \infty$, so the step converges to $L \cdot s$. The bisection scale $s$ starts at 1 and halves on each increase→retract→cooling cycle, allowing the system to converge to within $\pm 1$ of the true equilibrium in $O(\log L)$ oscillation cycles. $s$ resets to 1 when entering Restoring (operating point changed) or Decreasing (genuine degradation).

**Severity through persistence:** The formula has no explicit acceleration parameter. Instead, sustained signal → depth keeps incrementing → steps grow naturally. A brief spike triggers 1-2 small steps before cooling or recovery kicks in. A persistent degradation accumulates depth, producing increasingly aggressive correction. This is inherently self-damping: the moment the signal disappears, growth stops and restoring reclaims the excess.

**Definition (Regulation phase).** The regulator operates in one of five phases:

| Phase | Depth behavior | Purpose |
|-------|---------------|---------|
| $\texttt{Idle}$ | $d = 0$ | At baseline, no active regulation |
| $\texttt{Increasing}$ | $d$ increments: $1, 2, \ldots$ | Increase concurrency via convergent slow start |
| $\texttt{Retracting}$ | $d$ decrements: $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ | Walk back a previous increase sequence in reverse |
| $\texttt{Decreasing}$ | $d$ increments: $1, 2, \ldots$ | Fresh decrease ramp after retraction exhausted |
| $\texttt{Restoring}$ | $d$ increments: $1, 2, \ldots$ | Converge back toward baseline from either direction |

#### 4.4.1 Per-halfLife Evaluation

Every $H$ windows (when $n_w \geq H$ and $n_w \bmod H = 0$), the regulator evaluates six branches in priority order:

1. **Latency degrading** → `applyDecrease`. Retract previous increase or start fresh decrease ramp.
2. **Cooling** ($\Phi \in \{\texttt{Retracting}, \texttt{Decreasing}\}$, not degrading) → Reset to $\texttt{Idle}$, $d = 0$, $s \leftarrow s/2$ (bisection damping). One halfLife evaluation pause after a decrease sequence before allowing increases. Acts as natural momentum — prevents immediate flip-flop between latency-decrease and queue-increase. The halved $s$ ensures the next increase cycle uses finer steps.
3. **Queue pressure** ($Q > 0$, not in a decrease sequence — $\Phi \in \{\texttt{Idle}, \texttt{Increasing}, \texttt{Restoring}\}$) → `applyIncrease`. Convergent slow start.
4. **Probabilistic error decrease** ($\hat{E} > 0$ and $\text{rand}() < \hat{E}$) → `applyDecrease`. Fires with probability equal to the aggregate error rate. Per-lane shedding keeps the aggregate rate low for localized failures, so this only fires frequently for systemic issues. No momentum — the probabilistic nature provides proportional response without needing a separate hold/gravity gate.
5. **Restoring** ($L \neq B$) → Convergent step toward baseline from current position. Uses the same step formula $\Delta(d)$ with incrementing depth. If $L < B$: cautious probe upward (latency signal can react before overshoot). If $L > B$: shed excess capacity. Phase set to $\texttt{Restoring}$.
6. **Idle** ($L = B$, no queue, no degradation, no errors) → $d = 0$, $\Phi = \texttt{Idle}$.

#### 4.4.2 Decrease (latency degrading or probabilistic error)

When latency is degrading, or when the probabilistic error coin fires:

**Case 1: $\Phi = \texttt{Increasing}$ and $d > 0$.** Transition to Retracting. The current depth $d$ becomes the starting point for retraction. Retraction uses the scaled multiplicative inverse $fs/(1+fs)$ to exactly undo the corresponding increase (which used $f \cdot s$):

$$f = 1 - e^{-d/H}, \quad g = f \cdot s, \quad \Delta = \max(1, \lceil L \cdot g/(1+g) \rceil), \quad d \leftarrow d - 1, \quad \Phi \leftarrow \texttt{Retracting}$$

**Case 2: $\Phi = \texttt{Retracting}$ and $d > 0$.** Continue retraction with the scaled multiplicative inverse:

$$f = 1 - e^{-d/H}, \quad g = f \cdot s, \quad \Delta = \max(1, \lceil L \cdot g/(1+g) \rceil), \quad d \leftarrow d - 1$$

**Case 3: $\Phi = \texttt{Increasing}$ with $d = 0$, or $\Phi = \texttt{Retracting}$ with $d = 0$, or $\Phi = \texttt{Decreasing}$.** No prior increase to retract (or retraction exhausted). Fresh decrease ramp — reset $s = 1$ and increment depth:

$$s \leftarrow 1, \quad d \leftarrow d + 1, \quad \Delta = \Delta(d), \quad \Phi \leftarrow \texttt{Decreasing}$$

**Apply:**

$$L \leftarrow \max(L_{\min},\; L - \Delta)$$

#### 4.4.3 Increase (convergent slow start)

When $Q > 0$ and not degraded, and $\Phi \in \{\texttt{Idle}, \texttt{Increasing}, \texttt{Restoring}\}$:

**Phase transition.** If $\Phi \neq \texttt{Increasing}$ and $\Phi \neq \texttt{Restoring}$, reset and start cautious growth:

$$d \leftarrow 0, \quad \Phi \leftarrow \texttt{Increasing}$$

Unlike the decrease case, there is no retraction here. The previous decrease was correcting real latency degradation — undoing it would re-add capacity that caused the problem.

**Apply convergent step (scaled by $s$):**

$$d \leftarrow d + 1, \quad \Delta = \max(1, \lceil L \cdot f(d) \cdot s \rceil)$$

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

At convergence ($d \to \infty$), $\Delta \to L$: each halfLife evaluation doubles (or halves) the limit — **true exponential adjustment** directly in the concurrency limit.

#### 4.4.4 Restoring (gravity)

When $Q = 0$, not degraded, no probabilistic error decrease, and $L \neq B$. On phase transition into Restoring (from any other phase), reset $s = 1$ and $d = 0$ (operating point has changed; next search starts fresh):

$$\text{if } \Phi \neq \texttt{Restoring}: \quad s \leftarrow 1, \quad d \leftarrow 0$$
$$\Phi \leftarrow \texttt{Restoring}, \quad d \leftarrow d + 1$$
$$\Delta = \Delta(d)$$

If $L < B$: $L \leftarrow \min(B, L + \Delta)$

If $L > B$: $L \leftarrow \max(B, L - \Delta)$

Converges gradually toward baseline using the convergent step formula at $s = 1$ (no bisection damping — Restoring is returning to a known target, not searching for an unknown equilibrium). Unlike the previous snap-to-usage design, restoring uses convergent steps that start small and grow with depth. This prevents large discontinuous jumps when the limit is far from baseline, while still converging in bounded time.

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

Note: the table shows factors at $s = 1$ (first oscillation cycle). The retraction steps use the scaled multiplicative inverse $fs/(1+fs)$, which exactly undoes the corresponding increase step (which used $f \cdot s$). If increase multiplied $L$ by $(1+fs)$, retraction divides by $(1+fs)$. Ceiling rounding introduces at most $\pm 1$ per step, so a full retraction returns $L$ to a tight neighborhood of its original value. After cooling, $s$ is halved — the next increase cycle uses finer steps (bisection convergence).

### 4.5 Key Properties

1. **Single formula.** Both increase and decrease use $\Delta(d) = \max(1, \lceil L \cdot f(d) \cdot s \rceil)$ where $f(d) = 1 - e^{-d/H}$. The system has no inherent bias toward growth or shrinkage — the direction is determined solely by the dLogWBar signal and the regulation phase. Severity is encoded through persistence: sustained signal → depth keeps incrementing → steps grow naturally.

2. **Self-scaling.** The step is proportional to the *current* limit $L$, not a lagging EWMA. A pool at $L = 50$ takes steps of $\sim 32$ at convergence; a pool at $L = 10$ takes steps of $\sim 6$.

3. **Bounded by limit.** $\Delta \leq L$ always (Theorem 9 below) — the limit never more than doubles or halves in a single evaluation.

4. **Sensor-actuator lockstep.** The convergence rate $1/H$ matches the EWMA sensor's absorption rate. After each halfLife evaluation, the dLogWBar sensor has absorbed $\sim 63\%$ of the previous adjustment's effect before the next decision. The actuator never outpaces the sensor.

5. **Asymmetric phase transitions.** Increasing→Retracting: walk back growth in reverse (proportional correction). Retracting/Decreasing→Increasing: no retraction, start cautious growth from depth 0 (the decrease was warranted).

6. **Retraction is the exact inverse of growth.** Retraction uses $f/(1+f)$ — the multiplicative inverse of the increase factor $f$. If increase multiplied $L$ by $(1+f)$, retraction divides by $(1+f)$. A full retraction returns $L$ to its original value (up to ceiling rounding). This eliminates oscillation from overshoot or undershoot.

7. **Persistence-based severity.** No explicit acceleration parameter. A brief latency spike triggers 1-2 small steps before cooling kicks in. Persistent degradation accumulates depth, producing increasingly aggressive correction. The moment the signal disappears, growth stops and restoring converges gradually toward baseline.

8. **Gradual restoring.** When $L \neq B$ and no other condition applies, restoring uses convergent steps toward baseline from either direction. No snapping — the convergent step formula starts small and grows, allowing the latency signal to detect problems before overshooting baseline.

9. **Bisection convergence.** Each increase→retract→cooling cycle halves $s$ (`stepScale`). The next increase cycle uses finer steps: if the first cycle overshot by $\Delta_1$, the second cycle's maximum step is $\Delta_1/2$. After $k$ cycles, the search band is $\Delta_1/2^k$, converging to within $\max(1, \cdot)$ of the true equilibrium in $O(\log L)$ cycles. $s$ resets to 1 on Restoring (operating point changed) or Decreasing (genuine degradation needs full strength).

### 4.6 Theorems

**Theorem 9 (Convergent step is bounded).** *$\Delta(d) \leq L$ for all $d \geq 1$ and $L \geq 1$.*

*Proof.* $1 - e^{-d/H} \leq 1$ for all $d \geq 0$, with equality only at $d = \infty$. Therefore $L \cdot (1 - e^{-d/H}) \leq L$, so $\lceil L \cdot (1 - e^{-d/H}) \rceil \leq L$. Since $L \geq L_{\min} \geq 1$, the $\max(1, \cdot)$ floor preserves $\Delta \leq L$. Equality ($\Delta = L$) is possible at very high $d$ when the product approaches $L$ from below and ceiling rounds up. $\square$

**Theorem 10 (Exponential adjustment at convergence).** *Under sustained directional pressure, the limit grows (or shrinks) exponentially with doubling time $H^2 \cdot W$ ms.*

*Proof.* At convergence ($d \gg H$), $1 - e^{-d/H} \to 1$. The behavior depends on the phase:

**Increase:** $\Delta \approx L$, so $L_{k+1} \approx 2L_k$ — true doubling.

**Retraction:** Uses $f/(1+f)$ where $f \to 1$, so $\Delta \approx L/2$, giving $L_{k+1} \approx L_k/2$ — true halving (multiplicative inverse of doubling).

**Fresh decrease:** $\Delta \approx L$, so $L_{k+1} \approx \max(L_{\min}, 0)$ — drives to floor in one step.

halfLife evaluations occur every $H \cdot W$ ms, and it takes $\sim H$ depths to reach convergence. The ramp phase adds $H \cdot H \cdot W = H^2 \cdot W$ wall-clock time.

For $H = 9$ and $W = 100\text{ms}$: the ramp takes $\sim 8.1\text{s}$. After ramp, each doubling takes $\sim 900\text{ms}$. $\square$

**Theorem 11 (Retraction mirrors growth in reverse order).** *If the system increased through depths $1, 2, \ldots, d_{\text{peak}}$ in Increasing phase, transitioning to Retracting on latency degradation produces decrease steps at depths $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ — the mirror image of the increase sequence.*

*Proof.* When $\widehat{\text{d}\bar{m}} > \theta$ and $\Phi = \texttt{Increasing}$ with $d = d_{\text{peak}} > 0$:

1. The regulator transitions to $\Phi = \texttt{Retracting}$.
2. It computes $\Delta(d_{\text{peak}})$ and applies $L \leftarrow L - \Delta$. Sets $d \leftarrow d_{\text{peak}} - 1$.
3. On the next halfLife evaluation (if still $\widehat{\text{d}\bar{m}} > \theta$), $\Phi = \texttt{Retracting}$ and $d = d_{\text{peak}} - 1 > 0$. It computes $\Delta(d_{\text{peak}} - 1)$ and sets $d \leftarrow d_{\text{peak}} - 2$.
4. This continues: $\Delta(d_{\text{peak}} - 2), \Delta(d_{\text{peak}} - 3), \ldots$
5. When $d = 1$: computes $\Delta(1)$, sets $d \leftarrow 0$.
6. When $d = 0$: transitions to $\Phi = \texttt{Decreasing}$, sets $d \leftarrow 1$, fresh ramp begins.

The decrease depths are exactly $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$, mirroring the increase sequence $1, 2, \ldots, d_{\text{peak}}$ in reverse. $\square$

**Theorem 12 (Retraction exactly undoes growth).** *If the system increased through depths $1, 2, \ldots, d_{\text{peak}}$ in Increasing phase, a full retraction through depths $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ returns $L$ to its original value (up to ceiling rounding effects of at most $\pm 1$ per step).*

*Proof.* At each increase step at depth $d$, the factor is $f(d) = 1 - e^{-d/H}$, and $L$ is multiplied by approximately $(1 + f(d))$. The retraction step at the same depth $d$ uses the multiplicative inverse $f(d)/(1+f(d))$, so $L$ is divided by approximately $(1 + f(d))$. Since each retraction step exactly inverts the corresponding increase step (up to ceiling rounding), the full retraction returns $L$ to a neighborhood of its original value. $\square$

**Theorem 13 (Finite convergence to $L_{\min}$ under persistent degradation).** *Starting from any $L_0$, there exists a finite $N$ such that after $N$ consecutive decrease evaluations, $L \leq L_{\min}$.*

*Proof.* Since $\Delta \geq 1$ always (the $\max(1, \cdot)$ floor), $L$ decreases by at least 1 per evaluation. Starting from $L_0$, at most $L_0 - L_{\min}$ evaluations reach $L_{\min}$. In practice, convergence is much faster due to accelerating step sizes. $\square$

**Theorem 14 (Invariant: $L \in [L_{\min}, L_{\max}]$).** *The concurrency limit is always within bounds.*

*Proof.* By exhaustive case analysis: decrease uses $\max(L_{\min}, L - \Delta)$; increase uses $\min(L_{\max}, L + \Delta)$; restoring clamps toward $B$ using $\min(B, L + \Delta)$ or $\max(B, L - \Delta)$ where $B \in [L_{\min}, L_{\max}]$ by registration validation. $\square$

**Theorem 15 (System converges to sustainable concurrency).** *If the backend has a sustainable capacity $C$ at concurrency $L_C$ (and degrades above $L_C$), the system converges to a neighborhood of $L_C$.*

*Proof sketch.* Each overshoot-correction cycle narrows the oscillation band via bisection damping: (1) retraction exactly undoes recent growth (Theorem 12), (2) cooling halves $s$, (3) the next increase cycle uses finer steps. After $k$ cycles, the maximum step is $\Delta_1 / 2^k$ where $\Delta_1 = \max(1, \lceil L_C \cdot f(1) \rceil)$. The oscillation amplitude converges geometrically to within $\max(1, \cdot)$ of $L_C$. This is strictly tighter than the previous bound of $\Delta(1)$ per cycle — bisection provides $O(\log L)$ convergence instead of perpetual oscillation at the minimum step size. $\square$

---

## 5. Independence of Mechanisms

**Theorem 16 (Orthogonality).** *ProDel, early shedding, and the throughput regulator operate on disjoint state and trigger on different signals.*

| Property | ProDel | Early Shed | Per-Lane Shedding | Throughput Regulator | Probabilistic Error Decrease |
|----------|-------|------------|-------------------|----------------------|------------------------------|
| **Trigger** | Sojourn $\geq \tau$ | `dropping` ∧ $F \geq L$ ∧ $P > \text{rand}()$ | $\text{rand}() < \hat{p}_\ell$ | dLogWBar z-test | $\hat{E} > 0$ ∧ $\text{rand}() < \hat{E}$ |
| **Action** | Drop head / admit (FIFO or LIFO) | Reject at enqueue | Reject at enqueue | Adjust $L$ | Adjust $L$ |
| **State** | `dropping`, `dropCount` | `dropRateEwma` (read-only) | `lane.errorRateEwma` | `concurrencyLimit`, `regulationDepth`, `regulationPhase`, `stepScale` | `errorRateEwma` (read-only) |
| **Execution point** | `processQueue()` | `enqueueAndWait()` | `enqueueAndWait()` | `evaluateControlWindow()` | `evaluateControlWindow()` |

ProDel never writes to regulator state; the regulator never writes to ProDel state. Per-lane shedding operates on lane-local state, independent of pool-wide regulation — it handles localized failures without triggering systemic backoff. Early shedding reads `dropping` (ProDel state) and `dropRateEwma`/`completionRateEwma` (regulator state) but writes only `dropsThisWindow` (shared counter). Probabilistic error decrease reads `errorRateEwma` (shared tracker) but uses the same `applyDecrease` actuator as latency-driven regulation — it is a separate trigger, not a separate mechanism. The mechanisms converge independently to the appropriate response.

---

## 6. Summary of Safety Properties

| Property | Guarantee |
|----------|-----------|
| **No premature drops** | ProDel waits $\geq W$ ms before first drop (Theorem 2) |
| **No fresh drops** | Entries with sojourn $< \tau$ are never dropped (Theorem 1) |
| **No wasted drops** | P = 1 - τ/s ensures staleness is verified for every drop (Theorem 1) |
| **Bounded limit** | $L \in [L_{\min}, L_{\max}]$ always (Theorem 14) |
| **No false positives during warm-up** | Evaluation gated on $n_w \geq H$ (Theorem 8) |
| **Conservative at low concurrency** | WoLF Kalman gain reduced at low throughput via shrinkage-scaled $R_\text{eff}$ (§4.3.1) |
| **Step bounded** | Each step $\leq L$ (Theorem 9) |
| **Retraction mirrors growth** | Decrease walks back growth in reverse order (Theorem 11) |
| **Retraction is exact inverse** | Full retraction returns L to original value (Theorem 12) |
| **Finite convergence to floor** | Decrease reaches $L_{\min}$ in $O(L_0)$ steps (Theorem 13) |
| **Self-recovery** | ProDel exits dropping when no lane has stale entries (pool-wide check after all lanes processed) (Theorem 4) |
| **System convergence** | Regulator converges to sustainable $L_C$ via bisection in $O(\log L)$ cycles (Theorem 15) |
| **Early shed is self-regulating** | Shedding dampens its own intensity (Theorem 5b) |
| **No starvation from early shed** | Only fires at capacity; completing tasks re-enable admission (Theorem 5c) |
| **Adaptive LIFO/FIFO** | FIFO when healthy (fair ordering); LIFO when dropping (protect fresh work) — both among lanes and within lanes (§2.1) |
| **Single convergent formula** | Same step $\Delta(d)$ for Increasing, Retracting, Decreasing, and Restoring |
| **Cautious recovery** | Retracting/Decreasing→Increasing starts fresh from depth 0 |
| **Asymmetric phase transitions** | Only Increasing→decrease triggers retraction; decrease→Increasing does not |
| **Per-lane shedding is independent** | Lane error rate doesn't affect pool-wide regulation (Theorem 16) |
| **Probabilistic error decrease** | Systemic errors cause probabilistic decrease (P = errorRate); per-lane shedding filters localized errors (§4.3.2) |
| **Gradual restoring** | Convergent steps toward baseline from either direction; no discontinuous snaps (§4.4.4) |
| **Bisection convergence** | Each increase→retract→cooling cycle halves stepScale; $O(\log L)$ cycles to equilibrium (§4.5) |
| **One-eval cooling** | After a decrease sequence, one halfLife evaluation pause before allowing increases; stepScale halved (§4.4.1) |
| **WoLF outlier robustness** | IMQ-weighted Kalman suppresses error-spike contamination of latency signal (§4.3.1) |
