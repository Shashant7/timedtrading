// worker/timing-signals.js
//
// Unified timing / extension / risk-off orchestration. Connects TD Sequential,
// phase, RSI, Markov, VIX, and macro context into actionable posture signals
// (trim winners, short fade, put timing) — especially for broad index ETFs.

export const BROAD_INDEX_TICKERS = new Set(["SPY", "QQQ", "IWM", "DIA", "RSP"]);

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

function phaseExtreme(tfRow, tickerData) {
  const phaseV = Number(tfRow?.phase?.v ?? tickerData?.phase_pct);
  const phaseZ = String(tfRow?.phase?.z || "").toUpperCase();
  return phaseZ === "EXTREME" || Math.abs(phaseV) >= 130;
}

function rsiOverbought(tfRow, min = 70) {
  const r5 = Number(tfRow?.rsi?.r5 ?? tfRow?.rsi);
  return Number.isFinite(r5) && r5 >= min;
}

function markovBearish(tickerData) {
  const p1d = tickerData?.regime_forecast?.p_1d || tickerData?.regime_forecast?.p_next || {};
  const bull = (Number(p1d.HTF_BULL_LTF_BULL) || 0) + (Number(p1d.HTF_BULL_LTF_PULLBACK) || 0);
  const bear = (Number(p1d.HTF_BEAR_LTF_BEAR) || 0) + (Number(p1d.HTF_BEAR_LTF_PULLBACK) || 0);
  return bear > bull + 0.12;
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
  const ctx = tickerData?.context || tickerData?.fsd_context || {};
  const stance = String(ctx?.stance || ctx?.macro_stance || "").toLowerCase();
  const tags = Array.isArray(ctx?.tags) ? ctx.tags.map((t) => String(t).toLowerCase()) : [];
  if (stance.includes("risk_off") || stance.includes("defensive") || stance.includes("underweight")) return true;
  if (tags.some((t) => t.includes("risk_off") || t.includes("war") || t.includes("inflation") || t.includes("vix"))) return true;
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
  if (_phaseDZ === "EXTREME" || _phaseD >= 130) out.push(`daily_phase_extreme_${Math.round(_phaseD || 0)}`);
  const _phaseW = Number(tfW?.phase?.v);
  const _phaseWZ = String(tfW?.phase?.z || "").toUpperCase();
  if (_phaseWZ === "EXTREME" || _phaseW >= 130) out.push(`weekly_phase_extreme_${Math.round(_phaseW || 0)}`);

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

/**
 * Compute timing posture for a single ticker snapshot.
 */
export function computeTimingOverlay(tickerData, confluence = null) {
  const sym = String(tickerData?.ticker || "").toUpperCase();
  const warnings = detectExhaustionWarnings(tickerData);
  const signals = [];
  let score = 0;

  const dTd = bearishTdPrepCount(tickerData, "D");
  const wTd = bearishTdPrepCount(tickerData, "W");
  const td9Complete = dTd >= 9 || wTd >= 9 || warnings.some((w) => w.includes("td9_sell_complete"));
  const td9Building = dTd >= 7 || wTd >= 7;

  if (td9Complete) { score += 28; signals.push("TD9 sell setup complete (D/W)"); }
  else if (td9Building) { score += 18; signals.push(`TD9 sell prep building (D=${dTd}, W=${wTd})`); }

  const tfD = tickerData?.tf_tech?.D;
  const tfW = tickerData?.tf_tech?.W;
  if (phaseExtreme(tfD, tickerData)) { score += 12; signals.push("Daily phase EXTREME"); }
  if (phaseExtreme(tfW, tickerData)) { score += 14; signals.push("Weekly phase EXTREME"); }
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
  if (fsdRiskOffHint(tickerData)) { score += 8; signals.push("FSD / macro risk-off context"); }

  if (tickerData?.mean_revert_td9?.active) {
    score += 16;
    signals.push("Mean-revert TD9 aligned");
  }

  const stTrigger = confluence?.supertrend_trigger || null;
  const stBear = stTrigger?.side === "SHORT" && stTrigger?.triggered;
  if (stBear) { score += 10; signals.push("SuperTrend slope bearish"); }

  score = Math.min(100, score);

  let posture = "RISK_ON";
  if (score >= 72 || (td9Complete && warnings.length >= 3)) posture = "DUMP_WATCH";
  else if (score >= 52 || (td9Building && warnings.length >= 2)) posture = "RISK_OFF";
  else if (score >= 35) posture = "CAUTION";

  const trim_winners = score >= 45 || td9Building || warnings.length >= 2;
  const short_opportunity = score >= 50 || td9Complete || (td9Building && markovBearish(tickerData));
  const put_opportunity = short_opportunity && (stBear || td9Complete || score >= 58);
  const mean_revert_short = !!(tickerData?.mean_revert_td9?.active)
    || (td9Complete && rsiOverbought(tfD, 68));

  const flash_headline = (() => {
    if (posture === "DUMP_WATCH") {
      return `Extension dump watch — trim winners, fade rips (${warnings.length} exhaustion signals)`;
    }
    if (posture === "RISK_OFF") {
      return `Risk-off timing — mean-reversion setup building (score ${score})`;
    }
    if (posture === "CAUTION") {
      return `Caution — stretched; avoid new longs (${score}/100)`;
    }
    return null;
  })();

  return {
    ticker: sym || null,
    extension_score: score,
    posture,
    warnings,
    signals,
    trim_winners,
    short_opportunity,
    put_opportunity,
    mean_revert_short,
    td_daily_bear: dTd,
    td_weekly_bear: wTd,
    td9_complete: td9Complete,
    vix: vx,
    is_index: BROAD_INDEX_TICKERS.has(sym),
    flash_headline,
    flash_detail: signals.slice(0, 6).join(" · ") || null,
    generated_at: Date.now(),
  };
}

/**
 * Apply timing overlay to root confluence — elevates FADE SHORT when extension
 * signals dominate but HTF layers still lean long.
 */
export function applyTimingOverlayToConfluence(confluence, overlay, tickerData = null) {
  if (!confluence || !overlay) return confluence;
  const out = { ...confluence, timing: overlay };

  const sym = String(tickerData?.ticker || confluence?.ticker || "").toUpperCase();
  const indexEtf = BROAD_INDEX_TICKERS.has(sym);
  const extensionDominant = overlay.posture === "DUMP_WATCH"
    || overlay.posture === "RISK_OFF"
    || overlay.extension_score >= 55;

  if (!extensionDominant || !overlay.short_opportunity) {
    return out;
  }

  const st = confluence.supertrend_trigger || {};
  const stShort = st.side === "SHORT";
  const contractBear = String(tickerData?.trigger_dir || tickerData?.swing_consensus?.direction || "").toUpperCase();
  const contractShort = contractBear === "BEARISH" || contractBear === "SHORT";

  const shouldFadeShort = overlay.td9_complete
    || overlay.put_opportunity
    || stShort
    || contractShort
    || (indexEtf && overlay.extension_score >= 58);

  if (!shouldFadeShort) return out;

  if (confluence.wait || confluence.mode === "WAIT" || (confluence.side === "LONG" && confluence.long_agree > confluence.short_agree)) {
    out.mode = "FADE";
    out.side = "SHORT";
    out.fade = true;
    out.wait = false;
    out.ride = false;
    out.ready = false;
    out.timing_override = "extension_fade_short";
    out.actionable_summary = `TIMING FADE SHORT — ${overlay.flash_detail || overlay.flash_headline || "extension + exhaustion"}. Trim open winners; defined-risk puts on trigger. Layers may still lean long — this is a mean-reversion timing call, not a trend flip.`;
  } else if (confluence.mode === "FADE" && confluence.side === "SHORT") {
    out.actionable_summary = `FADE SHORT (timing confirmed) — ${overlay.flash_detail || ""}`;
  }

  if (overlay.put_opportunity) {
    out.put_timing = true;
  }
  if (overlay.trim_winners) {
    out.trim_winners = true;
  }

  return out;
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

export function formatTimingFlashSection(tickerData, overlay) {
  const o = overlay || tickerData?.timing_overlay;
  if (!o || !o.flash_headline) return "";
  const lines = [];
  lines.push("### Timed Trading — Extension / Timing Signals");
  lines.push(o.flash_headline);
  if (o.flash_detail) lines.push(o.flash_detail);
  if (Array.isArray(o.warnings) && o.warnings.length) {
    lines.push(`Exhaustion: ${o.warnings.slice(0, 5).join(", ")}`);
  }
  if (o.trim_winners) lines.push("Action: TRIM open winners into strength.");
  if (o.put_opportunity) lines.push("Action: PUT timing window — wait for ST slope or ORB confirm.");
  if (o.short_opportunity) lines.push("Action: FADE SHORT / mean-reversion bias on this name.");
  return lines.join("\n");
}

export function formatIndexWatchFlashSection(watch) {
  if (!watch?.active || !watch.headline) return "";
  const lines = ["### Broad Index Extension Watch (SPY · QQQ · IWM · DIA · RSP)"];
  lines.push(watch.headline);
  if (watch.detail) lines.push(watch.detail);
  lines.push("Operator playbook: reduce index long exposure, tighten stops on winners, stage puts on confirmation — not before layers align.");
  return lines.join("\n");
}
