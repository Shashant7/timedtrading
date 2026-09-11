// index-trend-auto-mirror.js
//
// Broker mirror for index trend LETF share plays via /bridge/order.

import { forwardOrderToBridge, parseBridgeOrderIds } from "./broker-bridge-client.js";
import {
  loadAutoMirrorPrefs,
  checkAndBumpDailyCounter,
  checkAndBumpVehicleCounter,
  releaseDailyCounter,
  releaseVehicleCounter,
} from "./options-auto-mirror.js";
import { defaultIndexTrendPaperShares, indexTrendBookIsLive, isPrematureIndexTrendInvalidation } from "./index-trend-paper.js";
import { isNyRegularMarketOpenStatic } from "./market-calendar.js";
import {
  readIndexTrendActions,
  loadIndexTrendBook,
  maybeReviveIndexTrendBook,
} from "./index-trend-alerts.js";

const VEHICLE_KEY = "index_trend_letf";
const MIRROR_TTL = 21 * 86400;
export const INDEX_TREND_MIRROR_LOG_KEY = "timed:idx-trend-mirror-log";
const MIRROR_LOG_KEY = INDEX_TREND_MIRROR_LOG_KEY;
const MIRROR_LOG_MAX = 120;

export const INDEX_TREND_REJECT_COOLDOWN_MS = 15 * 60 * 1000;
/** Same-tick follow-through only. Older rejected leftovers stay unbought. */
export const INDEX_TREND_SAME_TICK_ENTRY_MS = 15 * 60 * 1000;
/** Never-attempted open books (email wrote, /bridge/order did not). Covers the weekend so Friday W37 can still catch up Monday RTH. Week-old leftovers stay excluded. */
export const INDEX_TREND_NEVER_ATTEMPTED_ENTRY_MS = 4 * 86400 * 1000;
export const INDEX_TREND_CARRY_LETFS = Object.freeze([
  "SPYU", "SPXU", "TQQQ", "SQQQ", "TNA", "TZA", "UDOW", "SDOW",
]);
const HEAL_LOCK_KEY = "timed:idx-trend-heal-lock";
const HEAL_LOCK_MS = 45 * 1000;
const EXIT_CATCHUP_LOOKBACK_MS = 14 * 86400 * 1000;
const TERMINAL_EXIT_REJECT = /no_broker_position|already_flat|nothing_to_sell|position_flat|position_zero|qty_zero/i;

/** Bridge place that actually filled or claimed (not a false-ok 200). */
export function indexTrendFiredLooksPlaced(fired) {
  if (!fired || fired.ok !== true || fired.skip) return false;
  if (fired.deduped === true || fired.response?.deduped === true) return true;
  const parsed = fired.response && typeof fired.response === "object"
    ? fired.response
    : fired;
  return !!parseBridgeOrderIds(parsed).order_id;
}

/**
 * Same extraction the client ring uses. Fan-out hides reject_reason on
 * the child, so `fired.response.reject_reason` alone stamped
 * "bridge_reject" and the EXIT healer looped (TNA W36 2026-09-11).
 */
export function extractIndexTrendRejectReason(fired) {
  if (!fired) return "bridge_reject";
  if (fired.skip) return String(fired.skip).slice(0, 200);
  const parsed = fired.response && typeof fired.response === "object"
    ? fired.response
    : fired;
  const childReject = Array.isArray(parsed?.results)
    ? parsed.results.map((row) => (
      row?.result?.reject_reason || row?.result?.error || row?.result?.message || null
    )).find(Boolean)
    : null;
  const reason = parsed?.reject_reason
    || parsed?.error
    || parsed?.message
    || childReject
    || fired.error
    || null;
  if (reason) return String(reason).slice(0, 200);
  if (fired.ok === true && !indexTrendFiredLooksPlaced(fired)) {
    return "false_ok_no_order_id";
  }
  return "bridge_reject";
}

