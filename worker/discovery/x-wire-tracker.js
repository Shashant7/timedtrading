// worker/discovery/x-wire-tracker.js
//
// Phase 3 — Curated X wire-account ingest (<10 handles).
// Polls public timelines via X API v2 (app-only Bearer), stores raw posts
// in D1, fans ticker mentions into ticker_news, and surfaces macro prints
// for the calendar + Daily Brief.
//
// Requires env secret: X_API_BEARER_TOKEN

import { headlineMentionsTicker, ensureTickerNewsSchema } from "./news-tracker.js";

const X_API_BASE = "https://api.x.com/2";
const WATCHLIST_KV = "timed:x:watchlist";
const USER_IDS_KV = "timed:x:user_ids";
const SINCE_ID_PREFIX = "timed:x:since_id:";
const MACRO_ACTUALS_KV = "cro:macro:actuals:xwire";
const FETCH_TIMEOUT_MS = 12_000;

/** Default wire accounts — override via KV `timed:x:watchlist`. */
export const DEFAULT_X_WATCHLIST = [
  { handle: "DeItaone", kind: "macro_wire", reason: "objective real-time news (Walter Bloomberg)" },
  { handle: "ripster47", kind: "inspiration", reason: "Ripster — trade style inspiration" },
  { handle: "TrendSpider", kind: "general", reason: "general market / platform context" },
  { handle: "satymahajan", kind: "inspiration", reason: "Saty — swing and day trade inspiration" },
  { handle: "Desi_Trade", kind: "speculative", reason: "Vincent Desiano — minimal speculative ideas" },
  { handle: "fundstrat", kind: "fsd_leader", reason: "Tom Lee / Fundstrat — FSD research leader" },
  { handle: "MarkNewtonCMT", kind: "technical", reason: "Mark Newton CMT — technical expert" },
];

const MACRO_RELEASE_RE = /\b(US\s+)?([A-Z][A-Z\s\-]{2,40}?)\s+([\d.,]+[KMB%]?)\s*(?:;|,|\s)\s*(?:EST\.?|ESTIMATE|EXP\.?|VS\.?)\s*([\d.,]+[KMB%]?)/i;
const LEVEL_RE = /\b(support|resistance|breaks?|holds?|rejects?|above|below|at)\s+(?:the\s+)?\$?([\d]{2,5}(?:\.\d{1,2})?)\b/gi;
const CASHTAG_RE = /\$([A-Z]{1,5})\b/g;

function normHandle(h) {
  return String(h || "").replace(/^@/, "").trim();
}

function bearerToken(env) {
  return String(env?.X_API_BEARER_TOKEN || "").trim() || null;
}

