// worker-bridge/bridge-guards.js
//
// 2026-05-29 — Pre-flight guards for the broker bridge.
// Every incoming order goes through these checks BEFORE we touch
// the actual Robinhood MCP. Fail-closed: any check failing returns
// { ok: false, reject_reason } and the caller logs + refuses.

import { getKillSwitch, readUser, writeUser } from "./bridge-storage.js";

const SHORT_SIDES = new Set(["short", "sell_short", "sellshort"]);
const ALLOWED_LONG_SIDES = new Set(["buy", "long", "entry", "trim", "exit", "sell"]);

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
  if (SHORT_SIDES.has(side) && String(env?.REJECT_SHORT_SIDES).toLowerCase() !== "false") {
    return { ok: false, reject_reason: "short_not_supported_by_robinhood" };
  }
  if (!ALLOWED_LONG_SIDES.has(side) && !SHORT_SIDES.has(side)) {
    return { ok: false, reject_reason: `unknown_side:${side}` };
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
