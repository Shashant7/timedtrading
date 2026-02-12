// ─────────────────────────────────────────────────────────────────────────────
// Investor Intelligence Module
//
// Parallel scoring and analysis layer for long-term investors.
// Operates on Weekly/Monthly timeframes with multi-week to multi-month horizons.
// ─────────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1B: computeInvestorScore
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute a 0-100 investor attractiveness score for a ticker.
 * Components:
 *   - Weekly Trend (25 pts)
 *   - Monthly Trend (20 pts)
 *   - Relative Strength (20 pts)
 *   - Accumulation Signal (15 pts)
 *   - Trend Durability (10 pts)
 *   - Sector Context (10 pts)
 *
 * @param {object} tickerData - assembled ticker payload from assembleTickerData
 * @param {object} opts - { rsRank, sectorRsRank, marketHealth, sectorMap }
 * @returns {{ score: number, components: object }}
 */
export function computeInvestorScore(tickerData, opts = {}) {
  const components = {
    weeklyTrend: 0,
    monthlyTrend: 0,
    relativeStrength: 0,
    accumulationSignal: 0,
    trendDurability: 0,
    sectorContext: 0,
  };

  // ── Weekly Trend (25 pts) ──
  const tfW = tickerData.tf_tech?.W;
  const emaW = tickerData.ema_map?.W;
  const regime = tickerData.regime;

  if (tfW || emaW) {
    // Weekly SuperTrend direction: +8 bullish, -4 bearish
    const wStDir = tfW?.atr?.xs;
    if (wStDir === 1) components.weeklyTrend += 8;
    else if (wStDir === -1) components.weeklyTrend -= 4;

    // Weekly EMA stack depth (0-10): map to 0-10 pts
    const wDepth = emaW?.depth ?? tfW?.ema?.depth ?? 0;
    components.weeklyTrend += Math.min(10, Math.round(wDepth));

    // Weekly swing regime
    if (regime) {
      const wRegime = regime.weekly;
      if (wRegime === "uptrend") components.weeklyTrend += 7;
      else if (wRegime === "transition") components.weeklyTrend += 3;
      // downtrend adds 0
    }
  }
  components.weeklyTrend = Math.max(0, Math.min(25, components.weeklyTrend));

  // ── Monthly Trend (20 pts) ──
  const mb = tickerData.monthly_bundle;
  if (mb) {
    // Monthly SuperTrend direction: +7 bullish, -3 bearish
    if (mb.supertrend_dir === 1) components.monthlyTrend += 7;
    else if (mb.supertrend_dir === -1) components.monthlyTrend -= 3;

    // Monthly EMA structure (-1 to +1): map to 0-6 pts
    const mStruct = mb.ema_structure || 0;
    components.monthlyTrend += Math.round((mStruct + 1) * 3); // -1→0, 0→3, +1→6

    // Monthly RSI zone: >50 healthy, <30 deeply oversold (contrarian opportunity)
    const mRsi = mb.rsi;
    if (mRsi != null) {
      if (mRsi >= 60) components.monthlyTrend += 5;
      else if (mRsi >= 50) components.monthlyTrend += 4;
      else if (mRsi >= 40) components.monthlyTrend += 2;
      else if (mRsi < 30 && mb.supertrend_dir === 1) {
        // Deeply oversold but monthly trend still bullish = contrarian buy
        components.monthlyTrend += 3;
      }
    }

    // Monthly EMA depth (0-10): +2 for strong depth
    if (mb.ema_depth >= 8) components.monthlyTrend += 2;
    else if (mb.ema_depth >= 5) components.monthlyTrend += 1;
  }
  components.monthlyTrend = Math.max(0, Math.min(20, components.monthlyTrend));

  // ── Relative Strength (20 pts) ──
  const rsRank = opts.rsRank; // 0-100 percentile
  if (rsRank != null && Number.isFinite(rsRank)) {
    // Map percentile rank to points: top 10% = 20, top 25% = 15, top 50% = 10
    if (rsRank >= 90) components.relativeStrength = 20;
    else if (rsRank >= 75) components.relativeStrength = 15;
    else if (rsRank >= 50) components.relativeStrength = 10;
    else if (rsRank >= 25) components.relativeStrength = 5;
    else components.relativeStrength = 2;
  }

  // ── Accumulation Signal (15 pts) ──
  const accumZone = detectAccumulationZone(tickerData);
  if (accumZone.inZone) {
    components.accumulationSignal = Math.round(accumZone.confidence * 15 / 100);
  }

  // ── Trend Durability (10 pts) ──
  // How long has the weekly trend been intact? Use weekly SuperTrend flip age
  const wCross = tfW?.atr;
  if (wCross) {
    // If weekly SuperTrend is bullish (xs=1) and has been for a while
    if (wCross.xs === 1) {
      // Fresh cross = less durable (just started), established trend = more durable
      // We give base 5 pts for being in a weekly uptrend, +5 if it's established
      components.trendDurability += 5;
      // EMA structure confirms: if weekly structure > 0.5, trend is well-established
      if (emaW && emaW.structure > 0.5) components.trendDurability += 5;
      else if (emaW && emaW.structure > 0) components.trendDurability += 3;
    }
  }
  components.trendDurability = Math.max(0, Math.min(10, components.trendDurability));

  // ── Sector Context (10 pts) ──
  const sectorRsRank = opts.sectorRsRank; // 0-100 percentile for the sector
  if (sectorRsRank != null && Number.isFinite(sectorRsRank)) {
    if (sectorRsRank >= 80) components.sectorContext = 10;
    else if (sectorRsRank >= 60) components.sectorContext = 7;
    else if (sectorRsRank >= 40) components.sectorContext = 4;
    else if (sectorRsRank >= 20) components.sectorContext = 2;
    else components.sectorContext = 0;
  }

  const score = Math.max(0, Math.min(100,
    components.weeklyTrend +
    components.monthlyTrend +
    components.relativeStrength +
    components.accumulationSignal +
    components.trendDurability +
    components.sectorContext
  ));

  return { score: Math.round(score), components, accumZone };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1C: Relative Strength
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute relative strength of a ticker vs SPY.
 *
 * @param {Array<{ts:number, c:number}>} tickerCandles - Daily candles sorted ascending
 * @param {Array<{ts:number, c:number}>} spyCandles - SPY daily candles sorted ascending
 * @returns {{ rs1m: number, rs3m: number, rs6m: number, rsLine: number[], rsNewHigh3m: boolean, rsNewHigh6m: boolean }}
 */
export function computeRelativeStrength(tickerCandles, spyCandles) {
  const result = {
    rs1m: 0, rs3m: 0, rs6m: 0,
    rsLine: [],
    rsNewHigh3m: false,
    rsNewHigh6m: false,
  };

  if (!tickerCandles?.length || !spyCandles?.length) return result;
  if (tickerCandles.length < 21 || spyCandles.length < 21) return result;

  // Build date-aligned price maps
  const spyByDate = new Map();
  for (const c of spyCandles) {
    const dateKey = new Date(c.ts).toISOString().slice(0, 10);
    spyByDate.set(dateKey, c.c);
  }

  // Align ticker candles with SPY dates
  const aligned = [];
  for (const c of tickerCandles) {
    const dateKey = new Date(c.ts).toISOString().slice(0, 10);
    const spyClose = spyByDate.get(dateKey);
    if (spyClose && spyClose > 0 && c.c > 0) {
      aligned.push({ ts: c.ts, ticker: c.c, spy: spyClose, rs: c.c / spyClose });
    }
  }

  if (aligned.length < 21) return result;

  // RS Line: ratio of ticker / SPY over time (normalized to start at 100)
  const base = aligned[0].rs;
  result.rsLine = aligned.map(a => Math.round((a.rs / base) * 10000) / 100); // 100 = baseline

  const n = aligned.length;
  const current = aligned[n - 1];

  // Period returns (relative)
  const periods = [
    { name: "rs1m", days: 21 },
    { name: "rs3m", days: 63 },
    { name: "rs6m", days: 126 },
  ];

  for (const p of periods) {
    const idx = Math.max(0, n - p.days);
    const past = aligned[idx];
    if (past && past.rs > 0) {
      result[p.name] = Math.round(((current.rs / past.rs) - 1) * 10000) / 100; // % change
    }
  }

  // RS New High detection
  const check3m = Math.max(0, n - 63);
  const check6m = Math.max(0, n - 126);
  const currentRS = current.rs;

  let max3m = 0, max6m = 0;
  for (let i = check3m; i < n - 1; i++) {
    if (aligned[i].rs > max3m) max3m = aligned[i].rs;
  }
  for (let i = check6m; i < n - 1; i++) {
    if (aligned[i].rs > max6m) max6m = aligned[i].rs;
  }

  result.rsNewHigh3m = currentRS > max3m && max3m > 0;
  result.rsNewHigh6m = currentRS > max6m && max6m > 0;

  return result;
}

/**
 * Compute RS percentile rank for a ticker among all tickers.
 *
 * @param {number} tickerRS3m - this ticker's 3-month relative strength
 * @param {number[]} allRS3m - all tickers' 3-month relative strengths
 * @returns {number} 0-100 percentile rank
 */
export function computeRSRank(tickerRS3m, allRS3m) {
  if (!allRS3m?.length || !Number.isFinite(tickerRS3m)) return 50;
  const sorted = [...allRS3m].sort((a, b) => a - b);
  let rank = 0;
  for (const v of sorted) {
    if (v <= tickerRS3m) rank++;
    else break;
  }
  return Math.round((rank / sorted.length) * 100);
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1D: Market Health
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute aggregate market health from all ticker data.
 *
 * @param {object[]} allTickerData - array of assembled ticker payloads
 * @param {object} [spyData] - SPY ticker data for regime detection
 * @param {object} [qqqData] - QQQ ticker data for regime detection
 * @returns {{ score: number, regime: string, breadth: object, components: object }}
 */
export function computeMarketHealth(allTickerData, spyData = null, qqqData = null) {
  const components = {
    breadth: 0,      // 0-35 pts
    regimeScore: 0,  // 0-30 pts
    trendMomentum: 0, // 0-20 pts
    sectorHealth: 0,  // 0-15 pts
  };

  if (!allTickerData?.length) {
    return { score: 50, regime: "CAUTIOUS", breadth: {}, components };
  }

  // ── Breadth (35 pts) ──
  // % of tickers above their Weekly EMA(200), % above Daily EMA(50)
  let aboveW200 = 0, aboveD50 = 0, total = 0;
  let weeklyStructSum = 0, weeklyStructCount = 0;

  for (const td of allTickerData) {
    if (!td?.price || td.price <= 0) continue;
    total++;

    // Weekly EMA(200)
    const wEma200 = td.tf_tech?.W?.ema?.depth;
    // EMA depth >= 8 means above most EMAs including 200
    if (wEma200 != null && wEma200 >= 8) aboveW200++;

    // More precise: check if price > weekly ema structure is positive
    const wStruct = td.ema_map?.W?.structure;
    if (wStruct != null && wStruct > 0) aboveW200++; // count both indicators

    // Daily EMA depth >= 5 means above 50-period EMA-equivalent
    const dDepth = td.ema_map?.D?.depth;
    if (dDepth != null && dDepth >= 5) aboveD50++;

    // Collect weekly structure for trend momentum
    if (wStruct != null) {
      weeklyStructSum += wStruct;
      weeklyStructCount++;
    }
  }

  // De-dupe the W200 count (we double-counted above)
  aboveW200 = Math.min(aboveW200, total);

  const breadthW200 = total > 0 ? aboveW200 / total : 0;
  const breadthD50 = total > 0 ? aboveD50 / total : 0;

  // Breadth scoring: healthy market = >60% above W200, >50% above D50
  components.breadth = Math.round(breadthW200 * 20 + breadthD50 * 15);
  components.breadth = Math.max(0, Math.min(35, components.breadth));

  const breadth = {
    aboveWeekly200: aboveW200,
    aboveDaily50: aboveD50,
    total,
    pctAboveW200: Math.round(breadthW200 * 1000) / 10,
    pctAboveD50: Math.round(breadthD50 * 1000) / 10,
  };

  // ── Regime (30 pts) ──
  // Use SPY and QQQ swing regimes
  const spyRegime = spyData?.regime?.combined || "NEUTRAL";
  const qqqRegime = qqqData?.regime?.combined || "NEUTRAL";

  const REGIME_SCORES = {
    STRONG_BULL: 30,
    EARLY_BULL: 24,
    LATE_BULL: 20,
    COUNTER_TREND_BULL: 15,
    NEUTRAL: 12,
    COUNTER_TREND_BEAR: 10,
    EARLY_BEAR: 6,
    LATE_BEAR: 3,
    STRONG_BEAR: 0,
  };

  const spyRegimeScore = REGIME_SCORES[spyRegime] ?? 12;
  const qqqRegimeScore = REGIME_SCORES[qqqRegime] ?? 12;
  components.regimeScore = Math.round((spyRegimeScore * 0.6 + qqqRegimeScore * 0.4));

  // ── Trend Momentum (20 pts) ──
  // Average weekly EMA structure across all tickers
  const avgWeeklyStruct = weeklyStructCount > 0 ? weeklyStructSum / weeklyStructCount : 0;
  // Map -1 to +1 → 0 to 20
  components.trendMomentum = Math.round((avgWeeklyStruct + 1) * 10);
  components.trendMomentum = Math.max(0, Math.min(20, components.trendMomentum));

  // ── Sector Health (15 pts) ──
  // Count how many sectors are bullish (weekly regime uptrend)
  const sectorBullish = new Set();
  const sectorTotal = new Set();
  for (const td of allTickerData) {
    const sector = td._sector;
    if (!sector) continue;
    sectorTotal.add(sector);
    const wStruct = td.ema_map?.W?.structure;
    if (wStruct != null && wStruct > 0.3) sectorBullish.add(sector);
  }
  const sectorBreadth = sectorTotal.size > 0 ? sectorBullish.size / sectorTotal.size : 0;
  components.sectorHealth = Math.round(sectorBreadth * 15);

  const score = Math.max(0, Math.min(100,
    components.breadth + components.regimeScore + components.trendMomentum + components.sectorHealth
  ));

  // Regime label
  let regime = "CAUTIOUS";
  if (score >= 70) regime = "RISK_ON";
  else if (score >= 45) regime = "CAUTIOUS";
  else regime = "RISK_OFF";

  return { score: Math.round(score), regime, breadth, components };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2A: Investor Kanban Stages
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Classify a ticker's investor stage.
 *
 * @param {object} tickerData - assembled ticker payload
 * @param {number} investorScore - 0-100 from computeInvestorScore
 * @param {object|null} existingPosition - open investor position (or null)
 * @param {object} opts - { rsRank, marketHealth, accumZone }
 * @returns {{ stage: string, reason: string }}
 */
export function classifyInvestorStage(tickerData, investorScore, existingPosition = null, opts = {}) {
  const { rsRank = 50, marketHealth = 50, accumZone = null } = opts;
  const mb = tickerData.monthly_bundle;
  const wStDir = tickerData.tf_tech?.W?.atr?.xs;

  // If position is closed or monthly trend invalidated
  if (existingPosition?.status === "CLOSED") {
    return { stage: "exited", reason: "position_closed" };
  }

  // Monthly SuperTrend bearish = thesis invalidation for any position
  if (existingPosition && mb && mb.supertrend_dir === -1) {
    return { stage: "reduce", reason: "monthly_supertrend_bearish" };
  }

  // ── With open position ──
  if (existingPosition) {
    // Reduce: investor score < 50 or weekly SuperTrend bearish or RS rank < 30th pct
    if (investorScore < 50) {
      return { stage: "reduce", reason: "investor_score_low" };
    }
    if (wStDir === -1) {
      return { stage: "reduce", reason: "weekly_supertrend_bearish" };
    }
    if (rsRank < 30) {
      return { stage: "reduce", reason: "rs_rank_declining" };
    }

    // Watch: score dropping (50-65) or RS rank declining
    if (investorScore < 65 || rsRank < 50) {
      return { stage: "watch", reason: investorScore < 65 ? "score_declining" : "rs_rank_moderate" };
    }

    // Core Hold: weekly + monthly trends intact, RS rank > 50th pct
    return { stage: "core_hold", reason: "trends_intact" };
  }

  // ── Without position ──

  // Accumulate: high score + in accumulation zone + market health okay
  if (investorScore >= 65 && accumZone?.inZone && marketHealth >= 40) {
    return { stage: "accumulate", reason: accumZone.zoneType || "accumulation_zone" };
  }

  // Accumulate: very high score even without perfect zone
  if (investorScore >= 80 && marketHealth >= 50) {
    return { stage: "accumulate", reason: "strong_score" };
  }

  // Research: moderate score, worth watching
  if (investorScore >= 40) {
    return { stage: "research", reason: investorScore >= 60 ? "promising" : "monitoring" };
  }

  // Below 40: not interesting for investors right now
  return { stage: "research", reason: "low_score" };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2B: Accumulation Zone Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect if a ticker is in an accumulation zone (good buy zone for investors).
 *
 * @param {object} tickerData - assembled ticker payload
 * @returns {{ inZone: boolean, zoneType: string, confidence: number, signals: string[] }}
 */
export function detectAccumulationZone(tickerData) {
  const signals = [];
  let confidence = 0;

  const price = tickerData.price;
  const mb = tickerData.monthly_bundle;
  const tfW = tickerData.tf_tech?.W;
  const emaW = tickerData.ema_map?.W;
  const emaD = tickerData.ema_map?.D;

  if (!price || price <= 0) {
    return { inZone: false, zoneType: "none", confidence: 0, signals: [] };
  }

  // ── Weekly Support Confluence ──
  // Price within 3% of Weekly EMA(200)
  if (mb?.ema200 && mb.ema200 > 0) {
    const distFromM200 = Math.abs(price - mb.ema200) / mb.ema200;
    if (distFromM200 < 0.05) {
      signals.push("near_monthly_ema200");
      confidence += 20;
    }
  }

  // Weekly SuperTrend support proximity
  const wStLine = tickerData.st_support?.W;
  if (wStLine && wStLine > 0) {
    const distFromWST = Math.abs(price - wStLine) / wStLine;
    if (distFromWST < 0.03) {
      signals.push("near_weekly_supertrend");
      confidence += 25;
    }
  }

  // ── Oversold Bounce Setup ──
  // Weekly RSI < 40 while Monthly RSI > 45 (monthly trend intact, weekly oversold)
  const wRsi = tfW?.rsi?.r5;
  const mRsi = mb?.rsi;
  if (wRsi != null && mRsi != null) {
    if (wRsi < 40 && mRsi > 45) {
      signals.push("weekly_oversold_monthly_intact");
      confidence += 30;
    } else if (wRsi < 35) {
      signals.push("weekly_deeply_oversold");
      confidence += 20;
    }
  }

  // ── Volume Confirmation ──
  // Use fuel gauge as proxy for volume activity
  const dFuel = tickerData.fuel?.D;
  if (dFuel && dFuel.total > 70) {
    signals.push("strong_fuel");
    confidence += 10;
  }

  // ── EMA Reclaim ──
  // Weekly EMA momentum turning positive while structure is positive = reclaim
  if (emaW) {
    if (emaW.structure > 0.3 && emaW.momentum > -0.2 && emaW.momentum < 0.3) {
      // Structure still bullish but momentum just starting to turn up
      signals.push("weekly_ema_reclaim");
      confidence += 15;
    }
  }

  // ── Monthly trend confirmation bonus ──
  if (mb && mb.supertrend_dir === 1 && mb.ema_structure > 0) {
    confidence += 10;
    signals.push("monthly_trend_bullish");
  }

  confidence = Math.max(0, Math.min(100, confidence));
  const inZone = confidence >= 40 && signals.length >= 2;
  const zoneType = signals.length > 0 ? signals[0] : "none";

  return { inZone, zoneType, confidence, signals };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2C: Thesis Tracking
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Auto-generate an investment thesis for a ticker based on current conditions.
 *
 * @param {object} tickerData - assembled ticker payload
 * @param {number} rsRank - relative strength percentile rank
 * @returns {{ thesis: string, invalidation: string[], criteria: object }}
 */
export function generateThesis(tickerData, rsRank = 50) {
  const mb = tickerData.monthly_bundle;
  const emaW = tickerData.ema_map?.W;
  const tfW = tickerData.tf_tech?.W;
  const ticker = tickerData.ticker || "???";

  const conditions = [];
  const invalidation = [];

  // Monthly trend
  if (mb?.supertrend_dir === 1) {
    conditions.push("Monthly uptrend");
    invalidation.push("Monthly SuperTrend flips bearish");
  } else if (mb?.supertrend_dir === -1) {
    conditions.push("Monthly downtrend (caution)");
  }

  // Weekly EMA position
  if (emaW?.structure > 0.5) {
    conditions.push("Above Weekly EMA(200)");
    invalidation.push("Price closes below Weekly EMA(200)");
  }

  // Weekly SuperTrend
  if (tfW?.atr?.xs === 1) {
    conditions.push("Weekly SuperTrend bullish");
    invalidation.push("Weekly SuperTrend flips bearish");
  }

  // RS Rank
  if (rsRank >= 75) {
    conditions.push(`RS Rank top ${100 - rsRank}%`);
    invalidation.push("RS Rank drops below 30th percentile");
  } else if (rsRank >= 50) {
    conditions.push(`RS Rank ${rsRank}th percentile`);
    invalidation.push("RS Rank drops below 25th percentile");
  }

  // Monthly RSI
  if (mb?.rsi) {
    if (mb.rsi >= 50) conditions.push(`Monthly RSI ${mb.rsi.toFixed(0)} (healthy)`);
    else if (mb.rsi < 35) conditions.push(`Monthly RSI ${mb.rsi.toFixed(0)} (oversold — contrarian)`);
  }

  const thesis = conditions.length > 0
    ? `${ticker}: ${conditions.join(", ")}`
    : `${ticker}: Insufficient data for thesis`;

  return {
    thesis,
    invalidation,
    criteria: {
      monthlyST: mb?.supertrend_dir === 1,
      weeklyAbove200: emaW?.structure > 0.5,
      weeklyST: tfW?.atr?.xs === 1,
      rsRank,
    },
  };
}

/**
 * Check if an existing thesis has been invalidated.
 *
 * @param {object} thesisCriteria - criteria from generateThesis
 * @param {object} currentTickerData - current ticker payload
 * @param {number} currentRsRank - current RS rank
 * @returns {{ invalidated: boolean, reasons: string[] }}
 */
export function checkThesisHealth(thesisCriteria, currentTickerData, currentRsRank = 50) {
  const reasons = [];
  const mb = currentTickerData.monthly_bundle;
  const emaW = currentTickerData.ema_map?.W;
  const tfW = currentTickerData.tf_tech?.W;

  // Monthly SuperTrend flip
  if (thesisCriteria.monthlyST && mb?.supertrend_dir === -1) {
    reasons.push("Monthly SuperTrend flipped bearish");
  }

  // Weekly EMA(200) lost
  if (thesisCriteria.weeklyAbove200 && emaW?.structure < -0.3) {
    reasons.push("Price fell below Weekly EMA(200)");
  }

  // Weekly SuperTrend flip
  if (thesisCriteria.weeklyST && tfW?.atr?.xs === -1) {
    reasons.push("Weekly SuperTrend flipped bearish");
  }

  // RS Rank collapse
  if (thesisCriteria.rsRank >= 50 && currentRsRank < 25) {
    reasons.push(`RS Rank collapsed from ${thesisCriteria.rsRank} to ${currentRsRank}`);
  }

  return { invalidated: reasons.length > 0, reasons };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: Portfolio Analytics
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Compute portfolio-level analytics for investor positions.
 *
 * @param {object[]} positions - open positions [{ ticker, direction, shares, avgEntry, mark, unrealizedPnl }]
 * @param {object} sectorMap - { AAPL: "Technology", ... }
 * @param {object} opts - { investorScores: { AAPL: 78, ... }, rsRanks: { AAPL: 85, ... } }
 * @returns {object} portfolio analytics
 */
export function computePortfolioAnalytics(positions, sectorMap, opts = {}) {
  const { investorScores = {}, rsRanks = {} } = opts;

  if (!positions?.length) {
    return {
      sectorAllocation: {},
      concentrationRisk: { top3Pct: 0, herfindahl: 0, rating: "N/A" },
      diversificationScore: 0,
      positionHealth: [],
      totalValue: 0,
      cashPct: 100,
    };
  }

  // Total portfolio value
  const totalValue = positions.reduce((sum, p) => sum + (p.shares * p.mark), 0);

  // Sector allocation
  const sectorAllocation = {};
  const positionWeights = [];

  for (const p of positions) {
    const sector = sectorMap[p.ticker] || "Unknown";
    const value = p.shares * p.mark;
    const weight = totalValue > 0 ? value / totalValue : 0;

    positionWeights.push(weight);

    if (!sectorAllocation[sector]) {
      sectorAllocation[sector] = { value: 0, weight: 0, tickers: [] };
    }
    sectorAllocation[sector].value += value;
    sectorAllocation[sector].weight += weight;
    sectorAllocation[sector].tickers.push(p.ticker);
  }

  // Round sector weights
  for (const s of Object.values(sectorAllocation)) {
    s.weight = Math.round(s.weight * 1000) / 10;
    s.value = Math.round(s.value * 100) / 100;
  }

  // Concentration risk
  const sortedWeights = [...positionWeights].sort((a, b) => b - a);
  const top3Pct = Math.round(sortedWeights.slice(0, 3).reduce((s, w) => s + w, 0) * 1000) / 10;
  const herfindahl = Math.round(positionWeights.reduce((s, w) => s + w * w, 0) * 10000) / 100;

  let concentrationRating = "GOOD";
  if (top3Pct > 60) concentrationRating = "HIGH_RISK";
  else if (top3Pct > 45) concentrationRating = "MODERATE";

  // Diversification score (0-100)
  const sectorCount = Object.keys(sectorAllocation).length;
  const posCount = positions.length;
  const sectorDiversity = Math.min(30, sectorCount * 5); // Max 30 pts for 6+ sectors
  const positionDiversity = Math.min(30, posCount * 3);   // Max 30 pts for 10+ positions
  const concentrationPenalty = top3Pct > 50 ? Math.round((top3Pct - 50) * 0.8) : 0;
  const diversificationScore = Math.max(0, Math.min(100,
    sectorDiversity + positionDiversity + (100 - herfindahl) * 0.4 - concentrationPenalty
  ));

  // Position health
  const positionHealth = positions.map(p => ({
    ticker: p.ticker,
    direction: p.direction,
    pnlPct: p.unrealizedPnlPct || (p.mark && p.avgEntry ? ((p.mark - p.avgEntry) / p.avgEntry * 100) : 0),
    investorScore: investorScores[p.ticker] || null,
    rsRank: rsRanks[p.ticker] || null,
    sector: sectorMap[p.ticker] || "Unknown",
    weight: totalValue > 0 ? Math.round((p.shares * p.mark / totalValue) * 1000) / 10 : 0,
  }));

  return {
    sectorAllocation,
    concentrationRisk: { top3Pct, herfindahl, rating: concentrationRating },
    diversificationScore: Math.round(diversificationScore),
    positionHealth,
    totalValue: Math.round(totalValue * 100) / 100,
  };
}

/**
 * Generate rebalancing suggestions based on portfolio state and scores.
 *
 * @param {object} analytics - from computePortfolioAnalytics
 * @param {number} marketHealth - 0-100
 * @param {object} allInvestorScores - { AAPL: 78, GOOGL: 82, ... }
 * @param {object} allAccumZones - { AAPL: { inZone: true, ... }, ... }
 * @param {object} sectorMap - { AAPL: "Technology", ... }
 * @returns {object[]} suggestions
 */
export function generateRebalancingSuggestions(analytics, marketHealth, allInvestorScores, allAccumZones, sectorMap) {
  const suggestions = [];

  if (!analytics?.positionHealth?.length) return suggestions;

  // ── Overweight alerts ──
  for (const ph of analytics.positionHealth) {
    if (ph.weight > 12) {
      suggestions.push({
        type: "overweight",
        ticker: ph.ticker,
        message: `${ph.ticker} is ${ph.weight}% of portfolio (consider reducing to ~8%).`,
        priority: ph.weight > 20 ? "high" : "medium",
      });
    }
  }

  // ── Sector concentration alerts ──
  for (const [sector, data] of Object.entries(analytics.sectorAllocation)) {
    if (data.weight > 35) {
      suggestions.push({
        type: "sector_concentration",
        sector,
        message: `${sector} is ${data.weight}% of portfolio (${data.tickers.join(", ")}). Consider diversifying.`,
        priority: data.weight > 50 ? "high" : "medium",
      });
    }
  }

  // ── Quality upgrade suggestions ──
  const weakPositions = analytics.positionHealth
    .filter(ph => (ph.investorScore || 0) < 40 || (ph.rsRank || 0) < 20)
    .sort((a, b) => (a.investorScore || 0) - (b.investorScore || 0));

  // Find strong candidates not in portfolio
  const heldTickers = new Set(analytics.positionHealth.map(ph => ph.ticker));
  const strongCandidates = Object.entries(allInvestorScores)
    .filter(([t, s]) => !heldTickers.has(t) && s >= 75)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  for (const weak of weakPositions.slice(0, 2)) {
    if (strongCandidates.length > 0) {
      const [strongTicker, strongScore] = strongCandidates[0];
      suggestions.push({
        type: "quality_upgrade",
        from: weak.ticker,
        to: strongTicker,
        message: `Consider swapping ${weak.ticker} (Score ${weak.investorScore || "??"}) for ${strongTicker} (Score ${strongScore}).`,
        priority: "low",
      });
    }
  }

  // ── Sector gaps ──
  const heldSectors = new Set(Object.keys(analytics.sectorAllocation));
  const allSectors = new Set(Object.values(sectorMap));
  for (const sector of allSectors) {
    if (heldSectors.has(sector)) continue;
    // Find top candidates in this sector
    const candidates = Object.entries(allInvestorScores)
      .filter(([t, s]) => sectorMap[t] === sector && s >= 65)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    if (candidates.length > 0) {
      suggestions.push({
        type: "sector_gap",
        sector,
        message: `No ${sector} exposure. Consider: ${candidates.map(([t, s]) => `${t} (Score ${s})`).join(", ")}.`,
        priority: "low",
      });
    }
  }

  // ── Cash deployment ──
  if (marketHealth >= 60) {
    const accumCandidates = Object.entries(allAccumZones)
      .filter(([t, z]) => z?.inZone && !heldTickers.has(t))
      .map(([t, z]) => ({ ticker: t, score: allInvestorScores[t] || 0, zone: z }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (accumCandidates.length > 0) {
      suggestions.push({
        type: "cash_deployment",
        message: `Market Health ${marketHealth} (RISK_ON). Top accumulation candidates: ${accumCandidates.map(c => `${c.ticker} (${c.score})`).join(", ")}.`,
        priority: "medium",
        candidates: accumCandidates.map(c => c.ticker),
      });
    }
  }

  return suggestions;
}
