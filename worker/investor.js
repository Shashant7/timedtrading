import {
  computeTimingOverlay,
  detectExhaustionWarnings as _detectExhaustionWarningsFromTiming,
} from "./timing-signals.js";

// ─────────────────────────────────────────────────────────────────────────────
// Investor Intelligence Module
//
// Parallel scoring and analysis layer for long-term investors.
// Operates on Weekly/Monthly timeframes with multi-week to multi-month horizons.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3.9d (2026-05-10) — tunable stage-classification thresholds.
//
// Forensic dry-run on canonical Phase C `direction_accuracy` (517 trades on
// 14-ticker blueprint cohort, see tasks/phase-c/INVESTOR_FORENSIC_DRY_RUN_2026-05-10.md)
// showed the strong-score → accumulate gate at >= 70 was 5-10 pts too high
// for momentum-runner cohorts: 51% of trades scored 60-69 (just shy), 0%
// hit 80+. Lowering to 65 converts ~half of the 60-69 watch population
// to accumulate, capturing tickers like PLTR (avg 59, 0/49 accumulate)
// and TSM (avg 62.5, 0/24 accumulate) the gate was missing entirely.
//
// All thresholds are overridable via daCfg keys for live A/B without
// redeploys (mirror of TH config pattern in worker/trend-hold.js).
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_INVESTOR_CONFIG = Object.freeze({
  // 2026-06-01 — Bumped 65 → 70 to tighten the Accumulate lane after a
  // user report that the lane was showing ~90 candidates in a healthy
  // regime. The simulator can only act on 15 (INVESTOR_MAX_POSITIONS),
  // so a wider lane is operator-noise not engine-noise. 70 was the
  // original pre-3.9d hardcoded floor; we re-adopt it as the default
  // and keep `deep_audit_investor_accumulate_strong_score_min` as the
  // live-tunable override (operator can drop to 60-65 if they want the
  // Forensic-style broader catch for backtest cohorts).
  accumulate_strong_score_min: 70,                    // was 65 (was 70 hardcoded pre-3.9d)
  accumulate_strong_score_market_health_min: 40,      // unchanged
  accumulate_inzone_score_min: 30,                    // unchanged
  accumulate_inzone_market_health_min: 30,            // unchanged
  watch_score_min: 50,                                // unchanged
  watch_promising_score_min: 60,                      // unchanged
  research_on_watch_score_min: 40,                    // unchanged
  research_low_score_min: 30,                         // unchanged

  // Phase 3.9e (2026-05-11) — Momentum-runner accumulation-zone detection.
  //
  // The pre-Phase-3.9e detectAccumulationZone was 100% mean-reversion
  // oriented (near EMA200 / weekly ST support / oversold RSI / TD buyer
  // exhaustion / Saty ACCUMULATION phase). Forensic dry-run found this
  // averaged 0.4 of 15 possible contribution on momentum-runner cohorts —
  // detectors NEVER fire on names like SNDK (avg score 47.8 despite +388%
  // return), GEV, MU, BE because they're mid-trend, not oversold.
  //
  // Phase 3.9e adds a parallel momentum-runner branch that recognizes
  // healthy mid-trend conditions: above weekly+daily EMA21, monthly bull,
  // weekly RSI in healthy band (not oversold, not exhausted), daily RSI
  // above neutral. Each criterion contributes confidence; meeting >=
  // momentum_runner_min_signals fires inZone=true with zoneType='momentum_runner'.
  accum_zone_momentum_runner_enabled: true,
  accum_zone_momentum_runner_min_signals: 5,           // of 6 primary criteria — 5 chosen to filter noise; can tune to 4 for broader catch
  accum_zone_momentum_runner_min_confidence: 50,       // 10pt step above oversold branch (40) for selectivity
  accum_zone_momentum_runner_weekly_rsi_min: 50,       // healthy zone floor
  accum_zone_momentum_runner_weekly_rsi_max: 88,       // exhaustion gate
});

/**
 * Load runtime investor config with daCfg overrides. Mirror of
 * loadTrendHoldConfig in worker/trend-hold.js. Bounds-checked.
 *
 * Tunable keys (deep_audit_investor_*):
 *   - deep_audit_investor_accumulate_strong_score_min  (1-99, default 70 — was 65)
 *   - deep_audit_investor_watch_score_min              (1-99, default 50)
 *   - deep_audit_investor_research_on_watch_score_min  (1-99, default 40)
 *
 * The remaining thresholds are kept in the config object for future
 * tuning but are not exposed via daCfg yet (lower priority per Phase
 * 3.9d findings).
 */