export function isTerminalIndexTrendExitReject(reason) {
  return TERMINAL_EXIT_REJECT.test(String(reason || ""));
}

export function indexTrendMirrorLooksAttempted(mirror) {
  if (!mirror || typeof mirror !== "object") return false;
  if (mirror.entry_fired) return true;
  if (mirror.entry_order_id) return true;
  return !!String(mirror.last_reject || "").trim();
}

export async function indexTrendNeedsEntryCatchUp(env, signalId, now = Date.now()) {
  const existing = await loadMirror(env, signalId);
  if (existing?.entry_fired) return false;
  const rejectTs = Number(existing?.last_reject_ts) || 0;
  if (rejectTs && (Number(now) || Date.now()) - rejectTs < INDEX_TREND_REJECT_COOLDOWN_MS) {
    return false;
  }
  return true;
}

/**
 * Same-tick age gate stays (UDOW/TQQQ/TJX leftover rule). A never-
 * attempted BUY for a still-open book (age < 4d) may catch up
 * during RTH — TNA W37 emailed at 12:00 ET and never hit /bridge/order.
 */
export async function indexTrendShouldCatchUpOpenEntry(env, { signalId, book, now = Date.now() } = {}) {
  if (!signalId) return false;
  const status = String(book?.status || "");
  if (status !== "open" && status !== "trimmed") return false;
  if (!(await indexTrendNeedsEntryCatchUp(env, signalId, now))) return false;
  const age = (Number(now) || Date.now()) - (Number(book?.entry_ts) || 0);
  if (age >= 0 && age < INDEX_TREND_SAME_TICK_ENTRY_MS) return true;
  const existing = await loadMirror(env, signalId);
  if (indexTrendMirrorLooksAttempted(existing)) return false;
  if (!isNyRegularMarketOpenStatic(new Date(Number(now) || Date.now()))) return false;
  // Same session, or the next RTH morning after a Friday miss.
  // Not a backfill of week-old leftover books.
  return age >= 0 && age < INDEX_TREND_NEVER_ATTEMPTED_ENTRY_MS;
}

/**
 * Paper STOP/EXIT can persist + Discord, then the isolate dies before
 * /bridge/order (TQQQ 2026-09-10, UDOW W36 after 19:00 ET). The live
 * options/all loop then sees a closed book and never re-fires.
 * True when the broker sleeve is still open.
 */
export function indexTrendMirrorNeedsExitCatchUp(mirror, now = Date.now()) {
  if (!mirror?.entry_fired || mirror.exit_fired) return false;
  const rem = Number(mirror.shares_remaining);
  if (!Number.isFinite(rem) || rem <= 0) return false;
  const reject = String(mirror.last_reject || "");
  if (TERMINAL_EXIT_REJECT.test(reject)) return false;
  const rejectTs = Number(mirror.last_reject_ts) || 0;
  if (rejectTs && (Number(now) || Date.now()) - rejectTs < INDEX_TREND_REJECT_COOLDOWN_MS) {
    return false;
  }
  return true;
}

export async function indexTrendNeedsExitCatchUp(env, signalId, now = Date.now()) {
  const existing = await loadMirror(env, signalId);
  return indexTrendMirrorNeedsExitCatchUp(existing, now);
}

async function claimHealLock(env, now) {
  const KV = env?.KV_TIMED;
  if (!KV) return true;
  try {
    const raw = await KV.get(HEAL_LOCK_KEY);
    const prev = raw ? JSON.parse(raw) : null;
    if (prev?.until && Number(prev.until) > now) return false;
    await KV.put(HEAL_LOCK_KEY, JSON.stringify({ until: now + HEAL_LOCK_MS }), { expirationTtl: 120 });
    return true;
  } catch {
    return true;
  }
}

