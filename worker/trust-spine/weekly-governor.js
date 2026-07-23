// Weekly / nightly PnL governor — close Discovery → Calibration → capital.
// plans/wow-pnl-adaptive-governor.plan.md
//
// Observes edge scorecard + family attribution + WoW PnL, then:
//   • heals inert demotion config
//   • auto-demotes severe bleeders when flag ON (default ON for PF<0.5, n>=10)
//   • emits tier2 learning proposals for milder cases / widen blocks
// Never touches hard SL paths. Never widens capital when WoW regresses.

import { findDemotionCandidates } from "../edge-scorecard.js";
import {
  SEVERE_BLEEDER_PATHS,
  buildDemotionHealUpserts,
  demotionProposalConfigKey,
  mergeEnforceDemotionPaths,
  setupDemotionConfigKey,
} from "../pipeline/setup-demotion.js";
import { loadFamilyAttribution } from "./family-attribution.js";

const DAY_MS = 86400000;
const KV_KEY = "timed:weekly-governor:latest";

export function loadWeeklyGovernorConfig(daCfg = {}) {
  const enabledRaw = daCfg.deep_audit_weekly_governor_enabled;
  const enabled = enabledRaw == null
    ? true
    : String(enabledRaw).toLowerCase() !== "false";
  const autoDemoteRaw = daCfg.deep_audit_weekly_governor_auto_demote;
  const autoDemote = autoDemoteRaw == null
    ? true
    : String(autoDemoteRaw).toLowerCase() !== "false";
  const healRaw = daCfg.deep_audit_weekly_governor_heal_demotions;
  const healDemotions = healRaw == null
    ? true
    : String(healRaw).toLowerCase() !== "false";
  return {
    enabled,
    autoDemote,
    healDemotions,
    severeMinN: Number(daCfg.deep_audit_weekly_governor_severe_min_n) || 10,
    severeMaxPf: Number(daCfg.deep_audit_weekly_governor_severe_max_pf) || 0.5,
    blockWiden: String(daCfg.deep_audit_weekly_governor_block_widen ?? "false") === "true",
    convictionMinClosed: Number(daCfg.deep_audit_weekly_governor_conviction_min_closed) || 30,
    convictionKeepFloor: Number(daCfg.deep_audit_weekly_governor_conviction_keep_floor) || 0.35,
    moveEndingMinClosed: Number(daCfg.deep_audit_move_ending_min_closed_n) || 30,
    moveEndingKeepFloor: Number(daCfg.deep_audit_move_ending_keep_rate_floor) || 0.35,
    autoPromoteConviction: String(daCfg.deep_audit_weekly_governor_auto_promote_conviction ?? "true") === "true",
    autoPromoteMoveEnding: String(daCfg.deep_audit_weekly_governor_auto_promote_move_ending ?? "true") === "true",
  };
}

/** Pure gate: may we widen conviction fusion / move-ending enforce? */
export function canPromoteWidenLevers(family, wow, cfg = {}) {
  const closed = Number(family?.closed) || 0;
  const keep = Number(family?.avg_mfe_keep_rate);
  const minClosed = Number(cfg.convictionMinClosed) || 30;
  const keepFloor = Number(cfg.convictionKeepFloor) || 0.35;
  if (cfg.blockWiden) return { ok: false, reason: "block_widen_enabled" };
  if (wow?.regressing === true) return { ok: false, reason: "wow_regressing" };
  if (!family || family.ok === false) return { ok: false, reason: "no_family_attribution" };
  if (closed < minClosed) return { ok: false, reason: "insufficient_closed_n", closed, need: minClosed };
  if (!Number.isFinite(keep) || keep < keepFloor) {
    return { ok: false, reason: "keep_rate_below_floor", keep, floor: keepFloor };
  }
  return { ok: true, reason: "cleared", closed, keep };
}

/** Pure WoW comparison from two window stats. */
export function compareWowPnl(thisWeek, priorWeek) {
  const a = Number(thisWeek?.pnl_usd);
  const b = Number(priorWeek?.pnl_usd);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { regressing: null, delta_usd: null, note: "insufficient_windows" };
  }
  const delta = Math.round((a - b) * 100) / 100;
  return {
    regressing: a < b,
    delta_usd: delta,
    this_week_pnl_usd: a,
    prior_week_pnl_usd: b,
    note: a < b
      ? "WoW PnL regressing — block widen, prefer pause/demote"
      : "WoW PnL improving or flat",
  };
}

/**
 * Decide severe auto-demote actions from per-setup scorecard rows.
 */
