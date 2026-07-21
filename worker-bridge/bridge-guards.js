// worker-bridge/bridge-guards.js
//
// 2026-05-29 — Pre-flight guards for the broker bridge.
// Every incoming order goes through these checks BEFORE we touch
// the actual Robinhood MCP. Fail-closed: any check failing returns
// { ok: false, reject_reason } and the caller logs + refuses.

import { getKillSwitch, readUser, writeUser, resolveBridgeUser } from "./bridge-storage.js";
import { readManifestRow, classifyOrderLifecycle } from "./bridge-manifest.js";
import { brokerCapabilities, resolveBrokerId } from "./bridge-brokers.js";
import { computeRelationalQty } from "./bridge-sizing.js";

// 2026-06-01 — Naked-short sides are HARD-rejected regardless of any
// env var. The previous behavior accepted `REJECT_SHORT_SIDES=false`
// as an override; that escape hatch is now removed so the deferral
// is a code-level invariant. See worker/options-auto-mirror.js
// → NAKED_SHORT_ARCHETYPES for the matching list at the engine level.
const SHORT_SIDES = new Set(["short", "sell_short", "sellshort"]);
const ALLOWED_LONG_SIDES = new Set(["buy", "long", "entry", "trim", "exit", "sell"]);

// 2026-06-01 — Vehicle keys that align with worker/options-auto-mirror.js.
// Naked-short keys are NOT listed — the bridge rejects any payload that
// names one in `vehicle`.
const RECOGNIZED_VEHICLES = new Set([
  "equity_long",
  "long_call",
  "long_put",
  "vertical_spread",
  "leaps",
  "straddle",
  "moonshot",
]);
const NAKED_SHORT_VEHICLES = new Set([
  "short_call",
  "short_put",
  "iron_condor_naked",
  "short_straddle",
  "short_strangle",
  "short_combo",
  "covered_call_naked",
]);

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resolveUserCaps(env, user) {
  const defaultPerOrder = Number(env?.DEFAULT_MAX_ORDER_USD) || 5000;
  const defaultPerDay   = Number(env?.DEFAULT_MAX_ORDERS_PER_DAY) || 3;
  const overrides = user?.user_caps || {};
  return {
    max_per_order_usd: Number(overrides.max_per_order_usd) || defaultPerOrder,
    max_orders_per_day: Number(overrides.max_orders_per_day) || defaultPerDay,
    max_account_pct: Number(overrides.max_account_pct) || 0.25, // never put >25% of account on one order by default
  };
}

/**
 * 2026-06-01 — Per-vehicle prefs gate (PR #412). Called from preflightOrder
 * after the global guards pass. Reads the user's `options_prefs.vehicles[k]`
 * map (mirrored from worker/options-auto-mirror.js) and verifies:
 *   1. The vehicle row exists and is enabled.
 *   2. The order's notional respects the vehicle's max_per_order_usd.
 *
 * Returns { ok: true } when no vehicle is specified (equity orders
 * without a vehicle field bypass this check; they're governed by the
 * global per-user cap instead).
 *
 * Returns { ok: false, reject_reason } when any per-vehicle constraint
 * is violated.
 *
 * Storage shape (set via POST /bridge/user/options-prefs):
 *   user.options_prefs = {
 *     vehicles: {
 *       long_call: { enabled: true, max_per_order_usd: 200, daily_cap: 2, max_loss_per_order_usd: 75 },
 *       ...
 *     }
 *   }
 * Falls back to a permissive default (enabled=false for every option
 * vehicle, enabled=true for equity_long) so a freshly-connected user
 * with no prefs row can still place an equity order but cannot place
 * any option order until they opt in via Mission Control.
 */
