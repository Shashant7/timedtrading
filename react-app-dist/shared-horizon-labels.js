// Shared Short Term / Long Term display labels (frontend).
// Internal mode keys stay trader|investor; user-facing copy uses these helpers.
(function (root) {
  "use strict";

  function horizonFromMode(modeOrHorizon) {
    const h = String(modeOrHorizon || "").toLowerCase();
    if (h === "investor" || h === "long_term" || h === "lt" || h === "long-term") return "long_term";
    return "short_term";
  }

  function isLongTermHorizon(modeOrHorizon) {
    return horizonFromMode(modeOrHorizon) === "long_term";
  }

  function horizonLabel(modeOrHorizon, opts) {
    const upper = !!(opts && opts.upper);
    const compact = !!(opts && opts.compact);
    const lt = isLongTermHorizon(modeOrHorizon);
    let label = compact ? (lt ? "LT" : "ST") : (lt ? "Long Term" : "Short Term");
    if (upper) label = label.toUpperCase();
    return label;
  }

  function horizonPrefix(modeOrHorizon) {
    return horizonLabel(modeOrHorizon, { upper: true }) + " · ";
  }

  /** React list key when both horizons can show the same ticker. */
  function horizonCardKey(ticker, modeOrHorizon) {
    const sym = String(ticker || "").toUpperCase();
    return sym + ":" + horizonFromMode(modeOrHorizon);
  }

  const api = {
    horizonFromMode,
    isLongTermHorizon,
    horizonLabel,
    horizonPrefix,
    horizonCardKey,
  };

  root.TTHorizonLabels = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);

// cache-bust:1784828966647:250833413
