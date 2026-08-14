/**
 * Shared Model-board lane counting helpers.
 * Keeps nav badge, ATBrief narrative, and Kanban lane tabs on one contract.
 *
 * Queuing Up = near-entry only:
 *   Short Term: setup / enter stages (caller supplies those arrays)
 *   Long Term: accumulate / accumulate_queued
 * On-radar Long Term (`research_on_watch`) stays off this board — it is
 * tracking noise, not a queued entry.
 */
(function (root) {
  "use strict";

  var LT_QUEUE_STAGES = {
    accumulate: 1,
    accumulate_queued: 1,
  };

  function isLongTermQueueStage(stage) {
    return !!LT_QUEUE_STAGES[String(stage || "").toLowerCase()];
  }

  /** Open management cards on the unified Model board. */
  function countModelOpenCards(modelLanes) {
    var m = modelLanes || {};
    return (m.bought?.length || 0) + (m.defend?.length || 0) + (m.trim?.length || 0);
  }

  function countModelLaneCards(modelLanes) {
    var m = modelLanes || {};
    return {
      queue: m.queue?.length || 0,
      bought: m.bought?.length || 0,
      defend: m.defend?.length || 0,
      trim: m.trim?.length || 0,
      exit: m.exit?.length || 0,
      open: countModelOpenCards(m),
    };
  }

  /**
   * Investor rows that count toward the Model nav badge — owned positions
   * only (mirrors Bought / Defending / Trimming long-term cards). Unowned
   * accumulate-ready names belong in Queuing Up, not the badge.
   */
  function countInvestorOwnedForModelBadge(list) {
    var n = 0;
    var rows = Array.isArray(list) ? list : [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (!t || typeof t !== "object") continue;
      var stage = String(t.stage || t.investor_stage || "").toLowerCase();
      if (stage === "exited") continue;
      if (t.position && t.position.owned) n += 1;
    }
    return n;
  }

  function buildModelBriefNarrative(counts, opts) {
    var c = counts || {};
    var parts = [];
    var open = Number(c.open) || 0;
    if (open === 0) {
      parts.push("No open trades right now — the model is in scouting mode.");
    } else {
      var verbs = [];
      if ((c.bought || 0) > 0) verbs.push("holding " + c.bought);
      if ((c.defend || 0) > 0) verbs.push("defending " + c.defend);
      if ((c.trim || 0) > 0) verbs.push("trimming " + c.trim);
      parts.push("The model is " + verbs.join(", ") + ".");
    }
    if (opts && opts.avgPlSentence) parts.push(opts.avgPlSentence);
    if ((c.queue || 0) > 0) {
      parts.push(
        c.queue +
          " queuing up — waiting for an entry trigger.",
      );
    }
    if ((c.exit || 0) > 0) {
      parts.push(
        c.exit +
          " recently exited (last 24h) — review what worked.",
      );
    }
    return parts.join(" ");
  }

  var api = {
    isLongTermQueueStage: isLongTermQueueStage,
    countModelOpenCards: countModelOpenCards,
    countModelLaneCards: countModelLaneCards,
    countInvestorOwnedForModelBadge: countInvestorOwnedForModelBadge,
    buildModelBriefNarrative: buildModelBriefNarrative,
    LT_QUEUE_STAGES: LT_QUEUE_STAGES,
  };

  root.TTModelLaneCounts = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);

// cache-bust:1786745177723:80378833
