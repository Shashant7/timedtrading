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
import {
  MEMORY_THEME_TICKERS,
  buildSpxIndexContextBlock,
  loadCTOLineForTicker,
  memoryThemeHeaderLine,
  publicationMentionsMemoryStocks,
  publicationMentionsSpx,
  tickersIncludeMemoryTheme,
} from "./fsd-model-context.js";
import {
  buildFreshTickerContext,
  filterKeyPointsLevels,
  resolveTimedKv,
  rewriteMetaNeedsRefresh,
  stripUncitedModelLevels,
  REWRITE_PX_DRIFT_PCT,
} from "./fsd-rewrite-context.js";

const REWRITES_TABLE = "cro_publication_rewrites";
const PUBLICATION_TICKERS_TABLE = "cro_publication_tickers";

// ── Model-context loader for BLENDED rewrites ────────────────────────────────
// Prefer the freshest of snapshot / ticker_latest / timed:latest, overlay
// live timed:prices, and omit divergent plan levels before the LLM can cite them.
async function loadTickersForPub(env, pubId) {
  try {
    const rows = await env.DB.prepare(
      `SELECT ticker FROM ${PUBLICATION_TICKERS_TABLE} WHERE pub_id = ? ORDER BY position ASC LIMIT 6`,
    ).bind(pubId).all();
    return (rows?.results || []).map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean);
  } catch (_) { return []; }
}

let _snapCache = { ts: 0, blob: null };
let _pricesCache = { ts: 0, blob: null };

async function loadAllSnapshot(env) {
  const now = Date.now();
  if (_snapCache.blob && (now - _snapCache.ts) < 60000) return _snapCache.blob;
  try {
    const kv = resolveTimedKv(env);
    const raw = await kv?.get("timed:all:snapshot");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    _snapCache = { ts: now, blob: parsed };
    return parsed;
  } catch (_) { return null; }
}

async function loadTimedPricesMap(env) {
  const now = Date.now();
  if (_pricesCache.blob && (now - _pricesCache.ts) < 15000) return _pricesCache.blob;
  try {
    const kv = resolveTimedKv(env);
    const raw = await kv?.get("timed:prices");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    _pricesCache = { ts: now, blob: parsed };
    return parsed;
  } catch (_) { return null; }
}

async function loadTickerLatestRow(env, sym) {
  try {
    if (!env?.DB) return null;
    const row = await env.DB.prepare(
      `SELECT payload_json, updated_at FROM ticker_latest WHERE ticker = ?1`,
    ).bind(sym).first();
    if (!row?.payload_json) return null;
    return {
      payload: JSON.parse(String(row.payload_json)),
      ts: row.updated_at,
    };
  } catch (_) { return null; }
}

