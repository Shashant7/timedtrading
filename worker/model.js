/**
 * model.js — Self-Learning Model Engine
 *
 * Pattern matching, prediction logging, and outcome resolution.
 * Imported by index.js and used at scoring time + on a daily cron.
 */

// ─── Pattern Definition Format ───────────────────────────────────────────────
// Each pattern in pattern_library.definition_json is an array of conditions:
//   [
//     { "field": "state", "op": "eq", "value": "HTF_BULL_LTF_BULL" },
//     { "field": "flags.st_flip_30m", "op": "truthy" },
//     { "field": "htf_score", "op": "gte", "value": 60 }
//   ]
//
// Supported operators: eq, neq, gt, gte, lt, lte, truthy, falsy, in, contains

function resolveField(obj, fieldPath) {
  const parts = fieldPath.split(".");
  let val = obj;
  for (const p of parts) {
    if (val == null) return undefined;
    val = val[p];
  }
  return val;
}

function evaluateCondition(snapshot, cond) {
  const val = resolveField(snapshot, cond.field);
  switch (cond.op) {
    case "eq":      return val === cond.value;
    case "neq":     return val !== cond.value;
    case "gt":      return typeof val === "number" && val > cond.value;
    case "gte":     return typeof val === "number" && val >= cond.value;
    case "lt":      return typeof val === "number" && val < cond.value;
    case "lte":     return typeof val === "number" && val <= cond.value;
    case "truthy":  return !!val;
    case "falsy":   return !val;
    case "in":      return Array.isArray(cond.value) && cond.value.includes(val);
    case "contains":return typeof val === "string" && val.includes(cond.value);
    default:        return false;
  }
}

/**
 * Check if a scoring snapshot matches a pattern definition.
 * @param {Object} snapshot — the scoring payload (timed:latest shape)
 * @param {Array} conditions — array of condition objects from definition_json
 * @returns {boolean}
 */
function matchesPattern(snapshot, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  return conditions.every((c) => evaluateCondition(snapshot, c));
}

/**
 * Match a scoring snapshot against all active patterns in the library.
 * @param {Object} snapshot — the scoring payload
 * @param {Array} patterns — rows from pattern_library (with definition_json parsed)
 * @returns {Array<{pattern_id, name, expected_direction, confidence}>}
 */
function matchPatterns(snapshot, patterns) {
  const matched = [];
  for (const p of patterns) {
    try {
      const conditions = typeof p.definition_json === "string"
        ? JSON.parse(p.definition_json)
        : p.definition_json;
      if (matchesPattern(snapshot, conditions)) {
        matched.push({
          pattern_id: p.pattern_id,
          name: p.name,
          expected_direction: p.expected_direction,
          confidence: p.confidence,
          expected_value: p.expected_value,
        });
      }
    } catch (e) {
      // Skip malformed patterns
    }
  }
  return matched;
}

// ─── Prediction Triggers ─────────────────────────────────────────────────────
// Determines if the current scoring snapshot warrants logging a prediction.

/**
 * Determine if a prediction should be logged for this scoring update.
 * Returns null if no prediction warranted, or a prediction descriptor.
 *
 * @param {Object} current — current scoring snapshot
 * @param {Object|null} previous — previous scoring snapshot (for detecting changes)
 * @returns {Object|null} prediction descriptor or null
 */
