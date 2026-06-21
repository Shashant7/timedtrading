# Setup Mining Lift Pass — 2026-06-21

Objective pass: **backtest WIN vs LOSS vs missed Tier A** event-combo rates.

Run: `backtest_2025-07-01_2025-12-31@2026-03-14T03:11:44.033Z` (362 trades, 207W/152L)  
Missed: 211 discovery moves (74 Tier A), preprod replay trail  
Artifact: `data/setup-mining/pattern-lift/lift-2026-06-21T23-49-35.{json,md}`

## Headline findings

| Combo / signal | Win lift (W−L) | Backtest WIN rate | Miss Tier A rate | Capture gap |
|---|---:|---:|---:|---:|
| **ST flip + squeeze + EMA21** | **+5.5%** | 61.4% | 68.9% | **+7.5%** |
| EMA21 reclaim | +5.3% | 83.6% | 81.1% | −2.5% |
| Squeeze release | +2.5% | 72.9% | 70.3% | −2.6% |
| ST flip alone | **−3.3%** | 94.7% | 100% | +5.3% |
| TD9 + exhaustion confirmed | 0% | 0%* | 41.9% | +41.9% |

\*Backtest enrichment uses `trail_5m_facts` booleans; TD9 stage events derive from preprod replay trail on misses — not apples-to-apples on TD9 row yet.

## Interpretation

1. **ST flip alone is noise** — present on ~95–100% of wins, losses, and Tier A misses. Do not promote as entry trigger.

2. **Confirmation stack has modest edge** — ST flip **plus** squeeze **plus** EMA21 reclaim/reject shows the best win lift (+5.5%) and a positive capture gap on Tier A (+7.5%). This matches the MR ladder stages 5–6 intent (target + breakthrough).

3. **Individual EMA21 / squeeze** — small win lift but already present on most winning backtest entries; they differentiate wins vs losses weakly, not misses vs captures.

4. **Exhaustion / TD9 on misses** — high Tier A visibility (42%) but not measured on backtest trail path the same way. Needs unified event derivation before promotion.

5. **MR stage 5+** — essentially never fires on backtest `trail_5m` path; ladder progression remains broken for historical enrichment.

## Recommended next step

Gate simulation on preprod: require **stack_full_confirm** (or EMA21 reclaim + squeeze with ST flip) before entry on discovery Tier A anchors; measure hypothetical fill rate vs baseline backtest.
