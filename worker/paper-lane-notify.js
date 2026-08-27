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
} = {}) {
  const KV = env?.KV_TIMED;
  const row = buildPaperLaneActivityRow({
    engine, event, ticker, vehicleTicker, direction, price, qty, reason, signal_id, ts, embed,
  });
  if (KV) await appendPaperLaneActivity(KV, row).catch(() => {});
  await dispatchPaperLaneEmails(env, {
    type: paperEventToActivityType(event),
    ticker: row.ticker,
    underlying: row.underlying,
    direction: row.direction,
    price: row.price,
    qty: row.qty,
    reason: row.reason,
    headline: embed?.title || `${event} ${row.ticker}`,
    body: String(embed?.description || "").replace(/\*/g, "").slice(0, 1200),
    setup_name: engine === "index_trend_letf" ? "Index Swings LETF" : "Index Day Trade",
    trade_id: signal_id || null,
  }).catch(() => {});
  return row;
}
