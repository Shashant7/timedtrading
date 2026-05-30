# Gold Standard Pattern Analysis

Generated: 2026-02-12T00:44:41.806Z
Window: 2025-10-01 → 2026-02-12 (134 days)

## Executive Summary

| Metric | Value |
|:--|--:|
| Total trades | 15 |
| Winners | 2 |
| Losers | 4 |
| Win rate | 33.3% |
| Avg winner P&L | $19.96 (1.2%) |
| Avg loser P&L | $-43.14 (-2.6%) |
| Profit factor | 0.23 |

## 🎯 Winner vs Loser Patterns at Entry

| Metric | Winners | Losers | Delta |
|:--|--:|--:|--:|
| Count | 2 | 4 | — |
| Avg RR | — | — | 0.00 |
| Median RR | — | — | 0.00 |
| Avg Rank | — | — | 0 |
| LONG % | 50.0% | 75.0% | -25.0% |

### Key Finding: RR at Entry is Predictive

Winners have **0.0x higher RR** at entry compared to losers.

## 📊 RR Bucket Analysis

| RR Range | Trades | Wins | Losses | Win Rate |
|:--|--:|--:|--:|--:|
| RR 0-2 | 0 | 0 | 0 | — |
| RR 2-5 | 1 | 0 | 0 | — |
| RR 5-10 | 0 | 0 | 0 | — |
| RR 10-20 | 0 | 0 | 0 | — |
| RR 20+ | 0 | 0 | 0 | — |

## ⚠️ Trade Frequency Analysis (Churning Detection)

| Metric | Value |
|:--|--:|
| Unique tickers traded | 14 |
| Avg trades per ticker | 1.07 |
| Max trades on one ticker | 2 (BA) |
| Tickers with excessive trades | 0 |

## 📈 TP Analysis (Move Magnitude)

### Winner Gain Distribution

| Percentile | Gain % |
|:--|--:|
| P25 | 1.2% |
| Median (P50) | 1.2% |
| P75 | 1.3% |
| P90 | 1.3% |

### Winner Gain Buckets

| Range | Count |
|:--|--:|
| 0-1% | 0 |
| 1-2% | 2 |
| 2-3% | 0 |
| 3-5% | 0 |
| 5%+ | 0 |

### Recommended TP Targets

- **Conservative** (50th %ile): 1.2%
- **Moderate** (65th %ile): 1.3%
- **Aggressive** (80th %ile): 1.3%

## 💡 Recommendations

### TP Normalization

**Issue:** Winner median gain is 1.2%

**Recommendation:** Set TP target to ~1.3% (75th percentile of winners)

**Impact:** P25/P50/P75 of winner gains: 1.2% / 1.2% / 1.3%

### Direction Bias

**Issue:** SHORT trades have higher win rate

**Recommendation:** Consider SHORT-biased position sizing or stricter LONG filters

**Impact:** Winners: 50.0% LONG vs Losers: 75.0% LONG

## Next Steps

1. **Implement per-ticker trade limits** - Max 3 trades per ticker per day
2. **Add cooldown period** - Minimum 30 minutes between entries on same ticker
3. **Raise RR threshold** - Consider minimum RR of 5+ based on win rate analysis
4. **Normalize TP** - Use dynamic TP based on recent volatility or P75 of winner gains
5. **Add trail data analysis** - Cross-reference entry signals with actual trail snapshots
