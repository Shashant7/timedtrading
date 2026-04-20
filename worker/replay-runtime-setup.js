export const REPLAY_DA_KEYS = [
  "deep_audit_short_min_rank", "deep_audit_ticker_blacklist", "deep_audit_max_loss_pct", "deep_audit_sl_cap_mult", "deep_audit_sl_floor_mult", "deep_audit_rsi_tp_delay", "deep_audit_avoid_hours", "deep_audit_block_regime", "deep_audit_vix_ceiling", "deep_audit_regime_size_mult", "deep_audit_min_hold_regime_exit_hours", "deep_audit_loss_cooldown_hours", "deep_audit_min_htf_score", "deep_audit_momentum_elite_rank_boost", "deep_audit_breakout_daily_level_enabled", "deep_audit_breakout_atr_breakout_enabled", "deep_audit_breakout_ema_stack_enabled", "deep_audit_breakout_min_rr", "deep_audit_breakout_min_entry_quality", "deep_audit_opening_noise_end_minute", "deep_audit_min_1h_bias", "deep_audit_min_4h_bias", "deep_audit_ltf_momentum_min_bias", "deep_audit_ltf_momentum_min_rsi", "deep_audit_ripster_opening_noise_end_minute", "deep_audit_ltf_rsi_floor", "deep_audit_min_ltf_ema_depth", "deep_audit_post_trim_breakeven", "deep_audit_stall_max_hours", "deep_audit_stall_breakeven_pnl_pct", "deep_audit_stall_force_close_hours", "deep_audit_soft_fuse_defer_min_1h_depth", "deep_audit_runner_trail_pct", "deep_audit_post_trim_trail_pct", "deep_audit_stale_runner_bars", "deep_audit_momentum_fade_exit", "deep_audit_min_hold_before_mgmt_exit_min", "deep_audit_tp_atr_override", "deep_audit_phase_exit_enabled", "deep_audit_atr_exhaustion_exit", "deep_audit_rvol_ceiling", "deep_audit_rvol_ceiling_short", "deep_audit_rvol_high_threshold", "deep_audit_rvol_high_size_mult", "deep_audit_danger_max_signals", "deep_audit_danger_ema_depth_min", "deep_audit_danger_vix_threshold", "deep_audit_danger_min_st_aligned", "deep_audit_danger_size_mult", "deep_audit_danger_size_threshold", "deep_audit_danger_div_enabled", "deep_audit_div_exit_enabled", "deep_audit_div_exit_min_strength", "deep_audit_div_pivot_lookback", "deep_audit_div_max_age_bars", "deep_audit_div_runner_trail_pct", "deep_audit_mean_revert_td9_enabled", "deep_audit_td_exit_enabled", "deep_audit_td_exit_trail_pct", "deep_audit_td_ltf_trail_pct", "deep_audit_mfe_safety_trim_pct", "deep_audit_max_runner_drawdown_pct", "deep_audit_doa_early_exit_enabled", "deep_audit_confirmed_min_rank", "deep_audit_parity_defer_confirmed_opening_minutes", "deep_audit_legacy_momentum_precedence", "deep_audit_legacy_momentum_min_rr", "deep_audit_legacy_momentum_relax_trigger", "deep_audit_min_entry_quality", "deep_audit_hard_loss_cap", "deep_audit_hard_loss_cap_pct", "deep_audit_breakeven_mfe_threshold", "deep_audit_breakeven_skip_trimmed_runner", "deep_audit_parity_runner_tp_full_only", "deep_audit_parity_skip_stall_force_close", "deep_audit_parity_skip_sl_breach", "deep_audit_parity_no_reentry_after_tp_full_hours", "tier_risk_map", "grade_risk_map", "smart_runner_exit_enabled", "smart_runner_swing_atr_proximity", "smart_runner_min_bars_post_trim", "rank_gate_mode", "doa_gate_enabled", "doa_gate_ema_depth_threshold", "doa_gate_ticker_blacklist", "ai_cio_enabled", "ai_cio_replay_enabled", "ai_cio_reference_enabled", "short_min_rank", "short_require_daily_st_aligned", "short_min_4h_ema_depth", "min_entry_confidence", "entry_ticker_blacklist", "choppy_regime_rank_floor", "tt_spy_directional_gate", "tt_pdz_hard_gate", "deep_audit_phase_peak_extreme", "deep_audit_phase_decline_extreme", "deep_audit_bias_spread_min",
  "smart_runner_td_exhaustion_support_hold_enabled", "deep_audit_phase_leave_runner_trail_atr_mult", "deep_audit_min_minutes_since_entry_before_exit_min", "deep_audit_phase_decline_distrib", "deep_audit_phase_peak_distrib", "deep_audit_peak_reaction_lock_enabled", "deep_audit_pre_earnings_entry_block_enabled", "deep_audit_pullback_bull_state_ltf_conflict_guard_enabled", "deep_audit_pullback_bull_state_ltf_conflict_avg_bias_max", "deep_audit_pullback_min_bearish_count", "deep_audit_pullback_selective_enabled", "deep_audit_pullback_non_prime_min_rank", "deep_audit_pullback_prime_min_rank", "deep_audit_continuation_trigger_enabled", "deep_audit_continuation_trigger_include_tickers", "deep_audit_continuation_trigger_min_rank", "deep_audit_continuation_trigger_max_completion", "deep_audit_continuation_trigger_max_phase", "deep_audit_repeat_churn_guard_enabled", "deep_audit_repeat_churn_guard_include_tickers", "deep_audit_abt_long_quality_guard_enabled", "deep_audit_abt_long_quality_guard_include_tickers", "deep_audit_abt_long_quality_guard_avg_bias_max", "deep_audit_momentum_unfilled_gap_open_chase_guard_enabled", "deep_audit_momentum_unfilled_gap_open_chase_include_tickers", "deep_audit_momentum_unfilled_gap_open_chase_min_gap_pct", "deep_audit_momentum_unfilled_gap_open_chase_max_bars_since_open", "deep_audit_runner_stale_force_close_hours", "deep_audit_ripster_chase_dist_to_cloud_pct", "deep_audit_ripster_chase_rsi10_long", "deep_audit_ripster_chase_rsi30_long", "deep_audit_ripster_momentum_heat_rsi30", "deep_audit_ripster_momentum_heat_rsi1h", "deep_audit_ripster_pullback_trigger_noise_max_loss_pct", "deep_audit_ripster_trigger_noise_max_loss_pct", "deep_audit_reference_exact_entry_leniency", "deep_audit_reference_exact_tolerance_minutes", "deep_audit_swing_checklist_v1", "deep_audit_swing_phase_early_max", "deep_audit_swing_phase_near_zero_abs", "deep_audit_swing_require_squeeze_build", "deep_audit_variant_guardrails_v3", "deep_audit_variant_max_loss_pct", "deep_audit_variant_min_rank", "deep_audit_variant_min_rr", "deep_audit_variant_regime_exit_min_age_min", "deep_audit_agq_pullback_exception_enabled", "deep_audit_agq_pullback_exception_include_tickers", "deep_audit_agq_pullback_weak_consensus_avg_bias_max", "deep_audit_agq_pullback_late_filled_gap_min_bars_since_open", "deep_audit_agq_pullback_late_filled_gap_entry_quality_max",
  // R1 (2026-04-17): configurable PDZ max-loss window before strict normal floor takes over
  "deep_audit_max_loss_pdz_window_min",
  // R2 (2026-04-17): end-of-day flatten guard for trimmed underwater positions
  "deep_audit_eod_trimmed_underwater_flatten_enabled",
  "deep_audit_eod_trimmed_underwater_min_trim_pct",
  "deep_audit_eod_trimmed_underwater_window_min",
  "deep_audit_eod_trimmed_underwater_min_age_min",
  // R2 v3 (2026-04-17): structural MFE-decay guard — fires anywhere with 1H ST flip
  "deep_audit_mfe_decay_flatten_enabled",
  "deep_audit_mfe_decay_peak_min",
  "deep_audit_mfe_decay_giveback_pct_max",
  "deep_audit_mfe_decay_min_age_market_min",
  "deep_audit_mfe_decay_require_1h_st_flip",
  // R5 (2026-04-17): tt_momentum entry-path bias — protect tt_pullback as big-winner source
  "deep_audit_tt_momentum_reject_speculative_grade",
  "deep_audit_tt_momentum_reject_correction_transition",
  // R6 (2026-04-17): MFE-proportional stop trail — lock in progressively more of the peak as MFE grows
  "deep_audit_mfe_trail_enabled",
  "deep_audit_mfe_trail_min_pct",
  "deep_audit_mfe_trail_ratio_low",
  "deep_audit_mfe_trail_ratio_mid",
  "deep_audit_mfe_trail_ratio_high",
  // T6 (2026-04-18): ticker-scoped ETF pullback-depth + non-Prime rank floor
  // overrides. Relaxes two entry gates for SPY/QQQ/IWM/XLY without
  // changing single-stock behaviour. Phase-C 2025-07 probe found these two
  // gates produced 100 % of SPY/QQQ/IWM blocks at setup/in_review stage.
  "deep_audit_pullback_min_bearish_count_index_etf",
  "deep_audit_pullback_min_bearish_count_index_etf_tickers",
  "deep_audit_pullback_non_prime_min_rank_index_etf",
  // Phase-E (2026-04-19): daily-structure-aware gates
  //   - Index ETF swing trigger (SPY/QQQ/IWM Daily-Brief-aligned entry)
  //   - D-EMA overextension universal fakeout gate
  //   - SPY-regime-activated SHORT pullback-depth relaxation
  //   - SPY-regime-activated context gate ctx_short_daily_st_not_bear bypass
  "deep_audit_index_etf_swing_enabled",
  "deep_audit_index_etf_swing_tickers",
  "deep_audit_index_etf_swing_min_score",
  "deep_audit_index_etf_swing_pct_above_e48_min",
  "deep_audit_index_etf_swing_pct_above_e48_max",
  "deep_audit_index_etf_swing_pct_below_e48_min",
  "deep_audit_index_etf_swing_pct_below_e48_max",
  "deep_audit_index_etf_swing_e21_slope_min",
  "deep_audit_index_etf_swing_e21_slope_max",
  "deep_audit_index_etf_swing_rvol_min",
  "deep_audit_d_ema_overextension_gate_enabled",
  "deep_audit_d_ema_long_max_above_e48_pct",
  "deep_audit_d_ema_long_max_e21_slope_pct",
  "deep_audit_d_ema_long_min_e48_slope_pct",
  "deep_audit_d_ema_short_max_below_e48_pct",
  "deep_audit_d_ema_short_max_e21_slope_pct",
  "deep_audit_d_ema_short_max_e48_slope_pct",
  "deep_audit_short_spy_regime_relax_enabled",
  "deep_audit_short_allow_neutral_daily_st_when_spy_bear",
  // Phase-E.2 (2026-04-19): management-side loss-mitigation
  //   F1 — time-scaled max_loss tightening
  //   F2 — PRE_EVENT_RECOVERY_EXIT narrow window + skip-if-in-profit
  //   F3 — runner drawdown cap
  //   F4 — dead-money detector
  "deep_audit_time_scaled_max_loss_enabled",
  "deep_audit_time_scaled_max_loss_4h_pct",
  "deep_audit_time_scaled_max_loss_12h_pct",
  "deep_audit_time_scaled_max_loss_24h_pct",
  "deep_audit_runner_drawdown_cap_enabled",
  "deep_audit_runner_drawdown_cap_pct",
  "deep_audit_dead_money_exit_enabled",
  "deep_audit_dead_money_age_market_min",
  "deep_audit_dead_money_mfe_max_pct",
  "deep_audit_dead_money_pnl_max_pct",
  "deep_audit_pre_event_recovery_skip_if_profit_enabled",
  "deep_audit_pre_event_recovery_skip_if_profit_min_pnl_pct",
  // Phase-E.3 (2026-04-19): cohort-aware entry thresholds derived from
  // 150-trade pattern-mining analysis. Tightens ETF gates where flat
  // slopes bleed P&L, relaxes mega-cap/speculative gates where extended
  // or overbought conditions are historically green.
  "deep_audit_cohort_overlay_enabled",
  "deep_audit_cohort_index_etf_tickers",
  "deep_audit_cohort_megacap_tickers",
  "deep_audit_cohort_industrial_tickers",
  "deep_audit_cohort_speculative_tickers",
  "deep_audit_cohort_sector_etf_tickers",
  "deep_audit_cohort_sector_etf_pause_enabled",
  "deep_audit_cohort_slope_min_index_etf",
  "deep_audit_cohort_extension_max_index_etf",
  "deep_audit_cohort_rsi_max_index_etf",
  "deep_audit_cohort_slope_min_megacap",
  "deep_audit_cohort_extension_max_megacap",
  "deep_audit_cohort_slope_min_industrial",
  "deep_audit_cohort_extension_max_industrial",
  "deep_audit_cohort_rsi_neutral_block_industrial",
  "deep_audit_cohort_slope_min_speculative",
  "deep_audit_cohort_extension_max_speculative",
  // Phase-F (2026-04-20): SHORT-side activation
  //   F8 — invert d_ema_short_overextended (pay zone vs rejection zone)
  //   F9 — spy-bear bypass for d_ema_short_flat_structure
  //   F10 — accept daily structural bear as substitute for daily ST flag
  //   F11 — SHORT cohort overlay (mirror of LONG)
  //   F12 — relax tt_short_pullback_not_deep_enough to 0-of-3 when
  //         both SPY and ticker are bear-stacked
  "deep_audit_d_ema_short_capitulation_slope_pct",
  "deep_audit_short_accept_structural_bear_substitute",
  "deep_audit_cohort_short_slope_max_index_etf",
  "deep_audit_cohort_short_extension_min_index_etf",
  "deep_audit_cohort_short_rsi_min_index_etf",
  "deep_audit_cohort_short_slope_max_megacap",
  "deep_audit_cohort_short_extension_min_megacap",
  "deep_audit_cohort_short_rsi_min_megacap",
  "deep_audit_cohort_short_slope_max_industrial",
  "deep_audit_cohort_short_extension_min_industrial",
  "deep_audit_cohort_short_rsi_min_industrial",
  "deep_audit_cohort_short_slope_max_speculative",
  "deep_audit_cohort_short_extension_min_speculative",
  "deep_audit_cohort_short_rsi_min_speculative",
  "deep_audit_short_full_bear_relax_enabled",
  "deep_audit_short_bypass_4h_depth_when_bear_structure",
  "golden_julaug_reference_run_id", "live_config_run_id", "member_ticker_list", "consensus_signal_weights", "consensus_tf_weights", "scoring_weight_adj",
];

