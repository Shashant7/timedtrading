#!/usr/bin/env node

/**
 * Analyze today's alerts and trades
 * Compares expected vs actual alerts/trades
 */

const API_BASE = "https://timed-trading-ingest.shashant.workers.dev";

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

async function analyzeToday() {
  console.log("🔍 Analyzing Today's Alerts and Trades\n");
  console.log("=" .repeat(80));

  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().split("T")[0];
  console.log(`📅 Date: ${today}\n`);

  // Fetch activity feed (alerts)
  console.log("📊 Fetching Activity Feed (Alerts)...");
  const activityRes = await fetchJSON(`${API_BASE}/timed/activity?limit=500`);
  const allEvents = activityRes.events || [];

  // Filter today's events
  const todayEvents = allEvents.filter((event) => {
    if (!event.timestamp) return false;
    const eventDate = new Date(event.timestamp).toISOString().split("T")[0];
    return eventDate === today;
  });

  console.log(`   Found ${todayEvents.length} events today\n`);

  // Categorize events
  const discordAlerts = todayEvents.filter((e) => e.type === "discord_alert");
  const tradeEntries = todayEvents.filter((e) => e.type === "trade_entry");
  const otherEvents = todayEvents.filter(
    (e) => e.type !== "discord_alert" && e.type !== "trade_entry"
  );

  console.log("📈 Event Breakdown:");
  console.log(`   Discord Alerts: ${discordAlerts.length}`);
  console.log(`   Trade Entries: ${tradeEntries.length}`);
  console.log(`   Other Events: ${otherEvents.length}\n`);

  // Fetch all trades
  console.log("💰 Fetching Trades...");
  const tradesRes = await fetchJSON(`${API_BASE}/timed/trades`);
  const allTrades = tradesRes.trades || [];

  // Filter today's trades
  const todayTrades = allTrades.filter((trade) => {
    if (!trade.entryTime) return false;
    const tradeDate = new Date(trade.entryTime).toISOString().split("T")[0];
    return tradeDate === today;
  });

  console.log(`   Found ${todayTrades.length} trades entered today\n`);

  // Fetch all tickers to analyze expected alerts/trades
  console.log("📋 Fetching All Ticker Data...");
  const allDataRes = await fetchJSON(`${API_BASE}/timed/all`);
  const allTickers = allDataRes.ok ? Object.values(allDataRes.data || {}) : [];
  console.log(`   Found ${allTickers.length} tickers\n`);

  console.log("=" .repeat(80));
  console.log("\n🔍 ANALYSIS\n");

  // Analyze Discord Alerts
  console.log("📢 DISCORD ALERTS:");
  console.log("-" .repeat(80));
  if (discordAlerts.length === 0) {
    console.log("   ⚠️  No Discord alerts sent today\n");
  } else {
    console.log(`   ✅ ${discordAlerts.length} alerts sent:\n`);
    discordAlerts.forEach((alert, idx) => {
      console.log(`   ${idx + 1}. ${alert.ticker} (${alert.direction || "N/A"})`);
      console.log(`      Rank: ${alert.rank || "N/A"}, RR: ${alert.rr?.toFixed(2) || "N/A"}`);
      console.log(`      State: ${alert.state || "N/A"}`);
      console.log(`      Time: ${new Date(alert.timestamp).toLocaleTimeString()}`);
      if (alert.why) console.log(`      Why: ${alert.why}`);
      console.log("");
    });
  }

  // Analyze Trade Entries
  console.log("💼 TRADE ENTRIES:");
  console.log("-" .repeat(80));
  if (tradeEntries.length === 0) {
    console.log("   ⚠️  No trade entries logged today\n");
  } else {
    console.log(`   ✅ ${tradeEntries.length} trade entries logged:\n`);
    tradeEntries.forEach((entry, idx) => {
      console.log(`   ${idx + 1}. ${entry.ticker} (${entry.direction || "N/A"})`);
      console.log(`      Entry: $${entry.entry_price?.toFixed(2) || "N/A"}`);
      console.log(`      Rank: ${entry.rank || "N/A"}, RR: ${entry.rr?.toFixed(2) || "N/A"}`);
      console.log(`      Time: ${new Date(entry.timestamp).toLocaleTimeString()}`);
      console.log("");
    });
  }

  // Analyze Trades from Trades API
  console.log("💰 TRADES (from Trades API):");
  console.log("-" .repeat(80));
  if (todayTrades.length === 0) {
    console.log("   ⚠️  No trades entered today\n");
  } else {
    console.log(`   ✅ ${todayTrades.length} trades entered:\n`);
    todayTrades.forEach((trade, idx) => {
      console.log(`   ${idx + 1}. ${trade.ticker} (${trade.direction})`);
      console.log(`      Entry: $${trade.entryPrice?.toFixed(2) || "N/A"}`);
      console.log(`      Rank: ${trade.rank || "N/A"}, RR: ${trade.rr?.toFixed(2) || "N/A"}`);
      console.log(`      Status: ${trade.status || "N/A"}`);
      console.log(`      Time: ${new Date(trade.entryTime).toLocaleTimeString()}`);
      console.log("");
    });
  }

  // Compare alerts vs trades
  console.log("=" .repeat(80));
  console.log("\n🔍 COMPARISON\n");

  const alertTickers = new Set(discordAlerts.map((a) => a.ticker));
  const tradeTickers = new Set(todayTrades.map((t) => t.ticker));

  console.log("📊 Alert vs Trade Comparison:");
  console.log(`   Alerts sent: ${discordAlerts.length}`);
  console.log(`   Trades entered: ${todayTrades.length}`);
  console.log(`   Unique tickers with alerts: ${alertTickers.size}`);
  console.log(`   Unique tickers with trades: ${tradeTickers.size}\n`);

  // Find discrepancies
  const alertsWithoutTrades = [...alertTickers].filter(
    (t) => !tradeTickers.has(t)
  );
  const tradesWithoutAlerts = [...tradeTickers].filter(
    (t) => !alertTickers.has(t)
  );

  if (alertsWithoutTrades.length > 0) {
    console.log("⚠️  Tickers with alerts but NO trades:");
    alertsWithoutTrades.forEach((ticker) => {
      const alert = discordAlerts.find((a) => a.ticker === ticker);
      console.log(`   - ${ticker}: Alert sent at ${new Date(alert.timestamp).toLocaleTimeString()}`);
      console.log(`     Rank: ${alert.rank}, RR: ${alert.rr?.toFixed(2)}, State: ${alert.state}`);
    });
    console.log("");
  }

  if (tradesWithoutAlerts.length > 0) {
    console.log("⚠️  Tickers with trades but NO alerts:");
    tradesWithoutAlerts.forEach((ticker) => {
      const trade = todayTrades.find((t) => t.ticker === ticker);
      console.log(`   - ${ticker}: Trade entered at ${new Date(trade.entryTime).toLocaleTimeString()}`);
      console.log(`     Rank: ${trade.rank}, RR: ${trade.rr?.toFixed(2)}, State: ${trade.state}`);
    });
    console.log("");
  }

  if (alertsWithoutTrades.length === 0 && tradesWithoutAlerts.length === 0) {
    console.log("✅ All alerts have corresponding trades and vice versa\n");
  }

  // Summary
  console.log("=" .repeat(80));
  console.log("\n📋 SUMMARY\n");
  console.log(`Today (${today}):`);
  console.log(`   • Discord Alerts: ${discordAlerts.length}`);
  console.log(`   • Trade Entries (Activity): ${tradeEntries.length}`);
  console.log(`   • Trades Entered (API): ${todayTrades.length}`);
  console.log(`   • Discrepancies: ${alertsWithoutTrades.length + tradesWithoutAlerts.length}`);
  console.log("");
}

analyzeToday().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
