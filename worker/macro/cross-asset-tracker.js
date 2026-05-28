// worker/macro/cross-asset-tracker.js
//
// 2026-05-28 — Discovery Phase 5: cross-country + cross-asset macro
// tracking. Answers the user's thesis surface directly: "US markets likely
// to outperform due to energy + AI infrastructure; South Korea has
// outperformed; China importing energy hasn't performed well."
//
// Data flow:
//   Daily cron → runMacroSnapshot(env) →
//     1. For each macro_universe ticker, load last 65 daily candles from D1
//     2. Compute 20-day + 60-day total return + relative strength vs SPY
//     3. Classify each into outperforming / inline / underperforming
//     4. Roll up country_rotation + cross_asset_regime
//     5. Persist to KV timed:macro:cross-asset-summary
//
//   CIO eval cycle → reads timed:macro:cross-asset-summary via memoryCache
//     → CIO memory L13 macro_tilt
//
// Cost: free — uses existing TwelveData candle pipeline. The macro universe
// must be ingested as part of the daily candle backfill (added to backfill
// universe via include_user=1 or by listing macro tickers in SECTOR_MAP).

import { THEMES } from "../sector-mapping.js";

const COUNTRY_THEMES = [
  "country_korea", "country_germany", "country_japan", "country_china",
  "country_india", "country_brazil", "country_taiwan", "country_uk",
  "country_emerging", "country_developed",
];

const CROSS_ASSET_THEMES = [
  "cross_asset_dollar", "cross_asset_gold", "cross_asset_silver",
  "cross_asset_oil", "cross_asset_nat_gas", "cross_asset_rates",
  "cross_asset_credit", "cross_asset_fx", "cross_asset_vix",
];

const BENCHMARK = "SPY";
const RS_OUTPERFORM_THRESHOLD = 1.5; // % points over SPY over the window
const RS_UNDERPERFORM_THRESHOLD = -1.5;

// Pretty labels for the CIO prompt — derive from theme name.
const THEME_LABELS = {
  country_korea: "South Korea (EWY)",
  country_germany: "Germany (EWG)",
  country_japan: "Japan (EWJ)",
  country_china: "China (FXI)",
  country_india: "India (INDA)",
  country_brazil: "Brazil (EWZ)",
  country_taiwan: "Taiwan (EWT)",
  country_uk: "UK (EWU)",
  country_emerging: "Emerging Markets (EEM)",
  country_developed: "Developed ex-US (EFA)",
  cross_asset_dollar: "USD (UUP)",
  cross_asset_gold: "Gold (GLD)",
  cross_asset_silver: "Silver (SLV)",
  cross_asset_oil: "WTI Crude (USO)",
  cross_asset_nat_gas: "Nat Gas (UNG)",
  cross_asset_rates: "Long-Duration Treasuries (TLT)",
  cross_asset_credit: "High-Yield Credit (HYG)",
  cross_asset_fx: "Major FX",
  cross_asset_vix: "VIX (VXX)",
};

// Pick the primary ticker for a theme (first member). For groups like
// country_china = ["FXI","MCHI","KWEB","ASHR","YINN"], FXI is the headline.
function primaryTickerForTheme(theme) {
  return (THEMES[theme] || [])[0] || null;
}

async function loadDailyCandles(env, ticker, limit = 65) {
  if (!env?.DB) return null;
  const rows = (await env.DB.prepare(`
    SELECT ts, c FROM ticker_candles
     WHERE ticker = ?1 AND tf = 'D'
     ORDER BY ts DESC LIMIT ?2
  `).bind(String(ticker).toUpperCase(), limit).all().catch(() => ({ results: [] })))?.results || [];
  if (rows.length < 2) return null;
  // Returned DESC; reverse for chronological.
  return rows.reverse().map((r) => ({ ts: Number(r.ts), c: Number(r.c) }));
}

// % change over the last `bars` chronological closes.
function percentChange(candles, bars) {
  if (!Array.isArray(candles) || candles.length < bars + 1) return null;
  const last = candles[candles.length - 1].c;
  const ref = candles[candles.length - 1 - bars].c;
  if (!Number.isFinite(last) || !Number.isFinite(ref) || ref <= 0) return null;
  return +(((last - ref) / ref) * 100).toFixed(2);
}

function classifyRs(rsPct) {
  if (!Number.isFinite(rsPct)) return "no_data";
  if (rsPct >= RS_OUTPERFORM_THRESHOLD) return "outperforming";
  if (rsPct <= RS_UNDERPERFORM_THRESHOLD) return "underperforming";
  return "inline";
}

// Compute one theme's snapshot — typically just one ticker's RS.
async function snapshotTheme(env, theme, benchmarkCandles) {
  const ticker = primaryTickerForTheme(theme);
  if (!ticker) return null;
  const candles = await loadDailyCandles(env, ticker, 65);
  if (!candles) {
    return { theme, ticker, label: THEME_LABELS[theme] || theme, has_data: false };
  }
  const ret_20d = percentChange(candles, 20);
  const ret_60d = percentChange(candles, 60);
  const bench_20d = percentChange(benchmarkCandles, 20);
  const bench_60d = percentChange(benchmarkCandles, 60);
  const rs_20d = (ret_20d != null && bench_20d != null) ? +(ret_20d - bench_20d).toFixed(2) : null;
  const rs_60d = (ret_60d != null && bench_60d != null) ? +(ret_60d - bench_60d).toFixed(2) : null;
  return {
    theme,
    ticker,
    label: THEME_LABELS[theme] || theme,
    has_data: true,
    ret_20d,
    ret_60d,
    rs_20d_vs_spy: rs_20d,
    rs_60d_vs_spy: rs_60d,
    classification_20d: classifyRs(rs_20d),
    classification_60d: classifyRs(rs_60d),
  };
}