const REPLAY_CFG_KEYS = [
  "adaptive_entry_gates",
  "adaptive_regime_gates",
  "adaptive_sl_tp",
  "calibrated_sl_atr",
  "calibrated_tp_tiers",
  "calibrated_rank_min",
  "adaptive_rank_weights",
];

async function loadRunConfigSubset(db, runId, keys = []) {
  // Read all rows for the run and filter in JS. The previous implementation
  // used an `IN (?,?,…)` filter which exceeds Cloudflare D1's bind-parameter
  // cap (~100) once REPLAY_DA_KEYS passes ~90 entries, silently throwing and
  // forcing every pinned-config consumer into a live-model fallback.
  const rid = String(runId || "").trim();
  if (!db || !rid) return null;
  try {
    const rows = (await db.prepare(
      `SELECT config_key, config_value FROM backtest_run_config WHERE run_id = ?1`
    ).bind(rid).all())?.results || [];
    if (!rows.length) return null;
    const allowed = Array.isArray(keys) && keys.length > 0
      ? new Set(keys.map((key) => String(key || "").trim()).filter(Boolean))
      : null;
    const out = {};
    for (const row of rows) {
      const key = row?.config_key;
      if (!key) continue;
      if (!allowed || allowed.has(key)) out[key] = row.config_value;
    }
    return Object.keys(out).length ? out : null;
  } catch (error) {
    console.warn(
      `[REPLAY] loadRunConfigSubset failed for run_id=${rid}: ${String(error?.message || error).slice(0, 300)}`
    );
    return null;
  }
}

