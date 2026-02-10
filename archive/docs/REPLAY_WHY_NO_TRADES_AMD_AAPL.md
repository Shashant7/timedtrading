# Why AMD, AAPL and Others Did Not Register Trades During Replay

This doc pinpoints why the **replay-ingest** run (e.g. `replay-output-20260202-1738.txt`) produced **0 trades** for the day while processing 79 buckets and 3,923 rows.

## Which replay was run?

The output line **"Replaying ingest (date=2026-02-02) [clean slate]..."** comes from **`scripts/replay-ingest.js`**, which calls the **`/timed/admin/replay-ingest`** endpoint and processes **ingest_receipts** bucket-by-bucket (5‑minute buckets).

---

## Root causes (in order of impact)

### 1. **Only the first 50 receipts per bucket are processed**

In the worker, replay-ingest does:

```sql
SELECT receipt_id, ticker, ts FROM ingest_receipts
WHERE bucket_5m = ?1 AND (script_version = ?2 OR script_version IS NULL)
ORDER BY ts ASC LIMIT 50
```

So **each 5‑minute bucket only processes the first 50 receipts** (by `ts`). There is no “one row per ticker” guarantee.

- If a bucket has 80+ receipts (many tickers), only the first 50 are ever seen.
- **AMD, AAPL, and others may simply never appear in the processed set** for most buckets because their receipts fall after position 50 in that bucket’s order.

So the main reason those tickers “did not register any trades” is likely: **they were rarely or never among the first 50 receipts in a bucket**, so they were never run through Kanban + trade simulation.

### 2. **Trade creation requires `enter_now` and strict gates**

When a ticker *is* processed, a trade is only created if:

1. **Kanban stage = `enter_now`**  
   `classifyKanbanStage(payload)` must return `enter_now` (momentum state + score/position/corridor/flags, etc.).

2. **Direction from state**  
   `getTradeDirection(tickerData.state)` must be non-null (state must be momentum, e.g. `HTF_BULL_LTF_BULL` or `HTF_BEAR_LTF_BEAR`).

3. **shouldTriggerTradeSimulation** must be true, which includes:
   - Valid `price`, `sl`, `tp` (all present and > 0)
   - In corridor and corridor-aligned (HTF/LTF scores in range)
   - Trigger condition (e.g. just entered corridor, trigger reason, squeeze release, flip_watch)
   - RR ≥ minRR, completion ≤ maxComp, phase ≤ maxPhase
   - Rank ≥ 70 (or 60 for momentum_elite)
   - `dailyEmaRegimeOk`, `ichimokuRegimeOk` true
   - Not blocked by `isLateCycle` (unless momentum_elite)

If the **stored payload** in `ingest_receipts` is missing or weak on any of these (e.g. no `rank`, `rr`, `sl`, `tp`, or regime fields), the ticker can get `enter_now` in Kanban but still **no trade** because `shouldTriggerTradeSimulation` returns false.

### 3. **replay-day with bucketMinutes: “latest per ticker per bucket”**

If you had used **replay-day** with **bucketMinutes > 0** instead of replay-ingest:

- The worker fetches all receipts in the day, then groups by bucket and keeps **only the latest row per ticker per bucket** (`byBucket[bucketTs][tkr] = r`).
- So you only ever see the **end-of-bucket** state. If AMD entered `enter_now` at 10:02 but by 10:05 was in `hold`, you only process the 10:05 payload → stage is `hold` → no trade. So even when a ticker is present, the bucketing can **drop the exact moment** they were in `enter_now`.

This does not change the fact that in your 0-trade run you used **replay-ingest**, where the dominant issue is (1) the 50-receipt limit per bucket.

### 4. **script_version filter**

Replay-ingest filters on `script_version = '2.5.0' OR script_version IS NULL`. Receipts stored with another `script_version` are excluded. Unlikely to be the main cause of “no trades for AMD/AAPL” but worth being aware of.

---

## Summary

| Cause | Effect |
|-------|--------|
| **LIMIT 50 per bucket** | AMD, AAPL (and others) are often not in the first 50 receipts per bucket → never processed → no trades. |
| **Strict trade gates** | When a ticker is processed, missing/invalid payload fields (sl, tp, rank, rr, regime) can block trade creation even if stage is `enter_now`. |
| **replay-day bucket = latest per ticker** | If using replay-day with bucketMinutes, the “latest per ticker per bucket” logic can hide the exact candle where the ticker was in `enter_now`. |

---

## Fix applied (replay-ingest pagination)

1. **Worker** (`/timed/admin/replay-ingest`): added **bucketOffset** query param and **hasMoreInBucket** / **nextBucketOffset** in the response; default limit raised to 100 per page (max 200). **cleanSlate** only when `bucketOffset === 0`.

2. **Client** (`scripts/replay-ingest.js`): for each bucket, loops until no more rows (calls API with `bucketOffset`; when `hasMoreInBucket`, requests next page). All receipts per bucket are now processed.

3. **Optional diagnostic**: run with **DEBUG=1** to see enter_now counts and sample debug rows. Example: `DEBUG=1 DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=your_key node scripts/replay-ingest.js`

4. **Inspect payloads** (optional): if trades still don't appear for specific tickers, query `ingest_receipts` for that ticker and inspect `payload_json` for `state`, `rank`, `rr`, `sl`, `tp`, and regime fields.

Once you **deploy the worker** and run replay-ingest again, every receipt in each bucket is processed; AMD, AAPL and others can register trades when they meet the conditions.

---

## (Superseded steps removed)

1. **Confirm which tickers are actually processed**  
   In replay-ingest (or a one-off script), for each bucket log or count which tickers appear in the first 50 rows. Check whether AMD and AAPL appear in any bucket.

2. **Increase or remove the per-bucket limit for replay**  
   For historical replay, consider processing **all** receipts in each bucket (or a higher limit) so that no ticker is dropped solely because it wasn’t in the first 50. This may require pagination or batching to respect D1/API limits.

3. **Optional: “enter_now” snapshot per bucket**  
   If you keep “latest per ticker per bucket”, consider also keeping (or reprocessing) a snapshot at the **first** time in the bucket a ticker reaches `enter_now`, so replay can create trades for that moment instead of only the end-of-bucket state.

4. **Inspect payloads for AMD/AAPL**  
   Query `ingest_receipts` for a few receipts where `ticker IN ('AMD','AAPL')` and inspect `payload_json` for that day. Confirm they contain `state`, `rank`, `rr`, `sl`, `tp`, and any fields used by `dailyEmaRegimeOk` / `ichimokuRegimeOk` so that when they *are* processed, the gates can pass.

Once you process every receipt (or at least every ticker) per bucket and ensure payloads are complete, AMD, AAPL and others can register trades during replay when they truly meet the Kanban and trade-simulation conditions.
