# Technical Analysis: Scoring & Calculation Improvements

## Executive Summary

This document provides expert technical analysis and recommendations for improving the Timed Trading scoring system, TP/SL calculations, phase detection, and timeframe selection. All recommendations are based on technical analysis best practices, market microstructure, and statistical robustness.

---

## 1. Scoring System Improvements

### 1.1 Current HTF Scoring Analysis

**Current Implementation:**
- Weighted blend: Weekly (50%), Daily (35%), 4H (15%)
- Components: Trend bias (±20), Structure (±15), Regime (±8), Momentum (±5)
- Range: -50 to +50

**Issues Identified:**

1. **Static Weights Don't Adapt to Volatility Regimes**
   - High volatility periods: Weekly becomes less reliable (too slow)
   - Low volatility periods: 4H becomes noisy (too fast)
   - **Recommendation**: Implement volatility-adjusted weights
   ```pine
   // Volatility-adjusted weights
   volW = ta.atr(14) / ta.atr(14)[7]  // Weekly ATR change
   volD = ta.atr(14) / ta.atr(14)[1]   // Daily ATR change
   
   // High vol → favor Daily/4H, Low vol → favor Weekly
   wW_adj = volW > 1.5 ? wW * 0.7 : wW * 1.2
   wD_adj = volD > 1.3 ? wD * 1.2 : wD * 0.9
   ```

2. **Structure Component Too Binary**
   - Current: Bull stack = +10, Bear stack = -10 (all-or-nothing)
   - **Recommendation**: Graduated scoring based on stack quality
   ```pine
   // Graduated structure scoring
   stackScore = 0.0
   if e5 > e8: stackScore += 2.0
   if e8 > e13: stackScore += 2.5
   if e13 > e21: stackScore += 2.5
   if e21 > e48: stackScore += 3.0
   // Partial stacks get partial credit
   structure = (htfBull ? stackScore : -stackScore) + (slope48Up ? 5.0 : -5.0)
   ```

3. **Missing Volume Confirmation**
   - HTF score doesn't consider volume
   - **Recommendation**: Add volume-weighted momentum
   ```pine
   volRatio = volume / ta.sma(volume, 20)
   volBoost = volRatio > 1.2 ? 3.0 : (volRatio < 0.8 ? -2.0 : 0.0)
   htfScore += volBoost
   ```

4. **Regime Detection Too Simple**
   - Current: Compression = ±5, Phase exit = -3
   - **Recommendation**: Multi-factor regime detection
   ```pine
   // Regime score (0-15)
   regimeScore = 0.0
   // Compression factor
   if comp: regimeScore += (bias == 1 ? 5.0 : -5.0)
   // Phase exhaustion
   phaseExtreme = math.abs(osc) > phaseExitAbs
   if phaseExtreme: regimeScore -= 3.0
   // ATR expansion/contraction
   atrExpansion = ta.atr(14) > ta.atr(14)[5]
   if atrExpansion and not comp: regimeScore += 2.0
   // Volume regime
   if volRatio > 1.3: regimeScore += 1.0
   ```

### 1.2 Current LTF Scoring Analysis

**Current Implementation:**
- Weighted blend: 30m (60%), 10m (30%), 3m (10%)
- Components: Trigger (±20), Alignment (±15), SuperTrend support (±10), Guards (-5)
- Range: -50 to +50

**Issues Identified:**

1. **Squeeze Release Too Dominant**
   - Current: Squeeze release = ±12 (24% of range)
   - **Recommendation**: Scale by momentum strength
   ```pine
   // Momentum-normalized squeeze release
   momStrength = math.abs(mom) / ta.stdev(mom, 20)
   sqReleaseScore = release ? (relDir == 1 ? 8.0 : -8.0) * math.min(momStrength, 1.5) : 0.0
   ```

2. **Golden Gate Binary**
   - Current: GG cross = ±8 (one-time event)
   - **Recommendation**: Distance-based scoring
   ```pine
   // Distance to Golden Gate
   ggDist = dir == 1 ? (close - GGdn) / (GGup - GGdn) : (GGup - close) / (GGup - GGdn)
   ggScore = ggDist > 0.8 ? 6.0 : (ggDist < 0.2 ? -4.0 : 0.0)
   // Add proximity bonus
   if math.abs(close - GGup) < ATRd * 0.1: ggScore += 2.0
   if math.abs(close - GGdn) < ATRd * 0.1: ggScore -= 2.0
   ```