export function planSevereDemotions(perSetup, opts = {}) {
  const minN = Number(opts.minN) || 10;
  const maxPf = Number(opts.maxPf) || 0.5;
  const allowPaths = new Set(
    (opts.allowPaths || SEVERE_BLEEDER_PATHS).map((p) => String(p).toLowerCase()),
  );
  const out = [];
  for (const s of perSetup || []) {
    const stats = s.stats || s;
    const n = Number(stats.n) || 0;
    const pf = stats.profit_factor;
    if (n < minN || pf == null || pf >= maxPf) continue;
    const key = demotionProposalConfigKey(s.setup, s.direction || "long");
    // Prefer path-keyed severe list when we can resolve.
    let path = null;
    if (/^tt_[a-z0-9_]+$/.test(String(s.setup || ""))) path = String(s.setup).toLowerCase();
    else {
      const mapped = demotionProposalConfigKey(s.setup, s.direction || "long");
      for (const p of allowPaths) {
        if (setupDemotionConfigKey(p, s.direction || "long") === mapped) path = p;
      }
    }
    if (path && !allowPaths.has(path)) continue;
    if (!path && !allowPaths.size) continue;
    out.push({
      setup: s.setup,
      direction: String(s.direction || "long").toLowerCase(),
      path,
      config_key: key,
      n,
      profit_factor: pf,
      win_rate_pct: stats.win_rate_pct,
      pnl_usd: stats.pnl_usd,
      action: "auto_demote_blocked",
    });
  }
  return out;
}

