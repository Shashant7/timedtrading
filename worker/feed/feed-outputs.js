// ═══════════════════════════════════════════════════════════════════════════
// worker/feed/feed-outputs.js — feed-domain output writers.
//
// P2 decomposition Step 1 prep (2026-06-10). These two functions are
// feed-OUTPUT concerns (what happens to a fresh prices map after the fetch):
//
//   mergeFreshnessIntoLatest    — patch price/day-change/ingest_ts into the
//                                 per-ticker `timed:latest:*` scoring blobs
//                                 so freshness monitors + the UI see live
//                                 ingest timestamps between scoring ticks.
//   syncLivePricesToChartCandles — upsert the forming 30/15/60m bars in D1
//                                 ticker_candles so right-rail charts track
//                                 the same price the header shows (MU
//                                 incident: header $862 vs chart $912).
//
// Lifted VERBATIM from worker/index.js; the monolith now delegates here, and
// the standalone tt-feed worker (worker-feed/) imports them directly.
// `hooks` carries the host-specific session check + optional schema guard.
// ═══════════════════════════════════════════════════════════════════════════

import { kvGetJSON, kvPutJSON } from "../storage.js";
import { normalizeTfKey } from "../ingest.js";

function candleBucketTsMs(tsMs, tfMinutes) {
  const bucketMs = Number(tfMinutes) * 60 * 1000;
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) return 0;
  return Math.floor(Number(tsMs) / bucketMs) * bucketMs;
}

// Patch `timed:latest:${sym}` blobs with fresh price + ingest_ts. Preserves
// non-zero day-change values (a closed-market dc=0 must never erase the last
// known good value) and recomputes from price+prev_close when both sides are
// stale. Batched 50 at a time.
export async function mergeFreshnessIntoLatest(KV, prices) {
  const tickers = Object.keys(prices || {}).filter((s) => Number(prices[s]?.p) > 0);
  if (tickers.length === 0) return { merged: 0 };
  const now = Date.now();
  const ingestTime = new Date(now).toISOString();
  const BATCH = 50;
  let merged = 0;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (sym) => {
        const snap = prices[sym];
        if (!snap || !(Number(snap.p) > 0)) return;
        const existing = await kvGetJSON(KV, `timed:latest:${sym}`);
        if (!existing || typeof existing !== "object") return;
        // CRITICAL: Don't overwrite existing non-zero day_change with 0.
        // When market is closed or prevClose is unavailable, the price feed
        // computes dc=0/dp=0, which would erase the last known good values.
        // Only update if the new value is meaningfully non-zero, OR if existing is missing.
        const newDc = Number.isFinite(snap.dc) ? snap.dc : null;
        const newDp = Number.isFinite(snap.dp) ? snap.dp : null;
        const existDc = existing.day_change;
        const existDp = existing.day_change_pct;
        const updatedPrice = Number(snap.p);
        const updatedPc = Number(snap.pc) || existing.prev_close || 0;

        // If existing day_change is 0 (stale) but we have valid price + prev_close,
        // recompute from scratch so the UI shows a real value.
        let finalDc, finalDp;
        if (newDc !== null && newDc !== 0) {
          // Fresh non-zero value from the price feed — use it
          finalDc = newDc;
          finalDp = newDp;
        } else if (Number.isFinite(existDc) && existDc !== 0) {
          // Existing non-zero value — preserve it
          finalDc = existDc;
          finalDp = existDp;
        } else if (updatedPrice > 0 && updatedPc > 0 && updatedPc !== updatedPrice) {
          // Both existing and new are 0/null, but we have price + prev_close — recompute
          finalDc = Math.round((updatedPrice - updatedPc) * 100) / 100;
          finalDp = Math.round(((updatedPrice - updatedPc) / updatedPc) * 10000) / 100;
        } else {
          finalDc = existDc ?? newDc ?? 0;
          finalDp = existDp ?? newDp ?? 0;
        }

        const updated = {
          ...existing,
          price: updatedPrice,
          prev_close: updatedPc || existing.prev_close,
          day_change: finalDc,
          day_change_pct: finalDp,
          ingest_ts: now,
          ingest_time: ingestTime,
        };
        await kvPutJSON(KV, `timed:latest:${sym}`, updated);
        return 1;
      }),
    );
    merged += results.filter((r) => r.status === "fulfilled" && r.value === 1).length;
  }
  if (merged > 0) {
    console.log(`[FRESHNESS] Merged price+ingest_ts into ${merged}/${tickers.length} tickers`);
  }
  return { merged };
}

