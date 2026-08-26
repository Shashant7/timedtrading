// worker/cro/fsd-sector-outlook.js
// Fundstrat Direct ETF Outlook / Sector Allocation summary table.
// Stores per-analyst OW/N/UW (Tom Lee vs Mark Newton) plus model weights.
//
// Source: fundstratdirect.com/members/stock-lists (Etf Outlook category)
// Operator paste or hardcoded seed.

import { kvGetJSON, kvPutJSON } from "../storage.js";
import { FSD_TO_TT_SECTOR } from "./fsd-gics-sectors.js";

export const FSD_SECTOR_OUTLOOK_KV_KEY = "timed:fsd:sector-allocation-outlook";
export const FSD_SECTOR_OUTLOOK_META_KV_KEY = "timed:fsd:sector-allocation-outlook:meta";
export const FSD_ETF_OUTLOOK_PATH = "/members/stock-lists/?category=etf-outlook";
export const FSD_ETF_OUTLOOK_PAGE_ID = 796381;
/** WP category for monthly Sector Allocation updates (etf-prior-outlooks grid). */
export const FSD_SECTOR_ALLOCATION_CATEGORY_ID = 8362;

const OUTLOOK_SECTOR_NAMES = [
  "Communication Services",
  "Consumer Discretionary",
  "Consumer Staples",
  "Energy",
  "Financials",
  "Health Care",
  "Industrials",
  "Information Technology",
  "Materials",
  "Real Estate",
  "Utilities",
];

/** Monthly deck cadence — alert if no successful sync in this window. */
export const SECTOR_OUTLOOK_STALE_MS = 35 * 24 * 60 * 60 * 1000;

const STANCE_MAP = {
  OW: "overweight",
  N: "neutral",
  UW: "underweight",
  OVERWEIGHT: "overweight",
  NEUTRAL: "neutral",
  UNDERWEIGHT: "underweight",
};

/** August 2026 ETF Outlook — operator-provided canonical table. */
export const FSD_SECTOR_OUTLOOK_AUG_2026 = {
  source: "etf_outlook",
  as_of: "2026-08",
  total_spx_weight_pct: 85,
  total_fsi_weight_pct: 85,
  sectors: {
    "Health Care": {
      etf: "XLV",
      spx_weight_pct: 7.5,
      fsi_weight_pct: 9.5,
      delta_pct: 2.0,
      lee: "neutral",
      newton: "overweight",
    },
    "Consumer Discretionary": {
      etf: "XLY",
      spx_weight_pct: 7.9,
      fsi_weight_pct: 9.9,
      delta_pct: 2.0,
      lee: "neutral",
      newton: "neutral",
    },
    "Utilities": {
      etf: "XLU",
      spx_weight_pct: 1.8,
      fsi_weight_pct: 1.8,
      delta_pct: 0.0,
      lee: "neutral",
      newton: "neutral",
    },
    "Information Technology": {
      etf: "XLK",
      spx_weight_pct: 31.9,
      fsi_weight_pct: 32.2,
      delta_pct: 0.3,
      lee: "overweight",
      newton: "neutral",
    },
    "Financials": {
      etf: "XLF",
      spx_weight_pct: 10.4,
      fsi_weight_pct: 13.4,
      delta_pct: 3.0,
      lee: "overweight",
      newton: "overweight",
    },
    "Industrials": {
      etf: "XLI",
      spx_weight_pct: 7.4,
      fsi_weight_pct: 7.5,
      delta_pct: 0.1,
      lee: "overweight",
      newton: "neutral",
    },
    "Real Estate": {
      etf: "XLRE",
      spx_weight_pct: 1.6,
      fsi_weight_pct: 1.6,
      delta_pct: 0.0,
      lee: "overweight",
      newton: "neutral",
    },
    "Materials": {
      etf: "XLB",
      spx_weight_pct: 1.5,
      fsi_weight_pct: 1.5,
      delta_pct: 0.0,
      lee: "overweight",
      newton: "neutral",
    },
    "Energy": {
      etf: "XLE",
      spx_weight_pct: 2.7,
      fsi_weight_pct: 0.7,
      delta_pct: -2.0,
      lee: "overweight",
      newton: "underweight",
    },
    "Communication Services": {
      etf: "XLC",
      spx_weight_pct: 8.6,
      fsi_weight_pct: 6.7,
      delta_pct: -1.9,
      lee: "overweight",
      newton: "underweight",
    },
    "Consumer Staples": {
      etf: "XLP",
      spx_weight_pct: 3.8,
      fsi_weight_pct: 0.3,
      delta_pct: -3.5,
      lee: "underweight",
      newton: "underweight",
    },
  },
};

