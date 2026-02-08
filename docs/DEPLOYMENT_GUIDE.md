# Complete Deployment Guide

This guide walks you through deploying all three components of the Timed Trading system:
1. **TradingView** (Pine Script Indicator)
2. **Worker** (Cloudflare Worker Backend)
3. **UI** (React Dashboard)

---

## Prerequisites

Before starting, ensure you have:
- ✅ TradingView account (Pro or higher for webhooks)
- ✅ Cloudflare account (free tier works)
- ✅ Node.js installed (v18+)
- ✅ Git (if deploying UI via Pages)

---

## Part 1: TradingView Deployment

### Step 1.1: Open Pine Editor
1. Log into TradingView
2. Click "Pine Editor" at the bottom
3. Create a new script (or open existing)

### Step 1.2: Copy Script
1. Open `tradingview/TimedTrading_Unified.pine` (primary) or `tradingview/TimedTrading_ScoreEngine_Enhanced.pine`
2. Copy **entire contents**
3. Paste into Pine Editor
4. Click "Save"

### Step 1.3: Configure Webhook URL
1. In Pine Editor, find the alert configuration section
2. You'll need to set up an alert with webhook
3. The webhook URL format:
   ```
   https://YOUR-WORKER-URL.workers.dev/timed/ingest?key=YOUR_API_KEY
   ```
   ⚠️ **Note**: You'll get the actual URL after deploying the Worker (Part 2)

### Step 1.4: Set Up Alert
1. Add the indicator to a chart
2. Right-click on chart → "Add Alert"
3. Condition: "TimedTrading_Unified" (or your saved script name)
4. Webhook URL: (from Step 1.3)
5. Message: Use the JSON payload (the script sends it automatically)
6. Save alert

### Step 1.5: Test Alert
1. Apply to a chart (any ticker)
2. Wait for bar close
3. Check Worker logs (after deployment) to verify data received

### Step 1.6: Apply to Watchlist
1. Create or select a watchlist
2. Add indicator to all tickers in watchlist
3. Set up alerts for each (or use bulk alert setup if available)

**✅ TradingView Deployment Complete!**

---

## Part 2: Worker Deployment

### Step 2.1: Install Wrangler CLI
```bash
npm install -g wrangler
```

Verify installation:
```bash
wrangler --version
```

### Step 2.2: Login to Cloudflare
```bash
wrangler login
```

This opens a browser window for authentication.

### Step 2.3: Navigate to Worker Directory
```bash
cd worker
```

### Step 2.4: Create KV Namespace
```bash
wrangler kv:namespace create "KV_TIMED"
```

**Important**: Copy the `id` from the output. It looks like:
```
{ binding = "KV_TIMED", id = "abc123def456..." }
```

### Step 2.5: Update wrangler.toml
1. Open `worker/wrangler.toml`
2. Find the `[[kv_namespaces]]` section
3. Update the `id` with the value from Step 2.4:
   ```toml
   [[kv_namespaces]]
   binding = "KV_TIMED"
   id = "YOUR_NAMESPACE_ID_HERE"
   ```

### Step 2.6: Set Environment Secrets
Set the API key (required):
```bash
wrangler secret put TIMED_API_KEY
```
When prompted, enter a secure random string (e.g., generate with `openssl rand -hex 32`)

**Optional**: Discord webhook (for notifications):
```bash
wrangler secret put DISCORD_WEBHOOK_URL
wrangler secret put DISCORD_ENABLE
# For DISCORD_ENABLE, enter "true" to enable, "false" to disable
```

### Step 2.7: Deploy Worker
Deploy **must** be run from the `worker` directory so the entry point `index.js` is found (otherwise you may see "Missing entry-point to Worker script" or "No environment found in configuration with name 'production'"). Use the production environment so KV/D1 bindings and vars are applied.

**Option A** (from repo root):
```bash
npm run deploy:worker
```

**Option B** (from worker directory):
```bash
cd worker
wrangler deploy --env production
```

