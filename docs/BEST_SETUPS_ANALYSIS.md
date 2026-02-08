# Best Setups Analysis

Source: `https://timed-trading-ingest.shashant.workers.dev`
Window: last **5** days
Candidates: **event moments** (corridor entry, squeeze, TD9, setup→momentum) deduped by 30m
Generated: 2026-02-06T19:00:04.306Z

## What this is
This report scores which **signals** (events + snapshot rules) best predict a “winner” outcome over forward horizons.
A “winner” means **target% move happens before stop% adverse move** within the horizon window.
Sequence context is included via **time-since-event** and **HTF/LTF delta** features (4h + 1d lookbacks).

## Horizon: 4h
- Baseline win rate: **46.9%** (349/744)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) | 27 | 3.6% | 51.9% | 1.11 | 4.0% |
| Q1 (setup bull) | 233 | 31.3% | 51.5% | 1.10 | 34.4% |
| Corridor entry (event) | 400 | 53.8% | 50.0% | 1.07 | 57.3% |
| Squeeze release (event) | 25 | 3.4% | 48.0% | 1.02 | 3.4% |
| LTF improving (dir-aware, 4h) | 368 | 49.5% | 47.8% | 1.02 | 50.4% |
| |ΔHTF| ≥ 5 (4h) | 379 | 50.9% | 47.5% | 1.01 | 51.6% |
| Recent corridor entry (≤60m) | 618 | 83.1% | 47.4% | 1.01 | 84.0% |
| Pattern: corridor → squeeze on (≤6h) | 51 | 6.9% | 47.1% | 1.00 | 6.9% |
| In Corridor (snapshot) | 665 | 89.4% | 46.9% | 1.00 | 89.4% |
| Pattern: squeeze on → release (≤24h) | 63 | 8.5% | 46.0% | 0.98 | 8.3% |
| HTF + LTF improving (dir-aware, 4h) | 213 | 28.6% | 46.0% | 0.98 | 28.1% |
| |ΔLTF| ≥ 5 (4h) | 487 | 65.5% | 45.6% | 0.97 | 63.6% |

### Top combos (k=2, minN=75, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q1 (setup bull) + |ΔHTF| ≥ 5 (4h) | 127 | 17.1% | 57.5% | 1.23 | 20.9% |
| Q1 (setup bull) + LTF improving (dir-aware, 4h) | 116 | 15.6% | 56.9% | 1.21 | 18.9% |
| Corridor entry (event) + Q1 (setup bull) | 199 | 26.7% | 53.3% | 1.14 | 30.4% |
| Corridor entry (event) + LTF improving (dir-aware, 4h) | 170 | 22.8% | 52.9% | 1.13 | 25.8% |
| Q1 (setup bull) + Recent corridor entry (≤60m) | 216 | 29.0% | 52.3% | 1.12 | 32.4% |
| Corridor entry (event) + |ΔHTF| ≥ 5 (4h) | 222 | 29.8% | 52.3% | 1.11 | 33.2% |
| In Corridor (snapshot) + Q1 (setup bull) | 210 | 28.2% | 51.9% | 1.11 | 31.2% |
| Corridor entry (event) + HTF + LTF improving (dir-aware, 4h) | 83 | 11.2% | 51.8% | 1.10 | 12.3% |
| Recent corridor entry (≤60m) + LTF improving (dir-aware, 4h) | 294 | 39.5% | 50.3% | 1.07 | 42.4% |
| Corridor entry (event) + In Corridor (snapshot) | 400 | 53.8% | 50.0% | 1.07 | 57.3% |
| Corridor entry (event) + Recent corridor entry (≤60m) | 400 | 53.8% | 50.0% | 1.07 | 57.3% |
| Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 321 | 43.1% | 49.8% | 1.06 | 45.8% |
| Recent corridor entry (≤60m) + HTF + LTF improving (dir-aware, 4h) | 167 | 22.4% | 49.7% | 1.06 | 23.8% |
| Q1 (setup bull) + HTF improving (dir-aware, 4h) | 114 | 15.3% | 49.1% | 1.05 | 16.0% |
| Corridor entry (event) + HTF improving (dir-aware, 4h) | 162 | 21.8% | 48.8% | 1.04 | 22.6% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Corridor entry (event) | 400 | 50.0% | 1.07 | 57.3% | 12.4 |
| Q1 (setup bull) | 233 | 51.5% | 1.10 | 34.4% | 10.7 |
| LTF improving (dir-aware, 4h) | 368 | 47.8% | 1.02 | 50.4% | 3.4 |
| Recent corridor entry (≤60m) | 618 | 47.4% | 1.01 | 84.0% | 3.1 |
| |ΔHTF| ≥ 5 (4h) | 379 | 47.5% | 1.01 | 51.6% | 2.2 |
| In Corridor (snapshot) | 665 | 46.9% | 1.00 | 89.4% | 0.1 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Q1 (setup bull) + |ΔHTF| ≥ 5 (4h) | 127 | 57.5% | 1.23 | 20.9% | 13.4 |
| Corridor entry (event) + Q1 (setup bull) | 199 | 53.3% | 1.14 | 30.4% | 12.7 |
| Corridor entry (event) + In Corridor (snapshot) | 400 | 50.0% | 1.07 | 57.3% | 12.4 |
| Corridor entry (event) + Recent corridor entry (≤60m) | 400 | 50.0% | 1.07 | 57.3% | 12.4 |
| Corridor entry (event) + |ΔHTF| ≥ 5 (4h) | 222 | 52.3% | 1.11 | 33.2% | 11.9 |
| Q1 (setup bull) + Recent corridor entry (≤60m) | 216 | 52.3% | 1.12 | 32.4% | 11.7 |
| Q1 (setup bull) + LTF improving (dir-aware, 4h) | 116 | 56.9% | 1.21 | 18.9% | 11.6 |
| In Corridor (snapshot) + Q1 (setup bull) | 210 | 51.9% | 1.11 | 31.2% | 10.5 |
| Corridor entry (event) + LTF improving (dir-aware, 4h) | 170 | 52.9% | 1.13 | 25.8% | 10.3 |
| Recent corridor entry (≤60m) + LTF improving (dir-aware, 4h) | 294 | 50.3% | 1.07 | 42.4% | 10.1 |
| Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 321 | 49.8% | 1.06 | 45.8% | 9.4 |
| Recent corridor entry (≤60m) + HTF + LTF improving (dir-aware, 4h) | 167 | 49.7% | 1.06 | 23.8% | 4.7 |

