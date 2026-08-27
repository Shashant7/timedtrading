// index-trend-alerts.js
//
// KV paper book + Discord for index trend LETF lane.

import { notifyDiscord } from "./alerts.js";
import {
  buildIndexTrendSignalEmbed,
  classifyIndexTrendPaperEvent,
  defaultIndexTrendPaperShares,
} from "./index-trend-paper.js";

const BOOK_TTL = 21 * 86400;
const DEFAULT_PROFILE = "speculator";
const IT_ACTIONS_KEY = "timed:idx-trend-actions";
const IT_ACTIONS_MAX = 80;

export function indexTrendBookKey(signalId) {
  return `timed:idx-trend-book:${String(signalId || "").trim()}`;
}

export function indexTrendCarryKey(letfTicker) {
  return `timed:idx-trend-carry:${String(letfTicker || "").toUpperCase()}`;
}

function parseJson(raw) {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

function bookIsLive(book) {
  const status = String(book?.status || "");
  return status === "open" || status === "trimmed";
}

export async function recordIndexTrendAction(env, row) {
  const KV = env?.KV_TIMED;
  if (!KV || !row?.event || !row?.signal_id) return;
  try {
    const raw = await KV.get(IT_ACTIONS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift({
      ts: Number(row.ts) || Date.now(),
      event: String(row.event).toUpperCase(),
      underlying: String(row.underlying || "").toUpperCase(),
      letf_ticker: String(row.letf_ticker || "").toUpperCase(),
      signal_id: String(row.signal_id),
      shares: Number(row.shares) || 0,
      letf_price: Number(row.letf_price) || 0,
      reason: row.reason || null,
    });
    if (list.length > IT_ACTIONS_MAX) list.length = IT_ACTIONS_MAX;
    await KV.put(IT_ACTIONS_KEY, JSON.stringify(list), { expirationTtl: 30 * 86400 });
  } catch (_) { /* best-effort */ }
}

export async function readIndexTrendActions(env, sinceMs = 0) {
  const KV = env?.KV_TIMED;
  if (!KV) return [];
  try {
    const list = JSON.parse((await KV.get(IT_ACTIONS_KEY)) || "[]");
    return (Array.isArray(list) ? list : []).filter((a) => Number(a?.ts) >= sinceMs);
  } catch (_) {
    return [];
  }
}

export async function loadIndexTrendBook(env, { signal_id, letf_ticker } = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return { book: null, bookKey: null, fromCarry: false, carryKey: null };
  const bookKey = signal_id ? indexTrendBookKey(signal_id) : null;
  const carryKey = letf_ticker ? indexTrendCarryKey(letf_ticker) : null;
  let book = null;
  if (bookKey) {
    try { book = parseJson(await KV.get(bookKey)); } catch { book = null; }
  }
  if (bookIsLive(book)) {
    return { book, bookKey, fromCarry: false, carryKey };
  }
  if (!carryKey) return { book, bookKey, fromCarry: false, carryKey };
  let carry = null;
  try { carry = parseJson(await KV.get(carryKey)); } catch { carry = null; }
  if (bookIsLive(carry?.book)) {
    return {
      book: carry.book,
      bookKey: carry.book_key || (carry.signal_id ? indexTrendBookKey(carry.signal_id) : bookKey),
      fromCarry: true,
      carryKey,
      signal_id: carry.signal_id || signal_id || null,
    };
  }
  return { book, bookKey, fromCarry: false, carryKey };
}

async function persistIndexTrendBook(KV, {
  bookKey,
  book,
  letfTicker,
  signalId,
  now = Date.now(),
} = {}) {
  if (!KV || !bookKey || !book) return;
  await KV.put(bookKey, JSON.stringify(book), { expirationTtl: BOOK_TTL }).catch(() => {});
  const carryKey = letfTicker ? indexTrendCarryKey(letfTicker) : null;
  if (!carryKey) return;
  const live = bookIsLive(book);
  if (live) {
    await KV.put(carryKey, JSON.stringify({
      signal_id: signalId || null,
      book_key: bookKey,
      book,
      ts: now,
    }), { expirationTtl: BOOK_TTL }).catch(() => {});
    return;
  }
  if (typeof KV.delete === "function") {
    await KV.delete(carryKey).catch(() => {});
  } else {
    await KV.put(carryKey, JSON.stringify({ book: { status: "flat" }, ts: now }), { expirationTtl: 3600 }).catch(() => {});
  }
}

export async function maybeNotifyIndexTrendPaperEvent(env, payload = {}) {
  const profile = String(payload.profile || DEFAULT_PROFILE).toLowerCase();
  if (profile && profile !== DEFAULT_PROFILE) {
    return { skipped: true, reason: "non_default_profile" };
  }
  const KV = env?.KV_TIMED;
  const signalId = String(payload.signal_id || "").trim();
  if (!KV || !signalId) return { skipped: true, reason: !KV ? "no_kv" : "no_signal" };

  const loaded = payload.loadedBook && typeof payload.loadedBook === "object"
    ? payload.loadedBook
    : await loadIndexTrendBook(env, {
      signal_id: signalId,
      letf_ticker: payload.letf_ticker,
    });
  const book = loaded.book;
  const bookKey = loaded.bookKey || indexTrendBookKey(signalId);
  const persistSignalId = loaded.signal_id || signalId;

  const decision = classifyIndexTrendPaperEvent({
    book,
    letfPrice: payload.letf_price,
    underlyingPrice: payload.underlying_price,
    management: payload.management,
    direction: payload.direction,
    activate: payload.activate !== false,
    now: payload.now || Date.now(),
    shares: payload.shares,
  });

  if (decision.nextBook) {
    await persistIndexTrendBook(KV, {
      bookKey,
      book: decision.nextBook,
      letfTicker: payload.letf_ticker,
      signalId: persistSignalId,
      now: payload.now || Date.now(),
    });
  }
  if (!decision.event) {
    return {
      ok: true,
      event: null,
      book: decision.nextBook || book,
      fromCarry: !!loaded.fromCarry,
    };
  }

  const embed = buildIndexTrendSignalEmbed({
    event: decision.event,
    underlying: payload.underlying || payload.ticker,
    letfTicker: payload.letf_ticker,
    direction: payload.direction,
    management: payload.management,
    book: book || decision.nextBook,
    letfPrice: payload.letf_price,
    underlyingPrice: payload.underlying_price,
    reason: decision.reason,
    now: payload.now || Date.now(),
  });

  const discord = await notifyDiscord(env, embed, "trade").catch((err) => ({
    ok: false,
    error: String(err?.message || err).slice(0, 160),
  }));

  const nextBook = decision.nextBook || book;
  await recordIndexTrendAction(env, {
    ts: payload.now || Date.now(),
    event: decision.event,
    underlying: payload.underlying || payload.ticker,
    letf_ticker: payload.letf_ticker,
    signal_id: persistSignalId,
    shares: nextBook?.shares_remaining ?? nextBook?.shares ?? payload.shares ?? defaultIndexTrendPaperShares(payload.letf_price),
    letf_price: payload.letf_price,
    reason: decision.reason || null,
  }).catch(() => {});

  return {
    ok: !!discord?.ok,
    event: decision.event,
    reason: decision.reason || null,
    trim_sell_qty: decision.trim_sell_qty || null,
    dca_add_qty: decision.dca_add_qty || null,
    embed,
    discord,
    book: nextBook,
  };
}
