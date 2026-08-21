/**
 * Shared investor → broker catch-up planner + runner.
 *
 * Used by:
 *   - POST /timed/admin/broker-bridge/catchup-investor (operator)
 *   - RTH auto-retry cron (anomaly recovery: ETH fractional reject, etc.)
 *   - COO self-heal when bridge coverage fails
 *
 * Policy (2026-07-30):
 *   - Last signal wins per position — older unmatched lots are superseded.
 *   - Signals expire after 4 hours of NY RTH (ETH / overnight excluded).
 *   - Buys/DCAs are thesis+price gated; sells stay permissive while fresh.
 */

import { readClientRing, forwardInvestorMirror } from "./broker-bridge-client.js";
import {
  evaluateCatchupThesisGate,
  resolveCatchupLivePrice,
  isCatchupSignalFresh,
  CATCHUP_SIGNAL_TTL_RTH_MS,
} from "./investor-catchup-gates.js";

/** Hourly RTH + COO heal cap. Raised 8→24 after the 2026-08-21 OpEx storm. */
export const CATCHUP_AUTO_MAX_OPS = 24;

/**
 * True when a client-ring row is a real broker place (not a burned
 * `dedupe_skip`). A 2026-07-27 invariant: `{ ok:true, deduped:true }`
 * has no order id and must NOT look like a fill.
 *
 * 2026-08-21 — Live Webull successes often stored `status:ok` +
 * `http_status:200` with `rh_order_id:null` because the client only
 * read `parsed.rh_order_id`. Those legacy rows are real places; treat
 * them as mirrored so catch-up does not double-trim. New rows persist
 * `order_id` / `deduped`.
 */
export function ringLooksLikeRealPlace(r) {
  if (!r || String(r.status || "") !== "ok") return false;
  if (r.deduped === true || r.dedupe_skip === true) return false;
  const reject = String(r.reject_reason || r.error || "").toLowerCase();
  if (reject.includes("dedup") || reject.includes("duplicate_client")) return false;
  if (r.rh_order_id || r.broker_order_id || r.order_id) return true;
  return Number(r.http_status) === 200;
}

/** Exits/trims before buys so a max_ops slice cannot starve unmatched sells. */
export function prioritizeCatchupOps(ops = []) {
  const rank = (op) => {
    const k = String(op?.kind || "").toLowerCase();
    if (k === "exit" || k === "close") return 0;
    if (k === "trim" || k === "reduce" || k === "sell") return 1;
    return 2;
  };
  return [...(ops || [])].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (Number(a.lot_ts) || 0) - (Number(b.lot_ts) || 0);
  });
}

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

function tradeIdForLot(lot) {
  const posId = lot?.position_id != null ? String(lot.position_id) : "";
  if (posId) return posId.startsWith("inv-") ? posId : `inv-${posId}`;
  return `inv-${lot?.ticker || "UNK"}-${lot?.action || "x"}`;
}

function kindForLot(lot) {
  const reasonU = String(lot?.reason || "").toUpperCase();
  if (lot?.action === "SELL") {
    return /INVALIDATION|EXIT|CLOSE|FULL/.test(reasonU) ? "exit" : "trim";
  }
  if (lot?.action === "DCA_BUY") return "dca";
  return "add";
}

/**
 * Per position, keep only the chronologically latest lot.
 * Older lots are returned as superseded skips (last signal wins).
 *
 * 2026-08-19 — Tiebreaker for same-timestamp lots: `exit` (invalidation
 * breach, full close) beats `trim` (event-risk partial). Same auto-
 * rebalance pass can write both simultaneously (FN/PANW/CAT/DE tonight);
 * the full-flatten must win so the broker mirror does not leave a
 * residual position when the model is already CLOSED.
 */
function lotPreferenceRank(lot) {
  const kind = kindForLot(lot);
  if (kind === "exit") return 3;
  if (kind === "trim") return 2;
  if (kind === "sell") return 2;
  if (kind === "add" || kind === "open") return 1;
  if (kind === "dca") return 1;
  return 0;
}

export function selectLatestSignalLots(lots = []) {
  const byPos = new Map();
  for (const lot of lots || []) {
    const key = String(lot?.position_id || lot?.ticker || "").toUpperCase();
    if (!key) continue;
    const prev = byPos.get(key);
    if (!prev) { byPos.set(key, lot); continue; }
    const lotTs = Number(lot.ts) || 0;
    const prevTs = Number(prev.ts) || 0;
    if (lotTs > prevTs) { byPos.set(key, lot); continue; }
    if (lotTs < prevTs) continue;
    // Ties: prefer the deeper reduce (exit > trim > add).
    if (lotPreferenceRank(lot) > lotPreferenceRank(prev)) {
      byPos.set(key, lot);
    }
  }
  const latest = [...byPos.values()];
  const latestIds = new Set(latest.map((l) => l.id));
  const superseded = (lots || [])
    .filter((l) => l?.id && !latestIds.has(l.id))
    .map((l) => {
      const winner = byPos.get(String(l.position_id || l.ticker || "").toUpperCase());
      return {
        ticker: String(l.ticker || "").toUpperCase(),
        kind: kindForLot(l),
        shares: Number(l.shares) || 0,
        price: Number(l.price) || null,
        position_id: l.position_id,
        lot_id: l.id,
        lot_ts: l.ts,
        trade_id: tradeIdForLot(l),
        skip_reason: "superseded_by_newer_signal",
        detail: {
          note: "Last signal wins — a newer lot on this position replaces older unmatched signals",
          newer_lot_id: winner?.id || null,
          newer_lot_ts: winner?.ts || null,
          newer_action: winner?.action || null,
        },
      };
    });
  return { latest, superseded };
}

