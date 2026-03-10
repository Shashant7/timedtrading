# Mean Reversion: Multi-TF TD9 Alignment Setup — Action Plan

**Source:** INTU observation (Mar 2026) — candle history on Daily and 1H charts.

**Observation:** After multiple gaps down, a high-probability mean reversion entry formed when:
1. TD 9 Lead Up fired on Daily, Weekly, and 1H (aligned)
2. Phase Leaving Dot confirmed the reversal
3. Support confluence: old FVG Daily + Sell Side Liquidity (Weekly) + psych level 400
4. RSI at extremes (oversold)

---

## 1. Signal Components (What We Have vs. Need)

| Component | Current State | Gap / Action |
|-----------|---------------|--------------|
| **Gaps down history** | `detectFVGs` finds bearish FVGs; no "multiple gaps down" pattern | Add: `countRecentGapsDown(bars, lookback)` — count bearish FVGs in last N bars |
| **TD9 alignment** | `computeTDSequentialMultiTF` merges D/W/M; `per_tf` has D, W, 60, 240, etc. | Add: `td9_aligned_long` = D + W + 60 all have `td9_bullish` |
| **Phase Leaving Dot** | Phase oscillator + zone codes (P100, N618, etc.); no explicit "leaving" event | Add: `phaseLeavingDot(bullish)` = phaseOsc left extreme (e.g. from ≤-61.8 toward 0) |
| **FVG support** | `inBullGap`, `nearestBullDist`, `activeBull` per TF | Use: daily `inBullGap` or `nearestBullDist` < 0.5 ATR |
| **Sell Side Liquidity** | `detectLiquidityZones` → `sellside`, `nearestSellsideDist` | Use: daily/weekly `sellside` near price; price in or below SSL zone |
| **Psych level** | Not implemented | Add: `isNearPsychLevel(price, [100,200,400,500,...])` within 0.5–1% |
| **RSI extremes** | RSI per TF; RSI extreme guard exists | Use: D + 4H + 1H RSI ≤ 30 (or ≤ 25 for extreme) |

---

## 2. Codifiable Setup Definition

**Name:** `mean_revert_td9_aligned`

**Direction:** LONG (buy reversal after selloff)

**Entry conditions (all required):**

1. **Gap-down context:** ≥ 2 bearish FVGs in last 20 bars on Daily (or equivalent lookback)
2. **TD9 alignment:** Daily, Weekly, and 1H (60) all have `td9_bullish` on current bar
3. **Phase leaving dot:** Phase oscillator left accumulation (e.g. from ≤-61.8 toward 0) on Daily or 1H
4. **Support confluence (at least 2 of 3):**
   - In or near bullish FVG on Daily (`inBullGap` or `nearestBullDist` < 0.5 ATR)
   - Near or below Sell Side Liquidity on Weekly (`nearestSellsideDist` < 0.5 ATR or price swept SSL)
   - Within 1% of psych level (100, 200, 400, 500, etc.)
5. **RSI extremes:** Daily RSI ≤ 30 (or ≤ 25); 4H and 1H RSI ≤ 35 or 40

**Optional filters:**
- HTF bias: price below 200 EMA (oversold) for mean reversion
- Volume: no requirement for now; can add later

---

## 3. Implementation Phases

### Phase A: Add Missing Primitives

1. **`countRecentGapsDown(bars, lookback)`** — in `indicators.js` or inline in `detectFVGs` output
   - Returns count of bearish FVGs in last `lookback` bars
   - Use lookback ~20 for Daily

2. **`td9AlignedLong(tdSeq)`** — in `indicators.js` or model
   - Input: `td_sequential` with `per_tf`
   - Return: `per_tf.D?.td9_bullish && per_tf.W?.td9_bullish && per_tf["60"]?.td9_bullish`

3. **`phaseLeavingDotBullish(bars, bundle)`** — phase left extreme
   - Compare current `phaseOsc` to previous bar; if was ≤-61.8 and now > -61.8 (or similar), flag
   - Or: `phaseOsc` crossed from below -50 to above -50 (leaving accumulation)

4. **`isNearPsychLevel(price, pctTolerance)`** — round-number support
   - Levels: 100, 200, 250, 300, 400, 500, 750, 1000, etc.
   - Within `pctTolerance` (e.g. 1%) of nearest level

### Phase B: Wire Into Entry Logic

1. **New flag:** `mean_revert_td9_aligned` in `assembleTickerData` or scoring
   - Compute when all conditions met
   - Expose in `flags` or `signal_snapshot` for UI and trade logic

2. **Entry path:** Option A — treat as a **boost** to existing Ripster/entry logic when conditions align  
   Option B — dedicated **mean reversion entry** path (feature-flagged)

3. **Risk:** This setup is counter-trend. Consider:
   - Tighter SL (e.g. below recent low or SSL zone)
   - Smaller position size
   - Require confirmation candle (e.g. close above prior bar high)

### Phase C: Validation

1. **Backtest:** Run July 2025 (or similar) with `mean_revert_td9_aligned` enabled
2. **Manual audit:** Check INTU and similar setups (e.g. other gap-down stocks that reversed)
3. **Trade autopsy:** Tag trades with `mean_revert_td9_aligned` for classification

---

## 4. Data Flow

```
Candles (D, W, 60, 240, …)
  → computeTfBundle (per TF)
  → computeTDSequentialMultiTF
  → detectFVGs (per TF)
  → detectLiquidityZones (per TF)
  → RSI per TF
  → phaseOsc per TF
  → mean_revert_td9_aligned = f(all above)
```

---

## 5. Reference: INTU Chart

- **Daily:** TD 9 Lead Up at bottom; Phase Leaving Dot; RSI at extremes; support at $400 psych + old FVG
- **1H:** TD 9 fired; Phase Leaving Dot; RSI oversold
- **Weekly:** TD 9 printed; SSL at bottom

---

## 6. Next Steps

1. Add primitives (Phase A) to `worker/indicators.js`
2. Add `td9AlignedLong` to `computeTDSequentialMultiTF` output or `assembleTickerData`
3. Add `mean_revert_td9_aligned` flag and wire to entry path (feature-flagged)
4. Add to `tasks/todo.md` as a tracked task
