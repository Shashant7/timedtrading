// worker-bridge/bridge-guards.js
//
// 2026-05-29 — Pre-flight guards for the broker bridge.
// Every incoming order goes through these checks BEFORE we touch
// the actual Robinhood MCP. Fail-closed: any check failing returns
// { ok: false, reject_reason } and the caller logs + refuses.

import { getKillSwitch, readUser, writeUser } from "./bridge-storage.js";

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
 * 2026-06-01 — Per-vehicle prefs gate. Called from preflightOrder after
 * the global guards pass. Reads the user's `options_prefs.vehicles[k]`
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
  const user = await readUser(env, userId);
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

  // 2026-06-01 — Per-vehicle prefs gate (option archetypes only). Equity
  // orders without a `vehicle` field bypass this and use the global caps.
  const vehicleCheck = validateVehiclePrefs(payload, user);
  if (!vehicleCheck.ok) return vehicleCheck;

  // Per-order $ cap.
  const entry = Number(payload.entry || payload.price_target || 0);
  const qty = Number(payload.qty || 0);
  const estValue = entry > 0 ? entry * qty : null;
  if (estValue != null && estValue > caps.max_per_order_usd) {
    return {
      ok: false,
      reject_reason: `order_exceeds_cap_${estValue.toFixed(0)}_gt_${caps.max_per_order_usd}`,
      estimated_value: estValue,
      cap: caps.max_per_order_usd,
    };
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
