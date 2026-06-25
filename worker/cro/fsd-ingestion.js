// worker/cro/fsd-ingestion.js
// ─────────────────────────────────────────────────────────────────────────────
//  Ingestion orchestration for Fundstrat Direct publications.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Owns:
//    • The D1 schema for cro_publications + cro_publication_text
//    • The "have we already ingested this?" diff logic
//    • End-to-end "list → fetch → extract text → persist" flow
//    • Manual ingest path (operator pastes a URL or uploads a PDF blob)
//
//  Doesn't own:
//    • The login + HTTP layer (worker/cro/fsd-client.js)
//    • The LLM extraction → playbook proposal (worker/cro/fsd-extractor.js)
//    • The apply path (worker/cro/cro-apply.js)
//
//  Designed so the LLM-extraction step can run on a SEPARATE invocation
//  from the fetch — fetch is cheap and the operator may want to ingest
//  many at once but extract only a subset.

import { listFSDPublications, fetchFSDPublication, isGarbageFsdText } from "./fsd-client.js";

const PUBLICATIONS_TABLE = "cro_publications";
const PUBLICATION_TEXT_TABLE = "cro_publication_text";
const PUBLICATION_TICKERS_TABLE = "cro_publication_tickers";

// 2026-06-03 — FlashInsight bodies use $TICKER cashtag notation
// extensively ("$GOOGL $80 billion capital raise..."). Parse them to
// power per-ticker FSD intel surfacing on the Catalysts tab.
//
// Rules:
//   - $ABC → ABC (2-5 uppercase letters; matches ETF + stock conventions)
//   - $ABC.B → ABC.B (Berkshire-style class B suffixes)
//   - Skip a curated noise list (common false positives like $USD, $SPX
//     when they are macro references and we want per-equity surfacing).
// Returns deduped uppercased tickers in order of first appearance.
const CASHTAG_NOISE = new Set([
  "USD", "EUR", "GBP", "JPY", "CNY", "CHF", "CAD", "AUD",
  "INR", "BRL", "RUB", "KRW", "MXN", "HKD", "SGD", "TWD", "ZAR",
  // common chart-tag noise — keep if you want them per-ticker, drop if
  // you don't. We keep SPX/QQQ/SPY because FSD references them often
  // in equity-relevant context.
  "WTI", "WTIC", "DXY", "VIX",
]);

const CASHTAG_RE = /\$([A-Z][A-Z0-9]{0,4}(?:\.[A-Z])?)\b/g;
// 2026-06-03 — Also match the paren-form "(TICKER)" pattern. FSD posts often
// write "Alphabet (GOOGL)" or "Nvidia (NVDA)" instead of $-tagged cashtags,
// and the Catalysts panel was returning zero hits on those names. Operator
// reported repeatedly: "I don't see the FSD insights for GOOGL". This regex
// matches a 2–5 char uppercase token wrapped in parens — very high-signal
// in financial publication prose and almost never a false positive.
const PAREN_TICKER_RE = /\(([A-Z][A-Z0-9]{1,4})\)/g;
// FSD prose often writes "^SPX", "SPX", or "US500" without a cashtag.
const INDEX_MENTION_RE = /\^?(SPX500|US500|SPX)\b/gi;

// 2026-06-11 — SPX is a cash index (removed from the tradable universe).
// Research desk mentions still matter for the instruments we score/trade.
export const RESEARCH_DESK_INDEX_ALIASES = {
  SPX: ["SPY", "ES1!", "ES"],
  SPX500: ["SPY", "ES1!", "ES"],
  US500: ["SPY", "ES1!", "ES"],
};

/** Expand index tokens (SPX) to tradeable proxies when tagging publications. */
export function expandResearchDeskTickerTags(tickers) {
  const out = [];
  const seen = new Set();
  for (const raw of tickers || []) {
    const t = String(raw || "").toUpperCase().trim();
    if (!t) continue;
    const push = (sym) => {
      if (!sym || seen.has(sym)) return;
      seen.add(sym);
      out.push(sym);
    };
    push(t);
    for (const alias of RESEARCH_DESK_INDEX_ALIASES[t] || []) push(alias);
  }
  return out;
}

/** DB lookup keys for FSD intel — includes index sources that map to sym. */
export function researchDeskIntelQueryTickers(ticker) {
  const sym = String(ticker || "").toUpperCase().trim();
  if (!sym) return [];
  const indexSources = Object.entries(RESEARCH_DESK_INDEX_ALIASES)
    .filter(([, targets]) => targets.includes(sym))
    .map(([src]) => src);
  return [...new Set([sym, ...indexSources])];
}

function textMentionsIndexToken(blob, token) {
  const tok = String(token || "").toUpperCase();
  if (!tok) return false;
  const re = new RegExp(`(?:\\^${tok}\\b|\\$${tok}\\b|\\(${tok}\\)|\\b${tok}\\b)`, "i");
  return re.test(blob);
}

