// worker/pipeline/tt-core-exit.js
// TT Core exit engine — ripster cloud exits + PDZ management + legacy safety nets.
// Combined management for the primary engine.

export function evaluateExit(ctx, position) {
  const d = ctx.raw;
  if (!position || position.status !== "OPEN") return null;

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
  const structureHealth = ctx.structureHealth || null;
  const progression = ctx.progression || null;
  const eventRisk = ctx.eventRisk || null;
  const st15Dir = Number(ctx.tf.m15?.stDir) || 0;
  const st15Slope = Number(ctx.tf.m15?.stSlope) || 0;
  const st15Supportive = direction === "LONG" ? st15Dir === -1 : st15Dir === 1;
  const st15SlopeSupportive = direction === "LONG" ? st15Slope >= 0 : st15Slope <= 0;
  const st15TrendSupportive = st15Supportive && st15SlopeSupportive;
  const elevatedEventRisk = !!(
    eventRisk?.active
    && (
      eventRisk?.severity === "high"
      || eventRisk?.severity === "medium"
      || (Number.isFinite(Number(eventRisk?.hoursToEvent)) && Number(eventRisk.hoursToEvent) <= 24)
    )
  );

  // PDZ zone context
  const pdzZone = String(d?.pdz_zone_D || "unknown");
  const longInPremium = direction === "LONG" && (pdzZone === "premium" || pdzZone === "premium_approach");
  const shortInDiscount = direction === "SHORT" && (pdzZone === "discount" || pdzZone === "discount_approach");
  const longInDiscount = direction === "LONG" && (pdzZone === "discount" || pdzZone === "discount_approach");
  const shortInPremium = direction === "SHORT" && (pdzZone === "premium" || pdzZone === "premium_approach");
  const inExtended = longInPremium || shortInDiscount;
  const inFavorable = longInDiscount || shortInPremium;

  const regimeDaily = Number(d?.ema_regime_daily) || 0;
  const regimeConfirms = (direction === "LONG" && regimeDaily >= 1) || (direction === "SHORT" && regimeDaily <= -1);

  // ── RIPSTER CLOUD EXITS ──
  const cloudResult = evaluateRipsterCloudExits(
    ctx, position, direction, currentPrice, pnlPct, positionAgeMin,
    trimmedPct, mfePct, inExtended, inFavorable,
  );
  if (cloudResult) return cloudResult;

  // ── SAFETY NET: REGIME REVERSAL ──
  const daMinHoldH = Number(ctx.config.deepAudit?.deep_audit_min_hold_regime_exit_hours) || 0;
  if (positionAgeMin >= Math.max(240, daMinHoldH * 60) && !regimeConfirms) {
    if ((direction === "LONG" && regimeDaily <= 0) || (direction === "SHORT" && regimeDaily >= 0)) {
      return result("exit", "ema_regime_reversed", "legacy_regime");
    }
  }

  // ── SL BREACH ──
  const positionSL = Number(position.sl);
  if (Number.isFinite(positionSL) && positionSL > 0 && Number.isFinite(currentPrice)) {
    const slBreached = direction === "LONG" ? currentPrice <= positionSL : currentPrice >= positionSL;
    if (slBreached) {
      return result("exit", "sl_breached", "safety");
    }
  }

  // ── MAX LOSS ──
  // R1 (2026-04-17): PDZ relaxation is a window, not a perpetual grant.
  // After `deep_audit_max_loss_pdz_window_min` market-minutes (default 390
  // = 1 market day) a trade in a favorable zone reverts to the strict normal
  // floor. See worker/index.js classifyKanbanStage EARLY HARD-EXIT GUARDS
  // for the matching inline enforcement and the SGI 2025-07-28 motivating
  // case. Both implementations must agree so tt_core (which uses the inline
  // path via applyInlineFallbackHints) and ripster_core (which uses the
  // pipeline via applyHandledLifecycleDecision) behave identically.
  const daMaxLoss = ctx.config.deepAudit?.deep_audit_max_loss_pct;
  const normalMaxLossPct = daMaxLoss ? Number(daMaxLoss.normal || -3) : -3;
  const pdzMaxLossPct = daMaxLoss ? Number(daMaxLoss.pdz || -5) : -5;
  const pdzWindowMin = Number(ctx.config.deepAudit?.deep_audit_max_loss_pdz_window_min) || 390;
  const pdzToleranceActive = inFavorable && regimeConfirms;
  const pdzWindowOpen = positionAgeMin < pdzWindowMin;
  const maxLossPct = (pdzToleranceActive && pdzWindowOpen) ? pdzMaxLossPct : normalMaxLossPct;
  if (pnlPct <= maxLossPct) {
    const reason = (pdzToleranceActive && !pdzWindowOpen)
      ? "max_loss_pdz_window_expired"
      : "max_loss";
    return result("exit", reason, "safety");
  }

  // ── R6 (2026-04-17): MFE-PROPORTIONAL STOP TRAIL ──
  // Mirrors the inline check in worker/index.js classifyKanbanStage. Once MFE
  // >= 3%, trails stop at 40% of peak-gain; at MFE >= 6% ratchet to 60%; at
  // MFE >= 10% tighten to 75%. Exits when pnlPct <= ratio * MFE_peak. Works
  // as a generalization of R2 v3's giveback math without the 1H ST flip gate.
  {
    const r6Raw = ctx.config.deepAudit?.deep_audit_mfe_trail_enabled;
    const r6Enabled = r6Raw == null
      ? true
      : String(r6Raw).toLowerCase() !== "false" && r6Raw !== false && r6Raw !== 0;
    if (r6Enabled) {
      const r6MinCfg = Number(ctx.config.deepAudit?.deep_audit_mfe_trail_min_pct);
      const r6Min = Number.isFinite(r6MinCfg) && r6MinCfg > 0 ? r6MinCfg : 3.0;
      if (mfePct >= r6Min) {
        const ratio = mfePct >= 10.0
          ? (Number(ctx.config.deepAudit?.deep_audit_mfe_trail_ratio_high) || 0.75)
          : mfePct >= 6.0
            ? (Number(ctx.config.deepAudit?.deep_audit_mfe_trail_ratio_mid) || 0.60)
            : (Number(ctx.config.deepAudit?.deep_audit_mfe_trail_ratio_low) || 0.40);
        const stopPct = ratio * mfePct;
        if (pnlPct <= stopPct) {
          return result("exit", "mfe_proportional_trail", "safety");
        }
      }
    }
  }

  // ── R2 v3 (2026-04-17): STRUCTURAL MFE-DECAY GUARD ──
  // Mirrors the inline check in worker/index.js classifyKanbanStage. Fires ANYWHERE
  // (not just EOD) when a multi-day runner peaked >= 3% and gave back >= 60% AND
  // 1H SuperTrend flipped against the trade. Targets v1 profit-giveback cluster.
  {
    const mdGuardRaw = ctx.config.deepAudit?.deep_audit_mfe_decay_flatten_enabled;
    const mdGuardEnabled = mdGuardRaw == null
      ? true
      : String(mdGuardRaw).toLowerCase() !== "false" && mdGuardRaw !== false && mdGuardRaw !== 0;
    const mdMinAgeMin = Number(ctx.config.deepAudit?.deep_audit_mfe_decay_min_age_market_min) || 390;
    if (mdGuardEnabled && positionAgeMin >= mdMinAgeMin) {
      const mdPeakMin = Number.isFinite(Number(ctx.config.deepAudit?.deep_audit_mfe_decay_peak_min))
        ? Number(ctx.config.deepAudit.deep_audit_mfe_decay_peak_min)
        : 3.0;
      const mdGivebackMax = Number.isFinite(Number(ctx.config.deepAudit?.deep_audit_mfe_decay_giveback_pct_max))
        ? Number(ctx.config.deepAudit.deep_audit_mfe_decay_giveback_pct_max)
        : 0.6;
      if (mfePct >= mdPeakMin) {
        const retained = mfePct > 0 ? pnlPct / mfePct : 0;
        const giveback = 1 - retained;
        if (giveback >= mdGivebackMax) {
          const requireFlip = String(ctx.config.deepAudit?.deep_audit_mfe_decay_require_1h_st_flip ?? "true").toLowerCase() !== "false";
          const h1StDir = Number(ctx.tf.h1?.stDir) || 0;
          const flipped = direction === "LONG" ? h1StDir === 1 : h1StDir === -1;
          if (!requireFlip || flipped) {
            return result("exit", "mfe_decay_structural_flatten", "safety");
          }
        }
      }
    }
  }

  // ── DOA EARLY EXIT ──
  const doaEnabled = String(ctx.config.deepAudit?.deep_audit_doa_early_exit_enabled ?? "true") === "true";
  const doaThresholdH = 6;
  const positionAgeMarketMin = positionAgeMin;
  const mgmt30mST = Number(ctx.tf.m30?.stDir) || 0;
  const mgmt1hST = Number(ctx.tf.h1?.stDir) || 0;
  const stSupportScore = Number(ctx.raw?.st_support?.supportScore ?? 0.5);
  const emaStruct4H = Number(ctx.raw?.tf_tech?.["4H"]?.ema?.structure) || 0;
  const emaStructD = Number(ctx.raw?.tf_tech?.D?.ema?.structure) || 0;
  const profileLabel = String(ctx.raw?.__static_behavior_profile?.label || "").toLowerCase();
  const avgBias = Number(ctx.raw?.avg_bias ?? ctx.raw?.swing_consensus?.bias) || 0;
  const higherTfSupportive = direction === "LONG"
    ? stSupportScore >= 0.58
      && profileLabel === "trend-rider"
      && emaStruct4H >= 0.75
      && emaStructD >= 0.75
      && avgBias >= 0.20
    : stSupportScore <= 0.42
      && profileLabel === "trend-rider"
      && emaStruct4H <= -0.75
      && emaStructD <= -0.75
      && avgBias <= -0.20;
  const doaStructureIntact = (direction === "LONG" && (mgmt30mST === -1 || mgmt1hST === -1))
    || (direction === "SHORT" && (mgmt30mST === 1 || mgmt1hST === 1))
    || higherTfSupportive;
  if (doaEnabled && pnlPct < 0 && positionAgeMarketMin >= doaThresholdH * 60 && mfePct < 0.3 && !doaStructureIntact) {
    return result("exit", "doa_early_exit", "safety");
  }

  // ── HARD MAX HOLD ──
  const positionAgeH = positionAgeMin / 60;
  if (positionAgeH >= 504) {
    return result("exit", "hard_max_hold", "safety");
  }

  // ── TIME EXIT FOR LOSERS IN CHOP ──
  const tradeRegime = String(d?.regime_class || "TRANSITIONAL");
  const maxHoldDays = tradeRegime === "CHOPPY" ? 5 : tradeRegime === "TRANSITIONAL" ? 8 : 15;
  const positionAgeDays = positionAgeMarketMin / (60 * 6.5);
  if (pnlPct < 0 && positionAgeDays >= maxHoldDays) {
    return result("exit", `time_exit_loser_${tradeRegime.toLowerCase()}`, "safety");
  }

  // ── BIAS FLIP ──
  const bfState = String(d?.state || "");
  const bfMinAge = inExtended ? 60 : inFavorable ? 180 : 120;
  if (positionAgeMin >= bfMinAge) {
    if (direction === "SHORT" && bfState.startsWith("HTF_BULL") && bfState.includes("LTF_BULL")) {
      return result("exit", "bias_flip_full_bull_vs_short", "legacy_bias");
    }
    if (direction === "LONG" && bfState.startsWith("HTF_BEAR") && bfState.includes("LTF_BEAR")) {
      return result("exit", "bias_flip_full_bear_vs_long", "legacy_bias");
    }
  }
  if (positionAgeMin >= 60) {
    if (direction === "SHORT" && bfState.startsWith("HTF_BULL") && !bfState.includes("LTF_BULL")) {
      return result("defend", "bias_flip_htf_bull_vs_short", "legacy_bias");
    }
    if (direction === "LONG" && bfState.startsWith("HTF_BEAR") && !bfState.includes("LTF_BEAR")) {
      return result("defend", "bias_flip_htf_bear_vs_long", "legacy_bias");
    }
  }

  // ── TRIM ──
  const rsi10m = Number(ctx.tf.m10?.rsi?.r5) || 50;
  const rsi30m = Number(ctx.tf.m30?.rsi?.r5) || 50;
  const isRsiExtreme = direction === "LONG" ? (rsi10m >= 80 || rsi30m >= 80) : (rsi10m <= 20 || rsi30m <= 20);
  const fuel30 = d?.fuel?.["30"];
  const isFuelCritical = fuel30?.status === "critical";
  const isPnlExtreme = pnlPct >= 5;
  const pdzPnlExtreme = inExtended && pnlPct >= 3;
  const trimGuardActive = positionAgeMin < 30 && pnlPct < 3.0;

  if (!trimGuardActive && (isRsiExtreme || isFuelCritical || isPnlExtreme || pdzPnlExtreme)) {
    const trimReason = isRsiExtreme ? "rsi_extreme"
      : isFuelCritical ? "fuel_critical"
      : pdzPnlExtreme ? "pdz_extended"
      : "pnl_extreme";
    const canDeferExhaustion =
      pnlPct > 0
      && !elevatedEventRisk
      && !structureHealth?.broken
      && (structureHealth?.intact || progression?.status === "advancing");
    const canDeferSoftFuseLike =
      isRsiExtreme
      && pnlPct > 0
      && !elevatedEventRisk
      && st15TrendSupportive
      && !structureHealth?.broken
      && (
        structureHealth?.intact
        || progression?.status === "advancing"
        || (structureHealth?.fragile && progression?.status !== "stretched")
      );

    // Runner: exhaustion signals don't force exit if structure intact
    if (trimmedPct >= 0.5) {
      if (elevatedEventRisk && pnlPct > 0) {
        return result("exit", "runner_pre_event_risk_exit", "tt_context");
      }
      if (isRunnerStructureIntact(d, ctx, direction) && pnlPct > 0) {
        return result("hold", "runner_structure_holds", "tt_runner");
      }
      return result("exit", "runner_exhausted_no_structure", "tt_runner");
    }
    if (canDeferSoftFuseLike) {
      return result("defend", "soft_fuse_deferred_st15_supportive", "tt_context", {
        st15Dir,
        st15Slope,
      });
    }
    if (canDeferExhaustion && (isRsiExtreme || isFuelCritical)) {
      return result("defend", "exhaustion_deferred_structure_intact", "tt_context");
    }
    return result("trim", trimReason, "tt_trim");
  }

  // ── RUNNER TRAILING (post-trim, no active exhaustion signal) ──
  if (trimmedPct >= 0.5) {
    if (elevatedEventRisk && pnlPct > 0) {
      return result("exit", "runner_pre_event_risk_exit", "tt_context");
    }
    if (!isRunnerStructureIntact(d, ctx, direction)) {
      return result("exit", "runner_structure_broken", "tt_runner");
    }
    if (progression?.status === "stretched" && structureHealth?.fragile) {
      return result("defend", "runner_stretched_fragile", "tt_context");
    }
    if (mfePct >= 1.0 && pnlPct <= 0.1) {
      return result("exit", "runner_breakeven_stop", "tt_runner");
    }
    return result("hold", "runner_holding", "tt_runner");
  }

  // ── DEFEND ──
  const isAdverse = pnlPct < -2 && pnlPct > -6;
  if (isAdverse) return result("defend", "adverse_move", "legacy_defend");

  // ── JUST ENTERED ──
  if (positionAgeMin < 15) return result("just_entered", "initial_hold", "lifecycle");

  return result("hold", "healthy", "lifecycle");
}

