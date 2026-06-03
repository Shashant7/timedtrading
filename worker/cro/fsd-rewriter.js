// worker/cro/fsd-rewriter.js
// ─────────────────────────────────────────────────────────────────────────────
//  Phase 3b — Rewrite FSD publications into TT's own voice.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Goals:
//    1. Compliance — never republish FSD's copyrighted body verbatim. We
//       paraphrase + summarize.
//    2. Brand consistency — TT voice is concise, technical-first, action-
//       oriented. FSD voice is more conversational + chart-heavy.
//    3. Per-ticker actionability — each rewrite extracts the explicit
//       price levels / time horizon / direction the FSD author called
//       out, structured so the Catalysts tab can render them as chips.
//
//  Output schema (returned + persisted):
//    {
//      tt_summary_title:   short headline, 50-100 chars
//      tt_summary_body:    3-5 sentence paraphrase, TT voice
//      tt_key_points:      [{ ticker, kind, level?, direction?, horizon?, note }]
//      tt_cta:             "what should the desk DO with this?"
//      attribution:        the canonical "Source: Fundstrat Direct, ...
//                          " line we MUST always render alongside.
//    }
//
//  Persisted to D1 cro_publication_rewrites; surfaced via
//  loadFSDIntelForTicker so the Catalysts tab renders TT-voice when
//  available + falls back to the raw excerpt when the rewriter hasn't
//  run yet (cold pubs, LLM failure, etc.).

import { loadPublicationText } from "./fsd-ingestion.js";

const REWRITES_TABLE = "cro_publication_rewrites";
const REWRITE_TIMEOUT_MS = 30_000;
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_INPUT_CHARS = 12_000;
const MAX_COMPLETION_TOKENS = 800;

// ── Schema ───────────────────────────────────────────────────────────────────
export async function ensureRewriteSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${REWRITES_TABLE} (
        pub_id              TEXT PRIMARY KEY,
        tt_summary_title    TEXT,
        tt_summary_body     TEXT,
        tt_key_points_json  TEXT,
        tt_cta              TEXT,
        attribution         TEXT,
        model_used          TEXT,
        prompt_tokens       INTEGER,
        completion_tokens   INTEGER,
        rewritten_at        INTEGER NOT NULL,
        error               TEXT
      )
    `).run();
  } catch (e) {
    console.warn("[CRO_REWRITER] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// ── Prompt ────────────────────────────────────────────────────────────────────
function buildRewritePrompt(text, sourceTitle, sourceUrl, postType) {
  return {
    system: [
      "You are the Timed Trading editorial copywriter.",
      "Your job: rewrite an external research note into TIMED TRADING's own concise, technical-first voice for our user-facing Catalysts tab.",
      "",
      "ABSOLUTE CONSTRAINTS:",
      "• Output ONLY valid JSON in the schema at the end of the user message — no prose outside.",
      "• PARAPHRASE — never quote more than 5 consecutive words from the source. We do not republish copyrighted research verbatim.",
      "• Voice: concise (3-5 sentences MAX in tt_summary_body), present tense, technical, action-oriented. Lead with the price level or trigger. End with the implication.",
      "• Preserve PRECISE PRICE LEVELS, technical setups (TD Buy Setup, golden gate, support/resistance), and time horizons exactly as cited in the source.",
      "• No second-person ('you'). Use 'this account', 'the desk', or rephrase to third-person.",
      "• Mention tickers using bare uppercase symbols (NVDA, GOOGL) — NOT cashtags ($NVDA) or company names.",
      "• If the source is purely narrative with no actionable level/direction, return tt_key_points = [].",
    ].join("\n"),
    user: [
      `Source post type: ${postType}`,
      `Source title: ${sourceTitle || "(untitled)"}`,
      `Source URL: ${sourceUrl || "(none)"}`,
      "",
      "Source body:",
      "```",
      text.slice(0, MAX_INPUT_CHARS),
      "```",
      "",
      "Return JSON EXACTLY in this shape:",
      "{",
      '  "tt_summary_title": "<50-100 chars headline in TT voice — lead with the ticker + action>",',
      '  "tt_summary_body": "<3-5 sentences. Paraphrased, concise, technical.>",',
      '  "tt_key_points": [',
      "    {",
      '      "ticker": "<uppercase symbol, e.g. NVDA — null if signal is index/macro-only>",',
      '      "kind": "support" | "resistance" | "target" | "stop" | "setup" | "trigger" | "thesis" | "macro",',
      '      "level": "<single price or range as a string, e.g. ' + "\"341-350\"" + ' or ' + "\"99\"" + ' — null if not numeric>",',
      '      "direction": "long" | "short" | "neutral" | null,',
      '      "horizon": "intraday" | "tactical" | "intermediate" | "structural" | null,',
      '      "note": "<≤30 word context for this point>"',
      "    }",
      "  ],",
      '  "tt_cta": "<one sentence: what the desk should DO. e.g. ' + "\"Watch GOOGL for reclaim of 350 over the next week; below 341 invalidates.\"" + '>"',
      "}",
    ].join("\n"),
  };
}

