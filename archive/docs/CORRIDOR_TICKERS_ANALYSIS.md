# Tickers Already in Corridor - Analysis
**Date:** January 12, 2026

## Summary

There are **MANY tickers already in corridors** with excellent metrics that **SHOULD be alerting** but aren't because they're missing trigger conditions.

## The Problem

For tickers **already in corridor** (not just entering), the alert logic requires:
1. ✅ In corridor: Yes
2. ✅ Corridor aligned: Yes (LONG corridor → Q2, SHORT corridor → Q3)
3. ❌ **Trigger condition:** One of:
   - `enteredAligned` (just entered aligned state) - **Won't happen if already in corridor**
   - `trigOk` (trigger_reason is EMA_CROSS or SQUEEZE_RELEASE)
   - `sqRel` (squeeze release flag is true)
   - `hasTrigger` (has trigger_price and trigger_ts)

**Issue:** If a ticker is already in corridor and aligned, but doesn't have a recent trigger event, it won't alert even if all thresholds are met.

## Tickers in LONG Corridor Meeting Thresholds

### Fully Aligned (HTF_BULL_LTF_BULL) - Should Alert But Don't:

1. **AWI**
   - RR: 4.00 ✅
   - Completion: 0.19 ✅
   - Rank: 73 ✅
   - Phase: 0.41 ✅
   - State: HTF_BULL_LTF_BULL ✅
   - **Missing:** Trigger event (EMA_CROSS, SQUEEZE_RELEASE, or has trigger_price)

2. **ITT**
   - RR: 5.80 ✅
   - Completion: 0.17 ✅
   - Rank: 76 ✅
   - Phase: 0.23 ✅
   - State: HTF_BULL_LTF_BULL ✅
   - **Missing:** Trigger event

3. **MTZ**
   - RR: 6.02 ✅
   - Completion: 0.04 ✅
   - Rank: 71 ✅
   - Phase: 0.04 ✅
   - State: HTF_BULL_LTF_BULL ✅
   - **Missing:** Trigger event

4. **XLV**
   - RR: 10.13 ✅
   - Completion: 0.02 ✅
   - Rank: 71 ✅
   - Phase: 0.28 ✅
   - State: HTF_BULL_LTF_BULL ✅
   - **Missing:** Trigger event

5. **XLY**
   - RR: 3.35 ✅
   - Completion: 0.30 ✅
   - Rank: 68 ⚠️ (below 70, but close)
   - Phase: 0.35 ✅
   - State: HTF_BULL_LTF_BULL ✅
   - **Missing:** Trigger event + Rank slightly low

### In Pullback (HTF_BULL_LTF_PULLBACK) - Need to Enter Aligned:

6. **CDNS**
   - RR: 15.57 ✅
   - Completion: 0.14 ✅
   - Rank: 74 ✅
   - Phase: 0.07 ✅
   - State: HTF_BULL_LTF_PULLBACK (not fully aligned)
   - **Missing:** Needs to enter HTF_BULL_LTF_BULL state

7. **BK**
   - RR: 6.44 ✅
   - Completion: 0.05 ✅
   - Rank: 63 ⚠️ (below 70)
   - Phase: 0.27 ✅
   - State: HTF_BULL_LTF_PULLBACK
   - **Missing:** Needs to enter aligned state + Rank slightly low

## Tickers in SHORT Corridor

1. **VIX**
   - RR: 0.01 ❌ (way below 1.5)
   - Completion: 0.01 ✅
   - Rank: 75 ✅
   - Phase: 0.06 ✅
   - State: HTF_BEAR_LTF_BEAR ✅
   - **Blocked by:** RR too low

2. **NFLX**
   - RR: 0.004 ❌ (way below 1.5)
   - Completion: 0.02 ✅
   - Rank: 57 ❌ (below 70)
   - Phase: 0.39 ✅
   - State: HTF_BEAR_LTF_PULLBACK
   - **Blocked by:** RR too low, Rank too low

## Root Cause

The alert logic requires a **trigger event** even for tickers already in good positions:
- If a ticker is already in corridor and aligned, it needs a recent trigger (EMA_CROSS, SQUEEZE_RELEASE, or has trigger_price)
- This means tickers that are already in perfect setups won't alert until they get a new trigger event

## Recommendation

**Option 1: Alert on "Already in Corridor + Aligned + All Thresholds Met"**
- Remove the trigger requirement for tickers already in corridor and aligned
- If they meet all thresholds, alert immediately
- This would catch tickers like AWI, ITT, MTZ, XLV

**Option 2: Periodic Re-evaluation**
- Re-evaluate tickers already in corridor every N minutes
- If they meet thresholds and are aligned, alert (even without new trigger)

**Option 3: Lower Trigger Requirements for Already-Aligned Tickers**
- For tickers already in corridor and aligned, accept `hasTrigger` (has trigger_price) as sufficient
- Currently requires EMA_CROSS or SQUEEZE_RELEASE specifically

## Immediate Action Items

1. **Check if these tickers have trigger_price set:**
   - If they do, the `hasTrigger` condition should be met
   - If not, that's why they're not alerting

2. **Consider modifying alert logic** to alert on:
   - Tickers already in corridor + aligned + all thresholds met
   - Even without a recent trigger event

3. **Review logs** to see if these tickers ever had trigger events that were missed
