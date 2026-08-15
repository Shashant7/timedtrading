import { describe, it, expect } from "vitest";
import { julyAutopsyGateBlock, julyAutopsyDefaultDeny } from "./july-autopsy-gates.js";

const ON = { deep_audit_ja_opening_gate: "true", deep_audit_ja_location_gate: "true", deep_audit_ja_expected_move_gate: "true" };

describe("julyAutopsyGateBlock — flags default OFF", () => {
  it("returns null for everything when flags are off", () => {
    expect(julyAutopsyGateBlock({
      d: { pdz_zone_D: "premium", pdz_zone_4h: "premium", __entry_divergence_summary: { adverse_rsi: { count: 2 } } },
      daCfg: {},
      path: "tt_ath_breakout",
      direction: "LONG",
      etParts: { hour: 9, minute: 31 },
    })).toBeNull();
  });
});

describe("G1 opening window (P2)", () => {
  it("blocks a 9:31 TT-setup entry (XLI Jul 1 case)", () => {
    const block = julyAutopsyGateBlock({
      d: {}, daCfg: ON, path: "tt_ath_breakout", direction: "LONG",
      etParts: { hour: 9, minute: 31 },
    });
    expect(block?.reason).toBe("ja_opening_window_block");
  });

  it("allows 9:47 and 11:49 entries", () => {
    for (const minuteHour of [[9, 47], [11, 49]]) {
      const block = julyAutopsyGateBlock({
        d: {}, daCfg: { deep_audit_ja_opening_gate: "true" }, path: "tt_n_test_support",
        direction: "LONG", etParts: { hour: minuteHour[0], minute: minuteHour[1] },
      });
      expect(block).toBeNull();
    }
  });

  it("honors a custom end minute", () => {
    const block = julyAutopsyGateBlock({
      d: {}, daCfg: { deep_audit_ja_opening_gate: "true", deep_audit_ja_opening_gate_end_minute: 35 },
      path: "tt_ath_breakout", direction: "LONG", etParts: { hour: 9, minute: 36 },
    });
    expect(block).toBeNull();
  });
});

describe("G2 location gate (P3)", () => {
  it("blocks LONG in dual-premium zones with an adverse divergence (MTB Jul 7 profile)", () => {
    const block = julyAutopsyGateBlock({
      d: {
        pdz_zone_D: "premium_approach",
        pdz_zone_4h: "premium_approach",
        __entry_divergence_summary: { adverse_phase: { count: 1, tfs: ["4h"] } },
      },
      daCfg: { deep_audit_ja_location_gate: "true" },
      path: "tt_ath_breakout", direction: "LONG", etParts: { hour: 10, minute: 0 },
    });
    expect(block?.reason).toBe("ja_location_premium_adverse_div_block");
  });

  it("blocks f4-severe in CHOPPY regime even with mixed zones (JCI Jul 15 profile)", () => {
    const block = julyAutopsyGateBlock({
      d: {
        pdz_zone_D: "premium_approach",
        pdz_zone_4h: "discount_approach",
        regime_class: "CHOPPY",
        __entry_divergence_summary: { adverse_rsi: { count: 1 }, adverse_phase: { count: 2, tfs: ["w", "4h"] } },
      },
      daCfg: { deep_audit_ja_location_gate: "true" },
      path: "tt_range_reversal_long", direction: "LONG", etParts: { hour: 11, minute: 4 },
    });
    expect(block?.reason).toBe("ja_f4_severe_unstable_regime_block");
  });

  it("allows clean-signal LONGs (BRK-B profile: no adverse divs)", () => {
    const block = julyAutopsyGateBlock({
      d: {
        pdz_zone_D: "premium", pdz_zone_4h: "premium",
        __entry_divergence_summary: { adverse_rsi: { count: 0 }, adverse_phase: { count: 0 } },
      },
      daCfg: { deep_audit_ja_location_gate: "true" },
      path: "tt_n_test_support", direction: "LONG", etParts: { hour: 10, minute: 0 },
    });
    expect(block).toBeNull();
  });

  it("does not apply to SHORTs", () => {
    const block = julyAutopsyGateBlock({
      d: {
        pdz_zone_D: "premium", pdz_zone_4h: "premium",
        __entry_divergence_summary: { adverse_rsi: { count: 2 } },
      },
      daCfg: { deep_audit_ja_location_gate: "true" },
      path: "tt_atl_breakdown", direction: "SHORT", etParts: { hour: 10, minute: 0 },
    });
    expect(block).toBeNull();
  });

  it("reads anyActive-shaped summaries (no count field)", () => {
    const block = julyAutopsyGateBlock({
      d: {
        pdz_zone_D: "premium", pdz_zone_4h: "premium_approach",
        __entry_divergence_summary: { adverse_rsi: { anyActive: true, tfs: ["1h", "4h"] } },
      },
      daCfg: { deep_audit_ja_location_gate: "true" },
      path: "tt_ath_breakout", direction: "LONG", etParts: { hour: 12, minute: 0 },
    });
    expect(block?.reason).toBe("ja_location_premium_adverse_div_block");
  });
});

