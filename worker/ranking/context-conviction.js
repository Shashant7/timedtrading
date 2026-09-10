// Independent context that technical conviction never scored:
// quality / compounder / theme membership / unsigned fair-value /
// news sentiment / index-inclusion headlines.
//
// Missing is 0. Not a weight fit — these signals already exist on the
// payload and were display-only or signed to the wrong HTF side.
// Cap keeps context from dominating tape (max +18 / min -8).

import { getThemesForTicker } from "../sector-mapping.js";

export const CONTEXT_CONVICTION_VERSION = "context-conviction-v1";
export const CONTEXT_CONVICTION_CAP = 18;

const INDEX_INCLUSION_RE = /\b(s&p\s*500|s&p500|spx|russell\s*2000|nasdaq[- ]?100)\b/i;
const INDEX_VERB_RE = /\b(add(?:ed|s|ition)?|inclu(?:de|sion|ded)|join(?:s|ed)?|constituent)\b/i;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function themeList(d = {}) {
  const fromMap = getThemesForTicker(d.ticker || d.sym) || [];
  const stamped = Array.isArray(d.themes) ? d.themes : [];
  const names = [...fromMap, ...stamped]
    .map((t) => String(typeof t === "string" ? t : t?.theme || "").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function headlinesFromNews(news) {
  const out = [];
  if (!news || typeof news !== "object") return out;
  if (news.top_catalyst?.headline) out.push(String(news.top_catalyst.headline));
  for (const row of news.latest_3 || []) {
    if (row?.headline) out.push(String(row.headline));
  }
  return out;
}

export function newsLooksLikeIndexInclusion(news) {
  for (const h of headlinesFromNews(news)) {
    if (INDEX_INCLUSION_RE.test(h) && INDEX_VERB_RE.test(h)) return true;
  }
  return false;
}

/**
 * @param {object} tickerData
 * @param {string} side LONG | SHORT
 * @returns {{ pts: number, parts: object, version: string }}
 */
export function scoreContextConviction(tickerData = {}, side = null) {
  const dir = String(side || "").toUpperCase();
  const parts = {};
  let pts = 0;

  const fv = tickerData._fair_value || {};
  const stale = fv.stale === true;
  const grade = String(fv.quality_grade || "").toUpperCase();
  const growth = fv.growth_detected === true;
  const compounder = tickerData._compounder || {};
  const elite = String(compounder.tier || "") === "growth_elite" || compounder.eligible === true;

  if (!stale && dir === "LONG") {
    if (grade === "A") { parts.quality = 8; pts += 8; }
    else if (grade === "B") { parts.quality = 5; pts += 5; }
    else parts.quality = 0;
    if (growth) { parts.growth = 2; pts += 2; }
    if (elite) { parts.compounder = 4; pts += 4; }
  } else if (!stale && dir === "SHORT" && (grade === "A" || elite)) {
    // Do not reward fading a quality compounder.
    parts.quality = -4;
    pts -= 4;
  } else {
    parts.quality = 0;
  }

  const themes = themeList(tickerData);
  if (dir === "LONG" && themes.length > 0 && (grade === "A" || grade === "B" || elite)) {
    parts.theme_member = 4;
    pts += 4;
  } else {
    parts.theme_member = 0;
  }

  const rawFvTilt = num(fv.tilt);
  if (!stale && rawFvTilt != null && rawFvTilt !== 0 && (dir === "LONG" || dir === "SHORT")) {
    const signed = dir === "LONG" ? rawFvTilt : -rawFvTilt;
    const add = Math.max(-4, Math.min(4, Math.round(signed)));
    parts.value_tilt = add;
    pts += add;
  } else {
    parts.value_tilt = 0;
  }

  const news = tickerData._news_summary || tickerData.news_summary || null;
  if (news && news.has_data) {
    const dom = String(news.dominant_sentiment || "").toLowerCase();
    if (dir === "LONG" && dom === "bullish") {
      const extra = (Number(news.bullish_catalyst_count) || 0) >= 1 ? 2 : 0;
      parts.sentiment = 6 + extra;
      pts += 6 + extra;
    } else if (dir === "LONG" && dom === "bearish") {
      parts.sentiment = -6;
      pts -= 6;
    } else if (dir === "SHORT" && dom === "bearish") {
      parts.sentiment = 6;
      pts += 6;
    } else {
      parts.sentiment = 0;
    }
    if (newsLooksLikeIndexInclusion(news) && dir === "LONG") {
      parts.index_inclusion = 6;
      pts += 6;
    }
  } else {
    parts.sentiment = 0;
  }

  const capped = Math.max(-8, Math.min(CONTEXT_CONVICTION_CAP, pts));
  return {
    pts: capped,
    raw_pts: pts,
    parts,
    themes,
    version: CONTEXT_CONVICTION_VERSION,
    reason: capped === 0 ? "no_context" : `context_${capped >= 0 ? "+" : ""}${capped}`,
  };
}
