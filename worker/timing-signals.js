// worker/timing-signals.js
//
// Unified timing orchestration — bidirectional. Connects TD Sequential,
// phase, RSI, Markov, VIX, and macro context into actionable posture signals:
//   EXTENSION (bear): trim winners, fade short, put timing
//   COMPRESSION (bull): add on dips, fade long, call timing

import { ACTIVE_RISKS, TACTICAL_SIGNALS } from "./strategy-context.js";

export const BROAD_INDEX_TICKERS = new Set(["SPY", "QQQ", "IWM", "DIA", "RSP"]);

const MACRO_RISK_OFF_DIRECTIONS = new Set([
  "caution_mag7_short_term",
  "bullish_stretched",
  "short_term_caution_on_crypto",
]);

const MACRO_RISK_ON_DIRECTIONS = new Set([
  "favor_equal_weight_over_cap_weight",
  "favor_software_over_semis_on_any_tech_dip",
  "favor_industrials_into_broadening",
]);

const INDEX_WATCH_MIN_HITS = 3;

export function getTdPerTf(tickerData, tf) {
  const perTf = tickerData?.td_sequential?.per_tf || {};
  if (tf === "D") return perTf.D || perTf["1D"] || null;
  if (tf === "W") return perTf.W || perTf["1W"] || null;
  return perTf[tf] || null;
}

export function bearishTdPrepCount(tickerData, tf) {
  const row = getTdPerTf(tickerData, tf);
  if (!row) return 0;
  if (row.td9_bearish === true || row.td9_bearish === "true") return 9;
  return Number(row.bearish_prep_count) || 0;
}

export function bullishTdPrepCount(tickerData, tf) {
  const row = getTdPerTf(tickerData, tf);
  if (!row) return 0;
  if (row.td9_bullish === true || row.td9_bullish === "true") return 9;
  return Number(row.bullish_prep_count) || 0;
}

function phaseExtremeHigh(tfRow, tickerData) {
  const phaseV = Number(tfRow?.phase?.v ?? tickerData?.phase_pct);
  const phaseZ = String(tfRow?.phase?.z || "").toUpperCase();
  return phaseZ === "EXTREME" || phaseV >= 130;
}

function phaseExtremeLow(tfRow) {
  const phaseV = Number(tfRow?.phase?.v);
  const phaseZ = String(tfRow?.phase?.z || "").toUpperCase();
  return phaseZ === "EXTREME" || phaseV <= -130;
}

function rsiOverbought(tfRow, min = 70) {
  const r5 = Number(tfRow?.rsi?.r5 ?? tfRow?.rsi);
  return Number.isFinite(r5) && r5 >= min;
}

function rsiOversold(tfRow, max = 30) {
  const r5 = Number(tfRow?.rsi?.r5 ?? tfRow?.rsi);
  return Number.isFinite(r5) && r5 <= max;
}

function markovBearish(tickerData) {
  const p1d = tickerData?.regime_forecast?.p_1d || tickerData?.regime_forecast?.p_next || {};
  const bull = (Number(p1d.HTF_BULL_LTF_BULL) || 0) + (Number(p1d.HTF_BULL_LTF_PULLBACK) || 0);
  const bear = (Number(p1d.HTF_BEAR_LTF_BEAR) || 0) + (Number(p1d.HTF_BEAR_LTF_PULLBACK) || 0);
  return bear > bull + 0.12;
}

function markovBullish(tickerData) {
  const p1d = tickerData?.regime_forecast?.p_1d || tickerData?.regime_forecast?.p_next || {};
  const bull = (Number(p1d.HTF_BULL_LTF_BULL) || 0) + (Number(p1d.HTF_BULL_LTF_PULLBACK) || 0);
  const bear = (Number(p1d.HTF_BEAR_LTF_BEAR) || 0) + (Number(p1d.HTF_BEAR_LTF_PULLBACK) || 0);
  return bull > bear + 0.12;
}

function vixLevel(tickerData) {
  const vix = Number(
    tickerData?._vix
    ?? tickerData?.market_internals?.vix?.price
    ?? tickerData?._marketInternals?.vix?.price
  );
  return Number.isFinite(vix) ? vix : null;
}

function fsdRiskOffHint(tickerData) {
  const sym = String(tickerData?.ticker || "").toUpperCase();
  const ctx = tickerData?.context || tickerData?.fsd_context || {};
  const stance = String(
    ctx?.stance
    || ctx?.macro_stance
    || tickerData?.strategy_stance?.stance
    || tickerData?._strategy_stance?.stance
    || ""
  ).toLowerCase();
  const tags = Array.isArray(ctx?.tags) ? ctx.tags.map((t) => String(t).toLowerCase()) : [];
  if (stance.includes("risk_off") || stance.includes("defensive") || stance.includes("underweight")) return true;
  if (tags.some((t) => t.includes("risk_off") || t.includes("war") || t.includes("inflation") || t.includes("vix"))) return true;

  const highRisks = ACTIVE_RISKS.filter((r) => String(r?.severity || "").toLowerCase() === "high");
  if (highRisks.length > 0) {
    const riskText = highRisks.map((r) => `${r.name} ${r.note || ""}`.toLowerCase()).join(" ");
    if (riskText.includes("war") || riskText.includes("inflation") || riskText.includes("vol")) return true;
    if (BROAD_INDEX_TICKERS.has(sym)) return true;
  }

  if (BROAD_INDEX_TICKERS.has(sym)) {
    const tactRiskOff = TACTICAL_SIGNALS.some((s) => {
      const dir = String(s?.direction || "").toLowerCase();
      if (MACRO_RISK_OFF_DIRECTIONS.has(dir)) return true;
      const action = String(s?.playbook_action || "").toLowerCase();
      return action.includes("trim") || action.includes("consolidation") || action.includes("de-risk");
    });
    if (tactRiskOff) return true;
  }

  return false;
}

