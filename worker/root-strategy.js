// worker/root-strategy.js
//
// ─────────────────────────────────────────────────────────────────────────────
//  TT Root Strategy — 8-Layer Confluence Scorer
// ─────────────────────────────────────────────────────────────────────────────
//
//  The unified decision module that synthesizes every TT influence into a
//  single per-ticker confluence verdict.
//
//  Influence map (codified from the user's articulated vision):
//
//    L1  Tom Lee (Fundstrat)            → macro/sector regime
//    L2  Mark Newton                    → RS + cross-asset + Elliott Wave +
//                                          Ichimoku Cloud
//    L3  Markov + Random Walk           → statistical baseline probability
//    L4  Michael Huddleston (ICT)       → FVG, Order Blocks, BSL/SSL, PD array
//                                          ("market wants balance — ride imbalance")
//    L5  John Carter                    → TTM Squeeze release, first pullback,
//                                          200-SMA gate, 10 AM rule
//    L6  Tom DeMark (TD Sequential)     → setup/countdown counts, wave maturity
//    L7  Ripster + SuperTrend           → EMA cloud state, trend slope
//    L8  Saty Mahajan                   → ATR fib levels, Day Gate
//
//  Output: a `confluence` object that callers can use to decide:
//
//    • RIDE mode  (≥6 of 8 layers aligned bullish or bearish)
//        → options engine prefers Long Call/Put (max convexity)
//        → kanban allows Pyramid (add to winners)
//        → brief frames as "high-confidence directional setup"
//
//    • FADE mode  (price extended + ICT imbalance corrective signal + RS divergence)
//        → options engine prefers Credit Spread / Iron Condor (sell premium)
//        → kanban moves to Trim or Defend
//        → brief frames as "extended — sell the rip / buy the dip on weakness"
//
//    • WAIT mode  (mixed signals, <4 layers aligned)
//        → no trade signal; kanban stays in Setup/Watch
//        → options engine shows wait-and-see with educational alternatives
//
//  Public API:
//    scoreRootConfluence(tickerData) → { score, side, mode, layers, ride, fade, wait }
//
//  This module is READ-ONLY against existing scoring artifacts — never
//  mutates input. All fields it reads are already populated by the live
//  scoring cron (computeIchimoku, detectEWImpulse, td9Aligned*, ripster
//  clouds, smc_levels, etc.).
//
//  Authored 2026-05-30 — fuses the work of Lee, Newton, Huddleston, Carter,
//  DeMark, Ripster, Saty, and our own Markov/data-science layer.

import { STRATEGY_VINTAGE } from "./strategy-context.js";

// ── Mode thresholds ────────────────────────────────────────────────────────
// 8 layers identify the opportunity; SuperTrend slope ignites the trigger.
//   confluence ≥6 + ST slope confirms direction          → RIDE
//   confluence ≥6 + ST flat/not yet sloping in direction → READY (wait)
//   confluence ≥4 + ST slope already in motion           → DRIFT (in-motion late entry)
//   confluence ≥4 + ST opposes                           → FADE candidate
//   confluence <4                                        → WAIT
const RIDE_MIN_LAYERS = 6;
const FADE_MIN_LAYERS = 4;

// ── Layer scorers ──────────────────────────────────────────────────────────
// Each returns { side: "LONG"|"SHORT"|"NEUTRAL", strength: 0..1, evidence: str }
// `strength` lets a partial signal contribute less than a full one.

function scoreL1_Macro(t) {
  // From strategy-context, baked into ticker via __strategy_stance (if set
  // by the live scoring cron) OR we re-derive from sector tilt.
  const ss = t?._strategy_stance || t?.strategy_stance || null;
  if (ss && ss.stance) {
    if (ss.stance === "overweight") return { side: "LONG", strength: Math.min(1, ((ss.multiplier || 1) - 1) * 4), evidence: `Macro OW (${ss.tier || ss.reason || "tier"})` };
    if (ss.stance === "underweight") return { side: "SHORT", strength: Math.min(1, (1 - (ss.multiplier || 1)) * 5), evidence: `Macro UW (${ss.reason || "off-thesis"})` };
  }
  // Fallback: not on the playbook radar.
  return { side: "NEUTRAL", strength: 0, evidence: "Macro neutral" };
}