**Success Output**:
```
✨  Deployed to production
   https://timed-trading-ingest.YOUR_SUBDOMAIN.workers.dev
```

**✅ Copy this URL!** You'll need it for:
- TradingView webhook (Step 1.3)
- UI configuration (Part 3)

### Step 2.7a: Troubleshooting deploy
- **"Missing entry-point to Worker script"** — Wrangler can’t find `index.js`. Run deploy from the `worker` directory (e.g. `cd worker && wrangler deploy --env production`) or use `npm run deploy:worker` from the repo root.
- **"No environment found in configuration with name 'production'"** — You’re not in `worker/` so `worker/wrangler.toml` isn’t being read. Use one of the options in Step 2.7 (from root: `npm run deploy:worker`; or `cd worker` then `wrangler deploy --env production`).

### Step 2.8: Verify Deployment
Test the health endpoint:
```bash
curl https://YOUR-WORKER-URL.workers.dev/timed/health
```

Expected response:
```json
{
  "ok": true,
  "now": 1234567890,
  "lastIngestMs": 0,
  "minutesSinceLast": null,
  "tickers": 0
}
```

### Step 2.9: Test Ingest Endpoint
```bash
curl -X POST "https://YOUR-WORKER-URL.workers.dev/timed/ingest?key=YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ticker": "TEST",
    "ts": 1704067200000,
    "htf_score": 15.5,
    "ltf_score": 5.2,
    "state": "HTF_BULL_LTF_PULLBACK",
    "price": 100.0
  }'
```

Expected response:
```json
{
  "ok": true,
  "ticker": "TEST"
}
```

**✅ Worker Deployment Complete!**

---

## Part 3: UI Deployment

### Option A: Standalone (No Build Required)

#### Step 3A.1: Update API URL
1. Open `react-app/index-react.html`
2. Find line ~209 (search for `const API_BASE`)
3. Replace with your Worker URL:
   ```javascript
   const API_BASE = "https://YOUR-WORKER-URL.workers.dev";
   ```
