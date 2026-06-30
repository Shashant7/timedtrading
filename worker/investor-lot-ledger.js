// Replay investor_lots into position cost_basis / per-lot realized P&L.
// SELL rows reduce cost_basis by proportional cost (not sell proceeds).

function lotIdOf(lot) {
  return String(lot?.id || lot?.lot_id || "");
}

function lotValue(lot, shares, price) {
  const v = Number(lot?.value);
  if (Number.isFinite(v) && v > 0) return v;
  return shares > 0 && price > 0 ? shares * price : 0;
}

/**
 * Replay lots chronologically for one position.
 * @returns {{ totalShares, costBasis, avgEntry, byLotId: Map<string, object> }}
 */
export function replayInvestorLots(lots) {
  const sorted = [...(lots || [])].sort((a, b) => {
    const ta = Number(a?.ts) || 0;
    const tb = Number(b?.ts) || 0;
    if (ta !== tb) return ta - tb;
    return lotIdOf(a).localeCompare(lotIdOf(b));
  });

  let totalShares = 0;
  let costBasis = 0;
  const byLotId = new Map();

  for (const lot of sorted) {
    const id = lotIdOf(lot);
    const action = String(lot?.action || "").toUpperCase();
    const shares = Number(lot?.shares) || 0;
    const price = Number(lot?.price) || 0;
    if (shares <= 0) continue;

    if (action === "BUY" || action === "DCA_BUY") {
      const value = lotValue(lot, shares, price);
      totalShares += shares;
      costBasis += value;
      if (id) {
        byLotId.set(id, {
          avgEntryAfter: totalShares > 0 ? costBasis / totalShares : 0,
        });
      }
      continue;
    }

    if (action !== "SELL") continue;

    if (totalShares <= 0) {
      if (id) byLotId.set(id, { avgEntryAtSell: 0, realizedPnl: null, realizedPnlPct: null });
      continue;
    }

    const sellShares = Math.min(shares, totalShares);
    const avgEntryAtSell = costBasis / totalShares;
    const costBasisSold = avgEntryAtSell * sellShares;
    const sellValue = lotValue(lot, sellShares, price);
    const realizedPnl = sellValue - costBasisSold;
    const realizedPnlPct = avgEntryAtSell > 0
      ? ((price - avgEntryAtSell) / avgEntryAtSell) * 100
      : null;

    costBasis = Math.max(0, costBasis - costBasisSold);
    totalShares = Math.max(0, totalShares - sellShares);

    if (id) {
      byLotId.set(id, {
        avgEntryAtSell,
        costBasisSold,
        realizedPnl,
        realizedPnlPct,
        avgEntryAfter: totalShares > 0 ? costBasis / totalShares : 0,
      });
    }
  }

  return {
    totalShares,
    costBasis,
    avgEntry: totalShares > 0 ? costBasis / totalShares : 0,
    byLotId,
  };
}

/** Proportional trim snapshot (keeps avg_entry stable when cost_basis is correct). */
export function investorTrimSnapshot(costBasis, totalShares, trimShares) {
  const total = Number(totalShares) || 0;
  const cost = Number(costBasis) || 0;
  const trim = Number(trimShares) || 0;
  if (total <= 0 || trim <= 0) {
    return { partialCostBasis: 0, newCost: cost, remaining: total, avgEntry: total > 0 ? cost / total : 0 };
  }
  const partialCostBasis = cost * (trim / total);
  const newCost = Math.max(0, cost - partialCostBasis);
  const remaining = Math.max(0, total - trim);
  const avgEntry = remaining > 0 ? newCost / remaining : 0;
  return { partialCostBasis, newCost, remaining, avgEntry };
}