/** True when a close no longer needs broker follow-through (placed or already flat). */
export function indexTrendCloseReadyToFinalize(result) {
  if (!result) return false;
  if (indexTrendCatchUpPlaced(result)) return true;
  if (result.flattened) return true;
  const reason = String(result.reason || extractIndexTrendRejectReason(result.fired) || "");
  return /mirror_position_already_flat|no_mirrored_entry/i.test(reason)
    || isTerminalIndexTrendExitReject(reason);
}

/**
 * Scan recent paper STOP/EXIT rows and flatten any mirrored remainder
 * the same-tick forward never placed.
 * Premature day-trade invalidations on a runner (TQQQ W36) are revived
 * and held — heal must not sell those leftovers.
 */
export async function healStrandedIndexTrendCloses(env, { now = Date.now(), limit = 8 } = {}) {
  const out = {
    scanned: 0,
    attempted: 0,
    filled: 0,
    skipped: 0,
    revived: 0,
    locked: false,
    results: [],
  };
  if (!(await claimHealLock(env, now))) {
    out.locked = true;
    return out;
  }
  const actions = await readIndexTrendActions(env, now - EXIT_CATCHUP_LOOKBACK_MS);
  const seen = new Set();
  for (const a of actions) {
    const sid = String(a?.signal_id || "").trim();
    const ev = String(a?.event || "").toUpperCase();
    if (!sid || seen.has(sid)) continue;
    if (ev !== "STOP" && ev !== "EXIT") continue;
    seen.add(sid);
    const loaded = await loadIndexTrendBook(env, {
      signal_id: sid,
      letf_ticker: a.letf_ticker,
    });
    if (isPrematureIndexTrendInvalidation(loaded?.book, { atrPct: 0.012 })) {
      const revived = await maybeReviveIndexTrendBook(env, {
        book: loaded.book,
        bookKey: loaded.bookKey,
        letfTicker: a.letf_ticker,
        signalId: sid,
        now,
      });
      if (revived) {
        out.revived += 1;
        out.results.push({
          signal_id: sid,
          ticker: String(a.letf_ticker || "").toUpperCase(),
          placed: false,
          revived: true,
          qty: revived.shares_remaining ?? null,
          reason: "premature_invalidation_widened",
        });
        continue;
      }
    }
    // A revived / still-open runner must not be flatten-healed off a stale STOP tape.
    if (loaded?.book && indexTrendBookIsLive(loaded.book) && loaded.book.status !== "pending_close") {
      continue;
    }
    if (!(await indexTrendNeedsExitCatchUp(env, sid, now))) continue;
    const mirror = await loadMirror(env, sid);
    out.scanned += 1;
    const result = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "EXIT",
      catch_up: true,
      signal_id: sid,
      underlying: a.underlying || mirror?.underlying,
      letf_ticker: a.letf_ticker || mirror?.letf_ticker,
      letf_price: Number(a.letf_price) || Number(mirror?.last_letf_price) || 0,
      book: {
        status: "closed",
        shares: Number(mirror?.shares) || 0,
        shares_remaining: 0,
      },
      now,
    });
    out.attempted += 1;
    const placed = indexTrendCatchUpPlaced(result);
    if (placed) out.filled += 1;
    else out.skipped += 1;
    out.results.push({
      signal_id: sid,
      ticker: String(a.letf_ticker || mirror?.letf_ticker || "").toUpperCase(),
      placed,
      flattened: !!result?.flattened,
      qty: result?.qty ?? null,
      reason: result?.reason || extractIndexTrendRejectReason(result?.fired) || result?.fired?.skip || null,
    });
    if (out.attempted >= limit) break;
  }
  return out;
}

/**
 * Catch a same-session paper BUY that never reached /bridge/order
 * (notify/email wrote, isolate died, actions tape raced). Scans carry
 * keys so a dropped BUY row still heals. Runs before EXIT heal so a
 * doomed no_broker_position flatten cannot starve the live entry.
 */
