/**
 * Learning-bus setup demotion keys (deep_audit_setup_demotion_*).
 * Keys use display names from SETUP_NAME_MAP, e.g.
 *   deep_audit_setup_demotion_TT ATH Breakout_long
 *
 * 2026-07-23 — Production autopsy: demotions were inert because
 *   (1) dynamic keys never loaded into daCfg (REPLAY_DA_KEYS filter),
 *   (2) check required enforce_paths membership before reading blocked,
 *   (3) index_only defaulted true (single-name bleeders never blocked),
 *   (4) mangled keys like "TT Tt Ath Breakout" were written by early
 *       proposals and never matched setupDemotionConfigKey().
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

/** Paths the weekly governor may auto-pause when PF is catastrophic. */
export const SEVERE_BLEEDER_PATHS = Object.freeze([
  "tt_ath_breakout",
  "tt_n_test_support",
  "tt_range_reversal_long",
]);

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
 * Merge path into comma-separated enforce_paths (deduped, stable order).
 */
export function mergeEnforceDemotionPaths(existing, pathsToAdd) {
  const set = parseEnforceDemotionPaths(existing);
  for (const p of pathsToAdd || []) {
    const k = String(p || "").trim().toLowerCase();
    if (k) set.add(k);
  }
  return [...set].sort().join(",");
}

/**
 * Resolve whether a demotion key is blocked, including legacy mangled spellings
 * that share the same path+direction after normalization.
 */
export function isDemotionKeyBlocked(daCfg, path, direction) {
  const canonical = setupDemotionConfigKey(path, direction);
  if (!canonical) return { blocked: false };
  const cfg = daCfg || {};
  const direct = String(cfg[canonical] ?? "").toLowerCase();
  if (direct === "blocked") return { blocked: true, key: canonical };

  // Heal-read: any key that demotionProposalConfigKey would map to this path.
  const dir = String(direction || "").toLowerCase().trim();
  for (const [k, v] of Object.entries(cfg)) {
    if (!k.startsWith("deep_audit_setup_demotion_")) continue;
    if (String(v).toLowerCase() !== "blocked") continue;
    // Strip prefix + _dir suffix and re-canonicalize.
    const body = k.slice("deep_audit_setup_demotion_".length);
    const m = body.match(/^(.*)_([a-z]+)$/i);
    if (!m) continue;
    if (String(m[2]).toLowerCase() !== dir) continue;
    const mapped = demotionProposalConfigKey(m[1], dir);
    if (mapped === canonical) return { blocked: true, key: k };
  }
  return { blocked: false, key: canonical };
}

/**
 * @returns {{ blocked: boolean, key?: string }}
 */
export function checkSetupDemotion(path, direction, daCfg, ticker) {
  const pathKey = String(path || "").toLowerCase();
  const hit = isDemotionKeyBlocked(daCfg, path, direction);
  const enforce = parseEnforceDemotionPaths(
    daCfg?.deep_audit_setup_demotion_enforce_paths ?? "",
  );

  // 2026-07-23: a loaded `blocked` marker is authoritative. enforce_paths is
  // still honored as an explicit allow-list of paths under demotion review,
  // but it is no longer required before a blocked key takes effect.
  if (!hit.blocked && !enforce.has(pathKey)) {
    return { blocked: false };
  }
  if (!hit.blocked) {
    return { blocked: false, key: hit.key };
  }

  // Default flipped to false — single-name bleeders were the June/July drag.
  // Operators can still set index_only=true for index-model-only pauses.
  const indexOnly = String(daCfg?.deep_audit_setup_demotion_index_only ?? "false") === "true";
  if (indexOnly) {
    const tk = String(ticker || "").trim().toUpperCase();
    const indexTickers = new Set(
      String(daCfg?.deep_audit_index_model_tickers ?? "SPY,QQQ,IWM")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
    if (!indexTickers.has(tk)) {
      return { blocked: false, key: hit.key };
    }
  }
  return { blocked: true, key: hit.key };
}

/**
 * Rows to upsert when healing mangled / incomplete demotion config.
 * Pure — caller writes to D1.
 */
export function buildDemotionHealUpserts(opts = {}) {
  const paths = opts.paths || SEVERE_BLEEDER_PATHS;
  const direction = String(opts.direction || "long").toLowerCase();
  const now = Number(opts.now) || Date.now();
  const enforce = mergeEnforceDemotionPaths(
    opts.existingEnforcePaths || "",
    paths,
  );
  const rows = [
    {
      config_key: "deep_audit_setup_demotion_enforce_paths",
      config_value: JSON.stringify(enforce),
      description: "Paths subject to setup demotion (weekly governor heal)",
      updated_at: now,
      updated_by: opts.updatedBy || "weekly_governor_heal",
    },
    {
      config_key: "deep_audit_setup_demotion_index_only",
      config_value: JSON.stringify("false"),
      description: "Demote single-name bleeders, not just index tickers",
      updated_at: now,
      updated_by: opts.updatedBy || "weekly_governor_heal",
    },
  ];
  for (const path of paths) {
    const key = setupDemotionConfigKey(path, direction);
    if (!key) continue;
    rows.push({
      config_key: key,
      config_value: JSON.stringify("blocked"),
      description: `Auto-demote ${path} ${direction} (severe bleeder heal)`,
      updated_at: now,
      updated_by: opts.updatedBy || "weekly_governor_heal",
    });
  }
  return { enforce, rows };
}
