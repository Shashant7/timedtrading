# Model book autopsy — core vs experiments

Generated: 2026-08-23T13:51:44.377Z
Env: production live ledger ((run_id IS NULL OR run_id = ''))
Fills: 700 (closed 695, open 5)
First stamped `entry_path`: 2026-05-01
First paper-family stamp (coincident or standalone): 2026-08-05
First standalone experiment fill (family stamp, no canonical path): —

Classification: a canonical `entry_path` (Support Bounce, ATH, pullback, …) stays **core** even if a paper-family stamp sits on the payload (flagged coincident). Named slice stamps without a canonical path are the only standalone experiments. Do not treat the 60-day timing scan's family buckets as a dedicated experiment P&L book — those rows are mostly coincident stamps on core paths.

## Verdict — are experiments polluting the core?

- Blended book: n=700 closed=695 WR=48.7%  P&L=$37643.24  exp=0.52%  PF=1.86  MFE=3.37 MAE=0.41 keep=-0.946  notional~$9252.41
- Core only:    n=700 closed=695 WR=48.7%  P&L=$37643.24  exp=0.52%  PF=1.86  MFE=3.37 MAE=0.41 keep=-0.946  notional~$9252.41
- Standalone experiments:  n=0 closed=0 WR=—%  P&L=$0.00  exp=—%  PF=—  MFE=— MAE=— keep=—  notional~—
- Coincident paper-on-core-path: n=46 closed=42 WR=32.5%  P&L=-$670.41  exp=-0.44%  PF=0.36  MFE=2.12 MAE=2.25 keep=-1.054  notional~$2339.99

- Standalone experiment **dollar** drag vs core: $0.00 (blended − core)
- Standalone experiment **mix** drag on expectancy: 0.00 pp
- Standalone experiment **mix** drag on win rate: 0.0 pp
- Coincident paper-on-core P&L (still inside core): -$670.41 on 46 fills

**No standalone experiment fills in the live book.** Paper families have not opened their own tickets — they stamped core paths. Dollar pollution from a separate experiment book is $0. The live risk is (1) mis-attributing coincident core fills as experiments, and (2) size crush on a canonical path (AXON-class).

### Three eras (this is the degradation story)

- Unstamped historical core (no `entry_path`): n=565 closed=565 WR=52.7%  P&L=$41678.04  exp=0.78%  PF=2.15  MFE=37.37 MAE=0.01 keep=0.570  notional~$9949.64
- Stamped-path core, no paper stamp: n=89 closed=88 WR=30.7%  P&L=-$3364.39  exp=-0.76%  PF=0.47  MFE=3.02 MAE=2.04 keep=-0.912  notional~$6053.00
- Stamped-path + coincident paper stamp: n=46 closed=42 WR=32.5%  P&L=-$670.41  exp=-0.44%  PF=0.36  MFE=2.12 MAE=2.25 keep=-1.054  notional~$2339.99
- All stamped-path core (clean + coincident): n=135 closed=130 WR=31.3%  P&L=-$4034.80  exp=-0.65%  PF=0.45  MFE=2.58 MAE=2.11 keep=-0.981  notional~$4479.83

- Core before first stamped path (2026-05-01): n=560 closed=560 WR=52.8%  P&L=$40419.00  exp=0.77%  PF=2.13  MFE=— MAE=0.00 keep=—  notional~$9950.49
- Core after first stamped path: n=140 closed=135 WR=31.6%  P&L=-$2775.77  exp=-0.53%  PF=0.65  MFE=3.37 MAE=2.09 keep=-0.946  notional~$4680.00
- Core before first family stamp (2026-08-05): n=654 closed=653 WR=49.7%  P&L=$38313.65  exp=0.58%  PF=1.90  MFE=4.51 MAE=0.29 keep=-0.848  notional~$9422.00
- Core after first family stamp: n=46 closed=42 WR=32.5%  P&L=-$670.41  exp=-0.44%  PF=0.36  MFE=2.12 MAE=2.25 keep=-1.054  notional~$2339.99

If the unstamped book is the winner and the stamped-path book is the loser, that is **core engine-path degradation**, not experiment pollution. Paper stamps arriving in the same months as the new paths can make the two look like one story — they are not.

_Caveat: older unstamped rows usually have no MFE/MAE. Do not read keep/MFE on the all-time book._

## Scoreboard by program

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Confirm-stack | 0 | — | $0.00 | — | — | — | — | — |
| Cloud Pivot | 0 | — | $0.00 | — | — | — | — | — |
| Continuation | 0 | — | $0.00 | — | — | — | — | — |
| Core book | 700 | 48.7 | $37643.24 | 0.52 | 1.86 | 3.37 | 0.41 | -0.946 |

