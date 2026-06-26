// Week-calibration entry guards (2026-06-26) — default ON, DA-keyed.
// Implements dormant repeat_churn_guard + path-specific gates from the
// live-week scorecard. Pure helpers; wiring in index.js smart gates + sizing.

function truthy(v, dflt = "true") {
  return String(v ?? dflt).toLowerCase() === "true";
}

function normTsMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function parseTickerAllowlist(raw) {
  if (raw == null || raw === "") return null;
  if (Array.isArray(raw)) return raw.map((t) => String(t || "").toUpperCase()).filter(Boolean);
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed)
      ? parsed.map((t) => String(t || "").toUpperCase()).filter(Boolean)
      : null;
  } catch {
    return null;
  }
}

export function tickerInChurnAllowlist(ticker, allowlist) {
  const sym = String(ticker || "").toUpperCase();
  if (!sym) return false;
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.includes(sym);
}

/** Block range-reversal entries when adverse phase divergence is present at entry. */
export function shouldBlockRangeReversalAdversePhase(opts = {}) {
  const daCfg = opts.daCfg || {};
  if (!truthy(daCfg.deep_audit_range_reversal_block_adverse_phase, "true")) {
    return { block: false };
  }
  const path = String(opts.entryPath || "").toLowerCase();
  if (!path.includes("range_reversal")) return { block: false };

  const sig = opts.entrySignals || opts.entry_signals || {};
  const div = opts.divergenceSummary || opts.divergence || {};
  const hasPhase =
    sig.has_adverse_phase_div === true
    || Number((div.adverse_phase || {}).count) >= 1
    || (div.adverse_phase != null && div.adverse_phase !== false && typeof div.adverse_phase !== "object");

  if (!hasPhase) return { block: false };
  return {
    block: true,
    reason: "range_reversal_adverse_phase_div",
    detail: {
      tf: sig.adverse_phase_strongest_tf || null,
    },
  };
}

/** Require breakout to confirm for N minutes / scoring cycles before ATH entry. */
export function shouldBlockAthBreakoutFastFail(opts = {}) {
  const daCfg = opts.daCfg || {};
  if (!truthy(daCfg.deep_audit_ath_breakout_confirm_gate_enabled, "true")) {
    return { block: false };
  }
  const path = String(opts.entryPath || "").toLowerCase();
  if (path !== "tt_ath_breakout" && path !== "tt_atl_breakdown") return { block: false };

  const now = Number(opts.now) || Date.now();
  const minMin = Number(daCfg.deep_audit_ath_breakout_min_confirm_minutes) || 5;
  const minCount = Number(daCfg.deep_audit_ath_breakout_min_confirm_count) || 3;
  const triggerMs = normTsMs(opts.triggerTs ?? opts.tickerData?.trigger_ts);
  const confirmCount = Number(opts.confirmCount ?? opts.tickerData?._confirm_count) || 0;

  if (triggerMs != null) {
    const minsSince = (now - triggerMs) / 60000;
    if (minsSince < minMin) {
      return {
        block: true,
        reason: "ath_breakout_min_confirm_minutes",
        detail: { minsSince: Number(minsSince.toFixed(2)), required: minMin },
      };
    }
  }
  if (confirmCount < minCount) {
    return {
      block: true,
      reason: "ath_breakout_min_confirm_count",
      detail: { confirmCount, required: minCount },
    };
  }
  return { block: false };
}

function isSlBreachedExit(trade) {
  const r = String(trade?.exit_reason || trade?.exitReason || "").toLowerCase();
  return r.includes("sl_breached") || r.includes("sl_hit") || r === "sl";
}

function normalizeClosedTrade(trade) {
  const exitMs = normTsMs(trade?.exit_ts ?? trade?.exitTs);
  const entryMs = normTsMs(trade?.entry_ts ?? trade?.entryTs);
  return {
    ticker: String(trade?.ticker || "").toUpperCase(),
    direction: String(trade?.direction || "LONG").toUpperCase(),
    status: String(trade?.status || "").toUpperCase(),
    exitReason: String(trade?.exit_reason || trade?.exitReason || ""),
    exitMs,
    entryMs,
    isSl: isSlBreachedExit(trade),
  };
}

