// worker/pipeline/legacy-entry.js
// Frozen A/B reference: Legacy EMA regime entry engine.
// Faithfully reproduces the original ema_regime + gold_short + momentum + squeeze paths.
// Do NOT modify — kept for historical comparison only.

import { signalFreshness } from "../indicators.js";

const FRESHNESS_MIN = 0.3;

export function evaluateEntry(ctx) {
  const { side, state, tf, scores, flags, config, raw } = ctx;
  const d = raw;
  if (!side) return reject("no_inferred_side");

  const htf = scores.htf;
  const ltf = scores.ltf;
  const rr = scores.rr;
  let score = scores.rank;

  const m10 = tf.m10;
  const m30 = tf.m30;
  const h1 = tf.h1;
  const h4 = tf.h4;
  const D = tf.D;

  const daCfg = config.deepAudit || {};
  const now = ctx.asOfTs;

  // ── CONFIRMATION SIGNALS ──
  const triggerSet = new Set((d?.triggers || []).map(t => String(t).toUpperCase()));
  const flagFresh = (flag, flagTs, signalType) => {
    if (!flag) return false;
    if (!flagTs || flagTs <= 0) return true;
    return signalFreshness(flagTs, now, signalType) >= FRESHNESS_MIN;
  };

  const hasStFlipBull = triggerSet.has("ST_FLIP_30M") || triggerSet.has("ST_FLIP_1H")
    || triggerSet.has("ST_FLIP_10M") || triggerSet.has("ST_FLIP_3M")
    || flagFresh(flags.st_flip_30m, flags.st_flip_30m_ts, "momentum")
    || flagFresh(flags.st_flip_1h, flags.st_flip_1h_ts, "structural")
    || flagFresh(flags.st_flip_10m, flags.st_flip_10m_ts, "momentum");
  const hasStFlipBear = triggerSet.has("ST_FLIP_30M_BEAR") || triggerSet.has("ST_FLIP_1H_BEAR")
    || triggerSet.has("ST_FLIP_10M_BEAR") || triggerSet.has("ST_FLIP_3M_BEAR")
    || flagFresh(flags.st_flip_bear, flags.st_flip_bear_ts, "momentum");
  const hasEmaCrossBull = triggerSet.has("EMA_CROSS_1H_13_48_BULL")
    || triggerSet.has("EMA_CROSS_30M_13_48_BULL") || triggerSet.has("EMA_CROSS_10M_13_48_BULL")
    || flagFresh(flags.ema_cross_1h_13_48, flags.ema_cross_1h_13_48_ts, "entry");
  const hasEmaCrossBear = triggerSet.has("EMA_CROSS_1H_13_48_BEAR")
    || triggerSet.has("EMA_CROSS_30M_13_48_BEAR") || triggerSet.has("EMA_CROSS_10M_13_48_BEAR");
  const hasSqRelease = triggerSet.has("SQUEEZE_RELEASE_30M") || triggerSet.has("SQUEEZE_RELEASE_1H")
    || flagFresh(flags.sq30_release, flags.sq30_release_ts, "momentum")
    || flagFresh(flags.sq1h_release, flags.sq1h_release_ts, "entry");

  // ── EMA REGIME ──
  const dailyRegime = Number(d?.ema_regime_daily) || 0;
  const regime4H = Number(d?.ema_regime_4h) || 0;
  const regime1H = Number(d?.ema_regime_1h) || 0;
  const dailyST = d?.st_support?.map?.D;
  const stBullConfirms = dailyST?.dir === "bull" && dailyST?.aligned;
  const stBearConfirms = dailyST?.dir === "bear" && dailyST?.aligned;

  // LTF alignment
  const ltf10mDepth = m10?.ema?.depth ?? 5;
  const ltf10mStruct = m10?.ema?.structure ?? 0;
  const ltf10mRsi = Number(m10?.rsi?.r5) ?? 50;
  const ltf30mRsi = Number(m30?.rsi?.r5) ?? 50;
  const ltfStrongBull = (ltf10mDepth >= 8 && ltf10mStruct >= 0.5) || (ltf10mRsi > 60 && ltf30mRsi > 55);
  const ltfStrongBear = (ltf10mDepth >= 8 && ltf10mStruct <= -0.5) || (ltf10mRsi < 40 && ltf30mRsi < 45);

  // Sector alignment (from raw data)
  const sectorAlign = d?._sectorAlignment;
  const sectorBull = sectorAlign?.direction === "BULL";
  const sectorBear = sectorAlign?.direction === "BEAR";
  const sectorStrength = sectorAlign?.strength || 0;

  // Overbought/oversold gate
  // Configurable for replay parity experiments; defaults preserve historical behavior.
  const _exhaustHigh = Number(daCfg.deep_audit_exhaustion_rsi_high);
  const _exhaustLow = Number(daCfg.deep_audit_exhaustion_rsi_low);
  const _exhaustMinTf = Number(daCfg.deep_audit_exhaustion_min_tf_count);
  const _obLevel = Number.isFinite(_exhaustHigh) ? _exhaustHigh : 70;
  const _osLevel = Number.isFinite(_exhaustLow) ? _exhaustLow : 30;
  const _tfCountGate = Number.isFinite(_exhaustMinTf) ? Math.max(1, _exhaustMinTf) : 3;
  const _rsi30m = Number(m30?.rsi?.r5) ?? 50;
  const _rsi1H = Number(h1?.rsi?.r5) ?? 50;
  const _rsi4H = Number(h4?.rsi?.r5) ?? 50;
  const _rsiD = Number(D?.rsi?.r5) ?? 50;
  const _obCount = (_rsi30m > _obLevel ? 1 : 0) + (_rsi1H > _obLevel ? 1 : 0) + (_rsi4H > _obLevel ? 1 : 0) + (_rsiD > _obLevel ? 1 : 0);
  const _osCount = (_rsi30m < _osLevel ? 1 : 0) + (_rsi1H < _osLevel ? 1 : 0) + (_rsi4H < _osLevel ? 1 : 0) + (_rsiD < _osLevel ? 1 : 0);
  if (side !== "SHORT" && _obCount >= _tfCountGate) {
    return reject("overbought_exhaustion", { rsi30m: _rsi30m, rsi1H: _rsi1H, rsi4H: _rsi4H, rsiD: _rsiD, threshold: _obLevel, tfCountGate: _tfCountGate });
  }
  if (side !== "LONG" && _osCount >= _tfCountGate) {
    return reject("oversold_exhaustion", { rsi30m: _rsi30m, rsi1H: _rsi1H, rsi4H: _rsi4H, rsiD: _rsiD, threshold: _osLevel, tfCountGate: _tfCountGate });
  }

  const isMomentumBull = state === "HTF_BULL_LTF_BULL";
  const isMomentumBear = state === "HTF_BEAR_LTF_BEAR";

  // Optional parity switch: prioritize legacy momentum path before EMA regime paths.
  // This is disabled by default and can be enabled via model_config:
  // deep_audit_legacy_momentum_precedence=true
  const _legacyMomentumPrecedence = String(daCfg.deep_audit_legacy_momentum_precedence ?? "false") === "true";
  const _legacyMomentumMinRrCfg = Number(daCfg.deep_audit_legacy_momentum_min_rr);
  const _legacyMomentumMinRr = Number.isFinite(_legacyMomentumMinRrCfg) && _legacyMomentumMinRrCfg > 0
    ? _legacyMomentumMinRrCfg
    : 2.0;
  const _legacyMomentumRelaxTrigger = String(daCfg.deep_audit_legacy_momentum_relax_trigger ?? "false") === "true";
  const _legacyMomentumStructFallbackBull = _legacyMomentumRelaxTrigger && dailyRegime === 2 && stBullConfirms && regime4H >= 1;
  const _legacyMomentumStructFallbackBear = _legacyMomentumRelaxTrigger && dailyRegime === -2 && stBearConfirms && regime4H <= -1;
  const _momentumSignalBull = isMomentumBull
    && score >= 70
    && rr >= _legacyMomentumMinRr
    && (hasStFlipBull || hasEmaCrossBull || hasSqRelease || _legacyMomentumStructFallbackBull);
  const _momentumSignalBear = isMomentumBear
    && score >= 70
    && rr >= _legacyMomentumMinRr
    && (hasStFlipBear || hasEmaCrossBear || hasSqRelease || _legacyMomentumStructFallbackBear);
  if (_legacyMomentumPrecedence) {
    if (_momentumSignalBull) {
      return qualify("momentum_score", "medium", "momentum_with_signal_precedence", {
        momentum_precedence_enabled: true,
        momentum_min_rr: _legacyMomentumMinRr,
        momentum_relax_trigger: _legacyMomentumRelaxTrigger,
        momentum_struct_fallback_bull: _legacyMomentumStructFallbackBull,
        score,
        rr,
        hasStFlipBull,
        hasEmaCrossBull,
        hasSqRelease,
      });
    }
    if (_momentumSignalBear) {
      return qualify("momentum_score_short", "medium", "momentum_bear_with_signal_precedence", {
        momentum_precedence_enabled: true,
        momentum_min_rr: _legacyMomentumMinRr,
        momentum_relax_trigger: _legacyMomentumRelaxTrigger,
        momentum_struct_fallback_bear: _legacyMomentumStructFallbackBear,
        score,
        rr,
        hasStFlipBear,
        hasEmaCrossBear,
        hasSqRelease,
      });
    }
  }

  // ── PATH 1: EMA REGIME CONFIRMED LONG ──
  if (dailyRegime === 2 && side !== "SHORT") {
    if (ltfStrongBear) {
      return reject("ltf_opposing_long", { ltf10mDepth, ltf10mStruct });
    }
    if (htf >= 5) {
      const _st1H = Number(h1?.stDir) ?? 0;
      const _st30m = Number(m30?.stDir) ?? 0;
      const _fullyExtended = _st1H === -1 && _st30m === -1;
      let conf;
      if (stBullConfirms) conf = "high";
      else conf = (regime4H >= 1) ? "medium" : "low";
      if (_fullyExtended) conf = conf === "high" ? "medium" : "low";

      return qualify("ema_regime_confirmed_long",
        (sectorBull && sectorStrength >= 60 && !_fullyExtended) ? "high" : conf,
        stBullConfirms ? "daily_ema_regime_confirmed_with_st" : "daily_ema_regime_confirmed_st_pending",
        {
          momentum_precedence_enabled: _legacyMomentumPrecedence,
          momentum_min_rr: _legacyMomentumMinRr,
          momentum_relax_trigger: _legacyMomentumRelaxTrigger,
          momentum_signal_bull: _momentumSignalBull,
          momentum_inputs: {
            state,
            score,
            rr,
            hasStFlipBull,
            hasEmaCrossBull,
            hasSqRelease,
            structFallbackBull: _legacyMomentumStructFallbackBull,
          },
        });
    }
  }

  // ── PATH 2: EMA REGIME EARLY LONG ──
  if (dailyRegime === 1 && side !== "SHORT") {
    if (ltfStrongBear) {
      return reject("ltf_opposing_long", { ltf10mDepth, ltf10mStruct });
    }
    const hasConf = stBullConfirms || regime4H >= 2 || hasStFlipBull || hasEmaCrossBull || hasSqRelease;
    if (htf >= 8 && hasConf) {
      return qualify("ema_regime_early_long",
        stBullConfirms ? "medium" : "low",
        "daily_5_48_cross_with_confirmation");
    }
  }

  // ── PATH 3: EMA REGIME CONFIRMED SHORT ──
  if (dailyRegime === -2 && side !== "LONG") {
    if (ltfStrongBull) {
      return reject("ltf_opposing_short", { ltf10mDepth, ltf10mStruct });
    }
    if (htf <= -5) {
      let conf;
      if (stBearConfirms) conf = "high";
      else conf = (regime4H <= -1) ? "medium" : "low";

      return qualify("ema_regime_confirmed_short",
        (sectorBear && sectorStrength >= 60) ? "high" : conf,
        stBearConfirms ? "daily_ema_regime_confirmed_bear_with_st" : "daily_ema_regime_confirmed_bear_st_pending");
    }
  }

  // ── PATH 4: EMA REGIME EARLY SHORT ──
  if (dailyRegime === -1 && side !== "LONG") {
    if (ltfStrongBull) {
      return reject("ltf_opposing_short", { ltf10mDepth, ltf10mStruct });
    }
    const hasConf = stBearConfirms || regime4H <= -2 || flags.st_flip_bear || hasEmaCrossBear || hasSqRelease;
    if (htf <= -8 && hasConf) {
      return qualify("ema_regime_early_short",
        stBearConfirms ? "medium" : "low",
        "daily_5_48_cross_bear_with_confirmation");
    }
  }

  // ── GOLD SHORT (blow-off top) ──
  if (state === "HTF_BULL_LTF_BULL") {
    if (htf >= 30 && ltf >= 22) {
      return qualify("gold_short", "high", "extreme_blowoff");
    }
    if (htf >= 25 && ltf >= 15 && (hasEmaCrossBear || hasSqRelease)) {
      return qualify("gold_short_confirmed", "high", "blowoff_with_signal");
    }
    if (htf >= 22 && ltf >= 12 && (hasEmaCrossBear || hasSqRelease)) {
      return qualify("gold_short_medium", "medium", "overextended_with_divergence");
    }
  }

  // ── BEAR PULLBACK SHORTS ──
  if (state === "HTF_BEAR_LTF_PULLBACK") {
    const htfMin = (sectorBear && sectorStrength >= 50) ? -3 : -5;
    const bearPullback = htf <= htfMin && ltf >= -5 && ltf <= 25;
    if (bearPullback) {
      const ltfBearRecovering = ltf < 10 || flags.st_flip_bear || hasEmaCrossBear || hasSqRelease;
      if (ltf >= 5 && ltfBearRecovering) {
        return qualify("gold_short_pullback", "high", "bear_pullback_with_confirmation");
      }
      if (ltf >= 0 && (flags.st_flip_bear || hasEmaCrossBear)) {
        return qualify("gold_short_pullback_shallow", "medium", "bear_shallow_with_signal");
      }
      if (ltf >= 8 && htf <= -10) {
        return qualify("gold_short_pullback_deep", "medium", "bear_deep_pullback");
      }
    }
  }

  // ── MOMENTUM ──
  if (_momentumSignalBull) {
    return qualify("momentum_score", "medium", "momentum_with_signal", {
      momentum_precedence_enabled: _legacyMomentumPrecedence,
      momentum_min_rr: _legacyMomentumMinRr,
      momentum_relax_trigger: _legacyMomentumRelaxTrigger,
      score,
      rr,
      hasStFlipBull,
      hasEmaCrossBull,
      hasSqRelease,
      structFallbackBull: _legacyMomentumStructFallbackBull,
    });
  }
  if (_momentumSignalBear) {
    return qualify("momentum_score_short", "medium", "momentum_bear_with_signal", {
      momentum_precedence_enabled: _legacyMomentumPrecedence,
      momentum_min_rr: _legacyMomentumMinRr,
      momentum_relax_trigger: _legacyMomentumRelaxTrigger,
      score,
      rr,
      hasStFlipBear,
      hasEmaCrossBear,
      hasSqRelease,
      structFallbackBear: _legacyMomentumStructFallbackBear,
    });
  }

  // ── SQUEEZE SETUP ──
  if (state.includes("PULLBACK") && hasSqRelease && score >= 70 && rr >= 2.0) {
    return qualify("squeeze_setup", "medium", "squeeze_release");
  }

  // ── ELITE ──
  if ((flags.thesis_match || flags.momentum_elite) && score >= 70 && rr >= 2.0) {
    return qualify("elite", "medium", "momentum_elite");
  }

  // ── BREAKOUT ──
  const bo = d?.breakout;
  if (bo && bo.dir === side) {
    const boEnabled = daCfg[`deep_audit_breakout_${bo.type}_enabled`] !== "0";
    if (boEnabled) {
      const boMinRR = Number(daCfg.deep_audit_breakout_min_rr) || 1.5;
      if (rr >= boMinRR) {
        const boConf = (bo.rvol >= 2.0) ? "high" : (bo.rvol >= 1.5) ? "medium" : "low";
        return qualify(`breakout_${bo.type}_${side.toLowerCase()}`, boConf, `breakout_${bo.type}`);
      }
    }
  }

  // ── MEAN REVERT TD9 ALIGNED ──
  const mrEnabled = String(daCfg.deep_audit_mean_revert_td9_enabled ?? "false") === "true";
  if (mrEnabled && d?.mean_revert_td9?.active) {
    const mr = d.mean_revert_td9;
    if (d) d.__da_mean_revert_size_mult = 0.5;
    return qualify("mean_revert_td9_aligned",
      mr.support_score >= 3 ? "medium" : "low",
      `td9_aligned_reversal_support_${mr.support_score}`);
  }

  return reject("criteria_not_met");
}

function reject(reason, metadata = {}) {
  return { qualifies: false, reason, engine: "legacy", path: null, confidence: null, direction: null, sizing: null, metadata };
}

function qualify(path, confidence, reason, metadata = {}) {
  return { qualifies: true, path, confidence, direction: null, engine: "legacy", reason, sizing: null, metadata };
}
