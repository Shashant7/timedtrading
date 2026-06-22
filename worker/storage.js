// Storage module — KV and D1 helpers for Timed Trading Worker

import { serializeSequenceTrailSnapshot } from "./foundation/sequence-snapshot.js";

/** Read JSON from KV. Returns null if missing or invalid. */
export async function kvGetJSON(KV, key) {
  const t = await KV.get(key);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Write JSON to KV. */
export async function kvPutJSON(KV, key, val, ttlSec = null) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0)
    opts.expirationTtl = Math.floor(ttlSec);
  await KV.put(key, JSON.stringify(val), opts);
}

/** Write text to KV. */
export async function kvPutText(KV, key, text, ttlSec = null) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0)
    opts.expirationTtl = Math.floor(ttlSec);
  await KV.put(key, text, opts);
}

/** Retry KV write with verification (for critical operations like trade saving). */
export async function kvPutJSONWithRetry(
  KV,
  key,
  val,
  ttlSec = null,
  maxRetries = 3,
) {
  const opts = {};
  if (ttlSec && Number.isFinite(ttlSec) && ttlSec > 0)
    opts.expirationTtl = Math.floor(ttlSec);

  const valStr = JSON.stringify(val);
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await KV.put(key, valStr, opts);

      await new Promise((resolve) => setTimeout(resolve, 50));
      const verify = await KV.get(key);

      if (verify && verify === valStr) {
        return { success: true, attempt };
      } else if (verify) {
        try {
          JSON.parse(verify);
          JSON.parse(valStr);
          return {
            success: true,
            attempt,
            note: "verified (concurrent update possible)",
          };
        } catch {
          lastError = new Error(
            `Verification failed: value mismatch on attempt ${attempt}`,
          );
        }
      } else {
        lastError = new Error(
          `Verification failed: value not found after write on attempt ${attempt}`,
        );
      }
    } catch (err) {
      lastError = err;
    }

    if (attempt < maxRetries) {
      await new Promise((resolve) =>
        setTimeout(resolve, 50 * Math.pow(2, attempt - 1)),
      );
    }
  }

  return { success: false, error: lastError, attempts: maxRetries };
}

/** D1 safe limit for payload_json (Cloudflare SQL statement limit ~100KB). */
const D1_MAX_PAYLOAD_BYTES = 50000;

/** Truncate JSON string to fit D1. */
export function truncatePayloadForD1(jsonStr) {
  if (jsonStr == null || typeof jsonStr !== "string") return jsonStr;
  if (jsonStr.length <= D1_MAX_PAYLOAD_BYTES) return jsonStr;
  return jsonStr.slice(0, D1_MAX_PAYLOAD_BYTES - 1);
}

/** Keys to omit from payload when writing to D1 (avoids Invalid string length). */
const D1_OMIT_KEYS = new Set([
  "context", "fundamentals", "profile", "company_profile", "capture",
  "description", "longBusinessSummary", "business_summary", "raw", "meta",
]);

/** Additional heavy fields that aren't rendered in any frontend UI but
 * are large enough to push slim payloads above 50KB. Dropped in the
 * "compact-slim" intermediate step (between slim and minimal) so the
 * fields the right-rail Technicals + Analysis tabs depend on
 * (tf_tech, _ticker_profile, td_sequential, ema_map, ichimoku_*)
 * survive a size-driven fallback. */
const D1_COMPACT_OMIT_KEYS = new Set([
  // Heavy regime / ML telemetry — used by backtest, not the live UI
  "_marketInternals", "market_internals",
  "regime_factors", "regime_params", "regime_score", "regime_class", "regime", "regimeVocabulary",
  "ml", "ml_v1", "model",
  "__pullback_details", "__pullback_confirmed",
  "__ath_breakout_diag", "__gap_reversal_diag", "__n_test_support_diag",
  "__range_reversal_diag", "__entry_divergence_summary",
  "_signalWeights", "_scoreWeights", "_tfWeights",
  "_env", "_scoring_skip_reason",
  // Move history (re-fetched live from /timed/trail when needed)
  "trail",
]);

