#!/usr/bin/env node

/**
 * Script to analyze current ticker data and identify which tickers
 * should trigger Discord alerts based on alert conditions
 */

const API_URL = "https://timed-trading-ingest.shashant.workers.dev/timed/all";

// Alert thresholds
const BASE_MIN_RR = 1.5;
const BASE_MAX_COMP = 0.4;
const BASE_MAX_PHASE = 0.6;
const BASE_MIN_RANK = 70;

// Momentum Elite adjustments
const ME_MIN_RR = Math.max(1.2, BASE_MIN_RR * 0.9);
const ME_MAX_COMP = Math.min(0.5, BASE_MAX_COMP * 1.25);
const ME_MAX_PHASE = Math.min(0.7, BASE_MAX_PHASE * 1.17);
const ME_MIN_RANK = Math.max(60, BASE_MIN_RANK - 10);

function inLongCorridor(htf, ltf) {
  return Number.isFinite(htf) && Number.isFinite(ltf) && htf > 0 && ltf >= -8 && ltf <= 12;
}

function inShortCorridor(htf, ltf) {
  return Number.isFinite(htf) && Number.isFinite(ltf) && htf < 0 && ltf >= -12 && ltf <= 8;
}

function inCorridor(htf, ltf) {
  return inLongCorridor(htf, ltf) || inShortCorridor(htf, ltf);
}

function getCorridorSide(htf, ltf) {
  if (inLongCorridor(htf, ltf)) return "LONG";
  if (inShortCorridor(htf, ltf)) return "SHORT";
  return null;
}

function isAligned(state, corridorSide) {
  if (corridorSide === "LONG") return state === "HTF_BULL_LTF_BULL";
  if (corridorSide === "SHORT") return state === "HTF_BEAR_LTF_BEAR";
  return false;
}

function hasTrigger(tickerData) {
  const triggerReason = String(tickerData.trigger_reason || "");
  const trigOk = triggerReason === "EMA_CROSS" || triggerReason === "SQUEEZE_RELEASE";
  const sqRelease = !!(tickerData.flags && tickerData.flags.sq30_release);
  const hasTriggerPrice = !!tickerData.trigger_price && !!tickerData.trigger_ts;
  return trigOk || sqRelease || hasTriggerPrice;
}

function isBackfill(tickerData) {
  const now = Date.now();
  const triggerTs = tickerData.trigger_ts || tickerData.ts;
  if (!triggerTs) return false;
  const triggerTime = typeof triggerTs === 'string' ? new Date(triggerTs).getTime() : Number(triggerTs);
  return now - triggerTime > 60 * 60 * 1000; // More than 1 hour old
}

function checkAlertConditions(ticker, tickerData) {
  const htf = Number(tickerData.htf_score);
  const ltf = Number(tickerData.ltf_score);
  const state = String(tickerData.state || "");
  const flags = tickerData.flags || {};
  const momentumElite = !!(flags.momentum_elite);
  
  // Check basic requirements
  if (!tickerData.price || !tickerData.sl || !tickerData.tp) {
    return { shouldAlert: false, reason: "Missing price/SL/TP" };
  }
  
  // Check corridor
  const corridorSide = getCorridorSide(htf, ltf);
  if (!corridorSide) {
    return { 
      shouldAlert: false, 
      reason: `Not in corridor (HTF: ${htf.toFixed(2)}, LTF: ${ltf.toFixed(2)})` 
    };
  }
  
  // Check alignment
  const aligned = isAligned(state, corridorSide);
  if (!aligned) {
    return { 
      shouldAlert: false, 
      reason: `Corridor not aligned (State: ${state}, Corridor: ${corridorSide})` 
    };
  }
  
  // Check trigger
  const hasTrig = hasTrigger(tickerData);
  if (!hasTrig) {
    return { 
      shouldAlert: false, 
      reason: `No trigger (trigger_reason: ${tickerData.trigger_reason || "none"}, sq30_release: ${!!flags.sq30_release})` 
    };
  }
  
  // Check thresholds
  const minRR = momentumElite ? ME_MIN_RR : BASE_MIN_RR;
  const maxComp = momentumElite ? ME_MAX_COMP : BASE_MAX_COMP;
  const maxPhase = momentumElite ? ME_MAX_PHASE : BASE_MAX_PHASE;
  const minRank = momentumElite ? ME_MIN_RANK : BASE_MIN_RANK;
  
  const rr = Number(tickerData.rr) || 0;
  const comp = Number(tickerData.completion) || 0;
  const phase = Number(tickerData.phase_pct) || 0;
  const rank = Number(tickerData.rank) || 0;
  
  const blockers = [];
  if (rr < minRR) blockers.push(`RR (${rr.toFixed(2)} < ${minRR})`);
  if (comp > maxComp) blockers.push(`Completion (${comp.toFixed(2)} > ${maxComp})`);
  if (phase > maxPhase) blockers.push(`Phase (${phase.toFixed(2)} > ${maxPhase})`);
  if (rank < minRank) blockers.push(`Rank (${rank} < ${minRank})`);
  
  if (blockers.length > 0) {
    return { 
      shouldAlert: false, 
      reason: `Thresholds not met: ${blockers.join(", ")}` 
    };
  }
  
  // Check backfill
  const backfill = isBackfill(tickerData);
  if (backfill) {
    return { 
      shouldAlert: false, 
      reason: `Backfill detected (data older than 1 hour)` 
    };
  }
  
  return { 
    shouldAlert: true, 
    reason: "All conditions met",
    details: {
      corridorSide,
      state,
      rr,
      comp,
      phase,
      rank,
      momentumElite,
      triggerReason: tickerData.trigger_reason || "none",
      sq30Release: !!flags.sq30_release
    }
  };
}

