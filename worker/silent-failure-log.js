// worker/silent-failure-log.js
//
// Durable breadcrumb ring for critical "silent failure" sites.
//
// WHY: Cloudflare caps a single request's logs at 256KB (across all
// console.* + exceptions + metadata). During a heavy */5 scoring cron the
// worker logs a lot, so a late per-stage breadcrumb — e.g. the
// [ENTRY_FINALIZE] guards that record which alert-copy builder threw — can
// be truncated and lost, and `wrangler tail` never shows it. That is the
// exact observability gap that let the Active Trader entry cascade (email +
// broker order silently dropped) go undiagnosed for weeks.
//
// This ring persists the last N failures to KV under a well-known key so the
// operator (and the next agent) can always recover the exact stage + error
// independent of log truncation. Read it via GET
// /timed/admin/debug/silent-failures or `wrangler kv key get`.
//
// CONTRACT: best-effort and it MUST NEVER THROW — an observability tool that
// can itself blow up a hot path is worse than the gap it closes.

export const SILENT_FAILURE_RING_KEY = "timed:debug:silent-failures";
const RING_MAX = 100;
const RING_TTL_SEC = 30 * 86400; // 30 days

/**
 * Record a silent-failure breadcrumb to the durable KV ring (and console).
 * @param {object} env - worker env (needs env.KV_TIMED)
 * @param {object} rec
 * @param {string} rec.stage  - dotted stage id, e.g. "entry_finalize.parity"
 * @param {string} [rec.ticker]
 * @param {any}    [rec.error] - Error or string
 * @param {object} [rec.meta]  - small JSON-serialisable context
 * @returns {Promise<object>} the entry that was recorded
 */
export async function recordSilentFailure(env, { stage, ticker = null, error = null, meta = null } = {}) {
  const entry = {
    ts: Date.now(),
    stage: String(stage || "unknown").slice(0, 100),
    ticker: ticker ? String(ticker).toUpperCase().slice(0, 24) : null,
    error: error == null ? null : String(error?.stack || error?.message || error).slice(0, 800),
    meta: meta && typeof meta === "object" ? meta : null,
  };
  // Console too — cheap and visible when the request is NOT over the 256KB cap.
  try {
    console.error(
      `[SILENT_FAILURE] ${entry.stage}${entry.ticker ? ` ${entry.ticker}` : ""}: ${String(entry.error || "").slice(0, 300)}`,
    );
  } catch (_) { /* ignore */ }
  const KV = env?.KV_TIMED;
  if (!KV) return entry;
  try {
    const raw = await KV.get(SILENT_FAILURE_RING_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) throw new Error("ring_not_array");
    list.unshift(entry);
    if (list.length > RING_MAX) list.length = RING_MAX;
    await KV.put(SILENT_FAILURE_RING_KEY, JSON.stringify(list), { expirationTtl: RING_TTL_SEC });
  } catch (_) {
    // A corrupt/oversized ring must not wedge the path — reset to just this entry.
    try {
      await KV.put(SILENT_FAILURE_RING_KEY, JSON.stringify([entry]), { expirationTtl: RING_TTL_SEC });
    } catch (_2) { /* observability must never throw */ }
  }
  return entry;
}

/**
 * Read the silent-failure ring (newest first).
 * @param {object} env
 * @param {object} [opts]
 * @param {number} [opts.limit=100]
 * @param {string} [opts.stage] - substring filter on stage
 * @returns {Promise<object[]>}
 */
export async function readSilentFailures(env, { limit = 100, stage = null } = {}) {
  const KV = env?.KV_TIMED;
  if (!KV) return [];
  try {
    const parsed = JSON.parse((await KV.get(SILENT_FAILURE_RING_KEY)) || "[]");
    let list = Array.isArray(parsed) ? parsed : [];
    if (stage) {
      const needle = String(stage).toLowerCase();
      list = list.filter((r) => String(r?.stage || "").toLowerCase().includes(needle));
    }
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return list.slice(0, n);
  } catch (_) {
    return [];
  }
}
