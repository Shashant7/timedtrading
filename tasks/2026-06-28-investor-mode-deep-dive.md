---
title: Investor Mode — Deep Dive & Analysis
date: 2026-06-28
status: ANALYSIS (findings + prioritized recommendations; no engine changes in this PR)
author: cloud agent (parallel work while Active Trader July v9 slice runs on pre-prod)
scope: read-only assessment of live Investor Mode (scoring, zones, lifecycle, accuracy loop)
---

# Investor Mode — Deep Dive

The Active Trader engine has had months of rigorous, repeatable backtesting
(July slices, `trades.json`, direction-accuracy, win-rate/PnL deltas per config
iteration). **Investor Mode has not had the equivalent scrutiny.** This is a
read-only deep dive of the *live* investor stack to answer: is it working, can
we measure whether it is working, and where are the gaps?

All numbers below were pulled live on 2026-06-28 from
`https://timed-trading-ingest.shashant.workers.dev` (see
[Reproduce](#reproduce) for the exact commands).

---

## TL;DR

1. **Performance is actually solid.** Live book: **+22.85% total return**,
   **+$22.7k realized**, **60% action-level win rate** (124W / 81L over 205
   closed lot-actions), payoff ratio 1.37. This is a large improvement over the
   **36% WR** documented in the May-2026 improvement plan.
2. **But we cannot *measure* signal accuracy.** The Signal Outcome Ledger has
   logged **73 investor-action signals in 90 days and resolved ZERO of them.**
   Root cause is **not** investor code — it is **queue starvation in the shared
   resolver** (`resolveDueSignals`): ~3,900 perpetually-open `cto_level` rows
   monopolize the oldest-first scan budget, so *every* horizon-based source
   (`investor_action`, `fsd_tactical`, `options_play`) is starved. **This is the
   headline actionable bug.**
3. **The score is technical-only and diverges from analysts on 38% of names.**
   The investor score has zero fundamental/analyst-target input; the live sanity
   sweep flags 38/100 names as "analysts love it, we score it low" (NFLX 2,
   META 11, MSFT 12, AMZN 25). By design — but currently unmeasured and
   unreviewed.
4. **The May-2026 improvement plan was never executed.** None of the proposed
   levers (persistent-loser cooldown, per-entry component logging, regime
   filter) exist in `worker/`. The persistent-loser problem the plan targeted is
   **still live and still bleeding** (ASTS 6 entries / 0 wins / −$1,319; FSLR
   4/0/−$1,051; TSLA 9 entries / 11% WR / −$348).
5. **There is no turnkey investor backtest/accuracy analytic** comparable to the
   trader slice rig. `scripts/backtest-investor.js` is misnamed (it validates
   `htf_score_avg`, not the investor score).

---

## 1. What Investor Mode is (one-paragraph map)

Investor Mode is a **parallel stack** to the Active Trader — it does **not** use
`tt-core-entry.js` / `tt-core-exit.js`. The pieces:

- **Scoring:** `computeInvestorScore()` — `worker/investor.js:198` — a 0-100
  score from 9 technical components (weeklyTrend 25, monthlyTrend 20,
  relativeStrength 20, accumulationSignal 15, trendDurability 10, sectorContext
  10, ichimokuConfirm ±15, momentumHealth ±10/+5, dailySuperTrendBonus +5).
- **Zones:** `detectAccumulationZone()` — `worker/investor.js:1292` — emits
  `zoneType` (`momentum_runner`, `momentum_runner_exhausted`, oversold/support
  branches). (There is no `classifyInvestorZone`.)
- **Stages / kanban:** `classifyInvestorStage()` — `worker/investor.js:1036` —
  `accumulate` / `watch` / `core_hold` / `reduce` / `research_*` / `exited`.
- **Lifecycle:** `runInvestorDailyReplay()` (historical + optional live daily
  eval) and `POST /timed/investor/auto-rebalance` (hourly cron). Capital model
  $100k, ≤15-20 positions, ~5-7% per name.
- **Alerts:** `deriveInvestorAlertAction()` — `worker/alerts.js:744` — verbs
  `MODEL · QUEUE / ON RADAR / REDUCE / WATCH`.
- **Frontend:** `react-app/investor.html` + `investor-panel.js` (kanban) +
  bubble map; reads `/timed/investor/scores`.

---

## 2. Current live performance

### Account (`GET /timed/investor/portfolio`)

| Metric | Value |
|---|---|
| Equity | **$122,851** (on $100k start) |
| Total return | **+22.85%** |
| Realized P&L | **+$23,173** |
| Unrealized P&L | **+$132** (≈ flat) |
| Open positions | 11 |
| Cash | $66,220 |
| Diversification score | 96 (concentration rating GOOD, top-3 37%) |

### Closed-trade record (`GET /timed/ledger/trades?mode=investor&status=closed`)

| Metric | Value |
|---|---|
| Closed lot-actions (with PnL) | 205 |
| Win / Loss | 124 W / 81 L → **60% WR** |
| Sum PnL | **+$22,689** (reconciles with realized above) |
| Avg win / avg loss | +$350 / −$255 → **payoff 1.37** |
| Median trade | +$14 (≈ breakeven; edge is the winner tail) |
| Top 5 winners / bottom 5 losers | +$17,837 / −$4,684 |

> **Caveat:** these 205 rows are **lot/action-level** (BUY/DCA/TRIM/SELL), not
> position-level round-trips. High-`n` names (IESC 16, CDNS 13, ETN 12) are
> DCA/trim sequences, so 60% is an action-level WR and overstates "did the
> thesis pay." A position-level WR view is one of the gaps (see §6).

### Winners vs losers (by ticker, sum PnL)

**Edge (best):** FIX +$6,056 · MTZ +$4,626 · GOOGL +$4,343 (8/8, 100%) ·
ON +$3,461 · AGQ +$2,973 · RIOT +$2,559 · NVDA +$1,010 (88%) · ITT +$953 (9/9).
The engine's edge is **industrials (FIX/MTZ/ITT) + quality large-cap tech
(GOOGL/NVDA/AAPL).**

**Drag (worst):** ASTS −$1,319 (**6 entries, 0 wins**) · BE −$1,097 · FSLR
−$1,051 (**4/0**) · META −$959 · IESC −$852 · ETN −$821 · AVGO −$782 (20% WR) ·
CLS −$647 (**4/0**) · IREN −$350 (**4/0**) · TSLA −$348 (**9 entries, 11% WR**).

---

## 3. Finding: the accuracy feedback loop is dead (HEADLINE BUG)

`GET /timed/admin/signal-outcomes` 90-day summary, by source:

| source | desk | n | resolved | open | win_rate |
|---|---|---:|---:|---:|---:|
| `cto_level` | research | 4418 | **505** | 3913 | 100% |
| **`investor_action`** | **investor** | **73** | **0** | **73** | **null** |
| `fsd_tactical` | research | 40 | 3 | 37 | 66.7% |
| `options_play` | swing | 5 | 0 | 5 | — |
| `vehicle_counterfactual` | swing | 8 | 0 | 8 | — |

**Investor actions are recorded but never graded.** Running the resolver
manually twice (`?run_resolver=1`, the same call the 22:00 UTC cron makes,
`limit: 150`) resolved **62 signals — 100% `cto_level`, 0 investor.**

### Root cause — queue starvation, not investor code

`resolveDueSignals()` (`worker/signal-outcomes.js:382`) scans:

```sql
SELECT * FROM signal_outcomes WHERE status = 'open'
ORDER BY published_at ASC LIMIT 150
```

`cto_level` writes thousands of price-level signals; **3,913 are perpetually
open** and they are the oldest rows, so the oldest-150 window is *always* full of
CTO levels. CTO levels early-resolve only on **target/stop touch** (that is how
505 resolved); horizon-only sources (`investor_action` = "shares", 60-day
horizon, no target/stop) **only resolve when the resolver reaches them while
they are due** — which never happens because the budget is exhausted on CTO
rows first. `fsd_tactical` (3/40) and `options_play` (0/5) are collateral
victims of the same starvation.

**Impact:** we literally cannot answer "did our ACCUMULATE / QUEUE calls beat the
market over 60 days?" — the investor analog of the trader's `direction_accuracy`.
The data is being captured and then discarded by neglect.

### Recommended fix (P0)

Make resolution **fair across sources** in `resolveDueSignals`. Options (any one
works; first is simplest):

- **Process due signals first**, e.g. add `WHERE status='open' AND (expiry_ts>0 OR horizon_days>0)` ordering by *due time* `ASC`, and/or a second query pass dedicated to non-`cto_level` sources each run.
- **Skip not-yet-due, no-target rows cheaply** so the LIMIT budget advances past
  the open CTO backlog (don't let perpetually-open levels occupy the scan head).
- **Per-source budget**: reserve N of the 150 for `desk != 'research'`.

This single fix unblocks accuracy measurement for **investor, FSD, and options**
simultaneously. Low risk — it only changes *which* open signals get graded, not
how the engine trades. Pairs with a regression test in
`worker/signal-outcomes.test.js`.

---

## 4. Finding: technical-only score → 38% analyst divergence

`GET /timed/admin/investor/sanity-check` flags **38 of 100** names as
`analyst_loved_we_low` — analyst consensus 4.0-4.3 / 5 (Buy/Strong-Buy) while our
score is research_avoid/research_low. Examples: **NFLX 2, AVAV 5, SPGI 6,
META 11, NOW 11, MSFT 12, AMZN 25, ORCL 25, WMT 27.**

NFLX is the clean illustration (`GET /timed/investor/ticker?ticker=NFLX`):

```
score 2 · stage research_avoid · components:
  weeklyTrend 0, monthlyTrend 0, relativeStrength 2, accumulationSignal 0,
  trendDurability 0, sectorContext 4, ichimokuConfirm 0, momentumHealth -4
```

All trend components are **zero** and RS is bottom-decile — the model sees a
technical downtrend with terrible relative strength, so it (correctly, for a
momentum/trend model) refuses to catch the knife. Analysts rate it Buy on
fundamentals/valuation.

**This is by design** — the score is `weeklyTrend + monthlyTrend + RS +
accumulation + …`, with **no fundamental, valuation, or analyst-target input.**
The open questions:

- Is 38% divergence acceptable, or is the model *systematically avoiding quality
  names on dips* (the exact thing an "investor" horizon should sometimes buy)?
- Should we add a bounded **quality/valuation dimension** (analyst consensus
  distance, FCF/margins already pulled from TwelveData) so a fundamentally strong
  name in a controlled pullback can reach `accumulate` instead of `research_avoid`?

We can't answer this responsibly **until §3 is fixed** and we can see whether the
"we said avoid, analysts said buy" names actually went up or down over 60 days.

---

## 5. Finding: the May-2026 improvement plan was never executed

`tasks/archive/2026-pre-may/phase-c/INVESTOR_WR_IMPROVEMENT_PLAN.md` laid out 7
levers. Grep confirms **none shipped** — `deep_audit_investor_loser_cooldown_*`,
`investor_entry_components`, and `deep_audit_investor_regime_filter` appear
**only in the plan doc**, never in `worker/`. (The `consec_losses` / reentry-
throttle machinery that *does* exist is **trader-only**:
`worker/phase-c-loops.js`, `worker/pipeline/tt-core-entry.js:798`.)

The plan's #1 lever — **persistent-loser cooldown** — is still clearly needed.
Live evidence of "re-enter the same broken name with no negative feedback":

| ticker | entries | wins | WR | sum PnL |
|---|---:|---:|---:|---:|
| ASTS | 6 | 0 | 0% | −$1,319 |
| FSLR | 4 | 0 | 0% | −$1,051 |
| CLS | 4 | 0 | 0% | −$647 |
| IREN | 4 | 0 | 0% | −$350 |
| TSLA | 9 | 1 | 11% | −$348 |

A 2-consecutive-loss cooldown gate would have cut the tail entries on every one
of these. Note WR improved to 60% anyway (likely the live book was reseeded after
May via `replace-live-investor-from-preprod.mjs`), so this is now an
*optimization*, not a rescue.

---

## 6. Finding: no turnkey investor backtest/accuracy analytic

What exists for the trader has **no investor equivalent**:

| Trader has | Investor equivalent |
|---|---|
| `scripts/monthly-slice.sh` → `trades.json` per config iter | `full-backtest.sh --sequence` exists but emits portfolio P&L, not per-signal hit-rate |
| `direction_accuracy` table + per-day report | **none** for accumulate/QUEUE calls |
| `data/trade-analysis/*/report.md` per run | **none** |
| `scripts/backtest-*.js` | `scripts/backtest-investor.js` is **misnamed** — validates `trail_5m_facts.htf_score_avg`, not investor score |

Closest existing pieces: `scripts/forensic-investor-dry-run.mjs` (score/stage on
a 14-ticker cohort, no position sim) and the Signal Outcome Ledger (broken per
§3). There is **no** "did zone X / score-bucket Y beat SPY over 60d" report.

---

## 7. Score & zone distribution (context, 287 tickers)

| Stage | n | | zoneType | n |
|---|---:|---|---|---:|
| watch | 115 | | monthly_trend_bullish | 89 |
| research_avoid | 88 | | **momentum_runner_exhausted** | **72** |
| research_low | 42 | | none | 57 |
| research_on_watch | 32 | | weekly_deeply_oversold | 19 |
| **accumulate** | **10** | | weekly_ema_reclaim | 16 |

Score median 43, mean 40.7, only **1 name ≥80**, 10 in `accumulate`. With market
health 73 (RISK_ON) and **25% of the universe flagged
`momentum_runner_exhausted`**, the engine is appropriately cautious in an
extended tape — few fresh buy signals, consistent with the near-flat unrealized
on the current book.

---

## 8. Prioritized recommendations

| Pri | Item | Why | Effort |
|---|---|---|---|
| **P0** | **Fix resolver starvation** (`resolveDueSignals` fair scheduling) + regression test | Unblocks accuracy measurement for investor + FSD + options at once; pure infra, no trade-behavior change | small (~30-60 LOC + test) |
| **P1** | **Investor accuracy report**: once signals resolve, "ACCUMULATE/QUEUE forward return vs SPY by `zoneType` and score bucket" | The actual answer to "is Investor Mode's *signal* good," parallel to trader direction-accuracy | small once P0 lands |
| **P1** | **Per-entry component logging** (`investor_entry_components`) | Enables winner/loser component forensics (plan Lever 3); answers "do losers have inflated accumulationSignal compensating for weak trend?" | medium (table + write hook) |
| **P2** | **Persistent-loser cooldown** (plan Lever 1) | ASTS/FSLR/CLS/IREN/TSLA evidence; saves est. $2-4k of tail losses | small (~50 LOC + test) |
| **P2** | **Run a July investor slice** alongside the trader v9 slice | Apples-to-apples on the same period we're tuning the trader on | medium (uses existing `--sequence`) |
| **P2** | **Decide the analyst-divergence question** | Either document "technical by design" or add a bounded quality/valuation dimension; needs P0 data first | analysis |
| **P3** | **Rename/replace** `scripts/backtest-investor.js` | It does not backtest the investor score; the name is a trap | trivial |

**Suggested sequence:** P0 (resolver) → let it bake ~1 cron cycle → P1 accuracy
report (now has data) → decide P2 levers from the evidence. Everything downstream
is gated on P0, so it should go first.

---

## Reproduce

```bash
BASE="https://timed-trading-ingest.shashant.workers.dev"
K="$TIMED_TRADING_API_KEY"

# Performance
curl -s "$BASE/timed/investor/portfolio?key=$K"
curl -s "$BASE/timed/ledger/trades?mode=investor&status=closed&limit=500&key=$K"

# Scoring / zones / market health
curl -s "$BASE/timed/investor/scores?key=$K"
curl -s "$BASE/timed/investor/market-health?key=$K"

# Anomalies (analyst divergence)
curl -s "$BASE/timed/admin/investor/sanity-check?key=$K"

# Accuracy loop (the broken part)
curl -s "$BASE/timed/admin/signal-outcomes?key=$K"          # summary by source
curl -s "$BASE/timed/admin/signal-outcomes?key=$K&run_resolver=1"  # observe 100% cto_level
```

Key source files: `worker/investor.js` (score/zone/stage),
`worker/signal-outcomes.js` (the starved resolver — §3),
`worker/alerts.js` (alert verbs),
`tasks/archive/2026-pre-may/phase-c/INVESTOR_WR_IMPROVEMENT_PLAN.md` (the
unexecuted plan).
