// ledger-reconcile.js — Packet A of the ledger audit plan
// (plans/current-ledger-audit-pnl-improvement-2026-09-04.md).
//
// The account summary derives realized P&L from `account_ledger` events;
// the public ledger page sums closed `trades` rows. The 2026-09-04 audit
// found a $142.44 gap between the two. Root causes found in production:
//   • duplicate full-quantity EXIT events (same position, qty, price,
//     realized_pnl written twice — e.g. a premarket exit re-fired at the
//     open), double-counting cash AND realized P&L;
//   • realized trim events on still-open trades (legitimate — rows only
//     carry that P&L after the trade closes);
//   • smaller event-vs-row drifts where a row's final pnl was patched
//     after its close event was written.
//
// This module provides:
//   • isDuplicateExitEvent(db, row) — write-time idempotency guard used by
//     d1InsertLedgerEntry so an identical EXIT can never be recorded twice;
//   • computeLedgerReconciliation(db, opts) — the read-only truth surface
//     behind GET /timed/admin/ledger-reconcile.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  const n = num(v);
  return n == null ? null : Math.round(n * 100) / 100;
}

/**
 * True when an identical EXIT event already exists for this position.
 * "Identical" is deliberately narrow — same mode + position + EXIT +
 * same qty and price (±1e-6) — so legitimate staged exits with different
 * fills are never suppressed, only true double-fires.
 */
export async function isDuplicateExitEvent(db, row) {
  if (!db || !row) return false;
  const eventType = String(row.event_type || "").toUpperCase();
  if (eventType !== "EXIT") return false;
  const positionId = row.position_id;
  if (!positionId) return false;
  const qty = num(row.qty);
  const price = num(row.price);
  try {
    const existing = await db.prepare(
      `SELECT ledger_id, qty, price FROM account_ledger
        WHERE mode = ?1 AND position_id = ?2 AND event_type = 'EXIT'`
    ).bind(row.mode || "trader", positionId).all();
    for (const e of existing?.results || []) {
      const eq = num(e.qty);
      const ep = num(e.price);
      const qtyMatch = (qty == null && eq == null)
        || (qty != null && eq != null && Math.abs(qty - eq) < 1e-6);
      const priceMatch = (price == null && ep == null)
        || (price != null && ep != null && Math.abs(price - ep) < 1e-6);
      if (qtyMatch && priceMatch) return true;
    }
  } catch (_) {
    // On query failure fall through to allowing the insert — a missed
    // dedupe is recoverable via the reconcile report; a blocked legitimate
    // close event is not.
  }
  return false;
}

/**
 * Event-level reconciliation between account_ledger and trades rows.
 * Read-only. Returns totals, the gap, its decomposition, per-trade
 * drift rows, and duplicate-EXIT candidates.
 */
export async function computeLedgerReconciliation(db, { mode = "trader", driftLimit = 50 } = {}) {
  const m = String(mode || "trader").toLowerCase() === "investor" ? "investor" : "trader";

  const totals = await db.prepare(
    `SELECT
       (SELECT COALESCE(SUM(realized_pnl), 0) FROM account_ledger WHERE mode = ?1) AS events_realized,
       (SELECT COALESCE(SUM(pnl), 0) FROM trades WHERE status IN ('WIN','LOSS','FLAT')) AS closed_rows_pnl,
       (SELECT COALESCE(SUM(realized_pnl), 0) FROM account_ledger
         WHERE mode = ?1 AND position_id IN (SELECT trade_id FROM trades WHERE status IN ('OPEN','TP_HIT_TRIM'))) AS events_on_open_trades,
       (SELECT COUNT(*) FROM account_ledger WHERE mode = ?1) AS event_count,
       (SELECT COUNT(*) FROM trades WHERE status IN ('WIN','LOSS','FLAT')) AS closed_row_count`
  ).bind(m).first();

  const eventsRealized = round2(totals?.events_realized) ?? 0;
  const closedRowsPnl = round2(totals?.closed_rows_pnl) ?? 0;
  const eventsOnOpen = round2(totals?.events_on_open_trades) ?? 0;
  const gap = round2(closedRowsPnl - eventsRealized) ?? 0;

  // Per-trade drift: closed rows whose row pnl differs from the summed
  // events for that position by more than a cent.
  const drift = await db.prepare(
    `SELECT t.trade_id, t.ticker, t.status, t.exit_reason, t.exit_ts,
            ROUND(t.pnl, 2) AS row_pnl,
            ROUND(COALESCE(e.ev_pnl, 0), 2) AS event_pnl,
            ROUND(t.pnl - COALESCE(e.ev_pnl, 0), 2) AS drift
       FROM trades t
       LEFT JOIN (SELECT position_id, SUM(realized_pnl) AS ev_pnl
                    FROM account_ledger WHERE mode = ?1 GROUP BY position_id) e
         ON e.position_id = t.trade_id
      WHERE t.status IN ('WIN','LOSS','FLAT')
        AND ABS(t.pnl - COALESCE(e.ev_pnl, 0)) > 0.01
      ORDER BY ABS(t.pnl - COALESCE(e.ev_pnl, 0)) DESC
      LIMIT ?2`
  ).bind(m, Math.max(1, Math.min(500, Number(driftLimit) || 50))).all();
  const driftRows = drift?.results || [];
  const driftTotal = round2(driftRows.reduce((a, r) => a + (num(r.drift) || 0), 0)) ?? 0;

  // Duplicate EXIT candidates: >1 EXIT event on one position with the
  // same qty + price. These double-count cash and realized P&L.
  const dupes = await db.prepare(
    `SELECT position_id, ticker, COUNT(*) AS n,
            ROUND(SUM(realized_pnl), 2) AS total_rpnl,
            ROUND(SUM(cash_delta), 2) AS total_cash,
            MIN(ts) AS first_ts, MAX(ts) AS last_ts
       FROM account_ledger
      WHERE mode = ?1 AND event_type = 'EXIT'
      GROUP BY position_id, ROUND(COALESCE(qty, -1), 6), ROUND(COALESCE(price, -1), 6)
     HAVING COUNT(*) > 1
      ORDER BY ABS(SUM(realized_pnl)) DESC
      LIMIT 50`
  ).bind(m).all();
  const duplicateExits = dupes?.results || [];

  // reconciled == the gap is fully explained by open-trade trim events
  // plus the enumerated per-trade drifts (to the cent).
  const explained = round2(driftTotal - eventsOnOpen) ?? 0;
  const residual = round2(gap - explained) ?? 0;

  return {
    mode: m,
    events_realized: eventsRealized,
    closed_rows_pnl: closedRowsPnl,
    gap,
    decomposition: {
      per_trade_drift_total: driftTotal,
      events_on_open_trades: eventsOnOpen,
      explained,
      residual,
    },
    reconciled: Math.abs(residual) <= 0.01,
    event_count: Number(totals?.event_count) || 0,
    closed_row_count: Number(totals?.closed_row_count) || 0,
    drift_rows: driftRows,
    duplicate_exit_events: duplicateExits,
  };
}
