import { describe, it, expect } from "vitest";
import {
  isLongTermQueueStage,
  countModelLaneCards,
  countInvestorOwnedForModelBadge,
  buildModelBriefNarrative,
} from "../react-app/model-lane-counts.js";

describe("model-lane-counts", () => {
  it("treats accumulate / accumulate_queued as Queuing Up, not research_on_watch", () => {
    expect(isLongTermQueueStage("accumulate")).toBe(true);
    expect(isLongTermQueueStage("accumulate_queued")).toBe(true);
    expect(isLongTermQueueStage("research_on_watch")).toBe(false);
    expect(isLongTermQueueStage("core_hold")).toBe(false);
  });

  it("counts open cards as bought + defend + trim", () => {
    const counts = countModelLaneCards({
      queue: [{}, {}, {}],
      bought: [{}, {}],
      defend: [{}],
      trim: [],
      exit: [{}],
    });
    expect(counts.queue).toBe(3);
    expect(counts.bought).toBe(2);
    expect(counts.defend).toBe(1);
    expect(counts.open).toBe(3);
    expect(counts.exit).toBe(1);
  });

  it("Model badge investor leg counts owned only (not unowned accumulate-ready)", () => {
    const n = countInvestorOwnedForModelBadge([
      { ticker: "AAPL", stage: "core_hold", position: { owned: true } },
      { ticker: "MSFT", stage: "accumulate", actionTier: "act_now", position: { owned: false } },
      { ticker: "NVDA", stage: "reduce", position: { owned: true } },
      { ticker: "OLD", stage: "exited", position: { owned: false } },
    ]);
    expect(n).toBe(2);
  });

  it("brief narrative uses Queuing Up count (not legacy Setup wording)", () => {
    const text = buildModelBriefNarrative({
      bought: 3,
      defend: 1,
      trim: 0,
      queue: 45,
      exit: 1,
      open: 4,
    });
    expect(text).toContain("holding 3");
    expect(text).toContain("defending 1");
    expect(text).toContain("45 queuing up");
    expect(text).not.toContain("setup watchlist");
    expect(text).toContain("1 recently exited");
  });
});
