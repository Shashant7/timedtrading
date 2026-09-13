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

import {
  emailLayout,
  buildUnsubscribeUrl,
  getEmailOptedInUsers,
  sendEmail,
  buildEmailBriefTickerChip,
  EMAIL_FONT_UI,
  EMAIL_FONT_EDITORIAL,
} from "./email.js";
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
const WEEKEND_DAILY_BARS = 60;
const WEEKEND_CHART_REV = "3";
const MAX_DISPLAY_RR = 4;

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

const STORY_KIND_LABEL = {
  retest: "Retest",
  quiet_pierce: "Quiet probe",
  fired: "Break",
  approaching: "Approaching",
  magnet: "Magnet",
  stretch: "Extended",
  imbalance: "Gap",
  news_structure: "Tape + news",
  outside: "Outside the book",
};

const PSYCH_HANDLES = [50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000];

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

/** Daily-brief style date for the email H1 kicker row. */
export function weekendDeskLongLabel(nowMs = Date.now()) {
  const key = weekendDeskKey(nowMs);
  try {
    return new Date(`${key}T12:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return weekendDeskLabel(nowMs);
  }
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

function volumeSentences(vol, kind, role) {
  if (!vol) return [];
  const shelf = role === "support" ? "support" : role === "resistance" ? "resistance" : "level";
  if (kind === "quiet_pierce" || (vol.quietPierce && kind === "quiet_pierce")) {
    return [];
  }
  if (vol.quietPierce && kind !== "quiet_pierce") {
    return [`Price poked through that ${shelf} on light volume. The model does not treat a quiet poke as a confirmed break.`];
  }
  if (vol.confirmedBreak && (kind === "fired" || kind === "retest")) {
    return [`Volume expanded through the ${shelf}, which is the participation the model wants before treating the break as accepted.`];
  }
  if (vol.heavy && kind === "retest") {
    return [`Volume expanded as price came back to that ${shelf}.`];
  }
  if (vol.dry && (kind === "retest" || kind === "approaching" || kind === "magnet")) {
    return [`Volume has stayed light. A quiet hold at that ${shelf} can be the better window; a loud spike through it is usually the chase.`];
  }
  if (vol.heavy) {
    return ["Volume expanded on the last session — participation showed up."];
  }
  return [];
}

function weekendDeskDayPct(td) {
  return _n(td?.day_change_pct ?? td?.dailyChgPct ?? td?.dp ?? td?.day_pct);
}

function resolvePersonality(td) {
  const raw = td?.execution_profile?.personality
    || td?.ticker_character?.learned_profile?.personality
    || td?.ticker_character?.personality
    || td?._ticker_profile?.behavior_type
    || "";
  const p = String(raw).toUpperCase().replace(/\s+/g, "_");
  if (p === "VOLATILE_RUNNER" || p === "MEAN_REVERT" || p === "PULLBACK_PLAYER" || p === "SLOW_GRINDER") {
    return p;
  }
  return null;
}

function nearPsychHandle(price, pctTolerance = 0.012) {
  const px = Number(price);
  if (!Number.isFinite(px) || px <= 0) return null;
  for (const lvl of PSYCH_HANDLES) {
    if (Math.abs(px - lvl) / lvl <= pctTolerance) return lvl;
  }
  return null;
}

function setupLevelRole({ kind, dir, watchKind } = {}) {
  const d = String(dir || "").toUpperCase();
  const wk = String(watchKind || "").toLowerCase();
  if (kind === "retest") return d === "SHORT" ? "resistance" : "support";
  if (kind === "imbalance") return "support";
  if (kind === "magnet" || kind === "stretch") {
    return d === "SHORT" ? "resistance" : "support";
  }
  if (wk.includes("daily_level") || wk.includes("horiz")) {
    return d === "SHORT" ? "support" : "resistance";
  }
  return d === "SHORT" ? "support" : "resistance";
}

export function describeSetupLevel({ kind, dir, line, role, watchKind } = {}) {
  const lv = Number.isFinite(line) && line > 0 ? ` at $${Number(line).toFixed(2)}` : "";
  const daily = String(watchKind || "").toLowerCase().includes("daily_level");
  const d = String(dir || "").toUpperCase();
  if (kind === "retest") {
    if (daily) {
      return role === "support"
        ? `Former resistance, now support${lv}`
        : `Former support, now resistance${lv}`;
    }
    return role === "support"
      ? `Broken falling resistance, now support${lv}`
      : `Broken rising support, now resistance${lv}`;
  }
  if (kind === "imbalance") return `Unfilled gap as support${lv}`;
  if (kind === "magnet") return `Flat trend shelf${lv}`;
  if (kind === "stretch") return `Extended away from the trend shelf${lv}`;
  if (daily) return role === "support" ? `Horizontal support${lv}` : `Horizontal resistance${lv}`;
  if (d === "SHORT") return `Rising support${lv}`;
  return `Falling resistance${lv}`;
}

function personalityVoice(personality, kind) {
  if (personality === "MEAN_REVERT" && (kind === "retest" || kind === "imbalance" || kind === "quiet_pierce")) {
    return "This name has a mean-revert habit — unfinished structure often gets revisited rather than left behind.";
  }
  if (personality === "VOLATILE_RUNNER" && (kind === "quiet_pierce" || kind === "fired" || kind === "approaching")) {
    return "As a runner, first pokes of a barrier are often quiet; the real tell is whether the second attempt brings volume.";
  }
  if (personality === "PULLBACK_PLAYER" && (kind === "retest" || kind === "approaching")) {
    return "Pullbacks to broken structure are the usual window in this name — not the first thrust through it.";
  }
  if (personality === "SLOW_GRINDER" && (kind === "retest" || kind === "approaching")) {
    return "This name tends to grind along structure rather than gap through it, so a hold at the shelf is the more typical path.";
  }
  return "";
}

function gapNote(td, role, personality, kind) {
  if (kind === "imbalance") return "";
  const fvg = td?.fvg_imbalance_D || td?.fvg_imbalance || {};
  const unfilled = _n(fvg.unfilled_below);
  if (!(unfilled > 0) || role === "resistance") return "";
  if (personality === "MEAN_REVERT") {
    return "An unfilled daily gap still sits underneath; this name has tended to revisit unfinished business rather than leave it.";
  }
  if (personality === "VOLATILE_RUNNER") {
    return "An unfilled daily gap still sits underneath — runners in this book often leave those gaps behind unless the tape fails.";
  }
  return "An unfilled daily gap still sits underneath as a possible support pocket.";
}

function psychNote(px, line) {
  const handle = nearPsychHandle(px) || nearPsychHandle(line);
  if (!handle) return "";
  return `The ${handle} handle is also in play — a round number the tape often treats as a decision point.`;
}

function earningsNote(td) {
  const days = _n(td?.days_to_earnings ?? td?.daysToEarnings);
  const e = td?.fundamentals?.earnings || {};
  const beat = _n(e.beat_rate_pct);
  const surprise = _n(e.avg_surprise_pct);
  const hist = Array.isArray(e.history) ? e.history : [];
  const lastResult = String(hist[0]?.result || "").toLowerCase();
  const parts = [];
  if (days != null && days >= 0 && days <= 14) {
    parts.push(days === 0
      ? "Earnings print this session."
      : `Earnings are ${days} session${days === 1 ? "" : "s"} out.`);
    if (beat != null) {
      const surpriseBit = surprise != null
        ? `, average surprise ${surprise >= 0 ? "+" : ""}${surprise.toFixed(1)}%`
        : "";
      parts.push(`Recent prints have a ${Math.round(beat)}% beat rate${surpriseBit}.`);
    }
    if (lastResult === "beat" || lastResult === "miss") {
      parts.push(`The last report was a ${lastResult}.`);
    }
  }
  return parts.join(" ");
}

function distancePhrase(px, level) {
  if (px == null || level == null || !(level > 0)) return "";
  const pct = ((px - level) / level) * 100;
  if (!Number.isFinite(pct)) return "";
  return `${Math.abs(pct).toFixed(1)}% ${pct >= 0 ? "above" : "below"}`;
}

function magnetPrice(td) {
  return _n(td?.st_hold_setup?.magnet?.stLine
    ?? td?.st_hold_setup?.magnet?.line
    ?? td?.st_hold_setup?.best?.stLine
    ?? td?.st_hold_setup?.best?.line);
}

function readAtr(td) {
  return _n(td?.atr)
    ?? _n(td?.atr14)
    ?? _n(td?.atr_d)
    ?? _n(td?.tf_tech?.D?.atr)
    ?? _n(td?.tf_tech?.D?.atr14)
    ?? _n(td?.tf_tech?.["240"]?.atr)
    ?? _n(td?.tf_tech?.W?.atr);
}

function nextPsychHandle(px, dir) {
  if (!(px > 0)) return null;
  if (dir === "LONG") {
    for (const h of PSYCH_HANDLES) {
      if (h > px * 1.025) return h;
    }
  } else if (dir === "SHORT") {
    for (let i = PSYCH_HANDLES.length - 1; i >= 0; i--) {
      if (PSYCH_HANDLES[i] < px * 0.975) return PSYCH_HANDLES[i];
    }
  }
  return null;
}

/** Nearby round number only. A 150 handle 40% away is not a first target. */
function nearbyPsychHandle(px, dir, atr) {
  const h = nextPsychHandle(px, dir);
  if (!h || !(px > 0)) return null;
  const dist = Math.abs(h - px);
  const pct = dist / px;
  const atrCap = atr > 0 ? atr * 2 : px * 0.08;
  if (pct > 0.08 && dist > atrCap) return null;
  return h;
}

export function computeSetupRR({ entry, stop, target, dir } = {}) {
  if (!(entry > 0) || !(stop > 0) || !(target > 0)) return null;
  const risk = dir === "SHORT" ? (stop - entry) : (entry - stop);
  const reward = dir === "SHORT" ? (entry - target) : (target - entry);
  if (!(risk > 0) || !(reward > 0)) return null;
  const rr = reward / risk;
  if (rr < 0.4 || rr > MAX_DISPLAY_RR) return null;
  return Number(rr.toFixed(1));
}

/**
 * Structural target / invalidation. Magnet shelf is the target when
 * present — including when the shelf was resolved as the story level
 * but `st_hold_setup.magnet.stLine` was missing. Fired setups may use
 * a nearby psych handle. Distant 150/300/500 marks are not first
 * targets. R:R is omitted unless both sides are real, and omitted
 * above 4R — a tight invalidation is not a 10R plan.
 */
export function resolveSetupObjective(td, { kind, dir, level, px } = {}) {
  const magPx = magnetPrice(td);
  const atr = readAtr(td);
  const out = { target: null, target_label: null, stop: null, rr: null };
  if (kind === "magnet") {
    const shelf = magPx > 0 ? magPx : (level > 0 ? level : null);
    if (!(shelf > 0)) return out;
    out.target = Number(shelf.toFixed(2));
    out.target_label = "flat higher-timeframe shelf";
    if (atr > 0 && px > 0) {
      const towardLong = px < shelf;
      const stop = towardLong ? px - atr * 0.6 : px + atr * 0.6;
      if (stop > 0) {
        out.stop = Number(stop.toFixed(2));
        out.rr = computeSetupRR({
          entry: px,
          stop: out.stop,
          target: out.target,
          dir: towardLong ? "LONG" : "SHORT",
        });
      }
    }
    return out;
  }
  if (!level || !(level > 0) || !(px > 0)) return out;
  const tradeDir = _dir(dir);
  if (!tradeDir) return out;
  if (!["fired", "retest", "quiet_pierce", "approaching"].includes(kind)) return out;
  const buf = atr > 0 ? atr * 0.15 : level * 0.004;
  out.stop = Number((tradeDir === "SHORT" ? level + buf : level - buf).toFixed(2));
  if (magPx > 0 && ((tradeDir === "LONG" && magPx > Math.max(px, level))
    || (tradeDir === "SHORT" && magPx < Math.min(px, level)))) {
    out.target = Number(magPx.toFixed(2));
    out.target_label = "flat higher-timeframe shelf";
  } else if (kind === "fired") {
    const psych = nearbyPsychHandle(px, tradeDir, atr);
    if (psych) {
      out.target = psych;
      out.target_label = `${psych} handle`;
    }
  }
  const entry = kind === "fired" ? px : level;
  if (out.target && out.stop) {
    out.rr = computeSetupRR({ entry, stop: out.stop, target: out.target, dir: tradeDir });
  }
  return out;
}

function fmtPx(n) {
  return Number.isFinite(n) && n > 0 ? `$${Number(n).toFixed(2)}` : "";
}

function objectiveLine(story) {
  const bits = [];
  if (story?.target) {
    bits.push(`Target ${fmtPx(story.target)}${story.target_label ? ` · ${story.target_label}` : ""}`);
  }
  if (Number.isFinite(story?.rr) && story.rr > 0) bits.push(`${story.rr.toFixed(1)}R`);
  return bits.join("  ·  ");
}

function storyChart(kind, _flags = {}, _magTfs = []) {
  if (kind === "outside") return { tf: "W", bars: 60 };
  // Magnets use daily even when the stamp is weekly — W series is too
  // sparse for email, and the shelf still draws as a horizontal target.
  return { tf: "D", bars: WEEKEND_DAILY_BARS };
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
 * Structure-first setup story. Levels are named by role (support /
 * resistance), not "the line". Personality, psych handles, and
 * earnings are added only when the payload already has them.
 */
export function buildSetupStory(td, card = {}) {
  const ticker = String(card.ticker || td?.ticker || "").toUpperCase();
  if (!ticker) return null;
  if (card.kind === "outside" || (!td && card.thesis)) {
    return {
      ticker,
      kind: "outside",
      kind_label: STORY_KIND_LABEL.outside,
      posture: "should_watch",
      headline: "Not on the book yet",
      why: String(card.thesis || `${ticker} is still outside the universe.`).trim(),
      watching_for: "Whether the next session confirms the move. A name has to earn a slot on the book — this is a look, not an add.",
      dir: null,
      level: null,
      level_role: null,
      level_name: null,
      slope: null,
      intercept: null,
      chart_tf: "W",
      chart_bars: 60,
      chart_style: "candles",
      volume: null,
      day_pct: weekendDeskDayPct(td),
      price: _n(td?.price ?? td?.close),
    };
  }
  const watch = readBreakoutWatch(td) || card.watch || {};
  const flags = td?.flags || {};
  const vol = readWeekendVolume(td, watch);
  const kind = inferSetupKind(td, card);
  if (!kind) return null;
  const mag = td?.st_hold_setup?.magnet || {};
  const dir = _dir(watch.dir || card.dir || flags.breakout_watch_dir || mag.sideLabel);
  const watchKind = String(watch.kind || flags.breakout_watch_kind || "trendline");
  const magTfs = magnetTimeframes(flags);
  const chart = storyChart(kind, flags, magTfs);
  const level = storyLevel(watch, td, kind);
  const role = setupLevelRole({ kind, dir, watchKind });
  const levelName = describeSetupLevel({ kind, dir, line: level, role, watchKind });
  const volBits = volumeSentences(vol, kind, role);
  const news = td?._news_summary || card.news || null;
  const newsLean = news?.has_data ? String(news.dominant_sentiment || "") : "";
  const catalyst = news?.top_catalyst?.headline
    ? String(news.top_catalyst.headline).replace(/\s+/g, " ").slice(0, 120)
    : "";
  const px = _n(td?.price ?? td?.close);
  const lvTxt = level != null && level > 0 ? `$${Number(level).toFixed(2)}` : "";
  const dist = distancePhrase(px, level);
  const personality = resolvePersonality(td);
  const objective = resolveSetupObjective(td, { kind, dir, level, px });
  const tgtTxt = fmtPx(objective.target);
  const rrTxt = Number.isFinite(objective.rr) && objective.rr > 0 ? `${objective.rr.toFixed(1)}R` : "";

  let headline = "";
  let why = "";
  let watchingFor = "";

  if (kind === "retest") {
    headline = dir === "SHORT"
      ? "Broken support is now being tested as resistance"
      : "Broken resistance is now being tested as support";
    why = dir === "SHORT"
      ? `${ticker} already lost ${lvTxt || "the prior support shelf"}. Price is back at that shelf from below — the market is deciding whether failed support now caps the bounce.`
      : `${ticker} already cleared ${lvTxt || "overhead supply"}. The pullback is sitting on that former ceiling — the classic confirm that the break was accepted, not a fakeout.`;
    watchingFor = dir === "SHORT"
      ? `A rejection that leaves a lower high keeps the breakdown intact. A close back through ${lvTxt || "the shelf"} would neutralize this as resistance.`
      : `A daily hold and turn higher would confirm ${lvTxt || "the shelf"} as support. A close back under it would say the break was not accepted.`;
  } else if (kind === "quiet_pierce") {
    headline = dir === "SHORT"
      ? (watchKind === "daily_level" ? "A probe of horizontal support, not a break" : "A probe of rising support, not a break")
      : (watchKind === "daily_level" ? "A probe of horizontal resistance, not a break" : "A probe of falling resistance, not a break");
    why = `${ticker} poked ${lvTxt || levelName.toLowerCase()} on light volume. Until participation shows up, this reads as a test of the barrier rather than a committed break.`;
    watchingFor = `A second close through ${lvTxt || "that barrier"} with volume expanding would upgrade the tape. A fade back inside the range leaves the barrier intact.`;
  } else if (kind === "fired" && watchKind === "daily_level") {
    headline = dir === "SHORT" ? "Horizontal support gave way" : "Horizontal resistance gave way";
    why = `${ticker} closed through ${lvTxt || "a daily shelf"} that had been containing the range.`;
    watchingFor = tgtTxt
      ? `If the break holds, the first target is ${tgtTxt}${objective.target_label ? ` (${objective.target_label})` : ""}${rrTxt ? ` — about ${rrTxt}` : ""}. A close back through ${lvTxt || "the shelf"} would say the move did not stick.`
      : `A hold on this side of ${lvTxt || "the shelf"} keeps the break accepted. The first close back through it would say the move did not stick.`;
  } else if (kind === "fired") {
    headline = dir === "SHORT" ? "Rising support gave way" : "Falling resistance gave way";
    why = `${ticker} closed through ${lvTxt || levelName.toLowerCase()} with enough participation that the break is live, not just a wick.`;
    watchingFor = tgtTxt
      ? `If the break holds, the first target is ${tgtTxt}${objective.target_label ? ` (${objective.target_label})` : ""}${rrTxt ? ` — about ${rrTxt} from here` : ""}. Failure to hold ${lvTxt || "the break"} puts it back in the range.`
      : `The first pullback toward ${lvTxt || "that level"} is the confirmation window. Failure to hold the break puts it back in the range.`;
  } else if (kind === "approaching") {
    headline = dir === "SHORT"
      ? (watchKind === "daily_level" ? "Price is sitting on horizontal support" : "Price is sitting on rising support")
      : (watchKind === "daily_level" ? "Price is pressing horizontal resistance" : "Price is pressing falling resistance");
    why = dist && lvTxt
      ? `${ticker} is ${dist} ${lvTxt}. The next few sessions decide whether this is a pause in front of the barrier or the start of a break.`
      : `${ticker} is sitting against ${lvTxt || levelName.toLowerCase()}. The next few sessions decide whether this is a pause in front of the barrier or the start of a break.`;
    watchingFor = `Acceptance through ${lvTxt || "the level"} would open the next leg. A rejection here keeps the prevailing structure.`;
  } else if (kind === "magnet") {
    headline = "A flat higher-timeframe shelf is acting as a magnet";
    why = lvTxt
      ? `${ticker} is being pulled toward ${lvTxt} — that is the magnet target, the flat higher-timeframe shelf.${rrTxt ? ` About ${rrTxt} if the pull completes before a failed approach.` : ""}`
      : `When the higher-timeframe shelf goes flat, price often gets pulled back to it before the next move.`;
    watchingFor = `A hold at ${lvTxt || "the shelf"} as a possible bounce, or a clean break through it. Either outcome is more useful than chasing the stretch away from the shelf.`;
  } else if (kind === "stretch") {
    headline = "The last flip already ran too far";
    why = "The trend flip is extended. Chasing the stretch is how late entries get trapped.";
    watchingFor = `A pullback toward ${lvTxt || "the trend shelf"}. The interesting setup is the reset, not another push away from the shelf.`;
  } else if (kind === "imbalance") {
    headline = "An unfilled gap is sitting under price as support";
    why = `Unfilled gaps often act as a floor the next time price comes back${lvTxt ? ` — ${lvTxt} is the pocket` : ""}.`;
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
  const extras = [];
  const voice = personalityVoice(personality, kind);
  if (voice) extras.push(voice);
  const gap = gapNote(td, role, personality, kind);
  if (gap && personality !== "MEAN_REVERT" && personality !== "VOLATILE_RUNNER") extras.push(gap);
  else if (gap && !voice) extras.push(gap);
  const psych = psychNote(px, level);
  if (psych) extras.push(psych);
  const earn = earningsNote(td);
  if (earn) extras.push(earn);
  if (newsLean && kind !== "news_structure" && (newsLean === "bullish" || newsLean === "bearish")) {
    const agree = (dir === "LONG" && newsLean === "bullish") || (dir === "SHORT" && newsLean === "bearish");
    extras.push(agree
      ? "Recent headlines lean the same way as the chart."
      : "Recent headlines lean the other way — the chart still has to do the work.");
  }
  const nearbyMagnet = magnetPrice(td);
  if (kind !== "magnet" && nearbyMagnet > 0 && nearbyMagnet !== objective.target && px > 0) {
    const pct = Math.abs(nearbyMagnet - px) / px;
    const withTrade = (dir === "LONG" && nearbyMagnet > px) || (dir === "SHORT" && nearbyMagnet < px);
    if (withTrade && pct <= 0.12) {
      extras.push(`A flat higher-timeframe shelf at ${fmtPx(nearbyMagnet)} is also nearby — that is the magnet target.`);
    }
  }
  if (extras.length) why = `${why} ${extras.slice(0, 3).join(" ")}`;

  return {
    ticker,
    kind,
    kind_label: STORY_KIND_LABEL[kind] || null,
    posture: postureFromTd(td, card),
    headline,
    why: why.trim(),
    watching_for: watchingFor,
    dir,
    level,
    level_role: role,
    level_name: levelName,
    slope: _n(watch.slope),
    intercept: _n(watch.intercept),
    watch_kind: watchKind,
    chart_tf: chart.tf,
    chart_bars: chart.bars,
    chart_style: "candles",
    volume: vol.quietPierce ? "quiet" : vol.heavy ? "expanded" : vol.dry ? "light" : null,
    day_pct: weekendDeskDayPct(td),
    price: px,
    target: objective.target,
    target_label: objective.target_label,
    stop: objective.stop,
    rr: objective.rr,
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
  const bars = Number(story?.chart_bars || (tfClean === "W" ? 60 : WEEKEND_DAILY_BARS));
  p.set("bars", String(bars));
  p.set("style", "candles");
  p.set("v", WEEKEND_CHART_REV);
  const levelName = String(story?.level_name || "").trim();
  if (levelName) p.set("subtitle", levelName.slice(0, 80));
  else if (story?.headline) p.set("subtitle", String(story.headline).slice(0, 80));
  const level = Number(story?.level);
  const slope = Number(story?.slope);
  const roleLabel = story?.level_role === "support"
    ? "Support"
    : story?.level_role === "resistance"
      ? "Resistance"
      : "";
  const canDrawTl = tfClean === "D"
    && Number.isFinite(slope)
    && slope !== 0
    && Number.isFinite(level)
    && level > 0;
  if (canDrawTl) {
    // Slope is per daily bar of a local fit. Do not project it across
    // the full 90-bar window or a steep CDNS-style line leaves the tape.
    const span = Math.min(Math.max(bars - 1, 1), 36);
    const tl0 = level - slope * span;
    const tl1 = level;
    if (tl0 > 0 && tl1 > 0) {
      p.set("tl0", String(Number(tl0.toFixed(4))));
      p.set("tl1", String(Number(tl1.toFixed(4))));
      p.set("tl_span", String(span));
      if (roleLabel) p.set("tl_label", roleLabel);
    }
  } else if (Number.isFinite(level) && level > 0) {
    p.set("entry", String(level));
    p.set("level_label", story?.kind === "magnet" ? "Target" : (roleLabel || "Level"));
  }
  const target = Number(story?.target);
  if (Number.isFinite(target) && target > 0 && target !== level) {
    p.set("tp", String(target));
  }
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
    const side = _dir(story.dir || card.dir);
    const rank = (STORY_KIND_RANK[kind] || 0)
      + (story.posture === "already_watching" ? 6 : 0)
      + (story.volume === "quiet" && kind === "quiet_pierce" ? 6 : 0)
      + (story.volume === "expanded" && (kind === "fired" || kind === "retest") ? 5 : 0)
      + (side === "LONG" ? 16 : 0)
      + Math.min(Number(card.score) || 0, 24) * 0.15
      + (card.timed_uptick ? 3 : 0);
    scored.push({ card, story, rank, ticker, kind, side });
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
  const QUALITY_SHORT = new Set(["retest", "fired", "quiet_pierce"]);
  // Longs first, still one-kind-first so the mail does not stack clones.
  for (const row of scored) {
    if (row.side !== "LONG") continue;
    if ((kindCount[row.kind] || 0) >= 1) continue;
    take(row);
  }
  for (const row of scored) {
    if (row.side !== "LONG") continue;
    if ((kindCount[row.kind] || 0) >= 2) continue;
    take(row);
  }
  // Quality shorts only when longs are thin (fewer than 3).
  if (picked.length < 3 && picked.length < limit) {
    for (const row of scored) {
      if (row.side !== "SHORT") continue;
      if (!QUALITY_SHORT.has(row.kind)) continue;
      if ((kindCount[row.kind] || 0) >= 2) continue;
      take(row);
    }
  }
  if (picked.length < limit) {
    for (const row of scored) {
      if (row.side === "SHORT") continue;
      if ((kindCount[row.kind] || 0) >= 2) continue;
      take(row);
    }
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
  const QUALITY_SHORT = new Set(["retest", "fired", "quiet_pierce"]);
  const rankAlso = (a, b) => {
    const aNew = featuredKinds.has(a.story?.kind) ? 0 : 1;
    const bNew = featuredKinds.has(b.story?.kind) ? 0 : 1;
    return bNew - aNew
      || (STORY_KIND_RANK[b.story?.kind] || 0) - (STORY_KIND_RANK[a.story?.kind] || 0)
      || (b.score || 0) - (a.score || 0);
  };
  const longs = scored.filter((c) => _dir(c.story?.dir || c.dir) === "LONG").sort(rankAlso);
  const qualityShorts = scored.filter((c) => _dir(c.story?.dir || c.dir) === "SHORT"
    && QUALITY_SHORT.has(c.story?.kind)).sort(rankAlso);
  return [...longs, ...qualityShorts].slice(0, limit).map((card) => ({
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
    notes.push("Level pierced on light volume — not a confirmed break");
  } else if (vol.confirmedBreak) {
    score += 6;
    tags.push("volume_confirm");
    families.add("volume");
    notes.push("Volume expanded through the level");
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
    long_label: weekendDeskLongLabel(now),
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
    `TT Setups · Weekend watch · ${desk.long_label || desk.label}`,
    desk.disclaimer,
    "",
    featured.length
      ? `${featured.length} name${featured.length === 1 ? "" : "s"} with a defined support or resistance into the next session.`
      : "No clean setups cleared the bar this weekend.",
    "",
  ];
  featured.forEach((c, i) => {
    const s = c.story || {};
    const chipBits = [c.ticker];
    if (s.price > 0) chipBits.push(fmtPx(s.price));
    if (s.dir === "LONG" || s.dir === "SHORT") chipBits.push(s.dir);
    lines.push(`${i + 1}. ${chipBits.join(" ")}`);
    lines.push(s.posture === "already_watching" ? "Already watching" : "Should be watching");
    lines.push(s.headline || c.headline || "");
    if (s.level_name) lines.push(s.level_name);
    const obj = objectiveLine(s);
    if (obj) lines.push(obj);
    lines.push(s.why || "");
    if (s.watching_for) lines.push(`Watch: ${s.watching_for}`);
    lines.push("");
  });
  if (also.length) {
    lines.push("ALSO ON THE TAPE");
    for (const c of also) {
      const s = c.story || {};
      const obj = objectiveLine(s);
      const alsoBits = [c.ticker];
      if (s.price > 0) alsoBits.push(fmtPx(s.price));
      if (s.dir === "LONG" || s.dir === "SHORT") alsoBits.push(s.dir);
      lines.push(`- ${alsoBits.join(" ")} — ${s.headline || c.headline || "setup"}`);
      if (s.level_name) lines.push(`  ${s.level_name}`);
      if (obj) lines.push(`  ${obj}`);
    }
    lines.push("");
  }
  lines.push(`Open Today: ${WEEKEND_DESK_PAGE}`);
  return lines.join("\n");
}

function featuredBlock(card, index, origin, { compact = false } = {}) {
  const s = card.story || {};
  const ticker = String(card.ticker || s.ticker || "").toUpperCase();
  const chart = weekendSetupChartUrl({ ...s, ticker }, origin);
  const posture = s.posture === "already_watching" ? "Already watching" : "Should be watching";
  const today = `https://timed-trading.com/today.html?ticker=${encodeURIComponent(ticker)}`;
  const tfLabel = chartTfLabel(s.chart_tf);
  const chip = buildEmailBriefTickerChip(ticker, s.day_pct, null, origin, null, {
    price: s.price,
    dir: s.dir,
  });
  const kindLabel = s.kind_label || STORY_KIND_LABEL[s.kind] || "";
  const levelName = s.level_name || "";
  const obj = objectiveLine(s);
  const headlineSize = compact ? 18 : 22;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px">
    <tr><td style="padding:${index > 1 ? "28px 0 0" : "0"};${index > 1 ? `border-top:1px solid ${BRAND.border};` : ""}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td style="vertical-align:middle">${chip}</td>
          <td align="right" style="font-family:${EMAIL_FONT_UI};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.textMuted}">${_esc(kindLabel)}${kindLabel ? " · " : ""}${_esc(posture)}</td>
        </tr>
      </table>
      <div style="font-family:${EMAIL_FONT_EDITORIAL};font-size:${headlineSize}px;line-height:1.25;font-weight:400;color:white;margin:12px 0 8px">${_esc(s.headline || ticker)}</div>
      ${levelName ? `<div style="font-family:${EMAIL_FONT_UI};font-size:12px;color:${BRAND.textMuted};margin:0 0 6px">${_esc(levelName)}</div>` : ""}
      ${obj ? `<div style="font-family:${EMAIL_FONT_UI};font-size:13px;color:${BRAND.editorial};margin:0 0 10px">${_esc(obj)}</div>` : ""}
      <p style="margin:0 0 10px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6;font-family:${EMAIL_FONT_UI}">${_esc(s.why || "")}</p>
      ${s.watching_for ? `<p style="margin:0 0 14px;font-size:14px;color:${BRAND.textSecondary};line-height:1.55;font-family:${EMAIL_FONT_UI}"><span style="font-size:10px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${BRAND.editorial}">Watch</span> ${_esc(s.watching_for)}</p>` : ""}
      <a href="${today}" style="display:block;line-height:0;border-radius:8px;overflow:hidden;border:1px solid ${BRAND.border}">
        <img src="${_esc(chart)}" alt="${_esc(ticker)} ${tfLabel} candles" width="600" style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px" />
      </a>
      <div style="margin:6px 2px 12px;font-size:10px;color:${BRAND.textMuted};font-family:${EMAIL_FONT_UI}">${_esc(tfLabel)} candles${levelName ? ` · ${_esc(levelName)}` : ""}</div>
      <a href="${today}" style="color:${BRAND.green};text-decoration:none;font-size:13px;font-weight:600;font-family:${EMAIL_FONT_UI}">Open ${_esc(ticker)} on Today →</a>
    </td></tr>
  </table>`;
}

export function renderWeekendDeskHtml(desk, { unsubscribeUrl, origin, preview = false } = {}) {
  const base = String(origin || desk.chart_origin || "https://timed-trading.com").replace(/\/$/, "");
  const featured = desk.featured || desk.tt_setups || [];
  const also = desk.also_on_tape || [];
  const count = featured.length;
  const intro = count
    ? `${count} name${count === 1 ? "" : "s"} with a defined support or resistance into the next session. Daily candles keep gaps visible. A hold or rejection at the named level is the tell — not the first print through it.`
    : "No clean setups cleared the bar this weekend. The desk will look again after the next session.";
  const featuredHtml = featured.length
    ? featured.map((c, i) => featuredBlock(c, i + 1, base)).join("")
    : `<p style="margin:0 0 18px;font-size:14px;color:${BRAND.textMuted};font-family:${EMAIL_FONT_UI}">No clean setups cleared the bar this weekend.</p>`;
  const alsoHtml = also.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0 8px">
        <tr><td style="padding:0 0 10px;font-size:10px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${BRAND.textMuted};font-family:${EMAIL_FONT_UI}">Also on the tape</td></tr>
      </table>
      ${also.map((c, i) => featuredBlock(c, i + 1, base, { compact: true })).join("")}`
    : "";
  const previewNote = preview
    ? `<p style="margin:0 0 16px;font-size:12px;color:${BRAND.warning};font-family:${EMAIL_FONT_UI};line-height:1.45">Preview — admin only. The list is not going to members until the desk locks the copy.</p>`
    : "";
  const longDate = desk.long_label || desk.label;
  const body = `
    <div style="font-size:10px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${BRAND.editorial};font-family:${EMAIL_FONT_UI};margin:0 0 6px">TT Setups</div>
    <h1 style="margin:0 0 8px;font-size:32px;font-weight:400;color:white;font-family:${EMAIL_FONT_EDITORIAL};letter-spacing:-0.015em;line-height:1.1">Weekend watch</h1>
    <p style="margin:0 0 16px;font-size:13px;color:${BRAND.textMuted};font-family:${EMAIL_FONT_UI}">${_esc(longDate)}</p>
    ${previewNote}
    <p style="margin:0 0 22px;font-size:15px;color:${BRAND.textSecondary};line-height:1.6;font-family:${EMAIL_FONT_UI}">${intro}</p>
    ${featuredHtml}
    ${alsoHtml}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 0">
      <tr><td style="background:${BRAND.green};border-radius:8px;padding:10px 24px">
        <a href="${WEEKEND_DESK_PAGE}" style="color:white;font-size:13px;font-weight:600;text-decoration:none;display:inline-block;font-family:${EMAIL_FONT_UI}">Open Today</a>
      </td></tr>
    </table>
    <p style="margin:14px 0 0;font-size:11px;color:${BRAND.textMuted};line-height:1.45;font-family:${EMAIL_FONT_UI}">${_esc(desk.disclaimer)}</p>
  `;
  return emailLayout(body, {
    unsubscribeUrl,
    preheader: `TT Setups · Weekend watch · ${count} name${count === 1 ? "" : "s"} · ${desk.label}`,
  });
}

export function weekendDeskHasYouYour(htmlOrText) {
  return /\b(you|your|you're|you've|you'll)\b/i.test(String(htmlOrText || ""));
}

/** Email only when asked (or forced). Refresh with email=0 must not send. */
export function weekendDeskShouldEmail({
  composeNow = true,
  rescoreDone = true,
  wantEmail = false,
  forceEmail = false,
} = {}) {
  if (!composeNow) return false;
  if (forceEmail) return true;
  return !!(rescoreDone && wantEmail);
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

export function weekendDeskBroadcastEnabled(env) {
  const v = String(env?.WEEKEND_DESK_BROADCAST || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Admin-only until WEEKEND_DESK_BROADCAST is explicitly on. */
export function weekendDeskEmailRecipients(env, optedUsers = []) {
  const admin = String(env?.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!weekendDeskBroadcastEnabled(env)) {
    return admin ? [{ email: admin, preview: true }] : [];
  }
  const seen = new Set();
  const out = [];
  if (admin) {
    seen.add(admin);
    out.push({ email: admin });
  }
  for (const u of optedUsers || []) {
    const email = String(u?.email || "").toLowerCase().trim();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ ...u, email });
  }
  return out;
}

export async function sendWeekendDeskEmails(env, desk, { sendFn = sendEmail } = {}) {
  const optedRaw = await getEmailOptedInUsers(env, WEEKEND_DESK_PREF).catch(() => []);
  const recipients = weekendDeskEmailRecipients(env, optedRaw);
  const preview = !weekendDeskBroadcastEnabled(env);
  if (!recipients.length) {
    return {
      sent: 0,
      failed: 0,
      recipients: 0,
      preview,
      skipped: preview ? "no_admin_email" : "no_recipients",
      to: [],
    };
  }
  const baseUrl = String(env?.WORKER_URL || "https://timed-trading.com").replace(/\/$/, "");
  let sent = 0;
  let failed = 0;
  const subject = preview
    ? `TT Setups preview · ${desk.label}`
    : `TT Setups · ${desk.label}`;
  for (const u of recipients) {
    const unsubscribeUrl = env?.EMAIL_HMAC_SECRET
      ? await buildUnsubscribeUrl(baseUrl, u.email, WEEKEND_DESK_PREF, env.EMAIL_HMAC_SECRET).catch(() => null)
      : null;
    const html = renderWeekendDeskHtml(desk, { unsubscribeUrl, origin: baseUrl, preview });
    const text = renderWeekendDeskText(desk);
    try {
      const r = await sendFn(env, {
        to: u.email,
        subject,
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
  return {
    sent,
    failed,
    recipients: recipients.length,
    preview,
    skipped: null,
    to: recipients.map((r) => r.email),
  };
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
  const shouldEmail = !!(desk && weekendDeskShouldEmail({
    composeNow,
    rescoreDone,
    wantEmail,
    forceEmail,
  }));
  if (shouldEmail) {
    const weekendKey = desk.weekend_key || weekendDeskKey(now);
    const lock = forceEmail
      ? { ok: true, weekendKey, lockKey: `${WEEKEND_DESK_SENT_PREFIX}${weekendKey}` }
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
