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
import * as RobinhoodAdapter from "./bridge-robinhood.js";
import * as IbkrAdapter from "./bridge-ibkr.js";

// 2026-05-29 — broker-router. Each user record carries a `broker`
// field (`"robinhood"` | `"ibkr"`); the router picks the right
// adapter at order-time. Mock mode + hard caps + audit log work
// identically for both — the only thing that changes is the actual
// HTTPS call into the broker's API.
function brokerAdapterFor(user) {
  const b = String(user?.broker || "robinhood").toLowerCase();
  if (b === "ibkr") return IbkrAdapter;
  return RobinhoodAdapter; // default
}
// Re-exported tool-call shim for legacy /bridge/test/rh-call path —
// dispatches based on the user's `broker` field.
async function callMcpTool(env, user, toolName, args) {
  const adapter = brokerAdapterFor(user);
  if (typeof adapter.callMcpTool === "function") return adapter.callMcpTool(env, user, toolName, args);
  // IBKR doesn't have an MCP tool concept; map a few obvious cases.
  if (toolName === "get_portfolio")        return adapter.getPortfolio(env, user);
  if (toolName === "get_equity_positions") return adapter.getEquityPositions(env, user);
  return { ok: false, error: `tool_${toolName}_not_supported_for_${user?.broker || "broker"}` };
}
const reviewOrder = (env, user, order) => brokerAdapterFor(user).reviewOrder(env, user, order);
const placeOrder  = (env, user, order) => brokerAdapterFor(user).placeOrder(env, user, order);
const getPortfolio = (env, user) => brokerAdapterFor(user).getPortfolio(env, user);
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

      // 2026-05-29 — IBKR-specific connect endpoint.
      //
      // IBKR auth is fundamentally different from Robinhood OAuth.
      // Per IBKR's Self-Service OAuth model, the operator generates
      // their own consumer-key + access-token + access-token-secret
      // triplet in IBKR Account Management:
      //
      //   Account Management → Settings → API → OAuth →
      //     Generate New Pair
      //
      // The triplet is then POSTed here ONCE to encrypt + persist.
      // Subsequent orders use this stored credential — no per-order
      // login round-trip needed.
      //
      // Body: {
      //   user_id:                 "operator@email",
      //   ibkr_account_id:         "U1234567",
      //   ibkr_consumer_key:       "TIMEDTRADING",
      //   ibkr_oauth_token:        "<public access token>",
      //   ibkr_oauth_token_secret: "<secret — encrypted at rest>",
      // }
      if (method === "POST" && path === "/bridge/ibkr/connect") {
        if (operatorFail) return operatorFail;
        try {
          const body = await req.json().catch(() => ({}));
          const userId = String(body?.user_id || "").trim().toLowerCase();
          const acctId = String(body?.ibkr_account_id || "").trim();
          const consumerKey = String(body?.ibkr_consumer_key || "").trim();
          const token = String(body?.ibkr_oauth_token || "").trim();
          const tokenSecret = String(body?.ibkr_oauth_token_secret || "").trim();
          if (!userId || !acctId || !consumerKey || !token || !tokenSecret) {
            return json({ ok: false, error: "missing_required_fields", required: ["user_id", "ibkr_account_id", "ibkr_consumer_key", "ibkr_oauth_token", "ibkr_oauth_token_secret"] }, 400);
          }
          // Encrypt the token + secret.
          const { wrapSecret } = await import("./bridge-crypto.js");
          const tokenWrap = await wrapSecret(env, token);
          const tokenSecretWrap = await wrapSecret(env, tokenSecret);
          const existing = (await readUser(env, userId)) || { user_id: userId };
          const user = {
            ...existing,
            broker: "ibkr",
            status: "connected",
            connected_at: Date.now(),
            ibkr_account_id: acctId,
            ibkr_consumer_key: consumerKey,
            ibkr_oauth_token_wrap: tokenWrap,
            ibkr_oauth_token_secret_wrap: tokenSecretWrap,
            broker_integration_enabled: existing.broker_integration_enabled ?? false,
            daily_order_count: existing.daily_order_count || 0,
            daily_order_count_date: existing.daily_order_count_date || new Date().toISOString().slice(0, 10),
            total_orders_lifetime: existing.total_orders_lifetime || 0,
            user_caps: existing.user_caps || {
              max_per_order_usd: Number(env?.DEFAULT_MAX_ORDER_USD) || 5000,
              max_orders_per_day: Number(env?.DEFAULT_MAX_ORDERS_PER_DAY) || 3,
            },
          };
          await writeUser(env, userId, user);
          return json({
            ok: true,
            user_id: userId,
            broker: "ibkr",
            ibkr_account_id: acctId,
            broker_integration_enabled: user.broker_integration_enabled,
            note: "IBKR connected. Operator must explicitly flip broker_integration_enabled to true before any live orders flow.",
          });
        } catch (e) {
          return json({ ok: false, error: String(e?.message || e).slice(0, 500) }, 500);
        }
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

      // 2026-06-01 — GET /bridge/portfolio
      // Aggregates balance + open positions per connected user so
      // Mission Control's "Broker Bridge" section can show real
      // account state inline (instead of just "LIVE" / "MOCK" pill).
      // For each user in `connected` status, fetches portfolio +
      // equity positions via the broker adapter. Errors per-user are
      // captured in the row rather than failing the whole call —
      // operator can still see partial results.
      if (method === "GET" && path === "/bridge/portfolio") {
        if (operatorFail) return operatorFail;
        const users = await listConnectedUsers(env);
        const out = [];
        for (const u of users) {
          const userId = u.user_id || u.email;
          const summary = { user_id: userId, broker: u.broker || "ibkr", status: u.status };
          try {
            const adapter = brokerAdapterFor(u);
            // getPortfolio returns broker-specific shape — IBKR
            // returns { ok, accounts: [{ accountId, summary }] }.
            // We normalize to top-line equity + cash for the UI.
            const portfolio = typeof adapter.getPortfolio === "function"
              ? await adapter.getPortfolio(env, u).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }))
              : { ok: false, error: "broker_no_portfolio_method" };
            summary.portfolio = portfolio;
            if (portfolio?.ok) {
              // IBKR Client Portal /portfolio/{acctId}/summary returns
              // fields under `response.<lowercase>` (e.g.
              // `response.netliquidation.amount`). Other adapters
              // (Robinhood mock, etc.) may return camelCase or top-
              // level keys. Try every shape we've seen.
              const r = portfolio.response || portfolio;
              const acct = (Array.isArray(portfolio.accounts) && portfolio.accounts[0]) || portfolio.summary || r;
              const equity = Number(
                acct?.netliquidation?.amount ?? acct?.NetLiquidation?.amount
                ?? acct?.equitywithloanvalue?.amount
                ?? acct?.equity?.current ?? acct?.equity ?? acct?.net_liquidation
              );
              const cash = Number(
                acct?.totalcashvalue?.amount ?? acct?.TotalCashValue?.amount
                ?? acct?.availablefunds?.amount
                ?? acct?.cash?.current ?? acct?.cash ?? acct?.total_cash
              );
              const buyingPower = Number(
                acct?.buyingpower?.amount ?? acct?.BuyingPower?.amount ?? acct?.buying_power
              );
              const acctId = String(acct?.accountcode?.value || acct?.accountId || acct?.account || "").trim();
              summary.equity_usd = Number.isFinite(equity) ? equity : null;
              summary.cash_usd = Number.isFinite(cash) ? cash : null;
              summary.buying_power_usd = Number.isFinite(buyingPower) ? buyingPower : null;
              if (acctId) summary.account_id = acctId;
            }
          } catch (e) {
            summary.portfolio = { ok: false, error: String(e?.message || e).slice(0, 200) };
          }
          try {
            const adapter = brokerAdapterFor(u);
            const positions = typeof adapter.getEquityPositions === "function"
              ? await adapter.getEquityPositions(env, u).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }))
              : { ok: false, error: "broker_no_positions_method" };
            summary.positions = positions;
            if (positions?.ok && Array.isArray(positions.positions)) {
              summary.positions_count = positions.positions.length;
            } else if (Array.isArray(positions)) {
              // Some adapters return the array directly.
              summary.positions = { ok: true, positions };
              summary.positions_count = positions.length;
            }
          } catch (e) {
            summary.positions = { ok: false, error: String(e?.message || e).slice(0, 200) };
          }
          out.push(summary);
        }
        return json({ ok: true, users_count: out.length, users: out, ts: Date.now() });
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

      // 2026-06-01 — POST /bridge/user/caps
      // Operator-only. Updates a connected user's per-order /
      // per-day / per-account caps so the bridge respects the
      // operator's chosen risk envelope. Used by Mission Control's
      // 'Manage' button so the operator doesn't have to redeploy or
      // edit env vars to change caps for a small account.
      // Body: { user_id, max_per_order_usd?, max_orders_per_day?, max_account_pct? }
      if (method === "POST" && path === "/bridge/user/caps") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const userId = String(body?.user_id || "").trim().toLowerCase();
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);
        const current = user.user_caps || {};
        const next = { ...current };
        if (body.max_per_order_usd !== undefined) {
          const v = Number(body.max_per_order_usd);
          if (!Number.isFinite(v) || v <= 0 || v > 1_000_000) {
            return json({ ok: false, error: "max_per_order_usd_must_be_1_to_1000000" }, 400);
          }
          next.max_per_order_usd = Math.round(v);
        }
        if (body.max_orders_per_day !== undefined) {
          const v = Number(body.max_orders_per_day);
          if (!Number.isFinite(v) || v < 0 || v > 100) {
            return json({ ok: false, error: "max_orders_per_day_must_be_0_to_100" }, 400);
          }
          next.max_orders_per_day = Math.round(v);
        }
        if (body.max_account_pct !== undefined) {
          const v = Number(body.max_account_pct);
          if (!Number.isFinite(v) || v <= 0 || v > 1) {
            return json({ ok: false, error: "max_account_pct_must_be_0_to_1" }, 400);
          }
          next.max_account_pct = v;
        }
        user.user_caps = next;
        user.user_caps_updated_at = Date.now();
        await writeUser(env, userId, user);
        return json({ ok: true, user_id: userId, user_caps: next, updated_at: user.user_caps_updated_at });
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

      // 2026-05-30 — POST /bridge/options/order — route TT options play
      // (from worker/options-plays.js) to the broker. Operator-only for
      // auto-execution; other users get review-only response (dry run).
      if (method === "POST" && path === "/bridge/options/order") {
        const rawBody = await req.text();
        const sigFail = await requireWebhookSignature(env, req, rawBody);
        if (sigFail) return sigFail;
        let payload;
        try { payload = JSON.parse(rawBody); } catch (_) { return json({ ok: false, error: "bad_json" }, 400); }
        return await handleOptionsOrderWebhook(env, ctx, payload);
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

// ─────────────────────────────────────────────────────────────────────
// OPTIONS order webhook — Phase 3 of the TT Options Engine.
//
// Inbound payload shape:
//   { user_id, trade_id, ticker, play: { archetype, legs, contracts, ... },
//     confluence_verdict: {...}, source: 'auto_mirror' | 'manual' }
//
// Flow:
//   1. Preflight (kill switch, enablement, options-specific opt-in)
//   2. Translate play → IBKR order (playToIbkrOrder helper)
//   3. Adapter routes order to broker (IBKR options API)
//   4. Audit log + bump daily counter
//
// 2026-05-30 — Phase 3 of the TT Options Engine.
// ─────────────────────────────────────────────────────────────────────
async function handleOptionsOrderWebhook(env, ctx, payload) {
  const t0 = Date.now();
  const sanitized = {
    user_id: String(payload?.user_id || "").toLowerCase(),
    trade_id: payload?.trade_id || null,
    ticker: String(payload?.ticker || "").toUpperCase(),
    play: payload?.play || null,
    confluence: payload?.confluence_verdict || null,
    source: String(payload?.source || "manual"),
    dry_run: payload?.dry_run === true,
    ts: Date.now(),
  };
  if (!sanitized.user_id || !sanitized.ticker || !sanitized.play) {
    return json({ ok: false, error: "missing_required_fields" }, 400);
  }

  // Load user + check enablement.
  const { getUser } = await import("./bridge-storage.js");
  const user = await getUser(env, sanitized.user_id);
  if (!user) return json({ ok: false, error: "user_not_found" }, 404);

  // Global kill switch.
  if (env?.BRIDGE_KILL_SWITCH === "true") {
    return json({ ok: false, rejected: true, reason: "global_kill_switch" }, 200);
  }
  if (!user.broker_integration_enabled) {
    return json({ ok: false, rejected: true, reason: "user_disabled" }, 200);
  }
  // Options-specific gate — separate from stock enablement so users
  // can authorize stocks-only without options.
  if (!user.options_enabled && user.role !== "operator") {
    return json({ ok: false, rejected: true, reason: "options_not_enabled" }, 200);
  }

  // Translate play → broker order shape.
  const { playToIbkrOrder, placeOptionsOrder } = await import("./bridge-ibkr.js");
  const brokerOrder = playToIbkrOrder(sanitized.play, sanitized.ticker);
  if (!brokerOrder) return json({ ok: false, rejected: true, reason: "play_translation_failed" }, 200);

  // Dry-run path — return what WOULD be sent without hitting the broker.
  if (sanitized.dry_run || user.mock_mode) {
    return json({
      ok: true,
      dry_run: true,
      mock: true,
      ticker: sanitized.ticker,
      translated_order: brokerOrder,
      play_archetype: sanitized.play.archetype,
      max_loss_usd: sanitized.play.max_loss_usd,
      max_gain_usd: sanitized.play.max_gain_usd,
      latency_ms: Date.now() - t0,
    }, 200);
  }

  // Live execution.
  const placed = await placeOptionsOrder(env, user, brokerOrder);

  // Audit log (uses writeAudit which is the canonical helper).
  try {
    await writeAudit(env, {
      kind: "options_order",
      user_id: sanitized.user_id,
      ticker: sanitized.ticker,
      trade_id: sanitized.trade_id,
      source: sanitized.source,
      play_archetype: sanitized.play.archetype,
      confluence_mode: sanitized.confluence?.mode || null,
      confluence_score: sanitized.confluence?.score || null,
      translated_order: brokerOrder,
      broker_response: placed,
      ts: Date.now(),
    });
  } catch (_) { /* best-effort */ }

  return json({
    ok: !!placed?.ok,
    ticker: sanitized.ticker,
    play_archetype: sanitized.play.archetype,
    translated_order: brokerOrder,
    broker_response: placed,
    latency_ms: Date.now() - t0,
  }, placed?.ok ? 200 : 502);
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
