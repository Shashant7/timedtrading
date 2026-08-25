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
  const text = String(html);
  return /Become a Member To Access/i.test(text)
    && !/Health Care[\s\S]{0,400}XLV/i.test(text)
    && Object.keys(parseFsdSectorOutlookTable(stripHtmlToTableText(text)).sectors || {}).length < 8;
}

export function stripHtmlToTableText(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#8211;/g, "-");
}

/** Parse authenticated ETF Outlook HTML into sector rows. */
export function parseFsdEtfOutlookHtml(html = "") {
  const text = stripHtmlToTableText(html);
  const parsed = parseFsdSectorOutlookTable(text);
  if (Object.keys(parsed.sectors || {}).length >= 8) return parsed;

  // Fallback: row scan for "Sector ETF wt wt delta OW N" patterns in raw HTML.
  const sectors = { ...parsed.sectors };
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

export async function fetchFsdEtfOutlookPage(env) {
  const { fetchAuthenticatedFsdPage } = await import("./fsd-client.js");
  return fetchAuthenticatedFsdPage(env, FSD_ETF_OUTLOOK_PATH);
}

/**
 * Authenticated pull of etf-outlook page → parse → apply if changed.
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
    return { ok: false, error_kind: "parse_incomplete", sectors_parsed: sectorCount, changed: false, freshness: assessSectorOutlookFreshness(prev) };
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
