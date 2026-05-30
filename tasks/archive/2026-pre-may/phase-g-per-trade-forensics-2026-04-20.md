# Phase G.0 — Per-Trade Forensic Deep-Dive (prerequisite to all refinements)

**Date**: 2026-04-20
**Status**: Planning (v6 continuous-slice running; forensics tooling building in parallel)

## Directive

> "Before kicking off applying refinements, we may want to analyze each
> trade, from setup to entry to exit to post exit, against all of our
> indicators, rules, config, cohort, etc and get a true and precise
> sense of what refinements to make. This is additive and a part of
> analyzing the Saty ATR levels and how to best use our MTF readings
> to make better judgement calls related to entry and exit."

## Why this matters

Every refinement we've shipped (T6A, Phase-E.1..3, Phase-F) was tuned
from **aggregate patterns** — cohort means, median MFE, clear-loser %.
That got us from +147 % → +227 %, but we're now in the regime where
**which specific bar triggered, which indicator crossed, what MFE was
left on the table** matters more than any further aggregate tuning.

If we want ATR Levels, MTF signals, or any cohort-level rule to add
another 30-50 pp of PnL, we need to know:

1. **At entry**: which indicators were already pointing the "right" way
   and which were fighting — did we enter when 4H ST flipped bull but
   Daily ST was still bear?
2. **During the trade**: which MTF signal FIRST called the top / bottom?
   E.g., did 30m RSI exit overbought 2 hours before TP1? Did 1H phase
   osc peak 1 day before our actual trim?
3. **At exit**: how much MFE was left on the table? Exit reason vs
   optimal exit (reverse-engineered from the next 5 days of candles).
4. **Post-exit**: did the move continue in our direction (we left money
   on table) or reverse (we got out at the right moment)?

The Saty ATR Levels question from the user is a SPECIFIC case of this
general forensics problem: "What would TP1=+0.382, TP2=+0.618, TP3=+1.0
ATR targets have actually hit vs our actual exits?" We can only answer
that with per-trade reconstruction.

## What the forensic report must contain (per trade)

### Section 1: Entry context (what we knew going in)
- **Ticker + direction + entry_ts + entry_price + cohort**
- **Entry engine + path** (tt_pullback / tt_reclaim / tt_momentum / tt_index_etf_swing)
- **Multi-TF indicator snapshot at entry bar**:
  - 10m / 15m / 30m / 1H / 4H / D ST direction (bull / bear / flat)
  - 10m / 15m / 30m / 1H / 4H / D RSI-5 value + zone (oversold/neutral/overbought)
  - Ripster 5/12, 8/9, 34/50 cloud status per TF (above/inCloud/below)
  - Phase oscillator (satyPhase) value per TF + zone (bear_early / bull_mid / etc.)
  - EMA depth per TF (0-10)
  - Daily structure: px, D21, D48, D200, bull_stack, above_e200, slopes
  - Daily RSI-14
- **ATR Level context at entry**:
  - Day (Daily ATR anchor): disp, band, gate status
  - Multiday (Weekly ATR): disp, band, gate, levels_up[], levels_dn[]
  - Swing (Monthly): same
  - Position (Quarterly): same
  - Long-term (Yearly): same
- **Cohort match + active DA overrides** (which rules applied)

### Section 2: Trade lifecycle (what happened)
- **MFE timeline**: max favorable excursion peak ts + magnitude + which TF bar marked it
- **MAE timeline**: max adverse excursion
- **First indicator to flash "peak"**: which MTF indicator *first* pointed to reversal
  (e.g., 15m ST flipped 47 min before our exit; 1H phase peaked 3h before)
- **Trim events**: each TP-hit / giveback / runner event with ts
- **Management engine path**: which exit logic eventually fired

### Section 3: Exit + counterfactual
- **Actual exit**: ts + price + exit_reason + realized pnl
- **Optimal exit reconstruction**: what was the max pnl achievable within
  +7 days of entry at bar close?
