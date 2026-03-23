# Cross-Run Deep Analysis Report (Revised)
**Generated**: 2026-03-18
**Runs Analyzed**: 12 backtests from D1 archive (2,301 closed trades, excl. doa-gate-v2 bug)
**Period**: July 2025 – March 2026

---

## Executive Summary

Across 12 archived backtest runs totaling **2,301 closed trades**, the system generated a **net +$104,593**. The edge is concentrated entirely in **trimmed trades** — trades that hit the first TP target and kept a runner:

| Type | N | WR% | PnL | Avg PnL/Trade |
|------|---|-----|-----|---------------|
| **Trimmed** (≥1%) | 1,328 | **85.8%** | **+$208,617** | **+$157.10** |
| Untrimmed | 973 | 17.8% | -$104,024 | -$106.91 |

The system's profitability depends on (a) getting to the first trim, and (b) minimizing damage from untrimmed trades that never reach TP1.

---

## 1. Run Performance (sorted by trade count)

| Run | Total | Closed | WR% | PnL | Trimmed | Untrimmed PnL |
|-----|-------|--------|-----|-----|---------|---------------|
| saty-phase-atr-v1 | 421 | 420 | 50.5% | +$3,764 | 207 | -$32,825 |
| backtest-jul1-dec31 | 365 | 362 | 57.7% | +$978 | 196 | -$6,210 |
| **calibrated-v5** | **249** | **244** | **58.2%** | **+$10,168** | **148** | -$9,051 |
| **clean-launch-v1** | **222** | **219** | **57.5%** | **+$8,091** | **137** | -$10,340 |
| **15m-backtest (Dec-Mar)** | **188** | **182** | **57.1%** | **+$14,372** | **104** | -$9,763 |
| overnight-fix-keepopen | 184 | 184 | 48.9% | +$10,397 | 105 | -$9,705 |
| 15m-calibration-only | 176 | 170 | 57.1% | +$16,697 | 96 | -$10,403 |
| variant-b-guarded | 160 | 160 | 51.2% | +$8,911 | 75 | -$7,726 |
| phase3-4-tuned | 141 | 89 | 62.9% | +$1,225 | 78 | -$818 |
| sizing-fix-v1 | 115 | 114 | 69.3% | +$4,217 | 87 | -$3,590 |
| exit-upgrade-v1 | 111 | 108 | 71.3% | +$5,356 | 86 | -$2,493 |
| 15m-backtest (Jul-Mar) | 49 | 49 | **79.6%** | **+$20,418** | 32 | -$1,100 |

**Key insight**: Every single run is net profitable. The system works. The untrimmed drag is consistent (-$2K to -$33K) but trimmed wins always overcome it.

---

## 2. Exit Reason Performance (2,301 trades, ranked by frequency)

### Top Winners
| Exit Reason | N | WR% | PnL | Avg PnL |
|-------------|---|-----|-----|---------|
| sl_breached (mixed) | 561 | **57.6%** | **+$15,578** | +$27.8 |
| trigger_exit | 328 | 54.3% | +$7,832 | +$23.9 |
| PHASE_LEAVE_100 | 247 | **100%** | **+$33,022** | +$133.7 |
| other (combined) | 308 | 69.2% | +$74,136 | +$240.7 |
| SOFT_FUSE_RSI | 123 | **94.3%** | **+$29,107** | +$236.6 |
| TD_EXHAUSTION_RUNNER | 71 | **93.0%** | +$9,115 | +$128.4 |
| SUPPORT_BREAK_CLOUD | 106 | 60.4% | +$1,412 | +$13.3 |
| SQUEEZE_RELEASE | 47 | 70.2% | +$1,217 | +$25.9 |
| ST_FLIP | 20 | **100%** | +$3,028 | +$151.4 |

### Top Losers
| Exit Reason | N | WR% | PnL | Avg Loss |
|-------------|---|-----|-----|----------|
| **max_loss** | **311** | **0.6%** | **-$52,009** | **-$167** |
| **ema_regime_reversed** | **119** | **31.9%** | **-$17,198** | **-$144** |
| HARD_LOSS_CAP | 13 | 0% | -$4,972 | -$382 |
| STALL_FORCE_CLOSE | 31 | 12.9% | -$1,644 | -$53 |
| DRAWDOWN_BREAKER | 8 | 12.5% | -$976 | -$122 |

**Critical**: `max_loss` exits account for **-$52K** across 311 trades — **half of all untrimmed drag**. These are trades that go against immediately and never recover. Preventing even 30% of these entries would add ~$16K to net PnL.

---

## 3. Monthly Performance

| Month | N | WR% | PnL | Trim W | Trim L | Observation |
|-------|---|-----|-----|--------|--------|-------------|
| **Jul 2025** | 334 | **67.1%** | **+$37,104** | 185 | 22 | Bull market peak |
| Aug 2025 | 355 | 58.6% | +$27,602 | 180 | 18 | Still strong |
| Sep 2025 | 391 | 59.1% | +$21,947 | 204 | 21 | Healthy |
| **Oct 2025** | **382** | **53.4%** | **-$4,263** | **182** | **42** | **Only losing month — trim losses doubled** |
| Nov 2025 | 293 | 52.9% | +$11,129 | 132 | 41 | Recovery but more trim losses |
| Dec 2025 | 301 | 55.8% | +$3,200 | 147 | 21 | Stabilizing |
| Jan 2026 | 116 | 56.0% | +$5,653 | 61 | 11 | Fewer trades, decent quality |
| Feb 2026 | 110 | 48.2% | +$3,519 | 45 | 12 | Below 50% WR but still profitable |
| Mar 2026 | 19 | 26.3% | -$1,299 | 4 | 0 | Tiny sample |