function shouldLogPrediction(current, previous) {
  const kanban = current.kanban_stage;
  const prevKanban = previous?.kanban_stage;
  const state = current.state;
  const prevState = previous?.state;

  // 1. Kanban stage change to an actionable stage
  if (kanban !== prevKanban) {
    if (kanban === "enter_now" || kanban === "enter") {
      return {
        trigger_type: kanban === "enter_now" ? "enter_now" : "setup",
        direction: "UP",
        confidence: current.__entry_confidence || "medium",
        entry_path: current.__entry_path || null,
        entry_reason: current.__entry_reason || null,
      };
    }
    if (kanban === "exit" || kanban === "trim") {
      return {
        trigger_type: kanban,
        direction: "DOWN",
        confidence: "medium",
        entry_path: null,
        entry_reason: current.__exit_reason || current.__trim_reason || null,
      };
    }
  }

  // 2. State quadrant flip (e.g., bear→bull or bull→bear)
  if (state && prevState && state !== prevState) {
    const wasBull = prevState.includes("BULL") && !prevState.includes("BEAR");
    const isBull = state.includes("BULL") && !state.includes("BEAR");
    const wasBear = prevState.includes("BEAR") && !prevState.includes("BULL");
    const isBear = state.includes("BEAR") && !state.includes("BULL");

    // Full quadrant flip (not just pullback change)
    if (wasBear && isBull) {
      return {
        trigger_type: "state_flip",
        direction: "UP",
        confidence: "low",
        entry_path: null,
        entry_reason: `State flip: ${prevState} → ${state}`,
      };
    }
    if (wasBull && isBear) {
      return {
        trigger_type: "state_flip",
        direction: "DOWN",
        confidence: "low",
        entry_path: null,
        entry_reason: `State flip: ${prevState} → ${state}`,
      };
    }
  }

  // 3. TD Sequential exhaustion signals (new triggers for the model)
  const tdSeq = current.td_sequential;
  const prevTdSeq = previous?.td_sequential;
  if (tdSeq) {
    // TD9 signal (new on this bar — wasn't present on previous)
    const td9BullNew = tdSeq.td9_bullish && !prevTdSeq?.td9_bullish;
    const td9BearNew = tdSeq.td9_bearish && !prevTdSeq?.td9_bearish;
    const td13BullNew = tdSeq.td13_bullish && !prevTdSeq?.td13_bullish;
    const td13BearNew = tdSeq.td13_bearish && !prevTdSeq?.td13_bearish;

    // TD13 is the stronger signal (longer sequence = more exhaustion confidence)
    if (td13BullNew) {
      return {
        trigger_type: "td13_bullish",
        direction: "UP",
        confidence: "high",
        entry_path: null,
        entry_reason: `TD13 Bullish (${tdSeq.tf || "D"}) — DeMark exhaustion sequence complete, reversal up expected`,
      };
    }
    if (td13BearNew) {
      return {
        trigger_type: "td13_bearish",
        direction: "DOWN",
        confidence: "high",
        entry_path: null,
        entry_reason: `TD13 Bearish (${tdSeq.tf || "D"}) — DeMark exhaustion sequence complete, reversal down expected`,
      };
    }
    // TD9 signals (prep phase complete = weaker but earlier signal)
    if (td9BullNew) {
      return {
        trigger_type: "td9_bullish",
        direction: "UP",
        confidence: "medium",
        entry_path: null,
        entry_reason: `TD9 Bullish (${tdSeq.tf || "D"}) — DeMark prep phase exhaustion, potential reversal up`,
      };
    }
    if (td9BearNew) {
      return {
        trigger_type: "td9_bearish",
        direction: "DOWN",
        confidence: "medium",
        entry_path: null,
        entry_reason: `TD9 Bearish (${tdSeq.tf || "D"}) — DeMark prep phase exhaustion, potential reversal down`,
      };
    }
  }

  return null;
}

/**
 * Extract TD Sequential features from a scoring snapshot for model persistence.
 * Returns a flat object of features suitable for JSON storage in features_json.
 */
function extractTDSeqFeatures(snapshot) {
  const td = snapshot?.td_sequential;
  if (!td) return null;
  return {
    td_tf: td.tf || td.timeframe || null,
    td9_bullish: !!td.td9_bullish,
    td9_bearish: !!td.td9_bearish,
    td13_bullish: !!td.td13_bullish,
    td13_bearish: !!td.td13_bearish,
    td_exit_long: !!td.exit_long,
    td_exit_short: !!td.exit_short,
    td_boost: td.boost || 0,
    td_bull_prep: td.bullish_prep_count || 0,
    td_bear_prep: td.bearish_prep_count || 0,
    td_bull_leadup: td.bullish_leadup_count || 0,
    td_bear_leadup: td.bearish_leadup_count || 0,
    // Per-timeframe breakdown (if multi-TF computation is available)
    td_d_active: !!(td.per_tf?.D?.td9_bullish || td.per_tf?.D?.td9_bearish || td.per_tf?.D?.td13_bullish || td.per_tf?.D?.td13_bearish),
    td_w_active: !!(td.per_tf?.W?.td9_bullish || td.per_tf?.W?.td9_bearish || td.per_tf?.W?.td13_bullish || td.per_tf?.W?.td13_bearish),
    td_m_active: !!(td.per_tf?.M?.td9_bullish || td.per_tf?.M?.td9_bearish || td.per_tf?.M?.td13_bullish || td.per_tf?.M?.td13_bearish),
    // Multi-TF confluence (strongest signal)
    td_multi_tf_count: [td.per_tf?.D, td.per_tf?.W, td.per_tf?.M].filter(
      (r) => r && (r.td9_bullish || r.td9_bearish || r.td13_bullish || r.td13_bearish)
    ).length,
  };
}

