# Rescore a Single Ticker

**WHEN to use:** A ticker's Trader Tab or Investor Tab shows stale data
(stale rank, missing layers, missing W/M components, zone is wrong) and
you want to force a recompute without waiting for the next scoring cron.

**Prerequisites:**
- `TIMED_TRADING_API_KEY` (admin)
- The ticker already exists in the universe (check `/timed/all`)
- Alpaca + TwelveData APIs reachable

---

## What "rescore" actually does

The `POST /timed/admin/rescore-ticker` endpoint:

1. Fetches **D / W / M** candle bundles from Alpaca (with the same
   limits + dedup as the nightly cron — 300W, 250M).
2. Calls `computeServerSideScores(tickerData, env)` to recompute:
   - 8-layer Root Strategy confluence (Lee/Newton/Markov/ICT/Carter/DeMark/SuperTrend/Saty)
   - Investor Score Breakdown (7 components: trend, momentum, value, quality, growth, sentiment, technical)
   - Trader Score + entry path + rank
   - Volume Profile (POC/VAH/VAL)
   - Markov regime forecast
3. Writes the result to `timed:latest:<TICKER>` KV blob.
4. Writes a snapshot to `timed:all` (merging into `data.<TICKER>`).
5. Returns the full computed payload + a diff against the previous KV
   value (so you can see what changed).

---

## Copy-paste

```bash
curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/rescore-ticker" \
  -H "Content-Type: application/json" \
  -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY" \
  -d '{"ticker":"AMZN"}' | python3 -m json.tool | head -60
```

---

## Verify it worked

The endpoint response includes a `scored` object. Spot-check:

```json
{
  "ok": true,
  "ticker": "AMZN",
  "scored": {
    "investor_score": 60,
    "investor_score_breakdown": {
      "weeklyTrend": 0.8,
      "monthlyTrend": 0.6,
      ...
    },
    "rootStrategy": { "mode": "RIDE", "confluence": 0.62, ... },
    "computedAt": 1780...
  },
  "kv_written": true,
  "delta": { "investor_score": "+40" }
}
```

If `investor_score_breakdown` still has zeros for `weeklyTrend` or
`monthlyTrend`, the **Weekly or Monthly bundle didn't build** — see
[backfill-candles.md](backfill-candles.md) for the wm-bootstrap pattern.

Then verify the UI:

```bash
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/investor/ticker?ticker=AMZN&key=$TIMED_TRADING_API_KEY" \
  | python3 -m json.tool | head -40
```

The `timed:investor:rank` KV (used by the Investor Dashboard) is rebuilt
on the next `*/5 * * * *` cron tick, so the dashboard may take up to 5
minutes to reflect a manual rescore.

---

## Common pitfalls

- **"It returned ok but the UI hasn't changed"** — `timed:investor:rank`
  is computed across the universe every 5 minutes. The single-ticker
  rescore updates the underlying snapshot but not the rank index. Wait
  for the cron or trigger it explicitly:
  ```bash
  curl -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/rebuild-investor-rank" \
    -H "X-TT-Admin-Key: $TIMED_TRADING_API_KEY"
  ```

- **"0s won't go away"** — the W/M bundle dedup threshold. Check
  `worker/index.js` → look for `tfConfigs` and `dedupedCandles >= 50`.
  If your changes still don't fix it, the source data is genuinely thin
  (rare; usually only for IPO'd-this-month tickers).

- **"It's slow"** — single-ticker rescore typically takes 2-4s (Alpaca
  fetch dominates). If it takes >10s, something is wrong with the
  Alpaca client — check `/timed/health → captureMinutesSinceLast`.

## Source

- `worker/index.js` → `POST /timed/admin/rescore-ticker` handler
- `worker/indicators.js` → `computeServerSideScores`
- `worker/alpaca.js` → `fetchAlpacaBars`
