# 2026-05-18 — Stochastic methods audit + research program

**Question from owner:** "Have we tried Stochastic Methods? Specifically: (1) dependencies (e.g. RSI/price divergence as an exit signal), (2) long-term conditional probabilities (by ticker, universe, regime, recency), (3) extremes / dependency breakdown, (4) Simple Random Walk, (5) Markov chains on scores/signals, (6) Have we truly looked at EMA cross / ST flip triggers against context to know when they work?"

This document is the honest audit + sequenced research program. Like the chop-regime diagnostic (`tasks/2026-05-18-chop-regime-defense-diagnostic.md`), it ships as a **planning artifact** — no live engine code is changed by this PR. Owner picks which items to fund as scoped follow-up PRs.

The companion chop-regime doc is **defensive** (stop the bleed). This doc is **offensive** (find new edge through quant methods).

---

## 0. UPDATE 2026-05-18 PM — Owner feedback + trajectory framing

Owner's answers to the five open questions are locked in below. More importantly, owner reframed the whole program around a single insight that changes which work matters most:

> "We aren't really applying relativity into our thinking. We know the makeup of every move, long or short. We have the ability to look at our scores, signals and patterns throughout that move. If we looked at our scores and signals and the journey they go through, we should be able to relatively know what is likely to work vs not. Think of our bubble map, our unique proprietary offering. We know that there are key corridors and movements a ticker bubble will make before leading into and exiting out of a move. Is that not something we can use to decrypt the move?"

> "Now imagine applying Simple Random Walk or Markov Theory to that?"

> "Right now we have setups and plays that we look for but we haven't translated that to our language as well. We have become rigid on the setup and blindly hoping it works."

> "We really need to be 70-80% right with our trades, not 10% today or 20% yesterday or less than 50% in May. We have 200+ tickers and a streaming flow of data that tells us exactly when moves are happening."

This is correct, and it reorders the program. §0.1–§0.5 below capture what that means concretely. The §1–§7 content beneath stays as the technical scorecard, gap analysis, and Markov / random-walk theory — but the **rollout** in §4 is superseded by §0.6.

### 0.1 Locked answers to the five open questions

| # | Question | Owner's answer | What we'll do |
|---|---|---|---|
| 1 | X video — anything specific to ingest? | **Simple Random Walk** | Make Simple Random Walk (Wiener-style discrete random walk) the explicit null model in S3 and the explicit *baseline path* the bubble-map trajectory work is compared against. |
| 2 | S3 stringency — random-walk null threshold? | **My call** | I'm setting it at the **95th percentile** of the null distribution as the bar for "real edge." 95th is the standard statistical threshold; setting it stricter (99th) would reject too many setups that have honest but small edge, and we don't have enough trade count to support 99th-percentile claims yet (598 all-time). |
| 3 | S4 default — divergence exit OFF or ON? | **ON** | Ship S4 with the divergence exit *active*, behind a feature flag (`exits.divergence_enabled` in `model_config`) so you can roll back from config without redeploy. Every event logged to a new `divergence_events` table from day one. |
| 4 | Compute budget — nightly cron or separate job? | **Unsure → my call** | Cron-based, but separate from the worker hot path. S1/S2/S5 run inside Worker (small enough), S3 (10K random-walk simulations) ships as a separate scheduled job — likely a `scripts/random-walk-null.js` invoked from the existing nightly action runner so it doesn't compete with the live worker for CPU. |
| 5 | Min cohort sample before live action? | **>15** | All cohort-conditional probability overrides require **n ≥ 15** trades in the matched cohort before they affect admission, sizing, or exits. Cohorts below 15 are reported as **observational only** (visible in Insights, not wired to behavior). |

### 0.2 The relativity / trajectory insight, formalized

We have been doing **point-in-time** analysis: "is the setup right *at this instant* for entry?" The owner is asking us to do **path-conditional** analysis: "what's the *journey* this candidate is on, and does that journey historically lead to a win?"

The bubble map is already a state space. Each ticker at each moment is a point in a multi-dimensional feature space (the same dimensions the bubble chart renders + flags). As time passes, that point traces a trajectory. **The trajectory has predictive content the snapshot doesn't.**

Two example trajectories:

```
Move A (winner):  cell→  [Bull/D5/PhaseLow]  →  [Bull/D6/PhaseLow]  →  [Bull/D7/PhaseMid+sq_release]  →  [Bull/D8/PhaseMid+st_flip]  →  ENTRY  →  +2.1R

Move B (loser):   cell→  [Bull/D7/PhaseHigh] → [Bull/D7/PhaseHigh]  →  [Bull/D6/PhaseHigh+st_flip]    →  [Bull/D6/PhaseHigh]         →  ENTRY  →  -1.0R
```

