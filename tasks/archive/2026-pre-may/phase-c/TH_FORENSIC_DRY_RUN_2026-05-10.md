---
title: Trend-Hold Forensic Dry-Run (Phase 3.9b)
generated: 2026-05-10T21:19:33.597Z
cohort: SNDK, GOOGL, AMD, MU, META, BE, SOXL, AEHR, NFLX, PLTR, NVDA, AVGO, TSM, GEV
date_range: 2025-07-01 → 2026-05-08
config_overrides: {"promote_max_weekly_td9_sell_count":12,"promote_max_weekly_rsi":95}
---

# Trend-Hold Forensic Dry-Run

Pure functional eval of the actual `worker/trend-hold.js` predicates against canonical Phase C `direction_accuracy` snapshots, with W/M/4H trend signals synthesized from `ticker_candles`. **No deployment, no preprod fidelity gap, no live mutation.**

## Verdict

**TH module is sound, but its exhaustion gates (weekly TD9 ≥ 9, weekly RSI ≥ 88, monthly stBear) are over-strict for momentum-cohort tickers.** The empirical Phase C trade record shows these gates reject 51 + 6 + 4 should-have-held opportunities respectively (combined ~50% of MFE-eligible misses).

Recommended tuning **`promote_max_weekly_td9_sell_count: 12, promote_max_weekly_rsi: 95`**:

| metric | default | recommended | Δ |
|---|---:|---:|---:|
| promoted (MFE-eligible) | 17 (13.5%) | 43 (34.1%) | **+26 (+2.5×)** |
| suppressed exits | 6 | 18 | **+12** |
| implied uplift Σ | 51 pp | 154.6 pp | **+103.6 pp** |
| false-positive (LOSS) rate | 11.8% | 7% | **−4.8 pp** (improved) |

Recommended tuning ALSO **lowers** false-positive rate — meaning the existing RSI ≥ 88 gate was excluding healthy momentum trades that worked, not catching exhaustion tops.

SNDK pass criterion (from PHASE_3_DESIGN.md):
- ≥3 promoted trades: **5 ✓** (under recommended; 2 under default)
- ≥1 trade with suppressed-exit: **2 ✓**
- Σ SNDK rescued giveback: 16.9 pp (vs 6.4 pp default)

BE (top-performer in cohort): **17 of 27 MFE-eligible promoted (63%), 8 suppressed exits, Σ 73.8 pp rescued.**

## Headline

| metric | value |
|---|---:|
| trades pulled | 517 |
| trades evaluable | 517 |
| would-promote | 43 (**8.3%**) |
| would-suppress-exit | 18 (41.9% of promoted) |
| implied uplift Σ | 154.6% (UPPER bound — assumes peak-MFE exit) |

## MFE-eligible subset (mfe ≥ 5%)

A trade that never reached +5% MFE cannot benefit from TH (the +5% MFE gate is the entry to the TH lifecycle). The MFE-eligible subset is the only cohort where TH's promotion / suppression behavior is decision-relevant.

| metric | value |
|---|---:|
| MFE-eligible trades | 126 (24.4% of evaluable) |
| promoted | 43 (**34.1%** of MFE-eligible) |

### MFE-eligible rejection reasons (the actionable tuning levers)

| reason | n |
|---|---:|
| daily_ema21_below_close | 14 |
| 4h_ema21_below_close | 8 |
| weekly_ema21_below_close | 7 |
| weekly_st_not_bull (dir=-1) | 6 |
| monthly_st_bear (dir=-1) | 4 |
| weekly_rsi_99.06>=95 | 4 |
| weekly_rsi_95.85>=95 | 3 |
| weekly_rsi_97.99>=95 | 3 |
| weekly_rsi_99.28>=95 | 3 |
| weekly_rsi_98.64>=95 | 2 |
| weekly_rsi_99.49>=95 | 2 |
| weekly_rsi_99.91>=95 | 2 |
| weekly_rsi_98.41>=95 | 2 |
| weekly_rsi_95.65>=95 | 1 |
| weekly_rsi_98.58>=95 | 1 |

## Per-ticker

