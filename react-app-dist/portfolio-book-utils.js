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

  /**
   * Canonical book lane from mixed ledger / paper payloads.
   * Investor lots stamp `_source_mode` (not `_lane`); paper stamps `_paper_lane`.
   */
  function tradeLane(t) {
    if (!t || typeof t !== "object") return "";
    var raw = String(t._lane || t._paper_lane || "").trim();
    if (raw) return raw;
    var src = String(t._source_mode || t.mode || "").trim().toLowerCase();
    if (src === "investor") return "investor";
    if (src === "day_trade" || src === "index_day_trade" || src === "index_dt") return "index_day_trade";
    if (src === "index_swing") return "index_swing";
    if (src === "trader") return "trader";
    return "";
  }

  /**
   * Whether a trade belongs in the Trade History for `laneFilter`.
   * Day Trader is fail-closed: investor equity lots (e.g. CF) never match.
   */
  function tradeMatchesLane(t, laneFilter) {
    if (!laneFilter || laneFilter === "all") return true;
    var lane = tradeLane(t);
    if (laneFilter === "index_day_trade") {
      if (String(t && t._source_mode || "").toLowerCase() === "investor") return false;
      if (lane === "investor" || lane === "trader" || lane === "index_swing") return false;
      return lane === "index_day_trade" || lane === "day_trade" || lane === "index_dt";
    }
    if (laneFilter === "investor") return lane === "investor";
    if (laneFilter === "trader") return lane === "trader" || lane === "";
    return lane === laneFilter;
  }

  var api = {
    bookTotalPnlPct: bookTotalPnlPct,
    tradeLane: tradeLane,
    tradeMatchesLane: tradeMatchesLane,
  };
  root.TimedPortfolioBookUtils = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : window);

// cache-bust:1790401994960:571295866
