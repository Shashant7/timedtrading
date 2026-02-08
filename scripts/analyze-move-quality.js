#!/usr/bin/env node
/**
 * Move Quality Analysis
 * 
 * Compares tickers that RAN AND HELD vs RAN AND GAVE BACK.
 * Uses trail data from D1 to reconstruct full price trajectories.
 * 
 * For each ticker on a given day:
 * - Track price from trigger → peak → close
 * - Measure MFE (max favorable excursion), MAE (max adverse excursion)
 * - Measure "give back" ratio: how much of peak gains were lost by EOD
 * - Correlate with signals: HTF/LTF scores, state, trigger_reason, completion, phase, flags
 * 
 * TIMED_API_KEY=AwesomeSauce node scripts/analyze-move-quality.js
 */

const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "";

async function fetchJSON(path) {
  const resp = await fetch(`${API_BASE}${path}${path.includes("?") ? "&" : "?"}key=${API_KEY}`);
  return resp.json();
}

// Fetch trail data for a specific ticker within a time range
async function fetchTickerTrail(ticker, sinceMs, untilMs) {
  const url = `/timed/admin/trail-range?ticker=${encodeURIComponent(ticker)}&since=${sinceMs}&until=${untilMs}&limit=2000`;
  return fetchJSON(url);
}

// Fetch all available tickers
async function fetchTickers() {
  const data = await fetchJSON("/timed/debug/tickers?limit=300");
  return (data?.tickers || []).map(t => t.ticker).filter(Boolean);
}

// Use ingest_receipts for richer trail data
async function fetchTrailFromReceipts(ticker, date) {
  const url = `/timed/admin/trail-range?ticker=${encodeURIComponent(ticker)}&date=${date}&limit=3000`;
  const data = await fetchJSON(url);
  if (data?.rows?.length > 0) return data.rows;
  
  // Fallback: try querying through the D1 SQL endpoint
  const url2 = `/timed/admin/query-trail?ticker=${encodeURIComponent(ticker)}&date=${date}`;
  const data2 = await fetchJSON(url2);
  return data2?.rows || [];
}

