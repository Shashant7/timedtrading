// Dead-money flatten helpers (UNP 2026-07-15 false early_dead_money exit).
//
// Live kanban classification historically received getPositionContext() which
// carries SL/qty but NOT MFE/MAE/__tradeRef. early_dead_money then saw MFE=0
// on trades that had already trimmed green, and flattened the runner.

/** Peak favorable excursion % from position context and/or trade ref. */
export function resolveDeadMoneyMfePct(openPosition) {
  const candidates = [
    openPosition?.maxFavorableExcursion,
    openPosition?.max_favorable_excursion,
    openPosition?.mfePct,
    openPosition?.__tradeRef?.maxFavorableExcursion,
    openPosition?.__tradeRef?.max_favorable_excursion,
    openPosition?.__tradeRef?.mfePct,
  ];
  let best = 0;
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) best = Math.max(best, n);
  }
  return best;
}

/**
 * Enrich live D1 position context with open-trade MFE/MAE/trim/signals so
 * classifyKanbanStage matches the replay path (which already sets __tradeRef).
 */
export function enrichLiveOpenPositionContext(openPositionContext, openTrade) {
  if (!openTrade) return openPositionContext || null;
  const ctx = openPositionContext && typeof openPositionContext === "object"
    ? { ...openPositionContext }
    : {
      status: "OPEN",
      direction: openTrade.direction,
      entryPrice: openTrade.entryPrice ?? openTrade.entry_price,
      avgEntry: openTrade.entryPrice ?? openTrade.entry_price,
      entry_ts: Number(openTrade.entry_ts) || Number(openTrade.created_at) || 0,
      sl: openTrade.sl ?? openTrade.stop_loss ?? null,
    };
  const mfe = resolveDeadMoneyMfePct({ ...ctx, __tradeRef: openTrade });
  const maeRaw = [
    ctx.maxAdverseExcursion,
    ctx.max_adverse_excursion,
    openTrade.maxAdverseExcursion,
    openTrade.max_adverse_excursion,
    openTrade.maePct,
  ].map(Number).find((n) => Number.isFinite(n));
  ctx.maxFavorableExcursion = mfe;
  ctx.max_favorable_excursion = mfe;
  if (Number.isFinite(maeRaw)) {
    ctx.maxAdverseExcursion = maeRaw;
    ctx.max_adverse_excursion = maeRaw;
  }
  ctx.trimmedPct = Number(ctx.trimmedPct ?? openTrade.trimmedPct ?? openTrade.trimmed_pct) || 0;
  ctx.shares = Number(ctx.shares ?? ctx.total_shares ?? openTrade.shares ?? openTrade.qty) || 0;
  ctx.entrySignals = ctx.entrySignals || ctx.entry_signals
    || openTrade.entrySignals || openTrade.entry_signals || null;
  ctx.entryPath = ctx.entryPath || ctx.entry_path
    || openTrade.entryPath || openTrade.entry_path || null;
  ctx.entry_path = ctx.entryPath;
  ctx.__tradeRef = openTrade;
  return ctx;
}

/**
 * Phase-G.3 early dead-money: 4h+ market age, never reached mfeMax, currently
 * red by pnlMax. Never applies after a meaningful trim — that trade already
 * "worked" (UNP Jul 14/15: 65% trimmed green, then false flatten on runner).
 */
export function shouldEarlyDeadMoneyFlatten({
  enabled = true,
  positionAgeMarketMin = 0,
  ageMin = 240,
  mfePct = 0,
  mfeMaxPct = 0.5,
  pnlPct = 0,
  pnlMaxPct = -1.0,
  trimmedPct = 0,
  trimExemptPct = 0.25,
} = {}) {
  if (!enabled) return { flatten: false, reason: "disabled" };
  if ((Number(trimmedPct) || 0) >= (Number(trimExemptPct) || 0.25)) {
    return { flatten: false, reason: "already_trimmed" };
  }
  if ((Number(positionAgeMarketMin) || 0) < (Number(ageMin) || 240)) {
    return { flatten: false, reason: "too_young" };
  }
  if ((Number(mfePct) || 0) >= (Number(mfeMaxPct) || 0.5)) {
    return { flatten: false, reason: "had_mfe" };
  }
  if ((Number(pnlPct) || 0) > (Number(pnlMaxPct) || -1.0)) {
    return { flatten: false, reason: "pnl_ok" };
  }
  return { flatten: true, reason: "early_dead_money" };
}

/** Phase-E.2 F4 dead-money (24h+). Same trim exemption as early cut. */
export function shouldDeadMoneyFlatten({
  enabled = true,
  positionAgeMarketMin = 0,
  ageMin = 1440,
  mfePct = 0,
  mfeMaxPct = 1.0,
  pnlPct = 0,
  pnlMaxPct = -1.0,
  trimmedPct = 0,
  trimExemptPct = 0.25,
} = {}) {
  if (!enabled) return { flatten: false, reason: "disabled" };
  if ((Number(trimmedPct) || 0) >= (Number(trimExemptPct) || 0.25)) {
    return { flatten: false, reason: "already_trimmed" };
  }
  if ((Number(positionAgeMarketMin) || 0) < (Number(ageMin) || 1440)) {
    return { flatten: false, reason: "too_young" };
  }
  if ((Number(mfePct) || 0) >= (Number(mfeMaxPct) || 1.0)) {
    return { flatten: false, reason: "had_mfe" };
  }
  if ((Number(pnlPct) || 0) > (Number(pnlMaxPct) || -1.0)) {
    return { flatten: false, reason: "pnl_ok" };
  }
  return { flatten: true, reason: "dead_money" };
}