/** True when title or excerpt actually references the requested ticker. */
export function publicationMentionsTicker(title, excerpt, ticker) {
  const sym = String(ticker || "").toUpperCase().trim();
  if (!sym) return false;
  const blob = `${title || ""}\n${excerpt || ""}`;
  if (!blob.trim()) return false;
  // Cashtag, parenthetical, or bare uppercase token with word boundaries.
  const re = new RegExp(`(?:\\$${sym}\\b|\\(${sym}\\)|\\b${sym}\\b)`, "i");
  if (re.test(blob)) return true;
  // SPX cash-index mentions surface on SPY / ES / ES1! Catalysts panels.
  const indexSources = Object.entries(RESEARCH_DESK_INDEX_ALIASES)
    .filter(([, targets]) => targets.includes(sym))
    .map(([src]) => src);
  return indexSources.some((src) => textMentionsIndexToken(blob, src));
}

export function extractCashtagsFromText(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const sym = String(t || "").toUpperCase().trim();
    if (sym.length < 2) return;
    if (CASHTAG_NOISE.has(sym)) return;
    if (seen.has(sym)) return;
    seen.add(sym);
    out.push(sym);
  };
  let m;
  CASHTAG_RE.lastIndex = 0;
  while ((m = CASHTAG_RE.exec(text)) !== null) push(m[1]);
  PAREN_TICKER_RE.lastIndex = 0;
  while ((m = PAREN_TICKER_RE.exec(text)) !== null) push(m[1]);
  INDEX_MENTION_RE.lastIndex = 0;
  while ((m = INDEX_MENTION_RE.exec(text)) !== null) {
    const raw = String(m[1] || "").toUpperCase();
    push(raw === "SPX500" ? "SPX500" : raw === "US500" ? "US500" : "SPX");
  }
  return expandResearchDeskTickerTags(out);
}

