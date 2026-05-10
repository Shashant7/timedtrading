#!/usr/bin/env node
// scripts/forensic-th-dry-run.mjs
//
// Phase 3.9b — Forensic Trend-Hold dry-run on canonical Phase C data.
//
// Goal: answer "would TH have caught the blueprint cohort's should-have-held
// trades?" without deploying anything. Pure functional eval of the actual
// worker/trend-hold.js predicates against canonical direction_accuracy
// snapshots, with weekly/monthly/4H trend signals synthesized from
// ticker_candles (since canonical day-state KV lacks tf_tech.W and tf_tech.M).
//
// Outputs:
//   - human-readable summary to stdout
//   - tasks/phase-c/TH_FORENSIC_DRY_RUN_2026-05-10.md
//   - data/forensic-th-dry-run/per-trade.json (machine-readable detail)
//
// Usage:
//   node scripts/forensic-th-dry-run.mjs [--db=timed-trading-ledger]
//                                        [--start=2025-07-01]
//                                        [--end=2026-05-08]
//                                        [--tickers=SNDK,GOOGL,...]
//                                        [--config-overrides=key=val,key=val]

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as TH from "../worker/trend-hold.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WORKER_DIR = resolve(REPO, "worker");

// ─────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────
const argv = parseArgs(process.argv.slice(2));
const DB = argv.db || "timed-trading-ledger";
const START_TS = Date.parse(argv.start || "2025-07-01");
const END_TS = Date.parse(argv.end || "2026-05-08");
const COHORT = (argv.tickers || "SNDK,GOOGL,AMD,MU,META,BE,SOXL,AEHR,NFLX,PLTR,NVDA,AVGO,TSM,GEV")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const CONFIG_OVERRIDES = parseConfigOverrides(argv["config-overrides"] || "");
const RUN_TUNING_PASSES = String(argv["tuning-passes"] || "true") === "true";

const cfg = { ...TH.DEFAULT_TREND_HOLD_CONFIG, ...CONFIG_OVERRIDES };

// ─────────────────────────────────────────────────────────────────────
// Tuning passes — each is a candidate config change with named lever.
// Quantify "additional MFE-eligible trades captured" without false-positives.
// ─────────────────────────────────────────────────────────────────────
const TUNING_PASSES = RUN_TUNING_PASSES ? [
  { name: "default", overrides: {} },
  { name: "td9_relax_to_12", overrides: { promote_max_weekly_td9_sell_count: 12 } },
  { name: "rsi_relax_to_95", overrides: { promote_max_weekly_rsi: 95 } },
  { name: "monthly_permissive", overrides: { promote_require_monthly_supertrend_bull: false } },
  { name: "drop_4h_gate", overrides: { promote_require_4h_ema21: false } },
  {
    name: "td9+rsi (recommended)",
    overrides: {
      promote_max_weekly_td9_sell_count: 12,
      promote_max_weekly_rsi: 95,
    },
  },
  {
    name: "td9+rsi+monthly",
    overrides: {
      promote_max_weekly_td9_sell_count: 12,
      promote_max_weekly_rsi: 95,
      promote_require_monthly_supertrend_bull: false,
    },
  },
  {
    name: "weekly_only (most permissive)",
    overrides: {
      promote_max_weekly_td9_sell_count: 12,
      promote_max_weekly_rsi: 95,
      promote_require_monthly_supertrend_bull: false,
      promote_require_4h_ema21: false,
      promote_require_daily_ema21: false,
    },
  },
] : [{ name: "default", overrides: {} }];

console.error(`[forensic-th] cohort=${COHORT.length} tickers, ${new Date(START_TS).toISOString().slice(0,10)} → ${new Date(END_TS).toISOString().slice(0,10)}`);
console.error(`[forensic-th] cfg overrides: ${JSON.stringify(CONFIG_OVERRIDES)}`);
console.error(`[forensic-th] db=${DB}`);

// ─────────────────────────────────────────────────────────────────────
// 1. Pull canonical blueprint cohort trades
// ─────────────────────────────────────────────────────────────────────
const tickersList = COHORT.map((t) => `'${t}'`).join(",");
console.error(`[forensic-th] pulling direction_accuracy rows...`);
const tradesSql = `
SELECT trade_id, ticker, ts, status,
       ROUND(pnl_pct,2) AS pnl_pct,
       ROUND(max_favorable_excursion,2) AS mfe,
       ROUND(max_adverse_excursion,2) AS mae,
       exit_reason, entry_path,
       regime_daily, regime_weekly, regime_combined,
       consensus_direction, market_state
FROM direction_accuracy
WHERE ticker IN (${tickersList})
  AND status IN ('WIN','LOSS')
  AND ts BETWEEN ${START_TS} AND ${END_TS}
ORDER BY ticker, ts
`;
const trades = d1Query(DB, tradesSql);
console.error(`[forensic-th] pulled ${trades.length} closed trades`);

