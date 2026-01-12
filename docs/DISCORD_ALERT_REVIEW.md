# Discord Alert Logic Review

## Summary
This document reviews the Discord alert logic for entry, trim, and exit conditions to ensure alerts fire correctly.

## Alert Types

### 1. Entry Alerts (Trade Creation)
**When:** A new trade is created via `processTradeSimulation()`

**Conditions Required:**
- `shouldTriggerTradeSimulation()` returns `true`:
  - ✅ In corridor (LONG: HTF>0, LTF -8 to 12) OR (SHORT: HTF<0, LTF -12 to 8)
  - ✅ Corridor aligned with state (LONG corridor → Q2, SHORT corridor → Q3)
  - ✅ Trigger condition met:
    - Entered aligned state (Q2/Q3), OR
    - `trigger_reason` is `EMA_CROSS` or `SQUEEZE_RELEASE`, OR
    - Squeeze release flag is true, OR
    - Has `trigger_price` and `trigger_ts`
  - ✅ RR ≥ 1.5 (or ≥ 1.2 for Momentum Elite)
  - ✅ Completion ≤ 0.4 (or ≤ 0.5 for Momentum Elite)
  - ✅ Phase ≤ 0.6 (or ≤ 0.7 for Momentum Elite)
  - ✅ Rank ≥ 70 (or ≥ 60 for Momentum Elite)
- ✅ NOT a backfill (data older than 1 hour)
- ✅ No existing open trade with similar entry price (<5% difference)
- ✅ No recent trade within 1 hour
- ✅ No duplicate trade with similar entry price (<0.5% difference)

**Alert Sent:** `createTradeEntryEmbed()` → `notifyDiscord()`

### 2. Trim Alerts (TP Hit - 50% Trim)
**When:** Trade status changes from `OPEN` to `TP_HIT_TRIM`

**Conditions Required:**
- ✅ Trade exists and is OPEN
- ✅ Price hits first TP level (25% trim)
- ✅ Status change detected

**Alert Sent:** `createTradeTrimmedEmbed()` → `notifyDiscord()`

### 3. Exit Alerts (Trade Closed)
**When:** Trade status changes to `WIN` or `LOSS`

**Conditions Required:**
- ✅ Trade exists
- ✅ Price hits SL or final TP, OR
- ✅ TD Sequential exit signal detected
- ✅ Status change detected (from OPEN/TP_HIT_TRIM to WIN/LOSS)

**Alert Sent:** `createTradeClosedEmbed()` → `notifyDiscord()`

**Special:** If TD Sequential exit, also sends `createTD9ExitEmbed()`

## Discord Configuration

### Required Environment Variables
1. **`DISCORD_ENABLE`**: Must be exactly `"true"` (string)
   - Check: `wrangler secret get DISCORD_ENABLE`
   - Set: `wrangler secret put DISCORD_ENABLE` (enter `true`)

2. **`DISCORD_WEBHOOK_URL`**: Valid Discord webhook URL
   - Check: `wrangler secret get DISCORD_WEBHOOK_URL`
   - Set: `wrangler secret put DISCORD_WEBHOOK_URL` (paste webhook URL)

### Verification
The `notifyDiscord()` function will log:
- `[DISCORD] Notifications disabled` if `DISCORD_ENABLE !== "true"`
- `[DISCORD] Webhook URL not configured` if URL is missing
- `[DISCORD] ✅ Notification sent successfully` if successful
- `[DISCORD] Failed to send notification` if HTTP error

## Debugging Steps

### 1. Check Discord Configuration
```bash
# Check if Discord is enabled
wrangler secret get DISCORD_ENABLE

# Check webhook URL (will show if set)
wrangler secret get DISCORD_WEBHOOK_URL
```

### 2. Check Worker Logs
Look for these log messages in Cloudflare Workers logs:

**Entry Alerts:**
- `[TRADE SIM] ✅ Creating new trade` - Trade created
- `[TRADE SIM] 📢 Preparing entry alert` - Alert being prepared
- `[DISCORD] ✅ Notification sent successfully` - Alert sent

**Blocked Entry Alerts:**
- `[ALERT BLOCKED]` - Shows which condition failed
- `[TRADE SIM] ❌ Conditions not met` - Trade simulation conditions failed
- `[TRADE SIM] ⚠️ Skipping Discord alert - backfill trade` - Backfill detected

**Trim/Exit Alerts:**
- `[TRADE SIM] 📢 Preparing trim alert` - Trim alert
- `[TRADE SIM] 📢 Preparing exit alert` - Exit alert
- `[DISCORD] ✅ Notification sent successfully` - Alert sent

### 3. Common Issues

**Issue: No Entry Alerts**
- Check if `DISCORD_ENABLE` is set to `"true"` (not `true` or `"True"`)
- Check if conditions are met (RR, completion, phase, rank thresholds)
- Check if trades are being created (`[TRADE SIM] ✅ Creating new trade`)
- Check if backfill detection is blocking alerts
- Check if duplicate prevention is blocking alerts

**Issue: No Trim/Exit Alerts**
- Check if trades exist and are updating
- Check if status changes are being detected
- Check Discord configuration (same as entry alerts)

**Issue: Alerts Sent But Not Received**
- Verify webhook URL is correct
- Check Discord server webhook settings
- Check if webhook was deleted or rate-limited
- Check Cloudflare Workers logs for HTTP errors

## Enhanced Logging Added

The following enhanced logging has been added to help diagnose issues:

1. **Alert Blocking Logs**: Shows exactly which condition is blocking alerts
   ```
   [ALERT BLOCKED] TICKER: Alert blocked by: RR (1.2 < 1.5), Rank (65 < 70)
   ```

2. **Discord Notification Logs**: More detailed logging of Discord send attempts
   ```
   [DISCORD] ✅ Notification sent successfully: 🎯 Trade Entered: TICKER LONG
   ```

3. **Trade Simulation Logs**: Logs when alerts are being prepared
   ```
   [TRADE SIM] 📢 Preparing entry alert for TICKER LONG
   ```

## Testing Checklist

- [ ] `DISCORD_ENABLE` is set to `"true"`
- [ ] `DISCORD_WEBHOOK_URL` is set and valid
- [ ] Entry alerts fire when conditions are met
- [ ] Trim alerts fire when TP is hit
- [ ] Exit alerts fire when trade closes
- [ ] TD9 exit alerts fire when TD Sequential signals exit
- [ ] Backfill trades don't trigger entry alerts
- [ ] Duplicate prevention works correctly
- [ ] Logs show clear reasons when alerts are blocked

## Next Steps

1. Verify Discord configuration is correct
2. Check worker logs for any blocked alerts
3. Test with a ticker that meets all conditions
4. Monitor logs for the enhanced diagnostic messages
