// worker/lib/regime-hmm-features.js
//
// Build daily emission vectors for the Hidden Markov Model.
//
// Each row is a single trading day. Features were chosen for two
// reasons: (a) they're cheap to compute from data we already have in
// D1 (ticker_candles + trail_5m_facts), and (b) they collectively
// pick up the latent-regime drivers the article calls out — credit /
// monetary / risk-appetite proxies that lead price.
//
// Feature order (D = 5):
//   0  spy_ret_1d              SPY 1-day log return
//   1  spy_atr_pct_5d          5-day ATR / price (volatility)
//   2  vix_level_norm          VIX level / 30 (clipped 0–2)
//   3  breadth_pct             % of universe in HTF_BULL_LTF_BULL
//                              at end of day
//   4  sector_dispersion       std of sector daily returns (proxy
//                              for rotation entropy)
//
// All features are scaled so the typical range is small (~0–2),
// keeping the multivariate Gaussian covariances numerically friendly.

export const HMM_FEATURE_NAMES = Object.freeze([
  "spy_ret_1d", "spy_atr_pct_5d", "vix_level_norm", "breadth_pct", "sector_dispersion",
]);
export const HMM_D = HMM_FEATURE_NAMES.length;

// ─────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────

async function _getDailyCandles(env, ticker, limit = 400) {
  const db = env?.DB;
  if (!db) return [];
  try {
    const r = await db.prepare(
      `SELECT ts, o, h, l, c FROM ticker_candles WHERE ticker = ?1 AND tf = 'D' ORDER BY ts DESC LIMIT ?2`
    ).bind(ticker, limit).all();
    const rows = (r?.results || []).slice().reverse(); // chronological
    return rows.map(x => ({ ts: Number(x.ts), o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c) }));
  } catch (e) {
    console.warn(`[HMM FEATURES] candle read failed for ${ticker}:`, String(e?.message || e).slice(0, 150));
    return [];
  }
}

function _atrPct(candles, period = 5) {
  // Wilder-style ATR over `period`, returned as ATR / last close.
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Use the most-recent `period` TRs
  const recent = tr.slice(-period);
  const sum = recent.reduce((a, b) => a + b, 0);
  const atr = sum / recent.length;
  const last = candles[candles.length - 1].c;
  return last > 0 ? atr / last : null;
}

// Per-day universe breadth — % of tickers whose end-of-day state is
// HTF_BULL_LTF_BULL. We pull it from trail_5m_facts.state at the
// LAST 5-min bucket of each US trading day (~21:00 UTC during EDT,
// ~22:00 during EST). Approximate by selecting the latest bucket
// before bucket_ts < (next-day midnight).
async function _getBreadthSeries(env, sinceDays) {
  const db = env?.DB;
  if (!db) return [];
  const now = Date.now();
  const cutoff = now - sinceDays * 24 * 60 * 60 * 1000;
  try {
    // Group by trading day (UTC ymd) and count rows where state ends in BULL_BULL.
    const r = await db.prepare(
      `SELECT
         CAST(bucket_ts / 86400000 AS INTEGER) AS day_idx,
         COUNT(*) AS total,
         SUM(CASE WHEN state = 'HTF_BULL_LTF_BULL' THEN 1 ELSE 0 END) AS bull_bull
       FROM trail_5m_facts
       WHERE bucket_ts >= ?1
       GROUP BY day_idx
       ORDER BY day_idx ASC`
    ).bind(cutoff).all();
    return (r?.results || []).map(row => ({
      day_idx: Number(row.day_idx),
      breadth: Number(row.total) > 0 ? Number(row.bull_bull) / Number(row.total) : 0,
    }));
  } catch (e) {
    console.warn("[HMM FEATURES] breadth read failed:", String(e?.message || e).slice(0, 150));
    return [];
  }
}

// Sector dispersion proxy: std of daily returns across a small set of
// sector ETFs. Wider dispersion = more rotation, narrower = uniform
// risk-on/off behavior across sectors.
async function _getSectorReturnsByDay(env, sinceDays) {
  const SECTOR_ETFS = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE", "XLC"];
  const limit = Math.ceil(sinceDays * 1.2);
  const out = {}; // day_idx -> array of returns
  for (const sym of SECTOR_ETFS) {
    const candles = await _getDailyCandles(env, sym, limit);
    for (let i = 1; i < candles.length; i++) {
      const ret = Math.log(candles[i].c / candles[i - 1].c);
      if (!Number.isFinite(ret)) continue;
      const dayIdx = Math.floor(candles[i].ts / (24 * 60 * 60 * 1000));
      (out[dayIdx] || (out[dayIdx] = [])).push(ret);
    }
  }
  return out;
}

