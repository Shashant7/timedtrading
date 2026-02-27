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
    const sym = String(t?.ticker || "").toUpperCase();
    const stage = t.stage || "research";
    const score = Number(t.score) || 0;
    const scoreCls = score >= 70 ? "text-[#00e676]" : score >= 50 ? "text-amber-400" : "text-red-400";
    const _dc = getDailyChange(t);
    const dayPct = _dc?.dayPct;
    const price = t.price != null && Number.isFinite(t.price) ? t.price : null;
    const isSelected = selectedTicker === sym;
    const glassBg = "rgba(10,16,28,0.45)";
    const cardBgImage = [
      "linear-gradient(170deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 25%, transparent 55%)",
      "linear-gradient(to bottom, rgba(120,160,255,0.04) 0%, transparent 40%, rgba(0,0,0,0.15) 100%)",
      `linear-gradient(0deg, ${glassBg}, ${glassBg})`,
    ].join(", ");
    const stageColors = { accumulate: "#10b981", core_hold: "#3b82f6", watch: "#f59e0b", reduce: "#ef4444", research: "#8b5cf6", exited: "#6b7280" };
    const accentColor = stageColors[stage] || "#6b7280";

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
      React.createElement("div", { className: "relative flex flex-col flex-1 min-h-0 p-2", style: { zIndex: 1 } },
        React.createElement("div", { className: "flex items-center justify-between" },
          React.createElement("div", { className: "flex items-center gap-1.5 min-w-0" },
            toggleSavedTicker && React.createElement("button", {
              onClick: (e) => { e.stopPropagation(); toggleSavedTicker(sym); },
              className: `text-[13px] hover:scale-110 transition-transform shrink-0 ${savedTickers?.has(sym) ? "text-amber-400" : "text-[#4b5563] hover:text-amber-300"}`,
              title: savedTickers?.has(sym) ? "Remove from Saved" : "Add to Saved",
            }, savedTickers?.has(sym) ? "★" : "☆"),
            React.createElement("span", { className: "text-xs font-bold text-white truncate" }, sym),
            React.createElement("span", { className: `stage-badge stage-${stage} !text-[8px] !py-0 !px-1 shrink-0` }, stage.replace("_", " ")),
          ),
          React.createElement("div", { className: "flex items-center gap-1.5 shrink-0" },
            price != null && React.createElement("span", { className: "text-[10px] text-[#9ca3af] tabular-nums" }, `$${price.toFixed(2)}`),
            (dayPct != null && Number.isFinite(dayPct)) && React.createElement("span", { className: `text-[10px] font-semibold tabular-nums ${dayPct >= 0 ? "text-[#00e676]" : "text-red-400"}` }, `${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(1)}%`),
          ),
        ),
        React.createElement("div", { className: "flex items-center justify-between mt-1" },
          React.createElement("span", { className: `text-sm font-bold tabular-nums ${scoreCls}` }, Number.isFinite(score) ? score : "—"),
          React.createElement("span", { className: "flex items-center gap-1" },
            t.accumZone?.inZone && React.createElement("span", { className: "text-[9px] text-[#00e676] bg-[#00c853]/10 px-1 rounded" }, "ZONE"),
            t.rs?.rsNewHigh3m && React.createElement("span", { className: "text-[9px] text-sky-400 bg-sky-500/10 px-1 rounded" }, "RS HIGH"),
          ),
        ),
        React.createElement("div", { className: "mt-auto pt-1" },
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
        className: "flex flex-col justify-center items-center w-[52px] shrink-0 rounded-l-xl border-l-2 border-t border-b border-t-white/[0.04] border-b-white/[0.04] px-1 py-2",
        style: { borderLeftColor: color, background: "linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.015) 100%)" },
        title: title,
      },
        React.createElement("span", { className: "text-[11px] font-semibold text-white/90 tracking-wide text-center leading-tight" }, icon, React.createElement("br"), title),
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
    const stages = ["accumulate", "core_hold", "watch", "reduce"];
    const stageMeta = {
      accumulate: { label: "Accumulate", icon: "📈", color: "#10b981", title: "Consider buying — price is in a favorable zone" },
      core_hold: { label: "Core Hold", icon: "📊", color: "#3b82f6", title: "Keep holding — trend and strength are solid" },
      watch: { label: "Watch", icon: "👁", color: "#f59e0b", title: "Wait and monitor — signals are mixed" },
      reduce: { label: "Reduce", icon: "📉", color: "#ef4444", title: "Consider selling — showing signs of weakness" },
    };
    const grouped = {};
    for (const s of stages) grouped[s] = [];
    for (const t of tickers) {
      const stage = t.stage || "research";
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
    const { score, regime, breadth } = health;
    const color = score >= 70 ? "#10b981" : score >= 45 ? "#f59e0b" : "#ef4444";
    return React.createElement("div", { className: "card p-4 mb-4 fade-in" },
      React.createElement("div", { className: "flex items-center justify-between mb-1" },
        React.createElement("div", { className: "flex items-center gap-3" },
          React.createElement("h2", { className: "text-sm font-semibold text-white" }, "Market Health"),
          React.createElement(RegimeBadge, { regime }),
        ),
        React.createElement("span", { className: "text-sm font-bold", style: { color } }, Number.isFinite(score) ? score : "—"),
      ),
      breadth?.pctAboveW200 != null && React.createElement("div", { className: "text-[10px] text-[#6b7280] mt-1" }, `${breadth.pctAboveW200}% above 200-week avg`),
    );
  }

  function InvestorPanel({ apiBase, onSelectTicker, savedTickers, toggleSavedTicker, selectedTicker }) {
    const [scores, setScores] = useState(null);
    const [health, setHealth] = useState(null);
    const [loading, setLoading] = useState(true);
    const base = apiBase || "";

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
      return scores.tickers.map(t => ({ ...t, ticker: String(t.ticker || "").toUpperCase() }));
    }, [scores]);

    const actionCount = useMemo(() => allTickers.filter(t => t.stage && t.stage !== "research").length, [allTickers]);

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
