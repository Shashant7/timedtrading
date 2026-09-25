// option-day-trade-alerts.js
//
// Paper BUY / TRIM / EXIT / STOP → Discord #trade-signals.
// KV book is the position; the clock is the tape. Only the Today
// default profile (speculator) notifies so the */5 pre-warm of
// moderate/aggressive does not triple-post.

import { notifyDiscord } from "./alerts.js";
import { wirePaperLaneNotify } from "./paper-lane-notify.js";
import {
  buildSatyDayTradePlan,
  sizeDayTradePlay,
  classifyPaperEvent,
  buildDayTradeSignalEmbed,
  isOvernightCarry,
} from "./option-day-trade-plan.js";
import { dayTradeStopStreakKey, dayTradeSessionRoundsKey, dayTradeSideFromFlavor, normalizeDayLean, LANE_MINDS } from "./lane-minds.js";
import { publishIndexDtIntent } from "./mirror-intent-stream.js";

const BOOK_TTL = 3 * 86400;
const DEFAULT_PROFILE = "speculator";
const DT_ACTIONS_KEY = "timed:opt-dt-actions";
// Busy index-DT sessions write ~3 events/round (BUY/TRIM/EXIT). 16 rounds
// is ~48 events; keep several sessions so Portfolio history does not drop
// the morning rounds when the afternoon fills the ring.
const DT_ACTIONS_MAX = 500;

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

/**
 * When the last day-trade round on an underlying closed, whatever its strike
 * or side. The re-entry cooldown is per UNDERLYING: a re-entry is usually a
 * different contract (QQQ 742C stopped, 731P bought a minute later), so a
 * per-book stamp would never see it.
 */
export function dayTradeLastCloseKey(ticker) {
  return `timed:opt-dt:last-close:${String(ticker || "").toUpperCase()}`;
}

/**
 * Read the last underlying close stamp. Legacy values were a bare epoch ms
 * string; current values are JSON `{ts, reason, side, green, lean}`.
 */
export async function readLastUnderlyingCloseMeta(KV, ticker) {
  try {
    const raw = await KV.get(dayTradeLastCloseKey(ticker));
    if (raw == null || raw === "") return null;
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 1e12 && String(asNum) === String(raw).trim()) {
      return { ts: asNum };
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const ts = Number(parsed.ts);
        if (Number.isFinite(ts) && ts > 0) return { ...parsed, ts };
      }
    } catch (_) { /* fall through */ }
    if (Number.isFinite(asNum) && asNum > 0) return { ts: asNum };
    return null;
  } catch (_) { return null; }
}

async function readLastUnderlyingClose(KV, ticker) {
  const meta = await readLastUnderlyingCloseMeta(KV, ticker);
  return meta?.ts > 0 ? meta.ts : null;
}

