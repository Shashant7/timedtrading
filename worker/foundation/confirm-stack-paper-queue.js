// Confirm-stack EMA21 — sequence may propose Queued (tiny/paper).
// plans/confirm-stack-ema21-slice.plan.md + plans/wow-pnl-adaptive-governor.plan.md
//
// Does NOT mutate kanban_stage to in_review (that would fire full capital
// entry). Stamps a proposal on the payload; lifecycle surfaces Queued;
// sizing caps at paper size_mult if a normal entry still occurs.

export const CONFIRM_STACK_FAMILY = "confirm_stack_ema21";
export const PAPER_QUEUE_DEFAULT_SIZE_MULT = 0.1;

export function loadPaperQueueConfig(daCfg = {}) {
  const enabled = String(daCfg.deep_audit_confirm_stack_sequence_paper_queue_enabled ?? "true") === "true";
  const raw = Number(daCfg.deep_audit_confirm_stack_sequence_paper_size_mult);
  const sizeMult = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : PAPER_QUEUE_DEFAULT_SIZE_MULT;
  return { enabled, sizeMult };
}

export function hasConfirmStackFire(payload = {}) {
  const gates = payload.setup_gates || payload.setup_gate_shadow?.setup_gates || null;
  if (gates?.stack_full_confirm?.fires === true) return true;
  if (payload.confirm_stack === true) return true;
  if (payload._sequence_queue_proposal?.family === CONFIRM_STACK_FAMILY) return true;
  const flags = payload.flags || {};
  const reclaim = !!(flags.ema21_reclaim || payload.__pullback_confirmed || flags.ripster_reclaim);
  const stFlip = !!(flags.st_flip_bull || flags.st_flip_bear || flags.supertrend_flip);
  const squeeze = !!(flags.sq30_release || flags.squeeze_release);
  return reclaim && stFlip && squeeze;
}

export function hasSequenceEntryReady(payload = {}) {
  const seqs = Array.isArray(payload.setup_sequences) ? payload.setup_sequences : [];
  if (seqs.some((s) => String(s?.status || "").toLowerCase() === "entry_ready")) return true;
  if (String(payload.setup_shadow_posture?.posture || "").toLowerCase() === "entry_ready") return true;
  return false;
}

/**
 * Pure: build a paper Queued proposal when confirm-stack + sequence ready.
 * @returns {null|{ state, family, paper, size_mult, reason, sequence_status, confirm_stack }}
 */
export function buildSequencePaperQueueProposal(payload = {}, daCfg = {}) {
  const cfg = loadPaperQueueConfig(daCfg);
  if (!cfg.enabled) return null;
  if (!hasConfirmStackFire(payload)) return null;
  if (!hasSequenceEntryReady(payload)) return null;
  // Never paper-queue names already in a live open lifecycle.
  const life = String(payload._model_lifecycle?.state || payload.model_lifecycle?.state || "").toLowerCase();
  if (["bought", "held", "trimming", "exited"].includes(life)) return null;
  const stage = String(payload.kanban_stage || "").toLowerCase();
  if (["just_entered", "hold", "trim", "exit", "exited"].includes(stage)) return null;

  return {
    state: "queued",
    family: CONFIRM_STACK_FAMILY,
    paper: true,
    size_mult: cfg.sizeMult,
    reason: "sequence_entry_ready+stack_full_confirm",
    sequence_status: "entry_ready",
    confirm_stack: true,
    ts: Date.now(),
  };
}

/**
 * Options-first expression for Tier-A RIDE on the confirm-stack family.
 * Stamps intent only — sim fill stays gated elsewhere.
 */
export function buildConfirmStackOptionsFirstPlay(payload = {}, daCfg = {}) {
  const enabled = String(daCfg.deep_audit_confirm_stack_options_first_enabled ?? "true") === "true";
  if (!enabled) return null;
  if (!hasConfirmStackFire(payload)) return null;
  const mode = String(payload.confluence_mode || payload._confluence?.mode || "").toUpperCase();
  const tier = String(payload.__conviction_tier || payload.conviction_tier || "").toUpperCase();
  // Options-first only on RIDE + Tier A (or RIDE with no tier stamped yet —
  // fusion stamps tier at entry; scoring may only have confluence).
  if (mode !== "RIDE") return null;
  if (tier && tier !== "A") return null;

  return {
    play_vehicle: "options",
    vehicle: "options",
    why: "confirm_stack_tier_a_ride_options_first",
    family: CONFIRM_STACK_FAMILY,
    paper: true,
    ts: Date.now(),
  };
}

/** Apply proposal onto a payload copy (immutable-ish). */
export function stampConfirmStackThinSlice(payload, daCfg = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const proposal = buildSequencePaperQueueProposal(payload, daCfg);
  const play = buildConfirmStackOptionsFirstPlay(payload, daCfg);
  if (!proposal && !play) return payload;
  const out = { ...payload };
  if (proposal) out._sequence_queue_proposal = proposal;
  if (play) {
    // Don't clobber an already-executed non-paper play.
    const existing = out._model_play || out.__model_play;
    if (!existing || existing.paper === true || !existing.play_vehicle) {
      out._model_play = { ...(existing || {}), ...play };
    }
  }
  return out;
}

/** Size mult to apply at entry when a paper proposal is active. */
export function paperQueueSizeMult(tickerData, daCfg = {}) {
  const proposal = tickerData?._sequence_queue_proposal;
  if (!proposal?.paper) return 1;
  const cfg = loadPaperQueueConfig(daCfg);
  if (!cfg.enabled) return 1;
  const m = Number(proposal.size_mult);
  return Number.isFinite(m) && m > 0 && m <= 1 ? m : cfg.sizeMult;
}
