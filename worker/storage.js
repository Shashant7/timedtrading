// Storage module — KV and D1 helpers for Timed Trading Worker

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

/** Minimal payload for D1 when slim is still too large (replay + UI essentials). */
const D1_MINIMAL_KEYS = [
  "ts", "price", "close", "htf_score", "ltf_score", "completion", "phase_pct", "state", "rank",
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
        (() => {
          try {
            let slim = slimPayloadForD1(payload);
            let s = JSON.stringify(slim);
            if (s.length > D1_MAX_PAYLOAD_BYTES) {
              slim = minimalPayloadForD1(payload);
              s = JSON.stringify(slim);
            }
            return s.length <= D1_MAX_PAYLOAD_BYTES ? s : null;
          } catch {
            return null;
          }
        })(),
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
