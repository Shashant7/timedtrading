// worker/phantom-trim-scrub.js — detect + repair corrupted trim P&L rows.
//
// May 2026 cost_basis cascade wrote trades.entry_price ≈ $64 for SNDK ($1346
// real) → one TRIM cron tick booked +$14,365 realized. Same pattern on NFLX.

import {
  computeTrimRealized,
  isPhantomTrimRealized,
} from "./trade-trim-display.js";

export const PHANTOM_ENTRY_FLOOR = 0.5;

/** Classify one TRIM trade_event row. */
export function classifyPhantomTrimEvent(event, trade) {
  const type = String(event?.type || "").toUpperCase();
  if (type !== "TRIM") return { phantom: false, skipped: true, reason: "not_trim" };

  const entryPrice = Number(trade?.entry_price ?? trade?.entryPrice);
  const entryShares = Number(trade?.shares);
  const direction = trade?.direction || "LONG";
  const stored = Number(event?.pnl_realized);
  const trimPrice = Number(event?.price);
  const deltaFrac = Number(event?.qty_pct_delta);

  if (!Number.isFinite(stored) || stored === 0) {
    return { phantom: false, skipped: true, reason: "zero_realized" };
  }

  const phantom = isPhantomTrimRealized({
    storedRealized: stored,
    trimPrice,
    entryPrice,
    deltaFrac,
    entryShares,
    direction,
  });

  const corrected = phantom
    ? computeTrimRealized({
      trimPrice,
      entryPrice,
      deltaFrac,
      entryShares,
      direction,
    })
    : stored;

  return {
    phantom,
    skipped: false,
    storedRealized: stored,
    correctedRealized: Number.isFinite(corrected) ? corrected : 0,
    eventId: event?.event_id || null,
    tradeId: trade?.trade_id || event?.trade_id || null,
    ticker: trade?.ticker || null,
    ts: Number(event?.ts) || null,
  };
}

/**
 * Build scrub plan for trade_events + matching account_ledger rows.
 * Pure — caller executes against D1.
 */
export function buildPhantomTrimScrubPlan({ trades, trimEvents, ledgerRows }) {
  const tradeById = new Map((trades || []).map((t) => [String(t.trade_id), t]));
  const eventUpdates = [];
  const ledgerDeletes = [];

  for (const ev of (trimEvents || [])) {
    const trade = tradeById.get(String(ev.trade_id));
    if (!trade) continue;
    const cls = classifyPhantomTrimEvent(ev, trade);
    if (cls.skipped || !cls.phantom) continue;

    eventUpdates.push({
      event_id: cls.eventId,
      trade_id: cls.tradeId,
      ticker: cls.ticker,
      ts: cls.ts,
      storedRealized: cls.storedRealized,
      correctedRealized: cls.correctedRealized,
    });

    for (const row of (ledgerRows || [])) {
      if (String(row.position_id || "") !== String(cls.tradeId)) continue;
      if (Number(row.ts) !== Number(cls.ts)) continue;
      if (String(row.event_type || "").toUpperCase() !== "TRIM") continue;
      if (Math.abs(Number(row.realized_pnl) - cls.storedRealized) > 0.01) continue;
      ledgerDeletes.push({
        ledger_id: row.ledger_id,
        trade_id: cls.tradeId,
        ticker: cls.ticker,
        ts: cls.ts,
        storedRealized: Number(row.realized_pnl),
      });
    }
  }

  return { eventUpdates, ledgerDeletes };
}

/** SQL helpers for admin endpoint / script. */
export const SCRUB_SQL = {
  tradesByTickers: `
    SELECT trade_id, ticker, direction, entry_price, shares, trimmed_pct, status
      FROM trades
     WHERE UPPER(ticker) IN (?1)
  `,
  trimEvents: `
    SELECT event_id, trade_id, ts, type, price, qty_pct_delta, pnl_realized, reason
      FROM trade_events
     WHERE type = 'TRIM'
       AND trade_id IN (SELECT trade_id FROM trades WHERE UPPER(ticker) IN (?1))
  `,
  ledgerTrims: `
    SELECT ledger_id, position_id, ticker, ts, event_type, realized_pnl, note
      FROM account_ledger
     WHERE mode = 'trader'
       AND event_type = 'TRIM'
       AND UPPER(ticker) IN (?1)
  `,
};
