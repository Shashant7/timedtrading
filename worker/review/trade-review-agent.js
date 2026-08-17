// worker/review/trade-review-agent.js
//
// The reviewer: enqueue → run → persist.
//
// Enqueue is a single cheap D1 insert called from the trade-event write
// path; it never blocks execution and never calls an LLM. The LLM runs
// later, from the cron drain or an operator's "Review now", so a slow or
// rate-limited model can never delay a fill.

import { ensureTradeReviewSchema } from "./trade-review-schema.js";
import { buildLegContext } from "./trade-review-context.js";
import { extractLegs, reviewIdFor } from "./trade-review-legs.js";
import {
  TRADE_REVIEW_SYSTEM_PROMPT,
  TRADE_REVIEW_PROMPT_VERSION,
  buildTradeReviewUserPrompt,
} from "./trade-review-prompts.js";

const DEFAULT_MODEL = "gpt-4o-mini";
const VALID_GRADES = new Set(["A+", "A", "B", "C", "D", "F", "NA"]);
const VALID_VERDICTS = {
  ENTRY: new Set(["VALID_SETUP", "VALID_BUT_LATE", "CHASE", "LOCATION_WRONG", "STOP_INVALID", "TARGET_UNREALISTIC", "NO_EDGE", "INSUFFICIENT_DATA"]),
  TRIM: new Set(["GOOD_TRIM", "PREMATURE_TRIM", "TOO_SMALL", "TOO_LATE", "SHOULD_NOT_HAVE_TRIMMED", "INSUFFICIENT_DATA"]),
  EXIT: new Set(["GOOD_EXIT", "PREMATURE_EXIT", "LATE_EXIT", "STOPPED_BY_NOISE", "CORRECT_STOP", "SHOULD_HAVE_HELD", "INSUFFICIENT_DATA"]),
};

const flagOn = (v) => v === true || String(v ?? "").toLowerCase() === "true";

const TRADE_REVIEW_CONFIG_KEYS = [
  "trade_review_enabled",
  "trade_review_auto_run",
  "trade_review_github_enabled",
  "trade_review_model",
  "trade_review_batch",
  "trade_review_lookahead_days",
];

/**
 * env._deepAuditConfig is only populated on the scoring cron and inside
 * processTradeSimulation. Admin HTTP requests and the 22:00 cron reach the
 * reviewer with an empty config, which read as "feature off" no matter what
 * model_config said. Load just the reviewer's own keys on those paths —
 * a six-key point lookup, memoised per isolate.
 */
export async function loadTradeReviewConfig(env) {
  if (!env) return {};
  env._deepAuditConfig = env._deepAuditConfig || {};
  if (env._tradeReviewConfigLoaded) return env._deepAuditConfig;
  if (!env.DB) return env._deepAuditConfig;
  try {
    const ph = TRADE_REVIEW_CONFIG_KEYS.map((_, i) => `?${i + 1}`).join(",");
    const { results } = await env.DB.prepare(
      `SELECT config_key, config_value FROM model_config WHERE config_key IN (${ph})`,
    ).bind(...TRADE_REVIEW_CONFIG_KEYS).all();
    for (const row of results || []) {
      let v = row.config_value;
      try { v = JSON.parse(row.config_value); } catch { /* raw string */ }
      env._deepAuditConfig[row.config_key] = v;
    }
    env._tradeReviewConfigLoaded = true;
  } catch (e) {
    console.warn("[TRADE_REVIEW] config load failed:", String(e?.message || e).slice(0, 140));
  }
  return env._deepAuditConfig;
}

export function tradeReviewEnabled(env) {
  const cfg = env?._deepAuditConfig || {};
  return flagOn(cfg.trade_review_enabled ?? env?.TRADE_REVIEW_ENABLED ?? false);
}

export function tradeReviewAutoRun(env) {
  const cfg = env?._deepAuditConfig || {};
  return flagOn(cfg.trade_review_auto_run ?? env?.TRADE_REVIEW_AUTO_RUN ?? false);
}

