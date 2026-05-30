# Historical Big Movers Analysis

**Purpose:** Identify the biggest price moves across ALL historical data and analyze the signals that preceded them.

Generated: 2026-02-12T00:47:24.881Z
Criteria: Moves ≥3%, Top 5 per ticker, 50 signal points lookback

## Data Coverage

| Metric | Value |
|:--|--:|
| Tickers analyzed | 206 |
| Date range | 2025-10-01 → 2026-02-12 |
| Total data points | 1,577,832 |
| UP moves found | 917 |
| DOWN moves found | 863 |

## 📈 UP Moves Analysis (917 moves)

### Statistics at Move Start

| Metric | Value |
|:--|--:|
| Avg move | +57.71% |
| Median move | +12.33% |
| P90 move | +39.16% |
| Median duration | 8605 min |
| Avg HTF | 16.2 |
| Median HTF | 23.5 |
| Avg LTF | -7.9 |
| Median LTF | -8.2 |
| Avg Rank | 0 |
| Avg Completion | 22.7% |
| Avg Phase | 33.3% |

### State Distribution at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_PULLBACK | 362 | 39.5% |
| HTF_BULL_LTF_BULL | 331 | 36.1% |
| HTF_BEAR_LTF_BEAR | 165 | 18.0% |
| HTF_BEAR_LTF_PULLBACK | 59 | 6.4% |

### Pre-Move Signal Patterns

| Signal | Count | % | Interpretation |
|:--|--:|--:|:--|
| ltfPullback | 527 | 57.5% | LTF in pullback (setup) |
| stFlip | 390 | 42.5% | Supertrend flip |
| momentumElite | 257 | 28.0% | Momentum elite condition |
| stateTransition | 226 | 24.6% | State changed before move |
| emaCross | 206 | 22.5% | EMA crossover signal |
| squeezeRelease | 139 | 15.2% | Squeeze released (volatility expansion) |
| squeezeOn | 0 | 0.0% | Squeeze active (coiling) |
| htfImproving | 0 | 0.0% | HTF momentum improving |
| flipWatch | 0 | 0.0% | Flip watch active |

### Common State Transitions Before UP Moves

| Transition | Count |
|:--|--:|
| HTF_BULL_LTF_BULL → HTF_BULL_LTF_PULLBACK | 178 |
| HTF_BEAR_LTF_PULLBACK → HTF_BEAR_LTF_BEAR | 156 |
| HTF_BEAR_LTF_BEAR → HTF_BEAR_LTF_PULLBACK | 121 |
| HTF_BULL_LTF_PULLBACK → HTF_BULL_LTF_BULL | 109 |
| HTF_BULL_LTF_PULLBACK → HTF_BEAR_LTF_PULLBACK | 11 |
| HTF_BEAR_LTF_PULLBACK → HTF_BULL_LTF_PULLBACK | 10 |
| HTF_BEAR_LTF_PULLBACK → HTF_BULL_LTF_BULL | 8 |
| HTF_BULL_LTF_PULLBACK → HTF_BEAR_LTF_BEAR | 6 |
| HTF_BULL_LTF_BULL → HTF_BEAR_LTF_PULLBACK | 6 |
| HTF_BULL_LTF_BULL → HTF_BEAR_LTF_BEAR | 4 |

### Top 10 UP Moves

| # | Ticker | Move | Duration | Time | State | HTF | LTF |
|--:|:--|--:|--:|:--|:--|--:|--:|
| 1 | GOLD | +18600.62% | 105380m | 11-24T16:00 | BULL_PULLBACK | 7 | -14 |
| 2 | GOLD | +9085.33% | 4165m | 02-06T19:20 | BULL_PULLBACK | 10 | -21 |
| 3 | GOLD | +7599.39% | 41m | 02-09T16:50 | BULL_PULLBACK | 6 | -27 |
| 4 | AGQ | +412.34% | 98970m | 11-21T21:00 | BULL_BULL | 40 | 0 |
| 5 | CRVS | +313.76% | 14325m | 01-13T16:10 | BULL_PULLBACK | 20 | -23 |
| 6 | IBRX | +298.12% | 31500m | 12-31T17:30 | BEAR_BEAR | -40 | -15 |
| 7 | LITE | +282.81% | 158355m | 10-22T16:00 | BULL_BULL | 40 | 0 |
| 8 | SNDK | +196.49% | 48960m | 12-31T21:00 | BULL_PULLBACK | 12 | -11 |
| 9 | HL | +161.05% | 95030m | 11-21T15:00 | BULL_BULL | 36 | 0 |
| 10 | RKLB | +146.49% | 66270m | 12-01T15:00 | BULL_BULL | 7 | 0 |

