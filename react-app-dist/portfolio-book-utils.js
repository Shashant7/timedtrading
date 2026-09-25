/**
 * Portfolio book-tab helpers (Short Term / Long Term / Day Trader).
 * Classic script — attaches TimedPortfolioBookUtils on window.
 * Also exports via module.exports for vitest.
 */
(function (root) {
  "use strict";

  /** Total book return %: (realized + live open) / sleeve start when both known. */
  function bookTotalPnlPct(payload, openPl, startCashDefault) {
    if (!Number.isFinite(startCashDefault) || startCashDefault <= 0) startCashDefault = 100000;
    var sm = (payload && payload.summary) || {};
    var startCash = Number(sm.startCash) || startCashDefault;
    var realized = Number(sm.cumRealized);
    if (Number.isFinite(realized) && Number.isFinite(openPl) && startCash > 0) {
      return ((realized + openPl) / startCash) * 100;
    }
    var ret = Number(sm.totalReturnPct);
    return Number.isFinite(ret) ? ret : null;
  }

  var api = { bookTotalPnlPct: bookTotalPnlPct };
  root.TimedPortfolioBookUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

// cache-bust:1790376770157:481949923
