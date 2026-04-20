# Phase-E.2 Pattern Mining — 2026-04-19

Scope: **150 v4 trades** across 8 months (Jul 2025 – Feb 2026) on the 24-ticker universe.

For every trade we reconstruct the **Daily EMA structural context at entry**:
- Price vs D21, D48, D200 EMAs
- EMA stack alignment (bull/bear/mixed)
- D21 5-day slope (momentum of the swing EMA)
- D48 10-day slope (structural trend)
- Daily RSI-14 regime

The goal is a playbook: "For ticker cohort X, our system works when structure Y; avoid when structure Z."

## 1. Cohort baselines

| Cohort | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| Industrial | 41 | 58.5% | 3 | 8 | +56.07% | +1.37% |
| Speculative | 20 | 65.0% | 4 | 4 | +51.37% | +2.57% |
| Index_ETF | 47 | 75.0% | 2 | 4 | +40.14% | +0.85% |
| MegaCap_Tech | 31 | 69.0% | 3 | 8 | +34.20% | +1.10% |
| Semi_Momentum | 5 | 60.0% | 1 | 0 | +5.21% | +1.04% |
| Sector_ETF | 6 | 66.7% | 0 | 1 | -5.86% | -0.98% |

## 2. Daily regime × cohort

Regime labels:
- **bullish_stacked**: price > D200 AND D21 > D48 > D200 (textbook bull)
- **bullish_mixed**: price > D200 but EMAs not fully stacked (early bull / consolidation)
- **bearish_stacked**: price < D200 AND D21 < D48 < D200 (textbook bear)
- **bearish_mixed**: price < D200, EMAs not fully stacked

### Index_ETF (n=47)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 47 | 75.0% | 2 | 4 | +40.14% | +0.85% |

### Sector_ETF (n=6)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 6 | 66.7% | 0 | 1 | -5.86% | -0.98% |

### MegaCap_Tech (n=31)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 30 | 71.4% | 3 | 8 | +34.60% | +1.15% |
| bullish_mixed | 1 | 0.0% | 0 | 0 | -0.40% | -0.40% |

### Industrial (n=41)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 38 | 55.3% | 3 | 8 | +53.50% | +1.41% |
| bearish_mixed | 1 | 100.0% | 0 | 0 | +1.96% | +1.96% |
| bullish_mixed | 2 | 100.0% | 0 | 0 | +0.60% | +0.30% |

### Semi_Momentum (n=5)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 3 | 66.7% | 1 | 0 | +6.11% | +2.04% |
| bearish_mixed | 2 | 50.0% | 0 | 0 | -0.89% | -0.45% |

### Speculative (n=20)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 20 | 65.0% | 4 | 4 | +51.37% | +2.57% |

## 3. Distance from D48 × cohort

Does the "price band above D48 matters" insight from Phase-D hold per cohort?

### Index_ETF

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| just_above_e48_0_2 | 20 | 78.9% | 0 | 2 | -1.25% | -0.06% |
| healthy_2_5 | 27 | 72.0% | 2 | 2 | +41.39% | +1.53% |

### MegaCap_Tech

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| below_e48 | 1 | 0.0% | 0 | 1 | -2.37% | -2.37% |
| just_above_e48_0_2 | 2 | 100.0% | 0 | 0 | +3.18% | +1.59% |
| healthy_2_5 | 26 | 66.7% | 3 | 7 | +30.26% | +1.16% |
| extended_5_8 | 2 | 100.0% | 0 | 0 | +3.13% | +1.57% |

### Industrial

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| just_above_e48_0_2 | 2 | 0.0% | 0 | 1 | -2.11% | -1.06% |
| healthy_2_5 | 29 | 58.6% | 2 | 6 | +45.32% | +1.56% |
| extended_5_8 | 10 | 70.0% | 1 | 1 | +12.87% | +1.29% |

### Semi_Momentum

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| healthy_2_5 | 5 | 60.0% | 1 | 0 | +5.21% | +1.04% |

