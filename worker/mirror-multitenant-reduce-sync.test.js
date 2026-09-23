// worker/mirror-multitenant-reduce-sync.test.js
//
// 2026-09-22 NBIS — every mirror-enabled account is supposed to track the
// model, with per-account quantities relational to account size. The trader
// EXIT heal lane budgeted its sells per TICKER against holdings it only ever
// fetched for the OWNER, so a ticker held by three accounts had one pot:
// whichever sleeve was processed first drained it and the rest were dropped
// as `broker_position_already_flat`.
//
// Live state that produced this file (pulled from /timed/admin/broker-bridge
// /manifest and /bridge/positions on 2026-09-23):
//
//   NBIS-1790010197683-jzd6yaqkr, model CLOSED, exit via
//   `catchup_exit:admin_catchup_trader_exits`
//     shashant@gmail.com          / LJJ84GKUVIVG998B8DO3069DKA  qty 2
//        sync_last_action_json: exit placed 5KG6S484OE910GLQGV9J9JK0K8
//        broker: NBIS 0 held (the sell filled 2 @ 235.93)
//     ...#webull#individual-cash  / 9QHQ6RKN0POS4JU54D4TJTKH98  qty 1
//        sync_last_action_json: null — no exit was EVER attempted
//        broker: NBIS 1 held, $236
//
// It was one of 8 positions worth $2,656 that the model had closed and the
// partner's cash account still held.

import { describe, it, expect } from "vitest";
import {
  heldEquityByAccount,
  heldEquityFromAccounts,
  heldOwnerEmailFor,
  resolveHeldAccount,
  loadBrokerHeldEquityForOwners,
} from "./broker-held-equity.js";
import {
  planTraderExitCatchup,
  clampExitOpsToHoldings,
} from "./trader-exit-catchup.js";

const OWNER_ACCT = "LJJ84GKUVIVG998B8DO3069DKA";
const PARTNER_CASH = "9QHQ6RKN0POS4JU54D4TJTKH98";
const PARTNER_FUTURES = "CLHSKJADF2U8F2I0GU61FNF9A8";

/** The two live NBIS sleeves, verbatim shape. */
const NBIS_MANIFESTS = [
  {
    user_id: "shashant@gmail.com",
    broker_account_id: OWNER_ACCT,
    trade_id: "NBIS-1790010197683-jzd6yaqkr",
    ticker: "NBIS",
    model_status: "CLOSED",
    model_intended_qty: 2,
    broker_filled_qty: 2,
    broker_remaining_qty: 2,
    broker_avg_cost: 234.19,
    sync_state: "broker_orphan",
    mirror_suppressed: 1,
  },
  {
    user_id: "shahpritesh206@gmail.com#webull#individual-cash",
    broker_account_id: PARTNER_CASH,
    trade_id: "NBIS-1790010197683-jzd6yaqkr",
    ticker: "NBIS",
    model_status: "CLOSED",
    model_intended_qty: 1,
    broker_filled_qty: 1,
    broker_remaining_qty: 1,
    broker_avg_cost: 234.07,
    sync_state: "broker_orphan",
    mirror_suppressed: 1,
  },
];

/** /bridge/positions?owner=shashant@gmail.com — the sell already filled. */
const OWNER_POSITIONS = [{
  account_id: "shashant@gmail.com#webull#roth-ira",
  broker_account_id: OWNER_ACCT,
  mirror_enabled: true,
  items: [
    { ticker: "NBIS", broker_qty: 0, avg_cost: 234.19 },
    { ticker: "UNP", broker_qty: 1.90357, avg_cost: 225.1 },
  ],
}];

/** /bridge/positions?owner=shahpritesh206@gmail.com — still holds. */
const PARTNER_POSITIONS = [
  {
    account_id: "shahpritesh206@gmail.com#webull#individual-cash",
    broker_account_id: PARTNER_CASH,
    mirror_enabled: true,
    items: [
      { ticker: "NBIS", broker_qty: 1, avg_cost: 234.07 },
      { ticker: "XYZ", broker_qty: 8, avg_cost: 77.4 },
    ],
  },
  {
    account_id: "shahpritesh206@gmail.com#webull#futures",
    broker_account_id: PARTNER_FUTURES,
    mirror_enabled: true,
    items: [{ ticker: "IYT", broker_qty: 5, avg_cost: 80 }],
  },
];

function envWithBridge(byOwner) {
  return {
    BROKER_BRIDGE_OPERATOR_KEY: "k",
    BROKER_BRIDGE_URL: "https://bridge.internal",
    ADMIN_EMAIL: "shashant@gmail.com",
    KV_TIMED: { get: async () => null, put: async () => {} },
    BROKER_BRIDGE: {
      fetch: async (req) => {
        const owner = new URL(req.url).searchParams.get("owner");
        const accounts = byOwner[owner];
        if (accounts === undefined) return new Response(JSON.stringify({ ok: false }));
        return new Response(JSON.stringify({ ok: true, accounts }));
      },
    },
  };
}