function fsdRiskOnHint(tickerData) {
  const sym = String(tickerData?.ticker || "").toUpperCase();
  const ctx = tickerData?.context || tickerData?.fsd_context || {};
  const stance = String(
    ctx?.stance
    || ctx?.macro_stance
    || tickerData?.strategy_stance?.stance
    || tickerData?._strategy_stance?.stance
    || ""
  ).toLowerCase();
  if (stance.includes("overweight") || stance.includes("risk_on") || stance.includes("accumulate")) return true;

  if (BROAD_INDEX_TICKERS.has(sym)) {
    const tactRiskOn = TACTICAL_SIGNALS.some((s) => {
      const dir = String(s?.direction || "").toLowerCase();
      if (MACRO_RISK_ON_DIRECTIONS.has(dir)) return true;
      const action = String(s?.playbook_action || "").toLowerCase();
      return action.includes("favor") || action.includes("lean toward") || action.includes("buy the dip");
    });
    if (tactRiskOn) return true;
  }
  return false;
}

function premiumExtension(tickerData) {
  const pdz = tickerData?.tf_tech?.D?.pdz || tickerData?.pdz;
  const zone = String(pdz?.zone || pdz?.label || "").toLowerCase();
  if (zone.includes("premium") || zone.includes("ext")) return true;
  const fuelD = tickerData?.fuel?.D || tickerData?.fuel?.["30"];
  if (fuelD?.status === "critical" || fuelD?.status === "low") return true;
  return false;
}

function discountCompression(tickerData) {
  const pdz = tickerData?.tf_tech?.D?.pdz || tickerData?.pdz;
  const zone = String(pdz?.zone || pdz?.label || "").toLowerCase();
  if (zone.includes("discount") || zone.includes("value")) return true;
  const fuelD = tickerData?.fuel?.D || tickerData?.fuel?.["30"];
  if (fuelD?.status === "full" || fuelD?.status === "high") return true;
  return false;
}

/**
 * Compression / capitulation signals — mirror of exhaustion for long timing.
 */
export function detectCompressionSignals(tickerData) {
  if (!tickerData || typeof tickerData !== "object") return [];
  const mb = tickerData.monthly_bundle;
  const tfD = tickerData.tf_tech?.D;
  const tfW = tickerData.tf_tech?.W;
  const out = [];

  const tdD = bullishTdPrepCount(tickerData, "D");
  const tdW = bullishTdPrepCount(tickerData, "W");
  if (tdD >= 7) out.push(`daily_td9_buy_at_${tdD}`);
  if (tdW >= 7) out.push(`weekly_td9_buy_at_${tdW}`);
  if (getTdPerTf(tickerData, "D")?.td9_bullish) out.push("daily_td9_buy_complete");
  if (getTdPerTf(tickerData, "W")?.td9_bullish) out.push("weekly_td9_buy_complete");

  const _phaseD = Number(tfD?.phase?.v ?? tickerData?.phase_pct);
  if (phaseExtremeLow(tfD) || _phaseD <= -130) out.push(`daily_phase_compressed_${Math.round(_phaseD || 0)}`);
  const _phaseW = Number(tfW?.phase?.v);
  if (phaseExtremeLow(tfW) || _phaseW <= -130) out.push(`weekly_phase_compressed_${Math.round(_phaseW || 0)}`);

  const _mRsi = Number(mb?.rsi);
  if (_mRsi <= 25) out.push(`monthly_rsi_${_mRsi.toFixed(0)}`);
  const _wRsi5 = Number(tfW?.rsi?.r5);
  if (Number.isFinite(_wRsi5) && _wRsi5 <= 35) out.push(`weekly_rsi_${_wRsi5.toFixed(0)}`);
  const _dRsi5 = Number(tfD?.rsi?.r5);
  if (Number.isFinite(_dRsi5) && _dRsi5 <= 32) out.push(`daily_rsi_${_dRsi5.toFixed(0)}`);

  if (tickerData?.rsi_divergence?.D?.bull?.active || tfD?.rsiDiv?.bull?.active) out.push("daily_bullish_rsi_divergence");
  if (tickerData?.rsi_divergence?.W?.bull?.active || tfW?.rsiDiv?.bull?.active) out.push("weekly_bullish_rsi_divergence");

  const _rsRank = Number(tickerData?.__rsRank ?? tickerData?.rsRank);
  if (Number.isFinite(_rsRank) && _rsRank > 70) out.push(`rs_rank_strong_${_rsRank.toFixed(0)}`);
  const _rs1m = Number(tickerData?.rs?.rs1m);
  if (Number.isFinite(_rs1m) && _rs1m > 3) out.push(`rs_1m_+${_rs1m.toFixed(1)}pct`);

  if (markovBullish(tickerData)) out.push("markov_1d_bullish");

  const vx = vixLevel(tickerData);
  if (vx != null && vx >= 25) out.push(`vix_spike_capitulation_${vx.toFixed(1)}`);

  if (fsdRiskOnHint(tickerData)) out.push("fsd_macro_risk_on");

  if (tickerData?.mean_revert_td9?.active && String(tickerData.mean_revert_td9.side || "").toUpperCase() === "LONG") {
    out.push("mean_revert_td9_long");
  }

  return out;
}

