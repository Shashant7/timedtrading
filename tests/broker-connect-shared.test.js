// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadBrokerConnect() {
  const src = readFileSync(join(process.cwd(), "react-app/broker-connect-shared.js"), "utf8");
  // eslint-disable-next-line no-eval
  window.eval(src);
  return window.TimedBrokerConnect;
}

describe("collectOpenPositionRows", () => {
  let BC;

  beforeAll(() => {
    BC = loadBrokerConnect();
  });

  it("merges equity first, then formatted option lots", () => {
    const rows = BC.collectOpenPositionRows({
      positions: {
        ok: true,
        positions: [
          { ticker: "AAPL", qty: 10, market_value: 2000 },
          { ticker: "MSFT", qty: 4, market_value: 1600 },
        ],
        options: [{
          symbol: "SPY260920C00777000",
          underlying: "SPY",
          qty: 2,
          option_type: "CALL",
          strike: 777,
          expiration: "2026-09-20",
          avg_cost: 1.25,
          market_value: 320,
          unrealized_pnl: 70,
        }],
      },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].ticker).toBe("AAPL");
    expect(rows[0].instrument).toBe("equity");
    expect(rows[2].instrument).toBe("option");
    expect(rows[2].ticker).toBe("SPY 777C 09/20");
    expect(rows[2].qty).toBe(2);
  });

  it("prefers options_positions from /bridge/portfolio over bundled .options", () => {
    const rows = BC.collectOpenPositionRows({
      positions: {
        positions: [{ ticker: "AAPL", qty: 1 }],
        options: [{ underlying: "QQQ", option_type: "PUT", strike: 400, expiration: "2026-10-17", qty: 9 }],
      },
      options_positions: [{
        instrument: "option",
        ticker: "SPY 777C 09/20",
        option_type: "CALL",
        broker_qty: 2,
        market_value: 320,
      }],
    });
    expect(rows.map((r) => r.ticker)).toEqual(["AAPL", "SPY 777C 09/20"]);
    expect(rows[1].qty).toBe(2);
  });

  it("copies options_positions through mergeAccountRows", () => {
    const merged = BC.mergeAccountRows(
      [{ user_id: "a@b.com", status: "connected", broker: "webull" }],
      [{
        user_id: "a@b.com",
        positions: { ok: true, positions: [] },
        options_positions: [{ instrument: "option", ticker: "SPY 777C 09/20" }],
        options_count: 1,
        equity_usd: 1000,
      }],
    );
    expect(merged[0].options_count).toBe(1);
    expect(merged[0].options_positions[0].ticker).toBe("SPY 777C 09/20");
  });
});
