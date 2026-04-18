# Phase D cross-month synthesis — 2026-04-18

This directory contains the first 10-month (Jul 2025 – Apr 2026)
cross-month synthesis of v2 monthly slices.

- `synthesis.md` — operator-readable summary with per-month table, cohort ×
  cycle breakdown, exit-reason rollup, events audit, and SPY/QQQ/IWM
  block-chain deep dive.
- `synthesis.json` — machine-readable snapshot of the same data.
- `tuning-proposals.md` — six evidence-backed proposals (P1 – P6) for Phase E.

## How to reproduce

```bash
# Prereqs: all 10 v2 slices in data/trade-analysis/phase-d-slice-<month>-v2/
#          and refreshed backdrops in data/backdrops/<month>.json
cd /workspace
python3 scripts/phase-d-cross-month-analysis.py
```

The analyzer pulls `trades.json`, `block_chain.jsonl`, and the corresponding
monthly backdrop for each month, and regenerates every file in this
directory.

## Scope

- Universe: **24-ticker tier1-tier2** (Mag 7 + SPY/QQQ/IWM + 14 tier-2).
- Orchestrator: `scripts/monthly-slice.sh` with cleanSlate fix (PR #9).
- Worker: full 215-ticker hydration complete; stale-bundle + entry-price-divergent guards active; T6A enabled for SPY/QQQ/IWM.
- Training months (Jul 2025 – Feb 2026) — used for evidence.
- Holdout months (2026-03, 2026-04) — reported only; reserved for proposal
  validation.

## Headline numbers (training months)

| Metric | Value |
|---|---|
| Trades | 158 |
| Wins / Losses | 90 / 66 |
| Win rate | 57.7 % |
| Big winners (≥ 5 %) | 12 |
| Clear losers (≤ −1.5 %) | 29 |
| Sum pnl_pct | +150.93 % |
| SPY / QQQ / IWM trades | 0 |

## Key findings

1. Event honoring is working correctly — `PRE_EVENT_RECOVERY_EXIT` and
   `PRE_EARNINGS_FORCE_EXIT` both fire against real scheduled events.
2. The biggest PnL leak is the `max_loss` cohort (−59 % on 25 trades,
   concentrated in transitional-cycle months).
3. Runners held past month-end (`replay_end_close`) contribute +99 % of
   the sum-pnl through only 11 trades.
4. T6A targeted the wrong ETF gate; `tt_no_trigger` + `HTF_BULL_LTF_PULLBACK`
   is the real blocker, needing a different relaxation strategy (P4 / T6B).