3. **SuperTrend Support Too Reactive**
   - Current: ST support = ±10 (large swing)
   - **Recommendation**: Graduated support based on distance
   ```pine
   // Distance-based SuperTrend support
   stDist = math.abs(close - stLine) / ta.atr(14)
   stSupport = 0.0
   if stDir < 0 and stSlopeUp and px > stLine:
       stSupport = 10.0 * math.max(0, 1.0 - stDist / 2.0)  // Fade with distance
   ```

4. **Missing Mean Reversion Component**
   - LTF doesn't detect overextension
   - **Recommendation**: Add RSI-based mean reversion
   ```pine
   rsi = ta.rsi(close, 14)
   meanRev = rsi > 70 ? -4.0 : (rsi < 30 ? 4.0 : 0.0)
   ltfScore += meanRev
   ```

### 1.3 Recommended Scoring Enhancements

**Priority 1 (High Impact, Low Complexity):**
1. Graduated structure scoring (replace binary bull/bear stack)
2. Volume-weighted momentum boost
3. Distance-based Golden Gate scoring
4. RSI mean reversion component

**Priority 2 (Medium Impact, Medium Complexity):**
1. Volatility-adjusted timeframe weights
2. Momentum-normalized squeeze release
3. Multi-factor regime detection

**Priority 3 (High Impact, High Complexity):**
1. Adaptive scoring based on market regime (trending vs ranging)
2. Machine learning-weighted component importance
3. Cross-timeframe confirmation signals

---

## 2. TP/SL Calculation Improvements

### 2.1 Current TP/SL Analysis

**Current Implementation:**
- TP: Weekly ATR-based (0.618 and 1.000 from PCw)
- SL: Weekly SuperTrend or ATR-based (0.35 × ATRw)
- Trigger: 30m close on event

**Issues Identified:**

1. **TP Levels Too Static**
   - Fixed 0.618 and 1.000 multipliers don't adapt to volatility
   - **Recommendation**: Dynamic TP based on recent swing size
   ```pine
   // Recent swing analysis
   swingHigh = ta.highest(high, 20)
   swingLow = ta.lowest(low, 20)
   recentSwing = swingHigh - swingLow
   
   // Adaptive TP
   tp618 = PCw + (0.618 * math.max(ATRw, recentSwing * 0.5))
   tp100 = PCw + (1.000 * math.max(ATRw, recentSwing * 0.7))
   tp161 = PCw + (1.618 * math.max(ATRw, recentSwing * 0.9))  // Add extension
   ```

2. **SL Too Tight in Volatile Markets**
   - 0.35 × ATRw can be too tight for volatile assets
   - **Recommendation**: Volatility-adjusted SL
   ```pine
   // Volatility-adjusted SL
   volMultiplier = ta.atr(14) / ta.sma(ta.atr(14), 20)
   baseSL = ATRw * 0.35
   adjustedSL = baseSL * math.max(0.8, math.min(1.5, volMultiplier))
   
   // Minimum SL based on recent volatility
   minSL = ta.atr(14) * 1.5  // Daily ATR-based minimum
   sl = math.max(adjustedSL, minSL)
   ```

3. **Missing Support/Resistance Levels**
   - TP/SL don't consider key S/R levels
   - **Recommendation**: Incorporate pivot points
   ```pine
   // Pivot-based TP/SL
   pivotHigh = ta.pivothigh(high, 5, 5)
   pivotLow = ta.pivotlow(low, 5, 5)
   
   // Find nearest resistance above
   nearestResistance = na
   for i = 0 to 20
       if not na(pivotHigh[i]) and pivotHigh[i] > close
           nearestResistance := pivotHigh[i]
           break
   
   // Adjust TP to respect resistance
   if not na(nearestResistance) and nearestResistance < tp100
       tp := math.min(tp100, nearestResistance * 0.98)  // 2% below resistance
   ```

4. **No Trailing Stop Logic**
   - SL is static once set
   - **Recommendation**: Dynamic trailing stop
   ```pine
   // Trailing stop logic
   var float trailStop = na
   if not na(triggerPrice)
       if dir == 1
           // Long: trail below recent low
           recentLow = ta.lowest(low, 5)
           trailStop := math.max(na(trailStop) ? sl : trailStop, recentLow - ATRd * 0.2)
       else
           // Short: trail above recent high
           recentHigh = ta.highest(high, 5)
           trailStop := math.min(na(trailStop) ? sl : trailStop, recentHigh + ATRd * 0.2)
   
   // Use trailing stop if better than initial SL
   sl = dir == 1 ? math.max(sl, trailStop) : math.min(sl, trailStop)
   ```

