#!/usr/bin/env node
/**
 * Model Calibration Pipeline
 *
 * Three-step process:
 *   1. Harvest Moves — scan daily candles, compute ATR, identify significant moves, capture signal profiles
 *   2. Autopsy Trades — compute MFE/MAE from 5m candles, exit efficiency, classify trades
 *   3. Trigger server-side analysis — upload data and run gap analysis
 *
 * Usage:
 *   node scripts/calibrate.js [--lookback 400] [--ticker AAPL] [--dry-run] [--skip-moves] [--skip-autopsy]
 */

const { execSync } = require("child_process");
const path = require("path");

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : dflt;
};
const hasFlag = (name) => args.includes(`--${name}`);

const LOOKBACK_DAYS = Number(getArg("lookback", "400"));
const TICKER_FILTER = getArg("ticker", null);
const DRY_RUN = hasFlag("dry-run");
const SKIP_MOVES = hasFlag("skip-moves");
const SKIP_AUTOPSY = hasFlag("skip-autopsy");

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

const WORKER_DIR = path.join(__dirname, "../worker");

function queryD1(sql) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
  if (parsed?.results) return parsed.results;
  return [];
}

function queryD1Chunked(baseSql, chunkSize = 15000) {
  let all = [];
  let offset = 0;
  while (true) {
    const rows = queryD1(`${baseSql} LIMIT ${chunkSize} OFFSET ${offset}`);
    all = all.concat(rows);
    if (rows.length < chunkSize) break;
    offset += chunkSize;
  }
  return all;
}

