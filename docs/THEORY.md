# Executor: Formal Analysis

A formal treatment of the mechanisms in the Executor: **ProDel** (Probabilistic Delay Load-shedding — queue management), **probabilistic early shedding**, and the **throughput regulator** (concurrency regulation). ProDel is a sojourn-based active queue management algorithm where drop probability is proportional to entry staleness. All theorem numbers, definitions, and proofs reference the implementation in `Executor.ts`.

> **Interactive plots:** See [`theory-plots.html`](theory-plots.html) for Chart.js visualizations of every curve in this document — compare theory against the [live simulation](../simulations/simulation-live.html).

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

**EWMA state (latency detection).** Per window:

- $\hat{L}_k$ — EWMA of in-flight count (`inFlightEwma`)
- $\bar{m}_k$ — shrinkage-dampened EWMA of $\log(W)$ (`logWBar`)
- $\hat{v}_k$ — EWMA of shrunk derivative $v_k \cdot s_k$ (`dLogWBarEwma`); asymmetric shrinkage on input
- $\delta^2_k$ — von Neumann's lag-1 squared-difference noise estimator $\text{EWMA}((v_k - v_{k-1})^2 / 2)$ (`dLogWBarVarianceEstimate`); drift-invariant
- $W_k^{(2)}$ — sum of squared EWMA weights (`ewmaSumW2`); encodes effective sample size

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

$$\alpha_k = 1 - \exp\left(\frac{-\Delta t_k}{H \cdot W}\right)$$

where $H = \text{round}(2 / (1 - e^{-1/\sigma_D^2}))$ is the EWMA time constant and $\sigma_D = 2$ (zScoreThreshold).

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

**Where applied:** completion rate, drop rate, error rate, log(W) level EWMA, and early shedding probability. Shrinkage is used for *parameter estimation* only; the trend hypothesis test uses Student-t instead (see §4.3.1.2 for the audit). The relevant $n$ differs per signal:

