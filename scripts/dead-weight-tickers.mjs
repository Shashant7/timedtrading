#!/usr/bin/env node
/**
 * Build a keep / watch / dead ticker report from cheap D1 dumps.
 *
 * Do not query ticker_candles here. Pass JSON produced by
 * `wrangler d1 execute … --json` (or the combined dump this script
 * writes). Report only — no registry mutation.
 *
 *   node scripts/dead-weight-tickers.mjs --dump /tmp/dw-dump.json --out /opt/cursor/artifacts/dead-weight-tickers.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { classifyDeadWeightUniverse, hasUsableLatestScore } from "../worker/dead-weight-tickers.js";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

function rowsFromWrangler(json) {
  if (Array.isArray(json) && json[0]?.results) {
    return json.flatMap((block) => block.results || []);
  }
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json)) return json;
  return [];
}

function loadTable(dump, key) {
  if (!dump?.[key]) return [];
  if (Array.isArray(dump[key]) && dump[key][0] && !dump[key][0].ticker && dump[key][0].results) {
    return rowsFromWrangler(dump[key]);
  }
  return rowsFromWrangler(dump[key]);
}

function up(s) {
  return String(s || "").trim().toUpperCase();
}

const dumpPath = arg("--dump");
const outPath = arg("--out", "/opt/cursor/artifacts/dead-weight-tickers.json");
if (!dumpPath) {
  console.error("usage: node scripts/dead-weight-tickers.mjs --dump <dump.json> [--out file]");
  process.exit(2);
}

const dump = JSON.parse(readFileSync(dumpPath, "utf8"));
const now = Number(dump.now) || Date.now();
const sectorKeys = new Set((dump.sectorMapKeys || []).map(up));

const indexRows = loadTable(dump, "ticker_index");
const profileRows = loadTable(dump, "ticker_profiles");
const latestRows = loadTable(dump, "ticker_latest");
const tradeRows = loadTable(dump, "live_trades");
const userRows = loadTable(dump, "user_tickers");
const invRows = loadTable(dump, "investor_positions");

const tickers = new Set();
for (const r of indexRows) tickers.add(up(r.ticker));
for (const r of latestRows) tickers.add(up(r.ticker));
for (const extra of dump.extraTickers || []) tickers.add(up(extra));
tickers.delete("");

const profiles = new Set(profileRows.map((r) => up(r.ticker)));
const users = new Set(userRows.filter((r) => !r.deleted_at).map((r) => up(r.ticker)));
const priority = new Set((dump.priorityPicks || []).map(up));

const latestBy = new Map();
for (const r of latestRows) {
  const sym = up(r.ticker);
  let payload = r;
  if (typeof r.payload_json === "string") {
    try { payload = { ...r, ...JSON.parse(r.payload_json) }; } catch (_) { /* keep row */ }
  }
  latestBy.set(sym, payload);
}

const tradesBy = new Map();
for (const r of tradeRows) {
  const sym = up(r.ticker);
  tradesBy.set(sym, {
    liveTradeCount: Number(r.n || r.liveTradeCount || 0),
    openLiveTrades: Number(r.n_open || r.openLiveTrades || 0),
    lastLiveEntryTs: Number(r.last_entry_ts || r.lastLiveEntryTs || 0) || 0,
  });
}

const invBy = new Map();
for (const r of invRows) {
  const sym = up(r.ticker);
  const prev = invBy.get(sym) || { openInvestor: false, investorPositionCount: 0 };
  prev.investorPositionCount += Number(r.n || 1);
  if (String(r.status || "").toUpperCase() === "OPEN") prev.openInvestor = true;
  invBy.set(sym, prev);
}

const facts = [...tickers].sort().map((ticker) => {
  const latest = latestBy.get(ticker);
  const tr = tradesBy.get(ticker) || {};
  const inv = invBy.get(ticker) || {};
  return {
    ticker,
    inSectorMap: sectorKeys.has(ticker),
    isUserSlot: users.has(ticker),
    isPriorityPick: priority.has(ticker),
    hasProfile: profiles.has(ticker),
    hasUsableScore: hasUsableLatestScore(latest),
    openLiveTrades: tr.openLiveTrades || 0,
    liveTradeCount: tr.liveTradeCount || 0,
    lastLiveEntryTs: tr.lastLiveEntryTs || 0,
    openInvestor: !!inv.openInvestor,
    investorPositionCount: inv.investorPositionCount || 0,
  };
});

const report = classifyDeadWeightUniverse(facts, now);
const out = {
  note: "Report only. Do not auto-remove. KEEP names stay regardless of idle rank.",
  do_not: [
    "Do not DELETE from ticker_candles or ticker_index from this list.",
    "Do not mutate timed:tickers / timed:removed without an operator REMOVE.",
    "Do not GROUP BY ticker_candles to refresh this report.",
  ],
  ...report,
  dead_reasons: report.byBucket.DEAD.reduce((acc, r) => {
    acc[r.reason] = (acc[r.reason] || 0) + 1;
    return acc;
  }, {}),
  watch: report.byBucket.WATCH.map((r) => r.ticker),
  dead: report.byBucket.DEAD.map((r) => r.ticker),
};

writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  out: outPath,
  counts: out.counts,
  dead_reasons: out.dead_reasons,
  watch_sample: out.watch.slice(0, 20),
  dead_sample: out.dead.slice(0, 20),
}, null, 2));
