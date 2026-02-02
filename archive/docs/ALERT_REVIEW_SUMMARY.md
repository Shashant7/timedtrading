# Alert & Trade Entry Review Summary
**Date:** January 12, 2026

## Executive Summary

**Discord Alerts Status:** ❌ **NOT WORKING** - No alerts sent
**Trade Entries Status:** ❌ **NOT WORKING** - No trades created

## Key Findings

### 1. Discord Alerts
- **Status:** Alerts are being evaluated but **NONE are being sent**
- **Reason:** All tickers are being blocked by threshold requirements

### 2. Trade Entries
- **Status:** Trade simulation is running but **NO trades are being created**
- **Reason:** `shouldTrigger=false` for all tickers evaluated

### 3. Data Ingestion
- **Status:** ⚠️ **CONCERN** - No recent POST requests to `/timed/ingest` found in logs
- **Implication:** TradingView alerts may not be reaching the worker

## Alert Thresholds (Current Requirements)

For an alert to be sent, ALL of these must be met:

1. **Corridor Entry:** 
   - LONG: HTF > 0, LTF between -8 and 12
   - SHORT: HTF < 0, LTF between -12 and 8

2. **Alignment:** 
   - Corridor side must match state (LONG corridor → Q2, SHORT corridor → Q3)

3. **Trigger Condition (one of):**
   - Entered aligned state (Q2 or Q3)
   - Trigger reason is `EMA_CROSS` or `SQUEEZE_RELEASE`
   - Squeeze release flag is true
   - Has trigger_price and trigger_ts

4. **Thresholds:**
   - **RR ≥ 1.5** (Momentum Elite: ≥ 1.2)
   - **Completion ≤ 0.4** (Momentum Elite: ≤ 0.5)
   - **Phase ≤ 0.6** (Momentum Elite: ≤ 0.7)
   - **Rank ≥ 70** (Momentum Elite: ≥ 60)

## Tickers Evaluated (From Logs)

### Tickers That Were Considered But Blocked:

1. **JCI**
   - ✅ In corridor: Yes
   - ✅ Should consider alert: Yes
   - ❌ **Blocked by:** RR (0.05 < 1.5), Completion (0.52 > 0.5)

2. **NKE**
   - ✅ In corridor: Yes
   - ✅ Should consider alert: Yes
   - ❌ **Blocked by:** RR (0.15 < 1.5)

3. **ANET**
   - ✅ In corridor: Yes
   - ✅ Should consider alert: Yes
   - ❌ **Blocked by:** RR (0.22 < 1.5)

4. **XLY**
   - ✅ In corridor: Yes
   - ✅ Should consider alert: Yes
   - ❌ **Blocked by:** RR (0.01 < 1.5)

5. **NFLX**
   - ❌ Should consider alert: No (trigger conditions not met)
   - ❌ **Blocked by:** Trigger conditions, RR (0.03 < 1.5), Rank (59 < 60)

6. **XLV**
   - ❌ Should consider alert: No (trigger conditions not met)
   - ❌ **Blocked by:** Trigger conditions, RR (0.20 < 1.5)

### Trade Entry Candidates (From Logs):

1. **ALLY**
   - Entry price: $44.57
   - Entry RR: 1.11 (below 1.5 threshold)
   - Current RR: 0.00
   - **Result:** ❌ shouldTrigger=false

2. **HII**
   - Entry price: $394.45
   - Entry RR: 1.68 (above 1.5 threshold ✅)
   - Current RR: 0.06
   - **Result:** ❌ shouldTrigger=false (other conditions not met)

3. **VST**
   - Entry price: $174.16
   - Entry RR: 2.35 (above 1.5 threshold ✅)
   - Current RR: 0.16
   - **Result:** ❌ shouldTrigger=false (other conditions not met)

## Root Cause Analysis

### Primary Issue: Low RR Values
- **Most common blocker:** RR values are too low (0.01 - 0.22 vs required 1.5)
- **Why:** Current price may have moved significantly from trigger price, reducing RR
- **Solution:** System uses `computeRRAtTrigger()` to evaluate RR at entry point, but current RR is what's being checked

### Secondary Issues:
1. **High Completion:** Some tickers (JCI) have completion > 0.4 threshold
2. **Low Rank:** Some tickers (NFLX) have rank < 70 threshold
3. **Trigger Conditions:** Many tickers don't meet trigger conditions (not aligned, no EMA_CROSS, no squeeze release)

## Recommendations

### Immediate Actions:

1. **Check Discord Configuration:**
   ```bash
   # Verify DISCORD_ENABLE and DISCORD_WEBHOOK_URL are set
   wrangler secret list
   ```

2. **Check TradingView Alert Status:**
   - Verify TradingView alerts are firing
   - Check webhook URL is correct
   - Verify API key is valid

3. **Review Alert Thresholds:**
   - Consider if RR threshold (1.5) is too high
   - Consider if completion threshold (0.4) is too low
   - Consider if rank threshold (70) is too high

### Long-term Improvements:

1. **Add Alert Debugging Endpoint:**
   - `/timed/alert-debug?ticker=XYZ` - Shows why alerts aren't firing

2. **Improve Logging:**
   - Log when alerts WOULD fire but are blocked
   - Log Discord configuration status on startup
   - Log when TradingView alerts are received

3. **Consider Alerting on "Near Misses":**
   - Alert when tickers are close to meeting criteria
   - This helps identify when thresholds might be too strict

## Next Steps

1. ✅ Review this summary
2. ⏳ Check Discord webhook configuration
3. ⏳ Verify TradingView alerts are being sent
4. ⏳ Review threshold values (may be too strict)
5. ⏳ Check if any tickers SHOULD have alerted based on current data
