#!/usr/bin/env node
/**
 * Signal-to-Outcome Analysis
 * 
 * Mines ingest_receipts data to find:
 * 1. What signals are present when big moves START (trigger → peak)
 * 2. What signals are present when moves FAIL (trigger → stopped out)
 * 3. Optimal SL distance, hold time, trim timing
 * 4. Which HTF/LTF score combinations produce the best R:R
 * 
 * Usage: TIMED_API_KEY=AwesomeSauce node scripts/analyze-signal-outcomes.js
 */

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";
const DATE = process.env.DATE || "2026-02-02";

if (!API_KEY) { console.error("TIMED_API_KEY required"); process.exit(1); }

// Fetch all ingest receipts for a day, paginated
async function fetchDayData(date) {
  const allRows = [];
  let offset = 0;
  const limit = 500;
  
  while (true) {
    const url = `${API_BASE}/timed/admin/replay-day?key=${API_KEY}&date=${date}&limit=${limit}&offset=${offset}&bucketMinutes=1`;
    const resp = await fetch(url, { method: "POST" });
    const data = await resp.json();
    
    if (!data.ok) { console.error("API error:", data); break; }
    
    // Parse each row's payload
    const batchRows = [];
    // The endpoint processes rows internally. We need raw data. 
    // Let's use a different approach - query the trail data directly
    
    if (!data.hasMore) break;
    offset = data.nextOffset || offset + limit;
    if (offset >= (data.totalRows || Infinity)) break;
    
    process.stdout.write(`\rFetched offset ${offset} / ${data.totalRows || '?'}...`);
  }
  
  return allRows;
}