async function loadActiveExperimentRunId(db) {
  if (!db) return null;
  try {
    const row = await db.prepare(
      `SELECT run_id
         FROM backtest_runs
        WHERE active_experiment_slot = 1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 1`
    ).first();
    return String(row?.run_id || "").trim() || null;
  } catch (error) {
    console.warn(
      `[REPLAY] loadActiveExperimentRunId failed: ${String(error?.message || error).slice(0, 300)}`
    );
    return null;
  }
}

async function runRecordExists(db, runId) {
  const rid = String(runId || "").trim();
  if (!db || !rid) return false;
  try {
    const row = await db.prepare(
      `SELECT run_id
         FROM backtest_runs
        WHERE run_id = ?1
        LIMIT 1`
    ).bind(rid).first();
    return String(row?.run_id || "").trim() === rid;
  } catch (error) {
    console.warn(
      `[REPLAY] runRecordExists failed for run_id=${rid}: ${String(error?.message || error).slice(0, 300)}`
    );
    return false;
  }
}

function extractReplayLockReason(lockValue) {
  const raw = String(lockValue || "").trim();
  if (!raw) return null;
  const atIdx = raw.indexOf("@");
  return atIdx >= 0 ? raw.slice(0, atIdx).trim() || null : raw;
}

function extractRunnerRunId(lockValue) {
  const reason = extractReplayLockReason(lockValue);
  if (!reason) return null;
  if (reason.startsWith("backtest_runner:")) {
    return reason.slice("backtest_runner:".length).trim() || null;
  }
  return reason;
}

