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
  //
  // The overlay also fetches /timed/latest?ticker=X and merges the
  // result into the ticker prop. This is required for the Technicals,
  // Analysis (Behavior Profile), and Fundamentals tabs because
  // /timed/all strips heavy fields (tf_tech, _ticker_profile,
  // td_sequential, fundamentals, etc.) to keep its response small,
  // while /timed/latest returns the full payload for a single ticker.
  // /index-react.html does the same dance in TickerDetailsLoader.
  const e = React.createElement;
  const { useState, useEffect, useMemo } = React;
  function RailOverlay(props) {
    const { ticker, allLoadedData, onClose } = props || {};
    const tickerSym = useMemo(() => String(ticker?.ticker || ticker?.symbol || "").toUpperCase(), [ticker]);

    // Full-payload fetch: hits /timed/latest for the open ticker so the
    // rail has tf_tech, td_sequential, _ticker_profile, fundamentals,
    // execution_profile, ichimoku_map, etc. — everything the heavy
    // tabs depend on. Hides behind a sentinel so we don't re-fetch on
    // every render. Falls back to the prop ticker if the fetch fails.
    const [fullPayload, setFullPayload] = useState(null);
    useEffect(() => {
      if (!tickerSym) { setFullPayload(null); return; }
      let alive = true;
      const ts = Date.now();
      fetch(`${API_BASE}/timed/latest?ticker=${encodeURIComponent(tickerSym)}&_t=${ts}`, {
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (!alive || !j?.ok) return;
          const latest = j.latestData || j.data || null;
          if (latest && typeof latest === "object") setFullPayload(latest);
        })
        .catch(() => {/* silent — keep prop ticker */});
      return () => { alive = false; };
    }, [tickerSym]);

    // Merge: full payload wins, but the prop ticker fills in anything
    // the latest endpoint dropped (rare). This preserves the kanban
    // stage / open trade overlay the parent passed in.
    const enrichedTicker = useMemo(() => {
      if (!ticker) return null;
      if (!fullPayload) return ticker;
      return {
        ...fullPayload,
        ...ticker,
        // Heavy fields the rail's Technicals / Analysis / Fundamentals
        // / Investor / History tabs all rely on — always prefer the
        // full /timed/latest copy because /timed/all strips these.
        tf_tech: fullPayload.tf_tech ?? ticker.tf_tech,
        _ticker_profile: fullPayload._ticker_profile ?? ticker._ticker_profile,
        _tickerProfile: fullPayload._tickerProfile ?? ticker._tickerProfile,
        td_sequential: fullPayload.td_sequential ?? ticker.td_sequential,
        fundamentals: fullPayload.fundamentals ?? ticker.fundamentals,
        execution_profile: fullPayload.execution_profile ?? ticker.execution_profile,
        ichimoku_map: fullPayload.ichimoku_map ?? ticker.ichimoku_map,
        ichimoku_d: fullPayload.ichimoku_d ?? ticker.ichimoku_d,
        ema_map: fullPayload.ema_map ?? ticker.ema_map,
        fuel: fullPayload.fuel ?? ticker.fuel,
        atr_levels: fullPayload.atr_levels ?? ticker.atr_levels,
        liq_4h: fullPayload.liq_4h ?? ticker.liq_4h,
        liq_D: fullPayload.liq_D ?? ticker.liq_D,
        regime: fullPayload.regime ?? ticker.regime,
        regime_class: fullPayload.regime_class ?? ticker.regime_class,
        market_internals: fullPayload.market_internals ?? ticker.market_internals,
        // Ensure ticker symbol field is preserved (some /timed/latest
        // payloads don't include a top-level `ticker` field).
        ticker: ticker.ticker || fullPayload.ticker || tickerSym,
      };
    }, [ticker, fullPayload, tickerSym]);

    useEffect(() => {
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
    if (!ticker || !enrichedTicker) return null;
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
        "aria-label": `${tickerSym || "Ticker"} detail`,
      },
        e("button", {
          className: "rail-close",
          onClick: onClose,
          "aria-label": "Close ticker detail",
          title: "Close (Esc)",
        }, "✕"),
        e(Component, {
          ticker: enrichedTicker,
          allLoadedData: allLoadedData || null,
          onClose,
        }),
      ),
    );
  }
  window.TimedRightRail.Overlay = RailOverlay;
})();
