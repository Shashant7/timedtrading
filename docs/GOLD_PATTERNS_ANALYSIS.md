# Gold Standard Pattern Analysis

Generated: 2026-02-10T02:21:38.061Z
Window: 2026-02-03 → 2026-02-10 (7 days)

## Executive Summary

| Metric | Value |
|:--|--:|
| Total trades | 90 |
| Winners | 19 |
| Losers | 30 |
| Win rate | 38.8% |
| Avg winner P&L | $7.62 (0.4%) |
| Avg loser P&L | $-21.89 (-1.3%) |
| Profit factor | 0.22 |

## 🎯 Winner vs Loser Patterns at Entry

| Metric | Winners | Losers | Delta |
|:--|--:|--:|--:|
| Count | 19 | 30 | — |
| Avg RR | 1.44 | 1.40 | 0.04 |
| Median RR | 0.68 | 0.90 | -0.23 |
| Avg Rank | 0 | 0 | 0 |
| LONG % | 5.3% | 6.7% | -1.4% |

### Key Finding: RR at Entry is Predictive

Winners have **1.0x higher RR** at entry compared to losers.

## 📊 RR Bucket Analysis

| RR Range | Trades | Wins | Losses | Win Rate |
|:--|--:|--:|--:|--:|
| RR 0-2 | 41 | 16 | 20 | 44.4% |
| RR 2-5 | 47 | 1 | 10 | 9.1% |
| RR 5-10 | 2 | 2 | 0 | 100.0% |
| RR 10-20 | 0 | 0 | 0 | — |
| RR 20+ | 0 | 0 | 0 | — |

## ⚠️ Trade Frequency Analysis (Churning Detection)

| Metric | Value |
|:--|--:|
| Unique tickers traded | 87 |
| Avg trades per ticker | 1.03 |
| Max trades on one ticker | 2 (CRS) |
| Tickers with excessive trades | 0 |

## 📈 TP Analysis (Move Magnitude)

### Winner Gain Distribution

| Percentile | Gain % |
|:--|--:|
| P25 | 0.1% |
| Median (P50) | 0.4% |
| P75 | 0.6% |
| P90 | 0.8% |

### Winner Gain Buckets

| Range | Count |
|:--|--:|
| 0-1% | 19 |
| 1-2% | 0 |
| 2-3% | 0 |
| 3-5% | 0 |
| 5%+ | 0 |

### Recommended TP Targets

- **Conservative** (50th %ile): 0.4%
- **Moderate** (65th %ile): 0.4%
- **Aggressive** (80th %ile): 0.7%

## 💡 Recommendations

### TP Normalization

**Issue:** Winner median gain is 0.4%

**Recommendation:** Set TP target to ~0.6% (75th percentile of winners)

**Impact:** P25/P50/P75 of winner gains: 0.1% / 0.4% / 0.6%

## Next Steps

1. **Implement per-ticker trade limits** - Max 3 trades per ticker per day
2. **Add cooldown period** - Minimum 30 minutes between entries on same ticker
3. **Raise RR threshold** - Consider minimum RR of 5+ based on win rate analysis
4. **Normalize TP** - Use dynamic TP based on recent volatility or P75 of winner gains
5. **Add trail data analysis** - Cross-reference entry signals with actual trail snapshots
