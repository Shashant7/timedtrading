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

import { listFSDPublications, fetchFSDPublication } from "./fsd-client.js";

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

export function extractCashtagsFromText(text) {
  if (!text) return [];
  const seen = new Set();
  const out = [];
  let m;
  CASHTAG_RE.lastIndex = 0;
  while ((m = CASHTAG_RE.exec(text)) !== null) {
    const t = m[1].toUpperCase();
    if (t.length < 2) continue;
    if (CASHTAG_NOISE.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
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
export function extractHtmlText(html) {
  if (!html) return "";
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
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
    await env.DB.prepare(`
      INSERT OR REPLACE INTO ${PUBLICATIONS_TABLE}
        (pub_id, title, source, source_url, published_at, fetched_at,
         content_type, bytes_len, fetch_status, fetch_error,
         extracted_at, proposal_id, applied_at)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
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
      row.extracted_at || null,
      row.proposal_id || null,
      row.applied_at || null,
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
    const tickers = extractCashtagsFromText(text);
    if (tickers.length === 0) return;
    const now = Date.now();
    // Batch insert. D1 supports prepared statement batches via .batch(),
    // but a simple loop is fine here — usually 1-8 tickers per pub.
    for (let i = 0; i < tickers.length; i++) {
      try {
        await env.DB.prepare(`
          INSERT OR REPLACE INTO ${PUBLICATION_TICKERS_TABLE}
            (pub_id, ticker, position, tagged_at)
          VALUES (?1, ?2, ?3, ?4)
        `).bind(pubId, tickers[i], i, now).run();
      } catch (_) { /* tolerate per-ticker errors */ }
    }
  } catch (e) {
    console.warn("[CRO_INGESTION] cashtag tagging failed:", String(e?.message || e).slice(0, 200));
  }
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
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 6));
  const lookbackDays = Math.max(1, Number(opts.lookbackDays) || 14);
  const since = Date.now() - lookbackDays * 86400000;
  try {
    const rows = await db.prepare(`
      SELECT p.pub_id, p.title, p.source, p.source_url, p.published_at,
             p.fetched_at, p.proposal_id, p.applied_at, pt.position
        FROM ${PUBLICATION_TICKERS_TABLE} pt
        JOIN ${PUBLICATIONS_TABLE} p ON p.pub_id = pt.pub_id
       WHERE pt.ticker = ?1
         AND p.fetched_at >= ?2
       ORDER BY p.fetched_at DESC
       LIMIT ?3
    `).bind(sym, since, limit).all();
    const publications = (rows?.results || []).map((r) => ({
      pub_id: r.pub_id,
      title: r.title,
      source: r.source,
      source_url: r.source_url,
      published_at: r.published_at,
      fetched_at: r.fetched_at,
      proposal_id: r.proposal_id,
      applied_at: r.applied_at,
      mention_position: r.position,
    }));
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
        p.excerpt = excerptByPub[p.pub_id]?.slice(0, 600) || null;
      }
    }
    return {
      ticker: sym,
      count: publications.length,
      lookback_days: lookbackDays,
      publications,
    };
  } catch (e) {
    return { ticker: sym, error: String(e?.message || e).slice(0, 200), publications: [] };
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
      const now = Date.now();
      for (let i = 0; i < tickers.length; i++) {
        try {
          await db.prepare(`
            INSERT OR REPLACE INTO ${PUBLICATION_TICKERS_TABLE}
              (pub_id, ticker, position, tagged_at)
            VALUES (?1, ?2, ?3, ?4)
          `).bind(r.pub_id, tickers[i], i, now).run();
        } catch (_) {}
      }
      totalTagged += tickers.length;
      pubResults.push({ pub_id: r.pub_id, tagged: tickers.length, tickers });
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
              fetch_status, fetch_error, extracted_at, proposal_id, applied_at
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

  const fetched = await fetchFSDPublication(env, pub.source_url);
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
    });
    return { ok: false, pub_id: pub.id, error_kind: fetched.error_kind, hint: fetched.hint };
  }

  let text = "";
  if (fetched.body_text) {
    text = extractHtmlText(fetched.body_text);
  } else if (fetched.body_bytes) {
    text = extractPdfTextHeuristic(fetched.body_bytes);
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
  });
  if (text) await recordPublicationText(env, pub.id, text);

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

  let summary_title = meta?.title || "FSD FlashInsight";
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
    await notifyDiscord(env, {
      title: `📡 FSD FlashInsight — ${matched.slice(0, 3).join(", ")}${matched.length > 3 ? ` +${matched.length - 3}` : ""}`,
      description: summary_title.slice(0, 220),
      color: 0xa855f7,
      fields: [
        { name: "Mentioned (active universe)", value: matched.map((t) => `\`${t}\``).join(" "), inline: false },
        ...(summary_body ? [{ name: "TT summary", value: summary_body.slice(0, 900), inline: false }] : []),
        ...(meta?.source_url ? [{ name: "Source", value: `[Read on fundstratdirect.com](${meta.source_url})`, inline: false }] : []),
        { name: "View in app", value: `Open the ticker's right-rail → Catalysts tab (📡 FSD Intel panel)`, inline: false },
      ],
      footer: { text: `pub_id=${pubId} · auto-routed by CRO ingestion` },
      timestamp: new Date().toISOString(),
    }, "system");
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

  const results = [];
  for (const pub of (listed.publications || [])) {
    try {
      const r = await ingestSinglePublication(env, pub, { reFetch: force });
      results.push(r);
    } catch (e) {
      results.push({ ok: false, pub_id: pub.id, error_kind: "exception", hint: String(e?.message || e).slice(0, 200) });
    }
  }

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
