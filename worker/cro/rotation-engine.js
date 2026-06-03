// worker/cro/rotation-engine.js
// ─────────────────────────────────────────────────────────────────────────────
//  Phase 5 — Rotation engine. Computes the same kind of cross-asset / sector
//  rotation signals Fundstrat Direct publishes, but against TT's own
//  universe data so the CRO can corroborate or contradict the FSD read.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Three independent computes, each cheap, each driven off the
//  ticker_candles D1 table:
//
//    A. computePairwiseRS   — relative-strength pairs (RSP/SPY, IGV/SMH,
//       XLI/SPY, MAGS/SPY, ...) with trendline + 20d ROC + TD Buy/Sell
//       Setup state.
//    B. computeThemeBreadth — for each theme in sector-mapping.THEMES,
//       compute the % of constituents up >X% over today / 5d / 20d.
//       Surfaces the "are all semis bid? Are materials all up?" view the
//       operator explicitly asked for.
//    C. computeCorrelationByTheme — for each theme, compute the average
//       pairwise correlation of its members' daily returns over a rolling
//       window. High intra-theme correlation = the theme is "all moving
//       together" (regime signal). Low correlation = theme is decoupling
//       (often precedes a leadership shift). Cheaper than a full N² matrix
//       (~200 tickers → 20k pairs); intra-theme is bounded by theme size
//       (typically 5–15 names → ~50 pairs max per theme).
//
//  All three compute together, cache to KV at
//  `timed:cro:rotation-snapshot` with a 30-min TTL, and surface via a
//  single read helper for the CRO daily-note synthesis.

import { THEMES, getThemesForTicker } from "../sector-mapping.js";

const SNAPSHOT_KV_KEY = "timed:cro:rotation-snapshot";
const SNAPSHOT_TTL_SECONDS = 30 * 60;     // 30 min

// Canonical pairs the operator's editorial inspiration tracks. These are
// the ones the CRO check tracks against the upstream view. Operator can
// extend via the KV-backed config (loaded on first compute).
const CONFIG_KV_KEY = "cro:rotation:pairs";
export const DEFAULT_RS_PAIRS = [
  { id: "rsp_spy",   numer: "RSP",  denom: "SPY",  label: "Equal-Weight vs Cap-Weight",  horizon: "intermediate" },
  { id: "igv_smh",   numer: "IGV",  denom: "SMH",  label: "Software vs Semiconductors",  horizon: "intermediate" },
  { id: "xli_spy",   numer: "XLI",  denom: "SPY",  label: "Industrials vs S&P 500",       horizon: "intermediate" },
  { id: "mags_spy",  numer: "MAGS", denom: "SPY",  label: "Magnificent 7 vs S&P 500",     horizon: "tactical" },
  { id: "qqq_iwm",   numer: "QQQ",  denom: "IWM",  label: "Large Tech vs Small Caps",     horizon: "intermediate" },
  { id: "xle_xly",   numer: "XLE",  denom: "XLY",  label: "Energy vs Consumer Disc.",     horizon: "intermediate" },
  { id: "xlf_spy",   numer: "XLF",  denom: "SPY",  label: "Financials vs S&P 500",        horizon: "intermediate" },
  { id: "xlk_spy",   numer: "XLK",  denom: "SPY",  label: "Tech vs S&P 500",              horizon: "intermediate" },
  { id: "xlv_spy",   numer: "XLV",  denom: "SPY",  label: "Healthcare vs S&P 500",        horizon: "intermediate" },
  { id: "xlb_spy",   numer: "XLB",  denom: "SPY",  label: "Materials vs S&P 500",         horizon: "intermediate" },
  { id: "xlre_spy",  numer: "XLRE", denom: "SPY",  label: "Real Estate vs S&P 500",       horizon: "intermediate" },
  { id: "tlt_spy",   numer: "TLT",  denom: "SPY",  label: "Bonds vs Stocks (risk-on/off)",horizon: "tactical" },
];

