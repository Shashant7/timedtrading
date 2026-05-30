# Backfill Candles (D / W / M / 10m)

**WHEN to use:** A ticker is showing 0s in Investor Score Breakdown, a
weekly/monthly indicator is blank, Mission Control flags it as "stale",
or you've just added a new ticker and need its initial history.

**Prerequisites:**
- `TIMED_TRADING_API_KEY` env var set (admin key)
- Worker is deployed and `/timed/health` returns ok
- Alpaca data subscription is healthy (the source for backfill)

---

## Decision tree

```
Single ticker, recent stale candle (e.g. yesterday missing)
  → "Refresh stale ticker" button in Mission Control → Status Grid section
  OR  POST /timed/admin/alpaca-backfill   { "ticker": "BK", "days": 5 }

Single ticker, missing W/M for Investor Tab
  → POST /timed/admin/rescore-ticker      { "ticker": "AMZN" }
  (fetches W+M from Alpaca, recomputes Investor & Trader scores, writes
   timed:latest:AMZN — the scoring cron does the same job nightly)

Entire universe, missing W/M after schema change / first-time setup
  → POST /timed/admin/wm-bootstrap        { }  (fire-and-forget, job_id returned)
  → Poll GET /timed/admin/wm-bootstrap/status?job_id=...

Single ticker, 10m candles missing for replay/intraday
  → POST /timed/admin/replay-ticker-d1    { "ticker": "X", "days": 30 }
```

---

## Copy-paste commands

```bash
# Refresh one ticker's daily candles (last 5 trading days)
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/alpaca-backfill" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{"ticker":"BK","days":5}'

# Rescore one ticker (full W/M/D refresh + investor + trader)
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/rescore-ticker" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{"ticker":"AMZN"}'

# Universe W/M bootstrap (fire-and-forget)
JOB=$(curl -s -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/wm-bootstrap" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" | python3 -c "import json,sys;print(json.load(sys.stdin)['job_id'])")
# Poll status
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/wm-bootstrap/status?job_id=$JOB" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" | python3 -m json.tool
```

---

## Verify it worked

After backfill, the ticker should:

1. **Show non-zero Investor Score Breakdown components** for Weekly + Monthly:
   ```bash
   curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/investor/ticker?ticker=AMZN&key=$TIMED_TRADING_API_KEY" \
     | python3 -m json.tool | grep -A2 weeklyTrend
   ```
2. **Have a recent `timed:latest:TICKER` KV blob**:
   ```bash
   # Via wrangler (requires worker dir CWD)
   cd worker && ../node_modules/.bin/wrangler kv key get \
     --binding=KV_TIMED --env production "timed:latest:AMZN" | head -50
   ```

---

## Common pitfalls

- **`/options/chain` 404 from TwelveData** — TD options chain is unreliable.
  Use Alpaca (default since PR #374). Don't reinvent the TD fallback chain.
- **Weekly/Monthly bundles need ≥50 deduped candles** — Alpaca returns
  duplicate monthly bars. `tfConfigs` in scoring cron uses W limit 300, M
  limit 250 to survive dedup. If you tweak these, check
  `worker/index.js` lines ~10580 + `rescore-ticker` handler.
- **`wm-bootstrap` blocks if not fire-and-forget** — always use the
  `job_id` polling pattern. The endpoint uses `ctx.waitUntil` so the HTTP
  response returns within ms.
- **Backfill before replay** — `replay-ticker-d1` reads from D1; if 10m
  candles are missing, replay processes zero rows and silently exits.

## Source

- `worker/index.js` — handlers for `alpaca-backfill`, `rescore-ticker`, `wm-bootstrap`
- `worker/alpaca.js` — `fetchAlpacaBars` (Alpaca data API client)
- `worker/indicators.js` — `computeServerSideScores` (the scoring entry point)
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "AMZN Investor Tab zeros" entry
