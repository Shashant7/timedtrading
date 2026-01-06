# TP Calculation Enhancements

This document outlines the intelligent TP calculation enhancements to be added to `TimedTrading_ScoreEngine.pine`.

## Current TP Structure

Currently, TP levels are stored as a simple array of prices:
```pine
tp_levels = [46.68, 46.91, 46.96, ...]
```

## Enhanced TP Structure

TP levels will include metadata:
```pine
tp_level = {
    price: 46.68,
    label: "TP1",
    source: "38.2% ATR Daily",
    type: "ATR_FIB",
    multiplier: 0.382,
    timeframe: "D",
    confidence: 0.85,
    priority: 1
}
```

## New Features to Add

### 1. Chart Patterns & Measured Moves
- **Double Top/Bottom**: Measure from pattern to neckline, project target
- **Head & Shoulders**: Measure from head to neckline, project target
- **Triangles**: Measure base width, project from breakout
- **Flags/Pennants**: Measure pole, project continuation
- **Cup & Handle**: Measure cup depth, project target

### 2. HTF Structure (Highs/Lows)
- Identify swing highs/lows on Weekly, Daily, 4H
- Use previous swing high/low as resistance/support targets
- Consider structure breaks for target validation

### 3. Buyside/Sellside Liquidity
- **Buyside Liquidity**: Equal lows (liquidity pools) on 4H, D, W
- **Sellside Liquidity**: Equal highs (liquidity pools) on 4H, D, W
- These act as magnets before price continues

### 4. FVG (Fair Value Gap) Considerations
- Detect FVGs (3-bar imbalance patterns)
- Price tends to return to fill FVGs
- Use FVG midpoint as potential target/retracement level

### 5. Open Gap Analysis
- Detect gaps on Daily/Weekly charts
- Calculate gap age (bars since gap)
- Probability of gap fill decreases with age:
  - 0-5 bars: 80% probability
  - 6-20 bars: 60% probability
  - 21-50 bars: 40% probability
  - 50+ bars: 20% probability
- Use gap fill as target with confidence based on age

## Implementation Plan

1. **Add TP Level Metadata Structure** (Pine Script)
   - Create helper functions to build TP level objects
   - Update `allTargets` array to store objects instead of just prices

2. **Add Pattern Detection Functions** (Pine Script)
   - Implement pattern detection for common chart patterns
   - Calculate measured move targets

3. **Add HTF Structure Analysis** (Pine Script)
   - Identify swing highs/lows on multiple timeframes
   - Store as potential TP levels

4. **Add Liquidity Zone Detection** (Pine Script)
   - Detect equal highs/lows on 4H, D, W
   - Mark as liquidity zones with confidence scores

5. **Add FVG Detection** (Pine Script)
   - Detect 3-bar imbalance patterns
   - Calculate FVG midpoint and boundaries

6. **Add Gap Detection** (Pine Script)
   - Detect gaps on Daily/Weekly
   - Calculate gap age and fill probability

7. **Update JSON Output** (Pine Script)
   - Modify `tpArrayStr` to include metadata
   - Format as JSON array of objects

8. **Update Worker** (index.js)
   - Parse enhanced TP level structure
   - Store metadata in KV

9. **Update UI** (index-react.html)
   - Display TP level metadata (already done)
   - Show confidence scores
   - Color-code by confidence