4. Also update line ~1559 (trail endpoint):
   ```javascript
   const response = await fetch(`https://YOUR-WORKER-URL.workers.dev/timed/trail?ticker=...`);
   ```

#### Step 3A.2: Deploy to Cloudflare Pages
1. Go to Cloudflare Dashboard → Pages
2. Click "Create a project"
3. Connect your Git repository (or upload files)
4. Build settings:
   - **Framework preset**: None
   - **Build command**: (leave empty)
   - **Output directory**: `react-app`
   - **Root directory**: `/`
5. Click "Save and Deploy"

#### Step 3A.3: Alternative: Static Hosting
You can also host the HTML file on:
- GitHub Pages
- Netlify
- Any static file server
- Or open directly in browser (for testing)

**✅ UI Deployment Complete!**

---

### Option B: Full Vite Build (Recommended for Production)

#### Step 3B.1: Install Dependencies
```bash
cd react-app
npm install
```

#### Step 3B.2: Update API URL
1. Open `react-app/index-react.html`
2. Find line ~209: `const API_BASE = "..."`
3. Replace with your Worker URL
4. Also update line ~1559 (trail endpoint) with your Worker URL

#### Step 3B.3: Build for Production
```bash
npm run build
```

Output will be in `react-app/dist/`

#### Step 3B.4: Deploy dist/ Folder
Upload the `dist/` folder contents to:
- Cloudflare Pages
- Netlify
- Vercel
- Any static hosting

**✅ UI Deployment Complete!**

---

## Admin reset (Worker)

**Endpoint:** `POST /timed/admin/reset?key=YOUR_API_KEY`

Resets system state (KV simulated trades, paper portfolio, activity feed, per-ticker Kanban state). Lanes recompute from fresh state.

**Query params (optional):**
- **`resetLedger=1`** — Clears D1 ledger: deletes all rows in `trade_events`, `trades`, and `alerts`. Use when you want a completely empty ledger (no trades after reset). Without this, open trades are only archived (status → `ARCHIVED`); the UI hides archived trades so you see “no trades” either way.
- **`resetMl=1`** — Clears ML model and training queue (KV keys + D1 `ml_v1_queue`).

**Example (full ledger clear):**
```bash
curl -X POST "https://YOUR-WORKER-URL.workers.dev/timed/admin/reset?key=YOUR_API_KEY&resetLedger=1"
```

---

## Verification Checklist

### TradingView ✅
- [ ] Indicator loads without errors
- [ ] Alert created and saved
- [ ] Webhook URL configured correctly
- [ ] Test alert sent (check Worker logs)

### Worker ✅
- [ ] Wrangler login successful
- [ ] KV namespace created
- [ ] Secrets set (TIMED_API_KEY)
- [ ] Deployment successful
- [ ] Health endpoint returns 200
- [ ] Test ingest returns success

### UI ✅
- [ ] API URL updated
- [ ] Page loads without errors
- [ ] Data fetches from Worker
- [ ] Chart renders correctly
- [ ] Filters work
- [ ] Ticker details open

---

## Troubleshooting

### TradingView Issues

**Problem**: Alert not sending
- **Solution**: Check webhook URL format, ensure API key matches

**Problem**: Script errors
- **Solution**: Check Pine Script version (should be v6), verify all functions present

### Worker Issues

**Problem**: `wrangler deploy` fails
- **Solution**: 
  - Verify KV namespace ID in wrangler.toml
  - Check you're logged in: `wrangler whoami`
  - Ensure secrets are set: `wrangler secret list`

**Problem**: 401 Unauthorized on ingest
- **Solution**: Verify API key matches in secret and TradingView webhook

**Problem**: KV errors
- **Solution**: Check namespace binding in wrangler.toml matches code

### UI Issues

**Problem**: CORS errors
- **Solution**: Worker should have CORS headers (already included in code)

**Problem**: Data not loading
- **Solution**: 
  - Check browser console for errors
  - Verify API URL is correct
  - Test Worker endpoints directly with curl

**Problem**: Chart not rendering
- **Solution**: 
  - Check browser console
  - Verify Recharts CDN loaded
  - Ensure data format matches expected structure

---

## Post-Deployment Configuration

### 1. Update TradingView Webhook
Once Worker is deployed, update TradingView alert webhook URL:
```
https://YOUR-WORKER-URL.workers.dev/timed/ingest?key=YOUR_API_KEY
```

### 2. Monitor Worker Logs
```bash
wrangler tail
```

This shows real-time logs from your Worker.

### 3. Check Data Flow
1. Send test alert from TradingView
2. Check Worker logs: `wrangler tail`
3. Verify data in UI (should appear within 30 seconds)

### 4. Set Up Monitoring (Optional)
- Cloudflare Analytics (built-in)
- Set up alerts for Worker errors
- Monitor KV usage

---

## Quick Reference

### Worker URLs
- **Health**: `GET /timed/health`
- **All Data**: `GET /timed/all`
- **Latest**: `GET /timed/latest?ticker=SPY`
- **Trail**: `GET /timed/trail?ticker=SPY`
- **Momentum**: `GET /timed/momentum?ticker=SPY`

### Important Files
- **Pine Script**: `tradingview/TimedTrading_ScoreEngine_Enhanced.pine`
- **Worker Code**: `worker/index.js`
- **Worker Config**: `worker/wrangler.toml`
- **UI**: `react-app/index-react.html`

### Commands
```bash
# Worker (deploy from repo root or from worker/)
npm run deploy:worker
# Or: cd worker && wrangler deploy --env production

wrangler login
wrangler kv:namespace create "KV_TIMED"
wrangler secret put TIMED_API_KEY
wrangler tail

# UI (if using Vite)
cd react-app
npm install
npm run dev
npm run build
```

---

## Next Steps

1. ✅ Deploy all components
2. ✅ Verify data flow
3. ✅ Test with real tickers
4. ✅ Monitor performance
5. ✅ Set up alerts/notifications
6. ✅ Customize settings as needed

**🎉 Deployment Complete!**

