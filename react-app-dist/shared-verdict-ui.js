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
      ".tt-lane-badge{display:inline-flex;align-items:center;font-size:9.5px;font-weight:700;letter-spacing:.1em;padding:2px 7px;border-radius:4px;margin-left:8px}",
      ".tt-lane-badge--trader{background:rgba(96,165,250,.15);color:#60a5fa}",
      ".tt-lane-badge--investor{background:rgba(192,132,252,.15);color:#c084fc}",
      ".tt-lifecycle{display:flex;gap:4px;align-items:center;margin-top:5px;font-size:9px;letter-spacing:.08em;color:var(--ds-text-faint,#6b7280);flex-wrap:wrap}",
      ".tt-lc{padding:1px 6px;border-radius:3px;background:rgba(255,255,255,.04)}",
      ".tt-lc--on{background:rgba(20,184,166,.14);color:#14b8a6;font-weight:700}",
      ".tt-lc--done{color:var(--ds-text-muted,#9ca3af)}",
      ".tt-answers{border:1px solid var(--ds-stroke,rgba(255,255,255,.07));border-radius:14px;background:var(--ds-bg-surface,rgba(255,255,255,.022));margin-bottom:16px;overflow:hidden}",
      ".tt-answers__head{padding:13px 18px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}",
      ".tt-answers__head h2{font-size:14px;margin:0;font-weight:700}",
      ".tt-answers__meta{font-size:11px;color:var(--ds-text-faint,#6b7280)}",
      ".tt-answers__row{display:grid;grid-template-columns:110px 108px 1fr auto;gap:10px;align-items:center;padding:11px 18px;border-bottom:1px solid rgba(255,255,255,.04);cursor:pointer}",
      ".tt-answers__row:last-child{border-bottom:none}",
      ".tt-answers__row:hover{background:rgba(255,255,255,.02)}",
      ".tt-answers__sym{font-weight:800;font-size:14px}",
      ".tt-answers__sub{font-size:10.5px;color:var(--ds-text-faint,#6b7280);font-family:var(--tt-font-mono,ui-monospace,monospace)}",
      ".tt-answers__cta{font-size:11px;color:#14b8a6;white-space:nowrap;font-weight:600}",
      ".tt-answers__empty{padding:16px 18px;color:var(--ds-text-faint,#6b7280);font-size:12.5px;font-style:italic}",
      ".tt-answers__locked{padding:16px 18px;font-size:12.5px;color:var(--ds-text-muted,#9ca3af)}",
      ".tt-trust{display:flex;flex-wrap:wrap;gap:16px;align-items:center;padding:10px 16px;border:1px solid var(--ds-stroke,rgba(255,255,255,.07));border-radius:10px;background:rgba(255,255,255,.02);margin-bottom:16px;font-size:11.5px;color:var(--ds-text-muted,#9ca3af)}",
      ".tt-trust b{color:var(--ds-text-body,#e5e7eb);font-family:var(--tt-font-mono,ui-monospace,monospace)}",
      ".tt-trust__label{font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ds-text-faint,#6b7280)}",
    ].join("");
    document.head.appendChild(el);
  }

  function fetchVerdict(opts) {
    opts = opts || {};
    var ticker = opts.ticker ? String(opts.ticker).toUpperCase() : "";
    var limit = opts.limit || 5;
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

  function register(React) {
    if (!React) return null;
    ensureStyles();
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;

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
      return h("div", { className: "tt-vb" },
        h("div", { className: "tt-vb__inner" },
          data.trader && h(VerdictLaneRow, { verdict: data.trader, showEntry: true, shortVerdict: compact }),
          data.investor && h(VerdictLaneRow, { verdict: data.investor, shortVerdict: compact }),
        ),
        !compact && h("div", { className: "tt-vb__proof" },
          "Contract: GET /timed/verdict",
          h("span", { style: { color: "#14b8a6", cursor: "pointer" }, onClick: props.onExpandProof }, "Show proof ▾"),
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

    function TodaysAnswers(props) {
      var onSelect = props.onSelectTicker;
      var _s = useState(null);
      var pack = _s[0];
      var setPack = _s[1];
      useEffect(function () {
        if (!window._ttIsPro) return;
        var alive = true;
        fetchVerdict({ limit: 5, cacheTtlMs: 120000 }).then(function (j) {
          if (alive) setPack(j);
        }).catch(function () {});
        return function () { alive = false; };
      }, []);
      if (!window._ttIsPro) {
        return h("section", { className: "tt-answers" },
          h("div", { className: "tt-answers__head" },
            h("h2", null, "Today's answers"),
            h("span", { className: "tt-answers__meta" }, "Pro"),
          ),
          h("div", { className: "tt-answers__locked" }, "Upgrade to Pro to see ranked buy candidates from the model."),
        );
      }
      var candidates = (pack && pack.candidates) || [];
      var count = pack && pack.count != null ? pack.count : candidates.length;
      return h("section", { className: "tt-answers" },
        h("div", { className: "tt-answers__head" },
          h("h2", null, "Today's answers"),
          h("span", { className: "tt-answers__meta" },
            count + " actionable · Pro",
          ),
        ),
        candidates.length === 0
          ? h("div", { className: "tt-answers__empty" }, "Nothing qualifies right now — no filler picks. Next check in 5 minutes.")
          : candidates.map(function (row) {
              var sym = String(row.ticker || "").toUpperCase();
              var tv = row.trader || {};
              var price = tv.price;
              var rank = row.rank || tv.rank;
              var cta = tv.verdict === "BUY" ? "Open plan →" : "Watch setup →";
              return h("div", {
                key: sym,
                className: "tt-answers__row",
                role: "button",
                tabIndex: 0,
                onClick: function () { if (onSelect) onSelect(sym); },
                onKeyDown: function (e) { if (e.key === "Enter" && onSelect) onSelect(sym); },
              },
                h("div", null,
                  h("div", { className: "tt-answers__sym" }, sym),
                  h("div", { className: "tt-answers__sub" },
                    price != null ? fmtPx(price) : "—",
                    rank != null ? " · rank " + rank : "",
                  ),
                ),
                h("div", null,
                  h(VerdictWord, { verdict: tv.verdict, short: true }),
                  h(LaneBadge, { lane: "trader" }),
                ),
                h("div", { className: "tt-vb__why" }, tv.why || "—"),
                h("div", { className: "tt-answers__cta" }, cta),
              );
            }),
        candidates.length > 0 && h("div", { className: "tt-answers__empty", style: { borderTop: "1px solid rgba(255,255,255,.04)" } },
          "Nothing else qualifies right now — no filler picks.",
        ),
      );
    }

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
      LifecycleStrip: LifecycleStrip,
      TodaysAnswers: TodaysAnswers,
      TrustStrip: TrustStrip,
      useVerdict: useVerdict,
      fetchVerdict: fetchVerdict,
      verdictLabel: verdictLabel,
      verdictMeta: verdictMeta,
      lifecycleFromStage: lifecycleFromStage,
      inferTraderVerdictFromTicker: inferTraderVerdictFromTicker,
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
    LIFECYCLE_STEPS: LIFECYCLE_STEPS,
    register: register,
  };
})();

// cache-bust:1783274907384:747068672
