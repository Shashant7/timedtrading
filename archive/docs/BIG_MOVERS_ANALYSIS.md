# Big Movers Analysis - Signal Sequence Study

**Goal:** Find tickers with massive moves, analyze the signals BEFORE the move started.

Generated: 2026-02-10T02:23:05.615Z
Window: 2026-02-08T02:21:37 → 2026-02-10T02:21:37
Criteria: ≥3% move within 4h, 4h signal lookback

## Summary

| Metric | Value |
|:--|--:|
| Total significant moves | 466 |
| UP moves | 41 |
| DOWN moves | 9 |
| Avg move magnitude | 6.38% |

## 📈 UP Moves (41 total)

### Conditions at Move Start

| Metric | Value |
|:--|--:|
| Avg move | +16.59% |
| Median duration | 100 min |
| Avg HTF score | -9.5 |
| Median HTF score | -22.4 |
| Avg LTF score | -5.4 |
| Median LTF score | -9.3 |
| Avg Rank | 0 |
| Avg Completion | 31.9% |
| Avg Phase | 61.2% |

### State at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BEAR_LTF_BEAR | 17 | 41.5% |
| HTF_BEAR_LTF_PULLBACK | 12 | 29.3% |
| HTF_BULL_LTF_PULLBACK | 12 | 29.3% |

### Pre-Move Signal Patterns

| Pattern | Count | % | Interpretation |
|:--|--:|--:|:--|
| HTF Improving | 22 | 53.7% | HTF trending in direction of move |
| LTF Pullback Setup | 9 | 22.0% | LTF negative before up move |
| Recent Corridor Entry | 14 | 34.1% | Just entered entry zone |
| Squeeze Release | 14 | 34.1% | Volatility expansion starting |
| State Transition | 19 | 46.3% | Momentum shift detected |

### Active Flags at Move Start (>10% frequency)

| Flag | Count | % |
|:--|--:|--:|
| momentum_elite | 22 | 53.7% |
| st_flip_1h | 5 | 12.2% |
| st_flip_30m | 5 | 12.2% |

## 📉 DOWN Moves (9 total)

### Conditions at Move Start

| Metric | Value |
|:--|--:|
| Avg move | 11.99% |
| Median duration | 70 min |
| Avg HTF score | 16.2 |
| Median HTF score | -2.9 |
| Avg LTF score | 21.1 |
| Median LTF score | 22.3 |
| Avg Rank | 0 |
| Avg Completion | 35.2% |
| Avg Phase | 40.3% |

### State at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BEAR_LTF_PULLBACK | 5 | 55.6% |
| HTF_BULL_LTF_BULL | 4 | 44.4% |

### Pre-Move Signal Patterns

| Pattern | Count | % | Interpretation |
|:--|--:|--:|:--|
| HTF Improving | 0 | 0.0% | HTF trending in direction of move |
| LTF Pullback Setup | 9 | 100.0% | LTF positive before down move |
| Recent Corridor Entry | 0 | 0.0% | Just entered entry zone |
| Squeeze Release | 3 | 33.3% | Volatility expansion starting |
| State Transition | 1 | 11.1% | Momentum shift detected |

## 🎬 Top Move Journeys (Signal Sequences)

### HIMS UP +37.61%

