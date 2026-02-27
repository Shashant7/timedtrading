/**
 * Investor Panel — inline component for main dashboard (replaces iframe embed).
 * Fetches /timed/investor/scores, market-health; renders Action Kanban lanes.
 */
(function () {
  if (typeof React === "undefined") return;
  const { useState, useEffect, useCallback, useMemo, useRef } = React;
  const getDailyChange = window.TimedPriceUtils?.getDailyChange || (() => ({ dayPct: null, dayChg: null }));

  function ScoreBar({ score, max, color }) {
    const pct = Math.max(0, Math.min(100, ((score || 0) / (max || 100)) * 100));
    return React.createElement("div", { className: "w-full h-1.5 rounded-full bg-white/[0.06] overflow-hidden" },
      React.createElement("div", { style: { width: `${pct}%`, background: color || "#3b82f6" }, className: "h-full rounded-full transition-all duration-500" })
    );
  }

  function RegimeBadge({ regime }) {
    const colors = { RISK_ON: "text-[#00e676] bg-[#00c853]/10 border-[#00c853]/25", CAUTIOUS: "text-amber-400 bg-amber-500/10 border-amber-500/25", RISK_OFF: "text-red-400 bg-red-500/10 border-red-500/25" };
    const friendly = { RISK_ON: "Bullish", CAUTIOUS: "Cautious", RISK_OFF: "Bearish" };
    return React.createElement("span", { className: `px-2 py-0.5 rounded-md text-[11px] font-semibold border ${colors[regime] || colors.CAUTIOUS}`, title: regime }, friendly[regime] || regime);
  }

  function InvestorCard({ t, onSelect, selectedTicker, savedTickers, toggleSavedTicker }) {
    const SparklineBg = window.TimedSparkline;
    const sym = String(t?.ticker || "").toUpperCase();
    const stage = t.stage || "research_avoid";
    const score = Number(t.score) || 0;
    const scoreCls = score >= 70 ? "text-[#00e676]" : score >= 50 ? "text-amber-400" : "text-red-400";
    const _dc = getDailyChange(t);
    const dayPct = _dc?.dayPct;
    const dayChg = _dc?.dayChg;
    const price = t.price != null && Number.isFinite(t.price) ? t.price : null;
    const isSelected = selectedTicker === sym;
    const glassBg = "rgba(10,16,28,0.45)";
    const cardBgImage = [
      "linear-gradient(170deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 25%, transparent 55%)",
      "linear-gradient(to bottom, rgba(120,160,255,0.04) 0%, transparent 40%, rgba(0,0,0,0.15) 100%)",
      `linear-gradient(0deg, ${glassBg}, ${glassBg})`,
    ].join(", ");
    const stageColors = { accumulate: "#10b981", core_hold: "#3b82f6", watch: "#f59e0b", reduce: "#ef4444", research_on_watch: "#a78bfa", research_low: "#8b5cf6", research_avoid: "#6b7280", research: "#6b7280", exited: "#6b7280" };
    const accentColor = stageColors[stage] || "#6b7280";
    const stageLabels = { accumulate: "Accum", core_hold: "Core", watch: "Watch", reduce: "Reduce", research_on_watch: "On Watch", research_low: "Low Conv", research_avoid: "Avoid", research: "Research", exited: "Exited" };

    return React.createElement("div", {
      key: sym,
      role: "button",
      tabIndex: 0,
      onClick: () => onSelect && onSelect(sym),
      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect && onSelect(sym); } },
      className: `w-full text-left rounded-lg cursor-pointer hover:brightness-110 relative overflow-hidden border flex flex-col transition-all ${isSelected ? "border-white/30 bg-white/[0.08]" : "border-white/[0.08]"}`,
      style: { backgroundImage: cardBgImage, boxShadow: "0 4px 12px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.12)", height: "142px" },
    },
      React.createElement("div", { className: "absolute left-0 top-0 bottom-0 w-[3px] rounded-l-lg", style: { background: accentColor, boxShadow: `0 0 6px ${accentColor}66` } }),
      SparklineBg && t._sparkline && t._sparkline.length >= 3 && React.createElement("div", { className: "absolute inset-0 pointer-events-none", style: { zIndex: 0 } },
        React.createElement(SparklineBg, { data: (() => {
          const lp = Number(t._live_price || t.price);
          const sp = t._sparkline;
          if (lp > 0 && sp.length > 0 && Math.abs(lp - sp[sp.length - 1]) / sp[sp.length - 1] > 0.005) return [...sp, lp];
          return sp;
        })(), width: 200, height: 142, bgMode: true }),
      ),
      React.createElement("div", { className: "relative flex flex-col flex-1 min-h-0", style: { zIndex: 1 } },
        React.createElement("div", { className: "absolute inset-0 pointer-events-none rounded-lg", style: { background: "linear-gradient(to bottom, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0.05) 45%, rgba(0,0,0,0.40) 100%)" } }),

        React.createElement("div", { className: "relative flex items-center justify-between px-2 pt-1.5 pb-0", style: { zIndex: 1 } },
          React.createElement("div", { className: "flex items-center gap-1.5 min-w-0" },
            toggleSavedTicker && React.createElement("button", {
              onClick: (e) => { e.stopPropagation(); toggleSavedTicker(sym); },
              className: `shrink-0 text-[13px] hover:scale-110 transition-transform ${savedTickers?.has(sym) ? "text-amber-400" : "text-[#4b5563] hover:text-amber-300"}`,
              title: savedTickers?.has(sym) ? "Remove from Saved" : "Add to Saved",
            }, savedTickers?.has(sym) ? "\u2733" : "\u2606"),
            React.createElement("div", { className: "flex flex-col min-w-0 shrink" },
              React.createElement("span", { className: "text-[13px] font-bold text-white shrink-0", style: { textShadow: "0 1px 3px rgba(0,0,0,0.8)" } }, sym),
              t.companyName && React.createElement("span", { className: "text-[9px] text-[#9ca3af] truncate", title: t.companyName }, t.companyName),
            ),
            React.createElement("span", {
              className: "inline-flex items-center justify-center px-1.5 py-px rounded text-[9px] font-bold shrink-0 tracking-wide bg-violet-500/40 text-violet-200 border border-violet-400/60",
              style: { textShadow: "0 0 6px rgba(139,92,246,0.5)" },
              title: "Timed Trading Investor",
            }, "TT"),
            React.createElement("span", { className: `inline-flex items-center px-1.5 py-px rounded text-[8px] font-bold shrink-0 tracking-wide border`, style: { background: `${accentColor}30`, color: accentColor, borderColor: `${accentColor}60` } }, stageLabels[stage] || stage),
          ),
          React.createElement("div", { className: "flex flex-col items-end shrink-0 ml-1" },
            price != null && React.createElement("span", { className: "text-white font-bold text-[13px] tabular-nums leading-tight", style: { textShadow: "0 1px 3px rgba(0,0,0,0.8)" } }, `$${price.toFixed(2)}`),
            (dayPct != null && Number.isFinite(dayPct)) && React.createElement("span", {
              className: "text-[11px] font-bold tabular-nums leading-tight",
              style: { color: dayPct >= 0 ? (Math.abs(dayPct) >= 3 ? "#4ade80" : "#00e676") : (Math.abs(dayPct) >= 3 ? "#fb7185" : "#f87171"), textShadow: "0 1px 4px rgba(0,0,0,0.7)" },
            }, `${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(2)}%${Number.isFinite(dayChg) ? ` (${dayChg >= 0 ? "+" : "-"}$${Math.abs(dayChg).toFixed(2)})` : ""}`),
          ),
        ),

        React.createElement("div", { className: "relative flex items-center justify-between px-2 py-0.5", style: { zIndex: 1 } },
          React.createElement("div", { className: "flex items-center gap-1.5 text-[10px] font-medium text-[#8b95a5]" },
            React.createElement("span", null, "Score ", React.createElement("span", { className: `font-bold tabular-nums ${scoreCls}` }, Number.isFinite(score) ? score : "\u2014")),
            t.rsRank != null && React.createElement("span", null, "RS ", React.createElement("span", { className: "font-bold tabular-nums text-white" }, `${t.rsRank}%`)),
          ),
          React.createElement("div", { className: "flex items-center gap-1" },
            t.accumZone?.inZone && React.createElement("span", { className: "text-[9px] font-bold text-[#00e676] bg-[#00c853]/15 px-1.5 py-px rounded border border-[#00c853]/30" }, "BUY ZONE"),
            t.rs?.rsNewHigh3m && React.createElement("span", { className: "text-[9px] font-bold text-sky-400 bg-sky-500/15 px-1.5 py-px rounded border border-sky-500/30" }, "RS HIGH"),
          ),
        ),

        React.createElement("div", { className: "relative flex items-center justify-between px-2 py-0.5 text-[9px]", style: { zIndex: 1 } },
          React.createElement("div", { className: "flex items-center gap-1" },
            t.rs?.rs1m != null && React.createElement("span", { className: `font-semibold tabular-nums ${t.rs.rs1m >= 0 ? "text-[#00e676]" : "text-rose-400"}` }, `1M:${t.rs.rs1m >= 0 ? "+" : ""}${Number(t.rs.rs1m).toFixed(1)}%`),
            t.rs?.rs3m != null && React.createElement("span", { className: `font-semibold tabular-nums ${t.rs.rs3m >= 0 ? "text-[#00e676]" : "text-rose-400"}` }, `3M:${t.rs.rs3m >= 0 ? "+" : ""}${Number(t.rs.rs3m).toFixed(1)}%`),
          ),
          stage === "accumulate" && React.createElement("span", { className: "text-[8px] text-[#00e676]/80 font-semibold" }, "Consider buying"),
          stage === "reduce" && React.createElement("span", { className: "text-[8px] text-rose-400/80 font-semibold" }, "Consider trimming"),
          stage === "research_on_watch" && React.createElement("span", { className: "text-[8px] text-violet-400/80 font-semibold" }, "On radar"),
          stage === "research_avoid" && React.createElement("span", { className: "text-[8px] text-[#6b7280]/80 font-semibold" }, "Caution"),
        ),

        React.createElement("div", { className: "relative mt-auto px-2 pb-1.5 pt-0.5", style: { zIndex: 1 } },
          React.createElement(ScoreBar, { score: Math.min(100, Math.max(0, score)), color: score >= 70 ? "#10b981" : score >= 50 ? "#f59e0b" : "#ef4444" }),
        ),
      ),
    );
  }

  function InvestorKanbanColumn({ laneKey, title, icon, color, count, items, renderCard, laneScrollRef }) {
    const listRef = useRef(null);
    useEffect(() => {
      try {
        const el = listRef.current;
        if (!el || !laneScrollRef?.current) return;
        const saved = laneScrollRef.current[laneKey];
        if (Number.isFinite(saved) && saved > 0) el.scrollLeft = saved;
      } catch {}
    }, [laneKey, items?.map(i => i.ticker).join(",")]);

    return React.createElement("div", { className: "flex items-stretch gap-0 mb-1 kanban-lane" },
      React.createElement("div", {
        className: "flex flex-col justify-center items-center min-w-[72px] w-[72px] shrink-0 rounded-l-xl border-l-2 border-t border-b border-t-white/[0.04] border-b-white/[0.04] px-1.5 py-2",
        style: { borderLeftColor: color, background: "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)" },
        title: title,
      },
        React.createElement("span", { className: "text-[11px] font-semibold text-white/90 tracking-wide text-center leading-tight break-words" }, icon, React.createElement("br"), title),
        React.createElement("span", { className: `text-[10px] font-bold tabular-nums mt-0.5 ${count > 0 ? "text-white/80" : "text-[#4b5563]"}` }, count),
      ),
      React.createElement("div", {
        ref: listRef,
        className: "flex-1 rounded-r-xl border-t border-r border-b border-white/[0.04] p-1.5 overflow-x-auto scrollbar-hide",
        style: { overflowAnchor: "none", WebkitOverflowScrolling: "touch", background: "rgba(255,255,255,0.01)" },
        onScroll: () => {
          try {
            const el = listRef.current;
            if (el && laneScrollRef?.current) laneScrollRef.current[laneKey] = el.scrollLeft;
          } catch {}
        },
      },
        Array.isArray(items) && items.length > 0
          ? React.createElement("div", { className: "flex gap-1.5" },
              items.slice(0, 80).map(t => React.createElement("div", { key: t.ticker, className: "w-[280px] shrink-0 kanban-card" }, renderCard(t))),
            )
          : React.createElement("div", { className: "text-[10px] text-[#4b5563] italic flex items-center h-full px-2 min-h-[80px]" }, "No tickers"),
      ),
    );
  }

  function ActionKanban({ tickers, onSelect, selectedTicker, savedTickers, toggleSavedTicker }) {
    const laneScrollRef = useRef({});
    const stages = ["accumulate", "core_hold", "watch", "reduce", "research_on_watch", "research_low", "research_avoid"];
    const stageMeta = {
      accumulate: { label: "Accumulate", icon: "📈", color: "#10b981", title: "Consider buying — price is in a favorable zone" },
      core_hold: { label: "Core Hold", icon: "📊", color: "#3b82f6", title: "Keep holding — trend and strength are solid" },
      watch: { label: "Watch", icon: "👁", color: "#f59e0b", title: "Wait and monitor — signals are mixed" },
      reduce: { label: "Reduce", icon: "📉", color: "#ef4444", title: "Consider selling — showing signs of weakness" },
      research_on_watch: { label: "On Watch", icon: "🔍", color: "#a78bfa", title: "On the radar — moderate score, worth tracking" },
      research_low: { label: "Low Conviction", icon: "📋", color: "#8b5cf6", title: "Low conviction — not actionable yet" },
      research_avoid: { label: "Avoid", icon: "⛔", color: "#6b7280", title: "Weak signals — system advises caution" },
    };
    const grouped = {};
    for (const s of stages) grouped[s] = [];
        for (const t of tickers) {
          let stage = t.stage || "research_avoid";
          if (stage === "research") stage = "research_avoid"; // backward compat: old API
          if (grouped[stage]) grouped[stage].push(t);
        }
    const renderCard = (t) => React.createElement(InvestorCard, { key: t.ticker, t, onSelect, selectedTicker, savedTickers: savedTickers || new Set(), toggleSavedTicker });

    return React.createElement("div", { className: "flex-1 overflow-y-auto space-y-1 min-h-0", "data-coachmark": "action-board" },
      ...stages.map(stage =>
        React.createElement(InvestorKanbanColumn, {
          key: stage,
          laneKey: stage,
          title: stageMeta[stage].label,
          icon: stageMeta[stage].icon,
          color: stageMeta[stage].color,
          count: grouped[stage].length,
          items: grouped[stage],
          renderCard,
          laneScrollRef,
        }),
      ),
    );
  }

  function MarketHealthBar({ health, loading }) {
    if (!health) return React.createElement("div", { className: "card p-4 mb-4" },
      React.createElement("div", { className: "text-[#6b7280] text-sm" }, loading ? "Loading market health…" : "Market health data hasn't been calculated yet. It updates automatically during market hours.")
    );
    const { score, regime, breadth, components, computedAt } = health;
    const color = score >= 70 ? "#10b981" : score >= 45 ? "#f59e0b" : "#ef4444";
    const fmtTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      const ago = Math.round((Date.now() - ts) / 60000);
      if (ago < 60) return `${ago}m ago`;
      if (ago < 1440) return `${Math.floor(ago / 60)}h ago`;
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    };
    const MetricCell = (label, value, desc, colorFn) => {
      const v = value ?? 0;
      const c = colorFn ? colorFn(v) : (v >= 20 ? "#00e676" : v >= 10 ? "#fbbf24" : "#f87171");
      const w = v >= 20 ? "Strong" : v >= 10 ? "Fair" : "Weak";
      return React.createElement("div", { key: label, className: "text-center" },
        React.createElement("div", { className: "text-[10px] text-[#6b7280] uppercase tracking-wide" }, label),
        React.createElement("div", { className: "flex items-baseline justify-center gap-1" },
          React.createElement("span", { className: "text-base font-semibold text-white" }, typeof v === "number" ? v : v),
          (typeof v === "number" && label !== "Long-Term") && React.createElement("span", { className: "text-[10px] font-semibold", style: { color: c } }, w),
        ),
        React.createElement("div", { className: "text-[9px] text-[#4b5563] mt-0.5" }, desc),
      );
    };
    return React.createElement("div", { className: "card p-4 mb-4 fade-in" },
      React.createElement("div", { className: "flex items-center justify-between mb-1" },
        React.createElement("div", { className: "flex items-center gap-3" },
          React.createElement("h2", { className: "text-sm font-semibold text-white" }, "Market Health"),
          React.createElement(RegimeBadge, { regime }),
        ),
        React.createElement("div", { className: "flex items-center gap-2" },
          React.createElement("span", { className: "text-2xl font-bold", style: { color } }, Number.isFinite(score) ? score : "—"),
          React.createElement("span", { className: "text-[#6b7280] text-xs" }, "/ 100"),
        ),
      ),
      React.createElement("div", { className: "text-[11px] text-[#6b7280] mb-2" }, "How healthy is the overall stock market right now? Combines breadth, regime, trend strength, and sector participation."),
      React.createElement(ScoreBar, { score, color }),
      React.createElement("div", { className: "grid grid-cols-2 sm:grid-cols-5 gap-3 mt-3" },
        MetricCell("Participation", components?.breadth, "Stocks above key EMAs", (v) => v >= 20 ? "#00e676" : v >= 10 ? "#fbbf24" : "#f87171"),
        MetricCell("Market Mode", components?.regimeScore, "SPY/QQQ swing regime", (v) => v >= 20 ? "#00e676" : v >= 10 ? "#fbbf24" : "#f87171"),
        MetricCell("Trend Strength", components?.trendMomentum, "Weekly structure avg", (v) => v >= 20 ? "#00e676" : v >= 10 ? "#fbbf24" : "#f87171"),
        MetricCell("Sector Health", components?.sectorHealth, "Bullish sectors count", (v) => v >= 10 ? "#00e676" : v >= 5 ? "#fbbf24" : "#f87171"),
        React.createElement("div", { key: "lt", className: "text-center" },
          React.createElement("div", { className: "text-[10px] text-[#6b7280] uppercase tracking-wide" }, "Long-Term"),
          React.createElement("div", { className: "flex items-baseline justify-center gap-1" },
            React.createElement("span", { className: "text-base font-semibold text-white" }, breadth?.pctAboveW200 != null ? `${breadth.pctAboveW200}%` : "—"),
            breadth?.pctAboveW200 != null && React.createElement("span", {
              className: "text-[10px] font-semibold",
              style: { color: (breadth.pctAboveW200 >= 60 ? "#00e676" : breadth.pctAboveW200 >= 40 ? "#fbbf24" : "#f87171") },
            }, breadth.pctAboveW200 >= 60 ? "Healthy" : breadth.pctAboveW200 >= 40 ? "Fair" : "Weak"),
          ),
          React.createElement("div", { className: "text-[9px] text-[#4b5563] mt-0.5" }, "Above 200-week avg"),
        ),
      ),
      computedAt && React.createElement("div", { className: "text-[9px] text-[#4b5563] mt-2" }, "Updated ", fmtTime(computedAt)),
    );
  }

  function InvestorPanel({ apiBase, onSelectTicker, savedTickers, toggleSavedTicker, selectedTicker, tickerData, searchQuery, filterGroup }) {
    const [scores, setScores] = useState(null);
    const [health, setHealth] = useState(null);
    const [loading, setLoading] = useState(true);
    const [memberTickers, setMemberTickers] = useState([]);
    const [memberTickersLoaded, setMemberTickersLoaded] = useState(false);
    const base = apiBase || "";

    useEffect(() => {
      if (window._ttIsPro || window._ttIsAdmin) {
        setMemberTickersLoaded(true);
        return;
      }
      fetch(`${base}/timed/member-tickers`).then(r => r.json())
        .then(j => {
          if (j.ok && Array.isArray(j.tickers)) setMemberTickers(j.tickers.map(s => String(s).toUpperCase()));
          setMemberTickersLoaded(true);
        })
        .catch(() => { setMemberTickersLoaded(true); });
    }, [base]);

    const fetchData = useCallback(async () => {
      setLoading(true);
      try {
        const [scoresResp, healthResp] = await Promise.all([
          fetch(`${base}/timed/investor/scores`).then(r => r.json()).catch(() => null),
          fetch(`${base}/timed/investor/market-health`).then(r => r.json()).catch(() => null),
        ]);
        if (scoresResp?.ok) setScores(scoresResp);
        if (healthResp?.ok) setHealth(healthResp);
      } catch (_) {}
      finally { setLoading(false); }
    }, [base]);

    useEffect(() => {
      fetchData();
      const interval = setInterval(fetchData, 60000);
      return () => clearInterval(interval);
    }, [fetchData]);

    useEffect(() => {
      if (!scores?.tickers?.length) return;
      let active = true;
      const mergePrices = async () => {
        try {
          const res = await fetch(`${base}/timed/prices?_t=${Date.now()}`, { cache: "no-store" });
          if (!res.ok || !active) return;
          const json = await res.json();
          if (!json.ok || !json.prices) return;
          setScores(prev => {
            if (!prev?.tickers?.length) return prev;
            let changed = false;
            const updated = prev.tickers.map(t => {
              const pf = json.prices[t.ticker];
              if (!pf || !(Number(pf.p) > 0)) return t;
              if (t._live_price === pf.p) return t;
              changed = true;
              const feedPc = Number(pf.pc);
              const feedP = Number(pf.p);
              const feedPcUsable = Number.isFinite(feedPc) && feedPc > 0 && feedP > 0 && (Math.abs(feedPc - feedP) / feedP * 100) > 0.05;
              const bestPc = feedPcUsable ? feedPc : (t._live_prev_close || t.prev_close || undefined);
              return {
                ...t,
                price: pf.p,
                _live_price: pf.p,
                ...(bestPc > 0 ? { _live_prev_close: bestPc, prev_close: bestPc } : {}),
                ...(Number.isFinite(Number(pf.dp)) ? { day_change_pct: pf.dp, change_pct: pf.dp } : {}),
                ...(Number.isFinite(Number(pf.dc)) ? { day_change: pf.dc, change: pf.dc } : {}),
              };
            });
            return changed ? { ...prev, tickers: updated } : prev;
          });
        } catch (_) {}
      };
      mergePrices();
      const interval = setInterval(mergePrices, 30000);
      return () => { active = false; clearInterval(interval); };
    }, [base, scores?.tickers?.length > 0]);

    const allTickers = useMemo(() => {
      if (!scores?.tickers) return [];
      let list = scores.tickers.map(t => {
        const sym = String(t.ticker || "").toUpperCase();
        const mainData = tickerData?.[sym];
        return {
          ...t,
          ticker: sym,
          _sparkline: mainData?._sparkline || t._sparkline,
        };
      });
      if (!window._ttIsPro && !window._ttIsAdmin) {
        if (!memberTickersLoaded) list = [];
        else if (memberTickers.length > 0) {
          const allowed = new Set(memberTickers);
          list = list.filter(t => allowed.has(t.ticker));
        } else list = [];
      }
      if (searchQuery && searchQuery.trim()) {
        const q = searchQuery.trim().toUpperCase();
        list = list.filter(t => t.ticker.includes(q));
      }
      if (filterGroup === "SAVED" && savedTickers && savedTickers.size > 0) {
        list = list.filter(t => savedTickers.has(t.ticker));
      }
      return list;
    }, [scores, memberTickers, memberTickersLoaded, tickerData, searchQuery, filterGroup, savedTickers]);

    const actionCount = useMemo(() => allTickers.filter(t => t.stage && !t.stage.startsWith("research_")).length, [allTickers]);

    return React.createElement("div", { className: "space-y-4" },
      React.createElement("div", { className: "flex items-center justify-between" },
        React.createElement("h2", { className: "text-sm font-semibold text-white" },
          "Action Board",
          React.createElement("span", { className: "text-[10px] text-[#4b5563] ml-2 font-normal" }, `${actionCount} ticker${actionCount !== 1 ? "s" : ""} need attention`),
        ),
        React.createElement("button", {
          onClick: fetchData,
          className: "px-3 py-1 rounded-md text-[12px] text-[#6b7280] hover:text-white hover:bg-white/[0.04] border border-white/[0.06] transition-all",
        }, loading ? "Loading…" : "↻ Refresh"),
      ),
      React.createElement(MarketHealthBar, { health, loading }),
      allTickers.length > 0
        ? React.createElement(ActionKanban, {
            tickers: allTickers,
            onSelect: onSelectTicker,
            selectedTicker,
            savedTickers: savedTickers || new Set(),
            toggleSavedTicker,
          })
        : React.createElement("div", { className: "card p-8 text-center text-[#6b7280]" },
            React.createElement("div", { className: "text-lg mb-2" }, "No investor data yet"),
            React.createElement("div", { className: "text-sm" }, "Stock scores are calculated every hour while the market is open. Check back soon."),
          ),
    );
  }

  window.InvestorPanel = InvestorPanel;
})();
