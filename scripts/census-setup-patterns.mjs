#!/usr/bin/env node
/**
 * Objective pattern census: all setup events + MR ladder stages before anchors/entries.
 *
 * Usage:
 *   node scripts/census-setup-patterns.mjs \
 *     --missed-file data/setup-mining/tiered-reliability/aggregate-2026-06-21T22-25-14.json \
 *     --wrangler-d1 preprod --min-atr 8 --limit 75
 *
 *   node scripts/census-setup-patterns.mjs \
 *     --missed-file ... --wrangler-d1 production --live --limit 75 --enrich-captured
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildPatternCensusReport,
  classifyMoveAlignment,
  diagnosticsForEntryWindow,
  diagnosticsForEventWindow,
  extractPatternProfile,
  formatPatternCensusMarkdown,
  joinMissedMoveWithTrailDiagnostics,
  joinTradeWithSequenceDiagnostics,
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

const MISSED_FILE = argValue("--missed-file", "");
const OUT_DIR = argValue("--out-dir", "data/setup-mining/pattern-census");
const WRANGLER_D1 = argValue("--wrangler-d1", "preprod");
const TRAIL_SOURCE = argValue("--trail-source", "raw");
const LIMIT = Math.max(1, Number(argValue("--limit", "211")) || 211);
const MIN_ATR = Number(argValue("--min-atr", "0")) || 0;
const PRE_ENTRY_HOURS = Number(argValue("--pre-entry-hours", "120")) || 120;
const ENRICH_CAPTURED = process.argv.includes("--enrich-captured") || process.argv.includes("--live");

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
  const sql = `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json FROM timed_trail WHERE ticker='${sym}' AND ts >= ${since} AND ts <= ${until} ORDER BY ts ASC LIMIT 2000`;
  return fetchD1Rows(wranglerEnv, sql);
}

function fetchLiveTrades(wranglerEnv, limit) {
  const sql = `SELECT trade_id, ticker, direction, entry_ts, exit_ts, pnl_pct, status, entry_path FROM trades WHERE status IN ('WIN','LOSS') AND run_id IS NULL ORDER BY entry_ts DESC LIMIT ${Math.max(limit * 3, 100)}`;
  return fetchD1Rows(wranglerEnv, sql);
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

function diagnosticsForAnchor(ticker, anchorTs, preEntryMs, wranglerEnv) {
  const since = anchorTs - preEntryMs;
  const events = fetchSetupEvents(ticker, since, anchorTs, wranglerEnv);
  if (events.length >= 3) {
    return { ...diagnosticsForEventWindow(events, anchorTs, { preEntryMs, ticker }), source: "setup_events" };
  }
  const trailRows = fetchTrailRows(ticker, since, anchorTs, wranglerEnv);
  const snapshots = snapshotsFromTrailRows(trailRows, ticker);
  return {
    ...diagnosticsForEntryWindow(
      snapshots,
      anchorTs,
      {
        preEntryMs,
        derivationOpts: { tdTfs: ["D", "W", "60"], signalTfs: ["D", "60", "30"] },
      },
    ),
    source: "trail_window",
  };
}

function enrichMissedRow(row, opts) {
  const anchorTs = Number(row.start_ts);
  const moveDir = resolveMoveDirection(row) || "LONG";
  const diag = diagnosticsForAnchor(row.ticker, anchorTs, opts.preEntryMs, opts.wranglerEnv);
  const seq = sequenceForDirection(diag.sequences || [], moveDir);
  return {
    ...row,
    direction: moveDir,
    sequence: compactSeq(seq),
    pattern_profile: diag.ok ? extractPatternProfile(diag, { moveDir }) : null,
    move_alignment: classifyMoveAlignment(row, seq),
    diagnostics_ok: diag.ok === true,
    diagnostics_reason: diag.reason || null,
    event_count: (diag.events || []).length,
    diagnostics_source: diag.source,
  };
}

function enrichCapturedRow(trade, opts) {
  const entryTs = Number(trade.entry_ts);
  const tradeDir = String(trade.direction || "LONG").toUpperCase();
  const diag = diagnosticsForAnchor(trade.ticker, entryTs, opts.preEntryMs, opts.wranglerEnv);
  const seq = sequenceForDirection(diag.sequences || [], tradeDir);
  const joined = joinTradeWithSequenceDiagnostics(trade, [], { preEntryMs: opts.preEntryMs, enrich_patterns: false });
  return {
    ...joined,
    sequence: compactSeq(seq),
    pattern_profile: diag.ok ? extractPatternProfile(diag, { moveDir: tradeDir }) : null,
    diagnostics_ok: diag.ok === true,
    event_count: (diag.events || []).length,
    diagnostics_source: diag.source,
    cohort: "live_trades",
    trade_outcome: joined.outcome,
  };
}

function main() {
  if (!MISSED_FILE || !fs.existsSync(MISSED_FILE)) {
    console.error("Missing --missed-file aggregate JSON");
    process.exit(1);
  }

  const opts = {
    preEntryMs: PRE_ENTRY_HOURS * 60 * 60 * 1000,
    wranglerEnv: WRANGLER_D1,
  };

  const missedRaw = loadMissedRows(MISSED_FILE);
  const missed = missedRaw.map((row) => enrichMissedRow(row, opts));

  let captured = [];
  if (ENRICH_CAPTURED) {
    captured = fetchLiveTrades(WRANGLER_D1, LIMIT)
      .slice(0, LIMIT)
      .map((trade) => enrichCapturedRow(trade, opts));
  }

  const report = buildPatternCensusReport([...missed, ...captured]);
  const payload = {
    generated_at: new Date().toISOString(),
    missed_file: MISSED_FILE,
    wrangler_d1: WRANGLER_D1,
    trail_source: TRAIL_SOURCE,
    pre_entry_hours: PRE_ENTRY_HOURS,
    min_atr: MIN_ATR,
    limit: LIMIT,
    missed_enriched: missed.length,
    captured_enriched: captured.length,
    report,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `census-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `census-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, formatPatternCensusMarkdown(report));

  console.log(JSON.stringify({
    json: jsonPath,
    md: mdPath,
    headline: report.headline,
    top_events: (report.by_event_type || []).slice(0, 10).map((r) => ({ key: r.key, n: r.total_n })),
    top_stage_keys: (report.by_matched_stage_key || []).slice(0, 10).map((r) => ({ key: r.key, n: r.total_n })),
  }, null, 2));
}

function loadMissedRows(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let rows = payload.report?.trades || payload.trades || [];
  if (MIN_ATR > 0) rows = rows.filter((r) => Number(r.move_atr) >= MIN_ATR);
  return refreshMoveAlignmentOnRows(rows.map((r) => ({ ...r, cohort: "discovery_missed" }))).slice(0, LIMIT);
}

main();
