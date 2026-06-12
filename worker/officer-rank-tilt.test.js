// worker/officer-rank-tilt.test.js
import { describe, it, expect } from "vitest";
import {
  ctoTiltFromRow,
  croNoteTiltFromText,
  lookupOfficerTilt,
  computeOfficerRankMap,
  CTO_MAX,
  CRO_NOTE_MAX,
} from "./officer-rank-tilt.js";

describe("ctoTiltFromRow", () => {
  it("rewards high regime-aligned upside probability", () => {
    const t = ctoTiltFromRow({
      ok: true,
      top_upside: [{ regime_adjusted_prob: 0.91 }],
      top_downside: [{ regime_adjusted_prob: 0.55 }],
    });
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(CTO_MAX);
  });

  it("returns 0 for failed rows", () => {
    expect(ctoTiltFromRow({ ok: false })).toBe(0);
  });
});

describe("croNoteTiltFromText", () => {
  it("detects bullish sector language", () => {
    const t = croNoteTiltFromText(
      "Healthcare leadership today fits our overweight stance and breakout strength.",
      { sector: "Health Care" },
    );
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(CRO_NOTE_MAX);
  });
});

describe("lookupOfficerTilt", () => {
  it("applies direction-aware CTO tilt for long-side HTF", () => {
    const map = computeOfficerRankMap({
      ctoRollup: {
        computed_at: Date.now(),
        results: [{
          ticker: "SPY",
          ok: true,
          top_upside: [{ label: "R1", price: 580, regime_adjusted_prob: 0.85 }],
          top_downside: [{ label: "P", price: 560, regime_adjusted_prob: 0.7 }],
        }],
      },
      croNote: null,
      gates: { cto: true, cro: true },
    });
    map.gates = { cto: true, cro: true };
    map.cto_rows = { SPY: map.cto_rows?.SPY || map.by_ticker?.SPY };
    map.cto_rows = {
      SPY: {
        ok: true,
        top_upside: [{ label: "R1", price: 580, regime_adjusted_prob: 0.85 }],
        top_downside: [{ label: "P", price: 560, regime_adjusted_prob: 0.7 }],
      },
    };
    const entry = lookupOfficerTilt(map, "SPY", 12);
    expect(entry).toBeTruthy();
    expect(entry.tilt).toBeGreaterThan(0);
  });
});
