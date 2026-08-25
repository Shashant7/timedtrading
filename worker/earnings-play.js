// worker/earnings-play.js — Earnings play block for the lotto strip (2026-08-25)
//
// The earnings-prep lotto (options-plays.js `shouldActivateEarningsPrepLotto`)
// already decides WHEN a cheap OTM contract into a 1–5 day (or same-day AMC)
// print is allowed.
// This module answers the operator's next three questions on that card:
//
//   Catalyst   — when is the print, and what move does the options market
//                already imply through the contract's expiration?
//   Confluence — do the technical verdict, the fundamentals, the retail
//                tape, and the research desk lean the same way?
//   Target     — where does the underlying have to go, and what kills it?
//
// Every input is data the system already stores. Nothing is invented: when
// the chain is missing the implied move is null and the card says so.

import { blackScholes } from "./options-plays.js";
import { overlayConvexityCardPremium, chainStrikeRangeForPlay } from "./options-convexity.js";
import { getStaticCalendar, previousTradingDay } from "./market-calendar.js";

export const EARNINGS_PLAY_MAX_CARDS = 3;

// Expected move ≈ 0.85 × ATM straddle. The straddle itself prices the move
// PLUS the volatility premium, so quoting it raw overstates the move the
// market expects. 0.85 is the desk convention.
export const STRADDLE_EXPECTED_MOVE_FACTOR = 0.85;

