# Delta One X Filtered Stream (worker ingest)

**WHEN to use:** Operating or debugging **@DeItaone** real-time wire ingest —
stream health, poll fallback, Discord `#general` posts, macro pulse KV, or
"why didn't a macro headline land?"

**Not this skill:** Interactive X queries in Cursor → [x-mcp-cursor.md](x-mcp-cursor.md).
Production ingest uses the **`DeltaOneStream` Durable Object** + `X_API_BEARER_TOKEN`.

**Prerequisites:**
- `TIMED_TRADING_API_KEY` (admin routes)
- Cloudflare secret `X_API_BEARER_TOKEN` on **monolith** (`timed-trading-ingest`)
- Optional: `DISCORD_GENERAL_WEBHOOK_URL` for new-wire Discord posts
- `wrangler` at `node_modules/.bin/wrangler`

---

## Architecture (30-second version)

```
@DeItaone X posts
  ├─ PRIMARY: DeltaOneStream DO (X Filtered Stream push, rule: from:DeItaone -is:retweet)
  │     → ingestDeltaOneStreamPosts → D1 x_wire_posts, ticker_news, macro actuals KV
  │     → macro-wire-intel LLM classify → timed:discovery:macro-wire-pulse
  │     → Discord #general, CRO/CIO, live rank tilt (macro-risk-tilt)
  └─ FALLBACK: timeline poll (fetchDeltaOnePosts) when stream off/unhealthy
        */1 healthy → 15m backup poll; hourly poll only when unhealthy
```

| Module | Path |
|---|---|
| Stream DO | `worker/discovery/delta-one-stream.js` |
| Stream client | `worker/discovery/x-wire-stream.js` |
| Ingest + poll | `worker/discovery/x-wire-tracker.js` |
| LLM classify + pulse | `worker/discovery/macro-wire-intel.js` |
| Rank overlay | `worker/macro-risk-tilt.js` |
| Cron + admin routes | `worker/index.js` |

**Worker topology:** `DELTA_ONE_STREAM` binding lives on the **monolith** only
(`worker/wrangler.toml`, migration `v7`). Stream keep-alive runs on monolith
`*/1` cron even when `PRICE_FEED_EXTERNAL=true` (tt-feed does not own this lane).
See [worker-topology.md](worker-topology.md).

---

## Deploy after worker changes

```bash
cd /workspace/worker
# dashboard-html.js must exist (gitignored); regenerate if missing:
# node ../scripts/embed-dashboard.js
../node_modules/.bin/wrangler deploy 2>&1 | tail -8
../node_modules/.bin/wrangler deploy --env production 2>&1 | tail -8
```

Both deploys must succeed. DO migration `v7` (`DeltaOneStream`) applies on first
deploy after the stream commit.

---

## Smoke test (post-deploy)

Set the API key once per shell:

```bash
export TIMED_API_KEY="${TIMED_TRADING_API_KEY}"
# Custom domain may return CF bot challenge to bare curl — use workers.dev for admin smoke tests:
BASE="https://timed-trading-ingest.shashant.workers.dev"
```

Admin routes accept `X-TT-Admin-Key` header **or** `?key=` query param.

### 1. Stream status

```bash
curl -sS "$BASE/timed/admin/discovery/x-wire/stream/status?key=$TIMED_API_KEY" \
  | python3 -m json.tool
```

**Healthy production:**

| Field | Expected |
|---|---|
| `enabled` | `true` |
| `healthy` | `true` |
| `stream.isRunning` | `true` |
| `stream.isStreaming` | `true` (or recent `connectedAt` / `lastPostAt`) |
| `stream.lastError` | `null` |

### 2. Start stream (idempotent)

```bash
curl -sS -X POST "$BASE/timed/admin/discovery/x-wire/stream/start?key=$TIMED_API_KEY" \
  | python3 -m json.tool
```

Re-check status after ~10s.

### 3. Recent posts (ingest path)

```bash
curl -sS "$BASE/timed/admin/discovery/x-wire/posts?handle=DeItaone&lookback_hours=24&key=$TIMED_API_KEY" \
  | python3 -m json.tool | head -60
```

Expect `ok: true` and recent rows when DeItaone has posted in the window.

### 4. Macro pulse KV (downstream)

```bash
cd /workspace/worker
../node_modules/.bin/wrangler kv key get --binding=KV_TIMED --env production \
  "timed:discovery:macro-wire-pulse" | python3 -m json.tool | head -40
```

Expect `risk_tone`, `posts[]` with `intel` when classify has run recently.

### 5. Manual poll fallback (outage drill)

```bash
curl -sS -X POST "$BASE/timed/admin/discovery/x-wire/refresh?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}' | python3 -m json.tool
```

Use when stream is unhealthy or `X_DELTA_ONE_STREAM_ENABLED=false`.

---

## Kill switches and secrets

| Var / secret | Where | Effect |
|---|---|---|
| `X_API_BEARER_TOKEN` | CF secret (monolith) | Required for stream + poll |
| `X_DELTA_ONE_STREAM_ENABLED` | CF var (default `true`) | `false` → poll-only mode |
| `DISCORD_GENERAL_WEBHOOK_URL` | CF secret | Wire posts to `#general` |

```bash
cd /workspace/worker
../node_modules/.bin/wrangler secret put X_API_BEARER_TOKEN --env production
```

---

## Poll cadence (cron)

| Trigger | Behavior |
|---|---|
| `*/1` (always) | `deltaOneStreamStart` every minute (24/7, independent of price-feed window) |
| `*/1` poll | Stream unhealthy → poll every minute (24/7); healthy → 15m backup **only inside** feed window |
| `*/5` (macro-release window, weekdays) | Same poll gate as `*/1` during 12–19 UTC |
| Hourly | Weekdays 11–22 UTC: poll when stream disabled/unhealthy; **weekends**: hourly check when unhealthy |
| Nightly batch (`tt-research`) | Always polls once (overnight catch-up) |

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `enabled: false` | `DELTA_ONE_STREAM` binding missing — redeploy monolith |
| `healthy: false`, `lastError: no_x_api_bearer_token` | Set `X_API_BEARER_TOKEN` secret |
| `healthy: false`, connect errors | X API quota / filtered-stream entitlement; try `POST .../stream/start` |
| Posts in D1 but no Discord | `DISCORD_GENERAL_WEBHOOK_URL` unset; or first backfill without `since_id` (poll only) |
| Weekend headlines missing | Fixed 2026-07-12: stream keepalive + unhealthy poll were gated behind `isPriceFeedCron` — redeploy monolith if still stale |
| Pulse empty | LLM classify path — check `macro-wire-intel` logs; `OPENAI_API_KEY` on worker |
| Duplicate posts | Should not happen — `INSERT OR IGNORE` on `post_id` |

### Stop stream (maintenance)

```bash
curl -sS -X POST "$BASE/timed/admin/discovery/x-wire/stream/stop?key=$TIMED_API_KEY" \
  | python3 -m json.tool
```

Poll fallback takes over automatically.

---

## Unit tests

```bash
cd /workspace
npm test -- worker/discovery/x-wire-stream.test.js \
  worker/discovery/x-wire-tracker.test.js \
  worker/discovery/macro-wire-intel.test.js
```

---

## Related skills

- [x-mcp-cursor.md](x-mcp-cursor.md) — Cursor IDE X MCP (Bearer)
- [kv-inspection.md](kv-inspection.md) — read `timed:discovery:macro-wire-pulse`
- [discord-alerts.md](discord-alerts.md) — webhook lanes
- [worker-topology.md](worker-topology.md) — which worker runs crons
- [deploy.md](deploy.md) — full deploy cycle