describe("heldOwnerEmailFor", () => {
  it("strips the account suffix a partner's sleeves carry", () => {
    expect(heldOwnerEmailFor("shahpritesh206@gmail.com#webull#individual-cash"))
      .toBe("shahpritesh206@gmail.com");
  });

  it("leaves the owner's bare user_id alone", () => {
    expect(heldOwnerEmailFor("shashant@gmail.com")).toBe("shashant@gmail.com");
  });

  it("is empty for a missing id rather than throwing", () => {
    expect(heldOwnerEmailFor(null)).toBe("");
  });
});

describe("heldEquityByAccount", () => {
  it("keeps each account's position separate instead of summing them", () => {
    const byAccount = heldEquityByAccount([...OWNER_POSITIONS, ...PARTNER_POSITIONS]);
    expect(byAccount[OWNER_ACCT.toLowerCase()].held.NBIS).toBeUndefined();
    expect(byAccount[PARTNER_CASH.toLowerCase()].held.NBIS.qty).toBe(1);
  });

  it("reaches one account under every alias it answers to", () => {
    const byAccount = heldEquityByAccount(PARTNER_POSITIONS);
    const viaBrokerId = byAccount[PARTNER_CASH.toLowerCase()];
    const viaUserId = byAccount["shahpritesh206@gmail.com#webull#individual-cash"];
    expect(viaUserId).toBe(viaBrokerId);
  });

  it("skips accounts that never enabled mirroring", () => {
    const byAccount = heldEquityByAccount([
      { broker_account_id: "X", mirror_enabled: false, items: [{ ticker: "NBIS", broker_qty: 5 }] },
    ]);
    expect(byAccount.x).toBeUndefined();
  });

  it("still sums across accounts via heldEquityFromAccounts", () => {
    const total = heldEquityFromAccounts([...OWNER_POSITIONS, ...PARTNER_POSITIONS]);
    expect(total.NBIS.qty).toBe(1);
    expect(total.IYT.qty).toBe(5);
  });
});

describe("resolveHeldAccount", () => {
  const byAccount = heldEquityByAccount([...OWNER_POSITIONS, ...PARTNER_POSITIONS]);

  it("matches a sleeve on broker_account_id", () => {
    const acct = resolveHeldAccount(byAccount, {
      userId: "shashant@gmail.com",
      brokerAccountId: OWNER_ACCT,
    });
    expect(acct.id).toBe(OWNER_ACCT.toLowerCase());
  });

  it("falls back to the suffixed user_id when the broker id is absent", () => {
    const acct = resolveHeldAccount(byAccount, {
      userId: "shahpritesh206@gmail.com#webull#futures",
    });
    expect(acct.id).toBe(PARTNER_FUTURES.toLowerCase());
  });

  it("returns null — unknown, not flat — for an account the broker never reported", () => {
    expect(resolveHeldAccount(byAccount, { brokerAccountId: "NOPE" })).toBe(null);
  });
});

describe("loadBrokerHeldEquityForOwners", () => {
  it("asks every tenant's broker, not just the admin's", async () => {
    const env = envWithBridge({
      "shashant@gmail.com": OWNER_POSITIONS,
      "shahpritesh206@gmail.com": PARTNER_POSITIONS,
    });
    const holdings = await loadBrokerHeldEquityForOwners(env, {
      owners: ["shashant@gmail.com", "shahpritesh206@gmail.com#webull#individual-cash"],
    });
    expect(Object.keys(holdings.owners).sort())
      .toEqual(["shahpritesh206@gmail.com", "shashant@gmail.com"]);
    expect(holdings.byAccount[PARTNER_CASH.toLowerCase()].held.NBIS.qty).toBe(1);
    expect(holdings.unknown).toEqual([]);
  });

  it("fails closed per owner, so one blind tenant cannot flatten another", async () => {
    const env = envWithBridge({ "shashant@gmail.com": OWNER_POSITIONS });
    const holdings = await loadBrokerHeldEquityForOwners(env, {
      owners: ["shashant@gmail.com", "shahpritesh206@gmail.com"],
    });
    expect(holdings.owners["shashant@gmail.com"].held).toBeTruthy();
    expect(holdings.owners["shahpritesh206@gmail.com"].held).toBe(null);
    expect(holdings.unknown).toEqual(["shahpritesh206@gmail.com"]);
  });

  it("treats a rate-limited account as unknown rather than empty", async () => {
    const env = envWithBridge({
      "shashant@gmail.com": [{
        account_id: "shashant@gmail.com#webull#roth-ira",
        broker_account_id: OWNER_ACCT,
        mirror_enabled: true,
        positions_error: "Too many requests",
        items: [],
      }],
    });
    const holdings = await loadBrokerHeldEquityForOwners(env, { owners: ["shashant@gmail.com"] });
    expect(holdings.owners["shashant@gmail.com"].held).toBe(null);
  });
});

