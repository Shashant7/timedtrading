// Observed 0–10 setup grade. Five pillars, two points each. Missing is not a pass.
// Ticker Grader's marketing shape (structure / tape / macro / value / desk) mapped
// onto signals Timed already computes. No fitted weights, no Form 4, no exit trapdoor.
import { observedSetupVolume, meetsSetupVolume, finiteSetupNumber } from "./setup-evidence.js";

export const SETUP_GRADE_VERSION = "setup-grade-v1";
export const SETUP_GRADE_MAX = 10;
export const SETUP_GRADE_PILLAR_POINTS = 2;
export const SETUP_GRADE_DEFAULT_FLOOR = 6;
export const SETUP_GRADE_DEFAULT_RVOL = 1.2;

const LONG_STATES = new Set([
  "HTF_BULL_LTF_BULL",
  "HTF_BULL_LTF_PULLBACK",
  "HTF_NEUTRAL_LTF_BULL",
  "TRANSITIONAL_BULL",
  "EARLY_BULL",
]);
const SHORT_STATES = new Set([
  "HTF_BEAR_LTF_BEAR",
  "HTF_BEAR_LTF_BOUNCE",
  "HTF_NEUTRAL_LTF_BEAR",
  "TRANSITIONAL_BEAR",
  "EARLY_BEAR",
]);

export function setupGradeEnabled(daCfg = {}) {
  return String(daCfg.deep_audit_setup_grade_enabled ?? "true") === "true";
}

export function setupGradeFloor(daCfg = {}) {
  const n = Number(daCfg.deep_audit_setup_grade_floor);
  return Number.isFinite(n) && n >= 0 && n <= SETUP_GRADE_MAX ? n : SETUP_GRADE_DEFAULT_FLOOR;
}

export function setupGradeRvolFloor(daCfg = {}) {
  const n = Number(daCfg.deep_audit_setup_grade_rvol);
  return Number.isFinite(n) && n >= 0 ? n : SETUP_GRADE_DEFAULT_RVOL;
}

/** Index model and paper-family experiments keep their own admission. */
export function isSetupGradeExemptPath(path) {
  const p = String(path || "").toLowerCase();
  if (!p) return false;
  return /index_etf|index_dt|day_trade|cloud_pivot|confirm_stack|momentum_continuation/.test(p);
}

function signedTilt(d, field) {
  const applied = finiteSetupNumber(d?.[field]);
  if (applied != null) return { value: applied, source: "applied" };
  const shadow = finiteSetupNumber(d?.[`${field}_shadow`]);
  if (shadow != null) return { value: shadow, source: "shadow" };
  return { value: null, source: "missing" };
}

function pillarFromTilt(id, tilt) {
  if (tilt.value == null) return { id, points: 0, status: "missing", source: tilt.source };
  if (tilt.value > 0) {
    return { id, points: SETUP_GRADE_PILLAR_POINTS, status: "aligned", source: tilt.source, value: tilt.value };
  }
  return {
    id, points: 0, status: tilt.value < 0 ? "opposed" : "flat",
    source: tilt.source, value: tilt.value,
  };
}

function stateAligned(state, side) {
  const st = String(state || "").toUpperCase().trim();
  if (!st) return { known: false, aligned: false };
  if (side === "LONG") {
    if (st.startsWith("HTF_BEAR")) return { known: true, aligned: false };
    if (LONG_STATES.has(st) || st.startsWith("HTF_BULL")) return { known: true, aligned: true };
    return { known: true, aligned: false };
  }
  if (side === "SHORT") {
    if (st.startsWith("HTF_BULL")) return { known: true, aligned: false };
    if (SHORT_STATES.has(st) || st.startsWith("HTF_BEAR")) return { known: true, aligned: true };
    return { known: true, aligned: false };
  }
  return { known: true, aligned: false };
}

export function gradeStructure(d = {}, side) {
  const validSide = side === "LONG" || side === "SHORT" ? side : null;
  if (!validSide) return { id: "structure", points: 0, status: "missing", detail: "no_side" };
  const state = d?.state;
  const ds = d?.daily_structure || {};
  const stateHit = stateAligned(state, validSide);
  const stackKnown = ds.bull_stack === true || ds.bear_stack === true;
  const stackOk = validSide === "LONG" ? ds.bull_stack === true : ds.bear_stack === true;
  if (!stateHit.known && !stackKnown) {
    return { id: "structure", points: 0, status: "missing", detail: "no_state_or_stack" };
  }
  if (stateHit.aligned || stackOk) {
    return {
      id: "structure",
      points: SETUP_GRADE_PILLAR_POINTS,
      status: "aligned",
      detail: stateHit.aligned && stackOk ? "state+stack" : stateHit.aligned ? "state" : "stack",
      state: state || null,
    };
  }
  return { id: "structure", points: 0, status: "opposed", detail: String(state || "no_aligned_stack"), state: state || null };
}

function squeezeReleased(d = {}) {
  const flags = d?.flags || {};
  if (flags.sq30_release === true || flags.sq10_release === true) return true;
  const sq = d?.squeeze || {};
  if (sq.r === 1 || sq.release === true) return true;
  for (const key of ["10", "15", "30", "1H"]) {
    const row = sq[key];
    if (row && (row.r === 1 || row.release === true)) return true;
  }
  return false;
}

