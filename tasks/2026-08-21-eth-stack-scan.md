# ETHUSD-like TD / Phase Leaving / 233 stack

Operator question (2026-08-21): how many tracked tickers did something
similar to ETHUSD — flashed a TD 13 and a TD 9 on Monthly or Weekly or
Daily or 4H, showed Phase Leaving on Monthly / Weekly / Daily / 4H,
reclaimed the 233 on 4H or above, then at least mean-reverted or went
higher — over the candle history we actually store.

## Reconstruction

Same formulas as scoring, walked bar-by-bar (last-bar flags are useless
for history):

- TD Sequential: `computeTDSequential` — TD9 = prep 9 (`close < close[4]`),
  TD13 = lead-up 13 (`close < low[2]` after a TD9). Pair = 9 after 13
  within 12 bars on the same TF.
- Phase Leaving: Saty osc `((close − EMA21) / (3 × ATR14)) × 100`, EMA-3.
  Oversold leave = `extDn` (−100) or `accum` (−61.8).
- 233 reclaim: close crosses from below EMA 233 to above, on 4H / D / W.
  Monthly 233 is almost never computable (ETHUSD has ~104 monthly bars).

Script: `scripts/scan-eth-td-phase-233.mjs`

## Tiers

| Tier | TD | Phase Leaving | 233 |
|---|---|---|---|
| strict | 13→9 on any of M/W/D/4H | all four TFs | 4H+ |
| eth-like | 13→9 on Monthly or Weekly | ≥3 of four TFs | 4H+ |
| strong | 13→9 on any | ≥2 of four TFs | 4H+ |
| loose | 13→9 on any | ≥1 TF | 4H+ |

Outcome (daily closes after the last piece of the stack): went ≥1%
higher within 60d, or last 20d close > signal, or mean-reverted back
through / halfway to the 21 EMA within 20d.

## Status

Scan in progress. Results land in `data/eth-stack-scan/report.md`.