// ── Utilities ─────────────────────────────────────────────────────────────────
async function loadConfiguredPairs(env) {
  try {
    const raw = await env?.KV?.get(CONFIG_KV_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch (_) {}
  return DEFAULT_RS_PAIRS;
}

// Load daily closes for a given universe over `windowDays`. Returns
// `{ tickerUpper: [{ts, c}, ...sorted asc] }`.
async function loadDailyCloses(env, tickers, windowDays) {
  const db = env?.DB;
  if (!db || !tickers || tickers.length === 0) return {};
  const sinceTsMs = Date.now() - (windowDays + 7) * 86400000;
  const uniqUpper = Array.from(new Set(tickers.map((t) => String(t).toUpperCase()))).filter(Boolean);
  if (uniqUpper.length === 0) return {};

  // Bind list dynamically. D1 supports up to ~100 bind values comfortably.
  // Chunk to be safe.
  const out = {};
  const CHUNK = 80;
  for (let i = 0; i < uniqUpper.length; i += CHUNK) {
    const slice = uniqUpper.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    try {
      const rows = await db.prepare(
        `SELECT ticker, ts, c
           FROM ticker_candles
          WHERE tf = 'D' AND ts >= ? AND ticker IN (${placeholders})`,
      ).bind(sinceTsMs, ...slice).all();
      for (const r of (rows?.results || [])) {
        const ts = Number(r.ts);
        if (!Number.isFinite(ts)) continue;
        const tsMs = ts > 1e12 ? ts : ts * 1000;
        if (tsMs < sinceTsMs) continue;
        const t = String(r.ticker).toUpperCase();
        const c = Number(r.c);
        if (!Number.isFinite(c) || c <= 0) continue;
        (out[t] = out[t] || []).push({ ts: tsMs, c });
      }
    } catch (e) {
      console.warn(`[CRO_ROTATION] candle load chunk failed: ${String(e?.message || e).slice(0, 150)}`);
    }
  }
  for (const t of Object.keys(out)) out[t].sort((a, b) => a.ts - b.ts);
  return out;
}

// ── Compute A: pairwise RS ────────────────────────────────────────────────────
function computeTDSetupState(closes) {
  // TD Buy Setup: 9 consecutive closes < close[i-4]. Returns the highest count
  // achieved in the trailing window (max 9), plus a label.
  const buyCounts = [];
  const sellCounts = [];
  let buyStreak = 0, sellStreak = 0;
  for (let i = 4; i < closes.length; i++) {
    const ref = closes[i - 4];
    if (closes[i] < ref) { buyStreak++; sellStreak = 0; }
    else if (closes[i] > ref) { sellStreak++; buyStreak = 0; }
    else { buyStreak = 0; sellStreak = 0; }
    buyCounts.push(buyStreak);
    sellCounts.push(sellStreak);
  }
  const latestBuy = buyCounts[buyCounts.length - 1] || 0;
  const latestSell = sellCounts[sellCounts.length - 1] || 0;
  let state = "none";
  let count = 0;
  if (latestBuy >= latestSell && latestBuy >= 5) {
    state = latestBuy >= 9 ? "buy_setup_perfect" : "buy_setup_in_progress";
    count = latestBuy;
  } else if (latestSell >= 5) {
    state = latestSell >= 9 ? "sell_setup_perfect" : "sell_setup_in_progress";
    count = latestSell;
  }
  return { state, count };
}

function computeRsPair(pair, daily) {
  const num = daily[pair.numer.toUpperCase()];
  const den = daily[pair.denom.toUpperCase()];
  if (!num || !den || num.length < 25 || den.length < 25) {
    return { ...pair, ok: false, error_kind: "insufficient_data", numer_bars: num?.length || 0, denom_bars: den?.length || 0 };
  }
  // Align on date via ts; we take the intersection.
  const denByDate = new Map();
  for (const d of den) denByDate.set(d.ts, d.c);
  const aligned = [];
  for (const n of num) {
    const d = denByDate.get(n.ts);
    if (d) aligned.push({ ts: n.ts, ratio: n.c / d });
  }
  if (aligned.length < 25) {
    return { ...pair, ok: false, error_kind: "insufficient_aligned_bars", aligned_bars: aligned.length };
  }
  const ratios = aligned.map((a) => a.ratio);
  const N = ratios.length;
  const ratioNow = ratios[N - 1];
  const ratioPrev20 = ratios[Math.max(0, N - 21)];
  const ratioPrev60 = ratios[Math.max(0, N - 61)];
  const roc20 = (ratioNow - ratioPrev20) / ratioPrev20;
  const roc60 = (ratioNow - ratioPrev60) / ratioPrev60;
  // Trend state derived from 20d ROC + recent slope. Simple: trend up if
  // ratio_now > all of last 5 ratios and roc20 > 0.005; trend down mirror.
  const last5 = ratios.slice(-5);
  const max5 = Math.max(...last5);
  const min5 = Math.min(...last5);
  let trendState = "choppy";
  if (ratioNow >= max5 && roc20 > 0.005) trendState = "breaking_up";
  else if (ratioNow <= min5 && roc20 < -0.005) trendState = "breaking_down";
  else if (roc20 > 0.01) trendState = "stable_up";
  else if (roc20 < -0.01) trendState = "stable_down";

  const td = computeTDSetupState(ratios);

  return {
    ...pair,
    ok: true,
    bars: N,
    ratio_now: Number(ratioNow.toFixed(6)),
    ratio_20d_ago: Number(ratioPrev20.toFixed(6)),
    ratio_60d_ago: Number(ratioPrev60.toFixed(6)),
    roc_20d_pct: Number((roc20 * 100).toFixed(2)),
    roc_60d_pct: Number((roc60 * 100).toFixed(2)),
    trend_state: trendState,
    td_setup_state: td.state,
    td_setup_count: td.count,
  };
}

// ── Compute B: theme breadth ──────────────────────────────────────────────────
function computeThemeBreadthForTheme(themeName, themeMembers, daily) {
  const memberSnaps = themeMembers.map((m) => {
    const arr = daily[String(m).toUpperCase()];
    if (!arr || arr.length < 22) return null;
    const N = arr.length;
    const cNow = arr[N - 1].c;
    const c1 = arr[N - 2].c;
    const c5 = arr[Math.max(0, N - 6)].c;
    const c20 = arr[Math.max(0, N - 21)].c;
    return {
      ticker: String(m).toUpperCase(),
      ret_today: (cNow - c1) / c1,
      ret_5d:    (cNow - c5) / c5,
      ret_20d:   (cNow - c20) / c20,
    };
  }).filter(Boolean);
  if (memberSnaps.length === 0) return null;

  const N = memberSnaps.length;
  const upToday  = memberSnaps.filter((m) => m.ret_today > 0.01).length;
  const dnToday  = memberSnaps.filter((m) => m.ret_today < -0.01).length;
  const up5d     = memberSnaps.filter((m) => m.ret_5d > 0.05).length;
  const dn5d     = memberSnaps.filter((m) => m.ret_5d < -0.05).length;
  const up20d    = memberSnaps.filter((m) => m.ret_20d > 0.10).length;
  const dn20d    = memberSnaps.filter((m) => m.ret_20d < -0.10).length;

  const pct = (x) => Math.round((x / N) * 100);
  return {
    theme: themeName,
    members_count: N,
    breadth_today_up_gt_1pct:   pct(upToday),
    breadth_today_dn_gt_1pct:   pct(dnToday),
    breadth_5d_up_gt_5pct:      pct(up5d),
    breadth_5d_dn_gt_5pct:      pct(dn5d),
    breadth_20d_up_gt_10pct:    pct(up20d),
    breadth_20d_dn_gt_10pct:    pct(dn20d),
    all_bid_today:    pct(upToday) >= 70,
    all_offered_today: pct(dnToday) >= 70,
    all_bid_20d:      pct(up20d) >= 70,
    all_offered_20d:  pct(dn20d) >= 70,
    median_5d_pct:    Number((medianPct(memberSnaps.map((m) => m.ret_5d * 100))).toFixed(2)),
    median_20d_pct:   Number((medianPct(memberSnaps.map((m) => m.ret_20d * 100))).toFixed(2)),
    movers_top_5d:    memberSnaps.slice().sort((a, b) => b.ret_5d - a.ret_5d).slice(0, 3).map((m) => ({ ticker: m.ticker, ret_5d_pct: Number((m.ret_5d * 100).toFixed(2)) })),
    movers_bot_5d:    memberSnaps.slice().sort((a, b) => a.ret_5d - b.ret_5d).slice(0, 3).map((m) => ({ ticker: m.ticker, ret_5d_pct: Number((m.ret_5d * 100).toFixed(2)) })),
  };
}

function medianPct(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ── Compute C: intra-theme correlation ────────────────────────────────────────
function computeCorrelationForTheme(themeName, themeMembers, daily, windowDays = 20) {
  // Build daily-return series for each member; intersect dates.
  const members = themeMembers.map((m) => String(m).toUpperCase());
  const series = {};
  for (const m of members) {
    const arr = daily[m];
    if (!arr || arr.length < windowDays + 2) continue;
    const slice = arr.slice(-windowDays - 1);
    const rets = [];
    for (let i = 1; i < slice.length; i++) {
      rets.push({ ts: slice[i].ts, r: (slice[i].c - slice[i - 1].c) / slice[i - 1].c });
    }
    series[m] = rets;
  }
  const keys = Object.keys(series);
  if (keys.length < 2) return null;
  // Align by ts intersection.
  const tsSets = keys.map((k) => new Set(series[k].map((p) => p.ts)));
  const common = Array.from(tsSets[0]).filter((t) => tsSets.every((s) => s.has(t))).sort((a, b) => a - b);
  if (common.length < Math.max(10, windowDays - 3)) return null;
  // Compute pairwise Pearson correlation and average.
  function alignedSeries(k) {
    const map = new Map(series[k].map((p) => [p.ts, p.r]));
    return common.map((t) => map.get(t));
  }
  const aligned = {};
  for (const k of keys) aligned[k] = alignedSeries(k);
  let sum = 0, count = 0;
  const pairCorrs = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const c = pearson(aligned[keys[i]], aligned[keys[j]]);
      if (Number.isFinite(c)) {
        sum += c;
        count++;
        pairCorrs.push(c);
      }
    }
  }
  const avg = count > 0 ? sum / count : 0;
  const sorted = pairCorrs.slice().sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
  return {
    theme: themeName,
    members_with_data: keys.length,
    pairs_evaluated: count,
    avg_correlation: Number(avg.toFixed(3)),
    median_correlation: Number(median.toFixed(3)),
    high_correlation_cluster: avg >= 0.70,     // "all moving together"
    decoupling: avg <= 0.20,                   // members trading independently
    window_days: windowDays,
  };
}

function pearson(x, y) {
  if (!x || !y || x.length !== y.length || x.length < 3) return NaN;
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i], yi = y[i];
    sx += xi; sy += yi;
    sxx += xi * xi; syy += yi * yi;
    sxy += xi * yi;
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt(Math.max(0, (n * sxx - sx * sx) * (n * syy - sy * sy)));
  return den > 0 ? num / den : NaN;
}

