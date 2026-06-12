// worker/officer-rank-tilt.test.js
//
// v2 (2026-06-12): the CRO component now consumes the STRUCTURED
// tactical overlay (cro:tactical_overrides — theme keys + direction)
// instead of regex-scanning the daily note's prose, which netted zero
// on mixed-tone notes and hit every mentioned sector on single-tone
// ones. Same convention as the promotion queue's W_TACTICAL nudge.

import { describe, it, expect } from "vitest";
import {
  ctoTiltFromRow,
  buildOverlayDirMaps,
  croOverlayTilt,
  lookupOfficerTilt,
  computeOfficerRankMap,
  CTO_MAX,
  CRO_NOTE_MAX,
  OFFICER_TOTAL_MAX,
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

  it("penalizes high downside probability and clamps at ±CTO_MAX", () => {
    const t = ctoTiltFromRow({
      ok: true,
      top_upside: [{ regime_adjusted_prob: 0.5 }],
      top_downside: [{ regime_adjusted_prob: 0.95 }],
    });
    expect(t).toBeLessThan(0);
    expect(Math.abs(t)).toBeLessThanOrEqual(CTO_MAX);
  });

  it("returns 0 for failed rows", () => {
    expect(ctoTiltFromRow({ ok: false })).toBe(0);
  });
});

describe("CRO tactical overlay tilt (structured)", () => {
  const blob = {
    tactical_title: "MAGS broke trend; favor software over semis",
    tactical_signals: [
      { signal: "igv_over_smh", direction: "favor / rotate into", affected_tier1_themes: ["ai_software"] },
      { signal: "semis_caution", direction: "caution / trim", affected_tier1_themes: ["ai_infra_semicap"], affected_sectors_overweight: [] },
      { signal: "financials_ow", direction: "add", affected_tier1_themes: [], affected_sectors_overweight: ["Financials"] },
    ],
  };

  it("builds direction maps from overlay signals", () => {
    const o = buildOverlayDirMaps(blob);
    expect(o.themeDir.get("ai_software")).toBe(1);
    expect(o.themeDir.get("ai_infra_semicap")).toBe(-1);
    expect(o.sectorDir.get("Financials")).toBe(1);
    expect(o.signals_count).toBe(3);
  });

  it("tilts a favored-theme ticker positive and a cautioned one negative", () => {
    const o = buildOverlayDirMaps(blob);
    expect(croOverlayTilt(o, { themes: ["ai_software"] })).toBe(CRO_NOTE_MAX);
    expect(croOverlayTilt(o, { themes: ["ai_infra_semicap"] })).toBe(-CRO_NOTE_MAX);
    expect(croOverlayTilt(o, { themes: ["space_tech"] })).toBe(0);
    expect(croOverlayTilt(o, { themes: [], sector: "Financials" })).toBe(CRO_NOTE_MAX);
  });

  it("returns 0 with no overlay signals", () => {
    const o = buildOverlayDirMaps(null);
    expect(croOverlayTilt(o, { themes: ["ai_software"] })).toBe(0);
  });
});

describe("lookupOfficerTilt", () => {
  const map = computeOfficerRankMap({
    ctoRollup: {
      computed_at: Date.now(),
      results: [{
        ticker: "SPY",
        ok: true,
        top_upside: [{ label: "R1", price: 580, regime_adjusted_prob: 0.85 }],
        top_downside: [{ label: "P", price: 560, regime_adjusted_prob: 0.55 }],
      }],
    },
    tacticalOverlay: {
      tactical_signals: [
        { signal: "sw", direction: "favor", affected_tier1_themes: ["ai_software"] },
      ],
    },
    gates: { cto: true, cro: true },
  });

  it("applies direction-aware CTO tilt for long-side HTF", () => {
    const entry = lookupOfficerTilt(map, "SPY", 12);
    expect(entry).toBeTruthy();
    expect(entry.tilt).toBeGreaterThan(0);
    expect(entry.cto_upside?.label).toBe("R1");
  });

  it("inverts for short-side HTF (hot levels hurt shorts)", () => {
    const entry = lookupOfficerTilt(map, "SPY", -12);
    expect(entry.tilt).toBeLessThan(0);
  });

  it("combines CTO + overlay and clamps at ±OFFICER_TOTAL_MAX", () => {
    // SNOW is in ai_software (overlay +2) — no CTO row, overlay only.
    const entry = lookupOfficerTilt(map, "SNOW", 10);
    expect(entry).toBeTruthy();
    expect(entry.cro).toBe(CRO_NOTE_MAX);
    expect(Math.abs(entry.tilt)).toBeLessThanOrEqual(OFFICER_TOTAL_MAX);
  });

  it("returns null when neither source has signal", () => {
    expect(lookupOfficerTilt(map, "KO", 10)).toBe(null);
  });

  it("respects gates (shadow semantics handled by caller)", () => {
    const gatedMap = computeOfficerRankMap({
      ctoRollup: map ? { computed_at: 1, results: [map.cto_rows.SPY] } : null,
      tacticalOverlay: null,
      gates: { cto: false, cro: false },
    });
    // cto gate off → enabled flag false; lookup yields no cto component.
    expect(gatedMap.enabled.cto).toBe(false);
    expect(gatedMap.overlay).toBe(null);
  });
});
