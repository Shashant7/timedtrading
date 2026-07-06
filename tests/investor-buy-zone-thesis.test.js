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

describe("isInvestorBuyZoneThesis", () => {
  let helpers;

  beforeAll(() => {
    helpers = loadRailHelpers();
  });

  it("includes unowned accumulate thesis on radar", () => {
    expect(helpers.isInvestorBuyZoneThesis({ stage: "accumulate", score: 70 }, "TEST")).toBe(true);
  });

  it("excludes research_avoid kanban", () => {
    expect(helpers.isInvestorBuyZoneThesis({ stage: "research_avoid" }, "BAD")).toBe(false);
  });

  it("excludes exited stage", () => {
    expect(helpers.isInvestorBuyZoneThesis({ stage: "exited" }, "GONE")).toBe(false);
  });

  it("excludes recently exited cooldown even when raw stage is still accumulate", () => {
    expect(helpers.isInvestorBuyZoneThesis({
      stage: "accumulate",
      recentlyExited: { closed_at: Date.now() - 3600000 },
    }, "IESC")).toBe(false);
  });

  it("excludes exited kanban from resolveInvestorKanbanStage fallback", () => {
    const kanban = helpers.resolveInvestorKanbanStage({
      stage: "accumulate",
      recentlyExited: { last_action_type: "SELL" },
    });
    expect(kanban).toBe("exited");
    expect(helpers.isInvestorBuyZoneThesis({
      stage: "accumulate",
      recentlyExited: { last_action_type: "SELL" },
    }, "IONQ")).toBe(false);
  });
});