/**
 * Exhaustion warnings used by investor trim, accumZone, and trader SL tightening.
 * Fixed 2026-06-06: reads td_sequential.per_tf (not the nonexistent .D/.W top level).
 */
export function detectExhaustionWarnings(tickerData) {
  if (!tickerData || typeof tickerData !== "object") return [];
  const mb = tickerData.monthly_bundle;
  const tfD = tickerData.tf_tech?.D;
  const tfW = tickerData.tf_tech?.W;
  const out = [];

  const tdD = bearishTdPrepCount(tickerData, "D");
  const tdW = bearishTdPrepCount(tickerData, "W");
  if (tdD >= 7) out.push(`daily_td9_at_${tdD}`);
  if (tdW >= 7) out.push(`weekly_td9_at_${tdW}`);
  if (getTdPerTf(tickerData, "D")?.td9_bearish) out.push("daily_td9_sell_complete");
  if (getTdPerTf(tickerData, "W")?.td9_bearish) out.push("weekly_td9_sell_complete");

  const _phaseD = Number(tfD?.phase?.v ?? tickerData?.phase_pct);
  const _phaseDZ = String(tfD?.phase?.z || "").toUpperCase();
  if (phaseExtremeHigh(tfD, tickerData)) out.push(`daily_phase_extreme_${Math.round(_phaseD || 0)}`);
  const _phaseW = Number(tfW?.phase?.v);
  const _phaseWZ = String(tfW?.phase?.z || "").toUpperCase();
  if (phaseExtremeHigh(tfW, tickerData)) out.push(`weekly_phase_extreme_${Math.round(_phaseW || 0)}`);

  const _mRsi = Number(mb?.rsi);
  if (_mRsi >= 80) out.push(`monthly_rsi_${_mRsi.toFixed(0)}`);
  const _wRsi5 = Number(tfW?.rsi?.r5);
  if (Number.isFinite(_wRsi5) && _wRsi5 >= 85) out.push(`weekly_rsi_${_wRsi5.toFixed(0)}`);
  const _dRsi5 = Number(tfD?.rsi?.r5);
  if (Number.isFinite(_dRsi5) && _dRsi5 >= 80) out.push(`daily_rsi_${_dRsi5.toFixed(0)}`);

  if (tickerData?.rsi_divergence?.D?.bear?.active || tfD?.rsiDiv?.bear?.active) out.push("daily_bearish_rsi_divergence");
  if (tickerData?.rsi_divergence?.W?.bear?.active || tfW?.rsiDiv?.bear?.active) out.push("weekly_bearish_rsi_divergence");

  const _rsRank = Number(tickerData?.__rsRank ?? tickerData?.rsRank);
  if (Number.isFinite(_rsRank) && _rsRank < 30) out.push(`rs_rank_weak_${_rsRank.toFixed(0)}`);
  const _rs1m = Number(tickerData?.rs?.rs1m);
  if (Number.isFinite(_rs1m) && _rs1m < -3) out.push(`rs_1m_${_rs1m.toFixed(1)}pct`);

  if (tickerData?.regime_exhausted?.sigma_above_mean >= 2) {
    out.push(`markov_dwell_exhausted_${Number(tickerData.regime_exhausted.sigma_above_mean).toFixed(1)}sigma`);
  }
  if (markovBearish(tickerData)) out.push("markov_1d_bearish");

  const vx = vixLevel(tickerData);
  if (vx != null && vx >= 22) out.push(`vix_elevated_${vx.toFixed(1)}`);
  if (vx != null && vx >= 28) out.push(`vix_risk_off_${vx.toFixed(1)}`);

  if (fsdRiskOffHint(tickerData)) out.push("fsd_macro_risk_off");

  if (tickerData?.mean_revert_td9?.active && String(tickerData.mean_revert_td9.side || "").toUpperCase() === "SHORT") {
    out.push("mean_revert_td9_short");
  }

  return out;
}

