#!/usr/bin/env node
/**
 * Quick trade outcome analysis from the current replay data.
 * TIMED_API_KEY=AwesomeSauce node scripts/quick-trade-analysis.js
 */
const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const fs = require("fs");

async function main() {
  // 1. Get all trades
  const resp = await fetch(`${API_BASE}/timed/trades?key=${API_KEY}`);
  const { trades } = await resp.json();
  console.log(`\nLoaded ${trades.length} trades\n`);

  // Helper: parse timestamp
  const parseTs = (v) => {
    if (!v) return null;
    const n = typeof v === "number" ? v : new Date(v).getTime();
    return Number.isFinite(n) && n > 0 ? (n < 1e12 ? n * 1000 : n) : null;
  };

  // 2. Enrich each trade
  const enriched = trades.map(t => {
    const entryTs = parseTs(t.entryTime || t.entry_ts);
    const exitTs = parseTs(t.exitTime || t.exit_ts || t.lastUpdate);
    const holdMin = (entryTs && exitTs && exitTs > entryTs) ? (exitTs - entryTs) / 60000 : null;
    const pnl = Number(t.pnlPct || 0);
    const isWin = t.status === "WIN" || t.status === "TP_HIT_TRIM";
    const isLoss = t.status === "LOSS";
    const isClosed = isWin || isLoss;
    return {
      ticker: t.ticker,
      direction: t.direction,
      status: t.status,
      entryPath: t.entryPath || t.entry_path || "unknown",
      exitReason: t.exitReason || t.exit_reason || (isClosed ? "unknown" : null),
      entryPrice: Number(t.entryPrice || t.entry_price || 0),
      exitPrice: Number(t.exitPrice || t.exit_price || 0),
      sl: Number(t.sl || 0),
      tp: Number(t.tp || 0),
      pnlPct: pnl,
      holdMin: holdMin ? Math.round(holdMin) : null,
      isWin, isLoss, isClosed,
      state: t.state,
      htf: Number(t.htf_score || 0),
      ltf: Number(t.ltf_score || 0),
      rank: Number(t.rank || 0),
      rr: Number(t.rr || 0),
      trimmedPct: Number(t.trimmedPct || 0),
      history: Array.isArray(t.history) ? t.history : [],
    };
  });

  const closed = enriched.filter(t => t.isClosed);
  const winners = enriched.filter(t => t.isWin);
  const losers = enriched.filter(t => t.isLoss);

  // 3. Core metrics
  const stats = (arr, fn) => {
    const vals = arr.map(fn).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) return { count: 0 };
    return {
      count: vals.length,
      mean: +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3),
      median: vals[Math.floor(vals.length / 2)],
      p10: vals[Math.floor(vals.length * 0.1)],
      p25: vals[Math.floor(vals.length * 0.25)],
      p75: vals[Math.floor(vals.length * 0.75)],
      p90: vals[Math.floor(vals.length * 0.9)],
    };
  };

  const result = {
    overview: {
      total: trades.length,
      closed: closed.length,
      wins: winners.length,
      losses: losers.length,
      open: enriched.filter(t => !t.isClosed).length,
      winRate: closed.length > 0 ? +(winners.length / closed.length * 100).toFixed(1) : 0,
    },
    pnl: {
      all: stats(closed, t => t.pnlPct),
      winners: stats(winners, t => t.pnlPct),
      losers: stats(losers, t => t.pnlPct),
      profitFactor: (() => {
        const totalWin = winners.reduce((s, t) => s + Math.max(0, t.pnlPct), 0);
        const totalLoss = Math.abs(losers.reduce((s, t) => s + Math.min(0, t.pnlPct), 0));
        return totalLoss > 0 ? +(totalWin / totalLoss).toFixed(2) : null;
      })(),
    },
    holdTime: {
      winners: stats(winners, t => t.holdMin),
      losers: stats(losers, t => t.holdMin),
    },
    direction: {
      LONG: (() => {
        const lt = closed.filter(t => t.direction === "LONG");
        const lw = lt.filter(t => t.isWin);
        return { total: lt.length, wins: lw.length, losses: lt.length - lw.length, winRate: lt.length > 0 ? +(lw.length / lt.length * 100).toFixed(1) : 0, avgPnl: stats(lt, t => t.pnlPct).mean };
      })(),
      SHORT: (() => {
        const st = closed.filter(t => t.direction === "SHORT");
        const sw = st.filter(t => t.isWin);
        return { total: st.length, wins: sw.length, losses: st.length - sw.length, winRate: st.length > 0 ? +(sw.length / st.length * 100).toFixed(1) : 0, avgPnl: stats(st, t => t.pnlPct).mean };
      })(),
    },
    exitReasons: (() => {
      const map = {};
      for (const t of closed) {
        const r = t.exitReason || "unknown";
        if (!map[r]) map[r] = { count: 0, wins: 0, losses: 0, avgPnl: 0, pnls: [] };
        map[r].count++;
        if (t.isWin) map[r].wins++;
        if (t.isLoss) map[r].losses++;
        map[r].pnls.push(t.pnlPct);
      }
      for (const [k, v] of Object.entries(map)) {
        v.avgPnl = +(v.pnls.reduce((s, p) => s + p, 0) / v.pnls.length).toFixed(3);
        v.winRate = +(v.wins / v.count * 100).toFixed(1);
        delete v.pnls;
      }
      return Object.fromEntries(Object.entries(map).sort((a, b) => b[1].count - a[1].count));
    })(),
    slAnalysis: {
      slDistancePct: stats(enriched.filter(t => t.sl > 0 && t.entryPrice > 0), t => Math.abs(t.entryPrice - t.sl) / t.entryPrice * 100),
      winnersSlDistance: stats(winners.filter(t => t.sl > 0 && t.entryPrice > 0), t => Math.abs(t.entryPrice - t.sl) / t.entryPrice * 100),
      losersSlDistance: stats(losers.filter(t => t.sl > 0 && t.entryPrice > 0), t => Math.abs(t.entryPrice - t.sl) / t.entryPrice * 100),
    },
    tradeHistory: (() => {
      // Analyze the event history of each trade for patterns
      const patterns = { quickExits: 0, trimThenExit: 0, multipleTrims: 0, slTightens: 0, noEvents: 0 };
      for (const t of closed) {
        if (!t.history.length) { patterns.noEvents++; continue; }
        const types = t.history.map(e => e.type);
        if (t.holdMin != null && t.holdMin < 15) patterns.quickExits++;
        if (types.includes("TRIM") && types.includes("EXIT")) patterns.trimThenExit++;
        if (types.filter(t => t === "TRIM").length > 1) patterns.multipleTrims++;
        if (types.includes("SL_TIGHTEN")) patterns.slTightens++;
      }
      return patterns;
    })(),
    perTicker: (() => {
      const map = {};
      for (const t of enriched) {
        if (!map[t.ticker]) map[t.ticker] = { trades: 0, wins: 0, losses: 0, pnls: [], directions: new Set() };
        map[t.ticker].trades++;
        if (t.isWin) map[t.ticker].wins++;
        if (t.isLoss) map[t.ticker].losses++;
        map[t.ticker].pnls.push(t.pnlPct);
        map[t.ticker].directions.add(t.direction);
      }
      return Object.fromEntries(
        Object.entries(map)
          .map(([k, v]) => [k, {
            trades: v.trades, wins: v.wins, losses: v.losses,
            netPnl: +(v.pnls.reduce((s, p) => s + p, 0)).toFixed(3),
            winRate: v.trades > 0 ? +((v.wins / Math.max(1, v.wins + v.losses)) * 100).toFixed(1) : 0,
            directions: [...v.directions],
          }])
          .sort((a, b) => b[1].netPnl - a[1].netPnl)
      );
    })(),
  };

  // 4. Print report
  const ln = "═".repeat(70);
  console.log(ln);
  console.log("  SIGNAL-TO-OUTCOME ANALYSIS");
  console.log(ln);
  
  console.log(`\n  OVERVIEW`);
  console.log(`  Total: ${result.overview.total} | Closed: ${result.overview.closed} | Open: ${result.overview.open}`);
  console.log(`  Wins: ${result.overview.wins} | Losses: ${result.overview.losses} | Win Rate: ${result.overview.winRate}%`);
  console.log(`  Profit Factor: ${result.pnl.profitFactor}`);
  
  console.log(`\n  P&L DISTRIBUTION`);
  console.log(`  Winners: mean=${result.pnl.winners.mean}% median=${result.pnl.winners.median}% p75=${result.pnl.winners.p75}%`);
  console.log(`  Losers:  mean=${result.pnl.losers.mean}% median=${result.pnl.losers.median}% p25=${result.pnl.losers.p25}%`);
  
  console.log(`\n  HOLD TIME (minutes)`);
  console.log(`  Winners: mean=${result.holdTime.winners.mean} median=${result.holdTime.winners.median} p25=${result.holdTime.winners.p25} p75=${result.holdTime.winners.p75}`);
  console.log(`  Losers:  mean=${result.holdTime.losers.mean} median=${result.holdTime.losers.median} p25=${result.holdTime.losers.p25} p75=${result.holdTime.losers.p75}`);
  
  console.log(`\n  DIRECTION`);
  console.log(`  LONG:  ${result.direction.LONG.total} trades, WR=${result.direction.LONG.winRate}%, avgPnl=${result.direction.LONG.avgPnl}%`);
  console.log(`  SHORT: ${result.direction.SHORT.total} trades, WR=${result.direction.SHORT.winRate}%, avgPnl=${result.direction.SHORT.avgPnl}%`);
  
  console.log(`\n  EXIT REASONS (top 8)`);
  for (const [reason, data] of Object.entries(result.exitReasons).slice(0, 8)) {
    const bar = "█".repeat(Math.min(30, Math.round(data.count / 2)));
    console.log(`  ${reason.padEnd(35)} ${String(data.count).padStart(3)} exits | WR=${String(data.winRate + "%").padStart(6)} | avgPnl=${data.avgPnl}%`);
  }
  
  console.log(`\n  SL DISTANCE AT ENTRY`);
  console.log(`  All:     mean=${result.slAnalysis.slDistancePct.mean}% median=${result.slAnalysis.slDistancePct.median}%`);
  console.log(`  Winners: mean=${result.slAnalysis.winnersSlDistance.mean}% median=${result.slAnalysis.winnersSlDistance.median}%`);
  console.log(`  Losers:  mean=${result.slAnalysis.losersSlDistance.mean}% median=${result.slAnalysis.losersSlDistance.median}%`);
  
  console.log(`\n  TRADE PATTERNS`);
  console.log(`  Quick exits (<15min): ${result.tradeHistory.quickExits}`);
  console.log(`  Trim then exit: ${result.tradeHistory.trimThenExit}`);
  console.log(`  SL tightens: ${result.tradeHistory.slTightens}`);
  
  console.log(`\n  TOP 5 TICKERS (by net P&L)`);
  const tickers = Object.entries(result.perTicker);
  for (const [t, d] of tickers.slice(0, 5)) {
    console.log(`  ${t.padEnd(6)} ${d.trades} trades | net ${d.netPnl > 0 ? "+" : ""}${d.netPnl}% | WR=${d.winRate}% | ${d.directions.join("/")}`);
  }
  console.log(`  WORST 5:`);
  for (const [t, d] of tickers.slice(-5)) {
    console.log(`  ${t.padEnd(6)} ${d.trades} trades | net ${d.netPnl > 0 ? "+" : ""}${d.netPnl}% | WR=${d.winRate}% | ${d.directions.join("/")}`);
  }
  
  console.log(`\n${ln}`);
  console.log("  KEY FINDINGS & RECOMMENDATIONS");
  console.log(ln);
  
  // Recommendations based on data
  const recs = [];
  
  // 1. Win rate
  if (result.overview.winRate < 40) {
    recs.push(`[CRITICAL] Win rate ${result.overview.winRate}% is below 40%. Exits are too aggressive.`);
  }
  
  // 2. Quick exits
  if (result.tradeHistory.quickExits > closed.length * 0.3) {
    recs.push(`[CRITICAL] ${result.tradeHistory.quickExits}/${closed.length} trades exit in <15min. Min hold period too short or SL too tight.`);
  }
  
  // 3. Loss > Win size
  if (Math.abs(result.pnl.losers.mean) > result.pnl.winners.mean) {
    recs.push(`[HIGH] Avg loss (${result.pnl.losers.mean}%) larger than avg win (${result.pnl.winners.mean}%). SL needs widening or trim needs to happen sooner.`);
  }
  
  // 4. Hold time asymmetry  
  if (result.holdTime.losers.median && result.holdTime.winners.median && result.holdTime.losers.median < 20) {
    recs.push(`[HIGH] Losers exit in ${result.holdTime.losers.median}min median. Increase minimum exit hold to 25-30min.`);
  }
  
  // 5. SL distance
  if (result.slAnalysis.losersSlDistance.median && result.slAnalysis.losersSlDistance.median < 1.0) {
    recs.push(`[HIGH] Loser SL distance median is ${result.slAnalysis.losersSlDistance.median}% — too tight. Widen to 1.5-2.0%.`);
  }
  
  // 6. Exit reason clustering
  const topLossReason = Object.entries(result.exitReasons).filter(([_, d]) => d.losses > d.wins).sort((a, b) => b[1].losses - a[1].losses)[0];
  if (topLossReason) {
    recs.push(`[HIGH] Exit reason "${topLossReason[0]}" causes ${topLossReason[1].losses} losses vs ${topLossReason[1].wins} wins. Loosen this exit trigger.`);
  }
  
  // 7. Direction imbalance
  if (Math.abs(result.direction.LONG.winRate - result.direction.SHORT.winRate) > 15) {
    const weaker = result.direction.LONG.winRate < result.direction.SHORT.winRate ? "LONG" : "SHORT";
    recs.push(`[MEDIUM] ${weaker} trades have lower win rate. Tighten ${weaker} entry criteria.`);
  }
  
  // 8. Profit factor
  if (result.pnl.profitFactor != null && result.pnl.profitFactor < 1.0) {
    recs.push(`[CRITICAL] Profit factor ${result.pnl.profitFactor} < 1.0 — system is net negative. Must fix SL/exit logic.`);
  }
  
  for (const r of recs) console.log(`\n  ${r}`);
  
  // Specific tuning recommendations
  console.log(`\n\n  SPECIFIC TUNING VALUES:`);
  console.log(`  ─────────────────────────`);
  
  const wMedianHold = result.holdTime.winners.median;
  const lMedianHold = result.holdTime.losers.median;
  const wSLDist = result.slAnalysis.winnersSlDistance.median || result.slAnalysis.slDistancePct.median;
  const lSLDist = result.slAnalysis.losersSlDistance.median || result.slAnalysis.slDistancePct.median;
  
  console.log(`  MIN_HOLD_BEFORE_EXIT: ${Math.max(20, Math.round((wMedianHold || 30) * 0.4))} min (was 15min)`);
  console.log(`  SL_DISTANCE_MIN: ${Math.max(1.0, +(wSLDist * 1.2).toFixed(1))}% (winners need ${wSLDist}%)`);
  console.log(`  BELOW_TRIGGER_THRESHOLD: ${Math.max(1.5, +(wSLDist * 0.8).toFixed(1))}% (was 1.0%)`);
  console.log(`  MAX_LOSS_PCT: -${Math.max(4, Math.min(8, Math.abs(result.pnl.losers.p10 || 5)))}% (p10 of losers)`);
  console.log(`  TRIM_THRESHOLD_PCT: +${Math.max(0.5, +(result.pnl.winners.p25 || 0.3)).toFixed(1)}% (p25 of winners)`);
  
  console.log(`\n${ln}\n`);
  
  // Save full analysis
  fs.writeFileSync(
    "/Users/shashant/timedtrading/docs/SIGNAL_OUTCOME_ANALYSIS.json",
    JSON.stringify(result, null, 2)
  );
  console.log("Full analysis saved to docs/SIGNAL_OUTCOME_ANALYSIS.json\n");
}

main().catch(err => { console.error(err); process.exit(1); });
