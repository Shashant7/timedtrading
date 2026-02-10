# Quadrant Progression Patterns

## Overview

The quadrant progression visualization tracks how tickers move through the four quadrants over time, identifying patterns that signal great trading setups.

## Quadrants

| Quadrant | State | Description | Color |
|----------|-------|-------------|-------|
| **Q1** | HTF_BULL_LTF_PULLBACK | Bull Setup - HTF bullish, LTF pullback | Blue |
| **Q2** | HTF_BULL_LTF_BULL | Bull Momentum - Both timeframes bullish | Green |
| **Q3** | HTF_BEAR_LTF_BEAR | Bear Momentum - Both timeframes bearish | Red |
| **Q4** | HTF_BEAR_LTF_PULLBACK | Bear Setup - HTF bearish, LTF pullback | Orange |

## Detected Patterns

### 🎯 High Confidence Patterns

#### 1. **Ideal Entry** (HIGH)
- **Q1→Q2**: Clean transition from Bull Setup to Bull Momentum
- **Q4→Q3**: Clean transition from Bear Setup to Bear Momentum
- **Signal**: Strong entry opportunity
- **Visual**: Highlighted with yellow border and glow

#### 2. **Elite Setup** (HIGH)
- Momentum Elite ticker in Setup Quadrant (Q1 or Q4)
- **Signal**: High-quality stock in entry zone
- **Combines**: Fundamental strength + technical setup

#### 3. **Squeeze Setup** (HIGH)
- Squeeze release occurs in Setup Quadrant (Q1 or Q4)
- **Signal**: Explosive move potential
- **Timing**: Perfect entry point

### 📊 Medium Confidence Patterns

#### 4. **Phase Shift** (MEDIUM)
- Phase zone change occurs in Setup Quadrant
- **Signal**: Regime change confirmation
- **Timing**: Validates setup quality

#### 5. **Stable** (MEDIUM)
- Ticker stays in same quadrant for 3+ points
- **Signal**: Consistent state, no chop
- **Quality**: Clean setup, less noise

#### 6. **Choppy** (MEDIUM - Warning)
- Multiple quadrant visits (3+ different quadrants)
- **Signal**: Unclear direction, avoid
- **Action**: Lower priority or skip

## Visualization Features

### Quadrant Map
- **Current Quadrant**: Bright border and background
- **Visited Quadrants**: Dimmed border and background
- **Unvisited Quadrants**: Dark background

### Path Visualization
- Shows progression: Q1 → Q2 → Q1 (example)
- Current position highlighted
- Historical path shown with arrows

### Pattern Indicators
- **High Confidence**: Yellow background, bold text
- **Medium Confidence**: Blue background
- **Descriptions**: Clear explanation of pattern
- **Quadrant Reference**: Shows which quadrants involved

## Usage

### In TickerDetails View
1. Open any ticker's detail view
2. Scroll to "Quadrant Progression" section
3. View:
   - Current quadrant (highlighted)
   - Historical path through quadrants
   - Detected patterns with confidence levels

### Pattern Priority
1. **Ideal Entry** - Highest priority, clean transitions
2. **Elite Setup** - High-quality fundamentals + setup
3. **Squeeze Setup** - Explosive move potential
4. **Phase Shift** - Confirmation signal
5. **Stable** - Consistent, less noise
6. **Choppy** - Avoid or lower priority

## Best Practices

### Look For:
- ✅ Clean Q1→Q2 or Q4→Q3 transitions
- ✅ Momentum Elite in setup quadrants
- ✅ Squeeze releases in setup zones
- ✅ Stable quadrant behavior (no chop)

### Avoid:
- ❌ Choppy action (multiple quadrant visits)
- ❌ Unclear progression paths
- ❌ Patterns with low confidence

## Technical Details

### Trail Data
- Stored in KV: `timed:trail:${ticker}`
- Contains: ts, htf_score, ltf_score, state, flags, momentum_elite
- History: Last 20 points (configurable)
- Updated: On every ingest

### Pattern Detection
- Runs client-side in UI
- Analyzes trail history
- Real-time pattern recognition
- No server-side calculation needed

### Performance
- Trail data cached for 60 seconds
- Pattern detection: < 1ms
- Visualization: React component with memoization

