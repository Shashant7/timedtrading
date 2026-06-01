// worker-bridge/bridge-guards.js
//
// 2026-05-29 — Pre-flight guards for the broker bridge.
// Every incoming order goes through these checks BEFORE we touch
// the actual Robinhood MCP. Fail-closed: any check failing returns
// { ok: false, reject_reason } and the caller logs + refuses.

import { getKillSwitch, readUser, writeUser } from "./bridge-storage.js";

const SHORT_SIDES = new Set(["short", "sell_short", "sellshort"]);
const ALLOWED_LONG_SIDES = new Set(["buy", "long", "entry", "trim", "exit", "sell"]);

// 2026-06-01 — Sides that REDUCE an existing position (trim, exit,
// close, sell, sell_short). Any of these requires the user's
// broker account to actually hold the named ticker BEFORE we
// accept the order — otherwise we'd accidentally open a naked
// short for a model-only position that never made it to the real
// account (e.g. blocked by daily cap, $-cap, kill switch, or
// auto-mirror disabled at entry time).
const REDUCING_SIDES = new Set(["trim", "exit", "sell", "close", "sell_short", "sellshort", "short"]);
// Sides that OPEN or ADD to a long position.
const ADDING_SIDES = new Set(["buy", "long", "entry"]);

// Normalize broker-specific position shapes into a single
// { ticker, qty, avgCost } object. Different brokers return
// different field names — try every shape we've seen.
function _normalizePosition(p) {
  if (!p || typeof p !== "object") return null;
  const ticker = String(
    p.contractDesc ?? p.symbol ?? p.ticker ?? p.instrument_symbol ?? p.conid ?? ""
  ).toUpperCase();
  const qty = Number(
    p.position ?? p.qty ?? p.quantity ?? p.size ?? 0
  );
  const avgCost = Number(
    p.avgCost ?? p.avg_cost ?? p.avgPrice ?? p.avg_price ?? p.average_buy_price ?? 0
  );
  if (!ticker || !Number.isFinite(qty)) return null;
  return { ticker, qty, avgCost };
}

