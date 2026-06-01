// worker-bridge/bridge-oco.js
//
// 2026-06-01 — Phase D OCO (One-Cancels-Other) order lifecycle for the
// broker mirror. Per §2.1 (Trader · Shares flow) of the design doc.
//
// When a TRIM fires on a trade that has model-managed SL/TP orders at
// the broker, those existing OCO orders must be CANCELED first
// (otherwise the broker rejects the trim — qty is "locked up" by the
// open stop/limit orders), then re-placed for the reduced position
// after the trim fills.
//
// This module is the orchestration layer. The actual cancel + place
// calls go through the broker adapter (IBKR / Robinhood). For now we
// expose a single helper `orchestrateOcoForReducer()` that returns
// a plan the caller (bridge order handler) can execute against the
// adapter. Keeping the orchestration adapter-agnostic means we can
// add IBKR-specific batch-cancel later without churning the call site.
//
// Behavior is gated by env BROKER_OCO_ENABLED (default 'false'). When
// off, the helper returns { skipped: 'oco_disabled' } so the existing
// order flow is unchanged. The operator opts in once they're ready to
// have the bridge manage SL/TP placement.

import { readManifestRow } from "./bridge-manifest.js";

/**
 * Plan the OCO cancel-then-replace needed for a reducer (TRIM/EXIT).
 *
 * @param {object} env
 * @param {object} payload  Order payload (must have user_id, trade_id, side, qty)
 * @param {object} user     User record
 * @returns {Promise<object>} One of:
 *   { skipped: <reason> }
 *   { ok: true, actions: [{ type: 'cancel_oco', order_id: <id> }, ...],
 *     post_reducer_actions: [{ type: 'replace_sl', strike, qty }, ...] }
 *   { ok: false, error: <reason> }
 *
 * Caller pattern (in bridge-index.js handleOrderWebhook):
 *   1. preflight passes (Phase B accepted the reducer)
 *   2. plan = orchestrateOcoForReducer(env, payload, user)
 *   3. for action in plan.actions: adapter.cancelOrder(action.order_id)
 *   4. place the reducer order
 *   5. for action in plan.post_reducer_actions:
 *        adapter.placeStopOrder({ ... })
 *   6. update manifest broker_sl_order_id / broker_tp_order_ids
 *
 * Steps 3 + 5 are not implemented in this PR (adapter-specific). This
 * PR ships the planning layer + manifest plumbing only. The full
 * cancel→trim→replace dispatch lands in Phase E along with the user
 * notification ladder.
 */
export async function orchestrateOcoForReducer(env, payload, user) {
  const enabled = String(env?.BROKER_OCO_ENABLED || "false").toLowerCase() === "true";
  if (!enabled) return { skipped: "oco_disabled" };

  const side = String(payload?.side || "").toLowerCase();
  if (side !== "trim" && side !== "exit" && side !== "sell" && side !== "close") {
    return { skipped: `oco_not_applicable_for_side:${side}` };
  }
  const tradeId = String(payload?.trade_id || "").trim();
  if (!tradeId) return { skipped: "no_trade_id_for_oco_lookup" };

  const userId = String(payload?.user_id || user?.user_id || "").toLowerCase();
  const brokerAccountId = String(
    user?.rh_account_number
      ?? user?.account_id
      ?? user?.ibkr_account_id
      ?? user?.broker_account_id
      ?? "default"
  );

  let row = null;
  try {
    row = await readManifestRow(env, userId, tradeId, brokerAccountId);
  } catch (e) {
    return { ok: false, error: `manifest_read_error:${String(e?.message || e).slice(0, 100)}` };
  }
  if (!row) return { skipped: "no_manifest_row_for_trade" };

  const actions = [];
  const postReducerActions = [];

  // Cancel the SL OCO order if present.
  if (row.broker_sl_order_id) {
    actions.push({ type: "cancel_oco", role: "stop_loss", order_id: row.broker_sl_order_id });
  }
  // Cancel any TP OCO orders.
  const tpOrders = (() => {
    if (!row.broker_tp_order_ids) return [];
    if (typeof row.broker_tp_order_ids === "object" && !Array.isArray(row.broker_tp_order_ids)) {
      return Object.entries(row.broker_tp_order_ids).map(([tier, order_id]) => ({ tier, order_id }));
    }
    return [];
  })();
  for (const tp of tpOrders) {
    if (tp.order_id) actions.push({ type: "cancel_oco", role: `take_profit_${tp.tier}`, order_id: tp.order_id });
  }

  // Plan the post-reducer replacements. For TRIM we re-place SL for the
  // REDUCED qty; for EXIT (full close) we don't re-place anything (the
  // position will be flat).
  const isFullExit = side === "exit" || side === "close";
  if (!isFullExit) {
    // qty after this trim
    const currentQty = Number(row.broker_remaining_qty) || Number(row.model_intended_qty) || 0;
    const trimQty = Number(payload.qty) || 0;
    const remainingQty = Math.max(0, currentQty - trimQty);
    if (remainingQty > 0 && row.broker_sl_order_id) {
      // SL price comes from the original payload or could be looked up
      // from the model; for now we'll let the caller resolve from the
      // payload (Phase E adds the model-side SL lookup).
      const slPrice = Number(payload.sl) || null;
      postReducerActions.push({
        type: "replace_sl",
        qty: remainingQty,
        stop_price: slPrice,
        original_order_id: row.broker_sl_order_id,
      });
    }
  }

  return {
    ok: true,
    actions,
    post_reducer_actions: postReducerActions,
    manifest: {
      sl_order_id: row.broker_sl_order_id || null,
      tp_order_ids: tpOrders,
      remaining_qty: row.broker_remaining_qty,
    },
  };
}
