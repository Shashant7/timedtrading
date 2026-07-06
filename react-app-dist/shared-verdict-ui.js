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

    function buildGuideKeyLevels(trader, investor, payload, opts) {
      opts = opts || {};
      var pc = opts.predictionContract;
      var invData = opts.investorData;
      var numN = function (v) { if (v === null || v === undefined || v === "") return null; var n = Number(v); return Number.isFinite(n) ? n : null; };
      var px = numN(opts.livePrice || payload.price || payload._live_price);
      var rows = [];
      var stop = numN(trader && trader.stop);
      if (stop === null && pc && pc.risk) stop = numN(pc.risk.stop_loss);
      if (stop === null) stop = numN(payload.sl);
      var target = numN(trader && trader.target);
      if (target === null && pc && Array.isArray(pc.targets) && pc.targets[0]) target = numN(pc.targets[0].price);
      if (target === null) target = numN(payload.tp_trim || payload.tp_exit);
      var entry = numN(trader && trader.entry_price);
      if (Number.isFinite(px) && px > 0) {
        rows.push({ label: "Current price", price: px, tone: "accent", now: true });
      }
      if (entry !== null) rows.push({ label: "Entry trigger", price: entry, tone: "accent" });
      if (stop !== null) rows.push({ label: "Stop / invalidation", price: stop, tone: "dn" });
      if (target !== null) rows.push({ label: "First target", price: target, tone: "up" });
      var invZone = invData && (invData.accumulate_zone || invData.buy_zone || invData.zone);
      if (invZone) {
        var zLo = numN(invZone.low != null ? invZone.low : invZone.min);
        var zHi = numN(invZone.high != null ? invZone.high : invZone.max);
        if (zLo !== null && zHi !== null) {
          rows.push({ label: "Investor buy zone", range: fmtPx(zLo) + " – " + fmtPx(zHi), tone: "up" });
        }
      }
      if (pc && Array.isArray(pc.levels)) {
        var sup = pc.levels.filter(function (l) { return l.role === "support"; }).sort(function (a, b) { return b.price - a.price; }).slice(0, 2);
        var res = pc.levels.filter(function (l) { return l.role === "resistance"; }).sort(function (a, b) { return a.price - b.price; }).slice(0, 2);
        sup.forEach(function (l) {
          rows.push({ label: l.label || "Support", price: Number(l.price), tone: "up" });
        });
        res.forEach(function (l) {
          rows.push({ label: l.label || "Resistance", price: Number(l.price), tone: "dn" });
        });
      }
      return rows.length > 0 ? rows : null;
    }

    function GuideKeyLevels(props) {
      var rows = props.rows;
      if (!rows || !rows.length) return null;
      return h("div", { className: "tt-vb__key-levels" },
        h("div", { className: "tt-vb__key-levels-head" }, "Key levels"),
        h("div", { className: "tt-vb__key-levels-grid" },
          rows.map(function (r, i) {
            var priceCls = "tt-vb__kl-price" + (r.tone === "up" ? " tt-vb__kl-price--up" : r.tone === "dn" ? " tt-vb__kl-price--dn" : r.tone === "accent" ? " tt-vb__kl-price--accent" : "");
            return h("div", {
              key: (r.label || "row") + "-" + i,
              className: "tt-vb__kl-row" + (r.now ? " tt-vb__kl-row--now" : ""),
            },
              h("span", { className: "tt-vb__kl-label" }, r.label),
              h("span", { className: priceCls }, r.range || fmtPx(r.price)),
            );
          }),
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
      var levelRows = buildGuideKeyLevels(data.trader, data.investor, payload, {
        predictionContract: props.predictionContract,
        investorData: props.investorData,
        livePrice: props.livePrice,
      });
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
          h(GuideKeyLevels, { rows: levelRows }),
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
          "Every name the model marks enter-ready or accumulate — scroll the strip. Separate from the technical screener and Growth Ideas fundamentals below.",
        ),
      );

      if (!window._ttIsPro) {
        return h("section", { className: "tt-ready" },
          headCopy,
          h("div", { className: "tt-ready__locked" }, "Upgrade to Pro to see ranked setups the model would act on."),
        );
      }
      if (loading) {
        return h("section", { className: "tt-ready" }, headCopy, h(ReadySetupsSkeleton, null));
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

// cache-bust:1783295791477:968813632
