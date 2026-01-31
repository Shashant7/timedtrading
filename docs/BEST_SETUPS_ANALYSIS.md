# Best Setups Analysis

Source: `https://timed-trading-ingest.shashant.workers.dev`
Window: last **14** days
Candidates: **event moments** (corridor entry, squeeze, TD9, setup→momentum) deduped by 30m
Generated: 2026-01-30T21:36:05.040Z

## What this is
This report scores which **signals** (events + snapshot rules) best predict a “winner” outcome over forward horizons.
A “winner” means **target% move happens before stop% adverse move** within the horizon window.
Sequence context is included via **time-since-event** and **HTF/LTF delta** features (4h + 1d lookbacks).

## Horizon: 4h
- Baseline win rate: **52.1%** (4163/7994)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) | 267 | 3.3% | 59.6% | 1.14 | 3.8% |
| Prime-like (snapshot) | 159 | 2.0% | 54.1% | 1.04 | 2.1% |
| Corridor entry (event) | 4302 | 53.8% | 53.0% | 1.02 | 54.8% |
| Pattern: squeeze on → release (≤24h) | 3170 | 39.7% | 52.7% | 1.01 | 40.2% |
| HTF improving (dir-aware, 1d) | 4182 | 52.3% | 52.7% | 1.01 | 52.9% |
| In Corridor (snapshot) | 6597 | 82.5% | 52.4% | 1.01 | 83.1% |
| Recent corridor entry (≤60m) | 6893 | 86.2% | 52.3% | 1.00 | 86.6% |
| HTF improving (dir-aware, 4h) | 4155 | 52.0% | 52.3% | 1.00 | 52.2% |
| Pattern: corridor → squeeze release (≤24h) | 720 | 9.0% | 52.2% | 1.00 | 9.0% |
| Recent squeeze release (≤6h) | 2255 | 28.2% | 52.1% | 1.00 | 28.2% |
| |ΔHTF| ≥ 5 (4h) | 3993 | 49.9% | 51.9% | 1.00 | 49.8% |
| Squeeze on (event) | 500 | 6.3% | 51.8% | 0.99 | 6.2% |

