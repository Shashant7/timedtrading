// worker/cro/macro-event-extractor.js
// ─────────────────────────────────────────────────────────────────────────────
//  Extract the US macro-economic calendar (dates, times, estimates, ACTUALS)
//  from ingested FSD notes — so the Today macro-events strip self-updates from
//  the research we already pull instead of a hand-maintained list.
// ─────────────────────────────────────────────────────────────────────────────
//
//  FSD "First Word" (Tom Lee) and "Daily" notes embed the full incoming-data
//  block, e.g.:
//     "6/5 8:30 AM ET: May Non-Farm Payrolls 85ke"
//     "6/1 9:45 AM ET: May ISM Manufacturing PMI 54.0 vs 53.0e"  (actual vs est)
//     "6/17 2:00 PM ET: Jun FOMC Decision"
//  We run a focused LLM pass on calendar-bearing notes, extract structured
//  events, and merge them into KV `timed:macro:events:fsd` (keyed by
//  date|normalized-name, newest note wins, actuals preserved). getUpcoming-
//  MacroEvents() then prefers these FSD-sourced events over the curated floor.

import { loadPublicationText } from "./fsd-ingestion.js";

const STORE_KEY = "cro:macro:events:fsd";
const DEFAULT_MODEL = "gpt-4o-mini";
const EXTRACT_TIMEOUT_MS = 40_000;

// Quick gate: only spend an LLM call on notes that look like they carry a
// macro calendar. Avoids extracting from single-stock / crypto flash notes.
const CALENDAR_SIGNALS = /(first word|incoming data|economic data|non[- ]?farm|payroll|\bCPI\b|\bPPI\b|\bFOMC\b|\bPCE\b|jobless claims|jolts|retail sales|ism (manufacturing|services)|fed (rate|decision|chair)|inflation report)/i;

export function looksLikeMacroCalendar(text, title) {
  const hay = `${title || ""}\n${String(text || "").slice(0, 4000)}`;
  return CALENDAR_SIGNALS.test(hay);
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40);
}

async function callOpenAI(env, messages) {
  const key = env?.OPENAI_API_KEY;
  if (!key) return { ok: false, error_kind: "no_openai_key" };
  const model = DEFAULT_MODEL;
  const body = { model, messages, max_completion_tokens: 1200, response_format: { type: "json_object" } };
  if (!String(model).toLowerCase().startsWith("gpt-5")) body.temperature = 0.0;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), EXTRACT_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) return { ok: false, error_kind: `openai_${resp.status}` };
    const json = await resp.json();
    return { ok: true, content: json.choices?.[0]?.message?.content || "" };
  } catch (e) {
    return { ok: false, error_kind: e?.name === "AbortError" ? "openai_timeout" : "openai_exception" };
  } finally {
    clearTimeout(t);
  }
}

function buildPrompt(text, pubDateISO) {
  return [
    {
      role: "system",
      content: [
        "You extract the US MACRO-ECONOMIC CALENDAR from a research note. Output JSON only.",
        "Include ONLY scheduled US economic data releases and Federal Reserve events (e.g., Non-Farm Payrolls, CPI, PPI, PCE, JOLTS, Retail Sales, ISM/PMI, FOMC rate decision, Fed Chair remarks, GDP, sentiment surveys).",
        "EXCLUDE: single-company earnings, price targets, ticker commentary, non-US data.",
        "For each event capture the date (resolve to YYYY-MM-DD using the note's date for year/month context), the ET time if given, the estimate (consensus) if given, and the ACTUAL if the note shows it was already released (e.g. '54.0 vs 53.0e' → actual 54.0, estimate 53.0).",
        "impact: high (NFP/CPI/PPI/PCE/FOMC/Retail Sales), medium (JOLTS/ISM/PMI/GDP/sentiment/housing), low (everything else).",
        "kind: one of jobs|inflation|fomc|consumer|manufacturing|housing|growth|sentiment|trade|other.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `Note publication date: ${pubDateISO || "(unknown)"} (use for year/month inference).`,
        "",
        "NOTE TEXT:",
        "```",
        String(text).slice(0, 16000),
        "```",
        "",
        "Return EXACTLY:",
        '{ "events": [ { "date": "YYYY-MM-DD", "time_et": "8:30 AM" | null, "name": "May Non-Farm Payrolls", "impact": "high"|"medium"|"low", "kind": "jobs", "estimate": "+85K" | null, "actual": "139K" | null } ] }',
        "If the note contains no macro calendar, return { \"events\": [] }.",
      ].join("\n"),
    },
  ];
}

