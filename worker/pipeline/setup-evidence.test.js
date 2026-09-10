import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { finiteSetupNumber, observedSetupVolume, meetsSetupVolume, breakoutEvidence, beginSetupEvaluation, setupBarPosition, priorDeclineBlocksGap } from "./setup-evidence.js";
import { buildTradeContext } from "./trade-context.js";
import { evaluateEntry } from "./tt-core-entry.js";
import { computeTfBundle, assembleTickerData } from "../indicators.js";
import { buildSequenceTrailSnapshot } from "../foundation/sequence-snapshot.js";
import { minimalPayloadForD1 } from "../storage.js";

const NOW = Date.parse("2026-09-09T16:00:00Z");
function payload() {
  const cloud = { bull: true, bear: false, above: true, below: false, inCloud: false, fastSlope: 0.1 };
  const tf = { stDir: -1, ema: { structure: 1 }, rsi: { r5: 50 }, ripster: { c34_50: cloud, c5_12: cloud, c8_9: cloud } };
  return structuredClone({
    ticker: "TEST", price: 102, rank: 100, score: 100, htf_score: 60, ltf_score: 40,
    rr: 3, completion: 0.2, phase_pct: 20, state: "HTF_BULL_LTF_BULL",
    setup_grade: "Prime", regime_class: "STRONG_BULL",
    tf_tech: { "10": tf, "15": tf, "30": tf, "1H": tf, "4H": tf, D: tf, W: tf },
    _env: { _entryEngine: "tt_core", _deepAuditConfig: { deep_audit_forming_pair_entry: "false" } },
    rvol_map: { "30": { vr: 2 } },
    _theme_tilt: 1,
    _fv_tilt: 1,
    _officer_tilt: 1,
    _sector_rating: "overweight",
    daily_structure: { ath52w: {
      sample_size: 252, pct_below_high_252: 0, breakout_above_prev_high: true,
      tight_base_5d_pct: 2, prev_high: 101, prev_low: 98, prev_close: 100, prev_prev_close: 99,
    } },
  });
}

describe("observed setup volume", () => {
  it.each([null, undefined, "", " ", false, true, {}, [], "bad", Infinity])("does not manufacture evidence from %s", v => {
    expect(finiteSetupNumber(v)).toBeNull();
    expect(observedSetupVolume({ rvol_map: { "30": { vr: v } } }).value).toBeNull();
  });
  it("does not promote missing hourly volume to 1.0 above a weak measured 30m", () => {
    const volume = observedSetupVolume({ rvol_map: { "30": { vr: "0.5" } } });
    expect(volume.value).toBe(0.5);
    expect(meetsSetupVolume(volume, 1)).toBe(false);
  });
  it("retains observed zero, uses measured maxima, and reports provenance", () => {
    expect(observedSetupVolume({ rvol_map: { "30": { vr: 0 } } }).value).toBe(0);
    expect(observedSetupVolume({ rvol_map: { "30": { vr: 0.5 }, "60": { vr: "2" } } }))
      .toEqual({ value: 2, source: "rvol_map.60.vr", observations: 2 });
    expect(observedSetupVolume({ rvol_best: "1.4" }).value).toBe(1.4);
  });
  it("requires a valid floor; only explicit zero disables the volume requirement", () => {
    const missing = observedSetupVolume({});
    expect(meetsSetupVolume(missing, 1)).toBe(false);
    expect(meetsSetupVolume(missing, 0)).toBe(true);
    expect(meetsSetupVolume(missing, null)).toBe(false);
    expect(meetsSetupVolume({ value: 0 }, 1)).toBe(false);
    expect(meetsSetupVolume({ value: 1 }, "1")).toBe(true);
  });
});

