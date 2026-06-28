# Phase D slice — 2025-07 (run_id `phase-d-slice-2025-07-v5`)

> v5 refinements on merged PR #862 index model: doctrine defer, high-rank
> earnings-cluster block, index re-entry cooldown, XLY unpause, 5× retry /
> 45s backoff. **Full 22/22 sessions** (Jul 23–24 recovered vs v4).

## Headline vs anchor

| Metric | **v5** | v4 | v1 anchor |
|---|---|---|---|
| Sessions | **22/22** | 20/22 (Jul 23–24 skipped) | 22/22 |
| Trades | **26** | 24 | 25 |
| Win rate | **57.7%** | 54.2% | **76.0%** |
| Sum `pnl_pct` | **+9.24%** | +8.29% | **+26.05%** |
| Index entries | 7 (+1.46%) | 7 (+1.70%) | 0 |

v5 improved on v4 but **does not beat the anchor**.

## What helped vs v4

- XLY restored (+0.80%, +0.39%) via `deep_audit_cohort_sector_etf_pause_enabled=false`
- Full month replay (+2 sessions, Jul 23–24)
- Index cooldown reduced duplicate SPY entry (3 → 2 on same day)

## Remaining damage (vs anchor)

| Trade | PnL | Issue |
|---|---|---|
| TSLA | −3.95% | Not in anchor; earnings-cluster gate did not fire (empty `market_events` on preprod) |
| SWK | −3.21% | Same — cluster windows never built |
| MTZ / ON / SGI | −1.37 / −1.77 / −1.06% | `doctrine_force_exit` — defer missed `openPosition.rank` |
| Missing AMZN | ~+1.43% | `deep_audit_ticker_blacklist` includes AMZN |
| Missing ETN / GRNY / RIOT | ~+1.9% net | Preprod warm-up: first entries Jul 17, not Jul 1 |

## v6 follow-ups (same branch)

1. July earnings cluster **fallback** from backdrop when events empty
2. Doctrine defer reads `openPosition.rank`
3. Remove AMZN from slice blacklist; lower focus conviction floor to 70

Re-run: `phase-d-slice-2025-07-v6` after deploy + `node scripts/push-july-v6-config.mjs`.