export function validateVehiclePrefs(payload, user) {
  const vehicle = payload?.vehicle ? String(payload.vehicle).trim().toLowerCase() : null;
  if (!vehicle) return { ok: true };
  if (!RECOGNIZED_VEHICLES.has(vehicle)) {
    return { ok: false, reject_reason: `unknown_vehicle:${vehicle}` };
  }
  const prefsVehicles = user?.options_prefs?.vehicles || {};
  // Conservative defaults when no prefs exist: every option vehicle is
  // OFF; equity_long is ON. Mirrors VEHICLE_DEFAULTS in the engine.
  const defaultEnabled = vehicle === "equity_long";
  const row = prefsVehicles[vehicle];
  const enabled = row ? !!row.enabled : defaultEnabled;
  if (!enabled) {
    return { ok: false, reject_reason: `vehicle_${vehicle}_disabled_by_user` };
  }
  // Per-vehicle notional cap (when a price is supplied).
  const entry = Number(payload.entry || payload.price_target || 0);
  const qty = Number(payload.qty || 0);
  if (entry > 0 && qty > 0 && row && Number(row.max_per_order_usd) > 0) {
    const estValue = entry * qty;
    if (estValue > Number(row.max_per_order_usd)) {
      return {
        ok: false,
        reject_reason: `vehicle_${vehicle}_notional_${estValue.toFixed(0)}_exceeds_cap_${row.max_per_order_usd}`,
        vehicle, estimated_value: estValue, vehicle_cap: row.max_per_order_usd,
      };
    }
  }
  return { ok: true, vehicle, vehicle_row: row };
}

