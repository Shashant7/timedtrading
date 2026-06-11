# KV Inspection

**WHEN to use:** You need to see what's actually stored in a KV key —
typically when troubleshooting "the API returns X but the UI shows Y"
or "did the cron actually write this?"

**Prerequisites:**
- `wrangler` (`node_modules/.bin/wrangler`)
- Cwd inside `worker/`

---

## KV namespaces in this project

| Binding | Purpose | Common keys |
|---|---|---|
| `KV` | Auth + sessions | `session:<sid>`, `user:<id>` |
| `KV_TIMED` | Ticker snapshots + live state | `timed:latest:<TICKER>`, `timed:prices`, `timed:all`, `timed:investor:rank`, `timed:options:cache:*` |
| `KV_TIMED_TRAIL` | 5m bar trail for Markov | `trail:<TICKER>:<bucket_ts>` |
| `KV_MODEL_CONFIG` | Operator-set model knobs | `model_config:gates`, `model_config:overlays` |

---

## Quick reads

```bash
cd /workspace/worker

# Read a specific key
../node_modules/.bin/wrangler kv key get --binding=KV_TIMED --env production "timed:latest:AMZN" | head -100

# Pretty-print
../node_modules/.bin/wrangler kv key get --binding=KV_TIMED --env production "timed:latest:AMZN" \
  | python3 -m json.tool | head -80

# List keys with prefix
../node_modules/.bin/wrangler kv key list --binding=KV_TIMED --env production --prefix "timed:options:cache:" \
  | python3 -m json.tool | head -40

# Count keys with prefix
../node_modules/.bin/wrangler kv key list --binding=KV_TIMED --env production --prefix "timed:latest:" \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"
```

---

## Useful key shapes

### `timed:latest:<TICKER>` — primary ticker snapshot

```json
{
  "ticker": "AMZN",
  "price": 180.5,
  "ts": 1780...,
  "investor_score": 60,
  "investor_score_breakdown": { "weeklyTrend": 0.8, ... },
  "rootStrategy": { "mode": "RIDE", "confluence": 0.62, ... },
  "tf_tech": { "D": {...}, "1H": {...}, "10m": {...}, "W": {...}, "M": {...} },
  "computedAt": 1780...
}
```

If a field is `null` / missing, the corresponding source data wasn't
available at last score. The most common gap is `tf_tech.W` or `tf_tech.M`
→ see [backfill-candles.md](backfill-candles.md).

### `timed:prices` — live price aggregate

```json
{
  "prices": {
    "AMZN": { "p": 180.5, "pc": 178.2, "dc": 2.3, "dp": 1.29, "ahp": 181.1, "ahdc": 0.6, "ahdp": 0.33, "t": 1780... },
    ...
  },
  "updated_at": 1780...
}
```

**Critical**: the data is at `.prices`, NOT at the top level. When reading
in code, always unwrap: `const livePrices = (await KV_TIMED.get("timed:prices", "json"))?.prices || {}`.

### `timed:investor:scores` — Investor kanban / `/timed/investor/scores`

Object keyed by ticker symbol (not an array). The Investor page reads this
KV blob, **not** `/timed/all`. A ticker can be absent from `/timed/all` but
still appear on Investor cards if this key was never cleaned.

After `POST /timed/admin/purge-ticker`, verify the symbol is gone:

```bash
curl -s -H "X-API-Key: $TIMED_TRADING_API_KEY" \
  "https://timed-trading-ingest.shashant.workers.dev/timed/investor/scores" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('DBA' in [t.get('ticker') for t in d.get('tickers',[])])"
```

Purge also clears `timed:investor:stages`, `rs-ranks`, and `prev-stages`.
See `tasks/lessons.md` → "June 2026 — Price display, purge hygiene".

### `timed:all` — universe snapshot for dashboards

```json
{
  "data": {
    "AMZN": { ... },
    "AAPL": { ... }
  },
  "updated_at": 1780...
}
```

**Critical**: this is **keyed by symbol**, not an array. To iterate:
`Object.entries(timed_all.data).map(([ticker, snap]) => ({ ticker, ...snap }))`.
Using `Object.values(timed_all.data).filter(t => t.ticker)` silently drops every entry — see CONTEXT.md.

### `timed:investor:rank` — ranked list for Investor Dashboard

Computed every 5 minutes by the scoring cron. Single-ticker `rescore-ticker`
does NOT update this — the rank rebuild handles it next cron tick.

---

## Writes

KV writes are rarely needed manually — go through the worker endpoints
instead, which include the right TTL / format / observability.

If you must:

```bash
cd /workspace/worker
echo '{"foo":"bar"}' | ../node_modules/.bin/wrangler kv key put \
  --binding=KV_TIMED --env production "timed:experiment:test" --path /dev/stdin
```

For destructive deletes, double-check the env:

```bash
../node_modules/.bin/wrangler kv key delete \
  --binding=KV_TIMED --env production "timed:experiment:test"
```

---

## Common pitfalls

- **Default vs production env** — `--env production` is the live one. Without
  it you talk to the `default` KV namespace (used by the workers.dev URL).
- **KV is eventually consistent (~60s globally).** A `put` from one POP may
  not be visible from another for up to a minute. Don't assume immediate
  read-your-write.
- **Don't store >25 MB in a single key.** KV's hard limit.

## Source

- `worker/wrangler.toml` → KV bindings
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "KV" entries
