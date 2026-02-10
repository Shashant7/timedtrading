# Stop Loss, Trailing SL, Trim & Exit Analysis

**Date**: 2026-02-05  
**Data**: 227 trajectory entries from 211 tickers (5 days), 576K+ candles across 7 TFs  
**Tickers Studied**: AMD (peak reversal), MU (sustained runner), AAPL (basing breakout), AXON (big short)

---

## 1. MFE / MAE Study (Max Favorable / Max Adverse Excursion)

| Category | Count | MFE Median | MAE Median | MFE p90 |
|----------|-------|-----------|-----------|---------|
| **Winners** (MFE ≥ 1.5%) | 71 | 3.18% | 0.30% | 6.45% |
| **Small Wins** (0.5-1.5%) | 51 | 0.91% | 0.80% | 1.27% |
| **Losers** (MFE < 0.5%) | 105 | 0.16% | 1.66% | 0.41% |

**Key Insight**: Winners dip very little before running (median MAE 0.3%), while losers immediately show adverse movement (median MAE 1.66%). This means **early adverse movement is a strong negative signal**.

---

## 2. Stop Loss Analysis

### Current System (PROBLEM)
- ATR-based SL: 0.65x ATR for LONGs, 1.0x ATR for SHORTs
- With 2% ATR fallback → ~1.3% for LONGs, ~2.0% for SHORTs
- **Result**: 13 of 14 closed trades exited via `sl_breached`
- **The direction logic is backwards**: LONGs get tighter SL but need MORE room (avg MAE 1.69%), SHORTs get wider SL but need LESS (avg MAE 0.66%)

### SL Hit Rate Simulation

| SL Level | Winners Stopped | Losers Stopped | Net Advantage |
|----------|----------------|----------------|---------------|
| 0.5% | 42.3% | 76.2% | 33.9% |
| **1.25%** | **22.5%** | **59.0%** | **36.5% (best)** |
| 1.5% | 22.5% | 51.4% | 28.9% |
| 2.0% | 14.1% | 45.7% | 31.6% |
| 3.0% | 9.9% | 36.2% | 26.3% |

### Recommendation
- **LONG initial SL**: 1.5% from entry (allows 78% of winners to survive)
- **SHORT initial SL**: 0.8% from entry (SHORTs run cleaner, avg MAE 0.66%)
- **Flip the direction logic**: LONGs need WIDER SL, SHORTs need TIGHTER

---

## 3. Trailing Stop Analysis

### Move Timing (when winners peak)

| Percentile | Time to MFE Peak |
|-----------|-----------------|
| p25 | 85 min |
| Median | 110 min |
| p75 | 170 min |
| p90 | 190 min |

### Give-back (how much of peak gains are lost)

| Percentile | Give-back from Peak |
|-----------|-------------------|
| p25 | 6.2% |
| Median | 20% |
| p75 | 51.1% |

### Recommended Phased Trailing
1. **Phase 1 (0-60 min)**: No trail. Keep initial SL. Let setup develop.
2. **Phase 2 (60-120 min OR +1.5% favorable)**: Move SL to breakeven.
3. **Phase 3 (120+ min OR +2% favorable)**: Trail at 50% of MFE distance from high watermark.
4. **Runner (after trim)**: Tighten trail to 1.0x ATR from current price (vs. current 1.5x).

---

## 4. Trim Level Analysis

### Winner MFE Distribution

| Percentile | MFE Level |
|-----------|----------|
| p25 | 1.97% |
| Median | 3.18% |
| p75 | 4.74% |
| p90 | 6.45% |

### Trim Level Capture Rates

| Trim Level | All Setups Reach | Winners Reach |
|-----------|-----------------|--------------|
| 1.0% | 39% | 100% |
| **2.0%** | **22%** | **70%** |
| **3.2%** | **17%** | **54%** |
| 5.0% | 6% | 20% |

### Recommendation
- **Trim 1 (50% off)**: At +2.0% (p25 of winner MFE — high confidence level)
- **Trim 2 (75% cumulative)**: At +3.2% (median of winner MFE — captures typical full move)
- **Runner exit**: At +6.5% or trailing stop (only 20% make it past 5%)

---

## 5. Final Exit Analysis

