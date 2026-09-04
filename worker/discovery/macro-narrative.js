// worker/discovery/macro-narrative.js
//
// Session-level macro NARRATIVE synthesis for the Delta One wire (shadow).
//
// Why: per-post classification treats each headline in isolation. On
// 2026-09-03 six Waller headlines ("hold rates", "inflation coming down",
// "rate futures jump") landed in one premarket hour; individually most
// classified neutral and the aggregate pulse stayed "neutral" while a human
// read the sequence as decisively risk-on. This module clusters same-story
// posts inside the session window and synthesizes a story-level tone.
//
// SHADOW ONLY: results are written onto the pulse KV as `narratives`,
// `narrative_risk_tone`, and `narrative_divergence`. No decision path
// (rank tilt, CIO, CRO stance) reads them yet — per the ledger-audit
// charter, influence is a separate one-lever experiment after this field
// accrues enough history to grade against outcomes.

import { parseIntelJson, urgencyWeight } from "./macro-wire-intel.js";
import { decodeXWireText } from "./x-wire-tracker.js";

const SYNTH_MODEL_FALLBACK = "gpt-4o-mini";
const SYNTH_TIMEOUT_MS = 18_000;
/** Max LLM synthesis calls per pulse refresh (caching makes repeats free). */
const MAX_SYNTH_PER_REFRESH = 2;
/** A story needs this many same-subject posts to be a narrative. */
export const MIN_CLUSTER_POSTS = 3;

const STOPWORDS = new Set([
  "THE", "AND", "FOR", "ARE", "WITH", "THAT", "THIS", "FROM", "HAVE", "HAS",
  "WILL", "SAYS", "SAY", "SAID", "AFTER", "OVER", "INTO", "MORE", "THAN",
  "NOT", "BUT", "ITS", "OUT", "NOW", "NEW", "ON", "IN", "OF", "TO", "AS",
  "BE", "IS", "IT", "AT", "BY", "AN", "A", "US", "U.S", "REALLY", "SHOULD",
  "COULD", "WOULD", "SOME", "SEE", "WE", "IF", "HE", "SHE", "THEY", "YOU",
  "ALL", "ONE", "TWO", "PER", "VS", "AMID", "STILL", "JUST", "ALSO",
]);

function tokenize(text) {
  return String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s.%'-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+([.,]\d+)?%?$/.test(t));
}

/**
 * Pure. Cluster classified wire posts into same-story groups.
 *
 * Anchor tokens are distinctive words appearing in >= MIN_CLUSTER_POSTS
 * posts within the window (e.g. WALLER, FED, OPEC). A post joins the
 * cluster of its strongest anchor. Deterministic — no LLM.
 */
export function clusterWirePosts(posts, { minClusterPosts = MIN_CLUSTER_POSTS } = {}) {
  const rows = (posts || [])
    .map((p) => ({
      post: p,
      intel: p.intel || parseIntelJson(p.intel_json),
      tokens: new Set(tokenize(decodeXWireText(p.text))),
    }))
    .filter((r) => r.intel && r.tokens.size > 0);

  const tokenCounts = new Map();
  for (const r of rows) {
    for (const t of r.tokens) tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
  }
  const anchors = [...tokenCounts.entries()]
    .filter(([, n]) => n >= minClusterPosts)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);

  const clusters = new Map();
  for (const r of rows) {
    const anchor = anchors.find((a) => r.tokens.has(a));
    if (!anchor) continue;
    if (!clusters.has(anchor)) clusters.set(anchor, []);
    clusters.get(anchor).push(r);
  }

  return [...clusters.entries()]
    .filter(([, members]) => members.length >= minClusterPosts)
    .map(([anchor, members]) => ({
      anchor,
      posts: members.map((m) => m.post),
      intels: members.map((m) => m.intel),
      texts: members.map((m) => decodeXWireText(m.post.text).slice(0, 200)),
    }))
    .sort((a, b) => b.posts.length - a.posts.length);
}

const SYNTH_SYSTEM = [
  "You synthesize a SEQUENCE of related macro wire headlines from one trading session into a single story read for a trading desk.",
  "The sequence matters: repeated same-direction headlines are a stronger signal than any one alone.",
  "Return JSON only:",
  '{"story":"<one sentence>","risk_tone":"risk-on|risk-off|neutral",',
  '"sentiment":"bullish|bearish|neutral","conviction":0-10,"sustained":boolean}',
  "",
  "Rules:",
  "- conviction reflects how decisively the FULL sequence points one way (repetition + escalation raise it).",
  "- sustained=true when 3+ headlines reinforce the same direction across the window.",
  "- A market-reaction headline (futures/odds moving on the story) is strong confirmation.",
].join("\n");

