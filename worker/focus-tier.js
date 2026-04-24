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
function scoreLiquidity(tickerData) {
  const tickerType = String(tickerData?._ticker_type || tickerData?.ticker_type || "").toLowerCase();
  const price = _f(tickerData?.price ?? tickerData?.close);

  let pts = 0;
  let reason = "";

  // Broad + sector ETFs = deepest liquidity
  if (tickerType === "broad_etf" || tickerType === "sector_etf") {
    pts = 20;
    reason = `etf_${tickerType}`;
  } else if (tickerType === "large_cap" || tickerType === "growth" || tickerType === "mega_cap") {
    pts = 18;
    reason = `liquid_${tickerType}`;
  } else if (tickerType === "mid_cap") {
    pts = 13;
    reason = "mid_cap";
  } else if (tickerType === "thematic_etf" || tickerType === "commodity_etf" || tickerType === "precious_metal") {
    pts = 15;
    reason = `specialty_${tickerType}`;
  } else if (tickerType === "small_cap") {
    pts = 8;
    reason = "small_cap";
  } else if (tickerType === "crypto" || tickerType === "crypto_adj") {
    pts = 12;
    reason = `crypto_${tickerType}`;
  } else if (tickerType) {
    pts = 10;
    reason = `other_${tickerType}`;
  } else {
    // Unclassified ticker — fall back to price-based heuristic
    if (price <= 0) return { pts: 0, reason: "no_classification_no_price" };
    if (price < 5) { pts = 0; reason = `unclassified_penny_${price.toFixed(2)}`; }
    else if (price < 10) { pts = 5; reason = `unclassified_low_${price.toFixed(2)}`; }
    else { pts = 8; reason = `unclassified_${price.toFixed(2)}`; }
  }

  // Penny-stock override even for classified names
  if (price > 0 && price < 3) {
    pts = Math.min(pts, 3);
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
  if (!e21) return { pts: bullStack || bearStack ? 10 : 0, reason: `${bullStack ? 'bull' : 'bear'}_stack_only` };

  let pts = 0;
  let reason = "";

  if (bullStack) {
    pts += 10;  // stacked bull
    reason = "bull_stacked";
  } else if (bearStack) {
    pts += 10;  // stacked bear (valid for SHORT setups)
    reason = "bear_stacked";
  } else {
    pts += 0;
    reason = "chop";
  }

  // Price distance from E21 (in ATR units if available)
  if (atr > 0) {
    const distAtrs = Math.abs(price - e21) / atr;
    // Sweet spot: 0.3-2.0 ATRs from E21 (close enough to be tradeable,
    // far enough not to be extended)
    if (distAtrs <= 2.0 && distAtrs >= 0.0) pts += 10;
    else if (distAtrs <= 3.0) pts += 5;
    // > 3 ATRs from E21 = too extended, 0 extra pts
    reason += `, ${distAtrs.toFixed(1)}atr_from_e21`;
  } else {
    // Fallback: pct distance from E21
    const distPct = Math.abs((price - e21) / e21) * 100;
    if (distPct <= 4.0) pts += 10;
    else if (distPct <= 7.0) pts += 5;
    reason += `, ${distPct.toFixed(1)}%_from_e21`;
  }

  return { pts, reason };
}

// ─────────────────────────────────────────────────────────────────────────
// Signal 4 — SECTOR REGIME (0-10 pts)
// Read from the monthly backdrop (already computed for each month).
// If ticker's sector is in the backdrop's `sector_leadership` list = boost.
// ─────────────────────────────────────────────────────────────────────────
function scoreSector(tickerData, ctx) {
  // V13: worker emits `_sector_rating` (overweight / neutral / underweight)
  // based on Fundstrat's sector guidance. Use this as the primary signal
  // since it's always populated and already reflects the analyst view.
  const rating = String(tickerData?._sector_rating || "").toLowerCase();
  if (rating === "overweight") return { pts: 10, reason: "sector_overweight" };
  if (rating === "underweight") return { pts: 0, reason: "sector_underweight" };
  if (rating === "neutral") return { pts: 5, reason: "sector_neutral" };

  // Fallback to monthly backdrop sector leadership if rating missing
  const sector = String(tickerData?._sector || ctx?.sector || "").toLowerCase();
  if (!sector) return { pts: 5, reason: "no_sector_data" };
  const leadership = ctx?.market?.monthlySectorTop || ctx?.monthlyBackdrop?.sector_leadership || [];
  const bottom = ctx?.market?.monthlySectorBottom || ctx?.monthlyBackdrop?.sector_bottom || [];
  const leadNorm = (Array.isArray(leadership) ? leadership : []).map(s => String(s).toLowerCase());
  const bottomNorm = (Array.isArray(bottom) ? bottom : []).map(s => String(s).toLowerCase());
  if (leadNorm.some(s => s.includes(sector) || sector.includes(s))) {
    return { pts: 10, reason: "sector_leadership_backdrop" };
  }
  if (bottomNorm.some(s => s.includes(sector) || sector.includes(s))) {
    return { pts: 0, reason: "sector_bottom_backdrop" };
  }
  return { pts: 5, reason: "sector_neutral_fallback" };
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
  const spyDaily = ctx?.market?.spy_daily_structure || ctx?.spyDailyStructure || {};
  const spySlope = _f(spyDaily?.e21_slope_5d_pct);

  // No data path
  if (tickerSlope === 0 && tickerPctAboveE48 === 0) {
    return { pts: 5, reason: "no_rs_data" };
  }

  // Relative slope: ticker vs SPY daily velocity (percentage points)
  const slopeDiff = tickerSlope - spySlope;
  // Extension: how much above E48 (conviction ETF-style check)
  // Combined score: weighted sum
  let pts = 5;  // neutral
  if (slopeDiff > 0.5 && tickerPctAboveE48 > 1.0) pts = 10;       // strong RS + above mean
  else if (slopeDiff > 0.25 && tickerPctAboveE48 > 0) pts = 8;    // moderate RS
  else if (slopeDiff > 0) pts = 6;                                 // mild RS
  else if (slopeDiff < -0.5 && tickerPctAboveE48 < -2.0) pts = 0;  // strong underperform
  else if (slopeDiff < -0.25) pts = 2;                             // mild underperform
  else pts = 4;                                                     // neutral/weak

  return {
    pts,
    slopeDiff: Math.round(slopeDiff * 100) / 100,
    tickerSlope: Math.round(tickerSlope * 100) / 100,
    spySlope: Math.round(spySlope * 100) / 100,
    pctAboveE48: Math.round(tickerPctAboveE48 * 10) / 10,
    reason: `slope ${slopeDiff >= 0 ? '+' : ''}${slopeDiff.toFixed(2)}% vs SPY, ${tickerPctAboveE48.toFixed(1)}% above E48`,
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

  let base = s1.pts + s2.pts + s3.pts + s4.pts + s5.pts + s6.pts;

  // Bonuses (capped so total ≤ 100)
  const ttSelBonus = (ttSelected || TT_SELECTED_DEFAULT).has(tickerUpper) ? 15 : 0;
  const grannyBonus = (currentGrannyEtfHoldings && currentGrannyEtfHoldings.has(tickerUpper)) ? 10 : 0;
  const upticksBonus = (currentUpticks && currentUpticks.has(tickerUpper)) ? 10 : 0;
  const recentBonus = scoreRecentWinner(tickerUpper, historyStats);

  const total = Math.min(100, base + ttSelBonus + grannyBonus + upticksBonus + recentBonus);

  const tier = total >= 75 ? "A" : total >= 50 ? "B" : "C";

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
