/* tt-rail-bridge.js — activity strip → right rail History handoff */
(function () {
  if (typeof window === "undefined") return;

  function parseUrlRailContext() {
    try {
      const u = new URL(window.location.href);
      const ticker = String(u.searchParams.get("ticker") || "").trim().toUpperCase();
      const initialRailTab = String(u.searchParams.get("railTab") || "").trim().toUpperCase() || null;
      const tradeId = String(u.searchParams.get("trade_id") || "").trim() || null;
      const evType = String(u.searchParams.get("ev") || "").trim().toUpperCase();
      const openAutopsy =
        u.searchParams.get("autopsy") === "1" ||
        (tradeId && (evType === "EXIT" || evType === "TRIM" || evType === "TRADE_EXIT" || evType === "TRADE_TRIM"));
      return { ticker, initialRailTab, tradeId, openAutopsy, evType };
    } catch (_) {
      return {};
    }
  }

  window.ttOpenTickerInRail = function ttOpenTickerInRail(opts) {
    const ticker = String(opts?.ticker || "").toUpperCase();
    if (!ticker) return;
    const initialRailTab = opts?.initialRailTab != null
      ? (String(opts.initialRailTab || "").trim().toUpperCase() || null)
      : (opts?.tradeId || opts?.trade_id ? "HISTORY" : null);
    const tradeId = opts?.tradeId || opts?.trade_id || null;
    const evType = String(opts?.evType || opts?.type || "").toUpperCase();
    const openAutopsy =
      opts?.openAutopsy === true ||
      evType === "EXIT" ||
      evType === "TRIM" ||
      evType === "TRADE_EXIT" ||
      evType === "TRADE_TRIM";

    try {
      const u = new URL(window.location.href);
      u.searchParams.set("ticker", ticker);
      if (initialRailTab) u.searchParams.set("railTab", initialRailTab);
      else u.searchParams.delete("railTab");
      if (tradeId) u.searchParams.set("trade_id", tradeId);
      else u.searchParams.delete("trade_id");
      if (openAutopsy) u.searchParams.set("autopsy", "1");
      else u.searchParams.delete("autopsy");
      if (evType) u.searchParams.set("ev", evType);
      else u.searchParams.delete("ev");
      window.history.replaceState({ ttTicker: ticker }, "", u.toString());
    } catch (_) {}

    window.dispatchEvent(
      new CustomEvent("tt-open-ticker", {
        detail: {
          ticker,
          initialRailTab,
          tradeId,
          openAutopsy,
          activityEvent: opts?.activityEvent || null,
          source: opts?.source || "rail-bridge",
          handled: true,
        },
        bubbles: true,
      }),
    );
    try {
      if (typeof window.ttGlobalSearchMarkHandled === "function") {
        window.ttGlobalSearchMarkHandled(ticker);
      }
    } catch (_) {}
  };

  window.ttParseRailOpenDetail = function ttParseRailOpenDetail(evOrDetail) {
    const d = evOrDetail?.detail || evOrDetail || {};
    const url = parseUrlRailContext();
    const ticker = String(d.ticker || url.ticker || "").toUpperCase();
    const initialRailTab = d.initialRailTab || url.initialRailTab || null;
    const tradeId = d.tradeId || d.trade_id || url.tradeId || null;
    const openAutopsy = d.openAutopsy === true || url.openAutopsy === true;
    return { ticker, initialRailTab, tradeId, openAutopsy, activityEvent: d.activityEvent || null };
  };

  window.ttClearRailUrlParams = function ttClearRailUrlParams() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete("railTab");
      u.searchParams.delete("trade_id");
      u.searchParams.delete("autopsy");
      u.searchParams.delete("ev");
      const t = String(u.searchParams.get("ticker") || "").trim();
      if (!t) u.searchParams.delete("ticker");
      window.history.replaceState({}, "", u.toString());
    } catch (_) {}
  };

  window.ttBuildAutopsyStubFromActivity = function ttBuildAutopsyStubFromActivity(ev, ticker) {
    const sym = String(ticker || ev?.ticker || "").toUpperCase();
    if (!sym) return null;
    const type = String(ev?.type || "").toUpperCase();
    return {
      ticker: sym,
      trade_id: ev?.trade_id || ev?.tradeId || null,
      direction: ev?.direction || null,
      entry_price: type === "ENTRY" || type === "ADD_ENTRY" || type === "TRADE_ENTRY" ? Number(ev?.price) : undefined,
      exit_price: type === "EXIT" || type === "TRADE_EXIT" ? Number(ev?.price) : undefined,
      trim_price: type === "TRIM" || type === "TRADE_TRIM" ? Number(ev?.price) : undefined,
      pnl: Number(ev?.pnl) || 0,
      pnl_pct: Number(ev?.pnl_pct ?? ev?.pnlPct) || 0,
      reason: ev?.reason || null,
      setup_grade: ev?.setup_grade || null,
      setup_name: ev?.setup_name || null,
    };
  };

  window.ttConsumeRailOpenForReact = function ttConsumeRailOpenForReact(evDetail) {
    const p = window.ttParseRailOpenDetail({ detail: evDetail });
    if (!p.ticker) return null;
    const initialRailTab = p.initialRailTab || (p.tradeId ? "HISTORY" : null);
    let openAutopsyForTrade = null;
    if (p.openAutopsy && p.tradeId) {
      openAutopsyForTrade =
        window.ttBuildAutopsyStubFromActivity(
          p.activityEvent || { trade_id: p.tradeId, ticker: p.ticker },
          p.ticker,
        ) || { ticker: p.ticker, trade_id: p.tradeId };
    }
    return {
      ticker: p.ticker,
      initialRailTab,
      highlightTradeId: p.tradeId,
      openAutopsyForTrade,
    };
  };
})();

// cache-bust:1781968146769:895116687