## Core — where it wins and loses

### By entry path

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| (unstamped) | 565 | 52.7 | $41678.04 | 0.78 | 2.15 | 37.37 | 0.01 | 0.570 |
| tt_n_test_support | 50 | 34.9 | -$853.92 | -0.39 | 0.57 | 2.62 | 1.80 | -1.223 |
| tt_ath_breakout | 42 | 35.7 | -$1396.75 | -0.68 | 0.24 | 1.61 | 1.85 | -0.788 |
| tt_gap_reversal_long | 20 | 20.0 | -$976.04 | -0.76 | 0.51 | 11.06 | 2.37 | 0.961 |
| tt_pullback | 10 | 30.0 | $54.42 | -0.47 | 1.10 | 2.61 | 2.64 | -1.392 |
| tt_range_reversal_long | 8 | 12.5 | -$904.30 | -2.38 | 0.00 | 1.66 | 3.18 | -1.986 |
| tt_htf_reclaim | 5 | 40.0 | $41.80 | 0.04 | 1.34 | 3.06 | 3.24 | -0.568 |

### Setup winners

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Gap Reversal Long | 348 | 56.9 | $37160.84 | 1.11 | 2.66 | 11.06 | 0.14 | 0.961 |
| Gap Reversal Short | 11 | 63.6 | $2078.43 | 1.83 | 10.38 | — | 0.00 | — |
| Setup | 5 | 40.0 | $1259.04 | 2.69 | 3.42 | 37.37 | 1.57 | 0.570 |
| N Test Support | 71 | 39.4 | $619.24 | 0.05 | 1.13 | 0.20 | 0.27 | 1.000 |
| Momentum | 3 | 66.7 | $596.01 | 1.78 | 15.33 | — | 0.00 | — |
| Range Reversal Long | 28 | 42.9 | $408.02 | -0.24 | 1.20 | 1.66 | 0.91 | -1.986 |
| Reclaim | 2 | 100.0 | $163.99 | 0.73 | 99.00 | — | 0.00 | — |
| Atl Breakdown | 7 | 28.6 | $131.20 | 0.26 | 1.50 | — | 0.00 | — |
| Htf Reclaim | 5 | 40.0 | $41.80 | 0.04 | 1.34 | 3.06 | 3.24 | -0.568 |

### Setup losers

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Ath Breakout | 104 | 37.5 | -$3120.81 | -0.40 | 0.47 | 1.61 | 0.75 | -0.788 |
| N Test Resistance | 13 | 38.5 | -$554.89 | -0.28 | 0.32 | — | 0.00 | — |
| Pullback | 59 | 47.5 | -$508.17 | -0.06 | 0.90 | 6.20 | 0.04 | 0.696 |
| Pullback Reclaim | 6 | 16.7 | -$368.67 | -1.38 | 0.04 | 0.82 | 4.03 | -2.435 |
| Support Bounce | 37 | 30.0 | -$262.81 | -0.30 | 0.79 | 2.78 | 1.93 | -1.371 |

### By session

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Midday 10:45–13:30 | 268 | 48.3 | $12577.89 | 0.46 | 1.66 | 1.48 | 0.28 | -1.498 |
| Afternoon 13:30–15:00 | 151 | 44.3 | $2006.52 | 0.11 | 1.21 | 2.53 | 0.35 | -1.278 |
| Open 9:30–10:00 | 106 | 51.4 | $8130.28 | 0.52 | 2.97 | 0.83 | 0.69 | -0.725 |
| 10am 10:00–10:45 | 99 | 56.7 | $12631.57 | 1.37 | 3.35 | 9.48 | 0.22 | -0.486 |
| Last hour 15:00–16:00 | 76 | 44.6 | $2296.98 | 0.43 | 1.43 | 6.69 | 0.81 | -0.319 |

### By month

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 2025-07 | 93 | 60.2 | $12731.48 | 1.34 | 3.99 | — | 0.00 | — |
| 2025-08 | 79 | 55.7 | $6146.88 | 0.83 | 2.28 | — | 0.00 | — |
| 2025-09 | 60 | 55.0 | $9287.31 | 1.42 | 3.31 | — | 0.00 | — |
| 2025-10 | 51 | 35.3 | -$2452.56 | -0.34 | 0.53 | — | 0.00 | — |
| 2025-11 | 21 | 47.6 | $1193.96 | 0.36 | 1.75 | — | 0.00 | — |
| 2025-12 | 53 | 52.8 | $3897.58 | 0.82 | 2.65 | — | 0.00 | — |
| 2026-01 | 76 | 60.5 | $8450.96 | 1.34 | 3.85 | — | 0.00 | — |
| 2026-02 | 72 | 50.0 | $1203.54 | 0.26 | 1.20 | — | 0.00 | — |
| 2026-03 | 35 | 37.1 | -$2951.62 | -0.85 | 0.27 | — | 0.00 | — |
| 2026-04 | 19 | 57.9 | $2911.47 | 1.56 | 6.51 | — | 0.00 | — |
| 2026-05 | 49 | 33.3 | $18.66 | -0.17 | 1.01 | 14.61 | 1.70 | 1.168 |
| 2026-06 | 14 | 30.8 | -$865.41 | -1.64 | 0.12 | 0.81 | 2.10 | 0.194 |
| 2026-07 | 32 | 28.1 | -$1258.61 | -0.74 | 0.44 | 2.25 | 2.40 | -1.578 |
| 2026-08 | 46 | 32.5 | -$670.41 | -0.44 | 0.36 | 2.12 | 2.25 | -1.054 |