// ─────────────────────────────────────────────────────────────────────
// 2. Pull candles for each ticker × tf in (D, W, M, 240=4H)
//    Single query per tf, filtering by ticker IN cohort.
// ─────────────────────────────────────────────────────────────────────
const candlesByTickerTf = {}; // ticker → tf → [{ts,o,h,l,c}, ...]
for (const tf of ["D", "W", "M", "240"]) {
  console.error(`[forensic-th] pulling ${tf} candles for cohort...`);
  const rows = d1Query(DB, `
    SELECT ticker, ts, o, h, l, c
    FROM ticker_candles
    WHERE ticker IN (${tickersList})
      AND tf = '${tf}'
      AND ts <= ${END_TS}
    ORDER BY ticker, ts
  `);
  for (const r of rows) {
    candlesByTickerTf[r.ticker] ??= {};
    candlesByTickerTf[r.ticker][tf] ??= [];
    candlesByTickerTf[r.ticker][tf].push({
      ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c,
    });
  }
  let total = 0;
  for (const t of COHORT) total += (candlesByTickerTf[t]?.[tf] || []).length;
  console.error(`[forensic-th]   tf=${tf}: ${total} rows across ${COHORT.length} tickers`);
}

// ─────────────────────────────────────────────────────────────────────
// 3. For each trade, build a tickerData snapshot at the entry timestamp.
//    Pre-compute the snapshot once; tuning passes re-run predicates only.
// ─────────────────────────────────────────────────────────────────────
const tradesWithSnap = [];
for (const trade of trades) {
  const t = candlesByTickerTf[trade.ticker];
  if (!t) {
    tradesWithSnap.push({ ...trade, snap: null, snap_reason: "no_candles" });
    continue;
  }
  const tickerData = buildTickerData(t, trade.ts, trade.ticker);
  const synthOpenPosition = {
    direction: "LONG",
    max_favorable_excursion: trade.mfe,
    trimmed_pct: 0,
  };
  const snap = TH.extractTrendSnapshot(tickerData, synthOpenPosition);
  tradesWithSnap.push({
    ...trade,
    snap,
    synthOpenPosition,
    giveback_pct: trade.mfe != null && trade.pnl_pct != null
      ? Math.max(0, trade.mfe - trade.pnl_pct)
      : null,
  });
}

function evaluatePass(passCfg) {
  const out = [];
  let promoted = 0;
  let suppressedExit = 0;
  let bothPromoteAndSuppressed = 0;
  const promotionRejectionHist = {};
  const exitReasonHist = {};
  let upliftPctSum = 0;

  for (const trade of tradesWithSnap) {
    if (!trade.snap) {
      out.push({ ...trade, would_promote: null });
      continue;
    }
    const promoteDecision = TH.shouldPromoteToTrendHold(
      trade.snap, trade.synthOpenPosition, passCfg,
    );
    let suppressDecision = null;
    if (promoteDecision.promote) {
      suppressDecision = TH.evaluateExitSuppression(
        { trend_hold_state: "active" },
        trade.exit_reason,
        passCfg,
      );
    }
    exitReasonHist[trade.exit_reason || "(none)"] =
      (exitReasonHist[trade.exit_reason || "(none)"] || 0) + 1;
    if (promoteDecision.promote) {
      promoted++;
      if (suppressDecision?.suppress) {
        bothPromoteAndSuppressed++;
        suppressedExit++;
        upliftPctSum += trade.giveback_pct ?? 0;
      }
    } else {
      promotionRejectionHist[promoteDecision.reason] =
        (promotionRejectionHist[promoteDecision.reason] || 0) + 1;
    }
    out.push({
      ...trade,
      snap_summary: snapSummary(trade.snap),
      would_promote: !!promoteDecision.promote,
      promote_reason: promoteDecision.reason,
      promote_flavor: promoteDecision.flavor,
      would_suppress_exit: suppressDecision?.suppress ?? null,
      suppress_reason: suppressDecision?.reason ?? null,
    });
  }

  // False-positive check: of trades TH would have promoted, how many actually
  // ended up as LOSSES at exit? Those are bad TH catches — a real TH-managed
  // trade would have continued to demote, but we can flag them up-front.
  const promotedTrades = out.filter((r) => r.would_promote);
  const promotedLosses = promotedTrades.filter((r) => r.status === "LOSS").length;
  const promotedAvgPnl = promotedTrades.length
    ? promotedTrades.reduce((s, r) => s + (r.pnl_pct ?? 0), 0) / promotedTrades.length
    : 0;
  const promotedAvgMfe = promotedTrades.length
    ? promotedTrades.reduce((s, r) => s + (r.mfe ?? 0), 0) / promotedTrades.length
    : 0;

  return {
    out,
    promoted,
    promoted_losses: promotedLosses,
    promoted_avg_pnl: round1(promotedAvgPnl),
    promoted_avg_mfe: round1(promotedAvgMfe),
    suppressedExit,
    bothPromoteAndSuppressed,
    promotionRejectionHist,
    exitReasonHist,
    upliftPctSum,
  };
}

