# Phase C — Orphaned OPEN positions investigation
**Date:** 2026-05-03  
**Run:** `phase-c-stage1-jul2025-may2026` (Cloudflare Worker)  
**Symptom:** 17 trades from Aug 15-29 2025 still showing as OPEN / TP_HIT_TRIM with stale MFE values, while the simulation has progressed to Sept 26-29 2025.

---

## 1. Root cause hypothesis

When the September leg resumes via `--resume`, the per-batch `loadReplayScopedTrades` reconcile in `worker/replay-runtime-setup.js` queries the **live** `trades` D1 table by `run_id` and uses that as the merged source-of-truth — but the live `trades` table is missing ~167 of the run's trades (including every Aug 15-29 OPEN / TP_HIT_TRIM position). The archive table `backtest_run_trades` has them all (250 vs 83 in live), but the existing archive-fallback at `replay-runtime-setup.js:946` is gated `else if (!allTrades || allTrades.length === 0)` so it never fires when D1 returns *any* live rows. The result: the August opens are never re-loaded into `replayCtx.allTrades`, so MFE/MAE never update, no exit rule sees them, the entry-side duplicate-open guard cannot match them (so the engine happily re-enters the same tickers — DIA, SPY, IWM, ALLY, SNDK all entered new positions in September while the August trade was still nominally OPEN), and the verdict generator inherits ghost trades.

---

## 2. Evidence

### 2.1 Stale MFE confirmed via `entry_signals_json.loop_events`

For every Aug-leg open position, `loop_events` (appended by Loop 3 `phase-c-loops.js:loop3ShouldCutFlat` from `worker/index.js:7602-7604` on every kanban management bar) only contains events whose `age_min` is consistent with the bars **inside the August leg** — none from the September leg.

| Ticker | Entry (UTC) | Status | MFE (run-trades) | last loop_event age_min | Sim days held |
|---|---|---|---|---|---|
| DIA  | 2025-08-25 14:00 | OPEN | +0.37 % | none (0 events) | 35.1 d |
| SPY  | 2025-08-25 18:00 | OPEN | +0.72 % | none (0 events) | 34.9 d |
| HII  | 2025-08-27 15:00 | OPEN | +0.36 % | <30 min (2 events) | 33.0 d |
| INTC | 2025-08-27 15:30 | OPEN | +1.30 % | <30 min (2 events) | 33.0 d |
| ALLY | 2025-08-29 17:30 | OPEN | 0 %     | 150 min = 20:00 Aug 29 (10 events) | 30.9 d |

Every `updated_at` on these rows is between `2026-05-03 05:39 UTC` and `05:42 UTC` — **the closing window of the August leg**. The September leg (which started at `12:46 UTC` and is currently mid-way through Sept 29) has not touched a single one of these rows. Source: `runs/trades` archive snapshot (`/tmp/runtrades.json`).

### 2.2 Duplicate-open evidence — definitive proof the engine doesn't see the August opens

For every ticker that has an Aug-leg open, the September leg has happily entered new trades on the same ticker:

| Ticker | Aug position | Sept new entries while Aug "still open" |
|---|---|---|
| DIA  | OPEN Aug 25 14:00 | WIN Sept 9 (closed), **OPEN Sept 26** (concurrent dupe) |
| SPY  | OPEN Aug 25 18:00 | WIN Sept 5, WIN Sept 12 |
| ALLY | OPEN Aug 29 17:30 | WIN Sept 11 |
| SNDK | TP_HIT_TRIM Aug 27 18:30 | LOSS Sept 8, LOSS Sept 11, LOSS Sept 15, LOSS Sept 18 + WIN Sept 3 |
| BE   | TP_HIT_TRIM Aug 21 16:00 | LOSS Sept 11 |
| AAPL | TP_HIT_TRIM Aug 22 17:00 | WIN Sept 2, WIN Sept 17 |
| IWM  | TP_HIT_TRIM Aug 25 14:00 | WIN Sept 11 + **TP_HIT_TRIM Sept 26** (concurrent dupe) |

`worker/pipeline/tt-core-entry.js:376-388` (`deep_audit_duplicate_open_block_enabled = true` in pinned config) *would* have rejected those duplicates with `phase_i_duplicate_open` if the Aug positions were in `_recentTrades` (built at `worker/replay-candle-batches.js:359-371` from `replayCtx.allTrades`). They aren't — confirming the orphan trades are missing from `replayCtx.allTrades` for the entire September leg.

