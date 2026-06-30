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
import { isNyRegularMarketOpen } from "../market-calendar.js";

export const PF_FRESH_MS = 30 * 60 * 1000;
/** Outside RTH the last trade clock ages normally — 26h catches week-old zombies. */
export const PF_VALUE_FRESH_MS_CLOSED = 26 * 60 * 60 * 1000;

/** Poll timestamp on timed:prices row (`t`) — updated every cron tick. */
export function isPriceFeedTickFresh(pf, nowMs = Date.now()) {
  const t = Number(pf?.t) || 0;
  return t > 0 && (nowMs - t) <= PF_FRESH_MS;
}

/** Value timestamp (`p_ts`) — last time `p` actually moved. Never fall back to poll `t`. */
export function priceValueTimestamp(pf) {
  return Number(pf?.p_ts) || 0;
}

export function isPriceValueFresh(pf, nowMs = Date.now(), marketOpen = true) {
  const ts = priceValueTimestamp(pf);
  if (!(ts > 0)) return false;
  const maxAge = marketOpen ? PF_FRESH_MS : PF_VALUE_FRESH_MS_CLOSED;
  return (nowMs - ts) <= maxAge;
}

/**
 * Overlay one timed:prices row onto a ticker payload (snapshot / latest).
 * Always writes live price; resolves prev_close with TD-first logic.
 * Fresh per-symbol ticks bypass the 8% sanity cap (SMCI crash-day fix).
 */
