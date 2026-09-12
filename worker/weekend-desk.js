/**
 * Weekend CMT Desk — Saturday/Sunday prep when RTH scoring is skipped.
 *
 * Mimics a professional CMT pass across the universe: trendlines, EMA
 * structure, SuperTrend slope/flat magnets, FVG imbalance, news/analyst
 * tilt, Momentum Elite, then folds those stamps into Timed Upticks.
 * Screener promotion candidates outside the book stay on the same desk.
 *
 * Highlight / email only. Not a new buy path. Do not add
 * `tt_weekend_upticks`. Setup grade and qualifiesForEnter stay unchanged.
 */

import { emailLayout, buildUnsubscribeUrl, getEmailOptedInUsers, sendEmail } from "./email.js";
import {
  readBreakoutWatch,
  watchPromotesToSetup,
  breakoutWatchLookForEntryCopy,
} from "./breakout-watch.js";

export const WEEKEND_DESK_KV = "timed:weekend-desk:latest";
export const WEEKEND_DESK_CURSOR_KV = "timed:weekend-desk:rescore-cursor";
export const WEEKEND_DESK_SENT_PREFIX = "timed:weekend-desk:sent:";
export const WEEKEND_DESK_PREF = "weekend_desk";
export const WEEKEND_DESK_PAGE = "https://timed-trading.com/today.html";

const BRAND = {
  green: "#00c853",
  textSecondary: "#9ca3af",
  textMuted: "#6b7280",
  border: "#1e2128",
  warning: "#f59e0b",
  editorial: "#a78bfa",
};

const UPTICK_MIN_SCORE = 36;
const UPTICK_MIN_FAMILIES = 2;
const SECTION_LIMIT = 10;
const UPTICK_LIMIT = 12;

function _n(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _dir(v) {
  const s = String(v || "").toUpperCase();
  return s === "LONG" || s === "SHORT" ? s : null;
}

function _esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nyParts(nowMs = Date.now()) {
  const raw = new Date(nowMs).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    hour12: false,
  });
  // "Sat, 09/12/2026, 10"
  const bits = raw.split(",").map((s) => s.trim());
  const weekday = bits[0] || "";
  const md = (bits[1] || "").split("/");
  let hour = parseInt(bits[2] || "0", 10);
  if (hour === 24) hour = 0;
  const month = md[0] || "01";
  const day = md[1] || "01";
  const year = md[2] || "1970";
  return { weekday, hour, year, month, day, iso: `${year}-${month}-${day}` };
}

/**
 * Saturday NY date of the current/adjacent weekend.
 * Sat Sep 12 and Sun Sep 13 share 2026-09-12 so the email lock is once
 * per weekend.
 */
export function weekendDeskKey(nowMs = Date.now()) {
  const p = nyParts(nowMs);
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const [y, m, d] = p.iso.split("-").map(Number);
  const utcNoon = Date.UTC(y, m - 1, d, 12, 0, 0);
  let delta = 0;
  if (dow === 0) delta = -1;
  else if (dow === 6) delta = 0;
  else if (dow === 5) delta = 1;
  else delta = -((dow + 1) % 7);
  return new Date(utcNoon + delta * 86400000).toISOString().slice(0, 10);
}

export function weekendDeskSlot(nowMs = Date.now()) {
  const { weekday, hour } = nyParts(nowMs);
  if (weekday === "Sat" && hour === 10) return { fire: true, action: "full" };
  if (weekday === "Sun" && hour === 10) return { fire: true, action: "refresh" };
  if (weekday === "Sat" && hour >= 11 && hour <= 16) {
    return { fire: true, action: "rescore_continue" };
  }
  return { fire: false, action: null };
}