// Only a genuinely at-the-money pair prices the move. Further out, the
// straddle carries intrinsic value that inflates the estimate.
const ATM_MAX_DRIFT_PCT = 0.03;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(n, dp = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** `2026-08-27` → `Wed Aug 27`. Dates are trading days, not instants. */
export function formatReportDate(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Vendor `hour` field (bmo / amc / dmh) → display session. */
export function normalizeReportSession(hour) {
  const h = String(hour || "").trim().toLowerCase();
  if (h === "bmo" || h.includes("before")) return "BMO";
  if (h === "amc" || h.includes("after")) return "AMC";
  if (h === "dmh" || h.includes("during")) return "DMH";
  return null;
}

/**
 * Does the contract still exist when the print lands?
 *   BMO — the report is out before that session, so an expiry ON the report
 *         date still trades the reaction.
 *   AMC / unknown — the report lands after the close, so the expiry has to
 *         be strictly later.
 */
export function contractCoversPrint({ expirationIso, reportDate, session }) {
  const exp = String(expirationIso || "").slice(0, 10);
  const rep = String(reportDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp) || !/^\d{4}-\d{2}-\d{2}$/.test(rep)) return null;
  const sess = normalizeReportSession(session);
  if (sess === "BMO" || sess === "DMH") return exp >= rep;
  return exp > rep;
}

/**
 * Implied move from the ATM straddle. Returns null when either leg is
 * missing a usable mid — an estimated straddle is worse than no number.
 */
export function atmStraddleImpliedMove({ calls, puts, spot } = {}) {
  const px = num(spot);
  if (!(px > 0) || !Array.isArray(calls) || !Array.isArray(puts)) return null;
  const callByStrike = new Map();
  for (const leg of calls) {
    const k = num(leg?.strike);
    if (k > 0) callByStrike.set(k, leg);
  }
  const candidates = [];
  for (const put of puts) {
    const k = num(put?.strike);
    if (!(k > 0)) continue;
    const call = callByStrike.get(k);
    if (!call) continue;
    const drift = Math.abs(k - px) / px;
    if (drift > ATM_MAX_DRIFT_PCT) continue;
    candidates.push({ strike: k, drift, call, put });
  }
  candidates.sort((a, b) => a.drift - b.drift);
  let best = null;
  let callMid = null;
  let putMid = null;
  for (const c of candidates) {
    const cm = num(c.call.mid) ?? num(c.call.last);
    const pm = num(c.put.mid) ?? num(c.put.last);
    if (cm > 0 && pm > 0) { best = c; callMid = cm; putMid = pm; break; }
  }
  if (!best) return null;
  // Strip the intrinsic value the near-the-money leg carries so the number
  // is the move the market implies, not the distance to the strike.
  const straddle = Math.max(0, callMid + putMid - Math.abs(px - best.strike));
  if (!(straddle > 0)) return null;
  const moveUsd = straddle * STRADDLE_EXPECTED_MOVE_FACTOR;
  const ivs = [num(best.call.implied_volatility), num(best.put.implied_volatility)].filter((v) => v > 0);
  const ivAvg = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  return {
    implied_move_usd: round(moveUsd, 2),
    implied_move_pct: round((moveUsd / px) * 100, 2),
    iv_atm_pct: ivAvg == null ? null : round(ivAvg * 100, 1),
    atm_strike: best.strike,
    straddle_mid: round(straddle, 2),
    basis: "atm_straddle",
  };
}

/** Fallback: IV × √(t/365) when the chain has IV but no two-sided quotes. */
export function ivImpliedMove({ ivPct, spot, days } = {}) {
  const iv = num(ivPct);
  const px = num(spot);
  const d = num(days);
  if (!(iv > 0) || !(px > 0) || !(d > 0)) return null;
  const movePct = iv * Math.sqrt(d / 365);
  return {
    implied_move_usd: round((movePct / 100) * px, 2),
    implied_move_pct: round(movePct, 2),
    iv_atm_pct: round(iv, 1),
    atm_strike: null,
    straddle_mid: null,
    basis: "iv_sqrt_t",
  };
}

/** At-the-money IV (percent) from a chain — the term-structure reference. */
export function atmIvFromChain({ chain, spot } = {}) {
  const px = num(spot);
  if (!(px > 0)) return null;
  const legs = [...(chain?.calls || []), ...(chain?.puts || [])];
  let best = null;
  for (const leg of legs) {
    const k = num(leg?.strike);
    const iv = num(leg?.implied_volatility);
    if (!(k > 0) || !(iv > 0)) continue;
    const drift = Math.abs(k - px) / px;
    if (drift > ATM_MAX_DRIFT_PCT) continue;
    if (!best || drift < best.drift) best = { drift, iv };
  }
  return best ? round(best.iv * 100, 1) : null;
}

/**
 * Expiration to read post-print volatility from: the first one at least a
 * week past the contract in hand, so the event week's inflation is out of
 * it. Falls back to the last listed expiry after the contract.
 */
export function pickBackExpiration(expirations, frontIso) {
  const front = String(frontIso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(front)) return null;
  const later = (Array.isArray(expirations) ? expirations : [])
    .map((e) => String(e || "").slice(0, 10))
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e) && e > front)
    .sort();
  if (later.length === 0) return null;
  const cutoff = new Date(Date.parse(`${front}T12:00:00Z`) + 7 * 86400000)
    .toISOString().slice(0, 10);
  return later.find((e) => e >= cutoff) || later[later.length - 1];
}

export function resolveImpliedMove({ chain, spot, days } = {}) {
  const straddle = atmStraddleImpliedMove({ calls: chain?.calls, puts: chain?.puts, spot });
  if (straddle) return straddle;
  const legs = [...(chain?.calls || []), ...(chain?.puts || [])];
  const px = num(spot);
  let nearest = null;
  for (const leg of legs) {
    const k = num(leg?.strike);
    const iv = num(leg?.implied_volatility);
    if (!(k > 0) || !(iv > 0) || !(px > 0)) continue;
    const drift = Math.abs(k - px) / px;
    if (drift > ATM_MAX_DRIFT_PCT) continue;
    if (!nearest || drift < nearest.drift) nearest = { drift, iv };
  }
  if (!nearest) return null;
  return ivImpliedMove({ ivPct: nearest.iv * 100, spot, days });
}

/* ── IV crush ────────────────────────────────────────────────────────── */