// ── Schema ────────────────────────────────────────────────────────────────────
export async function ensureCROIngestionSchema(env) {
  const db = env?.DB;
  if (!db) return;
  try {
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${PUBLICATIONS_TABLE} (
        pub_id              TEXT PRIMARY KEY,
        title               TEXT,
        source              TEXT NOT NULL,
        source_url          TEXT NOT NULL,
        published_at        TEXT,
        fetched_at          INTEGER NOT NULL,
        content_type        TEXT,
        bytes_len           INTEGER,
        fetch_status        TEXT NOT NULL,
        fetch_error         TEXT,
        extracted_at        INTEGER,
        proposal_id         TEXT,
        applied_at          INTEGER
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_${PUBLICATIONS_TABLE}_fetched_at
      ON ${PUBLICATIONS_TABLE} (fetched_at DESC)
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_${PUBLICATIONS_TABLE}_source
      ON ${PUBLICATIONS_TABLE} (source, fetched_at DESC)
    `).run();
    // 2026-06-04 — Persist the WP post type (post / fsi-alert / fsi-alert-crypto)
    // so categorization (FlashInsight vs long-form note) is durable rather than
    // inferred from the URL. ALTER guarded for idempotency (no IF NOT EXISTS).
    try { await db.prepare(`ALTER TABLE ${PUBLICATIONS_TABLE} ADD COLUMN post_type TEXT`).run(); } catch (_) {}
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${PUBLICATION_TEXT_TABLE} (
        pub_id              TEXT PRIMARY KEY,
        text_excerpt        TEXT,
        text_full           TEXT,
        char_count          INTEGER,
        stored_at           INTEGER NOT NULL,
        FOREIGN KEY (pub_id) REFERENCES ${PUBLICATIONS_TABLE}(pub_id)
      )
    `).run();
    // 2026-06-03 — Per-ticker tagging for FSD publications. One row per
    // (pub_id, ticker) so a single FlashInsight that mentions GOOGL + QQQ
    // shows up on both tickers' Catalysts tabs.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS ${PUBLICATION_TICKERS_TABLE} (
        pub_id              TEXT NOT NULL,
        ticker              TEXT NOT NULL,
        position            INTEGER,
        tagged_at           INTEGER NOT NULL,
        PRIMARY KEY (pub_id, ticker)
      )
    `).run();
    await db.prepare(`
      CREATE INDEX IF NOT EXISTS idx_${PUBLICATION_TICKERS_TABLE}_ticker
      ON ${PUBLICATION_TICKERS_TABLE} (ticker, tagged_at DESC)
    `).run();
  } catch (e) {
    console.warn("[CRO_INGESTION] schema ensure failed:", String(e?.message || e).slice(0, 200));
  }
}

// ── PDF text extraction ───────────────────────────────────────────────────────
// Cloudflare Workers don't have pypdf. For PDFs we extract a best-effort
// text view using a minimal in-worker parser. Goal: enough text for the
// LLM to summarize — not a perfect render. The vast majority of FSD
// publications are also available as HTML (per design of subscriber sites),
// in which case `fetchFSDPublication` already returns `body_text` and this
// path is skipped.
//
// Strategy: scan the PDF stream for text-bearing operators
// (Tj, TJ, ', ", BT...ET) and emit the literal strings between parens.
// This produces noisy output but is sufficient for an LLM summarizer to
// pick up the rotation calls + sector verdicts. PDFs with content-stream
// encryption or font subsetting that maps to CID will produce gibberish;
// those are rare for editorial publications.
export function extractPdfTextHeuristic(arrayBuf) {
  try {
    const bytes = new Uint8Array(arrayBuf);
    // Latin-1 decode is safe for PDF objects (strings are escaped).
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    const out = [];
    // Match literal string operands of text operators: ( ... ) Tj   or   ( ... ) Tj
    // Also collect array text ops: [ ( ... ) ( ... ) ] TJ
    const reLiteral = /\(((?:\\.|[^()\\])*)\)\s*(?:Tj|'|")/g;
    const reArray = /\[((?:\s*\(((?:\\.|[^()\\])*)\)\s*-?\d*\s*)+)\]\s*TJ/g;
    let m;
    while ((m = reLiteral.exec(s)) !== null) {
      out.push(pdfUnescape(m[1]));
    }
    while ((m = reArray.exec(s)) !== null) {
      const inner = m[1];
      const reInner = /\(((?:\\.|[^()\\])*)\)/g;
      let im;
      while ((im = reInner.exec(inner)) !== null) {
        out.push(pdfUnescape(im[1]));
      }
    }
    // Collapse whitespace + drop very-short fragments (likely glyph noise).
    let text = out.join(" ").replace(/\s+/g, " ");
    return text.trim();
  } catch (e) {
    return "";
  }
}

function pdfUnescape(s) {
  return String(s || "")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

// HTML → readable text (strip tags + collapse whitespace).
// Common WP-rendered chrome strings that occasionally bleed into post
// content via embedded shortcodes or theme bits. We strip the surrounding
// noise so it doesn't pollute the LLM rewriter input.
const FSD_CHROME_NOISE = [
  /Send your questions to the FSI Team[\s\S]*?$/i,
  /Referral Program\s+Gift Cards\s+Merch Store[\s\S]*?$/i,
  /Subscribe to FSI[\s\S]*?$/i,
];

function decodeHtmlEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return "";
      try { return String.fromCodePoint(code); } catch (_) { return ""; }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hx) => {
      const code = parseInt(hx, 16);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return "";
      try { return String.fromCodePoint(code); } catch (_) { return ""; }
    });
}

// Alpine / WP theme strings that leak when the legacy HTML scrape path runs.
const FSD_UI_LEAK_PATTERNS = [
  /\$refs\.[a-zA-Z0-9_.]+/g,
  /\{[^}]*\$refs[^}]*\}/g,
  /x-on:[a-z-]+="[^"]*"/gi,
  /Fundstrat Direct\s*-->\s*/gi,
  /-->\s*⚡\s*\d*/g,
  /Search\s+Search\s+Referral Program[\s\S]{0,400}?Merch Store/gi,
];

/**
 * Clean plain or HTML FSD text for inline Catalysts display and rewriter input.
 * Decodes entities, strips nav/footer chrome, and removes Alpine/JS leaks.
 */
export function sanitizeFsdPlainText(text) {
  if (!text) return "";
  let out = String(text);
  if (/<[a-z][\s\S]*?>/i.test(out)) {
    out = extractHtmlText(out);
  } else {
    out = decodeHtmlEntities(out);
    for (const re of FSD_CHROME_NOISE) out = out.replace(re, "");
    for (const re of FSD_UI_LEAK_PATTERNS) out = out.replace(re, " ");
    out = out.replace(/\s+/g, " ").trim();
  }
  return out;
}

export function extractHtmlText(html) {
  if (!html) return "";
  let out = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ");
  out = decodeHtmlEntities(out);
  // Strip well-known chrome blocks that occasionally leak through.
  for (const re of FSD_CHROME_NOISE) out = out.replace(re, "");
  for (const re of FSD_UI_LEAK_PATTERNS) out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}

// ── Persistence helpers ───────────────────────────────────────────────────────
async function publicationExists(env, pubId) {
  try {
    const row = await env.DB.prepare(
      `SELECT pub_id FROM ${PUBLICATIONS_TABLE} WHERE pub_id = ?`,
    ).bind(pubId).first();
    return !!row;
  } catch (_) { return false; }
}

async function recordPublication(env, row) {
  try {
    // Preserve extraction lineage on re-fetch — INSERT OR REPLACE would
    // otherwise null out extracted_at / proposal_id / applied_at.
    let existing = null;
    if (row.pub_id) {
      try {
        existing = await env.DB.prepare(
          `SELECT extracted_at, proposal_id, applied_at FROM ${PUBLICATIONS_TABLE} WHERE pub_id = ?`,
        ).bind(row.pub_id).first();
      } catch (_) { /* fresh row */ }
    }
    await env.DB.prepare(`
      INSERT OR REPLACE INTO ${PUBLICATIONS_TABLE}
        (pub_id, title, source, source_url, published_at, fetched_at,
         content_type, bytes_len, fetch_status, fetch_error,
         extracted_at, proposal_id, applied_at, post_type)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
    `).bind(
      row.pub_id,
      row.title || null,
      row.source || "fsd",
      row.source_url,
      row.published_at || null,
      row.fetched_at || Date.now(),
      row.content_type || null,
      row.bytes_len || null,
      row.fetch_status,
      row.fetch_error || null,
      row.extracted_at != null ? row.extracted_at : (existing?.extracted_at ?? null),
      row.proposal_id != null ? row.proposal_id : (existing?.proposal_id ?? null),
      row.applied_at != null ? row.applied_at : (existing?.applied_at ?? null),
      row.post_type || null,
    ).run();
  } catch (e) {
    console.warn("[CRO_INGESTION] recordPublication failed:", String(e?.message || e).slice(0, 200));
  }
}

async function recordPublicationText(env, pubId, text) {
  if (!text) return;
  const excerpt = text.slice(0, 4000);
  const full = text.slice(0, 256 * 1024);
  try {
    await env.DB.prepare(`
      INSERT OR REPLACE INTO ${PUBLICATION_TEXT_TABLE}
        (pub_id, text_excerpt, text_full, char_count, stored_at)
      VALUES (?1,?2,?3,?4,?5)
    `).bind(pubId, excerpt, full, text.length, Date.now()).run();
  } catch (e) {
    console.warn("[CRO_INGESTION] recordPublicationText failed:", String(e?.message || e).slice(0, 200));
  }
  // Cashtag extraction — best-effort, never blocks the text write.
  try {
    await writePublicationTickerTags(env, pubId, extractCashtagsFromText(text));
  } catch (e) {
    console.warn("[CRO_INGESTION] cashtag tagging failed:", String(e?.message || e).slice(0, 200));
  }
}

async function writePublicationTickerTags(env, pubId, tickers) {
  const tags = expandResearchDeskTickerTags(tickers);
  if (!tags.length || !env?.DB || !pubId) return 0;
  const now = Date.now();
  for (let i = 0; i < tags.length; i++) {
    try {
      await env.DB.prepare(`
        INSERT OR REPLACE INTO ${PUBLICATION_TICKERS_TABLE}
          (pub_id, ticker, position, tagged_at)
        VALUES (?1, ?2, ?3, ?4)
      `).bind(pubId, tags[i], i, now).run();
    } catch (_) { /* tolerate per-ticker errors */ }
  }
  return tags.length;
}

// ── Per-ticker FSD intel lookup (used by the Catalysts tab) ─────────────────
/**
 * Returns recent FSD publications that mention a given ticker (via cashtag).
 * @param env
 * @param ticker
 * @param opts { limit?, lookbackDays?, includeText? }
 */
export async function loadFSDIntelForTicker(env, ticker, opts = {}) {
  const db = env?.DB;
  if (!db || !ticker) return null;
  const sym = String(ticker).toUpperCase();
  const queryTickers = researchDeskIntelQueryTickers(sym);
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 6));
  const lookbackDays = Math.max(1, Number(opts.lookbackDays) || 14);
  const since = Date.now() - lookbackDays * 86400000;
  try {
    const placeholders = queryTickers.map((_, i) => `?${i + 1}`).join(",");
    const rows = await db.prepare(`
      SELECT p.pub_id, p.title, p.source, p.source_url, p.published_at,
             p.fetched_at, p.proposal_id, p.applied_at, pt.position, pt.ticker AS matched_ticker
        FROM ${PUBLICATION_TICKERS_TABLE} pt
        JOIN ${PUBLICATIONS_TABLE} p ON p.pub_id = pt.pub_id
       WHERE pt.ticker IN (${placeholders})
         AND COALESCE(p.published_at, p.fetched_at) >= ?${queryTickers.length + 1}
       ORDER BY COALESCE(p.published_at, p.fetched_at) DESC
       LIMIT ?${queryTickers.length + 2}
    `).bind(...queryTickers, since, limit).all();
    const seenPub = new Set();
    let publications = (rows?.results || []).map((r) => ({
      pub_id: r.pub_id,
      title: r.title,
      source: r.source,
      source_url: r.source_url,
      published_at: r.published_at,
      fetched_at: r.fetched_at,
      proposal_id: r.proposal_id,
      applied_at: r.applied_at,
      mention_position: r.position,
      matched_ticker: r.matched_ticker || null,
    })).filter((p) => {
      if (seenPub.has(p.pub_id)) return false;
      seenPub.add(p.pub_id);
      return true;
    });
    if (publications.length === 0) {
      return { ticker: sym, count: 0, publications: [], lookback_days: lookbackDays };
    }
    // Optionally enrich with the excerpt for inline display.
    if (opts.includeText !== false) {
      const ids = publications.map((p) => p.pub_id);
      const placeholders = ids.map(() => "?").join(",");
      const textRows = await db.prepare(`
        SELECT pub_id, text_excerpt FROM ${PUBLICATION_TEXT_TABLE} WHERE pub_id IN (${placeholders})
      `).bind(...ids).all();
      const excerptByPub = {};
      for (const r of (textRows?.results || [])) excerptByPub[r.pub_id] = r.text_excerpt;
      for (const p of publications) {
        const raw = excerptByPub[p.pub_id] || "";
        p.excerpt = raw ? sanitizeFsdPlainText(raw).slice(0, 2000) || null : null;
      }
    }
    // Drop cross-tagged pubs (e.g. ETHA article tagged AAPL via macro cashtag scan).
    publications = publications.filter((p) =>
      publicationMentionsTicker(p.title, p.excerpt, sym),
    );
    publications.sort((a, b) => {
      const ta = Number(a.published_at) || Number(a.fetched_at) || 0;
      const tb = Number(b.published_at) || Number(b.fetched_at) || 0;
      return tb - ta;
    });
    const latestPublishedAt = publications.length
      ? (Number(publications[0].published_at) || Number(publications[0].fetched_at) || null)
      : null;
    return {
      ticker: sym,
      count: publications.length,
      lookback_days: lookbackDays,
      latest_published_at: latestPublishedAt,
      publications,
    };
  } catch (e) {
    return { ticker: sym, error: String(e?.message || e).slice(0, 200), publications: [] };
  }
}

// Expand SPX/US500/SPX500 tags on already-tagged pubs so SPY + ES inherit intel.
export async function backfillResearchDeskIndexAliases(env, { limit = 200 } = {}) {
  await ensureCROIngestionSchema(env);
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db" };
  const indexKeys = Object.keys(RESEARCH_DESK_INDEX_ALIASES);
  try {
    const placeholders = indexKeys.map(() => "?").join(",");
    const rows = await db.prepare(`
      SELECT DISTINCT pub_id, ticker
        FROM ${PUBLICATION_TICKERS_TABLE}
       WHERE ticker IN (${placeholders})
       LIMIT ?${indexKeys.length + 1}
    `).bind(...indexKeys, limit).all();
    let totalTags = 0;
    const results = [];
    for (const r of (rows?.results || [])) {
      const tagged = await writePublicationTickerTags(env, r.pub_id, expandResearchDeskTickerTags([r.ticker]));
      totalTags += tagged;
      results.push({ pub_id: r.pub_id, source: r.ticker, tagged });
    }
    return { ok: true, pubs_processed: results.length, total_tags_written: totalTags, results };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

// Backfill cashtag tags for already-ingested pubs that pre-date this code
// path. Used by an admin endpoint so the operator can re-tag historical
// publications without re-ingesting.
export async function backfillCashtagsForExistingPublications(env, { limit = 50 } = {}) {
  await ensureCROIngestionSchema(env);
  const db = env?.DB;
  if (!db) return { ok: false, error_kind: "no_db" };
  try {
    const rows = await db.prepare(`
      SELECT pt.pub_id, pt.text_full
        FROM ${PUBLICATION_TEXT_TABLE} pt
        LEFT JOIN (
          SELECT pub_id, COUNT(*) AS n FROM ${PUBLICATION_TICKERS_TABLE} GROUP BY pub_id
        ) ttc ON ttc.pub_id = pt.pub_id
       WHERE ttc.n IS NULL OR ttc.n = 0
       ORDER BY pt.stored_at DESC LIMIT ?1
    `).bind(limit).all();
    let totalTagged = 0;
    const pubResults = [];
    for (const r of (rows?.results || [])) {
      const tickers = extractCashtagsFromText(r.text_full || "");
      if (tickers.length === 0) {
        pubResults.push({ pub_id: r.pub_id, tagged: 0 });
        continue;
      }
      const tagged = await writePublicationTickerTags(env, r.pub_id, tickers);
      totalTagged += tagged;
      pubResults.push({ pub_id: r.pub_id, tagged, tickers });
    }
    return { ok: true, pubs_processed: pubResults.length, total_tags_written: totalTagged, results: pubResults };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

export async function loadPublicationText(env, pubId) {
  try {
    const row = await env.DB.prepare(
      `SELECT text_excerpt, text_full, char_count FROM ${PUBLICATION_TEXT_TABLE} WHERE pub_id = ?`,
    ).bind(pubId).first();
    return row || null;
  } catch (_) { return null; }
}

export async function listRecentPublications(env, { limit = 20, sourceFilter = null } = {}) {
  try {
    const where = sourceFilter ? `WHERE source = ?` : ``;
    const stmt = env.DB.prepare(
      `SELECT pub_id, title, source, source_url, published_at, fetched_at,
              fetch_status, fetch_error, extracted_at, proposal_id, applied_at, post_type
         FROM ${PUBLICATIONS_TABLE}
         ${where}
         ORDER BY fetched_at DESC LIMIT ?`);
    const rows = sourceFilter
      ? await stmt.bind(sourceFilter, limit).all()
      : await stmt.bind(limit).all();
    return rows?.results || [];
  } catch (_) { return []; }
}

// ── Ingest a single publication (used by both cron + manual paths) ────────────
export async function ingestSinglePublication(env, pub, { reFetch = false } = {}) {
  await ensureCROIngestionSchema(env);
  const exists = await publicationExists(env, pub.id);
  if (exists && !reFetch) {
    return { ok: true, pub_id: pub.id, skipped: "already_ingested" };
  }

  // 2026-06-03 — Prefer the numeric post id (carried through from the
  // listing) over the public source URL. fetchFSDPublication's slug-
  // resolution path only checks /wp/v2/posts and 404s for fsi-alert
  // posts, falling through to the legacy HTML scrape of the public
  // post URL (which grabs FSD's site nav + footer chrome and renders
  // as garbage in the Catalysts tab). Passing the id keeps us on the
  // clean WP REST path that walks fsi-alert + fsi-alert-crypto +
  // posts in turn until the post is found.
  const fetchKey = pub.id && /^\d+$/.test(String(pub.id)) ? pub.id : pub.source_url;
  const fetched = await fetchFSDPublication(env, fetchKey, {
    postTypePath: pub.post_type_path || null,
  });
  if (!fetched.ok) {
    await recordPublication(env, {
      pub_id: pub.id,
      title: pub.title,
      source: "fsd",
      source_url: pub.source_url,
      published_at: pub.published_at,
      fetched_at: Date.now(),
      fetch_status: "error",
      fetch_error: `${fetched.error_kind}: ${fetched.hint || ""}`.slice(0, 500),
      post_type: pub.post_type || null,
    });
    return { ok: false, pub_id: pub.id, error_kind: fetched.error_kind, hint: fetched.hint };
  }

  let text = "";
  const htmlText = fetched.body_text ? extractHtmlText(fetched.body_text) : "";
  const pdfText = fetched.body_bytes ? extractPdfTextHeuristic(fetched.body_bytes) : "";
  if (pdfText && htmlText) {
    // Prefer PDF tables when present (sector allocation decks); keep HTML recap.
    text = pdfText.length >= 800
      ? `${pdfText}\n\n--- HTML RECAP ---\n${htmlText}`
      : `${htmlText}\n\n--- PDF EXTRACT ---\n${pdfText}`;
  } else if (htmlText) {
    text = htmlText;
  } else if (pdfText) {
    text = pdfText;
  }

  await recordPublication(env, {
    pub_id: pub.id,
    title: pub.title,
    source: "fsd",
    source_url: pub.source_url,
    published_at: pub.published_at,
    fetched_at: Date.now(),
    content_type: fetched.content_type || null,
    bytes_len: fetched.body_bytes_len || (text?.length || 0),
    fetch_status: "ok",
    fetch_error: null,
    post_type: pub.post_type || null,
  });
  if (text) {
    text = sanitizeFsdPlainText(text);
    if (isGarbageFsdText(text)) {
      return {
        ok: false,
        pub_id: pub.id,
        error_kind: "garbage_body_text",
        hint: "Extracted text looks like paywall/chrome, not article body. Re-ingest with numeric WP id via wp_rest (not HTML URL scrape).",
      };
    }
    await recordPublicationText(env, pub.id, text);
  }

  // 2026-06-03 — Eager TT-voice rewrite. Previously we waited on a
  // periodic cron pass before the LLM rewrite ran; that left the
  // Catalysts tab showing the raw paraphrased-but-not-yet-blended
  // excerpt for an hour or more. Now every successful ingest triggers
  // the rewriter synchronously so the FSD Intel panel renders TT-voice
  // immediately on the next page render. Best-effort: any rewrite
  // error is logged but does NOT fail the ingest.
  try {
    if (text && text.length > 80) {
      const { rewriteFSDPublication } = await import("./fsd-rewriter.js");
      // Force the rewrite when the operator re-ingested (reFetch=true) —
      // re-ingest is the cleanup path for garbage pubs stored by the
      // broken slug-resolution code, so the old rewrite (built from
      // garbage) needs to be overwritten with a fresh blend.
      const rw = await rewriteFSDPublication(env, pub.id, { force: !!reFetch });
      if (!rw?.ok && rw?.error_kind) {
        console.warn(`[CRO_INGESTION] eager rewrite failed pub=${pub.id} kind=${rw.error_kind}`);
      }
    }
  } catch (e) {
    console.warn(`[CRO_INGESTION] eager rewrite threw pub=${pub.id}: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 2026-06-05 — Eager macro-calendar extraction. FSD "First Word" + daily
  // notes embed the US economic calendar (dates, times, estimates, ACTUALS).
  // Pull it into the self-updating macro-events store so the Today macro strip
  // reflects the real schedule + released figures, not a hand-curated list.
  // Cheap-gated (only calendar-bearing notes hit the LLM) + best-effort.
  try {
    if (text && text.length > 120) {
      const { extractMacroEventsFromPublication, looksLikeMacroCalendar } = await import("./macro-event-extractor.js");
      if (looksLikeMacroCalendar(text, pub.title)) {
        const me = await extractMacroEventsFromPublication(env, pub.id, { title: pub.title });
        if (me?.ok && me.merged > 0) {
          console.log(`[CRO_INGESTION] macro-calendar: merged ${me.merged} event(s) from pub=${pub.id}`);
        }
      }
    }
  } catch (e) {
    console.warn(`[CRO_INGESTION] macro-calendar extract threw pub=${pub.id}: ${String(e?.message || e).slice(0, 200)}`);
  }

  // 2026-06-03 — Per-pub Discord notification for FlashInsights that
  // mention an active-universe ticker. Skips long-form posts (those go
  // through the daily synthesis-summary Discord) and skips pubs without
  // any tracked ticker. Best-effort: alert errors never block ingest.
  try {
    const isFlash = String(pub.id || "").length <= 8 // numeric WP id; long-form has same shape, fall back to source_url
                  || (pub.source_url && /fsi-alert/i.test(pub.source_url))
                  || (pub.post_type && /fsi-alert/i.test(pub.post_type));
    // Use the same source_url heuristic — fsi-alert pubs have a flash-style URL.
    const sourceLooksFlash = pub.source_url && (/flashinsight|fsi-alert|\/flash\//i.test(pub.source_url));
    if (isFlash && sourceLooksFlash) {
      await maybeNotifyDiscordForFlashInsight(env, pub.id);
    }
  } catch (_) { /* alerts never block ingest */ }

  return {
    ok: true,
    pub_id: pub.id,
    char_count: text?.length || 0,
    pdf_url: fetched.pdf_url || null,
    content_type: fetched.content_type || null,
  };
}

/**
 * Full post-ingest pipeline: extract → TT-voice rewrite.
 * Called after re-fetch so publications land in the Research Desk feed
 * with synthesis + TT voice, not just raw ingested text.
 */
export async function runPublicationPostIngestPipeline(env, pubId, { forceExtract = true, forceRewrite = true } = {}) {
  const id = String(pubId || "").trim();
  if (!id) return { ok: false, error: "missing_pub_id" };
  const out = { ok: true, pub_id: id, extract: null, rewrite: null };

  try {
    const { extractPublicationToProposal } = await import("./fsd-extractor.js");
    out.extract = await extractPublicationToProposal(env, id, { force: !!forceExtract });
  } catch (e) {
    out.extract = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  try {
    const { rewriteFSDPublication } = await import("./fsd-rewriter.js");
    out.rewrite = await rewriteFSDPublication(env, id, { force: !!forceRewrite });
  } catch (e) {
    out.rewrite = { ok: false, error: String(e?.message || e).slice(0, 200) };
  }

  out.ok = !!(out.extract?.ok !== false || out.rewrite?.ok);

  try {
    const { buildPublicFSDFeed } = await import("./influence-ledger.js");
    await buildPublicFSDFeed(env, { limit: 50, lookbackHours: 7 * 24 });
  } catch (_) { /* KV sync best-effort */ }

  return out;
}

/** Discord embed title max (API limit). */
export const MARKET_INTEL_DISCORD_TITLE_MAX = 256;

/**
 * Build a distinct Market Intel Discord title: tickers + TT headline.
 * Avoids duplicate-looking alerts when two flashes share the same tag set.
 */
export function buildMarketIntelDiscordTitle(matchedTickers, summaryTitle) {
  const tickers = (matchedTickers || []).map((t) => String(t || "").toUpperCase()).filter(Boolean);
  const headline = String(summaryTitle || "Market Intel update").replace(/\s+/g, " ").trim();
  const tickerPart = tickers.length <= 3
    ? tickers.join(", ")
    : `${tickers.slice(0, 3).join(", ")} +${tickers.length - 3}`;
  const prefix = tickers.length
    ? `📡 Market Intel — ${tickerPart} · `
    : "📡 Market Intel · ";
  const maxHeadline = Math.max(0, MARKET_INTEL_DISCORD_TITLE_MAX - prefix.length);
  if (maxHeadline <= 0) return prefix.trim();
  if (headline.length <= maxHeadline) return `${prefix}${headline}`;
  const clipped = headline.slice(0, Math.max(0, maxHeadline - 1)).trim();
  return `${prefix}${clipped}…`;
}

// ── Discord notification for new FlashInsights ──────────────────────────────
/**
 * Fires a Discord system-lane embed when a newly-ingested FlashInsight
 * mentions at least one ticker the desk tracks (open positions OR
 * recent screener candidates OR a hardcoded index list). Falls back to
 * silent skip when no active-universe ticker is mentioned (avoids
 * alert fatigue from purely macro FlashInsights).
 *
 * Resolves the rewrite synchronously when possible — Discord renders
 * better with TT-voice than raw FSD prose.
 */
async function maybeNotifyDiscordForFlashInsight(env, pubId) {
  // Pull the just-tagged tickers for this pub.
  const tagRows = await env.DB.prepare(
    `SELECT ticker FROM ${PUBLICATION_TICKERS_TABLE} WHERE pub_id = ? ORDER BY position ASC LIMIT 10`,
  ).bind(pubId).all().catch(() => ({ results: [] }));
  const tickers = (tagRows?.results || []).map((r) => String(r.ticker || "").toUpperCase()).filter(Boolean);
  if (tickers.length === 0) return;

  // Resolve active-universe set: open positions + screener candidates +
  // common index ETFs we always care about.
  const active = new Set(["SPY", "QQQ", "IWM", "DIA", "RSP", "MAGS"]);
  try {
    const open = await env.DB.prepare(`SELECT DISTINCT ticker FROM positions WHERE status='OPEN'`).all();
    for (const r of (open?.results || [])) active.add(String(r.ticker || "").toUpperCase());
  } catch (_) {}
  try {
    const raw = await env.KV.get("timed:screener:candidates");
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const c of (parsed?.candidates || []).slice(0, 30)) {
        if (c?.ticker) active.add(String(c.ticker).toUpperCase());
      }
    }
  } catch (_) {}

  const matched = tickers.filter((t) => active.has(t));
  if (matched.length === 0) return; // No relevant ticker — silent.

  // Resolve title + rewrite for the Discord embed.
  const meta = await env.DB.prepare(
    `SELECT title, source_url FROM ${PUBLICATIONS_TABLE} WHERE pub_id = ?`,
  ).bind(pubId).first().catch(() => null);

  let summary_title = meta?.title || "Market Intel update";
  let summary_body = null;
  try {
    const { rewriteFSDPublication } = await import("./fsd-rewriter.js");
    const rw = await rewriteFSDPublication(env, pubId);
    if (rw.ok) {
      summary_title = rw.tt_summary_title || summary_title;
      summary_body = rw.tt_summary_body || null;
    }
  } catch (_) {}
  if (!summary_body) {
    // Fall back to the raw excerpt.
    const tx = await loadPublicationText(env, pubId);
    if (tx?.text_excerpt) summary_body = String(tx.text_excerpt).slice(0, 500);
  }

  try {
    const { notifyDiscord } = await import("../alerts.js");
    const discordTitle = buildMarketIntelDiscordTitle(matched, summary_title);
    await notifyDiscord(env, {
      title: discordTitle,
      description: summary_body ? summary_body.slice(0, 220) : undefined,
      color: 0xa855f7,
      fields: [
        { name: "Mentioned (active universe)", value: matched.map((t) => `\`${t}\``).join(" "), inline: false },
        ...(summary_body ? [{ name: "TT summary", value: summary_body.slice(0, 900), inline: false }] : []),
        ...(meta?.source_url ? [{ name: "Source", value: `[Read on fundstratdirect.com](${meta.source_url})`, inline: false }] : []),
        { name: "View in app", value: `Open the ticker's right-rail → Catalysts tab (Intel panel)`, inline: false },
      ],
      footer: { text: `pub_id=${pubId} · Timed Trading intel routing` },
      timestamp: new Date().toISOString(),
    }, "general");
  } catch (_) {}
}

