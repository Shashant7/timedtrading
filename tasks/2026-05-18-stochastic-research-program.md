# 2026-05-18 — Stochastic methods audit + research program

**Question from owner:** "Have we tried Stochastic Methods? Specifically: (1) dependencies (e.g. RSI/price divergence as an exit signal), (2) long-term conditional probabilities (by ticker, universe, regime, recency), (3) extremes / dependency breakdown, (4) Simple Random Walk, (5) Markov chains on scores/signals, (6) Have we truly looked at EMA cross / ST flip triggers against context to know when they work?"

This document is the honest audit + sequenced research program. Like the chop-regime diagnostic (`tasks/2026-05-18-chop-regime-defense-diagnostic.md`), it ships as a **planning artifact** — no live engine code is changed by this PR. Owner picks which items to fund as scoped follow-up PRs.

The companion chop-regime doc is **defensive** (stop the bleed). This doc is **offensive** (find new edge through quant methods).

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
