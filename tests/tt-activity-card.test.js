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

  it("writes a compact headline without repeating the ticker", () => {
    expect(card.buildActivityHeadline({
      actionLabel: "BUY",
      size: "12.6 sh @ $41.20",
    })).toBe("BUY · 12.6 sh @ $41.20");
    expect(card.buildActivityHeadline({
      actionLabel: "BUY",
    })).toBe("BUY");
  });

  it("keeps the legacy punchline helper for callers that still use it", () => {
    expect(card.buildActivityPunchline({
      actionLabel: "BUY",
      sym: "BNY",
      detail: "12.6 sh @ $41.20",
    })).toBe("BUY on BNY — 12.6 sh @ $41.20");
  });

  it("maps FORMING / WATCH / ADD to Buy on the activity chip", () => {
    expect(card.normalizeDisplayAction({ label: "FORMING" })).toBe("BUY");
    expect(card.normalizeDisplayAction({ label: "WATCH" })).toBe("BUY");
    expect(card.normalizeDisplayAction({ label: "ADD", evType: "ADD" })).toBe("BUY");
    expect(card.normalizeDisplayAction({ label: "ENTER", evType: "ENTRY" })).toBe("BUY");
    expect(card.normalizeDisplayAction({ label: "EXIT", evType: "EXIT" })).toBe("SELL");
    expect(card.normalizeDisplayAction({ label: "TRIM", evType: "TRIM" })).toBe("TIGHTEN");
  });

  it("joins scan bits with middots", () => {
    expect(card.buildActivityScanLine({
      reason: "5/12 cloud lost — momentum flipping",
      pnlText: "+2.40%",
      timeText: "12m",
    })).toBe("5/12 cloud lost — momentum flipping · +2.40% · 12m");
  });

  it("colors action labels like the day-trade strip", () => {
    expect(card.activityActionChipClass("BUY")).toContain("ds-chip--up");
    expect(card.activityActionChipClass("SELL")).toContain("ds-chip--dn");
    expect(card.activityActionChipClass("BUY")).toContain("ds-chip--up");
    expect(card.activityPunchClass("BUY")).toContain("tt-activity-card__action");
    expect(card.activityPunchClass("BUY")).toContain("tt-dt-plan__k--buy");
    expect(card.activityPunchClass("TIGHTEN")).toContain("tt-dt-plan__k--sell");
    expect(card.activityActionToneClass("ENTER")).toBe("tt-dt-plan__k--buy");
    expect(card.activityDirChipClass("LONG")).toContain("ds-chip--up");
  });
});
