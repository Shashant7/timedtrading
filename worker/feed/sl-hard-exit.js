// Published stop-loss enforcement for live trade management.
// Stops are contractual with the user — breach must close unless the stop
// itself was explicitly moved (defend tighten), not merely deferred to Defend.

/** Authoritative published SL: positions row → trade row → entry history. */
export function resolvePublishedStopLoss(openPositionContext, openTrade) {
  const fromPos = Number(openPositionContext?.sl ?? openPositionContext?.stop_loss);
  if (Number.isFinite(fromPos) && fromPos > 0) return fromPos;

  const fromTrade = Number(openTrade?.sl ?? openTrade?.stop_loss);
  if (Number.isFinite(fromTrade) && fromTrade > 0) return fromTrade;

  const history = Array.isArray(openTrade?.history) ? openTrade.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    const fromHist = Number(row?.sl_price ?? row?.sl ?? row?.stop_loss);
    if (Number.isFinite(fromHist) && fromHist > 0) return fromHist;
  }
  return null;
}

/** Worst-case print vs published stop (extended print when session closed). */
export function resolvePriceForStopCheck(tickerData, pxNow, direction, marketOpen) {
  const base = Number(pxNow);
  if (!(base > 0)) return base;
  if (marketOpen) return base;

  const ext = Number(
    tickerData?._ah_price ?? tickerData?.ahp ?? tickerData?.extended_price,
  );
  if (!(ext > 0)) return base;

  const dir = String(direction || "").toUpperCase();
  if (dir === "LONG") return Math.min(base, ext);
  if (dir === "SHORT") return Math.max(base, ext);
  return base;
}

export function isStopLossBreached(direction, pxNow, sl) {
  const price = Number(pxNow);
  const stop = Number(sl);
  const dir = String(direction || "").toUpperCase();
  if (!(price > 0) || !(stop > 0)) return false;
  if (dir === "LONG") return price <= stop;
  if (dir === "SHORT") return price >= stop;
  return false;
}

export function stopLossOvershootPct(direction, pxNow, sl) {
  const price = Number(pxNow);
  const stop = Number(sl);
  const dir = String(direction || "").toUpperCase();
  if (!(price > 0) || !(stop > 0)) return 0;
  if (dir === "LONG") return ((stop - price) / stop) * 100;
  if (dir === "SHORT") return ((price - stop) / stop) * 100;
  return 0;
}

/**
 * When price is past the published stop, force a hard close on this tick —
 * regardless of kanban lane (defend vs exit) or soft-fuse deferrals.
 */
export function applySlHardExitSafetyNet({
  openTrade,
  openPositionContext,
  direction,
  pxNow,
  exitReasonRaw,
  fuseExitFired,
  tickerData,
  marketOpen = true,
}) {
  const out = {
    exitReasonRaw,
    fuseExitFired,
    tickerData,
    slHardClose: false,
    slCheck: null,
    slBreached: false,
    slCheckPrice: Number(pxNow),
  };
  if (!openTrade) return out;

  const sl = resolvePublishedStopLoss(openPositionContext, openTrade);
  if (!(Number.isFinite(sl) && sl > 0)) return out;

  const dir = String(openTrade.direction || direction || "").toUpperCase();
  const checkPx = resolvePriceForStopCheck(tickerData, pxNow, dir, marketOpen);
  out.slCheck = sl;
  out.slCheckPrice = checkPx;

  if (!isStopLossBreached(dir, checkPx, sl)) return out;

  out.slBreached = true;
  out.slHardClose = true;
  const overshootPct = stopLossOvershootPct(dir, checkPx, sl);
  const origReason = exitReasonRaw;

  out.exitReasonRaw = "sl_breached";
  out.tickerData = {
    ...tickerData,
    __exit_reason: "sl_breached",
    __sl_safety_net: {
      original_reason: origReason,
      sl,
      price: checkPx,
      headline_price: Number(pxNow),
      overshoot_pct: Number(overshootPct.toFixed(3)),
      cleared_fuse_exit_fired: fuseExitFired === true,
      cleared_force_defend_stage: tickerData?.__force_defend_stage === true,
      cleared_defend_reason: tickerData?.__defend_reason || null,
    },
  };

  if (tickerData?.__force_defend_stage === true) {
    out.tickerData.__force_defend_stage = false;
    out.tickerData.__defend_reason = null;
  }
  out.fuseExitFired = false;
  return out;
}

/** Backfill missing SL on position context + open trade from published sources. */
export function ensurePublishedStopOnContext(openPositionContext, openTrade) {
  const sl = resolvePublishedStopLoss(openPositionContext, openTrade);
  if (!(Number.isFinite(sl) && sl > 0)) {
    return { openPositionContext, openTrade, sl: null };
  }

  let ctx = openPositionContext;
  if (ctx && !(Number(ctx.sl) > 0)) {
    ctx = { ...ctx, sl, stop_loss: sl };
  } else if (!ctx && openTrade) {
    ctx = {
      status: "OPEN",
      direction: openTrade.direction,
      sl,
      stop_loss: sl,
      entryPrice: openTrade.entryPrice,
      avgEntry: openTrade.entryPrice ?? openTrade.avgEntry,
      entry_ts: Number(openTrade.entry_ts) || Number(openTrade.created_at) || 0,
      __tradeRef: openTrade,
    };
  }

  let trade = openTrade;
  if (trade && !(Number(trade.sl) > 0)) {
    trade = { ...trade, sl, stop_loss: sl };
  }

  return { openPositionContext: ctx, openTrade: trade, sl };
}
