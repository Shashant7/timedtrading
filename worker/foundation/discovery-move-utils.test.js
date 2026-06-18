import { describe, expect, it } from "vitest";
import { discoveryMoveAnchorTs, filterMissedDiscoveryMoves } from "./discovery-move-utils.js";

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
});
