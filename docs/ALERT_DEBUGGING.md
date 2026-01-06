# Discord Alert Debugging Guide

## Why Alerts Might Not Fire

Discord alerts have **strict conditions** that ALL must be met. If any condition fails, no alert is sent.

## Alert Conditions Checklist

### 1. Discord Configuration ✅
- `DISCORD_ENABLE` must be set to `"true"` (not just `true`, must be string)
- `DISCORD_WEBHOOK_URL` must be set to a valid Discord webhook URL

**Check:**
```bash
# Check if Discord is enabled
curl "https://YOUR-WORKER.workers.dev/timed/alert-debug?ticker=AAPL"
# Look for: "discord.enabled": true, "discord.urlSet": true
```

### 2. Corridor Entry ✅
Ticker must be in entry corridor:
- **LONG Corridor**: HTF > 0 AND LTF between -8 and 12
- **SHORT Corridor**: HTF < 0 AND LTF between -12 and 8

### 3. Corridor Alignment ✅
Corridor side must match state alignment:
- **LONG corridor** → Must be in Q2 (`HTF_BULL_LTF_BULL`)
- **SHORT corridor** → Must be in Q3 (`HTF_BEAR_LTF_BEAR`)

### 4. Trigger Condition ✅
At least ONE of these must be true:
- **Entered aligned state** (just transitioned to Q2 or Q3)
- **Trigger reason** is `EMA_CROSS` or `SQUEEZE_RELEASE`
- **Squeeze release flag** is true (`sq30_release: true`)

### 5. Threshold Requirements ✅
ALL of these must pass:
- **RR ≥ 1.5** (default, configurable via `ALERT_MIN_RR`)
- **Completion ≤ 0.4** (default, configurable via `ALERT_MAX_COMPLETION`)
- **Phase ≤ 0.6** (default, configurable via `ALERT_MAX_PHASE`)
- **Rank ≥ 70** (default, configurable via `ALERT_MIN_RANK`)

## Debug Endpoint

Use the debug endpoint to see exactly why alerts aren't firing:

```bash
curl "https://YOUR-WORKER.workers.dev/timed/alert-debug?ticker=AAPL"
```

**Response shows:**
- Whether alert would fire (`wouldAlert: true/false`)
- Discord configuration status
- Each condition's status (pass/fail)
- Current values vs required thresholds
- All relevant data

**Example Response:**
```json
{
  "ok": true,
  "ticker": "AAPL",
  "wouldAlert": false,
  "discord": {
    "enabled": true,
    "urlSet": true,
    "configured": true
  },
  "conditions": {
    "inCorridor": true,
    "side": "LONG",
    "corridorAlignedOK": true,
    "enteredAligned": false,
    "trigOk": false,
    "sqRel": false,
    "shouldConsiderAlert": false,  // ← FAILED: No trigger condition
    "rrOk": { "value": 2.1, "required": 1.5, "ok": true },
    "compOk": { "value": 0.3, "required": 0.4, "ok": true },
    "phaseOk": { "value": 0.5, "required": 0.6, "ok": true },
    "rankOk": { "value": 75, "required": 70, "ok": true }
  }
}
```

## Common Issues

### Issue 1: Discord Not Enabled
**Symptom**: `discord.enabled: false`
**Fix**: Set `DISCORD_ENABLE` to `"true"` (string, not boolean)

```bash
wrangler secret put DISCORD_ENABLE
# Enter: true
```

### Issue 2: No Webhook URL
**Symptom**: `discord.urlSet: false`
**Fix**: Set `DISCORD_WEBHOOK_URL`

```bash
wrangler secret put DISCORD_WEBHOOK_URL
# Enter: https://discord.com/api/webhooks/...
```

### Issue 3: Not in Corridor
**Symptom**: `inCorridor: false`
**Reason**: HTF/LTF scores don't meet corridor criteria
**Fix**: Wait for ticker to enter corridor, or adjust corridor definitions

### Issue 4: No Trigger Condition
**Symptom**: `shouldConsiderAlert: false`
**Reason**: Not entered aligned, no EMA_CROSS, no SQUEEZE_RELEASE
**Fix**: Wait for trigger condition, or make trigger logic less restrictive

### Issue 5: Threshold Not Met
**Symptom**: One of `rrOk`, `compOk`, `phaseOk`, or `rankOk` is false
**Reason**: Value exceeds threshold
**Fix**: Lower threshold or wait for better setup

**Example**: Rank is 65 but `ALERT_MIN_RANK` is 70
```bash
# Lower threshold
wrangler secret put ALERT_MIN_RANK
# Enter: 60
```

## Making Alerts Less Restrictive

If alerts are too rare, you can:

1. **Lower thresholds:**
   ```bash
   wrangler secret put ALERT_MIN_RANK
   # Enter: 60 (instead of 70)
   
   wrangler secret put ALERT_MAX_COMPLETION
   # Enter: 0.5 (instead of 0.4)
   ```

2. **Remove trigger requirement** (modify worker code):
   - Change `shouldConsiderAlert` to not require trigger
   - This will alert on any corridor entry with good thresholds

3. **Add more trigger conditions** (modify worker code):
   - Add other trigger reasons
   - Make trigger logic less strict

## Testing Alerts

1. **Check a specific ticker:**
   ```bash
   curl "https://YOUR-WORKER.workers.dev/timed/alert-debug?ticker=SPY"
   ```

2. **Check Discord config:**
   ```bash
   curl "https://YOUR-WORKER.workers.dev/timed/health"
   # Check if Discord is mentioned (it won't be, but you can verify worker is running)
   ```

3. **Manually trigger test** (modify worker temporarily):
   - Add test alert in worker code
   - Or use Discord webhook tester

## Expected Alert Frequency

Alerts are **intentionally rare** because they require:
- Perfect corridor entry
- Alignment match
- Trigger condition
- All thresholds met

**Normal behavior:**
- 0-5 alerts per day (depending on market conditions)
- More alerts during volatile periods
- Fewer alerts during choppy markets

If you want more alerts, lower the thresholds or relax the trigger requirements.

## Quick Check

Run this to see why alerts aren't firing for your top tickers:

```bash
# Get top tickers
curl "https://YOUR-WORKER.workers.dev/timed/top?bucket=long&n=5"

# Check each one
curl "https://YOUR-WORKER.workers.dev/timed/alert-debug?ticker=SPY"
curl "https://YOUR-WORKER.workers.dev/timed/alert-debug?ticker=QQQ"
# etc.
```

This will show you exactly which condition is blocking alerts.

