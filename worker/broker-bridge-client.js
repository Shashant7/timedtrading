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
  // 2026-07-21 — Prefer the Service Binding (env.BROKER_BRIDGE) over an HTTP
  // fetch to the bridge's workers.dev URL. A plain worker-to-worker HTTP call
  // trips Cloudflare's subrequest loop detection and comes back as HTTP 404
  // ("error code: 1042") — which is exactly why every entry/exit order forward
  // in the client ring showed http_status:404 and never reached the broker.
  // The operator-side proxies (_callBridge/_postBridge in index.js) were
  // already migrated to the binding for this reason; the order path was not.
  // Falls back to HTTP fetch when the binding is absent (e.g. local dev).
  const svc = env?.BROKER_BRIDGE;
  const hasSvc = !!(svc && typeof svc.fetch === "function");
  if (!hasSvc && !bridgeUrl) return { ok: false, skip: "no_bridge_url" };
  if (!hmacKey)  return { ok: false, skip: "no_hmac_key" };

  const body = JSON.stringify(order);
  const sig = await hmacSign(hmacKey, body).catch(() => null);
  if (!sig) return { ok: false, skip: "sign_failed" };

  const t0 = Date.now();
  const controller = new AbortController();
  // 2026-07-22 — bumped 4s → 15s. Live Webull orders on a real Roth IRA
  // legitimately take ~2.5-3s (token refresh + preview + place), and any
  // rate-limit backoff (Webull's 2 req / 2s throttle in bridge-webull-api.js
  // adds 1.1s min gap between calls) can push past 4s. A premature abort
  // here shows up in the client ring as `status: fetch_error` while the
  // bridge is mid-place — the main worker then re-fires the entry on the
  // next scoring tick with a new trade_id, causing duplicate orders once
  // the Webull side succeeds. 15s is well under the 30s Worker CPU budget
  // and covers OAuth refresh + preview + place with plenty of headroom.
  const tid = setTimeout(() => controller.abort(), 15000);
  const ringEntry = {
    ts: Date.now(),
    user_id: order.user_id,
    ticker: order.ticker,
    side: order.side,
    qty: order.qty,
    trade_id: order.trade_id,
    client_order_id: order.client_order_id || null,
    transport: hasSvc ? "service-binding" : "http",
  };
  try {
    // Service-binding routes by binding name, not host — the URL host is
    // arbitrary. Keep the real URL when we have it (harmless) so HTTP fallback
    // and the binding hit the identical /bridge/order path.
    const _url = `${(bridgeUrl || "https://bridge.internal").replace(/\/$/, "")}/bridge/order`;
    const _reqInit = {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-bridge-signature": sig,
      },
      body,
    };
    const r = hasSvc
      ? await svc.fetch(new Request(_url, _reqInit))
      : await fetch(_url, _reqInit);
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
    return { ok, http_status: r.status, response: parsed, latency_ms: ringEntry.latency_ms, transport: ringEntry.transport };
  } catch (e) {
    ringEntry.status = "fetch_error";
    ringEntry.error = String(e?.message || e).slice(0, 200);
    ringEntry.latency_ms = Date.now() - t0;
    await pushRing(env, ringEntry);
    return { ok: false, error: ringEntry.error, transport: ringEntry.transport };
  } finally {
    clearTimeout(tid);
  }
}
