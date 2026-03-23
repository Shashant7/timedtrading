#!/usr/bin/env node
/**
 * Backfill daily_market_snapshots from D1 daily candle data.
 * Reconstructs VIX, SPY, QQQ, IWM, oil, gold, TLT, BTC, ETH, sector ETF changes per trading day.
 *
 * Usage: node scripts/backfill-market-snapshots.js [--from 2025-07-01] [--to 2026-03-18] [--dry-run]
 */

const { execSync } = require("child_process");

const FROM = process.argv.includes("--from")
  ? process.argv[process.argv.indexOf("--from") + 1]
  : "2025-07-01";
const TO = process.argv.includes("--to")
  ? process.argv[process.argv.indexOf("--to") + 1]
  : "2026-03-18";
const DRY_RUN = process.argv.includes("--dry-run");

const TICKERS = ["VIX", "SPY", "QQQ", "IWM", "XLK", "XLY", "XLI", "XLU", "XLP", "XLV", "XLE", "XLF", "XLC", "CL1!", "GC1!", "TLT", "GLD", "BTCUSD", "ETHUSD"];
const OFFENSE = ["XLK", "XLY", "XLI"];
const DEFENSE = ["XLU", "XLP", "XLV"];

function d1Query(sql) {
  const result = execSync(
    `cd /Users/shashant/timedtrading && npx wrangler d1 execute timed-trading-ledger --remote --command="${sql.replace(/"/g, '\\"')}" --json 2>/dev/null`,
    { maxBuffer: 50 * 1024 * 1024, encoding: "utf-8" }
  );
  const parsed = JSON.parse(result);
  return parsed[0]?.results || [];
}

function d1ExecuteBatch(statements) {
  const combined = statements.join(";\n");
  const tmpFile = `/tmp/backfill-batch-${Date.now()}.sql`;
  require("fs").writeFileSync(tmpFile, combined);
  try {
    execSync(
      `cd /Users/shashant/timedtrading && npx wrangler d1 execute timed-trading-ledger --remote --file="${tmpFile}" 2>/dev/null`,
      { maxBuffer: 10 * 1024 * 1024, encoding: "utf-8", timeout: 30000 }
    );
    return true;
  } catch (e) {
    console.warn(`  WARN: batch failed: ${String(e).slice(0, 150)}`);
    return false;
  } finally {
    try { require("fs").unlinkSync(tmpFile); } catch {}
  }
}

function classifyVix(vix) {
  if (vix <= 15) return "low_fear";
  if (vix <= 22) return "normal";
  if (vix <= 30) return "elevated";
  return "fear";
}

function classifyRotation(off, def) {
  const d = off - def;
  if (d > 0.5) return "risk_on";
  if (d < -0.5) return "risk_off";
  return "balanced";
}

console.log(`Backfilling daily_market_snapshots from ${FROM} to ${TO}${DRY_RUN ? " (DRY RUN)" : ""}`);

const fromMs = new Date(FROM + "T00:00:00Z").getTime();
const toMs = new Date(TO + "T23:59:59Z").getTime();

const candles = {};
for (const ticker of TICKERS) {
  process.stdout.write(`  Loading ${ticker}...`);
  const rows = d1Query(
    `SELECT ts, o, h, l, c FROM ticker_candles WHERE ticker='${ticker}' AND tf='D' AND ts >= ${fromMs} AND ts <= ${toMs} ORDER BY ts ASC`
  );
  candles[ticker] = rows;
  console.log(` ${rows.length}`);
}

const tradingDates = [...new Set(candles["SPY"].map(c => {
  const d = new Date(c.ts < 1e12 ? c.ts * 1000 : c.ts);
  return d.toISOString().slice(0, 10);
}))];
console.log(`\n${tradingDates.length} unique trading dates`);

function findCandle(ticker, dateStr) {
  const dayStart = new Date(dateStr + "T00:00:00Z").getTime();
  const dayEnd = new Date(dateStr + "T23:59:59Z").getTime();
  return (candles[ticker] || []).find(c => {
    const ts = c.ts < 1e12 ? c.ts * 1000 : c.ts;
    return ts >= dayStart && ts <= dayEnd;
  });
}

function findPrevCandle(ticker, dateStr) {
  const dayStart = new Date(dateStr + "T00:00:00Z").getTime();
  const all = candles[ticker] || [];
  const prev = all.filter(c => {
    const ts = c.ts < 1e12 ? c.ts * 1000 : c.ts;
    return ts < dayStart;
  });
  return prev.length > 0 ? prev[prev.length - 1] : null;
}