export function weekendDeskLabel(nowMs = Date.now()) {
  const p = nyParts(nowMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[Number(p.month) - 1] || p.month;
  return `${p.weekday} ${mon} ${Number(p.day)}`;
}

function holdTimeframes(flags = {}) {
  const tfs = [];
  if (flags.st_hold_M) tfs.push("M");
  if (flags.st_hold_W) tfs.push("W");
  if (flags.st_hold_D) tfs.push("D");
  if (flags.st_hold_4h) tfs.push("4H");
  return tfs;
}

function magnetTimeframes(flags = {}) {
  const tfs = [];
  if (flags.st_magnet_M) tfs.push("M");
  if (flags.st_magnet_W) tfs.push("W");
  if (flags.st_magnet_D) tfs.push("D");
  if (flags.st_magnet_4h) tfs.push("4H");
  return tfs;
}

function emaStructureNote(td, flags) {
  const depthD = _n(td?.ema_map?.D?.depth);
  const structD = _n(td?.ema_map?.D?.structure);
  const depthW = _n(td?.ema_map?.W?.depth);
  const structW = _n(td?.ema_map?.W?.structure);
  const regime = _n(td?.ema_regime_daily ?? flags?.ema_regime_D);
  const parts = [];
  if (regime != null && Math.abs(regime) >= 2) {
    parts.push(regime > 0 ? "Daily EMA regime stacked long" : "Daily EMA regime stacked short");
  } else if (flags?.ema13above21_D && flags?.ema5above48_D) {
    parts.push("Daily 5>48 and 13>21 — stacked long");
  } else if (flags?.ema13above21_D === false && flags?.ema5above48_D === false && regime != null && regime < 0) {
    parts.push("Daily EMAs stacked short");
  }
  if (depthD != null && depthD >= 7) parts.push(`Daily EMA depth ${depthD}/10`);
  if (structD != null && Math.abs(structD) >= 0.4) {
    parts.push(structD > 0 ? "Daily EMA structure rising" : "Daily EMA structure falling");
  }
  if (depthW != null && depthW >= 7) parts.push(`Weekly EMA depth ${depthW}/10`);
  if (structW != null && Math.abs(structW) >= 0.4) {
    parts.push(structW > 0 ? "Weekly EMA structure rising" : "Weekly EMA structure falling");
  }
  return parts;
}

function imbalanceNote(imb) {
  if (!imb || typeof imb !== "object") return [];
  const dir = String(imb.imbalance_direction || "");
  const down = _n(imb.downside_magnets) || 0;
  const up = _n(imb.upside_magnets) || 0;
  const below = _n(imb.unfilled_below) || 0;
  const notes = [];
  if (dir === "LONG_OPPORTUNITY" || dir === "BULLISH_LEAN") {
    notes.push(`Imbalance ${dir.replace(/_/g, " ").toLowerCase()} — ${up} upside magnets`);
  } else if (dir === "SHORT_OPPORTUNITY" || dir === "BEARISH_LEAN") {
    notes.push(`Imbalance ${dir.replace(/_/g, " ").toLowerCase()} — ${down} downside magnets`);
  } else if (below >= 2) {
    notes.push(`${below} unfilled bull gaps below — support / magnet to balance`);
  } else if (down >= 3 && down > up) {
    notes.push(`${down} downside magnets acting as support to close`);
  }
  return notes;
}

function newsNote(news) {
  if (!news || news.has_data !== true) return [];
  const notes = [];
  const dom = String(news.dominant_sentiment || "neutral");
  if (dom === "bullish" || dom === "bearish") {
    notes.push(`Recent news lean ${dom} (${news.bull || 0} / ${news.bear || 0} / ${news.neutral || 0})`);
  }
  const top = news.top_catalyst;
  if (top?.headline) {
    const sent = top.sentiment ? `${top.sentiment} ` : "";
    notes.push(`${sent}catalyst: ${String(top.headline).slice(0, 140)}`);
  }
  return notes;
}

function analystNote(td) {
  const fund = td?.fundamentals && typeof td.fundamentals === "object" ? td.fundamentals : null;
  const notes = [];
  const rating = _n(fund?.analyst_rating ?? fund?.recommendation_score ?? td?.analyst_consensus);
  const count = _n(fund?.number_of_analysts ?? td?.analyst_count);
  const target = _n(fund?.target_mean ?? fund?.analyst_target ?? td?.price_target);
  const px = _n(td?.price ?? td?.close);
  if (rating != null && rating >= 4 && (count == null || count >= 5)) {
    notes.push(`Analyst consensus ${rating.toFixed(2)}/5${count != null ? ` across ${count}` : ""}`);
  } else if (rating != null && rating <= 2.5 && (count == null || count >= 5)) {
    notes.push(`Analyst consensus skeptical ${rating.toFixed(2)}/5`);
  }
  if (target != null && px != null && px > 0) {
    const gap = ((target - px) / px) * 100;
    if (Math.abs(gap) >= 15) {
      notes.push(`Mean target ${gap >= 0 ? "+" : ""}${gap.toFixed(0)}% vs last`);
    }
  }
  if (td?._compounder === true || td?.flags?.compounder === true) {
    notes.push("Compounder quality flag");
  }
  return notes;
}

/**
 * Pure CMT card from an already-scored ticker payload.
 * Additive highlight score — not a new rank formula and not an entry gate.
 */
export function analyzeTickerForWeekendDesk(td, extras = {}) {
  const ticker = String(td?.ticker || td?.sym || "").toUpperCase();
  if (!ticker) return null;
  const flags = td?.flags && typeof td.flags === "object" ? td.flags : {};
  const watch = readBreakoutWatch(td);
  const news = td?._news_summary || td?.news_summary || null;
  const imb = td?.fvg_imbalance_D || td?.__fvg_imbalance || {};
  const notes = [];
  const tags = [];
  const families = new Set();
  let score = 0;
  let dir = _dir(watch?.dir) || _dir(flags.breakout_watch_dir) || _dir(flags.momentum_elite_dir);

  if (watch?.retest) {
    score += 22;
    tags.push("retest");
    families.add("trendline");
    notes.push(breakoutWatchLookForEntryCopy({ ...watch, retest: true }) || "Broken line retest — look for a good entry");
    dir = dir || _dir(watch.dir);
  } else if (watchPromotesToSetup(watch) || flags.breakout_watch) {
    score += 18;
    tags.push("breakout");
    families.add("trendline");
    notes.push(breakoutWatchLookForEntryCopy(watch) || "Level or trendline breakout — look for a good entry");
    dir = dir || _dir(watch?.dir);
  } else if (watch?.approaching || flags.breakout_approaching) {
    score += 10;
    tags.push("tl_watch");
    families.add("trendline");
    notes.push(breakoutWatchLookForEntryCopy(watch) || "Trendline nearby — watching for a break");
    dir = dir || _dir(watch?.dir);
  }

  const holdTfs = holdTimeframes(flags);
  if (flags.st_hold || holdTfs.length) {
    score += 10 + Math.min(6, holdTfs.length * 2);
    tags.push("st_hold");
    families.add("supertrend");
    notes.push(`SuperTrend hold on ${holdTfs.join("/") || "HTF"}`);
  }
  const magTfs = magnetTimeframes(flags);
  if (flags.st_magnet || magTfs.length) {
    score += 14;
    tags.push("st_magnet");
    families.add("supertrend");
    const magnet = td?.st_hold_setup?.magnet;
    const side = _dir(magnet?.sideLabel || magnet?.side);
    if (side) dir = dir || side;
    notes.push(`Flat SuperTrend magnet on ${magTfs.join("/") || "HTF"} — acting as a magnet`);
  }
  if (flags.st_flip_extended) {
    score += 3;
    tags.push("st_stretch");
    families.add("supertrend");
    notes.push("SuperTrend flip is extended — do not chase the stretch");
  }

  const emaNotes = emaStructureNote(td, flags);
  if (emaNotes.length) {
    const regime = _n(td?.ema_regime_daily ?? flags?.ema_regime_D);
    score += regime != null && Math.abs(regime) >= 2 ? 10 : 6;
    tags.push(regime != null && regime < 0 ? "ema_short" : "ema_long");
    families.add("ema");
    notes.push(...emaNotes.slice(0, 2));
    if (regime != null && regime >= 2) dir = dir || "LONG";
    if (regime != null && regime <= -2) dir = dir || "SHORT";
  }

  const imbNotes = imbalanceNote(imb);
  if (imbNotes.length) {
    const imbDir = String(imb.imbalance_direction || "");
    score += imbDir === "LONG_OPPORTUNITY" || imbDir === "SHORT_OPPORTUNITY" ? 12 : 7;
    tags.push("imbalance");
    families.add("imbalance");
    notes.push(...imbNotes);
    if (imbDir.includes("LONG") || imbDir === "BULLISH_LEAN") dir = dir || "LONG";
    if (imbDir.includes("SHORT") || imbDir === "BEARISH_LEAN") dir = dir || "SHORT";
  } else if ((flags.fvg_in_bull_D || 0) > 0) {
    score += 5;
    tags.push("fvg_support");
    families.add("imbalance");
    notes.push("Price sitting in a daily bull FVG — imbalance as support");
  }

  if (flags.momentum_elite) {
    score += 16;
    tags.push("momentum_elite");
    families.add("momentum");
    const meDir = _dir(flags.momentum_elite_dir);
    if (meDir) dir = dir || meDir;
    notes.push(`Momentum Elite${meDir ? ` ${meDir}` : ""}`);
  }

  const nNotes = newsNote(news);
  if (nNotes.length) {
    const dom = String(news.dominant_sentiment || "");
    score += dom === "bullish" || dom === "bearish" ? 8 : 4;
    if ((news.bullish_catalyst_count || 0) + (news.bearish_catalyst_count || 0) > 0) score += 3;
    tags.push("news");
    families.add("news");
    notes.push(...nNotes.slice(0, 2));
    if (dom === "bullish") dir = dir || "LONG";
    if (dom === "bearish") dir = dir || "SHORT";
  }

  const aNotes = analystNote(td);
  if (aNotes.length) {
    score += 6;
    tags.push("analyst");
    families.add("news");
    notes.push(...aNotes.slice(0, 2));
  }

  const conv = _n(td?.__focus_conviction_score ?? td?.__conviction_score ?? td?.conviction);
  const rank = _n(td?.rank);
  const tier = String(td?.__focus_tier || "").toUpperCase();
  if (tier === "A" || (conv != null && conv >= 110)) {
    score += 8;
    tags.push("conviction_a");
    families.add("conviction");
    notes.push(`Conviction ${tier || "A"}${conv != null ? ` (${Math.round(conv)})` : ""}`);
  } else if (conv != null && conv >= 80) {
    score += 4;
    tags.push("conviction_b");
    families.add("conviction");
  }
  if (rank != null && rank >= 70) {
    score += 4;
    if (!families.has("conviction")) families.add("conviction");
    notes.push(`Rank ${Math.round(rank)}`);
  }

  if (extras.newtonUpticks instanceof Set && extras.newtonUpticks.has(ticker)) {
    score += 5;
    tags.push("newton_upticks");
    families.add("newton");
    notes.push("On Newton's published Upticks list");
  }

  const familyList = [...families];
  const timedUptick = score >= UPTICK_MIN_SCORE && familyList.length >= UPTICK_MIN_FAMILIES;
  if (timedUptick) tags.unshift("timed_uptick");

  return {
    ticker,
    score,
    dir: dir || null,
    tags,
    families: familyList,
    notes: notes.slice(0, 6),
    timed_uptick: timedUptick,
    rank: rank,
    conviction: conv,
    focus_tier: tier || null,
    headline: notes[0] || `${ticker} weekend mark`,
  };
}

function takeTop(cards, pred, limit = SECTION_LIMIT) {
  return cards.filter(pred).sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker)).slice(0, limit);
}

