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
  claimOrderIdempotency, releaseOrderIdempotency, resolveBridgeAccounts,
  listMirrorParticipants, pauseOwnerAccounts,
} from "./bridge-storage.js";
import { preflightOrder, bumpDailyCounter, evaluateReducerAgainstPositions, reconcileReducerQty } from "./bridge-guards.js";
import { roundQtyForBroker } from "./bridge-sizing.js";
import {
  writeEntryManifest, writeRejectedEntry,
  recentManifestRows, readManifestRow,
  classifyOrderLifecycle, markManifestModelClosed,
  writeLastActionAudit,
} from "./bridge-manifest.js";
import {
  reconcileAllUsers, reconcileUser,
} from "./bridge-reconciler.js";
import { orchestrateOcoForReducer } from "./bridge-oco.js";
import {
  drainNotifyQueue, buildDailyOwnerDigest, renderDailyOwnerDigestEmail,
  emitDriftNotification, resolveNotifyRecipients, shouldBuildDailyDigest,
} from "./bridge-notifications.js";
import * as RobinhoodAdapter from "./bridge-robinhood.js";
import * as IbkrAdapter from "./bridge-ibkr.js";
import * as WebullAdapter from "./bridge-webull.js";
import { webullAuthMode, webullConnectConfigured, webullCredentialsConfigured, webullPersonalConfigured } from "./bridge-webull-config.js";
import {
  handleWebullOauthStart,
  handleWebullOauthCallback,
  handleWebullOauthDisconnect,
} from "./bridge-webull-auth.js";
import { refreshWebullTokensIfNeeded } from "./bridge-webull-tokens.js";
import { refreshRhTokensIfNeeded } from "./bridge-robinhood-auth.js";
import { listBrokers, resolveBrokerAccountId, resolveBrokerId, brokerCapabilities } from "./bridge-brokers.js";
import { normalizeOrderIntent, planBrokerOrder, summarizeOrderPlan } from "./bridge-order-plan.js";
import { recordAccountFill, readAccountLedger, readAccountSnapshots, recordEquityPoint, readEquityHistory } from "./bridge-account-ledger.js";
import { ensureConnectedAccountsEquity, extractPortfolioTotals, refreshAccountEquitySnapshot } from "./bridge-equity-sync.js";
import { classifyWebullFractError, roundToWholeShares } from "./bridge-webull-fract.js";

// 2026-05-29 — broker-router. Each user record carries a `broker`
// field (`"robinhood"` | `"ibkr"` | `"webull"`); the router picks the right
// adapter at order-time. Mock mode + hard caps + audit log work
// identically for all — the only thing that changes is the actual
// HTTPS call into the broker's API.
function brokerAdapterFor(user) {
  const b = String(user?.broker || "robinhood").toLowerCase();
  if (b === "ibkr") return IbkrAdapter;
  if (b === "webull") return WebullAdapter;
  return RobinhoodAdapter; // default
}
// Re-exported tool-call shim for legacy /bridge/test/rh-call path —
// dispatches based on the user's `broker` field.
async function callMcpTool(env, user, toolName, args) {
  const adapter = brokerAdapterFor(user);
  if (typeof adapter.callMcpTool === "function") return adapter.callMcpTool(env, user, toolName, args);
  if (typeof adapter.callWebullAction === "function") return adapter.callWebullAction(env, user, toolName, args);
  // IBKR doesn't have an MCP tool concept; map a few obvious cases.
  if (toolName === "get_portfolio")        return adapter.getPortfolio(env, user);
  if (toolName === "get_equity_positions") return adapter.getEquityPositions(env, user);
  return { ok: false, error: `tool_${toolName}_not_supported_for_${user?.broker || "broker"}` };
}
const reviewOrder = (env, user, order) => brokerAdapterFor(user).reviewOrder(env, user, order);
const placeOrder  = (env, user, order) => brokerAdapterFor(user).placeOrder(env, user, order);
const getPortfolio = (env, user) => brokerAdapterFor(user).getPortfolio(env, user);
// Place respecting the agnostic plan: native bracket when the broker adapter
// supports it AND the plan asked for it; otherwise a plain (market/limit) order.
const placePlannedOrder = (env, user, order, plan) => {
  const adapter = brokerAdapterFor(user);
  if (plan?.protection?.mode === "native_bracket" && typeof adapter.placeBracketOrder === "function") {
    return adapter.placeBracketOrder(env, user, order);
  }
  return adapter.placeOrder(env, user, order);
};

// Cancel the pending OCO children (SL + TP) for a trade on an account. They
// reserve the shares, so a trim/flatten must cancel them first or the broker
// rejects the reducer ("qty locked up by open orders"). Children use the
// deterministic `tt-oco-<trade>-<acct>-sl/-tp` client_order_ids (Webull cancels
// by client_order_id). Records each cancel to the per-account ledger.
async function cancelOcoChildren(env, user, tradeId, acctId, brokerId) {
  const adapter = brokerAdapterFor(user);
  if (typeof adapter.cancelOrder !== "function") return { cancelled: 0, legs: [] };
  // Active child ids from the ledger (placed, not yet cancelled) + the
  // deterministic base ids as a fallback for pre-ledger placements.
  const ids = new Set(await activeOcoChildIds(env, acctId, tradeId));
  ids.add(`tt-oco-${tradeId}-${acctId}-sl`);
  ids.add(`tt-oco-${tradeId}-${acctId}-tp`);
  const legs = [];
  let cancelled = 0;
  for (const coid of ids) {
    let ok = false;
    try {
      const r = await adapter.cancelOrder(env, user, coid);
      ok = !!(r && r.ok !== false);
    } catch (_) { ok = false; }
    if (ok) cancelled++;
    legs.push({ client_order_id: coid, ok });
    await recordAccountFill(env, {
      ts: Date.now(),
      owner_id: user?.owner_email || user?.user_id || null,
      user_id: user?.user_id || null,
      broker: brokerId || null,
      broker_account_id: acctId,
      model_trade_id: tradeId,
      client_order_id: coid,
      event_type: "OCO_CANCEL",
      status: ok ? "ok" : "error",
      meta: { reason: "reducer_cancel_before_place" },
    }).catch(() => {});
  }
  return { cancelled, legs };
}

// Client_order_ids of OCO children placed for a trade that have not since been
// cancelled — read from the per-account ledger so re-placed (generation-
// stamped) children are still found and cancelled on the next reducer.
async function activeOcoChildIds(env, acctId, tradeId) {
  const active = new Set();
  const cancelled = new Set();
  try {
    const rows = await readAccountLedger(env, { broker_account_id: acctId, limit: 300 });
    // rows are newest-first; walk oldest-first so cancels applied after places win.
    for (const r of [...rows].reverse()) {
      if (String(r.model_trade_id) !== String(tradeId)) continue;
      const coid = r.client_order_id;
      if (!coid) continue;
      if (r.event_type === "OCO_STOP_LOSS" || r.event_type === "OCO_TAKE_PROFIT") {
        if (r.status === "ok") active.add(coid);
      } else if (r.event_type === "OCO_CANCEL") {
        cancelled.add(coid);
      }
    }
  } catch (_) { /* best-effort */ }
  for (const c of cancelled) active.delete(c);
  return [...active];
}

// Recover the SL/TP prices for a trade's OCO children from the per-account
// ledger so a trim can re-establish protection for the remaining qty.
async function recoverOcoPrices(env, acctId, tradeId) {
  const out = { sl: null, tp: null };
  try {
    const rows = await readAccountLedger(env, { broker_account_id: acctId, limit: 200 });
    for (const r of rows) {
      if (String(r.model_trade_id) !== String(tradeId)) continue;
      if (out.sl == null && r.event_type === "OCO_STOP_LOSS" && Number(r.price) > 0) out.sl = Number(r.price);
      if (out.tp == null && r.event_type === "OCO_TAKE_PROFIT" && Number(r.price) > 0) out.tp = Number(r.price);
      if (out.sl != null && out.tp != null) break;
    }
  } catch (_) { /* best-effort */ }
  return out;
}

