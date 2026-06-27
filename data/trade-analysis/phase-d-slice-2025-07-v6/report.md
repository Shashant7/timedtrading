# Phase D slice — 2025-07 (run_id `phase-d-slice-2025-07-v6`)

> v5 + earnings cluster fallback, doctrine `openPosition.rank`, AMZN removed from
> blacklist, focus conviction floor 70.

## Headline vs anchor

| Metric | **v6** | v5 | v1 anchor |
|---|---|---|---|
| Trades | 26 | 26 | 25 |
| Win rate | **65.4%** | 57.7% | **76.0%** |
| Sum `pnl_pct` | **+18.08%** | +9.24% | **+26.05%** |

**Does not beat anchor** but closes ~9 pp of the v5 gap (+8.84 pp on sum pnl).

## Key delta vs v5

- **CDNS Jul 23 +7.36%** (`TP_FULL`) — anchor-scale winner restored
- WR +7.7 pp (fewer scratch losses on index/singles)
- TSLA (−3.95%) and SWK (−3.21%) **still entered** — cluster gate used
  `minTickers=4` so the 3-name Jul 23 cluster never applied; v7 merges backdrop
  clusters unconditionally

## Counterfactual

Removing TSLA + SWK damage only (−7.16%) would put v6 at **~+25.2%** sum pnl
(near anchor +26.05%). v7 deploys cluster merge + `minTickers=3`.

## Re-run

```bash
node scripts/push-july-v6-config.mjs   # includes min_tickers=3 after v7 commit
scripts/monthly-slice.sh --month=2025-07 --run-id=phase-d-slice-2025-07-v7 ...
```
