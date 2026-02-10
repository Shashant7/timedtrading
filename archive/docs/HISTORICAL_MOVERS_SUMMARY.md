# Historical Big Movers Analysis

**Purpose:** Identify the biggest price moves across ALL historical data and analyze the signals that preceded them.

Generated: 2026-02-10T02:21:31.941Z
Criteria: Moves ≥3%, Top 5 per ticker, 50 signal points lookback

## Data Coverage

| Metric | Value |
|:--|--:|
| Tickers analyzed | 164 |
| Date range | 2025-12-10 → 2026-02-10 |
| Total data points | 229,596 |
| UP moves found | 466 |
| DOWN moves found | 351 |

## 📈 UP Moves Analysis (466 moves)

### Statistics at Move Start

| Metric | Value |
|:--|--:|
| Avg move | +13.16% |
| Median move | +8.34% |
| P90 move | +26.13% |
| Median duration | 2830 min |
| Avg HTF | 18.7 |
| Median HTF | 25.1 |
| Avg LTF | -11.4 |
| Median LTF | -14.5 |
| Avg Rank | 0 |
| Avg Completion | 31.8% |
| Avg Phase | 36.5% |

### State Distribution at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_PULLBACK | 298 | 63.9% |
| HTF_BEAR_LTF_BEAR | 92 | 19.7% |
| HTF_BULL_LTF_BULL | 59 | 12.7% |
| HTF_BEAR_LTF_PULLBACK | 17 | 3.6% |

### Pre-Move Signal Patterns

| Signal | Count | % | Interpretation |
|:--|--:|--:|:--|
| ltfPullback | 390 | 83.7% | LTF in pullback (setup) |
| momentumElite | 363 | 77.9% | Momentum elite condition |
| stFlip | 284 | 60.9% | Supertrend flip |
| stateTransition | 244 | 52.4% | State changed before move |
| squeezeRelease | 126 | 27.0% | Squeeze released (volatility expansion) |
| emaCross | 77 | 16.5% | EMA crossover signal |
| squeezeOn | 0 | 0.0% | Squeeze active (coiling) |
| htfImproving | 0 | 0.0% | HTF momentum improving |
| flipWatch | 0 | 0.0% | Flip watch active |

### Common State Transitions Before UP Moves

| Transition | Count |
|:--|--:|
| HTF_BULL_LTF_BULL → HTF_BULL_LTF_PULLBACK | 297 |
| HTF_BULL_LTF_PULLBACK → HTF_BULL_LTF_BULL | 218 |
| HTF_BEAR_LTF_PULLBACK → HTF_BEAR_LTF_BEAR | 143 |
| HTF_BEAR_LTF_BEAR → HTF_BEAR_LTF_PULLBACK | 121 |
| HTF_BEAR_LTF_PULLBACK → HTF_BULL_LTF_PULLBACK | 27 |
| HTF_BULL_LTF_PULLBACK → HTF_BEAR_LTF_PULLBACK | 23 |
| HTF_BEAR_LTF_BEAR → HTF_BULL_LTF_PULLBACK | 7 |
| HTF_BULL_LTF_PULLBACK → HTF_BEAR_LTF_BEAR | 5 |
| HTF_BULL_LTF_BULL → HTF_BEAR_LTF_BEAR | 3 |
| HTF_BEAR_LTF_PULLBACK → HTF_BULL_LTF_BULL | 1 |

### Top 10 UP Moves

| # | Ticker | Move | Duration | Time | State | HTF | LTF |
|--:|:--|--:|--:|:--|:--|--:|--:|
| 1 | SNDK | +248.26% | 72000m | 12-15T21:00 | BULL_PULLBACK | 2 | -14 |
| 2 | BE | +97.54% | 71610m | 12-15T21:00 | BULL_PULLBACK | 21 | -12 |
| 3 | MU | +90.37% | 65895m | 12-15T20:30 | BULL_PULLBACK | 39 | -12 |
| 4 | APLD | +82.90% | 61860m | 12-15T21:00 | BULL_PULLBACK | 16 | -12 |
| 5 | RKLB | +80.15% | 45750m | 12-15T21:00 | BULL_PULLBACK | 44 | -11 |
| 6 | KTOS | +79.27% | 46170m | 12-15T16:30 | BULL_PULLBACK | 10 | -13 |
| 7 | IREN | +79.11% | 63330m | 12-15T21:00 | BULL_PULLBACK | 5 | -12 |
| 8 | AVAV | +74.71% | 46290m | 12-15T15:00 | BEAR_BEAR | -4 | -12 |
| 9 | SOXL | +73.44% | 64420m | 12-15T21:00 | BULL_PULLBACK | 35 | -14 |
| 10 | WDC | +72.46% | 71700m | 12-15T21:00 | BULL_PULLBACK | 41 | -14 |