### Top combos (k=2, minN=75, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 151 | 1.9% | 60.9% | 1.17 | 2.2% |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 108 | 1.4% | 60.2% | 1.16 | 1.6% |
| Winner Signature (snapshot) + Q4 (setup bear) | 123 | 1.5% | 60.2% | 1.16 | 1.8% |
| Corridor entry (event) + Q4 (setup bear) | 204 | 2.6% | 58.8% | 1.13 | 2.9% |
| In Corridor (snapshot) + Q4 (setup bear) | 225 | 2.8% | 58.7% | 1.13 | 3.2% |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 244 | 3.1% | 58.6% | 1.13 | 3.4% |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) | 202 | 2.5% | 58.4% | 1.12 | 2.8% |
| Q4 (setup bear) + |ΔHTF| ≥ 5 (4h) | 123 | 1.5% | 57.7% | 1.11 | 1.7% |
| Prime-like (snapshot) + Recent squeeze on (≤6h) | 115 | 1.4% | 57.4% | 1.10 | 1.6% |
| Q4 (setup bear) + Recent squeeze on (≤6h) | 97 | 1.2% | 56.7% | 1.09 | 1.3% |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 135 | 1.7% | 56.3% | 1.08 | 1.8% |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 155 | 1.9% | 56.1% | 1.08 | 2.1% |
| Prime-like (snapshot) + HTF improving (dir-aware, 1d) | 86 | 1.1% | 55.8% | 1.07 | 1.2% |
| Q4 (setup bear) + LTF improving (dir-aware, 4h) | 106 | 1.3% | 55.7% | 1.07 | 1.4% |
| Squeeze on (event) + Recent squeeze release (≤6h) | 249 | 3.1% | 55.0% | 1.06 | 3.3% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Corridor entry (event) | 4302 | 53.0% | 1.02 | 54.8% | 39.7 |
| In Corridor (snapshot) | 6597 | 52.4% | 1.01 | 83.1% | 24.5 |
| HTF improving (dir-aware, 1d) | 4182 | 52.7% | 1.01 | 52.9% | 24.2 |
| Pattern: squeeze on → release (≤24h) | 3170 | 52.7% | 1.01 | 40.2% | 21.2 |
| Q4 (setup bear) | 267 | 59.6% | 1.14 | 3.8% | 20.0 |
| Recent corridor entry (≤60m) | 6893 | 52.3% | 1.00 | 86.6% | 16.4 |
| HTF improving (dir-aware, 4h) | 4155 | 52.3% | 1.00 | 52.2% | 9.2 |
| Prime-like (snapshot) | 159 | 54.1% | 1.04 | 2.1% | 3.2 |
| Pattern: corridor → squeeze release (≤24h) | 720 | 52.2% | 1.00 | 9.0% | 1.0 |
| Recent squeeze release (≤6h) | 2255 | 52.1% | 1.00 | 28.2% | 0.7 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) + Recent corridor entry (≤60m) | 244 | 58.6% | 1.13 | 3.4% | 15.9 |
| In Corridor (snapshot) + Q4 (setup bear) | 225 | 58.7% | 1.13 | 3.2% | 14.8 |
| Corridor entry (event) + Q4 (setup bear) | 204 | 58.8% | 1.13 | 2.9% | 13.8 |
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 151 | 60.9% | 1.17 | 2.2% | 13.4 |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) | 202 | 58.4% | 1.12 | 2.8% | 12.8 |
| Winner Signature (snapshot) + Q4 (setup bear) | 123 | 60.2% | 1.16 | 1.8% | 9.9 |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 108 | 60.2% | 1.16 | 1.6% | 8.8 |
| Squeeze on (event) + Recent squeeze release (≤6h) | 249 | 55.0% | 1.06 | 3.3% | 7.3 |
| Q4 (setup bear) + |ΔHTF| ≥ 5 (4h) | 123 | 57.7% | 1.11 | 1.7% | 6.9 |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 155 | 56.1% | 1.08 | 2.1% | 6.3 |
| Prime-like (snapshot) + Recent squeeze on (≤6h) | 115 | 57.4% | 1.10 | 1.6% | 6.1 |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 135 | 56.3% | 1.08 | 1.8% | 5.7 |

## Horizon: 1d
- Baseline win rate: **52.2%** (4174/7994)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) | 267 | 3.3% | 59.6% | 1.14 | 3.8% |
| Prime-like (snapshot) | 159 | 2.0% | 54.1% | 1.04 | 2.1% |
| Corridor entry (event) | 4302 | 53.8% | 53.1% | 1.02 | 54.7% |
| Pattern: squeeze on → release (≤24h) | 3170 | 39.7% | 52.9% | 1.01 | 40.2% |
| HTF improving (dir-aware, 1d) | 4182 | 52.3% | 52.9% | 1.01 | 53.0% |
| In Corridor (snapshot) | 6597 | 82.5% | 52.6% | 1.01 | 83.1% |
| Recent corridor entry (≤60m) | 6893 | 86.2% | 52.4% | 1.00 | 86.6% |
| HTF improving (dir-aware, 4h) | 4155 | 52.0% | 52.4% | 1.00 | 52.2% |
| Pattern: corridor → squeeze release (≤24h) | 720 | 9.0% | 52.2% | 1.00 | 9.0% |
| Squeeze on (event) | 500 | 6.3% | 52.2% | 1.00 | 6.3% |
| Recent squeeze release (≤6h) | 2255 | 28.2% | 52.2% | 1.00 | 28.2% |
| |ΔHTF| ≥ 5 (4h) | 3993 | 49.9% | 52.0% | 1.00 | 49.8% |