describe("clampExitOpsToHoldings — per-account budgets", () => {
  const ops = planTraderExitCatchup({
    exits: [{
      position_id: "NBIS-1790010197683-jzd6yaqkr",
      ticker: "NBIS",
      ts: 1790104044760,
      price: 235.93,
    }],
    manifests: NBIS_MANIFESTS,
  });

  it("plans one op per sleeve", () => {
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.qty).sort()).toEqual([1, 2]);
  });

  it("keeps the partner's sell when the owner's account is already flat", () => {
    const holdings = {
      owners: {
        "shashant@gmail.com": { held: heldEquityFromAccounts(OWNER_POSITIONS) },
        "shahpritesh206@gmail.com": { held: heldEquityFromAccounts(PARTNER_POSITIONS) },
      },
      byAccount: heldEquityByAccount([...OWNER_POSITIONS, ...PARTNER_POSITIONS]),
    };
    const { ops: kept, dropped } = clampExitOpsToHoldings(ops, holdings);
    expect(kept).toHaveLength(1);
    expect(kept[0].broker_account_id).toBe(PARTNER_CASH);
    expect(kept[0].qty).toBe(1);
    // The owner's sleeve still claims 2 because the reconciler has not
    // caught up with the fill — holdings, not the manifest, settle it.
    expect(dropped).toHaveLength(1);
    expect(dropped[0].broker_account_id).toBe(OWNER_ACCT);
    expect(dropped[0].skip).toBe("broker_position_already_flat");
  });

  it("sells both sleeves when both accounts genuinely hold", () => {
    const stillHeld = [{
      account_id: "shashant@gmail.com#webull#roth-ira",
      broker_account_id: OWNER_ACCT,
      mirror_enabled: true,
      items: [{ ticker: "NBIS", broker_qty: 2, avg_cost: 234.19 }],
    }];
    const holdings = {
      owners: {
        "shashant@gmail.com": { held: heldEquityFromAccounts(stillHeld) },
        "shahpritesh206@gmail.com": { held: heldEquityFromAccounts(PARTNER_POSITIONS) },
      },
      byAccount: heldEquityByAccount([...stillHeld, ...PARTNER_POSITIONS]),
    };
    const { ops: kept, dropped } = clampExitOpsToHoldings(ops, holdings);
    expect(dropped).toEqual([]);
    expect(kept.map((o) => [o.broker_account_id, o.qty]).sort())
      .toEqual([[PARTNER_CASH, 1], [OWNER_ACCT, 2]]);
  });

  it("no longer lets one account's sell consume another account's shares", () => {
    // The pre-fix behaviour, reproduced: a single per-ticker budget of 2.
    const perTickerOnly = { NBIS: { qty: 2, avg_cost: 234.19 } };
    const { ops: kept } = clampExitOpsToHoldings(ops, {
      owners: {
        "shashant@gmail.com": { held: perTickerOnly },
        "shahpritesh206@gmail.com": { held: perTickerOnly },
      },
      byAccount: {},
    });
    // Each tenant gets its OWN pot now, so both sleeves survive instead of
    // the partner's being dropped as already-flat.
    expect(kept).toHaveLength(2);
  });

  it("still collapses sibling sleeves that claim one account's residual", () => {
    // 2026-09-14: four PH claims against a Roth holding exactly 0.13612.
    const phClaims = [0, 1, 2, 3].map((i) => ({
      trade_id: `PH-${i}`,
      ticker: "PH",
      user_id: "shashant@gmail.com",
      broker_account_id: OWNER_ACCT,
      qty: 0.13612,
      exit_ts: 1757000000000 + i,
    }));
    const { ops: kept, dropped } = clampExitOpsToHoldings(phClaims, {
      owners: { "shashant@gmail.com": { held: { PH: { qty: 0.13612, avg_cost: 640 } } } },
      byAccount: heldEquityByAccount([{
        account_id: "shashant@gmail.com#webull#roth-ira",
        broker_account_id: OWNER_ACCT,
        mirror_enabled: true,
        items: [{ ticker: "PH", broker_qty: 0.13612, avg_cost: 640 }],
      }]),
    });
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(3);
  });

  it("under-sells rather than over-sells when no broker could be asked", () => {
    const { ops: kept } = clampExitOpsToHoldings(ops, null);
    // One per account — each sleeve's own claim bounds it, and siblings on
    // the same account would still collapse.
    expect(kept.map((o) => [o.broker_account_id, o.qty]).sort())
      .toEqual([[PARTNER_CASH, 1], [OWNER_ACCT, 2]]);
  });

  it("does not over-sell an account whose sibling sleeves share a claim while blind", () => {
    const blindSiblings = [0, 1].map((i) => ({
      trade_id: `XLRE-${i}`,
      ticker: "XLRE",
      user_id: "shashant@gmail.com",
      broker_account_id: OWNER_ACCT,
      qty: 1.35379,
      exit_ts: 1757000000000 + i,
    }));
    const { ops: kept } = clampExitOpsToHoldings(blindSiblings, null);
    expect(kept).toHaveLength(1);
  });
});
