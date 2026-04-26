// ═══════════════════════════════════════════════════════════════════════
// Focus Tier — V13 Intrinsic Conviction Score
//
// The rank formula (computeRank) had +0.002 correlation with pnl in V11.
// Rather than try to refit it, V13 bypasses composite rank entirely and
// builds a transparent conviction score from 6 backtest-safe signals:
//
//   1. Liquidity tier  (dollar volume 20-day avg)      0-20 pts
//   2. Volatility fit  (daily ATR%)                    0-15 pts
//   3. Trend quality   (EMA21 > EMA48 > EMA200 + dist) 0-20 pts
//   4. Sector regime   (monthly backdrop leadership)    0-10 pts
//   5. Relative strength vs SPY (20-day)               0-10 pts
//   6. Historical trade record (pre-asOfTs only)        0-20 pts
//
// Plus additive bonuses (capped at 100 total):
//   +15 — TT_SELECTED hard-coded curation
//   +10 — current GRNY/GRNJ/GRNI holding  (LIVE ONLY; backtest=0)
//   +10 — on Mark Newton's Upticks list    (LIVE ONLY; backtest=0)
//   + 5 — recent winner (≥2 wins, net +3% PnL in last 30 days)
//
// Tier from score:
//   >= 75 → Tier A (smoke treatment: lower floor, larger risk, sooner
//                  winner-protect, ETF Precision Gate eligible)
//   50-74 → Tier B (default V12)
//   < 50  → Tier C (exploratory: strict floor, reduced risk)
//
// See: tasks/v13-focus-tier-strategy-2026-04-24.md
// ═══════════════════════════════════════════════════════════════════════

// Hard-coded curated set — user-maintained, backtest-safe (no lookahead).
// Keep aligned with TT_SELECTED in worker/index.js:~31461.
export const TT_SELECTED_DEFAULT = new Set([
  "AMGN","AMZN","AXP","BABA","BG","BRK-B","CLS","CRS","CRWV","CSX","DBA",
  "ETHA","GEV","GILD","JCI","MRK","MTB","PH","PWR","QXO","TSLA","TT","VST","WMT",
]);