### 2.3 KV vs D1-archive divergence — direct snapshot

```
KV  timed:trades:replay  (`/timed/admin/kv/get?k=timed:trades:replay`):  83 trades
D1  backtest_run_trades  (`/timed/admin/runs/trades?run_id=…`):         258 trades
```

Trades-by-month in KV: `2025-07: 3 · 2025-08: 1 · 2025-09: 79`.  
Trades-by-month in archive: `2025-07: 103 · 2025-08: 76 · 2025-09: 71`.

→ KV is missing the entire August cohort (with one stray ITT survivor), and 100 of 103 July trades. 175 trade rows are present in `backtest_run_trades` but absent from KV. Those 175 are precisely the rows the engine cannot see during management.

### 2.4 The reconcile path — where the rows fall through

`worker/replay-runtime-setup.js:858-966` (`loadReplayScopedTrades`):
```
861  const { results: liveRows } = await db.prepare(
862    `SELECT … FROM trades WHERE run_id = ?1`
867  ).bind(reconcileRunId).all();
868  console.log(`${logPrefix} D1 query returned: rows=${(liveRows||[]).length} …`);
869  if (liveRows && liveRows.length > 0) {
870    // … merges liveRows + KV; D1 wins on persisted state, max(MFE/MAE)
       …
946  } else if (!allTrades || allTrades.length === 0) {
947    // Last-resort fallback: try the archive table for legacy runs.
948    const { results: archiveRows } = await db.prepare(
949      `SELECT … FROM backtest_run_trades WHERE run_id = ?1`
958  }
```

Two issues:

1. **Archive fallback gate is too narrow.** The archive read is only reachable when *both* `liveRows.length === 0` *and* `allTrades.length === 0` (KV was also empty). For our run, the live `trades` query returns ~83 rows for the September leg, so the archive fallback never fires and the 175 archive-only trades stay invisible.

2. **`d1UpsertTrade` failures are silently swallowed** at `worker/replay-candle-batches.js:1187`:
   ```
   await d1UpsertTrade(env, trade).catch(() => {});
   ```
   `d1ArchiveRunTrade` (next loop, line 1203) is called separately. So a transient D1 write failure on the live `trades` table does not stop the archive write — the run can durably persist into the archive while losing the live row. Once a row is missing from live `trades`, the next batch's reconcile cannot recover it (gate above), so it's gone for the rest of the run.

### 2.5 Downstream consequences once the orphan is gone

* `worker/index.js:14587` `openTrade = allTrades.find(...)` → `null`. Management code falls through to entry path.
* `worker/index.js:16399` MFE/MAE update branch is gated on `openTrade && isOpenTradeStatus(openTrade.status)`. With no openTrade, MFE never advances. (Confirms why ALLY shows MFE 0% even though the underlying moved +9.21 % at peak.)
* `worker/index.js:21942` `anyOpenTrade = allTrades.find(...)` → `null`. Strict-single-position guard (`strictReplaySingleTicker = true` because manifest is clean-lane) does not block the duplicate.
* `worker/pipeline/tt-core-entry.js:377-388` `_stillOpen` lookup → `null`. `phase_i_duplicate_open` rejection cannot fire.
* `worker/pipeline/tt-core-exit.js` and the kanban classifier (V13 safety nets at `worker/index.js:6804-6833`, MFE-validated exits at `7382-7686`, stale-position force-close at `7688-7738`, stagnant cut at `7779+`) all run inside `classifyKanbanStage`'s `hasPosition` branch — which requires `openPosition`. With no openPosition, none of them fire — explaining why none of the V12/V13 timeouts (`v13_hard_age_days=30`, `deep_audit_stale_position_force_close_days=45`, `deep_audit_trim_runner_time_cap_days=30`, `deep_audit_stagnant_cut_min_age_days=7`) closed the orphans even when their thresholds were obviously breached.

---

## 3. Other affected trades

Counts from `phase-c-stage1-jul2025-may2026/trades.json` (250 trades total, 28 nominally still open):

