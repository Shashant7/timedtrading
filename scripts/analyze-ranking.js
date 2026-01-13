// Script to analyze ticker data and determine #1 ranked ticker
const API_BASE = "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = "AwesomeSauce";

// Copy the computeDynamicRank function from the frontend
function computeDynamicRank(ticker) {
  const baseRank = Number(ticker.rank) || 50;
  const htf = Number(ticker.htf_score) || 0;
  const ltf = Number(ticker.ltf_score) || 0;
  const comp = completionForSize(ticker);
  const phase = Number(ticker.phase_pct) || 0;
  const rr = Number(ticker.rr) || 0;
  const flags = ticker.flags || {};
  const state = String(ticker.state || "");

  const sqRel = !!flags.sq30_release;
  const sqOn = !!flags.sq30_on;
  const phaseZoneChange = !!flags.phase_zone_change;
  const aligned =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const ent = entryType(ticker);
  const inCorridor = ent.corridor;

  let dynamicScore = baseRank;

  // Corridor bonus (high priority - active setups)
  if (inCorridor) {
    dynamicScore += 12; // Strong bonus for being in corridor

    // Extra bonus if aligned AND in corridor (perfect setup)
    if (aligned) {
      dynamicScore += 8;
    }
  }

  // Squeeze release in corridor = very strong signal
  if (sqRel && inCorridor) {
    dynamicScore += 10;
  }

  // Squeeze on in corridor = building pressure
  if (sqOn && inCorridor && !sqRel) {
    dynamicScore += 5;
  }

  // RR bonus (scaled - better RR = higher rank)
  if (rr >= 2.0) {
    dynamicScore += 8; // Excellent RR
  } else if (rr >= 1.5) {
    dynamicScore += 5; // Good RR
  } else if (rr >= 1.0) {
    dynamicScore += 2; // Acceptable RR
  }

  // Phase bonus (early phase = better opportunity)
  if (phase < 0.3) {
    dynamicScore += 6; // Very early
  } else if (phase < 0.5) {
    dynamicScore += 3; // Early
  } else if (phase > 0.7) {
    dynamicScore -= 5; // Late phase penalty
  }

  // Completion bonus (low completion = more room to run)
  if (comp < 0.3) {
    dynamicScore += 5; // Early in move
  } else if (comp > 0.8) {
    dynamicScore -= 8; // Near completion penalty
  }

  // Score strength bonus (strong HTF/LTF scores)
  const htfStrength = Math.min(8, Math.abs(htf) * 0.15);
  const ltfStrength = Math.min(6, Math.abs(ltf) * 0.12);
  dynamicScore += htfStrength + ltfStrength;

  // Phase zone change bonus
  if (phaseZoneChange) {
    dynamicScore += 4;
  }

  // NO CAP - let scores go above 100 to avoid ties
  // Minimum is 0, but no maximum cap
  dynamicScore = Math.max(0, dynamicScore);

  return Math.round(dynamicScore * 100) / 100; // Round to 2 decimals for precision
}

function completionForSize(ticker) {
  const c = Number(ticker.completion);
  return Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
}

function entryType(ticker) {
  const state = String(ticker.state || "");
  const flags = ticker.flags || {};
  const aligned =
    state === "HTF_BULL_LTF_BULL" || state === "HTF_BEAR_LTF_BEAR";
  const pullback =
    state === "HTF_BULL_LTF_PULLBACK" ||
    state === "HTF_BEAR_LTF_PULLBACK";

  // Corridor logic: aligned states OR pullback states with squeeze release
  const corridor = aligned || (pullback && flags.sq30_release);

  return {
    corridor,
    aligned,
    pullback,
  };
}

