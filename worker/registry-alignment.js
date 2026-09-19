/**
 * Registry / Upticks / GICS drift checks.
 *
 * Cheap: no ticker_candles. Live Upticks, TT_SELECTED_DEFAULT, SECTOR_MAP,
 * ticker_index, and timed:removed must stay consistent. A live Uptick on
 * timed:removed (DBA Sep 2026) or a KV-only rotation (DDOG) is a fail.
 */

import { isUnknownSector } from "./sector-mapping.js";

const PULSE_FUTURES_RE = /^(ES|NQ|GC|SI|VX|CL|RTY|YM)1!$/;

function asTickerSet(list) {
  return new Set(
    (list || []).map((t) => String(t || "").toUpperCase().trim()).filter(Boolean),
  );
}

export function shouldSkipSymbolValidation(ticker, {
  sectorMap = {},
  ttSelected = null,
  liveUpticks = null,
} = {}) {
  const t = String(ticker || "").toUpperCase().trim();
  if (!t) return false;
  if (t.endsWith("1!")) return true;
  if (sectorMap && sectorMap[t]) return true;
  if (ttSelected instanceof Set && ttSelected.has(t)) return true;
  if (Array.isArray(ttSelected) && ttSelected.map((x) => String(x).toUpperCase()).includes(t)) {
    return true;
  }
  if (liveUpticks instanceof Set && liveUpticks.has(t)) return true;
  if (Array.isArray(liveUpticks) && liveUpticks.map((x) => String(x).toUpperCase()).includes(t)) {
    return true;
  }
  return false;
}

export function filterTickersNeedingValidation(tickers, lists) {
  return (tickers || []).filter((t) => !shouldSkipSymbolValidation(t, lists));
}

export function diffRegistryAlignment({
  liveUpticks = [],
  ttSelected = [],
  sectorMapKeys = [],
  indexTickers = [],
  removed = [],
} = {}) {
  const upticks = asTickerSet(liveUpticks);
  const selected = asTickerSet(ttSelected);
  const map = asTickerSet(sectorMapKeys);
  const index = asTickerSet(indexTickers);
  const rem = asTickerSet(removed);

  const missing_gics = [...index].filter((t) => !map.has(t) && !PULSE_FUTURES_RE.test(t)).sort();
  const upticks_on_removed = [...upticks].filter((t) => rem.has(t)).sort();
  const selected_on_removed = [...selected].filter((t) => rem.has(t)).sort();
  const live_not_in_selected = [...upticks].filter((t) => !selected.has(t)).sort();
  const selected_not_live = [...selected].filter((t) => !upticks.has(t)).sort();
  const selected_missing_index = [...selected].filter((t) => !index.has(t)).sort();
  const upticks_missing_index = [...upticks].filter((t) => !index.has(t)).sort();
  const upticks_missing_gics = [...upticks].filter((t) => !map.has(t)).sort();

  const fail = upticks_on_removed.length
    || upticks_missing_gics.length
    || upticks_missing_index.length
    || live_not_in_selected.length
    || selected_not_live.length;

  return {
    ok: !fail,
    missing_gics,
    upticks_on_removed,
    selected_on_removed,
    live_not_in_selected,
    selected_not_live,
    selected_missing_index,
    upticks_missing_index,
    upticks_missing_gics,
  };
}