export function normalizeAnalystStance(raw) {
  const key = String(raw || "").trim().toUpperCase();
  return STANCE_MAP[key] || String(raw || "neutral").toLowerCase();
}

export function normalizeOutlookSectorName(name) {
  const raw = String(name || "").trim();
  return FSD_TO_TT_SECTOR[raw] || raw;
}

/** Composite playbook rating from model delta + analyst disagreement guard. */
export function compositeRatingFromOutlook(row) {
  const delta = Number(row?.delta_pct) || 0;
  const lee = normalizeAnalystStance(row?.lee);
  const newton = normalizeAnalystStance(row?.newton);
  if (lee === "underweight" && newton === "underweight") return "underweight";
  if (delta <= -1.5) return "underweight";
  if (lee === "overweight" && newton === "overweight") return "overweight";
  if (delta >= 1.5) return "overweight";
  if (delta >= 0.5 && (lee === "overweight" || newton === "overweight")) return "overweight";
  return "neutral";
}

export function boostFromDelta(delta) {
  const d = Number(delta) || 0;
  if (d >= 2.5) return 5;
  if (d >= 1.5) return 4;
  if (d >= 0.5) return 2;
  if (d <= -3) return -5;
  if (d <= -1.5) return -3;
  return 0;
}

export function buildSectorRatingsPatchFromOutlook(outlook) {
  const patch = {};
  for (const [sector, row] of Object.entries(outlook?.sectors || {})) {
    const ttSector = normalizeOutlookSectorName(sector);
    const rating = compositeRatingFromOutlook(row);
    patch[ttSector] = {
      rating,
      boost: boostFromDelta(row.delta_pct),
      delta: Number(row.delta_pct) || 0,
      etf: row.etf || null,
      spx_weight_pct: row.spx_weight_pct ?? null,
      fsi_weight_pct: row.fsi_weight_pct ?? null,
      lee_rating: normalizeAnalystStance(row.lee),
      newton_rating: normalizeAnalystStance(row.newton),
      _fsd_source: true,
      _fsd_outlook: true,
      _fsd_as_of: outlook.as_of || null,
    };
    // Materials → Basic Materials alias
    if (sector === "Materials" && ttSector === "Basic Materials") {
      patch.Materials = { ...patch[ttSector] };
    }
  }
  return patch;
}

/**
 * Parse a pasted ETF Outlook table (tab- or whitespace-separated).
 * Skips header/total rows.
 */
export function parseFsdSectorOutlookTable(text = "") {
  const sectors = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^sector\b/i.test(trimmed) || /^total\b/i.test(trimmed)) continue;
    const cols = trimmed.split(/\t+/).length > 3
      ? trimmed.split(/\t+/).map((c) => c.trim())
      : trimmed.split(/\s{2,}|\t/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 6) {
      // Try single-space split for "Health Care XLV 7.50% ..."
      const m = trimmed.match(
        /^(.+?)\s+(X[A-Z]{2,4})\s+([\d.]+)%?\s+([\d.]+)%?\s+([-+]?[\d.]+)%?\s+(OW|N|UW)\s+(OW|N|UW)\s*$/i,
      );
      if (!m) continue;
      const [, sector, etf, spx, fsi, delta, lee, newton] = m;
      sectors[normalizeOutlookSectorName(sector)] = {
        etf: etf.toUpperCase(),
        spx_weight_pct: Number(spx),
        fsi_weight_pct: Number(fsi),
        delta_pct: Number(delta),
        lee: normalizeAnalystStance(lee),
        newton: normalizeAnalystStance(newton),
      };
      continue;
    }
    const [sector, etf, spx, fsi, delta, lee, newton] = cols;
    if (!sector || !etf || !/^X[A-Z]/i.test(etf)) continue;
    sectors[normalizeOutlookSectorName(sector)] = {
      etf: String(etf).toUpperCase(),
      spx_weight_pct: Number(String(spx).replace("%", "")),
      fsi_weight_pct: Number(String(fsi).replace("%", "")),
      delta_pct: Number(String(delta).replace("%", "")),
      lee: normalizeAnalystStance(lee),
      newton: normalizeAnalystStance(newton),
    };
  }
  return {
    source: "etf_outlook",
    as_of: new Date().toISOString().slice(0, 7),
    sectors,
  };
}

