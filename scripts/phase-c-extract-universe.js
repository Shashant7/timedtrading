#!/usr/bin/env node
/**
 * scripts/phase-c-extract-universe.js
 *
 * Phase 1 prep — emits the SECTOR_MAP universe from worker/index.js as
 * data/phase-c-deep-dive/universe.json so downstream scripts (cohort
 * segmentation, signal forensics) can iterate the same set the live engine
 * scores. Read-only on the source; pure code transform.
 */
const fs = require("fs");
const path = require("path");

const WORKER_PATH = path.join(__dirname, "..", "worker", "index.js");
const OUT_PATH = path.join(__dirname, "..", "data", "phase-c-deep-dive", "universe.json");

function extractSectorMap(src) {
  const start = src.indexOf("const SECTOR_MAP = {");
  if (start === -1) throw new Error("SECTOR_MAP not found");
  // Walk until matching closing brace `};` at column 0
  let i = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("SECTOR_MAP unterminated");
  const body = src.slice(start, end + 1);
  // Pull "TICKER: \"Sector\"," entries with light parsing — strip line comments first.
  const lines = body.split("\n");
  const map = {};
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    // Match "AAPL": "Information Technology",   or   AAPL: "Information Technology",
    const m = line.match(/^"?([A-Z][A-Z0-9.\-!]*)"?\s*:\s*"([^"]+)"\s*,?$/);
    if (m) {
      const ticker = m[1];
      const sector = m[2];
      if (ticker === "SECTOR_MAP") continue;
      map[ticker] = sector;
    }
  }
  return map;
}

const src = fs.readFileSync(WORKER_PATH, "utf8");
const map = extractSectorMap(src);
const tickers = Object.keys(map).sort();
const bySector = {};
for (const [t, s] of Object.entries(map)) {
  bySector[s] ??= [];
  bySector[s].push(t);
}
for (const k of Object.keys(bySector)) bySector[k].sort();

const watchOnly = new Set([
  "SPX", "US500", "BTCUSD", "ETHUSD",
  "ES1!", "NQ1!", "GC1!", "SI1!", "VX1!", "CL1!", "RTY1!", "YM1!",
]);

const tradeable = tickers.filter((t) => !watchOnly.has(t));

const out = {
  generated_at: Date.now(),
  total: tickers.length,
  tradeable_count: tradeable.length,
  watch_only_count: tickers.length - tradeable.length,
  sectors: Object.fromEntries(Object.entries(bySector).map(([k, v]) => [k, v.length])),
  ticker_to_sector: map,
  tickers,
  tradeable,
  by_sector: bySector,
};
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`[universe] wrote ${OUT_PATH}: total=${tickers.length} tradeable=${tradeable.length} sectors=${Object.keys(bySector).length}`);
