// worker/cro/research-feed-kv.js
// KV cache for the public Research Desk feed — deduped, date-ordered,
// with archival of items that fall outside the active window.

export const RESEARCH_FEED_KV_KEY = "timed:cro:research_feed";
export const RESEARCH_FEED_ARCHIVE_KEY = "timed:cro:research_feed:archive";

const DEFAULT_LOOKBACK_DAYS = 7;
const ACTIVE_TTL_SEC = 10 * 86400;
const ARCHIVE_TTL_SEC = 90 * 86400;
const MAX_ARCHIVE_ITEMS = 200;

/** Parse publication / fetch timestamp to epoch ms for sorting + windowing. */
export function parsePublicationTs(row) {
  if (!row) return 0;
  const pub = row.published_at;
  if (pub) {
    const d = Date.parse(String(pub));
    if (Number.isFinite(d)) return d;
  }
  const fetched = Number(row.fetched_at);
  if (Number.isFinite(fetched) && fetched > 0) return fetched;
  const sortTs = Number(row.sort_ts);
  if (Number.isFinite(sortTs) && sortTs > 0) return sortTs;
  return 0;
}

function kvStore(env) {
  return env?.KV_TIMED || env?.KV || null;
}

/**
 * Merge feed items into KV: dedupe by pub_id, keep active window, archive evicted.
 * Newer snapshot wins per pub_id (by sort_ts / updated_at).
 */
export async function syncResearchFeedKv(env, items, { lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const KV = kvStore(env);
  if (!KV) return { ok: false, error: "no_kv" };
  if (!Array.isArray(items)) return { ok: false, error: "items_required" };

  const lookbackMs = Math.max(1, lookbackDays) * 86400000;
  const cutoff = Date.now() - lookbackMs;
  const now = Date.now();

  let prev = { items: [], archive: [] };
  try {
    const raw = await KV.get(RESEARCH_FEED_KV_KEY);
    if (raw) prev = JSON.parse(raw);
  } catch (_) { /* fresh */ }

  const byId = new Map();

  // Seed from existing active cache (still inside window).
  for (const it of (prev.items || [])) {
    if (!it?.pub_id) continue;
    const ts = parsePublicationTs(it);
    if (ts >= cutoff) byId.set(String(it.pub_id), { ...it, sort_ts: ts });
  }

  // Merge incoming DB snapshot — incoming wins when same or newer.
  for (const it of items) {
    if (!it?.pub_id) continue;
    const id = String(it.pub_id);
    const ts = parsePublicationTs(it);
    if (ts < cutoff) continue;
    const next = { ...it, sort_ts: ts, kv_updated_at: now };
    const prevIt = byId.get(id);
    if (!prevIt || ts >= parsePublicationTs(prevIt)) byId.set(id, next);
  }

  const active = Array.from(byId.values())
    .sort((a, b) => (b.sort_ts || 0) - (a.sort_ts || 0));

  // Archive items that dropped out of the active set.
  const archive = Array.isArray(prev.archive) ? [...prev.archive] : [];
  const activeIds = new Set(active.map((it) => String(it.pub_id)));
  for (const it of (prev.items || [])) {
    if (!it?.pub_id) continue;
    const id = String(it.pub_id);
    if (activeIds.has(id)) continue;
    archive.push({ ...it, archived_at: now });
  }
  const trimmedArchive = archive
    .sort((a, b) => (b.sort_ts || parsePublicationTs(b) || 0) - (a.sort_ts || parsePublicationTs(a) || 0))
    .slice(0, MAX_ARCHIVE_ITEMS);

  const payload = {
    items: active,
    count: active.length,
    lookback_days: lookbackDays,
    updated_at: now,
    freshest_at: active[0]?.sort_ts || null,
    oldest_at: active.length ? active[active.length - 1]?.sort_ts : null,
  };

  await KV.put(RESEARCH_FEED_KV_KEY, JSON.stringify(payload), { expirationTtl: ACTIVE_TTL_SEC });

  if (trimmedArchive.length > 0) {
    await KV.put(RESEARCH_FEED_ARCHIVE_KEY, JSON.stringify({
      items: trimmedArchive,
      count: trimmedArchive.length,
      updated_at: now,
    }), { expirationTtl: ARCHIVE_TTL_SEC });
  }

  return { ok: true, active: active.length, archived: trimmedArchive.length };
}

/** Read cached feed (optional fast path). Returns null if missing/stale. */
export async function loadResearchFeedKv(env) {
  const KV = kvStore(env);
  if (!KV) return null;
  try {
    const raw = await KV.get(RESEARCH_FEED_KV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Dedupe feed rows by pub_id, sort by publication date (newest first).
 */
export function dedupeAndSortFeedItems(items, { lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const cutoff = Date.now() - Math.max(1, lookbackDays) * 86400000;
  const byId = new Map();
  for (const it of (items || [])) {
    if (!it?.pub_id) continue;
    const id = String(it.pub_id);
    const ts = parsePublicationTs(it);
    if (ts < cutoff) continue;
    const prev = byId.get(id);
    if (!prev || ts >= parsePublicationTs(prev)) {
      byId.set(id, { ...it, sort_ts: ts });
    }
  }
  return Array.from(byId.values()).sort((a, b) => (b.sort_ts || 0) - (a.sort_ts || 0));
}