// Same convention the options ladder already uses for its no-chain IV
// proxy: daily ATR% × √252 is the annualized realized move.
export function realizedVolProxyPct(atrPct) {
  const a = num(atrPct);
  if (!(a > 0)) return null;
  const raw = a * Math.sqrt(252) * 100;
  return round(Math.max(15, Math.min(200, raw)), 1);
}

/**
 * Smallest underlying move that keeps the contract worth what it cost once
 * the event premium is gone. This is the number that decides whether
 * holding through a print can pay at all: if it sits beyond the move the
 * market implies, a correct direction still loses.
 */
export function postCrushBreakeven({
  spot,
  strike,
  type,
  entryPremium,
  daysAfterPrint,
  postCrushIvPct,
} = {}) {
  const S0 = num(spot);
  const K = num(strike);
  const P = num(entryPremium);
  const sigma = num(postCrushIvPct);
  const days = num(daysAfterPrint);
  if (!(S0 > 0) || !(K > 0) || !(P > 0) || !(sigma > 0) || !(days > 0)) return null;
  const T = days / 365;
  const right = String(type || "").toUpperCase() === "P" ? "P" : "C";
  const valueAt = (S) => {
    const r = blackScholes({ S, K, T, sigma: sigma / 100, type: right });
    return r ? r.price : 0;
  };
  const flat = valueAt(S0);
  if (flat >= P) {
    return {
      breakeven_price: round(S0, 2),
      breakeven_move_pct: 0,
      premium_flat: round(flat, 2),
    };
  }
  // Bisect from "no move" toward the direction that helps the contract.
  let lo = S0;
  let hi = right === "C" ? S0 * 3 : S0 * 0.05;
  if (valueAt(hi) < P) {
    return { breakeven_price: null, breakeven_move_pct: null, premium_flat: round(flat, 2) };
  }
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    if (valueAt(mid) >= P) hi = mid; else lo = mid;
  }
  const be = hi;
  return {
    breakeven_price: round(be, 2),
    breakeven_move_pct: round(Math.abs((be - S0) / S0) * 100, 2),
    premium_flat: round(flat, 2),
  };
}

/** Last session a position can be closed while the event premium is intact. */
export function crushExitBy({ reportDate, session, cal = null }) {
  const rep = String(reportDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rep)) return null;
  const sess = normalizeReportSession(session);
  // After the close: the report date's own session is still safe.
  // Before the open or intraday: the prior session is the last safe close.
  if (sess === "AMC") return { date: rep, label: `the close on ${formatReportDate(rep)}` };
  const calendar = cal || getStaticCalendar();
  const prev = previousTradingDay(calendar, rep);
  return { date: prev, label: `the close on ${formatReportDate(prev)}` };
}

function crushSeverity({ crushPct, ivRvRatio }) {
  const c = num(crushPct);
  const r = num(ivRvRatio);
  if (c == null && r == null) return "UNKNOWN";
  if ((c != null && c >= 45) || (r != null && r >= 2)) return "EXTREME";
  if ((c != null && c >= 25) || (r != null && r >= 1.4)) return "ELEVATED";
  return "NORMAL";
}

/**
 * What the print does to the premium, and what to do about it.
 *
 * Post-crush volatility comes from the next expiration's at-the-money IV
 * when the chain has one (the term-structure gap IS the event premium);
 * otherwise from the realized-vol proxy. With neither, the block reports
 * UNKNOWN rather than inventing a haircut.
 */
