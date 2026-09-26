import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import vm from "vm";
import path from "path";

/**
 * Load classic-script trades-performance.js into a sandbox with a stub React.
 */
function loadFactory() {
  const file = path.resolve("react-app/trades-performance.js");
  const code = readFileSync(file, "utf8");
  const sandbox = {
    window: {},
    React: {
      useMemo: (fn) => fn(),
      createElement: () => null,
    },
    console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(code, sandbox, { filename: file });
  return sandbox.window.TradesPerformanceFactory({
    React: sandbox.React,
    API_BASE: "",
  });
}

describe("normalizeInvestorTrades", () => {
  let normalize;
  let computeSummary;

  beforeAll(() => {
    const TP = loadFactory();
    normalize = TP.normalizeInvestorTrades;
    computeSummary = TP.computeSummary;
  });

  it("keeps API pnl on SELL lots", () => {
    const rows = normalize([
      { action: "SELL", ticker: "LLY", pnl: -10.63, pnl_pct: -0.4, entry_ts: 1000, entry_price: 1170, exit_price: 1165, shares: 2 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("LOSS");
    expect(rows[0].pnl).toBeCloseTo(-10.63, 2);
  });

  it("derives pnl from entry/exit/shares when API pnl is null (failed lot-replay)", () => {
    // Shape Portfolio saw when D1 IN(...) overflow zeroed every SELL.
    const rows = normalize([
      {
        action: "SELL",
        ticker: "LLY",
        pnl: null,
        status: "FLAT",
        entry_price: 1169.64,
        exit_price: 1164.8,
        shares: 2.1941,
        entry_ts: 2000,
        exit_ts: 2000,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].pnl).toBeLessThan(0);
    expect(rows[0].status).toBe("LOSS");
    const summary = computeSummary(rows, { mode: "investor", accountStartCash: 100000 });
    expect(summary.totalPnlUsd).toBeLessThan(0);
    expect(summary.losses).toBe(1);
  });

  it("drops BUY lots and ignores DCA_BUY without closed status", () => {
    const rows = normalize([
      { action: "BUY", ticker: "A", pnl: 0, entry_ts: 1 },
      { action: "DCA_BUY", ticker: "B", status: "OPEN", entry_ts: 2 },
      { action: "SELL", ticker: "C", pnl: 50, entry_ts: 3, exit_price: 110, entry_price: 100, shares: 1 },
    ]);
    expect(rows.map((r) => r.ticker)).toEqual(["B", "C"]);
    expect(rows[1].status).toBe("WIN");
  });
});
