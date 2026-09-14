// index-trend-auto-mirror.js
//
// Broker mirror for index trend LETF share plays via /bridge/order.

import { forwardOrderToBridge, parseBridgeOrderIds, readClientRing } from "./broker-bridge-client.js";
import {
  loadAutoMirrorPrefs,
  entryCountersHaveRoom,
  commitEntryCounters,
  vehicleCounterKeyFor,
} from "./options-auto-mirror.js";
import { ringLooksLikeRealPlace } from "./investor-catchup-run.js";
import { loadBrokerHeldEquity, heldQtyFor } from "./broker-held-equity.js";
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
  const candidates = [];
  for (const letf of INDEX_TREND_CARRY_LETFS) {
    const loaded = await loadIndexTrendBook(env, { letf_ticker: letf });
    const book = loaded?.book;
    const sid = loaded?.signal_id || book?.signal_id || null;
    if (!sid || !book || !indexTrendBookIsLive(book)) continue;
    out.scanned += 1;
    if (!(await indexTrendShouldCatchUpOpenEntry(env, { signalId: sid, book, now }))) continue;
    const existing = await loadMirror(env, sid);
    const px = Number(book.last_letf_price) || Number(book.entry_letf_price) || 0;
    const shares = Number(book.shares) || 0;
    candidates.push({
      letf,
      sid,
      book,
      loaded,
      neverAttempted: !indexTrendMirrorLooksAttempted(existing),
      notional: px > 0 && shares > 0 ? px * shares : Number.MAX_SAFE_INTEGER,
    });
  }
  // Never-attempted new sleeves that still fit the $2000 book (UDOW W38)
  // before leftover books that grew past the cap (TNA W37 after paper DCA).
  candidates.sort((a, b) => {
    if (a.neverAttempted !== b.neverAttempted) return Number(b.neverAttempted) - Number(a.neverAttempted);
    return a.notional - b.notional;
  });
  for (const row of candidates) {
    const result = await maybeAutoMirrorIndexTrendEvent(env, {
      event: "BUY",
      catch_up: true,
      signal_id: row.sid,
      underlying: row.book.underlying || row.loaded.underlying,
      letf_ticker: row.letf,
      letf_price: Number(row.book.last_letf_price) || Number(row.book.entry_letf_price) || 0,
      book: row.book,
      now,
    });
    out.attempted += 1;
    const placed = indexTrendCatchUpPlaced(result);
    if (placed) out.filled += 1;
    else out.skipped += 1;
    out.results.push({
      signal_id: row.sid,
      ticker: row.letf,
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

function entryCapsFor(prefs, vehicleRow, now) {
  return {
    vehicleCap: Number(vehicleRow?.daily_cap || 0),
    globalCap: Number(prefs?.daily_cap) || 0,
    now: Number(now) || Date.now(),
  };
}

/**
 * UTC calendar day — the same basis the counter keys use, so the reconcile
 * counts exactly the window the counter covers.
 */
function counterDayKey(ts) {
  return new Date(Number(ts) || Date.now()).toISOString().slice(0, 10);
}

/**
 * Count the LETF buys the bridge actually took today, from the dispatch
 * ring. The ring is written per `/bridge/order` call, so it is the record
 * of what left the worker.
 */
/**
 * A dispatch whose outcome nobody ever learned. `forwardOrderToBridge`
 * stamps `status:"pending"` BEFORE the fetch so a torn-down isolate still
 * explains the model row; the response write is what flips it to ok/error.
 * So a row left at `pending` means the request may well have reached the
 * broker — SPYU 2026-09-14 sat at `pending qty 60` in the ring while the
 * broker ledger held a real 9-share FILL. Treat it as spent, never as free.
 */
export function ringRowOutcomeUnknown(row) {
  const status = String(row?.status || "").toLowerCase();
  return status === "pending" || status === "fetch_error";
}

/**
 * Slots this vehicle can account for today. Counts confirmed places AND
 * unknown-outcome dispatches: handing a slot back for a dispatch that
 * might have filled is how a heal double-buys a live sleeve.
 */
export function countRingLetfBuysToday(ring = [], now = Date.now()) {
  const today = counterDayKey(now);
  const carry = new Set(INDEX_TREND_CARRY_LETFS);
  const seen = new Set();
  for (const row of ring || []) {
    if (String(row?.side || "").toLowerCase() !== "buy") continue;
    if (!carry.has(String(row?.ticker || "").toUpperCase())) continue;
    if (counterDayKey(row?.ts) !== today) continue;
    if (!ringLooksLikeRealPlace(row) && !ringRowOutcomeUnknown(row)) continue;
    seen.add(String(row.trade_id || row.client_order_id || `${row.ticker}|${row.ts}`));
  }
  return seen.size;
}

/**
 * Count mirror rows stamped with a confirmed entry today. Written by the
 * same branch that commits the counter, so it corroborates the ring.
 */
async function countMirrorEntriesToday(env, now = Date.now()) {
  const KV = env?.KV_TIMED;
  if (typeof KV?.list !== "function") return 0;
  const today = counterDayKey(now);
  let n = 0;
  try {
    const listed = await KV.list({ prefix: "timed:idx-trend-mirror:", limit: 200 });
    for (const entry of listed?.keys || []) {
      const raw = await KV.get(entry.name);
      if (!raw) continue;
      let row = null;
      try { row = JSON.parse(raw); } catch { continue; }
      if (!row?.entry_fired) continue;
      if (counterDayKey(row.entry_fired_ts) !== today) continue;
      n += 1;
    }
  } catch (_) {
    return n;
  }
  return n;
}

/**
 * Heal a day counter that drifted above the orders actually placed.
 *
 * Commit-on-place stops NEW leaks, but a value already stranded by the old
 * reserve-then-release path kept the lane shut until the date key rolled
 * (2026-09-14 sat at 2/2 with zero placed orders, so every sleeve skipped
 * `vehicle_daily_cap_2_reached` for a full session). Reconciling lets the
 * lane recover on the next tick instead of at midnight.
 *
 * Two independent records have to agree that a slot went unused, and the
 * higher count wins: the dispatch ring and the mirror rows are both written
 * on the same confirmed-place branch as the counter commit, so trusting
 * either one alone would let a lagging write erase a legitimate slot and
 * make the cap unenforceable. Only ever lowers the counter.
 */
export async function reconcileIndexTrendVehicleCounter(env, operatorEmail, { now = Date.now() } = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return null;
  const key = vehicleCounterKeyFor(operatorEmail, VEHICLE_KEY, counterDayKey(now));
  try {
    const current = Number(await KV.get(key)) || 0;
    if (current <= 0) return null;
    const placed = Math.max(
      countRingLetfBuysToday(await readClientRing(env), now),
      await countMirrorEntriesToday(env, now),
    );
    if (placed >= current) return null;
    await KV.put(key, String(placed), { expirationTtl: 86400 * 2 });
    console.log(`[INDEX-TREND MIRROR] counter reconciled ${current} -> ${placed} (confirmed places today)`);
    return { key, from: current, to: placed };
  } catch (_) {
    return null;
  }
}

/** A sleeve the broker holds but no mirror row claims counts as filled from this many shares. */
export const ADOPT_MIN_SHARES = 0.999;

/**
 * Claim a sleeve the broker already holds instead of buying it again.
 *
 * A catch-up exists because every model-side record says "never attempted".
 * SPYU W38 proved those records can be wrong in the expensive direction: a
 * real 9-share fill with no ring settle, no audit row and no mirror row. The
 * broker's position is the only witness, so consult it before re-spending
 * and write the mirror row the dead isolate never got to write.
 *
 * Only on the catch-up path. A fresh BUY has not dispatched yet, so there is
 * nothing to confuse it with, and the entry must stay fast.
 *
 * Returns a skip result when the sleeve was adopted, else null to buy.
 */
export async function adoptBrokerHeldSleeve(env, {
  signalId,
  letfTicker,
  underlying,
  operatorEmail,
  catchUp = false,
  now = Date.now(),
} = {}) {
  if (!catchUp || !signalId || !letfTicker) return null;
  let held = null;
  try {
    held = await loadBrokerHeldEquity(env, { owner: operatorEmail, nowMs: Number(now) || Date.now() });
  } catch (_) {
    held = null;
  }
  // Unreachable broker. Buying on an unknown is the one outcome that cannot
  // be undone, so hold the sleeve and let the next tick decide.
  if (held == null) return { skipped: true, reason: "broker_holdings_unknown_entry_deferred" };
  const qty = heldQtyFor(held, letfTicker);
  if (!(qty >= ADOPT_MIN_SHARES)) return null;
  const shares = Math.max(1, Math.round(qty));
  await saveMirror(env, signalId, {
    entry_fired: true,
    entry_fired_ts: Number(now) || Date.now(),
    letf_ticker: letfTicker,
    underlying,
    shares,
    shares_remaining: shares,
    adopted_from_broker: true,
    adopted_broker_qty: qty,
    last_reject: null,
    last_reject_ts: null,
  });
  console.log(
    `[INDEX-TREND MIRROR] adopted broker-held ${letfTicker} ${qty} sh for ${signalId}`
    + " (no mirror row; catch-up would have double-bought)",
  );
  return {
    skipped: true,
    adopted: true,
    qty: shares,
    reason: `broker_already_holds_${letfTicker}_${qty}_adopted`,
  };
}

/**
 * Size a BUY to the vehicle sleeve. Paper books can grow past
 * max_per_order_usd (TNA W37 DCA 30→46 sh = $2975 vs $2000). Skipping
 * the whole catch-up left Discord-only signals. Cash-scale down to
 * the cap — same math as a fresh paper open.
 */
export function planEntryQty({ vehicleRow, letfPrice, book, size } = {}) {
  const px = Number(letfPrice);
  const maxUsd = Number(vehicleRow?.max_per_order_usd) || 2000;
  const fromBook = Number(book?.shares) || Number(size?.shares);
  const rawQty = Number.isFinite(fromBook) && fromBook > 0
    ? Math.round(fromBook)
    : defaultIndexTrendPaperShares(px, maxUsd);
  let qty = rawQty;
  let scaled = false;
  if (px > 0 && maxUsd > 0 && qty * px > maxUsd * 1.05) {
    qty = defaultIndexTrendPaperShares(px, maxUsd);
    scaled = qty !== rawQty;
  }
  if (!(qty > 0)) return { ok: false, reason: "zero_qty" };
  return { ok: true, qty: Math.max(1, qty), scaled, raw_qty: rawQty };
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
  let event = String(ctx.event || "BUY").toUpperCase();
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

  // Paper DCA on a sleeve that never filled is an entry, not an add.
  if (event === "DCA_ADD" && signalId) {
    const existing = await loadMirror(env, signalId);
    if (!existing?.entry_fired) event = "BUY";
  }

  if (event === "BUY") {
    if (signalId) {
      const existing = await loadMirror(env, signalId);
      if (existing?.entry_fired) return { skipped: true, reason: "entry_already_mirrored" };
    }
    // A catch-up runs precisely because our own records cannot say whether
    // the first dispatch landed. Ask the broker before spending again.
    const adopted = await adoptBrokerHeldSleeve(env, {
      signalId,
      letfTicker,
      underlying,
      operatorEmail,
      catchUp: ctx.catch_up === true,
      now: ctx.now,
    });
    if (adopted) return adopted;
    const sizing = planEntryQty({ vehicleRow, letfPrice, book: ctx.book, size: ctx.size });
    if (!sizing.ok) return { skipped: true, reason: sizing.reason };

    // Caps are checked here and counted only once the bridge confirms a
    // place, so a dead isolate cannot burn a slot it never used. Heal a
    // counter stranded by the old reserve-then-release path first.
    const caps = entryCapsFor(prefs, vehicleRow, ctx.now);
    await reconcileIndexTrendVehicleCounter(env, operatorEmail, { now: caps.now });
    const capRoom = await entryCountersHaveRoom(env, operatorEmail, VEHICLE_KEY, caps);
    if (!capRoom.ok) return capRoom;

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
        // Day-stamped so the cap reconcile can tell a slot this vehicle
        // really used from one a dead isolate stranded.
        entry_fired_ts: caps.now,
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
    if (placed) await commitEntryCounters(env, operatorEmail, VEHICLE_KEY, caps);


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
