import { describe, it, expect } from "vitest";
import {
  julyAutopsyGateBlock,
  julyAutopsyDefaultDeny,
  isHtfReclaimContext,
  exhaustTrimMinProfitPct,
  structStopCushion,
  ltfStructureBlock,
} from "./july-autopsy-gates.js";
import { admitSetup } from "./phase-c-setup-admission.js";
import { tapeAlignmentBlock } from "./july-autopsy-gates.js";

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

  it("grade-less ATH breakout in STRONG_BULL with rr>=2 and conviction passes", () => {
    const out = admitSetup({
      setup: "tt_ath_breakout", grade: "", direction: "LONG",
      regime: "STRONG_BULL", rr: 2.4, conviction: 4, allowWildcard: true,
    }, null);
    expect(out.allow).toBe(true);
  });

  it("grade-less ATH breakout fails closed when conviction is missing", () => {
    const out = admitSetup({
      setup: "tt_ath_breakout", grade: "", direction: "LONG",
      regime: "STRONG_BULL", rr: 2.4, allowWildcard: true,
    }, null);
    expect(out.allow).toBe(false);
    expect(out.reason).toMatch(/conviction_too_low/);
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

  it("grade-less index swing uses the Prime bar instead of default-allow", () => {
    const blocked = admitSetup({
      setup: "tt_index_etf_swing", grade: "", direction: "LONG",
      regime: "TRANSITIONAL", rr: 3, allowWildcard: true,
    }, null);
    expect(blocked.allow).toBe(false);
    expect(blocked.matched_key).toBe("tt_index_etf_swing:LONG:*");

    const pass = admitSetup({
      setup: "tt_index_etf_swing", grade: "", direction: "LONG",
      regime: "STRONG_BULL", rr: 2.1, allowWildcard: true,
    }, null);
    expect(pass.allow).toBe(true);
  });

  it("restricted plays fail closed when wildcard is on and no row matches", () => {
    const out = admitSetup({
      setup: "tt_ath_breakout", grade: "", direction: "LONG",
      regime: "STRONG_BULL", rr: 3, conviction: 4, allowWildcard: true,
    }, {});
    expect(out.allow).toBe(false);
    expect(out.reason).toMatch(/play_catalog_restricted/);
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

describe("ltfStructureBlock — LTF structure confirmation (pinned live entries)", () => {
  const ON = { deep_audit_ja_ltf_structure_confirm: "true" };
  // Values from live direction_accuracy entry snapshots. Snapshot supertrend
  // is +1=bull; tf_tech stDir is INVERTED (+1=bear), so signs are flipped here.

  // DE Jul 29 (TT Support Bounce, −$95): 15m/30m struct −1 + bear ST,
  // hourly struct 0.221 with bear ST. The knife catch this gate exists for.
  const de = {
    side: "LONG",
    struct15: -1, st15: 1, rsi15: 39.7,
    struct30: -1, st30: 1, rsi30: 39.7,
    struct1h: 0.221, st1h: 1,
    daCfg: ON,
  };
  // WM Jul 29 (TT ATH Breakout, −$108): structure broken on 15m/30m even
  // though supertrend was still bull; hourly weak (0.221).
  const wm = {
    side: "LONG",
    struct15: -1, st15: -1, rsi15: 44.9,
    struct30: -1, st30: -1, rsi30: 47.3,
    struct1h: 0.221, st1h: -1,
    daCfg: ON,
  };
  // PH Aug (TT ATH Breakout, −$12): 15m struct −1; 30m struct only −0.04
  // but bear ST — caught by the (st bear && struct < 0) leg.
  const phLoss = {
    side: "LONG",
    struct15: -1, st15: 1, rsi15: 38.4,
    struct30: -0.04, st30: 1, rsi30: 40.1,
    struct1h: 0.4, st1h: 1,
    daCfg: ON,
  };
  // RTX Aug (TT ATH Breakout, +$17): same broken LTF shape as PH but RSI
  // 28.5/30.5 — a washed-out capitulation flush at support. Must pass.
  const rtx = {
    side: "LONG",
    struct15: -1, st15: 1, rsi15: 28.5,
    struct30: -1, st30: 1, rsi30: 30.5,
    struct1h: 0.4, st1h: 1,
    daCfg: ON,
  };
  // SN Aug (TT ATH Breakout, −$27): LTF fully bullish at entry — its
  // failure mode is not this gate's target. Must pass.
  const sn = {
    side: "LONG",
    struct15: 1, st15: -1, rsi15: 50,
    struct30: 1, st30: -1, rsi30: 51.8,
    struct1h: 1, st1h: 1,
    daCfg: ON,
  };
  // PH Aug win (+$41): everything aligned bull. Must pass.
  const phWin = {
    side: "LONG",
    struct15: 1, st15: -1, rsi15: 52.2,
    struct30: 1, st30: -1, rsi30: 54.5,
    struct1h: 1, st1h: -1,
    daCfg: ON,
  };

  it("defaults OFF — no block without the flag", () => {
    expect(ltfStructureBlock({ ...de, daCfg: {} })).toBeNull();
    expect(ltfStructureBlock({ ...de, daCfg: { deep_audit_ja_ltf_structure_confirm: "false" } })).toBeNull();
  });

  it("blocks DE Jul 29 — support bounce into a breaking 15m+30m tape", () => {
    const b = ltfStructureBlock(de);
    expect(b?.reason).toBe("ja_ltf_structure_block");
  });

  it("blocks WM Jul 29 — ATH entry with broken structure despite bull ST", () => {
    expect(ltfStructureBlock(wm)?.reason).toBe("ja_ltf_structure_block");
  });

  it("blocks PH Aug loss — shallow 30m struct caught by the bear-ST leg", () => {
    expect(ltfStructureBlock(phLoss)?.reason).toBe("ja_ltf_structure_block");
  });

  it("passes RTX Aug — washout exemption (RSI 28.5 <= 32)", () => {
    expect(ltfStructureBlock(rtx)).toBeNull();
  });

  it("passes SN Aug — LTF bullish, out of scope", () => {
    expect(ltfStructureBlock(sn)).toBeNull();
  });

  it("passes PH Aug win — all TFs aligned", () => {
    expect(ltfStructureBlock(phWin)).toBeNull();
  });

  it("strong hourly overrides broken LTF", () => {
    expect(ltfStructureBlock({ ...de, struct1h: 0.8, st1h: -1 })).toBeNull();
  });

  it("does not block SHORT (no pinning data yet)", () => {
    expect(ltfStructureBlock({ ...de, side: "SHORT" })).toBeNull();
  });

  it("does not block when structure data is missing", () => {
    expect(ltfStructureBlock({ ...de, struct15: undefined })).toBeNull();
    expect(ltfStructureBlock({ ...de, struct30: null })).toBeNull();
  });

  it("washout cutoff is configurable via deep_audit_ja_ltf_washout_rsi", () => {
    // Raise the cutoff to 45 and DE (rsi 39.7) becomes exempt.
    expect(ltfStructureBlock({
      ...de,
      daCfg: { ...ON, deep_audit_ja_ltf_washout_rsi: 45 },
    })).toBeNull();
  });
});

describe("tapeAlignmentBlock (G8 — trade WITH the rotation, 2026-08-20)", () => {
  const ON = { deep_audit_tape_alignment_gate: "true" };
  const riskOffInternals = {
    overall: "risk_off",
    sector_rotation: { state: "risk_off", offense_avg_pct: -0.8, defense_avg_pct: 0.8 },
  };
  const riskOnInternals = {
    overall: "risk_on",
    sector_rotation: { state: "risk_on", offense_avg_pct: 0.9, defense_avg_pct: 0.1 },
  };

  // The SNOW 8/14 class: offense-sector Speculative LONG in a risk-off
  // tape, red on the day, below its own daily EMA21, no fundamental pass.
  const snow = {
    side: "LONG",
    sector: "Information Technology",
    internals: riskOffInternals,
    dayChangePct: -1.2,
    pctAboveE21: -2.4,
    investorScore: 44,
    daCfg: ON,
  };

  it("blocks the SNOW class — offense LONG in risk_off with no strength", () => {
    const b = tapeAlignmentBlock(snow);
    expect(b?.reason).toBe("ja_tape_misaligned_offense_long_risk_off");
    expect(b?.detail?.sector).toBe("Information Technology");
  });

  it("passes USO class — Energy is not an offense sector", () => {
    expect(tapeAlignmentBlock({ ...snow, sector: "Energy" })).toBeNull();
  });

  it("passes gold-miner class — Materials is aligned in risk_off", () => {
    expect(tapeAlignmentBlock({ ...snow, sector: "Materials" })).toBeNull();
  });

  it("passes an offense LONG that is outrunning the tape (RS exception)", () => {
    expect(tapeAlignmentBlock({ ...snow, dayChangePct: 1.4, pctAboveE21: 2.1 })).toBeNull();
  });

  it("passes an offense LONG with a fundamental score >= 65 (compounder exception)", () => {
    expect(tapeAlignmentBlock({ ...snow, investorScore: 78 })).toBeNull();
  });

  it("does not block in a risk_on tape", () => {
    expect(tapeAlignmentBlock({ ...snow, internals: riskOnInternals })).toBeNull();
  });

  it("never blocks SHORTs", () => {
    expect(tapeAlignmentBlock({ ...snow, side: "SHORT" })).toBeNull();
  });

  it("is a no-op when the flag is off", () => {
    expect(tapeAlignmentBlock({ ...snow, daCfg: {} })).toBeNull();
  });

  it("positive day but below EMA21 still blocks (dead-cat, not strength)", () => {
    const b = tapeAlignmentBlock({ ...snow, dayChangePct: 0.6, pctAboveE21: -1.8 });
    expect(b?.reason).toBe("ja_tape_misaligned_offense_long_risk_off");
  });
});