/**
 * Plan catch-up ops from already-loaded lots + ring + scores + prices.
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
  nowMs = Date.now(),
  ttlRthMs = CATCHUP_SIGNAL_TTL_RTH_MS,
  isRthDay = undefined,
  // 2026-08-12 — Fresh-lot fidelity window in RTH-elapsed ms (same clock as
  // the 4h signal TTL). Buy lots younger than this mirror the model book
  // faithfully: thesis gates (stage/score/zone) are skipped, price gates
  // kept. RTH-based so a 15:45 ET DCA whose mirror died (NVDA 8/11) is
  // still trusted at the next morning's catch-up pass. 0 = off.
  trustFreshLotMs = 0,
} = {}) {
  const mirroredOkIds = new Set(
    (ring || [])
      .filter((r) => String(r?.trade_id || "").startsWith("inv-")
        && ringLooksLikeRealPlace(r))
      .map((r) => `${String(r.side || "").toLowerCase()}|${String(r.trade_id)}`),
  );

  // Pre-filter by ticker, then last-signal-wins per position.
  const tickerLots = (lots || []).filter((lot) => {
    const ticker = String(lot.ticker || "").toUpperCase();
    return ticker && (!tickerFilter || tickerFilter.has(ticker));
  });

  const { latest, superseded } = selectLatestSignalLots(tickerLots);
  const skippedGates = [...superseded];
  const planned = [];

  for (const lot of latest) {
    const ticker = String(lot.ticker || "").toUpperCase();
    const tradeId = tradeIdForLot(lot);
    const kind = kindForLot(lot);

    // Already mirrored for this action → nothing to catch up. Older lots
    // were already marked superseded.
    if (lotAlreadyMirrored(mirroredOkIds, tradeId, lot.action)) continue;

    const freshness = isCatchupSignalFresh(lot.ts, nowMs, {
      force,
      ttlRthMs,
      isRthDay,
    });
    if (!freshness.fresh) {
      skippedGates.push({
        ticker,
        kind,
        shares: Number(lot.shares) || 0,
        price: Number(lot.price) || null,
        position_id: lot.position_id,
        lot_id: lot.id,
        lot_ts: lot.ts,
        trade_id: tradeId,
        skip_reason: freshness.reason || "signal_expired_rth",
        detail: {
          note: "Signal expired — 4h of NY RTH from lot ts (ETH/overnight excluded)",
          rth_elapsed_ms: freshness.rth_elapsed_ms,
          ttl_ms: freshness.ttl_ms,
        },
      });
      continue;
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
        trade_id: tradeId,
        skip_reason: "rth_closed_buy",
        detail: { note: "Auto buy/DCA catch-up waits for regular hours (Webull fractionals)" },
      });
      continue;
    }

    const scoreRow = scores[ticker] || {};
    const livePrice = livePrices[ticker] ?? null;
    const lotRthAgeMs = Number.isFinite(Number(freshness.rth_elapsed_ms))
      ? Number(freshness.rth_elapsed_ms)
      : Infinity;
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
      trustModelExecution: isBuy && trustFreshLotMs > 0 && lotRthAgeMs >= 0 && lotRthAgeMs <= trustFreshLotMs,
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
      rth_elapsed_ms: freshness.rth_elapsed_ms,
      ttl_ms: freshness.ttl_ms,
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

  return {
    planned,
    skipped_gates: skippedGates,
    mirrored_ok_count: mirroredOkIds.size,
  };
}

/**
 * Load state + plan + optionally forward to the bridge.
 *
 * @param {object} env
 * @param {object} [opts]
 */
export async function runInvestorCatchup(env, opts = {}) {
  const dryRun = opts.dry_run !== false;
  // Lookback only finds candidate lots; freshness is the 4h RTH TTL.
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
  const ttlRthMs = Number.isFinite(Number(opts.ttl_rth_ms)) && Number(opts.ttl_rth_ms) > 0
    ? Number(opts.ttl_rth_ms)
    : CATCHUP_SIGNAL_TTL_RTH_MS;
  const trustFreshLotMs = Number.isFinite(Number(opts.trust_fresh_lot_ms)) && Number(opts.trust_fresh_lot_ms) > 0
    ? Number(opts.trust_fresh_lot_ms)
    : 0;

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
    nowMs: Date.now(),
    ttlRthMs,
    trustFreshLotMs,
  });

  let planned = prioritizeCatchupOps(plannedFull.planned);
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
        rth_elapsed_ms: op.rth_elapsed_ms,
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
    ttl_rth_ms: ttlRthMs,
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
