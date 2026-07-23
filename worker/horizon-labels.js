// Shared Short Term / Long Term display labels.
// Internal mode keys stay trader|investor; user-facing copy uses these helpers.

export function horizonFromMode(modeOrHorizon) {
  const h = String(modeOrHorizon || "").toLowerCase();
  if (h === "investor" || h === "long_term" || h === "lt" || h === "long-term") return "long_term";
  return "short_term";
}

export function isLongTermHorizon(modeOrHorizon) {
  return horizonFromMode(modeOrHorizon) === "long_term";
}

/** @returns {"Short Term"|"Long Term"} */
export function horizonLabel(modeOrHorizon, { upper = false, compact = false } = {}) {
  const lt = isLongTermHorizon(modeOrHorizon);
  let label = compact ? (lt ? "LT" : "ST") : (lt ? "Long Term" : "Short Term");
  if (upper) label = label.toUpperCase();
  return label;
}

/** Discord / email title prefix, e.g. "SHORT TERM ·" / "LONG TERM ·" */
export function horizonPrefix(modeOrHorizon) {
  return `${horizonLabel(modeOrHorizon, { upper: true })} · `;
}
