#!/usr/bin/env node
/**
 * Sync Timed Trading tv-levels into Pine Seeds CSV layout.
 *
 * Flow:
 *   1. Fetch /timed/tv-levels for each universe ticker
 *   2. Write seed-timedtrading-levels/data/*.csv + symbol_info/*.json
 *   3. Operator pushes seed-timedtrading-levels/ to a Pine Seeds fork
 *      (repo name must be seed_timedtrading_levels) and runs Check data
 *
 * Usage:
 *   TIMED_TRADING_API_KEY=... node scripts/sync-tv-levels-seed.mjs
 *   node scripts/sync-tv-levels-seed.mjs --tickers AAPL,NVDA --out seed-timedtrading-levels
 *
 * Note: TradingView suspended creation of NEW Pine Seed repos (2025+).
 * Use an existing TV-provisioned seed fork, or keep paste-sync until enabled.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WORKER = process.env.WORKER_URL || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_TRADING_API_KEY || process.env.TIMED_API_KEY || "";
const OUT_DIR = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : path.join(ROOT, "seed-timedtrading-levels");
const TICKER_ARG = process.argv.includes("--tickers")
  ? process.argv[process.argv.indexOf("--tickers") + 1]
  : null;
const LIMIT = Number(process.env.TV_SEED_LIMIT || "0") || 0;

async function fetchJson(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function loadTickers() {
  if (TICKER_ARG) {
    return TICKER_ARG.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  const keyQ = API_KEY ? `?key=${encodeURIComponent(API_KEY)}` : "";
  const all = await fetchJson(`${WORKER}/timed/all${keyQ}`);
  const data = all?.data || all?.tickers || {};
  const syms = Object.keys(data).map((s) => String(s).toUpperCase()).filter(Boolean);
  syms.sort();
  return LIMIT > 0 ? syms.slice(0, LIMIT) : syms;
}

async function main() {
  if (!API_KEY) {
    console.error("Set TIMED_TRADING_API_KEY (or TIMED_API_KEY)");
    process.exit(1);
  }

  const { encodeTvLevelsSeed, buildSeedSymbolInfo, SEED_REPO_NAME } = await import("../worker/tv-levels-seed.js");

  const tickers = await loadTickers();
  console.log(`[tv-seed] syncing ${tickers.length} tickers → ${OUT_DIR}`);

  const dataDir = path.join(OUT_DIR, "data");
  const symDir = path.join(OUT_DIR, "symbol_info");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(symDir, { recursive: true });

  const allSymbols = [];
  let ok = 0;
  let miss = 0;

  for (const sym of tickers) {
    try {
      const url = `${WORKER}/timed/tv-levels?ticker=${encodeURIComponent(sym)}&key=${encodeURIComponent(API_KEY)}`;
      const payload = await fetchJson(url);
      if (!payload?.ok) {
        miss++;
        continue;
      }
      const { symbols } = encodeTvLevelsSeed(payload);
      for (const row of symbols) {
        const file = path.join(dataDir, `${row.symbol}.csv`);
        fs.writeFileSync(file, `${row.csv}\n`, "utf8");
        allSymbols.push(row);
      }
      ok++;
      if (ok % 25 === 0) console.log(`[tv-seed] ${ok}/${tickers.length}...`);
    } catch (e) {
      miss++;
      console.warn(`[tv-seed] ${sym}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  const info = buildSeedSymbolInfo(allSymbols, SEED_REPO_NAME);
  fs.writeFileSync(
    path.join(symDir, info.fileName),
    `${JSON.stringify(info.body, null, 2)}\n`,
    "utf8",
  );

  console.log(`[tv-seed] done ok=${ok} miss=${miss} symbols=${allSymbols.length}`);
  console.log(`[tv-seed] symbol_info → ${path.join(symDir, info.fileName)}`);
  console.log("[tv-seed] Next: push this folder to your Pine Seeds fork and run Check data workflow.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
