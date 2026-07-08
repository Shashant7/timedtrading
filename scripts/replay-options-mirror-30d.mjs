#!/usr/bin/env node
/**
 * Dry-run: what would Options Auto-Mirror have picked for recent model entries?
 *
 * Uses live D1 trade rows (last 30 days). Assumes RIDE confluence at entry.
 * Strike/exp/qty from buildOptionsLadder() — same engine as auto-mirror primary pick.
 *
 * Run: node scripts/replay-options-mirror-30d.mjs
 */
import { execSync } from "node:child_process";
import {
  buildOptionsLadder,
  compactOptionsPlay,
  RISK_PROFILES,
  PROFILE_META,
} from "../worker/options-plays.js";

function fetchTradesFromD1() {
  const cmd = `cd worker && ../node_modules/.bin/wrangler d1 execute timed-trading-ledger --env production --remote --command "SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.entry_price, t.status, t.setup_name, t.rr, p.stop_loss FROM trades t LEFT JOIN positions p ON p.position_id = t.trade_id WHERE t.entry_ts >= (strftime('%s','now') * 1000 - 30 * 86400000) ORDER BY t.entry_ts DESC;" 2>/dev/null`;
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const start = out.indexOf("[");
  const parsed = JSON.parse(out.slice(start));
  return parsed?.[0]?.results || [];
}

function syntheticContract(trade) {
  const price = Number(trade.entry_price);
  const dir = String(trade.direction || "LONG").toUpperCase();
  const sl = Number(trade.stop_loss);
  const slDist = Number.isFinite(sl) && sl > 0
    ? Math.abs(price - sl) / price
    : 0.03;
  const tp1 = dir === "LONG" ? price * (1 + Math.max(0.05, slDist * 2)) : price * (1 - Math.max(0.05, slDist * 2));
  return {
    ticker: String(trade.ticker).toUpperCase(),
    price,
    direction: dir,
    sl: Number.isFinite(sl) && sl > 0 ? sl : (dir === "LONG" ? price * (1 - slDist) : price * (1 + slDist)),
    tp1,
    tp2: null,
    tp3: null,
    rr: Number(trade.rr) || 2,
    stage: "swing",
    atr_pct: Math.max(0.02, slDist),
    mode: "trader",
    levels: [],
  };
}

const profileArg = process.argv.find((a) => a.startsWith("--profile="))?.split("=")[1]
  || (process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : null);
const profiles = profileArg ? [profileArg] : RISK_PROFILES;
const trades = fetchTradesFromD1();

if (!trades.length) {
  console.error("No trades returned from D1.");
  process.exit(1);
}

const rideConfluence = { mode: "RIDE", side: "LONG", supertrend_trigger: { freshness: "fresh" } };

console.log(`Options mirror ladder replay — ${trades.length} model entries (last 30d)`);
console.log("Assumption: RIDE confluence + fresh ST at entry. Uses entry_price + D1 stop_loss when present.");
console.log(`Account: $100k default · risk budget from tier (~0.5%)\n`);

for (const trade of trades) {
  const contract = syntheticContract(trade);
  const conf = { ...rideConfluence, side: contract.direction };
  const entryDate = new Date(Number(trade.entry_ts)).toISOString().slice(0, 10);
  console.log(`── ${trade.ticker} · ${entryDate} · $${contract.price} · ${trade.setup_name || "—"} · ${trade.status}`);
  for (const profile of profiles) {
    const ladder = buildOptionsLadder(contract, {
      profile,
      confluence: conf,
      account_value: 100_000,
    });
    const play = ladder?.primary;
    const label = PROFILE_META[profile]?.label || profile;
    if (!play) {
      console.log(`  ${label}: no primary play`);
      continue;
    }
    const compact = compactOptionsPlay(play, { ticker: contract.ticker, mode: "trader" });
    const optLeg = (play.legs || []).find((l) => l.instrument !== "STOCK" && l.instrument !== "ETF");
    const strike = optLeg?.strike ?? (play.legs?.[0]?.strike) ?? "—";
    const exp = optLeg?.expiration || play.expiration?.iso || play.expiration?.label || "—";
    const qty = play.contracts ?? optLeg?.qty ?? "—";
    const prem = play.premium?.mid != null ? `$${Number(play.premium.mid).toFixed(2)}` : "est";
    const notional = compact?.net_cost_usd != null ? `$${compact.net_cost_usd}` : "—";
    console.log(`  ${label}: ${play.archetype} · ${qty} ctr · strike $${strike} · exp ${exp} · prem ${prem} · debit ${notional}`);
    if (compact?.lines?.[0]) console.log(`           ${compact.lines.join(" | ")}`);
  }
  console.log("");
}
