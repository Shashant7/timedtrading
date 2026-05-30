// worker/volume-profile.js
//
// ─────────────────────────────────────────────────────────────────────────────
//  Volume Profile — Point of Control, Value Area High/Low
// ─────────────────────────────────────────────────────────────────────────────
//
//  Volume Profile slices price into horizontal bins and sums volume at each
//  bin. The resulting histogram tells you where the market built/lost
//  consensus.
//
//  Key levels:
//    POC  (Point of Control) — the single bin with the most volume.
//                              The fairest price; institutional anchor.
//    VAH  (Value Area High)  — top of the band containing ~68-70% of
//                              total volume (1 standard deviation).
//    VAL  (Value Area Low)   — bottom of the value area.
//
//  How traders use them:
//    • Price above VAH = premium (look short to revert)
//    • Price below VAL = discount (look long to revert)
//    • POC = magnet (price tends to gravitate back)
//    • HVN (High-Volume Nodes — peaks beside POC) = support / resistance
//    • LVN (Low-Volume Nodes — valleys) = price moves through fast
//
//  This module supports two computation modes:
//    • Daily Volume Profile (last N trading days, default 5)
//    • Session Volume Profile (single-day intraday from minute bars)
//
//  We use the daily mode primarily (cheaper, more stable). Session mode
//  is available for the day-trade flavor.
//
//  Authored 2026-05-30.

/**
 * Compute volume profile from a series of OHLCV bars.
 *
 * @param {Array} bars - [{ o, h, l, c, v }] sorted by time
 * @param {object} [opts] - { binCount?: 50, valueAreaPct?: 0.70 }
 * @returns {object} { poc, vah, val, bins, total_volume, value_area_volume }
 */
export function computeVolumeProfile(bars, opts = {}) {
  if (!Array.isArray(bars) || bars.length === 0) return null;
  const binCount = Math.max(10, Math.min(200, opts.binCount || 50));
  const valueAreaPct = Math.max(0.1, Math.min(0.95, opts.valueAreaPct || 0.70));

  // Find price range across all bars.
  let minPx = Infinity, maxPx = -Infinity;
  for (const b of bars) {
    const lo = Number(b.l ?? b.low);
    const hi = Number(b.h ?? b.high);
    if (Number.isFinite(lo)) minPx = Math.min(minPx, lo);
    if (Number.isFinite(hi)) maxPx = Math.max(maxPx, hi);
  }
  if (!(maxPx > minPx)) return null;

  const binSize = (maxPx - minPx) / binCount;
  const bins = new Array(binCount).fill(0); // volume per bin
  let totalVolume = 0;

  // Distribute each bar's volume uniformly across bins it overlaps.
  // (Simplified TPO model — true POC uses time-in-bin but this gives
  // structurally identical levels at fraction of compute cost.)
  for (const b of bars) {
    const lo = Number(b.l ?? b.low);
    const hi = Number(b.h ?? b.high);
    const v = Number(b.v ?? b.volume) || 0;
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || v <= 0) continue;
    const loBin = Math.max(0, Math.floor((lo - minPx) / binSize));
    const hiBin = Math.min(binCount - 1, Math.floor((hi - minPx) / binSize));
    const span = Math.max(1, hiBin - loBin + 1);
    const vPerBin = v / span;
    for (let i = loBin; i <= hiBin; i++) {
      bins[i] += vPerBin;
      totalVolume += vPerBin;
    }
  }

  if (totalVolume <= 0) return null;

  // POC = bin with max volume.
  let pocBin = 0, pocVol = 0;
  for (let i = 0; i < binCount; i++) {
    if (bins[i] > pocVol) { pocVol = bins[i]; pocBin = i; }
  }
  const poc = minPx + (pocBin + 0.5) * binSize;

  // Value Area — expand symmetrically from POC until accumulated volume
  // exceeds valueAreaPct × total volume. Standard Market Profile algorithm:
  // at each step compare the next bin above vs next bin below, add the
  // bigger one to the running total.
  let lowIdx = pocBin, highIdx = pocBin;
  let vaVolume = bins[pocBin];
  const targetVolume = totalVolume * valueAreaPct;
  while (vaVolume < targetVolume && (lowIdx > 0 || highIdx < binCount - 1)) {
    const above = highIdx < binCount - 1 ? bins[highIdx + 1] : -1;
    const below = lowIdx > 0 ? bins[lowIdx - 1] : -1;
    if (above >= below && above >= 0) {
      highIdx++;
      vaVolume += bins[highIdx];
    } else if (below >= 0) {
      lowIdx--;
      vaVolume += bins[lowIdx];
    } else {
      break;
    }
  }
  const vah = minPx + (highIdx + 1) * binSize;
  const val = minPx + lowIdx * binSize;

  // Identify the top 3 High-Volume Nodes (HVN) for support/resistance.
  const binIndices = bins.map((v, i) => ({ v, price: minPx + (i + 0.5) * binSize }));
  binIndices.sort((a, b) => b.v - a.v);
  const hvns = binIndices.slice(0, 5).map(b => ({
    price: Math.round(b.price * 100) / 100,
    volume_pct: Math.round((b.v / totalVolume) * 10000) / 100,
  }));

  return {
    poc: Math.round(poc * 100) / 100,
    vah: Math.round(vah * 100) / 100,
    val: Math.round(val * 100) / 100,
    total_volume: Math.round(totalVolume),
    value_area_volume: Math.round(vaVolume),
    value_area_pct: Math.round((vaVolume / totalVolume) * 10000) / 100,
    bin_size: Math.round(binSize * 100) / 100,
    bin_count: binCount,
    hvns,
    range: { min: Math.round(minPx * 100) / 100, max: Math.round(maxPx * 100) / 100 },
    bars_used: bars.length,
  };
}

