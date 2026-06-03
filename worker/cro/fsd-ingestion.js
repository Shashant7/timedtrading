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
  // SQLite has no row size limit but D1 is limited per-query payload (~1MB).
  // Cap full text at 256KB which is well within and plenty for any single
  // research note. The excerpt is what we pass to the LLM most of the time;
  // full text is for debugging / human-in-the-loop review.
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

  return {
    ok: true,
    pub_id: pub.id,
    char_count: text?.length || 0,
    pdf_url: fetched.pdf_url || null,
    content_type: fetched.content_type || null,
  };
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
