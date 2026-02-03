# Completion Validation (AAPL and others)

## Why completion % depends on the target (TP1 vs TP max)

**Completion = how far price has moved from trigger toward a target.** If the target is:

- **First TP (TP1)** – completion rises quickly (e.g. 96% toward TP1) but **RR is low** (small distance to TP1). Using completion vs TP1 for the gate would block entries that are “late” toward TP1 but still early toward the full move.
- **TP max** (farthest TP from tp_levels or tp_max_price) – completion is lower for the same price (e.g. 40% toward TP max). Using completion vs **TP max** for the gate keeps entries open while there’s still room to run and better RR.

So we want the **entry gate** to use completion toward **TP max**, not toward TP1. Otherwise we get high completion (e.g. 0.96) and block entries even when the move to TP max is still early.

**What the worker does:**

1. **compToMax** = completion toward **TP max**: `|price - trigger| / |tpMax - trigger|` when we have `tp_max_price` or `tp_levels`.
2. **compRaw** = `payload.completion` from Pine, or worker fallback using single `tp` (which may be TP1).
3. **Gate uses:** `compUsed = compToMax` when finite, else `compRaw`.

If Pine sends **completion toward TP1**, then when we have no `tp_levels`/`tp_max_price` we use that high value and block. **Recommendation:** ensure the ingest payload includes **tp_levels** or **tp_max_price** so we always use **compToMax** (completion to TP max) for the entry gate. Then completion stays low until price is near the full target and RR stays meaningful.

**TV Script:** TimedTrading_ScoreEngine_Enhanced.pine already computes completion toward **TP max** (denom = tpMove when tpMax is available; see lines 1223–1226). No TV script change needed for completion; we use TP max on the worker when we have tp_levels/tp_max_price, and otherwise use payload.completion (which Enhanced sends as TP max when available).

---

## How completion is used in the gate

The entry gate uses **one** of these for the completion check:

1. **compToMax** – completion toward **TP max** (from `tp_max_price` or `tp_levels`):  
   `|price - trigger_price| / |tpMax - trigger_price|`  
   Used when the payload has `tp_max_price` or `tp_levels`.

2. **compRaw** – raw **payload.completion** from Pine, or worker fallback:  
   `|price - trigger_price| / |tp - trigger_price|`  
   Used when compToMax cannot be computed.

So the value that actually gates the trade is **compUsed** = compToMax when finite, else compRaw.

## Debug output (DEBUG=1)

With **DEBUG=1** and **TICKER=AAPL**, the replay-ingest debug rows now include:

- **compFromPayload** – value from the ingest payload (Pine).
- **compUsed** – value used for the gate (compToMax or compRaw).
- **compToMax** – completion to TP max when available.
- **price, trigger_price, tp, tp_max** – so you can recompute and validate.

Example:

```json
{
  "ticker": "AAPL",
  "ts": 1770042660000,
  "compFromPayload": 0.96,
  "compUsed": 0.96,
  "compToMax": null,
  "price": 225.5,
  "trigger_price": 224.1,
  "tp": 226.0,
  "tp_max": null
}
```

If **compToMax** is null, we use payload completion (or completionForSize fallback). If **compFromPayload** and **compUsed** match and price/trigger/tp are present, you can validate:

- Worker fallback (single TP):  
  `comp = |price - trigger_price| / |tp - trigger_price|`
- With TP max:  
  `comp = |price - trigger_price| / |tp_max - trigger_price|`

## Validating from D1

To check whether completion was really that high for a given row:

1. Get one row from **ingest_receipts** (or **timed_trail** with payload_json) for the ticker and ts.
2. From **payload_json** read: `price`, `trigger_price`, `tp`, `tp_max_price` or `tp_levels`.
3. Compute:
   - If you have tp_max: `comp = |price - trigger| / |tp_max - trigger|`
   - Else: `comp = |price - trigger| / |tp - trigger|`
4. Compare to **payload.completion** and to **compUsed** in debug.

If the computed value is much lower than 0.96, the high completion may be a Pine vs worker mismatch (e.g. different TP reference) or a bug in one of the calculations.

---

## D1-based replay (avoid KV 429)

To run a full day for one ticker **without hitting KV rate limits**, use data already in D1 and write KV only at the end:

**Endpoint:** `POST /timed/admin/replay-ticker-d1?key=...&ticker=AAPL&date=YYYY-MM-DD&cleanSlate=1`

**Script:**
```bash
DATE=2026-02-02 CLEAN_SLATE=1 TIMED_API_KEY=your_key TICKER=AAPL node scripts/replay-ticker-d1.js
```

This reads **timed_trail** (ts, payload_json) for the ticker and date range in one D1 query, processes all rows in memory, then does **2 KV writes** at the end (timed:trades:all, timed:latest:TICKER). No per-row KV writes, so no 429. Requires **timed_trail** to have **payload_json** populated (from ingest).

---

## Checking table data (is D1 a better alternative?)

**Endpoint:** `GET /timed/admin/replay-data-stats?key=...&date=YYYY-MM-DD&ticker=AAPL`

Returns for that date (and optional ticker): **timed_trail** row count and count with non-empty **payload_json**; **ingest_receipts** row count; and a **recommendation** (use replay-ticker-d1 vs replay-ingest).

**Script to call it:**
```bash
# Check AAPL for 2026-02-02 (replace YOUR_KEY)
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/replay-data-stats?key=YOUR_KEY&date=2026-02-02&ticker=AAPL"
```

**How data gets in:** Both **ingest_receipts** and **timed_trail** are written on every ingest (d1InsertIngestReceipt and d1InsertTrailPoint). So if ingest is working, both tables have data. Use the stats endpoint to confirm `timed_trail.rows_with_payload_json` is sufficient; if it is, **replay-ticker-d1** (D1) is the better alternative for single-ticker replay (no 429).
