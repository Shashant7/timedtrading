// worker-bridge/bridge-index.js
//
// 2026-05-29 — tt-broker-bridge entry point. Separate Cloudflare Worker
// from the main TT ingest worker. See tasks/2026-05-29-broker-bridge-
// phase1-plan.md for the full design + security model.
//
// Routes:
//   GET  /bridge/health                  — readiness check
//   POST /bridge/order                   — inbound order from TT main worker
//   POST /bridge/oauth/start             — initiate per-user RH OAuth
//   GET  /bridge/oauth/callback          — RH OAuth redirect lands here
//   POST /bridge/oauth/disconnect        — operator revokes a user's link
//   GET  /bridge/status                  — operator dashboard payload
//   GET  /bridge/status/user?user_id=X   — single user detail
//   GET  /bridge/audit                   — recent audit log entries
//   POST /bridge/killswitch              — flip global kill switch
//   POST /bridge/enable                  — operator flips per-user enable
//   POST /bridge/test/rh-call            — manual MCP probe
//
// Auth:
//   /bridge/order            — HMAC-SHA256 signature header (BRIDGE_INTERNAL_HMAC_KEY)
//   /bridge/oauth/callback   — public (RH redirects here)
//   everything else          — Bearer with BRIDGE_OPERATOR_KEY (a CF secret)

import { hmacVerify } from "./bridge-crypto.js";
import {
  ensureBridgeSchema, readUser, writeUser, listConnectedUsers,
  getKillSwitch, setKillSwitch, writeAudit, recentAudit,
} from "./bridge-storage.js";
import { preflightOrder, bumpDailyCounter } from "./bridge-guards.js";
import { reviewOrder, placeOrder, callMcpTool, getPortfolio } from "./bridge-robinhood.js";
import {
  handleOauthStart, handleOauthCallback, handleOauthDisconnect,
} from "./bridge-auth.js";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,authorization,x-bridge-signature",
    "Access-Control-Max-Age": "600",
  };
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(), ...extra },
  });
}

function requireOperator(env, req) {
  const expected = env?.BRIDGE_OPERATOR_KEY;
  if (!expected) return json({ ok: false, error: "operator_key_not_configured" }, 503);
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (got !== expected) return json({ ok: false, error: "unauthorized" }, 401);
  return null;
}