// ── LLM call ──────────────────────────────────────────────────────────────────
async function callOpenAI(env, messages, { model = DEFAULT_MODEL, maxTokens = MAX_COMPLETION_TOKENS } = {}) {
  const key = env?.OPENAI_API_KEY;
  if (!key) return { ok: false, error_kind: "no_openai_key" };
  const isGpt5 = String(model).toLowerCase().startsWith("gpt-5");
  const body = {
    model,
    messages,
    max_completion_tokens: maxTokens,
    response_format: { type: "json_object" },
  };
  if (!isGpt5) body.temperature = 0.2;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REWRITE_TIMEOUT_MS);
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, error_kind: `openai_${resp.status}`, hint: errText.slice(0, 200) };
    }
    const json = await resp.json();
    const content = json.choices?.[0]?.message?.content || "";
    const usage = json.usage || {};
    return { ok: true, content, model, prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens };
  } catch (e) {
    return { ok: false, error_kind: e?.name === "AbortError" ? "openai_timeout" : "openai_exception", hint: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(t);
  }
}

// ── Public: rewrite one publication ──────────────────────────────────────────
/**
 * Rewrite a single publication into TT voice. Idempotent unless force=true.
 * Returns { ok, ...rewriteFields } or { ok:false, error_kind, hint }.
 */
export async function rewriteFSDPublication(env, pubId, { force = false, model = null } = {}) {
  await ensureRewriteSchema(env);
  if (!force) {
    try {
      const existing = await env.DB.prepare(`
        SELECT pub_id, tt_summary_title, tt_summary_body, tt_key_points_json,
               tt_cta, attribution, model_used, rewritten_at
          FROM ${REWRITES_TABLE} WHERE pub_id = ?
      `).bind(pubId).first();
      if (existing && existing.tt_summary_body) {
        return {
          ok: true,
          skipped: "already_rewritten",
          ...existing,
          tt_key_points: existing.tt_key_points_json ? safeJson(existing.tt_key_points_json) : [],
        };
      }
    } catch (_) {}
  }

  // Load source text + pub metadata.
  const text = await loadPublicationText(env, pubId);
  if (!text || !text.text_full) {
    return { ok: false, error_kind: "publication_text_missing", hint: `no cro_publication_text row for ${pubId}` };
  }
  const meta = await env.DB.prepare(
    `SELECT title, source_url, source FROM cro_publications WHERE pub_id = ?`,
  ).bind(pubId).first().catch(() => null);

  // Detect post type from pub_id (`fsi-alert`, `fsi-alert-crypto`, etc.)
  // for prompt context; default to "post" otherwise.
  let postType = "post";
  if (/^\d+$/.test(pubId)) postType = "post";
  if (meta?.source_url?.includes("flash") || meta?.source_url?.includes("alert")) postType = "fsi-alert";

  const { system, user } = buildRewritePrompt(
    text.text_full,
    meta?.title || "",
    meta?.source_url || "",
    postType,
  );
  const llm = await callOpenAI(env, [
    { role: "system", content: system },
    { role: "user",   content: user },
  ], { model: model || DEFAULT_MODEL });

  if (!llm.ok) {
    // Persist an error row so the operator sees it in /timed/admin/cro/rewrites.
    try {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO ${REWRITES_TABLE}
          (pub_id, model_used, rewritten_at, error)
        VALUES (?1, ?2, ?3, ?4)
      `).bind(pubId, model || DEFAULT_MODEL, Date.now(), `${llm.error_kind}: ${llm.hint || ""}`.slice(0, 500)).run();
    } catch (_) {}
    return { ok: false, error_kind: llm.error_kind, hint: llm.hint };
  }

  let parsed = null;
  try { parsed = JSON.parse(llm.content); } catch (e) {
    return { ok: false, error_kind: "rewrite_parse_failed", hint: String(e?.message || e).slice(0, 200), raw_preview: llm.content.slice(0, 300) };
  }

  const attribution = `Source: Fundstrat Direct — ${meta?.title ? `"${meta.title.slice(0, 100)}"` : "research"}${meta?.source_url ? ` (read original)` : ""}`;
  const payload = {
    tt_summary_title: String(parsed.tt_summary_title || "").slice(0, 300),
    tt_summary_body: String(parsed.tt_summary_body || "").slice(0, 2000),
    tt_key_points: Array.isArray(parsed.tt_key_points) ? parsed.tt_key_points.slice(0, 8) : [],
    tt_cta: String(parsed.tt_cta || "").slice(0, 400),
    attribution,
    model_used: llm.model,
    prompt_tokens: llm.prompt_tokens || null,
    completion_tokens: llm.completion_tokens || null,
  };

  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO ${REWRITES_TABLE}
        (pub_id, tt_summary_title, tt_summary_body, tt_key_points_json,
         tt_cta, attribution, model_used, prompt_tokens, completion_tokens,
         rewritten_at, error)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, NULL)
    `).bind(
      pubId,
      payload.tt_summary_title,
      payload.tt_summary_body,
      JSON.stringify(payload.tt_key_points),
      payload.tt_cta,
      payload.attribution,
      payload.model_used,
      payload.prompt_tokens,
      payload.completion_tokens,
      Date.now(),
    ).run();
  } catch (e) {
    console.warn("[CRO_REWRITER] persist failed:", String(e?.message || e).slice(0, 200));
  }

  return { ok: true, pub_id: pubId, ...payload };
}