### Speculative

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| below_e48 | 1 | 100.0% | 0 | 0 | +1.55% | +1.55% |
| just_above_e48_0_2 | 1 | 0.0% | 0 | 1 | -2.09% | -2.09% |
| healthy_2_5 | 14 | 57.1% | 3 | 3 | +25.49% | +1.82% |
| extended_5_8 | 4 | 100.0% | 1 | 0 | +26.43% | +6.61% |

## 4. D21 5-day slope × cohort

Slope is "momentum of the swing EMA". Too-flat = fakeout risk; too-parabolic = late-cycle risk.

### Index_ETF

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| flat_or_slow | 10 | 70.0% | 0 | 1 | -5.05% | -0.51% |
| healthy_rise | 37 | 76.5% | 2 | 3 | +45.20% | +1.22% |

### MegaCap_Tech

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| flat_or_slow | 4 | 50.0% | 0 | 2 | -2.94% | -0.73% |
| healthy_rise | 25 | 73.9% | 3 | 5 | +40.83% | +1.63% |
| strong_rise | 2 | 50.0% | 0 | 1 | -3.69% | -1.84% |

### Industrial

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| flat_or_slow | 5 | 40.0% | 1 | 2 | +28.92% | +5.78% |
| healthy_rise | 23 | 56.5% | 1 | 4 | +12.01% | +0.52% |
| strong_rise | 13 | 69.2% | 1 | 2 | +15.15% | +1.17% |

### Semi_Momentum

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| flat_or_slow | 1 | 100.0% | 0 | 0 | +0.30% | +0.30% |
| healthy_rise | 4 | 50.0% | 1 | 0 | +4.91% | +1.23% |

### Speculative

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| flat_or_slow | 2 | 50.0% | 0 | 1 | -0.97% | -0.48% |
| healthy_rise | 14 | 57.1% | 3 | 3 | +25.91% | +1.85% |
| strong_rise | 4 | 100.0% | 1 | 0 | +26.43% | +6.61% |

## 5. Daily RSI at entry × cohort

### Index_ETF

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| neutral | 2 | 50.0% | 0 | 0 | +2.57% | +1.29% |
| trending_up | 23 | 81.8% | 1 | 1 | +28.97% | +1.26% |
| overbought | 22 | 70.0% | 1 | 3 | +8.60% | +0.39% |

### MegaCap_Tech

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| pullback_zone | 1 | 0.0% | 0 | 1 | -2.83% | -2.83% |
| neutral | 4 | 50.0% | 0 | 2 | -0.58% | -0.14% |
| trending_up | 18 | 68.8% | 2 | 4 | +13.14% | +0.73% |
| overbought | 8 | 87.5% | 1 | 1 | +24.47% | +3.06% |

### Industrial

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| neutral | 4 | 25.0% | 0 | 1 | -2.57% | -0.64% |
| trending_up | 28 | 57.1% | 3 | 7 | +48.83% | +1.74% |
| overbought | 9 | 77.8% | 0 | 0 | +9.81% | +1.09% |

### Semi_Momentum

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| trending_up | 5 | 60.0% | 1 | 0 | +5.21% | +1.04% |

### Speculative

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| neutral | 3 | 66.7% | 1 | 1 | +6.63% | +2.21% |
| trending_up | 11 | 54.5% | 2 | 2 | +22.52% | +2.05% |
| overbought | 6 | 83.3% | 1 | 1 | +22.22% | +3.70% |

## 6. Combined setup quality per cohort

A+ Sweet Spot (per cohort): bullish_stacked regime AND slope in healthy/strong_rise range AND dist in just_above/healthy band.