export async function resolveReplayRunId(db, replayLockVal, opts = {}) {
  const runIdHint = String(opts?.runIdHint || "").trim() || null;
  if (runIdHint) {
    return { runId: runIdHint, source: "run_id_hint" };
  }

  const rawLock = String(replayLockVal || "").trim() || null;
  if (rawLock && await runRecordExists(db, rawLock)) {
    return { runId: rawLock, source: "lock" };
  }

  const runnerRunId = extractRunnerRunId(rawLock);
  if (runnerRunId && await runRecordExists(db, runnerRunId)) {
    return { runId: runnerRunId, source: "lock_reason" };
  }

  const activeRunId = await loadActiveExperimentRunId(db);
  if (activeRunId) {
    return { runId: activeRunId, source: "active_experiment_slot" };
  }

  return { runId: rawLock, source: rawLock ? "lock_fallback" : "none" };
}

export async function resolveReplayPinnedConfig(db, replayLockVal, keys = [], opts = {}) {
  const logPrefix = String(opts?.logPrefix || "[REPLAY]");
  const lockRunId = String(replayLockVal || "").trim() || null;
  if (lockRunId) {
    const lockConfig = await loadRunConfigSubset(db, lockRunId, keys);
    if (lockConfig && Object.keys(lockConfig).length > 0) {
      return { runId: lockRunId, config: lockConfig, source: "lock" };
    }
  }

  const activeRunId = await loadActiveExperimentRunId(db);
  if (activeRunId && activeRunId !== lockRunId) {
    const activeConfig = await loadRunConfigSubset(db, activeRunId, keys);
    if (activeConfig && Object.keys(activeConfig).length > 0) {
      console.warn(`${logPrefix} Falling back to active experiment slot config from ${activeRunId}`);
      return { runId: activeRunId, config: activeConfig, source: "active_experiment_slot" };
    }
  }

  // Explicitly flag the live-model fallback: this is the state that silently
  // masked Bug C for days. If the caller expected a pinned run snapshot, the
  // absence of this line in tails is the first hint something is off.
  if (lockRunId) {
    console.warn(
      `${logPrefix} No pinned config found for run_id=${lockRunId}; falling back to live model_config`
    );
  }
  return { runId: lockRunId, config: null, source: "live_fallback" };
}

function replayConfigHasKey(runConfig, key) {
  return !!runConfig && Object.prototype.hasOwnProperty.call(runConfig, key);
}

async function loadModelConfigValue(db, key) {
  if (!db || !key) return null;
  try {
    const row = await db.prepare(`SELECT config_value FROM model_config WHERE config_key = ?1`).bind(String(key)).first();
    return row?.config_value ?? null;
  } catch (error) {
    console.warn(
      `[REPLAY] loadModelConfigValue failed for key=${String(key)}: ${String(error?.message || error).slice(0, 300)}`
    );
    return null;
  }
}

