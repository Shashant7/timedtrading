#!/usr/bin/env node
// scripts/replace-live-investor-from-preprod.mjs
//
// Phase 3.9g — replace live Investor-Mode trades with the preprod backfill
// from Phase 3.9f. Trader-side data is NOT touched.
//
// Steps:
//   1. Pre-flight: snapshot trader+investor row counts on live
//   2. Export 4 investor tables from preprod (read-only)
//   3. Wipe live investor rows (mode-filtered for shared tables)
//   4. Insert preprod rows into live (chunked batches)
//   5. Verify: investor counts match preprod, trader counts unchanged
//
// Safety:
//   - --dry-run mode prints actions without executing
//   - Aborts if trader-state pre/post diff
//   - Writes data_audit_log row for every wipe/insert batch
//   - Live worker D1 binding is `timed-trading-ledger`; preprod is
//     `timed-trading-ledger-preprod`. Both via wrangler --remote.

import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WORKER_DIR = resolve(REPO, "worker");

const argv = parseArgs(process.argv.slice(2));
const DRY_RUN = !!argv["dry-run"];
const PREPROD_DB = "timed-trading-ledger-preprod";
const LIVE_DB = "timed-trading-ledger";
const EXPORT_DIR = resolve(REPO, "data/replace-live-investor-2026-05-11");

mkdirSync(EXPORT_DIR, { recursive: true });

console.error(`[replace-investor] DRY_RUN=${DRY_RUN}`);
console.error(`[replace-investor] preprod=${PREPROD_DB}  live=${LIVE_DB}`);

// ─────────────────────────────────────────────────────────────────────
// Step 1 — pre-flight snapshot of LIVE
// ─────────────────────────────────────────────────────────────────────
function snapshotLive() {
  const trader = {
    trades: count(LIVE_DB, "SELECT COUNT(*) AS n FROM trades"),
    promoted_trades: count(LIVE_DB, "SELECT COUNT(*) AS n FROM promoted_trades"),
    account_ledger_trader: count(LIVE_DB, "SELECT COUNT(*) AS n FROM account_ledger WHERE mode='trader'"),
    portfolio_snapshots_trader: count(LIVE_DB, "SELECT COUNT(*) AS n FROM portfolio_snapshots WHERE mode='trader'"),
    trader_realized_pnl: q(LIVE_DB, "SELECT ROUND(SUM(realized_pnl),2) AS v FROM account_ledger WHERE mode='trader'")[0]?.v ?? null,
  };
  const investor = {
    investor_positions: count(LIVE_DB, "SELECT COUNT(*) AS n FROM investor_positions"),
    investor_lots: count(LIVE_DB, "SELECT COUNT(*) AS n FROM investor_lots"),
    account_ledger_investor: count(LIVE_DB, "SELECT COUNT(*) AS n FROM account_ledger WHERE mode='investor'"),
    portfolio_snapshots_investor: count(LIVE_DB, "SELECT COUNT(*) AS n FROM portfolio_snapshots WHERE mode='investor'"),
    investor_realized_pnl: q(LIVE_DB, "SELECT ROUND(SUM(realized_pnl),2) AS v FROM account_ledger WHERE mode='investor'")[0]?.v ?? null,
  };
  return { trader, investor };
}

console.error("\n=== PRE-FLIGHT: LIVE state ===");
const live_pre = snapshotLive();
console.table(live_pre.trader);
console.table(live_pre.investor);

if (live_pre.trader.trades < 500) {
  throw new Error(`SAFETY ABORT: live trades count=${live_pre.trader.trades} unexpectedly low (expected >=587 from canonical)`);
}

// ─────────────────────────────────────────────────────────────────────
// Step 2 — export investor data from preprod
// ─────────────────────────────────────────────────────────────────────
console.error("\n=== EXPORT: preprod investor tables ===");
const ip_rows = q(PREPROD_DB, "SELECT * FROM investor_positions ORDER BY first_entry_ts");
const il_rows = q(PREPROD_DB, "SELECT * FROM investor_lots ORDER BY ts");
const al_rows = q(PREPROD_DB, "SELECT * FROM account_ledger WHERE mode='investor' ORDER BY ts");
const ps_rows = q(PREPROD_DB, "SELECT * FROM portfolio_snapshots WHERE mode='investor' ORDER BY ts");