export function loadInvestorConfig(daCfg) {
  const cfg = { ...DEFAULT_INVESTOR_CONFIG };
  if (!daCfg || typeof daCfg !== "object") return cfg;
  const strong = Number(daCfg.deep_audit_investor_accumulate_strong_score_min);
  if (Number.isFinite(strong) && strong > 0 && strong < 100) {
    cfg.accumulate_strong_score_min = strong;
  }
  const watch = Number(daCfg.deep_audit_investor_watch_score_min);
  if (Number.isFinite(watch) && watch > 0 && watch < 100) {
    cfg.watch_score_min = watch;
  }
  const research = Number(daCfg.deep_audit_investor_research_on_watch_score_min);
  if (Number.isFinite(research) && research > 0 && research < 100) {
    cfg.research_on_watch_score_min = research;
  }
  // Phase 3.9e — momentum-runner zone overrides
  const mrEnabled = daCfg.deep_audit_investor_accum_zone_momentum_runner_enabled;
  if (mrEnabled === true || mrEnabled === false) {
    cfg.accum_zone_momentum_runner_enabled = mrEnabled;
  } else if (typeof mrEnabled === "string") {
    if (mrEnabled === "true") cfg.accum_zone_momentum_runner_enabled = true;
    else if (mrEnabled === "false") cfg.accum_zone_momentum_runner_enabled = false;
  }
  const mrMinSig = Number(daCfg.deep_audit_investor_accum_zone_momentum_runner_min_signals);
  if (Number.isFinite(mrMinSig) && mrMinSig >= 1 && mrMinSig <= 10) {
    cfg.accum_zone_momentum_runner_min_signals = mrMinSig;
  }
  const mrMinConf = Number(daCfg.deep_audit_investor_accum_zone_momentum_runner_min_confidence);
  if (Number.isFinite(mrMinConf) && mrMinConf >= 0 && mrMinConf <= 100) {
    cfg.accum_zone_momentum_runner_min_confidence = mrMinConf;
  }
  const mrRsiMin = Number(daCfg.deep_audit_investor_accum_zone_momentum_runner_weekly_rsi_min);
  if (Number.isFinite(mrRsiMin) && mrRsiMin >= 0 && mrRsiMin <= 100) {
    cfg.accum_zone_momentum_runner_weekly_rsi_min = mrRsiMin;
  }
  const mrRsiMax = Number(daCfg.deep_audit_investor_accum_zone_momentum_runner_weekly_rsi_max);
  if (Number.isFinite(mrRsiMax) && mrRsiMax >= 0 && mrRsiMax <= 100) {
    cfg.accum_zone_momentum_runner_weekly_rsi_max = mrRsiMax;
  }
  return cfg;
}

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
 *   - Daily SuperTrend Alignment (up to +5 bonus pts)
 *
 * @param {object} tickerData - assembled ticker payload from assembleTickerData
 * @param {object} opts - { rsRank, sectorRsRank, marketHealth, sectorMap }
 * @returns {{ score: number, components: object }}
 */
