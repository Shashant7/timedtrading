/**
 * Shared investor → broker catch-up planner + runner.
 *
 * Used by:
 *   - POST /timed/admin/broker-bridge/catchup-investor (operator)
 *   - RTH auto-retry cron (anomaly recovery: ETH fractional reject, etc.)
 *   - COO self-heal when bridge coverage fails
 *
 * Buys/DCAs are thesis+price gated (see investor-catchup-gates.js).
 * Sells/trims/exits always plan (risk reduction).
 */

import { readClientRing, forwardInvestorMirror } from "./broker-bridge-client.js";
import {
  evaluateCatchupThesisGate,
  resolveCatchupLivePrice,
} from "./investor-catchup-gates.js";

async function kvJson(env, key) {
  try {
    const raw = await env?.KV_TIMED?.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Ring sides that satisfy a D1 lot action (mirror verb ≠ lot action). */
export function ringSidesForLotAction(action) {
  if (String(action || "").toUpperCase() === "SELL") {
    // forwardInvestorMirror writes side=trim|sell, never "SELL".
    return ["sell", "trim", "exit", "close"];
  }
  return ["buy"];
}

function lotAlreadyMirrored(mirroredOkIds, tradeId, action) {
  const ids = [String(tradeId), `inv-${tradeId}`];
  for (const side of ringSidesForLotAction(action)) {
    for (const id of ids) {
      if (mirroredOkIds.has(`${side}|${id}`)) return true;
    }
  }
  return false;
}

/**
 * 2026-07-30 — Auto catch-up bought missed DCAs then sold PRE_FOMC trims
 * for the same inv-* trade in one run (CRS/CW/NVDA). Relational sizing made
 * buy qty ≈ trim qty → Webull buy+sell churn, no Discord/email. When both
 * sides are still unmatched for one trade_id, keep risk-reducing sells and
 * defer buys to a later pass (after the sell is marked mirrored).
 */
export function suppressOffsettingCatchupBuys(planned = []) {
  const byTrade = new Map();
  for (const op of planned) {
    const tid = String(op?.trade_id || "");
    if (!tid) continue;
    if (!byTrade.has(tid)) byTrade.set(tid, { buys: [], sells: [] });
    const isBuy = ["dca", "add", "buy", "open"].includes(String(op?.kind || ""));
    if (isBuy) byTrade.get(tid).buys.push(op);
    else byTrade.get(tid).sells.push(op);
  }
  const drop = new Set();
  const skipped = [];
  for (const [tid, { buys, sells }] of byTrade) {
    if (!buys.length || !sells.length) continue;
    for (const b of buys) {
      drop.add(b);
      skipped.push({
        ...b,
        skip_reason: "offsetting_sell_same_trade",
        detail: {
          note: "Defer buy/DCA catch-up when a sell/trim for the same trade is also unmatched — avoids buy+sell churn",
          trade_id: tid,
          pending_sells: sells.map((s) => s.kind),
        },
      });
    }
  }
  return {
    planned: planned.filter((op) => !drop.has(op)),
    skipped_offsetting: skipped,
  };
}

/**
 * Plan catch-up ops from already-loaded lots + ring + scores + prices.
 * Pure aside from optional per-ticker latest lookups (passed in via livePrices map).
 *
 * @param {object} args
 * @returns {{ planned: object[], skipped_gates: object[], mirrored_ok_count: number }}
 */
export function planInvestorCatchupOps({
  lots = [],
  ring = [],
  scores = {},
  livePrices = {},
  tickerFilter = null,
  force = false,
  maxBuyDriftPct = 5,
  minScoreBuy = 30,
  skipBuys = false,
} = {}) {
  const mirroredOkIds = new Set(
    (ring || [])
      .filter((r) => String(r?.trade_id || "").startsWith("inv-")
        && r?.status === "ok"
        && (r?.rh_order_id || r?.broker_order_id || r?.order_id))
      .map((r) => `${String(r.side || "").toLowerCase()}|${String(r.trade_id)}`),
  );

  const seen = new Set();
  const planned = [];
  const skippedGates = [];

  for (const lot of lots || []) {
    const ticker = String(lot.ticker || "").toUpperCase();
    if (tickerFilter && !tickerFilter.has(ticker)) continue;
    const day = new Date(Number(lot.ts) || 0).toISOString().slice(0, 10);
    const dedupeKey = `${lot.position_id || lot.ticker}|${lot.action}|${day}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const posId = lot.position_id ? String(lot.position_id) : "";
    const tradeId = posId
      ? (posId.startsWith("inv-") ? posId : `inv-${posId}`)
      : `inv-${lot.ticker}-${lot.action}`;
    // 2026-07-30 — SELL lots must match ring side=trim (not only "sell").
    // Without this alias, every hourly auto catch-up re-fires trims forever.
    if (lotAlreadyMirrored(mirroredOkIds, tradeId, lot.action)) continue;

    const reasonU = String(lot.reason || "").toUpperCase();
    let kind;
    if (lot.action === "SELL") {
      kind = /INVALIDATION|EXIT|CLOSE|FULL/.test(reasonU) ? "exit" : "trim";
    } else if (lot.action === "DCA_BUY") {
      kind = "dca";
    } else {
      kind = "add";
    }

    const isBuy = kind === "dca" || kind === "add" || kind === "buy" || kind === "open";
    if (skipBuys && isBuy) {
      skippedGates.push({
        ticker,
        kind,
        shares: Number(lot.shares) || 0,
        price: Number(lot.price) || null,
        position_id: lot.position_id,
        lot_id: lot.id,
        lot_ts: lot.ts,
        skip_reason: "rth_closed_buy",
        detail: { note: "Auto buy/DCA catch-up waits for regular hours (Webull fractionals)" },
      });
      continue;
    }

    const scoreRow = scores[ticker] || {};
    const livePrice = livePrices[ticker] ?? null;
    const gate = evaluateCatchupThesisGate({
      kind,
      lotPrice: Number(lot.price) || null,
      livePrice,
      stage: scoreRow?.stage || null,
      score: scoreRow?.score ?? null,
      accumZone: scoreRow?.accumZone || null,
      maxBuyDriftPct,
      minScoreBuy,
      force,
    });

    const op = {
      ticker,
      kind,
      shares: Number(lot.shares) || 0,
      price: Number(lot.price) || null,
      position_id: lot.position_id,
      reason: `catchup_${lot.reason || lot.action}`,
      trade_id: tradeId,
      lot_id: lot.id,
      lot_ts: lot.ts,
      live_price: livePrice,
      stage: scoreRow?.stage || null,
      score: scoreRow?.score ?? null,
      drift_pct: gate.drift_pct,
      gate_reason: gate.reason,
    };

    if (!gate.allow) {
      skippedGates.push({
        ...op,
        skip_reason: gate.reason,
        detail: gate.detail || null,
      });
      continue;
    }
    planned.push(op);
  }

  const collapsed = suppressOffsettingCatchupBuys(planned);
  if (collapsed.skipped_offsetting.length) {
    skippedGates.push(...collapsed.skipped_offsetting);
  }

  return {
    planned: collapsed.planned,
    skipped_gates: skippedGates,
    mirrored_ok_count: mirroredOkIds.size,
  };
}

/**
 * Load state + plan + optionally forward to the bridge.
 *
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.dry_run=true]
 * @param {number} [opts.hours=72]
 * @param {boolean} [opts.force=false]
 * @param {number} [opts.max_buy_drift_pct=5]
 * @param {number} [opts.min_score_buy=30]
 * @param {string[]} [opts.tickers]
 * @param {number} [opts.max_ops] cap forwarded ops (auto path)
 * @param {boolean} [opts.skip_buys=false] defer buys when outside RTH
 * @param {string} [opts.source="catchup_investor"]
 */
export async function runInvestorCatchup(env, opts = {}) {
  const dryRun = opts.dry_run !== false;
  const hours = Math.min(168, Math.max(1, Number(opts.hours) || 72));
  const force = opts.force === true;
  const maxBuyDriftPct = Number.isFinite(Number(opts.max_buy_drift_pct))
    ? Number(opts.max_buy_drift_pct) : 5;
  const minScoreBuy = Number.isFinite(Number(opts.min_score_buy))
    ? Number(opts.min_score_buy) : 30;
  const tickerFilter = Array.isArray(opts.tickers)
    ? new Set(opts.tickers.map((t) => String(t || "").toUpperCase()).filter(Boolean))
    : null;
  const maxOps = Number.isFinite(Number(opts.max_ops)) && Number(opts.max_ops) > 0
    ? Math.floor(Number(opts.max_ops))
    : null;
  const skipBuys = opts.skip_buys === true;
  const source = String(opts.source || "catchup_investor").slice(0, 64);

  const sinceMs = Date.now() - hours * 3600000;
  const { results: lots } = await env.DB.prepare(
    `SELECT id, position_id, ticker, action, shares, price, ts, reason
     FROM investor_lots
     WHERE ts >= ?1 AND action IN ('BUY','SELL','DCA_BUY')
     ORDER BY ts ASC`,
  ).bind(sinceMs).all().catch(() => ({ results: [] }));

  const ring = await readClientRing(env);
  const scores = (await kvJson(env, "timed:investor:scores")) || {};
  const pricesBlob = (await kvJson(env, "timed:prices")) || {};
  const pricesMap = pricesBlob.prices || pricesBlob || {};

  // Resolve live prices for unique tickers in the lot set (bounded).
  const tickersNeeded = new Set();
  for (const lot of lots || []) {
    const t = String(lot.ticker || "").toUpperCase();
    if (t && (!tickerFilter || tickerFilter.has(t))) tickersNeeded.add(t);
  }
  const livePrices = {};
  for (const ticker of tickersNeeded) {
    const latest = await kvJson(env, `timed:latest:${ticker}`);
    livePrices[ticker] = resolveCatchupLivePrice(pricesMap[ticker], latest);
  }

  const plannedFull = planInvestorCatchupOps({
    lots: lots || [],
    ring: ring || [],
    scores,
    livePrices,
    tickerFilter,
    force,
    maxBuyDriftPct,
    minScoreBuy,
    skipBuys,
  });

  let planned = plannedFull.planned;
  let truncated = 0;
  if (maxOps != null && planned.length > maxOps) {
    truncated = planned.length - maxOps;
    planned = planned.slice(0, maxOps);
  }

  const results = [];
  if (!dryRun) {
    const retryNonce = String(Date.now());
    for (const op of planned) {
      const r = await forwardInvestorMirror(env, {
        ticker: op.ticker,
        kind: op.kind,
        shares: op.shares,
        price: op.price,
        position_id: op.position_id,
        reason: op.reason,
        source,
        retry_nonce: retryNonce,
      });
      results.push({
        ticker: op.ticker,
        kind: op.kind,
        trade_id: op.trade_id,
        lot_id: op.lot_id,
        ok: !!r?.ok,
        skip: r?.skip || null,
        reject: r?.bridge_reject_reason || r?.error || null,
        scaled_qty: r?.bridge_scaled_qty ?? null,
        drift_pct: op.drift_pct,
        stage: op.stage,
        score: op.score,
      });
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    hours,
    force,
    max_buy_drift_pct: maxBuyDriftPct,
    min_score_buy: minScoreBuy,
    skip_buys: skipBuys,
    source,
    candidate_lots: (lots || []).length,
    planned: planned.length,
    planned_ops: planned,
    skipped_gates: plannedFull.skipped_gates,
    skipped_gates_count: plannedFull.skipped_gates.length,
    truncated_ops: truncated,
    mirrored_ok_count: plannedFull.mirrored_ok_count,
    results,
  };
}