/** Slim payload for D1 storage: drop large optional fields, keep scoring/trade/UI essentials. */
export function slimPayloadForD1(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (D1_OMIT_KEYS.has(k)) continue;
    if (v != null && typeof v === "object" && !Array.isArray(v) && typeof v !== "function") {
      const nested = slimPayloadForD1(v);
      if (Object.keys(nested || {}).length > 0 || Array.isArray(nested)) out[k] = nested;
      else out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Compact slim: drops the heavy regime / ML / diagnostic blobs that
 * never reach the UI, but KEEPS tf_tech, _ticker_profile, td_sequential,
 * ema_map, ichimoku_*, fuel, atr_levels, liq_* — everything the right
 * rail's Technicals / Analysis / Setup tabs read. Use this when the
 * full slim payload exceeds the D1 size budget but we still want the
 * rail to show real data instead of a "not loaded" empty state. */
export function compactSlimPayloadForD1(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (D1_OMIT_KEYS.has(k)) continue;
    if (D1_COMPACT_OMIT_KEYS.has(k)) continue;
    if (v != null && typeof v === "object" && !Array.isArray(v) && typeof v !== "function") {
      const nested = compactSlimPayloadForD1(v);
      if (Object.keys(nested || {}).length > 0 || Array.isArray(nested)) out[k] = nested;
      else out[k] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Minimal payload for D1 when slim is still too large (replay + UI essentials).
 *
 * V15 P0.7.180 (2026-05-17) — Added the right-rail Technicals / Analysis
 * tab fields (tf_tech, _ticker_profile, td_sequential, ema_map,
 * ichimoku_d, ichimoku_map, horizon_bucket, momentum_pct,
 * momentum_elite_criteria, execution_profile, fuel, atr_levels,
 * st_support, deltas, eta_days_v2, eta_days_next, rank_position,
 * rank_score, focus_conviction_score, focus_tier, expected_return_pct,
 * risk_pct, scoring_version) so the rail still renders real data for
 * tickers whose slim payload exceeded the D1 size budget. Before this,
 * /timed/latest dropped tf_tech for ~70% of the universe (SPY, QQQ,
 * IWM, NVDA, MSFT, GOOGL, META, JPM, …) which made the Technicals tab
 * a permanent "not loaded" empty state. */
const D1_MINIMAL_KEYS = [
  "ts", "price", "close", "htf_score", "ltf_score", "completion", "phase_pct", "saty_phase_pct", "state", "rank",
  "flags", "trigger_reason", "trigger_dir", "trigger_price", "sl", "tp", "trigger_ts", "ingest_ts",
  "kanban_stage", "kanban_meta", "entry_ts", "entry_price", "prev_kanban_stage", "move_status",
  "rr", "score", "tp_levels",
  // Model pattern match enrichment
  "pattern_match",
  // Daily change / Current price display (many tickers missing these when minimal was used)
  "prev_close", "previous_close", "prior_close", "yclose", "close_prev",
  "day_change", "daily_change", "session_change", "chg",
  "day_change_pct", "daily_change_pct", "session_change_pct", "chp",
  "change", "change_pct", "pct_change", "is_rth", "session",
  // ── V15 P0.7.180 — Right-rail data the Technicals + Analysis tabs need ──
  // Without these, every ticker that exceeded the slim D1 size budget
  // (NVDA, MSFT, GOOGL, META, JPM, SPY, QQQ, IWM, …) had a permanently
  // empty Technicals tab and a broken Behavior Profile card.
  "tf_tech", "_ticker_profile", "_tickerProfile", "td_sequential",
  "ema_map", "ichimoku_d", "ichimoku_map",
  "horizon_bucket", "momentum_pct", "momentum_elite_criteria",
  "execution_profile", "fuel", "atr_levels", "atr_d", "atr_w",
  "st_support", "deltas", "eta_days_v2", "eta_days_next", "eta_days_max", "eta_confidence",
  "rank_position", "rank_score", "rank_total", "focus_conviction_score", "focus_tier",
  "expected_return_pct", "risk_pct", "scoring_version",
  "leading_ltf", "lead_intraday_tf",
  "entry_decision", "entry_ref", "entry_change_pct", "entry_quality",
  "tp_target_price", "tp_max_price", "tp_target_pct", "tp_max_pct",
  "tp_trim", "tp_exit", "tp_runner", "tp_likely",
  "rr_now_likely", "rr_entry_likely", "sl_dynamic",
  "saty_phase_exit", "phase_dir", "phase_divergence", "phase_zone", "phase_slope_5bar",
  "flip_watch_score", "flip_watch_reasons",
  "fvg_4h", "fvg_D", "fvg_imbalance_D",
  "pdz_4h", "pdz_D", "pdz_pct_4h", "pdz_pct_D", "pdz_zone_4h", "pdz_zone_D",
  "rvol_map", "volatility_atr_pct", "volatility_tier",
  "swing_consensus", "daily_structure", "regime_class", "regime",
  "tf_summary", "ema_regime_1h", "ema_regime_4h", "ema_regime_daily",
  "orb", "overnight_gap", "reset_at", "ticker",
  // 2026-05-22 — Markov regime forecast bundle. Tiny (~4 numbers × 3
  // horizons + meta), needed by the right-rail "What's likely next"
  // panel and by the AI CIO when it reasons about position holdability.
  "regime_forecast",
  // 2026-05-22 Phase C — HMM latent regime (universe-wide signal,
  // attached to every ticker payload for downstream reads). Tiny.
  "latent_regime",
  // 2026-05-22 Phase B — Markov dwell exhaustion advisory + run-length
  // counters. Tiny.
  "regime_exhausted", "_regime_run_length", "_regime_run_started_at",
  // Setup sequence shadow (read-only; does not gate entry)
  "setup_shadow", "setup_sequences", "setup_shadow_posture",
  "setup_shadow_event_count", "setup_shadow_as_of_ts",
  // Setup gate shadow (read-only; does not gate entry)
  "setup_gate_shadow", "setup_gates", "setup_gate_lookback_hours",
  "setup_gate_event_count", "setup_gate_as_of_ts",
];

export function minimalPayloadForD1(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  const out = {};
  for (const k of D1_MINIMAL_KEYS) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

/** FNV-1a style string hash for dedupe keys. */
export function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

/** Insert a trail point into D1 timed_trail. */
export async function d1InsertTrailPoint(env, ticker, payload) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  const ts = Number(payload?.ts);
  if (!Number.isFinite(ts))
    return { ok: false, skipped: true, reason: "bad_ts" };

  const point = {
    ts,
    price: payload?.price,
    htf_score: payload?.htf_score,
    ltf_score: payload?.ltf_score,
    completion: payload?.completion,
    phase_pct: payload?.phase_pct,
    state: payload?.state,
    rank: payload?.rank,
    flags: payload?.flags || {},
    trigger_reason: payload?.trigger_reason,
    trigger_dir: payload?.trigger_dir,
    kanban_stage: payload?.kanban_stage || null,
  };

  const flagsJson =
    point?.flags && typeof point.flags === "object"
      ? JSON.stringify(point.flags)
      : point?.flags != null
        ? JSON.stringify(point.flags)
        : null;

  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO timed_trail
          (ticker, ts, price, htf_score, ltf_score, completion, phase_pct, state, rank, flags_json, trigger_reason, trigger_dir, kanban_stage, payload_json)
         VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(
        String(ticker || "").toUpperCase(),
        ts,
        point?.price != null ? Number(point.price) : null,
        point?.htf_score != null ? Number(point.htf_score) : null,
        point?.ltf_score != null ? Number(point.ltf_score) : null,
        point?.completion != null ? Number(point.completion) : null,
        point?.phase_pct != null ? Number(point.phase_pct) : null,
        point?.state != null ? String(point.state) : null,
        point?.rank != null ? Number(point.rank) : null,
        flagsJson,
        point?.trigger_reason != null ? String(point.trigger_reason) : null,
        point?.trigger_dir != null ? String(point.trigger_dir) : null,
        point?.kanban_stage != null ? String(point.kanban_stage) : null,
        serializeSequenceTrailSnapshot(payload, env),
      )
      .run();

    return { ok: true };
  } catch (err) {
    console.error(`[D1 TRAIL] Insert failed for ${ticker}:`, err);
    return { ok: false, error: String(err) };
  }
}

/** Insert an ingest receipt into D1 ingest_receipts (dedupe). */
export async function d1InsertIngestReceipt(env, ticker, payload, rawPayload) {
  const db = env?.DB;
  if (!db) return { ok: false, skipped: true, reason: "no_db_binding" };

  const ts = Number(payload?.ts);
  if (!Number.isFinite(ts))
    return { ok: false, skipped: true, reason: "bad_ts" };

  let raw = typeof rawPayload === "string" ? rawPayload : "";
  if (!raw) {
    try {
      raw = JSON.stringify(payload);
    } catch {
      raw = "";
    }
  }
  const hash = stableHash(raw || "");
  const receiptId = `${String(ticker || "").toUpperCase()}:${ts}:${hash}`;
  const bucket5m = Math.floor(ts / (5 * 60 * 1000)) * (5 * 60 * 1000);
  const receivedTs = Date.now();
  const scriptVersion = payload?.script_version || null;

  let payloadJson = raw || null;
  if (payloadJson) {
    try {
      const parsed = JSON.parse(payloadJson);
      let slim = slimPayloadForD1(parsed);
      let s = JSON.stringify(slim);
      if (s.length > D1_MAX_PAYLOAD_BYTES) {
        slim = minimalPayloadForD1(parsed);
        s = JSON.stringify(slim);
      }
      payloadJson = s.length <= D1_MAX_PAYLOAD_BYTES ? s : JSON.stringify(minimalPayloadForD1(parsed));
    } catch {
      payloadJson = raw.length <= D1_MAX_PAYLOAD_BYTES ? raw : null;
    }
  }

  try {
    await db
      .prepare(
        `INSERT OR IGNORE INTO ingest_receipts
          (receipt_id, ticker, ts, bucket_5m, received_ts, payload_hash, script_version, payload_json)
         VALUES
          (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        receiptId,
        String(ticker || "").toUpperCase(),
        ts,
        bucket5m,
        receivedTs,
        hash,
        scriptVersion,
        payloadJson,
      )
      .run();

    return { ok: true };
  } catch (err) {
    console.error(`[D1 INGEST] Receipt insert failed for ${ticker}:`, err);
    return { ok: false, error: String(err) };
  }
}
