// worker/macro-event-canonical.js
// Canonical identity for macro calendar rows — dedupes FSD short names
// ("May JOLTS") with curated long names ("May JOLTS Job Openings") on the
// same release date.

/** Order matters: more-specific matchers before broad ones (core CPI before CPI). */
export const MACRO_SERIES_MATCHERS = [
  { key: "nfp", match: /non[- ]?farm|payroll/i, kind: "jobs" },
  { key: "unrate", match: /unemployment rate/i, kind: "jobs" },
  { key: "core_cpi", match: /core cpi/i, kind: "inflation" },
  { key: "cpi", match: /(^|[^e])\bcpi\b/i, kind: "inflation" },
  { key: "core_pce", match: /core pce/i, kind: "inflation" },
  { key: "pce", match: /(^|[^e])\bpce\b/i, kind: "inflation" },
  { key: "core_ppi", match: /core ppi/i, kind: "inflation" },
  { key: "retail", match: /retail sales/i, kind: "consumer" },
  { key: "jolts", match: /jolts/i, kind: "jobs" },
  { key: "gdp", match: /\bgdp\b/i, kind: "growth" },
  { key: "fedfunds", match: /fomc|fed (rate|funds|decision)/i, kind: "fomc" },
];

const IMPACT_RANK = { high: 3, medium: 2, low: 1 };

export function findMacroSeriesDef(name) {
  return MACRO_SERIES_MATCHERS.find((d) => d.match.test(String(name || ""))) || null;
}

export function resolveMacroSeriesKey(name) {
  return findMacroSeriesDef(name)?.key || null;
}

/** Stable dedupe / KV key: date + series alias when known, else normalized title. */
export function macroEventCanonicalKey(date, name) {
  const series = resolveMacroSeriesKey(name);
  if (series) return `${date}|${series}`;
  const slug = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40);
  return `${date}|${slug}`;
}

export function pickPreferredMacroName(a, b) {
  const na = String(a || "").trim();
  const nb = String(b || "").trim();
  if (!na) return nb;
  if (!nb) return na;
  if (na.length !== nb.length) return na.length >= nb.length ? na : nb;
  return na;
}

export function mergeMacroEventRow(base, incoming) {
  if (!base) return incoming ? { ...incoming } : null;
  if (!incoming) return { ...base };
  const baseRank = IMPACT_RANK[base.impact] || 0;
  const incRank = IMPACT_RANK[incoming.impact] || 0;
  const merged = {
    date: base.date || incoming.date,
    time_et: base.time_et || incoming.time_et || null,
    name: pickPreferredMacroName(base.name, incoming.name),
    impact: incRank >= baseRank ? (incoming.impact || base.impact) : base.impact,
    kind: base.kind || incoming.kind || findMacroSeriesDef(incoming.name)?.kind || "macro",
    estimate: incoming.estimate || base.estimate || null,
    actual: incoming.actual || base.actual || null,
    actual_source: incoming.actual_source || base.actual_source || null,
    previous: incoming.previous || base.previous || null,
    source: base.source && incoming.source && base.source !== incoming.source
      ? "merged"
      : (incoming.source || base.source || "curated"),
  };
  return merged;
}

/** Collapse duplicate rows that share the same canonical release (e.g. JOLTS variants). */
export function dedupeMacroEventsByCanonical(events) {
  const byCanon = new Map();
  for (const e of events || []) {
    if (!e?.date) continue;
    const k = macroEventCanonicalKey(e.date, e.name);
    const prev = byCanon.get(k);
    byCanon.set(k, prev ? mergeMacroEventRow(prev, e) : { ...e });
  }
  return Array.from(byCanon.values());
}
