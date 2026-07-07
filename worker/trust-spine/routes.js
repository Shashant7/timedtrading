// Trust Spine — HTTP route handlers (imported from worker/index.js).

import { sendJSON } from "../api.js";
import { resolveAutonomyConfig, evaluateRungGates } from "./autonomy-ladder.js";
import { attachCalibratedEdge } from "./calibrated-edge.js";
import { buildTodayPlaysQueue } from "./plays-today.js";
import { mergeWhyFeed, formatDecisionWhyRow } from "./why-feed.js";
import { scoreEpochMetrics } from "./scorecard.js";

export async function handleTrustSpineRoutes(routeKey, ctx) {
  const { env, req, url, corsHeaders, requireKeyOrAdmin, requireAdminSession, kvGetJSON, KV } = ctx;

  if (routeKey === "GET /timed/plays/today") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 50);
    const profile = String(url.searchParams.get("profile") || "speculator").toLowerCase();
    let optionsPlays = [];
    try {
      const cacheKey = `timed:options:plays-of-day:${profile}:${limit}`;
      const cached = await kvGetJSON(KV, cacheKey);
      optionsPlays = cached?.plays || [];
      if (!optionsPlays.length) {
        const fallback = await kvGetJSON(KV, `timed:options:plays-of-day:speculator:${limit}`);
        optionsPlays = fallback?.plays || [];
      }
    } catch { /* fallback empty */ }

    let readySetups = [];
    try {
      const all = await kvGetJSON(KV, "timed:all:snapshot")
        || await kvGetJSON(KV, "timed:all:micro")
        || await kvGetJSON(KV, "timed:all:slim")
        || await kvGetJSON(KV, "timed:all");
      const map = all?.data || all?.map || all?.tickers || all || {};
      const entries = Array.isArray(map)
        ? map.map((t) => ({ sym: String(t?.ticker || "").toUpperCase(), t }))
        : Object.entries(map).map(([sym, t]) => ({ sym: String(sym).toUpperCase(), t }));
      for (const { sym, t } of entries) {
        if (!sym || !t || typeof t !== "object") continue;
        const stage = String(t?.kanban_stage || "").toLowerCase();
        if (stage === "accumulate" || stage === "act_now" || stage === "ready") {
          readySetups.push({ ticker: sym, ...t });
        }
      }
    } catch { /* */ }

    const queue = buildTodayPlaysQueue({ optionsPlays, readySetups, limit });
    return sendJSON({ ok: true, ...queue }, 200, corsHeaders(env, req));
  }

  if (routeKey === "GET /timed/why/recent") {
    const authFail = await requireAdminSession(req, env);
    if (authFail) return authFail;
    const db = env?.DB;
    if (!db) return sendJSON({ ok: false, error: "no_db" }, 503, corsHeaders(env, req));
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
    const rows = (await db.prepare(
      `SELECT * FROM decision_records ORDER BY ts DESC LIMIT ?1`,
    ).bind(limit).all())?.results || [];
    const feed = mergeWhyFeed(rows, []);
    return sendJSON({ ok: true, count: feed.length, items: feed }, 200, corsHeaders(env, req));
  }

  if (routeKey === "GET /timed/ledger/trades/:id/decisions") {
    const authFail = await requireAdminSession(req, env);
    if (authFail) return authFail;
    const db = env?.DB;
    if (!db) return sendJSON({ ok: false, error: "no_db" }, 503, corsHeaders(env, req));
    const raw = url.pathname.split("/timed/ledger/trades/")[1] || "";
    const tradeId = decodeURIComponent(raw.replace(/\/decisions$/, "")).trim();
    if (!tradeId) return sendJSON({ ok: false, error: "missing trade_id" }, 400, corsHeaders(env, req));
    const rows = (await db.prepare(
      `SELECT * FROM decision_records WHERE trade_id = ?1 ORDER BY ts ASC`,
    ).bind(tradeId).all())?.results || [];
    return sendJSON({
      ok: true,
      trade_id: tradeId,
      count: rows.length,
      decisions: rows.map(formatDecisionWhyRow).filter(Boolean),
    }, 200, corsHeaders(env, req));
  }

  if (routeKey === "GET /timed/admin/trust-spine/autonomy-status") {
    const authFail = await requireKeyOrAdmin(req, env);
    if (authFail) return authFail;
    const daCfg = env._deepAuditConfig || {};
    const autonomy = resolveAutonomyConfig(daCfg);
    let metrics = {};
    if (env?.DB) {
      try {
        const row = await env.DB.prepare(
          `SELECT COUNT(*) as n, COUNT(DISTINCT config_hash) as epochs FROM decision_records`,
        ).first();
        metrics.attributed_trades = Number(row?.n) || 0;
        metrics.config_epochs = Number(row?.epochs) || 0;
        metrics.reproducible = true;
      } catch { /* */ }
    }
    const rung = evaluateRungGates(metrics);
    return sendJSON({ ok: true, autonomy, rung_gates: rung }, 200, corsHeaders(env, req));
  }

  if (routeKey === "GET /timed/admin/trust-spine/edge-scorecard") {
    const authFail = await requireKeyOrAdmin(req, env);
    if (authFail) return authFail;
    const db = env?.DB;
    if (!db) return sendJSON({ ok: false, error: "no_db" }, 503, corsHeaders(env, req));
    let patterns = [];
    try {
      patterns = (await db.prepare(
        `SELECT pattern_id, name, expected_direction, hit_rate, expected_value, confidence, status
         FROM pattern_library WHERE status = 'active' ORDER BY expected_value DESC LIMIT 50`,
      ).all())?.results || [];
    } catch { /* */ }
    const dr = (await db.prepare(
      `SELECT conviction_tier, COUNT(*) as n FROM decision_records WHERE event_type = 'ENTRY' GROUP BY conviction_tier`,
    ).all())?.results || [];
    return sendJSON({
      ok: true,
      patterns_active: patterns.length,
      top_patterns: patterns.slice(0, 10),
      entry_conviction_distribution: dr,
      note: "Rank is display; calibrated EV + conviction tier drive sizing when flags ON.",
    }, 200, corsHeaders(env, req));
  }

  if (routeKey === "GET /timed/admin/trust-spine/scorecard") {
    const authFail = await requireKeyOrAdmin(req, env);
    if (authFail) return authFail;
    const db = env?.DB;
    if (!db) return sendJSON({ ok: false, error: "no_db" }, 503, corsHeaders(env, req));
    const days = Math.min(Number(url.searchParams.get("days")) || 7, 90);
    const since = Date.now() - days * 86400000;
    const epochs = (await db.prepare(
      `SELECT config_hash, COUNT(*) as decisions,
              SUM(CASE WHEN event_type = 'ENTRY' THEN 1 ELSE 0 END) as entries
       FROM decision_records WHERE ts >= ?1 AND config_hash IS NOT NULL AND config_hash != ''
       GROUP BY config_hash ORDER BY decisions DESC`,
    ).bind(since).all())?.results || [];

    const trades = (await db.prepare(
      `SELECT t.pnl, t.pnl_pct, t.exit_ts, dr.config_hash
       FROM trades t
       LEFT JOIN decision_records dr ON dr.trade_id = t.trade_id AND dr.event_type = 'ENTRY'
       WHERE t.exit_ts >= ?1 AND t.status IN ('WIN','LOSS') AND (t.run_id IS NULL OR t.run_id = '')`,
    ).bind(since).all())?.results || [];

    const scorecard = scoreEpochMetrics(epochs, trades);
    return sendJSON({ ok: true, days, ...scorecard }, 200, corsHeaders(env, req));
  }

  return null;
}
