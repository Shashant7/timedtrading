# Big Movers Analysis - Signal Sequence Study

**Goal:** Find tickers with massive moves, analyze the signals BEFORE the move started.

Generated: 2026-02-06T18:58:15.096Z
Window: 2026-02-01T18:56:31 → 2026-02-06T18:56:31
Criteria: ≥2% move within 4h, 4h signal lookback

## Summary

| Metric | Value |
|:--|--:|
| Total significant moves | 512 |
| UP moves | 18 |
| DOWN moves | 57 |
| Avg move magnitude | 4.79% |

## 📈 UP Moves (18 total)

### Conditions at Move Start

| Metric | Value |
|:--|--:|
| Avg move | +10.57% |
| Median duration | 171 min |
| Avg HTF score | 7.0 |
| Median HTF score | 3.3 |
| Avg LTF score | -2.9 |
| Median LTF score | -6.1 |
| Avg Rank | 61 |
| Avg Completion | 28.2% |
| Avg Phase | 29.6% |

### State at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_PULLBACK | 9 | 50.0% |
| HTF_BEAR_LTF_BEAR | 7 | 38.9% |
| HTF_BEAR_LTF_PULLBACK | 1 | 5.6% |
| HTF_BULL_LTF_BULL | 1 | 5.6% |

### Pre-Move Signal Patterns

| Pattern | Count | % | Interpretation |
|:--|--:|--:|:--|
| HTF Improving | 7 | 38.9% | HTF trending in direction of move |
| LTF Pullback Setup | 12 | 66.7% | LTF negative before up move |
| Recent Corridor Entry | 10 | 55.6% | Just entered entry zone |
| Squeeze Release | 0 | 0.0% | Volatility expansion starting |
| State Transition | 12 | 66.7% | Momentum shift detected |

### Active Flags at Move Start (>10% frequency)

| Flag | Count | % |
|:--|--:|--:|
| htf_improving_1d | 12 | 66.7% |
| htf_improving_4h | 11 | 61.1% |
| htf_move_4h_ge_5 | 10 | 55.6% |
| flip_watch | 10 | 55.6% |
| buyable_dip_1h_13_48 | 2 | 11.1% |

## 📉 DOWN Moves (57 total)

### Conditions at Move Start

| Metric | Value |
|:--|--:|
| Avg move | 10.54% |
| Median duration | 207 min |
| Avg HTF score | 20.6 |
| Median HTF score | 27.8 |
| Avg LTF score | 3.5 |
| Median LTF score | 3.5 |
| Avg Rank | 73 |
| Avg Completion | 20.4% |
| Avg Phase | 36.9% |

### State at Move Start

| State | Count | % |
|:--|--:|--:|
| HTF_BULL_LTF_BULL | 30 | 52.6% |
| HTF_BULL_LTF_PULLBACK | 16 | 28.1% |
| HTF_BEAR_LTF_BEAR | 9 | 15.8% |
| HTF_BEAR_LTF_PULLBACK | 2 | 3.5% |

### Pre-Move Signal Patterns

| Pattern | Count | % | Interpretation |
|:--|--:|--:|:--|
| HTF Improving | 12 | 21.1% | HTF trending in direction of move |
| LTF Pullback Setup | 22 | 38.6% | LTF positive before down move |
| Recent Corridor Entry | 10 | 17.5% | Just entered entry zone |
| Squeeze Release | 3 | 5.3% | Volatility expansion starting |
| State Transition | 15 | 26.3% | Momentum shift detected |

## 🎬 Top Move Journeys (Signal Sequences)

### VIX UP +19.29%

