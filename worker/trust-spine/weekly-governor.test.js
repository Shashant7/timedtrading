import { describe, it, expect } from "vitest";
import { compareWowPnl, planSevereDemotions, loadWeeklyGovernorConfig, canPromoteWidenLevers } from "./weekly-governor.js";
import { buildFamilyAttributionReport, mfeKeepRate, isConfirmStackDecision } from "./family-attribution.js";

describe("weekly governor pure helpers", () => {
  it("flags WoW regression", () => {
    const r = compareWowPnl({ pnl_usd: -200 }, { pnl_usd: 100 });
    expect(r.regressing).toBe(true);
    expect(r.delta_usd).toBe(-300);
  });

  it("plans severe demotions only below PF floor", () => {
    const perSetup = [
      { setup: "tt_ath_breakout", direction: "long", stats: { n: 14, profit_factor: 0.18, win_rate_pct: 28, pnl_usd: -700 } },
      { setup: "tt_pullback", direction: "long", stats: { n: 20, profit_factor: 0.9, win_rate_pct: 45, pnl_usd: 100 } },
      { setup: "tt_n_test_support", direction: "long", stats: { n: 8, profit_factor: 0.1, win_rate_pct: 20, pnl_usd: -400 } },
    ];
    const severe = planSevereDemotions(perSetup, { minN: 10, maxPf: 0.5 });
    expect(severe).toHaveLength(1);
    expect(severe[0].path).toBe("tt_ath_breakout");
    expect(severe[0].action).toBe("auto_demote_blocked");
  });

  it("defaults governor flags ON", () => {
    const cfg = loadWeeklyGovernorConfig({});
    expect(cfg.enabled).toBe(true);
    expect(cfg.autoDemote).toBe(true);
    expect(cfg.healDemotions).toBe(true);
  });

  it("promotes widen levers only when n/keep clear and WoW not regressing", () => {
    const family = { ok: true, closed: 32, avg_mfe_keep_rate: 0.42 };
    expect(canPromoteWidenLevers(family, { regressing: false }, {}).ok).toBe(true);
    expect(canPromoteWidenLevers({ ok: true, closed: 10, avg_mfe_keep_rate: 0.5 }, { regressing: false }, {}).ok).toBe(false);
    expect(canPromoteWidenLevers(family, { regressing: true }, {}).ok).toBe(false);
    expect(canPromoteWidenLevers(family, { regressing: false }, { blockWiden: true }).ok).toBe(false);
  });
});

describe("family attribution", () => {
  it("computes MFE keep rate", () => {
    expect(mfeKeepRate(1.2, 3)).toBe(0.4);
    expect(mfeKeepRate(-1, 2)).toBe(-0.5);
    expect(mfeKeepRate(1, 0)).toBeNull();
  });

  it("detects confirm-stack decisions via slice_family", () => {
    expect(isConfirmStackDecision({
      inputs_json: JSON.stringify({ slice_family: "confirm_stack_ema21" }),
    })).toBe(true);
    expect(isConfirmStackDecision({
      gate_trace_json: JSON.stringify({ stack_full_confirm: { fires: true } }),
    })).toBe(true);
  });

  it("aggregates closed keep + window stats", () => {
    const report = buildFamilyAttributionReport({
      entryDecisions: [
        {
          event_type: "ENTRY",
          trade_id: "A-1",
          inputs_json: JSON.stringify({ slice_family: "confirm_stack_ema21", play_vehicle: "shares" }),
        },
        {
          event_type: "ENTRY",
          trade_id: "B-1",
          inputs_json: JSON.stringify({ confirm_stack: true }),
        },
      ],
      trades: [
        { trade_id: "A-1", status: "WIN", pnl: 40, pnl_pct: 1.5, max_favorable_excursion: 3, ticker: "A" },
        { trade_id: "B-1", status: "LOSS", pnl: -20, pnl_pct: -0.5, max_favorable_excursion: 2, ticker: "B" },
      ],
      universeCapturePct: 6.1,
      baselineCapturePct: 4.8,
    });
    expect(report.entries).toBe(2);
    expect(report.closed).toBe(2);
    expect(report.stats.wins).toBe(1);
    // (1.5/3 + -0.5/2) / 2 = (0.5 - 0.25) / 2 = 0.125
    expect(report.avg_mfe_keep_rate).toBe(0.125);
    expect(report.beats_baseline_capture).toBe(true);
    expect(report.vehicles.shares).toBe(2);
  });
});