export async function loadReplayConfigValue(db, runConfig, key, opts = {}) {
  const allowLiveFallback = opts.allowLiveFallback !== false;
  const warnPrefix = opts.warnPrefix || "[REPLAY]";
  if (replayConfigHasKey(runConfig, key)) return runConfig[key];
  if (runConfig && !allowLiveFallback) {
    console.warn(`${warnPrefix} Missing pinned config key ${String(key)}; live fallback disabled`);
    return null;
  }
  return loadModelConfigValue(db, key);
}

export async function loadReplayRuntimeConfig(args = {}) {
  const {
    db,
    KV,
    replayConfigRunHint,
    directConfigOverride = null,
    replayEnv = null,
    logPrefix = "[REPLAY]",
    pinnedConfigExtraKeys = [],
    disableReferenceExecution = false,
  } = args;

  const replayPinnedConfigKeys = [...new Set([
    ...REPLAY_CFG_KEYS,
    ...REPLAY_DA_KEYS,
    "dynamic_engine_rules",
    "reference_execution_map",
    "scenario_execution_policy",
    ...pinnedConfigExtraKeys,
  ])];

  const replayPinnedConfig = directConfigOverride
    ? { config: directConfigOverride, runId: replayConfigRunHint || "direct_override", source: "direct_override" }
    : await resolveReplayPinnedConfig(db, replayConfigRunHint, replayPinnedConfigKeys, { logPrefix });
  const replayRunConfig = replayPinnedConfig.config;
  const replayConfigRunId = replayPinnedConfig.runId;
  const replayConfigValue = (key) => replayRunConfig?.[key];

  if (replayRunConfig) {
    const replayConfigSource = replayPinnedConfig.source === "direct_override" ? "direct override" : "archive";
    console.log(`${logPrefix} Using pinned run config from ${replayConfigSource} for ${replayConfigRunId} (${Object.keys(replayRunConfig).length} keys)`);
  }

  let replayAdaptiveEntryGates = null;
  let replayAdaptiveRegimeGates = null;
  let replayAdaptiveSLTP = null;
  let replayCalibratedSlAtr = 0;
  let replayCalibratedRankMin = 0;
  let calibratedTPTiers = null;

  try {
    const cfgValues = replayRunConfig
      ? REPLAY_CFG_KEYS.map((key) => replayConfigValue(key))
      : (await db.batch(REPLAY_CFG_KEYS.map((key) => db.prepare(`SELECT config_value FROM model_config WHERE config_key=?1`).bind(key))))
          .map((row) => row?.results?.[0]?.config_value);
    if (cfgValues[0]) replayAdaptiveEntryGates = JSON.parse(cfgValues[0]);
    if (cfgValues[1]) replayAdaptiveRegimeGates = JSON.parse(cfgValues[1]);
    if (cfgValues[2]) replayAdaptiveSLTP = JSON.parse(cfgValues[2]);
    if (cfgValues[3]) replayCalibratedSlAtr = Number(cfgValues[3]) || 0;
    if (cfgValues[4]) {
      const tpRaw = JSON.parse(cfgValues[4]);
      const sltpDefault = replayAdaptiveSLTP?.["_default"] || {};
      if (sltpDefault.tp_trim_atr && sltpDefault.tp_exit_atr && sltpDefault.tp_runner_atr) {
        calibratedTPTiers = {
          trim: sltpDefault.tp_trim_atr,
          exit: sltpDefault.tp_exit_atr,
          runner: sltpDefault.tp_runner_atr,
        };
      } else if (tpRaw) {
        calibratedTPTiers = tpRaw;
      }
    }
    if (cfgValues[5]) replayCalibratedRankMin = Number(cfgValues[5]) || 0;
  } catch (error) {
    console.warn(
      `[REPLAY] adaptive entry/regime/SLTP config load failed (runConfig=${replayRunConfig ? "pinned" : "live"}): ${String(error?.message || error).slice(0, 300)}`
    );
  }

  let deepAuditConfig = {};
  try {
    if (replayRunConfig) {
      for (const key of REPLAY_DA_KEYS) {
        const value = replayConfigValue(key);
        if (value == null) continue;
        try { deepAuditConfig[key] = JSON.parse(value); } catch { deepAuditConfig[key] = value; }
      }
    } else {
      // Read all model_config rows and post-filter in JS. The previous
      // `WHERE config_key IN (?,?,…)` form exceeds D1's bind-parameter cap
      // once REPLAY_DA_KEYS passes ~90 entries and silently returns nothing,
      // leaving deepAuditConfig empty for the entire run.
      const daAllowed = new Set(REPLAY_DA_KEYS);
      const daRows = (await db.prepare(
        `SELECT config_key, config_value FROM model_config`
      ).all())?.results || [];
      for (const row of daRows) {
        const key = row?.config_key;
        if (!key || !daAllowed.has(key)) continue;
        try { deepAuditConfig[key] = JSON.parse(row.config_value); } catch { deepAuditConfig[key] = row.config_value; }
      }
    }
  } catch (error) {
    console.warn(
      `[REPLAY] deepAuditConfig load failed (runConfig=${replayRunConfig ? "pinned" : "live"}): ${String(error?.message || error).slice(0, 300)}`
    );
  }

  let dynamicEngineRules = null;
  try {
    const value = await loadReplayConfigValue(db, replayRunConfig, "dynamic_engine_rules", {
      allowLiveFallback: false,
      warnPrefix: logPrefix,
    });
    if (value) dynamicEngineRules = JSON.parse(value);
  } catch (error) {
    console.warn(
      `${logPrefix} dynamic_engine_rules load/parse failed: ${String(error?.message || error).slice(0, 300)}`
    );
  }

  let referenceExecutionMap = null;
  try {
    const value = await loadReplayConfigValue(db, replayRunConfig, "reference_execution_map", {
      allowLiveFallback: false,
      warnPrefix: logPrefix,
    });
    if (value) referenceExecutionMap = JSON.parse(value);
  } catch (error) {
    console.warn(
      `${logPrefix} reference_execution_map load/parse failed: ${String(error?.message || error).slice(0, 300)}`
    );
  }

  let scenarioExecutionPolicy = null;
  try {
    const value = await loadReplayConfigValue(db, replayRunConfig, "scenario_execution_policy", {
      allowLiveFallback: false,
      warnPrefix: logPrefix,
    });
    if (value) scenarioExecutionPolicy = JSON.parse(value);
  } catch (error) {
    console.warn(
      `${logPrefix} scenario_execution_policy load/parse failed: ${String(error?.message || error).slice(0, 300)}`
    );
  }

  let goldenProfiles = null;
  try {
    goldenProfiles = (await KV.get("timed:calibration:golden-profiles", "json"))?.profiles || null;
  } catch (error) {
    console.warn(
      `${logPrefix} goldenProfiles KV fetch failed: ${String(error?.message || error).slice(0, 300)}`
    );
  }

  if (replayEnv) {
    replayEnv._adaptiveEntryGates = replayAdaptiveEntryGates;
    replayEnv._adaptiveRegimeGates = replayAdaptiveRegimeGates;
    replayEnv._adaptiveSLTP = replayAdaptiveSLTP;
    replayEnv._calibratedSlAtr = replayCalibratedSlAtr;
    replayEnv._calibratedRankMin = replayCalibratedRankMin;
    replayEnv._goldenProfiles = goldenProfiles;
    replayEnv._deepAuditConfig = deepAuditConfig;
    replayEnv._referenceExecutionMap = disableReferenceExecution ? null : referenceExecutionMap;
    replayEnv._scenarioExecutionPolicy = scenarioExecutionPolicy;
  }

  return {
    replayPinnedConfig,
    replayRunConfig,
    replayConfigRunId,
    replayAdaptiveEntryGates,
    replayAdaptiveRegimeGates,
    replayAdaptiveSLTP,
    replayCalibratedSlAtr,
    replayCalibratedRankMin,
    calibratedTPTiers,
    deepAuditConfig,
    dynamicEngineRules,
    referenceExecutionMap,
    scenarioExecutionPolicy,
    goldenProfiles,
  };
}

