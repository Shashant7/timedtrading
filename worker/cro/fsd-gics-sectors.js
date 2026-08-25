// worker/cro/fsd-gics-sectors.js
// Parse Fundstrat Direct "ETF Sectors" stock lists (GICS Level-1 S&P 500
// membership) and align ticker→sector mapping with our SECTOR_MAP taxonomy.
//
// Source: https://fundstratdirect.com/members/stock-lists/?category=etf-sectors
// (public HTML tables; no login required for the GICS drill-down page).
//
// Per-analyst OW/N/UW (Tom Lee vs Mark Newton) lives on the Sector Allocation
// summary deck — NOT this page. Use fsd-extractor sector_stance_changes for
// composite stance; extend extraction when the deck PDF is ingested.

import { kvGetJSON, kvPutJSON } from "../storage.js";
import { DEFAULT_FSD_CONFIG } from "./fsd-client.js";

export const FSD_GICS_SECTOR_MAP_KV_KEY = "timed:fsd:gics-sector-map";
export const FSD_GICS_SECTOR_META_KV_KEY = "timed:fsd:gics-sector-meta";

/** Map FSD GICS labels → Timed Trading sector keys in SECTOR_RATINGS. */
export const FSD_TO_TT_SECTOR = {
  "Materials": "Basic Materials",
  "Health Care": "Health Care",
  "Healthcare": "Health Care",
  "Information Technology": "Information Technology",
  "Consumer Discretionary": "Consumer Discretionary",
  "Consumer Staples": "Consumer Staples",
  "Financials": "Financials",
  "Industrials": "Industrials",
  "Energy": "Energy",
  "Utilities": "Utilities",
  "Real Estate": "Real Estate",
  "Communication Services": "Communication Services",
};

const GICS_SECTOR_ETFS = {
  "Energy": "XLE",
  "Materials": "XLB",
  "Industrials": "XLI",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  "Health Care": "XLV",
  "Financials": "XLF",
  "Information Technology": "XLK",
  "Communication Services": "XLC",
  "Utilities": "XLU",
  "Real Estate": "XLRE",
};

const TICKER_ROW_RE = /^\|\s*[^|]+\|\s*([A-Z][A-Z0-9.-]{0,5})\s*\|/gm;
const SECTOR_HEADER_RE = /^###\s+(.+?)\s*$/gm;
const ETF_LINE_RE = /^######\s+ETF:\s*([A-Z]+)\s*$/m;
const HTML_SECTOR_ANCHOR_RE = /<a\s+name="sector_([^"]+)"/gi;
const HTML_YAHOO_TICKER_RE = /finance\.yahoo\.com\/quote\/([A-Z][A-Z0-9.-]{0,5})/gi;
const HTML_ETF_TAG_RE = /ETF:\s*(X[A-Z]{2,4})/i;

/** Minimum tickers before we trust a GICS parse (guards empty HTML writes). */
export const GICS_PARSE_MIN_TICKERS = 100;

export function normalizeFsdSectorName(name) {
  const raw = String(name || "").trim();
  return FSD_TO_TT_SECTOR[raw] || raw;
}

export function normalizeGicsTicker(sym) {
  const t = String(sym || "").toUpperCase().trim();
  if (!t || !/^[A-Z]{1,5}(?:-[A-Z]{1,2})?$/.test(t)) return null;
  return t;
}

function ingestGicsSectorBlock({
  sectors,
  tickerToSector,
  tickerToEtf,
  gicsName,
  block,
  etfOverride = null,
}) {
  if (!GICS_SECTOR_ETFS[gicsName]) return;
  const etfMatch = block.match(ETF_LINE_RE) || block.match(HTML_ETF_TAG_RE);
  const etf = etfOverride || etfMatch?.[1] || GICS_SECTOR_ETFS[gicsName];
  const ttSector = normalizeFsdSectorName(gicsName);
  const tickers = new Set(sectors[gicsName]?.tickers || []);

  for (const row of block.matchAll(TICKER_ROW_RE)) {
    const sym = normalizeGicsTicker(row[1]);
    if (!sym || sym === "TICKER") continue;
    tickers.add(sym);
    tickerToSector[sym] = ttSector;
    tickerToEtf[sym] = etf;
  }
  for (const row of block.matchAll(HTML_YAHOO_TICKER_RE)) {
    const sym = normalizeGicsTicker(row[1]);
    if (!sym) continue;
    tickers.add(sym);
    tickerToSector[sym] = ttSector;
    tickerToEtf[sym] = etf;
  }

  sectors[gicsName] = {
    gics: gicsName,
    tt_sector: ttSector,
    etf,
    tickers: [...tickers].sort(),
  };
}