### Current System
- `MIN_MINUTES_SINCE_ENTRY_BEFORE_EXIT`: 25 min
- Exit on stage transition to "exit" lane

### What the Data Shows
- Winners still +2.33% median at 4-hour mark
- But p25 of winner end PnL is only +1.19% — many give back substantially
- p25 of winner peak time is 85 min (25% haven't peaked yet at 85 min)

### Recommendation
- **Raise MIN_MINUTES_SINCE_ENTRY_BEFORE_EXIT to 45 min** (prevents exiting during setup development)
- **Add 4-hour time stop** for remaining runner positions
- Hard SL breaches still bypass min hold time

---

## 6. Journey Analysis (AMD, MU, AAPL, AXON)

### Common Entry Signals (across all 4 tickers)
- SuperTrend bull flip (4H) after EMA 8/21 golden cross = high probability LONG entry
- Price reclaims EMA50 after basing = confirmation (AAPL pattern)
- RSI crossing 50 from below on 4H = momentum building
- FVG fill as support test = additional confirmation

### Common Peak/Exhaustion Signals
- **RSI > 70 (4H) + Price > 12% from EMA8** = overextended top (MU peaked here)
- **RSI < 30 (4H) + Price < -15% from EMA8** = oversold bounce zone
- Large upper wick (>2%) after RSI>70 = rejection candle
- SuperTrend Bear flip after extended run = trend shift confirmed
- EMA 8/21 death cross AFTER ST flip = triple confirmation for exit

### Pullback Patterns During Strong Trends
- Typical pullback depth: **1.0-2.0x ATR** on daily timeframe
- On 4H: pullback to EMA8 (-0.5% to -1.5%) = ideal trim point
- SL should be set **0.3x ATR below pullback low** (gives room for wicks)

### ATR-Based Level Framework
- **Trail activation**: 1.5x ATR above entry
- **Trim trigger**: When price stalls at ATR extension levels
- **Exit trigger**: SuperTrend flip on 4H → trail tightens to 0.5x ATR
- **Hard exit**: SuperTrend flip on DAILY = immediate close

### Direction Differences

| Metric | LONG Winners | SHORT Winners |
|--------|-------------|--------------|
| Count | 52 | 19 |
| Avg MFE | 3.53% | 4.15% |
| Avg MAE | 1.69% | 0.66% |
| Best entry state | HTF_BULL_LTF_PULLBACK (48) | HTF_BEAR_LTF_BEAR (17) |

SHORTs have higher MFE and much lower MAE — they run faster and cleaner from entry.

---

## 7. Recommended Parameter Summary

| Parameter | Current | Recommended | Rationale |
|-----------|---------|-------------|-----------|
| Initial SL (LONG) | 0.65x ATR (~1.3%) | **1.5%** | LONG MAE avg 1.69%, need room |
| Initial SL (SHORT) | 1.0x ATR (~2.0%) | **0.8%** | SHORT MAE avg 0.66%, run cleaner |
| Min hold before exit | 25 min | **45 min** | p25 winner peak at 85 min |
| BE trigger | +3.0% PnL | **+1.5% PnL after 60 min** | Earlier protection, time-gated |
| Trail activation | Runner phase only | **Phase 2: BE at 60 min; Phase 3: 50% MFE trail at 120 min** | Capture give-back |
| Runner trail | 1.5x ATR | **1.0x ATR** | Median give-back is 20% |
| Trim 1 | 0.8-1.2x ATR | **~2.0% from entry** | 100% of winners, 22% of setups |
| Trim 2 | 1.2-2.0x ATR | **~3.2% from entry** | Captures median winner full move |
| Runner TP | 2.0-4.0x ATR | **~6.5%** or trailing | Only 20% get past 5% |

---

## 8. Next Steps (Pending Full Multi-TF Data)

With 1+ month of full data across all 7 timeframes, we will:

1. **Re-run journey analysis** at 4H and 1H granularity for AMD, MU, AAPL, AXON and other movers
2. **Validate ATR levels** as SL/TP anchors across timeframes
3. **Confirm FVG support/resistance** zones for precise SL placement
4. **Measure multi-TF signal cascade** timing (how early does 4H warn vs daily?)
5. **Encode validated rules** into trading logic with confidence-weighted parameters