function cfgNum(env, key, fallback) {
  const raw = env?._deepAuditConfig?.[key];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveModel(env) {
  const cfg = env?._deepAuditConfig || {};
  return String(cfg.trade_review_model || env?.TRADE_REVIEW_MODEL || DEFAULT_MODEL);
}

/**
 * Record that a leg needs reviewing. Idempotent on review_id, so a replay
 * of the same event never stacks duplicates and never clobbers a review
 * the operator has already decided on.
 */
export async function enqueueTradeReview(env, { tradeId, ticker, direction, legKind, legSeq = 0, eventId, ts, price, qtyPct } = {}) {
  if (!env?.DB || !tradeId || !legKind) return { ok: false, error: "bad_args" };
  await ensureTradeReviewSchema(env);
  const reviewId = reviewIdFor(tradeId, legKind, legSeq);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO trade_reviews
         (review_id, trade_id, ticker, direction, leg_kind, leg_seq, leg_event_id,
          leg_ts, leg_price, leg_qty_pct, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?11)
       ON CONFLICT(review_id) DO UPDATE SET
         leg_event_id = COALESCE(excluded.leg_event_id, trade_reviews.leg_event_id),
         leg_ts       = COALESCE(excluded.leg_ts, trade_reviews.leg_ts),
         leg_price    = COALESCE(excluded.leg_price, trade_reviews.leg_price),
         leg_qty_pct  = COALESCE(excluded.leg_qty_pct, trade_reviews.leg_qty_pct),
         updated_at   = excluded.updated_at`
    ).bind(
      reviewId, String(tradeId), ticker ? String(ticker).toUpperCase() : null,
      direction ? String(direction).toUpperCase() : null, String(legKind), Number(legSeq) || 0,
      eventId || null, ts != null ? Number(ts) : null, price != null ? Number(price) : null,
      qtyPct != null ? Number(qtyPct) : null, now,
    ).run();
    return { ok: true, review_id: reviewId };
  } catch (e) {
    console.warn("[TRADE_REVIEW] enqueue failed:", String(e?.message || e).slice(0, 150));
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }
}

/** Enqueue every leg of a trade that does not yet have a review row. */
export async function enqueueTradeLegs(env, tradeId) {
  if (!env?.DB || !tradeId) return { ok: false, error: "bad_args" };
  await ensureTradeReviewSchema(env);
  const { loadTrade } = await import("./trade-review-context.js");
  const trade = await loadTrade(env, tradeId);
  if (!trade) return { ok: false, error: "trade_not_found" };
  let events = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT event_id, ts, type, price, qty_pct_delta, pnl_realized, reason
         FROM trade_events WHERE trade_id = ?1 ORDER BY ts ASC`
    ).bind(String(tradeId)).all();
    events = results || [];
  } catch { /* summary-only fallback */ }

  const legs = extractLegs(trade, events);
  let queued = 0;
  for (const leg of legs) {
    const res = await enqueueTradeReview(env, {
      tradeId, ticker: trade.ticker, direction: trade.direction,
      legKind: leg.leg_kind, legSeq: leg.leg_seq, eventId: leg.event_id,
      ts: leg.ts, price: leg.price, qtyPct: leg.qty_pct,
    });
    if (res.ok) queued += 1;
  }
  return { ok: true, queued, legs: legs.length };
}

function buildOpenAIBody(model, messages, maxCompletionTokens) {
  const isGpt5Family = String(model || "").toLowerCase().startsWith("gpt-5");
  const body = {
    model,
    messages,
    max_completion_tokens: maxCompletionTokens,
    response_format: { type: "json_object" },
  };
  if (!isGpt5Family) body.temperature = 0.15;
  return body;
}

/**
 * Models reach for the full letter scale (B+, C-) even when the brief lists
 * only A+/A/B/C/D/F. Dropping those to null threw away the reviewer's whole
 * grade, so fold the modifier into the base letter instead. A+ is the one
 * modified grade the scale actually carries.
 */
function coerceGrade(raw) {
  const g = String(raw ?? "").toUpperCase().replace(/\s+/g, "");
  if (!g) return null;
  if (VALID_GRADES.has(g)) return g;
  const m = g.match(/^([ABCDF])[+-]$/);
  return m ? m[1] : null;
}

/**
 * Coerce the model's JSON into the stored shape. Anything out of contract
 * is dropped rather than persisted — a review with a hallucinated verdict
 * is worse than no review.
 */
