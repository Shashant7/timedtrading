# ETHUSD-like TD / Phase Leaving / 233 stack

Scanned **316** tickers over stored D / W / M / 4H candles.

## What was required

Same reconstruction as scoring (`computeTDSequential`, Saty phase osc, EMA 233):

- **TD 13 then 9** (bullish Sequential) on Monthly, Weekly, Daily, or 4H — prep-9 after lead-up-13, within 12 bars on that TF.
- **Phase Leaving** on the oversold side (`extDn` leave −100, and/or `accum` leave −61.8).
- **233 reclaim** on 4H or above (4H / D / W; monthly 233 is almost never computable — ETHUSD has ~104 monthly bars).
- **Outcome** from the daily close at signal: went ≥1% higher within 60d, or last 20d close > signal, **or** mean-reverted back through / halfway to the 21 EMA within 20d.

Tiers (so the four-TF Phase Leaving ask is not flattened):

| Tier | TD | Phase Leaving | 233 |
|---|---|---|---|
| **strict** | 13→9 on any of M/W/D/4H | official leave on all four TFs | 4H+ |
| **movie-strict** | 13→9 on any | washout turn-up on all four TFs | 4H+ |
| **eth-like** | 13→9 on Monthly or Weekly | official leave on ≥3 of four TFs | 4H+ |
| **movie-eth** | 13→9 on Monthly or Weekly | washout turn-up on ≥3 of four TFs | 4H+ |
| **strong** | 13→9 on any | official leave on ≥2 of four TFs | 4H+ |
| **loose** | 13→9 on any | official leave on ≥1 TF | 4H+ |

Official Phase Leaving is `extDn` (−100) / `accum` (−61.8). ETHUSD monthly never reached −61.8 (June 2026 trough −33), so the ETH movie uses a TF-scaled washout turn-up (M −20, W −40, D/4H −50) plus a lift.

## Headline

- **Strict (official Phase Leaving on M+W+D+4H):** 0 names / 0 setups. Of 0 with ≥10d follow-through, **0 (null%)** mean-reverted or went higher. Avg +20d null%, MFE null%.
- **Movie-strict (washout turn-up on all four TFs — ETH July template):** 10 names / 11 setups. Easy bar (higher or mean-revert): **11/11 (100%)**. Closed higher +20d: **8/11**. Closed higher +60d: **9/11**. Avg +20d 4.34%, MFE 14.52%, +60d 32.56%.
- **ETH-like (HTF TD13→9 + official leave on ≥3 TFs):** 0 names / 0 setups. 0 scored → **0 (null%)**.
- **Movie-ETH (HTF TD13→9 + turn-up on ≥3 TFs):** 2 names / 2 setups. 2 scored → **2 (100%)**.
- **Strong (≥2 TF official leave + 233):** 90 names / 105 setups. 100 scored → **96 (96%)**.
- **Any stack (loose+):** 171 unique names, 258 clusters.

## ETHUSD sanity

Coverage: M 104 bars 2018-01-01→2026-08-01; W 317 bars 2020-07-27→2026-08-17; D 1694 bars 2022-01-01→2026-08-21; 240 2192 bars 2025-08-21→2026-08-21.

| Date | Tier | Anchor TF | TD TFs | Official leave | Turn-up | 233 TFs | +20d | +60d | Success |
|---|---|---|---|---|---|---|---:|---:|---|
| 2025-11-24 | strong | 240 | 240 | 240,D | 240,D | 240,D | 3.7% | 0.1% | yes |
| 2026-03-09 | strong | 240 | 240 | 240,W,D | 240,W,D | D | -0.5% | 15.7% | yes |
| 2026-03-15 | strong | 240 | 240 | W,D | 240,W,D | 240 | -5.2% | 4.8% | yes |
| 2026-06-08 | movie-strict | 240 | 240 | 240,W,D | 240,M,W,D | 240 | -7.0% | 13.2% | yes |
| 2026-07-04 | movie-strict | M | M | 240,D | 240,M,W,D | 240 | 4.5% | 34.9% | yes |

## Closest to the ETH movie (HTF TD13→9 + multi-TF phase + 233)

