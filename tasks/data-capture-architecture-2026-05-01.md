# Data Capture Architecture (2026-05-01)

> **Goal**: every trade row, in every backtest, captures every entry-time
> signal we want to analyze later, in a query-friendly columnar form.
> **Apples-to-apples** comparison between backtests requires the same
> capture surface every time.

## The actual problem (as architected, not as patched)

Today there are **3 trade-write paths** that each independently bind columns:

1. `d1UpsertTrade(env, trade)` — INSERT-or-UPDATE into `trades`. Called from:
   - `processTradeSimulation` directly (line 22509, etc.)
   - **`replay-candle-batches.js` line 1183** — the replay flush
   - `replay-interval-step.js` line 516
2. `d1ArchiveRunTrade(env, runId, trade)` — INSERT-OR-REPLACE into `backtest_run_trades`.
   - Called from `replay-candle-batches.js` line 1199 + `replay-interval-step.js` line 534
3. `d1PersistTradeExitSnapshot(env, trade, exitSnap)` — UPDATE into `trades` for exit detail.

Each binding list is hand-maintained. **Adding a new field today means editing 3 INSERTs + 3 UPDATEs and getting the bind index numbering right in 6 places.** That's why I broke things.

## Design from scratch

### Principle 1 — single source of truth for the capture surface

A single function `_buildTradeRowForD1(trade)` returns a plain object whose
keys are the D1 column names, with **every value already coerced/serialized**.
Both `d1UpsertTrade` and `d1ArchiveRunTrade` consume this object.

```js
function _buildTradeRowForD1(trade) {
  const row = {
    trade_id: trade.id || trade.trade_id,
    ticker: trade.ticker?.toUpperCase() || null,
    direction: trade.direction?.toUpperCase() || null,
    entry_ts: _normalizeMs(trade.entry_ts ?? trade.entryTime),
    entry_price: _num(trade.entryPrice ?? trade.entry_price),
    // ... all standard columns ...

    // ─── Entry-time capture (the new lane) ───
    entry_signals_json: _resolveEntrySignals(trade),
    sector: _resolveSector(trade),
    rank_trace_json: _resolveRankTrace(trade),
    max_favorable_excursion: _num(trade.maxFavorableExcursion ?? trade.max_favorable_excursion ?? 0),
    max_adverse_excursion: _num(trade.maxAdverseExcursion ?? trade.max_adverse_excursion ?? 0),
  };
  return row;
}
```

### Principle 2 — INSERT and UPDATE share the same resolver chain

```js
async function d1UpsertTrade(env, trade) {
  const row = _buildTradeRowForD1(trade);
  // Build INSERT with COALESCE-friendly UPDATE in one upsert:
  //   INSERT ... ON CONFLICT DO UPDATE SET col=COALESCE(excluded.col, col)
  // (D1 / SQLite supports this since 3.24.)
  await db.prepare(_buildInsertSqlFromRow(row))
    .bind(...Object.values(row))
    .run();
}
```

This eliminates the dual-statement insert+update dance. **One SQL, one binding list, one source of truth.**

### Principle 3 — every resolver looks in three places

For every entry-time field, the resolver checks (in order):

1. **Top-level field on the trade object** (camelCase preferred, snake_case fallback).
2. **Nested in `setup_snapshot` inside `rank_trace_json`** (the existing capture).
3. **Static lookup function** if applicable (e.g., `getSector(ticker)` for sector).

This way:
- Code paths that explicitly attach the field still work (preferred path).
- Code paths that attach `rank_trace_json` but forget the field still work (fallback to setup_snapshot).
- Code paths that have neither still get sector populated (static lookup).

### Principle 4 — verification is mandatory

Add a **single column-coverage assertion** at the end of each batch flush in
`replay-candle-batches.js`: query `SELECT count(*) WHERE entry_signals_json IS
NULL` for the just-written batch. If non-zero, log a `[CAPTURE_GAP]` warning
with the trade IDs. This makes capture regressions visible in real time.

## Concrete implementation plan

| Step | Action | File | Risk |
|---|---|---|---|
| 1 | Define `_buildTradeRowForD1` + 3 resolvers in one block above `d1UpsertTrade` | `worker/index.js` | Low |
| 2 | Rewrite `d1UpsertTrade` to use the row builder + a single upsert SQL | `worker/index.js` | Medium — SQL changes |
| 3 | Rewrite `d1ArchiveRunTrade` to use the same row builder | `worker/index.js` | Medium |
| 4 | Add CAPTURE_GAP assertion at batch-flush time | `worker/replay-candle-batches.js` | Low |
| 5 | Smoke test: 1-day replay, verify all columns populated | n/a | n/a |

## Why this is straight-forward (not the rabbit hole I went down)

The data IS there. The problem is **plumbing**: the trade row construction
is fragmented across 3 SQL statements with hand-bound parameters. Replacing
the 3 statements with one row-object → one SQL → one bind list eliminates
the entire class of "did I forget to update this binding?" bugs.

The fact that my previous attempt added the field at the SQL level but
something else was still NULL-ing it out tells me there's a parallel write
path I haven't found yet — probably a different INSERT in `replay-candle-batches.js`
that was never updated. The single-source-of-truth approach makes this a
non-issue: there's literally one SQL string in the codebase that writes a
trade row.

## Out of scope for this PR (separate work)

- `signal_snapshot_json` on `direction_accuracy` (used by Trade Autopsy modal) — already works, leave alone.
- Sector field upstream in tickerData (`tickerData._sector`) — separate enrichment task.
- VWAP session-anchoring — backlog.

## Promotion gate for this fix

After the rewrite, run a 3-day smoke and verify:

| Field | Expected coverage |
|---|---|
| `entry_signals_json` | 100% of closed trades |
| `sector` | 100% of closed trades (via getSector fallback) |
| `max_favorable_excursion` | 100% (init to 0) |
| `max_adverse_excursion` | 100% (init to 0) |
| `rank_trace_json` | ≥ 95% (matches current canonical rate) |

If any field is < 95%, the rewrite is incomplete and we iterate.
