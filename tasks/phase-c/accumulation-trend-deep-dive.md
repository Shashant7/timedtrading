# Phase C — Trend-Hold Accumulation/Trend Deep Dive (Forensics)

**Generated:** 2026-05-08T20:12:40Z by `scripts/forensic-timeline.js`
**Sample:** 50 Trend-Hold-candidate tickers (from cohort segmentation, gated on weekly EMA-21 break streak ≤ 2).
**Window:** 2025-07-01 → 2026-05-08 (daily candle cache truncates per-ticker at ~2026-04-17).

Per-inflection snapshots use **closes only** (per user direction): trend status flips only on a bar close crossing the level, never on intra-bar wicks. Three close-discipline trend filters are stacked:

1. **Weekly EMA-21** (macro / structural)  — slow filter
2. **Daily 5/12 EMA cloud** (`above` = close above max(EMA-5,EMA-12); `below` = close under min; `inside` = between them)  — fast confirm
3. **4H EMA-21**  — tactical confirm

Plus daily/weekly SuperTrend (10,3), monthly SuperTrend, daily/weekly TD9 setup count, daily/weekly RSI-14, and a derived Fair-Value (`ttm_eps × forward P/E`) per inflection.

Legend: `↑` close above level · `↓` close below level · `~` inside cloud · `b-N`/`s-N` = TD9 buy/sell setup count N (sell-9 = bullish exhaustion warning, buy-9 = bearish exhaustion warning) · `D` discount FV / `F` fair / `P` premium.

## Headline patterns across the Trend-Hold candidate set

Sample: **50** tickers (CLEAN=8, RESILIENT=42).

### Trend filter agreement (close-discipline) at key inflections

| inflection | n | wk EMA-21 ↑ | dly 5/12 ↑ | dly EMA-21 ↑ | 4H EMA-21 ↑ | TD9-D sell-9 | TD9-W sell-9 | RSI-D ≥ 70 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **entry_oracle** | 50 | 96% | 54% | 92% | 76% | — | — | — |
| **peak**         | 50 | 100% | 100% | 100% | 100% | 40% | 24% | 52% |
| **exit_window**  | 50 | 98% | 82% | 84% | — | — | — | — |

### Sector + EPS growth distribution

- **Sectors:** Industrials (18), Technology (14), unknown (5), Basic Materials (4), Energy (3), Communication Services (2), Healthcare (2), Financial Services (1), Consumer Defensive (1)
- **EPS growth class (today):** positive (14), explosive (10), strong (10), exploding (9), declining (6), unknown (1)

### Fair-Value class at oracle entry vs peak (derived: ttm_eps × forward P/E)

- At entry: fair (14), premium (13), discount (13)
- At peak:  premium (36), discount (3), fair (1)

### System engagement on the candidate set

- Tickers traded by the system in the window: **39 / 50** (78%)
- Total system trades on the candidate set: **195** (mean 3.9 per ticker, max 16)

## Capture summary across the candidate set

- Tickers **never traded** in the window: **11 / 50** — pure missed opportunity.
- Tickers traded but **severely under-captured** (< 25% of oracle move): **39 / 50**
- Tickers traded and **partially captured** (25–50%): **0 / 50**
- Tickers **reasonably captured** (≥ 50% of oracle): **0 / 50**

- Σ oracle return across the cohort: **9234%**.
- Σ system pnl% extracted: **193%** ⇒ overall capture **2.1%**.
- Restricted to traded tickers (n=39): Σ oracle 7839%, Σ system 193% ⇒ capture 2.5%.

## Exit-reason distribution on the candidate set

Total closed system trades on the 50 TH-candidate tickers: **195**.

| exit reason | n | % of trades | avg pnl % | avg mfe % | avg mae % | giveback (mfe − pnl) |
|---|---:|---:|---:|---:|---:|---:|
| `doctrine_force_exit` | 20 | 10.3% | -1.99 | 0.32 | -2.15 | 2.30 |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 19 | 9.7% | 0.86 | 4.92 | -0.82 | 4.06 |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | 19 | 9.7% | 0.86 | 6.82 | -1.16 | 5.97 |
| `TP_FULL` | 16 | 8.2% | 3.71 | 7.73 | -0.53 | 4.03 |
| `ST_FLIP_4H_CLOSE` | 13 | 6.7% | 4.59 | 9.97 | -0.44 | 5.38 |
| `HARD_FUSE_RSI_EXTREME` | 11 | 5.6% | 4.11 | 7.53 | -0.29 | 3.41 |
| `sl_breached` | 9 | 4.6% | 5.46 | 13.00 | -0.53 | 7.54 |
| `max_loss_time_scaled` | 9 | 4.6% | -1.18 | 1.76 | -2.24 | 2.94 |
| `mfe_decay_structural_flatten` | 8 | 4.1% | 2.09 | 7.08 | -0.49 | 4.99 |
| `thesis_flip_htf` | 8 | 4.1% | -0.71 | 1.29 | -1.42 | 2.00 |
| `atr_week_618_full_exit` | 8 | 4.1% | 1.75 | 4.66 | -0.31 | 2.90 |
| `peak_lock_ema12_deep_break` | 7 | 3.6% | 3.31 | 11.08 | -0.39 | 7.78 |
| `phase_i_mfe_fast_cut_2h` | 5 | 2.6% | -1.53 | 0.12 | -1.54 | 1.66 |
| `max_loss` | 5 | 2.6% | -1.67 | 1.92 | -2.86 | 3.59 |
| `HARD_LOSS_CAP` | 4 | 2.1% | -5.42 | 0.17 | -5.42 | 5.59 |
| `PROFIT_GIVEBACK_COOLING_HOLD` | 4 | 2.1% | 1.62 | 5.38 | -0.69 | 3.77 |
| `atr_day_adverse_382_cut` | 4 | 2.1% | -0.94 | 0.93 | -1.80 | 1.86 |
| `phase_i_mfe_fast_cut_zero_mfe` | 3 | 1.5% | -1.55 | 0.00 | -1.55 | 1.55 |
| `tape_capitulation_force_exit` | 3 | 1.5% | -1.31 | 1.77 | -2.00 | 3.08 |
| `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | 3 | 1.5% | 0.02 | 0.84 | -0.98 | 0.82 |
| `SOFT_FUSE_RSI_CONFIRMED` | 2 | 1.0% | 2.91 | 4.37 | -0.06 | 1.46 |
| `runner_drawdown_cap` | 2 | 1.0% | -0.71 | 2.83 | -2.54 | 3.53 |
| `PRE_EARNINGS_FORCE_EXIT` | 2 | 1.0% | -2.21 | 0.00 | -0.77 | 2.21 |
| `phase_i_mfe_cut_4h` | 2 | 1.0% | -1.56 | 0.39 | -1.56 | 1.96 |
| `v13_hard_pnl_floor` | 1 | 0.5% | -6.46 | 0.32 | -6.46 | 6.78 |
| `SMART_RUNNER_TD_EXHAUSTION_RUNNER` | 1 | 0.5% | -0.85 | 1.37 | -2.39 | 2.22 |
| `h4_regime_flip_exit` | 1 | 0.5% | -0.53 | 0.83 | -0.53 | 1.36 |
| `ripster_72_89_1h_structural_break` | 1 | 0.5% | 1.38 | 1.38 | -0.02 | 0.00 |
| `hard_max_hold_504h` | 1 | 0.5% | 4.30 | 10.54 | -1.58 | 6.24 |
| `eod_trimmed_underwater_flatten` | 1 | 0.5% | 0.12 | 1.03 | -1.64 | 0.91 |
| `stagnant_no_commitment` | 1 | 0.5% | 0.59 | 2.29 | -0.35 | 1.70 |
| `PROFIT_GIVEBACK` | 1 | 0.5% | 0.96 | 5.04 | 0.00 | 4.08 |
| `max_loss_time_scaled_momentum_buffered` | 1 | 0.5% | -3.28 | 0.60 | -3.28 | 3.88 |

Highest-giveback exit reasons (avg `mfe% − pnl%`) on this cohort indicate where the engine is leaving the most money on the table when the trend was clean.

## Counter-examples — tickers expected by intuition but excluded by the gate

User-named names that did NOT make the Trend-Hold cohort because they had real multi-week trend breaks during the window. Useful to confirm the gate is not over-fitting to "obvious" winners.

| ticker | cohort | return % | max DD % | wk EMA-21 streak | dly 5/12 streak | sys trades | capture % | dominant exit reason |
|---|---|---:|---:|---:|---:|---:|---:|---|
| AMD | WINNERS | 104.5 | -27.8 | 8 | 12 | 6 | 16% | `sl_breached` (1) |
| AEHR | WINNERS | 494.3 | -42.3 | 3 | 16 | 9 | 6% | `PROFIT_GIVEBACK_STAGE_HOLD` (2) |
| NVDA | WINNERS | 31.6 | -20.2 | 6 | 12 | 7 | 10% | `thesis_flip_htf` (2) |
| AMZN | MODERATE | 13.7 | -21.7 | 9 | 18 | 5 | -32% | `stagnant_no_commitment` (1) |
| TSLA | WINNERS | 33.2 | -29.9 | 10 | 18 | 1 | 13% | `TP_FULL` (1) |
| NFLX | LOSERS | -24.8 | -41.5 | 14 | 18 | 2 | n/a | `SOFT_FUSE_RSI_CONFIRMED` (1) |
| META | STAGNANT | -4.3 | -33.5 | 10 | 24 | 3 | n/a | `sl_breached` (1) |
| AVGO | WINNERS | 53.6 | -28.9 | 11 | 20 | 3 | -4% | `atr_day_adverse_382_cut` (2) |
| PLTR | MODERATE | 12.0 | -38.2 | 14 | 16 | 3 | 13% | `peak_lock_ema12_deep_break` (1) |
| PANW | LOSERS | -15.1 | -36.0 | 22 | 18 | 2 | n/a | `thesis_flip_htf` (1) |

Key: AMD streak=8 (8 consecutive weekly closes below EMA-21) — looks "obvious" in hindsight but the trend WAS broken; correct exclusion. NFLX, META, PLTR, AMZN all show 9-22-week streaks → not Trend-Hold candidates over this window. AEHR streak=3 (just outside the gate) is the closest near-miss; would have qualified at streak ≤ 3.

## Tuning recommendations for the Trend-Hold module

Concrete thresholds for `worker/trend-hold.js` (Phase 2 implementation), derived from the patterns above.

### 1. Promotion gates (should fire when these are ALL true)

At oracle entry across the 50 TH candidates:
- **96%** had close ≥ weekly EMA-21
- **92%** had close ≥ daily EMA-21
- **76%** had close ≥ 4H EMA-21
- only **54%** had close above the daily 5/12 cloud (many were inside the cloud during accumulation — DO NOT gate promotion on this).

**Recommended Trend-Hold promotion gates:**

```js
// All of:
shouldPromoteToTrendHold = trade =>
  trade.mfe_pct >= 5 &&                                   // proves the setup worked
  weeklyClose >= weeklyEma21 &&                           // macro trend intact (CLOSES ONLY)
  dailyClose >= dailyEma21 &&                             // daily trend intact
  fourHClose >= fourHEma21 &&                             // tactical trend intact
  monthlySupertrendDir === 1 &&                           // monthly bull confirms
  weeklySupertrendDir === 1 &&                            // weekly bull confirms
  weeklyTd9SetupCount < 9 &&                              // not at weekly exhaustion
  weeklyEma21BreakStreakLast20wk <= 2 &&                  // recent macro discipline
  sectorRating !== "underweight" &&                       // tailwind/neutral required
  daysToEarnings >= 3 &&                                  // not pre-earnings
  trade.trimmed_pct < 0.5;                                // not already mostly trimmed
```

### 2. Demotion gates (any one fires → drop back to Active Trader management)

At the window-exit snapshot **98% still had weekly close ≥ EMA-21** — the macro filter is the strong demotion signal. Daily-cloud breaks (82% above at exit) are NOT demotion signals on their own; they're DCA triggers.

**Recommended Trend-Hold demotion gates:**

```js
shouldDemoteFromTrendHold = trade =>
  // PRIMARY: macro trend break — weekly close below EMA-21 for 2+ weeks running
  consecutiveWeeklyClosesBelowEma21 >= 2 ||
  // OR: daily AND 4H AND weekly all flip — capitulation cascade
  (dailyClose < dailyEma21 && fourHClose < fourHEma21 &&
   weeklyClose < weeklyEma21 && weeklySupertrendDir === -1) ||
  // OR: weekly TD9 sell-9 setup print (exhaustion) — confirms top
  (weeklyTd9SetupCount >= 9 && weeklyTd9Direction === "sell") ||
  // OR: macro shock — SPY -3% in a single session OR VIX > 35
  spySingleDayDrop <= -3 || vixLevel >= 35;
```

### 3. DCA-the-dip trigger (RESILIENT_TREND only — high-vol mega-runners)

Across the 42 RESILIENT_TREND tickers the daily 5/12 cloud was broken for a median of ~14 trading days during the run. Each cloud-reclaim was a textbook DCA signal — NOT an exit.

**Recommended DCA trigger (overrides full-exit on giveback):**

```js
shouldDcaPullback = trade =>
  trade.trend_hold_state === "active" &&
  trade.flavor === "RESILIENT_TREND" &&
  weeklyClose >= weeklyEma21 &&                           // macro intact
  prevDailyCloseBelowCloud && currentDailyCloseAboveCloud && // cloud reclaim
  trade.shares < trade.target_shares &&                   // room to add
  (currentClose / trade.avg_entry - 1) >= -0.10;          // pullback ≤ -10%