Both are "Bull-state with ST flip" at entry — our current admission engine treats them identically. But A entered during *ascent through a corridor that historically resolves up*, B entered after *exhaustion in a high-phase cell that historically reverts*. A snapshot can't see that; the trajectory can.

### 0.3 The data exists — we don't need new instrumentation to start

Critical finding (`worker/migrations/add-trail-5m-fact-table.sql`):

```13:62:worker/migrations/add-trail-5m-fact-table.sql
CREATE TABLE IF NOT EXISTS trail_5m_facts (
  ticker TEXT NOT NULL,
  bucket_ts INTEGER NOT NULL,  -- 5-minute bucket start (floor to 300000ms)
  ...
  htf_score_avg REAL,
  htf_score_min REAL,
  htf_score_max REAL,
  ltf_score_avg REAL,
  ltf_score_min REAL,
  ltf_score_max REAL,
  state TEXT,
  rank INTEGER,
  completion REAL,
  phase_pct REAL,
  had_squeeze_release INTEGER DEFAULT 0,
  had_ema_cross INTEGER DEFAULT 0,
  had_st_flip INTEGER DEFAULT 0,
  had_momentum_elite INTEGER DEFAULT 0,
  had_flip_watch INTEGER DEFAULT 0,
  kanban_stage_start TEXT,
  kanban_stage_end TEXT,
  ...
```

Per ticker, every 5 minutes, we already have: `(state, rank, completion, phase_pct, htf_score, ltf_score, signal flags, kanban stage)`. **That's the trajectory.** 30+ days × 250 tickers × 78 RTH 5-min buckets/day = ~**~600,000 trajectory snapshots already in the database**. We can build the trajectory framework against existing data — no new logging required.

That's a different posture from "go instrument and wait three months for data." We can have S0 + S1.5 producing real cohorts within days of the foundation PR landing.

### 0.4 New / changed items in the program

Inserted ahead of S1 — these are the prerequisites for everything trajectory-related:

- **S0 — Bubble-map state space definition.** Choose the discretization for `trail_5m_facts` rows into discrete cells. My proposed v0:
  - `state` (4 values: `HTF_BULL_LTF_BULL`, `HTF_BULL_LTF_PULLBACK`, `HTF_BEAR_LTF_BEAR`, `HTF_BEAR_LTF_PULLBACK`)
  - `rank_decile` (10 values: 0–9 by `rank` percentile of the universe at that bucket)
  - `completion_band` (4 values: 0–25 / 25–50 / 50–75 / 75–100)
  - `phase_band` (4 values: 0–25 / 25–50 / 50–75 / 75–100)
  - Signal-flag overlay (`had_squeeze_release`, `had_ema_cross`, `had_st_flip` as binary annotations on a cell, not a separate cell)

  v0 cell count: 4 × 10 × 4 × 4 = **640 cells**. Coarse enough that the n ≥ 15 cohort min is achievable from existing data; fine enough that trajectories show meaningful structure. v1 can refine after we measure cell density.

- **S1.5 — Trajectory recorder.** Backfill script + ongoing cron that, for every closed trade, builds the `(cell_t-K, cell_t-K+1, …, cell_entry, …, cell_exit)` sequence using K=12 (last hour pre-entry, 5-min granularity). Persist to new `trade_trajectories` table keyed by `trade_id`. For open positions, the latest K cells are computed live on read.

- **S2.5 — Trajectory similarity / cohort lookup.** Given a candidate trade's last-K cell sequence, find the nearest k-NN historical trajectories (Hamming or Jaccard distance over the cell sequence, weighted by recency). Return empirical `P(win)`, `avg_R`, and sample size of the matched cohort. With n ≥ 15 cohort minimum, results are gated.

- **S3 — explicit Simple Random Walk null.** Per owner's lock-in. Two flavors:
  - **Entry-time null:** for each setup × cohort, simulate random entries from a Simple Random Walk over the same valid-bar universe. If our actual entries don't beat the 95th percentile of the random distribution → that setup has no edge.
  - **Trajectory null:** generate Simple Random Walks through the **cell** state space (transition probabilities derived empirically from the trajectory recorder data); compare actual move trajectories to the random-walk distribution. Real edges show as trajectories statistically distinct from random walks through the same cells.