| Ticker | Date | Tier | TD TF | TD13 → TD9 | Official leave | Turn-up | 233 | +20d | +60d |
|---|---|---|---|---|---|---|---|---:|---:|
| VX1! | 2026-01-20 | movie-eth | 240,W | 2025-12-28 → 2026-01-18 | W,D | M,W,D | 240 | 7.9% | 6.6% |
| COIN | 2026-03-04 | movie-eth | 240,W,D | 2026-02-09 → 2026-02-16 | 240,D | 240,W,D | 240 | -17.2% | -12.8% |
| SRAD | 2026-06-08 | movie-strict | W | 2026-04-20 → 2026-05-18 | 240,W,D | 240,M,W,D | W | 3.9% | -16.1% |
| ETHUSD | 2026-07-04 | movie-strict | M | 2026-05-01 → 2026-07-01 | 240,D | 240,M,W,D | 240 | 4.5% | 34.9% |

## All movie-strict / movie-ETH setups

| Ticker | Date | Tier | Anchor | TD | Official leave | Turn-up | 233 | +20d | MFE20 | +60d |
|---|---|---|---|---|---|---|---|---:|---:|---:|
| LULU | 2025-10-21 | movie-strict | 240 | 240 | D | 240,M,W,D | 240 | -6.5% | 0.0% | 16.1% |
| VX1! | 2026-01-11 | movie-strict | 240 | 240 | 240,W,D | 240,M,W,D | D | 4.0% | 15.6% | 16.8% |
| UNG | 2026-01-20 | movie-strict | 240 | 240 | 240,D | 240,M,W,D | D | -4.0% | 36.6% | -12.9% |
| VX1! | 2026-01-20 | movie-eth | W | 240,W | W,D | M,W,D | 240 | 7.9% | 12.7% | 6.6% |
| DKNG | 2026-02-19 | movie-strict | 240 | 240 | 240,D | 240,M,W,D | 240 | 12.4% | 15.0% | 11.3% |
| COIN | 2026-03-04 | movie-eth | W | 240,W,D | 240,D | 240,W,D | 240 | -17.2% | 0.6% | -12.8% |
| QLYS | 2026-04-13 | movie-strict | D | D | 240,W,D | 240,M,W,D | 240 | 15.8% | 16.7% | 93.6% |
| ETHUSD | 2026-06-08 | movie-strict | 240 | 240 | 240,W,D | 240,M,W,D | 240 | -7.0% | 6.2% | 13.2% |
| SRAD | 2026-06-08 | movie-strict | W | W | 240,W,D | 240,M,W,D | W | 3.9% | 11.1% | -16.1% |
| ELF | 2026-06-16 | movie-strict | 240 | 240 | 240,D | 240,M,W,D | 240 | 10.9% | 17.7% | 51.0% |
| CRM | 2026-06-26 | movie-strict | 240 | 240 | 240,D | 240,M,W,D | 240 | 3.3% | 9.7% | 32.3% |
| TEAM | 2026-06-26 | movie-strict | 240 | 240 | 240,M,W | 240,M,W,D | 240 | 10.3% | 22.5% | 117.8% |
| ETHUSD | 2026-07-04 | movie-strict | M | M | 240,D | 240,M,W,D | 240 | 4.5% | 8.6% | 34.9% |

## Names — official strict

_none_

## Names — movie-strict (ETH July template, includes official strict)

CRM, DKNG, ELF, ETHUSD, LULU, QLYS, SRAD, TEAM, UNG, VX1!

## Names — movie-ETH (HTF TD + turn-up on ≥3 TFs)

COIN, CRM, DKNG, ELF, ETHUSD, LULU, QLYS, SRAD, TEAM, UNG, VX1!

## Caveats

- 4H history starts ~Aug 2024 for most names (ETHUSD 4H from Aug 2025). Monthly 233 is not in the data.
- Daily store starts 2022 for most equity names; weekly ~2019; monthly much longer.
- Phase Leaving on all four TFs in the same window is rare — that is why tiers exist.
- Forward returns use daily closes after the last piece of the stack (TD9 / phase / 233). Crypto vs equity vol is mixed in the averages.
