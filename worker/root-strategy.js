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

import { STRATEGY_VINTAGE, getStrategyForTicker } from "./strategy-context.js";
import { getThemesForTicker } from "./sector-mapping.js";

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
  // Tom Lee / FSD playbook layer. Prefers a baked-in __strategy_stance on
  // the ticker (from scoring cron) but falls back to inline computation
  // via getStrategyForTicker — sector + theme tilts + SMID bump.
  let ss = t?._strategy_stance || t?.strategy_stance || null;
  if (!ss) {
    try {
      const sym = String(t?.ticker || "").toUpperCase();
      ss = getStrategyForTicker(sym, {
        sector: t?.sector || t?._sector || null,
        market_cap: Number(t?.market_cap) || null,
      }, getThemesForTicker);
    } catch (_) { /* best-effort */ }
  }
  if (ss && ss.stance) {
    if (ss.stance === "overweight") {
      return { side: "LONG", strength: Math.min(1, ((ss.multiplier || 1) - 1) * 4), evidence: `Macro OW (${ss.tier || ss.reason || "favored"})` };
    }
    if (ss.stance === "underweight") {
      return { side: "SHORT", strength: Math.min(1, (1 - (ss.multiplier || 1)) * 5), evidence: `Macro UW (${ss.reason || "off-thesis"})` };
    }
  }
  return { side: "NEUTRAL", strength: 0, evidence: "Macro neutral" };
}