async function main() {
  try {
    console.log("Fetching ticker data...\n");
    const response = await fetch(API_URL);
    const data = await response.json();
    
    if (!data.ok || !data.data) {
      console.error("Failed to fetch data:", data);
      process.exit(1);
    }
    
    const tickers = Object.entries(data.data);
    console.log(`Analyzing ${tickers.length} tickers...\n`);
    
    const alertCandidates = [];
    const blocked = [];
    
    for (const [ticker, tickerData] of tickers) {
      const result = checkAlertConditions(ticker, tickerData);
      
      if (result.shouldAlert) {
        alertCandidates.push({ ticker, ...result });
      } else {
        blocked.push({ ticker, ...result });
      }
    }
    
    // Sort alert candidates by rank (highest first)
    alertCandidates.sort((a, b) => (b.details?.rank || 0) - (a.details?.rank || 0));
    
    console.log("=".repeat(80));
    console.log(`ALERT CANDIDATES: ${alertCandidates.length} tickers should trigger alerts`);
    console.log("=".repeat(80));
    
    if (alertCandidates.length > 0) {
      console.log("\n✅ Tickers that SHOULD trigger alerts:\n");
      alertCandidates.forEach(({ ticker, details }) => {
        console.log(`${ticker.padEnd(8)} | ${details.corridorSide.padEnd(5)} | Rank: ${String(details.rank).padStart(3)} | RR: ${details.rr.toFixed(2).padStart(5)} | Comp: ${(details.comp * 100).toFixed(1).padStart(5)}% | Phase: ${(details.phase * 100).toFixed(1).padStart(5)}% | ${details.momentumElite ? "🚀 ME" : ""} | Trigger: ${details.triggerReason}`);
      });
    } else {
      console.log("\n❌ No tickers currently meet all alert conditions.\n");
    }
    
    // Show top blocked tickers (closest to meeting conditions)
    console.log("\n" + "=".repeat(80));
    console.log(`BLOCKED: ${blocked.length} tickers blocked from alerts`);
    console.log("=".repeat(80));
    
    // Group blocked by reason and show counts
    const blockedByReason = {};
    blocked.forEach(({ ticker, reason }) => {
      const key = reason.split(":")[0]; // Get main reason
      if (!blockedByReason[key]) blockedByReason[key] = [];
      blockedByReason[key].push(ticker);
    });
    
    console.log("\n📊 Blocked by reason:\n");
    Object.entries(blockedByReason)
      .sort((a, b) => b[1].length - a[1].length)
      .forEach(([reason, tickers]) => {
        console.log(`${reason}: ${tickers.length} tickers`);
        if (tickers.length <= 10) {
          console.log(`  ${tickers.join(", ")}`);
        } else {
          console.log(`  ${tickers.slice(0, 10).join(", ")} ... and ${tickers.length - 10} more`);
        }
        console.log();
      });
    
    // Show tickers that are close (in corridor and aligned but blocked by thresholds)
    const closeCandidates = blocked.filter(b => 
      !b.reason.includes("Not in corridor") && 
      !b.reason.includes("Corridor not aligned") &&
      !b.reason.includes("No trigger") &&
      !b.reason.includes("Missing")
    );
    
    if (closeCandidates.length > 0) {
      console.log("\n" + "=".repeat(80));
      console.log(`CLOSE CANDIDATES: ${closeCandidates.length} tickers in corridor/aligned but blocked by thresholds`);
      console.log("=".repeat(80));
      console.log("\n⚠️  These tickers are in corridor and aligned but don't meet thresholds:\n");
      closeCandidates.slice(0, 20).forEach(({ ticker, reason }) => {
        console.log(`${ticker.padEnd(8)} | ${reason}`);
      });
      if (closeCandidates.length > 20) {
        console.log(`\n... and ${closeCandidates.length - 20} more`);
      }
    }
    
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
