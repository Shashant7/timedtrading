import { describe, expect, it } from "vitest";
import {
  discoveryMoveAnchorTs,
  filterMissedDiscoveryMoves,
  moveReplayDateRange,
  subtractCalendarDays,
} from "./discovery-move-utils.js";

describe("discovery move utils", () => {
  it("derives start_ts from start_date when missing", () => {
    const ts = discoveryMoveAnchorTs({ start_date: "2026-04-22" });
    expect(Number.isFinite(ts)).toBe(true);
  });

  it("filters missed moves with valid anchors", () => {
    const moves = filterMissedDiscoveryMoves([
      { ticker: "SPY", capture: "MISSED", start_date: "2026-04-22", move_atr: 5 },
      { ticker: "BAD", capture: "MISSED" },
      { ticker: "QQQ", capture: "CAPTURED", start_date: "2026-04-22" },
    ]);
    expect(moves).toHaveLength(1);
    expect(moves[0].ticker).toBe("SPY");
    expect(moves[0].start_ts).toBeTruthy();
  });

  it("builds weekday replay sessions with pre-entry calendar days", () => {
    expect(subtractCalendarDays("2026-04-22", 5)).toBe("2026-04-17");
    const range = moveReplayDateRange(
      { start_date: "2026-04-22", end_date: "2026-04-24" },
      { preEntryDays: 2 },
    );
    expect(range.startDate).toBe("2026-04-20");
    expect(range.endDate).toBe("2026-04-24");
    expect(range.sessions).toEqual(["2026-04-20", "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24"]);
  });
});
