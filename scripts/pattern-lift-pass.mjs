#!/usr/bin/env node
/**
 * Objective lift pass: backtest WIN vs LOSS vs missed Tier A event-combo rates.
 *
 * Usage:
 *   node scripts/pattern-lift-pass.mjs \
 *     --run-id backtest_2025-07-01_2025-12-31@2026-03-14T03:11:44.033Z \
 *     --missed-file data/setup-mining/tiered-reliability/aggregate-2026-06-21T22-25-14.json \
 *     --wrangler-d1 production --missed-wrangler-d1 preprod
 *
 *   node scripts/pattern-lift-pass.mjs --run-id ... --missed-cache data/setup-mining/pattern-lift/missed-enriched.json
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  augmentPatternProfileFromTrailFacts,
  buildEventLiftReport,
  classifyMoveAlignment,
  diagnosticsForEntryWindow,
  diagnosticsForEventWindow,
  extractPatternProfile,
  formatEventLiftMarkdown,
  refreshMoveAlignmentOnRows,
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

const RUN_ID = argValue("--run-id", "backtest_2025-07-01_2025-12-31@2026-03-14T03:11:44.033Z");
const MISSED_FILE = argValue("--missed-file", "data/setup-mining/tiered-reliability/aggregate-2026-06-21T22-25-14.json");
const MISSED_CACHE = argValue("--missed-cache", "");
const OUT_DIR = argValue("--out-dir", "data/setup-mining/pattern-lift");
const WRANGLER_D1 = argValue("--wrangler-d1", "production");
const MISSED_D1 = argValue("--missed-wrangler-d1", "preprod");
const TRAIL_SOURCE = argValue("--trail-source", "5m");
const PRE_ENTRY_HOURS = Number(argValue("--pre-entry-hours", "120")) || 120;
const BACKTEST_LIMIT = Math.max(1, Number(argValue("--backtest-limit", "500")) || 500);
const MISSED_LIMIT = Math.max(1, Number(argValue("--missed-limit", "211")) || 211);
const TIER_A_MIN = Number(argValue("--tier-a-min-atr", "8")) || 8;
const SKIP_MISSED = process.argv.includes("--skip-missed");

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
  const sql = `SELECT event_id, ticker, tf, event_ts, event_type, direction, price, source, confidence, payload_json FROM setup_events WHERE ticker='${sym}' AND event_ts >= ${since} AND event_ts <= ${until} ORDER BY event_ts ASC LIMIT 2000`;
  try {
    return fetchD1Rows(wranglerEnv, sql);
  } catch {
    return [];
  }
}

function fetchTrailRows(ticker, since, until, wranglerEnv) {
  const sym = String(ticker).toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  if (TRAIL_SOURCE === "5m") {
    const sql = `SELECT bucket_ts, price_close, state, kanban_stage_end, phase_pct, pdz_zone, pdz_pct, fvg_bull_count, fvg_bear_count, ema_regime_D, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite FROM trail_5m_facts WHERE ticker='${sym}' AND bucket_ts >= ${since} AND bucket_ts <= ${until} ORDER BY bucket_ts ASC LIMIT 2000`;
    return fetchD1Rows(wranglerEnv, sql);
  }
  const sql = `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json FROM timed_trail WHERE ticker='${sym}' AND ts >= ${since} AND ts <= ${until} ORDER BY ts ASC LIMIT 2000`;
  return fetchD1Rows(wranglerEnv, sql);
}

function fetchBacktestTrades(runId, limit) {
  const rid = escSql(runId);
  const sql = `SELECT trade_id, ticker, direction, entry_ts, exit_ts, pnl_pct, status, entry_path FROM backtest_run_trades WHERE run_id = '${rid}' AND status IN ('WIN','LOSS') ORDER BY entry_ts ASC LIMIT ${limit}`;
  return fetchD1Rows(WRANGLER_D1, sql);
}

function compactSeq(seq) {
  if (!seq?.sequence_type) return null;
  return {
    sequence_type: seq.sequence_type,
    direction: seq.direction,
    stage: seq.stage,
    stage_bucket: stageBucket(seq.stage),
    status: seq.status,
    confidence: seq.confidence,
  };
}

function diagnosticsForAnchor(ticker, anchorTs, preEntryMs, wranglerEnv, cache) {
  const since = anchorTs - preEntryMs;
  const cacheKey = `${wranglerEnv}:${ticker}:${since}:${anchorTs}`;
  if (cache && !cache.has(cacheKey)) {
    const events = fetchSetupEvents(ticker, since, anchorTs, wranglerEnv);
    if (events.length >= 3) {
      cache.set(cacheKey, { mode: "events", data: events });
    } else {
      cache.set(cacheKey, { mode: "trail", data: fetchTrailRows(ticker, since, anchorTs, wranglerEnv) });
    }
  }
  if (cache?.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    if (cached.mode === "events") {
      return { ...diagnosticsForEventWindow(cached.data, anchorTs, { preEntryMs, ticker }), source: "setup_events", trailRows: [] };
    }
    const snapshots = snapshotsFromTrailRows(cached.data, ticker);
    return {
      ...diagnosticsForEntryWindow(snapshots, anchorTs, {
        preEntryMs,
        derivationOpts: { tdTfs: ["D", "W", "60"], signalTfs: ["D", "60", "30"] },
      }),
      source: "trail_window",
      trailRows: cached.data,
    };
  }
  const events = fetchSetupEvents(ticker, since, anchorTs, wranglerEnv);
  if (events.length >= 3) {
    return { ...diagnosticsForEventWindow(events, anchorTs, { preEntryMs, ticker }), source: "setup_events" };
  }
  const trailRows = fetchTrailRows(ticker, since, anchorTs, wranglerEnv);
  const snapshots = snapshotsFromTrailRows(trailRows, ticker);
  return {
    ...diagnosticsForEntryWindow(snapshots, anchorTs, {
      preEntryMs,
      derivationOpts: { tdTfs: ["D", "W", "60"], signalTfs: ["D", "60", "30"] },
    }),
    source: "trail_window",
    trailRows,
  };
}

function enrichBacktestTrade(trade, opts, cache) {
  const entryTs = Number(trade.entry_ts);
  const tradeDir = String(trade.direction || "LONG").toUpperCase();
  const diag = diagnosticsForAnchor(trade.ticker, entryTs, opts.preEntryMs, opts.wranglerEnv, cache);
  const seq = sequenceForDirection(diag.sequences || [], tradeDir);
  const outcome = String(trade.status || "").toLowerCase();
  let patternProfile = diag.ok ? extractPatternProfile(diag, { moveDir: tradeDir }) : null;
  if (patternProfile && diag.trailRows?.length) {
    patternProfile = augmentPatternProfileFromTrailFacts(patternProfile, diag.trailRows, TRAIL_SOURCE);
  }
  return {
    trade_id: trade.trade_id,
    ticker: trade.ticker,
    direction: tradeDir,
    entry_ts: entryTs,
    entry_path: trade.entry_path,
    outcome,
    cohort: "backtest",
    run_id: opts.runId,
    sequence: compactSeq(seq),
    pattern_profile: patternProfile,
    diagnostics_ok: diag.ok === true,
    event_count: (diag.events || []).length,
    diagnostics_source: diag.source,
  };
}

function enrichMissedRow(row, opts, cache) {
  const anchorTs = Number(row.start_ts);
  const moveDir = resolveMoveDirection(row) || "LONG";
  const diag = diagnosticsForAnchor(row.ticker, anchorTs, opts.preEntryMs, opts.wranglerEnv, cache);
  const seq = sequenceForDirection(diag.sequences || [], moveDir);
  let patternProfile = diag.ok ? extractPatternProfile(diag, { moveDir }) : null;
  if (patternProfile && diag.trailRows?.length) {
    patternProfile = augmentPatternProfileFromTrailFacts(patternProfile, diag.trailRows, TRAIL_SOURCE);
  }
  return {
    ...row,
    direction: moveDir,
    sequence: compactSeq(seq),
    pattern_profile: patternProfile,
    move_alignment: classifyMoveAlignment(row, seq),
    diagnostics_ok: diag.ok === true,
    event_count: (diag.events || []).length,
    diagnostics_source: diag.source,
  };
}

function loadMissedRows(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rows = payload.report?.trades || payload.trades || [];
  return refreshMoveAlignmentOnRows(rows.map((r) => ({ ...r, cohort: "discovery_missed" }))).slice(0, MISSED_LIMIT);
}

function main() {
  const opts = {
    preEntryMs: PRE_ENTRY_HOURS * 60 * 60 * 1000,
    wranglerEnv: WRANGLER_D1,
    runId: RUN_ID,
  };
  const missedOpts = { ...opts, wranglerEnv: MISSED_D1 };
  const trailCache = new Map();

  console.error(`Enriching backtest run ${RUN_ID} (limit ${BACKTEST_LIMIT})...`);
  const backtestTrades = fetchBacktestTrades(RUN_ID, BACKTEST_LIMIT);
  const backtest = backtestTrades.map((t) => enrichBacktestTrade(t, opts, trailCache));
  const btWithProfile = backtest.filter((r) => r.pattern_profile);
  console.error(`  backtest: ${backtest.length} trades, ${btWithProfile.length} with pattern profile`);

  let missed = [];
  if (!SKIP_MISSED) {
    if (MISSED_CACHE && fs.existsSync(MISSED_CACHE)) {
      missed = JSON.parse(fs.readFileSync(MISSED_CACHE, "utf8"));
      console.error(`  missed: loaded ${missed.length} from cache ${MISSED_CACHE}`);
    } else if (MISSED_FILE && fs.existsSync(MISSED_FILE)) {
      console.error(`Enriching ${MISSED_LIMIT} missed moves from ${MISSED_D1}...`);
      missed = loadMissedRows(MISSED_FILE).map((row) => enrichMissedRow(row, missedOpts, trailCache));
      const cachePath = path.join(OUT_DIR, "missed-enriched.json");
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(missed, null, 2));
      console.error(`  missed: ${missed.length} enriched, cached ${cachePath}`);
    }
  }

  const allRows = [...backtest, ...missed];
  const lift = buildEventLiftReport(allRows, { tier_a_min_atr: TIER_A_MIN });

  const payload = {
    generated_at: new Date().toISOString(),
    run_id: RUN_ID,
    missed_file: MISSED_FILE,
    wrangler_d1: WRANGLER_D1,
    missed_wrangler_d1: MISSED_D1,
    trail_source: TRAIL_SOURCE,
    pre_entry_hours: PRE_ENTRY_HOURS,
    backtest_enriched: backtest.length,
    backtest_with_profile: btWithProfile.length,
    missed_enriched: missed.length,
    lift,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `lift-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `lift-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, formatEventLiftMarkdown(lift));

  console.log(JSON.stringify({
    json: jsonPath,
    md: mdPath,
    totals: lift.totals,
    top_win_lift: lift.top_win_lift?.map((r) => ({
      key: r.key,
      win_lift: r.win_lift,
      win_rate: r.rates.backtest_win,
      loss_rate: r.rates.backtest_loss,
    })),
    top_capture_gap: lift.top_capture_signals?.map((r) => ({
      key: r.key,
      capture_gap: r.capture_gap_tier_a,
      miss_tier_a_rate: r.rates.missed_tier_a,
      win_rate: r.rates.backtest_win,
    })),
  }, null, 2));
}

main();