export function buildCrushBlock({
  side,
  spot,
  strike,
  entryPremium,
  dte,
  daysToPrint,
  ivFrontPct,
  ivBackPct,
  atrPct,
  impliedMovePct,
  coversPrint,
  reportDate,
  session,
  cal = null,
} = {}) {
  const ivFront = num(ivFrontPct);
  const rv = realizedVolProxyPct(atrPct);
  const ivBack = num(ivBackPct);
  let ivPost = null;
  let basis = null;
  if (ivBack > 0 && (!(ivFront > 0) || ivBack < ivFront)) {
    ivPost = ivBack;
    basis = "term_structure";
  } else if (rv > 0 && (!(ivFront > 0) || rv < ivFront)) {
    ivPost = rv;
    basis = "realized_vol";
  }
  const ivRvRatio = (ivFront > 0 && rv > 0) ? round(ivFront / rv, 2) : null;
  const crushPct = (ivFront > 0 && ivPost > 0) ? round((1 - ivPost / ivFront) * 100, 0) : null;

  const daysAfterPrint = (num(dte) != null && num(daysToPrint) != null)
    ? Math.max(0.5, num(dte) - num(daysToPrint))
    : null;
  const be = (coversPrint !== false)
    ? postCrushBreakeven({
        spot,
        strike,
        type: String(side || "").toUpperCase() === "SHORT" ? "P" : "C",
        entryPremium,
        daysAfterPrint,
        postCrushIvPct: ivPost,
      })
    : null;

  const premiumFlat = num(be?.premium_flat);
  const entry = num(entryPremium);
  const premiumFlatPct = (premiumFlat != null && entry > 0)
    ? round(((premiumFlat - entry) / entry) * 100, 0)
    : null;
  const beMove = num(be?.breakeven_move_pct);
  const implied = num(impliedMovePct);
  const coveredByImplied = (beMove != null && implied > 0) ? beMove <= implied : null;
  // The implied move is roughly a one-standard-deviation figure, so a
  // breakeven that only just fits inside it is not a cushion — the print
  // has to land in the upper half of the cone AND on the right side.
  const cushionRatio = (beMove != null && implied > 0) ? round(beMove / implied, 2) : null;

  const severity = crushSeverity({ crushPct, ivRvRatio });
  const exitBy = crushExitBy({ reportDate, session, cal });

  let recommendation = "UNKNOWN";
  if (coversPrint === false) recommendation = "RUN_UP_ONLY";
  else if (coveredByImplied === false) recommendation = "EXIT_BEFORE_PRINT";
  else if (coveredByImplied === true) {
    recommendation = (cushionRatio != null && cushionRatio > 0.6) ? "TIGHT_HOLD" : "CAN_HOLD_THROUGH";
  }

  const flatBit = premiumFlat != null
    ? ` At an unchanged price the premium is worth about $${premiumFlat}${premiumFlatPct != null ? ` (${premiumFlatPct}%)` : ""}.`
    : "";
  let note;
  if (recommendation === "RUN_UP_ONLY") {
    note = "Contract expires before the print — crush is not the risk here; the run-up is the whole trade.";
  } else if (recommendation === "EXIT_BEFORE_PRINT") {
    note = `Crush math fails: the contract needs ${beMove}% to break even after the print, more than the ${round(implied, 1)}% the market implies. Plan the exit by ${exitBy?.label || "the last session before the print"}.`;
  } else if (recommendation === "TIGHT_HOLD") {
    note = `Thin cushion: breakeven ${beMove}% against an implied ${round(implied, 1)}% means the print has to land in the upper half of the cone and on the right side. Exiting by ${exitBy?.label || "the last session before the print"} keeps the event premium.${flatBit}`;
  } else if (recommendation === "CAN_HOLD_THROUGH") {
    note = `Holding through the print needs ${beMove}% against an implied ${round(implied, 1)}%.${flatBit}`;
  } else {
    note = "No post-print volatility reference — IV crush magnitude is unmeasured on this contract. Size for total premium loss.";
  }

  return {
    severity,
    recommendation,
    iv_front_pct: ivFront > 0 ? round(ivFront, 1) : null,
    iv_post_pct: ivPost != null ? round(ivPost, 1) : null,
    iv_post_basis: basis,
    rv_proxy_pct: rv,
    iv_rv_ratio: ivRvRatio,
    crush_pct: crushPct,
    premium_flat: premiumFlat,
    premium_flat_pct: premiumFlatPct,
    breakeven_price: num(be?.breakeven_price),
    breakeven_move_pct: beMove,
    covered_by_implied_move: coveredByImplied,
    cushion_ratio: cushionRatio,
    exit_by: exitBy,
    note,
  };
}