function computeExtensionSide(tickerData, confluence, warnings) {
  const signals = [];
  let score = 0;
  const dTd = bearishTdPrepCount(tickerData, "D");
  const wTd = bearishTdPrepCount(tickerData, "W");
  const td9Complete = dTd >= 9 || wTd >= 9 || warnings.some((w) => w.includes("td9_sell_complete"));
  const td9Building = dTd >= 7 || wTd >= 7;
  const tfD = tickerData?.tf_tech?.D;
  const tfW = tickerData?.tf_tech?.W;

  if (td9Complete) { score += 28; signals.push("TD9 sell setup complete (D/W)"); }
  else if (td9Building) { score += 18; signals.push(`TD9 sell prep building (D=${dTd}, W=${wTd})`); }
  if (phaseExtremeHigh(tfD, tickerData)) { score += 12; signals.push("Daily phase EXTREME"); }
  if (phaseExtremeHigh(tfW, tickerData)) { score += 14; signals.push("Weekly phase EXTREME"); }
  if (rsiOverbought(tfD, 75)) { score += 8; signals.push("Daily RSI overbought"); }
  if (rsiOverbought(tfW, 80)) { score += 10; signals.push("Weekly RSI overbought"); }
  if (premiumExtension(tickerData)) { score += 10; signals.push("Premium / extension zone"); }
  if (markovBearish(tickerData)) { score += 14; signals.push("Markov 1d bearish"); }
  if (tickerData?.regime_exhausted?.sigma_above_mean >= 2) {
    score += 12;
    signals.push("Markov dwell exhaustion");
  }
  const vx = vixLevel(tickerData);
  if (vx != null && vx >= 22) { score += 8; signals.push(`VIX elevated (${vx.toFixed(1)})`); }
  if (vx != null && vx >= 28) { score += 10; signals.push(`VIX risk-off (${vx.toFixed(1)})`); }
  if (fsdRiskOffHint(tickerData)) { score += 8; signals.push("Macro risk-off context"); }
  if (tickerData?.mean_revert_td9?.active && String(tickerData.mean_revert_td9.side || "").toUpperCase() !== "LONG") {
    score += 16;
    signals.push("Mean-revert TD9 aligned (short)");
  }
  const stTrigger = confluence?.supertrend_trigger || null;
  const stBear = stTrigger?.side === "SHORT" && stTrigger?.triggered;
  if (stBear) { score += 10; signals.push("SuperTrend slope bearish"); }

  score = Math.min(100, score);
  let posture = "RISK_ON";
  if (score >= 72 || (td9Complete && warnings.length >= 3)) posture = "DUMP_WATCH";
  else if (score >= 52 || (td9Building && warnings.length >= 2)) posture = "RISK_OFF";
  else if (score >= 35) posture = "CAUTION";

  return {
    score,
    posture,
    signals,
    dTd,
    wTd,
    td9Complete,
    td9Building,
    stBear,
    trim_winners: score >= 45 || td9Building || warnings.length >= 2,
    short_opportunity: score >= 50 || td9Complete || (td9Building && markovBearish(tickerData)),
    put_opportunity: false,
    mean_revert_short: !!(tickerData?.mean_revert_td9?.active && String(tickerData.mean_revert_td9.side || "").toUpperCase() === "SHORT")
      || (td9Complete && rsiOverbought(tfD, 68)),
  };
}

function computeCompressionSide(tickerData, confluence, compressions) {
  const signals = [];
  let score = 0;
  const dTd = bullishTdPrepCount(tickerData, "D");
  const wTd = bullishTdPrepCount(tickerData, "W");
  const td9Complete = dTd >= 9 || wTd >= 9 || compressions.some((c) => c.includes("td9_buy_complete"));
  const td9Building = dTd >= 7 || wTd >= 7;
  const tfD = tickerData?.tf_tech?.D;
  const tfW = tickerData?.tf_tech?.W;

  if (td9Complete) { score += 28; signals.push("TD9 buy setup complete (D/W)"); }
  else if (td9Building) { score += 18; signals.push(`TD9 buy prep building (D=${dTd}, W=${wTd})`); }
  if (phaseExtremeLow(tfD)) { score += 12; signals.push("Daily phase compressed"); }
  if (phaseExtremeLow(tfW)) { score += 14; signals.push("Weekly phase compressed"); }
  if (rsiOversold(tfD, 32)) { score += 8; signals.push("Daily RSI oversold"); }
  if (rsiOversold(tfW, 35)) { score += 10; signals.push("Weekly RSI oversold"); }
  if (discountCompression(tickerData)) { score += 10; signals.push("Discount / compression zone"); }
  if (markovBullish(tickerData)) { score += 14; signals.push("Markov 1d bullish"); }
  const vx = vixLevel(tickerData);
  if (vx != null && vx >= 25) { score += 8; signals.push(`VIX spike capitulation (${vx.toFixed(1)})`); }
  if (fsdRiskOnHint(tickerData)) { score += 8; signals.push("Macro risk-on context"); }
  if (tickerData?.mean_revert_td9?.active && String(tickerData.mean_revert_td9.side || "").toUpperCase() === "LONG") {
    score += 16;
    signals.push("Mean-revert TD9 aligned (long)");
  }
  const stTrigger = confluence?.supertrend_trigger || null;
  const stBull = stTrigger?.side === "LONG" && stTrigger?.triggered;
  if (stBull) { score += 10; signals.push("SuperTrend slope bullish"); }

  score = Math.min(100, score);
  let posture = "NEUTRAL";
  if (score >= 72 || (td9Complete && compressions.length >= 3)) posture = "RALLY_WATCH";
  else if (score >= 52 || (td9Building && compressions.length >= 2)) posture = "RISK_ON_BUY";
  else if (score >= 35) posture = "ACCUMULATE_CAUTION";

  const long_opportunity = score >= 50 || td9Complete || (td9Building && markovBullish(tickerData));
  const call_opportunity = long_opportunity && (stBull || td9Complete || score >= 58);

  return {
    score,
    posture,
    signals,
    dTd,
    wTd,
    td9Complete,
    td9Building,
    stBull,
    add_on_dips: score >= 45 || td9Building || compressions.length >= 2,
    long_opportunity,
    call_opportunity,
    mean_revert_long: !!(tickerData?.mean_revert_td9?.active && String(tickerData.mean_revert_td9.side || "").toUpperCase() === "LONG")
      || (td9Complete && rsiOversold(tfD, 35)),
  };
}

