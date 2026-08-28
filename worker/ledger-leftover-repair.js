// Investor ledger leftovers the exact-ts COO heal misses:
//   1. Orphan repair_backfill ENTRY/DCA_BUY whose lot was deleted (twin +286ms).
//   2. Same-timestamp double SELL that overshoots remaining shares (invalidation
//      + event-risk trim). Keep the invalidation, drop the extra trim.
//   3. Closed-position dust after an incomplete invalidation EXIT.

import { replayInvestorLots } from "./investor-lot-ledger.js";

const TWIN_MS = 2000;
const DUST_SHARES = 2;
const DUST_VALUE = 500;
const SHARE_EPS = 0.01;
const CASH_EPS = 1;

function lotIdOf(lot) {
  return String(lot?.id || lot?.lot_id || "");
}

function lotAction(lot) {
  return String(lot?.action || "").toUpperCase();
}

function isBuyAction(action) {
  const a = String(action || "").toUpperCase();
  return a === "BUY" || a === "DCA_BUY";
}

function isSellAction(action) {
  return String(action || "").toUpperCase() === "SELL";
}

function isInvalidationReason(reason) {
  return /INVALIDATION/i.test(String(reason || ""));
}

function lotIdFromNote(note) {
  const m = String(note || "").match(/repair_backfill_from_lot_(\S+)/);
  return m ? m[1] : "";
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows || []) {
    const key = keyFn(row);
    const arr = map.get(key) || [];
    arr.push(row);
    map.set(key, arr);
  }
  return map;
}

function sortLots(lots) {
  return [...(lots || [])].sort((a, b) => {
    const ta = Number(a?.ts) || 0;
    const tb = Number(b?.ts) || 0;
    if (ta !== tb) return ta - tb;
    return lotIdOf(a).localeCompare(lotIdOf(b));
  });
}

function findLedgerForLot(ledgerRows, lot, { eventTypes = null } = {}) {
  const pid = String(lot.position_id || "");
  const ts = Number(lot.ts) || 0;
  const shares = Number(lot.shares) || 0;
  const value = Number(lot.value) || 0;
  const accepted = eventTypes || (isSellAction(lot.action)
    ? new Set(["TRIM", "EXIT"])
    : new Set(["ENTRY", "DCA_BUY"]));
  const candidates = (ledgerRows || []).filter((r) => {
    if (String(r.position_id || "") !== pid) return false;
    if (!accepted.has(String(r.event_type || "").toUpperCase())) return false;
    const sameTs = Number(r.ts) === ts;
    const qtyMatch = Math.abs((Number(r.qty) || 0) - shares) <= SHARE_EPS;
    const cashMatch = Math.abs(Math.abs(Number(r.cash_delta) || 0) - value) <= CASH_EPS;
    const noteLot = lotIdFromNote(r.note);
    if (noteLot && noteLot === lotIdOf(lot)) return true;
    return sameTs && (qtyMatch || cashMatch);
  });
  if (!candidates.length) return null;
  return candidates.find((r) => Math.abs((Number(r.qty) || 0) - shares) <= SHARE_EPS)
    || candidates[0];
}

/** Twin buy ledger whose lot was deleted, sitting beside a kept sibling. */
export function planOrphanTwinBuys(lots, ledgerRows) {
  const lotIds = new Set((lots || []).map(lotIdOf).filter(Boolean));
  const buyLedger = (ledgerRows || []).filter((r) => {
    const t = String(r.event_type || "").toUpperCase();
    return t === "ENTRY" || t === "DCA_BUY";
  });
  const orphans = [];
  for (const row of buyLedger) {
    const lotId = lotIdFromNote(row.note);
    if (!lotId || lotIds.has(lotId)) continue;
    const sibling = buyLedger.find((other) => {
      if (other === row) return false;
      if (String(other.position_id || "") !== String(row.position_id || "")) return false;
      if (Math.abs((Number(other.ts) || 0) - (Number(row.ts) || 0)) > TWIN_MS) return false;
      if (Math.abs((Number(other.qty) || 0) - (Number(row.qty) || 0)) > SHARE_EPS) return false;
      if (Math.abs((Number(other.cash_delta) || 0) - (Number(row.cash_delta) || 0)) > CASH_EPS) return false;
      const otherLot = lotIdFromNote(other.note);
      return !otherLot || lotIds.has(otherLot);
    });
    if (!sibling) continue;
    orphans.push({
      kind: "orphan_twin_buy",
      ledger_id: row.ledger_id,
      ticker: row.ticker,
      position_id: row.position_id,
      ts: row.ts,
      cash_delta: Number(row.cash_delta) || 0,
      missing_lot_id: lotId,
      sibling_ledger_id: sibling.ledger_id,
    });
  }
  return orphans;
}

