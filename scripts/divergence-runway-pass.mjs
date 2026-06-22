#!/usr/bin/env node
/**
 * Divergence runway pass: event-order timing exhaustion → RSI div → momentum.
 *
 * Usage:
 *   node scripts/divergence-runway-pass.mjs \
 *     --missed-cache data/setup-mining/pattern-lift/missed-enriched.json \
 *     --with-backtest --backtest-limit 80
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  analyzeDivergenceRunway,
  buildDivergenceRunwayReport,
  buildEventLiftReport,
  formatDivergenceRunwayMarkdown,
  formatEventLiftMarkdown,
  resolveMoveDirection,
} from "../worker/foundation/setup-replay-mining.js";

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const MISSED_CACHE = argValue("--missed-cache", "data/setup-mining/pattern-lift/missed-enriched.json");
const OUT_DIR = argValue("--out-dir", "data/setup-mining/divergence-runway");
const MISSED_D1 = argValue("--missed-wrangler-d1", "preprod");
const BACKTEST_D1 = argValue("--wrangler-d1", "production");
const RUN_ID = argValue("--run-id", "backtest_2025-07-01_2025-12-31@2026-03-14T03:11:44.033Z");
const PRE_ENTRY_HOURS = Number(argValue("--pre-entry-hours", "120")) || 120;
const TIER_A_MIN = Number(argValue("--tier-a-min-atr", "8")) || 8;
const BACKTEST_LIMIT = Math.max(1, Number(argValue("--backtest-limit", "100")) || 100);
const WITH_BACKTEST = process.argv.includes("--with-backtest");
const TIER_A_ONLY = process.argv.includes("--tier-a-only");

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

function fetchBacktestTrades(runId, limit) {
  const rid = escSql(runId);
  const sql = `SELECT trade_id, ticker, direction, entry_ts, status FROM backtest_run_trades WHERE run_id = '${rid}' AND status IN ('WIN','LOSS') ORDER BY entry_ts ASC LIMIT ${limit}`;
  return fetchD1Rows(BACKTEST_D1, sql);
}

function attachEvents(row, anchorTs, moveDir, wranglerEnv, cache, preEntryMs) {
  const since = anchorTs - preEntryMs;
  const cacheKey = `${wranglerEnv}:${row.ticker}:${since}:${anchorTs}`;
  if (!cache.has(cacheKey)) {
    cache.set(cacheKey, fetchSetupEvents(row.ticker, since, anchorTs, wranglerEnv));
  }
  return {
    ...row,
    anchor_ts: anchorTs,
    move_dir: moveDir,
    events: cache.get(cacheKey),
  };
}

function main() {
  if (!fs.existsSync(MISSED_CACHE)) {
    console.error("Missing missed cache:", MISSED_CACHE);
    process.exit(1);
  }

  const preEntryMs = PRE_ENTRY_HOURS * 60 * 60 * 1000;
  const cache = new Map();
  let missed = JSON.parse(fs.readFileSync(MISSED_CACHE, "utf8"));
  if (TIER_A_ONLY) {
    missed = missed.filter((r) => Number(r.move_atr) >= TIER_A_MIN);
  }

  console.error(`Fetching setup_events for ${missed.length} missed moves (${MISSED_D1})...`);
  const missedWithEvents = missed.map((row) => {
    const anchorTs = Number(row.start_ts);
    const moveDir = resolveMoveDirection(row) || "LONG";
    return attachEvents(row, anchorTs, moveDir, MISSED_D1, cache, preEntryMs);
  });

  let backtestRows = [];
  if (WITH_BACKTEST) {
    console.error(`Fetching setup_events for ${BACKTEST_LIMIT} backtest trades (${BACKTEST_D1})...`);
    backtestRows = fetchBacktestTrades(RUN_ID, BACKTEST_LIMIT).map((t) => {
      const entryTs = Number(t.entry_ts);
      const dir = String(t.direction || "LONG").toUpperCase();
      return attachEvents({
        cohort: "backtest",
        trade_id: t.trade_id,
        ticker: t.ticker,
        direction: dir,
        entry_ts: entryTs,
        outcome: String(t.status || "").toLowerCase(),
        pattern_profile: null,
      }, entryTs, dir, BACKTEST_D1, cache, preEntryMs);
    });
  }

  const allRows = [...missedWithEvents, ...backtestRows];
  const report = buildDivergenceRunwayReport(allRows, { preEntryMs, tier_a_min_atr: TIER_A_MIN });

  const lift = buildEventLiftReport(missedWithEvents.filter((r) => r.pattern_profile), {
    tier_a_min_atr: TIER_A_MIN,
  });
  const divCombos = (lift.by_combo || []).filter((r) => r.key.includes("div") || r.key.includes("runway"));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const jsonPath = path.join(OUT_DIR, `runway-${stamp}.json`);
  const mdPath = path.join(OUT_DIR, `runway-${stamp}.md`);
  const liftMdPath = path.join(OUT_DIR, `runway-lift-${stamp}.md`);

  const payload = {
    generated_at: new Date().toISOString(),
    missed_cache: MISSED_CACHE,
    pre_entry_hours: PRE_ENTRY_HOURS,
    tier_a_min_atr: TIER_A_MIN,
    with_backtest: WITH_BACKTEST,
    backtest_limit: WITH_BACKTEST ? BACKTEST_LIMIT : 0,
    runway: report,
    divergence_combos: divCombos,
    missed_with_events: missedWithEvents.filter((r) => (r.events || []).length > 0).length,
    backtest_with_events: backtestRows.filter((r) => (r.events || []).length > 0).length,
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, formatDivergenceRunwayMarkdown(report));
  fs.writeFileSync(liftMdPath, formatEventLiftMarkdown({ ...lift, by_combo: divCombos }));

  console.log(JSON.stringify({
    json: jsonPath,
    md: mdPath,
    lift_md: liftMdPath,
    cohorts: report.cohorts,
    timing_medians: report.timing_medians,
    divergence_combos: divCombos.map((r) => ({
      key: r.key,
      win_lift: r.win_lift,
      missed_tier_a_rate: r.rates.missed_tier_a,
      backtest_win_rate: r.rates.backtest_win,
    })),
  }, null, 2));
}

main();