### Top combos (k=2, minN=75, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 151 | 1.9% | 60.9% | 1.17 | 2.2% |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 108 | 1.4% | 60.2% | 1.15 | 1.6% |
| Winner Signature (snapshot) + Q4 (setup bear) | 123 | 1.5% | 60.2% | 1.15 | 1.8% |
| Corridor entry (event) + Q4 (setup bear) | 204 | 2.6% | 58.8% | 1.13 | 2.9% |
| In Corridor (snapshot) + Q4 (setup bear) | 225 | 2.8% | 58.7% | 1.12 | 3.2% |
| Q4 (setup bear) + Recent corridor entry (≤60m) | 244 | 3.1% | 58.6% | 1.12 | 3.4% |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) | 202 | 2.5% | 58.4% | 1.12 | 2.8% |
| Q4 (setup bear) + |ΔHTF| ≥ 5 (4h) | 123 | 1.5% | 57.7% | 1.11 | 1.7% |
| Prime-like (snapshot) + Recent squeeze on (≤6h) | 115 | 1.4% | 57.4% | 1.10 | 1.6% |
| Q4 (setup bear) + Recent squeeze on (≤6h) | 97 | 1.2% | 56.7% | 1.09 | 1.3% |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 135 | 1.7% | 56.3% | 1.08 | 1.8% |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 155 | 1.9% | 56.1% | 1.07 | 2.1% |
| Prime-like (snapshot) + HTF improving (dir-aware, 1d) | 86 | 1.1% | 55.8% | 1.07 | 1.1% |
| Q4 (setup bear) + LTF improving (dir-aware, 4h) | 106 | 1.3% | 55.7% | 1.07 | 1.4% |
| Squeeze on (event) + Recent squeeze release (≤6h) | 249 | 3.1% | 55.4% | 1.06 | 3.3% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Corridor entry (event) | 4302 | 53.1% | 1.02 | 54.7% | 37.7 |
| HTF improving (dir-aware, 1d) | 4182 | 52.9% | 1.01 | 53.0% | 27.4 |
| In Corridor (snapshot) | 6597 | 52.6% | 1.01 | 83.1% | 24.4 |
| Pattern: squeeze on → release (≤24h) | 3170 | 52.9% | 1.01 | 40.2% | 21.8 |
| Q4 (setup bear) | 267 | 59.6% | 1.14 | 3.8% | 19.6 |
| Recent corridor entry (≤60m) | 6893 | 52.4% | 1.00 | 86.6% | 15.9 |
| HTF improving (dir-aware, 4h) | 4155 | 52.4% | 1.00 | 52.2% | 9.5 |
| Prime-like (snapshot) | 159 | 54.1% | 1.04 | 2.1% | 3.0 |
| Pattern: corridor → squeeze release (≤24h) | 720 | 52.2% | 1.00 | 9.0% | 0.1 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) + Recent corridor entry (≤60m) | 244 | 58.6% | 1.12 | 3.4% | 15.6 |
| In Corridor (snapshot) + Q4 (setup bear) | 225 | 58.7% | 1.12 | 3.2% | 14.5 |
| Corridor entry (event) + Q4 (setup bear) | 204 | 58.8% | 1.13 | 2.9% | 13.5 |
| Q4 (setup bear) + HTF improving (dir-aware, 1d) | 151 | 60.9% | 1.17 | 2.2% | 13.2 |
| Q4 (setup bear) + |ΔLTF| ≥ 5 (4h) | 202 | 58.4% | 1.12 | 2.8% | 12.5 |
| Winner Signature (snapshot) + Q4 (setup bear) | 123 | 60.2% | 1.15 | 1.8% | 9.8 |
| Q4 (setup bear) + Pattern: squeeze on → release (≤24h) | 108 | 60.2% | 1.15 | 1.6% | 8.6 |
| Squeeze on (event) + Recent squeeze release (≤6h) | 249 | 55.4% | 1.06 | 3.3% | 8.0 |
| Q4 (setup bear) + |ΔHTF| ≥ 5 (4h) | 123 | 57.7% | 1.11 | 1.7% | 6.8 |
| Q4 (setup bear) + HTF improving (dir-aware, 4h) | 155 | 56.1% | 1.07 | 2.1% | 6.1 |
| Prime-like (snapshot) + Recent squeeze on (≤6h) | 115 | 57.4% | 1.10 | 1.6% | 6.0 |
| Prime-like (snapshot) + Recent corridor entry (≤60m) | 135 | 56.3% | 1.08 | 1.8% | 5.5 |

## Notes / Next upgrades
- Add richer **sequence mining** (multi-event combos, e.g. corridor entry → squeeze on → release within (X) hours).
- Add **trade-relative labels** (+1R/+2R before -1R) once SL/entry reference fields are consistently available in trail points.
- Once we have more history, train a lightweight model to output a **win probability** and drive a “Best Setups” tag in the UI.
