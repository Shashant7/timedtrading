(function () {
  "use strict";

  function buildSignal(opts) {
    opts = opts || {};
    var engine = String(opts.engine || "trader").toLowerCase() === "investor" ? "investor" : "trader";
    var execStateRaw = String(opts.execState || opts.exec_state || "watching").toLowerCase();
    var execState = execStateRaw === "done" || execStateRaw === "recommended" ? execStateRaw : "watching";
    var mode = String(opts.mode || "").toLowerCase();
    if (mode !== "watching" && mode !== "doing") {
      mode = execState === "recommended" || execState === "done" || opts.actionTaken ? "doing" : "watching";
    }
    if (execState === "recommended" || execState === "done") mode = "doing";
    return {
      engine: engine,
      mode: mode,
      execState: execState,
      action: String(opts.action || "hold").toLowerCase(),
      ticker: String(opts.ticker || "").toUpperCase(),
      direction: opts.direction ? String(opts.direction).toUpperCase() : null,
    };
  }

  var TRADER_LANE_META = {
    setup: { band: "watching", label: "Watchlist", action: "WATCH" },
    setup_watch: { band: "watching", label: "Watchlist", action: "WATCH" },
    flip_watch: { band: "watching", label: "Watchlist", action: "WATCH" },
    in_review: { band: "watching", label: "Trigger Ready", action: "REVIEW" },
    enter: { band: "watching", label: "Trigger Ready", action: "REVIEW" },
    enter_now: { band: "doing", label: "Trigger Ready", action: "ENTER" },
    just_flipped: { band: "watching", label: "Trigger Ready", action: "REVIEW" },
    just_entered: { band: "doing", label: "Just Entered", action: "HOLD" },
    hold: { band: "doing", label: "Holding", action: "HOLD" },
    active: { band: "doing", label: "Holding", action: "HOLD" },
    defend: { band: "doing", label: "Defending", action: "DEFEND" },
    trim: { band: "doing", label: "Trimming", action: "TRIM" },
    exiting: { band: "doing", label: "Exiting", action: "EXIT" },
    exit: { band: "doing", label: "Closed", action: "DONE" },
  };

  var INVESTOR_LANE_META = {
    research_on_watch: { band: "watching", label: "On Radar", action: "WAIT" },
    research_low: { band: "watching", label: "Low Conviction", action: "WAIT" },
    research_avoid: { band: "watching", label: "Avoid", action: "SKIP" },
    accumulate: { band: "doing", label: "Accumulating", action: "BUY" },
    accumulate_queued: { band: "doing", label: "Queued", action: "NEXT REBAL" },
    accumulate_entered: { band: "doing", label: "Entered", action: "HELD" },
    core_hold: { band: "doing", label: "Core Hold", action: "HOLD" },
    watch: { band: "doing", label: "Hold & Watch", action: "HOLD" },
    reduce: { band: "doing", label: "Reducing", action: "TRIM" },
  };

  function traderLaneMeta(stage) {
    var key = String(stage || "").toLowerCase();
    return TRADER_LANE_META[key] || { band: "watching", label: key || "—", action: "—" };
  }

  function investorLaneMeta(stage) {
    var key = String(stage || "").toLowerCase();
    return INVESTOR_LANE_META[key] || { band: "watching", label: key || "—", action: "—" };
  }

  function classifyActivityEvent(ev) {
    var t = String(ev && (ev.type || ev.event) || "").toUpperCase();
    var modeRaw = String(ev && (ev.mode || ev.alert_class) || "").toLowerCase();
    var engine = String(ev && ev.engine || "").toLowerCase() === "investor"
      || t === "INVESTOR_SIGNAL"
      || (ev && ev.investor_alert_type)
      ? "investor" : "trader";
    if (t === "TRADE_EXIT_SIGNAL") {
      return { engine: engine, mode: "doing", execState: "recommended", label: "EXIT", scope: engine, cls: "ev-exit ev-recommended ev-doing" };
    }
    var doingTypes = ["TRADE_ENTRY", "TRADE_TRIM", "TRADE_EXIT", "ENTRY", "ENTER", "ADD", "ADD_ENTRY", "TRIM", "TP_HIT_TRIM", "EXIT", "TP_HIT_EXIT", "SL_HIT"];
    var isDoing = doingTypes.indexOf(t) >= 0 || modeRaw === "doing" || modeRaw === "done";
    var action = "hold";
    var label = "UPDATE";
    var cls = "";
    var invExecDone = false;
    if (t === "INVESTOR_SIGNAL") {
      var invT = String(ev && ev.investor_alert_type || "").toLowerCase();
      if (invT === "position_add") { action = "add"; label = "ADD"; cls = "ev-entry ev-doing"; invExecDone = true; }
      else if (invT === "position_trim") { action = "trim"; label = "TRIM"; cls = "ev-trim ev-doing"; invExecDone = true; }
      else if (invT === "position_close") { action = "exit"; label = "EXIT"; cls = "ev-exit ev-doing"; invExecDone = true; }
      else { action = "accumulate"; label = "WATCH"; cls = "ev-watching"; }
    } else if (t.indexOf("TRIM") >= 0 || t === "TP_HIT_TRIM") { label = "TRIM"; cls = "ev-trim"; }
    else if (t.indexOf("EXIT") >= 0 || t === "SL_HIT") { label = "EXIT"; cls = "ev-exit"; }
    else if (t.indexOf("ENTRY") >= 0 || t === "ENTER" || t === "ADD") { label = t.indexOf("ADD") >= 0 || t === "ADD" ? "ADD" : "ENTER"; cls = "ev-entry"; }
    var mode = invExecDone || isDoing ? "doing" : "watching";
    return {
      engine: engine,
      mode: mode,
      execState: invExecDone || isDoing ? "done" : "watching",
      label: label,
      scope: engine,
      cls: cls || (mode === "doing" ? "ev-doing" : "ev-watching"),
    };
  }

  function renderSignalChips(signal) {
    var s = signal && signal.engine ? signal : buildSignal(signal || {});
    var chips = [];
    chips.push({ kind: "engine", text: s.engine === "investor" ? "INVESTOR" : "TRADER" });
    chips.push({ kind: "mode", text: s.mode === "doing" ? "DOING" : "WATCHING" });
    if (s.execState === "recommended") chips.push({ kind: "exec", text: "RECOMMENDED" });
    else if (s.execState === "done" && s.mode === "doing") chips.push({ kind: "exec", text: "DONE" });
    return chips;
  }

  window.TimedSignalGrammar = {
    buildSignal: buildSignal,
    traderLaneMeta: traderLaneMeta,
    investorLaneMeta: investorLaneMeta,
    classifyActivityEvent: classifyActivityEvent,
    renderSignalChips: renderSignalChips,
    TRADER_LANE_META: TRADER_LANE_META,
    INVESTOR_LANE_META: INVESTOR_LANE_META,
  };
})();

// cache-bust:1782235608792:943770061