function narrativeHash(texts) {
  let h = 2166136261;
  const s = texts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function parseNarrativeJson(raw) {
  try {
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!p || typeof p !== "object") return null;
    const risk_tone = ["risk-on", "risk-off", "neutral"].includes(String(p.risk_tone).toLowerCase())
      ? String(p.risk_tone).toLowerCase() : "neutral";
    const sentiment = ["bullish", "bearish", "neutral"].includes(String(p.sentiment).toLowerCase())
      ? String(p.sentiment).toLowerCase() : "neutral";
    const conviction = Math.max(0, Math.min(10, Math.round(Number(p.conviction) || 0)));
    return {
      story: String(p.story || "").slice(0, 240),
      risk_tone,
      sentiment,
      conviction,
      sustained: p.sustained === true,
    };
  } catch (_) {
    return null;
  }
}

export async function synthesizeNarrative(env, cluster) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_openai_api_key" };
  const KV = env?.KV_TIMED || env?.KV;
  const hash = narrativeHash(cluster.texts);
  const cacheKey = `timed:macro-narrative:${hash}`;
  if (KV) {
    try {
      const cached = await KV.get(cacheKey, "json");
      if (cached?.narrative) return { ok: true, narrative: cached.narrative, cached: true };
    } catch (_) { /* cache optional */ }
  }
  const model = String(env?.AI_MACRO_WIRE_MODEL || env?.AI_NEWS_SENTIMENT_MODEL || SYNTH_MODEL_FALLBACK);
  const isGpt5 = model.toLowerCase().startsWith("gpt-5");
  const user = `Subject: ${cluster.anchor}\n\nHeadlines in session order:\n`
    + cluster.texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const body = {
    model,
    messages: [
      { role: "system", content: SYNTH_SYSTEM },
      { role: "user", content: user },
    ],
    max_completion_tokens: 300,
    response_format: { type: "json_object" },
  };
  if (!isGpt5) body.temperature = 0.0;
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS),
    });
    if (!resp.ok) return { ok: false, error: `openai_${resp.status}` };
    const json = await resp.json();
    const narrative = parseNarrativeJson(json.choices?.[0]?.message?.content || "");
    if (!narrative) return { ok: false, error: "parse_failed" };
    if (KV) {
      try { await KV.put(cacheKey, JSON.stringify({ narrative, model }), { expirationTtl: 2 * 86400 }); } catch (_) {}
    }
    try {
      const { recordOpenAiSpend } = await import("../openai-spend.js");
      recordOpenAiSpend(env, "macro_narrative_synth", {
        model,
        prompt_tokens: json.usage?.prompt_tokens,
        completion_tokens: json.usage?.completion_tokens,
      }).catch(() => {});
    } catch (_) {}
    return { ok: true, narrative, model };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/**
 * Pure. Story-level risk tone from synthesized narratives: the strongest
 * sustained narrative wins; ties fall back to per-post tone.
 */
export function narrativeRiskTone(narratives, perPostTone = "neutral") {
  const sustained = (narratives || [])
    .filter((n) => n && n.sustained && n.conviction >= 6 && n.risk_tone !== "neutral")
    .sort((a, b) => b.conviction - a.conviction);
  if (sustained.length === 0) return perPostTone;
  const top = sustained[0];
  const opposite = sustained.find((n) => n.risk_tone !== top.risk_tone);
  if (opposite && Math.abs(opposite.conviction - top.conviction) <= 1) return perPostTone;
  return top.risk_tone;
}

/**
 * Cluster + synthesize + attach shadow fields to a pulse payload.
 * Never throws; on any failure the payload is returned unchanged.
 */
export async function attachNarrativeShadow(env, payload, classifiedRows) {
  try {
    if (String(env?.MACRO_NARRATIVE_ENABLED || "true") === "false") return payload;
    const clusters = clusterWirePosts(classifiedRows || []);
    if (clusters.length === 0) return payload;
    const narratives = [];
    for (const cluster of clusters.slice(0, MAX_SYNTH_PER_REFRESH)) {
      const res = await synthesizeNarrative(env, cluster);
      if (res.ok && res.narrative) {
        narratives.push({
          anchor: cluster.anchor,
          post_count: cluster.posts.length,
          ...res.narrative,
        });
      }
    }
    if (narratives.length === 0) return payload;
    const shadowTone = narrativeRiskTone(narratives, payload.risk_tone);
    return {
      ...payload,
      narratives,
      narrative_risk_tone: shadowTone,
      // Divergence is the measurable: how often does the story-level read
      // disagree with the per-post aggregate the model currently trades on?
      narrative_divergence: shadowTone !== payload.risk_tone,
    };
  } catch (_) {
    return payload;
  }
}