export function normalizeReviewPayload(raw, legKind) {
  const out = {
    grade: null, verdict: null, headline: null, price_action: null,
    assessment: null, probability_of_success: null, failure_modes: [],
    capture_commentary: null, should_have_held: null, confidence: null,
    engine_findings: [],
  };
  if (!raw || typeof raw !== "object") return out;

  out.grade = coerceGrade(raw.grade);

  const verdict = String(raw.verdict || "").toUpperCase().trim();
  const allowed = VALID_VERDICTS[String(legKind || "").toUpperCase()] || null;
  out.verdict = allowed && allowed.has(verdict) ? verdict : null;

  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
  out.headline = str(raw.headline, 200);
  out.price_action = str(raw.price_action, 2000);
  out.assessment = str(raw.assessment, 2000);
  out.capture_commentary = str(raw.capture_commentary, 2000);

  const prob = Number(raw.probability_of_success);
  out.probability_of_success = Number.isFinite(prob) && prob >= 0 && prob <= 1 ? prob : null;
  const conf = Number(raw.confidence);
  out.confidence = Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : null;

  if (typeof raw.should_have_held === "boolean") out.should_have_held = raw.should_have_held;

  if (Array.isArray(raw.failure_modes)) {
    out.failure_modes = raw.failure_modes
      .filter((f) => typeof f === "string" && f.trim())
      .slice(0, 8)
      .map((f) => f.trim().slice(0, 300));
  }

  if (Array.isArray(raw.engine_findings)) {
    out.engine_findings = raw.engine_findings
      .filter((f) => f && typeof f === "object" && typeof f.finding === "string" && f.finding.trim())
      .slice(0, 5)
      .map((f) => {
        const kind = ["config", "engine", "none"].includes(String(f.kind)) ? String(f.kind) : "none";
        return {
          finding: String(f.finding).trim().slice(0, 400),
          scope: String(f.scope) === "recurring" ? "recurring" : "one_off",
          kind,
          // A config finding without a key is not actionable; demote it so
          // the apply step never writes a half-formed proposal.
          config_key: kind === "config" && typeof f.config_key === "string" && f.config_key.trim()
            ? f.config_key.trim().slice(0, 120) : null,
          proposed_value: f.proposed_value == null ? null : String(f.proposed_value).slice(0, 120),
          rationale: typeof f.rationale === "string" ? f.rationale.trim().slice(0, 600) : null,
        };
      })
      .map((f) => (f.kind === "config" && !f.config_key ? { ...f, kind: "engine" } : f));
  }
  return out;
}