### By direction

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| LONG | 662 | 48.8 | $35925.09 | 0.52 | 1.86 | 3.41 | 0.43 | -0.969 |
| SHORT | 38 | 47.4 | $1718.15 | 0.51 | 2.07 | 0.28 | 0.00 | 1.000 |

### By grade

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Prime | 389 | 54.6 | $39225.84 | 1.04 | 2.47 | 9.21 | 0.10 | -0.783 |
| Confirmed | 205 | 43.8 | $554.32 | 0.13 | 1.05 | 3.17 | 0.41 | -0.975 |
| Speculative | 105 | 35.6 | -$2136.93 | -0.70 | 0.57 | 2.32 | 1.55 | -0.963 |
| (none) | 1 | — | $0.00 | 0.00 | — | — | 0.00 | — |

### By exit reason (volume)

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| sl_breached | 57 | 49.1 | $7548.87 | 1.37 | 3.92 | 3.22 | 1.35 | -1.180 |
| doctrine_force_exit | 56 | 7.1 | -$7980.75 | -1.46 | 0.07 | 0.61 | 0.28 | -5.743 |
| TP_FULL | 47 | 100.0 | $14653.18 | 3.23 | 99.00 | 2.01 | 0.03 | 0.772 |
| SMART_RUNNER_SUPPORT_BREAK_CLOUD | 47 | 48.9 | $1263.92 | 0.33 | 1.72 | 2.38 | 0.14 | -0.057 |
| thesis_flip_htf | 45 | 15.6 | -$3052.37 | -0.67 | 0.07 | 0.54 | 0.27 | -3.357 |
| max_loss | 36 | 8.3 | -$4355.98 | -2.01 | 0.01 | 2.45 | 1.74 | -1.485 |
| PROFIT_GIVEBACK_STAGE_HOLD | 36 | 94.4 | $3313.94 | 0.93 | 18.56 | 3.20 | 0.23 | 0.087 |
| max_loss_time_scaled | 32 | 15.6 | -$3133.05 | -0.83 | 0.05 | — | 0.00 | — |
| atr_week_618_full_exit | 31 | 74.2 | $4629.87 | 1.47 | 23.66 | 0.31 | 0.02 | 2.751 |
| mfe_decay_structural_flatten | 29 | 93.1 | $4522.62 | 1.57 | 9.83 | — | 0.00 | — |
| ST_FLIP_4H_CLOSE | 26 | 100.0 | $9367.15 | 3.58 | 99.00 | — | 0.00 | — |
| atr_day_adverse_382_cut | 26 | 11.5 | -$1768.29 | -0.79 | 0.05 | — | 0.19 | — |
| HARD_FUSE_RSI_EXTREME | 21 | 90.5 | $13948.25 | 6.23 | 112.22 | — | 0.00 | — |
| peak_lock_ema12_deep_break | 19 | 94.7 | $5747.04 | 3.37 | 122.59 | — | 0.00 | — |
| SOFT_FUSE_RSI_CONFIRMED | 16 | 93.8 | $3493.99 | 1.99 | 233.39 | 12.11 | 0.00 | 0.392 |

### Exit reasons that bled (worst $)

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| doctrine_force_exit | 56 | 7.1 | -$7980.75 | -1.46 | 0.07 | 0.61 | 0.28 | -5.743 |
| HARD_LOSS_CAP | 14 | 0.0 | -$5428.37 | -4.32 | 0.00 | 1.11 | 2.49 | -3.793 |
| max_loss | 36 | 8.3 | -$4355.98 | -2.01 | 0.01 | 2.45 | 1.74 | -1.485 |
| max_loss_time_scaled | 32 | 15.6 | -$3133.05 | -0.83 | 0.05 | — | 0.00 | — |
| thesis_flip_htf | 45 | 15.6 | -$3052.37 | -0.67 | 0.07 | 0.54 | 0.27 | -3.357 |
| phase_i_mfe_fast_cut_2h | 15 | 0.0 | -$1875.89 | -1.13 | 0.00 | — | 0.11 | — |
| v13_hard_pnl_floor | 5 | 0.0 | -$1849.54 | -4.74 | 0.00 | — | 2.06 | — |
| atr_day_adverse_382_cut | 26 | 11.5 | -$1768.29 | -0.79 | 0.05 | — | 0.19 | — |
| phase_i_mfe_fast_cut_zero_mfe | 12 | 0.0 | -$1643.60 | -1.23 | 0.00 | — | 0.00 | — |
| PRE_EARNINGS_FORCE_EXIT | 7 | 0.0 | -$867.88 | -1.09 | 0.00 | — | 0.00 | — |

