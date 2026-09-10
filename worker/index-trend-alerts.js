// index-trend-alerts.js
//
// KV paper book + Discord for index trend LETF lane.

import { notifyDiscord } from "./alerts.js";
import {
  buildIndexTrendSignalEmbed,
  classifyIndexTrendPaperEvent,
  defaultIndexTrendPaperShares,
  indexTrendBookIsLive,
  isPrematureIndexTrendInvalidation,
  revivePrematureIndexTrendStop,
} from "./index-trend-paper.js";
import { paperEventToNotifType, wirePaperLaneNotify } from "./paper-lane-notify.js";

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

/** Qty written to the paper action tape. Closes use the flatten size, not remaining=0. */
export function indexTrendActionShares(decision, { nextBook, priorBook, fallbackShares } = {}) {
  const ev = String(decision?.event || "").toUpperCase();
  if (ev === "TRIM") return Math.max(0, Number(decision?.trim_sell_qty) || 0);
  if (ev === "STOP" || ev === "EXIT") {
    const stamped = Number(decision?.close_qty);
    if (Number.isFinite(stamped) && stamped > 0) return Math.round(stamped);
    const prior = Number(priorBook?.shares_remaining ?? priorBook?.shares);
    if (Number.isFinite(prior) && prior > 0) return Math.round(prior);
    return 0;
  }
  const live = Number(nextBook?.shares_remaining ?? nextBook?.shares ?? fallbackShares);
  return Number.isFinite(live) && live > 0 ? Math.round(live) : 0;
}

