// worker/macro-actuals-fred.js
// ─────────────────────────────────────────────────────────────────────────────
//  Near-real-time macro ACTUALS from FRED (St. Louis Fed) — free + authoritative.
// ─────────────────────────────────────────────────────────────────────────────
//
//  FSD reports actuals on a note cadence (the day's 8:30am print only lands in
//  the next FSD note), so same-day releases lag hours-to-a-day. FRED publishes
//  the official series right after release, so polling it in the release window
//  gives the actual within minutes. This module fetches the high-impact series,
//  computes the reported headline (level-diff / MoM% / YoY% / direct), caches
//  them in KV, and applies them onto the macro-events calendar.
//
//  Requires a FREE FRED_API_KEY secret (https://fredaccount.stlouisfed.org/apikeys).
//  Gracefully no-ops when the key is absent — the curated + FSD layers still work.

import {
  fredObsMatchesEventReference,
  macroEventHasReleased,
  parseReferenceMonthFromEventName,
} from "./macro-release-time.js";

const ACTUALS_KEY = "cro:macro:actuals:fred";
const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";

// match: regex tested against the event name. series: FRED id. transform: how to
// turn the raw series into the reported headline. unit: suffix for display.
const FRED_SERIES = [
  { key: "nfp",        match: /non[- ]?farm|payroll/i,        series: "PAYEMS",            transform: "mom_change_k", label: "NFP" },
  { key: "unrate",     match: /unemployment rate/i,           series: "UNRATE",            transform: "direct", unit: "%", label: "Unemployment" },
  { key: "core_cpi",   match: /core cpi/i,                    series: "CPILFESL",          transform: "mom_pct", unit: "% m/m", label: "Core CPI" },
  { key: "cpi",        match: /(^|[^e])\bcpi\b/i,             series: "CPIAUCSL",          transform: "mom_pct", unit: "% m/m", label: "CPI" },
  { key: "core_pce",   match: /core pce/i,                    series: "PCEPILFE",          transform: "mom_pct", unit: "% m/m", label: "Core PCE" },
  { key: "pce",        match: /(^|[^e])\bpce\b/i,             series: "PCEPI",             transform: "mom_pct", unit: "% m/m", label: "PCE" },
  { key: "core_ppi",   match: /core ppi/i,                    series: "WPSFD49116",        transform: "mom_pct", unit: "% m/m", label: "Core PPI" },
  { key: "retail",     match: /retail sales/i,                series: "RSAFS",             transform: "mom_pct", unit: "% m/m", label: "Retail Sales" },
  { key: "jolts",      match: /jolts/i,                       series: "JTSJOL",            transform: "level_millions", unit: "M", label: "JOLTS" },
  { key: "gdp",        match: /\bgdp\b/i,                     series: "A191RL1Q225SBEA",   transform: "direct", unit: "% q/q", label: "GDP" },
  { key: "fedfunds",   match: /fomc|fed (rate|funds|decision)/i, series: "DFEDTARU",       transform: "direct", unit: "%", label: "Fed Funds (upper)" },
];

function fmtSigned(n, decimals = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(decimals)}`;
}

async function fetchObservations(key, series, limit = 14) {
  try {
    const url = `${FRED_BASE}?series_id=${series}&api_key=${key}&file_type=json&sort_order=desc&limit=${limit}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    const json = await resp.json().catch(() => null);
    const obs = Array.isArray(json?.observations) ? json.observations : [];
    // FRED uses "." for missing; keep numeric only, newest-first.
    return obs.map((o) => ({ date: o.date, value: Number(o.value) })).filter((o) => Number.isFinite(o.value));
  } catch (_) { return null; }
}