async function apiPost(endpoint, body) {
  const resp = await fetch(`${API_BASE}${endpoint}?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json();
}

function computeATR(candles, period = 14) {
  const atrs = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    if (i < period) {
      atrs[i] = atrs[i - 1] + (tr - atrs[i - 1]) / i;
    } else {
      atrs[i] = atrs[i - 1] + (tr - atrs[i - 1]) / period;
    }
  }
  return atrs;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║   Model Calibration Pipeline                         ║`);
console.log(`╚══════════════════════════════════════════════════════╝`);
console.log(`  Lookback: ${LOOKBACK_DAYS} days`);
console.log(`  Ticker filter: ${TICKER_FILTER || "ALL"}`);
console.log(`  Dry run: ${DRY_RUN}`);
console.log();

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: Harvest Moves
// ═══════════════════════════════════════════════════════════════════════════

let harvestedMoves = [];

if (!SKIP_MOVES) {
  console.log("═══ Step 1: Harvesting Moves ═══\n");

  const tickerWhere = TICKER_FILTER ? `AND ticker='${TICKER_FILTER}'` : "";
  console.log("  Fetching daily candles...");
  const rawCandles = queryD1Chunked(
    `SELECT ticker, ts, o, h, l, c, v FROM ticker_candles WHERE tf='D' ${tickerWhere} ORDER BY ticker, ts`
  );
  console.log(`  Total: ${rawCandles.length} daily candles`);

  const byTicker = {};
  for (const c of rawCandles) {
    const t = String(c.ticker).toUpperCase();
    (byTicker[t] = byTicker[t] || []).push({
      ts: Number(c.ts), o: Number(c.o), h: Number(c.h),
      l: Number(c.l), c: Number(c.c), v: Number(c.v || 0),
    });
  }
  for (const t of Object.keys(byTicker)) byTicker[t].sort((a, b) => a.ts - b.ts);

  const tickers = Object.keys(byTicker).filter(t => byTicker[t].length >= 30);
  console.log(`  Analyzing ${tickers.length} tickers\n`);

  // Fetch trail data for signal profiles
  console.log("  Fetching trail_5m_facts for signal snapshots...");
  const trailRows = queryD1Chunked(
    `SELECT ticker, bucket_ts, htf_score_avg, ltf_score_avg, state, rank,
            had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite
     FROM trail_5m_facts ORDER BY ticker, bucket_ts`
  );
  console.log(`  Trail rows: ${trailRows.length}`);

  const trailByTicker = {};
  for (const r of trailRows) {
    const t = String(r.ticker).toUpperCase();
    (trailByTicker[t] = trailByTicker[t] || []).push(r);
  }

  // Fetch direction_accuracy for signal snapshots at move starts
  console.log("  Fetching direction_accuracy signal snapshots...");
  const daRows = queryD1Chunked(
    `SELECT ticker, ts, signal_snapshot_json, regime_daily, regime_weekly, regime_combined,
            entry_path, rank, htf_score, ltf_score
     FROM direction_accuracy WHERE signal_snapshot_json IS NOT NULL ORDER BY ticker, ts`
  );
  console.log(`  Direction accuracy rows with signals: ${daRows.length}\n`);

  const daByTicker = {};
  for (const r of daRows) {
    const t = String(r.ticker).toUpperCase();
    (daByTicker[t] = daByTicker[t] || []).push(r);
  }

  const MIN_ATR_MULTIPLE = 1.5;
  const MIN_DURATION = 3;

  for (const ticker of tickers) {
    const candles = byTicker[ticker];
    const atrs = computeATR(candles);

    for (let i = MIN_DURATION; i < candles.length; i++) {
      const atr = atrs[i] || atrs[i - 1];
      if (!atr || atr <= 0) continue;

      // Look back from candle i to find swing low/high
      // Scan backward for a local extremum that starts a sustained move
      for (let lookback = MIN_DURATION; lookback <= Math.min(40, i); lookback++) {
        const startIdx = i - lookback;
        const startAtr = atrs[startIdx] || atr;
        if (startAtr <= 0) continue;

        const startPrice = candles[startIdx].c;
        const endPrice = candles[i].c;
        const movePct = ((endPrice - startPrice) / startPrice) * 100;
        const moveAtr = Math.abs(endPrice - startPrice) / startAtr;

        if (moveAtr < MIN_ATR_MULTIPLE || lookback < MIN_DURATION) continue;

        const direction = movePct > 0 ? "UP" : "DOWN";

        // Compute MFE/MAE within the move window
        let maxExt = 0, maxPull = 0;
        for (let j = startIdx + 1; j <= i; j++) {
          if (direction === "UP") {
            const ext = (candles[j].h - startPrice) / startAtr;
            const pull = (startPrice - candles[j].l) / startAtr;
            maxExt = Math.max(maxExt, ext);
            maxPull = Math.max(maxPull, pull);
          } else {
            const ext = (startPrice - candles[j].l) / startAtr;
            const pull = (candles[j].h - startPrice) / startAtr;
            maxExt = Math.max(maxExt, ext);
            maxPull = Math.max(maxPull, pull);
          }
        }

        // Find closest trail snapshot to move start
        let signalsJson = null, regimeJson = null;
        const trail = trailByTicker[ticker];
        if (trail) {
          const startTs = candles[startIdx].ts;
          let closest = null, minDist = Infinity;
          for (const r of trail) {
            const dist = Math.abs(Number(r.bucket_ts) - startTs);
            if (dist < minDist) { minDist = dist; closest = r; }
          }
          if (closest && minDist < 2 * 86400000) {
            signalsJson = JSON.stringify({
              htf_score: Number(closest.htf_score_avg) || 0,
              ltf_score: Number(closest.ltf_score_avg) || 0,
              state: closest.state,
              rank: Number(closest.rank) || 0,
              squeeze_release: closest.had_squeeze_release ? 1 : 0,
              ema_cross: closest.had_ema_cross ? 1 : 0,
              st_flip: closest.had_st_flip ? 1 : 0,
              momentum_elite: closest.had_momentum_elite ? 1 : 0,
            });
          }
        }

        // Check direction_accuracy for richer signal snapshot
        const da = daByTicker[ticker];
        if (da) {
          const startTs = candles[startIdx].ts;
          let closest = null, minDist = Infinity;
          for (const r of da) {
            const dist = Math.abs(Number(r.ts) - startTs);
            if (dist < minDist) { minDist = dist; closest = r; }
          }
          if (closest && minDist < 3 * 86400000) {
            signalsJson = closest.signal_snapshot_json || signalsJson;
            regimeJson = JSON.stringify({
              daily: closest.regime_daily, weekly: closest.regime_weekly,
              combined: closest.regime_combined,
            });
          }
        }

        // Compute optimal SL/TP from within-move candle data
        const withinMoveMAEs = [];
        const withinMoveMFEs = [];
        for (let j = startIdx + 1; j <= i; j++) {
          if (direction === "UP") {
            withinMoveMFEs.push((candles[j].h - startPrice) / startAtr);
            withinMoveMAEs.push((startPrice - candles[j].l) / startAtr);
          } else {
            withinMoveMFEs.push((startPrice - candles[j].l) / startAtr);
            withinMoveMAEs.push((candles[j].h - startPrice) / startAtr);
          }
        }

        const moveId = `${ticker}_${direction}_${candles[startIdx].ts}`;
        harvestedMoves.push({
          move_id: moveId,
          ticker, direction,
          start_ts: candles[startIdx].ts,
          end_ts: candles[i].ts,
          duration_days: lookback,
          move_pct: Math.round(movePct * 100) / 100,
          move_atr: Math.round(moveAtr * 100) / 100,
          max_ext_atr: Math.round(maxExt * 100) / 100,
          pullback_atr: Math.round(maxPull * 100) / 100,
          sl_optimal_atr: Math.round(percentile(withinMoveMAEs.filter(v => v > 0), 75) * 100) / 100,
          tp_p50_atr: Math.round(percentile(withinMoveMFEs, 50) * 100) / 100,
          tp_p75_atr: Math.round(percentile(withinMoveMFEs, 75) * 100) / 100,
          tp_p90_atr: Math.round(percentile(withinMoveMFEs, 90) * 100) / 100,
          signals_json: signalsJson,
          regime_json: regimeJson,
        });

        break; // only capture the longest move starting from this point
      }
    }
  }

  // Deduplicate: keep the largest move_atr per ticker+direction within 3-day buckets
  harvestedMoves.sort((a, b) => b.move_atr - a.move_atr);
  const moveSeen = new Set();
  const dedupedMoves = [];
  for (const m of harvestedMoves) {
    const bucket = Math.floor(m.start_ts / (3 * 86400000));
    const key = `${m.ticker}:${m.direction}:${bucket}`;
    if (moveSeen.has(key)) continue;
    moveSeen.add(key);
    moveSeen.add(`${m.ticker}:${m.direction}:${bucket - 1}`);
    moveSeen.add(`${m.ticker}:${m.direction}:${bucket + 1}`);
    dedupedMoves.push(m);
  }
  harvestedMoves = dedupedMoves;

  console.log(`  Moves found: ${harvestedMoves.length}`);
  console.log(`    UP: ${harvestedMoves.filter(m => m.direction === "UP").length}`);
  console.log(`    DOWN: ${harvestedMoves.filter(m => m.direction === "DOWN").length}`);
  if (harvestedMoves.length) {
    const avgAtr = harvestedMoves.reduce((s, m) => s + m.move_atr, 0) / harvestedMoves.length;
    console.log(`    Avg move: ${avgAtr.toFixed(2)} ATR`);
  }
  console.log();
} else {
  console.log("  Skipping move harvesting (--skip-moves)\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: Autopsy Trades
// ═══════════════════════════════════════════════════════════════════════════

let autopsiedTrades = [];

if (!SKIP_AUTOPSY) {
  console.log("═══ Step 2: Autopsying Trades ═══\n");

  const tickerWhere = TICKER_FILTER ? `AND t.ticker='${TICKER_FILTER}'` : "";
  console.log("  Fetching closed trades...");
  const trades = queryD1Chunked(
    `SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.exit_ts,
            t.entry_price, t.exit_price, t.pnl_pct, t.rank, t.rr, t.status, t.entry_path,
            da.signal_snapshot_json, da.regime_daily, da.regime_weekly, da.regime_combined,
            da.entry_path AS da_entry_path
     FROM trades t
     LEFT JOIN direction_accuracy da ON da.trade_id = t.trade_id
     WHERE t.status IN ('CLOSED','TP_HIT','SL_HIT','MANUAL_EXIT','TP_HIT_TRIM') ${tickerWhere}
     ORDER BY t.entry_ts`
  );
  console.log(`  Closed trades: ${trades.length}`);

  if (trades.length === 0) {
    console.log("  No closed trades found. Skipping autopsy.\n");
  } else {
    // Fetch 5m candles for MFE/MAE computation
    console.log("  Fetching 5-minute candles for MFE/MAE...");
    const tickersNeeded = [...new Set(trades.map(t => String(t.ticker).toUpperCase()))];
    const fiveMinCandles = {};

    for (const ticker of tickersNeeded) {
      const rows = queryD1Chunked(
        `SELECT ts, h, l, c FROM ticker_candles WHERE tf='5' AND ticker='${ticker}' ORDER BY ts`
      );
      if (rows.length) fiveMinCandles[ticker] = rows;
    }
    console.log(`  5m candle tickers loaded: ${Object.keys(fiveMinCandles).length}`);

    // Also need daily candles for ATR per trade
    console.log("  Fetching daily candles for ATR...");
    const dailyByTicker = {};
    for (const ticker of tickersNeeded) {
      const rows = queryD1Chunked(
        `SELECT ts, o, h, l, c FROM ticker_candles WHERE tf='D' AND ticker='${ticker}' ORDER BY ts`
      );
      if (rows.length) {
        const candles = rows.map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
        const atrs = computeATR(candles);
        dailyByTicker[ticker] = { candles, atrs };
      }
    }
    console.log(`  Daily candle tickers loaded: ${Object.keys(dailyByTicker).length}\n`);

    for (const trade of trades) {
      const ticker = String(trade.ticker).toUpperCase();
      const entryTs = Number(trade.entry_ts);
      const exitTs = Number(trade.exit_ts);
      const entryPrice = Number(trade.entry_price);
      const exitPrice = Number(trade.exit_price);
      const direction = String(trade.direction).toUpperCase();
      const isLong = direction === "LONG";

      if (!entryTs || !exitTs || !entryPrice || !exitPrice) continue;

      // Find ATR at entry from daily candles
      let atrAtEntry = 0;
      const daily = dailyByTicker[ticker];
      if (daily) {
        let closestIdx = 0, minDist = Infinity;
        for (let i = 0; i < daily.candles.length; i++) {
          const d = Math.abs(daily.candles[i].ts - entryTs);
          if (d < minDist) { minDist = d; closestIdx = i; }
        }
        atrAtEntry = daily.atrs[closestIdx] || 0;
      }
      if (atrAtEntry <= 0) atrAtEntry = entryPrice * 0.02; // fallback 2%

      // Compute SL price (from rr + entry/exit data or estimate)
      const rr = Number(trade.rr) || 2;
      const pnlPct = Number(trade.pnl_pct) || 0;
      const actualPnl = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
      const estimatedRisk = atrAtEntry * 1.5; // default SL distance if unknown
      let slPrice = isLong ? entryPrice - estimatedRisk : entryPrice + estimatedRisk;

      // R-multiple
      const initialRisk = Math.abs(entryPrice - slPrice) || atrAtEntry;
      const rMultiple = actualPnl / initialRisk;

      // Compute MFE/MAE from 5m candles
      let mfePct = 0, maePct = 0, mfeAtr = 0, maeAtr = 0;
      let timeToMfeMin = 0, slHitBeforeMfe = false;
      let mfeTs = entryTs;

      const candles5m = fiveMinCandles[ticker];
      if (candles5m) {
        const during = candles5m.filter(c => {
          const ts = Number(c.ts);
          return ts >= entryTs && ts <= exitTs;
        });

        let maxFav = 0, maxAdv = 0;
        for (const c of during) {
          const high = Number(c.h), low = Number(c.l);
          if (isLong) {
            const fav = (high - entryPrice) / entryPrice * 100;
            const adv = (entryPrice - low) / entryPrice * 100;
            if (fav > maxFav) { maxFav = fav; mfeTs = Number(c.ts); }
            maxAdv = Math.max(maxAdv, adv);
          } else {
            const fav = (entryPrice - low) / entryPrice * 100;
            const adv = (high - entryPrice) / entryPrice * 100;
            if (fav > maxFav) { maxFav = fav; mfeTs = Number(c.ts); }
            maxAdv = Math.max(maxAdv, adv);
          }
        }
        mfePct = Math.round(maxFav * 100) / 100;
        maePct = Math.round(maxAdv * 100) / 100;
        mfeAtr = atrAtEntry > 0 ? Math.round((maxFav / 100 * entryPrice / atrAtEntry) * 100) / 100 : 0;
        maeAtr = atrAtEntry > 0 ? Math.round((maxAdv / 100 * entryPrice / atrAtEntry) * 100) / 100 : 0;
        timeToMfeMin = Math.round((mfeTs - entryTs) / 60000);
        slHitBeforeMfe = maxAdv > (estimatedRisk / entryPrice * 100) && mfeTs > entryTs;
      }

      // Exit efficiency
      const mfePnl = mfePct > 0 ? mfePct : 0.01;
      const exitEfficiency = mfePnl > 0 ? Math.round((Math.max(0, pnlPct) / mfePnl) * 100) / 100 : 0;

      // Optimal hold time
      const actualHoldMin = (exitTs - entryTs) / 60000;
      const optimalHoldMin = timeToMfeMin;

      // Classification
      let classification = "noise_trade";
      if (mfeAtr < 0.5 && maeAtr < 0.5) {
        classification = "noise_trade";
      } else if (maePct > mfePct && pnlPct <= 0) {
        classification = "bad_entry";
      } else if (pnlPct > 0 && exitEfficiency >= 0.7) {
        classification = "optimal";
      } else if (pnlPct > 0 && exitEfficiency < 0.5) {
        classification = "left_money";
      } else if (mfePct > 1 && pnlPct <= 0) {
        classification = "gave_back";
      } else if (pnlPct <= 0) {
        classification = "bad_entry";
      } else {
        classification = "left_money";
      }

      autopsiedTrades.push({
        trade_id: trade.trade_id,
        ticker, direction,
        entry_ts: entryTs, exit_ts: exitTs,
        entry_price: entryPrice, exit_price: exitPrice,
        sl_price: Math.round(slPrice * 100) / 100,
        pnl_pct: pnlPct,
        r_multiple: Math.round(rMultiple * 100) / 100,
        mfe_pct: mfePct, mfe_atr: mfeAtr,
        mae_pct: maePct, mae_atr: maeAtr,
        exit_efficiency: exitEfficiency,
        sl_hit_before_mfe: slHitBeforeMfe,
        time_to_mfe_min: timeToMfeMin,
        optimal_hold_min: optimalHoldMin,
        classification,
        entry_signals_json: trade.signal_snapshot_json || null,
        entry_path: trade.da_entry_path || trade.entry_path || "unknown",
        rank_at_entry: Number(trade.rank) || 0,
        regime_at_entry: trade.regime_combined || trade.regime_daily || "unknown",
      });
    }

    console.log(`  Autopsied trades: ${autopsiedTrades.length}`);
    const byCls = {};
    for (const t of autopsiedTrades) {
      byCls[t.classification] = (byCls[t.classification] || 0) + 1;
    }
    for (const [cls, n] of Object.entries(byCls).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cls}: ${n}`);
    }
    const avgR = autopsiedTrades.reduce((s, t) => s + t.r_multiple, 0) / autopsiedTrades.length;
    const avgEfficiency = autopsiedTrades.reduce((s, t) => s + t.exit_efficiency, 0) / autopsiedTrades.length;
    console.log(`    Avg R-multiple: ${avgR.toFixed(2)}`);
    console.log(`    Avg exit efficiency: ${(avgEfficiency * 100).toFixed(1)}%`);
    console.log();
  }
} else {
  console.log("  Skipping trade autopsy (--skip-autopsy)\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: Upload & Trigger Analysis
// ═══════════════════════════════════════════════════════════════════════════

async function uploadAndAnalyze() {
  console.log("═══ Step 3: Upload & Analysis ═══\n");

  if (DRY_RUN) {
    console.log("  DRY RUN — skipping upload.");
    console.log(`  Would upload ${harvestedMoves.length} moves and ${autopsiedTrades.length} trades`);
    return;
  }

  if (harvestedMoves.length > 0) {
    console.log(`  Uploading ${harvestedMoves.length} moves...`);
    const batchSize = 200;
    for (let i = 0; i < harvestedMoves.length; i += batchSize) {
      const chunk = harvestedMoves.slice(i, i + batchSize);
      const isFirst = i === 0;
      const resp = await apiPost("/timed/calibration/upload-moves", { moves: chunk, clear: isFirst });
      if (!resp.ok) {
        console.error(`  Upload moves failed:`, resp.error);
        break;
      }
      console.log(`    Uploaded batch ${Math.floor(i/batchSize) + 1}: ${resp.inserted || chunk.length} moves`);
    }
  }

  if (autopsiedTrades.length > 0) {
    console.log(`  Uploading ${autopsiedTrades.length} trade autopsies...`);
    const resp = await apiPost("/timed/calibration/upload-autopsy", { trades: autopsiedTrades, clear: true });
    if (resp.ok) {
      console.log(`    Uploaded: ${resp.inserted || autopsiedTrades.length} trades`);
    } else {
      console.error(`  Upload autopsy failed:`, resp.error);
    }
  }

  console.log("\n  Running server-side calibration analysis...");
  const runResp = await apiPost("/timed/calibration/run", {});
  if (runResp.ok) {
    const r = runResp.report;
    console.log(`\n  ═══════════════════════════════════════════════`);
    console.log(`   CALIBRATION REPORT`);
    console.log(`  ═══════════════════════════════════════════════`);
    if (r.system_health) {
      const h = r.system_health.overall;
      console.log(`\n  System Health:`);
      console.log(`    Trades: ${h.n}  |  Win Rate: ${h.win_rate}%  |  Expectancy: ${h.expectancy}`);
      console.log(`    SQN: ${h.sqn}  |  Avg R: ${h.avg_r}  |  Profit Factor: ${h.profit_factor}`);
      const verdict = h.sqn >= 3 ? "EXCELLENT" : h.sqn >= 2 ? "GOOD" : h.sqn >= 1 ? "NEEDS WORK" : "BROKEN";
      console.log(`    Verdict: ${verdict}`);
    }
    if (r.sl_tp_calibration) {
      console.log(`\n  SL/TP Calibration (ATR):`);
      console.log(`    Recommended SL: ${r.sl_tp_calibration.recommended_sl_atr}`);
      console.log(`    TP Trim: ${r.sl_tp_calibration.recommended_tp_trim_atr}  |  TP Exit: ${r.sl_tp_calibration.recommended_tp_exit_atr}  |  TP Runner: ${r.sl_tp_calibration.recommended_tp_runner_atr}`);
    }
    if (r.wfo_summary) {
      console.log(`\n  Walk-Forward Validation:`);
      console.log(`    In-sample SQN: ${r.wfo_summary.in_sample_sqn}  |  Out-sample SQN: ${r.wfo_summary.out_sample_sqn}`);
      console.log(`    Verdict: ${r.wfo_summary.verdict}`);
    }
    if (r.recommendations) {
      console.log(`\n  Rank Threshold: >= ${r.recommendations.rank_threshold}`);
    }
    console.log(`\n  Report ID: ${r.report_id || runResp.report?.report_id}`);
    console.log(`  View full report: ${API_BASE}/timed/calibration/report?key=${API_KEY}`);
    console.log(`  ═══════════════════════════════════════════════\n`);
  } else {
    console.error("  Calibration analysis failed:", runResp.error);
  }
}

uploadAndAnalyze().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
