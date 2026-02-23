// ─────────────────────────────────────────────────────────────────────────────
// Hindsight Oracle with Event-Driven Lifecycle Snapshots
// Analyzes harvested moves end-to-end, capturing indicator state at every
// significant event during a move's lifecycle.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute PDZ from a window of 5m candles (simplified inline version).
 * @param {Array} candles - recent candles for context
 * @param {number} px - current price
 * @returns {{ zone: string, pct: number }}
 */
function computePDZInline(candles, px) {
  if (!candles || candles.length < 10 || !Number.isFinite(px)) return { zone: "unknown", pct: 50 };
  let hi = -Infinity, lo = Infinity;
  for (const c of candles) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo) lo = c.l;
  }
  const range = hi - lo;
  if (range <= 0) return { zone: "unknown", pct: 50 };
  const pct = Math.round(((px - lo) / range) * 1000) / 10;
  const premiumLine = lo + 0.95 * range;
  const discountLine = lo + 0.05 * range;
  const eqHigh = lo + 0.525 * range;
  const eqLow = lo + 0.475 * range;
  let zone;
  if (px >= premiumLine) zone = "premium";
  else if (px <= discountLine) zone = "discount";
  else if (px >= eqLow && px <= eqHigh) zone = "equilibrium";
  else if (px > eqHigh) zone = "premium_approach";
  else zone = "discount_approach";
  return { zone, pct: Math.max(0, Math.min(100, pct)) };
}

/**
 * Detect active FVGs from a window of candles (simplified inline version).
 * @param {Array} candles - candle array sorted ascending
 * @returns {{ activeBull: number, activeBear: number, inBullGap: boolean, inBearGap: boolean }}
 */
function detectFVGsInline(candles, px) {
  if (!candles || candles.length < 5) return { activeBull: 0, activeBear: 0, inBullGap: false, inBearGap: false };
  const fvgs = [];
  for (let i = 2; i < candles.length; i++) {
    const curr = candles[i], prev2 = candles[i - 2];
    if (curr.l > prev2.h) fvgs.push({ type: "bull", top: curr.l, bottom: prev2.h, formIdx: i, mitigated: false });
    if (curr.h < prev2.l) fvgs.push({ type: "bear", top: prev2.l, bottom: curr.h, formIdx: i, mitigated: false });
  }
  for (const gap of fvgs) {
    for (let k = gap.formIdx + 1; k < candles.length; k++) {
      if (gap.type === "bull" && candles[k].l < gap.bottom) { gap.mitigated = true; break; }
      if (gap.type === "bear" && candles[k].h > gap.top) { gap.mitigated = true; break; }
    }
  }
  const active = fvgs.filter(g => !g.mitigated);
  const activeBull = active.filter(g => g.type === "bull").length;
  const activeBear = active.filter(g => g.type === "bear").length;
  const inBullGap = active.some(g => g.type === "bull" && px >= g.bottom && px <= g.top);
  const inBearGap = active.some(g => g.type === "bear" && px >= g.bottom && px <= g.top);
  return { activeBull, activeBear, inBullGap, inBearGap };
}

