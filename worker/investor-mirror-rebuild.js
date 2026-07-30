/**
 * Roth / broker mirror rebuild after orphan cleanup.
 *
 * Unlike catchup-investor (replays unmatched lots with a 4h RTH TTL),
 * this scores OPEN investor_positions vs model avg_entry + live thesis
 * and plans one DCA-sized buy per eligible ticker.
 *
 *   POST /timed/admin/broker-bridge/rebuild-mirror
 *     { dry_run?: true, tickers?: [], max_ops?, force?,
 *       min_vs_entry_pct?, max_vs_entry_pct?, min_score?,
 *       max_slice_usd?, broker_account_id? }
 */

import { forwardInvestorMirror } from "./broker-bridge-client.js";
import {
  evaluateMirrorRebuildGate,
  rebuildSliceShares,
  resolveCatchupLivePrice,
  REBUILD_MIN_VS_ENTRY_PCT,
  REBUILD_MAX_VS_ENTRY_PCT,
  REBUILD_MIN_SCORE,
  REBUILD_DEFAULT_SLICE_USD,
  REBUILD_BROKER_DUST,
} from "./investor-catchup-gates.js";

async function kvJson(env, key) {
  try {
    const raw = await env?.KV_TIMED?.get?.(key);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
}

function scoreRowFor(scores, ticker) {
  if (!scores || typeof scores !== "object") return {};
  const t = String(ticker || "").toUpperCase();
  if (scores[t] && typeof scores[t] === "object") return scores[t];
  // Some writers nest under byTicker / tickers.
  const nested = scores.byTicker || scores.tickers || scores.scores;
  if (nested && typeof nested === "object" && nested[t]) return nested[t];
  return {};
}

/**
 * Plan rebuild ops from already-loaded positions + prices + scores + broker qty.
 * Pure — no I/O.
 *
 * @param {object} args
 * @returns {{ planned: object[], skipped: object[] }}
 */
export function planMirrorRebuildOps({
  positions = [],
  livePrices = {},
  scores = {},
  brokerQtyByTicker = {},
  tickerFilter = null,
  force = false,
  minVsEntryPct = REBUILD_MIN_VS_ENTRY_PCT,
  maxVsEntryPct = REBUILD_MAX_VS_ENTRY_PCT,
  minScore = REBUILD_MIN_SCORE,
  defaultSliceUsd = REBUILD_DEFAULT_SLICE_USD,
  maxSliceUsd = null,
  brokerDust = REBUILD_BROKER_DUST,
} = {}) {
  const planned = [];
  const skipped = [];

  for (const pos of positions || []) {
    const ticker = String(pos.ticker || "").toUpperCase();
    if (!ticker) continue;
    if (tickerFilter && !tickerFilter.has(ticker)) continue;

    const status = String(pos.status || "").toUpperCase();
    if (status && status !== "OPEN") {
      skipped.push({
        ticker,
        position_id: pos.id || pos.position_id,
        skip_reason: "not_open",
        detail: { status },
      });
      continue;
    }

    const scoreRow = scoreRowFor(scores, ticker);
    const stage = scoreRow.stage || scoreRow.investor_stage || pos.investor_stage || null;
    const score = scoreRow.score ?? scoreRow.investor_score ?? null;
    const livePrice = livePrices[ticker] ?? null;
    const avgEntry = Number(pos.avg_entry) || Number(pos.avgEntry) || null;
    const brokerQty = Number(brokerQtyByTicker[ticker]) || 0;

    const gate = evaluateMirrorRebuildGate({
      avgEntry,
      livePrice,
      stage,
      score,
      accumZone: scoreRow.accumZone || scoreRow.accum_zone || null,
      brokerQty,
      minVsEntryPct,
      maxVsEntryPct,
      minScore,
      brokerDust,
      force,
    });

    const dcaAmount = Number(pos.dca_amount) || Number(pos.dcaAmount) || 0;
    const shares = rebuildSliceShares({
      dcaAmountUsd: dcaAmount,
      livePrice,
      defaultSliceUsd,
      maxSliceUsd,
    });
    const notional = (Number.isFinite(livePrice) && livePrice > 0)
      ? Math.round(shares * livePrice * 100) / 100
      : null;

    const op = {
      ticker,
      kind: "dca",
      shares,
      price: livePrice,
      avg_entry: avgEntry,
      vs_entry_pct: gate.vs_entry_pct,
      notional_usd: notional,
      dca_amount_usd: dcaAmount > 0 ? dcaAmount : defaultSliceUsd,
      position_id: pos.id || pos.position_id,
      trade_id: pos.id || pos.position_id,
      reason: "mirror_rebuild_slice",
      stage: stage || null,
      score: score ?? null,
      broker_qty: brokerQty,
      gate_reason: gate.reason,
    };

    if (!gate.allow) {
      skipped.push({
        ...op,
        skip_reason: gate.reason,
        detail: gate.detail || null,
      });
      continue;
    }
    if (!(shares > 0)) {
      skipped.push({
        ...op,
        skip_reason: "qty_zero",
        detail: { dcaAmount, livePrice },
      });
      continue;
    }
    planned.push(op);
  }

  // Prefer deepest discount within band (most under avg_entry) first.
  planned.sort((a, b) => (Number(a.vs_entry_pct) || 0) - (Number(b.vs_entry_pct) || 0));

  return { planned, skipped };
}

/**
 * Load OPEN positions, live prices/scores, Roth holdings, plan (+ optional forward).
 */
export async function runMirrorRebuild(env, opts = {}) {
  const dryRun = opts.dry_run !== false;
  const force = opts.force === true;
  const minVsEntryPct = Number.isFinite(Number(opts.min_vs_entry_pct))
    ? Number(opts.min_vs_entry_pct) : REBUILD_MIN_VS_ENTRY_PCT;
  const maxVsEntryPct = Number.isFinite(Number(opts.max_vs_entry_pct))
    ? Number(opts.max_vs_entry_pct) : REBUILD_MAX_VS_ENTRY_PCT;
  const minScore = Number.isFinite(Number(opts.min_score))
    ? Number(opts.min_score) : REBUILD_MIN_SCORE;
  const defaultSliceUsd = Number.isFinite(Number(opts.default_slice_usd))
    ? Number(opts.default_slice_usd) : REBUILD_DEFAULT_SLICE_USD;
  const maxSliceUsd = Number.isFinite(Number(opts.max_slice_usd)) && Number(opts.max_slice_usd) > 0
    ? Number(opts.max_slice_usd) : null;
  const tickerFilter = Array.isArray(opts.tickers)
    ? new Set(opts.tickers.map((t) => String(t || "").toUpperCase()).filter(Boolean))
    : null;
  const maxOps = Number.isFinite(Number(opts.max_ops)) && Number(opts.max_ops) > 0
    ? Math.floor(Number(opts.max_ops))
    : null;
  const source = String(opts.source || "mirror_rebuild").slice(0, 64);
  const brokerAccountId = String(opts.broker_account_id || "").trim() || null;

  const { results: positions } = await env.DB.prepare(
    `SELECT id, ticker, status, total_shares, avg_entry, investor_stage,
            dca_amount, dca_enabled, thesis
     FROM investor_positions
     WHERE status = 'OPEN'
     ORDER BY ticker`,
  ).all().catch(() => ({ results: [] }));

  const scores = (await kvJson(env, "timed:investor:scores")) || {};
  const pricesBlob = (await kvJson(env, "timed:prices")) || {};
  const pricesMap = pricesBlob.prices || pricesBlob || {};

  const livePrices = {};
  const brokerQtyByTicker = {};

  // Broker holdings for the Roth (or requested) account — skip if already held.
  try {
    const bridgeUrl = env?.BROKER_BRIDGE_URL || "https://bridge.internal";
    const svc = env?.BROKER_BRIDGE;
    const opKey = env?.BROKER_BRIDGE_OPERATOR_KEY;
    const headers = opKey ? { Authorization: `Bearer ${opKey}` } : {};
    const url = `${String(bridgeUrl).replace(/\/$/, "")}/bridge/portfolio`;
    const init = { method: "GET", headers };
    const resp = svc && typeof svc.fetch === "function"
      ? await svc.fetch(new Request(url, init))
      : await fetch(url, init);
    const body = await resp.json().catch(() => null);
    const users = Array.isArray(body?.users) ? body.users : [];
    for (const u of users) {
      const uid = String(u?.user_id || "");
      const acct = String(u?.account_id || u?.webull_account_id || "");
      const isRoth = uid.includes("roth") || (brokerAccountId && acct === brokerAccountId);
      if (!isRoth && brokerAccountId && acct !== brokerAccountId) continue;
      if (!isRoth && !brokerAccountId) {
        // Default: prefer roth-ira user; fall through if none matched yet.
        if (!uid.includes("roth")) continue;
      }
      const rows = u?.positions?.positions || u?.positions?.response || [];
      if (!Array.isArray(rows)) continue;
      for (const p of rows) {
        const sym = String(p?.symbol || p?.ticker || "").toUpperCase();
        const qty = Number(p?.quantity || p?.qty || 0);
        if (!sym || !(qty > 0)) continue;
        brokerQtyByTicker[sym] = (brokerQtyByTicker[sym] || 0) + qty;
      }
      if (Object.keys(brokerQtyByTicker).length) break;
    }
  } catch (_) {
    // Fail open on portfolio read — gate still applies avg_entry/thesis;
    // already_mirrored just won't fire.
  }

  // Enrich scores from timed:latest when the scores blob has score:null
  // stubs (outside-universe reconcile). Prefer live investor_score.
  const scoresEnriched = { ...(scores || {}) };
  for (const pos of positions || []) {
    const t = String(pos.ticker || "").toUpperCase();
    if (!t || (tickerFilter && !tickerFilter.has(t))) continue;
    const latest = await kvJson(env, `timed:latest:${t}`);
    livePrices[t] = resolveCatchupLivePrice(pricesMap[t], latest);
    const row = scoreRowFor(scoresEnriched, t);
    const blobScore = row?.score ?? row?.investor_score;
    const latestScore = Number(latest?.investor_score);
    if ((blobScore == null || !Number.isFinite(Number(blobScore)))
        && Number.isFinite(latestScore)) {
      scoresEnriched[t] = {
        ...row,
        score: latestScore,
        stage: row?.stage || latest?.investor_stage || pos.investor_stage || null,
        _score_from_latest: true,
      };
    } else if (!row?.stage && (latest?.investor_stage || pos.investor_stage)) {
      scoresEnriched[t] = {
        ...row,
        stage: latest?.investor_stage || pos.investor_stage,
      };
    }
  }

  const plannedFull = planMirrorRebuildOps({
    positions: positions || [],
    livePrices,
    scores: scoresEnriched,
    brokerQtyByTicker,
    tickerFilter,
    force,
    minVsEntryPct,
    maxVsEntryPct,
    minScore,
    defaultSliceUsd,
    maxSliceUsd,
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
        kind: "dca",
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
        shares: op.shares,
        notional_usd: op.notional_usd,
        vs_entry_pct: op.vs_entry_pct,
        ok: !!r?.ok,
        skip: r?.skip || null,
        reject: r?.bridge_reject_reason || r?.error || null,
        scaled_qty: r?.bridge_scaled_qty ?? null,
        stage: op.stage,
        score: op.score,
      });
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    force,
    min_vs_entry_pct: minVsEntryPct,
    max_vs_entry_pct: maxVsEntryPct,
    min_score: minScore,
    default_slice_usd: defaultSliceUsd,
    max_slice_usd: maxSliceUsd,
    source,
    open_positions: (positions || []).length,
    planned: planned.length,
    planned_ops: planned,
    skipped: plannedFull.skipped,
    skipped_count: plannedFull.skipped.length,
    truncated_ops: truncated,
    broker_qty_by_ticker: brokerQtyByTicker,
    results,
  };
}
