/**
 * Learning-bus setup demotion keys (deep_audit_setup_demotion_*).
 * Keys use display names from SETUP_NAME_MAP, e.g.
 *   deep_audit_setup_demotion_TT ATH Breakout_long
 */

export const SETUP_DEMOTION_NAME_MAP = {
  tt_ath_breakout: "TT ATH Breakout",
  tt_atl_breakdown: "TT ATL Breakdown",
  tt_pullback: "TT Pullback Reclaim",
  tt_reclaim: "TT Reclaim Long",
  tt_momentum: "TT Momentum Push",
  tt_mean_revert: "TT Mean Reversion",
  tt_n_test_support: "TT Support Bounce",
  tt_n_test_resistance: "TT Resistance Fade",
  tt_range_reversal_long: "TT Range Reversal (Long)",
  tt_range_reversal_short: "TT Range Reversal (Short)",
  tt_gap_reversal_long: "TT Gap Reversal (Long)",
  tt_gap_reversal_short: "TT Gap Reversal (Short)",
  tt_index_etf_swing: "TT Index Swing",
};

export function setupDemotionConfigKey(path, direction) {
  const setupKey = String(path || "").trim();
  const dir = String(direction || "").toLowerCase().trim();
  if (!setupKey || !dir) return null;
  const display = SETUP_DEMOTION_NAME_MAP[setupKey]
    || `TT ${setupKey.replace(/^tt_/i, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
  return `deep_audit_setup_demotion_${display}_${dir}`;
}

/**
 * Canonical demotion key from a scorecard candidate whose `setup` may be a
 * display name ("TT ATH Breakout"), a path key ("tt_ath_breakout"), or a
 * mangled display ("TT Tt Ath Breakout"). Edge-scorecard proposals used the
 * raw string, so applied proposals landed under keys checkSetupDemotion()
 * never reads — the ATH-breakout demotion marker sat inert in model_config.
 */
export function demotionProposalConfigKey(setup, direction) {
  const raw = String(setup || "").trim();
  const dir = String(direction || "").toLowerCase().trim();
  if (!raw || !dir) return null;
  // Path key form.
  if (/^tt_[a-z0-9_]+$/.test(raw)) return setupDemotionConfigKey(raw, dir);
  // Display-name form (case/spacing tolerant, tolerates duplicated TT prefix).
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/^(tt )+/, "tt ").trim();
  const target = norm(raw);
  for (const [path, display] of Object.entries(SETUP_DEMOTION_NAME_MAP)) {
    if (norm(display) === target) return setupDemotionConfigKey(path, dir);
  }
  return `deep_audit_setup_demotion_${raw}_${dir}`;
}

export function parseEnforceDemotionPaths(raw) {
  return new Set(
    String(raw || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * @returns {{ blocked: boolean, key?: string }}
 */
export function checkSetupDemotion(path, direction, daCfg, ticker) {
  const enforce = parseEnforceDemotionPaths(
    daCfg?.deep_audit_setup_demotion_enforce_paths ?? "",
  );
  const pathKey = String(path || "").toLowerCase();
  if (!enforce.has(pathKey)) {
    return { blocked: false };
  }
  const indexOnly = String(daCfg?.deep_audit_setup_demotion_index_only ?? "true") === "true";
  const tk = String(ticker || "").trim().toUpperCase();
  const indexTickers = new Set(
    String(daCfg?.deep_audit_index_model_tickers ?? "SPY,QQQ,IWM")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  if (indexOnly && !indexTickers.has(tk)) {
    return { blocked: false };
  }
  const key = setupDemotionConfigKey(path, direction);
  if (!key) return { blocked: false };
  const val = String(daCfg?.[key] ?? "").toLowerCase();
  if (val === "blocked") {
    return { blocked: true, key };
  }
  return { blocked: false };
}
