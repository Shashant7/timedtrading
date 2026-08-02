#!/usr/bin/env node
/**
 * Export investor positions opened in a month into Trade Autopsy
 * (backtest_runs + backtest_run_trades) on a target worker env.
 *
 * Default: pull July 2025 opens from preprod D1 via wrangler, POST the
 * payload to production's archive-investor endpoint so the live Trade Autopsy
 * UI can grade them.
 *
 * Usage:
 *   TIMED_API_KEY=… node scripts/export-investor-to-autopsy.mjs \
 *     --month=2025-07 \
 *     --run-id=investor-slice-2025-07-post890 \
 *     [--source-env=preprod] \
 *     [--target-api=https://timed-trading-ingest.shashant.workers.dev] \
 *     [--dry-run]
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const WORKER = resolve(REPO, "worker");

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

const MONTH = String(arg("month", "2025-07"));
const RUN_ID = String(arg("run-id", `investor-slice-${MONTH}-post890`));
const SOURCE_ENV = String(arg("source-env", "preprod"));
const TARGET_API = String(
  arg(
    "target-api",
    process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev",
  ),
).replace(/\/$/, "");
const DRY_RUN = !!arg("dry-run", false);
const API_KEY = process.env.TIMED_API_KEY || process.env.TIMED_TRADING_API_KEY || "";

if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(MONTH)) {
  console.error("ERROR: --month must be YYYY-MM");
  process.exit(2);
}
if (!DRY_RUN && !API_KEY) {
  console.error("ERROR: TIMED_API_KEY required (unless --dry-run)");
  process.exit(2);
}

function monthRangeMs(monthStr) {
  const [y, mo] = monthStr.split("-").map(Number);
  return {
    startMs: Date.UTC(y, mo - 1, 1, 0, 0, 0, 0),
    endMsExclusive: Date.UTC(y, mo, 1, 0, 0, 0, 0),
  };
}

function wranglerD1Json(envName, dbName, sql) {
  const args = [
    "d1",
    "execute",
    "--env",
    envName,
    dbName,
    "--remote",
    "--json",
    "--command",
    sql,
  ];
  const wrangler = resolve(REPO, "node_modules/.bin/wrangler");
  const res = spawnSync(wrangler, args, {
    cwd: WORKER,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(`wrangler failed: ${(res.stderr || res.stdout || "").slice(0, 800)}`);
  }
  const parsed = JSON.parse(res.stdout);
  return parsed[0]?.results || [];
}

const { startMs, endMsExclusive } = monthRangeMs(MONTH);
const dbName = SOURCE_ENV === "preprod" ? "timed-trading-ledger-preprod" : "timed-trading-ledger";
const envName = SOURCE_ENV === "preprod" ? "preprod" : "production";

console.log(`[export-investor-to-autopsy] source=${SOURCE_ENV} month=${MONTH} run_id=${RUN_ID}`);
console.log(`[export-investor-to-autopsy] target=${TARGET_API}`);

const positions = wranglerD1Json(
  envName,
  dbName,
  `SELECT id, ticker, status, avg_entry, total_shares, cost_basis, first_entry_ts, closed_at, investor_stage, thesis, created_at
     FROM investor_positions
    WHERE first_entry_ts >= ${startMs} AND first_entry_ts < ${endMsExclusive}
    ORDER BY first_entry_ts ASC, ticker ASC`,
);

if (!positions.length) {
  console.error(`ERROR: no investor_positions opened in ${MONTH} on ${SOURCE_ENV}`);
  process.exit(5);
}

const trades = [];
for (const pos of positions) {
  const lots = wranglerD1Json(
    envName,
    dbName,
    `SELECT id, position_id, ticker, action, shares, price, value, ts, reason
       FROM investor_lots
      WHERE position_id = '${String(pos.id).replace(/'/g, "''")}'
      ORDER BY ts ASC`,
  );
  const buys = lots.filter((l) => ["BUY", "DCA_BUY"].includes(String(l.action || "").toUpperCase()));
  const sells = lots.filter((l) => String(l.action || "").toUpperCase() === "SELL");
  const buy = buys[0] || null;
  const sell = sells.length ? sells[sells.length - 1] : null;
  const entryPrice = Number(buy?.price ?? pos.avg_entry);
  const shares = Number(buy?.shares ?? pos.total_shares);
  const exitPrice = sell ? Number(sell.price) : null;
  let pnl = null;
  let pnlPct = null;
  let status = String(pos.status || "OPEN").toUpperCase() === "OPEN" && !sell ? "OPEN" : "FLAT";
  if (sell && Number.isFinite(entryPrice) && Number.isFinite(exitPrice) && Number.isFinite(shares)) {
    pnl = (exitPrice - entryPrice) * shares;
    pnlPct = entryPrice !== 0 ? ((exitPrice / entryPrice) - 1) * 100 : null;
    status = pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT";
  }
  trades.push({
    trade_id: pos.id,
    ticker: pos.ticker,
    status,
    entry_ts: Number(buy?.ts ?? pos.first_entry_ts),
    entry_price: entryPrice,
    exit_ts: sell ? Number(sell.ts) : (pos.closed_at != null ? Number(pos.closed_at) : null),
    exit_price: exitPrice,
    exit_reason: sell?.reason || (status === "OPEN" ? null : "investor_closed"),
    shares,
    notional: Number(buy?.value ?? (entryPrice * shares)),
    pnl,
    pnl_pct: pnlPct,
    investor_stage: pos.investor_stage || null,
    thesis: pos.thesis || null,
    lots,
  });
}

console.log(`[export-investor-to-autopsy] prepared ${trades.length} trades (OPEN=${trades.filter((t) => t.status === "OPEN").length})`);
for (const t of trades) {
  console.log(
    `  ${t.status.padEnd(5)} ${String(t.ticker).padEnd(6)} entry=${t.entry_price} exit=${t.exit_price ?? "—"} pnl=${t.pnl == null ? "—" : t.pnl.toFixed(2)}`,
  );
}

if (DRY_RUN) {
  console.log("[export-investor-to-autopsy] dry-run — not posting");
  process.exit(0);
}

const body = {
  run_id: RUN_ID,
  month: MONTH,
  include_open: true,
  source: `${SOURCE_ENV}_export`,
  trades,
};

const res = await fetch(`${TARGET_API}/timed/admin/trade-autopsy/archive-investor`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`,
    "User-Agent": "TimedTradingAgent/export-investor-to-autopsy",
  },
  body: JSON.stringify(body),
});
const json = await res.json().catch(() => ({}));
if (!res.ok || !json?.ok) {
  console.error("ERROR: archive failed", res.status, json);
  process.exit(6);
}

console.log("[export-investor-to-autopsy] archived ok", {
  run_id: json.run_id,
  count: json.count,
  summary: json.summary,
  autopsy_url: json.autopsy_url,
});
console.log(`Open: ${TARGET_API.replace("timed-trading-ingest.shashant.workers.dev", "timed-trading.com")}${json.autopsy_url}`);
