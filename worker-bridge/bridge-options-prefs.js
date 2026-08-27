// worker-bridge/bridge-options-prefs.js
//
// Self-service options-strategy enablement for Broker Connections.
// Long call / long put are the vehicles the index day-trade mirror uses.
// Equity-long and other vehicles are left untouched by the master toggle.

export const DAY_TRADE_OPTION_VEHICLES = ["long_call", "long_put"];
export const INDEX_TREND_LETF_VEHICLE = "index_trend_letf";

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
 * Apply a master options toggle and/or per-vehicle patches.
 * Master ON with no vehicle patch enables long_call + long_put.
 * Master OFF disables those two only (equity_long stays as-is).
 */
export function applyOptionsStrategyPatch(user, { options_enabled, vehicles } = {}) {
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
  } else if (typeof options_enabled === "boolean") {
    for (const key of DAY_TRADE_OPTION_VEHICLES) {
      patched[key] = { ...(patched[key] || {}), enabled: options_enabled };
    }
  }

  const anyOn = DAY_TRADE_OPTION_VEHICLES.some((k) => patched[k]?.enabled === true);
  if (typeof options_enabled === "boolean") next.options_enabled = options_enabled;
  else next.options_enabled = anyOn;

  next.options_prefs = { ...(next.options_prefs || {}), vehicles: patched };
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
