# Cloudflare Usage Evaluation (Workers Paid $5/month)

This doc evaluates your Timed Trading Worker’s use of Cloudflare (KV, D1, Worker requests) against the **Workers Paid plan** limits and highlights where you might approach or exceed them.

---

## 1. Plan limits (Workers Paid, $5/month)

| Resource | Included / month | Overage |
|----------|------------------|--------|
| **Worker requests** | 10 million | $0.30 / million |
| **Worker CPU time** | 30 million ms | $0.02 / million ms |
| **KV reads** | 10 million | $0.50 / million |
| **KV writes** | **1 million** | **$5.00 / million** |
| **KV deletes** | 1 million | $5.00 / million |
| **KV list** | 1 million | $5.00 / million |
| **KV storage** | 1 GB | $0.50 / GB-month |
| **D1 rows read** | 25 billion | $0.001 / million |
| **D1 rows written** | 50 million | $1.00 / million |
| **D1 storage** | 5 GB | $0.75 / GB-month |

The tightest limit for your pattern is **KV writes** (1M/month). KV reads and Worker requests are more forgiving; D1 included amounts are very large.

---

## 2. How you use KV and D1

### 2.1 KV key patterns

- **Global:** `timed:tickers`, `timed:trades:all`, `timed:portfolio:v1`, `timed:activity:feed`, `timed:data_version`, `timed:model:ml_v1`, `timed:corr:open_trades`, `timed:d1:latest_sync_cursor`, throttle/dedupe keys.
- **Per ticker:** `timed:latest:{ticker}`, `timed:trail:{ticker}`, `timed:capture:trail:{ticker}`, `timed:momentum:{ticker}`, `timed:momentum:marketcap:{ticker}`, `timed:momentum:adr:{ticker}`, `timed:momentum:volume:{ticker}`, `timed:momentum:changes:{ticker}`, `timed:momentum:history:{ticker}`, `timed:prevstate:{ticker}`, `timed:prevcorridor:{ticker}`, `timed:prevsqueeze:*`, `timed:context:{ticker}`, `timed:capture:latest:{ticker}`, `timed:fundamentals:{ticker}`, `timed:snapshot:{ticker}:{version}`, `timed:sector_map:{ticker}`, dedupe/alert keys.

### 2.2 D1 tables

- **timed_trail** – ingest history (per ticker/ts).
- **ingest_receipts** – webhook idempotency.
- **ticker_index**, **ticker_latest** – fast UI reads (synced from KV).
- **alerts**, **trades**, **trade_events** – ledger.
- **ticker_candles** – OHLCV.
- **ml_v1_queue** – ML labeling queue.

---

## 3. Estimated usage (typical month)

Assumptions (you can replace with your real numbers):

- **Tickers:** 150–250.
- **Ingests:** ~50–200 per ticker per day (e.g. 5–15 min bars) → **~225K–1.5M ingest requests/month**.
- **UI:** ~500–2000 requests/day (all, latest, trail, trades, sectors, etc.) → **~15K–60K/month**.
- **Cron:** 6 schedules (3× daily AI, every 5 min sync, every 15 min alerts weekdays, every 6 h ML) → **~10K–12K invocations/month**.

### 3.1 Worker requests

- Ingest: 225K–1.5M.
- UI: 15K–60K.
- Cron: ~10K–12K.
- **Total:** ~**250K–1.6M requests/month** → well under 10M. **Risk: low.**

### 3.2 KV reads (approx.)

- **Per ingest:** tickers (1), latest (1), trail (1), trades (1), dedupe/prev state/corridor/squeeze (~6), activity (1), version (1), exec (1), optional momentum/cache (~4). **~15–20 reads per ingest.**
- **Per /timed/all:** 1 + N (N = ticker count). For 200 tickers → **~201 per request.**
- **Cron (e.g. 5‑min sync):** 1 (tickers) + 200 (latest) + 1 (cursor) → **~202 reads per run.** At 288 runs/day → **~58K reads/day** from that cron alone.

Rough month (mid‑range):

- Ingest: 500K ingests × 18 reads ≈ **9M reads** (already near 10M if ingest is heavy).
- UI: 30K × 100 reads ≈ **3M** (if many /all with large N).
- Cron: ~2–3M.
- **Total:** **~10–15M KV reads/month** in a busy scenario. **Risk: medium** if ingest + UI are high; you can cross 10M and pay $0.50/million.

### 3.3 KV writes (approx.) — main risk

