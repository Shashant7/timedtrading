# Timed Trading ScoreEngine v2.0.0 — Comprehensive Refactor

## Overview

This refactor implements the ideal vision state from `SCORING_IMPROVEMENTS.md`, incorporating Priority 1 and Priority 2 improvements with a focus on adaptive, nuanced scoring.

## Key Improvements

### 1. HTF Scoring Enhancements

#### Graduated Structure Scoring
- **Before**: Binary bull/bear stack (all-or-nothing ±10)
- **After**: Graduated scoring based on stack quality
  - e5 > e8: +2.0
  - e8 > e13: +2.5
  - e13 > e21: +2.5
  - e21 > e48: +3.0
  - Partial stacks get partial credit

#### Volatility-Adjusted Weights
- **Before**: Static weights (50% W, 35% D, 15% 4H)
- **After**: Dynamic weights based on ATR ratios
  - High volatility → favor Daily/4H/1H (more responsive)
  - Low volatility → favor Weekly (more stable)
  - Weights automatically normalize

#### Volume-Weighted Momentum
- **Before**: Simple EMA cross momentum (±5)
- **After**: Volume boost added
  - Volume ratio > 1.2: +3.0 boost
  - Volume ratio < 0.8: -2.0 penalty
  - Confirms momentum with volume

#### Multi-Factor Regime Detection
- **Before**: Simple compression + phase exit
- **After**: Multi-factor regime score
  - Compression factor: ±5
  - Phase exhaustion: -3
  - ATR expansion: +2 (when not compressed)
  - Volume regime: +1 (high vol) / -0.5 (low vol)

### 2. LTF Scoring Enhancements

#### Momentum-Normalized Squeeze Release
- **Before**: Fixed ±12 on squeeze release
- **After**: Scaled by momentum strength
  - Base: ±8.0
  - Multiplied by `min(1.5, |mom| / momStd)`
  - Stronger momentum = stronger signal

#### Distance-Based Golden Gate
- **Before**: Binary cross detection (±8)
- **After**: Distance-based scoring (optional)
  - Distance > 0.8: +6.0
  - Distance < 0.2: -4.0
  - Proximity bonus: ±2.0 when within 0.1×ATR
  - Can toggle between distance-based and binary modes

#### Graduated SuperTrend Support
- **Before**: Binary ±10 when conditions met
- **After**: Distance-based fade
  - Base: ±10.0
  - Fades with distance: `10.0 × max(0, 1.0 - dist/2.0)`
  - More nuanced support detection

#### RSI Mean Reversion Component
- **New**: Added RSI-based mean reversion
  - RSI > 70: -4.0 (overbought)
  - RSI < 30: +4.0 (oversold)
  - Helps detect pullback opportunities

### 3. TP/SL Calculation Improvements

#### Dynamic TP Based on Swing Size
- **Before**: Fixed 0.618 and 1.000 multipliers
- **After**: Adaptive TP using recent swing
  - `swingBasedATR = max(ATRw, recentSwingW × 0.5)`
  - Adds 1.618 extension level
  - Respects actual market structure

#### Volatility-Adjusted SL
- **Before**: Fixed 0.35 × ATRw
- **After**: Volatility-adjusted with minimum
  - Multiplier: `max(0.8, min(1.5, atrRatio))`
  - Minimum: `ATRd × 1.5` (daily ATR-based floor)
  - Prevents stops in normal volatility

#### Pivot-Based S/R Integration
- **New**: Incorporates pivot points
  - Finds nearest resistance/support
  - Adjusts TP to 2% below resistance / 2% above support
  - Adjusts SL to respect S/R levels
  - Prevents unrealistic targets

### 4. Phase Calculation Enhancements

#### Multi-Factor Phase
- **Before**: Price-only phase oscillator
- **After**: Weighted combination
  - Price phase: 60%
  - Momentum phase: 30%
  - Volume phase: 10%
  - More comprehensive regime detection

#### Graduated Phase Zones
- **Before**: Binary high/low
- **After**: Four zones
  - EXTREME: |osc| > 100
  - HIGH: |osc| > 61.8
  - MEDIUM: |osc| > 38.2
  - LOW: |osc| ≤ 38.2
  - Zone transitions trigger phase dot

#### Phase Velocity
- **New**: Tracks rate of change
  - `phaseVelocity = phaseOsc - phaseOsc[1]`
  - `phaseAccel = phaseVelocity - phaseVelocity[1]`
  - Available for future use (divergence detection)

### 5. Timeframe Enhancements

#### Intermediate Timeframe Bridge
- **New**: Added 1H timeframe
  - Bridges gap between 4H (HTF) and 30m (LTF)
  - Default weight: 5% (adjustable)
  - Improves multi-timeframe alignment

#### Session-Aware LTF Weights
- **New**: Adjusts weights based on trading session
  - RTH (9am-4pm): Favor 30m (70%), reduce 3m (7%)
  - Outside RTH: Use base weights
  - Better signal quality during active hours

#### Asset-Class Adaptive (Framework)
- **New**: Detection functions for asset classes
  - Crypto, Futures, Forex, Equities
  - Framework ready for adaptive timeframe selection
  - Currently uses base timeframes (can be extended)

## New Inputs

### Adaptive Features
- `useVolatilityAdjust`: Enable volatility-adjusted weights
- `useSessionAware`: Enable session-aware LTF weights
- `useAssetAdaptive`: Framework for asset-class adaptation

### Golden Gate
- `ggDistanceMode`: Toggle distance-based vs binary cross

### Phase
- `useMultiFactorPhase`: Enable multi-factor phase calculation
- `usePhaseZones`: Enable graduated phase zones

### TP/SL
- `useDynamicTP`: Enable dynamic TP based on swing size
- `useVolatilitySL`: Enable volatility-adjusted SL
- `usePivotSR`: Enable pivot-based S/R integration
- `pivotLookback`: Pivot detection lookback (3-10)

## New Output Fields

- `phase_zone`: Phase zone string (EXTREME/HIGH/MEDIUM/LOW)
- `flags.phase_zone_change`: Boolean for zone transitions

## Backward Compatibility

- All new features are **opt-in** via input toggles
- Default behavior matches v1.1.0 when toggles are off
- JSON output format extended (new fields are optional)
- Worker handles missing fields gracefully

## Migration Notes

1. **Test with toggles OFF first** to verify baseline behavior
2. **Enable features incrementally** to measure impact
3. **Monitor rank scores** - they may shift with new scoring
4. **Adjust alert thresholds** if needed (RR, completion, phase, rank)

## Performance Considerations

- Additional security calls for 1H timeframe (minimal impact)
- Pivot detection adds small overhead (only when enabled)
- Multi-factor phase uses existing data (no extra calls)
- Volatility calculations use cached ATR values

## Testing Recommendations

1. **Backtest** with toggles on/off to compare
2. **Compare win rates** before/after
3. **Check RR distribution** - should improve with dynamic TP/SL
4. **Validate phase zones** - should predict reversals better
5. **Monitor corridor entries** - should be more accurate

## Next Steps (Future Enhancements)

- Trailing stop logic (Priority 3)
- Cross-timeframe confirmation scoring
- Phase divergence detection
- Machine learning-weighted components (optional)

---

**Version**: 2.0.0  
**Date**: 2026-01-05  
**Compatibility**: Pine Script v6

