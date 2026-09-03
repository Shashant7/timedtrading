// worker/trader-entry-catchup.js
//
// 2026-09-03 — Heal Short Term equity + index-trend LETF ENTRIES that
// wrote the model book but never reached the broker (waitUntil stampede,
// 15-min index-trend CPU death, cash floor to 0 whole shares).
// Independent of /timed/options/all. Does NOT chase shorts onto an IRA.

import {
  readClientRing,
  forwardOrderToBridge,
  shouldForwardTraderMirrorAsEquity,
} from "./broker-bridge-client.js";
import { ringLooksLikeRealPlace } from "./investor-catchup-run.js";
import {
  maybeAutoMirrorIndexTrendEvent,
  indexTrendNeedsEntryCatchUp,
  indexTrendCatchUpPlaced,
} from "./index-trend-auto-mirror.js";
import { loadOpenIndexTrendBookForUnderlying } from "./paper-lane-positions.js";
import { INDEX_TREND_TICKERS } from "./index-trend-letf.js";
import { isNyRegularMarketOpenStatic } from "./market-calendar.js";
import { resolveCatchupLivePrice } from "./investor-catchup-gates.js";

export const TRADER_ENTRY_CATCHUP_MAX_OPS = 8;
export const TRADER_ENTRY_DRIFT_PCT = 5;
export const TRADER_ENTRY_ERROR_COOLDOWN_MS = 10 * 60 * 1000;

function ringSideIsBuy(side) {
  const s = String(side || "").toLowerCase();
  return !s
    || s === "buy"
    || s === "long"
    || s === "entry"
    || s === "dca"
    || s === "add"
    || s === "open";
}

export function tradeHasRealBuyPlace(ring, tradeId) {
  const id = String(tradeId || "");
  if (!id) return false;
  return (ring || []).some((r) => {
    if (String(r.trade_id || "") !== id) return false;
    if (!ringSideIsBuy(r.side)) return false;
    return ringLooksLikeRealPlace(r);
  });
}

export function recentRingError(ring, tradeId, nowMs, cooldownMs = TRADER_ENTRY_ERROR_COOLDOWN_MS) {
  const id = String(tradeId || "");
  if (!id) return false;
  const now = Number(nowMs) || Date.now();
  return (ring || []).some((r) => {
    if (String(r.trade_id || "") !== id) return false;
    const st = String(r.status || "");
    if (st !== "error" && st !== "fetch_error") return false;
    const ts = Number(r.ts) || 0;
    return ts > 0 && now - ts < cooldownMs;
  });
}

export function entryDriftPct(live, entry) {
  const e = Number(entry);
  const p = Number(live);
  if (!(e > 0) || !(p > 0)) return null;
  return ((p - e) / e) * 100;
}

export function planTraderEquityEntryCatchup({
  trades = [],
  ring = [],
  livePrices = {},
  nowMs = Date.now(),
  maxBuyDriftPct = TRADER_ENTRY_DRIFT_PCT,
  includeShorts = false,
  force = false,
} = {}) {
  const planned = [];
  const skipped = [];
  for (const t of trades || []) {
    const tradeId = String(t.trade_id || t.id || "").trim();
    const ticker = String(t.ticker || "").toUpperCase();
    const dir = String(t.direction || t.side || "LONG").toUpperCase();
    const entry = Number(t.entry_price ?? t.entryPrice ?? t.entry) || 0;
    const qty = Number(t.shares ?? t.qty) || 0;
    if (!tradeId || !ticker) continue;
    if (!shouldForwardTraderMirrorAsEquity(t)) {
      skipped.push({ trade_id: tradeId, ticker, skip: "not_equity_mirror" });
      continue;
    }
    if (dir === "SHORT" && !includeShorts) {
      skipped.push({ trade_id: tradeId, ticker, skip: "equity_short_blocked_on_ira" });
      continue;
    }
    if (tradeHasRealBuyPlace(ring, tradeId)) {
      skipped.push({ trade_id: tradeId, ticker, skip: "already_mirrored" });
      continue;
    }
    if (!force && recentRingError(ring, tradeId, nowMs)) {
      skipped.push({ trade_id: tradeId, ticker, skip: "recent_reject_cooldown" });
      continue;
    }
    if (!(qty > 0) || !(entry > 0)) {
      skipped.push({ trade_id: tradeId, ticker, skip: "qty_or_entry_unknown" });
      continue;
    }
    const live = livePrices[ticker];
    const drift = entryDriftPct(live, entry);
    if (!force && drift != null && Math.abs(drift) > maxBuyDriftPct) {
      skipped.push({
        trade_id: tradeId,
        ticker,
        skip: "price_drift",
        drift_pct: Math.round(drift * 100) / 100,
        live,
        entry,
      });
      continue;
    }
    planned.push({
      kind: "st_equity",
      trade_id: tradeId,
      ticker,
      direction: dir,
      qty,
      entry,
      live: live ?? null,
      side: dir === "SHORT" ? "short" : "buy",
    });
  }
  return { planned, skipped };
}