- **S6 — Markov chain on bubble cells.** Now grounded:
  - **Cell transition matrix:** `P(cell_t+1 | cell_t)` over the 640-cell space, built from `trail_5m_facts`. Lets us forward-project: "given this ticker is in cell X, what's the distribution of cells in 3 bars?"
  - **Win-conditioned chain:** separate `P(cell_t+1 | cell_t, eventually_won)` vs `P(cell_t+1 | cell_t, eventually_lost)`. The two matrices diverge in cells where the model has predictive power. Cells where they're nearly identical are noise zones — don't trade them.
  - **Stage Markov:** kept from original S5, `P(stage_t+1 | stage_t)` for open-trade stages.

### 0.5 Honest take on 70–80% win-rate target

I have to be straight here: **70–80% sustained WR is a stretch target.** Reasons:

- All-time book WR is 51.7% on 598 trades. The best months ran 65% with PF 9. The system has the upside but not the floor.
- High-WR strategies typically have small TP / wide SL (scalp-style). Our setup library (ATH breakout, gap reversal, pullback continuation, ranged-reversal) is built for trend-capture — those naturally run 50–60% WR with PF > 2 by design. April hit 65% / PF 9.13 not because every setup was 75%, but because the regime fit and a few big winners pulled the PF up.
- Industry baselines: serious systematic funds report 55–62% WR on directional intraday strategies; very-high-frequency market makers approach 80%+ but on average-R-per-trade ~0.05R (different game entirely).

What's **realistic** with the trajectory framework working:

- WR: **55–65%** sustained (vs current rolling ~45% and May ~21%).
- Avg expectancy: **+$80–$150/trade** (vs current rolling +$2 and May -$76).
- PF: **1.7–2.5** sustained (vs all-time 2.00 and May 0.06).
- The big lever isn't pushing WR to 75% — it's **eliminating the long left tail** (the `hard_loss_cap` -$590 avg trades, the `doctrine_force_exit` -$124 avg trades). Cutting tail losses by half while WR stays at 55% would put expectancy comfortably at +$100/trade and PF at ~1.8.

I'd rather under-promise and over-deliver here. If the trajectory work moves WR to 60% AND cuts the worst exits in half, we're back to a healthy system. If it moves WR to 70% AND cuts tail in half, that's exceptional. Setting **65% WR + PF 1.8 + expectancy +$100** as the realistic 90-day target post-rollout, with 70%+ as the stretch goal if the trajectory cohorts come in tight.

That doesn't mean we settle. It means we measure honestly and don't tell users we'll be 75% right and then ship 60%. The system can be **dramatically** better than May without being industry-anomalous.

### 0.6 Revised sequenced rollout (supersedes §4)

Same blast-radius philosophy: read-only foundations first, behavior changes last, evidence between each step.

