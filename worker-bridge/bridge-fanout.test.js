import { describe, it, expect } from "vitest";
import { resolveBridgeAccounts, resolveBridgeUser } from "./bridge-storage.js";

// In-memory BRIDGE_KV stub with the subset resolveBridgeAccounts needs.
function makeKv(rows) {
  const map = new Map();
  for (const r of rows) map.set(`bridge:user:${String(r.user_id).toLowerCase()}`, JSON.stringify(r));
  return {
    async get(k) { return map.get(k) || null; },
    async list({ prefix = "", limit = 100 } = {}) {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix)).slice(0, limit).map((name) => ({ name }));
      return { keys };
    },
  };
}

const owner = "op@x.com";
const fiveWebullPlusIbkr = [
  { user_id: `${owner}#webull#individual-margin`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_id: "WB-1", webull_account_class: "INDIVIDUAL_MARGIN" },
  { user_id: `${owner}#webull#individual-cash`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_id: "WB-2", webull_account_class: "INDIVIDUAL_CASH" },
  { user_id: `${owner}#webull#roth-ira`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_id: "WB-3" },
  { user_id: `${owner}#webull#trad-ira`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: false, webull_account_id: "WB-4" },
  { user_id: `${owner}#webull#joint`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_id: "WB-5" },
  { user_id: owner, broker: "ibkr", status: "connected", broker_integration_enabled: true, ibkr_account_id: "U-IBKR" },
];

describe("resolveBridgeAccounts — multi-account fan-out set", () => {
  it("returns every ENABLED account for the owner (5 enabled of 6)", async () => {
    const env = { BRIDGE_KV: makeKv(fiveWebullPlusIbkr) };
    const accounts = await resolveBridgeAccounts(env, owner, { enabledOnly: true });
    const ids = accounts.map((a) => a.webull_account_id || a.ibkr_account_id).sort();
    // WB-4 is disabled → excluded; IBKR + 4 enabled Webull = 5.
    expect(accounts).toHaveLength(5);
    expect(ids).toEqual(["U-IBKR", "WB-1", "WB-2", "WB-3", "WB-5"]);
  });

  it("includes disabled accounts when enabledOnly=false", async () => {
    const env = { BRIDGE_KV: makeKv(fiveWebullPlusIbkr) };
    const accounts = await resolveBridgeAccounts(env, owner, { enabledOnly: false });
    expect(accounts).toHaveLength(6);
  });

  it("dedupes and returns empty for an unknown owner", async () => {
    const env = { BRIDGE_KV: makeKv(fiveWebullPlusIbkr) };
    expect(await resolveBridgeAccounts(env, "nobody@x.com")).toHaveLength(0);
  });

  it("skips non-connected accounts", async () => {
    const rows = [
      { user_id: owner, broker: "ibkr", status: "pending_oauth", broker_integration_enabled: true, ibkr_account_id: "U-IBKR" },
      { user_id: `${owner}#webull#a`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_id: "WB-1" },
    ];
    const env = { BRIDGE_KV: makeKv(rows) };
    const accounts = await resolveBridgeAccounts(env, owner);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].webull_account_id).toBe("WB-1");
  });
});

describe("resolveBridgeUser — Roth default for owner email", () => {
  it("resolves owner email to the enabled Roth IRA sub-account", async () => {
    const rows = [
      { user_id: owner, broker: "webull", status: "disconnected", broker_integration_enabled: false, webull_account_id: "WB-LEGACY" },
      { user_id: `${owner}#webull#individual-margin`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: false, webull_account_id: "WB-1", webull_account_class: "INDIVIDUAL_MARGIN" },
      { user_id: `${owner}#webull#roth-ira`, owner_email: owner, broker: "webull", status: "connected", broker_integration_enabled: true, webull_account_id: "WB-ROTH", webull_account_class: "ROTH_IRA", equity_usd: 16403 },
    ];
    const env = { BRIDGE_KV: makeKv(rows), WEBULL_DEFAULT_ACCOUNT_CLASS: "ROTH_IRA" };
    const u = await resolveBridgeUser(env, owner);
    expect(u.user_id).toBe(`${owner}#webull#roth-ira`);
    expect(u.webull_account_id).toBe("WB-ROTH");
    expect(u.broker_integration_enabled).toBe(true);
  });
});