function stDirMatchesSide(d = {}, side) {
  const tfs = d?.tf_tech || {};
  for (const key of ["30", "10", "15"]) {
    const dir = Number(tfs[key]?.stDir);
    if (!Number.isFinite(dir) || dir === 0) continue;
    if (side === "LONG" && dir > 0) return true;
    if (side === "SHORT" && dir < 0) return true;
  }
  return false;
}

export function gradeTape(d = {}, side, rvolFloor = SETUP_GRADE_DEFAULT_RVOL) {
  const volume = observedSetupVolume(d);
  const rvolOk = meetsSetupVolume(volume, rvolFloor);
  const released = squeezeReleased(d);
  const validSide = side === "LONG" || side === "SHORT" ? side : null;
  const directional = released && validSide && stDirMatchesSide(d, validSide);
  if (rvolOk || directional) {
    return {
      id: "tape",
      points: SETUP_GRADE_PILLAR_POINTS,
      status: "aligned",
      detail: rvolOk && directional ? "rvol+squeeze" : rvolOk ? "rvol" : "squeeze_release",
      rvol: volume.value,
      rvol_source: volume.source,
    };
  }
  if (volume.value == null && !released) {
    return { id: "tape", points: 0, status: "missing", detail: "no_rvol_or_squeeze" };
  }
  return {
    id: "tape",
    points: 0,
    status: released ? "opposed" : "weak",
    detail: released ? "squeeze_release_not_directional" : "rvol_below_floor",
    rvol: volume.value,
  };
}

export function gradeMacro(d = {}) {
  const theme = signedTilt(d, "_theme_tilt");
  const wire = signedTilt(d, "_macro_wire_tilt");
  if ((theme.value != null && theme.value > 0) || (wire.value != null && wire.value > 0)) {
    return {
      id: "macro",
      points: SETUP_GRADE_PILLAR_POINTS,
      status: "aligned",
      theme: theme.value,
      wire: wire.value,
    };
  }
  if (theme.value == null && wire.value == null) {
    return { id: "macro", points: 0, status: "missing" };
  }
  return { id: "macro", points: 0, status: "opposed_or_flat", theme: theme.value, wire: wire.value };
}

export function gradeValue(d = {}) {
  return pillarFromTilt("value", signedTilt(d, "_fv_tilt"));
}

export function gradeOfficer(d = {}, side) {
  const tilt = signedTilt(d, "_officer_tilt");
  if (tilt.value != null && tilt.value > 0) {
    return {
      id: "officer",
      points: SETUP_GRADE_PILLAR_POINTS,
      status: "aligned",
      source: tilt.source,
      value: tilt.value,
    };
  }
  const rating = String(d?._sector_rating || "").toLowerCase();
  if (rating) {
    const ow = rating.includes("over");
    const uw = rating.includes("under");
    if (side === "LONG" && ow) {
      return { id: "officer", points: SETUP_GRADE_PILLAR_POINTS, status: "aligned", source: "sector_rating", rating };
    }
    if (side === "SHORT" && uw) {
      return { id: "officer", points: SETUP_GRADE_PILLAR_POINTS, status: "aligned", source: "sector_rating", rating };
    }
    if (tilt.value == null) {
      return { id: "officer", points: 0, status: "flat", source: "sector_rating", rating };
    }
  }
  if (tilt.value == null) return { id: "officer", points: 0, status: "missing" };
  return {
    id: "officer",
    points: 0,
    status: tilt.value < 0 ? "opposed" : "flat",
    source: tilt.source,
    value: tilt.value,
  };
}

export function evaluateSetupGrade(d = {}, { side, rvolFloor } = {}) {
  const validSide = side === "LONG" || side === "SHORT" ? side : null;
  const parts = [
    gradeStructure(d, validSide),
    gradeTape(d, validSide, rvolFloor ?? SETUP_GRADE_DEFAULT_RVOL),
    gradeMacro(d),
    gradeValue(d),
    gradeOfficer(d, validSide),
  ];
  const score = parts.reduce((sum, part) => sum + part.points, 0);
  const failed = parts.filter((p) => p.points === 0).map((p) => `${p.id}:${p.status}`);
  return {
    version: SETUP_GRADE_VERSION,
    side: validSide,
    score,
    max: SETUP_GRADE_MAX,
    parts,
    reason: failed.length ? failed.join(",") : "all_aligned",
  };
}

export function admitSetupGrade(d, { side, path, daCfg } = {}) {
  const floor = setupGradeFloor(daCfg);
  const grade = evaluateSetupGrade(d, { side, rvolFloor: setupGradeRvolFloor(daCfg) });
  const enabled = setupGradeEnabled(daCfg);
  const exempt = isSetupGradeExemptPath(path);
  const applied = enabled && !exempt;
  const allow = !applied || grade.score >= floor;
  const out = {
    ...grade,
    enabled,
    exempt,
    applied,
    floor,
    allow,
    reason: !enabled
      ? "setup_grade_disabled"
      : exempt
        ? "setup_grade_exempt_path"
        : allow
          ? "setup_grade_passed"
          : `setup_grade_below_floor:${grade.score}<${floor}`,
  };
  if (d && typeof d === "object") {
    d.__setup_grade = out;
    if (d.__setup_evaluation && typeof d.__setup_evaluation === "object") {
      d.__setup_evaluation.setup_grade = out;
    }
  }
  return out;
}