/**
 * Same-ts SELL pair that overshoots remaining shares.
 * Keep the invalidation (or the lot that matches remaining), drop the rest.
 */
export function planSameTsOversellDrops(lots, ledgerRows) {
  const sorted = sortLots(lots);
  const heldBefore = new Map();
  const held = new Map();
  for (const lot of sorted) {
    const pid = String(lot.position_id || "");
    heldBefore.set(lotIdOf(lot), Number(held.get(pid)) || 0);
    const action = lotAction(lot);
    const shares = Number(lot.shares) || 0;
    if (isBuyAction(action)) held.set(pid, (Number(held.get(pid)) || 0) + shares);
    else if (isSellAction(action)) held.set(pid, Math.max(0, (Number(held.get(pid)) || 0) - shares));
  }

  const sellGroups = groupBy(
    sorted.filter((l) => isSellAction(l.action)),
    (l) => `${l.position_id || ""}|${Number(l.ts) || 0}`,
  );
  const drops = [];
  const resyncs = [];

  for (const [, group] of sellGroups) {
    if (group.length < 2) continue;
    const remaining = heldBefore.get(lotIdOf(group[0])) || 0;
    const sold = group.reduce((s, l) => s + (Number(l.shares) || 0), 0);
    if (sold <= remaining + SHARE_EPS) continue;

    const keep = group.find((l) => isInvalidationReason(l.reason))
      || group.find((l) => Math.abs((Number(l.shares) || 0) - remaining) <= SHARE_EPS)
      || [...group].sort((a, b) => (Number(b.shares) || 0) - (Number(a.shares) || 0))[0];
    const dropLots = group.filter((l) => l !== keep);
    for (const lot of dropLots) {
      const led = findLedgerForLot(ledgerRows, lot);
      drops.push({
        kind: "same_ts_oversell",
        ticker: lot.ticker,
        position_id: lot.position_id,
        ts: lot.ts,
        lot_id: lotIdOf(lot),
        ledger_id: led?.ledger_id || null,
        shares: Number(lot.shares) || 0,
        value: Number(lot.value) || 0,
        reason: lot.reason || "",
        keep_lot_id: lotIdOf(keep),
      });
    }
    const keepLed = findLedgerForLot(ledgerRows, keep);
    if (keepLed) {
      const expectedCash = Number(keep.value) || 0;
      const actualCash = Number(keepLed.cash_delta) || 0;
      if (Math.abs(expectedCash - actualCash) > CASH_EPS) {
        resyncs.push({
          kind: "resync_kept_exit_cash",
          ledger_id: keepLed.ledger_id,
          lot_id: lotIdOf(keep),
          ticker: keep.ticker,
          qty: Number(keep.shares) || 0,
          cash_delta: Math.round(expectedCash * 100) / 100,
          realized_pnl: Number(keepLed.realized_pnl),
        });
      }
    }
  }
  return { drops, resyncs };
}