function parseJson(raw) {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

function bookIsLive(book) {
  return indexTrendBookIsLive(book);
}

async function loadMirrorSharesRemaining(env, signalId) {
  if (!env?.KV_TIMED || !signalId) return null;
  try {
    const raw = await env.KV_TIMED.get(`timed:idx-trend-mirror:${String(signalId).trim()}`);
    const row = raw ? JSON.parse(raw) : null;
    const rem = Number(row?.shares_remaining);
    return Number.isFinite(rem) && rem > 0 ? rem : null;
  } catch {
    return null;
  }
}

export async function writeIndexTrendBook(env, {
  bookKey,
  book,
  letfTicker,
  signalId,
  now = Date.now(),
} = {}) {
  return persistIndexTrendBook(env?.KV_TIMED, { bookKey, book, letfTicker, signalId, now });
}

export async function maybeReviveIndexTrendBook(env, {
  book,
  bookKey,
  letfTicker,
  signalId,
  atrPct = 0.012,
  sharesRemaining = null,
  now = Date.now(),
} = {}) {
  if (!isPrematureIndexTrendInvalidation(book, { atrPct })) return null;
  const rem = Number.isFinite(Number(sharesRemaining)) && Number(sharesRemaining) > 0
    ? Number(sharesRemaining)
    : await loadMirrorSharesRemaining(env, signalId);
  const revived = revivePrematureIndexTrendStop(book, { atrPct, sharesRemaining: rem, now });
  if (!revived) return null;
  const key = bookKey || (signalId ? indexTrendBookKey(signalId) : null);
  await persistIndexTrendBook(env?.KV_TIMED, {
    bookKey: key,
    book: revived,
    letfTicker,
    signalId,
    now,
  });
  return revived;
}

function asPendingCloseBook(decision, priorBook, now) {
  const ev = String(decision?.event || "").toUpperCase();
  if (ev !== "STOP" && ev !== "EXIT") return decision.nextBook;
  const closeQty = Math.max(0, Math.round(
    Number(decision.close_qty ?? priorBook?.shares_remaining ?? priorBook?.shares) || 0,
  ));
  return {
    ...decision.nextBook,
    status: "pending_close",
    pending_event: ev,
    event: ev,
    reason: decision.reason || decision.nextBook?.reason || null,
    needs_wait: false,
    pending_close_ts: now,
    shares_remaining: closeQty > 0 ? closeQty : (Number(decision.nextBook?.shares) || 0),
    broadcast_done: false,
  };
}

async function broadcastIndexTrendEvent(env, {
  payload,
  decision,
  book,
  persistSignalId,
  priorBook,
} = {}) {
  const embed = buildIndexTrendSignalEmbed({
    event: decision.event,
    underlying: payload.underlying || payload.ticker,
    letfTicker: payload.letf_ticker,
    direction: payload.direction,
    management: payload.management || book?.management || {},
    book: book || decision.nextBook || priorBook,
    letfPrice: payload.letf_price,
    underlyingPrice: payload.underlying_price,
    reason: decision.reason,
    now: payload.now || Date.now(),
  });

  const discord = await notifyDiscord(env, embed, "trade").catch((err) => ({
    ok: false,
    error: String(err?.message || err).slice(0, 160),
  }));

  await wirePaperLaneNotify(env, {
    engine: "index_trend_letf",
    event: decision.event,
    ticker: payload.underlying || payload.ticker,
    vehicleTicker: payload.letf_ticker,
    direction: payload.direction,
    price: payload.letf_price,
    qty: book?.shares_remaining ?? book?.shares,
    reason: decision.reason,
    signal_id: persistSignalId,
    ts: payload.now || Date.now(),
    embed,
    book: book || priorBook,
    management: payload.management || book?.management || priorBook?.management,
  }).catch(() => {});

  return { embed, discord };
}

/** Persist closed + Discord after /bridge/order actually placed (or is already flat). */
export async function finalizeIndexTrendPaperClose(env, payload = {}) {
  const KV = env?.KV_TIMED;
  const signalId = String(payload.signal_id || "").trim();
  if (!KV || !signalId) return { skipped: true, reason: !KV ? "no_kv" : "no_signal" };
  const loaded = payload.loadedBook && typeof payload.loadedBook === "object"
    ? payload.loadedBook
    : await loadIndexTrendBook(env, { signal_id: signalId, letf_ticker: payload.letf_ticker });
  const pending = payload.book || loaded.book;
  if (!pending) return { skipped: true, reason: "no_book" };
  const ev = String(payload.event || pending.pending_event || pending.event || "STOP").toUpperCase();
  const now = payload.now || Date.now();
  const closeQty = Math.max(0, Math.round(
    Number(payload.close_qty ?? pending.shares_remaining ?? pending.shares) || 0,
  ));
  const closedBook = {
    ...pending,
    status: "closed",
    event: ev,
    reason: payload.reason || pending.reason || null,
    needs_wait: true,
    exit_ts: now,
    exit_letf_price: Number(payload.letf_price) || pending.exit_letf_price || pending.last_letf_price || null,
    exit_underlying_price: Number(payload.underlying_price) || pending.exit_underlying_price || pending.last_underlying_price || null,
    shares_remaining: 0,
    pending_event: null,
    broadcast_done: true,
  };
  const bookKey = loaded.bookKey || indexTrendBookKey(signalId);
  await persistIndexTrendBook(KV, {
    bookKey,
    book: closedBook,
    letfTicker: payload.letf_ticker,
    signalId: loaded.signal_id || signalId,
    now,
  });
  if (pending.broadcast_done) {
    return { ok: true, event: ev, book: closedBook, already_broadcast: true };
  }
  const decision = { event: ev, reason: closedBook.reason, close_qty: closeQty };
  const broadcast = await broadcastIndexTrendEvent(env, {
    payload: { ...payload, now },
    decision,
    book: { ...closedBook, shares: pending.shares || closeQty, shares_remaining: 0 },
    persistSignalId: loaded.signal_id || signalId,
    priorBook: pending,
  });
  return { ok: true, event: ev, book: closedBook, ...broadcast };
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
  const bookKey = loaded.bookKey || indexTrendBookKey(signalId);
  const persistSignalId = loaded.signal_id || signalId;
  const now = payload.now || Date.now();

  let book = loaded.book;
  if (isPrematureIndexTrendInvalidation(book, { atrPct: payload.atrPct })) {
    const revived = await maybeReviveIndexTrendBook(env, {
      book,
      bookKey,
      letfTicker: payload.letf_ticker,
      signalId: persistSignalId,
      atrPct: payload.atrPct,
      now,
    });
    if (revived) book = revived;
  }

  const decision = classifyIndexTrendPaperEvent({
    book,
    letfPrice: payload.letf_price,
    underlyingPrice: payload.underlying_price,
    management: payload.management || book?.management || {},
    direction: payload.direction,
    activate: payload.activate !== false,
    now,
    shares: payload.shares,
  });

  const ev = String(decision.event || "").toUpperCase();
  const isClose = ev === "STOP" || ev === "EXIT";
  const alreadyPending = !!decision.pending_close || String(book?.status || "") === "pending_close";

  if (decision.nextBook) {
    const mgmtSnap = payload.management && typeof payload.management === "object"
      ? { ...payload.management }
      : decision.nextBook.management || null;
    let stampedBook = {
      ...decision.nextBook,
      letf_ticker: String(payload.letf_ticker || decision.nextBook.letf_ticker || "").toUpperCase() || null,
      underlying: String(payload.underlying || payload.ticker || decision.nextBook.underlying || "").toUpperCase() || null,
      management: mgmtSnap,
    };
    if (isClose && !alreadyPending) {
      stampedBook = asPendingCloseBook({ ...decision, nextBook: stampedBook }, book, now);
    }
    await persistIndexTrendBook(KV, {
      bookKey,
      book: stampedBook,
      letfTicker: payload.letf_ticker,
      signalId: persistSignalId,
      now,
    });
    decision.nextBook = stampedBook;
  }
  if (!decision.event) {
    return {
      ok: true,
      event: null,
      book: decision.nextBook || book,
      fromCarry: !!loaded.fromCarry,
      revived: book?.revived_from_stop === true && book !== loaded.book,
    };
  }

  const nextBook = decision.nextBook || book;

  // STOP/EXIT: persist pending_close + action tape, then the caller mirrors.
  // Discord waits until finalizeIndexTrendPaperClose after /bridge/order.
  // Isolate death after this persist still retries — book stays live.
  if (isClose) {
    if (!alreadyPending) {
      await recordIndexTrendAction(env, {
        ts: now,
        event: ev,
        underlying: payload.underlying || payload.ticker,
        letf_ticker: payload.letf_ticker,
        signal_id: persistSignalId,
        shares: indexTrendActionShares(decision, {
          nextBook,
          priorBook: book,
          fallbackShares: payload.shares ?? defaultIndexTrendPaperShares(payload.letf_price),
        }),
        letf_price: payload.letf_price,
        reason: decision.reason || null,
      }).catch(() => {});
    }
    return {
      ok: true,
      event: ev,
      reason: decision.reason || null,
      pending_close: true,
      close_qty: decision.close_qty || nextBook?.shares_remaining || null,
      book: nextBook,
      fromCarry: !!loaded.fromCarry,
      notif_type: paperEventToNotifType(ev),
    };
  }

  const broadcast = await broadcastIndexTrendEvent(env, {
    payload: { ...payload, now },
    decision,
    book: nextBook,
    persistSignalId,
    priorBook: book,
  });

  await recordIndexTrendAction(env, {
    ts: now,
    event: ev,
    underlying: payload.underlying || payload.ticker,
    letf_ticker: payload.letf_ticker,
    signal_id: persistSignalId,
    shares: indexTrendActionShares(decision, {
      nextBook,
      priorBook: book,
      fallbackShares: payload.shares ?? defaultIndexTrendPaperShares(payload.letf_price),
    }),
    letf_price: payload.letf_price,
    reason: decision.reason || null,
  }).catch(() => {});

  return {
    ok: !!broadcast.discord?.ok,
    event: ev,
    reason: decision.reason || null,
    trim_sell_qty: decision.trim_sell_qty || null,
    dca_add_qty: decision.dca_add_qty || null,
    embed: broadcast.embed,
    discord: broadcast.discord,
    book: nextBook,
    notif_type: paperEventToNotifType(ev),
  };
}
