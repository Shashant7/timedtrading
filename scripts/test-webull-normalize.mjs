#!/usr/bin/env node
/**
 * Unit smoke test for Webull v2 balance/position normalizers.
 * Run: node scripts/test-webull-normalize.mjs
 */
import {
  normalizeWebullBalance,
  normalizeWebullPositions,
} from "../worker-bridge/bridge-webull-api.js";

const balance = normalizeWebullBalance({
  response: {
    total_asset_currency: "USD",
    total_cash_balance: "485705.0",
    total_net_liquidation_value: "727687.04",
    account_currency_assets: [{
      currency: "USD",
      cash_balance: "485705.95",
      buying_power: "484551",
      net_liquidation_value: "727687.04",
    }],
  },
});

if (balance?.equity !== 727687.04) {
  console.error("FAIL equity", balance);
  process.exit(1);
}
if (balance?.cash !== 485705) {
  console.error("FAIL cash", balance);
  process.exit(1);
}
if (balance?.buying_power !== 484551) {
  console.error("FAIL buying_power", balance);
  process.exit(1);
}

const positions = normalizeWebullPositions({
  response: {
    positions: [
      { symbol: "AAPL", qty: "10", market_value: "1800.5", cost_price: "175.2", unrealized_profit_loss: "52.0", instrument_type: "EQUITY" },
      { symbol: "SPY", quantity: "5", last_price: "500", cost_price: "498.5", unrealized_profit_loss: "7.5", instrument_type: "ETF" },
    ],
  },
});

if (positions.length !== 2) {
  console.error("FAIL positions count", positions);
  process.exit(1);
}
if (positions[0].avg_cost !== 175.2 || positions[0].unrealized_pnl !== 52) {
  console.error("FAIL position[0] cost/upl", positions[0]);
  process.exit(1);
}

console.log("OK webull normalize smoke test", {
  equity: balance.equity,
  cash: balance.cash,
  positions: positions.length,
});
