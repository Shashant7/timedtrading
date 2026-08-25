// worker/earnings-play.js — Earnings play block for the lotto strip (2026-08-25)
//
// The earnings-prep lotto (options-plays.js `shouldActivateEarningsPrepLotto`)
// already decides WHEN a cheap OTM contract into a 1–5 day print is allowed.
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
    Number.isFinite(daysToPrint) ? `${daysToPrint}d out` : null,
    movePct > 0 ? `implied move ±${round(movePct, 1)}%` : "implied move unavailable",
  ].filter(Boolean);

  const crushNote = covers === false
    ? "Contract expires before the print — this trades the run-up, not the event."
    : "IV crush lands the moment the print clears: premium can fall on a correct direction. Size for total premium loss.";

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
    crush_note: crushNote,
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
      const [fundamentals, fsd, chain] = await Promise.all([
        loadFundamentalsSnapshot(env, sym),
        FSD?.loadFSDIntelForTicker
          ? FSD.loadFSDIntelForTicker(env, sym, { limit: 4, lookbackDays: 14, includeText: false }).catch(() => null)
          : Promise.resolve(null),
        (typeof opts.fetchChain === "function" && expIso)
          ? opts.fetchChain(env, sym, expIso, { strikeRangePct: 0.08, skipOI: true }).catch(() => null)
          : Promise.resolve(null),
      ]);
      const spot = num(opts.spotBySym?.[sym]) ?? num(chain?.underlying_price);
      const impliedMove = chain?.ok
        ? resolveImpliedMove({ chain, spot, days: num(card.expiration?.dte) })
        : null;
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
        now: opts.now || Date.now(),
      });
      if (block) card.earnings_play = block;
    } catch (e) {
      console.warn(`[EARNINGS PLAY] ${sym} enrich failed:`, String(e?.message || e).slice(0, 120));
    }
  }));

  return list;
}