export function compactPromotionCandidate(row) {
  const ticker = String(row?.ticker || "").toUpperCase();
  if (!ticker) return null;
  const inUniverse = row?.in_universe === true || row?.signals?.in_universe === true
    || row?.already_tracked === true || row?.signals?.already_tracked === true;
  if (inUniverse) return null;
  const status = String(row?.status || "");
  if (status !== "needs_review" && status !== "ready_to_add") return null;
  return {
    ticker,
    status,
    score: _n(row?.total_score) || 0,
    thesis: String(row?.thesis_text || "").slice(0, 220),
    in_universe: false,
  };
}

/**
 * Pure. Rank already-analyzed cards into desk buckets.
 */
export function composeWeekendDesk({
  cards = [],
  promotions = [],
  now = Date.now(),
  scanned = 0,
  rescore = null,
} = {}) {
  const clean = (cards || []).filter((c) => c && c.ticker);
  const upticks = takeTop(clean, (c) => c.timed_uptick, UPTICK_LIMIT);
  const trendlines = takeTop(clean, (c) => c.tags.includes("retest") || c.tags.includes("breakout") || c.tags.includes("tl_watch"));
  const supertrend = takeTop(clean, (c) => c.tags.includes("st_magnet") || c.tags.includes("st_hold"));
  const imbalance = takeTop(clean, (c) => c.tags.includes("imbalance") || c.tags.includes("fvg_support"));
  const ema = takeTop(clean, (c) => c.tags.includes("ema_long") || c.tags.includes("ema_short"));
  const elite = takeTop(clean, (c) => c.tags.includes("momentum_elite"));
  const news = takeTop(clean, (c) => c.tags.includes("news") || c.tags.includes("analyst"));
  const promo = (promotions || []).filter(Boolean).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, SECTION_LIMIT);

  return {
    ok: true,
    generated_at: now,
    weekend_key: weekendDeskKey(now),
    label: weekendDeskLabel(now),
    scanned: scanned || clean.length,
    marked: clean.length,
    counts: {
      timed_upticks: upticks.length,
      trendlines: trendlines.length,
      supertrend: supertrend.length,
      imbalance: imbalance.length,
      ema: ema.length,
      momentum_elite: elite.length,
      news: news.length,
      promotion_candidates: promo.length,
    },
    timed_upticks: upticks,
    trendlines,
    supertrend,
    imbalance,
    ema,
    momentum_elite: elite,
    news,
    promotion_candidates: promo,
    rescore: rescore || null,
    disclaimer: "Timed Upticks are the weekend confluence list — not Newton's monthly Upticks, and not a buy list. Look for a good entry; the model does not auto-buy from this desk.",
  };
}