async function upsertModelConfig(db, row) {
  await db.prepare(
    `INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(config_key) DO UPDATE SET
       config_value = excluded.config_value,
       description = excluded.description,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
  ).bind(
    row.config_key,
    row.config_value,
    row.description || null,
    row.updated_at,
    row.updated_by || "weekly_governor",
  ).run();
}

/**
 * Build + optionally apply the weekly governor report.
 */
export async function runWeeklyGovernor(env, opts = {}) {
  const daCfg = env?._deepAuditConfig || {};
  const cfg = { ...loadWeeklyGovernorConfig(daCfg), ...(opts.cfg || {}) };
  if (!cfg.enabled && !opts.force) {
    return { ok: true, skipped: true, reason: "governor_disabled" };
  }

  const db = env?.DB;
  const KV = env?.KV || env?.TICKER_KV;
  const now = Date.now();

  // Edge scorecard from KV (nightly B5) or opts override.
  let scorecard = opts.scorecard || null;
  if (!scorecard && KV?.get) {
    try {
      const raw = await KV.get("timed:edge:scorecard");
      scorecard = raw ? JSON.parse(raw) : null;
    } catch { scorecard = null; }
  }

  const windows = scorecard?.windows || {};
  const wow = compareWowPnl(windows.d7, {
    // Prior week ≈ d30 residual proxy when we lack a stored prior artifact.
    pnl_usd: Number.isFinite(Number(windows.d30?.pnl_usd)) && Number.isFinite(Number(windows.d7?.pnl_usd))
      ? (Number(windows.d30.pnl_usd) - Number(windows.d7.pnl_usd)) * (7 / 23)
      : null,
  });

  // Prefer stored prior governor snapshot for true WoW.
  let priorGov = null;
  if (KV?.get) {
    try {
      const raw = await KV.get(KV_KEY);
      priorGov = raw ? JSON.parse(raw) : null;
    } catch { /* */ }
  }
  if (priorGov?.windows?.d7 && windows.d7) {
    const ageMs = now - Number(priorGov.generated_at || 0);
    if (ageMs >= 5 * DAY_MS && ageMs <= 10 * DAY_MS) {
      Object.assign(wow, compareWowPnl(windows.d7, priorGov.windows.d7));
    }
  }

  const family = await loadFamilyAttribution(env, { days: 7, family: "confirm_stack_ema21" })
    .catch((e) => ({ ok: false, error: String(e?.message || e) }));

  const perSetup = scorecard?.per_setup || scorecard?.perSetup || [];
  const mildCandidates = findDemotionCandidates(perSetup, { minN: 10, maxPf: 0.8 });
  const severe = planSevereDemotions(perSetup, {
    minN: cfg.severeMinN,
    maxPf: cfg.severeMaxPf,
    allowPaths: SEVERE_BLEEDER_PATHS,
  });

  const actions = [];
  const applied = [];

  // 1) Always heal demotion plumbing when enabled (idempotent).
  if (db && cfg.healDemotions) {
    let existingEnforce = "";
    try {
      const row = await db.prepare(
        `SELECT config_value FROM model_config WHERE config_key = 'deep_audit_setup_demotion_enforce_paths'`,
      ).first();
      existingEnforce = row?.config_value != null
        ? (typeof row.config_value === "string"
          ? (() => { try { return JSON.parse(row.config_value); } catch { return row.config_value; } })()
          : String(row.config_value))
        : "";
      existingEnforce = String(existingEnforce || "").replace(/^"|"$/g, "");
    } catch { /* */ }

    const heal = buildDemotionHealUpserts({
      existingEnforcePaths: existingEnforce,
      paths: SEVERE_BLEEDER_PATHS,
      direction: "long",
      now,
      updatedBy: "weekly_governor_heal",
    });
    if (!opts.dryRun) {
      for (const row of heal.rows) {
        try {
          await upsertModelConfig(db, row);
          applied.push({ type: "heal_upsert", key: row.config_key, value: row.config_value });
        } catch (e) {
          actions.push({ type: "heal_error", key: row.config_key, error: String(e?.message || e) });
        }
      }
      // Clear mangled legacy keys so they don't confuse operators.
      for (const mangled of [
        "deep_audit_setup_demotion_TT Tt Ath Breakout_long",
        "deep_audit_setup_demotion_TT Tt N Test Support_long",
      ]) {
        try {
          await db.prepare(`DELETE FROM model_config WHERE config_key = ?1`).bind(mangled).run();
          applied.push({ type: "heal_delete_mangled", key: mangled });
        } catch { /* */ }
      }
    }
    actions.push({ type: "heal_demotions", enforce: heal.enforce, rows: heal.rows.length });
  }

  // 2) Auto-demote severe scorecard bleeders (extra to the static heal list).
  if (db && cfg.autoDemote && severe.length) {
    for (const s of severe) {
      if (!s.config_key) continue;
      const row = {
        config_key: s.config_key,
        config_value: JSON.stringify("blocked"),
        description: `Weekly governor auto-demote PF=${s.profit_factor} n=${s.n}`,
        updated_at: now,
        updated_by: "weekly_governor_auto_demote",
      };
      if (!opts.dryRun) {
        try {
          await upsertModelConfig(db, row);
          if (s.path) {
            const enfRow = await db.prepare(
              `SELECT config_value FROM model_config WHERE config_key = 'deep_audit_setup_demotion_enforce_paths'`,
            ).first();
            let cur = "";
            try { cur = JSON.parse(enfRow?.config_value); } catch { cur = enfRow?.config_value || ""; }
            const merged = mergeEnforceDemotionPaths(cur, [s.path]);
            await upsertModelConfig(db, {
              config_key: "deep_audit_setup_demotion_enforce_paths",
              config_value: JSON.stringify(merged),
              description: "enforce_paths merge from weekly governor",
              updated_at: now,
              updated_by: "weekly_governor_auto_demote",
            });
          }
          applied.push({ type: "auto_demote", ...s });
        } catch (e) {
          actions.push({ type: "auto_demote_error", setup: s.setup, error: String(e?.message || e) });
        }
      } else {
        actions.push({ type: "auto_demote_dry_run", ...s });
      }
    }
  }

  // 3) Enable bleeder shield if missing (idempotent capital-protect).
  if (db && cfg.healDemotions && !opts.dryRun) {
    try {
      const bl = await db.prepare(
        `SELECT config_value FROM model_config WHERE config_key = 'deep_audit_bleeder_shield_enabled'`,
      ).first();
      const cur = bl?.config_value != null
        ? String((() => { try { return JSON.parse(bl.config_value); } catch { return bl.config_value; } })()).toLowerCase()
        : "";
      if (cur !== "true") {
        await upsertModelConfig(db, {
          config_key: "deep_audit_bleeder_shield_enabled",
          config_value: JSON.stringify("true"),
          description: "Shield soft fast-cut exits when HTF structure intact (WoW governor)",
          updated_at: now,
          updated_by: "weekly_governor_heal",
        });
        applied.push({ type: "enable_bleeder_shield" });
      }
    } catch (e) {
      actions.push({ type: "bleeder_shield_error", error: String(e?.message || e) });
    }
  }

  // 4) Auto-promote conviction fusion + move-ending enforce when the
  //    confirm-stack family clears n/keep floors and WoW is not regressing.
  const promoteGate = canPromoteWidenLevers(family, wow, cfg);
  actions.push({ type: "promote_gate", ...promoteGate });
  if (db && promoteGate.ok && !opts.dryRun) {
    if (cfg.autoPromoteConviction) {
      try {
        const cur = await db.prepare(
          `SELECT config_value FROM model_config WHERE config_key = 'deep_audit_conviction_fusion_enabled'`,
        ).first();
        const curVal = cur?.config_value != null
          ? String((() => { try { return JSON.parse(cur.config_value); } catch { return cur.config_value; } })()).toLowerCase()
          : "";
        if (curVal !== "true") {
          await upsertModelConfig(db, {
            config_key: "deep_audit_conviction_fusion_enabled",
            config_value: JSON.stringify("true"),
            description: `Weekly governor promote: family n=${promoteGate.closed} keep=${promoteGate.keep}`,
            updated_at: now,
            updated_by: "weekly_governor_auto_promote",
          });
          applied.push({ type: "promote_conviction_fusion", ...promoteGate });
        }
      } catch (e) {
        actions.push({ type: "promote_conviction_error", error: String(e?.message || e) });
      }
    }
    if (cfg.autoPromoteMoveEnding) {
      try {
        const closedOk = Number(family?.closed) >= cfg.moveEndingMinClosed;
        const keepOk = Number(family?.avg_mfe_keep_rate) >= cfg.moveEndingKeepFloor;
        if (closedOk && keepOk) {
          const cur = await db.prepare(
            `SELECT config_value FROM model_config WHERE config_key = 'deep_audit_move_ending_enforce_enabled'`,
          ).first();
          const curVal = cur?.config_value != null
            ? String((() => { try { return JSON.parse(cur.config_value); } catch { return cur.config_value; } })()).toLowerCase()
            : "";
          if (curVal !== "true") {
            await upsertModelConfig(db, {
              config_key: "deep_audit_move_ending_enforce_enabled",
              config_value: JSON.stringify("true"),
              description: `Weekly governor promote move-ending: n=${family.closed} keep=${family.avg_mfe_keep_rate}`,
              updated_at: now,
              updated_by: "weekly_governor_auto_promote",
            });
            applied.push({ type: "promote_move_ending_enforce", closed: family.closed, keep: family.avg_mfe_keep_rate });
          }
        }
      } catch (e) {
        actions.push({ type: "promote_move_ending_error", error: String(e?.message || e) });
      }
    }
  } else if (!promoteGate.ok) {
    actions.push({ type: "promote_blocked", reason: promoteGate.reason });
  }

  // 5) Learning-bus proposals for mild candidates (operator review).
  const proposals = [];
  if (typeof opts.submitProposal === "function") {
    for (const cand of mildCandidates.slice(0, 8)) {
      const key = demotionProposalConfigKey(cand.setup, cand.direction);
      if (!key) continue;
      const alreadySevere = severe.some((s) => s.config_key === key);
      if (alreadySevere) continue;
      try {
        await opts.submitProposal({
          source: "weekly_governor",
          tier: "tier2",
          config_key: key,
          proposed_value: "blocked",
          note: `WoW governor: 90d/setup PF ${cand.profit_factor} n=${cand.n} WR ${cand.win_rate_pct}% — review demotion`,
        });
        proposals.push(key);
      } catch { /* */ }
    }
    if (wow.regressing === true) {
      try {
        await opts.submitProposal({
          source: "weekly_governor",
          tier: "tier2",
          config_key: "deep_audit_weekly_governor_block_widen",
          proposed_value: "true",
          note: `WoW PnL regressing (Δ $${wow.delta_usd}) — do not widen conviction/sequence gates`,
        });
        proposals.push("deep_audit_weekly_governor_block_widen");
      } catch { /* */ }
    }
  }

  const report = {
    ok: true,
    generated_at: now,
    windows: {
      d7: windows.d7 || null,
      d30: windows.d30 || null,
      d90: windows.d90 || null,
    },
    wow,
    family_attribution: family?.ok ? {
      family: family.family,
      entries: family.entries,
      closed: family.closed,
      stats: family.stats,
      avg_mfe_keep_rate: family.avg_mfe_keep_rate,
      universe_capture_rate_pct: family.universe_capture_rate_pct,
      beats_baseline_capture: family.beats_baseline_capture,
    } : { ok: false, error: family?.error || "unavailable" },
    severe_demotions: severe,
    mild_demotion_candidates: mildCandidates.slice(0, 10),
    actions,
    applied,
    proposals,
    flags: [
      ...(scorecard?.flags || []),
      wow.regressing === true ? "wow_pnl_regressing" : null,
      family?.avg_mfe_keep_rate != null && family.avg_mfe_keep_rate < 0.35
        ? "family_mfe_keep_weak"
        : null,
      !cfg.autoDemote ? "auto_demote_disabled" : null,
    ].filter(Boolean),
    policy: {
      auto_demote: cfg.autoDemote,
      heal_demotions: cfg.healDemotions,
      severe_min_n: cfg.severeMinN,
      severe_max_pf: cfg.severeMaxPf,
      block_widen_on_regression: wow.regressing === true,
    },
  };

  if (KV?.put && !opts.dryRun) {
    try {
      await KV.put(KV_KEY, JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 45 });
    } catch { /* */ }
  }

  return report;
}

export { KV_KEY };