export async function loadReplayTickerProfiles(db, batchTickers = [], opts = {}) {
  const logPrefix = String(opts?.logPrefix || "[REPLAY]");
  const out = {};
  try {
    if (batchTickers.length > 0) {
      const profilePlaceholders = batchTickers.map((_, idx) => `?${idx + 1}`).join(",");
      const { results: profRows } = await db.prepare(
        `SELECT ticker, behavior_type, sl_mult, tp_mult, entry_threshold_adj, atr_pct_p50,
                trend_persistence, ichimoku_responsiveness, learning_json
           FROM ticker_profiles
          WHERE ticker IN (${profilePlaceholders})`
      ).bind(...batchTickers.map((ticker) => String(ticker || "").toUpperCase())).all();
      for (const row of (profRows || [])) out[row.ticker] = row;
    }
    if (Object.keys(out).length > 0) {
      console.log(`${logPrefix} Loaded ${Object.keys(out).length} ticker profiles for personality-aware SL/TP`);
    }
  } catch (error) {
    console.warn(
      `${logPrefix} loadReplayTickerProfiles failed for ${batchTickers.length} tickers: ${String(error?.message || error).slice(0, 300)}`
    );
  }
  return out;
}

function mapArchivedReplayTrade(row, replayLockVal) {
  return {
    id: row.trade_id,
    trade_id: row.trade_id,
    ticker: row.ticker,
    direction: row.direction,
    entry_ts: row.entry_ts,
    entryPrice: row.entry_price,
    entry_price: row.entry_price,
    rank: row.rank,
    rr: row.rr,
    status: row.status,
    exit_ts: row.exit_ts,
    exitPrice: row.exit_price,
    exit_price: row.exit_price,
    exitReason: row.exit_reason,
    exit_reason: row.exit_reason,
    trimmedPct: row.trimmed_pct,
    trimmed_pct: row.trimmed_pct,
    pnl: row.pnl,
    pnlPct: row.pnl_pct,
    pnl_pct: row.pnl_pct,
    trim_ts: row.trim_ts,
    trim_price: row.trim_price,
    setupName: row.setup_name,
    setup_name: row.setup_name,
    setupGrade: row.setup_grade,
    setup_grade: row.setup_grade,
    riskBudget: row.risk_budget,
    risk_budget: row.risk_budget,
    shares: row.shares,
    notional: row.notional,
    run_id: replayLockVal,
  };
}