```

For CLEAN_TREND (low-vol grinders) the daily-cloud break is rare — keep tighter trail; no DCA path needed.

### 4. Suppress premature-exit doctrines while in Trend-Hold

Exit reasons firing most on the candidate set (with average pnl% they locked in):

| reason | n | avg pnl% | avg mfe% | giveback |
|---|---:|---:|---:|---:|
| `doctrine_force_exit` | 20 | -1.99 | 0.32 | 2.30 |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 19 | 0.86 | 4.92 | 4.06 |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | 19 | 0.86 | 6.82 | 5.97 |
| `TP_FULL` | 16 | 3.71 | 7.73 | 4.03 |
| `ST_FLIP_4H_CLOSE` | 13 | 4.59 | 9.97 | 5.38 |
| `HARD_FUSE_RSI_EXTREME` | 11 | 4.11 | 7.53 | 3.41 |

**While `trade_hold_state === "active"`, the following doctrines should NOT fire:**

- `HARD_FUSE_RSI_EXTREME` — overrides on RSI ≥ 80 even when trend is intact (saw 1948% SNDK ride exited 11x by this gate).
- `PROFIT_GIVEBACK_STAGE_HOLD` — locks in 0–2% on what becomes 50%+ moves.
- `SMART_RUNNER_SUPPORT_BREAK_CLOUD` — closing below daily 5/12 cloud is a DCA trigger, not an exit, when weekly EMA-21 holds.
- `mfe_decay_structural_flatten` — only fires on trades that consolidate; consolidation is normal in RESILIENT_TREND.
- `doctrine_giveback` / `fresh_failure` / `stagnant_exit` — all time-based; Trend-Hold is structural, not time-based.

**Allowed exits while in Trend-Hold:** weekly EMA-21 close-break, weekly TD9 sell-9, monthly SuperTrend bear flip, macro shock (SPY -3% / VIX > 35). Everything else routes through the demotion path → drop back to Active Trader management profile.

### 5. Simultaneous Trend-Hold position cap

Per user direction, start cap at **5–7** but make it tunable via `deep_audit_trend_hold_max_positions` in `model_config`.

Recommended sizing:
- Max 6 simultaneous Trend-Hold positions, target 5% of equity each (max 30% locked).
- When a 7th candidate qualifies, drop the lowest-MFE active TH position back to Active Trader management (so capacity is allocated to fresh runners).
- Combined with Active Trader cap (~50% of equity) this keeps cash buffer ≥ 20%.

---

## Per-ticker timelines

## SNDK — RESILIENT_TREND · Technology · return 1948.5% · max DD -31.3%

**Fundamentals (today):** P/E TTM 47.69 · Fwd 8.3 · PEG -0.17 · FV $1115.94 (premium) · current $1560.86 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 10

**Should-have-held diagnosis:** 11 closed trades · Σ pnl% 32.9 on 1948% oracle return → capture 2% · premature exits 8/11 · stopped-out 2 · TP-hit 1 · dominant exit: HARD_FUSE_RSI_EXTREME (3/11)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 44.96 | 0 | ↑ | ↓ | ↑ | ↓ | 57.27 | 47.11 | b-2 | s-10 | bull | bull | · | -2.49 | · | — |
| +5% | 2025-08-26 | 47.35 | 5 | ↑ | ↑ | ↑ | ↑ | 60.83 | 57.28 | s-4 | s-3 | bull | bull | · | -0.08 | · | tt_gap_reversal_long · Prime · 10.87% · exit:HARD_FUSE_RSI_EXTREME |
| +15% | 2025-08-29 | 52.47 | 15 | ↑ | ↑ | ↑ | ↑ | 72.76 | 57.28 | s-7 | s-3 | bull | bull | · | -0.08 | · | tt_gap_reversal_long · Prime · 10.87% · exit:HARD_FUSE_RSI_EXTREME |
| +30% | 2025-09-04 | 62.50 | 30 | ↑ | ↑ | ↑ | ↑ | 81.51 | 70.5 | s-10 | s-4 | bull | bull | · | -0.08 | · | — |
| +50% | 2025-09-05 | 68.55 | 50 | ↑ | ↑ | ↑ | ↑ | 85.32 | 70.5 | s-11 | s-4 | bull | bull | · | -0.08 | · | — |
| +75% | 2025-09-11 | 84.30 | 75 | ↑ | ↑ | ↑ | ↑ | 91.33 | 78.38 | s-15 | s-5 | bull | bull | · | -0.08 | · | tt_gap_reversal_long · Prime · -0.75% · exit:HARD_FUSE_RSI_EXTREME |
| +100% | 2025-09-15 | 90.09 | 100 | ↑ | ↑ | ↑ | ↑ | 92.63 | 82.88 | s-17 | s-6 | bull | bull | · | -0.08 | · | tt_gap_reversal_long · Prime · 8.15% · exit:sl_breached |
| peak | 2026-04-13 | 952.50 | 2018.55 | ↑ | ↑ | ↑ | ↑ | 74.15 | 78.38 | s-8 | s-3 | bull | bull | bull | 61.53 | 15.48× P | — |
| exit_window | 2026-04-17 | 920.99 | 1948.47 | ↑ | ↑ | ↑ | ↑ | 67.66 | 78.38 | b-1 | s-3 | bull | bull | bull | 61.53 | 14.968× P | — |

### System trades on SNDK during window (n=11)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-18 | 2025-08-19 | LONG | tt_range_reversal_long | Prime | ? | ? | 93 | 4.18 | 2.24 | -1.79 | 1.1 | 0.23% | PROFIT_GIVEBACK_STAGE_HOLD |
| 2 | 2025-08-27 | 2025-09-04 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.67 | 19.84 | -0.26 | 7.8 | 10.87% | HARD_FUSE_RSI_EXTREME |
| 3 | 2025-09-08 | 2025-09-08 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 1.99 | 0 | -1.31 | 0 | -1.25% | HARD_FUSE_RSI_EXTREME |
| 4 | 2025-09-11 | 2025-09-11 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 1.45 | 0 | -0.75 | 0 | -0.75% | HARD_FUSE_RSI_EXTREME |
| 5 | 2025-09-15 | 2025-09-24 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 1.57 | 22.89 | -0.41 | 9.1 | 8.15% | sl_breached |
| 6 | 2025-09-26 | 2025-10-01 | LONG | tt_n_test_support | Prime | ? | ? | 100 | 3.07 | 26.05 | -1.7 | 5.1 | 14.63% | TP_FULL |
| 7 | 2025-10-23 | 2025-10-28 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.17 | 11.74 | 0 | 4.8 | 1.33% | mfe_decay_structural_flatten |
| 8 | 2025-11-17 | 2025-11-17 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.52 | 0 | -4.92 | 0.2 | -4.92% | HARD_LOSS_CAP |
| 9 | 2026-01-06 | 2026-01-08 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 3.08 | 11.33 | -0.84 | 2 | 2.40% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 10 | 2026-02-02 | 2026-02-04 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 98 | 2.08 | 5.53 | -2.43 | 1.8 | 0.35% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 11 | 2026-02-20 | 2026-02-24 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 92 | 7.56 | 8.28 | 0 | 3.9 | 1.84% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |

## LITE — RESILIENT_TREND · Technology · return 877.2% · max DD -28.7%

**Fundamentals (today):** P/E TTM 159.86 · Fwd 50.71 · PEG -0.71 · FV $730.26 (premium) · current $903.38 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 8

**Should-have-held diagnosis:** 4 closed trades · Σ pnl% 3.3 on 877% oracle return → capture 0% · premature exits 4/4 · stopped-out 0 · TP-hit 0 · dominant exit: SMART_RUNNER_SUPPORT_BREAK_CLOUD (1/4)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 91.49 | 0 | ↑ | ~ | ↑ | ↑ | 65.63 | 71.08 | b-1 | s-10 | bull | bull | · | 62.38 | 1.467× P | — |
| +5% | 2025-07-15 | 98.14 | 5 | ↑ | ↑ | ↑ | ↓ | 71.76 | 74.93 | s-3 | s-12 | bull | bull | · | 62.38 | 1.573× P | — |
| +15% | 2025-07-28 | 107.17 | 15 | ↑ | ↑ | ↑ | ↑ | 73.85 | 76.57 | s-3 | s-14 | bull | bull | · | 62.38 | 1.718× P | tt_gap_reversal_long · Prime · 2.10% · exit:SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| +30% | 2025-08-12 | 119.66 | 30 | ↑ | ↑ | ↑ | ↑ | 74.53 | 79.26 | s-4 | s-16 | bull | bull | · | 103.96 | 1.151× P | — |
| +50% | 2025-09-04 | 141.91 | 50 | ↑ | ↑ | ↑ | ↑ | 79.12 | 87.11 | s-11 | s-19 | bull | bull | · | 103.96 | 1.365× P | — |
| +75% | 2025-09-10 | 164.88 | 75 | ↑ | ↑ | ↑ | ↑ | 87.76 | 89 | s-15 | s-20 | bull | bull | · | 103.96 | 1.586× P | — |
| +100% | 2025-10-27 | 193.80 | 100 | ↑ | ↑ | ↑ | ↑ | 70.7 | 81.9 | s-3 | s-2 | bull | bull | · | 103.96 | 1.864× P | — |
| peak | 2026-04-10 | 897.30 | 880.76 | ↑ | ↑ | ↑ | ↑ | 64.78 | 80.95 | s-7 | s-11 | bull | bull | bull | 176.99 | 5.07× P | — |
| exit_window | 2026-04-17 | 894.07 | 877.23 | ↑ | ↑ | ↑ | ↑ | 61.86 | 80.55 | s-1 | s-12 | bull | bull | bull | 176.99 | 5.052× P | — |

### System trades on LITE during window (n=4)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-28 | 2025-08-01 | LONG | tt_gap_reversal_long | Prime | ? | ? | 97 | 2.25 | 8.02 | -1.84 | 4 | 2.10% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 2 | 2026-02-06 | 2026-02-13 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.2 | 12.95 | -0.21 | 7 | 3.33% | mfe_decay_structural_flatten |
| 3 | 2026-02-20 | 2026-02-23 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.09 | 0.02 | -1.7 | 2.9 | -1.70% | doctrine_force_exit |
| 4 | 2026-03-19 | 2026-03-20 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 3.21 | 6.03 | -1.89 | 1 | -0.39% | PROFIT_GIVEBACK_STAGE_HOLD |

## BE — RESILIENT_TREND · Industrials · return 839.3% · max DD -45.9%

**Fundamentals (today):** P/E TTM 1707.5 · Fwd 64.83 · PEG -4.88 · FV $· (·) · current $261.05 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 9 closed trades · Σ pnl% 27.6 on 839% oracle return → capture 3% · premature exits 4/9 · stopped-out 3 · TP-hit 0 · dominant exit: PROFIT_GIVEBACK_STAGE_HOLD (2/9)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 22.13 | 0 | ↑ | ↓ | ↑ | ↑ | 53.61 | 59.17 | s-2 | s-8 | bull | bull | · | 25.28 | 0.875× F | — |
| +5% | 2025-07-03 | 24.24 | 5 | ↑ | ↑ | ↑ | ↓ | 61.98 | 59.17 | s-4 | s-8 | bull | bull | · | 25.28 | 0.959× F | — |
| +15% | 2025-07-09 | 28.71 | 15 | ↑ | ↑ | ↑ | ↑ | 74.18 | 61.43 | s-7 | s-9 | bull | bull | · | 25.28 | 1.136× F | — |
| +30% | 2025-07-24 | 33.06 | 30 | ↑ | ↑ | ↑ | ↑ | 75.78 | 73.57 | s-4 | s-11 | bull | bull | · | 25.28 | 1.308× P | — |
| +50% | 2025-07-25 | 34.34 | 50 | ↑ | ↑ | ↑ | ↑ | 77.55 | 73.57 | s-5 | s-11 | bull | bull | · | 25.28 | 1.358× P | — |
| +75% | 2025-08-06 | 38.86 | 75 | ↑ | ↑ | ↑ | ↑ | 78.32 | 75.87 | s-1 | s-13 | bull | bull | · | 35.66 | 1.09× F | — |
| +100% | 2025-08-14 | 45.11 | 100 | ↑ | ↑ | ↑ | ↑ | 80.95 | 82.1 | s-7 | s-14 | bull | bull | · | 35.66 | 1.265× P | tt_gap_reversal_long · Prime · 6.03% · exit:ST_FLIP_4H_CLOSE |
| peak | 2026-04-14 | 219.03 | 889.74 | ↑ | ↑ | ↑ | ↑ | 74.35 | 71.18 | s-8 | s-3 | bull | bull | bull | 49.92 | 4.388× P | — |
| exit_window | 2026-04-17 | 207.86 | 839.27 | ↑ | ↑ | ↑ | ↑ | 68.32 | 71.18 | s-11 | s-3 | bull | bull | bull | 49.92 | 4.164× P | — |

### System trades on BE during window (n=9)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-12 | 2025-08-19 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.09 | 15.41 | 0 | 6.8 | 6.03% | ST_FLIP_4H_CLOSE |
| 2 | 2025-08-21 | 2025-09-02 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.59 | 21.48 | -1.68 | 11.9 | 10.40% | sl_breached |
| 3 | 2025-09-11 | 2025-09-12 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.13 | 0.6 | -3.45 | 0.9 | -1.43% | max_loss_time_scaled |
| 4 | 2025-09-16 | 2025-09-18 | LONG | tt_gap_reversal_long | Prime | ? | ? | 93 | 2.74 | 16.05 | 0 | 2.1 | 8.77% | HARD_FUSE_RSI_EXTREME |
| 5 | 2025-11-03 | 2025-11-04 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.76 | 6.77 | -2.41 | 1 | 0.76% | PROFIT_GIVEBACK_STAGE_HOLD |
| 6 | 2026-01-09 | 2026-01-26 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 3.16 | 21.79 | -0.75 | 16.9 | 5.72% | peak_lock_ema12_deep_break |
| 7 | 2026-01-27 | 2026-01-29 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.56 | 10.6 | 0 | 1.9 | 1.75% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 8 | 2026-02-03 | 2026-02-03 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 3.18 | 0 | -4.73 | 0.1 | -4.73% | HARD_LOSS_CAP |
| 9 | 2026-02-24 | 2026-02-26 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 3 | 5.35 | -2.17 | 1.9 | 0.31% | PROFIT_GIVEBACK_STAGE_HOLD |

## SATS — RESILIENT_TREND · Communication Services · return 369.7% · max DD -19.9%

**Fundamentals (today):** P/E TTM 11.86 · Fwd -1073.73 · PEG -1073.73 · FV $· (·) · current $127.05 · EPS growth class: declining

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 7 closed trades · Σ pnl% 6.5 on 370% oracle return → capture 2% · premature exits 0/7 · stopped-out 1 · TP-hit 0 · dominant exit: ST_FLIP_4H_CLOSE (2/7)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 28.36 | 0 | ↑ | ↑ | ↑ | ↑ | 66.65 | 60.81 | s-4 | s-3 | bull | bull | · | 816.03 | 0.035× D | — |
| +5% | 2025-07-03 | 31.36 | 5 | ↑ | ↑ | ↑ | ↑ | 72.26 | 60.81 | s-6 | s-3 | bull | bull | · | 816.03 | 0.038× D | — |
| +15% | 2025-07-08 | 32.66 | 15 | ↑ | ↑ | ↑ | ↑ | 74.48 | 59.72 | s-8 | s-4 | bull | bull | · | 816.03 | 0.04× D | — |
| +30% | 2025-08-26 | 50.87 | 30 | ↑ | ↑ | ↑ | ↑ | 88.05 | 81.66 | s-3 | s-1 | bull | bull | · | 1138.15 | 0.045× D | — |
| +50% | 2025-08-26 | 50.87 | 50 | ↑ | ↑ | ↑ | ↑ | 88.05 | 81.66 | s-3 | s-1 | bull | bull | · | 1138.15 | 0.045× D | — |
| +75% | 2025-08-26 | 50.87 | 75 | ↑ | ↑ | ↑ | ↑ | 88.05 | 81.66 | s-3 | s-1 | bull | bull | · | 1138.15 | 0.045× D | — |
| +100% | 2025-08-27 | 58.76 | 100 | ↑ | ↑ | ↑ | ↑ | 90.7 | 81.66 | s-4 | s-1 | bull | bull | · | 1138.15 | 0.052× D | — |
| peak | 2026-04-17 | 133.21 | 369.71 | ↑ | ↑ | ↑ | ↑ | 64.09 | 73.55 | s-6 | s-3 | bull | bull | bull | 49939.09 | 0.003× D | — |
| exit_window | 2026-04-17 | 133.21 | 369.71 | ↑ | ↑ | ↑ | ↑ | 64.09 | 73.55 | s-6 | s-3 | bull | bull | bull | 49939.09 | 0.003× D | — |

### System trades on SATS during window (n=7)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-09-26 | 2025-09-29 | LONG | tt_n_test_support | Prime | ? | ? | 92 | 4.26 | 0 | -1.76 | 2.9 | -1.76% | phase_i_mfe_fast_cut_zero_mfe |
| 2 | 2025-10-31 | 2025-11-03 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 94 | 3.73 | 0.21 | -0.96 | 2.9 | -0.96% | phase_i_mfe_fast_cut_2h |
| 3 | 2025-12-08 | 2025-12-17 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 93 | 2.62 | 23.96 | -1.51 | 9.1 | 8.38% | ST_FLIP_4H_CLOSE |
| 4 | 2026-01-06 | 2026-01-07 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 93 | 2.88 | 2.49 | -2.47 | 1 | -0.84% | max_loss_time_scaled |
| 5 | 2026-01-09 | 2026-01-16 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.65 | 10.26 | 0 | 7.1 | 2.20% | ST_FLIP_4H_CLOSE |
| 6 | 2026-01-22 | 2026-01-26 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 3.25 | 1.91 | -1.38 | 3.8 | -0.30% | thesis_flip_htf |
| 7 | 2026-04-02 | 2026-04-07 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | CHOPPY | 100 | 2.29 | 4.23 | -1.42 | 5 | -0.24% | tape_capitulation_force_exit |

## SOXL — RESILIENT_TREND · sector? · return 283.2% · max DD -43.5%

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 283% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 24.71 | 0 | ↑ | ↑ | ↑ | ↑ | 69.4 | 66.06 | s-6 | s-10 | bull | bull | · | · | · | — |
| +5% | 2025-07-02 | 26.05 | 5 | ↑ | ↑ | ↑ | ↑ | 73.37 | 66.06 | s-7 | s-10 | bull | bull | · | · | · | — |
| +15% | 2025-08-13 | 29.27 | 15 | ↑ | ↑ | ↑ | ↑ | 66.39 | 64.25 | s-5 | s-1 | bull | bull | · | · | · | — |
| +30% | 2025-09-18 | 33.64 | 30 | ↑ | ↑ | ↑ | ↑ | 75.19 | 70.61 | s-10 | s-6 | bull | bull | · | · | · | — |
| +50% | 2025-10-02 | 39.08 | 50 | ↑ | ↑ | ↑ | ↑ | 82.55 | 75.97 | s-3 | s-8 | bull | bull | · | · | · | — |
| +75% | 2025-10-27 | 46.84 | 75 | ↑ | ↑ | ↑ | ↑ | 65.52 | 77.51 | s-3 | s-12 | bull | bull | · | · | · | — |
| +100% | 2025-12-10 | 49.65 | 100 | ↑ | ↑ | ↑ | ↑ | 64.33 | 58.63 | s-12 | s-2 | bull | bull | · | · | · | — |
| peak | 2026-04-17 | 94.68 | 283.16 | ↑ | ↑ | ↑ | ↑ | 78.51 | 75.37 | s-12 | s-3 | bull | bull | bull | · | · | — |
| exit_window | 2026-04-17 | 94.68 | 283.16 | ↑ | ↑ | ↑ | ↑ | 78.51 | 75.37 | s-12 | s-3 | bull | bull | bull | · | · | — |

> *No system trades on SOXL in the window — pure missed opportunity.*

## MU — RESILIENT_TREND · Technology · return 276.4% · max DD -30.3%

**Fundamentals (today):** P/E TTM 30.33 · Fwd 6.32 · PEG 0.04 · FV $514.4 (premium) · current $745.74 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 276% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 120.89 | 0 | ↑ | ↓ | ↑ | ↑ | 63.9 | 67.45 | b-2 | s-10 | bull | bull | · | 40.68 | 2.972× P | — |
| +5% | 2025-08-12 | 127.75 | 5 | ↑ | ↑ | ↑ | ↑ | 67.85 | 62.04 | s-4 | s-1 | bull | bull | · | 40.68 | 3.14× P | — |
| +15% | 2025-09-10 | 140.00 | 15 | ↑ | ↑ | ↑ | ↑ | 73.79 | 73.76 | s-10 | s-5 | bull | bull | · | 40.68 | 3.441× P | — |
| +30% | 2025-09-12 | 157.23 | 30 | ↑ | ↑ | ↑ | ↑ | 82.31 | 73.76 | s-12 | s-5 | bull | bull | · | 40.68 | 3.865× P | — |
| +50% | 2025-10-01 | 182.15 | 50 | ↑ | ↑ | ↑ | ↑ | 77.83 | 78.03 | s-2 | s-8 | bull | bull | · | 51.11 | 3.564× P | — |
| +75% | 2025-10-24 | 219.02 | 75 | ↑ | ↑ | ↑ | ↑ | 72.17 | 80.59 | s-2 | s-11 | bull | bull | · | 51.11 | 4.285× P | — |
| +100% | 2025-11-10 | 253.30 | 100 | ↑ | ↑ | ↑ | ↑ | 73.86 | 84.16 | s-4 | s-14 | bull | bull | · | 51.11 | 4.956× P | — |
| peak | 2026-04-14 | 465.66 | 285.19 | ↑ | ↑ | ↑ | ↑ | 66.11 | 68.07 | s-9 | s-1 | bull | bull | bull | 154.65 | 3.011× P | — |
| exit_window | 2026-04-17 | 455.07 | 276.43 | ↑ | ↑ | ↑ | ↑ | 62.61 | 68.07 | s-12 | s-1 | bull | bull | bull | 154.65 | 2.943× P | — |

> *No system trades on MU in the window — pure missed opportunity.*

## ALB — RESILIENT_TREND · Basic Materials · return 214.4% · max DD -20.1%

**Fundamentals (today):** P/E TTM 33.52 · Fwd 21.58 · PEG -0.02 · FV $· (·) · current $203.53 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 15 closed trades · Σ pnl% -1.9 on 214% oracle return → capture -1% · premature exits 7/15 · stopped-out 1 · TP-hit 0 · dominant exit: SMART_RUNNER_SUPPORT_BREAK_CLOUD (3/15)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 62.90 | 0 | ↑ | ↑ | ↑ | ↓ | 55.23 | 45.5 | s-6 | s-2 | bull | bull | · | -230.49 | · | — |
| +5% | 2025-07-02 | 67.99 | 5 | ↑ | ↑ | ↑ | ↑ | 64.59 | 45.5 | s-7 | s-2 | bull | bull | · | -230.49 | · | — |
| +15% | 2025-07-10 | 74.27 | 15 | ↑ | ↑ | ↑ | ↑ | 70.55 | 49.23 | s-12 | s-3 | bull | bull | · | -230.49 | · | — |
| +30% | 2025-07-22 | 83.24 | 30 | ↑ | ↑ | ↑ | ↑ | 75.08 | 59.68 | s-4 | s-5 | bull | bull | · | -230.49 | · | — |
| +50% | 2025-10-09 | 96.50 | 50 | ↑ | ↑ | ↑ | ↑ | 68.81 | 59.83 | s-5 | s-4 | bull | bull | · | -24.17 | · | tt_gap_reversal_long · Confirmed · 3.79% · exit:peak_lock_ema12_deep_break |
| +75% | 2025-11-12 | 110.32 | 75 | ↑ | ↑ | ↑ | ↑ | 66.24 | 69.47 | s-4 | s-9 | bull | bull | · | -37.77 | · | tt_gap_reversal_long · Prime · 0.57% · exit:PROFIT_GIVEBACK_STAGE_HOLD |
| +100% | 2025-11-26 | 126.91 | 100 | ↑ | ↑ | ↑ | ↑ | 69.51 | 74.78 | s-1 | s-11 | bull | bull | · | -37.77 | · | tt_gap_reversal_long · Prime · 0.77% · exit:PROFIT_GIVEBACK_STAGE_HOLD |
| peak | 2026-04-16 | 215.62 | 242.8 | ↑ | ↑ | ↑ | ↑ | 72.37 | 69.49 | s-5 | s-4 | bull | bull | bull | -45.32 | · | — |
| exit_window | 2026-04-17 | 197.75 | 214.39 | ↑ | ↑ | ↑ | ↑ | 59.58 | 69.49 | s-6 | s-4 | bull | bull | bull | -45.32 | · | — |

### System trades on ALB during window (n=15)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-17 | 2025-07-28 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.13 | 12.07 | -0.56 | 10.8 | 0.79% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 2 | 2025-08-18 | 2025-08-19 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.29 | 0 | -3.46 | 0.8 | -3.46% | phase_i_mfe_fast_cut_2h |
| 3 | 2025-08-21 | 2025-08-27 | LONG | tt_range_reversal_long | Prime | ? | ? | 83 | 5.22 | 7.95 | 0 | 6 | 5.11% | SOFT_FUSE_RSI_CONFIRMED |
| 4 | 2025-09-23 | 2025-09-24 | LONG | tt_n_test_support | Confirmed | ? | ? | 73 | 2.32 | 3.39 | -2.5 | 1 | 1.36% | PROFIT_GIVEBACK_COOLING_HOLD |
| 5 | 2025-09-26 | 2025-09-30 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 82 | 1.96 | 0.32 | -6.46 | 3.8 | -6.46% | v13_hard_pnl_floor |
| 6 | 2025-10-06 | 2025-10-17 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 81 | 3.3 | 11.98 | 0 | 11 | 3.79% | peak_lock_ema12_deep_break |
| 7 | 2025-10-20 | 2025-10-21 | LONG | tt_gap_reversal_long | Prime | ? | ? | 98 | 3.31 | 1.33 | -2.28 | 0.8 | -0.74% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 8 | 2025-11-14 | 2025-11-18 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.02 | 8.19 | -0.26 | 3.9 | 0.57% | PROFIT_GIVEBACK_STAGE_HOLD |
| 9 | 2025-11-26 | 2025-12-03 | LONG | tt_gap_reversal_long | Prime | ? | ? | 90 | 2.41 | 6.75 | 0 | 7 | 0.77% | PROFIT_GIVEBACK_STAGE_HOLD |
| 10 | 2025-12-09 | 2025-12-12 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.66 | 3.46 | -1.63 | 2.9 | 0.63% | mfe_decay_structural_flatten |
| 11 | 2025-12-19 | 2025-12-22 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 1.92 | 0.39 | -1.9 | 2.9 | -1.63% | doctrine_force_exit |
| 12 | 2026-01-06 | 2026-01-08 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.58 | 2.92 | -2.28 | 2 | -0.52% | runner_drawdown_cap |
| 13 | 2026-01-21 | 2026-01-28 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 99 | 1.76 | 9.85 | -0.02 | 6.8 | 2.21% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 14 | 2026-02-24 | 2026-02-26 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 87 | 2.15 | 7.8 | -0.67 | 1.8 | 4.11% | ST_FLIP_4H_CLOSE |
| 15 | 2026-03-02 | 2026-03-03 | LONG | tt_gap_reversal_long | Speculative | VOLATILE_RUNNER | TRANSITIONAL | 58 | 3.27 | 0.15 | -8.44 | 0.9 | -8.44% | HARD_LOSS_CAP |

## INTC — RESILIENT_TREND · Technology · return 199.8% · max DD -24.2%

**Fundamentals (today):** P/E TTM 809.33 · Fwd 71.61 · PEG 2.85 · FV $· (·) · current $124.91 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 18

**Should-have-held diagnosis:** 2 closed trades · Σ pnl% -6.8 on 200% oracle return → capture -3% · premature exits 0/2 · stopped-out 2 · TP-hit 0 · dominant exit: max_loss (2/2)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 22.85 | 0 | ↑ | ↑ | ↑ | ↑ | 61.65 | 49.08 | s-1 | s-3 | bull | bull | · | -24.35 | · | tt_gap_reversal_long · Prime · -3.54% · exit:max_loss |
| +5% | 2025-08-15 | 24.56 | 5 | ↑ | ↑ | ↑ | ↑ | 69.09 | 56.95 | s-8 | s-1 | bull | bull | · | -32.94 | · | — |
| +15% | 2025-09-18 | 30.57 | 15 | ↑ | ↑ | ↑ | ↑ | 78.45 | 68.35 | s-4 | s-1 | bull | bull | · | 141.07 | 0.217× D | — |
| +30% | 2025-09-18 | 30.57 | 30 | ↑ | ↑ | ↑ | ↑ | 78.45 | 68.35 | s-4 | s-1 | bull | bull | · | 141.07 | 0.217× D | — |
| +50% | 2025-09-26 | 35.50 | 50 | ↑ | ↑ | ↑ | ↑ | 80.57 | 76.56 | s-10 | s-2 | bull | bull | · | 141.07 | 0.252× D | — |
| +75% | 2025-10-28 | 41.53 | 75 | ↑ | ↑ | ↑ | ↑ | 73.37 | 80.24 | s-7 | s-7 | bull | bull | · | 159.69 | 0.26× D | — |
| +100% | 2026-01-13 | 47.29 | 100 | ↑ | ↑ | ↑ | ↑ | 70.98 | 71.98 | s-11 | s-2 | bull | bull | bull | 159.69 | 0.296× D | — |
| peak | 2026-04-16 | 68.50 | 199.78 | ↑ | ↑ | ↑ | ↑ | 78.2 | 77.31 | s-11 | s-3 | bull | bull | bull | 161.13 | 0.425× D | — |
| exit_window | 2026-04-17 | 68.50 | 199.78 | ↑ | ↑ | ↑ | ↑ | 78.2 | 77.31 | s-12 | s-3 | bull | bull | bull | 161.13 | 0.425× D | — |

### System trades on INTC during window (n=2)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-01 | 2025-07-02 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 4.02 | 0.42 | -3.23 | 0.9 | -3.54% | max_loss |
| 2 | 2025-08-27 | 2025-09-02 | LONG | tt_gap_reversal_long | Prime | ? | ? | 92 | 3.28 | 1.3 | -3.31 | 5.9 | -3.31% | max_loss |

## RKLB — RESILIENT_TREND · Industrials · return 147.0% · max DD -43.0%

**Fundamentals (today):** P/E TTM 0 · Fwd 1533.27 · PEG 1533.27 · FV $· (·) · current $105.49 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 30

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 147% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 34.33 | 0 | ↑ | ~ | ↑ | ↑ | 65.01 | 75.19 | s-9 | s-3 | bull | bull | · | -551.98 | · | — |
| +5% | 2025-07-07 | 38.88 | 5 | ↑ | ↑ | ↑ | ↑ | 73.46 | 77.6 | s-2 | s-4 | bull | bull | · | -551.98 | · | — |
| +15% | 2025-07-14 | 43.21 | 15 | ↑ | ↑ | ↑ | ↑ | 79.56 | 83.8 | s-7 | s-5 | bull | bull | · | -551.98 | · | — |
| +30% | 2025-07-16 | 47.69 | 30 | ↑ | ↑ | ↑ | ↑ | 84.24 | 83.8 | s-9 | s-5 | bull | bull | · | -551.98 | · | — |
| +50% | 2025-09-12 | 53.34 | 50 | ↑ | ↑ | ↑ | ↑ | 65.67 | 74.38 | s-4 | s-3 | bull | bull | · | -628.64 | · | — |
| +75% | 2025-10-07 | 61.51 | 75 | ↑ | ↑ | ↑ | ↑ | 70.97 | 74.64 | s-5 | s-2 | bull | bull | · | -628.64 | · | — |
| +100% | 2025-10-15 | 69.27 | 100 | ↑ | ↑ | ↑ | ↑ | 74.88 | 75.6 | s-11 | s-3 | bull | bull | · | -628.64 | · | — |
| peak | 2026-01-16 | 96.30 | 180.51 | ↑ | ↑ | ↑ | ↑ | 75.96 | 77.3 | s-11 | s-6 | bull | bull | bull | -521.31 | · | — |
| exit_window | 2026-04-17 | 84.80 | 147.01 | ↑ | ↑ | ↑ | ↑ | 66.88 | 63.36 | s-6 | s-1 | bull | bull | bull | 1333.94 | 0.064× D | — |

> *No system trades on RKLB in the window — pure missed opportunity.*

## FN — RESILIENT_TREND · Technology · return 138.6% · max DD -20.6%

**Fundamentals (today):** P/E TTM 53.77 · Fwd 36.15 · PEG 1.74 · FV $501.55 (premium) · current $621.18 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 5 closed trades · Σ pnl% -2.1 on 139% oracle return → capture -2% · premature exits 2/5 · stopped-out 2 · TP-hit 0 · dominant exit: PROFIT_GIVEBACK_STAGE_HOLD (1/5)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 289.11 | 0 | ↑ | ~ | ↑ | ↑ | 71.03 | 75.54 | s-14 | s-11 | bull | bull | · | 358.97 | 0.805× D | — |
| +5% | 2025-07-17 | 308.36 | 5 | ↑ | ↑ | ↑ | ↑ | 72.74 | 76.88 | s-5 | s-13 | bull | bull | · | 358.97 | 0.859× F | — |
| +15% | 2025-08-07 | 335.11 | 15 | ↑ | ↑ | ↑ | ↑ | 72.74 | 80.42 | s-4 | s-16 | bull | bull | · | 358.97 | 0.934× F | tt_gap_reversal_long · Confirmed · -0.57% · exit:max_loss_time_scaled |
| +30% | 2025-09-18 | 378.01 | 30 | ↑ | ↑ | ↑ | ↑ | 64.83 | 72.28 | s-1 | s-4 | bull | bull | · | 359.34 | 1.052× F | — |
| +50% | 2025-10-28 | 437.56 | 50 | ↑ | ↑ | ↑ | ↑ | 69.33 | 74.88 | s-4 | s-4 | bull | bull | · | 359.34 | 1.218× P | — |
| +75% | 2025-12-10 | 516.63 | 75 | ↑ | ↑ | ↑ | ↑ | 70.53 | 68.78 | s-5 | s-3 | bull | bull | · | 369.10 | 1.4× P | — |
| +100% | 2026-02-24 | 585.87 | 100 | ↑ | ↑ | ↑ | ↑ | 69.52 | 69.71 | s-6 | s-5 | bull | bull | bull | 323.19 | 1.813× P | tt_gap_reversal_long · Prime · -2.41% · exit:doctrine_force_exit |
| peak | 2026-04-13 | 689.89 | 138.63 | ↑ | ↑ | ↑ | ↑ | 68.66 | 77.17 | s-7 | s-4 | bull | bull | bull | 323.19 | 2.135× P | — |
| exit_window | 2026-04-17 | 689.89 | 138.63 | ↑ | ↑ | ↑ | ↑ | 66.58 | 77.17 | ?-0 | s-4 | bull | bull | bull | 323.19 | 2.135× P | — |

### System trades on FN during window (n=5)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-28 | 2025-08-01 | LONG | tt_ath_breakout | Prime | ? | ? | 100 | 3.56 | 6.16 | -0.23 | 3.9 | 2.36% | PROFIT_GIVEBACK_STAGE_HOLD |
| 2 | 2025-08-08 | 2025-08-11 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 100 | 4.26 | 1.67 | -2 | 3.1 | -0.57% | max_loss_time_scaled |
| 3 | 2026-01-13 | 2026-01-14 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 2.9 | 1.37 | -2.57 | 0.9 | -0.62% | max_loss |
| 4 | 2026-02-18 | 2026-02-18 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 96 | 2.61 | 1.37 | -2.39 | 0.1 | -0.85% | SMART_RUNNER_TD_EXHAUSTION_RUNNER |
| 5 | 2026-02-25 | 2026-02-26 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 93 | 2.11 | 0 | -2.41 | 0.8 | -2.41% | doctrine_force_exit |

## AU — RESILIENT_TREND · Basic Materials · return 138.3% · max DD -37.6%

**Fundamentals (today):** P/E TTM 20.63 · Fwd 10.86 · PEG 0.33 · FV $85.49 (premium) · current $107.05 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% -3.2 on 138% oracle return → capture -2% · premature exits 0/1 · stopped-out 0 · TP-hit 0 · dominant exit: PRE_EARNINGS_FORCE_EXIT (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 45.80 | 0 | ↑ | ↓ | ↓ | ↑ | 50.01 | 60.49 | b-9 | s-7 | bear | bull | · | 31.83 | 1.439× P | — |
| +5% | 2025-07-21 | 50.62 | 5 | ↑ | ↑ | ↑ | ↑ | 64.58 | 63.76 | s-1 | s-1 | bull | bull | · | 31.83 | 1.59× P | — |
| +15% | 2025-08-04 | 53.17 | 15 | ↑ | ↑ | ↑ | ↑ | 63.56 | 68.91 | s-1 | s-3 | bull | bull | · | 38.90 | 1.367× P | — |
| +30% | 2025-09-05 | 59.77 | 30 | ↑ | ↑ | ↑ | ↑ | 66.97 | 68.72 | s-11 | s-7 | bull | bull | · | 38.90 | 1.537× P | — |
| +50% | 2025-09-22 | 69.37 | 50 | ↑ | ↑ | ↑ | ↑ | 75.43 | 74.54 | s-2 | s-10 | bull | bull | · | 29.44 | 2.356× P | — |
| +75% | 2025-11-12 | 85.13 | 75 | ↑ | ↑ | ↑ | ↑ | 71.32 | 74.14 | s-4 | s-1 | bull | bull | · | 48.89 | 1.741× P | — |
| +100% | 2026-01-06 | 93.66 | 100 | ↑ | ↑ | ↑ | ↑ | 65.49 | 72.39 | s-2 | s-9 | bull | bull | bull | 39.44 | 2.375× P | — |
| peak | 2026-03-02 | 128.26 | 180.04 | ↑ | ↑ | ↑ | ↑ | 70.29 | 60.4 | s-8 | s-17 | bull | bull | bull | 63.45 | 2.021× P | — |
| exit_window | 2026-04-17 | 109.15 | 138.32 | ↑ | ↑ | ↑ | ↓ | 58.57 | 58.86 | s-1 | s-2 | bull | bear | bull | 63.45 | 1.72× P | — |

### System trades on AU during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2026-02-18 | 2026-02-19 | LONG | tt_range_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 3.52 | 0 | -0.78 | 0.8 | -3.16% | PRE_EARNINGS_FORCE_EXIT |

## SLV — RESILIENT_TREND · sector? · return 125.0% · max DD -42.5%

**Fundamentals (today):** P/E TTM 0 · Fwd 0 · PEG 0 · FV $· (·) · current $73.02 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 125% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 32.73 | 0 | ↑ | ↓ | ↑ | ↓ | 55 | 58.47 | b-1 | s-7 | bull | bull | · | · | · | — |
| +5% | 2025-07-11 | 35.03 | 5 | ↑ | ↑ | ↑ | ↑ | 69.77 | 62.61 | s-2 | s-8 | bull | bull | · | · | · | — |
| +15% | 2025-09-11 | 37.79 | 15 | ↑ | ↑ | ↑ | ↑ | 70.16 | 69.26 | s-2 | s-4 | bull | bull | · | · | · | — |
| +30% | 2025-10-01 | 42.91 | 30 | ↑ | ↑ | ↑ | ↑ | 81.51 | 78.86 | s-9 | s-7 | bull | bull | · | · | · | — |
| +50% | 2025-10-16 | 49.17 | 50 | ↑ | ↑ | ↑ | ↑ | 84.52 | 83.05 | s-20 | s-9 | bull | bull | · | · | · | — |
| +75% | 2025-12-11 | 57.62 | 75 | ↑ | ↑ | ↑ | ↑ | 78.29 | 82.86 | s-3 | s-4 | bull | bull | · | · | · | — |
| +100% | 2025-12-26 | 71.12 | 100 | ↑ | ↑ | ↑ | ↑ | 85.64 | 90.14 | s-13 | s-6 | bull | bull | · | · | · | — |
| peak | 2026-01-28 | 105.60 | 222.64 | ↑ | ↑ | ↑ | ↑ | 82.75 | 65.55 | s-5 | s-11 | bull | bull | bull | · | · | — |
| exit_window | 2026-04-17 | 73.63 | 124.96 | ↑ | ↑ | ↑ | ↑ | 58.26 | 57.45 | s-7 | s-1 | bear | bear | bull | · | · | — |

> *No system trades on SLV in the window — pure missed opportunity.*

## MTZ — RESILIENT_TREND · Industrials · return 120.5% · max DD -14.1%

**Fundamentals (today):** P/E TTM 75.62 · Fwd 37.83 · PEG 0.83 · FV $346.62 (premium) · current $414.26 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** 6 closed trades · Σ pnl% 6.9 on 120% oracle return → capture 6% · premature exits 3/6 · stopped-out 2 · TP-hit 0 · dominant exit: PROFIT_GIVEBACK_STAGE_HOLD (2/6)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 168.23 | 0 | ↑ | ~ | ↑ | ↑ | 62.37 | 81.37 | b-1 | s-11 | bull | bull | · | 171.77 | 0.979× F | — |
| +5% | 2025-07-18 | 177.67 | 5 | ↑ | ↑ | ↑ | ↑ | 71.02 | 81.53 | s-5 | s-13 | bull | bull | · | 171.77 | 1.034× F | — |
| +15% | 2025-09-18 | 199.45 | 15 | ↑ | ↑ | ↑ | ↑ | 68.89 | 76.76 | s-7 | s-2 | bull | bull | · | 191.82 | 1.04× F | tt_gap_reversal_long · Prime · 0.82% · exit:PROFIT_GIVEBACK_STAGE_HOLD |
| +30% | 2025-10-08 | 218.92 | 30 | ↑ | ↑ | ↑ | ↓ | 74.15 | 65.28 | s-1 | s-5 | bull | bull | · | 191.82 | 1.141× F | — |
| +50% | 2026-02-06 | 259.16 | 50 | ↑ | ↑ | ↑ | ↓ | 64.77 | 74.73 | s-2 | s-4 | bull | bull | bull | 162.31 | 1.597× P | — |
| +75% | 2026-02-27 | 298.02 | 75 | ↑ | ↑ | ↑ | ↑ | 74.37 | 82.08 | s-7 | s-7 | bull | bull | bull | 211.49 | 1.409× P | — |
| +100% | 2026-04-06 | 337.27 | 100 | ↑ | ↑ | ↑ | ↑ | 65.45 | 85.44 | s-3 | s-13 | bull | bull | bull | 129.39 | 2.607× P | — |
| peak | 2026-04-17 | 370.89 | 120.47 | ↑ | ↑ | ↑ | ↑ | 72.02 | 86.34 | s-1 | s-14 | bull | bull | bull | 129.39 | 2.866× P | tt_ath_breakout · Confirmed · 1.03% · exit:PROFIT_GIVEBACK_STAGE_HOLD |
| exit_window | 2026-04-17 | 370.89 | 120.47 | ↑ | ↑ | ↑ | ↑ | 72.02 | 86.34 | s-1 | s-14 | bull | bull | bull | 129.39 | 2.866× P | tt_ath_breakout · Confirmed · 1.03% · exit:PROFIT_GIVEBACK_STAGE_HOLD |

### System trades on MTZ during window (n=6)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-07 | 2025-07-08 | LONG | tt_ath_breakout | Prime | ? | ? | 92 | 3.61 | 0.53 | -2.21 | 1 | -2.21% | max_loss_time_scaled |
| 2 | 2025-09-18 | 2025-09-25 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.34 | 5.2 | 0 | 6.9 | 0.82% | PROFIT_GIVEBACK_STAGE_HOLD |
| 3 | 2026-01-15 | 2026-01-29 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 2.53 | 5 | -1.18 | 13.8 | 2.06% | mfe_decay_structural_flatten |
| 4 | 2026-03-19 | 2026-03-20 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 94 | 3.07 | 2.93 | -0.39 | 0.9 | 0.13% | atr_week_618_full_exit |
| 5 | 2026-04-02 | 2026-04-15 | LONG | tt_gap_reversal_long | Confirmed | VOLATILE_RUNNER | TRENDING | 98 | 2.27 | 10.64 | -0.87 | 13 | 5.09% | sl_breached |
| 6 | 2026-04-17 | 2026-04-29 | LONG | tt_ath_breakout | Confirmed | VOLATILE_RUNNER | TRENDING | 94 | 1.75 | 6.49 | -0.77 | 11.9 | 1.03% | PROFIT_GIVEBACK_STAGE_HOLD |

## AA — RESILIENT_TREND · Basic Materials · return 117.3% · max DD -15.8%

**Fundamentals (today):** P/E TTM 16.24 · Fwd 9.46 · PEG -0.72 · FV $41.84 (premium) · current $63.15 · EPS growth class: declining

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** 16 closed trades · Σ pnl% 2.4 on 117% oracle return → capture 2% · premature exits 9/16 · stopped-out 0 · TP-hit 0 · dominant exit: doctrine_force_exit (4/16)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 30.20 | 0 | ↑ | ↑ | ↑ | ↑ | 59.54 | · | s-2 | s-2 | bull | bull | · | 35.56 | 0.849× D | tt_gap_reversal_long · Confirmed · 2.12% · exit:peak_lock_ema12_deep_break |
| +5% | 2025-07-22 | 31.93 | 5 | ↑ | ↑ | ↑ | ↑ | 61.21 | 67.4 | s-3 | s-5 | bull | bull | · | 39.25 | 0.814× D | — |
| +15% | 2025-10-02 | 34.83 | 15 | ↑ | ↑ | ↑ | ↑ | 64.34 | 69.32 | s-5 | s-8 | bull | bull | · | 39.25 | 0.887× F | — |
| +30% | 2025-10-23 | 40.14 | 30 | ↑ | ↑ | ↑ | ↓ | 64.06 | 78.16 | s-1 | s-11 | bull | bull | · | 28.66 | 1.401× P | tt_gap_reversal_long · Confirmed · -6.14% · exit:doctrine_force_exit |
| +50% | 2025-12-11 | 47.24 | 50 | ↑ | ↑ | ↑ | ↑ | 72.51 | 78.03 | s-2 | s-3 | bull | bull | · | 28.66 | 1.648× P | — |
| +75% | 2025-12-22 | 53.72 | 75 | ↑ | ↑ | ↑ | ↑ | 79.4 | 84.39 | s-3 | s-5 | bull | bull | · | 28.66 | 1.874× P | tt_gap_reversal_long · Prime · 6.58% · exit:HARD_FUSE_RSI_EXTREME |
| +100% | 2026-01-05 | 61.44 | 100 | ↑ | ↑ | ↑ | ↑ | 82.72 | 88.86 | s-2 | s-7 | bull | bull | bull | 28.66 | 2.144× P | tt_gap_reversal_long · Prime · -4.05% · exit:doctrine_force_exit |
| peak | 2026-04-13 | 73.31 | 142.75 | ↑ | ↑ | ↑ | ↑ | 66.19 | 61.47 | s-3 | s-3 | bull | bull | bull | 22.70 | 3.23× P | — |
| exit_window | 2026-04-17 | 65.62 | 117.28 | ↑ | ↓ | ↓ | ↓ | 47.04 | 61.47 | b-3 | s-3 | bull | bull | bull | 31.12 | 2.109× P | — |

### System trades on AA during window (n=16)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-01 | 2025-07-07 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 71 | 3.81 | 6.85 | 0 | 6 | 2.12% | peak_lock_ema12_deep_break |
| 2 | 2025-07-28 | 2025-07-28 | LONG | tt_n_test_support | Speculative | ? | ? | 59 | 3.92 | 1.6 | -0.24 | 0.2 | 0.68% | atr_week_618_full_exit |
| 3 | 2025-09-11 | 2025-09-22 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 5.38 | 7.48 | 0 | 10.9 | 1.09% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 4 | 2025-10-07 | 2025-10-10 | LONG | tt_gap_reversal_long | Prime | ? | ? | 90 | 3.29 | 9.69 | -0.12 | 3 | 3.49% | ST_FLIP_4H_CLOSE |
| 5 | 2025-10-20 | 2025-10-21 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 4.85 | 4.22 | -3.34 | 0.9 | -0.61% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 6 | 2025-10-23 | 2025-10-24 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 100 | 1.73 | 0 | -6.14 | 0.8 | -6.14% | doctrine_force_exit |
| 7 | 2025-10-29 | 2025-10-29 | LONG | tt_pullback | Prime | ? | ? | 90 | 3.24 | 0.35 | -2.59 | 0.2 | -2.59% | doctrine_force_exit |
| 8 | 2025-12-03 | 2025-12-04 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.03 | 0.81 | -1.6 | 1.1 | -1.60% | doctrine_force_exit |
| 9 | 2025-12-19 | 2026-01-05 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.11 | 12.73 | -0.09 | 16.8 | 6.58% | HARD_FUSE_RSI_EXTREME |
| 10 | 2026-01-06 | 2026-01-07 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 92 | 1.48 | 0 | -4.05 | 0.9 | -4.05% | doctrine_force_exit |
| 11 | 2026-01-09 | 2026-01-14 | LONG | tt_gap_reversal_long | Confirmed | VOLATILE_RUNNER | TRENDING | 100 | 2.23 | 5.45 | 0 | 5 | 1.55% | atr_week_618_full_exit |
| 12 | 2026-02-03 | 2026-02-04 | LONG | tt_gap_reversal_long | Confirmed | VOLATILE_RUNNER | TRANSITIONAL | 76 | 3.56 | 3.68 | -1.46 | 1.1 | 0.44% | thesis_flip_htf |
| 13 | 2026-02-09 | 2026-02-12 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | CHOPPY | 93 | 2.78 | 3.25 | -1.34 | 2.9 | 1.99% | ST_FLIP_4H_CLOSE |
| 14 | 2026-02-20 | 2026-02-23 | LONG | tt_gap_reversal_long | Confirmed | VOLATILE_RUNNER | TRANSITIONAL | 69 | 4.33 | 0.83 | -0.53 | 3 | -0.53% | h4_regime_flip_exit |
| 15 | 2026-02-24 | 2026-02-26 | LONG | tt_gap_reversal_long | Confirmed | VOLATILE_RUNNER | CHOPPY | 67 | 2.81 | 6.85 | -0.36 | 1.8 | 0.99% | PROFIT_GIVEBACK_STAGE_HOLD |
| 16 | 2026-03-02 | 2026-03-03 | LONG | tt_gap_reversal_long | Confirmed | VOLATILE_RUNNER | TRANSITIONAL | 82 | 3.72 | 1.98 | -3.18 | 1 | -0.98% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |

## UTHR — RESILIENT_TREND · Healthcare · return 102.3% · max DD -10.6%

**Fundamentals (today):** P/E TTM 21.41 · Fwd 17.39 · PEG 0.86 · FV $507.25 (premium) · current $564.76 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 20

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 102% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 290.91 | 0 | ↓ | ↑ | ↓ | ↑ | 45.97 | 45.45 | s-1 | b-4 | bear | bull | · | 435.75 | 0.668× D | — |
| +5% | 2025-07-23 | 305.61 | 5 | ↑ | ↑ | ↑ | ↑ | 58.63 | 50.05 | s-1 | s-3 | bear | bull | · | 435.75 | 0.701× D | — |
| +15% | 2025-09-02 | 404.81 | 15 | ↑ | ↑ | ↑ | ↓ | 83.32 | 73.22 | s-1 | s-5 | bull | bull | · | 445.48 | 0.909× F | — |
| +30% | 2025-09-02 | 404.81 | 30 | ↑ | ↑ | ↑ | ↓ | 83.32 | 73.22 | s-1 | s-5 | bull | bull | · | 445.48 | 0.909× F | — |
| +50% | 2025-09-24 | 438.75 | 50 | ↑ | ↑ | ↑ | ↑ | 76.15 | 77.41 | s-5 | s-8 | bull | bull | · | 445.48 | 0.985× F | — |
| +75% | 2025-12-17 | 510.94 | 75 | ↑ | ↑ | ↑ | ↓ | 73.06 | 80.35 | s-4 | s-7 | bull | bull | · | 458.87 | 1.113× F | — |
| +100% | 2026-03-30 | 588.36 | 100 | ↑ | ↑ | ↑ | ↓ | 69.73 | 70.45 | s-5 | s-4 | bull | bull | bull | 264.65 | 2.223× P | — |
| peak | 2026-03-31 | 592.98 | 103.84 | ↑ | ↑ | ↑ | ↑ | 70.54 | 70.45 | s-6 | s-4 | bull | bull | bull | 264.65 | 2.241× P | — |
| exit_window | 2026-04-17 | 588.38 | 102.25 | ↑ | ↑ | ↑ | ↑ | 64.35 | 73.42 | s-3 | s-6 | bull | bull | bull | 161.54 | 3.642× P | — |

> *No system trades on UTHR in the window — pure missed opportunity.*

## KLAC — RESILIENT_TREND · Technology · return 99.3% · max DD -22.4%

**Fundamentals (today):** P/E TTM 53.24 · Fwd 37.86 · PEG 4.55 · FV $1596.22 (premium) · current $1869.02 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 10 closed trades · Σ pnl% 17.6 on 99% oracle return → capture 18% · premature exits 6/10 · stopped-out 1 · TP-hit 1 · dominant exit: doctrine_force_exit (2/10)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 898.85 | 0 | ↑ | ↑ | ↑ | ↑ | 66.33 | 70.22 | s-5 | s-11 | bull | bull | · | 1156.11 | 0.777× D | — |
| +5% | 2025-08-13 | 949.48 | 5 | ↑ | ↑ | ↑ | ↑ | 61.36 | 61.43 | s-3 | b-3 | bull | bull | · | 1261.35 | 0.753× D | — |
| +15% | 2025-09-18 | 1046.69 | 15 | ↑ | ↑ | ↑ | ↑ | 77.63 | 73.34 | s-10 | s-2 | bull | bull | · | 1261.35 | 0.83× D | — |
| +30% | 2025-10-24 | 1182.82 | 30 | ↑ | ↑ | ↑ | ↑ | 65.8 | 71.57 | s-8 | s-7 | bull | bull | · | 1261.35 | 0.938× F | — |
| +50% | 2026-01-05 | 1352.45 | 50 | ↑ | ↑ | ↑ | ↑ | 67.23 | 74.83 | s-1 | s-6 | bull | bull | bull | 1317.38 | 1.027× F | tt_gap_reversal_long · Prime · -0.64% · exit:SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| +75% | 2026-01-27 | 1616.33 | 75 | ↑ | ↑ | ↑ | ↑ | 71.87 | 66.88 | s-2 | s-9 | bull | bull | bull | 1317.38 | 1.227× P | tt_gap_reversal_long · Prime · 5.29% · exit:TP_FULL |
| peak | 2026-04-14 | 1795.91 | 99.8 | ↑ | ↑ | ↑ | ↑ | 73.28 | 72.23 | s-9 | s-3 | bull | bull | bull | 1038.76 | 1.729× P | — |
| exit_window | 2026-04-17 | 1791.44 | 99.3 | ↑ | ↑ | ↑ | ↑ | 68.8 | 72.23 | s-1 | s-3 | bull | bull | bull | 1038.76 | 1.725× P | — |

### System trades on KLAC during window (n=10)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-09-11 | 2025-09-18 | LONG | tt_gap_reversal_long | Prime | ? | ? | 95 | 1.67 | 9.82 | 0 | 7 | 4.99% | HARD_FUSE_RSI_EXTREME |
| 2 | 2025-10-06 | 2025-10-07 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.47 | 0.77 | -2.85 | 1 | -1.09% | doctrine_force_exit |
| 3 | 2025-10-31 | 2025-11-03 | LONG | tt_n_test_support | Confirmed | ? | ? | 100 | 2.17 | 0.79 | -1.79 | 3 | -1.41% | doctrine_force_exit |
| 4 | 2025-12-01 | 2025-12-12 | LONG | tt_n_test_support | Prime | VOLATILE_RUNNER | CHOPPY | 92 | 2.44 | 7.55 | -0.78 | 11 | 3.52% | peak_lock_ema12_deep_break |
| 5 | 2025-12-23 | 2025-12-29 | LONG | tt_ath_breakout | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 2.17 | 1.25 | -0.57 | 5.9 | 0.25% | sl_breached |
| 6 | 2026-01-05 | 2026-01-08 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.02 | 4.39 | -1.89 | 3 | -0.64% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 7 | 2026-01-09 | 2026-01-14 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 1.73 | 5.15 | 0 | 4.9 | 0.60% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 8 | 2026-01-26 | 2026-01-29 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 93 | 2.41 | 7.74 | 0 | 2.9 | 5.29% | TP_FULL |
| 9 | 2026-02-17 | 2026-02-19 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 3.7 | 3.57 | 0 | 2.1 | 1.38% | mfe_decay_structural_flatten |
| 10 | 2026-02-20 | 2026-03-03 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 99 | 2.3 | 7.21 | -0.76 | 10.9 | 4.75% | ST_FLIP_4H_CLOSE |

## GEV — RESILIENT_TREND · Industrials · return 98.2% · max DD -17.5%

**Fundamentals (today):** P/E TTM 30.54 · Fwd 42.7 · PEG 0.02 · FV $1369.6 (discount) · current $1039.95 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 18

**Should-have-held diagnosis:** 8 closed trades · Σ pnl% 8.8 on 98% oracle return → capture 9% · premature exits 2/8 · stopped-out 1 · TP-hit 0 · dominant exit: atr_week_618_full_exit (2/8)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 506.00 | 0 | ↑ | ~ | ↑ | ↑ | 59.94 | 86.25 | s-11 | s-11 | bull | bull | · | 296.35 | 1.707× P | — |
| +5% | 2025-07-09 | 535.77 | 5 | ↑ | ↑ | ↑ | ↑ | 68.71 | 87.27 | s-3 | s-12 | bull | bull | · | 296.35 | 1.808× P | — |
| +15% | 2025-07-23 | 629.03 | 15 | ↑ | ↑ | ↑ | ↓ | 77.95 | 90.93 | s-1 | s-14 | bull | bull | · | 177.21 | 3.55× P | tt_gap_reversal_long · Prime · 0.55% · exit:SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| +30% | 2025-07-31 | 660.29 | 30 | ↑ | ↑ | ↑ | ↑ | 76.19 | 91.24 | s-7 | s-15 | bull | bull | · | 177.21 | 3.726× P | — |
| +50% | 2026-02-03 | 780.25 | 50 | ↑ | ↑ | ↑ | ↑ | 74.42 | 71.63 | s-6 | s-2 | bull | bull | bull | 760.08 | 1.027× F | tt_gap_reversal_long · Prime · 4.17% · exit:ST_FLIP_4H_CLOSE |
| +75% | 2026-03-24 | 909.41 | 75 | ↑ | ↑ | ↑ | ↑ | 64.79 | 68.65 | s-5 | b-1 | bull | bull | bull | 760.08 | 1.196× P | — |
| peak | 2026-04-17 | 1002.75 | 98.17 | ↑ | ↑ | ↑ | ↑ | 69.19 | 77.46 | s-1 | s-3 | bull | bull | bull | 734.03 | 1.366× P | tt_ath_breakout · Prime · -0.81% · exit:phase_i_mfe_fast_cut_2h |
| exit_window | 2026-04-17 | 1002.75 | 98.17 | ↑ | ↑ | ↑ | ↑ | 69.19 | 77.46 | s-1 | s-3 | bull | bull | bull | 734.03 | 1.366× P | tt_ath_breakout · Prime · -0.81% · exit:phase_i_mfe_fast_cut_2h |

### System trades on GEV during window (n=8)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-23 | 2025-08-13 | LONG | tt_gap_reversal_long | Prime | ? | ? | 96 | 1.62 | 7.73 | -1.49 | 20.9 | 0.55% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 2 | 2026-01-06 | 2026-01-07 | LONG | tt_pullback | Prime | VOLATILE_RUNNER | TRANSITIONAL | 93 | 2.34 | 0.43 | -1.21 | 0.8 | -1.21% | doctrine_force_exit |
| 3 | 2026-02-02 | 2026-02-04 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.54 | 4.6 | -0.08 | 1.8 | 4.17% | ST_FLIP_4H_CLOSE |
| 4 | 2026-02-06 | 2026-02-26 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 92 | 1.79 | 16.34 | 0 | 20 | 6.61% | sl_breached |
| 5 | 2026-03-04 | 2026-03-04 | LONG | tt_pullback | Prime | VOLATILE_RUNNER | TRENDING | 95 | 3.46 | 0 | -1.35 | 0.2 | -0.95% | thesis_flip_htf |
| 6 | 2026-03-19 | 2026-03-20 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 95 | 3.86 | 3.38 | -0.02 | 1.1 | 0.46% | atr_week_618_full_exit |
| 7 | 2026-04-17 | 2026-04-20 | LONG | tt_ath_breakout | Prime | VOLATILE_RUNNER | TRENDING | 100 | 1.77 | 0.26 | -0.87 | 2.9 | -0.81% | phase_i_mfe_fast_cut_2h |
| 8 | 2026-04-30 | 2026-05-01 | LONG | tt_ath_breakout | Prime | VOLATILE_RUNNER | TRENDING | 100 | 1.27 | 1.03 | -0.81 | 1 | -0.05% | atr_week_618_full_exit |

## WFRD — RESILIENT_TREND · Energy · return 96.3% · max DD -20.3%

**Fundamentals (today):** P/E TTM 15.98 · Fwd 13.85 · PEG 0.36 · FV $75.54 (premium) · current $102.29 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 96% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 52.14 | 0 | ↑ | ↑ | ↑ | ↓ | 59.98 | 51.03 | s-3 | s-5 | bull | bull | · | 87.80 | 0.594× D | — |
| +5% | 2025-07-02 | 55.32 | 5 | ↑ | ↑ | ↑ | ↑ | 67.28 | 51.03 | s-4 | s-5 | bull | bull | · | 87.80 | 0.63× D | — |
| +15% | 2025-08-22 | 60.83 | 15 | ↑ | ↑ | ↑ | ↑ | 63.86 | 57.27 | s-2 | s-2 | bull | bull | · | 79.49 | 0.765× D | — |
| +30% | 2025-09-25 | 68.09 | 30 | ↑ | ↑ | ↑ | ↑ | 67.44 | 65.1 | s-8 | s-7 | bull | bull | · | 79.49 | 0.857× F | — |
| +50% | 2025-12-09 | 80.10 | 50 | ↑ | ↑ | ↑ | ↑ | 66.6 | 69.96 | s-2 | s-8 | bull | bull | · | 66.47 | 1.205× P | — |
| +75% | 2026-01-27 | 93.26 | 75 | ↑ | ↑ | ↑ | ↑ | 68.53 | 72.31 | s-5 | s-15 | bull | bull | bull | 110.37 | 0.845× D | — |
| +100% | 2026-02-06 | 105.51 | 100 | ↑ | ↑ | ↑ | ↑ | 77.53 | 77.89 | s-4 | s-16 | bull | bull | bull | 122.56 | 0.861× F | — |
| peak | 2026-02-24 | 106.86 | 104.95 | ↑ | ↑ | ↑ | ↑ | 69.49 | 74.29 | s-6 | s-19 | bull | bull | bull | 113.56 | 0.941× F | — |
| exit_window | 2026-04-17 | 102.36 | 96.32 | ↑ | ↑ | ↑ | ↓ | 60.91 | 63.76 | b-4 | s-3 | bull | bull | bull | 113.56 | 0.901× F | — |

> *No system trades on WFRD in the window — pure missed opportunity.*

## GOOGL — RESILIENT_TREND · Communication Services · return 94.3% · max DD -20.4%

**Fundamentals (today):** P/E TTM 30.22 · Fwd 27.37 · PEG 0.37 · FV $448.18 (discount) · current $400.67 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 22

**Should-have-held diagnosis:** 12 closed trades · Σ pnl% 13.2 on 94% oracle return → capture 14% · premature exits 3/12 · stopped-out 2 · TP-hit 3 · dominant exit: TP_FULL (3/12)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 175.84 | 0 | ↑ | ↑ | ↑ | ↑ | 56.71 | 63.51 | s-4 | s-2 | bull | bull | · | 193.78 | 0.907× F | tt_n_test_support · Prime · 1.97% · exit:TP_FULL |
| +5% | 2025-07-18 | 185.06 | 5 | ↑ | ↑ | ↑ | ↑ | 66.48 | 65.84 | s-6 | s-4 | bull | bull | · | 193.78 | 0.955× F | — |
| +15% | 2025-08-12 | 203.34 | 15 | ↑ | ↑ | ↑ | ↑ | 73.02 | 71.16 | s-5 | s-8 | bull | bull | · | 257.00 | 0.791× D | — |
| +30% | 2025-09-03 | 230.66 | 30 | ↑ | ↑ | ↑ | ↑ | 82.82 | 79.85 | s-8 | s-11 | bull | bull | · | 257.00 | 0.898× F | — |
| +50% | 2025-10-27 | 269.27 | 50 | ↑ | ↑ | ↑ | ↑ | 73.15 | 79.93 | s-2 | s-2 | bull | bull | · | 257.00 | 1.048× F | tt_gap_reversal_long · Prime · 0.85% · exit:TP_FULL |
| +75% | 2025-11-24 | 318.58 | 75 | ↑ | ↑ | ↑ | ↑ | 75.32 | 83.76 | s-4 | s-6 | bull | bull | · | 277.53 | 1.148× F | tt_gap_reversal_long · Prime · 0.60% · exit:PROFIT_GIVEBACK_STAGE_HOLD |
| peak | 2026-02-02 | 343.69 | 95.46 | ↑ | ↑ | ↑ | ↑ | 70.03 | 69.6 | s-6 | b-1 | bull | bull | bull | 197.88 | 1.737× P | tt_pullback · Confirmed · 0.79% · exit:atr_week_618_full_exit |
| exit_window | 2026-04-17 | 341.68 | 94.31 | ↑ | ↑ | ↑ | ↑ | 72.63 | 65.17 | s-12 | s-2 | bull | bear | bull | 137.40 | 2.487× P | — |

### System trades on GOOGL during window (n=12)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-01 | 2025-07-23 | LONG | tt_n_test_support | Prime | ? | ? | 92 | 3.84 | 9.35 | -0.93 | 21.8 | 1.97% | TP_FULL |
| 2 | 2025-08-08 | 2025-08-20 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 4.31 | 2.78 | -0.79 | 11.9 | 0.42% | PROFIT_GIVEBACK_STAGE_HOLD |
| 3 | 2025-08-28 | 2025-09-02 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 98 | 3.17 | 0.95 | -1.27 | 4.8 | -0.21% | atr_day_adverse_382_cut |
| 4 | 2025-09-09 | 2025-09-23 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.72 | 8.47 | 0 | 14 | 3.59% | sl_breached |
| 5 | 2025-10-20 | 2025-10-21 | LONG | tt_ath_breakout | Prime | ? | ? | 100 | 2.19 | 0.38 | -0.91 | 0.9 | -0.91% | doctrine_force_exit |
| 6 | 2025-10-27 | 2025-10-29 | LONG | tt_gap_reversal_long | Prime | ? | ? | 93 | 2.81 | 1.51 | 0 | 2 | 0.85% | TP_FULL |
| 7 | 2025-11-19 | 2025-11-20 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.26 | 2.72 | -2.09 | 1.1 | -0.30% | max_loss_time_scaled |
| 8 | 2025-11-24 | 2025-11-28 | LONG | tt_gap_reversal_long | Prime | ? | ? | 99 | 2.08 | 3.75 | -0.57 | 4 | 0.60% | PROFIT_GIVEBACK_STAGE_HOLD |
| 9 | 2025-12-19 | 2025-12-22 | LONG | tt_gap_reversal_long | Confirmed | PULLBACK_PLAYER | TRANSITIONAL | 98 | 8.61 | 1.38 | -0.02 | 2.8 | 1.38% | ripster_72_89_1h_structural_break |
| 10 | 2026-01-06 | 2026-01-13 | LONG | tt_n_test_support | Prime | PULLBACK_PLAYER | TRANSITIONAL | 100 | 3.37 | 5.8 | -0.45 | 7 | 4.90% | TP_FULL |
| 11 | 2026-01-26 | 2026-01-28 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 94 | 3.23 | 0.93 | -0.34 | 1.9 | 0.15% | SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE |
| 12 | 2026-01-30 | 2026-02-03 | LONG | tt_pullback | Confirmed | PULLBACK_PLAYER | TRENDING | 94 | 2.87 | 1.74 | -0.53 | 4.1 | 0.79% | atr_week_618_full_exit |

## NXT — RESILIENT_TREND · Technology · return 93.7% · max DD -23.3%

**Fundamentals (today):** P/E TTM 31.66 · Fwd 25.91 · PEG 3.17 · FV $126.94 (fair) · current $125.91 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% 1.4 on 94% oracle return → capture 2% · premature exits 0/1 · stopped-out 0 · TP-hit 1 · dominant exit: TP_FULL (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 57.52 | 0 | ↑ | ~ | ↑ | ↓ | 52.47 | 74.63 | b-2 | s-11 | bull | bull | · | 109.33 | 0.526× D | — |
| +5% | 2025-07-02 | 61.04 | 5 | ↑ | ↑ | ↑ | ↑ | 60.54 | 74.63 | s-1 | s-11 | bull | bull | · | 109.33 | 0.558× D | — |
| +15% | 2025-07-03 | 66.31 | 15 | ↑ | ↑ | ↑ | ↑ | 69.02 | 74.63 | s-2 | s-11 | bull | bull | · | 109.33 | 0.607× D | — |
| +30% | 2025-09-29 | 76.13 | 30 | ↑ | ↑ | ↑ | ↑ | 67.12 | 69.92 | s-1 | s-8 | bull | bull | · | 115.29 | 0.66× D | — |
| +50% | 2025-10-13 | 86.96 | 50 | ↑ | ↑ | ↑ | ↓ | 73.07 | 75.37 | s-3 | s-10 | bull | bull | · | 115.29 | 0.754× D | — |
| +75% | 2025-10-29 | 102.67 | 75 | ↑ | ↑ | ↑ | ↑ | 74.87 | 80.97 | s-5 | s-12 | bull | bull | · | 148.19 | 0.693× D | — |
| +100% | 2026-01-28 | 119.97 | 100 | ↑ | ↑ | ↑ | ↑ | 75.43 | 75.54 | s-6 | s-5 | bull | bull | bull | 153.63 | 0.781× D | tt_gap_reversal_long · Prime · 1.42% · exit:TP_FULL |
| peak | 2026-03-25 | 130.42 | 126.74 | ↑ | ↑ | ↑ | ↑ | 64.59 | 63.76 | s-2 | s-1 | bull | bull | bull | 101.04 | 1.291× P | — |
| exit_window | 2026-04-17 | 111.39 | 93.65 | ↑ | ~ | ↓ | ↓ | 47.77 | 56.24 | b-4 | b-2 | bear | bull | bull | 101.04 | 1.102× F | — |

### System trades on NXT during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2026-01-26 | 2026-01-27 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 98 | 3.48 | 2.54 | 0 | 1 | 1.42% | TP_FULL |

## GDX — RESILIENT_TREND · Industrials · return 92.8% · max DD -30.8%

**Fundamentals (today):** P/E TTM 18.06 · Fwd 0 · PEG 0 · FV $· (·) · current $94.5 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 2 closed trades · Σ pnl% 0.6 on 93% oracle return → capture 1% · premature exits 1/2 · stopped-out 0 · TP-hit 0 · dominant exit: HARD_FUSE_RSI_EXTREME (1/2)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 52.04 | 0 | ↑ | ~ | ↑ | ↑ | 51.72 | 59.57 | s-2 | s-7 | bull | bull | · | · | · | — |
| +5% | 2025-08-04 | 54.94 | 5 | ↑ | ↑ | ↑ | ↑ | 60.09 | 63.82 | s-1 | s-1 | bull | bull | · | · | · | tt_gap_reversal_long · Prime · 1.29% · exit:HARD_FUSE_RSI_EXTREME |
| +15% | 2025-08-22 | 60.18 | 15 | ↑ | ↑ | ↑ | ↑ | 68.51 | 66.05 | s-3 | s-3 | bull | bull | · | · | · | — |
| +30% | 2025-09-10 | 68.50 | 30 | ↑ | ↑ | ↑ | ↑ | 80.47 | 74.38 | s-15 | s-6 | bull | bull | · | · | · | — |
| +50% | 2025-10-06 | 78.61 | 50 | ↑ | ↑ | ↑ | ↑ | 81.26 | 76.26 | s-12 | s-10 | bull | bull | · | · | · | — |
| +75% | 2025-12-26 | 91.29 | 75 | ↑ | ↑ | ↑ | ↑ | 72.31 | 75.31 | s-6 | s-6 | bull | bull | · | · | · | — |
| +100% | 2026-01-22 | 105.17 | 100 | ↑ | ↑ | ↑ | ↑ | 78.09 | 78.13 | s-13 | s-10 | bull | bull | bull | · | · | — |
| peak | 2026-02-27 | 115.84 | 122.6 | ↑ | ↑ | ↑ | ↑ | 66.63 | 73.62 | s-7 | s-1 | bull | bull | bull | · | · | — |
| exit_window | 2026-04-17 | 100.34 | 92.81 | ↑ | ↑ | ↑ | ↑ | 57.75 | 57.31 | s-1 | s-2 | bull | bear | bull | · | · | — |

### System trades on GDX during window (n=2)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-06 | 2025-08-07 | LONG | tt_gap_reversal_long | Prime | ? | ? | 95 | 4.09 | 2.05 | 0 | 0.9 | 1.29% | HARD_FUSE_RSI_EXTREME |
| 2 | 2025-10-14 | 2025-10-14 | LONG | tt_n_test_support | Prime | ? | ? | 100 | 2.95 | 0.06 | -0.71 | 0.2 | -0.71% | thesis_flip_htf |

## ASTS — RESILIENT_TREND · Technology · return 89.6% · max DD -47.0%

**Fundamentals (today):** P/E TTM -55.99 · Fwd -429.9 · PEG -429.9 · FV $· (·) · current $74.82 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 18

**Should-have-held diagnosis:** 2 closed trades · Σ pnl% 16.0 on 90% oracle return → capture 18% · premature exits 0/2 · stopped-out 0 · TP-hit 0 · dominant exit: peak_lock_ema12_deep_break (1/2)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 45.11 | 0 | ↑ | ↓ | ↑ | ↓ | 61.96 | 73.65 | b-3 | s-5 | bull | bull | · | 855.50 | 0.053× D | — |
| +5% | 2025-07-14 | 47.86 | 5 | ↑ | ↑ | ↑ | ↑ | 64.01 | 79.94 | s-1 | s-7 | bull | bull | · | 855.50 | 0.056× D | tt_gap_reversal_long · Prime · 6.03% · exit:peak_lock_ema12_deep_break |
| +15% | 2025-07-16 | 52.63 | 15 | ↑ | ↑ | ↑ | ↑ | 70.87 | 79.94 | s-3 | s-7 | bull | bull | · | 855.50 | 0.062× D | tt_gap_reversal_long · Prime · 6.03% · exit:peak_lock_ema12_deep_break |
| +30% | 2025-07-23 | 58.92 | 30 | ↑ | ↑ | ↑ | ↑ | 75.12 | 74.3 | s-8 | s-8 | bull | bull | · | 855.50 | 0.069× D | — |
| +50% | 2025-10-03 | 67.76 | 50 | ↑ | ↑ | ↑ | ↑ | 76.5 | 71.81 | s-3 | s-2 | bull | bull | · | 812.51 | 0.083× D | — |
| +75% | 2025-10-08 | 81.20 | 75 | ↑ | ↑ | ↑ | ↑ | 83.64 | 77.05 | s-6 | s-3 | bull | bull | · | 812.51 | 0.1× D | — |
| +100% | 2025-10-13 | 90.50 | 100 | ↑ | ↑ | ↑ | ↓ | 80.65 | 77.51 | s-9 | s-4 | bull | bull | · | 812.51 | 0.111× D | — |
| peak | 2026-01-29 | 122.09 | 170.65 | ↑ | ↑ | ↑ | ↑ | 64.86 | 70.67 | s-3 | s-9 | bull | bull | bull | -1715.30 | · | — |
| exit_window | 2026-04-17 | 85.53 | 89.6 | ↑ | ↓ | ↓ | ↑ | 46.42 | 52.32 | b-4 | b-1 | bear | bull | bull | -1913.06 | · | — |

### System trades on ASTS during window (n=2)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-15 | 2025-07-25 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 5.26 | 22.02 | 0 | 9.9 | 6.03% | peak_lock_ema12_deep_break |
| 2 | 2026-01-15 | 2026-01-21 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 3.23 | 17.13 | -0.64 | 5.8 | 9.97% | ST_FLIP_4H_CLOSE |

## IESC — RESILIENT_TREND · Industrials · return 85.8% · max DD -21.8%

**Fundamentals (today):** P/E TTM 35.54 · Fwd 30.09 · PEG 0.64 · FV $544.67 (premium) · current $667.06 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 6 closed trades · Σ pnl% 9.0 on 86% oracle return → capture 10% · premature exits 1/6 · stopped-out 1 · TP-hit 1 · dominant exit: TP_FULL (1/6)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 289.30 | 0 | ↑ | ↑ | ↑ | ↑ | 61.65 | 79.14 | s-11 | s-3 | bull | bull | · | 99.30 | 2.913× P | — |
| +5% | 2025-07-03 | 306.41 | 5 | ↑ | ↑ | ↑ | ↑ | 68.9 | 79.14 | s-13 | s-3 | bull | bull | · | 99.30 | 3.086× P | — |
| +15% | 2025-07-25 | 357.66 | 15 | ↑ | ↑ | ↑ | ↑ | 73.63 | 83.42 | s-2 | s-6 | bull | bull | · | 99.30 | 3.602× P | tt_gap_reversal_long · Prime · 5.81% · exit:TP_FULL |
| +30% | 2025-09-10 | 381.19 | 30 | ↑ | ↑ | ↑ | ↑ | 65.43 | 79.52 | s-4 | s-2 | bull | bull | · | 200.11 | 1.905× P | — |
| +50% | 2025-10-24 | 436.98 | 50 | ↑ | ↑ | ↑ | ↑ | 63.9 | 78.04 | s-1 | s-2 | bull | bull | · | 200.11 | 2.184× P | — |
| +75% | 2026-02-11 | 514.36 | 75 | ↑ | ↑ | ↑ | ↑ | 64.22 | 65.01 | s-5 | s-2 | bull | bull | bull | 353.28 | 1.456× P | — |
| peak | 2026-04-14 | 544.14 | 88.09 | ↑ | ↑ | ↑ | ↑ | 64.87 | 63.73 | s-9 | s-3 | bull | bull | bull | 353.28 | 1.54× P | — |
| exit_window | 2026-04-17 | 537.58 | 85.82 | ↑ | ↑ | ↑ | ↓ | 58.49 | 63.73 | b-3 | s-3 | bull | bull | bull | 353.28 | 1.522× P | — |

### System trades on IESC during window (n=6)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-23 | 2025-07-31 | LONG | tt_gap_reversal_long | Prime | ? | ? | 92 | 4.11 | 12.77 | -1.07 | 7.9 | 5.81% | TP_FULL |
| 2 | 2025-08-25 | 2025-08-29 | LONG | tt_gap_reversal_long | Prime | ? | ? | 94 | 4.5 | 5.56 | 0 | 3.9 | 1.60% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 3 | 2025-09-18 | 2025-09-19 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.67 | 0.4 | -1.56 | 1 | -1.56% | phase_i_mfe_cut_4h |
| 4 | 2025-09-26 | 2025-10-03 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.67 | 3.1 | -1.22 | 6.9 | -0.42% | peak_lock_ema12_deep_break |
| 5 | 2025-12-05 | 2025-12-15 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 3.03 | 12.66 | 0 | 9.8 | 5.96% | atr_week_618_full_exit |
| 6 | 2026-02-20 | 2026-02-23 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 97 | 3.01 | 1.22 | -2.39 | 2.9 | -2.39% | max_loss_time_scaled |

## CCJ — RESILIENT_TREND · Energy · return 68.3% · max DD -25.7%

**Fundamentals (today):** P/E TTM 106.98 · Fwd 59.91 · PEG 1.22 · FV $93.29 (premium) · current $116.74 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 6 closed trades · Σ pnl% 10.7 on 68% oracle return → capture 16% · premature exits 2/6 · stopped-out 1 · TP-hit 0 · dominant exit: PROFIT_GIVEBACK_STAGE_HOLD (2/6)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 71.67 | 0 | ↑ | ~ | ↑ | ↑ | 65.43 | 89.58 | s-11 | s-11 | bull | bull | · | 38.94 | 1.841× P | — |
| +5% | 2025-07-15 | 75.80 | 5 | ↑ | ↑ | ↑ | ↑ | 66.78 | 89.65 | s-2 | s-13 | bull | bull | · | 38.94 | 1.947× P | tt_gap_reversal_long · Prime · 4.51% · exit:atr_week_618_full_exit |
| +15% | 2025-09-15 | 86.32 | 15 | ↑ | ↑ | ↑ | ↓ | 68.97 | 79.27 | s-6 | s-2 | bull | bull | · | 73.09 | 1.181× P | — |
| +30% | 2025-10-14 | 93.19 | 30 | ↑ | ↑ | ↑ | ↑ | 72.56 | 76.73 | s-7 | s-6 | bull | bull | · | 73.09 | 1.275× P | — |
| +50% | 2026-01-09 | 107.56 | 50 | ↑ | ↑ | ↑ | ↑ | 73.95 | 71.78 | s-6 | s-5 | bull | bull | bull | 77.88 | 1.381× P | — |
| +75% | 2026-01-27 | 125.97 | 75 | ↑ | ↑ | ↑ | ↓ | 78.79 | 77.56 | s-17 | s-8 | bull | bull | bull | 77.88 | 1.617× P | — |
| peak | 2026-01-28 | 134.09 | 87.09 | ↑ | ↑ | ↑ | ↑ | 83.21 | 77.56 | s-18 | s-8 | bull | bull | bull | 77.88 | 1.722× P | — |
| exit_window | 2026-04-17 | 120.66 | 68.35 | ↑ | ↑ | ↑ | ↑ | 61.89 | 63.96 | s-12 | s-3 | bear | bull | bull | 86.27 | 1.399× P | — |

### System trades on CCJ during window (n=6)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-14 | 2025-07-28 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 4.76 | 8.47 | -0.5 | 13.9 | 4.51% | atr_week_618_full_exit |
| 2 | 2025-09-18 | 2025-09-22 | LONG | tt_pullback | Prime | ? | ? | 100 | 3.24 | 4.72 | 0 | 4 | 1.63% | PROFIT_GIVEBACK_STAGE_HOLD |
| 3 | 2025-12-08 | 2025-12-08 | LONG | tt_pullback | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 3.26 | 0.29 | -0.79 | 0.2 | -0.59% | thesis_flip_htf |
| 4 | 2026-01-15 | 2026-01-30 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 2.84 | 18.57 | -0.43 | 14.8 | 7.95% | ST_FLIP_4H_CLOSE |
| 5 | 2026-02-24 | 2026-02-26 | LONG | tt_pullback | Prime | VOLATILE_RUNNER | TRANSITIONAL | 98 | 3.86 | 2.29 | -0.72 | 1.9 | 0.79% | PROFIT_GIVEBACK_STAGE_HOLD |
| 6 | 2026-03-04 | 2026-03-05 | LONG | tt_pullback | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 3.97 | 0.54 | -3.59 | 0.8 | -3.59% | HARD_LOSS_CAP |

## BWXT — RESILIENT_TREND · Industrials · return 68.0% · max DD -22.1%

**Fundamentals (today):** P/E TTM 55.82 · Fwd 40.44 · PEG 1.81 · FV $178.41 (premium) · current $205.34 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 3 closed trades · Σ pnl% 0.7 on 68% oracle return → capture 1% · premature exits 1/3 · stopped-out 0 · TP-hit 0 · dominant exit: PROFIT_GIVEBACK_STAGE_HOLD (1/3)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 140.37 | 0 | ↑ | ~ | ↑ | ↑ | 67.02 | 80.06 | b-1 | s-11 | bull | bull | · | 134.66 | 1.042× F | — |
| +5% | 2025-07-25 | 147.96 | 5 | ↑ | ↑ | ↑ | ↑ | 68.91 | 77.42 | s-8 | s-2 | bull | bull | · | 134.66 | 1.099× F | tt_gap_reversal_long · Prime · 2.00% · exit:PROFIT_GIVEBACK_STAGE_HOLD |
| +15% | 2025-08-05 | 182.00 | 15 | ↑ | ↑ | ↑ | ↑ | 86.5 | 84.84 | s-2 | s-4 | bull | bull | · | 142.74 | 1.275× P | — |
| +30% | 2025-09-30 | 184.37 | 30 | ↑ | ↑ | ↑ | ↑ | 67.88 | 78 | s-9 | s-3 | bull | bull | · | 142.74 | 1.292× P | — |
| +50% | 2025-10-29 | 213.69 | 50 | ↑ | ↑ | ↑ | ↑ | 66.59 | 84.14 | s-2 | s-7 | bull | bull | · | 142.74 | 1.497× P | — |
| peak | 2026-04-15 | 238.42 | 69.85 | ↑ | ↑ | ↑ | ↑ | 66.47 | 71.29 | s-10 | s-3 | bull | bull | bull | 127.78 | 1.866× P | — |
| exit_window | 2026-04-17 | 235.78 | 67.97 | ↑ | ↑ | ↑ | ↑ | 62.42 | 71.29 | s-12 | s-3 | bull | bull | bull | 127.78 | 1.845× P | — |

### System trades on BWXT during window (n=3)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-23 | 2025-08-01 | LONG | tt_gap_reversal_long | Prime | ? | ? | 96 | 4.11 | 6.78 | -0.39 | 8.8 | 2.00% | PROFIT_GIVEBACK_STAGE_HOLD |
| 2 | 2026-01-06 | 2026-01-08 | LONG | tt_gap_reversal_long | Prime | PULLBACK_PLAYER | TRANSITIONAL | 100 | 3.17 | 5.87 | 0 | 2.1 | 1.62% | PROFIT_GIVEBACK_COOLING_HOLD |
| 3 | 2026-01-27 | 2026-01-28 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.95 | 0.03 | -2.39 | 0.8 | -2.94% | thesis_flip_htf |

## TSM — RESILIENT_TREND · Technology · return 64.9% · max DD -18.4%

**Fundamentals (today):** P/E TTM 35.37 · Fwd 21.38 · PEG 0.61 · FV $329.94 (premium) · current $411.45 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 3 closed trades · Σ pnl% -1.0 on 65% oracle return → capture -2% · premature exits 1/3 · stopped-out 0 · TP-hit 0 · dominant exit: PROFIT_GIVEBACK_STAGE_HOLD (1/3)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 224.68 | 0 | ↑ | ↑ | ↑ | ↑ | 68.75 | 76.69 | s-6 | s-10 | bull | bull | · | 166.32 | 1.351× P | — |
| +5% | 2025-07-15 | 236.95 | 5 | ↑ | ↑ | ↑ | ↑ | 68.96 | 76.05 | s-3 | s-12 | bull | bull | · | 166.32 | 1.425× P | — |
| +15% | 2025-09-10 | 260.44 | 15 | ↑ | ↑ | ↑ | ↑ | 70.14 | 73.34 | s-4 | s-2 | bull | bull | · | 187.48 | 1.389× P | — |
| +30% | 2025-10-03 | 292.19 | 30 | ↑ | ↑ | ↑ | ↑ | 75.44 | 79.9 | s-3 | s-5 | bull | bull | · | 187.48 | 1.559× P | — |
| +50% | 2026-01-15 | 341.64 | 50 | ↑ | ↑ | ↑ | ↑ | 71.17 | 77.4 | s-5 | s-7 | bull | bull | bull | 227.67 | 1.501× P | — |
| peak | 2026-02-25 | 387.73 | 72.57 | ↑ | ↑ | ↑ | ↑ | 72.14 | 78.94 | s-4 | s-13 | bull | bull | bull | 240.50 | 1.612× P | — |
| exit_window | 2026-04-17 | 370.50 | 64.9 | ↑ | ↑ | ↑ | ↑ | 58.51 | 67.6 | s-1 | s-3 | bull | bull | bull | 262.30 | 1.413× P | — |

### System trades on TSM during window (n=3)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-12-09 | 2025-12-11 | LONG | tt_ath_breakout | Prime | PULLBACK_PLAYER | CHOPPY | 98 | 1.76 | 3.91 | -0.12 | 2 | 0.40% | PROFIT_GIVEBACK_STAGE_HOLD |
| 2 | 2026-02-02 | 2026-02-03 | LONG | tt_gap_reversal_long | Confirmed | PULLBACK_PLAYER | TRENDING | 94 | 2.81 | 0.68 | -1.53 | 0.8 | -0.42% | thesis_flip_htf |
| 3 | 2026-04-29 | 2026-04-30 | LONG | tt_momentum | Confirmed | PULLBACK_PLAYER | TRANSITIONAL | 100 | 1.37 | 0.15 | -1.02 | 0.9 | -1.02% | phase_i_mfe_fast_cut_2h |

## CRS — RESILIENT_TREND · Industrials · return 64.0% · max DD -19.1%

**Fundamentals (today):** P/E TTM 45.34 · Fwd 33.79 · PEG 0.97 · FV $379.2 (premium) · current $427.76 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** 4 closed trades · Σ pnl% 3.8 on 64% oracle return → capture 6% · premature exits 0/4 · stopped-out 0 · TP-hit 1 · dominant exit: atr_day_adverse_382_cut (1/4)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 271.75 | 0 | ↑ | ↑ | ↑ | ↑ | 72.02 | 80.02 | s-11 | s-11 | bull | bull | · | 239.56 | 1.134× F | — |
| +5% | 2025-07-17 | 286.73 | 5 | ↑ | ↑ | ↑ | ↑ | 76.76 | 80.48 | s-4 | s-13 | bull | bull | · | 239.56 | 1.197× P | tt_n_test_support · Prime · -0.60% · exit:atr_day_adverse_382_cut |
| +15% | 2025-10-24 | 314.21 | 15 | ↑ | ↑ | ↑ | ↑ | 78.27 | 73.94 | s-4 | s-1 | bull | bull | · | 276.39 | 1.137× F | — |
| +30% | 2026-02-06 | 365.11 | 30 | ↑ | ↑ | ↑ | ↑ | 63.01 | 69.81 | s-4 | s-1 | bull | bull | bull | 214.56 | 1.702× P | tt_gap_reversal_long · Prime · 4.30% · exit:hard_max_hold_504h |
| +50% | 2026-03-02 | 408.50 | 50 | ↑ | ↑ | ↑ | ↑ | 72.35 | 70.28 | s-19 | s-5 | bull | bull | bull | 214.56 | 1.904× P | — |
| peak | 2026-04-17 | 445.69 | 64.01 | ↑ | ↑ | ↑ | ↑ | 63.85 | 75.21 | s-1 | s-3 | bull | bull | bull | 214.56 | 2.077× P | — |
| exit_window | 2026-04-17 | 445.69 | 64.01 | ↑ | ↑ | ↑ | ↑ | 63.85 | 75.21 | s-1 | s-3 | bull | bull | bull | 214.56 | 2.077× P | — |

### System trades on CRS during window (n=4)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-14 | 2025-07-16 | LONG | tt_n_test_support | Prime | ? | ? | 95 | 6.02 | 0.64 | -1.84 | 1.9 | -0.60% | atr_day_adverse_382_cut |
| 2 | 2026-01-15 | 2026-01-16 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 2.74 | 0 | -1.27 | 0.8 | -1.27% | phase_i_mfe_fast_cut_zero_mfe |
| 3 | 2026-01-26 | 2026-01-28 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 99 | 3.65 | 3.74 | -0.5 | 2 | 1.33% | TP_FULL |
| 4 | 2026-02-06 | 2026-02-27 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 94 | 2.35 | 10.54 | -1.58 | 21.1 | 4.30% | hard_max_hold_504h |

## PWR — RESILIENT_TREND · Industrials · return 61.7% · max DD -11.7%

**Fundamentals (today):** P/E TTM 102.91 · Fwd 45.95 · PEG 2 · FV $599.32 (premium) · current $744.84 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 3 closed trades · Σ pnl% 3.9 on 62% oracle return → capture 6% · premature exits 1/3 · stopped-out 0 · TP-hit 1 · dominant exit: doctrine_force_exit (1/3)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 372.29 | 0 | ↑ | ~ | ↑ | ↑ | 64.52 | 84.5 | b-1 | s-11 | bull | bull | · | 429.13 | 0.868× F | — |
| +5% | 2025-07-17 | 397.90 | 5 | ↑ | ↑ | ↑ | ↑ | 72.95 | 84.98 | s-4 | s-13 | bull | bull | · | 429.13 | 0.927× F | — |
| +15% | 2025-10-08 | 443.45 | 15 | ↑ | ↑ | ↑ | ↑ | 74.73 | 73.77 | s-15 | s-5 | bull | bull | · | 455.78 | 0.973× F | — |
| +30% | 2026-02-03 | 488.60 | 30 | ↑ | ↑ | ↑ | ↑ | 66.21 | 72.87 | s-1 | s-4 | bull | bull | bull | 322.08 | 1.517× P | — |
| +50% | 2026-02-24 | 568.21 | 50 | ↑ | ↑ | ↑ | ↑ | 74.28 | 79.44 | s-4 | s-7 | bull | bull | bull | 236.16 | 2.406× P | — |
| peak | 2026-04-17 | 601.88 | 61.67 | ↑ | ↑ | ↑ | ↑ | 64.53 | 77.25 | s-12 | s-3 | bull | bull | bull | 236.16 | 2.549× P | — |
| exit_window | 2026-04-17 | 601.88 | 61.67 | ↑ | ↑ | ↑ | ↑ | 64.53 | 77.25 | s-12 | s-3 | bull | bull | bull | 236.16 | 2.549× P | — |

### System trades on PWR during window (n=3)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2026-03-16 | 2026-03-17 | LONG | tt_ath_breakout | Prime | PULLBACK_PLAYER | TRENDING | 100 | 2.3 | 0.98 | -0.69 | 1 | -0.69% | doctrine_force_exit |
| 2 | 2026-03-19 | 2026-03-20 | LONG | tt_gap_reversal_long | Prime | PULLBACK_PLAYER | TRENDING | 100 | 3.22 | 1.08 | -0.73 | 0.8 | 0.17% | tape_capitulation_force_exit |
| 3 | 2026-04-10 | 2026-04-29 | LONG | tt_momentum | Prime | PULLBACK_PLAYER | TRANSITIONAL | 100 | 2.42 | 9.12 | -0.74 | 19 | 4.42% | TP_FULL |

## HII — RESILIENT_TREND · Industrials · return 60.3% · max DD -18.7%

**Fundamentals (today):** P/E TTM 20.45 · Fwd 15.3 · PEG 0.72 · FV $282.1 (premium) · current $316.21 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 4 closed trades · Σ pnl% 6.5 on 60% oracle return → capture 11% · premature exits 2/4 · stopped-out 1 · TP-hit 0 · dominant exit: max_loss_time_scaled (1/4)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 246.31 | 0 | ↑ | ↑ | ↑ | ↑ | 68.68 | 72.34 | s-5 | s-4 | bull | bull | · | 212.35 | 1.16× P | — |
| +5% | 2025-07-23 | 265.56 | 5 | ↑ | ↑ | ↑ | ↓ | 72.51 | 74.13 | s-2 | s-7 | bull | bull | · | 212.35 | 1.251× P | — |
| +15% | 2025-09-30 | 287.91 | 15 | ↑ | ↑ | ↑ | ↑ | 69.52 | 78.03 | s-3 | s-17 | bull | bull | · | 204.39 | 1.409× P | — |
| +30% | 2025-10-31 | 322.02 | 30 | ↑ | ↑ | ↑ | ↑ | 74.74 | 84.38 | s-9 | s-21 | bull | bull | · | 221.53 | 1.454× P | — |
| +50% | 2026-01-08 | 378.47 | 50 | ↑ | ↑ | ↑ | ↑ | 70.79 | 82.18 | s-4 | s-5 | bull | bull | bull | 221.53 | 1.708× P | tt_gap_reversal_long · Confirmed · 3.46% · exit:mfe_decay_structural_flatten |
| +75% | 2026-02-19 | 443.14 | 75 | ↑ | ↑ | ↑ | ↑ | 64.22 | 77.5 | s-6 | s-1 | bull | bull | bull | 235.14 | 1.885× P | tt_pullback · Prime · 2.54% · exit:PROFIT_GIVEBACK_COOLING_HOLD |
| peak | 2026-03-02 | 453.73 | 84.21 | ↑ | ↑ | ↑ | ↑ | 64.42 | 71.74 | s-3 | s-3 | bull | bull | bull | 235.14 | 1.93× P | — |
| exit_window | 2026-04-17 | 394.81 | 60.29 | ↑ | ↓ | ↓ | ↓ | 45.36 | 57.72 | s-2 | b-6 | bear | bull | bull | 235.14 | 1.679× P | — |

### System trades on HII during window (n=4)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-27 | 2025-09-02 | LONG | tt_gap_reversal_long | Prime | ? | ? | 96 | 3.49 | 0.36 | -2.6 | 5.9 | -2.60% | max_loss_time_scaled |
| 2 | 2025-12-19 | 2025-12-22 | LONG | tt_gap_reversal_long | Prime | PULLBACK_PLAYER | TRENDING | 100 | 2.83 | 3.87 | -0.47 | 2.9 | 3.09% | HARD_FUSE_RSI_EXTREME |
| 3 | 2026-01-09 | 2026-01-15 | LONG | tt_gap_reversal_long | Confirmed | PULLBACK_PLAYER | TRENDING | 97 | 2.51 | 9.18 | -0.51 | 5.8 | 3.46% | mfe_decay_structural_flatten |
| 4 | 2026-02-17 | 2026-02-25 | LONG | tt_pullback | Prime | PULLBACK_PLAYER | TRANSITIONAL | 100 | 2.59 | 7.41 | -0.1 | 7.9 | 2.54% | PROFIT_GIVEBACK_COOLING_HOLD |

## ON — RESILIENT_TREND · Technology · return 54.9% · max DD -28.1%

**Fundamentals (today):** P/E TTM 75.83 · Fwd 24.18 · PEG -0.82 · FV $53.58 (premium) · current $103.2 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 18

**Should-have-held diagnosis:** 2 closed trades · Σ pnl% 3.5 on 55% oracle return → capture 6% · premature exits 1/2 · stopped-out 1 · TP-hit 0 · dominant exit: doctrine_force_exit (1/2)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 53.60 | 0 | ↑ | ↑ | ↑ | ↓ | 61.42 | 69.49 | b-3 | s-10 | bull | bull | · | 60.21 | 0.89× F | — |
| +5% | 2025-07-03 | 56.60 | 5 | ↑ | ↑ | ↑ | ↑ | 68.22 | 69.49 | s-2 | s-10 | bull | bull | · | 60.21 | 0.94× F | — |
| +15% | 2025-07-22 | 62.45 | 15 | ↑ | ↑ | ↑ | ↓ | 73.85 | 65.61 | s-3 | s-13 | bull | bull | · | 60.21 | 1.037× F | — |
| +30% | 2026-02-11 | 71.18 | 30 | ↑ | ↑ | ↑ | ↑ | 71.32 | 73.59 | s-5 | s-12 | bull | bull | bull | 48.12 | 1.479× P | — |
| +50% | 2026-04-17 | 83.01 | 50 | ↑ | ↑ | ↑ | ↑ | 81.35 | 72.17 | s-12 | s-3 | bull | bull | bull | 48.12 | 1.725× P | — |
| peak | 2026-04-17 | 83.01 | 54.87 | ↑ | ↑ | ↑ | ↑ | 81.35 | 72.17 | s-12 | s-3 | bull | bull | bull | 48.12 | 1.725× P | — |
| exit_window | 2026-04-17 | 83.01 | 54.87 | ↑ | ↑ | ↑ | ↑ | 81.35 | 72.17 | s-12 | s-3 | bull | bull | bull | 48.12 | 1.725× P | — |

### System trades on ON during window (n=2)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-10-20 | 2025-10-21 | LONG | tt_gap_reversal_long | Prime | ? | ? | 94 | 1.42 | 0 | -1.52 | 0.9 | -1.52% | doctrine_force_exit |
| 2 | 2026-01-02 | 2026-01-08 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 2.88 | 10.79 | -0.36 | 6 | 4.99% | sl_breached |

## CW — RESILIENT_TREND · Industrials · return 54.3% · max DD -13.0%

**Fundamentals (today):** P/E TTM 53.46 · Fwd 43.25 · PEG 2.77 · FV $618.91 (premium) · current $729.06 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 7 closed trades · Σ pnl% -1.8 on 54% oracle return → capture -3% · premature exits 6/7 · stopped-out 1 · TP-hit 0 · dominant exit: doctrine_force_exit (4/7)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 476.63 | 0 | ↑ | ~ | ↑ | ↑ | 65.64 | 84.05 | s-7 | s-11 | bull | bull | · | 507.29 | 0.94× F | — |
| +5% | 2025-08-05 | 511.64 | 5 | ↑ | ↑ | ↑ | ↑ | 70.07 | 72.65 | s-8 | b-1 | bull | bull | · | 507.29 | 1.009× F | — |
| +15% | 2025-10-06 | 554.06 | 15 | ↑ | ↑ | ↑ | ↑ | 71.63 | 79.16 | s-8 | s-6 | bull | bull | · | 531.51 | 1.042× F | — |
| +30% | 2026-01-12 | 624.60 | 30 | ↑ | ↑ | ↑ | ↑ | 70.5 | 78.14 | s-7 | s-5 | bull | bull | bull | 519.83 | 1.202× P | tt_gap_reversal_long · Confirmed · 2.80% · exit:HARD_FUSE_RSI_EXTREME |
| +50% | 2026-03-02 | 726.48 | 50 | ↑ | ↑ | ↑ | ↑ | 67.96 | 70.16 | s-2 | s-12 | bull | bull | bull | 561.78 | 1.293× P | tt_pullback · Confirmed · -1.24% · exit:doctrine_force_exit |
| peak | 2026-04-14 | 742.61 | 55.8 | ↑ | ↑ | ↑ | ↑ | 63.03 | 72.55 | s-9 | s-3 | bull | bull | bull | 261.21 | 2.843× P | — |
| exit_window | 2026-04-17 | 735.65 | 54.34 | ↑ | ↑ | ↑ | ↑ | 59.19 | 72.55 | s-1 | s-3 | bull | bull | bull | 261.21 | 2.816× P | tt_ath_breakout · Prime · -0.26% · exit:doctrine_force_exit |

### System trades on CW during window (n=7)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-11-03 | 2025-11-04 | LONG | tt_ath_breakout | Confirmed | ? | ? | 92 | 2.59 | 0.12 | -2.45 | 0.9 | -2.45% | doctrine_force_exit |
| 2 | 2026-01-09 | 2026-01-13 | LONG | tt_gap_reversal_long | Confirmed | PULLBACK_PLAYER | TRENDING | 98 | 2.82 | 4.29 | 0 | 3.8 | 2.80% | HARD_FUSE_RSI_EXTREME |
| 3 | 2026-01-15 | 2026-01-21 | LONG | tt_gap_reversal_long | Prime | PULLBACK_PLAYER | TRENDING | 100 | 2.14 | 1.41 | -1.42 | 6 | -0.34% | max_loss_time_scaled |
| 4 | 2026-02-17 | 2026-02-25 | LONG | tt_pullback | Confirmed | PULLBACK_PLAYER | TRANSITIONAL | 99 | 2.58 | 3.15 | -1.74 | 8 | 1.04% | PROFIT_GIVEBACK_STAGE_HOLD |
| 5 | 2026-03-04 | 2026-03-05 | LONG | tt_pullback | Confirmed | PULLBACK_PLAYER | TRENDING | 97 | 3.91 | 0.56 | -1.24 | 0.8 | -1.24% | doctrine_force_exit |
| 6 | 2026-04-17 | 2026-04-20 | LONG | tt_ath_breakout | Prime | PULLBACK_PLAYER | TRANSITIONAL | 92 | 1.86 | 0.64 | -1.15 | 3.1 | -0.26% | doctrine_force_exit |
| 7 | 2026-04-30 | 2026-05-01 | LONG | tt_ath_breakout | Prime | PULLBACK_PLAYER | TRANSITIONAL | 100 | 2.98 | 0.02 | -1.35 | 0.9 | -1.35% | doctrine_force_exit |

## RGLD — RESILIENT_TREND · Basic Materials · return 51.0% · max DD -29.3%

**Fundamentals (today):** P/E TTM 28.87 · Fwd 17.03 · PEG 17.03 · FV $190.78 (premium) · current $238.9 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% 4.7 on 51% oracle return → capture 9% · premature exits 0/1 · stopped-out 0 · TP-hit 1 · dominant exit: TP_FULL (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 177.62 | 0 | ↑ | ↓ | ↓ | ↑ | 49.04 | 59.08 | s-1 | s-1 | bull | bull | · | 99.80 | 1.78× P | — |
| +5% | 2025-09-11 | 189.19 | 5 | ↑ | ↑ | ↑ | ↑ | 71.19 | 62.81 | s-9 | s-6 | bull | bull | · | 109.33 | 1.73× P | — |
| +15% | 2025-10-08 | 205.23 | 15 | ↑ | ↑ | ↑ | ↓ | 68.4 | 62.67 | s-1 | s-10 | bull | bull | · | 109.33 | 1.877× P | — |
| +30% | 2025-12-22 | 231.67 | 30 | ↑ | ↑ | ↑ | ↑ | 77.39 | 73.26 | s-10 | s-6 | bull | bull | · | 119.38 | 1.941× P | — |
| +50% | 2026-01-20 | 277.70 | 50 | ↑ | ↑ | ↑ | ↑ | 86.18 | 80.43 | s-11 | s-10 | bull | bull | bull | 119.38 | 2.326× P | — |
| peak | 2026-03-02 | 304.29 | 71.32 | ↑ | ↑ | ↑ | ↑ | 66.28 | 64.56 | s-6 | s-2 | bull | bull | bull | 124.32 | 2.448× P | — |
| exit_window | 2026-04-17 | 268.12 | 50.95 | ↑ | ↑ | ↑ | ↓ | 55.3 | 57.33 | s-1 | s-2 | bull | bear | bull | 124.32 | 2.157× P | — |

### System trades on RGLD during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2026-01-06 | 2026-01-20 | LONG | tt_gap_reversal_long | Confirmed | PULLBACK_PLAYER | TRANSITIONAL | 93 | 2.64 | 16.1 | -0.54 | 13.9 | 4.67% | TP_FULL |

## BK — RESILIENT_TREND · Financial Services · return 49.0% · max DD -10.2%

**Fundamentals (today):** P/E TTM 16.58 · Fwd 13.9 · PEG 0.39 · FV $140.03 (fair) · current $130.5 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 2 closed trades · Σ pnl% 2.8 on 49% oracle return → capture 6% · premature exits 0/2 · stopped-out 0 · TP-hit 0 · dominant exit: ST_FLIP_4H_CLOSE (2/2)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 90.65 | 0 | ↑ | ~ | ↑ | ↑ | 55.29 | 62.65 | s-1 | s-3 | bull | bull | · | 66.99 | 1.353× P | — |
| +5% | 2025-07-14 | 95.25 | 5 | ↑ | ↑ | ↑ | ↑ | 69.91 | 68.63 | s-9 | s-5 | bull | bull | · | 66.99 | 1.422× P | — |
| +15% | 2025-08-26 | 104.59 | 15 | ↑ | ↑ | ↑ | ↑ | 66.49 | 71.04 | s-4 | s-11 | bull | bull | · | 93.95 | 1.113× F | — |
| +30% | 2025-12-10 | 118.38 | 30 | ↑ | ↑ | ↑ | ↑ | 77.17 | 71.12 | s-12 | s-3 | bull | bull | · | 100.49 | 1.178× P | — |
| peak | 2026-04-17 | 135.10 | 49.03 | ↑ | ↑ | ↑ | ↑ | 79.46 | 73.43 | s-13 | s-3 | bull | bull | bull | 170.26 | 0.793× D | — |
| exit_window | 2026-04-17 | 135.10 | 49.03 | ↑ | ↑ | ↑ | ↑ | 79.46 | 73.43 | s-13 | s-3 | bull | bull | bull | 170.26 | 0.793× D | — |

### System trades on BK during window (n=2)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-17 | 2025-08-01 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 100 | 3.03 | 6.33 | 0 | 14.9 | 2.53% | ST_FLIP_4H_CLOSE |
| 2 | 2025-08-11 | 2025-08-13 | LONG | tt_pullback | Prime | ? | ? | 95 | 2.98 | 0.87 | -0.23 | 1.9 | 0.32% | ST_FLIP_4H_CLOSE |

## BG — RESILIENT_TREND · Consumer Defensive · return 48.6% · max DD -12.5%

**Fundamentals (today):** P/E TTM 33.26 · Fwd 11.58 · PEG -0.43 · FV $66.88 (premium) · current $124.97 · EPS growth class: declining

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% 2.0 on 49% oracle return → capture 4% · premature exits 1/1 · stopped-out 0 · TP-hit 0 · dominant exit: mfe_decay_structural_flatten (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 80.25 | 0 | ↑ | ↓ | ↓ | ↓ | 49.12 | · | b-7 | s-3 | bull | bull | · | 92.17 | 0.871× F | — |
| +5% | 2025-08-22 | 87.11 | 5 | ↑ | ↑ | ↑ | ↑ | 67.7 | 64.18 | s-3 | s-3 | bull | bull | · | 87.31 | 0.998× F | — |
| +15% | 2025-10-15 | 93.09 | 15 | ↑ | ↑ | ↑ | ↑ | 73.62 | 68.11 | s-1 | s-1 | bull | bull | · | 87.31 | 1.066× F | — |
| +30% | 2026-01-14 | 105.46 | 30 | ↑ | ↑ | ↑ | ↑ | 77.52 | 70.82 | s-11 | s-2 | bull | bull | bull | 87.07 | 1.211× P | — |
| +50% | 2026-02-11 | 122.03 | 50 | ↑ | ↑ | ↑ | ↑ | 76.81 | 78.95 | s-7 | s-6 | bull | bull | bull | 72.49 | 1.683× P | — |
| peak | 2026-04-02 | 129.42 | 61.27 | ↑ | ↑ | ↑ | ↑ | 63.39 | 71.3 | s-8 | s-2 | bull | bull | bull | 72.49 | 1.785× P | — |
| exit_window | 2026-04-17 | 119.26 | 48.61 | ↑ | ↓ | ↓ | ↓ | 42.13 | 59.21 | b-9 | s-1 | bull | bull | bull | 64.84 | 1.839× P | — |

### System trades on BG during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-14 | 2025-07-18 | SHORT | tt_gap_reversal_short | Confirmed | ? | ? | 92 | 4.69 | 4.08 | 0 | 4.1 | 1.98% | mfe_decay_structural_flatten |

## MRK — RESILIENT_TREND · Healthcare · return 45.5% · max DD -11.2%

**Fundamentals (today):** P/E TTM 31.63 · Fwd 11.79 · PEG -0.17 · FV $89.84 (premium) · current $111.35 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 15

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 46% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 81.81 | 0 | ↓ | ↑ | ↑ | ↑ | 58.69 | 34.71 | s-1 | s-5 | bear | bull | · | 91.87 | 0.89× F | — |
| +5% | 2025-08-21 | 86.08 | 5 | ↑ | ↑ | ↑ | ↑ | 65.1 | 49.25 | s-8 | s-2 | bull | bull | · | 90.10 | 0.955× F | — |
| +15% | 2025-11-18 | 96.43 | 15 | ↑ | ↑ | ↑ | ↓ | 76.58 | 62.44 | s-8 | s-3 | bull | bull | · | 102.01 | 0.945× F | — |
| +30% | 2025-12-24 | 106.45 | 30 | ↑ | ↑ | ↑ | ↑ | 70.33 | 66.76 | s-9 | s-8 | bull | bull | · | 102.01 | 1.044× F | — |
| +50% | 2026-02-23 | 123.82 | 50 | ↑ | ↑ | ↑ | ↑ | 73.34 | 75.74 | s-6 | s-17 | bull | bull | bull | 72.64 | 1.705× P | — |
| peak | 2026-02-24 | 123.93 | 51.49 | ↑ | ↑ | ↑ | ↑ | 73.51 | 75.74 | s-7 | s-17 | bull | bull | bull | 72.64 | 1.706× P | — |
| exit_window | 2026-04-17 | 119.07 | 45.54 | ↑ | ~ | ↑ | ↓ | 50.67 | 62.75 | b-4 | s-3 | bull | bull | bull | 72.64 | 1.639× P | — |

> *No system trades on MRK in the window — pure missed opportunity.*

## IAU — RESILIENT_TREND · sector? · return 45.2% · max DD -19.2%

**Fundamentals (today):** P/E TTM 0 · Fwd 0 · PEG 0 · FV $· (·) · current $88.86 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 45% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 62.92 | 0 | ↑ | ↑ | ↑ | ↑ | 51.01 | 60.06 | s-1 | s-1 | bear | bull | · | · | · | — |
| +5% | 2025-09-02 | 66.65 | 5 | ↑ | ↑ | ↑ | ↑ | 73.8 | 68.46 | s-7 | s-3 | bull | bull | · | · | · | — |
| +15% | 2025-09-30 | 72.77 | 15 | ↑ | ↑ | ↑ | ↑ | 80.1 | 76.81 | s-27 | s-7 | bull | bull | · | · | · | — |
| +30% | 2025-10-20 | 82.50 | 30 | ↑ | ↑ | ↑ | ↑ | 80.27 | 74.94 | s-41 | s-10 | bull | bull | · | · | · | — |
| +50% | 2026-01-26 | 95.18 | 50 | ↑ | ↑ | ↑ | ↑ | 82.53 | 73.15 | s-5 | s-10 | bull | bull | bull | · | · | — |
| peak | 2026-01-29 | 101.57 | 61.43 | ↑ | ↑ | ↑ | ↑ | 88.27 | 73.15 | s-8 | s-10 | bull | bull | bull | · | · | — |
| exit_window | 2026-04-17 | 91.34 | 45.17 | ↑ | ↑ | ↑ | ↑ | 54.63 | 59.38 | s-7 | s-1 | bull | bull | bull | · | · | — |

> *No system trades on IAU in the window — pure missed opportunity.*

## GLD — RESILIENT_TREND · sector? · return 45.0% · max DD -19.2%

**Fundamentals (today):** P/E TTM 0 · Fwd 0 · PEG 0 · FV $· (·) · current $433.81 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** 3 closed trades · Σ pnl% 2.1 on 45% oracle return → capture 5% · premature exits 1/3 · stopped-out 0 · TP-hit 1 · dominant exit: SOFT_FUSE_RSI_CONFIRMED (1/3)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 307.55 | 0 | ↑ | ↑ | ↑ | ↑ | 51.05 | 61.96 | s-1 | s-1 | bear | bull | · | · | · | — |
| +5% | 2025-09-02 | 325.59 | 5 | ↑ | ↑ | ↑ | ↑ | 73.73 | 69.77 | s-7 | s-3 | bull | bull | · | · | · | — |
| +15% | 2025-09-30 | 355.47 | 15 | ↑ | ↑ | ↑ | ↑ | 80.16 | 77.82 | s-27 | s-7 | bull | bull | · | · | · | — |
| +30% | 2025-10-20 | 403.15 | 30 | ↑ | ↑ | ↑ | ↑ | 80.23 | 75.5 | s-41 | s-10 | bull | bull | · | · | · | — |
| +50% | 2026-01-26 | 464.70 | 50 | ↑ | ↑ | ↑ | ↑ | 82.57 | 73.1 | s-5 | s-10 | bull | bull | bull | · | · | — |
| peak | 2026-01-29 | 495.90 | 61.24 | ↑ | ↑ | ↑ | ↑ | 88.3 | 73.1 | s-8 | s-10 | bull | bull | bull | · | · | — |
| exit_window | 2026-04-17 | 445.93 | 44.99 | ↑ | ↑ | ↑ | ↑ | 54.64 | 59.38 | s-7 | s-1 | bull | bull | bull | · | · | — |

### System trades on GLD during window (n=3)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-26 | 2025-08-28 | LONG | tt_ath_breakout | Prime | ? | ? | 96 | 3.73 | 0.79 | -0.11 | 1.9 | 0.71% | SOFT_FUSE_RSI_CONFIRMED |
| 2 | 2026-02-11 | 2026-02-12 | LONG | tt_n_test_support | Confirmed | SLOW_GRINDER | TRANSITIONAL | 100 | 2.18 | 0.01 | -0.58 | 0.8 | -0.58% | doctrine_force_exit |
| 3 | 2026-02-25 | 2026-03-02 | LONG | tt_momentum | Confirmed | SLOW_GRINDER | TRANSITIONAL | 94 | 1.49 | 3.06 | -0.48 | 5 | 1.93% | TP_FULL |

## ITT — RESILIENT_TREND · Industrials · return 38.1% · max DD -13.3%

**Fundamentals (today):** P/E TTM 36.65 · Fwd 22.52 · PEG -1.11 · FV $166.23 (premium) · current $206.2 · EPS growth class: declining

**Cohort metrics:** weekly EMA-21 break streak = 2 · daily 5/12 cloud break streak = 16

**Should-have-held diagnosis:** 3 closed trades · Σ pnl% 0.0 on 38% oracle return → capture 0% · premature exits 0/3 · stopped-out 0 · TP-hit 0 · dominant exit: SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE (2/3)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 158.56 | 0 | ↑ | ↑ | ↑ | ↑ | 68.11 | 70.52 | s-8 | s-3 | bull | bull | · | 132.85 | 1.194× P | — |
| +5% | 2025-07-31 | 169.96 | 5 | ↑ | ↑ | ↑ | ↓ | 71.93 | 70.34 | s-5 | s-7 | bull | bull | · | 136.23 | 1.248× P | tt_pullback · Confirmed · -0.05% · exit:SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE |
| +15% | 2025-09-18 | 182.88 | 15 | ↑ | ↑ | ↑ | ↑ | 68.39 | 77.59 | s-10 | s-14 | bull | bull | · | 136.23 | 1.342× P | — |
| +30% | 2026-02-06 | 206.87 | 30 | ↑ | ↑ | ↑ | ↑ | 76.34 | 72.75 | s-5 | s-5 | bull | bull | bull | 151.32 | 1.367× P | tt_gap_reversal_long · Confirmed · -0.05% · exit:SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE |
| peak | 2026-04-14 | 221.69 | 39.81 | ↑ | ↑ | ↑ | ↑ | 73.88 | 68.53 | s-9 | s-3 | bull | bull | bull | 151.32 | 1.465× P | — |
| exit_window | 2026-04-17 | 219.02 | 38.13 | ↑ | ↑ | ↑ | ↑ | 66.06 | 68.53 | b-3 | s-3 | bull | bull | bull | 151.32 | 1.447× P | — |

### System trades on ITT during window (n=3)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-28 | 2025-07-29 | LONG | tt_pullback | Confirmed | ? | ? | 96 | 5.02 | 0.68 | -1.39 | 1.2 | -0.05% | SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE |
| 2 | 2025-08-04 | 2025-08-07 | LONG | tt_pullback | Confirmed | ? | ? | 99 | 6.02 | 1.03 | -1.64 | 3.1 | 0.12% | eod_trimmed_underwater_flatten |
| 3 | 2026-02-06 | 2026-02-09 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 100 | 2.26 | 0.9 | -1.21 | 3.1 | -0.05% | SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE |

## RTX — RESILIENT_TREND · Industrials · return 36.2% · max DD -11.8%

**Fundamentals (today):** P/E TTM 33.09 · Fwd 23.4 · PEG 1 · FV $150.18 (premium) · current $176.07 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% -1.6 on 36% oracle return → capture -4% · premature exits 0/1 · stopped-out 0 · TP-hit 0 · dominant exit: phase_i_mfe_fast_cut_zero_mfe (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 144.19 | 0 | ↑ | ~ | ↑ | ↑ | 57.07 | 61.1 | s-2 | s-10 | bull | bull | · | 98.53 | 1.463× P | — |
| +5% | 2025-07-17 | 151.50 | 5 | ↑ | ↑ | ↑ | ↑ | 69.59 | 64.76 | s-8 | s-12 | bull | bull | · | 98.53 | 1.538× P | — |
| +15% | 2025-09-30 | 167.33 | 15 | ↑ | ↑ | ↑ | ↑ | 72.92 | 71.5 | s-7 | s-6 | bull | bull | · | 135.04 | 1.239× P | — |
| +30% | 2026-01-05 | 188.26 | 30 | ↑ | ↑ | ↑ | ↑ | 68.13 | 70.89 | s-2 | s-5 | bull | bull | bull | 140.89 | 1.336× P | — |
| peak | 2026-03-02 | 212.16 | 47.14 | ↑ | ↑ | ↑ | ↑ | 67.11 | 73.36 | s-2 | s-3 | bull | bull | bull | 162.42 | 1.306× P | — |
| exit_window | 2026-04-17 | 196.42 | 36.22 | ↑ | ↓ | ↓ | ↓ | 45.81 | 56.23 | b-4 | b-5 | bear | bull | bull | 162.42 | 1.209× P | — |

### System trades on RTX during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-06 | 2025-08-07 | LONG | tt_n_test_support | Prime | ? | ? | 100 | 2.77 | 0 | -1.61 | 0.9 | -1.61% | phase_i_mfe_fast_cut_zero_mfe |

## JCI — RESILIENT_TREND · Industrials · return 34.6% · max DD -13.0%

**Fundamentals (today):** P/E TTM 42.82 · Fwd 24.62 · PEG 1.12 · FV $112.01 (premium) · current $139.53 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 14

**Should-have-held diagnosis:** 4 closed trades · Σ pnl% -1.2 on 35% oracle return → capture -4% · premature exits 2/4 · stopped-out 0 · TP-hit 1 · dominant exit: PROFIT_GIVEBACK_STAGE_HOLD (2/4)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 104.67 | 0 | ↑ | ↑ | ↑ | ↑ | 63.51 | 77.9 | s-4 | s-11 | bull | bull | · | 95.54 | 1.096× F | — |
| +5% | 2025-07-23 | 110.13 | 5 | ↑ | ↑ | ↑ | ↑ | 72.27 | 79.39 | s-6 | s-14 | bull | bull | · | 95.54 | 1.153× P | — |
| +15% | 2025-11-05 | 120.86 | 15 | ↑ | ↑ | ↑ | ↓ | 70.18 | 75.68 | s-1 | s-4 | bull | bull | · | 123.86 | 0.976× F | — |
| +30% | 2026-02-06 | 137.65 | 30 | ↑ | ↑ | ↑ | ↑ | 82.23 | 71.32 | s-10 | s-1 | bull | bull | bull | 119.92 | 1.148× F | — |
| peak | 2026-03-02 | 145.46 | 38.97 | ↑ | ↑ | ↑ | ↑ | 73.59 | 60.66 | s-2 | b-1 | bull | bull | bull | 119.92 | 1.213× P | tt_ath_breakout · Prime · -3.86% · exit:tape_capitulation_force_exit |
| exit_window | 2026-04-17 | 140.87 | 34.58 | ↑ | ↑ | ↑ | ↓ | 57.47 | 64.93 | b-3 | s-3 | bull | bull | bull | 119.92 | 1.175× P | — |

### System trades on JCI during window (n=4)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-12-15 | 2025-12-17 | LONG | tt_pullback | Confirmed | PULLBACK_PLAYER | TRANSITIONAL | 95 | 3.21 | 2.6 | 0 | 1.9 | 1.26% | PROFIT_GIVEBACK_STAGE_HOLD |
| 2 | 2026-02-02 | 2026-02-03 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.65 | 0.53 | 0 | 0.8 | 0.57% | TP_FULL |
| 3 | 2026-02-17 | 2026-02-26 | LONG | tt_gap_reversal_long | Prime | PULLBACK_PLAYER | TRENDING | 100 | 2.72 | 3.49 | -1.31 | 8.9 | 0.81% | PROFIT_GIVEBACK_STAGE_HOLD |
| 4 | 2026-03-02 | 2026-03-03 | LONG | tt_ath_breakout | Prime | PULLBACK_PLAYER | TRENDING | 97 | 3.47 | 0 | -3.86 | 0.8 | -3.86% | tape_capitulation_force_exit |

## XOM — RESILIENT_TREND · Energy · return 34.0% · max DD -14.6%

**Fundamentals (today):** P/E TTM 24.65 · Fwd 14.34 · PEG -0.57 · FV $94.44 (premium) · current $144.4 · EPS growth class: declining

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 12

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 34% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 109.24 | 0 | ↑ | ~ | ↑ | ↓ | 51.81 | 44.56 | s-1 | s-4 | bull | bull | · | 107.44 | 1.017× F | — |
| +5% | 2025-07-10 | 114.93 | 5 | ↑ | ↑ | ↑ | ↑ | 63.15 | 48.11 | s-7 | s-5 | bull | bull | · | 107.44 | 1.07× F | — |
| +15% | 2026-01-13 | 126.54 | 15 | ↑ | ↑ | ↑ | ↑ | 63.83 | 67.14 | s-2 | s-4 | bull | bull | bull | 99.69 | 1.269× P | — |
| +30% | 2026-02-03 | 143.73 | 30 | ↑ | ↑ | ↑ | ↓ | 76.04 | 79.2 | s-16 | s-7 | bull | bull | bull | 100.26 | 1.434× P | — |
| +50% | 2026-03-24 | 165.38 | 50 | ↑ | ↑ | ↑ | ↑ | 74.17 | 84.68 | s-10 | s-14 | bull | bull | bull | 112.60 | 1.469× P | — |
| peak | 2026-03-30 | 171.47 | 56.97 | ↑ | ↑ | ↑ | ↑ | 76.47 | 70.28 | s-14 | s-15 | bull | bull | bull | 112.60 | 1.523× P | — |
| exit_window | 2026-04-17 | 146.44 | 34.05 | ↑ | ↓ | ↓ | ↓ | 36.49 | 55.71 | b-12 | b-2 | bear | bull | bull | 112.60 | 1.301× P | — |

> *No system trades on XOM in the window — pure missed opportunity.*

## NOC — RESILIENT_TREND · Industrials · return 32.1% · max DD -14.5%

**Fundamentals (today):** P/E TTM 17.19 · Fwd 18.16 · PEG 0.2 · FV $478.8 (premium) · current $549.49 · EPS growth class: exploding

**Cohort metrics:** weekly EMA-21 break streak = 1 · daily 5/12 cloud break streak = 22

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% 0.6 on 32% oracle return → capture 2% · premature exits 0/1 · stopped-out 0 · TP-hit 0 · dominant exit: stagnant_no_commitment (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 503.53 | 0 | ↑ | ↑ | ↑ | ↓ | 57.33 | 48.49 | s-2 | s-5 | bull | bull | · | 418.93 | 1.202× P | — |
| +5% | 2025-07-22 | 563.79 | 5 | ↑ | ↑ | ↑ | ↓ | 76.23 | 60.4 | s-1 | s-2 | bull | bull | · | 451.43 | 1.249× P | — |
| +15% | 2025-08-01 | 586.44 | 15 | ↑ | ↑ | ↑ | ↑ | 81.08 | 62.82 | s-9 | s-3 | bull | bull | · | 451.43 | 1.299× P | — |
| +30% | 2026-01-15 | 654.61 | 30 | ↑ | ↑ | ↑ | ↑ | 71.25 | 69.91 | s-10 | s-6 | bull | bull | bull | 211.73 | 3.092× P | — |
| +50% | 2026-03-02 | 768.02 | 50 | ↑ | ↑ | ↑ | ↑ | 70.35 | 78.88 | s-1 | s-13 | bull | bull | bull | 282.73 | 2.716× P | — |
| peak | 2026-03-02 | 768.02 | 52.53 | ↑ | ↑ | ↑ | ↑ | 70.35 | 78.88 | s-1 | s-13 | bull | bull | bull | 282.73 | 2.716× P | — |
| exit_window | 2026-04-17 | 665.26 | 32.12 | ↓ | ↓ | ↓ | ↓ | 36.74 | 52.3 | b-8 | b-5 | bear | bull | bull | 282.73 | 2.353× P | — |

### System trades on NOC during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-15 | 2025-09-02 | LONG | tt_n_test_support | Prime | ? | ? | 100 | 4.09 | 2.29 | -0.35 | 17.8 | 0.59% | stagnant_no_commitment |

## WDC — CLEAN_TREND · Technology · return 483.5% · max DD -20.6%

**Fundamentals (today):** P/E TTM 28.41 · Fwd 27.24 · PEG 0.05 · FV $417.18 (premium) · current $480.01 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 8

**Should-have-held diagnosis:** 3 closed trades · Σ pnl% 2.5 on 484% oracle return → capture 1% · premature exits 2/3 · stopped-out 1 · TP-hit 0 · dominant exit: SMART_RUNNER_SUPPORT_BREAK_CLOUD (2/3)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 63.84 | 0 | ↑ | ↑ | ↑ | ↑ | 84.02 | 77.2 | s-11 | s-11 | bull | bull | · | 85.25 | 0.749× D | — |
| +5% | 2025-07-15 | 67.53 | 5 | ↑ | ↑ | ↑ | ↑ | 79.75 | 78.23 | s-3 | s-13 | bull | bull | · | 85.25 | 0.792× D | — |
| +15% | 2025-07-31 | 78.69 | 15 | ↑ | ↑ | ↑ | ↑ | 85.3 | 82.35 | s-15 | s-15 | bull | bull | · | 130.46 | 0.603× D | — |
| +30% | 2025-09-03 | 86.00 | 30 | ↑ | ↑ | ↑ | ↑ | 76.24 | 86.36 | s-8 | s-20 | bull | bull | · | 130.46 | 0.659× D | — |
| +50% | 2025-09-11 | 96.15 | 50 | ↑ | ↑ | ↑ | ↑ | 85.42 | 87.86 | s-14 | s-21 | bull | bull | · | 130.46 | 0.737× D | — |
| +75% | 2025-09-22 | 112.41 | 75 | ↑ | ↑ | ↑ | ↑ | 88.12 | 89.85 | s-21 | s-23 | bull | bull | · | 130.46 | 0.862× F | — |
| +100% | 2025-10-01 | 130.59 | 100 | ↑ | ↑ | ↑ | ↑ | 86.3 | 93.24 | s-3 | s-24 | bull | bull | · | 130.46 | 1.001× F | — |
| peak | 2026-04-17 | 372.52 | 483.52 | ↑ | ↑ | ↑ | ↑ | 70.81 | 80.36 | s-12 | s-3 | bull | bull | bull | 128.01 | 2.91× P | — |
| exit_window | 2026-04-17 | 372.52 | 483.52 | ↑ | ↑ | ↑ | ↑ | 70.81 | 80.36 | s-12 | s-3 | bull | bull | bull | 128.01 | 2.91× P | — |

### System trades on WDC during window (n=3)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-08-25 | 2025-08-29 | LONG | tt_gap_reversal_long | Prime | ? | ? | 96 | 3.67 | 4.84 | -1.55 | 4.3 | 0.07% | max_loss_time_scaled |
| 2 | 2025-12-19 | 2025-12-22 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 3.11 | 1.51 | -2.78 | 2.9 | -0.64% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 3 | 2026-02-17 | 2026-02-19 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 4.22 | 8.98 | 0 | 1.9 | 3.02% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |

## STX — CLEAN_TREND · Technology · return 277.6% · max DD -21.0%

**Fundamentals (today):** P/E TTM 73.54 · Fwd 29.62 · PEG 0.66 · FV $622.46 (premium) · current $782.64 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 10

**Should-have-held diagnosis:** 9 closed trades · Σ pnl% 10.4 on 278% oracle return → capture 4% · premature exits 3/9 · stopped-out 2 · TP-hit 2 · dominant exit: TP_FULL (2/9)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 145.04 | 0 | ↑ | ↑ | ↑ | ↑ | 86.17 | 81.97 | s-11 | s-10 | bull | bull | · | 194.28 | 0.747× D | — |
| +5% | 2025-07-23 | 152.76 | 5 | ↑ | ↑ | ↑ | ↓ | 69 | 80.87 | s-1 | s-13 | bull | bull | · | 194.28 | 0.786× D | tt_gap_reversal_long · Prime · 3.37% · exit:TP_FULL |
| +15% | 2025-08-27 | 167.24 | 15 | ↑ | ↑ | ↑ | ↑ | 69.1 | 81.85 | s-12 | s-18 | bull | bull | · | 239.88 | 0.697× D | tt_gap_reversal_long · Confirmed · 5.64% · exit:TP_FULL |
| +30% | 2025-09-08 | 189.24 | 30 | ↑ | ↑ | ↑ | ↑ | 78.58 | 86.88 | s-19 | s-20 | bull | bull | · | 239.88 | 0.789× D | — |
| +50% | 2025-09-19 | 221.23 | 50 | ↑ | ↑ | ↑ | ↑ | 88.65 | 89.73 | s-28 | s-21 | bull | bull | · | 239.88 | 0.922× F | — |
| +75% | 2025-10-01 | 256.84 | 75 | ↑ | ↑ | ↑ | ↑ | 85.04 | 90.11 | s-3 | s-23 | bull | bull | · | 239.88 | 1.071× F | — |
| +100% | 2025-11-10 | 293.99 | 100 | ↑ | ↑ | ↑ | ↑ | 69.97 | 70.65 | s-4 | s-29 | bull | bull | · | 270.39 | 1.087× F | — |
| peak | 2026-04-17 | 547.75 | 277.65 | ↑ | ↑ | ↑ | ↑ | 72.35 | 76.72 | s-12 | s-3 | bull | bull | bull | 302.37 | 1.812× P | — |
| exit_window | 2026-04-17 | 547.75 | 277.65 | ↑ | ↑ | ↑ | ↑ | 72.35 | 76.72 | s-12 | s-3 | bull | bull | bull | 302.37 | 1.812× P | — |

### System trades on STX during window (n=9)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-23 | 2025-07-28 | LONG | tt_gap_reversal_long | Prime | ? | ? | 93 | 3.66 | 1.7 | -1.03 | 4.8 | 3.37% | TP_FULL |
| 2 | 2025-08-18 | 2025-08-20 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.1 | 0.81 | -2.59 | 2 | -2.59% | atr_day_adverse_382_cut |
| 3 | 2025-08-25 | 2025-09-05 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 96 | 2.45 | 14.62 | 0 | 11 | 5.64% | TP_FULL |
| 4 | 2025-09-11 | 2025-09-12 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 1.94 | 1.3 | -1.5 | 1 | -0.36% | atr_day_adverse_382_cut |
| 5 | 2025-09-15 | 2025-09-25 | LONG | tt_gap_reversal_long | Prime | ? | ? | 94 | 1.81 | 11.19 | -0.88 | 10 | 4.62% | sl_breached |
| 6 | 2025-10-23 | 2025-10-27 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 6.27 | 6.64 | -0.43 | 4 | 2.52% | mfe_decay_structural_flatten |
| 7 | 2025-12-08 | 2025-12-12 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 2.82 | 9.16 | -0.22 | 4.1 | 1.59% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 8 | 2026-01-06 | 2026-01-07 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRANSITIONAL | 100 | 2.96 | 4.87 | -2.04 | 1 | 0.21% | max_loss |
| 9 | 2026-03-25 | 2026-03-26 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | CHOPPY | 94 | 2.38 | 0 | -4.58 | 0.8 | -4.58% | doctrine_force_exit |

## FIX — CLEAN_TREND · Industrials · return 216.4% · max DD -13.8%

**Fundamentals (today):** P/E TTM 55.53 · Fwd 36.68 · PEG 0.46 · FV $1586.38 (premium) · current $1951.67 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 10

**Should-have-held diagnosis:** 9 closed trades · Σ pnl% 4.4 on 216% oracle return → capture 2% · premature exits 2/9 · stopped-out 2 · TP-hit 0 · dominant exit: PROFIT_GIVEBACK_COOLING_HOLD (1/9)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 521.66 | 0 | ↑ | ~ | ↑ | ↑ | 63 | 84.95 | s-8 | s-11 | bull | bull | · | 611.08 | 0.854× F | tt_pullback · Prime · 0.95% · exit:PROFIT_GIVEBACK_COOLING_HOLD |
| +5% | 2025-07-17 | 550.50 | 5 | ↑ | ↑ | ↑ | ↑ | 67.42 | 85.32 | s-4 | s-13 | bull | bull | · | 611.08 | 0.901× F | — |
| +15% | 2025-07-25 | 688.74 | 15 | ↑ | ↑ | ↑ | ↑ | 84.25 | 90.28 | s-2 | s-14 | bull | bull | · | 713.41 | 0.965× F | — |
| +30% | 2025-07-25 | 688.74 | 30 | ↑ | ↑ | ↑ | ↑ | 84.25 | 90.28 | s-2 | s-14 | bull | bull | · | 713.41 | 0.965× F | — |
| +50% | 2025-09-18 | 799.38 | 50 | ↑ | ↑ | ↑ | ↑ | 69.49 | 90.88 | s-1 | s-22 | bull | bull | · | 713.41 | 1.121× F | tt_gap_reversal_long · Prime · -0.03% · exit:SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| +75% | 2025-10-24 | 981.66 | 75 | ↑ | ↑ | ↑ | ↑ | 73.93 | 94.46 | s-1 | s-27 | bull | bull | · | 866.00 | 1.134× F | — |
| +100% | 2026-01-13 | 1073.14 | 100 | ↑ | ↑ | ↑ | ↑ | 63.48 | 80.33 | s-2 | s-3 | bull | bull | bull | 826.75 | 1.298× P | tt_gap_reversal_long · Prime · -3.28% · exit:max_loss_time_scaled_momentum_buffered |
| peak | 2026-04-14 | 1650.48 | 216.39 | ↑ | ↑ | ↑ | ↑ | 68.61 | 80.52 | s-9 | s-3 | bull | bull | bull | 777.60 | 2.123× P | — |
| exit_window | 2026-04-17 | 1650.47 | 216.39 | ↑ | ↑ | ↑ | ↑ | 66.01 | 80.52 | s-12 | s-3 | bull | bull | bull | 777.60 | 2.123× P | — |

### System trades on FIX during window (n=9)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-01 | 2025-07-08 | LONG | tt_pullback | Prime | ? | ? | 94 | 5.54 | 4.86 | -0.15 | 6.9 | 0.95% | PROFIT_GIVEBACK_COOLING_HOLD |
| 2 | 2025-08-12 | 2025-08-13 | LONG | tt_gap_reversal_long | Prime | ? | ? | 99 | 4.15 | 5.04 | 0 | 1 | 0.96% | PROFIT_GIVEBACK |
| 3 | 2025-08-26 | 2025-08-29 | LONG | tt_gap_reversal_long | Prime | ? | ? | 94 | 6.06 | 3.66 | -1.74 | 3.1 | -0.23% | thesis_flip_htf |
| 4 | 2025-09-15 | 2025-09-25 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 3.26 | 6.5 | -1.15 | 9.9 | -0.03% | SMART_RUNNER_SUPPORT_BREAK_CLOUD |
| 5 | 2025-10-08 | 2025-10-09 | LONG | tt_gap_reversal_long | Confirmed | ? | ? | 93 | 2.79 | 0.1 | -2.31 | 0.8 | -2.31% | doctrine_force_exit |
| 6 | 2026-01-13 | 2026-01-14 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 100 | 3.3 | 0.6 | -3.28 | 0.9 | -3.28% | max_loss_time_scaled_momentum_buffered |
| 7 | 2026-02-02 | 2026-02-04 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 4.24 | 4.49 | 0 | 1.8 | 3.79% | ST_FLIP_4H_CLOSE |
| 8 | 2026-02-06 | 2026-02-13 | LONG | tt_gap_reversal_long | Confirmed | VOLATILE_RUNNER | TRANSITIONAL | 98 | 2.58 | 13.94 | 0 | 6.8 | 5.45% | sl_breached |
| 9 | 2026-02-20 | 2026-02-23 | LONG | tt_gap_reversal_long | Prime | VOLATILE_RUNNER | TRENDING | 96 | 2.13 | 2.73 | -2.81 | 3.1 | -0.89% | runner_drawdown_cap |

## LRCX — CLEAN_TREND · Technology · return 176.4% · max DD -20.1%

**Fundamentals (today):** P/E TTM 56.07 · Fwd 37.55 · PEG 1.39 · FV $248.8 (premium) · current $294.06 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 10

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% -1.1 on 176% oracle return → capture -1% · premature exits 0/1 · stopped-out 1 · TP-hit 0 · dominant exit: max_loss (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 96.81 | 0 | ↑ | ↑ | ↑ | ↑ | 70.24 | 69.28 | s-6 | s-10 | bull | bull | · | 135.95 | 0.712× D | — |
| +5% | 2025-07-11 | 101.73 | 5 | ↑ | ↑ | ↑ | ↑ | 76.41 | 70.63 | s-13 | s-11 | bull | bull | · | 135.95 | 0.748× D | tt_pullback · Prime · -1.10% · exit:max_loss |
| +15% | 2025-09-11 | 115.58 | 15 | ↑ | ↑ | ↑ | ↑ | 72.76 | 75.17 | s-5 | s-4 | bull | bull | · | 155.48 | 0.743× D | — |
| +30% | 2025-09-18 | 126.32 | 30 | ↑ | ↑ | ↑ | ↑ | 81.2 | 78.96 | s-10 | s-5 | bull | bull | · | 155.48 | 0.812× D | — |
| +50% | 2025-10-02 | 146.99 | 50 | ↑ | ↑ | ↑ | ↑ | 85.77 | 84.23 | s-3 | s-7 | bull | bull | · | 155.48 | 0.945× F | — |
| +75% | 2025-12-19 | 172.27 | 75 | ↑ | ↑ | ↑ | ↑ | 61.63 | 74.49 | s-2 | s-2 | bull | bull | · | 50.70 | 3.398× P | — |
| +100% | 2026-01-05 | 194.76 | 100 | ↑ | ↑ | ↑ | ↑ | 71.97 | 84.01 | s-2 | s-5 | bull | bull | bull | 50.70 | 3.841× P | — |
| peak | 2026-04-14 | 272.41 | 181.39 | ↑ | ↑ | ↑ | ↑ | 69.6 | 70.45 | s-9 | s-3 | bull | bull | bull | 81.87 | 3.327× P | — |
| exit_window | 2026-04-17 | 267.60 | 176.42 | ↑ | ↑ | ↑ | ↑ | 64.59 | 70.45 | s-1 | s-3 | bull | bull | bull | 81.87 | 3.269× P | — |

### System trades on LRCX during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-09 | 2025-07-16 | LONG | tt_pullback | Prime | ? | ? | 100 | 2.62 | 1.62 | -3.16 | 6.8 | -1.10% | max_loss |

## LSCC — CLEAN_TREND · Technology · return 133.5% · max DD -19.3%

**Fundamentals (today):** P/E TTM 892.79 · Fwd 54.08 · PEG 2.98 · FV $99.99 (premium) · current $127.11 · EPS growth class: explosive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 10

**Should-have-held diagnosis:** 1 closed trades · Σ pnl% 0.8 on 133% oracle return → capture 1% · premature exits 0/1 · stopped-out 0 · TP-hit 1 · dominant exit: TP_FULL (1/1)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 50.14 | 0 | ↑ | ↑ | ↑ | ↓ | 51.76 | 46.95 | b-2 | s-3 | bear | bull | · | 45.43 | 1.104× F | — |
| +5% | 2025-07-08 | 53.65 | 5 | ↑ | ↑ | ↑ | ↓ | 60.65 | 48.7 | s-4 | s-4 | bull | bull | · | 45.43 | 1.181× P | — |
| +15% | 2025-08-07 | 60.72 | 15 | ↑ | ↑ | ↑ | ↑ | 69.55 | 56.32 | s-3 | s-1 | bull | bull | · | 45.97 | 1.321× P | — |
| +30% | 2025-08-13 | 65.22 | 30 | ↑ | ↑ | ↑ | ↑ | 74.07 | 57.93 | s-7 | s-2 | bull | bull | · | 45.97 | 1.419× P | — |
| +50% | 2025-12-04 | 75.83 | 50 | ↑ | ↑ | ↑ | ↑ | 66.12 | 64.65 | s-9 | s-1 | bull | bull | · | 23.25 | 3.262× P | — |
| +75% | 2026-02-10 | 90.95 | 75 | ↑ | ↑ | ↑ | ↑ | 67.86 | 72.75 | s-4 | s-6 | bull | bull | bull | -1.62 | · | — |
| +100% | 2026-02-11 | 105.77 | 100 | ↑ | ↑ | ↑ | ↑ | 80.64 | 72.75 | s-5 | s-6 | bull | bull | bull | -1.62 | · | — |
| peak | 2026-04-17 | 117.06 | 133.47 | ↑ | ↑ | ↑ | ↑ | 69.84 | 76.25 | s-12 | s-3 | bull | bull | bull | -1.62 | · | — |
| exit_window | 2026-04-17 | 117.06 | 133.47 | ↑ | ↑ | ↑ | ↑ | 69.84 | 76.25 | s-12 | s-3 | bull | bull | bull | -1.62 | · | — |

### System trades on LSCC during window (n=1)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-10-31 | 2025-11-03 | LONG | tt_pullback | Prime | ? | ? | 93 | 3.19 | 0.46 | -0.85 | 2.8 | 0.75% | TP_FULL |

## ENS — CLEAN_TREND · Industrials · return 124.2% · max DD -18.3%

**Fundamentals (today):** P/E TTM 27.44 · Fwd 18.79 · PEG -1.7 · FV $177.12 (premium) · current $229.81 · EPS growth class: declining

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 8

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 124% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 88.75 | 0 | ↑ | ↑ | ↑ | ↓ | 55.44 | 47.89 | s-6 | s-3 | bear | bull | · | 191.49 | 0.463× D | — |
| +5% | 2025-07-23 | 94.40 | 5 | ↑ | ↑ | ↑ | ↑ | 67.35 | 51.42 | s-5 | s-6 | bull | bull | · | 191.49 | 0.493× D | — |
| +15% | 2025-08-27 | 102.35 | 15 | ↑ | ↑ | ↑ | ↑ | 67.74 | 57.79 | s-4 | s-4 | bull | bull | · | 193.37 | 0.529× D | — |
| +30% | 2025-10-06 | 115.97 | 30 | ↑ | ↑ | ↑ | ↑ | 74.98 | 59.76 | s-6 | s-10 | bull | bull | · | 193.37 | 0.6× D | — |
| +50% | 2025-11-10 | 134.82 | 50 | ↑ | ↑ | ↑ | ↑ | 74.16 | 75.71 | s-4 | s-15 | bull | bull | · | 152.59 | 0.884× F | — |
| +75% | 2026-01-06 | 158.12 | 75 | ↑ | ↑ | ↑ | ↑ | 70.18 | 82.81 | s-2 | s-23 | bull | bull | bull | 152.59 | 1.036× F | — |
| +100% | 2026-01-27 | 179.89 | 100 | ↑ | ↑ | ↑ | ↑ | 77.88 | 88.41 | s-16 | s-26 | bull | bull | bull | 152.59 | 1.179× P | — |
| peak | 2026-04-17 | 199.00 | 124.23 | ↑ | ↑ | ↑ | ↑ | 69.74 | 75.31 | s-12 | s-4 | bull | bull | bull | 148.84 | 1.337× P | — |
| exit_window | 2026-04-17 | 199.00 | 124.23 | ↑ | ↑ | ↑ | ↑ | 69.74 | 75.31 | s-12 | s-4 | bull | bull | bull | 148.84 | 1.337× P | — |

> *No system trades on ENS in the window — pure missed opportunity.*

## LIT — CLEAN_TREND · sector? · return 115.8% · max DD -13.1%

**Fundamentals (today):** P/E TTM 27.49 · Fwd 0 · PEG 0 · FV $· (·) · current $90.08 · EPS growth class: positive

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 4

**Should-have-held diagnosis:** Never traded — pure missed opportunity. Oracle return 116% over the window.

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 38.41 | 0 | ↑ | ↑ | ↑ | ↑ | 58.4 | 53.41 | s-6 | s-2 | bull | bear | bull | · | · | — |
| +5% | 2025-07-14 | 40.55 | 5 | ↑ | ↑ | ↑ | ↑ | 65.38 | 60.5 | s-14 | s-4 | bull | bull | bull | · | · | — |
| +15% | 2025-07-24 | 44.48 | 15 | ↑ | ↑ | ↑ | ↑ | 75.04 | 66.29 | s-6 | s-5 | bull | bull | bull | · | · | — |
| +30% | 2025-09-05 | 50.56 | 30 | ↑ | ↑ | ↑ | ↑ | 76.57 | 71.22 | s-10 | s-11 | bull | bull | bull | · | · | — |
| +50% | 2025-10-02 | 58.43 | 50 | ↑ | ↑ | ↑ | ↑ | 82.13 | 79.5 | s-14 | s-15 | bull | bull | bull | · | · | — |
| +75% | 2025-12-26 | 67.89 | 75 | ↑ | ↑ | ↑ | ↑ | 70.95 | 72.79 | s-5 | s-5 | bull | bull | bull | · | · | — |
| +100% | 2026-02-25 | 77.09 | 100 | ↑ | ↑ | ↑ | ↑ | 65.86 | 71.55 | s-13 | s-1 | bull | bull | bull | · | · | — |
| peak | 2026-04-17 | 83.23 | 116.69 | ↑ | ↑ | ↑ | ↑ | 73.32 | 70.79 | s-8 | s-3 | bull | bull | bull | · | · | — |
| exit_window | 2026-04-20 | 82.89 | 115.82 | ↑ | ↑ | ↑ | ↑ | 71.84 | 70.16 | s-9 | s-4 | bull | bull | bull | · | · | — |

> *No system trades on LIT in the window — pure missed opportunity.*

## CAT — CLEAN_TREND · Industrials · return 103.3% · max DD -13.9%

**Fundamentals (today):** P/E TTM 44.65 · Fwd 30.56 · PEG 1.47 · FV $659.56 (premium) · current $897.28 · EPS growth class: strong

**Cohort metrics:** weekly EMA-21 break streak = 0 · daily 5/12 cloud break streak = 10

**Should-have-held diagnosis:** 7 closed trades · Σ pnl% 8.7 on 103% oracle return → capture 8% · premature exits 2/7 · stopped-out 0 · TP-hit 1 · dominant exit: HARD_FUSE_RSI_EXTREME (2/7)

### Inflection timeline (close-discipline)

| inflection | date | close | gain% | wk EMA-21 | dly 5/12 | dly EMA-21 | 4H EMA-21 | RSI-D | RSI-W | TD9-D | TD9-W | ST-D | ST-W | ST-M | FV $ | FV ratio | sys near (path · grade · pnl%) |
|---|---|---:|---:|:---:|:---:|:---:|:---:|---:|---:|:---:|:---:|:---:|:---:|:---:|---:|---:|---|
| entry_oracle | 2025-07-01 | 390.92 | 0 | ↑ | ↑ | ↑ | ↑ | 77.28 | 69.84 | s-8 | s-10 | bull | bull | · | 603.02 | 0.648× D | — |
| +5% | 2025-07-16 | 412.88 | 5 | ↑ | ↑ | ↑ | ↑ | 77.04 | 72.66 | s-18 | s-12 | bull | bull | · | 603.02 | 0.685× D | — |
| +15% | 2025-09-17 | 450.66 | 15 | ↑ | ↑ | ↑ | ↑ | 69.5 | 72.38 | s-9 | s-3 | bull | bull | · | 589.27 | 0.765× D | — |
| +30% | 2025-10-14 | 527.47 | 30 | ↑ | ↑ | ↑ | ↑ | 76.54 | 78.33 | s-2 | s-7 | bull | bull | · | 589.27 | 0.895× F | — |
| +50% | 2025-12-03 | 591.49 | 50 | ↑ | ↑ | ↑ | ↑ | 66.54 | 78.6 | s-7 | s-1 | bull | bull | · | 582.55 | 1.015× F | — |
| +75% | 2026-02-02 | 690.91 | 75 | ↑ | ↑ | ↑ | ↑ | 70.21 | 80.54 | s-3 | s-5 | bull | bull | bull | 583.16 | 1.185× P | — |
| +100% | 2026-04-09 | 787.07 | 100 | ↑ | ↑ | ↑ | ↑ | 66.6 | 72.26 | s-6 | s-2 | bull | bull | bull | 459.68 | 1.712× P | — |
| peak | 2026-04-17 | 794.65 | 103.28 | ↑ | ↑ | ↑ | ↑ | 64.54 | 72.58 | s-1 | s-3 | bull | bull | bull | 459.68 | 1.729× P | — |
| exit_window | 2026-04-17 | 794.65 | 103.28 | ↑ | ↑ | ↑ | ↑ | 64.54 | 72.58 | s-1 | s-3 | bull | bull | bull | 459.68 | 1.729× P | — |

### System trades on CAT during window (n=7)

| # | entry | exit | dir | path | grade | personality | regime | rank | rr | mfe% | mae% | held d | pnl % | exit reason |
|---|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 2025-07-08 | 2025-07-23 | LONG | tt_pullback | Prime | ? | ? | 94 | 2.7 | 8.65 | -0.17 | 15.1 | 1.76% | TP_FULL |
| 2 | 2025-07-28 | 2025-07-29 | LONG | tt_ath_breakout | Confirmed | ? | ? | 94 | 4.08 | 0.38 | -1.57 | 1 | -1.57% | phase_i_mfe_cut_4h |
| 3 | 2025-09-11 | 2025-09-18 | LONG | tt_gap_reversal_long | Prime | ? | ? | 97 | 4.25 | 7.08 | -0.36 | 7 | 3.80% | HARD_FUSE_RSI_EXTREME |
| 4 | 2025-09-26 | 2025-10-03 | LONG | tt_range_reversal_long | Prime | ? | ? | 93 | 3.12 | 7.05 | 0 | 7 | 5.04% | HARD_FUSE_RSI_EXTREME |
| 5 | 2025-10-08 | 2025-10-09 | LONG | tt_gap_reversal_long | Prime | ? | ? | 100 | 2.57 | 0 | -1.41 | 0.9 | -1.41% | phase_i_mfe_fast_cut_2h |
| 6 | 2025-12-10 | 2025-12-12 | LONG | tt_ath_breakout | Prime | PULLBACK_PLAYER | TRENDING | 93 | 2.99 | 4.29 | 0 | 2 | 2.38% | peak_lock_ema12_deep_break |
| 7 | 2026-02-25 | 2026-02-26 | LONG | tt_ath_breakout | Prime | PULLBACK_PLAYER | TRENDING | 97 | 2.92 | 0 | -0.76 | 0.9 | -1.26% | PRE_EARNINGS_FORCE_EXIT |


---

### Methodology footnote

- Daily candles dedupe'd on date (highest-volume row per date) before indicator computation, matching the universe-benchmark pipeline.
- Weekly bars: ISO-week (Mon-Sun) aggregation; weekly close = last daily close in week.
- 4H bars: from `/timed/candles?tf=4H` (cached at `data/forensic/4h-candles/`).
- Fair-Value derivation per user direction: at each inflection date, compute `ttm_eps` = sum of last 4 quarterly EPS prints with date ≤ inflection_date, then `fv_price = ttm_eps × forward_P/E_today`. This blends a historical earnings stream with a stationary multiple — directionally correct for spotting "discount-vs-fair-vs-premium" labels but not a precise valuation. Where fewer than 4 quarters of history exist before a date, ttm_eps uses what is available (annotated in the per-ticker JSON).
- **FV caveat for explosive-growth names:** for tickers whose earnings turn positive mid-window (e.g. SNDK printed −$0.30 → $0.29 → $1.22 → $6.20 → $23.41 over the run), ttm-EPS-derived FV is meaningless or negative at entry. The bull-case "discount" signal in those cases comes from the FORWARD earnings curve (visible in `eps_growth_class`: explosive/exploding) — not from trailing FV. The Trend-Hold module should treat `growth.eps_growth_class === "explosive"` AND `pe_forward < pe_ttm × 0.5` as an early-cycle "fundamentals discount" signal that supplements the trend filters.
- System-trade snapshots joined within ±3 trading days of each inflection.
- Source data: `data/cohort-segmentation.json`, `data/universe-cache/<T>-D.json`, `data/forensic/4h-candles/<T>-4H.json`, `data/forensic/fundamentals/<T>.json`, `tasks/phase-c/universe-benchmark/system-trades.json`.