## Horizon: 1d
- Baseline win rate: **46.9%** (349/744)

| Signal | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q4 (setup bear) | 27 | 3.6% | 51.9% | 1.11 | 4.0% |
| Q1 (setup bull) | 233 | 31.3% | 51.5% | 1.10 | 34.4% |
| Corridor entry (event) | 400 | 53.8% | 50.0% | 1.07 | 57.3% |
| Squeeze release (event) | 25 | 3.4% | 48.0% | 1.02 | 3.4% |
| LTF improving (dir-aware, 4h) | 368 | 49.5% | 47.8% | 1.02 | 50.4% |
| |ΔHTF| ≥ 5 (4h) | 379 | 50.9% | 47.5% | 1.01 | 51.6% |
| Recent corridor entry (≤60m) | 618 | 83.1% | 47.4% | 1.01 | 84.0% |
| Pattern: corridor → squeeze on (≤6h) | 51 | 6.9% | 47.1% | 1.00 | 6.9% |
| In Corridor (snapshot) | 665 | 89.4% | 46.9% | 1.00 | 89.4% |
| Pattern: squeeze on → release (≤24h) | 63 | 8.5% | 46.0% | 0.98 | 8.3% |
| HTF + LTF improving (dir-aware, 4h) | 213 | 28.6% | 46.0% | 0.98 | 28.1% |
| |ΔLTF| ≥ 5 (4h) | 487 | 65.5% | 45.6% | 0.97 | 63.6% |