/**
 * Compute timing posture for a single ticker snapshot (bidirectional).
 */
export function computeTimingOverlay(tickerData, confluence = null) {
  const sym = String(tickerData?.ticker || "").toUpperCase();
  const warnings = detectExhaustionWarnings(tickerData);
  const compressions = detectCompressionSignals(tickerData);
  const ext = computeExtensionSide(tickerData, confluence, warnings);
  const comp = computeCompressionSide(tickerData, confluence, compressions);

  ext.put_opportunity = ext.short_opportunity && (ext.stBear || ext.td9Complete || ext.score >= 58);

  let bias = "NEUTRAL";
  if (ext.score >= 35 && comp.score >= 35) {
    bias = ext.score > comp.score ? "EXTENSION" : comp.score > ext.score ? "COMPRESSION" : "NEUTRAL";
  } else if (ext.score >= 35) bias = "EXTENSION";
  else if (comp.score >= 35) bias = "COMPRESSION";

  const dominantSignals = bias === "COMPRESSION" ? comp.signals : ext.signals;
  const vx = vixLevel(tickerData);

  const flash_headline = (() => {
    if (bias === "COMPRESSION") {
      if (comp.posture === "RALLY_WATCH") {
        return `Compression rally watch — add on dips, fade selloffs (${compressions.length} capitulation signals)`;
      }
      if (comp.posture === "RISK_ON_BUY") {
        return `Risk-on buy timing — mean-reversion long setup building (score ${comp.score})`;
      }
      if (comp.posture === "ACCUMULATE_CAUTION") {
        return `Accumulate caution — compressed; avoid new shorts (${comp.score}/100)`;
      }
    }
    if (bias === "EXTENSION") {
      if (ext.posture === "DUMP_WATCH") {
        return `Extension dump watch — trim winners, fade rips (${warnings.length} exhaustion signals)`;
      }
      if (ext.posture === "RISK_OFF") {
        return `Risk-off timing — mean-reversion setup building (score ${ext.score})`;
      }
      if (ext.posture === "CAUTION") {
        return `Caution — stretched; avoid new longs (${ext.score}/100)`;
      }
    }
    return null;
  })();

  return {
    ticker: sym || null,
    bias,
    extension_score: ext.score,
    compression_score: comp.score,
    posture: bias === "COMPRESSION" ? comp.posture : ext.posture,
    warnings,
    compressions,
    signals: dominantSignals,
    trim_winners: ext.trim_winners,
    short_opportunity: ext.short_opportunity,
    put_opportunity: ext.put_opportunity,
    mean_revert_short: ext.mean_revert_short,
    add_on_dips: comp.add_on_dips,
    long_opportunity: comp.long_opportunity,
    call_opportunity: comp.call_opportunity,
    mean_revert_long: comp.mean_revert_long,
    td_daily_bear: ext.dTd,
    td_weekly_bear: ext.wTd,
    td_daily_bull: comp.dTd,
    td_weekly_bull: comp.wTd,
    td9_complete: bias === "COMPRESSION" ? comp.td9Complete : ext.td9Complete,
    vix: vx,
    is_index: BROAD_INDEX_TICKERS.has(sym),
    flash_headline,
    flash_detail: dominantSignals.slice(0, 6).join(" · ") || null,
    timing_primary: (bias === "EXTENSION" && ext.score >= 52) ? "TOP"
      : (bias === "COMPRESSION" && comp.score >= 52) ? "BOTTOM"
      : null,
    playbook: (bias === "EXTENSION" && ext.score >= 52) ? "TIME_TOP"
      : (bias === "COMPRESSION" && comp.score >= 52) ? "TIME_BOTTOM"
      : "NEUTRAL",
    generated_at: Date.now(),
  };
}

function _applyFadeLong(out, confluence, overlay, reason) {
  out.mode = "FADE";
  out.side = "LONG";
  out.fade = true;
  out.wait = false;
  out.ride = false;
  out.ready = false;
  out.drift = false;
  out.timing_override = reason;
  out.timing_primary = "BOTTOM";
  out.playbook = "TIME_BOTTOM";
  out.trend_catch_suppressed = reason === "timing_bottom_overrides_trend";
  out.actionable_summary = reason === "timing_bottom_overrides_trend"
    ? `TIME THE BOTTOM — ${overlay.flash_detail || overlay.flash_headline || "compression + capitulation"}. Trend-catch SHORT suppressed at a timing bottom. Add on dips; defined-risk calls on trigger.`
    : `TIMING FADE LONG — ${overlay.flash_detail || overlay.flash_headline || "compression + capitulation"}. Add on dips; defined-risk calls on trigger. Layers may still lean short — primary timing call, not a trend flip.`;
  if (overlay.call_opportunity) out.call_timing = true;
  if (overlay.add_on_dips) out.add_on_dips = true;
  return out;
}