// 2026-06-01 — Phase B: manifest-aware reducer.
//
// Reads the mirror_trade_manifest row for (user_id, trade_id,
// broker_account_id) BEFORE running the portfolio check, and gates
// reducing/closing actions on what the bridge actually opened.
//
// Decision matrix (§4.1 of tasks/2026-06-01-trade-aware-mirror-sync-design.md):
//
//   Open (entry / buy / add / dca_buy):
//     - No manifest gate. Phase A writer handles row creation.
//
//   Reduce (trim):
//     - manifest missing → REJECT (no_manifest_for_trade)
//     - sync_state == 'pending' → REJECT (entry not yet confirmed)
//     - sync_state in {rejected, mothership_orphan, mirror_suppressed,
//       expired, untracked} → REJECT (with specific reason)
//     - mirror_suppressed=1 → REJECT (mirror_suppressed)
//     - sync_state in {in_sync, partial_fill, broker_orphan} → PROCEED
//     - partial_fill + BROKER_PARTIAL_FILL_MODE='scale' → scale qty
//
//   Close (exit / close / sell):
//     - manifest missing → REJECT (no_manifest_for_trade)
//     - sync_state in {pending, rejected, mothership_orphan,
//       mirror_suppressed, expired} → REJECT
//     - sync_state in {in_sync, partial_fill, broker_orphan,
//       untracked} → PROCEED (we're TRYING to close — broker_orphan
//       included so the exit can mop up an open broker position)
//
// Phase A writer leaves rejected entries with sync_state='rejected'
// + mirror_suppressed=1, so a follow-on TRIM/EXIT on a rejected
// trade_id is correctly rejected here as 'mirror_suppressed'.
//
// Failure mode: if the manifest table is missing or the read throws,
// fail-OPEN (allow the order, log a warning). The portfolio guard
// (PR #409) is the last-line defense.
//
// Rollout safety: gated by env BROKER_MANIFEST_ENFORCE.
//   'on' (default in prod once Phase A has data) → reject per matrix
//   'log' → log decision but allow order (shadow mode)
//   'off' → skip entirely (back-compat)
export async function manifestAwareReducerCheck(env, payload, user) {
  const mode = String(env?.BROKER_MANIFEST_ENFORCE || "on").toLowerCase();
  if (mode === "off") return { ok: true, skipped: "manifest_enforce_off" };

  const lifecycle = classifyOrderLifecycle(payload?.side);
  if (lifecycle !== "reduce" && lifecycle !== "close") {
    // Entries don't read the manifest — the writer creates the row.
    return { ok: true, lifecycle };
  }

  const tradeId = String(payload?.trade_id || "").trim();
  if (!tradeId) {
    // Reducing/closing without a trade_id is fundamentally unsafe in
    // trade-aware mirror mode — we can't map this back to a manifest
    // row. Reject unless explicit opt-out is set.
    if (String(env?.BROKER_MANIFEST_ALLOW_UNTAGGED_REDUCERS || "false").toLowerCase() === "true") {
      return { ok: true, skipped: "untagged_reducer_allowed_by_env" };
    }
    return {
      ok: false,
      reject_reason: "reducer_missing_trade_id_for_manifest_lookup",
      lifecycle,
    };
  }

  const userId = String(payload?.user_id || user?.user_id || "").toLowerCase();
  // Use the agnostic account id (incl. webull_account_id) so the reducer
  // lookup matches how writeEntryManifest keyed the row. The old chain
  // dropped Webull to "default" → every Webull reducer missed its manifest.
  const brokerAccountId = String(payload?.broker_account_id || resolveBrokerAccountId(user));

  let row = null;
  try {
    row = await readManifestRow(env, userId, tradeId, brokerAccountId);
  } catch (e) {
    console.warn(`[MANIFEST] reducer-check read failed for ${userId}/${tradeId}:`,
      String(e?.message || e).slice(0, 200));
    // Fail open in shadow / on read error so we don't lock the operator
    // out of the platform if the D1 table is degraded.
    return { ok: true, skipped: "manifest_read_error_fail_open" };
  }

  if (!row) {
    // No manifest = the bridge never opened this trade.
    if (mode === "log") {
      console.warn(`[MANIFEST] would_reject ${payload.side} on ${payload.ticker}/${tradeId}: no_manifest_for_trade`);
      return { ok: true, skipped: "log_mode_no_manifest" };
    }
    return {
      ok: false,
      reject_reason: "no_manifest_for_trade",
      lifecycle,
      details: { trade_id: tradeId, broker_account_id: brokerAccountId },
    };
  }

  // Operator-set suppression always wins.
  if (Number(row.mirror_suppressed) === 1) {
    const reason = String(row.mirror_suppressed_reason || "operator_suppressed").slice(0, 200);
    if (mode === "log") {
      console.warn(`[MANIFEST] would_reject ${payload.side} on ${payload.ticker}/${tradeId}: mirror_suppressed (${reason})`);
      return { ok: true, skipped: "log_mode_suppressed" };
    }
    return {
      ok: false,
      reject_reason: `mirror_suppressed:${reason}`,
      lifecycle,
      manifest_sync_state: row.sync_state,
    };
  }

  const state = String(row.sync_state || "unknown");

  if (lifecycle === "reduce") {
    const PROCEED = new Set(["in_sync", "partial_fill", "broker_orphan"]);
    const REJECT = new Set(["pending", "rejected", "mothership_orphan", "expired", "untracked", "mirror_suppressed", "reconcile_error"]);
    if (PROCEED.has(state)) {
      let scaledQty = null;
      if (state === "partial_fill" && String(env?.BROKER_PARTIAL_FILL_MODE || "scale").toLowerCase() === "scale") {
        const ratio = Number(row.model_intended_qty) > 0
          ? Number(row.broker_filled_qty) / Number(row.model_intended_qty)
          : 1;
        if (ratio > 0 && ratio < 1 && Number(payload?.qty) > 0) {
          scaledQty = Math.max(1, Math.floor(Number(payload.qty) * ratio));
        }
      }
      return {
        ok: true,
        lifecycle,
        manifest_sync_state: state,
        broker_remaining_qty: Number(row.broker_remaining_qty) || null,
        scaled_qty: scaledQty,
      };
    }
    if (REJECT.has(state)) {
      if (mode === "log") {
        console.warn(`[MANIFEST] would_reject ${payload.side} on ${payload.ticker}/${tradeId}: sync_state=${state}`);
        return { ok: true, skipped: `log_mode_state_${state}` };
      }
      return {
        ok: false,
        reject_reason: `reducer_blocked_by_sync_state:${state}`,
        lifecycle, manifest_sync_state: state,
      };
    }
    // Unknown state → fail open (log) so we don't surprise the operator.
    console.warn(`[MANIFEST] unknown sync_state '${state}' for reducer ${payload.ticker}/${tradeId}; failing open`);
    return { ok: true, skipped: `unknown_state_${state}_fail_open`, manifest_sync_state: state };
  }

  if (lifecycle === "close") {
    const PROCEED = new Set(["in_sync", "partial_fill", "broker_orphan", "untracked"]);
    const REJECT = new Set(["pending", "rejected", "mothership_orphan", "expired", "mirror_suppressed", "reconcile_error"]);
    if (PROCEED.has(state)) {
      return {
        ok: true,
        lifecycle,
        manifest_sync_state: state,
        broker_remaining_qty: Number(row.broker_remaining_qty) || null,
      };
    }
    if (REJECT.has(state)) {
      if (mode === "log") {
        console.warn(`[MANIFEST] would_reject ${payload.side} on ${payload.ticker}/${tradeId}: sync_state=${state}`);
        return { ok: true, skipped: `log_mode_state_${state}` };
      }
      return {
        ok: false,
        reject_reason: `closer_blocked_by_sync_state:${state}`,
        lifecycle, manifest_sync_state: state,
      };
    }
    console.warn(`[MANIFEST] unknown sync_state '${state}' for closer ${payload.ticker}/${tradeId}; failing open`);
    return { ok: true, skipped: `unknown_state_${state}_fail_open`, manifest_sync_state: state };
  }

  return { ok: true, lifecycle };
}

