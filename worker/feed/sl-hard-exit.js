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

function pushCandidate(cands, v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) cands.push(n);
}

/**
 * Every print we might use for stop enforcement — plus PnL-implied marks
 * when headline price lags (NVDA-class: px ~200 while market ~194).
 */
export function collectStopCheckPriceCandidates(tickerData, pxNow, openTrade = null, openPositionContext = null) {
  const cands = [];
  pushCandidate(cands, pxNow);
  if (tickerData && typeof tickerData === "object") {
    pushCandidate(cands, tickerData.price);
    pushCandidate(cands, tickerData._live_price);
    pushCandidate(cands, tickerData.close);
    pushCandidate(cands, tickerData._ah_price);
    pushCandidate(cands, tickerData.ahp);
    pushCandidate(cands, tickerData.extended_price);
    pushCandidate(cands, tickerData.ah_price);
  }

  const entryPx = Number(
    openTrade?.entryPrice ?? openTrade?.entry_price
    ?? openPositionContext?.entryPrice ?? openPositionContext?.avgEntry,
  );
  const dir = String(openTrade?.direction ?? openPositionContext?.direction ?? tickerData?.direction ?? "LONG").toUpperCase();

  const pnlSources = [
    openTrade?.pnlPct,
    openTrade?.pnl_pct,
    tickerData?.__exit_meta?.pnl_pct,
    tickerData?.__exit_doctrine?.pnl,
    openPositionContext?.maxAdverseExcursion,
    openPositionContext?.max_adverse_excursion,
    openTrade?.maxAdverseExcursion,
    openTrade?.max_adverse_excursion,
  ];
  for (const raw of pnlSources) {
    const pnl = Number(raw);
    if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(pnl)) continue;
    if (dir === "LONG") pushCandidate(cands, entryPx * (1 + pnl / 100));
    else if (dir === "SHORT") pushCandidate(cands, entryPx * (1 - pnl / 100));
  }

  return cands;
}

/** Worst-case print vs published stop — always conservative for the direction. */
export function resolvePriceForStopCheck(tickerData, pxNow, direction, marketOpen, openTrade = null, openPositionContext = null) {
  void marketOpen; // kept for call-site compatibility; session no longer gates candidate set
  const cands = collectStopCheckPriceCandidates(tickerData, pxNow, openTrade, openPositionContext);
  if (cands.length === 0) return Number(pxNow);
  const dir = String(direction || "").toUpperCase();
  if (dir === "LONG") return Math.min(...cands);
  if (dir === "SHORT") return Math.max(...cands);
  return cands[0];
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
 * Fetch a fresh live quote when headline price is missing or inconsistent
 * with loss / stop proximity (prevents NVDA-style stale ~200 vs ~194 prints).
 */
export function shouldRefreshQuoteForStopCheck({
  direction,
  sl,
  checkPx,
  entryPx,
  pxNow,
  pnlPct,
  doctrinePnlPct,
  tickerData,
  openTrade,
  openPositionContext,
}) {
  if (!(Number.isFinite(sl) && sl > 0)) return false;
  const dir = String(direction || "LONG").toUpperCase();
  const headline = Number(pxNow);
  const nearStopPct = 0.02;

  if (!Number.isFinite(headline) || headline <= 0) return true;

  if (dir === "LONG") {
    if (checkPx <= sl) return true;
    if (checkPx <= sl * (1 + nearStopPct)) return true;
  } else if (dir === "SHORT") {
    if (checkPx >= sl) return true;
    if (checkPx >= sl * (1 - nearStopPct)) return true;
  }

  const entry = Number(entryPx);
  if (!(Number.isFinite(entry) && entry > 0)) return false;

  const impliedCandidates = collectStopCheckPriceCandidates(
    tickerData,
    pxNow,
    openTrade,
    openPositionContext,
  ).filter((p) => p !== headline && p !== checkPx);

  for (const implied of impliedCandidates) {
    if (dir === "LONG" && implied <= sl && checkPx > sl) return true;
    if (dir === "SHORT" && implied >= sl && checkPx < sl) return true;
  }

  const lossPct = Number.isFinite(Number(pnlPct)) ? Number(pnlPct)
    : Number.isFinite(Number(doctrinePnlPct)) ? Number(doctrinePnlPct) : null;
  if (lossPct != null && lossPct <= -2) {
    const implied = dir === "LONG" ? entry * (1 + lossPct / 100) : entry * (1 - lossPct / 100);
    if (dir === "LONG" && implied <= sl && checkPx > sl) return true;
    if (dir === "SHORT" && implied >= sl && checkPx < sl) return true;
  }

  return false;
}

export function priceDivergencePct(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return 0;
  return (Math.abs(x - y) / y) * 100;
}

/**
 * Fetch a fresh live quote when competing price sources disagree during
 * open-trade management (GEV 2026-06-24: scoring bundle printed ~$1078
 * while timed:prices / the market were ~$1045, triggering a false
 * BREAKEVEN defend).
 */
export function shouldRefreshQuoteForTradeMgmt({
  bundlePx,
  pfPx,
  pfTickFresh,
  pxNow,
  recentAdvisoryPx,
  minDivergencePct = 1.5,
} = {}) {
  const minDiv = Number(minDivergencePct) || 1.5;

  if (Number.isFinite(bundlePx) && bundlePx > 0 && Number.isFinite(pfPx) && pfPx > 0) {
    if (priceDivergencePct(bundlePx, pfPx) > minDiv) return "bundle_vs_feed";
  }

  if (Number.isFinite(pxNow) && pxNow > 0 && Number.isFinite(recentAdvisoryPx) && recentAdvisoryPx > 0) {
    if (priceDivergencePct(pxNow, recentAdvisoryPx) > minDiv) return "px_vs_recent_advisory";
  }

  if (Number.isFinite(pfPx) && pfPx > 0 && pfTickFresh === false) {
    return "feed_tick_stale";
  }

  if (!(Number.isFinite(pfPx) && pfPx > 0) && Number.isFinite(bundlePx) && bundlePx > 0) {
    return "missing_feed_row";
  }

  return null;
}

export function mergeFreshQuoteIntoTickerData(tickerData, freshPx, meta = {}) {
  if (!tickerData || typeof tickerData !== "object") return tickerData;
  const px = Number(freshPx);
  if (!(px > 0)) return tickerData;
  tickerData.price = px;
  tickerData._live_price = px;
  tickerData._sl_fresh_quote = {
    ...meta,
    fresh_price: px,
    fetched_at: Date.now(),
  };
  const pc = Number(tickerData.prev_close);
  if (Number.isFinite(pc) && pc > 0) {
    tickerData.day_change = px - pc;
    tickerData.day_change_pct = ((px - pc) / pc) * 100;
  }
  return tickerData;
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
  const checkPx = resolvePriceForStopCheck(
    tickerData,
    pxNow,
    dir,
    marketOpen,
    openTrade,
    openPositionContext,
  );
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
      price_candidates: collectStopCheckPriceCandidates(tickerData, pxNow, openTrade, openPositionContext),
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
    return { openPositionContext, openTrade, sl: null, slBackfilled: false };
  }

  let ctx = openPositionContext;
  let trade = openTrade;
  let slBackfilled = false;

  if (ctx && !(Number(ctx.sl) > 0)) {
    ctx = { ...ctx, sl, stop_loss: sl };
    slBackfilled = true;
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
    slBackfilled = true;
  }

  if (trade && !(Number(trade.sl) > 0)) {
    trade = { ...trade, sl, stop_loss: sl };
    slBackfilled = true;
  }

  return { openPositionContext: ctx, openTrade: trade, sl, slBackfilled };
}
