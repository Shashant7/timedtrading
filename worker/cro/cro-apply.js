// worker/cro/cro-apply.js
// ─────────────────────────────────────────────────────────────────────────────
//  Phase 4 — Apply a CRO-extracted proposal as a KV-backed tactical override.
// ─────────────────────────────────────────────────────────────────────────────
//
//  Two apply paths exist:
//
//    1. KV-OVERRIDE (this module — fully automated). Writes the proposal to
//       `cro:tactical_overrides` in KV. `getTacticalSignals()` (via
//       loadTacticalOverridesFromKV) merges the override on top of the
//       in-code TACTICAL_SIGNALS at request time. Reverting = a single
//       `KV.delete`. No deploy, no PR. Operator-gated by the model_config
//       key `cro_auto_apply_tactical` (default OFF — operator turns on
//       when comfortable; until then proposals queue up as `pending`
//       for review).
//
//    2. SOURCE-OF-TRUTH (deferred to Phase 4b — GitHub PR autocreate).
//       For proposals classified as `structural` we still write a
//       KV override so the runtime picks them up immediately, but we
//       ALSO surface the proposal in the operator workflow so the
//       canonical worker/strategy-context.js can be updated via the
//       manual `update-strategy-playbook` skill on the next deploy.
//
//  This module deliberately stays small. The merge logic itself is in
//  `worker/strategy-context.js` (`loadTacticalOverridesFromKV` +
//  `getTacticalSignalsWithOverrides`) so callers that already use
//  `getStrategyBrief()` / `getTacticalSignals()` automatically pick up
//  the overrides without additional plumbing.

import { getProposal, markProposalApplied } from "./fsd-extractor.js";
import { markPublicationApplied } from "./fsd-ingestion.js";

const OVERRIDE_KV_KEY = "cro:tactical_overrides";
const APPLIED_HISTORY_KV_KEY = "cro:tactical_overrides:history";

