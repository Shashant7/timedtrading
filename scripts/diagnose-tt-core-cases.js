#!/usr/bin/env node

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { assembleTickerData, computeTfBundle } from "../worker/indicators.js";
import { buildTradeContext } from "../worker/pipeline/trade-context.js";
import { runUniversalGates } from "../worker/pipeline/gates.js";
import { enrichEntry } from "../worker/pipeline/enrichment.js";
import { evaluateEntry as evaluateTtCore } from "../worker/pipeline/tt-core-entry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const DB_PATH = join(ROOT, "data", "timed-local.db");
const DEFAULT_CONFIG = join(ROOT, "configs", "iter5-runtime-recovered-20260325.json");

const CASES = [
  { label: "fix_bad_pullback_hard_cap", ticker: "FIX", ts: 1751378400000 },
  { label: "fix_bad_pullback_doa", ticker: "FIX", ts: 1751392800000 },
  { label: "fix_bad_momentum_breakeven", ticker: "FIX", ts: 1751895000000 },
  { label: "fix_good_pullback_control", ticker: "FIX", ts: 1752160800000 },
  { label: "fix_bad_pullback_late", ticker: "FIX", ts: 1753108200000 },
  { label: "fix_good_momentum_control", ticker: "FIX", ts: 1753380000000 },
  { label: "rblx_bad_momentum_hard_cap", ticker: "RBLX", ts: 1751376600000 },
  { label: "rblx_good_momentum_control", ticker: "RBLX", ts: 1751895000000 },
  { label: "rblx_good_pullback_control", ticker: "RBLX", ts: 1752162000000 },
  { label: "rblx_bad_momentum_soft_fuse", ticker: "RBLX", ts: 1752674400000 },
  { label: "rblx_bad_momentum_confirmed", ticker: "RBLX", ts: 1752761400000 },
  { label: "rblx_bad_momentum_late", ticker: "RBLX", ts: 1752846000000 },
  { label: "rblx_bad_pullback_hard_cap", ticker: "RBLX", ts: 1753118400000 },
];

const args = parseArgs(process.argv.slice(2));
const configPath = args.config ? join(ROOT, args.config) : DEFAULT_CONFIG;
const leadingLtf = String(args.ltf || "10");
const selectedLabels = args.labels
  ? new Set(String(args.labels).split(",").map((s) => s.trim()).filter(Boolean))
  : null;
const selectedTickers = args.tickers
  ? new Set(String(args.tickers).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))
  : null;

const configRaw = JSON.parse(readFileSync(configPath, "utf8"));
const modelConfig = normalizeConfigEnvelope(configRaw);

const TF_CONFIGS = [
  { tf: "M", limit: 200 },
  { tf: "W", limit: 300 },
  { tf: "D", limit: 600 },
  { tf: "240", limit: 500 },
  { tf: "60", limit: 500 },
  { tf: "30", limit: 500 },
  { tf: leadingLtf, limit: 600 },
];
const TF_MAX_AGE_MS = {
  M: 45 * 24 * 60 * 60 * 1000,
  W: 21 * 24 * 60 * 60 * 1000,
  D: 7 * 24 * 60 * 60 * 1000,
  "240": 5 * 24 * 60 * 60 * 1000,
  "60": 5 * 24 * 60 * 60 * 1000,
  "30": 5 * 24 * 60 * 60 * 1000,
  "15": 5 * 24 * 60 * 60 * 1000,
  "10": 5 * 24 * 60 * 60 * 1000,
  "5": 5 * 24 * 60 * 60 * 1000,
};

const db = new Database(DB_PATH, { readonly: true });
const stmtCandles = db.prepare(
  "SELECT ts, o, h, l, c, v FROM ticker_candles WHERE ticker = ? AND tf = ? AND ts <= ? ORDER BY ts DESC LIMIT ?",
);

main();

function main() {
  const cases = CASES.filter((entry) => {
    if (selectedLabels && !selectedLabels.has(entry.label)) return false;
    if (selectedTickers && !selectedTickers.has(entry.ticker)) return false;
    return true;
  });

  const out = [];
  for (const entry of cases) {
    out.push(diagnoseCase(entry));
  }

  console.log(JSON.stringify(out, null, 2));
}

