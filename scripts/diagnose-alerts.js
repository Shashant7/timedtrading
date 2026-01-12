#!/usr/bin/env node
/**
 * Diagnostic script to investigate why Discord alerts are not firing
 * 
 * Usage:
 *   node scripts/diagnose-alerts.js [ticker]
 * 
 * If ticker is provided, analyzes that specific ticker.
 * Otherwise, analyzes all tickers in corridor to find potential alert candidates.
 */

const API_BASE = "https://timed-trading-ingest.shashant.workers.dev";

async function fetchAllTickers() {
  try {
    const res = await fetch(`${API_BASE}/timed/all`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.ok && json.data) {
      return json.data;
    }
    throw new Error(json.error || "Invalid response");
  } catch (err) {
    console.error("Failed to fetch tickers:", err);
    throw err;
  }
}

async function checkAlertDebug(ticker) {
  try {
    const res = await fetch(`${API_BASE}/timed/alert-debug?ticker=${encodeURIComponent(ticker)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json;
  } catch (err) {
    console.error(`Failed to check alert debug for ${ticker}:`, err);
    return null;
  }
}

function corridorSide(ticker) {
  const htf = Number(ticker.htf_score || 0);
  const ltf = Number(ticker.ltf_score || 0);
  
  // LONG corridor: HTF > 0, LTF between -8 and 12
  if (htf > 0 && ltf >= -8 && ltf <= 12) {
    return "LONG";
  }
  
  // SHORT corridor: HTF < 0, LTF between -12 and 8
  if (htf < 0 && ltf >= -12 && ltf <= 8) {
    return "SHORT";
  }
  
  return null;
}

function analyzeTicker(ticker) {
  const tickerSymbol = ticker.ticker || "UNKNOWN";
  const state = String(ticker.state || "");
  const alignedLong = state === "HTF_BULL_LTF_BULL";
  const alignedShort = state === "HTF_BEAR_LTF_BEAR";
  const aligned = alignedLong || alignedShort;
  
  const side = corridorSide(ticker);
  const inCorridor = !!side;
  
  const corridorAlignedOK = (side === "LONG" && alignedLong) || (side === "SHORT" && alignedShort);
  
  const flags = ticker.flags || {};
  const trigReason = String(ticker.trigger_reason || "");
  const trigOk = trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE";
  const sqRel = !!flags.sq30_release;
  const momentumElite = !!flags.momentum_elite;
  
  // Thresholds (matching worker defaults)
  const baseMinRR = 1.5;
  const baseMaxComp = 0.4;
  const baseMaxPhase = 0.6;
  const baseMinRank = 70;
  
  const minRR = momentumElite ? Math.max(1.2, baseMinRR * 0.9) : baseMinRR;
  const maxComp = momentumElite ? Math.min(0.5, baseMaxComp * 1.25) : baseMaxComp;
  const maxPhase = momentumElite ? Math.min(0.7, baseMaxPhase * 1.17) : baseMaxPhase;
  const minRank = momentumElite ? Math.max(60, baseMinRank - 10) : baseMinRank;
  
  const rr = Number(ticker.rr || 0);
  const completion = Number(ticker.completion || 0);
  const phase = Number(ticker.phase_pct || 0);
  const rank = Number(ticker.rank || 0);
  
  const rrOk = rr >= minRR;
  const compOk = completion <= maxComp;
  const phaseOk = phase <= maxPhase;
  const rankOk = rank >= minRank;
  
  const momentumEliteTrigger = momentumElite && inCorridor && (corridorAlignedOK || sqRel);
  
  // Note: We can't check enteredAligned without previous state, so we'll assume it's false for now
  const shouldConsiderAlert = inCorridor && (
    (corridorAlignedOK && (trigOk || sqRel)) ||
    (sqRel && side)
  );
  
  const enhancedTrigger = shouldConsiderAlert || momentumEliteTrigger;
  
  const allConditionsMet = enhancedTrigger && rrOk && compOk && phaseOk && rankOk;
  
  return {
    ticker: tickerSymbol,
    inCorridor,
    side,
    corridorAlignedOK,
    aligned,
    state,
    enhancedTrigger,
    rrOk,
    rr,
    minRR,
    compOk,
    completion,
    maxComp,
    phaseOk,
    phase,
    maxPhase,
    rankOk,
    rank,
    minRank,
    momentumElite,
    trigOk,
    trigReason,
    sqRel,
    allConditionsMet,
    blockers: [
      !enhancedTrigger && "trigger conditions",
      !rrOk && `RR (${rr.toFixed(2)} < ${minRR})`,
      !compOk && `Completion (${completion.toFixed(2)} > ${maxComp})`,
      !phaseOk && `Phase (${phase.toFixed(2)} > ${maxPhase})`,
      !rankOk && `Rank (${rank} < ${minRank})`,
    ].filter(Boolean),
  };
}

async function main() {
  const tickerArg = process.argv[2];
  
  console.log("🔍 Discord Alert Diagnostic Tool\n");
  console.log("=" .repeat(60));
  
  if (tickerArg) {
    // Analyze specific ticker
    console.log(`\nAnalyzing ticker: ${tickerArg.toUpperCase()}\n`);
    
    const debugInfo = await checkAlertDebug(tickerArg.toUpperCase());
    if (debugInfo && debugInfo.ok) {
      console.log("Alert Debug Info:");
      console.log(JSON.stringify(debugInfo, null, 2));
      
      if (debugInfo.wouldAlert) {
        console.log("\n✅ This ticker SHOULD trigger an alert!");
      } else {
        console.log("\n❌ This ticker would NOT trigger an alert.");
        console.log("\nBlockers:");
        if (!debugInfo.conditions.enhancedTrigger.ok) {
          console.log("  - Trigger conditions not met");
        }
        if (!debugInfo.conditions.rrOk.ok) {
          console.log(`  - RR: ${debugInfo.conditions.rrOk.value} < ${debugInfo.conditions.rrOk.adjustedRequired}`);
        }
        if (!debugInfo.conditions.compOk.ok) {
          console.log(`  - Completion: ${debugInfo.conditions.compOk.value} > ${debugInfo.conditions.compOk.adjustedRequired}`);
        }
        if (!debugInfo.conditions.phaseOk.ok) {
          console.log(`  - Phase: ${debugInfo.conditions.phaseOk.value} > ${debugInfo.conditions.phaseOk.adjustedRequired}`);
        }
        if (!debugInfo.conditions.rankOk.ok) {
          console.log(`  - Rank: ${debugInfo.conditions.rankOk.value} < ${debugInfo.conditions.rankOk.adjustedRequired}`);
        }
        if (!debugInfo.discord.configured) {
          console.log("  - Discord not configured!");
          console.log(`    DISCORD_ENABLE: ${debugInfo.discord.enabled}`);
          console.log(`    DISCORD_WEBHOOK_URL: ${debugInfo.discord.urlSet ? "SET" : "NOT SET"}`);
        }
      }
    } else {
      console.error("Failed to get debug info for ticker");
    }
  } else {
    // Analyze all tickers
    console.log("\nFetching all tickers...\n");
    
    const allTickers = await fetchAllTickers();
    const tickersArray = Object.values(allTickers);
    
    console.log(`Found ${tickersArray.length} tickers\n`);
    
    // Filter tickers in corridor
    const inCorridorTickers = tickersArray.filter(t => corridorSide(t) !== null);
    console.log(`Tickers in corridor: ${inCorridorTickers.length}\n`);
    
    // Analyze each ticker
    const analyses = inCorridorTickers.map(analyzeTicker);
    
    // Find potential alert candidates
    const candidates = analyses.filter(a => {
      // Should alert if: in corridor + aligned + (trigger or squeeze) + all thresholds met
      return a.inCorridor && 
             a.corridorAlignedOK && 
             (a.trigOk || a.sqRel || a.momentumElite) &&
             a.rrOk && 
             a.compOk && 
             a.phaseOk && 
             a.rankOk;
    });
    
    console.log("=" .repeat(60));
    console.log(`\n📊 Summary:\n`);
    console.log(`Total tickers: ${tickersArray.length}`);
    console.log(`In corridor: ${inCorridorTickers.length}`);
    console.log(`Potential alert candidates: ${candidates.length}\n`);
    
    if (candidates.length > 0) {
      console.log("✅ Potential Alert Candidates:\n");
      candidates.forEach(c => {
        console.log(`  ${c.ticker}:`);
        console.log(`    State: ${c.state}`);
        console.log(`    Side: ${c.side}`);
        console.log(`    RR: ${c.rr.toFixed(2)} (min: ${c.minRR})`);
        console.log(`    Completion: ${c.completion.toFixed(2)} (max: ${c.maxComp})`);
        console.log(`    Phase: ${c.phase.toFixed(2)} (max: ${c.maxPhase})`);
        console.log(`    Rank: ${c.rank} (min: ${c.minRank})`);
        console.log(`    Momentum Elite: ${c.momentumElite}`);
        console.log(`    Trigger: ${c.trigReason || "none"}`);
        console.log(`    Squeeze Release: ${c.sqRel}`);
        console.log("");
      });
    }
    
    // Show blockers for tickers in corridor but not alerting
    const blocked = analyses.filter(a => a.inCorridor && !a.allConditionsMet);
    if (blocked.length > 0) {
      console.log("\n❌ Tickers in Corridor but Blocked:\n");
      blocked.slice(0, 20).forEach(b => {
        console.log(`  ${b.ticker}: ${b.blockers.join(", ")}`);
      });
      if (blocked.length > 20) {
        console.log(`  ... and ${blocked.length - 20} more`);
      }
    }
    
    // Check Discord configuration
    console.log("\n" + "=".repeat(60));
    console.log("\n🔧 Discord Configuration Check:\n");
    console.log("To check Discord configuration, look for these logs in worker:");
    console.log("  [DISCORD CONFIG] - Shows if Discord is enabled");
    console.log("  [DISCORD] Notifications disabled - DISCORD_ENABLE not set to 'true'");
    console.log("  [DISCORD] Webhook URL not configured - DISCORD_WEBHOOK_URL missing");
    console.log("\nTo check a specific ticker:");
    console.log(`  node scripts/diagnose-alerts.js TICKER`);
  }
}

main().catch(console.error);
