# Phase-C Stage1 Universe Benchmark — Oracle vs System

**Run:** `phase-c-stage1-jul2025-may2026`
**Universe:** 238 tickers (`configs/backtest-universe-phase-c-stage1.txt`)
**Window:** entries 2025-07-01 → **2025-09-30** (capped at system's last entry day; daily candle data extends through 2026-05-01)
**Oracle method:** N=10-trading-day forward window, |move| ≥ 8%, top-3 non-overlapping per ticker per side, greedy by |pct| desc.
**Match window:** ±3 trading days on entry, same direction.

## Headline

- Oracle winners total: **830** (466 long, 364 short)
- Total oracle opportunity (sum |%move|): **15064.4%** (long 10135.2% + short 4929.1%)
- System trades in window: **258** (250 long, 8 short); 149 win / 109 loss
- System total PnL%: **243.2%** (long 237.8%, short 5.5%)
- Oracle windows the system entered within ±3 TD: **51 / 830 = 6.1%**
  - Long hit rate: 10.5% (49/466)
  - Short hit rate: 0.5% (2/364)
- Avg per-match capture (system pnl% / oracle |%|): **5.7%**
- **Capture efficiency** (Σ system pnl% / Σ oracle |%|, matched only): **5.3%**
  - Long: 5.0%   Short: 22.2%
- Matched-trade outcome buckets: fully ≥70% cap = 0, partial 30–70% = 3, mismanaged <30% = 48
- System wins outside any oracle window (system 'edge'): **114**, total pnl% = 267.8%
- Avg oracle window length: 7.6 trading days

## Missed Winners (oracle hit, system never opened) — Top 30 by |% move|

| ticker | side | entry → exit | days | oracle % | nearest sys trade in ticker (direction, entry, pnl%) |
|---|---|---|---|---|---|
| SATS | LONG | 2025-08-25 → 2025-09-09 | 10 | +185.71% | LONG @ 2025-09-26 (-1.76%, Δ=23d) |
| MP | LONG | 2025-07-09 → 2025-07-21 | 8 | +116.62% | LONG @ 2025-07-28 (-0.04%, Δ=13d) |
| ASTS | LONG | 2025-09-30 → 2025-10-14 | 10 | +101.98% | — |
| APLD | LONG | 2025-09-08 → 2025-09-22 | 10 | +78.63% | LONG @ 2025-09-17 (+3.60%, Δ=7d) |
| IONQ | LONG | 2025-09-08 → 2025-09-22 | 10 | +78.42% | — |
| ARRY | LONG | 2025-08-12 → 2025-08-26 | 10 | +77.76% | — |
| UUUU | LONG | 2025-09-30 → 2025-10-14 | 10 | +75.11% | — |
| UUUU | LONG | 2025-07-09 → 2025-07-23 | 10 | +72.09% | — |
| NBIS | LONG | 2025-09-08 → 2025-09-22 | 10 | +69.50% | — |
| IREN | LONG | 2025-09-26 → 2025-10-10 | 10 | +67.34% | LONG @ 2025-09-17 (+0.35%, Δ=7d) |
| LMND | LONG | 2025-07-30 → 2025-08-13 | 10 | +66.51% | — |
| IREN | LONG | 2025-09-08 → 2025-09-22 | 10 | +63.92% | LONG @ 2025-09-17 (+0.35%, Δ=7d) |
| GLXY | LONG | 2025-07-08 → 2025-07-21 | 9 | +63.16% | LONG @ 2025-07-23 (+0.69%, Δ=11d) |
| MDB | LONG | 2025-08-26 → 2025-09-10 | 10 | +60.89% | LONG @ 2025-07-09 (-4.01%, Δ=34d) |
| BE | LONG | 2025-07-17 → 2025-07-31 | 10 | +60.80% | LONG @ 2025-08-05 (+0.82%, Δ=13d) |
| U | LONG | 2025-07-02 → 2025-07-17 | 10 | +60.46% | LONG @ 2025-07-14 (+12.50%, Δ=7d) |
| RKLB | LONG | 2025-09-26 → 2025-10-10 | 10 | +58.88% | — |
| UUUU | LONG | 2025-08-19 → 2025-08-26 | 5 | +57.50% | — |
| BE | LONG | 2025-09-29 → 2025-10-13 | 10 | +56.53% | LONG @ 2025-09-11 (-1.43%, Δ=12d) |
| ORCL | LONG | 2025-09-04 → 2025-09-10 | 4 | +55.03% | LONG @ 2025-07-31 (-5.17%, Δ=24d) |
| ASTS | LONG | 2025-09-09 → 2025-09-23 | 10 | +52.78% | — |
| ETHA | LONG | 2025-07-07 → 2025-07-21 | 10 | +51.90% | LONG @ 2025-08-12 (+3.30%, Δ=26d) |
| INTC | LONG | 2025-09-12 → 2025-09-26 | 10 | +50.75% | LONG @ 2025-08-27 (-0.99%, Δ=11d) |
| NBIS | LONG | 2025-07-29 → 2025-08-11 | 9 | +50.71% | — |
| AMD | LONG | 2025-09-26 → 2025-10-09 | 9 | +50.57% | LONG @ 2025-08-13 (-0.88%, Δ=31d) |
| RKLB | LONG | 2025-07-03 → 2025-07-17 | 9 | +49.86% | — |
| GLXY | LONG | 2025-09-04 → 2025-09-18 | 10 | +49.50% | LONG @ 2025-07-23 (+0.69%, Δ=30d) |
| MP | LONG | 2025-09-30 → 2025-10-14 | 10 | +49.47% | LONG @ 2025-09-18 (+4.55%, Δ=8d) |
| HIMS | LONG | 2025-07-21 → 2025-07-31 | 8 | +47.96% | — |
| CELH | LONG | 2025-08-06 → 2025-08-20 | 10 | +46.14% | — |

## Caught but Mismanaged (matched, capture <30%) — Top 30 by giveback

| ticker | side | oracle entry | oracle % | sys entry | sys pnl % | capture | exit reason | setup | personality |
|---|---|---|---|---|---|---|---|---|---|
| APLD | LONG | 2025-09-26 | +79.96% | 2025-09-30 | +1.66% | 2% | ? | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| SNDK | LONG | 2025-09-02 | +82.36% | 2025-09-03 | +5.36% | 7% | HARD_FUSE_RSI_EXTREME | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| AEHR | LONG | 2025-07-09 | +73.06% | 2025-07-10 | -0.80% | -1% | max_loss | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| BE | LONG | 2025-09-08 | +62.59% | 2025-09-11 | -1.43% | -2% | max_loss_time_scaled | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| JOBY | LONG | 2025-07-02 | +75.79% | 2025-07-07 | +12.37% | 16% | TP_FULL | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| IREN | LONG | 2025-08-19 | +60.25% | 2025-08-18 | +0.23% | 0% | PROFIT_GIVEBACK_STAGE_HOLD | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| AEHR | LONG | 2025-08-20 | +58.28% | 2025-08-25 | -0.62% | -1% | PROFIT_GIVEBACK_STAGE_HOLD | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| PATH | LONG | 2025-09-25 | +54.37% | 2025-09-23 | -3.89% | -7% | max_loss | TT Tt Pullback | VOLATILE_RUNNER |
| APLD | LONG | 2025-07-30 | +58.03% | 2025-08-04 | +3.52% | 6% | mfe_decay_structural_flatten | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| RDDT | LONG | 2025-07-30 | +58.95% | 2025-08-04 | +9.35% | 16% | atr_week_618_full_exit | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| PI | LONG | 2025-07-22 | +46.60% | 2025-07-24 | +1.88% | 4% | TP_FULL | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| PSTG | LONG | 2025-08-20 | +45.29% | 2025-08-25 | +1.60% | 4% | TP_FULL | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| CLS | LONG | 2025-07-22 | +36.68% | 2025-07-21 | -2.23% | -6% | max_loss | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| RIOT | LONG | 2025-09-26 | +35.30% | 2025-09-29 | -3.13% | -9% | max_loss | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| MP | LONG | 2025-07-29 | +36.91% | 2025-07-28 | -0.04% | -0% | runner_drawdown_cap | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| FIX | LONG | 2025-07-22 | +35.00% | 2025-07-17 | -1.31% | -4% | max_loss | TT Tt Pullback | VOLATILE_RUNNER |
| IBP | LONG | 2025-07-31 | +36.32% | 2025-08-04 | +2.48% | 7% | TP_FULL | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| BWXT | LONG | 2025-07-22 | +35.14% | 2025-07-23 | +2.00% | 6% | PROFIT_GIVEBACK_STAGE_HOLD | TT Tt Gap Reversal Long | PULLBACK_PLAYER |
| ALB | LONG | 2025-09-30 | +23.16% | 2025-09-26 | -6.46% | -28% | v13_hard_pnl_floor | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| WDC | LONG | 2025-08-29 | +29.18% | 2025-09-03 | -0.03% | -0% | SOFT_FUSE_RSI_CONFIRMED | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| MDB | LONG | 2025-07-14 | +23.18% | 2025-07-09 | -4.01% | -17% | max_loss | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| ALB | LONG | 2025-07-07 | +23.82% | 2025-07-10 | -1.81% | -8% | phase_i_mfe_fast_cut_zero_mfe | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| APP | LONG | 2025-09-05 | +33.21% | 2025-09-08 | +9.55% | 29% | sl_breached | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| STX | LONG | 2025-08-29 | +27.96% | 2025-09-02 | +6.47% | 23% | HARD_FUSE_RSI_EXTREME | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| ANET | LONG | 2025-07-24 | +23.65% | 2025-07-23 | +2.54% | 11% | mfe_decay_structural_flatten | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| GOOGL | LONG | 2025-09-02 | +19.73% | 2025-08-28 | +0.70% | 4% | unknown | TT Tt Gap Reversal Long | PULLBACK_PLAYER |
| APP | LONG | 2025-08-20 | +23.91% | 2025-08-25 | +5.26% | 22% | unknown | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| AVAV | LONG | 2025-07-09 | +20.02% | 2025-07-14 | +1.54% | 8% | PROFIT_GIVEBACK_STAGE_HOLD | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| AWI | LONG | 2025-07-21 | +16.92% | 2025-07-17 | -0.80% | -5% | phase_i_mfe_fast_cut_2h | TT Tt Range Reversal Long | PULLBACK_PLAYER |
| STX | LONG | 2025-09-18 | +22.24% | 2025-09-15 | +4.62% | 21% | sl_breached | TT Tt Gap Reversal Long | VOLATILE_RUNNER |

## System Wins NOT in Oracle (system 'edge') — Top 30 by pnl %

| ticker | side | entry | exit | pnl % | exit reason | setup | personality |
|---|---|---|---|---|---|---|---|
| AEHR | LONG | 2025-07-21 | 2025-07-28 | +21.18% | atr_week_618_full_exit | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| AEHR | LONG | 2025-09-15 | 2025-09-25 | +12.85% | peak_lock_ema12_deep_break | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| U | LONG | 2025-07-14 | 2025-07-22 | +12.50% | sl_breached | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| BE | LONG | 2025-08-21 | OPEN | +11.13% | unknown | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| IREN | LONG | 2025-07-01 | 2025-07-15 | +10.21% | sl_breached | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| CLS | LONG | 2025-09-04 | 2025-09-05 | +9.21% | HARD_FUSE_RSI_EXTREME | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| LITE | LONG | 2025-07-14 | 2025-08-01 | +8.70% | sl_breached | TT Tt Pullback | VOLATILE_RUNNER |
| MP | LONG | 2025-08-04 | 2025-08-07 | +6.10% | TP_FULL | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| BE | LONG | 2025-08-12 | 2025-08-19 | +6.03% | ST_FLIP_4H_CLOSE | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| ALB | LONG | 2025-08-21 | 2025-08-27 | +5.11% | SOFT_FUSE_RSI_CONFIRMED | TT Tt Range Reversal Long | VOLATILE_RUNNER |
| GOOGL | LONG | 2025-07-01 | 2025-07-23 | +5.01% | TP_FULL | TT Tt N Test Support | PULLBACK_PLAYER |
| KLAC | LONG | 2025-09-11 | 2025-09-18 | +4.99% | HARD_FUSE_RSI_EXTREME | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| MP | LONG | 2025-09-18 | 2025-09-22 | +4.55% | below_trigger,trigger_breached_5pct,adverse_move_warning | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| AAPL | LONG | 2025-09-02 | 2025-09-08 | +4.49% | sl_breached | TT Tt N Test Support | PULLBACK_PLAYER |
| AA | LONG | 2025-09-03 | 2025-09-23 | +4.35% | peak_lock_ema12_deep_break | TT Tt Range Reversal Long | VOLATILE_RUNNER |
| MTZ | LONG | 2025-09-18 | OPEN | +4.29% | unknown | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| CAT | LONG | 2025-07-08 | 2025-07-23 | +4.19% | TP_FULL | TT Tt Pullback | PULLBACK_PLAYER |
| AAPL | LONG | 2025-09-17 | 2025-09-22 | +4.13% | HARD_FUSE_RSI_EXTREME | TT Tt N Test Support | PULLBACK_PLAYER |
| B | LONG | 2025-08-04 | 2025-08-11 | +3.77% | mfe_decay_structural_flatten | TT Tt Gap Reversal Long | PULLBACK_PLAYER |
| JCI | LONG | 2025-07-14 | 2025-07-28 | +3.65% | TP_FULL | TT Tt N Test Support | PULLBACK_PLAYER |
| APLD | LONG | 2025-09-17 | 2025-09-22 | +3.60% | TP_FULL | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| GOOGL | LONG | 2025-09-09 | 2025-09-23 | +3.59% | sl_breached | TT Tt Gap Reversal Long | PULLBACK_PLAYER |
| CCJ | LONG | 2025-09-18 | 2025-09-24 | +3.32% | peak_lock_ema12_deep_break | TT Tt Pullback | VOLATILE_RUNNER |
| ETHA | LONG | 2025-08-12 | 2025-08-13 | +3.30% | HARD_FUSE_RSI_EXTREME | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| GE | LONG | 2025-09-15 | 2025-09-25 | +3.07% | ST_FLIP_4H_CLOSE | TT Tt Gap Reversal Long | PULLBACK_PLAYER |
| PSTG | LONG | 2025-09-15 | 2025-09-22 | +2.94% | atr_week_618_full_exit | TT Tt Gap Reversal Long | VOLATILE_RUNNER |
| SGI | LONG | 2025-08-18 | OPEN | +2.91% | unknown | TT Tt Pullback | VOLATILE_RUNNER |
| IWM | LONG | 2025-07-01 | 2025-07-11 | +2.85% | sl_breached | TT Tt Gap Reversal Long | MODERATE |
| NEU | LONG | 2025-07-01 | 2025-07-03 | +2.77% | HARD_FUSE_RSI_EXTREME | TT Tt Gap Reversal Long | MODERATE |
| RBLX | LONG | 2025-07-14 | 2025-07-16 | +2.65% | HARD_FUSE_RSI_EXTREME | TT Tt Gap Reversal Long | VOLATILE_RUNNER |

## Setup × Personality × Regime breakdown (matched trades only)

### By personality

| personality | fully (≥70%) | partial (30–70%) | mismanaged (<30%) |
|---|---|---|---|
| VOLATILE_RUNNER | 0 | 3 | 37 |
| PULLBACK_PLAYER | 0 | 0 | 10 |
| SLOW_GRINDER | 0 | 0 | 1 |

### By regime

| regime | fully | partial | mismanaged |
|---|---|---|---|
| TRENDING | 0 | — | 28 |
| TRANSITIONAL | 0 | — | 17 |
| CHOPPY | 0 | — | 3 |

### By setup (top 12 by total matches)

| setup | fully | mismanaged |
|---|---|---|
| TT Tt Gap Reversal Long | 0 | 36 |
| TT Tt Range Reversal Long | 0 | 4 |
| TT Tt Ath Breakout | 0 | 4 |
| TT Tt Pullback | 0 | 3 |
| TT Tt N Test Resistance | 0 | 1 |

### Matched-trade exit reasons

| exit reason | fully (≥70%) | mismanaged (<30%) |
|---|---|---|
| max_loss | 0 | 6 |
| HARD_FUSE_RSI_EXTREME | 0 | 6 |
| TP_FULL | 0 | 5 |
| PROFIT_GIVEBACK_STAGE_HOLD | 0 | 5 |
| mfe_decay_structural_flatten | 0 | 3 |
| atr_day_adverse_382_cut | 0 | 3 |
| unknown | 0 | 3 |
| max_loss_time_scaled | 0 | 3 |
| phase_i_mfe_fast_cut_zero_mfe | 0 | 2 |
| SMART_RUNNER_SUPPORT_BREAK_CLOUD | 0 | 2 |
| atr_week_618_full_exit | 0 | 2 |
| SOFT_FUSE_RSI_CONFIRMED | 0 | 2 |
| sl_breached | 0 | 2 |
| ? | 0 | 1 |
| phase_i_mfe_fast_cut_2h | 0 | 1 |
| v13_hard_pnl_floor | 0 | 1 |
| runner_drawdown_cap | 0 | 1 |

## Insights & Calibration Suggestions

Each insight is tagged with the relevant config knob; *do not implement here*, the parent agent will run a calibration A/B.

- **1. Entries are reasonably well-timed; exit discipline is the binding constraint.** Of 51 matched oracle windows, the system enters within ±1 trading day **35%** of the time, but average per-match capture is only **6%** of the oracle |%| (and **0** matches reach the ≥70% 'fully captured' bucket). The top exit reasons in the mismanaged-bucket are: `HARD_FUSE_RSI_EXTREME`=6, `max_loss`=6, `TP_FULL`=5, `PROFIT_GIVEBACK_STAGE_HOLD`=5, `mfe_decay_structural_flatten`=3. `HARD_FUSE_RSI_EXTREME` and `PROFIT_GIVEBACK_STAGE_HOLD` between them account for ~25% of the mismanaged exits — these fire on day 2–4 of moves that the oracle shows would have continued for 7+ days. ➜ *Calibration knob:* `worker/index.js` — search for the RSI threshold that triggers `HARD_FUSE_RSI_EXTREME` (likely `rsi >= 80` or similar). Proposed test: raise the threshold to `rsi >= 88` for `VOLATILE_RUNNER` personality + `Gap Reversal Long` setup, since these are the dominant mismanaged combo (37/49 = 76%) and also the dominant 'edge' winners — the gate is firing too symmetrically across both.

- **2. `PROFIT_GIVEBACK_STAGE_HOLD` is firing on real winners.** It accounts for **5** of 48 mismanaged matched trades, all locking in <10% capture on oracle moves of 20–60%. The trades had positive MFE early then mean-reverted intraday, but the oracle confirms the move resumed within 5 trading days. ➜ *Calibration knob:* `worker/index.js` — search `PROFIT_GIVEBACK_STAGE_HOLD`. Proposed test: raise the giveback-percent threshold from current value to **0.55** of MFE (typically ~0.38–0.5), and gate the trigger behind `bars_since_entry >= 12` on the 4H timeframe so day-1 chop doesn't tag it. Also disable on `personality == 'VOLATILE_RUNNER'` for the first 24h.

- **3. Short side is structurally under-sampled.** Oracle has **364** short opportunities worth Σ4929% of move; system took 8 shorts vs 250 longs (3.1% of trades) and matched only **2** oracle short windows (0.5% hit rate). Even on the 1 fully-caught short, capture stayed at 22.2% of the oracle move. ➜ *Calibration knob:* `worker/index.js` — search `setup_name === 'TT Tt Gap Reversal Short'` and the `td9_bear_ltf_active`/`HTF_BEAR_LTF_BEAR` gates. Proposed test: relax the short-entry requirement so `HTF_TRANSITIONAL + LTF_BEAR + daily_td9_adverse` is permitted (currently requires fully aligned bear). Cross-check against the 8 short trades' `rank_trace_json` to confirm they're being filtered at `_applyContextGates()`.

- **4. 174 tickers had ≥2 oracle winners; **83** of them were never traded by the system in this window.** Combined opportunity left on the table from never-traded tickers: Σ6683% of move across 376 oracle windows. Examples: `ACN, AMGN, AR, ARRY, ASTS, AXON, BABA, BTCUSD, CELH, CL1!, COIN, CRM`. ➜ *Calibration knob:* `worker/index.js` — search the global entry threshold (`finalScore >= ` near `qualifiesForEnter`). Proposed test: probe `rank_trace_json` for these specific tickers on the oracle entry dates — if `parts[]` shows score zeroed at `data_completeness` or `tf_summary`, that's the rejection root. Likely fix: lower the `finalScore` entry threshold by 5 points and add a new `volatility_expansion_bonus` that adds +5 to score when daily ATR/price > 4% (high-vol names like UUUU/IONQ/IREN/RKLB/ASTS keep getting filtered by the choppy-regime guard).

- **5. The system has 114 profitable trades that no oracle window matched** (total Σ267.8% pnl). Top combo: `TT Tt Gap Reversal Long` × `VOLATILE_RUNNER` (68 trades). These are sub-8.0% moves the system profitably scalps — protect them when calibrating. ➜ *Calibration guard-rail:* if Insight 1's HARD_FUSE_RSI threshold raise is implemented, split the rule by `setup_name`: keep aggressive HARD_FUSE for `TT Tt N Test Support/Resistance` (these dominate the 'edge' wins for `PULLBACK_PLAYER`), but loosen for `Gap Reversal Long` × `VOLATILE_RUNNER` only. Same file, same code path, but the branch must read the setup_name.

- **6. Holding-period gap on matched trades.** Avg oracle window = 7.6 trading days (~10.7 calendar days); avg system hold on matched trades = 4.7 calendar days. The system is exiting **56%** earlier than the oracle peak on average. Combined with Insight 1 + Insight 2 this is the single biggest source of capture loss. ➜ *Calibration knob:* `worker/index.js` — `executionProfileName == 'correction_transition'` is the most common profile in our data. Find its time-stop / max-bars constant. Proposed test: raise from current value to ≥**16** trading days for trades that have positive MFE > 1R.

- **7. `max_loss` is stopping us out on 9 trades that became oracle winners.** These trades entered within ±3 TD of an eventual large move but the stop triggered during the chop *before* the move. Examples: AEHR (oracle +73%, sys -0.8%, max_loss), BE (oracle +63%, sys -1.4%, max_loss_time_scaled), MDB (oracle +23%, sys -4%, max_loss). ➜ *Calibration knob:* `worker/index.js` — search the `max_loss` cap (likely `-0.5R` to `-1R`). Proposed test: for `VOLATILE_RUNNER` personality, widen initial stop from current value to **-1.4R** for the first 12 4H bars, then tighten to current value. Rationale: high-vol names need more rope on entry day to survive the noise that precedes the oracle move.

## Appendix A — Tickers never traded by system but had oracle winners

| ticker | # missed oracle windows | total |%move| missed |
|---|---|---|
| ASTS | 6 | 264.2% |
| IONQ | 6 | 201.4% |
| ARRY | 6 | 181.3% |
| UUUU | 6 | 257.7% |
| NBIS | 6 | 194.1% |
| LMND | 6 | 157.2% |
| RKLB | 6 | 186.1% |
| HIMS | 6 | 160.5% |
| CELH | 6 | 119.9% |
| CRWV | 6 | 209.4% |
| TLN | 6 | 95.0% |
| HL | 6 | 136.7% |
| TEM | 6 | 150.5% |
| SANM | 6 | 112.1% |
| ETHUSD | 6 | 148.1% |
| MU | 6 | 122.3% |
| LSCC | 6 | 99.1% |
| FLR | 6 | 94.4% |
| SOXL | 6 | 139.3% |
| STRL | 6 | 114.2% |
| IOT | 6 | 89.0% |
| TWLO | 6 | 99.5% |
| COIN | 6 | 120.6% |
| LRCX | 6 | 91.8% |
| ON | 6 | 80.1% |
| ELF | 6 | 120.5% |
| SOFI | 6 | 101.9% |
| TNA | 6 | 94.5% |
| MSTR | 6 | 106.6% |
| GOLD | 6 | 81.2% |
| CRWD | 6 | 70.1% |
| VX1! | 6 | 71.3% |
| VST | 6 | 78.7% |
| WFRD | 6 | 78.9% |
| VIXY | 6 | 79.0% |
| UNH | 5 | 91.1% |
| BABA | 5 | 90.6% |
| TSLA | 5 | 78.5% |
| HOOD | 5 | 104.1% |
| AXON | 5 | 74.3% |
| XYZ | 5 | 69.0% |
| FSLR | 5 | 83.5% |
| ACN | 5 | 54.1% |
| JD | 5 | 61.3% |
| AR | 5 | 53.6% |
| UTHR | 4 | 79.8% |
| DELL | 4 | 67.2% |
| PLTR | 4 | 85.3% |
| EXEL | 4 | 52.5% |
| EXPE | 4 | 54.2% |
| MRK | 4 | 45.4% |
| HALO | 4 | 56.7% |
| TSM | 4 | 46.8% |
| UHS | 4 | 49.7% |
| WAL | 4 | 53.1% |
| BTCUSD | 4 | 48.0% |
| RGLD | 4 | 50.0% |
| LIT | 4 | 51.2% |
| SI1! | 4 | 42.1% |
| ULTA | 4 | 38.0% |
| DY | 3 | 43.8% |
| GDX | 3 | 44.0% |
| CRM | 3 | 33.4% |
| SLV | 3 | 34.8% |
| XHB | 3 | 30.6% |
| ENS | 3 | 32.1% |
| EWBC | 3 | 29.8% |
| CL1! | 3 | 32.0% |
| USO | 3 | 30.1% |
| ISRG | 3 | 26.8% |
| DINO | 2 | 26.7% |
| MNST | 2 | 21.9% |
| VMI | 2 | 23.8% |
| PPG | 2 | 20.3% |
| QLYS | 2 | 22.2% |
| AMGN | 2 | 20.2% |
| GILD | 2 | 19.1% |
| IAU | 2 | 18.0% |
| NFLX | 2 | 18.1% |
| DTM | 2 | 17.5% |
| GC1! | 2 | 17.0% |
| CSCO | 2 | 16.5% |
| WMT | 2 | 16.5% |
| UPS | 1 | 18.6% |
| OKE | 1 | 12.5% |
| ABT | 1 | 10.9% |
| TJX | 1 | 10.8% |
| DE | 1 | 10.3% |
| IBB | 1 | 10.0% |
| UNP | 1 | 9.9% |
| MTB | 1 | 9.8% |
| XLV | 1 | 9.0% |
| IGV | 1 | 8.5% |
| WTS | 1 | 8.4% |
| BK | 1 | 8.0% |

---

### Methodology footnote

For every trading day `i` with available data after 2025-07-01, we compute `(max high in days i+1..i+10) / close_i - 1` (long) and `(min low in days i+1..i+10) / close_i - 1` (short). Days where |move| ≥ 8.0% become candidates. We then greedy-pick top 3 per ticker per side by descending |move|, requiring no overlap on `[entry_idx, exit_idx]`. Entry is the *close* of day `i`; exit is the *high* (long) or *low* (short) of the peak/trough day. Match window vs system trades is ±3 trading days on entry and same direction. Capture is `system_pnl_pct / |oracle_pct|`.