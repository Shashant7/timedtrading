# Best Setups Analysis

Source: `https://timed-trading-ingest.shashant.workers.dev`
Window: last **180** days
Candidates: **event moments** (corridor entry, squeeze, TD9, setup→momentum) deduped by 30m
Generated: 2026-01-19T19:37:35.504Z

## What this is
This report scores which **signals** (events + snapshot rules) best predict a “winner” outcome over forward horizons.
A “winner” means **target% move happens before stop% adverse move** within the horizon window.
Sequence context is included via **time-since-event** and **HTF/LTF delta** features (4h + 1d lookbacks).

## Horizon: 4h
- Baseline win rate: **52.7%** (1238/2348)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Pattern: squeeze release → momentum (≤6h) | 198 | 8.4% | 59.1% | 1.12 | 9.5% |
| Squeeze on (event) | 146 | 6.2% | 58.9% | 1.12 | 6.9% |
| Q4 (setup bear) | 68 | 2.9% | 58.8% | 1.12 | 3.2% |
| Pattern: corridor → squeeze on (≤6h) | 231 | 9.8% | 58.4% | 1.11 | 10.9% |
| Prime-like (snapshot) | 47 | 2.0% | 57.4% | 1.09 | 2.2% |
| Recent squeeze on (≤6h) | 735 | 31.3% | 57.4% | 1.09 | 34.1% |
| Recent squeeze release (≤6h) | 428 | 18.2% | 57.2% | 1.09 | 19.8% |
| Squeeze release (event) | 75 | 3.2% | 56.0% | 1.06 | 3.4% |
| Pattern: squeeze on → release (≤24h) | 401 | 17.1% | 55.6% | 1.05 | 18.0% |
| Corridor entry (event) | 1301 | 55.4% | 54.0% | 1.02 | 56.7% |
| Recent corridor entry (≤60m) | 1950 | 83.0% | 53.4% | 1.01 | 84.2% |
| In Corridor (snapshot) | 1964 | 83.6% | 53.2% | 1.01 | 84.4% |

### Top combos (k=2, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 98 | 4.2% | 65.3% | 1.24 | 5.2% |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze release (≤24h) | 59 | 2.5% | 64.4% | 1.22 | 3.1% |
| Squeeze on (event) + LTF improving (dir-aware, 4h) | 61 | 2.6% | 63.9% | 1.21 | 3.2% |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) | 142 | 6.0% | 63.4% | 1.20 | 7.3% |
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 120 | 5.1% | 63.3% | 1.20 | 6.1% |
| Squeeze on (event) + |ΔLTF| ≥ 5 (4h) | 100 | 4.3% | 62.0% | 1.18 | 5.0% |
| Setup → Momentum (event) + Recent squeeze release (≤6h) | 90 | 3.8% | 61.1% | 1.16 | 4.4% |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) | 90 | 3.8% | 61.1% | 1.16 | 4.4% |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 174 | 7.4% | 60.9% | 1.16 | 8.6% |
| Squeeze on (event) + In Corridor (snapshot) | 66 | 2.8% | 60.6% | 1.15 | 3.2% |
| Squeeze on (event) + Pattern: corridor → squeeze on (≤6h) | 124 | 5.3% | 60.5% | 1.15 | 6.1% |
| Squeeze on (event) + Recent corridor entry (≤60m) | 91 | 3.9% | 60.4% | 1.15 | 4.4% |
| Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 169 | 7.2% | 60.4% | 1.14 | 8.2% |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 60 | 2.6% | 60.0% | 1.14 | 2.9% |
| In Corridor (snapshot) + Pattern: corridor → squeeze on (≤6h) | 126 | 5.4% | 59.5% | 1.13 | 6.1% |

