// Replay investor_lots into position cost_basis / per-lot realized P&L.
// SELL rows reduce cost_basis by proportional cost (not sell proceeds).

/** D1 rejects statements with >100 bound parameters (silent if caught). */
export const D1_MAX_BOUND_PARAMS = 100;
/** Leave headroom for other binds in the same statement. */
export const INVESTOR_LOT_IN_CHUNK = 80;

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
          action,
          shares,
          price,
          avgEntryAfter: totalShares > 0 ? costBasis / totalShares : 0,
          heldAfter: totalShares,
        });
      }
      continue;
    }

    if (action !== "SELL") continue;

    if (totalShares <= 0) {
      if (id) {
        byLotId.set(id, {
          action,
          shares,
          price,
          avgEntryAtSell: 0,
          realizedPnl: null,
          realizedPnlPct: null,
          heldAfter: 0,
        });
      }
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
        action,
        shares: sellShares,
        price,
        avgEntryAtSell,
        costBasisSold,
        realizedPnl,
        realizedPnlPct,
        avgEntryAfter: totalShares > 0 ? costBasis / totalShares : 0,
        heldAfter: totalShares,
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

/**
 * Load all investor_lots for a set of position_ids, chunked under D1's
 * 100-bind cap. A single IN (...) with 161 ids previously threw
 * "too many SQL variables", was swallowed by `.catch(() => [])`, and
 * made every Long Term monthly PnL row show $0 / 0% WR.
 *
 * @param {object} db D1 database
 * @param {string[]} positionIds
 * @param {{ chunkSize?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function fetchInvestorLotsForPositions(db, positionIds, opts = {}) {
  const ids = [...new Set((positionIds || []).map((x) => String(x || "").trim()).filter(Boolean))];
  if (!db || !ids.length) return [];
  const chunkSize = Math.max(1, Math.min(
    INVESTOR_LOT_IN_CHUNK,
    Number(opts.chunkSize) || INVESTOR_LOT_IN_CHUNK,
    D1_MAX_BOUND_PARAMS - 1,
  ));
  const out = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const ph = chunk.map(() => "?").join(",");
    const res = await db.prepare(
      `SELECT id, position_id, action, shares, price, value, ts
         FROM investor_lots
        WHERE position_id IN (${ph})
        ORDER BY position_id ASC, ts ASC, id ASC`,
    ).bind(...chunk).all();
    for (const row of res?.results || []) out.push(row);
  }
  return out;
}

/**
 * Build replay maps keyed by position_id from a flat lots list.
 * @param {object[]} lots
 * @returns {Record<string, ReturnType<typeof replayInvestorLots>>}
 */
export function replayInvestorLotsByPosition(lots) {
  const lotsByPos = {};
  for (const lot of lots || []) {
    const pid = String(lot?.position_id || "");
    if (!pid) continue;
    if (!lotsByPos[pid]) lotsByPos[pid] = [];
    lotsByPos[pid].push(lot);
  }
  const replayByPos = {};
  for (const pid of Object.keys(lotsByPos)) {
    replayByPos[pid] = replayInvestorLots(lotsByPos[pid]);
  }
  return replayByPos;
}
