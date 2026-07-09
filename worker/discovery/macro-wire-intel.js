// worker/discovery/macro-wire-intel.js
//
// LLM classification + real-time pulse for Delta One (@DeItaone).
// Feeds CRO synthesis, CIO Layer 15f,
// live rank tilt (macro-risk-tilt.js), and timed:discovery:news-summary.

import { headlineMentionsTicker, ensureTickerNewsSchema } from "./news-tracker.js";
import { THEMES, getThemesForTicker } from "../sector-mapping.js";
import { DELTA_ONE_HANDLE, isDeltaOneHandle } from "./x-wire-tracker.js";

export const MACRO_WIRE_KIND = "macro_wire";
export { DELTA_ONE_HANDLE };
export const MACRO_WIRE_PULSE_KV = "timed:discovery:macro-wire-pulse";
export const NEWS_SUMMARY_KV = "timed:discovery:news-summary";

const CLASSIFY_MODEL_FALLBACK = "gpt-4o-mini";
const CLASSIFY_TIMEOUT_MS = 18_000;
const VALID_THEMES = new Set(Object.keys(THEMES || {}));

const CLASSIFY_SYSTEM = [
  "You classify real-time macro/market wire headlines for a trading desk.",
  "Return JSON only with this shape:",
  '{"sentiment":"bullish|bearish|neutral","urgency":"high|medium|low","risk_tone":"risk-on|risk-off|neutral",',
  '"is_catalyst":boolean,"catalyst_strength":0-10,',
  '"themes":["<theme_key from allowed list only>"],',
  '"sectors":["<GICS-style sector name>"],',
  '"tickers":["<US equity/index ETF symbols, no $>"]}',
  "",
  "Allowed theme keys (use exact strings, omit if none apply):",
  Object.keys(THEMES || {}).join(", "),
  "",
  "Rules:",
  "- Macro data prints (CPI, NFP, job openings) → high urgency, is_catalyst true.",
  "- Geopolitical / headline noise without tradable impact → low urgency.",
  "- Infer tickers/sectors/themes even when not cashtagged (e.g. NATO → defense).",
  "- catalyst_strength: 0=noise, 10=immediate market mover.",
].join("\n");

export function isMacroWireKind(kind) {
  return String(kind || "").toLowerCase() === MACRO_WIRE_KIND;
}

export function isDeltaOnePost(row) {
  return isDeltaOneHandle(row?.handle);
}

export function parseIntelJson(raw) {
  if (!raw) return null;
  try {
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!p || typeof p !== "object") return null;
    const sentiment = ["bullish", "bearish", "neutral"].includes(String(p.sentiment).toLowerCase())
      ? String(p.sentiment).toLowerCase() : "neutral";
    const urgency = ["high", "medium", "low"].includes(String(p.urgency).toLowerCase())
      ? String(p.urgency).toLowerCase() : "medium";
    const risk_tone = ["risk-on", "risk-off", "neutral"].includes(String(p.risk_tone).toLowerCase())
      ? String(p.risk_tone).toLowerCase() : "neutral";
    const themes = (Array.isArray(p.themes) ? p.themes : [])
      .map((t) => String(t || "").trim())
      .filter((t) => VALID_THEMES.has(t))
      .slice(0, 4);
    const sectors = (Array.isArray(p.sectors) ? p.sectors : [])
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, 4);
    const tickers = (Array.isArray(p.tickers) ? p.tickers : [])
      .map((t) => String(t || "").toUpperCase().replace(/^\$/, ""))
      .filter((t) => /^[A-Z]{1,5}$/.test(t))
      .slice(0, 8);
    const cs = Math.max(0, Math.min(10, Math.round(Number(p.catalyst_strength) || 0)));
    return {
      sentiment,
      urgency,
      risk_tone,
      is_catalyst: p.is_catalyst === true || cs >= 7,
      catalyst_strength: cs,
      themes,
      sectors,
      tickers,
      classified_at: Date.now(),
    };
  } catch (_) {
    return null;
  }
}

export function urgencyWeight(urgency) {
  if (urgency === "high") return 1.0;
  if (urgency === "low") return 0.35;
  return 0.65;
}

export function sentimentSign(sentiment) {
  if (sentiment === "bullish") return 1;
  if (sentiment === "bearish") return -1;
  return 0;
}

/** Pure: aggregate risk tone from classified posts. */
export function aggregateRiskTone(posts) {
  let riskOn = 0;
  let riskOff = 0;
  for (const p of posts || []) {
    const intel = p.intel || parseIntelJson(p.intel_json);
    if (!intel) continue;
    const w = urgencyWeight(intel.urgency) * (intel.catalyst_strength / 10 || 0.5);
    if (intel.risk_tone === "risk-on") riskOn += w;
    else if (intel.risk_tone === "risk-off") riskOff += w;
  }
  if (riskOff > riskOn + 0.5) return "risk-off";
  if (riskOn > riskOff + 0.5) return "risk-on";
  return "neutral";
}

