// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadRailHelpers() {
  const src = readFileSync(join(process.cwd(), "react-app/shared-rail-helpers.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TimedRailHelpers;
}

describe("trader posture-aligned plan", () => {
  let H;

  beforeAll(() => {
    H = loadRailHelpers();
  });

  it("aligns INTU-like lean-long watch plan away from HTF SHORT contract", () => {
    const ctx = H.resolveTraderPlanDisplayContext({
      px: 281.17,
      stage: "watch",
      tradeIsOpen: false,
      postureDir: "LONG",
      postureStrength: "lean",
      predictionContract: {
        direction: "SHORT",
        posture_direction: "LONG",
        posture_strength: "lean",
        risk: { stop_loss: 292.33 },
        targets: [
          { label: "Trim", price: 253.39 },
          { label: "Exit", price: 236.27 },
        ],
        invalidation: ["Close above 292.33 (stop)"],
        levels: [
          { role: "support", price: 274.96, label: "Yesterday's High" },
          { role: "support", price: 263.66, label: "Yesterday's Low" },
          { role: "resistance", price: 302.36, label: "Resistance Pivot" },
          { role: "resistance", price: 308.74, label: "4H Swing High" },
        ],
      },
      timing: {
        bias: "COMPRESSION",
        posture: "ACCUMULATE_CAUTION",
        flash_headline: "Accumulate caution — compressed; avoid new shorts (44/100)",
        add_on_dips: true,
      },
      ticker: { atr_d: 13.86 },
    });

    expect(ctx.alignToPosture).toBe(true);
    expect(ctx.displayDir).toBe("LONG");
    expect(ctx.htfAltDir).toBe("SHORT");
    expect(ctx.sl).toBeLessThan(281.17);
    expect(ctx.sl).toBeGreaterThan(260);
    expect(ctx.targets[0].price).toBeGreaterThan(281.17);
    expect(ctx.invalidationLines[0]).toMatch(/below/i);
    expect(ctx.invalidationLines.some((l) => /292\.33/i.test(l))).toBe(true);
  });

  it("keeps HTF contract direction on enter stage", () => {
    const ctx = H.resolveTraderPlanDisplayContext({
      px: 281.17,
      stage: "enter_now",
      tradeIsOpen: false,
      postureDir: "LONG",
      postureStrength: "lean",
      predictionContract: {
        direction: "SHORT",
        risk: { stop_loss: 292.33 },
        targets: [{ label: "Trim", price: 253.39 }],
      },
      timing: { bias: "COMPRESSION", add_on_dips: true },
      ticker: { atr_d: 13.86 },
    });
    expect(ctx.alignToPosture).toBe(false);
    expect(ctx.displayDir).toBe("SHORT");
  });

  it("does not override when posture matches contract", () => {
    const ctx = H.resolveTraderPlanDisplayContext({
      px: 100,
      stage: "watch",
      tradeIsOpen: false,
      postureDir: "SHORT",
      postureStrength: "lean",
      predictionContract: {
        direction: "SHORT",
        risk: { stop_loss: 105 },
        targets: [{ label: "Trim", price: 95 }],
      },
      timing: { bias: "EXTENSION" },
      ticker: { atr_d: 2 },
    });
    expect(ctx.alignToPosture).toBe(false);
    expect(ctx.displayDir).toBe("SHORT");
  });
});