async function callReviewModel(env, { system, user, model, timeoutMs = 45_000 }) {
  const apiKey = env?.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "no_api_key" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildOpenAIBody(model, [
        { role: "system", content: system },
        { role: "user", content: user },
      ], 1600)),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, error: `openai_http_${resp.status}`, detail: text.slice(0, 300), latency_ms: Date.now() - started };
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return { ok: false, error: "empty_completion", latency_ms: Date.now() - started };
    let parsed;
    try { parsed = JSON.parse(content); } catch {
      return { ok: false, error: "unparseable_json", detail: String(content).slice(0, 300), latency_ms: Date.now() - started };
    }
    return { ok: true, payload: parsed, latency_ms: Date.now() - started, usage: data?.usage || null };
  } catch (e) {
    const aborted = e?.name === "AbortError";
    return { ok: false, error: aborted ? "timeout" : String(e?.message || e).slice(0, 200), latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the reviewer for one leg and persist the result.
 * Never throws — a failed review is stored with status 'error' so the UI
 * can show why and the operator can retry.
 */
export async function runTradeReview(env, { reviewId, tradeId, legKind, legSeq = 0, force = false, dryRun = false } = {}) {
  if (!env?.DB) return { ok: false, error: "no_db" };
  await ensureTradeReviewSchema(env);

  let row = null;
  if (reviewId) {
    row = await env.DB.prepare(`SELECT * FROM trade_reviews WHERE review_id = ?1`)
      .bind(String(reviewId)).first().catch(() => null);
  }
  const tid = row?.trade_id || tradeId;
  const kind = String(row?.leg_kind || legKind || "").toUpperCase();
  const seq = row?.leg_seq ?? (Number(legSeq) || 0);
  if (!tid || !kind) return { ok: false, error: "review_not_found" };

  // Decided reviews are immutable unless the operator explicitly re-runs.
  if (row && !force && ["approved", "modified", "rejected"].includes(String(row.status))) {
    return { ok: true, skipped: "already_decided", review_id: row.review_id };
  }

  const rid = row?.review_id || reviewIdFor(tid, kind, seq);
  const lookaheadDays = cfgNum(env, "trade_review_lookahead_days", 10);
  const built = await buildLegContext(env, { tradeId: tid, legKind: kind, legSeq: seq, lookaheadDays });
  if (!built.ok) {
    await persistError(env, rid, built.error);
    return { ok: false, error: built.error, review_id: rid };
  }

  const model = resolveModel(env);
  const user = buildTradeReviewUserPrompt(built.context);

  // Dry run: return exactly what the reviewer would see, without spending a
  // call. Used to audit the prompt and to verify the context pipeline in
  // environments that have no model key.
  if (dryRun) {
    return {
      ok: true, dry_run: true, review_id: rid, model,
      prompt_version: TRADE_REVIEW_PROMPT_VERSION,
      system_prompt: TRADE_REVIEW_SYSTEM_PROMPT,
      user_prompt: user,
      capture: built.capture,
      context: built.context,
    };
  }

  const llm = await callReviewModel(env, { system: TRADE_REVIEW_SYSTEM_PROMPT, user, model });
  if (!llm.ok) {
    await persistError(env, rid, llm.error, llm.latency_ms);
    return { ok: false, error: llm.error, detail: llm.detail || null, review_id: rid };
  }

  const analysis = normalizeReviewPayload(llm.payload, kind);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO trade_reviews
         (review_id, trade_id, ticker, direction, leg_kind, leg_seq, leg_ts, leg_price, leg_qty_pct,
          status, grade, verdict, success_prob, headline, capture_json, context_json, analysis_json,
          model, prompt_version, latency_ms, error, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'reviewed', ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, NULL, ?20, ?20)
       ON CONFLICT(review_id) DO UPDATE SET
         status = 'reviewed', grade = excluded.grade, verdict = excluded.verdict,
         success_prob = excluded.success_prob, headline = excluded.headline,
         capture_json = excluded.capture_json, context_json = excluded.context_json,
         analysis_json = excluded.analysis_json, model = excluded.model,
         prompt_version = excluded.prompt_version, latency_ms = excluded.latency_ms,
         error = NULL, updated_at = excluded.updated_at`
    ).bind(
      rid, String(tid), built.context.trade.ticker || null, built.context.trade.direction || null,
      kind, seq, built.context.leg.ts ?? null, built.context.leg.price ?? null, built.context.leg.qty_pct ?? null,
      analysis.grade, analysis.verdict, analysis.probability_of_success, analysis.headline,
      JSON.stringify(built.capture || {}), JSON.stringify(built.context || {}), JSON.stringify(analysis),
      model, TRADE_REVIEW_PROMPT_VERSION, llm.latency_ms ?? null, now,
    ).run();
  } catch (e) {
    console.warn("[TRADE_REVIEW] persist failed:", String(e?.message || e).slice(0, 160));
    return { ok: false, error: "persist_failed", review_id: rid };
  }

  return { ok: true, review_id: rid, grade: analysis.grade, verdict: analysis.verdict, analysis, latency_ms: llm.latency_ms };
}

async function persistError(env, reviewId, error, latencyMs = null) {
  const now = Date.now();
  try {
    await env.DB.prepare(
      `UPDATE trade_reviews SET status = 'error', error = ?2, latency_ms = ?3, updated_at = ?4
        WHERE review_id = ?1`
    ).bind(String(reviewId), String(error || "unknown").slice(0, 200), latencyMs, now).run();
  } catch { /* best effort */ }
}

/**
 * Drain pending reviews. Bounded per tick so one cron never burns the
 * whole LLM budget or the worker's CPU allowance.
 */
export async function drainTradeReviewQueue(env, { limit } = {}) {
  if (!env?.DB) return { ok: false, error: "no_db" };
  await ensureTradeReviewSchema(env);
  const batch = Math.max(1, Math.min(25, limit || cfgNum(env, "trade_review_batch", 6)));
  let pending = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT review_id, trade_id, leg_kind, leg_seq FROM trade_reviews
        WHERE status = 'pending' ORDER BY leg_ts ASC LIMIT ?1`
    ).bind(batch).all();
    pending = results || [];
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 150) };
  }

  const done = [];
  for (const r of pending) {
    const res = await runTradeReview(env, {
      reviewId: r.review_id, tradeId: r.trade_id, legKind: r.leg_kind, legSeq: r.leg_seq,
    });
    done.push({ review_id: r.review_id, ok: res.ok, grade: res.grade || null, error: res.error || null });
    // Stop early on auth/quota failures — retrying the rest just burns time.
    if (!res.ok && ["no_api_key", "openai_http_401", "openai_http_429"].includes(String(res.error))) break;
  }
  return { ok: true, processed: done.length, pending_seen: pending.length, results: done };
}