export function evaluateRegistryAlignment(diff, { unknownHealed = [] } = {}) {
  const anomalies = [];
  const failLists = [
    ["upticks_on_removed", "Live Uptick is on timed:removed"],
    ["upticks_missing_gics", "Live Uptick has no GICS row"],
    ["upticks_missing_index", "Live Uptick is missing from ticker_index"],
    ["live_not_in_selected", "Live Uptick is not in TT_SELECTED_DEFAULT"],
    ["selected_not_live", "TT_SELECTED_DEFAULT name is not on live Upticks"],
  ];
  for (const [key, label] of failLists) {
    for (const ticker of diff?.[key] || []) {
      anomalies.push({ ticker, detail: `${label}: ${ticker}`, severity: "fail" });
    }
  }
  const warnLists = [
    ["selected_on_removed", "Curated Selected name is on timed:removed"],
    ["selected_missing_index", "Curated Selected name is missing from ticker_index"],
  ];
  for (const [key, label] of warnLists) {
    for (const ticker of diff?.[key] || []) {
      anomalies.push({ ticker, detail: `${label}: ${ticker}`, severity: "warn" });
    }
  }
  const missing = diff?.missing_gics || [];
  if (missing.length) {
    const shown = missing.slice(0, 20);
    anomalies.push({
      detail: `${missing.length} ticker_index names have no GICS row (showing ${shown.join(", ")}${missing.length > 20 ? ", ..." : ""})`,
      severity: "warn",
    });
  }
  if (unknownHealed.length) {
    anomalies.push({
      detail: `Deleted Unknown timed:sector_map overlays: ${unknownHealed.join(", ")}`,
      severity: "warn",
    });
  }
  return anomalies;
}

export async function healUnknownSectorMapKeys(kv, tickers) {
  const healed = [];
  if (!kv) return healed;
  for (const raw of tickers || []) {
    const t = String(raw || "").toUpperCase().trim();
    if (!t) continue;
    const key = `timed:sector_map:${t}`;
    let value;
    try {
      value = await kv.get(key, "text");
    } catch (_) {
      continue;
    }
    if (!isUnknownSector(value)) continue;
    try {
      await kv.delete(key);
      healed.push(t);
    } catch (_) { /* best-effort */ }
  }
  return healed;
}

async function kvJsonList(kv, key) {
  if (!kv) return [];
  try {
    const v = await kv.get(key, "json");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

export async function loadRegistryAlignmentInputs(env) {
  const kv = env?.KV_TIMED || env?.KV;
  const [liveUpticks, removed, kvTickers] = await Promise.all([
    kvJsonList(kv, "timed:admin:upticks"),
    kvJsonList(kv, "timed:removed"),
    kvJsonList(kv, "timed:tickers"),
  ]);
  let indexTickers = kvTickers;
  try {
    if (env?.DB) {
      const { results } = await env.DB.prepare(
        `SELECT ticker FROM ticker_index ORDER BY ticker ASC`,
      ).all();
      if (results?.length) indexTickers = results.map((r) => r.ticker);
    }
  } catch (_) { /* cheap table; tolerate miss */ }

  const { SECTOR_MAP } = await import("./sector-mapping.js");
  const { TT_SELECTED_DEFAULT } = await import("./focus-tier.js");
  return {
    liveUpticks: Array.isArray(liveUpticks) ? liveUpticks : [],
    ttSelected: [...TT_SELECTED_DEFAULT],
    sectorMapKeys: Object.keys(SECTOR_MAP || {}),
    indexTickers,
    kvTickers: Array.isArray(kvTickers) ? kvTickers : [],
    removed: Array.isArray(removed) ? removed : [],
  };
}

export async function runRegistryAlignment(env, { healUnknown = false } = {}) {
  const inputs = await loadRegistryAlignmentInputs(env);
  const kv = env?.KV_TIMED || env?.KV;
  const unknownHealed = healUnknown && kv
    ? await healUnknownSectorMapKeys(kv, inputs.kvTickers)
    : [];
  const diff = diffRegistryAlignment(inputs);
  return {
    ...diff,
    unknown_overlays_healed: unknownHealed,
    anomalies: evaluateRegistryAlignment(diff, { unknownHealed }),
    counts: {
      live_upticks: inputs.liveUpticks.length,
      tt_selected: inputs.ttSelected.length,
      sector_map: inputs.sectorMapKeys.length,
      ticker_index: inputs.indexTickers.length,
      removed: inputs.removed.length,
    },
  };
}
