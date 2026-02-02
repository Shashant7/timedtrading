# AMD Alert Investigation

## Summary
AMD was identified as a candidate for alerts but did not trigger. Investigation reveals why.

## Current Status

### AMD Current Data (as of investigation)
- **State**: HTF_BULL_LTF_BULL ✅ (Aligned)
- **HTF Score**: 20.26 ✅ (> 0)
- **LTF Score**: 19.68 ❌ (> 12, OUT of LONG corridor)
- **Rank**: 84 ✅ (≥ 70)
- **RR**: 4.38 ✅ (≥ 1.5)
- **Completion**: 0% ✅ (≤ 40%)
- **Phase**: 14% ✅ (≤ 60%)
- **Trigger Reason**: SQUEEZE_RELEASE ✅
- **Data Age**: 0.11 hours ✅ (Not backfill)
- **Existing Trade**: None ✅

### Why AMD Didn't Alert

**Root Cause**: AMD's LTF score moved OUT of the corridor range.

- **Earlier Data**: LTF = 8.57 (IN corridor: -8 to 12) ✅
- **Current Data**: LTF = 19.68 (OUT of corridor: > 12) ❌

When the alert logic evaluated AMD, it was no longer in the LONG corridor because LTF > 12.

## Alert Systems

There are TWO separate alert systems:

### 1. Trading Opportunity Alert (Lines 5522-5620)
- Fires during ingestion when conditions are met
- Checks `inCorridor` at time of ingestion
- Deduplicated by `trigger_ts`
- Key: `timed:alerted:{ticker}:{trigger_ts}`

### 2. Trade Entry Alert (Lines 2320-2337)
- Fires when `processTradeSimulation()` creates a new trade
- Checks `shouldTriggerTradeSimulation()` which requires `inCorridor`
- Only fires if NOT a backfill

## The Problem

AMD's LTF score changed from 8.57 to 19.68, moving it OUT of the corridor. This could happen:

1. **Between data snapshots**: LTF changed between when `/timed/all` was fetched and when alerts were evaluated
2. **During ingestion**: LTF changed during the ingestion process
3. **After initial evaluation**: Alert conditions were met initially, but LTF moved out before alert was sent

## Potential Solutions

### Option 1: Alert on Corridor Entry (Recommended)
Alert when a ticker ENTERS the corridor, not just when it's already in corridor.

**Pros**:
- Catches opportunities as they develop
- Less likely to miss due to score changes
- More timely alerts

**Cons**:
- May alert on false entries
- Requires tracking previous state

### Option 2: Use Historical Trigger Data
When evaluating alerts, check if the ticker was in corridor at the time of the trigger (using `trigger_ts`).

**Pros**:
- More accurate to actual signal timing
- Less affected by current score changes

**Cons**:
- Requires storing historical score data
- More complex logic

### Option 3: Alert Window
Allow alerts for tickers that were in corridor within a recent time window (e.g., last 5 minutes).

**Pros**:
- Catches opportunities that briefly exit corridor
- Handles rapid score changes

**Cons**:
- May alert on stale opportunities
- Requires time-based tracking

## Recommendation

**Implement Option 1**: Alert when tickers ENTER the corridor.

This would require:
1. Tracking previous corridor state (`prevInCorridor`)
2. Alerting when `!prevInCorridor && inCorridor` AND other conditions met
3. This is already partially implemented for activity feed tracking

## Next Steps

1. Review if AMD was ever in corridor when trigger occurred
2. Check worker logs for AMD ingestion to see exact timing
3. Consider implementing corridor entry alerts
4. Monitor for similar cases where tickers move out of corridor quickly
