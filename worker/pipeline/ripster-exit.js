// worker/pipeline/ripster-exit.js
// Frozen A/B reference: Pure ripster cloud exit engine.
// Identical to ripster cloud exits in classifyKanbanStage.

export function evaluateExit(ctx, position) {
  const d = ctx.raw;
  if (!position || position.status !== "OPEN") return null;
  if (!ctx.config.ripsterTuneV2) return null;

  const direction = String(position.direction || "").toUpperCase();
  const entryPrice = Number(position.entryPrice || position.avgEntry);
  const entryTs = Number(position.entry_ts || position.created_at) || 0;
  const currentPrice = ctx.price;
  const now = ctx.asOfTs;
  const positionAgeMin = entryTs > 0 ? (now - entryTs) / (1000 * 60) : 999;
  const trimmedPct = clamp(Number(position.trimmedPct ?? position.trimmed_pct ?? 0), 0, 1);
  const mfePct = Number(position.maxFavorableExcursion ?? position.mfePct) || 0;

  let pnlPct = 0;
  if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(currentPrice)) {
    pnlPct = direction === "LONG"
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;
  }

  const pdzZone = String(d?.pdz_zone_D || "unknown");
  const inExtended = (direction === "LONG" && (pdzZone === "premium" || pdzZone === "premium_approach"))
    || (direction === "SHORT" && (pdzZone === "discount" || pdzZone === "discount_approach"));
  const inFavorable = (direction === "LONG" && (pdzZone === "discount" || pdzZone === "discount_approach"))
    || (direction === "SHORT" && (pdzZone === "premium" || pdzZone === "premium_approach"));

  const tfTech = (key) => d?.tf_tech?.[key] || null;
  const rt10 = tfTech("10")?.ripster;
  const rt30 = tfTech("30")?.ripster;
  const rt1H = tfTech("1H")?.ripster;
  if (!rt10) return null;

  const c5_12 = rt10.c5_12;
  const c34_50_10 = rt10.c34_50;
  const c34_50_1H = rt1H?.c34_50;
  const c72_89_1H = rt1H?.c72_89;

  const baseDebounceBars = Math.max(1, Number(d?._env?._ripsterExitDebounceBars) || 2);
  const debounceBars = inExtended ? Math.max(1, baseDebounceBars - 1)
    : inFavorable ? baseDebounceBars + 1 : baseDebounceBars;

  const lose5_12 = direction === "LONG"
    ? !!(c5_12?.crossDn || (c5_12?.bear && c5_12?.below))
    : !!(c5_12?.crossUp || (c5_12?.bull && c5_12?.above));

  const lose34_50 = direction === "LONG"
    ? !!((c34_50_10?.bear || c34_50_10?.below) && (c34_50_1H?.bear || c34_50_1H?.below))
    : !!((c34_50_10?.bull || c34_50_10?.above) && (c34_50_1H?.bull || c34_50_1H?.above));

  const prev5 = Math.max(Number(position.ripster_pending_5_12) || 0, Number(d?.__ripster_pending_5_12) || 0);
  const prev34 = Math.max(Number(position.ripster_pending_34_50) || 0, Number(d?.__ripster_pending_34_50) || 0);
  const pending5 = lose5_12 ? prev5 + 1 : 0;
  const pending34 = lose34_50 ? prev34 + 1 : 0;
  position.ripster_pending_5_12 = pending5;
  position.ripster_pending_34_50 = pending34;
  if (d) { d.__ripster_pending_5_12 = pending5; d.__ripster_pending_34_50 = pending34; }

  if (positionAgeMin >= 30 && lose5_12) {
    if (pending5 < debounceBars) return res("defend", "ripster_5_12_pending", "ripster_cloud");
    if (pnlPct > 0.4 && trimmedPct < 0.33) return res("trim", "ripster_5_12_defend_trim", "ripster_cloud");
    return res("defend", "ripster_5_12_lost_confirmed", "ripster_cloud");
  }

  if (positionAgeMin >= 60 && lose34_50) {
    if (pending34 < Math.max(2, debounceBars)) return res("defend", "ripster_34_50_pending", "ripster_cloud");
    return res("exit", "ripster_34_50_lost_mtf", "ripster_cloud");
  }

  if (direction === "SHORT" && positionAgeMin >= 20) {
    const ema10 = tfTech("10")?.ema || {};
    const ema30 = tfTech("30")?.ema || {};
    const below10m21 = Number.isFinite(ema10.e21) ? currentPrice <= Number(ema10.e21) : true;
    const below30m21 = Number.isFinite(ema30.e21) ? currentPrice <= Number(ema30.e21) : true;
    const holdPivotShort = below10m21 && below30m21;
    if (!holdPivotShort && (c5_12?.bull || c5_12?.above || c34_50_10?.bull || rt30?.c5_12?.bull)) {
      return res("exit", "ripster_short_pivot_reclaimed", "ripster_cloud");
    }
  }

  // PDZ-enhanced signals
  const lost72_89_1H = direction === "LONG"
    ? !!(c72_89_1H?.bear || c72_89_1H?.below)
    : !!(c72_89_1H?.bull || c72_89_1H?.above);
  const pdzMinGreen = (inExtended && positionAgeMin >= 360) ? 360 : 720;

  if (lost72_89_1H && positionAgeMin >= pdzMinGreen && pnlPct > 0) {
    if (trimmedPct < 0.5 && mfePct >= 2.0) return res("trim", "ripster_72_89_1h_trim", "ripster_pdz");
    return res("exit", "ripster_72_89_1h_structural_break", "ripster_pdz");
  }

  const ema30_9 = Number(tfTech("30")?.ema?.e9);
  const trail30m9 = direction === "LONG"
    ? (Number.isFinite(ema30_9) && currentPrice < ema30_9)
    : (Number.isFinite(ema30_9) && currentPrice > ema30_9);
  if (inExtended && trail30m9 && positionAgeMin >= 120 && pnlPct > 0.3) {
    if (trimmedPct < 0.5 && mfePct >= 2.0) return res("trim", "ripster_30m_9ema_trail_trim", "ripster_pdz");
    if (mfePct >= 3.0) return res("exit", "ripster_30m_9ema_trail_exit", "ripster_pdz");
  }

  if (inExtended && mfePct >= 2.0 && positionAgeMin >= pdzMinGreen && trimmedPct < 0.33 && pnlPct > 0.5) {
    return res("trim", "ripster_pdz_mfe_trim", "ripster_pdz");
  }

  return null;
}

function res(stage, reason, family) { return { stage, reason, family, metadata: {} }; }
function clamp(x, lo, hi) { const n = Number(x); return !Number.isFinite(n) ? lo : Math.max(lo, Math.min(hi, n)); }
