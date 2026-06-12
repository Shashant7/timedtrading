/* worker/lib/smart-gates.js — context-aware smart gate bypasses.
 *
 * Data basis (admission_cohort_log, 60d to 2026-06-12):
 *   late_day_entry_block: 17 rejects — 4 tt_ath_breakout, 5 tt_gap_reversal_long
 *   pre_macro_entry (PCE): 13 — 7 gap_reversal, 2 ath_breakout, 3 pullback
 *
 * Move-discovery (691 moves, 4.1% capture):
 *   Binding constraint CONVICTION_TOO_LOW 58.9% (rank/HTF/qualification gap)
 *   Downstream smart gates are a small slice once names reach admission.
 *
 * Policy:
 *   - Late day: allow high-conviction momentum breakouts (ATH/momentum paths)
 *     where the breakout itself is the signal — blanket 15:30 block was
 *     catching valid ATH continuation entries.
 *   - Macro: still block fragile paths (gap_reversal, pullback) on macro days;
 *     allow ATH/momentum when rank + conviction confirm institutional flow.
 */

export const MOMENTUM_BREAKOUT_PATHS = new Set([
  "tt_ath_breakout",
  "tt_atl_breakdown",
  "tt_momentum",
]);

export function normalizeCompletionPct(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

export function isMomentumBreakoutPath(entryPath) {
  return MOMENTUM_BREAKOUT_PATHS.has(String(entryPath || "").toLowerCase());
}

export function stampMomentumBreakoutEarly(d, ctx, daCfg, triggers = {}) {
  if (!d) return false;
  const enabled = String(daCfg?.deep_audit_momentum_breakout_early_qualify_enabled ?? "true") === "true";
  if (!enabled) return false;

  const athFired = triggers.athBreakoutTrigger === true || d?.__ath_breakout_diag?.fired === true;
  const momFired = triggers.momentumTrigger === true;
  const rvol = Number(ctx?.rvol?.best)
    || Number(d?.rvol?.best)
    || Number(d?.rvol_map?.["30"]?.vr)
    || Number(d?.rvol_best)
    || 0;
  const minRvol = Number(daCfg?.deep_audit_momentum_breakout_early_min_rvol ?? 2.0);
  const momentumElite = d?.flags?.momentum_elite === true;
  const ath = d?.daily_structure?.ath52w;
  const nearHighPct = ath?.pct_below_high_252;
  const nearHighMax = Number(daCfg?.deep_audit_momentum_breakout_near_high_pct ?? 8.0);
  const nearHigh = Number.isFinite(nearHighPct) && nearHighPct >= 0 && nearHighPct < nearHighMax;

  const qualifies = athFired
    || (momFired && (momentumElite || (rvol > 0 && rvol >= minRvol)))
    || (nearHigh && (momentumElite || (rvol > 0 && rvol >= minRvol)) && ath?.breakout_above_prev_high === true);

  if (qualifies) {
    d.__momentum_breakout_early = true;
    d.__momentum_breakout_early_meta = {
      ath_fired: athFired,
      momentum_fired: momFired,
      momentum_elite: momentumElite,
      rvol,
      near_high_pct: nearHighPct ?? null,
    };
  }
  return qualifies;
}

export function applyMomentumBreakoutConvictionCarveout(entryMinConviction, d, daCfg) {
  let floor = entryMinConviction;
  if (!d?.__momentum_breakout_early) return floor;
  const delta = Number(daCfg?.deep_audit_momentum_breakout_conviction_delta ?? 10);
  const minRank = Number(daCfg?.deep_audit_momentum_breakout_min_rank ?? 65);
  const rank = Number(d?.rank ?? d?.score) || 0;
  if (rank < minRank) return floor;
  return Math.max(70, floor - delta);
}

export function shouldBypassLateDaySmartGate(tickerData, daCfg) {
  if (String(daCfg?.deep_audit_smart_gate_late_day_bypass_enabled ?? "true") !== "true") {
    return false;
  }
  const path = String(tickerData?.__entry_path || tickerData?.entry_path || "").toLowerCase();
  if (!isMomentumBreakoutPath(path) && tickerData?.__momentum_breakout_early !== true) {
    return false;
  }
  const rank = Number(tickerData?.rank ?? tickerData?.score) || 0;
  const rvol = Number(tickerData?.rvol?.best ?? tickerData?.rvol_map?.["30"]?.vr ?? tickerData?.rvol_best) || 0;
  const conv = Number(tickerData?.__focus_conviction_score) || 0;
  const minRank = Number(daCfg?.deep_audit_smart_gate_late_day_min_rank ?? 72);
  const minRvol = Number(daCfg?.deep_audit_smart_gate_late_day_min_rvol ?? 1.5);
  const minConv = Number(daCfg?.deep_audit_smart_gate_late_day_min_conviction ?? 75);
  if (rank < minRank) return false;
  if (rvol > 0 && rvol < minRvol) return false;
  if (conv > 0 && conv < minConv) return false;
  return true;
}

export function shouldBypassMacroEntrySmartGate(tickerData, event, daCfg) {
  if (String(daCfg?.deep_audit_smart_gate_macro_bypass_enabled ?? "true") !== "true") {
    return false;
  }
  if (event?.eventType !== "macro") return false;
  const path = String(tickerData?.__entry_path || tickerData?.entry_path || "").toLowerCase();
  if (!isMomentumBreakoutPath(path)) return false;
  // Keep gap/pullback blocked on macro release days — admission log showed
  // gap_reversal as the dominant macro casualty (7/13 PCE rejects).
  if (path.includes("gap") || path.includes("pullback") || path.includes("reclaim")) {
    return false;
  }
  const rank = Number(tickerData?.rank ?? tickerData?.score) || 0;
  const conv = Number(tickerData?.__focus_conviction_score) || 0;
  const minRank = Number(daCfg?.deep_audit_smart_gate_macro_min_rank ?? 78);
  const minConv = Number(daCfg?.deep_audit_smart_gate_macro_min_conviction ?? 75);
  if (rank < minRank) return false;
  if (conv > 0 && conv < minConv) return false;
  return tickerData?.__momentum_breakout_early === true || path === "tt_ath_breakout" || path === "tt_momentum";
}