/**
 * 2026-07-21 — Ground-truth reducer guard. A SELL/EXIT/TRIM must never exceed
 * (or exist without) the account's actual long position — critical for a cash
 * / IRA account that can't short. Independent of the manifest (which can drift
 * or be in shadow mode): decide purely from live broker positions.
 *
 * @returns {{action:'proceed'|'reject'|'clamp', reason?, heldQty, clampQty?}}
 */
export function evaluateReducerAgainstPositions({ ticker, requestedQty, positions } = {}) {
  const sym = String(ticker || "").toUpperCase();
  const req = Number(requestedQty) || 0;
  const list = Array.isArray(positions) ? positions : [];
  let held = 0;
  let found = false;
  for (const p of list) {
    const psym = String(p?.symbol ?? p?.ticker ?? "").toUpperCase();
    if (!psym || psym !== sym) continue;
    found = true;
    held += Number(p?.qty ?? p?.position ?? p?.quantity ?? 0) || 0;
  }
  // No long position (flat, missing, or short) → never send a sell.
  if (!(held > 0)) {
    return { action: "reject", reason: found ? "position_flat" : "no_broker_position", heldQty: held };
  }
  // Requesting more than held → clamp so we never oversell into a short.
  if (req > 0 && req > held + 1e-9) {
    return { action: "clamp", heldQty: held, clampQty: held };
  }
  return { action: "proceed", heldQty: held };
}

// Pure validator. Does not mutate KV.
export function validateOrderShape(payload, env) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reject_reason: "bad_payload" };
  }
  const requiredKeys = ["user_id", "ticker", "side", "qty"];
  for (const k of requiredKeys) {
    if (payload[k] === undefined || payload[k] === null || payload[k] === "") {
      return { ok: false, reject_reason: `missing_${k}` };
    }
  }
  const ticker = String(payload.ticker || "").trim().toUpperCase();
  if (!ticker || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker)) {
    return { ok: false, reject_reason: `invalid_ticker:${ticker}` };
  }
  const side = String(payload.side || "").trim().toLowerCase();
  // Naked-short equity sides — HARD reject (no env override). The previous
  // REJECT_SHORT_SIDES=false escape hatch is intentionally removed.
  if (SHORT_SIDES.has(side)) {
    return { ok: false, reject_reason: "naked_short_deferred" };
  }
  if (!ALLOWED_LONG_SIDES.has(side)) {
    return { ok: false, reject_reason: `unknown_side:${side}` };
  }
  // Naked-short option vehicles — also hard-rejected. The vehicle field
  // is only populated for option archetypes coming from auto-mirror; an
  // equity order doesn't carry a vehicle, so its absence is fine.
  const vehicle = payload.vehicle ? String(payload.vehicle).trim().toLowerCase() : null;
  if (vehicle && NAKED_SHORT_VEHICLES.has(vehicle)) {
    return { ok: false, reject_reason: `naked_short_vehicle_deferred:${vehicle}` };
  }
  if (vehicle && !RECOGNIZED_VEHICLES.has(vehicle)) {
    return { ok: false, reject_reason: `unknown_vehicle:${vehicle}` };
  }
  const qty = Number(payload.qty);
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reject_reason: `invalid_qty:${payload.qty}` };
  }
  const entry = Number(payload.entry || payload.price_target || 0);
  if (entry > 0) {
    const estValue = entry * qty;
    if (estValue > 1_000_000) {
      return { ok: false, reject_reason: `estimated_value_too_large:${estValue.toFixed(0)}` };
    }
  }
  return { ok: true };
}