function scoreL2_Newton(t) {
  // Three sub-signals: RS, Elliott Wave, Ichimoku.
  let bull = 0, bear = 0, parts = [];

  // RS rank vs SPY — production paths.
  const rsRank = Number(
    t?.investor?.rsRank
    ?? t?.investor_rsRank
    ?? t?.rs?.rsRank
    ?? t?._rs_rank
    ?? t?.rs_rank
  );
  if (Number.isFinite(rsRank)) {
    if (rsRank >= 70) { bull += 1; parts.push(`RS top-${100 - Math.round(rsRank)}%`); }
    else if (rsRank <= 30) { bear += 1; parts.push(`RS bottom-${Math.round(rsRank)}%`); }
  }

  // Elliott Wave per-TF, with production paths (tf_tech.D.ew + .W.ew).
  const ewD = t?.tf_tech?.D?.ew || t?.ew_daily || null;
  const ewW = t?.tf_tech?.W?.ew || t?.ew_weekly || null;
  for (const [tfLbl, ew] of [["D", ewD], ["W", ewW]]) {
    if (!ew || ew.detected === false) continue;
    if (ew.dir === 1) { bull += 0.6; parts.push(`EW${tfLbl} W3-ready bull (fib ${ew.fiboMatch})`); }
    else if (ew.dir === -1) { bear += 0.6; parts.push(`EW${tfLbl} W3-ready bear (fib ${ew.fiboMatch})`); }
  }

  // Ichimoku — production paths:
  //   top-level: ichimoku_d (rich object with tkBull, cloudBullish, position)
  //   per-TF:    tf_tech.D.ich
  const ichi = t?.ichimoku_d || t?.tf_tech?.D?.ich || t?.tf_tech?.D?.ichimoku || null;
  if (ichi) {
    // Prefer the pre-computed boolean flags.
    const pos = String(ichi.position || "").toLowerCase();
    const tkBull = ichi.tkBull === true || (ichi.tkCrossUp === true && ichi.tkCrossDn !== true);
    const cloudBull = ichi.cloudBullish === true;
    if (pos === "above" && tkBull && cloudBull) { bull += 0.9; parts.push("Ichi: above bull cloud + TK bull"); }
    else if (pos === "below" && !tkBull && !cloudBull) { bear += 0.9; parts.push("Ichi: below bear cloud + TK bear"); }
    else if (pos === "above") { bull += 0.4; parts.push("Ichi: above cloud"); }
    else if (pos === "below") { bear += 0.4; parts.push("Ichi: below cloud"); }
    // Geometry fallback if position string absent.
    else {
      const px = Number(t?.price || ichi.price);
      const cloudTop = Math.max(Number(ichi.senkouA) || 0, Number(ichi.senkouB) || 0, Number(ichi.cloudTop) || 0);
      const cloudBot = Math.min(Number(ichi.senkouA) || Infinity, Number(ichi.senkouB) || Infinity, Number(ichi.cloudBase) || Infinity);
      if (px > cloudTop && tkBull) { bull += 0.6; parts.push("Ichi: above cloud (geom)"); }
      else if (px < cloudBot && !tkBull) { bear += 0.6; parts.push("Ichi: below cloud (geom)"); }
    }
  }

  const net = bull - bear;
  const strength = Math.min(1, (bull + bear) / 2.5);
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
  // Huddleston / Inner Circle Trader — structural levels say where price
  // wants to go. Reads production fields:
  //   tf_tech.{tf}.fvg              — { activeBull, activeBear, inBullGap,
  //                                     inBearGap, nearestBullDist, nearestBearDist }
  //   top-level fvg_D / fvg_4h / fvg_imbalance_D
  //   tf_tech.{tf}.liq              — liquidity zones
  //   top-level liq_D               — daily liquidity snapshot
  //   tf_tech.{tf}.pdz              — premium/discount zone object
  let bull = 0, bear = 0, parts = [];
  const px = Number(t?.price || 0);
  if (!px) return { side: "NEUTRAL", strength: 0, evidence: "no_price" };

  // FVG — production shape (top-level + per-TF):
  //   fvg_D / fvg_4h: { activeBull, activeBear, inBullGap, inBearGap,
  //                     nearestBullDist, nearestBearDist }
  //   tf_tech.{tf}.fvg: same shape
  // Interpretation:
  //   activeBull > activeBear  → multiple bull FVGs below/around price act as
  //                              cushion → supports longs.
  //   activeBear > activeBull  → multiple bear FVGs overhead → resistance → supports shorts.
  //   inBullGap = price currently inside a bullish FVG (being respected as support).
  //   nearestBullDist < 0     = bull FVG is BELOW price (support distance)
  //   nearestBearDist < 0     = bear FVG is ABOVE price (resistance distance)
  const fvgSrcs = [
    ["W",  t?.tf_tech?.W?.fvg, 1.0],
    ["D",  t?.tf_tech?.D?.fvg  || t?.fvg_D,  1.0],
    ["4H", t?.tf_tech?.["4H"]?.fvg || t?.fvg_4h, 0.6],
    ["1H", t?.tf_tech?.["1H"]?.fvg, 0.4],
  ];
  for (const [tf, fvgObj, weight] of fvgSrcs) {
    if (!fvgObj) continue;
    if (typeof fvgObj === "object" && (fvgObj.activeBull !== undefined || fvgObj.activeBear !== undefined)) {
      const aBull = Number(fvgObj.activeBull) || 0;
      const aBear = Number(fvgObj.activeBear) || 0;
      const inBullGap = fvgObj.inBullGap === true;
      const inBearGap = fvgObj.inBearGap === true;
      // Net imbalance — even a tilt of 2-vs-1 should register.
      const netBull = aBull - aBear;
      if (netBull > 0) {
        // Base credit for each unfilled bull FVG (scaled), bonus if currently in one.
        const credit = weight * (Math.min(1.0, netBull / 4) + (inBullGap ? 0.5 : 0));
        if (credit > 0) {
          bull += credit;
          parts.push(`${tf}: ${aBull}b/${aBear}s FVG${inBullGap ? " (in bull)" : ""}`);
        }
      } else if (netBull < 0) {
        const credit = weight * (Math.min(1.0, -netBull / 4) + (inBearGap ? 0.5 : 0));
        if (credit > 0) {
          bear += credit;
          parts.push(`${tf}: ${aBull}b/${aBear}s FVG${inBearGap ? " (in bear)" : ""}`);
        }
      }
    } else if (Array.isArray(fvgObj)) {
      const unfilled = fvgObj.filter(f => f?.filled === false || f?.status === "unfilled");
      const bullFvg = unfilled.find(f => (f?.type === "bullish" || f?.dir === 1) && f?.top != null && f.top < px);
      const bearFvg = unfilled.find(f => (f?.type === "bearish" || f?.dir === -1) && f?.bottom != null && f.bottom > px);
      if (bullFvg) { bull += weight; parts.push(`${tf} bull FVG support`); }
      if (bearFvg) { bear += weight; parts.push(`${tf} bear FVG resist`); }
    }
  }
  // fvg_imbalance_D — top-level imbalance summary (when present, strong signal).
  const imb = t?.fvg_imbalance_D || t?.tf_tech?.D?.fvg_imbalance;
  if (imb && typeof imb === "object") {
    const side = String(imb.side || imb.direction || "").toLowerCase();
    const mag = Number(imb.magnitude || imb.strength || 0);
    if (side === "bull" || side === "bullish") { bull += 0.5 + Math.min(0.5, mag); parts.push("D imbalance bull"); }
    else if (side === "bear" || side === "bearish") { bear += 0.5 + Math.min(0.5, mag); parts.push("D imbalance bear"); }
  }

  // Liquidity sweep + reclaim. Production: liq_D, tf_tech.{tf}.liq.
  const liqD = t?.tf_tech?.D?.liq || t?.liq_D || null;
  if (liqD && typeof liqD === "object") {
    if (liqD.ssl_reclaim === true || liqD.ssl_swept_and_reclaimed === true) {
      bull += 0.8; parts.push("SSL swept + reclaim");
    } else if (liqD.bsl_reject === true || liqD.bsl_swept_and_rejected === true) {
      bear += 0.8; parts.push("BSL swept + reject");
    }
  }
  // Older flag path as fallback.
  const ls = t?._liqSweepFlag || t?.liq_sweep_flag || null;
  if (ls && parts.length === 0) {
    if (ls === "ssl_swept_bull_reclaim" || ls === "liq_into_ssl_reclaim") {
      bull += 0.8; parts.push("SSL swept + reclaim");
    } else if (ls === "bsl_swept_bear_reject" || ls === "liq_into_bsl_reject") {
      bear += 0.8; parts.push("BSL swept + reject");
    }
  }

  // PD Zone — production: tf_tech.{tf}.pdz with premium/discount classification.
  const pdz = t?.tf_tech?.D?.pdz || t?.pdz || null;
  if (pdz && typeof pdz === "object") {
    const zone = String(pdz.zone || pdz.label || "").toLowerCase();
    if (zone.includes("discount")) { bull += 0.3; parts.push("PD: discount"); }
    else if (zone.includes("premium")) { bear += 0.3; parts.push("PD: premium"); }
  } else {
    // Geometric fallback from day range.
    const dayHi = Number(t?.day_high || t?.session_high || t?.high_24h || t?._live_daily_high);
    const dayLo = Number(t?.day_low  || t?.session_low  || t?.low_24h  || t?._live_daily_low);
    if (dayHi > 0 && dayLo > 0 && dayHi > dayLo) {
      const mid = (dayHi + dayLo) / 2;
      if (px < mid) { bull += 0.3; parts.push("PD: discount"); }
      else if (px > mid) { bear += 0.3; parts.push("PD: premium"); }
    }
  }

  // Volume Profile — POC / VAH / VAL. When ticker carries a `_vp` field
  // (injected by options endpoint or scoring cron), classify price zone.
  // Reinforces the PD array signal with institutional volume context.
  const vp = t?._vp || t?.volume_profile;
  if (vp && Number.isFinite(vp.poc)) {
    const zoneObj = (() => {
      const tol = Math.max(0.005 * px, vp.bin_size * 0.5);
      if (px > vp.vah + tol) return { z: "ABOVE_VAH", side: "BEAR", w: 0.4, ev: `Above VAH \$${vp.vah} (premium)` };
      if (px < vp.val - tol) return { z: "BELOW_VAL", side: "BULL", w: 0.4, ev: `Below VAL \$${vp.val} (discount)` };
      if (Math.abs(px - vp.poc) <= tol) return { z: "AT_POC", side: "NEUTRAL", w: 0.2, ev: `At POC \$${vp.poc} (magnet)` };
      return null;
    })();
    if (zoneObj) {
      if (zoneObj.side === "BULL") { bull += zoneObj.w; parts.push(`VP: ${zoneObj.ev}`); }
      else if (zoneObj.side === "BEAR") { bear += zoneObj.w; parts.push(`VP: ${zoneObj.ev}`); }
    }
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
  const sma200 = Number(t?.tf_tech?.D?.sma200 || t?.tf_tech?.D?.ema?.sma200 || t?.sma200_daily || t?._sma200);
  if (Number.isFinite(sma200) && sma200 > 0 && px > 0) {
    if (px > sma200) { bull += 0.4; parts.push("Above 200SMA"); }
    else if (px < sma200) { bear += 0.4; parts.push("Below 200SMA"); }
  }

  // TTM Squeeze release on D / 4H / 1H. Production shape:
  //   tf_tech.{tf}.sq = { s: 1|0, r: 1|0, c: 1|0 } where r=1 means release.
  // Direction (momentum) read from tf_tech.{tf}.rsi or ema_regime as proxy
  // since momentum oscillator isn't stored directly.
  const tfList = ["D", "4H", "1H"];
  let releasedTf = null, releaseDir = 0;
  for (const tf of tfList) {
    const sq = t?.tf_tech?.[tf]?.sq;
    if (!sq) continue;
    if (sq.r === 1 || sq.r === true) {
      releasedTf = tf;
      // Sign release direction from EMA regime if present (1=bull, -1=bear).
      const regimeKey = tf === "D" ? "ema_regime_daily" : tf === "4H" ? "ema_regime_4h" : "ema_regime_1h";
      const reg = Number(t?.[regimeKey]);
      if (Number.isFinite(reg) && reg !== 0) releaseDir = reg > 0 ? 1 : -1;
      break;
    }
  }
  if (releasedTf) {
    if (releaseDir > 0) { bull += 0.7; parts.push(`Squeeze RLS ${releasedTf} (EMA+)`); }
    else if (releaseDir < 0) { bear += 0.7; parts.push(`Squeeze RLS ${releasedTf} (EMA−)`); }
    else { parts.push(`Squeeze RLS ${releasedTf}`); }
  }

  // First-pullback heuristic: did we close above the 5-day high recently
  // AND now we're pulled back to the 8 or 21 EMA?
  const emaMap = t?.tf_tech?.D?.ema || {};
  const ema8  = Number(emaMap?.ema8  || t?.ema_map?.ema8  || t?._ema8);
  const ema21 = Number(emaMap?.ema21 || t?.ema_map?.ema21 || t?._ema21);
  const recentHi5 = Number(t?.high_5d || t?._high_5d || t?._live_daily_high);
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
      if (orbBias > 0) { bull += 0.3; parts.push(`ORB reclaim → bull (${orb.reclaimCount})`); }
      else if (orbBias < 0) { bear += 0.3; parts.push(`ORB reclaim → bear (${orb.reclaimCount})`); }
    }
  }

  // SMT — Smart Money Technique. Quartet-level divergence at marked HTF
  // levels = institutional manipulation = reversal in progress. We accept
  // SMT context injected via tickerData._index_quartet (populated by the
  // scoring layer when present) and treat Stage 1 as a meaningful bonus,
  // Stage 2 (confirmed) as a heavy weight.
  const quartet = t?._index_quartet || t?.index_quartet;
  const smt = quartet?.smt || quartet?.SMT;
  if (smt && smt.stage1) {
    // Stage 1 alone — meaningful confluence boost in the direction
    // opposite to the swept level (since SMT signals reversal).
    if (smt.direction === "BULL") { bull += 0.5; parts.push(`SMT-S1 ${smt.divergent_index} swept ${smt.level_type}`); }
    else if (smt.direction === "BEAR") { bear += 0.5; parts.push(`SMT-S1 ${smt.divergent_index} swept ${smt.level_type}`); }
  }
  const smtConfirmed = quartet?.smt_confirmed || quartet?.SMT_CONFIRMED;
  if (smtConfirmed?.confirmed) {
    // Stage 1 + Stage 2 — the 81% setup. Heavy weight.
    if (smtConfirmed.direction === "BULL") { bull += 1.0; parts.push(`SMT 2-stage CONFIRMED bull`); }
    else if (smtConfirmed.direction === "BEAR") { bear += 1.0; parts.push(`SMT 2-stage CONFIRMED bear`); }
  }

  const net = bull - bear;
  const total = bull + bear;
  const strength = Math.min(1, total / 2.3);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: strength * 0.4, evidence: parts.join(", ") || "Carter neutral" };
}

