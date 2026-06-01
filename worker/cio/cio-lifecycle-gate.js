// worker/cio/cio-lifecycle-gate.js
// CIO LIFECYCLE GATE — universal wrapper around evaluateCIOLifecycle() that
// enforces the three "going all in" guardrails the operator requires before
// CIO is allowed to vote on every lifecycle decision:
//
//   1. LATENCY CAP — per-call AbortController with a tighter timeout than the
//      raw CIO call (default 1500 ms, configurable). On timeout we return the
//      engine-default decision and tick a `_timeout` counter so the operator
//      can audit the floor's strictness.
//   2. MONTHLY $ CAP — running KV counter `ai_cio:spend:YYYY-MM` (USD * 1000).
//      Hard-stop when `AI_CIO_MONTHLY_USD_CAP` is reached; downstream returns
//      `{ decision: <engine_default>, fallback: true, reason: "cost_cap" }`.
//      Estimated cost is added on each call (we use a conservative flat
//      $0.001 per call for gpt-4o-mini and $0.004 for gpt-5.x family — see
//      ESTIMATED_COST_USD below).
//   3. DIFFERENTIAL OVERRIDE LOGGING — every call that returns a decision
//      different from the engine default is logged with a stable `[AI_CIO_GATE]`
//      prefix + decision-type + bucket + sym + reasoning excerpt, AND a
//      per-decision-type rolling counter is bumped in KV so the Mission
//      Control endpoint `/timed/admin/ai-cio/lifecycle-stats` can show
//      override-rates by decision type without scanning logs.
//
// Decision-type matrix (each independently togglable via model_config or env
// var; all default ON when the master switch `ai_cio_lifecycle_all_in_enabled`
// is true, otherwise default OFF):
//
//   entry_skip_review        — engine wanted to skip an entry (Loop 2 trip,
//                              rank floor, etc.); CIO gets to override.
//   rebalance_trim           — Investor auto-rebalance is about to trim a
//                              "reduce" or event-risk position; CIO can HOLD.
//   sl_move                  — SL is about to move by >= 1.5% of the entry-to-
//                              current-SL distance; CIO can defer to next bar.
//                              Defaults to RECORD-ONLY mode (logs opinion but
//                              SL still moves) until we have audit data.
//   defend_record            — DEFEND lane is about to fire; CIO opinion is
//                              recorded alongside doctrine. Doctrine still
//                              wins on disagreement (per PR #285); the
//                              record-only mode builds the audit dataset.
//
// All hooks are SAFE BY DEFAULT: if env.OPENAI_API_KEY is missing, if any
// part of the gate throws, if the timeout fires, OR if the monthly cap is
// hit, the gate returns the engine-default decision. The trade-management
// path NEVER stalls waiting on CIO.

import { buildCIOLifecycleProposal, evaluateCIOLifecycle } from "./cio-service.js";

// ── Tunables ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MONTHLY_USD_CAP = 50; // operator override via env / model_config
const DEDUP_TTL_MS = 60 * 1000; // 60s — collapse multiple ticks on the same (sym, type) decision into one CIO call
const DEDUP_CACHE_MAX = 200;

// Per-call cost estimates (conservative). Refined when operators observe
// actual OpenAI billing line items vs. the per-call counter we report. The
// gate is monthly-capped so an under-estimate just means we burn the cap a
// tick earlier, not silent overruns.
function estimatedCostUsd(model) {
  const m = String(model || "").toLowerCase();
  if (m.startsWith("gpt-5")) return 0.004;
  if (m.startsWith("gpt-4o")) return m.includes("mini") ? 0.001 : 0.003;
  if (m.startsWith("o1")) return 0.012;
  return 0.001;
}

// Engine-default decision per type. Returned when CIO is disabled, off, in
// fallback, or over the cost cap. These match what the engine would have
// done without any CIO consult, so the gate is a pure additive layer.
const ENGINE_DEFAULT = {
  entry_skip_review: { decision: "SKIP", reason: "engine_default_skip" },
  rebalance_trim: { decision: "PROCEED", reason: "engine_default_trim" },
  sl_move: { decision: "PROCEED", reason: "engine_default_sl_move" },
  defend_record: { decision: "RECORD_ONLY", reason: "engine_default_defend" },
};

// ── Config loader ──────────────────────────────────────────────────────────

