// worker/broker-intents.js
//
// Durable order-intent ledger for broker reducers (2026-09-05).
//
// Before this, forwardOrderToBridge was fire-and-forget: a reducer that the
// bridge skipped (after 19:00 ET, sub-share outside RTH) or that died on a
// fetch error was gone. The paper book closed, Discord said "(filled)", and
// the broker kept the shares (UDOW W36, DPZ, AMZN). Every reducer that does
// not come back placed now leaves a row in D1 `broker_intents`; the */5 cron
// drains pending rows whenever the broker can act, with a fresh
// client_order_id per attempt (bridge idempotency stays per attempt).
//
// Scope: trader-mode SELL / TRIM / EXIT on equities and LETFs. Entries are
// deliberately excluded — a deferred entry must re-qualify in the next
// window, not chase.

import {
  isNyRegularMarketOpenStatic,
  isEquityBrokerFollowThroughStatic,
} from "./market-calendar.js";

export const INTENT_MAX_ATTEMPTS = 12;
export const INTENT_TTL_MS = 3 * 24 * 60 * 60 * 1000; // three calendar days covers a weekend

const REDUCER_SIDES = new Set(["sell", "trim", "exit", "close", "reduce"]);

// Skips that mean "the window is wrong", not "the order is wrong".
const DEFERRED_SKIPS = new Set([
  "equity_ah_too_late_for_broker",
  "fractional_trim_deferred_to_rth",
  "outside_rth",
  "ah_too_late",
]);

// Skips / rejects that will not heal by retrying.
const TERMINAL_PATTERNS = [
  /no_manifest/i,
  /no_bridge_url|no_hmac_key|sign_failed/i,
  /naked_short/i,
  /not_held|nothing_to_sell|zero_qty|qty_zero|position_zero/i,
  /already_closed|already_flat/i,
  /unsupported|not_supported/i,
  /invalid_symbol|unknown_ticker/i,
];

const TRANSIENT_PATTERNS = [
  /timeout|timed out|aborted/i,
  /rate|throttl|429/i,
  /unavailable|503|502|504|500/i,
  /token|auth|login|session/i,
  /fetch_error|network|ECONN|socket/i,
];

export function isReducerOrder(order) {
  if (!order || typeof order !== "object") return false;
  if (String(order.mode || "") !== "trader") return false;
  const side = String(order.side || "").toLowerCase();
  if (!REDUCER_SIDES.has(side)) return false;
  const vehicle = String(order.vehicle || "").toLowerCase();
  if (vehicle.includes("option")) return false;
  return true;
}

/**
 * Classify what forwardOrderToBridge returned.
 * @returns {"placed"|"deferred"|"transient"|"terminal"}
 */
export function classifyBridgeOutcome(result) {
  if (!result || typeof result !== "object") return "transient";
  if (result.ok === true) return "placed";
  const skip = String(result.skip || "");
  if (skip) {
    if (DEFERRED_SKIPS.has(skip)) return "deferred";
    if (TERMINAL_PATTERNS.some((re) => re.test(skip))) return "terminal";
    return "deferred";
  }
  const http = Number(result.http_status) || 0;
  const reject = String(
    result.response?.reject_reason
    || result.response?.error
    || result.response?.message
    || result.error
    || "",
  );
  if (TERMINAL_PATTERNS.some((re) => re.test(reject))) return "terminal";
  if (http >= 500 || http === 429 || http === 0) return "transient";
  if (TRANSIENT_PATTERNS.some((re) => re.test(reject))) return "transient";
  if (http >= 400) return "terminal";
  return "transient";
}

export function intentIdFor(order) {
  const tradeId = String(order?.trade_id || order?.ticker || "unknown");
  const side = String(order?.side || "exit").toLowerCase();
  const user = String(order?.user_id || "operator");
  return `${user}|${tradeId}|${side}`;
}

/**
 * Pure: may this intent be attempted right now?
 * Sub-share reducers need RTH (Webull fractional); whole shares can go while
 * the broker follows through (PM 04:00 -> 19:00 ET, 17:00 early close).
 */
export function intentWindowOpen(intent, now = new Date()) {
  const d = now instanceof Date ? now : new Date(Number(now));
  const qty = Number(intent?.qty);
  const fractional = Number.isFinite(qty) && qty > 0 && Math.abs(qty - Math.round(qty)) > 1e-9;
  const deferredReason = String(intent?.last_reason || "");
  if (fractional || /fractional/i.test(deferredReason)) return isNyRegularMarketOpenStatic(d);
  return isEquityBrokerFollowThroughStatic(d);
}

