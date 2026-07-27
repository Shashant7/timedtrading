import { describe, it, expect } from "vitest";
import { evaluateReducerAgainstPositions, reconcileReducerQty } from "./bridge-guards.js";

describe("roundQtyForBroker — Webull 5dp fractional ceiling", () => {
  it("floors TT 50% trim 1.199385 → 1.19938 (Webull max 5 decimals)", async () => {
    const { roundQtyForBroker } = await import("./bridge-sizing.js");
    expect(roundQtyForBroker(1.199385, { fractional: true, precision: 5 })).toBe(1.19938);
  });
});

describe("reconcileReducerQty — TRIM uses reduce_pct of model portion", () => {
  it("NVDA 50% trim sells half the broker lot, not the full remaining", () => {
    // Model sent ~23.6 shares (50% of $100k book); broker holds ~7.75.
    // Without reduce_pct, explicit qty clamps to full remaining (the bug).
    const withPct = reconcileReducerQty({
      side: "trim",
      requestedQty: 23.608527686364297,
      reducePct: 0.5,
      modelRemainingQty: 7.74514,
      heldQty: 7.74514,
    });
    expect(withPct.qty).toBeCloseTo(3.87257, 4);
    expect(withPct.reasons.some((r) => String(r).startsWith("pct_"))).toBe(true);

    const withoutPct = reconcileReducerQty({
      side: "trim",
      requestedQty: 23.608527686364297,
      reducePct: null,
      modelRemainingQty: 7.74514,
      heldQty: 7.74514,
    });
    expect(withoutPct.qty).toBeCloseTo(7.74514, 4);
  });
});

describe("reconcileReducerQty — TRIM (side=trim) uses explicit qty (KO retry regression)", () => {
  it("side=trim with explicit qty uses reqQty, NOT full model portion", () => {
    // KO scenario: model book intended 4.04568 sh trim; broker holds 10.9.
    // With the correct side=trim (not side=sell), the bridge must sell
    // exactly the intended 4.04568 — not liquidate all 10.9 sh.
    const r = reconcileReducerQty({
      side: "trim",
      requestedQty: 4.04568,
      reducePct: null,
      modelRemainingQty: 10.9,
      heldQty: 10.9,
    });
    expect(r.qty).toBeCloseTo(4.04568, 5);
    expect(r.isFull).toBe(false);
    expect(r.reasons).toContain("explicit_qty");
    expect(r.sweptDust).toBe(false);
  });

  it("side=sell (exit) with same model + held liquidates in full (documents the difference)", () => {
    const r = reconcileReducerQty({
      side: "sell",
      requestedQty: 4.04568,   // model would have passed the trim qty
      reducePct: null,
      modelRemainingQty: 10.9,
      heldQty: 10.9,
    });
    expect(r.qty).toBeCloseTo(10.9, 5); // full flatten
    expect(r.isFull).toBe(true);
  });
});