async function requireWebhookSignature(env, req, rawBody) {
  const sig = req.headers.get("x-bridge-signature") || "";
  if (!sig) return json({ ok: false, error: "missing_signature" }, 401);
  const ok = await hmacVerify(env, rawBody, sig);
  if (!ok) return json({ ok: false, error: "invalid_signature" }, 401);
  return null;
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    await ensureBridgeSchema(env).catch(() => {});
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // ── Public health ────────────────────────────────────────
      if (method === "GET" && path === "/bridge/health") {
        const ks = await getKillSwitch(env);
        return json({
          ok: true,
          service: "tt-broker-bridge",
          env: env?.BRIDGE_ENV || "unknown",
          mock_mode: String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false",
          kill_switch: ks,
          ts: Date.now(),
        });
      }

      // ── Public OAuth callback (RH redirects here) ────────────
      if (method === "GET" && path === "/bridge/oauth/callback") {
        const result = await handleOauthCallback(env, req);
        // Render a tiny HTML page so the user sees something useful.
        const status = result.status || (result.ok ? 200 : 400);
        const heading = result.ok ? "✓ Robinhood Connected" : "Connection Failed";
        const detail = result.ok
          ? `Account: ${result.rh_account_number || "(pending)"}. Live trading is disabled until the operator enables it.`
          : `Error: ${result.error || "unknown"}`;
        const html = `<!doctype html><html><body style="font-family:system-ui;max-width:560px;margin:64px auto;padding:24px;background:#0e1014;color:#eaecf0">
<h1 style="margin-top:0">${heading}</h1>
<p>${detail}</p>
<p style="opacity:0.6;font-size:13px">You can close this tab.</p>
</body></html>`;
        return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() } });
      }

      // ── Authenticated operator endpoints ─────────────────────
      const operatorFail = requireOperator(env, req);

      if (method === "POST" && path === "/bridge/oauth/start") {
        if (operatorFail) return operatorFail;
        const result = await handleOauthStart(env, req);
        return json(result, result.status || 200);
      }
      if (method === "POST" && path === "/bridge/oauth/disconnect") {
        if (operatorFail) return operatorFail;
        const result = await handleOauthDisconnect(env, req);
        return json(result, result.status || 200);
      }

      if (method === "GET" && path === "/bridge/status") {
        if (operatorFail) return operatorFail;
        const users = await listConnectedUsers(env);
        const ks = await getKillSwitch(env);
        return json({
          ok: true,
          mock_mode: String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false",
          kill_switch: ks,
          users: users.map(_redactUserForList),
          users_count: users.length,
          ts: Date.now(),
        });
      }
      if (method === "GET" && path === "/bridge/status/user") {
        if (operatorFail) return operatorFail;
        const userId = url.searchParams.get("user_id");
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "not_found" }, 404);
        return json({ ok: true, user: _redactUser(user) });
      }
      if (method === "GET" && path === "/bridge/audit") {
        if (operatorFail) return operatorFail;
        const rows = await recentAudit(env, {
          user_id: url.searchParams.get("user_id"),
          limit: Number(url.searchParams.get("limit")) || 50,
        });
        return json({ ok: true, count: rows.length, rows });
      }

      if (method === "POST" && path === "/bridge/killswitch") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const state = String(body?.state || "").toLowerCase();
        if (state !== "on" && state !== "off") {
          return json({ ok: false, error: "state_must_be_on_or_off" }, 400);
        }
        await setKillSwitch(env, state);
        return json({ ok: true, kill_switch: state });
      }

      if (method === "POST" && path === "/bridge/enable") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const userId = String(body?.user_id || "").trim().toLowerCase();
        const enable = body?.enable === true;
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);
        if (user.status !== "connected") {
          return json({ ok: false, error: `user_status_${user.status}_must_be_connected` }, 400);
        }
        user.broker_integration_enabled = enable;
        user.enable_changed_at = Date.now();
        await writeUser(env, userId, user);
        return json({ ok: true, user_id: userId, broker_integration_enabled: enable });
      }

      if (method === "POST" && path === "/bridge/test/rh-call") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const userId = String(body?.user_id || "").trim().toLowerCase();
        const tool = String(body?.tool || "get_accounts").trim();
        const args = body?.args || {};
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);
        const result = await callMcpTool(env, user, tool, args);
        return json({ ok: true, tool, ...result });
      }

      // ── Webhook (HMAC-authenticated) ─────────────────────────
      if (method === "POST" && path === "/bridge/order") {
        const rawBody = await req.text();
        const sigFail = await requireWebhookSignature(env, req, rawBody);
        if (sigFail) return sigFail;
        let payload;
        try { payload = JSON.parse(rawBody); } catch (_) { return json({ ok: false, error: "bad_json" }, 400); }
        return await handleOrderWebhook(env, ctx, payload);
      }

      return json({ ok: false, error: "not_found", path }, 404);
    } catch (e) {
      console.error("[BRIDGE] uncaught:", String(e?.message || e).slice(0, 500));
      return json({ ok: false, error: "internal_error", detail: String(e?.message || e).slice(0, 200) }, 500);
    }
  },
};

