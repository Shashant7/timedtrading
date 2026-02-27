#!/usr/bin/env node
/**
 * Check for ledger pollution from duplicate backtest processes.
 * Looks for: duplicate trades, overlapping positions, inconsistent state.
 *
 * Usage: TIMED_API_KEY=your_key node scripts/check-ledger-pollution.js
 */
const API_BASE = process.env.TIMED_API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

async function fetchAllTrades() {
  const trades = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ limit: "500" });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${API_BASE}/timed/ledger/trades?${qs}`);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || "ledger_trades_failed");
    trades.push(...(json.trades || []));
    cursor = json.nextCursor || null;
  } while (cursor);
  return trades;
}

function msToDate(ms) {
  if (!Number.isFinite(ms)) return "?";
  return new Date(ms).toISOString().slice(0, 10);
}

function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  Ledger Pollution Check                              ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  fetchAllTrades()
    .then((trades) => {
      console.log(`Total trades: ${trades.length}\n`);

      // 1. Duplicate trades: same ticker + direction + entry_ts (or within 1 min)
      const key = (t) => `${t.ticker}|${t.direction}|${Math.floor((t.entry_ts || 0) / 60000)}`;
      const byKey = new Map();
      const duplicates = [];
      for (const t of trades) {
        const k = key(t);
        if (byKey.has(k)) {
          duplicates.push({ trade1: byKey.get(k), trade2: t });
        } else {
          byKey.set(k, t);
        }
      }

      if (duplicates.length > 0) {
        console.log("⚠️  DUPLICATE TRADES (same ticker/direction/entry minute):");
        duplicates.slice(0, 10).forEach((d, i) => {
          const t1 = d.trade1, t2 = d.trade2;
          console.log(`   ${i + 1}. ${t1.ticker} ${t1.direction}: ${t1.trade_id} vs ${t2.trade_id}`);
          console.log(`      entry_ts: ${t1.entry_ts} vs ${t2.entry_ts}`);
        });
        if (duplicates.length > 10) console.log(`   ... and ${duplicates.length - 10} more`);
        console.log(`   Total duplicates: ${duplicates.length}\n`);
      } else {
        console.log("✅ No duplicate trades (same ticker/direction/entry minute)\n");
      }

      // 2. Same ticker with multiple OPEN positions
      const openByTicker = new Map();
      for (const t of trades) {
        const status = String(t.status || "").toUpperCase();
        if (status !== "OPEN" && status !== "TP_HIT_TRIM") continue;
        const k = `${t.ticker}|${t.direction}`;
        if (!openByTicker.has(k)) openByTicker.set(k, []);
        openByTicker.get(k).push(t);
      }
      const multiOpen = [...openByTicker.entries()].filter(([, arr]) => arr.length > 1);

      if (multiOpen.length > 0) {
        console.log("⚠️  MULTIPLE OPEN POSITIONS (same ticker + direction):");
        multiOpen.forEach(([k, arr]) => {
          console.log(`   ${k}: ${arr.length} positions`);
          arr.forEach((t, i) => console.log(`      ${i + 1}. ${t.trade_id} entry=${msToDate(t.entry_ts)}`));
        });
        console.log("");
      } else {
        console.log("✅ No multiple open positions per ticker/direction\n");
      }

      // 3. Chronological order: entry before exit for same trade
      const byTradeId = new Map();
      for (const t of trades) {
        const id = t.trade_id || t.id;
        if (!byTradeId.has(id)) byTradeId.set(id, []);
        byTradeId.get(id).push(t);
      }
      // Single trade per id expected; skip this check for now

      // 4. Summary by status
      const byStatus = {};
      for (const t of trades) {
        const s = t.status || "unknown";
        byStatus[s] = (byStatus[s] || 0) + 1;
      }
      console.log("Trade counts by status:");
      Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([s, n]) => console.log(`   ${s}: ${n}`));

      const polluted = duplicates.length > 0 || multiOpen.length > 0;
      console.log("\n" + (polluted ? "⚠️  LEDGER MAY BE POLLUTED — consider reset and re-run." : "✅ No obvious pollution detected."));
    })
    .catch((err) => {
      console.error("Error:", err.message);
      process.exit(1);
    });
}

main();