### Top combos (k=3, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 57 | 2.4% | 71.9% | 1.36 | 3.3% |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 88 | 3.7% | 67.0% | 1.27 | 4.8% |
| Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 100 | 4.3% | 67.0% | 1.27 | 5.4% |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Recent squeeze release (≤6h) | 69 | 2.9% | 66.7% | 1.26 | 3.7% |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 69 | 2.9% | 66.7% | 1.26 | 3.7% |
| Pattern: squeeze release → momentum (≤6h) + HTF + LTF improving (dir-aware, 4h) + HTF improving (dir-aware, 1d) | 57 | 2.4% | 66.7% | 1.26 | 3.1% |
| Recent corridor entry (≤60m) + Recent squeeze on (≤6h) + Pattern: corridor → squeeze release (≤24h) | 51 | 2.2% | 66.7% | 1.26 | 2.7% |
| Setup → Momentum (event) + Recent squeeze release (≤6h) + HTF improving (dir-aware, 4h) | 65 | 2.8% | 66.2% | 1.25 | 3.5% |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) | 65 | 2.8% | 66.2% | 1.25 | 3.5% |
| Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) + |ΔHTF| ≥ 5 (4h) | 73 | 3.1% | 65.8% | 1.25 | 3.9% |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) + |ΔLTF| ≥ 5 (4h) | 73 | 3.1% | 65.8% | 1.25 | 3.9% |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 105 | 4.5% | 65.7% | 1.25 | 5.6% |
| Pattern: corridor → squeeze on (≤6h) + LTF improving (dir-aware, 4h) + |ΔLTF| ≥ 5 (4h) | 70 | 3.0% | 65.7% | 1.25 | 3.7% |
| In Corridor (snapshot) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 93 | 4.0% | 65.6% | 1.24 | 4.9% |
| Pattern: squeeze release → momentum (≤6h) + LTF improving (dir-aware, 4h) + |ΔHTF| ≥ 5 (4h) | 61 | 2.6% | 65.6% | 1.24 | 3.2% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Recent squeeze on (≤6h) | 735 | 57.4% | 1.09 | 34.1% | 34.5 |
| Recent squeeze release (≤6h) | 428 | 57.2% | 1.09 | 19.8% | 19.3 |
| Corridor entry (event) | 1301 | 54.0% | 1.02 | 56.7% | 16.0 |
| Recent corridor entry (≤60m) | 1950 | 53.4% | 1.01 | 84.2% | 13.8 |
| Pattern: corridor → squeeze on (≤6h) | 231 | 58.4% | 1.11 | 10.9% | 13.2 |
| Pattern: squeeze release → momentum (≤6h) | 198 | 59.1% | 1.12 | 9.5% | 12.6 |
| Pattern: squeeze on → release (≤24h) | 401 | 55.6% | 1.05 | 18.0% | 11.6 |
| In Corridor (snapshot) | 1964 | 53.2% | 1.01 | 84.4% | 9.5 |
| Squeeze on (event) | 146 | 58.9% | 1.12 | 6.9% | 9.0 |
| |ΔLTF| ≥ 5 (4h) | 1640 | 53.0% | 1.00 | 70.2% | 4.3 |
| Q4 (setup bear) | 68 | 58.8% | 1.12 | 3.2% | 4.1 |
| Squeeze release (event) | 75 | 56.0% | 1.06 | 3.4% | 2.5 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) | 142 | 63.4% | 1.20 | 7.3% | 15.1 |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 174 | 60.9% | 1.16 | 8.6% | 14.3 |
| Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 169 | 60.4% | 1.14 | 8.2% | 12.9 |
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 120 | 63.3% | 1.20 | 6.1% | 12.7 |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 98 | 65.3% | 1.24 | 5.2% | 12.3 |
| Squeeze on (event) + Pattern: corridor → squeeze on (≤6h) | 124 | 60.5% | 1.15 | 6.1% | 9.6 |
| Squeeze on (event) + |ΔLTF| ≥ 5 (4h) | 100 | 62.0% | 1.18 | 5.0% | 9.3 |
| In Corridor (snapshot) + Pattern: corridor → squeeze on (≤6h) | 126 | 59.5% | 1.13 | 6.1% | 8.6 |
| Setup → Momentum (event) + Recent squeeze release (≤6h) | 90 | 61.1% | 1.16 | 4.4% | 7.5 |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) | 90 | 61.1% | 1.16 | 4.4% | 7.5 |
| Squeeze on (event) + Recent corridor entry (≤60m) | 91 | 60.4% | 1.15 | 4.4% | 7.0 |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze release (≤24h) | 59 | 64.4% | 1.22 | 3.1% | 6.9 |

