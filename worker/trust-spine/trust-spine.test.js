import { describe, expect, it } from "vitest";
import { resolveAutonomyConfig, evaluateRungGates } from "./autonomy-ladder.js";
import { attachCalibratedEdge } from "./calibrated-edge.js";
import { buildTodayPlaysQueue } from "./plays-today.js";
import { scoreEpochMetrics } from "./scorecard.js";
import { evaluateSectorConcentration } from "./sector-concentration.js";

describe("trust-spine autonomy", () => {
  it("defaults to L0", () => {
    const a = resolveAutonomyConfig({});
    expect(a.level).toBe("L0");
    expect(a.options_auto_mirror_allowed).toBe(false);
  });

  it("L2 allows options mirror", () => {
    const a = resolveAutonomyConfig({ autonomy_level: "L2" });
    expect(a.options_auto_mirror_allowed).toBe(true);
  });
});

describe("calibrated-edge", () => {
  it("attaches EV from pattern", () => {
    const out = attachCalibratedEdge(
      { trigger_dir: "LONG", setup_gates: { stack_full_confirm: { fires: true } } },
      [{ pattern_id: "x", name: "Test", expected_direction: "UP", hit_rate: 0.65, expected_value: 12 }],
    );
    expect(out.calibrated_probability).toBe(0.65);
    expect(out.calibrated_expected_value).toBe(12);
  });
});

describe("plays-today", () => {
  it("prioritizes RIDE over DRIFT", () => {
    const q = buildTodayPlaysQueue({
      optionsPlays: [
        { ticker: "SPY", confluence_mode: "DRIFT", confluence_score: 80 },
        { ticker: "QQQ", confluence_mode: "RIDE", confluence_score: 70 },
      ],
      limit: 5,
    });
    expect(q.plays[0].ticker).toBe("QQQ");
  });

  it("surfaces confirm-stack EMA21 family with lifecycle + play chips", () => {
    const q = buildTodayPlaysQueue({
      confirmStackTickers: [{
        ticker: "NVDA",
        trigger_dir: "LONG",
        confluence_mode: "RIDE",
        setup_gates: { stack_full_confirm: { fires: true }, gate_runway_full: { fires: true } },
        _model_lifecycle: { state: "queued", label: "Queued", horizon: "swing", why: "Confirm stack + EMA21" },
        _model_play: { play_vehicle: "options", why: "Tier-A RIDE convexity" },
        _business_character: { archetype: "growth_compounder" },
        __conviction_tier: "A",
        setup_sequences: [{ status: "entry_ready" }],
      }],
      limit: 10,
    });
    expect(q.slice.count).toBe(1);
    const p = q.slice.plays[0];
    expect(p.slice_family).toBe("confirm_stack_ema21");
    expect(p.confirm_stack).toBe(true);
    expect(p.runway_full).toBe(true);
    expect(p.lifecycle.state).toBe("queued");
    expect(p.play_vehicle).toBe("options");
    expect(p.play_label).toBe("Options");
    expect(p.business_character).toBe("growth_compounder");
    expect(p.sequence_entry_ready).toBe(true);
    expect(q.plays[0].ticker).toBe("NVDA");
  });
});

describe("scorecard", () => {
  it("joins epochs to trade pnl", () => {
    const s = scoreEpochMetrics(
      [{ config_hash: "abc123", decisions: 10, entries: 5 }],
      [{ config_hash: "abc123", pnl: 100 }, { config_hash: "abc123", pnl: -50 }],
    );
    expect(s.epochs[0].net_pnl).toBe(50);
    expect(s.epochs[0].win_rate).toBe(50);
  });
});

describe("sector concentration", () => {
  it("trips when one sector dominates", () => {
    const r = evaluateSectorConcentration(
      [{ ticker: "NVDA", shares: 100, entry_price: 100 }, { ticker: "AMD", shares: 10, entry_price: 100 }],
      { NVDA: { p: 100 }, AMD: { p: 100 } },
      40,
    );
    expect(r.sector_trip).toBe(true);
  });
});
