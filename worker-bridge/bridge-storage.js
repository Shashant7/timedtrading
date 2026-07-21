// worker-bridge/bridge-storage.js
//
// 2026-05-29 — KV + D1 helpers for the broker bridge.
// All per-user state lives in BRIDGE_KV under `bridge:user:{user_id}`.
// All decisions/responses logged to BRIDGE_DB.bridge_audit.

import { ensureMirrorManifestSchema } from "./bridge-manifest.js";

export async function ensureBridgeSchema(env) {
  const db = env?.BRIDGE_DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS bridge_audit (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        user_id         TEXT,
        trade_id        TEXT,
        ticker          TEXT,
        action          TEXT,
        side            TEXT,
        qty             REAL,
        price_target    REAL,
        sl              REAL,
        tp              REAL,
        estimated_value REAL,
        rh_order_id     TEXT,
        status          TEXT,
        reject_reason   TEXT,
        request_json    TEXT,
        response_json   TEXT,
        latency_ms      INTEGER
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_audit_user_ts ON bridge_audit(user_id, ts DESC)`,
    ).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_audit_ticker_ts ON bridge_audit(ticker, ts DESC)`,
    ).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_audit_action_ts ON bridge_audit(action, ts DESC)`,
    ).run();
  } catch (e) {
    console.warn("[BRIDGE] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
  // 2026-06-01 — Phase A: mirror_trade_manifest table (one row per
  // model trade × user × broker_account). Best-effort + cached.
  await ensureMirrorManifestSchema(env);
}

const USER_KEY = (userId) => `bridge:user:${String(userId).toLowerCase()}`;
const KILL_SWITCH_KEY = "bridge:killswitch_global";
const OAUTH_STATE_KEY = (state) => `bridge:oauth:state:${state}`;
const OAUTH_STATE_TTL_S = 600; // 10 min

export async function readUser(env, userId) {
  const KV = env?.BRIDGE_KV;
  if (!KV || !userId) return null;
  try {
    const raw = await KV.get(USER_KEY(userId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[BRIDGE] readUser failed for ${userId}:`, String(e?.message || e).slice(0, 200));
    return null;
  }
}

export async function writeUser(env, userId, userObj) {
  const KV = env?.BRIDGE_KV;
  if (!KV || !userId) return false;
  try {
    await KV.put(USER_KEY(userId), JSON.stringify({ ...userObj, user_id: String(userId).toLowerCase() }));
    return true;
  } catch (e) {
    console.warn(`[BRIDGE] writeUser failed for ${userId}:`, String(e?.message || e).slice(0, 200));
    return false;
  }
}

export async function listConnectedUsers(env, limit = 100) {
  const KV = env?.BRIDGE_KV;
  if (!KV) return [];
  try {
    const list = await KV.list({ prefix: "bridge:user:", limit });
    const out = [];
    for (const k of list.keys || []) {
      const raw = await KV.get(k.name);
      if (raw) out.push(JSON.parse(raw));
    }
    return out;
  } catch (e) {
    console.warn("[BRIDGE] listConnectedUsers failed:", String(e?.message || e).slice(0, 200));
    return [];
  }
}

/**
 * Resolve a bridge user row for order preflight.
 * Supports owner email → enabled Webull sub-account fallback.
 */
export async function resolveBridgeUser(env, userId, opts = {}) {
  const id = String(userId || "").toLowerCase().trim();
  if (!id) return null;

  const direct = await readUser(env, id);
  if (direct?.status === "connected") return direct;

  const all = await listConnectedUsers(env, 200);
  const subs = all.filter((u) => {
    if (String(u?.broker || "").toLowerCase() !== "webull") return false;
    if (u.status !== "connected") return false;
    if (u.owner_email === id) return true;
    return String(u.user_id || "").startsWith(`${id}#webull#`);
  });
  if (!subs.length) return direct || null;

  const enabled = subs.filter((u) => u.broker_integration_enabled);
  const pool = enabled.length ? enabled : subs;
  const preferClass = opts.preferClass || env?.WEBULL_DEFAULT_ACCOUNT_CLASS || "INDIVIDUAL_MARGIN";
  return pool.find((u) => u.webull_account_class === preferClass)
    || pool.find((u) => u.webull_account_class === "INDIVIDUAL_CASH")
    || pool[0];
}

/**
 * Resolve ALL broker accounts belonging to an owner — used for multi-account
 * fan-out (owner runs 5 Webull + 1 IBKR). Returns the direct row plus any
 * Webull sub-account rows (owner_email match or `{owner}#webull#…` key).
 * @param {object} opts { enabledOnly=true }
 */
export async function resolveBridgeAccounts(env, ownerId, opts = {}) {
  const id = String(ownerId || "").toLowerCase().trim();
  if (!id) return [];
  const enabledOnly = opts.enabledOnly !== false;

  const seen = new Map();
  const add = (u) => {
    if (!u || u.status !== "connected") return;
    const key = String(u.user_id || "").toLowerCase();
    if (!key || seen.has(key)) return;
    if (enabledOnly && !u.broker_integration_enabled) return;
    seen.set(key, u);
  };

  add(await readUser(env, id));
  const all = await listConnectedUsers(env, 200);
  for (const u of all) {
    const uid = String(u?.user_id || "").toLowerCase();
    if (uid === id) { add(u); continue; }
    if (u?.owner_email && String(u.owner_email).toLowerCase() === id) { add(u); continue; }
    if (uid.startsWith(`${id}#`)) { add(u); continue; }
  }
  return Array.from(seen.values());
}

