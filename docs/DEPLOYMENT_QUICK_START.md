# Quick Start Deployment

## TL;DR - Deploy in 10 Minutes

### 1. Worker (5 min)
```bash
cd worker
npm install -g wrangler
wrangler login
wrangler kv:namespace create "KV_TIMED"
# Copy the ID, update wrangler.toml
wrangler secret put TIMED_API_KEY
# Enter a secure key (save it!)
wrangler deploy
# Copy the URL: https://YOUR-WORKER.workers.dev
```

### 2. TradingView (3 min)
1. Open Pine Editor
2. Paste `tradingview/TimedTrading_ScoreEngine_Enhanced.pine`
3. Save
4. Add to chart → Create Alert
5. Webhook URL: `https://YOUR-WORKER.workers.dev/timed/ingest?key=YOUR_API_KEY`

### 3. UI (2 min)
1. Open `react-app/index-react.html`
2. Line 209: Update `API_BASE` to your Worker URL
3. Line 1559: Update trail endpoint to your Worker URL
4. Deploy to Cloudflare Pages (or any static host)

**Done!** 🎉

---

## Detailed Steps

See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) for complete instructions.