function scoreL2_Newton(t) {
  // Three sub-signals: RS, Elliott Wave, Ichimoku.
  let bull = 0, bear = 0, parts = [];

  // RS rank vs SPY
  const rsRank = Number(t?.investor?.rsRank ?? t?.rs?.rsRank ?? t?._rs_rank);
  if (Number.isFinite(rsRank)) {
    if (rsRank >= 70) { bull += 1; parts.push(`RS top-${100 - Math.round(rsRank)}%`); }
    else if (rsRank <= 30) { bear += 1; parts.push(`RS bottom-${Math.round(rsRank)}%`); }
  }

  // Elliott Wave (detected on HTF)
  const ewD = t?.tf_tech?.D?.ew || t?.ew_daily || t?._ew_daily || null;
  const ewW = t?.tf_tech?.W?.ew || t?.ew_weekly || null;
  for (const [tfLbl, ew] of [["D", ewD], ["W", ewW]]) {
    if (!ew || ew.detected === false) continue;
    if (ew.dir === 1) { bull += 0.6; parts.push(`EW${tfLbl} W3-ready bull (fib ${ew.fiboMatch})`); }
    else if (ew.dir === -1) { bear += 0.6; parts.push(`EW${tfLbl} W3-ready bear (fib ${ew.fiboMatch})`); }
  }

  // Ichimoku — prefer daily
  const ichi = t?.tf_tech?.D?.ichimoku || t?.ichimoku_daily || t?._ichimoku_daily || null;
  if (ichi) {
    const px = Number(t?.price || ichi.price);
    const cloudTop = Math.max(Number(ichi.senkouA) || 0, Number(ichi.senkouB) || 0);
    const cloudBot = Math.min(Number(ichi.senkouA) || Infinity, Number(ichi.senkouB) || Infinity);
    const tkBull = Number(ichi.tenkan) > Number(ichi.kijun);
    const cloudBull = ichi.senkouA > ichi.senkouB;
    if (px > cloudTop && tkBull && cloudBull) { bull += 0.8; parts.push("Ichi: above bull cloud + TK bull"); }
    else if (px < cloudBot && !tkBull && !cloudBull) { bear += 0.8; parts.push("Ichi: below bear cloud + TK bear"); }
    else if (px > cloudTop) { bull += 0.4; parts.push("Ichi: above cloud"); }
    else if (px < cloudBot) { bear += 0.4; parts.push("Ichi: below cloud"); }
  }

  const net = bull - bear;
  const strength = Math.min(1, (bull + bear) / 2.4); // max possible ~2.4
  if (net > 0.5) return { side: "LONG", strength, evidence: parts.join(", ") || "Newton bull mix" };
  if (net < -0.5) return { side: "SHORT", strength, evidence: parts.join(", ") || "Newton bear mix" };
  return { side: "NEUTRAL", strength: strength * 0.3, evidence: parts.join(", ") || "Newton mixed" };
}

function scoreL3_Statistical(t) {
  // Markov regime forecast + simple random-walk baseline.
  const f = t?.regime_forecast || null;
  if (!f) return { side: "NEUTRAL", strength: 0, evidence: "no_forecast" };
  // Sum bullish vs bearish probability over the 1-day horizon.
  const p1d = f.p_1d || {};
  const bull = (Number(p1d.HTF_BULL_LTF_BULL) || 0) + (Number(p1d.HTF_BULL_LTF_PULLBACK) || 0);
  const bear = (Number(p1d.HTF_BEAR_LTF_BEAR) || 0) + (Number(p1d.HTF_BEAR_LTF_PULLBACK) || 0);
  // Compare against random-walk baseline (50/50). Strength = distance from 0.5.
  const net = bull - bear;
  const strength = Math.min(1, Math.abs(net) * 2);
  if (net > 0.15) return { side: "LONG", strength, evidence: `Markov 1d bull ${(bull * 100).toFixed(0)}%` };
  if (net < -0.15) return { side: "SHORT", strength, evidence: `Markov 1d bear ${(bear * 100).toFixed(0)}%` };
  return { side: "NEUTRAL", strength: 0.2, evidence: `Markov 1d coin-flip (bull ${(bull * 100).toFixed(0)}%)` };
}

