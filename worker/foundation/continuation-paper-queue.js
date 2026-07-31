// Momentum continuation thin slice — paper Queued only.
// plans/continuation-move-capture-slice.plan.md
//
// Does NOT unlock ATH Speculative/Confirmed capital admission.
// Stamps a proposal so lifecycle/Today/provenance can see the family.

export const CONTINUATION_FAMILY = "momentum_continuation";
export const CONTINUATION_PAPER_SIZE_MULT = 0.1;

export function loadContinuationConfig(daCfg = {}) {
  const enabled = String(daCfg.deep_audit_momentum_continuation_paper_queue_enabled ?? "true") === "true";
  const raw = Number(daCfg.deep_audit_momentum_continuation_paper_size_mult);
  const sizeMult = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : CONTINUATION_PAPER_SIZE_MULT;
  const minRank = Number(daCfg.deep_audit_momentum_continuation_min_rank);
  return {
    enabled,
    sizeMult,
    minRank: Number.isFinite(minRank) && minRank > 0 ? minRank : 75,
  };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dayPctAbs(payload = {}) {
  const candidates = [
    payload.day_change_pct,
    payload.dailyChgPct,
    payload.dp,
    payload._live_day_pct,
    payload.change_pct,
  ];
  for (const c of candidates) {
    const n = num(c);
    if (n != null) return Math.abs(n);
  }
  // Derive from price vs prev_close when present.
  const px = num(payload.price ?? payload._live_price ?? payload.close);
  const pc = num(payload.prev_close ?? payload.pc ?? payload.previous_close);
  if (px != null && pc != null && pc > 0) return Math.abs(((px - pc) / pc) * 100);
  return null;
}

function rvol(payload = {}) {
  return num(
    payload.rvol
    ?? payload.relative_volume
    ?? payload.flags?.rvol
    ?? payload.tf_tech?.D?.rvol
    ?? payload.tf_tech?.["60"]?.rvol,
  );
}

function ema21Daily(payload = {}) {
  const d = payload.tf_tech?.D || payload.tf_tech?.["1D"] || null;
  if (!d) return null;
  return num(d.ema21 ?? d.ema?.ema21 ?? d.emas?.ema21);
}

function resolveDirection(payload = {}) {
  const explicit = String(payload.direction || payload.trigger_dir || "").toUpperCase();
  if (explicit === "LONG" || explicit === "SHORT") return explicit;
  const state = String(payload.state || "").toUpperCase();
  if (state.includes("BULL")) return "LONG";
  if (state.includes("BEAR")) return "SHORT";
  const mode = String(payload.confluence_mode || payload._confluence?.mode || "").toUpperCase();
  if (mode === "RIDE" || mode === "READY") return "LONG";
  return null;
}

/**
 * Pure detector — returns { fires, direction, reasons[] } or null.
 */
export function detectMomentumContinuation(payload = {}, daCfg = {}) {
  const cfg = loadContinuationConfig(daCfg);
  if (!cfg.enabled) return null;
  if (!payload || typeof payload !== "object") return null;

  // Confirm-stack already owns this name's paper queue.
  const prior = payload._sequence_queue_proposal;
  if (prior?.family === "confirm_stack_ema21" && prior?.paper) return null;

  const direction = resolveDirection(payload);
  if (!direction) return null;

  const state = String(payload.state || "").toUpperCase();
  const confluence = String(payload.confluence_mode || payload._confluence?.mode || "").toUpperCase();
  const aligned = direction === "LONG"
    ? (state === "HTF_BULL_LTF_BULL" || state === "HTF_BULL_LTF_PULLBACK" || confluence === "RIDE")
    : (state === "HTF_BEAR_LTF_BEAR" || state === "HTF_BEAR_LTF_PULLBACK" || confluence === "RIDE");
  if (!aligned) return null;

  const rank = num(payload.rank ?? payload.rank_position);
  const htf = Math.abs(num(payload.htf_score) || 0);
  const flags = payload.flags || {};
  const elite = !!(flags.momentum_elite || flags.momentum_push || payload.__momentum_elite);
  const strengthOk = (rank != null && rank >= cfg.minRank) || htf >= 15 || elite;
  if (!strengthOk) return null;

  const dp = dayPctAbs(payload);
  const rv = rvol(payload);
  const squeeze = !!(flags.sq30_release || flags.squeeze_release);
  const impulseOk = (dp != null && dp >= 2.5) || (rv != null && rv >= 1.5) || squeeze;
  if (!impulseOk) return null;

  const px = num(payload.price ?? payload._live_price ?? payload.close);
  const ema = ema21Daily(payload);
  if (px != null && ema != null) {
    if (direction === "LONG" && px < ema) return null;
    if (direction === "SHORT" && px > ema) return null;
  }

  const life = String(payload._model_lifecycle?.state || payload.model_lifecycle?.state || "").toLowerCase();
  if (["bought", "held", "trimming", "exited"].includes(life)) return null;
  const stage = String(payload.kanban_stage || "").toLowerCase();
  if (["just_entered", "hold", "trim", "exit", "exited"].includes(stage)) return null;

  const reasons = [];
  if (rank != null && rank >= cfg.minRank) reasons.push(`rank ${rank}`);
  if (htf >= 15) reasons.push(`|htf| ${htf}`);
  if (elite) reasons.push("momentum_elite");
  if (dp != null && dp >= 2.5) reasons.push(`day ${dp.toFixed(1)}%`);
  if (rv != null && rv >= 1.5) reasons.push(`rvol ${rv.toFixed(1)}`);
  if (squeeze) reasons.push("squeeze_release");
  if (confluence === "RIDE") reasons.push("RIDE");

  return {
    fires: true,
    family: CONTINUATION_FAMILY,
    direction,
    reasons,
    rank,
    htf_score: num(payload.htf_score),
    day_pct_abs: dp,
    rvol: rv,
  };
}

export function hasMomentumContinuation(payload = {}, daCfg = {}) {
  return !!detectMomentumContinuation(payload, daCfg)?.fires
    || payload.momentum_continuation === true
    || payload._sequence_queue_proposal?.family === CONTINUATION_FAMILY
    || payload.slice_family === CONTINUATION_FAMILY;
}

/**
 * Paper Queued proposal for continuation family.
 */
export function buildContinuationPaperQueueProposal(payload = {}, daCfg = {}) {
  const cfg = loadContinuationConfig(daCfg);
  if (!cfg.enabled) return null;
  const det = detectMomentumContinuation(payload, daCfg);
  if (!det?.fires) return null;
  return {
    state: "queued",
    family: CONTINUATION_FAMILY,
    paper: true,
    size_mult: cfg.sizeMult,
    reason: `momentum_continuation:${det.reasons.slice(0, 3).join("+")}`,
    direction: det.direction,
    momentum_continuation: true,
    ts: Date.now(),
  };
}

/** Options-first when RIDE + Tier A on continuation (intent only). */
export function buildContinuationOptionsFirstPlay(payload = {}, daCfg = {}) {
  const enabled = String(daCfg.deep_audit_momentum_continuation_options_first_enabled ?? "true") === "true";
  if (!enabled) return null;
  if (!detectMomentumContinuation(payload, daCfg)?.fires) return null;
  const mode = String(payload.confluence_mode || payload._confluence?.mode || "").toUpperCase();
  const tier = String(payload.__conviction_tier || payload.conviction_tier || "").toUpperCase();
  if (mode !== "RIDE") return null;
  if (tier && tier !== "A") return null;
  return {
    play_vehicle: "options",
    vehicle: "options",
    why: "momentum_continuation_tier_a_ride_options_first",
    family: CONTINUATION_FAMILY,
    paper: true,
    ts: Date.now(),
  };
}

/**
 * Stamp continuation onto payload. Never overrides confirm-stack proposal.
 */
export function stampContinuationThinSlice(payload, daCfg = {}) {
  if (!payload || typeof payload !== "object") return payload;
  const existingProp = payload._sequence_queue_proposal;
  if (existingProp?.family === "confirm_stack_ema21") {
    // Still may mark observability flag when detector fires.
    const det = detectMomentumContinuation(
      { ...payload, _sequence_queue_proposal: null },
      daCfg,
    );
    if (!det?.fires) return payload;
    return { ...payload, momentum_continuation: true, _continuation_detect: det };
  }

  const proposal = buildContinuationPaperQueueProposal(payload, daCfg);
  const play = buildContinuationOptionsFirstPlay(payload, daCfg);
  if (!proposal && !play) {
    const det = detectMomentumContinuation(payload, daCfg);
    if (!det?.fires) return payload;
    return { ...payload, momentum_continuation: true, _continuation_detect: det };
  }
  const out = { ...payload, momentum_continuation: true };
  if (proposal && !existingProp) out._sequence_queue_proposal = proposal;
  else if (proposal && existingProp?.family === CONTINUATION_FAMILY) {
    out._sequence_queue_proposal = proposal;
  }
  if (play) {
    const existing = out._model_play || out.__model_play;
    if (!existing || existing.paper === true || !existing.play_vehicle) {
      out._model_play = { ...(existing || {}), ...play };
    }
  }
  if (proposal || play) {
    out._continuation_detect = detectMomentumContinuation(payload, daCfg);
  }
  return out;
}

/** Size mult when continuation paper proposal is active. */
export function continuationPaperSizeMult(tickerData, daCfg = {}) {
  const proposal = tickerData?._sequence_queue_proposal;
  if (!proposal?.paper || proposal.family !== CONTINUATION_FAMILY) return 1;
  const cfg = loadContinuationConfig(daCfg);
  if (!cfg.enabled) return 1;
  const m = Number(proposal.size_mult);
  return Number.isFinite(m) && m > 0 && m <= 1 ? m : cfg.sizeMult;
}