export async function ensureXWireSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS x_wire_posts (
        post_id            TEXT PRIMARY KEY,
        handle             TEXT NOT NULL,
        kind               TEXT,
        text               TEXT NOT NULL,
        created_at         TEXT,
        url                TEXT,
        tickers_json       TEXT,
        levels_json        TEXT,
        macro_json         TEXT,
        fanout_news_count  INTEGER DEFAULT 0,
        ingested_at        INTEGER NOT NULL
      )
    `).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_x_wire_handle_time ON x_wire_posts (handle, created_at DESC)`,
    ).run();
    await db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_x_wire_ingested ON x_wire_posts (ingested_at DESC)`,
    ).run();
  } catch (e) {
    console.warn("[X_WIRE] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

export async function loadWatchlist(env) {
  const kv = env?.KV_TIMED || env?.KV;
  try {
    const raw = await kv?.get(WATCHLIST_KV);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((row) => ({
          handle: normHandle(row.handle),
          kind: String(row.kind || "wire").slice(0, 32),
        })).filter((r) => r.handle);
      }
    }
  } catch (_) { /* fall through */ }
  return DEFAULT_X_WATCHLIST.map((r) => ({ ...r, handle: normHandle(r.handle) }));
}

export async function saveWatchlist(env, accounts) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv || !Array.isArray(accounts)) return { ok: false, error: "invalid_watchlist" };
  const cleaned = accounts.map((row) => ({
    handle: normHandle(row.handle),
    kind: String(row.kind || "wire").slice(0, 32),
    reason: row.reason ? String(row.reason).slice(0, 200) : null,
  })).filter((r) => r.handle).slice(0, 12);
  if (cleaned.length === 0) return { ok: false, error: "empty_watchlist" };
  await kv.put(WATCHLIST_KV, JSON.stringify(cleaned));
  return { ok: true, count: cleaned.length, accounts: cleaned };
}

async function xFetch(url, token) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: json?.detail || json?.title || `x_${resp.status}`, json };
    }
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  } finally {
    clearTimeout(tid);
  }
}

async function loadUserIdCache(env) {
  const kv = env?.KV_TIMED || env?.KV;
  try {
    const raw = await kv?.get(USER_IDS_KV);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

async function saveUserIdCache(env, cache) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return;
  try { await kv.put(USER_IDS_KV, JSON.stringify(cache)); } catch (_) {}
}

export async function resolveUserId(env, handle, token) {
  const h = normHandle(handle);
  if (!h || !token) return null;
  const cache = await loadUserIdCache(env);
  if (cache[h]) return cache[h];
  const url = `${X_API_BASE}/users/by/username/${encodeURIComponent(h)}?user.fields=id,username`;
  const r = await xFetch(url, token);
  const id = r.ok ? String(r.json?.data?.id || "") : "";
  if (!id) return null;
  cache[h] = id;
  await saveUserIdCache(env, cache);
  return id;
}

/** Extract cashtags and bare index tickers from post text. */
export function extractTickersFromText(text, opts = {}) {
  const max = Math.max(1, Math.min(20, Number(opts.max) || 12));
  const allow = new Set([
    ...(opts.allowlist || []),
    "SPY", "QQQ", "IWM", "DIA", "VIX", "TLT", "GLD", "USO", "HYG",
  ].map((s) => String(s).toUpperCase()));
  const found = new Set();
  const blob = String(text || "");
  for (const m of blob.matchAll(CASHTAG_RE)) {
    const sym = String(m[1] || "").toUpperCase();
    if (sym.length >= 1 && sym.length <= 5) found.add(sym);
  }
  // Bare mega-cap / index mentions without $
  for (const sym of ["SPY", "QQQ", "IWM", "NVDA", "AAPL", "MSFT", "TSLA", "AMD", "META", "AMZN", "GOOGL"]) {
    const re = new RegExp(`\\b${sym}\\b`, "i");
    if (re.test(blob)) found.add(sym);
  }
  const out = [...found];
  if (allow.size > 10) {
    return out.filter((s) => allow.has(s) || found.has(s)).slice(0, max);
  }
  return out.slice(0, max);
}

/** DeItaone-style macro print: "US MAY JOB OPENINGS 7.594M; EST. 7.296M" */
export function parseMacroFromText(text) {
  const blob = String(text || "").trim();
  if (!blob) return null;
  const m = blob.match(MACRO_RELEASE_RE);
  if (!m) return null;
  const event = String(m[2] || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const actual = String(m[3] || "").trim();
  const estimate = String(m[4] || "").trim();
  if (!event || !actual) return null;
  return {
    event_name: event,
    actual,
    estimate: estimate || null,
    source_text: blob.slice(0, 280),
  };
}

/** Pull numeric levels from trader-style posts. */
export function extractLevelsFromText(text, opts = {}) {
  const max = Math.max(1, Math.min(10, Number(opts.max) || 6));
  const blob = String(text || "");
  const levels = [];
  for (const m of blob.matchAll(LEVEL_RE)) {
    const kind = String(m[1] || "").toLowerCase();
    const price = Number(m[2]);
    if (!Number.isFinite(price) || price <= 0) continue;
    levels.push({ kind, price, raw: m[0] });
    if (levels.length >= max) break;
  }
  return levels;
}

async function getSinceId(env, handle) {
  const kv = env?.KV_TIMED || env?.KV;
  try {
    return await kv?.get(`${SINCE_ID_PREFIX}${normHandle(handle)}`) || null;
  } catch (_) {
    return null;
  }
}

async function setSinceId(env, handle, postId) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv || !postId) return;
  try {
    await kv.put(`${SINCE_ID_PREFIX}${normHandle(handle)}`, String(postId));
  } catch (_) {}
}

async function fetchTimeline(env, userId, sinceId, token, opts = {}) {
  const max = Math.max(5, Math.min(20, Number(opts.maxResults) || 10));
  const params = new URLSearchParams({
    "max_results": String(max),
    "tweet.fields": "created_at,text,author_id",
    "exclude": "retweets,replies",
  });
  if (sinceId) params.set("since_id", String(sinceId));
  const url = `${X_API_BASE}/users/${encodeURIComponent(userId)}/tweets?${params}`;
  return xFetch(url, token);
}

async function persistPost(env, row) {
  const db = env?.DB;
  if (!db || !row?.post_id) return false;
  try {
    const result = await db.prepare(`
      INSERT OR IGNORE INTO x_wire_posts
        (post_id, handle, kind, text, created_at, url, tickers_json, levels_json,
         macro_json, fanout_news_count, ingested_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
    `).bind(
      row.post_id, row.handle, row.kind, row.text, row.created_at, row.url,
      row.tickers_json, row.levels_json, row.macro_json,
      row.fanout_news_count || 0, row.ingested_at,
    ).run();
    return (result?.meta?.changes || 0) > 0;
  } catch (e) {
    console.warn(`[X_WIRE] persist failed ${row.post_id}:`, String(e?.message || e).slice(0, 150));
    return false;
  }
}

async function fanOutToTickerNews(env, post, tickers) {
  const db = env?.DB;
  if (!db || !Array.isArray(tickers) || tickers.length === 0) return 0;
  const headline = String(post.text || "").trim().slice(0, 500);
  const url = post.url || `https://x.com/i/status/${post.post_id}`;
  const source = `@${normHandle(post.handle)}`;
  const summary = `X wire (${post.kind || "wire"})`;
  const dtIso = post.created_at || new Date().toISOString();
  const now = Date.now();
  let count = 0;
  for (const sym of tickers) {
    const t = String(sym || "").toUpperCase();
    if (!t || !headlineMentionsTicker(headline, null, t)) continue;
    try {
      await db.prepare(`
        INSERT OR IGNORE INTO ticker_news
          (ticker, headline, source, url, summary, datetime_utc,
           sentiment, catalyst_strength, is_catalyst, scored_at, scored_by, created_at)
        VALUES (?1,?2,?3,?4,?5,?6, NULL,NULL,NULL,NULL,NULL,?7)
      `).bind(t, headline, source, url, summary, dtIso, now).run();
      count += 1;
    } catch (_) { /* unique collision */ }
  }
  return count;
}

