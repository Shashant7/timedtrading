/**
 * Day Trader portfolio book — durable ledger + equity curve.
 *
 * Index option day trades historically lived only in the short KV action
 * ring (`timed:opt-dt-actions`, 7d / 500). Short Term and Long Term already
 * have `account_ledger` + `portfolio_snapshots`. This module gives Day
 * Trader the same separation:
 *
 *   - mode = "day_trade" on account_ledger
 *   - start cash = model sleeve ($25k)
 *   - equity = start + cumulative realized (closed rounds)
 *   - open MTM overlays the tip the same way ST/LT do
 *
 * Closed-round P&L must match `closedTradesFromPaperActions` /
 * `scripts/replay-day-trades.mjs` (TRIM proceeds included).
 */

export const DAY_TRADE_LEDGER_MODE = "day_trade";
export const DAY_TRADE_START_CASH = 25_000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function nyDateKey(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(t));
  } catch (_) {
    return new Date(t).toISOString().slice(0, 10);
  }
}

/** Filter closed paper trades to the Index Day Trade lane only. */
export function filterDayTradeClosedTrades(trades = []) {
  return (Array.isArray(trades) ? trades : []).filter((t) => {
    const lane = String(t?._lane || t?._paper_lane || "").toLowerCase();
    return lane === "index_day_trade" || lane === "day_trade" || lane === "index_dt";
  });
}

/**
 * Build daily equity-curve points from closed Day Trade rounds.
 * Pure — no I/O. Realized P&L accumulates into startCash.
 *
 * @param {Array} closedTrades — rows shaped like closedTradesFromPaperActions
 * @param {{startCash?:number, since?:string, until?:string, openUnrealized?:number, openPositions?:number}} opts
 */
export function buildDayTradeEquityPoints(closedTrades = [], opts = {}) {
  const startCash = Number.isFinite(Number(opts.startCash))
    ? Number(opts.startCash)
    : DAY_TRADE_START_CASH;
  const since = String(opts.since || "2020-01-01").slice(0, 10);
  const until = String(opts.until || "2099-12-31").slice(0, 10);
  const openUnrealized = Number(opts.openUnrealized) || 0;
  const openPositions = Number(opts.openPositions) || 0;

  const dayTradesOnly = filterDayTradeClosedTrades(closedTrades);
  const byDay = new Map(); // date -> { dayPnl, dayTrades, equityAfter }

  let cumulative = 0;
  const ordered = [...dayTradesOnly].sort(
    (a, b) => (Number(a.exit_ts) || 0) - (Number(b.exit_ts) || 0),
  );

  for (const t of ordered) {
    const date = nyDateKey(t.exit_ts);
    if (!date) continue;
    const pnl = num(t.realized_pnl ?? t.realizedPnl ?? t.pnl) ?? 0;
    cumulative += pnl;
    if (date < since || date > until) continue;
    let slot = byDay.get(date);
    if (!slot) {
      slot = { dayPnl: 0, dayTrades: 0, equityAfter: startCash };
      byDay.set(date, slot);
    }
    slot.dayPnl += pnl;
    slot.dayTrades += 1;
    slot.equityAfter = startCash + cumulative;
  }

  // Carry equity through days with no trades so the curve is continuous
  // from first activity (or since) when callers want a dense series —
  // we only emit days that had closes, plus a tip for open MTM.
  let peakEquity = startCash;
  const points = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, s]) => {
      const eq = Math.round(s.equityAfter * 100) / 100;
      if (eq > peakEquity) peakEquity = eq;
      const drawdown = peakEquity > 0 ? (eq - peakEquity) / peakEquity : 0;
      return {
        date,
        equity: eq,
        cash: eq,
        positionsValue: 0,
        openPositions: 0,
        dayPnl: Math.round(s.dayPnl * 100) / 100,
        dayTrades: s.dayTrades,
        drawdownPct: Math.round(drawdown * 10000) / 100,
      };
    });

  // Seed a start point so a single-day book still charts.
  if (points.length === 1) {
    const first = points[0].date;
    const seedDate = since < first ? since : first;
    if (seedDate !== first) {
      points.unshift({
        date: seedDate,
        equity: startCash,
        cash: startCash,
        positionsValue: 0,
        openPositions: 0,
        dayPnl: 0,
        dayTrades: 0,
        drawdownPct: 0,
      });
    }
  } else if (points.length === 0 && (openPositions > 0 || Math.abs(openUnrealized) > 0.01)) {
    const today = nyDateKey(Date.now()) || new Date().toISOString().slice(0, 10);
    points.push({
      date: today,
      equity: startCash,
      cash: startCash,
      positionsValue: 0,
      openPositions: 0,
      dayPnl: 0,
      dayTrades: 0,
      drawdownPct: 0,
    });
  }

  // Overlay open MTM on the tip (same contract as ST/LT live_mark).
  if (points.length > 0 && (Math.abs(openUnrealized) > 0.005 || openPositions > 0)) {
    const tip = points[points.length - 1];
    const marked = Math.round((tip.equity + openUnrealized) * 100) / 100;
    if (marked > peakEquity) peakEquity = marked;
    const drawdown = peakEquity > 0 ? (marked - peakEquity) / peakEquity : 0;
    points[points.length - 1] = {
      ...tip,
      equity: marked,
      positionsValue: Math.round(openUnrealized * 100) / 100,
      openPositions,
      drawdownPct: Math.round(drawdown * 10000) / 100,
      live_mark: true,
    };
  }

  return points;
}

