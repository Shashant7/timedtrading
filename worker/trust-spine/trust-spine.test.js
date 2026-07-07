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
