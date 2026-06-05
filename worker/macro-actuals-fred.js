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
  { key: "retail",     match: /retail sales/i,                series: "RSAFS",             transform: "mom_pct", unit: "% m/m", label: "Retail Sales" },
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

function computeHeadline(transform, obs) {
  if (!obs || obs.length === 0) return null;
  const latest = obs[0];
  if (transform === "direct") {
    return { value: latest.value, obs_date: latest.date };
  }
  if (transform === "mom_change_k") {
    const prev = obs[1];
    if (!prev) return null;
    // PAYEMS is in thousands → change is the reported "+139K".
    const chg = Math.round(latest.value - prev.value);
    return { value: chg, obs_date: latest.date, display: `${fmtSigned(chg)}K` };
  }
  if (transform === "mom_pct") {
    const prev = obs[1];
    if (!prev || !(prev.value > 0)) return null;
    const pct = (latest.value / prev.value - 1) * 100;
    return { value: Math.round(pct * 100) / 100, obs_date: latest.date, display: `${fmtSigned(pct, 1)}%` };
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
    const head = computeHeadline(def.transform, obs);
    if (!head) continue;
    const display = head.display != null ? head.display : `${head.value}${def.unit ? " " + def.unit : ""}`;
    store[def.key] = {
      key: def.key, label: def.label, series: def.series,
      value: head.value, display, obs_date: head.obs_date,
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
 * series by name regex; only fills a RELEASED event (date <= today) that doesn't
 * already have an actual, and only when the FRED observation is recent enough to
 * plausibly belong to it (within ~45 days of the event). Returns the same array.
 */
export async function applyFREDActuals(env, events, todayStr) {
  const byKey = await loadActuals(env);
  if (!byKey || Object.keys(byKey).length === 0) return events;
  const today = todayStr || new Date().toISOString().slice(0, 10);
  const dayMs = 86400000;
  for (const e of events) {
    if (!e || e.actual || !e.date || e.date > today) continue;
    const def = FRED_SERIES.find((d) => d.match.test(e.name || ""));
    if (!def) continue;
    const a = byKey[def.key];
    if (!a || a.display == null) continue;
    // Sanity: the FRED observation (reference period) should be within ~45d of
    // the event date so we don't paste April's print onto June's event.
    const evMs = Date.parse(e.date + "T00:00:00Z");
    const obMs = a.obs_date ? Date.parse(a.obs_date + "T00:00:00Z") : NaN;
    if (Number.isFinite(evMs) && Number.isFinite(obMs) && Math.abs(evMs - obMs) > 45 * dayMs) continue;
    e.actual = a.display;
    e.actual_source = "fred";
  }
  return events;
}