export async function loadReplayScopedTrades(args = {}) {
  const {
    env,
    KV,
    db,
    replayLockVal,
    replayTradeScope,
    cleanReplayLane = false,
    resetTrades = false,
    logPrefix = "[REPLAY]",
    scopeDropLabel = "before replay",
    deps = {},
  } = args;
  const {
    kvGetJSON,
    kvPutJSON,
    d1EnsureBacktestRunsSchema,
    sanitizeReplayTradesForScope,
    REPLAY_TRADES_KV_KEY,
  } = deps;

  const replayTradesKey = String(REPLAY_TRADES_KV_KEY || "");
  if (!kvGetJSON || !kvPutJSON || !d1EnsureBacktestRunsSchema || !sanitizeReplayTradesForScope || !replayTradesKey) {
    throw new Error("loadReplayScopedTrades missing required dependencies");
  }

  let allTrades = resetTrades ? [] : ((await kvGetJSON(KV, replayTradesKey)) || []);
  if (!cleanReplayLane && (!allTrades || allTrades.length === 0) && replayLockVal && db) {
    try {
      await d1EnsureBacktestRunsSchema(env);
      const { results: archiveRows } = await db.prepare(
        `SELECT trade_id, ticker, direction, entry_ts, entry_price, rank, rr, status,
                exit_ts, exit_price, exit_reason, trimmed_pct, pnl, pnl_pct,
                trim_ts, trim_price, setup_name, setup_grade, risk_budget, shares, notional
         FROM backtest_run_trades WHERE run_id = ?1`
      ).bind(replayLockVal).all();
      if (archiveRows && archiveRows.length > 0) {
        allTrades = archiveRows.map((row) => mapArchivedReplayTrade(row, replayLockVal));
        await kvPutJSON(KV, replayTradesKey, allTrades);
        console.log(`${logPrefix} Restored ${allTrades.length} trades from archive for run ${replayLockVal}`);
      }
    } catch (e) {
      console.warn(`${logPrefix} Archive load failed:`, String(e).slice(0, 150));
    }
  }

  const scopedTrades = sanitizeReplayTradesForScope(allTrades, replayTradeScope);
  if (scopedTrades.length !== allTrades.length) {
    console.warn(`${logPrefix.replace(/\]$/, "")} SCOPE] Dropped ${allTrades.length - scopedTrades.length} out-of-scope trade(s) ${scopeDropLabel}`);
  }

  return {
    allTrades,
    scopedTrades,
  };
}

export async function loadReplayTickerState(args = {}) {
  const {
    db,
    KV,
    ticker,
    skipKv = false,
    skipDbFallback = false,
    logPrefix = "[REPLAY]",
    deps = {},
  } = args;
  const { kvGetJSON } = deps;
  if (!ticker || !kvGetJSON) throw new Error("loadReplayTickerState missing required dependencies");

  let existing = null;
  if (!skipKv) {
    existing = await kvGetJSON(KV, `timed:latest:${ticker}`);
  }
  if ((!existing || Object.keys(existing).length === 0) && !skipDbFallback && db) {
    try {
      const row = await db.prepare(
        `SELECT payload_json FROM ticker_latest WHERE ticker = ?`
      ).bind(String(ticker).toUpperCase()).first();
      if (row?.payload_json) {
        existing = JSON.parse(row.payload_json);
        console.log(`${logPrefix} Loaded state for ${ticker} from D1 (KV was empty)`);
      }
    } catch (error) {
      console.warn(
        `${logPrefix} ticker_latest D1 load failed for ${String(ticker).toUpperCase()}: ${String(error?.message || error).slice(0, 300)}`
      );
    }
  }
  return existing || {};
}

