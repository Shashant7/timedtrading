import { describe, it, expect } from "vitest";
import {
  applyOptionsStrategyPatch,
  optionsStrategiesOn,
  pickOptionsAccount,
} from "./bridge-options-prefs.js";

describe("applyOptionsStrategyPatch", () => {
  it("master ON enables long call + long put and leaves equity_long alone", () => {
    const next = applyOptionsStrategyPatch(
      { options_prefs: { vehicles: { equity_long: { enabled: true, daily_cap: 10 } } } },
      { options_enabled: true },
    );
    expect(next.options_enabled).toBe(true);
    expect(next.options_prefs.vehicles.long_call.enabled).toBe(true);
    expect(next.options_prefs.vehicles.long_put.enabled).toBe(true);
    expect(next.options_prefs.vehicles.equity_long.enabled).toBe(true);
    expect(next.options_prefs.vehicles.equity_long.daily_cap).toBe(10);
  });

  it("master OFF disables only the option day-trade vehicles", () => {
    const next = applyOptionsStrategyPatch(
      {
        options_enabled: true,
        options_prefs: { vehicles: { equity_long: { enabled: true }, long_call: { enabled: true }, leaps: { enabled: true } } },
      },
      { options_enabled: false },
    );
    expect(next.options_enabled).toBe(false);
    expect(next.options_prefs.vehicles.long_call.enabled).toBe(false);
    expect(next.options_prefs.vehicles.long_put.enabled).toBe(false);
    expect(next.options_prefs.vehicles.leaps.enabled).toBe(true);
  });

  it("per-vehicle patch can leave puts off", () => {
    const next = applyOptionsStrategyPatch({}, {
      vehicles: { long_call: { enabled: true }, long_put: { enabled: false } },
    });
    expect(next.options_enabled).toBe(true);
    expect(next.options_prefs.vehicles.long_call.enabled).toBe(true);
    expect(next.options_prefs.vehicles.long_put.enabled).toBe(false);
  });
});

describe("pickOptionsAccount", () => {
  const roth = {
    user_id: "a#webull#roth", status: "connected", broker_integration_enabled: true,
    options_enabled: true, webull_account_class: "ROTH_IRA",
  };
  const cash = {
    user_id: "a#webull#cash", status: "connected", broker_integration_enabled: true,
    options_enabled: false, webull_account_class: "INDIVIDUAL_CASH",
  };

  it("returns the options-enabled account, preferring Roth", () => {
    expect(pickOptionsAccount([cash, roth])?.user_id).toBe("a#webull#roth");
  });

  it("returns null when no account opted in", () => {
    expect(pickOptionsAccount([cash])).toBeNull();
  });

  it("treats vehicle flags as opted-in even without options_enabled", () => {
    const viaPrefs = {
      user_id: "a#webull#cash", status: "connected", broker_integration_enabled: true,
      options_prefs: { vehicles: { long_call: { enabled: true } } },
    };
    expect(optionsStrategiesOn(viaPrefs)).toBe(true);
    expect(pickOptionsAccount([viaPrefs])?.user_id).toBe("a#webull#cash");
  });
});