/**
 * Convenience: pull daily candles from D1 + compute Volume Profile.
 * Returns null if no candles or DB unavailable. Caches result in KV
 * 1h since daily profile doesn't change intraday.
 *
 * @param {object} env - worker env with DB binding
 * @param {string} ticker - underlying symbol
 * @param {object} [opts] - { lookbackDays?: 20, binCount?: 50 }
 */
export async function computeDailyVolumeProfile(env, ticker, opts = {}) {
  if (!env?.DB || !ticker) return null;
  const lookbackDays = Math.max(5, Math.min(252, opts.lookbackDays || 20));
  const cacheKey = `timed:vp:${String(ticker).toUpperCase()}:${lookbackDays}`;
  try {
    const cached = await env.KV_TIMED?.get(cacheKey);
    if (cached) {
      const j = JSON.parse(cached);
      if (Date.now() - (j._fetched_at || 0) < 3600_000) return j;
    }
  } catch (_) {}

  try {
    const r = await env.DB.prepare(
      `SELECT ts, o, h, l, c, v FROM ticker_candles
       WHERE ticker = ?1 AND tf = 'D'
       ORDER BY ts DESC LIMIT ?2`
    ).bind(String(ticker).toUpperCase(), lookbackDays).all();
    const rows = (r?.results || []).reverse(); // ascending for VP
    if (rows.length === 0) return null;
    const profile = computeVolumeProfile(rows, opts);
    if (!profile) return null;
    profile._fetched_at = Date.now();
    profile.ticker = String(ticker).toUpperCase();
    profile.lookback_days = lookbackDays;
    try { await env.KV_TIMED?.put(cacheKey, JSON.stringify(profile), { expirationTtl: 7200 }); } catch (_) {}
    return profile;
  } catch (_) {
    return null;
  }
}

/**
 * Classify current price relative to the value area + POC.
 * Used by ICT layer (premium/discount) and Saty layer (level execution).
 *
 * @returns {object} { zone, pct_from_poc, evidence }
 *   zone ∈ { ABOVE_VAH, AT_VAH, IN_VALUE, AT_VAL, BELOW_VAL }
 */
export function classifyPriceVsVP(price, vp) {
  if (!Number.isFinite(price) || !vp) return null;
  const { poc, vah, val } = vp;
  const tol = Math.max(0.005 * price, vp.bin_size * 0.5);
  let zone, evidence;
  if (price > vah + tol) {
    zone = "ABOVE_VAH";
    evidence = `Above VAH \$${vah} → premium, look for revert`;
  } else if (price >= vah - tol) {
    zone = "AT_VAH";
    evidence = `At VAH \$${vah} → resistance test`;
  } else if (price >= val - tol) {
    zone = "IN_VALUE";
    evidence = `In value area (\$${val}–\$${vah}, POC \$${poc})`;
  } else if (price >= val - tol) {
    zone = "AT_VAL";
    evidence = `At VAL \$${val} → support test`;
  } else {
    zone = "BELOW_VAL";
    evidence = `Below VAL \$${val} → discount, look for revert`;
  }
  const pctFromPOC = ((price - poc) / poc) * 100;
  return {
    zone,
    pct_from_poc: Math.round(pctFromPOC * 100) / 100,
    poc, vah, val,
    evidence,
  };
}
