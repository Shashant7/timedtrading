/**
 * Weekend CMT Desk — Saturday/Sunday prep when RTH scoring is skipped.
 *
 * Mimics a professional CMT pass across the universe: trendlines, volume,
 * EMA structure, SuperTrend slope/flat magnets, FVG imbalance, news/analyst
 * tilt, Momentum Elite. The subscriber email is TT Setups — a short unique
 * list of stories + charts, not an indicator dump.
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
import { SECTOR_MAP } from "./sector-mapping.js";
import { attachNewsSummary, loadNewsSummariesBatch } from "./discovery/news-tracker.js";

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
const FEATURED_LIMIT = 4;
const ALSO_TAPE_LIMIT = 2;

const STORY_KIND_RANK = {
  retest: 100,
  quiet_pierce: 93,
  fired: 88,
  approaching: 80,
  magnet: 72,
  stretch: 64,
  imbalance: 56,
  news_structure: 44,
  outside: 30,
};

function _n(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _dir(v) {
  const s = String(v || "").toUpperCase();
  return s === "LONG" || s === "SHORT" ? s : null;
}

function voteDir(votes, dir) {
  const d = _dir(dir);
  if (d) votes.push(d);
}

/** Require two agreeing family votes so mixed ST/EMA/FVG notes do not invent a side. */
export function consensusDir(votes = []) {
  let long = 0;
  let short = 0;
  for (const v of votes) {
    if (v === "LONG") long += 1;
    else if (v === "SHORT") short += 1;
  }
  if (long >= 2 && long > short) return "LONG";
  if (short >= 2 && short > long) return "SHORT";
  return null;
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

/** Futures (`CL1!`) and crypto (`BTCUSD`) stay off the subscriber short list. */
export function isWeekendEmailTicker(ticker) {
  const t = String(ticker || "").toUpperCase();
  if (!t) return false;
  if (t.includes("!")) return false;
  if (/USD$/.test(t)) return false;
  return true;
}

export function readWeekendVolume(td, watch = null) {
  const w = watch || readBreakoutWatch(td) || {};
  const rvolWatch = _n(w.rvol);
  const rvolD = _n(td?.rvol_map?.D?.vr ?? td?.rvol?.D);
  const rvolW = _n(td?.rvol_map?.W?.vr);
  const rvol4h = _n(td?.rvol_map?.["240"]?.vr);
  const rvol1h = _n(td?.rvol_map?.["60"]?.vr);
  const candidates = [rvolWatch, rvolD, rvolW, rvol4h, rvol1h].filter((v) => v != null);
  const rvolBest = _n(td?.rvol?.best) ?? (candidates.length ? Math.max(...candidates) : null);
  const quietPierce = w.reason === "tl_through_low_rvol";
  const confirmedBreak = !!(w.active || w.promotes_setup) && rvolWatch != null && rvolWatch >= 1.15;
  const heavy = (rvolWatch != null && rvolWatch >= 1.5) || (rvolD != null && rvolD >= 1.5);
  const dry = (rvolWatch != null && rvolWatch > 0 && rvolWatch < 0.85)
    || (rvolD != null && rvolD > 0 && rvolD < 0.75);
  return { rvolWatch, rvolD, rvolW, rvolBest, quietPierce, confirmedBreak, heavy, dry };
}

function volumeSentences(vol, kind) {
  if (!vol) return [];
  if (kind === "quiet_pierce" || vol.quietPierce && kind === "quiet_pierce") {
    return [];
  }
  if (vol.quietPierce && kind !== "quiet_pierce") {
    return ["Price poked through that line on light volume. The model does not treat a quiet poke as a confirmed break."];
  }
  if (vol.confirmedBreak && (kind === "fired" || kind === "retest")) {
    return ["Volume expanded through the line, which is the participation the model wants before treating the break as real."];
  }
  if (vol.heavy && kind === "retest") {
    return ["Volume expanded as price came back to the line."];
  }
  if (vol.dry && (kind === "retest" || kind === "approaching" || kind === "magnet")) {
    return ["Volume has stayed light. A quiet hold can be the better window; a loud spike through the level is usually the chase."];
  }
  if (vol.heavy) {
    return ["Volume expanded on the last session — participation showed up."];
  }
  return [];
}

function storyChart(kind, flags = {}, magTfs = []) {
  if (kind === "magnet") {
    if (magTfs.includes("D") || flags.st_magnet_D) return { tf: "D", bars: 90 };
    if (magTfs.includes("W") || magTfs.includes("M") || flags.st_magnet_W || flags.st_magnet_M) {
      return { tf: "W", bars: 80 };
    }
    if (magTfs.includes("4H") || flags.st_magnet_4h) return { tf: "240", bars: 80 };
  }
  if (kind === "outside") return { tf: "W", bars: 60 };
  return { tf: "D", bars: 90 };
}

function storyLevel(watch, td, kind) {
  const line = _n(watch?.line);
  if (line != null && line > 0) return Number(line.toFixed(2));
  const mag = td?.st_hold_setup?.magnet;
  const magLine = _n(mag?.stLine ?? mag?.line);
  if ((kind === "magnet" || kind === "stretch") && magLine != null && magLine > 0) {
    return Number(magLine.toFixed(2));
  }
  const holdLine = _n(td?.st_hold_setup?.best?.stLine ?? td?.st_hold_setup?.best?.line);
  if ((kind === "magnet" || kind === "stretch") && holdLine != null && holdLine > 0) {
    return Number(holdLine.toFixed(2));
  }
  const gap = _n(td?._fvg?.nearest_gap_support ?? td?.fvg_imbalance_D?.nearest_gap_support);
  if (kind === "imbalance" && gap != null && gap > 0) return Number(gap.toFixed(2));
  return null;
}

function postureFromTd(td, card = {}) {
  const k = String(td?.kanban_stage || td?.kanban || "").toLowerCase();
  if (k === "setup" || k === "watch" || k === "ready") return "already_watching";
  const tags = card.tags || [];
  if (card.timed_uptick && tags.some((t) => ["retest", "breakout", "tl_watch", "st_magnet"].includes(t))) {
    return "already_watching";
  }
  return "should_watch";
}

export function inferSetupKind(td, card = {}) {
  if (card.kind) return card.kind;
  const watch = readBreakoutWatch(td) || card.watch || {};
  const flags = td?.flags || {};
  const tags = card.tags || [];
  const vol = readWeekendVolume(td, watch);
  if (watch.retest || flags.breakout_retest || tags.includes("retest")) return "retest";
  if (watch.reason === "tl_through_low_rvol" || vol.quietPierce) return "quiet_pierce";
  if (watchPromotesToSetup(watch) || flags.breakout_watch || tags.includes("breakout")) return "fired";
  if (watch.approaching || flags.breakout_approaching || tags.includes("tl_watch")) return "approaching";
  if (flags.st_flip_extended || tags.includes("st_stretch")) return "stretch";
  if (flags.st_magnet || tags.includes("st_magnet")) return "magnet";
  const imb = td?.fvg_imbalance_D || {};
  const hasGap = (flags.fvg_in_bull_D || 0) > 0 || (_n(imb.unfilled_below) || 0) >= 2
    || tags.includes("fvg_support") || tags.includes("imbalance");
  const families = card.families || [];
  if (hasGap && (families.includes("trendline") || families.includes("supertrend") || families.includes("ema"))) {
    return "imbalance";
  }
  if (tags.includes("news") && families.length >= 2) return "news_structure";
  return null;
}

/**
 * Plain-English setup story. No indicator tags in the copy.
 * Volume is a first-class CMT input even when the operator does not trade it.
 */
export function buildSetupStory(td, card = {}) {
  const ticker = String(card.ticker || td?.ticker || "").toUpperCase();
  if (!ticker) return null;
  if (card.kind === "outside" || (!td && card.thesis)) {
    return {
      ticker,
      kind: "outside",
      posture: "should_watch",
      headline: "Not on the book yet",
      why: String(card.thesis || `${ticker} is still outside the universe.`).trim(),
      watching_for: "Whether the next session confirms the move. A name has to earn a slot on the book — this is a look, not an add.",
      dir: null,
      level: null,
      chart_tf: "W",
      chart_bars: 60,
      volume: null,
    };
  }
  const watch = readBreakoutWatch(td) || card.watch || {};
  const flags = td?.flags || {};
  const vol = readWeekendVolume(td, watch);
  const kind = inferSetupKind(td, card);
  if (!kind) return null;
  const dir = _dir(watch.dir || card.dir || flags.breakout_watch_dir);
  const watchKind = String(watch.kind || flags.breakout_watch_kind || "trendline");
  const magTfs = magnetTimeframes(flags);
  const chart = storyChart(kind, flags, magTfs);
  const level = storyLevel(watch, td, kind);
  const volBits = volumeSentences(vol, kind);
  const news = td?._news_summary || card.news || null;
  const newsLean = news?.has_data ? String(news.dominant_sentiment || "") : "";
  const catalyst = news?.top_catalyst?.headline
    ? String(news.top_catalyst.headline).replace(/\s+/g, " ").slice(0, 120)
    : "";

  let headline = "";
  let why = "";
  let watchingFor = "";

  if (kind === "retest") {
    headline = "The line already broke — price came back and held";
    why = dir === "SHORT"
      ? "The rising line that had been holding this name gave way. Price came back to that same line from the other side and held."
      : "The falling line that had been capping this name gave way. Price came back to that same line from the other side and held.";
    watchingFor = "A clean hold on this side of the line on the next session. That is the good-entry window. A gap-through chase is not.";
  } else if (kind === "quiet_pierce") {
    headline = "Price poked the line, but volume did not confirm";
    why = "The first poke through the line happened on light volume. Professionals treat that as a probe, not a break.";
    watchingFor = "A second close through the line with volume expanding. Until that prints, the line is still the level.";
  } else if (kind === "fired" && watchKind === "daily_level") {
    headline = "Price cleared a daily level";
    why = "A horizontal level that had been in the way gave way on the daily chart.";
    watchingFor = "A hold above that level. The first close back under it would say the break did not stick.";
  } else if (kind === "fired") {
    headline = dir === "SHORT" ? "The rising support line just broke" : "The falling resistance line just broke";
    why = "Price closed through a line that had been in the way.";
    watchingFor = "Whether the next session holds on this side of the line. A hold keeps the name on the list. A snap back takes the idea off.";
  } else if (kind === "approaching") {
    headline = dir === "SHORT"
      ? "Price is pressing a rising support line"
      : "Price is pressing a falling resistance line";
    why = dir === "SHORT"
      ? "An upward-sloping line has supported the last several weeks. Price is sitting right on that line."
      : "A downward-sloping line has capped the last several weeks. Price is sitting right under that line.";
    watchingFor = "A close through the line, then a hold. That is the start of a potential setup — not a reason to chase the first print.";
  } else if (kind === "magnet") {
    headline = "A flat trend line is sitting nearby like a magnet";
    why = "When the higher-timeframe trend line goes flat, price often gets pulled back to it before the next move.";
    watchingFor = "A hold at the line as a possible bounce, or a clean break through it. Either outcome is more useful than chasing the stretch away from the line.";
  } else if (kind === "stretch") {
    headline = "The last flip already ran too far";
    why = "The trend flip is extended. Chasing the stretch is how late entries get trapped.";
    watchingFor = "A pullback toward the trend line. The interesting setup is the reset, not another push away from the line.";
  } else if (kind === "imbalance") {
    headline = "An unfilled gap is sitting under price";
    why = "Unfilled gaps often act as a floor the next time price comes back.";
    watchingFor = "Whether that gap holds if price revisits it. A hold there is the interesting setup. A slice through it with volume takes the idea off.";
  } else if (kind === "news_structure") {
    headline = "The tape and the headlines are leaning the same way";
    why = catalyst
      ? `Recent news is ${newsLean || "active"} — ${catalyst}. The chart already has structure behind it.`
      : `Recent news is leaning ${newsLean || "with the chart"}. The headline alone is not the setup.`;
    watchingFor = "Whether the next session agrees with that lean. The chart still has to confirm.";
  } else {
    return null;
  }

  if (volBits[0]) why = `${why} ${volBits[0]}`;
  const tags = card.tags || [];
  if (kind !== "magnet" && (flags.st_magnet || tags.includes("st_magnet"))) {
    why += " A flat higher-timeframe trend line is also nearby, which can act as a magnet.";
  }
  if (kind !== "imbalance" && (tags.includes("imbalance") || tags.includes("fvg_support") || (flags.fvg_in_bull_D || 0) > 0)) {
    why += " An unfilled gap sits under price as extra structure.";
  }
  if (newsLean && kind !== "news_structure" && (newsLean === "bullish" || newsLean === "bearish")) {
    const agree = (dir === "LONG" && newsLean === "bullish") || (dir === "SHORT" && newsLean === "bearish");
    why += agree
      ? " Recent headlines lean the same way as the chart."
      : " Recent headlines lean the other way — the chart still has to do the work.";
  }

  return {
    ticker,
    kind,
    posture: postureFromTd(td, card),
    headline,
    why: why.trim(),
    watching_for: watchingFor,
    dir,
    level,
    chart_tf: chart.tf,
    chart_bars: chart.bars,
    volume: vol.quietPierce ? "quiet" : vol.heavy ? "expanded" : vol.dry ? "light" : null,
  };
}

function thesisLooksReal(text) {
  const t = String(text || "").trim();
  if (t.length < 24) return false;
  if (/^screener candidate/i.test(t)) return false;
  return true;
}

export function weekendSetupChartUrl(story, origin = "https://timed-trading.com") {
  const base = String(origin || "https://timed-trading.com").replace(/\/$/, "");
  const p = new URLSearchParams();
  p.set("ticker", String(story?.ticker || "").toUpperCase());
  const tf = String(story?.chart_tf || "D");
  const tfClean = ["60", "240", "D", "W"].includes(tf) ? tf : "D";
  p.set("tf", tfClean);
  p.set("bars", String(story?.chart_bars || (tfClean === "W" ? 80 : 90)));
  if (story?.headline) p.set("subtitle", String(story.headline).slice(0, 80));
  const level = Number(story?.level);
  if (Number.isFinite(level) && level > 0) p.set("entry", String(level));
  return `${base}/timed/chart-image?${p.toString()}`;
}

/**
 * Short unique list. One ticker once. Story quality over raw score.
 * Volume, retests, and confirmed breaks outrank indicator piles.
 */
export function pickFeaturedSetups(cards = [], { promotions = [], limit = FEATURED_LIMIT } = {}) {
  const scored = [];
  const scoredTickers = new Set();
  for (const card of cards || []) {
    const ticker = String(card?.ticker || "").toUpperCase();
    if (!isWeekendEmailTicker(ticker) || scoredTickers.has(ticker)) continue;
    const story = card.story;
    if (!story?.headline || !story?.watching_for) continue;
    scoredTickers.add(ticker);
    const kind = story.kind;
    const rank = (STORY_KIND_RANK[kind] || 0)
      + (story.posture === "already_watching" ? 6 : 0)
      + (story.volume === "quiet" && kind === "quiet_pierce" ? 6 : 0)
      + (story.volume === "expanded" && (kind === "fired" || kind === "retest") ? 5 : 0)
      + Math.min(Number(card.score) || 0, 24) * 0.15
      + (card.timed_uptick ? 3 : 0);
    scored.push({ card, story, rank, ticker, kind });
  }
  scored.sort((a, b) => b.rank - a.rank || a.ticker.localeCompare(b.ticker));
  const picked = [];
  const pickedSet = new Set();
  const kindCount = {};
  const take = (row) => {
    if (pickedSet.has(row.ticker) || picked.length >= limit) return;
    kindCount[row.kind] = (kindCount[row.kind] || 0) + 1;
    pickedSet.add(row.ticker);
    picked.push({ ...row.card, ticker: row.ticker, story: row.story });
  };
  for (const row of scored) {
    if ((kindCount[row.kind] || 0) >= 1) continue;
    take(row);
  }
  for (const row of scored) {
    if ((kindCount[row.kind] || 0) >= 2) continue;
    take(row);
  }
  if (picked.length < limit) {
    for (const promo of promotions || []) {
      const ticker = String(promo?.ticker || "").toUpperCase();
      if (!isWeekendEmailTicker(ticker) || pickedSet.has(ticker)) continue;
      if (!thesisLooksReal(promo.thesis)) continue;
      const story = buildSetupStory(null, { ticker, kind: "outside", thesis: promo.thesis });
      if (!story) continue;
      picked.push({ ticker, score: promo.score || 0, story, outside: true });
      break;
    }
  }
  return picked;
}

export function pickAlsoOnTape(cards = [], featured = [], { limit = ALSO_TAPE_LIMIT } = {}) {
  const used = new Set((featured || []).map((c) => String(c.ticker || "").toUpperCase()));
  const featuredKinds = new Set((featured || []).map((c) => c.story?.kind).filter(Boolean));
  const scored = [];
  for (const card of cards || []) {
    const ticker = String(card?.ticker || "").toUpperCase();
    if (!isWeekendEmailTicker(ticker) || used.has(ticker)) continue;
    if (!card.story?.headline) continue;
    used.add(ticker);
    scored.push({ ...card, ticker });
  }
  scored.sort((a, b) => {
    const aNew = featuredKinds.has(a.story?.kind) ? 0 : 1;
    const bNew = featuredKinds.has(b.story?.kind) ? 0 : 1;
    return bNew - aNew
      || (STORY_KIND_RANK[b.story?.kind] || 0) - (STORY_KIND_RANK[a.story?.kind] || 0)
      || (b.score || 0) - (a.score || 0);
  });
  return scored.slice(0, limit).map((card) => ({
    ticker: card.ticker,
    story: card.story,
    score: card.score || 0,
  }));
}

export function uniqueEmailTickers(desk) {
  const list = [...(desk?.featured || []), ...(desk?.also_on_tape || [])]
    .map((c) => String(c?.ticker || "").toUpperCase())
    .filter(Boolean);
  return list;
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
  const dirVotes = [];
  let score = 0;

  if (watch?.retest) {
    score += 22;
    tags.push("retest");
    families.add("trendline");
    notes.push(breakoutWatchLookForEntryCopy({ ...watch, retest: true }) || "Broken line retest — look for a good entry");
    voteDir(dirVotes, watch.dir);
  } else if (watchPromotesToSetup(watch) || flags.breakout_watch) {
    score += 18;
    tags.push("breakout");
    families.add("trendline");
    notes.push(breakoutWatchLookForEntryCopy(watch) || "Level or trendline breakout — look for a good entry");
    voteDir(dirVotes, watch?.dir || flags.breakout_watch_dir);
  } else if (watch?.approaching || flags.breakout_approaching) {
    score += 10;
    tags.push("tl_watch");
    families.add("trendline");
    notes.push(breakoutWatchLookForEntryCopy(watch) || "Trendline nearby — watching for a break");
    voteDir(dirVotes, watch?.dir || flags.breakout_watch_dir);
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
    voteDir(dirVotes, magnet?.sideLabel || magnet?.side);
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
    if (regime != null && regime >= 2) voteDir(dirVotes, "LONG");
    if (regime != null && regime <= -2) voteDir(dirVotes, "SHORT");
  }

  const imbNotes = imbalanceNote(imb);
  if (imbNotes.length) {
    const imbDir = String(imb.imbalance_direction || "");
    score += imbDir === "LONG_OPPORTUNITY" || imbDir === "SHORT_OPPORTUNITY" ? 12 : 7;
    tags.push("imbalance");
    families.add("imbalance");
    notes.push(...imbNotes);
    if (imbDir.includes("LONG") || imbDir === "BULLISH_LEAN") voteDir(dirVotes, "LONG");
    if (imbDir.includes("SHORT") || imbDir === "BEARISH_LEAN") voteDir(dirVotes, "SHORT");
  } else if ((flags.fvg_in_bull_D || 0) > 0) {
    score += 5;
    tags.push("fvg_support");
    families.add("imbalance");
    notes.push("Price sitting in a daily bull FVG — imbalance as support");
  }

  const vol = readWeekendVolume(td, watch);
  if (vol.quietPierce) {
    score += 8;
    tags.push("quiet_volume");
    families.add("volume");
    notes.push("Line pierced on light volume — not a confirmed break");
  } else if (vol.confirmedBreak) {
    score += 6;
    tags.push("volume_confirm");
    families.add("volume");
    notes.push("Volume expanded through the line");
  } else if (vol.heavy) {
    score += 4;
    tags.push("volume_expand");
    families.add("volume");
    notes.push("Volume expanded on the last session");
  }

  if (flags.momentum_elite) {
    score += 16;
    tags.push("momentum_elite");
    families.add("momentum");
    voteDir(dirVotes, flags.momentum_elite_dir);
    notes.push(`Momentum Elite${_dir(flags.momentum_elite_dir) ? ` ${flags.momentum_elite_dir}` : ""}`);
  }

  const nNotes = newsNote(news);
  if (nNotes.length) {
    const dom = String(news.dominant_sentiment || "");
    score += dom === "bullish" || dom === "bearish" ? 8 : 4;
    if ((news.bullish_catalyst_count || 0) + (news.bearish_catalyst_count || 0) > 0) score += 3;
    tags.push("news");
    families.add("news");
    notes.push(...nNotes.slice(0, 2));
    if (dom === "bullish") voteDir(dirVotes, "LONG");
    if (dom === "bearish") voteDir(dirVotes, "SHORT");
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
  const dir = consensusDir(dirVotes);
  const story = buildSetupStory(td, {
    ticker,
    tags,
    families: familyList,
    timed_uptick: timedUptick,
    dir,
    notes,
  });

  return {
    ticker,
    score,
    dir,
    tags,
    families: familyList,
    notes: notes.slice(0, 6),
    timed_uptick: timedUptick,
    tt_setup: timedUptick,
    rank: rank,
    conviction: conv,
    focus_tier: tier || null,
    headline: story?.headline || notes[0] || `${ticker} weekend mark`,
    story,
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
  const featured = pickFeaturedSetups(clean, { promotions: promo, limit: FEATURED_LIMIT });
  const alsoOnTape = pickAlsoOnTape(clean, featured, { limit: ALSO_TAPE_LIMIT });

  return {
    ok: true,
    generated_at: now,
    weekend_key: weekendDeskKey(now),
    label: weekendDeskLabel(now),
    scanned: scanned || clean.length,
    marked: clean.length,
    counts: {
      tt_setups: featured.length,
      timed_upticks: upticks.length,
      featured: featured.length,
      also_on_tape: alsoOnTape.length,
      trendlines: trendlines.length,
      supertrend: supertrend.length,
      imbalance: imbalance.length,
      ema: ema.length,
      momentum_elite: elite.length,
      news: news.length,
      promotion_candidates: promo.length,
    },
    featured,
    also_on_tape: alsoOnTape,
    tt_setups: featured,
    timed_upticks: upticks,
    trendlines,
    supertrend,
    imbalance,
    ema,
    momentum_elite: elite,
    news,
    promotion_candidates: promo,
    rescore: rescore || null,
    disclaimer: "TT Setups are names the desk is already watching or should be watching. This is not Newton's monthly Upticks list, and not a buy list. Look for a good entry. Monday still has to grade the setup.",
  };
}

function storyLine(c) {
  const s = c.story || {};
  return `${c.ticker} — ${s.headline || c.headline || "setup"}`;
}

function chartTfLabel(tf) {
  if (tf === "W") return "Weekly";
  if (tf === "240") return "4-hour";
  if (tf === "60") return "Hourly";
  return "Daily";
}

export function renderWeekendDeskText(desk) {
  const featured = desk.featured || desk.tt_setups || [];
  const also = desk.also_on_tape || [];
  const lines = [
    `TT Setups · ${desk.label}`,
    desk.disclaimer,
    "",
    featured.length
      ? `${featured.length} name${featured.length === 1 ? "" : "s"} the desk is watching into the next session.`
      : "No clean setups cleared the bar this weekend.",
    "",
  ];
  featured.forEach((c, i) => {
    const s = c.story || {};
    lines.push(`${i + 1}. ${c.ticker}`);
    lines.push(s.posture === "already_watching" ? "Already watching" : "Should be watching");
    lines.push(s.headline || c.headline || "");
    lines.push(`Why: ${s.why || ""}`);
    lines.push(`Watching for: ${s.watching_for || ""}`);
    lines.push("");
  });
  if (also.length) {
    lines.push("ALSO ON THE TAPE");
    for (const c of also) lines.push(`- ${storyLine(c)}`);
    lines.push("");
  }
  lines.push(`Open Today: ${WEEKEND_DESK_PAGE}`);
  return lines.join("\n");
}

function featuredBlock(card, index, origin) {
  const s = card.story || {};
  const ticker = String(card.ticker || s.ticker || "").toUpperCase();
  const chart = weekendSetupChartUrl({ ...s, ticker }, origin);
  const posture = s.posture === "already_watching" ? "Already watching" : "Should be watching";
  const today = `https://timed-trading.com/today.html?ticker=${encodeURIComponent(ticker)}`;
  const tfLabel = chartTfLabel(s.chart_tf);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px">
    <tr><td style="padding:0 0 16px;border-bottom:1px solid ${BRAND.border}">
      <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.textMuted}">${index}. ${_esc(ticker)} · ${_esc(posture)}</div>
      <div style="font-size:18px;font-weight:700;color:white;line-height:1.3;margin:6px 0 12px">${_esc(s.headline || ticker)}</div>
      <a href="${today}" style="display:block;line-height:0;border-radius:8px;overflow:hidden;border:1px solid ${BRAND.border}">
        <img src="${_esc(chart)}" alt="${_esc(ticker)} ${tfLabel} chart" width="600" style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px" />
      </a>
      <div style="margin:4px 2px 14px;font-size:10px;color:${BRAND.textMuted}">${_esc(tfLabel)} chart · the line on the chart is the level the model is watching</div>
      <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.editorial}">Why it is interesting</div>
      <p style="margin:4px 0 12px;font-size:14px;color:${BRAND.textSecondary};line-height:1.55">${_esc(s.why || "")}</p>
      <div style="font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${BRAND.editorial}">What the model is watching for</div>
      <p style="margin:4px 0 12px;font-size:14px;color:${BRAND.textSecondary};line-height:1.55">${_esc(s.watching_for || "")}</p>
      <a href="${today}" style="color:${BRAND.green};text-decoration:none;font-size:13px;font-weight:600">Open ${_esc(ticker)} on Today →</a>
    </td></tr>
  </table>`;
}

export function renderWeekendDeskHtml(desk, { unsubscribeUrl, origin } = {}) {
  const base = String(origin || desk.chart_origin || "https://timed-trading.com").replace(/\/$/, "");
  const featured = desk.featured || desk.tt_setups || [];
  const also = desk.also_on_tape || [];
  const count = featured.length;
  const intro = count
    ? `${count} name${count === 1 ? "" : "s"} the desk is already watching or should be watching into the next session. Each one has a simple reason, the chart that shows the setup, and what the model is waiting for.`
    : "No clean setups cleared the bar this weekend. The desk will look again after the next session.";
  const featuredHtml = featured.length
    ? featured.map((c, i) => featuredBlock(c, i + 1, base)).join("")
    : `<p style="margin:0 0 18px;font-size:14px;color:${BRAND.textMuted}">No clean setups cleared the bar this weekend.</p>`;
  const alsoHtml = also.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px">
        <tr><td style="padding:0 0 6px;font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">Also on the tape</td></tr>
        ${also.map((c) => `<tr><td style="padding:6px 0;font-size:13px;color:${BRAND.textSecondary}">${_esc(storyLine(c))}</td></tr>`).join("")}
      </table>`
    : "";
  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:white">TT Setups</h1>
    <p style="margin:0 0 14px;font-size:13px;color:${BRAND.editorial};letter-spacing:0.04em;text-transform:uppercase">Weekend watch · ${_esc(desk.label)}</p>
    <p style="margin:0 0 22px;font-size:14px;color:${BRAND.textSecondary};line-height:1.55">${intro}</p>
    ${featuredHtml}
    ${alsoHtml}
    <p style="margin:8px 0 0;font-size:12px">
      <a href="${WEEKEND_DESK_PAGE}" style="color:${BRAND.green};text-decoration:none;font-weight:600">Open Today →</a>
    </p>
    <p style="margin:14px 0 0;font-size:11px;color:${BRAND.textMuted};line-height:1.45">${_esc(desk.disclaimer)}</p>
  `;
  return emailLayout(body, {
    unsubscribeUrl,
    preheader: `TT Setups · ${count} name${count === 1 ? "" : "s"} · ${desk.label}`,
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
    if (out.length) return out;
  } catch (_) { /* fall through to raw screener */ }
  return loadScreenerOutsideUniverse(env);
}

/** Raw screener rows include OTC junk. Keep listed-looking names with a real price. */
export function isScreenerPromoteCandidate(ticker, c = {}) {
  const sym = String(ticker || "").toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) return false;
  if (sym.length === 5 && sym.endsWith("F")) return false;
  const px = _n(c.price);
  if (px != null && px < 5) return false;
  const mcap = _n(c.market_cap);
  if (mcap != null && mcap < 5e8) return false;
  return true;
}

/** Fallback when the promotion queue is empty or every row is already tracked. */
export async function loadScreenerOutsideUniverse(env) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return [];
  let parsed = null;
  try {
    const raw = await KV.get("timed:screener:candidates");
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed?.candidates || []);
  const universe = new Set(Object.keys(SECTOR_MAP || {}).map((s) => String(s).toUpperCase()));
  try {
    const reg = await KV.get("timed:tickers");
    const arr = typeof reg === "string" ? JSON.parse(reg) : reg;
    for (const t of (Array.isArray(arr) ? arr : (arr?.tickers || []))) {
      const sym = String(t || "").toUpperCase();
      if (sym) universe.add(sym);
    }
  } catch (_) { /* registry optional */ }
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const ticker = String(c?.ticker || c?.symbol || "").toUpperCase();
    if (!ticker || seen.has(ticker) || universe.has(ticker)) continue;
    if (!isScreenerPromoteCandidate(ticker, c)) continue;
    seen.add(ticker);
    const week = _n(c.week_change_pct ?? c.change_pct);
    const name = String(c.name || "").slice(0, 40);
    const thesis = c.thesis_text || c.thesis || c.reason || [
      name || ticker,
      week != null ? `weekly ${week >= 0 ? "+" : ""}${week.toFixed(1)}%` : "screener candidate",
      "outside the book",
    ].join(" · ");
    out.push({
      ticker,
      status: "screener",
      score: _n(c.total_score ?? c.score ?? c.week_change_pct ?? c.rank) || 0,
      thesis: String(thesis).slice(0, 220),
      in_universe: false,
    });
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, SECTION_LIMIT);
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
    const html = renderWeekendDeskHtml(desk, { unsubscribeUrl, origin: baseUrl });
    const text = renderWeekendDeskText(desk);
    try {
      const r = await sendFn(env, {
        to: u.email,
        subject: `TT Setups · ${desk.label}`,
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
  let newsMap = {};
  try {
    newsMap = await loadNewsSummariesBatch(env, payloads.map((p) => p.ticker), { lookbackDays: 7 });
  } catch (_) { newsMap = {}; }
  const cards = [];
  for (const td of payloads) {
    if (!td._news_summary) attachNewsSummary(td, newsMap);
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
        title: `TT SETUPS · ${desk.label}`,
        description: [
          `TT Setups: ${(desk.featured || []).map((c) => c.ticker).join(", ") || "none"}`,
          email.skipped ? `Email: ${email.skipped}` : `Email ${email.sent}/${email.recipients}`,
        ].join("\n"),
        color: 0xa78bfa,
      });
    } catch (_) { /* best-effort */ }
  }

  return { ok: true, action, desk, stored, email, rescore };
}