// Merge live quote ticks into chart TFs (30/15/60) in D1 so /timed/candles
// tracks the live feed between REST refreshes.
// hooks:
//   isNyRegularMarketOpen() — required session gate (skipped when closed
//                             unless opts.force)
//   ensureCandleSchema(env) — optional; the monolith passes its throttled
//                             d1EnsureCandleSchema, tt-feed omits it (the
//                             table exists in prod; a missing table just
//                             logs a failed batch).
export async function syncLivePricesToChartCandles(env, pricesMap, opts = {}, hooks = {}) {
  const db = env?.DB;
  if (!db || !pricesMap || typeof pricesMap !== "object") return { upserted: 0 };
  const marketOpen = typeof hooks.isNyRegularMarketOpen === "function" ? hooks.isNyRegularMarketOpen() : true;
  if (!marketOpen && !opts.force) return { upserted: 0, skipped: "market_closed" };

  const priority = new Set((opts.priorityTickers || []).map((t) => String(t || "").toUpperCase()).filter(Boolean));
  const entries = Object.entries(pricesMap)
    .map(([sym, snap]) => [String(sym).toUpperCase(), snap])
    .filter(([sym, snap]) => sym && Number(snap?.p) > 0)
    .sort((a, b) => (priority.has(a[0]) ? 0 : 1) - (priority.has(b[0]) ? 0 : 1));

  const maxTickers = Math.max(10, Math.min(300, Number(opts.maxTickers) || 120));
  const chartTfs = [30, 15, 60];
  const nowMs = Date.now();
  const updatedAt = nowMs;
  const stmts = [];

  try {
    if (typeof hooks.ensureCandleSchema === "function") {
      await hooks.ensureCandleSchema(env);
    }
    for (const [sym, snap] of entries.slice(0, maxTickers)) {
      const px = Math.round(Number(snap.p) * 100) / 100;
      const ts = Number(snap.t) || nowMs;
      for (const tfMin of chartTfs) {
        const tfKey = normalizeTfKey(String(tfMin));
        const bucketTs = candleBucketTsMs(ts, tfMin);
        if (!tfKey || !bucketTs) continue;
        stmts.push(
          db.prepare(
            `INSERT INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)
             ON CONFLICT(ticker, tf, ts) DO UPDATE SET
               h = MAX(ticker_candles.h, excluded.h),
               l = MIN(ticker_candles.l, excluded.l),
               c = excluded.c,
               updated_at = excluded.updated_at`
          ).bind(sym, tfKey, bucketTs, px, px, px, px, updatedAt),
        );
      }
    }

    let upserted = 0;
    const BATCH_SIZE = 400;
    for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
      const chunk = stmts.slice(i, i + BATCH_SIZE);
      try {
        await db.batch(chunk);
        upserted += chunk.length;
      } catch (batchErr) {
        console.warn(`[LIVE_CANDLE_SYNC] batch ${i / BATCH_SIZE} failed:`, String(batchErr?.message || batchErr).slice(0, 150));
      }
    }
    if (upserted > 0 && (opts.log !== false)) {
      console.log(`[LIVE_CANDLE_SYNC] merged ${upserted} live quote(s) into chart TFs (${Math.min(entries.length, maxTickers)} tickers, priority=${priority.size})`);
    }
    return { upserted };
  } catch (err) {
    console.warn("[LIVE_CANDLE_SYNC] failed:", String(err?.message || err).slice(0, 200));
    return { upserted: 0, error: String(err?.message || err).slice(0, 200) };
  }
}