/** Parse legacy markdown-exported GICS page (### headers + pipe tables). */
export function parseFsdGicsSectorMarkdown(text = "") {
  const sectors = {};
  const tickerToSector = {};
  const tickerToEtf = {};
  const src = String(text || "");
  const headerMatches = [...src.matchAll(SECTOR_HEADER_RE)];
  for (let i = 0; i < headerMatches.length; i++) {
    const gicsName = headerMatches[i][1].trim();
    const start = headerMatches[i].index;
    const end = i + 1 < headerMatches.length ? headerMatches[i + 1].index : src.length;
    ingestGicsSectorBlock({
      sectors,
      tickerToSector,
      tickerToEtf,
      gicsName,
      block: src.slice(start, end),
    });
  }
  return { sectors, tickerToSector, tickerToEtf };
}

/** Parse live FSD HTML (anchor sectors + Yahoo quote links in tables). */
export function parseFsdGicsSectorHtml(html = "") {
  const sectors = {};
  const tickerToSector = {};
  const tickerToEtf = {};
  const src = String(html || "");
  const anchors = [...src.matchAll(HTML_SECTOR_ANCHOR_RE)];
  for (let i = 0; i < anchors.length; i++) {
    const gicsName = anchors[i][1].trim();
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : src.length;
    ingestGicsSectorBlock({
      sectors,
      tickerToSector,
      tickerToEtf,
      gicsName,
      block: src.slice(start, end),
    });
  }
  return { sectors, tickerToSector, tickerToEtf };
}

/**
 * Parse the FSD "In Depth Sectors" HTML or markdown-converted page.
 * Returns { sectors, tickerToSector, tickerToEtf, stats }.
 */
export function parseFsdGicsSectorPage(html = "") {
  const text = String(html || "");
  const htmlParsed = parseFsdGicsSectorHtml(text);
  const mdParsed = parseFsdGicsSectorMarkdown(text);
  const useHtml = Object.keys(htmlParsed.tickerToSector).length >= Object.keys(mdParsed.tickerToSector).length;
  const picked = useHtml ? htmlParsed : mdParsed;

  return {
    ...picked,
    stats: {
      sector_count: Object.keys(picked.sectors).length,
      ticker_count: Object.keys(picked.tickerToSector).length,
    },
  };
}

/** Diff FSD GICS map against a curated ticker→sector map (stocks only). */
export function diffSectorMaps(fsdTickerToSector, ourMap) {
  const skipBuckets = new Set([
    "ETF", "Sector ETF", "Thematic ETF", "Commodity ETF",
    "Crypto", "Precious Metals", "Index ETF",
  ]);
  const ours = {};
  for (const [sym, sector] of Object.entries(ourMap || {})) {
    if (!skipBuckets.has(sector)) ours[sym] = sector;
  }

  const fsdTickers = new Set(Object.keys(fsdTickerToSector || {}));
  const ourTickers = new Set(Object.keys(ours));

  const missing_from_ours = [...fsdTickers].filter((t) => !ourTickers.has(t)).sort();
  const extra_in_ours = [...ourTickers].filter((t) => !fsdTickers.has(t)).sort();
  const mismatches = [];
  for (const sym of [...fsdTickers].filter((t) => ourTickers.has(t)).sort()) {
    const fsd = fsdTickerToSector[sym];
    const tt = ours[sym];
    if (fsd !== tt) mismatches.push({ ticker: sym, fsd, ours: tt });
  }

  return {
    fsd_count: fsdTickers.size,
    ours_count: ourTickers.size,
    overlap: [...fsdTickers].filter((t) => ourTickers.has(t)).length,
    missing_from_ours,
    extra_in_ours,
    mismatches,
  };
}