function scoreL6_DeMark(t) {
  // TD Sequential — wave maturity. Production shape:
  //   t.td_sequential.per_tf.{tf} = {
  //     td9_bullish, td9_bearish, td13_bullish, td13_bearish,
  //     bullish_prep_count, bearish_prep_count,
  //     tv_count, tv_count_side
  //   }
  // Mid-wave count (3-7) = continuation = ride. tv_count_side identifies
  // dominant direction. Perfected 9 or 13 = exhaustion.
  const tdSeq = t?.td_sequential || t?.td_seq || t?._td_seq;
  const perTf = tdSeq?.per_tf || (tdSeq ? { D: tdSeq } : null);
  if (!perTf) return { side: "NEUTRAL", strength: 0, evidence: "no_td" };
  let bull = 0, bear = 0, parts = [];
  for (const tf of ["D", "4H", "240"]) {
    const row = perTf[tf];
    if (!row) continue;
    const bullPrep = Number(row.bullish_prep_count || row.buy_setup || row.buyCount || 0);
    const bearPrep = Number(row.bearish_prep_count || row.sell_setup || row.sellCount || 0);
    if (row.td9_bullish === true) { bear += 0.3; parts.push(`TD${tf} 9 bull (exhaustion)`); }
    if (row.td9_bearish === true) { bull += 0.3; parts.push(`TD${tf} 9 bear (exhaustion)`); }
    if (row.td13_bullish === true) { bear += 0.5; parts.push(`TD${tf} 13 bull (deep exhaustion)`); }
    if (row.td13_bearish === true) { bull += 0.5; parts.push(`TD${tf} 13 bear (deep exhaustion)`); }
    if (bullPrep >= 3 && bullPrep <= 7) { bull += 0.4; parts.push(`TD${tf} bull prep ${bullPrep}/9`); }
    if (bearPrep >= 3 && bearPrep <= 7) { bear += 0.4; parts.push(`TD${tf} bear prep ${bearPrep}/9`); }
    // tv_count is the TradingView-style live count (set in the current direction).
    if (row.tv_count_side === "bull" && row.tv_count >= 3 && row.tv_count <= 7) {
      bull += 0.3; parts.push(`TD${tf} tv ${row.tv_count} bull`);
    } else if (row.tv_count_side === "bear" && row.tv_count >= 3 && row.tv_count <= 7) {
      bear += 0.3; parts.push(`TD${tf} tv ${row.tv_count} bear`);
    }
  }
  const net = bull - bear;
  const total = bull + bear;
  const strength = Math.min(1, total / 1.5);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: 0, evidence: parts.join(", ") || "TD neutral" };
}