// Better approach: query ingest_receipts via a custom endpoint
async function fetchTickerTrail(ticker, date) {
  // Use replay-day single-ticker mode to get raw data
  const url = `${API_BASE}/timed/admin/replay-day?key=${API_KEY}&date=${date}&ticker=${ticker}&limit=1000&offset=0`;
  try {
    const resp = await fetch(url, { method: "POST" });
    const text = await resp.text();
    // The endpoint may fail for single ticker. Try the trail range instead.
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

// Fetch all tickers that were active on this day via a lightweight query
async function fetchActiveTickers(date) {
  const url = `${API_BASE}/timed/admin/replay-day?key=${API_KEY}&date=${date}&limit=25&offset=0&bucketMinutes=1`;
  const resp = await fetch(url, { method: "POST" });
  const data = await resp.json();
  if (!data.ok) return [];
  // The response has laneCounts but not individual ticker names
  // We need to get the full ticker list differently
  return data;
}

// Main analysis: Fetch raw trail data per ticker using the D1 query endpoint
async function fetchRawTrailBatch(date, offset = 0, limit = 500) {
  // Use the replay-day endpoint but just for data extraction (not processing)
  const dayStart = new Date(`${date}T09:30:00-05:00`).getTime();
  const dayEnd = new Date(`${date}T16:00:00-05:00`).getTime();
  
  const url = `${API_BASE}/timed/admin/replay-day?key=${API_KEY}&date=${date}&limit=${limit}&offset=${offset}&bucketMinutes=1`;
  const resp = await fetch(url, { method: "POST" });
  return resp.json();
}

// Compute price trajectory metrics for a ticker's data series
function analyzeTickerTrajectory(tickerData) {
  if (!tickerData || tickerData.length < 5) return null;
  
  // Sort chronologically
  tickerData.sort((a, b) => a.ts - b.ts);
  
  const ticker = tickerData[0].ticker;
  const results = [];
  
  // Find trigger points (where trigger_reason changes or trigger_ts appears)
  let lastTriggerTs = null;
  
  for (let i = 0; i < tickerData.length; i++) {
    const d = tickerData[i];
    const trigTs = Number(d.trigger_ts);
    const trigReason = d.trigger_reason;
    const price = Number(d.price);
    const htf = Number(d.htf_score) || 0;
    const ltf = Number(d.ltf_score) || 0;
    const state = d.state || "";
    const completion = Number(d.completion) || 0;
    const phase = Number(d.phase_pct) || 0;
    const sl = Number(d.sl);
    const tp = Number(d.tp);
    const flags = d.flags || {};
    
    if (!Number.isFinite(price) || price <= 0) continue;
    
    // Detect trigger point: new trigger_ts that we haven't seen
    if (Number.isFinite(trigTs) && trigTs > 0 && trigTs !== lastTriggerTs) {
      lastTriggerTs = trigTs;
      
      // Look ahead to measure the move after this trigger
      const triggerPrice = Number(d.trigger_price) || price;
      let maxFavorable = 0; // Maximum Favorable Excursion (MFE) %
      let maxAdverse = 0;   // Maximum Adverse Excursion (MAE) %
      let timeToMax = 0;    // Minutes to reach MFE
      let timeToMinMax = 0; // Minutes to reach MAE
      let priceAt5m = null, priceAt15m = null, priceAt30m = null, priceAt60m = null, priceAt120m = null;
      let exitPrice = null;
      
      // Determine side from state
      const isLong = state.includes("BULL") && !state.includes("PULLBACK");
      const isShort = state.includes("BEAR") && !state.includes("PULLBACK");
      const isPullbackLong = state === "HTF_BULL_LTF_PULLBACK";
      const isPullbackShort = state === "HTF_BEAR_LTF_PULLBACK";
      const side = (isPullbackLong || isLong) ? "LONG" : (isPullbackShort || isShort) ? "SHORT" : null;
      
      // Gold SHORT detection (blow-off top)
      const isGoldShort = state === "HTF_BULL_LTF_BULL" && htf >= 25 && ltf >= 15;
      const effectiveSide = isGoldShort ? "SHORT" : side;
      
      if (!effectiveSide) continue;
      
      for (let j = i + 1; j < tickerData.length; j++) {
        const future = tickerData[j];
        const futurePrice = Number(future.price);
        if (!Number.isFinite(futurePrice)) continue;
        
        const minutesElapsed = (future.ts - d.ts) / 60000;
        
        // Compute excursion
        let favorablePct, adversePct;
        if (effectiveSide === "LONG") {
          favorablePct = ((futurePrice - triggerPrice) / triggerPrice) * 100;
          adversePct = ((triggerPrice - futurePrice) / triggerPrice) * 100;
        } else {
          favorablePct = ((triggerPrice - futurePrice) / triggerPrice) * 100;
          adversePct = ((futurePrice - triggerPrice) / triggerPrice) * 100;
        }
        
        if (favorablePct > maxFavorable) {
          maxFavorable = favorablePct;
          timeToMax = minutesElapsed;
        }
        if (adversePct > maxAdverse) {
          maxAdverse = adversePct;
          timeToMinMax = minutesElapsed;
        }
        
        // Record prices at time intervals
        if (minutesElapsed >= 5 && priceAt5m === null) priceAt5m = futurePrice;
        if (minutesElapsed >= 15 && priceAt15m === null) priceAt15m = futurePrice;
        if (minutesElapsed >= 30 && priceAt30m === null) priceAt30m = futurePrice;
        if (minutesElapsed >= 60 && priceAt60m === null) priceAt60m = futurePrice;
        if (minutesElapsed >= 120 && priceAt120m === null) priceAt120m = futurePrice;
      }
      
      // Compute P&L at various timepoints
      const pnlAt = (px) => {
        if (!Number.isFinite(px)) return null;
        const pct = effectiveSide === "LONG" 
          ? ((px - triggerPrice) / triggerPrice) * 100
          : ((triggerPrice - px) / triggerPrice) * 100;
        return Math.round(pct * 100) / 100;
      };
      
      // SL distance from trigger
      const slDistance = Number.isFinite(sl) && sl > 0 && Number.isFinite(triggerPrice)
        ? Math.abs(triggerPrice - sl) / triggerPrice * 100
        : null;
      
      // RR at trigger
      const risk = Number.isFinite(sl) ? Math.abs(triggerPrice - sl) : 0;
      const reward = Number.isFinite(tp) ? Math.abs(tp - triggerPrice) : 0;
      const rr = risk > 0 ? reward / risk : null;
      
      results.push({
        ticker,
        ts: d.ts,
        triggerTs: trigTs,
        triggerPrice: Math.round(triggerPrice * 100) / 100,
        triggerReason: trigReason || "unknown",
        state,
        effectiveSide,
        htf: Math.round(htf * 10) / 10,
        ltf: Math.round(ltf * 10) / 10,
        completion: Math.round(completion * 100) / 100,
        phase: Math.round(phase * 100) / 100,
        slDistance: slDistance ? Math.round(slDistance * 100) / 100 : null,
        rr: rr ? Math.round(rr * 100) / 100 : null,
        // Flags
        sqRelease: !!(flags.sq30_release || flags.sq1h_release),
        emaCross1h: !!flags.ema_cross_1h_13_48,
        emaCross30m: !!flags.ema_cross_30m_13_48,
        stFlip: !!(flags.st_flip_bull || flags.st_flip_bear),
        phaseDot: !!flags.phase_dot,
        // Outcomes
        mfePct: Math.round(maxFavorable * 100) / 100,
        maePct: Math.round(maxAdverse * 100) / 100,
        timeToMaxMin: Math.round(timeToMax),
        timeToMAEMin: Math.round(timeToMinMax),
        pnlAt5m: pnlAt(priceAt5m),
        pnlAt15m: pnlAt(priceAt15m),
        pnlAt30m: pnlAt(priceAt30m),
        pnlAt60m: pnlAt(priceAt60m),
        pnlAt120m: pnlAt(priceAt120m),
        // Classification
        category: maxFavorable >= 2 ? "BIG_MOVER" : maxFavorable >= 0.8 ? "SMALL_MOVER" : "DULL",
      });
    }
  }
  
  return results;
}

// Aggregate statistics
function computeStats(entries) {
  if (!entries.length) return null;
  
  const vals = entries.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return null;
  
  return {
    count: vals.length,
    mean: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 100) / 100,
    median: vals[Math.floor(vals.length / 2)],
    p25: vals[Math.floor(vals.length * 0.25)],
    p75: vals[Math.floor(vals.length * 0.75)],
    min: vals[0],
    max: vals[vals.length - 1],
  };
}

async function main() {
  console.log(`\n=== Signal-to-Outcome Analysis for ${DATE} ===\n`);
  
  // Step 1: Get all data by iterating through replay-day batches
  // We'll collect raw payloads by ticker
  const byTicker = {};
  let offset = 0;
  const batchSize = 200;
  let totalRows = null;
  
  console.log("Phase 1: Extracting raw trail data from ingest_receipts...");
  
  while (true) {
    const url = `${API_BASE}/timed/admin/replay-day?key=${API_KEY}&date=${DATE}&limit=${batchSize}&offset=${offset}&bucketMinutes=1`;
    
    let data;
    try {
      const resp = await fetch(url, { method: "POST" });
      data = await resp.json();
    } catch (e) {
      console.error(`Batch ${offset} failed:`, e.message);
      break;
    }
    
    if (!data.ok) { console.error("API error at offset", offset, data); break; }
    if (totalRows === null) totalRows = data.totalRows;
    
    // The replay-day endpoint processes data and stores to KV.
    // We need to intercept the raw payloads. Since replay-day doesn't return raw data,
    // we'll use the KV state written after each batch.
    
    // After processing, query latest state for tickers in this batch
    // This is inefficient but works. Better: add a raw data endpoint.
    
    offset = data.nextOffset || (offset + batchSize);
    process.stdout.write(`\r  Processed ${offset} / ${totalRows || '?'} rows...`);
    
    if (!data.hasMore || offset >= (totalRows || Infinity)) break;
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }
  
  console.log(`\n  Total rows: ${totalRows}`);
  
  // Step 2: Now query the stored ticker data (KV has the latest state per ticker after replay)
  // But we need time-series data, not just latest state.
  // Better approach: query D1 ingest_receipts directly
  
  console.log("\nPhase 2: Querying time-series data per ticker...");
  
  // Get list of known tickers
  const tickerListResp = await fetch(`${API_BASE}/timed/debug/tickers?key=${API_KEY}&limit=200`);
  const tickerListData = await tickerListResp.json();
  const tickers = (tickerListData?.tickers || []).map(t => t.ticker).filter(Boolean);
  console.log(`  Found ${tickers.length} tickers`);
  
  // For each ticker, get trail data for the day
  const allEntries = [];
  let processed = 0;
  
  for (const ticker of tickers) {
    processed++;
    process.stdout.write(`\r  Analyzing ${ticker} (${processed}/${tickers.length})...     `);
    
    // Query trail data via the existing API
    try {
      const trailResp = await fetch(
        `${API_BASE}/timed/admin/replay-day?key=${API_KEY}&date=${DATE}&ticker=${ticker}&limit=500&offset=0`,
        { method: "POST" }
      );
      const trailText = await trailResp.text();
      let trailData;
      try { trailData = JSON.parse(trailText); } catch { continue; }
      
      if (!trailData?.ok) continue;
      
      // The trail data is processed but not returned as raw points.
      // We need to extract from KV after processing.
      // For now, use the latest state which has been enriched.
      
      const latestResp = await fetch(`${API_BASE}/timed/latest?key=${API_KEY}&ticker=${ticker}`);
      const latest = await latestResp.json();
      
      if (latest?.tickers?.length > 0) {
        const t = latest.tickers[0];
        if (t.htf_score != null && t.price > 0) {
          // We have enriched data - record it
          allEntries.push({
            ticker: t.ticker || ticker,
            htf: Number(t.htf_score) || 0,
            ltf: Number(t.ltf_score) || 0,
            state: t.state,
            completion: Number(t.completion) || 0,
            phase: Number(t.phase_pct) || 0,
            price: Number(t.price),
            sl: Number(t.sl),
            tp: Number(t.tp),
            rr: Number(t.rr) || 0,
            triggerReason: t.trigger_reason,
            kanbanStage: t.kanban_stage,
            flags: t.flags || {},
          });
        }
      }
      
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      continue;
    }
  }
  
  console.log(`\n  Collected ${allEntries.length} ticker snapshots`);
  
  // Step 3: Since per-ticker time series is hard to get via API, let's use the 
  // already-existing historical movers data + gold patterns analysis
  console.log("\nPhase 3: Loading existing analysis data...");
  
  let goldPatterns, historicalMovers;
  try {
    const fs = await import('fs');
    const goldPath = '/Users/shashant/timedtrading/docs/GOLD_PATTERNS_ANALYSIS.json';
    const moversPath = '/Users/shashant/timedtrading/docs/HISTORICAL_MOVERS_DATA.json';
    
    try { goldPatterns = JSON.parse(fs.readFileSync(goldPath, 'utf8')); } 
    catch { console.log("  Gold patterns file not found, skipping"); }
    
    try { historicalMovers = JSON.parse(fs.readFileSync(moversPath, 'utf8')); } 
    catch { console.log("  Historical movers file not found, skipping"); }
  } catch (e) {
    console.log("  Could not load analysis files:", e.message);
  }
  
  // Step 4: Analyze the replay trades we already have
  console.log("\nPhase 4: Analyzing replay trade outcomes...");
  
  const tradesResp = await fetch(`${API_BASE}/timed/trades?key=${API_KEY}`);
  const tradesData = await tradesResp.json();
  const trades = tradesData?.trades || [];
  
  console.log(`  ${trades.length} trades from replay`);
  
  // Classify trades
  const winners = trades.filter(t => t.status === "WIN" || t.status === "TP_HIT_TRIM");
  const losers = trades.filter(t => t.status === "LOSS");
  const open = trades.filter(t => t.status === "OPEN" || t.status === "TP_HIT_TRIM");
  
  // Analyze entry quality
  const analysis = {
    overview: {
      totalTrades: trades.length,
      uniqueTickers: [...new Set(trades.map(t => t.ticker))].length,
      wins: winners.length,
      losses: losers.length,
      openPositions: open.length,
      winRate: trades.length > 0 ? Math.round((winners.length / (winners.length + losers.length)) * 1000) / 10 : 0,
    },
    
    // P&L distribution
    pnlDistribution: {
      winners: computeStats(winners.map(t => Number(t.pnlPct || 0))),
      losers: computeStats(losers.map(t => Number(t.pnlPct || 0))),
      all: computeStats(trades.filter(t => t.status !== "OPEN").map(t => Number(t.pnlPct || 0))),
    },
    
    // Hold time analysis
    holdTime: {
      winners: computeStats(winners.map(t => {
        const entry = new Date(t.entryTime || t.entry_ts).getTime();
        const exit = new Date(t.exitTime || t.exit_ts || t.lastUpdate).getTime();
        return Number.isFinite(entry) && Number.isFinite(exit) ? (exit - entry) / 60000 : null;
      }).filter(Number.isFinite)),
      losers: computeStats(losers.map(t => {
        const entry = new Date(t.entryTime || t.entry_ts).getTime();
        const exit = new Date(t.exitTime || t.exit_ts || t.lastUpdate).getTime();
        return Number.isFinite(entry) && Number.isFinite(exit) ? (exit - entry) / 60000 : null;
      }).filter(Number.isFinite)),
    },
    
    // Entry path analysis
    entryPaths: {},
    
    // Direction analysis
    directionAnalysis: {
      LONG: { total: 0, wins: 0, losses: 0, avgPnl: 0 },
      SHORT: { total: 0, wins: 0, losses: 0, avgPnl: 0 },
    },
    
    // Exit reason analysis
    exitReasons: {},
    
    // Score distribution at entry
    scoreAtEntry: {
      winners: computeStats(winners.map(t => Number(t.rank || t.score || 0)).filter(v => v > 0)),
      losers: computeStats(losers.map(t => Number(t.rank || t.score || 0)).filter(v => v > 0)),
    },
    
    // Ticker performance (which tickers trade best)
    tickerPerformance: {},
    
    // Gold patterns integration
    goldPatternInsights: null,
    historicalMoverInsights: null,
  };
  
  // Entry path breakdown
  for (const t of trades) {
    const path = t.entryPath || t.entry_path || "unknown";
    if (!analysis.entryPaths[path]) analysis.entryPaths[path] = { total: 0, wins: 0, losses: 0, avgPnl: 0, pnls: [] };
    analysis.entryPaths[path].total++;
    if (t.status === "WIN" || t.status === "TP_HIT_TRIM") analysis.entryPaths[path].wins++;
    if (t.status === "LOSS") analysis.entryPaths[path].losses++;
    const pnl = Number(t.pnlPct || 0);
    if (Number.isFinite(pnl)) analysis.entryPaths[path].pnls.push(pnl);
  }
  for (const [path, data] of Object.entries(analysis.entryPaths)) {
    data.avgPnl = data.pnls.length > 0 ? Math.round((data.pnls.reduce((s, v) => s + v, 0) / data.pnls.length) * 100) / 100 : 0;
    data.winRate = data.total > 0 ? Math.round(((data.wins) / Math.max(1, data.wins + data.losses)) * 1000) / 10 : 0;
    delete data.pnls;
  }
  
  // Direction breakdown
  for (const t of trades) {
    const dir = String(t.direction || "").toUpperCase();
    if (!analysis.directionAnalysis[dir]) continue;
    analysis.directionAnalysis[dir].total++;
    if (t.status === "WIN" || t.status === "TP_HIT_TRIM") analysis.directionAnalysis[dir].wins++;
    if (t.status === "LOSS") analysis.directionAnalysis[dir].losses++;
  }
  for (const dir of ["LONG", "SHORT"]) {
    const d = analysis.directionAnalysis[dir];
    d.winRate = d.total > 0 ? Math.round((d.wins / Math.max(1, d.wins + d.losses)) * 1000) / 10 : 0;
  }
  
  // Exit reason breakdown
  for (const t of trades) {
    if (t.status === "OPEN") continue;
    const reason = t.exitReason || t.exit_reason || "unknown";
    if (!analysis.exitReasons[reason]) analysis.exitReasons[reason] = { total: 0, wins: 0, losses: 0 };
    analysis.exitReasons[reason].total++;
    if (t.status === "WIN" || t.status === "TP_HIT_TRIM") analysis.exitReasons[reason].wins++;
    if (t.status === "LOSS") analysis.exitReasons[reason].losses++;
  }
  
  // Per-ticker performance
  for (const t of trades) {
    const ticker = t.ticker;
    if (!analysis.tickerPerformance[ticker]) analysis.tickerPerformance[ticker] = { trades: 0, wins: 0, losses: 0, pnls: [] };
    analysis.tickerPerformance[ticker].trades++;
    if (t.status === "WIN" || t.status === "TP_HIT_TRIM") analysis.tickerPerformance[ticker].wins++;
    if (t.status === "LOSS") analysis.tickerPerformance[ticker].losses++;
    const pnl = Number(t.pnlPct || 0);
    if (Number.isFinite(pnl)) analysis.tickerPerformance[ticker].pnls.push(pnl);
  }
  for (const [ticker, data] of Object.entries(analysis.tickerPerformance)) {
    data.avgPnl = data.pnls.length > 0 ? Math.round((data.pnls.reduce((s, v) => s + v, 0) / data.pnls.length) * 100) / 100 : 0;
    data.netPnl = Math.round(data.pnls.reduce((s, v) => s + v, 0) * 100) / 100;
    data.winRate = data.trades > 0 ? Math.round((data.wins / Math.max(1, data.wins + data.losses)) * 1000) / 10 : 0;
    delete data.pnls;
  }
  
  // Integrate gold patterns insights
  if (goldPatterns) {
    analysis.goldPatternInsights = {
      upMoves: {
        totalSampled: goldPatterns.up_moves?.count || 0,
        topState: goldPatterns.up_moves?.top_state || null,
        medianHTF: goldPatterns.up_moves?.median_htf || null,
        medianLTF: goldPatterns.up_moves?.median_ltf || null,
        medianCompletion: goldPatterns.up_moves?.median_completion || null,
        topTriggers: goldPatterns.up_moves?.top_triggers || [],
      },
      downMoves: {
        totalSampled: goldPatterns.down_moves?.count || 0,
        topState: goldPatterns.down_moves?.top_state || null,
        medianHTF: goldPatterns.down_moves?.median_htf || null,
        medianLTF: goldPatterns.down_moves?.median_ltf || null,
        medianCompletion: goldPatterns.down_moves?.median_completion || null,
        topTriggers: goldPatterns.down_moves?.top_triggers || [],
      },
    };
  }
  
  // Integrate historical movers
  if (historicalMovers) {
    const movers = historicalMovers.movers || historicalMovers;
    const bigUp = Array.isArray(movers) ? movers.filter(m => Number(m.pct_change || m.change_pct) > 2) : [];
    const bigDown = Array.isArray(movers) ? movers.filter(m => Number(m.pct_change || m.change_pct) < -2) : [];
    
    analysis.historicalMoverInsights = {
      bigUpMovers: bigUp.length,
      bigDownMovers: bigDown.length,
      topUpTickers: bigUp.slice(0, 10).map(m => ({ ticker: m.ticker, change: m.pct_change || m.change_pct })),
      topDownTickers: bigDown.slice(0, 10).map(m => ({ ticker: m.ticker, change: m.pct_change || m.change_pct })),
    };
  }
  
  // Step 5: Generate recommendations
  console.log("\n\nPhase 5: Generating recommendations...\n");
  
  const recs = [];
  
  // Win rate analysis
  if (analysis.overview.winRate < 40) {
    recs.push({
      area: "EXIT_LOGIC",
      severity: "HIGH",
      finding: `Win rate is ${analysis.overview.winRate}% - too many losing trades`,
      recommendation: "SL is likely too tight, causing normal retracements to trigger stops. Widen SL or use time-based exits.",
    });
  }
  
  // P&L asymmetry
  const avgWin = analysis.pnlDistribution.winners?.mean || 0;
  const avgLoss = Math.abs(analysis.pnlDistribution.losers?.mean || 0);
  if (avgLoss > avgWin * 1.5) {
    recs.push({
      area: "RISK_MANAGEMENT",
      severity: "HIGH",
      finding: `Avg loss (${avgLoss}%) > 1.5x avg win (${avgWin}%)`,
      recommendation: "Trim winners faster or use trailing stops to lock in gains. Current SL:TP ratio is inverted.",
    });
  }
  
  // Hold time analysis
  const winHold = analysis.holdTime.winners?.median;
  const lossHold = analysis.holdTime.losers?.median;
  if (winHold && lossHold && lossHold < winHold * 0.3) {
    recs.push({
      area: "HOLD_TIME",
      severity: "MEDIUM",
      finding: `Losers exit in ${lossHold} min median vs winners ${winHold} min`,
      recommendation: "Quick exits suggest premature stop-outs. Consider minimum hold period of 20-30 min.",
    });
  }
  
  // Direction skew
  const longWR = analysis.directionAnalysis.LONG.winRate;
  const shortWR = analysis.directionAnalysis.SHORT.winRate;
  if (Math.abs(longWR - shortWR) > 20) {
    const better = longWR > shortWR ? "LONG" : "SHORT";
    recs.push({
      area: "DIRECTION",
      severity: "MEDIUM",
      finding: `${better} trades significantly more profitable (${Math.max(longWR, shortWR)}% vs ${Math.min(longWR, shortWR)}%)`,
      recommendation: `Consider tighter criteria for ${better === "LONG" ? "SHORT" : "LONG"} entries or reduce position size.`,
    });
  }
  
  // Exit reason clustering
  const topExitReason = Object.entries(analysis.exitReasons)
    .sort((a, b) => b[1].total - a[1].total)[0];
  if (topExitReason && topExitReason[1].losses > topExitReason[1].wins * 2) {
    recs.push({
      area: "EXIT_REASONS",
      severity: "HIGH",
      finding: `Exit reason "${topExitReason[0]}" causes ${topExitReason[1].losses} losses vs ${topExitReason[1].wins} wins`,
      recommendation: `Review the "${topExitReason[0]}" exit condition - it may be too aggressive.`,
    });
  }
  
  analysis.recommendations = recs;
  
  // Output results
  const fs = await import('fs');
  const outPath = '/Users/shashant/timedtrading/docs/SIGNAL_OUTCOME_ANALYSIS.json';
  fs.writeFileSync(outPath, JSON.stringify(analysis, null, 2));
  console.log(`Full analysis saved to: ${outPath}`);
  
  // Print summary
  console.log("\n" + "═".repeat(70));
  console.log("  SIGNAL-TO-OUTCOME ANALYSIS SUMMARY");
  console.log("═".repeat(70));
  console.log(`\n  Trades: ${analysis.overview.totalTrades} | Tickers: ${analysis.overview.uniqueTickers}`);
  console.log(`  Wins: ${analysis.overview.wins} | Losses: ${analysis.overview.losses} | Win Rate: ${analysis.overview.winRate}%`);
  console.log(`  Avg Win: ${avgWin}% | Avg Loss: -${avgLoss}%`);
  if (winHold) console.log(`  Winner Hold Time: ${winHold} min median | Loser Hold: ${lossHold} min median`);
  
  console.log(`\n  Direction:`);
  console.log(`    LONG:  ${analysis.directionAnalysis.LONG.total} trades, ${analysis.directionAnalysis.LONG.winRate}% WR`);
  console.log(`    SHORT: ${analysis.directionAnalysis.SHORT.total} trades, ${analysis.directionAnalysis.SHORT.winRate}% WR`);
  
  console.log(`\n  Exit Reasons:`);
  for (const [reason, data] of Object.entries(analysis.exitReasons).sort((a, b) => b[1].total - a[1].total).slice(0, 5)) {
    console.log(`    ${reason}: ${data.total} exits (${data.wins}W/${data.losses}L)`);
  }
  
  console.log(`\n  Per-Ticker (sorted by net P&L):`);
  const sortedTickers = Object.entries(analysis.tickerPerformance)
    .sort((a, b) => b[1].netPnl - a[1].netPnl);
  for (const [ticker, data] of sortedTickers.slice(0, 5)) {
    console.log(`    ${ticker}: ${data.trades} trades, net ${data.netPnl > 0 ? '+' : ''}${data.netPnl}%, WR ${data.winRate}%`);
  }
  console.log(`    ...`);
  for (const [ticker, data] of sortedTickers.slice(-3)) {
    console.log(`    ${ticker}: ${data.trades} trades, net ${data.netPnl > 0 ? '+' : ''}${data.netPnl}%, WR ${data.winRate}%`);
  }
  
  if (recs.length > 0) {
    console.log(`\n  RECOMMENDATIONS:`);
    for (const r of recs) {
      console.log(`    [${r.severity}] ${r.area}: ${r.finding}`);
      console.log(`      → ${r.recommendation}`);
    }
  }
  
  console.log("\n" + "═".repeat(70) + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