5. **RR Calculation Doesn't Account for Probability**
   - Current: Simple gain/risk ratio
   - **Recommendation**: Probability-weighted RR
   ```pine
   // Probability of reaching TP based on historical patterns
   // (This would require historical data analysis)
   // For now, adjust RR based on corridor position
   corridorPos = (ltf - corridorMin) / (corridorMax - corridorMin)
   probMultiplier = corridorPos > 0.7 ? 0.9 : (corridorPos < 0.3 ? 0.7 : 1.0)
   adjustedRR = rr * probMultiplier
   ```

### 2.2 Recommended TP/SL Enhancements

**Priority 1:**
1. Volatility-adjusted SL (prevent stops in normal volatility)
2. Dynamic TP based on recent swing size
3. Minimum SL based on daily ATR

**Priority 2:**
1. Pivot-based S/R level integration
2. Trailing stop logic
3. Multiple TP levels (618, 1000, 1618)

**Priority 3:**
1. Probability-weighted RR
2. Time-based SL adjustment (widen after X days)
3. Correlation-adjusted SL (for portfolio context)

---

## 3. Phase Calculation Improvements

### 3.1 Current Phase Analysis

**Current Implementation:**
- Phoenix-style oscillator: `(close - piv) / (3.0 * ATR14) * 100`
- Smoothed with EMA(3)
- Phase % = `abs(osc) / phaseMaxAbs` (capped at 100)
- Phase dot: Exit from 61.8 or 100 levels

**Issues Identified:**

1. **Phase Calculation Too Simple**
   - Only considers price vs pivot, ignores momentum
   - **Recommendation**: Multi-factor phase
   ```pine
   // Enhanced phase calculation
   pricePhase = (close - piv) / (3.0 * a14) * 100
   momentumPhase = (ta.mom(close, 10) / a14) * 20
   volumePhase = (volume / ta.sma(volume, 20) - 1.0) * 30
   
   // Weighted combination
   phaseOsc = (pricePhase * 0.6) + (momentumPhase * 0.3) + (volumePhase * 0.1)
   phaseOsc = ta.ema(phaseOsc, 3)
   ```

2. **Phase Exit Detection Too Binary**
   - Only detects exit from fixed levels
   - **Recommendation**: Graduated phase zones
   ```pine
   // Phase zones
   phaseZone = 
       math.abs(phaseOsc) > 100 ? "EXTREME" :
       math.abs(phaseOsc) > 61.8 ? "HIGH" :
       math.abs(phaseOsc) > 38.2 ? "MEDIUM" :
       "LOW"
   
   // Zone transition detection
   prevZone = phaseZone[1]
   zoneChange = phaseZone != prevZone
   ```

3. **No Phase Velocity**
   - Doesn't measure how fast phase is changing
   - **Recommendation**: Phase velocity indicator
   ```pine
   // Phase velocity (rate of change)
   phaseVelocity = phaseOsc - phaseOsc[1]
   phaseAccel = phaseVelocity - phaseVelocity[1]
   
   // High velocity = momentum building
   // Negative acceleration = momentum fading
   ```

4. **Phase Doesn't Consider Time**
   - Same phase value means different things over different timeframes
   - **Recommendation**: Time-normalized phase
   ```pine
   // Time-normalized phase
   barsInPhase = 0
   for i = 1 to 50
       if math.sign(phaseOsc[i]) == math.sign(phaseOsc)
           barsInPhase += 1
       else
           break
   
   // Extended phase = more significant
   phaseSignificance = math.min(barsInPhase / 20.0, 1.5)
   adjustedPhase = phaseOsc * phaseSignificance
   ```

### 3.2 Recommended Phase Enhancements

**Priority 1:**
1. Multi-factor phase (price + momentum + volume)
2. Graduated phase zones (not just binary exit)
3. Phase velocity indicator

**Priority 2:**
1. Time-normalized phase significance
2. Phase divergence detection (price vs phase)
3. Cross-timeframe phase confirmation

---

## 4. Timeframe Selection Improvements

### 4.1 Current Timeframe Analysis

**HTF:** Weekly (W), Daily (D), 4H (240) - weights: 0.50, 0.35, 0.15  
**LTF:** 30m (30), 10m (10), 3m (3) - weights: 0.60, 0.30, 0.10

**Issues Identified:**

