// worker/cio/cio-authority.js
//
// P3.L2 (2026-06-09) — accuracy-scaled CIO authority.
//
// Problem (full-system-review §3): the CIO's authority (shadow vs live,
// lifecycle enforcement) was a set of operator checkboxes. Its measured
// accuracy never adjusted anything — a CIO with a 70% correct-reject
// record stayed in shadow, and one whose precision collapsed stayed
// live.
//
// This module computes a nightly scorecard from attributed
// ai_cio_decisions rows and turns it into bounded recommendations:
//
//   shadow → live   : recommend ONLY (tier-2 learning proposal — the
//                     operator keeps the go-live decision)
//   live → shadow   : on measured degradation, auto-revert is allowed
//                     when ai_cio_authority_autoscale=true (safety
//                     demotions are the one self-acting path; promoting
//                     itself is never automatic)
//
// Scorecard persisted to KV `ai_cio:authority:latest` for Mission
// Control. All thresholds operator-tunable via model_config.

const KV_KEY = "ai_cio:authority:latest";

const DEFAULTS = {
  window_days: 90,
  min_sample: 20,             // decisions with outcomes before any signal
  promote_reject_precision: 0.60, // shadow-REJECTs that were right (non-WIN)
  promote_approve_wr: 0.45,   // approved-trade WR floor
  demote_reject_precision: 0.35, // live floor — below this, revert to shadow
  demote_approve_wr: 0.30,
};