// ─── Prediction ID Generation ────────────────────────────────────────────────

function makePredictionId(ticker, ts, triggerType) {
  return `pred:${ticker}:${ts}:${triggerType}`;
}

function makeOutcomeId(predictionId) {
  return predictionId.replace("pred:", "out:");
}

// ─── D1 Operations ───────────────────────────────────────────────────────────

/**
 * Fetch all active patterns from pattern_library.
 */
async function getActivePatterns(DB) {
  const { results } = await DB.prepare(
    `SELECT pattern_id, name, description, expected_direction, definition_json,
            hit_rate, sample_count, confidence, expected_value, status
     FROM pattern_library WHERE status = 'active'`
  ).all();
  return results || [];
}

/**
 * Log a prediction to D1.
 */
async function logPrediction(DB, pred) {
  const id = makePredictionId(pred.ticker, pred.ts, pred.trigger_type);
  await DB.prepare(
    `INSERT OR IGNORE INTO model_predictions
     (prediction_id, ticker, ts, price, direction, trigger_type, confidence, horizon_days,
      htf_score, ltf_score, state, completion, phase_pct, rank, kanban_stage,
      entry_path, entry_reason, sector, flags_json, matched_patterns, resolved, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`
  ).bind(
    id,
    pred.ticker,
    pred.ts,
    pred.price,
    pred.direction,
    pred.trigger_type,
    pred.confidence,
    pred.horizon_days || 5,
    pred.htf_score,
    pred.ltf_score,
    pred.state,
    pred.completion,
    pred.phase_pct,
    pred.rank,
    pred.kanban_stage,
    pred.entry_path,
    pred.entry_reason,
    pred.sector,
    pred.flags_json,
    pred.matched_patterns,
    pred.ts
  ).run();

  return id;
}

/**
 * Resolve open predictions whose horizon has expired.
 * Called by the daily cron or admin endpoint.
 */
