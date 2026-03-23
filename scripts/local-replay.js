#!/usr/bin/env node
// scripts/local-replay.js
// Local Node.js backtest runner — replays from local SQLite DB.
// 10-20x faster than HTTP-based replay through Cloudflare.
//
// Usage:
//   node scripts/local-replay.js --start 2025-07-01 --end 2026-03-04
//   node scripts/local-replay.js --start 2025-07-01 --end 2026-03-04 --engine tt_core --label "my-run"
//   node scripts/local-replay.js --start 2025-07-01 --end 2025-07-15 --tickers AAPL,MSFT,NVDA
//   node scripts/local-replay.js --engine tt_core --config configs/context-gates-v1.json --label "tt-core-v1"

import Database from "better-sqlite3";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { performance } from "perf_hooks";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// ── Pipeline imports ────────────────────────────────────────────────────────
import { computeTfBundle, assembleTickerData, computeTDSequentialMultiTF } from "../worker/indicators.js";
import { buildTradeContext } from "../worker/pipeline/trade-context.js";
import { runUniversalGates } from "../worker/pipeline/gates.js";
import { evaluateEntry, registerEntryEngine } from "../worker/pipeline/entry-engine.js";
import { enrichEntry } from "../worker/pipeline/enrichment.js";
import { gatherSizingMultipliers, computeRiskBasedSize } from "../worker/pipeline/sizing.js";
import { evaluateEntry as ttCoreEntry } from "../worker/pipeline/tt-core-entry.js";
import { evaluateEntry as ripsterEntry } from "../worker/pipeline/ripster-entry.js";
import { evaluateEntry as legacyEntry } from "../worker/pipeline/legacy-entry.js";

registerEntryEngine("tt_core", { evaluateEntry: ttCoreEntry });
registerEntryEngine("ripster_core", { evaluateEntry: ripsterEntry });
registerEntryEngine("legacy", { evaluateEntry: legacyEntry });

// ── CLI Args ────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const START_DATE = args.start || "2025-07-01";
const END_DATE = args.end || "2026-03-04";
const ENGINE = args.engine || "ripster_core";
const LEADING_LTF = args.ltf || "10";
const INTERVAL_MIN = Number(args.interval) || 5;
const LABEL = args.label || `local-${ENGINE}`;
const TICKER_FILTER = args.tickers ? args.tickers.split(",").map(s => s.trim().toUpperCase()) : null;
const START_CASH = Number(args.cash) || 100000;
const SMOKE_TEST_DAYS = Number(args.smoke) || 0;
const CONFIG_PATH = args.config || null;

import { readFileSync } from "fs";
let DEEP_AUDIT_CONFIG = {};
if (CONFIG_PATH) {
  try {
    const cfgRaw = readFileSync(CONFIG_PATH, "utf-8");
    DEEP_AUDIT_CONFIG = JSON.parse(cfgRaw);
    console.log(`[CONFIG] Loaded ${Object.keys(DEEP_AUDIT_CONFIG).length} overrides from ${CONFIG_PATH}`);
  } catch (e) {
    console.error(`[CONFIG] Failed to load ${CONFIG_PATH}: ${e.message}`);
    process.exit(1);
  }
}

// ── Constants ───────────────────────────────────────────────────────────────
const PORTFOLIO_START_CASH = START_CASH;
const MAX_CONCURRENT_TRADES = 15;
const MIN_NOTIONAL = 500;
const DEFAULT_SL_ATR = 2.0;
const DEFAULT_TP_ATR = 3.0;
const RTH_OPEN_HOUR = 9;
const RTH_OPEN_MIN = 30;
const RTH_CLOSE_HOUR = 16;
const RTH_CLOSE_MIN = 0;
const SIZING_MULT_FLOOR = 0.30;
const HOLIDAYS = new Set([
  "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16",
]);
const TF_CONFIGS = [
  { tf: "M",   limit: 200 },
  { tf: "W",   limit: 300 },
  { tf: "D",   limit: 600 },
  { tf: "240", limit: 500 },
  { tf: "60",  limit: 500 },
  { tf: "30",  limit: 500 },
  { tf: LEADING_LTF, limit: 600 },
];

