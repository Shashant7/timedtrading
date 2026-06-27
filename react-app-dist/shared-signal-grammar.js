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

  function investorEvType(ev) {
    const invT = String(ev && ev.investor_alert_type || "").toLowerCase();
    if (invT === "position_open") return "BOUGHT";
    if (invT === "position_add") return "ADD";
    if (invT === "position_trim") return "TRIM";
    if (invT === "position_close") return "EXIT";
    return null;
  }

  var INVESTOR_PASSIVE_ALERT_VERBS = ["MODEL · ON RADAR", "MODEL · WATCH", "MODEL · INFO"];
  var INVESTOR_ACTIONABLE_ALERT_VERBS = [
    "MODEL · QUEUE", "MODEL · BOUGHT", "MODEL · REDUCE", "MODEL · TRIMMED", "MODEL · EXITED",
    "MODEL · REVIEW", "MODEL · ADD", "ACCUMULATE", "QUEUE", "ADD ON PULLBACK",
    "REDUCE / EXIT", "TRIM / REDUCE", "REVIEW PORTFOLIO",
  ];
  var TRADER_EXEC_FEED_TYPES = [
    "TRADE_ENTRY", "TRADE_TRIM", "TRADE_EXIT", "ENTRY", "ENTER", "ADD", "ADD_ENTRY",
    "TRIM", "TP_HIT_TRIM", "EXIT", "TP_HIT_EXIT", "SL_HIT",
  ];
  var INVESTOR_EXEC_ALERT_TYPES = ["position_open", "position_add", "position_trim", "position_close"];
  var ACTIONABLE_KANBAN_STAGES = [
    "in_review", "enter", "enter_now", "just_flipped", "just_entered",
    "hold", "active", "defend", "trim", "exiting", "exit",
  ];

  function normalizeInvestorVerb(raw) {
    var v = String(raw || "").trim();
    if (!v) return "";
    if (v.indexOf("MODEL ·") === 0) return v;
    var upper = v.toUpperCase();
    if (upper.indexOf("ACCUMULATE") === 0) return "MODEL · QUEUE";
    if (upper.indexOf("QUEUE") === 0) return "MODEL · QUEUE";
    if (upper.indexOf("BOUGHT") === 0) return "MODEL · BOUGHT";
    if (upper.indexOf("REDUCE") === 0) return "MODEL · REDUCE";
    if (upper.indexOf("ADD") === 0) return "MODEL · ADD";
    if (upper.indexOf("TRIM") >= 0) return "MODEL · TRIMMED";
    if (upper.indexOf("EXIT") >= 0) return "MODEL · EXITED";
    if (upper.indexOf("REVIEW") >= 0) return "MODEL · REVIEW";
    return v;
  }

  function classifyActivityEvent(ev) {
    var invT = String(ev && ev.investor_alert_type || "").toLowerCase();
    if (invT === "position_open") {
      return { engine: "investor", mode: "doing", execState: "done", label: "BOUGHT", evType: "ENTRY", scope: "investor", cls: "ev-entry ev-doing" };
    }
    if (invT === "position_add") {
      return { engine: "investor", mode: "doing", execState: "done", label: "ADD", evType: "ADD", scope: "investor", cls: "ev-entry ev-doing" };
    }
    if (invT === "position_trim") {
      return { engine: "investor", mode: "doing", execState: "done", label: "TRIM", evType: "TRIM", scope: "investor", cls: "ev-trim ev-doing" };
    }
    if (invT === "position_close") {
      return { engine: "investor", mode: "doing", execState: "done", label: "EXIT", evType: "EXIT", scope: "investor", cls: "ev-exit ev-doing" };
    }
    var t = String(ev && (ev.type || ev.event) || "").toUpperCase();
    var modeRaw = String(ev && (ev.mode || ev.alert_class) || "").toLowerCase();
    var engine = String(ev && ev.engine || "").toLowerCase() === "investor"
      || modeRaw === "investor"
      || t === "INVESTOR_SIGNAL"
      || (ev && ev.investor_alert_type)
      ? "investor" : "trader";
    if (t === "TRADE_EXIT_SIGNAL") {
      return { engine: engine, mode: "doing", execState: "recommended", label: "EXIT", evType: "EXIT", scope: engine, cls: "ev-exit ev-recommended ev-doing" };
    }
    var doingTypes = ["TRADE_ENTRY", "TRADE_TRIM", "TRADE_EXIT", "ENTRY", "ENTER", "ADD", "ADD_ENTRY", "TRIM", "TP_HIT_TRIM", "EXIT", "TP_HIT_EXIT", "SL_HIT"];
    var isDoing = doingTypes.indexOf(t) >= 0 || modeRaw === "doing" || modeRaw === "done";
    var action = "hold";
    var label = "UPDATE";
    var evType = t || "EVENT";
    var cls = "";
    var invExecDone = false;
    if (t === "INVESTOR_SIGNAL") {
      var invT2 = String(ev && ev.investor_alert_type || "").toLowerCase();
      if (invT2 === "position_open") { action = "open"; label = "BOUGHT"; evType = "ENTRY"; cls = "ev-entry ev-doing"; invExecDone = true; }
      else if (invT2 === "position_add") { action = "add"; label = "ADD"; evType = "ADD"; cls = "ev-entry ev-doing"; invExecDone = true; }
      else if (invT2 === "position_trim") { action = "trim"; label = "TRIM"; evType = "TRIM"; cls = "ev-trim ev-doing"; invExecDone = true; }
      else if (invT2 === "position_close") { action = "exit"; label = "EXIT"; evType = "EXIT"; cls = "ev-exit ev-doing"; invExecDone = true; }
      else {
        var verb = normalizeInvestorVerb(ev && ev.action);
        if (verb === "MODEL · QUEUE" || verb === "MODEL · ACCUMULATE") {
          action = "queue"; label = "QUEUE"; evType = "INVESTOR_SIGNAL"; cls = "ev-recommended ev-doing";
          isDoing = true;
        } else if (verb === "MODEL · REDUCE") {
          action = "reduce"; label = "REDUCE"; evType = "INVESTOR_SIGNAL"; cls = "ev-trim ev-recommended ev-doing";
          isDoing = true;
        } else if (verb === "MODEL · REVIEW") {
          action = "review"; label = "REVIEW"; evType = "INVESTOR_SIGNAL"; cls = "ev-recommended ev-doing";
          isDoing = true;
        } else {
          action = "accumulate"; label = "WATCH"; evType = "INVESTOR_SIGNAL"; cls = "ev-watching";
        }
      }
    } else if (t.indexOf("TRIM") >= 0 || t === "TP_HIT_TRIM") { label = "TRIM"; evType = "TRIM"; cls = "ev-trim"; }
    else if (t.indexOf("EXIT") >= 0 || t === "SL_HIT") { label = "EXIT"; evType = "EXIT"; cls = "ev-exit"; }
    else if (t.indexOf("ENTRY") >= 0 || t === "ENTER" || t === "ADD") { label = t.indexOf("ADD") >= 0 || t === "ADD" ? "ADD" : "ENTER"; evType = label; cls = "ev-entry"; }
    var mode = invExecDone || isDoing ? "doing" : "watching";
    var execStateOut = invExecDone || isDoing ? "done" : "watching";
    if (t === "INVESTOR_SIGNAL" && (label === "QUEUE" || label === "ACCUM" || label === "REDUCE" || label === "REVIEW")) {
      execStateOut = "recommended";
    }
    return {
      engine: engine,
      mode: mode,
      execState: execStateOut,
      label: label,
      evType: evType,
      scope: engine,
      cls: cls || (mode === "doing" ? "ev-doing" : "ev-watching"),
    };
  }

  function investorVerbFromNotification(n) {
    var title = String(n && n.title || "");
    var m = title.match(/^(?:INVESTOR|MODEL)\s*·\s*([^:]+)/i);
    if (m) return normalizeInvestorVerb("MODEL · " + m[1].trim());
    return normalizeInvestorVerb(title);
  }

  function kanbanStageFromNotification(n) {
    var body = String(n && n.body || "").toLowerCase();
    var m = body.match(/moved to ([a-z_]+)/i);
    if (m) return String(m[1]).toLowerCase();
    var title = String(n && n.title || "").toLowerCase();
    if (title.indexOf("under review") >= 0) return "in_review";
    if (title.indexOf("position initiated") >= 0) return "just_entered";
    if (title.indexOf("holding") >= 0) return "hold";
    if (title.indexOf("defending") >= 0) return "defend";
    if (title.indexOf("exit signal") >= 0) return "exit";
    if (title.indexOf("setup") >= 0) return "setup";
    return "";
  }

  function verbInSet(verb, list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === verb) return true;
    }
    return false;
  }

  function stageActionable(stage) {
    for (var i = 0; i < ACTIONABLE_KANBAN_STAGES.length; i++) {
      if (ACTIONABLE_KANBAN_STAGES[i] === stage) return true;
    }
    return false;
  }

  function isActionableFeedEvent(ev, meta) {
    if (!ev) return false;
    var sym = String(ev.ticker || ev.symbol || "").toUpperCase();
    if (!sym || sym === "UNDEFINED" || sym === "NULL") return false;
    var t = String(ev.type || ev.event || "").toUpperCase();
    if (t === "SIGNAL_GRADED") return false;
    if (t === "TRADE_EXIT_SIGNAL") return true;
    if (TRADER_EXEC_FEED_TYPES.indexOf(t) >= 0) return true;
    var invType = String(ev.investor_alert_type || "").toLowerCase();
    if (INVESTOR_EXEC_ALERT_TYPES.indexOf(invType) >= 0) return true;
    if (t === "INVESTOR_SIGNAL") {
      var verb = normalizeInvestorVerb(ev.action);
      if (verbInSet(verb, INVESTOR_PASSIVE_ALERT_VERBS)) return false;
      if (verbInSet(verb, INVESTOR_ACTIONABLE_ALERT_VERBS)) return true;
      if (invType === "thesis_invalidation") return true;
      if (meta) {
        if (meta.execState === "recommended") return true;
        if (meta.mode === "doing" && meta.execState === "done") return true;
        if (meta.label === "WATCH" || meta.label === "UPDATE") return false;
      }
      return false;
    }
    return false;
  }

  function isActionableNotification(n) {
    if (!n) return false;
    var t = String(n.type || "").toLowerCase();
    if (t === "trade_entry" || t === "trade_exit" || t === "trade_trim") return true;
    if (t === "investor_signal") {
      var verb = investorVerbFromNotification(n);
      if (verbInSet(verb, INVESTOR_PASSIVE_ALERT_VERBS)) return false;
      if (verbInSet(verb, INVESTOR_ACTIONABLE_ALERT_VERBS)) return true;
      var exec = String(n.exec_state || "").toLowerCase();
      var cls = String(n.alert_class || n.mode || "").toLowerCase();
      if (exec === "recommended" || exec === "done" || cls === "doing") return true;
      return false;
    }
    if (t === "kanban") {
      var stage = kanbanStageFromNotification(n);
      if (stage && !stageActionable(stage)) return false;
      var title = String(n.title || "").toUpperCase();
      if (title.indexOf("SETUP:") === 0) return false;
      return true;
    }
    return false;
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
    investorEvType: investorEvType,
    isActionableFeedEvent: isActionableFeedEvent,
    isActionableNotification: isActionableNotification,
    renderSignalChips: renderSignalChips,
    TRADER_LANE_META: TRADER_LANE_META,
    INVESTOR_LANE_META: INVESTOR_LANE_META,
  };
})();

// cache-bust:1782599489693:283363238