function runHindsightOracle(harvestedMoves, autopsiedTrades, query, findNearest, percentile, emaFn, byTicker) {
  const qualifying = harvestedMoves.filter(m => m.move_atr >= 2.0 && m.duration_days >= 3);
  if (qualifying.length === 0) return null;
  const WINDOW_MS_4H = 4 * 60 * 60 * 1000;
  const WINDOW_MS_2H = 2 * 60 * 60 * 1000;
  const PDZ_LOOKBACK = 200; // 5m candles for PDZ context (~16 hours)
  const tickers = [...new Set(qualifying.map(m => m.ticker))];
  const candles5mByTicker = {};
  const trailByTicker = {};
  for (const ticker of tickers) {
    const movesForTicker = qualifying.filter(m => m.ticker === ticker);
    const minTs = Math.min(...movesForTicker.map(m => m.start_ts)) - WINDOW_MS_4H;
    const maxTs = Math.max(...movesForTicker.map(m => m.end_ts)) + 86400000;
    const rows = query(`SELECT ts, o, h, l, c FROM ticker_candles WHERE tf='5' AND ticker='${ticker}' AND ts >= ${minTs} AND ts <= ${maxTs} ORDER BY ts`);
    if (rows.length) candles5mByTicker[ticker] = rows.map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
    const trailRows = query(`SELECT bucket_ts, htf_score_avg, ltf_score_avg, state, completion, phase_pct, had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite FROM trail_5m_facts WHERE ticker='${ticker}' AND bucket_ts >= ${minTs} AND bucket_ts <= ${maxTs} ORDER BY bucket_ts`);
    if (trailRows.length) trailByTicker[ticker] = trailRows;
  }

  function computeEmaRegimeAtIndex(closes, idx) {
    if (idx < 48 || !emaFn) return { regime: 0, e5above48: false, e13above21: false };
    const slice = closes.slice(0, idx + 1);
    const e5 = emaFn(slice, 5), e13 = emaFn(slice, 13);
    const e21 = emaFn(slice, 21), e48 = emaFn(slice, 48);
    const a = e5[e5.length - 1] > e48[e48.length - 1];
    const b = e13[e13.length - 1] > e21[e21.length - 1];
    let regime = 0;
    if (a && b) regime = 2;
    else if (a && !b) regime = 1;
    else if (!a && b) regime = -1;
    else regime = -2;
    return { regime, e5above48: a, e13above21: b };
  }

  /**
   * Build lifecycle event snapshots for a single move.
   * Scans every 5m candle during the move and detects significant events.
   */
  function buildLifecycleEvents(candles5, trail, entryBarTs, entryPrice, mfeBarTs, isUp) {
    const events = [];
    if (!candles5 || candles5.length < 6) return events;

    const moveCandles = candles5.filter(c => c.ts >= entryBarTs && c.ts <= mfeBarTs);
    if (moveCandles.length < 3) return events;

    let prevPdz = null;
    let prevPhase = null;
    let runningHigh = entryPrice;
    let runningLow = entryPrice;
    let prevStFlip = false;

    for (let i = 0; i < moveCandles.length; i++) {
      const c = moveCandles[i];
      const px = c.c;
      const pnlFromEntry = isUp
        ? ((px - entryPrice) / entryPrice) * 100
        : ((entryPrice - px) / entryPrice) * 100;

      // PDZ context: use last 200 candles up to this point
      const allIdx = candles5.indexOf(c);
      const pdzWindow = candles5.slice(Math.max(0, allIdx - PDZ_LOOKBACK), allIdx + 1);
      const pdz = computePDZInline(pdzWindow, px);

      // FVG context: use last 50 candles
      const fvgWindow = candles5.slice(Math.max(0, allIdx - 50), allIdx + 1);
      const fvgState = detectFVGsInline(fvgWindow, px);

      // Trail data for this bar
      const trailRow = trail ? findNearest(trail, "bucket_ts", c.ts, 5 * 60 * 1000) : null;
      const phase = trailRow ? Number(trailRow.phase_pct) || 0 : 0;
      const htf = trailRow ? Number(trailRow.htf_score_avg) || 0 : 0;
      const ltf = trailRow ? Number(trailRow.ltf_score_avg) || 0 : 0;
      const stFlip = trailRow ? !!trailRow.had_st_flip : false;
      const sqRelease = trailRow ? !!trailRow.had_squeeze_release : false;

      const snapshot = {
        ts: c.ts, price: px, pnl_pct: Math.round(pnlFromEntry * 100) / 100,
        pdz_zone: pdz.zone, pdz_pct: pdz.pct,
        phase, htf_score: htf, ltf_score: ltf,
        fvg_active_bull: fvgState.activeBull, fvg_active_bear: fvgState.activeBear,
        fvg_in_bull_gap: fvgState.inBullGap, fvg_in_bear_gap: fvgState.inBearGap,
      };

      // EVENT: Zone transition
      if (prevPdz && pdz.zone !== prevPdz) {
        events.push({ event: "zone_transition", from: prevPdz, to: pdz.zone, ...snapshot });
      }

      // EVENT: New swing high/low within the move
      if (isUp && c.h > runningHigh) {
        runningHigh = c.h;
        events.push({ event: "new_swing_high", ...snapshot });
      }
      if (!isUp && c.l < runningLow) {
        runningLow = c.l;
        events.push({ event: "new_swing_low", ...snapshot });
      }

      // EVENT: Phase extreme (crosses +/- 75)
      if (Math.abs(phase) >= 75 && (prevPhase === null || Math.abs(prevPhase) < 75)) {
        events.push({ event: "phase_extreme", value: phase, ...snapshot });
      }

      // EVENT: SuperTrend flip
      if (stFlip && !prevStFlip) {
        events.push({ event: "st_flip", ...snapshot });
      }

      // EVENT: Squeeze release
      if (sqRelease) {
        events.push({ event: "squeeze_release", ...snapshot });
      }

      // EVENT: Significant pullback (> 1% adverse from running best)
      if (isUp) {
        const drawdown = ((runningHigh - px) / runningHigh) * 100;
        if (drawdown > 1.0 && i > 5) {
          events.push({ event: "pullback", depth_pct: Math.round(drawdown * 100) / 100, ...snapshot });
        }
      } else {
        const drawdown = ((px - runningLow) / runningLow) * 100;
        if (drawdown > 1.0 && i > 5) {
          events.push({ event: "pullback", depth_pct: Math.round(drawdown * 100) / 100, ...snapshot });
        }
      }

      prevPdz = pdz.zone;
      prevPhase = phase;
      prevStFlip = stFlip;
    }

    return events;
  }

  const fingerprints = [];
  for (const m of qualifying) {
    const candles5 = candles5mByTicker[m.ticker];
    const trail = trailByTicker[m.ticker];
    if (!candles5 || candles5.length < 12) continue;
    const startTs = m.start_ts, endTs = m.end_ts, direction = m.direction, isUp = direction === "UP";
    const inRange = candles5.filter(c => c.ts >= startTs && c.ts <= endTs);
    if (inRange.length < 6) continue;
    let entryBarTs = startTs, entryPrice = inRange[0].c;
    if (isUp) {
      const lowBar = inRange.reduce((a, c) => (c.l < (a?.l ?? 1e9) ? c : a), null);
      if (lowBar) { entryBarTs = lowBar.ts; entryPrice = lowBar.l; }
    } else {
      const highBar = inRange.reduce((a, c) => (c.h > (a?.h ?? 0) ? c : a), null);
      if (highBar) { entryBarTs = highBar.ts; entryPrice = highBar.h; }
    }
    let mfeBarTs = entryBarTs, maxFav = 0;
    for (const c of inRange) {
      if (c.ts < entryBarTs) continue;
      const fav = isUp ? (c.h - entryPrice) / entryPrice : (entryPrice - c.l) / entryPrice;
      if (fav > maxFav) { maxFav = fav; mfeBarTs = c.ts; }
    }
    const pullbackPct = (m.pullback_atr / (m.move_atr || 1)) * 100;
    if (pullbackPct > 50 || m.duration_days < 2) continue;
    const trailAtEntry = trail ? findNearest(trail, "bucket_ts", entryBarTs, WINDOW_MS_4H) : null;
    const trailAtExit = trail ? findNearest(trail, "bucket_ts", mfeBarTs, 30 * 60 * 1000) : null;
    const entryWindow = trail ? trail.filter(r => r.bucket_ts >= entryBarTs - WINDOW_MS_4H && r.bucket_ts <= entryBarTs + WINDOW_MS_2H) : [];
    const stateAtEntry = trailAtEntry?.state || "unknown";
    const htfAtEntry = Number(trailAtEntry?.htf_score_avg) || 0;
    const ltfAtEntry = Number(trailAtEntry?.ltf_score_avg) || 0;
    const squeeze = entryWindow.some(r => r.had_squeeze_release);
    const emaCross = entryWindow.some(r => r.had_ema_cross);
    const stFlip = entryWindow.some(r => r.had_st_flip);
    const momentum = entryWindow.some(r => r.had_momentum_elite);

    const dailyCandles = byTicker ? byTicker[m.ticker] : null;
    let emaRegimeAtEntry = 0, ema5above48AtEntry = false, ema13above21AtEntry = false, emaRegimeAtExit = 0;
    if (dailyCandles && dailyCandles.length >= 50) {
      const closes = dailyCandles.map(c => c.c);
      const entryDayIdx = dailyCandles.findIndex(c => c.ts >= startTs);
      const exitDayIdx = dailyCandles.findIndex(c => c.ts >= endTs);
      if (entryDayIdx >= 48) {
        const er = computeEmaRegimeAtIndex(closes, entryDayIdx);
        emaRegimeAtEntry = er.regime; ema5above48AtEntry = er.e5above48; ema13above21AtEntry = er.e13above21;
      }
      if (exitDayIdx >= 48) emaRegimeAtExit = computeEmaRegimeAtIndex(closes, exitDayIdx).regime;
    }

    // PDZ at entry
    const entryIdx = candles5.findIndex(c => c.ts >= entryBarTs);
    const pdzWindowEntry = candles5.slice(Math.max(0, entryIdx - PDZ_LOOKBACK), entryIdx + 1);
    const pdzAtEntry = computePDZInline(pdzWindowEntry, entryPrice);

    // PDZ at exit (MFE)
    const exitIdx = candles5.findIndex(c => c.ts >= mfeBarTs);
    const pdzWindowExit = candles5.slice(Math.max(0, exitIdx - PDZ_LOOKBACK), exitIdx + 1);
    const mfePrice = isUp ? Math.max(...inRange.filter(c => c.ts >= entryBarTs).map(c => c.h)) : Math.min(...inRange.filter(c => c.ts >= entryBarTs).map(c => c.l));
    const pdzAtExit = computePDZInline(pdzWindowExit, mfePrice);

    // Build lifecycle events
    const lifecycle = buildLifecycleEvents(candles5, trail, entryBarTs, entryPrice, mfeBarTs, isUp);

    // Move stats
    let maxDrawdown = 0;
    let pullbackCount = 0;
    const afterEntry = inRange.filter(c => c.ts >= entryBarTs);
    let best = entryPrice;
    for (const c of afterEntry) {
      if (isUp) {
        if (c.h > best) best = c.h;
        const dd = ((best - c.l) / best) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
        if (dd > 1.0) pullbackCount++;
      } else {
        if (c.l < best) best = c.l;
        const dd = ((c.h - best) / best) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
        if (dd > 1.0) pullbackCount++;
      }
    }

    fingerprints.push({
      move_id: m.move_id, ticker: m.ticker, direction: m.direction, state: stateAtEntry,
      htf_score: htfAtEntry, ltf_score: ltfAtEntry,
      completion: Number(trailAtEntry?.completion) || 0, phase_pct: Number(trailAtEntry?.phase_pct) || 0,
      squeeze_release: squeeze ? 1 : 0, ema_cross: emaCross ? 1 : 0, st_flip: stFlip ? 1 : 0, momentum_elite: momentum ? 1 : 0,
      ema_regime_at_entry: emaRegimeAtEntry, ema5above48_at_entry: ema5above48AtEntry ? 1 : 0,
      ema13above21_at_entry: ema13above21AtEntry ? 1 : 0, ema_regime_at_exit: emaRegimeAtExit,
      pdz_at_entry: pdzAtEntry.zone, pdz_pct_at_entry: pdzAtEntry.pct,
      pdz_at_exit: pdzAtExit.zone, pdz_pct_at_exit: pdzAtExit.pct,
      move_atr: m.move_atr, duration_days: m.duration_days, vix_at_start: m.vix_at_start,
      exit_phase: trailAtExit ? Number(trailAtExit.phase_pct) : null,
      lifecycle,
      move_stats: {
        duration_days: m.duration_days,
        max_pnl_pct: Math.round(maxFav * 10000) / 100,
        max_drawdown_pct: Math.round(maxDrawdown * 100) / 100,
        pullback_count: pullbackCount,
        lifecycle_events: lifecycle.length,
      },
    });
  }

  // ── Golden Profiles (entry-level aggregation, unchanged) ──
  const byState = {};
  for (const fp of fingerprints) {
    const st = fp.state || "unknown";
    if (st === "unknown") continue;
    (byState[st] = byState[st] || []).push(fp);
  }
  const goldenProfiles = {};
  for (const [state, arr] of Object.entries(byState)) {
    if (arr.length < 5) continue;
    const n = arr.length;
    const pct = (v) => Math.round((arr.filter(x => x[v]).length / n) * 100);
    const med = (key) => percentile(arr.map(a => a[key]).filter(x => x != null), 50);
    const regimeConfirmedPct = Math.round((arr.filter(x => x.ema_regime_at_entry >= 2 || x.ema_regime_at_entry <= -2).length / n) * 100);
    const regimeEarlyPct = Math.round((arr.filter(x => Math.abs(x.ema_regime_at_entry) === 1).length / n) * 100);
    const regimeReversedAtExitPct = Math.round((arr.filter(x => {
      if (x.direction === "UP") return x.ema_regime_at_exit <= -1;
      return x.ema_regime_at_exit >= 1;
    }).length / n) * 100);
    goldenProfiles[state] = {
      sample_count: n,
      squeeze_release_pct: pct("squeeze_release"), ema_cross_pct: pct("ema_cross"), st_flip_pct: pct("st_flip"), momentum_elite_pct: pct("momentum_elite"),
      ema_regime_confirmed_pct: regimeConfirmedPct, ema_regime_early_pct: regimeEarlyPct,
      ema5above48_pct: pct("ema5above48_at_entry"), ema13above21_pct: pct("ema13above21_at_entry"),
      ema_regime_reversed_at_exit_pct: regimeReversedAtExitPct,
      htf_score_median: Math.round(med("htf_score") * 10) / 10, ltf_score_median: Math.round(med("ltf_score") * 10) / 10,
      completion_median: Math.round(med("completion") * 100) / 100, phase_median: Math.round(med("phase_pct") * 100) / 100,
      avg_move_atr: Math.round((arr.reduce((s, a) => s + a.move_atr, 0) / n) * 100) / 100
    };
  }

  // ── Lifecycle Profiles (NEW: aggregated from lifecycle events) ──
  const lifecycleProfiles = buildLifecycleProfiles(fingerprints, percentile);

  // ── Trade Alignments ──
  const tradeAlignments = [];
  for (const t of autopsiedTrades) {
    const state = t.entry_path || t.state_at_entry || "unknown";
    const golden = goldenProfiles[state];
    if (!golden) { tradeAlignments.push({ trade_id: t.trade_id, state, alignment_pct: null }); continue; }
    let score = 0, sigs = 0;
    try {
      const flags = t.flags_at_entry ? (typeof t.flags_at_entry === "string" ? JSON.parse(t.flags_at_entry) : t.flags_at_entry) : {};
      if (golden.squeeze_release_pct >= 50 && flags.squeeze_release) { score++; sigs++; }
      if (golden.ema_cross_pct >= 50 && flags.ema_cross) { score++; sigs++; }
      if (golden.st_flip_pct >= 50 && flags.st_flip) { score++; sigs++; }
      if (golden.momentum_elite_pct >= 50 && flags.momentum_elite) { score++; sigs++; }
    } catch (_) {}
    tradeAlignments.push({ trade_id: t.trade_id, state, alignment_pct: sigs > 0 ? Math.round((score / sigs) * 100) : null });
  }

  // ── Recommendations ──
  const recommendations = [];
  for (const [state, g] of Object.entries(goldenProfiles)) {
    if (g.sample_count < 20) continue;
    if (g.squeeze_release_pct >= 60) recommendations.push({ type: "signal", state, signal: "squeeze_release", message: `Require squeeze_release for ${state} (present in ${g.squeeze_release_pct}% of ideal entries)` });
    if (g.ema_cross_pct >= 60) recommendations.push({ type: "signal", state, signal: "ema_cross", message: `Consider ema_cross confirmation for ${state} (${g.ema_cross_pct}% of ideal entries)` });
    if (g.htf_score_median >= 20) recommendations.push({ type: "threshold", state, metric: "min_htf_score", suggested: g.htf_score_median, message: `Raise min HTF score for ${state} toward ${g.htf_score_median} (golden median)` });
    if (g.ema_regime_confirmed_pct >= 50) recommendations.push({ type: "regime", state, signal: "ema_regime_confirmed", message: `${g.ema_regime_confirmed_pct}% of ${state} moves started with confirmed EMA regime (5>48 AND 13>21)` });
    if (g.ema5above48_pct >= 60) recommendations.push({ type: "regime", state, signal: "ema_5_48_position", message: `${g.ema5above48_pct}% of ${state} moves had 5 EMA above 48 EMA at entry` });
    if (g.ema_regime_reversed_at_exit_pct >= 40) recommendations.push({ type: "regime", state, signal: "ema_regime_exit", message: `${g.ema_regime_reversed_at_exit_pct}% of ${state} moves ended with EMA regime reversal — use as exit signal` });
  }

  // ── Lifecycle-based recommendations ──
  if (lifecycleProfiles.trim_profile) {
    const tp = lifecycleProfiles.trim_profile;
    if (tp.pdz_zone_premium_pct >= 60) recommendations.push({ type: "lifecycle", signal: "trim_in_premium", message: `${tp.pdz_zone_premium_pct}% of MFE peaks occurred in premium zone — trim when price reaches premium` });
    if (tp.phase_median >= 65) recommendations.push({ type: "lifecycle", signal: "trim_on_phase", message: `Phase at peak was median ${tp.phase_median} — use phase ≥${Math.round(tp.phase_median * 0.9)} as trim trigger` });
  }
  if (lifecycleProfiles.pullback_profile) {
    const pp = lifecycleProfiles.pullback_profile;
    if (pp.pdz_zone_discount_pct >= 40) recommendations.push({ type: "lifecycle", signal: "hold_in_discount", message: `${pp.pdz_zone_discount_pct}% of pullbacks occurred in discount zone — hold through discount pullbacks` });
  }

  return {
    qualifying_moves: qualifying.length,
    fingerprints_count: fingerprints.length,
    golden_profiles: goldenProfiles,
    lifecycle_profiles: lifecycleProfiles,
    trade_alignments: tradeAlignments,
    recommendations: recommendations.slice(0, 15)
  };
}

