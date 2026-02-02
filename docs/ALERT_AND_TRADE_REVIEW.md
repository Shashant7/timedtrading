# Alert and Trade Tracking Review

## ✅ Fixes Applied

### 1. Activity Feed - Trade Entry Logging
- **Issue**: Trade entries (like PLTR) were not appearing in Activity Feed
- **Fix**: Added `appendActivity` call after Discord alert is sent for trade entries
- **Location**: `worker/index.js` line ~2587
- **Result**: All trade entries now log to Activity Feed with type `trade_entry`

### 2. Activity Feed - Cache Busting
- **Issue**: Activity Feed gets stuck on first hard refresh
- **Fix**: Enhanced cache busting with:
  - Timestamp parameter in URL (`?_t=${timestamp}`)
  - Additional `X-Request-ID` header
  - Existing cache headers (Cache-Control, Pragma, Expires)
- **Location**: `react-app/index-react.html` line ~3449
- **Result**: Activity Feed should load reliably on hard refresh

### 3. Activity Feed - Filter Tags
- **Issue**: No way to filter Activity Feed by event type
- **Fix**: Added filter tags:
  - All (default)
  - Trade Entered
  - Discord Alert
  - Corridor
  - Squeeze
  - Momentum Elite
- **Location**: `react-app/index-react.html` line ~3676
- **Result**: Users can filter Activity Feed by event type

### 4. Trade Entry Event Type Support
- **Issue**: `trade_entry` events not displayed properly
- **Fix**: Added support for `trade_entry` in:
  - `getEventIcon()` - Returns ✅ icon
  - `getEventColor()` - Returns green color
  - `getEventLabel()` - Returns "Trade Entered: TICKER DIRECTION"
- **Location**: `react-app/index-react.html` lines ~3554-3623

## 📋 Alert Logic Review

### Alert Conditions (ALL must be met):

1. **Corridor Entry** (`enteredCorridor`):
   - Ticker enters LONG corridor (HTF>0, LTF -8 to 12) OR
   - Ticker enters SHORT corridor (HTF<0, LTF -12 to 8)

2. **Trigger Condition** (`enhancedTrigger`):
   - Entered aligned state (Q2 for LONG, Q3 for SHORT) OR
   - EMA_CROSS trigger OR
   - Squeeze release OR
   - Momentum Elite in corridor

3. **Thresholds**:
   - **RR** (`rrOk`): ≥ 1.5 (Momentum Elite: ≥ 1.2)
   - **Completion** (`compOk`): ≤ 0.4 (Momentum Elite: ≤ 0.5)
   - **Phase** (`phaseOk`): ≤ 0.6 (Momentum Elite: ≤ 0.7)
   - **Rank** (`rankOk`): ≥ 60 (Momentum Elite: ≥ 50)

### RR Calculation:
- **For Alerts**: Uses `computeRRAtTrigger()` - calculates RR at trigger_price
- **Why**: When price moves UP after trigger, using current price decreases RR incorrectly
- **Example**: Trigger at 177.52, current at 182.68 → RR at trigger = 5.80, RR at current = 0.21

### Alert Deduplication:
- **Key**: `timed:alerted:${ticker}:${YYYY-MM-DD}`
- **TTL**: 48 hours
- **Result**: One alert per ticker per day

## 🔔 Discord Message Types

### 1. "Trade Entered" (from Trade Simulation)
- **When**: A trade is automatically created by `processTradeSimulation`
- **Title**: "Trade Entered: TICKER DIRECTION"
- **Meaning**: The system has automatically entered a simulated trade
- **Action**: This is a CONFIRMATION that a trade was created
- **Location**: `worker/index.js` line ~2568 (`createTradeEntryEmbed`)

### 2. "Trading Opportunity" (from Alert Evaluation)
- **When**: A ticker meets alert conditions but NO trade is created yet
- **Title**: "Trading Opportunity: TICKER DIRECTION"
- **Meaning**: This is an ALERT/OPPORTUNITY to consider entering manually
- **Action**: This is a SIGNAL to evaluate and potentially enter manually
- **Location**: `worker/index.js` line ~5890 (`opportunityEmbed`)

### Key Difference:
- **Trade Entered** = System already created the trade (automatic)
- **Trading Opportunity** = Alert to consider entering manually (manual decision)

## 🔍 Trade Tracking

### Trade Storage:
- **Key**: `timed:trades:all`
- **Format**: Array of trade objects
- **Fields**: ticker, direction, entryPrice, sl, tp, entryTime, status, rank, rr, etc.

### Activity Feed Logging:
- **Trade Entry**: Logged when trade is created (`type: "trade_entry"`)
- **Discord Alert**: Logged when alert is sent (`type: "discord_alert"`)
- **Trade Trim**: Logged when position is trimmed
- **Trade Close**: Logged when position is closed

### Why PLTR Trade Might Not Show:
1. **Check Trade Tracker**: Verify trade exists in `/timed/trades` endpoint
2. **Check Activity Feed**: Verify `trade_entry` event exists
3. **Check Date Range**: Trade Tracker filters by date range (default: today)
4. **Check Trade Status**: Trade might be filtered if status is not "OPEN"

## ✅ Verification Steps

1. **Deploy Worker**:
   ```bash
   cd worker
   wrangler deploy --env production
   ```

2. **Test Activity Feed**:
   - Hard refresh dashboard (Cmd+Shift+R)
   - Check Activity Feed loads on first try
   - Verify filter tags work
   - Check for "Trade Entered" events

3. **Test Alerts**:
   - Monitor logs: `wrangler tail timed-trading-ingest`
   - Look for `[ALERT EVAL]` messages
   - Check Discord for alerts
   - Verify Activity Feed shows `discord_alert` events

4. **Test Trade Tracking**:
   - Check `/timed/trades` endpoint for PLTR trade
   - Verify Trade Tracker shows PLTR trade
   - Check Activity Feed for `trade_entry` event

## 📊 Expected Behavior

### When a Trade is Created:
1. ✅ Trade saved to KV (`timed:trades:all`)
2. ✅ Discord alert sent ("Trade Entered")
3. ✅ Activity Feed event logged (`trade_entry`)
4. ✅ Trade appears in Trade Tracker

### When an Alert Fires:
1. ✅ Discord alert sent ("Trading Opportunity")
2. ✅ Activity Feed event logged (`discord_alert`)
3. ⚠️ Trade may or may not be created (depends on conditions)