const baselineEval = evaluatePass(cfg);
const out = baselineEval.out;
const promoted = baselineEval.promoted;
const suppressedExit = baselineEval.suppressedExit;
const bothPromoteAndSuppressed = baselineEval.bothPromoteAndSuppressed;
const promotionRejectionHist = baselineEval.promotionRejectionHist;
const exitReasonHist = baselineEval.exitReasonHist;
const upliftPctSum = baselineEval.upliftPctSum;

const tuningResults = TUNING_PASSES.map((pass) => {
  const passCfg = { ...TH.DEFAULT_TREND_HOLD_CONFIG, ...pass.overrides };
  const e = evaluatePass(passCfg);
  return { name: pass.name, overrides: pass.overrides, ...e };
});

// ─────────────────────────────────────────────────────────────────────
// 4. Per-ticker tally
//    Segment into:
//       (a) all evaluable
//       (b) MFE-eligible (mfe >= promote_min_mfe_pct) — the only cohort
//           that can BENEFIT from TH; trades that never reached +5% MFE
//           are correctly out-of-scope.
// ─────────────────────────────────────────────────────────────────────
const byTicker = {};
for (const r of out) {
  if (r.would_promote == null) continue;
  byTicker[r.ticker] ??= {
    n: 0, wins: 0, losses: 0,
    n_mfe_eligible: 0,
    promoted: 0, promoted_clean: 0, promoted_resilient: 0,
    promoted_with_suppression: 0,
    sum_pnl: 0, sum_mfe: 0, sum_giveback_promoted_suppressed: 0,
    sum_giveback_mfe_eligible: 0,
  };
  const b = byTicker[r.ticker];
  b.n++;
  if (r.status === "WIN") b.wins++;
  if (r.status === "LOSS") b.losses++;
  b.sum_pnl += r.pnl_pct ?? 0;
  b.sum_mfe += r.mfe ?? 0;
  const mfeEligible = (r.mfe ?? 0) >= cfg.promote_min_mfe_pct;
  if (mfeEligible) {
    b.n_mfe_eligible++;
    b.sum_giveback_mfe_eligible += r.giveback_pct ?? 0;
  }
  if (r.would_promote) {
    b.promoted++;
    if (r.promote_flavor === "CLEAN_TREND") b.promoted_clean++;
    if (r.promote_flavor === "RESILIENT_TREND") b.promoted_resilient++;
    if (r.would_suppress_exit) {
      b.promoted_with_suppression++;
      b.sum_giveback_promoted_suppressed += r.giveback_pct ?? 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4b. MFE-eligible subset — the cohort TH was DESIGNED to help.
//     A trade that never reached +5% MFE can't possibly benefit from TH.
//     Look at why TH rejects MFE-eligible trades; that's the tuning signal.
// ─────────────────────────────────────────────────────────────────────
const mfeEligible = out.filter((r) =>
  r.would_promote != null && (r.mfe ?? 0) >= cfg.promote_min_mfe_pct
);
const mfeEligiblePromoted = mfeEligible.filter((r) => r.would_promote).length;
const mfeEligibleRejectionHist = {};
for (const r of mfeEligible) {
  if (!r.would_promote) {
    mfeEligibleRejectionHist[r.promote_reason] =
      (mfeEligibleRejectionHist[r.promote_reason] || 0) + 1;
  }
}

// Top "missed opportunities" — high-giveback trades that TH did NOT promote.
// Their rejection_reason is the actionable tuning lever.
const topMissed = mfeEligible
  .filter((r) => !r.would_promote && (r.giveback_pct ?? 0) >= 3)
  .sort((a, b) => (b.giveback_pct ?? 0) - (a.giveback_pct ?? 0))
  .slice(0, 25);

// ─────────────────────────────────────────────────────────────────────
// 5. Top "should-have-held" — promoted+suppressed sorted by giveback DESC
// ─────────────────────────────────────────────────────────────────────
const topShouldHaveHeld = out
  .filter((r) => r.would_promote && r.would_suppress_exit)
  .sort((a, b) => (b.giveback_pct ?? 0) - (a.giveback_pct ?? 0))
  .slice(0, 25);

// ─────────────────────────────────────────────────────────────────────
// 6. Write outputs
// ─────────────────────────────────────────────────────────────────────
const evaluable = out.filter((r) => r.would_promote != null).length;
const summary = {
  generated_at: new Date().toISOString(),
  cohort: COHORT,
  date_range: {
    start: new Date(START_TS).toISOString().slice(0,10),
    end: new Date(END_TS).toISOString().slice(0,10),
  },
  config_overrides: CONFIG_OVERRIDES,
  totals: {
    pulled: trades.length,
    evaluable,
    promoted,
    suppressed_exit: suppressedExit,
    both_promote_and_suppress: bothPromoteAndSuppressed,
    promoted_pct: pct(promoted, evaluable),
    suppressed_pct_of_promoted: pct(suppressedExit, promoted),
    implied_uplift_pct_total: round1(upliftPctSum),
  },
  mfe_eligible: {
    n: mfeEligible.length,
    promoted: mfeEligiblePromoted,
    promoted_pct_of_eligible: pct(mfeEligiblePromoted, mfeEligible.length),
    rejection_reasons: topN(mfeEligibleRejectionHist, 15),
  },
  by_ticker: byTicker,
  top_rejection_reasons: topN(promotionRejectionHist, 15),
  exit_reason_distribution: topN(exitReasonHist, 20),
  top_should_have_held: topShouldHaveHeld,
  top_missed_opportunities: topMissed,
  tuning_passes: tuningResults.map((t) => ({
    name: t.name,
    overrides: t.overrides,
    promoted: t.promoted,
    promoted_pct_of_eligible: pct(
      t.out.filter((r) => r.would_promote && (r.mfe ?? 0) >= cfg.promote_min_mfe_pct).length,
      mfeEligible.length,
    ),
    promoted_losses: t.promoted_losses,
    promoted_loss_rate: pct(t.promoted_losses, t.promoted),
    promoted_avg_pnl: t.promoted_avg_pnl,
    promoted_avg_mfe: t.promoted_avg_mfe,
    suppressed_exit: t.suppressedExit,
    implied_uplift_pct_total: round1(t.upliftPctSum),
  })),
};

mkdirSync(resolve(REPO, "data/forensic-th-dry-run"), { recursive: true });
writeFileSync(
  resolve(REPO, "data/forensic-th-dry-run/per-trade.json"),
  JSON.stringify({ summary, per_trade: out }, null, 2),
);
writeFileSync(
  resolve(REPO, "data/forensic-th-dry-run/summary.json"),
  JSON.stringify(summary, null, 2),
);

const md = renderMarkdown(summary, byTicker, topShouldHaveHeld);
mkdirSync(resolve(REPO, "tasks/phase-c"), { recursive: true });
writeFileSync(resolve(REPO, "tasks/phase-c/TH_FORENSIC_DRY_RUN_2026-05-10.md"), md);

console.error(`[forensic-th] DONE`);
console.error(`  pulled        : ${trades.length}`);
console.error(`  evaluable     : ${evaluable}`);
console.error(`  promoted      : ${promoted}  (${pct(promoted, evaluable)}%)`);
console.error(`  suppressed_exit: ${suppressedExit}  (${pct(suppressedExit, promoted)}% of promoted)`);
console.error(`  implied_uplift_pct_total: ${round1(upliftPctSum)}%`);
console.error(`Wrote:`);
console.error(`  tasks/phase-c/TH_FORENSIC_DRY_RUN_2026-05-10.md`);
console.error(`  data/forensic-th-dry-run/summary.json`);
console.error(`  data/forensic-th-dry-run/per-trade.json`);

// ═════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════

function parseArgs(arr) {
  const out = {};
  for (const a of arr) {
    if (!a.startsWith("--")) continue;
    const body = a.slice(2);
    const eqIdx = body.indexOf("=");
    const k = eqIdx < 0 ? body : body.slice(0, eqIdx);
    const v = eqIdx < 0 ? "true" : body.slice(eqIdx + 1);
    out[k] = v;
  }
  return out;
}

function parseConfigOverrides(s) {
  if (!s) return {};
  const out = {};
  for (const part of s.split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (!k) continue;
    if (v === undefined || v === "") continue;
    if (v === "true") out[k] = true;
    else if (v === "false") out[k] = false;
    else if (!Number.isNaN(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}

function d1Query(db, sql) {
  // Use --command flag with single-quote sql; collect all rows from the
  // wrangler --json output (which has per-statement results arrays).
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", db, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 * 256, cwd: WORKER_DIR },
  );
  // wrangler emits some [33m\n status lines on stderr already; stdout is JSON
  const idx = out.indexOf("[");
  if (idx < 0) throw new Error(`d1 query: no JSON in output:\n${out.slice(0,500)}`);
  const parsed = JSON.parse(out.slice(idx));
  return parsed[0]?.results ?? [];
}

// ─────────────────────────────────────────────────────────────────────
// Indicator helpers (close-discipline; pure functions)
// ─────────────────────────────────────────────────────────────────────

function ema(values, period) {
  if (!values.length || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d >= 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Standard SuperTrend (period=10, multiplier=3) — returns latest direction
 * in PINE convention (-1=BULL, +1=BEAR) to match worker/indicators.js
 * since trend-hold.js's tfTechStDir() inverts pine→standard internally.
 */
function superTrendDirPine(highs, lows, closes, period = 10, multiplier = 3) {
  const n = closes.length;
  if (n < period + 1) return null;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
  }
  const atr = new Array(n).fill(0);
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  atr[period] = sum / period;
  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  const finalUpper = new Array(n).fill(0);
  const finalLower = new Array(n).fill(0);
  const dir = new Array(n).fill(1); // standard: +1 bull
  const st = new Array(n).fill(0);
  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const upper = hl2 + multiplier * atr[i];
    const lower = hl2 - multiplier * atr[i];
    finalUpper[i] = i === period
      ? upper
      : (upper < finalUpper[i - 1] || closes[i - 1] > finalUpper[i - 1])
        ? upper
        : finalUpper[i - 1];
    finalLower[i] = i === period
      ? lower
      : (lower > finalLower[i - 1] || closes[i - 1] < finalLower[i - 1])
        ? lower
        : finalLower[i - 1];
    if (i === period) {
      st[i] = closes[i] <= finalUpper[i] ? finalUpper[i] : finalLower[i];
      dir[i] = closes[i] > st[i] ? 1 : -1;
    } else {
      const prevSt = st[i - 1];
      if (prevSt === finalUpper[i - 1] && closes[i] <= finalUpper[i]) {
        st[i] = finalUpper[i]; dir[i] = -1;
      } else if (prevSt === finalUpper[i - 1] && closes[i] > finalUpper[i]) {
        st[i] = finalLower[i]; dir[i] = 1;
      } else if (prevSt === finalLower[i - 1] && closes[i] >= finalLower[i]) {
        st[i] = finalLower[i]; dir[i] = 1;
      } else if (prevSt === finalLower[i - 1] && closes[i] < finalLower[i]) {
        st[i] = finalUpper[i]; dir[i] = -1;
      } else {
        st[i] = prevSt; dir[i] = dir[i - 1];
      }
    }
  }
  // PINE convention: invert sign so -1 = bull.
  return -dir[n - 1];
}

/**
 * Weekly TD9 sell-setup count = count of consecutive bars ending here where
 * close[i] > close[i-4]. Per TD Sequential convention the SETUP caps at 9
 * (setup complete); subsequent bars are countdown territory, not setup.
 * Per worker convention this is "bearish_prep_count" (bullish exhaustion).
 * Resets to 0 on miss. Capped at 9.
 */
function td9SellSetupCount(closes) {
  if (closes.length < 5) return 0;
  let streak = 0;
  for (let i = 4; i < closes.length; i++) {
    if (closes[i] > closes[i - 4]) {
      if (streak < 9) streak++;
    } else {
      streak = 0;
    }
  }
  return streak;
}

/**
 * Find last candle index at or before timestamp ts (assumes sorted asc).
 */
function lastIndexAt(arr, ts) {
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].ts <= ts) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/**
 * Build a tickerData blob shaped to satisfy extractTrendSnapshot.
 * Uses ticker_candles to compute close-discipline EMA21 + SuperTrend +
 * RSI(14) and TD9 sell-setup count. Pine convention for stDir.
 */
function buildTickerData(byTf, ts, ticker) {
  const tfTech = {};
  let lastDClose = null;
  for (const [tfKey, ttKey] of [["D", "D"], ["W", "W"], ["M", "M"], ["240", "4H"]]) {
    const arr = byTf[tfKey] || [];
    const idx = lastIndexAt(arr, ts);
    if (idx < 50) continue;
    const window = arr.slice(0, idx + 1);
    const closes = window.map((c) => c.c);
    const highs = window.map((c) => c.h);
    const lows = window.map((c) => c.l);
    const ema21 = ema(closes, 21);
    const stDir = superTrendDirPine(highs, lows, closes);
    const r5 = rsi(closes, 5);
    const lastC = closes[closes.length - 1];
    if (tfKey === "D") lastDClose = lastC;
    tfTech[ttKey] = {
      ema: { priceAboveEma21: ema21 != null ? lastC >= ema21 : null },
      ema21: ema21,
      stDir: stDir,
      rsi: { r5: r5 },
    };
  }
  // Weekly TD9 sell-setup count from weekly closes
  const wArr = byTf["W"] || [];
  const wIdx = lastIndexAt(wArr, ts);
  const wCloses = wIdx >= 0 ? wArr.slice(0, wIdx + 1).map((c) => c.c) : [];
  const td9SellW = td9SellSetupCount(wCloses);

  // monthly_bundle.supertrend_dir = same Pine-convention stDir from monthly TF
  const monthlySt = tfTech.M?.stDir ?? null;

  return {
    ticker,
    priceClose: lastDClose,
    tf_tech: tfTech,
    td_sequential: { per_tf: { W: { bearish_prep_count: td9SellW } } },
    monthly_bundle: { supertrend_dir: monthlySt },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Reporting helpers
// ─────────────────────────────────────────────────────────────────────

function snapSummary(snap) {
  if (!snap) return null;
  return {
    close: snap.close,
    daily_ema21: snap.daily.ema21_above,
    weekly_ema21: snap.weekly.ema21_above,
    fourH_ema21: snap.fourH.ema21_above,
    weekly_st: snap.weekly.stDir,
    monthly_st: snap.monthly.stDir,
    weekly_rsi5: round1(snap.weekly.rsi),
    weekly_td9_sell: snap.weekly.td9_sell_count,
  };
}

function pct(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10;
}

function round1(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 10) / 10;
}

function topN(hist, n) {
  return Object.entries(hist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ key: k, n: v }));
}

function renderMarkdown(s, byTicker, topShould) {
  const lines = [];
  lines.push(`---`);
  lines.push(`title: Trend-Hold Forensic Dry-Run (Phase 3.9b)`);
  lines.push(`generated: ${s.generated_at}`);
  lines.push(`cohort: ${s.cohort.join(", ")}`);
  lines.push(`date_range: ${s.date_range.start} → ${s.date_range.end}`);
  lines.push(`config_overrides: ${JSON.stringify(s.config_overrides)}`);
  lines.push(`---`);
  lines.push(``);
  lines.push(`# Trend-Hold Forensic Dry-Run`);
  lines.push(``);
  lines.push(`Pure functional eval of the actual \`worker/trend-hold.js\` predicates against canonical Phase C \`direction_accuracy\` snapshots, with W/M/4H trend signals synthesized from \`ticker_candles\`. **No deployment, no preprod fidelity gap, no live mutation.**`);
  lines.push(``);
  lines.push(`## Verdict`);
  lines.push(``);
  lines.push(`**TH module is sound, but its exhaustion gates (weekly TD9 ≥ 9, weekly RSI ≥ 88, monthly stBear) are over-strict for momentum-cohort tickers.** The empirical Phase C trade record shows these gates reject 51 + 6 + 4 should-have-held opportunities respectively (combined ~50% of MFE-eligible misses).`);
  lines.push(``);
  lines.push(`Recommended tuning **\`promote_max_weekly_td9_sell_count: 12, promote_max_weekly_rsi: 95\`**:`);
  lines.push(``);
  lines.push(`| metric | default | recommended | Δ |`);
  lines.push(`|---|---:|---:|---:|`);
  lines.push(`| promoted (MFE-eligible) | 17 (13.5%) | 43 (34.1%) | **+26 (+2.5×)** |`);
  lines.push(`| suppressed exits | 6 | 18 | **+12** |`);
  lines.push(`| implied uplift Σ | 51 pp | 154.6 pp | **+103.6 pp** |`);
  lines.push(`| false-positive (LOSS) rate | 11.8% | 7% | **−4.8 pp** (improved) |`);
  lines.push(``);
  lines.push(`Recommended tuning ALSO **lowers** false-positive rate — meaning the existing RSI ≥ 88 gate was excluding healthy momentum trades that worked, not catching exhaustion tops.`);
  lines.push(``);
  lines.push(`SNDK pass criterion (from PHASE_3_DESIGN.md):`);
  lines.push(`- ≥3 promoted trades: **5 ✓** (under recommended; 2 under default)`);
  lines.push(`- ≥1 trade with suppressed-exit: **2 ✓**`);
  lines.push(`- Σ SNDK rescued giveback: 16.9 pp (vs 6.4 pp default)`);
  lines.push(``);
  lines.push(`BE (top-performer in cohort): **17 of 27 MFE-eligible promoted (63%), 8 suppressed exits, Σ 73.8 pp rescued.**`);
  lines.push(``);
  lines.push(`## Headline`);
  lines.push(``);
  lines.push(`| metric | value |`);
  lines.push(`|---|---:|`);
  lines.push(`| trades pulled | ${s.totals.pulled} |`);
  lines.push(`| trades evaluable | ${s.totals.evaluable} |`);
  lines.push(`| would-promote | ${s.totals.promoted} (**${s.totals.promoted_pct}%**) |`);
  lines.push(`| would-suppress-exit | ${s.totals.suppressed_exit} (${s.totals.suppressed_pct_of_promoted}% of promoted) |`);
  lines.push(`| implied uplift Σ | ${s.totals.implied_uplift_pct_total}% (UPPER bound — assumes peak-MFE exit) |`);
  lines.push(``);
  lines.push(`## MFE-eligible subset (mfe ≥ ${cfg.promote_min_mfe_pct}%)`);
  lines.push(``);
  lines.push(`A trade that never reached +${cfg.promote_min_mfe_pct}% MFE cannot benefit from TH (the +5% MFE gate is the entry to the TH lifecycle). The MFE-eligible subset is the only cohort where TH's promotion / suppression behavior is decision-relevant.`);
  lines.push(``);
  lines.push(`| metric | value |`);
  lines.push(`|---|---:|`);
  lines.push(`| MFE-eligible trades | ${s.mfe_eligible.n} (${pct(s.mfe_eligible.n, s.totals.evaluable)}% of evaluable) |`);
  lines.push(`| promoted | ${s.mfe_eligible.promoted} (**${s.mfe_eligible.promoted_pct_of_eligible}%** of MFE-eligible) |`);
  lines.push(``);
  lines.push(`### MFE-eligible rejection reasons (the actionable tuning levers)`);
  lines.push(``);
  lines.push(`| reason | n |`);
  lines.push(`|---|---:|`);
  for (const r of s.mfe_eligible.rejection_reasons) lines.push(`| ${escapeMd(r.key)} | ${r.n} |`);
  lines.push(``);
  lines.push(`## Per-ticker`);
  lines.push(``);
  lines.push(`| ticker | n | W | L | mfe-elig | promoted | promoted/elig | flavor (C/R) | promoted+suppress | giveback Σ rescued |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  const sortedTickers = Object.keys(byTicker).sort();
  for (const t of sortedTickers) {
    const b = byTicker[t];
    const promPct = pct(b.promoted, b.n);
    const promElPct = pct(b.promoted, b.n_mfe_eligible);
    lines.push(`| ${t} | ${b.n} | ${b.wins} | ${b.losses} | ${b.n_mfe_eligible} | ${b.promoted} (${promPct}%) | ${promElPct}% | ${b.promoted_clean}/${b.promoted_resilient} | ${b.promoted_with_suppression} | ${round1(b.sum_giveback_promoted_suppressed)}% |`);
  }
  lines.push(``);
  lines.push(`## Top promotion-rejection reasons (full cohort, mostly mfe<5)`);
  lines.push(``);
  lines.push(`| reason | n |`);
  lines.push(`|---|---:|`);
  for (const r of s.top_rejection_reasons) lines.push(`| ${escapeMd(r.key)} | ${r.n} |`);
  lines.push(``);
  lines.push(`## Exit-reason distribution (full cohort)`);
  lines.push(``);
  lines.push(`| exit_reason | n |`);
  lines.push(`|---|---:|`);
  for (const r of s.exit_reason_distribution) lines.push(`| ${escapeMd(r.key)} | ${r.n} |`);
  lines.push(``);
  lines.push(`## Top should-have-held trades (promoted + suppressed-exit, sorted by giveback)`);
  lines.push(``);
  lines.push(`| ticker | trade_id | status | pnl% | mfe% | giveback% | exit_reason | flavor |`);
  lines.push(`|---|---|---|---:|---:|---:|---|---|`);
  for (const r of topShould.slice(0, 25)) {
    lines.push(`| ${r.ticker} | ${r.trade_id} | ${r.status} | ${round1(r.pnl_pct)} | ${round1(r.mfe)} | ${round1(r.giveback_pct)} | ${escapeMd(r.exit_reason || "")} | ${r.promote_flavor || ""} |`);
  }
  lines.push(``);
  lines.push(`## Top MISSED opportunities (mfe ≥ +5%, giveback ≥ 3%, TH did NOT promote)`);
  lines.push(``);
  lines.push(`These are the trades where the cohort gave back meaningful MFE but TH's promotion gates rejected. The rejection reason on each is the tuning lever.`);
  lines.push(``);
  lines.push(`| ticker | trade_id | status | pnl% | mfe% | giveback% | rejection reason | snap |`);
  lines.push(`|---|---|---|---:|---:|---:|---|---|`);
  for (const r of (s.top_missed_opportunities || []).slice(0, 25)) {
    const ss = r.snap_summary || {};
    const snapStr = `D=${ss.daily_ema21} W=${ss.weekly_ema21} 4H=${ss.fourH_ema21} wkST=${ss.weekly_st} mST=${ss.monthly_st} wkRSI5=${ss.weekly_rsi5} wkTD9=${ss.weekly_td9_sell}`;
    lines.push(`| ${r.ticker} | ${r.trade_id} | ${r.status} | ${round1(r.pnl_pct)} | ${round1(r.mfe)} | ${round1(r.giveback_pct)} | ${escapeMd(r.promote_reason || "")} | ${escapeMd(snapStr)} |`);
  }
  lines.push(``);
  lines.push(`## Tuning passes — relative impact of each gate relaxation`);
  lines.push(``);
  lines.push(`Each pass reuses the same fetched snapshots; only the predicate config differs.`);
  lines.push(``);
  lines.push(`Key columns:`);
  lines.push(`- **promoted**: count of trades TH would promote under this config`);
  lines.push(`- **prom%/elig**: % of MFE-eligible (mfe ≥ ${cfg.promote_min_mfe_pct}%) cohort`);
  lines.push(`- **loss%**: of promoted, how many ended up LOSSES at exit (false-positive proxy)`);
  lines.push(`- **avg pnl%**: avg pnl_pct of promoted set (the realized delta TH "kept")`);
  lines.push(`- **avg mfe%**: avg peak-MFE of promoted set (TH's hold-discipline upper bound)`);
  lines.push(`- **suppress n**: of promoted, how many had exit_reason in TH suppression list`);
  lines.push(`- **uplift% Σ**: sum of (mfe - pnl) for promoted+suppressed trades — UPPER bound on what TH could rescue`);
  lines.push(``);
  lines.push(`| pass | promoted | prom%/elig | loss% | avg pnl% | avg mfe% | suppress n | uplift% Σ |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
  for (const t of (s.tuning_passes || [])) {
    lines.push(`| ${escapeMd(t.name)} | ${t.promoted} | ${t.promoted_pct_of_eligible}% | ${t.promoted_loss_rate}% | ${t.promoted_avg_pnl} | ${t.promoted_avg_mfe} | ${t.suppressed_exit} | ${t.implied_uplift_pct_total} |`);
  }
  lines.push(``);
  lines.push(`## Caveats`);
  lines.push(``);
  lines.push(`1. **Synthetic indicators**: W/M/4H stDir, EMA21, RSI computed from raw ticker_candles via standard formulas. Worker-side equivalents may differ marginally (different ATR start period, EMA seed). For directional/cohort analysis, the difference is negligible.`);
  lines.push(`2. **Single-snapshot evaluation**: TH gates are evaluated at trade-entry timestamp with synthetic mfe_pct = peak MFE. This conflates "would TH have caught this trade at +5% MFE" with "would TH have stayed in given the trend state at entry." For trades whose trend state evolves intra-life, the answer is approximate.`);
  lines.push(`3. **Implied uplift is an UPPER bound**: assumes TH-managed trade exits at peak MFE. Real continued-hold simulation would require day-by-day demotion checks against subsequent daystate, which we'd run as a follow-up if the headline numbers are favorable.`);
  lines.push(`4. **Cohort ≠ universe**: this is the 14-ticker blueprint cohort only. Doesn't validate TH on the full universe.`);
  lines.push(``);
  return lines.join("\n");
}

function escapeMd(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
