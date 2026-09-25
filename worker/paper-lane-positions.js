// paper-lane-positions.js — open paper-lane books as trade-shaped rows for
// Kanban, model board, and GET /timed/trades?source=paper.

import { lookupLETF, DAY_TRADE_TICKERS } from "./options-plays.js";
import { pickPreferredLetfTicker } from "./letf-vehicles.js";
import { INDEX_TREND_TICKERS } from "./index-trend-letf.js";
import { loadDayTradeBook, readDayTradeActions } from "./option-day-trade-alerts.js";
import { loadIndexTrendBook, readIndexTrendActions } from "./index-trend-alerts.js";
import { indexTrendBookIsLive } from "./index-trend-paper.js";
import { HARD_STOP_PCT } from "./option-day-trade-plan.js";
import { readMarks, pickFreshMarkMid, buildOccSymbol } from "./options-marks.js";

/** Options contract multiplier — $ P&L = premium delta × contracts × 100. */
const OPT_MULTIPLIER = 100;

function bookIsLive(book) {
  return indexTrendBookIsLive(book);
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

function defaultStopPremium(entry) {
  if (!(entry > 0)) return null;
  return Math.round(entry * (1 + HARD_STOP_PCT / 100) * 100) / 100;
}

/** Overlay a fresh contract mid onto a paper option trade row. */
export function applyLivePremiumToTrade(row, liveMid) {
  const mid = num(liveMid);
  if (!row || !(mid > 0)) return row;
  const entry = num(row.entry_premium) ?? num(row.entry_price);
  let pnlPct = row.pnl_pct;
  if (entry > 0) pnlPct = Math.round(((mid - entry) / entry) * 1000) / 10;
  return {
    ...row,
    mark_price: mid,
    current_price: mid,
    last_premium: mid,
    pnl_pct: pnlPct,
  };
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
  const trimPx = num(book.trim_premium);
  const exitPx = num(book.exit_premium);
  const stopPx = num(book.stop_premium) ?? num(book.trail_stop_premium) ?? defaultStopPremium(entry);
  const tpArray = [trimPx, exitPx].filter((n) => n > 0);
  let pnlPct = null;
  if (entry > 0 && live > 0) {
    pnlPct = Math.round(((live - entry) / entry) * 1000) / 10;
  }
  return {
    id: loaded.signal_id || book.signal_id || `dt:${sym}`,
    trade_id: loaded.signal_id || book.signal_id || `dt:${sym}`,
    ticker: sym,
    direction: dir,
    flavor: String(book.flavor || "call").toLowerCase(),
    entry_price: entry,
    entryPrice: entry,
    entry_premium: entry,
    mark_price: live,
    current_price: live,
    last_premium: live,
    trim_premium: trimPx,
    exit_premium: exitPx,
    stop_premium: stopPx,
    trail_stop_premium: num(book.trail_stop_premium),
    entry_ts: Number(book.entry_ts) || null,
    status: trimmed ? "TP_HIT_TRIM" : "OPEN",
    sl: stopPx,
    tp: exitPx,
    tpArray,
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

async function overlayFreshOptionMark(env, book, row) {
  if (!row || !book) return row;
  try {
    const flavor = String(book.flavor || "").toLowerCase() === "put" ? "P" : "C";
    const occ = buildOccSymbol(row.ticker, book.expiration?.iso, flavor, book.strike);
    const fromTs = Date.now() - 20 * 60 * 1000;
    const marks = occ
      ? await readMarks(env, { optionSymbol: occ, fromTs, limit: 30 })
      : [];
    const fresh = pickFreshMarkMid(marks);
    if (fresh?.mid > 0) return applyLivePremiumToTrade(row, fresh.mid);
  } catch (_) { /* keep book last_premium */ }
  return row;
}

/** List all open paper-lane positions (day-trade options + index trend LETF). */
export async function listOpenPaperLaneTrades(env) {
  const trades = [];
  for (const sym of DAY_TRADE_TICKERS) {
    const loaded = await loadDayTradeBook(env, { ticker: sym });
    const row = dayTradeBookToTrade(sym, loaded);
    if (row) trades.push(await overlayFreshOptionMark(env, loaded?.book, row));
  }
  for (const sym of INDEX_TREND_TICKERS) {
    const loaded = await loadOpenIndexTrendBookForUnderlying(env, sym);
    if (!bookIsLive(loaded?.book)) continue;
    const row = indexTrendBookToTrade(sym, loaded.letf_ticker, loaded);
    if (row) trades.push(row);
  }
  return trades;
}

function actionEvent(a) {
  return String(a?.event || "").toUpperCase();
}

/** Normalize DT + LETF action rings into one chronological activity feed. */
export function normalizePaperLaneActions({ dayTrade = [], indexTrend = [] } = {}) {
  const out = [];
  for (const a of dayTrade) {
    const ev = actionEvent(a);
    if (!ev) continue;
    out.push({
      ts: Number(a.ts) || 0,
      event: ev,
      lane: "index_day_trade",
      lane_label: "Day Trade",
      ticker: String(a.ticker || "").toUpperCase(),
      vehicle: String(a.ticker || "").toUpperCase(),
      signal_id: String(a.signal_id || ""),
      qty: Number(a.contracts) || 0,
      price: Number(a.premium) || 0,
      reason: a.reason || null,
      instrument: "option",
    });
  }
  for (const a of indexTrend) {
    const ev = actionEvent(a);
    if (!ev) continue;
    const letf = String(a.letf_ticker || "").toUpperCase();
    const ul = String(a.underlying || "").toUpperCase();
    out.push({
      ts: Number(a.ts) || 0,
      event: ev,
      lane: "index_swing",
      lane_label: "Index Swings",
      ticker: ul || letf,
      vehicle: letf || ul,
      signal_id: String(a.signal_id || ""),
      qty: Number(a.shares) || 0,
      price: Number(a.letf_price) || 0,
      reason: a.reason || null,
      instrument: "letf",
      underlying: ul || null,
      letf_ticker: letf || null,
    });
  }
  out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  return out;
}

/**
 * Collapse a signal's BUY / TRIM / EXIT / STOP tape into closed round rows
 * for Portfolio history / performance.
 *
 * Must match `scripts/replay-day-trades.mjs` round accounting: TRIM proceeds
 * count toward realized P&L. Pairing only the final EXIT/STOP qty against
 * entry undercounts every trimmed winner (e.g. BUY 2 + TRIM 1 + EXIT 1
 * would report half the round). Re-entry on the same signal_id (same strike
 * later in the session) opens a new round.
 */
export function closedTradesFromPaperActions(actions = []) {
  const bySignal = new Map();
  for (const a of actions) {
    const sid = String(a?.signal_id || "").trim();
    if (!sid) continue;
    if (!bySignal.has(sid)) bySignal.set(sid, []);
    bySignal.get(sid).push(a);
  }
  const trades = [];

  const pushClosedRound = (sid, round) => {
    if (!round?.entry || !round.legs?.length) return;
    if (round.qtyRemaining > 0) return; // still open — not Portfolio history
    const buy = round.entry;
    const last = round.legs[round.legs.length - 1];
    const closeEv = actionEvent(last);
    if (closeEv !== "EXIT" && closeEv !== "STOP") return;

    const entry = num(buy.price);
    const entryQty = num(buy.qty) || 0;
    const isOpt = last.instrument === "option" || buy.instrument === "option"
      || round.legs.some((l) => l.instrument === "option");
    const mult = isOpt ? OPT_MULTIPLIER : 1;

    let sold = 0;
    let proceeds = 0;
    for (const leg of round.legs) {
      const q = num(leg.qty) || 0;
      const px = num(leg.price) || 0;
      proceeds += px * q * mult;
      sold += q;
    }
    const basis = (entry != null && entry > 0 && entryQty > 0) ? entry * entryQty * mult : null;
    let realized = null;
    let realizedPct = null;
    if (basis != null && basis > 0) {
      realized = Math.round((proceeds - basis) * 100) / 100;
      realizedPct = Math.round(((proceeds - basis) / basis) * 1000) / 10;
    }
    // Volume-weighted exit across TRIM + final close (display only).
    let exit = num(last.price);
    if (sold > 0 && mult > 0) {
      const vwap = proceeds / (sold * mult);
      if (Number.isFinite(vwap) && vwap > 0) exit = Math.round(vwap * 10000) / 10000;
    }

    const status = realized == null
      ? "CLOSED"
      : realized > 0 ? "WIN" : realized < 0 ? "LOSS" : "FLAT";
    const lane = last.lane || buy.lane;
    trades.push({
      id: `${sid}:${closeEv}:${last.ts}`,
      trade_id: sid,
      signal_id: sid,
      ticker: String(last.ticker || buy.ticker || "").toUpperCase(),
      direction: "LONG",
      entry_price: entry,
      entryPrice: entry,
      exit_price: exit,
      exitPrice: exit,
      entry_ts: Number(buy.ts) || null,
      exit_ts: Number(last.ts) || null,
      status,
      realized_pnl: realized,
      realizedPnl: realized,
      pnl: realized,
      realized_pct: realizedPct,
      realizedPct: realizedPct,
      pct_return: realizedPct,
      pnl_pct: realizedPct,
      pnlPct: realizedPct,
      qty: entryQty,
      contracts: isOpt ? entryQty : null,
      shares: isOpt ? null : entryQty,
      instrument: isOpt ? "option" : "letf",
      _paper_lane: lane,
      _lane: lane,
      _lane_label: last.lane_label || buy.lane_label,
      _vehicle_label: last.vehicle || buy.vehicle,
      setup_name: lane === "index_swing" ? "Index Swings LETF" : "Index Day Trade",
      note: closeEv === "STOP" ? "stop" : "exit",
      close_event: closeEv,
      reason: last.reason || null,
    });
  };

  for (const [sid, rows] of bySignal) {
    const ordered = [...rows].sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    let cur = null;
    for (const e of ordered) {
      const ev = actionEvent(e);
      if (ev === "BUY") {
        // Re-entry on the same signal_id starts a new round; drop any
        // unfinished prior (still-open) tape rather than inventing a close.
        cur = { entry: e, legs: [], qtyRemaining: num(e.qty) || 0 };
        continue;
      }
      if (!cur) continue;
      if (ev !== "TRIM" && ev !== "EXIT" && ev !== "STOP") continue;
      cur.legs.push(e);
      cur.qtyRemaining -= num(e.qty) || 0;
      if ((ev === "EXIT" || ev === "STOP") && cur.qtyRemaining <= 0) {
        pushClosedRound(sid, cur);
        cur = null;
      }
    }
  }
  trades.sort((a, b) => (Number(b.exit_ts) || 0) - (Number(a.exit_ts) || 0));
  return trades;
}

/** Activity feed + closed paper-lane trades for Portfolio history. */
export async function listPaperLaneHistory(env, { sinceMs = 0 } = {}) {
  const [dayTrade, indexTrend] = await Promise.all([
    readDayTradeActions(env, sinceMs),
    readIndexTrendActions(env, sinceMs),
  ]);
  const actions = normalizePaperLaneActions({ dayTrade, indexTrend });
  const trades = closedTradesFromPaperActions(actions);
  return { actions, trades };
}