function scoreL4_ICT(t) {
  // Huddleston / Inner Circle Trader — structural levels say where price wants
  // to go. We synthesize: FVG presence + direction, liquidity sweep + reclaim,
  // PD array (premium vs discount of range).
  const px = Number(t?.price || 0);
  if (!px) return { side: "NEUTRAL", strength: 0, evidence: "no_price" };

  let bull = 0, bear = 0, parts = [];

  // FVG (Fair Value Gap) — bullish FVG below price = support, supports longs.
  // Look at multiple TFs (4H, D, W) — give more weight to HTF.
  const tfFvgs = [
    ["4H", t?.tf_tech?.["240"]?.fvgs || t?.smc?.fvgs_4h, 0.5],
    ["D",  t?.tf_tech?.D?.fvgs       || t?.smc?.fvgs_d,  0.8],
    ["W",  t?.tf_tech?.W?.fvgs       || t?.smc?.fvgs_w,  1.0],
  ];
  for (const [tf, fvgList, w] of tfFvgs) {
    if (!Array.isArray(fvgList) || fvgList.length === 0) continue;
    const unfilled = fvgList.filter(f => f?.filled === false || f?.status === "unfilled");
    const bullFvg = unfilled.find(f => (f?.type === "bullish" || f?.dir === 1) && f?.top != null && f.top < px);
    const bearFvg = unfilled.find(f => (f?.type === "bearish" || f?.dir === -1) && f?.bottom != null && f.bottom > px);
    if (bullFvg) { bull += w; parts.push(`${tf} bull FVG support`); }
    if (bearFvg) { bear += w; parts.push(`${tf} bear FVG resist`); }
  }

  // Liquidity sweep + reclaim. We already detect this elsewhere; surface it.
  const ls = t?._liqSweepFlag || t?.liq_sweep_flag || null;
  if (ls === "ssl_swept_bull_reclaim" || ls === "liq_into_ssl_reclaim") {
    bull += 0.8; parts.push("SSL swept + reclaim");
  } else if (ls === "bsl_swept_bear_reject" || ls === "liq_into_bsl_reject") {
    bear += 0.8; parts.push("BSL swept + reject");
  }

  // PD Array — where are we in the recent range?
  const dayHi = Number(t?.day_high || t?.session_high);
  const dayLo = Number(t?.day_low  || t?.session_low);
  if (dayHi > 0 && dayLo > 0 && dayHi > dayLo) {
    const mid = (dayHi + dayLo) / 2;
    const inDiscount = px < mid;
    const inPremium  = px > mid;
    // ICT: in discount = look long; in premium = look short.
    if (inDiscount) { bull += 0.3; parts.push("PD: discount"); }
    if (inPremium)  { bear += 0.3; parts.push("PD: premium"); }
  }

  const net = bull - bear;
  const total = bull + bear;
  const strength = Math.min(1, total / 3);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: strength * 0.4, evidence: parts.join(", ") || "ICT balanced" };
}

