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

/** Display rank is 0–100. Raw `rank_score` can be 100+ and is not /100. */
export function pickDisplayRank(...candidates) {
  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0 && n <= 100) return n;
  }
  return null;
}

/**
 * Rank / conviction for Index Swings + Day Trade emails.
 * Prefer explicit fields, then the paper book (stamped at BUY), then tickerData.
 */
export function resolvePaperLaneAlertScores({
  rank,
  rr,
  conviction_score,
  conviction_tier,
  signal_quality_lines,
  tickerData,
  book,
  play,
} = {}) {
  const src = tickerData && typeof tickerData === "object" ? tickerData : {};
  const b = book && typeof book === "object" ? book : {};
  const p = play && typeof play === "object" ? play : {};
  const displayRank = pickDisplayRank(
    rank, b.rank, src.rank, src._ranking, src.rank_score,
  );
  const conv = num(conviction_score)
    ?? num(b.conviction_score)
    ?? num(src.__focus_conviction_score)
    ?? num(src.focus_conviction_score)
    ?? num(src.__conviction_score);
  const tierRaw = conviction_tier
    || b.conviction_tier
    || src.__focus_tier
    || src.focus_tier
    || src.__conviction_tier
    || null;
  const tier = tierRaw ? String(tierRaw).toUpperCase() : null;
  const rrN = num(rr) ?? num(b.rr) ?? num(src.rr);
  const suitability = num(p.suitability) ?? num(b.letf_suitability) ?? num(p.score);

  let lines = Array.isArray(signal_quality_lines) && signal_quality_lines.length > 0
    ? signal_quality_lines.map((line) => String(line))
    : [];
  if (!lines.length) {
    if (displayRank) lines.push(`Signal Strength (Rank): ${Math.round(displayRank)}/100`);
    if (conv > 0) lines.push(`Conviction: ${conv.toFixed(0)}${tier ? ` (${tier})` : ""}`);
    if (rrN > 0) lines.push(`Risk/Reward: ${rrN.toFixed(1)}:1`);
    if (suitability > 0) lines.push(`LETF Suitability: ${Math.round(suitability)}/100`);
  }

  return {
    rank: displayRank,
    rr: rrN > 0 ? rrN : null,
    conviction_score: conv > 0 ? conv : null,
    conviction_tier: tier,
    signal_quality_lines: lines.length ? lines : null,
    letf_suitability: suitability > 0 ? suitability : null,
  };
}

/** Fill blanks only — do not replace an entry stamp with a later tape read. */
export function mergeBookAlertScores(book, incoming = {}) {
  const prior = resolvePaperLaneAlertScores({ book });
  const next = resolvePaperLaneAlertScores({ ...incoming, book: null });
  const out = { ...(book && typeof book === "object" ? book : {}) };
  if (!prior.rank && next.rank) out.rank = next.rank;
  if (!prior.conviction_score && next.conviction_score) out.conviction_score = next.conviction_score;
  if (!prior.conviction_tier && next.conviction_tier) out.conviction_tier = next.conviction_tier;
  if (!prior.rr && next.rr) out.rr = next.rr;
  if (!prior.letf_suitability && next.letf_suitability) out.letf_suitability = next.letf_suitability;
  return out;
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
  rank,
  rr,
  conviction_score,
  conviction_tier,
  signal_quality_lines,
  tickerData = null,
  play = null,
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
  const scores = resolvePaperLaneAlertScores({
    rank, rr, conviction_score, conviction_tier, signal_quality_lines,
    tickerData, book, play,
  });

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
    rank: scores.rank,
    rr: scores.rr,
    conviction_score: scores.conviction_score,
    conviction_tier: scores.conviction_tier,
    signal_quality_lines: scores.signal_quality_lines,
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
  rank,
  rr,
  conviction_score,
  conviction_tier,
  signal_quality_lines,
  tickerData,
  play,
} = {}) {
  const KV = env?.KV_TIMED;
  let latest = tickerData;
  if (!latest && KV && ticker) {
    try {
      latest = await kvGetJSON(KV, `timed:latest:${String(ticker).toUpperCase()}`);
    } catch {
      latest = null;
    }
  }
  const emailAlert = buildPaperLaneEmailAlert({
    engine, event, ticker, vehicleTicker, direction, price, qty, reason,
    signal_id, ts, embed, book, management,
    rank, rr, conviction_score, conviction_tier, signal_quality_lines,
    tickerData: latest, play,
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