// ── Sector breadth (sector-level wrapper around theme breadth) ────────────────
// Aggregates per-theme breadth into per-sector breadth using the existing
// THEMES → sector mapping.
function aggregateSectorBreadth(themeBreadthArray) {
  // Best-effort sector tagging based on theme key prefixes / names.
  const sectorByTheme = {
    ai_infra_compute:   "Information Technology",
    ai_infra_memory:    "Information Technology",
    ai_infra_semicap:   "Information Technology",
    ai_software:        "Information Technology",
    ai_consumer:        "Communication Services",
    ai_infra_dc_reit:   "Real Estate",
    ai_infra_cooling:   "Industrials",
    ai_infra_energy:    "Utilities",
    banks_money_center: "Financials",
    banks_regional:     "Financials",
    fintech:            "Financials",
    oil_gas:            "Energy",
    oil_services:       "Energy",
    refiners:           "Energy",
    uranium_nuclear:    "Energy",
    uranium_etf:        "Energy",
    metals_miners:      "Materials",
    crypto_proxies:     "Financials",
    crypto_etf:         "Financials",
    crypto_miners:      "Financials",
    defense:            "Industrials",
    space_tech:         "Industrials",
    cybersecurity:      "Information Technology",
    weight_loss:        "Healthcare",
    travel_leisure:     "Consumer Discretionary",
    ev_battery:         "Consumer Discretionary",
    ecom_logistics:     "Consumer Discretionary",
  };
  const bySector = {};
  for (const tb of (themeBreadthArray || [])) {
    const sec = sectorByTheme[tb.theme] || "Other";
    if (!bySector[sec]) bySector[sec] = { sector: sec, themes: [], median_5d_pct_avg: 0, median_20d_pct_avg: 0, themes_all_bid_today: 0 };
    bySector[sec].themes.push(tb.theme);
    bySector[sec].median_5d_pct_avg += tb.median_5d_pct || 0;
    bySector[sec].median_20d_pct_avg += tb.median_20d_pct || 0;
    if (tb.all_bid_today) bySector[sec].themes_all_bid_today++;
  }
  return Object.values(bySector).map((s) => ({
    sector: s.sector,
    themes_count: s.themes.length,
    themes: s.themes,
    median_5d_pct_avg: s.themes.length > 0 ? Number((s.median_5d_pct_avg / s.themes.length).toFixed(2)) : 0,
    median_20d_pct_avg: s.themes.length > 0 ? Number((s.median_20d_pct_avg / s.themes.length).toFixed(2)) : 0,
    themes_all_bid_today: s.themes_all_bid_today,
  }));
}