/**
 * Pure: next state for an intent after one attempt.
 * @returns {{ status: string, terminal: boolean }}
 */
export function nextIntentState(intent, outcome) {
  const attempts = (Number(intent?.attempts) || 0) + 1;
  if (outcome === "placed") return { status: "filled", terminal: true, attempts };
  if (outcome === "terminal") return { status: "rejected", terminal: true, attempts };
  if (attempts >= INTENT_MAX_ATTEMPTS) return { status: "exhausted", terminal: true, attempts };
  return { status: "pending", terminal: false, attempts };
}

// ─── D1 layer ───────────────────────────────────────────────────────────

let _schemaReady = false;
export async function ensureBrokerIntentSchema(env) {
  if (_schemaReady) return true;
  const db = env?.DB;
  if (!db) return false;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS broker_intents (
        id TEXT PRIMARY KEY,
        trade_id TEXT,
        ticker TEXT NOT NULL,
        side TEXT NOT NULL,
        qty REAL,
        user_id TEXT,
        lane TEXT,
        reason TEXT,
        order_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_outcome TEXT,
        last_reason TEXT,
        last_client_order_id TEXT,
        created_ts INTEGER NOT NULL,
        updated_ts INTEGER NOT NULL,
        expires_ts INTEGER NOT NULL,
        filled_ts INTEGER
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_broker_intents_status ON broker_intents(status, expires_ts)`,
    ).run().catch(() => {});
    _schemaReady = true;
    return true;
  } catch (e) {
    console.error("[BROKER INTENT] schema init failed:", String(e?.message || e).slice(0, 200));
    return false;
  }
}

function outcomeReason(result) {
  return String(
    result?.skip
    || result?.response?.reject_reason
    || result?.response?.error
    || result?.response?.message
    || result?.error
    || (result?.http_status ? `http_${result.http_status}` : "")
    || "",
  ).slice(0, 200);
}

/**
 * Record (or refresh) a pending intent for a reducer that did not place.
 * Called by forwardOrderToBridge on every non-placed outcome. Returns the
 * outcome so callers can log it; never throws.
 */
export async function recordBrokerIntent(env, order, result, now = Date.now()) {
  try {
    if (!isReducerOrder(order)) return null;
    if (order?.meta?.intent_id) return null; // drain attempts update their own row
    const outcome = classifyBridgeOutcome(result);
    if (outcome === "terminal") return outcome;
    if (outcome === "placed") {
      await settleBrokerIntent(env, { trade_id: order.trade_id, side: order.side, user_id: order.user_id }, now);
      return outcome;
    }
    if (!(await ensureBrokerIntentSchema(env))) return outcome;
    const id = intentIdFor(order);
    const reason = outcomeReason(result);
    const lane = String(order?.meta?.lane || order?.vehicle || "trader");
    const orderJson = JSON.stringify({ ...order, client_order_id: undefined });
    await env.DB.prepare(`
      INSERT INTO broker_intents
        (id, trade_id, ticker, side, qty, user_id, lane, reason, order_json, status,
         attempts, last_outcome, last_reason, last_client_order_id, created_ts, updated_ts, expires_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        qty = excluded.qty,
        order_json = excluded.order_json,
        status = 'pending',
        attempts = 0,
        last_outcome = excluded.last_outcome,
        last_reason = excluded.last_reason,
        updated_ts = excluded.updated_ts,
        expires_ts = excluded.expires_ts
    `).bind(
      id,
      String(order.trade_id || ""),
      String(order.ticker || "").toUpperCase(),
      String(order.side || "").toLowerCase(),
      Number(order.qty) || null,
      String(order.user_id || ""),
      lane,
      String(order.reason || order.meta?.reason || "").slice(0, 120),
      orderJson,
      outcome,
      reason,
      String(order.client_order_id || ""),
      now,
      now,
      now + INTENT_TTL_MS,
    ).run();
    console.log(`[BROKER INTENT] queued ${order.ticker} ${order.side} qty=${order.qty} (${outcome}: ${reason})`);
    return outcome;
  } catch (e) {
    console.warn("[BROKER INTENT] record failed:", String(e?.message || e).slice(0, 200));
    return null;
  }
}

/** Mark an intent filled from outside the drain (e.g. a manual catch-up). */
export async function settleBrokerIntent(env, { trade_id, side, user_id, status = "filled" } = {}, now = Date.now()) {
  try {
    if (!(await ensureBrokerIntentSchema(env))) return false;
    const id = intentIdFor({ trade_id, side, user_id });
    await env.DB.prepare(
      `UPDATE broker_intents SET status = ?, updated_ts = ?, filled_ts = CASE WHEN ? = 'filled' THEN ? ELSE filled_ts END
       WHERE id = ? AND status = 'pending'`,
    ).bind(status, now, status, now, id).run();
    return true;
  } catch (_) {
    return false;
  }
}

export async function listPendingBrokerIntents(env, { limit = 25, now = Date.now() } = {}) {
  if (!(await ensureBrokerIntentSchema(env))) return [];
  const res = await env.DB.prepare(
    `SELECT * FROM broker_intents WHERE status = 'pending' AND expires_ts > ? ORDER BY created_ts ASC LIMIT ?`,
  ).bind(now, limit).all();
  return res?.results || [];
}

/**
 * Retry every pending intent whose window is open.
 * @param {object} env
 * @param {{ forward: Function, now?: number, limit?: number }} opts
 *   forward(env, order) must be forwardOrderToBridge (injected to avoid an
 *   import cycle).
 */
export async function drainBrokerIntents(env, { forward, now = Date.now(), limit = 25 } = {}) {
  const out = { scanned: 0, attempted: 0, filled: 0, rejected: 0, exhausted: 0, deferred: 0, expired: 0, results: [] };
  if (typeof forward !== "function") return out;
  const db = env?.DB;
  if (!db) return out;
  // Expire stale rows first so the operator sees them as such, not pending.
  try {
    const exp = await db.prepare(
      `UPDATE broker_intents SET status = 'expired', updated_ts = ? WHERE status = 'pending' AND expires_ts <= ?`,
    ).bind(now, now).run();
    out.expired = Number(exp?.meta?.changes) || 0;
  } catch (_) { /* best effort */ }

  const rows = await listPendingBrokerIntents(env, { limit, now });
  out.scanned = rows.length;
  for (const row of rows) {
    if (!intentWindowOpen(row, new Date(now))) { out.deferred += 1; continue; }
    let order;
    try { order = JSON.parse(row.order_json); } catch (_) { order = null; }
    if (!order) {
      await db.prepare(`UPDATE broker_intents SET status = 'rejected', last_reason = 'bad_order_json', updated_ts = ? WHERE id = ?`)
        .bind(now, row.id).run().catch(() => {});
      out.rejected += 1;
      continue;
    }
    const attempt = (Number(row.attempts) || 0) + 1;
    const clientOrderId = `tt-intent-${String(row.ticker).toLowerCase()}-${attempt}-${now.toString(36)}`.slice(0, 60);
    const liveOrder = {
      ...order,
      client_order_id: clientOrderId,
      meta: { ...(order.meta || {}), intent_id: row.id, intent_attempt: attempt, catch_up: true },
    };
    out.attempted += 1;
    let result;
    try {
      result = await forward(env, liveOrder);
    } catch (e) {
      result = { ok: false, error: String(e?.message || e) };
    }
    const outcome = classifyBridgeOutcome(result);
    const next = nextIntentState(row, outcome);
    const reason = outcomeReason(result);
    await db.prepare(`
      UPDATE broker_intents
      SET status = ?, attempts = ?, last_outcome = ?, last_reason = ?, last_client_order_id = ?, updated_ts = ?,
          filled_ts = CASE WHEN ? = 'filled' THEN ? ELSE filled_ts END
      WHERE id = ? AND status = 'pending'
    `).bind(next.status, next.attempts, outcome, reason, clientOrderId, now, next.status, now, row.id).run().catch(() => {});
    if (next.status === "filled") out.filled += 1;
    else if (next.status === "rejected") out.rejected += 1;
    else if (next.status === "exhausted") out.exhausted += 1;
    out.results.push({ id: row.id, ticker: row.ticker, side: row.side, qty: row.qty, outcome, status: next.status, reason });
    console.log(`[BROKER INTENT] ${row.ticker} ${row.side} attempt=${attempt} -> ${outcome} (${next.status})${reason ? ` ${reason}` : ""}`);
  }
  return out;
}
