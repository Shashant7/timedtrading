import { describe, it, expect } from "vitest";
import {
  julyAutopsyGateBlock,
  julyAutopsyDefaultDeny,
  isHtfReclaimContext,
  exhaustTrimMinProfitPct,
} from "./july-autopsy-gates.js";
import { admitSetup } from "./phase-c-setup-admission.js";

describe("exhaustTrimMinProfitPct — ATR-scaled exhaustion trim floor", () => {
  // HALO Jul 22: $77.93 entry, ~3.2% daily ATR, trimmed 50% at +0.74% via
  // TD_HTF_EXHAUSTION on a move that ran to +8.35% MFE.
  const halo = { price: 78, atr: 2.5 };
  // NEU Jul 21: ~$780, ~1.9% ATR, trimmed 50% at +0.59% twelve minutes in.
  const neu = { price: 780, atr: 15 };

  it("blocks the HALO trim that banked 9% of an 8.35% move", () => {
    const floor = exhaustTrimMinProfitPct(halo, {}, 0.5);
    expect(floor).toBeGreaterThan(0.74);
  });

  it("blocks the NEU 12-minute trim at +0.59%", () => {
    const floor = exhaustTrimMinProfitPct(neu, {}, 0.5);
    expect(floor).toBeGreaterThan(0.59);
  });

  it("never drops below the absolute floor on a very quiet name", () => {
    expect(exhaustTrimMinProfitPct({ price: 100, atr: 0.2 }, {}, 0.5)).toBe(0.5);
  });

  it("caps the floor so a violently volatile name still trims", () => {
    const floor = exhaustTrimMinProfitPct({ price: 10, atr: 3 }, {}, 0.5);
    expect(floor).toBe(2.5);
  });

  it("respects a configured cap", () => {
    const floor = exhaustTrimMinProfitPct({ price: 10, atr: 3 }, { deep_audit_ja_exhaust_trim_max_floor_pct: 1.5 }, 0.5);
    expect(floor).toBe(1.5);
  });

  it("frac=0 restores the flat legacy floor", () => {
    expect(exhaustTrimMinProfitPct(halo, { deep_audit_ja_exhaust_trim_atr_frac: 0 }, 0.5)).toBe(0.5);
  });

  it("falls back to the flat floor when ATR or price is unavailable", () => {
    expect(exhaustTrimMinProfitPct({ price: 78 }, {}, 0.5)).toBe(0.5);
    expect(exhaustTrimMinProfitPct(null, {}, 0.5)).toBe(0.5);
  });
});

describe("admitSetup wildcard grade fallback (P8 fix)", () => {
  it("grade-less ATH breakout must clear the Prime bar when wildcard enabled", () => {
    // The July no-op: grade empty at admission → default allow. With
    // wildcard: unknown-grade ATH breakout in TRANSITIONAL regime rejects.
    const out = admitSetup({
      setup: "tt_ath_breakout", grade: "", direction: "LONG",
      regime: "TRANSITIONAL", rr: 2.5, allowWildcard: true,
    }, null);
    expect(out.allow).toBe(false);
    expect(out.matched_key).toBe("tt_ath_breakout:LONG:*");
  });

  it("grade-less ATH breakout in STRONG_BULL with rr>=2 passes the wildcard", () => {
    const out = admitSetup({
      setup: "tt_ath_breakout", grade: "", direction: "LONG",
      regime: "STRONG_BULL", rr: 2.4, allowWildcard: true,
    }, null);
    expect(out.allow).toBe(true);
  });

  it("without allowWildcard, legacy behavior unchanged (default allow)", () => {
    const out = admitSetup({
      setup: "tt_ath_breakout", grade: "", direction: "LONG",
      regime: "TRANSITIONAL", rr: 1.0,
    }, null);
    expect(out.allow).toBe(true);
    expect(out.reason).toBe("missing_inputs_default_allow");
  });

  it("exact grade rows still take precedence over the wildcard", () => {
    const out = admitSetup({
      setup: "tt_ath_breakout", grade: "Confirmed", direction: "LONG",
      regime: "STRONG_BULL", rr: 5, allowWildcard: true,
    }, null);
    expect(out.allow).toBe(false);
    expect(out.matched_key).toBe("tt_ath_breakout:LONG:Confirmed");
  });

  it("unknown setups without a wildcard row still default-allow", () => {
    const out = admitSetup({
      setup: "tt_htf_reclaim", grade: "", direction: "LONG",
      regime: "TRANSITIONAL", allowWildcard: true,
    }, null);
    expect(out.allow).toBe(true);
  });
});

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

describe("isHtfReclaimContext — time freshness (tuning pass 2)", () => {
  const base = (over = {}) => ({
    daily_structure: {
      pct_above_e21: 1.2, e21_slope_5d_pct: 0.3, above_e200: true,
      days_above_e21: 2, ...over,
    },
  });

  it("fresh reclaim (2 days above) qualifies", () => {
    expect(isHtfReclaimContext(base(), null, {})).toBe(true);
  });

  it("stale hover (7 days above) is NOT a reclaim (MTB 51-day drift case)", () => {
    expect(isHtfReclaimContext(base({ days_above_e21: 7 }), null, {})).toBe(false);
    expect(isHtfReclaimContext(base({ days_above_e21: 51 }), null, {})).toBe(false);
  });

  it("boundary: 5 days passes with the default cap", () => {
    expect(isHtfReclaimContext(base({ days_above_e21: 5 }), null, {})).toBe(true);
  });

  it("configurable cap", () => {
    expect(isHtfReclaimContext(base({ days_above_e21: 5 }), null, { deep_audit_ja_htf_reclaim_max_days_above: 3 })).toBe(false);
  });

  it("missing days_above_e21 (older snapshots) does not block", () => {
    expect(isHtfReclaimContext(base({ days_above_e21: null }), null, {})).toBe(true);
  });

  it("distance/slope/trend conditions still enforced", () => {
    expect(isHtfReclaimContext(base({ pct_above_e21: 4.0 }), null, {})).toBe(false);
    expect(isHtfReclaimContext(base({ e21_slope_5d_pct: -1.2 }), null, {})).toBe(false);
    expect(isHtfReclaimContext(base({ above_e200: false }), null, {})).toBe(false);
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
