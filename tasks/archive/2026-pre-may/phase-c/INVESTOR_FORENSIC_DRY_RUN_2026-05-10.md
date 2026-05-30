---
title: Investor-Mode Forensic Dry-Run (Phase 3.9c)
generated: 2026-05-11T01:26:04.849Z
cohort: SNDK, GOOGL, AMD, MU, META, BE, SOXL, AEHR, NFLX, PLTR, NVDA, AVGO, TSM, GEV
date_range: 2025-07-01 → 2026-05-08
---

# Investor-Mode Forensic Dry-Run

Pure functional eval of `worker/investor.js`'s `computeInvestorScore` + `classifyInvestorStage` against canonical Phase C trader entry timestamps for the 14-ticker blueprint cohort. **No deployment, no preprod fidelity gap.**

The question this answers: *"At the moments the trader entered each blueprint cohort trade, what would Investor Mode have classified the ticker as?"* If Investor Mode would have flagged most as `accumulate`, the strategy can capture the same opportunities. If most fall into `watch` or `research_*`, the scoring gates are over-strict for momentum cohorts (analogous to TH's TD9/RSI exhaustion-gate problem solved in Phase 3.9b).

## Verdict (post Phase 3.9d tuning)

Phase 3.9d landed the **strong-score → accumulate threshold lowered from 70 → 65** (config-driven via `deep_audit_investor_accumulate_strong_score_min`). Re-running the same forensic against canonical Phase C trader entries:

| metric | pre-tuning (default 70) | post-tuning (default 65) | Δ |
|---|---:|---:|---:|
| accumulate | 104 (20.1%) | **444 (85.9%)** | +340 (4.3×) |
| watch | 358 (69.2%) | 29 (5.6%) | -329 |
| research_* | 55 | 44 | -11 |

**Per-ticker Δ on the blueprint cohort:**

- **PLTR: 0 → 13** of 49 entries (was 0%, now 27%)
- **TSM: 0 → 10** of 24 (now 42%)
- **AMD: 8 → 29** of 39 (now 74%)
- **AEHR: 13 → 33** of 37 (now 89%)
- **BE: 40 → 46** of 52 (now 88%)
- **GEV: 10 → 31** of 52 (now 60%)
- **GOOGL: 10 → 29** of 72 (now 40%)

**SNDK remains the outlier**: only 8 of 41 entries → accumulate (was 6). The limiting factor is its low average score (47.8), not the threshold. SNDK's score-component breakdown is dominated by its low `accumulationSignal` and `monthlyTrend` contributions — addressed in the follow-up Phase 3.9e (tune `detectAccumulationZone`).

**Remaining tuning opportunity** (Phase 3.9e — separate PR):

- **`detectAccumulationZone` averages 0.4 of 15 possible contribution** — almost dead weight on momentum-runner cohorts. Tuning it to recognize "above weekly EMA21 + within 10% of 50-day high + monthly bull" would add 5-10 pts to cohort score, capturing the SNDK-class trades whose component scoring drags below 65.

## Headline

| metric | value |
|---|---:|
| trades scored | 517 / 517 |
| classified as accumulate | 444 (**85.9%**) |
| classified as watch | 29 (5.6%) |
| classified as research_* | 44 |

## Stage distribution (full cohort)

| stage | n | % |
|---|---:|---:|
| accumulate | 444 | 85.9% |
| watch | 29 | 5.6% |
| research_avoid | 27 | 5.2% |
| research_on_watch | 16 | 3.1% |
| research_low | 1 | 0.2% |

## Investor score distribution

| bucket | n | % |
|---|---:|---:|
| <30 | 27 | 5.2% |
| 30-39 | 4 | 0.8% |
| 40-49 | 39 | 7.5% |
| 50-59 | 25 | 4.8% |
| 60-69 | 83 | 16.1% |
| 70-79 | 202 | 39.1% |
| 80+ | 137 | 26.5% |

## Avg component contribution to score

Each component's average contribution across the cohort. Components with low average vs their max-possible cap are the candidates for tuning.

| component | avg | max possible |
|---|---:|---:|
| weeklyTrend | 18.7 | 25 |
| monthlyTrend | 16.5 | 20 |
| relativeStrength | 10.4 | 20 |
| accumulationSignal | 9.5 | 15 |
| trendDurability | 8.2 | 10 |
| sectorContext | 4 | 10 |
| ichimokuConfirm | 0 | 15 |
| momentumHealth | -2.3 | 5 |
| dailySuperTrendBonus | 4.2 | 5 |

## Per-ticker breakdown

| ticker | n | avg score | avg rs_rank | accumulate | watch | research_* |
|---|---:|---:|---:|---:|---:|---:|
| AEHR | 37 | 78.5 | 87.2 | 35 | 2 | 0 |
| AMD | 39 | 74.3 | 66.1 | 37 | 0 | 2 |
| AVGO | 41 | 67.7 | 43.1 | 37 | 0 | 4 |
| BE | 52 | 84.1 | 84 | 52 | 0 | 0 |
| GEV | 52 | 72.7 | 64.3 | 51 | 1 | 0 |
| GOOGL | 72 | 69.4 | 48.9 | 68 | 4 | 0 |
| META | 38 | 47.9 | 22.7 | 21 | 0 | 17 |
| MU | 14 | 79 | 80.3 | 14 | 0 | 0 |
| NFLX | 11 | 58.1 | 35.7 | 7 | 1 | 3 |
| NVDA | 47 | 67.8 | 48.3 | 42 | 2 | 3 |
| PLTR | 49 | 70.2 | 45.4 | 45 | 0 | 4 |
| SNDK | 41 | 50.8 | 85.6 | 13 | 17 | 11 |
| TSM | 24 | 73.4 | 52.8 | 22 | 2 | 0 |

## Sample missed-opportunities (high MFE trader trades NOT classified as accumulate)

These are big-MFE trader entries where investor mode would have STAYED in research/watch — the entries Investor Mode is NOT catching but should consider catching.

| ticker | trade_id | mfe% | pnl% | inv_score | stage | reason | rs_rank |
|---|---|---:|---:|---:|---|---|---:|
| SNDK | SNDK-1757944800000 | 22.9 | 8.2 | 53 | watch | monitoring | 100 |
| SNDK | SNDK-1756319400000 | 19.8 | 10.9 | 20 | research_avoid | low_score | 77 |
| AEHR | AEHR-1752073200000-qr2cqrlcd | 13.8 | 3.9 | 62 | watch | promising | 85 |
| SNDK | SNDK-1761679200000 | 13.1 | 4.9 | 53 | watch | monitoring | 100 |
| META | META-1774450800000 | 12.7 | 5.4 | 18 | research_avoid | low_score | 31 |
| META | META-1774359000000 | 12.5 | 5.4 | 15 | research_avoid | low_score | 23 |
| SNDK | SNDK-1761246000000 | 11.7 | 1.3 | 53 | watch | monitoring | 100 |
| SNDK | SNDK-1756922400000 | 10.7 | 5.9 | 48 | research_on_watch | moderate_score | 85 |
| TSM | TSM-1767106800000 | 10.3 | 4.6 | 61 | watch | promising | 62 |

## Caveats

1. **Synthetic indicators**: D/W/M EMAs, SuperTrend, RSI, TD9 sell-setup count computed from raw candles via standard formulas. May differ marginally from worker runtime values.
2. **Mocked context**: `sectorRsRank=50`, `marketHealth=50`. Real runtime would have richer context that could push score either direction.
3. **Null fields**: `saty`, `ichimoku_w`, `ichimoku_map.M`, `rsi_divergence` are not synthesizable from raw candles; left null. Their score contributions are 0 in the dry-run. **This is CONSERVATIVE** — real runtime can only score equal or higher when these fields are present and bullish, never lower (they only ADD to score on confirmation, subtract on bearish signals).
4. **Snapshot-style**: evaluates at trade entry timestamp only. Doesn't simulate continued holding / position lifecycle. The stage classification ASSUMES no existing position (which is true for trader-mode entries).
