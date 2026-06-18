#!/usr/bin/env node
/**
 * Move-window replay orchestrator — rescore discovery move windows with live
 * worker candle-replay, persist sequence_trail snapshots, derive setup_events,
 * and emit shadow reliability tables.
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/replay-move-windows.mjs \
 *     --discovery-file data/move-discovery-live.json --limit 3 --ticker SOXL
 *
 *   node scripts/replay-move-windows.mjs --discovery-file data/move-discovery-live.json \
 *     --limit 5 --wrangler-d1 production --replay-only
 *
 * Options:
 *   --discovery-file PATH   move-discovery JSON export (required)
 *   --limit N               max moves to process (default 5)
 *   --ticker SYM            single ticker filter
 *   --min-atr N             minimum move_atr filter (default 0)
 *   --pre-entry-days N      calendar days before move start_date (default 5)
 *   --api-base URL          worker base URL
 *   --wrangler-d1 ENV       production|preprod — read trail + persist events via D1
 *   --out-dir PATH          write summary.json + summary.md (default data/setup-mining/move-replay)
 *   --replay-only           skip event persist + mining (replay trail only)
 *   --skip-replay           skip candle-replay (derive events from existing trail)
 *   --dry-run               print plan only
 *   --interval-minutes N    replay bar interval (default 5)
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deriveSetupEventsFromWindow } from "../worker/foundation/setup-event-derivation.js";
import { parseTrailSnapshotRow } from "../worker/foundation/setup-diagnostics-route.js";
import { setupEventToDbBind } from "../worker/foundation/setup-events-store.js";
import {
  discoveryMoveAnchorTs,
  discoveryMoveEndTs,
  filterMissedDiscoveryMoves,
  moveReplayDateRange,
} from "../worker/foundation/discovery-move-utils.js";
import {
  buildReliabilityReport,
  formatReliabilityMarkdown,
  joinMissedMoveWithTrailDiagnostics,
} from "../worker/foundation/setup-replay-mining.js";

const API_BASE = process.env.TIMED_API_BASE
  || process.env.API_BASE
  || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const DISCOVERY_FILE = argValue("--discovery-file", "");
const LIMIT = Math.max(1, Number(argValue("--limit", "5")) || 5);
const TICKER_FILTER = String(argValue("--ticker", "") || "").toUpperCase();
const MIN_ATR = Number(argValue("--min-atr", "0")) || 0;
const PRE_ENTRY_DAYS = Number(argValue("--pre-entry-days", "5")) || 5;
const API_BASE_ARG = argValue("--api-base", API_BASE);
const WRANGLER_D1 = argValue("--wrangler-d1", "");
const OUT_DIR = argValue("--out-dir", "data/setup-mining/move-replay");
const REPLAY_ONLY = hasFlag("--replay-only");
const SKIP_REPLAY = hasFlag("--skip-replay");
const DRY_RUN = hasFlag("--dry-run");
const INTERVAL_MINUTES = Math.max(1, Number(argValue("--interval-minutes", "5")) || 5);
const PRE_ENTRY_MS = PRE_ENTRY_DAYS * 86400000;

const REPLAY_RETRIES = 5;
const REPLAY_RETRY_MS = 30000;
const REPLAY_TIMEOUT_MS = 180000;

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

function loadMoves() {
  if (!DISCOVERY_FILE) {
    console.error("--discovery-file required");
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
  const moves = Array.isArray(raw?.moves) ? raw.moves : [];
  let filtered = filterMissedDiscoveryMoves(moves)
    .filter((m) => Number(m.move_atr || 0) >= MIN_ATR)
    .sort((a, b) => Number(b.move_atr || 0) - Number(a.move_atr || 0));
  if (TICKER_FILTER) {
    filtered = filtered.filter((m) => String(m.ticker || "").toUpperCase() === TICKER_FILTER);
  }
  return filtered.slice(0, LIMIT);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postCandleReplay(ticker, date) {
  if (!API_KEY) throw new Error("TIMED_API_KEY required for candle-replay");
  const params = new URLSearchParams({
    key: API_KEY,
    date,
    tickers: ticker,
    tickerBatch: "1",
    fullDay: "1",
    trailOnly: "1",
    sequenceSnapshot: "1",
    disableReferenceExecution: "1",
    skipInvestor: "1",
    intervalMinutes: String(INTERVAL_MINUTES),
  });
  const url = `${API_BASE_ARG}/timed/admin/candle-replay?${params}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= REPLAY_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { method: "POST", signal: controller.signal });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt < REPLAY_RETRIES) {
        console.warn(`  replay retry ${attempt}/${REPLAY_RETRIES} ${ticker} ${date}: ${String(e.message || e).slice(0, 120)}`);
        await sleep(REPLAY_RETRY_MS);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("replay_failed");
}

function fetchSequenceTrailRows(ticker, since, until, wranglerEnv) {
  const sym = String(ticker).toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  const sql = `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json FROM timed_trail WHERE ticker='${sym}' AND payload_json IS NOT NULL AND ts >= ${Number(since)} AND ts <= ${Number(until)} ORDER BY ts ASC LIMIT 5000`;
  return fetchD1Rows(wranglerEnv, sql);
}

function deriveEventsFromTrailRows(ticker, rows) {
  const snapshots = rows.map((r) => parseTrailSnapshotRow(r, ticker)).filter(Boolean);
  const derived = deriveSetupEventsFromWindow(snapshots, {
    bootstrapFirst: true,
    source: "historical_replay",
    tdTfs: ["D", "W", "60"],
    signalTfs: ["D", "60", "30"],
  });
  return { snapshots: snapshots.length, events: derived.events, sequences: derived.sequences?.length || 0 };
}

function persistEventsViaD1(wranglerEnv, events) {
  let written = 0;
  for (const ev of events) {
    const b = setupEventToDbBind(ev);
    const sqlVal = (v) => {
      if (v === null || v === undefined) return "NULL";
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
      return `'${String(v).replace(/'/g, "''")}'`;
    };
    const sql = `INSERT OR IGNORE INTO setup_events (event_id, ticker, tf, event_ts, event_type, direction, price, source, confidence, payload_json, created_at) VALUES (${b.map(sqlVal).join(",")})`;
    try {
      fetchD1Rows(wranglerEnv, sql);
      written += 1;
    } catch (e) {
      console.warn("  D1 insert failed:", ev.event_id, String(e.message || e).slice(0, 80));
    }
  }
  return written;
}

async function postBackfillApi(ticker, since, until) {
  if (!API_KEY) throw new Error("TIMED_API_KEY required for setup-events backfill");
  const params = new URLSearchParams({
    key: API_KEY,
    ticker,
    since: String(since),
    until: String(until),
    trailSource: "snap",
    source: "historical_replay",
  });
  const resp = await fetch(`${API_BASE_ARG}/timed/admin/setup-events/backfill?${params}`, { method: "POST" });
  return resp.json();
}

async function replayMoveWindow(move) {
  const ticker = String(move.ticker || "").toUpperCase();
  const { sessions, startDate, endDate } = moveReplayDateRange(move, { preEntryDays: PRE_ENTRY_DAYS });
  const dayResults = [];
  for (const date of sessions) {
    if (DRY_RUN) {
      dayResults.push({ date, dry_run: true });
      continue;
    }
    console.log(`  replay ${ticker} ${date} (${dayResults.length + 1}/${sessions.length})`);
    const data = await postCandleReplay(ticker, date);
    dayResults.push({
      date,
      trail_written: data.trailWritten ?? data.dayTrailWritten ?? null,
      scored: data.dayScored ?? data.scored ?? null,
    });
    await sleep(500);
  }
  return { ticker, startDate, endDate, sessions: sessions.length, dayResults };
}

async function processMove(move) {
  const ticker = String(move.ticker || "").toUpperCase();
  const anchorTs = discoveryMoveAnchorTs(move);
  const endTs = discoveryMoveEndTs(move) || anchorTs;
  const since = anchorTs - PRE_ENTRY_MS;
  const until = endTs;

  const item = {
    move_id: move.move_id || `${ticker}:${anchorTs}`,
    ticker,
    move_atr: Number(move.move_atr) || null,
    move_pct: Number(move.move_pct) || null,
    start_date: move.start_date,
    end_date: move.end_date,
    replay: null,
    trail_rows: 0,
    snapshots: 0,
    events_derived: 0,
    events_persisted: 0,
    sequences: 0,
    mining: null,
  };

  if (!SKIP_REPLAY) {
    item.replay = await replayMoveWindow(move);
  }

  if (REPLAY_ONLY) return item;

  if (WRANGLER_D1) {
    const rows = fetchSequenceTrailRows(ticker, since, until, WRANGLER_D1);
    item.trail_rows = rows.length;
    const derived = deriveEventsFromTrailRows(ticker, rows);
    item.snapshots = derived.snapshots;
    item.events_derived = derived.events.length;
    item.sequences = derived.sequences;
    if (!DRY_RUN && derived.events.length) {
      item.events_persisted = persistEventsViaD1(WRANGLER_D1, derived.events);
    }
    item.mining = joinMissedMoveWithTrailDiagnostics(move, rows, {
      preEntryMs: PRE_ENTRY_MS,
      analysis_mode: "sequence_trail_replay",
      derivationOpts: { tdTfs: ["D", "W", "60"], signalTfs: ["D", "60", "30"] },
    });
    return item;
  }

  const apiResult = await postBackfillApi(ticker, since, until);
  item.trail_rows = apiResult.trail_rows ?? 0;
  item.snapshots = apiResult.snapshots ?? 0;
  item.events_derived = apiResult.events_derived ?? 0;
  item.events_persisted = apiResult.persist?.written ?? 0;
  item.sequences = apiResult.sequences ?? 0;
  item.mining = { api: apiResult };
  return item;
}

async function main() {
  const moves = loadMoves();
  if (!moves.length) {
    console.error("No moves matched filters");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log(JSON.stringify({
      dry_run: true,
      moves: moves.map((m) => ({
        ticker: m.ticker,
        move_atr: m.move_atr,
        ...moveReplayDateRange(m, { preEntryDays: PRE_ENTRY_DAYS }),
      })),
    }, null, 2));
    return;
  }

  if (!SKIP_REPLAY && !API_KEY) {
    console.error("TIMED_API_KEY required unless --skip-replay");
    process.exit(1);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    discovery_file: DISCOVERY_FILE,
    limit: LIMIT,
    pre_entry_days: PRE_ENTRY_DAYS,
    wrangler_d1: WRANGLER_D1 || null,
    replay_only: REPLAY_ONLY,
    skip_replay: SKIP_REPLAY,
    moves_processed: 0,
    total_trail_rows: 0,
    total_events_derived: 0,
    total_events_persisted: 0,
    items: [],
  };

  const joinedRows = [];
  for (const move of moves) {
    console.log(`\n=== ${move.ticker} move_atr=${move.move_atr} ${move.start_date} → ${move.end_date} ===`);
    const item = await processMove(move);
    summary.moves_processed += 1;
    summary.total_trail_rows += item.trail_rows || 0;
    summary.total_events_derived += item.events_derived || 0;
    summary.total_events_persisted += item.events_persisted || 0;
    summary.items.push(item);
    if (item.mining && item.mining.ticker) joinedRows.push(item.mining);
    console.log(JSON.stringify(item, null, 2));
  }

  const report = buildReliabilityReport(joinedRows, {
    cohort: "discovery_replay",
    analysis_mode: "sequence_trail_replay",
    discovery_file: DISCOVERY_FILE,
  });
  summary.reliability = report.reliability;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `summary-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `summary-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, report }, null, 2));
  fs.writeFileSync(mdPath, formatReliabilityMarkdown(report));
  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