// Confirm an account holds the position before a SELL/EXIT/TRIM. Uses live
// broker positions (ground truth), so it protects even when the manifest is in
// shadow mode or drifted. Fails SAFE for a confirmed no-position; on an
// unavailable positions API it allows through (broker is the final backstop)
// unless BROKER_REDUCER_REQUIRE_POSITION=true.
async function verifyReducerHoldsPosition(env, user, sanitized) {
  const adapter = brokerAdapterFor(user);
  if (typeof adapter.getEquityPositions !== "function") {
    return { ok: true, skip: "no_positions_api" };
  }
  let res;
  try {
    res = await adapter.getEquityPositions(env, user);
  } catch (e) {
    res = { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
  // Mock mode has no real positions — don't false-reject during testing.
  if (res?.mock) return { ok: true, skip: "mock_mode" };
  if (!res || res.ok === false) {
    const strict = String(env?.BROKER_REDUCER_REQUIRE_POSITION || "false").toLowerCase() === "true";
    if (strict) return { ok: false, reason: "reducer_position_unverified", heldQty: null };
    console.warn(`[REDUCER_GUARD] positions unavailable for ${sanitized.user_id}/${sanitized.ticker} — allowing (broker backstop)`);
    return { ok: true, skip: "positions_unavailable" };
  }
  const positions = Array.isArray(res.positions) ? res.positions
    : (Array.isArray(res.response) ? res.response : []);
  const ev = evaluateReducerAgainstPositions({
    ticker: sanitized.ticker,
    requestedQty: sanitized.qty,
    positions,
  });
  if (ev.action === "reject") return { ok: false, reason: ev.reason, heldQty: ev.heldQty };
  if (ev.action === "clamp") return { ok: true, clampQty: ev.clampQty, heldQty: ev.heldQty };
  return { ok: true, heldQty: ev.heldQty };
}

// Emulated OCO for brokers without native brackets (Webull): after the entry
// fills, place a stop-loss + take-profit child on the opposite side. Children
// use `<base>-sl` / `<base>-tp` client_order_ids so fill reconciliation can
// cancel the sibling when one fills. Records each child to the per-account
// ledger. Returns [{ role, ok, order_id }].
async function placeOcoChildren(env, user, sanitized, plan, ctx = {}) {
  const acctId = ctx.brokerAccountId || resolveBrokerAccountId(user);
  const qty = Number(ctx.filledQty) > 0 ? Number(ctx.filledQty) : Number(sanitized.qty);
  const exitSide = String(sanitized.side || "buy").toLowerCase() === "buy" ? "sell" : "buy";
  // A generation suffix keeps re-placed children (after a trim) from reusing a
  // cancelled client_order_id, which brokers reject. cancelOcoChildren finds
  // active children from the ledger, so any suffix is cancellable later.
  const base = `tt-oco-${sanitized.trade_id || "na"}-${acctId}${ctx.idSuffix ? `-${ctx.idSuffix}` : ""}`;
  const sl = Number(plan?.protection?.stop_loss);
  const tp = Number(plan?.protection?.take_profit);
  const children = [];
  if (Number.isFinite(sl) && sl > 0) {
    children.push({ role: "sl", order_type: "stop", stop_price: sl, client_order_id: `${base}-sl` });
  }
  if (Number.isFinite(tp) && tp > 0) {
    children.push({ role: "tp", order_type: "limit", limit_price: tp, client_order_id: `${base}-tp` });
  }

  const results = [];
  for (const c of children) {
    const childOrder = {
      ticker: sanitized.ticker,
      side: exitSide,
      qty,
      trade_id: sanitized.trade_id,
      tif: "GTC",
      order_type: c.order_type,
      stop_price: c.stop_price,
      limit_price: c.limit_price,
      client_order_id: c.client_order_id,
    };
    let res;
    try {
      res = await placeOrder(env, user, childOrder);
    } catch (e) {
      res = { ok: false, error: String(e?.message || e).slice(0, 160) };
    }
    const childOrderId = Array.isArray(res?.response)
      ? (res.response[0]?.order_id || null)
      : (res?.response?.order_id || res?.response?.id || null);
    await recordAccountFill(env, {
      ts: Date.now(),
      owner_id: user?.owner_email || sanitized.user_id,
      user_id: user?.user_id || sanitized.user_id,
      broker: ctx.brokerId || null,
      broker_account_id: acctId,
      model_trade_id: sanitized.trade_id,
      client_order_id: c.client_order_id,
      broker_order_id: childOrderId,
      ticker: sanitized.ticker,
      side: exitSide,
      event_type: c.role === "sl" ? "OCO_STOP_LOSS" : "OCO_TAKE_PROFIT",
      order_type: c.order_type,
      protection_mode: "oco_children",
      qty,
      price: c.stop_price || c.limit_price || 0,
      status: res?.ok ? "ok" : "error",
      reject_reason: res?.ok ? null : (res?.error || "child_place_failed"),
    }).catch(() => {});
    results.push({ role: c.role, ok: !!res?.ok, order_id: childOrderId });
  }
  return results;
}
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
          webull_auth_mode: webullAuthMode(env),
          webull_credentials_configured: webullCredentialsConfigured(env),
          webull_personal_configured: webullPersonalConfigured(env),
          webull_connect_configured: webullConnectConfigured(env),
          webull_environment: env?.WEBULL_ENVIRONMENT || "uat",
          fanout_enabled: String(env?.BROKER_FANOUT_ENABLED || "").toLowerCase() === "true",
          manifest_enforce: String(env?.BROKER_MANIFEST_ENFORCE || "on").toLowerCase(),
          oco_enabled: String(env?.BROKER_OCO_ENABLED || "").toLowerCase() === "true",
          supported_brokers: listBrokers().map((b) => {
            const a = b.capabilities?.adapter || {};
            return {
              id: b.id,
              label: b.label,
              status: b.status,
              // What the adapter can actually SEND today (agnostic layer).
              sends: {
                equity_market: !!a.equity?.market,
                equity_limit: !!a.equity?.limit,
                equity_stop: !!a.equity?.stop,
                bracket: !!a.bracket,
                oco: !!a.oco,
                options: !!(a.options?.limit || a.options?.market),
                fractional: !!a.fractional,
                reads_fills: !!a.read_fills,
                multi_account: !!b.multiAccount,
              },
            };
          }),
          ts: Date.now(),
        });
      }

      // ── Public OAuth callbacks ───────────────────────────────
      if (method === "GET" && path === "/bridge/webull/oauth/callback") {
        const result = await handleWebullOauthCallback(env, req);
        return _oauthCallbackHtml(result, "Webull");
      }

      if (method === "GET" && path === "/bridge/oauth/callback") {
        const result = await handleOauthCallback(env, req);
        return _oauthCallbackHtml(result, "Robinhood");
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

      if (method === "POST" && path === "/bridge/webull/oauth/start") {
        if (operatorFail) return operatorFail;
        const result = await handleWebullOauthStart(env, req);
        return json(result, result.status || 200);
      }
      if (method === "POST" && path === "/bridge/webull/oauth/disconnect") {
        if (operatorFail) return operatorFail;
        const result = await handleWebullOauthDisconnect(env, req);
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
              // 0 = unlimited (mirror on/off is the account control).
              max_orders_per_day: Number.isFinite(Number(env?.DEFAULT_MAX_ORDERS_PER_DAY))
                ? Number(env.DEFAULT_MAX_ORDERS_PER_DAY)
                : 0,
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
          webull_auth_mode: webullAuthMode(env),
          webull_credentials_configured: webullCredentialsConfigured(env),
          webull_personal_configured: webullPersonalConfigured(env),
          webull_connect_configured: webullConnectConfigured(env),
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
      // 2026-08-11 — All broker accounts for ONE owner (self-service
      // Broker Connections page). Scoped: only rows whose owner matches,
      // so the main worker can safely proxy this per signed-in user.
      if (method === "GET" && path === "/bridge/accounts") {
        if (operatorFail) return operatorFail;
        const owner = String(url.searchParams.get("owner") || "").trim().toLowerCase();
        if (!owner) return json({ ok: false, error: "owner_required" }, 400);
        const accounts = await resolveBridgeAccounts(env, owner, { enabledOnly: false });
        return json({
          ok: true,
          owner,
          count: accounts.length,
          accounts: accounts.map(_redactUserForList),
          ts: Date.now(),
        });
      }
      // 2026-08-12 — Owner-level kill switch: pause mirroring on every
      // account under one owner (self-service "Pause all" + the admin
      // un-provision cascade). Credentials and connection status stay.
      if (method === "POST" && path === "/bridge/owner/pause") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const owner = String(body?.owner || "").trim().toLowerCase();
        if (!owner) return json({ ok: false, error: "owner_required" }, 400);
        const result = await pauseOwnerAccounts(env, owner);
        return json({ ok: true, owner, ...result, ts: Date.now() });
      }
      // 2026-08-12 — Position sync view for ONE owner (self-service page).
      // Joins live broker equity positions against the mirror trade
      // manifest so the user can see which positions are model-managed
      // and whether each is in sync (sync_state maintained by the
      // reconciler). Broker positions with no manifest row are the
      // user's own holdings → "untracked".
      if (method === "GET" && path === "/bridge/positions") {
        if (operatorFail) return operatorFail;
        const owner = String(url.searchParams.get("owner") || "").trim().toLowerCase();
        if (!owner) return json({ ok: false, error: "owner_required" }, 400);
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const accounts = (await resolveBridgeAccounts(env, owner, { enabledOnly: false }))
          .filter((u) => String(u?.status || "").toLowerCase() === "connected");
        const out = [];
        // 2026-08-13 — KV positions cache. Five accounts fetched
        // back-to-back tripped Webull's rate limit ("Too many requests"
        // on Roth IRA + Margin). Serve a <60s-fresh cache without any
        // broker call; on a live-fetch failure fall back to the last
        // good snapshot (up to 1h) marked stale with its as-of time —
        // data with an age beats an error.
        const POS_CACHE_FRESH_MS = 60 * 1000;
        const POS_CACHE_TTL_SEC = 60 * 60;
        // Account equity/cash from the reconciler's snapshots (summary strip).
        let snapByAcct = new Map();
        try {
          const { readAccountSnapshots } = await import("./bridge-account-ledger.js");
          const snaps = await readAccountSnapshots(env, { owner_id: owner });
          snapByAcct = new Map(snaps.map((s) => [String(s.broker_account_id), s]));
        } catch (_) { /* snapshots optional */ }
        for (const acct of accounts) {
          const _snap = snapByAcct.get(String(resolveBrokerAccountId(acct))) || null;
          const _snapEq = _snap != null ? Number(_snap.equity_usd) : NaN;
          const _snapCash = _snap != null ? Number(_snap.cash_usd) : NaN;
          const entry = {
            account_id: acct.user_id,
            broker: resolveBrokerId(acct) || acct.broker || null,
            label: acct.webull_account_label || acct.webull_account_class || null,
            mirror_enabled: acct.broker_integration_enabled === true,
            // Preserve finite 0; `|| null` used to wipe legitimate empty accounts.
            equity_usd: Number.isFinite(_snapEq) ? _snapEq : null,
            cash_usd: Number.isFinite(_snapCash) ? _snapCash : null,
            snapshot_at: _snap ? (Number(_snap.synced_at) || null) : null,
            connected_at: Number(acct.connected_at) || null,
            enable_changed_at: Number(acct.enable_changed_at) || null,
            mirror_events: Array.isArray(acct.mirror_events) ? acct.mirror_events : [],
            items: [],
          };
          const cacheKey = `bridge:positions:${String(acct.user_id).toLowerCase()}`;
          let cached = null;
          try {
            cached = env.BRIDGE_KV ? JSON.parse((await env.BRIDGE_KV.get(cacheKey)) || "null") : null;
          } catch (_) { cached = null; }
          let brokerPositions = null;
          if (!forceRefresh && cached && Date.now() - (Number(cached.ts) || 0) < POS_CACHE_FRESH_MS) {
            brokerPositions = cached.positions || [];
            entry.positions_as_of = cached.ts;
            entry.positions_cached = true;
          } else {
            try {
              const adapter = brokerAdapterFor(acct);
              const res = typeof adapter.getEquityPositions === "function"
                ? await adapter.getEquityPositions(env, acct).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 200) }))
                : { ok: false, error: "broker_no_positions_method" };
              if (Array.isArray(res)) brokerPositions = res;
              else if (res?.ok && Array.isArray(res.positions)) brokerPositions = res.positions;
              else entry.positions_error = res?.error || "positions_unavailable";
            } catch (e) {
              entry.positions_error = String(e?.message || e).slice(0, 200);
            }
            if (brokerPositions !== null) {
              entry.positions_as_of = Date.now();
              if (env.BRIDGE_KV) {
                ctx?.waitUntil?.(env.BRIDGE_KV.put(cacheKey,
                  JSON.stringify({ ts: Date.now(), positions: brokerPositions }),
                  { expirationTtl: POS_CACHE_TTL_SEC },
                ).catch(() => {}));
              }
            } else if (cached && Array.isArray(cached.positions)) {
              // Live fetch failed — degrade to the last good snapshot.
              brokerPositions = cached.positions;
              entry.positions_as_of = cached.ts;
              entry.positions_stale = true;
              entry.positions_stale_reason = entry.positions_error || null;
              delete entry.positions_error;
            }
          }
          if (brokerPositions === null) brokerPositions = [];
          const posBySym = new Map();
          for (const p of brokerPositions) {
            const sym = String(p?.ticker || p?.symbol || p?.instrument_symbol || "").toUpperCase();
            if (!sym) continue;
            const qty = Number(p?.quantity ?? p?.qty ?? p?.position ?? p?.units);
            const mv = Number(p?.market_value ?? p?.marketValue);
            let last = Number(p?.last_price ?? p?.price ?? p?.lastPrice);
            if (!(Number.isFinite(last) && last > 0) && Number.isFinite(mv) && mv > 0 && Number.isFinite(qty) && Math.abs(qty) > 0) {
              last = mv / Math.abs(qty);
            }
            const upl = Number(p?.unrealized_pnl ?? p?.unrealizedPnl);
            const uplPct = Number(p?.unrealized_pnl_pct);
            const dayPnl = Number(p?.day_pnl);
            posBySym.set(sym, {
              qty: Number.isFinite(qty) ? qty : null,
              avg_cost: Number(p?.avg_cost ?? p?.average_cost ?? p?.cost_price ?? p?.avgPrice) || null,
              last_price: Number.isFinite(last) && last > 0 ? last : null,
              market_value: Number.isFinite(mv) && mv > 0 ? mv : null,
              unrealized_pnl: Number.isFinite(upl) ? upl : null,
              unrealized_pnl_pct: Number.isFinite(uplPct) ? uplPct : null,
              day_pnl: Number.isFinite(dayPnl) ? dayPnl : null,
            });
          }
          // 2026-08-13 — Match manifest rows on user_id OR broker_account_id
          // (same fix the reconciler needed on 2026-07-24): fan-out orders
          // write rows under the OWNER's base user_id with the per-account
          // broker_account_id, so matching user_id alone showed every
          // model-managed position as "untracked" (AXON in the Roth IRA).
          let manifestRows = [];
          try {
            const db = env?.BRIDGE_DB;
            const acctBrokerId = resolveBrokerAccountId(acct);
            if (db) {
              const r = await db.prepare(`
                SELECT * FROM mirror_trade_manifest
                 WHERE (user_id = ?1 OR (?2 IS NOT NULL AND broker_account_id = ?2))
                 ORDER BY updated_at DESC LIMIT 200
              `).bind(
                String(acct.user_id).toLowerCase(),
                acctBrokerId ? String(acctBrokerId) : null,
              ).all().catch(() => ({ results: [] }));
              manifestRows = r?.results || [];
            }
          } catch (_) {
            manifestRows = await recentManifestRows(env, { user_id: acct.user_id, limit: 200 });
          }
          const seen = new Set();
          for (const row of manifestRows) {
            const sym = String(row?.ticker || "").toUpperCase();
            if (!sym || seen.has(sym)) continue;
            const state = String(row?.sync_state || "").toLowerCase();
            const modelStatus = String(row?.model_status || "").toUpperCase();
            // Skip fully closed + reconciled history; keep anything live
            // or in a drift state the user should see.
            if (modelStatus === "CLOSED" && (state === "in_sync" || state === "expired" || state === "rejected")) continue;
            seen.add(sym);
            const broker = posBySym.get(sym) || null;
            entry.items.push({
              ticker: sym,
              managed: true,
              model_status: modelStatus || null,
              sync_state: state || "pending",
              model_qty: Number(row?.model_intended_qty) || null,
              broker_filled_qty: Number(row?.broker_filled_qty) || 0,
              broker_qty: broker ? broker.qty : 0,
              avg_cost: broker ? broker.avg_cost : (Number(row?.broker_avg_cost) || null),
              last_price: broker?.last_price ?? null,
              price: broker?.last_price ?? null,
              market_value: broker?.market_value ?? null,
              unrealized_pnl: broker?.unrealized_pnl ?? null,
              unrealized_pnl_pct: broker?.unrealized_pnl_pct ?? null,
              day_pnl: broker?.day_pnl ?? null,
              sync_note: row?.sync_note || null,
              updated_at: row?.updated_at || null,
            });
          }
          for (const [sym, p] of posBySym) {
            if (seen.has(sym)) continue;
            entry.items.push({
              ticker: sym,
              managed: false,
              sync_state: "untracked",
              broker_qty: p.qty,
              avg_cost: p.avg_cost,
              last_price: p.last_price ?? null,
              price: p.last_price ?? null,
              market_value: p.market_value ?? null,
              unrealized_pnl: p.unrealized_pnl ?? null,
              unrealized_pnl_pct: p.unrealized_pnl_pct ?? null,
              day_pnl: p.day_pnl ?? null,
            });
          }
          // 2026-08-13 — Per-ticker action history sub-rows (fills, trims,
          // DCAs, rejects) from this account's ledger so the page can show
          // "what happened to this position" without another round trip.
          try {
            const { readAccountLedger } = await import("./bridge-account-ledger.js");
            const ledgerRows = await readAccountLedger(env, {
              broker_account_id: resolveBrokerAccountId(acct),
              limit: 300,
            });
            const bySym = new Map();
            for (const r of ledgerRows) {
              const sym = String(r?.ticker || "").toUpperCase();
              if (!sym) continue;
              const list = bySym.get(sym) || [];
              if (list.length < 12) {
                list.push({
                  ts: r.ts,
                  side: r.side || null,
                  event_type: r.event_type || null,
                  qty: Number(r.qty) || 0,
                  price: Number(r.price) || 0,
                  value: Number(r.value) || 0,
                  status: r.status || null,
                  reject_reason: r.reject_reason || null,
                });
              }
              bySym.set(sym, list);
            }
            for (const it of entry.items) {
              const hist = bySym.get(it.ticker);
              if (hist && hist.length) it.history = hist;
            }
          } catch (e) {
            console.warn("[POSITIONS] history attach failed:", String(e?.message || e).slice(0, 160));
          }
          entry.items.sort((a, b) => (b.managed - a.managed) || String(a.ticker).localeCompare(String(b.ticker)));
          // 2026-08-13 — Stamp equity for EVERY connected account (mirror
          // off included). Reconciler only snapshots mirror-on accounts;
          // without this, Brokers page cards stay at $0 / "Not started".
          // When positions were live-fetched, keep the equity window to 60s
          // so Individual Margin / Cash cards track Webull NLV in near-realtime.
          try {
            const eqRes = await refreshAccountEquitySnapshot(env, acct, {
              adapter: brokerAdapterFor(acct),
              positions: brokerPositions,
              force: forceRefresh,
              existingSnap: _snap,
              maxStaleMs: entry.positions_cached ? (5 * 60 * 1000) : (60 * 1000),
            });
            if (Number.isFinite(eqRes.equity_usd)) {
              entry.equity_usd = eqRes.equity_usd;
              entry.equity_source = eqRes.source;
              if (eqRes.stale) entry.equity_stale = true;
            }
            if (Number.isFinite(eqRes.cash_usd)) entry.cash_usd = eqRes.cash_usd;
            if (eqRes.ok && (eqRes.source === "broker" || eqRes.source === "positions_estimate")) {
              entry.snapshot_at = Date.now();
            } else if (_snap) {
              entry.snapshot_at = Number(_snap.synced_at) || entry.snapshot_at;
            }
          } catch (e) {
            console.warn("[POSITIONS] equity sync failed:", String(e?.message || e).slice(0, 160));
          }
          out.push(entry);
        }
        return json({ ok: true, owner, accounts: out, ts: Date.now() });
      }
      // 2026-08-13 — Adopt a user-initiated broker position under model
      // management ("Sync with model"). Pure bookkeeping — writes the
      // manifest association at the model's scaled sizing; NO order is
      // placed and none can fire as a side effect. Shares above the
      // sleeve stay user-owned.
      if (method === "POST" && path === "/bridge/adopt-position") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const owner = String(body?.owner || "").trim().toLowerCase();
        const accountId = String(body?.account_id || "").trim().toLowerCase();
        const ticker = String(body?.ticker || "").trim().toUpperCase();
        const modelTradeId = String(body?.model_trade_id || "").trim();
        const modelQty = Number(body?.model_qty);
        const modelCapital = Number(body?.model_capital_usd) > 0 ? Number(body.model_capital_usd) : 100000;
        if (!owner || !accountId || !ticker || !modelTradeId) {
          return json({ ok: false, error: "owner_account_id_ticker_model_trade_id_required" }, 400);
        }
        if (!Number.isFinite(modelQty) || modelQty <= 0) {
          return json({ ok: false, error: "model_qty_must_be_positive" }, 400);
        }
        const accounts = await resolveBridgeAccounts(env, owner, { enabledOnly: false });
        const acct = accounts.find((u) => String(u.user_id).toLowerCase() === accountId);
        if (!acct || String(acct.status || "").toLowerCase() !== "connected") {
          return json({ ok: false, error: "account_not_found_or_not_connected" }, 404);
        }
        const brokerAccountId = resolveBrokerAccountId(acct);
        // Broker holding for the ticker — positions cache first (adoption
        // is not latency-sensitive and must not burn rate limit).
        let held = null;
        try {
          const cacheKey = `bridge:positions:${accountId}`;
          const cached = env.BRIDGE_KV ? JSON.parse((await env.BRIDGE_KV.get(cacheKey)) || "null") : null;
          let positions = cached && Date.now() - (Number(cached.ts) || 0) < 10 * 60 * 1000
            ? cached.positions
            : null;
          if (!positions) {
            const adapter = brokerAdapterFor(acct);
            const res = await adapter.getEquityPositions(env, acct);
            if (res?.ok && Array.isArray(res.positions)) {
              positions = res.positions;
              if (env.BRIDGE_KV) {
                ctx?.waitUntil?.(env.BRIDGE_KV.put(cacheKey,
                  JSON.stringify({ ts: Date.now(), positions }),
                  { expirationTtl: 3600 }).catch(() => {}));
              }
            }
          }
          for (const p of positions || []) {
            const sym = String(p?.ticker || p?.symbol || p?.instrument_symbol || "").toUpperCase();
            if (sym !== ticker) continue;
            held = {
              qty: Number(p?.quantity ?? p?.qty ?? p?.position ?? p?.units) || 0,
              avg_cost: Number(p?.avg_cost ?? p?.average_cost ?? p?.cost_price ?? p?.avgPrice) || null,
            };
            break;
          }
        } catch (e) {
          return json({ ok: false, error: `positions_unavailable:${String(e?.message || e).slice(0, 120)}` }, 200);
        }
        if (!held || !(held.qty > 0)) {
          return json({ ok: false, error: "account_holds_no_shares", note: "Nothing to adopt — this account is flat in the ticker. The model buys in during its natural windows instead." }, 200);
        }
        // Rationalize the sleeve to the model's sizing for THIS account:
        // scaled = model qty × (account equity / model capital), capped at
        // what the account actually holds. Equity comes from the
        // reconciler's account snapshot — refuse rather than guess.
        let equity = null;
        try {
          const { readAccountSnapshots } = await import("./bridge-account-ledger.js");
          const snaps = await readAccountSnapshots(env, { owner_id: owner });
          const snap = snaps.find((s) => String(s.broker_account_id) === String(brokerAccountId));
          if (snap && Number(snap.equity_usd) > 0) equity = Number(snap.equity_usd);
        } catch (_) { /* handled below */ }
        if (!(equity > 0)) {
          return json({ ok: false, error: "account_equity_unknown", note: "The account snapshot has no equity yet — the reconciler refreshes it within minutes of connecting. Retry shortly." }, 200);
        }
        const scaledTarget = Math.floor(modelQty * (equity / modelCapital) * 1e5) / 1e5;
        if (!(scaledTarget > 0)) {
          return json({ ok: false, error: "scaled_target_zero", note: "The model's allocation scales below a placeable size for this account." }, 200);
        }
        const adoptQty = Math.min(held.qty, scaledTarget);
        const tradeId = modelTradeId.startsWith("inv-") ? modelTradeId : `inv-${modelTradeId}`;
        const { adoptUserPosition } = await import("./bridge-manifest.js");
        const result = await adoptUserPosition(env, {
          userId: accountId,
          tradeId,
          brokerAccountId,
          broker: resolveBrokerId(acct) || acct.broker || "webull",
          mode: "investor",
          ticker,
          direction: "LONG",
          modelIntendedQty: adoptQty,
          adoptQty,
          brokerAvgCost: held.avg_cost,
          note: `adopted_user_position sleeve=${adoptQty} held=${held.qty} scaled_target=${scaledTarget}`,
        });
        if (!result?.ok) return json({ ok: false, error: result?.reason || "adopt_failed" }, 200);
        await writeAudit(env, {
          ts: Date.now(),
          user_id: accountId,
          trade_id: tradeId,
          ticker,
          action: "adopt_position",
          side: "adopt",
          qty: adoptQty,
          status: "ok",
          request_json: {
            owner, broker_account_id: brokerAccountId,
            held_qty: held.qty, scaled_target: scaledTarget,
            adopt_qty: adoptQty, excess_user_qty: Math.max(0, held.qty - adoptQty),
            model_qty: modelQty, model_capital_usd: modelCapital, equity_usd: equity,
          },
        }).catch(() => {});
        return json({
          ok: true,
          ticker,
          account_id: accountId,
          adopted_qty: adoptQty,
          held_qty: held.qty,
          scaled_target: scaledTarget,
          excess_user_qty: Math.max(0, Math.floor((held.qty - adoptQty) * 1e5) / 1e5),
          avg_cost: held.avg_cost,
          trade_id: tradeId,
          orders_placed: 0,
        }, 200);
      }
      // 2026-08-13 — Day view for ONE owner (Broker Connections page):
      // every per-account fill/reject from the account ledger plus the
      // order-path audit rows (rejects with reasons, dedupes) in the
      // window. The main worker joins these against the MODEL's own
      // ledger to build the "what did the model do and did this account
      // follow" timeline.
      if (method === "GET" && path === "/bridge/day-actions") {
        if (operatorFail) return operatorFail;
        const owner = String(url.searchParams.get("owner") || "").trim().toLowerCase();
        if (!owner) return json({ ok: false, error: "owner_required" }, 400);
        const hours = Math.min(744, Math.max(1, Number(url.searchParams.get("hours")) || 36));
        const sinceMs = Date.now() - hours * 3600 * 1000;
        const db = env?.BRIDGE_DB;
        let ledger = [];
        let audit = [];
        if (db) {
          try {
            const { ensureAccountLedgerSchema } = await import("./bridge-account-ledger.js");
            await ensureAccountLedgerSchema(env);
            const r = await db.prepare(`
              SELECT ts, owner_id, user_id, broker, broker_account_id, model_trade_id,
                     client_order_id, broker_order_id, ticker, side, event_type,
                     qty, price, value, status, reject_reason
                FROM broker_account_ledger
               WHERE (owner_id = ?1 OR user_id = ?1 OR user_id LIKE ?1 || '#%')
                 AND ts >= ?2
               ORDER BY ts DESC LIMIT 800
            `).bind(owner, sinceMs).all();
            ledger = r?.results || [];
          } catch (e) {
            console.warn("[DAY_ACTIONS] ledger read failed:", String(e?.message || e).slice(0, 160));
          }
          try {
            const r = await db.prepare(`
              SELECT ts, user_id, trade_id, ticker, action, side, qty,
                     estimated_value, status, reject_reason
                FROM bridge_audit
               WHERE (user_id = ?1 OR user_id LIKE ?1 || '#%')
                 AND ts >= ?2
                 AND action IN ('place','reject','dedupe_skip','reducer_rejected','post_exec_drift')
               ORDER BY ts DESC LIMIT 300
            `).bind(owner, sinceMs).all();
            audit = r?.results || [];
          } catch (e) {
            console.warn("[DAY_ACTIONS] audit read failed:", String(e?.message || e).slice(0, 160));
          }
        }
        const accounts = (await resolveBridgeAccounts(env, owner, { enabledOnly: false }))
          .filter((u) => String(u?.status || "").toLowerCase() === "connected")
          .map((u) => ({
            account_id: u.user_id,
            broker_account_id: resolveBrokerAccountId(u),
            broker: resolveBrokerId(u) || u.broker || null,
            label: u.webull_account_label || u.webull_account_class || null,
            mirror_enabled: u.broker_integration_enabled === true,
            connected_at: Number(u.connected_at) || null,
            enable_changed_at: Number(u.enable_changed_at) || null,
            mirror_events: Array.isArray(u.mirror_events) ? u.mirror_events : [],
          }));
        return json({ ok: true, owner, since: sinceMs, accounts, ledger, audit, ts: Date.now() });
      }
      if (method === "GET" && path === "/bridge/audit") {
        if (operatorFail) return operatorFail;
        const rows = await recentAudit(env, {
          user_id: url.searchParams.get("user_id"),
          limit: Number(url.searchParams.get("limit")) || 50,
        });
        return json({ ok: true, count: rows.length, rows });
      }

      // 2026-07-20 — Per-account ledger (real fills tied to each account).
      if (method === "GET" && path === "/bridge/account-ledger") {
        if (operatorFail) return operatorFail;
        const rows = await readAccountLedger(env, {
          broker_account_id: url.searchParams.get("broker_account_id"),
          owner_id: url.searchParams.get("owner_id"),
          limit: Number(url.searchParams.get("limit")) || 100,
        });
        return json({ ok: true, count: rows.length, rows });
      }

      // 2026-08-13 — Per-account equity samples + mirror on/off markers
      // for the Broker Connections growth chart.
      if (method === "GET" && path === "/bridge/equity-curve") {
        if (operatorFail) return operatorFail;
        const owner = String(url.searchParams.get("owner") || "").trim().toLowerCase();
        if (!owner) return json({ ok: false, error: "owner_required" }, 400);
        const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
        const connected = (await resolveBridgeAccounts(env, owner, { enabledOnly: false }))
          .filter((u) => String(u?.status || "").toLowerCase() === "connected");
        // Refresh equity for all connected accounts (not just mirror-on) so
        // value history cards/charts include Futures / Cash / Margin / etc.
        try {
          await ensureConnectedAccountsEquity(env, connected, {
            adapterFor: brokerAdapterFor,
            force: url.searchParams.get("refresh") === "1",
          });
        } catch (_) { /* best-effort */ }
        try {
          const snaps = await readAccountSnapshots(env, { owner_id: owner });
          for (const s of snaps) {
            if (Number.isFinite(Number(s.equity_usd))) {
              await recordEquityPoint(env, {
                broker_account_id: s.broker_account_id,
                ts: Date.now(),
                equity_usd: s.equity_usd,
              });
            }
          }
        } catch (_) { /* stamp is best-effort */ }
        const history = await readEquityHistory(env, { owner_id: owner, since_ts: since });
        const byBrokerId = new Map(connected.map((u) => [String(resolveBrokerAccountId(u)), u]));
        const claimed = new Set();
        const series = history.map((h) => {
          const u = byBrokerId.get(String(h.broker_account_id))
            || connected.find((a) => String(a.user_id) === String(h.user_id));
          if (u) claimed.add(String(resolveBrokerAccountId(u)));
          const events = Array.isArray(u?.mirror_events) ? u.mirror_events : [];
          let markers = events
            .filter((e) => e && Number(e.ts) > 0)
            .map((e) => ({ ts: Number(e.ts), on: e.on === true }));
          if (!markers.length) {
            const ts = Number(u?.enable_changed_at) || Number(u?.connected_at) || 0;
            if (ts && u?.broker_integration_enabled === true) markers.push({ ts, on: true });
          }
          markers.sort((a, b) => a.ts - b.ts);
          const pts = h.points || [];
          const lastEq = pts.length ? pts[pts.length - 1].equity : null;
          const firstOn = markers.find((m) => m.on)?.ts;
          let base = null;
          if (firstOn && pts.length) {
            for (const p of pts) {
              if (p.ts <= firstOn) base = p.equity;
              else {
                if (base == null) base = p.equity;
                break;
              }
            }
          }
          const sinceMirror = (Number.isFinite(lastEq) && Number.isFinite(base)) ? lastEq - base : null;
          return {
            broker_account_id: h.broker_account_id,
            user_id: h.user_id || u?.user_id || null,
            label: h.label || u?.webull_account_label || u?.webull_account_class || h.broker_account_id,
            broker: h.broker || (u ? (resolveBrokerId(u) || u.broker) : null),
            mirror_enabled: u ? u.broker_integration_enabled === true : false,
            points: pts,
            markers,
            equity: lastEq,
            since_mirror_gain: sinceMirror,
          };
        });
        // Include connected accounts that still have no history row.
        for (const u of connected) {
          const bid = String(resolveBrokerAccountId(u) || "");
          if (!bid || claimed.has(bid)) continue;
          const eq = Number(u.equity_usd);
          series.push({
            broker_account_id: bid,
            user_id: u.user_id || null,
            label: u.webull_account_label || u.webull_account_class || bid,
            broker: resolveBrokerId(u) || u.broker || null,
            mirror_enabled: u.broker_integration_enabled === true,
            points: Number.isFinite(eq) ? [{ ts: Date.now(), equity: eq }] : [],
            markers: [],
            equity: Number.isFinite(eq) ? eq : null,
            since_mirror_gain: null,
          });
        }
        return json({ ok: true, owner, accounts: series, ts: Date.now() });
      }

      // 2026-07-20 — Per-account sync snapshots (broker truth vs system).
      if (method === "GET" && path === "/bridge/account-snapshots") {
        if (operatorFail) return operatorFail;
        const rows = await readAccountSnapshots(env, {
          owner_id: url.searchParams.get("owner_id"),
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
        const users = (await listConnectedUsers(env))
          .filter((u) => String(u?.status || "").toLowerCase() === "connected");
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
              const totals = extractPortfolioTotals(portfolio) || {};
              const equity = Number(totals.equity_usd);
              const cash = Number(totals.cash_usd);
              const buyingPower = Number(totals.buying_power_usd);
              const r = portfolio.response || portfolio;
              const acct = (Array.isArray(portfolio.accounts) && portfolio.accounts[0]) || portfolio.summary || r;
              const acctId = String(
                u.webull_account_id
                || u.ibkr_account_id
                || acct?.accountcode?.value || acct?.accountId || acct?.account || ""
              ).trim();
              summary.equity_usd = Number.isFinite(equity) ? equity : null;
              summary.cash_usd = Number.isFinite(cash) ? cash : null;
              summary.buying_power_usd = Number.isFinite(buyingPower) ? buyingPower : null;
              if (acctId) summary.account_id = acctId;
              // Persist equity onto the user row + account snapshot/history
              // so Brokers page value charts work for every connected
              // account (mirror on or off).
              try {
                const fresh = await readUser(env, userId);
                if (fresh) {
                  if (Number.isFinite(equity)) fresh.equity_usd = equity;
                  if (Number.isFinite(cash))   fresh.cash_usd = cash;
                  if (Number.isFinite(buyingPower)) fresh.buying_power_usd = buyingPower;
                  fresh.portfolio_synced_at = Date.now();
                  await writeUser(env, userId, fresh);
                  // No second broker call — refresh reads the user row we
                  // just stamped and writes snapshot + equity history.
                  await refreshAccountEquitySnapshot(env, fresh, { adapter: null, force: false });
                }
              } catch (e) {
                console.warn(`[BRIDGE] failed to persist portfolio snapshot for ${userId}: ${String(e?.message || e).slice(0, 200)}`);
              }
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

      // 2026-06-01 — Per-vehicle options auto-mirror prefs for a single
      // user. Mirrors the worker/options-auto-mirror.js VEHICLE_DEFAULTS
      // shape; the bridge stores the inflated map on the user record so
      // bridge-guards.validateVehiclePrefs can enforce it without making
      // an extra KV round-trip per order.
      //
      // Payload:
      //   { user_id, vehicles: { long_call: { enabled, max_per_order_usd,
      //     daily_cap, max_loss_per_order_usd }, ... } }
      // OR
      //   { user_id, apply_small_account_defaults: true }
      //   (writes a known-safe small-account preset)
      //
      // Naked-short vehicle keys are silently stripped (defense in depth
      // — the engine already short-circuits before reaching here).
      if (method === "POST" && path === "/bridge/user/options-prefs") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const userId = String(body?.user_id || "").trim().toLowerCase();
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);

        const NAKED = new Set([
          "short_call", "short_put", "iron_condor_naked", "short_straddle",
          "short_strangle", "short_combo", "covered_call_naked",
        ]);
        const RECOGNIZED = new Set([
          "equity_long", "long_call", "long_put", "vertical_spread",
          "leaps", "straddle", "moonshot",
        ]);
        // 2026-07-22 — equity_long bumped from a 3/day + $300 preset that
        // was clearly copy-pasted from the options-moonshot rows below.
        // A real small IRA (e.g. Roth $16.5k) can't mirror trader entries
        // at $300 — SPHB 9.7 shares × $145 = $1,420 alone exceeds it and
        // was hard-rejected pre-fix. New default: $5,000/order (matches
        // DEFAULT_MAX_ORDER_USD, which is the global governing cap
        // anyway) + 10 orders/day. Post-sizing scale-to-fit in
        // applyVehicleNotionalCap now guarantees an order still lands
        // even if a user leaves the cap low intentionally.
        const SMALL_ACCOUNT_DEFAULTS = {
          equity_long:     { enabled: true,  daily_cap: 10, max_per_order_usd: 5000 },
          long_call:       { enabled: false, daily_cap: 2, max_per_order_usd: 200, max_loss_per_order_usd: 75 },
          long_put:        { enabled: false, daily_cap: 2, max_per_order_usd: 200, max_loss_per_order_usd: 75 },
          vertical_spread: { enabled: false, daily_cap: 2, max_per_order_usd: 200, max_loss_per_order_usd: 75 },
          leaps:           { enabled: false, daily_cap: 1, max_per_order_usd: 500, max_loss_per_order_usd: 500 },
          straddle:        { enabled: false, daily_cap: 1, max_per_order_usd: 300, max_loss_per_order_usd: 200 },
          moonshot:        { enabled: false, daily_cap: 1, max_per_order_usd: 100, max_loss_per_order_usd: 100 },
        };

        const current = user.options_prefs?.vehicles || {};
        let nextVehicles;
        if (body?.apply_small_account_defaults === true) {
          nextVehicles = JSON.parse(JSON.stringify(SMALL_ACCOUNT_DEFAULTS));
        } else {
          nextVehicles = { ...current };
          for (const [k, row] of Object.entries(body?.vehicles || {})) {
            const key = String(k || "").toLowerCase();
            if (NAKED.has(key)) continue;
            if (!RECOGNIZED.has(key)) continue;
            // Validate each field; reject negative / absurd values.
            const next = { ...(current[key] || {}) };
            if (row?.enabled !== undefined) next.enabled = !!row.enabled;
            if (row?.daily_cap !== undefined) {
              const v = Number(row.daily_cap);
              if (!Number.isFinite(v) || v < 0 || v > 100) {
                return json({ ok: false, error: `${key}_daily_cap_must_be_0_to_100` }, 400);
              }
              next.daily_cap = Math.round(v);
            }
            if (row?.max_per_order_usd !== undefined) {
              const v = Number(row.max_per_order_usd);
              if (!Number.isFinite(v) || v <= 0 || v > 100_000) {
                return json({ ok: false, error: `${key}_max_per_order_usd_must_be_1_to_100000` }, 400);
              }
              next.max_per_order_usd = Math.round(v);
            }
            if (row?.max_loss_per_order_usd !== undefined) {
              const v = Number(row.max_loss_per_order_usd);
              if (!Number.isFinite(v) || v < 0 || v > 100_000) {
                return json({ ok: false, error: `${key}_max_loss_per_order_usd_must_be_0_to_100000` }, 400);
              }
              next.max_loss_per_order_usd = Math.round(v);
            }
            nextVehicles[key] = next;
          }
        }
        user.options_prefs = { ...(user.options_prefs || {}), vehicles: nextVehicles };
        user.options_prefs_updated_at = Date.now();
        await writeUser(env, userId, user);
        return json({
          ok: true, user_id: userId,
          options_prefs: user.options_prefs,
          options_enabled: !!user.options_enabled,
          updated_at: user.options_prefs_updated_at,
        });
      }

      // GET /bridge/user/options-prefs?user_id=X — read-only inspector
      if (method === "GET" && path === "/bridge/user/options-prefs") {
        if (operatorFail) return operatorFail;
        const userId = String(url.searchParams.get("user_id") || "").trim().toLowerCase();
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);
        return json({
          ok: true, user_id: userId,
          options_prefs: user.options_prefs || null,
          options_enabled: !!user.options_enabled,
          updated_at: user.options_prefs_updated_at || null,
        });
      }

      // 2026-08-24 — Self-service options-strategy toggle (Broker Connections).
      // Sets options_enabled + long_call / long_put vehicles. Ownership is
      // enforced by the main worker before this is proxied.
      if (method === "POST" && path === "/bridge/user/options-enable") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const userId = String(body?.user_id || "").trim().toLowerCase();
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);
        if (user.status !== "connected") {
          return json({ ok: false, error: `user_status_${user.status}_must_be_connected` }, 400);
        }
        const { applyOptionsStrategyPatch } = await import("./bridge-options-prefs.js");
        const next = applyOptionsStrategyPatch(user, {
          options_enabled: typeof body?.options_enabled === "boolean" ? body.options_enabled : undefined,
          vehicles: body?.vehicles || null,
        });
        await writeUser(env, userId, next);
        return json({
          ok: true,
          user_id: userId,
          options_enabled: !!next.options_enabled,
          options_prefs: next.options_prefs,
          updated_at: next.options_prefs_updated_at,
        });
      }

      // 2026-06-01 — Phase A: mirror trade manifest debug view.
      // Operator-only. Returns the N most recent manifest rows ordered
      // by updated_at DESC. Mission Control renders a table beneath
      // the Bridge section so the operator can verify the writer is
      // populating rows after each ENTRY/ADD.
      if (method === "GET" && path === "/bridge/manifest") {
        if (operatorFail) return operatorFail;
        const userId = url.searchParams.get("user_id");
        const limit = Number(url.searchParams.get("limit")) || 50;
        const sinceMs = Number(url.searchParams.get("since_ms")) || 0;
        const rows = await recentManifestRows(env, { user_id: userId, limit, since_ms: sinceMs });
        // Surface counts by sync_state to make MC stats easy.
        const counts = {};
        for (const r of rows) {
          const k = r.sync_state || "unknown";
          counts[k] = (counts[k] || 0) + 1;
        }
        return json({
          ok: true, rows, counts,
          total_returned: rows.length,
          server_time: Date.now(),
        });
      }
      if (method === "GET" && path === "/bridge/manifest/row") {
        if (operatorFail) return operatorFail;
        const userId = url.searchParams.get("user_id");
        const tradeId = url.searchParams.get("trade_id");
        const accountId = url.searchParams.get("broker_account_id") || "default";
        if (!userId || !tradeId) return json({ ok: false, error: "user_id_and_trade_id_required" }, 400);
        const row = await readManifestRow(env, userId, tradeId, accountId);
        return json({ ok: true, row });
      }

      // 2026-06-01 — Phase E: operator action endpoints for the MC
      // "Mirror Sync — Per-User" panel. Each one mutates a single
      // manifest row. All operator-only.
      if (method === "POST" && path === "/bridge/manifest/action") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const action = String(body?.action || "").toLowerCase();
        const userId = String(body?.user_id || "").toLowerCase();
        const tradeId = String(body?.trade_id || "");
        const accountId = String(body?.broker_account_id || "default");
        if (!userId || !tradeId) return json({ ok: false, error: "user_id_and_trade_id_required" }, 400);

        const validActions = new Set(["suppress", "unsuppress", "mark_manual", "mark_closed", "force_resync_from_broker"]);
        if (!validActions.has(action)) return json({ ok: false, error: `invalid_action:${action}` }, 400);

        const db = env?.BRIDGE_DB;
        if (!db) return json({ ok: false, error: "no_db" }, 500);
        const now = Date.now();
        const reasonText = String(body?.reason || `operator_${action}`).slice(0, 200);
        try {
          if (action === "suppress") {
            await db.prepare(`UPDATE mirror_trade_manifest SET mirror_suppressed=1, mirror_suppressed_at=?4, mirror_suppressed_reason=?5, sync_note=?5, updated_at=?4 WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3`)
              .bind(userId, tradeId, accountId, now, reasonText).run();
          } else if (action === "unsuppress") {
            await db.prepare(`UPDATE mirror_trade_manifest SET mirror_suppressed=0, mirror_suppressed_at=NULL, mirror_suppressed_reason=NULL, sync_drift_count=0, sync_note='operator_unsuppressed', updated_at=?4 WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3`)
              .bind(userId, tradeId, accountId, now).run();
          } else if (action === "mark_manual") {
            await db.prepare(`UPDATE mirror_trade_manifest SET sync_state='untracked', mirror_suppressed=1, mirror_suppressed_at=?4, mirror_suppressed_reason=?5, sync_note=?5, updated_at=?4 WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3`)
              .bind(userId, tradeId, accountId, now, `operator_marked_manual:${reasonText}`.slice(0, 200)).run();
          } else if (action === "mark_closed") {
            await db.prepare(`UPDATE mirror_trade_manifest SET model_status='CLOSED', model_exit_ts=?4, model_exit_reason=?5, sync_note=?5, updated_at=?4 WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3`)
              .bind(userId, tradeId, accountId, now, `operator_marked_closed:${reasonText}`.slice(0, 200)).run();
          } else if (action === "force_resync_from_broker") {
            // Bumps sync_last_checked_at backwards so the next reconciler
            // cycle treats this row as eligible regardless of cadence.
            await db.prepare(`UPDATE mirror_trade_manifest SET sync_last_checked_at=0, sync_note='operator_forced_resync', updated_at=?4 WHERE user_id=?1 AND trade_id=?2 AND broker_account_id=?3`)
              .bind(userId, tradeId, accountId, now).run();
          }
          return json({ ok: true, action, user_id: userId, trade_id: tradeId, updated_at: now });
        } catch (e) {
          return json({ ok: false, error: String(e?.message || e).slice(0, 200) }, 500);
        }
      }

      // 2026-06-01 — Phase E: drain the bridge notify queue. Returns
      // queued user-email payloads. The MAIN worker calls this from
      // its own cron and sends via SendGrid. Operator-only.
      if (method === "POST" && path === "/bridge/notify/drain") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const limit = Number(body?.limit) || 200;
        // peek=true when the main worker is previewing (send !== true) so
        // we don't wipe the queue without delivering.
        const peek = body?.peek === true || body?.send === false;
        const items = await drainNotifyQueue(env, { limit, peek });
        return json({ ok: true, count: items.length, items, peek: !!peek });
      }

      // 2026-06-01 — Phase E: daily owner digest preview/build. Returns
      // the digest payload for one user (or all). Caller (main worker
      // cron at 21:30 UTC) renders + sends via SendGrid.
      if (method === "POST" && path === "/bridge/notify/daily-digest") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const dryRun = body?.dry_run === true;
        const targetUserId = body?.user_id ? String(body.user_id).toLowerCase() : null;
        const users = targetUserId
          ? [await readUser(env, targetUserId)].filter(Boolean)
          : await listConnectedUsers(env, 100);
        const eligible = users.filter(u => u && u.status === "connected" && u.broker_integration_enabled);
        const out = [];
        for (const u of eligible) {
          try {
            const adapter = brokerAdapterFor(u);
            const digest = await buildDailyOwnerDigest(env, u, adapter);
            if (!digest) { out.push({ user_id: u.user_id, status: "no_digest" }); continue; }
            if (digest.skip) { out.push({ user_id: u.user_id, status: "skipped", reason: digest.reason }); continue; }
            const email = renderDailyOwnerDigestEmail(digest);
            out.push({
              user_id: u.user_id,
              user_email: digest.user_email,
              status: dryRun ? "rendered_only" : "ready_to_send",
              subject: email?.subject,
              digest_summary: {
                executed_count: digest.executed.length,
                rejected_count: digest.rejected_count,
                day_pnl: digest.day_pnl,
                positions_count: digest.positions.length,
                options_count: digest.options_positions.length,
              },
              email: dryRun ? null : email,
            });
          } catch (e) {
            out.push({ user_id: u.user_id, status: "error", error: String(e?.message || e).slice(0, 200) });
          }
        }
        return json({ ok: true, dry_run: dryRun, users_processed: out.length, items: out });
      }

      // 2026-06-01 — Phase C: on-demand reconciliation. Operator-only.
      // Body:
      //   { user_id?: string,        // single user; if omitted, all eligible
      //     dry_run?: boolean,       // don't persist updates
      //     limit?: number }         // max rows per user per cycle
      // Returns aggregate stats per user + cluster aggregate.
      // Cron runs this every 5 min during RTH; the on-demand endpoint
      // is for "fix it now" diagnostics from Mission Control.
      if (method === "POST" && path === "/bridge/reconcile") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const dryRun = body?.dry_run === true;
        const limit = Number(body?.limit) || 100;
        const targetUserId = body?.user_id ? String(body.user_id).toLowerCase() : null;
        const runReconcile = async () => {
          if (targetUserId) {
            const u = await readUser(env, targetUserId);
            if (!u) return json({ ok: false, error: "user_not_found" }, 404);
            const adapter = brokerAdapterFor(u);
            const stats = await reconcileUser(env, u, adapter, { limit, dryRun });
            return json({ ok: true, single_user: true, stats, dry_run: dryRun });
          }
          return reconcileAllUsers(
            env,
            () => listConnectedUsers(env, 100),
            (u) => brokerAdapterFor(u),
            { dryRun },
          );
        };
        const result = await runReconcile();
        // Heartbeat for main-worker sanity sweep (shared KV_TIMED).
        try {
          const kv = env?.KV_TIMED || env?.BRIDGE_KV;
          if (kv) {
            await kv.put("bridge:reconciler:last_run", String(Date.now()), { expirationTtl: 24 * 3600 });
          }
        } catch (_) {}
        if (result instanceof Response) return result;
        return json(result);
      }

      if (method === "POST" && path === "/bridge/enable") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const userId = String(body?.user_id || "").trim().toLowerCase();
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);
        if (user.status !== "connected") {
          return json({ ok: false, error: `user_status_${user.status}_must_be_connected` }, 400);
        }
        // enable may be omitted when only stamping fractional_agreement_missing
        if (typeof body?.enable === "boolean") {
          const next = body.enable === true;
          const prev = user.broker_integration_enabled === true;
          user.broker_integration_enabled = next;
          user.enable_changed_at = Date.now();
          if (next !== prev) {
            const events = Array.isArray(user.mirror_events) ? user.mirror_events.slice() : [];
            events.push({ ts: Date.now(), on: next });
            user.mirror_events = events.slice(-40);
          }
        }
        // 2026-08-11 — Self-service opt-in: set by the main worker's
        // Broker Connections flow so this account joins the model-signal
        // dispatch (see listMirrorParticipants). Disabling the account
        // also clears participation via the broker_integration_enabled
        // check; the flag records provenance (user-driven mirror).
        if (typeof body?.mirror_participant === "boolean") {
          user.mirror_participant = body.mirror_participant === true;
        }
        // 2026-07-23 — Operator stamp: force whole-share preflight on a
        // Webull account that has not signed TRADE_FRACT_PRO (Roth IRA).
        if (body?.fractional_agreement_missing === true) {
          user.fractional_agreement_missing = true;
          if (body?.fractional_agreement_url) {
            user.fractional_agreement_url = String(body.fractional_agreement_url).slice(0, 500);
          }
          user.fractional_agreement_flagged_at = Date.now();
        } else if (body?.fractional_agreement_missing === false) {
          user.fractional_agreement_missing = false;
          user.fractional_agreement_url = null;
          user.fractional_agreement_flagged_at = null;
        }
        await writeUser(env, userId, user);
        return json({
          ok: true,
          user_id: userId,
          broker_integration_enabled: !!user.broker_integration_enabled,
          fractional_agreement_missing: !!user.fractional_agreement_missing,
          fractional_agreement_url: user.fractional_agreement_url || null,
        });
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

      // 2026-07-21 — Probe RH's MCP OAuth discovery + client registration
      // BEFORE attempting a real connect. Confirms the auth-server endpoints,
      // PKCE support, and whether DCR works — so we know our headless OAuth
      // will succeed (or which env overrides to set) ahead of time. Read-only.
      if (method === "GET" && path === "/bridge/test/rh-oauth-discovery") {
        if (operatorFail) return operatorFail;
        const { discoverRhAuth, ensureRhClient, mcpResource } = await import("./bridge-robinhood-auth.js");
        const disc = await discoverRhAuth(env);
        let client = { ok: false, skipped: "discovery_failed" };
        if (disc.ok) {
          const redirectUri = env?.OAUTH_REDIRECT_URI || `${url.origin}/bridge/oauth/callback`;
          client = await ensureRhClient(env, disc.asMeta, redirectUri).catch((e) => ({ ok: false, error: String(e?.message || e).slice(0, 160) }));
          // Don't leak a client secret in the probe response.
          if (client?.client_secret) client = { ...client, client_secret: "[present]" };
        }
        return json({
          ok: disc.ok,
          resource: mcpResource(env),
          discovery: disc.ok
            ? {
                source: disc.source, cached: !!disc.cached, scope: disc.scope,
                authorization_endpoint: disc.asMeta?.authorization_endpoint,
                token_endpoint: disc.asMeta?.token_endpoint,
                registration_endpoint: disc.asMeta?.registration_endpoint,
                pkce_s256: (disc.asMeta?.code_challenge_methods_supported || []).includes("S256"),
              }
            : { error: disc.error },
          client: client.ok
            ? { ok: true, source: client.source, client_id: client.client_id, has_secret: client.client_secret === "[present]" }
            : client,
          redirect_uri: env?.OAUTH_REDIRECT_URI || `${url.origin}/bridge/oauth/callback`,
        });
      }

      if (method === "POST" && path === "/bridge/test/webull-call") {
        if (operatorFail) return operatorFail;
        const body = await req.json().catch(() => ({}));
        const userId = String(body?.user_id || "").trim().toLowerCase();
        const action = String(body?.action || "get_portfolio").trim();
        const args = body?.args || {};
        if (!userId) return json({ ok: false, error: "user_id_required" }, 400);
        const user = await readUser(env, userId);
        if (!user) return json({ ok: false, error: "user_not_found" }, 404);
        if (String(user.broker || "").toLowerCase() !== "webull") {
          return json({ ok: false, error: "user_broker_not_webull", broker: user.broker || null }, 400);
        }
        const result = await WebullAdapter.callWebullAction(env, user, action, args);
        return json({ ok: true, action, ...result });
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

      if (method === "POST" && path === "/bridge/options/order/status") {
        const rawBody = await req.text();
        const sigFail = await requireWebhookSignature(env, req, rawBody);
        if (sigFail) return sigFail;
        let payload;
        try { payload = JSON.parse(rawBody); } catch (_) { return json({ ok: false, error: "bad_json" }, 400); }
        return await handleOptionsOrderStatus(env, payload);
      }

      return json({ ok: false, error: "not_found", path }, 404);
    } catch (e) {
      console.error("[BRIDGE] uncaught:", String(e?.message || e).slice(0, 500));
      return json({ ok: false, error: "internal_error", detail: String(e?.message || e).slice(0, 200) }, 500);
    }
  },

  // 2026-06-01 — Cron triggers (Phase C reconciler + Phase E daily digest).
  // Configured in wrangler.toml as: triggers.crons = ["*/5 * * * *", "30 21 * * *"]
  //
  // The handler routes on event.cron:
  //   "*/5 * * * *" → reconciler (gates on RTH)
  //   "30 21 * * *" → daily owner digest builder (4:30pm ET / 21:30 UTC)
  //
  // Daily digest only BUILDS the payloads on the bridge; the main worker
  // drains the result via POST /bridge/notify/daily-digest and sends
  // via SendGrid (it owns the SENDGRID_API_KEY secret).
  async scheduled(event, env, ctx) {
    const t0 = Date.now();
    const cron = String(event?.cron || "*/5 * * * *");
    try {
      await ensureBridgeSchema(env).catch(() => {});

      // ── Daily Owner Digest cron (21:30 UTC) ─────────────────────────
      if (cron === "30 21 * * *") {
        // Weekends and market holidays produced a "0 fills / No fills or syncs
        // today" email restating unchanged positions. Set
        // DAILY_DIGEST_IGNORE_CALENDAR=true to send every day again.
        const ignoreCalendar = String(env?.DAILY_DIGEST_IGNORE_CALENDAR || "false").toLowerCase() === "true";
        const calendar = shouldBuildDailyDigest(Date.now(), { ignoreCalendar });
        if (!calendar.send) {
          console.log(`[DAILY_DIGEST] skipped et_date=${calendar.et_date} reason=${calendar.reason}`);
          return;
        }
        const dryRun = String(env?.DAILY_DIGEST_DRY_RUN || "false").toLowerCase() === "true";
        const users = await listConnectedUsers(env, 100);
        const eligible = users.filter(u => u && u.status === "connected" && u.broker_integration_enabled);
        let prepared = 0, skipped = 0, errored = 0;
        for (const u of eligible) {
          try {
            const adapter = brokerAdapterFor(u);
            const digest = await buildDailyOwnerDigest(env, u, adapter);
            if (!digest || digest.skip) { skipped++; continue; }
            // Stash rendered email in the notify queue for the main
            // worker's cron to pick up.
            const email = renderDailyOwnerDigestEmail(digest);
            if (!email) { skipped++; continue; }
            // Partner accounts (notify_emails on the user row): one queue
            // item per recipient (partner + admin). Others: unchanged.
            const recipients = resolveNotifyRecipients(env, u) || [digest.user_email];
            const day = new Date().toISOString().slice(0, 10);
            for (const recipient of recipients) {
              const queueKey = `bridge:notify:daily:${u.user_id}:${day}${recipients.length > 1 ? `:${recipient}` : ""}`;
              await env.BRIDGE_KV.put(queueKey, JSON.stringify({
                user_id: u.user_id,
                user_email: recipient || digest.user_email,
                kind: "daily_owner_digest",
                ts: Date.now(),
                dry_run: dryRun,
                content: email,
                digest_summary: digest,
              }), { expirationTtl: 7 * 86400 });
            }
            prepared++;
          } catch (e) {
            errored++;
            console.warn(`[DAILY_DIGEST] user ${u?.user_id} failed:`, String(e?.message || e).slice(0, 200));
          }
        }
        console.log(`[DAILY_DIGEST] prepared=${prepared} skipped=${skipped} errored=${errored} elapsed=${Date.now() - t0}ms`);
        return;
      }

      // ── 5-min reconciler cron (Phase C) ────────────────────────────
      const refreshSummary = await refreshWebullTokensIfNeeded(env).catch((e) => {
        console.warn("[WEBULL/REFRESH] cron failed:", String(e?.message || e).slice(0, 200));
        return null;
      });
      if (refreshSummary && refreshSummary.refreshed > 0) {
        console.log(`[WEBULL/REFRESH] refreshed=${refreshSummary.refreshed} failed=${refreshSummary.failed}`);
      }

      // Robinhood MCP OAuth token refresh (headless).
      const rhRefresh = await refreshRhTokensIfNeeded(env).catch((e) => {
        console.warn("[RH/REFRESH] cron failed:", String(e?.message || e).slice(0, 200));
        return null;
      });
      if (rhRefresh && rhRefresh.refreshed > 0) {
        console.log(`[RH/REFRESH] refreshed=${rhRefresh.refreshed} failed=${rhRefresh.failed}`);
      }

      // Operating-hours gate: skip when NY market is closed (we don't
      // expect drift on closed markets). Operator can flip BROKER_
      // RECONCILE_24_7=true if they want continuous sweeps (useful
      // for Investor mode + post-market drift detection).
      // Always tick the shared heartbeat so sanity-sweep can tell "cron
      // alive but gated" from "cron dead". last_run stays RTH-only below.
      const _writeReconcilerTick = async () => {
        try {
          const kv = env?.KV_TIMED || env?.BRIDGE_KV;
          if (kv) {
            await kv.put("bridge:reconciler:last_tick", String(Date.now()), { expirationTtl: 24 * 3600 });
          }
        } catch (hbErr) {
          console.warn("[RECONCILER_TICK] write failed:", String(hbErr?.message || hbErr).slice(0, 120));
        }
      };

      if (String(env?.BROKER_RECONCILE_24_7 || "false").toLowerCase() !== "true") {
        const dt = new Date();
        const hourUtc = dt.getUTCHours();
        const dow = dt.getUTCDay();
        const isWeekend = (dow === 0 || dow === 6);
        const isMarketHours = !isWeekend && hourUtc >= 13 && hourUtc <= 22;
        if (!isMarketHours) {
          await _writeReconcilerTick();
          console.log(`[RECONCILER] skip off-hours (hourUtc=${hourUtc}, dow=${dow})`);
          return;
        }
      }
      const dryRun = String(env?.BROKER_RECONCILE_DRY_RUN || "false").toLowerCase() === "true";
      const result = await reconcileAllUsers(
        env,
        () => listConnectedUsers(env, 100),
        (u) => brokerAdapterFor(u),
        { dryRun },
      );
      // 2026-06-02 — Reconciler heartbeat for the main worker's
      // sanity-sweep broker_reconciler_freshness check. Must write to
      // KV_TIMED (shared with timed-trading-ingest) — NOT BRIDGE_KV alone.
      try {
        const kv = env?.KV_TIMED || env?.BRIDGE_KV;
        if (kv) {
          const nowHb = String(Date.now());
          await kv.put("bridge:reconciler:last_run", nowHb, { expirationTtl: 24 * 3600 });
          await kv.put("bridge:reconciler:last_tick", nowHb, { expirationTtl: 24 * 3600 });
        }
      } catch (hbErr) {
        console.warn("[RECONCILER_HEARTBEAT] write failed:", String(hbErr?.message || hbErr).slice(0, 120));
      }
      console.log(`[RECONCILER] cycle done ${JSON.stringify(result.aggregate || {})} elapsed=${Date.now() - t0}ms dry=${dryRun}`);
    } catch (e) {
      console.error("[BRIDGE_CRON] failed:", String(e?.message || e).slice(0, 500));
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
// Dispatcher: fan the model signal out to every enabled account (owner runs
// 5 Webull + 1 IBKR) when BROKER_FANOUT_ENABLED, else place on the single
// resolved account (default, unchanged behavior). An explicit broker_account_id
// always targets one account.
//
// 2026-08-11 — Self-service mirror participants (Broker Connections):
// accounts owned by OTHER app users who connected their own broker login
// and explicitly enabled mirroring (`mirror_participant: true`) join every
// model-signal dispatch — their enable IS the opt-in. BROKER_FANOUT_ENABLED
// continues to gate only the signal owner's own multi-account expansion,
// so with no participants the behavior is exactly the legacy one.
async function handleOrderWebhook(env, ctx, payload) {
  const owner = String(payload?.user_id || "").toLowerCase();
  const vehicle = String(payload?.vehicle || "").toLowerCase();
  const fanoutOn = String(env?.BROKER_FANOUT_ENABLED || "").toLowerCase() === "true";
  if (payload?.broker_account_id) {
    return handleSingleAccountOrder(env, ctx, payload);
  }
  const { pickIndexTrendLetfAccount, indexTrendLetfOn } = await import("./bridge-options-prefs.js");
  const participants = await listMirrorParticipants(env, owner).catch(() => []);
  const ownerAccounts = fanoutOn
    ? await resolveBridgeAccounts(env, owner, { enabledOnly: true })
    : [];
  const expandOwner = fanoutOn && ownerAccounts.length > 1;
  if (!expandOwner && !participants.length) {
    if (vehicle === "index_trend_letf") {
      const allOwner = await resolveBridgeAccounts(env, owner, { enabledOnly: true }).catch(() => []);
      const picked = pickIndexTrendLetfAccount(allOwner, {
        preferClass: env?.WEBULL_DEFAULT_ACCOUNT_CLASS || "ROTH_IRA",
      });
      if (picked) {
        return handleSingleAccountOrder(env, ctx, {
          ...payload,
          user_id: picked.user_id,
          broker_account_id: resolveBrokerAccountId(picked),
        });
      }
    }
    return handleSingleAccountOrder(env, ctx, payload);
  }
  const results = [];
  const dispatchOne = async (perPayload, acct) => {
    let res, body = null;
    try {
      res = await handleSingleAccountOrder(env, ctx, perPayload);
      body = await res.clone().json().catch(() => null);
    } catch (e) {
      body = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
    results.push({
      broker_account_id: perPayload.broker_account_id || null,
      user_id: perPayload.user_id,
      broker: acct ? (resolveBrokerId(acct) || acct.broker || null) : null,
      http_status: res?.status || 500,
      result: body,
    });
  };
  const perAccountPayload = (acct) => {
    const acctId = resolveBrokerAccountId(acct);
    // Webull requires client_order_id length 10–40. Base ids from
    // shortClientOrderId are already ≤40; appending the full account id
    // (e.g. `tt-lt-dca-inv-…-PANW-auto-<ms>-LJJ84…`) overflowed and
    // Webull rejected with "Parameter error, invalid client order id".
    // Keep a short, stable per-account suffix.
    let coid = null;
    if (payload?.client_order_id) {
      const base = String(payload.client_order_id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 28);
      const suffix = String(acctId || "").replace(/[^a-zA-Z0-9]/g, "").slice(-8);
      coid = `${base}${suffix ? "-" + suffix : ""}`.slice(0, 40);
      if (coid.length < 10) coid = (coid + "xxxxxxxxxx").slice(0, 10);
    }
    return {
      ...payload,
      user_id: acct.user_id,
      broker_account_id: acctId,
      // Per-account idempotency: one stable key per (trade, account) so a
      // repeat fire dedupes per account, not across accounts.
      client_order_id: coid,
    };
  };
  if (expandOwner) {
    const ownerPool = vehicle === "index_trend_letf"
      ? ownerAccounts.filter((acct) => indexTrendLetfOn(acct))
      : ownerAccounts;
    for (const acct of ownerPool) await dispatchOne(perAccountPayload(acct), acct);
  } else {
    // Signal owner keeps the legacy single-account resolution.
    await dispatchOne({ ...payload }, null);
  }
  for (const acct of participants) {
    if (vehicle === "index_trend_letf" && !indexTrendLetfOn(acct)) continue;
    await dispatchOne(perAccountPayload(acct), acct);
  }
  return json({ ok: true, fanout: true, accounts: results.length, results }, 200);
}

async function handleSingleAccountOrder(env, ctx, payload) {
  const t0 = Date.now();
  const sanitized = {
    user_id: String(payload?.user_id || "").toLowerCase(),
    trade_id: payload?.trade_id || null,
    // Clamp to Webull's 10–40 char client_order_id window (also safe for
    // other brokers). Long legacy ids like `tt-lt-dca-inv-inv-…` are
    // truncated here as a last line of defense.
    client_order_id: (() => {
      if (!payload?.client_order_id) return null;
      let id = String(payload.client_order_id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
      if (id.length && id.length < 10) id = (id + "xxxxxxxxxx").slice(0, 10);
      return id || null;
    })(),
    // Optional explicit account target. When omitted, resolveBridgeUser picks
    // the account (single-account brokers or the class-preferred Webull sub).
    broker_account_id: payload?.broker_account_id ? String(payload.broker_account_id) : null,
    ticker: String(payload?.ticker || "").toUpperCase(),
    side: String(payload?.side || "").toLowerCase(),
    qty: Number(payload?.qty || 0),
    entry: Number(payload?.entry || 0) || null,
    sl: payload?.sl == null ? null : Number(payload.sl),
    tp: payload?.tp == null ? null : Number(payload.tp),
    order_kind: payload?.order_kind || null,
    limit_price: payload?.limit_price == null ? null : Number(payload.limit_price),
    // ETH / extended: caller may request GTC + support_trading_session=ALL.
    // Defaults stay DAY/CORE via the order planner + Webull body builder.
    tif: payload?.tif != null ? String(payload.tif) : null,
    support_trading_session: payload?.support_trading_session != null
      ? String(payload.support_trading_session)
      : null,
    vehicle: payload?.vehicle || null,
    decision_reason: payload?.decision_reason || null,
    mode: payload?.mode || null,
    // 2026-07-24 — MUST forward reduce_pct/trim_pct. reconcileReducerQty
    // uses these for TRIM % of the broker model portion. Dropping them
    // made a 50% NVDA trim resolve as explicit model-book qty, then clamp
    // to full broker_remaining (sold 7.75 instead of ~3.87).
    reduce_pct: payload?.reduce_pct == null ? null : Number(payload.reduce_pct),
    trim_pct: payload?.trim_pct == null ? null : Number(payload.trim_pct),
  };

  // 0. Idempotency — a stable client_order_id is claimed once per 24h.
  // A repeated fire (retry, or a systematic false-exit firing 3x like
  // AMZN 2026-07-20) is dropped BEFORE any broker review/place so a single
  // erroneous decision can never turn into multiple real orders.
  if (sanitized.client_order_id) {
    const claim = await claimOrderIdempotency(env, sanitized.client_order_id);
    if (!claim.fresh) {
      await writeAudit(env, {
        ts: Date.now(),
        user_id: sanitized.user_id,
        trade_id: sanitized.trade_id,
        ticker: sanitized.ticker,
        action: "dedupe_skip",
        side: sanitized.side,
        qty: sanitized.qty,
        status: "rejected",
        reject_reason: `duplicate_client_order_id:${sanitized.client_order_id}`,
        request_json: sanitized,
        latency_ms: Date.now() - t0,
      });
      return json({ ok: true, deduped: true, client_order_id: sanitized.client_order_id }, 200);
    }
  }

  // 1. Preflight
  let pf;
  try {
    pf = await preflightOrder(env, sanitized);
  } catch (e) {
    const detail = String(e?.message || e).slice(0, 200);
    console.error("[BRIDGE] preflight threw:", detail);
    await writeAudit(env, {
      ts: Date.now(),
      user_id: sanitized.user_id,
      trade_id: sanitized.trade_id,
      ticker: sanitized.ticker,
      action: "reject",
      side: sanitized.side,
      qty: sanitized.qty,
      status: "error",
      reject_reason: `preflight_threw:${detail}`,
      request_json: sanitized,
      latency_ms: Date.now() - t0,
    });
    return json({ ok: false, rejected: true, reject_reason: `preflight_threw:${detail}` }, 200);
  }
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
    // 2026-06-01 — Phase A: stamp a manifest row when an ENTRY is
    // rejected at preflight, so Phase B's reducer can later return
    // `mirror_suppressed` on any follow-on TRIM/EXIT against this
    // trade_id (the model thinks the position is open, but the
    // broker never accepted it).
    if (classifyOrderLifecycle(sanitized.side) === "open" && sanitized.trade_id) {
      // Reload the user record so we have broker / account_id even
      // though preflight failed before we hit pf.user. readUser is
      // cheap; missing user just yields a no-op write.
      const userForReject = await readUser(env, sanitized.user_id);
      await writeRejectedEntry(env, sanitized, userForReject, pf.reject_reason);
    }
    // Never spread pf into the response — ok:true carries the full user
    // row (wrapped secrets) which can break JSON.stringify → bare HTTP 500
    // with no audit (looked like "trim never hit Webull").
    return json({
      ok: false,
      rejected: true,
      reject_reason: pf.reject_reason || "preflight_rejected",
      estimated_value: pf.estimated_value ?? null,
      manifest_sync_state: pf.manifest_sync_state ?? null,
      lifecycle: pf.lifecycle ?? null,
    }, 200);
  }

  const user = pf.user;
  const estValue = pf.estimated_value;

  // ── Broker-agnostic order plan ──
  // Translate the model intent into a concrete plan for THIS broker,
  // respecting its market/limit/OCO/bracket support. Records how protection
  // is carried (native bracket vs OCO children vs engine-managed) so it is
  // never a silent gap. Placement still uses the adapter primary; the plan
  // documents intent + downgrades and drives per-account ledger metadata.
  const brokerId = resolveBrokerId(user) || user?.broker || null;
  const brokerAccountId = resolveBrokerAccountId(user);
  const orderIntent = normalizeOrderIntent(sanitized);
  const ocoEnabled = String(env?.BROKER_OCO_ENABLED || "false").toLowerCase() === "true";
  const orderPlan = planBrokerOrder(brokerId, orderIntent, { ocoEnabled });
  // Apply the capability-respecting plan back onto the order the adapter sends
  // (e.g. a limit downgraded to market, or the executable tif).
  if (orderPlan.ok && orderPlan.primary) {
    sanitized.order_type = orderPlan.primary.order_type;
    sanitized.limit_price = orderPlan.primary.limit_price;
    sanitized.tif = orderPlan.primary.tif;
  }
  await writeAudit(env, {
    ts: Date.now(),
    user_id: sanitized.user_id,
    trade_id: sanitized.trade_id,
    ticker: sanitized.ticker,
    action: "order_plan",
    side: sanitized.side,
    qty: sanitized.qty,
    status: orderPlan.ok ? "ok" : "rejected",
    reject_reason: orderPlan.ok ? null : orderPlan.reject_reason,
    request_json: { broker: brokerId, broker_account_id: brokerAccountId, plan: orderPlan, summary: summarizeOrderPlan(orderPlan) },
  });

  // 2026-06-01 — Account-fit scaling: preflightOrder may have rounded
  // sanitized.qty down to fit caps + cash + concentration. Pick up the
  // scaled value here so review/place see the actual broker qty (not
  // the model's $100k-notional original). pf.scaling carries the
  // before/after for audit + response.
  if (pf.scaling?.scaled_qty != null && pf.scaling.scaled_qty !== sanitized.qty) {
    sanitized.qty = pf.scaling.scaled_qty;
  }

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
    request_json: { ...sanitized, scaling: pf.scaling || null },
    latency_ms: Date.now() - t0,
  });

  // 2026-06-01 — Phase D: OCO orchestration plan for reducers
  // (TRIM/EXIT). Logs the cancel-then-replace plan in the audit so
  // operators can see what the bridge WOULD do once BROKER_OCO_ENABLED
  // is flipped. Actual cancel + place dispatch lands in Phase E.
  let _ocoPlan = null;
  try {
    _ocoPlan = await orchestrateOcoForReducer(env, sanitized, user);
    if (_ocoPlan && _ocoPlan.ok && (_ocoPlan.actions?.length > 0 || _ocoPlan.post_reducer_actions?.length > 0)) {
      await writeAudit(env, {
        ts: Date.now(),
        user_id: sanitized.user_id,
        trade_id: sanitized.trade_id,
        ticker: sanitized.ticker,
        action: "oco_plan",
        side: sanitized.side,
        qty: sanitized.qty,
        status: "ok",
        request_json: sanitized,
        response_json: _ocoPlan,
      });
    }
  } catch (e) {
    console.warn("[OCO] plan failed:", String(e?.message || e).slice(0, 200));
  }

  // 3. Review (dry-run)
  const review = await reviewOrder(env, user, sanitized);
  const reviewWarnings = review?.response?.warnings || review?.response?.review?.warnings || [];
  const reviewOk = review.ok && (!Array.isArray(reviewWarnings) || reviewWarnings.length === 0);
  // 2026-07-22 — Reject reason now surfaces the ACTUAL broker error when the
  // review call itself failed (previously we always templated
  // `review_warnings:[]` even when review.ok was false with a real error
  // like INVALID_PARAMETER, hiding the true cause in the audit list).
  let reviewRejectReason = null;
  if (!reviewOk) {
    if (Array.isArray(reviewWarnings) && reviewWarnings.length > 0) {
      reviewRejectReason = `review_warnings:${JSON.stringify(reviewWarnings).slice(0, 200)}`;
    } else {
      const errCode = review?.response?.error_code || review?.response?.code || review?.error_code || null;
      const errMsg = review?.response?.message || review?.response?.msg || review?.error || review?.message || "unknown_review_error";
      reviewRejectReason = `review_error:${errCode ? errCode + ":" : ""}${String(errMsg).slice(0, 180)}`;
    }
  }
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
    reject_reason: reviewRejectReason,
    response_json: review.response || review,
    latency_ms: review.latency_ms,
  });
  if (!reviewOk) {
    // Review rejected — free the claim so a corrected retry can land.
    if (sanitized.client_order_id) {
      await releaseOrderIdempotency(env, sanitized.client_order_id).catch(() => {});
    }
    return json({ ok: false, rejected: true, reject_reason: reviewRejectReason || "review_failed", review_response: review.response || review }, 200);
  }

  // 3.5 — Ground-truth reducer guard. Before selling, confirm the account
  // actually holds the position (live broker positions, not the manifest).
  // A SELL/EXIT/TRIM with no position would be a naked/short order — forbidden
  // on a cash/IRA account. Reject if flat/missing; clamp if the model asks to
  // sell more than is held. Skips mock mode (no real positions to check).
  const reducerLifecycle = classifyOrderLifecycle(sanitized.side);

  // 2026-07-30 — DE exit RCA: order_plan→order_in→review ok, then the
  // request died during getEquityPositions (no reducer_reconcile, no place,
  // no client ring / silent-failure). model_status stayed OPEN because
  // markManifestModelClosed only ran on place.ok → reconciler reported
  // in_sync while Roth still held 0.85 DE. Stamp CLOSED as soon as EXIT
  // clears review (before the slow positions call) so a mid-flight abort
  // surfaces as broker_orphan instead of a silent hold.
  if (reducerLifecycle === "close" && sanitized.trade_id) {
    const exitReason = sanitized?.decision_reason || sanitized?.exit_reason || "exit";
    await markManifestModelClosed(env, sanitized.user_id, sanitized.trade_id, brokerAccountId, {
      exitReason: `intent_accepted:${exitReason}`.slice(0, 180),
      exitTs: Date.now(),
    }).catch((e) => console.warn("[MANIFEST] early markClosed failed:", String(e?.message || e).slice(0, 160)));
  }

  let place = null;
  let _fractFallback = null;
  try {
  if (reducerLifecycle === "reduce" || reducerLifecycle === "close") {
    await writeAudit(env, {
      ts: Date.now(), user_id: sanitized.user_id, trade_id: sanitized.trade_id,
      ticker: sanitized.ticker, action: "reducer_guard_begin", side: sanitized.side,
      qty: sanitized.qty, status: "ok",
      request_json: { broker_account_id: brokerAccountId, lifecycle: reducerLifecycle },
    }).catch(() => {});
    // (a) Live position — ground truth; reject if the account holds nothing.
    const posGuard = await verifyReducerHoldsPosition(env, user, sanitized);
    if (!posGuard.ok) {
      await writeAudit(env, {
        ts: Date.now(), user_id: sanitized.user_id, trade_id: sanitized.trade_id,
        ticker: sanitized.ticker, action: "reducer_rejected", side: sanitized.side,
        qty: sanitized.qty, status: "rejected", reject_reason: posGuard.reason,
        request_json: { held_qty: posGuard.heldQty ?? null, broker_account_id: brokerAccountId },
      });
      if (sanitized.client_order_id) {
        await releaseOrderIdempotency(env, sanitized.client_order_id).catch(() => {});
      }
      return json({
        ok: false, rejected: true, reject_reason: posGuard.reason,
        held_qty: posGuard.heldQty ?? null, requested_qty: sanitized.qty,
      }, 200);
    }
    const heldQty = Number(posGuard.heldQty) || 0;

    // (b) Model's tracked portion on THIS account (link via trade_id +
    // account). We only ever reduce the model's shares, never the user's.
    let modelRow = null;
    let modelRemaining = null;
    try {
      if (sanitized.trade_id && posGuard.skip !== "mock_mode") {
        modelRow = await readManifestRow(env, sanitized.user_id, sanitized.trade_id, brokerAccountId);
        if (modelRow) {
          const rem = Number(modelRow.broker_remaining_qty);
          const filled = Number(modelRow.broker_filled_qty);
          modelRemaining = rem > 0 ? rem : (filled > 0 ? filled : null);
        }
      }
    } catch (_) { /* manifest read best-effort */ }

    // (c) Reconcile: percentage of the model portion, capped to model shares,
    // clamped to live holding. Never oversell, never touch user shares.
    const recon = reconcileReducerQty({
      side: sanitized.side,
      requestedQty: sanitized.qty,
      reducePct: sanitized.reduce_pct ?? sanitized.trim_pct ?? null,
      modelRemainingQty: modelRemaining,
      heldQty,
    });

    // (d) Always log the reconcile; log + notify on a discrepancy.
    await writeAudit(env, {
      ts: Date.now(), user_id: sanitized.user_id, trade_id: sanitized.trade_id,
      ticker: sanitized.ticker, action: "reducer_reconcile", side: sanitized.side,
      qty: recon.qty, status: recon.discrepancy ? "warn" : "ok",
      request_json: {
        requested_qty: sanitized.qty, resolved_qty: recon.qty,
        model_remaining: modelRemaining, held_qty: heldQty,
        reasons: recon.reasons, broker_account_id: brokerAccountId,
      },
    });
    if (recon.discrepancy) {
      console.warn(`[REDUCER_DISCREPANCY] ${sanitized.user_id}/${sanitized.ticker} trade=${sanitized.trade_id}: ${JSON.stringify(recon.discrepancy)}`);
      await writeAudit(env, {
        ts: Date.now(), user_id: sanitized.user_id, trade_id: sanitized.trade_id,
        ticker: sanitized.ticker, action: "reducer_discrepancy", side: sanitized.side,
        qty: recon.qty, status: "warn",
        reject_reason: recon.discrepancy.map((d) => d.kind).join(","),
        request_json: { discrepancy: recon.discrepancy, model_remaining: modelRemaining, held_qty: heldQty },
      });
      if (modelRow) {
        try {
          await emitDriftNotification(env, {
            ...modelRow, sync_state: "reconcile_error",
            sync_note: `reducer discrepancy: ${recon.discrepancy.map((d) => d.note || d.kind).join("; ")}`,
          }, "warn");
        } catch (_) { /* notify best-effort */ }
      }
    }

    if (!(recon.qty > 0)) {
      if (sanitized.client_order_id) {
        await releaseOrderIdempotency(env, sanitized.client_order_id).catch(() => {});
      }
      return json({
        ok: false, rejected: true, reject_reason: "nothing_to_reduce",
        held_qty: heldQty, model_remaining: modelRemaining, requested_qty: sanitized.qty,
      }, 200);
    }
    // Webull fractional qty max 5 decimal places — 1.199385 (6dp) from a
    // 50% of 2.39877 TT trim returned OAUTH_OPENAPI_INVALID_PARAMETER.
    const fractionalCap = !!brokerCapabilities(brokerId, "adapter")?.fractional;
    const roundedQty = roundQtyForBroker(recon.qty, {
      fractional: fractionalCap || brokerId === "webull",
      precision: 5,
    });
    if (!(roundedQty > 0)) {
      if (sanitized.client_order_id) {
        await releaseOrderIdempotency(env, sanitized.client_order_id).catch(() => {});
      }
      return json({
        ok: false, rejected: true, reject_reason: "reducer_qty_rounded_to_zero",
        held_qty: heldQty, model_remaining: modelRemaining, requested_qty: sanitized.qty,
        resolved_qty: recon.qty,
      }, 200);
    }
    sanitized.qty = roundedQty;
    sanitized._reducer = { isFull: recon.isFull, heldQty, modelRemaining, pre_round_qty: recon.qty };

    // (e) Cancel pending OCO children — they reserve the shares, so a trim /
    // flatten would otherwise be rejected by the broker ("qty locked up").
    if (ocoEnabled && sanitized.trade_id) {
      const cancelRes = await cancelOcoChildren(env, user, sanitized.trade_id, brokerAccountId, brokerId);
      if (cancelRes.cancelled > 0) {
        await writeAudit(env, {
          ts: Date.now(), user_id: sanitized.user_id, trade_id: sanitized.trade_id,
          ticker: sanitized.ticker, action: "oco_cancel_for_reducer", side: sanitized.side,
          status: "ok", request_json: { cancelled: cancelRes.cancelled, legs: cancelRes.legs },
        });
      }
    }
  }

  // 4. Place (native bracket when planned + supported, else market/limit)
  place = await placePlannedOrder(env, user, sanitized, orderPlan);

  // 2026-07-22 — Webull fractional-agreement auto-fallback. Webull rejects
  // fractional orders when the account holder has not signed the "Fractional
  // Trading Agreement v2" for third-party API (error code
  // OAUTH_OPENAPI_OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE). HALO/RPG/RTX
  // orders today all preview-passed then place-failed with this error on the
  // Roth. Auto-retry rounded to whole shares (never over-buy) so the order
  // still lands; persist the flag on the RESOLVED account user (Roth sub-id,
  // not the owner email) so future preflights skip the wasted fractional
  // round-trip. Retry uses a fresh client_order_id (`…-w`) — Webull can
  // reject a reuse of the failed fractional id even for the whole-share
  // retry. Operator can still sign the agreementUrl to re-enable fractional.
  if (!place.ok) {
    const _fract = classifyWebullFractError(place);
    // Agreement missing OR fractional-outside-RTH — both need whole shares.
    if (_fract.isFractAgreementError || _fract.isFractHoursError) {
      const _origQty = Number(sanitized.qty);
      const _wholeQty = roundToWholeShares(_origQty);
      if (_wholeQty > 0 && _wholeQty < _origQty) {
        const _retryCoid = sanitized.client_order_id
          ? `${String(sanitized.client_order_id).slice(0, 38)}-w`.slice(0, 40)
          : `tt-whole-${sanitized.trade_id || sanitized.ticker}-${Date.now().toString(36)}`;
        const _why = _fract.isFractHoursError ? "outside_rth" : "agreement_missing";
        console.warn(`[WEBULL_FRACT] ${(user?.user_id || sanitized.user_id)}/${sanitized.ticker} fractional ${_why} — retrying whole shares ${_origQty}→${_wholeQty} coid=${_retryCoid} (${_fract.agreementUrl || "no_url"})`);
        const _retryPayload = {
          ...sanitized,
          qty: _wholeQty,
          client_order_id: _retryCoid,
        };
        place = await placePlannedOrder(env, user, _retryPayload, orderPlan);
        if (place.ok) {
          sanitized.qty = _wholeQty;
          sanitized.client_order_id = _retryCoid;
          _fractFallback = {
            reason: _fract.isFractHoursError
              ? "webull_fractional_outside_rth"
              : "webull_fractional_agreement_missing",
            original_qty: _origQty,
            whole_qty: _wholeQty,
            retry_client_order_id: _retryCoid,
            agreement_url: _fract.agreementUrl,
          };
        } else {
          // Keep the fract classification visible when the whole-share retry
          // also fails (rate-limit / hours / buying power).
          place = {
            ...place,
            error: place.error || "webull_fractional_agreement_whole_retry_failed",
            response: {
              ...(place.response || {}),
              _fract_retry: {
                original_qty: _origQty,
                whole_qty: _wholeQty,
                retry_client_order_id: _retryCoid,
                agreement_url: _fract.agreementUrl,
                first_error: _fract.errorCode,
              },
            },
          };
        }
      } else {
        // Already whole shares, or would round to 0 — clean reject.
        place = {
          ok: false,
          error: _fract.isFractHoursError
            ? "webull_fractional_outside_rth_whole_share_unaffordable"
            : "webull_fractional_agreement_required",
          response: {
            error_code: _fract.errorCode,
            agreement_url: _fract.agreementUrl,
            message: _fract.isFractHoursError
              ? "Fractional equity orders are RTH-only; one whole share does not fit after account scaling"
              : (_fract.agreementUrl || "operator must sign Webull TRADE_FRACT_PRO agreement to enable fractional orders"),
            requested_qty: _origQty,
            whole_qty: _wholeQty,
          },
          latency_ms: place.latency_ms,
        };
      }
      // Persist agreement flag ONLY for the TRADE_FRACT_PRO path — not for
      // ETH hours rejects (those are session-bound, not account-bound).
      if (_fract.isFractAgreementError) {
        // Persist on the RESOLVED broker account (e.g. …#webull#roth-ira), not
        // the owner email the main worker forwards. Preflight reads this flag
        // from the resolved user — writing the owner row was a silent no-op.
        try {
          const _flagUid = String(user?.user_id || sanitized.user_id || "").toLowerCase();
          if (_flagUid) {
            const _u = await readUser(env, _flagUid);
            if (_u) {
              _u.fractional_agreement_missing = true;
              _u.fractional_agreement_url = _fract.agreementUrl || _u.fractional_agreement_url || null;
              _u.fractional_agreement_flagged_at = Date.now();
              await writeUser(env, _flagUid, _u);
            }
            if (user) {
              user.fractional_agreement_missing = true;
              user.fractional_agreement_url = _fract.agreementUrl || null;
            }
          }
        } catch (_flagErr) { /* flagging is best-effort — never block a placed order */ }
      }
    }
  }
  } catch (e) {
    // Mid-flight death after review (positions API hang, isolate cancel, …).
    // Audit + free the claim so catch-up / retry can place.
    const detail = String(e?.message || e).slice(0, 200);
    console.error("[BRIDGE] post_review threw:", detail);
    await writeAudit(env, {
      ts: Date.now(),
      user_id: sanitized.user_id,
      trade_id: sanitized.trade_id,
      ticker: sanitized.ticker,
      action: "post_review_error",
      side: sanitized.side,
      qty: sanitized.qty,
      status: "error",
      reject_reason: `post_review_threw:${detail}`,
      request_json: sanitized,
      latency_ms: Date.now() - t0,
    }).catch(() => {});
    if (sanitized.client_order_id) {
      await releaseOrderIdempotency(env, sanitized.client_order_id).catch(() => {});
    }
    return json({ ok: false, error: "post_review_error", detail }, 200);
  }

  // IBKR returns an array (parent + bracket legs); others a single object.
  const _placeResp = place?.response;
  const rhOrderId = Array.isArray(_placeResp)
    ? (_placeResp[0]?.order_id || _placeResp[0]?.id || null)
    : (_placeResp?.order_id || _placeResp?.id || null);
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
    reject_reason: place.ok ? (_fractFallback ? "fract_agreement_missing_retried_whole_shares" : null) : (place.error || "place_failed"),
    response_json: _fractFallback ? { ...place.response, _fract_fallback: _fractFallback } : (place.response || place),
    latency_ms: place.latency_ms,
  });
  // Failed place (or aborted mid-flight that somehow resumed) must free the
  // idempotency claim — otherwise a stuck EXIT like DE-1785351897700 can
  // never be retried for 24h (`dedupe_skip`).
  if (!place.ok && sanitized.client_order_id) {
    await releaseOrderIdempotency(env, sanitized.client_order_id).catch(() => {});
  }
  // ── Per-account ledger: record every real fill/reject against the
  // specific broker account (owner runs 5 Webull + 1 IBKR). ──
  await recordAccountFill(env, {
    ts: Date.now(),
    owner_id: user?.owner_email || sanitized.user_id,
    user_id: user?.user_id || sanitized.user_id,
    broker: brokerId,
    broker_account_id: brokerAccountId,
    model_trade_id: sanitized.trade_id,
    client_order_id: sanitized.client_order_id,
    broker_order_id: rhOrderId,
    ticker: sanitized.ticker,
    side: sanitized.side,
    event_type: classifyOrderLifecycle(sanitized.side) === "close" ? "EXIT" : "ENTRY",
    order_type: orderPlan?.primary?.order_type || null,
    protection_mode: orderPlan?.protection?.mode || null,
    qty: Number(place?.response?.filled_qty ?? place?.response?.cumulative_quantity ?? sanitized.qty) || 0,
    price: Number(place?.response?.avg_price ?? place?.response?.price ?? sanitized.entry) || 0,
    status: place.ok ? "ok" : "error",
    reject_reason: place.ok ? null : (place.error || "place_failed"),
    meta: { scaling: pf.scaling || null, plan_downgrades: orderPlan?.downgrades || [] },
  }).catch(() => {});

  if (place.ok) {
    await bumpDailyCounter(env, sanitized.user_id);
    const lifecycle = classifyOrderLifecycle(sanitized.side);
    // 2026-06-01 — Phase A: stamp the manifest with the entry-tracker
    // row + order ID on a successful ENTRY/ADD.
    if (lifecycle === "open" && sanitized.trade_id) {
      // 2026-07-24 — Webull market place often returns order_id without
      // filled_qty/cumulative_quantity. Falling back to 0 left the manifest
      // stuck in sync_state=pending, which BROKER_MANIFEST_ENFORCE=on then
      // used to hard-block every TRIM/EXIT (NVDA 50% trim never reached
      // Webull). When place.ok, treat requested qty as filled until the
      // reconciler confirms live broker qty.
      const filledQty = Number(place?.response?.filled_qty
        ?? place?.response?.cumulative_quantity
        ?? sanitized.qty
        ?? 0);
      const mfRes = await writeEntryManifest(env, sanitized, user, {
        broker_order_id: rhOrderId,
        filled_qty: filledQty,
        requested_qty: sanitized.qty,
      });
      if (!mfRes?.ok && mfRes?.reason && env?.MANIFEST_DEBUG_LOG === "true") {
        console.warn(`[MANIFEST] entry write skipped for ${sanitized.user_id}/${sanitized.trade_id}: ${mfRes.reason}`);
      }

      // OCO protection: place SL + TP children after a filled entry when the
      // plan asked for oco_children (broker has no native bracket). Sibling is
      // cancelled by fill reconciliation when one child fills. Gated by
      // BROKER_OCO_ENABLED (checked via the plan mode, set with ocoEnabled).
      if (orderPlan?.protection?.mode === "oco_children") {
        try {
          const oco = await placeOcoChildren(env, user, sanitized, orderPlan, {
            brokerId, brokerAccountId, filledQty,
          });
          await writeAudit(env, {
            ts: Date.now(), user_id: sanitized.user_id, trade_id: sanitized.trade_id,
            ticker: sanitized.ticker, action: "oco_children",
            status: oco.some((c) => c.ok) ? "ok" : "error",
            request_json: { children: oco },
          });
        } catch (e) {
          console.warn(`[OCO] child placement failed for ${sanitized.trade_id}:`, String(e?.message || e).slice(0, 160));
        }
      }
    }
    // 2026-06-01 — Phase B: on a successful EXIT, flip the manifest
    // row's model_status to 'CLOSED' so the reconciler (Phase C) knows
    // a follow-on broker position is now an orphan (broker_orphan)
    // rather than a still-open trade. TRIM/SL/TP fills don't flip the
    // top-level model_status — they just update the broker_*_order_ids
    // arrays (Phase C does that).
    if (lifecycle === "close" && sanitized.trade_id) {
      const accountId = brokerAccountId;
      const exitReason = sanitized?.decision_reason || sanitized?.exit_reason || "exit";
      markManifestModelClosed(env, sanitized.user_id, sanitized.trade_id, accountId, {
        exitReason, exitTs: Date.now(),
      }).catch(e => console.warn("[MANIFEST] markClosed failed:", String(e?.message || e).slice(0, 160)));
    }

    // 2026-07-27 — Post-execution audit. Every successful REDUCER
    // (TRIM / EXIT / CLOSE) stamps its expectation onto the manifest
    // row: pre-held qty (broker-verified milliseconds ago), intended
    // qty (reconciled), expected post-held qty. The reconciler compares
    // live held vs expected_post_held_qty a couple of minutes later
    // and either clears the audit (in_sync) or emits a post_exec_drift
    // notification. This is the "did our action result in what we
    // expected?" contract — every model-fired reducer signal now has
    // a first-class execution receipt attached to its manifest row.
    if ((lifecycle === "reduce" || lifecycle === "close") && sanitized.trade_id) {
      const preHeld = Number(sanitized?._reducer?.heldQty);
      // Prefer the pre-round reconciled qty (what the model wanted post
      // reducer sizing); the broker adapter may round to precision but
      // we intended `pre_round_qty`. Falls back to the placed qty.
      const intended = Number(sanitized?._reducer?.pre_round_qty) || Number(sanitized.qty);
      if (Number.isFinite(preHeld) && preHeld > 0 && Number.isFinite(intended) && intended > 0) {
        // 2026-07-29 — MUST be awaited. Fire-and-forget without
        // ctx.waitUntil() on Workers has the runtime cancel the pending
        // promise once the response is sent, so `sync_last_action_json`
        // never lands (verified via query: 0/18 rows stamped despite
        // dozens of successful reducers). Blocking here adds ~10ms; the
        // reducer path is already async so the caller doesn't feel it.
        try {
          const auditRes = await writeLastActionAudit(env, {
            userId: sanitized.user_id,
            tradeId: sanitized.trade_id,
            brokerAccountId,
            kind: sanitized.side,
            preHeldQty: preHeld,
            intendedQty: intended,
            clientOrderId: sanitized.client_order_id || null,
            brokerOrderId: rhOrderId,
            reasons: {
              is_full: !!sanitized?._reducer?.isFull,
              model_remaining: sanitized?._reducer?.modelRemaining ?? null,
              placed_qty: Number(sanitized.qty) || null,
            },
          });
          if (!auditRes?.ok) {
            console.warn(
              `[MANIFEST] writeLastActionAudit did not stamp ${sanitized.trade_id}: ${auditRes?.reason || "unknown"}`,
            );
          }
        } catch (e) {
          console.warn(
            `[MANIFEST] writeLastActionAudit failed for ${sanitized.trade_id}:`,
            String(e?.message || e).slice(0, 160),
          );
        }
      } else if (env?.MANIFEST_DEBUG_LOG === "true") {
        console.warn(
          `[MANIFEST] audit-skip ${sanitized.trade_id}: preHeld=${preHeld} intended=${intended}`,
        );
      }
    }

    // On a partial TRIM, re-establish OCO protection for the REMAINING qty
    // (we cancelled the old children before placing the trim). Full closes
    // don't re-place (position flat). SL/TP recovered from the ledger, or
    // taken from the payload if the model sent them.
    if (lifecycle === "reduce" && sanitized.trade_id && ocoEnabled) {
      try {
        const soldQty = Number(place?.response?.filled_qty ?? place?.response?.cumulative_quantity ?? sanitized.qty) || 0;
        const heldBefore = Number(sanitized?._reducer?.heldQty) || 0;
        const remaining = Math.max(0, heldBefore - soldQty);
        if (remaining > 0) {
          const recovered = await recoverOcoPrices(env, brokerAccountId, sanitized.trade_id);
          const sl = Number(sanitized.sl) > 0 ? Number(sanitized.sl) : recovered.sl;
          const tp = Number(sanitized.tp) > 0 ? Number(sanitized.tp) : recovered.tp;
          if ((Number(sl) > 0) || (Number(tp) > 0)) {
            const rplan = { protection: { mode: "oco_children", stop_loss: sl || null, take_profit: tp || null } };
            const oco = await placeOcoChildren(env, user, sanitized, rplan, {
              brokerId, brokerAccountId, filledQty: remaining,
              idSuffix: `r${Date.now().toString(36)}`,
            });
            await writeAudit(env, {
              ts: Date.now(), user_id: sanitized.user_id, trade_id: sanitized.trade_id,
              ticker: sanitized.ticker, action: "oco_replace_after_trim",
              status: oco.some((c) => c.ok) ? "ok" : "error",
              request_json: { remaining_qty: remaining, sl, tp, children: oco },
            });
          } else {
            console.warn(`[OCO] trim on ${sanitized.ticker}/${sanitized.trade_id}: no SL/TP to re-establish for remaining ${remaining} — protection not re-placed`);
          }
        }
      } catch (e) {
        console.warn(`[OCO] re-place after trim failed for ${sanitized.trade_id}:`, String(e?.message || e).slice(0, 160));
      }
    }
  }

  return json({
    ok: place.ok,
    rh_order_id: rhOrderId,
    place_status: place.response?.status,
    // Surface place/reject reason so rebuild / catch-up can show why
    // ok:false without digging the audit row (AMAT ETH fractional was
    // silent in rebuild results because only audit had the message).
    reject_reason: place.ok
      ? (_fractFallback ? _fractFallback.reason : null)
      : (place.error
        || place.response?.message
        || place.response?.msg
        || place.response?.reject_reason
        || "place_failed"),
    review_warnings: reviewWarnings,
    manifest_sync_state: pf.manifest_sync_state || null,
    // 2026-06-01 — surface scaling so the caller can see "model wanted
    // 100, bridge sent 7" with the reason (cap_per_order / cash_buffer
    // / concentration). null when no scaling was applied.
    scaling: pf.scaling || null,
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
async function recordOptionsAccountFill(env, {
  user, sanitized, brokerOrder = null, fill = null, placed = null,
  status, reject_reason = null,
} = {}) {
  const action = String(
    brokerOrder?.action
    || sanitized?.play?.legs?.[0]?.action
    || sanitized?.side
    || "BUY",
  ).toUpperCase();
  const side = action === "SELL" ? "sell" : "buy";
  const qty = Number(brokerOrder?.qty ?? fill?.filled_qty ?? sanitized?.play?.contracts) || 1;
  const price = Number(
    brokerOrder?.limit_price
    ?? brokerOrder?.price
    ?? sanitized?.play?.premium?.mid
    ?? sanitized?.play?.legs?.[0]?.premium
    ?? 0,
  ) || 0;
  const tradeId = sanitized?.trade_id || null;
  await recordAccountFill(env, {
    ts: Date.now(),
    owner_id: user?.owner_email || sanitized?.user_id || null,
    user_id: user?.user_id || sanitized?.user_id || null,
    broker: user?.broker || null,
    broker_account_id: resolveBrokerAccountId(user),
    model_trade_id: tradeId,
    client_order_id: tradeId ? `tt-opt-${tradeId}-${side}` : null,
    broker_order_id: fill?.order_id || placed?.response?.order_id || placed?.response?.orderId || null,
    ticker: sanitized?.ticker || null,
    side,
    event_type: side === "sell" ? "EXIT" : "ENTRY",
    qty,
    price,
    status: status || "rejected",
    reject_reason: reject_reason || null,
    meta: {
      source: sanitized?.source || null,
      vehicle: "options",
      archetype: sanitized?.play?.archetype || null,
    },
  }).catch(() => {});
}

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

  // Prefer a connected account that opted into options strategies
  // (Broker Connections toggle). Owner emails resolve to the opted-in
  // Webull sub-account instead of a creds-less parent row.
  const { pickOptionsAccount, optionsStrategiesOn } = await import("./bridge-options-prefs.js");
  const ownerAccounts = await resolveBridgeAccounts(env, sanitized.user_id, { enabledOnly: true }).catch(() => []);
  const opted = pickOptionsAccount(ownerAccounts, {
    preferClass: env?.WEBULL_DEFAULT_ACCOUNT_CLASS || "ROTH_IRA",
  });
  const user = opted || await resolveBridgeUser(env, sanitized.user_id) || await readUser(env, sanitized.user_id);
  if (!user) return json({ ok: false, error: "user_not_found" }, 404);

  // Global kill switch.
  if (env?.BRIDGE_KILL_SWITCH === "true") {
    return json({ ok: false, rejected: true, reason: "global_kill_switch" }, 200);
  }
  if (!user.broker_integration_enabled) {
    return json({ ok: false, rejected: true, reason: "user_disabled" }, 200);
  }
  // Options-specific gate — separate from stock enablement so users
  // can authorize stocks-only without options. Broker Connections
  // toggle writes options_enabled + long_call/long_put vehicles.
  if (!optionsStrategiesOn(user) && user.role !== "operator") {
    return json({ ok: false, rejected: true, reason: "options_not_enabled" }, 200);
  }

  // Translate play → broker order shape (IBKR or Webull).
  const broker = String(user.broker || "ibkr").toLowerCase();
  let brokerOrder = null;
  let placeFn = null;

  if (broker === "webull") {
    const { playToWebullOptionOrder, placeOptionsOrder: wbPlace } = await import("./bridge-webull-options.js");
    brokerOrder = playToWebullOptionOrder(sanitized.play, sanitized.ticker);
    placeFn = wbPlace;
  } else {
    const { playToIbkrOrder, placeOptionsOrder: ibPlace } = await import("./bridge-ibkr.js");
    brokerOrder = playToIbkrOrder(sanitized.play, sanitized.ticker);
    placeFn = ibPlace;
  }

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
      fill: {
        status: "filled",
        filled_qty: Number(brokerOrder.qty) || 1,
        mock: true,
      },
      latency_ms: Date.now() - t0,
    }, 200);
  }

  // Live SELL: reject if the broker does not hold enough of this contract.
  // Mock mode skips — getOptionsPositions returns [] and would false-reject.
  const { isBridgeMockMode } = await import("./bridge-webull-config.js");
  if (String(brokerOrder.action || "").toUpperCase() === "SELL" && !isBridgeMockMode(env)) {
    const { applyOptionsSellGuard } = await import("./bridge-options-guard.js");
    const loaded = await loadOptionsPositionsForGuard(env, user, broker);
    if (loaded.error && loaded.positions == null) {
      await recordOptionsAccountFill(env, {
        user, sanitized, brokerOrder,
        status: "rejected",
        reject_reason: "positions_unavailable",
      });
      return json({
        ok: false, rejected: true, reason: "positions_unavailable",
        detail: loaded.error, latency_ms: Date.now() - t0,
      }, 200);
    }
    const guard = applyOptionsSellGuard(brokerOrder, loaded.positions || []);
    if (!guard.ok) {
      await recordOptionsAccountFill(env, {
        user, sanitized, brokerOrder,
        status: "rejected",
        reject_reason: guard.reason || "no_tracked_option_entry",
      });
      await writeAudit(env, {
        ts: Date.now(),
        user_id: sanitized.user_id,
        trade_id: sanitized.trade_id,
        ticker: sanitized.ticker,
        action: "reject",
        side: "sell",
        qty: brokerOrder.qty,
        status: "rejected",
        reject_reason: guard.reason,
      }).catch(() => {});
      return json({
        ok: false, rejected: true, reason: guard.reason,
        held_qty: guard.held_qty ?? null,
        requested_qty: guard.requested_qty ?? brokerOrder.qty,
        latency_ms: Date.now() - t0,
      }, 200);
    }
  }

  // Live execution.
  const placed = await placeFn(env, user, brokerOrder);
  const fill = await resolveOptionsPlaceFill(env, user, placed, brokerOrder);
  const placeOk = !!placed?.ok;
  await recordOptionsAccountFill(env, {
    user, sanitized, brokerOrder, fill, placed,
    status: placeOk ? (fill?.status === "filled" ? "ok" : (fill?.status || "ok")) : "rejected",
    reject_reason: placeOk ? null : (placed?.error || fill?.reason || "place_failed"),
  });

  // Audit log (uses writeAudit which is the canonical helper).
  try {
    await writeAudit(env, {
      kind: "options_order",
      user_id: sanitized.user_id,
      ticker: sanitized.ticker,
      trade_id: sanitized.trade_id,
      source: sanitized.source,
      side: String(brokerOrder?.action || "").toLowerCase() === "sell" ? "sell" : "buy",
      qty: brokerOrder?.qty,
      status: placeOk ? "ok" : "rejected",
      reject_reason: placeOk ? null : (placed?.error || "place_failed"),
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
    fill,
    latency_ms: Date.now() - t0,
  }, placed?.ok ? 200 : 502);
}