export async function healMissedIndexTrendEntries(env, { now = Date.now(), limit = 4 } = {}) {
  const out = { scanned: 0, attempted: 0, filled: 0, skipped: 0, results: [] };
  if (!isNyRegularMarketOpenStatic(new Date(Number(now) || Date.now()))) {
    out.reason = "outside_rth";
    return out;
  }
  for (const letf of INDEX_TREND_CARRY_LETFS) {
    const loaded = await loadIndexTrendBook(env, { letf_ticker: letf });
    const book = loaded?.book;
    const sid = loaded?.signal_id || book?.signal_id || null;
    if (!sid || !book || !indexTrendBookIsLive(book)) continue;
    out.scanned += 1;
    if (!(await indexTrendShouldCatchUpOpenEntry(env, { signalId: sid, book, now }))) continue;
    const result = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      catch_up: true,
      signal_id: sid,
      underlying: book.underlying || loaded.underlying,
      letf_ticker: letf,
      letf_price: Number(book.last_letf_price) || Number(book.entry_letf_price) || 0,
      book,
      now,
    });
    out.attempted += 1;
    const placed = indexTrendCatchUpPlaced(result);
    if (placed) out.filled += 1;
    else out.skipped += 1;
    out.results.push({
      signal_id: sid,
      ticker: letf,
      placed,
      qty: result?.qty ?? null,
      reason: result?.reason || extractIndexTrendRejectReason(result?.fired) || null,
    });
    if (out.attempted >= limit) break;
  }
  return out;
}

/** True when a catch-up BUY actually forwarded (not skipped/rejected). */
export function indexTrendCatchUpPlaced(result) {
  if (!result || result.skipped) return false;
  return indexTrendFiredLooksPlaced(result.fired);
}

export function indexTrendMirrorKey(signalId) {
  return `timed:idx-trend-mirror:${String(signalId || "").trim()}`;
}