async function persistMacroActual(env, macro, meta = {}) {
  if (!macro?.event_name || !macro?.actual) return false;
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return false;
  const key = String(macro.event_name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 48);
  if (!key) return false;
  let store = { byKey: {}, updated_at: Date.now() };
  try {
    const raw = await kv.get(MACRO_ACTUALS_KV);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.byKey) store = parsed;
  } catch (_) { /* fresh store */ }
  store.byKey[key] = {
    key,
    event_name: macro.event_name,
    actual: macro.actual,
    estimate: macro.estimate || null,
    handle: meta.handle || null,
    post_id: meta.post_id || null,
    refreshed_at: Date.now(),
  };
  store.updated_at = Date.now();
  try {
    await kv.put(MACRO_ACTUALS_KV, JSON.stringify(store));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Poll all watchlist accounts, persist new posts, fan out to ticker_news.
 */
export async function fetchAndStoreWirePosts(env, opts = {}) {
  const token = bearerToken(env);
  if (!token) return { ok: false, error: "no_x_api_bearer_token" };
  await ensureXWireSchema(env);
  await ensureTickerNewsSchema(env);
  const watchlist = opts.accounts || await loadWatchlist(env);
  if (!Array.isArray(watchlist) || watchlist.length === 0) {
    return { ok: false, error: "empty_watchlist" };
  }
  const interDelayMs = Math.max(0, Number(opts.delayMs) || 350);
  let fetched = 0, persisted = 0, fanout = 0, macroHits = 0, errors = 0;
  const perHandle = {};

  for (let i = 0; i < watchlist.length; i++) {
    const { handle, kind } = watchlist[i];
    const h = normHandle(handle);
    if (!h) continue;
    const userId = await resolveUserId(env, h, token);
    if (!userId) {
      errors += 1;
      perHandle[h] = { error: "user_lookup_failed" };
      continue;
    }
    const sinceId = await getSinceId(env, h);
    const tl = await fetchTimeline(env, userId, sinceId, token, opts);
    if (!tl.ok) {
      errors += 1;
      perHandle[h] = { error: tl.error || tl.status || "timeline_failed" };
      if (interDelayMs > 0 && i < watchlist.length - 1) {
        await new Promise((r) => setTimeout(r, interDelayMs));
      }
      continue;
    }
    const tweets = Array.isArray(tl.json?.data) ? tl.json.data : [];
    fetched += tweets.length;
    // API returns newest-first; process oldest-first so since_id advances correctly.
    const ordered = tweets.slice().reverse();
    let newestId = sinceId;
    let handlePersisted = 0;
    let handleFanout = 0;
    for (const tw of ordered) {
      const postId = String(tw.id || "");
      const text = String(tw.text || "").trim();
      if (!postId || !text) continue;
      newestId = postId;
      const tickers = extractTickersFromText(text);
      const levels = extractLevelsFromText(text);
      const macro = parseMacroFromText(text);
      const row = {
        post_id: postId,
        handle: h,
        kind: kind || "wire",
        text: text.slice(0, 2000),
        created_at: tw.created_at || null,
        url: `https://x.com/${h}/status/${postId}`,
        tickers_json: JSON.stringify(tickers),
        levels_json: levels.length ? JSON.stringify(levels) : null,
        macro_json: macro ? JSON.stringify(macro) : null,
        ingested_at: Date.now(),
      };
      const didPersist = await persistPost(env, row);
      if (didPersist) {
        persisted += 1;
        handlePersisted += 1;
        const fc = await fanOutToTickerNews(env, row, tickers);
        fanout += fc;
        handleFanout += fc;
        if (macro && await persistMacroActual(env, macro, { handle: h, post_id: postId })) {
          macroHits += 1;
        }
      }
    }
    if (newestId && newestId !== sinceId) {
      await setSinceId(env, h, newestId);
    }
    perHandle[h] = {
      fetched: tweets.length,
      persisted: handlePersisted,
      fanout: handleFanout,
      since_id: sinceId || null,
      newest_id: newestId || sinceId || null,
    };
    if (interDelayMs > 0 && i < watchlist.length - 1) {
      await new Promise((r) => setTimeout(r, interDelayMs));
    }
  }

  return {
    ok: true,
    accounts: watchlist.length,
    fetched,
    persisted,
    fanout,
    macro_hits: macroHits,
    errors,
    per_handle: perHandle,
    fetched_at: Date.now(),
  };
}

/** Recent wire posts for admin preview / brief enrichment. */
export async function loadRecentWirePosts(env, opts = {}) {
  const db = env?.DB;
  if (!db) return [];
  const lookbackHours = Math.max(1, Math.min(168, Number(opts.lookbackHours) || 48));
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 30));
  const handle = normHandle(opts.handle || "");
  const cutoff = new Date(Date.now() - lookbackHours * 3600000).toISOString();
  try {
    const rows = handle
      ? (await db.prepare(`
          SELECT post_id, handle, kind, text, created_at, url, tickers_json, levels_json, macro_json, ingested_at
            FROM x_wire_posts
           WHERE handle = ?1 AND (created_at >= ?2 OR ingested_at >= ?3)
           ORDER BY COALESCE(created_at, '') DESC, ingested_at DESC
           LIMIT ?4
        `).bind(handle, cutoff, Date.now() - lookbackHours * 3600000, limit).all().catch(() => ({ results: [] })))?.results || []
      : (await db.prepare(`
          SELECT post_id, handle, kind, text, created_at, url, tickers_json, levels_json, macro_json, ingested_at
            FROM x_wire_posts
           WHERE created_at >= ?1 OR ingested_at >= ?2
           ORDER BY COALESCE(created_at, '') DESC, ingested_at DESC
           LIMIT ?3
        `).bind(cutoff, Date.now() - lookbackHours * 3600000, limit).all().catch(() => ({ results: [] })))?.results || [];
    return rows;
  } catch (_) {
    return [];
  }
}

