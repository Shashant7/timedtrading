# Phase-E.2 Pattern Mining — 2026-04-19

Scope: **117 v4 trades** across 8 months (Jul 2025 – Feb 2026) on the 24-ticker universe.

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
| MegaCap_Tech | 27 | 70.8% | 4 | 6 | +76.64% | +2.84% |
| Industrial | 34 | 69.7% | 3 | 5 | +61.08% | +1.80% |
| Speculative | 17 | 68.8% | 4 | 2 | +53.99% | +3.18% |
| Index_ETF | 32 | 71.4% | 1 | 4 | +27.59% | +0.86% |
| Semi_Momentum | 7 | 57.1% | 1 | 0 | +7.62% | +1.09% |

## 2. Daily regime × cohort

Regime labels:
- **bullish_stacked**: price > D200 AND D21 > D48 > D200 (textbook bull)
- **bullish_mixed**: price > D200 but EMAs not fully stacked (early bull / consolidation)
- **bearish_stacked**: price < D200 AND D21 < D48 < D200 (textbook bear)
- **bearish_mixed**: price < D200, EMAs not fully stacked

### Index_ETF (n=32)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 32 | 71.4% | 1 | 4 | +27.59% | +0.86% |

### MegaCap_Tech (n=27)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 26 | 73.9% | 4 | 6 | +77.04% | +2.96% |
| bullish_mixed | 1 | 0.0% | 0 | 0 | -0.40% | -0.40% |

### Industrial (n=34)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 31 | 66.7% | 3 | 5 | +59.89% | +1.93% |
| bullish_mixed | 3 | 100.0% | 0 | 0 | +1.19% | +0.40% |

### Semi_Momentum (n=7)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 5 | 60.0% | 1 | 0 | +8.52% | +1.70% |
| bearish_mixed | 2 | 50.0% | 0 | 0 | -0.89% | -0.45% |

### Speculative (n=17)

| Regime | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| bullish_stacked | 17 | 68.8% | 4 | 2 | +53.99% | +3.18% |

## 3. Distance from D48 × cohort

Does the "price band above D48 matters" insight from Phase-D hold per cohort?

### Index_ETF

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| just_above_e48_0_2 | 5 | 66.7% | 0 | 1 | +0.11% | +0.02% |
| healthy_2_5 | 27 | 72.0% | 1 | 3 | +27.48% | +1.02% |

### MegaCap_Tech

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| just_above_e48_0_2 | 1 | 100.0% | 0 | 0 | +0.97% | +0.97% |
| healthy_2_5 | 24 | 66.7% | 3 | 6 | +31.94% | +1.33% |
| extended_5_8 | 2 | 100.0% | 1 | 0 | +43.74% | +21.87% |

### Industrial

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| healthy_2_5 | 21 | 71.4% | 1 | 4 | +45.68% | +2.17% |
| extended_5_8 | 13 | 66.7% | 2 | 1 | +15.40% | +1.18% |

### Semi_Momentum

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| healthy_2_5 | 6 | 66.7% | 1 | 0 | +7.91% | +1.32% |
| extended_5_8 | 1 | 0.0% | 0 | 0 | -0.28% | -0.28% |

### Speculative

| Distance from D48 | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| just_above_e48_0_2 | 1 | 0.0% | 0 | 1 | -2.09% | -2.09% |
| healthy_2_5 | 12 | 63.6% | 3 | 1 | +30.41% | +2.53% |
| extended_5_8 | 4 | 100.0% | 1 | 0 | +25.67% | +6.42% |

## 4. D21 5-day slope × cohort

Slope is "momentum of the swing EMA". Too-flat = fakeout risk; too-parabolic = late-cycle risk.

### Index_ETF

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| healthy_rise | 32 | 71.4% | 1 | 4 | +27.59% | +0.86% |

### MegaCap_Tech

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| healthy_rise | 25 | 72.7% | 4 | 5 | +80.33% | +3.21% |
| strong_rise | 2 | 50.0% | 0 | 1 | -3.69% | -1.84% |

### Industrial

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| healthy_rise | 20 | 65.0% | 1 | 3 | +42.32% | +2.12% |
| strong_rise | 14 | 76.9% | 2 | 2 | +18.76% | +1.34% |

### Semi_Momentum

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| flat_or_slow | 1 | 100.0% | 0 | 0 | +0.30% | +0.30% |
| healthy_rise | 4 | 50.0% | 1 | 0 | +4.91% | +1.23% |
| strong_rise | 2 | 50.0% | 0 | 0 | +2.41% | +1.21% |

### Speculative

| D21 slope band | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| healthy_rise | 13 | 58.3% | 3 | 2 | +28.32% | +2.18% |
| strong_rise | 4 | 100.0% | 1 | 0 | +25.67% | +6.42% |

## 5. Daily RSI at entry × cohort