/* ── Confluence pillars ──────────────────────────────────────────────── */

const TECHNICAL_MODE_POINTS = { RIDE: 40, READY: 34, DRIFT: 24, WAIT: 12 };

function technicalPillar({ side, confluence }) {
  const mode = String(confluence?.mode || "").toUpperCase();
  if (!mode) return { key: "technical", label: "Technical", state: "unknown", points: 0, note: "No confluence verdict" };
  const verdictSide = String(confluence?.side || "").toUpperCase();
  const timing = confluence?.timing || {};
  const timingSide = timing.call_opportunity ? "LONG" : timing.put_opportunity ? "SHORT" : null;
  const base = TECHNICAL_MODE_POINTS[mode] ?? 0;
  if (verdictSide && side && verdictSide !== side) {
    return {
      key: "technical",
      label: "Technical",
      state: "against",
      points: 0,
      note: `Confluence ${mode} leans ${verdictSide}`,
    };
  }
  const bonus = timingSide && timingSide === side ? 4 : 0;
  return {
    key: "technical",
    label: "Technical",
    state: mode === "WAIT" ? "mixed" : "aligned",
    points: Math.min(40, base + bonus),
    note: `Confluence ${mode}${timingSide === side ? " + compression timing" : ""}`,
  };
}

function fundamentalPillar({ side, fundamentals }) {
  const earnings = fundamentals?.earnings || {};
  const growth = fundamentals?.growth || {};
  const beatRate = num(earnings.beat_rate_pct);
  const avgSurprise = num(earnings.avg_surprise_pct);
  const epsGrowth = num(growth.eps_growth_pct);
  const revGrowth = num(growth.rev_growth_pct);
  if (beatRate == null && avgSurprise == null && epsGrowth == null && revGrowth == null) {
    return { key: "fundamental", label: "Fundamentals", state: "unknown", points: 0, note: "No fundamentals snapshot" };
  }
  let bull = 0;
  const bits = [];
  if (beatRate != null) {
    if (beatRate >= 75) { bull += 2; bits.push(`beat rate ${Math.round(beatRate)}%`); }
    else if (beatRate >= 50) { bull += 1; bits.push(`beat rate ${Math.round(beatRate)}%`); }
    else { bull -= 1; bits.push(`beat rate ${Math.round(beatRate)}%`); }
  }
  if (avgSurprise != null) {
    if (avgSurprise >= 5) { bull += 1; bits.push(`avg surprise +${round(avgSurprise, 1)}%`); }
    else if (avgSurprise <= -2) { bull -= 1; bits.push(`avg surprise ${round(avgSurprise, 1)}%`); }
  }
  if (earnings.estimates_up) { bull += 1; bits.push("estimates rising"); }
  if (earnings.guidance_higher) { bull += 1; bits.push("guidance raised"); }
  const growthPct = epsGrowth ?? revGrowth;
  if (growthPct != null) {
    if (growthPct >= 25) { bull += 1; bits.push(`growth +${Math.round(growthPct)}%`); }
    else if (growthPct < 0) { bull -= 1; bits.push(`growth ${Math.round(growthPct)}%`); }
  }
  const bias = bull > 0 ? "LONG" : bull < 0 ? "SHORT" : null;
  const magnitude = Math.min(25, Math.abs(bull) * 6);
  const note = bits.slice(0, 3).join(", ") || "Mixed record";
  if (!bias) return { key: "fundamental", label: "Fundamentals", state: "mixed", points: 6, note };
  if (bias !== side) return { key: "fundamental", label: "Fundamentals", state: "against", points: 0, note };
  return { key: "fundamental", label: "Fundamentals", state: "aligned", points: magnitude, note };
}