export function getAnalystSectorRating(outlook, sector, analyst = "newton") {
  const key = normalizeOutlookSectorName(sector);
  const row = outlook?.sectors?.[key]
    || outlook?.sectors?.[sector]
    || Object.entries(outlook?.sectors || {}).find(([k]) => normalizeOutlookSectorName(k) === key)?.[1];
  if (!row) return null;
  const field = String(analyst).toLowerCase() === "lee" ? "lee" : "newton";
  return normalizeAnalystStance(row[field]);
}

export async function getFsdSectorOutlook(env) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return FSD_SECTOR_OUTLOOK_AUG_2026;
  const stored = await kvGetJSON(kv, FSD_SECTOR_OUTLOOK_KV_KEY);
  return stored?.sectors ? stored : FSD_SECTOR_OUTLOOK_AUG_2026;
}

/** Persist outlook + merge analyst-aware ratings into timed:admin:sector_ratings. */
export function outlookFingerprint(outlook) {
  return Object.entries(outlook?.sectors || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sector, row]) => [
      sector,
      row.etf,
      row.spx_weight_pct,
      row.fsi_weight_pct,
      row.delta_pct,
      normalizeAnalystStance(row.lee),
      normalizeAnalystStance(row.newton),
    ].join(":"))
    .join("|");
}

export function isEtfOutlookPaywall(html = "") {
  const article = extractArticleBackgroundHtml(html);
  const text = String(article);
  return /Become a Member To Access/i.test(text)
    && !/Health Care[\s\S]{0,400}XLV/i.test(text)
    && Object.keys(parseFsdSectorOutlookTable(stripHtmlToTableText(text)).sectors || {}).length < 8
    && Object.keys(parseFsdEtfOutlookHtmlRows(text).sectors || {}).length < 8;
}

export function stripHtmlToTableText(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;/g, "-")
    .replace(/&amp;/g, "&");
}