async function loadStore(env) {
  try {
    const raw = await env?.KV?.get(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && typeof parsed === "object" && parsed.byKey) ? parsed : { byKey: {}, updated_at: 0 };
  } catch (_) { return { byKey: {}, updated_at: 0 }; }
}

async function saveStore(env, store) {
  if (!env?.KV) return;
  // Prune events older than 10 days to keep the blob small.
  const cutoff = (() => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 10); return d.toISOString().slice(0, 10); })();
  const byKey = {};
  for (const [k, v] of Object.entries(store.byKey || {})) {
    if (v && typeof v.date === "string" && v.date >= cutoff) byKey[k] = v;
  }
  store.byKey = byKey;
  store.updated_at = Date.now();
  try { await env.KV.put(STORE_KEY, JSON.stringify(store)); } catch (_) {}
}

/**
 * Extract macro events from one publication and merge into the FSD store.
 * Best-effort + cheap-gated: only calendar-bearing notes hit the LLM.
 * @returns { ok, extracted, merged, skipped? }
 */
export async function extractMacroEventsFromPublication(env, pubId, { title = null } = {}) {
  const row = await loadPublicationText(env, pubId).catch(() => null);
  const text = row?.text_full || row?.text_excerpt || "";
  if (!text || text.length < 120) return { ok: true, skipped: "no_text", extracted: 0 };
  if (!looksLikeMacroCalendar(text, title)) return { ok: true, skipped: "no_calendar_signal", extracted: 0 };

  // Publish date for year/month inference.
  let pubDateISO = null;
  try {
    const meta = await env.DB.prepare(`SELECT published_at, fetched_at FROM cro_publications WHERE pub_id = ?`).bind(pubId).first();
    pubDateISO = (meta?.published_at || (meta?.fetched_at ? new Date(meta.fetched_at).toISOString() : null) || "").slice(0, 10) || null;
  } catch (_) {}

  const llm = await callOpenAI(env, buildPrompt(text, pubDateISO));
  if (!llm.ok) return { ok: false, error_kind: llm.error_kind, extracted: 0 };
  let parsed = null;
  try { parsed = JSON.parse(llm.content); } catch (_) { return { ok: false, error_kind: "json_parse_failed", extracted: 0 }; }
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  if (events.length === 0) return { ok: true, extracted: 0, merged: 0 };

  const store = await loadStore(env);
  let merged = 0;
  const nowPub = pubDateISO || new Date().toISOString().slice(0, 10);
  for (const e of events) {
    const date = String(e.date || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !e.name) continue;
    const key = `${date}|${normName(e.name)}`;
    const prev = store.byKey[key] || null;
    // Newest note wins; but never wipe a known actual with null.
    const next = {
      date,
      time_et: e.time_et || prev?.time_et || null,
      name: String(e.name).slice(0, 80),
      impact: ["high", "medium", "low"].includes(e.impact) ? e.impact : (prev?.impact || "medium"),
      kind: e.kind || prev?.kind || "macro",
      estimate: (e.estimate != null && e.estimate !== "") ? String(e.estimate).slice(0, 24) : (prev?.estimate || null),
      actual: (e.actual != null && e.actual !== "") ? String(e.actual).slice(0, 24) : (prev?.actual || null),
      source: "fsd",
      src_pub: pubId,
      src_date: nowPub,
    };
    // Only overwrite if this note is same-or-newer than the stored one.
    if (!prev || nowPub >= (prev.src_date || "")) {
      store.byKey[key] = next;
      merged += 1;
    }
  }
  await saveStore(env, store);
  return { ok: true, extracted: events.length, merged };
}

/** Load FSD-extracted macro events (array) for the calendar merge. */
export async function loadFSDMacroEvents(env) {
  const store = await loadStore(env);
  return Object.values(store.byKey || {});
}
