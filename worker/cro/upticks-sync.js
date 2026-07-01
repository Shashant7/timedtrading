// worker/cro/upticks-sync.js
// Parse Newton "Upticks" monthly publications and sync timed:admin:upticks.

import { kvGetJSON, kvPutJSON } from "../storage.js";
import { onboardTicker } from "../onboard-ticker.js";
import { SECTOR_MAP } from "../sector-mapping.js";

export const UPTICKS_KV_KEY = "timed:admin:upticks";

const TICKER_RE = /\$([A-Z]{1,5}(?:-[A-Z]{1,2})?)\b/g;

function normalizeTicker(sym) {
  const t = String(sym || "").toUpperCase().trim();
  if (!t || !/^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(t)) return null;
  return t;
}

function extractTickersFromSection(section) {
  if (!section) return [];
  const out = new Set();
  for (const m of String(section).matchAll(TICKER_RE)) {
    const t = normalizeTicker(m[1]);
    if (t) out.add(t);
  }
  return [...out];
}

/** True when title/body looks like the monthly Upticks list update. */
export function isUpticksPublication(title, text = "") {
  const t = String(title || "").trim();
  if (/^Upticks\s*[–-]/i.test(t) || /\bUpticks\s*[–-]\s*\w+/i.test(t)) return true;
  const body = String(text || "");
  return /Upticks\s+Additions/i.test(body) && /(?:Upticks\s+Deletions|Deletions:)/i.test(body);
}

/**
 * Parse additions/removals from an Upticks publication body.
 * Returns { added, removed, source: "sections"|"commentary"|"mixed" }.
 */
export function parseUpticksChanges(text) {
  const body = String(text || "").replace(/\s+/g, " ").trim();
  if (!body) return { added: [], removed: [], source: "empty" };

  let added = [];
  let removed = [];
  let source = "sections";

  const addMatch = body.match(
    /Upticks?\s+Additions([\s\S]*?)(?:Upticks?\s+Deletions|Deletions:)/i,
  );
  const delMatch = body.match(
    /(?:Upticks?\s+Deletions|Deletions:)([\s\S]*?)(?:UPTICKS Total Return|Upticks One Month|Upticks Commentary|ADDITIONS\s*:|Three additions)/i,
  );

  if (addMatch || delMatch) {
    added = extractTickersFromSection(addMatch?.[1] || "");
    removed = extractTickersFromSection(delMatch?.[1] || "");
  }

  const commentary = body.match(
    /Three additions:\s*((?:\$[A-Z]{1,5}(?:-[A-Z]{1,2})?\s*,?\s*(?:and\s*)?)+).*?subtractions:\s*((?:\$[A-Z]{1,5}(?:-[A-Z]{1,2})?\s*,?\s*(?:and\s*)?)+)/i,
  );
  if (commentary) {
    const cAdded = extractTickersFromSection(commentary[1]);
    const cRemoved = extractTickersFromSection(commentary[2]);
    if (cAdded.length) added = [...new Set([...added, ...cAdded])];
    if (cRemoved.length) removed = [...new Set([...removed, ...cRemoved])];
    source = addMatch || delMatch ? "mixed" : "commentary";
  }

  return {
    added: [...new Set(added)],
    removed: [...new Set(removed)],
    source,
  };
}

async function updateTickerSources(KV, tickerOrTickers, source) {
  if (!KV) return;
  try {
    const sources = (await kvGetJSON(KV, "timed:ticker-sources")) || {};
    const tickers = Array.isArray(tickerOrTickers) ? tickerOrTickers : [tickerOrTickers];
    for (const t of tickers) {
      const sym = String(t).toUpperCase();
      if (!sources[sym]) sources[sym] = [];
      if (!sources[sym].includes(source)) sources[sym].push(source);
    }
    await kvPutJSON(KV, "timed:ticker-sources", sources);
  } catch (_) { /* best-effort */ }
}

async function ensureTickerInIndex(KV, ticker) {
  if (!KV || !ticker) return false;
  try {
    const blocklist = (await kvGetJSON(KV, "timed:removed")) || [];
    if (Array.isArray(blocklist) && blocklist.includes(ticker)) return false;
    const cur = (await kvGetJSON(KV, "timed:tickers")) || [];
    if (cur.includes(ticker)) return false;
    cur.push(ticker);
    cur.sort();
    await kvPutJSON(KV, "timed:tickers", cur);
    return true;
  } catch (_) {
    return false;
  }
}