async function loadOptionsPositionsForGuard(env, user, broker) {
  try {
    if (broker === "webull") {
      const { getOptionsPositions } = await import("./bridge-webull-options.js");
      const r = await getOptionsPositions(env, user);
      if (!r?.ok) return { positions: null, error: r?.error || "webull_positions_failed" };
      return { positions: r.positions || [] };
    }
    const r = await IbkrAdapter.getEquityPositions(env, user);
    const raw = r?.response ?? r?.positions ?? r;
    const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
    return { positions: rows };
  } catch (e) {
    return { positions: null, error: String(e?.message || e).slice(0, 160) };
  }
}

function fillFromPlaced(placed, requestedQty) {
  if (placed?.mock) {
    return { status: "filled", filled_qty: requestedQty, mock: true, order_id: placed?.response?.order_id || null };
  }
  if (placed?.ok === false) {
    return { status: "rejected", filled_qty: 0, reason: placed?.error || "place_failed" };
  }
  const raw = placed?.response || placed || {};
  const orderId = raw.order_id || raw.orderId || raw.id || null;
  const filled = Number(raw.filled_qty ?? raw.filled_quantity ?? raw.filledQuantity ?? raw.cumulative_quantity);
  if (Number.isFinite(filled) && filled > 0) {
    return { status: "filled", filled_qty: filled, order_id: orderId };
  }
  if (orderId) return { status: "working", filled_qty: null, order_id: String(orderId) };
  return { status: "unknown", filled_qty: null, order_id: null };
}