### Top combos (k=2, minN=75, top=15)
| Combo | N | Coverage | Win rate | Lift | Recall |
|:--|--:|--:|--:|--:|--:|
| Q1 (setup bull) + |ΔHTF| ≥ 5 (4h) | 127 | 17.1% | 57.5% | 1.23 | 20.9% |
| Q1 (setup bull) + LTF improving (dir-aware, 4h) | 116 | 15.6% | 56.9% | 1.21 | 18.9% |
| Corridor entry (event) + Q1 (setup bull) | 199 | 26.7% | 53.3% | 1.14 | 30.4% |
| Corridor entry (event) + LTF improving (dir-aware, 4h) | 170 | 22.8% | 52.9% | 1.13 | 25.8% |
| Q1 (setup bull) + Recent corridor entry (≤60m) | 216 | 29.0% | 52.3% | 1.12 | 32.4% |
| Corridor entry (event) + |ΔHTF| ≥ 5 (4h) | 222 | 29.8% | 52.3% | 1.11 | 33.2% |
| In Corridor (snapshot) + Q1 (setup bull) | 210 | 28.2% | 51.9% | 1.11 | 31.2% |
| Corridor entry (event) + HTF + LTF improving (dir-aware, 4h) | 83 | 11.2% | 51.8% | 1.10 | 12.3% |
| Recent corridor entry (≤60m) + LTF improving (dir-aware, 4h) | 294 | 39.5% | 50.3% | 1.07 | 42.4% |
| Corridor entry (event) + In Corridor (snapshot) | 400 | 53.8% | 50.0% | 1.07 | 57.3% |
| Corridor entry (event) + Recent corridor entry (≤60m) | 400 | 53.8% | 50.0% | 1.07 | 57.3% |
| Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 321 | 43.1% | 49.8% | 1.06 | 45.8% |
| Recent corridor entry (≤60m) + HTF + LTF improving (dir-aware, 4h) | 167 | 22.4% | 49.7% | 1.06 | 23.8% |
| Q1 (setup bull) + HTF improving (dir-aware, 4h) | 114 | 15.3% | 49.1% | 1.05 | 16.0% |
| Corridor entry (event) + HTF improving (dir-aware, 4h) | 162 | 21.8% | 48.8% | 1.04 | 22.6% |

### Shortlist-ready (balances lift + recall)
Ranked by **incremental winners vs baseline**: ΔWins = Winners − N×BaselineWinRate (higher means more actionable yield).

#### Singles (top by ΔWins)
| Signal | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Corridor entry (event) | 400 | 50.0% | 1.07 | 57.3% | 12.4 |
| Q1 (setup bull) | 233 | 51.5% | 1.10 | 34.4% | 10.7 |
| LTF improving (dir-aware, 4h) | 368 | 47.8% | 1.02 | 50.4% | 3.4 |
| Recent corridor entry (≤60m) | 618 | 47.4% | 1.01 | 84.0% | 3.1 |
| |ΔHTF| ≥ 5 (4h) | 379 | 47.5% | 1.01 | 51.6% | 2.2 |
| In Corridor (snapshot) | 665 | 46.9% | 1.00 | 89.4% | 0.1 |

#### Combos k=2 (top by ΔWins)
| Combo | N | Win rate | Lift | Recall | ΔWins |
|:--|--:|--:|--:|--:|--:|
| Q1 (setup bull) + |ΔHTF| ≥ 5 (4h) | 127 | 57.5% | 1.23 | 20.9% | 13.4 |
| Corridor entry (event) + Q1 (setup bull) | 199 | 53.3% | 1.14 | 30.4% | 12.7 |
| Corridor entry (event) + In Corridor (snapshot) | 400 | 50.0% | 1.07 | 57.3% | 12.4 |
| Corridor entry (event) + Recent corridor entry (≤60m) | 400 | 50.0% | 1.07 | 57.3% | 12.4 |
| Corridor entry (event) + |ΔHTF| ≥ 5 (4h) | 222 | 52.3% | 1.11 | 33.2% | 11.9 |
| Q1 (setup bull) + Recent corridor entry (≤60m) | 216 | 52.3% | 1.12 | 32.4% | 11.7 |
| Q1 (setup bull) + LTF improving (dir-aware, 4h) | 116 | 56.9% | 1.21 | 18.9% | 11.6 |
| In Corridor (snapshot) + Q1 (setup bull) | 210 | 51.9% | 1.11 | 31.2% | 10.5 |
| Corridor entry (event) + LTF improving (dir-aware, 4h) | 170 | 52.9% | 1.13 | 25.8% | 10.3 |
| Recent corridor entry (≤60m) + LTF improving (dir-aware, 4h) | 294 | 50.3% | 1.07 | 42.4% | 10.1 |
| Recent corridor entry (≤60m) + |ΔHTF| ≥ 5 (4h) | 321 | 49.8% | 1.06 | 45.8% | 9.4 |
| Recent corridor entry (≤60m) + HTF + LTF improving (dir-aware, 4h) | 167 | 49.7% | 1.06 | 23.8% | 4.7 |

## Notes / Next upgrades
- Add richer **sequence mining** (multi-event combos, e.g. corridor entry → squeeze on → release within (X) hours).
- Add **trade-relative labels** (+1R/+2R before -1R) once SL/entry reference fields are consistently available in trail points.
- Once we have more history, train a lightweight model to output a **win probability** and drive a “Best Setups” tag in the UI.
