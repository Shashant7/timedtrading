/**
 * Shared Bubble Map search helpers — Today + Investor pages.
 * Comma-delimited multi-ticker lists and substring prefix search.
 */
(function () {
  "use strict";

  function normTicker(sym) {
    return String(sym || "").trim().toUpperCase();
  }

  function parseTickerSearchQuery(query) {
    const raw = String(query || "").trim();
    if (!raw) return { type: "none" };
    if (
      raw.includes(",") &&
      !raw.match(
        /rank|rr|risk|reward|phase|completion|moved|points|prime|squeeze|corridor|momentum|top|long|short|setup|above|over|below|under/i,
      )
    ) {
      return {
        type: "multi-ticker",
        tickers: raw.split(",").map((t) => normTicker(t)).filter(Boolean),
      };
    }
    return { type: "substring", q: raw.toUpperCase() };
  }

  function hasExplicitTickerSearch(query) {
    const search = parseTickerSearchQuery(query);
    return search.type === "multi-ticker" || search.type === "substring";
  }

  function matchesTickerSearchQuery(sym, query) {
    const search = parseTickerSearchQuery(query);
    const S = normTicker(sym);
    if (search.type === "multi-ticker") return search.tickers.includes(S);
    if (search.type === "substring") return S.includes(search.q);
    return true;
  }

  function hasBubbleMapScores(t) {
    return Number.isFinite(Number(t?.ltf_score)) && Number.isFinite(Number(t?.htf_score));
  }

  window.TTBubbleSearchUtils = {
    normTicker,
    parseTickerSearchQuery,
    hasExplicitTickerSearch,
    matchesTickerSearchQuery,
    hasBubbleMapScores,
  };
})();

// cache-bust:1782311564530:200252478
