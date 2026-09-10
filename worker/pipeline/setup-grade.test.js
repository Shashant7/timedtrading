import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  SETUP_GRADE_VERSION,
  evaluateSetupGrade,
  admitSetupGrade,
  isSetupGradeExemptPath,
  setupGradeEnabled,
  setupGradeFloor,
  gradeStructure,
  gradeTape,
  gradeMacro,
  gradeValue,
  gradeOfficer,
} from "./setup-grade.js";
import { beginSetupEvaluation } from "./setup-evidence.js";
import { buildTradeContext } from "./trade-context.js";
import { evaluateEntry } from "./tt-core-entry.js";

const NOW = Date.parse("2026-09-09T16:00:00Z");

function alignedPayload(overrides = {}) {
  const cloud = { bull: true, bear: false, above: true, below: false, inCloud: false, fastSlope: 0.1 };
  const tf = { stDir: 1, ema: { structure: 1 }, rsi: { r5: 50 }, ripster: { c34_50: cloud, c5_12: cloud, c8_9: cloud } };
  return structuredClone({
    ticker: "TEST", price: 102, rank: 100, score: 100, htf_score: 60, ltf_score: 40,
    rr: 3, completion: 0.2, phase_pct: 20, state: "HTF_BULL_LTF_BULL",
    setup_grade: "Prime", regime_class: "STRONG_BULL",
    regime: { combined: "STRONG_BULL" },
    regime_combined: "STRONG_BULL",
    focus: { conviction_score: 90 },
    tf_tech: { "10": tf, "15": tf, "30": tf, "1H": tf, "4H": tf, D: tf, W: tf },
    rvol_map: { "30": { vr: 1.5 } },
    daily_structure: { bull_stack: true, bear_stack: false, ath52w: {
      sample_size: 252, pct_below_high_252: 0, breakout_above_prev_high: true,
      tight_base_5d_pct: 2, prev_high: 101, prev_low: 98, prev_close: 100, prev_prev_close: 99,
    } },
    _theme_tilt: 1.2,
    _fv_tilt: 0.8,
    _officer_tilt: 0.5,
    _sector_rating: "overweight",
    ...overrides,
  });
}

describe("setup-grade pillars fail closed", () => {
  it("scores a fully aligned long at 10", () => {
    const g = evaluateSetupGrade(alignedPayload(), { side: "LONG" });
    expect(g.version).toBe(SETUP_GRADE_VERSION);
    expect(g.score).toBe(10);
    expect(g.reason).toBe("all_aligned");
    expect(g.parts.map((p) => p.id)).toEqual(["structure", "tape", "macro", "value", "officer"]);
  });

  it("does not treat missing structure, tape, or overlays as a pass", () => {
    expect(gradeStructure({}, "LONG").status).toBe("missing");
    expect(gradeTape({}, "LONG").status).toBe("missing");
    expect(gradeMacro({}).status).toBe("missing");
    expect(gradeValue({}).status).toBe("missing");
    expect(gradeOfficer({}, "LONG").status).toBe("missing");
    expect(evaluateSetupGrade({}, { side: "LONG" }).score).toBe(0);
  });

  it("does not credit opposing HTF state even with a same-side LTF label", () => {
    const long = gradeStructure({ state: "HTF_BEAR_LTF_BULL", daily_structure: {} }, "LONG");
    expect(long.points).toBe(0);
    expect(long.status).toBe("opposed");
    const short = gradeStructure({ state: "HTF_BULL_LTF_BEAR" }, "SHORT");
    expect(short.points).toBe(0);
  });

  it("accepts daily stack without a named state, and named state without stack", () => {
    expect(gradeStructure({ daily_structure: { bull_stack: true } }, "LONG").points).toBe(2);
    expect(gradeStructure({ state: "HTF_BULL_LTF_PULLBACK" }, "LONG").points).toBe(2);
    expect(gradeStructure({ state: "HTF_BEAR_LTF_BOUNCE" }, "SHORT").points).toBe(2);
  });

  it("requires observed rvol or a directional squeeze release", () => {
    expect(gradeTape({ rvol_map: { "30": { vr: 1.2 } } }, "LONG").points).toBe(2);
    expect(gradeTape({ rvol_map: { "30": { vr: 1.19 } } }, "LONG").points).toBe(0);
    expect(gradeTape({
      flags: { sq30_release: true },
      tf_tech: { "30": { stDir: 1 } },
    }, "LONG").points).toBe(2);
    expect(gradeTape({
      flags: { sq30_release: true },
      tf_tech: { "30": { stDir: -1 } },
    }, "LONG").status).toBe("opposed");
    expect(gradeTape({ flags: { sq30_release: true } }, "LONG").status).toBe("opposed");
  });

  it("uses shadow tilts as observed evidence and treats zero as flat, not missing", () => {
    expect(gradeMacro({ _theme_tilt_shadow: 2 }).points).toBe(2);
    expect(gradeValue({ _fv_tilt_shadow: 1 }).points).toBe(2);
    expect(gradeValue({ _fv_tilt: 0 }).status).toBe("flat");
    expect(gradeMacro({ _macro_wire_tilt: -1 }).status).toBe("opposed_or_flat");
  });

  it("lets sector rating stand in for officer tilt, side-aware", () => {
    expect(gradeOfficer({ _sector_rating: "overweight" }, "LONG").points).toBe(2);
    expect(gradeOfficer({ _sector_rating: "overweight" }, "SHORT").points).toBe(0);
    expect(gradeOfficer({ _sector_rating: "underweight" }, "SHORT").points).toBe(2);
    expect(gradeOfficer({ _officer_tilt: 0.4, _sector_rating: "underweight" }, "LONG").points).toBe(2);
  });
});

