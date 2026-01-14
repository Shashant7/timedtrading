# Reviewing Cloudflare Worker Logs

This guide helps you access and analyze Cloudflare Worker logs to diagnose Discord alert issues.

## Quick Start

## Prerequisite: Enable Worker Logs in Cloudflare

Cloudflare **does not stream any logs** to the Dashboard “Logs” tab (or to `wrangler tail`) unless **Worker Logs are enabled** for the worker.

1. Go to **Cloudflare Dashboard** → **Workers & Pages** → `timed-trading-ingest`
2. Open **Settings** → **Observability** (or **Logs** depending on UI)
3. **Enable Worker Logs** (sometimes shown as “Tail logs” / “Workers Logs”)

After enabling, use the commands below.

### Option 1: Using Wrangler CLI (Recommended)

1. **Install Wrangler** (if not already installed):
   ```bash
   npm install -g wrangler
   ```

2. **Authenticate**:
   ```bash
   wrangler login
   ```

3. **Fetch logs**:
   ```bash
   cd worker
   wrangler tail --env production --format pretty > logs.txt
   ```
   
   Or use the helper script:
   ```bash
   bash scripts/fetch-worker-logs.sh > logs.txt
   ```

4. **Analyze logs**:
   ```bash
   node scripts/analyze-logs.js logs.txt
   ```

### Option 2: Cloudflare Dashboard

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages** > **timed-trading-ingest**
3. Click on the **Logs** tab
4. Filter for relevant keywords:
   - `DISCORD` - Discord configuration and alerts
   - `ALERT` - Alert evaluation and blocking
   - `corridor` - Corridor entry/exit events
   - `enteredCorridor` - Tickers entering corridor

5. Copy logs and save to a file, then analyze:
   ```bash
   node scripts/analyze-logs.js logs.txt
   ```

## What to Look For

### 1. Discord Configuration

Look for these log messages:
- `[DISCORD CONFIG]` - Shows Discord enable status
- `[DISCORD] Notifications disabled` - DISCORD_ENABLE not set to "true"
- `[DISCORD] Webhook URL not configured` - DISCORD_WEBHOOK_URL missing

**Fix**: Set environment variables:
```bash
cd worker
wrangler secret put DISCORD_ENABLE
# Enter: true

wrangler secret put DISCORD_WEBHOOK_URL
# Enter: your Discord webhook URL
```

### 2. Alert Blocking

Look for `[ALERT BLOCKED]` messages:
- Shows which ticker is blocked and why
- Common blockers:
  - `RR (X < 1.5)` - Risk/Reward too low
  - `Completion (X > 0.4)` - Completion too high
  - `Phase (X > 0.6)` - Phase too high
  - `Rank (X < 70)` - Rank too low

### 3. Alert Evaluation

Look for `[ALERT EVAL]` messages:
- Shows all conditions evaluated for each ticker
- `allConditionsMet: true` means alert should fire
- `allConditionsMet: false` means alert is blocked

### 4. Corridor Entries

Look for `corridor_entry` events:
- Shows when tickers enter the corridor
- If many entries but no alerts, check thresholds

### 5. Discord Alerts Sent

Look for `[DISCORD ALERT] Sending alert`:
- Confirms alerts are being sent
- If missing, check configuration and blockers

## Diagnostic Scripts

### diagnose-alerts.js
Analyzes current ticker data to find potential alert candidates:
```bash
node scripts/diagnose-alerts.js          # All tickers
node scripts/diagnose-alerts.js AMD      # Specific ticker
```

### analyze-logs.js
Analyzes log files for patterns:
```bash
node scripts/analyze-logs.js logs.txt
```

## Common Issues

### Issue: No Discord alerts despite many tickers in corridor

**Check**:
1. Discord configuration (see above)
2. Alert thresholds (RR, Completion, Phase, Rank)
3. Trigger conditions (must have EMA_CROSS, SQUEEZE_RELEASE, or entered aligned state)

**Debug**:
```bash
# Check specific ticker
node scripts/diagnose-alerts.js TICKER

# Check alert debug endpoint
curl "https://timed-trading-ingest.shashant.workers.dev/timed/alert-debug?ticker=TICKER"
```

### Issue: Alerts being deduplicated

**Check**: Look for `[DISCORD ALERT] Skipped` messages
- Alerts are deduplicated by ticker + timestamp
- Same ticker won't alert twice within 24 hours for same trigger

### Issue: Thresholds too strict

**Adjust**: Set environment variables:
```bash
cd worker
wrangler secret put ALERT_MIN_RR          # Default: 1.5
wrangler secret put ALERT_MAX_COMPLETION   # Default: 0.4
wrangler secret put ALERT_MAX_PHASE       # Default: 0.6
wrangler secret put ALERT_MIN_RANK         # Default: 70
```

## Live Monitoring

To monitor logs in real-time:
```bash
cd worker
wrangler tail --format pretty
```

Filter for specific patterns:
```bash
wrangler tail --format pretty | grep -E "(DISCORD|ALERT)"
```

## Next Steps

1. Fetch logs using one of the methods above
2. Run the analysis script to identify issues
3. Check Discord configuration
4. Review blockers for tickers in corridor
5. Adjust thresholds if needed
6. Redeploy worker after changes
