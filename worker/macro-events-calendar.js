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
//  sentiment/ISM) and merges in any live actuals/estimates we do manage to
//  fetch. Curated entries carry the scheduled date + ET time; `actual` fills
//  in from the live feed (or stays null until the print lands).
//
//  Maintenance: extend CURATED_UPCOMING each quarter. The schedule is sourced
//  from the FSD "First Word" incoming-data block + the published FOMC calendar.
//  TODO(roadmap): auto-extract this from ingested FSD notes so it self-updates.

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
];

function nyDateStr(d = new Date()) {
  const p = d.toLocaleString("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).split("/");
  return `${p[2]}-${p[0]}-${p[1]}`;
}

/**
 * Return upcoming high-impact US macro events from today out `days` ahead,
 * merging the curated schedule with any live actuals/estimates already
 * persisted (best-effort). Sorted by date+time ascending; `is_today` flagged.
 *
 * @param env
 * @param opts { days?, includeLowImpact? }
 */
export async function getUpcomingMacroEvents(env, { days = 14, includeLowImpact = false } = {}) {
  const today = nyDateStr();
  const horizon = (() => {
    const d = new Date(today + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + Math.max(1, days));
    return d.toISOString().slice(0, 10);
  })();

  const normKey = (date, name) => `${date}|${String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40)}`;

  // Merge map: curated schedule is the floor; FSD-extracted events (from
  // ingested "First Word" / daily notes) override + supply real estimates +
  // ACTUALS, and add events the curated list doesn't know about.
  const byKey = new Map();
  for (const e of CURATED_UPCOMING_MACRO) {
    if (e.date < today || e.date > horizon) continue;
    byKey.set(normKey(e.date, e.name), {
      date: e.date, time_et: e.time_et || null, name: e.name, impact: e.impact,
      kind: e.kind || "macro", estimate: e.estimate || null, actual: null, source: "curated",
    });
  }

  // 2026-06-05 — FSD-extracted events (self-updating from ingested notes).
  let fsdCount = 0;
  try {
    const { loadFSDMacroEvents } = await import("./cro/macro-event-extractor.js");
    const fsdEvents = await loadFSDMacroEvents(env);
    for (const e of (fsdEvents || [])) {
      if (!e?.date || e.date < today || e.date > horizon) continue;
      const k = normKey(e.date, e.name);
      const prev = byKey.get(k);
      byKey.set(k, {
        date: e.date,
        time_et: e.time_et || prev?.time_et || null,
        name: e.name || prev?.name,
        impact: e.impact || prev?.impact || "medium",
        kind: e.kind || prev?.kind || "macro",
        estimate: e.estimate || prev?.estimate || null,
        actual: e.actual || prev?.actual || null,
        source: "fsd",
      });
      fsdCount += 1;
    }
  } catch (_) { /* FSD store optional — curated is the floor */ }

  let items = Array.from(byKey.values())
    .filter((e) => includeLowImpact || e.impact !== "low")
    .map((e) => ({ ...e, is_today: e.date === today }))
    .sort((a, b) => (a.date === b.date ? (String(a.time_et) < String(b.time_et) ? -1 : 1) : a.date < b.date ? -1 : 1));

  // 2026-06-05 — Near-real-time ACTUALS from FRED (authoritative, fills within
  // minutes of release vs FSD's note cadence). Best-effort; no-op without key.
  try {
    const { applyFREDActuals } = await import("./macro-actuals-fred.js");
    const { stripPreReleaseActuals } = await import("./macro-release-time.js");
    items = await applyFREDActuals(env, items, today);
    stripPreReleaseActuals(items);
  } catch (_) { /* FRED layer optional */ }

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