// ── Public: run the whole rotation snapshot ───────────────────────────────────
export async function runRotationSnapshot(env, { force = false, windowDays = 80 } = {}) {
  if (!force) {
    try {
      const cached = await env?.KV?.get(SNAPSHOT_KV_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && (Date.now() - (parsed.computed_at || 0)) < SNAPSHOT_TTL_SECONDS * 1000) {
          return { ...parsed, from_cache: true };
        }
      }
    } catch (_) {}
  }

  const t0 = Date.now();
  const pairs = await loadConfiguredPairs(env);

  // Build the universe: all RS-pair tickers + all theme members.
  const universe = new Set();
  for (const p of pairs) {
    universe.add(String(p.numer).toUpperCase());
    universe.add(String(p.denom).toUpperCase());
  }
  for (const [, members] of Object.entries(THEMES || {})) {
    for (const m of (members || [])) universe.add(String(m).toUpperCase());
  }

  const tickers = Array.from(universe);
  const daily = await loadDailyCloses(env, tickers, windowDays);

  // A) RS pairs.
  const rs_pairs = pairs.map((p) => computeRsPair(p, daily));

  // B) Theme breadth.
  const theme_breadth = [];
  for (const [themeName, members] of Object.entries(THEMES || {})) {
    if (!members || members.length === 0) continue;
    const tb = computeThemeBreadthForTheme(themeName, members, daily);
    if (tb) theme_breadth.push(tb);
  }

  // C) Theme correlation (intra-theme).
  const theme_correlation = [];
  for (const [themeName, members] of Object.entries(THEMES || {})) {
    if (!members || members.length < 3) continue;
    const tc = computeCorrelationForTheme(themeName, members, daily, 20);
    if (tc) theme_correlation.push(tc);
  }

  const sector_breadth = aggregateSectorBreadth(theme_breadth);

  // Headlines for the LLM summarizer to lean on.
  const headlines = [];
  // Rotation pairs breaking direction:
  for (const r of rs_pairs) {
    if (!r.ok) continue;
    if (r.trend_state === "breaking_up") headlines.push(`${r.numer}/${r.denom} breaking up (+${r.roc_20d_pct.toFixed(1)}% 20d)`);
    else if (r.trend_state === "breaking_down") headlines.push(`${r.numer}/${r.denom} breaking down (${r.roc_20d_pct.toFixed(1)}% 20d)`);
    if (r.td_setup_state === "buy_setup_perfect") headlines.push(`${r.numer}/${r.denom} TD Buy Setup perfected`);
    if (r.td_setup_state === "sell_setup_perfect") headlines.push(`${r.numer}/${r.denom} TD Sell Setup perfected`);
  }
  // Themes "all bid" / "all offered":
  for (const tb of theme_breadth) {
    if (tb.all_bid_today) headlines.push(`${tb.theme}: all bid today (${tb.breadth_today_up_gt_1pct}% members up >1%)`);
    if (tb.all_offered_today) headlines.push(`${tb.theme}: all offered today (${tb.breadth_today_dn_gt_1pct}% members down >1%)`);
  }
  // Decoupling clusters (often the early signal of leadership rotation):
  for (const tc of theme_correlation) {
    if (tc.decoupling) headlines.push(`${tc.theme}: decoupling (avg corr ${tc.avg_correlation.toFixed(2)} over ${tc.window_days}d) — possible regime change`);
    else if (tc.high_correlation_cluster) headlines.push(`${tc.theme}: tight cluster (avg corr ${tc.avg_correlation.toFixed(2)})`);
  }

  const snapshot = {
    ok: true,
    computed_at: Date.now(),
    elapsed_ms: Date.now() - t0,
    window_days: windowDays,
    universe_size: tickers.length,
    with_data: Object.keys(daily).length,
    rs_pairs,
    theme_breadth,
    theme_correlation,
    sector_breadth,
    headlines,
  };

  try {
    await env?.KV?.put(SNAPSHOT_KV_KEY, JSON.stringify(snapshot), { expirationTtl: SNAPSHOT_TTL_SECONDS * 2 });
  } catch (_) {}

  return snapshot;
}

export async function loadRotationSnapshot(env) {
  try {
    const raw = await env?.KV?.get(SNAPSHOT_KV_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

export async function setRotationPairs(env, pairs) {
  if (!env?.KV) return { ok: false };
  await env.KV.put(CONFIG_KV_KEY, JSON.stringify(pairs));
  return { ok: true };
}