* **OPEN with stale MFE (Aug-leg orphans, > 30 sim-days held):** 5 → DIA, SPY, HII, INTC, ALLY.
* **TP_HIT_TRIM with stale MFE (Aug-leg orphans, runners abandoned):** 12 → NOC (Aug 15), SGI (Aug 18), BE (Aug 21, MFE 21.5 %!), AAPL (Aug 22), STX/IWM/APP/VRTX (Aug 25), PH (Aug 26), QQQ/SNDK (Aug 27), GOOGL (Aug 28).
* **Total Aug-leg ghost positions:** 17.
* **Sept-leg duplicate entries created on tickers that had Aug ghosts:** 21 trades across 11 tickers (`AAPL×2, STX×3, SNDK×5, SPY×2, APP, GOOGL, DIA×2, IWM×2, SGI, ALLY, BE`). Several of these are themselves now ALSO sitting OPEN/TP_HIT_TRIM (CAT, IWM, DIA, AGQ, ALB, etc. from Sept 25-26).
* **Currently nominally OPEN positions where the new Sept entry is also stuck OPEN (compounded):** 4 → DIA, IWM, SPY, AAPL.

Net effect on metrics: Aug-leg verdict overstates win rate (these 17 should have been closed losses or modest wins by the v13/v15 timeout rules); Sep-leg verdict double-counts capacity (PnL attributed to second entries on the same ticker that should have been blocked).

---

## 4. Proposed fix

**Single-line surface, two-line code change.** Read the archive into the merge whenever the live `trades` table is sparse for a clean-lane resume, not only when both KV and live are empty.

**File:** `worker/replay-runtime-setup.js`  
**Function:** `loadReplayScopedTrades`  
**Lines:** 869 – 958

Replace the `if (liveRows && liveRows.length > 0) { … } else if (!allTrades || allTrades.length === 0) { archiveRows fallback }` shape with:

1. Always also query `backtest_run_trades` for `WHERE run_id = ?1` immediately after the `trades` query (cheap — ~250 rows max for our run; no joins).
2. Build the merge as **D1-trades-row ∪ archive-row ∪ KV-row**, deduping by `trade_id` and applying the existing precedence rule (D1 row wins on persisted state, max(MFE/MAE) preserved). For trade_ids present **only** in archive, build a base record via `mapArchivedReplayTrade` and add it. The current MFE/MAE merge logic at lines 909-922 already handles the merge math.
3. Log when archive-only rows are recovered (count of orphans rescued) so we can tell from worker tail when it's firing.

Concrete patch sketch (do NOT apply now — the run is mid-leg):

```js
// after line 867 (right after liveRows query)
let archiveRows = [];
try {
  const { results } = await db.prepare(
    `SELECT trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
            exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct,
            trim_ts, trim_price, setup_name, setup_grade, risk_budget, shares, notional,
            entry_path, max_favorable_excursion, max_adverse_excursion
       FROM backtest_run_trades WHERE run_id = ?1`
  ).bind(reconcileRunId).all();
  archiveRows = results || [];
} catch (e) {
  console.warn(`${logPrefix} archive reconcile read failed: ${String(e).slice(0, 200)}`);
}

const liveByTradeId = new Map();
for (const row of (liveRows || [])) {
  const tid = String(row?.trade_id || "").trim();
  if (tid) liveByTradeId.set(tid, row);
}

// Promote archive-only rows into the merge basis as if they were live rows.
let archiveOnlyRescued = 0;
for (const row of archiveRows) {
  const tid = String(row?.trade_id || "").trim();
  if (!tid || liveByTradeId.has(tid)) continue;
  liveByTradeId.set(tid, row);
  archiveOnlyRescued++;
}
const reconciliationRows = [...liveByTradeId.values()];
if (archiveOnlyRescued > 0) {
  console.warn(`${logPrefix} Rescued ${archiveOnlyRescued} archive-only trade(s) absent from live trades table`);
}

// then change line 869 from `if (liveRows && liveRows.length > 0)` to:
if (reconciliationRows.length > 0) {
  // existing merge loop, iterating `reconciliationRows` instead of `liveRows`
  // (the merge logic at 909-922 already handles MFE max + status-from-D1).
```

Then remove the now-redundant archive fallback at line 946-958 (or keep it as dead code with a note).

**Fix character:** read-only addition to one D1 query per batch (~250 rows of indexed lookup; cost negligible vs the per-batch trail-write workload). Behaviour preserved when live `trades` already contains everything (archive read returns same set; merge collapses to a no-op).

