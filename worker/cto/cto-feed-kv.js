// worker/cto/cto-feed-kv.js
// Slim KV cache for the user-facing CTO levels feed (Today hero + Now tab).

export const CTO_FEED_KV_KEY = "timed:cto:research_feed";
const FEED_TTL_SEC = 6 * 3600;

function kvStore(env) {
  return env?.KV_TIMED || env?.KV || null;
}

/** Persist a slim CTO feed snapshot built from the universe rollup. */
export async function syncCTOFeedKv(env, payload) {
  const KV = kvStore(env);
  if (!KV || !payload) return { ok: false, error: "no_kv_or_payload" };

  const now = Date.now();
  const envelope = {
    ...payload,
    updated_at: now,
    count: Array.isArray(payload.items) ? payload.items.length : 0,
  };

  await KV.put(CTO_FEED_KV_KEY, JSON.stringify(envelope), { expirationTtl: FEED_TTL_SEC });
  return { ok: true, count: envelope.count };
}

/** Read cached CTO feed. Returns null when missing or corrupt. */
export async function loadCTOFeedKv(env) {
  const KV = kvStore(env);
  if (!KV) return null;
  try {
    const raw = await KV.get(CTO_FEED_KV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