function scoreL5_Carter(t) {
  // John Carter — synthesized intraday/swing triggers:
  //   • TTM Squeeze release (highest-conviction timing trigger)
  //   • 200-SMA "hold the line" gate
  //   • First pullback to 8/21 EMA after breakout
  //   • ORB bias (Opening Range Breakout, 5/15/30/60-min windows)
  //
  // Planned additions (need data feeds):
  //   • TICK ($TICK NYSE breadth) — needs market-internals feed
  //   • Premarket high/low                                ┐ needs intraday
  //   • Gap-and-go / Bart Simpson pattern recognition     │ scanner module
  //   • Volume Profile (POC, VAH, VAL)                    ┘
  let bull = 0, bear = 0, parts = [];

  // 200-SMA gate (Carter's "hold the line" rule).
  const px = Number(t?.price || 0);
  const sma200 = Number(t?.tf_tech?.D?.sma200 || t?.sma200_daily || t?._sma200);
  if (Number.isFinite(sma200) && sma200 > 0 && px > 0) {
    if (px > sma200) { bull += 0.4; parts.push("Above 200SMA"); }
    else if (px < sma200) { bear += 0.4; parts.push("Below 200SMA"); }
  }

  // TTM Squeeze release on D or 4H (highest-conviction Carter trigger).
  // Sign the direction with the squeeze's momentum oscillator if present.
  const tfList = ["D", "240", "60"];
  let releasedTf = null, releaseMo = 0;
  for (const tf of tfList) {
    const sq = t?.tf_tech?.[tf]?.sq;
    if (!sq) continue;
    if (sq.r === true) {
      releasedTf = tf;
      releaseMo = Number(sq.mo ?? sq.momentum ?? 0);
      break;
    }
  }
  if (releasedTf) {
    if (releaseMo > 0) { bull += 0.7; parts.push(`Squeeze RLS ${releasedTf} (mo+)`); }
    else if (releaseMo < 0) { bear += 0.7; parts.push(`Squeeze RLS ${releasedTf} (mo−)`); }
    else { parts.push(`Squeeze RLS ${releasedTf}`); }
  }

  // First-pullback heuristic: did we close above the 5-day high in the last
  // 3 bars AND now we're pulled back to the 8 or 21 EMA?
  const ema8  = Number(t?.tf_tech?.D?.ema8  || t?._ema8);
  const ema21 = Number(t?.tf_tech?.D?.ema21 || t?._ema21);
  const recentHi5 = Number(t?.high_5d || t?._high_5d);
  if (px > 0 && ema8 > 0 && ema21 > 0 && recentHi5 > 0 && px <= recentHi5 * 1.005 && px >= ema21 * 0.99 && px <= ema8 * 1.01) {
    bull += 0.5; parts.push("First-pullback to 8/21 EMA after breakout");
  }

  // ORB — Opening Range Breakout (5/15/30/60-min windows). Carter trades
  // the ORB direction once 2+ windows agree. Reclaim of the OR after a
  // failed breakout in the opposite direction is a powerful reversal.
  const orb = t?.orb || t?._orb || t?.intraday?.orb;
  if (orb && orb.resolvedCount > 0) {
    const orbBias = Number(orb.orbBias) || 0;
    if (orbBias > 0) {
      const w = Math.min(0.7, 0.3 + (Number(orb.longBreakouts) || 1) * 0.15);
      bull += w;
      parts.push(`ORB bull (${orb.longBreakouts}/${orb.resolvedCount} windows)`);
    } else if (orbBias < 0) {
      const w = Math.min(0.7, 0.3 + (Number(orb.shortBreakouts) || 1) * 0.15);
      bear += w;
      parts.push(`ORB bear (${orb.shortBreakouts}/${orb.resolvedCount} windows)`);
    }
    if (Number(orb.reclaimCount) >= 2) {
      // Reclaim = strong reversal signal. Side determined by current orbBias.
      if (orbBias > 0) { bull += 0.3; parts.push(`ORB reclaim → bull (${orb.reclaimCount})`); }
      else if (orbBias < 0) { bear += 0.3; parts.push(`ORB reclaim → bear (${orb.reclaimCount})`); }
    }
  }

  const net = bull - bear;
  const total = bull + bear;
  const strength = Math.min(1, total / 2.3);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: strength * 0.4, evidence: parts.join(", ") || "Carter neutral" };
}

function scoreL6_DeMark(t) {
  // TD Sequential — wave maturity. Mid-wave (count 3-7) = ride; perfected
  // 9/13 = exhaustion (counter-trade or exit).
  const tdSeq = t?.td_seq || t?._td_seq;
  if (!tdSeq?.per_tf) return { side: "NEUTRAL", strength: 0, evidence: "no_td" };
  let bull = 0, bear = 0, parts = [];
  for (const tf of ["D", "240"]) {
    const row = tdSeq.per_tf[tf];
    if (!row) continue;
    const buyCount = Number(row.buy_setup || row.buyCount || 0);
    const sellCount = Number(row.sell_setup || row.sellCount || 0);
    // Active setup in mid-range = continuation. Perfected 9/13 = exhaustion.
    if (buyCount >= 3 && buyCount <= 7) { bull += 0.4; parts.push(`TD${tf} buy ${buyCount}/9`); }
    else if (buyCount === 9) { bear += 0.3; parts.push(`TD${tf} buy PERFECT 9 (exhaustion)`); }
    if (sellCount >= 3 && sellCount <= 7) { bear += 0.4; parts.push(`TD${tf} sell ${sellCount}/9`); }
    else if (sellCount === 9) { bull += 0.3; parts.push(`TD${tf} sell PERFECT 9 (exhaustion)`); }
  }
  const net = bull - bear;
  const total = bull + bear;
  const strength = Math.min(1, total / 1.0);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: 0, evidence: parts.join(", ") || "TD neutral" };
}