function evaluateRipsterCloudExits(ctx, position, direction, price, pnlPct, ageMin, trimPct, mfePct, inExtended, inFavorable) {
  if (!ctx.config.ripsterTuneV2) return null;

  const d = ctx.raw;
  const structureHealth = ctx.structureHealth || null;
  const progression = ctx.progression || null;
  const eventRisk = ctx.eventRisk || null;
  const st15Dir = Number(ctx.tf.m15?.stDir) || 0;
  const st15Slope = Number(ctx.tf.m15?.stSlope) || 0;
  const st15Supportive = direction === "LONG" ? st15Dir === -1 : st15Dir === 1;
  const st15SlopeSupportive = direction === "LONG" ? st15Slope >= 0 : st15Slope <= 0;
  const st15TrendSupportive = st15Supportive && st15SlopeSupportive;
  const elevatedEventRisk = !!(
    eventRisk?.active
    && (
      eventRisk?.severity === "high"
      || eventRisk?.severity === "medium"
      || (Number.isFinite(Number(eventRisk?.hoursToEvent)) && Number(eventRisk.hoursToEvent) <= 24)
    )
  );
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

  // 5/12 cloud loss
  const lose5_12 = direction === "LONG"
    ? !!(c5_12?.crossDn || (c5_12?.bear && c5_12?.below))
    : !!(c5_12?.crossUp || (c5_12?.bull && c5_12?.above));

  // 34/50 MTF loss
  const lose34_50 = direction === "LONG"
    ? !!((c34_50_10?.bear || c34_50_10?.below) && (c34_50_1H?.bear || c34_50_1H?.below))
    : !!((c34_50_10?.bull || c34_50_10?.above) && (c34_50_1H?.bull || c34_50_1H?.above));

  // Debounce tracking
  const prev5 = Math.max(Number(position.ripster_pending_5_12) || 0, Number(d?.__ripster_pending_5_12) || 0);
  const prev34 = Math.max(Number(position.ripster_pending_34_50) || 0, Number(d?.__ripster_pending_34_50) || 0);
  const pending5 = lose5_12 ? prev5 + 1 : 0;
  const pending34 = lose34_50 ? prev34 + 1 : 0;

  position.ripster_pending_5_12 = pending5;
  position.ripster_pending_34_50 = pending34;
  if (d) {
    d.__ripster_pending_5_12 = pending5;
    d.__ripster_pending_34_50 = pending34;
  }

  // 5/12 cloud exit with debounce
  if (ageMin >= 30 && lose5_12) {
    if (pending5 < debounceBars) {
      return result("defend", "ripster_5_12_pending", "ripster_cloud");
    }
    // Runner: tolerate 5/12 loss if 34/50 structure still holds
    if (trimPct >= 0.5) {
      const struct34_10 = direction === "LONG" ? !!c34_50_10?.bull : !!c34_50_10?.bear;
      const struct34_30 = rt30?.c34_50 && (direction === "LONG" ? !!rt30.c34_50.bull : !!rt30.c34_50.bear);
      if (struct34_10 || struct34_30) {
        return result("hold", "runner_5_12_loss_struct_ok", "tt_runner");
      }
      return result("exit", "runner_5_12_and_34_gone", "tt_runner");
    }
    if (pnlPct > 0.4 && trimPct < 0.33) {
      return result("trim", "ripster_5_12_defend_trim", "ripster_cloud");
    }
    return result("defend", "ripster_5_12_lost_confirmed", "ripster_cloud");
  }

  // 34/50 MTF exit with debounce
  if (ageMin >= 60 && lose34_50) {
    if (pending34 < Math.max(2, debounceBars)) {
      return result("defend", "ripster_34_50_pending", "ripster_cloud");
    }
    return result("exit", "ripster_34_50_lost_mtf", "ripster_cloud");
  }

  // Short pivot reclaimed
  if (direction === "SHORT" && ageMin >= 20) {
    const ema10 = tfTech("10")?.ema || {};
    const ema30 = tfTech("30")?.ema || {};
    const below10m21 = Number.isFinite(ema10.e21) ? price <= Number(ema10.e21) : true;
    const below30m21 = Number.isFinite(ema30.e21) ? price <= Number(ema30.e21) : true;
    const holdPivotShort = below10m21 && below30m21;
    const shortReclaimed = !holdPivotShort && (c5_12?.bull || c5_12?.above || c34_50_10?.bull || c34_50_10?.above || rt30?.c5_12?.bull);
    if (shortReclaimed) {
      return result("exit", "ripster_short_pivot_reclaimed", "ripster_cloud");
    }
  }

  // PDZ-enhanced: 1H 72-89 structural break
  const lost72_89_1H = direction === "LONG"
    ? !!(c72_89_1H?.bear || c72_89_1H?.below)
    : !!(c72_89_1H?.bull || c72_89_1H?.above);
  const pdzMinGreenMin = (inExtended && ageMin >= 360) ? 360 : 720;
  const canDefer72_89Break =
    pnlPct > 0
    && !elevatedEventRisk
    && st15TrendSupportive
    && !structureHealth?.broken
    && (
      structureHealth?.intact
      || progression?.status === "advancing"
      || (structureHealth?.fragile && progression?.status !== "stretched")
    );

  if (lost72_89_1H && ageMin >= pdzMinGreenMin && pnlPct > 0) {
    if (canDefer72_89Break) {
      return result("defend", "ripster_72_89_1h_deferred_structure_reclaim", "ripster_pdz", {
        st15Dir,
        st15Slope,
      });
    }
    if (trimPct < 0.5 && mfePct >= 2.0) {
      return result("trim", "ripster_72_89_1h_trim", "ripster_pdz");
    }
    return result("exit", "ripster_72_89_1h_structural_break", "ripster_pdz");
  }

  // PDZ-enhanced: 30m 9 EMA trail in extended zone
  const ema30_9 = Number(tfTech("30")?.ema?.e9);
  const trail30m9Breach = direction === "LONG"
    ? (Number.isFinite(ema30_9) && price < ema30_9)
    : (Number.isFinite(ema30_9) && price > ema30_9);

  if (inExtended && trail30m9Breach && ageMin >= 120 && pnlPct > 0.3) {
    if (trimPct < 0.5 && mfePct >= 2.0) {
      return result("trim", "ripster_30m_9ema_trail_trim", "ripster_pdz");
    }
    if (mfePct >= 3.0) {
      return result("exit", "ripster_30m_9ema_trail_exit", "ripster_pdz");
    }
  }

  // MFE trim in extended zone
  if (inExtended && mfePct >= 2.0 && ageMin >= pdzMinGreenMin && trimPct < 0.33 && pnlPct > 0.5) {
    return result("trim", "ripster_pdz_mfe_trim", "ripster_pdz");
  }

  return null;
}

function result(stage, reason, family, metadata = {}) {
  return { stage, reason, family, metadata };
}

function isRunnerStructureIntact(d, ctx, direction) {
  const tfTech = (key) => d?.tf_tech?.[key] || null;
  const rt10 = tfTech("10")?.ripster;
  const rt30 = tfTech("30")?.ripster;
  const c34_10 = rt10?.c34_50;
  const c34_30 = rt30?.c34_50;
  const stDir30m = Number(ctx.tf.m30?.stDir) || 0;
  if (direction === "LONG") {
    return !!(c34_10?.bull || c34_30?.bull) || stDir30m === -1;
  }
  return !!(c34_10?.bear || c34_30?.bear) || stDir30m === 1;
}

function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