#### Combos k=3 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 100 | 67.0% | 1.27 | 5.4% | 14.3 |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 105 | 65.7% | 1.25 | 5.6% | 13.6 |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 88 | 67.0% | 1.27 | 4.8% | 12.6 |
| In Corridor (snapshot) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 93 | 65.6% | 1.24 | 4.9% | 12.0 |
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 57 | 71.9% | 1.36 | 3.3% | 10.9 |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Recent squeeze release (≤6h) | 69 | 66.7% | 1.26 | 3.7% | 9.6 |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 69 | 66.7% | 1.26 | 3.7% | 9.6 |
| Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) + |ΔHTF| ≥ 5 (4h) | 73 | 65.8% | 1.25 | 3.9% | 9.5 |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) + |ΔLTF| ≥ 5 (4h) | 73 | 65.8% | 1.25 | 3.9% | 9.5 |
| Pattern: corridor → squeeze on (≤6h) + LTF improving (dir-aware, 4h) + |ΔLTF| ≥ 5 (4h) | 70 | 65.7% | 1.25 | 3.7% | 9.1 |
| Setup → Momentum (event) + Recent squeeze release (≤6h) + HTF improving (dir-aware, 4h) | 65 | 66.2% | 1.25 | 3.5% | 8.7 |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) | 65 | 66.2% | 1.25 | 3.5% | 8.7 |

## Horizon: 1d
- Baseline win rate: **53.7%** (1262/2348)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) | 68 | 2.9% | 60.3% | 1.12 | 3.2% |
| Pattern: squeeze release → momentum (≤6h) | 198 | 8.4% | 59.1% | 1.10 | 9.3% |
| Squeeze on (event) | 146 | 6.2% | 58.9% | 1.10 | 6.8% |
| Pattern: corridor → squeeze on (≤6h) | 231 | 9.8% | 58.9% | 1.10 | 10.8% |
| Recent squeeze on (≤6h) | 735 | 31.3% | 57.8% | 1.08 | 33.7% |
| Recent squeeze release (≤6h) | 428 | 18.2% | 57.5% | 1.07 | 19.5% |
| Prime-like (snapshot) | 47 | 2.0% | 57.4% | 1.07 | 2.1% |
| Squeeze release (event) | 75 | 3.2% | 57.3% | 1.07 | 3.4% |
| Pattern: squeeze on → release (≤24h) | 401 | 17.1% | 55.9% | 1.04 | 17.7% |
| Corridor entry (event) | 1301 | 55.4% | 55.1% | 1.03 | 56.8% |
| Recent corridor entry (≤60m) | 1950 | 83.0% | 54.5% | 1.01 | 84.2% |
| In Corridor (snapshot) | 1964 | 83.6% | 54.2% | 1.01 | 84.4% |

