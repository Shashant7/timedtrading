# July v15 — Anchor recovery (trader backtest)

> **Status:** v15 run in progress. This doc is the north star after v8–v14 drift.

## Problem (why we fell off)

1. **Wrong iteration axis** — loosened gates (v8–v11) → 40–50 trades, WR ~40%.
2. **v14 regression** — re-enabled `index_model_enabled=true` → 15 index trades, 20% WR, −7.9% from index path alone.
3. **Config tuning ≠ anchor** — anchor is Phase-A engine (`1d7d8d3`) + 144-key package; v13 re-seed still yielded ~48% WR.
4. **Anchor edge = selectivity** — 25 trades, rank≥90 → 84% WR, **0 index entries**, MFE-trail exits.

## v15 lane (do this, stop the rest)

| Knob | v15 value | Why |
|---|---|---|
| `deep_audit_index_model_enabled` | **false** | Match anchor (0 index). v14's `true` was the mistake. |
| `deep_audit_pullback_non_prime_min_rank` | **90** | Anchor rank≥90 → 84% WR |
| `deep_audit_focus_min_entry_conviction` | **70** | v10/v11 74 was a dud |
| `deep_audit_earnings_cluster_*` | on, minTickers=3 | Block TSLA/SWK cluster damage (v6 gap) |
| Range reversal | **globally blocked** | July: 5% WR, −7.9% aggregate |
| Worker | `shouldBlockStockPathOnIndexTicker` | Already deployed (v12) |

**Do not:** `rank_bypass=0`, conviction floor experiments, re-enable index model, broad Phase-A re-seed without engine parity work.

## Run

```bash
TIMED_API_KEY=… scripts/run-v15-july.sh
# tmux: v15-july
```

Artifacts: `data/trade-analysis/phase-d-slice-2025-07-v15/`

## Acceptance (vs anchor `phase-c-slice-2025-07-v1`)

| Metric | Anchor | v15 stretch |
|---|---:|---:|
| Trades | 25 | **≤ 30** |
| WR | 76% | **≥ 60%** (stretch ≥ 65%) |
| Sum pnl_pct | +26.05% | **≥ +18%** (v6 floor) |
| Index entries | 0 | **0** |
| Range reversal entries | 0 | **0** |

Beating anchor fully requires **engine/admission parity** (replay on `1d7d8d3` or block-chain backlog) — v15 is the correct **config** lane until then.

## Next after v15

1. If v15 ≥ v6 → hold config; run August slice same lane.
2. If WR still ~48% with v15 config → **engine parity** (`seed-phase-a-anchor-config` + admission matrix diff vs v2 block chain).
3. **Investor lane** — separate; finish post890 isolated rerun (fix seed `errors=1` exit).

## References

- Anchor report: `data/trade-analysis/phase-c-slice-2025-07-v1/report.md`
- v13 limits: `docs/july-v13-phase-a-iteration.md`
- Readiness review: `docs/july-readiness-review-2026-06.md`
