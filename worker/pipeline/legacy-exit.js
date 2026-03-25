// worker/pipeline/legacy-exit.js
// Frozen A/B reference: Legacy phase/regime/state-based exit engine.
// Includes: regime reversal, SL, max_loss, DOA, bias flip, trim, defend.

export function evaluateExit(ctx, position) {
  const d = ctx.raw;
  if (!position || position.status !== "OPEN") return null;

  const direction = String(position.direction || "").toUpperCase();
  const entryPrice = Number(position.entryPrice || position.avgEntry);
  const entryTs = Number(position.entry_ts || position.created_at) || 0;
  const currentPrice = ctx.price;
  const now = ctx.asOfTs;
  const positionAgeMin = entryTs > 0 ? (now - entryTs) / (1000 * 60) : 999;
  const mfePct = Number(position.maxFavorableExcursion ?? position.mfePct) || 0;

  let pnlPct = 0;
  if (Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(currentPrice)) {
    pnlPct = direction === "LONG"
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;
  }

  const pdzZone = String(d?.pdz_zone_D || "unknown");
  const inFavorable = (direction === "LONG" && (pdzZone === "discount" || pdzZone === "discount_approach"))
    || (direction === "SHORT" && (pdzZone === "premium" || pdzZone === "premium_approach"));
  const inExtended = (direction === "LONG" && (pdzZone === "premium" || pdzZone === "premium_approach"))
    || (direction === "SHORT" && (pdzZone === "discount" || pdzZone === "discount_approach"));

  const regimeDaily = Number(d?.ema_regime_daily) || 0;
  const regimeConfirms = (direction === "LONG" && regimeDaily >= 1) || (direction === "SHORT" && regimeDaily <= -1);

  // Regime reversal
  const daMinH = Number(ctx.config.deepAudit?.deep_audit_min_hold_regime_exit_hours) || 0;
  if (positionAgeMin >= Math.max(240, daMinH * 60) && !regimeConfirms) {
    if ((direction === "LONG" && regimeDaily <= 0) || (direction === "SHORT" && regimeDaily >= 0)) {
      return res("exit", "ema_regime_reversed", "legacy_regime");
    }
  }

  // SL
  const sl = Number(position.sl);
  if (Number.isFinite(sl) && sl > 0 && Number.isFinite(currentPrice)) {
    if ((direction === "LONG" && currentPrice <= sl) || (direction === "SHORT" && currentPrice >= sl)) {
      return res("exit", "sl_breached", "safety");
    }
  }

  // Max loss
  const maxLossPct = (inFavorable && regimeConfirms) ? -5 : -3;
  if (pnlPct <= maxLossPct) return res("exit", "max_loss", "safety");

  // DOA
  const doaEnabled = String(ctx.config.deepAudit?.deep_audit_doa_early_exit_enabled ?? "true") === "true";
  const mgmt30mST = Number(ctx.tf.m30?.stDir) || 0;
  const mgmt1hST = Number(ctx.tf.h1?.stDir) || 0;
  const structureIntact = (direction === "LONG" && (mgmt30mST === -1 || mgmt1hST === -1))
    || (direction === "SHORT" && (mgmt30mST === 1 || mgmt1hST === 1));
  if (doaEnabled && pnlPct < 0 && positionAgeMin >= 360 && mfePct < 0.3 && !structureIntact) {
    return res("exit", "doa_early_exit", "safety");
  }

  // Hard max hold
  if (positionAgeMin / 60 >= 504) return res("exit", "hard_max_hold", "safety");

  // Time exit for losers
  const tradeRegime = String(d?.regime_class || "TRANSITIONAL");
  const maxDays = tradeRegime === "CHOPPY" ? 5 : tradeRegime === "TRANSITIONAL" ? 8 : 15;
  if (pnlPct < 0 && positionAgeMin / (60 * 6.5) >= maxDays) {
    return res("exit", `time_exit_loser_${tradeRegime.toLowerCase()}`, "safety");
  }

  // Bias flip
  const st = String(d?.state || "");
  const bfAge = inExtended ? 60 : inFavorable ? 180 : 120;
  if (positionAgeMin >= bfAge) {
    if (direction === "SHORT" && st.startsWith("HTF_BULL") && st.includes("LTF_BULL"))
      return res("exit", "bias_flip_full_bull_vs_short", "legacy_bias");
    if (direction === "LONG" && st.startsWith("HTF_BEAR") && st.includes("LTF_BEAR"))
      return res("exit", "bias_flip_full_bear_vs_long", "legacy_bias");
  }

  // Trim
  const rsi10m = Number(ctx.tf.m10?.rsi?.r5) || 50;
  const rsi30m = Number(ctx.tf.m30?.rsi?.r5) || 50;
  const isRsiExtreme = direction === "LONG" ? (rsi10m >= 80 || rsi30m >= 80) : (rsi10m <= 20 || rsi30m <= 20);
  const fuel30 = d?.fuel?.["30"];
  const isFuelCritical = fuel30?.status === "critical";
  const isPnlExtreme = pnlPct >= 5;
  if (positionAgeMin >= 30 && (isRsiExtreme || isFuelCritical || isPnlExtreme)) {
    const reason = isRsiExtreme ? "rsi_extreme" : isFuelCritical ? "fuel_critical" : "pnl_extreme";
    return res("trim", reason, "legacy_trim");
  }

  // Defend
  if (pnlPct < -2 && pnlPct > -6) return res("defend", "adverse_move", "legacy_defend");
  if (pnlPct > 0.5 && rsi30m < 40 && direction === "LONG") return res("defend", "rsi_weakening", "legacy_defend");
  if (pnlPct > 0.5 && rsi30m > 60 && direction === "SHORT") return res("defend", "rsi_weakening", "legacy_defend");

  if (positionAgeMin < 15) return res("just_entered", "initial_hold", "lifecycle");
  return res("hold", "healthy", "lifecycle");
}

function res(stage, reason, family) { return { stage, reason, family, metadata: {} }; }