describe("breakout evidence", () => {
  const ath = { prev_high: 101, prev_low: 98, prev_close: 100, prev_prev_close: 99 };
  it("a prior high excursion does not qualify a price back under resistance", () => {
    expect(breakoutEvidence({ ...ath, breakout_above_prev_high: true }, 100.5, "LONG").eligible).toBe(false);
    expect(breakoutEvidence(ath, 102, "LONG").eligible).toBe(true);
    expect(breakoutEvidence(ath, 101, "LONG").eligible).toBe(false);
  });
  it("uses completed preceding closes, not today's up move, for follow-through", () => {
    const downYesterday = { ...ath, prev_prev_close: 101 };
    expect(breakoutEvidence(downYesterday, 102, "LONG").eligible).toBe(false);
    expect(breakoutEvidence(downYesterday, 102, "LONG", false).eligible).toBe(true);
    expect(breakoutEvidence(downYesterday, 100, "LONG", false).eligible).toBe(false);
  });
  it("mirrors the complete rule for shorts", () => {
    const downYesterday = { ...ath, prev_prev_close: 101 };
    expect(breakoutEvidence(downYesterday, 97, "SHORT").eligible).toBe(true);
    expect(breakoutEvidence(downYesterday, 99, "SHORT").eligible).toBe(false);
    expect(breakoutEvidence(ath, 97, "SHORT").eligible).toBe(false);
  });
  it("keeps missing prices and preceding evidence unknown, never favorable", () => {
    expect(breakoutEvidence({}, 102, "LONG").holds_level).toBeNull();
    expect(breakoutEvidence({ prev_high: 101 }, 102, "LONG").eligible).toBe(false);
    expect(breakoutEvidence({ prev_high: 101 }, 102, "LONG", false).eligible).toBe(true);
    expect(breakoutEvidence(ath, null, "LONG", false).eligible).toBe(false);
    expect(breakoutEvidence(ath, 102, null, false).eligible).toBe(false);
  });
  it("the indicator producer supplies levels/preceding closes unchanged by today's wick", () => {
    const bars = Array.from({ length: 65 }, (_, i) => ({ ts: NOW - (65 - i) * 86400000, o: 99, h: 101, l: 98, c: 99, v: 1000 }));
    bars.at(-2).c = 100;
    bars.at(-1).h = 105;
    bars.at(-1).c = 100.5;
    const a = computeTfBundle(bars).ath52w;
    expect(a.breakout_above_prev_high).toBe(true); // raw excursion is still available
    expect(a).toMatchObject(ath);
    expect(breakoutEvidence(a, bars.at(-1).c, "LONG").eligible).toBe(false);
    const bundle = computeTfBundle(bars);
    const assembled = assembleTickerData("TEST", { D: bundle, "10": bundle });
    expect(assembled.daily_structure.ath52w).toMatchObject(ath);
    expect(assembled.tf_tech["10"].latest).toEqual(bundle.latest);
  });
});

describe("setup evaluation trace", () => {
  it("clears per-pass diagnostics and stale forced direction before early returns", () => {
    const d = payload();
    d.__gap_reversal_force_short = true;
    d.__gap_reversal_diag = { fired: true };
    const audit = beginSetupEvaluation(d, { side: "LONG", asOfTs: NOW });
    expect(d.__gap_reversal_force_short).toBeUndefined();
    expect(d.__gap_reversal_diag).toBeUndefined();
    expect(audit.structural_evaluation.gap).toBe("not_reached");
    expect(audit.raw_shapes.gap).toBeNull();
    expect(audit.raw_shapes.ath).toBe(true);
    expect(audit.selected_path).toBeNull();
    expect(buildSequenceTrailSnapshot(d).setup_evaluation).toEqual(audit);
    expect(minimalPayloadForD1(d).__setup_evaluation).toEqual(audit);
  });
  it("keeps false distinct from absent and resets the whole trace next pass", () => {
    const d = { daily_structure: { gap_reversal: { long_setup_active: false } } };
    const a = beginSetupEvaluation(d, { side: "LONG", asOfTs: NOW });
    a.selected_path = "tt_gap_reversal_long";
    const b = beginSetupEvaluation(d, { side: "LONG", asOfTs: NOW + 1 });
    expect(b.selected_path).toBeNull();
    expect(b.raw_shapes.gap).toBe(false);
    expect(b.raw_shapes.range).toBeNull();
    expect(b.sequence_evidence).toBe("not_evaluated_by_this_trace");
  });
  it("is wired into both existing persisted entry snapshots", () => {
    const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
    expect(src.match(/evaluation: tickerData\?\.__setup_evaluation \|\| null/g)).toHaveLength(2);
    expect(src).toContain("setup_grade: tickerData?.__setup_grade");
    expect(src).toContain('"__entry_setup_snapshot", "__setup_evaluation",');
  });
});