describe("reconcileReducerQty — full-exit dust sweep (2026-07-27)", () => {
  it("sweeps up sub-dust when held slightly exceeds model portion (no leftover fraction)", () => {
    // KO after event-risk full exit: model tracked 10.905 sh, broker
    // reports 10.90578 held (0.00078 sh above model — broker-side fill
    // precision). Without the sweep we sell 10.905 and leave 0.00078
    // "open" on the manifest forever.
    const r = reconcileReducerQty({
      side: "exit",
      requestedQty: 10.905,
      reducePct: null,
      modelRemainingQty: 10.905,
      heldQty: 10.90578,
    });
    expect(r.qty).toBeCloseTo(10.90578, 6);
    expect(r.sweptDust).toBe(true);
    expect(r.reasons.some((s) => String(s).startsWith("full_exit_sweep_dust_"))).toBe(true);
    // A dust delta is NOT a real discrepancy on a full exit — skip the
    // noisy notification.
    expect(r.discrepancy).toBeNull();
  });

  it("does NOT sweep on a partial trim (side=trim) even when held is slightly above model", () => {
    const r = reconcileReducerQty({
      side: "trim",
      requestedQty: 3,
      reducePct: null,
      modelRemainingQty: 10.905,
      heldQty: 10.90578,
    });
    // trim of 3 sh; no dust involved because we're not flattening.
    expect(r.qty).toBeCloseTo(3, 6);
    expect(r.sweptDust).toBe(false);
  });

  it("does NOT sweep when the excess exceeds the tolerance (protects user shares)", () => {
    // User added 0.5 sh above the model portion (>0.05 dust tolerance).
    // A full exit must NOT touch the user's shares — stays at model.
    const r = reconcileReducerQty({
      side: "sell",
      requestedQty: 10.9,
      reducePct: null,
      modelRemainingQty: 10.9,
      heldQty: 11.4, // 0.5 sh user-added
    });
    expect(r.qty).toBeCloseTo(10.9, 6);
    expect(r.sweptDust).toBe(false);
    // The full exit path settled on model portion (10.9); the "held_gt_model"
    // discrepancy is still surfaced so the operator sees the untouched excess.
    expect(r.discrepancy).not.toBeNull();
    expect(r.discrepancy.some((d) => d.kind === "held_gt_model")).toBe(true);
  });

  it("dust sweep respects heldQty ceiling — cannot oversell if held is below intended", () => {
    // Edge: model says 10.9, held=10.9 (exact match). No dust to sweep.
    const r = reconcileReducerQty({
      side: "close",
      requestedQty: 10.9,
      reducePct: null,
      modelRemainingQty: 10.9,
      heldQty: 10.9,
    });
    expect(r.qty).toBeCloseTo(10.9, 6);
    expect(r.sweptDust).toBe(false);
  });

  it("dustSweepTolerance is overridable per-call", () => {
    // 0.1 sh excess is above default 0.05 tolerance → no sweep by default.
    const rDefault = reconcileReducerQty({
      side: "exit", requestedQty: 10, reducePct: null,
      modelRemainingQty: 10, heldQty: 10.1,
    });
    expect(rDefault.sweptDust).toBe(false);
    expect(rDefault.qty).toBeCloseTo(10, 6);
    // With a higher tolerance the sweep engages.
    const rWide = reconcileReducerQty({
      side: "exit", requestedQty: 10, reducePct: null,
      modelRemainingQty: 10, heldQty: 10.1,
      dustSweepTolerance: 0.5,
    });
    expect(rWide.sweptDust).toBe(true);
    expect(rWide.qty).toBeCloseTo(10.1, 6);
  });
});

describe("evaluateReducerAgainstPositions — never sell what you don't hold", () => {
  it("REJECTS a sell when the account holds no position (the Roth scenario)", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 3, positions: [{ symbol: "MSFT", qty: 10 }],
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("no_broker_position");
    expect(r.heldQty).toBe(0);
  });

  it("REJECTS when the position exists but is flat (qty 0)", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 3, positions: [{ symbol: "AMZN", qty: 0 }],
    });
    expect(r.action).toBe("reject");
    expect(r.reason).toBe("position_flat");
  });

  it("REJECTS selling into a short (negative held) — IRA can't short", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 3, positions: [{ symbol: "AMZN", qty: -5 }],
    });
    expect(r.action).toBe("reject");
  });

  it("PROCEEDS when held >= requested", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 2.8, positions: [{ symbol: "AMZN", qty: 2.8 }],
    });
    expect(r.action).toBe("proceed");
    expect(r.heldQty).toBeCloseTo(2.8, 5);
  });

  it("CLAMPS when the model asks to sell more than is held (never oversell)", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 17, positions: [{ symbol: "AMZN", qty: 2.8 }],
    });
    expect(r.action).toBe("clamp");
    expect(r.clampQty).toBeCloseTo(2.8, 5);
  });

  it("matches on ticker or symbol and sums lots", () => {
    const r = evaluateReducerAgainstPositions({
      ticker: "AMZN", requestedQty: 5, positions: [{ ticker: "AMZN", quantity: 3 }, { symbol: "AMZN", position: 4 }],
    });
    expect(r.action).toBe("proceed");
    expect(r.heldQty).toBe(7);
  });
});
