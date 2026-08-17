import { describe, it, expect } from "vitest";
import {
  julyAutopsyGateBlock,
  julyAutopsyDefaultDeny,
  isHtfReclaimContext,
  exhaustTrimMinProfitPct,
  structStopCushion,
} from "./july-autopsy-gates.js";
import { admitSetup } from "./phase-c-setup-admission.js";

describe("exhaustTrimMinProfitPct — ATR-scaled exhaustion trim floor", () => {
  // HALO Jul 22: $77.93 entry, ~3.2% daily ATR, trimmed 50% at +0.74% via
  // TD_HTF_EXHAUSTION on a move that ran to +8.35% MFE.
  const halo = { price: 78, atr: 2.5 };
  // NEU Jul 21: ~$780, ~1.9% ATR, trimmed 50% at +0.59% twelve minutes in.
  const neu = { price: 780, atr: 15 };
  const ON = { deep_audit_ja_exhaust_trim_atr_frac: 0.35 };

  it("is DISABLED by default (validated negative in the July replay)", () => {
    expect(exhaustTrimMinProfitPct(halo, {}, 0.5)).toBe(0.5);
    expect(exhaustTrimMinProfitPct(halo, { deep_audit_ja_exhaust_trim_atr_frac: 0 }, 0.5)).toBe(0.5);
  });

  it("when enabled, blocks the HALO trim that banked 9% of an 8.35% move", () => {
    expect(exhaustTrimMinProfitPct(halo, ON, 0.5)).toBeGreaterThan(0.74);
  });

  it("when enabled, blocks the NEU 12-minute trim at +0.59%", () => {
    expect(exhaustTrimMinProfitPct(neu, ON, 0.5)).toBeGreaterThan(0.59);
  });

  it("never drops below the absolute floor on a very quiet name", () => {
    expect(exhaustTrimMinProfitPct({ price: 100, atr: 0.2 }, ON, 0.5)).toBe(0.5);
  });

  it("caps the floor so a violently volatile name still trims", () => {
    expect(exhaustTrimMinProfitPct({ price: 10, atr: 3 }, ON, 0.5)).toBe(2.5);
  });

  it("respects a configured cap", () => {
    const cfg = { ...ON, deep_audit_ja_exhaust_trim_max_floor_pct: 1.5 };
    expect(exhaustTrimMinProfitPct({ price: 10, atr: 3 }, cfg, 0.5)).toBe(1.5);
  });

  it("falls back to the flat floor when ATR or price is unavailable", () => {
    expect(exhaustTrimMinProfitPct({ price: 78 }, ON, 0.5)).toBe(0.5);
    expect(exhaustTrimMinProfitPct(null, ON, 0.5)).toBe(0.5);
  });
});

describe("structStopCushion — stop inside the h1 EMA-233 noise band", () => {
  const ON = { deep_audit_ja_struct_stop_guard: "true" };

  // NEU Jul 27 (the save): LONG, stop 770.54 sat 0.55% below the hourly
  // 233 at 774.81. The Jul 29 test bottomed at 770.00 — a 0.07% pierce past
  // the stop — the level HELD, and NEU ran +24.7% without us.
  const neu = { direction: "LONG", sl: 770.54, level: 774.81, atrPct: 1.1, daCfg: ON };
  const neuOvershoot = (770.54 - 770.00) / 770.54;

  // CF Aug 3 (the control): LONG, stop 121.21 just under the 233 at 122.14,
  // and price flushed to 119.89 — 1.09% through the stop — and kept going.
  // The guard must NOT hold that one.
  const cf = { direction: "LONG", sl: 121.21, level: 122.14, atrPct: 1.0, daCfg: ON };
  const cfOvershoot = (121.21 - 119.89) / 121.21;

  it("is OFF by default", () => {
    expect(structStopCushion({ ...neu, daCfg: {} })).toBe(0);
    expect(structStopCushion({ ...neu, daCfg: { deep_audit_ja_struct_stop_guard: "false" } })).toBe(0);
  });

  it("NEU Jul 27: the 0.07% level-test pierce defers instead of exiting", () => {
    const cushion = structStopCushion(neu);
    expect(cushion).toBeGreaterThan(neuOvershoot);
    expect(cushion).toBeLessThanOrEqual(0.01);
  });

  it("CF Aug 3: the 1.09% flush through the band still exits", () => {
    const cushion = structStopCushion(cf);
    expect(cushion).toBeGreaterThan(0);
    expect(cfOvershoot).toBeGreaterThan(cushion);
  });

  it("no cushion when the stop already clears the noise band", () => {
    // Stop 3% below the level — a breach there IS a confirmed break.
    expect(structStopCushion({ ...neu, sl: 751.57 })).toBe(0);
  });

  it("no cushion when the stop is far above the level (level not in play)", () => {
    expect(structStopCushion({ ...neu, sl: 800, level: 700 })).toBe(0);
  });

  it("no cushion when the level is missing (thin h1 history)", () => {
    expect(structStopCushion({ ...neu, level: undefined })).toBe(0);
    expect(structStopCushion({ ...neu, level: 0 })).toBe(0);
  });

  it("falls back to a 1% band when hourly ATR is unavailable", () => {
    const cushion = structStopCushion({ ...neu, atrPct: undefined });
    expect(cushion).toBeGreaterThan(0);
    // band floor = 774.81 * 0.99 = 767.06 → (770.54 - 767.06) / 770.54
    expect(cushion).toBeCloseTo((770.54 - 774.81 * 0.99) / 770.54, 6);
  });

  it("caps the cushion at the configured max", () => {
    const cfg = { ...ON, deep_audit_ja_struct_stop_max_cushion_pct: 0.3 };
    // Huge band: stop barely below level → uncapped cushion would be ~2%
    const cushion = structStopCushion({ direction: "LONG", sl: 774, level: 774.81, atrPct: 2.0, daCfg: cfg });
    expect(cushion).toBeCloseTo(0.003, 6);
  });

  it("SHORT mirror: stop inside the band above the level defers", () => {
    // SHORT with stop 0.4% above the 233 — the mirrored NEU shape.
    const cushion = structStopCushion({ direction: "SHORT", sl: 100.4, level: 100, atrPct: 1.0, daCfg: ON });
    expect(cushion).toBeGreaterThan(0);
    // band ceiling 101 → (101 - 100.4) / 100.4
    expect(cushion).toBeCloseTo((101 - 100.4) / 100.4, 6);
  });

  it("SHORT: stop already beyond the band ceiling gets no cushion", () => {
    expect(structStopCushion({ direction: "SHORT", sl: 101.5, level: 100, atrPct: 1.0, daCfg: ON })).toBe(0);
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
