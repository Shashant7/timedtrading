// shared-verdict-ui.js — Phase D Objective 3 answer-first UI (one contract:
// GET /timed/verdict). Shared by right rail, Today, kanban cards, portfolio.
(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var API_BASE = window.TT_API_BASE || "";
  var LIFECYCLE_STEPS = ["FORMING", "READY", "TRIGGERED", "MANAGED", "CLOSED"];

  var VERDICT_META = {
    BUY: { label: "BUY", cls: "tt-vb--buy" },
    SETUP_FORMING: { label: "SETUP FORMING", short: "FORMING", cls: "tt-vb--forming" },
    HOLD: { label: "HOLD", cls: "tt-vb--hold" },
    TIGHTEN: { label: "TIGHTEN", cls: "tt-vb--tighten" },
    SELL: { label: "SELL", cls: "tt-vb--sell" },
    WAIT: { label: "WAIT", cls: "tt-vb--wait" },
  };

  function verdictMeta(v) {
    var key = String(v || "WAIT").toUpperCase();
    return VERDICT_META[key] || VERDICT_META.WAIT;
  }

  function verdictLabel(v, short) {
    var m = verdictMeta(v);
    return short && m.short ? m.short : m.label;
  }

  function fmtPx(n) {
    var x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return "$" + x.toFixed(2);
  }

  function fmtPct(n) {
    var x = Number(n);
    if (!Number.isFinite(x)) return "—";
    return (x >= 0 ? "+" : "") + x.toFixed(1) + "%";
  }

  function fmtTiming(t) {
    if (!t) return null;
    return "Timing: " + String(t);
  }

  /** Map kanban / zone stage → lifecycle step (display-only, D3). */
  function lifecycleFromStage(stage, hasPosition) {
    var s = String(stage || "").toLowerCase();
    if (s === "exit" || s === "exiting" || s === "exited") return "CLOSED";
    if (hasPosition || s === "just_entered" || s === "hold" || s === "active" || s === "defend" || s === "trim") return "MANAGED";
    if (s === "enter_now" || s === "just_flipped") return "TRIGGERED";
    if (s === "enter" || s === "in_review") return "READY";
    return "FORMING";
  }

  function lifecycleIndex(step) {
    var i = LIFECYCLE_STEPS.indexOf(step);
    return i >= 0 ? i : 0;
  }

  /** Lightweight client mirror of buildTraderVerdict for card surfaces (no fetch). */
  function inferTraderVerdictFromTicker(t, openTrade) {
    if (!t || typeof t !== "object") return null;
    var stage = String(t.kanban_stage || "").toLowerCase();
    var journey = t._journey && t._journey.features;
    var hasPosition = !!openTrade;
    var why = [];
    var verdict, timing = null;
    if (hasPosition) {
      var journeyBad = journey && journey.direction === "deteriorating";
      if (stage === "exit" || stage === "exit_now") {
        verdict = "SELL"; timing = "now"; why.push("exit lane");
      } else if (stage === "defend" || stage === "trim" || journeyBad) {
        verdict = "TIGHTEN"; timing = "now";
        if (stage === "defend" || stage === "trim") why.push(stage + " lane");
        if (journeyBad) why.push("journey deteriorating");
      } else {
        verdict = "HOLD"; why.push("plan intact");
      }
    } else if (stage === "enter" || stage === "enter_now") {
      verdict = "BUY"; timing = "now"; why.push("entry lane");
    } else if ((stage === "watch" || stage === "in_review" || stage === "setup" || stage === "setup_watch") && journey && journey.direction === "improving") {
      verdict = "SETUP_FORMING"; timing = "on confirmation"; why.push("journey improving");
    } else {
      verdict = "WAIT"; why.push("no setup");
    }
    return { lane: "trader", verdict: verdict, timing: timing, why: why.join("; ") };
  }

  /** Lightweight client mirror of buildInvestorVerdict for card surfaces. */
  function inferInvestorVerdictFromTicker(t) {
    if (!t || typeof t !== "object") return null;
    var stage = String(t.investor_stage || t.investorStage || "").toLowerCase();
    if (!stage) return null;
    var journey = t._journey && t._journey.features;
    var score = Number(t.investor_score);
    var why = [];
    var verdict, timing = null;
    if (stage === "accumulate") {
      verdict = "BUY"; timing = "scale in";
      why.push("accumulate zone" + (Number.isFinite(score) ? ", score " + score : ""));
    } else if (stage === "watch" && journey && journey.direction === "improving") {
      verdict = "SETUP_FORMING"; timing = "on zone entry";
      why.push("watch zone with improving journey");
    } else if (stage === "exit" || stage === "reduce") {
      verdict = "SELL"; timing = "now"; why.push("investor stage " + stage);
    } else {
      verdict = "WAIT"; why.push("zone " + stage + " — wait for accumulate");
    }
    return { lane: "investor", verdict: verdict, timing: timing, why: why.join("; ") };
  }

  /** Client mirror of worker/buildVerdictGuide — keeps rail guide fresh before worker deploy. */
  function buildVerdictGuide(trader, investor, payload) {
    if (!trader && !investor) return null;
    payload = payload || {};
    var tv = String((trader && trader.verdict) || "WAIT").toUpperCase();
    var iv = investor ? String(investor.verdict || "WAIT").toUpperCase() : "WAIT";
    var state = String(payload.state || "");
    var bearish = state.indexOf("BEAR") >= 0;
    var journey = payload._journey && payload._journey.features;
    var timing = payload.timing_overlay;
    var macroRiskOff = timing && (timing.posture === "RISK_OFF"
      || (Array.isArray(timing.warnings) && timing.warnings.some(function (w) { return String(w).indexOf("macro_risk_off") >= 0; })));
    var parts = [];
    var headline = "Lane guide";
    var modelNotEntered = null;
    var earlyEntry = null;
    var diverge = (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING"))
      || (tv === "BUY" && iv === "WAIT")
      || (bearish && iv === "BUY" && tv !== "BUY");

    if (iv === "BUY" && tv === "WAIT") {
      headline = "Horizons diverge — accumulate vs no trader entry";
      parts.push(bearish
        ? "Short-term trader read is bearish or choppy; the tactical entry trigger has not fired."
        : "Trader lane has no entry signal yet — the stage must reach enter before the model opens a position.");
      parts.push("Investor lane flags an accumulate zone; the longer thesis may still be intact.");
      if (macroRiskOff) parts.push("Broader market drawdown / risk-off timing is weighing on the short-term read.");
      modelNotEntered = (trader && trader.why) || "The model has not opened a trader position.";
      earlyEntry = "Scaling in before the model's scale-in call is appropriate only inside the published buy zone, with capped size and a defined invalidation level.";
    } else if (tv === "BUY" && iv === "WAIT") {
      headline = "Trader entry active — investor lane not yet accumulate";
      parts.push("Tactical entry conditions are met on the trader lane.");
      parts.push("Investor lane is not in accumulate yet — shorter-term trade and longer-term build run on different clocks.");
      if (investor && investor.why) modelNotEntered = investor.why;
    } else if (tv === "BUY" && iv === "BUY") {
      headline = "Both lanes align";
      parts.push("Trader entry and investor accumulate agree. Size each lane by its horizon rules.");
    } else if (tv === "SETUP_FORMING") {
      headline = "Setup building — confirmation pending";
      parts.push("Trader setup is forming; the entry trigger has not fired yet.");
      if (iv === "BUY") {
        parts.push("Investor accumulate may still be valid on a separate, longer clock.");
        earlyEntry = "Do not confuse a forming trader setup with investor scale-in — each lane has its own invalidation.";
      }
      modelNotEntered = trader && trader.why;
    } else if (tv === "WAIT" && iv === "WAIT") {
      headline = "No lane action yet";
      parts.push("Neither lane is actionable right now. Watch the technical screener below or wait for the next scoring pass.");
      modelNotEntered = (trader && trader.why) || (investor && investor.why);
    } else if (["HOLD", "TIGHTEN", "SELL"].indexOf(tv) >= 0 || ["HOLD", "TIGHTEN", "SELL"].indexOf(iv) >= 0) {
      headline = "Managing — trader " + tv.toLowerCase() + ", investor " + iv.toLowerCase();
      if (trader && trader.why) parts.push(trader.why);
      if (investor && investor.why && investor.why !== (trader && trader.why)) parts.push(investor.why);
    } else {
      headline = "Trader " + tv + " · Investor " + iv;
      if (trader && trader.why) parts.push(trader.why);
      if (investor && investor.why) parts.push(investor.why);
    }
    if (journey && journey.direction === "deteriorating" && tv === "WAIT") {
      parts.push("Journey is deteriorating on the trader lane — wait for improvement before forcing a tactical entry.");
    }
    return {
      headline: headline,
      narrative: parts.filter(Boolean).join(" "),
      model_not_entered: modelNotEntered,
      early_entry: earlyEntry,
      diverge: !!diverge,
      trader_verdict: tv,
      investor_verdict: iv,
    };
  }

  function ensureStyles() {
    if (document.getElementById("tt-verdict-ui-styles")) return;
    var el = document.createElement("style");
    el.id = "tt-verdict-ui-styles";
    el.textContent = [
      ".tt-vb{border:1px solid var(--ds-stroke,rgba(255,255,255,.07));border-radius:12px;background:var(--ds-bg-surface,rgba(255,255,255,.022));margin-bottom:var(--ds-space-3,12px);overflow:hidden}",
      ".tt-vb__inner{padding:14px 16px}",
      ".tt-vb__lane{display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-top:1px solid rgba(255,255,255,.05)}",
      ".tt-vb__lane:first-child{border-top:none;padding-top:0}",
      ".tt-vb__main{flex:1;min-width:0}",
      ".tt-vb__word{display:inline-flex;align-items:center;gap:6px;font-weight:800;font-size:14px;letter-spacing:.02em;padding:4px 10px;border-radius:8px}",
      ".tt-vb__dot{width:7px;height:7px;border-radius:50%;background:currentColor}",
      ".tt-vb--buy{background:var(--ds-up-bg,rgba(52,211,153,.14));color:var(--ds-up,#34d399)}",
      ".tt-vb--forming{background:rgba(20,184,166,.14);color:#14b8a6}",
      ".tt-vb--hold{background:var(--ds-bg-glass,rgba(255,255,255,.06));color:var(--ds-text-body,#e5e7eb)}",
      ".tt-vb--tighten{background:rgba(245,158,11,.14);color:#f59e0b}",
      ".tt-vb--sell{background:var(--ds-dn-bg,rgba(239,68,68,.14));color:var(--ds-dn,#ef4444)}",
      ".tt-vb--wait{background:rgba(255,255,255,.04);color:var(--ds-text-muted,#9ca3af)}",
      ".tt-vb__why{font-size:12px;color:var(--ds-text-muted,#9ca3af);margin-top:4px;line-height:1.45}",
      ".tt-vb__timing{font-size:11px;color:#14b8a6;margin-top:2px;font-weight:600}",
      ".tt-vb__levels{display:flex;flex-wrap:wrap;gap:12px;margin-top:6px;font-size:11px;color:var(--ds-text-faint,#6b7280)}",
      ".tt-vb__levels b{color:var(--ds-text-body,#e5e7eb);font-weight:600;font-family:var(--tt-font-mono,ui-monospace,monospace)}",
      ".tt-vb__journey{display:flex;align-items:center;gap:8px;margin-top:10px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:8px;font-size:11px;color:var(--ds-text-muted,#9ca3af)}",
      ".tt-vb__proof{border-top:1px solid rgba(255,255,255,.05);padding:9px 16px;font-size:11px;color:var(--ds-text-faint,#6b7280);display:flex;justify-content:space-between;align-items:center}",
      ".tt-vb--guide .tt-vb__inner{padding:14px 16px 12px}",
      ".tt-vb__guide-head{font-size:13px;font-weight:800;color:var(--ds-text-headline,#f4f5f7);margin-bottom:6px;line-height:1.35}",
      ".tt-vb__guide-narrative{font-size:12px;color:var(--ds-text-muted,#9ca3af);line-height:1.5;margin:0 0 10px}",
      ".tt-vb__callout{margin-top:8px;padding:8px 10px;border-radius:8px;font-size:11.5px;line-height:1.45;color:var(--ds-text-muted,#9ca3af)}",
      ".tt-vb__callout strong{color:var(--ds-text-body,#e5e7eb);font-weight:700}",
      ".tt-vb__callout--wait{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.06)}",
      ".tt-vb__callout--info{background:rgba(20,184,166,.08);border:1px solid rgba(20,184,166,.18)}",
      ".tt-lane-badge{display:inline-flex;align-items:center;font-size:9.5px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:4px;margin-left:8px}",
      ".tt-lane-badge--trader{background:rgba(96,165,250,.15);color:#60a5fa}",
      ".tt-lane-badge--investor{background:rgba(192,132,252,.15);color:#c084fc}",
      ".tt-lifecycle{display:flex;gap:4px;align-items:center;margin-top:5px;font-size:9px;letter-spacing:.08em;color:var(--ds-text-faint,#6b7280);flex-wrap:wrap}",
      ".tt-lc{padding:1px 6px;border-radius:3px;background:rgba(255,255,255,.04)}",
      ".tt-lc--on{background:rgba(20,184,166,.14);color:#14b8a6;font-weight:700}",
      ".tt-lc--done{color:var(--ds-text-muted,#9ca3af)}",
      ".tt-ready{margin-bottom:18px}",
      ".tt-ready__head{margin-bottom:8px}",
      ".tt-ready__title{font-family:var(--tt-font-display,inherit);font-size:18px;font-weight:800;color:var(--ds-text-headline,#f4f5f7);letter-spacing:-.02em;margin:4px 0 0}",
      ".tt-ready__sub{font-size:12.5px;color:var(--ds-text-muted,#9ca3af);line-height:1.5;margin:6px 0 0;max-width:52em}",
      ".tt-ready-scroll{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 10px;scroll-snap-type:x proximity;scrollbar-width:thin;-webkit-overflow-scrolling:touch}",
      ".tt-ready-scroll::-webkit-scrollbar{height:6px}",
      ".tt-ready-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:999px}",
      ".tt-ready-card{flex:0 0 210px;scroll-snap-align:start;display:flex;flex-direction:column;gap:7px;padding:11px 13px;border-radius:14px;cursor:pointer;text-align:left;background:var(--ds-bg-surface,rgba(255,255,255,.022));border:1px solid var(--ds-stroke,rgba(255,255,255,.07));color:var(--ds-text-body,#e5e7eb);transition:border-color .15s,background .15s}",
      ".tt-ready-card:hover{border-color:rgba(20,184,166,.35);background:rgba(255,255,255,.03)}",
      ".tt-ready-card__head{display:flex;align-items:center;gap:5px;flex-wrap:wrap}",
      ".tt-ready-card__sym{font-weight:800;font-size:14px;font-family:var(--tt-font-mono,ui-monospace,monospace);letter-spacing:.02em}",
      ".tt-ready-chip{display:inline-flex;align-items:center;font-size:8px;font-weight:700;letter-spacing:.08em;padding:2px 6px;border-radius:999px;white-space:nowrap;line-height:1.2}",
      ".tt-ready-chip--buy{background:rgba(52,211,153,.14);color:#34d399}",
      ".tt-ready-chip--forming{background:rgba(20,184,166,.14);color:#14b8a6}",
      ".tt-ready-chip--lane-trader{background:rgba(96,165,250,.15);color:#60a5fa}",
      ".tt-ready-chip--lane-investor{background:rgba(192,132,252,.15);color:#c084fc}",
      ".tt-ready-card__meta{font-size:10px;color:var(--ds-text-faint,#6b7280);font-family:var(--tt-font-mono,ui-monospace,monospace)}",
      ".tt-ready-card__why{margin:0;font-size:11.5px;line-height:1.45;color:var(--ds-text-muted,#9ca3af);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".tt-ready-card__lanes{font-size:9.5px;color:var(--ds-text-faint,#6b7280);font-family:var(--tt-font-mono,ui-monospace,monospace);letter-spacing:.02em}",
      ".tt-ready__empty{font-size:12.5px;color:var(--ds-text-faint,#6b7280);font-style:italic;padding:4px 2px 8px}",
      ".tt-ready__locked{font-size:12.5px;color:var(--ds-text-muted,#9ca3af);padding:4px 2px 8px}",
      ".tt-trust{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:10px 16px;border:1px solid var(--ds-stroke,rgba(255,255,255,.07));border-radius:10px;background:rgba(255,255,255,.02);margin-bottom:16px;font-size:11.5px;color:var(--ds-text-muted,#9ca3af)}",
      ".tt-trust b{color:var(--ds-text-body,#e5e7eb);font-family:var(--tt-font-mono,ui-monospace,monospace)}",
      ".tt-trust__label{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ds-text-faint,#6b7280)}",
    ].join("");
    document.head.appendChild(el);
  }

  function fetchVerdict(opts) {
    opts = opts || {};
    var ticker = opts.ticker ? String(opts.ticker).toUpperCase() : "";
    var limit = opts.limit || 12;
    var url = API_BASE + "/timed/verdict" + (ticker ? "?ticker=" + encodeURIComponent(ticker) : "?limit=" + limit);
    var fetchOpts = { credentials: "include" };
    if (window.TTFetchCache && opts.cacheTtlMs) {
      return window.TTFetchCache.get(url, {
        ttlMs: opts.cacheTtlMs,
        maxAgeMs: opts.cacheMaxAgeMs || opts.cacheTtlMs * 6,
        fetchOpts: fetchOpts,
      });
    }
    return fetch(url, fetchOpts).then(function (r) { return r.json(); });
  }

  function fetchLedgerSummary(days) {
    days = days || 90;
    var since = Date.now() - days * 86400000;
    var url = API_BASE + "/timed/ledger/summary?since=" + since;
    return fetch(url, { credentials: "include" }).then(function (r) { return r.json(); });
  }

  function headlinePrice(t) {
    try {
      var p = window.TimedPriceUtils && window.TimedPriceUtils.getHeadlinePrice
        ? window.TimedPriceUtils.getHeadlinePrice(t)
        : null;
      if (Number.isFinite(Number(p))) return Number(p);
    } catch (_) {}
    var n = Number(t && (t._live_price != null ? t._live_price : t.price != null ? t.price : t.close));
    return Number.isFinite(n) ? n : null;
  }

  /** Rank actionable setups from the live /timed/all map (Today already has this). */
  function rankReadySetupsFromData(data, limit) {
    var rows = [];
    if (!data || typeof data !== "object") return rows;
    Object.keys(data).forEach(function (sym) {
      var t = data[sym];
      if (!t || typeof t !== "object") return;
      var key = String(sym).toUpperCase();
      var stage = String(t.kanban_stage || "").toLowerCase();
      var invStage = String(t.investor_stage || t.investorStage || "").toLowerCase();
      var journey = t._journey && t._journey.features;
      var rank = Number(t.rank);
      var rankNum = Number.isFinite(rank) ? rank : null;
      var price = headlinePrice(t);
      var score = 0;
      var traderVerdict = inferTraderVerdictFromTicker(t, null);
      var investorVerdict = inferInvestorVerdictFromTicker(t);

      var tv = traderVerdict;
      if (tv && (tv.verdict === "BUY" || tv.verdict === "SETUP_FORMING")) {
        score = tv.verdict === "BUY" ? 100 : 50;
        if (journey && journey.direction === "improving") score += 20;
        if (rankNum != null) score += Math.max(0, 100 - rankNum) / 10;
        tv.price = price;
        tv.rank = rankNum;
        rows.push({ ticker: key, rank: rankNum, lane: "trader", trader: tv, traderVerdict: traderVerdict, investorVerdict: investorVerdict, score: score });
        return;
      }
      if (stage === "enter" || stage === "enter_now" || stage === "just_flipped") {
        score = 100;
        if (journey && journey.direction === "improving") score += 20;
        if (rankNum != null) score += Math.max(0, 100 - rankNum) / 10;
        rows.push({
          ticker: key, rank: rankNum, lane: "trader",
          trader: {
            lane: "trader", verdict: "BUY", timing: "now",
            why: "entry lane (" + stage + ")",
            price: price, rank: rankNum,
          },
          traderVerdict: traderVerdict,
          investorVerdict: investorVerdict,
          score: score,
        });
        return;
      }
      if (stage === "in_review") {
        score = 55;
        if (journey && journey.direction === "improving") score += 20;
        if (rankNum != null) score += Math.max(0, 100 - rankNum) / 10;
        rows.push({
          ticker: key, rank: rankNum, lane: "trader",
          trader: {
            lane: "trader", verdict: "SETUP_FORMING", timing: "on confirmation",
            why: "trigger ready" + (journey && journey.direction === "improving" ? "; journey improving" : ""),
            price: price, rank: rankNum,
          },
          traderVerdict: traderVerdict,
          investorVerdict: investorVerdict,
          score: score,
        });
        return;
      }
      if (invStage === "accumulate") {
        score = 85;
        if (journey && journey.direction === "improving") score += 15;
        var iv = investorVerdict || {
          lane: "investor", verdict: "BUY", timing: "scale in",
          why: "accumulate zone" + (t.investor_score != null ? ", score " + t.investor_score : ""),
        };
        iv.price = price;
        iv.rank = rankNum;
        rows.push({
          ticker: key, rank: rankNum, lane: "investor",
          trader: iv,
          traderVerdict: traderVerdict,
          investorVerdict: investorVerdict,
          score: score,
        });
      }
    });
    rows.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    if (limit != null && limit > 0) return rows.slice(0, limit);
    return rows;
  }

  function register(React) {
    if (!React) return null;
    ensureStyles();
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;

    function LaneBadge(props) {
      var lane = String(props.lane || "trader").toLowerCase();
      var label = lane === "investor" ? "INVESTOR" : "TRADER";
      return h("span", {
        className: "tt-lane-badge tt-lane-badge--" + lane,
      }, label);
    }

    function VerdictWord(props) {
      var m = verdictMeta(props.verdict);
      var label = props.short ? verdictLabel(props.verdict, true) : verdictLabel(props.verdict, false);
      return h("span", { className: "tt-vb__word " + m.cls },
        h("span", { className: "tt-vb__dot" }),
        label,
      );
    }

    function LifecycleStrip(props) {
      var current = props.current || "FORMING";
      var idx = lifecycleIndex(current);
      return h("div", { className: "tt-lifecycle", "aria-label": "Setup lifecycle" },
        LIFECYCLE_STEPS.map(function (step, i) {
          var cls = "tt-lc";
          if (i < idx) cls += " tt-lc--done";
          else if (i === idx) cls += " tt-lc--on";
          return h("span", { key: step, className: cls }, step);
        }),
      );
    }

    function VerdictLaneRow(props) {
      var v = props.verdict;
      if (!v) return null;
      var journey = v.journey;
      var levels = [];
      if (v.entry_price != null && props.showEntry) levels.push(["entry", v.entry_price]);
      if (v.stop != null) levels.push(["stop", v.stop]);
      if (v.target != null) levels.push(["target", v.target]);
      if (v.pnl_pct != null) levels.push(["P&L", v.pnl_pct, true]);

      return h("div", { className: "tt-vb__lane" },
        h("div", { className: "tt-vb__main" },
          h(VerdictWord, { verdict: v.verdict, short: props.shortVerdict }),
          h(LaneBadge, { lane: v.lane }),
          v.timing && h("div", { className: "tt-vb__timing" }, fmtTiming(v.timing)),
          v.why && h("div", { className: "tt-vb__why" }, v.why),
          levels.length > 0 && h("div", { className: "tt-vb__levels" },
            levels.map(function (pair) {
              var isPct = pair[2];
              return h("span", { key: pair[0] },
                pair[0] + " ",
                h("b", { className: isPct && Number(pair[1]) >= 0 ? "up" : isPct && Number(pair[1]) < 0 ? "dn" : "" },
                  isPct ? fmtPct(pair[1]) : fmtPx(pair[1]),
                ),
              );
            }),
          ),
          journey && h("div", { className: "tt-vb__journey" },
            "Journey: ",
            h("b", {
              style: { color: journey.direction === "improving" ? "var(--ds-up,#34d399)" : journey.direction === "deteriorating" ? "var(--ds-dn,#ef4444)" : "inherit" },
            }, journey.direction || "flat"),
            journey.time_in_stage_min != null && (" · " + journey.time_in_stage_min + "m in stage"),
            journey.cell && (" · cell " + journey.cell),
          ),
        ),
      );
    }

    function VerdictBlock(props) {
      var sym = String(props.ticker || "").toUpperCase();
      var data = props.data;
      var loading = props.loading;
      var compact = props.compact;
      if (!sym) return null;
      if (loading) {
        return h("div", { className: "tt-vb" },
          h("div", { className: "tt-vb__inner", style: { color: "var(--ds-text-faint)", fontSize: 12 } }, "Loading verdict…"),
        );
      }
      if (!data || !data.ok) return null;
      var showTrader = data.trader && data.trader.verdict && data.trader.verdict !== "WAIT";
      var showInvestor = data.investor && data.investor.verdict && data.investor.verdict !== "WAIT";
      if (!showTrader && !showInvestor) return null;
      return h("div", { className: "tt-vb" },
        h("div", { className: "tt-vb__inner" },
          showTrader && h(VerdictLaneRow, { verdict: data.trader, showEntry: true, shortVerdict: compact }),
          showInvestor && h(VerdictLaneRow, { verdict: data.investor, shortVerdict: compact }),
        ),
      );
    }

    function VerdictGuideBlock(props) {
      var sym = String(props.ticker || "").toUpperCase();
      var data = props.data;
      var loading = props.loading;
      var payload = props.tickerPayload;
      if (!sym || !window._ttIsPro) return null;
      if (loading) {
        return h("div", { className: "tt-vb tt-vb--guide" },
          h("div", { className: "tt-vb__inner", style: { color: "var(--ds-text-faint)", fontSize: 12 } }, "Loading lane guide…"),
        );
      }
      if (!data || !data.ok) return null;
      if (!data.trader && !data.investor) return null;
      var guide = data.guide || buildVerdictGuide(data.trader, data.investor, payload);
      if (!guide) return null;
      return h("div", { className: "tt-vb tt-vb--guide" },
        h("div", { className: "tt-vb__inner" },
          h("div", { className: "tt-vb__guide-head" }, guide.headline),
          guide.narrative && h("p", { className: "tt-vb__guide-narrative" }, guide.narrative),
          data.trader && h(VerdictLaneRow, { verdict: data.trader, showEntry: true, shortVerdict: true }),
          data.investor && h(VerdictLaneRow, { verdict: data.investor, shortVerdict: true }),
          guide.model_not_entered && h("div", { className: "tt-vb__callout tt-vb__callout--wait" },
            h("strong", null, "Why the model has not entered: "),
            guide.model_not_entered,
          ),
          guide.early_entry && h("div", { className: "tt-vb__callout tt-vb__callout--info" },
            h("strong", null, "Early vs model: "),
            guide.early_entry,
          ),
        ),
      );
    }

    function useVerdict(ticker, opts) {
      opts = opts || {};
      var sym = String(ticker || "").toUpperCase();
      var _s = useState(null);
      var data = _s[0];
      var setData = _s[1];
      var _l = useState(false);
      var loading = _l[0];
      var setLoading = _l[1];
      useEffect(function () {
        if (!sym || !window._ttIsPro) { setData(null); return; }
        var alive = true;
        setLoading(true);
        fetchVerdict({ ticker: sym, cacheTtlMs: opts.cacheTtlMs || 60000 }).then(function (j) {
          if (alive) { setData(j); setLoading(false); }
        }).catch(function () { if (alive) { setData(null); setLoading(false); } });
        return function () { alive = false; };
      }, [sym, opts.cacheTtlMs]);
      return { data: data, loading: loading };
    }

    function ReadySetupsBoard(props) {
      var onSelect = props.onSelectTicker;
      var tickerData = props.tickerData;
      var _s = useState(null);
      var apiPack = _s[0];
      var setApiPack = _s[1];
      useEffect(function () {
        if (!window._ttIsPro || (tickerData && Object.keys(tickerData).length > 0)) return;
        var alive = true;
        fetchVerdict({ cacheTtlMs: 120000 }).then(function (j) {
          if (alive) setApiPack(j);
        }).catch(function () {});
        return function () { alive = false; };
      }, [tickerData]);
      var candidates = useMemo(function () {
        if (tickerData && typeof tickerData === "object" && Object.keys(tickerData).length > 0) {
          return rankReadySetupsFromData(tickerData);
        }
        return (apiPack && apiPack.candidates) || [];
      }, [tickerData, apiPack]);

      var headCopy = h("div", { className: "tt-ready__head" },
        h("div", { className: "tt-sec-title" }, "READY SETUPS"),
        h("h2", { className: "tt-ready__title" }, "What the model would act on"),
        h("p", { className: "tt-ready__sub" },
          "Every name the model marks enter-ready or accumulate — scroll the strip. Separate from the technical screener and Growth Ideas fundamentals below.",
        ),
      );

      if (!window._ttIsPro) {
        return h("section", { className: "tt-ready" },
          headCopy,
          h("div", { className: "tt-ready__locked" }, "Upgrade to Pro to see ranked setups the model would act on."),
        );
      }
      if (candidates.length === 0) {
        return h("section", { className: "tt-ready" },
          headCopy,
          h("div", { className: "tt-ready__empty" }, "No entry or accumulate setups right now — the strip stays empty rather than forcing picks. Refreshes with each scoring pass."),
        );
      }
      return h("section", { className: "tt-ready" },
        headCopy,
        h("div", { className: "tt-ready-scroll", role: "list" },
          candidates.map(function (row) {
            var sym = String(row.ticker || "").toUpperCase();
            var tv = row.trader || {};
            var lane = row.lane || tv.lane || "trader";
            var price = tv.price;
            var rank = row.rank != null ? row.rank : tv.rank;
            var verdictCls = tv.verdict === "BUY" ? "buy" : "forming";
            var railTab = lane === "investor" ? "INVESTOR" : "SETUP";
            var traderV = row.traderVerdict || tv;
            var investorV = row.investorVerdict;
            var laneLine = investorV
              ? ("Trader " + verdictLabel(traderV.verdict, true) + " · Investor " + verdictLabel(investorV.verdict, true))
              : null;
            return h("button", {
              key: sym + "-" + lane,
              type: "button",
              className: "tt-ready-card",
              role: "listitem",
              title: sym + " — open " + (lane === "investor" ? "Investor" : "Trader") + " tab",
              onClick: function () { if (onSelect) onSelect(sym, railTab); },
            },
              h("div", { className: "tt-ready-card__head" },
                h("span", { className: "tt-ready-card__sym" }, sym),
                h("span", { className: "tt-ready-chip tt-ready-chip--" + verdictCls },
                  verdictLabel(tv.verdict, true),
                ),
                h("span", { className: "tt-ready-chip tt-ready-chip--lane-" + lane },
                  lane === "investor" ? "INVESTOR" : "TRADER",
                ),
              ),
              h("div", { className: "tt-ready-card__meta" },
                price != null ? fmtPx(price) : "—",
                rank != null ? " · rank " + rank : "",
              ),
              laneLine && h("div", { className: "tt-ready-card__lanes" }, laneLine),
              h("p", { className: "tt-ready-card__why" }, tv.why || "—"),
            );
          }),
        ),
      );
    }

    // Legacy export name — prefer ReadySetupsBoard.
    var TodaysAnswers = ReadySetupsBoard;

    function TrustStrip() {
      var _s = useState(null);
      var summary = _s[0];
      var setSummary = _s[1];
      useEffect(function () {
        var alive = true;
        fetchLedgerSummary(90).then(function (j) {
          if (alive && j && j.ok) setSummary(j.totals);
        }).catch(function () {});
        return function () { alive = false; };
      }, []);
      if (!summary) return null;
      var closed = Number(summary.closedTrades) || 0;
      if (closed < 5) return null;
      var wr = Number(summary.winRate);
      return h("div", { className: "tt-trust" },
        h("span", { className: "tt-trust__label" }, "Model track record · 90d"),
        h("span", null, h("b", null, String(closed)), " closed calls"),
        h("span", null, h("b", null, Number.isFinite(wr) ? wr.toFixed(1) + "%" : "—"), " hit rate"),
        h("span", null, "Profit factor ", h("b", null, summary.profitFactor != null ? Number(summary.profitFactor).toFixed(2) : "—")),
      );
    }

    function VerdictChip(props) {
      var v = props.verdict;
      if (!v) return null;
      return h("span", {
        className: "tt-vb__word " + verdictMeta(v).cls,
        style: { fontSize: props.size || 11, padding: "2px 8px" },
        title: props.why || undefined,
      },
        h("span", { className: "tt-vb__dot" }),
        verdictLabel(v, true),
      );
    }

    return {
      LaneBadge: LaneBadge,
      VerdictWord: VerdictWord,
      VerdictChip: VerdictChip,
      VerdictBlock: VerdictBlock,
      VerdictGuideBlock: VerdictGuideBlock,
      LifecycleStrip: LifecycleStrip,
      ReadySetupsBoard: ReadySetupsBoard,
      TodaysAnswers: TodaysAnswers,
      rankReadySetupsFromData: rankReadySetupsFromData,
      TrustStrip: TrustStrip,
      useVerdict: useVerdict,
      fetchVerdict: fetchVerdict,
      verdictLabel: verdictLabel,
      verdictMeta: verdictMeta,
      lifecycleFromStage: lifecycleFromStage,
      inferTraderVerdictFromTicker: inferTraderVerdictFromTicker,
      inferInvestorVerdictFromTicker: inferInvestorVerdictFromTicker,
      buildVerdictGuide: buildVerdictGuide,
      LIFECYCLE_STEPS: LIFECYCLE_STEPS,
    };
  }

  function boot() {
    ensureStyles();
    if (window.React && !window.TimedVerdictUI) {
      window.TimedVerdictUI = register(window.React);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.TimedVerdictUI = window.TimedVerdictUI || {
    fetchVerdict: fetchVerdict,
    verdictLabel: verdictLabel,
    verdictMeta: verdictMeta,
    lifecycleFromStage: lifecycleFromStage,
    inferTraderVerdictFromTicker: inferTraderVerdictFromTicker,
    rankReadySetupsFromData: rankReadySetupsFromData,
    LIFECYCLE_STEPS: LIFECYCLE_STEPS,
    register: register,
  };
})();

// cache-bust:1783278879082:135362481
