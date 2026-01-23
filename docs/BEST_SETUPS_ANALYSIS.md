# Best Setups Analysis

Source: `https://timed-trading-ingest.shashant.workers.dev`
Window: last **14** days
Candidates: **event moments** (corridor entry, squeeze, TD9, setup→momentum) deduped by 30m
Generated: 2026-01-23T02:33:14.921Z

## What this is
This report scores which **signals** (events + snapshot rules) best predict a “winner” outcome over forward horizons.
A “winner” means **target% move happens before stop% adverse move** within the horizon window.
Sequence context is included via **time-since-event** and **HTF/LTF delta** features (4h + 1d lookbacks).

## Horizon: 4h
- Baseline win rate: **53.0%** (3392/6406)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Prime-like (snapshot) | 117 | 1.8% | 59.8% | 1.13 | 2.1% |
| Q4 (setup bear) | 173 | 2.7% | 59.0% | 1.11 | 3.0% |
| Pattern: squeeze release → momentum (≤6h) | 856 | 13.4% | 55.3% | 1.04 | 13.9% |
| Squeeze on (event) | 360 | 5.6% | 54.7% | 1.03 | 5.8% |
| Recent squeeze on (≤6h) | 1919 | 30.0% | 54.6% | 1.03 | 30.9% |
| Recent squeeze release (≤6h) | 1589 | 24.8% | 54.1% | 1.02 | 25.4% |
| Pattern: corridor → squeeze on (≤6h) | 598 | 9.3% | 53.7% | 1.01 | 9.5% |
| Pattern: squeeze on → release (≤24h) | 2192 | 34.2% | 53.6% | 1.01 | 34.6% |
| In Corridor (snapshot) | 5433 | 84.8% | 53.5% | 1.01 | 85.7% |
| Recent corridor entry (≤60m) | 5509 | 86.0% | 53.4% | 1.01 | 86.8% |
| HTF improving (dir-aware, 4h) | 3439 | 53.7% | 53.3% | 1.01 | 54.0% |
| Corridor entry (event) | 3584 | 55.9% | 53.3% | 1.01 | 56.3% |