function _f(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 1 — LIQUIDITY TIER (0-20 pts)
// V11 losers skewed toward thin names. Every golden winner was on a
// ticker with consistent >$100M/day volume.
// ─────────────────────────────────────────────────────────────────────────
// V13: liquidity scoring uses TICKER_TYPE_MAP assignment as the primary
// proxy (emitted as `_ticker_type` on ticker data, populated by the
// scoring pipeline). The worker doesn't expose raw avg daily volume as
// a stable field, so we use the curated classification which correlates
// strongly with deep liquidity in practice.
//
// Price floor is a secondary signal: extremely low-priced names
// (< $5) tend to be penny-stock risk regardless of sector assignment.
// V15 P0.5 (2026-04-26): reverted liquidity to the P0.3 0-10 range
// after P0.3.4 weight relaxation backfired. The P0.3 calibration
// produced +29.38% / 66.7% WR on July; loosening weights leaked
// in losers (ORCL -5.17%, CDNS -3.23%, both with saty=-15 fade-
// into-level signals). The fix is the saty/phase VETO (below),
// not weight relaxation.
function scoreLiquidity(tickerData) {
  const tickerType = String(tickerData?._ticker_type || tickerData?.ticker_type || "").toLowerCase();
  const price = _f(tickerData?.price ?? tickerData?.close);

  let pts = 0;
  let reason = "";

  if (tickerType === "broad_etf" || tickerType === "sector_etf") {
    pts = 10;
    reason = `etf_${tickerType}`;
  } else if (tickerType === "large_cap" || tickerType === "growth" || tickerType === "mega_cap") {
    pts = 9;
    reason = `liquid_${tickerType}`;
  } else if (tickerType === "mid_cap") {
    pts = 8;
    reason = "mid_cap";
  } else if (tickerType === "thematic_etf" || tickerType === "commodity_etf" || tickerType === "precious_metal") {
    pts = 8;
    reason = `specialty_${tickerType}`;
  } else if (tickerType === "small_cap") {
    pts = 4;
    reason = "small_cap";
  } else if (tickerType === "crypto" || tickerType === "crypto_adj") {
    pts = 6;
    reason = `crypto_${tickerType}`;
  } else if (tickerType) {
    pts = 5;
    reason = `other_${tickerType}`;
  } else {
    if (price <= 0) return { pts: 0, reason: "no_classification_no_price" };
    if (price < 5) { pts = 0; reason = `unclassified_penny_${price.toFixed(2)}`; }
    else if (price < 10) { pts = 2; reason = `unclassified_low_${price.toFixed(2)}`; }
    else { pts = 4; reason = `unclassified_${price.toFixed(2)}`; }
  }

  if (price > 0 && price < 3) {
    pts = Math.min(pts, 1);
    reason += "_pennystock_cap";
  }

  return { pts, tickerType, reason };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 2 — VOLATILITY FIT (0-15 pts)
// V11 golden winners clustered at daily ATR% of 1.5-4%. Below 1.5 = too
// tight to produce meaningful moves; above 5% = whipsaws stop us out.
// ─────────────────────────────────────────────────────────────────────────
function scoreVolatility(tickerData) {
  // Worker emits `volatility_atr_pct` directly (daily ATR / price * 100).
  // Fall back to deriving from atr_d / price if the convenience field
  // isn't set.
  let effectiveAtrPct = _f(tickerData?.volatility_atr_pct);
  if (effectiveAtrPct <= 0) {
    const atrD = _f(tickerData?.atr_d ?? tickerData?.daily?.atr ?? tickerData?.atr);
    const price = _f(tickerData?.price ?? tickerData?.close);
    if (atrD > 0 && price > 0) effectiveAtrPct = (atrD / price) * 100;
  }
  if (effectiveAtrPct <= 0) return { pts: 0, reason: "no_atr" };

  // Sweet spot 1.5-4.0 gets full 15 pts. Bell-curve decay outside.
  let pts = 0;
  if (effectiveAtrPct >= 1.5 && effectiveAtrPct <= 4.0) pts = 15;
  else if (effectiveAtrPct >= 1.0 && effectiveAtrPct < 1.5) pts = 10;
  else if (effectiveAtrPct > 4.0 && effectiveAtrPct <= 5.5) pts = 10;
  else if (effectiveAtrPct >= 0.7 && effectiveAtrPct < 1.0) pts = 5;
  else if (effectiveAtrPct > 5.5 && effectiveAtrPct <= 7.5) pts = 5;
  // < 0.7 or > 7.5 = 0 pts (too tight / too wild)
  return { pts, atrPct: Math.round(effectiveAtrPct * 100) / 100 };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 3 — TREND QUALITY (0-20 pts)
// V11 golden winner fingerprint: daily E21 > E48 > E200 stacked, price
// within 2 ATR of E21 (not overextended, not deeply broken).
// ─────────────────────────────────────────────────────────────────────────
// V15 P0.5 (2026-04-26): reverted to P0.3 0-10 range. The P0.3.1
// boost to 0-15 leaked losers in (ORCL/CDNS Jul 31). Trend is still
// useful but the V14 forensic showed it was saturated, so 0-10 is
// the right scale. The saty/phase VETO will catch the losers that
// the conviction floor alone couldn't.
function scoreTrend(tickerData) {
  const daily = tickerData?.daily_structure || tickerData?.daily || {};
  const e21 = _f(daily?.e21 ?? daily?.ema21);
  const e48 = _f(daily?.e48 ?? daily?.ema48);
  const e200 = _f(daily?.e200 ?? daily?.ema200);
  const price = _f(tickerData?.price ?? tickerData?.close ?? daily?.px);
  // daily_structure doesn't carry atr — use top-level atr_d
  const atr = _f(tickerData?.atr_d ?? daily?.atr ?? tickerData?.atr);

  // If e200 missing but bull_stack flag is set, use it (daily_structure
  // sometimes emits just e21/e48 + bull_stack/bear_stack booleans).
  let bullStack, bearStack;
  if (e21 > 0 && e48 > 0 && e200 > 0) {
    bullStack = e21 > e48 && e48 > e200;
    bearStack = e21 < e48 && e48 < e200;
  } else if (daily?.bull_stack === true || daily?.bear_stack === true) {
    bullStack = daily.bull_stack === true;
    bearStack = daily.bear_stack === true;
  } else {
    return { pts: 0, reason: "missing_emas" };
  }
  if (!price) return { pts: 0, reason: "missing_price" };
  if (!e21) return { pts: bullStack || bearStack ? 5 : 0, reason: `${bullStack ? 'bull' : 'bear'}_stack_only` };

  let pts = 0;
  let reason = "";

  if (bullStack) {
    pts += 5;  // V14 was 10, P0.3 set to 5
    reason = "bull_stacked";
  } else if (bearStack) {
    pts += 5;
    reason = "bear_stacked";
  } else {
    pts += 0;
    reason = "chop";
  }

  if (atr > 0) {
    const distAtrs = Math.abs(price - e21) / atr;
    if (distAtrs <= 2.0 && distAtrs >= 0.0) pts += 5;
    else if (distAtrs <= 3.0) pts += 3;
    reason += `, ${distAtrs.toFixed(1)}atr_from_e21`;
  } else {
    const distPct = Math.abs((price - e21) / e21) * 100;
    if (distPct <= 4.0) pts += 5;
    else if (distPct <= 7.0) pts += 3;
    reason += `, ${distPct.toFixed(1)}%_from_e21`;
  }

  return { pts, reason };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 4 — SECTOR REGIME (0-10 pts)
// Read from the monthly backdrop (already computed for each month).
// If ticker's sector is in the backdrop's `sector_leadership` list = boost.
// ─────────────────────────────────────────────────────────────────────────
// V15 P0.3 (2026-04-25): sector range expanded 0-10 → 0-15 because V14
// forensic showed Pearson(sector_pts, pnl) = +0.047 (mildly predictive
// but underweighted). Sector overweight produced WR 54.4% vs underweight
// 55.2% in V14 — a flat outcome — but the difference between leadership
// vs bottom backdrop trades was clearer. Boost weight to leverage what's
// reliably populated.
function scoreSector(tickerData, ctx) {
  // V13: worker emits `_sector_rating` (overweight / neutral / underweight)
  // based on Fundstrat's sector guidance. Use this as the primary signal
  // since it's always populated and already reflects the analyst view.
  const rating = String(tickerData?._sector_rating || "").toLowerCase();
  if (rating === "overweight") return { pts: 15, reason: "sector_overweight" };
  if (rating === "underweight") return { pts: 0, reason: "sector_underweight" };
  if (rating === "neutral") return { pts: 7, reason: "sector_neutral" };

  // Fallback to monthly backdrop sector leadership if rating missing
  const sector = String(tickerData?._sector || ctx?.sector || "").toLowerCase();
  if (!sector) return { pts: 7, reason: "no_sector_data" };
  const leadership = ctx?.market?.monthlySectorTop || ctx?.monthlyBackdrop?.sector_leadership || [];
  const bottom = ctx?.market?.monthlySectorBottom || ctx?.monthlyBackdrop?.sector_bottom || [];
  const leadNorm = (Array.isArray(leadership) ? leadership : []).map(s => String(s).toLowerCase());
  const bottomNorm = (Array.isArray(bottom) ? bottom : []).map(s => String(s).toLowerCase());
  if (leadNorm.some(s => s.includes(sector) || sector.includes(s))) {
    return { pts: 15, reason: "sector_leadership_backdrop" };
  }
  if (bottomNorm.some(s => s.includes(sector) || sector.includes(s))) {
    return { pts: 0, reason: "sector_bottom_backdrop" };
  }
  return { pts: 7, reason: "sector_neutral_fallback" };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 5 — RELATIVE STRENGTH vs SPY (0-10 pts)
// Trailing 20-day price change vs SPY's. Outperforming = bullish bias.
// ─────────────────────────────────────────────────────────────────────────
function scoreRelativeStrength(tickerData, ctx) {
  // V13 pragmatic: we don't persist a 20-day change per ticker, but the
  // daily EMA slopes are a solid proxy. e21_slope_5d_pct measures the
  // recent trend velocity on the daily. Combine with pct_above_e48
  // (how extended above the 48-day mean) for a RS view vs its own trend.
  // SPY's slope serves as the market baseline.
  const daily = tickerData?.daily_structure || {};
  const tickerSlope = _f(daily?.e21_slope_5d_pct);
  const tickerPctAboveE48 = _f(daily?.pct_above_e48);
  // V14 (2026-04-24): replay-interval-step was previously not propagating
  // spy_daily_structure into _marketRegime, so spySlope was always 0 in
  // backtests and "RS vs SPY" degenerated into absolute ticker slope.
  // Fall back through every shape we've ever emitted, and mark a
  // diagnostic note so we can detect regressions in the trace.
  const spyDaily = ctx?.market?.spy_daily_structure
    || ctx?.spyDailyStructure
    || ctx?._marketRegime?.spy_daily_structure
    || ctx?.market?.spy?.daily_structure
    || {};
  let spySlope = _f(spyDaily?.e21_slope_5d_pct);
  let spySlopeMissing = !Number.isFinite(Number(spyDaily?.e21_slope_5d_pct));
  // V14 (2026-04-24): when spy_daily_structure isn't threaded through (shape
  // varies across replay code paths), fall back to htf_score as a proxy.
  // htf_score is roughly bounded -50..+50 representing market regime
  // strength; convert to a slope-equivalent (~0.02 = +1pp) to keep the
  // signal rounded. This is approximate but correctly directional.
  if (spySlopeMissing) {
    const htfScore = _f(ctx?.market?.htf_score ?? ctx?._marketRegime?.htf_score);
    if (htfScore !== 0) {
      spySlope = htfScore * 0.02;  // map ±50 → ±1.0 slope-equiv
      spySlopeMissing = false;
    }
  }

  // V15 P0.3 (2026-04-25): RS range expanded 0-10 → 0-25. V14 forensic
  // confirmed RS as the strongest predictor (Pearson +0.097, highest of
  // all signals). pts=8 bucket had 69.6% WR / +1.65% avg — best cluster
  // in the entire run. Doubling weight to leverage what works.

  // No data path
  if (tickerSlope === 0 && tickerPctAboveE48 === 0) {
    return { pts: 12, reason: spySlopeMissing ? "no_rs_data_spy_missing" : "no_rs_data" };
  }

  // Relative slope: ticker vs SPY daily velocity (percentage points)
  const slopeDiff = tickerSlope - spySlope;
  // Combined score: weighted sum (was 0-10 → now 0-25)
  let pts = 12;  // neutral default
  if (slopeDiff > 0.5 && tickerPctAboveE48 > 1.0) pts = 25;       // strong RS + above mean
  else if (slopeDiff > 0.25 && tickerPctAboveE48 > 0) pts = 20;   // moderate RS
  else if (slopeDiff > 0) pts = 15;                                // mild RS
  else if (slopeDiff < -0.5 && tickerPctAboveE48 < -2.0) pts = 0;  // strong underperform
  else if (slopeDiff < -0.25) pts = 5;                             // mild underperform
  else pts = 10;                                                    // neutral/weak

  return {
    pts,
    slopeDiff: Math.round(slopeDiff * 100) / 100,
    tickerSlope: Math.round(tickerSlope * 100) / 100,
    spySlope: Math.round(spySlope * 100) / 100,
    pctAboveE48: Math.round(tickerPctAboveE48 * 10) / 10,
    spy_baseline_missing: spySlopeMissing,
    reason: `slope ${slopeDiff >= 0 ? '+' : ''}${slopeDiff.toFixed(2)}% vs SPY${spySlopeMissing ? '(missing)' : ''}, ${tickerPctAboveE48.toFixed(1)}% above E48`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 6 — HISTORICAL TRADE RECORD (0-20 pts)
// Reads from pre-computed historyStats (trades with exit_ts < asOfTs only).
// Requires n ≥ 3 to generate a signal. Cold-start friendly.
// ─────────────────────────────────────────────────────────────────────────
function scoreHistory(tickerUpper, historyStats) {
  const stats = historyStats?.get?.(tickerUpper) || historyStats?.[tickerUpper];
  if (!stats || stats.n < 3) return { pts: 10, reason: "insufficient_history" };  // neutral

  const wr = stats.wins / stats.n;
  const avgPnl = stats.totalPnl / stats.n;

  let pts = 10;
  // WR-based
  if (wr >= 0.70 && avgPnl > 1.0) pts = 20;
  else if (wr >= 0.60 && avgPnl > 0.5) pts = 17;
  else if (wr >= 0.50 && avgPnl > 0) pts = 13;
  else if (wr >= 0.40) pts = 8;
  else if (wr >= 0.30) pts = 4;
  else pts = 0;

  return {
    pts,
    n: stats.n, wins: stats.wins,
    wr: Math.round(wr * 100),
    avgPnl: Math.round(avgPnl * 100) / 100,
    reason: `${stats.n}t ${Math.round(wr*100)}%WR ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(2)}%avg`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 7 — SATY ATR PROXIMITY (V15 P0.1, 2026-04-25)
//
// V14 forensic surfaced the H SHORT 2026-04-07 catastrophe: -11.39% via
// HARD_LOSS_CAP. The trade entered SHORT into a Saty ATR support level
// on the daily timeframe — price was approaching prev_close ATR support
// and our system shorted it. A trader looking at the chart would say
// "you don't fade into key support."
//
// This signal codifies that intuition. For each entry we measure the
// nearest Saty ATR level on the daily timeframe (using prev_close as
// anchor + Fib ratios × atr_d). Three categories:
//
//   1. FADE-INTO-LEVEL (the trap): shorting INTO a level above (level
//      acts as resistance for the short → risk of reversal off level)
//      OR longing INTO a level below (level acts as support → risk of
//      bounce off level). Within 0.25 ATR. → -15 pts
//
//   2. RIDING-THROUGH-LEVEL (the alpha): entry beyond a level in the
//      same direction (e.g. SHORT below a recently-broken support, LONG
//      above a recently-broken resistance). Level becomes new floor /
//      ceiling. Within 0.5 ATR of a level on the FAR side. → +10 pts
//
//   3. CLEAN RUNWAY: between levels, no level within 0.5 ATR in entry
//      direction. → +5 pts (default)
//
//   4. NO DATA: atr_levels.day missing or invalid. → 0 pts (neutral)
//
// Range: -15 to +10 pts (asymmetric — penalty stronger than reward
// because fade-trap losses are the catastrophic class).
//
// Required inputs: ctx.side ("LONG" | "SHORT"), tickerData.atr_levels.day
// ─────────────────────────────────────────────────────────────────────────
function scoreSatyAtrProximity(tickerData, ctx) {
  const side = String(ctx?.side || ctx?.direction || "").toUpperCase();
  if (!side || (side !== "LONG" && side !== "SHORT")) {
    return { pts: 0, reason: "no_side" };
  }
  const day = tickerData?.atr_levels?.day || null;
  if (!day || !Number.isFinite(day.atr) || day.atr <= 0) {
    return { pts: 0, reason: "no_atr_levels" };
  }
  const price = _f(tickerData?.price ?? tickerData?.close);
  if (!Number.isFinite(price) || price <= 0) {
    return { pts: 0, reason: "no_price" };
  }
  const prevClose = Number(day.prevClose) || 0;
  const atr = Number(day.atr);
  if (atr <= 0) return { pts: 0, reason: "no_atr" };

  // Build the full level set: prev_close + ±{0.236, 0.382, 0.618, 1.0, 1.272, 1.618} × atr
  const ratios = [0.236, 0.382, 0.618, 1.0, 1.272, 1.618];
  const levels = [{ price: prevClose, ratio: 0, label: "prev_close" }];
  for (const r of ratios) {
    levels.push({ price: prevClose + r * atr, ratio: +r, label: `+${(r*100).toFixed(1)}%` });
    levels.push({ price: prevClose - r * atr, ratio: -r, label: `-${(r*100).toFixed(1)}%` });
  }

  // Find nearest level (by absolute price distance)
  let nearest = null;
  let nearestDistAtr = Infinity;
  for (const lv of levels) {
    const distPrice = Math.abs(price - lv.price);
    const distAtr = distPrice / atr;
    if (distAtr < nearestDistAtr) {
      nearestDistAtr = distAtr;
      nearest = lv;
    }
  }
  if (!nearest) return { pts: 0, reason: "no_nearest_level" };

  const levelAbove = nearest.price > price;
  const levelBelow = nearest.price < price;

  // FADE-INTO-LEVEL detection — within 0.25 ATR
  // SHORT: dangerous if level is above (acts as resistance ABOVE which a
  //        short already entered, and price could reverse OFF the level
  //        upward). Wait — a SHORT entered AT/NEAR a support level is
  //        the classic "shorting into support" mistake. So:
  //        SHORT + level BELOW + close = fade trap (level is support)
  //        LONG  + level ABOVE + close = fade trap (level is resistance)
  if (nearestDistAtr <= 0.25) {
    if (side === "LONG" && levelAbove) {
      return {
        pts: -15,
        reason: `fade_into_resistance_${nearest.label}_${nearestDistAtr.toFixed(2)}atr`,
        nearest_level: nearest.price,
        nearest_label: nearest.label,
        distance_atr: Math.round(nearestDistAtr * 100) / 100,
      };
    }
    if (side === "SHORT" && levelBelow) {
      return {
        pts: -15,
        reason: `fade_into_support_${nearest.label}_${nearestDistAtr.toFixed(2)}atr`,
        nearest_level: nearest.price,
        nearest_label: nearest.label,
        distance_atr: Math.round(nearestDistAtr * 100) / 100,
      };
    }
  }

  // RIDING-THROUGH-LEVEL detection — within 0.5 ATR, level is on the
  // SAME side as direction (LONG above level = riding through resistance,
  // SHORT below level = riding through support).
  if (nearestDistAtr <= 0.5) {
    if (side === "LONG" && levelBelow) {
      return {
        pts: 10,
        reason: `riding_through_${nearest.label}_${nearestDistAtr.toFixed(2)}atr`,
        nearest_level: nearest.price,
        nearest_label: nearest.label,
        distance_atr: Math.round(nearestDistAtr * 100) / 100,
      };
    }
    if (side === "SHORT" && levelAbove) {
      return {
        pts: 10,
        reason: `riding_through_${nearest.label}_${nearestDistAtr.toFixed(2)}atr`,
        nearest_level: nearest.price,
        nearest_label: nearest.label,
        distance_atr: Math.round(nearestDistAtr * 100) / 100,
      };
    }
  }

  // CLEAN RUNWAY default (no level within 0.5 ATR in danger direction
  // OR level present but on the safe side)
  return {
    pts: 5,
    reason: `clean_runway_nearest_${nearest.label}_${nearestDistAtr.toFixed(2)}atr`,
    nearest_level: nearest.price,
    nearest_label: nearest.label,
    distance_atr: Math.round(nearestDistAtr * 100) / 100,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 8 — PHASE SLOPE ALIGNMENT (V15 P0.2, 2026-04-25)
//
// V14 forensic on the H trade: the catastrophe entry had phase trending
// against direction. The user explicitly called out: "Another signal
// that was saying no to Short is the sloping Phase Line."
//
// Implementation: phase_slope_5bar is computed from the daily momentum
// series (positive = bullish trending, negative = bearish trending).
//
//   LONG  + slope >= +0.5  → +10 pts (phase confirms long)
//   LONG  + slope ∈ [-0.5, +0.5]  → 0 pts (neutral)
//   LONG  + slope < -0.5  → -10 pts (phase opposes — the H pattern)
//
//   SHORT + slope <= -0.5  → +10 pts (phase confirms short)
//   SHORT + slope ∈ [-0.5, +0.5]  → 0 pts (neutral)
//   SHORT + slope > +0.5  → -10 pts (phase opposes — the H pattern)
//
// Range -10 to +10.
// ─────────────────────────────────────────────────────────────────────────
function scorePhaseAlignment(tickerData, ctx) {
  const side = String(ctx?.side || ctx?.direction || "").toUpperCase();
  if (!side || (side !== "LONG" && side !== "SHORT")) {
    return { pts: 0, reason: "no_side" };
  }
  const slope = _f(tickerData?.phase_slope_5bar);
  if (!Number.isFinite(Number(tickerData?.phase_slope_5bar))) {
    return { pts: 0, reason: "no_phase_slope" };
  }

  const NEUTRAL_BAND = 0.5;
  let pts = 0;
  let reason = "";
  if (side === "LONG") {
    if (slope >= NEUTRAL_BAND) { pts = 10; reason = `phase_confirms_long_${slope.toFixed(2)}`; }
    else if (slope <= -NEUTRAL_BAND) { pts = -10; reason = `phase_opposes_long_${slope.toFixed(2)}`; }
    else { pts = 0; reason = `phase_neutral_${slope.toFixed(2)}`; }
  } else {
    if (slope <= -NEUTRAL_BAND) { pts = 10; reason = `phase_confirms_short_${slope.toFixed(2)}`; }
    else if (slope >= NEUTRAL_BAND) { pts = -10; reason = `phase_opposes_short_${slope.toFixed(2)}`; }
    else { pts = 0; reason = `phase_neutral_${slope.toFixed(2)}`; }
  }
  return { pts, reason, slope: Math.round(slope * 100) / 100 };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 9 — RSI SLOPE ALIGNMENT (V15 P0.2, 2026-04-25)
//
// Same logic as phase_alignment but with RSI on the daily timeframe.
// RSI slope tells us momentum direction independent of phase
// composition — a SHORT entered when RSI is rising signals momentum
// against the trade.
//
// Reads tickerData.tf_tech.D.rsi.slope5 (5-bar RSI change in pts/bar).
// LONG/SHORT + slope agreement → ±5 pts (lower weight than phase
// because RSI is noisier on shorter timeframes).
//
//   LONG  + slope >= +0.3  → +5
//   LONG  + slope ∈ [-0.3, +0.3]  → 0
//   LONG  + slope < -0.3  → -5
//   SHORT (mirrored)
//
// Range -5 to +5.
// ─────────────────────────────────────────────────────────────────────────
function scoreRsiAlignment(tickerData, ctx) {
  const side = String(ctx?.side || ctx?.direction || "").toUpperCase();
  if (!side || (side !== "LONG" && side !== "SHORT")) {
    return { pts: 0, reason: "no_side" };
  }
  // Prefer Daily RSI slope, fall back to 1H, then 30m
  const tfTech = tickerData?.tf_tech || {};
  const candidates = [tfTech.D, tfTech["1H"], tfTech["60"], tfTech["30"]];
  let slope = null;
  let usedTf = null;
  for (const tf of candidates) {
    const v = tf?.rsi?.slope5;
    if (Number.isFinite(Number(v))) {
      slope = Number(v);
      usedTf = tf === tfTech.D ? "D" : tf === tfTech["1H"] || tf === tfTech["60"] ? "1H" : "30";
      break;
    }
  }
  if (!Number.isFinite(slope)) {
    return { pts: 0, reason: "no_rsi_slope" };
  }

  const NEUTRAL_BAND = 0.3;
  let pts = 0;
  let reason = "";
  if (side === "LONG") {
    if (slope >= NEUTRAL_BAND) { pts = 5; reason = `rsi_confirms_long_${slope.toFixed(2)}_${usedTf}`; }
    else if (slope <= -NEUTRAL_BAND) { pts = -5; reason = `rsi_opposes_long_${slope.toFixed(2)}_${usedTf}`; }
    else { pts = 0; reason = `rsi_neutral_${slope.toFixed(2)}_${usedTf}`; }
  } else {
    if (slope <= -NEUTRAL_BAND) { pts = 5; reason = `rsi_confirms_short_${slope.toFixed(2)}_${usedTf}`; }
    else if (slope >= NEUTRAL_BAND) { pts = -5; reason = `rsi_opposes_short_${slope.toFixed(2)}_${usedTf}`; }
    else { pts = 0; reason = `rsi_neutral_${slope.toFixed(2)}_${usedTf}`; }
  }
  return { pts, reason, slope: Math.round(slope * 100) / 100, tf: usedTf };
}

// ─────────────────────────────────────────────────────────────────────────
// Recent-winner bonus (+5 pts)
// ≥2 wins on this ticker in last 30 trading days, net +3% PnL.
// ─────────────────────────────────────────────────────────────────────────
function scoreRecentWinner(tickerUpper, historyStats) {
  const stats = historyStats?.get?.(tickerUpper) || historyStats?.[tickerUpper];
  if (!stats || !stats.recent30d) return 0;
  const r = stats.recent30d;
  if ((r.wins || 0) >= 2 && (r.totalPnl || 0) >= 3.0) return 5;
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN — compute score + tier
// ─────────────────────────────────────────────────────────────────────────
export function computeConvictionScore({
  tickerData,
  ctx,
  historyStats,
  ttSelected,
  // Live-only bonuses (backtest skips by passing empty Sets)
  currentGrannyEtfHoldings,
  currentUpticks,
}) {
  const tickerUpper = String(tickerData?.ticker || tickerData?.sym || ctx?.ticker || "").toUpperCase();

  const s1 = scoreLiquidity(tickerData);
  const s2 = scoreVolatility(tickerData);
  const s3 = scoreTrend(tickerData);
  const s4 = scoreSector(tickerData, ctx);
  const s5 = scoreRelativeStrength(tickerData, ctx);
  const s6 = scoreHistory(tickerUpper, historyStats);
  // V15 P0.1 — Saty ATR proximity (range -15 to +10)
  const s7 = scoreSatyAtrProximity(tickerData, ctx);
  // V15 P0.2 — Phase + RSI slope alignment
  const s8 = scorePhaseAlignment(tickerData, ctx);
  const s9 = scoreRsiAlignment(tickerData, ctx);

  let base = s1.pts + s2.pts + s3.pts + s4.pts + s5.pts + s6.pts + s7.pts + s8.pts + s9.pts;

  // Bonuses (capped so total ≤ 100)
  const ttSelBonus = (ttSelected || TT_SELECTED_DEFAULT).has(tickerUpper) ? 15 : 0;
  const grannyBonus = (currentGrannyEtfHoldings && currentGrannyEtfHoldings.has(tickerUpper)) ? 10 : 0;
  const upticksBonus = (currentUpticks && currentUpticks.has(tickerUpper)) ? 10 : 0;
  const recentBonus = scoreRecentWinner(tickerUpper, historyStats);

  // V15 P0.5 (2026-04-26): reverted weights to P0.3 baseline.
  //   liquidity 0-10  (was 0-20 V14)
  //   volatility 0-15
  //   trend 0-10  (was 0-20 V14)
  //   sector 0-15  (was 0-10 V14)
  //   relative_strength 0-25  (was 0-10 V14, the strongest predictor)
  //   history 0-20
  //   saty_atr_proximity -15 to +10
  //   phase_alignment -10 to +10
  //   rsi_alignment -5 to +5
  // Max base = 10+15+10+15+25+20+10+10+5 = 120
  // Max bonuses = 40 → theoretical max 160
  const total = Math.max(0, Math.min(160, base + ttSelBonus + grannyBonus + upticksBonus + recentBonus));

  // V15 P0.5 tier thresholds (back to P0.3 calibration):
  //   A ≥ 110, B ≥ 80, C < 80
  // Entry floor 80 (handled by Math.max() in tt-core-entry.js).
  const tier = total >= 110 ? "A" : total >= 80 ? "B" : "C";

  return {
    ticker: tickerUpper,
    score: total,
    tier,
    breakdown: {
      liquidity: s1,
      volatility: s2,
      trend: s3,
      sector: s4,
      relative_strength: s5,
      history: s6,
      saty_atr_proximity: s7,
      phase_alignment: s8,
      rsi_alignment: s9,
      bonuses: {
        tt_selected: ttSelBonus,
        granny_etf: grannyBonus,
        upticks: upticksBonus,
        recent_winner: recentBonus,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// History stats builder — call once per run at startup.
//
// Accepts an array of closed trades. Returns a Map keyed by ticker with:
//   { n, wins, losses, totalPnl, recent30d: { wins, losses, totalPnl } }
//
// IMPORTANT: this is a POINT-IN-TIME builder. For each replay bar's
// asOfTs, the caller should invalidate/rebuild the stats to only
// include trades with exit_ts < asOfTs. For performance, we build
// it once per DAY (not per bar) — a one-day granularity is plenty.
// ─────────────────────────────────────────────────────────────────────────
export function buildHistoryStats(trades, asOfMs) {
  const out = new Map();
  if (!Array.isArray(trades)) return out;
  const recent30dMs = 30 * 24 * 60 * 60 * 1000;

  for (const t of trades) {
    if (!t) continue;
    const ticker = String(t.ticker || "").toUpperCase();
    if (!ticker) continue;
    const exitTs = Number(t.exit_ts || t.exit_timestamp || 0);
    if (!exitTs || exitTs >= asOfMs) continue;  // backtest-safe: future trades invisible

    const pnl = Number(t.pnl_pct || 0);
    const status = (t.status || "").toUpperCase();
    if (status !== "WIN" && status !== "LOSS" && status !== "FLAT") continue;

    let slot = out.get(ticker);
    if (!slot) {
      slot = { n: 0, wins: 0, losses: 0, totalPnl: 0, recent30d: { n: 0, wins: 0, losses: 0, totalPnl: 0 } };
      out.set(ticker, slot);
    }
    slot.n++;
    slot.totalPnl += pnl;
    if (status === "WIN") slot.wins++;
    else if (status === "LOSS") slot.losses++;

    if (asOfMs - exitTs <= recent30dMs) {
      slot.recent30d.n++;
      slot.recent30d.totalPnl += pnl;
      if (status === "WIN") slot.recent30d.wins++;
      else if (status === "LOSS") slot.recent30d.losses++;
    }
  }
  return out;
}
