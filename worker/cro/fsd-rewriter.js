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
const PUBLICATION_TICKERS_TABLE = "cro_publication_tickers";

// ── Model-context loader for BLENDED rewrites ────────────────────────────────
// Operator: "Don't we already have so much data from the Technicals Tab and
// HTF scoring info? Is there any reusability?" — yes. The right rail's
// Technicals tab + Snapshot tab consume the per-ticker payload that the
// scoring path bakes into `timed:all:snapshot.data[SYM]`. We read the same
// blob, no new KV layout, no parallel fetch.
async function loadTickersForPub(env, pubId) {
  try {
    const rows = await env.DB.prepare(
      `SELECT ticker FROM ${PUBLICATION_TICKERS_TABLE} WHERE pub_id = ? ORDER BY position ASC LIMIT 6`,
    ).bind(pubId).all();
    return (rows?.results || []).map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean);
  } catch (_) { return []; }
}

let _snapCache = { ts: 0, blob: null };
async function loadAllSnapshot(env) {
  // 60s in-process cache so a multi-ticker rewrite batch doesn't re-fetch
  // the (large) snapshot blob per call.
  const now = Date.now();
  if (_snapCache.blob && (now - _snapCache.ts) < 60000) return _snapCache.blob;
  try {
    const raw = await env?.KV?.get("timed:all:snapshot");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    _snapCache = { ts: now, blob: parsed };
    return parsed;
  } catch (_) { return null; }
}

function summarizeTickerForPrompt(sym, t) {
  // Pull the same fields the Technicals tab + HTF scoring tile + Snapshot
  // hero card render — keep the prompt-context dense but compact.
  if (!t) return null;
  const parts = [`${sym}:`];
  const _num = (v, fix = 2) => Number.isFinite(Number(v)) ? Number(v).toFixed(fix) : null;
  if (_num(t.price ?? t._live_price)) parts.push(`px=$${_num(t.price ?? t._live_price)}`);
  if (_num(t.day_change_pct ?? t.dailyChgPct)) parts.push(`day=${_num(t.day_change_pct ?? t.dailyChgPct)}%`);
  if (t.regime_class) parts.push(`regime=${String(t.regime_class).replace(/_/g, " ")}`);
  if (t.kanban_stage) parts.push(`stage=${String(t.kanban_stage)}`);
  if (t.state) parts.push(`htf=${String(t.state).replace(/_/g, " ")}`);
  if (_num(t.score, 0)) parts.push(`score=${_num(t.score, 0)}`);
  if (_num(t.conviction, 0)) parts.push(`conv=${_num(t.conviction, 0)}`);
  if (_num(t.rank_position, 0)) parts.push(`R${_num(t.rank_position, 0)}`);
  if (_num(t.rr)) parts.push(`rr=${_num(t.rr)}`);
  if (_num(t.trigger_price)) parts.push(`trigger=${_num(t.trigger_price)}`);
  if (_num(t.sl)) parts.push(`stop=${_num(t.sl)}`);
  if (_num(t.tp)) parts.push(`tp=${_num(t.tp)}`);
  if (t._ticker_profile?.behavior_type) parts.push(`profile=${t._ticker_profile.behavior_type}`);
  if (t.latent_regime?.state) parts.push(`hmm=${String(t.latent_regime.state).replace(/_/g, " ")}`);
  if (Array.isArray(t.flags) && t.flags.length > 0) parts.push(`flags=${t.flags.slice(0, 3).join(",")}`);
  return parts.join(" ");
}

