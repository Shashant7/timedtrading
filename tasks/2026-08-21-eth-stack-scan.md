# ETHUSD-like TD / Phase Leaving / 233 stack

Operator question (2026-08-21): how many tracked tickers did something
similar to ETHUSD — flashed a TD 13 and a TD 9 on Monthly or Weekly or
Daily or 4H, showed Phase Leaving on Monthly / Weekly / Daily / 4H,
reclaimed the 233 on 4H or above, then at least mean-reverted or went
higher — over the candle history we actually store.

**Answer:** official four-TF Phase Leaving never stacked (0 of 316).
The ETH July movie itself (HTF TD13→9 + washout turn-up on all four TFs
+ 233 on 4H+) printed on **two names: ETHUSD and SRAD**. Ten names
printed the four-TF washout + any-TF TD13→9 + 233; 8/11 of those
setups closed higher 20 days later.

Full tables: `data/eth-stack-scan/report.md`.
Script: `scripts/scan-eth-td-phase-233.mjs`.

## Reconstruction

Same formulas as scoring, walked bar-by-bar:

- TD Sequential: TD9 = prep 9 (`close < close[4]`), TD13 = lead-up 13
  (`close < low[2]` after a TD9). Pair = 9 after 13 within 12 bars.
- Phase: Saty osc `((close − EMA21) / (3 × ATR14)) × 100`, EMA-3.
  Official leave = `extDn` (−100) or `accum` (−61.8).
- 233 reclaim: close crosses from below EMA 233 on 4H / D / W.
  Monthly 233 is not computable (ETHUSD has 104 monthly bars).

## Why ETH itself is not “official strict”

ETH monthly Saty osc only reached **−33** at the June 2026 low (monthly
ATR ~$800). Weekly reached **−58.4** and missed −61.8. Official Phase
Leaving therefore never printed on ETH monthly, and no name in the 316
hit official leave on M+W+D+4H in the same window.

The ETH movie uses a TF-scaled washout turn-up (M −20, W −40, D/4H −50)
plus a lift, with the trough at or before the TD9.

## ETHUSD July template (confirmed in store)

- Monthly TD13 2026-05-01, TD9 2026-07-01
- 4H 233 reclaim 2026-07-04
- Phase turn-up on M+W+D+4H (official leave only on 4H+D)
- Then **+4.5% / 20d**, **+34.9% / 60d**

## Counts (316 tickers, stored D/W/M/4H)

| Cut | Names | Setups | Closed +20d | Closed +60d | Avg +20d | Avg +60d |
|---|---:|---:|---:|---:|---:|---:|
| Official Phase Leaving on all 4 TFs | 0 | 0 | — | — | — | — |
| HTF TD13→9 + 4-TF turn + 233 (ETHUSD, SRAD) | 2 | 2 | 2 | 1 | +4.2% | +9.4% |
| 4-TF turn + any-TF TD13→9 + 233 | 10 | 11 | 8 | 9 | +4.3% | +32.6% |
| HTF TD13→9 + ≥3-TF turn + 233 (adds VX1!, COIN) | 11 | 13 | 10 | 10 | +3.1% | +26.3% |
| Official leave on ≥2 TFs + 233 | 90 | 105 | — | — | +4.8% | — |

Monthly TD13→9 exists on only 8 names: ETHUSD, NKE, OKTA, SWK, UNG,
VIXY, VX1!, WULF. Weekly TD13→9 on 47 names. Most of those never also
got the phase stack and a 233 reclaim in the same window.

## Closest HTF movies

| Ticker | Date | TD | Then |
|---|---|---|---|
| ETHUSD | 2026-07-04 | Monthly 13→9 | +4.5% / +34.9% |
| SRAD | 2026-06-08 | Weekly 13→9 | +3.9% / −16.1% |
| VX1! | 2026-01-20 | Weekly 13→9 (3-TF turn, no 4H) | +7.9% / +6.6% |
| COIN | 2026-03-04 | Weekly 13→9 (no monthly turn) | −17.2% / −12.8% |

## Caveats

- 4H history is short (~Aug 2024; ETHUSD 4H from Aug 2025).
- “Went higher or mean-reverted” is an easy bar in a rising tape. Use
  the closed-higher +20d / +60d columns.
- COIN counted as “went higher” on a +0.6% 20d MFE while closing −17%.
- Crypto, vol ETFs (VX1!, UNG), and equity are mixed in the averages.
