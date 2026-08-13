import { describe, it, expect, beforeEach, vi } from "vitest";
import { extractPortfolioTotals, refreshAccountEquitySnapshot } from "./bridge-equity-sync.js";

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
    snapshotAccount: async (_env, snap) => { snaps.push(snap); return { ok: true }; },
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

  it("returns null when portfolio failed", () => {
    expect(extractPortfolioTotals({ ok: false, error: "x" })).toBeNull();
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

  it("reuses a fresh user equity record without calling the broker", async () => {
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
  });
});
