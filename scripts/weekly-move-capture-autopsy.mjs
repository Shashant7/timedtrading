#!/usr/bin/env node
/**
 * Weekly ≥10% move-capture autopsy (CLI).
 *
 * Usage:
 *   node scripts/weekly-move-capture-autopsy.mjs --wrangler-d1 production --remote
 *   node scripts/weekly-move-capture-autopsy.mjs --wrangler-d1 production --remote --weeks 8
 *
 * Prefer the worker path when deployed:
 *   GET/POST /timed/admin/discovery/weekly-move-autopsy
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectWeeklyMoves,
  buildWeeklyAutopsyReport,
  CANARY_TICKERS,
  WEEKLY_MOVE_MIN_PCT,
} from "../worker/discovery/weekly-move-autopsy.js";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const d1Idx = args.indexOf("--wrangler-d1");
const envName = d1Idx >= 0 ? args[d1Idx + 1] : "production";
const weeksIdx = args.indexOf("--weeks");
const weeks = Math.min(Math.max(Number(weeksIdx >= 0 ? args[weeksIdx + 1] : 8) || 8, 1), 26);
const minPct = WEEKLY_MOVE_MIN_PCT;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "data", "trust-spine");

function d1Query(sql) {
  const remoteFlag = remote ? " --remote" : "";
  const envFlag = ` --env ${envName}`;
  const escaped = sql.replace(/'/g, "'\"'\"'");
  const cmd = `cd worker && npx wrangler d1 execute timed-trading-ledger${envFlag}${remoteFlag} --command '${escaped}'`;
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  const m = out.match(/"results":\s*(\[[\s\S]*?\])\s*,\s*"success"/);
  if (!m) throw new Error("could not parse D1 output");
  return JSON.parse(m[1]);
}

const since = Date.now() - (weeks * 7 + 14) * 86400000;
const canaryList = CANARY_TICKERS.map((t) => `'${t}'`).join(",");

// Focus CLI on canary + top movers by scanning canary fully, then a capped universe sample.
const tickers = d1Query(
  `SELECT DISTINCT ticker FROM ticker_candles
    WHERE tf = 'D' AND ts >= ${since}
      AND (ticker IN (${canaryList}) OR ticker IN (
        SELECT ticker FROM trades
         WHERE entry_ts >= ${since} AND (run_id IS NULL OR run_id = '')
         GROUP BY ticker ORDER BY COUNT(*) DESC LIMIT 80
      ))
    ORDER BY CASE WHEN ticker IN (${canaryList}) THEN 0 ELSE 1 END, ticker
    LIMIT 120`,
);

const tickerMoves = [];
for (const row of tickers) {
  const ticker = String(row.ticker || "").toUpperCase();
  const candles = d1Query(
    `SELECT ts, o, h, l, c FROM ticker_candles
      WHERE ticker = '${ticker}' AND tf = 'D' AND ts >= ${since}
      ORDER BY ts ASC`,
  );
  const moves = detectWeeklyMoves(candles, { minPct });
  if (!moves.length) continue;
  let trades = [];
  try {
    trades = d1Query(
      `SELECT trade_id, ticker, direction, status, pnl_pct, entry_ts, exit_ts,
              max_favorable_excursion
         FROM trades
        WHERE ticker = '${ticker}' AND (run_id IS NULL OR run_id = '')
          AND entry_ts >= ${since - 14 * 86400000}`,
    );
  } catch {
    trades = d1Query(
      `SELECT trade_id, ticker, direction, status, pnl_pct, entry_ts, exit_ts
         FROM trades
        WHERE ticker = '${ticker}' AND (run_id IS NULL OR run_id = '')
          AND entry_ts >= ${since - 14 * 86400000}`,
    );
  }
  let payload = null;
  try {
    const prow = d1Query(
      `SELECT payload_json FROM ticker_latest WHERE ticker = '${ticker}' LIMIT 1`,
    )[0];
    if (prow?.payload_json) payload = JSON.parse(prow.payload_json);
  } catch { /* */ }
  tickerMoves.push({ ticker, moves, trades, payload });
}

const report = buildWeeklyAutopsyReport({ tickerMoves, minPct, weeks, canary: CANARY_TICKERS });

const lines = [];
lines.push("# Weekly ≥10% Move-Capture Autopsy");
lines.push("");
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Env: ${envName} | weeks=${report.weeks} | min_pct=${minPct}`);
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push("```");
lines.push(JSON.stringify(report.summary, null, 2));
lines.push("```");
lines.push("");
lines.push("## Canary (NBIS/BE/DELL/MU/CRDO/OKLO)");
lines.push("");
for (const r of report.canary || []) {
  lines.push(`- ${r.week_key} ${r.ticker} ${r.direction} move=${r.move_pct}% → **${r.capture}**${r.miss_reason ? ` (${r.miss_reason})` : ""}${r.best_pnl_pct != null ? ` pnl=${r.best_pnl_pct}%` : ""}`);
}
if (!(report.canary || []).length) lines.push("_No canary ≥10% weeks in window._");
lines.push("");
lines.push("## Top missed");
lines.push("");
for (const r of report.top_missed || []) {
  lines.push(`- ${r.week_key} ${r.ticker} ${r.move_pct}% ${r.direction} — ${r.miss_reason || "unknown"}`);
}
lines.push("");
lines.push("API: `GET /timed/admin/discovery/weekly-move-autopsy` · `POST .../refresh`");
lines.push("Scoreboard rule: freeze net-new defensive gates without capture/MFE before-after.");

const md = lines.join("\n");
console.log(md);
fs.mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
fs.writeFileSync(path.join(OUT_DIR, `weekly-move-autopsy-${stamp}.md`), md);
fs.writeFileSync(path.join(OUT_DIR, `weekly-move-autopsy-${stamp}.json`), JSON.stringify(report, null, 2));
console.error(`\nWrote data/trust-spine/weekly-move-autopsy-${stamp}.{md,json}`);