function computeHeadline(transform, obs, def = null) {
  if (!obs || obs.length === 0) return null;
  const latest = obs[0];
  const unit = def?.unit || "";
  if (transform === "direct") {
    const prev = obs[1];
    const display = `${latest.value}${unit ? " " + unit : ""}`;
    const prevDisplay = prev != null ? `${prev.value}${unit ? " " + unit : ""}` : null;
    return { value: latest.value, obs_date: latest.date, display, previous_display: prevDisplay };
  }
  if (transform === "mom_change_k") {
    const prev = obs[1];
    if (!prev) return null;
    // PAYEMS is in thousands → change is the reported "+139K".
    const chg = Math.round(latest.value - prev.value);
    const prevChg = obs[2] ? Math.round(prev.value - obs[2].value) : null;
    return {
      value: chg,
      obs_date: latest.date,
      display: `${fmtSigned(chg)}K`,
      previous_display: prevChg != null ? `${fmtSigned(prevChg)}K` : null,
    };
  }
  if (transform === "mom_pct") {
    const prev = obs[1];
    if (!prev || !(prev.value > 0)) return null;
    const pct = (latest.value / prev.value - 1) * 100;
    return {
      value: Math.round(pct * 100) / 100,
      obs_date: latest.date,
      display: `${fmtSigned(pct, 1)}%`,
      previous_display: `${fmtSigned(((prev.value / (obs[2]?.value || prev.value)) - 1) * 100, 1)}%`,
    };
  }
  if (transform === "level_millions") {
    const prev = obs[1];
    const millions = latest.value / 1000;
    const prevMillions = prev ? prev.value / 1000 : null;
    return {
      value: millions,
      obs_date: latest.date,
      display: `${millions.toFixed(1)}M`,
      previous_display: prevMillions != null ? `${prevMillions.toFixed(1)}M` : null,
    };
  }
  if (transform === "yoy_pct") {
    const yearAgo = obs[12];
    if (!yearAgo || !(yearAgo.value > 0)) return null;
    const pct = (latest.value / yearAgo.value - 1) * 100;
    return { value: Math.round(pct * 100) / 100, obs_date: latest.date, display: `${fmtSigned(pct, 1)}%` };
  }
  return null;
}

/**
 * Refresh FRED actuals into KV. Best-effort; no-op without FRED_API_KEY.
 * @returns { ok, refreshed, skipped? }
 */
export async function refreshMacroActualsFromFRED(env) {
  const key = env?.FRED_API_KEY;
  if (!key) return { ok: false, skipped: "no_fred_key" };
  const store = {};
  let refreshed = 0;
  for (const def of FRED_SERIES) {
    const obs = await fetchObservations(key, def.series, def.transform === "yoy_pct" ? 14 : 3);
    const head = computeHeadline(def.transform, obs, def);
    if (!head) continue;
    const display = head.display != null ? head.display : `${head.value}${def.unit ? " " + def.unit : ""}`;
    store[def.key] = {
      key: def.key, label: def.label, series: def.series,
      value: head.value, display, obs_date: head.obs_date,
      previous_display: head.previous_display || null,
      refreshed_at: Date.now(),
    };
    refreshed += 1;
  }
  if (refreshed > 0 && env?.KV) {
    try { await env.KV.put(ACTUALS_KEY, JSON.stringify({ byKey: store, updated_at: Date.now() })); } catch (_) {}
  }
  return { ok: true, refreshed };
}

async function loadActuals(env) {
  try {
    const raw = await env?.KV?.get(ACTUALS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && parsed.byKey) ? parsed.byKey : {};
  } catch (_) { return {}; }
}

/**
 * Fill `actual` onto calendar events from the FRED store. Matches an event to a
 * series by name regex; only fills after the scheduled ET release time, and only
 * when the FRED observation reference month aligns with the event name (e.g. May
 * JOLTS → May obs). Falls back to a ~45d window only when no month is parseable.
 */
export async function applyFREDActuals(env, events, todayStr, now = new Date()) {
  const byKey = await loadActuals(env);
  if (!byKey || Object.keys(byKey).length === 0) return events;
  const dayMs = 86400000;
  for (const e of events) {
    if (!e || e.actual || !e.date) continue;
    if (!macroEventHasReleased(e, now)) continue;
    const def = FRED_SERIES.find((d) => d.match.test(e.name || ""));
    if (!def) continue;
    const a = byKey[def.key];
    if (!a || a.display == null || !a.obs_date) continue;
    const ref = parseReferenceMonthFromEventName(e.name, e.date);
    if (ref) {
      if (!fredObsMatchesEventReference(e, a.obs_date)) continue;
    } else {
      const evMs = Date.parse(e.date + "T00:00:00Z");
      const obMs = Date.parse(a.obs_date + "T00:00:00Z");
      if (!Number.isFinite(evMs) || !Number.isFinite(obMs) || Math.abs(evMs - obMs) > 45 * dayMs) continue;
    }
    e.actual = a.display;
    e.actual_source = "fred";
    if (a.previous_display && !e.previous) e.previous = a.previous_display;
  }
  return events;
}