**October is the only losing month** — trim losses doubled (42 vs ~20 avg). The system's defense against bad trims needs strengthening during regime transitions.

---

## 4. Rank x Direction (corrected with full dataset)

| Rank | Dir | N | WR% | PnL | Avg PnL |
|------|-----|---|-----|-----|---------|
| 80+ | LONG | 834 | **59.6%** | **+$37,104** | +$44.5 |
| 80+ | SHORT | 32 | 56.2% | +$2,500 | +$78.1 |
| 70-79 | LONG | 516 | 55.0% | +$26,924 | +$52.2 |
| 70-79 | SHORT | 38 | 55.3% | +$969 | +$25.5 |
| 60-69 | LONG | 576 | 56.9% | +$20,323 | +$35.3 |
| 60-69 | SHORT | 30 | 56.7% | +$967 | +$32.2 |
| <60 | LONG | 253 | 55.3% | +$15,912 | +$62.9 |
| <60 | SHORT | 22 | 36.4% | -$106 | -$4.8 |

**Correction from initial analysis**: With the full 2,300+ trade dataset, ALL rank buckets are profitable for LONGs. The 80+ bucket is the best (59.6% WR, highest total PnL). The earlier finding about 70-79 being a "trap" was a small-sample artifact.

SHORTs work at all rank levels except <60 (only 22 trades, inconclusive).

---

## 5. Worst Tickers (consistent losers, ≥10 trades)

| Ticker | N | WR% | PnL | Avg PnL |
|--------|---|-----|-----|---------|
| **AMZN** | 19 | **15.8%** | **-$4,708** | -$247.8 |
| **META** | 17 | **23.5%** | **-$4,399** | -$258.8 |
| **RKLB** | 10 | **10.0%** | **-$3,499** | -$349.9 |
| RDDT | 27 | 29.6% | -$3,255 | -$120.6 |
| LRN | 21 | 42.9% | -$2,699 | -$128.5 |
| IESC | 31 | 32.3% | -$2,405 | -$77.6 |
| BG | 21 | 33.3% | -$2,086 | -$99.4 |
| WMT | 56 | 33.9% | -$1,515 | -$27.1 |
| ETN | 41 | 46.3% | -$1,254 | -$30.6 |
| NVDA | 21 | 19.0% | -$1,051 | -$50.0 |

**AMZN, META, NVDA** — large-cap mega-caps with tight ranges that the system can't capture. These should be blacklisted or have dramatically reduced sizing.

---

## 6. Best Tickers (consistent winners, ≥10 trades)

| Ticker | N | WR% | PnL | Avg PnL |
|--------|---|-----|-----|---------|
| **PH** | 39 | 59.0% | **+$7,351** | +$188.5 |
| **AVGO** | 28 | **75.0%** | **+$6,097** | +$217.8 |
| **APP** | 48 | 54.2% | +$5,960 | +$124.2 |
| LITE | 24 | 66.7% | +$5,891 | +$245.5 |
| AU | 17 | 76.5% | +$5,598 | +$329.3 |
| CAT | 82 | 61.0% | +$5,495 | +$67.0 |
| RGLD | 26 | **88.5%** | +$5,214 | +$200.5 |
| HII | 46 | 67.4% | +$4,598 | +$100.0 |
| ANET | 17 | 64.7% | +$3,917 | +$230.4 |
| TJX | 45 | 60.0% | +$3,774 | +$83.9 |

These are "franchise" tickers — strong trends, clean technical behavior, good volatility-to-noise ratio.

---

## 7. Actionable Recommendations (Revised)

### Highest Impact (based on 2,301 trades)

1. **Eliminate max_loss exits** (-$52K): This is a position sizing + entry quality problem. Trades that hit max_loss NEVER worked. Either:
   - Reduce position size so max_loss can't trigger (smaller notional)
   - Better entry gates to reject the 311 trades that became max_loss
   - The AI CIO agent (Phase 5) could evaluate and reject these pre-entry

2. **Fix ema_regime_reversed exits** (-$17K): These 119 trades entered trending and then the regime flipped. The exit fires too late — damage is already done. Need:
   - Earlier detection of regime deterioration (before the reversal confirms)
   - Faster tightening when regime score drops below threshold

3. **Protect October-style transitions**: The only losing month had 2x the normal trim losses (42 vs ~20). During macro regime transitions, trimmed runners need tighter protection.

4. **Blacklist/reduce**: AMZN, META, RKLB, RDDT, NVDA (-$16,912 combined). These mega-caps don't trend cleanly enough for the system.

5. **Boost franchise tickers**: PH, AVGO, APP, LITE, AU, CAT, RGLD (+$41,706 combined). These should get favorable treatment (larger size, lower entry threshold).

### Confirmed from full dataset
- Trimmed = the edge. Optimize everything to reach TP1 faster.
- PHASE_LEAVE_100 and SOFT_FUSE_RSI are the crown jewels — protect them.
- All rank buckets work (80+ is best). No need for rank-based size reduction.
- SHORTs work but are severely underrepresented (122 of 2,301).
- System is profitable Jul-Feb, only loses in Oct (macro transition).