async function loadMirror(env, signalId) {
  if (!env?.KV_TIMED || !signalId) return null;
  try {
    const raw = await env.KV_TIMED.get(indexTrendMirrorKey(signalId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function saveMirror(env, signalId, patch) {
  if (!env?.KV_TIMED || !signalId) return;
  const prev = await loadMirror(env, signalId) || {};
  const merged = { ...prev, ...patch, signal_id: signalId, ts: Date.now() };
  await env.KV_TIMED.put(indexTrendMirrorKey(signalId), JSON.stringify(merged), { expirationTtl: MIRROR_TTL });
}

async function recordMirrorDecision(env, ctx, result) {
  const KV = env?.KV_TIMED;
  if (!KV) return;
  try {
    const raw = await KV.get(MIRROR_LOG_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const event = String(ctx.event || "").toUpperCase();
    const skipped = !!result?.skipped;
    const firedSkip = result?.fired?.skip || null;
    const rejected = !skipped && (result?.fired?.ok === false || !!firedSkip);
    list.unshift({
      ts: Date.now(),
      event,
      side: (event === "BUY" || event === "DCA_ADD") ? "buy" : "sell",
      signal_id: String(ctx.signal_id || ""),
      underlying: String(ctx.underlying || ctx.ticker || "").toUpperCase(),
      letf_ticker: String(ctx.letf_ticker || "").toUpperCase(),
      skipped,
      decision: skipped ? "skipped" : (rejected ? "rejected" : "placed"),
      reason: result?.reason || extractIndexTrendRejectReason(result?.fired) || result?.error || firedSkip || null,
    });
    if (list.length > MIRROR_LOG_MAX) list.length = MIRROR_LOG_MAX;
    await KV.put(MIRROR_LOG_KEY, JSON.stringify(list), { expirationTtl: 30 * 86400 });
  } catch (_) { /* best-effort */ }
}

async function gateMirror(env, ctx = {}) {
  const operatorEmail = env.ADMIN_EMAIL;
  if (!operatorEmail) return { ok: false, skipped: true, reason: "no_operator_email" };

  const letfTicker = String(ctx.letf_ticker || "").toUpperCase();
  const underlying = String(ctx.underlying || ctx.ticker || "").toUpperCase();
  if (!letfTicker || !underlying) return { ok: false, skipped: true, reason: "missing_context" };

  const prefs = await loadAutoMirrorPrefs(env, operatorEmail);
  if (!prefs.enabled) return { ok: false, skipped: true, reason: "disabled" };

  const vehicleRow = prefs.vehicles?.[VEHICLE_KEY];
  if (!vehicleRow?.enabled) {
    return { ok: false, skipped: true, reason: `vehicle_${VEHICLE_KEY}_disabled`, vehicle: VEHICLE_KEY };
  }

  return { ok: true, operatorEmail, letfTicker, underlying, prefs, vehicleRow };
}

async function bumpEntryCounters(env, operatorEmail, prefs, vehicleRow) {
  let vehicleCounter = null;
  const vehicleCap = Number(vehicleRow.daily_cap || 0);
  if (vehicleCap > 0) {
    const vCounter = await checkAndBumpVehicleCounter(env, operatorEmail, VEHICLE_KEY, vehicleCap);
    if (!vCounter.allowed) {
      return { ok: false, skipped: true, reason: `vehicle_daily_cap_${vCounter.cap}_reached_for_${VEHICLE_KEY}` };
    }
    vehicleCounter = vCounter;
  }
  let globalCounter = null;
  const globalCap = Number(prefs.daily_cap) || 0;
  if (globalCap > 0) {
    const counter = await checkAndBumpDailyCounter(env, operatorEmail, globalCap);
    if (!counter.allowed) {
      if (vehicleCounter) await releaseVehicleCounter(env, operatorEmail, VEHICLE_KEY);
      return { ok: false, skipped: true, reason: `daily_cap_${counter.cap}_reached` };
    }
    globalCounter = counter;
  }
  return { ok: true, vehicle_counter: vehicleCounter, global_counter: globalCounter };
}

async function releaseEntryCounters(env, operatorEmail, reservation) {
  const releases = [];
  if (reservation?.vehicle_counter) {
    releases.push(releaseVehicleCounter(env, operatorEmail, VEHICLE_KEY));
  }
  if (reservation?.global_counter) {
    releases.push(releaseDailyCounter(env, operatorEmail));
  }
  await Promise.all(releases);
}

function planEntryQty({ vehicleRow, letfPrice, book, size }) {
  const px = Number(letfPrice);
  const maxUsd = Number(vehicleRow?.max_per_order_usd) || 2000;
  const fromBook = Number(book?.shares) || Number(size?.shares);
  const qty = Number.isFinite(fromBook) && fromBook > 0
    ? Math.round(fromBook)
    : defaultIndexTrendPaperShares(px, maxUsd);
  const notional = px > 0 ? px * qty : 0;
  if (maxUsd > 0 && notional > maxUsd * 1.05) {
    return { ok: false, reason: `notional_${Math.round(notional)}_exceeds_cap_${maxUsd}` };
  }
  return { ok: true, qty: Math.max(1, qty) };
}

function closeQty(event, book, mirror) {
  const ev = String(event || "").toUpperCase();
  const mirroredRem = Number.isFinite(Number(mirror?.shares_remaining))
    ? Math.max(0, Math.round(Number(mirror.shares_remaining)))
    : Math.max(0, Math.round(Number(mirror?.shares) || 0));
  if (mirroredRem <= 0) return 0;
  if (ev === "TRIM") {
    const trimQty = Number(book?.trim_sell_qty);
    if (Number.isFinite(trimQty) && trimQty > 0) return Math.min(mirroredRem, Math.round(trimQty));
    return Math.min(mirroredRem, Math.max(1, Math.round(mirroredRem * 0.25)));
  }
  if (ev === "DCA_ADD") {
    const addQty = Number(book?.dca_add_qty) || Math.max(1, Math.round(mirroredRem * 0.5));
    return Math.max(1, addQty);
  }
  return mirroredRem;
}

export async function maybeAutoMirrorIndexTrendEvent(env, ctx = {}) {
  let result;
  try {
    result = await runIndexTrendMirror(env, ctx);
  } catch (err) {
    result = { skipped: true, error: String(err?.message || err).slice(0, 160), reason: "mirror_error" };
  }
  try { await recordMirrorDecision(env, ctx, result); } catch (_) { /* best-effort */ }
  return result;
}

async function runIndexTrendMirror(env, ctx = {}) {
  const event = String(ctx.event || "BUY").toUpperCase();
  const signalId = String(ctx.signal_id || "").trim();
  const gate = await gateMirror(env, ctx);
  if (!gate.ok) return gate;

  const { operatorEmail, letfTicker, underlying, prefs, vehicleRow } = gate;
  const mgmt = ctx.management || ctx.play?.management || {};
  const letfPrice = Number(ctx.letf_price);

  if (event === "BUY" || event === "DCA_ADD") {
    // Catch-up of an already-open paper book (the original BUY's waitUntil
    // died) may run after the cash session — Webull can still take the share.
    if (!ctx.catch_up && !isNyBuyWindow(ctx.now)) {
      return { skipped: true, reason: "outside_rth_buy_window" };
    }
  }

  if (event === "BUY") {
    if (signalId) {
      const existing = await loadMirror(env, signalId);
      if (existing?.entry_fired) return { skipped: true, reason: "entry_already_mirrored" };
    }
    const sizing = planEntryQty({ vehicleRow, letfPrice, book: ctx.book, size: ctx.size });
    if (!sizing.ok) return { skipped: true, reason: sizing.reason };

    const counterOk = await bumpEntryCounters(env, operatorEmail, prefs, vehicleRow);
    if (!counterOk.ok) return counterOk;

    const fired = await forwardOrderToBridge(env, {
      user_id: operatorEmail,
      trade_id: signalId || `it:${underlying}:${letfTicker}`,
      client_order_id: `tt-it-${signalId || underlying}-buy-${Date.now()}`,
      ticker: letfTicker,
      side: "buy",
      qty: sizing.qty,
      entry: letfPrice > 0 ? letfPrice : null,
      sl: mgmt.stop_underlying || null,
      tp: mgmt.target_underlying || null,
      mode: "trader",
      horizon: "swing_trend",
      vehicle: VEHICLE_KEY,
      meta: { underlying, lane: "index_trend", archetype: "index_trend_letf" },
    });

    const placed = indexTrendFiredLooksPlaced(fired);
    if (signalId && placed) {
      const parsed = fired.response && typeof fired.response === "object"
        ? fired.response
        : fired;
      const ids = parseBridgeOrderIds(parsed);
      await saveMirror(env, signalId, {
        entry_fired: true,
        letf_ticker: letfTicker,
        underlying,
        shares: sizing.qty,
        shares_remaining: sizing.qty,
        entry_order_id: ids.order_id,
        entry_order_ids: ids.order_ids,
        last_reject: null,
        last_reject_ts: null,
      });
    } else if (signalId) {
      await saveMirror(env, signalId, {
        last_reject: extractIndexTrendRejectReason(fired),
        last_reject_ts: Number(ctx.now) || Date.now(),
      });
    }
    if (!placed) await releaseEntryCounters(env, operatorEmail, counterOk);

    return {
      skipped: false,
      fired,
      event,
      qty: sizing.qty,
      vehicle: VEHICLE_KEY,
      reason: placed ? null : extractIndexTrendRejectReason(fired),
    };
  }

  if (event === "DCA_ADD") {
    if (!signalId) return { skipped: true, reason: "no_signal_id" };
    const mirror = await loadMirror(env, signalId);
    if (!mirror?.entry_fired) return { skipped: true, reason: "no_mirrored_entry" };
    const qty = closeQty(event, ctx.book, mirror);
    if (!(qty > 0)) return { skipped: true, reason: "zero_dca_qty" };

    const fired = await forwardOrderToBridge(env, {
      user_id: operatorEmail,
      trade_id: signalId,
      client_order_id: `tt-it-${signalId}-dca-${Date.now()}`,
      ticker: letfTicker,
      side: "buy",
      qty,
      entry: letfPrice > 0 ? letfPrice : null,
      mode: "trader",
      horizon: "swing_trend",
      vehicle: VEHICLE_KEY,
      meta: { underlying, lane: "index_trend", dca: true },
    });

    if (indexTrendFiredLooksPlaced(fired)) {
      const rem = (Number(mirror.shares_remaining) || 0) + qty;
      await saveMirror(env, signalId, {
        shares: (Number(mirror.shares) || 0) + qty,
        shares_remaining: rem,
        dca_fired: true,
      });
    }
    return { skipped: false, fired, event, qty, vehicle: VEHICLE_KEY };
  }

  // TRIM / EXIT / STOP — never cap-gated.
  if (!signalId) return { skipped: true, reason: "no_signal_id" };
  const mirror = await loadMirror(env, signalId);
  if (!mirror?.entry_fired) return { skipped: true, reason: "no_mirrored_entry" };
  if (event === "TRIM" && mirror.trim_fired) return { skipped: true, reason: "trim_already_mirrored" };
  if ((event === "EXIT" || event === "STOP") && mirror.exit_fired) {
    return { skipped: true, reason: "exit_already_mirrored" };
  }

  const qty = closeQty(event, ctx.book, mirror);
  if (!(qty > 0)) return { skipped: true, reason: "mirror_position_already_flat" };

  const side = event === "TRIM" ? "trim" : "exit";
  const fired = await forwardOrderToBridge(env, {
    user_id: operatorEmail,
    trade_id: signalId,
    client_order_id: `tt-it-${signalId}-${side}-${Date.now()}`,
    ticker: letfTicker,
    side,
    qty,
    reduce_pct: event === "TRIM" ? (qty / Math.max(1, Number(mirror.shares_remaining) || qty)) : undefined,
    mode: "trader",
    horizon: "swing_trend",
    vehicle: VEHICLE_KEY,
    meta: { underlying, lane: "index_trend", close_event: event.toLowerCase() },
  });

  const rejectReason = extractIndexTrendRejectReason(fired);
  if (indexTrendFiredLooksPlaced(fired)) {
    const remaining = Math.max(0, (Number(mirror.shares_remaining) || 0) - qty);
    const patch = event === "TRIM"
      ? { trim_fired: true, trim_qty: qty, shares_remaining: remaining, last_reject: null, last_reject_ts: null }
      : { exit_fired: true, exit_qty: qty, shares_remaining: remaining, last_reject: null, last_reject_ts: null };
    await saveMirror(env, signalId, patch);
    return { skipped: false, fired, event, qty, vehicle: VEHICLE_KEY };
  }

  const nowTs = Number(ctx.now) || Date.now();
  if (isTerminalIndexTrendExitReject(rejectReason)) {
    await saveMirror(env, signalId, {
      exit_fired: true,
      shares_remaining: 0,
      last_reject: rejectReason,
      last_reject_ts: nowTs,
      exit_terminal: true,
      exit_terminal_reason: rejectReason,
    });
    return {
      skipped: false,
      fired,
      event,
      qty,
      vehicle: VEHICLE_KEY,
      flattened: true,
      reason: rejectReason,
    };
  }

  await saveMirror(env, signalId, {
    last_reject: rejectReason,
    last_reject_ts: nowTs,
  });

  return { skipped: false, fired, event, qty, vehicle: VEHICLE_KEY, reason: rejectReason };
}

function isNyBuyWindow(ts) {
  return isNyRegularMarketOpenStatic(new Date(Number(ts) || Date.now()));
}