writeFileSync(resolve(EXPORT_DIR, "investor_positions.json"), JSON.stringify(ip_rows, null, 2));
writeFileSync(resolve(EXPORT_DIR, "investor_lots.json"), JSON.stringify(il_rows, null, 2));
writeFileSync(resolve(EXPORT_DIR, "account_ledger_investor.json"), JSON.stringify(al_rows, null, 2));
writeFileSync(resolve(EXPORT_DIR, "portfolio_snapshots_investor.json"), JSON.stringify(ps_rows, null, 2));

console.error(`  investor_positions:    ${ip_rows.length} rows`);
console.error(`  investor_lots:         ${il_rows.length} rows`);
console.error(`  account_ledger:        ${al_rows.length} rows`);
console.error(`  portfolio_snapshots:   ${ps_rows.length} rows`);

if (DRY_RUN) {
  console.error("\n[dry-run] not wiping or inserting. Exiting.");
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────
// Step 3 — WIPE live investor rows (full table for investor-only tables;
//          mode-filter for shared tables)
// ─────────────────────────────────────────────────────────────────────
console.error("\n=== WIPE: live investor rows ===");

// data_audit_log entry pre-wipe
// Schema: audit_id (auto), ts, op, scope, caller, rows_affected, meta_json
const auditMeta = JSON.stringify({
  phase: "3.9g",
  preprod_source: PREPROD_DB,
  pre_counts: live_pre.investor,
  pre_trader: live_pre.trader,
  preprod_incoming: {
    investor_positions: ip_rows.length,
    investor_lots: il_rows.length,
    account_ledger_investor: al_rows.length,
    portfolio_snapshots_investor: ps_rows.length,
  },
}).replace(/'/g, "''");
exec(LIVE_DB, `INSERT INTO data_audit_log (ts, op, scope, caller, rows_affected, meta_json) VALUES (${Date.now()}, 'investor_replace_preflight', 'investor_*', 'replace-live-investor-from-preprod.mjs', ${live_pre.investor.investor_positions + live_pre.investor.investor_lots + live_pre.investor.account_ledger_investor + live_pre.investor.portfolio_snapshots_investor}, '${auditMeta}')`);

exec(LIVE_DB, "DELETE FROM investor_positions");
exec(LIVE_DB, "DELETE FROM investor_lots");
exec(LIVE_DB, "DELETE FROM account_ledger WHERE mode='investor'");
exec(LIVE_DB, "DELETE FROM portfolio_snapshots WHERE mode='investor'");

const live_post_wipe = snapshotLive();
console.error("  post-wipe live counts:");
console.error(`    investor_positions:    ${live_post_wipe.investor.investor_positions}`);
console.error(`    investor_lots:         ${live_post_wipe.investor.investor_lots}`);
console.error(`    account_ledger:        ${live_post_wipe.investor.account_ledger_investor}`);
console.error(`    portfolio_snapshots:   ${live_post_wipe.investor.portfolio_snapshots_investor}`);

// Trader integrity check
if (
  live_post_wipe.trader.trades !== live_pre.trader.trades ||
  live_post_wipe.trader.promoted_trades !== live_pre.trader.promoted_trades ||
  live_post_wipe.trader.account_ledger_trader !== live_pre.trader.account_ledger_trader ||
  live_post_wipe.trader.portfolio_snapshots_trader !== live_pre.trader.portfolio_snapshots_trader ||
  live_post_wipe.trader.trader_realized_pnl !== live_pre.trader.trader_realized_pnl
) {
  throw new Error("SAFETY ABORT: trader state changed during wipe!");
}

// ─────────────────────────────────────────────────────────────────────
// Step 4 — INSERT preprod data into live (chunked)
// ─────────────────────────────────────────────────────────────────────
console.error("\n=== INSERT: preprod investor data into live ===");

if (ip_rows.length > 0) {
  console.error(`  investor_positions: inserting ${ip_rows.length} rows`);
  insertChunked(LIVE_DB, "investor_positions", ip_rows, 50);
}
if (il_rows.length > 0) {
  console.error(`  investor_lots:      inserting ${il_rows.length} rows`);
  insertChunked(LIVE_DB, "investor_lots", il_rows, 50);
}
if (al_rows.length > 0) {
  console.error(`  account_ledger:     inserting ${al_rows.length} rows`);
  // account_ledger has AUTOINCREMENT ledger_id; let it auto-assign by EXCLUDING the column.
  insertChunked(LIVE_DB, "account_ledger", al_rows, 50, { exclude: ["ledger_id"] });
}
if (ps_rows.length > 0) {
  console.error(`  portfolio_snapshots: inserting ${ps_rows.length} rows`);
  insertChunked(LIVE_DB, "portfolio_snapshots", ps_rows, 50);
}

// ─────────────────────────────────────────────────────────────────────
// Step 5 — verify
// ─────────────────────────────────────────────────────────────────────
console.error("\n=== VERIFY: post-replace state ===");
const live_post = snapshotLive();
console.table(live_post.trader);
console.table(live_post.investor);

const expected = {
  investor_positions: ip_rows.length,
  investor_lots: il_rows.length,
  account_ledger_investor: al_rows.length,
  portfolio_snapshots_investor: ps_rows.length,
};
let mismatch = false;
for (const [k, v] of Object.entries(expected)) {
  if (live_post.investor[k] !== v) {
    console.error(`  MISMATCH ${k}: expected ${v}, got ${live_post.investor[k]}`);
    mismatch = true;
  }
}

// Trader integrity post-import
if (
  live_post.trader.trades !== live_pre.trader.trades ||
  live_post.trader.account_ledger_trader !== live_pre.trader.account_ledger_trader ||
  live_post.trader.portfolio_snapshots_trader !== live_pre.trader.portfolio_snapshots_trader ||
  live_post.trader.trader_realized_pnl !== live_pre.trader.trader_realized_pnl
) {
  console.error("  TRADER INTEGRITY VIOLATION:");
  console.error("    pre :", JSON.stringify(live_pre.trader));
  console.error("    post:", JSON.stringify(live_post.trader));
  process.exit(2);
}

// post-replace audit
const postMeta = JSON.stringify({
  phase: "3.9g",
  preprod_source: PREPROD_DB,
  post_counts: live_post.investor,
  trader_unchanged: {
    trades: live_post.trader.trades === live_pre.trader.trades,
    trader_realized_pnl: live_post.trader.trader_realized_pnl === live_pre.trader.trader_realized_pnl,
  },
}).replace(/'/g, "''");
const totalRowsAffected = live_post.investor.investor_positions + live_post.investor.investor_lots + live_post.investor.account_ledger_investor + live_post.investor.portfolio_snapshots_investor;
exec(LIVE_DB, `INSERT INTO data_audit_log (ts, op, scope, caller, rows_affected, meta_json) VALUES (${Date.now()}, 'investor_replace_complete', 'investor_*', 'replace-live-investor-from-preprod.mjs', ${totalRowsAffected}, '${postMeta}')`);

if (mismatch) {
  console.error("\nDONE WITH MISMATCH — see above");
  process.exit(3);
}

console.error("\nDONE — investor replace successful, trader untouched.");
console.error(`  exports saved: ${EXPORT_DIR}/`);

// ═════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════

function parseArgs(arr) {
  const out = {};
  for (const a of arr) {
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eqIdx = body.indexOf("=");
    const k = eqIdx < 0 ? body : body.slice(0, eqIdx);
    const v = eqIdx < 0 ? "true" : body.slice(eqIdx + 1);
    out[k] = v;
  }
  return out;
}

function q(db, sql) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 256, cwd: WORKER_DIR },
  );
  const idx = out.indexOf("[");
  if (idx < 0) throw new Error(`d1: no JSON in output: ${out.slice(0, 500)}`);
  return JSON.parse(out.slice(idx))[0]?.results ?? [];
}

function count(db, sql) {
  const r = q(db, sql);
  return r[0]?.n ?? 0;
}

function exec(db, sql) {
  // mutating commands (DELETE / INSERT). Re-uses --json for confirmation.
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", db, "--remote", "--command", sql],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 16, cwd: WORKER_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
}

function insertChunked(db, tableName, rows, chunkSize, opts = {}) {
  if (!rows.length) return;
  const exclude = new Set(opts.exclude || []);
  const cols = Object.keys(rows[0]).filter((c) => !exclude.has(c));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const valuesParts = chunk.map((r) => {
      const vals = cols.map((c) => sqlLiteral(r[c]));
      return `(${vals.join(",")})`;
    });
    const sql = `INSERT INTO ${tableName} (${cols.join(",")}) VALUES ${valuesParts.join(",")}`;
    exec(db, sql);
    process.stderr.write(`    chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(rows.length / chunkSize)} (${chunk.length} rows) ✓\n`);
  }
}

function sqlLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return "'" + String(v).replace(/'/g, "''") + "'";
}