### Index_ETF

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| neutral | 1 | 0.0% | 0 | 1 | -2.24% | -2.24% |
| trending_up | 13 | 70.0% | 1 | 1 | +33.81% | +2.60% |
| overbought | 18 | 76.5% | 0 | 2 | -3.98% | -0.22% |

### MegaCap_Tech

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| neutral | 2 | 50.0% | 0 | 1 | -0.42% | -0.21% |
| trending_up | 18 | 66.7% | 3 | 4 | +55.49% | +3.08% |
| overbought | 7 | 85.7% | 1 | 1 | +21.58% | +3.08% |

### Industrial

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| neutral | 1 | 0.0% | 0 | 1 | -3.17% | -3.17% |
| trending_up | 22 | 72.7% | 2 | 4 | +56.25% | +2.56% |
| overbought | 11 | 70.0% | 1 | 0 | +8.00% | +0.73% |

### Semi_Momentum

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| trending_up | 6 | 66.7% | 1 | 0 | +7.91% | +1.32% |
| overbought | 1 | 0.0% | 0 | 0 | -0.28% | -0.28% |

### Speculative

| RSI-D zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---:|---:|---:|---:|---:|---:|
| neutral | 1 | 100.0% | 1 | 0 | +7.59% | +7.59% |
| trending_up | 10 | 50.0% | 2 | 2 | +21.72% | +2.17% |
| overbought | 6 | 100.0% | 1 | 0 | +24.67% | +4.11% |

## 6. Combined setup quality per cohort

A+ Sweet Spot (per cohort): bullish_stacked regime AND slope in healthy/strong_rise range AND dist in just_above/healthy band.

| Cohort | Zone | n | WR | Big W | Clear L | Sum PnL | Avg PnL |
|---|---|---:|---:|---:|---:|---:|---:|
| Index_ETF → A+ sweet | 32 | 71.4% | 1 | 4 | +27.59% | +0.86% |
| Index_ETF → extended / parabolic | — | — | — | — | — | — |
| Index_ETF → fakeout risk | — | — | — | — | — | — |
| Index_ETF → neutral | — | — | — | — | — | — |
| MegaCap_Tech → A+ sweet | 24 | 71.4% | 3 | 6 | +33.30% | +1.39% |
| MegaCap_Tech → extended / parabolic | 2 | 100.0% | 1 | 0 | +43.74% | +21.87% |
| MegaCap_Tech → fakeout risk | — | — | — | — | — | — |
| MegaCap_Tech → neutral | 1 | 0.0% | 0 | 0 | -0.40% | -0.40% |
| Industrial → A+ sweet | 19 | 68.4% | 1 | 4 | +44.53% | +2.34% |
| Industrial → extended / parabolic | 13 | 66.7% | 2 | 1 | +15.40% | +1.18% |
| Industrial → fakeout risk | — | — | — | — | — | — |
| Industrial → neutral | 2 | 100.0% | 0 | 0 | +1.15% | +0.58% |
| Semi_Momentum → A+ sweet | 3 | 66.7% | 1 | 0 | +8.50% | +2.83% |
| Semi_Momentum → extended / parabolic | 1 | 0.0% | 0 | 0 | -0.28% | -0.28% |
| Semi_Momentum → fakeout risk | — | — | — | — | — | — |
| Semi_Momentum → neutral | 3 | 66.7% | 0 | 0 | -0.59% | -0.20% |
| Speculative → A+ sweet | 13 | 58.3% | 3 | 2 | +28.32% | +2.18% |
| Speculative → extended / parabolic | 4 | 100.0% | 1 | 0 | +25.67% | +6.42% |
| Speculative → fakeout risk | — | — | — | — | — | — |
| Speculative → neutral | — | — | — | — | — | — |

## 7. Winner vs loser distributions (per cohort)

Where is the dividing line inside each cohort? (medians / percentiles)

### Index_ETF

**pct_above_e48**:
  - Winners: min=1.47 q1=2.1 median=2.5 q3=3.26 max=4.37 mean=2.7
  - Losers: min=1.79 q1=2.52 median=3.19 q3=3.36 max=4.16 mean=2.92

**e21_slope_5d_pct**:
  - Winners: min=0.5 q1=0.53 median=0.61 q3=0.85 max=1.25 mean=0.71
  - Losers: min=0.56 q1=0.65 median=0.69 q3=0.82 max=1.17 mean=0.73

**rsi_d**:
  - Winners: min=56.8 q1=62.2 median=72.8 q3=78.1 max=79.0 mean=70.44
  - Losers: min=53.0 q1=66.3 median=71.4 q3=79.9 max=85.5 mean=70.21

### MegaCap_Tech

**pct_above_e48**:
  - Winners: min=0.85 q1=3.12 median=3.32 q3=4.35 max=6.12 mean=3.55
  - Losers: min=2.14 q1=2.68 median=3.41 q3=4.1 max=4.92 mean=3.48