function scoreL7_Trend(t) {
  // Ripster cloud + SuperTrend structure health (sustainability of move).
  let bull = 0, bear = 0, parts = [];

  // Ripster c72/89 cloud — daily.
  const rip = t?.ripster?.c72_89 || t?.tf_tech?.D?.ripster?.c72_89;
  if (rip) {
    if (rip.above) { bull += 0.5; parts.push("Ripster above"); }
    else if (rip.below) { bear += 0.5; parts.push("Ripster below"); }
  }

  // SuperTrend daily + slope.
  const stD = t?.tf_tech?.D?.supertrend || t?.supertrend_daily;
  if (stD) {
    const dir = String(stD.dir || stD.direction || "").toUpperCase();
    const slope = Number(stD.slope || 0);
    if (dir === "BULL" || dir === "LONG") { bull += 0.5 + Math.min(0.3, Math.max(0, slope)); parts.push(`ST bull (slope ${slope.toFixed(2)})`); }
    else if (dir === "BEAR" || dir === "SHORT") { bear += 0.5 + Math.min(0.3, Math.max(0, -slope)); parts.push(`ST bear (slope ${slope.toFixed(2)})`); }
  }

  // EMA spacing — widening = strong trend, tightening = exhaustion.
  const emaSpread = Number(t?.tf_tech?.D?.ema_spread || t?._ema_spread);
  if (Number.isFinite(emaSpread) && Math.abs(emaSpread) > 0.005) {
    if (emaSpread > 0) { bull += 0.2; parts.push("EMA spacing widening up"); }
    else { bear += 0.2; parts.push("EMA spacing widening down"); }
  }

  const net = bull - bear;
  const total = bull + bear;
  const strength = Math.min(1, total / 1.5);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: strength * 0.3, evidence: parts.join(", ") || "Trend mixed" };
}

function scoreL8_Saty(t) {
  // ATR fib day-gate — execution-level signal. Above mid + room to +38.2 = bull
  // execution lane open; below mid + room to -38.2 = bear lane open.
  const af = t?.atr_levels || t?.atrFibLevels;
  if (!af) return { side: "NEUTRAL", strength: 0, evidence: "no_atr_fib" };
  const px = Number(t?.price || 0);
  const mid = Number(af.anchor);
  const up = Number(af.levels?.["+38.2%"] || af["+38.2"]);
  const dn = Number(af.levels?.["-38.2%"] || af["-38.2"]);
  if (!px || !mid) return { side: "NEUTRAL", strength: 0, evidence: "no_anchor" };
  let bull = 0, bear = 0, parts = [];
  if (px > mid) { bull += 0.4; parts.push("Above pivot"); }
  else if (px < mid) { bear += 0.4; parts.push("Below pivot"); }
  if (Number.isFinite(up) && px < up * 0.997) { bull += 0.3; parts.push(`Room to +38.2 @ ${up.toFixed(2)}`); }
  if (Number.isFinite(dn) && px > dn * 1.003) { bear += 0.3; parts.push(`Room to −38.2 @ ${dn.toFixed(2)}`); }
  const net = bull - bear;
  const strength = Math.min(1, (bull + bear) / 1.0);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: strength * 0.4, evidence: parts.join(", ") || "Saty neutral" };
}

// ── SuperTrend(10,3) Trigger Gate ────────────────────────────────────────
//
// The user's empirical insight: "I have never seen an adverse action when the
// ST line is sloping. It's a good trigger for entry open."
//
// SuperTrend is treated as the ignition switch, not a vote. We look at it on
// multiple TFs and report:
//   • direction:           BULL (line below price as support) / BEAR (line above as resistance)
//   • sloping:             is the ST line itself moving in its direction (rising in BULL,
//                          falling in BEAR)? Flat ST = no fuel even if BULL.
//   • slope_just_started:  did the slope turn from flat to active in the last N bars?
//                          This is the highest-edge entry (fresh ignition).
//   • timeframe_confirmed: which TFs report sloping in the same direction.
//
// We score 5m/15m/30m as intraday (for tactical entries) and 60m/4h/D as swing
// (for the options-ladder selector). A sloping daily ST is the strongest
// confirmation; a flat daily ST + sloping 60m = entering early into a swing.

const ST_TFS_INTRADAY = ["5", "15", "30"];
const ST_TFS_SWING    = ["60", "240", "D"];

