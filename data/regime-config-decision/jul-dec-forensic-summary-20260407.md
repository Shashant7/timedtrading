# Jul-Dec Forensic Summary

Run basis:
- Primary archived lane: `full-jul-apr-v6-intu-jci-runtimefix-v1`
- Run ID: `backtest_2025-07-01_2026-04-03@2026-04-07T05:01:30.420Z`
- December supplement: live `trades` rows with `run_id IS NULL` and `entry_ts` in Dec 2025

Reason for December supplement:
- The still-flowing December trades are not yet stamped to the full-run `run_id`
- They are still relevant evidence for the Jul-Dec cleanup pass
- They were included in the analysis, but not blindly re-stamped into the run archive

## Combined Scope

- Archived Jul-Nov trades: `119`
- December live supplement trades: `51`
- Combined Jul-Dec evidence set: `170`

## Month-by-Month

| Month | Trades | Closed | Wins | Losses | Openish | Closed PnL | Win Rate |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2025-07 | 26 | 24 | 16 | 8 | 2 | `+$4,296.80` | `66.67%` |
| 2025-08 | 27 | 26 | 6 | 20 | 1 | `+$871.96` | `23.08%` |
| 2025-09 | 19 | 15 | 6 | 9 | 4 | `-$729.04` | `40.00%` |
| 2025-10 | 22 | 19 | 11 | 8 | 3 | `+$2,396.95` | `57.89%` |
| 2025-11 | 25 | 18 | 2 | 16 | 7 | `-$2,226.74` | `11.11%` |
| 2025-12 | 51 | 47 | 20 | 27 | 4 | `+$280.32` | `42.55%` |

## Rank Inflation

The rank drift appears in September, grows in October, and breaks trust by November/December.

| Month | Trades | `90+` rank | `95+` rank | `90+` losses |
|---|---:|---:|---:|---:|
| 2025-09 | 19 | 11 | 8 | 6 |
| 2025-10 | 22 | 18 | 9 | 7 |
| 2025-11 | 25 | 23 | 15 | 15 |
| 2025-12 | 51 | 47 | 36 | 26 |

December null-run supplement:
- Avg rank: `95.47`
- Avg rank for losses: `95.85`
- Avg rank for wins: `94.81`

Conclusion:
- By Nov/Dec, the rank is no longer separating good from bad trades.
- The problem is not just weak trade management; the engine is over-scoring many poor entries.

## MFE / MAE Coverage

Excursion data source:
- Archived rows: `backtest_run_direction_accuracy`
- December live rows: `direction_accuracy`

Coverage:
- Combined rows with excursion coverage: `73 / 170`
- Archived Jul-Nov covered: `28 / 119`
- December covered: `45 / 51`

This makes the Nov/Dec conclusions materially stronger than the Jul-Sep conclusions.

## MFE / MAE Findings

High-rank (`90+`) losses from Sep-Dec with excursion coverage:
- Total high-rank losses: `56`
- Covered with MFE/MAE: `45`
- `30 / 45` had `MFE < 0.5%`
- Only `8 / 45` had `MFE >= 1%`
- `0 / 45` had `MFE >= 2%`
- `39 / 45` had `abs(MAE) > MFE`
- `33 / 45` had `abs(MAE) >= 2x MFE`

Interpretation:
- Most high-rank Nov/Dec losers never really worked.
- This is primarily an `avoid entry` problem, not just a management problem.

December `90+` rank trade comparison with excursion coverage:

| Status | Count | Avg MFE | Avg MAE | Avg PnL |
|---|---:|---:|---:|---:|
| WIN | 15 | `3.494%` | `-2.348%` | `+$168.32` |
| LOSS | 26 | `0.456%` | `-1.448%` | `-$97.82` |

The winners expand. The losers mostly do not.

## Forensic Buckets

### Avoid Entry

Primary signature:
- High rank
- Very low MFE
- Immediate adverse move or hard loss path

Combined bucket:
- Count: `82`
- Net PnL: `-$7,007.26`

Representative names:
- `TEM`, `SWK`, `SLV`, `B`, `SANM`, `BE`, `CELH`, `WFRD`

Representative high-rank, low-MFE examples:
- `ACN` Dec: rank `90`, MFE `0.0717%`, MAE `-2.4963%`, exit `ema_regime_reversed`
- `LULU` Dec: rank `98`, MFE `0.0538%`, MAE `-1.3621%`, exit `doa_early_exit`
- `DTM` Dec: rank `100`, MFE `0.2313%`, MAE `-0.9294%`, exit `sl_breached,ichimoku_regime_break`
- `AU` Dec: rank `100`, MFE `0.0971%`, MAE `-1.2757%`, exit `sl_breached`
- `DIA` Dec: rank `95`, MFE `0.1434%`, MAE `-0.7984%`, exit `doa_early_exit`

### Manage Better

Primary signature:
- Trade reached trim or positive excursion
- Realized path still leaked too much or remained structurally weak

Combined bucket:
- Count: `21`
- Net PnL: `+$4,104.41`

Representative names:
- `SWK` trimmed-runner failure
- `AGYS` trimmed-runner failure
- `PSTG`, `CSX`, `UUUU` mixed trim/runner behavior

### Exit Earlier

Primary signature:
- Real trade opportunity existed, but the exit/de-risk came late relative to degradation

Combined bucket:
- Count: `11`
- Net PnL: `-$1,026.16`

Representative names:
- `RIOT`, `JCI`, `GRNY`, `OKE`, `ACN`

## Worst Combined Losses

Top losses across the combined Jul-Dec evidence:
- `AYI` Dec: `-$591.61`, rank `92`
- `TEM` Nov: `-$452.51`, rank `100`, `HARD_LOSS_CAP`
- `SWK` Nov: `-$418.35`, rank `91`, `HARD_LOSS_CAP`
- `SLV` Nov: `-$397.40`, rank `90`, `HARD_LOSS_CAP`
- `TEM` Nov: `-$393.30`, rank `100`, `HARD_LOSS_CAP`
- `WAL` Aug: `-$376.16`, `HARD_LOSS_CAP`
- `B` Nov: `-$337.74`, rank `95`, `HARD_LOSS_CAP`
- `SANM` Oct: `-$335.36`, rank `100`, `HARD_LOSS_CAP`
- `AA` Dec: `-$319.75`, rank `100`, `HARD_LOSS_CAP`
- `BE` Sep: `-$315.72`, rank `95`, `HARD_LOSS_CAP`

## Implication For Fix Ordering

Priority should be:
1. Reduce elite-rank inflation in Sep-Dec style environments
2. Tighten entry acceptance for `90+` trades that never achieve early excursion
3. Then tighten lifecycle logic for the smaller subset that did reach meaningful MFE before failing

## Coverage Follow-Up

Coverage gap identified:
- `direction_accuracy` / `backtest_run_direction_accuracy` holds MFE/MAE, not `trades`
- Some persistence helpers only trusted `trade.id`, while other paths can surface `trade.trade_id`
- This can silently skip direction-accuracy updates and reduce archive excursion coverage

Fix applied locally and deployed:
- direction-accuracy entry/exit helpers now accept both `id` and `trade_id`
- exit-side update backfills a minimal `direction_accuracy` row if the entry row was missed

Next validation:
- Confirm new replays/archive rows materially improve excursion coverage
- Then rerun the Jul-Dec loser board with fuller archived MFE/MAE support
