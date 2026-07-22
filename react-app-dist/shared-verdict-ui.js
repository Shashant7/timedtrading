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
      ".tt-vb--guide .tt-vb__inner{padding:16px 16px 14px}",
      /* 2026-07-22 model-first design uplevel: headline reads as the page
         lede; horizons render as distinct sub-cards with an accent spine so
         Short term vs Long term scan instantly. */
      ".tt-vb__guide-head{font-size:14.5px;font-weight:800;color:var(--ds-text-headline,#f4f5f7);margin-bottom:12px;line-height:1.4;letter-spacing:-.01em}",
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
      ".tt-vb__horizon{display:flex;gap:12px;align-items:flex-start;padding:11px 12px;border:1px solid rgba(255,255,255,.05);border-radius:10px;background:rgba(255,255,255,.02);margin-top:8px;border-left:3px solid rgba(96,165,250,.55)}",
      ".tt-vb__horizon:first-of-type{margin-top:0}",
      ".tt-vb__horizon--long{border-left-color:rgba(192,132,252,.55)}",
      ".tt-vb__htag{flex:0 0 46px;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ds-text-muted,#9ca3af);line-height:1.25;padding-top:4px}",
      ".tt-vb__hbody{flex:1;min-width:0}",
      ".tt-vb__hhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".tt-vb__hline{font-size:12px;color:var(--ds-text-muted,#9ca3af);line-height:1.5;margin-top:6px}",
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
      ".tt-universe-panel .tt-ready__sub{max-width:none}",
      ".tt-ready-scroll{display:flex;gap:10px;overflow-x:auto;padding:4px 2px 10px;scroll-snap-type:x proximity;scrollbar-width:thin;-webkit-overflow-scrolling:touch}",
      ".tt-ready-scroll::-webkit-scrollbar{height:6px}",
      ".tt-ready-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:999px}",
      /* Universal strip stack — Viewport lane card + foot row (Today Ready / Growth). */
      ".tt-strip-card{flex:0 0 280px;width:280px;max-width:280px;scroll-snap-align:start;display:flex;flex-direction:column;gap:6px;min-width:0}",
      ".tt-strip-card .ds-tickercard.tt-lane-card{width:100%!important;flex:0 0 auto;min-height:118px;height:auto;max-height:none}",
      ".tt-strip-card .ds-tickercard.tt-lane-card.tt-lane-card--active,.tt-strip-card .ds-tickercard.tt-lane-card.tt-lane-card--owned{--tt-lane-card-h:auto;--tt-lane-mid-h:auto}",
      ".tt-strip-card .tt-lane-card__main{flex:0 0 auto!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;align-items:flex-start}",
      ".tt-strip-card .tt-lane-card__mid{flex:0 0 auto!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;padding-top:4px}",
      ".tt-strip-card .tt-lane-card__chips{overflow:visible;max-height:none;height:auto;flex-wrap:wrap;gap:3px 4px;align-content:flex-start}",
      ".tt-strip-card .tt-lane-card__chips .ds-chip,.tt-strip-card .tt-lane-card__chips .tt-lane-badge{padding:1px 6px;font-size:9px;font-weight:700;letter-spacing:.04em;line-height:1.15;max-height:16px}",
      ".tt-strip-card .tt-lane-badge{margin-left:0;border-radius:999px;border:1px solid transparent}",
      ".tt-strip-card .tt-lane-badge--trader{background:rgba(96,165,250,.12);border-color:rgba(96,165,250,.28);color:#60a5fa}",
      ".tt-strip-card .tt-lane-badge--investor{background:rgba(192,132,252,.12);border-color:rgba(192,132,252,.28);color:#c084fc}",
      ".tt-strip-card__foot{display:flex;flex-direction:column;gap:4px;padding:6px 6px 2px;min-width:0;border-top:1px dashed rgba(255,255,255,.06)}",
      ".tt-strip-card__hint{margin:0;font-size:10.5px;line-height:1.4;color:var(--ds-text-muted,#9ca3af)}",
      ".tt-zone-bar{margin-top:2px}",
      ".tt-zone-bar + .tt-zone-bar{margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,255,255,.06)}",
      ".tt-zone-bar__lane-row{display:flex;align-items:center;gap:6px;font-family:var(--tt-font-mono,ui-monospace,monospace);font-size:8.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ds-text-faint,#6b7280);margin-bottom:3px}",
      ".tt-zone-bar__lane{padding:1px 5px;border-radius:4px;font-size:8px;letter-spacing:.06em}",
      ".tt-zone-bar__lane--trader{background:rgba(96,165,250,.15);color:#60a5fa}",
      ".tt-zone-bar__lane--investor{background:rgba(192,132,252,.15);color:#c084fc}",
      ".tt-zone-bar__meta{display:flex;flex-wrap:wrap;gap:4px 10px;font-family:var(--tt-font-mono,ui-monospace,monospace);font-size:9.5px;color:var(--ds-text-body,#e5e7eb);font-weight:600}",
      ".tt-zone-bar__meta--tagged{gap:4px 8px}",
      ".tt-zone-bar__prob{color:var(--ds-accent,#38f2a1);font-weight:700}",
      ".tt-ready-card__blocker{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#f59e0b;padding:2px 8px;border-radius:6px;border:1px solid rgba(245,158,11,.28);background:rgba(245,158,11,.08);align-self:flex-start}",
      ".tt-ready__empty{font-size:12.5px;color:var(--ds-text-faint,#6b7280);font-style:italic;padding:4px 2px 8px}",
      ".tt-ready__locked{font-size:12.5px;color:var(--ds-text-muted,#9ca3af);padding:4px 2px 8px}",
      ".tt-ready-skel{flex:0 0 280px;min-height:118px;padding:12px 14px;border-radius:var(--vf-radius-md,18px);background:var(--ds-bg-surface,rgba(255,255,255,.022));border:1px solid var(--ds-stroke,rgba(255,255,255,.07));display:flex;flex-direction:column;gap:10px}",
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
      var pn = Number(p);
      if (Number.isFinite(pn) && pn > 0) return pn;
    } catch (_) {}
    var n = Number(t && (t._live_price != null ? t._live_price : t.price != null ? t.price : t.close));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Build an INV / PB / TGT zone model for the TRADER lane from /timed/all
   * fields (sl, entry_ref, tp_trim). Returns null when the levels don't
   * form a coherent long ladder (INV < PX < TGT).
   */
  function buildTraderZoneModel(t, priceIn) {
    if (!t || typeof t !== "object") return null;
    var price = Number(priceIn) || headlinePrice(t);
    if (!(price > 0)) return null;
    var sl = Number(t.sl_dynamic || t.sl);
    var entryRef = Number(t.entry_ref || t.entry_price || t.entryPrice || price);
    var tp1 = Number(t.tp_trim || t.tp);
    var tp2 = Number(t.tp_exit);
    var runner = Number(t.tp_runner || t.tp_target_price);
    // Long-only zones for now (Ready Setups skews LONG).
    if (!(sl > 0) || sl >= price) return null;
    var target = null;
    if (tp1 > price) target = tp1;
    else if (tp2 > price) target = tp2;
    else if (runner > price) target = runner;
    if (!(target > price)) return null;
    // Pullback band: between SL and current entry_ref (or a ~40% slice from INV).
    var pbLo = entryRef > sl && entryRef < price ? entryRef : sl + (price - sl) * 0.55;
    var pbHi = entryRef > pbLo && entryRef <= price ? Math.max(entryRef, price) : price;
    if (pbLo <= sl) pbLo = sl + (price - sl) * 0.55;
    if (pbHi <= pbLo) pbHi = price;
    var span = target - sl;
    if (!(span > 0)) return null;
    var pad = span * 0.04;
    var minPx = sl - pad;
    var maxPx = target + pad;
    var pct = function (px) { return Math.max(0, Math.min(100, ((px - minPx) / (maxPx - minPx)) * 100)); };
    return {
      inv: sl, pb: [pbLo, pbHi], tgt: target,
      price: price, minPx: minPx, maxPx: maxPx, pct: pct,
      lane: "trader",
      subLabels: {
        tgtDetail: (tp2 && tp2 > tp1) ? "TP1 " + fmtPx(tp1) : null,
      },
    };
  }

  /**
   * Build an INV / PB / TGT zone model for the INVESTOR lane. Uses:
   *  - `t._fair_value.fair_value` as the target (or a modest premium above)
   *  - A conservative pullback band derived from fair value distance
   *  - A structural invalidation floor: prefers `t.primary_invalidation_price`
   *    / `t.thesisInvalidationPrice`, else a fair-value-anchored discount.
   * Falls back to null when there is nothing coherent (e.g. missing FV).
   */
  function buildInvestorZoneModel(t, priceIn) {
    if (!t || typeof t !== "object") return null;
    var price = Number(priceIn) || headlinePrice(t);
    if (!(price > 0)) return null;
    var fv = Number(t._fair_value && t._fair_value.fair_value) || Number(t.fair_value_price);
    var inv = Number(t.primary_invalidation_price || t.thesisInvalidationPrice || t.primaryInvalidation && t.primaryInvalidation.price);
    // Target: fair value if above price, otherwise a modest 10% premium.
    var tgt = null;
    if (fv > price) tgt = fv;
    else if (fv > 0) tgt = price * 1.10;
    else tgt = price * 1.12;
    // Invalidation: use structural floor if present, else 12% risk anchor.
    if (!(inv > 0) || inv >= price) inv = price * 0.88;
    var span = tgt - inv;
    if (!(span > 0)) return null;
    // Add-on band: slice of the inv→target span (not % below live price, so a
    // trending name can sit above the band while a pullback can enter it).
    var pbLo = inv + span * 0.28;
    var pbHi = inv + span * 0.52;
    if (pbLo <= inv) pbLo = inv + span * 0.22;
    if (pbHi <= pbLo) pbHi = pbLo + span * 0.12;
    if (pbHi > tgt) pbHi = tgt * 0.98;
    if (pbLo >= pbHi) {
      pbLo = price * 0.94;
      pbHi = price * 0.98;
    }
    var pad = span * 0.04;
    var minPx = inv - pad;
    var maxPx = tgt + pad;
    var pct = function (px) { return Math.max(0, Math.min(100, ((px - minPx) / (maxPx - minPx)) * 100)); };
    return {
      inv: inv, pb: [pbLo, pbHi], tgt: tgt,
      price: price, minPx: minPx, maxPx: maxPx, pct: pct,
      lane: "investor",
      subLabels: {
        tgtDetail: (fv > price) ? "Fair value" : "10% premium target",
      },
    };
  }

  /** Normalize CTO feed row or /timed/cto/ticker payload for zone probabilities. */
  function normalizeCtoFeedItem(raw) {
    if (!raw || typeof raw !== "object") return null;
    var sym = String(raw.ticker || "").toUpperCase();
    if (!sym) return null;
    var up = raw.top_upside;
    var dn = raw.top_downside;
    if (Array.isArray(up)) up = up[0];
    if (Array.isArray(dn)) dn = dn[0];
    return {
      ticker: sym,
      top_upside: up ? {
        price: up.price,
        adj_prob: up.adj_prob != null ? up.adj_prob : up.regime_adjusted_prob,
      } : null,
      top_downside: dn ? {
        price: dn.price,
        adj_prob: dn.adj_prob != null ? dn.adj_prob : dn.regime_adjusted_prob,
      } : null,
    };
  }

  /** Attach CTO invalidation/target hit probabilities to a zone bar model. */
  function attachCtoProbToZone(zm, ctoItem) {
    if (!zm) return zm;
    var norm = normalizeCtoFeedItem(ctoItem);
    if (!norm) return zm;
    var invProb = Number(norm.top_downside && norm.top_downside.adj_prob);
    var tgtProb = Number(norm.top_upside && norm.top_upside.adj_prob);
    if (!Number.isFinite(invProb) && !Number.isFinite(tgtProb)) return zm;
    var out = Object.assign({}, zm);
    if (Number.isFinite(invProb)) out.invProb = invProb;
    if (Number.isFinite(tgtProb)) out.tgtProb = tgtProb;
    return out;
  }

  /** Load CTO map for strip cards — bulk feed plus per-ticker backfill for gaps. */
  function fetchCtoMapForSymbols(symbols) {
    var uniq = [];
    (symbols || []).forEach(function (s) {
      var u = String(s || "").toUpperCase();
      if (u && uniq.indexOf(u) < 0) uniq.push(u);
    });
    if (!uniq.length) return Promise.resolve({});
    var feedUrl = API_BASE + "/timed/cto/feed?limit=120";
    var fetchFeed = window.TTFetchCache && window.TTFetchCache.get
      ? window.TTFetchCache.get(feedUrl, {
          ttlMs: 5 * 60 * 1000,
          maxAgeMs: 30 * 60 * 1000,
          fetchOpts: { credentials: "include" },
        })
      : fetch(feedUrl, { credentials: "include" }).then(function (r) { return r.json(); });
    return fetchFeed.then(function (j) {
      var map = {};
      if (j && j.ok && Array.isArray(j.items)) {
        j.items.forEach(function (it) {
          var n = normalizeCtoFeedItem(it);
          if (n) map[n.ticker] = n;
        });
      }
      var missing = uniq.filter(function (s) { return !map[s]; });
      if (!missing.length) return map;
      return Promise.all(missing.slice(0, 16).map(function (sym) {
        var u = API_BASE + "/timed/cto/ticker?ticker=" + encodeURIComponent(sym);
        return fetch(u, { credentials: "include" })
          .then(function (r) { return r.json(); })
          .then(function (p) {
            var n = normalizeCtoFeedItem(p);
            if (n) map[n.ticker] = n;
          })
          .catch(function () {});
      })).then(function () { return map; });
    }).catch(function () { return {}; });
  }

  /** Pullback band bounds — prefer live accumZone, else the card planning band. */
  function resolveInvestorPbBounds(t, price, investorZone) {
    var az = t && (t.accumZone || t.investor_accum_zone);
    var zLo = numN(az && (az.zoneBottom != null ? az.zoneBottom : az.low != null ? az.low : az.min));
    var zHi = numN(az && (az.zoneTop != null ? az.zoneTop : az.high != null ? az.high : az.max));
    if (zLo != null && zHi != null && zHi > zLo) return { lo: zLo, hi: zHi, source: "accumZone" };
    if (investorZone && investorZone.pb && investorZone.pb.length >= 2) {
      return { lo: investorZone.pb[0], hi: investorZone.pb[1], source: "plan" };
    }
    return null;
  }

  /** True when price sits in the live investor buy zone (not just accumulate thesis). */
  function isInvestorLiveBuyZone(t, price) {
    if (!(price > 0)) return false;
    var az = t && (t.accumZone || t.investor_accum_zone);
    if (az && az.inZone === true) return true;
    var zLo = numN(az && (az.zoneBottom != null ? az.zoneBottom : az.low != null ? az.low : az.min));
    var zHi = numN(az && (az.zoneTop != null ? az.zoneTop : az.high != null ? az.high : az.max));
    if (zLo != null && zHi != null && price >= zLo && price <= zHi) return true;
    return false;
  }

  /**
   * Ready Setup card headline — avoids a bare "BUY" when price is above the
   * add-on band. Trader entry → BUY NOW; investor in live zone → BUY;
   * in PB band → SCALE IN; above PB → ACCUMULATE; queued → QUEUED.
   */
  function resolveReadySetupCardDisplay(row, tickerRow) {
    row = row || {};
    tickerRow = tickerRow || {};
    var tv = row.trader || {};
    var price = row.price;
    var invStage = String(row.invStage || tickerRow.investor_stage || tickerRow.investorStage || "").toLowerCase();

    if (row.traderPrimed) {
      return {
        label: "BUY NOW",
        cls: "buy",
        hint: row.investorPrimed
          ? "Trader entry live; investor lane also active."
          : "Trader entry live — size to the stop.",
        title: "Trader entry lane is active" + (tv.why ? " (" + tv.why + ")." : "."),
      };
    }

    if (row.investorPrimed) {
      if (invStage === "accumulate_queued" || row.blocker === "Next rebalance") {
        return {
          label: "QUEUED",
          cls: "queued",
          hint: "Waits for the next rebalance inside the buy zone.",
          title: "Execution-ready but queued for the next investor rebalance.",
        };
      }
      if (isInvestorLiveBuyZone(tickerRow, price)) {
        return {
          label: "BUY",
          cls: "buy",
          hint: "Live buy zone — scale in per model rules.",
          title: "Price is in the investor buy zone; the model may add on rebalance.",
        };
      }
      var pb = resolveInvestorPbBounds(tickerRow, price, row.investorZone);
      if (pb && price > pb.hi) {
        return {
          label: "ACCUMULATE",
          cls: "accumulate",
          hint: "Thesis active — add on dips into the PB band, not at extension.",
          title: "High-conviction accumulate name. Do not chase — wait for a pullback into the green PB band.",
        };
      }
      if (pb && price >= pb.lo && price <= pb.hi) {
        return {
          label: "SCALE IN",
          cls: "accumulate",
          hint: "Inside the add-on band — scale in with capped size.",
          title: "Price is inside the planned pullback band; scale in with invalidation below Inv.",
        };
      }
      return {
        label: "ACCUMULATE",
        cls: "accumulate",
        hint: "Scale in on pullbacks — do not chase extension.",
        title: "Investor accumulate thesis — add on dips, not at extension.",
      };
    }

    var verdict = String(tv.verdict || "WAIT").toUpperCase();
    if (verdict === "SETUP_FORMING") {
      return {
        label: "FORMING",
        cls: "forming",
        hint: "Wait for the trigger to confirm.",
        title: tv.why || "Setup forming.",
      };
    }
    return {
      label: verdictLabel(verdict, true),
      cls: verdict === "BUY" ? "buy" : "forming",
      hint: tv.why || null,
      title: tv.why || verdict,
    };
  }

  function verdictChipClass(cls) {
    if (cls === "buy") return "ds-chip--up";
    if (cls === "queued") return "ds-chip--accent";
    if (cls === "accumulate") return "ds-chip--accent";
    if (cls === "forming") return "ds-chip--solid";
    return "ds-chip--solid";
  }

  /** Rank actionable setups from the live /timed/all map — curated, confluence-weighted. */
  function rankReadySetupsFromData(data, limit) {
    var rows = [];
    if (!data || typeof data !== "object") return rows;
    var HARD_LIMIT = (limit != null && limit > 0) ? limit : 10;

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
      var flags = (t && t.flags) || {};
      var traderVerdict = inferTraderVerdictFromTicker(t, null);
      var investorVerdict = inferInvestorVerdictFromTicker(t);

      // Eligibility — the model would ACT on this now if capacity allowed.
      // Trader lane: an actual entry lane (in_review is too broad — belongs in Technical Setups).
      // Investor lane: buy-zone execute (accumulate) OR queued for next rebalance.
      var traderPrimed = stage === "enter" || stage === "enter_now" || stage === "just_flipped";
      var investorPrimed = false;
      var invRow = null;
      if (invStage === "accumulate" || invStage === "accumulate_queued") {
        invRow = (window.TimedRailHelpers && window.TimedRailHelpers.normalizeInvestorScoreRow)
          ? window.TimedRailHelpers.normalizeInvestorScoreRow(t, key)
          : { stage: invStage, investor_stage: invStage, score: t.investor_score };
        // Filter out recently exited names on either stage; the accumulate-only
        // buy-zone thesis is skipped for accumulate_queued (queued already
        // qualified but is waiting on rebalance capacity).
        var recentlyExited = !!(invRow && invRow.recentlyExited);
        if (recentlyExited) {
          investorPrimed = false;
        } else if (invStage === "accumulate") {
          if (window.TimedRailHelpers && window.TimedRailHelpers.isInvestorBuyZoneThesis) {
            investorPrimed = window.TimedRailHelpers.isInvestorBuyZoneThesis(invRow, key);
          } else {
            investorPrimed = true;
          }
        } else {
          investorPrimed = true;
        }
      }
      if (!traderPrimed && !investorPrimed) return;

      // Confluence — count NON-technical factors that raise this into "worth acting".
      var confluence = [];
      var conflScore = 0;
      if (flags.momentum_elite) { confluence.push({ label: "Momentum Elite", weight: 30 }); conflScore += 30; }
      if (flags.thesis_match) { confluence.push({ label: "Thesis Match", weight: 25 }); conflScore += 25; }
      var themeTilt = Number(t._theme_tilt);
      if (Number.isFinite(themeTilt) && themeTilt >= 2) {
        confluence.push({ label: "Theme Hot", weight: 22 });
        conflScore += 22;
      }
      var sectorState = t.market_internals && t.market_internals.sector_rotation && t.market_internals.sector_rotation.state;
      if (sectorState === "risk_on") { confluence.push({ label: "Risk-On", weight: 15 }); conflScore += 15; }
      var invScore = Number(t.investor_score);
      if (Number.isFinite(invScore) && invScore >= 70) {
        conflScore += 20;
      }
      var tierLabel = String(t.tier_label || "").toUpperCase();
      if (tierLabel === "COMPOUND CORE" || tierLabel === "COMPOUND_CORE") {
        confluence.push({ label: "Compound Core", weight: 20 });
        conflScore += 20;
      }
      if (rankNum != null && rankNum <= 20) {
        conflScore += 20;
      } else if (rankNum != null && rankNum <= 50) {
        conflScore += 10;
      }
      if (flags.sq30_release) { confluence.push({ label: "Squeeze Release", weight: 15 }); conflScore += 15; }
      if (journey && journey.direction === "improving") { confluence.push({ label: "Improving", weight: 10 }); conflScore += 10; }

      // Base score — trigger imminence.
      var baseScore = 0;
      if (stage === "enter_now" || stage === "just_flipped") baseScore = 120;
      else if (stage === "enter") baseScore = 100;
      else if (invStage === "accumulate") baseScore = 80;
      else if (invStage === "accumulate_queued") baseScore = 60;

      var score = baseScore + conflScore;

      // Blocker — what's holding the model back from just doing it?
      var blocker = null;
      if (flags.portfolio_no_cash) blocker = "Waiting for capital";
      else if (invStage === "accumulate_queued") blocker = "Next rebalance";
      else if (flags.pre_earnings_block || flags.pre_earnings) blocker = "Pre-earnings window";
      else if (sectorState === "risk_off") blocker = "Sector risk-off";

      // Trader verdict — prefer entry-lane verbiage; else fall back to inference.
      var tv;
      if (traderPrimed) {
        tv = {
          lane: "trader", verdict: "BUY", timing: "now",
          why: "entry lane (" + stage + ")",
          price: price, rank: rankNum,
        };
      } else if (invRow) {
        tv = investorVerdict || {
          lane: "investor", verdict: "BUY", timing: "scale in",
          why: "accumulate zone" + (t.investor_score != null ? ", score " + t.investor_score : ""),
        };
        tv.price = price;
        tv.rank = rankNum;
      } else {
        tv = traderVerdict || { lane: "trader", verdict: "SETUP_FORMING", timing: "on confirmation", why: "trigger ready", price: price, rank: rankNum };
      }

      // Attach zone models per active lane so the card can render a
      // Growth Ideas-style INV/PB/TGT bar for each lane the model has primed.
      var traderZone = traderPrimed ? buildTraderZoneModel(t, price) : null;
      var investorZone = investorPrimed ? buildInvestorZoneModel(t, price) : null;
      var isFinite = function (n) { return Number.isFinite(Number(n)); };
      var dayPct = null;
      try {
        var utils = window.TimedPriceUtils;
        if (utils && typeof utils.getDailyChange === "function") {
          var dc = utils.getDailyChange(t);
          if (isFinite(dc && dc.dayPct)) dayPct = Number(dc.dayPct);
        }
      } catch (_) { /* best effort */ }
      if (dayPct === null && isFinite(t.dailyChgPct)) dayPct = Number(t.dailyChgPct);

      rows.push({
        ticker: key,
        rank: rankNum,
        lane: traderPrimed ? "trader" : "investor",
        trader: tv,
        traderVerdict: traderVerdict,
        investorVerdict: investorVerdict,
        confluence: confluence.slice(0, 5),
        blocker: blocker,
        score: score,
        price: price,
        dayPct: dayPct,
        companyName: t.companyName || t.name || null,
        traderPrimed: !!traderPrimed,
        investorPrimed: !!investorPrimed,
        invStage: invStage,
        accumZone: t.accumZone || t.investor_accum_zone || null,
        traderZone: traderZone,
        investorZone: investorZone,
        display: resolveReadySetupCardDisplay({
          ticker: key,
          rank: rankNum,
          lane: traderPrimed ? "trader" : "investor",
          trader: tv,
          blocker: blocker,
          price: price,
          traderPrimed: !!traderPrimed,
          investorPrimed: !!investorPrimed,
          invStage: invStage,
          investorZone: investorZone,
        }, t),
      });
    });

    rows.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    return rows.slice(0, HARD_LIMIT);
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
      accumulate_queued: { label: "Queued", color: "#34d399", line: "Execution-ready — the model waits for the next rebalance to enter inside the buy zone." },
      accumulate_entered: { label: "Entered", color: "#22c55e", line: "The model opened or added on a prior rebalance — hold and add only on pullbacks." },
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
        // Side gates need a live anchor — skip wrong-side levels until price loads.
        if (px === null && side) return;
        if (px !== null && side === "below" && p >= px) return;
        if (px !== null && side === "above" && p <= px) return;
        var key = p.toFixed(2);
        if (seen[key]) return;
        seen[key] = 1;
        rows.push({ label: label, price: p, tone: tone });
      }
      // OPEN-POSITION stop — the committed risk line of the live trade
      // (payload.position_sl, stamped by the worker while a trader position
      // is open). 2026-07-22 operator ask: "The Key Levels should also
      // include the Trader Stop Loss." Added FIRST so if the verdict stop
      // matches the same price, the dedupe keeps this clearer label. No side
      // gate — an already-breached stop is still critical context.
      add("Position stop (active trade)", payload.position_sl, "dn", null);
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
        if (zHi !== null && zLo !== null && zHi > 0 && zLo > 0) {
          var zKey = zLo.toFixed(2) + "-" + zHi.toFixed(2);
          if (!seen[zKey]) {
            seen[zKey] = 1;
            rows.push({ label: "Investor buy zone", range: fmtPx(zLo) + " – " + fmtPx(zHi), _sort: (zLo + zHi) / 2, tone: "up" });
          }
        }
        add("Fair value estimate", fv, "warn", null);
        // Keep invalidation visible even after a breach — it is thesis context, not a directional gate.
        add("Investor invalidation", invPrice, "dn", null);
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

      // Long-term (investor) horizon — resolve to the kanban lane the Investor
      // page shows so an UNOWNED watch/core_hold demotes to On Radar (matches
      // resolveInvestorKanbanStage in shared-rail-helpers / investor-panel).
      var invStage = String((props.investorData && props.investorData.stage) || payload.investor_stage || payload.investorStage || "").toLowerCase();
      var invOwned = !!(props.investorData && props.investorData.position && props.investorData.position.owned);
      if (window.TimedRailHelpers && window.TimedRailHelpers.resolveInvestorKanbanStage) {
        var kanbanRow = props.investorData || { stage: invStage };
        var kanbanStage = window.TimedRailHelpers.resolveInvestorKanbanStage(kanbanRow);
        if (kanbanStage) invStage = kanbanStage;
      } else if (!invOwned) {
        if (invStage === "watch" || invStage === "core_hold") invStage = "research_on_watch";
        else if (invStage === "reduce") invStage = "research_low";
      }
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
      if (iv === "BUY" && (tv === "WAIT" || tv === "SETUP_FORMING") && invFloor !== null && px > 0 && invFloor < px) {
        earlyEntry = "Accumulating ahead of the model is only reasonable inside the buy zone with capped size — the long-term thesis breaks on a close below " + fmtPx(invFloor) + ".";
      }

      return h("div", { className: "tt-vb tt-vb--guide" },
        h("div", { className: "tt-vb__inner" },
          h("div", { className: "tt-vb__guide-head" }, guide.headline),

          /* 2026-07-22 model-first: lane badges (TRADER / INVESTOR) removed —
             the horizon tag already says Short term / Long term and the
             operator wants the trader-vs-investor split under the surface. */
          data.trader && h("div", { className: "tt-vb__horizon" },
            h("div", { className: "tt-vb__htag" }, "Short", h("br"), "term"),
            h("div", { className: "tt-vb__hbody" },
              h("div", { className: "tt-vb__hhead" },
                h(VerdictWord, { verdict: tv, short: true }),
                data.trader.timing && h("span", { className: "tt-vb__timing" }, fmtTiming(data.trader.timing)),
              ),
              h("div", { className: "tt-vb__hline" }, shortLine),
            ),
          ),

          (play || data.investor) && h("div", { className: "tt-vb__horizon tt-vb__horizon--long" },
            h("div", { className: "tt-vb__htag" }, "Long", h("br"), "term"),
            h("div", { className: "tt-vb__hbody" },
              h("div", { className: "tt-vb__hhead" },
                play
                  ? h("span", { className: "tt-vb__stage-word", style: { background: play.color + "22", color: play.color } }, play.label)
                  : h(VerdictWord, { verdict: iv, short: true }),
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
      var embedded = !!props.embedded;
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
      var _cto = useState({});
      var ctoBySym = _cto[0];
      var setCtoBySym = _cto[1];
      useEffect(function () {
        if (!window._ttIsPro || !candidates.length) return;
        var alive = true;
        var syms = candidates.map(function (r) { return String(r.ticker || "").toUpperCase(); });
        fetchCtoMapForSymbols(syms).then(function (m) {
          if (alive) setCtoBySym(m || {});
        }).catch(function () {});
        return function () { alive = false; };
      }, [candidates]);
      // Loading = the source data hasn't resolved yet (parent /timed/all still
      // in flight AND our own verdict fetch hasn't returned). Show a skeleton
      // rather than a premature empty state.
      var loading = !hasTickerData && !apiTried;

      var headCopy = h("div", { className: "tt-ready__head" },
        h("div", { className: "tt-sec-title" }, "READY SETUPS"),
        h("h2", { className: "tt-ready__title" }, "What the model would act on today"),
        h("p", { className: "tt-ready__sub" },
          embedded
            ? "Top 10 primed names — technical trigger plus sector, fundamentals, and momentum confluence. Zone labels (ACCUMULATE, SCALE IN, BUY) reflect positioning, not market orders."
            : "Top 10 primed names — technical trigger plus sector / fundamentals / momentum confluence. Labels reflect lane + zone: BUY NOW (trader entry), BUY (live buy zone), SCALE IN / ACCUMULATE (investor thesis — add on dips, not chase).",
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
          h("div", { className: "tt-ready__empty" }, "No high-confluence setups yet — the strip stays empty rather than forcing picks. Broaden the search using Technical Setups below."),
        ));
      }
      var savedSet = props.savedSet;
      var onToggleSaved = props.onToggleSaved;
      var sparkCache = props.sparkCache || null;
      var ensureSpark = props.ensureSpark || null;
      var tickerData = props.tickerData || null;
      var LaneCard = window.TTLaneCard;
      return wrap(h(React.Fragment, null,
        headCopy,
        h("div", { className: "tt-ready-scroll tt-opp-scroll", role: "list" },
          candidates.map(function (row) {
            var sym = String(row.ticker || "").toUpperCase();
            var tv = row.trader || {};
            var lane = row.lane || tv.lane || "trader";
            var tRow = (tickerData && tickerData[sym]) || {};
            var price = row.price != null ? row.price : tv.price;
            var rank = row.rank != null ? row.rank : tv.rank;
            var disp = row.display || resolveReadySetupCardDisplay(row, tRow);
            var railTab = "NOW";
            var confluence = Array.isArray(row.confluence) ? row.confluence : [];
            var isSaved = savedSet instanceof Set ? savedSet.has(sym) : false;
            var dayPct = Number.isFinite(row.dayPct) ? Number(row.dayPct) : null;
            var dayChg = null;
            try {
              var utils = window.TimedPriceUtils;
              if (utils && typeof utils.getDailyChange === "function") {
                var dc = utils.getDailyChange(tRow);
                if (Number.isFinite(dc && dc.dayChg)) dayChg = Number(dc.dayChg);
                if (dayPct === null && Number.isFinite(dc && dc.dayPct)) dayPct = Number(dc.dayPct);
              }
            } catch (_) { /* best effort */ }
            var dir = dayPct == null || Math.abs(dayPct) < 0.05
              ? "flat"
              : dayPct > 0 ? "up" : "dn";
            var laneNames = [];
            if (row.traderPrimed) laneNames.push("trader");
            if (row.investorPrimed) laneNames.push("investor");
            if (laneNames.length === 0) laneNames.push(lane);
            var zones = [];
            if (row.traderZone) zones.push(row.traderZone);
            if (row.investorZone) zones.push(row.investorZone);
            var primaryZone = null;
            if (row.traderPrimed && row.traderZone) primaryZone = row.traderZone;
            else if (row.investorPrimed && row.investorZone) primaryZone = row.investorZone;
            else if (zones.length) primaryZone = zones[0];
            var extLine = LaneCard && LaneCard.extLineFromTicker ? LaneCard.extLineFromTicker(tRow) : null;
            var sparkSvg = LaneCard && LaneCard.sparkSvgFromCache
              ? LaneCard.sparkSvgFromCache(sym, Number(price), dir, sparkCache, ensureSpark)
              : "";

            var chipRow = [
              h("span", {
                key: "verdict",
                className: "ds-chip ds-chip--sm " + verdictChipClass(disp.cls),
                style: { fontFamily: "var(--tt-font-mono)" },
                title: disp.title || "TT lane verdict",
              }, disp.label),
            ];
            laneNames.forEach(function (l, i) {
              chipRow.push(h(LaneBadge, { key: "lane-" + l + "-" + i, lane: l }));
            });
            confluence.slice(0, 1).forEach(function (c) {
              chipRow.push(h("span", {
                key: "conf-" + c.label,
                className: "ds-chip ds-chip--sm",
                title: "Confluence factor",
              }, c.label));
            });

            var metrics = LaneCard && LaneCard.rankScoreMetricChips
              ? LaneCard.rankScoreMetricChips({
                  rank: rank,
                  score: Number.isFinite(Number(row.score)) ? Math.round(Number(row.score)) : null,
                  rankTitle: rank != null ? ("Ready rank " + rank + " — model shortlist for capital") : null,
                  scoreTitle: "Ready-setup confluence score",
                })
              : [];

            var midBody = primaryZone && LaneCard && LaneCard.zoneBarTrack
              ? LaneCard.zoneBarTrack(primaryZone, {
                  compact: true,
                  trackTitle: primaryZone.lane === "investor"
                    ? "Investor lane — invalidation floor, add-on-pullback zone, and target."
                    : "Trader plan — stop, pullback / entry zone, and first TP target.",
                })
              : null;

            var footEls = [];
            if (disp.hint) footEls.push(h("p", { key: "hint", className: "tt-strip-card__hint" }, disp.hint));
            if (row.blocker) footEls.push(h("div", { key: "blocker", className: "tt-ready-card__blocker" }, row.blocker));
            if (LaneCard && LaneCard.zoneBarMeta) {
              var tagLanes = zones.length > 1;
              var ctoItem = ctoBySym[sym];
              zones.forEach(function (zm, idx) {
                footEls.push(h(React.Fragment, { key: "meta-" + zm.lane + "-" + idx },
                  LaneCard.zoneBarMeta(attachCtoProbToZone(zm, ctoItem), { laneTag: tagLanes }),
                ));
              });
            }

            if (LaneCard && typeof LaneCard.create === "function") {
              return h("div", { key: sym + "-" + lane, className: "tt-strip-card", role: "listitem" },
                LaneCard.create({
                  sym: sym,
                  button: {
                    onClick: function () { if (onSelect) onSelect(sym, railTab); },
                    title: sym + " — open Now tab with lane guide",
                    style: { textAlign: "left", padding: "var(--ds-space-3)" },
                  },
                  chipRow: chipRow,
                  quote: {
                    price: Number.isFinite(Number(price)) ? Number(price) : null,
                    dayPct: dayPct,
                    dayChg: dayChg,
                    dir: dir,
                    extLine: extLine,
                  },
                  sparkSvg: sparkSvg,
                  midBody: midBody,
                  metrics: metrics,
                  isSaved: isSaved,
                  onToggleSaved: onToggleSaved,
                }),
                footEls.length > 0 && h("div", { className: "tt-strip-card__foot" }, footEls),
              );
            }

            return h("button", {
              key: sym + "-" + lane,
              type: "button",
              className: "tt-ready-card",
              role: "listitem",
              onClick: function () { if (onSelect) onSelect(sym, railTab); },
            },
              h("div", null, sym),
              h("span", null, disp.label),
              disp.hint && h("p", { className: "tt-strip-card__hint" }, disp.hint),
              price != null && h("div", null, fmtPx(price)),
            );
          }),
        ),
      ));
    }

    // Legacy zone bar export — prefer TTLaneCard.zoneBarTrack / zoneBarMeta.
    function ReadyZoneBar(props) {
      var LaneCard = window.TTLaneCard;
      if (LaneCard && LaneCard.zoneBarTrack) {
        return h(React.Fragment, null,
          LaneCard.zoneBarTrack(props.zone),
          LaneCard.zoneBarMeta(props.zone),
        );
      }
      return null;
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
      resolveReadySetupCardDisplay: resolveReadySetupCardDisplay,
      attachCtoProbToZone: attachCtoProbToZone,
      buildInvestorZoneModel: buildInvestorZoneModel,
      fetchCtoMapForSymbols: fetchCtoMapForSymbols,
      normalizeCtoFeedItem: normalizeCtoFeedItem,
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
    resolveReadySetupCardDisplay: resolveReadySetupCardDisplay,
    buildInvestorZoneModel: buildInvestorZoneModel,
    attachCtoProbToZone: attachCtoProbToZone,
    LIFECYCLE_STEPS: LIFECYCLE_STEPS,
    register: register,
  };
})();

// cache-bust:1784753136177:241306926
