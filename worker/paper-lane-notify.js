// paper-lane-notify.js — activity strip, bell, and email parity for paper lanes
// (index day-trade options + index trend LETF shares).

import { kvGetJSON, kvPutJSON } from "./storage.js";
import { getEmailOptedInUsers, sendTradeAlertEmail } from "./email.js";

const FEED_KEY = "timed:activity:feed";
const EMAIL_THROTTLE_MS = 30 * 60 * 1000;

export function paperEventToActivityType(event) {
  const ev = String(event || "").toUpperCase();
  if (ev === "BUY" || ev === "DCA_ADD") return "TRADE_ENTRY";
  if (ev === "TRIM") return "TRADE_TRIM";
  if (ev === "EXIT" || ev === "STOP") return "TRADE_EXIT";
  return `PAPER_${ev || "EVENT"}`;
}

export function paperEventToNotifType(event) {
  const ev = String(event || "").toUpperCase();
  if (ev === "BUY" || ev === "DCA_ADD") return "trade_entry";
  if (ev === "TRIM") return "trade_trim";
  return "trade_exit";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map paper-lane book + event into sendTradeAlertEmail fields so Index
 * Swings / Day Trade emails match Short Term Position Closed (entry, exit, P&L).
 */
export function buildPaperLaneEmailAlert({
  engine,
  event,
  ticker,
  vehicleTicker,
  direction,
  price,
  qty,
  reason,
  signal_id,
  ts = Date.now(),
  embed,
  book = null,
  management = null,
} = {}) {
  const type = paperEventToActivityType(event);
  const isLetf = engine === "index_trend_letf";
  const sym = String(vehicleTicker || ticker || "").toUpperCase();
  const dir = String(direction || "LONG").toUpperCase();
  const mark = num(price);
  const mgmt = management || book?.management || {};

  let entry = null;
  let exitPx = null;
  let pnlPct = null;
  let shares = num(qty);
  let sl = null;
  let tp = null;

  if (isLetf) {
    entry = num(book?.entry_letf_price);
    exitPx = (type === "TRADE_EXIT" || type === "TRADE_TRIM") ? mark : null;
    if (type === "TRADE_ENTRY") entry = entry ?? mark;
    if (entry > 0 && mark > 0 && type !== "TRADE_ENTRY") {
      pnlPct = Math.round(((mark - entry) / entry) * 10000) / 100;
    }
    // After EXIT/STOP the book stamps shares_remaining=0 — fall back to original shares.
    shares = (shares > 0 ? shares : null)
      ?? (num(book?.shares_remaining) > 0 ? num(book.shares_remaining) : null)
      ?? num(book?.shares);
    sl = num(mgmt.stop_underlying) ?? num(book?.stop_underlying);
    tp = num(mgmt.target_underlying) ?? num(book?.target_underlying);
  } else {
    entry = num(book?.entry_premium);
    exitPx = (type === "TRADE_EXIT" || type === "TRADE_TRIM") ? mark : null;
    if (type === "TRADE_ENTRY") entry = entry ?? mark;
    if (entry > 0 && mark > 0 && type !== "TRADE_ENTRY") {
      pnlPct = Math.round(((mark - entry) / entry) * 10000) / 100;
    }
    shares = (shares > 0 ? shares : null)
      ?? (num(book?.contracts_remaining) > 0 ? num(book.contracts_remaining) : null)
      ?? num(book?.contracts);
    sl = num(book?.stop_premium) ?? num(book?.trail_stop_premium);
    tp = num(book?.exit_premium) ?? num(book?.trim_premium);
  }

  const notional = entry > 0 && shares > 0 ? Math.round(entry * shares * 100) / 100 : null;

  return {
    type,
    mode: "trader",
    ticker: sym,
    underlying: String(ticker || "").toUpperCase() || null,
    direction: dir,
    price: mark,
    entry: entry > 0 ? entry : null,
    exit: exitPx > 0 ? exitPx : null,
    fillPrice: type === "TRADE_TRIM" && mark > 0 ? mark : null,
    pnlPct,
    shares: shares > 0 ? shares : null,
    notional,
    sl: sl > 0 ? sl : null,
    tp: tp > 0 ? tp : null,
    exitReason: reason || null,
    reason: reason || null,
    trade_id: signal_id || null,
    setup_name: isLetf ? "TT Index Swings LETF" : "TT Index Day Trade",
    action_ts: ts,
    headline: embed?.title || `${event} ${sym}`,
    body: String(embed?.description || "").replace(/\*/g, "").slice(0, 1200),
  };
}

export async function appendPaperLaneActivity(KV, row = {}) {
  if (!KV || !row?.ticker) return;
  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const feed = (await kvGetJSON(KV, FEED_KEY)) || [];
  const ts = Number(row.ts) > 0 ? Number(row.ts) : now;
  feed.unshift({
    ...row,
    ts,
    id: `${row.ticker}-${ts}-${Math.random().toString(36).slice(2, 9)}`,
  });
  const keep = feed.filter((e) => Number(e.ts) > oneWeekAgo).slice(0, 500);
  await kvPutJSON(KV, FEED_KEY, keep);
}

export function buildPaperLaneActivityRow({
  engine,
  event,
  ticker,
  vehicleTicker,
  direction,
  price,
  qty,
  reason,
  signal_id,
  ts = Date.now(),
  embed,
  entry = null,
  pnlPct = null,
} = {}) {
  const sym = String(vehicleTicker || ticker || "").toUpperCase();
  const ev = String(event || "").toUpperCase();
  const type = paperEventToActivityType(ev);
  const lane = engine === "index_trend_letf" ? "Index Swings" : "Index Day Trade";
  const detail = embed?.title
    || `${ev} ${sym}${ticker && sym !== String(ticker).toUpperCase() ? ` (${String(ticker).toUpperCase()})` : ""}`;
  return {
    type,
    ticker: sym,
    underlying: String(ticker || "").toUpperCase() || null,
    direction: String(direction || "LONG").toUpperCase(),
    price: Number(price) || null,
    entry: Number(entry) || null,
    pnlPct: Number.isFinite(Number(pnlPct)) ? Number(pnlPct) : null,
    qty: Number(qty) || null,
    reason: reason || null,
    trade_id: signal_id || null,
    mode: "trader",
    engine: String(engine || ""),
    vehicle_lane: lane,
    detail,
    ts,
  };
}

export async function dispatchPaperLaneEmails(env, alertData = {}) {
  if (env?.EMAIL_ENABLED !== "true") return;
  const users = await getEmailOptedInUsers(env, "trade_alerts");
  if (!users.length) return;
  const KV = env?.KV_TIMED;
  const type = String(alertData?.type || "TRADE_ENTRY").toUpperCase();
  const ticker = String(alertData?.ticker || "").toUpperCase();
  if (!ticker) return;
  for (const u of users) {
    const throttleKey = `timed:email:paper:${type}:${u.email}:${ticker}`;
    if (KV) {
      const last = await KV.get(throttleKey);
      if (last && Date.now() - Number(last) < EMAIL_THROTTLE_MS) continue;
    }
    const r = await sendTradeAlertEmail(env, u.email, {
      mode: "trader",
      ...alertData,
      type,
      ticker,
    }).catch(() => ({ ok: false }));
    if (r?.ok && KV) {
      await KV.put(throttleKey, String(Date.now()), {
        expirationTtl: Math.ceil(EMAIL_THROTTLE_MS / 1000) + 120,
      }).catch(() => {});
    }
  }
}

/** Wire KV activity + optional email after Discord paper-lane event. */
export async function wirePaperLaneNotify(env, {
  engine,
  event,
  ticker,
  vehicleTicker,
  direction,
  price,
  qty,
  reason,
  signal_id,
  ts,
  embed,
  book,
  management,
} = {}) {
  const KV = env?.KV_TIMED;
  const emailAlert = buildPaperLaneEmailAlert({
    engine, event, ticker, vehicleTicker, direction, price, qty, reason,
    signal_id, ts, embed, book, management,
  });
  const row = buildPaperLaneActivityRow({
    engine, event, ticker, vehicleTicker, direction, price, qty, reason,
    signal_id, ts, embed,
    entry: emailAlert.entry,
    pnlPct: emailAlert.pnlPct,
  });
  if (KV) await appendPaperLaneActivity(KV, row).catch(() => {});
  await dispatchPaperLaneEmails(env, emailAlert).catch(() => {});
  return row;
}