### Exit reasons that paid (best $)

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| TP_FULL | 47 | 100.0 | $14653.18 | 3.23 | 99.00 | 2.01 | 0.03 | 0.772 |
| HARD_FUSE_RSI_EXTREME | 21 | 90.5 | $13948.25 | 6.23 | 112.22 | — | 0.00 | — |
| ST_FLIP_4H_CLOSE | 26 | 100.0 | $9367.15 | 3.58 | 99.00 | — | 0.00 | — |
| sl_breached | 57 | 49.1 | $7548.87 | 1.37 | 3.92 | 3.22 | 1.35 | -1.180 |
| peak_lock_ema12_deep_break | 19 | 94.7 | $5747.04 | 3.37 | 122.59 | — | 0.00 | — |
| atr_week_618_full_exit | 31 | 74.2 | $4629.87 | 1.47 | 23.66 | 0.31 | 0.02 | 2.751 |
| mfe_decay_structural_flatten | 29 | 93.1 | $4522.62 | 1.57 | 9.83 | — | 0.00 | — |
| SOFT_FUSE_RSI_CONFIRMED | 16 | 93.8 | $3493.99 | 1.99 | 233.39 | 12.11 | 0.00 | 0.392 |
| PROFIT_GIVEBACK_STAGE_HOLD | 36 | 94.4 | $3313.94 | 0.93 | 18.56 | 3.20 | 0.23 | 0.087 |
| RUNNER_STALE_FORCE_CLOSE | 1 | 100.0 | $1750.88 | 18.58 | 99.00 | 74.44 | 0.00 | 0.250 |

### Core ticker winners

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| SNDK | 12 | 75.0 | $5785.03 | 4.29 | 9.65 | 74.44 | 0.00 | 0.250 |
| JOBY | 2 | 50.0 | $4744.75 | 19.52 | 14.47 | — | 0.00 | — |
| APLD | 9 | 66.7 | $2790.95 | 2.57 | 19.59 | — | 0.00 | — |
| AEHR | 9 | 88.9 | $2687.59 | 3.20 | 66.90 | — | 0.00 | — |
| BE | 9 | 77.8 | $2507.74 | 3.07 | 4.73 | — | 0.00 | — |
| AGQ | 9 | 55.6 | $1756.97 | 1.51 | 3.54 | — | 0.00 | — |
| ASTS | 2 | 100.0 | $1688.32 | 8.00 | 99.00 | — | 0.00 | — |
| KLAC | 10 | 70.0 | $1685.36 | 1.77 | 5.60 | — | 0.00 | — |
| AMD | 6 | 83.3 | $1558.40 | 2.70 | 12.10 | — | 0.00 | — |
| ETHA | 4 | 75.0 | $1410.70 | 3.42 | 154.64 | — | 0.00 | — |
| GOOGL | 12 | 75.0 | $1278.34 | 1.10 | 11.49 | — | 0.00 | — |
| KTOS | 4 | 100.0 | $1142.67 | 2.85 | 99.00 | — | 0.00 | — |
| STX | 10 | 60.0 | $1133.81 | 0.69 | 2.76 | — | 0.35 | — |
| CCJ | 6 | 66.7 | $1051.97 | 1.78 | 2.75 | — | 0.00 | — |
| CAT | 7 | 57.1 | $1023.09 | 1.25 | 2.95 | — | 0.00 | — |