function cardLine(c) {
  const dir = c.dir ? ` ${c.dir}` : "";
  const note = (c.notes && c.notes[0]) || c.headline || "";
  return `${c.ticker}${dir} · ${note}`;
}

export function renderWeekendDeskText(desk) {
  const lines = [
    `Weekend Desk — Timed Upticks · ${desk.label}`,
    desk.disclaimer,
    "",
    `Scanned ${desk.scanned} names. Timed Upticks: ${desk.counts.timed_upticks}.`,
    "",
    "TIMED UPTICKS",
    ...(desk.timed_upticks || []).map((c) => `- ${cardLine(c)}`),
    "",
    "TRENDLINES / BREAKOUTS",
    ...(desk.trendlines || []).map((c) => `- ${cardLine(c)}`),
    "",
    "SUPERTREND MAGNETS + HOLDS",
    ...(desk.supertrend || []).map((c) => `- ${cardLine(c)}`),
    "",
    "IMBALANCE",
    ...(desk.imbalance || []).map((c) => `- ${cardLine(c)}`),
    "",
    "MOMENTUM ELITE",
    ...(desk.momentum_elite || []).map((c) => `- ${cardLine(c)}`),
    "",
    "NEWS + ANALYST",
    ...(desk.news || []).map((c) => `- ${cardLine(c)}`),
    "",
    "SCREENER — OUTSIDE THE UNIVERSE",
    ...(desk.promotion_candidates || []).map((c) => `- ${c.ticker} · ${c.thesis || c.status}`),
    "",
    `Open Today: ${WEEKEND_DESK_PAGE}`,
  ];
  return lines.join("\n");
}

