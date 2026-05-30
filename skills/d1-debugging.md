# D1 Debugging

**WHEN to use:** You suspect a D1 read/write is wrong (missing column,
empty result, wrong join), or you need to look up something in the
authoritative DB.

**Prerequisites:**
- `wrangler` (run via `node_modules/.bin/wrangler`)
- Cwd inside `worker/` (wrangler reads `wrangler.toml` from there)

---

## Quick reads via wrangler

```bash
cd /workspace/worker

# List all tables in production D1
../node_modules/.bin/wrangler d1 execute --env production timed-trading \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"

# Show schema of one table
../node_modules/.bin/wrangler d1 execute --env production timed-trading \
  --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='ai_cio_decisions';"

# Read recent rows
../node_modules/.bin/wrangler d1 execute --env production timed-trading \
  --command "SELECT trade_id, ticker, decision, confidence, created_at FROM ai_cio_decisions ORDER BY created_at DESC LIMIT 10;"
```

**`--env production`** matters — without it you query the default env,
which has its own (empty/test) D1.

---

## Useful read recipes

### Recent closed trades

```sql
SELECT trade_id, ticker, direction, entry_price, exit_price,
       pnl_usd, exit_reason, exit_ts
FROM trades
WHERE exit_ts IS NOT NULL
ORDER BY exit_ts DESC
LIMIT 25;
```

### Open positions

```sql
SELECT ticker, direction, entry_price, qty, opened_at,
       trimmed_pct, mfe_pct, mae_pct
FROM trades
WHERE exit_ts IS NULL
ORDER BY opened_at DESC;
```

### AI CIO win/loss when live (exclude replays)

```sql
SELECT decision,
       COUNT(*) AS n,
       SUM(CASE WHEN trade_outcome='WIN' THEN 1 ELSE 0 END) AS wins
FROM ai_cio_decisions
WHERE COALESCE(is_replay, 0) = 0
  AND trade_outcome IS NOT NULL
GROUP BY decision;
```

The `COALESCE(is_replay, 0) = 0` filter is critical — backtest replays
pollute the table and inflate counts. See PR #380 lessons.

### Stale candles (per ticker, last D candle older than N hours)

```sql
SELECT ticker, MAX(ts) AS last_ts,
       (strftime('%s','now')*1000 - MAX(ts)) / 3600000 AS hours_stale
FROM ticker_candles
WHERE timeframe = 'D'
GROUP BY ticker
HAVING hours_stale > 48
ORDER BY hours_stale DESC
LIMIT 20;
```

---

## Writes (use sparingly)

```bash
# ALTER TABLE — wrap in try/catch in code; from CLI just be careful
cd /workspace/worker
../node_modules/.bin/wrangler d1 execute --env production timed-trading \
  --command "ALTER TABLE ai_cio_decisions ADD COLUMN is_replay INTEGER DEFAULT 0;"

# Delete a single bad row (e.g. duplicate trade id)
../node_modules/.bin/wrangler d1 execute --env production timed-trading \
  --command "DELETE FROM trades WHERE trade_id = 'bad-id-here';"
```

For multi-row migrations, use the `_migrations/` folder (committed) and
run via `wrangler d1 migrations apply`.

---

## Common pitfalls

- **`db.batch()` max ~500** — chunk larger writes into batches of 400.
- **No unbounded window functions on big tables** — `ROW_NUMBER() OVER
  (PARTITION BY ticker)` on `ticker_candles` (millions of rows) will
  OOM the D1 query. Add `WHERE timeframe='D' AND ts >= ?` first.
- **`ALTER TABLE ADD COLUMN` may fail if column exists** — always wrap
  in try/catch (code) or use `PRAGMA table_info(table)` to check first.
- **D1 is SQLite, not PostgreSQL** — no `RETURNING` (newer SQLite has it,
  D1's runtime doesn't), no `IF NOT EXISTS` on `ADD COLUMN`, no `INSERT
  ON CONFLICT UPDATE` with multiple columns easily.

## Source

- `worker/wrangler.toml` → D1 bindings (`timed-trading` is the prod DB)
- Lessons: [`tasks/lessons.md`](../tasks/lessons.md) → "D1" entries
