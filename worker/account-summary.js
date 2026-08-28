// Account NAV — realized + open mark-to-market.
//
// `/timed/account-summary` is the single source for "is the model making
// money?" The weekly governor / edge scorecard stay closed-trade only
// (demotion must not chase open winners). This module is the bookkeeping
// layer: start cash + realized + open MTM = account value.

export const TRADER_START_CASH = 100000;
export const INVESTOR_START_CASH = 100000;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Flatten `timed:prices` (or a {SYM: {p}} map) into ticker → last price. */
export function priceMapFromTimedPrices(pricesRaw) {
  const priceMap = {};
  const blob = pricesRaw?.prices && typeof pricesRaw.prices === "object"
    ? pricesRaw.prices
    : (pricesRaw && typeof pricesRaw === "object" ? pricesRaw : {});
  for (const [sym, pObj] of Object.entries(blob)) {
    if (!sym || String(sym).startsWith("_")) continue;
    if (pObj && typeof pObj === "object") {
      priceMap[String(sym).toUpperCase()] = Number(pObj.p || pObj.price || pObj.latestTrade?.p) || 0;
    } else if (Number.isFinite(Number(pObj))) {
      priceMap[String(sym).toUpperCase()] = Number(pObj);
    }
  }
  return priceMap;
}

export function markTraderOpen(openTrades, priceMap = {}) {
  let unrealized = 0;
  let costBasis = 0;
  let markToMarket = 0;
  let openCount = 0;
  for (const t of openTrades || []) {
    const px = Number(priceMap[String(t.ticker || "").toUpperCase()]) || 0;
    const fullQty = Number(t.shares) || 0;
    const trimPct = Math.max(0, Math.min(1, Number(t.trimmed_pct) || 0));
    const qty = fullQty * (1 - trimPct);
    if (!(qty > 0)) continue;
    openCount += 1;
    const entry = Number(t.entry_price) || 0;
    const cb = entry * qty;
    const mtm = px * qty;
    const dir = String(t.direction || "").toUpperCase() === "SHORT" ? -1 : 1;
    unrealized += dir * (mtm - cb);
    costBasis += cb;
    markToMarket += mtm;
  }
  return {
    unrealized: round2(unrealized),
    costBasis: round2(costBasis),
    markToMarket: round2(markToMarket),
    openCount,
  };
}

export function markInvestorOpen(openPos, priceMap = {}) {
  let unrealized = 0;
  let costBasis = 0;
  let markToMarket = 0;
  let openCount = 0;
  for (const pos of openPos || []) {
    const px = Number(priceMap[String(pos.ticker || "").toUpperCase()]) || 0;
    const qty = Number(pos.total_shares) || 0;
    if (!(qty > 0)) continue;
    openCount += 1;
    const cb = Number(pos.cost_basis) || 0;
    const mtm = px * qty;
    unrealized += mtm - cb;
    costBasis += cb;
    markToMarket += mtm;
  }
  return {
    unrealized: round2(unrealized),
    costBasis: round2(costBasis),
    markToMarket: round2(markToMarket),
    openCount,
  };
}

export function assembleAccountSummary({
  mode,
  startCash,
  cash,
  totalRealized,
  unrealized,
  costBasis,
  markToMarket,
  openCount,
}) {
  const start = Number(startCash) || 0;
  const realized = Number(totalRealized) || 0;
  const open = Number(unrealized) || 0;
  const accountValue = start + realized + open;
  const totalPnl = realized + open;
  return {
    ok: true,
    mode,
    startCash: round2(start),
    cash: round2(cash),
    totalRealized: round2(realized),
    unrealized: round2(open),
    costBasis: round2(costBasis),
    markToMarket: round2(markToMarket),
    openCount: Number(openCount) || 0,
    accountValue: round2(accountValue),
    totalPnl: round2(totalPnl),
    growthPct: start > 0 ? round2((totalPnl / start) * 100) : 0,
  };
}

