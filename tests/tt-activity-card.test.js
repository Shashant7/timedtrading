// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadActivityStrip() {
  const src = readFileSync(join(process.cwd(), "react-app/tt-activity-strip.js"), "utf8");
  // eslint-disable-next-line no-eval
  eval(src);
  return globalThis.TTActivityCard;
}

describe("TTActivityCard", () => {
  let card;

  beforeAll(() => {
    card = loadActivityStrip();
  });

  it("writes punchlines in day-trade grammar", () => {
    expect(card.buildActivityPunchline({
      actionLabel: "FORMING",
      sym: "BNY",
      detail: "12.6 sh @ $41.20",
    })).toBe("FORMING on BNY — 12.6 sh @ $41.20");
    expect(card.buildActivityPunchline({
      actionLabel: "BUY",
      sym: "AXON",
    })).toBe("BUY on AXON");
  });

  it("joins scan bits with middots", () => {
    expect(card.buildActivityScanLine({
      reason: "5/12 cloud lost — momentum flipping",
      pnlText: "+2.40%",
      timeText: "12m",
    })).toBe("5/12 cloud lost — momentum flipping · +2.40% · 12m");
  });

  it("colors action chips like the day-trade strip", () => {
    expect(card.activityActionChipClass("BUY")).toContain("ds-chip--up");
    expect(card.activityActionChipClass("SELL")).toContain("ds-chip--dn");
    expect(card.activityActionChipClass("FORMING")).toContain("ds-chip--accent");
    expect(card.activityPunchClass("BUY")).toContain("tt-dt-plan__k--buy");
    expect(card.activityPunchClass("TIGHTEN")).toContain("tt-dt-plan__k--sell");
    expect(card.activityDirChipClass("LONG")).toContain("ds-chip--up");
  });
});