/** Summary KPIs for a Day Trade equity series. */
export function summarizeDayTradeEquity(points = [], {
  startCash = DAY_TRADE_START_CASH,
  closedTrades = [],
  openUnrealized = 0,
  openPositions = 0,
} = {}) {
  const pts = Array.isArray(points) ? points : [];
  const endEquity = pts.length
    ? Number(pts[pts.length - 1].equity)
    : startCash + (Number(openUnrealized) || 0);
  let cumRealized = 0;
  let peak = startCash;
  let maxDd = 0;
  for (const p of pts) {
    cumRealized += Number(p.dayPnl) || 0;
    const eq = Number(p.equity) || startCash;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? (eq - peak) / peak : 0;
    if (dd < maxDd) maxDd = dd;
  }
  // Prefer summing closed trades when present — dayPnl on live_mark tip
  // may exclude open overlay from realized.
  const dtClosed = filterDayTradeClosedTrades(closedTrades);
  if (dtClosed.length) {
    cumRealized = dtClosed.reduce(
      (s, t) => s + (num(t.realized_pnl ?? t.realizedPnl ?? t.pnl) || 0),
      0,
    );
  }
  let wins = 0;
  let losses = 0;
  for (const t of dtClosed) {
    const s = String(t.status || "").toUpperCase();
    const pnl = num(t.realized_pnl ?? t.realizedPnl ?? t.pnl) || 0;
    if (s === "WIN" || pnl > 0) wins++;
    else if (s === "LOSS" || pnl < 0) losses++;
  }
  const totalReturnPct = startCash > 0
    ? Math.round(((endEquity - startCash) / startCash) * 10000) / 100
    : 0;
  return {
    startCash,
    endEquity: Math.round(endEquity * 100) / 100,
    totalReturnPct,
    maxDrawdownPct: Math.round(maxDd * 10000) / 100,
    sharpe: null,
    totalDays: pts.length,
    cumRealized: Math.round(cumRealized * 100) / 100,
    unrealized: Math.round((Number(openUnrealized) || 0) * 100) / 100,
    openPositions: Number(openPositions) || 0,
    closedStats: {
      closed: dtClosed.length,
      wins,
      losses,
    },
  };
}

/**
 * Ledger row payload for one closed Day Trade round.
 * cash_delta = realized_pnl (sleeve book tracks realized, not premium debit).
 */
export function dayTradeCloseLedgerRow({
  trade,
  balanceAfter,
  startCash = DAY_TRADE_START_CASH,
} = {}) {
  if (!trade) return null;
  const ts = Number(trade.exit_ts) || Date.now();
  const pnl = num(trade.realized_pnl ?? trade.realizedPnl ?? trade.pnl) ?? 0;
  const bal = Number.isFinite(Number(balanceAfter))
    ? Number(balanceAfter)
    : startCash + pnl;
  const signalId = String(trade.signal_id || trade.trade_id || trade.id || "").trim();
  if (!signalId) return null;
  return {
    mode: DAY_TRADE_LEDGER_MODE,
    ts,
    event_type: String(trade.close_event || "EXIT").toUpperCase() === "STOP" ? "EXIT" : "EXIT",
    position_id: `${signalId}:${ts}`,
    ticker: String(trade.ticker || "").toUpperCase() || null,
    direction: "LONG",
    qty: num(trade.contracts ?? trade.qty),
    price: num(trade.exit_price ?? trade.exitPrice),
    cash_delta: pnl,
    realized_pnl: pnl,
    balance: bal,
    note: `day_trade:${trade.close_event || "exit"}:${trade.reason || ""}`.slice(0, 200),
  };
}

/**
 * Idempotent backfill: write any closed Day Trade rounds missing from
 * account_ledger. Returns { inserted, skipped, errors }.
 *
 * @param {object} env — needs env.DB; optional insertFn for tests
 */