/** Headlines shaped like Finnhub econ news for Daily Brief prompt injection. */
export async function loadWireHeadlinesForBrief(env, opts = {}) {
  const rows = await loadRecentWirePosts(env, { lookbackHours: opts.lookbackHours || 36, limit: opts.limit || 20 });
  return rows.map((r) => ({
    headline: String(r.text || "").slice(0, 280),
    summary: r.macro_json ? "macro print" : (r.levels_json ? "levels" : "wire"),
    source: `@${r.handle}`,
    created_at: r.created_at || new Date(r.ingested_at || Date.now()).toISOString(),
    url: r.url,
    kind: r.kind,
  }));
}

async function loadMacroActualsStore(env) {
  const kv = env?.KV_TIMED || env?.KV;
  try {
    const raw = await kv?.get(MACRO_ACTUALS_KV);
    const parsed = raw ? JSON.parse(raw) : null;
    return (parsed && parsed.byKey) ? parsed.byKey : {};
  } catch (_) {
    return {};
  }
}

/** Apply X-wire macro actuals onto calendar events (after FRED layer). */
export async function applyXWireMacroActuals(env, events, todayStr) {
  const byKey = await loadMacroActualsStore(env);
  if (!byKey || Object.keys(byKey).length === 0) return events;
  const today = todayStr || new Date().toISOString().slice(0, 10);
  for (const e of events) {
    if (!e || e.actual || !e.date || e.date > today) continue;
    const name = String(e.name || "").toLowerCase();
    for (const entry of Object.values(byKey)) {
      const evName = String(entry.event_name || "").toLowerCase();
      if (!evName || evName.length < 4) continue;
      // Fuzzy: wire "MAY JOB OPENINGS" matches curated "May JOLTS Job Openings"
      const tokens = evName.split(/\s+/).filter((t) => t.length > 3);
      const hits = tokens.filter((t) => name.includes(t)).length;
      if (hits >= Math.min(2, tokens.length)) {
        e.actual = entry.actual;
        e.estimate = e.estimate || entry.estimate || null;
        e.actual_source = "x_wire";
        break;
      }
    }
  }
  return events;
}
