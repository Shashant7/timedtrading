#!/usr/bin/env node
/**
 * Tier 3: Shadow backfill of setup_events from trail windows.
 *
 * Cohorts:
 *   fixtures  — parity ticker set (SPY, QQQ, IWM, USO, …)
 *   trades    — closed trades with optional rank_trace (entry window)
 *   discovery — MISSED moves from Discovery report export
 *
 * Usage:
 *   node scripts/backfill-setup-events.mjs --cohort fixtures --wrangler-d1 production
 *   node scripts/backfill-setup-events.mjs --cohort trades --wrangler-d1 production --limit 25
 *   node scripts/backfill-setup-events.mjs --cohort discovery --discovery-file data/move-discovery.json --limit 50
 *   node scripts/backfill-setup-events.mjs --cohort fixtures --api-base URL --dry-run
 *
 * Writes via POST /timed/admin/setup-events/backfill (requires SETUP_EVENTS_WRITE=1 on worker)
 * or --dry-run to only report derived event counts locally.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { deriveSetupEventsFromWindow } from "../worker/foundation/setup-event-derivation.js";
import { parseTrailSnapshotRow } from "../worker/foundation/setup-diagnostics-route.js";
import { filterMissedDiscoveryMoves } from "../worker/foundation/discovery-move-utils.js";

const API_BASE = process.env.TIMED_API_BASE
  || process.env.API_BASE
  || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";

const PARITY_FIXTURES = ["SPY", "QQQ", "IWM", "USO", "GLD", "XLE", "NVDA", "TSLA", "DIA"];

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

const COHORT = argValue("--cohort", "fixtures");
const WRANGLER_D1 = argValue("--wrangler-d1", "");
const LIMIT = Math.max(1, Number(argValue("--limit", "25")) || 25);
const PRE_ENTRY_HOURS = Number(argValue("--pre-entry-hours", "48")) || 48;
const DISCOVERY_FILE = argValue("--discovery-file", "");
const DRY_RUN = hasFlag("--dry-run");
const API_BASE_ARG = argValue("--api-base", API_BASE);
const TRAIL_SOURCE = argValue("--trail-source", "5m");

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

function fetchTrailRows(ticker, since, until, wranglerEnv) {
  const sym = String(ticker).toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  if (TRAIL_SOURCE === "5m") {
    const sql = `SELECT bucket_ts, price_close, state, kanban_stage_end, phase_pct, pdz_zone, pdz_pct, fvg_bull_count, fvg_bear_count, ema_regime_D, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite FROM trail_5m_facts WHERE ticker='${sym}' AND bucket_ts >= ${since} AND bucket_ts <= ${until} ORDER BY bucket_ts ASC LIMIT 2000`;
    return fetchD1Rows(wranglerEnv, sql);
  }
  const sql = `SELECT ts, price, state, kanban_stage, phase_pct, flags_json, payload_json FROM timed_trail WHERE ticker='${sym}' AND ts >= ${since} AND ts <= ${until} ORDER BY ts ASC LIMIT 2000`;
  return fetchD1Rows(wranglerEnv, sql);
}

function deriveEventsForWindow(ticker, since, until, wranglerEnv) {
  const rows = fetchTrailRows(ticker, since, until, wranglerEnv);
  const snapshots = rows.map((r) => parseTrailSnapshotRow(r, ticker)).filter(Boolean);
  const derived = deriveSetupEventsFromWindow(snapshots, {
    bootstrapFirst: true,
    source: `backfill_${COHORT}`,
    tdTfs: ["D", "W", "60"],
    signalTfs: ["D", "60", "30"],
  });
  return { rows: rows.length, snapshots: snapshots.length, events: derived.events, sequences: derived.sequences?.length || 0 };
}

async function postBackfillApi(ticker, since, until) {
  if (!API_KEY) throw new Error("TIMED_API_KEY required for API backfill");
  const params = new URLSearchParams({
    key: API_KEY,
    ticker,
    since: String(since),
    until: String(until),
    trailSource: TRAIL_SOURCE === "5m" ? "5m" : "raw",
  });
  if (DRY_RUN) params.set("dryRun", "1");
  const resp = await fetch(`${API_BASE_ARG}/timed/admin/setup-events/backfill?${params}`, { method: "POST" });
  return resp.json();
}

function loadDiscoveryMissed() {
  if (!DISCOVERY_FILE) return [];
  const raw = JSON.parse(fs.readFileSync(DISCOVERY_FILE, "utf8"));
  const moves = Array.isArray(raw?.moves) ? raw.moves : [];
  return filterMissedDiscoveryMoves(moves)
    .sort((a, b) => Number(b.move_atr || 0) - Number(a.move_atr || 0));
}

function loadTradeAnchors(wranglerEnv) {
  const sql = `SELECT ticker, entry_ts, exit_ts FROM backtest_run_trades WHERE status IN ('WIN','LOSS') ORDER BY entry_ts DESC LIMIT ${LIMIT * 2}`;
  return fetchD1Rows(wranglerEnv, sql).slice(0, LIMIT);
}

async function runLocalPersist(wranglerEnv, allEvents) {
  if (!allEvents.length) return { written: 0 };
  let written = 0;
  for (const ev of allEvents) {
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
      console.warn("D1 insert failed:", ev.event_id, String(e.message || e).slice(0, 80));
    }
  }
  return { written };
}

async function main() {
  const preMs = PRE_ENTRY_HOURS * 60 * 60 * 1000;
  const jobs = [];
  const summary = { cohort: COHORT, jobs: 0, events_derived: 0, events_persisted: 0, items: [] };

  if (COHORT === "fixtures") {
    for (const ticker of PARITY_FIXTURES.slice(0, LIMIT)) {
      const until = Date.now();
      const since = until - 7 * 86400000;
      jobs.push({ ticker, since, until, label: "fixture_7d" });
    }
  } else if (COHORT === "discovery") {
    const moves = loadDiscoveryMissed().slice(0, LIMIT);
    if (!moves.length) {
      console.error("No MISSED moves in --discovery-file");
      process.exit(1);
    }
    for (const m of moves) {
      const start = Number(m.start_ts);
      if (!Number.isFinite(start)) continue;
      jobs.push({
        ticker: m.ticker,
        since: start - preMs,
        until: start,
        label: `missed:${m.move_id || start}`,
      });
    }
  } else {
    if (!WRANGLER_D1) {
      console.error("--wrangler-d1 required for trades cohort");
      process.exit(1);
    }
    for (const t of loadTradeAnchors(WRANGLER_D1)) {
      const entry = Number(t.entry_ts);
      jobs.push({
        ticker: t.ticker,
        since: entry - preMs,
        until: entry,
        label: `trade:${t.ticker}:${entry}`,
      });
    }
  }

  const allEvents = [];
  for (const job of jobs) {
    summary.jobs += 1;
    if (WRANGLER_D1) {
      const result = deriveEventsForWindow(job.ticker, job.since, job.until, WRANGLER_D1);
      summary.events_derived += result.events.length;
      allEvents.push(...result.events);
      let persist = { written: 0 };
      if (!DRY_RUN) {
        persist = await runLocalPersist(WRANGLER_D1, result.events);
        summary.events_persisted += persist.written || 0;
      }
      summary.items.push({
        ...job,
        trail_rows: result.rows,
        snapshots: result.snapshots,
        events: result.events.length,
        sequences: result.sequences,
        persisted: persist.written || 0,
        dry_run: DRY_RUN,
      });
      continue;
    }
    const result = await postBackfillApi(job.ticker, job.since, job.until);
    if (result.events_derived != null) {
      summary.events_derived += Number(result.events_derived) || 0;
      if (result.persist?.written) summary.events_persisted += result.persist.written;
    }
    summary.items.push({ ...job, api: result });
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