- **Time:** 2026-02-04T14:48:00 (207 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=1.2 LTF=8.9 | Rank=74 | Comp=7.0% Phase=20.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:43:00 | -4.6 | 13.2 | BEAR_PULLBACK | st_flip_3m, htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:44:00 | 5.4 | 18.0 | BULL_BULL | htf_improving_4h, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 14:45:00 | -4.6 | 6.9 | BEAR_PULLBACK | htf_improving_4h, htf_improving_1d, flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:46:00 | 5.4 | 18.0 | BULL_BULL | position_closed_cleared, forced_watch_no_position |
| 14:47:00 | -4.6 | 15.0 | BEAR_PULLBACK | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, position_closed_cleared, forced_watch_no_position |

### VIX UP +18.18%

- **Time:** 2026-02-04T13:45:00 (240 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=5.4 LTF=3.8 | Rank=74 | Comp=7.0% Phase=20.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 13:40:00 | 5.4 | 7.8 | BULL_PULLBACK | buyable_dip, htf_improving_1d, position_closed_cleared, forced_watch_no_position |
| 13:41:00 | -4.6 | -1.3 | BEAR_BEAR | ema_cross_3m_13_48, htf_improving_4h, htf_improving_1d, position_closed_cleared, forced_watch_no_position |
| 13:42:00 | 5.4 | 7.8 | BULL_PULLBACK | buyable_dip, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 13:43:00 | -4.6 | -1.3 | BEAR_BEAR | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 13:44:00 | 5.4 | 7.0 | BULL_PULLBACK | buyable_dip, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |

### SOXL DOWN -18.05%

- **Time:** 2026-02-04T14:48:00 (207 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=32.9 LTF=-12.0 | Rank=71 | Comp=19.0% Phase=23.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:43:00 | 32.9 | -12.0 | BULL_PULLBACK | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:44:00 | 22.9 | -12.0 | BULL_PULLBACK | flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:45:00 | 22.9 | -6.0 | BULL_PULLBACK | flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:46:00 | 32.9 | -12.0 | BULL_PULLBACK | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:47:00 | 32.9 | -12.0 | BULL_PULLBACK | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, position_closed_cleared, forced_watch_no_position |

### VIX UP +17.57%

- **Time:** 2026-02-04T14:15:00 (240 min)
- **At start:** HTF_BEAR_LTF_PULLBACK | HTF=-4.6 LTF=14.6 | Rank=51 | Comp=4.0% Phase=21.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:10:00 | -4.6 | 12.1 | BEAR_PULLBACK | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:11:00 | -2.0 | 12.1 | BEAR_PULLBACK | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:12:00 | -4.6 | 12.1 | BEAR_PULLBACK | htf_improving_4h, htf_improving_1d, flip_watch, position_closed_cleared, forced_watch_no_position |
| 14:13:00 | 5.4 | 15.1 | BULL_BULL | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 14:14:00 | 5.4 | 15.1 | BULL_BULL | htf_improving_4h, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |

### APLD DOWN -16.91%

- **Time:** 2026-02-04T14:30:00 (195 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=23.0 LTF=3.5 | Rank=82 | Comp=18.0% Phase=8.0%

### ONDS DOWN -16.62%

- **Time:** 2026-02-04T14:30:00 (225 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=21.2 LTF=13.5 | Rank=84 | Comp=2.0% Phase=13.0%

### VIX UP +15.40%

- **Time:** 2026-02-04T15:11:00 (184 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=24.3 LTF=24.0 | Rank=82 | Comp=2.0% Phase=23.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:06:00 | 22.8 | 25.1 | BULL_BULL | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 15:07:00 | 15.9 | 25.1 | BULL_BULL | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 15:08:00 | 14.3 | 24.0 | BULL_BULL | st_flip_30m, htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 15:09:00 | 14.3 | 18.0 | BULL_BULL | htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |
| 15:10:00 | 14.3 | 18.0 | BULL_BULL | htf_improving_4h, htf_move_4h_ge_5, position_closed_cleared, forced_watch_no_position |

### BE DOWN -15.24%

- **Time:** 2026-02-04T14:30:00 (215 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=34.1 LTF=15.7 | Rank=96 | Comp=10.0% Phase=44.0%

### SOXL DOWN -14.89%

- **Time:** 2026-02-04T15:09:00 (186 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=32.9 LTF=-9.5 | Rank=76 | Comp=30.0% Phase=19.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:04:00 | 32.9 | -9.5 | BULL_PULLBACK | move_invalidated, htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch |
| 15:05:00 | 22.9 | -9.5 | BULL_PULLBACK | move_invalidated, flip_watch |
| 15:06:00 | 32.9 | -9.5 | BULL_PULLBACK | move_invalidated, htf_improving_4h, htf_move_4h_ge_5, flip_watch |
| 15:07:00 | 22.9 | -5.8 | BULL_PULLBACK | move_invalidated, flip_watch |
| 15:08:00 | 32.9 | -9.5 | BULL_PULLBACK | st_flip_10m, move_invalidated, htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch |

### LITE DOWN -14.61%

- **Time:** 2026-02-04T14:50:00 (235 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=40.3 LTF=20.4 | Rank=67 | Comp=75.0% Phase=55.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:45:00 | 39.1 | 20.4 | BULL_BULL | htf_improving_4h |
| 14:46:00 | 39.1 | 17.0 | BULL_BULL | htf_improving_4h |
| 14:47:00 | 39.1 | 20.4 | BULL_BULL | htf_improving_4h |
| 14:48:00 | 40.0 | 20.1 | BULL_BULL | htf_improving_4h |
| 14:49:00 | 40.0 | 20.2 | BULL_BULL | htf_improving_4h, htf_improving_1d |

### AEHR DOWN -14.37%

- **Time:** 2026-02-04T14:39:00 (206 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=37.8 LTF=10.6 | Rank=82 | Comp=2.0% Phase=5.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:34:00 | 37.8 | 8.5 | BULL_BULL | htf_improving_4h, htf_move_4h_ge_5, forced_enter_now_gate, stage_monotonicity_enforced |
| 14:35:00 | 27.8 | -9.8 | BULL_PULLBACK | flip_watch |
| 14:36:00 | 37.8 | 10.6 | BULL_BULL | htf_improving_4h, htf_move_4h_ge_5, forced_enter_now_gate, stage_monotonicity_enforced |
| 14:37:00 | 27.8 | 8.5 | BULL_BULL | — |
| 14:38:00 | 37.8 | 8.5 | BULL_BULL | htf_improving_4h, htf_move_4h_ge_5 |

### IREN DOWN -13.73%

- **Time:** 2026-02-04T14:30:00 (215 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=21.5 LTF=-12.1 | Rank=81 | Comp=2.0% Phase=10.0%

### RKLB DOWN -13.63%

- **Time:** 2026-02-04T14:30:00 (215 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=22.0 LTF=14.9 | Rank=76 | Comp=34.0% Phase=12.0%

### LITE DOWN -12.29%

- **Time:** 2026-02-04T15:00:00 (225 min)
- **At start:** HTF_BULL_LTF_BULL | HTF=41.1 LTF=19.9 | Rank=66 | Comp=68.0% Phase=53.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 14:55:00 | 30.5 | 15.8 | BULL_BULL | htf_move_4h_ge_5 |
| 14:56:00 | 30.5 | 16.8 | BULL_BULL | htf_move_4h_ge_5 |
| 14:57:00 | 40.5 | 15.8 | BULL_BULL | htf_improving_4h |
| 14:58:00 | 40.5 | 17.0 | BULL_BULL | htf_improving_4h |
| 14:59:00 | 37.1 | 17.0 | BULL_BULL | htf_improving_1d |

### BE DOWN -12.19%

- **Time:** 2026-02-04T15:10:00 (175 min)
- **At start:** HTF_BULL_LTF_PULLBACK | HTF=40.0 LTF=-4.0 | Rank=87 | Comp=0.0% Phase=38.0%

**Pre-move signals (last 5 points):**

| Time | HTF | LTF | State | Flags |
|:--|--:|--:|:--|:--|
| 15:05:00 | 40.0 | -1.7 | BULL_PULLBACK | momentum_elite, htf_improving_4h, htf_move_4h_ge_5, flip_watch, stage_monotonicity_enforced |
| 15:06:00 | 30.0 | -6.0 | BULL_PULLBACK | momentum_elite, flip_watch, stage_monotonicity_enforced |
| 15:07:00 | 30.0 | -5.9 | BULL_PULLBACK | momentum_elite, flip_watch, stage_monotonicity_enforced |
| 15:08:00 | 40.0 | -5.5 | BULL_PULLBACK | momentum_elite, htf_improving_4h, htf_move_4h_ge_5, flip_watch, stage_monotonicity_enforced |
| 15:09:00 | 40.0 | -3.8 | BULL_PULLBACK | momentum_elite, st_flip_30m, htf_improving_4h, htf_improving_1d, htf_move_4h_ge_5, flip_watch, stage_monotonicity_enforced |

## 🎯 Gold Standard Entry Criteria (Derived)

Based on the signal sequences that preceded big moves:

### For LONG entries (UP moves):

- LTF score in pullback (< 0) — median: -6
- LTF pullback setup present (66.7% of winners)
- HTF improving in lookback (38.9% of winners)
- State transition in lookback (66.7% of winners)

### For SHORT entries (DOWN moves):

- LTF score in pullback (> 0) — median: 4
- LTF pullback setup present (38.6% of winners)