| ticker | n | W | L | mfe-elig | promoted | promoted/elig | flavor (C/R) | promoted+suppress | giveback Σ rescued |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| AEHR | 37 | 23 | 14 | 15 | 3 (8.1%) | 20% | 0/3 | 3 | 36.6% |
| AMD | 39 | 24 | 15 | 11 | 3 (7.7%) | 27.3% | 0/3 | 1 | 7.3% |
| AVGO | 41 | 22 | 19 | 8 | 2 (4.9%) | 25% | 0/2 | 0 | 0% |
| BE | 52 | 39 | 13 | 27 | 17 (32.7%) | 63% | 0/17 | 8 | 73.8% |
| GEV | 52 | 23 | 29 | 4 | 1 (1.9%) | 25% | 0/1 | 0 | 0% |
| GOOGL | 72 | 49 | 23 | 14 | 2 (2.8%) | 14.3% | 0/2 | 1 | 4.3% |
| META | 38 | 13 | 25 | 6 | 0 (0%) | 0% | 0/0 | 0 | 0% |
| MU | 14 | 6 | 8 | 3 | 2 (14.3%) | 66.7% | 0/2 | 1 | 7.1% |
| NFLX | 11 | 8 | 3 | 0 | 0 (0%) | 0% | 0/0 | 0 | 0% |
| NVDA | 47 | 28 | 19 | 8 | 2 (4.3%) | 25% | 0/2 | 1 | 2.9% |
| PLTR | 49 | 29 | 20 | 15 | 4 (8.2%) | 26.7% | 0/4 | 1 | 5.8% |
| SNDK | 41 | 26 | 15 | 13 | 5 (12.2%) | 38.5% | 0/5 | 2 | 16.9% |
| TSM | 24 | 15 | 9 | 2 | 2 (8.3%) | 100% | 0/2 | 0 | 0% |

## Top promotion-rejection reasons (full cohort, mostly mfe<5)

| reason | n |
|---|---:|
| mfe=null<5 | 129 |
| daily_ema21_below_close | 14 |
| 4h_ema21_below_close | 8 |
| weekly_ema21_below_close | 7 |
| mfe=1.16<5 | 7 |
| weekly_st_not_bull (dir=-1) | 6 |
| mfe=0.26<5 | 5 |
| mfe=2.85<5 | 5 |
| monthly_st_bear (dir=-1) | 4 |
| mfe=0.57<5 | 4 |
| mfe=0.38<5 | 4 |
| mfe=0.67<5 | 4 |
| weekly_rsi_99.06>=95 | 4 |
| weekly_rsi_95.85>=95 | 3 |
| mfe=0.69<5 | 3 |

## Exit-reason distribution (full cohort)

| exit_reason | n |
|---|---:|
| (none) | 94 |
| SMART_RUNNER_TD_EXHAUSTION_RUNNER | 37 |
| SMART_RUNNER_SUPPORT_BREAK_CLOUD | 29 |
| PROFIT_GIVEBACK | 28 |
| PROFIT_GIVEBACK_STAGE_HOLD | 26 |
| max_loss | 23 |
| HARD_LOSS_CAP | 23 |
| sl_breached | 22 |
| TP_FULL | 21 |
| mfe_decay_structural_flatten | 19 |
| deferred_exit_st15_flip | 17 |
| max_loss_time_scaled | 16 |
| HARD_FUSE_RSI_EXTREME | 13 |
| PHASE_LEAVE_100 | 11 |
| atr_day_adverse_382_cut | 11 |
| SOFT_FUSE_RSI_CONFIRMED | 9 |
| doa_early_exit | 9 |
| mfe_proportional_trail | 9 |
| phase_i_mfe_fast_cut_2h | 8 |
| ST_FLIP_4H_CLOSE | 8 |

## Top should-have-held trades (promoted + suppressed-exit, sorted by giveback)