1. **Fixed Timeframes Don't Adapt to Asset Class**
   - Crypto needs different timeframes than equities
   - **Recommendation**: Asset-class adaptive timeframes
   ```pine
   // Detect asset class
   isCrypto = str.contains(syminfo.ticker, "USD") or str.contains(syminfo.ticker, "USDT")
   isFutures = str.contains(syminfo.ticker, "1!")
   isForex = str.contains(syminfo.ticker, "DXY") or str.contains(syminfo.ticker, "EUR")
   
   // Adaptive HTF
   htf1 = isCrypto ? "D" : "W"      // Crypto: Daily, Equities: Weekly
   htf2 = isCrypto ? "240" : "D"    // Crypto: 4H, Equities: Daily
   htf3 = isCrypto ? "60" : "240"   // Crypto: 1H, Equities: 4H
   
   // Adaptive LTF
   ltf1 = isCrypto ? "15" : "30"   // Crypto: 15m, Equities: 30m
   ltf2 = isCrypto ? "5" : "10"    // Crypto: 5m, Equities: 10m
   ltf3 = isCrypto ? "1" : "3"     // Crypto: 1m, Equities: 3m
   ```

2. **Missing Intermediate Timeframe**
   - Gap between 4H (HTF) and 30m (LTF) is large
   - **Recommendation**: Add 1H or 2H as bridge
   ```pine
   // Add intermediate timeframe
   tf1H = input.string("60", "Intermediate (1H)", group=groupAxes)
   htf1HScore = f_htf_from_bundle(...)  // Use HTF logic
   ltf1HScore = f_ltf_from_bundle(...)  // Use LTF logic
   
   // Blend with existing
   htfScore = (htfWScore*wW + htfDScore*wD + htf4HScore*w4H) * 0.85 + htf1HScore * 0.15
   ltfScore = (ltf30Score*w30 + ltf10Score*w10 + ltf3Score*w3) * 0.85 + ltf1HScore * 0.15
   ```

3. **Weights Don't Consider Market Hours**
   - Equities: RTH vs pre/post market
   - **Recommendation**: Session-aware weights
   ```pine
   // Session detection
   isRTH = hour >= 9 and hour < 16  // Regular trading hours
   isPreMarket = hour >= 4 and hour < 9
   isAfterHours = hour >= 16 and hour < 20
   
   // Adjust weights based on session
   if isRTH
       w30 := 0.70  // Favor 30m during RTH
       w10 := 0.25
       w3 := 0.05
   else
       w30 := 0.50  // Lower weight outside RTH
       w10 := 0.35
       w3 := 0.15
   ```

4. **No Timeframe Correlation Check**
   - All timeframes treated independently
   - **Recommendation**: Cross-timeframe confirmation
   ```pine
   // Cross-timeframe alignment score
   alignmentScore = 0.0
   if (htfScore > 0 and ltfScore > 0) or (htfScore < 0 and ltfScore < 0)
       alignmentScore = 5.0  // Bonus for alignment
   else
       alignmentScore = -3.0  // Penalty for divergence
   
   // Add to final score
   finalScore = htfScore + ltfScore + alignmentScore
   ```

### 4.2 Recommended Timeframe Enhancements

**Priority 1:**
1. Asset-class adaptive timeframes
2. Add intermediate timeframe (1H/2H bridge)
3. Session-aware weight adjustment

**Priority 2:**
1. Cross-timeframe confirmation scoring
2. Volatility-adjusted timeframe selection
3. Dynamic weight rebalancing based on signal quality

---

## 5. Implementation Roadmap

### Phase 1: Quick Wins (1-2 weeks)
1. Graduated structure scoring
2. Volatility-adjusted SL
3. Dynamic TP based on swing size
4. Multi-factor phase calculation

### Phase 2: Medium Complexity (2-4 weeks)
1. Volume-weighted momentum
2. Distance-based Golden Gate
3. Pivot-based S/R integration
4. Asset-class adaptive timeframes

### Phase 3: Advanced Features (1-2 months)
1. Trailing stop logic
2. Phase velocity and zones
3. Cross-timeframe confirmation
4. Machine learning integration (optional)

---

## 6. Testing & Validation

### Backtesting Recommendations
1. Test each improvement individually
2. Compare win rate, RR, and Sharpe ratio
3. Test across different market regimes (trending, ranging, volatile)
4. Validate on multiple asset classes

### Metrics to Track
- **Win Rate**: Should improve with better scoring
- **Average RR**: Should increase with better TP/SL
- **Phase Accuracy**: Phase exits should predict reversals
- **Timeframe Correlation**: Cross-TF alignment should improve outcomes

---

## 7. Conclusion

The current system is solid but can be significantly improved with:
1. **More nuanced scoring** (graduated vs binary)
2. **Adaptive calculations** (volatility and regime-aware)
3. **Better risk management** (dynamic TP/SL)
4. **Smarter timeframes** (asset-class and session-aware)

Priority should be on **Phase 1** improvements as they provide the best ROI (high impact, low complexity).




