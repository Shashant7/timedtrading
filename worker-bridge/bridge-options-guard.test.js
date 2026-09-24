import { describe, it, expect } from "vitest";
import {
  optionContractKey,
  positionContractKey,
  heldQtyForOption,
  guardOptionsSellQty,
  applyOptionsSellGuard,
} from "./bridge-options-guard.js";
import { normalizeWebullOptionsPositions } from "./bridge-webull-options.js";

const SPEC = { ticker: "QQQ", expiration: "2026-08-25", strike: 710, optionType: "CALL" };

describe("optionContractKey", () => {
  it("canonicalizes strike + right", () => {
    expect(optionContractKey(SPEC)).toBe("QQQ:2026-08-25:710.00:C");
    expect(optionContractKey({ ...SPEC, optionType: "P" })).toBe("QQQ:2026-08-25:710.00:P");
  });
});

describe("positionContractKey", () => {
  it("reads Webull-normalized rows", () => {
    expect(positionContractKey({
      underlying: "QQQ",
      expiration: "2026-08-25",
      strike: 710,
      option_type: "CALL",
      qty: 1,
    })).toBe("QQQ:2026-08-25:710.00:C");
  });

  it("parses OCC symbols", () => {
    expect(positionContractKey({ symbol: "QQQ260825C00710000", qty: 2 }))
      .toBe("QQQ:2026-08-25:710.00:C");
  });

  it("reads IBKR YYYYMMDD expiry", () => {
    expect(positionContractKey({
      ticker: "QQQ",
      expiry: "20260825",
      strike: 710,
      putOrCall: "C",
      position: 1,
    })).toBe("QQQ:2026-08-25:710.00:C");
  });

  it("refuses to key a row that never named its right", () => {
    expect(positionContractKey({
      underlying: "QQQ",
      expiration: "2026-08-25",
      strike: 710,
      qty: 1,
    })).toBeNull();
  });
});

// 2026-09-24: IWM 279P entered and mirrored, then the breakeven stop came
// back `no_held_position` while the contract was sitting in the account.
// Webull describes an option holding on `legs[]`; the normalizer read the
// top level, so every position keyed as strike 0 / no expiry / CALL and
// matched nothing. End-to-end here because neither half failed alone.
describe("Webull options SELL guard, end to end", () => {
  const webullPositions = () => normalizeWebullOptionsPositions({
    response: {
      data: {
        position_list: [{
          currency: "USD",
          quantity: "1",
          symbol: "IWM",
          option_strategy: "SINGLE",
          instrument_type: "OPTION",
          cost_price: "0.65",
          legs: [{
            symbol: "IWM",
            instrument_type: "OPTION",
            option_type: "PUT",
            option_expire_date: "2026-09-25",
            option_exercise_price: "279",
          }],
        }],
      },
    },
  });

  it("allows the stop-out of a contract the account actually holds", () => {
    const guard = applyOptionsSellGuard({
      type: "single",
      action: "SELL",
      qty: 1,
      symbol: "IWM",
      expiration: "2026-09-25",
      strike: 279,
      option_type: "PUT",
    }, webullPositions());
    expect(guard).toMatchObject({ ok: true, held_qty: 1 });
  });

  it("still rejects a strike the account does not hold", () => {
    const guard = applyOptionsSellGuard({
      type: "single",
      action: "SELL",
      qty: 1,
      symbol: "IWM",
      expiration: "2026-09-25",
      strike: 280,
      option_type: "PUT",
    }, webullPositions());
    expect(guard).toMatchObject({ ok: false, reason: "no_held_position" });
  });

  it("does not let a put cover a call sell at the same strike", () => {
    const guard = applyOptionsSellGuard({
      type: "single",
      action: "SELL",
      qty: 1,
      symbol: "IWM",
      expiration: "2026-09-25",
      strike: 279,
      option_type: "CALL",
    }, webullPositions());
    expect(guard.ok).toBe(false);
  });

  it("will not count a combo leg it cannot call long or short", () => {
    const held = heldQtyForOption(
      [{
        underlying: "SPY",
        expiration: "2026-09-25",
        strike: 770,
        option_type: "CALL",
        qty: 1,
        direction_unknown: true,
      }],
      { ticker: "SPY", expiration: "2026-09-25", strike: 770, optionType: "CALL" },
    );
    expect(held).toBe(0);
  });
});

describe("guardOptionsSellQty", () => {
  it("lets BUY through without positions", () => {
    expect(guardOptionsSellQty({ action: "BUY", qty: 2, positions: null, ...SPEC }).ok).toBe(true);
  });

  it("rejects SELL when positions cannot be loaded", () => {
    const r = guardOptionsSellQty({ action: "SELL", qty: 1, positions: null, ...SPEC });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("positions_unavailable");
  });

  it("rejects SELL when the contract is not held", () => {
    const r = guardOptionsSellQty({ action: "SELL", qty: 1, positions: [], ...SPEC });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_held_position");
  });

  it("rejects SELL that exceeds held qty", () => {
    const r = guardOptionsSellQty({
      action: "SELL",
      qty: 3,
      positions: [{ underlying: "QQQ", expiration: "2026-08-25", strike: 710, option_type: "CALL", qty: 1 }],
      ...SPEC,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sell_qty_exceeds_held");
    expect(r.held_qty).toBe(1);
    expect(r.requested_qty).toBe(3);
  });

  it("allows SELL at or under held qty", () => {
    const positions = [{ underlying: "QQQ", expiration: "2026-08-25", strike: 710, option_type: "C", qty: 2 }];
    expect(guardOptionsSellQty({ action: "SELL", qty: 1, positions, ...SPEC }).ok).toBe(true);
    expect(guardOptionsSellQty({ action: "SELL", qty: 2, positions, ...SPEC }).ok).toBe(true);
  });

  it("does not match a different strike or right", () => {
    const positions = [{ underlying: "QQQ", expiration: "2026-08-25", strike: 711, option_type: "CALL", qty: 4 }];
    const r = guardOptionsSellQty({ action: "SELL", qty: 1, positions, ...SPEC });
    expect(r.reason).toBe("no_held_position");
  });
});

describe("applyOptionsSellGuard", () => {
  it("guards a translated Webull SELL", () => {
    const r = applyOptionsSellGuard(
      { type: "single", action: "SELL", qty: 2, symbol: "QQQ", expiration: "2026-08-25", strike: 710, option_type: "CALL" },
      [{ underlying: "QQQ", expiration: "2026-08-25", strike: 710, option_type: "CALL", qty: 1 }],
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("sell_qty_exceeds_held");
  });

  it("skips combo structures", () => {
    expect(applyOptionsSellGuard({ type: "combo", action: "SELL", qty: 2 }, []).ok).toBe(true);
  });
});

describe("heldQtyForOption", () => {
  it("sums matching rows", () => {
    expect(heldQtyForOption([
      { underlying: "QQQ", expiration: "2026-08-25", strike: 710, option_type: "CALL", qty: 1 },
      { symbol: "QQQ260825C00710000", qty: 1 },
    ], SPEC)).toBe(2);
  });
});
