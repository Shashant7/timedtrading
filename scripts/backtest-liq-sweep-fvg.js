#!/usr/bin/env node
/**
 * Backtest: Liquidity Sweep + FVG Entry Strategy
 *
 * Strategy:
 *   LONG:  4H SSL swept → price reverses above swept SSL top → 15m bullish FVG forms → enter at FVG mid → SL at SSL bottom
 *   SHORT: 4H BSL swept → price reverses below swept BSL bottom → 15m bearish FVG forms → enter at FVG mid → SL at BSL top
 *
 * Uses historical candle data from D1 (ticker_candles) via the /timed/candles API.
 *
 * Usage:
 *   node scripts/backtest-liq-sweep-fvg.js
 *   node scripts/backtest-liq-sweep-fvg.js --tickers SPY,QQQ,AAPL --days 180
 *   node scripts/backtest-liq-sweep-fvg.js --rr 2 --max-hold 20
 */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

// ─── CLI ─────────────────────────────────────────────────────────────────────

function argVal(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] != null ? process.argv[i + 1] : fallback;
}

const TICKER_LIST = argVal("--tickers", "");
const DAYS = Number(argVal("--days", "365"));
const TARGET_RR = Number(argVal("--rr", "2"));
const MAX_HOLD_4H_BARS = Number(argVal("--max-hold", "20"));
const SWEEP_LOOKBACK = 3;
const FVG_WINDOW_BARS = 40; // 15m bars to look for FVG after sweep (~10 hours)
const VERBOSE = process.argv.includes("--verbose");

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJson(url) {
  const sep = url.includes("?") ? "&" : "?";
  const fullUrl = `${url}${sep}key=${API_KEY}`;
  const res = await fetch(fullUrl, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtPct(n) { return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "—"; }
function fmtNum(n, d = 2) { return Number.isFinite(n) ? n.toFixed(d) : "—"; }

function computeATR(bars, period = 14) {
  if (bars.length < period + 1) return 0;
  let sum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    sum += tr;
  }
  return sum / period;
}

// ─── Swing Pivots ────────────────────────────────────────────────────────────

function findSwingPivots(bars, lookback = 3) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
    }
    if (isHigh) highs.push({ price: bars[i].h, idx: i, ts: bars[i].ts });
    if (isLow) lows.push({ price: bars[i].l, idx: i, ts: bars[i].ts });
  }
  return { highs, lows };
}

// ─── Liquidity Zone Detection (rolling) ──────────────────────────────────────

function detectLiquidityZonesAt(bars, endIdx, atr) {
  const window = bars.slice(Math.max(0, endIdx - 120), endIdx + 1);
  if (window.length < 20 || atr <= 0) return { buyside: [], sellside: [] };

  const pivots = findSwingPivots(window, SWEEP_LOOKBACK);
  const threshold = atr / 2.5;

  function cluster(pivotArr) {
    if (pivotArr.length < 2) return [];
    const sorted = [...pivotArr].sort((a, b) => a.price - b.price);
    const clusters = [];
    let cl = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].price - cl[0].price <= threshold) {
        cl.push(sorted[i]);
      } else {
        if (cl.length >= 3) {
          const avg = cl.reduce((s, p) => s + p.price, 0) / cl.length;
          const lo = Math.min(...cl.map(p => p.price));
          const hi = Math.max(...cl.map(p => p.price));
          clusters.push({ level: avg, lo, hi, count: cl.length });
        }
        cl = [sorted[i]];
      }
    }
    if (cl.length >= 3) {
      const avg = cl.reduce((s, p) => s + p.price, 0) / cl.length;
      const lo = Math.min(...cl.map(p => p.price));
      const hi = Math.max(...cl.map(p => p.price));
      clusters.push({ level: avg, lo, hi, count: cl.length });
    }
    return clusters;
  }

  return {
    buyside: cluster(pivots.highs), // BSL: equal highs (stops above)
    sellside: cluster(pivots.lows),  // SSL: equal lows (stops below)
  };
}

