// worker/broker-bridge-catchup-exit.js
//
// 2026-07-30 — Re-fire a stuck trader EXIT when the bridge claimed
// client_order_id, cleared review, then died before place (DE
// DE-1785351897700-5d1dzat80). Uses a fresh retry client_order_id so the
// 24h idempotency claim on the original tt-exit-* key cannot block.

import { forwardOrderToBridge } from "./broker-bridge-client.js";

/**
 * @param {object} env
 * @param {{ trade_id: string, dry_run?: boolean, retry_nonce?: string, qty?: number, user_id?: string }} opts
 */
export async function catchupTraderExit(env, opts = {}) {
  const tradeId = String(opts.trade_id || "").trim();
  if (!tradeId) return { ok: false, error: "trade_id_required" };

  const dryRun = opts.dry_run !== false;
  const retryNonce = String(opts.retry_nonce || Date.now().toString(36)).slice(0, 24);

  // Prefer live manifest remaining qty (broker-scaled); fall back to caller qty.
  let manifest = null;
  try {
    const bridgeUrl = env?.BROKER_BRIDGE_URL || "https://bridge.internal";
    const svc = env?.BROKER_BRIDGE;
    const opKey = env?.BROKER_BRIDGE_OPERATOR_KEY;
    const headers = opKey ? { Authorization: `Bearer ${opKey}` } : {};
    const call = async (path) => {
      const url = `${String(bridgeUrl).replace(/\/$/, "")}${path}`;
      const init = { method: "GET", headers };
      const r = svc && typeof svc.fetch === "function"
        ? await svc.fetch(new Request(url, init))
        : await fetch(url, init);
      return r.json().catch(() => null);
    };
    // Prefer exact row when caller supplies user + account; else scan recent.
    if (opts.user_id && opts.broker_account_id) {
      const qs = new URLSearchParams({
        user_id: String(opts.user_id).toLowerCase(),
        trade_id: tradeId,
        broker_account_id: String(opts.broker_account_id),
      });
      const body = await call(`/bridge/manifest/row?${qs}`);
      manifest = body?.row || null;
    }
    if (!manifest) {
      const body = await call("/bridge/manifest?limit=200");
      const rows = Array.isArray(body?.rows) ? body.rows : [];
      manifest = rows.find((row) => String(row?.trade_id) === tradeId) || null;
    }
  } catch (e) {
    return { ok: false, error: `manifest_fetch_failed:${String(e?.message || e).slice(0, 120)}` };
  }

  if (!manifest) return { ok: false, error: "manifest_not_found", trade_id: tradeId };

  const ticker = String(manifest.ticker || "").toUpperCase();
  const remaining = Number(manifest.broker_remaining_qty);
  const filled = Number(manifest.broker_filled_qty);
  const qty = Number(opts.qty) > 0
    ? Number(opts.qty)
    : (remaining > 0 ? remaining : (filled > 0 ? filled : 0));
  if (!(qty > 0)) {
    return {
      ok: false,
      error: "nothing_to_exit",
      trade_id: tradeId,
      ticker,
      broker_remaining_qty: remaining,
      model_status: manifest.model_status,
    };
  }

  const userId = String(opts.user_id || manifest.user_id || env?.ADMIN_EMAIL || "operator").toLowerCase();
  const order = {
    user_id: userId,
    trade_id: tradeId,
    client_order_id: `tt-exit-${tradeId}-retry-${retryNonce}`.slice(0, 64),
    ticker,
    side: "exit",
    qty,
    entry: null,
    sl: null,
    tp: null,
    decision_reason: `catchup_exit:${opts.reason || "operator"}`.slice(0, 160),
    action_ts: Date.now(),
    mode: manifest.mode || "trader",
    horizon: manifest.mode === "investor" ? "long_term" : "short_term",
    vehicle: "equity_long",
    broker_account_id: manifest.broker_account_id || null,
  };

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      planned: order,
      manifest: {
        model_status: manifest.model_status,
        broker_remaining_qty: remaining,
        sync_state: manifest.sync_state,
      },
    };
  }

  const result = await forwardOrderToBridge(env, order);
  return {
    ok: !!result?.ok,
    dry_run: false,
    order,
    bridge: result,
    manifest: {
      model_status: manifest.model_status,
      broker_remaining_qty: remaining,
      sync_state: manifest.sync_state,
    },
  };
}