describe("real TradeContext → TT entry engine", () => {
  it("evaluates a held breakout with measured volume and records suppressed alternatives", () => {
    const d = payload();
    d.daily_structure.gap_reversal = { long_setup_active: true, gap_pct: -2 };
    const result = evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__ath_breakout_diag, JSON.stringify(result)).toMatchObject({ fired: true });
    expect(d.__setup_evaluation.raw_shapes.gap).toBe(true);
    expect(d.__setup_evaluation.structural_evaluation.gap).toBe("preempted");
    expect(d.__gap_reversal_diag).toBeUndefined();
  });
  it("does not use TradeContext's neutral fallback as volume confirmation", () => {
    const d = payload();
    delete d.rvol_map;
    const ctx = buildTradeContext(d, NOW);
    expect(ctx.rvol.best).toBe(1); // legacy non-setup consumers unchanged
    const result = evaluateEntry(ctx);
    expect(d.__ath_breakout_diag, JSON.stringify(result)).toMatchObject({ fired: false, rvol: null });
  });
  it("rejects the breakout trigger after a wick retreat, without changing the raw excursion", () => {
    const d = payload();
    d.price = 100.5;
    const result = evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__ath_breakout_diag, JSON.stringify(result)).toMatchObject({ fired: false, breakout_above_prev_high: true });
  });
  it("clears stale setup diagnostics even when an earlier setup wins this pass", () => {
    const d = payload();
    evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__ath_breakout_diag.fired).toBe(true);
    d.__gap_reversal_force_short = true;
    d._env._deepAuditConfig.deep_audit_forming_pair_entry = "true";
    const result = evaluateEntry(buildTradeContext(d, NOW + 300000));
    expect(result.path).toBe("tt_forming_pair");
    expect(d.__ath_breakout_diag).toBeUndefined();
    expect(d.__gap_reversal_force_short).toBeUndefined();
    expect(d.__setup_evaluation.structural_evaluation.ath).toBe("not_reached");
    expect(d.__setup_evaluation.selected_path).toBe("tt_forming_pair");
  });
  it("enforces an enabled bar-position gate and keeps it off when unconfigured", () => {
    const d = payload();
    d._env._deepAuditConfig.deep_audit_tt_momentum_bar_position_min = "0.6";
    evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__setup_evaluation.cloud_triggers.momentum).toBe(false);
    d.tf_tech["10"].latest = { h: 103, l: 100, c: 102 };
    evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__setup_evaluation.cloud_triggers.momentum).toBe(true);
    d.tf_tech["10"].latest.c = 100.5;
    evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__setup_evaluation.cloud_triggers.momentum).toBe(false);
    delete d._env._deepAuditConfig.deep_audit_tt_momentum_bar_position_min;
    evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__setup_evaluation.cloud_triggers.momentum).toBe(true);
  });
});

describe("bar-position evidence", () => {
  it("uses valid OHLC evidence; null/flat/out-of-range bars are unknown", () => {
    expect(setupBarPosition({ h: 110, l: 100, c: 106 })).toBe(0.6);
    for (const bar of [null, {}, { h: 100, l: 100, c: 100 }, { h: 110, l: 100, c: 111 }, { h: 110, l: 100, c: null }]) {
      expect(setupBarPosition(bar)).toBeNull();
    }
  });
});

describe("preceding decline evidence", () => {
  it("keeps the preceding three-session decline after today's green partial reclaim", () => {
    const bars = Array.from({ length: 65 }, (_, i) => ({ ts: NOW - (65 - i) * 86400000, o: 110, h: 111, l: 109, c: 110, v: 1000 }));
    [108, 105, 100].forEach((c, i) => { bars[bars.length - 4 + i] = { ...bars[bars.length - 4 + i], o: c + 1, h: c + 2, l: c - 1, c }; });
    bars.at(-1).o = 98;
    bars.at(-1).c = 102; // green today, but prior 3 closes fell 9.09%
    bars.at(-1).h = 103;
    bars.at(-1).l = 97;
    const bundle = computeTfBundle(bars);
    const gap = bundle.gapReversal;
    expect(gap.long_setup_active).toBe(true);
    expect(gap.prior_decline.consecutive_down).toBe(3);
    expect(priorDeclineBlocksGap(gap.prior_decline, 3, -5)).toBe(true);
    expect(priorDeclineBlocksGap(gap.prior_decline, 4, -5)).toBe(false);
    expect(priorDeclineBlocksGap(gap.prior_decline, 3, -10)).toBe(false);
    const d = payload();
    d._env._deepAuditConfig.deep_audit_ath_breakout_enabled = "false";
    d.daily_structure.gap_reversal = gap;
    evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__gap_reversal_diag).toMatchObject({ fired: false, falling_knife_blocked: true });
    d._env._deepAuditConfig.deep_audit_gap_reversal_knife_filter_enabled = "false";
    evaluateEntry(buildTradeContext(d, NOW));
    expect(d.__gap_reversal_diag.fired).toBe(true);
  });
});