// ─── FVG Detection on 15m bars ───────────────────────────────────────────────

function detect15mFVGs(bars15m, startIdx, count, atr15) {
  const fvgs = [];
  const end = Math.min(startIdx + count, bars15m.length);
  for (let i = startIdx + 2; i < end; i++) {
    const curr = bars15m[i];
    const prev2 = bars15m[i - 2];
    if (!curr || !prev2) continue;

    // Bullish FVG: gap up
    if (curr.l > prev2.h) {
      const size = curr.l - prev2.h;
      if (atr15 > 0 && size < atr15 * 0.1) continue;
      fvgs.push({ type: "bull", top: curr.l, bottom: prev2.h, mid: (curr.l + prev2.h) / 2, idx: i, ts: curr.ts });
    }
    // Bearish FVG: gap down
    if (curr.h < prev2.l) {
      const size = prev2.l - curr.h;
      if (atr15 > 0 && size < atr15 * 0.1) continue;
      fvgs.push({ type: "bear", top: prev2.l, bottom: curr.h, mid: (prev2.l + curr.h) / 2, idx: i, ts: curr.ts });
    }
  }
  return fvgs;
}

// ─── Find 15m bar index closest to a 4H timestamp ────────────────────────────

function find15mIdx(bars15m, ts) {
  let lo = 0, hi = bars15m.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars15m[mid].ts < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.min(lo, bars15m.length - 1);
}

// ─── Strategy Backtest per Ticker ────────────────────────────────────────────

function backtestTicker(ticker, bars4h, bars15m) {
  const trades = [];
  if (bars4h.length < 60 || bars15m.length < 200) return trades;

  for (let i = 30; i < bars4h.length - MAX_HOLD_4H_BARS; i++) {
    const atr4h = computeATR(bars4h.slice(0, i + 1), 14);
    if (atr4h <= 0) continue;

    const liq = detectLiquidityZonesAt(bars4h, i - 1, atr4h);
    const bar = bars4h[i];
    const threshold4h = atr4h / 2.5;

    // Check for SSL sweep (price dips below SSL → potential long)
    for (const ssl of liq.sellside) {
      const swept = bar.l < ssl.lo - threshold4h * 0.3;
      if (!swept) continue;

      // Confirm reversal: bar closes back above the SSL top
      const closedAbove = bar.c > ssl.hi;
      if (!closedAbove) continue;

      // Find matching 15m window after the sweep
      const sweepTs = bar.ts;
      const idx15 = find15mIdx(bars15m, sweepTs);
      const atr15 = computeATR(bars15m.slice(Math.max(0, idx15 - 20), idx15 + 1), 14);
      const fvgs = detect15mFVGs(bars15m, idx15, FVG_WINDOW_BARS, atr15);
      const bullFvg = fvgs.find(f => f.type === "bull" && f.bottom > ssl.hi);

      if (!bullFvg) continue;

      // Entry at FVG mid, SL at SSL bottom
      const entry = bullFvg.mid;
      const sl = ssl.lo;
      const risk = entry - sl;
      if (risk <= 0 || risk < atr4h * 0.1) continue;
      const tp = entry + risk * TARGET_RR;

      // Simulate forward on 15m bars
      const result = simulateTrade(bars15m, bullFvg.idx, entry, sl, tp, "LONG");
      if (result) {
        trades.push({ ticker, direction: "LONG", ...result, sweepLevel: ssl.level, fvgMid: entry, sl, tp, risk, atr4h, sweepTs });
      }
    }

    // Check for BSL sweep (price spikes above BSL → potential short)
    for (const bsl of liq.buyside) {
      const swept = bar.h > bsl.hi + threshold4h * 0.3;
      if (!swept) continue;

      const closedBelow = bar.c < bsl.lo;
      if (!closedBelow) continue;

      const sweepTs = bar.ts;
      const idx15 = find15mIdx(bars15m, sweepTs);
      const atr15 = computeATR(bars15m.slice(Math.max(0, idx15 - 20), idx15 + 1), 14);
      const fvgs = detect15mFVGs(bars15m, idx15, FVG_WINDOW_BARS, atr15);
      const bearFvg = fvgs.find(f => f.type === "bear" && f.top < bsl.lo);

      if (!bearFvg) continue;

      const entry = bearFvg.mid;
      const sl = bsl.hi;
      const risk = sl - entry;
      if (risk <= 0 || risk < atr4h * 0.1) continue;
      const tp = entry - risk * TARGET_RR;

      const result = simulateTrade(bars15m, bearFvg.idx, entry, sl, tp, "SHORT");
      if (result) {
        trades.push({ ticker, direction: "SHORT", ...result, sweepLevel: bsl.level, fvgMid: entry, sl, tp, risk, atr4h, sweepTs });
      }
    }
  }

  return trades;
}