async function readSessionRounds(KV, ticker, now = Date.now()) {
  try {
    const raw = await KV.get(dayTradeSessionRoundsKey(ticker, now));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

async function recordSessionRound(KV, ticker, { side, lean, ts } = {}, now = Date.now()) {
  const resolved = dayTradeSideFromFlavor(side);
  if (!KV || !ticker || !resolved) return;
  const key = dayTradeSessionRoundsKey(ticker, now);
  try {
    const rounds = await readSessionRounds(KV, ticker, now);
    rounds.push({
      side: resolved,
      lean: normalizeDayLean(lean) || null,
      ts: Number(ts) || now,
    });
    await KV.put(key, JSON.stringify(rounds), { expirationTtl: 86400 });
  } catch (_) { /* protective only */ }
}

async function readSessionStopStreak(KV, ticker, now = Date.now()) {
  try {
    const n = Number(await KV.get(dayTradeStopStreakKey(ticker, now)));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) { return 0; }
}

async function bumpSessionStopStreak(KV, ticker, event, now = Date.now()) {
  const ev = String(event || "").toUpperCase();
  if (ev !== "STOP" && ev !== "EXIT") return;
  const key = dayTradeStopStreakKey(ticker, now);
  try {
    if (ev === "STOP") {
      const n = (await readSessionStopStreak(KV, ticker, now)) + 1;
      await KV.put(key, String(n), { expirationTtl: 86400 });
      return n;
    }
    // A clean EXIT (thesis / target) is not a whipsaw — reset the streak so
    // a later setup the same day is allowed.
    await KV.put(key, "0", { expirationTtl: 86400 });
  } catch (_) { /* streak is protective only */ }
  return null;
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

  const lastClose = await readLastUnderlyingCloseMeta(KV, payload.ticker);
  const sessionRounds = await readSessionRounds(KV, payload.ticker, payload.now || Date.now());
  const decision = classifyPaperEvent({
    clock: payload.execution,
    book,
    premium: payload.premium ?? payload.execution?.premium_band?.premium,
    now: payload.now || Date.now(),
    size,
    lastUnderlyingCloseTs: lastClose?.ts || null,
    lastClose,
    sessionRounds,
    sessionMind: LANE_MINDS.day_trade,
    sessionStopCount: await readSessionStopStreak(KV, payload.ticker, payload.now || Date.now()),
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
    return {
      ok: true, event: null, plan, size, book: decision.nextBook || book, fromCarry: !!loaded.fromCarry,
      ...(decision.blocked ? { blocked: decision.blocked } : {}),
    };
  }
  if (decision.event === "BUY" && payload.ticker) {
    await recordSessionRound(KV, payload.ticker, {
      side: decision.nextBook?.flavor || payload.execution?.contract?.flavor,
      lean: decision.nextBook?.entry_thesis?.lean
        || payload.execution?.thesis?.lean
        || payload.execution?.thesis?.day_lean,
      ts: payload.now || Date.now(),
    }, payload.now || Date.now());
  }
  if ((decision.event === "STOP" || decision.event === "EXIT") && payload.ticker) {
    try {
      const entryPx = Number(book?.entry_premium ?? decision.nextBook?.entry_premium);
      const exitPx = Number(
        decision.nextBook?.exit_premium
        ?? payload.premium
        ?? payload.execution?.premium_band?.premium,
      );
      const green = Number.isFinite(entryPx) && Number.isFinite(exitPx) && exitPx > entryPx;
      await KV.put(dayTradeLastCloseKey(payload.ticker), JSON.stringify({
        ts: payload.now || Date.now(),
        reason: decision.reason || null,
        side: dayTradeSideFromFlavor(book?.flavor || decision.nextBook?.flavor),
        green,
        lean: normalizeDayLean(book?.entry_thesis?.lean) || null,
      }), { expirationTtl: 86400 });
    } catch (_) { /* a missing stamp only loses one cooldown, never an order */ }
    await bumpSessionStopStreak(KV, payload.ticker, decision.event, payload.now || Date.now());
  }

  // 2026-09-23 — the broker goes first, ahead of Discord.
  //
  // The mirror used to hang off this function's `.then()`, which meant a
  // live order waited on a Discord webhook round-trip and, worse, was never
  // dispatched at all if anything between here and the return rejected. On a
  // 0/1 DTE contract the notification is the cheap half; the order is the
  // half that expires.
  //
  // The book is already persisted above, so a crash here cannot leave a
  // broker position with no paper state behind it. Order is: persist, place,
  // then tell everyone.
  // The model's intent goes on record before any order does, so every
  // account's follow-through can be checked against it later. A D1 failure
  // costs the record, never the order.
  const legBook = decision.nextBook || book;
  let leg = null;
  if (env?.DB) {
    try {
      const { recordModelLeg } = await import("./mirror-kernel.js");
      leg = await recordModelLeg(env.DB, {
        lane: "index_dt",
        signalId: persistSignalId,
        entryTs: legBook?.entry_ts,
        ticker: payload.ticker,
        event: decision.event,
        openedQty: legBook?.contracts,
        remainingAfter: legBook?.contracts_remaining ?? legBook?.contracts,
        paperPrice: payload.premium ?? payload.execution?.premium_band?.premium,
        now: payload.now || Date.now(),
      });
    } catch (e) {
      console.warn("[MIRROR KERNEL] model leg not recorded:", String(e?.message || e).slice(0, 160));
    }
  }

  // Constant stream: every model leg publishes the remaining the brokers
  // must converge to. close_owed rows are drained by the minute reconciler.
  try {
    const remaining = (decision.event === "EXIT" || decision.event === "STOP")
      ? 0
      : Math.max(0, Math.round(Number(legBook?.contracts_remaining ?? legBook?.contracts) || 0));
    await publishIndexDtIntent(env, {
      signalId: persistSignalId,
      ticker: payload.ticker,
      event: decision.event,
      remainingQty: remaining,
      entryTs: legBook?.entry_ts,
      now: payload.now || Date.now(),
    });
  } catch (_) { /* stream must never block the order path */ }

  if (typeof payload.onEvent === "function") {
    try {
      await payload.onEvent({
        event: decision.event,
        reason: decision.reason || null,
        book: legBook,
        signal_id: persistSignalId,
        position_id: leg?.position_id || null,
        leg_seq: leg?.seq ?? null,
      });
    } catch (_) { /* a broken listener must not stop the notification */ }
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
    book: book,
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

  const flavor = payload.execution?.contract?.flavor || payload.flavor || "call";
  const strike = payload.execution?.contract?.strike ?? payload.strike;
  const vehicleLabel = strike
    ? `${String(payload.ticker || "").toUpperCase()} ${Math.round(Number(strike))}${flavor === "put" ? "P" : "C"}`
    : String(payload.ticker || "").toUpperCase();

  await wirePaperLaneNotify(env, {
    engine: "options_day_trade",
    event: decision.event,
    ticker: payload.ticker,
    vehicleTicker: vehicleLabel,
    direction: flavor === "put" ? "SHORT" : "LONG",
    price: payload.premium ?? payload.execution?.premium_band?.premium,
    qty: nextBook?.contracts_remaining ?? nextBook?.contracts ?? size?.contracts,
    reason: decision.reason,
    signal_id: persistSignalId,
    ts: payload.now || Date.now(),
    embed,
    book: nextBook || book,
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
