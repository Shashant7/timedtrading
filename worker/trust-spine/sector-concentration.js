// Trust Spine — portfolio sector concentration cap (shadow-first).

import { getThemesForTicker } from "../sector-mapping.js";

/**
 * @param {Array<{ticker, shares, entry_price}>} openRows
 * @param {object} priceMap timed:prices.prices
 * @param {number} maxSectorPct default 40
 */
export function evaluateSectorConcentration(openRows, priceMap, maxSectorPct = 40) {
  const bySector = {};
  let total = 0;
  for (const r of openRows || []) {
    const sym = String(r.ticker || "").toUpperCase();
    const shares = Number(r.shares) || 0;
    const px = Number(priceMap?.[sym]?.p) || Number(r.entry_price) || 0;
    if (shares <= 0 || px <= 0) continue;
    const notional = Math.abs(shares * px);
    total += notional;
    const themes = getThemesForTicker(sym) || [];
    const sector = themes[0] || "OTHER";
    bySector[sector] = (bySector[sector] || 0) + notional;
  }
  const sectors = Object.entries(bySector).map(([sector, notional]) => ({
    sector,
    notional: +notional.toFixed(2),
    pct: total > 0 ? +((notional / total) * 100).toFixed(1) : 0,
  })).sort((a, b) => b.pct - a.pct);

  const worst = sectors[0] || null;
  const trip = worst && worst.pct >= maxSectorPct;
  return {
    total_notional: +total.toFixed(2),
    max_sector_pct: maxSectorPct,
    sectors,
    worst_sector: worst?.sector || null,
    worst_sector_pct: worst?.pct ?? null,
    sector_trip: trip,
    block_reason: trip ? `sector_concentration_${worst.sector}_${worst.pct}pct` : null,
  };
}
