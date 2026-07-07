// worker/harmonic-cycle.js
// ─────────────────────────────────────────────────────────────────────────────
// Harmonic cycle decomposition on daily closes — desk-style quarter/year
// cyclical read (dominant periods like 180d / 315d + harmonic ladder).
// Pure functions; candle loading stays in the caller via opts/getCandles.
// ─────────────────────────────────────────────────────────────────────────────

/** Harmonic ladder (trading days) aligned with the desk NVDA cycle chart. */
export const DEFAULT_HARMONIC_PERIODS = [20, 24, 30, 37, 43, 48, 60, 68, 80, 92, 119, 180, 315];

/** Primary cyclical windows the desk tracks for peak/trough calls. */
export const PRIMARY_CYCLE_PERIODS = [180, 315];

/** Minimum daily bars for a stable fit (covers ~1y + 180d window). */
export const HARMONIC_MIN_BARS = 240;

/** Detrend log closes with a linear regression (removes drift before spectral fit). */
export function detrendLogSeries(closes) {
  const vals = (closes || []).map(Number).filter((c) => Number.isFinite(c) && c > 0);
  if (vals.length < 20) return null;
  const log = vals.map((c) => Math.log(c));
  const n = log.length;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += log[i]; sxx += i * i; sxy += i * log[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  return log.map((y, i) => y - (intercept + slope * i));
}

/** Least-squares sin/cos fit at a fixed period (trading days). */
export function fitSinusoidAtPeriod(series, period) {
  const n = series?.length || 0;
  const p = Number(period);
  if (!Number.isFinite(p) || p < 8 || n < p * 2) return null;
  let ySin = 0; let yCos = 0; let ss = 0; let cc = 0;
  for (let i = 0; i < n; i++) {
    const y = series[i];
    if (!Number.isFinite(y)) continue;
    const ang = (2 * Math.PI * i) / p;
    const s = Math.sin(ang);
    const c = Math.cos(ang);
    ySin += y * s;
    yCos += y * c;
    ss += s * s;
    cc += c * c;
  }
  const denom = Math.sqrt(ss * cc) || 1;
  const aSin = ySin / denom;
  const aCos = yCos / denom;
  const amplitude = Math.sqrt(aSin * aSin + aCos * aCos) / n;
  const phase = Math.atan2(aCos, aSin);
  const power = amplitude * amplitude;
  return { period: p, amplitude, phase, power };
}

/** Rank candidate periods by fitted power. */
export function rankHarmonicPeriods(series, candidates = DEFAULT_HARMONIC_PERIODS, topN = 5) {
  const fits = (candidates || [])
    .map((p) => fitSinusoidAtPeriod(series, p))
    .filter(Boolean)
    .sort((a, b) => b.power - a.power);
  return fits.slice(0, Math.max(1, topN || 5));
}

/** Weighted composite wave value at bar index. */
export function compositeAtBar(harmonics, barIdx) {
  let v = 0;
  let wSum = 0;
  for (const h of harmonics || []) {
    const w = h.power || h.amplitude || 1;
    v += w * Math.sin((2 * Math.PI * barIdx) / h.period + h.phase);
    wSum += w;
  }
  return wSum ? v / wSum : 0;
}

/** Map radians to 0..1 cycle position (0.5 ≈ peak, 0 ≈ trough). */
export function harmonicPhasePct(phaseRad) {
  let p = (phaseRad / (2 * Math.PI) + 0.25) % 1;
  if (p < 0) p += 1;
  return p;
}

/** Phase at the last bar for a fitted harmonic. */
export function phaseAtBar(harmonic, barIdx) {
  return harmonic.phase + (2 * Math.PI * barIdx) / harmonic.period;
}

/** Human label for cyclical inflection (quarter/year style). */
export function labelHarmonicInflection(phasePct, direction) {
  const p = phasePct;
  const rising = direction > 0;
  if (p >= 0.72 && !rising) return "past peak / down-cycle";
  if (p >= 0.55 && p < 0.72) return "late cycle / approaching peak";
  if (p >= 0.45 && p <= 0.55 && rising) return "mid cycle / rising";
  if (p >= 0.45 && p <= 0.55 && !rising) return "mid cycle / rolling";
  if (p < 0.28) return "early cycle / trough zone";
  if (p < 0.45 && rising) return "recovery / rising";
  return "transitional";
}

/**
 * Decompose daily closes into dominant harmonics + composite phase.
 * @param {number[]} closes oldest-first
 */
export function analyzeHarmonicCycle(closes, opts = {}) {
  const minBars = opts.minBars || HARMONIC_MIN_BARS;
  const arr = (closes || []).map(Number).filter((c) => Number.isFinite(c) && c > 0);
  if (arr.length < minBars) {
    return { ok: false, reason: "insufficient_bars", bars: arr.length, min_bars: minBars };
  }

  const detrended = detrendLogSeries(arr);
  if (!detrended) return { ok: false, reason: "detrend_failed", bars: arr.length };

  const ranked = rankHarmonicPeriods(
    detrended,
    opts.periods || DEFAULT_HARMONIC_PERIODS,
    opts.topN || 5,
  );
  if (!ranked.length) return { ok: false, reason: "no_fit", bars: arr.length };

  const last = detrended.length - 1;
  const cur = compositeAtBar(ranked, last);
  const prev = compositeAtBar(ranked, Math.max(0, last - 5));
  const direction = cur >= prev ? 1 : -1;

  const primary = ranked.find((h) => PRIMARY_CYCLE_PERIODS.includes(h.period)) || ranked[0];
  const phasePct = harmonicPhasePct(phaseAtBar(primary, last));

  return {
    ok: true,
    bars: arr.length,
    dominant_periods: ranked.map((h) => h.period),
    harmonics: ranked.map((h) => ({
      period: h.period,
      amplitude: Math.round(h.amplitude * 1e6) / 1e6,
      power: Math.round(h.power * 1e8) / 1e8,
    })),
    primary_period: primary.period,
    phase_pct: Math.round(phasePct * 1000) / 1000,
    composite_value: Math.round(cur * 1000) / 1000,
    direction: direction > 0 ? "rising" : "falling",
    label: labelHarmonicInflection(phasePct, direction),
    source: "harmonic-cycle.v1",
  };
}

/** Load D candles via injected getter and run harmonic decomposition. */
export async function analyzeHarmonicCycleForTicker(env, ticker, getCandles, opts = {}) {
  const get = typeof getCandles === "function" ? getCandles : null;
  if (!get) return { ok: false, reason: "no_get_candles" };
  const sym = String(ticker || "").toUpperCase();
  if (!sym) return { ok: false, reason: "bad_ticker" };
  const limit = opts.limit || 420;
  try {
    const res = await get(env, sym, "D", limit);
    const candles = Array.isArray(res?.candles) ? res.candles : [];
    const closes = candles.map((c) => Number(c?.c)).filter(Number.isFinite);
    return analyzeHarmonicCycle(closes, opts);
  } catch (_) {
    return { ok: false, reason: "candle_read_failed", ticker: sym };
  }
}