export async function runMacroSnapshot(env) {
  if (!env?.DB) return { ok: false, error: "no_db" };
  const benchmarkCandles = await loadDailyCandles(env, BENCHMARK, 65);
  if (!benchmarkCandles) {
    return { ok: false, error: `benchmark_${BENCHMARK}_not_loaded` };
  }
  const bench_20d = percentChange(benchmarkCandles, 20);
  const bench_60d = percentChange(benchmarkCandles, 60);

  const countries = [];
  for (const theme of COUNTRY_THEMES) {
    const snap = await snapshotTheme(env, theme, benchmarkCandles);
    if (snap) countries.push(snap);
  }
  const crossAssets = [];
  for (const theme of CROSS_ASSET_THEMES) {
    const snap = await snapshotTheme(env, theme, benchmarkCandles);
    if (snap) crossAssets.push(snap);
  }

  // Rank countries by 20-day RS.
  const countriesByRs = countries
    .filter((c) => c.has_data && Number.isFinite(c.rs_20d_vs_spy))
    .sort((a, b) => b.rs_20d_vs_spy - a.rs_20d_vs_spy);
  const topOutperformers = countriesByRs.slice(0, 3).map((c) => ({
    label: c.label, rs_20d: c.rs_20d_vs_spy, ret_20d: c.ret_20d,
  }));
  const topUnderperformers = countriesByRs.slice(-3).reverse().map((c) => ({
    label: c.label, rs_20d: c.rs_20d_vs_spy, ret_20d: c.ret_20d,
  }));

  // Cross-asset narrative — distill the key trends into one-liner.
  const aBy = {};
  for (const a of crossAssets) {
    if (a.has_data) aBy[a.theme] = a;
  }
  const dollar = aBy.cross_asset_dollar?.classification_20d || "no_data";
  const gold = aBy.cross_asset_gold?.classification_20d || "no_data";
  const oil = aBy.cross_asset_oil?.classification_20d || "no_data";
  const rates = aBy.cross_asset_rates?.classification_20d || "no_data";
  const credit = aBy.cross_asset_credit?.classification_20d || "no_data";
  const natGas = aBy.cross_asset_nat_gas?.classification_20d || "no_data";

  const summary = {
    computed_at: Date.now(),
    benchmark: BENCHMARK,
    benchmark_20d_pct: bench_20d,
    benchmark_60d_pct: bench_60d,
    country_rotation: {
      top_outperformers: topOutperformers,
      top_underperformers: topUnderperformers,
      all: countries,
    },
    cross_asset_regime: {
      dollar_20d: dollar,
      gold_20d: gold,
      oil_20d: oil,
      nat_gas_20d: natGas,
      rates_20d: rates,
      credit_20d: credit,
      all: crossAssets,
    },
    macro_narrative: buildMacroNarrative(topOutperformers, topUnderperformers, aBy),
  };

  // Persist to KV for CIO to read.
  const KV = env?.KV_TIMED || env?.KV;
  if (KV) {
    try {
      await KV.put("timed:macro:cross-asset-summary", JSON.stringify(summary), {
        expirationTtl: 3 * 86400,
      });
    } catch (e) {
      console.warn("[MACRO] KV put failed:", String(e?.message || e).slice(0, 150));
    }
  }

  return { ok: true, ...summary };
}

// Build a 1-2 sentence narrative for CIO to read directly.
function buildMacroNarrative(topOut, topUnder, aBy) {
  const parts = [];
  if (topOut.length > 0) {
    parts.push(`Outperforming vs SPY (20d): ${topOut.map((c) => `${c.label} +${c.rs_20d}`).join(", ")}.`);
  }
  if (topUnder.length > 0) {
    parts.push(`Underperforming: ${topUnder.map((c) => `${c.label} ${c.rs_20d}`).join(", ")}.`);
  }
  const dollar = aBy.cross_asset_dollar?.ret_20d;
  const gold = aBy.cross_asset_gold?.ret_20d;
  const oil = aBy.cross_asset_oil?.ret_20d;
  const rates = aBy.cross_asset_rates?.ret_20d;
  const credit = aBy.cross_asset_credit?.ret_20d;
  const xParts = [];
  if (Number.isFinite(dollar)) xParts.push(`USD ${dollar >= 0 ? "+" : ""}${dollar}%`);
  if (Number.isFinite(gold)) xParts.push(`gold ${gold >= 0 ? "+" : ""}${gold}%`);
  if (Number.isFinite(oil)) xParts.push(`oil ${oil >= 0 ? "+" : ""}${oil}%`);
  if (Number.isFinite(rates)) xParts.push(`TLT ${rates >= 0 ? "+" : ""}${rates}%`);
  if (Number.isFinite(credit)) xParts.push(`HYG ${credit >= 0 ? "+" : ""}${credit}%`);
  if (xParts.length > 0) parts.push(`Cross-asset 20d: ${xParts.join(", ")}.`);
  return parts.join(" ");
}

// Load the latest macro snapshot for CIO memory enrichment. Cheap KV read.
export async function loadMacroSnapshot(env) {
  const KV = env?.KV_TIMED || env?.KV;
  if (!KV) return null;
  try {
    const raw = await KV.get("timed:macro:cross-asset-summary");
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