function diagnoseCase(entry) {
  const { ticker, ts, label } = entry;
  const bundles = {};
  const bundleStatus = {};
  for (const cfg of TF_CONFIGS) {
    const candles = getCandles(ticker, cfg.tf, ts, cfg.limit);
    const status = summarizeBundleStatus(candles, cfg.tf, ts);
    bundleStatus[cfg.tf] = status;
    if (status.fresh) bundles[cfg.tf] = computeTfBundle(candles);
  }
  if (!bundles.D) {
    return { label, ticker, ts, error: "missing_daily_bundle", bundleStatus };
  }

  let spyData = null;
  const spyBundles = {};
  for (const cfg of TF_CONFIGS) {
    const candles = getCandles("SPY", cfg.tf, ts, cfg.limit);
    const status = summarizeBundleStatus(candles, cfg.tf, ts);
    if (status.fresh) spyBundles[cfg.tf] = computeTfBundle(candles);
  }
  if (spyBundles.D) {
    spyData = assembleTickerData("SPY", spyBundles, null, { leadingLtf, asOfTs: ts });
  }

  let vixPrice = null;
  const vixCandles = getCandles("VIX", "D", ts, 5);
  if (vixCandles.length > 0) {
    vixPrice = vixCandles[vixCandles.length - 1].c;
  } else {
    const vixAlt = getCandles("$VIX", "D", ts, 5);
    if (vixAlt.length > 0) vixPrice = vixAlt[vixAlt.length - 1].c;
  }

  const tickerData = assembleTickerData(ticker, bundles, null, {
    leadingLtf,
    asOfTs: ts,
  });
  if (!tickerData) {
    return { label, ticker, ts, error: "assembleTickerData_null" };
  }

  tickerData._vix = vixPrice;
  tickerData._spyData = spyData ? {
    htf_score: spyData.htf_score,
    ema_regime_daily: spyData.ema_regime_daily,
    regime_class: spyData.regime_class,
    regime_score: spyData.regime_score,
  } : null;
  tickerData._env = {
    _isReplay: true,
    _entryEngine: "tt_core",
    _managementEngine: "tt_core",
    _leadingLtf: leadingLtf,
    _ripsterTuneV2: true,
    _deepAuditConfig: modelConfig,
  };

  const ctx = buildTradeContext(tickerData, ts);
  const universalGate = runUniversalGates(ctx);
  const entryResult = universalGate?.pass === false ? null : evaluateTtCore(ctx);
  const contextGate = entryResult?.qualifies
    ? applyTtCoreContextGates(tickerData, ctx.side, ts, ctx.leadingLtfLabel)
    : null;
  const enriched = entryResult?.qualifies && !contextGate
    ? enrichEntry(entryResult, ctx)
    : null;

  return {
    label,
    ticker,
    ts,
    bundleStatus,
    state: tickerData.state || null,
    side: ctx.side || null,
    rank: Number(tickerData.rank ?? tickerData.score) || null,
    price: Number(tickerData.price) || null,
    universalGate: universalGate?.pass === false
      ? { pass: false, reason: universalGate.reason || "blocked" }
      : { pass: true },
    entryResult: entryResult
      ? {
          qualifies: !!entryResult.qualifies,
          reason: entryResult.reason || null,
          path: entryResult.path || null,
          confidence: entryResult.confidence || null,
          metadata: entryResult.metadata || null,
        }
      : null,
    contextGate: contextGate ? { pass: false, reason: contextGate.reason || "blocked" } : { pass: true },
    enriched: enriched
      ? {
          qualifies: !!enriched.qualifies,
          path: enriched.path || null,
          direction: enriched.direction || null,
          confidence: enriched.confidence || null,
        }
      : null,
    tf: {
      m10: summarizeTf(ctx.tf?.m10),
      m15: summarizeTf(ctx.tf?.m15),
      m30: summarizeTf(ctx.tf?.m30),
      h1: summarizeTf(ctx.tf?.h1),
      h4: summarizeTf(ctx.tf?.h4),
      D: summarizeTf(ctx.tf?.D),
    },
  };
}

function getCandles(ticker, tf, beforeTs, limit) {
  return stmtCandles.all(ticker, tf, beforeTs, limit).reverse();
}

function getTfMaxAgeMs(tf) {
  return TF_MAX_AGE_MS[String(tf)] ?? (5 * 24 * 60 * 60 * 1000);
}

function summarizeBundleStatus(candles, tf, asOfTs) {
  const count = candles?.length || 0;
  const lastTs = count ? Number(candles[count - 1]?.ts || 0) : null;
  const ageMs = lastTs ? (asOfTs - lastTs) : null;
  const fresh = count >= 50 && !!lastTs && ageMs <= getTfMaxAgeMs(tf);
  return {
    count,
    lastTs,
    ageMs,
    fresh,
  };
}

function summarizeTf(tf) {
  if (!tf) return null;
  return {
    stDir: Number(tf.stDir) || 0,
    emaStructure: Number(tf?.ema?.structure) || 0,
    emaDepth: Number(tf?.ema?.depth) || 0,
    rsi: Number(tf?.rsi?.r5) || null,
    c5_12: summarizeCloud(tf?.ripster?.c5_12),
    c8_9: summarizeCloud(tf?.ripster?.c8_9),
    c34_50: summarizeCloud(tf?.ripster?.c34_50),
  };
}