// Find the user's current position for a ticker via the broker
// adapter. Returns the normalized position or null. Catches
// errors so a flaky broker API doesn't lock the user out — but
// the caller decides how to handle null vs error (default:
// fail-closed for reducing orders, fail-open for adding orders).
async function _lookupUserPosition(env, brokerAdapter, user, ticker) {
  if (!brokerAdapter || typeof brokerAdapter.getEquityPositions !== "function") {
    return { ok: false, reason: "broker_no_positions_method" };
  }
  try {
    const resp = await brokerAdapter.getEquityPositions(env, user);
    // Adapter may return { ok, positions: [...] } OR { positions: [...] }
    // OR a raw array. Normalize.
    const list = Array.isArray(resp?.positions) ? resp.positions
               : Array.isArray(resp) ? resp
               : Array.isArray(resp?.response) ? resp.response
               : [];
    const upper = String(ticker || "").toUpperCase();
    for (const raw of list) {
      const norm = _normalizePosition(raw);
      if (norm && norm.ticker === upper) {
        return { ok: true, position: norm };
      }
    }
    return { ok: true, position: null };
  } catch (e) {
    return { ok: false, reason: `position_lookup_threw: ${String(e?.message || e).slice(0, 100)}` };
  }
}

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
// per-order $ cap, AND portfolio awareness. Side-effects: rolls daily
// counter if date changed.
//
// 2026-06-01 — `brokerAdapter` parameter added so the portfolio
// check can call adapter.getEquityPositions. Call site:
// `preflightOrder(env, payload, brokerAdapterFor(user))`. Backward-
// compatible: if brokerAdapter is omitted, the portfolio check is
// SKIPPED with a warning in the response (callers should always
// pass it for real orders — only test scripts may omit).
export async function preflightOrder(env, payload, brokerAdapter = null) {
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
  const side = String(payload.side || "").toLowerCase();
  const ticker = String(payload.ticker || "").toUpperCase();
  const qty = Number(payload.qty || 0);

  // 2026-06-01 — PORTFOLIO AWARENESS (lock-tight guard).
  //
  // If the order REDUCES a position (sell/trim/exit/close/sell_short),
  // the user's broker account MUST already hold that ticker with
  // sufficient quantity. Otherwise the bridge would accidentally
  // open a naked short for a position the model thinks exists but
  // never actually made it onto the real account (e.g. blocked by
  // daily cap on entry day, $-cap, kill switch, or auto-mirror
  // disabled at entry time).
  //
  // Modes (via BROKER_POSITION_CHECK_MODE env var):
  //   "reject"  (default) — reject any reducing order with no/under
  //                         position. Safest.
  //   "cap"               — for under-position case, cap qty to the
  //                         actual held qty and proceed.
  //                         For no-position case, still reject.
  //   "off"               — bypass the check (escape hatch for ops).
  //
  // If the broker position lookup ITSELF fails (network error,
  // broker API down), we FAIL CLOSED on reducing orders — refusing
  // to place a sell is far safer than placing one against unknown
  // portfolio state.
  if (REDUCING_SIDES.has(side)) {
    const mode = String(env?.BROKER_POSITION_CHECK_MODE || "reject").toLowerCase();
    if (mode !== "off") {
      if (!brokerAdapter) {
        return {
          ok: false,
          reject_reason: "no_broker_adapter_for_portfolio_check_FAIL_CLOSED",
        };
      }
      const lookup = await _lookupUserPosition(env, brokerAdapter, user, ticker);
      if (!lookup.ok) {
        // Broker position API failed. Fail-closed for reducing orders.
        return {
          ok: false,
          reject_reason: `position_lookup_failed_FAIL_CLOSED:${lookup.reason}`,
        };
      }
      const pos = lookup.position;
      const heldQty = pos ? Math.abs(Number(pos.qty) || 0) : 0;
      if (heldQty === 0) {
        return {
          ok: false,
          reject_reason: `no_open_position_for_${side}_on_${ticker}_would_be_naked_short`,
          held_qty: 0,
          requested_qty: qty,
        };
      }
      if (qty > heldQty) {
        if (mode === "cap") {
          // Cap to held quantity and continue.
          payload.qty = heldQty;
          payload._capped_from_qty = qty;
          payload._capped_to_qty = heldQty;
        } else {
          return {
            ok: false,
            reject_reason: `${side}_qty_${qty}_exceeds_held_qty_${heldQty}_on_${ticker}`,
            held_qty: heldQty,
            requested_qty: qty,
            avg_cost: pos.avgCost || null,
          };
        }
      }
    }
  }

  // 2026-06-01 — ADDING orders: refuse if user is already at-or-past
  // max_account_pct on this ticker (prevents pyramiding into a
  // single-name concentration risk beyond what the operator allowed).
  // Best-effort — if the broker position lookup fails for an ADD,
  // we fail-OPEN (the per-order $ cap still applies; user-level
  // daily cap still applies).
  if (ADDING_SIDES.has(side) && brokerAdapter) {
    const lookup = await _lookupUserPosition(env, brokerAdapter, user, ticker).catch(() => null);
    if (lookup?.ok && lookup.position) {
      const heldValue = (lookup.position.avgCost || 0) * Math.abs(lookup.position.qty || 0);
      const accountEquity = Number(env?.BROKER_ASSUMED_EQUITY_USD) || null;
      // We don't have account equity inline here — defer to per-
      // order $ cap. The max_account_pct enforcement happens at
      // /portfolio refresh time on the bridge endpoint where
      // equity is known. Stamp a hint into the payload so the
      // operator's audit log shows we considered it.
      payload._existing_position_value_usd = heldValue;
    }
  }

  // Per-order $ cap.
  const entry = Number(payload.entry || payload.price_target || 0);
  const effectiveQty = Number(payload.qty || 0); // may have been capped above
  const estValue = entry > 0 ? entry * effectiveQty : null;
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
