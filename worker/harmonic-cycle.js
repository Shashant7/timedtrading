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

/** Map composite wave values onto the price range for overlay charting. */
export function scaleWaveToPriceRange(waveVals, priceVals) {
  const prices = (priceVals || []).filter(Number.isFinite);
  const waves = (waveVals || []).filter(Number.isFinite);
  if (!prices.length || !waves.length) return (waveVals || []).map(() => null);
  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const wMin = Math.min(...waves);
  const wMax = Math.max(...waves);
  const pSpan = pMax - pMin;
  const wSpan = wMax - wMin;
  if (!Number.isFinite(pSpan) || pSpan <= 0 || !Number.isFinite(wSpan) || wSpan <= 0) {
    const mid = (pMin + pMax) / 2;
    return waves.map(() => mid);
  }
  return waves.map((w) => pMin + ((w - wMin) / wSpan) * pSpan);
}

/** Advance a YYYY-MM-DD string by N calendar days (chart projection labels). */
export function addCalendarDays(dateStr, days) {
  const m = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return dateStr;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dt.toISOString().slice(0, 10);
}

/**
 * Build chart-ready price + scaled composite wave series.
 * @param {number[]} closes oldest-first
 * @param {string[]} dates optional YYYY-MM-DD aligned to closes
 * @param {object[]} ranked fitted harmonics (must include phase)
 */
export function buildHarmonicWaveSeries(closes, dates, ranked, opts = {}) {
  const arr = (closes || []).map(Number).filter((c) => Number.isFinite(c) && c > 0);
  if (!arr.length || !ranked?.length) return null;

  const historyBars = Math.max(60, Math.min(arr.length, opts.historyBars || 180));
  const projectBars = Math.max(0, Math.min(120, opts.projectBars || 75));
  const start = Math.max(0, arr.length - historyBars);
  const slice = arr.slice(start);
  const dateSlice = Array.isArray(dates) && dates.length === arr.length
    ? dates.slice(start)
    : slice.map((_, i) => `bar-${start + i}`);

  const waveRaw = slice.map((_, i) => compositeAtBar(ranked, start + i));
  const waveScaled = scaleWaveToPriceRange(waveRaw, slice);

  const history = slice.map((price, i) => ({
    d: dateSlice[i],
    p: Math.round(price * 100) / 100,
    w: Math.round(waveScaled[i] * 100) / 100,
  }));

  const lastDate = dateSlice[dateSlice.length - 1];
  const lastIdx = arr.length - 1;
  const lastWaveScaled = waveScaled[waveScaled.length - 1];
  const lastPrice = slice[slice.length - 1];
  const pMin = Math.min(...slice);
  const pMax = Math.max(...slice);
  const wMin = Math.min(...waveRaw);
  const wMax = Math.max(...waveRaw);
  const pSpan = pMax - pMin;
  const wSpan = wMax - wMin;
  const scaleOne = (w) => {
    if (!Number.isFinite(wSpan) || wSpan <= 0 || !Number.isFinite(pSpan) || pSpan <= 0) {
      return (pMin + pMax) / 2;
    }
    return pMin + ((w - wMin) / wSpan) * pSpan;
  };

  const projection = [];
  for (let j = 1; j <= projectBars; j++) {
    const barIdx = lastIdx + j;
    const wRaw = compositeAtBar(ranked, barIdx);
    projection.push({
      d: typeof lastDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(lastDate)
        ? addCalendarDays(lastDate, j)
        : `bar-${barIdx}`,
      w: Math.round(scaleOne(wRaw) * 100) / 100,
    });
  }

  return {
    history_bars: history.length,
    project_bars: projection.length,
    pivot_index: history.length - 1,
    pivot_date: lastDate,
    pivot_price: Math.round(lastPrice * 100) / 100,
    pivot_wave: Math.round(lastWaveScaled * 100) / 100,
    history,
    projection,
  };
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

  const out = {
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
    source: "harmonic-cycle.v2",
  };

  if (opts.includeSeries) {
    const waveSeries = buildHarmonicWaveSeries(arr, opts.dates, ranked, {
      historyBars: opts.historyBars || 180,
      projectBars: opts.projectBars || 75,
    });
    if (waveSeries) out.wave_series = waveSeries;
  }

  return out;
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
    const closes = [];
    const dates = [];
    for (const c of candles) {
      const close = Number(c?.c);
      if (!Number.isFinite(close) || close <= 0) continue;
      closes.push(close);
      const t = c?.t ?? c?.time ?? c?.date;
      if (typeof t === "string" && /^\d{4}-\d{2}-\d{2}/.test(t)) dates.push(t.slice(0, 10));
      else if (Number.isFinite(Number(t))) {
        const ms = Number(t) < 1e12 ? Number(t) * 1000 : Number(t);
        dates.push(new Date(ms).toISOString().slice(0, 10));
      } else dates.push(null);
    }
    return analyzeHarmonicCycle(closes, {
      ...opts,
      dates: dates.length === closes.length ? dates : null,
      includeSeries: opts.includeSeries === true,
    });
  } catch (_) {
    return { ok: false, reason: "candle_read_failed", ticker: sym };
  }
}

/** On-demand harmonic cycle payload for chart overlay (price + composite wave). */
export async function getHarmonicCycleChart(env, ticker, getCandles, opts = {}) {
  const sym = String(ticker || "").toUpperCase();
  const result = await analyzeHarmonicCycleForTicker(env, sym, getCandles, {
    minBars: opts.minBars || HARMONIC_MIN_BARS,
    topN: opts.topN || 5,
    limit: opts.limit || 420,
    historyBars: opts.historyBars || 180,
    projectBars: opts.projectBars || 75,
    includeSeries: true,
  });
  if (!result?.ok) return { ok: false, ticker: sym, ...result };
  return { ok: true, ticker: sym, ...result };
}