async function loadTimedLatestPayload(env, sym) {
  try {
    const kv = resolveTimedKv(env);
    const raw = await kv?.get(`timed:latest:${sym}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

/**
 * @returns {{ line: string|null, meta: object|null }}
 */
async function loadTickerModelContext(env, sym, snap, pricesMap) {
  const S = String(sym || "").toUpperCase();
  if (!S) return { line: null, meta: null };

  const latestRow = await loadTickerLatestRow(env, S);
  const timedLatest = await loadTimedLatestPayload(env, S);
  const priceRow = pricesMap?.[S] || pricesMap?.prices?.[S] || null;

  const built = buildFreshTickerContext(S, {
    snapshotPayload: snap?.data?.[S] || null,
    snapshotTs: snap?.ts || snap?.generated_at || snap?.updated_at || null,
    latestPayload: latestRow?.payload || null,
    latestTs: latestRow?.ts || null,
    timedLatestPayload: timedLatest,
    timedLatestTs: timedLatest?.ingest_ts || timedLatest?.ts || null,
    priceRow,
  });

  const ctoLine = await loadCTOLineForTicker(env, S);
  let line = built.summary;
  if (line && ctoLine) line = `${line}\n  ${ctoLine}`;
  else if (ctoLine) line = ctoLine;
  return { line, meta: built.meta };
}

async function loadModelContextForTickers(env, tickers, { focusTicker = null, sourceText = null } = {}) {
  const ordered = [];
  const seen = new Set();
  const focus = String(focusTicker || "").toUpperCase();
  if (focus) { ordered.push(focus); seen.add(focus); }
  for (const t of (tickers || [])) {
    const S = String(t || "").toUpperCase();
    if (!S || seen.has(S)) continue;
    seen.add(S);
    ordered.push(S);
  }

  const srcBlob = String(sourceText || "");
  const wantsMemory = tickersIncludeMemoryTheme(ordered) || publicationMentionsMemoryStocks(srcBlob);
  if (wantsMemory) {
    for (const m of MEMORY_THEME_TICKERS) {
      if (!seen.has(m)) {
        seen.add(m);
        ordered.push(m);
      }
    }
  }

  const mentionsSpx = publicationMentionsSpx(srcBlob)
    || ordered.some((s) => ["SPX", "SPX500", "US500"].includes(s));
  if (mentionsSpx && !seen.has("SPY")) {
    seen.add("SPY");
    ordered.unshift("SPY");
  }

  if (ordered.length === 0 && !mentionsSpx) {
    return { text: "(no tickers extracted from publication)", metaByTicker: {} };
  }

  const snap = await loadAllSnapshot(env);
  const pricesMap = await loadTimedPricesMap(env);
  const lines = [];
  const metaByTicker = {};

  if (wantsMemory) lines.push(memoryThemeHeaderLine());

  if (mentionsSpx) {
    const spyCtx = await loadTickerModelContext(env, "SPY", snap, pricesMap);
    if (spyCtx.meta) metaByTicker.SPY = spyCtx.meta;
    const spyCto = await loadCTOLineForTicker(env, "SPY");
    lines.push(await buildSpxIndexContextBlock(env, {
      spyScoringLine: spyCtx.line,
      spyCtoLine: spyCto,
    }));
  }

  for (const sym of ordered.slice(0, 6)) {
    if (mentionsSpx && sym === "SPY" && lines.some((l) => l.includes("SPY (tradeable proxy)"))) continue;
    const ctx = await loadTickerModelContext(env, sym, snap, pricesMap);
    if (ctx.meta) metaByTicker[sym] = ctx.meta;
    if (ctx.line) lines.push(ctx.line);
    else lines.push(`${sym}: (limited model data — treat source levels as primary until desk snapshot refreshes)`);
  }
  return { text: lines.join("\n"), metaByTicker };
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
        error               TEXT,
        model_context_meta_json TEXT
      )
    `).run();
  } catch (e) {
    console.warn("[CRO_REWRITER] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
  // Existing DBs created before 2026-07-23 lack the meta column.
  try {
    await db.prepare(
      `ALTER TABLE ${REWRITES_TABLE} ADD COLUMN model_context_meta_json TEXT`,
    ).run();
  } catch (_) { /* already present */ }
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
      "• OVERLAY the TT MODEL CONTEXT below — current LIVE price, regime, HTF state, score/conviction, kanban stage, and our own trigger/stop/TP levels ONLY when the context line includes them.",
      "• When the model AGREES with the source and the context includes a trigger/stop/TP, say so explicitly and reinforce with those numbers.",
      "• When the model DISAGREES (e.g. source long but our regime BEAR_TREND), surface the conflict honestly using levels from the TT MODEL CONTEXT only.",
      "• When TT MODEL CONTEXT includes price/regime/score for a ticker, that ticker IS on the desk — blend source + model. Never claim a ticker is 'not in our active universe' when context lines exist for it.",
      "• If a ticker line says 'model levels omitted — stale vs live price', cite regime/stage/live price ONLY. Do NOT invent, recycle, or guess trigger/stop/TP for that ticker.",
      "• Never cite TT model stop/target/entry numbers that are not present in the TT MODEL CONTEXT block for that ticker.",
      "• Only when context explicitly says 'limited model data' for a ticker, present the source view and note the desk snapshot is still syncing.",
      "• MEMORY STOCKS (MU, WDC, STX, SNDK, HIMX): the desk tracks these under ai_infra_memory with scoring + CTO magnets. When CTO or price lines exist, cite them as actionable levels. Never write that the model lacks memory-stock levels.",
      "• SPX / US500 (cash index): TT has no SPX feed — desk tracks SPY (+ ES). When the SPX/SPY block shows a live ratio, convert source ^SPX levels to SPY in tt_key_points (SPY ≈ SPX ÷ ratio). Never use fixed 10:1 math; ratio drifts with dividends/expense. Blend against SPY model context.",
      "• The result must be MORE VALUABLE than either input alone. Users pay for the synthesis, not the relay.",
      "",
      "ABSOLUTE CONSTRAINTS:",
      "• Output ONLY valid JSON in the schema at the end of the user message — no prose outside.",
      "• PARAPHRASE the source — never quote more than 5 consecutive words. We do not republish copyrighted research verbatim.",
      "• Voice: concise (3-5 sentences MAX in tt_summary_body), present tense, technical, action-oriented. Lead with the price level or trigger. End with the implication for the desk.",
      "• Preserve PRECISE PRICE LEVELS from the SOURCE when citing the source's call. TT model levels must come only from TT MODEL CONTEXT.",
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
      "── TT MODEL CONTEXT (live-overlaid desk data — cite stop/tp/trigger ONLY if present) ──",
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
export async function rewriteFSDPublication(env, pubId, { force = false, model = null, focusTicker = null } = {}) {
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

  // 2026-07-23 — Freshest of snapshot/ticker_latest/timed:latest + live
  // timed:prices overlay; divergent plan levels omitted from the prompt.
  const taggedTickers = await loadTickersForPub(env, pubId);
  const modelCtx = await loadModelContextForTickers(env, taggedTickers, {
    focusTicker,
    sourceText: text.text_full,
  });
  const modelContext = modelCtx?.text || "";
  const modelContextMeta = {
    built_at: Date.now(),
    tickers: modelCtx?.metaByTicker || {},
  };
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
  const { sanitizeFsdCopy, sanitizeFsdTitle } = await import("./fsd-sanitize.js");
  const metaTickers = modelContextMeta?.tickers || {};
  const sourceBody = String(text.text_full || "");
  // Post-process: LLM sometimes leaves author bylines / source brand in the
  // headline even with the prompt instruction. Strip them defensively.
  // Also strip TT stop/target/trigger dollars the model invented outside
  // the fresh context (2026-07-23 TSLA $373 hallucination).
  const payload = {
    tt_summary_title: sanitizeFsdTitle(String(parsed.tt_summary_title || "").slice(0, 300), "Market Intel update"),
    tt_summary_body: stripUncitedModelLevels(
      sanitizeFsdCopy(String(parsed.tt_summary_body || "").slice(0, 2000)),
      metaTickers,
      sourceBody,
    ),
    tt_key_points: filterKeyPointsLevels(
      Array.isArray(parsed.tt_key_points) ? parsed.tt_key_points.slice(0, 8) : [],
      metaTickers,
      sourceBody,
    ),
    tt_cta: stripUncitedModelLevels(
      sanitizeFsdCopy(String(parsed.tt_cta || "").slice(0, 400)),
      metaTickers,
      sourceBody,
    ),
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
         rewritten_at, error, model_context_meta_json)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10, NULL, ?11)
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
      JSON.stringify(modelContextMeta),
    ).run();
  } catch (e) {
    // Fallback without meta column if ALTER hasn't landed yet.
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
    } catch (e2) {
      console.warn("[CRO_REWRITER] persist failed:", String(e2?.message || e2).slice(0, 200));
    }
  }

  return { ok: true, pub_id: pubId, ...payload, model_context_meta: modelContextMeta };
}