describe("setup-grade admission", () => {
  it("requires 6 of 10 by default and stamps the payload", () => {
    const d = alignedPayload({ _theme_tilt: null, _fv_tilt: null, _officer_tilt: null, _sector_rating: null });
    delete d._theme_tilt;
    delete d._fv_tilt;
    delete d._officer_tilt;
    delete d._sector_rating;
    beginSetupEvaluation(d, { side: "LONG", asOfTs: NOW });
    const blocked = admitSetupGrade(d, { side: "LONG", path: "tt_ath_breakout" });
    expect(blocked.score).toBe(4);
    expect(blocked.allow).toBe(false);
    expect(blocked.reason).toBe("setup_grade_below_floor:4<6");
    expect(d.__setup_grade.allow).toBe(false);
    expect(d.__setup_evaluation.setup_grade.score).toBe(4);

    d._fv_tilt = 1;
    const passed = admitSetupGrade(d, { side: "LONG", path: "tt_ath_breakout" });
    expect(passed.score).toBe(6);
    expect(passed.allow).toBe(true);
    expect(passed.reason).toBe("setup_grade_passed");
  });

  it("is on by default, killable, and exempts index/paper paths only", () => {
    expect(setupGradeEnabled({})).toBe(true);
    expect(setupGradeEnabled({ deep_audit_setup_grade_enabled: "false" })).toBe(false);
    expect(setupGradeFloor({})).toBe(6);
    expect(isSetupGradeExemptPath("tt_index_etf_swing")).toBe(true);
    expect(isSetupGradeExemptPath("tt_cloud_pivot_long")).toBe(true);
    expect(isSetupGradeExemptPath("tt_ath_breakout")).toBe(false);
    expect(isSetupGradeExemptPath("momentum_score")).toBe(false);

    const thin = { state: "HTF_BULL_LTF_BULL" };
    expect(admitSetupGrade(thin, { side: "LONG", path: "tt_pullback" }).allow).toBe(false);
    expect(admitSetupGrade(thin, {
      side: "LONG", path: "tt_pullback", daCfg: { deep_audit_setup_grade_enabled: "false" },
    }).reason).toBe("setup_grade_disabled");
    expect(admitSetupGrade(thin, { side: "LONG", path: "tt_cloud_pivot_long" }).reason).toBe("setup_grade_exempt_path");
  });

  it("rejects a core ATH that only has structure+tape through the live engine", () => {
    const d = alignedPayload();
    delete d._theme_tilt;
    delete d._fv_tilt;
    delete d._officer_tilt;
    delete d._sector_rating;
    d._env = { _entryEngine: "tt_core", _deepAuditConfig: { deep_audit_forming_pair_entry: "false" } };
    const result = evaluateEntry(buildTradeContext(d, NOW));
    expect(result.qualifies).toBe(false);
    expect(result.reason).toBe("setup_grade_below_floor:4<6");
    expect(d.__setup_grade.score).toBe(4);
  });

  it("still admits a convicted ATH through the live engine", () => {
    const d = alignedPayload();
    d._env = { _entryEngine: "tt_core", _deepAuditConfig: { deep_audit_forming_pair_entry: "false" } };
    const result = evaluateEntry(buildTradeContext(d, NOW));
    expect(result.qualifies, JSON.stringify({ reason: result.reason, grade: d.__setup_grade })).toBe(true);
    expect(d.__setup_grade.allow).toBe(true);
    expect(d.__setup_grade.score).toBe(10);
  });
});

describe("setup-grade wiring", () => {
  it("is redacted, persisted, and snapshotted with the existing setup evaluation", () => {
    const api = readFileSync(new URL("../api.js", import.meta.url), "utf8");
    expect(api).toContain('"__setup_evaluation"');
    expect(api).toContain('"__setup_grade"');
    const storage = readFileSync(new URL("../storage.js", import.meta.url), "utf8");
    expect(storage).toContain('"__setup_grade"');
    const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    expect(index).toContain("setup_grade: tickerData?.__setup_grade");
    expect(index).toContain("setup_grade: result.__setup_grade");
    expect(index.match(/admitSetupGrade/g)?.length).toBeGreaterThanOrEqual(1);
    const core = readFileSync(new URL("./tt-core-entry.js", import.meta.url), "utf8");
    expect(core).toContain("admitSetupGrade");
  });
});