### Top combos (k=2, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 98 | 4.2% | 65.3% | 1.22 | 5.1% |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze release (≤24h) | 59 | 2.5% | 64.4% | 1.20 | 3.0% |
| Squeeze on (event) + LTF improving (dir-aware, 4h) | 61 | 2.6% | 63.9% | 1.19 | 3.1% |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) | 142 | 6.0% | 63.4% | 1.18 | 7.1% |
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 120 | 5.1% | 63.3% | 1.18 | 6.0% |
| Squeeze on (event) + |ΔLTF| ≥ 5 (4h) | 100 | 4.3% | 62.0% | 1.15 | 4.9% |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 60 | 2.6% | 61.7% | 1.15 | 2.9% |
| Setup → Momentum (event) + Recent squeeze release (≤6h) | 90 | 3.8% | 61.1% | 1.14 | 4.4% |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) | 90 | 3.8% | 61.1% | 1.14 | 4.4% |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 174 | 7.4% | 60.9% | 1.13 | 8.4% |
| Q1 (setup bull) + Pattern: corridor → squeeze release (≤24h) | 56 | 2.4% | 60.7% | 1.13 | 2.7% |
| Squeeze on (event) + In Corridor (snapshot) | 66 | 2.8% | 60.6% | 1.13 | 3.2% |
| Squeeze on (event) + Pattern: corridor → squeeze on (≤6h) | 124 | 5.3% | 60.5% | 1.13 | 5.9% |
| Squeeze on (event) + Recent corridor entry (≤60m) | 91 | 3.9% | 60.4% | 1.12 | 4.4% |
| Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 169 | 7.2% | 60.4% | 1.12 | 8.1% |

### Top combos (k=3, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 57 | 2.4% | 71.9% | 1.34 | 3.2% |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 88 | 3.7% | 67.0% | 1.25 | 4.7% |
| Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 100 | 4.3% | 67.0% | 1.25 | 5.3% |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Recent squeeze release (≤6h) | 69 | 2.9% | 66.7% | 1.24 | 3.6% |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 69 | 2.9% | 66.7% | 1.24 | 3.6% |
| Pattern: squeeze release → momentum (≤6h) + HTF + LTF improving (dir-aware, 4h) + HTF improving (dir-aware, 1d) | 57 | 2.4% | 66.7% | 1.24 | 3.0% |
| Recent corridor entry (≤60m) + Recent squeeze on (≤6h) + Pattern: corridor → squeeze release (≤24h) | 51 | 2.2% | 66.7% | 1.24 | 2.7% |
| Setup → Momentum (event) + Recent squeeze release (≤6h) + HTF improving (dir-aware, 4h) | 65 | 2.8% | 66.2% | 1.23 | 3.4% |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) | 65 | 2.8% | 66.2% | 1.23 | 3.4% |
| Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) + |ΔHTF| ≥ 5 (4h) | 73 | 3.1% | 65.8% | 1.22 | 3.8% |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) + |ΔLTF| ≥ 5 (4h) | 73 | 3.1% | 65.8% | 1.22 | 3.8% |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 105 | 4.5% | 65.7% | 1.22 | 5.5% |
| Pattern: corridor → squeeze on (≤6h) + LTF improving (dir-aware, 4h) + |ΔLTF| ≥ 5 (4h) | 70 | 3.0% | 65.7% | 1.22 | 3.6% |
| In Corridor (snapshot) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 93 | 4.0% | 65.6% | 1.22 | 4.8% |
| Pattern: squeeze release → momentum (≤6h) + LTF improving (dir-aware, 4h) + |ΔHTF| ≥ 5 (4h) | 61 | 2.6% | 65.6% | 1.22 | 3.2% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Recent squeeze on (≤6h) | 735 | 57.8% | 1.08 | 33.7% | 30.0 |
| Corridor entry (event) | 1301 | 55.1% | 1.03 | 56.8% | 17.7 |
| Recent squeeze release (≤6h) | 428 | 57.5% | 1.07 | 19.5% | 16.0 |
| Recent corridor entry (≤60m) | 1950 | 54.5% | 1.01 | 84.2% | 13.9 |
| Pattern: corridor → squeeze on (≤6h) | 231 | 58.9% | 1.10 | 10.8% | 11.8 |
| Pattern: squeeze release → momentum (≤6h) | 198 | 59.1% | 1.10 | 9.3% | 10.6 |
| In Corridor (snapshot) | 1964 | 54.2% | 1.01 | 84.4% | 9.4 |
| Pattern: squeeze on → release (≤24h) | 401 | 55.9% | 1.04 | 17.7% | 8.5 |
| Squeeze on (event) | 146 | 58.9% | 1.10 | 6.8% | 7.5 |
| |ΔLTF| ≥ 5 (4h) | 1640 | 54.1% | 1.01 | 70.4% | 6.5 |
| Q4 (setup bear) | 68 | 60.3% | 1.12 | 3.2% | 4.5 |
| Squeeze release (event) | 75 | 57.3% | 1.07 | 3.4% | 2.7 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) | 142 | 63.4% | 1.18 | 7.1% | 13.7 |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 174 | 60.9% | 1.13 | 8.4% | 12.5 |
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 120 | 63.3% | 1.18 | 6.0% | 11.5 |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 98 | 65.3% | 1.22 | 5.1% | 11.3 |
| Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 169 | 60.4% | 1.12 | 8.1% | 11.2 |
| Squeeze on (event) + Pattern: corridor → squeeze on (≤6h) | 124 | 60.5% | 1.13 | 5.9% | 8.4 |
| Squeeze on (event) + |ΔLTF| ≥ 5 (4h) | 100 | 62.0% | 1.15 | 4.9% | 8.3 |
| Setup → Momentum (event) + Recent squeeze release (≤6h) | 90 | 61.1% | 1.14 | 4.4% | 6.6 |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) | 90 | 61.1% | 1.14 | 4.4% | 6.6 |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze release (≤24h) | 59 | 64.4% | 1.20 | 3.0% | 6.3 |
| Squeeze on (event) + LTF improving (dir-aware, 4h) | 61 | 63.9% | 1.19 | 3.1% | 6.2 |
| Squeeze on (event) + Recent corridor entry (≤60m) | 91 | 60.4% | 1.12 | 4.4% | 6.1 |