async function resolveExpiredPredictions(DB, now) {
  // Find unresolved predictions whose horizon has passed
  const { results: openPreds } = await DB.prepare(
    `SELECT prediction_id, ticker, ts, price, direction, horizon_days, matched_patterns
     FROM model_predictions
     WHERE resolved = 0 AND ts + (horizon_days * 86400000) <= ?
     LIMIT 200`
  ).bind(now).all();

  if (!openPreds || openPreds.length === 0) return { resolved: 0 };

  let resolved = 0;
  const errors = [];

  for (const pred of openPreds) {
    try {
      const horizonEnd = pred.ts + (pred.horizon_days || 5) * 86400000;

      // Get daily candles for the ticker in the horizon window
      const { results: candles } = await DB.prepare(
        `SELECT ts, h, l, c FROM ticker_candles
         WHERE ticker = ? AND tf = 'D' AND ts >= ? AND ts <= ?
         ORDER BY ts`
      ).bind(pred.ticker, pred.ts, horizonEnd + 86400000).all();

      if (!candles || candles.length === 0) {
        // No candle data yet — skip, will retry next cycle
        continue;
      }

      const startPrice = pred.price;
      let endPrice = candles[candles.length - 1].c;
      let maxHigh = startPrice;
      let minLow = startPrice;
      let peakIdx = 0;
      let troughIdx = 0;

      for (let i = 0; i < candles.length; i++) {
        if (candles[i].h > maxHigh) { maxHigh = candles[i].h; peakIdx = i; }
        if (candles[i].l < minLow) { minLow = candles[i].l; troughIdx = i; }
      }

      const actualReturnPct = ((endPrice - startPrice) / startPrice) * 100;
      const actualReturnPts = endPrice - startPrice;
      const mfePct = pred.direction === "UP"
        ? ((maxHigh - startPrice) / startPrice) * 100
        : ((startPrice - minLow) / startPrice) * 100;
      const maePct = pred.direction === "UP"
        ? ((startPrice - minLow) / startPrice) * 100
        : ((maxHigh - startPrice) / startPrice) * 100;
      const timeToPeak = pred.direction === "UP"
        ? peakIdx + 1
        : troughIdx + 1;

      // Hit = moved in predicted direction by ≥ 2%
      const HIT_THRESHOLD = 2.0;
      const dirReturn = pred.direction === "UP" ? actualReturnPct : -actualReturnPct;
      const hit = dirReturn >= HIT_THRESHOLD ? 1 : 0;
      const miss = hit ? 0 : 1;

      const absMag = Math.abs(actualReturnPct);
      const magBucket = absMag < 5 ? "small" : absMag < 15 ? "medium" : "large";

      // Check if there was a linked trade
      const { results: trades } = await DB.prepare(
        `SELECT trade_id FROM trades
         WHERE ticker = ? AND entry_ts >= ? AND entry_ts <= ?
         LIMIT 1`
      ).bind(pred.ticker, pred.ts - 86400000, pred.ts + 86400000 * 2).all();

      const tradeId = trades?.[0]?.trade_id || null;
      const isTDSeqTrigger = (pred.trigger_type || "").startsWith("td9_") || (pred.trigger_type || "").startsWith("td13_");
      const actionTaken = tradeId ? "traded" : (hit ? "missed_opportunity" : "signal_only");

      const outcomeId = makeOutcomeId(pred.prediction_id);

      await DB.prepare(
        `INSERT OR IGNORE INTO model_outcomes
         (outcome_id, prediction_id, ticker, prediction_ts, resolution_ts,
          price_at_prediction, price_at_resolution, actual_return_pct, actual_return_pts,
          max_favorable_excursion_pct, max_adverse_excursion_pct, time_to_peak_days,
          hit, miss, magnitude_bucket, trade_id, action_taken, resolution_reason, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        outcomeId,
        pred.prediction_id,
        pred.ticker,
        pred.ts,
        now,
        startPrice,
        Math.round(endPrice * 100) / 100,
        Math.round(actualReturnPct * 100) / 100,
        Math.round(actualReturnPts * 100) / 100,
        Math.round(mfePct * 100) / 100,
        Math.round(maePct * 100) / 100,
        timeToPeak,
        hit,
        miss,
        magBucket,
        tradeId,
        actionTaken,
        isTDSeqTrigger ? `horizon_expired:td_sequential:${pred.trigger_type}` : "horizon_expired",
        now
      ).run();

      // Mark prediction as resolved
      await DB.prepare(
        `UPDATE model_predictions SET resolved = 1, outcome_id = ? WHERE prediction_id = ?`
      ).bind(outcomeId, pred.prediction_id).run();

      // Update pattern hit rates
      if (pred.matched_patterns) {
        const patternIds = pred.matched_patterns.split(",").filter(Boolean);
        for (const pid of patternIds) {
          await updatePatternStats(DB, pid, hit, actualReturnPct, now);
        }
      }

      resolved++;
    } catch (e) {
      errors.push({ prediction_id: pred.prediction_id, error: String(e.message || e).slice(0, 200) });
    }
  }

  return { resolved, errors: errors.length > 0 ? errors : undefined };
}

/**
 * Update a pattern's hit rate and stats after an outcome.
 */
async function updatePatternStats(DB, patternId, hit, returnPct, now) {
  const { results } = await DB.prepare(
    `SELECT hit_rate, sample_count, avg_return, confidence, status FROM pattern_library WHERE pattern_id = ?`
  ).bind(patternId).all();

  if (!results || results.length === 0) return;

  const p = results[0];
  const newCount = (p.sample_count || 0) + 1;
  const oldHits = Math.round((p.hit_rate || 0) * (p.sample_count || 0));
  const newHits = oldHits + (hit ? 1 : 0);
  const newHitRate = newCount > 0 ? newHits / newCount : 0;
  const newAvgReturn = ((p.avg_return || 0) * (p.sample_count || 0) + returnPct) / newCount;

  // Simple confidence update: blend prior with observed hit rate
  // More samples → more weight on observed
  const alpha = Math.min(0.1, 1 / newCount); // learning rate decays with samples
  const newConfidence = (1 - alpha) * (p.confidence || 0.5) + alpha * (hit ? 1 : 0);

  // Check for degradation: hit rate dropped below 40%
  let newStatus = p.status;
  if (newCount >= 10 && newHitRate < 0.40 && p.status === "active") {
    newStatus = "degraded";
    // Log the degradation
    await DB.prepare(
      `INSERT INTO model_changelog (change_id, change_type, pattern_id, description,
       old_value_json, new_value_json, evidence_json, status, proposed_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      `chg:degrade:${patternId}:${now}`,
      "degrade_pattern",
      patternId,
      `Pattern "${patternId}" hit rate dropped to ${(newHitRate * 100).toFixed(1)}% (n=${newCount}). Auto-degraded.`,
      JSON.stringify({ hit_rate: p.hit_rate, status: p.status }),
      JSON.stringify({ hit_rate: newHitRate, status: "degraded" }),
      JSON.stringify({ sample_count: newCount, recent_hit: hit, recent_return: returnPct }),
      "auto_applied",
      now,
      now
    ).run();
  }

  await DB.prepare(
    `UPDATE pattern_library
     SET hit_rate = ?, sample_count = ?, avg_return = ?, confidence = ?,
         status = ?, last_hit_ts = ?, last_updated = ?
     WHERE pattern_id = ?`
  ).bind(
    Math.round(newHitRate * 10000) / 10000,
    newCount,
    Math.round(newAvgReturn * 100) / 100,
    Math.round(newConfidence * 10000) / 10000,
    newStatus,
    hit ? now : p.last_hit_ts,
    now,
    patternId
  ).run();
}

/**
 * Get model health summary for dashboards.
 */
async function getModelHealth(DB) {
  const [predictions, outcomes, patterns, pendingChanges] = await Promise.all([
    DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN resolved=0 THEN 1 ELSE 0 END) as open FROM model_predictions`).first(),
    DB.prepare(`SELECT COUNT(*) as total, SUM(hit) as hits, SUM(miss) as misses, AVG(actual_return_pct) as avg_return FROM model_outcomes`).first(),
    DB.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='degraded' THEN 1 ELSE 0 END) as degraded FROM pattern_library`).first(),
    DB.prepare(`SELECT COUNT(*) as total FROM model_changelog WHERE status = 'proposed'`).first(),
  ]);

  const hitRate = outcomes.total > 0 ? (outcomes.hits / outcomes.total * 100) : 0;

  return {
    predictions: { total: predictions.total, open: predictions.open },
    outcomes: {
      total: outcomes.total,
      hits: outcomes.hits,
      misses: outcomes.misses,
      hitRate: Math.round(hitRate * 10) / 10,
      avgReturn: Math.round((outcomes.avg_return || 0) * 100) / 100,
    },
    patterns: { total: patterns.total, active: patterns.active, degraded: patterns.degraded },
    pendingChanges: pendingChanges.total,
  };
}

