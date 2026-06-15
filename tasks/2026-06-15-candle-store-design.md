# Candle store — proper design (efficient, additive)

How the per-ticker candle data SHOULD work. Goal: build deep history ONCE, then
only ever fetch + compute the new closed bar(s). Reads are O(recent N) with no
re-derive. Freshness is a property of "did we append the last bar", not "can we
re-scan the base".

## Principles
1. **One source of truth, no per-TF drift.** Every intraday TF is derived from a
   single 5m base; W/M from a single daily base. (This is the existing chain's
   correct core — keep it.)
2. **Additive ingest — fetch only the new closed bars.** Per ticker keep a cursor
   = last stored 5m ts. Each feed tick fetches the provider for `(cursor, now]`
   only (steady state: 1 bar / 5 min), not a fixed re-fetch window. Idempotent
   append (dedup by ts).
3. **Incremental derive — recompute only the affected tail.** When new 5m bars
   land, re-resample ONLY the buckets they touch (the last 1–2 buckets per TF),
   and upsert those into a MATERIALIZED per-TF series. Never re-derive 50 days to
   serve a read.
4. **O(N) reads — no resample on the hot path.** Scoring reads the materialized
   TF series and slices the last N bars. No `storage.list` of the whole base, no
   resample per read.
5. **Self-healing correctness.** A daily (off-peak) full re-derive + reconcile
   repairs any late-print / correction older than the incremental tail window.

## Storage model (per ticker, in the shard DO)
```
b5:<T>:<YYYY-MM-DD>   5m base, chunked by ET session day        (exists)
bd:<T>                daily base (small array)                   (exists)
mtf:<T>:<TF>          MATERIALIZED derived series, bounded to    (NEW)
                      the last K bars (K≈600; TF∈10,15,30,60,240,W,M)
cur:<T>               { ts5m, tsDaily }  ingest cursor           (NEW)
```
Daily/W/M: daily base is small; W/M materialized the same way from the daily base.

## Write path (additive)
`ingest(ticker, "5", newBars)`:
1. Dedup + append newBars into the affected `b5:<T>:<day>` chunk(s). (exists)
2. `cur.ts5m = max(ts)`.
3. For each intraday TF: find the earliest bucket-start touched by newBars; load
   the 5m from that bucket-start through the latest (a SMALL tail — at most a
   couple sessions), `resampleIntradaySessions` that tail, and UPSERT the produced
   buckets into `mtf:<T>:<TF>` by bucket ts (replace the forming/last bucket, append
   new). Trim `mtf` to the last K. Work is O(tail), independent of history depth.

`ingest(ticker, "D", newDailyBars)`: append/normalize daily; re-derive only the
current week + month buckets into `mtf:<T>:W` / `mtf:<T>:M`.

## Read path (efficient)
`getSeries(ticker, tf, {limit})`:
- If `mtf:<T>:<tf>` exists → slice last `limit`, return (O(N), no resample, no
  base scan). Carry the `complete`/coverage contract from the materialized meta.
- Cold/missing (first read after backfill) → derive-on-read ONCE from the base,
  then materialize so subsequent reads are cheap.
`getSeriesMulti(tfs)` → one read per materialized TF (cheap), no base load.

## Feed (additive, cursor-based)
Replace the fixed 30-min re-fetch with: read `cur.ts5m`; fetch provider 5m for
`(ts5m − 1 bar, now]` (small overlap for safety); ingest. Steady state = 1 bar.
Cold ticker (no cursor) = one-time deep backfill (e.g. 60 sessions), then additive.

## Backfill (one-time bootstrap)
Per ticker, once: fetch deep 5m (≈60 sessions) + deep daily (≈2y), ingest →
materializes every TF. After that the ticker is additive forever.

## Why this fixes the incident
- The scorer reads materialized TFs (O(N)) — no 255×(full base list + 4-TF
  re-resample) per `*/5` cron → no DO overload / fallback-to-stale-legacy.
- The feed fetches 1 bar/tick — cheap, no provider waste, no D1 cost.
- Freshness = "did the feed append the last 5m bar" — directly observable via the
  cursor; not dependent on a heavy re-derive completing under cron load.

## Worker mapping (leverages the decomposition — `skills/worker-topology.md`,
## `tasks/2026-06-10-worker-decomposition-plan.md`)
The candle store spans three workers, matching the existing role split. The DO is
the single owner; the other workers bind it via `script_name="timed-trading-ingest"`
(same pattern as PRICE_HUB etc. — no DO migration moves).

| Concern | Worker / lane | How |
|---|---|---|
| **Feed** (fetch new 5m, additive) | **tt-feed** `*/1` (feed role) | the chain feed is a `*/1` lane → it belongs with the price feed on tt-feed, not the monolith. Cursor-based fetch → ingest into the DO. Needs the `CANDLE_CHAIN_SHARD` binding added to `worker-feed/wrangler.toml`. |
| **Store + incremental materialize** | **CandleChainShard DO** (monolith-owned) | `ingest()` appends base + materializes the affected tail; `getSeriesMulti()` reads materialized O(N). |
| **Read for scoring** | **tt-engine** `*/5` (engine role) | reads `getSeriesMulti` (materialized). Binding + `SCORE_CANDLE_SOURCE` added to `worker-engine/wrangler.toml` (done). |
| **Admin / backfill / API** | **monolith** | owns the DO + the backfill + diagnostic endpoints. |

So the build extends the decomposition rather than fighting it: the chain feed
moves to the feed role (gated like the price feed), the DO stays the owner, and
each role worker binds what its lane needs (the binding-parity rule from
`skills/worker-topology.md`).

## Build order (each step pure + unit-tested before wiring)
1. `candle-store.js` (pure): incremental `materializeTail`, `upsertSeries`,
   `readMaterialized`, cursor helpers. Tests: incremental == full-derive parity;
   late-bar upsert; bounded tail cost; cold→materialize.
2. Wire into `candle-chain-shard.js`: ingest updates `mtf`, getSeries/Multi read
   `mtf` (derive-on-read fallback). Keep existing tests green.
3. Cursor-based feed in `_feedCandleChainDO` (fetch from cursor).
4. Binding-parity + a health field exposing per-shard cursor age (freshness =
   cursor age, surfaced — never a silent fallback).
5. Backfill script for cold tickers. Deploy ONCE, verified on pre-prod first.

## Invariant tests (the guardrail)
For any sequence of incremental ingests, `readMaterialized(tf)` MUST equal a
from-scratch `resampleIntradaySessions(fullBase, tf)` over the same window. This
parity test is what lets us trust the additive path.
