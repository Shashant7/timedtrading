// option-day-trade-alerts.js
//
// Paper BUY / TRIM / EXIT / STOP → Discord #trade-signals.
// KV book is the position; the clock is the tape. Only the Today
// default profile (speculator) notifies so the */5 pre-warm of
// moderate/aggressive does not triple-post.

import { notifyDiscord } from "./alerts.js";
import {
  buildSatyDayTradePlan,
  sizeDayTradePlay,
  classifyPaperEvent,
  buildDayTradeSignalEmbed,
  isOvernightCarry,
} from "./option-day-trade-plan.js";

const BOOK_TTL = 3 * 86400;
const DEFAULT_PROFILE = "speculator";
const DT_ACTIONS_KEY = "timed:opt-dt-actions";
const DT_ACTIONS_MAX = 80;

export async function recordDayTradeAction(env, row) {
  const KV = env?.KV_TIMED;
  if (!KV || !row?.event || !row?.signal_id) return;
  try {
    const raw = await KV.get(DT_ACTIONS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift({
      ts: Number(row.ts) || Date.now(),
      event: String(row.event).toUpperCase(),
      ticker: String(row.ticker || "").toUpperCase(),
      signal_id: String(row.signal_id),
      contracts: Number(row.contracts) || 1,
      premium: Number(row.premium) || 0,
      reason: row.reason || null,
    });
    if (list.length > DT_ACTIONS_MAX) list.length = DT_ACTIONS_MAX;
    await KV.put(DT_ACTIONS_KEY, JSON.stringify(list), { expirationTtl: 7 * 86400 });
  } catch (_) { /* best-effort — timeline join must never block Discord */ }
}

export async function readDayTradeActions(env, sinceMs = 0) {
  const KV = env?.KV_TIMED;
  if (!KV) return [];
  try {
    const list = JSON.parse((await KV.get(DT_ACTIONS_KEY)) || "[]");
    return (Array.isArray(list) ? list : []).filter((a) => Number(a?.ts) >= sinceMs);
  } catch (_) {
    return [];
  }
}

export function dayTradeBookKey(signalId) {
  return `timed:opt-dt-book:${String(signalId || "").trim()}`;
}

export function dayTradeCarryKey(ticker) {
  return `timed:opt-dt-carry:${String(ticker || "").toUpperCase()}`;
}

function parseJson(raw) {
  if (!raw) return null;
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
}

function bookIsLive(book) {
  const status = String(book?.status || "");
  return status === "open" || status === "trimmed";
}

/**
 * Load the paper book for this signal, then fall back to the ticker
 * overnight-carry pointer. Signal ids include the NY date, so a
 * Thursday book is invisible to Friday's id without the carry key.
 */
export async function loadDayTradeBook(env, { signal_id, ticker } = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return { book: null, bookKey: null, fromCarry: false, carryKey: null };
  const bookKey = signal_id ? dayTradeBookKey(signal_id) : null;
  const carryKey = ticker ? dayTradeCarryKey(ticker) : null;
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
      bookKey: carry.book_key || (carry.signal_id ? dayTradeBookKey(carry.signal_id) : bookKey),
      fromCarry: true,
      carryKey,
      signal_id: carry.signal_id || signal_id || null,
    };
  }
  return { book, bookKey, fromCarry: false, carryKey };
}

