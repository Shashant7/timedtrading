import { describe, it, expect } from "vitest";
import {
  applyOptionsStrategyPatch,
  dailyLossLimitFromUser,
  DEFAULT_DAILY_LOSS_LIMIT_USD,
  indexTrendLetfOn,
  normalizeDailyLossLimitUsd,
  optionsStrategiesOn,
  partnerCashVehicleEnables,
  pickIndexTrendLetfAccount,
  pickOptionsAccount,
  rothIraVehicleEnables,
} from "./bridge-options-prefs.js";

describe("normalizeDailyLossLimitUsd", () => {
  it("defaults to $500 when missing", () => {
    expect(normalizeDailyLossLimitUsd(undefined)).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
    expect(normalizeDailyLossLimitUsd(null)).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
    expect(normalizeDailyLossLimitUsd("")).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
  });

  it("keeps explicit 0 (gate off)", () => {
    expect(normalizeDailyLossLimitUsd(0)).toBe(0);
  });

  it("rounds valid positives", () => {
    expect(normalizeDailyLossLimitUsd(250.4)).toBe(250);
  });

  it("rejects negatives / NaN back to default", () => {
    expect(normalizeDailyLossLimitUsd(-5)).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
    expect(normalizeDailyLossLimitUsd("lots")).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
  });
});

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
    expect(next.options_prefs.daily_loss_limit_usd).toBe(DEFAULT_DAILY_LOSS_LIMIT_USD);
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

  it("index_trend_letf patch does not flip options master", () => {
    const next = applyOptionsStrategyPatch(
      { options_enabled: false, options_prefs: { vehicles: { long_call: { enabled: false } } } },
      { vehicles: { index_trend_letf: { enabled: true } } },
    );
    expect(next.options_enabled).toBe(false);
    expect(next.options_prefs.vehicles.index_trend_letf.enabled).toBe(true);
    expect(next.options_prefs.vehicles.long_call.enabled).toBe(false);
  });

  it("stores a user-configured daily_loss_limit_usd", () => {
    const next = applyOptionsStrategyPatch({}, { daily_loss_limit_usd: 750 });
    expect(next.options_prefs.daily_loss_limit_usd).toBe(750);
    expect(dailyLossLimitFromUser(next)).toBe(750);
  });

  it("can enable leaps via vehicle patch", () => {
    const next = applyOptionsStrategyPatch({}, {
      vehicles: { leaps: { enabled: true }, long_call: { enabled: true }, long_put: { enabled: true } },
    });
    expect(next.options_prefs.vehicles.leaps.enabled).toBe(true);
    expect(next.options_enabled).toBe(true);
  });
});

describe("account vehicle presets", () => {
  it("Roth enables all option strategies + LETF", () => {
    const v = rothIraVehicleEnables();
    expect(v.long_call.enabled).toBe(true);
    expect(v.long_put.enabled).toBe(true);
    expect(v.leaps.enabled).toBe(true);
    expect(v.vertical_spread.enabled).toBe(true);
    expect(v.straddle.enabled).toBe(true);
    expect(v.moonshot.enabled).toBe(true);
    expect(v.lotto.enabled).toBe(true);
    expect(v.index_trend_letf.enabled).toBe(true);
  });

  it("Partner Cash enables only Call / Put / LETF", () => {
    const v = partnerCashVehicleEnables();
    expect(v.long_call.enabled).toBe(true);
    expect(v.long_put.enabled).toBe(true);
    expect(v.index_trend_letf.enabled).toBe(true);
    expect(v.leaps.enabled).toBe(false);
    expect(v.moonshot.enabled).toBe(false);
    expect(v.straddle.enabled).toBe(false);
    expect(v.vertical_spread.enabled).toBe(false);
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

describe("pickIndexTrendLetfAccount", () => {
  it("prefers Roth when both opted into LETF", () => {
    const cash = {
      user_id: "a#webull#cash", status: "connected", broker_integration_enabled: true,
      webull_account_class: "INDIVIDUAL_CASH",
      options_prefs: { vehicles: { index_trend_letf: { enabled: true } } },
    };
    const roth = {
      user_id: "a#webull#roth", status: "connected", broker_integration_enabled: true,
      webull_account_class: "ROTH_IRA",
      options_prefs: { vehicles: { index_trend_letf: { enabled: true } } },
    };
    expect(pickIndexTrendLetfAccount([cash, roth])?.user_id).toBe("a#webull#roth");
    expect(indexTrendLetfOn(cash)).toBe(true);
  });

  it("returns null when LETF is off", () => {
    const cash = {
      user_id: "a#webull#cash", status: "connected", broker_integration_enabled: true,
      options_prefs: { vehicles: { long_call: { enabled: true } } },
    };
    expect(pickIndexTrendLetfAccount([cash])).toBeNull();
  });
});