// Full preflight — global killswitch, per-user enablement, daily counter,
// per-order $ cap. Side-effects: rolls daily counter if date changed.
export async function preflightOrder(env, payload) {
  const shape = validateOrderShape(payload, env);
  if (!shape.ok) return shape;

  const ks = await getKillSwitch(env);
  if (ks === "on") {
    return { ok: false, reject_reason: "global_kill_switch_on" };
  }

  const userId = String(payload.user_id).toLowerCase();
  const user = await resolveBridgeUser(env, userId);
  if (!user) {
    return { ok: false, reject_reason: "user_not_connected" };
  }
  if (user.status !== "connected") {
    return { ok: false, reject_reason: `user_status_${user.status}` };
  }
  if (!user.broker_integration_enabled) {
    return { ok: false, reject_reason: "broker_integration_disabled_for_user" };
  }

  const caps = resolveUserCaps(env, user);

  // 2026-06-01 — Per-vehicle prefs gate (PR #412 — option archetypes
  // only). Equity orders without a `vehicle` field bypass this and use
  // the global caps below.
  const vehicleCheck = validateVehiclePrefs(payload, user);
  if (!vehicleCheck.ok) return vehicleCheck;

  // 2026-07-21 — Relational position sizing (BOTH modes).
  // The model sizes against its $100k book; a real account (e.g. a Webull
  // Roth IRA ~$16.5k) must deploy the SAME fraction of capital, not the raw
  // model share count. Scale qty by the account/book ratio (or the model's
  // own "% of account" when supplied) BEFORE the per-order / cash /
  // concentration caps below (those remain a safety ceiling). Keeps
  // fractional shares when the broker supports them (Webull); else whole.
  //
  // Applies to ENTRIES / ADDS only — reducers (trim/exit) close what's
  // actually held, so they must not be re-scaled here.
  const relationalOn = String(env?.BROKER_RELATIONAL_SIZING || "true").toLowerCase() !== "false";
  const sizingLifecycle = classifyOrderLifecycle(payload?.side);
  if (relationalOn && (sizingLifecycle === "open" || sizingLifecycle === "add")) {
    const modelBook = Number(payload?.model_capital_usd)
      || Number(env?.MODEL_BOOK_BASE_USD)
      || 100000;
    const liveEquity = Number(user?.equity_usd || user?.portfolio?.equity_usd || user?.buying_power_usd || user?.cash_usd);
    const entryPx = Number(payload?.entry || payload?.price_target || 0);
    const brokerId = resolveBrokerId(user) || user?.broker || null;
    const fractionalCap = !!brokerCapabilities(brokerId, "adapter")?.fractional;
    const fractionalOn = fractionalCap
      && String(env?.BROKER_FRACTIONAL_ENABLED || "true").toLowerCase() !== "false";

    // Fail-safe: never mirror an entry to an account whose size we don't know
    // — that would risk over-allocating a small account (the exact hazard for
    // a Roth IRA). Require a portfolio sync (GET /bridge/portfolio populates
    // equity_usd) first. Disable via BROKER_RELATIONAL_SIZING=false.
    if (!(Number.isFinite(liveEquity) && liveEquity > 0)) {
      return {
        ok: false,
        reject_reason: "account_equity_unknown_sync_required",
        hint: "relational sizing needs account equity — call GET /bridge/portfolio to populate equity_usd, or set BROKER_RELATIONAL_SIZING=false",
      };
    }
    if (liveEquity > 0 && liveEquity < modelBook) {
      const sized = computeRelationalQty({
        modelQty: Number(payload?.qty) || 0,
        entryPrice: entryPx,
        accountEquity: liveEquity,
        modelBookUsd: modelBook,
        modelAccountPct: payload?.model_account_pct ?? null,
        fractional: fractionalOn,
        minNotionalUsd: Number(env?.BROKER_FRACTIONAL_MIN_USD) || 1,
      });
      if (sized.ok && sized.qty < (Number(payload?.qty) || 0)) {
        console.log(`[BRIDGE_SCALE] ${userId}/${payload.ticker} ${payload?.mode || "trader"}: relational qty ${payload.qty}→${sized.qty} (ratio=${sized.ratio.toFixed(3)} = $${liveEquity.toFixed(0)}/$${modelBook.toFixed(0)}, fractional=${sized.fractional_used})`);
        payload.qty = sized.qty;
        payload._sizing = {
          model_qty: sized.model_qty, scaled_qty: sized.qty, ratio: sized.ratio,
          account_equity_usd: liveEquity, model_book_usd: modelBook,
          fractional_used: sized.fractional_used, basis: payload?.model_account_pct != null ? "model_account_pct" : "equity_ratio",
        };
      } else if (!sized.ok && (sized.reason === "account_too_small_for_one_share" || sized.reason === "below_min_notional")) {
        return {
          ok: false,
          reject_reason: `account_too_small_to_mirror_${liveEquity.toFixed(0)}_${sized.reason}`,
          equity_usd: liveEquity,
          model_book_usd: modelBook,
          model_qty: Number(payload?.qty) || 0,
          entry: entryPx,
        };
      }
      // sized.fallback (missing price/equity) → leave payload.qty, caps below apply.
    }
  }

  // 2026-06-01 — Phase B: manifest-aware reducer. For TRIM/EXIT orders,
  // require a matching manifest row in the right sync_state. Cheap
  // (single SELECT, no broker call) and gates BEFORE the portfolio
  // check so we get an early reject on naked closes that the model
  // emitted for a position the bridge never opened. Entries (lifecycle
  // = 'open') skip this check — Phase A's writer creates their row.
  const manifestCheck = await manifestAwareReducerCheck(env, payload, user);
  if (!manifestCheck.ok) return manifestCheck;

  // Per-order $ cap.
  // 2026-06-01 — Scale-to-fit instead of reject. The model sizes against
  // a $100k notional simulator account; real users have whatever equity
  // their broker shows. When the model says "buy 100 shares of DIA"
  // ($48k notional) and the user's per-order cap is $5k, the previous
  // behavior was to REJECT — the user got nothing while the model
  // showed a winning trade. The operator's explicit ask: "mirror the
  // model actions per mode for an account when the account has enabled
  // it and can support the position, of course scaled for it."
  //
  // New behavior: round qty DOWN to fit the cap. Two side-effects to be
  // aware of:
  //   1. The caller's payload.qty is replaced with the scaled value
  //      before review/place so downstream audit + order placement
  //      sees the actual broker qty.
  //   2. `scaled_qty` (already returned for manifest-aware partial
  //      fills) and a new `scaling.original_qty` field surface both
  //      numbers so the operator can audit "model wanted 100 / bridge
  //      sent 10" via the audit log.
  //
  // Only enabled for LONG sides (buy / long / entry / trim / exit / sell).
  // The naked-short guards above already hard-reject short_*. Disable
  // via env BROKER_SCALE_TO_FIT=false if the operator ever needs
  // hard-rejection back for a debugging session.
  let entry = Number(payload.entry || payload.price_target || 0);
  let qty = Number(payload.qty || 0);
  let estValue = entry > 0 ? entry * qty : null;
  let scalingMeta = null;
  if (estValue != null && estValue > caps.max_per_order_usd) {
    const scaleToFit = String(env?.BROKER_SCALE_TO_FIT || "true").toLowerCase() !== "false";
    if (!scaleToFit) {
      return {
        ok: false,
        reject_reason: `order_exceeds_cap_${estValue.toFixed(0)}_gt_${caps.max_per_order_usd}`,
        estimated_value: estValue,
        cap: caps.max_per_order_usd,
      };
    }
    const maxQtyByCap = Math.floor(caps.max_per_order_usd / entry);
    if (maxQtyByCap < 1) {
      // Even one share/contract doesn't fit. Genuinely too large.
      return {
        ok: false,
        reject_reason: `order_too_large_min_unit_${entry.toFixed(2)}_gt_cap_${caps.max_per_order_usd}`,
        estimated_value: estValue,
        cap: caps.max_per_order_usd,
        min_unit_usd: entry,
      };
    }
    scalingMeta = {
      original_qty: qty,
      original_value: estValue,
      scaled_qty: maxQtyByCap,
      reason: "cap_per_order",
      cap_usd: caps.max_per_order_usd,
      scale_ratio: Math.round((maxQtyByCap / qty) * 1000) / 1000,
    };
    qty = maxQtyByCap;
    estValue = entry * qty;
    payload.qty = qty;
    console.log(`[BRIDGE_SCALE] ${payload.user_id || "?"}/${payload.ticker}: scaled qty ${scalingMeta.original_qty}→${qty} (${scalingMeta.original_value.toFixed(0)} > cap ${caps.max_per_order_usd})`);
  }

  // Cash-availability preflight ("can support the position").
  // 2026-06-01 — If the user record carries a fresh cash balance
  // (mirrored from the broker portfolio sync), use it as a hard ceiling
  // BEFORE we hit the broker. Avoids the broker rejecting with
  // "insufficient buying power" 200ms later. Scale-to-fit again here so
  // a user with $200 cash + a cap of $5k still gets 0 shares if entry
  // > $200, but gets the right fractional / floor count if it fits.
  const liveCash = Number(user?.cash_usd || user?.portfolio?.cash_usd);
  if (Number.isFinite(liveCash) && liveCash > 0 && estValue != null && estValue > liveCash) {
    const scaleToFit = String(env?.BROKER_SCALE_TO_FIT || "true").toLowerCase() !== "false";
    if (!scaleToFit) {
      return {
        ok: false,
        reject_reason: `insufficient_cash_${liveCash.toFixed(0)}_lt_${estValue.toFixed(0)}`,
        estimated_value: estValue,
        cash_usd: liveCash,
      };
    }
    // Reserve a 2% buffer for fees / slippage so the broker doesn't
    // reject the place call for a few cents.
    const usableCash = liveCash * 0.98;
    const maxQtyByCash = Math.floor(usableCash / entry);
    if (maxQtyByCash < 1) {
      return {
        ok: false,
        reject_reason: `insufficient_cash_for_one_unit_${liveCash.toFixed(0)}_lt_${entry.toFixed(2)}`,
        cash_usd: liveCash,
        unit_usd: entry,
      };
    }
    const originalQty = scalingMeta?.original_qty ?? qty;
    const originalValue = scalingMeta?.original_value ?? estValue;
    scalingMeta = {
      original_qty: originalQty,
      original_value: originalValue,
      scaled_qty: maxQtyByCash,
      reason: scalingMeta ? `${scalingMeta.reason}+cash_buffer` : "cash_buffer",
      cap_usd: scalingMeta?.cap_usd || null,
      cash_usd: liveCash,
      scale_ratio: Math.round((maxQtyByCash / originalQty) * 1000) / 1000,
    };
    qty = maxQtyByCash;
    estValue = entry * qty;
    payload.qty = qty;
    console.log(`[BRIDGE_SCALE] ${payload.user_id || "?"}/${payload.ticker}: cash-scaled qty ${originalQty}→${qty} (cash $${liveCash.toFixed(0)} vs $${originalValue.toFixed(0)} order)`);
  }

  // Account-concentration cap (max_account_pct). Default 25%.
  // 2026-06-01 — Previously defined in resolveUserCaps but never
  // enforced. Reads live equity (mirrored from broker portfolio sync);
  // skipped silently if equity isn't in the user record. Scale-to-fit
  // applies the same way.
  const liveEquity = Number(user?.equity_usd || user?.portfolio?.equity_usd);
  if (Number.isFinite(liveEquity) && liveEquity > 0 && estValue != null) {
    const maxAccountUsd = liveEquity * Number(caps.max_account_pct);
    if (maxAccountUsd > 0 && estValue > maxAccountUsd) {
      const scaleToFit = String(env?.BROKER_SCALE_TO_FIT || "true").toLowerCase() !== "false";
      if (!scaleToFit) {
        return {
          ok: false,
          reject_reason: `exceeds_account_concentration_${estValue.toFixed(0)}_gt_${maxAccountUsd.toFixed(0)}_${Math.round(caps.max_account_pct * 100)}pct`,
          estimated_value: estValue,
          equity_usd: liveEquity,
          max_account_pct: caps.max_account_pct,
        };
      }
      const maxQtyByConc = Math.floor(maxAccountUsd / entry);
      if (maxQtyByConc < 1) {
        return {
          ok: false,
          reject_reason: `concentration_too_small_for_one_unit_${maxAccountUsd.toFixed(0)}_lt_${entry.toFixed(2)}`,
          equity_usd: liveEquity,
          max_account_pct: caps.max_account_pct,
        };
      }
      const originalQty = scalingMeta?.original_qty ?? qty;
      const originalValue = scalingMeta?.original_value ?? estValue;
      scalingMeta = {
        original_qty: originalQty,
        original_value: originalValue,
        scaled_qty: maxQtyByConc,
        reason: scalingMeta ? `${scalingMeta.reason}+concentration` : "concentration",
        cap_usd: scalingMeta?.cap_usd || null,
        cash_usd: scalingMeta?.cash_usd || null,
        equity_usd: liveEquity,
        max_account_pct: caps.max_account_pct,
        scale_ratio: Math.round((maxQtyByConc / originalQty) * 1000) / 1000,
      };
      qty = maxQtyByConc;
      estValue = entry * qty;
      payload.qty = qty;
      console.log(`[BRIDGE_SCALE] ${payload.user_id || "?"}/${payload.ticker}: concentration-scaled qty ${originalQty}→${qty} (>${Math.round(caps.max_account_pct * 100)}% of $${liveEquity.toFixed(0)} equity)`);
    }
  }

  // Daily order counter (only counts ENTRY/TRIM/EXIT placements, not reviews).
  const today = todayKey();
  if (user.daily_order_count_date !== today) {
    user.daily_order_count = 0;
    user.daily_order_count_date = today;
  }
  if ((user.daily_order_count || 0) >= caps.max_orders_per_day) {
    return {
      ok: false,
      reject_reason: `daily_cap_hit_${user.daily_order_count}_ge_${caps.max_orders_per_day}`,
      daily_order_count: user.daily_order_count,
      cap: caps.max_orders_per_day,
    };
  }

  return {
    ok: true,
    user,
    caps,
    estimated_value: estValue,
    // 2026-06-01 — Phase B: pass through the manifest check's findings
    // so the caller can inspect / log them and (in Phase D's options
    // flow) act on partial-fill scaling.
    manifest_sync_state: manifestCheck.manifest_sync_state || null,
    broker_remaining_qty: manifestCheck.broker_remaining_qty ?? null,
    // Manifest partial-fill scaling OR the new account-fit scaling
    // (cap_per_order / cash_buffer / concentration). Both surface as
    // scaled_qty so the audit log + response body don't double-track.
    scaled_qty: scalingMeta?.scaled_qty ?? manifestCheck.scaled_qty ?? null,
    // 2026-06-01 — Surface scaling details for the audit log + caller
    // (Mission Control, ring buffer, daily digest). null when the
    // model's original qty fit all the caps unchanged.
    scaling: scalingMeta,
  };
}

// Called after a successful PLACE to roll the counter.
export async function bumpDailyCounter(env, userId) {
  const user = await readUser(env, userId);
  if (!user) return false;
  const today = todayKey();
  if (user.daily_order_count_date !== today) {
    user.daily_order_count = 0;
    user.daily_order_count_date = today;
  }
  user.daily_order_count = (user.daily_order_count || 0) + 1;
  user.total_orders_lifetime = (user.total_orders_lifetime || 0) + 1;
  user.last_order_at = Date.now();
  return await writeUser(env, userId, user);
}