/**
 * Build lifecycle profiles by aggregating events across all fingerprints.
 * Produces statistical summaries for trim, hold, exit, and pullback conditions.
 */
function buildLifecycleProfiles(fingerprints, percentile) {
  const allEvents = [];
  const peakSnapshots = [];
  const pullbackSnapshots = [];
  const entrySnapshots = [];

  for (const fp of fingerprints) {
    if (!fp.lifecycle || fp.lifecycle.length === 0) continue;

    // Entry snapshot
    entrySnapshots.push({
      pdz_zone: fp.pdz_at_entry,
      pdz_pct: fp.pdz_pct_at_entry,
      phase: fp.phase_pct,
      htf_score: fp.htf_score,
    });

    // Collect peak events (new swing highs/lows near MFE)
    const peaks = fp.lifecycle.filter(e => e.event === "new_swing_high" || e.event === "new_swing_low");
    if (peaks.length > 0) {
      const lastPeak = peaks[peaks.length - 1];
      peakSnapshots.push(lastPeak);
    }

    // Collect pullback events
    const pullbacks = fp.lifecycle.filter(e => e.event === "pullback");
    pullbackSnapshots.push(...pullbacks);

    allEvents.push(...fp.lifecycle);
  }

  if (allEvents.length === 0) return {};

  const zonePct = (arr, zone) => arr.length > 0 ? Math.round((arr.filter(s => s.pdz_zone === zone).length / arr.length) * 100) : 0;
  const safeMed = (arr, key) => {
    const vals = arr.map(a => a[key]).filter(x => Number.isFinite(x));
    return vals.length > 0 ? percentile(vals, 50) : 0;
  };

  const result = {};

  // Trim profile: what conditions look like at the peak of the move
  if (peakSnapshots.length >= 3) {
    result.trim_profile = {
      sample_count: peakSnapshots.length,
      pdz_zone_premium_pct: zonePct(peakSnapshots, "premium"),
      pdz_zone_premium_approach_pct: zonePct(peakSnapshots, "premium_approach"),
      pdz_zone_equilibrium_pct: zonePct(peakSnapshots, "equilibrium"),
      pdz_pct_median: Math.round(safeMed(peakSnapshots, "pdz_pct") * 10) / 10,
      phase_median: Math.round(safeMed(peakSnapshots, "phase") * 10) / 10,
      pnl_pct_median: Math.round(safeMed(peakSnapshots, "pnl_pct") * 100) / 100,
      fvg_active_bull_median: Math.round(safeMed(peakSnapshots, "fvg_active_bull")),
      fvg_active_bear_median: Math.round(safeMed(peakSnapshots, "fvg_active_bear")),
    };
  }

  // Hold profile: what the "normal" state of a move looks like (zone transitions to equilibrium or discount approach)
  const holdEvents = allEvents.filter(e => e.event === "zone_transition" && (e.to === "equilibrium" || e.to === "discount_approach"));
  if (holdEvents.length >= 3) {
    result.hold_profile = {
      sample_count: holdEvents.length,
      pdz_pct_median: Math.round(safeMed(holdEvents, "pdz_pct") * 10) / 10,
      phase_median: Math.round(safeMed(holdEvents, "phase") * 10) / 10,
      pnl_pct_median: Math.round(safeMed(holdEvents, "pnl_pct") * 100) / 100,
      fvg_bull_support_pct: Math.round((holdEvents.filter(e => e.fvg_active_bull > 0).length / holdEvents.length) * 100),
    };
  }

  // Exit profile: what the final peak snapshot looks like (last lifecycle event for each move)
  const exitSnapshots = fingerprints
    .filter(fp => fp.lifecycle && fp.lifecycle.length > 0)
    .map(fp => fp.lifecycle[fp.lifecycle.length - 1]);
  if (exitSnapshots.length >= 3) {
    result.exit_profile = {
      sample_count: exitSnapshots.length,
      pdz_zone_premium_pct: zonePct(exitSnapshots, "premium"),
      pdz_pct_median: Math.round(safeMed(exitSnapshots, "pdz_pct") * 10) / 10,
      phase_median: Math.round(safeMed(exitSnapshots, "phase") * 10) / 10,
      pnl_pct_median: Math.round(safeMed(exitSnapshots, "pnl_pct") * 100) / 100,
    };
  }

  // Pullback profile: what pullbacks look like during successful moves
  if (pullbackSnapshots.length >= 3) {
    result.pullback_profile = {
      sample_count: pullbackSnapshots.length,
      pdz_zone_discount_pct: zonePct(pullbackSnapshots, "discount"),
      pdz_zone_discount_approach_pct: zonePct(pullbackSnapshots, "discount_approach"),
      pdz_pct_median: Math.round(safeMed(pullbackSnapshots, "pdz_pct") * 10) / 10,
      depth_pct_median: Math.round(safeMed(pullbackSnapshots, "depth_pct") * 100) / 100,
      phase_median: Math.round(safeMed(pullbackSnapshots, "phase") * 10) / 10,
      fvg_bull_support_pct: Math.round((pullbackSnapshots.filter(e => e.fvg_active_bull > 0).length / pullbackSnapshots.length) * 100),
    };
  }

  // Entry profile: where entries happen in PDZ terms
  if (entrySnapshots.length >= 3) {
    result.entry_profile = {
      sample_count: entrySnapshots.length,
      pdz_zone_discount_pct: zonePct(entrySnapshots, "discount"),
      pdz_zone_discount_approach_pct: zonePct(entrySnapshots, "discount_approach"),
      pdz_zone_equilibrium_pct: zonePct(entrySnapshots, "equilibrium"),
      pdz_pct_median: Math.round(safeMed(entrySnapshots, "pdz_pct") * 10) / 10,
    };
  }

  return result;
}

module.exports = { runHindsightOracle };