export function computeInvestorScore(tickerData, opts = {}) {
  const _scoreCfg = opts.cfg || DEFAULT_INVESTOR_CONFIG;
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
    // V15 P0.7.110 (2026-05-08) — Phase 3 fix: monthly_bundle.supertrend_dir
    // uses PINE convention (-1 = bull, +1 = bear), same as every other stDir
    // in the worker. Verified empirically against day-state KV: AAPL/MSFT/
    // SPY/QQQ/NVDA/META/GOOGL all show supertrend_dir = -1 on Jul 1 2025
    // (clear monthly bull). The misleading "1 = bullish" comment at
    // worker/indicators.js:5050 is a code-comment bug — bM.stDir comes from
    // the same Pine SuperTrend pipeline as tf_tech.{D,W,4H,M}.stDir.
    //
    // Pre-fix this scoring logic was INVERTED: real bull markets got the
    // -3 bear penalty instead of the +7 bull bonus, suppressing every
    // ticker's investor score by 10 pts. As a result no ticker reached the
    // accumulate-stage threshold and runInvestorDailyReplay returned
    // opened=0 for every day in the Phase C Jul→May window — the original
    // "investor-replay returns opened=0" blocker documented in the handoff.
    if (mb.supertrend_dir === -1) components.monthlyTrend += 7;        // Pine bull
    else if (mb.supertrend_dir === 1) components.monthlyTrend -= 3;    // Pine bear

    // Monthly EMA structure (-1 to +1): map to 0-6 pts
    const mStruct = mb.ema_structure || 0;
    components.monthlyTrend += Math.round((mStruct + 1) * 3); // -1→0, 0→3, +1→6

    // Monthly RSI zone: >50 healthy, <30 deeply oversold (contrarian opportunity)
    const mRsi = mb.rsi;
    if (mRsi != null) {
      if (mRsi >= 60) components.monthlyTrend += 5;
      else if (mRsi >= 50) components.monthlyTrend += 4;
      else if (mRsi >= 40) components.monthlyTrend += 2;
      else if (mRsi < 30 && mb.supertrend_dir === -1) {
        // Deeply oversold but monthly trend still bullish (Pine -1) = contrarian buy
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
  const accumZone = detectAccumulationZone(tickerData, _scoreCfg);
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

  // ── v3: Ichimoku Confirmation (bonus up to +15, penalty up to -10) ──
  components.ichimokuConfirm = 0;
  const ichW = tickerData?.ichimoku_w;
  const ichM = tickerData?.ichimoku_map?.M;
  if (ichW) {
    if (ichW.priceVsCloud === "above") components.ichimokuConfirm += 4;
    else if (ichW.priceVsCloud === "inside") components.ichimokuConfirm -= 2;
    else if (ichW.priceVsCloud === "below") components.ichimokuConfirm -= 5;

    if (ichW.cloudBullish) components.ichimokuConfirm += 2;
    else components.ichimokuConfirm -= 1;

    const ct = ichW.cloudThickness || 0;
    if (ct > 1.0) components.ichimokuConfirm += 2;
    else if (ct < 0.3) components.ichimokuConfirm -= 2;

    const ks = Math.abs(ichW.kijunSlope || 0);
    if (ks > 0.2) components.ichimokuConfirm += 2;
    else if (ks < 0.05) components.ichimokuConfirm -= 1;

    if (ichW.tkCross === "bullish") components.ichimokuConfirm += 3;
    else if (ichW.tkCross === "bearish") components.ichimokuConfirm -= 2;
  }
  if (ichM) {
    if (ichM.priceVsCloud === "above") components.ichimokuConfirm += 2;
    else if (ichM.priceVsCloud === "below") components.ichimokuConfirm -= 3;

    if (ichM.cloudBullish) components.ichimokuConfirm += 1;
  }
  components.ichimokuConfirm = Math.max(-10, Math.min(15, components.ichimokuConfirm));

  // ── Momentum Health adjustment (-10 to +5 pts) ──
  // Penalize exhaustion/divergence, reward accumulation phase timing
  components.momentumHealth = 0;
  const _rsiDivW = tickerData?.rsi_divergence?.W || tickerData?.tf_tech?.W?.rsiDiv;
  const _rsiDivD = tickerData?.rsi_divergence?.D || tickerData?.tf_tech?.D?.rsiDiv;
  if (_rsiDivW?.bear?.active) components.momentumHealth -= 8;

  // bearish_prep counts while price RISES → buyer exhaustion → rally may top out
  const _tdPerTf = tickerData?.td_sequential?.per_tf;
  const _tdW = _tdPerTf?.W || _tdPerTf?.["1W"];
  const _tdD = _tdPerTf?.D || _tdPerTf?.["1D"];
  if ((_tdW?.bearish_prep_count >= 7) || (_tdD?.bearish_prep_count >= 7)) components.momentumHealth -= 5;

  const _satyW = tickerData?.tf_tech?.W?.saty;
  if (_satyW) {
    const wPhaseVal = Number(_satyW.v) || 0;
    const wPhaseZone = _satyW.z || "";
    if (wPhaseZone === "DISTRIBUTION" || (wPhaseVal > 80 && _satyW.l)) components.momentumHealth -= 3;
    if (wPhaseZone === "ACCUMULATION" || (wPhaseVal < -80 && _satyW.l)) components.momentumHealth += 5;
  }

  const _emaRegD = Number(tickerData?.ema_regime_daily) || 0;
  if (_emaRegD <= -2) components.momentumHealth -= 4;

  components.momentumHealth = Math.max(-10, Math.min(5, components.momentumHealth));

  // ── Daily SuperTrend Alignment (bonus up to +5 pts) ──
  components.dailySuperTrendBonus = 0;
  const dStDir = tickerData?.tf_tech?.D?.stDir;
  const wStDirRaw = tickerData?.tf_tech?.W?.stDir;
  if (dStDir === -1) {
    // Daily SuperTrend bullish (Pine convention: -1 = bullish)
    if (wStDirRaw === -1) {
      components.dailySuperTrendBonus = 5; // D+W both bullish
    } else {
      components.dailySuperTrendBonus = 3; // D bullish, W neutral/bearish
    }
  }

  const score = Math.max(0, Math.min(100,
    components.weeklyTrend +
    components.monthlyTrend +
    components.relativeStrength +
    components.accumulationSignal +
    components.trendDurability +
    components.sectorContext +
    components.ichimokuConfirm +
    components.momentumHealth +
    components.dailySuperTrendBonus
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
/**
 * Pre-compute Kanban action tier for Accumulate / Reduce lanes.
 * Surfaces which names are execution-ready vs lane-label-only when a lane
 * has dozens of cards (operator report: ~79 in Accumulate).
 *
 * Tiers (sort priority: act_now → ready → monitor → stale):
 *   act_now  — Buy zone + SuperTrend alignment (simulator gate passed)
 *   ready    — simEligible OR in-zone with strong score (≥65)
 *   monitor  — Lane signal only; auto-rebalance may still queue by score
 *   stale    — Owned; signal active >7d without a matching lot action
 */
/**
 * Resolve timing overlay for investor stage gating (uses baked snapshot or computes).
 */
export function resolveInvestorTimingOverlay(tickerData) {
  if (!tickerData || typeof tickerData !== "object") return null;
  if (tickerData.timing_overlay && typeof tickerData.timing_overlay === "object") {
    return tickerData.timing_overlay;
  }
  try {
    return computeTimingOverlay(tickerData, tickerData.confluence_verdict || null);
  } catch (_) {
    return null;
  }
}

/**
 * Timed Trading investor gate — tops block new adds; bottoms boost accumulate-on-dips.
 * Thesis-invalidating reduce paths are never overridden.
 */
export function applyInvestorTimingGate(stageResult, timing, ctx = {}) {
  if (!stageResult || !timing) return stageResult;
  const primary = timing.timing_primary || null;
  if (!primary) return stageResult;

  const {
    existingPosition = null,
    investorScore = 0,
    accumZone = null,
    marketHealth = 50,
    cfg = DEFAULT_INVESTOR_CONFIG,
  } = ctx;

  const stage = String(stageResult.stage || "");
  const owned = !!existingPosition;

  if (primary === "TOP") {
    if (!owned && stage === "accumulate") {
      return {
        stage: "watch",
        reason: `timing_top_block_new_entry:${stageResult.reason}`,
        timing_primary: "TOP",
        timing_playbook: "TIME_TOP",
      };
    }
    if (owned && stage === "core_hold") {
      return {
        stage: "watch",
        reason: `timing_top_hold_no_adds:${stageResult.reason}`,
        timing_primary: "TOP",
        timing_playbook: "TIME_TOP",
      };
    }
    if (stage === "watch" || stage === "reduce") {
      return {
        ...stageResult,
        reason: String(stageResult.reason || "").startsWith("timing_top")
          ? stageResult.reason
          : `timing_top:${stageResult.reason}`,
        timing_primary: "TOP",
        timing_playbook: "TIME_TOP",
      };
    }
    return { ...stageResult, timing_primary: "TOP", timing_playbook: "TIME_TOP" };
  }

  if (primary === "BOTTOM") {
    if (!owned && stage === "watch"
      && investorScore >= cfg.watch_promising_score_min
      && marketHealth >= cfg.accumulate_inzone_market_health_min
      && (timing.add_on_dips || accumZone?.inZone)) {
      return {
        stage: "accumulate",
        reason: accumZone?.inZone
          ? `timing_bottom_accumulate_on_dips:${accumZone.zoneType || "compression"}`
          : "timing_bottom_promising_accumulate",
        timing_primary: "BOTTOM",
        timing_playbook: "TIME_BOTTOM",
      };
    }
    if (!owned && stage === "accumulate") {
      return {
        ...stageResult,
        reason: `timing_bottom_confirmed:${stageResult.reason}`,
        timing_primary: "BOTTOM",
        timing_playbook: "TIME_BOTTOM",
      };
    }
    if (owned && stage === "watch" && investorScore >= cfg.watch_score_min) {
      return {
        stage: "core_hold",
        reason: `timing_bottom_hold_add_on_dips:${stageResult.reason}`,
        timing_primary: "BOTTOM",
        timing_playbook: "TIME_BOTTOM",
      };
    }
    return { ...stageResult, timing_primary: "BOTTOM", timing_playbook: "TIME_BOTTOM" };
  }

  return stageResult;
}

export function computeInvestorActionTier(row) {
  const stage = String(row?.stage || "");
  if (stage !== "accumulate" && stage !== "reduce") return null;

  const owned = !!(row?.position?.owned);
  const simEligible = row?.simEligible === true;
  const inZone = !!(row?.accumZone?.inZone);
  const score = Number(row?.score) || 0;

  const STALE_MS = 7 * 24 * 3600 * 1000;
  const lastActionTs = Number(row?.position?.last_action_ts) || 0;
  const lastActionType = String(row?.position?.last_action_type || "");
  const lastAgoMs = lastActionTs > 0 ? Date.now() - lastActionTs : 0;
  const isStale = owned && lastActionTs > 0 && lastAgoMs > STALE_MS && (
    (stage === "reduce" && lastActionType !== "SELL") ||
    (stage === "accumulate" && !["BUY", "DCA_BUY"].includes(lastActionType))
  );
  if (isStale) return "stale";

  if (stage === "accumulate") {
    if (inZone && simEligible) return "act_now";
    if (simEligible || (inZone && score >= 65)) return "ready";
    return "monitor";
  }

  // reduce — owned positions only reach this lane in the UI
  if (simEligible) return "act_now";
  if (owned) return "ready";
  return "monitor";
}

export function classifyInvestorStage(tickerData, investorScore, existingPosition = null, opts = {}) {
  const { rsRank = 50, marketHealth = 50, accumZone = null, cfg = DEFAULT_INVESTOR_CONFIG } = opts;
  const timing = resolveInvestorTimingOverlay(tickerData);
  const finalize = (result) => applyInvestorTimingGate(result, timing, {
    existingPosition, investorScore, accumZone, marketHealth, cfg,
  });
  const mb = tickerData.monthly_bundle;
  const wStDir = tickerData.tf_tech?.W?.atr?.xs;
  // 2026-06-01 — Surface tf_tech.D / tf_tech.W at function scope so the
  // exhaustion gate (added below for momentum_runner downgrade) can read
  // TD9 setup_count + Phase zone + RSI without a separate optional-chain
  // dance at every reference. Previously caused 'tfD is not defined'
  // ReferenceError that aborted the entire /timed/investor/compute run.
  const tfD = tickerData.tf_tech?.D;
  const tfW = tickerData.tf_tech?.W;

  // If position is closed or monthly trend invalidated
  if (existingPosition?.status === "CLOSED") {
    return finalize({ stage: "exited", reason: "position_closed" });
  }

  // Monthly SuperTrend bearish (Pine +1) = thesis invalidation for any position
  if (existingPosition && mb && mb.supertrend_dir === 1) {
    return finalize({ stage: "reduce", reason: "monthly_supertrend_bearish" });
  }

  // ── v3: Regime + Ichimoku enrichment ──
  const tickerRegime = String(tickerData?.regimeVocabulary?.executionRegimeClass || tickerData?.regime_class || "");
  const ichW = tickerData?.ichimoku_w;

  // ── With open position ──
  if (existingPosition) {
    const posEntry = Number(existingPosition.entry_price || existingPosition.avg_entry || 0);
    const curPrice = Number(tickerData?.price || 0);
    const posPnlPct = posEntry > 0 && curPrice > 0 ? ((curPrice - posEntry) / posEntry) * 100 : 0;

    // v3: CHOPPY regime + significant loss → exit earlier
    // Relaxed from -5% to -8% to avoid premature exits on normal pullbacks
    if (tickerRegime === "CHOPPY" && posPnlPct < -8) {
      return finalize({ stage: "reduce", reason: "choppy_regime_losing" });
    }

    // v3: Weekly Ichimoku price inside cloud + meaningful loss → reduce (trend uncertain)
    // Added -3% threshold to prevent exit on minor dips while in cloud
    if (ichW?.priceVsCloud === "inside" && posPnlPct < -3) {
      return finalize({ stage: "reduce", reason: "weekly_ichimoku_inside_cloud" });
    }

    // Reduce: investor score < 30 or weekly SuperTrend bearish or RS rank < 20th pct
    // Backtest fix: previous threshold of 40 caused immediate 1-day churn. Positions entered
    // at 70+ score, then daily fluctuations dropped them below 40 the next day → instant sell.
    // Lowered all thresholds significantly and require weekly/monthly confirmation for sells.
    // The 2-consecutive-reduce-days gate in runInvestorDailyReplay provides additional protection.
    if (investorScore < 30 && wStDir !== 1) {
      return finalize({ stage: "reduce", reason: "investor_score_very_low" });
    }
    // wStDir is tf_tech.W.atr.xs (STANDARD convention: +1=bull, -1=bear).
    // mb.supertrend_dir is monthly_bundle.supertrend_dir (PINE convention: -1=bull).
    // "weekly bear AND monthly NOT bull" → reduce. Pine "not bull" = !== -1.
    if (wStDir === -1 && mb?.supertrend_dir !== -1) {
      return finalize({ stage: "reduce", reason: "weekly_supertrend_bearish" });
    }
    if (rsRank < 20 && investorScore < 40) {
      return finalize({ stage: "reduce", reason: "rs_rank_declining" });
    }

    // v3: CHOPPY regime with weak Weekly Ichimoku → downgrade to watch
    if (tickerRegime === "CHOPPY" && ichW?.priceVsCloud !== "above") {
      return finalize({ stage: "watch", reason: "choppy_regime_ichimoku_weak" });
    }

    // Watch: score dropping (50-65) or RS rank declining
    if (investorScore < 65 || rsRank < 50) {
      // BUT: if weekly bullish divergence is active, selling pressure is weakening — hold, don't downgrade
      const _stgDivW = tickerData?.rsi_divergence?.W || tickerData?.tf_tech?.W?.rsiDiv;
      if (_stgDivW?.bull?.active && investorScore >= 50) {
        return finalize({ stage: "core_hold", reason: "bullish_divergence_hold" });
      }
      return finalize({ stage: "watch", reason: investorScore < 65 ? "score_declining" : "rs_rank_moderate" });
    }

    // 2026-06-01 — Owned-position exhaustion gate. Uses the shared
    // detectExhaustionWarnings() helper so the no-position branch +
    // owned-position branch + Trader-engine SL tightening all see the
    // same 9-signal logic. If 2+ exhaustion signals fire, downgrade
    // to 'watch' so the auto-rebalance stops adding. We do NOT
    // auto-trim from here — that lives in the auto-rebalance trim
    // sweep (worker/index.js) which calls cioReviewRebalanceTrim
    // before pulling the trigger.
    const _ownExhaustion = detectExhaustionWarnings(tickerData);
    if (_ownExhaustion.length >= 2) {
      return finalize({
        stage: "watch",
        reason: `exhaustion_detected:${_ownExhaustion.slice(0, 4).join("|")}`,
      });
    }

    // Signal-based downgrades for core_hold positions
    const _stgDivWBear = tickerData?.rsi_divergence?.W || tickerData?.tf_tech?.W?.rsiDiv;
    if (_stgDivWBear?.bear?.active) {
      return finalize({ stage: "watch", reason: "weekly_bearish_divergence" });
    }

    const _stgTdPerTf = tickerData?.td_sequential?.per_tf;
    const _stgTdW = _stgTdPerTf?.W || _stgTdPerTf?.["1W"];
    const _stgTdD = _stgTdPerTf?.D || _stgTdPerTf?.["1D"];
    if (_stgTdW?.bearish_prep_count >= 7 || _stgTdW?.td9_bearish) {
      return finalize({ stage: "watch", reason: "weekly_buyer_exhaustion_td9" });
    }
    if (_stgTdD?.bearish_prep_count >= 8 || _stgTdD?.td9_bearish) {
      return finalize({ stage: "watch", reason: "daily_buyer_exhaustion_td9" });
    }
    if (_stgTdW?.bullish_prep_count >= 8) {
      return finalize({ stage: "watch", reason: "weekly_seller_exhaustion" });
    }

    const _stgSatyW = tickerData?.tf_tech?.W?.saty;
    if (_stgSatyW) {
      const wVal = Number(_stgSatyW.v) || 0;
      if ((_stgSatyW.z === "DISTRIBUTION" || wVal > 80) && _stgSatyW.l) {
        return finalize({ stage: "watch", reason: "weekly_phase_distribution" });
      }
    }

    // Core Hold: weekly + monthly trends intact, RS rank > 50th pct
    return finalize({ stage: "core_hold", reason: "trends_intact" });
  }

  // ── Without position ──

  // 2026-06-01 — Exhausted momentum-runner short-circuit.
  // detectAccumulationZone() flags `momentum_runner_exhausted` when 2+
  // exhaustion signals fire alongside an otherwise-passing trend
  // checklist (TD9 setup at 7+, Phase EXTREME, monthly RSI > 80,
  // bearish RSI divergence, RS rank < 30, 1m RS < -3%). For these
  // names the trend is "still up" but the setup is "do not add" — we
  // route them to 'watch' so they appear in the Investor UI's "Hold
  // & Watch" lane (visible, but the auto-rebalance does not initiate
  // a starter position). The exhaustionWarnings array surfaces in the
  // stageReason so the operator + thesis email can show WHY this isn't
  // an accumulate.
  if (accumZone?.zoneType === "momentum_runner_exhausted") {
    return finalize({
      stage: "watch",
      reason: `exhaustion_detected:${(accumZone.exhaustionWarnings || []).slice(0, 4).join("|")}`,
    });
  }

  // Accumulate: in accumulation zone + decent score + market health okay
  if (
    accumZone?.inZone &&
    investorScore >= cfg.accumulate_inzone_score_min &&
    marketHealth >= cfg.accumulate_inzone_market_health_min
  ) {
    return finalize({ stage: "accumulate", reason: accumZone.zoneType || "accumulation_zone" });
  }

  // Accumulate: strong score even without perfect zone.
  // Phase 3.9d (2026-05-10): default lowered from 70 to 65 based on forensic
  // dry-run findings (51% of blueprint cohort scored 60-69, just shy of the
  // old 70 cutoff). Tunable via deep_audit_investor_accumulate_strong_score_min.
  if (
    investorScore >= cfg.accumulate_strong_score_min &&
    marketHealth >= cfg.accumulate_strong_score_market_health_min
  ) {
    return finalize({ stage: "accumulate", reason: "strong_score" });
  }

  // Watch: moderate-to-good score, worth monitoring closely
  if (investorScore >= cfg.watch_score_min) {
    return finalize({
      stage: "watch",
      reason: investorScore >= cfg.watch_promising_score_min ? "promising" : "monitoring",
    });
  }

  // Research sub-classes: below watch — still in universe, conviction-level granularity
  if (investorScore >= cfg.research_on_watch_score_min) {
    return finalize({ stage: "research_on_watch", reason: "moderate_score" });
  }
  if (investorScore >= cfg.research_low_score_min) {
    return finalize({ stage: "research_low", reason: "low_conviction" });
  }
  return finalize({ stage: "research_avoid", reason: "low_score" });
}


// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2B: Accumulation Zone Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect exhaustion warnings on a ticker. Each warning is independently
 * meaningful; 2+ firing simultaneously is a strong "trend stretched,
 * mean-reversion imminent" signal even when the trend direction itself
 * is still up.
 *
 * Used by:
 *   • detectAccumulationZone (this file) — to downgrade momentum_runner
 *     to momentum_runner_exhausted so blowoff tops don't get an
 *     ACCUMULATE green light.
 *   • classifyInvestorStage (this file, with-position branch) — to
 *     route owned positions into 'watch' so the auto-rebalance stops
 *     adding to a stretched name.
 *   • worker/index.js processTradeSimulation (Trader entry path) — to
 *     TIGHTEN the SL multiplier when a Trader entry fires on an
 *     exhausted name (smaller risk per trade, quicker exit on cracks).
 *
 * Pure function on tickerData; no side effects, no external calls.
 *
 * @param {object} tickerData - assembled ticker payload
 * @returns {string[]} array of warning identifiers; empty when no exhaustion.
 */
export function detectExhaustionWarnings(tickerData) {
  return _detectExhaustionWarningsFromTiming(tickerData);
}

/**
 * Detect if a ticker is in an accumulation zone (good buy zone for investors).
 *
 * @param {object} tickerData - assembled ticker payload
 * @param {object} [cfg] - optional InvestorConfig (defaults to DEFAULT_INVESTOR_CONFIG).
 *                         Controls Phase 3.9e momentum-runner branch tunables.
 * @returns {{ inZone: boolean, zoneType: string, confidence: number, signals: string[] }}
 */
export function detectAccumulationZone(tickerData, cfg = DEFAULT_INVESTOR_CONFIG) {
  const signals = [];
  let confidence = 0;

  const price = tickerData.price;
  const mb = tickerData.monthly_bundle;
  const tfW = tickerData.tf_tech?.W;
  const tfD = tickerData.tf_tech?.D;
  const emaW = tickerData.ema_map?.W;
  const emaD = tickerData.ema_map?.D;

  if (!price || price <= 0) {
    return { inZone: false, zoneType: "none", confidence: 0, signals: [] };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Phase 3.9e (2026-05-11) — Momentum-Runner Zone branch.
  //
  // Recognize healthy mid-trend conditions on momentum-runner profiles
  // (SNDK / BE / AEHR class). Pre-Phase-3.9e, the zone detector was 100%
  // mean-reversion oriented and missed these entirely (avg 0.4 of 15
  // possible score contribution). Forensic dry-run on canonical Phase C
  // showed PLTR scoring 0/49 → accumulate, TSM 0/24, SNDK 6/41 (avg 47.8
  // despite +388% return) — all calibrated below the strong-score gate
  // because this detector was silent on their profiles.
  //
  // Six criteria (each contributing); promote zone when >= min_signals
  // AND confidence >= min_confidence. Independent of and additive to the
  // existing oversold-bounce branch below.
  // ═════════════════════════════════════════════════════════════════════════
  if (cfg.accum_zone_momentum_runner_enabled) {
    const mrSignals = [];   // primary criteria (count toward min_signals threshold)
    const mrBonus = [];     // bonus boosters (confidence-only, not counted)
    let mrConfidence = 0;
    // 1. Above weekly EMA21 (close-discipline)
    if (tfW?.ema?.priceAboveEma21 === true) {
      mrSignals.push("weekly_above_ema21");
      mrConfidence += 18;
    }
    // 2. Above daily EMA21
    if (tfD?.ema?.priceAboveEma21 === true) {
      mrSignals.push("daily_above_ema21");
      mrConfidence += 12;
    }
    // 3. Monthly bull (Pine convention -1 = bull)
    if (mb?.supertrend_dir === -1) {
      mrSignals.push("monthly_supertrend_bull");
      mrConfidence += 14;
    }
    // 4. Weekly SuperTrend bull (STANDARD convention: atr.xs === 1)
    if (tfW?.atr?.xs === 1) {
      mrSignals.push("weekly_supertrend_bull");
      mrConfidence += 14;
    }
    // 5. Weekly RSI in healthy zone (not oversold, not exhausted)
    const wRsi5 = Number(tfW?.rsi?.r5);
    if (
      Number.isFinite(wRsi5) &&
      wRsi5 >= cfg.accum_zone_momentum_runner_weekly_rsi_min &&
      wRsi5 <= cfg.accum_zone_momentum_runner_weekly_rsi_max
    ) {
      mrSignals.push("weekly_rsi_healthy");
      mrConfidence += 12;
    }
    // 6. Daily SuperTrend bull (Pine convention -1 = bull)
    if (tfD?.stDir === -1) {
      mrSignals.push("daily_supertrend_bull");
      mrConfidence += 10;
    }
    // Bonus boosters — contribute confidence but NOT to the min_signals
    // count. They make a marginal-pass case more confident, but can't
    // promote a too-thin signal set on their own.
    if ((emaW?.depth ?? tfW?.ema?.depth ?? 0) >= 4) {
      mrBonus.push("weekly_ema_stack_strong");
      mrConfidence += 8;
    }
    if (
      mrSignals.length >= cfg.accum_zone_momentum_runner_min_signals &&
      mrConfidence >= cfg.accum_zone_momentum_runner_min_confidence
    ) {
      // 2026-06-01 — EXHAUSTION GATES on momentum_runner. See lessons.md.
      // Uses the shared detectExhaustionWarnings() helper exported below
      // so the Trader-entry path (worker/index.js) sees the same 9-signal
      // logic when deciding whether to tighten SL on a "popping off" name.
      const exhaustionWarnings = detectExhaustionWarnings(tickerData);
      const exhaustionMin = Number(cfg.accum_zone_exhaustion_min ?? 2);
      if (exhaustionWarnings.length >= exhaustionMin) {
        return {
          inZone: true,
          zoneType: "momentum_runner_exhausted",
          // Confidence penalty: each exhaustion signal subtracts 10 pts so
          // a clearly exhausted setup falls below the watch threshold too
          // (and classifyInvestorStage drops it from any accumulate lane).
          confidence: Math.max(0, Math.min(100, mrConfidence - 10 * exhaustionWarnings.length)),
          signals: [...mrSignals, ...mrBonus],
          exhaustionWarnings,
        };
      }

      // Momentum-runner zone qualifies. Return early — this profile is
      // structurally different from the oversold-bounce profile below;
      // mixing the two would dilute confidence semantics.
      return {
        inZone: true,
        zoneType: "momentum_runner",
        confidence: Math.min(100, mrConfidence),
        signals: [...mrSignals, ...mrBonus],
      };
    }
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
  // Pine convention: monthly_bundle.supertrend_dir === -1 = bull.
  if (mb && mb.supertrend_dir === -1 && mb.ema_structure > 0) {
    confidence += 10;
    signals.push("monthly_trend_bullish");
  }

  // ── RSI Divergence confirmation / penalty ──
  const _azDivW = tickerData?.rsi_divergence?.W || tickerData?.tf_tech?.W?.rsiDiv;
  const _azDivD = tickerData?.rsi_divergence?.D || tickerData?.tf_tech?.D?.rsiDiv;
  if (_azDivW?.bull?.active) {
    signals.push("weekly_bullish_divergence");
    confidence += 25;
  }
  if (_azDivW?.bear?.active || _azDivD?.bear?.active) {
    signals.push("bearish_divergence_active");
    confidence -= 20;
  }

  // ── TD Sequential buyer exhaustion (contrarian buy zone) ──
  // bearish_prep counts while price RISES → buyer exhaustion → potential drop
  const _azTdPerTf = tickerData?.td_sequential?.per_tf;
  const _azTdW = _azTdPerTf?.W || _azTdPerTf?.["1W"];
  const _azTdD = _azTdPerTf?.D || _azTdPerTf?.["1D"];
  if ((_azTdW?.bearish_prep_count >= 7) || (_azTdD?.bearish_prep_count >= 7)) {
    signals.push("td_buyer_exhaustion");
    confidence += 15;
  }
  // bullish_prep counts while price FALLS → seller exhaustion → bounce may be stretched
  if ((_azTdD?.bullish_prep_count >= 8)) {
    signals.push("td_seller_exhaustion_bounce_stretched");
    confidence -= 15;
  }

  // ── Saty Phase leaving accumulation (institutional buying starting) ──
  const _azSatyW = tickerData?.tf_tech?.W?.saty;
  if (_azSatyW) {
    const wVal = Number(_azSatyW.v) || 0;
    if (_azSatyW.z === "ACCUMULATION" || (wVal < -60 && _azSatyW.l)) {
      signals.push("phase_accumulation");
      confidence += 20;
    }
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
  const wb = tickerData.weekly_bundle; // 2026-06-01 — added in indicators.js
  const emaW = tickerData.ema_map?.W;
  const tfW = tickerData.tf_tech?.W;
  const ticker = tickerData.ticker || "???";

  const conditions = [];
  const invalidation = [];

  /* 2026-06-01 — Operator request: surface the actual price levels next to
     each Invalidation string so the user immediately sees how much room
     before invalidation triggers (e.g. "Monthly SuperTrend flips bearish
     (below $425.30)" — current price $479.15 = ~11% buffer). Without the
     numbers, the user has to mentally cross-reference the chart.

     Convention: append `(below $X.XX)` for floor levels (ST, EMA200) and
     `(currently top NN%)` for percentile gates (RS rank). Same numeric
     format the rest of the Investor card uses.

     2026-06-01 (v2) — Distance sanity check.
     Operator: "MU invalidation at 395... is that valid?" (MU @ $1035,
     Monthly ST at $393 = 62% drawdown to trigger). For parabolic stocks
     where price has rallied faster than the trail indicators can catch
     up, the long-horizon ST levels become mathematically correct but
     practically useless as invalidation anchors. A 62% drawdown floor
     is not a "risk plan", it's "we accept a 62% loss before changing
     our mind".

     Rule: if a trail level is > 25% below current price, tag it with
     "(extreme distance — N% drawdown to trigger)" so the operator sees
     the trail is too far to act on. The condition stays in the invalid-
     ation list so the historical thesis is intact, but the user
     instantly sees the risk-anchor isn't useful and should fall back
     to a closer level (Weekly EMA21, ATR-based trail, or a per-trade
     stop). */
  const fmtUsd = (n) => Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : null;
  const livePx = Number(tickerData?._live_price || tickerData?.price) || 0;
  const EXTREME_DD_PCT = 25; // % drawdown threshold beyond which a level is "extreme"
  const annotateDistance = (label, level) => {
    const lvl = Number(level);
    if (!(livePx > 0) || !Number.isFinite(lvl) || lvl <= 0) return label;
    const ddPct = ((livePx - lvl) / livePx) * 100;
    if (ddPct >= EXTREME_DD_PCT) {
      return `${label} — extreme distance, ${ddPct.toFixed(0)}% drawdown to trigger`;
    }
    return label;
  };

  // Monthly trend (Pine convention: -1 = bull, +1 = bear)
  if (mb?.supertrend_dir === -1) {
    conditions.push("Monthly uptrend");
    const stLvl = fmtUsd(mb?.supertrend_line);
    const base = stLvl ? `Monthly SuperTrend flips bearish (below ${stLvl})` : "Monthly SuperTrend flips bearish";
    invalidation.push(annotateDistance(base, mb?.supertrend_line));
  } else if (mb?.supertrend_dir === 1) {
    conditions.push("Monthly downtrend (caution)");
  }

  // Weekly EMA position
  if (emaW?.structure > 0.5) {
    conditions.push("Above Weekly EMA(200)");
    const wEma200 = fmtUsd(wb?.ema200);
    const base = wEma200 ? `Price closes below Weekly EMA(200) (${wEma200})` : "Price closes below Weekly EMA(200)";
    invalidation.push(annotateDistance(base, wb?.ema200));
  }

  // Weekly SuperTrend
  if (tfW?.atr?.xs === 1) {
    conditions.push("Weekly SuperTrend bullish");
    const wStLvl = fmtUsd(wb?.supertrend_line);
    const base = wStLvl ? `Weekly SuperTrend flips bearish (below ${wStLvl})` : "Weekly SuperTrend flips bearish";
    invalidation.push(annotateDistance(base, wb?.supertrend_line));
  }

  // 2026-06-01 (v2) — Parabolic-mover fallback risk anchor.
  // When EVERY long-horizon trail is > EXTREME_DD_PCT below price, the
  // operator has no useful invalidation level. Add a fallback line that
  // points to a tighter, more actionable risk anchor:
  //   • If the ticker has an EMA21 weekly level → use that
  //   • Otherwise fall back to a fixed-percentage stop (price × 0.85)
  //     so the user gets *some* practical risk number, not just the
  //     "extreme distance" warnings on every level.
  const _allLevels = [mb?.supertrend_line, wb?.supertrend_line, wb?.ema200].filter(n => Number.isFinite(Number(n)) && Number(n) > 0);
  const _allExtreme = _allLevels.length > 0 && livePx > 0
    && _allLevels.every(lvl => ((livePx - Number(lvl)) / livePx) * 100 >= EXTREME_DD_PCT);
  if (_allExtreme) {
    const _ema21W = Number(tickerData?.tf_tech?.W?.ema?.ema21 || tickerData?.ema_map?.W?.ema21);
    if (Number.isFinite(_ema21W) && _ema21W > 0 && _ema21W < livePx) {
      const ddPct = ((livePx - _ema21W) / livePx) * 100;
      invalidation.push(`Practical risk anchor: Weekly EMA(21) at ${fmtUsd(_ema21W)} (${ddPct.toFixed(0)}% drawdown — closer than the long-horizon trails)`);
    } else {
      const stopFloor = livePx * 0.85; // 15% trailing stop as a coarse fallback
      invalidation.push(`Practical risk anchor: 15% trailing stop at ${fmtUsd(stopFloor)} — long-horizon trails haven't caught up after parabolic move`);
    }
  }

  // RS Rank
  const _ord = (n) => {
    const r = Math.round(Number(n));
    if (!Number.isFinite(r)) return String(n);
    const rem100 = r % 100;
    if (rem100 >= 11 && rem100 <= 13) return `${r}th`;
    const rem10 = r % 10;
    return `${r}${rem10 === 1 ? "st" : rem10 === 2 ? "nd" : rem10 === 3 ? "rd" : "th"}`;
  };
  if (rsRank >= 75) {
    conditions.push(`RS Rank top ${100 - rsRank}%`);
    invalidation.push(`RS Rank drops below 30th percentile (currently ${_ord(rsRank)})`);
  } else if (rsRank >= 50) {
    conditions.push(`RS Rank ${_ord(rsRank)} percentile`);
    invalidation.push(`RS Rank drops below 25th percentile (currently ${_ord(rsRank)})`);
  }

  // Monthly RSI
  if (mb?.rsi) {
    if (mb.rsi >= 50) conditions.push(`Monthly RSI ${mb.rsi.toFixed(0)} (healthy)`);
    else if (mb.rsi < 35) conditions.push(`Monthly RSI ${mb.rsi.toFixed(0)} (oversold — contrarian)`);
  }

  // Momentum signals
  const _thDivW = tickerData?.rsi_divergence?.W || tickerData?.tf_tech?.W?.rsiDiv;
  if (_thDivW?.bear?.active) {
    conditions.push("Momentum divergence detected on weekly — the uptrend may be losing steam");
    invalidation.push("Weekly momentum divergence confirms with price breakdown");
  }
  if (_thDivW?.bull?.active) {
    conditions.push("Bullish divergence on weekly — selling pressure weakening");
  }

  const _thTdPerTf = tickerData?.td_sequential?.per_tf;
  const _thTdW = _thTdPerTf?.W || _thTdPerTf?.["1W"];
  const _thTdD = _thTdPerTf?.D || _thTdPerTf?.["1D"];
  if (_thTdW?.bearish_prep_count >= 7) {
    conditions.push("Weekly buying pressure elevated — buyers may be near exhaustion (bearish prep rising)");
  }
  if (_thTdW?.bullish_prep_count >= 7) {
    conditions.push("Weekly selling pressure elevated — sellers may be near exhaustion (bullish prep rising)");
    invalidation.push("TD Sequential shows seller exhaustion on both daily and weekly");
  }

  const _thSatyW = tickerData?.tf_tech?.W?.saty;
  if (_thSatyW) {
    const wVal = Number(_thSatyW.v) || 0;
    if (_thSatyW.z === "ACCUMULATION" || (wVal < -60 && _thSatyW.l)) {
      conditions.push("Institutional accumulation phase detected — favorable entry timing");
    }
    if (_thSatyW.z === "DISTRIBUTION" || (wVal > 80 && _thSatyW.l)) {
      conditions.push("Institutional distribution phase detected — caution warranted");
      invalidation.push("Weekly Phase confirms distribution with trend breakdown");
    }
  }

  const thesis = conditions.length > 0
    ? `${ticker}: ${conditions.join(". ")}`
    : `${ticker}: Insufficient data for thesis`;

  return {
    thesis,
    invalidation,
    criteria: {
      monthlyST: mb?.supertrend_dir === -1,    // Pine convention: -1 = bull
      weeklyAbove200: emaW?.structure > 0.5,
      weeklyST: tfW?.atr?.xs === 1,             // STANDARD convention for atr.xs: +1 = up-cross / bull
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

  // Monthly SuperTrend flip (was bull at thesis time, now bear in Pine = +1)
  if (thesisCriteria.monthlyST && mb?.supertrend_dir === 1) {
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

  // Weekly bearish divergence confirmed with price below Weekly SuperTrend
  const _chkDivW = currentTickerData?.rsi_divergence?.W || currentTickerData?.tf_tech?.W?.rsiDiv;
  if (_chkDivW?.bear?.active && tfW?.atr?.xs === -1) {
    reasons.push("Weekly momentum divergence confirmed — SuperTrend flipped bearish");
  }

  // TD seller exhaustion on both D and W (bullish prep = price falling = sellers tiring)
  const _chkTdPerTf = currentTickerData?.td_sequential?.per_tf;
  const _chkTdW = _chkTdPerTf?.W || _chkTdPerTf?.["1W"];
  const _chkTdD = _chkTdPerTf?.D || _chkTdPerTf?.["1D"];
  if ((_chkTdW?.bullish_prep_count >= 8) && (_chkTdD?.bullish_prep_count >= 7)) {
    reasons.push("TD Sequential shows seller exhaustion on both daily and weekly");
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
