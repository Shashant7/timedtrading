// Script to clarify the ranking system and terminology
const API_BASE = "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = "AwesomeSauce";

async function clarifyRanking() {
  try {
    console.log("🔍 Fetching ticker data to clarify ranking system...\n");
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

    console.log(`📊 Found ${tickers.length} tickers\n`);
    console.log("=".repeat(100));
    console.log("\n📋 TERMINOLOGY CLARIFICATION:\n");
    console.log("   • SCORE: Numeric value (0-100) representing quality/strength");
    console.log("   • RANK: Position (1, 2, 3... 135) after sorting by score");
    console.log("   • ticker.rank from worker = BASE SCORE (not position!)");
    console.log("   • computeDynamicRank() = DYNAMIC SCORE (not position!)");
    console.log("\n" + "=".repeat(100));

    // Show sample tickers with their scores
    console.log("\n📊 SAMPLE TICKER DATA:\n");
    const sampleTickers = tickers.slice(0, 5);
    sampleTickers.forEach((t) => {
      console.log(`   ${t.ticker}:`);
      console.log(`     • Base Score (ticker.rank): ${t.rank}`);
      console.log(`     • RR: ${Number(t.rr || 0).toFixed(2)}`);
      console.log(`     • State: ${t.state || "N/A"}`);
      console.log(`     • HTF Score: ${Number(t.htf_score || 0).toFixed(2)}`);
      console.log(`     • LTF Score: ${Number(t.ltf_score || 0).toFixed(2)}`);
      console.log("");
    });

    // Analyze score distribution
    const scores = tickers.map((t) => Number(t.rank) || 0);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    console.log("=".repeat(100));
    console.log("\n📈 BASE SCORE DISTRIBUTION:\n");
    console.log(`   • Total tickers: ${tickers.length}`);
    console.log(`   • Min Score: ${minScore}`);
    console.log(`   • Max Score: ${maxScore}`);
    console.log(`   • Avg Score: ${avgScore.toFixed(2)}`);
    console.log(`   • Score Range: ${minScore} - ${maxScore}`);

    // Show score distribution
    const scoreRanges = {
      "90-100": scores.filter((s) => s >= 90).length,
      "80-89": scores.filter((s) => s >= 80 && s < 90).length,
      "70-79": scores.filter((s) => s >= 70 && s < 80).length,
      "60-69": scores.filter((s) => s >= 60 && s < 70).length,
      "50-59": scores.filter((s) => s >= 50 && s < 60).length,
      "0-49": scores.filter((s) => s < 50).length,
    };

    console.log("\n   Score Distribution:");
    Object.entries(scoreRanges).forEach(([range, count]) => {
      const bar = "█".repeat(Math.round((count / tickers.length) * 50));
      console.log(`   ${range.padEnd(8)}: ${count.toString().padStart(3)} ${bar}`);
    });

    // Show what RANK should be (position after sorting)
    console.log("\n" + "=".repeat(100));
    console.log("\n🏆 WHAT RANK SHOULD BE (Position 1-" + tickers.length + "):\n");
    
    // Sort by base score (descending)
    const sortedByScore = [...tickers].sort((a, b) => {
      const scoreA = Number(a.rank) || 0;
      const scoreB = Number(b.rank) || 0;
      if (scoreB !== scoreA) {
        return scoreB - scoreA;
      }
      return String(a.ticker || "").localeCompare(String(b.ticker || ""));
    });

    console.log("   Top 10 by BASE SCORE (showing what RANK should be):\n");
    sortedByScore.slice(0, 10).forEach((ticker, idx) => {
      const rank = idx + 1; // This is the actual RANK (position)
      const score = ticker.rank; // This is the SCORE
      console.log(`   Rank ${rank.toString().padStart(2)}: ${ticker.ticker.padEnd(6)} | Score: ${score.toString().padStart(3)} | RR: ${Number(ticker.rr || 0).toFixed(2)}`);
    });

    console.log("\n" + "=".repeat(100));
    console.log("\n✅ SUMMARY:\n");
    console.log("   • ticker.rank = BASE SCORE (0-100, from worker)");
    console.log("   • RANK = Position (1-" + tickers.length + ") after sorting by score");
    console.log("   • Current issue: dynamicRank caps at 100, causing ties");
    console.log("   • Solution: Rank should be position (1-" + tickers.length + "), not capped score");

  } catch (error) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  }
}

clarifyRanking();