| Cohort | Zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---|---:|---:|---:|---:|---:|---:|
| Index_ETF → A+ sweet | 37 | 76.5% | 2 | 3 | +45.20% | +1.22% |
| Index_ETF → extended / parabolic | — | — | — | — | — | — |
| Index_ETF → fakeout risk | — | — | — | — | — | — |
| Index_ETF → neutral | 10 | 70.0% | 0 | 1 | -5.05% | -0.51% |
| MegaCap_Tech → A+ sweet | 24 | 72.7% | 3 | 6 | +34.41% | +1.43% |
| MegaCap_Tech → extended / parabolic | 2 | 100.0% | 0 | 0 | +3.13% | +1.57% |
| MegaCap_Tech → fakeout risk | — | — | — | — | — | — |
| MegaCap_Tech → neutral | 5 | 40.0% | 0 | 2 | -3.34% | -0.67% |
| Industrial → A+ sweet | 24 | 54.2% | 1 | 5 | +11.76% | +0.49% |
| Industrial → extended / parabolic | 10 | 70.0% | 1 | 1 | +12.87% | +1.29% |
| Industrial → fakeout risk | — | — | — | — | — | — |
| Industrial → neutral | 7 | 57.1% | 1 | 2 | +31.44% | +4.49% |
| Semi_Momentum → A+ sweet | 2 | 50.0% | 1 | 0 | +5.81% | +2.90% |
| Semi_Momentum → extended / parabolic | — | — | — | — | — | — |
| Semi_Momentum → fakeout risk | — | — | — | — | — | — |
| Semi_Momentum → neutral | 3 | 66.7% | 0 | 0 | -0.59% | -0.20% |
| Speculative → A+ sweet | 14 | 57.1% | 3 | 3 | +25.91% | +1.85% |
| Speculative → extended / parabolic | 4 | 100.0% | 1 | 0 | +26.43% | +6.61% |
| Speculative → fakeout risk | — | — | — | — | — | — |
| Speculative → neutral | 2 | 50.0% | 0 | 1 | -0.97% | -0.48% |
| Sector_ETF → A+ sweet | 3 | 33.3% | 0 | 1 | -7.94% | -2.65% |
| Sector_ETF → extended / parabolic | — | — | — | — | — | — |
| Sector_ETF → fakeout risk | — | — | — | — | — | — |
| Sector_ETF → neutral | 3 | 100.0% | 0 | 0 | +2.08% | +0.69% |

## 7. Winner vs loser distributions (per cohort)

Where is the dividing line inside each cohort? (medians / percentiles)

### Index_ETF

**pct_above_e48**:
  - Winners: min=0.72 q1=1.55 median=2.07 q3=2.8 max=4.37 mean=2.22
  - Losers: min=0.67 q1=1.37 median=2.24 q3=3.01 max=4.37 mean=2.31

**e21_slope_5d_pct**:
  - Winners: min=0.02 q1=0.38 median=0.53 q3=0.81 max=1.25 mean=0.56
  - Losers: min=0.2 q1=0.27 median=0.44 q3=0.66 max=1.48 mean=0.58

**rsi_d**:
  - Winners: min=50.8 q1=60.6 median=66.3 q3=72.8 max=85.5 mean=67.0
  - Losers: min=49.7 q1=60.9 median=71.1 q3=73.0 max=79.9 mean=67.78

### MegaCap_Tech

**pct_above_e48**:
  - Winners: min=0.68 q1=2.25 median=3.31 q3=3.91 max=5.58 mean=3.27
  - Losers: min=-0.53 q1=2.68 median=3.35 q3=3.77 max=4.92 mean=2.97

**e21_slope_5d_pct**:
  - Winners: min=0.05 q1=0.45 median=0.83 q3=1.21 max=1.8 mean=0.81
  - Losers: min=-0.21 q1=0.31 median=0.79 q3=1.02 max=1.77 mean=0.72

**rsi_d**:
  - Winners: min=49.6 q1=56.8 median=67.1 q3=70.8 max=90.1 mean=65.79
  - Losers: min=44.4 q1=46.1 median=67.6 q3=69.5 max=74.3 mean=61.0

### Industrial

