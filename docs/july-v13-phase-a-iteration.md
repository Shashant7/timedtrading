# July v13 — Phase-A anchor config re-seed + block-chain diff

> Queued after v12 completes. Implements the doc-backed path from
> `docs/july-readiness-review-2026-06.md` and `docs/july-slice-v2-improvement-plan.md`.

## Problem

Tuning 21 `deep_audit_*` knobs (v6/v10/v11/v12) cannot restore the anchor because:

1. **Anchor config shape** — frozen `backtest_run_config` for `phase-c-slice-2025-07-v1`
   has **144 keys** (Phase-A `calibrated_*` package), not today's 455+ prod-sync flood.
2. **Engine drift** — deploy commit `1d7d8d3` → HEAD added `tt_ath_breakout` volume,
   index ETF overrides, capitulation exits, setup demotion keys (mostly unwired).
3. **Index regression** — v2 counterfactual: removing 15 index entries alone →
   59.3% WR, +30.23% (beats anchor P&L).

## v13 approach

| Step | Tool | Purpose |
|---|---|---|
| 1 | `scripts/seed-phase-a-anchor-config.mjs` | Push 144-key anchor snapshot + guard keys that disable post-anchor index overrides |
| 2 | `scripts/diff-engine-since-anchor.sh` | Git diff since `1d7d8d3` on entry/admission paths |
| 3 | `monthly-slice.sh --block-chain` | Run `phase-d-slice-2025-07-v13` under Phase-A config |
| 4 | `compare-block-chains.js` | v13 (strict) vs v2 `block_chain.jsonl` (loose prod-sync proxy) — surfaces bars v2 admits that Phase-A blocks |
| 5 | `calibration-diff-anchor.mjs` | Anchor frozen vs post-seed pre-prod overlap |

**Worker prerequisite (already deployed):** v12 index stock-path block
(`shouldBlockStockPathOnIndexTicker`) — ATH/support/pullback on SPY/QQQ/IWM blocked
even when index model is OFF. Does **not** blanket-block ATH on singles.

## Run commands

```bash
# After v12 finishes (automated queue):
TIMED_API_KEY=… scripts/queue-v13-after-v12.sh

# Or manual:
TIMED_API_KEY=… scripts/run-v13-phase-a-iteration.sh
```

Logs:

- `data/trade-analysis/run-v12-retry-2025-07.log`
- `data/trade-analysis/run-v13-phase-a-iteration.log`

## Acceptance (vs anchor)

| Metric | Anchor | v13 target |
|---|---:|---:|
| Trades | 25 | ≤ 28 |
| WR | 76.0% | ≥ 60% (stretch ≥ 74%) |
| Sum pnl_pct | +26.05% | ≥ +23.4% (regression budget) |
| Index entries | 0 | **0** |

## Artifacts

| Path | Content |
|---|---|
| `data/trade-analysis/phase-c-slice-2025-07-v1/frozen_config.json` | 144-key anchor snapshot (from prod D1) |
| `data/trade-analysis/phase-c-slice-2025-07-v1/engine-diff-since-anchor.md` | Commit/file diff since anchor deploy |
| `data/trade-analysis/phase-d-slice-2025-07-v13/` | v13 trades + block_chain.jsonl |
| `data/trade-analysis/phase-d-slice-2025-07-v13/block_chain_vs_v2.md` | Admission redistribution vs v2 |

## Known limits

- Pre-prod may retain `deep_audit_*` keys **not** in the anchor snapshot; guards only
  override known index-unlock keys. Full parity may require explicit pre-prod key purge.
- No Phase C anchor `block_chain.jsonl` exists — v2 chain is the documented loose proxy.
- Engine code at HEAD ≠ `1d7d8d3`; config re-seed alone cannot undo new entry paths
  without additional admission-matrix work.