function _readSuperTrend(t, tf) {
  // Multiple field shapes — be defensive.
  const tfRow = t?.tf_tech?.[tf];
  return tfRow?.supertrend
      || tfRow?.st
      || t?.supertrend_by_tf?.[tf]
      || null;
}

function _stSloping(st) {
  if (!st) return { sloping: false, slope_dir: 0, slope_age_bars: null };
  // Direct field if available (preferred).
  if (Number.isFinite(Number(st.slope))) {
    const s = Number(st.slope);
    const dir = String(st.dir || st.direction || "").toUpperCase();
    if (Math.abs(s) < 0.0005) return { sloping: false, slope_dir: 0, slope_age_bars: null };
    const sign = s > 0 ? 1 : -1;
    return {
      sloping: true,
      slope_dir: sign,
      slope_age_bars: Number(st.slope_age_bars) || Number(st.flip_age_bars) || null,
      st_dir: dir,
    };
  }
  // Fallback — derive from a series of recent values if present.
  const series = Array.isArray(st.series) ? st.series : (Array.isArray(st.values) ? st.values : null);
  if (series && series.length >= 3) {
    const last = Number(series[series.length - 1]);
    const prev = Number(series[series.length - 2]);
    const prev2 = Number(series[series.length - 3]);
    if ([last, prev, prev2].every(Number.isFinite)) {
      const slope = last - prev2;
      const sign = slope > 0 ? 1 : slope < 0 ? -1 : 0;
      if (sign === 0) return { sloping: false, slope_dir: 0, slope_age_bars: null };
      return { sloping: true, slope_dir: sign, slope_age_bars: null };
    }
  }
  // Last fallback — if we know direction but not slope, assume sloping (most
  // ST implementations only flip when direction changes, so a held direction
  // for several bars implies the line is moving with the trend).
  const dir = String(st.dir || st.direction || "").toUpperCase();
  if (dir === "BULL" || dir === "LONG")  return { sloping: true, slope_dir: 1,  slope_age_bars: null, st_dir: dir };
  if (dir === "BEAR" || dir === "SHORT") return { sloping: true, slope_dir: -1, slope_age_bars: null, st_dir: dir };
  return { sloping: false, slope_dir: 0, slope_age_bars: null };
}

/**
 * Compute the SuperTrend trigger gate across timeframes.
 * Returns the highest-conviction TF state per direction.
 */
function computeSupertrendTrigger(t) {
  const intraday = {};
  const swing = {};
  let anyBullSloping = false, anyBearSloping = false;
  let freshBullTf = null, freshBearTf = null;
  let confirmedBullTfs = [], confirmedBearTfs = [];

  const inspect = (tf, bucket) => {
    const st = _readSuperTrend(t, tf);
    if (!st) return;
    const s = _stSloping(st);
    bucket[tf] = {
      st_dir: s.st_dir || null,
      sloping: s.sloping,
      slope_dir: s.slope_dir,
      slope_age_bars: s.slope_age_bars,
    };
    if (!s.sloping) return;
    if (s.slope_dir > 0) {
      anyBullSloping = true;
      confirmedBullTfs.push(tf);
      const age = Number(s.slope_age_bars);
      if (Number.isFinite(age) && age <= 3) freshBullTf = freshBullTf || tf;
    } else if (s.slope_dir < 0) {
      anyBearSloping = true;
      confirmedBearTfs.push(tf);
      const age = Number(s.slope_age_bars);
      if (Number.isFinite(age) && age <= 3) freshBearTf = freshBearTf || tf;
    }
  };

  for (const tf of ST_TFS_INTRADAY) inspect(tf, intraday);
  for (const tf of ST_TFS_SWING)    inspect(tf, swing);

  // Trigger strength: SWING-TF slope > INTRADAY-TF slope.
  const swingBullCount = confirmedBullTfs.filter(tf => ST_TFS_SWING.includes(tf)).length;
  const swingBearCount = confirmedBearTfs.filter(tf => ST_TFS_SWING.includes(tf)).length;
  const intradayBullCount = confirmedBullTfs.filter(tf => ST_TFS_INTRADAY.includes(tf)).length;
  const intradayBearCount = confirmedBearTfs.filter(tf => ST_TFS_INTRADAY.includes(tf)).length;

  let triggerSide = "NEUTRAL";
  let triggerStrength = 0;
  let freshness = "none";
  if (swingBullCount > swingBearCount && swingBullCount > 0) {
    triggerSide = "LONG";
    triggerStrength = Math.min(1, swingBullCount / 2 + intradayBullCount / 6);
    freshness = freshBullTf ? "fresh" : (swingBullCount >= 2 ? "mature" : "in_motion");
  } else if (swingBearCount > swingBullCount && swingBearCount > 0) {
    triggerSide = "SHORT";
    triggerStrength = Math.min(1, swingBearCount / 2 + intradayBearCount / 6);
    freshness = freshBearTf ? "fresh" : (swingBearCount >= 2 ? "mature" : "in_motion");
  } else if (intradayBullCount > 0 || intradayBearCount > 0) {
    triggerSide = intradayBullCount >= intradayBearCount ? "LONG" : "SHORT";
    triggerStrength = 0.3;
    freshness = "intraday_only";
  }

  return {
    side: triggerSide,
    strength: Math.round(triggerStrength * 100) / 100,
    freshness,
    triggered: triggerSide !== "NEUTRAL",
    confirmed_tfs: triggerSide === "LONG" ? confirmedBullTfs : (triggerSide === "SHORT" ? confirmedBearTfs : []),
    fresh_tf: triggerSide === "LONG" ? freshBullTf : (triggerSide === "SHORT" ? freshBearTf : null),
    intraday, swing,
  };
}