async function logUpticksDiff(env, { prior, next, added, removed, pubId }) {
  if (!env?.DB || (added.length === 0 && removed.length === 0)) return;
  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO etf_rebalance_history
        (etf_symbol, snapshot_date, captured_at, source_label,
         ticker_count, diff_added_json, diff_removed_json,
         diff_reweighted_json, is_rebalance)
      VALUES ('UPTICKS', ?1, ?2, ?3, ?4, ?5, ?6, NULL, 0)
    `).bind(
      new Date().toISOString().slice(0, 10),
      Date.now(),
      pubId ? `upticks_pub_${pubId}` : "upticks_auto_sync",
      next.length,
      JSON.stringify(added.map((t) => ({ ticker: t }))),
      JSON.stringify(removed.map((t) => ({ ticker: t }))),
    ).run();
  } catch (_) { /* best-effort */ }
}

/**
 * Apply parsed Upticks diff to KV list (+ index/onboard for additions).
 * Idempotent when list already matches.
 */
export async function applyUpticksListChanges(env, { added = [], removed = [], pubId = null, ctx = null } = {}) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return { ok: false, error_kind: "no_kv" };

  const addSet = new Set((added || []).map(normalizeTicker).filter(Boolean));
  const removeSet = new Set((removed || []).map(normalizeTicker).filter(Boolean));
  for (const t of removeSet) addSet.delete(t);

  const priorList = (await kvGetJSON(KV, UPTICKS_KV_KEY)) || [];
  const prior = Array.isArray(priorList) ? priorList.map((t) => String(t).toUpperCase()) : [];
  const priorSet = new Set(prior);

  const nextSet = new Set(prior);
  for (const t of addSet) nextSet.add(t);
  for (const t of removeSet) nextSet.delete(t);
  const next = [...nextSet].sort();

  const appliedAdded = [...addSet].filter((t) => !priorSet.has(t));
  const appliedRemoved = prior.filter((t) => removeSet.has(t));

  if (appliedAdded.length === 0 && appliedRemoved.length === 0
      && addSet.size === 0 && removeSet.size === 0) {
    return { ok: true, skipped: "no_changes_parsed", prior_count: prior.length, next_count: prior.length, tickers: prior };
  }

  const unchanged = prior.length === next.length && prior.every((t, i) => t === next[i]);
  if (unchanged) {
    return {
      ok: true,
      skipped: "already_current",
      prior_count: prior.length,
      next_count: next.length,
      tickers: next,
      diff: { added: appliedAdded, removed: appliedRemoved },
    };
  }

  await kvPutJSON(KV, UPTICKS_KV_KEY, next);
  await updateTickerSources(KV, next, "UPTICKS");
  await logUpticksDiff(env, {
    prior, next, added: appliedAdded, removed: appliedRemoved, pubId,
  });

  const indexAdded = [];
  for (const t of appliedAdded) {
    const wasNew = await ensureTickerInIndex(KV, t);
    if (wasNew) indexAdded.push(t);
    if (!SECTOR_MAP[t]) {
      try {
        await KV.put(`timed:sector_map:${t}`, "Unknown");
      } catch (_) { /* best-effort */ }
    }
  }

  const onboard = async () => {
    for (const t of appliedAdded) {
      try {
        await onboardTicker(env, t, { sinceDays: 730 });
      } catch (e) {
        console.warn(`[UPTICKS_SYNC] onboard failed ${t}: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
  };
  if (appliedAdded.length > 0) {
    if (ctx?.waitUntil) ctx.waitUntil(onboard());
    else await onboard();
  }

  return {
    ok: true,
    pub_id: pubId || null,
    prior_count: prior.length,
    next_count: next.length,
    tickers: next,
    diff: {
      added: appliedAdded,
      removed: appliedRemoved,
      added_count: appliedAdded.length,
      removed_count: appliedRemoved.length,
    },
    index_added: indexAdded,
  };
}

/** Load publication text and sync Upticks list when applicable. */
export async function syncUpticksFromPublication(env, pubId, { title = null, ctx = null, force = false } = {}) {
  const id = String(pubId || "").trim();
  if (!id || !env?.DB) return { ok: false, error_kind: "missing_pub_or_db" };

  let meta = null;
  if (title) meta = { title };
  else {
    meta = await env.DB.prepare(
      `SELECT title FROM cro_publications WHERE pub_id = ?1`,
    ).bind(id).first().catch(() => null);
  }

  const textRow = await env.DB.prepare(
    `SELECT text_full FROM cro_publication_text WHERE pub_id = ?1`,
  ).bind(id).first().catch(() => null);
  const text = textRow?.text_full || "";
  const pubTitle = meta?.title || "";

  if (!force && !isUpticksPublication(pubTitle, text)) {
    return { ok: true, skipped: "not_upticks_publication", pub_id: id };
  }

  const parsed = parseUpticksChanges(text);
  if (parsed.added.length === 0 && parsed.removed.length === 0) {
    return { ok: false, error_kind: "parse_empty", pub_id: id, title: pubTitle };
  }

  const applied = await applyUpticksListChanges(env, {
    added: parsed.added,
    removed: parsed.removed,
    pubId: id,
    ctx,
  });

  return {
    ...applied,
    parsed,
    title: pubTitle,
  };
}