## 📉 DOWN Moves Analysis (351 moves)

### Statistics at Move Start

| Metric | Value |
|:--|--:|
| Avg move | 10.78% |
| Median move | 6.81% |
| Median duration | 2630 min |
| Avg HTF | 28.8 |
| Median HTF | 35.9 |
| Avg LTF | 8.9 |
| Median LTF | 11.6 |

### State Distribution at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_BULL | 250 | 71.2% |
| HTF_BULL_LTF_PULLBACK | 56 | 16.0% |
| HTF_BEAR_LTF_PULLBACK | 31 | 8.8% |
| HTF_BEAR_LTF_BEAR | 14 | 4.0% |

### Pre-Move Signal Patterns

| Signal | Count | % |
|:--|--:|--:|
| ltfPullback | 280 | 79.8% |
| momentumElite | 265 | 75.5% |
| stateTransition | 234 | 66.7% |
| stFlip | 232 | 66.1% |
| squeezeRelease | 131 | 37.3% |
| emaCross | 59 | 16.8% |
| squeezeOn | 0 | 0.0% |
| htfImproving | 0 | 0.0% |
| flipWatch | 0 | 0.0% |

### Top 10 DOWN Moves

| # | Ticker | Move | Duration | Time | State | HTF | LTF |
|--:|:--|--:|--:|:--|:--|--:|--:|
| 1 | HIMS | -56.86% | 84750m | 12-12T18:00 | BULL_BULL | 6 | 7 |
| 2 | GLXY | -49.91% | 12950m | 01-27T21:00 | BULL_BULL | 13 | 23 |
| 3 | APP | -49.87% | 80640m | 12-11T19:30 | BULL_BULL | 34 | 14 |
| 4 | IOT | -48.00% | 80275m | 12-10T21:00 | BULL_BULL | 36 | 13 |
| 5 | HOOD | -47.24% | 82120m | 12-10T20:00 | BULL_BULL | 45 | 4 |
| 6 | COIN | -46.29% | 79375m | 12-12T18:00 | BEAR_PULLBACK | -3 | 5 |
| 7 | ETHUSD | -44.63% | 28800m | 01-16T14:30 | BULL_PULLBACK | 11 | -11 |
| 8 | ETHA | -44.44% | 28790m | 01-16T21:00 | BEAR_BEAR | -12 | -9 |
| 9 | AVAV | -42.31% | 28920m | 01-16T18:35 | BULL_BULL | 49 | 8 |
| 10 | RDDT | -41.53% | 30480m | 01-16T16:30 | BULL_BULL | 35 | 5 |

## 🎯 Derived Gold Standard Entry Criteria

Based on analysis of 817 significant moves:

### For LONG Entries:

- HTF > 13 (median at start: 25)
- LTF in pullback (< 5) — median: -15
- LTF pullback setup (83.7% of winners)
- Squeeze release in lookback (27.0% of winners)
- State transition in lookback (52.4% of winners)
- Most common state: **HTF_BULL_LTF_PULLBACK** (63.9%)

### For SHORT Entries:

- LTF in pullback (> -5) — median: 12
- LTF pullback setup (79.8% of winners)
- Most common state: **HTF_BULL_LTF_BULL** (71.2%)

## Per-Ticker Analysis Files

Individual ticker analysis saved to `docs/historical-movers/[TICKER].json`

Use these files for:
- Reviewing signal sequences for specific tickers
- Building ticker-specific entry criteria
- Backtesting against historical moves