// ─── Weekly Retrospective (worker-native, lightweight) ───────────────────────
// Runs inside the worker cron — evaluates recent prediction outcomes,
// detects pattern degradation, and writes proposals to model_changelog.

/**
 * Run the automated weekly retrospective.
 * Uses only the D1 binding (no shell/wrangler), designed for cron execution.
 *
 * Steps:
 *   1. Resolve any outstanding predictions
 *   2. Compute per-pattern performance from model_outcomes (recent vs all-time)
 *   3. Compare recent hit rates to seeded baselines
 *   4. Detect regime changes from daily candle data (recent 30d vs prior 60d)
 *   5. Write proposals to model_changelog
 *   6. Return a summary
 */
async function runWeeklyRetrospective(DB) {
  const now = Date.now();
  const RECENT_MS = 30 * 86400000;
  const recentStart = now - RECENT_MS;
  const results = { resolved: 0, patternsEvaluated: 0, regimeShifts: [], proposals: [], errors: [] };

  try {
    // Step 1: Resolve outstanding predictions first
    const resolution = await resolveExpiredPredictions(DB, now);
    results.resolved = resolution.resolved || 0;

    // Step 2: Per-pattern performance from outcomes
    const patterns = await getActivePatterns(DB);
    results.patternsEvaluated = patterns.length;

    for (const pattern of patterns) {
      try {
        // All-time outcomes for this pattern
        const { results: allOutcomes } = await DB.prepare(
          `SELECT mo.hit, mo.actual_return_pct FROM model_outcomes mo
           JOIN model_predictions mp ON mp.prediction_id = mo.prediction_id
           WHERE mp.matched_patterns LIKE ?`
        ).bind(`%${pattern.pattern_id}%`).all();

        // Recent outcomes (last 30 days)
        const { results: recentOutcomes } = await DB.prepare(
          `SELECT mo.hit, mo.actual_return_pct FROM model_outcomes mo
           JOIN model_predictions mp ON mp.prediction_id = mo.prediction_id
           WHERE mp.matched_patterns LIKE ? AND mp.ts >= ?`
        ).bind(`%${pattern.pattern_id}%`, recentStart).all();

        if (!allOutcomes || allOutcomes.length < 5) continue;

        const allHitRate = allOutcomes.filter((o) => o.hit).length / allOutcomes.length;
        const recentHitRate = recentOutcomes && recentOutcomes.length >= 3
          ? recentOutcomes.filter((o) => o.hit).length / recentOutcomes.length
          : null;

        // Detect degradation: recent hit rate significantly below all-time
        if (recentHitRate !== null && recentOutcomes.length >= 5) {
          const shift = recentHitRate - allHitRate;
          if (Math.abs(shift) > 0.15) {
            results.regimeShifts.push({
              pattern_id: pattern.pattern_id,
              name: pattern.name,
              allHitRate: Math.round(allHitRate * 100),
              recentHitRate: Math.round(recentHitRate * 100),
              shift: Math.round(shift * 100),
              allN: allOutcomes.length,
              recentN: recentOutcomes.length,
            });

            // Write proposal
            const changeType = shift < 0 ? "degrade_pattern" : "promote_pattern";
            const desc = shift < 0
              ? `Pattern "${pattern.name}" degrading: recent 30d hit rate ${Math.round(recentHitRate * 100)}% vs all-time ${Math.round(allHitRate * 100)}% (n_recent=${recentOutcomes.length})`
              : `Pattern "${pattern.name}" improving: recent 30d hit rate ${Math.round(recentHitRate * 100)}% vs all-time ${Math.round(allHitRate * 100)}% (n_recent=${recentOutcomes.length})`;

            await DB.prepare(
              `INSERT OR IGNORE INTO model_changelog
               (change_id, change_type, pattern_id, description, evidence_json, status, proposed_at, created_at)
               VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)`
            ).bind(
              `chg:weekly:${pattern.pattern_id}:${now}`,
              changeType,
              pattern.pattern_id,
              desc,
              JSON.stringify({ allHitRate, recentHitRate, allN: allOutcomes.length, recentN: recentOutcomes.length }),
              now,
              now
            ).run();

            results.proposals.push({ type: changeType, pattern_id: pattern.pattern_id, description: desc });
          }
        }
      } catch (e) {
        results.errors.push({ pattern_id: pattern.pattern_id, error: String(e?.message || e).slice(0, 150) });
      }
    }

    // Step 3: Market regime from daily candles (universe-level UP/DOWN ratio)
    try {
      const { results: recentCandles } = await DB.prepare(
        `SELECT ticker, ts, c FROM ticker_candles WHERE tf = 'D' AND ts >= ? ORDER BY ticker, ts`
      ).bind(now - 90 * 86400000).all();

      if (recentCandles && recentCandles.length > 0) {
        // Compute 5-day returns for each ticker
        const byTicker = {};
        for (const c of recentCandles) {
          if (!byTicker[c.ticker]) byTicker[c.ticker] = [];
          byTicker[c.ticker].push(c);
        }

        let recentUpMoves = 0, recentDownMoves = 0, histUpMoves = 0, histDownMoves = 0;
        for (const candles of Object.values(byTicker)) {
          for (let i = 0; i + 5 < candles.length; i++) {
            const ret = ((candles[i + 5].c - candles[i].c) / candles[i].c) * 100;
            if (Math.abs(ret) < 5) continue;
            const isRecent = candles[i].ts >= recentStart;
            if (ret > 0) { if (isRecent) recentUpMoves++; else histUpMoves++; }
            else { if (isRecent) recentDownMoves++; else histDownMoves++; }
          }
        }

        const recentTotal = recentUpMoves + recentDownMoves;
        const histTotal = histUpMoves + histDownMoves;
        if (recentTotal >= 20 && histTotal >= 20) {
          const recentUpPct = (recentUpMoves / recentTotal) * 100;
          const histUpPct = (histUpMoves / histTotal) * 100;
          results.marketRegime = {
            recentUpPct: Math.round(recentUpPct),
            histUpPct: Math.round(histUpPct),
            shift: Math.round(recentUpPct - histUpPct),
            recentMoves: recentTotal,
            histMoves: histTotal,
          };

          if (Math.abs(recentUpPct - histUpPct) > 15) {
            const desc = `Market regime shift: recent 30d ${Math.round(recentUpPct)}% UP vs prior 60d ${Math.round(histUpPct)}% UP (shift ${Math.round(recentUpPct - histUpPct)}pp)`;
            await DB.prepare(
              `INSERT OR IGNORE INTO model_changelog
               (change_id, change_type, description, evidence_json, status, proposed_at, created_at)
               VALUES (?, 'market_regime_change', ?, ?, 'proposed', ?, ?)`
            ).bind(
              `chg:regime:${now}`,
              desc,
              JSON.stringify(results.marketRegime),
              now,
              now
            ).run();
            results.proposals.push({ type: "market_regime_change", description: desc });
          }
        }
      }
    } catch (e) {
      results.errors.push({ step: "market_regime", error: String(e?.message || e).slice(0, 150) });
    }

  } catch (e) {
    results.errors.push({ step: "top_level", error: String(e?.message || e).slice(0, 200) });
  }

  return results;
}