function socialPillar({ side, social }) {
  if (!social || social.has_data === false) {
    return { key: "social", label: "Social tape", state: "unknown", points: 0, note: "No social snapshot" };
  }
  const bullRatio = num(social.bull_ratio_pct);
  const msgs = num(social.message_count_24h) || 0;
  const spike = num(social.reddit?.spike_ratio);
  const bits = [];
  let bias = null;
  if (bullRatio != null) {
    bits.push(`${Math.round(bullRatio)}% bullish`);
    if (bullRatio >= 62) bias = "LONG";
    else if (bullRatio <= 42) bias = "SHORT";
  }
  if (msgs > 0) bits.push(`${msgs} msgs/24h`);
  if (spike != null && spike >= 2) bits.push(`Reddit ${round(spike, 1)}x mentions`);
  const conviction = (msgs >= 50 ? 2 : msgs >= 10 ? 1 : 0) + (spike != null && spike >= 2 ? 1 : 0);
  const note = bits.slice(0, 3).join(", ") || "Quiet tape";
  if (!bias) return { key: "social", label: "Social tape", state: "mixed", points: 4, note };
  if (bias !== side) return { key: "social", label: "Social tape", state: "against", points: 0, note };
  return { key: "social", label: "Social tape", state: "aligned", points: Math.min(20, 10 + conviction * 3), note };
}

function researchPillar({ fsd, now = Date.now() }) {
  const pubs = Array.isArray(fsd?.publications) ? fsd.publications : [];
  if (pubs.length === 0) {
    return { key: "research", label: "Research desk", state: "unknown", points: 0, note: "No desk coverage" };
  }
  const latest = pubs.reduce((acc, p) => {
    const ts = num(p?.published_at) || num(p?.fetched_at) || 0;
    return ts > acc ? ts : acc;
  }, 0);
  const ageDays = latest > 0 ? (now - latest) / 86400000 : null;
  const fresh = ageDays != null && ageDays <= 3;
  const points = fresh ? 15 : ageDays != null && ageDays <= 7 ? 9 : 5;
  const ageBit = ageDays == null ? "" : ageDays < 1 ? " today" : ` ${Math.round(ageDays)}d ago`;
  return {
    key: "research",
    label: "Research desk",
    state: fresh ? "aligned" : "mixed",
    points,
    note: `${pubs.length} mention${pubs.length === 1 ? "" : "s"}${ageBit}`,
  };
}

/**
 * Four-pillar read on a print. Returns a 0–100 alignment score plus the
 * pillar detail so the card can show WHY, not just a number.
 */
export function scoreEarningsConfluence({ side, confluence, fundamentals, social, fsd, now = Date.now() } = {}) {
  const dir = String(side || "").toUpperCase();
  const pillars = [
    technicalPillar({ side: dir, confluence }),
    fundamentalPillar({ side: dir, fundamentals }),
    socialPillar({ side: dir, social }),
    researchPillar({ fsd, now }),
  ];
  const score = Math.max(0, Math.min(100, pillars.reduce((sum, p) => sum + (Number(p.points) || 0), 0)));
  const aligned = pillars.filter((p) => p.state === "aligned");
  const against = pillars.filter((p) => p.state === "against");
  let verdict = "THIN";
  if (against.length === 0 && score >= 65) verdict = "CONFLUENT";
  else if (score >= 40 && against.length <= 1) verdict = "MIXED";
  return {
    score,
    verdict,
    aligned_count: aligned.length,
    against_count: against.length,
    pillars,
    summary: `${aligned.length}/4 aligned${against.length ? `, ${against.length} against` : ""}`,
  };
}

/* ── Card block ──────────────────────────────────────────────────────── */

/**
 * Compose the `earnings_play` block attached to an earnings-prep lotto
 * card. `impliedMove` may be null — the block then says the chain was
 * unavailable rather than substituting a guess.
 */
