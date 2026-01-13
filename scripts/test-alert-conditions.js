#!/usr/bin/env node
const API_BASE = "https://timed-trading-ingest.shashant.workers.dev";

async function testTicker(ticker) {
  const res = await fetch(`${API_BASE}/timed/latest?ticker=${ticker}`);
  const json = await res.json();
  const data = json.data;
  
  if (!data) {
    console.log(`${ticker}: No data`);
    return;
  }
  
  const inCorridor = (data.htf_score > 0 && data.ltf_score >= -8 && data.ltf_score <= 12) ||
                     (data.htf_score < 0 && data.ltf_score >= -12 && data.ltf_score <= 8);
  const side = data.htf_score > 0 ? "LONG" : "SHORT";
  const aligned = data.state === "HTF_BULL_LTF_BULL" || data.state === "HTF_BEAR_LTF_BEAR";
  const corridorAlignedOK = (side === "LONG" && data.state === "HTF_BULL_LTF_BULL") ||
                             (side === "SHORT" && data.state === "HTF_BEAR_LTF_BEAR");
  const trigReason = String(data.trigger_reason || "");
  const trigOk = trigReason === "EMA_CROSS" || trigReason === "SQUEEZE_RELEASE";
  const sqRel = !!(data.flags && data.flags.sq30_release);
  
  const shouldConsiderAlert = 
    (inCorridor && corridorAlignedOK && trigOk) ||
    (inCorridor && sqRel);
  
  console.log(`\n${ticker}:`);
  console.log(`  In corridor: ${inCorridor}`);
  console.log(`  Side: ${side}`);
  console.log(`  State: ${data.state}`);
  console.log(`  Aligned: ${aligned}`);
  console.log(`  Corridor aligned OK: ${corridorAlignedOK}`);
  console.log(`  Trigger reason: ${trigReason}`);
  console.log(`  trigOk: ${trigOk}`);
  console.log(`  sqRel: ${sqRel}`);
  console.log(`  shouldConsiderAlert: ${shouldConsiderAlert}`);
  console.log(`  RR: ${data.rr}, Rank: ${data.rank}, Comp: ${data.completion}, Phase: ${data.phase_pct}`);
}

async function main() {
  const tickers = ["CRS", "DY", "ITT", "JOBY", "MNST", "SHOP", "WTS"];
  for (const ticker of tickers) {
    await testTicker(ticker);
  }
}

main();