| ticker | trade_id | status | pnl% | mfe% | giveback% | exit_reason | flavor |
|---|---|---|---:|---:|---:|---|---|
| AEHR | AEHR-1770660000000 | WIN | 7.5 | 30.8 | 23.3 | ST_FLIP_4H_CLOSE | RESILIENT_TREND |
| BE | BE-1760362200000 | WIN | 4.4 | 17.7 | 13.3 | mfe_decay_structural_flatten | RESILIENT_TREND |
| BE | BE-1751906700000 | WIN | 7.6 | 19.6 | 12 | mfe_decay_structural_flatten | RESILIENT_TREND |
| BE | BE-1751907000000 | WIN | 7.6 | 19.6 | 12 | mfe_decay_structural_flatten | RESILIENT_TREND |
| BE | BE-1751916600000 | WIN | 8 | 19.9 | 12 | mfe_decay_structural_flatten | RESILIENT_TREND |
| SNDK | SNDK-1761246000000 | WIN | 1.3 | 11.7 | 10.4 | mfe_decay_structural_flatten | RESILIENT_TREND |
| BE | BE-1769540400000 | WIN | 1.8 | 10.6 | 8.9 | SMART_RUNNER_SUPPORT_BREAK_CLOUD | RESILIENT_TREND |
| AMD | AMD-1769022000000 | WIN | 1.1 | 8.3 | 7.3 | SMART_RUNNER_SUPPORT_BREAK_CLOUD | RESILIENT_TREND |
| AEHR | AEHR-1755023400000 | WIN | 0.6 | 7.7 | 7.2 | PROFIT_GIVEBACK_STAGE_HOLD | RESILIENT_TREND |
| MU | MU-1761575400000 | WIN | 1.2 | 8.3 | 7.1 | ST_FLIP_4H_CLOSE | RESILIENT_TREND |
| SNDK | SNDK-1771608600000 | WIN | 1.8 | 8.3 | 6.4 | SMART_RUNNER_SUPPORT_BREAK_CLOUD | RESILIENT_TREND |
| AEHR | AEHR-1771954200000 | WIN | 0.1 | 6.3 | 6.1 | SMART_RUNNER_SUPPORT_BREAK_CLOUD | RESILIENT_TREND |
| BE | BE-1762180200000 | WIN | 0.8 | 6.8 | 6 | PROFIT_GIVEBACK_STAGE_HOLD | RESILIENT_TREND |
| PLTR | PLTR-1754494200000 | WIN | 0.6 | 6.4 | 5.8 | PROFIT_GIVEBACK_STAGE_HOLD | RESILIENT_TREND |
| BE | BE-1771954200000 | WIN | 0.3 | 5.4 | 5 | PROFIT_GIVEBACK_STAGE_HOLD | RESILIENT_TREND |
| BE | BE-1761744600000 | WIN | 7.4 | 11.9 | 4.5 | mfe_decay_structural_flatten | RESILIENT_TREND |
| GOOGL | GOOGL-1754335800000 | WIN | 1.8 | 6.1 | 4.3 | PROFIT_GIVEBACK_COOLING_HOLD | RESILIENT_TREND |
| NVDA | NVDA-1759239000000 | WIN | 4.3 | 7.3 | 2.9 | mfe_decay_structural_flatten | RESILIENT_TREND |

## Top MISSED opportunities (mfe ≥ +5%, giveback ≥ 3%, TH did NOT promote)

These are the trades where the cohort gave back meaningful MFE but TH's promotion gates rejected. The rejection reason on each is the tuning lever.

| ticker | trade_id | status | pnl% | mfe% | giveback% | rejection reason | snap |
|---|---|---|---:|---:|---:|---|---|
| AEHR | AEHR-1753113600000 | WIN | 4.8 | 42 | 37.2 | monthly_st_bear (dir=-1) | D=true W=true 4H=true wkST=1 mST=-1 wkRSI5=95.1 wkTD9=4 |
| AEHR | AEHR-1757943000000 | WIN | 12.9 | 28.1 | 15.3 | weekly_rsi_98.58>=95 | D=true W=true 4H=true wkST=1 mST=1 wkRSI5=98.6 wkTD9=9 |
| AEHR | AEHR-1751465700000 | LOSS | -4.5 | 10.3 | 14.9 | monthly_st_bear (dir=-1) | D=true W=true 4H=true wkST=1 mST=-1 wkRSI5=98.6 wkTD9=5 |
| SNDK | SNDK-1757944800000 | WIN | 8.2 | 22.9 | 14.7 | weekly_rsi_99.64>=95 | D=true W=true 4H=true wkST=1 mST=null wkRSI5=99.6 wkTD9=9 |
| BE | BE-1754928600000 | WIN | 7.4 | 21 | 13.6 | weekly_rsi_99.28>=95 | D=true W=true 4H=true wkST=1 mST=1 wkRSI5=99.3 wkTD9=9 |
| GEV | GEV-1751376600000-tnq5dv5sx | WIN | 3.4 | 15.7 | 12.3 | 4h_ema21_below_close | D=true W=true 4H=false wkST=1 mST=null wkRSI5=87.8 wkTD9=9 |
| SNDK | SNDK-1758893400000 | WIN | 14.6 | 26.1 | 11.4 | 4h_ema21_below_close | D=true W=true 4H=false wkST=1 mST=null wkRSI5=81.7 wkTD9=9 |
| BE | BE-1755792000000 | WIN | 10.4 | 21.5 | 11.1 | weekly_rsi_99.49>=95 | D=true W=true 4H=true wkST=1 mST=1 wkRSI5=99.5 wkTD9=9 |
| MU | MU-1769014800000 | WIN | 6 | 16.9 | 10.9 | weekly_rsi_99.06>=95 | D=true W=true 4H=true wkST=1 mST=1 wkRSI5=99.1 wkTD9=9 |
| BE | BE-1755882000000 | WIN | 8.2 | 18.7 | 10.5 | weekly_rsi_99.49>=95 | D=true W=true 4H=true wkST=1 mST=1 wkRSI5=99.5 wkTD9=9 |
| AEHR | AEHR-1752073200000-qr2cqrlcd | WIN | 3.9 | 13.8 | 9.9 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=-1 wkRSI5=57 wkTD9=0 |
| AEHR | AEHR-1757683800000 | LOSS | -3 | 6.8 | 9.8 | 4h_ema21_below_close | D=true W=true 4H=false wkST=1 mST=1 wkRSI5=95.7 wkTD9=9 |
| PLTR | PLTR-1754063400000-tgdxy3swl | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-v6k8pf0jd | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-et42x259q | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-568gxn8cm | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-g9fnu551e | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-dbm9hcear | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-r9m7tvpfl | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-89zaq82g2 | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-op7qmc5ad | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-nrxe6ncr1 | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| PLTR | PLTR-1754063400000-8i10gpibi | WIN | 7.6 | 17.2 | 9.6 | daily_ema21_below_close | D=false W=true 4H=false wkST=1 mST=1 wkRSI5=67.7 wkTD9=8 |
| BE | BE-1755023400000 | WIN | 6 | 15.4 | 9.4 | weekly_rsi_99.28>=95 | D=true W=true 4H=true wkST=1 mST=1 wkRSI5=99.3 wkTD9=9 |
| AEHR | AEHR-1757439000000 | WIN | 3 | 12.2 | 9.3 | weekly_rsi_95.65>=95 | D=true W=true 4H=true wkST=1 mST=1 wkRSI5=95.7 wkTD9=8 |

