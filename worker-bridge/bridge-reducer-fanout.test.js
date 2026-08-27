import { describe, it, expect } from "vitest";
import {
  rowHoldsReducerQty,
  accountMatchesManifestRow,
  pickReducerFanoutAccounts,
} from "./bridge-manifest.js";

const ROTH = {
  user_id: "op@x.com",
  webull_account_id: "WB-ROTH",
  webull_account_class: "ROTH_IRA",
};
const CASH = {
  user_id: "friend@x.com#webull#individual-cash",
  webull_account_id: "WB-CASH",
};
const FUT = {
  user_id: "friend@x.com#webull#futures",
  webull_account_id: "WB-FUT",
};

const HELD = {
  user_id: "op@x.com",
  broker_account_id: "WB-ROTH",
  broker_remaining_qty: 0.27,
  sync_state: "in_sync",
  mirror_suppressed: 0,
};
const REJECTED = {
  user_id: "friend@x.com#webull#individual-cash",
  broker_account_id: "WB-CASH",
  broker_remaining_qty: 0,
  sync_state: "rejected",
  mirror_suppressed: 0,
};

describe("pickReducerFanoutAccounts", () => {
  it("keeps only the sleeve that still holds the trade", () => {
    const out = pickReducerFanoutAccounts([ROTH, CASH, FUT], [HELD, REJECTED]);
    expect(out).toHaveLength(1);
    expect(out[0].webull_account_id).toBe("WB-ROTH");
  });

  it("returns empty when nobody opened the trade (EXPE)", () => {
    expect(pickReducerFanoutAccounts([ROTH, CASH, FUT], [])).toEqual([]);
    expect(rowHoldsReducerQty(null)).toBe(false);
  });

  it("matches by broker account id even when user_id differs", () => {
    expect(accountMatchesManifestRow(ROTH, HELD)).toBe(true);
    expect(accountMatchesManifestRow(CASH, HELD)).toBe(false);
  });
});