function sectionTable(title, rows, renderRow) {
  if (!rows || !rows.length) {
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">
      <tr><td style="padding:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">${_esc(title)}</td></tr>
      <tr><td style="font-size:12px;color:${BRAND.textMuted}">None marked this weekend.</td></tr>
    </table>`;
  }
  const body = rows.map(renderRow).join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px">
    <tr><td style="padding:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">${_esc(title)}</td></tr>
    ${body}
  </table>`;
}

function tickerRow(c) {
  const dirColor = c.dir === "SHORT" ? "#ef4444" : BRAND.green;
  const dir = c.dir
    ? `<span style="color:${dirColor};font-weight:700;font-size:11px">${_esc(c.dir)}</span>`
    : "";
  const tags = (c.tags || []).filter((t) => t !== "timed_uptick").slice(0, 4)
    .map((t) => t.replace(/_/g, " "))
    .join(" · ");
  return `<tr><td style="padding:8px 0;border-bottom:1px solid ${BRAND.border}">
    <div style="font-size:14px;font-weight:700;color:white">${_esc(c.ticker)} ${dir}</div>
    <div style="font-size:12px;color:${BRAND.textSecondary};line-height:1.45;margin-top:2px">${_esc(c.notes?.[0] || c.headline || "")}</div>
    ${tags ? `<div style="font-size:10px;color:${BRAND.textMuted};margin-top:3px">${_esc(tags)}</div>` : ""}
  </td></tr>`;
}

function promoRow(c) {
  return `<tr><td style="padding:8px 0;border-bottom:1px solid ${BRAND.border}">
    <div style="font-size:14px;font-weight:700;color:white">${_esc(c.ticker)} <span style="font-size:10px;color:${BRAND.warning};font-weight:700">OUTSIDE BOOK</span></div>
    <div style="font-size:12px;color:${BRAND.textSecondary};line-height:1.45;margin-top:2px">${_esc(c.thesis || c.status)}</div>
  </td></tr>`;
}

export function renderWeekendDeskHtml(desk, { unsubscribeUrl } = {}) {
  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:white">Weekend Desk</h1>
    <p style="margin:0 0 6px;font-size:13px;color:${BRAND.editorial};letter-spacing:0.04em;text-transform:uppercase">Timed Upticks · ${_esc(desk.label)}</p>
    <p style="margin:0 0 18px;font-size:14px;color:${BRAND.textSecondary};line-height:1.55">
      Saturday CMT pass across the universe: trendlines, EMA structure, SuperTrend magnets, imbalance, news, and Momentum Elite. Timed Upticks are the names with the most confluence — not Newton's monthly list, and not a buy list.
    </p>
    <p style="margin:0 0 20px;font-size:12px;color:${BRAND.textMuted}">
      Scanned ${desk.scanned} names · ${desk.counts.timed_upticks} Timed Upticks · ${desk.counts.promotion_candidates} screener candidates outside the book.
    </p>
    ${sectionTable("Timed Upticks", desk.timed_upticks, tickerRow)}
    ${sectionTable("Trendlines / breakouts", desk.trendlines, tickerRow)}
    ${sectionTable("SuperTrend magnets + holds", desk.supertrend, tickerRow)}
    ${sectionTable("Imbalance / FVG", desk.imbalance, tickerRow)}
    ${sectionTable("EMA structure", desk.ema, tickerRow)}
    ${sectionTable("Momentum Elite", desk.momentum_elite, tickerRow)}
    ${sectionTable("News + analyst / fundamentals", desk.news, tickerRow)}
    ${sectionTable("Screener — candidates to promote", desk.promotion_candidates, promoRow)}
    <p style="margin:8px 0 0;font-size:12px">
      <a href="${WEEKEND_DESK_PAGE}" style="color:${BRAND.green};text-decoration:none;font-weight:600">Open Today →</a>
    </p>
    <p style="margin:14px 0 0;font-size:11px;color:${BRAND.textMuted};line-height:1.45">${_esc(desk.disclaimer)}</p>
  `;
  return emailLayout(body, {
    unsubscribeUrl,
    preheader: `Weekend Desk — ${desk.counts.timed_upticks} Timed Upticks · ${desk.label}`,
  });
}

export function weekendDeskHasYouYour(htmlOrText) {
  return /\b(you|your|you're|you've|you'll)\b/i.test(String(htmlOrText || ""));
}

export async function loadUniversePayloads(env) {
  const db = env?.DB;
  if (!db) return [];
  const rows = (await db.prepare(
    `SELECT ticker, payload_json FROM ticker_latest`,
  ).all().catch(() => ({ results: [] })))?.results || [];
  const out = [];
  for (const r of rows) {
    let payload = r.payload_json;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { continue; }
    }
    if (!payload || typeof payload !== "object") continue;
    const ticker = String(r.ticker || payload.ticker || "").toUpperCase();
    if (!ticker) continue;
    out.push({ ...payload, ticker });
  }
  return out;
}

export async function loadNewtonUpticksSet(env) {
  const set = new Set();
  try {
    const raw = await (env?.KV_TIMED || env?.KV)?.get("timed:admin:upticks");
    if (!raw) return set;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const list = Array.isArray(parsed) ? parsed : (parsed?.tickers || []);
    for (const t of list) {
      const sym = String(t || "").toUpperCase();
      if (sym) set.add(sym);
    }
  } catch (_) { /* empty */ }
  return set;
}

export async function loadPromotionCandidates(env) {
  try {
    const PromotionQueue = await import("./discovery/promotion-queue.js");
    const [review, ready] = await Promise.all([
      PromotionQueue.loadPromotionQueueRows(env, { status: "needs_review", limit: 40 }),
      PromotionQueue.loadPromotionQueueRows(env, { status: "ready_to_add", limit: 40 }),
    ]);
    const rows = [...(review?.rows || []), ...(ready?.rows || [])];
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      const card = compactPromotionCandidate(row);
      if (!card || seen.has(card.ticker)) continue;
      seen.add(card.ticker);
      out.push(card);
    }
    return out;
  } catch (_) {
    return [];
  }
}

export async function persistWeekendDesk(env, desk) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV || !desk) return false;
  await KV.put(WEEKEND_DESK_KV, JSON.stringify(desk), { expirationTtl: 14 * 86400 });
  return true;
}

export async function loadWeekendDesk(env) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return null;
  try {
    const raw = await KV.get(WEEKEND_DESK_KV, "json");
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

async function claimWeekendSendLock(env, weekendKey) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return { ok: true, reason: "no_kv", weekendKey };
  const lockKey = `${WEEKEND_DESK_SENT_PREFIX}${weekendKey}`;
  try {
    const existing = await KV.get(lockKey);
    if (existing) return { ok: false, reason: "already_sent", weekendKey, lockKey };
    const claim = JSON.stringify({ claimed_at: Date.now(), status: "pending" });
    await KV.put(lockKey, claim, { expirationTtl: 14 * 86400 });
    await new Promise((r) => setTimeout(r, 50));
    const winner = await KV.get(lockKey);
    if (winner && winner !== claim) return { ok: false, reason: "lost_race", weekendKey, lockKey };
    return { ok: true, weekendKey, lockKey, claim };
  } catch (e) {
    return { ok: true, reason: "lock_error", weekendKey, error: String(e?.message || e).slice(0, 120) };
  }
}

async function markWeekendSent(env, lock, result = {}) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV || !lock?.lockKey) return;
  try {
    await KV.put(lock.lockKey, JSON.stringify({
      claimed_at: Date.now(),
      status: "sent",
      sent: result.sent ?? null,
      recipients: result.recipients ?? null,
    }), { expirationTtl: 14 * 86400 });
  } catch (_) { /* best-effort */ }
}

export async function sendWeekendDeskEmails(env, desk, { sendFn = sendEmail } = {}) {
  const optedRaw = await getEmailOptedInUsers(env, WEEKEND_DESK_PREF).catch(() => []);
  const seen = new Set();
  const opted = [];
  for (const u of optedRaw) {
    const email = String(u?.email || "").toLowerCase().trim();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    opted.push(u);
  }
  if (!opted.length) return { sent: 0, failed: 0, recipients: 0 };
  const baseUrl = String(env?.WORKER_URL || "https://timed-trading.com").replace(/\/$/, "");
  let sent = 0;
  let failed = 0;
  for (const u of opted) {
    const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
      ? await buildUnsubscribeUrl(baseUrl, u.email, WEEKEND_DESK_PREF, env.EMAIL_HMAC_SECRET).catch(() => null)
      : null;
    const html = renderWeekendDeskHtml(desk, { unsubscribeUrl });
    const text = renderWeekendDeskText(desk);
    try {
      const r = await sendFn(env, {
        to: u.email,
        subject: `Weekend Desk — Timed Upticks · ${desk.label}`,
        html,
        text,
        category: WEEKEND_DESK_PREF,
      });
      if (r?.ok) sent += 1;
      else failed += 1;
    } catch (_) {
      failed += 1;
    }
  }
  return { sent, failed, recipients: opted.length };
}

export async function composeWeekendDeskFromEnv(env, { now = Date.now(), rescore = null } = {}) {
  const [payloads, newtonUpticks, promotions] = await Promise.all([
    loadUniversePayloads(env),
    loadNewtonUpticksSet(env),
    loadPromotionCandidates(env),
  ]);
  const cards = [];
  for (const td of payloads) {
    const card = analyzeTickerForWeekendDesk(td, { newtonUpticks });
    if (card && (card.score > 0 || card.timed_uptick)) cards.push(card);
  }
  return composeWeekendDesk({
    cards,
    promotions,
    now,
    scanned: payloads.length,
    rescore,
  });
}

/**
 * Orchestrate a weekend pass.
 * @param {object} opts.rescorePage  (opts) => rescoreStaleUniverse result
 * @param {object} opts.sendFn       sendEmail
 * @param {object} opts.notify       Discord embed fn
 */
export async function runWeekendDesk(env, opts = {}) {
  const now = opts.now || Date.now();
  const action = opts.action || "full";
  const wantRescore = opts.rescore === true || action === "full" || action === "rescore_continue";
  const wantEmail = opts.email === true || action === "full" || (action === "refresh" && opts.email !== false);
  const forceEmail = opts.forceEmail === true;
  let rescore = null;

  if (wantRescore && typeof opts.rescorePage === "function") {
    rescore = await opts.rescorePage({
      all: true,
      limit: Number(opts.rescoreLimit) || 20,
      offset: Number(opts.rescoreOffset) || 0,
      dedupe: false,
      forcePostClose: false,
    });
    try {
      await (env?.KV_TIMED || env?.KV)?.put(WEEKEND_DESK_CURSOR_KV, JSON.stringify({
        weekend_key: weekendDeskKey(now),
        offset: rescore?.next_offset || 0,
        remaining: rescore?.remaining || 0,
        updated_at: now,
      }), { expirationTtl: 7 * 86400 });
    } catch (_) { /* best-effort */ }
    if ((rescore?.remaining || 0) > 0 && opts.continueRescore !== false && typeof env?._selfDispatch === "function") {
      const nextOff = rescore.next_offset || 0;
      const lim = Number(opts.rescoreLimit) || 20;
      env._executionCtx?.waitUntil?.(
        env._selfDispatch(
          `/timed/admin/weekend-desk?phase=rescore&offset=${nextOff}&limit=${lim}`,
          { method: "POST" },
        ).catch((e) => console.warn("[WEEKEND DESK] rescore continue failed:", String(e?.message || e).slice(0, 160))),
      );
    }
  }

  const remaining = Number(rescore?.remaining || 0);
  const rescoreDone = !wantRescore || remaining === 0;
  const composeNow = opts.compose !== false && (action !== "rescore_continue" || rescoreDone);
  let desk = null;
  let stored = false;
  if (composeNow) {
    desk = await composeWeekendDeskFromEnv(env, { now, rescore });
    stored = await persistWeekendDesk(env, desk);
  } else {
    desk = await loadWeekendDesk(env);
  }

  let email = { sent: 0, failed: 0, recipients: 0, skipped: "not_requested" };
  const shouldEmail = !!(desk && composeNow && (
    forceEmail
    || (rescoreDone && (wantEmail || action === "full" || action === "refresh" || action === "rescore_continue"))
  ));
  if (shouldEmail) {
    const weekendKey = desk.weekend_key || weekendDeskKey(now);
    const lock = forceEmail
      ? { ok: true, weekendKey }
      : await claimWeekendSendLock(env, weekendKey);
    if (!lock.ok && !forceEmail) {
      email = { sent: 0, failed: 0, recipients: 0, skipped: lock.reason };
    } else {
      email = await sendWeekendDeskEmails(env, desk, { sendFn: opts.sendFn || sendEmail });
      email.skipped = null;
      await markWeekendSent(env, { ...lock, claimed_at: now }, email);
    }
  }

  if (typeof opts.notify === "function" && desk && action !== "rescore_continue") {
    try {
      await opts.notify({
        title: `WEEKEND DESK · ${desk.label}`,
        description: [
          `Timed Upticks: ${(desk.timed_upticks || []).map((c) => c.ticker).join(", ") || "none"}`,
          `Trendlines ${desk.counts.trendlines} · ST ${desk.counts.supertrend} · Elite ${desk.counts.momentum_elite} · Promote ${desk.counts.promotion_candidates}`,
          email.skipped ? `Email: ${email.skipped}` : `Email ${email.sent}/${email.recipients}`,
        ].join("\n"),
        color: 0xa78bfa,
      });
    } catch (_) { /* best-effort */ }
  }

  return { ok: true, action, desk, stored, email, rescore };
}