- **Per ingest:** latest (1), trail (1), tickers (1), trades (1 if updated), exec (1 if trade event), activity (1), dedupe (1), throttle (1), snapshot (1), capture:latest (1), optional momentum/cache (2–4). **~10–15 writes per ingest.**
- **Cron (5‑min sync):** cursor (1), throttle (1). Per ticker in batch: no direct KV write in sync (D1 only), but **2 writes per run**.
- **Cron (ML training):** model (1) per run when model updated.
- **Other crons:** activity/feed, version, etc. → a few writes per run.

Rough month (mid‑range):

- Ingest: 500K × 12 writes ≈ **6M writes** → **over 1M included.** Overage ≈ 5M × $5 = **$25** from ingest alone.
- Cron: ~1K–2K writes.
- **Total:** **~6–8M KV writes/month** in a busy scenario. **Risk: high** — you can exceed 1M writes by a large margin and incur meaningful overage ($5/million).

### 3.4 KV deletes

- Mostly on **purge/reset** (delete tickers, latest, trail, momentum keys per ticker). Not on the hot path. **Risk: low** unless you run full purges very often.

### 3.5 D1

- **Rows read:** Trail/candles queries are bounded (e.g. LIMIT 200); ticker_latest/ticker_index by key. With 25B included, normal usage is **low risk**.
- **Rows written:** Per ingest: timed_trail (1), ingest_receipts (1), ticker_index (1), ticker_latest (1), optional ml_v1_queue (2). **~4–6 writes per ingest.** 500K ingests → **~2–3M rows written/month** → well under 50M. **Risk: low.**
- **Storage:** Trail + receipts + ledger + candles + ml_v1_queue. With retention (e.g. 7–30 days) and a few hundred tickers, **risk: low** (likely under 1 GB).

---

## 4. Risk summary

| Resource | Risk | Notes |
|----------|------|--------|
| Worker requests | Low | Typical total well under 10M. |
| KV reads | Medium | Can reach 10–15M if ingest + UI + cron are heavy. |
| **KV writes** | **High** | 1M included; ingest alone can be 5–10M writes → **main cost/limit risk.** |
| KV deletes | Low | Only on purge/reset. |
| D1 rows read/written | Low | Included amounts are large. |
| D1 storage | Low | Likely under 1 GB with retention. |

---

## 5. Recommendations

1. **Reduce KV writes per ingest (highest impact)**  
   - **Batch or throttle “hot” writes:** e.g. don’t rewrite `timed:tickers` on every single ingest; update in memory and flush every N ingests or every T seconds (e.g. from a single ticker or from a batch).  
   - **Avoid redundant writes:** If payload is unchanged, skip writing `timed:latest:{ticker}` (and optionally trail).  
   - **Short TTL for ephemeral keys:** Dedupe/throttle keys already use TTL; ensure you’re not doing unnecessary overwrites.  
   - **Trail:** Consider writing trail less often (e.g. every 2nd or 5th bar, or only when state changes) to cut `timed:trail:{ticker}` and `timed:capture:trail:{ticker}` writes.

2. **Cap or sample ingest-triggered writes**  
   - If one ticker can fire 100+ ingests/day, consider server-side throttling (e.g. at most one “latest” + one “trail” write per ticker per 1–5 minutes) so KV writes scale with tickers × time, not raw ingest count.

3. **Cache UI reads**  
   - Use Cache API or short-lived KV caching for `/timed/all` (and similar) so repeated UI loads don’t multiply KV read ops. This also helps if KV reads creep toward 10M.

4. **Monitor in the dashboard**  
   - **Workers & Pages** → your Worker → **Metrics** / **Usage**.  
   - **KV** → namespace → usage (reads/writes/list).  
   - **D1** → database → **Metrics** → Row Metrics (rows read/written).  
   Check at least monthly to confirm estimates and spot spikes.

5. **Optional: move “latest” to D1 only**  
   - If most UI reads can be served from D1 (ticker_latest already exists), you could stop writing `timed:latest:{ticker}` to KV on every ingest and only sync from KV→D1 on a schedule. That would remove the largest per-ingest KV write volume (one write per ticker per ingest). Design would need to account for read path (e.g. /timed/latest and /timed/all reading from D1 or a cache).

---

## 6. Quick numbers to track

- **KV writes per ingest** (average): aim to get this down (e.g. &lt;5) if you’re above ~80K ingests/month to stay near or under 1M KV writes.  
- **Ingests per day (total):** 10K → ~300K/month; 30K → ~900K/month.  
- **Ticker count:** Directly affects /all read volume (1 + N) and number of keys written in purge.

Checking **Cloudflare Dashboard → Workers & Pages → [your Worker] → Metrics** and **KV** usage will show actual request and KV usage so you can replace these estimates with real numbers and re-evaluate risk.
