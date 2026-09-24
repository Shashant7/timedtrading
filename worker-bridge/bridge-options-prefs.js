// worker-bridge/bridge-options-prefs.js
//
// Self-service options-strategy enablement for Broker Connections.
// Long call / long put are the vehicles the index day-trade mirror uses.
// Equity-long and other vehicles are left untouched by the master toggle.
//
// 2026-09-24 — Account-level daily_loss_limit_usd (default $500) is the
// dollar day-stop for options mirrors. Per-vehicle daily_cap /
// max_loss_per_order_usd are legacy count/ticket caps and no longer
// govern the index day-trade lane (see worker/options-risk-budget.js).

/** Matches worker/options-risk-budget.js DEFAULT_DAILY_LOSS_LIMIT_USD. */
export const DEFAULT_DAILY_LOSS_LIMIT_USD = 500;

export const DAY_TRADE_OPTION_VEHICLES = ["long_call", "long_put"];
export const INDEX_TREND_LETF_VEHICLE = "index_trend_letf";

/** All long-side option vehicles Mission Control can enable on an account. */
export const OPTION_STRATEGY_VEHICLES = [
  "long_call",
  "long_put",
  "vertical_spread",
  "leaps",
  "straddle",
  "moonshot",
  "lotto",
  "index_trend_letf",
];

/**
 * Normalize a daily loss limit. Missing/invalid → default $500.
 * Explicit 0 disables the gate (same contract as options-risk-budget).
 */
export function normalizeDailyLossLimitUsd(raw, { defaultUsd = DEFAULT_DAILY_LOSS_LIMIT_USD } = {}) {
  if (raw === null || raw === undefined || raw === "") return defaultUsd;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return defaultUsd;
  return Math.round(n);
}

export function dailyLossLimitFromUser(user) {
  return normalizeDailyLossLimitUsd(user?.options_prefs?.daily_loss_limit_usd);
}

export function optionsStrategiesOn(user) {
  if (user?.options_enabled === true) return true;
  const v = user?.options_prefs?.vehicles || {};
  return DAY_TRADE_OPTION_VEHICLES.some((k) => v[k]?.enabled === true);
}

export function indexTrendLetfOn(user) {
  const v = user?.options_prefs?.vehicles || {};
  return v[INDEX_TREND_LETF_VEHICLE]?.enabled === true;
}

/**
 * Partner Cash default: Long Call, Long Put, Index Trend LETF.
 * Equity long stays untouched (caller merges onto existing vehicles).
 */
export function partnerCashVehicleEnables() {
  return {
    long_call: { enabled: true },
    long_put: { enabled: true },
    vertical_spread: { enabled: false },
    leaps: { enabled: false },
    straddle: { enabled: false },
    moonshot: { enabled: false },
    lotto: { enabled: false },
    index_trend_letf: { enabled: true },
  };
}

/**
 * Roth IRA default: all long-side option strategies + LETF.
 */
export function rothIraVehicleEnables() {
  return {
    long_call: { enabled: true },
    long_put: { enabled: true },
    vertical_spread: { enabled: true },
    leaps: { enabled: true },
    straddle: { enabled: true },
    moonshot: { enabled: true },
    lotto: { enabled: true },
    index_trend_letf: { enabled: true },
  };
}

/**
 * Apply a master options toggle and/or per-vehicle patches.
 * Master ON with no vehicle patch enables long_call + long_put.
 * Master OFF disables those two only (equity_long stays as-is).
 * Optional daily_loss_limit_usd is stored at options_prefs top level.
 */
export function applyOptionsStrategyPatch(user, { options_enabled, vehicles, daily_loss_limit_usd } = {}) {
  const next = { ...(user || {}) };
  const current = next.options_prefs?.vehicles || {};
  const patched = { ...current };
  const explicit = vehicles && typeof vehicles === "object" ? vehicles : null;

  if (explicit) {
    for (const key of DAY_TRADE_OPTION_VEHICLES) {
      if (explicit[key]?.enabled !== undefined) {
        patched[key] = { ...(patched[key] || {}), enabled: !!explicit[key].enabled };
      }
    }
    if (explicit[INDEX_TREND_LETF_VEHICLE]?.enabled !== undefined) {
      patched[INDEX_TREND_LETF_VEHICLE] = {
        ...(patched[INDEX_TREND_LETF_VEHICLE] || {}),
        enabled: !!explicit[INDEX_TREND_LETF_VEHICLE].enabled,
      };
    }
    // Allow Mission Control / admin patches for the full strategy set.
    for (const key of OPTION_STRATEGY_VEHICLES) {
      if (DAY_TRADE_OPTION_VEHICLES.includes(key) || key === INDEX_TREND_LETF_VEHICLE) continue;
      if (explicit[key]?.enabled !== undefined) {
        patched[key] = { ...(patched[key] || {}), enabled: !!explicit[key].enabled };
      }
    }
  } else if (typeof options_enabled === "boolean") {
    for (const key of DAY_TRADE_OPTION_VEHICLES) {
      patched[key] = { ...(patched[key] || {}), enabled: options_enabled };
    }
  }

  const anyOn = DAY_TRADE_OPTION_VEHICLES.some((k) => patched[k]?.enabled === true);
  if (typeof options_enabled === "boolean") next.options_enabled = options_enabled;
  else next.options_enabled = anyOn;

  const prefs = { ...(next.options_prefs || {}), vehicles: patched };
  if (daily_loss_limit_usd !== undefined) {
    prefs.daily_loss_limit_usd = normalizeDailyLossLimitUsd(daily_loss_limit_usd);
  } else if (prefs.daily_loss_limit_usd === undefined) {
    prefs.daily_loss_limit_usd = DEFAULT_DAILY_LOSS_LIMIT_USD;
  }
  next.options_prefs = prefs;
  next.options_prefs_updated_at = Date.now();
  return next;
}

/** Prefer a connected, mirror-on account that opted into options. */
export function pickOptionsAccount(accounts, { preferClass = "ROTH_IRA" } = {}) {
  const connected = (Array.isArray(accounts) ? accounts : []).filter(
    (u) => u && String(u.status || "").toLowerCase() === "connected" && u.broker_integration_enabled,
  );
  const opted = connected.filter((u) => optionsStrategiesOn(u));
  if (!opted.length) return null;
  const want = String(preferClass || "").toUpperCase();
  return opted.find((u) => String(u.webull_account_class || "").toUpperCase() === want) || opted[0];
}

/** Prefer a connected, mirror-on account that opted into index swing LETF shares. */
export function pickIndexTrendLetfAccount(accounts, { preferClass = "ROTH_IRA" } = {}) {
  const connected = (Array.isArray(accounts) ? accounts : []).filter(
    (u) => u && String(u.status || "").toLowerCase() === "connected" && u.broker_integration_enabled,
  );
  const opted = connected.filter((u) => indexTrendLetfOn(u));
  if (!opted.length) return null;
  const want = String(preferClass || "").toUpperCase();
  return opted.find((u) => String(u.webull_account_class || "").toUpperCase() === want) || opted[0];
}
