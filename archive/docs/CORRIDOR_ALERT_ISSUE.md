# Critical Issue: Tickers Already in Corridor Not Alerting

## The Problem

**5+ tickers are already in corridors with EXCELLENT metrics but NOT alerting:**

1. **AWI**: RR=4.0, Completion=0.19, Rank=73, Phase=0.41, State=HTF_BULL_LTF_BULL ✅
2. **ITT**: RR=5.80, Completion=0.17, Rank=76, Phase=0.23, State=HTF_BULL_LTF_BULL ✅
3. **MTZ**: RR=6.02, Completion=0.04, Rank=71, Phase=0.04, State=HTF_BULL_LTF_BULL ✅
4. **PEGA**: RR=5.70, Completion=0.05, Rank=76, Phase=0.11, State=HTF_BULL_LTF_BULL ✅
5. **XLV**: RR=10.13, Completion=0.02, Rank=71, Phase=0.28, State=HTF_BULL_LTF_BULL ✅

All have:
- ✅ In LONG corridor
- ✅ Fully aligned (HTF_BULL_LTF_BULL)
- ✅ Trigger reason (EMA_CROSS or SQUEEZE_RELEASE)
- ✅ Has trigger_price and trigger_ts
- ✅ All thresholds met (RR ≥ 1.5, Completion ≤ 0.4, Rank ≥ 70, Phase ≤ 0.6)

## Root Cause

**The `computeRRAtTrigger()` function is returning LOW RR values (0.05-0.21) instead of high values (4.0-6.0).**

### Example: AWI
- Current price: $199.95
- Trigger price: $194.47
- SL: $193.3
- TP: $200.31
- **Current RR (from payload.rr):** 4.0 ✅
- **RR at trigger (computed):** Should be ~5.0, but showing 0.05 ❌

### Why This Happens

When price moves UP after trigger:
- **At trigger price:** Risk = $1.17, Gain = $5.84, RR = 5.0 ✅
- **At current price:** Risk = $6.65, Gain = $0.36, RR = 0.05 ❌

The system uses `computeRRAtTrigger()` which should use trigger_price, but it's calculating RR as if using current price, OR the TP is too close to current price.

### The Bug

Looking at AWI:
- TP = $200.31
- Current price = $199.95
- **Gain remaining = $0.36** (very small!)

If `computeRRAtTrigger()` is using current price instead of trigger_price, or if TP is being calculated incorrectly, it will show very low RR.

## Solution

**Option 1: Use payload.rr for alerts (if it's calculated at trigger)**
- The payload.rr value (4.0) is correct
- Use this instead of recalculating

**Option 2: Fix computeRRAtTrigger()**
- Ensure it's using trigger_price, not current price
- Check if TP is being calculated correctly

**Option 3: Use MAX of (RR at trigger, RR at current)**
- Alert if EITHER RR value meets threshold
- This catches setups that were good at trigger even if price moved

## Immediate Fix Needed

These tickers SHOULD be alerting right now. They're in perfect setups but the RR calculation is blocking them.
