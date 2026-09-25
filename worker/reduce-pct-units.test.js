// worker/reduce-pct-units.test.js
//
// The model and the bridge must mean the same thing by `reduce_pct`.
// The bridge applies it to the account's CURRENT sleeve
// (`reconcileReducerQty`: intended = broker_remaining × pct). The Short Term
// trim path used to send the delta of the ORIGINAL position, so laddered
// trims under-sold and a trim-to-full left a quarter of the position behind.

import { describe, it, expect } from "vitest";
import { reducePctOfRemaining } from "./broker-bridge-client.js";
import { reconcileReducerQty } from "../worker-bridge/bridge-guards.js";

/** Walk a trim ladder through the model and the bridge, one account. */
function simulate(ladder, { sleeve = 100, pctFor } = {}) {
  let held = sleeve;
  let from = 0;
  for (const to of ladder) {
    const full = to >= 0.9999;
    const pct = pctFor(from, to);
    const r = reconcileReducerQty({
      side: full ? "exit" : "trim",
      requestedQty: 0,
      reducePct: pct,
      modelRemainingQty: held,
      heldQty: held,
    });
    held = Math.max(0, held - r.qty);
    from = to;
  }
  return held;
}

describe("reducePctOfRemaining", () => {
  it("is the delta for the first trim", () => {
    expect(reducePctOfRemaining(0, 0.5)).toBeCloseTo(0.5);
  });

  it("is a fraction of what is left for a later trim", () => {
    // 50% -> 75% sells half of the remaining half.
    expect(reducePctOfRemaining(0.5, 0.75)).toBeCloseTo(0.5);
    // 25% -> 50% sells a third of the remaining three quarters.
    expect(reducePctOfRemaining(0.25, 0.5)).toBeCloseTo(1 / 3);
  });

  it("returns null for a full close — an exit is not a percentage", () => {
    expect(reducePctOfRemaining(0.5, 1)).toBeNull();
    expect(reducePctOfRemaining(0, 1)).toBeNull();
  });

  it("returns null when there is nothing to trim", () => {
    expect(reducePctOfRemaining(0.5, 0.5)).toBeNull();
    expect(reducePctOfRemaining(0.6, 0.5)).toBeNull();
  });
});

describe("model and bridge agree across a trim ladder", () => {
  const fixed = (from, to) => reducePctOfRemaining(from, to);
  const legacy = (from, to) => to - from;

  it("50% then 75% leaves 25", () => {
    expect(simulate([0.5, 0.75], { pctFor: fixed })).toBeCloseTo(25);
  });

  it("50% then 100% leaves nothing", () => {
    expect(simulate([0.5, 1], { pctFor: fixed })).toBeCloseTo(0);
  });

  it("50%, 75%, then 100% leaves nothing", () => {
    expect(simulate([0.5, 0.75, 1], { pctFor: fixed })).toBeCloseTo(0);
  });

  it("the legacy delta under-sold the ladder (the defect this pins)", () => {
    expect(simulate([0.5, 0.75], { pctFor: legacy })).toBeCloseTo(37.5);
  });
});

describe("reconcileReducerQty: a full-exit side sells the sleeve", () => {
  it("ignores a partial pct riding on side exit", () => {
    const r = reconcileReducerQty({
      side: "exit", requestedQty: 50, reducePct: 0.5,
      modelRemainingQty: 50, heldQty: 50,
    });
    expect(r.qty).toBeCloseTo(50);
    expect(r.reasons.some((x) => x.startsWith("full_side_ignores_pct"))).toBe(true);
  });

  it("treats side sell the same way (investor exits map to sell)", () => {
    const r = reconcileReducerQty({
      side: "sell", requestedQty: 10, reducePct: 0.3,
      modelRemainingQty: 10, heldQty: 10,
    });
    expect(r.qty).toBeCloseTo(10);
  });

  it("still applies pct to a trim", () => {
    const r = reconcileReducerQty({
      side: "trim", requestedQty: 0, reducePct: 0.25,
      modelRemainingQty: 40, heldQty: 40,
    });
    expect(r.qty).toBeCloseTo(10);
  });
});
