# Phase D slice — 2025-07 (run_id `phase-d-slice-2025-07-v2`)

> Re-run on **preprod** with **current production `model_config`** (493 keys
> synced 2026-06-27). Compare to anchor `phase-c-slice-2025-07-v1`.

## Run envelope

| Field | Value |
|---|---|
| `run_id` | `phase-d-slice-2025-07-v2` |
| Environment | `timed-trading-ingest-preprod` |
| Window | 2025-07-01 → 2025-07-31 (22 sessions) |
| Universe | 24 tickers (tier1-tier2) |
| Wall-clock | ~58 min (with 1102 retries on 6 days) |
| Config | Production sync: ATH confirm, range-reversal gate, SL 0.45, short rank 80, etc. |

## Headline comparison vs Phase C anchor

| Metric | **v2 (current config)** | **v1 anchor** | Δ |
|---|---|---|---|
| Trades | **42** | 25 | +17 (+68%) |
| Win rate | **45.2%** | 76.0% | −30.8 pp |
| Sum `pnl_pct` | **+25.64%** | +26.05% | −0.41 pp |
| Big winners (≥5%) | 2 | 2 | — |
| Clear losers (≤−1.5%) | 2 | 3 | −1 |
| SPY+QQQ+IWM entries | **15** | 0 | +15 |

**Verdict:** Current config is **much noisier** (68% more trades, WR cut in half)
but **nearly identical total return** on equal-weight sum pnl_pct. The model
traded indices that the anchor skipped and leaned heavily on ATH breakout.

## Exit reason mix (v2)

| Exit reason | Count |
|---|---|
| `sl_breached` | 13 |
| `tape_capitulation_force_exit` | 13 |
| `SOFT_FUSE_RSI_CONFIRMED` | 4 |
| `mfe_ratchet_giveback` | 4 |
| `doctrine_force_exit` | 3 |
| `atr_week_618_full_exit` | 2 |
| `TP_FULL` | 1 |
| `HARD_LOSS_CAP` | 1 |
| `thesis_flip_htf` | 1 |

Anchor primary exits were `mfe_proportional_trail` (6) and `TP_FULL` (3).
v2 shows more **SL + capitulation force** exits — consistent with tighter SL
(0.45 ATR) and unchanged bleeder shield OFF.

## Entry path mix (v2)

| Path | Count |
|---|---|
| `tt_ath_breakout` | 17 |
| `tt_pullback` | 13 |
| `tt_n_test_support` | 8 |
| `tt_range_reversal_long` | 4 |

ATH breakout is the largest bucket despite confirm gate + demotion key —
admission matrix still allows STRONG_BULL/EARLY_BULL ATH entries.

## Index ETF activity (new vs anchor)

| Ticker | v2 trades |
|---|---|
| IWM | 7 |
| SPY | 5 |
| QQQ | 3 |

Anchor had **zero** index entries (pullback depth + rank floor). Current
config + synced keys produced meaningful index participation — a major
logic-path deviation.

## Implications for July readiness

1. **Return parity, quality drop** — not safe to assume WR holds; monitor live
   July with lower WR expectation but similar PnL% ceiling if breadth stays high.
2. **ATH path volume up** — confirm gate did not suppress ATH count vs anchor;
   demotion keys not wired to admission matrix.
3. **Index entries unlocked** — verify whether index ETF override keys are ON
   in synced config (`deep_audit_pullback_*_index_etf*`).
4. **Force-exit churn** — 13 `tape_capitulation_force_exit` warrants block-chain
   review vs anchor.

## Artifacts

- `trades.json`, `trades.csv`, `block_chain.jsonl` in this directory
- Log: `/tmp/july-slice-preprod.log`

## Reproduce

```bash
node scripts/sync-model-config-to-preprod.mjs
curl -X DELETE -H "X-API-Key: $TIMED_API_KEY" \
  https://timed-trading-ingest-preprod.shashant.workers.dev/timed/admin/cron-mute
export TIMED_API_KEY=...
scripts/monthly-slice.sh --month=2025-07 \
  --run-id=phase-d-slice-2025-07-v2 \
  --tickers=tier1-tier2 --block-chain \
  --api-base=https://timed-trading-ingest-preprod.shashant.workers.dev
```
