// worker/cio/cio-context-gate.js
//
// Deterministic CIO context enforcement. The 13–19 Aug book showed the
// model ADJUSTing Speculative ATH / support / range-reversal longs in
// high-confidence CHOP (HMM posterior ~0.99). Reduced size still lost
// $80–$128. ADJUST is not a decision on a location that should not exist.
//
// The LLM still runs first (so reasoning and APPROVE/REJECT on other
// classes stay intact). This gate upgrades APPROVE/ADJUST → REJECT when
// the context cluster matches. Flag: cio_speculative_chop_reject_enabled
// (default ON once set; explicit "false" disables).

const FRAGILE_SETUP_RE = /ath[_\s-]?breakout|n[_\s-]?test[_\s-]?support|support[_\s-]?bounce|range[_\s-]?reversal/i;

const flagOn = (v) => {
  if (v === undefined || v === null || v === "") return true; // default ON
  return v === true || String(v).toLowerCase() === "true" || String(v) === "1";
};

export function isHighChopHmm(hmm) {
  if (!hmm || typeof hmm !== "object") return false;
  const state = String(hmm.state || "").toUpperCase();
  if (state !== "CHOP") return false;
  const post = Number(hmm.posterior_top ?? hmm.chop ?? hmm.posterior);
  if (Number.isFinite(post) && post >= 0.55) return true;
  return String(hmm.confidence_label || "").toLowerCase() === "high";
}

export function isSpeculativeOrUnknownGrade(grade) {
  const g = String(grade || "").trim();
  if (!g) return true; // empty grade was the July admission hole
  return /speculative/i.test(g);
}

export function isFragileChopSetup(name) {
  return FRAGILE_SETUP_RE.test(String(name || ""));
}

/**
 * Elder / Brooks triple-screen: a 10m trigger that is opposed on BOTH
 * 30m and 1H is a lower-timeframe chase, not a confirmed sequence.
 * stDir convention: -1 bull, +1 bear (matches index.js _htfStBull).
 */
export function condenseMtfSequence(tickerData, direction) {
  const isLong = String(direction || "").toUpperCase() !== "SHORT";
  const wantSt = isLong ? -1 : 1;
  const tf = tickerData?.tf_tech || {};
  const c10 = tf["10"]?.ripster?.c5_12;
  const trigger10m = isLong ? !!c10?.bull : !!c10?.bear;
  const st30 = Number(tf["30"]?.stDir);
  const st1h = Number(tf["1H"]?.stDir);
  const stD = Number(tf.D?.stDir);
  const aligned30 = Number.isFinite(st30) && st30 === wantSt;
  const aligned1h = Number.isFinite(st1h) && st1h === wantSt;
  const alignedD = Number.isFinite(stD) && stD === wantSt;
  const known30 = Number.isFinite(st30);
  const known1h = Number.isFinite(st1h);
  const opposed30 = known30 && !aligned30;
  const opposed1h = known1h && !aligned1h;
  return {
    trigger_10m: trigger10m,
    st_dir_30m: known30 ? st30 : null,
    st_dir_1h: known1h ? st1h : null,
    st_dir_d: Number.isFinite(stD) ? stD : null,
    aligned_30m: aligned30,
    aligned_1h: aligned1h,
    aligned_d: alignedD,
    confirm_count: [aligned30, aligned1h, alignedD].filter(Boolean).length,
    htf_opposed: opposed30 && opposed1h,
  };
}

export function shouldRejectSpeculativeChop(proposal) {
  if (!proposal || typeof proposal !== "object") return { reject: false, reason: null };
  const dir = String(proposal.direction || "").toUpperCase();
  if (dir && dir !== "LONG") return { reject: false, reason: null };
  const chop = isHighChopHmm(proposal.hmm_regime);
  if (!chop) return { reject: false, reason: null };
  const fragile = isFragileChopSetup(proposal.setup?.name || proposal.entry_path);
  if (!fragile) return { reject: false, reason: null };
  const spec = isSpeculativeOrUnknownGrade(proposal.setup?.grade);
  if (!spec) return { reject: false, reason: null };
  return {
    reject: true,
    reason: "speculative_chop_fragile_setup",
    detail: {
      setup: proposal.setup?.name || proposal.entry_path || null,
      grade: proposal.setup?.grade || "",
      hmm: proposal.hmm_regime?.state || null,
      posterior: proposal.hmm_regime?.posterior_top ?? null,
    },
  };
}

export function shouldRejectMtfChase(proposal) {
  if (!proposal || typeof proposal !== "object") return { reject: false, reason: null };
  const seq = proposal.mtf_sequence;
  if (!seq || seq.htf_opposed !== true) return { reject: false, reason: null };
  if (!isHighChopHmm(proposal.hmm_regime)) return { reject: false, reason: null };
  const fragile = isFragileChopSetup(proposal.setup?.name || proposal.entry_path);
  const spec = isSpeculativeOrUnknownGrade(proposal.setup?.grade);
  if (!fragile && !spec) return { reject: false, reason: null };
  if (seq.trigger_10m !== true && !fragile) return { reject: false, reason: null };
  return {
    reject: true,
    reason: "mtf_10m_chase_htf_opposed",
    detail: {
      trigger_10m: seq.trigger_10m,
      aligned_30m: seq.aligned_30m,
      aligned_1h: seq.aligned_1h,
      confirm_count: seq.confirm_count,
    },
  };
}

/**
 * Apply context enforcement to a parsed CIO decision.
 * Leaves REJECT alone. Upgrades APPROVE/ADJUST when a hard-context
 * cluster matches. No-ops when the flag is explicitly false.
 */
export function applyCioContextVerdict(proposal, parsed, cfg = {}) {
  const out = parsed && typeof parsed === "object" ? { ...parsed } : { decision: "APPROVE" };
  if (!flagOn(cfg.cio_speculative_chop_reject_enabled)) return out;

  const decision = String(out.decision || "APPROVE").toUpperCase();
  if (decision === "REJECT") return out;

  const spec = shouldRejectSpeculativeChop(proposal);
  const chase = shouldRejectMtfChase(proposal);
  const hit = spec.reject ? spec : chase.reject ? chase : null;
  if (!hit) return out;

  const prior = String(out.reasoning || "").trim();
  const prefix = `[context-enforce ${hit.reason}] ADJUST is not a decision here.`;
  return {
    ...out,
    decision: "REJECT",
    reasoning: prior ? `${prefix} ${prior}`.slice(0, 4000) : prefix,
    adjustments: null,
    risk_flags: Array.from(new Set([
      ...(Array.isArray(out.risk_flags) ? out.risk_flags : []),
      hit.reason,
    ])).slice(0, 5),
    context_enforced: true,
    context_reason: hit.reason,
  };
}

export default {
  isHighChopHmm,
  isSpeculativeOrUnknownGrade,
  isFragileChopSetup,
  condenseMtfSequence,
  shouldRejectSpeculativeChop,
  shouldRejectMtfChase,
  applyCioContextVerdict,
};