function extractArticleBackgroundHtml(html = "") {
  const src = String(html || "");
  const start = src.search(/id=["']article-background["']/i);
  if (start < 0) return src;
  const slice = src.slice(start, start + 120_000);
  const end = slice.search(/<\/div>\s*<\/div>\s*<div[^>]*class="[^"]*fsi-plan-boxes/i);
  return end > 0 ? slice.slice(0, end) : slice;
}

function mergeOutlookParses(...parsedList) {
  const sectors = {};
  let asOf = null;
  for (const parsed of parsedList) {
    if (!parsed) continue;
    if (parsed.as_of) asOf = parsed.as_of;
    Object.assign(sectors, parsed.sectors || {});
  }
  return {
    source: "etf_outlook",
    as_of: asOf || new Date().toISOString().slice(0, 7),
    sectors,
  };
}

function parseStanceToken(raw) {
  const t = String(raw || "").trim().toUpperCase();
  if (t === "OW" || t === "OVERWEIGHT") return "overweight";
  if (t === "UW" || t === "UNDERWEIGHT") return "underweight";
  if (t === "N" || t === "NEUTRAL") return "neutral";
  return normalizeAnalystStance(raw);
}

/** Parse HTML <tr> rows with Sector / ETF / weights / Lee / Newton columns. */
export function parseFsdEtfOutlookHtmlRows(html = "") {
  const sectors = {};
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(String(html))) !== null) {
    const rowHtml = m[1];
    if (!/X[A-Z]{2,4}/i.test(rowHtml)) continue;
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((c) => stripHtmlToTableText(c[1]).replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (cells.length < 4) continue;

    let sector = null;
    let etf = null;
    let spx = null;
    let fsi = null;
    let delta = null;
    let lee = null;
    let newton = null;

    for (const cell of cells) {
      if (!etf && /^X[A-Z]{2,4}$/i.test(cell)) etf = cell.toUpperCase();
      if (!sector) {
        const known = OUTLOOK_SECTOR_NAMES.find((s) => cell.toLowerCase() === s.toLowerCase());
        if (known) sector = known;
      }
      const pct = cell.match(/^([-+]?[\d.]+)\s*%?$/);
      if (pct && spx == null) spx = Number(pct[1]);
      else if (pct && fsi == null) fsi = Number(pct[1]);
      else if (pct && delta == null) delta = Number(pct[1]);
      if (/^(OW|N|UW|OVERWEIGHT|NEUTRAL|UNDERWEIGHT)$/i.test(cell)) {
        if (!lee) lee = parseStanceToken(cell);
        else if (!newton) newton = parseStanceToken(cell);
      }
    }

    if (!sector || !etf) {
      const rowText = stripHtmlToTableText(rowHtml).replace(/\s+/g, " ").trim();
      const rowMatch = rowText.match(
        /^(.+?)\s+(X[A-Z]{2,4})\s+([\d.]+)%?\s+([\d.]+)%?\s+([-+]?[\d.]+)%?\s+(OW|N|UW|OVERWEIGHT|NEUTRAL|UNDERWEIGHT)\s+(OW|N|UW|OVERWEIGHT|NEUTRAL|UNDERWEIGHT)\s*$/i,
      );
      if (rowMatch) {
        sector = normalizeOutlookSectorName(rowMatch[1].trim());
        etf = rowMatch[2].toUpperCase();
        spx = Number(rowMatch[3]);
        fsi = Number(rowMatch[4]);
        delta = Number(rowMatch[5]);
        lee = parseStanceToken(rowMatch[6]);
        newton = parseStanceToken(rowMatch[7]);
      }
    }

    if (!sector || !etf) continue;
    const key = normalizeOutlookSectorName(sector);
    if (!OUTLOOK_SECTOR_NAMES.includes(key) && key !== "Basic Materials") continue;
    sectors[key] = {
      etf,
      spx_weight_pct: spx ?? sectors[key]?.spx_weight_pct ?? null,
      fsi_weight_pct: fsi ?? sectors[key]?.fsi_weight_pct ?? null,
      delta_pct: delta ?? sectors[key]?.delta_pct ?? null,
      lee: lee ?? sectors[key]?.lee ?? "neutral",
      newton: newton ?? sectors[key]?.newton ?? "neutral",
    };
  }
  return {
    source: "etf_outlook",
    as_of: new Date().toISOString().slice(0, 7),
    sectors,
  };
}

/** Parse authenticated ETF Outlook HTML into sector rows. */
export function parseFsdEtfOutlookHtml(html = "") {
  const article = extractArticleBackgroundHtml(html);
  const text = stripHtmlToTableText(article);
  const parsed = parseFsdSectorOutlookTable(text);
  const rowParsed = parseFsdEtfOutlookHtmlRows(article);
  const merged = mergeOutlookParses(parsed, rowParsed);

  if (Object.keys(merged.sectors || {}).length >= 8) return merged;

  // Fallback: row scan for "Sector ETF wt wt delta OW N" patterns in raw HTML.
  const sectors = { ...merged.sectors };
  const rowRe = /([A-Za-z][A-Za-z &]+?)\s+(X[A-Z]{2,4})\s+([\d.]+)%?\s+([\d.]+)%?\s+([-+]?[\d.]+)%?\s+(OW|N|UW)\s+(OW|N|UW)/gi;
  let m;
  while ((m = rowRe.exec(String(html))) !== null) {
    const sector = normalizeOutlookSectorName(m[1].trim());
    if (!sector || sector === "Total") continue;
    sectors[sector] = {
      etf: m[2].toUpperCase(),
      spx_weight_pct: Number(m[3]),
      fsi_weight_pct: Number(m[4]),
      delta_pct: Number(m[5]),
      lee: normalizeAnalystStance(m[6]),
      newton: normalizeAnalystStance(m[7]),
    };
  }
  return {
    source: "etf_outlook",
    as_of: new Date().toISOString().slice(0, 7),
    sectors,
  };
}