// ── Cron entry point: list then ingest anything new ───────────────────────────
export async function runFSDIngestion(env, { limit = 20, force = false } = {}) {
  const startedAt = Date.now();
  await ensureCROIngestionSchema(env);

  const listed = await listFSDPublications(env, { limit });
  if (!listed.ok) {
    return {
      ok: false,
      error_kind: listed.error_kind,
      hint: listed.hint,
      login_probe: listed.login_probe || null,
      elapsed_ms: Date.now() - startedAt,
    };
  }

  // Process oldest publications first so extract/rewrite respects chronology.
  const pubs = [...(listed.publications || [])];
  pubs.sort((a, b) => {
    const ta = Date.parse(String(a.published_at || "")) || 0;
    const tb = Date.parse(String(b.published_at || "")) || 0;
    return ta - tb;
  });

  const results = [];
  for (const pub of pubs) {
    try {
      const r = await ingestSinglePublication(env, pub, { reFetch: force });
      results.push(r);
      if (r?.ok && !r.skipped) {
        try {
          // Extract after ingest; rewrite already ran inside ingestSinglePublication.
          await runPublicationPostIngestPipeline(env, pub.id, {
            forceExtract: true,
            forceRewrite: !!force,
          });
        } catch (_) { /* pipeline is best-effort */ }
      }
    } catch (e) {
      results.push({ ok: false, pub_id: pub.id, error_kind: "exception", hint: String(e?.message || e).slice(0, 200) });
    }
  }

  // Refresh KV research feed cache after batch ingest.
  try {
    const { buildPublicFSDFeed } = await import("./influence-ledger.js");
    await buildPublicFSDFeed(env, { limit: 50, lookbackHours: 7 * 24 });
  } catch (_) { /* KV sync is best-effort */ }

  return {
    ok: true,
    listed: listed.publications.length,
    ingested: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    errors: results.filter((r) => !r.ok).length,
    results: results.slice(0, 50),
    elapsed_ms: Date.now() - startedAt,
  };
}

