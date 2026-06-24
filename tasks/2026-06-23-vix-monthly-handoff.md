# VIX + Monthly Freshness Handoff — 2026-06-23

## VIX (replaces VX1! TV futures)

| Before | After |
|--------|-------|
| VX1! TradingView futures heartbeat | **VIX** canonical key in UI/KV |
| Daily Brief charts: VIXY ETF proxy | **VIX** (mirrors VX1! stub) |
| TD quote attempted for VIX | **Skipped** — TD 404; VX1! is source |

**Files:** `worker/sector-mapping.js` (VIX in SECTOR_MAP), `worker/futures-proxy.js`
(`MACRO_CANONICAL_SOURCES`), `worker/twelvedata.js` (VIX in SKIP_TICKERS),
`worker/feed/price-feed-cron.js`, `worker/index.js` MARKET_PULSE_SYMS,
`react-app/daily-brief.html`, `react-app/today.html`.

Legacy `timed:latest:VX1!` still read as fallback where `pull("VX1!")` remains.

## Monthly candle health

**Symptom:** `/timed/health` showed M `p50_min` ~33k minutes mid-month.

**Reality:** Monthly bars stamp on the 1st; wall-clock age ~23 days was
**within SLO** (40 days) — misleading, not broken.

**Fix:** `worker/freshness.js` — `effectiveCandleAgeMs()` treats M/W bars
in the current calendar period as age **0**.

**Backfill (operator):**

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/wm-bootstrap" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{}'
# Poll: GET /timed/admin/wm-bootstrap/status?job_id=...
```

Daily 6 AM ET cron already refreshes M (`sinceDays=90`). Sunday 5 PM ET
runs deep W (3yr) + M (5yr).