export async function fetchFsdLatestSectorAllocationPdfText(env) {
  const listUrl = `https://fundstratdirect.com/wp-json/wp/v2/posts?categories=${FSD_SECTOR_ALLOCATION_CATEGORY_ID}&per_page=1&_fields=id,title,content,date`;
  const listRes = await fetch(listUrl, { signal: AbortSignal.timeout(15_000) });
  if (!listRes.ok) return { ok: false, error_kind: "wp_rest_list_error", status: listRes.status };
  const posts = await listRes.json().catch(() => []);
  const post = Array.isArray(posts) ? posts[0] : null;
  const content = String(post?.content?.rendered || "");
  const pdfMatch = content.match(/href=["']([^"']+SectorAllocation[^"']+\.pdf[^"']*)["']/i)
    || content.match(/href=["']([^"']+\.pdf[^"']*)["']/i);
  if (!pdfMatch?.[1]) {
    return { ok: false, error_kind: "pdf_link_missing", post_id: post?.id || null };
  }
  let pdfUrl = pdfMatch[1].replace(/&amp;/g, "&");
  if (!/^https?:\/\//i.test(pdfUrl)) {
    pdfUrl = `https://fundstratdirect.com${pdfUrl.startsWith("/") ? "" : "/"}${pdfUrl}`;
  }
  const { fetchAuthenticatedFsdUrl } = await import("./fsd-client.js");
  const fetched = await fetchAuthenticatedFsdUrl(env, pdfUrl, { accept: "application/pdf,*/*" });
  if (!fetched.ok) return { ok: false, ...fetched, pdf_url: pdfUrl };
  const ct = String(fetched.content_type || "");
  if (!ct.includes("pdf") && (fetched.body_bytes_len || 0) < 5000) {
    return { ok: false, error_kind: "pdf_not_binary", pdf_url: pdfUrl, content_type: ct };
  }
  const { extractPdfTextHeuristic } = await import("./fsd-ingestion.js");
  const text = extractPdfTextHeuristic(fetched.body_bytes);
  if (!text || text.length < 200) {
    return { ok: false, error_kind: "pdf_text_empty", pdf_url: pdfUrl, text_len: text?.length || 0 };
  }
  return {
    ok: true,
    pdf_url: pdfUrl,
    post_id: post?.id || null,
    post_title: post?.title?.rendered || null,
    text,
    fetched_at: fetched.fetched_at,
  };
}

export async function fetchFsdEtfOutlookPage(env) {
  const { fetchAuthenticatedFsdPage, fetchAuthenticatedFsdAjax } = await import("./fsd-client.js");
  const chunks = [];
  const meta = { sources: [] };

  const page = await fetchAuthenticatedFsdPage(env, FSD_ETF_OUTLOOK_PATH);
  if (!page.ok) return page;
  chunks.push(page.html || "");
  meta.sources.push({ kind: "page", url: page.url, html_length: String(page.html || "").length });

  const ajaxTemplates = [
    String(FSD_ETF_OUTLOOK_PAGE_ID),
    "etf-outlook",
    "stock-lists",
    "",
  ];
  for (const template of ajaxTemplates) {
    const ajax = await fetchAuthenticatedFsdAjax(env, {
      action: "client_portal_view_more",
      category: "etf-outlook",
      params: {
        offset: "0",
        template,
        max: "50",
        min: "0",
        author_id: "0",
        extra_author_ids: "",
        watchlist: "",
        flashtype: "",
      },
    });
    if (ajax.ok && ajax.html_length > 0) {
      chunks.push(ajax.html);
      meta.sources.push({ kind: "ajax", template, html_length: ajax.html_length });
    }
  }

  const pdf = await fetchFsdLatestSectorAllocationPdfText(env);
  if (pdf.ok && pdf.text) {
    chunks.push(pdf.text);
    meta.sources.push({ kind: "pdf", pdf_url: pdf.pdf_url, text_len: pdf.text.length });
  }

  return {
    ok: true,
    html: chunks.join("\n\n"),
    url: page.url,
    fetched_at: Date.now(),
    auth_from_cache: page.auth_from_cache,
    fetch_meta: meta,
  };
}

export function assessSectorOutlookFreshness(outlook, now = Date.now()) {
  const generatedAt = Number(outlook?.generated_at) || 0;
  const asOf = String(outlook?.as_of || "");
  let ageMs = generatedAt > 0 ? now - generatedAt : null;
  if (!ageMs && /^\d{4}-\d{2}$/.test(asOf)) {
    const [y, mo] = asOf.split("-").map(Number);
    const monthEnd = Date.UTC(y, mo, 0, 23, 59, 59);
    ageMs = now - monthEnd;
  }
  const stale = ageMs == null || ageMs > SECTOR_OUTLOOK_STALE_MS;
  return {
    stale,
    age_days: ageMs == null ? null : Math.round(ageMs / (24 * 60 * 60 * 1000)),
    stale_after_days: Math.round(SECTOR_OUTLOOK_STALE_MS / (24 * 60 * 60 * 1000)),
    generated_at: generatedAt || null,
    as_of: asOf || null,
  };
}

export async function diagFsdEtfOutlookPage(env) {
  const fetched = await fetchFsdEtfOutlookPage(env);
  if (!fetched.ok) return { ok: false, ...fetched };
  const html = String(fetched.html || "");
  const stripped = stripHtmlToTableText(html);
  const parsed = parseFsdEtfOutlookHtml(html);
  return {
    ok: true,
    url: fetched.url,
    html_length: html.length,
    has_xlv: /XLV/i.test(html),
    has_health_care: /Health\s*Care/i.test(html),
    has_ow_tokens: (html.match(/\bOW\b/g) || []).length,
    paywall: isEtfOutlookPaywall(html),
    sectors_parsed: Object.keys(parsed.sectors || {}).length,
    stripped_sample: stripped.slice(0, 4000),
    parsed_sectors: Object.keys(parsed.sectors || {}),
    auth_from_cache: fetched.auth_from_cache,
    fetch_meta: fetched.fetch_meta || null,
  };
}

/**
 * Called from the daily FSD ingestion cron so sector ratings stay current.
 */
export async function syncFsdSectorOutlookFromFsd(env, { notify = true } = {}) {
  const kv = env?.KV_TIMED || env?.KV;
  const meta = {
    last_check_at: Date.now(),
    last_check_ok: false,
  };
  const prev = kv ? await kvGetJSON(kv, FSD_SECTOR_OUTLOOK_KV_KEY) : null;
  const prevFp = prev ? outlookFingerprint(prev) : null;

  const fetched = await fetchFsdEtfOutlookPage(env);
  if (!fetched.ok) {
    meta.last_error = fetched.error_kind || "fetch_failed";
    meta.last_hint = fetched.hint || null;
    if (kv) await kvPutJSON(kv, FSD_SECTOR_OUTLOOK_META_KV_KEY, meta);
    return { ok: false, changed: false, ...fetched, freshness: assessSectorOutlookFreshness(prev) };
  }
  if (isEtfOutlookPaywall(fetched.html)) {
    meta.last_error = "paywall";
    if (kv) await kvPutJSON(kv, FSD_SECTOR_OUTLOOK_META_KV_KEY, meta);
    return { ok: false, error_kind: "paywall", changed: false, freshness: assessSectorOutlookFreshness(prev) };
  }

  const parsed = parseFsdEtfOutlookHtml(fetched.html);
  const sectorCount = Object.keys(parsed.sectors || {}).length;
  if (sectorCount < 8) {
    meta.last_error = "parse_incomplete";
    meta.sectors_parsed = sectorCount;
    if (kv) await kvPutJSON(kv, FSD_SECTOR_OUTLOOK_META_KV_KEY, meta);
    const diag = {
      html_length: String(fetched.html || "").length,
      has_xlv: /XLV/i.test(fetched.html || ""),
      has_health_care: /Health\s*Care/i.test(fetched.html || ""),
      paywall: isEtfOutlookPaywall(fetched.html),
      stripped_sample: stripHtmlToTableText(fetched.html).slice(0, 1500),
      fetch_meta: fetched.fetch_meta || null,
    };
    return { ok: false, error_kind: "parse_incomplete", sectors_parsed: sectorCount, changed: false, diag, freshness: assessSectorOutlookFreshness(prev) };
  }

  const fp = outlookFingerprint(parsed);
  const changed = fp !== prevFp;
  meta.last_check_ok = true;
  meta.last_fetch_at = fetched.fetched_at;
  meta.fingerprint = fp;
  meta.sectors_parsed = sectorCount;

  let applied = null;
  if (changed) {
    applied = await syncFsdSectorOutlook(env, { ...parsed, generated_at: Date.now() });
    meta.last_applied_at = Date.now();
    meta.last_changed_at = Date.now();
  } else if (kv) {
    meta.last_unchanged_at = Date.now();
  }

  const outlook = changed ? applied?.outlook : (prev || parsed);
  const freshness = assessSectorOutlookFreshness(outlook);
  meta.freshness = freshness;
  if (kv) await kvPutJSON(kv, FSD_SECTOR_OUTLOOK_META_KV_KEY, meta);

  if (notify && (changed || freshness.stale)) {
    try {
      const { notifyDiscord } = await import("../alerts.js");
      const hc = parsed.sectors?.["Health Care"];
      const lines = changed
        ? [`Sector allocation outlook updated (${sectorCount} sectors).`, hc ? `Health Care: Lee ${hc.lee}, Newton ${hc.newton}, delta ${hc.delta_pct}%` : null].filter(Boolean)
        : [`Sector outlook sync OK but data is stale (${freshness.age_days ?? "?"}d old). Check FSD ETF Outlook page.`];
      await notifyDiscord(env, {
        title: changed ? "FSD sector outlook refreshed" : "FSD sector outlook stale",
        description: lines.join("\n"),
        color: changed ? 0x22c55e : 0xf59e0b,
        timestamp: new Date().toISOString(),
      }, "SYSTEM");
    } catch (_) { /* best-effort */ }
  }

  return {
    ok: true,
    changed,
    sectors_parsed: sectorCount,
    fingerprint: fp,
    freshness,
    ratings_patch: applied?.ratings_patch || null,
  };
}

export async function syncFsdSectorOutlook(env, outlook = FSD_SECTOR_OUTLOOK_AUG_2026) {
  const kv = env?.KV_TIMED || env?.KV;
  const payload = {
    ...outlook,
    generated_at: Date.now(),
  };
  const ratingsPatch = buildSectorRatingsPatchFromOutlook(payload);

  if (kv) {
    await kvPutJSON(kv, FSD_SECTOR_OUTLOOK_KV_KEY, payload);
    let stored = {};
    try {
      stored = (await kvGetJSON(kv, "timed:admin:sector_ratings")) || {};
    } catch (_) { /* empty */ }
    for (const [sector, val] of Object.entries(ratingsPatch)) {
      stored[sector] = { ...(stored[sector] || {}), ...val };
    }
    await kvPutJSON(kv, "timed:admin:sector_ratings", stored);
  }

  return { ok: true, outlook: payload, ratings_patch: ratingsPatch };
}