#### Combos k=3 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) | 100 | 67.0% | 1.25 | 5.3% | 13.3 |
| Recent corridor entry (≤60m) + Pattern: corridor → squeeze on (≤6h) + |ΔLTF| ≥ 5 (4h) | 105 | 65.7% | 1.22 | 5.5% | 12.6 |
| Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 88 | 67.0% | 1.25 | 4.7% | 11.7 |
| In Corridor (snapshot) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 93 | 65.6% | 1.22 | 4.8% | 11.0 |
| Pattern: squeeze on → release (≤24h) + Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 57 | 71.9% | 1.34 | 3.2% | 10.4 |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Recent squeeze release (≤6h) | 69 | 66.7% | 1.24 | 3.6% | 8.9 |
| Setup → Momentum (event) + Recent corridor entry (≤60m) + Pattern: squeeze release → momentum (≤6h) | 69 | 66.7% | 1.24 | 3.6% | 8.9 |
| Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) + |ΔHTF| ≥ 5 (4h) | 73 | 65.8% | 1.22 | 3.8% | 8.8 |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) + |ΔLTF| ≥ 5 (4h) | 73 | 65.8% | 1.22 | 3.8% | 8.8 |
| Pattern: corridor → squeeze on (≤6h) + LTF improving (dir-aware, 4h) + |ΔLTF| ≥ 5 (4h) | 70 | 65.7% | 1.22 | 3.6% | 8.4 |
| Setup → Momentum (event) + Recent squeeze release (≤6h) + HTF improving (dir-aware, 4h) | 65 | 66.2% | 1.23 | 3.4% | 8.1 |
| Setup → Momentum (event) + Pattern: squeeze release → momentum (≤6h) + HTF improving (dir-aware, 4h) | 65 | 66.2% | 1.23 | 3.4% | 8.1 |

## Notes / Next upgrades
- Add richer **sequence mining** (multi-event combos, e.g. corridor entry → squeeze on → release within (X) hours).
- Add **trade-relative labels** (+1R/+2R before -1R) once SL/entry reference fields are consistently available in trail points.
- Once we have more history, train a lightweight model to output a **win probability** and drive a “Best Setups” tag in the UI.
