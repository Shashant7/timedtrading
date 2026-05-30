# Data Capture Architecture (2026-05-01)

> **Goal**: every trade row, in every backtest, captures every entry-time
> signal we want to analyze later, in a query-friendly columnar form.
> **Apples-to-apples** comparison between backtests requires the same
> capture surface every time.

## The actual problem

Today there are **3 trade-write paths** that each independently bind columns:

1. `d1UpsertTrade(env, trade)` — INSERT-or-UPDATE into `trades`. Called from:
   - `processTradeSimulation` directly (multiple sites)
   - **`replay-candle-batches.js` line 1183** — the per-batch flush
   - `replay-interval-step.js` line 516
2. `d1ArchiveRunTrade(env, runId, trade)` — INSERT-OR-REPLACE into `backtest_run_trades`.
   - Called from `replay-candle-batches.js` line 1199 + `replay-interval-step.js` line 534
3. `finalizeBacktestRun` (in `backtest-run-archive-helpers.js`) — INSERT...SELECT
   from `trades` into `backtest_run_trades` at run finalize. Backstop for runs
   where `d1ArchiveRunTrade` didn't run for some trades.

Each binding list is hand-maintained. Adding a new column means editing all 3
INSERTs. The 2 new flat columns (`entry_signals_json`, `sector`) had been
added inconsistently across these paths, leaving `trades.entry_signals_json`
NULL even when `trades.rank_trace_json` was populated with the same data
inside `setup_snapshot`.

## The fix that worked (V15 P0.7.46, 2026-05-01)

Surgical wiring of the new columns into all 3 SQL paths, using a shared
**3-tier resolver** chain so any of the upstream code paths produces the
right value:

### Resolver chain (per column)

For `entry_signals_json` and `sector`, the resolver checks (in order):

1. **Top-level field on the trade object**
   - `trade.entrySignals` → camelCase preferred (the trade constructor stamps
     this directly, see `worker/index.js` line ~19583)
   - `trade.entry_signals` → snake_case fallback
   - For sector: `trade.sector`, `trade.sectorAtEntry?.sector`,
     `trade.sector_at_entry?.sector`
2. **Nested in `setup_snapshot` inside `rank_trace_json`** — derives the
   flat fields from the existing rich capture if Tier 1 missed
3. **Static lookup function** (sector only) — `getSector(ticker)` from
   the local `SECTOR_MAP`

### What got changed

| File | Change |
|---|---|
| `worker/index.js` | New `_captureResolveEntrySignals` + `_captureResolveSector` helpers above `d1UpsertTrade` |
| `worker/index.js` | `d1UpsertTrade` SQL: INSERT (?29 → ?31) + UPDATE adds `entry_signals_json`, `sector` |
| `worker/index.js` | `d1ArchiveRunTrade` SQL: INSERT OR REPLACE adds `entry_signals_json`, `sector` |
| `worker/backtest-run-archive-helpers.js` | `finalizeBacktestRun` archive INSERT...SELECT adds the two columns |
| `worker/index.js` | Idempotent `ALTER TABLE … ADD COLUMN entry_signals_json TEXT / sector TEXT` migrations on both `trades` and `backtest_run_trades` |
| `worker/index.js` | New `GET /timed/admin/kv/get` + `GET /timed/admin/kv/list` debug routes |
| `worker/index.js` | KV-based capture probes in `d1UpsertTrade` + `d1ArchiveRunTrade` (`debug:capture:<tradeId>`, 10-min TTL) so we can prove the write path fires |
| `worker/index.js` | Re-applied MFE/MAE init-to-0 (origin: 9c041c9) so the prior fix doesn't regress on this branch |

## Smoke results (1 day, 2026-03-04, 200-ticker canon)

```
run_id: cap-fix2-1777608738
trades: 6 closed

entry_signals_json: 6/6 ✓
sector:             6/6 ✓
max_favorable_excursion: 6/6 ✓
max_adverse_excursion:   6/6 ✓
rank_trace_json:    6/6 ✓
```

KV probe inspection confirms `d1UpsertTrade` fired for all 6 trades with
`has_entrySignals: true` (Tier 1 hit) and a non-null resolved sector.

Sample resolved entry_signals_json (TJX):

```json
{
  "has_adverse_rsi_div": true,
  "has_adverse_phase_div": true,
  "is_f4_severe": true,
  "adverse_phase_strongest_tf": "30m",
  "daily_td9_adverse": false,
  "daily_adverse_prep": 0,
  "fourh_adverse_prep": 0,
  "td9_bear_ltf_active": false,
  "pdz_d": "premium_approach",
  "pdz_4h": "premium_approach",
  "personality": "MODERATE"
}
```

## Why the prior architecture rewrite (70b6e0f) didn't take

The reverted `_buildTradeRowForD1` ON CONFLICT DO UPDATE upsert was
architecturally clean but introduced a SQL shape change at the same time as
the new bindings. When the new SQL silently failed (no exception bubbled to
the caller because the catch swallowed and logged), the columns stayed NULL
and the diagnosis became "d1UpsertTrade probably isn't firing". This time
we keep the proven INSERT-OR-IGNORE-then-UPDATE shape and only **append**
the two new columns to the bind lists. Lower risk, identical surface area.

## Out of scope (separate work)

- `signal_snapshot_json` on `direction_accuracy` — already works, leave alone.
- Sector field upstream in `tickerData._sector` — separate enrichment task.
- `replay-runtime-setup.js` reconciliation merge — explicitly NOT touched per
  the parent task. The merge already preserves KV-only fields via spread, so
  `entrySignals` survives cross-batch reconciliation.

## Promotion gate (passed)

| Field | Required | Observed |
|---|---|---|
| `entry_signals_json` | 100% closed trades | 6/6 |
| `sector` | 100% closed trades | 6/6 |
| `max_favorable_excursion` | 100% (init=0 fix) | 6/6 |
| `max_adverse_excursion` | 100% (init=0 fix) | 6/6 |
| `rank_trace_json` | ≥ 95% | 6/6 |