async function resolveOptionsPlaceFill(env, user, placed, brokerOrder) {
  const requested = Number(brokerOrder?.qty) || 1;
  let fill = fillFromPlaced(placed, requested);
  if (fill.status === "working" && fill.order_id && !placed?.mock) {
    const polled = await lookupOptionsOrderFill(env, user, fill.order_id);
    if (polled?.fill) fill = { ...fill, ...polled.fill, polled: true };
  }
  return fill;
}

async function lookupOptionsOrderFill(env, user, orderId) {
  try {
    const adapter = brokerAdapterFor(user);
    if (typeof adapter.listOrders !== "function") return { ok: false, error: "no_list_orders" };
    const { normalizeBrokerOrder, extractOrders } = await import("./bridge-fills.js");
    const listRes = await adapter.listOrders(env, user, { limit: 50 });
    if (listRes && listRes.ok === false) return { ok: false, error: listRes.error || "list_orders_failed" };
    const want = String(orderId || "");
    const match = extractOrders(listRes).find((raw) => {
      const id = String(raw?.order_id ?? raw?.orderId ?? raw?.id ?? "");
      const cid = String(raw?.client_order_id ?? raw?.clientOrderId ?? "");
      return (want && (id === want || cid === want));
    });
    if (!match) return { ok: true, fill: null };
    const n = normalizeBrokerOrder(user?.broker, match);
    return {
      ok: true,
      fill: {
        status: n?.status || "unknown",
        filled_qty: n?.filled_qty ?? null,
        order_id: n?.broker_order_id || want,
        avg_price: n?.avg_price ?? null,
      },
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 160) };
  }
}

