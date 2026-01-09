#!/usr/bin/env node

/**
 * Check what trades are in the system and purge trades by version
 * Usage:
 *   node scripts/check-and-purge-trades.js [version]
 * 
 * Examples:
 *   node scripts/check-and-purge-trades.js          # Check all trades
 *   node scripts/check-and-purge-trades.js 2.6.0    # Purge 2.6.0 trades
 */

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY;

async function checkTrades() {
  try {
    console.log("📊 Checking trades in the system...\n");
    
    const res = await fetch(`${API_BASE}/timed/trades`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "Failed to fetch trades");
    }
    
    const trades = data.trades || [];
    console.log(`Total trades: ${trades.length}\n`);
    
    // Group by version
    const byVersion = {};
    trades.forEach(trade => {
      const version = trade.scriptVersion || trade.script_version || "unknown";
      if (!byVersion[version]) {
        byVersion[version] = [];
      }
      byVersion[version].push(trade);
    });
    
    console.log("Trades by version:");
    Object.keys(byVersion).sort().forEach(version => {
      const count = byVersion[version].length;
      const open = byVersion[version].filter(t => t.status === "OPEN").length;
      const closed = count - open;
      console.log(`  ${version}: ${count} total (${open} open, ${closed} closed)`);
    });
    
    // Show sample trades
    if (trades.length > 0) {
      console.log("\nSample trades (first 5):");
      trades.slice(0, 5).forEach((trade, i) => {
        const version = trade.scriptVersion || trade.script_version || "unknown";
        console.log(`  ${i + 1}. ${trade.ticker} - ${trade.direction} - ${trade.status} - Version: ${version}`);
      });
    }
    
    return { trades, byVersion };
  } catch (error) {
    console.error("❌ Error checking trades:", error.message);
    process.exit(1);
  }
}

async function purgeTradesByVersion(version) {
  if (!API_KEY) {
    console.error("❌ TIMED_API_KEY environment variable is required for purging trades");
    console.error("   Set it with: export TIMED_API_KEY=your_key");
    process.exit(1);
  }
  
  try {
    console.log(`\n🗑️  Purging trades with version ${version}...\n`);
    
    const url = `${API_BASE}/timed/purge-trades-by-version?version=${encodeURIComponent(version)}&key=${encodeURIComponent(API_KEY)}`;
    const res = await fetch(url, { method: "POST" });
    
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
    }
    
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.error || "Failed to purge trades");
    }
    
    console.log(`✅ Successfully purged ${data.purgedCount} trades`);
    console.log(`   Before: ${data.beforeCount} trades`);
    console.log(`   After: ${data.afterCount} trades`);
    console.log(`   Purged: ${data.purgedCount} trades with version ${version}`);
    
  } catch (error) {
    console.error("❌ Error purging trades:", error.message);
    process.exit(1);
  }
}

async function main() {
  const version = process.argv[2];
  
  const { trades, byVersion } = await checkTrades();
  
  if (version) {
    const count = byVersion[version]?.length || 0;
    if (count === 0) {
      console.log(`\n⚠️  No trades found with version ${version}. Nothing to purge.`);
      return;
    }
    
    console.log(`\n⚠️  Found ${count} trades with version ${version}`);
    console.log("   This will delete these trades permanently.");
    
    // In a real script, you might want to add a confirmation prompt
    // For now, proceed with purge
    await purgeTradesByVersion(version);
    
    // Check again after purge
    console.log("\n📊 Checking trades after purge...");
    await checkTrades();
  } else {
    console.log("\n💡 To purge trades by version, run:");
    console.log(`   node scripts/check-and-purge-trades.js <version>`);
    console.log(`   Example: node scripts/check-and-purge-trades.js 2.6.0`);
  }
}

main();