// ───────────────────────────────────────────────────────────────────
// Order webhook handler — the meat of the bridge.
//
// Flow:
//   1. preflightOrder — kill switch, enablement, $ cap, daily cap
//   2. audit: order_in
//   3. reviewOrder via MCP — dry-run with RH
//   4. if review warnings → audit: rejected, return
//   5. placeOrder via MCP
//   6. bumpDailyCounter
//   7. audit: place
// ───────────────────────────────────────────────────────────────────
async function handleOrderWebhook(env, ctx, payload) {
  const t0 = Date.now();
  const sanitized = {
    user_id: String(payload?.user_id || "").toLowerCase(),
    trade_id: payload?.trade_id || null,
    ticker: String(payload?.ticker || "").toUpperCase(),
    side: String(payload?.side || "").toLowerCase(),
    qty: Number(payload?.qty || 0),
    entry: Number(payload?.entry || 0) || null,
    sl: payload?.sl == null ? null : Number(payload.sl),
    tp: payload?.tp == null ? null : Number(payload.tp),
    decision_reason: payload?.decision_reason || null,
  };

  // 1. Preflight
  const pf = await preflightOrder(env, sanitized);
  if (!pf.ok) {
    await writeAudit(env, {
      ts: Date.now(),
      user_id: sanitized.user_id,
      trade_id: sanitized.trade_id,
      ticker: sanitized.ticker,
      action: "reject",
      side: sanitized.side,
      qty: sanitized.qty,
      price_target: sanitized.entry,
      sl: sanitized.sl,
      tp: sanitized.tp,
      estimated_value: pf.estimated_value || null,
      status: "rejected",
      reject_reason: pf.reject_reason,
      request_json: sanitized,
      latency_ms: Date.now() - t0,
    });
    return json({ ok: false, rejected: true, reject_reason: pf.reject_reason, ...pf }, 200);
  }

  const user = pf.user;
  const estValue = pf.estimated_value;

  // 2. Audit: order_in
  await writeAudit(env, {
    ts: Date.now(),
    user_id: sanitized.user_id,
    trade_id: sanitized.trade_id,
    ticker: sanitized.ticker,
    action: "order_in",
    side: sanitized.side,
    qty: sanitized.qty,
    price_target: sanitized.entry,
    sl: sanitized.sl,
    tp: sanitized.tp,
    estimated_value: estValue,
    status: "ok",
    request_json: sanitized,
    latency_ms: Date.now() - t0,
  });

  // 3. Review (dry-run)
  const review = await reviewOrder(env, user, sanitized);
  const reviewWarnings = review?.response?.warnings || review?.response?.review?.warnings || [];
  const reviewOk = review.ok && (!Array.isArray(reviewWarnings) || reviewWarnings.length === 0);
  await writeAudit(env, {
    ts: Date.now(),
    user_id: sanitized.user_id,
    trade_id: sanitized.trade_id,
    ticker: sanitized.ticker,
    action: "review",
    side: sanitized.side,
    qty: sanitized.qty,
    price_target: sanitized.entry,
    estimated_value: estValue,
    status: reviewOk ? "ok" : "rejected",
    reject_reason: reviewOk ? null : `review_warnings:${JSON.stringify(reviewWarnings).slice(0, 200)}`,
    response_json: review.response || review,
    latency_ms: review.latency_ms,
  });
  if (!reviewOk) {
    return json({ ok: false, rejected: true, reject_reason: "review_failed", review_response: review.response || review }, 200);
  }

  // 4. Place
  const place = await placeOrder(env, user, sanitized);
  const rhOrderId = place?.response?.order_id || place?.response?.id || null;
  await writeAudit(env, {
    ts: Date.now(),
    user_id: sanitized.user_id,
    trade_id: sanitized.trade_id,
    ticker: sanitized.ticker,
    action: "place",
    side: sanitized.side,
    qty: sanitized.qty,
    price_target: sanitized.entry,
    sl: sanitized.sl,
    tp: sanitized.tp,
    estimated_value: estValue,
    rh_order_id: rhOrderId,
    status: place.ok ? "ok" : "error",
    reject_reason: place.ok ? null : (place.error || "place_failed"),
    response_json: place.response || place,
    latency_ms: place.latency_ms,
  });
  if (place.ok) {
    await bumpDailyCounter(env, sanitized.user_id);
  }

  return json({
    ok: place.ok,
    rh_order_id: rhOrderId,
    place_status: place.response?.status,
    review_warnings: reviewWarnings,
    mock: !!place.mock,
    latency_ms: Date.now() - t0,
  }, 200);
}

// ── Redaction helpers — never return token wraps to operator UI ──
function _redactUser(user) {
  if (!user) return null;
  const { rh_token_wrap, rh_refresh_wrap, ...safe } = user;
  return {
    ...safe,
    has_rh_token: !!rh_token_wrap,
    has_rh_refresh: !!rh_refresh_wrap,
  };
}
function _redactUserForList(user) {
  if (!user) return null;
  return {
    user_id: user.user_id,
    status: user.status,
    broker_integration_enabled: !!user.broker_integration_enabled,
    rh_account_number: user.rh_account_number || null,
    connected_at: user.connected_at || null,
    last_order_at: user.last_order_at || null,
    daily_order_count: user.daily_order_count || 0,
    daily_order_count_date: user.daily_order_count_date || null,
    total_orders_lifetime: user.total_orders_lifetime || 0,
    mock_mode: !!user.mock_mode,
  };
}
