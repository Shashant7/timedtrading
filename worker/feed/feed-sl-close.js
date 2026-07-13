// */1 price-feed stop-loss breach detection + trigger ring buffer.
// Uses the same worst-case price logic as sl-hard-exit.js so feed ticks
// cannot miss NVDA-class breaches where the scoring snapshot lags the feed.

import { kvGetJSON, kvPutJSON } from "../storage.js";
import {
  resolvePublishedStopLoss,
  resolvePriceForStopCheck,
  isStopLossBreached,
  resolveAuthoritativeEntryPrice,
  shouldDeferFeedSlOutsideRth,
} from "./sl-hard-exit.js";

const TRIGGER_RING_KEY = "timed:feed-sl-triggers";
const TRIGGER_RING_MAX = 50;

/** Minimal ticker payload from one timed:prices row for stop checks. */
export function buildTickerDataFromFeedSnap(sym, feedSnap, marketOpen = true) {
  const pfP = Number(feedSnap?.p);
  if (!(pfP > 0)) return null;
  const obj = {
    ticker: String(sym || "").toUpperCase(),
    price: pfP,
    _live_price: pfP,
    prev_close: Number(feedSnap?.pc) || undefined,
  };
  if (!marketOpen) obj.close = pfP;
  return obj;
}

/**
 * Scan open trades against the current prices map. Returns breaches where
 * worst-case check price is past the published stop (history → trade row).
 * Feed cron uses feed prints only (no PnL-implied marks) — KV entry/pnl
 * lag D1 VWAP after trims (KO-class false breaches).
 */
export function detectFeedSlBreaches(openTrades, pricesMap, marketOpen = true) {
  const breaches = [];
  if (!Array.isArray(openTrades) || !pricesMap || typeof pricesMap !== "object") {
    return breaches;
  }

  for (const trade of openTrades) {
    const sym = String(trade?.ticker || "").toUpperCase();
    if (!sym) continue;
    const snap = pricesMap[sym];
    if (!snap || !(Number(snap.p) > 0)) continue;

    const direction = String(trade.direction || "LONG").toUpperCase();
    const sl = resolvePublishedStopLoss(null, trade);
    if (!(Number.isFinite(sl) && sl > 0)) continue;

    const tickerData = buildTickerDataFromFeedSnap(sym, snap, marketOpen);
    const feedPx = Number(snap.p);
    const checkPx = resolvePriceForStopCheck(
      tickerData,
      feedPx,
      direction,
      marketOpen,
      trade,
      null,
      { includePnlImplied: false },
    );

    if (!isStopLossBreached(direction, checkPx, sl)) continue;

    const entryPx = resolveAuthoritativeEntryPrice(trade, null);
    const defer = shouldDeferFeedSlOutsideRth({
      marketOpen,
      direction,
      checkPx,
      feedPx,
      sl,
      entryPx,
      pnlPct: trade?.pnlPct ?? trade?.pnl_pct,
    });
    if (defer.defer) continue;

    breaches.push({ sym, trade, sl, checkPx, feedPx, direction });
  }
  return breaches;
}

/** Append one feed-SL trigger event to the admin ring buffer. */
export async function appendFeedSlTrigger(KV, entry) {
  if (!KV || !entry) return;
  try {
    const prev = (await kvGetJSON(KV, TRIGGER_RING_KEY)) || [];
    const ring = Array.isArray(prev) ? prev : [];
    ring.unshift({
      ...entry,
      ts: Number(entry.ts) || Date.now(),
    });
    await kvPutJSON(KV, TRIGGER_RING_KEY, ring.slice(0, TRIGGER_RING_MAX));
  } catch (_) { /* observability only */ }
}

export async function readFeedSlTriggers(KV) {
  if (!KV) return [];
  try {
    const raw = await kvGetJSON(KV, TRIGGER_RING_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}