| Step | PRs | Soak | Why this order |
|---|---|---|---|
| **Phase 1 — Foundation** | **S0** (cell definition) + **S1.5** (trajectory recorder backfill) + **R7/S2** (calibration enrichment + cohort lookup) | 3 days | All read-only. Builds the substrate. Without S0/S1.5 every other trajectory item is theoretical. |
| **Phase 2 — Visibility** | **S1** (trigger hit-rate analyzer, *upgraded* to bucket by cell instead of by raw VIX/regime) + **S2.5** (k-NN trajectory cohort lookup endpoint) + **S5** (stage Markov on Insights) | 5 days | Read-only. Owner sees first cohort numbers. Decides which to act on. |
| **Phase 3 — Edge validation** | **S3** (Simple Random Walk null — entry-time + trajectory) | 5 days | Tells us which setups and which cells have real edge vs label-on-noise. Per owner: 95th percentile threshold. |
| **Phase 4 — First active stochastic** | **PR #203 R1** (restore VIX ceiling on TT-Core — defensive, smallest first) + **S4** (divergence exit, **ON per owner**, feature-flagged, every event logged) | 7 days | First behavior changes. Each is small and rollback-able from config. |
| **Phase 5 — Trajectory-aware admission + sizing** | **S2.5 wired to admission**: when a candidate's cohort `n ≥ 15` AND empirical WR < marginal WR by > 10pts → reject; when WR > marginal by > 10pts at the same conviction → upsize. **R3** (chop size haircut from PR #203) ships in the same phase if S3 confirms chop-cell trajectories are negative-edge. | 14 days | First time the bubble-map state space drives live entries. Conservative thresholds; n ≥ 15 floor enforced. |
| **Phase 6 — Markov-conditioned exits** | **S6** (cell transition matrix → forward project current open trades; downgrade to defend if forward-projected cell distribution has > 60% in known-losing cells) + **PR #203 R5** (exit doctrine chop mode) | 14 days | Highest leverage but biggest exit-logic change. Lands after we trust the cell maps. |
| **Phase 7 — Awareness + extensions** | **S7** (tail-event tagger) + **S8** (MACD/OBV divergence) + **R4** (weekly DD breaker from PR #203) | Ongoing | Cleanup + extensions once the trajectory framework is established. |

**First PR to schedule (if/when you approve this updated plan):** Phase 1 — `S0 + S1.5 + R7`. Single small worker route + a backfill script + one migration. Read-only. Produces the trajectory dataset against which everything else is measured.

### 0.7 What changed from the original v1 plan

For audit-trail clarity:

- **Added** S0, S1.5, S2.5 (bubble-map state space, trajectory recorder, k-NN cohort).
- **Modified** S3 to be explicitly Simple Random Walk (owner directive) with two flavors (entry-time + trajectory).
- **Modified** S6 from "regime + score-band Markov" (generic) to **cell-based Markov on the bubble state space** + win-conditioned chain comparison.
- **S4** locked to ship **ON** with feature flag + event logging.
- **Cohort floor** locked at n ≥ 15.
- **Rollout sequence** revised — foundation items lead, then visibility, then validation, then live behavior changes.
- **70–80% WR target** addressed honestly with a realistic 65% WR / PF 1.8 / expectancy +$100 90-day target.

§1 through §7 below are the original v1 audit, gap analysis, and method primer — still valid; just superseded on rollout sequence and S3/S6 specifics by §0.6.

---

---

## TL;DR — honest scorecard

| Method | Status | Where it lives | What's missing |
|---|---|---|---|
| **RSI / phase divergence detection** | ✅ EXISTS | `worker/indicators.js:182`, used in `divergenceModifier` (`worker/pipeline/entry-selector.js:58`) | Only feeds entry score — NOT exit signal; no breakdown tracking; no MACD/OBV divergence |
| **Markov chain / state transition probabilities** | ❌ NOT IMPLEMENTED | — | No transition-frequency tables for regime, setup grade, RSI bands, stage chains, etc. |
| **Random walk null hypothesis** | ⚠️ PARTIAL | `scripts/statistical-validation.js:119` (bootstrap CIs, shuffle K–S) | Standalone script only; not in production backtest; no Monte-Carlo synthetic price paths |
| **EMA cross / ST flip hit rate by context** | ⚠️ PARTIAL | Flags stored on trail facts (`worker/index.js:29169`); global Spearman IC computed (`:29495`); pre-move "alignment accuracy" in `worker/onboard-ticker.js:296` | No "flip at T → outcome at T+N bars" bucketed by VIX / regime_class / sector / vol of day. We compute the IC of the value, never the hit rate of the trigger event. |
| **Conditional probability lattice P(win \| feature_bucket)** | ⚠️ PARTIAL | Marginal buckets exist: `by_regime`, `vix_buckets`, `executionProfileAnalysis`, `rankDeciles`, `pathReport` (`worker/index.js:29387`–`:30167`) | One-dimensional only — no joint P(win \| regime × VIX × setup × grade); `vix_buckets` often empty (any trade missing `vix_at_entry` is silently skipped) |
| **Extreme / tail / dependency-breakdown analysis** | ❌ NOT IMPLEMENTED | — | No code that flags when a previously-correlated dependency stops holding, no tail-event tagging, no "cause" attribution |
| **Bayesian posterior updating** | ❌ NOT IMPLEMENTED | — | No prior/posterior, no exponentially-weighted recency-prior |
| **Survival / hazard analysis on open trades** | ❌ NOT IMPLEMENTED | — | We have hold-time buckets in static reports (`tasks/may-2026-performance-analysis.md` §2F) but no live hazard rate per minute / per bar by setup |

**Plain English:** We have one solid quant primitive (RSI/phase divergence) that we use only on the entry side. We have a marginal-bucket calibration aggregator that under-reports because its VIX enrichment is broken (already in PR #203 R7). We have **no** state-transition / Markov / random-walk / context-bucketed trigger hit-rate / joint-probability machinery. The "have you really looked at your triggers" question — for ST flips and EMA crosses specifically — the answer is no: we look at the **value** of the indicator at entry (IC), never the **outcome** of the flip event itself bucketed by anything.

---

## 1. The owner's questions, answered directly

### Q1. "What are the dependencies?" — e.g. RSI peak + price peak → next price high needs RSI confirmation or it's divergence

**Status:** We detect the divergence today (RSI + phase oscillator), but only USE it as an additive entry-score penalty. We don't use it as a live EXIT signal, and we don't track how reliable each divergence has been for each ticker / regime.

Quoted entry-side use:

```58:94:worker/pipeline/entry-selector.js
export function divergenceModifier(div) {
  ...
  if (advRsi >= 1 && advPhase >= 1) return -25;
  ...
  if (advRsi >= 1) return -10;
```

**Missing piece — the dependency framework you described:**
1. Per ticker, maintain a rolling list of (price pivot, RSI pivot) pairs.
2. For each open position, on every bar, ask: *did price make a new high without RSI confirmation?* If yes → flag as **bearish divergence forming**.
3. Convert to a graded exit signal: `divergence_warn` → tighten trail; `divergence_confirmed` (2 consecutive bars) → trim 50%; `divergence_persistent` (3+ bars) → force exit.
4. Log to a `divergence_events` table so we can answer "how reliable was that divergence?" by ticker / regime / time-of-day.

This is the exact dependency the owner described, and 80% of the primitive is already in `detectSeriesDivergence`. The missing 20% is wiring it as an exit signal + logging the outcomes.

### Q2. "What are the long-term probabilities?" — by ticker, universe, regime, recent

**Status:** Partial. We compute marginal buckets (`by_regime`, `vix_buckets`, `rankDeciles`, `pathReport`, `executionProfileAnalysis`) but each is one-dimensional. We don't compute joint distributions, and `vix_buckets` is often empty because the resolution is fragile:

```29836:29857:worker/index.js
  const vixBuckets = { low: [], medium: [], high: [], extreme: [] };
  for (const t of trades) {
    const s = extractScoring(t);
    if (s.vix == null) continue;
```

`vix_at_entry` is sourced from D1 VIX candles within 5 days of entry — if VIX D1 is missing for any reason the trade is dropped from VIX analysis entirely.

**Missing piece — true conditional probability lattice:**
A single endpoint that emits, for every closed trade:

```
P(win | setup × grade × direction × regime × regime_class × vix_bucket × sector × dow × age_bucket)
```

Stored as a sparse multi-dim table with sample counts. Then a top-level query: "for this candidate trade with these features, what's the empirical win rate of the nearest matched cohort, and what's the sample size?" Drive admission OR sizing off that empirical rate.

Without this, we can never honestly answer "P(SPY gap-reversal-long Prime wins | VIX 22 + CHOPPY)" because the trade gets posted to `pathReport["gap_reversal_long"]` AND to `by_regime["EARLY_BULL"]` separately, not their intersection.

### Q3. "How often do the extremes happen and what is the impact?" — dependency breakdown, cause attribution

**Status:** Not implemented. We log `hard_loss_cap` exits and `doctrine_force_exit` exits but we don't tag them as "dependency broke" or "regime flipped unexpectedly" or "VIX shocked." The owner is essentially asking for **tail-event taxonomy and root-cause clustering**.

**Missing piece — tail-event tagger:**
1. On every closed losing trade with PnL beyond 2σ of expected, classify the cause:
   - `divergence_unconfirmed` — divergence formed but didn't act on it
   - `regime_flip_intrabar` — regime label flipped during the trade
   - `vix_shock` — VIX moved > 3pts intrabar
   - `sector_capitulation` — sector ETF dropped > 1σ same bar
   - `single_bar_gap` — single 5m bar caused > 50% of the loss
   - `event_unknown` — none of the above
2. Aggregate: `tail_event_counts[cause] = n / 90d` with average impact.
3. The owner's "how often does this dependency breakdown happen and what is the impact" becomes a one-row answer per cause.

### Q4. Simple Random Walk

**Status:** Not in production. Standalone script does bootstrap CIs:

```119:141:scripts/statistical-validation.js
function bootstrapCI(data, statFn, { nBoot = 10000, alpha = 0.05 } = {}) {
  ...
  for (let b = 0; b < nBoot; b++) {
    const sample = [];
    for (let i = 0; i < data.length; i++) {
      sample.push(data[Math.floor(Math.random() * data.length)]);
    }
    ...
  }
}
```

**Two distinct applications of random walk we could do:**

**(a) Strategy-level null:** Shuffle our trade entry signals across all valid bars in the historical window. Compute the resulting "random strategy" return distribution. Compare our actual strategy's return to that distribution. If our strategy's return is *not* above the 95th percentile of the random distribution, we don't have edge — we have luck. Today we have ~$39K all-time PF 2.00 — we should know what % of random-entry strategies would have produced > $39K over 598 trades on the same universe. Until we measure this, we don't know whether the engine has edge or whether the recent 3-month flat period is reverting to truth.

**(b) Per-setup null:** For each named setup (`gap_reversal_long`, `ath_breakout`, etc.), test: "do *random* entries with the same hold-time distribution and same ticker universe produce the same win rate?" If yes, that setup has no edge — it's a label on a coin flip.

This is the **single most important test we don't run**. Without it, every calibration is downstream of an unknown.

### Q5. Markov chain on scores/signals

**Status:** Not implemented. We have a "state just changed" bonus (`worker/index.js:3075-3121`) but no transition matrix.

**Concrete applications:**

**(a) Regime transition matrix:** Build P(`regime.combined` at t+1 | `regime.combined` at t) from historical SPY/QQQ daily snapshots. Then "given we're in `LATE_BULL` today, what's P(`EARLY_BEAR` in 5 trading days)?" Drive size/admission off forward-projected regime distribution, not just current label.

**(b) Setup-grade Markov:** For each setup, build P(`Prime` at next signal | `Prime` now, `Prime` last 5). Tells us whether we're in a "Prime cluster" (mean-revert: skip the next one) or "Prime streak" (trend-follow: take all of them).

**(c) Score-band Markov on per-bar ticker score:** Bucket `score` into deciles. Build the transition matrix. Tells us, e.g., "score crossing from D7 → D9 has P(close at D9+ next bar) = 0.62" — actionable trigger.

**(d) Open-trade stage Markov:** We already have stage transitions (`open` → `defend` → `tp_partial`, etc.). Counting these transitions is one SQL query against the trades table. The output is a transition matrix that tells us, e.g., "trades that ever enter `defend` recover to `tp_partial` with P = X." Today we have no such number.

(d) is the smallest and most directly useful. It would change how we treat `defend`-stage trades immediately.

### Q6. EMA cross / ST flip triggers — when do they work, when don't they?

**Status:** PARTIAL — see status table. We flag `had_ema_cross` / `had_st_flip` on trail facts, we compute the global Spearman IC of `ema_cross` / `supertrend` values against `pnl_pct`, and we measure pre-move "alignment accuracy." We do **not** measure:

- "ST flipped at time T at price P; what's the outcome N bars later?" — the literal hit rate of the trigger event.
- Bucketed by VIX, `regime_class`, sector, time-of-day, recent volatility.

The IC we compute is the rank correlation of the *value* of the EMA-cross feature against return. That tells you whether the feature is correlated with returns. It does NOT tell you whether *acting* on a cross event is profitable. Those are different things.

**Missing piece — trigger hit-rate analyzer.** This is the highest-leverage answer to the owner's question and the smallest first PR (see §3 / §4).

---

## 2. The X.com video

Owner shared: `https://x.com/0xMovez/status/2054291302112534982/video/1?s=46`

I can't fetch X video content directly. If the video has specific claims / formulas / takeaways you want this program to adopt, drop them in the PR comments and I'll fold them into the relevant section. From the surrounding context in your message (random walk + Markov + dependency breakdowns), I'm assuming it's standard quant-research framing — that's what this program is built around. If the video proposes something specific I should ingest, name it.

---

## 3. Sequenced research program (smallest blast radius first)

Each S# is one focused PR, scoped so we can measure impact independently. Numbered for cross-reference. **Reading-only items first** — we get evidence before we change live behavior.

### S1 — ST flip / EMA cross trigger hit-rate analyzer ⭐ START HERE

**What:** New script + worker route that, given the existing `trail_5m_facts` table (which already has `had_st_flip`, `had_ema_cross`, `had_squeeze_release`), computes — for every historical ST flip event on every ticker in the universe:

```
trigger event → outcome at +1H, +4H, +1D bars
bucketed by: VIX bucket, regime_class, sector, time-of-day-bucket, ATR-pctile-of-ticker
```

Emit a JSON report:

```json
{
  "st_flip_long_to_short": {
    "ALL": { "n": 4821, "hit_rate_1h": 0.51, "hit_rate_4h": 0.47, "avg_R_1d": +0.08 },
    "by_regime_class": {
      "TRENDING": { "n": 2104, "hit_rate_1h": 0.61, "avg_R_1d": +0.42 },
      "CHOPPY":   { "n": 1809, "hit_rate_1h": 0.42, "avg_R_1d": -0.31 }
    },
    "by_vix": { "low": {...}, "medium": {...}, "high": {...} },
    "by_dow_hour": {...}
  },
  "ema_cross_9_20_up": { ... },
  ...
}
```

**Blast radius:** Zero — read-only analyzer. **Impact:** Directly answers Q6. We learn whether our two most-cited intraday triggers actually work, and in which contexts. Likely outcome: at least one of them turns out to be break-even in CHOPPY, which justifies the chop-regime defensive R-items in PR #203.

**Effort:** Single file in `scripts/` + a thin worker route + a small Insights UI page (optional). Uses existing trail facts — no new instrumentation.

### S2 — Joint conditional probability lattice + cohort lookup

**What:** Extend the calibration aggregator (`worker/index.js:~29387–30167`) so the report has a `cohort_lookup` field that lets you query, given features:

```
features = { setup: "gap_reversal_long", grade: "Prime", regime_class: "CHOPPY", vix_bucket: "medium", sector: "tech" }
→ { n: 14, win_rate: 0.36, avg_R: -0.42, recent_n: 5, recent_win_rate: 0.20 }
```

With a "min sample" filter to suppress over-confident cohorts (e.g. n ≥ 8 before the cohort overrides the marginal prior).

**Blast radius:** Zero behavior change, just new data. **Impact:** Directly answers Q2. Foundation for any future "cohort-aware admission" change. Also fixes the empty `vix_buckets` gap (most trades are silently dropped today because `vix_at_entry` resolution is fragile — S2 should look up VIX via a richer fallback chain).

### S3 — Random walk null on the entire engine + per-setup

**What:** Standalone script (`scripts/random-walk-null.js`) that:

1. Takes the universe of valid entry bars (same liquidity / price / hour constraints we apply live) for the last 90 days.
2. Simulates `K = 10,000` random strategies: same trade *count* as our real engine, random *timing* and random *ticker* selection from the valid pool, same hold-time distribution.
3. Computes the distribution of net PnL / PF / expectancy across the K random strategies.
4. Reports our actual engine's percentile in that distribution.
5. Repeats per-setup (`gap_reversal_long`-only random strategy, `ath_breakout`-only random strategy, etc.).

**Blast radius:** Zero — offline analytics. **Impact:** Directly answers Q4. Tells us whether each setup has real edge or is a label on noise. This is the single most important question we don't currently answer.

### S4 — RSI / phase divergence as a graded LIVE EXIT signal

**What:** Wire the existing `detectSeriesDivergence` into the exit-doctrine path. New exit states:

- `divergence_warn` (1 bar of confirmed bearish div on a long) — log only, don't act.
- `divergence_confirmed` (2 consecutive bars) — tighten trail to last-bar low / breakeven.
- `divergence_persistent` (3+ bars) — `defend` stage; force exit if R < +0.5.

Log every divergence event to `divergence_events` table so S1/S2 can compute its hit rate over time. This is the dependency-breakdown tagging the owner described.

**Blast radius:** Small — additive exit branch, off by default behind `model_config.exits.divergence_enabled`. **Impact:** Directly answers Q1 (turns the existing detector from "entry score nudge" into an active exit signal) AND begins building the dataset that answers Q3 (how often does the dependency break down).

**Sequencing:** Land after S1 so we can compare divergence-exit outcomes to baseline.

### S5 — Open-trade stage Markov chain (lowest-hanging Markov fruit)

**What:** One SQL/D1 query against the closed-trades table that counts every `stage_t → stage_t+1` transition (e.g. `open → tp_partial`, `open → defend`, `defend → tp_full`, `defend → hard_loss_cap`). Emit as a transition matrix in the Insights API.

Use immediately for: when a live open trade enters `defend`, look up P(recover to `tp_full` | currently in `defend` for N bars). Show that probability on the trade detail page. **Don't** auto-act on it yet — first ship the visibility, then decide.

**Blast radius:** Trivial — one query, one new field on existing endpoint. **Impact:** Answers Q5(d), gives the owner an immediate live decision aid ("this defend trade has 12% historical recovery rate — close it" vs "this defend trade has 78% recovery — hold").

### S6 — Regime + score-band Markov

**What:** Per Q5(a)–(c). Build transition matrices for:
- `regime.combined` (daily snapshots) — P(label at t+5d | label at t)
- Per-ticker score deciles — P(decile_t+1 | decile_t)
- Setup-grade clustering — P(Prime at next | Prime now × Prime last 5)

Surface as Insights tiles. Don't auto-act yet — visibility first.

**Blast radius:** Zero behavior, new metrics. **Impact:** Owner-facing situational awareness. Later phases can convert any of these into admission/exit knobs once we trust them.

### S7 — Tail-event tagger + cause attribution

**What:** Per Q3. On every closed losing trade with PnL beyond -2σ of expected, run the cause classifier:
- `divergence_unconfirmed` / `regime_flip_intrabar` / `vix_shock` / `sector_capitulation` / `single_bar_gap` / `event_unknown`.

Aggregate over the 90-day window. The owner's "how often does this dependency breakdown happen and what is the impact" becomes a one-row answer per cause.

**Blast radius:** Zero behavior, additive logging + report field. **Impact:** Lets future calibration target the actual cause family driving the bleed, not just exit-reason buckets.

### S8 — MACD / OBV divergence (extend S4)

**What:** Apply the existing `detectSeriesDivergence` primitive to MACD histogram and OBV. Today we only do RSI and phase. MACD and OBV give different signals (momentum vs. volume confirmation). Three for the price of one in the same exit doctrine.

**Blast radius:** Small. **Impact:** Modest additive — more confirmation paths reduce false positives on divergence-as-exit.

---

## 4. Proposed sequenced rollout

Two soak windows. **Recommend S1 + S2 immediately (read-only, evidence-gathering).** Pause for owner review of S1/S2 reports before any live-behavior change.

| Step | PRs | Soak | Why this order |
|---|---|---|---|
| **Phase 1 — Measure** | S1 (trigger hit-rate analyzer) + S2 (cohort lookup) + R7 from PR #203 (VIX/regime enrichment fix) | 1 cycle | All read-only. Builds the evidence base. Phase 2 can't be honest without these. |
| **Phase 2 — Validate edge** | S3 (random walk null on engine + per-setup) | 1 cycle | Tells us which setups actually have edge. If a setup fails the null, prioritize demoting it in PR #203's R2/R3. |
| **Phase 3 — First active stochastic exit** | S4 (divergence exit, OFF by default, logging only) | 2 cycles | Ships the wiring, logs events, doesn't change behavior. Phase 4 turns it on with cohort context. |
| **Phase 4 — Live signal use** | Turn S4 to active per-cohort (using S2 lookup); S5 (stage Markov on Insights) | 2 cycles | First active use of the new infrastructure. |
| **Phase 5 — Awareness layer** | S6 (regime/score Markov) + S7 (tail-event tagger) | Ongoing | Owner-facing situational awareness. |
| **Phase 6 — Extensions** | S8 (MACD/OBV divergence) | When relevant | Marginal additive. |

---

## 5. How this complements PR #203 (chop-regime defense)

PR #203 (R1–R7) is **defensive**: it stops the bleed by restoring gates that are silently off (R1), adding a weekly DD breaker (R4), adding chop-aware sizing (R3), etc. It works with what we already know.

This program (S1–S8) is **offensive + research**: it produces the evidence needed to know **which** gates and **which** sizings actually work. They share R7 (VIX/regime calibration enrichment) because both need it.

**Suggested unified sequence:**

1. Land PR #203 R1 (smallest defensive — restore VIX ceiling for TT-Core).
2. Land R7 / S2 (calibration enrichment + cohort lookup — read-only).
3. Land S1 (trigger hit-rate analyzer — read-only).
4. **Owner reviews S1 + S2 + R7 reports.** Decisions made here are evidence-based.
5. Land S3 (random walk null) before any setup-level changes.
6. Then R3 (chop size haircut) and R2 (chop block on continuation Prime) with cohort evidence behind them.
7. S4 (divergence exit) ships logging-only, then active.
8. R5 (exit doctrine chop mode) and S5–S7 land last.

---

## 6. Open questions for the owner

1. **The X video** — if it has specific methods you want adopted (e.g. a particular Markov formulation, a specific bootstrap approach, a divergence rule), name them. I can't fetch it from here.
2. **S3 stringency** — for random-walk null, what's the bar? 95th percentile? 99th? If only the 80th, do we still call that "edge"?
3. **S4 default** — should divergence exit ship initially OFF (logging only, manual review) or ON for a small named cohort (e.g. ATH breakout where we already know the WR is bad)?
4. **Compute budget** — S1, S2, S3 all scan historical data. S3 in particular runs 10K simulated strategies. Are we OK running these as nightly cron in the Worker, or do they belong in a separate scheduled job?
5. **Live-acting threshold** — generally, what's the minimum cohort sample size before we let a cohort-conditional probability override the marginal? My default proposal is `n >= 8`. If we want to be more conservative, `n >= 15` cuts coverage but reduces false positives.

---

## 7. What this doc is and isn't

**IS:** A research program scoped to answer the owner's six questions with evidence, not opinion. Each item ships as a single PR. The first three items are read-only.

**IS NOT:** A code change. No live behavior moves with this PR. Choosing to fund S1 + S2 + R7 in parallel is the smallest commitment that starts producing evidence within a cycle.

**Cross-references:**
- `tasks/2026-05-18-chop-regime-defense-diagnostic.md` (defensive R-items 1–7)
- `tasks/may-2026-performance-analysis.md` (May perf + PR #194 calibration source)
- `worker/indicators.js:182` (`detectSeriesDivergence` — the primitive we'd extend in S4/S8)
- `worker/index.js:29387`–`:30167` (calibration aggregator — the target of S2)
- `scripts/statistical-validation.js` (existing bootstrap/shuffle scaffolding — basis for S3)
