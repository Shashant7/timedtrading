# Post-Deployment Monitoring Guide

## Quick Status Check

```bash
# Check health
curl https://timed-trading-ingest.shashant.workers.dev/timed/health | python3 -m json.tool

# Check a specific ticker (if you know one that fired)
curl "https://timed-trading-ingest.shashant.workers.dev/timed/latest?ticker=PH" | python3 -m json.tool

# Check ticker count
curl https://timed-trading-ingest.shashant.workers.dev/timed/tickers | python3 -m json.tool
```

## What to Monitor

### 1. Cloudflare Worker Logs

Look for these log patterns in order:

#### Successful Ingestion:
```
[INGEST REQUEST RECEIVED] IP: ...
[INGEST AUTH PASSED] Processing request from IP: ...
[INGEST RAW] <TICKER>: ...
[INGEST] <TICKER>: ...
[INGEST STORED] <TICKER> - latest data saved at ...
[INGEST COMPLETE] <TICKER> - added to index and stored
[ALERT EVAL] <TICKER>: { enhancedTrigger: ..., allConditionsMet: ... }
[INGEST SUCCESS] <TICKER> - completed successfully
```

#### If Alert Fires:
```
[DISCORD ALERT] Sending alert for <TICKER>
[DISCORD] Sending notification: TimedTrading 🎯 <TICKER> — ...
[DISCORD] Notification sent successfully
```

#### If Alert Doesn't Fire:
```
[ALERT EVAL] <TICKER>: { 
  enhancedTrigger: false,  // or true but other conditions failed
  rrOk: true/false,
  compOk: true/false,
  phaseOk: true/false,
  rankOk: true/false,
  allConditionsMet: false
}
[ALERT SKIPPED] <TICKER>: RR 1.2 < 1.5, Rank 65 < 70  // Example reasons
```

#### Errors:
```
[INGEST AUTH FAILED] IP: ...
[INGEST JSON PARSE FAILED] IP: ...
[INGEST VALIDATION FAILED] ...
[INGEST ERROR] ...
[DISCORD] Failed to send notification: ...
```

### 2. Check Ingestion Timestamps

After a ticker ingests, verify it has timestamp fields:

```bash
curl "https://timed-trading-ingest.shashant.workers.dev/timed/latest?ticker=PH" | python3 -m json.tool | grep -E "(ingest_ts|ingest_time)"
```

Should show:
```json
"ingest_ts": 1767805868328,
"ingest_time": "2025-01-08T12:34:56.789Z"
```

### 3. Verify Version Match

Check that version matches:
```bash
curl https://timed-trading-ingest.shashant.workers.dev/timed/health | python3 -m json.tool | grep -E "(dataVersion|expectedVersion)"
```

Should show:
```json
"dataVersion": "2.4.0",
"expectedVersion": "2.4.0"
```

### 4. Monitor Discord Alerts

If alerts aren't firing, check logs for:
- `[ALERT EVAL]` - Shows which conditions passed/failed
- `[DISCORD] Notifications disabled` - Discord not enabled
- `[DISCORD] Webhook URL not configured` - Missing webhook URL
- `[ALERT SKIPPED]` - Shows specific reasons why alert didn't fire

## Real-Time Monitoring

### Using Wrangler Tail (Recommended)
```bash
wrangler tail --format pretty
```

This shows live logs as requests come in.

### Using Cloudflare Dashboard
1. Go to Workers & Pages → Your Worker
2. Click "Logs" tab
3. Filter by:
   - `[INGEST` - All ingestion logs
   - `[ALERT` - Alert-related logs
   - `[DISCORD` - Discord logs
   - `[ERROR` - Error logs

## Troubleshooting

### No Ingestion Logs
- Check TradingView alert history - did alerts actually fire?
- Verify webhook URL in TradingView is correct
- Check TradingView alert status (enabled, conditions met, etc.)

### Authentication Failures
- Verify `TIMED_API_KEY` secret matches webhook URL `?key=` parameter
- Check logs for `[INGEST AUTH FAILED]`

### Discord Not Firing
1. Check `[ALERT EVAL]` logs - see which conditions failed
2. Verify Discord secrets:
   ```bash
   wrangler secret list
   ```
3. Check `[DISCORD]` logs for configuration issues
4. Test Discord webhook manually:
   ```bash
   curl -X POST "YOUR_DISCORD_WEBHOOK_URL" \
     -H "Content-Type: application/json" \
     -d '{"content": "Test message"}'
   ```

### Migration Still Running
- Check for `Background migration completed` log
- If migration takes >5 minutes, it's working on large dataset
- No action needed - it runs in background

## Expected Behavior

### Normal Flow
1. TradingView alert fires → Webhook POST to worker
2. Worker receives request → `[INGEST REQUEST RECEIVED]`
3. Auth passes → `[INGEST AUTH PASSED]`
4. Data processed → `[INGEST STORED]`
5. Alert evaluated → `[ALERT EVAL]`
6. If conditions met → `[DISCORD ALERT]` → Discord notification sent
7. Success → `[INGEST SUCCESS]`

### Timeline
- Request to success: < 1 second (typically)
- Migration: Background (doesn't block)
- Discord notification: < 2 seconds

## Next Steps

1. ✅ Wait for next TradingView alert to fire
2. ✅ Monitor logs for `[INGEST REQUEST RECEIVED]`
3. ✅ Verify `[INGEST SUCCESS]` appears
4. ✅ Check `[ALERT EVAL]` to see alert conditions
5. ✅ If alert should fire but doesn't, check `[ALERT SKIPPED]` reasons
6. ✅ Verify Discord secrets if alerts should fire
7. ✅ Check ticker data has `ingest_ts` and `ingest_time` fields