### Core ticker losers

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| INTC | 4 | 0.0 | -$968.97 | -2.70 | 0.00 | 0.84 | 1.45 | -4.664 |
| ANET | 7 | 14.3 | -$846.41 | -1.26 | 0.03 | — | 0.00 | — |
| CVNA | 5 | 20.0 | -$835.93 | -1.30 | 0.20 | — | 0.00 | — |
| SN | 4 | 0.0 | -$746.19 | -2.40 | 0.00 | 1.48 | 1.04 | -1.445 |
| XLI | 5 | 20.0 | -$568.05 | -1.52 | 0.05 | 0.31 | 0.59 | -1.867 |
| HIMX | 2 | 50.0 | -$539.78 | -2.56 | 0.02 | 0.16 | 6.12 | 4.501 |
| HUBS | 2 | 0.0 | -$534.59 | -2.06 | 0.00 | — | 0.00 | — |
| AMZN | 6 | 16.7 | -$507.16 | -1.02 | 0.18 | 0.47 | 0.33 | -3.839 |
| QXO | 2 | 0.0 | -$392.89 | -2.03 | 0.00 | — | 0.00 | — |
| KO | 5 | 0.0 | -$391.49 | -1.05 | 0.00 | 1.35 | 2.11 | -2.873 |
| CW | 8 | 37.5 | -$389.04 | -0.21 | 0.47 | — | 0.13 | — |
| XHB | 4 | 0.0 | -$382.94 | -0.72 | 0.00 | 0.47 | 0.37 | -0.102 |
| AU | 1 | 0.0 | -$321.28 | -3.16 | 0.00 | — | 0.00 | — |
| ARM | 2 | 0.0 | -$320.50 | -1.76 | 0.00 | — | 0.00 | — |
| NVDA | 2 | 0.0 | -$318.49 | -3.96 | 0.00 | 1.06 | 6.97 | -0.705 |

### Core tickers that never won (n≥3, 0 wins)

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| INTC | 4 | 0.0 | -$968.97 | -2.70 | 0.00 | 0.84 | 1.45 | -4.664 |
| SN | 4 | 0.0 | -$746.19 | -2.40 | 0.00 | 1.48 | 1.04 | -1.445 |
| KO | 5 | 0.0 | -$391.49 | -1.05 | 0.00 | 1.35 | 2.11 | -2.873 |
| XHB | 4 | 0.0 | -$382.94 | -0.72 | 0.00 | 0.47 | 0.37 | -0.102 |
| AGYS | 4 | 0.0 | -$296.20 | -0.68 | 0.00 | — | 0.00 | — |
| BA | 3 | 0.0 | -$270.38 | -0.73 | 0.00 | — | 0.00 | — |
| XLV | 3 | 0.0 | -$231.83 | -0.71 | 0.00 | — | 0.00 | — |
| WTS | 3 | 0.0 | -$169.32 | -0.47 | 0.00 | — | 0.00 | — |
| XLP | 3 | 0.0 | -$125.51 | -0.41 | 0.00 | — | 0.00 | — |
| RPG | 3 | 0.0 | -$92.38 | -0.71 | 0.00 | 0.53 | 0.92 | -1.246 |

### Stamped-path core with no paper stamp (May–Jul class)

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tt_n_test_support | 31 | 36.7 | -$751.80 | -0.46 | 0.57 | 2.69 | 1.83 | -1.288 |
| tt_ath_breakout | 23 | 34.8 | -$918.62 | -0.79 | 0.28 | 1.43 | 1.53 | -0.830 |
| tt_gap_reversal_long | 20 | 20.0 | -$976.04 | -0.76 | 0.51 | 11.06 | 2.37 | 0.961 |
| tt_pullback | 9 | 33.3 | $56.47 | -0.46 | 1.10 | 3.12 | 2.28 | -0.604 |
| tt_range_reversal_long | 6 | 16.7 | -$774.39 | -2.53 | 0.00 | 1.85 | 3.56 | -1.863 |

### Experiment-named exits on core fills

Cloud Pivot (and any confirm-stack) exit reasons firing on a canonical `entry_path`. This is management overlay, not a standalone experiment fill.

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tt_cloud_pivot_34_50_mtf_exit | 7 | 57.1 | -$75.65 | -0.09 | 0.22 | 0.85 | 0.95 | -0.043 |
| tt_cloud_pivot_5_12_close_exit | 5 | 0.0 | -$29.98 | -0.28 | 0.00 | 0.54 | 3.19 | -1.504 |

## Coincident paper stamps on core paths

Canonical engine entries that also carry a paper family stamp. They stay in CORE. Do not widen a family or retire a family on this sample.

### Coincident by family stamp

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| confirm_stack_ema21 | 30 | 42.3 | -$172.22 | -0.20 | 0.66 | 2.45 | 2.33 | -0.617 |
| tt_cloud_pivot | 16 | 14.3 | -$498.19 | -0.87 | 0.08 | 1.53 | 2.10 | -1.839 |

