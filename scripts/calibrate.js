#!/usr/bin/env node
/**
 * Model Calibration Pipeline (runs locally — no Cloudflare time limits)
 *
 * Three-step process:
 *   1. Harvest Moves — scan daily candles, compute ATR, identify significant moves, capture scoring + VIX context
 *   2. Autopsy Trades — compute MFE/MAE from hourly candles, exit efficiency, scoring snapshots at entry
 *   3. Upload & trigger server-side analysis — uploads data, server runs lightweight runCalibrationAnalysis
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

function queryD1(sql, retries = 3) {
  const escaped = sql.replace(/"/g, '\\"');
  const cmd = `cd "${WORKER_DIR}" && npx wrangler d1 execute timed-trading-ledger --remote --env production --json --command "${escaped}"`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const raw = execSync(cmd, { maxBuffer: 100 * 1024 * 1024, encoding: "utf-8" });
      const parsed = JSON.parse(raw);
      if (parsed?.error) {
        if (attempt < retries) { process.stderr.write(`  [retry ${attempt}/${retries}] D1 error: ${parsed.error.text || JSON.stringify(parsed.error).slice(0, 100)}\n`); continue; }
        return [];
      }
      if (Array.isArray(parsed) && parsed[0]?.results) return parsed[0].results;
      if (parsed?.results) return parsed.results;
      return [];
    } catch (e) {
      if (attempt < retries) {
        process.stderr.write(`  [retry ${attempt}/${retries}] ${String(e.message || e).slice(0, 80)}\n`);
        execSync("sleep 2");
        continue;
      }
      return [];
    }
  }
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

function findNearest(rows, tsField, targetTs, maxDistMs) {
  let closest = null, minDist = Infinity;
  for (const r of rows) {
    const d = Math.abs(Number(r[tsField]) - targetTs);
    if (d < minDist) { minDist = d; closest = r; }
  }
  return closest && minDist < maxDistMs ? closest : null;
}

const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

console.log(`\n╔══════════════════════════════════════════════════════╗`);
console.log(`║   Model Calibration Pipeline (local)                 ║`);
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
  console.log(`  [${elapsed()}] Fetching daily candles...`);
  const rawCandles = queryD1Chunked(
    `SELECT ticker, ts, o, h, l, c FROM ticker_candles WHERE tf='D' ${tickerWhere} ORDER BY ticker, ts`
  );
  console.log(`  [${elapsed()}] Total: ${rawCandles.length} daily candles`);

  const byTicker = {};
  for (const c of rawCandles) {
    const t = String(c.ticker).toUpperCase();
    (byTicker[t] = byTicker[t] || []).push({
      ts: Number(c.ts), o: Number(c.o), h: Number(c.h),
      l: Number(c.l), c: Number(c.c),
    });
  }
  for (const t of Object.keys(byTicker)) byTicker[t].sort((a, b) => a.ts - b.ts);

  const tickers = Object.keys(byTicker).filter(t => byTicker[t].length >= 30);
  console.log(`  Analyzing ${tickers.length} tickers\n`);

  // VIX daily candles for regime context
  console.log(`  [${elapsed()}] Fetching VIX candles...`);
  const vixRows = queryD1(
    `SELECT ts, c FROM ticker_candles WHERE tf='D' AND ticker IN ('VIX','$VIX','VIX.X') ORDER BY ts`
  );
  const vixCandles = vixRows.map(r => ({ ts: Number(r.ts), c: Number(r.c) }));
  console.log(`  VIX candles: ${vixCandles.length}`);

  function getVixAtTs(ts) {
    if (!vixCandles.length) return null;
    const v = findNearest(vixCandles, "ts", ts, 5 * 86400000);
    return v ? Math.round(v.c * 100) / 100 : null;
  }

  // Trail data for scoring context (batch by ticker groups)
  console.log(`  [${elapsed()}] Fetching trail_5m_facts (batched)...`);
  const trailByTicker = {};
  const BATCH_SZ = 15;
  for (let b = 0; b < tickers.length; b += BATCH_SZ) {
    const batch = tickers.slice(b, b + BATCH_SZ);
    const inClause = batch.map(t => `'${t}'`).join(",");
    const rows = queryD1Chunked(
      `SELECT ticker, bucket_ts, htf_score_avg, ltf_score_avg, state, rank,
              completion, phase_pct,
              had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite
       FROM trail_5m_facts WHERE ticker IN (${inClause}) ORDER BY ticker, bucket_ts`
    );
    for (const r of rows) {
      const t = String(r.ticker).toUpperCase();
      (trailByTicker[t] = trailByTicker[t] || []).push(r);
    }
    process.stdout.write(`    trail: ${Math.min(b + BATCH_SZ, tickers.length)}/${tickers.length} tickers...\r`);
  }
  console.log(`  [${elapsed()}] Trail tickers loaded: ${Object.keys(trailByTicker).length}      `);

  // Direction accuracy for signal snapshots (batched)
  console.log(`  [${elapsed()}] Fetching direction_accuracy (batched)...`);
  const daByTicker = {};
  for (let b = 0; b < tickers.length; b += BATCH_SZ) {
    const batch = tickers.slice(b, b + BATCH_SZ);
    const inClause = batch.map(t => `'${t}'`).join(",");
    const rows = queryD1Chunked(
      `SELECT ticker, ts, signal_snapshot_json, regime_daily, regime_weekly, regime_combined
       FROM direction_accuracy WHERE ticker IN (${inClause}) AND signal_snapshot_json IS NOT NULL ORDER BY ticker, ts`
    );
    for (const r of rows) {
      const t = String(r.ticker).toUpperCase();
      (daByTicker[t] = daByTicker[t] || []).push(r);
    }
    process.stdout.write(`    DA: ${Math.min(b + BATCH_SZ, tickers.length)}/${tickers.length} tickers...\r`);
  }
  console.log(`  [${elapsed()}] DA tickers loaded: ${Object.keys(daByTicker).length}      \n`);

  const MIN_ATR_MULTIPLE = 1.5;
  const MIN_DURATION = 3;

  console.log(`  [${elapsed()}] Detecting moves...`);
  for (const ticker of tickers) {
    const candles = byTicker[ticker];
    const atrs = computeATR(candles);

    for (let i = MIN_DURATION; i < candles.length; i++) {
      const atr = atrs[i] || atrs[i - 1];
      if (!atr || atr <= 0) continue;

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

        let maxExt = 0, maxPull = 0;
        const mfes = [], maes = [];
        for (let j = startIdx + 1; j <= i; j++) {
          const fav = direction === "UP"
            ? (candles[j].h - startPrice) / startAtr
            : (startPrice - candles[j].l) / startAtr;
          const adv = direction === "UP"
            ? (startPrice - candles[j].l) / startAtr
            : (candles[j].h - startPrice) / startAtr;
          maxExt = Math.max(maxExt, fav);
          maxPull = Math.max(maxPull, adv);
          mfes.push(fav);
          maes.push(adv > 0 ? adv : 0);
        }

        // Trail scoring snapshot at move start
        let signalsJson = null, entryScoringJson = null, regimeJson = null;
        const trail = trailByTicker[ticker];
        if (trail) {
          const closest = findNearest(trail, "bucket_ts", candles[startIdx].ts, 2 * 86400000);
          if (closest) {
            const scoringData = {
              htf_score: Number(closest.htf_score_avg) || 0,
              ltf_score: Number(closest.ltf_score_avg) || 0,
              state: closest.state || "unknown",
              rank: Number(closest.rank) || 0,
              completion: Number(closest.completion) || 0,
              phase_pct: Number(closest.phase_pct) || 0,
              squeeze_release: closest.had_squeeze_release ? 1 : 0,
              ema_cross: closest.had_ema_cross ? 1 : 0,
              st_flip: closest.had_st_flip ? 1 : 0,
              momentum_elite: closest.had_momentum_elite ? 1 : 0,
            };
            signalsJson = JSON.stringify(scoringData);
            entryScoringJson = JSON.stringify(scoringData);
          }
        }

        // Direction accuracy for richer signal snapshot
        const da = daByTicker[ticker];
        if (da) {
          const closest = findNearest(da, "ts", candles[startIdx].ts, 3 * 86400000);
          if (closest) {
            signalsJson = closest.signal_snapshot_json || signalsJson;
            regimeJson = JSON.stringify({
              daily: closest.regime_daily, weekly: closest.regime_weekly,
              combined: closest.regime_combined,
            });
          }
        }

        const vixAtStart = getVixAtTs(candles[startIdx].ts);

        harvestedMoves.push({
          move_id: `${ticker}_${direction}_${candles[startIdx].ts}`,
          ticker, direction,
          start_ts: candles[startIdx].ts,
          end_ts: candles[i].ts,
          duration_days: lookback,
          move_pct: Math.round(movePct * 100) / 100,
          move_atr: Math.round(moveAtr * 100) / 100,
          max_ext_atr: Math.round(maxExt * 100) / 100,
          pullback_atr: Math.round(maxPull * 100) / 100,
          sl_optimal_atr: Math.round(percentile(maes.filter(v => v > 0), 75) * 100) / 100,
          tp_p50_atr: Math.round(percentile(mfes, 50) * 100) / 100,
          tp_p75_atr: Math.round(percentile(mfes, 75) * 100) / 100,
          tp_p90_atr: Math.round(percentile(mfes, 90) * 100) / 100,
          signals_json: signalsJson,
          regime_json: regimeJson,
          entry_scoring_json: entryScoringJson,
          vix_at_start: vixAtStart,
        });

        break;
      }
    }
  }

  // Deduplicate
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

  console.log(`  [${elapsed()}] Moves found: ${harvestedMoves.length}`);
  console.log(`    UP: ${harvestedMoves.filter(m => m.direction === "UP").length}`);
  console.log(`    DOWN: ${harvestedMoves.filter(m => m.direction === "DOWN").length}`);
  if (harvestedMoves.length) {
    const avgAtr = harvestedMoves.reduce((s, m) => s + m.move_atr, 0) / harvestedMoves.length;
    const withVix = harvestedMoves.filter(m => m.vix_at_start != null).length;
    const withScoring = harvestedMoves.filter(m => m.entry_scoring_json != null).length;
    console.log(`    Avg move: ${avgAtr.toFixed(2)} ATR`);
    console.log(`    With VIX context: ${withVix}  |  With scoring context: ${withScoring}`);
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
  console.log(`  [${elapsed()}] Fetching closed trades...`);
  const trades = queryD1Chunked(
    `SELECT t.trade_id, t.ticker, t.direction, t.entry_ts, t.exit_ts,
            t.entry_price, t.exit_price, t.pnl_pct, t.rank, t.rr, t.status,
            da.signal_snapshot_json, da.regime_daily, da.regime_weekly, da.regime_combined,
            da.entry_path AS da_entry_path
     FROM trades t
     LEFT JOIN direction_accuracy da ON da.trade_id = t.trade_id
     WHERE t.status IN ('WIN','LOSS','FLAT') ${tickerWhere}
     ORDER BY t.entry_ts`
  );
  console.log(`  Closed trades: ${trades.length}`);

  if (trades.length === 0) {
    console.log("  No closed trades found. Skipping autopsy.\n");
  } else {
    const tickersNeeded = [...new Set(trades.map(t => String(t.ticker).toUpperCase()))];

    // VIX candles for regime context at entry
    console.log(`  [${elapsed()}] Fetching VIX candles...`);
    const vixRows = queryD1(
      `SELECT ts, c FROM ticker_candles WHERE tf='D' AND ticker IN ('VIX','$VIX','VIX.X') ORDER BY ts`
    );
    const vixCandles = vixRows.map(r => ({ ts: Number(r.ts), c: Number(r.c) }));
    function getVixAtTs(ts) {
      if (!vixCandles.length) return null;
      const v = findNearest(vixCandles, "ts", ts, 5 * 86400000);
      return v ? Math.round(v.c * 100) / 100 : null;
    }

    // Trail data for scoring snapshot at entry
    console.log(`  [${elapsed()}] Fetching trail_5m_facts for trade tickers...`);
    const trailByTicker = {};
    for (const ticker of tickersNeeded) {
      const rows = queryD1Chunked(
        `SELECT bucket_ts, htf_score_avg, ltf_score_avg, state, rank,
                completion, phase_pct,
                had_squeeze_release, had_ema_cross, had_st_flip, had_momentum_elite
         FROM trail_5m_facts WHERE ticker='${ticker}' ORDER BY bucket_ts`
      );
      if (rows.length) trailByTicker[ticker] = rows;
    }
    console.log(`  [${elapsed()}] Trail tickers loaded: ${Object.keys(trailByTicker).length}`);

    // Hourly candles for MFE/MAE (better precision than daily, lighter than 5m)
    console.log(`  [${elapsed()}] Fetching hourly candles for MFE/MAE...`);
    const hourlyByTicker = {};
    for (const ticker of tickersNeeded) {
      const rows = queryD1Chunked(
        `SELECT ts, h, l, c FROM ticker_candles WHERE tf='60' AND ticker='${ticker}' ORDER BY ts`
      );
      if (rows.length) hourlyByTicker[ticker] = rows;
    }
    console.log(`  [${elapsed()}] Hourly candle tickers loaded: ${Object.keys(hourlyByTicker).length}`);

    // Daily candles for ATR
    console.log(`  [${elapsed()}] Fetching daily candles for ATR...`);
    const dailyByTicker = {};
    for (const ticker of tickersNeeded) {
      const rows = queryD1Chunked(
        `SELECT ts, o, h, l, c FROM ticker_candles WHERE tf='D' AND ticker='${ticker}' ORDER BY ts`
      );
      if (rows.length) {
        const candles = rows.map(r => ({ ts: Number(r.ts), o: Number(r.o), h: Number(r.h), l: Number(r.l), c: Number(r.c) }));
        dailyByTicker[ticker] = { candles, atrs: computeATR(candles) };
      }
    }
    console.log(`  [${elapsed()}] Daily candle tickers loaded: ${Object.keys(dailyByTicker).length}\n`);

    for (const trade of trades) {
      const ticker = String(trade.ticker).toUpperCase();
      const entryTs = Number(trade.entry_ts);
      const exitTs = Number(trade.exit_ts);
      const entryPrice = Number(trade.entry_price);
      const exitPrice = Number(trade.exit_price);
      const direction = String(trade.direction).toUpperCase();
      const isLong = direction === "LONG";

      if (!entryTs || !exitTs || !entryPrice || !exitPrice) continue;

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
      if (atrAtEntry <= 0) atrAtEntry = entryPrice * 0.02;

      const pnlPct = Number(trade.pnl_pct) || 0;
      const actualPnl = isLong ? exitPrice - entryPrice : entryPrice - exitPrice;
      const estRisk = atrAtEntry * 1.5;
      const slPrice = isLong ? entryPrice - estRisk : entryPrice + estRisk;
      const initialRisk = Math.abs(entryPrice - slPrice) || atrAtEntry;
      const rMultiple = actualPnl / initialRisk;

      // MFE/MAE from hourly candles (fallback to daily)
      let mfePct = 0, maePct = 0, mfeAtr = 0, maeAtr = 0, timeToMfeMin = 0, slHitBeforeMfe = false;
      const hourly = hourlyByTicker[ticker];
      const mfeSource = hourly
        ? hourly.filter(c => Number(c.ts) >= entryTs && Number(c.ts) <= exitTs)
        : null;
      const useDailyFallback = !mfeSource || mfeSource.length === 0;
      const duringCandles = useDailyFallback && daily
        ? daily.candles.filter(c => c.ts >= entryTs && c.ts <= exitTs)
        : mfeSource || [];

      if (duringCandles.length > 0) {
        let maxFav = 0, maxAdv = 0, mfeTs = entryTs;
        for (const c of duringCandles) {
          const high = Number(c.h), low = Number(c.l);
          const fav = isLong ? (high - entryPrice) / entryPrice * 100 : (entryPrice - low) / entryPrice * 100;
          const adv = isLong ? (entryPrice - low) / entryPrice * 100 : (high - entryPrice) / entryPrice * 100;
          if (fav > maxFav) { maxFav = fav; mfeTs = Number(c.ts); }
          maxAdv = Math.max(maxAdv, adv);
        }
        mfePct = Math.round(maxFav * 100) / 100;
        maePct = Math.round(maxAdv * 100) / 100;
        mfeAtr = atrAtEntry > 0 ? Math.round((maxFav / 100 * entryPrice / atrAtEntry) * 100) / 100 : 0;
        maeAtr = atrAtEntry > 0 ? Math.round((maxAdv / 100 * entryPrice / atrAtEntry) * 100) / 100 : 0;
        timeToMfeMin = Math.round((mfeTs - entryTs) / 60000);
        slHitBeforeMfe = maxAdv > (estRisk / entryPrice * 100) && mfeTs > entryTs;
      }

      const exitEfficiency = mfePct > 0 ? Math.round((Math.max(0, pnlPct) / mfePct) * 100) / 100 : 0;

      let classification = "noise_trade";
      if (mfeAtr < 0.5 && maeAtr < 0.5) classification = "noise_trade";
      else if (maePct > mfePct && pnlPct <= 0) classification = "bad_entry";
      else if (pnlPct > 0 && exitEfficiency >= 0.7) classification = "optimal";
      else if (pnlPct > 0 && exitEfficiency < 0.5) classification = "left_money";
      else if (mfePct > 1 && pnlPct <= 0) classification = "gave_back";
      else if (pnlPct <= 0) classification = "bad_entry";
      else classification = "left_money";

      // Scoring snapshot from trail at entry
      let htfScoreAtEntry = null, ltfScoreAtEntry = null, stateAtEntry = null;
      let completionAtEntry = null, phaseAtEntry = null, flagsAtEntry = null;
      const trailArr = trailByTicker[ticker];
      if (trailArr) {
        const closest = findNearest(trailArr, "bucket_ts", entryTs, 2 * 86400000);
        if (closest) {
          htfScoreAtEntry = Number(closest.htf_score_avg) || 0;
          ltfScoreAtEntry = Number(closest.ltf_score_avg) || 0;
          stateAtEntry = closest.state || null;
          completionAtEntry = Number(closest.completion) || 0;
          phaseAtEntry = Number(closest.phase_pct) || 0;
          flagsAtEntry = JSON.stringify({
            squeeze_release: closest.had_squeeze_release ? 1 : 0,
            ema_cross: closest.had_ema_cross ? 1 : 0,
            st_flip: closest.had_st_flip ? 1 : 0,
            momentum_elite: closest.had_momentum_elite ? 1 : 0,
          });
        }
      }

      let entryPath = trade.da_entry_path || "unknown";
      if ((!entryPath || entryPath === "unknown") && stateAtEntry) entryPath = stateAtEntry;

      const vixAtEntry = getVixAtTs(entryTs);

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
        sl_hit_before_mfe: slHitBeforeMfe ? 1 : 0,
        time_to_mfe_min: timeToMfeMin,
        optimal_hold_min: timeToMfeMin,
        classification,
        entry_signals_json: trade.signal_snapshot_json || null,
        entry_path: entryPath,
        rank_at_entry: Number(trade.rank) || 0,
        regime_at_entry: trade.regime_combined || trade.regime_daily || "unknown",
        vix_at_entry: vixAtEntry,
        htf_score_at_entry: htfScoreAtEntry,
        ltf_score_at_entry: ltfScoreAtEntry,
        state_at_entry: stateAtEntry,
        completion_at_entry: completionAtEntry,
        phase_at_entry: phaseAtEntry,
        flags_at_entry: flagsAtEntry,
      });
    }

    console.log(`  [${elapsed()}] Autopsied trades: ${autopsiedTrades.length}`);
    const byCls = {};
    for (const t of autopsiedTrades) byCls[t.classification] = (byCls[t.classification] || 0) + 1;
    for (const [cls, n] of Object.entries(byCls).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${cls}: ${n}`);
    }
    if (autopsiedTrades.length > 0) {
      const avgR = autopsiedTrades.reduce((s, t) => s + t.r_multiple, 0) / autopsiedTrades.length;
      const avgEff = autopsiedTrades.reduce((s, t) => s + t.exit_efficiency, 0) / autopsiedTrades.length;
      const withVix = autopsiedTrades.filter(t => t.vix_at_entry != null).length;
      const withState = autopsiedTrades.filter(t => t.state_at_entry != null).length;
      console.log(`    Avg R-multiple: ${avgR.toFixed(2)}`);
      console.log(`    Avg exit efficiency: ${(avgEff * 100).toFixed(1)}%`);
      console.log(`    With VIX: ${withVix}  |  With scoring state: ${withState}`);
    }
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
    console.log(`  [${elapsed()}] Uploading ${harvestedMoves.length} moves...`);
    const batchSize = 200;
    for (let i = 0; i < harvestedMoves.length; i += batchSize) {
      const chunk = harvestedMoves.slice(i, i + batchSize);
      const isFirst = i === 0;
      const resp = await apiPost("/timed/calibration/upload-moves", { moves: chunk, clear: isFirst });
      if (!resp.ok) {
        console.error(`  Upload moves failed:`, resp.error);
        break;
      }
      const batchNum = Math.floor(i/batchSize) + 1;
      const totalBatches = Math.ceil(harvestedMoves.length / batchSize);
      process.stdout.write(`    Batch ${batchNum}/${totalBatches} (${resp.inserted || chunk.length} moves)\r`);
      if (batchNum % 10 === 0) await new Promise(r => setTimeout(r, 500));
    }
    console.log(`    Uploaded ${harvestedMoves.length} moves in ${Math.ceil(harvestedMoves.length / batchSize)} batches`);
  }

  if (autopsiedTrades.length > 0) {
    console.log(`  [${elapsed()}] Uploading ${autopsiedTrades.length} trade autopsies...`);
    const resp = await apiPost("/timed/calibration/upload-autopsy", { trades: autopsiedTrades, clear: true });
    if (resp.ok) {
      console.log(`    Uploaded: ${resp.inserted || autopsiedTrades.length} trades`);
    } else {
      console.error(`  Upload autopsy failed:`, resp.error);
    }
  }

  console.log(`\n  [${elapsed()}] Running server-side analysis...`);
  const runResp = await apiPost("/timed/calibration/run", { analysis_only: true });
  if (runResp.ok) {
    const r = runResp.report;
    if (!r) {
      console.log("  Analysis queued or no report returned.");
      console.log(`  Check: ${API_BASE}/timed/calibration/report?key=${API_KEY}`);
      return;
    }
    console.log(`\n  ╔═══════════════════════════════════════════════╗`);
    console.log(`  ║   CALIBRATION REPORT                          ║`);
    console.log(`  ╚═══════════════════════════════════════════════╝`);
    if (r.system_health) {
      const h = r.system_health.overall;
      console.log(`\n  System Health:`);
      console.log(`    Trades: ${h.n}  |  Win Rate: ${(h.win_rate * 100).toFixed(1)}%  |  Expectancy: ${h.expectancy}`);
      console.log(`    SQN: ${h.sqn}  |  Avg R: ${h.avg_r}  |  Profit Factor: ${h.profit_factor}`);
      const verdict = h.sqn >= 3 ? "EXCELLENT" : h.sqn >= 2 ? "GOOD" : h.sqn >= 1 ? "NEEDS WORK" : "BROKEN";
      console.log(`    Verdict: ${verdict}`);
    }
    if (r.sl_tp_calibration) {
      console.log(`\n  SL/TP Calibration (ATR):`);
      console.log(`    Recommended SL: ${r.sl_tp_calibration.recommended_sl_atr}`);
      console.log(`    TP Trim: ${r.sl_tp_calibration.recommended_tp_trim_atr}  |  Exit: ${r.sl_tp_calibration.recommended_tp_exit_atr}  |  Runner: ${r.sl_tp_calibration.recommended_tp_runner_atr}`);
    }
    if (r.adaptive_profiles) {
      const wp = r.adaptive_profiles.winner_move || [];
      const wt = r.adaptive_profiles.winner_trade || [];
      const lt = r.adaptive_profiles.loser_trade || [];
      console.log(`\n  Adaptive Profiles: ${wp.length} winner moves, ${wt.length} winner trades, ${lt.length} loser trades`);
    }
    if (r.wfo_summary) {
      console.log(`\n  Walk-Forward: IS SQN=${r.wfo_summary.in_sample_sqn}  OS SQN=${r.wfo_summary.out_sample_sqn}  ${r.wfo_summary.verdict}`);
    }
    console.log(`\n  Report ID: ${r.report_id || runResp.report_id || "?"}`);
    console.log(`  Apply: curl -X POST "${API_BASE}/timed/calibration/apply?key=${API_KEY}" -H "Content-Type: application/json" -d '{"report_id":"${r.report_id || ""}"}'`);
    console.log(`  View:  ${API_BASE}/timed/calibration/report?key=${API_KEY}`);
    console.log();
  } else {
    console.error(`  [${elapsed()}] Analysis failed:`, runResp.error);
  }
}

uploadAndAnalyze().then(() => {
  console.log(`  [${elapsed()}] Done.\n`);
}).catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
