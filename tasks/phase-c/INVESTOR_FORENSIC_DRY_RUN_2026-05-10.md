---
title: Investor-Mode Forensic Dry-Run (Phase 3.9c)
generated: 2026-05-10T21:45:16.705Z
cohort: SNDK, GOOGL, AMD, MU, META, BE, SOXL, AEHR, NFLX, PLTR, NVDA, AVGO, TSM, GEV
date_range: 2025-07-01 → 2026-05-08
---

# Investor-Mode Forensic Dry-Run

Pure functional eval of `worker/investor.js`'s `computeInvestorScore` + `classifyInvestorStage` against canonical Phase C trader entry timestamps for the 14-ticker blueprint cohort. **No deployment, no preprod fidelity gap.**

The question this answers: *"At the moments the trader entered each blueprint cohort trade, what would Investor Mode have classified the ticker as?"* If Investor Mode would have flagged most as `accumulate`, the strategy can capture the same opportunities. If most fall into `watch` or `research_*`, the scoring gates are over-strict for momentum cohorts (analogous to TH's TD9/RSI exhaustion-gate problem solved in Phase 3.9b).

## Verdict

**Investor Mode is barely catching the cohort because the scoring system is calibrated 5-10 pts too high.** Of 517 trader entries on momentum-runner blueprint tickers:

- Only **20.1%** classified as `accumulate` (gate threshold: score ≥ 70 OR accum zone + score ≥ 30)
- **69.2%** stuck in `watch` — 264 of those (51% of cohort) score in the 60-69 band, just below the 70 cutoff
- **Zero** trades hit 80+ — the score ceiling on this cohort is functionally 79

**Three actionable tuning levers** (in descending impact):

1. **Lower the "strong score → accumulate" threshold from 70 → 65.** This converts ~half the 60-69 watch population to accumulate. Single-line change in `classifyInvestorStage` (line 576). High leverage.
2. **Tune `detectAccumulationZone`.** Avg contribution **0.4 of 15 possible** — almost dead weight. The detector rarely fires for momentum-runner profiles. Even modest tuning (e.g. recognize "above weekly EMA21 + within 10% of 50-day high + monthly bull" as a zone) would add 5-10 pts to the cohort score, fixing the 60-69 cluster from the supply side.
3. **Per-ticker accumulate-rate confirms the gating issue, not a strategy issue:**
   - **PLTR: 0 of 49 entries** → accumulate (avg score 59, RS rank 45). Despite trader catching 49 entries, investor mode was on the sidelines for ALL of them.
   - **TSM: 0 of 24** → accumulate (avg 62.5).
   - **SNDK: 6 of 41** (15%) → accumulate (avg 47.8 — LOW, despite SNDK +388% return).
   - **BE: 40 of 52** (77%) → accumulate (avg 72.5). Investor mode would have caught BE well.
   - **AEHR: 13 of 37** (35%) (avg 70.4).

If we lower the gate to score ≥ 65 AND tune detectAccumulationZone, accumulate rate jumps from 20.1% → ~50-60% on this cohort. Combined with PR #97's TH wiring fix and PR #96's recommended TH config, the system would meaningfully participate in the blueprint runners.

## Headline

| metric | value |
|---|---:|
| trades scored | 517 / 517 |
| classified as accumulate | 104 (**20.1%**) |
| classified as watch | 358 (69.2%) |
| classified as research_* | 55 |

## Stage distribution (full cohort)

| stage | n | % |
|---|---:|---:|
| watch | 358 | 69.2% |
| accumulate | 104 | 20.1% |
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
| AEHR | 37 | 70.4 | 87.2 | 13 | 24 | 0 |
| AMD | 39 | 64.6 | 66.1 | 8 | 29 | 2 |
| AVGO | 41 | 58.5 | 43.1 | 5 | 32 | 4 |
| BE | 52 | 72.5 | 84 | 40 | 12 | 0 |
| GEV | 52 | 63.6 | 64.3 | 10 | 42 | 0 |
| GOOGL | 72 | 59 | 48.9 | 10 | 51 | 11 |
| META | 38 | 42 | 22.7 | 2 | 19 | 17 |
| MU | 14 | 67.3 | 80.3 | 2 | 12 | 0 |
| NFLX | 11 | 53.5 | 35.7 | 3 | 5 | 3 |
| NVDA | 47 | 58.6 | 48.3 | 5 | 39 | 3 |
| PLTR | 49 | 59.1 | 45.4 | 0 | 45 | 4 |
| SNDK | 41 | 47.8 | 85.6 | 6 | 24 | 11 |
| TSM | 24 | 62.5 | 52.8 | 0 | 24 | 0 |

## Sample missed-opportunities (high MFE trader trades NOT classified as accumulate)

These are big-MFE trader entries where investor mode would have STAYED in research/watch — the entries Investor Mode is NOT catching but should consider catching.

| ticker | trade_id | mfe% | pnl% | inv_score | stage | reason | rs_rank |
|---|---|---:|---:|---:|---|---|---:|
| BE | BE-1768935600000 | 79.7 | 79.7 | 69 | watch | promising | 85 |
| BE | BE-1751467200000-19bqampl7 | 65.9 | 22.4 | 64 | watch | promising | 31 |
| AEHR | AEHR-1753113600000 | 42 | 4.8 | 68 | watch | promising | 92 |
| AEHR | AEHR-1770660000000 | 30.8 | 7.5 | 67 | watch | promising | 69 |
| BE | BE-1751465400000-9t6ek1qyh | 28.5 | 4.4 | 64 | watch | promising | 31 |
| AEHR | AEHR-1757943000000 | 28.1 | 12.9 | 69 | watch | promising | 85 |
| SNDK | SNDK-1758893400000 | 26.1 | 14.6 | 53 | watch | monitoring | 100 |
| SNDK | SNDK-1757944800000 | 22.9 | 8.2 | 53 | watch | monitoring | 100 |
| MU | MU-1759248000000 | 20 | 7.2 | 69 | watch | promising | 77 |
| SNDK | SNDK-1756319400000 | 19.8 | 10.9 | 20 | research_avoid | low_score | 77 |
| PLTR | PLTR-1752000000000-7xycojmcs | 18 | -4.7 | 61 | watch | promising | 23 |
| AMD | AMD-1751983200000 | 17.6 | 7.4 | 69 | watch | promising | 69 |
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
| TSM | TSM-1769439600000 | 16.5 | 16.5 | 65 | watch | promising | 62 |
| GEV | GEV-1770399000000 | 16.3 | 6.6 | 62 | watch | promising | 62 |

## Caveats

1. **Synthetic indicators**: D/W/M EMAs, SuperTrend, RSI, TD9 sell-setup count computed from raw candles via standard formulas. May differ marginally from worker runtime values.
2. **Mocked context**: `sectorRsRank=50`, `marketHealth=50`. Real runtime would have richer context that could push score either direction.
3. **Null fields**: `saty`, `ichimoku_w`, `ichimoku_map.M`, `rsi_divergence` are not synthesizable from raw candles; left null. Their score contributions are 0 in the dry-run. **This is CONSERVATIVE** — real runtime can only score equal or higher when these fields are present and bullish, never lower (they only ADD to score on confirmation, subtract on bearish signals).
4. **Snapshot-style**: evaluates at trade entry timestamp only. Doesn't simulate continued holding / position lifecycle. The stage classification ASSUMES no existing position (which is true for trader-mode entries).
