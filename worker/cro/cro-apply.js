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
import { stampOverlayProvenance } from "../overlay-provenance.js";

const OVERRIDE_KV_KEY = "cro:tactical_overrides";
const APPLIED_HISTORY_KV_KEY = "cro:tactical_overrides:history";

// ── Public: load + write override blob ────────────────────────────────────────
function croKv(env) {
  return env?.KV_TIMED || env?.KV || null;
}

export async function loadTacticalOverrideBlob(env) {
  try {
    const raw = await croKv(env)?.get(OVERRIDE_KV_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}

export async function writeTacticalOverrideBlob(env, blob) {
  const kv = croKv(env);
  if (!kv) return { ok: false, error_kind: "kv_unavailable" };
  // C3 (2026-07-05) — every overlay is born with a lifespan: issued_at /
  // expires_at stamped at write time (explicit values on the proposal win).
  blob = stampOverlayProvenance(blob);
  // KV values are bounded but plenty large for our shape (~2KB).
  await kv.put(OVERRIDE_KV_KEY, JSON.stringify(blob));
  // Best-effort short history (last 10 applies).
  try {
    const histRaw = await kv.get(APPLIED_HISTORY_KV_KEY);
    const history = histRaw ? JSON.parse(histRaw) : [];
    history.unshift({ applied_at: Date.now(), proposal_id: blob?.proposal_id || null, source: blob?.source || null });
    await kv.put(APPLIED_HISTORY_KV_KEY, JSON.stringify(history.slice(0, 10)));
  } catch (_) {}
  return { ok: true };
}

export async function clearTacticalOverrideBlob(env, { reason = "operator_clear" } = {}) {
  const kv = croKv(env);
  if (!kv) return { ok: false, error_kind: "kv_unavailable" };
  try { await kv.delete(OVERRIDE_KV_KEY); } catch (_) {}
  try {
    const histRaw = await kv.get(APPLIED_HISTORY_KV_KEY);
    const history = histRaw ? JSON.parse(histRaw) : [];
    history.unshift({ cleared_at: Date.now(), reason });
    await kv.put(APPLIED_HISTORY_KV_KEY, JSON.stringify(history.slice(0, 10)));
  } catch (_) {}
  return { ok: true };
}

export async function loadAppliedHistory(env) {
  try {
    const raw = await croKv(env)?.get(APPLIED_HISTORY_KV_KEY);
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
    sector_stance_changes: Array.isArray(proposal?.sector_stance_changes)
      ? proposal.sector_stance_changes
      : [],
    theme_stance_changes: Array.isArray(proposal?.theme_stance_changes)
      ? proposal.theme_stance_changes
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
          sector_stance_changes: Array.isArray(proposal?.sector_stance_changes)
            ? proposal.sector_stance_changes
            : [],
          theme_stance_changes: Array.isArray(proposal?.theme_stance_changes)
            ? proposal.theme_stance_changes
            : [],
        }
      : null,
  };
}

function mergeStanceChanges(existing = [], incoming = []) {
  const map = new Map();
  for (const row of existing) {
    if (row?.sector) map.set(String(row.sector), row);
  }
  for (const row of incoming) {
    if (row?.sector) map.set(String(row.sector), row);
  }
  return [...map.values()];
}

function mergeThemeChanges(existing = [], incoming = []) {
  const map = new Map();
  for (const row of existing) {
    if (row?.theme) map.set(String(row.theme), row);
  }
  for (const row of incoming) {
    if (row?.theme) map.set(String(row.theme), row);
  }
  return [...map.values()];
}

/** Tactical overlays must not wipe a prior structural sector-allocation apply. */
async function mergeWithPreviousOverride(env, blob, proposal) {
  const prev = await loadTacticalOverrideBlob(env);
  if (!prev || proposal?.classification === "structural") return blob;

  const prevStructural = prev.structural_pending;
  if (prevStructural && !blob.structural_pending) {
    blob.structural_pending = prevStructural;
  }

  const prevSectors = [
    ...(Array.isArray(prev.sector_stance_changes) ? prev.sector_stance_changes : []),
    ...(Array.isArray(prevStructural?.sector_stance_changes) ? prevStructural.sector_stance_changes : []),
  ];
  blob.sector_stance_changes = mergeStanceChanges(
    prevSectors,
    blob.sector_stance_changes || [],
  );

  const prevThemes = [
    ...(Array.isArray(prev.theme_stance_changes) ? prev.theme_stance_changes : []),
    ...(Array.isArray(prevStructural?.theme_stance_changes) ? prevStructural.theme_stance_changes : []),
  ];
  blob.theme_stance_changes = mergeThemeChanges(
    prevThemes,
    blob.theme_stance_changes || [],
  );
  return blob;
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

  let blob = proposalToOverrideBlob(row.proposal, { proposalId, pubId: row.pub_id });
  blob = await mergeWithPreviousOverride(env, blob, row.proposal);
  const w = await writeTacticalOverrideBlob(env, blob);
  if (!w.ok) {
    await markProposalApplied(env, proposalId, { apply_kind: "kv_override", apply_error: w.error_kind });
    return { ok: false, error_kind: w.error_kind };
  }

  // Mark proposal + publication as applied.
  await markProposalApplied(env, proposalId, { apply_kind: "kv_override" });
  await markPublicationApplied(env, row.pub_id);

  // Live strategy arm: merge sector/theme stances into runtime + scoring ratings.
  try {
    const {
      setStrategyOverrideCache,
      syncSectorRatingsFromOverride,
    } = await import("./strategy-overrides.js");
    setStrategyOverrideCache(blob);
    const { SECTOR_RATINGS } = await import("../sector-mapping.js");
    const ratingSync = await syncSectorRatingsFromOverride(env, blob, SECTOR_RATINGS);
    if (ratingSync.updated > 0) {
      console.log(`[CRO_APPLY] synced ${ratingSync.updated} sector rating(s) from FSD stance changes`);
    }
  } catch (e) {
    console.warn("[CRO_APPLY] strategy override sync failed:", String(e?.message || e).slice(0, 200));
  }

  // B3 (2026-06-11) — record every applied tactical signal in the Signal
  // Outcome Ledger so FSD's calls get graded against candles like
  // everything else we act on ("actively learn from FSD"). Idempotent on
  // signal_id; fire-and-forget — the apply path never blocks on it.
  try {
    const { recordSignal, fsdTacticalToSignals } = await import("../signal-outcomes.js");
    const ledgerRows = fsdTacticalToSignals(blob.tactical_signals || [], {
      proposalId,
      vintage: blob.tactical_vintage || null,
      publishedAt: Date.now(),
    });
    for (const s of ledgerRows) {
      await recordSignal(env, s).catch(() => {});
    }
    if (ledgerRows.length > 0) {
      console.log(`[CRO_APPLY] recorded ${ledgerRows.length} FSD tactical signal(s) in the outcome ledger`);
    }
  } catch (_) { /* ledger recording never blocks applies */ }

  // Research alert on #general so Discord users see tactical overlay updates.
  // Never blocks; never throws.
  try {
    const { notifyDiscord } = await import("../alerts.js");
    const sigCount = (blob.tactical_signals || []).length;
    const signalLines = (blob.tactical_signals || []).slice(0, 4)
      .map((s) => `• **${s.signal || "signal"}** (${s.pair || "—"} → ${s.direction || "—"})`)
      .join("\n");
    const stanceLines = (blob.sector_stance_changes || []).slice(0, 4)
      .map((s) => `• **${s.sector || "sector"}** → ${s.new_stance || "neutral"}`)
      .join("\n");
    const themeStanceLines = (blob.theme_stance_changes || []).slice(0, 3)
      .map((t) => `• **${t.theme || "theme"}** → ${t.new_stance || "neutral"}`)
      .join("\n");
    let rewriteTitle = null;
    try {
      const rw = await env.DB.prepare(
        `SELECT tt_summary_title FROM cro_publication_rewrites WHERE pub_id = ?1`,
      ).bind(row.pub_id).first();
      rewriteTitle = rw?.tt_summary_title || null;
    } catch (_) {}
    const headline = rewriteTitle || blob.tactical_title || "Research desk tactical overlay updated";
    await notifyDiscord(env, {
      title: "Research Desk — tactical update",
      description: String(headline).slice(0, 500),
      color: autoApproved ? 0x2ecc71 : 0x3498db,
      fields: [
        { name: "Overlay", value: String(blob.tactical_overlay || blob.tactical_title || "—").slice(0, 900), inline: false },
        { name: sigCount ? `${sigCount} signal${sigCount === 1 ? "" : "s"}` : "Signals", value: signalLines || "See Today → Research Desk feed for details.", inline: false },
        ...(stanceLines ? [{ name: "Sector stances (live)", value: stanceLines.slice(0, 900), inline: false }] : []),
        ...(themeStanceLines ? [{ name: "Theme stances (live)", value: themeStanceLines.slice(0, 900), inline: false }] : []),
      ],
      footer: { text: "Timed Trading research desk — directional context, not a trade entry" },
      timestamp: new Date().toISOString(),
    }, "general");
  } catch (_) { /* alerts never block applies */ }

  return { ok: true, applied_blob: blob, decided_by: decidedBy, auto_approved: !!autoApproved };
}

// ── Auto-apply gate (called by the cron after extraction) ────────────────────
/**
 * Returns true if auto-apply for tactical proposals is enabled.
 *
 * DEFAULTS TO TRUE — per the operator's "coma-proof" / "true autopilot"
 * directive. Justification for fail-OPEN:
 *   1. Extracted proposals already pass schema validation (theme + sector
 *      keys must match the canonical playbook before persistence).
 *   2. Reverting is a single KV.delete on cro:tactical_overrides — fully
 *      reversible, no state pollution.
 *   3. Structural changes (stance flips) still require explicit operator
 *      approval via isAutoApplyStructuralEnabled (defaults FALSE).
 *   4. Discord alerts fire on every auto-apply so the operator sees
 *      what changed in near-real-time.
 * Operator opt-out: set model_config row cro_auto_apply_tactical = "false".
 */
export async function isAutoApplyEnabled(env) {
  const cached = env?._deepAuditConfig?.cro_auto_apply_tactical;
  if (cached === false || String(cached).toLowerCase() === "false" || String(cached) === "0") return false;
  if (cached === true || String(cached).toLowerCase() === "true") return true;
  if (!env?.DB) return true;
  try {
    const row = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'cro_auto_apply_tactical'`,
    ).first();
    if (!row) return true;
    const v = row.config_value;
    if (v === false || String(v).toLowerCase() === "false" || String(v) === "0") return false;
    return true;
  } catch (_) { return true; }
}

/**
 * Also gated separately for structural changes. 2026-06-05 — operator flipped
 * this ON by default. Structural proposals still pass the same confidence /
 * on-theme review gate (assessProposalAutoApply) before auto-applying; only
 * confident, on-theme, model-not-flagged ones apply automatically — the rest
 * still queue for review. Set cro_auto_apply_structural = "false" to opt out.
 */
export async function isAutoApplyStructuralEnabled(env) {
  const cached = env?._deepAuditConfig?.cro_auto_apply_structural;
  if (cached === true || String(cached).toLowerCase() === "true") return true;
  if (cached === false || String(cached).toLowerCase() === "false") return false;
  if (!env?.DB) return true;
  try {
    const row = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'cro_auto_apply_structural'`,
    ).first();
    if (!row) return true;
    const v = row.config_value;
    return !(v === false || String(v).toLowerCase() === "false" || String(v) === "0");
  } catch (_) { return true; }
}

/**
 * 2026-06-09 — FSD publications are a trusted source. When enabled (default
 * ON), proposals auto-apply unless they fail schema/taxonomy validation.
 * Operator opt-out: model_config cro_auto_apply_trusted_fsd = "false".
 */
export async function isTrustedFsdAutoApplyEnabled(env) {
  const cached = env?._deepAuditConfig?.cro_auto_apply_trusted_fsd;
  if (cached === false || String(cached).toLowerCase() === "false" || String(cached) === "0") return false;
  if (cached === true || String(cached).toLowerCase() === "true") return true;
  if (!env?.DB) return true;
  try {
    const row = await env.DB.prepare(
      `SELECT config_value FROM model_config WHERE config_key = 'cro_auto_apply_trusted_fsd'`,
    ).first();
    if (!row) return true;
    const v = row.config_value;
    if (v === false || String(v).toLowerCase() === "false" || String(v) === "0") return false;
    return true;
  } catch (_) { return true; }
}