// ── Database Setup ──────────────────────────────────────────────────────────
const DB_PATH = join(ROOT, "data", "timed-local.db");
if (!existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  process.exit(1);
}
const db = new Database(DB_PATH, { readonly: true });
db.pragma("cache_size = -200000");

const stmtCandles = db.prepare(
  "SELECT ts, o, h, l, c, v FROM ticker_candles WHERE ticker = ? AND tf = ? AND ts <= ? ORDER BY ts ASC LIMIT ?"
);

function getCandles(ticker, tf, beforeTs, limit) {
  return stmtCandles.all(ticker, tf, beforeTs, limit);
}

// ── Date Utilities ──────────────────────────────────────────────────────────
function tradingDays(start, end) {
  const days = [];
  const d = new Date(start + "T12:00:00Z");
  const endD = new Date(end + "T12:00:00Z");
  while (d <= endD) {
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5 && !HOLIDAYS.has(iso)) {
      days.push(iso);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function marketOpenMs(dateStr) {
  return new Date(`${dateStr}T${String(RTH_OPEN_HOUR).padStart(2,"0")}:${String(RTH_OPEN_MIN).padStart(2,"0")}:00-04:00`).getTime();
}
function marketCloseMs(dateStr) {
  return new Date(`${dateStr}T${String(RTH_CLOSE_HOUR).padStart(2,"0")}:${String(RTH_CLOSE_MIN).padStart(2,"0")}:00-04:00`).getTime();
}

// ── Ticker Universe ─────────────────────────────────────────────────────────
const _require = createRequire(import.meta.url);
const { SECTOR_MAP: _SECTOR_MAP } = _require("../worker/sector-mapping.js");
const WATCHLIST_TICKERS = new Set(Object.keys(_SECTOR_MAP));

function loadTickerUniverse() {
  if (TICKER_FILTER) return TICKER_FILTER;
  const rows = db.prepare(
    "SELECT DISTINCT ticker FROM ticker_candles WHERE tf = 'D' AND ts > ? ORDER BY ticker"
  ).all(new Date("2025-06-01").getTime());
  const dbTickers = rows.map(r => r.ticker);
  const filtered = dbTickers.filter(t => WATCHLIST_TICKERS.has(t));
  if (filtered.length < WATCHLIST_TICKERS.size * 0.5) {
    console.warn(`[WARN] Only ${filtered.length}/${WATCHLIST_TICKERS.size} SECTOR_MAP tickers found in DB`);
  }
  return filtered;
}

// ── Trade State ─────────────────────────────────────────────────────────────
const allTrades = [];
const openPositions = new Map();
let cash = PORTFOLIO_START_CASH;
let tradeSeq = 0;

const stats = {
  totalDays: 0,
  totalIntervals: 0,
  entriesEvaluated: 0,
  entriesQualified: 0,
  tradesOpened: 0,
  tradesClosed: 0,
  wins: 0,
  losses: 0,
  flat: 0,
  totalPnl: 0,
  gateBlocks: {},
  monthly: {},
};

function getMonthlyBucket(tsOrDate) {
  const d = typeof tsOrDate === "string" ? tsOrDate : new Date(tsOrDate).toISOString().slice(0, 10);
  return d.slice(0, 7);
}

function ensureMonthBucket(month) {
  if (!stats.monthly[month]) {
    stats.monthly[month] = { trades: 0, wins: 0, losses: 0, flat: 0, pnl: 0, entries: 0, holdHoursSum: 0 };
  }
  return stats.monthly[month];
}

function openTrade(ticker, direction, entryPx, sl, tp, confidence, path, asOfTs, sizingMeta) {
  if (openPositions.has(ticker)) return null;
  if (openPositions.size >= MAX_CONCURRENT_TRADES) return null;

  const accountValue = PORTFOLIO_START_CASH + allTrades
    .filter(t => t.status === "WIN" || t.status === "LOSS")
    .reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
  const vixLevel = 18;
  const sizing = computeRiskBasedSize(confidence, accountValue, entryPx, sl, vixLevel, {}, 0.01);
  const mults = sizingMeta?._sizingMults || { combined: 1.0, breakdown: {} };
  const adjustedNotional = sizing.notional * mults.combined;
  const notional = Math.min(adjustedNotional, cash);
  if (notional < MIN_NOTIONAL) return null;

  const shares = notional / entryPx;
  cash -= notional;

  const trade = {
    id: `local-${++tradeSeq}`,
    ticker,
    direction,
    entryPrice: entryPx,
    shares,
    notional,
    sl, tp,
    confidence,
    path,
    entry_ts: asOfTs,
    _date: new Date(asOfTs).toISOString().slice(0, 10),
    status: "OPEN",
    mfe_pct: 0,
    mae_pct: 0,
    trimmedPct: 0,
    sizingMeta: { ...sizing, ...mults.breakdown, effectiveMult: mults.combined },
  };
  openPositions.set(ticker, trade);
  allTrades.push(trade);
  stats.tradesOpened++;
  ensureMonthBucket(getMonthlyBucket(asOfTs)).entries++;
  return trade;
}

function closeTrade(ticker, exitPx, exitReason, asOfTs) {
  const trade = openPositions.get(ticker);
  if (!trade) return null;

  const isLong = trade.direction === "LONG";
  const pnl = isLong
    ? (exitPx - trade.entryPrice) * trade.shares
    : (trade.entryPrice - exitPx) * trade.shares;
  const pnlPct = isLong
    ? ((exitPx - trade.entryPrice) / trade.entryPrice) * 100
    : ((trade.entryPrice - exitPx) / trade.entryPrice) * 100;

  trade.exitPrice = exitPx;
  trade.exitReason = exitReason;
  trade.exit_ts = asOfTs;
  trade.realizedPnl = pnl;
  trade.pnlPct = pnlPct;
  trade.status = pnlPct > 0.05 ? "WIN" : pnlPct < -0.05 ? "LOSS" : "FLAT";

  cash += trade.notional + pnl;
  openPositions.delete(ticker);
  stats.tradesClosed++;
  if (trade.status === "WIN") stats.wins++;
  else if (trade.status === "LOSS") stats.losses++;
  else stats.flat++;
  stats.totalPnl += pnl;

  const exitMonth = getMonthlyBucket(asOfTs);
  const mb = ensureMonthBucket(exitMonth);
  mb.trades++;
  mb.pnl += pnl;
  if (trade.status === "WIN") mb.wins++;
  else if (trade.status === "LOSS") mb.losses++;
  else mb.flat++;
  if (trade.entry_ts && asOfTs) mb.holdHoursSum += (asOfTs - trade.entry_ts) / 3600000;

  return trade;
}

function updateMFE(ticker, currentPx) {
  const trade = openPositions.get(ticker);
  if (!trade) return;
  const isLong = trade.direction === "LONG";
  const pnlPct = isLong
    ? ((currentPx - trade.entryPrice) / trade.entryPrice) * 100
    : ((trade.entryPrice - currentPx) / trade.entryPrice) * 100;
  if (pnlPct > trade.mfe_pct) trade.mfe_pct = pnlPct;
  if (pnlPct < trade.mae_pct) trade.mae_pct = pnlPct;
}

// ── TT Core Context Gates (mirrors _applyTtCoreContextGates in worker/index.js) ──
function applyTtCoreContextGates(d, inferredSide, asOfTs, leadingLtfLabel) {
  const daCfg = d?._env?._deepAuditConfig || {};

  const vixCeiling = Number(daCfg.deep_audit_vix_ceiling) || 32;
  if (vixCeiling > 0 && d?._vix != null) {
    const vx = Number(d._vix);
    if (vx > vixCeiling) return { qualifies: false, reason: "tt_vix_ceiling" };
  }

  const blockRegimes = daCfg.deep_audit_block_regime;
  const tickerSwingRegime = String(d?.regime?.combined || "").toUpperCase();
  if (blockRegimes && tickerSwingRegime) {
    const arr = Array.isArray(blockRegimes) ? blockRegimes : [blockRegimes];
    const isBear = tickerSwingRegime.includes("BEAR");
    const isBull = tickerSwingRegime.includes("BULL") && !isBear;
    if (arr.some(r => String(r).toUpperCase() === tickerSwingRegime)) {
      if (isBear && inferredSide === "SHORT") { /* allow */ }
      else if (isBull && inferredSide === "LONG") { /* allow */ }
      else return { qualifies: false, reason: "tt_regime_blocked" };
    }
  }

  if (String(daCfg.tt_spy_directional_gate ?? "false") === "true" && d?._spyData) {
    const spyHtf = Number(d._spyData?.htf_score) || 0;
    const spyRegime = Number(d._spyData?.ema_regime_daily) || 0;
    if (inferredSide === "LONG" && spyHtf < -10 && spyRegime <= -1)
      return { qualifies: false, reason: "tt_spy_bearish_long_block" };
    if (inferredSide === "SHORT" && spyHtf > 10 && spyRegime >= 1)
      return { qualifies: false, reason: "tt_spy_bullish_short_block" };
  }

  const dangerMax = Number(daCfg.deep_audit_danger_max_signals);
  if (Number.isFinite(dangerMax) && dangerMax > 0) {
    const tt = d?.tf_tech || {};
    const isLong = inferredSide === "LONG";
    const dirSign = isLong ? 1 : -1;
    let cnt = 0;

    if ((tt.D?.stDir ?? 0) !== 0 && (tt.D?.stDir ?? 0) !== dirSign) cnt++;
    const s30 = tt["30"]?.stDir ?? 0; if (s30 !== 0 && (tt["30"]?.stSlope ?? 0) !== s30) cnt++;
    if ((tt["1H"]?.ema?.depth ?? 0) < (Number(daCfg.deep_audit_danger_ema_depth_min) || 5)) cnt++;
    if ((tt["4H"]?.stDir ?? 0) !== 0 && (tt["4H"]?.stDir ?? 0) !== dirSign) cnt++;
    const ltfKey = leadingLtfLabel === "10m" ? "10" : leadingLtfLabel === "15m" ? "15" : "30";
    const sLtf = tt[ltfKey]?.stDir ?? 0;
    if (sLtf !== 0 && (tt[ltfKey]?.stSlope ?? 0) !== sLtf) cnt++;
    if ((Number(d?._vix) || 0) > (Number(daCfg.deep_audit_danger_vix_threshold) || 25)) cnt++;
    const stTFs = ["D", "4H", "1H", "30", ltfKey];
    let aligned = 0; for (const tf of stTFs) { if ((tt[tf]?.stDir ?? 0) === dirSign) aligned++; }
    if (aligned < (Number(daCfg.deep_audit_danger_min_st_aligned) || 3)) cnt++;

    if (cnt > dangerMax) return { qualifies: false, reason: "tt_danger_score_exceeded" };
  }

  if (String(daCfg.doa_gate_enabled ?? "true") === "true") {
    const tt = d?.tf_tech || {};
    const dirSign = inferredSide === "LONG" ? 1 : -1;
    const stD = tt.D?.stDir ?? 0;
    if (stD !== 0 && stD !== dirSign) {
      const st4H = tt["4H"]?.stDir ?? 0;
      if (st4H !== 0 && st4H !== dirSign)
        return { qualifies: false, reason: "tt_doa_d_4h_against" };
      const st1H = tt["1H"]?.stDir ?? 0;
      if (st1H !== 0 && st1H !== dirSign && (tt.D?.ema?.depth ?? 10) < 5)
        return { qualifies: false, reason: "tt_doa_d_1h_shallow" };
    }
  }

  if (String(daCfg.tt_pdz_hard_gate ?? "false") === "true") {
    const zone = String(d?.pdz_zone_D || "unknown").toLowerCase();
    if (inferredSide === "LONG" && (zone === "premium" || zone === "premium_approach"))
      return { qualifies: false, reason: "tt_pdz_long_in_premium" };
    if (inferredSide === "SHORT" && (zone === "discount" || zone === "discount_approach"))
      return { qualifies: false, reason: "tt_pdz_short_in_discount" };
  }

  return null;
}

// ── Core Replay Loop ────────────────────────────────────────────────────────
async function runReplay() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LOCAL REPLAY: ${LABEL}`);
  console.log(`  ${START_DATE} → ${END_DATE} | Engine: ${ENGINE} | LTF: ${LEADING_LTF}`);
  console.log(`  Interval: ${INTERVAL_MIN}min | Cash: $${PORTFOLIO_START_CASH.toLocaleString()}`);
  if (CONFIG_PATH) console.log(`  Config: ${CONFIG_PATH} (${Object.keys(DEEP_AUDIT_CONFIG).length} overrides)`);
  console.log(`${"═".repeat(60)}\n`);

  const tickers = loadTickerUniverse();
  console.log(`Ticker universe: ${tickers.length} tickers`);
  if (TICKER_FILTER) console.log(`  Filtered to: ${TICKER_FILTER.join(", ")}`);

  const days = tradingDays(START_DATE, END_DATE);
  const totalDays = SMOKE_TEST_DAYS > 0 ? Math.min(SMOKE_TEST_DAYS, days.length) : days.length;
  console.log(`Trading days: ${totalDays}${SMOKE_TEST_DAYS > 0 ? ` (smoke test, ${days.length} total)` : ""}\n`);

  const replayStart = performance.now();

  for (let dayIdx = 0; dayIdx < totalDays; dayIdx++) {
    const date = days[dayIdx];
    const dayStart = performance.now();
    const openMs = marketOpenMs(date);
    const closeMs = marketCloseMs(date);
    const intervalMs = INTERVAL_MIN * 60 * 1000;
    let intervalsThisDay = 0;

    for (let ts = openMs; ts <= closeMs; ts += intervalMs) {
      intervalsThisDay++;
      stats.totalIntervals++;

      // Score VIX + SPY once per interval for context injection
      let vixPrice = null;
      try {
        const vixCandles = getCandles("VIX", "D", ts, 5);
        if (vixCandles.length > 0) vixPrice = vixCandles[vixCandles.length - 1].c;
        if (!vixPrice) {
          const vixAlt = getCandles("$VIX", "D", ts, 5);
          if (vixAlt.length > 0) vixPrice = vixAlt[vixAlt.length - 1].c;
        }
      } catch {}

      let spyData = null;
      try {
        const spyBundles = {};
        for (const cfg of TF_CONFIGS) {
          const candles = getCandles("SPY", cfg.tf, ts, cfg.limit);
          if (candles.length >= 50) spyBundles[cfg.tf] = computeTfBundle(candles);
        }
        if (spyBundles["D"]) {
          spyData = assembleTickerData("SPY", spyBundles, null, { leadingLtf: LEADING_LTF, asOfTs: ts });
        }
      } catch {}

      for (const ticker of tickers) {
        try {
          const bundles = {};
          for (const cfg of TF_CONFIGS) {
            const candles = getCandles(ticker, cfg.tf, ts, cfg.limit);
            if (candles.length >= 50) {
              bundles[cfg.tf] = computeTfBundle(candles);
            }
          }

          if (!bundles["D"]) continue;

          const existing = null;
          const tickerData = assembleTickerData(ticker, bundles, existing, {
            leadingLtf: LEADING_LTF,
            asOfTs: ts,
          });
          if (!tickerData) continue;

          tickerData._vix = vixPrice;
          tickerData._spyData = spyData ? {
            htf_score: spyData.htf_score,
            ema_regime_daily: spyData.ema_regime_daily,
            regime_class: spyData.regime_class,
            regime_score: spyData.regime_score,
          } : null;

          tickerData._env = {
            _entryEngine: ENGINE,
            _managementEngine: ENGINE,
            _leadingLtf: LEADING_LTF,
            _ripsterTuneV2: true,
            _deepAuditConfig: DEEP_AUDIT_CONFIG,
          };

          const currentPx = Number(tickerData?.price || tickerData?.close) || 0;
          if (!currentPx) continue;

          if (openPositions.has(ticker)) {
            updateMFE(ticker, currentPx);
            const trade = openPositions.get(ticker);
            const isLong = trade.direction === "LONG";

            if (trade.sl && ((isLong && currentPx <= trade.sl) || (!isLong && currentPx >= trade.sl))) {
              closeTrade(ticker, currentPx, "SL_HIT", ts);
              continue;
            }
            if (trade.tp && ((isLong && currentPx >= trade.tp) || (!isLong && currentPx <= trade.tp))) {
              closeTrade(ticker, currentPx, "TP_HIT", ts);
              continue;
            }

            const holdMs = ts - trade.entry_ts;
            const holdHours = holdMs / 3600000;
            if (holdHours > 200) {
              closeTrade(ticker, currentPx, "MAX_HOLD", ts);
              continue;
            }

            const pnlPct = isLong
              ? ((currentPx - trade.entryPrice) / trade.entryPrice) * 100
              : ((trade.entryPrice - currentPx) / trade.entryPrice) * 100;
            if (pnlPct < -5) {
              closeTrade(ticker, currentPx, "MAX_LOSS", ts);
              continue;
            }

            if (holdHours >= 24 && pnlPct < 0.2 && trade.mfe_pct < 0.5) {
              closeTrade(ticker, currentPx, "DOA", ts);
              continue;
            }

          } else {
            if (openPositions.size >= MAX_CONCURRENT_TRADES) continue;

            stats.entriesEvaluated++;

            const ctx = buildTradeContext(tickerData, ts);
            const gateResult = runUniversalGates(ctx);
            if (!gateResult.pass) {
              const reason = gateResult.reason || "gate_block";
              stats.gateBlocks[reason] = (stats.gateBlocks[reason] || 0) + 1;
              continue;
            }

            const entryResult = evaluateEntry(ctx);
            if (!entryResult || !entryResult.qualifies) {
              if (entryResult?.reason) {
                stats.gateBlocks[entryResult.reason] = (stats.gateBlocks[entryResult.reason] || 0) + 1;
              }
              continue;
            }

            if (ENGINE === "tt_core") {
              const ctxGateBlock = applyTtCoreContextGates(tickerData, ctx.side, ts, ctx.leadingLtfLabel);
              if (ctxGateBlock) {
                stats.gateBlocks[ctxGateBlock.reason] = (stats.gateBlocks[ctxGateBlock.reason] || 0) + 1;
                continue;
              }
            }

            const enriched = enrichEntry(entryResult, ctx);
            if (!enriched.qualifies) continue;

            stats.entriesQualified++;

            const direction = enriched.direction || ctx.side || "LONG";
            const atr = Number(tickerData?.atr) || currentPx * 0.02;
            const slDist = atr * DEFAULT_SL_ATR;
            const tpDist = atr * DEFAULT_TP_ATR;
            const sl = direction === "LONG" ? currentPx - slDist : currentPx + slDist;
            const tp = direction === "LONG" ? currentPx + tpDist : currentPx - tpDist;
            const confidence = enriched.confidence === "high" ? 0.8
              : enriched.confidence === "medium" ? 0.6 : 0.4;

            const _sizingMults = gatherSizingMultipliers(tickerData);

            openTrade(ticker, direction, currentPx, sl, tp, confidence,
              enriched.path || "unknown", ts, { _sizingMults });
          }
        } catch (err) {
          // best-effort per ticker
        }
      }
    }

    stats.totalDays++;
    const dayMs = performance.now() - dayStart;
    const openCount = openPositions.size;
    const closedToday = allTrades.filter(t => t._date === date && t.status !== "OPEN").length;

    if (dayIdx % 5 === 0 || dayIdx === totalDays - 1) {
      const elapsed = ((performance.now() - replayStart) / 1000).toFixed(0);
      const wr = stats.wins + stats.losses > 0
        ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) : "N/A";
      console.log(
        `[${dayIdx + 1}/${totalDays}] ${date} | ` +
        `${(dayMs / 1000).toFixed(1)}s | ` +
        `open=${openCount} closed=${closedToday} | ` +
        `PnL=$${stats.totalPnl.toFixed(0)} WR=${wr}% | ` +
        `trades=${stats.tradesOpened} | ${elapsed}s elapsed`
      );
    }
  }

  // Close all remaining open positions at last known price
  for (const [ticker, trade] of openPositions) {
    const candles = getCandles(ticker, "D", Date.now(), 1);
    const lastPx = candles.length > 0 ? candles[candles.length - 1].c : trade.entryPrice;
    closeTrade(ticker, lastPx, "END_OF_REPLAY", Date.now());
  }

  const totalSec = ((performance.now() - replayStart) / 1000).toFixed(1);
  return totalSec;
}

// ── Output ──────────────────────────────────────────────────────────────────
async function writeArtifacts(totalSec) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
  const dirName = `${LABEL}--${timestamp}`;
  const outDir = join(ROOT, "data", "backtest-artifacts", dirName);
  mkdirSync(outDir, { recursive: true });

  const wr = stats.wins + stats.losses > 0
    ? ((stats.wins / (stats.wins + stats.losses)) * 100).toFixed(1) : "N/A";
  const avgPnl = allTrades.filter(t => t.status !== "OPEN").length > 0
    ? stats.totalPnl / allTrades.filter(t => t.status !== "OPEN").length : 0;

  const monthlyBreakdown = {};
  for (const [month, mb] of Object.entries(stats.monthly).sort()) {
    const closed = mb.wins + mb.losses + mb.flat;
    monthlyBreakdown[month] = {
      entries_opened: mb.entries,
      trades_closed: closed,
      wins: mb.wins,
      losses: mb.losses,
      flat: mb.flat,
      win_rate: closed > 0 ? +((mb.wins / (mb.wins + mb.losses || 1)) * 100).toFixed(1) : "N/A",
      pnl: +mb.pnl.toFixed(2),
      avg_hold_hours: closed > 0 ? +(mb.holdHoursSum / closed).toFixed(1) : 0,
    };
  }

  const summary = {
    label: LABEL,
    engine: ENGINE,
    leading_ltf: LEADING_LTF,
    interval_min: INTERVAL_MIN,
    date_range: `${START_DATE} → ${END_DATE}`,
    start_cash: PORTFOLIO_START_CASH,
    final_cash: cash,
    total_pnl: +stats.totalPnl.toFixed(2),
    total_return_pct: +((stats.totalPnl / PORTFOLIO_START_CASH) * 100).toFixed(2),
    total_trades: stats.tradesOpened,
    wins: stats.wins,
    losses: stats.losses,
    flat: stats.flat,
    win_rate: wr,
    avg_pnl_per_trade: +avgPnl.toFixed(2),
    entries_evaluated: stats.entriesEvaluated,
    entries_qualified: stats.entriesQualified,
    qualification_rate: stats.entriesEvaluated > 0
      ? +((stats.entriesQualified / stats.entriesEvaluated) * 100).toFixed(2) : 0,
    days_processed: stats.totalDays,
    intervals_processed: stats.totalIntervals,
    runtime_seconds: +totalSec,
    gate_blocks: stats.gateBlocks,
    tickers_filtered: TICKER_FILTER || "all",
    config_overrides: CONFIG_PATH ? DEEP_AUDIT_CONFIG : null,
    monthly: monthlyBreakdown,
  };

  const trades = allTrades.map(t => ({
    id: t.id,
    ticker: t.ticker,
    direction: t.direction,
    entry_price: t.entryPrice,
    exit_price: t.exitPrice || null,
    sl: t.sl,
    tp: t.tp,
    pnl: t.realizedPnl != null ? +t.realizedPnl.toFixed(2) : null,
    pnl_pct: t.pnlPct != null ? +t.pnlPct.toFixed(2) : null,
    mfe_pct: +t.mfe_pct.toFixed(2),
    mae_pct: +t.mae_pct.toFixed(2),
    status: t.status,
    path: t.path,
    confidence: t.confidence,
    entry_date: t._date,
    exit_reason: t.exitReason || null,
    hold_hours: t.exit_ts && t.entry_ts
      ? +((t.exit_ts - t.entry_ts) / 3600000).toFixed(1) : null,
  }));

  const winners = trades.filter(t => t.status === "WIN");
  const losers = trades.filter(t => t.status === "LOSS");

  await writeFile(join(outDir, "account-summary.json"), JSON.stringify(summary, null, 2));
  await writeFile(join(outDir, "trades.json"), JSON.stringify(trades, null, 2));
  await writeFile(join(outDir, "manifest.json"), JSON.stringify({
    runner: "local-replay",
    version: "1.0.0",
    created: new Date().toISOString(),
    ...summary,
  }, null, 2));

  if (losers.length > 0) {
    const losingReport = losers
      .sort((a, b) => a.pnl - b.pnl)
      .slice(0, 20)
      .map(t => ({
        ticker: t.ticker, pnl: t.pnl, pnl_pct: t.pnl_pct,
        mfe_pct: t.mfe_pct, path: t.path, exit_reason: t.exit_reason,
        hold_hours: t.hold_hours,
        gave_back: t.mfe_pct > 1 ? `${t.mfe_pct.toFixed(1)}% → ${t.pnl_pct.toFixed(1)}%` : null,
      }));
    await writeFile(join(outDir, "losing-trades-report.json"), JSON.stringify(losingReport, null, 2));
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  REPLAY COMPLETE");
  console.log(`${"═".repeat(60)}`);
  console.log(`  Runtime:       ${totalSec}s`);
  console.log(`  Trades:        ${stats.tradesOpened} (${stats.wins}W / ${stats.losses}L / ${stats.flat}F)`);
  console.log(`  Win Rate:      ${wr}%`);
  console.log(`  Total PnL:     $${stats.totalPnl.toFixed(2)}`);
  console.log(`  Return:        ${((stats.totalPnl / PORTFOLIO_START_CASH) * 100).toFixed(2)}%`);
  console.log(`  Final Cash:    $${cash.toFixed(2)}`);
  console.log(`  Avg PnL/Trade: $${avgPnl.toFixed(2)}`);
  console.log(`  Artifacts:     ${outDir}`);

  const months = Object.keys(monthlyBreakdown).sort();
  if (months.length > 0) {
    console.log(`\n  ${"─".repeat(56)}`);
    console.log("  MONTHLY BREAKDOWN");
    console.log(`  ${"─".repeat(56)}`);
    console.log("  Month     | Entries | Closed | W  | L  | WR%   | PnL        | AvgHold");
    console.log(`  ${"─".repeat(56)}`);
    for (const m of months) {
      const mb = monthlyBreakdown[m];
      console.log(
        `  ${m}  | ${String(mb.entries_opened).padStart(7)} | ${String(mb.trades_closed).padStart(6)} | ${String(mb.wins).padStart(2)} | ${String(mb.losses).padStart(2)} | ${String(mb.win_rate).padStart(5)}% | $${String(mb.pnl.toFixed(0)).padStart(8)} | ${mb.avg_hold_hours}h`
      );
    }
    console.log(`  ${"─".repeat(56)}`);
  }

  console.log(`${"═".repeat(60)}\n`);

  return outDir;
}

// ── CLI Parser ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        result[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        result[arg.slice(2)] = argv[++i];
      } else {
        result[arg.slice(2)] = true;
      }
    }
  }
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────────
try {
  const totalSec = await runReplay();
  const outDir = await writeArtifacts(totalSec);
  db.close();
  process.exit(0);
} catch (err) {
  console.error("\nFATAL:", err);
  db.close();
  process.exit(1);
}