function scoreL7_Trend(t) {
  // Ripster cloud + SuperTrend structure health (sustainability of move).
  // Production paths:
  //   tf_tech.D.ripster.c72_89.above/below
  //   tf_tech.D.stDir + .stSlope
  let bull = 0, bear = 0, parts = [];

  // Ripster c72/89 cloud — daily.
  const rip = t?.tf_tech?.D?.ripster?.c72_89 || t?.ripster?.c72_89;
  if (rip) {
    if (rip.above) { bull += 0.5; parts.push("Ripster above"); }
    else if (rip.below) { bear += 0.5; parts.push("Ripster below"); }
  }

  // SuperTrend daily + slope (production fields).
  const stDir = t?.tf_tech?.D?.stDir;
  const stSlope = Number(t?.tf_tech?.D?.stSlope || 0);
  const stDirStr = String(stDir || "").toUpperCase();
  if (stDirStr === "BULL" || stDirStr === "LONG" || stDir === 1) {
    bull += 0.5 + Math.min(0.3, Math.max(0, stSlope * 10));
    parts.push(`ST bull (slope ${stSlope.toFixed(3)})`);
  } else if (stDirStr === "BEAR" || stDirStr === "SHORT" || stDir === -1) {
    bear += 0.5 + Math.min(0.3, Math.max(0, -stSlope * 10));
    parts.push(`ST bear (slope ${stSlope.toFixed(3)})`);
  }

  // EMA regime daily (proxy for spacing). +2 = strong bull, -2 = strong bear.
  const emaReg = Number(t?.ema_regime_daily);
  if (Number.isFinite(emaReg)) {
    if (emaReg >= 1) { bull += 0.2 * Math.min(1, emaReg / 2); parts.push(`EMA regime +${emaReg}`); }
    else if (emaReg <= -1) { bear += 0.2 * Math.min(1, -emaReg / 2); parts.push(`EMA regime ${emaReg}`); }
  }

  const net = bull - bear;
  const total = bull + bear;
  const strength = Math.min(1, total / 1.5);
  if (net > 0.3) return { side: "LONG", strength, evidence: parts.join(", ") };
  if (net < -0.3) return { side: "SHORT", strength, evidence: parts.join(", ") };
  return { side: "NEUTRAL", strength: strength * 0.3, evidence: parts.join(", ") || "Trend mixed" };
}

