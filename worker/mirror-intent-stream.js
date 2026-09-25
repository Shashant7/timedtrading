// worker/mirror-intent-stream.js
//
// The model pushes desired remaining quantity; brokers consume it.
//
// Until Phase 2 retires the KV mirror for a Cloudflare Queue, this is the
// durable stream: every index day-trade model leg publishes (or updates) an
// intent row keyed by signal id. The minute cron drains `close_owed` rows
// through the existing partner + operator reconciler — so a missed STOP
// event cannot leave a partner long with nothing to disagree with.
//
// Status:
//   open         model still holds (target_remaining > 0)
//   close_owed   model flat; brokers must converge to zero
//   settled      every account confirmed flat / partner close stamped

export const INTENT_KEY_PREFIX = "timed:opt-dt-intent:";
export const INTENT_INDEX_KEY = "timed:opt-dt-intent-index";
export const INTENT_INDEX_MAX = 200;

export function indexDtIntentKey(signalId) {
  return `${INTENT_KEY_PREFIX}${String(signalId || "").trim()}`;
}

/**
 * Build the row the stream stores. Pure — callers decide when to publish.
 */
export function buildIndexDtIntent({
  signalId,
  ticker = null,
  event = null,
  remainingQty = 0,
  entryTs = null,
  now = Date.now(),
} = {}) {
  const sid = String(signalId || "").trim();
  if (!sid) return null;
  const remaining = Math.max(0, Math.round(Number(remainingQty) || 0));
  const ev = String(event || "").toUpperCase() || null;
  return {
    signal_id: sid,
    ticker: ticker ? String(ticker).toUpperCase() : null,
    last_event: ev,
    target_remaining: remaining,
    entry_ts: Number(entryTs) || null,
    updated_at: now,
    status: remaining > 0 ? "open" : "close_owed",
  };
}

async function loadIndex(env) {
  try {
    const raw = await env.KV_TIMED.get(INTENT_INDEX_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveIndex(env, ids) {
  const next = [...new Set((ids || []).map((s) => String(s || "").trim()).filter(Boolean))]
    .slice(-INTENT_INDEX_MAX);
  await env.KV_TIMED.put(INTENT_INDEX_KEY, JSON.stringify(next), { expirationTtl: 3 * 86400 });
  return next;
}

/** Publish (upsert) one model intent. Brokers drain close_owed on the cron. */
export async function publishIndexDtIntent(env, partial) {
  if (!env?.KV_TIMED) return null;
  const intent = buildIndexDtIntent(partial);
  if (!intent) return null;
  const key = indexDtIntentKey(intent.signal_id);
  let prev = null;
  try {
    const raw = await env.KV_TIMED.get(key);
    prev = raw ? JSON.parse(raw) : null;
  } catch { prev = null; }

  // Re-entry (BUY with size) always reopens. A close on an already-settled
  // row stays settled so the drain does not loop forever.
  let status = intent.status;
  if (intent.target_remaining > 0) status = "open";
  else if (prev?.status === "settled") status = "settled";

  const merged = {
    ...(prev && typeof prev === "object" ? prev : {}),
    ...intent,
    status,
    settled_at: status === "settled" ? (prev?.settled_at || intent.updated_at) : null,
    partners_settled: status === "open" ? false : (prev?.partners_settled || false),
  };
  await env.KV_TIMED.put(key, JSON.stringify(merged), { expirationTtl: 3 * 86400 });
  const idx = await loadIndex(env);
  if (!idx.includes(intent.signal_id)) await saveIndex(env, [...idx, intent.signal_id]);
  return merged;
}

export async function markIndexDtIntentSettled(env, signalId, { now = Date.now(), partnersSettled = true } = {}) {
  if (!env?.KV_TIMED || !signalId) return null;
  const key = indexDtIntentKey(signalId);
  let prev = null;
  try {
    const raw = await env.KV_TIMED.get(key);
    prev = raw ? JSON.parse(raw) : null;
  } catch { return null; }
  if (!prev) return null;
  const next = {
    ...prev,
    status: "settled",
    target_remaining: 0,
    partners_settled: !!partnersSettled,
    settled_at: now,
    updated_at: now,
  };
  await env.KV_TIMED.put(key, JSON.stringify(next), { expirationTtl: 3 * 86400 });
  return next;
}

/** Intents the brokers still owe a flatten for. */
export async function listCloseOwedIndexDtIntents(env, { limit = 20 } = {}) {
  if (!env?.KV_TIMED) return [];
  const idx = await loadIndex(env);
  const out = [];
  for (const sid of idx) {
    if (out.length >= limit) break;
    try {
      const raw = await env.KV_TIMED.get(indexDtIntentKey(sid));
      if (!raw) continue;
      const row = JSON.parse(raw);
      if (row?.status === "close_owed") out.push(row);
    } catch { /* skip bad row */ }
  }
  return out;
}