export function overlayTimedPricesRow(obj, pf, opts = {}) {
  const sym = String(opts.sym || obj?.ticker || "").toUpperCase();
  const pricesUpdatedAt = Number(opts.pricesUpdatedAt) || Number(pf?.t) || Date.now();
  const dailyCandlePc = Number(opts.dailyCandlePc) || 0;
  const marketOpen = opts.marketOpen !== false;
  if (!obj || !pf || !(Number(pf.p) > 0)) return obj;

  const pfP = Number(pf.p);
  const pfPc = Number(pf.pc);
  const pfDp = Number(pf.dp);
  const pfDc = Number(pf.dc);
  const tickFresh = isPriceFeedTickFresh(pf);
  const valueFresh = isPriceValueFresh(pf, Date.now(), marketOpen);
  const pfValueTs = priceValueTimestamp(pf);

  // Never poison /timed/all with week-old prints (GS @ 1090). Cron refreshes
  // `t` every minute even when `p` is a zombie — gate on p_ts.
  if (!valueFresh) return obj;

  obj.price = pfP;
  obj._live_price = pfP;
  obj._live_daily_high = pf.dh;
  obj._live_daily_low = pf.dl;
  obj._live_daily_volume = pf.dv;
  obj._price_updated_at = Math.max(pricesUpdatedAt, pfValueTs, Number(pf.t) || 0);
  obj._price_value_ts = pfValueTs;

  // Outside RTH, pf.p is today's RTH close (extended print is ahp).
  // Scoring snapshots often leave close == prev_close; cards must not
  // read that stale close via getHeadlinePrice().
  if (!marketOpen) {
    obj.close = pfP;
  }

  if (!marketOpen) {
    const pfAhDp = Number(pf.ahdp);
    const pfAhDc = Number(pf.ahdc);
    const pfAhP = Number(pf.ahp);
    const isCrypto = sym === "BTCUSD" || sym === "ETHUSD";
    const absCap = isCrypto ? 200 : 50;
    if (Number.isFinite(pfAhDp) && pfAhDp !== 0 && Math.abs(pfAhDp) <= absCap) {
      obj._ah_change_pct = pfAhDp;
      obj._ah_change = Number.isFinite(pfAhDc) ? pfAhDc : 0;
      if (Number.isFinite(pfAhP) && pfAhP > 0) obj._ah_price = pfAhP;
    }
  }

  const pfPcUsable = Number.isFinite(pfPc) && pfPc > 0 && pfP > 0
    && (Math.abs(pfPc - pfP) / pfP * 100) > 0.05;

  const tdMoveConfirmed = pfPcUsable
    && Number.isFinite(pfDp) && pfDp !== 0
    && Math.abs(pfDp) > 8
    && Math.abs((pfP - pfPc) / pfPc * 100 - pfDp) < 3;

  let bestPc = 0;
  let bestPcSource = "none";
  if (pfPcUsable && (tickFresh || tdMoveConfirmed || Math.abs(pfDp) <= 8 || !Number.isFinite(pfDp))) {
    bestPc = pfPc;
    bestPcSource = "td";
  } else if (dailyCandlePc > 0) {
    bestPc = dailyCandlePc;
    bestPcSource = "daily_candle";
  } else if (obj.prev_close || obj._live_prev_close) {
    bestPc = Number(obj.prev_close || obj._live_prev_close) || 0;
    bestPcSource = "stored";
  }

  if (!tickFresh && !tdMoveConfirmed && bestPc > 0 && pfP > 0
      && Math.abs((pfP - bestPc) / bestPc * 100) > 8) {
    if (bestPcSource === "td" && dailyCandlePc > 0
        && Math.abs((pfP - dailyCandlePc) / dailyCandlePc * 100) <= 8) {
      bestPc = dailyCandlePc;
      bestPcSource = "daily_candle_fallback";
    } else {
      const storedPc = Number(obj.prev_close || obj._live_prev_close) || 0;
      if (storedPc > 0 && Math.abs((pfP - storedPc) / storedPc * 100) <= 8) {
        bestPc = storedPc;
        bestPcSource = "stored_fallback";
      } else {
        bestPc = 0;
        bestPcSource = "rejected_extreme";
      }
    }
  }

  if (bestPc > 0) {
    obj._live_prev_close = bestPc;
    obj.prev_close = bestPc;
  } else if (tickFresh && pfPcUsable) {
    obj._live_prev_close = pfPc;
    obj.prev_close = pfPc;
  }

  if (bestPcSource === "td" && Number.isFinite(pfDp) && pfDp !== 0) {
    obj.day_change_pct = pfDp;
    obj.change_pct = pfDp;
    if (Number.isFinite(pfDc) && pfDc !== 0) {
      obj.day_change = pfDc;
      obj.change = pfDc;
    }
  } else if (bestPc > 0 && pfP > 0) {
    const computedDc = Math.round((pfP - bestPc) * 100) / 100;
    const computedDp = Math.round(((pfP - bestPc) / bestPc) * 10000) / 100;
    obj.day_change = computedDc;
    obj.day_change_pct = computedDp;
    obj.change = computedDc;
    obj.change_pct = computedDp;
  } else if (tickFresh && pfPcUsable) {
    if (Number.isFinite(pfDp) && pfDp !== 0) {
      obj.day_change_pct = pfDp;
      obj.change_pct = pfDp;
    }
    if (Number.isFinite(pfDc) && pfDc !== 0) {
      obj.day_change = pfDc;
      obj.change = pfDc;
    } else {
      const computedDc = Math.round((pfP - pfPc) * 100) / 100;
      const computedDp = Math.round(((pfP - pfPc) / pfPc) * 10000) / 100;
      obj.day_change = computedDc;
      obj.day_change_pct = computedDp;
      obj.change = computedDc;
      obj.change_pct = computedDp;
    }
  }

  const pfTs = Math.max(pricesUpdatedAt, Number(pf.t) || 0);
  if (pfTs > 0) {
    const existingTs = Number(obj.ingest_ts) || Number(obj.ts) || 0;
    const existingNorm = existingTs > 0 && existingTs < 1e12 ? existingTs * 1000 : existingTs;
    if (pfTs > existingNorm) {
      obj.ingest_ts = pfTs;
      obj.ingest_time = new Date(pfTs).toISOString();
    }
  }

  return obj;
}

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
        const marketOpen = isNyRegularMarketOpen();
        // During RTH open, a price that equals prev_close with zero day
        // change is almost always a stale vendor quote (PWR 2026-06-23).
        // Do not stamp a fresh ingest_ts — that defeats age-based guards.
        const staleOpenQuote = marketOpen
          && updatedPrice > 0
          && updatedPc > 0
          && Math.abs(updatedPrice - updatedPc) < updatedPc * 0.0005
          && (!Number.isFinite(newDc) || newDc === 0)
          && (!Number.isFinite(newDp) || newDp === 0);

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
          close: updatedPrice,
          prev_close: updatedPc || existing.prev_close,
          day_change: finalDc,
          day_change_pct: finalDp,
          _price_updated_at: Number(snap.t) || now,
          ...(staleOpenQuote ? { __price_stale_at_open: true } : {}),
          ingest_ts: staleOpenQuote ? (existing.ingest_ts || existing.ts || now) : now,
          ingest_time: staleOpenQuote
            ? (existing.ingest_time || new Date(existing.ingest_ts || now).toISOString())
            : ingestTime,
        };
        if (!isNyRegularMarketOpen()) {
          const pfAhP = Number(snap.ahp);
          const pfAhDc = Number(snap.ahdc);
          const pfAhDp = Number(snap.ahdp);
          if (Number.isFinite(pfAhP) && pfAhP > 0) updated._ah_price = pfAhP;
          if (Number.isFinite(pfAhDc)) updated._ah_change = pfAhDc;
          if (Number.isFinite(pfAhDp)) updated._ah_change_pct = pfAhDp;
        } else {
          delete updated._ah_price;
          delete updated._ah_change;
          delete updated._ah_change_pct;
        }
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

// Merge live quote ticks into chart 1H TF in D1 so /timed/candles tracks
// the live feed between REST refreshes (chart UI no longer surfaces 15m/30m).
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

  // Freshness Doctrine grades 10/30 as CRITICAL_RTH — patch all leading
  // intraday TFs from the live quote so D1 ages stay within SLO between
  // */5 REST bar fetches (PriceStream does NOT write ticker_candles).
  const maxTickers = Math.max(10, Math.min(300, Number(opts.maxTickers) || 280));
  const chartTfs = [10, 15, 30, 60];
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