### 4.1 Followup — also worth doing in the same patch (optional)

Surface the silent-swallow: change `worker/replay-candle-batches.js:1187` from `await d1UpsertTrade(env, trade).catch(() => {});` to push errors into the batch's `errors` array (already returned in the API response). This won't fix the orphan-management problem (proposed fix above already handles that durably), but it would expose the next root-cause-class write failure rather than letting it accumulate silently across batches.

---

## 5. Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Resurrects "ARCHIVED" trades that were intentionally archived via `/timed/admin/reset` | low | The archive table only contains trades that were explicitly persisted by `d1ArchiveRunTrade` for the run_id; reset endpoint also clears archive when `resetLedger=1`. For Phase-C clean-lane runs the archive is always strict-monotonic (INSERT OR REPLACE per batch), so it cannot contain entries that should not still exist. |
| Doubles the per-batch D1 read load | low | One additional indexed `SELECT` per batch (one per simulated day per offset = ~20 batches/day × 21 days = 420 total in the September leg). Each returns ~250 small rows. Order of magnitude cheaper than the trail-write batch already running. |
| Brings back trades from a *different* run that share trade_ids | none | Both queries filter on `WHERE run_id = ?1`. trade_ids are `<TICKER>-<entry_ts_ms>`, which are unique per (ticker, ms). |
| Conflict with KV-only fields (rank_trace_json) | low | The proposed merge keeps the existing precedence (KV preserves rank_trace_json + in-memory richness; D1/archive wins on persisted state). Archive-only rows have full setup/path/rank fields available — they were written by `d1ArchiveRunTrade`. |
| Causes the V12/V13 timeout rules to fire on now-resurrected stale trades and dump them at bad prices | **medium** | Real concern. As soon as the fix ships and the September leg processes one more batch, every Aug-leg orphan will become visible to `classifyKanbanStage`'s `hasPosition` branch. With `deep_audit_v13_hard_age_days = 30` (already breached for all 17 orphans) and `deep_audit_stale_position_force_close_days = 45`, those positions will close immediately on the next bar — at the September price (potentially much higher or lower than where the user expected the simulated exit to land). For DIA (+1.7 %), SPY (+2.9 %), INTC (+19.2 %), this means a deferred big-winner realization; for ALLY (+4 %), HII (+0 %), modest. **The user should accept that stage and continue, OR flatten these positions manually at a meaningful intermediate timestamp before redeploying.** |
| Leg-end snapshot trades.json mismatches verdicts | low | Only the live `trades` table is wrong; the archive snapshot the verdict generator reads is unchanged. |

---

## Summary (one paragraph)

The Aug-leg open positions (17 trades, 5 OPEN + 12 TP_HIT_TRIM, MFE values frozen at end of August leg) are orphaned because `loadReplayScopedTrades` in `worker/replay-runtime-setup.js:858-966` reconciles `replayCtx.allTrades` from the live D1 `trades` table only, and that live table is missing 167 of the run's 250 trades (likely from silently-swallowed `d1UpsertTrade` failures at `worker/replay-candle-batches.js:1187` that don't affect the parallel `d1ArchiveRunTrade` path). The archive `backtest_run_trades` has them all, but the existing fallback to the archive at `replay-runtime-setup.js:946` is gated `else if (… liveRows.length === 0 …)` so it never fires for our case. With the orphans missing from `replayCtx.allTrades`, the per-bar MFE update branch (`worker/index.js:16399`) never ran, no exit rule could fire (V13 hard age cap at 30d, stale-position close at 45d, stagnant cut at 7d are all gated on `hasPosition`), and the entry-side `phase_i_duplicate_open` guard couldn't match — so the engine entered 21 new positions on tickers it should have known were already open (DIA, SPY, IWM each have concurrent Aug+Sept duplicates right now). Fix: read both `trades` and `backtest_run_trades` per batch and union by `trade_id` before the existing MFE/MAE merge — patch is ~20 lines, scoped to `loadReplayScopedTrades`. Risk: deploying mid-run will resurrect 17 orphans that immediately trip the V13 30-day hard-age cap and close at September prices, which may or may not be desirable — recommend the user decide whether to deploy now (accepting same-bar v13 close-outs for the 17 orphans) or close the orphans manually at chosen intermediate timestamps first.