// ─── Multi-Level Predictions (Phase 3.3) ─────────────────────────────────────
// Computes real-time predictions at ticker, sector, and market level
// by aggregating pattern matches across the universe.

/**
 * Compute multi-level predictions from the current ticker universe.
 * @param {D1Database} DB
 * @param {Object} sectorMap — { ticker: sector }
 * @returns {Object} { ticker, sector, market }
 */
async function computeMultiLevelPredictions(DB, sectorMap) {
  const now = Date.now();
  const activePatterns = await getActivePatterns(DB);

  // Fetch latest scoring snapshots from D1 (ticker_latest)
  const { results: latestRows } = await DB.prepare(
    `SELECT ticker, payload_json, kanban_stage FROM ticker_latest WHERE ts > ? ORDER BY ticker`
  ).bind(now - 2 * 86400000).all();

  if (!latestRows || latestRows.length === 0) {
    return { ticker: [], sector: [], market: null };
  }

  // Parse payloads and match against patterns
  const tickerPredictions = [];
  const sectorAgg = {}; // sector → { bullish: [], bearish: [], neutral: [] }

  for (const row of latestRows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }

    const ticker = row.ticker;
    const sector = sectorMap?.[ticker] || payload.sector || "Unknown";
    const matched = matchPatterns(payload, activePatterns);

    if (matched.length === 0) continue;

    // Classify matches
    const bullPatterns = matched.filter((m) => m.expected_direction === "UP");
    const bearPatterns = matched.filter((m) => m.expected_direction === "DOWN");

    const bullConfidence = bullPatterns.length > 0
      ? bullPatterns.reduce((s, m) => s + (m.confidence || 0.5), 0) / bullPatterns.length
      : 0;
    const bearConfidence = bearPatterns.length > 0
      ? bearPatterns.reduce((s, m) => s + (m.confidence || 0.5), 0) / bearPatterns.length
      : 0;

    const netSignal = bullConfidence - bearConfidence;
    const direction = netSignal > 0.1 ? "BULLISH" : netSignal < -0.1 ? "BEARISH" : "NEUTRAL";

    const topBullEV = bullPatterns.length > 0
      ? Math.max(...bullPatterns.map((m) => m.expected_value || 0))
      : 0;
    const topBearEV = bearPatterns.length > 0
      ? Math.min(...bearPatterns.map((m) => m.expected_value || 0))
      : 0;

    // Extract TD Sequential features for enrichment
    const tdFeatures = extractTDSeqFeatures(payload);
    const tdSeq = payload.td_sequential;

    const pred = {
      ticker,
      sector,
      direction,
      bullPatterns: bullPatterns.length,
      bearPatterns: bearPatterns.length,
      bullConfidence: Math.round(bullConfidence * 100) / 100,
      bearConfidence: Math.round(bearConfidence * 100) / 100,
      netSignal: Math.round(netSignal * 100) / 100,
      topBullEV: Math.round(topBullEV * 10) / 10,
      topBearEV: Math.round(topBearEV * 10) / 10,
      matchedPatterns: matched.map((m) => m.pattern_id),
      kanbanStage: row.kanban_stage,
      price: payload.price,
      htfScore: payload.htf_score,
      ltfScore: payload.ltf_score,
      state: payload.state,
      // TD Sequential enrichment
      td_sequential: tdSeq ? {
        tf: tdSeq.tf,
        td9_bullish: !!tdSeq.td9_bullish,
        td9_bearish: !!tdSeq.td9_bearish,
        td13_bullish: !!tdSeq.td13_bullish,
        td13_bearish: !!tdSeq.td13_bearish,
        exit_long: !!tdSeq.exit_long,
        exit_short: !!tdSeq.exit_short,
        boost: tdSeq.boost || 0,
        multi_tf_count: tdFeatures?.td_multi_tf_count || 0,
      } : null,
    };

    tickerPredictions.push(pred);

    // Aggregate into sector
    if (!sectorAgg[sector]) sectorAgg[sector] = { bullish: 0, bearish: 0, neutral: 0, tickers: [] };
    if (direction === "BULLISH") sectorAgg[sector].bullish++;
    else if (direction === "BEARISH") sectorAgg[sector].bearish++;
    else sectorAgg[sector].neutral++;
    sectorAgg[sector].tickers.push(pred);
  }

  // Sort ticker predictions by net signal strength
  tickerPredictions.sort((a, b) => Math.abs(b.netSignal) - Math.abs(a.netSignal));

  // Sector-level predictions
  const sectorPredictions = Object.entries(sectorAgg)
    .map(([sector, data]) => {
      const total = data.bullish + data.bearish + data.neutral;
      const breadthBull = total > 0 ? (data.bullish / total) * 100 : 0;
      const breadthBear = total > 0 ? (data.bearish / total) * 100 : 0;
      const avgBullConf = data.tickers.filter((t) => t.direction === "BULLISH").length > 0
        ? data.tickers.filter((t) => t.direction === "BULLISH").reduce((s, t) => s + t.bullConfidence, 0) / data.bullish
        : 0;

      return {
        sector,
        total,
        bullish: data.bullish,
        bearish: data.bearish,
        neutral: data.neutral,
        breadthBullPct: Math.round(breadthBull),
        breadthBearPct: Math.round(breadthBear),
        avgBullConfidence: Math.round(avgBullConf * 100) / 100,
        regime: breadthBull > 60 ? "BULLISH" : breadthBear > 60 ? "BEARISH" : "MIXED",
        topBullish: data.tickers.filter((t) => t.direction === "BULLISH").sort((a, b) => b.netSignal - a.netSignal).slice(0, 3).map((t) => t.ticker),
        topBearish: data.tickers.filter((t) => t.direction === "BEARISH").sort((a, b) => a.netSignal - b.netSignal).slice(0, 3).map((t) => t.ticker),
      };
    })
    .sort((a, b) => b.total - a.total);

  // Market-level prediction
  const totalTickers = tickerPredictions.length;
  const marketBullish = tickerPredictions.filter((t) => t.direction === "BULLISH").length;
  const marketBearish = tickerPredictions.filter((t) => t.direction === "BEARISH").length;
  const marketNeutral = totalTickers - marketBullish - marketBearish;
  const marketBreadthBull = totalTickers > 0 ? (marketBullish / totalTickers) * 100 : 0;

  const marketPrediction = {
    totalTickers,
    bullish: marketBullish,
    bearish: marketBearish,
    neutral: marketNeutral,
    breadthBullPct: Math.round(marketBreadthBull),
    breadthBearPct: Math.round(totalTickers > 0 ? (marketBearish / totalTickers) * 100 : 0),
    regime: totalTickers < 10 ? "INSUFFICIENT_DATA" : marketBreadthBull > 55 ? "BULLISH" : marketBreadthBull < 40 ? "BEARISH" : "MIXED",
    signal: totalTickers < 10 ? "INSUFFICIENT_DATA" : marketBreadthBull > 70 ? "STRONG_BULL" : marketBreadthBull > 55 ? "MILD_BULL" : marketBreadthBull < 30 ? "STRONG_BEAR" : marketBreadthBull < 45 ? "MILD_BEAR" : "NEUTRAL",
    riskFlag: totalTickers < 10 ? null : marketBreadthBull > 80 ? "EXTREME_CONCENTRATION — mean reversion risk" : marketBreadthBull < 20 ? "EXTREME_BEARISH — potential capitulation/bounce" : null,
  };

  return {
    generated: new Date().toISOString(),
    ticker: tickerPredictions.slice(0, 50), // top 50 by signal strength
    sector: sectorPredictions,
    market: marketPrediction,
  };
}

export {
  matchesPattern,
  matchPatterns,
  shouldLogPrediction,
  extractTDSeqFeatures,
  makePredictionId,
  makeOutcomeId,
  getActivePatterns,
  logPrediction,
  resolveExpiredPredictions,
  updatePatternStats,
  getModelHealth,
  runWeeklyRetrospective,
  computeMultiLevelPredictions,
};