### Coincident by entry path

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tt_ath_breakout | 19 | 36.8 | -$478.13 | -0.54 | 0.15 | 1.75 | 2.23 | -0.757 |
| tt_n_test_support | 19 | 30.8 | -$102.12 | -0.26 | 0.56 | 2.53 | 1.74 | -1.150 |
| tt_htf_reclaim | 5 | 40.0 | $41.80 | 0.04 | 1.34 | 3.06 | 3.24 | -0.568 |
| tt_range_reversal_long | 2 | 0.0 | -$129.91 | -1.93 | 0.00 | 1.29 | 2.02 | -2.232 |
| tt_pullback | 1 | 0.0 | -$2.05 | -0.55 | 0.00 | 0.10 | 5.88 | -5.331 |

### Coincident by setup

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Ath Breakout | 19 | 36.8 | -$478.13 | -0.54 | 0.15 | 1.75 | 2.23 | -0.757 |
| Support Bounce | 19 | 30.8 | -$102.12 | -0.26 | 0.56 | 2.53 | 1.74 | -1.150 |
| Htf Reclaim | 5 | 40.0 | $41.80 | 0.04 | 1.34 | 3.06 | 3.24 | -0.568 |
| Range Reversal Long | 2 | 0.0 | -$129.91 | -1.93 | 0.00 | 1.29 | 2.02 | -2.232 |
| Pullback Reclaim | 1 | 0.0 | -$2.05 | -0.55 | 0.00 | 0.10 | 5.88 | -5.331 |

### Coincident by session

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Midday 10:45–13:30 | 16 | 33.3 | -$374.58 | -0.53 | 0.17 | 1.43 | 1.90 | -1.270 |
| Afternoon 13:30–15:00 | 12 | 30.0 | -$21.10 | -0.30 | 0.89 | 3.25 | 3.34 | -1.579 |
| Last hour 15:00–16:00 | 10 | 25.0 | -$221.40 | -0.66 | 0.15 | 2.71 | 2.50 | -0.586 |
| 10am 10:00–10:45 | 5 | 75.0 | $69.97 | 0.43 | 3.37 | 1.48 | 0.90 | -0.164 |
| Open 9:30–10:00 | 3 | 0.0 | -$123.31 | -1.19 | 0.00 | 1.16 | 1.86 | -1.109 |

### Coincident by size lane

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| mid_2k_8k | 23 | 26.3 | -$584.10 | -0.70 | 0.33 | 1.78 | 1.61 | -1.296 |
| crushed_<2k | 20 | 36.8 | -$88.11 | -0.22 | 0.43 | 2.46 | 2.61 | -0.911 |
| fullish_>=8k | 3 | 50.0 | $1.80 | 0.02 | 1.08 | 2.19 | 5.06 | -0.062 |

### Coincident ticker winners

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| LLY | 1 | 100.0 | $140.96 | 3.48 | 99.00 | 8.63 | 2.22 | 0.403 |
| USO | 1 | 100.0 | $80.39 | 2.17 | 99.00 | 2.42 | 0.47 | 0.895 |
| RTX | 2 | 100.0 | $40.07 | 0.52 | 99.00 | 1.91 | 0.72 | 0.270 |
| XLB | 1 | 100.0 | $32.81 | 0.88 | 99.00 | 1.92 | 0.77 | 0.461 |
| DE | 2 | 100.0 | $27.88 | 0.30 | 99.00 | 2.80 | 7.94 | 0.110 |
| AXON | 1 | 100.0 | $15.59 | 2.41 | 99.00 | 9.17 | 1.14 | 0.262 |
| EWBC | 2 | 100.0 | $2.53 | 0.24 | 99.00 | 0.43 | 0.86 | 0.617 |
| PNC | 1 | 100.0 | $1.70 | 0.25 | 99.00 | 0.46 | 0.98 | 0.547 |
| JD | 1 | 100.0 | $1.61 | 0.17 | 99.00 | 2.54 | 2.11 | 0.066 |

### Coincident ticker losers

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| WAL | 2 | 0.0 | -$129.91 | -1.93 | 0.00 | 1.29 | 2.02 | -2.232 |
| CPER | 1 | 0.0 | -$123.77 | -1.60 | 0.00 | 0.57 | 2.47 | -2.782 |
| HII | 2 | 0.0 | -$110.53 | -2.54 | 0.00 | 0.58 | 2.70 | -5.498 |
| XYZ | 2 | 0.0 | -$105.27 | -0.74 | 0.00 | 0.93 | 1.74 | -1.014 |
| PH | 3 | 33.3 | -$99.63 | 1.42 | 0.29 | 4.16 | 1.50 | -0.442 |
| SNOW | 1 | 0.0 | -$87.28 | -2.09 | 0.00 | 3.00 | 2.10 | -0.699 |
| TT | 1 | 0.0 | -$76.37 | -3.12 | 0.00 | 1.08 | 3.49 | -2.888 |
| JCI | 1 | 0.0 | -$47.08 | -2.11 | 0.00 | 2.15 | 2.14 | -0.980 |
| FLR | 1 | 0.0 | -$43.21 | -1.74 | 0.00 | 2.77 | 2.17 | -0.628 |
| SN | 2 | 0.0 | -$37.53 | -1.35 | 0.00 | 1.48 | 2.09 | -1.445 |