/**
 * Dormant model_config flag — now wired. Blocks enter/exit/enter churn on
 * allowlisted tickers (CRDO, MOD, GRNJ, …) after repeated same-day SL stops.
 */
export function shouldBlockRepeatChurn(opts = {}) {
  const daCfg = opts.daCfg || {};
  if (!truthy(daCfg.deep_audit_repeat_churn_guard_enabled, "true")) {
    return { block: false };
  }

  const ticker = String(opts.ticker || "").toUpperCase();
  const direction = String(opts.direction || "LONG").toUpperCase();
  const allowlist = parseTickerAllowlist(daCfg.deep_audit_repeat_churn_guard_include_tickers);
  const globalMode = truthy(daCfg.deep_audit_repeat_churn_guard_global, "false");
  if (!globalMode && !tickerInChurnAllowlist(ticker, allowlist)) {
    return { block: false };
  }

  const now = Number(opts.now) || Date.now();
  const dayKey = String(opts.dayKey || "");
  const maxSameDaySl = Number(daCfg.deep_audit_repeat_churn_max_same_day_sl) || 2;
  const cooldownH = Number(daCfg.deep_audit_repeat_churn_cooldown_hours) || 8;
  const cooldownMs = cooldownH * 3600000;

  const closed = (opts.recentClosedTrades || [])
    .map(normalizeClosedTrade)
    .filter((t) => t.ticker === ticker && t.exitMs != null);

  const sameDaySl = closed.filter((t) => {
    if (!t.isSl) return false;
    if (t.direction !== direction) return false;
    if (dayKey && opts.dayKeyForTs) {
      return opts.dayKeyForTs(t.exitMs) === dayKey;
    }
    return true;
  });

  if (sameDaySl.length >= maxSameDaySl) {
    return {
      block: true,
      reason: "repeat_churn_same_day_sl",
      detail: { count: sameDaySl.length, max: maxSameDaySl },
    };
  }

  const lastSl = closed.find((t) => t.isSl && t.direction === direction);
  if (lastSl && now - lastSl.exitMs < cooldownMs) {
    return {
      block: true,
      reason: "repeat_churn_sl_cooldown",
      detail: {
        hoursSince: Number(((now - lastSl.exitMs) / 3600000).toFixed(2)),
        required: cooldownH,
      },
    };
  }

  return { block: false };
}

/** Cap pullback notional on low-liquidity names (GRNJ-class outsized SL). */
export function applyPullbackLiquidityCap(opts = {}) {
  const daCfg = opts.daCfg || {};
  const notional = Number(opts.notional);
  if (!Number.isFinite(notional) || notional <= 0) {
    return { notional, capped: false };
  }
  if (!truthy(daCfg.deep_audit_pullback_low_liquidity_cap_enabled, "true")) {
    return { notional, capped: false };
  }
  const path = String(opts.entryPath || "").toLowerCase();
  if (path !== "tt_pullback") return { notional, capped: false };

  const minVol = Number(daCfg.deep_audit_pullback_low_liquidity_min_avg_vol) || 500_000;
  const avgVol = Number(opts.avgDailyVolume ?? opts.avgVolume);
  if (!Number.isFinite(avgVol) || avgVol >= minVol) return { notional, capped: false };

  const px = Number(opts.price) || 1;
  const maxPct = Number(daCfg.deep_audit_pullback_low_liquidity_max_notional_pct_adv) || 0.001;
  const floor = Number(daCfg.deep_audit_pullback_low_liquidity_max_notional_floor) || 2500;
  const dollarVol = avgVol * px;
  const cap = Math.max(floor, dollarVol * maxPct);
  const cappedNotional = Math.min(notional, cap);
  return {
    notional: cappedNotional,
    capped: cappedNotional < notional,
    cap: cappedNotional,
    avgVol,
  };
}

/** Run all entry calibration guards; first block wins. */
export function evaluateEntryCalibrationGuards(opts = {}) {
  const checks = [
    shouldBlockRepeatChurn,
    shouldBlockRangeReversalAdversePhase,
    shouldBlockAthBreakoutFastFail,
  ];
  for (const fn of checks) {
    const res = fn(opts);
    if (res?.block) return res;
  }
  return { block: false };
}
