// worker/review/trade-review-context.js
//
// Assemble everything the reviewer needs to grade ONE leg, from D1.
//
// Design rule: the reviewer is independent. It receives what the ENGINE
// claimed (setup, gates, stop, target, CIO verdict) clearly labelled as a
// claim, and separately receives what the TAPE did, computed here. It is
// asked to grade the claim against the tape — never to take the claim as
// evidence for itself.

import { extractLegs } from "./trade-review-legs.js";
import { computeCapture, computeEntryGeometry } from "./trade-review-capture.js";

const MS_PER_DAY = 86_400_000;

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJson(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/** Candles for [fromTs, toTs] at one timeframe, ascending. */
export async function fetchCandleRange(env, ticker, tf, fromTs, toTs, limit = 800) {
  const db = env?.DB;
  const sym = String(ticker || "").toUpperCase();
  if (!db || !sym) return [];
  try {
    const { results } = await db.prepare(
      `SELECT ts, o, h, l, c, v
         FROM ticker_candles
        WHERE ticker = ?1 AND tf = ?2 AND ts >= ?3 AND ts <= ?4
        ORDER BY ts ASC
        LIMIT ?5`
    ).bind(sym, String(tf), Number(fromTs), Number(toTs), Math.min(2000, Number(limit) || 800)).all();
    return (results || []).map((r) => ({
      ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c), v: Number(r.v),
    })).filter((b) => Number.isFinite(b.ts) && Number.isFinite(b.h) && Number.isFinite(b.l));
  } catch (e) {
    console.warn("[TRADE_REVIEW] candle fetch failed:", String(e?.message || e).slice(0, 140));
    return [];
  }
}

/**
 * Pick a timeframe that gives the reviewer enough resolution without
 * blowing the row budget: intraday for short holds, daily for long ones.
 */
export function pickTimeframe(spanMs) {
  const days = (Number(spanMs) || 0) / MS_PER_DAY;
  if (days <= 3) return "10";
  if (days <= 14) return "60";
  return "D";
}

export async function loadTrade(env, tradeId) {
  const db = env?.DB;
  if (!db || !tradeId) return null;
  const cols = `trade_id, ticker, direction, status, entry_ts, entry_price, exit_ts, exit_price,
                exit_reason, trim_ts, trim_price, trimmed_pct, pnl, pnl_pct, rank, rr,
                setup_name, setup_grade, risk_budget, shares, notional, entry_path,
                max_favorable_excursion, max_adverse_excursion, rank_trace_json,
                entry_signals_json, sector, run_id`;
  const live = await db.prepare(`SELECT ${cols} FROM trades WHERE trade_id = ?1`)
    .bind(String(tradeId)).first().catch(() => null);
  if (live) return { ...live, _source: "trades" };
  // Archived monthly books (live-short-term-YYYY-MM) keep their own copy.
  const archived = await db.prepare(
    `SELECT ${cols} FROM backtest_run_trades WHERE trade_id = ?1 ORDER BY entry_ts DESC LIMIT 1`
  ).bind(String(tradeId)).first().catch(() => null);
  return archived ? { ...archived, _source: "backtest_run_trades" } : null;
}

async function loadEvents(env, tradeId) {
  const db = env?.DB;
  if (!db) return [];
  try {
    const { results } = await db.prepare(
      `SELECT event_id, ts, type, price, qty_pct_delta, qty_pct_total, pnl_realized, reason
         FROM trade_events WHERE trade_id = ?1 ORDER BY ts ASC`
    ).bind(String(tradeId)).all();
    return results || [];
  } catch { return []; }
}

