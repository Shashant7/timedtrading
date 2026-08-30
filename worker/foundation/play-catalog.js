// Canonical core-play catalog.
//
// One play = one id (`tt_gap_reversal_long`) + one label ("Gap Reversal Long").
// Historical D1 wrote the label without `entry_path`; May 2026+ wrote the id.
// Those are the SAME play. Analysis that splits setup_name vs entry_path
// invents a second implementation that does not exist.
//
// Status:
//   live       — take when the detector + admission matrix fire
//   restricted — take only through the admission matrix (wildcard on)
//   paused     — hard reject at qualify (live book is a bleeder)

export const PLAY_STATUS = Object.freeze({
  LIVE: "live",
  RESTRICTED: "restricted",
  PAUSED: "paused",
});

function play(row) {
  return Object.freeze({
    aliases: [],
    demotion_label: null,
    role: "core",
    ...row,
  });
}

export const CORE_PLAYS = Object.freeze([
  play({
    id: "tt_gap_reversal_long",
    label: "Gap Reversal Long",
    direction: "LONG",
    status: PLAY_STATUS.LIVE,
    role: "workhorse",
    demotion_label: "TT Gap Reversal (Long)",
    aliases: [
      "gap reversal long",
      "gap reversal (long)",
      "tt gap reversal long",
      "tt gap reversal (long)",
      "tt tt gap reversal long",
    ],
  }),
  play({
    id: "tt_gap_reversal_short",
    label: "Gap Reversal Short",
    direction: "SHORT",
    status: PLAY_STATUS.LIVE,
    role: "bear_only",
    demotion_label: "TT Gap Reversal (Short)",
    aliases: [
      "gap reversal short",
      "gap reversal (short)",
      "tt gap reversal short",
      "tt gap reversal (short)",
    ],
  }),
  play({
    id: "tt_n_test_support",
    label: "Support Bounce",
    direction: "LONG",
    status: PLAY_STATUS.RESTRICTED,
    demotion_label: "TT Support Bounce",
    aliases: [
      "support bounce",
      "n test support",
      "n-test support",
      "tt support bounce",
      "tt n test support",
    ],
  }),
  play({
    id: "tt_n_test_resistance",
    label: "Resistance Fade",
    direction: "SHORT",
    status: PLAY_STATUS.RESTRICTED,
    demotion_label: "TT Resistance Fade",
    aliases: [
      "resistance fade",
      "n test resistance",
      "n-test resistance",
      "tt resistance fade",
      "tt n test resistance",
    ],
  }),
  play({
    id: "tt_range_reversal_long",
    label: "Range Reversal Long",
    direction: "LONG",
    status: PLAY_STATUS.PAUSED,
    demotion_label: "TT Range Reversal (Long)",
    aliases: [
      "range reversal long",
      "range reversal (long)",
      "tt range reversal long",
      "tt range reversal (long)",
    ],
  }),
  play({
    id: "tt_range_reversal_short",
    label: "Range Reversal Short",
    direction: "SHORT",
    status: PLAY_STATUS.PAUSED,
    demotion_label: "TT Range Reversal (Short)",
    aliases: [
      "range reversal short",
      "range reversal (short)",
      "tt range reversal short",
      "tt range reversal (short)",
    ],
  }),
  play({
    id: "tt_ath_breakout",
    label: "ATH Breakout",
    direction: "LONG",
    status: PLAY_STATUS.RESTRICTED,
    demotion_label: "TT ATH Breakout",
    aliases: [
      "ath breakout",
      "tt ath breakout",
      "tt tt ath breakout",
    ],
  }),
  play({
    id: "tt_atl_breakdown",
    label: "ATL Breakdown",
    direction: "SHORT",
    status: PLAY_STATUS.RESTRICTED,
    demotion_label: "TT ATL Breakdown",
    aliases: [
      "atl breakdown",
      "tt atl breakdown",
    ],
  }),
  // Paper-sized family (first print 2026-08-24). Loop 1 + Trade Review
  // must see this id. Auto-demote must not — three days of 0.1× paper
  // is refinement, not a pause.
  play({
    id: "tt_cloud_pivot",
    label: "Cloud Pivot",
    direction: "LONG",
    status: PLAY_STATUS.RESTRICTED,
    role: "calibration",
    demotion_label: "TT Cloud Pivot",
    aliases: [
      "cloud pivot",
      "tt cloud pivot",
      "tt tt cloud pivot",
    ],
  }),
  play({
    id: "tt_pullback",
    label: "Pullback Reclaim",
    direction: "LONG",
    status: PLAY_STATUS.LIVE,
    demotion_label: "TT Pullback Reclaim",
    aliases: [
      "pullback",
      "pullback reclaim",
      "tt pullback",
      "tt pullback reclaim",
    ],
  }),
  play({
    id: "tt_reclaim",
    label: "Reclaim Long",
    direction: "LONG",
    status: PLAY_STATUS.LIVE,
    demotion_label: "TT Reclaim Long",
    aliases: ["reclaim", "reclaim long", "tt reclaim", "tt reclaim long"],
  }),
  play({
    id: "tt_htf_reclaim",
    label: "HTF Reclaim",
    direction: "LONG",
    status: PLAY_STATUS.LIVE,
    demotion_label: "TT HTF Reclaim",
    aliases: ["htf reclaim", "tt htf reclaim"],
  }),
  play({
    id: "tt_forming_pair",
    label: "Forming Pair",
    direction: "LONG",
    status: PLAY_STATUS.LIVE,
    demotion_label: "TT Forming Pair",
    aliases: ["forming pair", "tt forming pair", "mtf forming"],
  }),
  play({
    id: "tt_momentum",
    label: "Momentum Push",
    direction: "LONG",
    status: PLAY_STATUS.LIVE,
    demotion_label: "TT Momentum Push",
    aliases: ["momentum", "momentum push", "tt momentum", "tt momentum push"],
  }),
  play({
    id: "tt_mean_revert",
    label: "Mean Reversion",
    direction: "LONG",
    status: PLAY_STATUS.LIVE,
    demotion_label: "TT Mean Reversion",
    aliases: ["mean revert", "mean reversion", "tt mean revert", "tt mean reversion"],
  }),
  play({
    id: "tt_index_etf_swing",
    label: "Index Swing",
    direction: "LONG",
    status: PLAY_STATUS.RESTRICTED,
    demotion_label: "TT Index Swing",
    aliases: ["index swing", "index etf swing", "tt index swing", "tt index etf swing"],
  }),
]);

