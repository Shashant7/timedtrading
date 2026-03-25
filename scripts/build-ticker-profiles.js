#!/usr/bin/env node
/**
 * build-ticker-profiles.js — Phases 4-5 of Ticker Learning System
 *
 * Reads ticker_moves + ticker_move_signals from D1, computes:
 *   - Signal precision per ticker (how often do origin signals predict moves?)
 *   - Per-ticker entry/exit parameters (optimal RSI zones, pullback expectations, etc.)
 *   - Ticker personality profiles stored as JSON in ticker_profiles
 *
 * Usage:
 *   node scripts/build-ticker-profiles.js [--ticker CAT]
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const TICKER_FILTER = getArg("ticker", null);
const WORKER_DIR = path.join(__dirname, "../worker");

function queryD1(sql, retries = 3) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: "utf-8" });
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
      if (parsed?.results) return parsed.results;
      return [];
    } catch (e) {
      if (attempt < retries) { execSync("sleep 2"); continue; }
      return [];
    }
  }
  return [];
}

function execD1(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  try {
    execSync(cmd, { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" });
    return true;
  } catch { return false; }
}

function rnd(v, dp = 2) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function pct(n, d) { return d > 0 ? rnd(n / d * 100, 1) : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function parseJsonMaybe(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}
function ichimokuDirectionAligned(ich, dir) {
  if (!ich || typeof ich !== 'object') return false;
  const tkBull = ich.tk === 1 || ich.tk === true;
  const cloudBull = ich.cb === 1 || ich.cb === true;
  if (dir === 'UP') return ich.pvc === 'above' && tkBull && cloudBull;
  return ich.pvc === 'below' && !tkBull && !cloudBull;
}


const ARCHETYPE_PLAYBOOK = {
  trend_continuation_runner: {
    entry_timing: 'enter_earlier_on_continuation',
    entry_engine: 'tt_core',
    management_engine: 'tt_core',
    guard_bundle: 'trend_confirmed',
    sl_tp_style: 'wider_runner',
    trim_run_bias: 'let_runner_work',
    exit_style: 'smart_exit_bias',
  },
  pullback_reclaim: {
    entry_timing: 'wait_for_reclaim_confirmation',
    entry_engine: 'tt_core',
    management_engine: 'tt_core',
    guard_bundle: 'reclaim_confirmation',
    sl_tp_style: 'standard_confirmed',
    trim_run_bias: 'balanced',
    exit_style: 'smart_exit_bias',
  },
  fast_impulse_fragile: {
    entry_timing: 'allow_but_reduce_chase',
    entry_engine: 'tt_core',
    management_engine: 'tt_core',
    guard_bundle: 'fragile_impulse',
    sl_tp_style: 'tight_defensive',
    trim_run_bias: 'quick_trim',
    exit_style: 'tp_full_bias',
  },
  exhaustion_reversal: {
    entry_timing: 'require_stronger_reversal_evidence',
    entry_engine: 'tt_core',
    management_engine: 'tt_core',
    guard_bundle: 'reversal_confirmation',
    sl_tp_style: 'tight_reversal',
    trim_run_bias: 'take_quicker_profits',
    exit_style: 'tp_full_bias',
  },
  liquidity_sweep_reclaim: {
    entry_timing: 'reward_sweep_reclaim',
    entry_engine: 'tt_core',
    management_engine: 'tt_core',
    guard_bundle: 'sweep_reclaim',
    sl_tp_style: 'adaptive_discount_premium',
    trim_run_bias: 'balanced_runner',
    exit_style: 'smart_exit_bias',
  },
  orb_expansion: {
    entry_timing: 'favor_opening_range_break',
    entry_engine: 'tt_core',
    management_engine: 'tt_core',
    guard_bundle: 'orb_defensive',
    sl_tp_style: 'orb_anchor',
    trim_run_bias: 'front_load_trims',
    exit_style: 'tp_full_bias',
  },
};

function getPhaseTf(moveMeta, phase, tf) {
  return moveMeta?.phases?.[phase]?.tf?.[tf] || null;
}

function zoneSupportsDirection(zone, dir) {
  if (!zone) return false;
  const z = String(zone).toLowerCase();
  if (dir === 'UP') return z.includes('discount');
  return z.includes('premium');
}

function supportsDirection(snapshot, dir) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const emaStruct = Number(snapshot?.ema?.structure);
  const stackBull = snapshot?.ema?.stack_bull === 1;
  const stDir = Number(snapshot?.supertrend?.dir);
  const ich = snapshot?.ichimoku || null;
  const bull = (Number.isFinite(emaStruct) && emaStruct > 0.2 && stackBull && stDir === -1)
    || (ich?.pvc === 'above' && (ich?.cb === 1 || ich?.cb === true));
  const bear = (Number.isFinite(emaStruct) && emaStruct < -0.2 && !stackBull && stDir === 1)
    || (ich?.pvc === 'below' && !(ich?.cb === 1 || ich?.cb === true));
  return dir === 'UP' ? bull : bear;
}

function classifyMoveArchetype(move) {
  const meta = move?.move_meta || {};
  const quality = meta?.quality || {};
  const context = meta?.context || {};
  const dir = move?.direction || meta?.summary?.direction || 'UP';
  const originD = getPhaseTf(meta, 'origin', 'D');
  const confirmation30 = getPhaseTf(meta, 'confirmation', '30') || getPhaseTf(meta, 'confirmation', '10');
  const confirmation1H = getPhaseTf(meta, 'confirmation', '1H');
  const expansion30 = getPhaseTf(meta, 'expansion', '30') || getPhaseTf(meta, 'expansion', '10');
  const maturityD = getPhaseTf(meta, 'maturity', 'D');
  const terminationD = getPhaseTf(meta, 'termination', 'D');
  const originOrb = getPhaseTf(meta, 'origin', '30')?.orb || getPhaseTf(meta, 'origin', '10')?.orb || null;

  const orbBias = Number(originOrb?.bias || 0);
  const orbDirectional = (dir === 'UP' && orbBias > 0) || (dir === 'DOWN' && orbBias < 0);
  if (orbDirectional && ['ELEVATED', 'SURGING'].includes(String(context?.rvol_bucket || '')) && Number(quality?.move_atr || 0) >= 3) {
    return 'orb_expansion';
  }

  const liqSupport = dir === 'UP'
    ? Number(confirmation30?.liquidity?.sellside_count || 0) > 0
    : Number(confirmation30?.liquidity?.buyside_count || 0) > 0;
  if (zoneSupportsDirection(originD?.pdz?.zone, dir) && liqSupport && supportsDirection(confirmation30 || confirmation1H, dir)) {
    return 'liquidity_sweep_reclaim';
  }

  const opposingTd = dir === 'UP'
    ? (originD?.td?.td9_bearish || originD?.td?.td13_bearish)
    : (originD?.td?.td9_bullish || originD?.td?.td13_bullish);
  const matureZone = String(maturityD?.phase?.zone || terminationD?.phase?.zone || '').toUpperCase();
  if (opposingTd && (matureZone === 'HIGH' || matureZone === 'EXTREME')) {
    return 'exhaustion_reversal';
  }

  if (Number(quality?.clean_expansion_score || 0) >= 55
      && Number(quality?.mfe_mae_ratio || 0) >= 2
      && String(context?.regime || '').includes('TRENDING')
      && supportsDirection(expansion30 || confirmation1H || maturityD, dir)) {
    return 'trend_continuation_runner';
  }

  if (Number(quality?.max_pullback_pct || 0) >= 4
      && Number(quality?.mfe_mae_ratio || 0) >= 1.4
      && supportsDirection(confirmation30 || confirmation1H, dir)) {
    return 'pullback_reclaim';
  }

  if (Number(quality?.mfe_pct || 0) >= 8
      && (Number(quality?.mfe_mae_ratio || 0) < 1.35 || Number(quality?.clean_expansion_score || 0) < 40)) {
    return 'fast_impulse_fragile';
  }

  return supportsDirection(expansion30 || maturityD, dir) ? 'trend_continuation_runner' : 'fast_impulse_fragile';
}

function summarizeArchetypes(subset) {
  const counts = {};
  for (const move of subset) {
    const archetype = move?.move_archetype || classifyMoveArchetype(move);
    counts[archetype] = (counts[archetype] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const dominant = entries[0]?.[0] || null;
  return {
    counts,
    dominant,
    recommendation: dominant ? { archetype: dominant, ...(ARCHETYPE_PLAYBOOK[dominant] || {}) } : null,
  };
}

function buildRuntimePolicy(moves) {
  const buildRules = (subset, direction) => {
    const groups = new Map();
    for (const move of subset) {
      const ctx = move?.move_meta?.context || {};
      const keyObj = {
        direction,
        regime: ctx.regime || 'ANY',
        vix_bucket: ctx.vix_bucket || 'ANY',
        rvol_bucket: ctx.rvol_bucket || 'ANY',
        market_state: ctx.market_state || 'ANY',
      };
      const key = JSON.stringify(keyObj);
      const bucket = groups.get(key) || { when: keyObj, moves: [] };
      bucket.moves.push(move);
      groups.set(key, bucket);
    }
    return [...groups.values()]
      .filter(g => g.moves.length >= 2)
      .sort((a, b) => b.moves.length - a.moves.length)
      .slice(0, 4)
      .map(g => {
        const summary = summarizeArchetypes(g.moves);
        return {
          when: g.when,
          sample_count: g.moves.length,
          recommend: summary.recommendation,
        };
      });
  };

  const longMoves = moves.filter(m => m.direction === 'UP');
  const shortMoves = moves.filter(m => m.direction === 'DOWN');
  const longSummary = summarizeArchetypes(longMoves);
  const shortSummary = summarizeArchetypes(shortMoves);
  const longDominant = longSummary.dominant;
  const investorBias = longDominant === 'trend_continuation_runner'
    ? { stance: 'hold_winners', add_on: 'shallow_pullbacks', risk: 'avoid_premature_trim' }
    : longDominant === 'pullback_reclaim'
      ? { stance: 'accumulate_on_reclaim', add_on: 'discount_reclaims_only', risk: 'avoid_chasing' }
      : longDominant === 'liquidity_sweep_reclaim'
        ? { stance: 'accumulate_after_sweep_reclaim', add_on: 'discount_or_equilibrium', risk: 'require_structure_reclaim' }
        : { stance: 'defensive', add_on: 'selective_only', risk: 'trim_strength_and_wait' };
  return {
    version: 1,
    defaults: {
      LONG: longSummary.recommendation,
      SHORT: shortSummary.recommendation,
    },
    context_rules: [
      ...buildRules(longMoves, 'LONG'),
      ...buildRules(shortMoves, 'SHORT'),
    ],
    investor: {
      long_bias_archetype: longDominant,
      ...investorBias,
    },
  };
}

const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }
const B = "\x1b[1m", G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", RST = "\x1b[0m";

// ════════════════════════════════════════════════════════════════════════════

console.log(`\n${B}╔══════════════════════════════════════════════════════════════╗${RST}`);
console.log(`${B}║   Ticker Profile Builder (Phases 4-5)                        ║${RST}`);
console.log(`${B}╚══════════════════════════════════════════════════════════════╝${RST}\n`);

// ── Step 1: Load moves with origin signals ────────────────────────────────

console.log(`${B}═══ Step 1: Loading Moves + Origin Signals ═══${RST}\n`);
console.log(`  [${elapsed()}] Querying D1...`);

const tickerWhere = TICKER_FILTER ? `AND m.ticker='${TICKER_FILTER}'` : "";
const movesRaw = queryD1(
  `SELECT m.ticker, m.direction, m.move_pct, m.move_atr, m.personality,
          m.duration_days, m.max_pullback_pct, m.pullback_count,
          m.rsi_at_start, m.ema_aligned, m.ema_state, m.atr_at_start, m.start_price,
          m.move_json,
          s.rsi_d as origin_rsi, s.st_dir_d as origin_st_dir,
          s.ema_cross_d as origin_ema_cross, s.atr_d as origin_atr,
          s.ema21_d as origin_ema21, s.ema48_d as origin_ema48,
          s.rsi_30m as origin_rsi_30m, s.st_dir_30m as origin_st_dir_30m,
          s.signals_json as origin_signals_json
   FROM ticker_moves m
   LEFT JOIN ticker_move_signals s ON s.move_id = m.id AND s.phase = 'origin'
   WHERE 1=1 ${tickerWhere}
   ORDER BY m.ticker`
);

console.log(`  [${elapsed()}] ${movesRaw.length} moves loaded\n`);

// Group by ticker
const byTicker = {};
for (const r of movesRaw) {
  const sig = parseJsonMaybe(r.origin_signals_json);
  r.move_meta = parseJsonMaybe(r.move_json);
  r.origin_ichimoku_d = sig?.ichimoku_d || null;
  r.origin_ichimoku_30m = sig?.ichimoku_30m || null;
  r.origin_ichimoku_w = sig?.ichimoku_w || null;
  r.origin_rsi_w = Number.isFinite(Number(sig?.rsi_w)) ? Number(sig.rsi_w) : null;
  r.origin_st_dir_w = Number.isFinite(Number(sig?.st_dir_w)) ? Number(sig.st_dir_w) : null;
  r.origin_ema_cross_w = Number.isFinite(Number(sig?.ema_cross_w)) ? Number(sig.ema_cross_w) : null;
  r.move_archetype = classifyMoveArchetype(r);
  r.move_recommendation = ARCHETYPE_PLAYBOOK[r.move_archetype] || null;
  const t = r.ticker;
  (byTicker[t] = byTicker[t] || []).push(r);
}
const tickers = Object.keys(byTicker).sort();
console.log(`  ${tickers.length} tickers\n`);

// ── Step 2: Compute signal precision + entry parameters ───────────────────

console.log(`${B}═══ Step 2: Signal Precision & Entry Parameters ═══${RST}\n`);

const profiles = {};

for (const ticker of tickers) {
  const moves = byTicker[ticker];
  const upMoves = moves.filter(m => m.direction === "UP");
  const dnMoves = moves.filter(m => m.direction === "DOWN");

  // Signal fingerprint analysis at origin:
  // Classify entries by RSI zone and EMA alignment
  function analyzeEntries(subset, dir) {
    if (subset.length < 3) return null;

    const rsiValues = subset.map(m => m.origin_rsi ?? m.rsi_at_start).filter(Number.isFinite);
    const movePcts = subset.map(m => Math.abs(m.move_pct));
    const moveAtrs = subset.map(m => m.move_atr);
    const pullbacks = subset.map(m => m.max_pullback_pct);
    const durations = subset.map(m => m.duration_days);

    // RSI zone distribution at move origin
    const rsiZones = { low: 0, mid: 0, high: 0 };
    const rsiZonePnl = { low: [], mid: [], high: [] };
    for (let i = 0; i < subset.length; i++) {
      const rsi = rsiValues[i] ?? 50;
      const zone = rsi < 40 ? "low" : rsi > 60 ? "high" : "mid";
      rsiZones[zone]++;
      rsiZonePnl[zone].push(movePcts[i]);
    }

    // EMA alignment precision
    const emaAligned = subset.filter(m => m.ema_aligned).length;
    const emaAlignedAvgMove = subset.filter(m => m.ema_aligned).length > 0
      ? rnd(subset.filter(m => m.ema_aligned).reduce((s, m) => s + Math.abs(m.move_pct), 0) / emaAligned)
      : 0;
    const emaOpposedAvgMove = subset.filter(m => !m.ema_aligned).length > 0
      ? rnd(subset.filter(m => !m.ema_aligned).reduce((s, m) => s + Math.abs(m.move_pct), 0) / (subset.length - emaAligned))
      : 0;

    // SuperTrend direction at origin
    const stAligned = dir === "UP"
      ? subset.filter(m => m.origin_st_dir === -1).length
      : subset.filter(m => m.origin_st_dir === 1).length;

    // LTF (30m) signal analysis at origin
    const rsi30mValues = subset.map(m => m.origin_rsi_30m).filter(Number.isFinite);
    const stDir30mTotal = subset.filter(m => m.origin_st_dir_30m != null).length;
    const st30mAligned = dir === "UP"
      ? subset.filter(m => m.origin_st_dir_30m === -1).length
      : subset.filter(m => m.origin_st_dir_30m === 1).length;
    const ltfEnriched = rsi30mValues.length;

    // Weekly HTF context at origin
    const rsiWValues = subset.map(m => m.origin_rsi_w).filter(Number.isFinite);
    const stDirWTotal = subset.filter(m => m.origin_st_dir_w != null).length;
    const stWAligned = dir === "UP"
      ? subset.filter(m => m.origin_st_dir_w === -1).length
      : subset.filter(m => m.origin_st_dir_w === 1).length;

    // Ichimoku alignment across timeframes
    const ichDailyTotal = subset.filter(m => m.origin_ichimoku_d).length;
    const ichDailyAligned = subset.filter(m => ichimokuDirectionAligned(m.origin_ichimoku_d, dir)).length;
    const ich30mTotal = subset.filter(m => m.origin_ichimoku_30m).length;
    const ich30mAligned = subset.filter(m => ichimokuDirectionAligned(m.origin_ichimoku_30m, dir)).length;
    const ichWTotal = subset.filter(m => m.origin_ichimoku_w).length;
    const ichWAligned = subset.filter(m => ichimokuDirectionAligned(m.origin_ichimoku_w, dir)).length;

    // Optimal RSI entry zone: which zone produces the best moves?
    const bestRsiZone = Object.entries(rsiZonePnl)
      .map(([zone, pnls]) => ({ zone, avg: pnls.length > 0 ? rnd(pnls.reduce((s, v) => s + v, 0) / pnls.length) : 0, count: pnls.length }))
      .sort((a, b) => b.avg - a.avg)[0];

    return {
      count: subset.length,
      avg_move_pct: rnd(movePcts.reduce((s, v) => s + v, 0) / movePcts.length),
      median_move_pct: rnd(median(movePcts)),
      avg_move_atr: rnd(moveAtrs.reduce((s, v) => s + v, 0) / moveAtrs.length),
      avg_duration: rnd(durations.reduce((s, v) => s + v, 0) / durations.length, 0),
      avg_pullback_pct: rnd(pullbacks.reduce((s, v) => s + v, 0) / pullbacks.length),
      median_pullback_pct: rnd(median(pullbacks)),
      rsi_at_origin: {
        mean: rnd(rsiValues.reduce((s, v) => s + v, 0) / rsiValues.length, 0),
        median: rnd(median(rsiValues), 0),
        low_zone_pct: pct(rsiZones.low, subset.length),
        mid_zone_pct: pct(rsiZones.mid, subset.length),
        high_zone_pct: pct(rsiZones.high, subset.length),
        best_zone: bestRsiZone.zone,
        best_zone_avg_move: bestRsiZone.avg,
      },
      ema_precision: {
        aligned_pct: pct(emaAligned, subset.length),
        aligned_avg_move: emaAlignedAvgMove,
        opposed_avg_move: emaOpposedAvgMove,
      },
      st_precision: {
        aligned_pct: pct(stAligned, subset.length),
      },
      ltf_30m: ltfEnriched > 0 ? {
        enriched_count: ltfEnriched,
        rsi_30m_mean: rnd(rsi30mValues.reduce((s, v) => s + v, 0) / rsi30mValues.length, 0),
        st_30m_aligned_pct: stDir30mTotal > 0 ? pct(st30mAligned, stDir30mTotal) : null,
        ichimoku_aligned_pct: ich30mTotal > 0 ? pct(ich30mAligned, ich30mTotal) : null,
      } : null,
      weekly_htf: rsiWValues.length > 0 || stDirWTotal > 0 || ichWTotal > 0 ? {
        enriched_count: Math.max(rsiWValues.length, stDirWTotal, ichWTotal),
        rsi_w_mean: rsiWValues.length > 0 ? rnd(rsiWValues.reduce((s, v) => s + v, 0) / rsiWValues.length, 0) : null,
        st_w_aligned_pct: stDirWTotal > 0 ? pct(stWAligned, stDirWTotal) : null,
        ichimoku_w_aligned_pct: ichWTotal > 0 ? pct(ichWAligned, ichWTotal) : null,
      } : null,
      ichimoku: {
        daily_aligned_pct: ichDailyTotal > 0 ? pct(ichDailyAligned, ichDailyTotal) : null,
        weekly_aligned_pct: ichWTotal > 0 ? pct(ichWAligned, ichWTotal) : null,
        ltf_30m_aligned_pct: ich30mTotal > 0 ? pct(ich30mAligned, ich30mTotal) : null,
      },
    };
  }

  const upAnalysis = analyzeEntries(upMoves, "UP");
  const dnAnalysis = analyzeEntries(dnMoves, "DOWN");
  const longArchetypes = summarizeArchetypes(upMoves);
  const shortArchetypes = summarizeArchetypes(dnMoves);
  const runtimePolicy = buildRuntimePolicy(moves);

  // Overall personality and entry recommendations
  const allMoveAtrs = moves.map(m => m.move_atr);
  const allPullbacks = moves.map(m => m.max_pullback_pct);
  const avgAtrPct = moves.reduce((s, m) => s + (m.atr_at_start / m.start_price * 100), 0) / moves.length;

  const personality = moves[0].personality;

  // Derive actionable entry/exit parameters
  const entry_params = {
    // Typical pullback size (for SL placement)
    sl_atr_mult: rnd(median(allPullbacks) / (avgAtrPct || 1), 1),
    // Expected move size (for TP placement)
    tp_atr_mult: rnd(median(allMoveAtrs), 1),
    // Optimal RSI entry zone for longs
    long_rsi_sweet_spot: upAnalysis?.rsi_at_origin?.best_zone || "mid",
    // Optimal RSI entry zone for shorts
    short_rsi_sweet_spot: dnAnalysis?.rsi_at_origin?.best_zone || "mid",
    // How often EMA alignment matters
    ema_alignment_boost: upAnalysis ? rnd(upAnalysis.ema_precision.aligned_avg_move / (upAnalysis.ema_precision.opposed_avg_move || 1), 2) : 1,
    // Personality-based trail style
    trail_style: personality === "VOLATILE_RUNNER" ? "wide"
      : personality === "PULLBACK_PLAYER" ? "adaptive"
      : personality === "SLOW_GRINDER" ? "tight"
      : "standard",
    // Expected pullback depth (for re-entry logic)
    typical_pullback_pct: rnd(median(allPullbacks)),
    // LTF 30m signal context (available for moves since Feb 2024)
    ltf_30m_rsi_mean_long: upAnalysis?.ltf_30m?.rsi_30m_mean ?? null,
    ltf_30m_rsi_mean_short: dnAnalysis?.ltf_30m?.rsi_30m_mean ?? null,
    ltf_30m_st_aligned_pct: upAnalysis?.ltf_30m?.st_30m_aligned_pct ?? null,
    ltf_30m_ichimoku_aligned_pct_long: upAnalysis?.ltf_30m?.ichimoku_aligned_pct ?? null,
    ltf_30m_ichimoku_aligned_pct_short: dnAnalysis?.ltf_30m?.ichimoku_aligned_pct ?? null,
    weekly_rsi_mean_long: upAnalysis?.weekly_htf?.rsi_w_mean ?? null,
    weekly_rsi_mean_short: dnAnalysis?.weekly_htf?.rsi_w_mean ?? null,
    weekly_st_aligned_pct_long: upAnalysis?.weekly_htf?.st_w_aligned_pct ?? null,
    weekly_st_aligned_pct_short: dnAnalysis?.weekly_htf?.st_w_aligned_pct ?? null,
    weekly_ichimoku_aligned_pct_long: upAnalysis?.weekly_htf?.ichimoku_w_aligned_pct ?? null,
    weekly_ichimoku_aligned_pct_short: dnAnalysis?.weekly_htf?.ichimoku_w_aligned_pct ?? null,
    daily_ichimoku_aligned_pct_long: upAnalysis?.ichimoku?.daily_aligned_pct ?? null,
    daily_ichimoku_aligned_pct_short: dnAnalysis?.ichimoku?.daily_aligned_pct ?? null,
    long_dominant_archetype: longArchetypes.dominant || null,
    short_dominant_archetype: shortArchetypes.dominant || null,
    preferred_entry_engine_long: runtimePolicy?.defaults?.LONG?.entry_engine || null,
    preferred_entry_engine_short: runtimePolicy?.defaults?.SHORT?.entry_engine || null,
    preferred_management_engine_long: runtimePolicy?.defaults?.LONG?.management_engine || null,
    preferred_management_engine_short: runtimePolicy?.defaults?.SHORT?.management_engine || null,
    preferred_guard_bundle_long: runtimePolicy?.defaults?.LONG?.guard_bundle || null,
    preferred_guard_bundle_short: runtimePolicy?.defaults?.SHORT?.guard_bundle || null,
    preferred_exit_style_long: runtimePolicy?.defaults?.LONG?.exit_style || null,
    preferred_exit_style_short: runtimePolicy?.defaults?.SHORT?.exit_style || null,
    preferred_trim_bias_long: runtimePolicy?.defaults?.LONG?.trim_run_bias || null,
    preferred_trim_bias_short: runtimePolicy?.defaults?.SHORT?.trim_run_bias || null,
  };

  profiles[ticker] = {
    ticker,
    personality,
    total_moves: moves.length,
    up_moves: upMoves.length,
    dn_moves: dnMoves.length,
    avg_volatility_pct: rnd(avgAtrPct),
    long_profile: upAnalysis,
    short_profile: dnAnalysis,
    archetypes: {
      long: longArchetypes,
      short: shortArchetypes,
    },
    runtime_policy: runtimePolicy,
    entry_params,
  };
}

// ── Step 3: Report ────────────────────────────────────────────────────────

console.log(`${B}═══ Step 3: Profile Summary ═══${RST}\n`);

// Personality distribution
const personalityCounts = {};
for (const p of Object.values(profiles)) {
  personalityCounts[p.personality] = (personalityCounts[p.personality] || 0) + 1;
}
for (const [p, c] of Object.entries(personalityCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(20)} ${c} tickers`);
}
console.log();

// Sample profiles for key tickers
const sampleTickers = TICKER_FILTER ? [TICKER_FILTER] : ["CAT", "AAPL", "NVDA", "SMCI", "SPY", "TSLA", "GE", "H"];
for (const t of sampleTickers) {
  const p = profiles[t];
  if (!p) continue;
  console.log(`  ${B}${t}${RST} (${p.personality}):`);
  console.log(`    Moves: ${p.total_moves} (${p.up_moves} UP / ${p.dn_moves} DN)  |  Volatility: ${p.avg_volatility_pct}%`);
  console.log(`    Entry params: SL=${p.entry_params.sl_atr_mult}x ATR, TP=${p.entry_params.tp_atr_mult}x ATR, trail=${p.entry_params.trail_style}`);
  console.log(`    Typical pullback: ${p.entry_params.typical_pullback_pct}%  |  EMA boost: ${p.entry_params.ema_alignment_boost}x`);
  if (p.long_profile) {
    console.log(`    Long: avg_move=${p.long_profile.avg_move_pct}%, RSI sweet=${p.long_profile.rsi_at_origin.best_zone} (${p.long_profile.rsi_at_origin.best_zone_avg_move}%), EMA aligned=${p.long_profile.ema_precision.aligned_pct}%`);
  }
  if (p.short_profile) {
    console.log(`    Short: avg_move=${p.short_profile.avg_move_pct}%, RSI sweet=${p.short_profile.rsi_at_origin.best_zone} (${p.short_profile.rsi_at_origin.best_zone_avg_move}%)`);
  }
  console.log();
}

// ── Step 4: Write profiles to D1 ──────────────────────────────────────────

console.log(`${B}═══ Step 4: Writing Profiles to D1 ═══${RST}\n`);

// Store in ticker_profiles as learning_json column
// Add column if missing (idempotent)
execD1(`ALTER TABLE ticker_profiles ADD COLUMN learning_json TEXT`);

const sqlDir = path.join(__dirname, "..", "data");
const allStatements = [];
const profileEntries = Object.entries(profiles);

// Check which tickers already have rows
const existingRows = queryD1(`SELECT ticker FROM ticker_profiles`);
const existingSet = new Set(existingRows.map(r => r.ticker));

for (const [ticker, profile] of profileEntries) {
  const json = JSON.stringify(profile).replace(/'/g, "''");
  if (existingSet.has(ticker)) {
    allStatements.push(
      `UPDATE ticker_profiles SET learning_json='${json}' WHERE ticker='${ticker}'`
    );
  } else {
    allStatements.push(
      `INSERT INTO ticker_profiles (ticker, learning_json) VALUES ('${ticker}','${json}')`
    );
  }
}

console.log(`  [${elapsed()}] ${allStatements.length} SQL statements`);

const STMTS_PER_FILE = 40;
const totalChunks = Math.ceil(allStatements.length / STMTS_PER_FILE);
let chunkOk = 0, chunkFail = 0;

for (let ci = 0; ci < allStatements.length; ci += STMTS_PER_FILE) {
  const chunk = allStatements.slice(ci, ci + STMTS_PER_FILE).join(";\n") + ";\n";
  const chunkPath = path.join(sqlDir, `_tp_chunk.sql`);
  fs.writeFileSync(chunkPath, chunk);
  try {
    execSync(
      `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --file "${chunkPath}"`,
      { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8", timeout: 180000 }
    );
    chunkOk++;
  } catch (e) {
    chunkFail++;
    if (chunkFail <= 3) console.log(`  ${R}Chunk failed: ${e.message?.slice(0, 120)}${RST}`);
  }
  try { fs.unlinkSync(chunkPath); } catch {}
}

console.log(`  [${elapsed()}] ${G}${chunkOk} chunks ok${RST}, ${chunkFail} failed\n`);

// Save local report
const tsStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 15);
const report = {
  generated: new Date().toISOString(),
  ticker_count: tickers.length,
  personality_distribution: personalityCounts,
  profiles,
};
const outPath = path.join(sqlDir, `ticker-profiles-${tsStr}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`  ${G}Report saved:${RST} ${outPath}`);
console.log(`  ${G}Runtime:${RST} ${elapsed()}\n`);