## Standalone experiments — where they win and lose

_None in the live book. Confirm-stack, Cloud Pivot, and Continuation have not filled as their own `entry_path`. The 60-day timing scan's family rows were coincident stamps on core paths._

### By program

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Confirm-stack | 0 | — | $0.00 | — | — | — | — | — |
| Cloud Pivot | 0 | — | $0.00 | — | — | — | — | — |
| Continuation | 0 | — | $0.00 | — | — | — | — | — |

### By setup

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

### By session

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

### By month

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

### By exit reason

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

### Experiment ticker winners

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

### Experiment ticker losers

| Slice | N | WR % | P&L | Exp % | PF | MFE | MAE | Keep |
|---|---:|---:|---:|---:|---:|---:|---:|---:|

## Tickers in both books

_No overlapping tickers._

## Open live fills

- GEV tt_n_test_support notional=$8846.33
- CSX tt_n_test_support stamp=confirm_stack_ema21 notional=$9698.08
- UNP tt_n_test_support stamp=tt_cloud_pivot notional=$6681.60
- TSM tt_n_test_support stamp=confirm_stack_ema21 notional=$2021.74
- J tt_n_test_support stamp=confirm_stack_ema21 notional=$5546.27

## Coincident fill list

Coincident fills (core path + paper stamp): 46

