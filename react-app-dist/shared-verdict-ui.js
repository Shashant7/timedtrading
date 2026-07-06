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

  /** Strict numeric coercion — null/""/undefined → null (not 0). */
  function numN(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
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

  var STATE_READS = {
    HTF_BULL_LTF_BULL: { htf: "up", ltf: "up", structuralDir: "LONG", label: "trend aligned up", ltfPhrase: "short-term momentum is also up" },
    HTF_BULL_LTF_PULLBACK: { htf: "up", ltf: "pulling back", structuralDir: "LONG", label: "bullish pullback", ltfPhrase: "short-term is pulling back into the trend" },
    HTF_BULL_LTF_BEAR: { htf: "up", ltf: "bearish", structuralDir: "LONG", label: "bull trend, bearish momentum", ltfPhrase: "short-term momentum has turned down" },
    HTF_BEAR_LTF_BEAR: { htf: "down", ltf: "down", structuralDir: "SHORT", label: "trend aligned down", ltfPhrase: "short-term momentum is also down" },
    HTF_BEAR_LTF_PULLBACK: { htf: "down", ltf: "bouncing", structuralDir: "SHORT", label: "bearish bounce", ltfPhrase: "short-term is bouncing against the trend" },
    HTF_BEAR_LTF_BULL: { htf: "down", ltf: "bullish", structuralDir: "SHORT", label: "bear trend, bullish momentum", ltfPhrase: "short-term momentum has turned up" },
  };
  function readState(state) {
    var key = String(state || "").toUpperCase();
    if (STATE_READS[key]) { var o = {}; for (var k in STATE_READS[key]) o[k] = STATE_READS[key][k]; o.state = key; return o; }
    var htfBull = key.indexOf("HTF_BULL") === 0;
    var htfBear = key.indexOf("HTF_BEAR") === 0;
    if (!htfBull && !htfBear) return null;
    return {
      htf: htfBull ? "up" : "down",
      ltf: key.indexOf("LTF_BEAR") >= 0 ? "bearish" : key.indexOf("LTF_BULL") >= 0 ? "bullish" : "mixed",
      structuralDir: htfBull ? "LONG" : "SHORT",
      label: htfBull ? "higher-timeframe up" : "higher-timeframe down",
      ltfPhrase: key.indexOf("LTF_BEAR") >= 0 ? "short-term momentum has turned down" : key.indexOf("LTF_BULL") >= 0 ? "short-term momentum has turned up" : "short-term is mixed",
      state: key,
    };
  }
  function fmtUsdShort(n) {
    var x = Number(n);
    if (!Number.isFinite(x)) return null;
    return "$" + (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
  }
  function capFirst(s) {
    var str = String(s || "").trim();
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  /** Client mirror of worker/buildVerdictGuide — grounded in state/score/levels. */
  function buildVerdictGuide(trader, investor, payload) {
    if (!trader && !investor) return null;
    payload = payload || {};
    var tv = String((trader && trader.verdict) || "WAIT").toUpperCase();
    var iv = investor ? String(investor.verdict || "WAIT").toUpperCase() : "WAIT";
    var sread = readState(payload.state);
    var score = Number(payload.score); if (!Number.isFinite(score)) score = null;
    var rank = Number(payload.rank); if (!Number.isFinite(rank)) rank = null;
    var numN = function (v) { if (v === null || v === undefined || v === "") return null; var n = Number(v); return Number.isFinite(n) ? n : null; };
    var structuralDir = (sread && sread.structuralDir) || String((trader && trader.direction) || "").toUpperCase();
    var stop = numN(trader && trader.stop); if (stop === null) stop = numN(payload.sl);
    var target = numN(trader && trader.target); if (target === null) target = numN(payload.tp_trim); if (target === null) target = numN(payload.tp_exit);
    var entryTrigger = numN(trader && trader.entry_price);
    var invScore = numN(investor && investor.score); if (invScore === null) invScore = numN(payload.investor_score);
    var journey = payload._journey && payload._journey.features;
    var timing = payload.timing_overlay;
    var extension = Number(timing && timing.extension_score); if (!Number.isFinite(extension)) extension = null;
    var macroRiskOff = timing && (timing.posture === "RISK_OFF"
      || (Array.isArray(timing.warnings) && timing.warnings.some(function (w) { return String(w).indexOf("macro_risk_off") >= 0; })));

    var scoreFrag = score !== null ? ("score " + score + (rank !== null ? ", rank " + rank : "")) : (rank !== null ? ("rank " + rank) : "");
    var trendFrag = sread
      ? ("Higher-timeframe trend is " + sread.htf + " and " + sread.ltfPhrase + (scoreFrag ? " (" + scoreFrag + ")" : "") + ".")
      : (scoreFrag ? ("Model " + scoreFrag + ".") : "");
    var structuralFrag = (function () {
      if (!structuralDir) return "";
      var bits = [];
      if (entryTrigger !== null) bits.push("triggers near " + fmtUsdShort(entryTrigger));
      if (target !== null) bits.push("first target " + fmtUsdShort(target));
      if (stop !== null) bits.push("invalidates " + (structuralDir === "SHORT" ? "above " : "below ") + fmtUsdShort(stop));
      return "The structural setup is a " + structuralDir + " plan" + (bits.length ? " — " + bits.join(", ") : "") + ".";
    })();
    var macroFrag = macroRiskOff
      ? "The broader market is risk-off right now, which is weighing on the short-term read."
      : (extension !== null && extension >= 60 ? "Price is extended near-term, so timing favors patience over chasing." : "");

    var parts = [];
    var headline = "Lane guide";
    var modelNotEntered = null;
    var earlyEntry = null;
    var diverge = (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING"))
      || (tv === "BUY" && iv === "WAIT")
      || (sread && sread.ltf === "bearish" && iv === "BUY" && tv !== "BUY");

    if (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING")) {
      headline = (sread && sread.htf === "up")
        ? "Long-term thesis intact — short-term still choppy"
        : "Investor accumulate open — trader entry not yet triggered";
      if (trendFrag) parts.push(trendFrag);
      if (structuralFrag) parts.push(structuralFrag);
      parts.push("Investor lane reads accumulate" + (invScore !== null ? " (score " + invScore + ")" : "") + " — the longer thesis is still in play.");
      if (macroFrag) parts.push(macroFrag);
      modelNotEntered = (trader && trader.why)
        ? capFirst(trader.why) + "."
        : (tv === "SETUP_FORMING" ? "The setup is forming but the entry trigger has not fired." : "No trader entry signal yet.");
      earlyEntry = "Accumulating ahead of the model is reasonable ONLY inside the buy zone and stop line shown in Key levels below, with capped size and a hard invalidation"
        + (stop !== null ? " — treat a close " + (structuralDir === "SHORT" ? "above " : "below ") + fmtUsdShort(stop) + " as the line where the thesis breaks" : "") + ".";
    } else if (tv === "BUY" && iv !== "BUY") {
      headline = "Trader entry active — investor lane not yet accumulate";
      if (trendFrag) parts.push(trendFrag);
      if (structuralFrag) parts.push(structuralFrag);
      parts.push("The tactical trade is live on its own clock; the investor build has not opened yet.");
      if (investor && investor.why) modelNotEntered = capFirst(investor.why) + ".";
    } else if (tv === "BUY" && iv === "BUY") {
      headline = "Both lanes align — trade and build agree";
      if (trendFrag) parts.push(trendFrag);
      if (structuralFrag) parts.push(structuralFrag);
      parts.push("Trader entry and investor accumulate agree; size each lane by its own horizon rules.");
    } else if (tv === "SETUP_FORMING") {
      headline = "Setup building — confirmation pending";
      if (trendFrag) parts.push(trendFrag);
      if (structuralFrag) parts.push(structuralFrag);
      if (macroFrag) parts.push(macroFrag);
      modelNotEntered = (trader && trader.why) ? capFirst(trader.why) + "." : "The entry trigger has not fired yet.";
    } else if (["HOLD", "TIGHTEN", "SELL"].indexOf(tv) >= 0 || ["HOLD", "TIGHTEN", "SELL"].indexOf(iv) >= 0) {
      headline = "Managing — trader " + tv.toLowerCase() + (iv !== "WAIT" ? ", investor " + iv.toLowerCase() : "");
      if (trader && trader.why) parts.push(capFirst(trader.why) + ".");
      if (investor && investor.why && investor.why !== (trader && trader.why)) parts.push(capFirst(investor.why) + ".");
      if (macroFrag) parts.push(macroFrag);
    } else {
      headline = sread ? (capFirst(sread.label) + " — no lane action yet") : "No lane action yet";
      if (trendFrag) parts.push(trendFrag);
      if (structuralFrag) parts.push(structuralFrag);
      parts.push("Neither lane is actionable right now — wait for the next scoring pass or use the technical screener.");
      modelNotEntered = (trader && trader.why) ? capFirst(trader.why) + "." : ((investor && investor.why) ? capFirst(investor.why) + "." : null);
    }

    if (journey && journey.direction === "deteriorating" && (tv === "WAIT" || tv === "SETUP_FORMING")) {
      parts.push("The momentum journey is still deteriorating — let it turn before forcing an entry.");
    } else if (journey && journey.direction === "improving" && (tv === "WAIT" || tv === "SETUP_FORMING")) {
      parts.push("The momentum journey is improving, so the setup is trending toward a trigger.");
    }

    return {
      headline: headline,
      narrative: parts.filter(Boolean).join(" "),
      model_not_entered: modelNotEntered,
      early_entry: earlyEntry,
      diverge: !!diverge,
      structural_direction: structuralDir || null,
      state_label: (sread && sread.label) || null,
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
      ".tt-vb__key-levels{margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}",
      ".tt-vb__key-levels-head{font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--ds-text-faint,#6b7280);margin-bottom:8px}",
      ".tt-vb__key-levels-grid{display:flex;flex-direction:column;gap:4px}",
      ".tt-vb__kl-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:4px 0;border-top:1px solid rgba(255,255,255,.04)}",
      ".tt-vb__kl-row:first-child{border-top:none;padding-top:0}",
      ".tt-vb__kl-row--now{background:rgba(56,242,161,.08);margin:0 -8px;padding:6px 8px;border-radius:6px;border-top:none}",
      ".tt-vb__kl-label{font-size:11px;color:var(--ds-text-muted,#9ca3af);line-height:1.35}",
      ".tt-vb__kl-price{font-size:12px;font-family:var(--tt-font-mono,ui-monospace,monospace);font-weight:700;color:var(--ds-text-body,#e5e7eb);text-align:right;white-space:nowrap}",
      ".tt-vb__kl-price--up{color:var(--ds-up,#34d399)}",
      ".tt-vb__kl-price--dn{color:var(--ds-dn,#ef4444)}",
      ".tt-vb__kl-price--accent{color:var(--ds-accent,#38f2a1)}",
      ".tt-vb__kl-price--warn{color:#fbbf24}",
      ".tt-vb__kl-dist{font-size:10px;color:var(--ds-text-faint,#6b7280);font-family:var(--tt-font-mono,ui-monospace,monospace);margin-left:8px;white-space:nowrap;font-weight:500}",
      ".tt-vb__horizon{display:flex;gap:12px;align-items:flex-start;padding:11px 0;border-top:1px solid rgba(255,255,255,.05)}",
      ".tt-vb__horizon:first-of-type{border-top:none;padding-top:2px}",
      ".tt-vb__htag{flex:0 0 46px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ds-text-faint,#6b7280);line-height:1.25;padding-top:4px}",
      ".tt-vb__hbody{flex:1;min-width:0}",
      ".tt-vb__hhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".tt-vb__hline{font-size:12px;color:var(--ds-text-muted,#9ca3af);line-height:1.45;margin-top:5px}",
      ".tt-vb__stage-word{display:inline-flex;align-items:center;gap:6px;font-weight:800;font-size:13px;letter-spacing:.02em;padding:3px 10px;border-radius:8px;background:rgba(167,139,250,.14);color:#c084fc}",
      ".tt-lane-badge{display:inline-flex;align-items:center;font-size:9.5px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:4px;margin-left:8px}",
      ".tt-lane-badge--trader{background:rgba(96,165,250,.15);color:#60a5fa}",
      ".tt-lane-badge--investor{background:rgba(192,132,252,.15);color:#c084fc}",
      ".tt-lifecycle{display:flex;gap:4px;align-items:center;margin-top:5px;font-size:9px;letter-spacing:.08em;color:var(--ds-text-faint,#6b7280);flex-wrap:wrap}",
      ".tt-lc{padding:1px 6px;border-radius:3px;background:rgba(255,255,255,.04)}",
      ".tt-lc--on{background:rgba(20,184,166,.14);color:#14b8a6;font-weight:700}",
      ".tt-lc--done{color:var(--ds-text-muted,#9ca3af)}",
      ".tt-ready{margin-bottom:18px}",
      ".tt-universe-panel .tt-ready{margin-bottom:0}",
      ".tt-universe-panel__ready{margin:0}",
      ".tt-ready__head{margin-bottom:8px}",
      ".tt-ready__title{font-family:var(--tt-font-display,inherit);font-size:18px;font-weight:800;color:var(--ds-text-headline,#f4f5f7);letter-spacing:-.02em;margin:4px 0 0}",
      ".tt-ready__sub{font-size:12.5px;color:var(--ds-text-muted,#9ca3af);line-height:1.5;margin:6px 0 0;max-width:52em}",
      ".tt-ready-scroll{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 10px;scroll-snap-type:x proximity;scrollbar-width:thin;-webkit-overflow-scrolling:touch}",
      ".tt-ready-scroll::-webkit-scrollbar{height:6px}",
      ".tt-ready-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:999px}",
      ".tt-ready-card{flex:0 0 232px;scroll-snap-align:start;display:flex;flex-direction:column;gap:8px;min-height:120px;padding:13px 15px;border-radius:var(--vf-radius-md,18px);cursor:pointer;text-align:left;background:var(--ds-bg-surface,rgba(255,255,255,.022));border:1px solid var(--ds-stroke,rgba(255,255,255,.07));color:var(--ds-text-body,#e5e7eb);transition:border-color .15s,background .15s}",
      ".tt-ready-card:hover{border-color:rgba(56,242,161,.35);background:var(--ds-bg-glass,rgba(255,255,255,.04))}",
      ".tt-ready-card__head{display:flex;align-items:center;gap:8px}",
      ".tt-ready-card__sym{font-weight:800;font-size:15px;font-family:var(--tt-font-mono,ui-monospace,monospace);letter-spacing:.02em;flex:1 1 auto;min-width:0}",
      ".tt-ready-card__chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".tt-ready-word{display:inline-flex;align-items:center;gap:5px;font-weight:800;font-size:10px;letter-spacing:.03em;padding:3px 9px;border-radius:7px;white-space:nowrap;line-height:1.2}",
      ".tt-ready-word__dot{width:6px;height:6px;border-radius:50%;background:currentColor}",
      ".tt-ready-word--buy{background:var(--ds-up-bg,rgba(52,211,153,.14));color:var(--ds-up,#34d399)}",
      ".tt-ready-word--forming{background:rgba(20,184,166,.14);color:#14b8a6}",
      ".tt-ready-card__meta{font-size:10.5px;color:var(--ds-text-muted,#9ca3af);font-family:var(--tt-font-mono,ui-monospace,monospace);font-weight:500}",
      ".tt-ready-card__why{margin:0;font-size:11.5px;line-height:1.45;color:var(--ds-text-muted,#9ca3af);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".tt-ready-card__lanes{font-size:9.5px;color:var(--ds-text-faint,#6b7280);font-family:var(--tt-font-mono,ui-monospace,monospace);letter-spacing:.02em;margin-top:auto}",
      ".tt-ready__empty{font-size:12.5px;color:var(--ds-text-faint,#6b7280);font-style:italic;padding:4px 2px 8px}",
      ".tt-ready__locked{font-size:12.5px;color:var(--ds-text-muted,#9ca3af);padding:4px 2px 8px}",
      ".tt-ready-skel{flex:0 0 232px;min-height:120px;padding:13px 15px;border-radius:var(--vf-radius-md,18px);background:var(--ds-bg-surface,rgba(255,255,255,.022));border:1px solid var(--ds-stroke,rgba(255,255,255,.07));display:flex;flex-direction:column;gap:10px}",
      ".tt-ready-skel__bar{border-radius:6px;background:linear-gradient(90deg,var(--ds-bg-surface,rgba(255,255,255,.03)),var(--ds-bg-glass,rgba(255,255,255,.07)),var(--ds-bg-surface,rgba(255,255,255,.03)));background-size:200% 100%;animation:tt-ready-shimmer 1.6s ease-in-out infinite}",
      "@keyframes tt-ready-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}",
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
        var invRow = (window.TimedRailHelpers && window.TimedRailHelpers.normalizeInvestorScoreRow)
          ? window.TimedRailHelpers.normalizeInvestorScoreRow(t, key)
          : { stage: invStage, investor_stage: invStage, score: t.investor_score };
        if (window.TimedRailHelpers && window.TimedRailHelpers.isInvestorBuyZoneThesis) {
          if (!window.TimedRailHelpers.isInvestorBuyZoneThesis(invRow, key)) return;
        }
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

    // Plain-English short-term (trader) playbook line per verdict.
    var TRADER_PLAY = {
      BUY: "Entry is live now — size the position to the stop shown below.",
      HOLD: "Trade is working — hold and let the plan run.",
      TIGHTEN: "Momentum is fading — tighten the stop or take partial profit.",
      SELL: "Exit signal is active — close or stop out now.",
      SETUP_FORMING: "Setup is building — wait for the trigger to confirm before entering.",
      WAIT: "No tradable setup yet — wait for a trigger to fire.",
    };

    // Long-term (investor) playbook — label + color + plain line, keyed to
    // the same lane vocabulary the Investor board uses.
    var INV_STAGE_PLAY = {
      accumulate: { label: "Accumulate", color: "#34d399", line: "Model is scaling into the buy zone — add on dips, never chase extension." },
      core_hold: { label: "Core Hold", color: "#60a5fa", line: "Owned and healthy — hold the core; add only on a meaningful pullback." },
      watch: { label: "Hold & Watch", color: "#60a5fa", line: "Owned but signals are mixed — hold flat, no adds or trims yet." },
      reduce: { label: "Reduce", color: "#fb923c", line: "Thesis is weakening — trim into strength and respect the invalidation." },
      research_on_watch: { label: "On Radar", color: "#a78bfa", line: "Not owned — tracking only. No capital until it reaches Accumulate." },
      research_low: { label: "Low Conviction", color: "#a78bfa", line: "Not owned — low conviction. Better setups exist elsewhere." },
      research_avoid: { label: "Avoid", color: "#8AA39A", line: "Not owned — multiple red flags. The model skips it." },
      exited: { label: "Exited", color: "#8AA39A", line: "Recently closed — watching for a fresh Accumulate signal." },
    };
    function investorStagePlay(stage) {
      var s = String(stage || "").toLowerCase();
      return INV_STAGE_PLAY[s] || null;
    }

    /**
     * Build a single, freshness-validated Key-Levels ladder anchored to the
     * live price. Every level is checked against the live price so a stale
     * or wrong-side number (e.g. a short stop rendered as a long invalidation)
     * is dropped instead of contradicting the price. Short-term levels come
     * from the active trader plan; long-term levels come from the fresh
     * investor detail (invalidation / fair value / buy zone).
     */
    function buildGuideKeyLevels(trader, investor, payload, opts) {
      opts = opts || {};
      payload = payload || {};
      var pc = opts.predictionContract;
      var invData = opts.investorData;
      var px = numN(opts.livePrice);
      if (px === null) px = numN(payload.price);
      if (px === null) px = numN(payload._live_price);
      if (px === null) px = numN(payload.close);
      if (!(px > 0)) px = null;
      var rows = [];
      var seen = {};
      // side: "below" must sit under the live price, "above" over it, null = no gate.
      function add(label, price, tone, side) {
        var p = numN(price);
        if (p === null || !(p > 0)) return;
        if (px !== null && side === "below" && p >= px) return;
        if (px !== null && side === "above" && p <= px) return;
        var key = p.toFixed(2);
        if (seen[key]) return;
        seen[key] = 1;
        rows.push({ label: label, price: p, tone: tone });
      }
      // Short-term (trader) plan — only when a setup is active + direction-consistent.
      var tv = String((trader && trader.verdict) || "").toUpperCase();
      var tActive = ["BUY", "HOLD", "TIGHTEN", "SELL"].indexOf(tv) >= 0;
      var tDir = String((trader && trader.direction) || "LONG").toUpperCase();
      if (tActive) {
        add("Entry trigger", trader.entry_price, "accent", null);
        add("Trader stop", trader.stop, "dn", tDir === "SHORT" ? "above" : "below");
        add("Trader target", trader.target, "up", tDir === "SHORT" ? "below" : "above");
      }
      // Long-term (investor) plan — long-biased, fresh from the investor detail.
      if (invData) {
        var invPrice = numN(invData.primaryInvalidation && invData.primaryInvalidation.price);
        if (invPrice === null) invPrice = numN(invData.thesisInvalidationPrice);
        var fv = numN(invData.fairValue && invData.fairValue.fair_value);
        if (fv === null) fv = numN(invData._fair_value && invData._fair_value.fair_value);
        var az = invData.accumZone || invData.accumulate_zone || invData.buy_zone || invData.zone;
        var zHi = numN(az && (az.zoneTop != null ? az.zoneTop : az.high != null ? az.high : az.max));
        var zLo = numN(az && (az.zoneBottom != null ? az.zoneBottom : az.low != null ? az.low : az.min));
        if (zHi !== null && zLo !== null && zHi > 0 && zLo > 0 && (px === null || zHi < px)) {
          var zKey = zLo.toFixed(2) + "-" + zHi.toFixed(2);
          if (!seen[zKey]) {
            seen[zKey] = 1;
            rows.push({ label: "Investor buy zone", range: fmtPx(zLo) + " – " + fmtPx(zHi), _sort: (zLo + zHi) / 2, tone: "up" });
          }
        }
        add("Fair value estimate", fv, "warn", null);
        add("Investor invalidation", invPrice, "dn", "below");
      }
      // Fallback S/R from the prediction contract only when we have nothing else.
      if (rows.length === 0 && pc && Array.isArray(pc.levels)) {
        pc.levels.filter(function (l) { return l.role === "resistance"; }).slice(0, 2)
          .forEach(function (l) { add(l.label || "Resistance", l.price, "dn", "above"); });
        pc.levels.filter(function (l) { return l.role === "support"; }).slice(0, 2)
          .forEach(function (l) { add(l.label || "Support", l.price, "up", "below"); });
      }
      if (rows.length === 0) return null;
      return { px: px, rows: rows };
    }

    function GuideKeyLevels(props) {
      var data = props.data;
      if (!data || !Array.isArray(data.rows) || !data.rows.length) return null;
      var px = data.px;
      var ladder = data.rows.slice();
      if (Number.isFinite(px) && px > 0) {
        ladder.push({ label: "Current price", price: px, tone: "accent", now: true });
      }
      // Price ladder — highest at top, lowest at bottom, live price in place.
      ladder.sort(function (a, b) {
        var ap = Number.isFinite(a._sort) ? a._sort : a.price;
        var bp = Number.isFinite(b._sort) ? b._sort : b.price;
        return (bp || 0) - (ap || 0);
      });
      return h("div", { className: "tt-vb__key-levels" },
        h("div", { className: "tt-vb__key-levels-head" }, "Key levels · live"),
        h("div", { className: "tt-vb__key-levels-grid" },
          ladder.map(function (r, i) {
            var priceCls = "tt-vb__kl-price"
              + (r.tone === "up" ? " tt-vb__kl-price--up"
                : r.tone === "dn" ? " tt-vb__kl-price--dn"
                : r.tone === "warn" ? " tt-vb__kl-price--warn"
                : r.tone === "accent" ? " tt-vb__kl-price--accent" : "");
            var refP = Number.isFinite(r._sort) ? r._sort : r.price;
            var dist = (!r.now && Number.isFinite(px) && px > 0 && Number.isFinite(refP))
              ? ((refP - px) / px) * 100 : null;
            return h("div", {
              key: (r.label || "row") + "-" + i,
              className: "tt-vb__kl-row" + (r.now ? " tt-vb__kl-row--now" : ""),
            },
              h("span", { className: "tt-vb__kl-label" }, r.label),
              h("span", { className: priceCls },
                r.range || fmtPx(r.price),
                dist !== null && h("span", { className: "tt-vb__kl-dist" }, (dist >= 0 ? "+" : "") + dist.toFixed(1) + "%"),
              ),
            );
          }),
        ),
      );
    }

    /**
     * VerdictGuideBlock — condensed two-horizon playbook (Now tab only).
     * Scans the trader + investor lanes and the fresh level set, then presents
     * ONE coherent read: a short-term (trader) line, a long-term (investor)
     * line, and a single freshness-checked Key-Levels ladder. No stale or
     * wrong-side numbers, no duplicated level panels.
     */
    function VerdictGuideBlock(props) {
      var sym = String(props.ticker || "").toUpperCase();
      var data = props.data;
      var loading = props.loading;
      var payload = props.tickerPayload || {};
      if (!sym || !window._ttIsPro) return null;
      if (loading) {
        return h("div", { className: "tt-vb tt-vb--guide" },
          h("div", { className: "tt-vb__inner", style: { color: "var(--ds-text-faint)", fontSize: 12 } }, "Loading playbook…"),
        );
      }
      if (!data || !data.ok) return null;
      if (!data.trader && !data.investor) return null;
      var guide = data.guide || buildVerdictGuide(data.trader, data.investor, payload);
      if (!guide) return null;

      var levels = buildGuideKeyLevels(data.trader, data.investor, payload, {
        predictionContract: props.predictionContract,
        investorData: props.investorData,
        livePrice: props.livePrice,
      });

      var px = numN(props.livePrice);
      if (px === null) px = numN(payload.price);
      if (px === null) px = numN(payload._live_price);
      if (px === null) px = numN(payload.close);

      // Short-term (trader) horizon.
      var tv = String((data.trader && data.trader.verdict) || "WAIT").toUpperCase();
      var shortLine = TRADER_PLAY[tv] || TRADER_PLAY.WAIT;

      // Long-term (investor) horizon — label + plain line from the fresh stage.
      var invStage = String((props.investorData && props.investorData.stage) || payload.investor_stage || payload.investorStage || "").toLowerCase();
      var play = investorStagePlay(invStage);
      var iv = String((data.investor && data.investor.verdict) || "WAIT").toUpperCase();
      var invScore = numN(props.investorData && props.investorData.score);
      if (invScore === null) invScore = numN(payload.investor_score);
      var longLine = play ? play.line : (data.investor && data.investor.why ? capFirst(data.investor.why) + "." : null);

      // Coherent early-entry note: only for a live accumulate signal whose
      // fresh invalidation actually sits below the current price.
      var invFloor = null;
      if (props.investorData) {
        invFloor = numN(props.investorData.primaryInvalidation && props.investorData.primaryInvalidation.price);
        if (invFloor === null) invFloor = numN(props.investorData.thesisInvalidationPrice);
      }
      var earlyEntry = null;
      if (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING") && invFloor !== null && (!(px > 0) || invFloor < px)) {
        earlyEntry = "Accumulating ahead of the model is only reasonable inside the buy zone with capped size — the long-term thesis breaks on a close below " + fmtPx(invFloor) + ".";
      }

      return h("div", { className: "tt-vb tt-vb--guide" },
        h("div", { className: "tt-vb__inner" },
          h("div", { className: "tt-vb__guide-head" }, guide.headline),

          data.trader && h("div", { className: "tt-vb__horizon" },
            h("div", { className: "tt-vb__htag" }, "Short", h("br"), "term"),
            h("div", { className: "tt-vb__hbody" },
              h("div", { className: "tt-vb__hhead" },
                h(VerdictWord, { verdict: tv, short: true }),
                h(LaneBadge, { lane: "trader" }),
                data.trader.timing && h("span", { className: "tt-vb__timing" }, fmtTiming(data.trader.timing)),
              ),
              h("div", { className: "tt-vb__hline" }, shortLine),
            ),
          ),

          (play || data.investor) && h("div", { className: "tt-vb__horizon" },
            h("div", { className: "tt-vb__htag" }, "Long", h("br"), "term"),
            h("div", { className: "tt-vb__hbody" },
              h("div", { className: "tt-vb__hhead" },
                play
                  ? h("span", { className: "tt-vb__stage-word", style: { background: play.color + "22", color: play.color } }, play.label)
                  : h(VerdictWord, { verdict: iv, short: true }),
                h(LaneBadge, { lane: "investor" }),
                invScore !== null && h("span", { className: "tt-vb__timing", style: { color: "var(--ds-text-faint)" } }, "score " + invScore),
              ),
              longLine && h("div", { className: "tt-vb__hline" }, longLine),
            ),
          ),

          levels && h(GuideKeyLevels, { data: levels }),

          earlyEntry && h("div", { className: "tt-vb__callout tt-vb__callout--info" },
            h("strong", null, "Buying early: "),
            earlyEntry,
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

    function ReadySetupsSkeleton() {
      return h("div", { className: "tt-ready-scroll", "aria-hidden": "true" },
        [0, 1, 2, 3].map(function (i) {
          return h("div", { key: i, className: "tt-ready-skel" },
            h("div", { className: "tt-ready-skel__bar", style: { width: "58%", height: 15 } }),
            h("div", { className: "tt-ready-skel__bar", style: { width: "42%", height: 11 } }),
            h("div", { className: "tt-ready-skel__bar", style: { width: "100%", height: 11 } }),
            h("div", { className: "tt-ready-skel__bar", style: { width: "80%", height: 11 } }),
          );
        }),
      );
    }

    function ReadySetupsBoard(props) {
      var onSelect = props.onSelectTicker;
      var tickerData = props.tickerData;
      var _s = useState(null);
      var apiPack = _s[0];
      var setApiPack = _s[1];
      var _t = useState(false);
      var apiTried = _t[0];
      var setApiTried = _t[1];
      var hasTickerData = tickerData && typeof tickerData === "object" && Object.keys(tickerData).length > 0;
      useEffect(function () {
        if (!window._ttIsPro || hasTickerData) return;
        var alive = true;
        fetchVerdict({ cacheTtlMs: 120000 }).then(function (j) {
          if (alive) { setApiPack(j); setApiTried(true); }
        }).catch(function () { if (alive) setApiTried(true); });
        return function () { alive = false; };
      }, [hasTickerData]);
      var candidates = useMemo(function () {
        if (hasTickerData) return rankReadySetupsFromData(tickerData);
        return (apiPack && apiPack.candidates) || [];
      }, [hasTickerData, tickerData, apiPack]);
      // Loading = the source data hasn't resolved yet (parent /timed/all still
      // in flight AND our own verdict fetch hasn't returned). Show a skeleton
      // rather than a premature empty state.
      var loading = !hasTickerData && !apiTried;

      var headCopy = h("div", { className: "tt-ready__head" },
        h("div", { className: "tt-sec-title" }, "READY SETUPS"),
        h("h2", { className: "tt-ready__title" }, "What the model would act on"),
        h("p", { className: "tt-ready__sub" },
          embedded
            ? "Every name the model marks enter-ready or accumulate — scroll the strip."
            : "Every name the model marks enter-ready or accumulate — scroll the strip. Investor BUY cards use the same accumulate / buy-zone thesis as the Investor page brief.",
        ),
      );

      var wrap = function (children) {
        if (embedded) return h("div", { className: "tt-universe-panel__ready" }, children);
        return h("section", { className: "tt-ready" }, children);
      };

      if (!window._ttIsPro) {
        return wrap(h(React.Fragment, null,
          headCopy,
          h("div", { className: "tt-ready__locked" }, "Upgrade to Pro to see ranked setups the model would act on."),
        ));
      }
      if (loading) {
        return wrap(h(React.Fragment, null, headCopy, h(ReadySetupsSkeleton, null)));
      }
      if (candidates.length === 0) {
        return wrap(h(React.Fragment, null,
          headCopy,
          h("div", { className: "tt-ready__empty" }, "No entry or accumulate setups right now — the strip stays empty rather than forcing picks. Refreshes with each scoring pass."),
        ));
      }
      return wrap(h(React.Fragment, null,
        headCopy,
        h("div", { className: "tt-ready-scroll", role: "list" },
          candidates.map(function (row) {
            var sym = String(row.ticker || "").toUpperCase();
            var tv = row.trader || {};
            var lane = row.lane || tv.lane || "trader";
            var price = tv.price;
            var rank = row.rank != null ? row.rank : tv.rank;
            var verdictCls = tv.verdict === "BUY" ? "buy" : "forming";
            var railTab = "NOW";
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
              title: sym + " — open Now tab with lane guide",
              onClick: function () { if (onSelect) onSelect(sym, railTab); },
            },
              h("div", { className: "tt-ready-card__head" },
                h("span", { className: "tt-ready-card__sym" }, sym),
                h("span", { className: "tt-ready-word tt-ready-word--" + verdictCls },
                  h("span", { className: "tt-ready-word__dot" }),
                  verdictLabel(tv.verdict, true),
                ),
              ),
              h("div", { className: "tt-ready-card__chips" },
                h(LaneBadge, { lane: lane }),
                price != null && h("span", { className: "tt-ready-card__meta" },
                  fmtPx(price) + (rank != null ? " · rank " + rank : ""),
                ),
              ),
              h("p", { className: "tt-ready-card__why" }, tv.why || "—"),
              laneLine && h("div", { className: "tt-ready-card__lanes" }, laneLine),
            );
          }),
        ),
      ));
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
    // Upgrade to the full React-backed object whenever React is available and
    // the components are not yet registered. The guard checks a COMPONENT (not
    // just object presence) because the synchronous fallback below assigns a
    // components-less object first when this script runs during page parse —
    // the old `!window.TimedVerdictUI` guard then skipped register() entirely.
    if (window.React && (!window.TimedVerdictUI || !window.TimedVerdictUI.ReadySetupsBoard)) {
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
    inferInvestorVerdictFromTicker: inferInvestorVerdictFromTicker,
    buildVerdictGuide: buildVerdictGuide,
    rankReadySetupsFromData: rankReadySetupsFromData,
    LIFECYCLE_STEPS: LIFECYCLE_STEPS,
    register: register,
  };
})();

// cache-bust:1783306220400:392064129