// ── Public: compute the full 8-layer confluence ──────────────────────────
/**
 * Compute the root strategy confluence for a single ticker snapshot.
 *
 * 8 layers identify the OPPORTUNITY; SuperTrend slope ignites the TRIGGER.
 *   High confluence + ST slope confirms direction          → RIDE
 *   High confluence + ST flat / not yet sloping            → READY (entry pending)
 *   Medium confluence + ST slope in motion                 → DRIFT (late but in motion)
 *   Medium confluence + ST opposes                         → FADE candidate
 *   Low confluence                                         → WAIT
 *
 * @param {object} t — ticker prediction snapshot (from loadLatestPredictionTicker)
 */
export function scoreRootConfluence(t) {
  if (!t || typeof t !== "object") return null;

  const layers = {
    L1_macro:     scoreL1_Macro(t),
    L2_newton:    scoreL2_Newton(t),
    L3_markov:    scoreL3_Statistical(t),
    L4_ict:       scoreL4_ICT(t),
    L5_carter:    scoreL5_Carter(t),
    L6_demark:    scoreL6_DeMark(t),
    L7_trend:     scoreL7_Trend(t),
    L8_saty:      scoreL8_Saty(t),
  };

  // Count agreeing layers (side & strength > 0.2 threshold).
  let longAgree = 0, shortAgree = 0;
  let longStrength = 0, shortStrength = 0;
  for (const k of Object.keys(layers)) {
    const l = layers[k];
    if (l.side === "LONG" && l.strength > 0.2) { longAgree++; longStrength += l.strength; }
    else if (l.side === "SHORT" && l.strength > 0.2) { shortAgree++; shortStrength += l.strength; }
  }

  const total = 8;
  const dominantSide = longStrength > shortStrength ? "LONG" : shortStrength > longStrength ? "SHORT" : "NEUTRAL";
  const dominantCount = dominantSide === "LONG" ? longAgree : dominantSide === "SHORT" ? shortAgree : 0;
  const score = Math.round((Math.max(longStrength, shortStrength) / total) * 100);

  // ── SuperTrend trigger gate ─────────────────────────────────────────────
  // Per the operator's empirical insight: "I have never seen an adverse
  // action when the ST line is sloping." So ST slope is the ignition
  // switch, not a vote.
  const stTrigger = computeSupertrendTrigger(t);

  // ── Mode resolution (with ST gating) ────────────────────────────────────
  let mode = "WAIT";
  let side = "NEUTRAL";
  let ride = false, ready = false, drift = false, fade = false, wait = true;

  // Helper: does the ST trigger agree with the confluence dominant side?
  const stAgrees = stTrigger.triggered && stTrigger.side === dominantSide;
  const stOpposes = stTrigger.triggered && stTrigger.side !== "NEUTRAL" && stTrigger.side !== dominantSide;

  if (dominantCount >= RIDE_MIN_LAYERS) {
    side = dominantSide;
    if (stAgrees) {
      // ✅ Highest conviction — confluence + ST slope agree.
      mode = "RIDE";
      ride = true; wait = false;
    } else if (stTrigger.side === "NEUTRAL") {
      // Confluence is there but ST hasn't ignited. Wait for the slope.
      mode = "READY";
      ready = true; wait = false;
    } else {
      // ST opposes — likely a fade setup. Confluence is wrong direction
      // OR this is mid-pullback within a larger trend.
      mode = "FADE";
      side = stTrigger.side;
      fade = true; wait = false;
    }
  } else if (dominantCount >= FADE_MIN_LAYERS) {
    side = dominantSide;
    if (stAgrees) {
      // Medium confluence + ST already in motion = late but in motion.
      mode = "DRIFT";
      drift = true; wait = false;
    } else if (stOpposes) {
      const newtonSide = layers.L2_newton.side;
      const opp = dominantSide === "LONG" ? "SHORT" : "LONG";
      if (newtonSide === opp && layers.L2_newton.strength > 0.5) {
        mode = "FADE";
        side = newtonSide;
        fade = true; wait = false;
      }
    }
  }

  const layerSummary = Object.entries(layers).map(([key, l]) => ({
    key,
    side: l.side,
    strength: Math.round(l.strength * 100) / 100,
    evidence: l.evidence,
  }));

  return {
    ok: true,
    ticker: String(t?.ticker || "").toUpperCase() || null,
    price: Number(t?.price) || null,
    generated_at: Date.now(),
    strategy_vintage: STRATEGY_VINTAGE,
    score,
    side,
    mode,
    // Flags for downstream consumers.
    ride, ready, drift, fade, wait,
    // Layer-level tallies.
    layers_agreeing: dominantCount,
    layers_total: total,
    long_agree: longAgree,
    short_agree: shortAgree,
    long_strength: Math.round(longStrength * 100) / 100,
    short_strength: Math.round(shortStrength * 100) / 100,
    layers: layerSummary,
    // SuperTrend trigger gate detail.
    supertrend_trigger: stTrigger,
    // Plain-English summary the UI can render verbatim.
    actionable_summary: _buildActionableSummary({
      mode, side, layers, score, longAgree, shortAgree, stTrigger,
    }),
  };
}