// ── Public: load + write override blob ────────────────────────────────────────
export async function loadTacticalOverrideBlob(env) {
  try {
    const raw = await env?.KV?.get(OVERRIDE_KV_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

export async function writeTacticalOverrideBlob(env, blob) {
  if (!env?.KV) return { ok: false, error_kind: "kv_unavailable" };
  // KV values are bounded but plenty large for our shape (~2KB).
  await env.KV.put(OVERRIDE_KV_KEY, JSON.stringify(blob));
  // Best-effort short history (last 10 applies).
  try {
    const histRaw = await env.KV.get(APPLIED_HISTORY_KV_KEY);
    const history = histRaw ? JSON.parse(histRaw) : [];
    history.unshift({ applied_at: Date.now(), proposal_id: blob?.proposal_id || null, source: blob?.source || null });
    await env.KV.put(APPLIED_HISTORY_KV_KEY, JSON.stringify(history.slice(0, 10)));
  } catch (_) {}
  return { ok: true };
}

export async function clearTacticalOverrideBlob(env, { reason = "operator_clear" } = {}) {
  if (!env?.KV) return { ok: false, error_kind: "kv_unavailable" };
  try { await env.KV.delete(OVERRIDE_KV_KEY); } catch (_) {}
  try {
    const histRaw = await env.KV.get(APPLIED_HISTORY_KV_KEY);
    const history = histRaw ? JSON.parse(histRaw) : [];
    history.unshift({ cleared_at: Date.now(), reason });
    await env.KV.put(APPLIED_HISTORY_KV_KEY, JSON.stringify(history.slice(0, 10)));
  } catch (_) {}
  return { ok: true };
}

export async function loadAppliedHistory(env) {
  try {
    const raw = await env?.KV?.get(APPLIED_HISTORY_KV_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (_) { return []; }
}

// ── Convert a proposal JSON to an override blob ──────────────────────────────
function proposalToOverrideBlob(proposal, { proposalId, pubId }) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    proposal_id: proposalId,
    pub_id: pubId,
    source: "cro_auto_apply",
    applied_at: Date.now(),
    tactical_vintage: today,
    tactical_title: proposal?.one_line_phase_tactical_overlay
      ? String(proposal.one_line_phase_tactical_overlay).slice(0, 200)
      : "CRO tactical overlay (auto-applied)",
    tactical_overlay: proposal?.one_line_phase_tactical_overlay || null,
    tactical_signals: Array.isArray(proposal?.tactical_signals_add)
      ? proposal.tactical_signals_add
      : [],
    theme_notes: Array.isArray(proposal?.theme_playbook_updates)
      ? proposal.theme_playbook_updates
      : [],
    sector_notes: Array.isArray(proposal?.sector_playbook_updates)
      ? proposal.sector_playbook_updates
      : [],
    active_risks_add: Array.isArray(proposal?.active_risks_add)
      ? proposal.active_risks_add
      : [],
    education_add: Array.isArray(proposal?.education_snippets_add)
      ? proposal.education_snippets_add
      : [],
    structural_pending: proposal?.classification === "structural"
      ? {
          headline_revision: proposal.strategy_headline_revision || null,
          phase_revision: proposal.strategy_phase_revision || null,
          sector_stance_changes: proposal.sector_stance_changes || [],
          theme_stance_changes: proposal.theme_stance_changes || [],
        }
      : null,
  };
}

// ── Apply a proposal ──────────────────────────────────────────────────────────
/**
 * Apply a proposal as a KV override.
 *
 * @param env
 * @param proposalId
 * @param options { autoApproved: bool, decidedBy: string }
 * @returns { ok, applied_blob? , error_kind?, hint? }
 */
export async function applyProposal(env, proposalId, { autoApproved = false, decidedBy = "operator" } = {}) {
  const row = await getProposal(env, proposalId);
  if (!row) return { ok: false, error_kind: "proposal_not_found", hint: proposalId };
  if (row.status === "applied") return { ok: false, error_kind: "already_applied" };

  const blob = proposalToOverrideBlob(row.proposal, { proposalId, pubId: row.pub_id });
  const w = await writeTacticalOverrideBlob(env, blob);
  if (!w.ok) {
    await markProposalApplied(env, proposalId, { apply_kind: "kv_override", apply_error: w.error_kind });
    return { ok: false, error_kind: w.error_kind };
  }

  // Mark proposal + publication as applied.
  await markProposalApplied(env, proposalId, { apply_kind: "kv_override" });
  await markPublicationApplied(env, row.pub_id);

  return { ok: true, applied_blob: blob, decided_by: decidedBy, auto_approved: !!autoApproved };
}

// ── Auto-apply gate (called by the cron after extraction) ────────────────────
/**
 * Returns true if the operator has flipped the model_config flag
 * `cro_auto_apply_tactical` to true. Reads from env._deepAuditConfig if
 * preloaded by the scoring cron; otherwise queries model_config directly.
 */
export async function isAutoApplyEnabled(env) {
  // Fast path — already cached.
  const cached = env?._deepAuditConfig?.cro_auto_apply_tactical;
  if (cached === true || String(cached).toLowerCase() === "true") return true;
  if (cached === false || String(cached).toLowerCase() === "false") return false;
  if (!env?.DB) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'cro_auto_apply_tactical'`,
    ).first();
    if (!row) return false;
    const v = row.config_value;
    return v === true || String(v).toLowerCase() === "true" || String(v) === "1";
  } catch (_) { return false; }
}

/**
 * Also gated separately for structural changes — these are higher-risk and
 * default OFF even when tactical auto-apply is on. Operator opt-in.
 */
export async function isAutoApplyStructuralEnabled(env) {
  const cached = env?._deepAuditConfig?.cro_auto_apply_structural;
  if (cached === true || String(cached).toLowerCase() === "true") return true;
  if (cached === false || String(cached).toLowerCase() === "false") return false;
  if (!env?.DB) return false;
  try {
    const row = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'cro_auto_apply_structural'`,
    ).first();
    if (!row) return false;
    const v = row.config_value;
    return v === true || String(v).toLowerCase() === "true" || String(v) === "1";
  } catch (_) { return false; }
}