async function handleOptionsOrderStatus(env, payload) {
  const userId = String(payload?.user_id || "").toLowerCase();
  const orderId = String(payload?.order_id || payload?.trade_id || "").trim();
  if (!userId || !orderId) return json({ ok: false, error: "missing_required_fields" }, 400);
  const user = await readUser(env, userId);
  if (!user) return json({ ok: false, error: "user_not_found" }, 404);
  const { isBridgeMockMode } = await import("./bridge-webull-config.js");
  if (isBridgeMockMode(env) || user.mock_mode) {
    return json({
      ok: true,
      mock: true,
      fill: {
        status: "filled",
        filled_qty: Number(payload?.requested_qty) || 1,
        order_id: orderId,
        mock: true,
      },
    });
  }
  const looked = await lookupOptionsOrderFill(env, user, orderId);
  return json({ ok: !!looked.ok, fill: looked.fill || null, error: looked.error || null });
}

function _oauthCallbackHtml(result, brokerLabel) {
  const status = result.status || (result.ok ? 200 : 400);
  const heading = result.ok ? `✓ ${brokerLabel} Connected` : `${brokerLabel} Connection Failed`;
  const acct = result.webull_account_id || result.rh_account_number || "(pending)";
  const detail = result.ok
    ? `Account: ${acct}. Live trading is disabled until the operator enables it.`
    : `Error: ${result.error || "unknown"}`;
  const html = `<!doctype html><html><body style="font-family:system-ui;max-width:560px;margin:64px auto;padding:24px;background:#0e1014;color:#eaecf0">
<h1 style="margin-top:0">${heading}</h1>
<p>${detail}</p>
<p style="opacity:0.6;font-size:13px">You can close this tab.</p>
</body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders() } });
}

// ── Redaction helpers — never return token wraps to operator UI ──
function _redactUser(user) {
  if (!user) return null;
  const {
    rh_token_wrap, rh_refresh_wrap,
    webull_token_wrap, webull_refresh_wrap,
    webull_app_key_wrap, webull_app_secret_wrap,
    ...safe
  } = user;
  return {
    ...safe,
    has_rh_token: !!rh_token_wrap,
    has_rh_refresh: !!rh_refresh_wrap,
    has_webull_token: !!webull_token_wrap,
    has_webull_refresh: !!webull_refresh_wrap,
    has_webull_app_creds: !!(webull_app_key_wrap && webull_app_secret_wrap),
  };
}
function _redactUserForList(user) {
  if (!user) return null;
  return {
    user_id: user.user_id,
    broker: user.broker || null,
    status: user.status,
    broker_integration_enabled: !!user.broker_integration_enabled,
    options_enabled: !!user.options_enabled,
    rh_account_number: user.rh_account_number || null,
    webull_account_id: user.webull_account_id || null,
    webull_account_label: user.webull_account_label || null,
    webull_account_type: user.webull_account_type || null,
    webull_account_class: user.webull_account_class || null,
    webull_auth_mode: user.webull_auth_mode || null,
    webull_login_label: user.webull_login_label || null,
    webull_creds_env: user.webull_creds_env || null,
    notify_emails: user.notify_emails || null,
    mirror_participant: user.mirror_participant === true,
    fractional_agreement_missing: !!user.fractional_agreement_missing,
    owner_email: user.owner_email || null,
    ibkr_account_id: user.ibkr_account_id || null,
    connected_at: user.connected_at || null,
    last_order_at: user.last_order_at || null,
    daily_order_count: user.daily_order_count || 0,
    daily_order_count_date: user.daily_order_count_date || null,
    total_orders_lifetime: user.total_orders_lifetime || 0,
    mock_mode: !!user.mock_mode,
    // 2026-06-01 — Surface user_caps so Mission Control can render
    // the actual saved values in the 'caps: $X/order · Y/day · Z%
    // per trade' line. Previously omitted, so MC always showed the
    // default fallback values even after the operator saved
    // tighter caps via /bridge/user/caps. Operator reported tapping
    // 'Apply small-account defaults' showed no change in the UI.
    user_caps: user.user_caps || null,
    user_caps_updated_at: user.user_caps_updated_at || null,
    // 2026-06-01 — Per-vehicle options auto-mirror prefs. Mission Control
    // renders these as a 7-row toggle table (Equity, Long Call, Long Put,
    // Vertical Spread, LEAPs, Straddle, Moonshot) so the operator can
    // see/edit which vehicles are enabled for this user without leaving
    // the bridge section.
    options_prefs: user.options_prefs || null,
    options_prefs_updated_at: user.options_prefs_updated_at || null,
  };
}
