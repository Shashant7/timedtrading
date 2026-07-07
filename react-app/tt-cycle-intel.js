/**
 * Shared formatters for Daily Cycle Composite + TT Intel (FSD level overlay).
 * Used by Today page (market-wide) and Right Rail (per-ticker).
 */
(function () {
  "use strict";

  const CYCLE_LABEL = {
    uptrend: "Uptrend",
    downtrend: "Downtrend",
    transitional: "Transitional",
  };

  const ALIGN_COLOR = {
    aligned: "var(--tt-up-soft, #22c55e)",
    divergent: "var(--tt-dn-soft, #ef4444)",
    mixed: "var(--tt-warn, #f59e0b)",
    computed_only: "var(--tt-text-muted, #94a3b8)",
    fsd_only: "var(--tt-accent, #60a5fa)",
    none: "var(--tt-text-faint, #64748b)",
  };

  const MODE_LABEL = {
    defensive: "Defensive",
    neutral: "Neutral",
    aggressive: "Aggressive",
  };

  const SECTOR_SHORT = {
    "Information Technology": "Tech",
    "Consumer Discretionary": "Cons Disc",
    "Communication Services": "Comm Svcs",
    "Health Care": "Health",
    "Healthcare": "Health",
    "Financials": "Financials",
    "Industrials": "Industrials",
    "Consumer Staples": "Staples",
    "Energy": "Energy",
    "Utilities": "Utilities",
    "Real Estate": "Real Est",
    "Basic Materials": "Materials",
  };

  function cycleLabel(c) {
    return CYCLE_LABEL[String(c || "").toLowerCase()] || (c ? String(c) : "—");
  }

  function alignmentColor(a) {
    return ALIGN_COLOR[String(a || "").toLowerCase()] || ALIGN_COLOR.none;
  }

  function modeLabel(m) {
    return MODE_LABEL[String(m || "").toLowerCase()] || (m ? String(m) : "Neutral");
  }

  function sectorShort(name) {
    return SECTOR_SHORT[name] || String(name || "").replace(/ Sector$/i, "").slice(0, 14);
  }

  function formatCycleChip(cycle, alignment) {
    const c = cycleLabel(cycle);
    const cycleCtx = c !== "—" ? `Cycle: ${c}` : c;
    const a = String(alignment || "").toLowerCase();
    if (!a || a === "none" || a === "computed_only") return cycleCtx;
    const alignLabel = a === "aligned"
      ? "aligned w/ desk"
      : a === "divergent"
        ? "diverges from desk"
        : a.replace(/_/g, " ");
    return `${cycleCtx} · ${alignLabel}`;
  }

  window.TTCycleIntel = {
    cycleLabel,
    alignmentColor,
    modeLabel,
    sectorShort,
    formatCycleChip,
  };
})();