/** Closed (or effectively flat) positions with leftover dust after invalidation. */
export function planClosedDustFlattens(lots, ledgerRows, positions) {
  const posById = new Map((positions || []).map((p) => [String(p.id), p]));
  const lotsByPos = groupBy(lots, (l) => String(l.position_id || ""));
  const flattens = [];
  const zeroClosed = [];

  for (const [pid, posLots] of lotsByPos) {
    const replay = replayInvestorLots(posLots);
    const leftover = Number(replay.totalShares) || 0;
    const leftoverCost = Number(replay.costBasis) || 0;
    const pos = posById.get(pid);
    const closed = !pos || String(pos.status || "").toUpperCase() === "CLOSED";
    if (leftover <= SHARE_EPS) {
      if (closed && pos && (Math.abs(Number(pos.cost_basis) || 0) > CASH_EPS || Math.abs(Number(pos.total_shares) || 0) > SHARE_EPS)) {
        zeroClosed.push({
          kind: "zero_closed_snapshot",
          position_id: pid,
          ticker: pos.ticker,
          before_cost: Number(pos.cost_basis) || 0,
          before_shares: Number(pos.total_shares) || 0,
        });
      }
      continue;
    }
    if (!closed) continue;
    if (leftover > DUST_SHARES && leftoverCost > DUST_VALUE) continue;

    const sells = sortLots(posLots).filter((l) => isSellAction(l.action));
    const lastSell = [...sells].reverse().find((l) => isInvalidationReason(l.reason)) || sells[sells.length - 1];
    if (!lastSell) continue;
    const price = Number(lastSell.price) || 0;
    if (!(price > 0)) continue;
    const newShares = (Number(lastSell.shares) || 0) + leftover;
    const newValue = Math.round(price * newShares * 100) / 100;
    const patched = posLots.map((l) => (
      lotIdOf(l) === lotIdOf(lastSell)
        ? { ...l, shares: newShares, value: newValue }
        : l
    ));
    const after = replayInvestorLots(patched);
    const sellMeta = after.byLotId.get(lotIdOf(lastSell)) || {};
    const led = findLedgerForLot(ledgerRows, lastSell);
    flattens.push({
      kind: "closed_dust_flatten",
      position_id: pid,
      ticker: lastSell.ticker,
      lot_id: lotIdOf(lastSell),
      ledger_id: led?.ledger_id || null,
      leftover_shares: Math.round(leftover * 10000) / 10000,
      leftover_cost: Math.round(leftoverCost * 100) / 100,
      shares: Math.round(newShares * 10000) / 10000,
      value: newValue,
      price,
      realized_pnl: Number.isFinite(Number(sellMeta.realizedPnl))
        ? Math.round(Number(sellMeta.realizedPnl) * 100) / 100
        : (led ? Number(led.realized_pnl) || 0 : 0),
    });
  }
  return { flattens, zeroClosed };
}

export function planInvestorLedgerLeftovers({ lots = [], ledgerRows = [], positions = [] } = {}) {
  const orphans = planOrphanTwinBuys(lots, ledgerRows);
  const { drops, resyncs } = planSameTsOversellDrops(lots, ledgerRows);
  const lotsAfterDrops = lots.filter((l) => !drops.some((d) => d.lot_id === lotIdOf(l)));
  const ledgerAfterOrphans = ledgerRows.filter((r) => (
    !orphans.some((o) => o.ledger_id === r.ledger_id)
    && !drops.some((d) => d.ledger_id === r.ledger_id)
  ));
  const { flattens, zeroClosed } = planClosedDustFlattens(lotsAfterDrops, ledgerAfterOrphans, positions);
  return {
    orphans,
    oversell_drops: drops,
    resyncs,
    flattens,
    zero_closed: zeroClosed,
    action_count: orphans.length + drops.length + resyncs.length + flattens.length + zeroClosed.length,
  };
}

export async function recomputeInvestorLedgerBalances(db) {
  const { results: postRows } = await db.prepare(
    `SELECT ledger_id, cash_delta FROM account_ledger WHERE mode = 'investor' ORDER BY ts ASC, ledger_id ASC`,
  ).all();
  let runningBal = 100000;
  let rebalanced = 0;
  for (const r of (postRows || [])) {
    runningBal += Number(r.cash_delta) || 0;
    await db.prepare(
      `UPDATE account_ledger SET balance = ?1 WHERE ledger_id = ?2`,
    ).bind(Math.round(runningBal * 100) / 100, r.ledger_id).run();
    rebalanced += 1;
  }
  return { rebalanced, balance: Math.round(runningBal * 100) / 100 };
}