- **MFE-vs-exit gap**: how much peak was left on the table
- **Target-ladder check**: did trade reach Multiday +0.236 / +0.382 /
  +0.618 / +1.0 ATR before exit? If so, when?
- **Post-exit 3-day price**: did the move continue in our favor or
  reverse?

### Section 4: Classification tags
Automatic tags per trade (not just WIN/LOSS):
- `clean_winner` — hit TP1+ and exited near MFE
- `leaky_winner` — positive pnl but < 30 % of MFE captured
- `runner_success` — held through multiple trims, big winner
- `runner_give_back` — ran then reversed
- `fakeout_long_loser` — entered at daily structural extension, quick reversal
- `fakeout_short_loser` — same for shorts
- `chop_scratch` — small pnl in either direction, trade never really went anywhere
- `tp_capped` — exit was management-side trim with MFE-vs-exit gap > 30 %
  (candidate for ATR-ladder widening)
- `sl_caught_falling_knife` — loss but hit a deep MAE before cutting
- `pre_event_clipped` — exited via macro/earnings guard at small pnl
- `regime_misalignment` — entered against daily structure AND lost

### Section 5: Cohort rollup
For each cohort × classification combination:
- n, WR, avg pnl, avg MFE, avg MFE-vs-exit gap
- Which classification DOMINATES each cohort (e.g., ETF might be 60%
  chop_scratch, Speculative might be 30% runner_success)

### Section 6: ATR Level pattern discovery (first-class, not afterthought)

For every trade, reconstruct the ATR Level interactions across all 5
horizons (Day / Multiday / Swing / Position / Long-term) and look for
repeatable patterns. Specific questions to answer:

**6a. ATR Levels as support / resistance**
For each trade, collect the ATR Level prices that price interacted with
between entry and exit. A "significant interaction" = price came within
0.1 × horizon-ATR of a level AND reacted (bounced or rejected) within
the next 30 min.

- How often does a +0.382 / +0.618 / +1.0 / +1.618 level act as
  resistance per cohort? (LONG trade peaks at which fib)
- How often does the trigger_up / trigger_dn act as the first real
  test? Does price usually go back to re-test after crossing?
- Which horizon is most "respected" per cohort? (Multiday Weekly vs
  Swing Monthly — user's hypothesis is that +100 Multiday = weekly
  peak; validate with data)

**6b. ATR Level as pullback-entry target**
For each trade, check whether the entry price was near an ATR Level
(within 0.1 × horizon-ATR). Pattern: do trades that enter *at* a
−0.382 Multiday level perform better than those that enter randomly?

- Entry price vs nearest ATR Level by horizon
- Cohort-cross: which cohort benefits most from "ATR-level-aware"
  entry timing?

**6c. ATR Level as peak / exit signal**
For each trade's MFE peak, measure which ATR Level was closest:
- If MFE peak clusters near +0.618 Multiday → that's a TP2 target
- If MFE peak clusters near +1.0 Multiday → validates user's "+100 =
  weekly peak" hypothesis for that cohort
- Distribution of MFE peak vs each horizon's +0.382 / +0.618 / +1.0
  levels, per cohort

**6d. ATR Level exhaustion signal**
For each LOSS trade, was price already at an extended band (EXT_200,
EXT_300) at entry? If yes, was that a predictable fakeout?
- Loss rate by entry-time ATR band, per cohort
- Does the rangeOfATR metric (% of daily ATR consumed) predict exit
  timing?

**6e. Multi-horizon ATR confluence**
When 2+ horizons' key levels cluster within 0.5 % of each other, does
price react more strongly at the confluence?
- E.g., Day +0.618 at $650 + Multiday +0.382 at $651 = strong zone
- Measure: trade peaks near confluence zones vs random levels

