# Big Movers Analysis - Signal Sequence Study

**Goal:** Find tickers with massive moves, analyze the signals BEFORE the move started.

Generated: 2026-02-12T00:44:36.330Z
Window: 2025-10-01T00:00:00 → 2026-02-12T00:00:00
Criteria: ≥3% move within 4h, 4h signal lookback

## Summary

| Metric | Value |
|:--|--:|
| Total significant moves | 10678 |
| UP moves | 62 |
| DOWN moves | 38 |
| Avg move magnitude | 4.75% |

## 📈 UP Moves (62 total)

### Conditions at Move Start

| Metric | Value |
|:--|--:|
| Avg move | +16.80% |
| Median duration | 180 min |
| Avg HTF score | 28.0 |
| Median HTF score | 35.0 |
| Avg LTF score | 2.7 |
| Median LTF score | 0.0 |
| Avg Rank | 0 |
| Avg Completion | 16.0% |
| Avg Phase | 31.0% |

### State at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_BULL | 48 | 77.4% |
| HTF_BEAR_LTF_PULLBACK | 8 | 12.9% |
| HTF_BULL_LTF_PULLBACK | 4 | 6.5% |
| HTF_BEAR_LTF_BEAR | 2 | 3.2% |

### Pre-Move Signal Patterns

| Pattern | Count | % | Interpretation |
|:--|--:|--:|:--|
| HTF Improving | 22 | 35.5% | HTF trending in direction of move |
| LTF Pullback Setup | 5 | 8.1% | LTF negative before up move |
| Recent Corridor Entry | 0 | 0.0% | Just entered entry zone |
| Squeeze Release | 7 | 11.3% | Volatility expansion starting |
| State Transition | 13 | 21.0% | Momentum shift detected |

## 📉 DOWN Moves (38 total)

### Conditions at Move Start

| Metric | Value |
|:--|--:|
| Avg move | 17.05% |
| Median duration | 195 min |
| Avg HTF score | 21.5 |
| Median HTF score | 30.9 |
| Avg LTF score | -0.7 |
| Median LTF score | 0.0 |
| Avg Rank | 0 |
| Avg Completion | 16.2% |
| Avg Phase | 26.1% |

### State at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_BULL | 25 | 65.8% |
| HTF_BULL_LTF_PULLBACK | 8 | 21.1% |
| HTF_BEAR_LTF_PULLBACK | 5 | 13.2% |

### Pre-Move Signal Patterns

| Pattern | Count | % | Interpretation |
|:--|--:|--:|:--|
| HTF Improving | 16 | 42.1% | HTF trending in direction of move |
| LTF Pullback Setup | 3 | 7.9% | LTF positive before down move |
| Recent Corridor Entry | 0 | 0.0% | Just entered entry zone |
| Squeeze Release | 2 | 5.3% | Volatility expansion starting |
| State Transition | 0 | 0.0% | Momentum shift detected |

## 🎬 Top Move Journeys (Signal Sequences)

### VIX UP +34.82%