- **Time:** 2026-02-09T14:30:00 (100 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-33.1 LTF=-20.5 | Rank=0 | Comp=27.2% Phase=85.1%

### HIMS UP +35.31%

- **Time:** 2026-02-09T15:35:00 (35 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-33.0 LTF=-16.6 | Rank=0 | Comp=27.2% Phase=85.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:10:00 | -33.0 | -12.8 | BEAR_BEAR | momentum_elite |
| 15:15:00 | -33.0 | -12.8 | BEAR_BEAR | momentum_elite |
| 15:20:00 | -33.0 | -11.6 | BEAR_BEAR | momentum_elite |
| 15:25:00 | -33.0 | -11.6 | BEAR_BEAR | momentum_elite |
| 15:30:00 | -33.0 | -14.9 | BEAR_BEAR | momentum_elite |

### HIMS UP +34.50%

- **Time:** 2026-02-09T15:00:00 (70 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-33.0 LTF=-11.6 | Rank=0 | Comp=27.2% Phase=85.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:35:00 | -33.1 | -21.3 | BEAR_BEAR | momentum_elite |
| 14:40:00 | -33.1 | -17.2 | BEAR_BEAR | momentum_elite |
| 14:45:00 | -33.1 | -17.2 | BEAR_BEAR | momentum_elite |
| 14:50:00 | -33.1 | -16.0 | BEAR_BEAR | momentum_elite |
| 14:55:00 | -33.1 | -16.0 | BEAR_BEAR | momentum_elite |

### HIMS UP +32.19%

- **Time:** 2026-02-09T16:35:00 (1 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-33.0 LTF=-15.9 | Rank=0 | Comp=27.2% Phase=85.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 16:10:29 | -21.6 | -12.8 | BEAR_BEAR | — |
| 16:15:00 | -33.0 | -11.5 | BEAR_BEAR | momentum_elite |
| 16:20:00 | -33.0 | -11.5 | BEAR_BEAR | momentum_elite |
| 16:25:00 | -33.0 | -11.5 | BEAR_BEAR | momentum_elite |
| 16:30:00 | -33.0 | -15.4 | BEAR_BEAR | momentum_elite |

### HIMS UP +30.25%

- **Time:** 2026-02-09T16:25:00 (11 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-33.0 LTF=-11.5 | Rank=0 | Comp=27.2% Phase=85.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 16:05:00 | -33.0 | -11.5 | BEAR_BEAR | momentum_elite |
| 16:10:00 | -33.0 | -11.5 | BEAR_BEAR | momentum_elite |
| 16:10:29 | -21.6 | -12.8 | BEAR_BEAR | — |
| 16:15:00 | -33.0 | -11.5 | BEAR_BEAR | momentum_elite |
| 16:20:00 | -33.0 | -11.5 | BEAR_BEAR | momentum_elite |

### HIMS UP +29.73%

- **Time:** 2026-02-09T17:05:00 (16 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-33.0 LTF=-12.7 | Rank=0 | Comp=27.2% Phase=85.1%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 16:40:00 | -33.0 | -13.6 | BEAR_BEAR | — |
| 16:45:00 | -33.0 | -13.6 | BEAR_BEAR | — |
| 16:50:00 | -33.0 | -9.1 | BEAR_BEAR | — |
| 16:55:00 | -33.0 | -7.3 | BEAR_BEAR | momentum_elite |
| 17:00:00 | -33.0 | -12.7 | BEAR_BEAR | momentum_elite |

### APP UP +18.47%

- **Time:** 2026-02-09T18:45:25 (240 min)
- **At start:** HTF_BEAR_LTF_PULLBACK | HTF=-5.2 LTF=14.3 | Rank=0 | Comp=33.5% Phase=94.8%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 18:30:26 | -5.2 | 14.3 | BEAR_PULLBACK | — |
| 18:30:26 | -5.2 | 14.3 | BEAR_PULLBACK | — |
| 18:35:00 | -3.3 | 9.8 | BEAR_PULLBACK | momentum_elite |
| 18:40:00 | -3.3 | 11.0 | BEAR_PULLBACK | momentum_elite |
| 18:45:00 | -3.3 | 8.0 | BEAR_PULLBACK | momentum_elite |

### RDDT UP +18.45%

- **Time:** 2026-02-09T14:30:00 (80 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-25.7 LTF=-15.2 | Rank=0 | Comp=27.4% Phase=77.9%

### RDDT UP +17.30%

- **Time:** 2026-02-09T15:20:00 (30 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-25.8 LTF=-18.2 | Rank=0 | Comp=27.4% Phase=77.9%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:55:00 | -25.7 | -17.7 | BEAR_BEAR | — |
| 15:00:00 | -25.8 | -18.2 | BEAR_BEAR | — |
| 15:05:00 | -25.8 | -18.2 | BEAR_BEAR | — |
| 15:10:00 | -25.8 | -7.4 | BEAR_BEAR | — |
| 15:15:00 | -25.8 | -7.4 | BEAR_BEAR | — |

### RDDT UP +16.99%

- **Time:** 2026-02-09T15:40:00 (10 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-25.8 LTF=-6.8 | Rank=0 | Comp=27.4% Phase=77.9%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:15:00 | -25.8 | -7.4 | BEAR_BEAR | — |
| 15:20:00 | -25.8 | -18.2 | BEAR_BEAR | — |
| 15:25:00 | -25.8 | -18.2 | BEAR_BEAR | — |
| 15:30:00 | -25.8 | -10.4 | BEAR_BEAR | — |
| 15:35:00 | -25.8 | -10.4 | BEAR_BEAR | — |

### RDDT UP +16.59%

- **Time:** 2026-02-09T17:25:00 (31 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-26.1 LTF=-17.2 | Rank=0 | Comp=27.4% Phase=77.9%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 17:00:38 | -20.5 | -13.6 | BEAR_BEAR | — |
| 17:05:00 | -26.1 | -5.8 | BEAR_BEAR | momentum_elite |
| 17:10:00 | -26.1 | -9.4 | BEAR_BEAR | — |
| 17:15:00 | -26.1 | -11.1 | BEAR_BEAR | — |
| 17:20:00 | -26.1 | -16.1 | BEAR_BEAR | — |

### RDDT UP +16.52%

- **Time:** 2026-02-09T17:30:00 (26 min)
- **At start:** HTF_BEAR_LTF_BEAR | HTF=-26.1 LTF=-15.6 | Rank=0 | Comp=27.4% Phase=77.9%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 17:05:00 | -26.1 | -5.8 | BEAR_BEAR | momentum_elite |
| 17:10:00 | -26.1 | -9.4 | BEAR_BEAR | — |
| 17:15:00 | -26.1 | -11.1 | BEAR_BEAR | — |
| 17:20:00 | -26.1 | -16.1 | BEAR_BEAR | — |
| 17:25:00 | -26.1 | -17.2 | BEAR_BEAR | momentum_elite |

### APP UP +15.40%

- **Time:** 2026-02-09T18:19:23 (236 min)
- **At start:** HTF_BEAR_LTF_PULLBACK | HTF=-5.2 LTF=14.3 | Rank=0 | Comp=33.5% Phase=94.8%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 18:00:00 | -3.3 | 16.4 | BEAR_PULLBACK | momentum_elite |
| 18:05:00 | -3.3 | 15.1 | BEAR_PULLBACK | momentum_elite |
| 18:08:24 | -5.2 | 14.3 | BEAR_PULLBACK | — |
| 18:10:00 | -3.3 | 12.8 | BEAR_PULLBACK | momentum_elite |
| 18:15:00 | -3.3 | 11.0 | BEAR_PULLBACK | momentum_elite |

### RDDT UP +15.33%

- **Time:** 2026-02-09T16:55:00 (6 min)
- **At start:** HTF_BEAR_LTF_PULLBACK | HTF=-25.8 LTF=1.6 | Rank=0 | Comp=27.4% Phase=77.9%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 16:30:00 | -25.8 | 3.4 | BEAR_PULLBACK | momentum_elite |
| 16:35:00 | -25.8 | 3.4 | BEAR_PULLBACK | momentum_elite |
| 16:40:00 | -25.8 | 3.4 | BEAR_PULLBACK | momentum_elite |
| 16:45:00 | -25.8 | 3.4 | BEAR_PULLBACK | momentum_elite |
| 16:50:00 | -25.8 | 3.4 | BEAR_PULLBACK | momentum_elite |

### RDDT UP +15.07%

- **Time:** 2026-02-09T16:15:00 (11 min)
- **At start:** HTF_BEAR_LTF_PULLBACK | HTF=-25.8 LTF=1.3 | Rank=0 | Comp=27.4% Phase=77.9%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:50:28 | -20.5 | -13.6 | BEAR_BEAR | — |
| 15:55:00 | -25.8 | 1.3 | BEAR_PULLBACK | — |
| 16:00:00 | -25.8 | 1.6 | BEAR_PULLBACK | — |
| 16:05:00 | -25.8 | 1.6 | BEAR_PULLBACK | — |
| 16:10:00 | -25.8 | 1.3 | BEAR_PULLBACK | momentum_elite |

## 🎯 Gold Standard Entry Criteria (Derived)

Based on the signal sequences that preceded big moves:

### For LONG entries (UP moves):

- LTF score in pullback (< 0) — median: -9
- HTF improving in lookback (53.7% of winners)
- State transition in lookback (46.3% of winners)

### For SHORT entries (DOWN moves):

- LTF score in pullback (> 0) — median: 22
- LTF pullback setup present (100.0% of winners)