**6f. ATR Golden Gate progression**
The computeATRLevels function emits `gate` with entered/completed/progress_pct.
For each trade:
- Did the trade's MFE cross the gate (0.382→0.618) on any horizon?
- If yes, which horizon's gate completion corresponded best with trade exit?

### Section 7: Refinement recommendations (derived)
- Candidate ATR-ladder TP thresholds per cohort (data-driven from 6c)
- Candidate ATR-based entry filters (data-driven from 6d)
- Candidate confluence-based entries (data-driven from 6e)
- Candidate entry-gate adds (e.g., "reject MegaCap when 4H phase ≥ 75 AND daily RSI ≥ 75")
- Candidate exit-rule tightening (e.g., "exit at 15m ST flip bear when pnl ≥ +1.5 %")
- MTF signal hierarchy for each cohort (which indicator to trust first)

## How we collect the data

### What we already have
- **trades.json** per run (entry/exit/pnl/exit_reason/rank/rr/status)
- **block_chain.jsonl** per run (every rejected bar with indicator state)
- **timed_trail** D1 table (snapshot per ticker per 5-min bar during replay,
  has `payload_json` with full tickerData including atr_levels, tf_tech etc.)

### What we need to reconstruct
The `timed_trail` rows are the jackpot. Each row has the full tickerData
payload INCLUDING `atr_levels`, `tf_tech`, `ema_map`, `flags`, etc.

For every trade in v6:
1. Query `timed_trail` rows for `ticker = trade.ticker` with `ts` ranging
   from `entry_ts - 1hour` → `exit_ts + 3 days`
2. Parse `payload_json` at entry_ts, at each trim_ts, at exit_ts, and at
   every +30min interval in between
3. Build the per-trade forensic record described above

### Tooling to build (before v6 finishes)

**`scripts/phase-g-trade-forensics.py`**:
- Input: `run_id` (e.g., phase-f-continuous-v6)
- Output: `data/trade-analysis/<run_id>/forensics/<trade_id>.json`
- Aggregate: `data/trade-analysis/<run_id>/forensics/summary.md`

Uses:
- `GET /timed/admin/runs/trades?run_id=...` — trades list
- `GET /timed/admin/timed-trail?ticker=...&start=...&end=...` — per-bar
  snapshots (need to verify this endpoint exists; may need to add one)
- Replay cached daily candles for post-exit price reconstruction

## Order of operations (revised)

1. **v6 continues running** (currently day 87/210, ETA ~60 min)
2. **While v6 runs**: build `phase-g-trade-forensics.py` scaffolding
3. **v6 finishes** → run forensics on v6 trades (~150 trades expected)
4. **Read the report** — user + agent review the classification tags,
   MFE gaps, per-cohort leaks
5. **Only then** design Phase-G refinements based on evidence:
   - ATR ladder TP levels → from the actual Multiday-ATR bands v6 trades hit
   - MTF signal hierarchy → from which indicator first called each trade's peak
   - Cohort-specific rules → from the classification rollup
6. **Apply refinements** + validate on targeted dates first
7. **v7 40-ticker validation**, then v8 215-ticker full universe

## Non-goals

- No code changes to the trading worker in Phase-G.0 — pure analysis
- No refinements until the forensic evidence is in hand
- No tuning on holdout months (Mar/Apr) during forensics; use training
  only

## Risks + mitigations

- `timed_trail` might not have full MTF snapshots for every bar — need
  to verify payload shape before trusting it. Mitigation: first step of
  forensic script is a schema check on a sample trade.
- The forensic report might be too dense to act on manually — mitigation:
  emit a ranked "top 20 candidate refinements" at the end based on the
  classification tags, not just the raw per-trade dump.
- ATR Levels on Multiday (Weekly anchor) might be dominated by the noise
  of the weekly bar (which can be wide) — mitigation: the forensic report
  computes the DISTRIBUTION of Multiday +1.0 hits across all trades by
  cohort, so we see if "+100 = weekly peak" is actually a statistical
  ceiling or just one possible outcome among many.