export async function prepareCandleReplayBatch(args = {}) {
  const {
    env,
    KV,
    db,
    url,
    dateParam,
    fullDay,
    tickerOffset,
    batchTickers,
    allTickers,
    replayLeadingLtf,
    replayEnv,
    marketCloseMs,
    cleanSlate,
    freshRun,
    deps = {},
  } = args;
  const {
    loadRunManifest,
    buildReplayTradeScope,
    isRunManifestCleanLane,
    kvPutJSON,
    d1GetCandlesAllTfs,
    kvGetJSON,
    d1EnsureBacktestRunsSchema,
    sanitizeReplayTradesForScope,
    loadReplayScopedTrades,
    loadReplayTickerState,
  } = deps;
  const replayTradesKey = String(deps.REPLAY_TRADES_KV_KEY || "");
  if (!loadRunManifest || !buildReplayTradeScope || !isRunManifestCleanLane || !kvPutJSON || !d1GetCandlesAllTfs || !kvGetJSON || !d1EnsureBacktestRunsSchema || !sanitizeReplayTradesForScope || !loadReplayScopedTrades || !loadReplayTickerState || !replayTradesKey) {
    throw new Error("prepareCandleReplayBatch missing required dependencies");
  }

  const replayLockVal = await KV.get("timed:replay:lock") || null;
  const runIdHint = String(url.searchParams.get("runId") || "").trim() || null;
  const { runId: replayRunId } = await resolveReplayRunId(db, replayLockVal, { runIdHint });
  const replayConfigRunHint = replayRunId || replayLockVal || null;
  const replayManifest = replayRunId ? await loadRunManifest(db, replayRunId) : null;
  const replayTradeScope = buildReplayTradeScope(replayManifest);
  const cleanReplayLane = !!(freshRun || cleanSlate || isRunManifestCleanLane(replayManifest));
  await kvPutJSON(KV, "timed:replay:running", { since: Date.now(), date: dateParam, offset: tickerOffset, fullDay: !!fullDay });

  if (cleanSlate && tickerOffset === 0) {
    await kvPutJSON(KV, "timed:trades:all", []);
    await kvPutJSON(KV, replayTradesKey, []);
    await kvPutJSON(KV, "timed:portfolio:v1", null);
    await kvPutJSON(KV, "timed:activity:feed", null);
    await Promise.allSettled(
      allTickers.map((ticker) => KV.delete(`timed:latest:${ticker}`))
    );

    if (db) {
      try {
        await db.batch([
          db.prepare("DELETE FROM trade_events"),
          db.prepare("DELETE FROM trades"),
        ]);
        console.log("[REPLAY cleanSlate] Purged D1 trade_events + trades (archive tables preserved)");
      } catch (d1Err) {
        console.warn("[REPLAY cleanSlate] D1 trades purge error:", String(d1Err?.message || d1Err).slice(0, 200));
      }
      for (const tbl of ["positions", "execution_actions", "lots", "alerts", "ticker_latest", "account_ledger", "investor_positions", "investor_lots", "portfolio_snapshots"]) {
        try {
          await db.prepare(`DELETE FROM ${tbl}`).run();
        } catch (error) {
          console.warn(
            `[REPLAY cleanSlate] DELETE FROM ${tbl} failed (table may not exist): ${String(error?.message || error).slice(0, 200)}`
          );
        }
      }
    }
  }

  const replayTfs = [...new Set(["M", "W", "D", "240", "60", "30", "15", "10", replayLeadingLtf])];
  const replayTfLimits = { M: 200, W: 300, D: 600, "240": 600, "60": 600, "30": 600, "15": 600, "10": 500 };
  const candleCache = {};

  await Promise.all(
    batchTickers.map(async (ticker) => {
      candleCache[ticker] = {};
      try {
        const tfConfigs = replayTfs.map((tf) => ({ tf, limit: replayTfLimits[tf] || 600 }));
        const batchResult = await d1GetCandlesAllTfs(replayEnv, ticker, tfConfigs, { beforeTs: marketCloseMs });
        for (const tf of replayTfs) {
          const res = batchResult[tf];
          candleCache[ticker][tf] = (res?.ok && Array.isArray(res.candles)) ? res.candles : [];
        }
      } catch {
        for (const tf of replayTfs) candleCache[ticker][tf] = [];
      }
    })
  );

  const { scopedTrades: initialReplayTrades } = await loadReplayScopedTrades({
    env,
    KV,
    db,
    replayLockVal,
    replayTradeScope,
    cleanReplayLane,
    resetTrades: cleanSlate && tickerOffset === 0,
    logPrefix: "[REPLAY RESUME]",
    scopeDropLabel: `before ${dateParam}`,
    deps: {
      kvGetJSON,
      kvPutJSON,
      d1EnsureBacktestRunsSchema,
      sanitizeReplayTradesForScope,
      REPLAY_TRADES_KV_KEY: replayTradesKey,
    },
  });

  const replayCtx = {
    allTrades: initialReplayTrades,
    execStates: new Map(),
    sessionScoreSeeds: new Map(),
    processDebug: [],
    candleCache,
    _blockedEntries: {},
    _leadingLtf: replayLeadingLtf,
    replayTradeScope,
    strictSingleTickerPosition: cleanReplayLane,
  };
  const sanitizeReplayTickerState = (existing) => {
    if (!existing || typeof existing !== "object") return {};
    const clean = { ...existing };
    for (const key of [
      "_env",
      "_marketInternals",
      "_tickerProfile",
      "__entry_block_reason",
      "__entry_block_fuel_pct",
    ]) {
      delete clean[key];
    }
    return clean;
  };
  const stripReplayCarryState = (existing) => {
    if (!existing || typeof existing !== "object") return {};
    const clean = sanitizeReplayTickerState(existing);
    for (const key of [
      "entry_ts",
      "entry_price",
      "trigger_ts",
      "trigger_price",
      "kanban_stage",
      "prev_kanban_stage",
      "prev_kanban_stage_ts",
      "kanban_meta",
      "kanban_cycle_enter_now_ts",
      "kanban_cycle_trigger_ts",
      "kanban_cycle_side",
      "move_status",
      "__entry_block_reason",
      "__entry_block_fuel_pct",
      "__position_context",
    ]) {
      delete clean[key];
    }
    return clean;
  };

  const stateMap = {};
  for (const ticker of batchTickers) {
    const existing = await loadReplayTickerState({
      db,
      KV,
      ticker,
      skipKv: cleanSlate && tickerOffset === 0,
      skipDbFallback: cleanSlate && tickerOffset === 0,
      logPrefix: "[REPLAY]",
      deps: { kvGetJSON },
    });
    stateMap[ticker] = sanitizeReplayTickerState(existing);
  }

  return {
    replayLockVal,
    replayRunId,
    replayConfigRunHint,
    replayManifest,
    replayTradeScope,
    cleanReplayLane,
    replayTfs,
    replayTfLimits,
    candleCache,
    replayCtx,
    stateMap,
    sanitizeReplayTickerState,
    stripReplayCarryState,
  };
}