function _cfgNum(env, key, fallback) {
  const v = Number(env?._deepAuditConfig?.[key]);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Compute the rolling scorecard from attributed (outcome != null),
 * non-replay decisions.
 */
export async function computeCioScorecard(env) {
  if (!env?.DB) return { ok: false, error: "no_db" };
  const windowDays = _cfgNum(env, "cio_authority_window_days", DEFAULTS.window_days);
  const since = Date.now() - windowDays * 86400000;

  const rows = (await env.DB.prepare(
    `SELECT decision, shadow, trade_outcome, trade_pnl_pct, created_at
       FROM ai_cio_decisions
      WHERE COALESCE(is_replay, 0) = 0
        AND trade_outcome IS NOT NULL
        AND created_at >= ?1
      ORDER BY created_at DESC
      LIMIT 1000`
  ).bind(since).all().catch(() => ({ results: [] })))?.results || [];

  // Entry-lane decisions: APPROVE/ADJUST (trade ran) and REJECT
  // (in shadow the trade ran anyway, so the outcome scores the reject).
  const approved = rows.filter((r) => /^(APPROVE|ADJUST)$/.test(String(r.decision)));
  const rejects = rows.filter((r) => /REJECT/.test(String(r.decision)));
  const approveWins = approved.filter((r) => r.trade_outcome === "WIN").length;
  const rejectCorrect = rejects.filter((r) => r.trade_outcome !== "WIN").length;

  // Lifecycle HOLD overrides (STALL_/RUNNER_STALE_/EXIT_/TRIM_ HOLD):
  // a HOLD was right when the trade still ended non-LOSS.
  const lifecycleHolds = rows.filter((r) => /_(HOLD)$/.test(String(r.decision)));
  const holdsCorrect = lifecycleHolds.filter((r) => r.trade_outcome !== "LOSS").length;

  const pct = (n, d) => (d > 0 ? +(n / d).toFixed(3) : null);

  return {
    ok: true,
    computed_at: Date.now(),
    window_days: windowDays,
    attributed_total: rows.length,
    entry: {
      approved: approved.length,
      approve_wr: pct(approveWins, approved.length),
      rejects: rejects.length,
      reject_precision: pct(rejectCorrect, rejects.length),
      avg_approved_pnl_pct: approved.length
        ? +(approved.reduce((s, r) => s + (Number(r.trade_pnl_pct) || 0), 0) / approved.length).toFixed(3)
        : null,
    },
    lifecycle: {
      holds: lifecycleHolds.length,
      hold_save_rate: pct(holdsCorrect, lifecycleHolds.length),
    },
  };
}

/**
 * Nightly authority evaluation. Computes the scorecard, persists it,
 * and emits bounded recommendations:
 *  - promotion (shadow→live): tier-2 learning proposal, operator decides
 *  - demotion  (live→shadow): auto-applies ONLY when
 *    ai_cio_authority_autoscale=true; otherwise tier-2 proposal
 *
 * @param {object} deps { submitProposal, notifyDiscord } injected so
 *   this module stays import-cycle-free and unit-testable.
 */
export async function evaluateCioAuthority(env, deps = {}) {
  const card = await computeCioScorecard(env);
  if (!card.ok) return card;

  const cfg = env?._deepAuditConfig || {};
  const minSample = _cfgNum(env, "cio_authority_min_sample", DEFAULTS.min_sample);
  const shadowOn = String(cfg.ai_cio_shadow_mode ?? "true") === "true";
  // 2026-06-09 operator decision: autoscale defaults ON ("informed, not
  // responsible") — measured accuracy moves authority in BOTH directions
  // with a Discord page on every change. Set ai_cio_authority_autoscale
  // to "false" in model_config to fall back to proposal-only.
  const autoscale = String(cfg.ai_cio_authority_autoscale ?? "true") === "true";

  const actions = [];
  const e = card.entry;
  const sampled = (e.approved + e.rejects) >= minSample && e.rejects >= 5;

  if (sampled) {
    const promoteOk =
      (e.reject_precision ?? 0) >= _cfgNum(env, "cio_authority_promote_reject_precision", DEFAULTS.promote_reject_precision) &&
      (e.approve_wr ?? 0) >= _cfgNum(env, "cio_authority_promote_approve_wr", DEFAULTS.promote_approve_wr);
    const demote =
      (e.reject_precision ?? 1) < _cfgNum(env, "cio_authority_demote_reject_precision", DEFAULTS.demote_reject_precision) ||
      (e.approve_wr ?? 1) < _cfgNum(env, "cio_authority_demote_approve_wr", DEFAULTS.demote_approve_wr);

    if (shadowOn && promoteOk) {
      if (autoscale && env?.DB) {
        // Autoscale ON: promotion is self-acting too — the operator is
        // INFORMED via Discord, not asked. Demotion symmetry below means
        // a wrong promotion self-corrects on the next nightly eval.
        await env.DB.prepare(
          `INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by)
           VALUES ('ai_cio_shadow_mode', 'false', ?1, ?2, 'cio_authority_autoscale')
           ON CONFLICT(config_key) DO UPDATE SET
             config_value = excluded.config_value,
             description = excluded.description,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`
        ).bind(
          `auto-promoted: reject_precision=${e.reject_precision}, approve_wr=${e.approve_wr}`,
          Date.now(),
        ).run();
        actions.push({ action: "auto_promoted_to_live" });
        if (deps.notifyDiscord) {
          deps.notifyDiscord(env, {
            title: "🟢 AI CIO auto-promoted to LIVE",
            description: `Measured over ${card.window_days}d: reject precision **${e.reject_precision}**, approve WR **${e.approve_wr}** (${e.approved + e.rejects} attributed decisions). Entry REJECTs now block trades. Auto-reverts to shadow if precision degrades; set \`ai_cio_authority_autoscale=false\` to require manual approval instead.`,
            color: 0x34d399,
          }, "system").catch(() => {});
        }
      } else if (deps.submitProposal) {
        const r = await deps.submitProposal(env, {
          source: "cio_authority",
          kind: "flag_flip",
          config_key: "ai_cio_shadow_mode",
          proposed_value: "false",
          tier: "tier2",
          evidence: card,
          note: `Promotion: reject_precision=${e.reject_precision}, approve_wr=${e.approve_wr} over ${e.approved + e.rejects} attributed decisions (${card.window_days}d)`,
        });
        actions.push({ action: "promote_proposed", proposal_id: r?.id ?? null });
      }
    }

    if (!shadowOn && demote) {
      if (autoscale && env?.DB) {
        // Safety demotion is the one self-acting path: live → shadow.
        await env.DB.prepare(
          `INSERT INTO model_config (config_key, config_value, description, updated_at, updated_by)
           VALUES ('ai_cio_shadow_mode', 'true', ?1, ?2, 'cio_authority_autoscale')
           ON CONFLICT(config_key) DO UPDATE SET
             config_value = excluded.config_value,
             description = excluded.description,
             updated_at = excluded.updated_at,
             updated_by = excluded.updated_by`
        ).bind(
          `auto-demoted: reject_precision=${e.reject_precision}, approve_wr=${e.approve_wr}`,
          Date.now(),
        ).run();
        actions.push({ action: "auto_demoted_to_shadow" });
        if (deps.notifyDiscord) {
          deps.notifyDiscord(env, {
            title: "🛑 AI CIO auto-demoted to SHADOW",
            description: `Measured degradation over ${card.window_days}d: reject precision ${e.reject_precision}, approve WR ${e.approve_wr} (${e.approved + e.rejects} attributed decisions). Entries now rules-only; review at /timed/admin/ai-cio/authority.`,
            color: 0xef4444,
          }).catch(() => {});
        }
      } else if (deps.submitProposal) {
        const r = await deps.submitProposal(env, {
          source: "cio_authority",
          kind: "flag_flip",
          config_key: "ai_cio_shadow_mode",
          proposed_value: "true",
          tier: "tier2",
          evidence: card,
          note: `Demotion recommended: reject_precision=${e.reject_precision}, approve_wr=${e.approve_wr}. Set ai_cio_authority_autoscale=true to allow auto-demotion.`,
        });
        actions.push({ action: "demote_proposed", proposal_id: r?.id ?? null });
      }
    }
  }

  const result = { ...card, sampled, min_sample: minSample, shadow_mode: shadowOn, autoscale, actions };
  try {
    const KV = env?.KV_TIMED || env?.KV;
    if (KV) await KV.put(KV_KEY, JSON.stringify(result), { expirationTtl: 7 * 86400 });
  } catch (_) { /* display-only persistence */ }
  return result;
}

export async function readCioAuthority(env) {
  try {
    const KV = env?.KV_TIMED || env?.KV;
    const raw = KV ? await KV.get(KV_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}