export async function fetchFsdGicsSectorPage(config = DEFAULT_FSD_CONFIG) {
  const url = `${config.base_url}/members/stock-lists/?category=etf-sectors`;
  const res = await fetch(url, {
    headers: { "user-agent": config.user_agent || "TimedTrading/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    return { ok: false, error_kind: "http_error", status: res.status, url };
  }
  const html = await res.text();
  if (/sign\s*in|subscribe|paywall/i.test(html) && !/ETF:\s*XLE/i.test(html)) {
    return { ok: false, error_kind: "paywall", url };
  }
  return { ok: true, html, url, fetched_at: Date.now() };
}

/** Fetch + parse + persist GICS map to KV. */
export async function syncFsdGicsSectorMap(env, { config } = {}) {
  const cfg = config || DEFAULT_FSD_CONFIG;
  const fetched = await fetchFsdGicsSectorPage(cfg);
  if (!fetched.ok) return { ok: false, ...fetched };

  const parsed = parseFsdGicsSectorPage(fetched.html);
  const tickerCount = parsed.stats?.ticker_count || 0;
  if (tickerCount < GICS_PARSE_MIN_TICKERS) {
    const meta = {
      last_sync_at: Date.now(),
      last_sync_ok: false,
      last_error: "parse_incomplete",
      sectors_parsed: parsed.stats?.sector_count || 0,
      tickers_parsed: tickerCount,
    };
    const kv = env?.KV_TIMED || env?.KV;
    if (kv) await kvPutJSON(kv, FSD_GICS_SECTOR_META_KV_KEY, meta);
    return {
      ok: false,
      error_kind: "parse_incomplete",
      tickers_parsed: tickerCount,
      sectors_parsed: parsed.stats?.sector_count || 0,
      source_url: fetched.url,
    };
  }
  const { SECTOR_MAP } = await import("../sector-mapping.js");
  const diff = diffSectorMaps(parsed.tickerToSector, SECTOR_MAP);
  const payload = {
    generated_at: Date.now(),
    source_url: fetched.url,
    ...parsed,
    diff,
  };

  const kv = env?.KV_TIMED || env?.KV;
  if (kv) {
    await kvPutJSON(kv, FSD_GICS_SECTOR_MAP_KV_KEY, {
      generated_at: payload.generated_at,
      source_url: payload.source_url,
      sectors: payload.sectors,
      tickerToSector: payload.tickerToSector,
      tickerToEtf: payload.tickerToEtf,
      stats: payload.stats,
      diff: payload.diff,
    });
    await kvPutJSON(kv, FSD_GICS_SECTOR_META_KV_KEY, {
      last_sync_at: payload.generated_at,
      last_sync_ok: true,
      stats: payload.stats,
      diff_summary: {
        missing_from_ours: diff.missing_from_ours.length,
        extra_in_ours: diff.extra_in_ours.length,
        mismatches: diff.mismatches.length,
      },
    });
  }

  return { ok: true, ...payload };
}

export async function getFsdGicsSectorMap(env) {
  const kv = env?.KV_TIMED || env?.KV;
  if (!kv) return null;
  return kvGetJSON(kv, FSD_GICS_SECTOR_MAP_KV_KEY);
}

/** Resolve sector for a ticker: FSD GICS KV first, then curated SECTOR_MAP. */
export async function resolveTickerSector(env, ticker) {
  const sym = normalizeGicsTicker(ticker);
  if (!sym) return null;
  const map = await getFsdGicsSectorMap(env);
  if (map?.tickerToSector?.[sym]) {
    return { sector: map.tickerToSector[sym], source: "fsd_gics", etf: map.tickerToEtf?.[sym] || null };
  }
  const { SECTOR_MAP } = await import("../sector-mapping.js");
  const curated = SECTOR_MAP[sym];
  if (curated && !["ETF", "Sector ETF", "Thematic ETF", "Commodity ETF"].includes(curated)) {
    return { sector: normalizeFsdSectorName(curated), source: "sector_map", etf: null };
  }
  return curated ? { sector: curated, source: "sector_map", etf: null } : null;
}