// ─── Trade Simulation (forward walk on 15m bars) ─────────────────────────────

function simulateTrade(bars15m, entryIdx, entry, sl, tp, direction) {
  const maxBars = MAX_HOLD_4H_BARS * 16; // 4H bars × 16 (15m per 4H)
  let mfe = 0, mae = 0;

  for (let i = entryIdx + 1; i < Math.min(bars15m.length, entryIdx + maxBars); i++) {
    const bar = bars15m[i];

    if (direction === "LONG") {
      const excursionUp = (bar.h - entry) / entry;
      const excursionDn = (entry - bar.l) / entry;
      if (excursionUp > mfe) mfe = excursionUp;
      if (excursionDn > mae) mae = excursionDn;

      if (bar.l <= sl) return { outcome: "LOSS", exitPrice: sl, exitIdx: i, exitTs: bar.ts, pnlPct: (sl - entry) / entry, mfe, mae, holdBars: i - entryIdx };
      if (bar.h >= tp) return { outcome: "WIN", exitPrice: tp, exitIdx: i, exitTs: bar.ts, pnlPct: (tp - entry) / entry, mfe, mae, holdBars: i - entryIdx };
    } else {
      const excursionUp = (entry - bar.l) / entry;
      const excursionDn = (bar.h - entry) / entry;
      if (excursionUp > mfe) mfe = excursionUp;
      if (excursionDn > mae) mae = excursionDn;

      if (bar.h >= sl) return { outcome: "LOSS", exitPrice: sl, exitIdx: i, exitTs: bar.ts, pnlPct: (entry - sl) / entry, mfe, mae, holdBars: i - entryIdx };
      if (bar.l <= tp) return { outcome: "WIN", exitPrice: tp, exitIdx: i, exitTs: bar.ts, pnlPct: (entry - tp) / entry, mfe, mae, holdBars: i - entryIdx };
    }
  }

  // Timeout: close at last bar's close
  const lastBar = bars15m[Math.min(bars15m.length - 1, entryIdx + maxBars - 1)];
  const pnl = direction === "LONG" ? (lastBar.c - entry) / entry : (entry - lastBar.c) / entry;
  return { outcome: "TIMEOUT", exitPrice: lastBar.c, exitIdx: entryIdx + maxBars, exitTs: lastBar.ts, pnlPct: pnl, mfe, mae, holdBars: maxBars };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  Liquidity Sweep + FVG Entry — Backtest                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Target R:R = ${TARGET_RR}:1 | Max hold = ${MAX_HOLD_4H_BARS} 4H bars | Days = ${DAYS}`);
  console.log();

  // Get ticker universe
  let tickers;
  if (TICKER_LIST) {
    tickers = TICKER_LIST.split(",").map(t => t.trim().toUpperCase());
  } else {
    console.log("Fetching ticker universe...");
    const allData = await fetchJson(`${API_BASE}/timed/all`);
    tickers = Object.keys(allData.data || {}).filter(t => !["VIX", "ES", "NQ", "BTCUSD", "ETHUSD"].includes(t));
    console.log(`  ${tickers.length} tickers in universe`);
  }

  const allTrades = [];
  let processed = 0;
  const errors = [];

  for (const ticker of tickers) {
    processed++;
    process.stdout.write(`\r  [${processed}/${tickers.length}] ${ticker.padEnd(6)}...`);

    try {
      // Fetch 4H and 15m candles
      const [res4h, res15m] = await Promise.all([
        fetchJson(`${API_BASE}/timed/candles?ticker=${ticker}&tf=240&limit=2000`),
        fetchJson(`${API_BASE}/timed/candles?ticker=${ticker}&tf=15&limit=5000`),
      ]);

      const bars4h = (res4h.candles || []).map(c => ({ ts: c.ts, o: +c.o, h: +c.h, l: +c.l, c: +c.c }));
      const bars15m = (res15m.candles || []).map(c => ({ ts: c.ts, o: +c.o, h: +c.h, l: +c.l, c: +c.c }));

      // Filter to requested days
      const cutoff = Date.now() - DAYS * 86400000;
      const filtered4h = bars4h.filter(b => b.ts >= cutoff);
      const filtered15m = bars15m.filter(b => b.ts >= cutoff);

      if (filtered4h.length < 60 || filtered15m.length < 200) continue;

      const trades = backtestTicker(ticker, filtered4h, filtered15m);
      allTrades.push(...trades);

      if (VERBOSE && trades.length > 0) {
        console.log(`  ${ticker}: ${trades.length} trades (${trades.filter(t => t.outcome === "WIN").length}W / ${trades.filter(t => t.outcome === "LOSS").length}L)`);
      }
    } catch (e) {
      errors.push(`${ticker}: ${e.message}`);
    }

    // Rate limit courtesy
    if (processed % 5 === 0) await sleep(500);
  }

  console.log("\r" + " ".repeat(60));

  // ─── Results ─────────────────────────────────────────────────────────────

  if (allTrades.length === 0) {
    console.log("\n  No trades found. The strategy may need parameter tuning.\n");
    return;
  }

  const wins = allTrades.filter(t => t.outcome === "WIN");
  const losses = allTrades.filter(t => t.outcome === "LOSS");
  const timeouts = allTrades.filter(t => t.outcome === "TIMEOUT");
  const longs = allTrades.filter(t => t.direction === "LONG");
  const shorts = allTrades.filter(t => t.direction === "SHORT");

  const winRate = wins.length / allTrades.length;
  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const expectancy = winRate * avgWinPct + (1 - winRate) * avgLossPct;
  const avgHoldBars = allTrades.reduce((s, t) => s + t.holdBars, 0) / allTrades.length;
  const avgMFE = allTrades.reduce((s, t) => s + t.mfe, 0) / allTrades.length;
  const avgMAE = allTrades.reduce((s, t) => s + t.mae, 0) / allTrades.length;

  const longWinRate = longs.length > 0 ? longs.filter(t => t.outcome === "WIN").length / longs.length : 0;
  const shortWinRate = shorts.length > 0 ? shorts.filter(t => t.outcome === "WIN").length / shorts.length : 0;

  // Per-ticker breakdown
  const byTicker = {};
  for (const t of allTrades) {
    if (!byTicker[t.ticker]) byTicker[t.ticker] = { wins: 0, losses: 0, timeouts: 0, total: 0, pnl: 0 };
    byTicker[t.ticker].total++;
    byTicker[t.ticker].pnl += t.pnlPct;
    if (t.outcome === "WIN") byTicker[t.ticker].wins++;
    else if (t.outcome === "LOSS") byTicker[t.ticker].losses++;
    else byTicker[t.ticker].timeouts++;
  }

  console.log("┌──────────────────────────────────────────────────────────────┐");
  console.log("│  RESULTS SUMMARY                                             │");
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`│  Total trades:      ${String(allTrades.length).padStart(6)}                                   │`);
  console.log(`│  Wins:              ${String(wins.length).padStart(6)}  (${fmtPct(winRate).padStart(6)})                          │`);
  console.log(`│  Losses:            ${String(losses.length).padStart(6)}  (${fmtPct(losses.length / allTrades.length).padStart(6)})                          │`);
  console.log(`│  Timeouts:          ${String(timeouts.length).padStart(6)}  (${fmtPct(timeouts.length / allTrades.length).padStart(6)})                          │`);
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`│  Win rate:          ${fmtPct(winRate).padStart(6)}                                    │`);
  console.log(`│  Avg win:           ${fmtPct(avgWinPct).padStart(6)}                                    │`);
  console.log(`│  Avg loss:          ${fmtPct(avgLossPct).padStart(6)}                                    │`);
  console.log(`│  Expectancy/trade:  ${fmtPct(expectancy).padStart(6)}                                    │`);
  console.log(`│  Avg MFE:           ${fmtPct(avgMFE).padStart(6)}                                    │`);
  console.log(`│  Avg MAE:           ${fmtPct(avgMAE).padStart(6)}                                    │`);
  console.log(`│  Avg hold (15m):    ${String(Math.round(avgHoldBars)).padStart(6)} bars (~${fmtNum(avgHoldBars / 4, 0)}h)                     │`);
  console.log("├──────────────────────────────────────────────────────────────┤");
  console.log(`│  Long trades:       ${String(longs.length).padStart(6)}  (win ${fmtPct(longWinRate).padStart(6)})                     │`);
  console.log(`│  Short trades:      ${String(shorts.length).padStart(6)}  (win ${fmtPct(shortWinRate).padStart(6)})                     │`);
  console.log("└──────────────────────────────────────────────────────────────┘");

  // Top tickers
  const tickerArr = Object.entries(byTicker)
    .map(([t, s]) => ({ ticker: t, ...s, winRate: s.wins / s.total }))
    .sort((a, b) => b.total - a.total);

  console.log("\n  Top tickers by trade count:");
  console.log("  " + "─".repeat(56));
  console.log(`  ${"Ticker".padEnd(8)} ${"Trades".padStart(6)} ${"Wins".padStart(5)} ${"Loss".padStart(5)} ${"WR%".padStart(6)} ${"Net P&L".padStart(8)}`);
  console.log("  " + "─".repeat(56));
  for (const t of tickerArr.slice(0, 20)) {
    console.log(`  ${t.ticker.padEnd(8)} ${String(t.total).padStart(6)} ${String(t.wins).padStart(5)} ${String(t.losses).padStart(5)} ${fmtPct(t.winRate).padStart(6)} ${fmtPct(t.pnl).padStart(8)}`);
  }

  // Save detailed results
  const outputPath = "data/backtest-liq-sweep-fvg-results.json";
  const fs = await import("fs");
  const output = {
    strategy: "Liquidity Sweep + FVG Entry",
    params: { targetRR: TARGET_RR, maxHold4hBars: MAX_HOLD_4H_BARS, days: DAYS, fvgWindowBars: FVG_WINDOW_BARS },
    summary: {
      totalTrades: allTrades.length,
      wins: wins.length, losses: losses.length, timeouts: timeouts.length,
      winRate, avgWinPct, avgLossPct, expectancy,
      avgMFE, avgMAE, avgHoldBars15m: avgHoldBars,
      longCount: longs.length, longWinRate,
      shortCount: shorts.length, shortWinRate,
    },
    byTicker: tickerArr,
    trades: allTrades.map(t => ({
      ticker: t.ticker, direction: t.direction, outcome: t.outcome,
      pnlPct: +t.pnlPct.toFixed(4), mfe: +t.mfe.toFixed(4), mae: +t.mae.toFixed(4),
      holdBars: t.holdBars, sweepLevel: t.sweepLevel, entry: t.fvgMid,
      sl: t.sl, tp: t.tp, sweepTs: t.sweepTs, exitTs: t.exitTs,
    })),
    errors,
    ranAt: new Date().toISOString(),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n  Full results saved to ${outputPath}`);

  if (errors.length > 0) {
    console.log(`\n  ${errors.length} ticker errors (use --verbose for details)`);
    if (VERBOSE) errors.forEach(e => console.log(`    ${e}`));
  }
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
