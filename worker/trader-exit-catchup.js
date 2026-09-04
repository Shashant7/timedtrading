// worker/trader-exit-catchup.js
//
// 2026-08-27 — Heal Short Term EXITs that wrote D1 but never reached the
// broker (waitUntil torn down on deploy; AMZN 5:07 PM ET). Does NOT buy
// a trade the model already closed (EXPE: no manifest → nothing to sell).

import { catchupTraderExit } from "./broker-bridge-catchup-exit.js";
import { recordBridgeMirrorSkip } from "./broker-bridge-client.js";
import {
  isNyRegularMarketOpenStatic,
  isEquityBrokerFollowThroughStatic,
} from "./market-calendar.js";

const NOTE_PREFIX = "timed:trader-exit-catchup:";

export function rowHoldsReducerQty(row) {
  if (!row) return false;
  // 2026-09-04 (DPZ) — broker HOLDINGS are the truth for exits. The entry
  // preflight rejected for cash and auto-suppressed the manifest, but a
  // later fill left 0.2714 sh at the broker; when the model exited, this
  // suppression check skipped the close and the shares were stranded.
  // Entry-time suppression / rejected state must never block reducing a
  // position the broker actually holds — same doctrine as the index-DT
  // mirror ("closes never cap-gated"). The only gate is real held qty.
  const remaining = Number(row.broker_remaining_qty);
  return Number.isFinite(remaining) && remaining > 1e-9;
}

/**
 * Pair model EXIT ledger rows with broker manifest leftovers.
 * EXPE-class (exit, no manifest) yields no ops. AMZN-class (exit +
 * remaining 0.27) yields one op on the holding account only.
 */
export function planTraderExitCatchup({ exits = [], manifests = [] } = {}) {
  const byTrade = new Map();
  for (const row of manifests) {
    const id = String(row?.trade_id || "").trim();
    if (!id) continue;
    if (!byTrade.has(id)) byTrade.set(id, []);
    byTrade.get(id).push(row);
  }
  const ops = [];
  const seen = new Set();
  for (const ex of exits) {
    const tid = String(ex?.position_id || ex?.trade_id || "").trim();
    if (!tid) continue;
    for (const row of byTrade.get(tid) || []) {
      if (!rowHoldsReducerQty(row)) continue;
      const key = `${tid}|${row.user_id}|${row.broker_account_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ops.push({
        trade_id: tid,
        ticker: String(row.ticker || ex.ticker || "").toUpperCase(),
        user_id: row.user_id,
        broker_account_id: row.broker_account_id,
        qty: Number(row.broker_remaining_qty),
        price: Number(ex.price) || null,
        exit_ts: Number(ex.ts) || 0,
      });
    }
  }
  return ops;
}

async function loadExits(env, sinceMs) {
  if (!env?.DB?.prepare) return [];
  try {
    const r = await env.DB.prepare(
      `SELECT position_id, ticker, ts, qty, price
         FROM account_ledger
        WHERE mode = 'trader' AND event_type = 'EXIT' AND ts >= ?1
        ORDER BY ts DESC LIMIT 80`,
    ).bind(sinceMs).all();
    return r?.results || [];
  } catch (_) {
    return [];
  }
}

async function loadManifests(env) {
  try {
    const bridgeUrl = env?.BROKER_BRIDGE_URL || "https://bridge.internal";
    const svc = env?.BROKER_BRIDGE;
    const opKey = env?.BROKER_BRIDGE_OPERATOR_KEY;
    const headers = opKey ? { Authorization: `Bearer ${opKey}` } : {};
    const url = `${String(bridgeUrl).replace(/\/$/, "")}/bridge/manifest?limit=400&remaining=1`;
    const init = { method: "GET", headers };
    const r = svc && typeof svc.fetch === "function"
      ? await svc.fetch(new Request(url, init))
      : await fetch(url, init);
    const body = await r.json().catch(() => null);
    return Array.isArray(body?.rows) ? body.rows : [];
  } catch (_) {
    return [];
  }
}

async function recentlyNoted(env, tradeId) {
  try {
    const raw = await env?.KV_TIMED?.get(`${NOTE_PREFIX}${tradeId}`);
    return !!raw;
  } catch (_) {
    return false;
  }
}

async function noteCatchup(env, tradeId, kind) {
  try {
    await env?.KV_TIMED?.put(
      `${NOTE_PREFIX}${tradeId}`,
      JSON.stringify({ kind, ts: Date.now() }),
      { expirationTtl: 6 * 3600 },
    );
  } catch (_) { /* best-effort */ }
}

export async function runTraderExitCatchup(env, opts = {}) {
  const dryRun = opts.dry_run !== false;
  const hours = Math.min(168, Math.max(1, Number(opts.hours) || 72));
  const maxOps = Math.min(24, Math.max(1, Number(opts.max_ops) || 8));
  const now = opts.now instanceof Date ? opts.now : new Date();
  const sinceMs = Date.now() - hours * 3600 * 1000;
  const exits = Array.isArray(opts.exits) ? opts.exits : await loadExits(env, sinceMs);
  const manifests = Array.isArray(opts.manifests) ? opts.manifests : await loadManifests(env);
  const planned = planTraderExitCatchup({ exits, manifests });
  const rth = isNyRegularMarketOpenStatic(now);
  const eth = isEquityBrokerFollowThroughStatic(now);
  const results = [];

  for (const op of planned.slice(0, maxOps)) {
    const qty = Number(op.qty);
    if (!rth && qty < 1) {
      if (!dryRun) {
        const already = await recentlyNoted(env, op.trade_id);
        if (!already) {
          await recordBridgeMirrorSkip(env, {
            ticker: op.ticker,
            side: "exit",
            reason: "fractional_trim_deferred_to_rth",
            trade_id: op.trade_id,
            qty,
            meta: { source: "trader_exit_catchup" },
          });
          await noteCatchup(env, op.trade_id, "deferred_rth");
        }
      }
      results.push({ ...op, ok: false, skip: "fractional_trim_deferred_to_rth" });
      continue;
    }
    if (!rth && !eth) {
      results.push({ ...op, ok: false, skip: "equity_ah_too_late_for_broker" });
      continue;
    }
    if (dryRun) {
      results.push({ ...op, ok: true, dry_run: true });
      continue;
    }
    const out = await catchupTraderExit(env, {
      trade_id: op.trade_id,
      dry_run: false,
      user_id: op.user_id,
      broker_account_id: op.broker_account_id,
      qty: op.qty,
      price: op.price,
      reason: opts.reason || "trader_exit_catchup",
    });
    results.push({ ...op, ok: !!out?.ok, bridge: out });
    if (out?.ok) await noteCatchup(env, op.trade_id, "forwarded");
  }

  return {
    ok: true,
    dry_run: dryRun,
    planned: planned.length,
    results,
    forwarded: results.filter((r) => r.ok && !r.dry_run && !r.skip).length,
  };
}