## 📉 DOWN Moves Analysis (863 moves)

### Statistics at Move Start

| Metric | Value |
|:--|--:|
| Avg move | 13.36% |
| Median move | 9.28% |
| Median duration | 7225 min |
| Avg HTF | 31.0 |
| Median HTF | 40.2 |
| Avg LTF | 6.5 |
| Median LTF | 5.5 |

### State Distribution at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_BULL | 714 | 82.7% |
| HTF_BEAR_LTF_PULLBACK | 82 | 9.5% |
| HTF_BULL_LTF_PULLBACK | 55 | 6.4% |
| HTF_BEAR_LTF_BEAR | 12 | 1.4% |

### Pre-Move Signal Patterns

| Signal | Count | % |
|:--|--:|--:|
| ltfPullback | 461 | 53.4% |
| stFlip | 379 | 43.9% |
| stateTransition | 298 | 34.5% |
| momentumElite | 278 | 32.2% |
| squeezeRelease | 159 | 18.4% |
| emaCross | 142 | 16.5% |
| squeezeOn | 0 | 0.0% |
| htfImproving | 0 | 0.0% |
| flipWatch | 0 | 0.0% |

### Top 10 DOWN Moves

| # | Ticker | Move | Duration | Time | State | HTF | LTF |
|--:|:--|--:|--:|:--|:--|--:|--:|
| 1 | GOLD | -98.91% | 1085m | 02-05T20:25 | BULL_PULLBACK | 5 | -4 |
| 2 | ETHT | -89.05% | 175790m | 10-06T19:00 | BULL_BULL | 30 | 0 |
| 3 | HIMS | -73.89% | 168270m | 10-15T18:00 | BULL_BULL | 49 | 0 |
| 4 | BMNR | -72.84% | 174680m | 10-07T13:30 | BULL_BULL | 16 | 0 |
| 5 | FIG | -71.98% | 171115m | 10-08T19:00 | BULL_BULL | 5 | 0 |
| 6 | MSTR | -70.96% | 176120m | 10-06T13:30 | BULL_BULL | 27 | 0 |
| 7 | AGQ | -70.58% | 9770m | 01-29T20:50 | BULL_BULL | 39 | 9 |
| 8 | SBET | -68.58% | 175790m | 10-06T19:00 | BULL_BULL | 1 | 0 |
| 9 | IONQ | -64.20% | 165815m | 10-13T17:00 | BULL_BULL | 49 | 0 |
| 10 | U | -63.42% | 89295m | 12-11T15:00 | BULL_BULL | 35 | 8 |

## 🎯 Derived Gold Standard Entry Criteria

Based on analysis of 1780 significant moves:

### For LONG Entries:

- HTF > 12 (median at start: 24)
- LTF in pullback (< 5) — median: -8
- LTF pullback setup (57.5% of winners)
- Squeeze release in lookback (15.2% of winners)
- State transition in lookback (24.6% of winners)
- Most common state: **HTF_BULL_LTF_PULLBACK** (39.5%)

### For SHORT Entries:

- LTF in pullback (> -5) — median: 6
- LTF pullback setup (53.4% of winners)
- Most common state: **HTF_BULL_LTF_BULL** (82.7%)

## Per-Ticker Analysis Files

Individual ticker analysis saved to `docs/historical-movers/[TICKER].json`

Use these files for:
- Reviewing signal sequences for specific tickers
- Building ticker-specific entry criteria
- Backtesting against historical moves