async function persistDayTradeBook(KV, {
  bookKey,
  book,
  ticker,
  signalId,
  now = Date.now(),
} = {}) {
  if (!KV || !bookKey || !book) return;
  await KV.put(bookKey, JSON.stringify(book), { expirationTtl: BOOK_TTL }).catch(() => {});
  const carryKey = ticker ? dayTradeCarryKey(ticker) : null;
  if (!carryKey) return;
  // Pin carry for ANY live book (open/trimmed), not only overnight — so a
  // later */5 tick with a re-snapped strike cannot open a second paper leg
  // on the same ticker (710C then 711C six minutes later).
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

function stWithPlay(execution, flavor) {
  const dir = Number(execution?.indicators?.st_dir);
  if (!Number.isFinite(dir)) return false;
  const isPut = String(flavor || "").toLowerCase() === "put";
  return isPut ? dir > 0 : dir < 0;
}

export function assembleDayTradePlan(payload = {}) {
  const exec = payload.execution || {};
  const gp = payload.gamePlan || payload.game_plan || {};
  const flavor = payload.flavor || exec.contract?.flavor;
  const size = sizeDayTradePlay({
    leanConviction: gp.lean_conviction || payload.day_lean_conviction,
    premiumBand: exec.premium_band?.band,
    stWith: stWithPlay(exec, flavor),
    honestyVeto: !!payload.honesty_gate_veto,
    premium: payload.premium ?? exec.premium_band?.premium,
  });
  const plan = buildSatyDayTradePlan({
    ticker: payload.ticker,
    flavor,
    strike: payload.strike ?? exec.contract?.strike,
    expiration: payload.expiration || exec.contract?.expiration,
    spot: payload.spot,
    premium: payload.premium,
    execution: exec,
    gamePlan: gp,
    management: payload.management,
    size,
    now: payload.now,
  });
  return { plan, size };
}

export async function maybeNotifyDayTradePaperEvent(env, payload = {}) {
  const profile = String(payload.profile || DEFAULT_PROFILE).toLowerCase();
  if (profile && profile !== DEFAULT_PROFILE) {
    return { skipped: true, reason: "non_default_profile" };
  }
  const KV = env?.KV_TIMED;
  const signalId = String(payload.signal_id || "").trim();
  if (!KV || !signalId) return { skipped: true, reason: !KV ? "no_kv" : "no_signal" };
  if (!payload.execution) return { skipped: true, reason: "no_clock" };

  const { plan, size } = assembleDayTradePlan(payload);
  const loaded = payload.loadedBook && typeof payload.loadedBook === "object"
    ? payload.loadedBook
    : await loadDayTradeBook(env, { signal_id: signalId, ticker: payload.ticker });
  const book = loaded.book;
  const bookKey = loaded.bookKey || dayTradeBookKey(signalId);
  const persistSignalId = loaded.signal_id || signalId;

  const decision = classifyPaperEvent({
    clock: payload.execution,
    book,
    premium: payload.premium ?? payload.execution?.premium_band?.premium,
    now: payload.now || Date.now(),
    size,
  });

  if (decision.nextBook) {
    await persistDayTradeBook(KV, {
      bookKey,
      book: decision.nextBook,
      ticker: payload.ticker,
      signalId: persistSignalId,
      now: payload.now || Date.now(),
    });
  }
  if (!decision.event) {
    return { ok: true, event: null, plan, size, book: decision.nextBook || book, fromCarry: !!loaded.fromCarry };
  }

  const embed = buildDayTradeSignalEmbed({
    event: decision.event,
    ticker: payload.ticker,
    plan,
    size,
    execution: payload.execution,
    premium: payload.premium,
    spot: payload.spot,
    reason: decision.reason,
    now: payload.now || Date.now(),
  });

  const discord = await notifyDiscord(env, embed, "trade").catch((err) => ({
    ok: false,
    error: String(err?.message || err).slice(0, 160),
  }));

  const nextBook = decision.nextBook || book;
  await recordDayTradeAction(env, {
    ts: payload.now || Date.now(),
    event: decision.event,
    ticker: payload.ticker,
    signal_id: persistSignalId,
    contracts: nextBook?.contracts_remaining ?? nextBook?.contracts ?? size?.contracts ?? 1,
    premium: payload.premium ?? payload.execution?.premium_band?.premium,
    reason: decision.reason || null,
  }).catch(() => {});

  return {
    ok: !!discord?.ok,
    event: decision.event,
    reason: decision.reason || null,
    plan,
    size,
    embed,
    discord,
    book: nextBook,
  };
}
