#!/usr/bin/env node
/**
 * Shadow gate simulation: would stack_full_confirm have allowed entry?
 *
 * Usage:
 *   node scripts/simulate-confirm-stack-gate.mjs \
 *     --missed-cache data/setup-mining/pattern-lift/missed-enriched.json \
 *     --backtest-cache data/setup-mining/pattern-lift/backtest-enriched.json
 *
 *   # Build backtest cache + timing on Tier A (preprod events):
 *   node scripts/simulate-confirm-stack-gate.mjs --with-timing --build-backtest
 *
 *   # Expanded runway gates + rebuild backtest cache with TD9 parity:
 *   node scripts/simulate-confirm-stack-gate.mjs --build-backtest --rebuild-backtest \
 *     --gates stack_full_confirm,gate_confirm+div,gate_runway_full,stack_td9+div+momentum
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  augmentPatternProfileFromTrailFacts,
  buildGateSimulationReport,
  computeGateTimingFromEvents,
  computeGateTimingFromTrailRows,
  diagnosticsForEntryWindow,
  diagnosticsForEventWindow,
  extractPatternProfile,
  formatGateSimulationMarkdown,
  resolveMoveDirection,
  sequenceForDirection,
  snapshotsFromTrailRows,
  stageBucket,
} from "../worker/foundation/setup-replay-mining.js";

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const MISSED_CACHE = argValue("--missed-cache", "data/setup-mining/pattern-lift/missed-enriched.json");
const BACKTEST_CACHE = argValue("--backtest-cache", "data/setup-mining/pattern-lift/backtest-enriched.json");
const OUT_DIR = argValue("--out-dir", "data/setup-mining/gate-simulation");
const RUN_ID = argValue("--run-id", "backtest_2025-07-01_2025-12-31@2026-03-14T03:11:44.033Z");
const WRANGLER_D1 = argValue("--wrangler-d1", "production");
const MISSED_D1 = argValue("--missed-wrangler-d1", "preprod");
const PRE_ENTRY_HOURS = Number(argValue("--pre-entry-hours", "120")) || 120;
const TIER_A_MIN = Number(argValue("--tier-a-min-atr", "8")) || 8;
const BACKTEST_LIMIT = Math.max(1, Number(argValue("--backtest-limit", "362")) || 362);
const WITH_TIMING = process.argv.includes("--with-timing");
const BUILD_BACKTEST = process.argv.includes("--build-backtest");
const REBUILD_BACKTEST = process.argv.includes("--rebuild-backtest");
const PRIMARY_GATE = argValue("--primary-gate", "gate_runway_full");
const GATE_KEYS = (argValue("--gates", "stack_full_confirm,gate_confirm+div,gate_runway_full,stack_td9+div+momentum,stack_exhaust+rsi_div") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function fetchD1Rows(wranglerEnv, sql) {
  const dbName = wranglerEnv === "preprod" ? "timed-trading-ledger-preprod" : "timed-trading-ledger";
  const out = execFileSync(path.join(process.cwd(), "node_modules/.bin/wrangler"), [
    "d1", "execute", dbName,
    "--env", wranglerEnv,
    "--remote", "--json",
    "--command", sql,
  ], {
    cwd: path.join(process.cwd(), "worker"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out)[0]?.results || [];
}

function escSql(s) {
  return String(s).replace(/'/g, "''");
}

function fetchSetupEvents(ticker, since, until, wranglerEnv) {
  const sym = String(ticker).toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  const sql = `SELECT event_id, ticker, tf, event_ts, event_type, direction, price FROM setup_events WHERE ticker='${sym}' AND event_ts >= ${since} AND event_ts <= ${until} ORDER BY event_ts ASC LIMIT 2000`;
  try {
    return fetchD1Rows(wranglerEnv, sql);
  } catch {
    return [];
  }
}

function fetchTrailRows(ticker, since, until, wranglerEnv) {
  const sym = String(ticker).toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  const sql = `SELECT bucket_ts, price_close, state, kanban_stage_end, phase_pct, pdz_zone, pdz_pct, fvg_bull_count, fvg_bear_count, ema_regime_D, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite FROM trail_5m_facts WHERE ticker='${sym}' AND bucket_ts >= ${since} AND bucket_ts <= ${until} ORDER BY bucket_ts ASC LIMIT 2000`;
  return fetchD1Rows(wranglerEnv, sql);
}

function fetchDailyCandles(ticker, since, until, wranglerEnv) {
  const sym = String(ticker).toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  const padSince = since - 120 * 24 * 60 * 60 * 1000;
  const sql = `SELECT ts, o, h, l, c FROM ticker_candles WHERE ticker='${sym}' AND tf='D' AND ts >= ${padSince} AND ts <= ${until} ORDER BY ts ASC LIMIT 500`;
  try {
    return fetchD1Rows(wranglerEnv, sql);
  } catch {
    return [];
  }
}

function fetchBacktestTrades(runId, limit) {
  const rid = escSql(runId);
  const sql = `SELECT trade_id, ticker, direction, entry_ts, exit_ts, pnl_pct, status, entry_path FROM backtest_run_trades WHERE run_id = '${rid}' AND status IN ('WIN','LOSS') ORDER BY entry_ts ASC LIMIT ${limit}`;
  return fetchD1Rows(WRANGLER_D1, sql);
}

function enrichBacktestTrade(trade, preEntryMs, cache) {
  const entryTs = Number(trade.entry_ts);
  const tradeDir = String(trade.direction || "LONG").toUpperCase();
  const since = entryTs - preEntryMs;
  const cacheKey = `${WRANGLER_D1}:${trade.ticker}:${since}:${entryTs}`;
  if (!cache.has(cacheKey)) {
    const events = fetchSetupEvents(trade.ticker, since, entryTs, WRANGLER_D1);
    if (events.length >= 3) {
      cache.set(cacheKey, { mode: "events", data: events, dailyCandles: [] });
    } else {
      cache.set(cacheKey, {
        mode: "trail",
        data: fetchTrailRows(trade.ticker, since, entryTs, WRANGLER_D1),
        dailyCandles: fetchDailyCandles(trade.ticker, since, entryTs, WRANGLER_D1),
      });
    }
  }
  const cached = cache.get(cacheKey);
  let diag;
  if (cached.mode === "events") {
    diag = { ...diagnosticsForEventWindow(cached.data, entryTs, { preEntryMs, ticker: trade.ticker }), trailRows: [] };
  } else {
    const snapshots = snapshotsFromTrailRows(cached.data, trade.ticker);
    diag = {
      ...diagnosticsForEntryWindow(snapshots, entryTs, {
        preEntryMs,
        dailyCandles: cached.dailyCandles || [],
        derivationOpts: { tdTfs: ["D", "W", "60"], signalTfs: ["D", "60", "30"] },
      }),
      trailRows: cached.data,
    };
  }
  const seq = sequenceForDirection(diag.sequences || [], tradeDir);
  let patternProfile = diag.ok ? extractPatternProfile(diag, { moveDir: tradeDir }) : null;
  if (patternProfile && diag.trailRows?.length) {
    patternProfile = augmentPatternProfileFromTrailFacts(patternProfile, diag.trailRows, "5m");
  }
  return {
    trade_id: trade.trade_id,
    ticker: trade.ticker,
    direction: tradeDir,
    entry_ts: entryTs,
    outcome: String(trade.status || "").toLowerCase(),
    cohort: "backtest",
    run_id: RUN_ID,
    sequence: seq ? {
      sequence_type: seq.sequence_type,
      direction: seq.direction,
      stage: seq.stage,
      stage_bucket: stageBucket(seq.stage),
    } : null,
    pattern_profile: patternProfile,
    pnl_pct: Number(trade.pnl_pct) || null,
  };
}

function loadOrBuildBacktest(preEntryMs, cache) {
  if (!BUILD_BACKTEST && !REBUILD_BACKTEST && fs.existsSync(BACKTEST_CACHE)) {
    return JSON.parse(fs.readFileSync(BACKTEST_CACHE, "utf8"));
  }
  console.error(`Building backtest cache (${BACKTEST_LIMIT} trades)...`);
  const rows = fetchBacktestTrades(RUN_ID, BACKTEST_LIMIT).map((t) => enrichBacktestTrade(t, preEntryMs, cache));
  fs.mkdirSync(path.dirname(BACKTEST_CACHE), { recursive: true });
  fs.writeFileSync(BACKTEST_CACHE, JSON.stringify(rows, null, 2));
  console.error(`  wrote ${BACKTEST_CACHE}`);
  return rows;
}

function tierTimingForMove(row, preEntryMs, gateKey) {
  const anchorTs = Number(row.start_ts);
  const since = anchorTs - preEntryMs;
  const events = fetchSetupEvents(row.ticker, since, anchorTs, MISSED_D1);
  let timing = computeGateTimingFromEvents(events, anchorTs, gateKey, { preEntryMs });
  if (!timing.fires) {
    const trail = fetchTrailRows(row.ticker, since, anchorTs, MISSED_D1);
    const trailTiming = computeGateTimingFromTrailRows(trail, anchorTs, gateKey, { preEntryMs });
    if (trailTiming.fires) timing = trailTiming;
  }
  return timing;
}

function main() {
  if (!fs.existsSync(MISSED_CACHE)) {
    console.error("Missing missed cache:", MISSED_CACHE);
    process.exit(1);
  }

  const preEntryMs = PRE_ENTRY_HOURS * 60 * 60 * 1000;
  const cache = new Map();
  const missed = JSON.parse(fs.readFileSync(MISSED_CACHE, "utf8"));
  const backtest = loadOrBuildBacktest(preEntryMs, cache);
  const allRows = [...backtest, ...missed];

  const timingByMoveId = {};
  if (WITH_TIMING) {
    const tierA = missed.filter((r) => Number(r.move_atr) >= TIER_A_MIN);
    console.error(`Computing event timing for ${tierA.length} Tier A moves (${PRIMARY_GATE})...`);
    for (const row of tierA) {
      timingByMoveId[row.move_id] = tierTimingForMove(row, preEntryMs, PRIMARY_GATE);
    }
  }

  const report = buildGateSimulationReport(allRows, {
    gate_keys: GATE_KEYS,
    tier_a_min_atr: TIER_A_MIN,
    pre_entry_hours: PRE_ENTRY_HOURS,
    primary_gate: PRIMARY_GATE,
    timing_by_move_id: timingByMoveId,
  });

  const payload = {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    missed_cache: MISSED_CACHE,
    backtest_cache: BACKTEST_CACHE,
    pre_entry_hours: PRE_ENTRY_HOURS,
    tier_a_min_atr: TIER_A_MIN,
    primary_gate: PRIMARY_GATE,
    gate_keys: GATE_KEYS,
    with_timing: WITH_TIMING,
    timing_by_move_id: timingByMoveId,
    simulation: report,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `gate-sim-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `gate-sim-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, formatGateSimulationMarkdown(report));

  const primary = report.gates?.find((g) => g.key === PRIMARY_GATE);
  console.log(JSON.stringify({
    json: jsonPath,
    md: mdPath,
    primary_gate: primary,
    gates: report.gates?.map((g) => ({
      key: g.key,
      tier_a_enter_rate: g.tier_a.enter_rate,
      win_share_when_fires: g.win_share_when_gate_fires,
      capture_opportunity: g.capture_opportunity,
    })),
  }, null, 2));
}

main();
