// worker/play-the-move.test.js — pins the C1 vehicle-menu semantics.

import { describe, it, expect } from "vitest";
import {
  buildVehicleMenu,
  vehicleMenuToCounterfactualSignals,
  vehicleMenuToModelPlaySignal,
  normalizePlayVehicle,
  summarizeModelPlayGroups,
  modelPlayLineage,
} from "./play-the-move.js";

const basePlay = {
  archetype: "long_call",
  label: "Long Call",
  headline: "Long Call · Jul 17",
  breakeven: 108,
  target_clears_breakeven: true,
  max_loss_usd: 420,
  expiration: { iso: "2026-07-17", label: "Jul 17" },
  legs: [{ kind: "option", type: "CALL", strike: 105, expiration: "2026-07-17", qty: 1 }],
};

function bigMoveInput(overrides = {}) {
  return {
    ticker: "QQQ",
    direction: "LONG",
    price: 100,
    sl: 95,
    tp: 108, // 8% expected move
    mode: "trader",
    optionsPlay: basePlay,
    tickerData: {
      htf_score: 20,
      state: "HTF_BULL_LTF_BULL",
      hold_intent: "SWING",
      completion: 0.3,
      themes: [],
    },
    ...overrides,
  };
}

describe("buildVehicleMenu", () => {
  it("includes shares + option + LETF for a mapped index and picks by suitability", () => {
    const menu = buildVehicleMenu(bigMoveInput());
    const vehicles = menu.entries.map((e) => e.vehicle);
    expect(vehicles).toContain("shares");
    expect(vehicles).toContain("option");
    expect(vehicles).toContain("letf");
    const letf = menu.entries.find((e) => e.vehicle === "letf");
    expect(letf.letf_ticker).toBe("TQQQ"); // QQQ LONG → TQQQ
    expect(menu.expected_move_pct).toBeCloseTo(8, 5);
    // 8% expected move + breakeven cleared → the option outranks shares.
    expect(menu.pick.vehicle).toBe("option");
    expect(menu.pick.play_vehicle).toBe("options");
    expect(menu.pick.why).toBeTruthy();
    expect(menu.allowed_vehicles).toEqual(["shares", "letf", "options"]);
  });

  it("respects allowed_vehicles prefs (shares-only)", () => {
    const menu = buildVehicleMenu(bigMoveInput({
      playPrefs: { allowed_vehicles: ["shares"] },
    }));
    expect(menu.pick.play_vehicle).toBe("shares");
    expect(menu.allowed_vehicles).toEqual(["shares"]);
  });

  it("prefers shares for modest expected moves", () => {
    const menu = buildVehicleMenu(bigMoveInput({
      tp: 102.5, // 2.5% move
      optionsPlay: { ...basePlay, target_clears_breakeven: false },
    }));
    expect(menu.pick.vehicle).toBe("shares");
  });

  it("SHORT direction maps to the bear LETF", () => {
    const menu = buildVehicleMenu(bigMoveInput({ direction: "SHORT", tp: 92, sl: 105 }));
    const letf = menu.entries.find((e) => e.vehicle === "letf");
    expect(letf.letf_ticker).toBe("SQQQ");
  });

  it("adds the covered-call income angle in investor mode with a late move", () => {
    const menu = buildVehicleMenu(bigMoveInput({
      mode: "investor",
      tickerData: {
        ...bigMoveInput().tickerData,
        completion: 0.7,
        _fair_value: { fv_premium_pct: 20 },
      },
    }));
    const cc = menu.entries.find((e) => e.vehicle === "covered_call");
    expect(cc).toBeTruthy();
    expect(cc.reasons.join(" ")).toContain("complete");
  });

  it("returns null without a price", () => {
    expect(buildVehicleMenu({ ticker: "QQQ", direction: "LONG" })).toBeNull();
  });
});

describe("vehicleMenuToCounterfactualSignals", () => {
  it("emits one graded counterfactual per non-shares entry", () => {
    const menu = buildVehicleMenu(bigMoveInput());
    const sigs = vehicleMenuToCounterfactualSignals(menu, {
      tradeId: "trade-9", price: 100, tp: 108, sl: 95,
    });
    const vehicles = sigs.map((s) => s.vehicle);
    expect(vehicles).toContain("long_call");
    expect(vehicles).toContain("letf");
    expect(vehicles).not.toContain("shares");
    const opt = sigs.find((s) => s.vehicle === "long_call");
    expect(opt.signal_id).toBe("vmenu:trade-9:option");
    expect(opt.expiry_ts).toBe(Date.parse("2026-07-17T21:00:00Z"));
    expect(opt.breakeven).toBe(108);
    const letf = sigs.find((s) => s.vehicle === "letf");
    expect(letf.horizon_days).toBe(10);
    expect(letf.payload.picked).toBe(false);
  });

  it("covered-call counterfactual inverts the direction", () => {
    const menu = buildVehicleMenu(bigMoveInput({
      mode: "investor",
      tickerData: { ...bigMoveInput().tickerData, completion: 0.7 },
    }));
    const sigs = vehicleMenuToCounterfactualSignals(menu, { tradeId: "t1", price: 100 });
    const cc = sigs.find((s) => s.vehicle === "covered_call");
    expect(cc.direction).toBe("SHORT");
  });
});

describe("model play dogfood", () => {
  it("normalizes vehicles to shares|letf|options", () => {
    expect(normalizePlayVehicle("option")).toBe("options");
    expect(normalizePlayVehicle("long_call")).toBe("options");
    expect(normalizePlayVehicle("leveraged_etf")).toBe("letf");
    expect(normalizePlayVehicle("shares")).toBe("shares");
  });

  it("emits a first-class model_play signal for the pick", () => {
    const menu = buildVehicleMenu(bigMoveInput());
    const sig = vehicleMenuToModelPlaySignal(menu, {
      tradeId: "trade-9", price: 100, tp: 108, sl: 95, executedVehicle: "shares",
    });
    expect(sig.source).toBe("model_play");
    expect(sig.vehicle).toBe("options");
    expect(sig.signal_id).toBe("model_play:trade-9");
    expect(sig.payload.executed_vehicle).toBe("shares");
    expect(modelPlayLineage(menu).play_vehicle).toBe("options");
  });

  it("aggregates scorecard buckets", () => {
    const s = summarizeModelPlayGroups([
      { source: "model_play", vehicle: "options", n: 10, resolved: 8, wins: 5, losses: 3, flats: 0, avg_pct: 2.5 },
      { source: "model_play", vehicle: "shares", n: 20, resolved: 18, wins: 10, losses: 8, flats: 0, avg_pct: 0.4 },
      { source: "vehicle_counterfactual", vehicle: "letf", n: 5, resolved: 5, wins: 2, losses: 3, flats: 0, avg_pct: -1 },
    ]);
    const opt = s.vehicles.find((v) => v.play_vehicle === "options");
    expect(opt.wins).toBe(5);
    expect(opt.label).toBe("Options");
    expect(opt.sum_pct).toBeCloseTo(20, 5); // 2.5 * 8
    expect(s.vehicles.find((v) => v.play_vehicle === "shares").n).toBe(20);
    expect(s.vehicles.find((v) => v.play_vehicle === "letf").n).toBe(0); // counterfactuals excluded
    expect(s.totals.n).toBe(30);
  });
});
