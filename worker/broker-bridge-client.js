// worker/broker-bridge-client.js
//
// 2026-05-29 — Lightweight HMAC-signed webhook client used by the
// main TT ingest worker to fire trade decisions over to the
// `tt-broker-bridge` worker. Fire-and-forget; never blocks the
// decision loop on bridge availability.
//
// Wire in by calling `forwardOrderToBridge(env, ctx, order)` from
// the spot in processTradeSimulation where ENTRY / TRIM / EXIT
// is finalized. The bridge URL + HMAC key are env vars set per-
// deployment.

async function hmacSign(key, payload) {
  const hk = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", hk, new TextEncoder().encode(String(payload)));
  const arr = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

// 2026-05-29 — A short ring buffer keeps the last 50 dispatches in KV
// (`bridge:client:recent`) for operator visibility from the main UI.
const RING_KEY = "bridge:client:recent";
const RING_MAX = 50;

async function pushRing(env, entry) {
  const KV = env?.KV_TIMED;
  if (!KV) return;
  try {
    const raw = await KV.get(RING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    if (list.length > RING_MAX) list.length = RING_MAX;
    await KV.put(RING_KEY, JSON.stringify(list), { expirationTtl: 30 * 86400 });
  } catch (_) { /* best-effort */ }
}

export async function readClientRing(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return [];
  try { return JSON.parse((await KV.get(RING_KEY)) || "[]"); } catch (_) { return []; }
}

// Fire-and-forget dispatch. Caller should wrap in ctx.waitUntil().
export async function forwardOrderToBridge(env, order) {
  const bridgeUrl = env?.BROKER_BRIDGE_URL;
  const hmacKey  = env?.BROKER_BRIDGE_HMAC_KEY;
  if (!bridgeUrl) return { ok: false, skip: "no_bridge_url" };
  if (!hmacKey)  return { ok: false, skip: "no_hmac_key" };

  const body = JSON.stringify(order);
  const sig = await hmacSign(hmacKey, body).catch(() => null);
  if (!sig) return { ok: false, skip: "sign_failed" };

  const t0 = Date.now();
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 4000);
  const ringEntry = {
    ts: Date.now(),
    user_id: order.user_id,
    ticker: order.ticker,
    side: order.side,
    qty: order.qty,
    trade_id: order.trade_id,
    client_order_id: order.client_order_id || null,
  };
  try {
    const r = await fetch(`${bridgeUrl.replace(/\/$/, "")}/bridge/order`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-bridge-signature": sig,
      },
      body,
    });
    const text = await r.text().catch(() => "");
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}
    const ok = r.ok && parsed?.ok !== false;
    ringEntry.status = ok ? "ok" : "error";
    ringEntry.http_status = r.status;
    ringEntry.rh_order_id = parsed?.rh_order_id || null;
    ringEntry.reject_reason = parsed?.reject_reason || null;
    ringEntry.latency_ms = Date.now() - t0;
    await pushRing(env, ringEntry);
    return { ok, http_status: r.status, response: parsed, latency_ms: ringEntry.latency_ms };
  } catch (e) {
    ringEntry.status = "fetch_error";
    ringEntry.error = String(e?.message || e).slice(0, 200);
    ringEntry.latency_ms = Date.now() - t0;
    await pushRing(env, ringEntry);
    return { ok: false, error: ringEntry.error };
  } finally {
    clearTimeout(tid);
  }
}