export function planIndexTrendEntryCatchup({
  books = [],
  ring = [],
  livePrices = {},
  nowMs = Date.now(),
  maxBuyDriftPct = TRADER_ENTRY_DRIFT_PCT,
  force = false,
} = {}) {
  const planned = [];
  const skipped = [];
  for (const row of books || []) {
    const signalId = String(row.signal_id || row.book?.signal_id || "").trim();
    const letf = String(row.letf_ticker || row.book?.letf_ticker || "").toUpperCase();
    const underlying = String(row.underlying || "").toUpperCase();
    if (!signalId || !letf) continue;
    if (row.needs_catchup === false) {
      skipped.push({ trade_id: signalId, ticker: letf, skip: "already_mirrored" });
      continue;
    }
    if (tradeHasRealBuyPlace(ring, signalId)) {
      skipped.push({ trade_id: signalId, ticker: letf, skip: "already_mirrored" });
      continue;
    }
    if (!force && recentRingError(ring, signalId, nowMs)) {
      skipped.push({ trade_id: signalId, ticker: letf, skip: "recent_reject_cooldown" });
      continue;
    }
    const entry = Number(row.entry ?? row.book?.entry_letf_price) || 0;
    const live = livePrices[letf];
    const drift = entryDriftPct(live, entry);
    if (!force && drift != null && Math.abs(drift) > maxBuyDriftPct) {
      skipped.push({
        trade_id: signalId,
        ticker: letf,
        skip: "price_drift",
        drift_pct: Math.round(drift * 100) / 100,
        live,
        entry,
      });
      continue;
    }
    planned.push({
      kind: "index_trend_letf",
      trade_id: signalId,
      ticker: letf,
      underlying,
      qty: Number(row.shares ?? row.book?.shares) || 0,
      entry,
      live: live ?? null,
      book: row.book || null,
    });
  }
  return { planned, skipped };
}