async function loadModelContextForTickers(env, tickers) {
  if (!Array.isArray(tickers) || tickers.length === 0) return "(no tickers extracted from publication)";
  const snap = await loadAllSnapshot(env);
  const lines = [];
  for (const sym of tickers.slice(0, 4)) {
    const t = snap?.data?.[sym] || null;
    const summary = summarizeTickerForPrompt(sym, t);
    if (summary) lines.push(summary);
    else lines.push(`${sym}: (no model snapshot — ticker not in active universe yet)`);
  }
  return lines.join("\n");
}
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
function buildRewritePrompt(text, sourceTitle, sourceUrl, postType, modelContext) {
  return {
    system: [
      "You are the Timed Trading editorial copywriter.",
      "Your job: produce a BLENDED take that fuses an external research note (from a trusted desk) with TIMED TRADING's own real-time model state for the mentioned tickers. Output is for our user-facing Catalysts tab — users come here to see how our model reads someone else's call against our own data.",
      "",
      "BLEND INSTRUCTIONS:",
      "• START from the source's read. Capture the price levels, direction, time horizon, and reasoning it gives.",
      "• OVERLAY the TT MODEL CONTEXT below — current price, regime, HTF state, score/conviction, kanban stage, and our own trigger/stop/TP levels (if any).",
      "• When the model AGREES with the source, say so explicitly and reinforce: 'The setup aligns with our regime read and the entry-trigger at <price>'.",
      "• When the model DISAGREES (e.g. source long but our regime BEAR_TREND, or source level below our stop), surface the conflict honestly: 'Source sees support at X; our model has us watching <our trigger> instead — the two disagree by Y%.'",
      "• When the model has NO read (ticker not in active universe), say 'Not in our active universe; presenting the source view as-is.'",
      "• The result must be MORE VALUABLE than either input alone. Users pay for the synthesis, not the relay.",
      "",
      "ABSOLUTE CONSTRAINTS:",
      "• Output ONLY valid JSON in the schema at the end of the user message — no prose outside.",
      "• PARAPHRASE the source — never quote more than 5 consecutive words. We do not republish copyrighted research verbatim.",
      "• Voice: concise (3-5 sentences MAX in tt_summary_body), present tense, technical, action-oriented. Lead with the price level or trigger. End with the implication for the desk.",
      "• Preserve PRECISE PRICE LEVELS, technical setups (TD Buy Setup, golden gate, support/resistance), and time horizons exactly as cited.",
      "• No second-person (\'you\'). Use \'this account\', \'the desk\', or third-person.",
      "• Mention tickers as bare uppercase symbols (NVDA, GOOGL) — NOT cashtags or company names.",
      "• Do NOT mention \'Fundstrat\' or the source brand in the title/body/cta — attribution renders separately. The title should sound like TT wrote it.",
      "• If neither the source nor the model produces an actionable level/direction, return tt_key_points = [].",
    ].join("\n"),
    user: [
      `Source post type: ${postType}`,
      `Source title: ${sourceTitle || "(untitled)"}`,
      `Source URL: ${sourceUrl || "(none)"}`,
      "",
      "── TT MODEL CONTEXT (your own data for the tickers mentioned) ──",
      modelContext || "(no model context)",
      "",
      "── SOURCE BODY (paraphrase, do not quote verbatim) ──",
      "```",
      String(text).slice(0, MAX_INPUT_CHARS),
      "```",
      "",
      "Return JSON EXACTLY in this shape:",
      "{",
      '  "tt_summary_title": "<50-100 chars TT-voice headline — lead with the ticker + action. Do not say Fundstrat or any source name.>",',
      '  "tt_summary_body": "<3-5 sentences. Blend source read + TT model context. State agreement or conflict explicitly when relevant.>",',
      '  "tt_key_points": [',
      "    {",
      '      "ticker": "<uppercase symbol, e.g. NVDA — null if signal is index/macro-only>",',
      '      "kind": "support" | "resistance" | "target" | "stop" | "setup" | "trigger" | "thesis" | "macro",',
      '      "level": "<single price or range as a string, e.g. ' + "\"341-350\"" + ' or ' + "\"99\"" + ' — null if not numeric>",',
      '      "direction": "long" | "short" | "neutral" | null,',
      '      "horizon": "intraday" | "tactical" | "intermediate" | "structural" | null,',
      '      "note": "<≤30 word context — call out whether TT model agrees or disagrees>"',
      "    }",
      "  ],",
      '  "tt_cta": "<one sentence: what the desk should DO, weighing source view against TT model. e.g. ' + "\"Watch GOOGL for reclaim of 350 — our regime read still defensive, so wait for confirmation.\"" + '>"',
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

  // 2026-06-03 — Build the BLENDED model-context block from the same
  // per-ticker snapshot the Technicals tab + HTF scoring tile consume
  // (no parallel KV layout, no duplicate fetches). Reads
  // `timed:all:snapshot.data[SYM]` for each tagged ticker on the pub.
  const taggedTickers = await loadTickersForPub(env, pubId);
  const modelContext = await loadModelContextForTickers(env, taggedTickers);
  const { system, user } = buildRewritePrompt(
    text.text_full,
    meta?.title || "",
    meta?.source_url || "",
    postType,
    modelContext,
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
