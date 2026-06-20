#!/usr/bin/env node
/**
 * Preflight gates before Tier A preprod marathon — abort early if sequence
 * trail payloads are not being written (avoids a wasted multi-hour run).
 *
 * Usage:
 *   TIMED_API_KEY=... node scripts/preflight-tier-a-replay.mjs
 *   node scripts/preflight-tier-a-replay.mjs --probe-ticker KLAC --probe-date 2026-04-22
 */

import { execFileSync } from "node:child_process";
import path from "node:path";

const API_BASE = process.env.TIMED_API_BASE
  || "https://timed-trading-ingest-preprod.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";
const WRANGLER_ENV = "preprod";
const MIN_PAYLOAD_RATIO = Number(process.env.TIER_A_MIN_PAYLOAD_RATIO || "0.75");
const MIN_PROBE_TRAIL = Number(process.env.TIER_A_MIN_PROBE_TRAIL || "50");

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (v == null || v.startsWith("--")) return fallback;
  return v;
}

const PROBE_TICKER = String(argValue("--probe-ticker", "KLAC")).toUpperCase();
const PROBE_DATE = argValue("--probe-date", "2026-04-22");

function fail(msg) {
  console.error(`PREFLIGHT FAIL: ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`PREFLIGHT OK: ${msg}`);
}

function fetchD1(sql) {
  const dbName = "timed-trading-ledger-preprod";
  const out = execFileSync(path.join(process.cwd(), "node_modules/.bin/wrangler"), [
    "d1", "execute", dbName,
    "--env", WRANGLER_ENV,
    "--remote", "--json",
    "--command", sql,
  ], {
    cwd: path.join(process.cwd(), "worker"),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  const errText = parsed[0]?.error?.text || parsed.error?.text;
  if (errText) throw new Error(String(errText));
  return parsed[0]?.results || [];
}

async function main() {
  if (!API_KEY) fail("TIMED_API_KEY (or TIMED_TRADING_API_KEY) required");

  console.log(`=== Tier A preflight probe ${PROBE_TICKER} ${PROBE_DATE} api=${API_BASE} ===`);

  const params = new URLSearchParams({
    key: API_KEY,
    date: PROBE_DATE,
    tickers: PROBE_TICKER,
    tickerBatch: "1",
    fullDay: "1",
    trailOnly: "1",
    sequenceSnapshot: "1",
    disableReferenceExecution: "1",
    skipInvestor: "1",
    intervalMinutes: "5",
  });
  const resp = await fetch(`${API_BASE}/timed/admin/candle-replay?${params}`, { method: "POST" });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    fail(`candle-replay HTTP ${resp.status}: ${data.error || "unknown"}`);
  }

  const trailWritten = Number(data.trailWritten ?? data.dayTrailWritten ?? 0);
  if (trailWritten < MIN_PROBE_TRAIL) {
    fail(`probe day wrote only ${trailWritten} trail rows (need >= ${MIN_PROBE_TRAIL})`);
  }
  ok(`probe replay wrote ${trailWritten} trail rows`);

  const dayStart = Date.parse(`${PROBE_DATE}T13:30:00Z`);
  const dayEnd = dayStart + 86400000;
  const sym = PROBE_TICKER.replace(/[^A-Z0-9._-]/g, "");
  const stats = fetchD1(
    `SELECT COUNT(*) as n,
            SUM(CASE WHEN payload_json IS NOT NULL AND payload_json LIKE '%sequence_trail%' THEN 1 ELSE 0 END) as seq_n
     FROM timed_trail
     WHERE ticker='${sym}' AND ts >= ${dayStart} AND ts < ${dayEnd}`,
  )[0] || {};

  const n = Number(stats.n) || 0;
  const seqN = Number(stats.seq_n) || 0;
  const ratio = n > 0 ? seqN / n : 0;

  console.log(JSON.stringify({ probe_ticker: PROBE_TICKER, probe_date: PROBE_DATE, trail_rows: n, sequence_payload_rows: seqN, payload_ratio: Math.round(ratio * 1000) / 1000 }, null, 2));

  if (n < MIN_PROBE_TRAIL) {
    fail(`D1 has only ${n} trail rows for probe day (expected >= ${MIN_PROBE_TRAIL})`);
  }
  if (ratio < MIN_PAYLOAD_RATIO) {
    fail(`sequence_trail payload ratio ${ratio.toFixed(3)} < ${MIN_PAYLOAD_RATIO} — deploy preprod with SETUP_TRAIL_SNAPSHOT=1`);
  }

  ok(`sequence_trail payload ratio ${ratio.toFixed(3)} >= ${MIN_PAYLOAD_RATIO}`);
  console.log("=== Preflight passed — safe to start Tier A marathon ===");
}

main().catch((e) => {
  fail(String(e.message || e));
});
