# Timed Trading CloudFlare Worker

This CloudFlare Worker handles data ingestion from TradingView alerts, stores data in KV, and sends Discord notifications when trading opportunities are detected.

## Setup

1. **Install Wrangler CLI** (if not already installed):
   ```bash
   npm install -g wrangler
   ```

2. **Login to CloudFlare**:
   ```bash
   wrangler login
   ```

3. **Create KV Namespace**:
   ```bash
   wrangler kv:namespace create "KV_TIMED"
   ```
   Update the `id` in `wrangler.toml` with the returned namespace ID.

4. **Set Environment Variables**:
   ```bash
   wrangler secret put TIMED_API_KEY
   wrangler secret put DISCORD_WEBHOOK_URL  # Optional
   wrangler secret put DISCORD_ENABLE  # Set to "true" to enable
   ```

5. **Deploy** (must run from `worker/` or use script so `index.js` is found):
   ```bash
   # From repo root:
   npm run deploy:worker
   # Or from this directory:
   wrangler deploy --env production
   ```
   Using `--env production` applies KV/D1 bindings and vars from `wrangler.toml`.

## API Endpoints

### POST `/timed/ingest?key=YOUR_API_KEY`
Ingest data from TradingView alerts. Requires `key` query parameter matching `TIMED_API_KEY`.

**Payload** (JSON):
```json
{
  "ticker": "SPY",
  "ts": 1704067200000,
  "htf_score": 15.5,
  "ltf_score": 5.2,
  "state": "HTF_BULL_LTF_PULLBACK",
  "price": 450.25,
  "trigger_price": 449.50,
  "sl": 448.00,
  "tp": 455.00,
  "completion": 0.15,
  "phase_pct": 0.30,
  "trigger_reason": "EMA_CROSS",
  "trigger_dir": "UP",
  "flags": {
    "sq30_on": true,
    "sq30_release": false,
    "phase_dot": true
  }
}
```

### GET `/timed/all`
Returns all tickers with their latest data.

### GET `/timed/latest?ticker=SPY`
Returns latest data for a specific ticker.

### GET `/timed/tickers`
Returns list of all tracked tickers.

### GET `/timed/trail?ticker=SPY`
Returns historical trail data for a ticker (last 8 points).

### GET `/timed/top?bucket=long|short|setup&n=10`
Returns top N tickers by rank for a specific bucket:
- `long`: Q2 (HTF_BULL_LTF_BULL)
- `short`: Q3 (HTF_BEAR_LTF_BEAR)
- `setup`: Q1/Q4 (HTF_BULL_LTF_PULLBACK / HTF_BEAR_LTF_PULLBACK)

### GET `/timed/health`
Health check endpoint showing last ingest time and ticker count.

## Alert Logic

Discord alerts are sent when ALL of the following conditions are met:

1. **Corridor Entry**: Ticker is in LONG corridor (HTF>0, LTF -8 to 12) or SHORT corridor (HTF<0, LTF -12 to 8)
2. **Alignment**: Corridor side matches state alignment (LONG corridor → Q2, SHORT corridor → Q3)
3. **Trigger**: One of:
   - Entered aligned state (Q2 or Q3)
   - Trigger reason is `EMA_CROSS` or `SQUEEZE_RELEASE`
   - Squeeze release flag is true
4. **Thresholds**:
   - RR ≥ `ALERT_MIN_RR` (default: 1.5)
   - Completion ≤ `ALERT_MAX_COMPLETION` (default: 0.4)
   - Phase ≤ `ALERT_MAX_PHASE` (default: 0.6)
   - Rank ≥ `ALERT_MIN_RANK` (default: 70)

## Corridor Definitions

- **LONG Corridor**: HTF > 0, LTF between -8 and 12
- **SHORT Corridor**: HTF < 0, LTF between -12 and 8

These must match the UI corridors defined in `index.html`.