**e21_slope_5d_pct**:
  - Winners: min=0.31 q1=0.46 median=0.79 q3=1.21 max=1.8 mean=0.85
  - Losers: min=0.31 q1=0.57 median=0.97 q3=1.44 max=1.77 mean=0.98

**rsi_d**:
  - Winners: min=49.6 q1=58.4 median=65.9 q3=70.8 max=90.1 mean=66.22
  - Losers: min=45.5 q1=62.9 median=69.0 q3=69.7 max=74.3 mean=65.5

### Industrial

**pct_above_e48**:
  - Winners: min=3.47 q1=4.21 median=4.82 q3=5.94 max=6.74 mean=4.96
  - Losers: min=3.16 q1=3.74 median=4.42 q3=5.15 max=6.51 mean=4.58

**e21_slope_5d_pct**:
  - Winners: min=0.73 q1=1.01 median=1.27 q3=1.93 max=2.44 mean=1.46
  - Losers: min=0.77 q1=0.89 median=1.01 q3=1.64 max=2.25 mean=1.22

**rsi_d**:
  - Winners: min=56.4 q1=65.4 median=67.6 q3=74.2 max=77.5 mean=68.33
  - Losers: min=49.9 q1=62.5 median=68.3 q3=70.8 max=73.1 mean=65.53

### Semi_Momentum

**pct_above_e48**:
  - Winners: min=2.73 q1=3.44 median=3.83 q3=4.86 max=4.86 mean=3.71
  - Losers: min=3.36 q1=3.36 median=3.57 q3=5.64 max=5.64 mean=4.19

**e21_slope_5d_pct**:
  - Winners: min=0.15 q1=0.64 median=1.37 q3=2.3 max=2.3 mean=1.11
  - Losers: min=0.94 q1=0.94 median=0.97 q3=2.28 max=2.28 mean=1.4

**rsi_d**:
  - Winners: min=60.9 q1=62.8 median=64.7 q3=68.7 max=68.7 mean=64.28
  - Losers: min=67.8 q1=67.8 median=69.8 q3=70.5 max=70.5 mean=69.37

### Speculative

**pct_above_e48**:
  - Winners: min=2.18 q1=3.42 median=4.63 q3=6.51 max=6.67 mean=4.62
  - Losers: min=1.97 q1=3.18 median=3.32 q3=4.36 max=4.4 mean=3.45

**e21_slope_5d_pct**:
  - Winners: min=0.37 q1=0.81 median=1.02 q3=1.78 max=2.73 mean=1.25
  - Losers: min=0.33 q1=0.46 median=0.51 q3=0.66 max=0.83 mean=0.56

**rsi_d**:
  - Winners: min=53.4 q1=65.7 median=70.8 q3=74.3 max=89.2 mean=69.47
  - Losers: min=62.1 q1=63.6 median=65.0 q3=65.5 max=68.5 mean=64.94

## 8. Operator playbook (what works / what doesn't)

For each cohort, the evidence-backed "when to trust the signal, when to stand down" rules.

### Index_ETF

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 32 trades / WR 71.4% / avg pnl +0.86%
- **All bullish_stacked entries**: 32 trades / WR 71.4% / sum pnl +27.59%

### MegaCap_Tech

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 24 trades / WR 71.4% / avg pnl +1.39%
- **Extended** (>5% above D48 OR parabolic slope): 2 trades / WR 100.0% / avg pnl +21.87%
- **All bullish_stacked entries**: 26 trades / WR 73.9% / sum pnl +77.04%
- **All bullish_mixed entries**: 1 trades / WR 0.0% / sum pnl -0.40%

### Industrial

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 19 trades / WR 68.4% / avg pnl +2.34%
- **Extended** (>5% above D48 OR parabolic slope): 13 trades / WR 66.7% / avg pnl +1.18%
- **All bullish_stacked entries**: 31 trades / WR 66.7% / sum pnl +59.89%
- **All bullish_mixed entries**: 3 trades / WR 100.0% / sum pnl +1.19%

### Semi_Momentum

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 3 trades / WR 66.7% / avg pnl +2.83%
- **Extended** (>5% above D48 OR parabolic slope): 1 trades / WR 0.0% / avg pnl -0.28%
- **All bullish_stacked entries**: 5 trades / WR 60.0% / sum pnl +8.52%

### Speculative

- **A+ sweet spot** (bullish stack + healthy slope + 0-5% above D48): 13 trades / WR 58.3% / avg pnl +2.18%
- **Extended** (>5% above D48 OR parabolic slope): 4 trades / WR 100.0% / avg pnl +6.42%
- **All bullish_stacked entries**: 17 trades / WR 68.8% / sum pnl +53.99%