function scoreL8_Saty(t) {
  // ATR fib day-gate — Saty Mahajan's execution-level signal. Production
  // path: tf_tech.D.saty OR top-level atr_levels.
  const af = t?.tf_tech?.D?.saty || t?.atr_levels || t?.atrFibLevels;
  if (!af) return { side: "NEUTRAL", strength: 0, evidence: "no_atr_fib" };
  const px = Number(t?.price || 0);
  const mid = Number(af.anchor || af.mid || af.pivot);
  const levels = af.levels || af;
  const up = Number(levels["+38.2%"] || levels["+38.2"] || af["+38.2%"]);
  const dn = Number(levels["-38.2%"] || levels["-38.2"] || af["-38.2%"]);
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

// Production tf_tech labels: '10', '30', '1H', '4H', 'D' (NOT '60' or '240').
const ST_TFS_INTRADAY = ["10", "30"];
const ST_TFS_SWING    = ["1H", "4H", "D"];

function _readSuperTrend(t, tf) {
  // Production scoring writes ST as two flat fields on the TF row:
  //   tf_tech.{tf}.stDir   — "BULL" | "BEAR" (or sometimes 1 / -1)
  //   tf_tech.{tf}.stSlope — numeric slope (per-bar delta of the ST line)
  // Older / alternate shapes are also supported as fallback.
  const tfRow = t?.tf_tech?.[tf];
  if (!tfRow) return null;
  if (tfRow.stDir !== undefined || tfRow.stSlope !== undefined) {
    return { dir: tfRow.stDir, slope: tfRow.stSlope };
  }
  return tfRow.supertrend || tfRow.st || null;
}

function _stSloping(st) {
  if (!st) return { sloping: false, slope_dir: 0, slope_age_bars: null };
  const dirRaw = st.dir ?? st.direction;
  // Direction can be string ("BULL"/"BEAR"), number (1/-1), or boolean-ish.
  let dirSign = 0;
  if (typeof dirRaw === "number") dirSign = dirRaw > 0 ? 1 : dirRaw < 0 ? -1 : 0;
  else if (typeof dirRaw === "string") {
    const up = dirRaw.toUpperCase();
    if (up === "BULL" || up === "LONG" || up === "UP")    dirSign = 1;
    if (up === "BEAR" || up === "SHORT" || up === "DOWN") dirSign = -1;
  }

  // Preferred: explicit slope field.
  if (Number.isFinite(Number(st.slope))) {
    const s = Number(st.slope);
    if (Math.abs(s) < 0.0005) {
      // Slope exists but ~0 — line is flat even though direction may be set.
      return { sloping: false, slope_dir: 0, slope_age_bars: null, st_dir: dirRaw };
    }
    const sign = s > 0 ? 1 : -1;
    return {
      sloping: true,
      slope_dir: sign,
      slope_age_bars: Number(st.slope_age_bars) || Number(st.flip_age_bars) || null,
      st_dir: dirRaw,
    };
  }

  // Series fallback.
  const series = Array.isArray(st.series) ? st.series : (Array.isArray(st.values) ? st.values : null);
  if (series && series.length >= 3) {
    const last = Number(series[series.length - 1]);
    const prev2 = Number(series[series.length - 3]);
    if ([last, prev2].every(Number.isFinite)) {
      const slope = last - prev2;
      const sign = slope > 0 ? 1 : slope < 0 ? -1 : 0;
      if (sign === 0) return { sloping: false, slope_dir: 0, slope_age_bars: null };
      return { sloping: true, slope_dir: sign, slope_age_bars: null, st_dir: dirRaw };
    }
  }

  // Last fallback: held direction means line is moving with the trend.
  if (dirSign !== 0) return { sloping: true, slope_dir: dirSign, slope_age_bars: null, st_dir: dirRaw };
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
