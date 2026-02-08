# Historical Big Movers Analysis

**Purpose:** Identify the biggest price moves across ALL historical data and analyze the signals that preceded them.

Generated: 2026-02-04T03:43:08.364Z
Criteria: Moves ≥3%, Top 5 per ticker, 50 signal points lookback

## Data Coverage

| Metric | Value |
|:--|--:|
| Tickers analyzed | 160 |
| Date range | 2026-01-14 → 2026-02-04 |
| Total data points | 433,467 |
| UP moves found | 331 |
| DOWN moves found | 306 |

## 📈 UP Moves Analysis (331 moves)

### Statistics at Move Start

| Metric | Value |
|:--|--:|
| Avg move | +8.17% |
| Median move | +5.94% |
| P90 move | +15.19% |
| Median duration | 1391 min |
| Avg HTF | 16.2 |
| Median HTF | 20.4 |
| Avg LTF | -6.9 |
| Median LTF | -9.3 |
| Avg Rank | 58 |
| Avg Completion | 30.4% |
| Avg Phase | 38.6% |

### State Distribution at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_PULLBACK | 224 | 67.7% |
| HTF_BEAR_LTF_BEAR | 55 | 16.6% |
| HTF_BULL_LTF_BULL | 49 | 14.8% |
| HTF_BEAR_LTF_PULLBACK | 3 | 0.9% |

### Pre-Move Signal Patterns

| Signal | Count | % | Interpretation |
|:--|--:|--:|:--|
| ltfPullback | 279 | 84.3% | LTF in pullback (setup) |
| stateTransition | 121 | 36.6% | State changed before move |
| htfImproving | 113 | 34.1% | HTF momentum improving |
| squeezeOn | 72 | 21.8% | Squeeze active (coiling) |
| flipWatch | 54 | 16.3% | Flip watch active |
| stFlip | 39 | 11.8% | Supertrend flip |
| momentumElite | 38 | 11.5% | Momentum elite condition |
| squeezeRelease | 29 | 8.8% | Squeeze released (volatility expansion) |
| emaCross | 21 | 6.3% | EMA crossover signal |

### Common State Transitions Before UP Moves

| Transition | Count |
|:--|--:|
| HTF_BULL_LTF_BULL → HTF_BULL_LTF_PULLBACK | 196 |
| HTF_BULL_LTF_PULLBACK → HTF_BEAR_LTF_BEAR | 171 |
| HTF_BEAR_LTF_BEAR → HTF_BULL_LTF_PULLBACK | 169 |
| HTF_BULL_LTF_PULLBACK → HTF_BULL_LTF_BULL | 164 |
| HTF_BEAR_LTF_PULLBACK → HTF_BEAR_LTF_BEAR | 22 |
| HTF_BULL_LTF_BULL → HTF_BEAR_LTF_PULLBACK | 21 |
| HTF_BEAR_LTF_PULLBACK → HTF_BULL_LTF_BULL | 16 |
| HTF_BEAR_LTF_BEAR → HTF_BEAR_LTF_PULLBACK | 10 |
| HTF_BEAR_LTF_BEAR → HTF_BULL_LTF_BULL | 3 |
| HTF_BEAR_LTF_PULLBACK → HTF_BULL_LTF_PULLBACK | 2 |

### Top 10 UP Moves

| # | Ticker | Move | Duration | Time | State | HTF | LTF |
|--:|:--|--:|--:|:--|:--|--:|--:|
| 1 | SNDK | +46.79% | 10360m | 01-27T16:19 | BULL_PULLBACK | 19 | -13 |
| 2 | AGQ | +46.35% | 5586m | 01-22T20:57 | BULL_BULL | 29 | 18 |
| 3 | LITE | +40.30% | 11154m | 01-26T20:36 | BULL_PULLBACK | 23 | -15 |
| 4 | VIX | +37.12% | 7286m | 01-15T18:05 | BEAR_BEAR | -24 | -8 |
| 5 | STX | +35.53% | 15633m | 01-23T17:57 | BULL_PULLBACK | 27 | -6 |
| 6 | MU | +31.38% | 27559m | 01-14T14:55 | BULL_PULLBACK | 26 | -14 |
| 7 | SILVER | +29.74% | 7090m | 01-21T19:53 | BULL_PULLBACK | 37 | -5 |
| 8 | NXT | +28.60% | 20241m | 01-20T14:37 | BULL_PULLBACK | 19 | -8 |
| 9 | UUUU | +28.38% | 6977m | 01-21T18:18 | BULL_PULLBACK | 22 | -10 |
| 10 | CRWV | +27.97% | 6071m | 01-23T14:34 | BEAR_BEAR | -15 | -13 |