describe("G3 expected move (P11)", () => {
  it("blocks a GRNY-class slow mover (ATR% below floor)", () => {
    const block = julyAutopsyGateBlock({
      d: { price: 27.64, atr: 0.25 }, // 0.90% ATR
      daCfg: { deep_audit_ja_expected_move_gate: "true" },
      path: "tt_n_test_support", direction: "LONG", etParts: { hour: 10, minute: 0 },
    });
    expect(block?.reason).toBe("ja_expected_move_too_small");
    expect(block.detail.atr_pct).toBeLessThan(1.4);
  });

  it("passes a normal mover and honors a custom floor", () => {
    const d = { price: 134.6, atr: 4.0 }; // 2.97% ATR
    expect(julyAutopsyGateBlock({
      d, daCfg: { deep_audit_ja_expected_move_gate: "true" },
      path: "tt_n_test_support", direction: "LONG", etParts: { hour: 10, minute: 0 },
    })).toBeNull();
    const strict = julyAutopsyGateBlock({
      d, daCfg: { deep_audit_ja_expected_move_gate: "true", deep_audit_ja_expected_move_min_atr_pct: 3.5 },
      path: "tt_n_test_support", direction: "LONG", etParts: { hour: 10, minute: 0 },
    });
    expect(strict?.reason).toBe("ja_expected_move_too_small");
  });

  it("does not block when price/ATR are missing (no false rejects)", () => {
    expect(julyAutopsyGateBlock({
      d: { price: 0, atr: 0 }, daCfg: { deep_audit_ja_expected_move_gate: "true" },
      path: "tt_n_test_support", direction: "LONG", etParts: { hour: 10, minute: 0 },
    })).toBeNull();
  });
});

describe("G4 default deny (P8)", () => {
  it("denies no_matrix_entry allows when flag on (Speculative-ATH July hole)", () => {
    const deny = julyAutopsyDefaultDeny(
      { deep_audit_ja_default_deny: "true" },
      { allow: true, reason: "no_matrix_entry", matched_key: "tt_ath_breakout:LONG:Speculative" },
    );
    expect(deny?.reason).toBe("ja_admission_default_deny");
    expect(deny.detail.matched_key).toBe("tt_ath_breakout:LONG:Speculative");
  });

  it("denies missing_inputs_default_allow (grade empty at admission)", () => {
    const deny = julyAutopsyDefaultDeny(
      { deep_audit_ja_default_deny: "true" },
      { allow: true, reason: "missing_inputs_default_allow" },
    );
    expect(deny?.reason).toBe("ja_admission_default_deny");
  });

  it("leaves explicit passes and rejections alone", () => {
    expect(julyAutopsyDefaultDeny(
      { deep_audit_ja_default_deny: "true" },
      { allow: true, reason: "setup_admission_passed: tt_pullback:LONG:Prime." },
    )).toBeNull();
    expect(julyAutopsyDefaultDeny(
      { deep_audit_ja_default_deny: "true" },
      { allow: false, reason: "setup_admission_blocked_always: x" },
    )).toBeNull();
  });

  it("is a no-op when the flag is off", () => {
    expect(julyAutopsyDefaultDeny({}, { allow: true, reason: "no_matrix_entry" })).toBeNull();
  });
});
