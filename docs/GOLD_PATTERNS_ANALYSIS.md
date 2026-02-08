# Gold Standard Pattern Analysis

Generated: 2026-02-04T03:30:02.881Z
Window: 2026-02-02 → 2026-02-04 (2 days)

## Executive Summary

| Metric | Value |
|:--|--:|
| Total trades | 1244 |
| Winners | 563 |
| Losers | 575 |
| Win rate | 52.4% |
| Avg winner P&L | $24.20 (1.9%) |
| Avg loser P&L | $-25.33 (-2.0%) |
| Profit factor | 0.94 |

## 🎯 Winner vs Loser Patterns at Entry

| Metric | Winners | Losers | Delta |
|:--|--:|--:|--:|
| Count | 563 | 575 | — |
| Avg RR | 20.41 | 5.16 | 15.25 |
| Median RR | 2.91 | 3.50 | -0.59 |
| Avg Rank | 0 | 0 | 0 |
| LONG % | 44.9% | 65.7% | -20.8% |

### Key Finding: RR at Entry is Predictive

Winners have **4.0x higher RR** at entry compared to losers.

## 📊 RR Bucket Analysis

| RR Range | Trades | Wins | Losses | Win Rate |
|:--|--:|--:|--:|--:|
| RR 0-2 | 252 | 146 | 94 | 60.8% |
| RR 2-5 | 609 | 322 | 266 | 54.8% |
| RR 5-10 | 177 | 29 | 148 | 16.4% |
| RR 10-20 | 68 | 20 | 48 | 29.4% |
| RR 20+ | 138 | 116 | 19 | 85.9% |

## ⚠️ Trade Frequency Analysis (Churning Detection)

| Metric | Value |
|:--|--:|
| Unique tickers traded | 153 |
| Avg trades per ticker | 8.13 |
| Max trades on one ticker | 276 (TLN) |
| Tickers with excessive trades | 11 |

### Churning Tickers (>10 trades or <5min avg gap)

| Ticker | Trades | Win Rate | Total P&L | Avg Gap (min) | Rapid (<10m) |
|:--|--:|--:|--:|--:|--:|
| TLN | 276 | 49.5% | $-110.98 | 7 | 273 |
| SHOP | 174 | 52.0% | $89.86 | 8 | 170 |
| CRWD | 125 | 50.8% | $-40.29 | 11 | 122 |
| CDNS | 85 | 50.0% | $32.61 | 2 | 84 |
| NBIS | 68 | 49.3% | $-14.99 | 23 | 65 |
| AYI | 59 | 48.3% | $52.26 | 26 | 54 |
| BRK-B | 57 | 48.2% | $15.02 | 2 | 56 |
| VIX | 49 | 50.0% | $11.37 | 32 | 46 |
| PSTG | 47 | 50.0% | $-51.34 | 27 | 44 |
| APP | 21 | 50.0% | $26.51 | 2 | 20 |

## 📈 TP Analysis (Move Magnitude)

### Winner Gain Distribution

| Percentile | Gain % |
|:--|--:|
| P25 | 0.5% |
| Median (P50) | 1.0% |
| P75 | 1.7% |
| P90 | 2.9% |

### Winner Gain Buckets

| Range | Count |
|:--|--:|
| 0-1% | 275 |
| 1-2% | 184 |
| 2-3% | 50 |
| 3-5% | 35 |
| 5%+ | 19 |

### Recommended TP Targets

- **Conservative** (50th %ile): 1.0%
- **Moderate** (65th %ile): 1.4%
- **Aggressive** (80th %ile): 1.9%

## 💡 Recommendations

### RR Filter

**Issue:** Trades with RR < 0 have lower win rates

**Recommendation:** Consider raising minimum RR from 1.2 to 2

**Impact:** Win rate in RR 0-2: 60.8%

### Trade Frequency

**Issue:** 11 tickers have excessive trades (964 total)

**Recommendation:** Implement per-ticker daily trade limit (max 3) and cooldown period (min 30 min)

**Impact:** Top churner: TLN with 276 trades

### TP Normalization

**Issue:** Winner median gain is 1.0%

**Recommendation:** Set TP target to ~1.7% (75th percentile of winners)

**Impact:** P25/P50/P75 of winner gains: 0.5% / 1.0% / 1.7%

### Direction Bias

**Issue:** SHORT trades have higher win rate

**Recommendation:** Consider SHORT-biased position sizing or stricter LONG filters

**Impact:** Winners: 44.9% LONG vs Losers: 65.7% LONG

## Next Steps

1. **Implement per-ticker trade limits** - Max 3 trades per ticker per day
2. **Add cooldown period** - Minimum 30 minutes between entries on same ticker
3. **Raise RR threshold** - Consider minimum RR of 5+ based on win rate analysis
4. **Normalize TP** - Use dynamic TP based on recent volatility or P75 of winner gains
5. **Add trail data analysis** - Cross-reference entry signals with actual trail snapshots