## 📉 DOWN Moves Analysis (306 moves)

### Statistics at Move Start

| Metric | Value |
|:--|--:|
| Avg move | 9.61% |
| Median move | 6.34% |
| Median duration | 4140 min |
| Avg HTF | 24.3 |
| Median HTF | 28.2 |
| Avg LTF | 16.2 |
| Median LTF | 18.8 |

### State Distribution at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_BULL | 253 | 82.7% |
| HTF_BEAR_LTF_PULLBACK | 24 | 7.8% |
| HTF_BULL_LTF_PULLBACK | 23 | 7.5% |
| HTF_BEAR_LTF_BEAR | 6 | 2.0% |

### Pre-Move Signal Patterns

| Signal | Count | % |
|:--|--:|--:|
| ltfPullback | 277 | 90.5% |
| stateTransition | 114 | 37.3% |
| htfImproving | 110 | 35.9% |
| squeezeOn | 60 | 19.6% |
| stFlip | 55 | 18.0% |
| momentumElite | 44 | 14.4% |
| squeezeRelease | 21 | 6.9% |
| flipWatch | 18 | 5.9% |
| emaCross | 16 | 5.2% |

### Top 10 DOWN Moves

| # | Ticker | Move | Duration | Time | State | HTF | LTF |
|--:|:--|--:|--:|:--|:--|--:|--:|
| 1 | ETHT | -63.86% | 28691m | 01-14T20:35 | BEAR_PULLBACK | -15 | 21 |
| 2 | ETHA | -37.55% | 28916m | 01-14T16:50 | BEAR_PULLBACK | -11 | 17 |
| 3 | GLXY | -37.13% | 10008m | 01-27T20:14 | BULL_BULL | 26 | 23 |
| 4 | ETHUSD | -36.72% | 22766m | 01-18T23:20 | BULL_BULL | 14 | 4 |
| 5 | RDDT | -36.30% | 28712m | 01-14T20:20 | BULL_PULLBACK | 30 | -3 |
| 6 | AVAV | -34.32% | 24526m | 01-16T19:14 | BULL_BULL | 42 | 22 |
| 7 | IOT | -33.77% | 26022m | 01-16T16:45 | BULL_BULL | 5 | 24 |
| 8 | SLV | -31.81% | 8485m | 01-27T20:55 | BULL_BULL | 41 | 22 |
| 9 | JOBY | -31.40% | 17261m | 01-22T19:12 | BULL_BULL | 32 | 19 |
| 10 | HL | -30.70% | 15503m | 01-23T20:15 | BULL_BULL | 38 | 24 |

## 🎯 Derived Gold Standard Entry Criteria

Based on analysis of 637 significant moves:

### For LONG Entries:

- HTF > 10 (median at start: 20)
- LTF in pullback (< 5) — median: -9
- LTF pullback setup (84.3% of winners)
- State transition in lookback (36.6% of winners)
- Most common state: **HTF_BULL_LTF_PULLBACK** (67.7%)

### For SHORT Entries:

- LTF in pullback (> -5) — median: 19
- LTF pullback setup (90.5% of winners)
- Most common state: **HTF_BULL_LTF_BULL** (82.7%)

## Per-Ticker Analysis Files

Individual ticker analysis saved to `docs/historical-movers/[TICKER].json`

Use these files for:
- Reviewing signal sequences for specific tickers
- Building ticker-specific entry criteria
- Backtesting against historical moves