### Top combos (k=2, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 88 | 1.4% | 67.0% | 1.27 | 1.7% |
| Prime-like (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 1.0% | 65.2% | 1.23 | 1.3% |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 80 | 1.2% | 63.7% | 1.20 | 1.5% |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 96 | 1.5% | 62.5% | 1.18 | 1.8% |
| Q4 (setup bear) + LTF improving (dir-aware, 4h) | 68 | 1.1% | 61.8% | 1.17 | 1.2% |
| Prime-like (snapshot) + HTF improving (dir-aware, 1d) | 64 | 1.0% | 60.9% | 1.15 | 1.1% |
| Prime-like (snapshot) + In Corridor (snapshot) | 117 | 1.8% | 59.8% | 1.13 | 2.1% |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 90 | 1.4% | 58.9% | 1.11 | 1.6% |
| Prime-like (snapshot) + Recent squeeze on (≤6h) | 91 | 1.4% | 58.2% | 1.10 | 1.6% |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 158 | 2.5% | 58.2% | 1.10 | 2.7% |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 414 | 6.5% | 58.2% | 1.10 | 7.1% |
| Prime-like (snapshot) + |ΔLTF| ≥ 5 (4h) | 91 | 1.4% | 57.1% | 1.08 | 1.5% |
| Corridor entry (event) + Q4 (setup bear) | 135 | 2.1% | 57.0% | 1.08 | 2.3% |
| Q4 (setup bear) + |ΔHTF| ≥ 5 (4h) | 86 | 1.3% | 57.0% | 1.08 | 1.4% |
| Squeeze on (event) + Recent squeeze release (≤6h) | 158 | 2.5% | 57.0% | 1.08 | 2.7% |

### Top combos (k=3, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Prime-like (snapshot) + Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 57 | 0.9% | 68.4% | 1.29 | 1.1% |
| Prime-like (snapshot) + Recent squeeze on (≤6h) + |ΔHTF| ≥ 5 (4h) | 52 | 0.8% | 67.3% | 1.27 | 1.0% |
| Winner Signature (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 66 | 1.0% | 66.7% | 1.26 | 1.3% |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) + HTF improving (dir-aware, 1d) | 57 | 0.9% | 66.7% | 1.26 | 1.1% |
| In Corridor (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 80 | 1.2% | 66.3% | 1.25 | 1.6% |
| Q4 (setup bear) + Recent corridor entry (≤60m) + HTF improving (dir-aware, 1d) | 82 | 1.3% | 65.9% | 1.24 | 1.6% |
| Corridor entry (event) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 75 | 1.2% | 65.3% | 1.23 | 1.4% |
| Prime-like (snapshot) + In Corridor (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 1.0% | 65.2% | 1.23 | 1.3% |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) + HTF improving (dir-aware, 1d) | 65 | 1.0% | 64.6% | 1.22 | 1.2% |
| Squeeze on (event) + In Corridor (snapshot) + Recent squeeze release (≤6h) | 67 | 1.0% | 64.2% | 1.21 | 1.3% |
| In Corridor (snapshot) + Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 64 | 1.0% | 64.1% | 1.21 | 1.2% |
| Prime-like (snapshot) + Recent corridor entry (≤60m) + HTF improving (dir-aware, 1d) | 55 | 0.9% | 63.6% | 1.20 | 1.0% |
| Q4 (setup bear) + Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) | 71 | 1.1% | 63.4% | 1.20 | 1.3% |
| Prime-like (snapshot) + |ΔHTF| ≥ 5 (4h) + |ΔLTF| ≥ 5 (4h) | 57 | 0.9% | 63.2% | 1.19 | 1.1% |
| Prime-like (snapshot) + In Corridor (snapshot) + Recent corridor entry (≤60m) | 96 | 1.5% | 62.5% | 1.18 | 1.8% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Recent squeeze on (≤6h) | 1919 | 54.6% | 1.03 | 30.9% | 30.9 |
| In Corridor (snapshot) | 5433 | 53.5% | 1.01 | 85.7% | 30.2 |
| Recent corridor entry (≤60m) | 5509 | 53.4% | 1.01 | 86.8% | 26.0 |
| Pattern: squeeze release → momentum (≤6h) | 856 | 55.3% | 1.04 | 13.9% | 19.7 |
| Recent squeeze release (≤6h) | 1589 | 54.1% | 1.02 | 25.4% | 18.6 |
| Pattern: squeeze on → release (≤24h) | 2192 | 53.6% | 1.01 | 34.6% | 13.3 |
| HTF improving (dir-aware, 4h) | 3439 | 53.3% | 1.01 | 54.0% | 12.0 |
| Corridor entry (event) | 3584 | 53.3% | 1.01 | 56.3% | 11.3 |
| Q4 (setup bear) | 173 | 59.0% | 1.11 | 3.0% | 10.4 |
| HTF improving (dir-aware, 1d) | 3486 | 53.2% | 1.00 | 54.7% | 8.2 |
| Prime-like (snapshot) | 117 | 59.8% | 1.13 | 2.1% | 8.0 |
| Squeeze on (event) | 360 | 54.7% | 1.03 | 5.8% | 6.4 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 414 | 58.2% | 1.10 | 7.1% | 21.8 |
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 88 | 67.0% | 1.27 | 1.7% | 12.4 |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 96 | 62.5% | 1.18 | 1.8% | 9.2 |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 80 | 63.7% | 1.20 | 1.5% | 8.6 |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 158 | 58.2% | 1.10 | 2.7% | 8.3 |
| Prime-like (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 65.2% | 1.23 | 1.3% | 8.1 |
| Prime-like (snapshot) + In Corridor (snapshot) | 117 | 59.8% | 1.13 | 2.1% | 8.0 |
| Squeeze on (event) + Recent squeeze release (≤6h) | 158 | 57.0% | 1.08 | 2.7% | 6.3 |
| Q4 (setup bear) + LTF improving (dir-aware, 4h) | 68 | 61.8% | 1.17 | 1.2% | 6.0 |
| Corridor entry (event) + Q4 (setup bear) | 135 | 57.0% | 1.08 | 2.3% | 5.5 |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 90 | 58.9% | 1.11 | 1.6% | 5.3 |
| Prime-like (snapshot) + HTF improving (dir-aware, 1d) | 64 | 60.9% | 1.15 | 1.1% | 5.1 |

#### Combos k=3 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| In Corridor (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 80 | 66.3% | 1.25 | 1.6% | 10.6 |
| Q4 (setup bear) + Recent corridor entry (≤60m) + HTF improving (dir-aware, 1d) | 82 | 65.9% | 1.24 | 1.6% | 10.6 |
| Corridor entry (event) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 75 | 65.3% | 1.23 | 1.4% | 9.3 |
| Prime-like (snapshot) + In Corridor (snapshot) + Recent corridor entry (≤60m) | 96 | 62.5% | 1.18 | 1.8% | 9.2 |
| Winner Signature (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 66 | 66.7% | 1.26 | 1.3% | 9.1 |
| Prime-like (snapshot) + Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 57 | 68.4% | 1.29 | 1.1% | 8.8 |
| Prime-like (snapshot) + In Corridor (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 65.2% | 1.23 | 1.3% | 8.1 |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) + HTF improving (dir-aware, 1d) | 57 | 66.7% | 1.26 | 1.1% | 7.8 |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) + HTF improving (dir-aware, 1d) | 65 | 64.6% | 1.22 | 1.2% | 7.6 |
| Squeeze on (event) + In Corridor (snapshot) + Recent squeeze release (≤6h) | 67 | 64.2% | 1.21 | 1.3% | 7.5 |
| Prime-like (snapshot) + Recent squeeze on (≤6h) + |ΔHTF| ≥ 5 (4h) | 52 | 67.3% | 1.27 | 1.0% | 7.5 |
| Q4 (setup bear) + Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) | 71 | 63.4% | 1.20 | 1.3% | 7.4 |

## Horizon: 1d
- Baseline win rate: **53.4%** (3422/6406)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Prime-like (snapshot) | 117 | 1.8% | 59.8% | 1.12 | 2.0% |
| Q4 (setup bear) | 173 | 2.7% | 59.5% | 1.11 | 3.0% |
| Pattern: squeeze release → momentum (≤6h) | 856 | 13.4% | 55.5% | 1.04 | 13.9% |
| Recent squeeze on (≤6h) | 1919 | 30.0% | 54.8% | 1.03 | 30.7% |
| Squeeze on (event) | 360 | 5.6% | 54.7% | 1.02 | 5.8% |
| Recent squeeze release (≤6h) | 1589 | 24.8% | 54.2% | 1.02 | 25.2% |
| In Corridor (snapshot) | 5433 | 84.8% | 54.0% | 1.01 | 85.7% |
| HTF improving (dir-aware, 4h) | 3439 | 53.7% | 53.9% | 1.01 | 54.1% |
| Recent corridor entry (≤60m) | 5509 | 86.0% | 53.9% | 1.01 | 86.7% |
| Pattern: corridor → squeeze on (≤6h) | 598 | 9.3% | 53.8% | 1.01 | 9.4% |
| HTF improving (dir-aware, 1d) | 3486 | 54.4% | 53.8% | 1.01 | 54.8% |
| Corridor entry (event) | 3584 | 55.9% | 53.8% | 1.01 | 56.3% |

### Top combos (k=2, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 88 | 1.4% | 68.2% | 1.28 | 1.8% |
| Prime-like (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 1.0% | 65.2% | 1.22 | 1.3% |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 80 | 1.2% | 63.7% | 1.19 | 1.5% |
| Q4 (setup bear) + LTF improving (dir-aware, 4h) | 68 | 1.1% | 63.2% | 1.18 | 1.3% |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 96 | 1.5% | 62.5% | 1.17 | 1.8% |
| Prime-like (snapshot) + HTF improving (dir-aware, 1d) | 64 | 1.0% | 60.9% | 1.14 | 1.1% |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 90 | 1.4% | 60.0% | 1.12 | 1.6% |
| Prime-like (snapshot) + In Corridor (snapshot) | 117 | 1.8% | 59.8% | 1.12 | 2.0% |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 158 | 2.5% | 58.9% | 1.10 | 2.7% |
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 414 | 6.5% | 58.7% | 1.10 | 7.1% |
| Prime-like (snapshot) + Recent squeeze on (≤6h) | 91 | 1.4% | 58.2% | 1.09 | 1.5% |
| Q4 (setup bear) + |ΔHTF| ≥ 5 (4h) | 86 | 1.3% | 58.1% | 1.09 | 1.5% |
| Corridor entry (event) + Q4 (setup bear) | 135 | 2.1% | 57.8% | 1.08 | 2.3% |
| In Corridor (snapshot) + Q4 (setup bear) | 148 | 2.3% | 57.4% | 1.08 | 2.5% |
| Prime-like (snapshot) + |ΔLTF| ≥ 5 (4h) | 91 | 1.4% | 57.1% | 1.07 | 1.5% |

### Top combos (k=3, minN=50, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Prime-like (snapshot) + Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 57 | 0.9% | 68.4% | 1.28 | 1.1% |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) + HTF improving (dir-aware, 1d) | 57 | 0.9% | 68.4% | 1.28 | 1.1% |
| Winner Signature (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 66 | 1.0% | 68.2% | 1.28 | 1.3% |
| In Corridor (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 80 | 1.2% | 67.5% | 1.26 | 1.6% |
| Prime-like (snapshot) + Recent squeeze on (≤6h) + |ΔHTF| ≥ 5 (4h) | 52 | 0.8% | 67.3% | 1.26 | 1.0% |
| Q4 (setup bear) + Recent corridor entry (≤60m) + HTF improving (dir-aware, 1d) | 82 | 1.3% | 67.1% | 1.26 | 1.6% |
| Corridor entry (event) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 75 | 1.2% | 66.7% | 1.25 | 1.5% |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) + HTF improving (dir-aware, 1d) | 65 | 1.0% | 66.2% | 1.24 | 1.3% |
| Prime-like (snapshot) + In Corridor (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 1.0% | 65.2% | 1.22 | 1.3% |
| Squeeze on (event) + In Corridor (snapshot) + Recent squeeze release (≤6h) | 67 | 1.0% | 64.2% | 1.20 | 1.3% |
| In Corridor (snapshot) + Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 64 | 1.0% | 64.1% | 1.20 | 1.2% |
| Prime-like (snapshot) + Recent corridor entry (≤60m) + HTF improving (dir-aware, 1d) | 55 | 0.9% | 63.6% | 1.19 | 1.0% |
| Q4 (setup bear) + Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) | 71 | 1.1% | 63.4% | 1.19 | 1.3% |
| Prime-like (snapshot) + |ΔHTF| ≥ 5 (4h) + |ΔLTF| ≥ 5 (4h) | 57 | 0.9% | 63.2% | 1.18 | 1.1% |
| Prime-like (snapshot) + In Corridor (snapshot) + Recent corridor entry (≤60m) | 96 | 1.5% | 62.5% | 1.17 | 1.8% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| In Corridor (snapshot) | 5433 | 54.0% | 1.01 | 85.7% | 30.8 |
| Recent squeeze on (≤6h) | 1919 | 54.8% | 1.03 | 30.7% | 26.9 |
| Recent corridor entry (≤60m) | 5509 | 53.9% | 1.01 | 86.7% | 25.2 |
| Pattern: squeeze release → momentum (≤6h) | 856 | 55.5% | 1.04 | 13.9% | 17.7 |
| HTF improving (dir-aware, 4h) | 3439 | 53.9% | 1.01 | 54.1% | 15.9 |
| Recent squeeze release (≤6h) | 1589 | 54.2% | 1.02 | 25.2% | 13.2 |
| HTF improving (dir-aware, 1d) | 3486 | 53.8% | 1.01 | 54.8% | 12.8 |
| Corridor entry (event) | 3584 | 53.8% | 1.01 | 56.3% | 12.5 |
| Q4 (setup bear) | 173 | 59.5% | 1.11 | 3.0% | 10.6 |
| Prime-like (snapshot) | 117 | 59.8% | 1.12 | 2.0% | 7.5 |
| Pattern: squeeze on → release (≤24h) | 2192 | 53.7% | 1.01 | 34.4% | 7.1 |
| Squeeze on (event) | 360 | 54.7% | 1.02 | 5.8% | 4.7 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Pattern: squeeze release → momentum (≤6h) + |ΔHTF| ≥ 5 (4h) | 414 | 58.7% | 1.10 | 7.1% | 21.8 |
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 88 | 68.2% | 1.28 | 1.8% | 13.0 |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 96 | 62.5% | 1.17 | 1.8% | 8.7 |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 158 | 58.9% | 1.10 | 2.7% | 8.6 |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 80 | 63.7% | 1.19 | 1.5% | 8.3 |
| Prime-like (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 65.2% | 1.22 | 1.3% | 7.7 |
| Prime-like (snapshot) + In Corridor (snapshot) | 117 | 59.8% | 1.12 | 2.0% | 7.5 |
| Q4 (setup bear) + LTF improving (dir-aware, 4h) | 68 | 63.2% | 1.18 | 1.3% | 6.7 |
| In Corridor (snapshot) + Q4 (setup bear) | 148 | 57.4% | 1.08 | 2.5% | 5.9 |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 90 | 60.0% | 1.12 | 1.6% | 5.9 |
| Corridor entry (event) + Q4 (setup bear) | 135 | 57.8% | 1.08 | 2.3% | 5.9 |
| Prime-like (snapshot) + HTF improving (dir-aware, 1d) | 64 | 60.9% | 1.14 | 1.1% | 4.8 |

#### Combos k=3 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| In Corridor (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 80 | 67.5% | 1.26 | 1.6% | 11.3 |
| Q4 (setup bear) + Recent corridor entry (≤60m) + HTF improving (dir-aware, 1d) | 82 | 67.1% | 1.26 | 1.6% | 11.2 |
| Corridor entry (event) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 75 | 66.7% | 1.25 | 1.5% | 9.9 |
| Winner Signature (snapshot) + Q4 (setup bear) + HTF improving (dir-aware, 1d) | 66 | 68.2% | 1.28 | 1.3% | 9.7 |
| Prime-like (snapshot) + In Corridor (snapshot) + Recent corridor entry (≤60m) | 96 | 62.5% | 1.17 | 1.8% | 8.7 |
| Prime-like (snapshot) + Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 57 | 68.4% | 1.28 | 1.1% | 8.6 |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) + HTF improving (dir-aware, 1d) | 57 | 68.4% | 1.28 | 1.1% | 8.6 |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) + HTF improving (dir-aware, 1d) | 65 | 66.2% | 1.24 | 1.3% | 8.3 |
| Prime-like (snapshot) + In Corridor (snapshot) + |ΔHTF| ≥ 5 (4h) | 66 | 65.2% | 1.22 | 1.3% | 7.7 |
| Prime-like (snapshot) + Recent squeeze on (≤6h) + |ΔHTF| ≥ 5 (4h) | 52 | 67.3% | 1.26 | 1.0% | 7.2 |
| Squeeze on (event) + In Corridor (snapshot) + Recent squeeze release (≤6h) | 67 | 64.2% | 1.20 | 1.3% | 7.2 |
| Q4 (setup bear) + Recent corridor entry (≤60m) + Pattern: squeeze on → release (≤24h) | 71 | 63.4% | 1.19 | 1.3% | 7.1 |

## Notes / Next upgrades
- Add richer **sequence mining** (multi-event combos, e.g. corridor entry → squeeze on → release within (X) hours).
- Add **trade-relative labels** (+1R/+2R before -1R) once SL/entry reference fields are consistently available in trail points.
- Once we have more history, train a lightweight model to output a **win probability** and drive a “Best Setups” tag in the UI.