export async function getKillSwitch(env) {
  const KV = env?.BRIDGE_KV;
  if (!KV) return "off";
  try { return (await KV.get(KILL_SWITCH_KEY)) || "off"; } catch (_) { return "off"; }
}

export async function setKillSwitch(env, state) {
  const KV = env?.BRIDGE_KV;
  if (!KV) return false;
  const norm = String(state).toLowerCase() === "on" ? "on" : "off";
  try { await KV.put(KILL_SWITCH_KEY, norm); return true; } catch (_) { return false; }
}

// ── Order idempotency ──────────────────────────────────────────────
// A stable client_order_id (e.g. `tt-exit-<tradeId>`) is claimed once per
// window. A repeat submit (retry, or a systematic false-exit that fires 3x
// like AMZN 2026-07-20) returns { fresh:false } so the caller can skip the
// real broker order. TTL 24h — a trade legitimately enters/exits once.
const ORDER_CLAIM_KEY = (id) => `bridge:order:claim:${id}`;
const ORDER_CLAIM_TTL_S = 24 * 60 * 60;

export async function claimOrderIdempotency(env, clientOrderId) {
  const KV = env?.BRIDGE_KV;
  const id = String(clientOrderId || "").trim();
  if (!KV || !id) return { fresh: true, id: id || null, skipped: "no_id" };
  try {
    const existing = await KV.get(ORDER_CLAIM_KEY(id));
    if (existing) {
      let prev = null;
      try { prev = JSON.parse(existing); } catch (_) { prev = { raw: existing }; }
      return { fresh: false, id, prior: prev };
    }
    await KV.put(
      ORDER_CLAIM_KEY(id),
      JSON.stringify({ claimed_at: Date.now() }),
      { expirationTtl: ORDER_CLAIM_TTL_S },
    );
    return { fresh: true, id };
  } catch (_) {
    // KV failure must not block a legitimate order.
    return { fresh: true, id, skipped: "kv_error" };
  }
}

export async function recordOauthState(env, state, payload) {
  const KV = env?.BRIDGE_KV;
  if (!KV) return false;
  try {
    await KV.put(OAUTH_STATE_KEY(state), JSON.stringify(payload), { expirationTtl: OAUTH_STATE_TTL_S });
    return true;
  } catch (_) { return false; }
}

export async function consumeOauthState(env, state) {
  const KV = env?.BRIDGE_KV;
  if (!KV) return null;
  try {
    const raw = await KV.get(OAUTH_STATE_KEY(state));
    if (!raw) return null;
    await KV.delete(OAUTH_STATE_KEY(state)); // one-shot
    return JSON.parse(raw);
  } catch (_) { return null; }
}

// Audit-log writer. Best-effort — never throws to the caller because
// audit-write failure must not block trade flow. Returns id on success.
export async function writeAudit(env, row) {
  const db = env?.BRIDGE_DB;
  if (!db) return null;
  try {
    const result = await db.prepare(`
      INSERT INTO bridge_audit
        (ts, user_id, trade_id, ticker, action, side, qty,
         price_target, sl, tp, estimated_value, rh_order_id, status,
         reject_reason, request_json, response_json, latency_ms)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)
    `).bind(
      row.ts || Date.now(),
      row.user_id || null,
      row.trade_id || null,
      row.ticker || null,
      row.action || "unknown",
      row.side || null,
      row.qty == null ? null : Number(row.qty),
      row.price_target == null ? null : Number(row.price_target),
      row.sl == null ? null : Number(row.sl),
      row.tp == null ? null : Number(row.tp),
      row.estimated_value == null ? null : Number(row.estimated_value),
      row.rh_order_id || null,
      row.status || "ok",
      row.reject_reason || null,
      row.request_json ? JSON.stringify(row.request_json).slice(0, 4000) : null,
      row.response_json ? JSON.stringify(row.response_json).slice(0, 4000) : null,
      row.latency_ms == null ? null : Number(row.latency_ms),
    ).run();
    return result?.meta?.last_row_id || null;
  } catch (e) {
    console.warn("[BRIDGE] writeAudit failed:", String(e?.message || e).slice(0, 200));
    return null;
  }
}

export async function recentAudit(env, opts = {}) {
  const db = env?.BRIDGE_DB;
  if (!db) return [];
  const userId = opts.user_id ? String(opts.user_id).toLowerCase() : null;
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  try {
    let q, b;
    if (userId) {
      q = `SELECT id, ts, user_id, trade_id, ticker, action, side, qty,
                  price_target, sl, tp, estimated_value, rh_order_id, status,
                  reject_reason, latency_ms
             FROM bridge_audit WHERE user_id = ?1 ORDER BY ts DESC LIMIT ?2`;
      b = [userId, limit];
    } else {
      q = `SELECT id, ts, user_id, trade_id, ticker, action, side, qty,
                  price_target, sl, tp, estimated_value, rh_order_id, status,
                  reject_reason, latency_ms
             FROM bridge_audit ORDER BY ts DESC LIMIT ?1`;
      b = [limit];
    }
    const r = await db.prepare(q).bind(...b).all().catch(() => ({ results: [] }));
    return r?.results || [];
  } catch (e) {
    console.warn("[BRIDGE] recentAudit failed:", String(e?.message || e).slice(0, 200));
    return [];
  }
}
