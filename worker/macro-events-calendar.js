// worker/macro-events-calendar.js
// ─────────────────────────────────────────────────────────────────────────────
//  Upcoming US macro-event calendar (high-impact releases) for the Today page.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Why this exists: the live sources (Finnhub /calendar/economic is a premium
//  endpoint that returns empty on our key; ForexFactory is a fragile HTML
//  scrape) frequently surface NOTHING, so big prints like Non-Farm Payrolls
//  never showed. This module provides a CURATED, reliable schedule of the
//  high-impact US releases (NFP, CPI, PPI, FOMC, PCE, JOLTS, Retail Sales,
//  sentiment/ISM) plus monthly Options Expiration (3rd Friday / triple
//  witching) and merges in any live actuals/estimates we do manage to
//  fetch. Curated entries carry the scheduled date + ET time; `actual` fills
//  in from the live feed (or stays null until the print lands).
//
//  Maintenance: extend CURATED_UPCOMING each quarter. The schedule is sourced
//  from the FSD "First Word" incoming-data block + the published FOMC calendar.
//  OpEx is generated (see opex-calendar.js) — no hand curation needed.
//  TODO(roadmap): auto-extract this from ingested FSD notes so it self-updates.

import {
  dedupeMacroEventsByCanonical,
  macroEventCanonicalKey,
  mergeMacroEventRow,
} from "./macro-event-canonical.js";
import { listOpexMacroEvents, syncOpexIntoMarketEvents } from "./opex-calendar.js";

// Each entry: { date: "YYYY-MM-DD", time_et: "8:30 AM", name, impact, kind, estimate? }
export const CURATED_UPCOMING_MACRO = [
  // ── June 2026 ──
  { date: "2026-06-05", time_et: "8:30 AM",  name: "May Non-Farm Payrolls",        impact: "high",   kind: "jobs",      estimate: "+85K" },
  { date: "2026-06-05", time_et: "8:30 AM",  name: "May Unemployment Rate",         impact: "high",   kind: "jobs" },
  { date: "2026-06-08", time_et: "11:00 AM", name: "May NY Fed 1yr Inflation Exp",  impact: "medium", kind: "inflation" },
  { date: "2026-06-09", time_et: "6:00 AM",  name: "May Small Business Optimism",   impact: "low",    kind: "sentiment" },
  { date: "2026-06-09", time_et: "8:30 AM",  name: "Apr Trade Balance",             impact: "low",    kind: "trade",     estimate: "-$55B" },
  { date: "2026-06-09", time_et: "10:00 AM", name: "May Existing Home Sales",       impact: "medium", kind: "housing",   estimate: "4.0M" },
  { date: "2026-06-10", time_et: "8:30 AM",  name: "May Core CPI (MoM)",            impact: "high",   kind: "inflation", estimate: "0.30%" },
  { date: "2026-06-11", time_et: "8:30 AM",  name: "May Core PPI (MoM)",            impact: "high",   kind: "inflation", estimate: "0.50%" },
  { date: "2026-06-12", time_et: "10:00 AM", name: "Jun P U. Mich Sentiment + Inflation Exp", impact: "medium", kind: "sentiment" },
  { date: "2026-06-15", time_et: "8:30 AM",  name: "Jun Empire Manufacturing",      impact: "medium", kind: "manufacturing" },
  { date: "2026-06-15", time_et: "10:00 AM", name: "Jun NAHB Housing Market Index", impact: "low",    kind: "housing" },
  { date: "2026-06-17", time_et: "8:30 AM",  name: "May Retail Sales",              impact: "high",   kind: "consumer" },
  { date: "2026-06-17", time_et: "2:00 PM",  name: "Jun FOMC Rate Decision (1st Warsh meeting)", impact: "high", kind: "fomc" },
  { date: "2026-06-18", time_et: "8:30 AM",  name: "Jun Philly Fed Business Outlook", impact: "medium", kind: "manufacturing" },
  { date: "2026-06-23", time_et: "9:45 AM",  name: "Jun P S&P Global PMIs (Mfg + Svcs)", impact: "medium", kind: "manufacturing" },
  { date: "2026-06-25", time_et: "8:30 AM",  name: "1Q T GDP",                      impact: "medium", kind: "growth" },
  { date: "2026-06-25", time_et: "8:30 AM",  name: "May PCE Deflator",              impact: "high",   kind: "inflation" },
  { date: "2026-06-30", time_et: "10:00 AM", name: "May JOLTS Job Openings",        impact: "medium", kind: "jobs" },
  // ── July 2026 (recurring majors; refine when FSD publishes July) ──
  { date: "2026-07-02", time_et: "8:30 AM",  name: "Jun Non-Farm Payrolls",         impact: "high",   kind: "jobs" },
  { date: "2026-07-15", time_et: "8:30 AM",  name: "Jun Core CPI (MoM)",            impact: "high",   kind: "inflation" },
  { date: "2026-07-16", time_et: "8:30 AM",  name: "Jun Core PPI (MoM)",            impact: "high",   kind: "inflation" },
  { date: "2026-07-16", time_et: "8:30 AM",  name: "Jun Retail Sales",              impact: "high",   kind: "consumer" },
  { date: "2026-07-29", time_et: "2:00 PM",  name: "Jul FOMC Rate Decision",        impact: "high",   kind: "fomc" },
  { date: "2026-07-31", time_et: "8:30 AM",  name: "Jun PCE Deflator",              impact: "high",   kind: "inflation" },
  // ── Sep–Dec 2026 FOMC (published Fed calendar; decision day 2:00 PM ET) ──
  { date: "2026-09-16", time_et: "2:00 PM",  name: "Sep FOMC Rate Decision + SEP",  impact: "high",   kind: "fomc" },
  { date: "2026-10-28", time_et: "2:00 PM",  name: "Oct FOMC Rate Decision",        impact: "high",   kind: "fomc" },
  { date: "2026-12-09", time_et: "2:00 PM",  name: "Dec FOMC Rate Decision + SEP",  impact: "high",   kind: "fomc" },
];