// ── Bulk path used by the orchestrator to rewrite a batch ────────────────────
/**
 * Rewrite up to N publications that don't yet have a rewrite. Used by the
 * orchestrator's per-cycle hook and the admin backfill endpoint.
 */
export async function rewritePendingPublications(env, { limit = 10, model = null } = {}) {
  await ensureRewriteSchema(env);
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db" };
  try {
    const rows = await db.prepare(`
      SELECT p.pub_id, p.title, p.fetched_at
        FROM cro_publications p
        LEFT JOIN ${REWRITES_TABLE} r ON r.pub_id = p.pub_id
       WHERE p.fetch_status = 'ok'
         AND (r.pub_id IS NULL OR r.tt_summary_body IS NULL)
       ORDER BY p.fetched_at DESC LIMIT ?
    `).bind(limit).all();
    const candidates = rows?.results || [];
    const results = [];
    for (const c of candidates) {
      const r = await rewriteFSDPublication(env, c.pub_id, { model });
      results.push({ pub_id: c.pub_id, ok: !!r.ok, error_kind: r.error_kind || null });
    }
    return {
      ok: true,
      considered: candidates.length,
      rewrote_ok: results.filter((r) => r.ok && !r.skipped).length,
      errors: results.filter((r) => !r.ok).length,
      results,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// ── Read helper — load rewrites for a batch of pub ids ───────────────────────
export async function loadRewritesForPubIds(env, pubIds) {
  if (!env?.DB || !Array.isArray(pubIds) || pubIds.length === 0) return {};
  try {
    const placeholders = pubIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(`
      SELECT pub_id, tt_summary_title, tt_summary_body, tt_key_points_json,
             tt_cta, attribution, model_used, rewritten_at
        FROM ${REWRITES_TABLE} WHERE pub_id IN (${placeholders})
    `).bind(...pubIds).all();
    const out = {};
    for (const r of (rows?.results || [])) {
      if (!r.tt_summary_body) continue; // skip error rows
      out[r.pub_id] = {
        tt_summary_title: r.tt_summary_title,
        tt_summary_body: r.tt_summary_body,
        tt_key_points: r.tt_key_points_json ? safeJson(r.tt_key_points_json) : [],
        tt_cta: r.tt_cta,
        attribution: r.attribution,
        rewritten_at: r.rewritten_at,
      };
    }
    return out;
  } catch (_) { return {}; }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return []; }
}