function _buildActionableSummary({ mode, side, layers, score, longAgree, shortAgree, stTrigger }) {
  if (mode === "RIDE") {
    const topLayers = Object.entries(layers)
      .filter(([_, l]) => l.side === side && l.strength > 0.4)
      .sort((a, b) => b[1].strength - a[1].strength)
      .slice(0, 3)
      .map(([k, l]) => `${k.replace(/L\d_/, "")}: ${l.evidence}`);
    const freshness = stTrigger.freshness === "fresh" ? " (ST just sloped — fresh trigger)"
                    : stTrigger.freshness === "in_motion" ? " (ST in motion)"
                    : stTrigger.freshness === "mature" ? " (ST sloping mature)"
                    : "";
    const tfs = (stTrigger.confirmed_tfs || []).join("/");
    return `RIDE ${side} — confluence ${score}/100, ${side === "LONG" ? longAgree : shortAgree}/8 layers agree, ST slope ${tfs}${freshness}. Strongest: ${topLayers.join(" · ")}. Options: prefer long ${side === "LONG" ? "call" : "put"} (max convexity).`;
  }
  if (mode === "READY") {
    return `READY ${side} — confluence ${score}/100 (${side === "LONG" ? longAgree : shortAgree}/8 layers) but SuperTrend slope hasn't ignited yet. ENTRY PENDING — wait for ST(10,3) to start sloping ${side === "LONG" ? "up" : "down"} on D/4H/60m. Options: prepare order; do not chase.`;
  }
  if (mode === "FADE") {
    const fadeSrc = stTrigger.side === side ? "ST opposes confluence" : "Newton (RS/Wave/Ichi) opposes majority";
    return `FADE ${side} — ${fadeSrc}. ${score}/100 confluence on the other side. Likely countertrend; prefer credit spread / iron condor over directional bet.`;
  }
  if (mode === "DRIFT") {
    return `DRIFT ${side} — partial confluence (${score}/100) with ST already in motion. Late entry; defined-risk spread only. Skip long premium (theta will eat it).`;
  }
  return `WAIT — confluence ${score}/100, layers split (${longAgree} long / ${shortAgree} short), no SuperTrend trigger. No directional bet. If IV is rich, iron condor candidate.`;
}