async function loadSignals(env, tradeId) {
  const db = env?.DB;
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT signal_snapshot_json, exit_snapshot_json, tf_stack_json, entry_path,
              max_favorable_excursion, max_adverse_excursion, entry_quality_score, market_state
         FROM direction_accuracy WHERE trade_id = ?1 ORDER BY COALESCE(ts,0) DESC LIMIT 1`
    ).bind(String(tradeId)).first();
    if (row) return row;
    const arch = await db.prepare(
      `SELECT signal_snapshot_json, exit_snapshot_json, tf_stack_json, entry_path,
              max_favorable_excursion, max_adverse_excursion, entry_quality_score, market_state
         FROM backtest_run_direction_accuracy WHERE trade_id = ?1 LIMIT 1`
    ).bind(String(tradeId)).first();
    return arch || null;
  } catch { return null; }
}

/**
 * Levels are only trustworthy if they sit on the correct side of the entry:
 * a LONG's stop must be below the fill and its target above it. A stop
 * quoted above a long's entry means we attributed some other position's
 * levels to this trade — better to report "unknown" than to hand the
 * reviewer a fabricated stop and have it grade the risk on that basis.
 */
export function levelsAreCoherent({ direction, entryPrice, stopLoss, takeProfit }) {
  const ep = num(entryPrice);
  if (ep == null) return false;
  const isLong = String(direction || "LONG").toUpperCase() !== "SHORT";
  const sl = num(stopLoss);
  const tp = num(takeProfit);
  if (sl == null && tp == null) return false;
  if (sl != null && (isLong ? sl >= ep : sl <= ep)) return false;
  if (tp != null && (isLong ? tp <= ep : tp >= ep)) return false;
  return true;
}

async function loadPositionLevels(env, tradeId, ticker, trade) {
  const db = env?.DB;
  if (!db) return null;
  const check = (levels, source) => {
    if (!levels) return null;
    const coherent = levelsAreCoherent({
      direction: trade?.direction,
      entryPrice: trade?.entry_price,
      stopLoss: levels.stop_loss,
      takeProfit: levels.take_profit,
    });
    return coherent ? { ...levels, source } : null;
  };

  try {
    // Preferred: the SL/TP stamped on this trade's own entry decision.
    const dr = await db.prepare(
      `SELECT inputs_json FROM decision_records
        WHERE trade_id = ?1 AND event_type = 'ENTRY' ORDER BY ts ASC LIMIT 1`
    ).bind(String(tradeId)).first().catch(() => null);
    const inputs = parseJson(dr?.inputs_json);
    const fromDr = check({
      stop_loss: num(inputs?.sl ?? inputs?.stop_loss ?? inputs?.stopLoss),
      take_profit: num(inputs?.tp ?? inputs?.take_profit ?? inputs?.takeProfit),
    }, "decision_record");
    if (fromDr) return fromDr;

    // Fallback: the live position row — but ONLY while the trade is still
    // open, because `positions` is keyed by ticker and a closed trade's
    // ticker may since have been re-entered with entirely different levels.
    const stillOpen = ["OPEN", "TP_HIT_TRIM"].includes(String(trade?.status || "").toUpperCase());
    if (stillOpen) {
      const pos = await db.prepare(
        `SELECT stop_loss, take_profit FROM positions WHERE ticker = ?1 ORDER BY updated_at DESC LIMIT 1`
      ).bind(String(ticker || "").toUpperCase()).first().catch(() => null);
      const fromPos = check({ stop_loss: num(pos?.stop_loss), take_profit: num(pos?.take_profit) }, "positions");
      if (fromPos) return fromPos;
    }
  } catch { /* levels are optional */ }
  return null;
}

async function loadCioDecision(env, tradeId) {
  const db = env?.DB;
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT decision, confidence, edge_score, reasoning, risk_flags, model
         FROM ai_cio_decisions WHERE trade_id = ?1 ORDER BY created_at DESC LIMIT 1`
    ).bind(String(tradeId)).first();
    return row || null;
  } catch { return null; }
}

/**
 * Trim a signal snapshot down to the per-timeframe read the reviewer needs.
 * Full snapshots are several KB of nested objects; this keeps the prompt
 * affordable while preserving the structural picture.
 */
