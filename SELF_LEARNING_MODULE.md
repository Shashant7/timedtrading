# Self-Learning Module: What Has Been Working

## Overview

The Self-Learning Module analyzes completed trades (WIN/LOSS) to identify patterns that have been successful. This helps inform threshold decisions for both "Trading Opportunity" alerts and "Trade Entered" simulation.

## How It Works

### Pattern Analysis

The module analyzes trade history and identifies:

1. **Best Rank Ranges**: Which rank ranges (e.g., 70-79, 80-89) have highest win rates
2. **Best RR Ranges**: Which RR ranges (e.g., ≥2.0, 1.5-2.0) perform best
3. **Win Rates**: Overall and by pattern category
4. **Matching Setups**: Current tickers that match winning patterns

### Data Sources

- **Trade History**: Last 50 completed trades (WIN/LOSS)
- **Current Tickers**: All active tickers being monitored
- **Pattern Matching**: Compares current setups to historical winners

## Key Metrics Tracked

### Rank Patterns
- Groups trades by rank ranges (0-9, 10-19, 20-29, etc.)
- Calculates win rate per range
- Requires minimum 3 trades per range for statistical significance

### RR Patterns
- Groups by RR ranges:
  - RR ≥ 2.0 (excellent)
  - RR 1.5-2.0 (good)
  - RR 1.0-1.5 (acceptable)
  - RR < 1.0 (poor)
- Calculates win rate and total P&L per range

### Matching Setups
- Identifies current tickers that match best-performing patterns
- Combines rank range + RR range matching
- Surfaces top 5 matching setups

## Accessing the Data

The Self-Learning Module runs:
- **Every 15 minutes**: Proactive alerts with pattern insights
- **3x daily**: AI market updates (9:45 AM, noon, 3:30 PM ET) with full pattern analysis

### Stored Data Keys

- `timed:ai:update:YYYY-MM-DD:HH:MM` - Full AI updates with pattern analysis
- `timed:ai:alerts:YYYY-MM-DD` - High-priority alerts with pattern insights
- `timed:ai:updates:list` - List of recent updates (last 30)

## Using the Insights

### For Threshold Decisions

Before adjusting thresholds, check:
1. **Best Rank Pattern**: What rank range has highest win rate?
2. **Best RR Pattern**: What RR range performs best?
3. **Win Rate**: Overall win rate for completed trades

### Example Decision Process

If Self-Learning shows:
- Rank 70-79: 75% win rate (best)
- Rank 60-69: 60% win rate
- Rank 80-89: 65% win rate

**Recommendation**: Set `ALERT_MIN_RANK=70` to match best-performing pattern.

## Current Implementation

The module is integrated into:
- Scheduled AI updates (includes pattern analysis)
- Proactive alerts (references winning patterns)
- Trade simulation (could use patterns to adjust thresholds)

## Next Steps

To use Self-Learning insights for threshold decisions:
1. Query recent AI updates to see pattern analysis
2. Review win rates by rank/RR ranges
3. Adjust thresholds to match best-performing patterns
4. Consider making trade simulation use same thresholds as alerts