// ── Manual ingestion (paste a URL, no FSD list needed) ────────────────────────
// Used by the operator-facing admin endpoint to ingest a publication directly
// from a URL even when the FSD scraper isn't fully configured yet.
export async function ingestFromUrl(env, url, { title = null } = {}) {
  await ensureCROIngestionSchema(env);
  const pubId = "manual_" + (url.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80)) + "_" + Date.now();
  const pub = {
    id: pubId,
    title: title || url.slice(-80),
    source_url: url,
    published_at: new Date().toISOString().slice(0, 10),
  };
  return await ingestSinglePublication(env, pub, { reFetch: true });
}

// ── Manual ingestion from a raw PDF / HTML blob (operator-uploaded) ──────────
// Skips the fetch step entirely. Used when the operator uploads a PDF via
// the admin endpoint or pastes the text body inline.
export async function ingestFromBlob(env, { title, source_url, content_type, body_text, body_bytes_b64 }) {
  await ensureCROIngestionSchema(env);
  const pubId = "blob_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

  let text = "";
  let bytesLen = 0;
  if (body_text) {
    text = String(body_text);
    bytesLen = text.length;
  } else if (body_bytes_b64) {
    // Decode base64 → Uint8Array → PDF heuristic.
    try {
      const bin = atob(body_bytes_b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      bytesLen = arr.byteLength;
      text = extractPdfTextHeuristic(arr.buffer);
    } catch (e) {
      return { ok: false, error_kind: "base64_decode_failed", hint: String(e?.message || e).slice(0, 200) };
    }
  } else {
    return { ok: false, error_kind: "no_body", hint: "supply body_text OR body_bytes_b64" };
  }

  await recordPublication(env, {
    pub_id: pubId,
    title: title || "(operator upload)",
    source: "manual",
    source_url: source_url || null,
    published_at: new Date().toISOString().slice(0, 10),
    fetched_at: Date.now(),
    content_type: content_type || (body_text ? "text/plain" : "application/pdf"),
    bytes_len: bytesLen,
    fetch_status: "ok",
  });
  await recordPublicationText(env, pubId, text);

  return { ok: true, pub_id: pubId, char_count: text.length };
}

// Setters used by the apply / extractor modules to stamp links back onto the
// publication row (so the operator can trace publication → proposal → apply
// from the cro_publications row alone).
export async function markPublicationExtracted(env, pubId, proposalId) {
  try {
    await env.DB.prepare(
      `UPDATE ${PUBLICATIONS_TABLE} SET extracted_at = ?1, proposal_id = ?2 WHERE pub_id = ?3`,
    ).bind(Date.now(), proposalId || null, pubId).run();
  } catch (_) {}
}

export async function markPublicationApplied(env, pubId) {
  try {
    await env.DB.prepare(
      `UPDATE ${PUBLICATIONS_TABLE} SET applied_at = ?1 WHERE pub_id = ?2`,
    ).bind(Date.now(), pubId).run();
  } catch (_) {}
}
