// worker-bridge/bridge-fills.js
//
// 2026-07-20 — Fill reconciliation.
//
// Broker order APIs are pull-based (no push webhooks), so "fills back into the
// ledger" = poll each account's recent orders, detect real fills, and record
// them to the per-account ledger (broker truth: submitted → filled qty/price).
// Also drives OCO: when one protective child (SL or TP) fills, cancel the
// sibling so the reduced position isn't double-protected.
//
// Pure normalizers are unit-tested; reconcileAccountFills does the I/O and is
// tested with stubs. Idempotent via a KV seen-marker so a fill is recorded once.

import { recordAccountFill } from "./bridge-account-ledger.js";
import { resolveBrokerAccountId, resolveBrokerId } from "./bridge-brokers.js";

/** Map any broker's order status string to a canonical state. */
export function normalizeOrderStatus(s) {
  const v = String(s || "").toUpperCase().replace(/[\s-]/g, "_");
  if (["FILLED", "COMPLETE", "COMPLETED", "EXECUTED"].includes(v)) return "filled";
  if (["PARTIAL_FILLED", "PARTIALLY_FILLED", "PARTIAL"].includes(v)) return "partial";
  if (["CANCELLED", "CANCELED", "CANCEL"].includes(v)) return "cancelled";
  if (["REJECTED", "FAILED", "EXPIRED"].includes(v)) return "rejected";
  if (["WORKING", "SUBMITTED", "PENDING", "QUEUED", "OPEN", "ACCEPTED", "PRESUBMITTED"].includes(v)) return "working";
  return "unknown";
}

/** Normalize a broker order row to a common shape for reconciliation. */
export function normalizeBrokerOrder(broker, raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const clientOrderId = raw.client_order_id ?? raw.clientOrderId ?? raw.cOID ?? raw.coid ?? null;
  const brokerOrderId = raw.order_id ?? raw.orderId ?? raw.id ?? null;
  const status = normalizeOrderStatus(raw.status ?? raw.order_status ?? raw.orderStatus);
  const filledQty = num(raw.filled_quantity ?? raw.filledQuantity ?? raw.filled_qty ?? raw.cumulative_quantity ?? raw.cumQty);
  const avgPrice = num(raw.avg_fill_price ?? raw.avgPrice ?? raw.avg_price ?? raw.average_price);
  const totalQty = num(raw.quantity ?? raw.total_quantity ?? raw.qty);
  const remainingQty = num(raw.remaining_quantity ?? raw.remainingQuantity)
    ?? (totalQty != null && filledQty != null ? Math.max(0, totalQty - filledQty) : null);
  return {
    broker: String(broker || "").toLowerCase(),
    client_order_id: clientOrderId ? String(clientOrderId) : null,
    broker_order_id: brokerOrderId ? String(brokerOrderId) : null,
    status,
    filled_qty: filledQty,
    avg_price: avgPrice,
    remaining_qty: remainingQty,
    ticker: String(raw.symbol ?? raw.ticker ?? "").toUpperCase() || null,
    side: raw.side ? String(raw.side).toLowerCase() : null,
    order_type: raw.order_type ?? raw.orderType ?? null,
  };
}

/** Pull the orders array out of an adapter listOrders() response. */
export function extractOrders(res) {
  if (!res) return [];
  if (Array.isArray(res.orders)) return res.orders;
  const r = res.response ?? res;
  if (Array.isArray(r)) return r;
  if (Array.isArray(r?.orders)) return r.orders;
  if (Array.isArray(r?.data)) return r.data;
  return [];
}

/** OCO convention: children are `<base>-sl` / `<base>-tp`. Return the sibling id. */
export function ocoSiblingClientOrderId(clientOrderId) {
  const id = String(clientOrderId || "");
  if (id.endsWith("-sl")) return `${id.slice(0, -3)}-tp`;
  if (id.endsWith("-tp")) return `${id.slice(0, -3)}-sl`;
  return null;
}

/**
 * Reconcile fills for one account: record newly-filled orders to the ledger
 * and cancel OCO siblings. Idempotent via KV seen-markers.
 *
 * @returns {object} stats { scanned, recorded, oco_cancelled }
 */
export async function reconcileAccountFills(env, user, adapter, opts = {}) {
  const stats = { scanned: 0, recorded: 0, oco_cancelled: 0 };
  if (typeof adapter?.listOrders !== "function") return { ...stats, skip: "adapter_no_listOrders" };

  const brokerId = resolveBrokerId(user) || user?.broker || null;
  const accountId = resolveBrokerAccountId(user);
  const KV = env?.BRIDGE_KV;

  let listRes;
  try {
    listRes = await adapter.listOrders(env, user, { limit: opts.limit || 50 });
  } catch (e) {
    return { ...stats, error: String(e?.message || e).slice(0, 160) };
  }
  const orders = extractOrders(listRes);
  stats.scanned = orders.length;

  for (const raw of orders) {
    const o = normalizeBrokerOrder(brokerId, raw);
    if (!o || (o.status !== "filled" && o.status !== "partial")) continue;
    if (!(o.filled_qty > 0)) continue;

    // Idempotency: record each (order, status, filled_qty) once.
    const seenKey = `bridge:fill:seen:${accountId}:${o.client_order_id || o.broker_order_id}:${o.status}:${o.filled_qty}`;
    if (KV) {
      try {
        if (await KV.get(seenKey)) continue;
      } catch (_) { /* fall through — better to double-check than miss a fill */ }
    }

    await recordAccountFill(env, {
      ts: Date.now(),
      owner_id: user?.owner_email || user?.user_id || null,
      user_id: user?.user_id || null,
      broker: brokerId,
      broker_account_id: accountId,
      client_order_id: o.client_order_id,
      broker_order_id: o.broker_order_id,
      ticker: o.ticker,
      side: o.side,
      event_type: o.status === "filled" ? "FILL" : "PARTIAL_FILL",
      order_type: o.order_type,
      qty: o.filled_qty,
      price: o.avg_price || 0,
      status: o.status,
      meta: { remaining_qty: o.remaining_qty, source: "fill_reconcile" },
    });
    stats.recorded++;
    if (KV) {
      try { await KV.put(seenKey, "1", { expirationTtl: 7 * 86400 }); } catch (_) {}
    }

    // OCO: a filled protective child cancels its sibling.
    if (o.status === "filled") {
      const siblingId = ocoSiblingClientOrderId(o.client_order_id);
      if (siblingId && typeof adapter.cancelOrder === "function") {
        try {
          await adapter.cancelOrder(env, user, siblingId);
          stats.oco_cancelled++;
          await recordAccountFill(env, {
            ts: Date.now(),
            owner_id: user?.owner_email || user?.user_id || null,
            user_id: user?.user_id || null,
            broker: brokerId,
            broker_account_id: accountId,
            client_order_id: siblingId,
            ticker: o.ticker,
            event_type: "OCO_CANCEL",
            status: "cancelled",
            meta: { cancelled_because_sibling_filled: o.client_order_id },
          });
        } catch (e) {
          console.warn(`[FILLS] OCO sibling cancel failed for ${siblingId}:`, String(e?.message || e).slice(0, 120));
        }
      }
    }
  }

  return stats;
}
