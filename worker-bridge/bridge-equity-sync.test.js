import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  estimateEquityFromHoldings,
  extractPortfolioTotals,
  refreshAccountEquitySnapshot,
} from "./bridge-equity-sync.js";

vi.mock("./bridge-storage.js", () => {
  const store = new Map();
  return {
    readUser: async (_env, id) => store.get(String(id).toLowerCase()) || null,
    writeUser: async (_env, id, row) => { store.set(String(id).toLowerCase(), { ...row }); },
    __store: store,
  };
});

vi.mock("./bridge-account-ledger.js", () => {
  const snaps = [];
  return {
    snapshotAccount: async (_env, snap) => { snaps.push({ ...snap }); return { ok: true }; },
    readAccountSnapshots: async () => snaps,
    __snaps: snaps,
  };
});

describe("extractPortfolioTotals", () => {
  it("reads Webull-style top-level equity/cash", () => {
    const t = extractPortfolioTotals({
      ok: true,
      equity: 12345.67,
      cash: 200,
      buying_power: 500,
    });
    expect(t).toEqual({ equity_usd: 12345.67, cash_usd: 200, buying_power_usd: 500 });
  });

  it("reads IBKR nested netliquidation.amount", () => {
    const t = extractPortfolioTotals({
      ok: true,
      accounts: [{ netliquidation: { amount: 9900 }, totalcashvalue: { amount: 100 } }],
    });
    expect(t.equity_usd).toBe(9900);
    expect(t.cash_usd).toBe(100);
  });

  it("reads margin-style total_equity / currency-asset NLV", () => {
    const t = extractPortfolioTotals({
      ok: true,
      response: {
        total_equity: 2109.44,
        account_currency_assets: [
          { currency: "USD", net_liquidation_value: 2109.44, cash_balance: 120.5, buying_power: 4000 },
        ],
      },
    });
    expect(t.equity_usd).toBe(2109.44);
    expect(t.cash_usd).toBe(120.5);
    expect(t.buying_power_usd).toBe(4000);
  });

  it("returns null when portfolio failed", () => {
    expect(extractPortfolioTotals({ ok: false, error: "x" })).toBeNull();
  });
});

describe("estimateEquityFromHoldings", () => {
  it("sums market value + cash", () => {
    expect(estimateEquityFromHoldings(
      [{ market_value: 1000 }, { market_value: 50.5 }],
      200,
    )).toBe(1250.5);
  });

  it("uses MV alone when cash unknown", () => {
    expect(estimateEquityFromHoldings([{ marketValue: 500 }], null)).toBe(500);
  });
});

describe("refreshAccountEquitySnapshot", () => {
  beforeEach(async () => {
    const storage = await import("./bridge-storage.js");
    storage.__store.clear();
    const ledger = await import("./bridge-account-ledger.js");
    ledger.__snaps.length = 0;
  });

  it("fetches broker equity for a mirror-off account and snapshots it", async () => {
    const user = {
      user_id: "op@x.com#webull#futures",
      owner_email: "op@x.com",
      broker: "webull",
      webull_account_id: "FUT-1",
      webull_account_label: "Futures",
      broker_integration_enabled: false,
      status: "connected",
    };
    const adapter = {
      getPortfolio: async () => ({ ok: true, equity: 2500.5, cash: 2500.5 }),
    };
    const res = await refreshAccountEquitySnapshot({}, user, { adapter, force: true });
    expect(res.ok).toBe(true);
    expect(res.equity_usd).toBe(2500.5);
    expect(res.source).toBe("broker");
    const ledger = await import("./bridge-account-ledger.js");
    expect(ledger.__snaps).toHaveLength(1);
    expect(ledger.__snaps[0].equity_usd).toBe(2500.5);
    expect(ledger.__snaps[0].account_label).toBe("Futures");
  });

  it("reuses a fresh user equity record without calling the broker or re-stamping", async () => {
    const user = {
      user_id: "op@x.com#webull#cash",
      owner_email: "op@x.com",
      broker: "webull",
      webull_account_id: "CASH-1",
      equity_usd: 800,
      cash_usd: 800,
      portfolio_synced_at: Date.now(),
    };
    const adapter = {
      getPortfolio: async () => { throw new Error("should_not_call"); },
    };
    const res = await refreshAccountEquitySnapshot({}, user, { adapter, force: false });
    expect(res.ok).toBe(true);
    expect(res.equity_usd).toBe(800);
    expect(res.source).toBe("user_record");
    const ledger = await import("./bridge-account-ledger.js");
    expect(ledger.__snaps).toHaveLength(0);
  });

  it("does not re-stamp synced_at when reusing a fresh snapshot (freeze bug)", async () => {
    const syncedAt = Date.now() - 20_000;
    const user = {
      user_id: "op@x.com#webull#individual-margin",
      owner_email: "op@x.com",
      broker: "webull",
      webull_account_id: "MARGIN-1",
      webull_account_label: "Individual Margin",
    };
    let brokerCalls = 0;
    const adapter = {
      getPortfolio: async () => {
        brokerCalls += 1;
        return { ok: true, equity: 9999, cash: 1 };
      },
    };
    const res = await refreshAccountEquitySnapshot({}, user, {
      adapter,
      force: false,
      existingSnap: {
        equity_usd: 2109,
        cash_usd: 100,
        synced_at: syncedAt,
        positions: [],
      },
    });
    expect(res.ok).toBe(true);
    expect(res.equity_usd).toBe(2109);
    expect(res.source).toBe("snapshot");
    expect(brokerCalls).toBe(0);
    const ledger = await import("./bridge-account-ledger.js");
    // Critical: no rewrite — otherwise the 60s window never expires.
    expect(ledger.__snaps).toHaveLength(0);
  });

  it("refetches broker equity once the snapshot ages past maxStaleMs", async () => {
    const user = {
      user_id: "op@x.com#webull#individual-margin",
      owner_email: "op@x.com",
      broker: "webull",
      webull_account_id: "MARGIN-1",
    };
    const adapter = {
      getPortfolio: async () => ({ ok: true, equity: 2250.12, cash: 80 }),
    };
    const res = await refreshAccountEquitySnapshot({}, user, {
      adapter,
      force: false,
      maxStaleMs: 60_000,
      existingSnap: {
        equity_usd: 2109,
        cash_usd: 100,
        synced_at: Date.now() - 90_000,
        positions: [],
      },
    });
    expect(res.source).toBe("broker");
    expect(res.equity_usd).toBe(2250.12);
    const ledger = await import("./bridge-account-ledger.js");
    expect(ledger.__snaps).toHaveLength(1);
    expect(ledger.__snaps[0].equity_usd).toBe(2250.12);
  });

  it("estimates equity from live positions when getPortfolio is rate-limited", async () => {
    const user = {
      user_id: "op@x.com#webull#individual-margin",
      owner_email: "op@x.com",
      broker: "webull",
      webull_account_id: "MARGIN-1",
      cash_usd: 100,
    };
    const adapter = {
      getPortfolio: async () => ({ ok: false, error: "Too many requests" }),
    };
    const res = await refreshAccountEquitySnapshot({}, user, {
      adapter,
      force: true,
      positions: [
        { ticker: "AAPL", market_value: 1500 },
        { ticker: "MSFT", market_value: 509 },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.source).toBe("positions_estimate");
    expect(res.equity_usd).toBe(2109);
  });
});