export function condenseSnapshot(raw) {
  const snap = parseJson(raw);
  if (!snap?.tf || typeof snap.tf !== "object") return null;
  const out = {};
  for (const [tfKey, v] of Object.entries(snap.tf)) {
    if (!v || typeof v !== "object") continue;
    const sig = v.signals || {};
    out[tfKey] = {
      bias: v.bias ?? null,
      supertrend: sig.supertrend ?? null,
      st_slope: sig.st_slope ?? null,
      ema_cross: sig.ema_cross ?? null,
      ema_structure: sig.ema_structure ?? null,
      rsi: sig.rsi ?? null,
    };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Build the full review context for one leg.
 *
 * @returns {{ok:boolean, context?:object, capture?:object, error?:string}}
 */
export async function buildLegContext(env, { tradeId, legKind, legSeq = 0, lookaheadDays = 10 } = {}) {
  const trade = await loadTrade(env, tradeId);
  if (!trade) return { ok: false, error: "trade_not_found" };

  const events = await loadEvents(env, tradeId);
  const legs = extractLegs(trade, events);
  const leg = legs.find((l) => l.leg_kind === legKind && l.leg_seq === (Number(legSeq) || 0));
  if (!leg) return { ok: false, error: "leg_not_found" };

  const entryTs = num(trade.entry_ts) ?? leg.ts;
  const closeTs = num(trade.exit_ts) ?? Date.now();
  const spanMs = Math.max(0, closeTs - entryTs);
  const tf = pickTimeframe(spanMs);
  // Pull a little history before the entry so the reviewer can judge the
  // location of the fill, and lookahead past the exit for the move overlay.
  const fromTs = entryTs - Math.max(2 * MS_PER_DAY, spanMs * 0.5);
  const toTs = closeTs + lookaheadDays * MS_PER_DAY;
  const bars = await fetchCandleRange(env, trade.ticker, tf, fromTs, toTs);

  const capture = computeCapture({ trade, bars, lookaheadDays });
  const preEntry = bars.filter((b) => b.ts <= entryTs);
  const entryBar = preEntry.length ? preEntry[preEntry.length - 1] : null;

  const levels = await loadPositionLevels(env, tradeId, trade.ticker, trade);
  const geometry = computeEntryGeometry({
    entryPrice: trade.entry_price,
    stopLoss: levels?.stop_loss,
    takeProfit: levels?.take_profit,
    direction: trade.direction,
    entryBar,
  });

  const signals = await loadSignals(env, tradeId);
  const cio = await loadCioDecision(env, tradeId);

  // Legs already executed before this one — the reviewer must see the story
  // so far, because a trim is only gradeable in the context of its entry.
  const priorLegs = legs
    .filter((l) => l.ts < leg.ts || (l.ts === leg.ts && l.leg_kind !== leg.leg_kind))
    .map((l) => ({ kind: l.leg_kind, seq: l.leg_seq, ts: l.ts, price: l.price, qty_pct: l.qty_pct, reason: l.reason }));

  const context = {
    trade: {
      trade_id: trade.trade_id,
      ticker: trade.ticker,
      direction: trade.direction,
      status: trade.status,
      sector: trade.sector || null,
      shares: num(trade.shares),
      notional: num(trade.notional),
      pnl_usd: num(trade.pnl),
      pnl_pct: num(trade.pnl_pct),
      source: trade._source,
    },
    // Everything under `engine_claim` is what the model asserted at the
    // time. It is the thing being graded, not evidence.
    engine_claim: {
      setup_name: trade.setup_name || null,
      setup_grade: trade.setup_grade || null,
      entry_path: trade.entry_path || signals?.entry_path || null,
      rank: num(trade.rank),
      rr: num(trade.rr),
      risk_budget: num(trade.risk_budget),
      exit_reason: trade.exit_reason || null,
      market_state: signals?.market_state || null,
      entry_quality_score: num(signals?.entry_quality_score),
      stop_loss: geometry?.stop_loss ?? null,
      take_profit: geometry?.take_profit ?? null,
      levels_source: levels?.source || null,
      cio_decision: cio ? {
        decision: cio.decision,
        confidence: num(cio.confidence),
        reasoning: String(cio.reasoning || "").slice(0, 600),
        risk_flags: parseJson(cio.risk_flags),
      } : null,
    },
    leg: {
      kind: leg.leg_kind,
      seq: leg.leg_seq,
      ts: leg.ts,
      price: leg.price,
      qty_pct: leg.qty_pct,
      reason: leg.reason,
      is_scale_in: !!leg.is_scale_in,
      // A synthesized leg came from summary columns, not an execution
      // receipt — the reviewer should not over-read its timestamp.
      from_receipt: !leg.synthesized,
    },
    prior_legs: priorLegs,
    all_legs: legs.map((l) => ({ kind: l.leg_kind, seq: l.leg_seq, ts: l.ts, price: l.price })),
    tape: {
      timeframe: tf,
      bar_count: bars.length,
      entry_bar: entryBar,
      geometry,
      capture,
    },
    signals_at_entry: condenseSnapshot(signals?.signal_snapshot_json),
    signals_at_exit: condenseSnapshot(signals?.exit_snapshot_json),
  };

  return { ok: true, context, capture, legs, trade, bars };
}

function tradeIsClosed(trade) {
  if (!trade) return false;
  if (num(trade.exit_ts) == null) return false;
  return !["OPEN", "TP_HIT_TRIM"].includes(String(trade.status || "").toUpperCase());
}

/**
 * One context object for a closed trade. Reuses the EXIT tape / claim
 * assembly so capture math stays identical, then overlays every leg so
 * the reviewer grades the whole story.
 */
export async function buildClosedTradeContext(env, { tradeId, lookaheadDays = 10 } = {}) {
  const trade = await loadTrade(env, tradeId);
  if (!trade) return { ok: false, error: "trade_not_found" };
  if (!tradeIsClosed(trade)) return { ok: false, error: "trade_still_open" };

  const events = await loadEvents(env, tradeId);
  const legs = extractLegs(trade, events);
  const exit = [...legs].reverse().find((l) => l.leg_kind === "EXIT") || legs.find((l) => l.leg_kind === "EXIT");
  if (!exit) return { ok: false, error: "exit_leg_not_found" };

  const built = await buildLegContext(env, {
    tradeId,
    legKind: "EXIT",
    legSeq: exit.leg_seq,
    lookaheadDays,
  });
  if (!built.ok) return built;

  built.context.leg = {
    ...built.context.leg,
    kind: "TRADE",
    seq: 0,
  };
  built.context.all_legs_full = legs.map((l) => ({
    kind: l.leg_kind,
    seq: l.leg_seq,
    ts: l.ts,
    price: l.price,
    qty_pct: l.qty_pct,
    reason: l.reason,
    from_receipt: !l.synthesized,
  }));
  return built;
}
