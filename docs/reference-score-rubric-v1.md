# Reference Score Rubric v1

## Objective
Rank individual trades by hybrid quality so reference selection is robust across ticker/regime diversity, not only raw PnL.

## Scoring Components (0-1 each)
- `outcome_quality` (weight: 0.35)
  - Positive `pnl_pct` and non-forced closure score highest.
- `journey_quality` (weight: 0.30)
  - Favor healthy `hold_days` plus strong MFE/controlled MAE when available.
- `lineage_quality` (weight: 0.20)
  - Reward complete lineage (`entry_path`, snapshots, tf stack, exit reason).
- `annotation_confidence` (weight: 0.15)
  - Boost classified `Good Trade` / `Valid Win`, penalize clear bad-trade labels.

## Forced-Closure Penalty
Apply penalty when `exit_reason` is operationally forced or non-analytical:
- `replay_end_close`
- `time_exit_loser_transitional`
- pure `unknown` closure without context

## Selection Constraints
- Enforce minimum spread across:
  - sectors
  - months/regime windows
  - long/short direction
- Cap same-ticker duplicates in top reference slice.

## Output
Each selected reference trade includes:
- hybrid score breakdown
- journey summary
- context tags
- selection rationale