- **Time:** 2025-11-20T14:30:00 (120 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=35.4 LTF=0.0 | Rank=0 | Comp=10.5% Phase=56.0%

### VIX UP +34.82%

- **Time:** 2025-11-20T15:00:00 (90 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=35.4 LTF=0.0 | Rank=0 | Comp=10.5% Phase=56.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:35:00 | 35.4 | 0.0 | BULL_BULL | — |
| 14:40:00 | 35.4 | 0.0 | BULL_BULL | — |
| 14:45:00 | 35.4 | 0.0 | BULL_BULL | — |
| 14:50:00 | 35.4 | 0.0 | BULL_BULL | — |
| 14:55:00 | 35.4 | 0.0 | BULL_BULL | — |

### VIX UP +27.13%

- **Time:** 2025-10-10T13:30:00 (60 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=21.9 LTF=0.0 | Rank=0 | Comp=10.2% Phase=97.7%

### VIX UP +27.13%

- **Time:** 2025-10-10T14:00:00 (30 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=21.9 LTF=0.0 | Rank=0 | Comp=10.2% Phase=97.7%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 13:35:00 | 21.9 | 0.0 | BULL_BULL | — |
| 13:40:00 | 21.9 | 0.0 | BULL_BULL | — |
| 13:45:00 | 21.9 | 0.0 | BULL_BULL | — |
| 13:50:00 | 21.9 | 0.0 | BULL_BULL | — |
| 13:55:00 | 21.9 | 0.0 | BULL_BULL | — |

### AXON DOWN -22.04%

- **Time:** 2025-11-04T17:00:00 (240 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=16.8 LTF=-8.2 | Rank=0 | Comp=20.7% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 16:35:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 16:40:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 16:45:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 16:50:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 16:55:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |

### AXON DOWN -22.00%

- **Time:** 2025-11-04T20:00:00 (60 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=12.9 LTF=-1.6 | Rank=0 | Comp=20.7% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 19:35:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:40:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:45:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:50:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:55:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |

### VIX UP +21.91%

- **Time:** 2025-11-20T15:30:00 (60 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=36.6 LTF=0.0 | Rank=0 | Comp=11.5% Phase=56.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:05:00 | 35.4 | 0.0 | BULL_BULL | — |
| 15:10:00 | 35.4 | 0.0 | BULL_BULL | — |
| 15:15:00 | 35.4 | 0.0 | BULL_BULL | — |
| 15:20:00 | 35.4 | 0.0 | BULL_BULL | — |
| 15:25:00 | 35.4 | 0.0 | BULL_BULL | — |

### VIX UP +21.91%

- **Time:** 2025-11-20T16:00:00 (30 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=36.6 LTF=0.0 | Rank=0 | Comp=11.5% Phase=56.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:35:00 | 36.6 | 0.0 | BULL_BULL | — |
| 15:40:00 | 36.6 | 0.0 | BULL_BULL | — |
| 15:45:00 | 36.6 | 0.0 | BULL_BULL | — |
| 15:50:00 | 36.6 | 0.0 | BULL_BULL | — |
| 15:55:00 | 36.6 | 0.0 | BULL_BULL | — |

### AXON DOWN -21.68%

- **Time:** 2025-11-04T17:30:00 (210 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=16.8 LTF=-7.1 | Rank=0 | Comp=20.6% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 17:05:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 17:10:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 17:15:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 17:20:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 17:25:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |

### AXON DOWN -21.32%

- **Time:** 2025-11-04T19:00:00 (120 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=16.8 LTF=-8.2 | Rank=0 | Comp=20.5% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 18:35:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:40:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:45:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:50:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:55:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |

### AXON DOWN -21.30%

- **Time:** 2025-11-04T18:30:00 (150 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=16.8 LTF=-8.2 | Rank=0 | Comp=20.5% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 18:05:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:10:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:15:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:20:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 18:25:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |

### AXON DOWN -21.22%

- **Time:** 2025-11-04T19:30:00 (90 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=16.8 LTF=-8.2 | Rank=0 | Comp=20.5% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 19:05:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:10:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:15:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:20:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |
| 19:25:00 | 16.8 | -8.2 | BULL_PULLBACK | move_completed |

### AXON DOWN -21.00%

- **Time:** 2025-11-04T20:30:00 (30 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=12.9 LTF=-9.4 | Rank=0 | Comp=20.5% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 20:05:00 | 12.9 | -1.6 | BULL_PULLBACK | move_completed |
| 20:10:00 | 12.9 | -1.6 | BULL_PULLBACK | move_completed |
| 20:15:00 | 12.9 | -1.6 | BULL_PULLBACK | move_completed |
| 20:20:00 | 12.9 | -1.6 | BULL_PULLBACK | move_completed |
| 20:25:00 | 12.9 | -1.6 | BULL_PULLBACK | move_completed |

### AXON DOWN -20.64%

- **Time:** 2025-11-04T18:00:00 (180 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=16.8 LTF=-8.2 | Rank=0 | Comp=20.4% Phase=3.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 17:35:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 17:40:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 17:45:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 17:50:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |
| 17:55:00 | 16.8 | -7.1 | BULL_PULLBACK | move_completed |

### VIX UP +18.98%

- **Time:** 2025-10-16T13:30:00 (240 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=24.5 LTF=0.0 | Rank=0 | Comp=11.6% Phase=91.1%

## 🎯 Gold Standard Entry Criteria (Derived)

Based on the signal sequences that preceded big moves:

### For LONG entries (UP moves):

- HTF score > 18 (median at move start: 35)
- HTF improving in lookback (35.5% of winners)

### For SHORT entries (DOWN moves):

- HTF improving (going more negative) in lookback (42.1% of winners)
