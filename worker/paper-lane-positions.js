// paper-lane-positions.js — open paper-lane books as trade-shaped rows for
// Kanban, model board, and GET /timed/trades?source=paper.

import { lookupLETF, DAY_TRADE_TICKERS } from "./options-plays.js";
import { pickPreferredLetfTicker } from "./letf-vehicles.js";
import { INDEX_TREND_TICKERS } from "./index-trend-letf.js";
import { loadDayTradeBook } from "./option-day-trade-alerts.js";
import { loadIndexTrendBook } from "./index-trend-alerts.js";

function bookIsLive(book) {
  const status = String(book?.status || "");
  return status === "open" || status === "trimmed";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmtExpShort(exp) {
  if (!exp) return "";
  const iso = String(exp.iso || exp).slice(0, 10);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m[2]) - 1] || m[2]} ${Number(m[3])}`;
}

export function formatDayTradeVehicleLabel(book = {}) {
  const sym = String(book.ticker || "").toUpperCase();
  const strike = Math.round(Number(book.strike) || 0);
  const flavor = String(book.flavor || "call").toLowerCase() === "put" ? "P" : "C";
  const exp = fmtExpShort(book.expiration);
  if (!sym || !strike) return sym || "OPTION";
  return exp ? `${sym} ${strike}${flavor} ${exp}` : `${sym} ${strike}${flavor}`;
}

/** Candidate LETF tickers to scan for an open index-trend carry book. */
export function indexTrendLetfCandidates(underlying) {
  const entry = lookupLETF(underlying);
  if (!entry) return [];
  const out = new Set();
  for (const dir of ["LONG", "SHORT"]) {
    const pref = pickPreferredLetfTicker(entry, dir);
    if (pref) out.add(String(pref).toUpperCase());
  }
  for (const k of ["long", "short", "long_alts", "short_alts"]) {
    const v = entry[k];
    if (Array.isArray(v)) v.forEach((x) => out.add(String(x).toUpperCase()));
    else if (v) out.add(String(v).toUpperCase());
  }
  return [...out];
}

export async function loadOpenIndexTrendBookForUnderlying(env, underlying) {
  for (const letf of indexTrendLetfCandidates(underlying)) {
    const loaded = await loadIndexTrendBook(env, { letf_ticker: letf });
    if (bookIsLive(loaded?.book)) return { ...loaded, letf_ticker: letf };
  }
  return { book: null, bookKey: null, fromCarry: false, carryKey: null, letf_ticker: null };
}

export function dayTradeBookToTrade(underlying, loaded = {}) {
  const book = loaded.book;
  if (!bookIsLive(book)) return null;
  const sym = String(underlying || book.ticker || "").toUpperCase();
  const entry = num(book.entry_premium);
  const live = num(book.last_premium);
  const contracts = Number(book.contracts_remaining ?? book.contracts) || 0;
  const trimmed = String(book.status).toLowerCase() === "trimmed";
  const original = Number(book.contracts) || contracts;
  const trimmedPct = trimmed && original > 0
    ? Math.min(1, (original - contracts) / original)
    : 0;
  const vehicle = formatDayTradeVehicleLabel(book);
  const dir = String(book.flavor || "").toLowerCase() === "put" ? "SHORT" : "LONG";
  let pnlPct = null;
  if (entry > 0 && live > 0) {
    pnlPct = Math.round(((live - entry) / entry) * 1000) / 10;
  }
  return {
    id: loaded.signal_id || book.signal_id || `dt:${sym}`,
    trade_id: loaded.signal_id || book.signal_id || `dt:${sym}`,
    ticker: sym,
    direction: dir,
    entry_price: entry,
    entryPrice: entry,
    mark_price: live,
    current_price: live,
    entry_ts: Number(book.entry_ts) || null,
    status: trimmed ? "TP_HIT_TRIM" : "OPEN",
    sl: num(book.stop_premium) ?? num(book.trail_stop_premium),
    tp: num(book.exit_premium),
    instrument: "option",
    qty: contracts,
    contracts,
    trimmed_pct: trimmedPct,
    kanban_stage: trimmed ? "trim" : "hold",
    pnl_pct: pnlPct,
    _source_mode: "trader",
    _paper_lane: "index_day_trade",
    _vehicle_label: vehicle,
    _vehicle_ticker: vehicle,
    _card_key: `${vehicle.replace(/\s+/g, "_")}:index_day_trade`,
    setup_name: "Index Day Trade",
    note: book.held_overnight ? "overnight_carry" : "index_day_trade",
  };
}

export function indexTrendBookToTrade(underlying, letfTicker, loaded = {}) {
  const book = loaded.book;
  if (!bookIsLive(book)) return null;
  const ul = String(underlying || "").toUpperCase();
  const letf = String(letfTicker || book.letf_ticker || "").toUpperCase();
  const entry = num(book.entry_letf_price);
  const live = num(book.last_letf_price);
  const shares = Number(book.shares_remaining ?? book.shares) || 0;
  const trimmed = String(book.status).toLowerCase() === "trimmed";
  const original = Number(book.shares) || shares;
  const trimmedPct = trimmed && original > 0
    ? Math.min(1, (original - shares) / original)
    : 0;
  let pnlPct = null;
  if (entry > 0 && live > 0) {
    pnlPct = Math.round(((live - entry) / entry) * 1000) / 10;
  }
  const stopUl = num(book.stop_underlying);
  const targetUl = num(book.target_underlying);
  return {
    id: loaded.signal_id || book.signal_id || `it:${ul}:${letf}`,
    trade_id: loaded.signal_id || book.signal_id || `it:${ul}:${letf}`,
    ticker: ul,
    direction: String(book.direction || "LONG").toUpperCase(),
    entry_price: entry,
    entryPrice: entry,
    mark_price: live,
    current_price: live,
    entry_ts: Number(book.entry_ts) || null,
    status: trimmed ? "TP_HIT_TRIM" : "OPEN",
    sl: stopUl,
    tp: targetUl,
    instrument: "letf",
    qty: shares,
    shares,
    trimmed_pct: trimmedPct,
    kanban_stage: trimmed ? "trim" : "hold",
    pnl_pct: pnlPct,
    _source_mode: "trader",
    _paper_lane: "index_swing",
    _vehicle_label: letf,
    _vehicle_ticker: letf,
    _card_key: `${letf}:index_swing`,
    setup_name: "Index Swings LETF",
    note: "index_trend_letf",
  };
}

/** List all open paper-lane positions (day-trade options + index trend LETF). */
export async function listOpenPaperLaneTrades(env) {
  const trades = [];
  for (const sym of DAY_TRADE_TICKERS) {
    const loaded = await loadDayTradeBook(env, { ticker: sym });
    const row = dayTradeBookToTrade(sym, loaded);
    if (row) trades.push(row);
  }
  for (const sym of INDEX_TREND_TICKERS) {
    const loaded = await loadOpenIndexTrendBookForUnderlying(env, sym);
    if (!bookIsLive(loaded?.book)) continue;
    const row = indexTrendBookToTrade(sym, loaded.letf_ticker, loaded);
    if (row) trades.push(row);
  }
  return trades;
}