/**
 * Force-rewrite recent notes whose rewrite-time model px drifted vs live.
 * Prevents frozen stale stop/tp prose after gaps / big moves.
 */
export async function refreshStaleRewrites(env, {
  limit = 5,
  lookbackMs = 7 * 24 * 3600 * 1000,
  driftPct = REWRITE_PX_DRIFT_PCT,
  model = null,
} = {}) {
  await ensureRewriteSchema(env);
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db", refreshed: [] };
  const since = Date.now() - lookbackMs;
  let rows = [];
  try {
    const q = await db.prepare(`
      SELECT pub_id, model_context_meta_json, rewritten_at
        FROM ${REWRITES_TABLE}
       WHERE tt_summary_body IS NOT NULL
         AND rewritten_at >= ?
         AND model_context_meta_json IS NOT NULL
       ORDER BY rewritten_at DESC
       LIMIT 80
    `).bind(since).all();
    rows = q?.results || [];
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200), refreshed: [] };
  }

  const pricesMap = await loadTimedPricesMap(env);
  const staleIds = [];
  for (const r of rows) {
    let meta = null;
    try { meta = JSON.parse(String(r.model_context_meta_json || "")); } catch (_) { continue; }
    const tickers = meta?.tickers || {};
    let needs = false;
    for (const [sym, tMeta] of Object.entries(tickers)) {
      const row = pricesMap?.[sym] || pricesMap?.prices?.[sym];
      const livePx = Number(row?.p ?? row?.price);
      if (rewriteMetaNeedsRefresh(tMeta, livePx, { driftPct })) {
        needs = true;
        break;
      }
    }
    if (needs) staleIds.push(r.pub_id);
    if (staleIds.length >= limit) break;
  }

  const refreshed = [];
  for (const pubId of staleIds) {
    const out = await rewriteFSDPublication(env, pubId, { force: true, model });
    refreshed.push({
      pub_id: pubId,
      ok: !!out.ok,
      error_kind: out.error_kind || null,
      reason: "px_drift",
    });
  }
  return { ok: true, considered: rows.length, stale: staleIds.length, refreshed };
}

// ── Bulk path used by the orchestrator to rewrite a batch ────────────────────
/**
 * Rewrite up to N publications that don't yet have a rewrite. Used by the
 * orchestrator's per-cycle hook and the admin backfill endpoint.
 * Also force-refreshes a small set of recent rewrites whose live px drifted.
 */
export async function rewritePendingPublications(env, { limit = 10, model = null, refreshStale = true } = {}) {
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
    let staleRefresh = { ok: true, refreshed: [] };
    if (refreshStale) {
      // Cap refresh budget so a gap day cannot burn the whole LLM quota.
      const refreshLimit = Math.min(5, Math.max(1, Math.floor(limit / 2)));
      staleRefresh = await refreshStaleRewrites(env, { limit: refreshLimit, model });
    }
    return {
      ok: true,
      considered: candidates.length,
      rewrote_ok: results.filter((r) => r.ok && !r.skipped).length,
      errors: results.filter((r) => !r.ok).length,
      results,
      stale_refresh: staleRefresh,
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
