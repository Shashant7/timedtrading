// Investor position snapshot repair — sync investor_positions from investor_lots.
//
// The ledger repair endpoint back-fills account_ledger from lots; this is the
// companion for the positions table when trims updated lots + ledger but left
// cost_basis / total_shares stale on investor_positions.

import { replayInvestorLots } from "./investor-lot-ledger.js";

const COST_TOLERANCE = 1;
const SHARE_TOLERANCE = 0.01;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/** Load per-position lot-derived net shares/cost for OPEN rows. */
export async function loadInvestorPositionLotDerived(db) {
  const posRes = await db.prepare(
    `SELECT id, ticker, status, total_shares, cost_basis, avg_entry
       FROM investor_positions
      WHERE status = 'OPEN'`,
  ).all().catch(() => ({ results: [] }));
  const positions = posRes?.results || [];
  if (!positions.length) return [];

  const lotsRes = await db.prepare(
    `SELECT l.id, l.position_id, l.action, l.shares, l.price, l.value, l.ts
       FROM investor_lots l
       INNER JOIN investor_positions p ON l.position_id = p.id
      WHERE p.status = 'OPEN'
      ORDER BY l.position_id ASC, l.ts ASC, l.id ASC`,
  ).all().catch(() => ({ results: [] }));

  const lotsByPos = new Map();
  for (const lot of lotsRes?.results || []) {
    const pid = lot.position_id;
    if (!lotsByPos.has(pid)) lotsByPos.set(pid, []);
    lotsByPos.get(pid).push(lot);
  }

  return positions.map((p) => {
    const lots = lotsByPos.get(p.id) || [];
    const replay = replayInvestorLots(lots);
    return {
      id: p.id,
      ticker: p.ticker,
      status: p.status,
      total_shares: p.total_shares,
      cost_basis: p.cost_basis,
      avg_entry: p.avg_entry,
      lot_shares: replay.totalShares,
      lot_cost: replay.costBasis,
      lot_avg_entry: replay.avgEntry,
      lot_count: lots.length,
    };
  });
}

/** Compare OPEN positions to lot-derived totals; return drift rows. */
export function diffInvestorPositionsVsLots(rows) {
  const mismatches = [];
  let posCostSum = 0;
  let lotCostSum = 0;
  for (const r of rows || []) {
    const posShares = Number(r.total_shares) || 0;
    const posCost = Number(r.cost_basis) || 0;
    const lotShares = Number(r.lot_shares) || 0;
    const lotCost = Number(r.lot_cost) || 0;
    const lotCount = Number(r.lot_count) || 0;
    posCostSum += posCost;
    lotCostSum += lotCost;
    const shareDrift = posShares - lotShares;
    const costDrift = posCost - lotCost;
    if (Math.abs(shareDrift) <= SHARE_TOLERANCE && Math.abs(costDrift) <= COST_TOLERANCE) continue;
    mismatches.push({
      id: r.id,
      ticker: r.ticker,
      lot_count: lotCount,
      pos_shares: round2(posShares),
      lot_shares: round2(lotShares),
      share_drift: round2(shareDrift),
      pos_cost: round2(posCost),
      lot_cost: round2(lotCost),
      cost_drift: round2(costDrift),
      needs_manual: lotCount === 0 && posCost > COST_TOLERANCE,
    });
  }
  return {
    mismatches,
    pos_cost_sum: round2(posCostSum),
    lot_cost_sum: round2(lotCostSum),
    total_cost_drift: round2(posCostSum - lotCostSum),
  };
}

/**
 * Sync investor_positions cost_basis / total_shares / avg_entry from lots.
 * Skips rows with no lots but non-zero cost (phantom positions — manual fix).
 */
export async function repairInvestorPositionsFromLots(db, { dryRun = true } = {}) {
  const rows = await loadInvestorPositionLotDerived(db);
  const { mismatches, pos_cost_sum, lot_cost_sum, total_cost_drift } = diffInvestorPositionsVsLots(rows);
  const repairs = [];
  const skipped = [];
  const now = Date.now();

  for (const m of mismatches) {
    if (m.needs_manual) {
      skipped.push({ ...m, reason: "open_position_no_lots" });
      continue;
    }
    const lotShares = Number(m.lot_shares) || 0;
    const lotCost = Number(m.lot_cost) || 0;
    const avgEntry = lotShares > 0 ? lotCost / lotShares : 0;
    const patch = {
      id: m.id,
      ticker: m.ticker,
      total_shares: round2(lotShares),
      cost_basis: round2(lotCost),
      avg_entry: round2(avgEntry),
      before: { shares: m.pos_shares, cost: m.pos_cost },
      after: { shares: round2(lotShares), cost: round2(lotCost), avg_entry: round2(avgEntry) },
    };
    repairs.push(patch);
    if (!dryRun) {
      await db.prepare(
        `UPDATE investor_positions
            SET total_shares = ?1, cost_basis = ?2, avg_entry = ?3, updated_at = ?4
          WHERE id = ?5`,
      ).bind(lotShares, lotCost, avgEntry, now, m.id).run();
    }
  }

  return {
    dryRun,
    mismatch_count: mismatches.length,
    repair_count: repairs.length,
    skipped_count: skipped.length,
    pos_cost_sum,
    lot_cost_sum,
    total_cost_drift,
    repairs,
    skipped,
  };
}
