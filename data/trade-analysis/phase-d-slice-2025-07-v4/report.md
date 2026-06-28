# Phase D slice — 2025-07 (run_id `phase-d-slice-2025-07-v4`)

> Per-ticker **slow-range index model** + singles demotion reverted (index-only).
> **Caveat:** Jul 23–24 sessions failed (preprod 503/1102) and were skipped;
> resume completed Jul 25–31 only. Re-run full month when preprod is stable.

## Headline comparison

| Metric | **v4** | v3 | v2 | v1 anchor |
|---|---|---|---|---|
| Trades | **24** | 17 | 42 | 25 |
| Win rate | **54.2%** | 52.9% | 45.2% | 76.0% |
| Sum pnl_pct | **+8.29%** | +14.72% | +25.64% | +26.05% |
| Index entries | **7** | 0 | 15 | 0 |
| Index WR / pnl | **71.4% / +1.70%** | — | 20% / −4.59% | — |

## Index model (corrected approach)

| Ticker | Path | Trades | Net pnl |
|---|---|---|---|
| SPY | `tt_index_etf_swing` | 3 | +0.76% |
| QQQ | `tt_index_etf_swing` | 2 | +1.50% |
| IWM | `tt_index_etf_swing` | 2 | −0.57% |

Indices now trade via **adapted slow-range rules** (not stock ATH/pullback).
SPY profile: rvol ≥ 0.45, rank ≥ 88, in-cloud OK, ride-runner at 0.6% MFE.

## Singles regression fixes vs v3

- Support demotion **index-only** — singles `tt_n_test_support` restored (2 trades)
- Index allowed in `HTF_BULL_LTF_BULL` slow grind (July calm uptrend)

## Remaining gaps vs anchor

1. **Missing Jul 23–24** replay days (503) — likely cost several anchor trades
2. **TSLA −3.95%** HARD_LOSS_CAP still present
3. Singles WR 47% vs anchor 76% — needs separate investigation

## Re-run

Full clean re-run recommended:

```bash
node scripts/push-july-v4-config.mjs
scripts/monthly-slice.sh --month=2025-07 --run-id=phase-d-slice-2025-07-v4-full \
  --tickers=tier1-tier2 --block-chain \
  --api-base=https://timed-trading-ingest-preprod.shashant.workers.dev
```
