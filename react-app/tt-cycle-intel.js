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

  const CYCLE_COLOR = {
    uptrend: "var(--tt-up-soft, #22c55e)",
    downtrend: "var(--tt-dn-soft, #ef4444)",
    transitional: "var(--tt-warn, #f59e0b)",
  };

  function cycleColor(c) {
    return CYCLE_COLOR[String(c || "").toLowerCase()] || "var(--tt-text-muted, #94a3b8)";
  }

  function formatIndexMix(mix) {
    if (!mix || typeof mix !== "object") return null;
    const parts = [];
    if (mix.uptrend) parts.push(`${mix.uptrend} up`);
    if (mix.transitional) parts.push(`${mix.transitional} trans`);
    if (mix.downtrend) parts.push(`${mix.downtrend} down`);
    return parts.length ? parts.join(" · ") : null;
  }

  function formatTransition(t) {
    if (!t) return "";
    const from = cycleLabel(t.from);
    const to = cycleLabel(t.to);
    return `${t.symbol}: ${from} → ${to}`;
  }

  function formatSpotlightLabel(sp) {
    if (!sp) return "—";
    const c = cycleLabel(sp.computed_cycle);
    const harmonic = sp.harmonic && sp.harmonic.ok ? formatHarmonicSummary(sp.harmonic) : null;
    const cyclical = harmonic || (sp.cyclical_phase ? ` · ${sp.cyclical_phase}` : "");
    const desk = sp.fsd_phase ? ` · desk ${sp.fsd_phase}` : "";
    const src = sp.cycle_source === "own_regime" ? "" : (sp.home_index ? ` · via ${sp.home_index}` : "");
    return `${c}${cyclical}${desk}${src}`;
  }

  function formatHarmonicSummary(h) {
    if (!h || !h.ok) return null;
    const periods = Array.isArray(h.dominant_periods) ? h.dominant_periods.slice(0, 3).join("d · ") : "";
    const pct = Number.isFinite(h.phase_pct) ? Math.round(h.phase_pct * 100) : null;
    const head = h.label || "harmonic cycle";
    const tail = [
      h.primary_period ? `${h.primary_period}d primary` : null,
      pct != null ? `${pct}% phase` : null,
      h.direction ? h.direction : null,
      periods ? `mix ${periods}d` : null,
    ].filter(Boolean).join(" · ");
    return ` · ${head}${tail ? ` (${tail})` : ""}`;
  }

  function formatRotationState(state) {
    const map = {
      risk_on: "Risk-on rotation",
      risk_off: "Risk-off rotation",
      balanced: "Balanced rotation",
      unknown: "Rotation n/a",
    };
    return map[String(state || "").toLowerCase()] || state || "—";
  }

  function formatSectorWatchReason(reason) {
    const map = {
      cycle_shift: "cycle just shifted",
      vs_market: "vs market breadth",
      desk_divergence: "desk diverges",
      pinned: "desk focus",
      rotation: "rotation watch",
      own_regime: "own regime",
    };
    return map[String(reason || "").toLowerCase()] || reason || "";
  }

  function formatCycleChip(cycle, alignment, opts) {
    const c = cycleLabel(cycle);
    const cycleCtx = c !== "—" ? `HTF cycle: ${c}` : c;
    const a = String(alignment || "").toLowerCase();
    if (opts && opts.short) return cycleCtx;
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
    cycleColor,
    alignmentColor,
    modeLabel,
    sectorShort,
    formatCycleChip,
    formatIndexMix,
    formatTransition,
    formatSpotlightLabel,
    formatHarmonicSummary,
    formatRotationState,
    formatSectorWatchReason,
  };
})();