| Signal | $n$ |
|--------|-----|
| Completion rate, drop rate, error rate | `completionsThisWindow` |
| log(W) level EWMA | `completionsThisWindow` (shrinkage-scaled alpha dampens noisy low-throughput windows) |
| Early shedding | `completionRateEwma` (smoothed throughput) |
| Per-lane error rate | $c_\ell$ (lane's cumulative completions) |

### 4.2 The Latency Detection Pipeline

The latency-trend hypothesis test composes seven layered estimators, each addressing a distinct statistical concern. Stages run in this order every window:

1. **Operational Little's Law**: instantaneous $W_k$ from accumulated in-flight integral (§4.2.1).
2. **Log transform**: $m_k = \log W_k$, robust to multiplicative spikes (§4.2.2).
3. **Level EWMA on $\log W$** with Bayesian-shrinkage-dampened α (§4.2.3).
4. **dLogW** — dt-normalized derivative of the filtered level (§4.2.4).
5. **Trend EWMA** with asymmetric shrinkage on the input (§4.2.5).
6. **MSSD/2 noise estimator** (von Neumann's δ²) — drift-invariant by construction (§4.2.6).
7. **Effective sample size** via exact $W^{(2)} = \sum w_j^2$ recursion (§4.2.7).

The test itself is in §4.3.1: a Student-t z-test using $\hat{v}/\text{SE}$ against a Cornish-Fisher critical value at df = ESS − 1.

#### 4.2.1 Stage 1 — Operational Little's Law

**Definition.** For window $k$ with elapsed time $\Delta t_k$ and completion count $r_k > 0$, the instantaneous mean-residence estimator is

$$W_k = \frac{\int_{0}^{\Delta t_k} N(t)\, dt}{r_k} = \frac{\texttt{inFlightMs}_k}{r_k}$$

The integral $\int N(t)\,dt$ is accumulated in `inFlightMs` and updated on every in-flight change (admission, completion, evaluation): `inFlightMs += inFlight × (now − lastChange)`.

**Why this is correct (Kim & Whitt, 2013).** Operational Little's Law is an *identity*, not a steady-state asymptotic. For any finite interval $[0, T]$:

$$\int_0^T N(t)\,dt = \sum_{i \in \mathcal{I}_T} R_i^{(T)}$$

where $\mathcal{I}_T$ is the set of tasks present in the interval and $R_i^{(T)} = \min(c_i, T) - \max(a_i, 0)$ is task $i$'s residence time *clipped to the interval*. Dividing by completions $r_k = |\{i : c_i \in [0,T]\}|$ gives a sample-average residence time over the window — exact, no approximation, no stationarity assumption.

The estimator is unbiased for the mean residence time $W$ whenever in-rate equals out-rate over the interval. Under transient flow imbalance (more arrivals than completions, or vice versa) the estimator is biased *high* (more in-flight integral, fewer completions to divide by) — but the bias is bounded by the in-flight integral, which is itself bounded by `inFlight × Δt`. The trend test is robust to this transient bias because (a) the bias is non-negative, so it cannot mask real degradation, and (b) §4.2.5's shrinkage dampens single-completion-per-window spikes proportionally to evidence.

**Why this is not just $L/\hat\mu$.** A naïve estimate $W \approx \hat{L} / \hat\mu$ multiplies two EWMAs of different signals — their estimation errors compound. Operational LL produces a single window-level sample with one source of variance ($r_k$ is an integer count, $\int N$ is exact), avoiding compounded errors.

**Robustness to the cap.** When $W \gg W_{\text{controlWindow}}$ (long tasks span multiple windows), most windows have $r_k = 0$ and are skipped via the gate `r_k > 0 ∧ inFlightMs > 0`. When a completion eventually arrives, `inFlightMs` has accumulated the integral *across all those skipped windows*, so $W_k = \text{(multi-window integral)} / r_k$ is still the correct sample-average residence by the same identity. The estimator handles arbitrary $W/W_{\text{cw}}$ ratios without modification.

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

$$v_k = \frac{\bar{m}_k - \bar{m}_{k-1}}{\widetilde{\Delta t}_k}, \quad \widetilde{\Delta t}_k = \frac{\Delta t_k}{W_{\text{cw}}}$$

where $W_{\text{cw}}$ is `controlWindow` and $\widetilde{\Delta t}_k$ is the window-normalized elapsed time (dimensionless, $\approx 1$ per on-time window).

**Why dt-normalize.** A one-time level shift accumulated over $N$ idle windows is *not* a sustained per-window trend. Dividing by $\widetilde{\Delta t}$ converts the level diff to a per-window rate — the same "trend per window" semantics regardless of how long the elapsed gap was.

**Why the filtered level rather than raw $m_k$.** Using $v_k = m_k - m_{k-1}$ would inherit the full per-window noise of $m_k$, which is large at sparse completions. Using $v_k = \Delta \bar{m}_k$ inherits only the *EWMA-smoothed* fluctuations, which scale with $\sqrt{W^{(2)}}$ — the right amount of noise dampening for the test statistic.

#### 4.2.5 Stage 5 — Trend EWMA (asymmetric shrinkage)

$$\hat{v}_k = (1 - \alpha_k)\, \hat{v}_{k-1} + \alpha_k\, (v_k \cdot s_k)$$

The derivative $v_k$ is multiplied by the per-window shrinkage $s_k = r_k/(r_k + Z^2)$ before entering the trend EWMA. The MSSD/2 noise estimator (§4.2.6) sees the *unshrunk* $v_k$. This is **asymmetric**: shrinkage on the numerator, raw signal on the denominator.

**Why asymmetric.** Under $H_0$ ($E[v_k] = 0$), shrinkage on the numerator does not change FPR — multiplying zero-mean noise by $s_k \in [0,1]$ stays zero-mean. Under $H_1$ ($E[v_k] = \mu > 0$), low-throughput windows have small $s_k$, so the trend numerator $E[\hat{v}] = \mu \cdot E[s]$ is dampened — the test is *more conservative* at low throughput, requiring stronger evidence per window before firing. Detection delay grows at low throughput, FPR is preserved.

**Why MSSD/2 is unshrunk.** δ² is a noise-floor estimator, and we want it calibrated to actual noise (so SE is right). Shrinking δ² inputs would underestimate noise at low throughput, producing too-easy fires.

#### 4.2.6 Stage 6 — MSSD/2 Noise Estimator (von Neumann's δ²)

$$\delta^2_k = (1 - \alpha_k)\, \delta^2_{k-1} + \alpha_k \cdot \frac{(v_k - v_{k-1})^2}{2}$$

This is the **mean squared successive difference**, halved — also known as von Neumann's δ². It estimates $\sigma_v^2$ via lag-1 squared differences.

**Why δ² (and why halved).** For a stationary sequence with finite variance and small autocorrelation, $E[(v_k - v_{k-1})^2] = 2\,\text{Var}(v) - 2\,\text{Cov}(v_k, v_{k-1}) = 2\sigma_v^2(1 - \rho_1)$. Dividing by $2$ gives an unbiased estimator of $\sigma_v^2$ when $\rho_1 = 0$, and remains close to unbiased for moderate autocorrelation. The factor $1/2$ is what makes it called "δ²" rather than "MSSD".

**Why it's drift-invariant.** A pure drift component $v_k = \mu + \epsilon_k$ has differences $v_k - v_{k-1} = \epsilon_k - \epsilon_{k-1}$ — the drift $\mu$ cancels exactly. So under $H_1$, δ² still tracks the noise of $\epsilon_k$, not the drift level. This is the **key property** that distinguishes δ² from any centered-variance estimator like Welford's: drift does not inflate the noise floor under $H_1$, so the test statistic $\hat{v}/\text{SE}$ grows linearly with $\mu$ — there is no saturation ceiling. Empirically validated against Welford-B and second-moment alternatives in v1.2.0 benchmarking; see `.changeset/statistical-rigor.md` for the comparative bench results.

**Autocorrelation correction.** Since $v_k$ is the first difference of an AR(1)-like EWMA, it carries known lag-1 negative autocorrelation $\rho_1 = -\alpha/2$. This causes the lag-1 squared difference to *overestimate* $\sigma_v^2$ by factor $(1 + \alpha/2)$:

$$E[\delta^2] = \sigma_v^2 \cdot (1 - \rho_1) = \sigma_v^2 \cdot (1 + \alpha/2)$$

The unbiased $\sigma^2$ estimator divides out this factor:

$$\hat\sigma_v^2 = \frac{\delta^2}{1 + \alpha/2}$$

Under constant $\alpha$ this is exact; under smooth time-varying $\alpha$ it is a first-order approximation, accurate at steady state.

#### 4.2.7 Stage 7 — Effective Sample Size ($W^{(2)}$ recursion)

For an EWMA with time-varying weights $w_j$, the standard $\alpha/(2-\alpha)$ formula does not apply. Instead, $W^{(2)} = \sum_j w_j^2$ is tracked exactly:

$$W_k^{(2)} = (1 - \alpha_k)^2\, W_{k-1}^{(2)} + \alpha_k^2$$

**Properties.**
- After the *first* observation, $W^{(2)} = 1$ (one weighted sample, full uncertainty).
- After idle ($\alpha \to 1$), $W^{(2)} \to 1$ — the EWMA effectively resets, and the system reports only one effective sample, widening SE.
- At steady state under constant $\alpha$, $W^{(2)} \to \alpha/(2-\alpha) \approx 0.055$ at $\alpha = 0.105$.

**Why this is the right ESS.** $\text{Var}(\hat{v}) = \sigma^2 \cdot W^{(2)}$ for an EWMA of independent $v_k$. The Satterthwaite ESS — the equivalent number of equally-weighted observations — is $1/W^{(2)}$, and df $= 1/W^{(2)} - 1$ (Welch–Satterthwaite, equal-variance case). This is what the Student-t critical value uses in §4.3.1.

#### 4.2.8 Other EWMA Updates (rates and counts)

The remaining EWMAs are not part of the trend-test pipeline; they support observability and other regulator branches. All use the time-weighted $\alpha_k$ from §4.1, with shrinkage applied for parameter-estimation signals:

**Rate signals** (Bayesian shrinkage on $\alpha$ scaled by per-window count $n_k = r_k$):

$$\alpha_c = \alpha_k \cdot \frac{r_k}{r_k + Z^2}$$

$$\hat\mu_k = (1 - \alpha_c) \hat\mu_{k-1} + \alpha_c r_k \quad (\text{completion rate})$$

$$\hat\delta_k = (1 - \alpha_c) \hat\delta_{k-1} + \alpha_c d_k \quad (\text{drop rate})$$

$$\hat{E}_k = (1 - \alpha_c) \hat{E}_{k-1} + \alpha_c \tfrac{e_k}{r_k} \quad (\text{error ratio})$$

**Counts** (raw $\alpha_k$ — admissions are not rate-shrunk because they are exact admission events):

$$\hat{a}_k = (1 - \alpha_k) \hat{a}_{k-1} + \alpha_k a_k \quad (\text{admission rate})$$

$$\hat{L}_k = (1 - \alpha_k) \hat{L}_{k-1} + \alpha_k F_k \quad (\text{in-flight count})$$

**Per-lane error rate** (time-weighted, with Bayesian shrinkage on the lane's cumulative completion count $c_\ell$):

$$\alpha_\ell^{\text{time}} = 1 - \exp\left(\frac{-\max(1, t - t_\ell)}{H \cdot W}\right), \quad \alpha_\ell = \alpha_\ell^{\text{time}} \cdot \frac{c_\ell}{c_\ell + Z^2}$$

$$\hat{p}_\ell \leftarrow (1 - \alpha_\ell) \hat{p}_\ell + \alpha_\ell\,[e]$$

where $[e] = 1$ if the task errored. The $\max(1, \cdot)$ floor ensures rapid same-tick completions still contribute weight. The shrinkage $c_\ell/(c_\ell + Z^2)$ dampens noisy early estimates (1 completion: 20%, 4 completions: 50%, 10 completions: 71%).

**Error rate (error ratio — errors/completions):**

$$\hat{E}_k = (1 - \alpha_c) \hat{E}_{k-1} + \alpha_c \tfrac{e_k}{r_k}$$

where $\alpha_c = \alpha_k \times r_k / (r_k + Z^2)$ (Bayesian shrinkage-scaled alpha on completions).

**Per-lane error rate (time-weighted with Bayesian shrinkage):**

Each lane's error rate is updated on completion with a time-weighted alpha based on elapsed time since the lane's last completion, scaled by Bayesian shrinkage:

$$\alpha_\ell^{\text{time}} = 1 - \exp\left(\frac{-\max(1, t - t_\ell)}{H \cdot W}\right)$$

$$\alpha_\ell = \alpha_\ell^{\text{time}} \times \frac{c_\ell}{c_\ell + Z^2}$$

$$\hat{p}_\ell \leftarrow (1 - \alpha_\ell) \hat{p}_\ell + \alpha_\ell [e]$$

where $[e] = 1$ if the task errored, $0$ otherwise, and $c_\ell$ is the lane's cumulative completion count. The $\max(1, \cdot)$ ensures rapid completions at the same timestamp still contribute weight. The Bayesian shrinkage factor $c_\ell/(c_\ell + Z^2)$ dampens the update for lanes with few completions — a lane with 1 completion gets only 20% of the full alpha, a lane with 4 completions gets 50%, and a lane with 10 gets 71%, preventing noisy early estimates from causing aggressive per-lane shedding. This uses the same Bayesian framework as all other signals.

### 4.3 Detection Thresholds

#### 4.3.1 Latency Detection (Student-t Hypothesis Test)

**Null hypothesis $H_0$:** latency is stable. $E[v] = 0$.

**Alternative hypothesis $H_1$:** latency is degrading. $E[v] > 0$.

**Philosophy: shrinkage for estimation, Student-t for the test.** Bayesian shrinkage and Student-t address distinct sources of small-sample uncertainty:

- **Shrinkage** (`n/(n + n_0)`) attenuates a parameter estimate toward a prior — the correct Bayesian treatment under a conjugate prior. Used for every *estimation* signal in the system: level, rates, proportions, lane error rates.
- **Student-t** (critical value grows as df decreases) is the exact sampling distribution of a z-like statistic when $\sigma^2$ is replaced by an estimate $\hat\sigma^2$. Used for the one *hypothesis test* in the system.

They solve different problems and are complementary, not substitutes. See §4.3.1.2 for the full audit.

##### Test statistic and SE formula

The test statistic is

$$t = \frac{\hat{v}}{\text{SE}}, \quad \text{SE}^2 = \hat\sigma_v^2 \cdot W^{(2)} \cdot \frac{1 + W^{(2)}}{2}, \quad \hat\sigma_v^2 = \frac{\delta^2}{1 + \alpha/2}$$

This expression has four components, each rigorously derived. Under $H_0$ at steady state, $E[\text{SE}^2] = \text{Var}(\hat{v})$ exactly — the SE is an unbiased estimator of the trend EWMA's variance.

**(a) δ² noise estimator with autocorrelation bias.** $v_k$ is the first difference of an AR(1)-like EWMA, which carries known negative autocorrelation $\rho_1 = -\alpha/2$. Under $H_0$,

$$E[\delta^2] = E\left[\frac{(v_k - v_{k-1})^2}{2}\right] = \sigma_v^2 (1 - \rho_1) = \sigma_v^2 \cdot \left(1 + \frac{\alpha}{2}\right)$$

So δ² overestimates $\sigma_v^2$ by factor $(1 + \alpha/2)$. Dividing yields the unbiased σ² estimator $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$.

**(b) Variance of an EWMA on autocorrelated $v$.** For an EWMA of $v_k$ with weights $w_j$, the standard formula $\text{Var}(\hat{v}) = \sigma_v^2 \sum_j w_j^2$ assumes independence. Under our actual lag-h autocorrelation $\rho_h = -\alpha(1-\alpha)^{h-1}/2$ (extending $\rho_1$ to higher lags), cross terms reduce the variance:

$$\text{Var}(\hat{v}) = \sigma_v^2 \left[\sum_j w_j^2 + 2\sum_{h \geq 1} \rho_h \sum_j w_j w_{j+h}\right]$$

Working through with $\sum_j w_j w_{j+h} = \alpha(1-\alpha)^h/(2-\alpha)$ at steady state and the closed-form $\rho_h$ above:

$$\text{Var}(\hat{v}) = \sigma_v^2 \cdot W^{(2)} \cdot \frac{1 + W^{(2)}}{2}$$

The $(1+W^{(2)})/2$ factor is the **autocorrelation variance-reduction** — negative autocorrelation suppresses the EWMA's variance below the i.i.d. baseline. At steady state $\alpha \approx 0.105$ (so $W^{(2)} \approx 0.055$), the factor is $\approx 0.527$ — `Var(ĥ)` is about half what it would be under independence.

**(c) Tracking $W^{(2)}$ exactly.** $W_k^{(2)} = (1-\alpha_k)^2 W_{k-1}^{(2)} + \alpha_k^2$ generalizes the constant-$\alpha$ formula $\alpha/(2-\alpha)$ to time-varying $\alpha$. The same tracked $W^{(2)}$ appears twice in the SE formula: once as $W^{(2)}$ (sum-of-squared-weights) and once inside $(1+W^{(2)})/2$ (autocorrelation factor). Both are exact in tracked state under constant $\alpha$, and degenerate gracefully under varying $\alpha$ — when $W^{(2)} \to 1$ (one effective sample, post-idle), the autocorrelation factor approaches 1, so SE² → σ̂² (no autocorrelation correction when there's effectively one sample).

**(d) Drift invariance.** A pure additive drift $v_k = \mu + \epsilon_k$ contributes zero to lag-1 differences ($\mu - \mu = 0$), so $\delta^2$ tracks the noise of $\epsilon_k$ only — independent of $\mu$. Under $H_1$ ($\mu > 0$), $\delta^2$ does **not** inflate, SE remains calibrated, and the test statistic $\hat{v}/\text{SE}$ grows linearly with $\mu$. There is no saturation ceiling on the z-score under severe degradation.

This property distinguishes von Neumann's δ² from any centered-variance estimator (Welford, $S^{(2)}$, etc.), all of which absorb drift into the noise estimate and produce saturating test statistics. Empirically validated in v1.2.0 against Welford-B and the raw second moment: those alternatives failed to fire on Full Overload and Error-Based Capacity Overload scenarios where δ² fired correctly. See `.changeset/statistical-rigor.md` for the comparative bench results.

**Asymmetric shrinkage between numerator and denominator.** The trend numerator $\hat{v}$ uses shrunk inputs $v_k \cdot s_k$ (§4.2.5); δ² uses raw $v_k$ (§4.2.6). Under $H_0$ this preserves FPR — $E[v \cdot s] = 0$ regardless of $s$. Under $H_1$ this dampens detection at low throughput by factor $E[s]$, providing per-window throughput-aware conservatism that complements the t-distribution's df-based gating.

**Putting it together.** Combining (a), (b), (c), (d):

$$\text{SE}^2 = \hat\sigma_v^2 \cdot W^{(2)} \cdot \frac{1+W^{(2)}}{2} = \frac{\delta^2 \cdot W^{(2)} \cdot (1 + W^{(2)})}{2 \cdot (1 + \alpha/2)}$$

Under constant $\alpha$ this is exact under both $H_0$ and $H_1$. Under smooth time-varying $\alpha$ it is a first-order approximation, accurate at steady state.

##### Degrees of freedom and Student-t critical value

Because $\sigma_v^2$ is estimated (not known), the studentized ratio $\hat{v}/\text{SE}$ follows a Student-t distribution rather than a standard normal:

$$t = \frac{\hat{v}}{\text{SE}} \sim t_\nu, \quad \nu = \frac{1}{W^{(2)}} - 1$$

The degrees-of-freedom expression $\nu = 1/W^{(2)} - 1$ comes from Welch–Satterthwaite applied to the EWMA:

- $1/W^{(2)}$ is the **effective sample size** — the equivalent number of equally-weighted samples that would produce the same $\text{Var}(\hat{v})$.
- Subtracting 1 reflects the loss of one degree of freedom from estimating the mean (here, the trend $\hat{v}$ is the estimator of $E[v]$). Standard practice for any sample-variance Student-t setup.

At steady state under $\alpha \approx 0.105$: $W^{(2)} \approx 0.055$, so $\nu \approx 17$. After idle: $W^{(2)} \approx 1$, $\nu \approx 0$ — the test is gated off (see Theorem 9).

**Critical value via Cornish-Fisher with conservative truncation bound.** Computing the exact Student-t quantile $t_{1-\Phi(-\sigma_D),\,\nu}$ requires the inverse incomplete beta function, which is expensive and has tricky edge cases at small $\nu$. concurrex uses a 4th-order Cornish-Fisher inverse-t series following Hill, G. W. "Algorithm 396: Student's t-quantiles." *Communications of the ACM* 13.10 (1970): 619–620, plus an asymptotic-series truncation bound:

$$t_{1-p,\,\nu} \approx z_p + \frac{g_1}{\nu} + \frac{g_2}{\nu^2} + \frac{g_3}{\nu^3} + \frac{g_4}{\nu^4} \;+\; 2 \left|\frac{g_4}{\nu^4}\right|$$

where $z_p = \Phi^{-1}(1-p) = \sigma_D$ for our test, and $g_1, g_2, g_3, g_4$ are polynomials in $z_p$:

$$g_1 = \frac{z(z^2 + 1)}{4}, \quad g_2 = \frac{z(5z^4 + 16z^2 + 3)}{96}, \quad \ldots$$

The truncation bound $2|g_4/\nu^4|$ is a one-sided upper bound on the geometric-tail residual: at $\nu \geq 5$, the Cornish-Fisher coefficients decay with ratio $\leq 1/2$ between successive terms, so the truncation error is bounded by twice the last included term. At $\nu < 5$ the geometric-decay assumption is heuristic, but the bound's $1/\nu^4$ growth is fast enough to remain empirically conservative.

**Net effect.** The implementation's `tScore(z, df)` always returns an upper bound on the true $t$-quantile. As $\nu \to \infty$, the bound converges to $z = \sigma_D$ and FPR converges to $\Phi(-\sigma_D)$. As $\nu \to 0$, the bound diverges, naturally gating the test off — no separate df-clamp or warm-up guard is needed (Theorem 9).

**Test rule.** Latency is degrading when

$$\hat{v} > \text{tScore}(\sigma_D,\, \nu) \cdot \text{SE}$$

At $\sigma_D = 2$, nominal FPR $\leq \Phi(-2) \approx 2.3\%$ at all $\nu$ (Theorem 7), with empirical FPR closer to $\sim 0\%$ in production benchmarks due to the conservative truncation bound at finite $\nu$.

##### Idle and sparse traffic handling

Three mechanisms cooperate to gate the test off when evidence is insufficient — all *implicit* through the math, no special-case code:

1. **Time-weighted alpha** $\alpha_k = 1 - e^{-\Delta t / (H \cdot W)}$ approaches 1 after long idle gaps, so the first observation after idle dominates the EWMA — but $W^{(2)}$ resets to ≈ 1 simultaneously.
2. **$W^{(2)}$ correctly tracks ESS** under time-varying $\alpha$. After idle, $W^{(2)} \approx 1$ (ESS = 1), so $\nu \approx 0$.
3. **Student-t critical value diverges** at $\nu \to 0$ via the truncation bound's $1/\nu^4$ growth. The test cannot fire until $\nu$ has decayed back to a usable range.

The handoff between these three mechanisms is continuous — there are no thresholds, no "warm-up window" counters, no df-clamps. The math gates the test naturally.

##### 4.3.1.1 Per-lane error rate: Bayesian shrinkage

Per-lane error rate uses Bayesian shrinkage (same as pool-wide signals), scaled by the lane's cumulative completions:

$$\alpha_\ell = \alpha_\ell^{\text{time}} \times \frac{c_\ell}{c_\ell + Z^2}$$

where $c_\ell$ is the lane's cumulative completion count. At 1 completion: 20% weight. At 4 completions: 50% weight. At 10 completions: 71% weight. At 100 completions: 96% weight. This prevents noisy early estimates from causing aggressive per-lane shedding, using the same Bayesian framework as all other estimation signals.

##### 4.3.1.2 Shrinkage vs Student-t: audit of concurrex signals

Each signal is classified by whether it's an *estimation* problem (shrinkage) or a *hypothesis test* (Student-t):

| Signal | Role | Mechanism |
|---|---|---|
| $\bar{m}$ (logWBar) | Estimate mean of $\log(W)$ | Shrinkage on level EWMA alpha |
| $\hat{v}$ (trend numerator) | Estimation input to the test | **Asymmetric** shrinkage on input ($v_k \cdot s_k$); δ² sees raw $v_k$ |
| Completion / drop rate EWMAs | Estimate rate parameters | Shrinkage (Gamma-Poisson conjugate) |
| Pool-wide and per-lane error rate | Estimate proportion | Shrinkage (Beta-Binomial / Wilson) |
| Early-shed probability | Confidence-weighted shed rate | Shrinkage (credibility scaling) |
| **Trend test (is $\mu_v > 0$?)** | **Hypothesis test** | **Student-t critical value with truncation bound** |

Only one signal in the system is a hypothesis test, and Student-t applies there alone. Bayesian shrinkage applies wherever a *parameter* is estimated — including the trend numerator (asymmetrically: numerator dampened, denominator δ² unshrunk).

#### 4.3.2 Probabilistic Error Decrease

Pool-wide error detection (error spread significance, dErrorRate z-test) has been removed. Error response is now handled by two independent mechanisms:

1. **Per-lane shedding** (§4.3.1.1): filters localized errors at the lane level. One bad downstream dependency causes its lane's error rate EWMA to rise, shedding requests to that lane without affecting pool-wide concurrency.

2. **Probabilistic error decrease** (§4.4.1, branch 4): when the pool-wide `errorRateEwma` $\hat{E} > 0$ and $\text{rand}() < \hat{E}$, the regulator applies a decrease step. Per-lane shedding keeps the aggregate error rate low for localized failures, so `errorRateEwma` only rises significantly for systemic issues (errors across many lanes). At 2% aggregate errors, the decrease fires on ~2% of time constant evaluations — barely noticeable. At 80% errors, it fires on most evaluations — aggressive correction. The probability self-scales to match error severity.

**Why this replaces pool-wide error detection.** The previous design used error spread (proportion of lanes with errors) and dErrorRate (trend in error ratio) to detect systemic errors. This required tracking `laneKeysCompletedThisWindow`, `laneKeysErroredThisWindow`, `errorSpreadEwma`, `activeLanesEwma`, `dErrorRateEwma`, and `dErrorRateVariance`. The new design achieves the same goal — decreasing concurrency for systemic errors while ignoring localized ones — with zero additional state. Per-lane shedding naturally filters localized errors, so the aggregate `errorRateEwma` is already a reliable systemic signal.

**Theorem 7 (Upper-bounded false positive rate).** *Under the following assumptions:*
- *constant $\alpha$ at steady state (or smooth time-varying $\alpha$ as a first-order approximation),*
- *CLT normality of $v_k$ (excellent at moderate throughput; mild deviation at very low throughput is partially absorbed by the Student-t's heavier tails),*
- *Satterthwaite df = $1/W^{(2)} - 1$ (standard EWMA approximation; exact for equal-weighted averages),*
- *Cornish-Fisher 4th-order series with truncation bound $2|g_4/\nu^4|$ for the t-quantile (rigorous at $\nu \geq 5$, heuristically conservative at smaller $\nu$ via $1/\nu^4$ growth),*

*the Student-t test using $\text{SE}^2 = \hat\sigma_v^2 \cdot W^{(2)} \cdot (1+W^{(2)})/2$ with $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ and critical value $\text{tScore}(\sigma_D, \nu)$ satisfies*

$$P(\text{false positive} \mid H_0) \leq \Phi(-\sigma_D)$$

*at every $\nu$. At $\sigma_D = 2$: FPR $\leq 0.0228$. Equality is achieved in the limit $\nu \to \infty$.*

*Proof.* Under $H_0$, $E[v] = 0$ and $v_k$ is zero-mean noise. The first difference $v_k - v_{k-1}$ has variance $2\sigma_v^2(1 - \rho_1)$ where $\rho_1 = -\alpha/2$ (from first-differencing an AR(1)-like EWMA). Therefore

$$E[\delta^2] = E\left[\frac{(v_k - v_{k-1})^2}{2}\right] = \sigma_v^2(1 + \alpha/2)$$

*so $\hat\sigma_v^2 = \delta^2/(1+\alpha/2)$ is unbiased for $\sigma_v^2$. For the EWMA $\hat{v}$ of an autocorrelated process with $\rho_h = -\alpha(1-\alpha)^{h-1}/2$, the variance is*

$$\text{Var}(\hat{v}) = \sigma_v^2 \cdot W^{(2)} \cdot \frac{1 + W^{(2)}}{2}$$

*(autocorrelation reduces the variance below the i.i.d. baseline by factor $(1+W^{(2)})/2$). Therefore*

$$\text{SE}^2 = \hat\sigma_v^2 \cdot W^{(2)} \cdot \frac{1+W^{(2)}}{2} = \frac{\delta^2 \cdot W^{(2)} \cdot (1+W^{(2)})}{2 \cdot (1 + \alpha/2)}$$

*so $E[\text{SE}^2] = \text{Var}(\hat{v})$ exactly under constant $\alpha$. By CLT, $\hat{v}$ is approximately normal; since $\sigma_v^2$ is replaced by an estimate, the studentized ratio $\hat{v}/\text{SE}$ is approximately $t_\nu$ with $\nu = 1/W^{(2)} - 1$ (Satterthwaite ESS − 1). The implementation's `tScore` returns $t_{1-\Phi(-\sigma_D),\,\nu}$ plus an asymptotic-series truncation bound that is zero in the $\nu \to \infty$ limit and strictly positive otherwise. Thresholding at this upper bound yields $P(\text{FP} \mid H_0) \leq \Phi(-\sigma_D)$, with equality only in the $\nu \to \infty$ limit. $\square$

*Caveats (approximations in the proof):*
- *Constant $\alpha$: true only at steady state; smooth time-varying $\alpha$ gives a first-order approximation.*
- *CLT for $v_k$: excellent at moderate throughput (≥ 5 completions/window); mild heavy-tail deviation at very low throughput is partially absorbed by the Student-t's heavier tails.*
- *Satterthwaite df: standard approximation for EWMA variance estimators; exact for equal-weight averages.*
- *$t_{1-p,\,\nu}$ approximation: implementation uses 4th-order Cornish-Fisher (Hill 1970) plus a one-sided asymptotic-series truncation bound $2\,|g_4/\nu^4|$. The bound is rigorous at $\nu \geq 5$, where Hill's series decays geometrically with ratio $\leq 1/2$ and the remainder is strictly less than twice the last term. At $\nu \in (1, 5)$ the ratio-½ assumption may not hold term-by-term (e.g., at $\nu = 2$ the first ratio $|g_2/g_1|/\nu \approx 0.6$); the bound is heuristically conservative in this regime — empirically the returned value upper-bounds the true t-quantile, and its fast growth at small $\nu$ swamps any term-by-term divergence. At $\nu \to 0$ the bound diverges, removing the need for any separate df-clamp. In all cases, realized FPR remains at or below nominal $\Phi(-\sigma_D)$ at steady state; the equality is achieved in the limit $\nu \to \infty$.*

**Theorem 8 (Detection power under $H_1$: no saturation).** *Under $H_1$ ($E[v] = \mu > 0$), $\delta^2$ retains its $H_0$ expectation:*

$$E[\delta^2 \mid H_1] = E[\delta^2 \mid H_0] = \sigma_v^2 (1 + \alpha/2)$$

*and the test statistic grows unboundedly with $\mu$:*

$$\lim_{\mu \to \infty} t = \frac{s \cdot \mu}{\sqrt{\sigma_v^2 \cdot W^{(2)} \cdot (1+W^{(2)})/2}} \to \infty$$

*where $s = E[s_k]$ is the steady-state shrinkage. Severe degradation triggers the test at any positive throughput.*

*Proof.* The drift component of $v_k = \mu + \epsilon_k$ cancels exactly in lag-1 differences:

$$v_k - v_{k-1} = (\mu + \epsilon_k) - (\mu + \epsilon_{k-1}) = \epsilon_k - \epsilon_{k-1}$$

*so $\delta^2 = \text{EWMA}((\epsilon_k - \epsilon_{k-1})^2/2)$ — independent of $\mu$. Therefore $E[\text{SE}^2 \mid H_1] = E[\text{SE}^2 \mid H_0] = \sigma_v^2 \cdot W^{(2)} \cdot (1+W^{(2)})/2$, and $E[\hat{v} \mid H_1] = s \mu$ (the asymmetric shrinkage on the trend numerator). The test statistic*

$$t = \frac{\hat{v}}{\text{SE}} = \frac{s\mu + O(\sigma_v / \sqrt{\nu})}{\sigma_v \cdot \sqrt{W^{(2)} \cdot (1+W^{(2)})/2}}$$

*grows linearly in $\mu$ with no saturation ceiling. This is the **drift invariance** property of von Neumann's δ²: drift cancels in pairwise differences, so the noise floor stays calibrated to the actual noise level under any $\mu$. $\square$

*Transient behavior.* Before $\hat{v}$ has absorbed the new $\mu$, the test fires once $\hat{v}$ reaches roughly $\sigma_D \cdot \text{SE}$ — typically within $\sim 2/\alpha$ windows after onset (the EWMA time constant). Detection latency = O(time constant), not O(time constant × magnitude).

**Theorem 9 (Implicit warm-up via the t-score error bound).** *The test cannot fire at low effective sample size: as $W^{(2)} \to 1$ (one effective observation, $\nu \to 0$), the asymptotic-series error bound $2\,|g_4/\nu^4|$ diverges, forcing the critical value $\to \infty$ and the test returns false. No separate $n_w \geq H$ elapsed-windows guard and no df-clamp are needed.*

*Proof.* Three independent mechanisms cooperate:*

1. *At pool creation, $\delta^2 = 0$ — `isLatencyDegrading` returns false on the explicit $\delta^2 = 0$ guard.*
2. *Before two observations have been seen, the lag-1 difference cannot be computed and $\delta^2$ remains 0 — gated as in (1).*
3. *After two observations, $W^{(2)} \approx 1$ initially, giving $\nu \approx 0$. In `tScore`, the truncation bound $2\,|g_4/\nu^4|$ diverges as $\nu \to 0^+$ — critical $\to \infty$, test returns false. As $W^{(2)}$ decays geometrically toward $\alpha/(2-\alpha) \approx 0.055$ (under typical $\alpha \approx 0.1$), the bound shrinks smoothly, and the test becomes active once enough independent data has accumulated.*

*Unlike a hard df-clamp, the divergence at $\nu \to 0$ is a mathematical consequence of the series truncation expression: the last included term $g_4/\nu^4$ grows unboundedly as $\nu \to 0$, and the error bound $2\,|g_4/\nu^4|$ follows suit. The test returns conservative (large) critical values precisely when the approximation is least reliable — a single continuous function of $\nu$ with no special-case logic. The formal upper-bound guarantee on the t-quantile is rigorous at $\nu \geq 5$ (geometric decay with ratio $\leq 1/2$ verified empirically) and heuristic at smaller $\nu$; in the heuristic regime the bound grows fast enough to remain empirically conservative. $\square$

### 4.4 Regulation Phases and Step Formula

**Definition (Step formula).** Given regulation depth $d \geq 1$, current concurrency limit $L$, and bisection scale $s$ (`stepScale`):

$$f(d) = 1 - e^{-d/H}$$

$$\Delta(d) = \max\!\bigl(1,\; \lceil L \cdot f(d) \cdot s \rceil\bigr)$$

The factor $f(d)$ is the EWMA absorption fraction after $d$ steps with time constant $H$. It converges to 1 as $d \to \infty$, so the step converges to $L \cdot s$. The bisection scale $s$ starts at 1 and halves on each increase→retract→cooling cycle, allowing the system to converge to within $\pm 1$ of the true equilibrium in $O(\log L)$ oscillation cycles. $s$ resets to 1 when entering Restoring (operating point changed) or Decreasing (genuine degradation).

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

Every $H$ windows (when $n_w > 0$ and $n_w \bmod H = 0$), the regulator evaluates six branches in priority order. Warm-up is handled implicitly by the Student-t critical value in branch 1 (Theorem 9) — no separate $n_w \geq H$ guard is needed.

1. **Latency degrading** → `applyDecrease`. Retract previous increase or start fresh decrease ramp.
2. **Cooling** ($\Phi \in \{\texttt{Retracting}, \texttt{Decreasing}\}$, not degrading) → Reset to $\texttt{Idle}$, $d = 0$, $s \leftarrow s/2$ (bisection damping). One time constant evaluation pause after a decrease sequence before allowing increases. Acts as natural momentum — prevents immediate flip-flop between latency-decrease and queue-increase. The halved $s$ ensures the next increase cycle uses finer steps.
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

At convergence ($d \to \infty$), $\Delta \to L$: each time constant evaluation doubles (or halves) the limit — **true exponential adjustment** directly in the concurrency limit.

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

3. **Bounded by limit.** $\Delta \leq L$ always (Theorem 10 below) — the limit never more than doubles or halves in a single evaluation.

4. **Sensor-actuator lockstep.** The convergence rate $1/H$ matches the EWMA sensor's absorption rate. After each time constant evaluation, the dLogWBar sensor has absorbed $\sim 63\%$ of the previous adjustment's effect before the next decision. The actuator never outpaces the sensor.

5. **Asymmetric phase transitions.** Increasing→Retracting: walk back growth in reverse (proportional correction). Retracting/Decreasing→Increasing: no retraction, start cautious growth from depth 0 (the decrease was warranted).

6. **Retraction is the exact inverse of growth.** Retraction uses $f/(1+f)$ — the multiplicative inverse of the increase factor $f$. If increase multiplied $L$ by $(1+f)$, retraction divides by $(1+f)$. A full retraction returns $L$ to its original value (up to ceiling rounding). This eliminates oscillation from overshoot or undershoot.

7. **Persistence-based severity.** No explicit acceleration parameter. A brief latency spike triggers 1-2 small steps before cooling kicks in. Persistent degradation accumulates depth, producing increasingly aggressive correction. The moment the signal disappears, growth stops and restoring converges gradually toward baseline.

8. **Gradual restoring.** When $L \neq B$ and no other condition applies, restoring uses convergent steps toward baseline from either direction. No snapping — the convergent step formula starts small and grows, allowing the latency signal to detect problems before overshooting baseline.

9. **Bisection convergence.** Each increase→retract→cooling cycle halves $s$ (`stepScale`). The next increase cycle uses finer steps: if the first cycle overshot by $\Delta_1$, the second cycle's maximum step is $\Delta_1/2$. After $k$ cycles, the search band is $\Delta_1/2^k$, converging to within $\max(1, \cdot)$ of the true equilibrium in $O(\log L)$ cycles. $s$ resets to 1 on Restoring (operating point changed) or Decreasing (genuine degradation needs full strength).

### 4.6 Theorems

**Theorem 10 (Convergent step is bounded).** *$\Delta(d) \leq L$ for all $d \geq 1$ and $L \geq 1$.*

*Proof.* $1 - e^{-d/H} \leq 1$ for all $d \geq 0$, with equality only at $d = \infty$. Therefore $L \cdot (1 - e^{-d/H}) \leq L$, so $\lceil L \cdot (1 - e^{-d/H}) \rceil \leq L$. Since $L \geq L_{\min} \geq 1$, the $\max(1, \cdot)$ floor preserves $\Delta \leq L$. Equality ($\Delta = L$) is possible at very high $d$ when the product approaches $L$ from below and ceiling rounds up. $\square$

**Theorem 11 (Exponential adjustment at convergence).** *Under sustained directional pressure, the limit grows (or shrinks) exponentially with doubling time $H^2 \cdot W$ ms.*

*Proof.* At convergence ($d \gg H$), $1 - e^{-d/H} \to 1$. The behavior depends on the phase:

**Increase:** $\Delta \approx L$, so $L_{k+1} \approx 2L_k$ — true doubling.

**Retraction:** Uses $f/(1+f)$ where $f \to 1$, so $\Delta \approx L/2$, giving $L_{k+1} \approx L_k/2$ — true halving (multiplicative inverse of doubling).

**Fresh decrease:** $\Delta \approx L$, so $L_{k+1} \approx \max(L_{\min}, 0)$ — drives to floor in one step.

Time constant evaluations occur every $H \cdot W$ ms, and it takes $\sim H$ depths to reach convergence. The ramp phase adds $H \cdot H \cdot W = H^2 \cdot W$ wall-clock time.

For $H = 9$ and $W = 100\text{ms}$: the ramp takes $\sim 8.1\text{s}$. After ramp, each doubling takes $\sim 900\text{ms}$. $\square$

**Theorem 12 (Retraction mirrors growth in reverse order).** *If the system increased through depths $1, 2, \ldots, d_{\text{peak}}$ in Increasing phase, transitioning to Retracting on latency degradation produces decrease steps at depths $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ — the mirror image of the increase sequence.*

*Proof.* When $\widehat{\text{d}\bar{m}} > \theta$ and $\Phi = \texttt{Increasing}$ with $d = d_{\text{peak}} > 0$:

1. The regulator transitions to $\Phi = \texttt{Retracting}$.
2. It computes $\Delta(d_{\text{peak}})$ and applies $L \leftarrow L - \Delta$. Sets $d \leftarrow d_{\text{peak}} - 1$.
3. On the next time constant evaluation (if still $\widehat{\text{d}\bar{m}} > \theta$), $\Phi = \texttt{Retracting}$ and $d = d_{\text{peak}} - 1 > 0$. It computes $\Delta(d_{\text{peak}} - 1)$ and sets $d \leftarrow d_{\text{peak}} - 2$.
4. This continues: $\Delta(d_{\text{peak}} - 2), \Delta(d_{\text{peak}} - 3), \ldots$
5. When $d = 1$: computes $\Delta(1)$, sets $d \leftarrow 0$.
6. When $d = 0$: transitions to $\Phi = \texttt{Decreasing}$, sets $d \leftarrow 1$, fresh ramp begins.

The decrease depths are exactly $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$, mirroring the increase sequence $1, 2, \ldots, d_{\text{peak}}$ in reverse. $\square$

**Theorem 13 (Retraction exactly undoes growth).** *If the system increased through depths $1, 2, \ldots, d_{\text{peak}}$ in Increasing phase, a full retraction through depths $d_{\text{peak}}, d_{\text{peak}}-1, \ldots, 1$ returns $L$ to its original value, with cumulative error $O(d_{\text{peak}}/L)$ from ceiling rounding (bounded by $\pm 1$ per step).*

*Proof.* At each increase step at depth $d$, the actual update is $L_{\text{new}} = L + \max(1, \lceil L \cdot f(d) \cdot s \rceil)$ where $f(d) = 1 - e^{-d/H}$. In the continuous limit (no ceiling), this multiplies $L$ by $(1 + f \cdot s)$. The retraction step uses the multiplicative inverse $f \cdot s / (1 + f \cdot s)$, so the continuous-limit factor is $1/(1 + f \cdot s)$ — the exact inverse. Each step's ceiling rounding contributes at most $\pm 1$ to the actual change, so a full retraction through $d_{\text{peak}}$ steps differs from the original $L$ by at most $\pm d_{\text{peak}}$. For $L \gg d_{\text{peak}}$, the relative error is $O(d_{\text{peak}}/L)$; for small $L$ (e.g., $L = 2$, $d_{\text{peak}} = 5$), the bound is loose and convergence should be verified empirically. $\square$

**Theorem 14 (Finite convergence to $L_{\min}$ under persistent degradation).** *Starting from any $L_0$, there exists a finite $N$ such that after $N$ consecutive decrease evaluations, $L \leq L_{\min}$.*

*Proof.* Since $\Delta \geq 1$ always (the $\max(1, \cdot)$ floor), $L$ decreases by at least 1 per evaluation. Starting from $L_0$, at most $L_0 - L_{\min}$ evaluations reach $L_{\min}$. In practice, convergence is much faster due to accelerating step sizes. $\square$

**Theorem 15 (Invariant: $L \in [L_{\min}, L_{\max}]$).** *The concurrency limit is always within bounds.*

*Proof.* By exhaustive case analysis: decrease uses $\max(L_{\min}, L - \Delta)$; increase uses $\min(L_{\max}, L + \Delta)$; restoring clamps toward $B$ using $\min(B, L + \Delta)$ or $\max(B, L - \Delta)$ where $B \in [L_{\min}, L_{\max}]$ by registration validation. $\square$

**Theorem 16 (System converges to sustainable concurrency).** *If the backend has a sustainable capacity $C$ at concurrency $L_C$ (and degrades above $L_C$), the system converges to a neighborhood of $L_C$.*

*Proof sketch.* Each overshoot-correction cycle narrows the oscillation band via bisection damping: (1) retraction exactly undoes recent growth (Theorem 13), (2) cooling halves $s$, (3) the next increase cycle uses finer steps. After $k$ cycles, the maximum step is $\Delta_1 / 2^k$ where $\Delta_1 = \max(1, \lceil L_C \cdot f(1) \rceil)$. The oscillation amplitude converges geometrically to within $\max(1, \cdot)$ of $L_C$. This is strictly tighter than the previous bound of $\Delta(1)$ per cycle — bisection provides $O(\log L)$ convergence instead of perpetual oscillation at the minimum step size. $\square$

---

## 5. Independence of Mechanisms

**Theorem 17 (Orthogonality).** *ProDel, early shedding, and the throughput regulator operate on disjoint state and trigger on different signals.*

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
| **Bounded limit** | $L \in [L_{\min}, L_{\max}]$ always (Theorem 15) |
| **FPR upper bound** | $P(\text{FP} \mid H_0) \leq \Phi(-\sigma_D)$ at all $\nu$ (Theorem 7) |
| **No saturation under H₁** | Drift-invariant δ² → test statistic grows linearly with $\mu$ (Theorem 8) |
| **No false positives during warm-up** | Student-t critical value diverges as $\nu \to 0$ (Theorem 9) |
| **Conservative at low throughput** | Asymmetric shrinkage on trend numerator + Student-t at small df (§4.2.5, §4.3.1) |
| **Arbitrary $W/W_{\text{cw}}$ ratio** | Operational LL is exact for any finite interval (§4.2.1) |
| **Step bounded** | Each step $\leq L$ (Theorem 10) |
| **Retraction mirrors growth** | Decrease walks back growth in reverse order (Theorem 12) |
| **Retraction is exact inverse** | Full retraction returns L to original value (Theorem 13) |
| **Finite convergence to floor** | Decrease reaches $L_{\min}$ in $O(L_0)$ steps (Theorem 14) |
| **Self-recovery** | ProDel exits dropping when no lane has stale entries (pool-wide check after all lanes processed) (Theorem 4) |
| **System convergence** | Regulator converges to sustainable $L_C$ via bisection in $O(\log L)$ cycles (Theorem 16) |
| **Early shed is self-regulating** | Shedding dampens its own intensity (Theorem 5b) |
| **No starvation from early shed** | Only fires at capacity; completing tasks re-enable admission (Theorem 5c) |
| **Adaptive LIFO/FIFO** | FIFO when healthy (fair ordering); LIFO when dropping (protect fresh work) — both among lanes and within lanes (§2.1) |
| **Single convergent formula** | Same step $\Delta(d)$ for Increasing, Retracting, Decreasing, and Restoring |
| **Cautious recovery** | Retracting/Decreasing→Increasing starts fresh from depth 0 |
| **Asymmetric phase transitions** | Only Increasing→decrease triggers retraction; decrease→Increasing does not |
| **Per-lane shedding is independent** | Lane error rate doesn't affect pool-wide regulation (Theorem 17) |
| **Probabilistic error decrease** | Systemic errors cause probabilistic decrease (P = errorRate); per-lane shedding filters localized errors (§4.3.2) |
| **Gradual restoring** | Convergent steps toward baseline from either direction; no discontinuous snaps (§4.4.4) |
| **Bisection convergence** | Each increase→retract→cooling cycle halves stepScale; $O(\log L)$ cycles to equilibrium (§4.5) |
| **One-eval cooling** | After a decrease sequence, one time constant evaluation pause before allowing increases; stepScale halved (§4.4.1) |
| **Log-space robustness** | Log-transform compresses error-spike contamination of latency signal (§4.2) |

---

## Appendix A. Derivation of the Autocorrelation Structure of $v_k$

This appendix derives the autocorrelation $\rho_h$ used in §4.3.1 and the variance reduction factor $(1+W^{(2)})/2$ in the SE formula.

**Setup.** Let $x_k$ be i.i.d. zero-mean noise with variance $\sigma_x^2$ (the per-window log-W observations under $H_0$). The level EWMA is

$$\bar{m}_k = (1-\alpha)\bar{m}_{k-1} + \alpha x_k$$

The trend signal is the first difference

$$v_k = \bar{m}_k - \bar{m}_{k-1} = \alpha(x_k - \bar{m}_{k-1})$$

(The dt-normalization in §4.2.4 is suppressed here; it doesn't affect autocorrelation structure.)

**A.1 Variance of $v_k$ at steady state.**

$$\text{Var}(v_k) = \alpha^2\,\text{Var}(x_k - \bar{m}_{k-1}) = \alpha^2[\sigma_x^2 + \sigma_x^2 W^{(2)}] = \alpha^2 \sigma_x^2 (1 + W^{(2)})$$

(using $\text{Var}(\bar{m}) = \sigma_x^2 W^{(2)}$ and independence of $x_k$ from past $\bar{m}$). With $W^{(2)} = \alpha/(2-\alpha)$ at steady state, this simplifies to $2\alpha^2\sigma_x^2/(2-\alpha)$.

**A.2 Lag-1 autocorrelation $\rho_1 = -\alpha/2$.**

$$\text{Cov}(v_k, v_{k-1}) = \alpha^2\,\text{Cov}(x_k - \bar{m}_{k-1}, x_{k-1} - \bar{m}_{k-2})$$

Expanding the covariance using independence of $x$ from past $\bar{m}$:

$$= \alpha^2[0 - 0 - \alpha\sigma_x^2 + (1-\alpha)\sigma_x^2 W^{(2)}]$$

(The $-\alpha\sigma_x^2$ term comes from $\text{Cov}(\bar{m}_{k-1}, x_{k-1}) = \alpha\sigma_x^2$ since $\bar{m}_{k-1} = \alpha x_{k-1} + (1-\alpha)\bar{m}_{k-2}$. The $(1-\alpha)\sigma_x^2 W^{(2)}$ comes from $\text{Cov}(\bar{m}_{k-1}, \bar{m}_{k-2}) = (1-\alpha)\text{Var}(\bar{m})$.)

Substituting $W^{(2)} = \alpha/(2-\alpha)$ and simplifying:

$$\text{Cov}(v_k, v_{k-1}) = \alpha^2 \sigma_x^2 \cdot \frac{(1-\alpha)\alpha - \alpha(2-\alpha)}{2-\alpha} = -\frac{\alpha^3 \sigma_x^2}{2-\alpha}$$

Therefore

$$\rho_1 = \frac{\text{Cov}(v_k, v_{k-1})}{\text{Var}(v_k)} = \frac{-\alpha^3/(2-\alpha)}{2\alpha^2/(2-\alpha)} = -\frac{\alpha}{2}$$

**A.3 Lag-h generalization $\rho_h = -\alpha(1-\alpha)^{h-1}/2$.**

By the same expansion at lag $h$, the EWMA's geometric decay propagates: $\bar{m}_{k-1}$'s correlation with $\bar{m}_{k-h-1}$ is $(1-\alpha)^{h-1}$ times its lag-1 correlation. The result $\rho_h = -\alpha(1-\alpha)^{h-1}/2$ follows.

**A.4 Variance reduction factor $(1+W^{(2)})/2$.**

The variance of an EWMA over an autocorrelated sequence is

$$\text{Var}(\hat{v}) = \sigma_v^2\left[\sum_j w_j^2 + 2\sum_{h\geq 1}\rho_h \sum_j w_j w_{j+h}\right]$$

For EWMA weights $w_j = \alpha(1-\alpha)^j$ at steady state:

$$\sum_j w_j^2 = W^{(2)} = \frac{\alpha}{2-\alpha}, \qquad \sum_j w_j w_{j+h} = \frac{\alpha(1-\alpha)^h}{2-\alpha}$$

Substituting $\rho_h$ from A.3:

$$2\sum_{h\geq 1} \rho_h \cdot \frac{\alpha(1-\alpha)^h}{2-\alpha} = -\frac{\alpha^2}{2-\alpha} \sum_{h\geq 1}(1-\alpha)^{2h-1} = -\frac{\alpha(1-\alpha)}{(2-\alpha)^2}$$

Combining:

$$\text{Var}(\hat{v}) = \sigma_v^2\left[\frac{\alpha}{2-\alpha} - \frac{\alpha(1-\alpha)}{(2-\alpha)^2}\right] = \frac{\sigma_v^2 \cdot \alpha}{(2-\alpha)^2}$$

Converting via $W^{(2)} = \alpha/(2-\alpha)$, so $\alpha = 2W^{(2)}/(1+W^{(2)})$ and $2-\alpha = 2/(1+W^{(2)})$:

$$\frac{\alpha}{(2-\alpha)^2} = \frac{2W^{(2)}/(1+W^{(2)})}{4/(1+W^{(2)})^2} = \frac{W^{(2)}(1+W^{(2)})}{2}$$

Therefore

$$\text{Var}(\hat{v}) = \sigma_v^2 \cdot W^{(2)} \cdot \frac{1+W^{(2)}}{2}$$

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
