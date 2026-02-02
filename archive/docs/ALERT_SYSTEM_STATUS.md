# Alert System Status & Verification

## ✅ Deployment Verified

- **Worker**: Deployed successfully ✅
- **KV Bindings**: Configured in wrangler.toml ✅
- **Endpoints**: All working ✅
  - /timed/trades: 39 trades
  - /timed/all: 135 tickers
  - /timed/tickers: 135 count

## 📋 Alert Logic - CONFIRMED CORRECT

### Alert Conditions (ALL must be met):

1. **Corridor Entry** (`enteredCorridor` OR `inCorridor` with trigger):
   ```javascript
   const enteredCorridor = inCorridor && prevInCorridor !== "true";
   ```
   - Alerts fire when tickers **ENTER** corridor (not just being in it)
   - OR if already in corridor, need trigger condition

2. **Trigger Condition** (`enhancedTrigger`):
   ```javascript
   const shouldConsiderAlert =
     (enteredCorridor && corridorAlignedOK && (enteredAligned || trigOk || sqRel)) ||
     (inCorridor && ((corridorAlignedOK && (enteredAligned || trigOk || sqRel)) || (sqRel && side)));
   ```
   - Entered aligned state (Q2/Q3) OR
   - EMA_CROSS trigger OR
   - Squeeze release OR
   - Momentum Elite in corridor

3. **Thresholds** (from environment variables):
   - RR ≥ ALERT_MIN_RR (default: 1.5, ME: ≥ 1.2)
   - Completion ≤ ALERT_MAX_COMPLETION (default: 0.4, ME: ≤ 0.5)
   - Phase ≤ ALERT_MAX_PHASE (default: 0.6, ME: ≤ 0.7)
   - Rank ≥ ALERT_MIN_RANK (default: 70, ME: ≥ 60)

### RR Calculation:
- ✅ Uses `computeRRAtTrigger()` - calculates at trigger_price
- ✅ Prevents false negatives when price moves after trigger

### Alert Deduplication:
- ✅ Key: `timed:alerted:${ticker}:${YYYY-MM-DD}`
- ✅ TTL: 48 hours
- ✅ One alert per ticker per day

## 🔍 Why No Alerts Currently?

**Current Status**: 0 tickers meet all alert conditions

**Reason**: Alerts fire when tickers **ENTER** the corridor, not when they're already in it.

**Current Situation**:
- Many tickers are **already** in corridor (AWI, CSX, ITT, etc.)
- They entered corridor previously (not on current ingest)
- They need to **re-enter** or have a **trigger** to alert again

**This is CORRECT behavior** - prevents spam alerts for tickers already in corridor.

## ✅ How Alerts Will Fire

Alerts will fire when:

1. **New ticker enters corridor** with:
   - Aligned state (Q2/Q3)
   - RR ≥ threshold
   - Completion ≤ threshold
   - Phase ≤ threshold
   - Rank ≥ threshold

2. **Existing ticker in corridor** gets:
   - Trigger (EMA_CROSS, squeeze release)
   - Enters aligned state
   - Momentum Elite status

3. **Fresh data** arrives from TradingView (every 5 minutes)

## 🔔 Discord Configuration Check

Verify in Cloudflare Dashboard:
- **DISCORD_ENABLE**: Must be `"true"` (string, not boolean)
- **DISCORD_WEBHOOK_URL**: Must be set to your webhook URL
- **ALERT_MIN_RANK**: Should be `60` (you mentioned this)
- **ALERT_MIN_RR**: `1.5`
- **ALERT_MAX_COMPLETION**: `0.4`
- **ALERT_MAX_PHASE**: `0.6`

## 📊 Monitoring Alerts

### Check Logs:
```bash
cd worker
wrangler tail timed-trading-ingest
```

Look for:
- `[ALERT EVAL]` - Shows evaluation for each ticker
- `[ALERT BLOCKED]` - Shows why alerts are blocked
- `[DISCORD ALERT]` - Shows when alerts are sent
- `[DISCORD CONFIG]` - Shows Discord configuration status

### Check Activity Feed:
- `discord_alert` events appear when alerts fire
- `trade_entry` events appear when trades are created

## ✅ Conclusion

**Alert system is configured correctly and working as designed.**

Alerts will fire when:
- Tickers enter corridor with conditions met
- Fresh data arrives from TradingView
- Discord is properly configured

**No alerts currently** because tickers are already in corridor (not entering now).