function _std(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  let s = 0;
  for (const v of arr) s += (v - m) ** 2;
  return Math.sqrt(s / arr.length);
}

// ─────────────────────────────────────────────────────────────────────
// Public — build emission vector series
// ─────────────────────────────────────────────────────────────────────

/**
 * buildEmissionSeries
 *
 * Returns an array of { day_idx, ts, features } where features is a
 * length-HMM_D vector. Aligned by trading day. Days missing one of
 * the inputs are dropped (we never emit a partial vector).
 *
 * @param {object} env worker env (DB + KV bindings)
 * @param {object} [opts]
 * @param {number} [opts.windowDays=365] history length
 *
 * @returns {Promise<{ rows, dropped, sources }>}
 */
export async function buildEmissionSeries(env, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? Math.max(60, Math.floor(opts.windowDays)) : 365;

  // 1. SPY daily candles for returns + ATR%
  const spyCandles = await _getDailyCandles(env, "SPY", Math.ceil(windowDays * 1.2));
  // 2. VIXY daily candles — directional vol feature only (not VIX level;
  //    live VIX level resolves via worker/vix-source.js: VX1! → Yahoo ^VIX).
  const vixyCandles = await _getDailyCandles(env, "VIXY", Math.ceil(windowDays * 1.2));
  // 3. Universe breadth per day
  const breadthSeries = await _getBreadthSeries(env, windowDays);
  // 4. Sector returns -> dispersion per day
  const sectorReturnsByDay = await _getSectorReturnsByDay(env, windowDays);

  // Build maps keyed by day_idx
  const spyByDay = new Map();
  for (let i = 1; i < spyCandles.length; i++) {
    const ret = Math.log(spyCandles[i].c / spyCandles[i - 1].c);
    if (!Number.isFinite(ret)) continue;
    // Rolling ATR % over the previous 5 bars
    const window = spyCandles.slice(Math.max(0, i - 5), i + 1);
    const atrPct = _atrPct(window, 5);
    const dayIdx = Math.floor(spyCandles[i].ts / (24 * 60 * 60 * 1000));
    spyByDay.set(dayIdx, { ts: spyCandles[i].ts, ret, atrPct: atrPct != null ? atrPct : null });
  }
  const vixyByDay = new Map();
  for (const c of vixyCandles) {
    const dayIdx = Math.floor(c.ts / (24 * 60 * 60 * 1000));
    // VIXY is a leveraged ETF — closing price ≈ VIX/30 doesn't hold
    // perfectly but scales the right direction. For HMM features we
    // care about relative changes more than absolute level. Normalize
    // by dividing by a rolling 200-day average (proxy for "current
    // baseline volatility") later. For now, use close directly.
    vixyByDay.set(dayIdx, c.c);
  }
  const breadthByDay = new Map();
  for (const b of breadthSeries) breadthByDay.set(b.day_idx, b.breadth);

  // Compute rolling vixy baseline so the feature has roughly unit range
  const vixyCloses = vixyCandles.map(c => c.c);
  const vixyAvg = vixyCloses.length > 0 ? vixyCloses.reduce((a, b) => a + b, 0) / vixyCloses.length : 1;
  const vixyBaseline = vixyAvg > 0 ? vixyAvg : 1;

  // Assemble rows
  const rows = [];
  let dropped = 0;
  const sortedDays = [...spyByDay.keys()].sort((a, b) => a - b);
  for (const dayIdx of sortedDays) {
    const spy = spyByDay.get(dayIdx);
    const vixyClose = vixyByDay.get(dayIdx);
    const breadth = breadthByDay.get(dayIdx);
    const sectorRets = sectorReturnsByDay[dayIdx] || [];
    if (spy.atrPct == null || vixyClose == null || breadth == null || sectorRets.length < 3) {
      dropped++;
      continue;
    }
    const features = [
      spy.ret,                                                    // spy_ret_1d
      spy.atrPct,                                                 // spy_atr_pct_5d
      Math.min(2, Math.max(0, vixyClose / vixyBaseline)),         // vix_level_norm
      breadth,                                                    // breadth_pct
      _std(sectorRets),                                           // sector_dispersion
    ];
    if (features.some(f => !Number.isFinite(f))) { dropped++; continue; }
    rows.push({ day_idx: dayIdx, ts: spy.ts, features });
  }

  return {
    rows,
    dropped,
    sources: {
      spy_candles: spyCandles.length,
      vixy_candles: vixyCandles.length,
      breadth_days: breadthSeries.length,
      sector_days: Object.keys(sectorReturnsByDay).length,
    },
    feature_names: HMM_FEATURE_NAMES.slice(),
    window_days: windowDays,
  };
}