function _applyFadeShort(out, confluence, overlay, reason) {
  out.mode = "FADE";
  out.side = "SHORT";
  out.fade = true;
  out.wait = false;
  out.ride = false;
  out.ready = false;
  out.drift = false;
  out.timing_override = reason;
  out.timing_primary = "TOP";
  out.playbook = "TIME_TOP";
  out.trend_catch_suppressed = reason === "timing_top_overrides_trend";
  out.actionable_summary = reason === "timing_top_overrides_trend"
    ? `TIME THE TOP — ${overlay.flash_detail || overlay.flash_headline || "extension + exhaustion"}. Trend-catch LONG suppressed at a timing top. Trim winners; defined-risk puts on trigger.`
    : `TIMING FADE SHORT — ${overlay.flash_detail || overlay.flash_headline || "extension + exhaustion"}. Trim open winners; defined-risk puts on trigger. Layers may still lean long — primary timing call, not a trend flip.`;
  if (overlay.put_opportunity) out.put_timing = true;
  if (overlay.trim_winners) out.trim_winners = true;
  return out;
}

function _finalizeTimingPlaybook(out, overlay) {
  if (out.timing_primary) return out;
  if (out.ride || out.drift) {
    out.playbook = "TREND_CATCH";
    out.trend_catch = true;
    const base = out.actionable_summary || "";
    if (!base.includes("Trend catch")) {
      out.actionable_summary = `${base} Trend catch (secondary) — not at a timed top/bottom; smaller size than a primary timing fade.`.trim();
    }
  } else if (!out.playbook) {
    out.playbook = overlay?.playbook || "NEUTRAL";
  }
  return out;
}

/**
 * Apply timing overlay to root confluence.
 * Timed Trading promise: TIME tops/bottoms first; trend-catch (RIDE/DRIFT) is rare fallback.
 */
export function applyTimingOverlayToConfluence(confluence, overlay, tickerData = null) {
  if (!confluence || !overlay) return confluence;
  const out = { ...confluence, timing: overlay };

  const sym = String(tickerData?.ticker || confluence?.ticker || "").toUpperCase();
  const indexEtf = BROAD_INDEX_TICKERS.has(sym);
  const bias = String(overlay.bias || "").toUpperCase();

  if (bias === "COMPRESSION" && overlay.long_opportunity) {
    const compressionDominant = overlay.posture === "RALLY_WATCH"
      || overlay.posture === "RISK_ON_BUY"
      || overlay.compression_score >= 55;
    if (compressionDominant) {
      const st = confluence.supertrend_trigger || {};
      const stLong = st.side === "LONG";
      const contractBull = String(tickerData?.trigger_dir || tickerData?.swing_consensus?.direction || "").toUpperCase();
      const contractLong = contractBull === "BULLISH" || contractBull === "LONG";
      const shouldFadeLong = overlay.td9_complete
        || overlay.call_opportunity
        || stLong
        || contractLong
        || (indexEtf && overlay.compression_score >= 58);

      if (shouldFadeLong) {
        if ((confluence.mode === "RIDE" || confluence.mode === "DRIFT") && confluence.side === "SHORT") {
          _applyFadeLong(out, confluence, overlay, "timing_bottom_overrides_trend");
        } else if (confluence.wait || confluence.mode === "WAIT"
          || (confluence.side === "SHORT" && confluence.short_agree > confluence.long_agree)) {
          _applyFadeLong(out, confluence, overlay, "compression_fade_long");
        } else if (confluence.mode === "FADE" && confluence.side === "LONG") {
          out.timing_primary = "BOTTOM";
          out.playbook = "TIME_BOTTOM";
          out.actionable_summary = `FADE LONG (timing confirmed) — ${overlay.flash_detail || ""}`;
          if (overlay.call_opportunity) out.call_timing = true;
          if (overlay.add_on_dips) out.add_on_dips = true;
        }
      }
    }
    return _finalizeTimingPlaybook(out, overlay);
  }

  if (bias === "EXTENSION" && overlay.short_opportunity) {
    const extensionDominant = overlay.posture === "DUMP_WATCH"
      || overlay.posture === "RISK_OFF"
      || overlay.extension_score >= 55;
    if (extensionDominant) {
      const st = confluence.supertrend_trigger || {};
      const stShort = st.side === "SHORT";
      const contractBear = String(tickerData?.trigger_dir || tickerData?.swing_consensus?.direction || "").toUpperCase();
      const contractShort = contractBear === "BEARISH" || contractBear === "SHORT";

      const shouldFadeShort = overlay.td9_complete
        || overlay.put_opportunity
        || stShort
        || contractShort
        || (indexEtf && overlay.extension_score >= 58);

      if (shouldFadeShort) {
        if ((confluence.mode === "RIDE" || confluence.mode === "DRIFT") && confluence.side === "LONG") {
          _applyFadeShort(out, confluence, overlay, "timing_top_overrides_trend");
        } else if (confluence.wait || confluence.mode === "WAIT"
          || (confluence.side === "LONG" && confluence.long_agree > confluence.short_agree)) {
          _applyFadeShort(out, confluence, overlay, "extension_fade_short");
        } else if (confluence.mode === "FADE" && confluence.side === "SHORT") {
          out.timing_primary = "TOP";
          out.playbook = "TIME_TOP";
          out.actionable_summary = `FADE SHORT (timing confirmed) — ${overlay.flash_detail || ""}`;
          if (overlay.put_opportunity) out.put_timing = true;
          if (overlay.trim_winners) out.trim_winners = true;
        }
      }
    }
    return _finalizeTimingPlaybook(out, overlay);
  }

  return _finalizeTimingPlaybook(out, overlay);
}