function pctChange(ticker, dateStr) {
  const today = findCandle(ticker, dateStr);
  const prev = findPrevCandle(ticker, dateStr);
  if (!today || !prev || !prev.c || prev.c === 0) return null;
  return Math.round(((today.c - prev.c) / prev.c) * 10000) / 100;
}

const BATCH_SIZE = 10;
let batch = [];
let total = 0;
let failed = 0;

function flushBatch() {
  if (batch.length === 0) return;
  const ok = d1ExecuteBatch(batch);
  if (!ok) failed += batch.length;
  total += batch.length;
  batch = [];
}

for (const dateStr of tradingDates) {
  const vixCandle = findCandle("VIX", dateStr);
  const vixClose = vixCandle ? Number(vixCandle.c) : 0;
  const vixState = classifyVix(vixClose);

  const spyPct = pctChange("SPY", dateStr) || 0;
  const qqqPct = pctChange("QQQ", dateStr) || 0;
  const iwmPct = pctChange("IWM", dateStr) || 0;
  const oilPct = pctChange("CL1!", dateStr);
  const goldPct = pctChange("GC1!", dateStr);
  const tltPct = pctChange("TLT", dateStr);
  const btcPct = pctChange("BTCUSD", dateStr);
  const ethPct = pctChange("ETHUSD", dateStr);

  const offenseAvg = Math.round(OFFENSE.reduce((s, sym) => s + (pctChange(sym, dateStr) || 0), 0) / OFFENSE.length * 100) / 100;
  const defenseAvg = Math.round(DEFENSE.reduce((s, sym) => s + (pctChange(sym, dateStr) || 0), 0) / DEFENSE.length * 100) / 100;
  const sectorRotation = classifyRotation(offenseAvg, defenseAvg);
  const regimeOverall = (spyPct > 0.3 && qqqPct > 0.3) ? "risk_on" : (spyPct < -0.3 && qqqPct < -0.3) ? "risk_off" : "balanced";
  const regimeScore = Math.round((spyPct + qqqPct) * 10);

  if (DRY_RUN) {
    console.log(`  ${dateStr}: VIX=${vixClose.toFixed(1)}(${vixState}) SPY=${spyPct}% QQQ=${qqqPct}% BTC=${btcPct ?? "N/A"}% ETH=${ethPct ?? "N/A"}% rotation=${sectorRotation}`);
    continue;
  }

  const v = (x) => x == null ? "NULL" : `${x}`;
  const s = (x) => `'${x}'`;
  batch.push(
    `INSERT INTO daily_market_snapshots (date,vix_close,vix_state,oil_pct,gold_pct,tlt_pct,spy_pct,qqq_pct,iwm_pct,sector_rotation,offense_avg_pct,defense_avg_pct,regime_overall,regime_score,es_prediction,brief_summary,econ_events,btc_pct,eth_pct,created_at) VALUES (${s(dateStr)},${vixClose},${s(vixState)},${v(oilPct)},${v(goldPct)},${v(tltPct)},${spyPct},${qqqPct},${iwmPct},${s(sectorRotation)},${offenseAvg},${defenseAvg},${s(regimeOverall)},${regimeScore},NULL,NULL,NULL,${v(btcPct)},${v(ethPct)},${Date.now()}) ON CONFLICT(date) DO UPDATE SET vix_close=excluded.vix_close,vix_state=excluded.vix_state,oil_pct=excluded.oil_pct,gold_pct=excluded.gold_pct,tlt_pct=excluded.tlt_pct,spy_pct=excluded.spy_pct,qqq_pct=excluded.qqq_pct,iwm_pct=excluded.iwm_pct,sector_rotation=excluded.sector_rotation,offense_avg_pct=excluded.offense_avg_pct,defense_avg_pct=excluded.defense_avg_pct,regime_overall=excluded.regime_overall,regime_score=excluded.regime_score,btc_pct=excluded.btc_pct,eth_pct=excluded.eth_pct`
  );

  if (batch.length >= BATCH_SIZE) {
    process.stdout.write(`  ${total + batch.length}/${tradingDates.length}...\r`);
    flushBatch();
  }
}

if (!DRY_RUN) {
  flushBatch();
  console.log(`\nDone! Processed ${total} rows (${failed} failed).`);
} else {
  console.log(`\nDry run complete. ${tradingDates.length} dates.`);
}
