/**
 * Shared Investor nav-badge counter — loaded on every journey page before
 * tt-nav-extras.js so top + bottom nav badges match the Investor kanban.
 */
(function () {
  "use strict";

  var ACTION_TIER_META = {
    act_now: 1,
    ready: 1,
    monitor: 1,
    stale: 1,
  };

  function deriveActionTier(t) {
    // Nav badge always recomputes — stored actionTier can lag read-time
    // revalidation (stage moved but tier field not refreshed yet).
    var stage = String((t && t.stage) || "");
    if (stage !== "accumulate" && stage !== "reduce") return null;
    var owned = !!(t && t.position && t.position.owned);
    var simEligible = t && t.simEligible === true;
    var inZone = !!(t && t.accumZone && t.accumZone.inZone);
    var score = Number((t && t.score) || 0) || 0;
    var lastTs = Number((t && t.position && t.position.last_action_ts) || 0) || 0;
    var lastType = String((t && t.position && t.position.last_action_type) || "");
    var agoMs = lastTs > 0 ? Date.now() - lastTs : 0;
    var stale =
      owned &&
      lastTs > 0 &&
      agoMs > 7 * 86400000 &&
      ((stage === "reduce" && lastType !== "SELL") ||
        (stage === "accumulate" && ["BUY", "DCA_BUY"].indexOf(lastType) < 0));
    if (stale) return "stale";
    if (stage === "accumulate") {
      if (inZone && simEligible) return "act_now";
      if (simEligible || (inZone && score >= 65)) return "ready";
      return "monitor";
    }
    if (simEligible) return "act_now";
    if (owned) return "ready";
    return "monitor";
  }

  function isExecuteReady(t) {
    var tier = deriveActionTier(t);
    return tier === "act_now" || tier === "ready";
  }

  function countInvestorNavBadge(list) {
    var n = 0;
    var rows = Array.isArray(list) ? list : [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (!t || typeof t !== "object") continue;
      var stage = String(t.stage || t.investor_stage || "").toLowerCase();
      if (stage === "exited") continue;
      // Owned holdings count (mirrors the Trader tab badge = open-trade count)
      // so entering a position lights the Investor tab. Each ticker counts
      // once; unowned rows still count when actionable (reduce / buy-ready).
      if (t.position && t.position.owned) {
        n++;
        continue;
      }
      if (stage === "reduce") {
        n++;
        continue;
      }
      if (stage === "accumulate" && isExecuteReady(t)) n++;
    }
    return n;
  }

  window.TTInvestorLane = window.TTInvestorLane || {};
  window.TTInvestorLane.deriveActionTier = deriveActionTier;
  window.TTInvestorLane.isExecuteReady = isExecuteReady;
  window.TTInvestorLane.countInvestorNavBadge = countInvestorNavBadge;
  window.TTCountInvestorNavBadge = countInvestorNavBadge;
})();

// cache-bust:1784436133998:983207139