/**
 * Cross-index extension watch — fires when broad indices align on exhaustion.
 */
export function evaluateBroadIndexExtensionWatch(snapshots = {}) {
  const hits = [];
  for (const sym of BROAD_INDEX_TICKERS) {
    const td = snapshots[sym];
    if (!td || typeof td !== "object") continue;
    const overlay = td.timing_overlay || computeTimingOverlay(td, td.confluence_verdict || null);
    if (overlay.extension_score >= 45 || overlay.posture === "RISK_OFF" || overlay.posture === "DUMP_WATCH") {
      hits.push({ ticker: sym, ...overlay });
    }
  }
  hits.sort((a, b) => (b.extension_score || 0) - (a.extension_score || 0));
  const active = hits.length >= INDEX_WATCH_MIN_HITS;
  const avgScore = hits.length
    ? Math.round(hits.reduce((s, h) => s + (h.extension_score || 0), 0) / hits.length)
    : 0;

  const headline = active
    ? `INDEX EXTENSION WATCH — ${hits.length} benchmarks stretched (avg ${avgScore}/100). Trim winners; watch put timing on SPY/QQQ.`
    : null;

  return {
    active,
    breadth: hits.length,
    avg_score: avgScore,
    hits,
    headline,
    detail: hits.map((h) => `${h.ticker}:${h.extension_score}(${h.posture})`).join(", "),
    generated_at: Date.now(),
  };
}