export function buildEarningsPlay({
  ticker,
  side,
  spot,
  event,
  expiration,
  impliedMove,
  confluence,
  fundamentals,
  social,
  fsd,
  multiBaggerTargets,
  strike,
  entryPremium,
  ivBackPct,
  atrPct,
  cal = null,
  now = Date.now(),
} = {}) {
  const sym = String(ticker || "").toUpperCase();
  const dir = String(side || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
  const px = num(spot);
  const reportDate = String(event?.date || "").slice(0, 10) || null;
  if (!sym || !reportDate) return null;
  const session = normalizeReportSession(event?.hour);
  const daysToPrint = num(event?.days_to_print);
  const dateLabel = formatReportDate(reportDate);
  const covers = contractCoversPrint({
    expirationIso: expiration?.iso,
    reportDate,
    session: event?.hour,
  });

  const movePct = num(impliedMove?.implied_move_pct);
  const moveUsd = num(impliedMove?.implied_move_usd);
  const expectedRange = (px > 0 && moveUsd > 0)
    ? { low: round(px - moveUsd, 2), high: round(px + moveUsd, 2) }
    : null;

  const alignment = scoreEarningsConfluence({ side: dir, confluence, fundamentals, social, fsd, now });

  let target = null;
  if (px > 0 && movePct > 0) {
    const level = dir === "SHORT" ? px * (1 - movePct / 100) : px * (1 + movePct / 100);
    target = {
      underlying: round(level, 2),
      basis: "implied_move",
      note: `Implied-move target — the print has to clear ${round(movePct, 1)}% to pay`,
    };
  } else {
    const mb = num(multiBaggerTargets?.["3x_underlying_at"]) ?? num(multiBaggerTargets?.["2x_underlying_at"]);
    if (mb != null) {
      target = {
        underlying: round(mb, 2),
        basis: "premium_multiple",
        note: "Premium-multiple target — no chain quote to imply a move",
      };
    }
  }

  const catalystBits = [
    `Earnings${session ? ` ${session}` : ""}${dateLabel ? ` ${dateLabel}` : ""}`,
    Number.isFinite(daysToPrint)
      ? (daysToPrint === 0 ? "today" : `${daysToPrint}d out`)
      : null,
    movePct > 0 ? `implied move ±${round(movePct, 1)}%` : "implied move unavailable",
  ].filter(Boolean);

  const crush = buildCrushBlock({
    side: dir,
    spot: px,
    strike,
    entryPremium,
    dte: num(expiration?.dte),
    daysToPrint,
    ivFrontPct: num(impliedMove?.iv_atm_pct),
    ivBackPct,
    atrPct,
    impliedMovePct: movePct,
    coversPrint: covers,
    reportDate,
    session: event?.hour,
    cal,
  });

  return {
    ticker: sym,
    side: dir,
    report_date: reportDate,
    report_date_label: dateLabel,
    report_session: session,
    days_to_print: Number.isFinite(daysToPrint) ? daysToPrint : null,
    covers_print: covers,
    implied_move_pct: movePct,
    implied_move_usd: moveUsd,
    implied_move_basis: impliedMove?.basis || null,
    iv_atm_pct: num(impliedMove?.iv_atm_pct),
    expected_range: expectedRange,
    target,
    catalyst: catalystBits.join(" · "),
    alignment,
    crush,
    crush_note: crush.note,
    as_of_ms: now,
  };
}

/* ── Enrichment (I/O) ────────────────────────────────────────────────── */

async function loadFundamentalsSnapshot(env, sym) {
  try {
    const raw = await env?.KV_TIMED?.get(`timed:fundamentals_v7:${sym}`);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Attach `earnings_play` to the earnings-prep lotto cards in `cards`.
 * Bounded to `maxCards` so the convexity scan never fans out into a chain
 * fetch per universe name. Mutates and returns the same array.
 *
 * @param opts.eventBySym  { SYM: { date, hour, days_to_print } }
 * @param opts.fetchChain  (env, sym, expIso, opts) => chain — injected so
 *                         tests never touch the vendor.
 */
export async function enrichEarningsPlayCards(env, cards, opts = {}) {
  const list = Array.isArray(cards) ? cards : [];
  const targets = list
    .filter((c) => c && c.earnings_prep && c.ticker)
    .slice(0, Number(opts.maxCards) || EARNINGS_PLAY_MAX_CARDS);
  if (targets.length === 0) return list;

  const eventBySym = opts.eventBySym || {};
  const syms = targets.map((c) => String(c.ticker).toUpperCase());

  let socialBySym = {};
  try {
    const SocialTracker = await import("./discovery/social-tracker.js");
    socialBySym = await SocialTracker.loadSocialSummariesBatch(env, syms, { lookbackDays: 3 }) || {};
  } catch (_) { /* social is a pillar, not a gate */ }

  let FSD = null;
  try { FSD = await import("./cro/fsd-ingestion.js"); } catch (_) { /* optional */ }

  await Promise.all(targets.map(async (card) => {
    const sym = String(card.ticker).toUpperCase();
    const event = eventBySym[sym];
    if (!event?.date) return;
    try {
      const expIso = String(card.expiration?.iso || "").slice(0, 10);
      const spotPre = num(opts.spotBySym?.[sym]);
      const strikeRangePct = chainStrikeRangeForPlay(spotPre, card.strike, 0.08);
      const [fundamentals, fsd, chain] = await Promise.all([
        loadFundamentalsSnapshot(env, sym),
        FSD?.loadFSDIntelForTicker
          ? FSD.loadFSDIntelForTicker(env, sym, { limit: 4, lookbackDays: 14, includeText: false }).catch(() => null)
          : Promise.resolve(null),
        (typeof opts.fetchChain === "function" && expIso)
          ? opts.fetchChain(env, sym, expIso, {
            strikeRangePct,
            skipOI: true,
            playStrike: card.strike,
          }).catch(() => null)
          : Promise.resolve(null),
      ]);
      const spot = num(opts.spotBySym?.[sym]) ?? num(chain?.underlying_price);
      if (chain?.ok) {
        overlayConvexityCardPremium(card, chain, {
          spot,
          atrPct: opts.atrPctBySym?.[sym],
          lottoMaxLossUsd: opts.lottoMaxLossUsd,
        });
      }
      const impliedMove = chain?.ok
        ? resolveImpliedMove({ chain, spot, days: num(card.expiration?.dte) })
        : null;
      // Term structure: the next expiration's ATM IV is what the front
      // month collapses toward once the print is out. Only worth two more
      // vendor calls when the front expiry actually quoted an IV.
      let ivBackPct = null;
      if (chain?.ok && num(impliedMove?.iv_atm_pct) > 0
          && typeof opts.fetchExpirations === "function") {
        try {
          const expRes = await opts.fetchExpirations(env, sym);
          const backIso = pickBackExpiration(expRes?.expirations, expIso);
          if (backIso && typeof opts.fetchChain === "function") {
            const backChain = await opts.fetchChain(env, sym, backIso, {
              strikeRangePct: 0.05,
              skipOI: true,
            });
            if (backChain?.ok) ivBackPct = atmIvFromChain({ chain: backChain, spot });
          }
        } catch (_) { /* term structure is a bonus, not a gate */ }
      }
      const block = buildEarningsPlay({
        ticker: sym,
        side: card.direction,
        spot,
        event,
        expiration: card.expiration,
        impliedMove,
        confluence: opts.confluenceBySym?.[sym] || null,
        fundamentals,
        social: socialBySym[sym] || null,
        fsd,
        multiBaggerTargets: card.multi_bagger_targets,
        strike: card.strike,
        entryPremium: card.premium_mid,
        ivBackPct,
        atrPct: opts.atrPctBySym?.[sym],
        cal: opts.cal || null,
        now: opts.now || Date.now(),
      });
      if (block) {
        card.earnings_play = block;
        if (card.h4_close_pending) {
          card.shot_reason = "4H still open — SuperTrend flip or hold confirms after the 1:30 PM ET close.";
        } else if (block.catalyst) {
          card.shot_reason = block.catalyst;
        }
      }
    } catch (e) {
      console.warn(`[EARNINGS PLAY] ${sym} enrich failed:`, String(e?.message || e).slice(0, 120));
    }
  }));

  return list;
}
