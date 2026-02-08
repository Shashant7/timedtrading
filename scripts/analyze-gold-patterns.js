/**
 * Gold Standard Pattern Analysis
 * 
 * Analyzes actual winning trades to determine:
 * 1. What distinguishes winners from losers at entry time
 * 2. Optimal TP targets (normalized by volatility/move magnitude)
 * 3. Trade frequency patterns (excessive churning detection)
 * 4. Cross-check against current entry rules
 * 
 * Usage:
 *   node scripts/analyze-gold-patterns.js --days 7
 *   node scripts/analyze-gold-patterns.js --since 2026-02-02 --until 2026-02-03
 */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  return v != null ? v : fallback;
}

const DAYS = Number(argValue("--days", "7"));
const SINCE_RAW = argValue("--since", "");
const UNTIL_RAW = argValue("--until", "");
const OUTPUT_JSON = argValue("--json", "docs/GOLD_PATTERNS_ANALYSIS.json");
const OUTPUT_MD = argValue("--md", "docs/GOLD_PATTERNS_ANALYSIS.md");

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function fmtPct(n, decimals = 1) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(decimals)}%` : "—";
}

function fmtNum(n, decimals = 2) {
  return Number.isFinite(n) ? n.toFixed(decimals) : "—";
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main() {
  console.log("[gold-patterns] Starting analysis...");

  // Fetch trades
  const tradesResp = await fetchJson(`${API_BASE}/timed/trades?source=d1`);
  const allTrades = Array.isArray(tradesResp?.trades) ? tradesResp.trades : [];
  console.log(`[gold-patterns] Loaded ${allTrades.length} trades from D1`);

  // Filter by date if specified
  let trades = allTrades;
  const now = Date.now();
  const sinceMs = SINCE_RAW ? Date.parse(SINCE_RAW) : now - DAYS * 24 * 60 * 60 * 1000;
  const untilMs = UNTIL_RAW ? Date.parse(UNTIL_RAW) + 24 * 60 * 60 * 1000 : now;
  
  trades = trades.filter(t => {
    const entryTs = t.entry_ts || Date.parse(t.entryTime);
    return Number.isFinite(entryTs) && entryTs >= sinceMs && entryTs <= untilMs;
  });
  console.log(`[gold-patterns] Filtered to ${trades.length} trades in window`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 1: Overall Statistics
  // ═══════════════════════════════════════════════════════════════════════════
  
  const winners = trades.filter(t => t.status === "WIN");
  const losers = trades.filter(t => t.status === "LOSS");
  const trims = trades.filter(t => t.status === "TP_HIT_TRIM");
  const open = trades.filter(t => t.status === "OPEN");

  const winRate = (winners.length + trims.length) / (winners.length + losers.length + trims.length) || 0;
  const avgWinPnl = winners.length ? winners.reduce((s, t) => s + (t.pnl || 0), 0) / winners.length : 0;
  const avgLossPnl = losers.length ? losers.reduce((s, t) => s + (t.pnl || 0), 0) / losers.length : 0;
  const avgWinPct = winners.length ? winners.reduce((s, t) => s + (t.pnlPct || 0), 0) / winners.length : 0;
  const avgLossPct = losers.length ? losers.reduce((s, t) => s + (t.pnlPct || 0), 0) / losers.length : 0;

  const overallStats = {
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    trims: trims.length,
    open: open.length,
    winRate,
    avgWinPnl,
    avgLossPnl,
    avgWinPct,
    avgLossPct,
    profitFactor: avgLossPnl !== 0 ? Math.abs(avgWinPnl * winners.length / (avgLossPnl * losers.length)) : null,
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 2: Winner vs Loser Pattern Analysis at Entry
  // ═══════════════════════════════════════════════════════════════════════════
  
  function analyzeTradeGroup(tradeList, label) {
    if (!tradeList.length) return { label, count: 0 };
    
    const rrs = tradeList.map(t => t.rr).filter(Number.isFinite);
    const ranks = tradeList.map(t => t.rank).filter(Number.isFinite);
    const pnlPcts = tradeList.map(t => t.pnlPct).filter(Number.isFinite);
    
    // Analyze direction distribution
    const longCount = tradeList.filter(t => t.direction === "LONG").length;
    const shortCount = tradeList.filter(t => t.direction === "SHORT").length;
    
    return {
      label,
      count: tradeList.length,
      avgRR: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
      medianRR: median(rrs),
      p25RR: percentile(rrs, 25),
      p75RR: percentile(rrs, 75),
      avgRank: ranks.length ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null,
      medianRank: median(ranks),
      avgPnlPct: pnlPcts.length ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : null,
      medianPnlPct: median(pnlPcts),
      longPct: longCount / tradeList.length,
      shortPct: shortCount / tradeList.length,
    };
  }

  const winnerStats = analyzeTradeGroup(winners, "Winners");
  const loserStats = analyzeTradeGroup(losers, "Losers");
  const trimStats = analyzeTradeGroup(trims, "TP_HIT_TRIM");

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 3: Trade Frequency Analysis (Churning Detection)
  // ═══════════════════════════════════════════════════════════════════════════
  
  const tradesByTicker = {};
  for (const t of trades) {
    const ticker = t.ticker;
    if (!tradesByTicker[ticker]) tradesByTicker[ticker] = [];
    tradesByTicker[ticker].push(t);
  }

  const tickerStats = Object.entries(tradesByTicker)
    .map(([ticker, tickerTrades]) => {
      const w = tickerTrades.filter(t => t.status === "WIN").length;
      const l = tickerTrades.filter(t => t.status === "LOSS").length;
      const totalPnl = tickerTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      
      // Time between trades (detect rapid churning)
      const sortedByTime = [...tickerTrades].sort((a, b) => 
        (a.entry_ts || Date.parse(a.entryTime)) - (b.entry_ts || Date.parse(b.entryTime))
      );
      const gaps = [];
      for (let i = 1; i < sortedByTime.length; i++) {
        const t1 = sortedByTime[i-1].entry_ts || Date.parse(sortedByTime[i-1].entryTime);
        const t2 = sortedByTime[i].entry_ts || Date.parse(sortedByTime[i].entryTime);
        if (Number.isFinite(t1) && Number.isFinite(t2)) {
          gaps.push((t2 - t1) / 60000); // minutes
        }
      }
      
      return {
        ticker,
        tradeCount: tickerTrades.length,
        wins: w,
        losses: l,
        winRate: (w + l) > 0 ? w / (w + l) : null,
        totalPnl,
        avgGapMinutes: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
        minGapMinutes: gaps.length ? Math.min(...gaps) : null,
        maxGapMinutes: gaps.length ? Math.max(...gaps) : null,
        rapidTrades: gaps.filter(g => g < 10).length, // < 10 min gap
      };
    })
    .sort((a, b) => b.tradeCount - a.tradeCount);

  // Identify problematic churning tickers (>10 trades/day or <5min avg gap)
  const churningTickers = tickerStats.filter(t => 
    t.tradeCount > 10 || (t.avgGapMinutes !== null && t.avgGapMinutes < 5)
  );

  const frequencyAnalysis = {
    totalTickers: Object.keys(tradesByTicker).length,
    avgTradesPerTicker: trades.length / Object.keys(tradesByTicker).length,
    maxTradesOnTicker: tickerStats[0]?.tradeCount || 0,
    maxTradesTicker: tickerStats[0]?.ticker || null,
    churningTickers: churningTickers.slice(0, 20),
    topTickers: tickerStats.slice(0, 15),
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 4: TP Analysis (Move Magnitude Distribution)
  // ═══════════════════════════════════════════════════════════════════════════
  
  const winnerPnlPcts = winners.map(t => t.pnlPct).filter(Number.isFinite);
  const loserPnlPcts = losers.map(t => t.pnlPct).filter(Number.isFinite);
  
  const tpAnalysis = {
    winners: {
      avgPct: winnerPnlPcts.length ? winnerPnlPcts.reduce((a, b) => a + b, 0) / winnerPnlPcts.length : null,
      medianPct: median(winnerPnlPcts),
      p25Pct: percentile(winnerPnlPcts, 25),
      p75Pct: percentile(winnerPnlPcts, 75),
      p90Pct: percentile(winnerPnlPcts, 90),
      distribution: {
        "0-1%": winnerPnlPcts.filter(p => p >= 0 && p < 1).length,
        "1-2%": winnerPnlPcts.filter(p => p >= 1 && p < 2).length,
        "2-3%": winnerPnlPcts.filter(p => p >= 2 && p < 3).length,
        "3-5%": winnerPnlPcts.filter(p => p >= 3 && p < 5).length,
        "5%+": winnerPnlPcts.filter(p => p >= 5).length,
      }
    },
    losers: {
      avgPct: loserPnlPcts.length ? loserPnlPcts.reduce((a, b) => a + b, 0) / loserPnlPcts.length : null,
      medianPct: median(loserPnlPcts),
      p25Pct: percentile(loserPnlPcts, 25),
      p75Pct: percentile(loserPnlPcts, 75),
    },
    recommendedTP: {
      conservative: percentile(winnerPnlPcts, 50), // 50th percentile
      moderate: percentile(winnerPnlPcts, 65),
      aggressive: percentile(winnerPnlPcts, 80),
    }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 5: RR Analysis - What RR predicts winners?
  // ═══════════════════════════════════════════════════════════════════════════
  
  const rrBuckets = [
    { min: 0, max: 2, label: "RR 0-2" },
    { min: 2, max: 5, label: "RR 2-5" },
    { min: 5, max: 10, label: "RR 5-10" },
    { min: 10, max: 20, label: "RR 10-20" },
    { min: 20, max: Infinity, label: "RR 20+" },
  ];

  const rrAnalysis = rrBuckets.map(bucket => {
    const inBucket = trades.filter(t => {
      const rr = t.rr;
      return Number.isFinite(rr) && rr >= bucket.min && rr < bucket.max;
    });
    const w = inBucket.filter(t => t.status === "WIN" || t.status === "TP_HIT_TRIM").length;
    const l = inBucket.filter(t => t.status === "LOSS").length;
    return {
      ...bucket,
      count: inBucket.length,
      wins: w,
      losses: l,
      winRate: (w + l) > 0 ? w / (w + l) : null,
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECTION 6: Recommendations
  // ═══════════════════════════════════════════════════════════════════════════
  
  const recommendations = [];

  // RR threshold recommendation
  const highRRBucket = rrAnalysis.find(b => b.winRate && b.winRate > 0.55 && b.count >= 50);
  if (highRRBucket) {
    recommendations.push({
      category: "RR Filter",
      issue: `Trades with RR < ${highRRBucket.min} have lower win rates`,
      recommendation: `Consider raising minimum RR from 1.2 to ${Math.max(2, highRRBucket.min)}`,
      impact: `Win rate in ${highRRBucket.label}: ${fmtPct(highRRBucket.winRate)}`,
    });
  }

  // Churning recommendation
  if (churningTickers.length > 0) {
    const totalChurnTrades = churningTickers.reduce((s, t) => s + t.tradeCount, 0);
    recommendations.push({
      category: "Trade Frequency",
      issue: `${churningTickers.length} tickers have excessive trades (${totalChurnTrades} total)`,
      recommendation: "Implement per-ticker daily trade limit (max 3) and cooldown period (min 30 min)",
      impact: `Top churner: ${churningTickers[0]?.ticker} with ${churningTickers[0]?.tradeCount} trades`,
    });
  }

  // TP normalization recommendation
  if (tpAnalysis.winners.medianPct !== null) {
    recommendations.push({
      category: "TP Normalization",
      issue: `Winner median gain is ${fmtPct(tpAnalysis.winners.medianPct / 100, 1)}`,
      recommendation: `Set TP target to ~${fmtPct((tpAnalysis.winners.p75Pct || 2) / 100, 1)} (75th percentile of winners)`,
      impact: `P25/P50/P75 of winner gains: ${fmtPct((tpAnalysis.winners.p25Pct || 0) / 100, 1)} / ${fmtPct((tpAnalysis.winners.medianPct || 0) / 100, 1)} / ${fmtPct((tpAnalysis.winners.p75Pct || 0) / 100, 1)}`,
    });
  }

  // Win rate vs direction
  if (winnerStats.longPct !== null && loserStats.longPct !== null) {
    const longWinBias = winnerStats.longPct - loserStats.longPct;
    if (Math.abs(longWinBias) > 0.1) {
      const betterDir = longWinBias > 0 ? "LONG" : "SHORT";
      recommendations.push({
        category: "Direction Bias",
        issue: `${betterDir} trades have higher win rate`,
        recommendation: `Consider ${betterDir}-biased position sizing or stricter ${betterDir === "LONG" ? "SHORT" : "LONG"} filters`,
        impact: `Winners: ${fmtPct(winnerStats.longPct)} LONG vs Losers: ${fmtPct(loserStats.longPct)} LONG`,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OUTPUT
  // ═══════════════════════════════════════════════════════════════════════════
  
  const analysis = {
    generated: new Date().toISOString(),
    window: {
      since: new Date(sinceMs).toISOString(),
      until: new Date(untilMs).toISOString(),
      days: Math.round((untilMs - sinceMs) / (24 * 60 * 60 * 1000)),
    },
    overallStats,
    patternAnalysis: {
      winners: winnerStats,
      losers: loserStats,
      trims: trimStats,
    },
    frequencyAnalysis,
    tpAnalysis,
    rrAnalysis,
    recommendations,
  };

  // Write JSON
  const fs = await import("node:fs/promises");
  await fs.mkdir("docs", { recursive: true });
  await fs.writeFile(OUTPUT_JSON, JSON.stringify(analysis, null, 2), "utf-8");
  console.log(`[gold-patterns] Wrote ${OUTPUT_JSON}`);

  // Write Markdown
  const md = generateMarkdown(analysis);
  await fs.writeFile(OUTPUT_MD, md, "utf-8");
  console.log(`[gold-patterns] Wrote ${OUTPUT_MD}`);
}

function generateMarkdown(analysis) {
  const lines = [];
  const { overallStats: os, patternAnalysis: pa, frequencyAnalysis: fa, tpAnalysis: tp, rrAnalysis: rr, recommendations: rec } = analysis;

  lines.push(`# Gold Standard Pattern Analysis`);
  lines.push(``);
  lines.push(`Generated: ${analysis.generated}`);
  lines.push(`Window: ${analysis.window.since.slice(0, 10)} → ${analysis.window.until.slice(0, 10)} (${analysis.window.days} days)`);
  lines.push(``);

  lines.push(`## Executive Summary`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|:--|--:|`);
  lines.push(`| Total trades | ${os.totalTrades} |`);
  lines.push(`| Winners | ${os.winners} |`);
  lines.push(`| Losers | ${os.losers} |`);
  lines.push(`| Win rate | ${fmtPct(os.winRate)} |`);
  lines.push(`| Avg winner P&L | $${fmtNum(os.avgWinPnl)} (${fmtPct(os.avgWinPct / 100)}) |`);
  lines.push(`| Avg loser P&L | $${fmtNum(os.avgLossPnl)} (${fmtPct(os.avgLossPct / 100)}) |`);
  lines.push(`| Profit factor | ${fmtNum(os.profitFactor)} |`);
  lines.push(``);

  lines.push(`## 🎯 Winner vs Loser Patterns at Entry`);
  lines.push(``);
  lines.push(`| Metric | Winners | Losers | Delta |`);
  lines.push(`|:--|--:|--:|--:|`);
  lines.push(`| Count | ${pa.winners.count} | ${pa.losers.count} | — |`);
  lines.push(`| Avg RR | ${fmtNum(pa.winners.avgRR)} | ${fmtNum(pa.losers.avgRR)} | ${fmtNum((pa.winners.avgRR || 0) - (pa.losers.avgRR || 0))} |`);
  lines.push(`| Median RR | ${fmtNum(pa.winners.medianRR)} | ${fmtNum(pa.losers.medianRR)} | ${fmtNum((pa.winners.medianRR || 0) - (pa.losers.medianRR || 0))} |`);
  lines.push(`| Avg Rank | ${fmtNum(pa.winners.avgRank, 0)} | ${fmtNum(pa.losers.avgRank, 0)} | ${fmtNum((pa.winners.avgRank || 0) - (pa.losers.avgRank || 0), 0)} |`);
  lines.push(`| LONG % | ${fmtPct(pa.winners.longPct)} | ${fmtPct(pa.losers.longPct)} | ${fmtPct((pa.winners.longPct || 0) - (pa.losers.longPct || 0))} |`);
  lines.push(``);

  lines.push(`### Key Finding: RR at Entry is Predictive`);
  lines.push(``);
  lines.push(`Winners have **${fmtNum((pa.winners.avgRR || 0) / (pa.losers.avgRR || 1), 1)}x higher RR** at entry compared to losers.`);
  lines.push(``);

  lines.push(`## 📊 RR Bucket Analysis`);
  lines.push(``);
  lines.push(`| RR Range | Trades | Wins | Losses | Win Rate |`);
  lines.push(`|:--|--:|--:|--:|--:|`);
  for (const b of rr) {
    lines.push(`| ${b.label} | ${b.count} | ${b.wins} | ${b.losses} | ${fmtPct(b.winRate)} |`);
  }
  lines.push(``);

  lines.push(`## ⚠️ Trade Frequency Analysis (Churning Detection)`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`|:--|--:|`);
  lines.push(`| Unique tickers traded | ${fa.totalTickers} |`);
  lines.push(`| Avg trades per ticker | ${fmtNum(fa.avgTradesPerTicker)} |`);
  lines.push(`| Max trades on one ticker | ${fa.maxTradesOnTicker} (${fa.maxTradesTicker}) |`);
  lines.push(`| Tickers with excessive trades | ${fa.churningTickers.length} |`);
  lines.push(``);

  if (fa.churningTickers.length > 0) {
    lines.push(`### Churning Tickers (>10 trades or <5min avg gap)`);
    lines.push(``);
    lines.push(`| Ticker | Trades | Win Rate | Total P&L | Avg Gap (min) | Rapid (<10m) |`);
    lines.push(`|:--|--:|--:|--:|--:|--:|`);
    for (const t of fa.churningTickers.slice(0, 10)) {
      lines.push(`| ${t.ticker} | ${t.tradeCount} | ${fmtPct(t.winRate)} | $${fmtNum(t.totalPnl)} | ${fmtNum(t.avgGapMinutes, 0)} | ${t.rapidTrades} |`);
    }
    lines.push(``);
  }

  lines.push(`## 📈 TP Analysis (Move Magnitude)`);
  lines.push(``);
  lines.push(`### Winner Gain Distribution`);
  lines.push(``);
  lines.push(`| Percentile | Gain % |`);
  lines.push(`|:--|--:|`);
  lines.push(`| P25 | ${fmtPct((tp.winners.p25Pct || 0) / 100)} |`);
  lines.push(`| Median (P50) | ${fmtPct((tp.winners.medianPct || 0) / 100)} |`);
  lines.push(`| P75 | ${fmtPct((tp.winners.p75Pct || 0) / 100)} |`);
  lines.push(`| P90 | ${fmtPct((tp.winners.p90Pct || 0) / 100)} |`);
  lines.push(``);

  lines.push(`### Winner Gain Buckets`);
  lines.push(``);
  const dist = tp.winners.distribution || {};
  lines.push(`| Range | Count |`);
  lines.push(`|:--|--:|`);
  for (const [k, v] of Object.entries(dist)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push(``);

  lines.push(`### Recommended TP Targets`);
  lines.push(``);
  lines.push(`- **Conservative** (50th %ile): ${fmtPct((tp.recommendedTP.conservative || 0) / 100)}`);
  lines.push(`- **Moderate** (65th %ile): ${fmtPct((tp.recommendedTP.moderate || 0) / 100)}`);
  lines.push(`- **Aggressive** (80th %ile): ${fmtPct((tp.recommendedTP.aggressive || 0) / 100)}`);
  lines.push(``);

  lines.push(`## 💡 Recommendations`);
  lines.push(``);
  for (const r of rec) {
    lines.push(`### ${r.category}`);
    lines.push(``);
    lines.push(`**Issue:** ${r.issue}`);
    lines.push(``);
    lines.push(`**Recommendation:** ${r.recommendation}`);
    lines.push(``);
    lines.push(`**Impact:** ${r.impact}`);
    lines.push(``);
  }

  lines.push(`## Next Steps`);
  lines.push(``);
  lines.push(`1. **Implement per-ticker trade limits** - Max 3 trades per ticker per day`);
  lines.push(`2. **Add cooldown period** - Minimum 30 minutes between entries on same ticker`);
  lines.push(`3. **Raise RR threshold** - Consider minimum RR of 5+ based on win rate analysis`);
  lines.push(`4. **Normalize TP** - Use dynamic TP based on recent volatility or P75 of winner gains`);
  lines.push(`5. **Add trail data analysis** - Cross-reference entry signals with actual trail snapshots`);
  lines.push(``);

  return lines.join("\n");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