/** Pure: top catalyst headlines for news-summary KV. */
export function buildTopCatalysts(rows, limit = 8) {
  const scored = [];
  for (const r of rows || []) {
    const intel = r.intel || parseIntelJson(r.intel_json);
    if (!intel) continue;
    const score = (intel.is_catalyst ? 2 : 0)
      + intel.catalyst_strength
      + urgencyWeight(intel.urgency) * 3;
    scored.push({
      headline: String(r.text || "").slice(0, 280),
      source: `@${r.handle || "wire"}`,
      url: r.url || null,
      sentiment: intel.sentiment,
      catalyst_strength: intel.catalyst_strength,
      urgency: intel.urgency,
      themes: intel.themes,
      tickers: intel.tickers,
      score,
      created_at: r.created_at || null,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function classifyMacroWirePost(env, post) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_openai_api_key" };
  const text = String(post?.text || "").trim().slice(0, 500);
  if (!text) return { ok: false, error: "empty_text" };
  const model = String(env?.AI_MACRO_WIRE_MODEL || env?.AI_NEWS_SENTIMENT_MODEL || CLASSIFY_MODEL_FALLBACK);
  const isGpt5 = model.toLowerCase().startsWith("gpt-5");
  const body = {
    model,
    messages: [
      { role: "system", content: CLASSIFY_SYSTEM },
      { role: "user", content: `Classify this wire headline:\n\n${text}` },
    ],
    max_completion_tokens: 400,
    response_format: { type: "json_object" },
  };
  if (!isGpt5) body.temperature = 0.0;
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { ok: false, error: `openai_${resp.status}` };
    }
    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content || "";
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { /* invalid */ }
    const intel = parseIntelJson(parsed);
    if (!intel) return { ok: false, error: "parse_failed", raw_preview: raw.slice(0, 200) };
    return { ok: true, intel, model };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

export async function storePostIntel(env, postId, intel) {
  const db = env?.DB;
  if (!db || !postId || !intel) return false;
  try {
    await db.prepare(
      `UPDATE x_wire_posts SET intel_json = ?2 WHERE post_id = ?1`,
    ).bind(String(postId), JSON.stringify(intel)).run();
    return true;
  } catch (_) {
    return false;
  }
}

/** Fan out LLM-inferred tickers (plus validated cashtags) into ticker_news. */
export async function fanOutIntelToTickerNews(env, post, intel, cashtags = []) {
  const db = env?.DB;
  if (!db || !intel) return 0;
  await ensureTickerNewsSchema(env);
  const headline = String(post.text || "").trim().slice(0, 500);
  const url = post.url || `https://x.com/i/status/${post.post_id}`;
  const source = `@${String(post.handle || "wire").replace(/^@/, "")}`;
  const dtIso = post.created_at || new Date().toISOString();
  const now = Date.now();
  const syms = new Set([
    ...(Array.isArray(cashtags) ? cashtags : []).map((t) => String(t).toUpperCase()),
    ...(intel.tickers || []),
  ]);
  let count = 0;
  for (const sym of syms) {
    const t = String(sym || "").toUpperCase();
    if (!t) continue;
    const isInferred = (intel.tickers || []).includes(t);
    if (!isInferred && !headlineMentionsTicker(headline, null, t)) continue;
    try {
      await db.prepare(`
        INSERT OR IGNORE INTO ticker_news
          (ticker, headline, source, url, summary, datetime_utc,
           sentiment, catalyst_strength, is_catalyst, scored_at, scored_by, created_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
      `).bind(
        t, headline, source, url,
        `X macro wire (${intel.urgency})`,
        dtIso,
        intel.sentiment,
        intel.catalyst_strength,
        intel.is_catalyst ? 1 : 0,
        now,
        "macro_wire_intel",
        now,
      ).run();
      count += 1;
    } catch (_) { /* unique collision */ }
  }
  return count;
}

export async function classifyAndEnrichPost(env, row, cashtags = []) {
  if (!isDeltaOnePost(row)) return { ok: true, skipped: true };
  const cls = await classifyMacroWirePost(env, row);
  if (!cls.ok || !cls.intel) return cls;
  await storePostIntel(env, row.post_id, cls.intel);
  const fanout = await fanOutIntelToTickerNews(env, row, cls.intel, cashtags);
  return { ok: true, intel: cls.intel, fanout, model: cls.model };
}

export async function loadRecentMacroWireRows(env, opts = {}) {
  const db = env?.DB;
  if (!db) return [];
  const lookbackHours = Math.max(1, Math.min(48, Number(opts.lookbackHours) || 4));
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 25));
  const cutoffIso = new Date(Date.now() - lookbackHours * 3600000).toISOString();
  const cutoffMs = Date.now() - lookbackHours * 3600000;
  try {
    const rows = (await db.prepare(`
      SELECT post_id, handle, kind, text, created_at, url, tickers_json, macro_json, intel_json, ingested_at
        FROM x_wire_posts
       WHERE handle = ?1 AND (created_at >= ?2 OR ingested_at >= ?3)
       ORDER BY COALESCE(created_at, '') DESC, ingested_at DESC
       LIMIT ?4
    `).bind(DELTA_ONE_HANDLE, cutoffIso, cutoffMs, limit).all().catch(() => ({ results: [] })))?.results || [];
    return rows.map((r) => ({
      ...r,
      intel: parseIntelJson(r.intel_json),
    }));
  } catch (_) {
    return [];
  }
}

/** Build + persist real-time macro wire pulse KV blob. */
export async function refreshMacroWirePulse(env, opts = {}) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return { ok: false, error: "no_kv" };
  const lookbackHours = Number(opts.lookbackHours) || 4;
  const rows = await loadRecentMacroWireRows(env, { lookbackHours, limit: 30 });
  const classified = rows.filter((r) => r.intel);
  const posts = classified.map((r) => ({
    post_id: r.post_id,
    handle: r.handle,
    text: String(r.text || "").slice(0, 280),
    url: r.url,
    created_at: r.created_at,
    macro: r.macro_json ? (() => { try { return JSON.parse(r.macro_json); } catch (_) { return null; } })() : null,
    intel: r.intel,
  }));
  const themeCounts = {};
  for (const p of classified) {
    for (const th of (p.intel?.themes || [])) {
      themeCounts[th] = (themeCounts[th] || 0) + 1;
    }
  }
  const dominantThemes = Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));

  const payload = {
    generated: new Date().toISOString(),
    lookback_hours: lookbackHours,
    post_count: rows.length,
    classified_count: classified.length,
    risk_tone: aggregateRiskTone(classified),
    dominant_themes: dominantThemes,
    posts,
    handles: [...new Set(rows.map((r) => r.handle))],
  };
  try {
    await kv.put(MACRO_WIRE_PULSE_KV, JSON.stringify(payload));
    try {
      const { invalidateMacroRiskTiltCache } = await import("../macro-risk-tilt.js");
      invalidateMacroRiskTiltCache();
    } catch (_) {}
    return { ok: true, ...payload };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** Populate timed:discovery:news-summary for CRO discovery.news_top. */
export async function refreshNewsSummary(env, opts = {}) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return { ok: false, error: "no_kv" };
  const rows = await loadRecentMacroWireRows(env, {
    lookbackHours: opts.lookbackHours || 12,
    limit: 40,
  });
  const top = buildTopCatalysts(rows, 8);
  const payload = {
    generated: new Date().toISOString(),
    source: "delta_one",
    top_catalysts: top,
  };
  try {
    await kv.put(NEWS_SUMMARY_KV, JSON.stringify(payload));
    return { ok: true, count: top.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

export async function loadMacroWirePulse(env) {
  const kv = env?.KV_TIMED || env?.KV;
  try {
    const raw = await kv?.get(MACRO_WIRE_PULSE_KV);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/** CIO-facing compact slice for one ticker from the pulse. */
export function macroWireContextForTicker(pulse, sym) {
  if (!pulse || !sym) return null;
  const S = String(sym).toUpperCase();
  const themes = getThemesForTicker(S) || [];
  const relevant = (pulse.posts || []).filter((p) => {
    const intel = p.intel;
    if (!intel) return false;
    if ((intel.tickers || []).includes(S)) return true;
    if ((intel.themes || []).some((t) => themes.includes(t))) return true;
    return false;
  }).slice(0, 4);
  if (relevant.length === 0 && pulse.risk_tone === "neutral") return null;
  return {
    risk_tone: pulse.risk_tone,
    dominant_themes: (pulse.dominant_themes || []).slice(0, 3),
    relevant_headlines: relevant.map((p) => ({
      text: p.text,
      handle: p.handle,
      urgency: p.intel?.urgency,
      sentiment: p.intel?.sentiment,
      created_at: p.created_at,
    })),
    note: "Delta One (@DeItaone) real-time macro wire. CONTEXT for timing — not a hard override.",
  };
}