function summarizeCloud(cloud) {
  if (!cloud) return null;
  return {
    bull: !!cloud.bull,
    bear: !!cloud.bear,
    above: !!cloud.above,
    below: !!cloud.below,
    inCloud: !!cloud.inCloud,
    fastSlope: Number(cloud.fastSlope) || 0,
    slowSlope: Number(cloud.slowSlope) || 0,
    distToCloudPct: Number(cloud.distToCloudPct) || 0,
    crossUp: !!cloud.crossUp,
    crossDn: !!cloud.crossDn,
  };
}

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
    if (arr.some((r) => String(r).toUpperCase() === tickerSwingRegime)) {
      if (isBear && inferredSide === "SHORT") {
        // allow
      } else if (isBull && inferredSide === "LONG") {
        // allow
      } else {
        return { qualifies: false, reason: "tt_regime_blocked" };
      }
    }
  }

  if (String(daCfg.tt_spy_directional_gate ?? "false") === "true" && d?._spyData) {
    const spyHtf = Number(d._spyData?.htf_score) || 0;
    const spyRegime = Number(d._spyData?.ema_regime_daily) || 0;
    if (inferredSide === "LONG" && spyHtf < -10 && spyRegime <= -1) {
      return { qualifies: false, reason: "tt_spy_bearish_long_block" };
    }
    if (inferredSide === "SHORT" && spyHtf > 10 && spyRegime >= 1) {
      return { qualifies: false, reason: "tt_spy_bullish_short_block" };
    }
  }

  const dangerMax = Number(daCfg.deep_audit_danger_max_signals);
  if (Number.isFinite(dangerMax) && dangerMax > 0) {
    const tt = d?.tf_tech || {};
    const isLong = inferredSide === "LONG";
    const dirSign = isLong ? 1 : -1;
    let cnt = 0;

    if ((tt.D?.stDir ?? 0) !== 0 && (tt.D?.stDir ?? 0) !== dirSign) cnt++;
    const s30 = tt["30"]?.stDir ?? 0;
    if (s30 !== 0 && (tt["30"]?.stSlope ?? 0) !== s30) cnt++;
    if ((tt["1H"]?.ema?.depth ?? 0) < (Number(daCfg.deep_audit_danger_ema_depth_min) || 5)) cnt++;
    if ((tt["4H"]?.stDir ?? 0) !== 0 && (tt["4H"]?.stDir ?? 0) !== dirSign) cnt++;
    const ltfKey = leadingLtfLabel === "10m" ? "10" : leadingLtfLabel === "15m" ? "15" : "30";
    const sLtf = tt[ltfKey]?.stDir ?? 0;
    if (sLtf !== 0 && (tt[ltfKey]?.stSlope ?? 0) !== sLtf) cnt++;
    if ((Number(d?._vix) || 0) > (Number(daCfg.deep_audit_danger_vix_threshold) || 25)) cnt++;
    const stTFs = ["D", "4H", "1H", "30", ltfKey];
    let aligned = 0;
    for (const tf of stTFs) {
      if ((tt[tf]?.stDir ?? 0) === dirSign) aligned++;
    }
    if (aligned < (Number(daCfg.deep_audit_danger_min_st_aligned) || 3)) cnt++;

    if (cnt > dangerMax) return { qualifies: false, reason: "tt_danger_score_exceeded" };
  }

  if (String(daCfg.doa_gate_enabled ?? "true") === "true") {
    const tt = d?.tf_tech || {};
    const dirSign = inferredSide === "LONG" ? 1 : -1;
    const stD = tt.D?.stDir ?? 0;
    if (stD !== 0 && stD !== dirSign) {
      const st4H = tt["4H"]?.stDir ?? 0;
      if (st4H !== 0 && st4H !== dirSign) return { qualifies: false, reason: "tt_doa_d_4h_against" };
      const st1H = tt["1H"]?.stDir ?? 0;
      if (st1H !== 0 && st1H !== dirSign && (tt.D?.ema?.depth ?? 10) < 5) {
        return { qualifies: false, reason: "tt_doa_d_1h_shallow" };
      }
    }
  }

  if (String(daCfg.tt_pdz_hard_gate ?? "false") === "true") {
    const zone = String(d?.pdz_zone_D || "unknown").toLowerCase();
    if (inferredSide === "LONG" && (zone === "premium" || zone === "premium_approach")) {
      return { qualifies: false, reason: "tt_pdz_long_in_premium" };
    }
    if (inferredSide === "SHORT" && (zone === "discount" || zone === "discount_approach")) {
      return { qualifies: false, reason: "tt_pdz_short_in_discount" };
    }
  }

  return null;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function normalizeConfigEnvelope(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)) return raw.config;
  return raw;
}
