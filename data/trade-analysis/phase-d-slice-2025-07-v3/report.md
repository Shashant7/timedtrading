# Phase D slice — 2025-07 (run_id `phase-d-slice-2025-07-v3`)

> Re-run on **preprod** after **index ETF model + July v3 gates** (deploy
> `c1223bff`, config push 2026-06-27). Compare to v2 and Phase C anchor.

## Run envelope

| Field | Value |
|---|---|
| `run_id` | `phase-d-slice-2025-07-v3` |
| Environment | `timed-trading-ingest-preprod` |
| Worker version | `c1223bff-3fae-407e-aa0a-da729f30c254` |
| Window | 2025-07-01 → 2025-07-31 (22 sessions) |
| Universe | 24 tickers (tier1-tier2) |
| Wall-clock | ~53 min |

## Code + config shipped for v3

| Change | Detail |
|---|---|
| **Index ETF model** | SPY/QQQ/IWM routed only through `tt_index_etf_swing`; stock paths blocked |
| Index model gates | rank ≥ 95, rvol ≥ 1.0, HTF_BULL_LTF_PULLBACK only, m30 reclaim |
| Legacy swing bypass | `deep_audit_index_etf_swing_enabled=false` |
| Setup demotion wired | support + range reversal (`tt_n_test_support` blocked) |
| Earnings cluster gate | ≥4 tickers, anchor ±1 day, rank bypass 97 |
| Tape capitulation | min loss −0.5%, skip if MFE ≥ 0.5%, index swing exempt |

## Headline comparison

| Metric | **v3** | **v2** | **v1 anchor** |
|---|---|---|---|
| Trades | **17** | 42 | 25 |
| Win rate | **52.9%** | 45.2% | 76.0% |
| Sum `pnl_pct` | **+14.72%** | +25.64% | +26.05% |
| Big winners (≥5%) | 2 | 2 | 2 |
| Index entries | **0** | 15 | 0 |

**Verdict:** Quality recovered vs v2 (fewer trades, higher WR, no index drag).
PnL is below anchor — TSLA (−3.95%), SWK (−3.21%), and doctrine exits on
MTZ/ON/SGI account for most of the gap. Index model produced **zero** July
entries (strict pullback-only rules); anchor also had zero index trades.

## Exit mix (v3)

| Exit reason | Count |
|---|---|
| `sl_breached` | 4 |
| `doctrine_force_exit` | 4 |
| `atr_week_618_full_exit` | 2 |
| `HARD_LOSS_CAP` | 2 |
| `TP_FULL` | 2 |
| `tape_capitulation_force_exit` | 1 |

Capitulation exits dropped from **13 → 1** (tape tuning working).

## Entry path mix (v3)

| Path | Count |
|---|---|
| `tt_ath_breakout` | 9 |
| `tt_pullback` | 6 |
| `tt_n_test_support` | 2 |

No index paths. Support demotion reduced support from 8 → 2 (both marginal).

## Notable trades

| Ticker | PnL% | Exit | Notes |
|---|---|---|---|
| CDNS | +7.36% | TP_FULL | Big winner preserved |
| IESC | +5.17% | sl_breached | Big winner preserved |
| TSLA | −3.95% | HARD_LOSS_CAP | New clear loser vs v2 |
| SWK | −3.21% | HARD_LOSS_CAP | Earnings cluster bypass (rank 100) |

## Next tuning (optional)

1. **Index model** — July had zero qualifying pullbacks on SPY/QQQ/IWM at rank
   95+ / rvol 1.0; if index exposure is desired, relax rvol to 0.85 on PULLBACK
   days only (keep stock-path block).
2. **Earnings cluster** — SWK rank-100 bypass kept the −3.21% loser; consider
   rank bypass 98 for cluster tickers only.
3. **TSLA pullback** — investigate Jul entry (rank 100, −3.95% HARD_LOSS_CAP).

## Reproduce

```bash
# Deploy worker + config (see scripts/push-july-v3-config.mjs)
curl -X DELETE -H "X-API-Key: $TIMED_API_KEY" \
  https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/cron-mute
scripts/monthly-slice.sh --month=2025-07 --run-id=phase-d-slice-2025-07-v3 \
  --tickers=tier1-tier2 --block-chain \
  --api-base=https://timed-trading-ingest-preprod.shashant.workers.dev
```