export function combineAccountBooks(trader, investor) {
  const t = trader || {};
  const i = investor || {};
  const startCash = (Number(t.startCash) || 0) + (Number(i.startCash) || 0);
  const totalRealized = (Number(t.totalRealized) || 0) + (Number(i.totalRealized) || 0);
  const unrealized = (Number(t.unrealized) || 0) + (Number(i.unrealized) || 0);
  const costBasis = (Number(t.costBasis) || 0) + (Number(i.costBasis) || 0);
  const markToMarket = (Number(t.markToMarket) || 0) + (Number(i.markToMarket) || 0);
  const cash = (Number(t.cash) || 0) + (Number(i.cash) || 0);
  const accountValue = (Number(t.accountValue) || 0) + (Number(i.accountValue) || 0);
  const totalPnl = totalRealized + unrealized;
  return {
    startCash: round2(startCash),
    cash: round2(cash),
    totalRealized: round2(totalRealized),
    unrealized: round2(unrealized),
    costBasis: round2(costBasis),
    markToMarket: round2(markToMarket),
    openCount: (Number(t.openCount) || 0) + (Number(i.openCount) || 0),
    accountValue: round2(accountValue),
    totalPnl: round2(totalPnl),
    growthPct: startCash > 0 ? round2((totalPnl / startCash) * 100) : 0,
  };
}

/**
 * Overlay today's open MTM onto an equity-curve series so the last point
 * matches account-summary (start + realized + unrealized) instead of
 * realized-only ledger walk.
 */
export function applyLiveMarkToEquityPoints(points, live, todayEt) {
  if (!Array.isArray(points) || !live || !todayEt) return points || [];
  const startCash = Number(live.startCash);
  const totalRealized = Number(live.totalRealized);
  const unrealized = Number(live.unrealized);
  if (![startCash, totalRealized, unrealized].every(Number.isFinite)) return points;
  const equity = round2(startCash + totalRealized + unrealized);
  const out = points.map((p) => ({ ...p }));
  let peak = startCash;
  for (const p of out) {
    if (p.date === todayEt) continue;
    if (Number(p.equity) > peak) peak = Number(p.equity);
  }
  if (equity > peak) peak = equity;
  const tip = {
    date: todayEt,
    equity,
    cash: Number.isFinite(Number(live.cash)) ? round2(live.cash) : equity,
    positionsValue: Number.isFinite(Number(live.markToMarket)) ? round2(live.markToMarket) : 0,
    openPositions: Number(live.openCount) || 0,
    dayPnl: 0,
    dayTrades: 0,
    drawdownPct: peak > 0 ? round2(((equity - peak) / peak) * 100) : 0,
    live_mark: true,
  };
  const last = out[out.length - 1];
  if (last && last.date === todayEt) {
    tip.dayPnl = Number(last.dayPnl) || 0;
    tip.dayTrades = Number(last.dayTrades) || 0;
    out[out.length - 1] = { ...last, ...tip };
  } else {
    out.push(tip);
  }
  return out;
}

export async function loadAccountBook(db, { mode, startCash, priceMap }) {
  const m = String(mode || "trader").toLowerCase() === "investor" ? "investor" : "trader";
  const start = Number(startCash) || (m === "investor" ? INVESTOR_START_CASH : TRADER_START_CASH);

  const latestRow = await db.prepare(
    "SELECT balance FROM account_ledger WHERE mode = ?1 ORDER BY ts DESC, ledger_id DESC LIMIT 1",
  ).bind(m).first();
  const cash = latestRow ? Number(latestRow.balance) : start;

  const pnlRow = await db.prepare(
    "SELECT SUM(realized_pnl) as total_realized FROM account_ledger WHERE mode = ?1",
  ).bind(m).first();
  let totalRealized = pnlRow ? Number(pnlRow.total_realized) || 0 : 0;

  if (totalRealized === 0 && m === "trader") {
    for (const tbl of ["trades", "positions"]) {
      try {
        const row = await db.prepare(
          `SELECT SUM(pnl) as total_pnl FROM ${tbl} WHERE status IN ('WIN','LOSS','FLAT') AND pnl IS NOT NULL`,
        ).first();
        if (row && Number(row.total_pnl)) {
          totalRealized = Number(row.total_pnl);
          break;
        }
      } catch (_) { /* table may not exist */ }
    }
  }

  let marked;
  if (m === "trader") {
    const openTrades = (await db.prepare(
      "SELECT trade_id, ticker, direction, entry_price, shares, notional, trimmed_pct FROM trades WHERE status IN ('OPEN', 'TP_HIT_TRIM')",
    ).all())?.results || [];
    marked = markTraderOpen(openTrades, priceMap);
  } else {
    try {
      const openPos = (await db.prepare(
        "SELECT id, ticker, total_shares, cost_basis, avg_entry FROM investor_positions WHERE status = 'OPEN'",
      ).all())?.results || [];
      marked = markInvestorOpen(openPos, priceMap);
    } catch {
      marked = { unrealized: 0, costBasis: 0, markToMarket: 0, openCount: 0 };
    }
  }

  return assembleAccountSummary({
    mode: m,
    startCash: start,
    cash,
    totalRealized,
    ...marked,
  });
}
