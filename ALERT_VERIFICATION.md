# Alert System Verification

## ✅ Deployment Status

- **Worker**: Deployed successfully
- **KV Bindings**: Configured (e48593af3ef74bf986b2592909ed40cb)
- **Endpoints**: Working (39 trades, 135 tickers)
- **Code**: 11,346 lines deployed

## 📋 Alert Logic Review

### Alert Conditions (ALL must be met):

1. **Corridor Entry** (`enteredCorridor` OR `inCorridor`):
   - LONG: HTF > 0, LTF between -8 and 12
   - SHORT: HTF < 0, LTF between -12 and 8

2. **Trigger Condition** (`enhancedTrigger`):
   - Entered aligned state (Q2 for LONG, Q3 for SHORT) OR
   - EMA_CROSS trigger OR
   - Squeeze release OR
   - Momentum Elite in corridor

3. **Thresholds** (from environment variables):
   - **RR** (`rrOk`): ≥ ALERT_MIN_RR (default: 1.5, Momentum Elite: ≥ 1.2)
   - **Completion** (`compOk`): ≤ ALERT_MAX_COMPLETION (default: 0.4, ME: ≤ 0.5)
   - **Phase** (`phaseOk`): ≤ ALERT_MAX_PHASE (default: 0.6, ME: ≤ 0.7)
   - **Rank** (`rankOk`): ≥ ALERT_MIN_RANK (default: 70, ME: ≥ 60)

### RR Calculation:
- Uses `computeRRAtTrigger()` - calculates RR at trigger_price
- This ensures alerts evaluate RR at entry point, not current price

### Alert Deduplication:
- Key: `timed:alerted:${ticker}:${YYYY-MM-DD}`
- TTL: 48 hours
- Result: One alert per ticker per day

## 🔍 Current Status

Based on alert candidate check:
- **0 tickers** currently meet all alert conditions
- **10 tickers** are close but blocked by thresholds:
  - AWI, CSX, GEV, JCI, PI, RGLD, VIX, XLY (thresholds)
  - ITT, XLV (backfill - data older than 1 hour)

## ⚙️ Environment Variables Required

Verify these are set in Cloudflare Dashboard:
- `DISCORD_ENABLE=true`
- `DISCORD_WEBHOOK_URL=<your webhook URL>`
- `ALERT_MIN_RR=1.5` (or your preferred value)
- `ALERT_MAX_COMPLETION=0.4`
- `ALERT_MAX_PHASE=0.6`
- `ALERT_MIN_RANK=60` (you mentioned this was set to 60)

## 🔔 Discord Message Types

1. **"Trade Entered"**: System automatically created a trade
2. **"Trading Opportunity"**: Alert to consider entering manually

## ✅ Verification Steps

1. **Check Environment Variables**:
   - Dashboard -> Workers & Pages -> timed-trading-ingest -> Settings -> Variables
   - Verify DISCORD_ENABLE=true and DISCORD_WEBHOOK_URL is set

2. **Monitor Logs**:
   ```bash
   cd worker
   wrangler tail timed-trading-ingest
   ```
   Look for:
   - `[ALERT EVAL]` - Shows alert evaluation for each ticker
   - `[ALERT BLOCKED]` - Shows why alerts are blocked
   - `[DISCORD ALERT]` - Shows when alerts are sent

3. **Check Activity Feed**:
   - Should show `discord_alert` events when alerts fire
   - Should show `trade_entry` events when trades are created

4. **Wait for New Data**:
   - Alerts fire when tickers ENTER corridor
   - Need fresh data from TradingView (every 5 minutes)
   - If no tickers are entering corridor, no alerts will fire

