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
 *   node scripts/calibrate.js [--lookback 400] [--ticker AAPL] [--dry-run] [--skip-moves] [--skip-autopsy] [--no-sync]
 *   Use --no-sync to skip delta sync before run. Use USE_D1=1 to read from D1 instead of local SQLite.
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
const NO_SYNC = hasFlag("no-sync");

const API_BASE = process.env.API_BASE || "https://timed-trading-ingest.shashant.workers.dev";
const API_KEY = process.env.TIMED_API_KEY || "AwesomeSauce";

const WORKER_DIR = path.join(__dirname, "../worker");
const LOCAL_DB_PATH = path.join(__dirname, "../data/timed-local.db");
const USE_D1 = process.env.USE_D1 === "1" || process.env.USE_D1 === "true";

let db = null;
if (!USE_D1) {
  try {
    const Database = require("better-sqlite3");
    db = new Database(LOCAL_DB_PATH, { readonly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ticker_candles','trades','trail_5m_facts','direction_accuracy')").all().map(r => r.name);
    if (tables.length < 4) {
      db.close();
      db = null;
      console.error("Local DB missing required tables. Run: ./scripts/export-d1.sh");
      process.exit(1);
    }
  } catch (e) {
    if (e.code === "SQLITE_CANTOPEN" || e.message.includes("no such file")) {
      console.error("Local DB not found at", LOCAL_DB_PATH);
      console.error("Run: ./scripts/export-d1.sh   then optionally ./scripts/sync-d1.sh for delta sync.");
      process.exit(1);
    }
    throw e;
  }
}

function query(sql) {
  if (db) return db.prepare(sql).all();
  return queryD1(sql);
}

function queryChunked(baseSql, chunkSize = 15000) {
  let all = [];
  let offset = 0;
  while (true) {
    const rows = query(`${baseSql} LIMIT ${chunkSize} OFFSET ${offset}`);
    all = all.concat(rows);
    if (rows.length < chunkSize) break;
    offset += chunkSize;
  }
  return all;
}

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

function ema(arr, period) {
  const k = 2 / (period + 1);
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out.push(arr[i] * k + out[i - 1] * (1 - k));
  return out;
}

function classifyStateFromCandles(candles, idx) {
  if (idx < 50) return "unknown";
  const closes = candles.slice(0, idx + 1).map(c => c.c);
  const ema8  = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const e8  = ema8[ema8.length - 1];
  const e21 = ema21[ema21.length - 1];
  const e50 = ema50[ema50.length - 1];
  const htf = e21 > e50 ? "BULL" : "BEAR";
  const ltf = e8 > e21 ? "BULL" : "BEAR";
  return `HTF_${htf}_LTF_${ltf}`;
}

const t0 = Date.now();
function elapsed() { return `${((Date.now() - t0) / 1000).toFixed(1)}s`; }

// Optional: run delta sync before analysis (when using local SQLite)
if (!USE_D1 && !NO_SYNC && db) {
  const syncScript = path.join(__dirname, "sync-d1.sh");
  const { existsSync } = require("fs");
  if (existsSync(syncScript)) {
    console.log("  Running delta sync (sync-d1.sh)...");
    try {
      execSync(`"${syncScript}" "${LOCAL_DB_PATH}"`, { stdio: "inherit", cwd: path.join(__dirname, "..") });
    } catch (e) {
      console.warn("  Sync failed (continuing with existing local data):", (e && e.message) || e);
    }
    console.log();
  }
}

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
  const rawCandles = queryChunked(
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
  const vixRows = query(
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
    const rows = queryChunked(
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
    const rows = queryChunked(
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
          const closest = findNearest(trail, "bucket_ts", candles[startIdx].ts, 14 * 86400000);
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

        // Candle-based state fallback when trail data unavailable
        if (!entryScoringJson) {
          const candleState = classifyStateFromCandles(candles, startIdx);
          if (candleState !== "unknown") {
            const fallbackData = {
              htf_score: 0, ltf_score: 0,
              state: candleState,
              rank: 0, completion: 0, phase_pct: 0,
              squeeze_release: 0, ema_cross: 0, st_flip: 0, momentum_elite: 0,
              source: "candle_ema",
            };
            entryScoringJson = JSON.stringify(fallbackData);
            signalsJson = signalsJson || JSON.stringify(fallbackData);
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
    const candleFallback = harvestedMoves.filter(m => {
      if (!m.entry_scoring_json) return false;
      try { return JSON.parse(m.entry_scoring_json).source === "candle_ema"; } catch (_) { return false; }
    }).length;
    console.log(`    Avg move: ${avgAtr.toFixed(2)} ATR`);
    console.log(`    With VIX context: ${withVix}  |  With scoring context: ${withScoring} (${candleFallback} candle-EMA fallback)`);
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
  const trades = queryChunked(
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
    const vixRows = query(
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
      const rows = queryChunked(
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
      const rows = queryChunked(
        `SELECT ts, h, l, c FROM ticker_candles WHERE tf='60' AND ticker='${ticker}' ORDER BY ts`
      );
      if (rows.length) hourlyByTicker[ticker] = rows;
    }
    console.log(`  [${elapsed()}] Hourly candle tickers loaded: ${Object.keys(hourlyByTicker).length}`);

    // Daily candles for ATR
    console.log(`  [${elapsed()}] Fetching daily candles for ATR...`);
    const dailyByTicker = {};
    for (const ticker of tickersNeeded) {
      const rows = queryChunked(
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
        const closest = findNearest(trailArr, "bucket_ts", entryTs, 14 * 86400000);
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

      // Candle-based state fallback for trades
      if (!stateAtEntry && daily) {
        let closestIdx = 0, minDist = Infinity;
        for (let i = 0; i < daily.candles.length; i++) {
          const d = Math.abs(daily.candles[i].ts - entryTs);
          if (d < minDist) { minDist = d; closestIdx = i; }
        }
        const candleState = classifyStateFromCandles(daily.candles, closestIdx);
        if (candleState !== "unknown") stateAtEntry = candleState;
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
      const unknownState = autopsiedTrades.filter(t => !t.state_at_entry || t.state_at_entry === "unknown").length;
      console.log(`    Avg R-multiple: ${avgR.toFixed(2)}`);
      console.log(`    Avg exit efficiency: ${(avgEff * 100).toFixed(1)}%`);
      console.log(`    With VIX: ${withVix}  |  With scoring state: ${withState}  |  Unknown state: ${unknownState}`);
    }
    console.log();
  }
} else {
  console.log("  Skipping trade autopsy (--skip-autopsy)\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// HINDSIGHT ORACLE: Perfect entry/exit signals from 5m data
// ═══════════════════════════════════════════════════════════════════════════
let hindsightOracle = null;

function computeEmaRegimeAtIndex(closes, idx) {
  if (idx < 48) return { regime: 0, e5above48: false, e13above21: false };
  const e5 = ema(closes.slice(0, idx + 1), 5);
  const e13 = ema(closes.slice(0, idx + 1), 13);
  const e21 = ema(closes.slice(0, idx + 1), 21);
  const e48 = ema(closes.slice(0, idx + 1), 48);
  const e5v = e5[e5.length - 1], e13v = e13[e13.length - 1];
  const e21v = e21[e21.length - 1], e48v = e48[e48.length - 1];
  const a = e5v > e48v, b = e13v > e21v;
  let regime = 0;
  if (a && b) regime = 2;
  else if (a && !b) regime = 1;
  else if (!a && b) regime = -1;
  else regime = -2;
  return { regime, e5above48: a, e13above21: b };
}

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
  return {
    activeBull: active.filter(g => g.type === "bull").length,
    activeBear: active.filter(g => g.type === "bear").length,
    inBullGap: active.some(g => g.type === "bull" && px >= g.bottom && px <= g.top),
    inBearGap: active.some(g => g.type === "bear" && px >= g.bottom && px <= g.top),
  };
}

function buildLifecycleEvents(candles5, trail, entryBarTs, entryPrice, mfeBarTs, isUp) {
  const events = [];
  if (!candles5 || candles5.length < 6) return events;
  const PDZ_LOOKBACK = 200;
  const moveCandles = candles5.filter(c => c.ts >= entryBarTs && c.ts <= mfeBarTs);
  if (moveCandles.length < 3) return events;

  let prevPdz = null, prevPhase = null, prevStFlip = false;
  let runningHigh = entryPrice, runningLow = entryPrice;

  for (let i = 0; i < moveCandles.length; i++) {
    const c = moveCandles[i];
    const px = c.c;
    const pnlFromEntry = isUp
      ? ((px - entryPrice) / entryPrice) * 100
      : ((entryPrice - px) / entryPrice) * 100;
    const allIdx = candles5.indexOf(c);
    const pdzWindow = candles5.slice(Math.max(0, allIdx - PDZ_LOOKBACK), allIdx + 1);
    const pdz = computePDZInline(pdzWindow, px);
    const fvgWindow = candles5.slice(Math.max(0, allIdx - 50), allIdx + 1);
    const fvgState = detectFVGsInline(fvgWindow, px);
    const trailRow = trail ? findNearest(trail, "bucket_ts", c.ts, 5 * 60 * 1000) : null;
    const phase = trailRow ? Number(trailRow.phase_pct) || 0 : 0;
    const htf = trailRow ? Number(trailRow.htf_score_avg) || 0 : 0;
    const ltf = trailRow ? Number(trailRow.ltf_score_avg) || 0 : 0;
    const stFlip = trailRow ? !!trailRow.had_st_flip : false;
    const sqRelease = trailRow ? !!trailRow.had_squeeze_release : false;
    const snapshot = {
      ts: c.ts, price: px, pnl_pct: Math.round(pnlFromEntry * 100) / 100,
      pdz_zone: pdz.zone, pdz_pct: pdz.pct, phase, htf_score: htf, ltf_score: ltf,
      fvg_active_bull: fvgState.activeBull, fvg_active_bear: fvgState.activeBear,
      fvg_in_bull_gap: fvgState.inBullGap, fvg_in_bear_gap: fvgState.inBearGap,
    };
    if (prevPdz && pdz.zone !== prevPdz) events.push({ event: "zone_transition", from: prevPdz, to: pdz.zone, ...snapshot });
    if (isUp && c.h > runningHigh) { runningHigh = c.h; events.push({ event: "new_swing_high", ...snapshot }); }
    if (!isUp && c.l < runningLow) { runningLow = c.l; events.push({ event: "new_swing_low", ...snapshot }); }
    if (Math.abs(phase) >= 75 && (prevPhase === null || Math.abs(prevPhase) < 75)) events.push({ event: "phase_extreme", value: phase, ...snapshot });
    if (stFlip && !prevStFlip) events.push({ event: "st_flip", ...snapshot });
    if (sqRelease) events.push({ event: "squeeze_release", ...snapshot });
    if (isUp) { const dd = ((runningHigh - px) / runningHigh) * 100; if (dd > 1.0 && i > 5) events.push({ event: "pullback", depth_pct: Math.round(dd * 100) / 100, ...snapshot }); }
    else { const dd = ((px - runningLow) / runningLow) * 100; if (dd > 1.0 && i > 5) events.push({ event: "pullback", depth_pct: Math.round(dd * 100) / 100, ...snapshot }); }
    prevPdz = pdz.zone; prevPhase = phase; prevStFlip = stFlip;
  }
  return events;
}

function buildLifecycleProfiles(fingerprints) {
  const allEvents = [], peakSnapshots = [], pullbackSnapshots = [], entrySnapshots = [];
  for (const fp of fingerprints) {
    if (!fp.lifecycle || fp.lifecycle.length === 0) continue;
    entrySnapshots.push({ pdz_zone: fp.pdz_at_entry, pdz_pct: fp.pdz_pct_at_entry, phase: fp.phase_pct, htf_score: fp.htf_score });
    const peaks = fp.lifecycle.filter(e => e.event === "new_swing_high" || e.event === "new_swing_low");
    if (peaks.length > 0) peakSnapshots.push(peaks[peaks.length - 1]);
    pullbackSnapshots.push(...fp.lifecycle.filter(e => e.event === "pullback"));
    allEvents.push(...fp.lifecycle);
  }
  if (allEvents.length === 0) return {};
  const zonePct = (arr, zone) => arr.length > 0 ? Math.round((arr.filter(s => s.pdz_zone === zone).length / arr.length) * 100) : 0;
  const safeMed = (arr, key) => {
    const vals = arr.map(a => a[key]).filter(x => Number.isFinite(x));
    return vals.length > 0 ? percentile(vals, 50) : 0;
  };
  const result = {};
  if (peakSnapshots.length >= 3) {
    result.trim_profile = {
      sample_count: peakSnapshots.length,
      pdz_zone_premium_pct: zonePct(peakSnapshots, "premium"),
      pdz_zone_premium_approach_pct: zonePct(peakSnapshots, "premium_approach"),
      pdz_pct_median: Math.round(safeMed(peakSnapshots, "pdz_pct") * 10) / 10,
      phase_median: Math.round(safeMed(peakSnapshots, "phase") * 10) / 10,
      pnl_pct_median: Math.round(safeMed(peakSnapshots, "pnl_pct") * 100) / 100,
    };
  }
  const holdEvents = allEvents.filter(e => e.event === "zone_transition" && (e.to === "equilibrium" || e.to === "discount_approach"));
  if (holdEvents.length >= 3) {
    result.hold_profile = {
      sample_count: holdEvents.length,
      pdz_pct_median: Math.round(safeMed(holdEvents, "pdz_pct") * 10) / 10,
      phase_median: Math.round(safeMed(holdEvents, "phase") * 10) / 10,
      fvg_bull_support_pct: Math.round((holdEvents.filter(e => e.fvg_active_bull > 0).length / holdEvents.length) * 100),
    };
  }
  const exitSnapshots = fingerprints.filter(fp => fp.lifecycle && fp.lifecycle.length > 0).map(fp => fp.lifecycle[fp.lifecycle.length - 1]);
  if (exitSnapshots.length >= 3) {
    result.exit_profile = {
      sample_count: exitSnapshots.length,
      pdz_zone_premium_pct: zonePct(exitSnapshots, "premium"),
      pdz_pct_median: Math.round(safeMed(exitSnapshots, "pdz_pct") * 10) / 10,
      phase_median: Math.round(safeMed(exitSnapshots, "phase") * 10) / 10,
      pnl_pct_median: Math.round(safeMed(exitSnapshots, "pnl_pct") * 100) / 100,
    };
  }
  if (pullbackSnapshots.length >= 3) {
    result.pullback_profile = {
      sample_count: pullbackSnapshots.length,
      pdz_zone_discount_pct: zonePct(pullbackSnapshots, "discount"),
      pdz_zone_discount_approach_pct: zonePct(pullbackSnapshots, "discount_approach"),
      depth_pct_median: Math.round(safeMed(pullbackSnapshots, "depth_pct") * 100) / 100,
      phase_median: Math.round(safeMed(pullbackSnapshots, "phase") * 10) / 10,
      fvg_bull_support_pct: Math.round((pullbackSnapshots.filter(e => e.fvg_active_bull > 0).length / pullbackSnapshots.length) * 100),
    };
  }
  if (entrySnapshots.length >= 3) {
    result.entry_profile = {
      sample_count: entrySnapshots.length,
      pdz_zone_discount_pct: zonePct(entrySnapshots, "discount"),
      pdz_zone_equilibrium_pct: zonePct(entrySnapshots, "equilibrium"),
      pdz_pct_median: Math.round(safeMed(entrySnapshots, "pdz_pct") * 10) / 10,
    };
  }
  return result;
}

function runHindsightOracle() {
  const qualifying = harvestedMoves.filter(m => (m.move_atr >= 2.0 && m.duration_days >= 3));
  if (qualifying.length === 0) return null;
  if (!db) return null;

  const WINDOW_MS_4H = 4 * 60 * 60 * 1000;
  const WINDOW_MS_2H = 2 * 60 * 60 * 1000;
  const PDZ_LOOKBACK = 200;
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

    const dailyCandles = byTicker[m.ticker];
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

    // PDZ at entry and exit
    const entryIdx = candles5.findIndex(c => c.ts >= entryBarTs);
    const pdzAtEntry = computePDZInline(candles5.slice(Math.max(0, entryIdx - PDZ_LOOKBACK), entryIdx + 1), entryPrice);
    const exitIdx = candles5.findIndex(c => c.ts >= mfeBarTs);
    const mfePrice = isUp ? Math.max(...inRange.filter(c => c.ts >= entryBarTs).map(c => c.h)) : Math.min(...inRange.filter(c => c.ts >= entryBarTs).map(c => c.l));
    const pdzAtExit = computePDZInline(candles5.slice(Math.max(0, exitIdx - PDZ_LOOKBACK), exitIdx + 1), mfePrice);

    // Build lifecycle events
    const lifecycle = buildLifecycleEvents(candles5, trail, entryBarTs, entryPrice, mfeBarTs, isUp);

    // Move stats
    let maxDrawdown = 0, pullbackCount = 0, best = entryPrice;
    for (const c of inRange.filter(c => c.ts >= entryBarTs)) {
      if (isUp) { if (c.h > best) best = c.h; const dd = ((best - c.l) / best) * 100; if (dd > maxDrawdown) maxDrawdown = dd; if (dd > 1.0) pullbackCount++; }
      else { if (c.l < best) best = c.l; const dd = ((c.h - best) / best) * 100; if (dd > maxDrawdown) maxDrawdown = dd; if (dd > 1.0) pullbackCount++; }
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
      move_stats: { duration_days: m.duration_days, max_pnl_pct: Math.round(maxFav * 10000) / 100, max_drawdown_pct: Math.round(maxDrawdown * 100) / 100, pullback_count: pullbackCount, lifecycle_events: lifecycle.length },
    });
  }

  // Golden Profiles
  const byState = {};
  for (const fp of fingerprints) { const st = fp.state || "unknown"; if (st === "unknown") continue; (byState[st] = byState[st] || []).push(fp); }
  const goldenProfiles = {};
  for (const [state, arr] of Object.entries(byState)) {
    if (arr.length < 5) continue;
    const n = arr.length;
    const pct = (v) => Math.round((arr.filter(x => x[v]).length / n) * 100);
    const med = (key) => percentile(arr.map(a => a[key]).filter(x => x != null), 50);
    const regimeConfirmedPct = Math.round((arr.filter(x => x.ema_regime_at_entry >= 2 || x.ema_regime_at_entry <= -2).length / n) * 100);
    const regimeEarlyPct = Math.round((arr.filter(x => Math.abs(x.ema_regime_at_entry) === 1).length / n) * 100);
    const regimeReversedAtExitPct = Math.round((arr.filter(x => { if (x.direction === "UP") return x.ema_regime_at_exit <= -1; return x.ema_regime_at_exit >= 1; }).length / n) * 100);
    goldenProfiles[state] = {
      sample_count: n, squeeze_release_pct: pct("squeeze_release"), ema_cross_pct: pct("ema_cross"), st_flip_pct: pct("st_flip"), momentum_elite_pct: pct("momentum_elite"),
      ema_regime_confirmed_pct: regimeConfirmedPct, ema_regime_early_pct: regimeEarlyPct,
      ema5above48_pct: pct("ema5above48_at_entry"), ema13above21_pct: pct("ema13above21_at_entry"),
      ema_regime_reversed_at_exit_pct: regimeReversedAtExitPct,
      htf_score_median: Math.round(med("htf_score") * 10) / 10, ltf_score_median: Math.round(med("ltf_score") * 10) / 10,
      completion_median: Math.round(med("completion") * 100) / 100, phase_median: Math.round(med("phase_pct") * 100) / 100,
      avg_move_atr: Math.round((arr.reduce((s, a) => s + a.move_atr, 0) / n) * 100) / 100,
    };
  }

  // Lifecycle Profiles
  const lifecycleProfiles = buildLifecycleProfiles(fingerprints);

  // Trade Alignments
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

  // Recommendations
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
  // Lifecycle-based recommendations
  if (lifecycleProfiles.trim_profile) {
    const tp = lifecycleProfiles.trim_profile;
    if (tp.pdz_zone_premium_pct >= 60) recommendations.push({ type: "lifecycle", signal: "trim_in_premium", message: `${tp.pdz_zone_premium_pct}% of MFE peaks in premium zone — trim when price reaches premium` });
    if (tp.phase_median >= 65) recommendations.push({ type: "lifecycle", signal: "trim_on_phase", message: `Phase at peak median ${tp.phase_median} — use as trim trigger` });
  }
  if (lifecycleProfiles.pullback_profile) {
    const pp = lifecycleProfiles.pullback_profile;
    if (pp.pdz_zone_discount_pct >= 40) recommendations.push({ type: "lifecycle", signal: "hold_in_discount", message: `${pp.pdz_zone_discount_pct}% of pullbacks in discount zone — hold through discount pullbacks` });
  }

  return {
    qualifying_moves: qualifying.length,
    fingerprints_count: fingerprints.length,
    golden_profiles: goldenProfiles,
    lifecycle_profiles: lifecycleProfiles,
    trade_alignments: tradeAlignments,
    recommendations: recommendations.slice(0, 15),
  };
}

if (db && harvestedMoves.length > 0) {
  console.log("═══ Hindsight Oracle (5m perfect entry/exit) ═══\n");
  hindsightOracle = runHindsightOracle();
  if (hindsightOracle) {
    console.log(`  [${elapsed()}] Qualifying moves: ${hindsightOracle.qualifying_moves} → fingerprints: ${hindsightOracle.fingerprints_count}`);
    console.log(`  Golden profiles: ${Object.keys(hindsightOracle.golden_profiles || {}).length} states`);
    const lp = hindsightOracle.lifecycle_profiles || {};
    const lpKeys = Object.keys(lp);
    console.log(`  Lifecycle profiles: ${lpKeys.length} (${lpKeys.join(", ") || "none"})`);
    if (lp.trim_profile) console.log(`    Trim: ${lp.trim_profile.sample_count} peaks, ${lp.trim_profile.pdz_zone_premium_pct}% in premium, phase median ${lp.trim_profile.phase_median}`);
    if (lp.pullback_profile) console.log(`    Pullback: ${lp.pullback_profile.sample_count} events, ${lp.pullback_profile.pdz_zone_discount_pct}% in discount, FVG support ${lp.pullback_profile.fvg_bull_support_pct}%`);
    if (lp.exit_profile) console.log(`    Exit: ${lp.exit_profile.sample_count} exits, ${lp.exit_profile.pdz_zone_premium_pct}% in premium, phase median ${lp.exit_profile.phase_median}`);
    console.log(`  Recommendations: ${(hindsightOracle.recommendations || []).length}`);
    console.log();
  }
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
  const runBody = { analysis_only: true };
  if (hindsightOracle) runBody.hindsight_oracle = hindsightOracle;
  const runResp = await apiPost("/timed/calibration/run", runBody);
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
  if (db) try { db.close(); } catch (_) {}
  console.log(`  [${elapsed()}] Done.\n`);
}).catch(err => {
  if (db) try { db.close(); } catch (_) {}
  console.error("Fatal error:", err);
  process.exit(1);
});
