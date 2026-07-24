// worker/broker-bridge-client.js
//
// 2026-05-29 — Lightweight HMAC-signed webhook client used by the
// main TT ingest worker to fire trade decisions over to the
// `tt-broker-bridge` worker. Fire-and-forget; never blocks the
// decision loop on bridge availability.
//
// Wire in by calling `forwardOrderToBridge(env, order)` from
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

async function recordBridgeFailure(env, { stage, ticker, error, meta } = {}) {
  try {
    const { recordSilentFailure } = await import("./silent-failure-log.js");
    await recordSilentFailure(env, {
      stage: String(stage || "bridge_mirror").slice(0, 100),
      ticker: ticker || null,
      error: error || null,
      meta: meta || null,
    });
  } catch (_) { /* observability must never throw */ }
}

export async function readClientRing(env) {
  const KV = env?.KV_TIMED;
  if (!KV) return [];
  try { return JSON.parse((await KV.get(RING_KEY)) || "[]"); } catch (_) { return []; }
}

/** True when a model fill should be mirrored as equity shares on the bridge. */
export function isEquityMirrorVehicle(vehicle) {
  const v = String(vehicle || "shares").toLowerCase();
  return v === "shares" || v === "equity" || v === "equity_long" || v === "";
}

/**
 * Record an intentional skip (vehicle gating, missing env, etc.) so operators
 * can see why a model fill did NOT hit the broker — without treating it as a
 * hard reject. Writes the client ring + silent-failure breadcrumb.
 */
export async function recordBridgeMirrorSkip(env, {
  ticker,
  side = "buy",
  reason,
  trade_id = null,
  client_order_id = null,
  qty = null,
  meta = null,
} = {}) {
  const ringEntry = {
    ts: Date.now(),
    user_id: env?.ADMIN_EMAIL || "operator",
    ticker: ticker ? String(ticker).toUpperCase() : null,
    side,
    qty,
    trade_id,
    client_order_id,
    transport: "skip",
    status: "skipped",
    skip_reason: String(reason || "skipped").slice(0, 120),
  };
  await pushRing(env, ringEntry);
  await recordBridgeFailure(env, {
    stage: `bridge_mirror.skip.${String(reason || "unknown").slice(0, 40)}`,
    ticker,
    error: reason || "skipped",
    meta: { side, trade_id, client_order_id, qty, ...(meta || {}) },
  });
  return { ok: false, skip: reason || "skipped" };
}

/**
 * Long Term (investor) auto-rebalance / DCA → bridge mirror.
 * Shared by /timed/investor/auto-rebalance and /timed/investor/dca/execute
 * so calendar DCA cannot silently skip the broker path.
 *
 * op = { kind: "open"|"add"|"trim"|"dca", ticker, shares, price, reason,
 *        position_id, score, stage }
 */
export async function forwardInvestorMirror(env, op = {}) {
  const ticker = String(op?.ticker || "").toUpperCase();
  const kind = String(op?.kind || "add");
  const side = kind === "trim" ? "sell" : "buy";
  const tradeId = op?.position_id
    ? `inv-${op.position_id}`
    : `inv-${ticker || "UNK"}-${kind}`;
  const qty = Math.max(0, Number(op?.shares) || 0);
  const investorMirrorOn = String(env?.BROKER_INVESTOR_MIRROR_ENABLED ?? "true").toLowerCase() === "true";
  if (!investorMirrorOn) {
    return recordBridgeMirrorSkip(env, {
      ticker, side, qty, trade_id: tradeId,
      reason: "investor_mirror_disabled",
      meta: { kind, source: op?.source || null },
    });
  }
  const bridgeReady = !!(env?.BROKER_BRIDGE_URL && env?.BROKER_BRIDGE_HMAC_KEY);
  if (!bridgeReady) {
    return recordBridgeMirrorSkip(env, {
      ticker, side, qty, trade_id: tradeId,
      reason: "no_hmac_or_url",
      meta: { kind, source: op?.source || null },
    });
  }
  if (qty <= 0) {
    return recordBridgeMirrorSkip(env, {
      ticker, side, qty, trade_id: tradeId,
      reason: "qty_zero",
      meta: { kind, source: op?.source || null },
    });
  }

  const modelCapital = Number(op?.model_capital_usd) > 0
    ? Number(op.model_capital_usd)
    : 100000;
  const userEmail = env?.ADMIN_EMAIL || "operator";
  const clientOrderId = `tt-lt-${kind}-${tradeId}`;
  try {
    const result = await forwardOrderToBridge(env, {
      user_id: userEmail,
      trade_id: tradeId,
      client_order_id: clientOrderId,
      ticker,
      side,
      qty,
      entry: Number(op?.price) || null,
      sl: null,
      tp: null,
      decision_reason: op?.reason || `long_term_${kind}`,
      action_ts: Date.now(),
      setup_name: `long_term_${op?.stage || kind}`,
      rank: Number(op?.score) || null,
      mode: "investor",
      horizon: "long_term",
      vehicle: "equity_long",
      model_capital_usd: modelCapital,
    });
    return {
      ok: !!result?.ok,
      result,
      trade_id: tradeId,
      side,
      qty,
      bridge_reject_reason: result?.response?.reject_reason || null,
      bridge_scaled_qty: result?.response?.scaling?.scaled_qty ?? null,
      bridge_scale_reason: result?.response?.scaling?.reason || null,
    };
  } catch (e) {
    console.warn(`[INVESTOR_MIRROR] ${ticker}/${kind} threw: ${String(e?.message || e).slice(0, 200)}`);
    return { ok: false, error: String(e?.message || e).slice(0, 200), trade_id: tradeId, side, qty };
  }
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
  // Config skips are quiet here — callers that expect a live bridge should
  // guard on URL+HMAC (or call recordBridgeMirrorSkip). Rejects / fetch
  // errors below are the async-mirror observability surface.
  if (!hasSvc && !bridgeUrl) return { ok: false, skip: "no_bridge_url" };
  if (!hmacKey) return { ok: false, skip: "no_hmac_key" };

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
    mode: order.mode || null,
    vehicle: order.vehicle || null,
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
    if (!ok) {
      await recordBridgeFailure(env, {
        stage: `bridge_mirror.reject.${String(order?.side || "order").slice(0, 20)}`,
        ticker: order?.ticker,
        error: parsed?.reject_reason || `http_${r.status}`,
        meta: {
          side: order?.side,
          trade_id: order?.trade_id,
          client_order_id: order?.client_order_id || null,
          http_status: r.status,
          qty: order?.qty,
          mode: order?.mode || null,
          transport: ringEntry.transport,
        },
      });
    }
    return { ok, http_status: r.status, response: parsed, latency_ms: ringEntry.latency_ms, transport: ringEntry.transport };
  } catch (e) {
    ringEntry.status = "fetch_error";
    ringEntry.error = String(e?.message || e).slice(0, 200);
    ringEntry.latency_ms = Date.now() - t0;
    await pushRing(env, ringEntry);
    await recordBridgeFailure(env, {
      stage: `bridge_mirror.fetch_error.${String(order?.side || "order").slice(0, 20)}`,
      ticker: order?.ticker,
      error: ringEntry.error,
      meta: {
        side: order?.side,
        trade_id: order?.trade_id,
        client_order_id: order?.client_order_id || null,
        transport: ringEntry.transport,
      },
    });
    return { ok: false, error: ringEntry.error, transport: ringEntry.transport };
  } finally {
    clearTimeout(tid);
  }
}