async function kvJson(env, key) {
  try {
    const raw = await env?.KV_TIMED?.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadOpenTraderEntries(env) {
  if (!env?.DB?.prepare) return [];
  try {
    const r = await env.DB.prepare(
      `SELECT trade_id, ticker, direction, entry_ts, entry_price, shares, status, setup_name
         FROM trades
        WHERE status IN ('OPEN', 'TP_HIT_TRIM')
        ORDER BY entry_ts DESC
        LIMIT 40`,
    ).all();
    return r?.results || [];
  } catch (_) {
    return [];
  }
}

async function loadOpenIndexTrendBooks(env) {
  const rows = [];
  for (const ul of INDEX_TREND_TICKERS) {
    try {
      const loaded = await loadOpenIndexTrendBookForUnderlying(env, ul);
      const book = loaded?.book;
      if (!book) continue;
      const status = String(book.status || "");
      if (status !== "open" && status !== "trimmed") continue;
      const signalId = String(loaded.signal_id || book.signal_id || "").trim();
      if (!signalId) continue;
      const needs = await indexTrendNeedsEntryCatchUp(env, signalId);
      rows.push({
        signal_id: signalId,
        underlying: String(ul).toUpperCase(),
        letf_ticker: String(loaded.letf_ticker || book.letf_ticker || "").toUpperCase(),
        shares: Number(book.shares_remaining ?? book.shares) || 0,
        entry: Number(book.entry_letf_price) || 0,
        book,
        needs_catchup: needs,
      });
    } catch (_) { /* one underlying must not abort the sweep */ }
  }
  return rows;
}

async function loadLivePrices(env, tickers) {
  const blob = (await kvJson(env, "timed:prices")) || {};
  const map = blob.prices || blob || {};
  const out = {};
  for (const ticker of tickers) {
    const t = String(ticker || "").toUpperCase();
    if (!t) continue;
    const latest = await kvJson(env, `timed:latest:${t}`);
    out[t] = resolveCatchupLivePrice(map[t], latest);
  }
  return out;
}

async function shortCatchupClientOrderId(tradeId, nonce) {
  let hex = "";
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${tradeId}|entry|${nonce}`),
    );
    hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    hex = String(Date.now());
  }
  return `ttcu${hex.slice(0, 20)}`.slice(0, 40);
}

export async function runTraderEntryCatchup(env, opts = {}) {
  const dryRun = opts.dry_run !== false;
  const force = opts.force === true;
  const includeShorts = opts.include_shorts === true;
  const maxOps = Math.min(24, Math.max(1, Number(opts.max_ops) || TRADER_ENTRY_CATCHUP_MAX_OPS));
  const maxBuyDriftPct = Number.isFinite(Number(opts.max_buy_drift_pct))
    ? Number(opts.max_buy_drift_pct)
    : TRADER_ENTRY_DRIFT_PCT;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowMs = now.getTime();

  if (!force && !isNyRegularMarketOpenStatic(now)) {
    return {
      ok: true,
      dry_run: dryRun,
      skipped: "not_rth",
      planned: 0,
      results: [],
      forwarded: 0,
    };
  }

  const trades = Array.isArray(opts.trades) ? opts.trades : await loadOpenTraderEntries(env);
  const books = Array.isArray(opts.index_trend_books)
    ? opts.index_trend_books
    : await loadOpenIndexTrendBooks(env);
  const ring = Array.isArray(opts.ring) ? opts.ring : await readClientRing(env);

  const tickers = new Set();
  for (const t of trades) {
    const sym = String(t.ticker || "").toUpperCase();
    if (sym) tickers.add(sym);
  }
  for (const b of books) {
    const letf = String(b.letf_ticker || "").toUpperCase();
    if (letf) tickers.add(letf);
  }
  const livePrices = opts.livePrices || await loadLivePrices(env, [...tickers]);

  const equity = planTraderEquityEntryCatchup({
    trades,
    ring,
    livePrices,
    nowMs,
    maxBuyDriftPct,
    includeShorts,
    force,
  });
  const trend = planIndexTrendEntryCatchup({
    books,
    ring,
    livePrices,
    nowMs,
    maxBuyDriftPct,
    force,
  });

  const plannedFull = [...equity.planned, ...trend.planned];
  const skipped = [...equity.skipped, ...trend.skipped];
  const truncated = Math.max(0, plannedFull.length - maxOps);
  const planned = plannedFull.slice(0, maxOps);
  const results = [];
  const retryNonce = String(opts.retry_nonce || Date.now().toString(36)).slice(0, 24);

  for (const op of planned) {
    if (dryRun) {
      results.push({ ...op, ok: true, dry_run: true });
      continue;
    }
    if (op.kind === "index_trend_letf") {
      const fired = await maybeAutoMirrorIndexTrendEvent(env, {
        event: "BUY",
        catch_up: true,
        signal_id: op.trade_id,
        underlying: op.underlying,
        letf_ticker: op.ticker,
        letf_price: Number(op.live) || Number(op.entry) || 0,
        book: op.book || { shares: op.qty, status: "open" },
        now: nowMs,
      });
      const placed = indexTrendCatchUpPlaced(fired);
      results.push({
        ...op,
        ok: placed,
        skip: placed ? null : (fired?.reason || fired?.fired?.skip || "bridge_reject"),
        bridge: fired,
      });
      continue;
    }
    const clientOrderId = await shortCatchupClientOrderId(op.trade_id, retryNonce);
    const fired = await forwardOrderToBridge(env, {
      user_id: env?.ADMIN_EMAIL || "operator",
      trade_id: op.trade_id,
      client_order_id: clientOrderId,
      ticker: op.ticker,
      side: op.side,
      qty: op.qty,
      entry: op.entry,
      decision_reason: opts.reason || "trader_entry_catchup",
      action_ts: nowMs,
      mode: "trader",
      horizon: "short_term",
      vehicle: "equity_long",
    });
    results.push({
      ...op,
      ok: fired?.ok === true,
      skip: fired?.ok === true ? null : (fired?.skip || fired?.error || fired?.response?.reject_reason || "bridge_reject"),
      bridge: fired,
    });
  }

  return {
    ok: true,
    dry_run: dryRun,
    planned: planned.length,
    planned_total: plannedFull.length,
    truncated,
    skipped_count: skipped.length,
    skipped,
    results,
    forwarded: results.filter((r) => r.ok && !r.dry_run && !r.skip).length,
  };
}