export function evaluateBroadIndexCompressionWatch(snapshots = {}) {
  const hits = [];
  for (const sym of BROAD_INDEX_TICKERS) {
    const td = snapshots[sym];
    if (!td || typeof td !== "object") continue;
    const overlay = td.timing_overlay || computeTimingOverlay(td, td.confluence_verdict || null);
    if (overlay.compression_score >= 45 || overlay.posture === "RISK_ON_BUY" || overlay.posture === "RALLY_WATCH") {
      hits.push({ ticker: sym, ...overlay });
    }
  }
  hits.sort((a, b) => (b.compression_score || 0) - (a.compression_score || 0));
  const active = hits.length >= INDEX_WATCH_MIN_HITS;
  const avgScore = hits.length
    ? Math.round(hits.reduce((s, h) => s + (h.compression_score || 0), 0) / hits.length)
    : 0;

  const headline = active
    ? `INDEX COMPRESSION WATCH — ${hits.length} benchmarks compressed (avg ${avgScore}/100). Add on dips; watch call timing on SPY/QQQ.`
    : null;

  return {
    active,
    breadth: hits.length,
    avg_score: avgScore,
    hits,
    headline,
    detail: hits.map((h) => `${h.ticker}:${h.compression_score}(${h.posture})`).join(", "),
    generated_at: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reversal-trim advisor (2026-06-10, SHADOW-FIRST).
//
// Operator incident: open positions were not trimmed near highs before a
// steep multi-day drawdown even though FSD had warned of a reversal. The
// audit (tasks/2026-06-10-reversal-trim-plan.md) found that FSD/CRO intel
// and the timing overlay stop at the CONTEXT layer for the trader book —
// trims only fire on mechanical extremes (RSI 80, fuel critical, TP tiers,
// cloud breaks) and actively defer while structure looks intact.
//
// This advisor closes the observation gap WITHOUT touching execution: for
// every open profitable position it combines
//   1. the ticker's own timing overlay (trim_winners / extension score /
//      exhaustion warnings — which already include fsd_macro_risk_off), and
//   2. the market-level INDEX EXTENSION WATCH breadth signal,
// and emits a concrete "trim N% near the high" advisory. The scoring cron
// persists it to KV + Discord. Enforcement (auto-trim) is a separate,
// operator-gated phase once the advisory's hit rate is proven.
//
// Pure function — no KV/D1/env. Unit-tested in timing-signals.test.js.
// ─────────────────────────────────────────────────────────────────────────────
export function evaluateReversalTrimAdvisory({ openTrades = [], getSnapshot, indexWatch = null, now = Date.now() } = {}) {
  const advisories = [];
  const marketStretch = !!(indexWatch && indexWatch.active);

  for (const trade of openTrades) {
    const status = String(trade?.status || "").toUpperCase();
    if (status !== "OPEN" && status !== "TP_HIT_TRIM") continue;
    const sym = String(trade?.ticker || "").toUpperCase();
    if (!sym) continue;
    const snap = typeof getSnapshot === "function" ? getSnapshot(sym) : null;
    if (!snap || typeof snap !== "object") continue;

    const direction = String(trade?.direction || "LONG").toUpperCase();
    const isLong = direction !== "SHORT";
    const entry = Number(trade?.entry_price ?? trade?.entryPrice) || 0;
    const px = Number(snap?._live_price ?? snap?.price ?? snap?.close) || 0;
    if (!(entry > 0) || !(px > 0)) continue;
    const pnlPct = isLong ? ((px - entry) / entry) * 100 : ((entry - px) / entry) * 100;
    const trimmedPct = Math.max(0, Math.min(1, Number(trade?.trimmedPct ?? trade?.trimmed_pct) || 0));

    // Only advise on WINNERS with meaningful untrimmed size — the point is
    // locking gains near the high, not exiting losers (loss handling stays
    // with SL/doctrine).
    if (!(pnlPct >= 1.0) || trimmedPct >= 0.5) continue;

    const overlay = snap.timing_overlay || computeTimingOverlay(snap, snap.confluence_verdict || null);
    const warnings = Array.isArray(overlay?.warnings) ? overlay.warnings : [];
    const reasons = [];

    if (isLong) {
      if (overlay?.trim_winners === true) reasons.push("overlay_trim_winners");
      if (Number(overlay?.extension_score) >= 55) reasons.push(`extension_${Math.round(Number(overlay.extension_score))}`);
      if (warnings.length >= 2) reasons.push(`exhaustion_x${warnings.length}`);
      if (warnings.includes("fsd_macro_risk_off")) reasons.push("fsd_risk_off");
      if (marketStretch) reasons.push(`index_watch_${indexWatch.breadth}`);
    } else {
      // SHORT winner near the lows — mirror with the compression side.
      if (Number(overlay?.compression_score) >= 55) reasons.push(`compression_${Math.round(Number(overlay.compression_score))}`);
      const compressions = Array.isArray(overlay?.compressions) ? overlay.compressions : [];
      if (compressions.length >= 2) reasons.push(`capitulation_x${compressions.length}`);
      if (overlay?.add_on_dips === true) reasons.push("overlay_rally_watch");
    }

    // Require at least one TICKER-level reason — the market-level index
    // watch alone must not flag every open winner (that is what the
    // existing INDEX EXTENSION WATCH alert already says in aggregate).
    const tickerReasons = reasons.filter((r) => !r.startsWith("index_watch"));
    if (tickerReasons.length === 0) continue;
    // Conviction: 1 ticker reason = advisory only with market confirmation
    // or strong pnl; 2+ ticker reasons = advisory on its own.
    if (tickerReasons.length === 1 && !marketStretch && pnlPct < 3) continue;

    const strong = tickerReasons.length >= 2 && (marketStretch || warnings.includes("fsd_macro_risk_off"));
    const suggested = strong ? 0.33 : 0.25;

    advisories.push({
      ticker: sym,
      trade_id: trade?.trade_id ?? trade?.id ?? null,
      direction,
      pnl_pct: Math.round(pnlPct * 100) / 100,
      trimmed_pct: Math.round(trimmedPct * 100) / 100,
      suggested_trim_pct: suggested,
      strength: strong ? "strong" : "standard",
      reasons,
      price: px,
      entry_price: entry,
    });
  }

  advisories.sort((a, b) => b.pnl_pct - a.pnl_pct);
  const active = advisories.length > 0;
  return {
    active,
    generated_at: now,
    market: {
      index_watch_active: marketStretch,
      index_watch_breadth: marketStretch ? indexWatch.breadth : 0,
    },
    advisories,
    headline: active
      ? `REVERSAL TRIM ADVISOR — ${advisories.length} open winner(s) showing reversal risk near highs. ${marketStretch ? `Index extension watch active (${indexWatch.breadth} benchmarks). ` : ""}Suggested partial trims below.`
      : null,
  };
}

export function formatTimingFlashSection(tickerData, overlay) {
  const o = overlay || tickerData?.timing_overlay;
  if (!o || !o.flash_headline) return "";
  const lines = [];
  const bias = String(o.bias || "EXTENSION").toUpperCase();
  lines.push(bias === "COMPRESSION"
    ? "### Timed Trading — Compression / Timing Signals"
    : "### Timed Trading — Extension / Timing Signals");
  lines.push(o.flash_headline);
  if (o.flash_detail) lines.push(o.flash_detail);
  if (bias === "COMPRESSION" && Array.isArray(o.compressions) && o.compressions.length) {
    lines.push(`Compression: ${o.compressions.slice(0, 5).join(", ")}`);
  } else if (Array.isArray(o.warnings) && o.warnings.length) {
    lines.push(`Exhaustion: ${o.warnings.slice(0, 5).join(", ")}`);
  }
  if (o.trim_winners) lines.push("Action: TRIM open winners into strength.");
  if (o.put_opportunity) lines.push("Action: PUT timing window — wait for ST slope or ORB confirm.");
  if (o.short_opportunity) lines.push("Action: FADE SHORT / mean-reversion bias on this name.");
  if (o.add_on_dips) lines.push("Action: ADD on dips into weakness.");
  if (o.call_opportunity) lines.push("Action: CALL timing window — wait for ST slope or ORB confirm.");
  if (o.long_opportunity) lines.push("Action: FADE LONG / mean-reversion bias on this name.");
  return lines.join("\n");
}

export function formatIndexWatchFlashSection(watch, kind = "extension") {
  if (!watch?.active || !watch.headline) return "";
  const title = kind === "compression"
    ? "### Broad Index Compression Watch (SPY · QQQ · IWM · DIA · RSP)"
    : "### Broad Index Extension Watch (SPY · QQQ · IWM · DIA · RSP)";
  const lines = [title];
  lines.push(watch.headline);
  if (watch.detail) lines.push(watch.detail);
  if (kind === "compression") {
    lines.push("Operator playbook: add index exposure on weakness, cover shorts into capitulation, stage calls on confirmation — not before layers align.");
  } else {
    lines.push("Operator playbook: reduce index long exposure, tighten stops on winners, stage puts on confirmation — not before layers align.");
  }
  return lines.join("\n");
}