**pct_above_e48**:
  - Winners: min=2.38 q1=3.9 median=4.74 q3=5.7 max=6.72 mean=4.66
  - Losers: min=1.75 q1=2.47 median=3.67 q3=4.39 max=6.51 mean=3.66

**e21_slope_5d_pct**:
  - Winners: min=0.2 q1=0.68 median=1.19 q3=1.91 max=2.33 mean=1.22
  - Losers: min=0.1 q1=0.43 median=0.78 q3=1.28 max=2.25 mean=0.93

**rsi_d**:
  - Winners: min=51.7 q1=62.4 median=67.0 q3=71.8 max=76.6 mean=66.45
  - Losers: min=49.9 q1=58.3 median=62.0 q3=62.5 max=73.1 mean=61.35

### Semi_Momentum

**pct_above_e48**:
  - Winners: min=2.73 q1=2.73 median=3.44 q3=3.83 max=3.83 mean=3.33
  - Losers: min=3.36 q1=3.36 median=3.57 q3=3.57 max=3.57 mean=3.46

**e21_slope_5d_pct**:
  - Winners: min=0.15 q1=0.15 median=0.64 q3=1.37 max=1.37 mean=0.72
  - Losers: min=0.94 q1=0.94 median=0.97 q3=0.97 max=0.97 mean=0.95

**rsi_d**:
  - Winners: min=62.8 q1=62.8 median=64.7 q3=68.7 max=68.7 mean=65.4
  - Losers: min=67.8 q1=67.8 median=69.8 q3=69.8 max=69.8 mean=68.8

### Speculative

**pct_above_e48**:
  - Winners: min=-0.04 q1=3.08 median=4.5 q3=6.49 max=6.67 mean=4.27
  - Losers: min=1.97 q1=2.18 median=3.18 q3=4.36 max=4.4 mean=3.09

**e21_slope_5d_pct**:
  - Winners: min=0.02 q1=0.39 median=0.89 q3=1.67 max=2.73 mean=1.12
  - Losers: min=0.14 q1=0.33 median=0.51 q3=0.81 max=0.83 mean=0.53

**rsi_d**:
  - Winners: min=45.7 q1=60.9 median=67.3 q3=71.5 max=76.4 mean=65.34
  - Losers: min=50.7 q1=62.1 median=65.0 q3=68.5 max=89.2 mean=66.37

## 8. Operator playbook (what works / what doesn't)

For each cohort, the evidence-backed "when to trust the signal, when to stand down" rules.

### Index_ETF

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 37 trades / WR 76.5% / avg pnl +1.22%
- **All bullish_stacked entries**: 47 trades / WR 75.0% / sum pnl +40.14%

### MegaCap_Tech

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 24 trades / WR 72.7% / avg pnl +1.43%
- **Extended** (>5% above D48 OR parabolic slope): 2 trades / WR 100.0% / avg pnl +1.57%
- **All bullish_stacked entries**: 30 trades / WR 71.4% / sum pnl +34.60%
- **All bullish_mixed entries**: 1 trades / WR 0.0% / sum pnl -0.40%

### Industrial

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 24 trades / WR 54.2% / avg pnl +0.49%
- **Extended** (>5% above D48 OR parabolic slope): 10 trades / WR 70.0% / avg pnl +1.29%
- **All bullish_stacked entries**: 38 trades / WR 55.3% / sum pnl +53.50%
- **All bullish_mixed entries**: 2 trades / WR 100.0% / sum pnl +0.60%

### Semi_Momentum

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 2 trades / WR 50.0% / avg pnl +2.90%
- **All bullish_stacked entries**: 3 trades / WR 66.7% / sum pnl +6.11%

### Speculative

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 14 trades / WR 57.1% / avg pnl +1.85%
- **Extended** (>5% above D48 OR parabolic slope): 4 trades / WR 100.0% / avg pnl +6.61%
- **All bullish_stacked entries**: 20 trades / WR 65.0% / sum pnl +51.37%