/**
 * Resolve the active gate config from (in priority order):
 *   1. env._cioLifecycleCache (loaded once per request from model_config)
 *   2. env.* env vars
 *   3. compiled-in defaults
 *
 * Operator can flip a single toggle via:
 *   POST /timed/admin/deep-audit-config
 *   body { config: { ai_cio_rebalance_trim_enabled: "true" } }
 *
 * Master kill switch: `ai_cio_lifecycle_all_in_enabled`. When this is set
 * to "false" the gate short-circuits on every type — useful for emergency
 * rollback without redeploy.
 */
export function getLifecycleGateConfig(env) {
  const merged = { ...(env?._cioModelCache || {}), ...(env?._deepAuditConfig || {}) };
  const readBool = (cfgKey, envKey, defaultValue) => {
    const raw = merged?.[cfgKey] ?? env?.[envKey];
    if (raw == null) return defaultValue;
    const s = String(raw).toLowerCase().trim();
    if (s === "true" || s === "1" || s === "on" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "off" || s === "no") return false;
    return defaultValue;
  };
  const readNum = (cfgKey, envKey, defaultValue) => {
    const raw = merged?.[cfgKey] ?? env?.[envKey];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
  };

  const masterOn = readBool("ai_cio_lifecycle_all_in_enabled", "AI_CIO_LIFECYCLE_ALL_IN_ENABLED", true);

  return {
    masterOn,
    types: {
      entry_skip_review: masterOn && readBool("ai_cio_entry_skip_review_enabled", "AI_CIO_ENTRY_SKIP_REVIEW_ENABLED", true),
      rebalance_trim: masterOn && readBool("ai_cio_rebalance_trim_enabled", "AI_CIO_REBALANCE_TRIM_ENABLED", true),
      sl_move: masterOn && readBool("ai_cio_sl_move_enabled", "AI_CIO_SL_MOVE_ENABLED", true),
      defend_record: masterOn && readBool("ai_cio_defend_record_enabled", "AI_CIO_DEFEND_RECORD_ENABLED", true),
    },
    // Some types support "record-only" mode where CIO opinion is logged but
    // never overrides the engine. Useful while building the audit dataset.
    recordOnly: {
      // SL moves default to record-only until we have 2 weeks of data on
      // override quality. Operator can flip to authoritative via
      // model_config { ai_cio_sl_move_authoritative: "true" }.
      sl_move: !readBool("ai_cio_sl_move_authoritative", "AI_CIO_SL_MOVE_AUTHORITATIVE", false),
      // DEFEND is always record-only per PR #285 (doctrine wins).
      defend_record: true,
    },
    timeoutMs: readNum("ai_cio_lifecycle_timeout_ms", "AI_CIO_LIFECYCLE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
    monthlyUsdCap: readNum("ai_cio_monthly_usd_cap", "AI_CIO_MONTHLY_USD_CAP", DEFAULT_MONTHLY_USD_CAP),
  };
}

// ── Monthly $ cap (KV-backed) ──────────────────────────────────────────────

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const SPEND_KV_KEY_PREFIX = "ai_cio:spend:";
const STATS_KV_KEY_PREFIX = "ai_cio:stats:";

async function getMonthlySpendUsd(env) {
  try {
    if (!env?.KV_TIMED) return 0;
    const raw = await env.KV_TIMED.get(`${SPEND_KV_KEY_PREFIX}${monthKey()}`);
    return Number(raw) || 0;
  } catch {
    return 0;
  }
}

async function addMonthlySpend(env, usd) {
  try {
    if (!env?.KV_TIMED || !(usd > 0)) return;
    const k = `${SPEND_KV_KEY_PREFIX}${monthKey()}`;
    const cur = Number(await env.KV_TIMED.get(k)) || 0;
    const next = cur + usd;
    // 35 day TTL — month rolls over before this expires
    await env.KV_TIMED.put(k, String(next), { expirationTtl: 35 * 86400 });
  } catch (e) {
    console.warn("[AI_CIO_GATE] addMonthlySpend failed:", String(e?.message || e).slice(0, 120));
  }
}

// ── Per-decision-type stats (counts + overrides) ───────────────────────────

async function bumpStat(env, type, field) {
  try {
    if (!env?.KV_TIMED) return;
    const k = `${STATS_KV_KEY_PREFIX}${monthKey()}:${type}`;
    const raw = await env.KV_TIMED.get(k);
    let obj = {};
    try { obj = raw ? JSON.parse(raw) : {}; } catch { obj = {}; }
    obj[field] = (Number(obj[field]) || 0) + 1;
    obj.last_ts = Date.now();
    await env.KV_TIMED.put(k, JSON.stringify(obj), { expirationTtl: 35 * 86400 });
  } catch (e) {
    console.warn("[AI_CIO_GATE] bumpStat failed:", String(e?.message || e).slice(0, 120));
  }
}

/**
 * Read the per-type stats for the current month. Used by the
 * /timed/admin/ai-cio/lifecycle-stats endpoint.
 */
export async function getLifecycleStats(env) {
  const types = ["entry_skip_review", "rebalance_trim", "sl_move", "defend_record"];
  const out = { month: monthKey(), monthly_usd: 0, types: {} };
  if (!env?.KV_TIMED) return out;
  try {
    out.monthly_usd = await getMonthlySpendUsd(env);
    for (const t of types) {
      const raw = await env.KV_TIMED.get(`${STATS_KV_KEY_PREFIX}${monthKey()}:${t}`);
      let obj = {};
      try { obj = raw ? JSON.parse(raw) : {}; } catch { obj = {}; }
      const calls = Number(obj.calls) || 0;
      const overrides = Number(obj.overrides) || 0;
      out.types[t] = {
        calls,
        overrides,
        timeouts: Number(obj.timeouts) || 0,
        fallbacks: Number(obj.fallbacks) || 0,
        cost_cap_hits: Number(obj.cost_cap_hits) || 0,
        override_rate: calls > 0 ? Math.round((overrides / calls) * 1000) / 10 : null,
        last_ts: Number(obj.last_ts) || null,
      };
    }
  } catch (e) {
    console.warn("[AI_CIO_GATE] getLifecycleStats failed:", String(e?.message || e).slice(0, 120));
  }
  return out;
}

// ── Dedup cache (per-isolate) ──────────────────────────────────────────────
// Collapse multiple ticks against the same (sym, type, bucket) into a single
// CIO call within a short TTL. Stops the SL-move path from burning $$ when
// the scoring cron fires every 5 minutes for a position that just trailed.

function dedupGet(env, key) {
  if (!env._cioGateCache) return null;
  const ent = env._cioGateCache[key];
  if (!ent) return null;
  if (Date.now() - ent.ts > DEDUP_TTL_MS) {
    delete env._cioGateCache[key];
    return null;
  }
  return ent.result;
}

function dedupPut(env, key, result) {
  if (!env._cioGateCache) env._cioGateCache = {};
  const keys = Object.keys(env._cioGateCache);
  if (keys.length > DEDUP_CACHE_MAX) {
    // Drop the oldest 1/4 entries to bound memory.
    const sorted = keys
      .map(k => [k, env._cioGateCache[k]?.ts || 0])
      .sort((a, b) => a[1] - b[1])
      .slice(0, Math.floor(DEDUP_CACHE_MAX / 4));
    for (const [k] of sorted) delete env._cioGateCache[k];
  }
  env._cioGateCache[key] = { ts: Date.now(), result };
}

// ── Core gate ─────────────────────────────────────────────────────────────

/**
 * Run a lifecycle CIO consult with all three guardrails applied.
 *
 * @param {object} env           Worker env (needs KV_TIMED + OPENAI_API_KEY)
 * @param {object} opts
 * @param {string} opts.type     entry_skip_review | rebalance_trim | sl_move | defend_record
 * @param {string} opts.bucket   Engine action bucket — e.g. "loop2_trip" / "auto_reduce" / "atr_trail" / "ripster_defend"
 * @param {string} opts.sym      Ticker
 * @param {object} opts.proposal Lifecycle proposal (built upstream via buildCIOLifecycleProposal or inline)
 * @param {object} opts.memory   CIO memory bundle (may be slim; memory builder is upstream's responsibility)
 * @param {string} [opts.engineDefaultDecision] Engine default decision string (so we can detect overrides). Defaults to ENGINE_DEFAULT[type].decision.
 * @returns {Promise<{decision, reasoning, fallback, model, override, latency_ms, cost_capped, timed_out, recorded_only}>}
 */
export async function cioLifecycleGate(env, opts = {}) {
  const t0 = Date.now();
  const type = String(opts.type || "");
  const bucket = String(opts.bucket || "_unknown");
  const sym = String(opts.sym || "?").toUpperCase();
  const cfg = getLifecycleGateConfig(env);
  const engineDefault = opts.engineDefaultDecision || ENGINE_DEFAULT[type]?.decision || "PROCEED";

  // 0. Type disabled → engine default, no logging, no spend.
  if (!cfg.types[type]) {
    return {
      decision: engineDefault,
      reasoning: "type_disabled",
      fallback: true,
      model: null,
      latency_ms: 0,
      cost_capped: false,
      timed_out: false,
      recorded_only: false,
    };
  }

  // Dedup — keyed by (sym, type, bucket). Use the cached result rather than
  // burning a second CIO call within DEDUP_TTL_MS.
  const dedupKey = `${sym}|${type}|${bucket}`;
  const cached = dedupGet(env, dedupKey);
  if (cached) {
    return { ...cached, dedup: true };
  }

  // 1. Monthly $ cap — short-circuit before we burn the call.
  try {
    const spent = await getMonthlySpendUsd(env);
    if (spent >= cfg.monthlyUsdCap) {
      await bumpStat(env, type, "cost_cap_hits");
      console.warn(`[AI_CIO_GATE] cost_cap_hit type=${type} sym=${sym} bucket=${bucket} spent=$${spent.toFixed(3)} cap=$${cfg.monthlyUsdCap}`);
      return {
        decision: engineDefault,
        reasoning: "cost_cap",
        fallback: true,
        model: null,
        latency_ms: 0,
        cost_capped: true,
        timed_out: false,
        recorded_only: false,
      };
    }
  } catch { /* spend check is best-effort */ }

  // 2. Call CIO with the tighter lifecycle-gate timeout. We do NOT pass
  //    chartSvg — lifecycle decisions on the hot path should be text-only
  //    (vision adds 600-1200 ms latency and 3-4x cost). Chart vision is
  //    still available for entry decisions via the existing path.
  await bumpStat(env, type, "calls");

  let cioResult;
  let timedOut = false;
  try {
    cioResult = await Promise.race([
      evaluateCIOLifecycle(env, opts.proposal || {}, opts.memory || {}, null, null),
      new Promise((resolve) => setTimeout(() => {
        timedOut = true;
        resolve({ decision: engineDefault, fallback: true, reason: "gate_timeout", model: null });
      }, cfg.timeoutMs)),
    ]);
  } catch (err) {
    console.warn(`[AI_CIO_GATE] exception type=${type} sym=${sym}: ${String(err?.message || err).slice(0, 120)}`);
    cioResult = { decision: engineDefault, fallback: true, reason: "exception", model: null };
  }

  if (timedOut) await bumpStat(env, type, "timeouts");
  if (cioResult?.fallback) await bumpStat(env, type, "fallbacks");

  // 3. Account spend (only if we actually completed a call).
  if (!timedOut && !cioResult?.fallback && cioResult?.model) {
    await addMonthlySpend(env, estimatedCostUsd(cioResult.model));
  }

  const latency = Date.now() - t0;
  const decision = String(cioResult?.decision || engineDefault).toUpperCase();
  const isOverride = !cioResult?.fallback && decision !== engineDefault.toUpperCase();
  const recordOnly = !!cfg.recordOnly?.[type];

  if (isOverride) {
    await bumpStat(env, type, "overrides");
    const reasoningShort = String(cioResult?.reasoning || "").slice(0, 140);
    console.log(`[AI_CIO_GATE] override type=${type} sym=${sym} bucket=${bucket} engine_default=${engineDefault} cio=${decision} record_only=${recordOnly} latency_ms=${latency} edge_remaining=${cioResult?.edge_remaining ?? "?"} reasoning="${reasoningShort}"`);
  }

  const result = {
    decision: recordOnly ? engineDefault : decision,
    cio_decision: decision,
    reasoning: cioResult?.reasoning || null,
    risk_flags: cioResult?.risk_flags || [],
    edge_remaining: cioResult?.edge_remaining ?? null,
    override: cioResult?.override || null,
    fallback: !!cioResult?.fallback,
    model: cioResult?.model || null,
    latency_ms: latency,
    cost_capped: false,
    timed_out: timedOut,
    recorded_only: recordOnly && isOverride,
    is_override: isOverride,
  };

  dedupPut(env, dedupKey, result);
  return result;
}

// ── Convenience wrappers ───────────────────────────────────────────────────

/**
 * Review an entry that the engine wanted to skip (e.g. Loop 2 trip).
 * Returns { allow: boolean, reasoning, gate }.
 *
 * Engine default is SKIP. If CIO returns OVERRIDE with edge_remaining >= 0.7,
 * we let the entry through — operator can lower the bar via
 * model_config { ai_cio_entry_skip_min_edge: "0.6" }.
 */
export async function cioReviewEntrySkip(env, { sym, direction, proposal, memory, bucket, getTickerProfile }) {
  const cfg = getLifecycleGateConfig(env);
  if (!cfg.types.entry_skip_review) {
    return { allow: false, reasoning: "type_disabled" };
  }
  const liveProposal = proposal || buildCIOLifecycleProposal("ENTRY_SKIP_REVIEW", sym, {
    direction, entryPrice: 0, entry_ts: Date.now(),
  }, {}, 0, getTickerProfile || (() => ({ profileKey: "unknown", label: "?" })));
  liveProposal.engine_action = "SKIP";
  liveProposal.engine_reason = bucket || "loop2_trip";

  const gate = await cioLifecycleGate(env, {
    type: "entry_skip_review",
    bucket: bucket || "loop2_trip",
    sym,
    proposal: liveProposal,
    memory: memory || {},
    engineDefaultDecision: "SKIP",
  });

  const merged = { ...(env?._cioModelCache || {}), ...(env?._deepAuditConfig || {}) };
  const minEdge = Number(merged?.ai_cio_entry_skip_min_edge ?? env?.AI_CIO_ENTRY_SKIP_MIN_EDGE) || 0.7;
  const allow = gate.is_override && gate.cio_decision === "OVERRIDE" && Number(gate.edge_remaining) >= minEdge;

  return { allow, reasoning: gate.reasoning, edge_remaining: gate.edge_remaining, gate };
}

/**
 * Review an Investor auto-rebalance trim before it executes.
 * Returns { proceed: boolean, reasoning, gate }.
 *
 * Engine default is PROCEED (trim). If CIO returns HOLD with edge_remaining
 * >= 0.6, we skip the trim and let the position breathe.
 */
export async function cioReviewRebalanceTrim(env, { sym, direction, currentPrice, position, scoreData, bucket, getTickerProfile }) {
  const cfg = getLifecycleGateConfig(env);
  if (!cfg.types.rebalance_trim) {
    return { proceed: true, reasoning: "type_disabled" };
  }
  // Build a lightweight openTrade shim from the investor position so the
  // existing buildCIOLifecycleProposal helper can work on it.
  const openTradeShim = {
    direction: String(direction || "LONG").toUpperCase(),
    entryPrice: Number(position?.avg_entry) || Number(position?.cost_basis) / Math.max(1, Number(position?.total_shares)) || 0,
    entry_ts: Number(position?.first_entry_ts) || Date.now() - 30 * 86400000,
    setupName: "investor_accumulate",
    setupGrade: scoreData?.score ?? null,
    sl: null,
    tp: null,
    trimmedPct: 0,
  };
  const proposal = buildCIOLifecycleProposal(
    "REBALANCE_TRIM",
    sym,
    openTradeShim,
    { ticker: sym, regime_class: scoreData?.regime || null },
    Number(currentPrice) || 0,
    getTickerProfile || (() => ({ profileKey: "investor", label: "Investor", max_hold_hours: 24 * 365 })),
  );
  proposal.engine_action = bucket || "auto_reduce";
  proposal.investor_score = scoreData?.score ?? null;
  proposal.investor_stage = scoreData?.stage || null;
  proposal.position_shares = Number(position?.total_shares) || 0;
  proposal.position_cost_basis = Number(position?.cost_basis) || 0;

  const gate = await cioLifecycleGate(env, {
    type: "rebalance_trim",
    bucket: bucket || "auto_reduce",
    sym,
    proposal,
    memory: {},
    engineDefaultDecision: "PROCEED",
  });

  const merged = { ...(env?._cioModelCache || {}), ...(env?._deepAuditConfig || {}) };
  const minEdge = Number(merged?.ai_cio_rebalance_min_hold_edge ?? env?.AI_CIO_REBALANCE_MIN_HOLD_EDGE) || 0.6;
  const proceed = !(gate.is_override && gate.cio_decision === "HOLD" && Number(gate.edge_remaining) >= minEdge);

  return { proceed, reasoning: gate.reasoning, gate };
}

/**
 * Record CIO opinion on an SL move. By default this is RECORD-ONLY — the
 * SL still moves but we log CIO's view for audit. Operator can flip to
 * authoritative via model_config { ai_cio_sl_move_authoritative: "true" }.
 *
 * Returns { proceed: boolean, reasoning, gate }.
 */
export async function cioReviewSlMove(env, { sym, direction, oldSl, newSl, currentPrice, openTrade, tickerData, bucket, getTickerProfile }) {
  const cfg = getLifecycleGateConfig(env);
  if (!cfg.types.sl_move) {
    return { proceed: true, reasoning: "type_disabled" };
  }
  // Threshold: only consult CIO when the move is meaningful — >= 1.5% of the
  // entry-to-SL distance. Micro-adjustments stay mechanical.
  const entry = Number(openTrade?.entryPrice) || 0;
  const minMovePct = Number(env?.AI_CIO_SL_MOVE_MIN_PCT) || 1.5;
  if (entry > 0 && oldSl != null && newSl != null) {
    const baseline = Math.abs(entry - Number(oldSl)) || 0.01;
    const move = Math.abs(Number(newSl) - Number(oldSl));
    const movePct = (move / baseline) * 100;
    if (movePct < minMovePct) {
      return { proceed: true, reasoning: `sub_threshold_move (${movePct.toFixed(2)}% < ${minMovePct}%)` };
    }
  }

  const proposal = buildCIOLifecycleProposal(
    "SL_MOVE",
    sym,
    openTrade || { direction, entryPrice: entry, entry_ts: Date.now() },
    tickerData || { ticker: sym },
    Number(currentPrice) || 0,
    getTickerProfile || (() => ({ profileKey: "unknown", label: "?", max_hold_hours: 168 })),
  );
  proposal.engine_action = bucket || "trail_sl";
  proposal.sl_old = Number(oldSl);
  proposal.sl_new = Number(newSl);

  const gate = await cioLifecycleGate(env, {
    type: "sl_move",
    bucket: bucket || "trail_sl",
    sym,
    proposal,
    memory: {},
    engineDefaultDecision: "PROCEED",
  });

  // Record-only mode: SL still moves regardless of CIO opinion.
  const proceed = gate.recorded_only ? true : !(gate.is_override && gate.cio_decision === "HOLD");
  return { proceed, reasoning: gate.reasoning, gate };
}

/**
 * Record CIO opinion on a DEFEND lane activation. RECORD-ONLY by design —
 * per PR #285 doctrine wins on disagreement; this builds the audit dataset
 * so we can identify cases where CIO was right and doctrine was wrong.
 *
 * Non-blocking: caller should pass through ctx.waitUntil() to avoid adding
 * latency to the management path.
 */
export async function cioRecordDefend(env, { sym, direction, currentPrice, openTrade, tickerData, exitReason, bucket, getTickerProfile }) {
  const cfg = getLifecycleGateConfig(env);
  if (!cfg.types.defend_record) return;

  try {
    const proposal = buildCIOLifecycleProposal(
      "DEFEND_OPINION",
      sym,
      openTrade || { direction, entryPrice: 0, entry_ts: Date.now() },
      tickerData || { ticker: sym, __exit_reason: exitReason },
      Number(currentPrice) || 0,
      getTickerProfile || (() => ({ profileKey: "unknown", label: "?", max_hold_hours: 168 })),
    );
    proposal.engine_action = "DEFEND";
    proposal.engine_exit_reason = exitReason || "?";

    await cioLifecycleGate(env, {
      type: "defend_record",
      bucket: bucket || "doctrine_defend",
      sym,
      proposal,
      memory: {},
      engineDefaultDecision: "RECORD_ONLY",
    });
  } catch (e) {
    console.warn("[AI_CIO_GATE] cioRecordDefend failed:", String(e?.message || e).slice(0, 120));
  }
}