const BY_ID = new Map(CORE_PLAYS.map((p) => [p.id, p]));

function norm(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^tt[\s_]+/g, "tt ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[()]/g, "")
    .trim();
}

const ALIAS_INDEX = new Map();
for (const p of CORE_PLAYS) {
  ALIAS_INDEX.set(norm(p.id), p);
  ALIAS_INDEX.set(norm(p.id.replace(/^tt_/, "")), p);
  ALIAS_INDEX.set(norm(p.label), p);
  if (p.demotion_label) ALIAS_INDEX.set(norm(p.demotion_label), p);
  for (const a of p.aliases) ALIAS_INDEX.set(norm(a), p);
}

const DIRECTION_PAIRS = Object.freeze({
  tt_gap_reversal_long: "tt_gap_reversal_short",
  tt_gap_reversal_short: "tt_gap_reversal_long",
  tt_n_test_support: "tt_n_test_resistance",
  tt_n_test_resistance: "tt_n_test_support",
  tt_range_reversal_long: "tt_range_reversal_short",
  tt_range_reversal_short: "tt_range_reversal_long",
  tt_ath_breakout: "tt_atl_breakdown",
  tt_atl_breakdown: "tt_ath_breakout",
});

/**
 * Resolve any historical label / engine path to one catalog play.
 * Direction, when provided, swaps ATH/ATL-style pairs.
 */
export function resolvePlay(raw, direction = null) {
  if (raw == null || raw === "") return null;
  const key = norm(raw);
  if (!key || key === "(unstamped)" || key === "(null)" || key === "(none)") return null;
  let play = ALIAS_INDEX.get(key) || BY_ID.get(String(raw).trim().toLowerCase()) || null;
  if (!play) return null;
  const dir = String(direction || "").toUpperCase();
  if (dir === "SHORT" || dir === "LONG") {
    const pairId = DIRECTION_PAIRS[play.id];
    if (pairId && play.direction !== dir) {
      play = BY_ID.get(pairId) || play;
    }
  }
  return play;
}

export function playLabel(raw, direction = null) {
  return resolvePlay(raw, direction)?.label || null;
}

export function isPlayPaused(raw, direction = null) {
  return resolvePlay(raw, direction)?.status === PLAY_STATUS.PAUSED;
}

export function isPlayRestricted(raw, direction = null) {
  return resolvePlay(raw, direction)?.status === PLAY_STATUS.RESTRICTED;
}

/** Roles the weekly governor may not auto-pause. */
export const NO_AUTO_DEMOTE_ROLES = Object.freeze(["workhorse", "calibration", "live_family"]);

export function isCalibrationPlay(raw, direction = null) {
  const play = typeof raw === "object" && raw?.id ? raw : resolvePlay(raw, direction);
  return play?.role === "calibration" || play?.role === "live_family";
}

/**
 * Auto-demote is for mature bleeders (ATH, Range Reversal).
 * A new paper family stays on the refinement path.
 */
export function canAutoDemotePlay(raw, direction = null) {
  const play = typeof raw === "object" && raw?.id ? raw : resolvePlay(raw, direction);
  if (!play) return { ok: false, reason: "unknown_play" };
  if (play.role === "workhorse") return { ok: false, reason: "workhorse_protected" };
  if (isCalibrationPlay(play)) return { ok: false, reason: "calibration_family" };
  return { ok: true, reason: "mature_bleeder" };
}

/** Prefer stamped path, then setup_name — both resolve to the same id. */
export function canonicalPlayId(entryPath, setupName, direction = null) {
  const path = String(entryPath || "").trim();
  const unstamped = !path || path === "(unstamped)" || path === "(null)";
  const fromPath = unstamped ? null : resolvePlay(path, direction);
  const fromSetup = resolvePlay(setupName, direction);
  return (fromPath || fromSetup)?.id || (unstamped ? null : path) || null;
}

export function demotionLabelForPath(path) {
  const play = resolvePlay(path);
  if (play?.demotion_label) return play.demotion_label;
  const raw = String(path || "").trim();
  if (!raw) return null;
  return `TT ${raw.replace(/^tt_/i, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}`;
}

export function catalogDemotionNameMap() {
  const out = {};
  for (const p of CORE_PLAYS) {
    if (p.demotion_label) out[p.id] = p.demotion_label;
  }
  return out;
}
