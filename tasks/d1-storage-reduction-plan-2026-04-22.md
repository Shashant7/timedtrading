# D1 Storage Reduction Plan

**Status:** Planned  
**Date:** 2026-04-22  
**Problem:** D1 at ~9 GB (90% of 10 GB limit). Next full backtest will push past the limit and break.

---

## 1. Root cause

`timed_trail.payload_json` is the single heaviest write path.

For every replay bar we write a per-ticker row with a condensed forensics
JSON payload (~2-3 KB) containing:

- Full `tf_tech` bundle for all 6 timeframes (stDir, stSlope, RSI, EMA structure, Ripster clouds, Saty phase, etc.)
- `daily_structure`, `atr_levels`, `ema_map`, `pdz_zone`, `fvg_D`, `liq_D`
- EMA regime per timeframe, rvol per timeframe, fuel
- Entry lineage fields

At 215 tickers × 14 bars/day × ~210 trading days per backtest
= **~630k rows per full run × 2-3 KB = 1.5-2 GB per backtest** before
counting the indexes and the aggregation table `trail_5m_facts`.

Phase-F, Phase-G, Phase-H, Phase-H.3, v8, v9, v10b, Phase-I, plus several
smokes — we've accumulated 7+ full runs and a dozen partial smokes.
That's the 9 GB.

The other heavy tables (`ticker_candles` = ~3-4 GB, `trades` / `backtest_run_trades` = <200 MB combined) are **irreducible data**:
- `ticker_candles`: needed for replay to work at all.
- `trades` / `backtest_run_trades`: historical trade-level record we
  explicitly use for analysis. Must keep.
- `direction_accuracy`: necessary for forensic comparisons.

So the fix is surgical: **stop writing `payload_json` by default during
backtests.** Keep the slim trail (price, htf/ltf, state, rank, flags)
because downstream analysis uses those fields. Make forensics opt-in
via a query flag for the rare cases we need it.

---

## 2. The plan

### 2.1 Opt-in forensics payload

- Default: `payload_json = NULL` on trail writes.
- New query param `trailForensics=1` preserves current behavior for
  one-off forensic runs.
- Everything else (slim fields) keeps flowing as today.

### 2.2 Post-run cleanup of existing `payload_json`

For runs we won't re-analyze via the old forensic scripts, null out
`payload_json` on old rows. This recovers ~1.5-2 GB per historical run.

Safe approach:

```sql
UPDATE timed_trail SET payload_json = NULL WHERE ts < <cutoff_ms>;
```

Can run in batches via an admin endpoint.

### 2.3 File-based forensics (if we ever need them again)

If future work truly needs the full payload, we can export to a JSONL
file during the run and store it outside D1 (R2 bucket, or committed
into the repo as a data artifact). For now: not needed. We have enough
data from past runs to answer current questions.

### 2.4 Heavier candle retention optimization (optional follow-on)

Current `CANDLE_RETENTION_DAYS`:
- 10m/30m: 90 days
- 1h: 180 days
- 4h: 365 days
- D/W/M: forever

If we need more space after `payload_json` cleanup, we can:
- Drop 10m bars older than 30 days (we mostly use 10m for intraday;
  backtests can recompute from 30m/1h if they ever need older 10m).
- Drop 30m bars older than 60 days.

This is a separate decision — wait until we see how much space
`payload_json` cleanup recovers.

---

## 3. Concrete code changes

### 3.1 `worker/replay-candle-batches.js`

Accept a `trailForensics` flag from the parsed request. When false (the new default), pass `payload_json = NULL` to the INSERT.

```js
// At the top of executeCandleReplayBatches where other query params are read:
const trailForensics = url.searchParams.get("trailForensics") === "1";

// At the INSERT bind site:
const payloadJson = trailForensics && payloadObj
  ? JSON.stringify(payloadObj)
  : null;
```

### 3.2 `worker/backtest-runner-contracts.js`

Add `trailForensics` to the parsed request object (for consistency / docs).

### 3.3 New admin endpoint for retroactive cleanup

`POST /timed/admin/purge-trail-payload` — batched UPDATE that nulls
`payload_json` across the existing `timed_trail` rows. Default: only
touch rows older than the most-recent run (so we don't wipe active
forensics). Query params:

- `cutoffDays` (default 0 = all rows)
- `maxBatches` (safety valve, default 100)
- `dryRun=1` reports without writing

### 3.4 Optional: `skipTrailPayload` env var for production

If we want payload capture only in live trading (never backtests), set
`SKIP_TRAIL_PAYLOAD_ON_REPLAY=true` in wrangler.toml. Cleaner than
requiring every backtest to opt out.

---

## 4. Expected impact

- **After code change**: next backtest writes ~50 MB of trail data
  (down from 1.5-2 GB). 30-40× reduction.
- **After retroactive cleanup**: reclaim 6-8 GB from historical runs.
  D1 drops from ~9 GB to ~1-2 GB.
- Zero impact on current trade analysis:
  - `trades.json` export (used in all retrospectives): unaffected
  - `backtest_run_trades`: unaffected
  - `direction_accuracy`: unaffected
  - `ticker_candles`: unaffected

The only affected surface is the ~two Python scripts that parse
`timed_trail.payload_json` for old forensic analyses (Phase-G
trade autopsies). Those runs are done; we don't need them again.

---

## 5. Sequence

1. Ship code change (sections 3.1–3.2). 20-line diff.
2. Deploy worker.
3. Add cleanup endpoint (section 3.3). 30-line diff.
4. Deploy, run cleanup with `dryRun=1` to see how much will free up.
5. Run cleanup for real.
6. Verify D1 size dropped.
7. Launch v11 full run via shell orchestrator.

Total time: ~30 minutes of focused work + however long cleanup takes
to run (probably a few minutes of batched UPDATEs).

---

## 6. Rollback plan

If something unexpectedly breaks:

- Revert the code change; backtests write payload_json again (adding
  space back but recovering full forensics).
- The cleanup UPDATEs are not reversible, but the payload data is
  reconstructible by re-running the replay — we never "lose"
  information, only the cache.

---

## 7. What we DON'T change

- `ticker_candles` (needed for replay)
- `trades` / `backtest_run_trades` (historical record)
- `direction_accuracy` / `backtest_run_direction_accuracy`
  (calibration data)
- `market_events` (needed for H.4.0 earnings gate)
- KV trade records (live trading uses these)