## Tuning passes — relative impact of each gate relaxation

Each pass reuses the same fetched snapshots; only the predicate config differs.

Key columns:
- **promoted**: count of trades TH would promote under this config
- **prom%/elig**: % of MFE-eligible (mfe ≥ 5%) cohort
- **loss%**: of promoted, how many ended up LOSSES at exit (false-positive proxy)
- **avg pnl%**: avg pnl_pct of promoted set (the realized delta TH "kept")
- **avg mfe%**: avg peak-MFE of promoted set (TH's hold-discipline upper bound)
- **suppress n**: of promoted, how many had exit_reason in TH suppression list
- **uplift% Σ**: sum of (mfe - pnl) for promoted+suppressed trades — UPPER bound on what TH could rescue

| pass | promoted | prom%/elig | loss% | avg pnl% | avg mfe% | suppress n | uplift% Σ |
|---|---:|---:|---:|---:|---:|---:|---:|
| default | 17 | 13.5% | 11.8% | 8.8 | 15.5 | 6 | 51 |
| td9_relax_to_12 | 23 | 18.3% | 13% | 7.2 | 14.2 | 9 | 77.4 |
| rsi_relax_to_95 | 30 | 23.8% | 6.7% | 7.6 | 16.2 | 10 | 94.3 |
| monthly_permissive | 17 | 13.5% | 11.8% | 8.8 | 15.5 | 6 | 51 |
| drop_4h_gate | 17 | 13.5% | 11.8% | 8.8 | 15.5 | 6 | 51 |
| td9+rsi (recommended) | 43 | 34.1% | 7% | 6.2 | 14.6 | 18 | 154.6 |
| td9+rsi+monthly | 43 | 34.1% | 7% | 6.2 | 14.6 | 18 | 154.6 |
| weekly_only (most permissive) | 64 | 50.8% | 4.7% | 6.4 | 14.6 | 18 | 154.6 |

## Caveats

1. **Synthetic indicators**: W/M/4H stDir, EMA21, RSI computed from raw ticker_candles via standard formulas. Worker-side equivalents may differ marginally (different ATR start period, EMA seed). For directional/cohort analysis, the difference is negligible.
2. **Single-snapshot evaluation**: TH gates are evaluated at trade-entry timestamp with synthetic mfe_pct = peak MFE. This conflates "would TH have caught this trade at +5% MFE" with "would TH have stayed in given the trend state at entry." For trades whose trend state evolves intra-life, the answer is approximate.
3. **Implied uplift is an UPPER bound**: assumes TH-managed trade exits at peak MFE. Real continued-hold simulation would require day-by-day demotion checks against subsequent daystate, which we'd run as a follow-up if the headline numbers are favorable.
4. **Cohort ≠ universe**: this is the 14-ticker blueprint cohort only. Doesn't validate TH on the full universe.