export async function applyInvestorLedgerLeftovers(db, { dryRun = true, skipRebalance = false } = {}) {
  const [{ results: lots }, { results: ledgerRows }, { results: positions }] = await Promise.all([
    db.prepare(
      `SELECT id, position_id, ticker, action, shares, price, value, ts, reason FROM investor_lots ORDER BY ts ASC, id ASC`,
    ).all(),
    db.prepare(
      `SELECT ledger_id, position_id, ticker, ts, event_type, qty, price, cash_delta, realized_pnl, note
         FROM account_ledger WHERE mode = 'investor' ORDER BY ts ASC, ledger_id ASC`,
    ).all(),
    db.prepare(
      `SELECT id, ticker, status, total_shares, cost_basis FROM investor_positions`,
    ).all(),
  ]);
  const plan = planInvestorLedgerLeftovers({ lots: lots || [], ledgerRows: ledgerRows || [], positions: positions || [] });
  const written = {
    deleted_ledger: 0,
    deleted_lots: 0,
    updated_ledger: 0,
    updated_lots: 0,
    zeroed_closed: 0,
    rebalanced: 0,
  };
  if (dryRun) {
    return { ok: true, dryRun: true, ...plan, written };
  }

  for (const drop of plan.oversell_drops) {
    if (drop.ledger_id) {
      await db.prepare(
        `DELETE FROM account_ledger WHERE ledger_id = ?1 AND mode = 'investor'`,
      ).bind(drop.ledger_id).run();
      written.deleted_ledger += 1;
    }
    if (drop.lot_id) {
      await db.prepare(`DELETE FROM investor_lots WHERE id = ?1`).bind(drop.lot_id).run();
      written.deleted_lots += 1;
    }
  }
  for (const row of plan.orphans) {
    await db.prepare(
      `DELETE FROM account_ledger WHERE ledger_id = ?1 AND mode = 'investor'`,
    ).bind(row.ledger_id).run();
    written.deleted_ledger += 1;
  }
  for (const row of plan.resyncs) {
    await db.prepare(
      `UPDATE account_ledger SET cash_delta = ?1, qty = COALESCE(qty, ?2) WHERE ledger_id = ?3`,
    ).bind(row.cash_delta, row.qty, row.ledger_id).run();
    written.updated_ledger += 1;
  }
  for (const row of plan.flattens) {
    if (row.lot_id) {
      await db.prepare(
        `UPDATE investor_lots SET shares = ?1, value = ?2 WHERE id = ?3`,
      ).bind(row.shares, row.value, row.lot_id).run();
      written.updated_lots += 1;
    }
    if (row.ledger_id) {
      await db.prepare(
        `UPDATE account_ledger SET qty = ?1, cash_delta = ?2, realized_pnl = ?3 WHERE ledger_id = ?4`,
      ).bind(row.shares, row.value, row.realized_pnl, row.ledger_id).run();
      written.updated_ledger += 1;
    }
    await db.prepare(
      `UPDATE investor_positions
          SET total_shares = 0, cost_basis = 0, avg_entry = 0, updated_at = ?1
        WHERE id = ?2 AND status = 'CLOSED'`,
    ).bind(Date.now(), row.position_id).run();
    written.zeroed_closed += 1;
  }
  for (const row of plan.zero_closed) {
    await db.prepare(
      `UPDATE investor_positions
          SET total_shares = 0, cost_basis = 0, avg_entry = 0, updated_at = ?1
        WHERE id = ?2 AND status = 'CLOSED'`,
    ).bind(Date.now(), row.position_id).run();
    written.zeroed_closed += 1;
  }
  if (plan.action_count > 0 && !skipRebalance) {
    const bal = await recomputeInvestorLedgerBalances(db);
    written.rebalanced = bal.rebalanced;
    written.balance = bal.balance;
  }
  return { ok: true, dryRun: false, ...plan, written };
}
