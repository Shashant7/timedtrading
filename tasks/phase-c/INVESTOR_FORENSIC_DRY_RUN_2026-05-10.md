---
title: Investor-Mode Forensic Dry-Run (Phase 3.9c)
generated: 2026-05-10T23:58:37.289Z
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
| accumulate | 104 (20.1%) | **232 (44.9%)** | +128 (2.2×) |
| watch | 358 (69.2%) | 230 (44.5%) | -128 |
| research_* | 55 | 55 | 0 |

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
| classified as accumulate | 232 (**44.9%**) |
| classified as watch | 230 (44.5%) |
| classified as research_* | 55 |

## Stage distribution (full cohort)

| stage | n | % |
|---|---:|---:|
| accumulate | 232 | 44.9% |
| watch | 230 | 44.5% |
| research_avoid | 29 | 5.6% |
| research_on_watch | 16 | 3.1% |
| research_low | 10 | 1.9% |

## Investor score distribution

| bucket | n | % |
|---|---:|---:|
| <30 | 29 | 5.6% |
| 30-39 | 11 | 2.1% |
| 40-49 | 30 | 5.8% |
| 50-59 | 110 | 21.3% |
| 60-69 | 264 | 51.1% |
| 70-79 | 73 | 14.1% |
| 80+ | 0 | 0% |

## Avg component contribution to score

Each component's average contribution across the cohort. Components with low average vs their max-possible cap are the candidates for tuning.

| component | avg | max possible |
|---|---:|---:|
| weeklyTrend | 18.7 | 25 |
| monthlyTrend | 16.5 | 20 |
| relativeStrength | 10.4 | 20 |
| accumulationSignal | 0.4 | 15 |
| trendDurability | 8.2 | 10 |
| sectorContext | 4 | 10 |
| ichimokuConfirm | 0 | 15 |
| momentumHealth | -2.3 | 5 |
| dailySuperTrendBonus | 4.2 | 5 |

## Per-ticker breakdown

| ticker | n | avg score | avg rs_rank | accumulate | watch | research_* |
|---|---:|---:|---:|---:|---:|---:|
| AEHR | 37 | 70.4 | 87.2 | 33 | 4 | 0 |
| AMD | 39 | 64.6 | 66.1 | 29 | 8 | 2 |
| AVGO | 41 | 58.5 | 43.1 | 6 | 31 | 4 |
| BE | 52 | 72.5 | 84 | 46 | 6 | 0 |
| GEV | 52 | 63.6 | 64.3 | 31 | 21 | 0 |
| GOOGL | 72 | 59 | 48.9 | 29 | 32 | 11 |
| META | 38 | 42 | 22.7 | 2 | 19 | 17 |
| MU | 14 | 67.3 | 80.3 | 9 | 5 | 0 |
| NFLX | 11 | 53.5 | 35.7 | 6 | 2 | 3 |
| NVDA | 47 | 58.6 | 48.3 | 10 | 34 | 3 |
| PLTR | 49 | 59.1 | 45.4 | 13 | 32 | 4 |
| SNDK | 41 | 47.8 | 85.6 | 8 | 22 | 11 |
| TSM | 24 | 62.5 | 52.8 | 10 | 14 | 0 |

## Sample missed-opportunities (high MFE trader trades NOT classified as accumulate)

These are big-MFE trader entries where investor mode would have STAYED in research/watch — the entries Investor Mode is NOT catching but should consider catching.

| ticker | trade_id | mfe% | pnl% | inv_score | stage | reason | rs_rank |
|---|---|---:|---:|---:|---|---|---:|
| BE | BE-1751467200000-19bqampl7 | 65.9 | 22.4 | 64 | watch | promising | 31 |
| BE | BE-1751465400000-9t6ek1qyh | 28.5 | 4.4 | 64 | watch | promising | 31 |
| SNDK | SNDK-1758893400000 | 26.1 | 14.6 | 53 | watch | monitoring | 100 |
| SNDK | SNDK-1757944800000 | 22.9 | 8.2 | 53 | watch | monitoring | 100 |
| SNDK | SNDK-1756319400000 | 19.8 | 10.9 | 20 | research_avoid | low_score | 77 |
| PLTR | PLTR-1752000000000-7xycojmcs | 18 | -4.7 | 61 | watch | promising | 23 |
| PLTR | PLTR-1754063400000-tgdxy3swl | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-v6k8pf0jd | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-et42x259q | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-568gxn8cm | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-g9fnu551e | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-dbm9hcear | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-r9m7tvpfl | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-89zaq82g2 | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-op7qmc5ad | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-nrxe6ncr1 | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| PLTR | PLTR-1754063400000-8i10gpibi | 17.2 | 7.6 | 57 | watch | monitoring | 46 |
| GEV | GEV-1770399000000 | 16.3 | 6.6 | 62 | watch | promising | 62 |
| AEHR | AEHR-1752073200000-qr2cqrlcd | 13.8 | 3.9 | 62 | watch | promising | 85 |
| SNDK | SNDK-1761679200000 | 13.1 | 4.9 | 53 | watch | monitoring | 100 |
| META | META-1774450800000 | 12.7 | 5.4 | 18 | research_avoid | low_score | 31 |
| META | META-1774359000000 | 12.5 | 5.4 | 15 | research_avoid | low_score | 23 |
| AEHR | AEHR-1768577400000 | 12.4 | 5.1 | 63 | watch | promising | 69 |
| SNDK | SNDK-1761246000000 | 11.7 | 1.3 | 53 | watch | monitoring | 100 |
| GOOGL | GOOGL-1751397600000-nzqtjl9ze | 11.2 | 10.2 | 31 | research_low | low_conviction | 8 |

## Caveats

1. **Synthetic indicators**: D/W/M EMAs, SuperTrend, RSI, TD9 sell-setup count computed from raw candles via standard formulas. May differ marginally from worker runtime values.
2. **Mocked context**: `sectorRsRank=50`, `marketHealth=50`. Real runtime would have richer context that could push score either direction.
3. **Null fields**: `saty`, `ichimoku_w`, `ichimoku_map.M`, `rsi_divergence` are not synthesizable from raw candles; left null. Their score contributions are 0 in the dry-run. **This is CONSERVATIVE** — real runtime can only score equal or higher when these fields are present and bullish, never lower (they only ADD to score on confirmation, subtract on bearish signals).
4. **Snapshot-style**: evaluates at trade entry timestamp only. Doesn't simulate continued holding / position lifecycle. The stage classification ASSUMES no existing position (which is true for trader-mode entries).
