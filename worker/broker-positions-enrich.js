/**
 * Overlay live marks onto GET /timed/broker/positions items.
 *
 * Broker last_price / market_value / unrealized_pnl / day_pnl are the
 * account's own Webull (or IBKR) marks — not licensed TwelveData — so they
 * MUST survive even when canAccessLivePrices is false. TwelveData is only
 * used for the day-change % display, and never overwrites native UPL.
 *
 * Overnight, TwelveData zeros `dc`/`dp`. Do not turn that into a $0
 * "today's P&L" that lights up the KPI as if the session had printed.
 */

function finiteNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function overlayBrokerPositionMarks(item, { tdRow = null, pricesAllowed = false } = {}) {
  if (!item || typeof item !== "object") return item;
  const qty = Number(item.broker_qty) || 0;

  const brokerPx = finiteNum(item.last_price ?? item.price);
  if (brokerPx != null && brokerPx > 0) {
    item.price = brokerPx;
    item.last_price = brokerPx;
  }

  const brokerMv = finiteNum(item.market_value);
  if (brokerMv != null && brokerMv !== 0) {
    item.market_value = brokerMv;
  } else if (qty > 0 && Number(item.price) > 0) {
    item.market_value = qty * Number(item.price);
  }

  const nativeUpl = finiteNum(item.unrealized_pnl);
  const hadNativeUpl = nativeUpl != null;
  if (hadNativeUpl) {
    item.unrealized_pnl = nativeUpl;
    const pct = finiteNum(item.unrealized_pnl_pct);
    if (pct != null) {
      item.unrealized_pnl_pct = pct;
    } else if (Number(item.avg_cost) > 0 && qty > 0) {
      const basis = Number(item.avg_cost) * qty;
      if (basis !== 0) item.unrealized_pnl_pct = (nativeUpl / basis) * 100;
    }
  }

  const nativeDay = finiteNum(item.day_pnl);
  const hadNativeDay = nativeDay != null;
  if (hadNativeDay) {
    item.day_pnl = nativeDay;
    item.day_pnl_source = "broker";
  }

  if (pricesAllowed && tdRow && Number(tdRow.p) > 0) {
    if (!(Number(item.price) > 0)) {
      item.price = Number(tdRow.p);
      if (!(Number(item.market_value) > 0) && qty > 0) {
        item.market_value = qty * Number(item.price);
      }
    }
    const pc = finiteNum(tdRow.pc);
    if (pc != null && pc > 0) item.prev_close = pc;
    const dc = finiteNum(tdRow.dc);
    const dp = finiteNum(tdRow.dp);
    if (dc != null) item.day_change = dc;
    if (dp != null) item.day_change_pct = dp;
    // Skip dc === 0: post-midnight / weekend vendor zero, not a session print.
    if (!hadNativeDay && dc != null && dc !== 0 && qty > 0) {
      item.day_pnl = dc * qty;
      item.day_pnl_source = "td";
    }
  }

  if (!hadNativeUpl && qty > 0 && Number(item.price) > 0 && Number(item.avg_cost) > 0) {
    item.unrealized_pnl = (Number(item.price) - Number(item.avg_cost)) * qty;
    item.unrealized_pnl_pct = ((Number(item.price) / Number(item.avg_cost)) - 1) * 100;
    item.unrealized_pnl_source = "computed";
  }

  return item;
}

export function summarizeBrokerAccountMarks(items) {
  let value = 0;
  let open = 0;
  let day = 0;
  let hasOpen = false;
  let hasDay = false;
  for (const it of items || []) {
    const qty = Number(it.broker_qty) || 0;
    if (!(qty > 0.0001)) continue;
    const mv = finiteNum(it.market_value);
    if (mv != null && mv > 0) value += mv;
    else {
      const px = Number(it.price) > 0 ? Number(it.price) : Number(it.avg_cost);
      if (px > 0) value += px * qty;
    }
    const upl = finiteNum(it.unrealized_pnl);
    if (upl != null) {
      open += upl;
      hasOpen = true;
    }
    if (it.day_pnl_source && finiteNum(it.day_pnl) != null) {
      day += Number(it.day_pnl);
      hasDay = true;
    }
  }
  return {
    positions_value: value > 0 ? value : null,
    unrealized_pnl: hasOpen ? open : null,
    day_pnl: hasDay ? day : null,
    has_open_pnl: hasOpen,
    has_day_pnl: hasDay,
  };
}