// Main analysis
async function main() {
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  MOVE QUALITY ANALYSIS: RAN & HELD vs RAN & GAVE BACK");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Step 1: Get all trades to find which tickers had activity
  console.log("Loading trade data...");
  const tradesData = await fetchJSON("/timed/trades");
  const trades = tradesData?.trades || [];
  console.log(`  ${trades.length} trades loaded\n`);

  if (trades.length === 0) {
    console.log("No trades found. Run a replay first.");
    process.exit(0);
  }

  // Step 2: For each traded ticker, get the full trail for the day
  console.log("Loading trail data for each ticker...\n");
  
  // Group trades by ticker
  const tradesByTicker = {};
  for (const t of trades) {
    const sym = t.ticker;
    if (!tradesByTicker[sym]) tradesByTicker[sym] = [];
    tradesByTicker[sym].push(t);
  }

  const tickers = Object.keys(tradesByTicker);
  const tickerProfiles = [];

  for (const ticker of tickers) {
    process.stdout.write(`  Analyzing ${ticker}...`);
    
    // Get trail data for Feb 2 (the replay day)
    const sinceMs = new Date("2026-02-02T09:00:00-05:00").getTime();
    const untilMs = new Date("2026-02-02T16:30:00-05:00").getTime();
    
    let trailData;
    try {
      trailData = await fetchTrailFromReceipts(ticker, "2026-02-02");
    } catch (e) {
      // Try alternate approach
      try {
        const resp = await fetchTickerTrail(ticker, sinceMs, untilMs);
        trailData = resp?.rows || [];
      } catch {
        trailData = [];
      }
    }

    if (!trailData || trailData.length < 3) {
      // Try getting latest state as fallback
      try {
        const latestData = await fetchJSON(`/timed/latest?ticker=${encodeURIComponent(ticker)}`);
        const latest = latestData?.tickers?.[0] || latestData;
        if (latest?.price) {
          trailData = [latest];
        }
      } catch {}
    }

    const tickerTrades = tradesByTicker[ticker];
    
    // Analyze each trade for this ticker
    for (const trade of tickerTrades) {
      const entryPrice = Number(trade.entryPrice || trade.entry_price);
      const exitPrice = Number(trade.exitPrice || trade.exit_price);
      const direction = String(trade.direction || "").toUpperCase();
      const entryPath = trade.entryPath || trade.entry_path || "unknown";
      const status = trade.status;
      const pnlPct = Number(trade.pnlPct || 0);
      const entryTime = new Date(trade.entryTime || trade.entry_ts).getTime();
      const exitTime = new Date(trade.exitTime || trade.exit_ts || trade.lastUpdate).getTime();
      const holdMinutes = (exitTime - entryTime) / 60000;
      
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
      
      // Find signal state at time of entry from trade data or trail
      const htfAtEntry = Number(trade.htf_score || 0);
      const ltfAtEntry = Number(trade.ltf_score || 0);
      const stateAtEntry = trade.state || "";
      const completionAtEntry = Number(trade.completion || 0);
      const phaseAtEntry = Number(trade.phase_pct || 0);
      const rrAtEntry = Number(trade.rr || 0);
      const triggerReason = trade.trigger_reason || "";
      
      // Reconstruct price trajectory from trail if available
      let mfePct = 0;   // Max Favorable Excursion
      let maePct = 0;   // Max Adverse Excursion  
      let giveBackPct = 0; // How much of MFE was given back
      let timeToMFE = 0;
      let peakPrice = entryPrice;
      let troughPrice = entryPrice;
      let finalPrice = exitPrice || entryPrice;
      
      // Calculate from trail data
      if (Array.isArray(trailData) && trailData.length > 0) {
        // Filter trail points after entry
        const postEntry = trailData
          .filter(r => {
            const ts = Number(r.ts || r.ingest_ts);
            return ts >= entryTime - 60000; // Allow 1 min buffer
          })
          .sort((a, b) => Number(a.ts || a.ingest_ts) - Number(b.ts || b.ingest_ts));
        
        for (const point of postEntry) {
          const px = Number(point.price);
          if (!Number.isFinite(px) || px <= 0) continue;
          const ts = Number(point.ts || point.ingest_ts);
          
          let favorable, adverse;
          if (direction === "LONG") {
            favorable = ((px - entryPrice) / entryPrice) * 100;
            adverse = ((entryPrice - px) / entryPrice) * 100;
          } else {
            favorable = ((entryPrice - px) / entryPrice) * 100;
            adverse = ((px - entryPrice) / entryPrice) * 100;
          }
          
          if (favorable > mfePct) {
            mfePct = favorable;
            peakPrice = px;
            timeToMFE = (ts - entryTime) / 60000;
          }
          if (adverse > maePct) {
            maePct = adverse;
            troughPrice = px;
          }
          finalPrice = px;
        }
      }
      
      // If no trail data, estimate from entry/exit
      if (mfePct === 0 && Number.isFinite(exitPrice) && exitPrice > 0) {
        if (direction === "LONG") {
          mfePct = Math.max(0, ((exitPrice - entryPrice) / entryPrice) * 100);
          maePct = Math.max(0, ((entryPrice - exitPrice) / entryPrice) * 100);
        } else {
          mfePct = Math.max(0, ((entryPrice - exitPrice) / entryPrice) * 100);
          maePct = Math.max(0, ((exitPrice - entryPrice) / entryPrice) * 100);
        }
      }
      
      // Give-back ratio: what % of MFE was lost
      if (mfePct > 0 && Number.isFinite(finalPrice)) {
        let finalPnl;
        if (direction === "LONG") {
          finalPnl = ((finalPrice - entryPrice) / entryPrice) * 100;
        } else {
          finalPnl = ((entryPrice - finalPrice) / entryPrice) * 100;
        }
        giveBackPct = mfePct > 0 ? Math.max(0, ((mfePct - finalPnl) / mfePct) * 100) : 0;
      }
      
      // Classify the move
      let moveType;
      if (mfePct >= 1.0 && giveBackPct <= 30) {
        moveType = "RAN_AND_HELD";   // Reached 1%+ and kept 70%+ of gains
      } else if (mfePct >= 1.0 && giveBackPct > 60) {
        moveType = "RAN_AND_GAVE_BACK"; // Reached 1%+ but lost 60%+ of gains
      } else if (mfePct >= 0.5 && giveBackPct <= 40) {
        moveType = "SMALL_HELD";     // Modest move, held reasonably
      } else if (mfePct >= 0.5 && giveBackPct > 60) {
        moveType = "SMALL_GAVE_BACK"; // Modest move, lost most of it
      } else if (mfePct < 0.3) {
        moveType = "NEVER_MOVED";    // Never developed
      } else {
        moveType = "MIXED";
      }

      // Collect signal flags from trade history
      const history = Array.isArray(trade.history) ? trade.history : [];
      const hadTrim = history.some(e => e.type === "TRIM");
      const hadSLTighten = history.some(e => e.type === "SL_TIGHTEN");
      const trimCount = history.filter(e => e.type === "TRIM").length;
      
      tickerProfiles.push({
        ticker,
        direction,
        entryPath,
        status,
        moveType,
        pnlPct: +pnlPct.toFixed(3),
        holdMin: Number.isFinite(holdMinutes) ? Math.round(holdMinutes) : null,
        // Price trajectory
        mfePct: +mfePct.toFixed(3),
        maePct: +maePct.toFixed(3),
        giveBackPct: +giveBackPct.toFixed(1),
        timeToMFEMin: Math.round(timeToMFE),
        // Signal profile at entry
        htfAtEntry: +htfAtEntry.toFixed(1),
        ltfAtEntry: +ltfAtEntry.toFixed(1),
        stateAtEntry,
        completionAtEntry: +completionAtEntry.toFixed(2),
        phaseAtEntry: +phaseAtEntry.toFixed(2),
        rrAtEntry: +rrAtEntry.toFixed(1),
        triggerReason,
        // Trade events
        hadTrim,
        hadSLTighten,
        trimCount,
        exitReason: trade.exitReason || trade.exit_reason || "",
      });
    }
    
    console.log(` ${trailData?.length || 0} trail points, ${tickerTrades.length} trades`);
    await new Promise(r => setTimeout(r, 30));
  }

  // Step 3: Aggregate by move type
  console.log(`\n\nTotal profiles: ${tickerProfiles.length}\n`);
  
  const byType = {};
  for (const p of tickerProfiles) {
    if (!byType[p.moveType]) byType[p.moveType] = [];
    byType[p.moveType].push(p);
  }

  const stats = (arr, fn) => {
    const vals = arr.map(fn).filter(Number.isFinite).sort((a, b) => a - b);
    if (!vals.length) return { n: 0 };
    return {
      n: vals.length,
      mean: +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2),
      median: vals[Math.floor(vals.length / 2)],
      p25: vals[Math.floor(vals.length * 0.25)],
      p75: vals[Math.floor(vals.length * 0.75)],
    };
  };

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  MOVE TYPE BREAKDOWN");
  console.log("═══════════════════════════════════════════════════════════════\n");

  for (const [type, profiles] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    const winRate = profiles.filter(p => p.status === "WIN" || p.status === "TP_HIT_TRIM").length / 
                    profiles.filter(p => p.status !== "OPEN").length * 100 || 0;
    
    console.log(`  ${type} (${profiles.length} trades, ${winRate.toFixed(0)}% WR)`);
    console.log(`  ${"─".repeat(55)}`);
    
    // Signal profile
    console.log(`    HTF Score:   mean=${stats(profiles, p => p.htfAtEntry).mean}, median=${stats(profiles, p => p.htfAtEntry).median}`);
    console.log(`    LTF Score:   mean=${stats(profiles, p => p.ltfAtEntry).mean}, median=${stats(profiles, p => p.ltfAtEntry).median}`);
    console.log(`    Completion:  mean=${stats(profiles, p => p.completionAtEntry).mean}, median=${stats(profiles, p => p.completionAtEntry).median}`);
    console.log(`    Phase:       mean=${stats(profiles, p => p.phaseAtEntry).mean}, median=${stats(profiles, p => p.phaseAtEntry).median}`);
    console.log(`    R:R:         mean=${stats(profiles, p => p.rrAtEntry).mean}, median=${stats(profiles, p => p.rrAtEntry).median}`);
    
    // Move metrics
    console.log(`    MFE:         mean=${stats(profiles, p => p.mfePct).mean}%, median=${stats(profiles, p => p.mfePct).median}%`);
    console.log(`    MAE:         mean=${stats(profiles, p => p.maePct).mean}%, median=${stats(profiles, p => p.maePct).median}%`);
    console.log(`    Give-back:   mean=${stats(profiles, p => p.giveBackPct).mean}%, median=${stats(profiles, p => p.giveBackPct).median}%`);
    console.log(`    Time to MFE: mean=${stats(profiles, p => p.timeToMFEMin).mean}min, median=${stats(profiles, p => p.timeToMFEMin).median}min`);
    console.log(`    Hold time:   mean=${stats(profiles, p => p.holdMin).mean}min, median=${stats(profiles, p => p.holdMin).median}min`);
    
    // Direction split
    const longCount = profiles.filter(p => p.direction === "LONG").length;
    const shortCount = profiles.filter(p => p.direction === "SHORT").length;
    console.log(`    Directions:  LONG=${longCount}, SHORT=${shortCount}`);
    
    // Top states
    const stateCounts = {};
    for (const p of profiles) {
      const s = p.stateAtEntry || "unknown";
      stateCounts[s] = (stateCounts[s] || 0) + 1;
    }
    const topStates = Object.entries(stateCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log(`    Top states:  ${topStates.map(([s, c]) => `${s}(${c})`).join(", ")}`);
    
    // Entry paths
    const pathCounts = {};
    for (const p of profiles) {
      pathCounts[p.entryPath] = (pathCounts[p.entryPath] || 0) + 1;
    }
    const topPaths = Object.entries(pathCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log(`    Entry paths: ${topPaths.map(([s, c]) => `${s}(${c})`).join(", ")}`);
    
    // Sample tickers
    const sorted = [...profiles].sort((a, b) => b.mfePct - a.mfePct);
    console.log(`    Best:        ${sorted.slice(0, 3).map(p => `${p.ticker}(MFE=${p.mfePct}%, P&L=${p.pnlPct}%)`).join(", ")}`);
    if (sorted.length > 3) {
      console.log(`    Worst:       ${sorted.slice(-3).map(p => `${p.ticker}(MFE=${p.mfePct}%, P&L=${p.pnlPct}%)`).join(", ")}`);
    }
    console.log();
  }

  // Step 4: Compare RAN_AND_HELD vs RAN_AND_GAVE_BACK directly
  const held = byType["RAN_AND_HELD"] || [];
  const gaveBack = byType["RAN_AND_GAVE_BACK"] || [];
  
  if (held.length > 0 || gaveBack.length > 0) {
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  HEAD-TO-HEAD: RAN & HELD vs RAN & GAVE BACK");
    console.log("═══════════════════════════════════════════════════════════════\n");
    
    const compare = (label, fn) => {
      const heldStats = stats(held, fn);
      const gaveBackStats = stats(gaveBack, fn);
      console.log(`  ${label.padEnd(20)} HELD: ${String(heldStats.median ?? "N/A").padEnd(10)} GAVE_BACK: ${String(gaveBackStats.median ?? "N/A").padEnd(10)}`);
    };
    
    compare("HTF Score", p => p.htfAtEntry);
    compare("LTF Score", p => p.ltfAtEntry);
    compare("Completion", p => p.completionAtEntry);
    compare("Phase", p => p.phaseAtEntry);
    compare("R:R", p => p.rrAtEntry);
    compare("MFE %", p => p.mfePct);
    compare("MAE %", p => p.maePct);
    compare("Time to Peak", p => p.timeToMFEMin);
    compare("Hold Time (min)", p => p.holdMin);
    
    console.log(`\n  HELD tickers:      ${held.map(p => `${p.ticker}(${p.direction})`).join(", ")}`);
    console.log(`  GAVE_BACK tickers: ${gaveBack.map(p => `${p.ticker}(${p.direction})`).join(", ")}`);
  }

  // Step 5: Extract actionable signal thresholds
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  SIGNAL THRESHOLDS FOR OPTIMAL ENTRIES");
  console.log("═══════════════════════════════════════════════════════════════\n");
  
  // Good moves: RAN_AND_HELD + SMALL_HELD
  const goodMoves = [...(byType["RAN_AND_HELD"] || []), ...(byType["SMALL_HELD"] || [])];
  // Bad moves: RAN_AND_GAVE_BACK + SMALL_GAVE_BACK + NEVER_MOVED
  const badMoves = [...(byType["RAN_AND_GAVE_BACK"] || []), ...(byType["SMALL_GAVE_BACK"] || []), ...(byType["NEVER_MOVED"] || [])];
  
  if (goodMoves.length > 0 && badMoves.length > 0) {
    const threshold = (label, fn) => {
      const goodS = stats(goodMoves, fn);
      const badS = stats(badMoves, fn);
      const diff = (goodS.median || 0) - (badS.median || 0);
      const indicator = diff > 0 ? "HIGHER is better" : diff < 0 ? "LOWER is better" : "no difference";
      console.log(`  ${label.padEnd(20)} Good: ${String(goodS.median ?? "?").padEnd(8)} Bad: ${String(badS.median ?? "?").padEnd(8)} → ${indicator}`);
    };
    
    threshold("HTF Score", p => p.htfAtEntry);
    threshold("LTF Score", p => p.ltfAtEntry);
    threshold("Completion", p => p.completionAtEntry);
    threshold("Phase %", p => p.phaseAtEntry);
    threshold("R:R Ratio", p => p.rrAtEntry);
    threshold("MFE %", p => p.mfePct);
    threshold("MAE %", p => p.maePct);
    threshold("Time to MFE", p => p.timeToMFEMin);
    
    // Direction preference
    const goodLongPct = goodMoves.filter(p => p.direction === "LONG").length / goodMoves.length * 100;
    const badLongPct = badMoves.filter(p => p.direction === "LONG").length / badMoves.length * 100;
    console.log(`\n  Direction:  Good moves ${goodLongPct.toFixed(0)}% LONG / ${(100 - goodLongPct).toFixed(0)}% SHORT`);
    console.log(`              Bad moves  ${badLongPct.toFixed(0)}% LONG / ${(100 - badLongPct).toFixed(0)}% SHORT`);
    
    // State preference
    const goodStateCounts = {};
    const badStateCounts = {};
    for (const p of goodMoves) goodStateCounts[p.stateAtEntry] = (goodStateCounts[p.stateAtEntry] || 0) + 1;
    for (const p of badMoves) badStateCounts[p.stateAtEntry] = (badStateCounts[p.stateAtEntry] || 0) + 1;
    
    console.log(`\n  Good move states: ${Object.entries(goodStateCounts).sort((a,b) => b[1]-a[1]).map(([s,c]) => `${s}(${c})`).join(", ")}`);
    console.log(`  Bad move states:  ${Object.entries(badStateCounts).sort((a,b) => b[1]-a[1]).map(([s,c]) => `${s}(${c})`).join(", ")}`);
    
    // Entry path preference
    const goodPathCounts = {};
    const badPathCounts = {};
    for (const p of goodMoves) goodPathCounts[p.entryPath] = (goodPathCounts[p.entryPath] || 0) + 1;
    for (const p of badMoves) badPathCounts[p.entryPath] = (badPathCounts[p.entryPath] || 0) + 1;
    
    console.log(`\n  Good entry paths: ${Object.entries(goodPathCounts).sort((a,b) => b[1]-a[1]).map(([s,c]) => `${s}(${c})`).join(", ")}`);
    console.log(`  Bad entry paths:  ${Object.entries(badPathCounts).sort((a,b) => b[1]-a[1]).map(([s,c]) => `${s}(${c})`).join(", ")}`);
    
    // Exit reason patterns
    const goodExitCounts = {};
    const badExitCounts = {};
    for (const p of goodMoves) if (p.exitReason) goodExitCounts[p.exitReason] = (goodExitCounts[p.exitReason] || 0) + 1;
    for (const p of badMoves) if (p.exitReason) badExitCounts[p.exitReason] = (badExitCounts[p.exitReason] || 0) + 1;
    
    console.log(`\n  Good exit reasons: ${Object.entries(goodExitCounts).sort((a,b) => b[1]-a[1]).slice(0,5).map(([s,c]) => `${s}(${c})`).join(", ")}`);
    console.log(`  Bad exit reasons:  ${Object.entries(badExitCounts).sort((a,b) => b[1]-a[1]).slice(0,5).map(([s,c]) => `${s}(${c})`).join(", ")}`);
  }

  // Step 6: Specific recommendations
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ACTIONABLE RECOMMENDATIONS");
  console.log("═══════════════════════════════════════════════════════════════\n");
  
  const recs = [];
  
  // Compare good vs bad moves
  if (goodMoves.length > 0 && badMoves.length > 0) {
    const goodHTF = stats(goodMoves, p => Math.abs(p.htfAtEntry)).median;
    const badHTF = stats(badMoves, p => Math.abs(p.htfAtEntry)).median;
    if (goodHTF > badHTF) {
      recs.push(`ENTRY: Require |HTF| >= ${Math.round(goodHTF * 0.8)} (good moves have stronger HTF conviction)`);
    }
    
    const goodComp = stats(goodMoves, p => p.completionAtEntry).median;
    const badComp = stats(badMoves, p => p.completionAtEntry).median;
    if (goodComp < badComp) {
      recs.push(`ENTRY: Prefer completion <= ${(goodComp + 0.1).toFixed(1)} (entering too late = gave back moves)`);
    }
    
    const goodPhase = stats(goodMoves, p => p.phaseAtEntry).median;
    const badPhase = stats(badMoves, p => p.phaseAtEntry).median;
    if (goodPhase < badPhase) {
      recs.push(`ENTRY: Prefer phase <= ${(goodPhase + 0.1).toFixed(1)} (lower phase = fresher move = holds better)`);
    }
    
    const goodTimeToMFE = stats(goodMoves, p => p.timeToMFEMin).median;
    const badTimeToMFE = stats(badMoves, p => p.timeToMFEMin).median;
    if (goodTimeToMFE > badTimeToMFE) {
      recs.push(`HOLD: Winners peak at ${goodTimeToMFE}min — don't exit before ${Math.round(goodTimeToMFE * 0.6)}min`);
    }
    
    const goodMAE = stats(goodMoves, p => p.maePct).median;
    recs.push(`SL: Good moves have ${goodMAE?.toFixed(1)}% max adverse excursion — SL should allow at least ${(goodMAE * 1.3)?.toFixed(1)}%`);
    
    const goodMFE = stats(goodMoves, p => p.mfePct).median;
    recs.push(`TRIM: Good moves reach ${goodMFE?.toFixed(1)}% MFE — first trim at ${(goodMFE * 0.5)?.toFixed(1)}%, exit at ${(goodMFE * 0.8)?.toFixed(1)}%`);
  }
  
  for (const r of recs) console.log(`  → ${r}`);
  
  // Save full data
  const fs = require("fs");
  const output = { 
    tickerProfiles, 
    byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, { count: v.length, tickers: v.map(p => p.ticker) }])),
    goodMoveSignals: goodMoves.length > 0 ? {
      htf: stats(goodMoves, p => p.htfAtEntry),
      ltf: stats(goodMoves, p => p.ltfAtEntry),
      completion: stats(goodMoves, p => p.completionAtEntry),
      phase: stats(goodMoves, p => p.phaseAtEntry),
      rr: stats(goodMoves, p => p.rrAtEntry),
      mfe: stats(goodMoves, p => p.mfePct),
      mae: stats(goodMoves, p => p.maePct),
    } : null,
    badMoveSignals: badMoves.length > 0 ? {
      htf: stats(badMoves, p => p.htfAtEntry),
      ltf: stats(badMoves, p => p.ltfAtEntry),
      completion: stats(badMoves, p => p.completionAtEntry),
      phase: stats(badMoves, p => p.phaseAtEntry),
      rr: stats(badMoves, p => p.rrAtEntry),
      mfe: stats(badMoves, p => p.mfePct),
      mae: stats(badMoves, p => p.maePct),
    } : null,
    recommendations: recs,
  };
  
  fs.writeFileSync(
    "/Users/shashant/timedtrading/docs/MOVE_QUALITY_ANALYSIS.json",
    JSON.stringify(output, null, 2)
  );
  console.log("\n  Full analysis saved to docs/MOVE_QUALITY_ANALYSIS.json");
  console.log("\n═══════════════════════════════════════════════════════════════\n");
}

main().catch(err => { console.error(err); process.exit(1); });