function nyDateStr(d = new Date()) {
  const p = d.toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).split("/");
  return `${p[2]}-${p[0]}-${p[1]}`;
}

/** Vendor/LLM FOMC dates within this many days of a published decision snap onto it. */
export const FOMC_SNAP_WINDOW_DAYS = 10;

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isFomcDecisionName(name) {
  const n = String(name || "");
  if (/minutes/i.test(n)) return false;
  return /fomc|fed (rate|funds|decision)/i.test(n);
}

export function curatedFomcDecisionDates() {
  return CURATED_UPCOMING_MACRO.filter((e) => isFomcDecisionName(e.name)).map((e) => e.date);
}

function parseYmdUtc(ymd) {
  if (!YMD_RE.test(String(ymd || ""))) return null;
  const [y, m, d] = String(ymd).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function daysBetweenYmd(a, b) {
  const ta = parseYmdUtc(a);
  const tb = parseYmdUtc(b);
  if (ta == null || tb == null) return null;
  return Math.round((tb - ta) / 86400000);
}

/** Civil weekday for a YYYY-MM-DD using 16:00 UTC (noon Eastern in EDT). */
export function weekdayFromYmd(ymd) {
  if (!YMD_RE.test(String(ymd || ""))) return null;
  return new Date(`${ymd}T16:00:00.000Z`).getUTCDay();
}

export function isWeekendYmd(ymd) {
  const dow = weekdayFromYmd(ymd);
  return dow === 0 || dow === 6;
}

/**
 * Snap a vendor/LLM FOMC *decision* onto the published Fed calendar.
 * Minutes are left alone. Weekend decisions with no nearby curated day
 * are dropped (returns null) so Sunday never labels as FOMC day.
 */
export function snapKnownMacroDate(event) {
  if (!event) return event;
  const date = String(event.date || "").slice(0, 10);
  const name = event.name || event.event || event.event_name || "";
  if (!YMD_RE.test(date)) return event;
  if (!isFomcDecisionName(name)) return { ...event, date };

  const curated = CURATED_UPCOMING_MACRO.filter((e) => isFomcDecisionName(e.name));
  let best = null;
  let bestAbs = Infinity;
  for (const c of curated) {
    const delta = daysBetweenYmd(date, c.date);
    if (delta == null) continue;
    const abs = Math.abs(delta);
    if (abs <= FOMC_SNAP_WINDOW_DAYS && abs < bestAbs) {
      best = c;
      bestAbs = abs;
    }
  }
  if (best && best.date !== date) {
    return {
      ...event,
      date: best.date,
      time_et: event.time_et || event.time || best.time_et,
      date_raw: date,
      date_snapped: "curated_fomc",
    };
  }
  if (isWeekendYmd(date)) return null;
  return { ...event, date };
}

/** Persist / brief helper: YYYY-MM-DD or null if the row should be dropped. */
export function resolveMacroPersistDate(event, fallbackToday) {
  const name = String(event?.event || event?.event_name || event?.name || "").trim();
  if (!name) return null;
  const raw = String(event?.date || fallbackToday || "").slice(0, 10);
  const snapped = snapKnownMacroDate({ date: raw, name });
  return snapped?.date || null;
}

const D1_MACRO_KEYS = new Set([
  "FOMC", "CPI", "NFP", "PPI", "GDP", "PCE", "RETAIL", "CLAIMS", "ISM", "JOLTS", "HOUSING", "OTHER_MACRO",
]);

async function loadD1ScheduledMacroEvents(env, today, horizon) {
  if (!env?.DB) return [];
  try {
    const rs = await env.DB.prepare(`
      SELECT date, event_name, scheduled_time_et, event_key, source, impact
      FROM market_events
      WHERE date >= ? AND date <= ?
        AND event_type = 'macro'
        AND COALESCE(impact, 'medium') IN ('high', 'medium')
        AND COALESCE(status, '') != 'resolved'
    `).bind(today, horizon).all();
    return (rs?.results || [])
      .filter((r) => D1_MACRO_KEYS.has(String(r.event_key || "").toUpperCase()) || isFomcDecisionName(r.event_name))
      .map((r) => ({
        date: String(r.date || "").slice(0, 10),
        time_et: r.scheduled_time_et || null,
        name: r.event_name,
        impact: r.impact || (String(r.event_key).toUpperCase() === "FOMC" ? "high" : "medium"),
        kind: isFomcDecisionName(r.event_name) ? "fomc" : "macro",
        source: r.source || "d1",
      }));
  } catch (_) {
    return [];
  }
}

/** Drop upcoming FOMC *decision* rows that are not on the published calendar. */
export async function purgeUncuratedUpcomingFomc(env, today = nyDateStr()) {
  if (!env?.DB) return { ok: false, deleted: 0 };
  const keep = curatedFomcDecisionDates();
  if (!keep.length) return { ok: true, deleted: 0 };
  const placeholders = keep.map(() => "?").join(",");
  try {
    const rs = await env.DB.prepare(`
      DELETE FROM market_events
      WHERE event_key = 'FOMC'
        AND date >= ?
        AND date NOT IN (${placeholders})
        AND LOWER(COALESCE(event_name, '')) NOT LIKE '%minute%'
    `).bind(today, ...keep).run();
    return { ok: true, deleted: Number(rs?.meta?.changes || 0) };
  } catch (_) {
    return { ok: false, deleted: 0 };
  }
}

/**
 * Return upcoming high-impact US macro events from today out `days` ahead,
 * merging the curated schedule with any live actuals/estimates already
 * persisted (best-effort). Sorted by date+time ascending; `is_today` flagged.
 *
 * @param env
 * @param opts { days?, includeLowImpact?, today? }
 */
export async function getUpcomingMacroEvents(env, { days = 14, includeLowImpact = false, today: todayOverride } = {}) {
  const today = todayOverride || nyDateStr();
  const horizon = (() => {
    const d = new Date(today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + Math.max(1, days));
    return d.toISOString().slice(0, 10);
  })();

  const normKey = macroEventCanonicalKey;

  // Merge map: curated schedule is the floor; FSD-extracted events (from
  // ingested "First Word" / daily notes) override + supply real estimates +
  // ACTUALS, and add events the curated list doesn't know about. Keys use the
  // canonical series alias (e.g. 2026-06-30|jolts) so "May JOLTS" and
  // "May JOLTS Job Openings" collapse to one row.
  const byKey = new Map();
  for (const e of CURATED_UPCOMING_MACRO) {
    if (e.date < today || e.date > horizon) continue;
    byKey.set(normKey(e.date, e.name), {
      date: e.date, time_et: e.time_et || null, name: e.name, impact: e.impact,
      kind: e.kind || "macro", estimate: e.estimate || null, actual: null, source: "curated",
    });
  }

  // Monthly OpEx / triple witching — generated 3rd Fridays (not hand-curated).
  for (const e of listOpexMacroEvents({ fromDate: today, toDate: horizon, months: 8 })) {
    byKey.set(normKey(e.date, e.name), {
      date: e.date, time_et: e.time_et || null, name: e.name, impact: e.impact,
      kind: e.kind || "opex", estimate: null, actual: null, source: "opex_calendar",
    });
  }

  // Keep market_events in sync so entry/exit risk gates see OpEx without
  // waiting on the next Daily Brief persist.
  try {
    await syncOpexIntoMarketEvents(env, { months: 4 });
  } catch (_) { /* best-effort */ }

  // 2026-06-05 — FSD-extracted events (self-updating from ingested notes).
  let fsdCount = 0;
  try {
    const { loadFSDMacroEvents } = await import("./cro/macro-event-extractor.js");
    const fsdEvents = await loadFSDMacroEvents(env);
    for (const raw of (fsdEvents || [])) {
      const e = snapKnownMacroDate({
        date: raw.date,
        name: raw.name,
        time_et: raw.time_et,
        impact: raw.impact,
        kind: raw.kind,
        estimate: raw.estimate,
        actual: raw.actual,
        source: "fsd",
      });
      if (!e?.date || e.date < today || e.date > horizon) continue;
      const k = normKey(e.date, e.name);
      const prev = byKey.get(k);
      byKey.set(k, mergeMacroEventRow(prev, {
        date: e.date,
        time_et: e.time_et || null,
        name: e.name,
        impact: e.impact || prev?.impact || "medium",
        kind: e.kind || prev?.kind || "macro",
        estimate: e.estimate || null,
        actual: e.actual || null,
        actual_source: e.actual ? "fsd" : null,
        source: "fsd",
      }));
      fsdCount += 1;
    }
  } catch (_) { /* FSD store optional — curated is the floor */ }

  // Daily-brief persist is how Empire / second-tier prints reach D1. Merge
  // those scheduled rows so the strip matches the ledger, then snap FOMC
  // onto the published decision day (Sunday "FOMC today" was a persist miss).
  try {
    const d1Events = await loadD1ScheduledMacroEvents(env, today, horizon);
    for (const raw of d1Events) {
      const e = snapKnownMacroDate(raw);
      if (!e?.date || e.date < today || e.date > horizon) continue;
      const k = normKey(e.date, e.name);
      const prev = byKey.get(k);
      byKey.set(k, mergeMacroEventRow(prev, {
        date: e.date,
        time_et: e.time_et || null,
        name: e.name,
        impact: e.impact || prev?.impact || "medium",
        kind: e.kind || prev?.kind || "macro",
        estimate: null,
        actual: null,
        source: e.source || "d1",
      }));
    }
  } catch (_) { /* D1 optional — curated + FSD remain the floor */ }

  let items = dedupeMacroEventsByCanonical(Array.from(byKey.values()))
    .filter((e) => includeLowImpact || e.impact !== "low")
    .map((e) => ({ ...e, is_today: e.date === today }))
    .sort((a, b) => (a.date === b.date ? (String(a.time_et) < String(b.time_et) ? -1 : 1) : a.date < b.date ? -1 : 1));

  // 2026-06-05 — Near-real-time ACTUALS from FRED (authoritative, fills within
  // minutes of release vs FSD's note cadence). Best-effort; no-op without key.
  try {
    const { applyFREDActuals, enrichMacroPreviousFromFRED } = await import("./macro-actuals-fred.js");
    const { stripPreReleaseActuals } = await import("./macro-release-time.js");
    items = await applyFREDActuals(env, items, today);
    items = await enrichMacroPreviousFromFRED(env, items);
    stripPreReleaseActuals(items);
  } catch (_) { /* FRED layer optional */ }

  // X wire macro prints (DeItaone-style) — best-effort; no-op without ingest.
  try {
    const { applyXWireMacroActuals } = await import("./discovery/x-wire-tracker.js");
    items = await applyXWireMacroActuals(env, items, today);
  } catch (_) { /* X wire layer optional */ }

  try {
    const { mergeMacroReleasesIntoEvents, computeMacroPollSchedule } = await import("./macro-release-alerts.js");
    items = await mergeMacroReleasesIntoEvents(env, items);
    const poll = computeMacroPollSchedule(items);
    return {
      ok: true,
      today,
      days,
      count: items.length,
      fsd_events: fsdCount,
      events: items,
      poll,
      generated_at: Date.now(),
    };
  } catch (_) {
    return { ok: true, today, days, count: items.length, fsd_events: fsdCount, events: items, generated_at: Date.now() };
  }
}