- 2026-08-05 PH tt_ath_breakout stamp=tt_cloud_pivot WIN $40.60 notional=$577.05 exit=sl_breached
- 2026-08-05 DE tt_n_test_support stamp=confirm_stack_ema21 WIN $3.74 notional=$1176.00 exit=mfe_ratchet_giveback
- 2026-08-06 CSX tt_ath_breakout stamp=tt_cloud_pivot LOSS -$14.29 notional=$642.01 exit=max_loss
- 2026-08-07 JD tt_ath_breakout stamp=confirm_stack_ema21 WIN $1.61 notional=$956.36 exit=sl_breached
- 2026-08-07 PNC tt_ath_breakout stamp=tt_cloud_pivot WIN $1.70 notional=$668.16 exit=tt_cloud_pivot_34_50_mtf_exit
- 2026-08-07 EWBC tt_ath_breakout stamp=confirm_stack_ema21 WIN $1.21 notional=$371.52 exit=tt_cloud_pivot_34_50_mtf_exit
- 2026-08-07 WAL tt_range_reversal_long stamp=tt_cloud_pivot LOSS -$8.97 notional=$450.00 exit=sl_breached
- 2026-08-07 KO tt_pullback stamp=confirm_stack_ema21 LOSS -$2.05 notional=$371.52 exit=tt_cloud_pivot_5_12_close_exit
- 2026-08-07 UNP tt_n_test_support stamp=tt_cloud_pivot LOSS -$2.05 notional=$704.31 exit=tt_cloud_pivot_34_50_mtf_exit
- 2026-08-07 MTB tt_ath_breakout stamp=confirm_stack_ema21 LOSS -$3.76 notional=$1152.00 exit=tt_cloud_pivot_5_12_close_exit
- 2026-08-07 IYT tt_ath_breakout stamp=confirm_stack_ema21 LOSS -$1.06 notional=$600.00 exit=tt_cloud_pivot_5_12_close_exit
- 2026-08-10 EWBC tt_ath_breakout stamp=confirm_stack_ema21 WIN $1.31 notional=$864.00 exit=tt_cloud_pivot_34_50_mtf_exit
- 2026-08-10 RPG tt_n_test_support stamp=tt_cloud_pivot LOSS -$0.76 notional=$634.27 exit=tt_cloud_pivot_5_12_close_exit
- 2026-08-12 AXON tt_n_test_support stamp=confirm_stack_ema21 WIN $15.59 notional=$648.00 exit=sl_breached
- 2026-08-12 IHF tt_n_test_support stamp=tt_cloud_pivot FLAT $0.00 notional=$1152.00 exit=sl_breached
- 2026-08-13 RTX tt_ath_breakout stamp=confirm_stack_ema21 WIN $17.47 notional=$3925.35 exit=tt_cloud_pivot_34_50_mtf_exit
- 2026-08-13 XHB tt_n_test_support stamp=confirm_stack_ema21 LOSS -$3.14 notional=$2750.38 exit=sl_breached
- 2026-08-13 CPER tt_ath_breakout stamp=confirm_stack_ema21 LOSS -$123.77 notional=$7737.60 exit=STALL_FORCE_CLOSE
- 2026-08-13 TT tt_ath_breakout stamp=tt_cloud_pivot LOSS -$76.37 notional=$2446.56 exit=max_loss
- 2026-08-13 PH tt_ath_breakout stamp=tt_cloud_pivot LOSS -$12.38 notional=$4739.99 exit=tt_cloud_pivot_34_50_mtf_exit
- 2026-08-13 JCI tt_ath_breakout stamp=confirm_stack_ema21 LOSS -$47.08 notional=$2233.43 exit=max_loss
- 2026-08-13 SN tt_ath_breakout stamp=confirm_stack_ema21 LOSS -$26.57 notional=$1234.65 exit=max_loss
- 2026-08-13 WAL tt_range_reversal_long stamp=tt_cloud_pivot LOSS -$120.94 notional=$6480.00 exit=POST_TRIM_ENTRY_FLOOR
- 2026-08-14 XHB tt_n_test_support stamp=confirm_stack_ema21 FLAT $0.00 notional=$4268.98 exit=sl_breached
- 2026-08-14 USO tt_n_test_support stamp=confirm_stack_ema21 WIN $80.39 notional=$3711.08 exit=TP_FULL
- 2026-08-14 CSX tt_n_test_support stamp=confirm_stack_ema21 OPEN $185.38 notional=$9698.08 exit=unknown
- 2026-08-14 EMR tt_ath_breakout stamp=tt_cloud_pivot LOSS -$33.25 notional=$1571.13 exit=max_loss
- 2026-08-14 XLRE tt_n_test_support stamp=tt_cloud_pivot LOSS -$33.10 notional=$4680.00 exit=sl_breached
- 2026-08-14 UNP tt_n_test_support stamp=tt_cloud_pivot OPEN $218.27 notional=$6681.60 exit=unknown
- 2026-08-14 RTX tt_ath_breakout stamp=confirm_stack_ema21 WIN $22.60 notional=$3811.33 exit=mfe_ratchet_giveback
- 2026-08-14 SNOW tt_ath_breakout stamp=confirm_stack_ema21 LOSS -$87.28 notional=$4166.34 exit=max_loss
- 2026-08-17 XYZ tt_htf_reclaim stamp=confirm_stack_ema21 LOSS -$82.92 notional=$6750.00 exit=tt_cloud_pivot_34_50_mtf_exit
- 2026-08-17 SPOT tt_htf_reclaim stamp=confirm_stack_ema21 LOSS -$18.04 notional=$855.81 exit=max_loss
- 2026-08-17 PH tt_ath_breakout stamp=tt_cloud_pivot LOSS -$127.86 notional=$5105.07 exit=max_loss
- 2026-08-17 HII tt_n_test_support stamp=tt_cloud_pivot LOSS -$30.70 notional=$1453.82 exit=max_loss
- 2026-08-17 LLY tt_htf_reclaim stamp=confirm_stack_ema21 WIN $140.96 notional=$4049.27 exit=sl_breached
- 2026-08-17 SN tt_ath_breakout stamp=confirm_stack_ema21 LOSS -$10.96 notional=$2027.49 exit=mfe_ratchet_giveback
- 2026-08-18 XYZ tt_htf_reclaim stamp=confirm_stack_ema21 LOSS -$22.34 notional=$9000.00 exit=tt_cloud_pivot_5_12_close_exit
- 2026-08-18 IYT tt_n_test_support stamp=confirm_stack_ema21 LOSS -$29.49 notional=$4680.00 exit=thesis_flip_htf
- 2026-08-18 XLB tt_n_test_support stamp=confirm_stack_ema21 WIN $32.81 notional=$3715.20 exit=sl_breached
- 2026-08-18 HII tt_n_test_support stamp=tt_cloud_pivot LOSS -$79.83 notional=$2682.97 exit=doctrine_force_exit
- 2026-08-18 GEV tt_n_test_support stamp=confirm_stack_ema21 LOSS -$12.37 notional=$1316.84 exit=max_loss
- 2026-08-18 TSM tt_n_test_support stamp=confirm_stack_ema21 OPEN $26.01 notional=$2021.74 exit=unknown
- 2026-08-18 FLR tt_n_test_support stamp=confirm_stack_ema21 LOSS -$43.21 notional=$2483.75 exit=max_loss
- 2026-08-18 J tt_n_test_support stamp=confirm_stack_ema21 OPEN $183.63 notional=$5546.27 exit=unknown
- 2026-08-20 DE tt_htf_reclaim stamp=confirm_stack_ema21 WIN $24.14 notional=$8641.35 exit=PROFIT_GIVEBACK_STAGE_HOLD

Skill: `skills/program-timing.md`. Re-run: `node scripts/program-book-autopsy.mjs --wrangler-d1 production --remote`