export async function syncDayTradeLedgerFromClosedTrades(env, closedTrades = [], {
  insertFn = null,
  listExistingIdsFn = null,
  startCash = DAY_TRADE_START_CASH,
} = {}) {
  const trades = filterDayTradeClosedTrades(closedTrades)
    .slice()
    .sort((a, b) => (Number(a.exit_ts) || 0) - (Number(b.exit_ts) || 0));
  if (!trades.length) return { inserted: 0, skipped: 0, errors: 0 };

  const db = env?.DB;
  let existing = new Set();
  if (typeof listExistingIdsFn === "function") {
    existing = new Set(await listExistingIdsFn());
  } else if (db) {
    try {
      const rows = (await db.prepare(
        `SELECT position_id FROM account_ledger WHERE mode = ?1`,
      ).bind(DAY_TRADE_LEDGER_MODE).all())?.results || [];
      for (const r of rows) {
        if (r?.position_id) existing.add(String(r.position_id));
      }
    } catch (_) { /* schema may not exist yet — inserts will ensure */ }
  }

  let balance = startCash;
  // Reconstruct balance from already-persisted rows when possible.
  if (db && existing.size) {
    try {
      const row = await db.prepare(
        `SELECT COALESCE(SUM(cash_delta), 0) AS s FROM account_ledger WHERE mode = ?1`,
      ).bind(DAY_TRADE_LEDGER_MODE).first();
      balance = startCash + (Number(row?.s) || 0);
    } catch (_) { /* keep startCash */ }
  }

  const insert = typeof insertFn === "function"
    ? insertFn
    : async (row) => {
      if (!db) return { ok: false, skipped: true };
      // Prefer the caller's insertFn (wraps d1InsertLedgerEntry). Inline
      // fallback keeps sync usable from tests / thin workers.
      await db.prepare(
        `INSERT INTO account_ledger (mode, ts, event_type, position_id, ticker, direction, qty, price, cash_delta, realized_pnl, balance, note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(
        row.mode, row.ts, row.event_type, row.position_id, row.ticker,
        row.direction, row.qty, row.price, row.cash_delta, row.realized_pnl,
        row.balance, row.note,
      ).run();
      return { ok: true };
    };

  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  for (const t of trades) {
    const ts = Number(t.exit_ts) || 0;
    const signalId = String(t.signal_id || t.trade_id || t.id || "").trim();
    const pid = `${signalId}:${ts}`;
    if (existing.has(pid)) {
      skipped++;
      continue;
    }
    const pnl = num(t.realized_pnl ?? t.realizedPnl ?? t.pnl) ?? 0;
    balance += pnl;
    const row = dayTradeCloseLedgerRow({ trade: t, balanceAfter: balance, startCash });
    if (!row) {
      skipped++;
      continue;
    }
    try {
      const r = await insert(row);
      if (r?.ok || r?.deduped) {
        inserted++;
        existing.add(pid);
      } else {
        errors++;
        balance -= pnl; // roll back local running total on failed write
      }
    } catch (_) {
      errors++;
      balance -= pnl;
    }
  }
  return { inserted, skipped, errors };
}

/**
 * Record one live close into the Day Trader ledger (call from STOP/EXIT path).
 */
export async function recordDayTradeCloseToLedger(env, trade, {
  insertFn = null,
  startCash = DAY_TRADE_START_CASH,
} = {}) {
  if (!trade || !env) return { ok: false, skipped: true };
  const db = env.DB;
  let balance = startCash;
  if (db) {
    try {
      const row = await db.prepare(
        `SELECT COALESCE(SUM(cash_delta), 0) AS s FROM account_ledger WHERE mode = ?1`,
      ).bind(DAY_TRADE_LEDGER_MODE).first();
      balance = startCash + (Number(row?.s) || 0);
    } catch (_) { /* first write */ }
  }
  const pnl = num(trade.realized_pnl ?? trade.realizedPnl ?? trade.pnl) ?? 0;
  const row = dayTradeCloseLedgerRow({
    trade,
    balanceAfter: balance + pnl,
    startCash,
  });
  if (!row) return { ok: false, skipped: true, reason: "no_row" };

  if (typeof insertFn === "function") {
    return insertFn(row);
  }
  if (!db) return { ok: false, skipped: true, reason: "no_db" };
  try {
    await db.prepare(
      `INSERT INTO account_ledger (mode, ts, event_type, position_id, ticker, direction, qty, price, cash_delta, realized_pnl, balance, note)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      row.mode, row.ts, row.event_type, row.position_id, row.ticker,
      row.direction, row.qty, row.price, row.cash_delta, row.realized_pnl,
      row.balance, row.note,
    ).run();
    return { ok: true };
  } catch (err) {
    // Duplicate position_id races are fine — treat as success.
    if (String(err?.message || err).includes("UNIQUE")) return { ok: true, deduped: true };
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  }
}
