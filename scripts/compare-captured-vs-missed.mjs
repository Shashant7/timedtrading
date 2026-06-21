#!/usr/bin/env node
/**
 * Compare setup sequences at entry for live captured trades vs discovery missed moves.
 *
 * Usage:
 *   node scripts/compare-captured-vs-missed.mjs \
 *     --missed-file data/setup-mining/tiered-reliability/aggregate-2026-06-21T21-57-57.json \
 *     --wrangler-d1 production --live --limit 75
 *
 *   node scripts/compare-captured-vs-missed.mjs --missed-file ... --captured-file data/.../summary.json
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  compareCapturedVsMissed,
  formatCapturedVsMissedMarkdown,
  joinTradeWithEventLedger,
  joinTradeWithSequenceDiagnostics,
  refreshMoveAlignmentOnRows,
} from "../worker/foundation/setup-replay-mining.js";

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const MISSED_FILE = argValue("--missed-file", "data/setup-mining/tiered-reliability/aggregate-2026-06-21T21-57-57.json");
const CAPTURED_FILE = argValue("--captured-file", "");
const OUT_DIR = argValue("--out-dir", "data/setup-mining/captured-vs-missed");
const WRANGLER_D1 = argValue("--wrangler-d1", "production");
const LIMIT = Math.max(1, Number(argValue("--limit", "75")) || 75);
const PRE_ENTRY_HOURS = Number(argValue("--pre-entry-hours", "48")) || 48;
const TRAIL_SOURCE = argValue("--trail-source", "5m");
const ANALYSIS_MODE = argValue("--analysis-mode", "combined");
const LIVE = process.argv.includes("--live");

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
  });
  return JSON.parse(out)[0]?.results || [];
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
  if (TRAIL_SOURCE === "snap" || TRAIL_SOURCE === "payload") {
    const sql = `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json FROM timed_trail WHERE ticker='${sym}' AND payload_json IS NOT NULL AND ts >= ${since} AND ts <= ${until} ORDER BY ts ASC LIMIT 2000`;
    const rows = fetchD1Rows(wranglerEnv, sql);
    if (rows.length) return rows;
  }
  const sql = `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json FROM timed_trail WHERE ticker='${sym}' AND ts >= ${since} AND ts <= ${until} ORDER BY ts ASC LIMIT 2000`;
  return fetchD1Rows(wranglerEnv, sql);
}

function fetchLiveTrades(wranglerEnv) {
  const sql = `SELECT trade_id, ticker, direction, entry_ts, exit_ts, pnl_pct, status, entry_path FROM trades WHERE status IN ('WIN','LOSS') AND run_id IS NULL ORDER BY entry_ts DESC LIMIT ${Math.max(LIMIT * 3, 100)}`;
  return fetchD1Rows(wranglerEnv, sql);
}

function loadMissedRows(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rows = payload.report?.trades || payload.trades || [];
  return refreshMoveAlignmentOnRows(rows.map((row) => ({
    ...row,
    cohort: "discovery_missed",
  })));
}

function loadCapturedRows(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return (payload.report?.trades || payload.trades || []).map((row) => ({
    ...row,
    cohort: row.cohort || "live_trades",
  }));
}

async function mineCapturedFromD1() {
  const preEntryMs = PRE_ENTRY_HOURS * 60 * 60 * 1000;
  const trades = fetchLiveTrades(WRANGLER_D1).slice(0, LIMIT);
  const trailCache = new Map();
  const joined = [];

  for (const trade of trades) {
    const ticker = String(trade.ticker || "").toUpperCase();
    const entryTs = Number(trade.entry_ts);
    const exitTs = Number(trade.exit_ts) || entryTs;
    if (!ticker || !Number.isFinite(entryTs)) continue;
    const since = entryTs - preEntryMs;
    const cacheKey = `${ticker}:${since}:${exitTs}`;
    if (!trailCache.has(cacheKey)) {
      try {
        trailCache.set(cacheKey, fetchTrailRows(ticker, since, exitTs, WRANGLER_D1));
      } catch {
        trailCache.set(cacheKey, []);
      }
    }
    let row = null;
    if (ANALYSIS_MODE === "events" || ANALYSIS_MODE === "combined") {
      const events = fetchSetupEvents(ticker, since, entryTs, WRANGLER_D1);
      if (events.length) {
        row = joinTradeWithEventLedger(trade, events, { preEntryMs, ticker });
      } else if (ANALYSIS_MODE === "events") {
        row = joinTradeWithEventLedger(trade, [], { preEntryMs, ticker });
      }
    }
    if (!row) {
      const trailRows = trailCache.get(cacheKey);
      row = joinTradeWithSequenceDiagnostics(trade, trailRows, {
        preEntryMs,
        analysis_mode: "captured_vs_missed",
        derivationOpts: { tdTfs: ["D", "W", "60"], signalTfs: ["D", "60", "30"] },
      });
    }
    joined.push({
      ...row,
      cohort: "live_trades",
      trade_outcome: row.outcome,
    });
  }
  return joined;
}

async function main() {
  if (!fs.existsSync(MISSED_FILE)) {
    console.error("Missing missed aggregate:", MISSED_FILE);
    process.exit(1);
  }

  const missed = loadMissedRows(MISSED_FILE);
  let captured = [];
  if (CAPTURED_FILE) {
    captured = loadCapturedRows(CAPTURED_FILE);
  } else {
    captured = await mineCapturedFromD1();
  }

  const comparison = compareCapturedVsMissed(captured, missed);
  const payload = {
    generated_at: new Date().toISOString(),
    missed_file: MISSED_FILE,
    captured_source: CAPTURED_FILE || `wrangler-d1:${WRANGLER_D1}:live:${LIMIT}`,
    trail_source: TRAIL_SOURCE,
    analysis_mode: ANALYSIS_MODE,
    comparison,
    captured_rows: captured.length,
    missed_rows: missed.length,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `compare-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `compare-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, formatCapturedVsMissedMarkdown(comparison));

  console.log(JSON.stringify({
    json: jsonPath,
    md: mdPath,
    captured: comparison.captured,
    missed: comparison.missed,
    top_sequences: (comparison.by_sequence || []).slice(0, 5),
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
