/* shared-rail-bootstrap.js
 *
 * Wires `window.TickerDetailRightRailFactory` (from shared-right-rail.js)
 * with the SAME helpers /index-react.html uses. No stubs.
 *
 * Load order on a host page:
 *   1. shared-price-utils.js        → window.TimedPriceUtils
 *   2. shared-bubble-chart.js       → window.TimedBubbleChart  (most helpers)
 *   3. shared-rail-helpers.js       → window.TimedRailHelpers (remaining helpers)
 *   4. shared-right-rail.js         → window.TickerDetailRightRailFactory
 *   5. shared-rail-bootstrap.js     → window.TimedRightRail  (this file)
 *
 * Then inside React:
 *   const Rail = window.TimedRightRail.Component;
 *   <Rail ticker={...} onClose={...} allLoadedData={...} />
 *
 * Notes:
 *  - We deliberately pull helpers fresh on each call to support late ETF
 *    group loading (loadETFGroups() populates GRNI/GRNJ/GRNY after fetch).
 *  - All helpers are verbatim ports from /index-react.source.html so the
 *    rail's data labels, action card text, pattern detection, sector
 *    rollups, and group mapping all match Active Trader exactly.
 */
(function () {
  if (typeof window === "undefined") return;
  if (typeof React === "undefined") {
    console.warn("[rail-bootstrap] React not loaded; bailing");
    return;
  }
  if (typeof window.TickerDetailRightRailFactory !== "function") {
    console.warn("[rail-bootstrap] shared-right-rail.js not loaded; bailing");
    return;
  }

  const PU = window.TimedPriceUtils || {};
  const TT = window.TimedBubbleChart  || {};
  const RH = window.TimedRailHelpers  || {};

  // ── Currency formatters — verbatim from /index-react.source.html:1182 ──
  function fmtUsd(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    return new Intl.NumberFormat("en-US", {
      style: "currency", currency: "USD", maximumFractionDigits: 2,
    }).format(n);
  }
  function fmtUsdAbs(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return `$${Math.abs(v).toFixed(2)}`;
  }

  // Fallbacks (used only if the module isn't loaded — keep behavior safe).
  const noop      = () => null;
  const emptyArr  = () => [];
  const passthrough = (v) => Array.isArray(v) ? v : [];

  const Component = window.TickerDetailRightRailFactory({
    React,
    API_BASE: window.TT_API_BASE || "",
    fmtUsd, fmtUsdAbs,

    // From TimedPriceUtils
    getDailyChange:        PU.getDailyChange         || noop,
    isNyRegularMarketOpen: PU.isNyRegularMarketOpen  || (() => false),
    getStaleInfo:          PU.getStaleInfo           || (() => ({ isStale: false, ageMs: 0, ageLabel: "" })),

    // From TimedBubbleChart
    isPrimeBubble:           TT.isPrimeBubble           || (() => false),
    entryType:               TT.entryType               || (() => ({ corridor: false, side: null })),
    rankScoreForTicker:      TT.rankScoreForTicker      || (() => 0),
    getRankedTickers:        TT.getRankedTickers        || ((d) => Array.isArray(d) ? d : Object.values(d || {})),
    getRankPosition:         TT.getRankPosition         || (() => null),
    getRankPositionFromMap:  TT.getRankPositionFromMap  || (() => null),
    phaseToColor:            TT.phaseToColor            || (() => "#9ca3af"),
    completionForSize:       TT.completionForSize       || ((t) => Number(t?.completion) || 0),
    computeEtaDays:          TT.computeEtaDays          || ((t) => Number(t?.eta_days_v2 ?? t?.eta_days) || null),
    computeReturnPct:        TT.computeReturnPct        || (() => null),
    computeRiskPct:          TT.computeRiskPct          || (() => null),
    summarizeEntryDecision:  TT.summarizeEntryDecision  || (() => null),
    getDirectionFromState:   TT.getDirectionFromState   || (() => ""),
    numFromAny:              TT.numFromAny              || ((v) => { const n = Number(v); return Number.isFinite(n) ? n : null; }),

    // From TimedRailHelpers — verbatim ports from index-react.source.html
    detectPatterns:           RH.detectPatterns           || emptyArr,
    normalizeTrailPoints:     RH.normalizeTrailPoints     || passthrough,
    computeHorizonBucket:     RH.computeHorizonBucket     || (() => "—"),
    computeTpTargetPrice:     RH.computeTpTargetPrice     || ((t) => Number(t?.tp) || null),
    computeTpMaxPrice:        RH.computeTpMaxPrice        || ((t) => Number(t?.tp_max ?? t?.tp) || null),
    getDirection:             RH.getDirection             || (() => ({ text: "—", color: "text-[#6b7280]", bg: "bg-white/[0.04]" })),
    getActionDescription:     RH.getActionDescription     || (() => ({ action: "Monitor", description: "", color: "text-[#6b7280]", bg: "bg-white/[0.04]" })),
    groupsForTicker:          RH.groupsForTicker          || (() => ["Other"]),
    GROUP_ORDER:              RH.GROUP_ORDER              || ["Other"],
    GROUP_LABELS:             RH.GROUP_LABELS             || { Other: "Other" },
    TRADE_SIZE:               RH.TRADE_SIZE               || 1000,
    FUTURES_SPECS:            RH.FUTURES_SPECS            || {},
    downsampleByInterval:     RH.downsampleByInterval     || passthrough,
    getTickerSector:          RH.getTickerSector          || (() => ""),
    normalizeSectorKey:       RH.normalizeSectorKey       || ((s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ")),
    sectorKeyToCanonicalName: RH.sectorKeyToCanonicalName || ((k) => k || ""),
  });

  window.TimedRightRail = {
    Component,
    helpers: { fmtUsd, fmtUsdAbs },
  };

  // ── RailOverlay — a self-contained React component that hosts the
  // ticker-detail panel as a slide-in drawer. Pages can render it like:
  //   const Rail = window.TimedRightRail.Overlay;
  //   <Rail ticker={selectedTicker} allLoadedData={data} onClose={...} />
  const e = React.createElement;
  function RailOverlay(props) {
    const { ticker, allLoadedData, onClose } = props || {};
    React.useEffect(() => {
      if (!ticker) return;
      const onKey = (ev) => { if (ev.key === "Escape") onClose && onClose(); };
      document.addEventListener("keydown", onKey);
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.removeEventListener("keydown", onKey);
        document.body.style.overflow = prev;
      };
    }, [ticker, onClose]);
    if (!ticker) return null;
    return e(React.Fragment, null,
      e("div", {
        className: "rail-backdrop",
        onClick: onClose,
        "aria-hidden": "true",
      }),
      e("aside", {
        className: "rail-panel",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": `${ticker.ticker || ticker.symbol || "Ticker"} detail`,
      },
        e("button", {
          className: "rail-close",
          onClick: onClose,
          "aria-label": "Close ticker detail",
          title: "Close (Esc)",
        }, "✕"),
        e(Component, {
          ticker,
          allLoadedData: allLoadedData || null,
          onClose,
        }),
      ),
    );
  }
  window.TimedRightRail.Overlay = RailOverlay;
})();
