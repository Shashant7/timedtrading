import { describe, it, expect } from "vitest";
import {
  computeSessionContextBanner,
  buildReleasedMacroPromptBlock,
  liveDayPctFromPriceFeedRow,
} from "./daily-brief.js";

describe("computeSessionContextBanner", () => {
  it("flags faded gap when SPY stabilizes after pre-market gap-down brief", () => {
    const slot = {
      type: "morning",
      marketSnapshot: { premarketGap: true, spyDp: -1.2 },
    };
    const pf = { SPY: { p: 601.2, pc: 600, dp: 0.19, dc: 1.14, p_ts: Date.now() } };
    const banner = computeSessionContextBanner(slot, pf, true, Date.parse("2026-06-24T15:00:00.000Z"));
    expect(banner).not.toBeNull();
    expect(banner.kind).toBe("gap_faded");
    expect(banner.spyLiveDp).toBe(0.19);
    expect(banner.message).toMatch(/Session update/);
  });

  it("returns null when gap narrative still matches live tape", () => {
    const slot = {
      type: "morning",
      marketSnapshot: { premarketGap: true, spyDp: -1.1 },
    };
    const pf = { SPY: { p: 594, pc: 600, dp: -1.0, dc: -6, p_ts: Date.now() } };
    const banner = computeSessionContextBanner(slot, pf, true, Date.parse("2026-06-24T15:00:00.000Z"));
    expect(banner).toBeNull();
  });
});

describe("buildReleasedMacroPromptBlock", () => {
  it("includes actual PCE print when present", () => {
    const block = buildReleasedMacroPromptBlock([
      {
        event: "May PCE Deflator",
        date: "2026-06-25",
        time: "08:30",
        impact: "high",
        actual: "+0.2%",
        estimate: "+0.3%",
      },
    ]);
    expect(block).toMatch(/RELEASED TODAY/);
    expect(block).toMatch(/Actual: 0\.20%/);
    expect(block).toMatch(/ALREADY PRINTED/);
  });
});

describe("liveDayPctFromPriceFeedRow RTH", () => {
  it("uses dp during regular session", () => {
    expect(liveDayPctFromPriceFeedRow({ p: 601, dp: 0.19, p_ts: Date.now() }, true)).toBe(0.19);
  });
});