async function analyzeRanking() {
  try {
    console.log("🔍 Fetching ticker data...\n");
    const res = await fetch(`${API_BASE}/timed/all`, {
      headers: {
        "X-API-KEY": API_KEY,
        "Cache-Control": "no-store",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP error: ${res.status}`);
    }

    const json = await res.json();
    if (!json.ok || !json.data) {
      throw new Error("Invalid response format");
    }

    const tickerData = json.data;
    const tickers = Object.values(tickerData).filter(
      (t) =>
        t &&
        typeof t === "object" &&
        t.ticker &&
        t.rank !== undefined &&
        t.rank !== null
    );

    console.log(`📊 Found ${tickers.length} tickers with rank data\n`);

    // Compute dynamicRank for all tickers
    const tickersWithDynamicRank = tickers.map((t) => ({
      ...t,
      dynamicRank: computeDynamicRank(t),
    }));

    // Sort by dynamicRank (descending)
    const sorted = [...tickersWithDynamicRank].sort((a, b) => {
      const rankA = Number(a.dynamicRank) || 0;
      const rankB = Number(b.dynamicRank) || 0;
      if (rankB !== rankA) {
        return rankB - rankA;
      }
      return String(a.ticker || "").localeCompare(String(b.ticker || ""));
    });

    console.log("🏆 TOP 10 RANKED TICKERS:\n");
    console.log("=".repeat(120));
    sorted.slice(0, 10).forEach((ticker, idx) => {
      const flags = ticker.flags || {};
      const ent = entryType(ticker);
      const aligned =
        ticker.state === "HTF_BULL_LTF_BULL" ||
        ticker.state === "HTF_BEAR_LTF_BEAR";
      
      // Calculate score breakdown for tie-breaking
      const htf = Number(ticker.htf_score) || 0;
      const ltf = Number(ticker.ltf_score) || 0;
      const htfStrength = Math.min(8, Math.abs(htf) * 0.15);
      const ltfStrength = Math.min(6, Math.abs(ltf) * 0.12);
      
      console.log(`\n#${idx + 1} ${ticker.ticker}`);
      console.log(`   Base Rank: ${ticker.rank} → Dynamic Rank: ${ticker.dynamicRank.toFixed(2)}`);
      console.log(`   State: ${ticker.state || "N/A"} | Aligned: ${aligned ? "YES" : "NO"} | In Corridor: ${ent.corridor ? "YES" : "NO"}`);
      console.log(`   RR: ${Number(ticker.rr || 0).toFixed(2)} | Completion: ${(completionForSize(ticker) * 100).toFixed(1)}% | Phase: ${(Number(ticker.phase_pct || 0) * 100).toFixed(1)}%`);
      console.log(`   HTF: ${htf.toFixed(2)} (+${htfStrength.toFixed(2)}) | LTF: ${ltf.toFixed(2)} (+${ltfStrength.toFixed(2)})`);
      console.log(`   Squeeze: ${flags.sq30_release ? "RELEASE" : flags.sq30_on ? "ON" : "NO"} | Momentum Elite: ${flags.momentum_elite ? "YES" : "NO"}`);
      
      // Show why it's ranked here (tie-breaker info)
      if (idx > 0 && sorted[idx - 1].dynamicRank === ticker.dynamicRank) {
        console.log(`   ⚠️  TIE with ${sorted[idx - 1].ticker} - sorted alphabetically`);
      }
    });
    
    // Show all tickers with dynamicRank = 100
    const maxRankTickers = sorted.filter(t => t.dynamicRank === 100);
    if (maxRankTickers.length > 1) {
      console.log(`\n⚠️  WARNING: ${maxRankTickers.length} tickers hit the maximum dynamicRank of 100!`);
      console.log(`   They are sorted alphabetically: ${maxRankTickers.map(t => t.ticker).join(", ")}`);
      console.log(`   Consider refining the dynamicRank calculation to avoid ties.`);
    }

    console.log("\n" + "=".repeat(100));
    console.log(`\n✅ #1 Ranked Ticker: ${sorted[0].ticker}`);
    console.log(`   Dynamic Rank: ${sorted[0].dynamicRank.toFixed(2)}`);
    console.log(`   Base Rank: ${sorted[0].rank}`);
    console.log(`   State: ${sorted[0].state || "N/A"}`);

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

analyzeRanking();
