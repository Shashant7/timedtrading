#!/usr/bin/env node
/**
 * Copy ticker_candles rows from prod D1 → preprod D1 for a date window.
 * Uses wrangler d1 execute --remote --json (read) + INSERT OR REPLACE batches.
 *
 * Usage:
 *   node scripts/copy-candles-prod-to-preprod.mjs \
 *     --tickers=MSFT,GOOGL \
 *     --from=2026-05-01 --to=2026-08-01 \
 *     --tfs=10,30,60,240,D
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WORKER = join(ROOT, "worker");
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");

function arg(name, def = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const tickers = String(arg("tickers", "")).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
const fromStr = arg("from", "2026-05-01");
const toStr = arg("to", "2026-08-01");
const tfs = String(arg("tfs", "10,30,60,240,D")).split(",").map((t) => t.trim()).filter(Boolean);
const batchSize = Number(arg("batch", "80")) || 80;

if (!tickers.length) {
  console.error("Need --tickers=A,B,C");
  process.exit(2);
}

function ms(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

const fromMs = ms(fromStr);
const toMs = ms(toStr);
const tmp = mkdtempSync(join(tmpdir(), "candle-copy-"));

function d1Json(dbFlag, sql) {
  // dbFlag: [] for prod default, or ["--env=preprod"] 
  const args = ["d1", "execute", dbFlag[0] === "--env=preprod" ? "timed-trading-ledger-preprod" : "timed-trading-ledger",
    ...dbFlag, "--remote", "--json", "--command", sql];
  const out = execFileSync(WRANGLER, args, { cwd: WORKER, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // wrangler may print warnings before JSON
  const idx = out.indexOf("[");
  if (idx < 0) throw new Error(`no JSON from wrangler: ${out.slice(0, 200)}`);
  const data = JSON.parse(out.slice(idx));
  return data[0]?.results || [];
}

function esc(s) {
  return String(s ?? "").replace(/'/g, "''");
}

function numOrNull(v) {
  if (v == null || v === "") return "NULL";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "NULL";
}

function copyPair(ticker, tf) {
  const rows = d1Json([],
    `SELECT ticker, tf, ts, o, h, l, c, v, updated_at, session FROM ticker_candles
      WHERE ticker='${esc(ticker)}' AND tf='${esc(tf)}'
        AND ts >= ${fromMs} AND ts < ${toMs}
      ORDER BY ts`);
  if (!rows.length) {
    console.log(`  ${ticker} ${tf}: 0 rows`);
    return 0;
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values = chunk.map((r) =>
      `('${esc(r.ticker)}','${esc(r.tf)}',${Number(r.ts)},${numOrNull(r.o)},${numOrNull(r.h)},${numOrNull(r.l)},${numOrNull(r.c)},${numOrNull(r.v)},${numOrNull(r.updated_at)},${r.session == null ? "NULL" : `'${esc(r.session)}'`})`
    ).join(",");
    const sql = `INSERT OR REPLACE INTO ticker_candles (ticker, tf, ts, o, h, l, c, v, updated_at, session) VALUES ${values};`;
    const sqlPath = join(tmp, `${ticker}_${tf}_${i}.sql`);
    writeFileSync(sqlPath, sql);
    execFileSync(WRANGLER, [
      "d1", "execute", "timed-trading-ledger-preprod", "--env=preprod", "--remote", "--file", sqlPath,
    ], { cwd: WORKER, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    written += chunk.length;
    process.stdout.write(`  ${ticker} ${tf}: ${written}/${rows.length}\r`);
  }
  console.log(`  ${ticker} ${tf}: ${written}/${rows.length} ok`);
  return written;
}

console.log(`Copy ${tickers.length} tickers × ${tfs.join(",")}  ${fromStr} → ${toStr}`);
console.log(`tmp ${tmp}`);
let total = 0;
for (const t of tickers) {
  for (const tf of tfs) {
    try {
      total += copyPair(t, tf);
    } catch (e) {
      console.error(`FAIL ${t} ${tf}:`, e.message || e);
      process.exitCode = 1;
    }
  }
}
console.log(`Done. rows=${total}`);
