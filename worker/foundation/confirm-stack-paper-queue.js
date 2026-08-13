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

/**
 * Copy prior-cycle shadow / gate / proposal fields onto a fresh scored payload
 * so thin-slice stamping can see sequences even when D1 shadow runs later.
 */
export function hydrateConfirmStackSliceInputs(payload, prior = null) {
  if (!payload || typeof payload !== "object") return payload;
  const src = prior && typeof prior === "object" ? prior : null;
  if (!src) return payload;
  const keys = [
    "setup_gates",
    "setup_gate_shadow",
    "setup_sequences",
    "setup_shadow_posture",
    "setup_shadow",
    "confirm_stack",
    "_sequence_queue_proposal",
  ];
  let out = null;
  for (const k of keys) {
    const cur = payload[k];
    const missing = cur == null
      || (k === "setup_sequences" && (!Array.isArray(cur) || cur.length === 0))
      || (k === "setup_gates" && typeof cur === "object" && !Object.keys(cur).length);
    if (!missing) continue;
    if (src[k] == null) continue;
    if (!out) out = { ...payload };
    out[k] = src[k];
  }
  return out || payload;
}

/** Compact fields that must land on KV / snapshot after D1 shadow stamp. */
export function thinSliceKvPatch(fromPayload = {}, stamped = {}) {
  if (!stamped || typeof stamped !== "object") return null;
  const keys = [
    "setup_gates",
    "setup_gate_shadow",
    "setup_sequences",
    "setup_shadow_posture",
    "setup_shadow",
    "setup_shadow_event_count",
    "setup_shadow_as_of_ts",
    "confirm_stack",
    "momentum_continuation",
    "_continuation_detect",
    "tt_cloud_pivot",
    "_cloud_pivot_detect",
    "_sequence_queue_proposal",
    "_model_play",
    "_model_lifecycle",
  ];
  const patch = {};
  for (const k of keys) {
    if (stamped[k] == null) continue;
    const prev = fromPayload?.[k];
    try {
      if (JSON.stringify(prev) === JSON.stringify(stamped[k])) continue;
    } catch {
      if (prev === stamped[k]) continue;
    }
    patch[k] = stamped[k];
  }
  if (stamped.setup_gates?.stack_full_confirm?.fires === true) {
    patch.confirm_stack = true;
  }
  return Object.keys(patch).length ? patch : null;
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

/**
 * Force vehicle-menu pick + __model_play to options when Tier-A RIDE confirm-stack.
 * Sim fill stays gated — this stamps intent / counterfactual lineage only.
 */
export function applyConfirmStackOptionsFirstToMenu(menu, payload = {}, daCfg = {}) {
  const play = buildConfirmStackOptionsFirstPlay(payload, daCfg);
  if (!play) return { menu, play: null, applied: false };
  if (!menu || typeof menu !== "object") {
    return { menu, play, applied: true };
  }
  const entries = Array.isArray(menu.entries) ? menu.entries : [];
  const optEntry = entries.find((e) => {
    const v = String(e?.play_vehicle || e?.vehicle || "").toLowerCase();
    return v === "options" || v === "option";
  }) || null;
  const next = {
    ...menu,
    pick: {
      ...(menu.pick || {}),
      vehicle: optEntry?.vehicle || "option",
      play_vehicle: "options",
      label: optEntry?.label || menu.pick?.label || "Options (confirm-stack Tier-A RIDE)",
      suitability: optEntry?.suitability ?? menu.pick?.suitability ?? null,
      why: play.why,
      archetype: optEntry?.archetype || menu.pick?.archetype || null,
      letf_ticker: null,
    },
  };
  return { menu: next, play, applied: true };
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

/**
 * Canonical capital entry paths (Support Bounce, ATH breakout, ORB, …)
 * must NEVER be crushed by a coincident paper-queue stamp.
 *
 * Repro 2026-08-12: AXON Prime `tt_n_test_support` risk-sized to ~$20k
 * (2% risk, SL $42.60 away) then ×0.30 regime floor ×0.10 paper → $648
 * (~1 share). Paper sizing only applies when the entry itself is the
 * thin-slice family's play — not when a first-class path fires while a
 * Queued proposal happens to sit on the payload.
 */
export function isCanonicalCapitalEntryPath(entryPath) {
  const path = String(entryPath || "").toLowerCase().trim();
  if (!path) return false;
  if (/^(tt_|orb_|gold_|vwap_|pullback_|ema21_|ichimoku_|ripster_)/.test(path)) return true;
  if (path.includes("test_support") || path.includes("ath_breakout")) return true;
  if (path.includes("support_bounce") || path.includes("breakout")) return true;
  return false;
}

/**
 * Resolve the effective paper size mult for a live sim entry.
 * Canonical paths → 1.0 (full size). Thin-slice-only entries keep the
 * proposal's paper mult.
 */
export function resolveEntryPaperSizeMult(tickerData, daCfg, entryPath, extras = {}) {
  if (isCanonicalCapitalEntryPath(entryPath)) return 1;
  const candidates = [
    paperQueueSizeMult(tickerData, daCfg),
    Number(extras.continuationMult) || 1,
    Number(extras.cloudPivotMult) || 1,
  ];
  let m = 1;
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0 && n < m) m = n;
  }
  return m;
}
