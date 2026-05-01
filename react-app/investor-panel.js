/**
 * Investor Panel — inline component for main dashboard (replaces iframe embed).
 * Fetches /timed/investor/scores, market-health; renders Action Kanban lanes.
 */
(function () {
  if (typeof React === "undefined") return;
  const { useState, useEffect, useCallback, useMemo, useRef } = React;
  const getDailyChange = window.TimedPriceUtils?.getDailyChange || (() => ({ dayPct: null, dayChg: null }));

  function ScoreBar({ score, max }) {
    const pct = Math.max(0, Math.min(100, ((score || 0) / (max || 100)) * 100));
    return React.createElement("div", { className: "w-full h-[3px] bg-white/[0.04] overflow-hidden", style: { borderRadius: "1px" } },
      React.createElement("div", { style: { width: `${pct}%`, background: "rgba(255,255,255,0.2)" }, className: "h-full transition-all duration-500", style2: { borderRadius: "1px" } })
    );
  }

  function RegimeBadge({ regime }) {
    const colors = { RISK_ON: "text-[#4ade80]", CAUTIOUS: "text-[#d4a017]", RISK_OFF: "text-[#f87171]" };
    const friendly = { RISK_ON: "Bullish", CAUTIOUS: "Cautious", RISK_OFF: "Bearish" };
    return React.createElement("span", { className: `text-[10px] font-bold uppercase tracking-wider ${colors[regime] || colors.CAUTIOUS}`, title: regime }, friendly[regime] || regime);
  }

  /* V2.1 round 5 (2026-05-01) — InvestorCard rewritten in v2 design
     language so Investor Mode reads like the Active Trader cards.
     Uses ds-tickercard / ds-chip / ds-caption / JBM mono numerals.
     Preserves the investor-specific data: Score, RS rank, 1M/3M %,
     stage label, BUY ZONE / RS HIGH badges. Logo + monogram + 1H spark
     borrowed from window.DS just like DsCompactCard. */
  function InvestorCard({ t, onSelect, selectedTicker, savedTickers, toggleSavedTicker }) {
    const sym = String(t?.ticker || "").toUpperCase();
    const stage = t.stage || "research_avoid";
    const score = Number(t.score) || 0;
    const _dc = getDailyChange(t);
    const dayPct = Number.isFinite(_dc?.dayPct) ? Number(_dc.dayPct) : null;
    const price = Number.isFinite(Number(t.price)) ? Number(t.price) : null;
    const isSelected = selectedTicker === sym;
    const isSaved = !!(savedTickers && savedTickers.has && savedTickers.has(sym));

    const dir = dayPct == null || Math.abs(dayPct) < 0.05 ? "flat" : dayPct > 0 ? "up" : "dn";

    /* Stage chip mapping — colors hint at action */
    const stageChip = (() => {
      if (stage === "accumulate")        return { label: "Accumulate", cls: "ds-chip--up" };
      if (stage === "core_hold")         return { label: "Core Hold", cls: "ds-chip--accent" };
      if (stage === "watch")             return { label: "Watch", cls: "ds-chip--solid" };
      if (stage === "reduce")            return { label: "Reduce", cls: "ds-chip--dn" };
      if (stage === "research_on_watch") return { label: "On Radar", cls: "ds-chip--solid" };
      if (stage === "research_low")      return { label: "Low Conv", cls: "ds-chip--solid" };
      if (stage === "research_avoid")    return { label: "Caution", cls: "ds-chip--dn" };
      if (stage === "exited")            return { label: "Exited", cls: "ds-chip--solid" };
      return null;
    })();

    /* 1H sparkline: same shared cache the Active Trader cards use. */
    const cachedSpark = (typeof window !== "undefined" && typeof window._dsEnsureSparkline === "function")
      ? window._dsEnsureSparkline(sym) : null;
    const sparkPoints = (cachedSpark && cachedSpark.length >= 2)
      ? cachedSpark
      : (Array.isArray(t._sparkline) && t._sparkline.length >= 2 ? t._sparkline : [price || 0, price || 0]);
    const sparkSvg = (typeof window !== "undefined" && window.DS && Number.isFinite(price) && price > 0)
      ? window.DS.sparklineSvg(sparkPoints, { width: 280, height: 44, direction: dir, strokeWidth: 1.4 })
      : "";

    /* TT Selected highlight — same gold accent as DsCompactCard. */
    const isTTSel = (typeof window !== "undefined" && typeof window.isTickerTTSelected === "function")
      ? window.isTickerTTSelected(sym) : false;

    /* Earnings badge — same lookup as DsCompactCard. */
    const earnings = (typeof window !== "undefined" && window._ttEarningsMap) ? window._ttEarningsMap[sym] : null;
    const earnDays = earnings && Number.isFinite(earnings._daysAway) ? earnings._daysAway : null;
    const earnLabel = earnDays === 0 ? "Today" : earnDays === 1 ? "Tomorrow"
                    : earnDays != null && earnDays > 0 ? `${earnDays}d` : null;

    const cardStyle = {
      width: 280,
      textAlign: "left",
      padding: "var(--ds-space-3)",
      ...(isSelected ? { borderColor: "var(--ds-text-display)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.2)" } : {}),
      ...(isTTSel && !isSelected ? { borderColor: "var(--ds-accent-dim)", boxShadow: "inset 0 0 0 1px rgba(245,194,92,0.18)" } : {}),
    };

    return React.createElement("button", {
      onClick: () => onSelect && onSelect(sym),
      onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect && onSelect(sym); } },
      className: "ds-tickercard",
      style: cardStyle,
    },
      React.createElement("div", { className: "ds-tickercard__head" },
        React.createElement("div", {
          className: "ds-tickercard__logo",
          style: { width: 22, height: 22 },
          ref: (el) => {
            if (el && !el.dataset.dsInit && window.DS) {
              el.dataset.dsInit = "1";
              try { el.replaceWith(window.DS.tickerLogo(sym, { size: 22 })); } catch (_) {}
            }
          },
        }, sym.slice(0, 2)),
        React.createElement("span", { className: "ds-tickercard__symbol", style: { fontSize: 13 } }, sym),
        // RS HIGH badge — investor-specific signal, gold accent
        t.rs?.rsNewHigh3m && React.createElement("span", {
          className: "ds-chip ds-chip--sm ds-chip--accent",
          style: { fontFamily: "var(--tt-font-mono)", marginLeft: 4 },
          title: "Relative strength made a new 3-month high",
        }, "RS HI"),
        // BUY ZONE badge — accumulate condition
        t.accumZone?.inZone && React.createElement("span", {
          className: "ds-chip ds-chip--sm ds-chip--up",
          style: { fontFamily: "var(--tt-font-mono)", marginLeft: 4 },
          title: "Price in favorable accumulation zone",
        }, "BUY"),
        // TT Selected dot
        isTTSel && React.createElement("span", {
          title: "TT Selected",
          style: {
            width: 6, height: 6, borderRadius: "50%",
            background: "var(--ds-accent)",
            boxShadow: "0 0 0 2px rgba(245,194,92,0.20)",
            marginLeft: 4, flexShrink: 0,
          },
        }),
        // Earnings badge
        earnLabel && React.createElement("span", {
          className: "ds-chip ds-chip--sm ds-chip--accent",
          style: { fontFamily: "var(--tt-font-mono)", marginLeft: 4 },
          title: `Earnings ${earnings?.date || ""} ${earnings?.hour || ""}`,
        }, `EPS ${earnLabel}`),
        // Stage chip — action-oriented
        stageChip && React.createElement("span", {
          className: `ds-chip ds-chip--sm ${stageChip.cls}`,
          style: { marginLeft: "auto" },
        }, stageChip.label),
        // Save toggle
        toggleSavedTicker && React.createElement("button", {
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); toggleSavedTicker(sym); },
          className: "ds-chip ds-chip--sm",
          style: {
            marginLeft: stageChip ? 4 : "auto",
            padding: "0 6px",
            height: 18,
            color: isSaved ? "var(--ds-accent)" : "var(--ds-text-muted)",
            background: isSaved ? "var(--ds-accent-dim)" : "transparent",
            borderColor: isSaved ? "var(--ds-accent)" : "var(--ds-stroke)",
          },
          title: isSaved ? "Saved \u2014 click to unsave" : "Save ticker",
          "aria-label": isSaved ? "Unsave ticker" : "Save ticker",
        }, isSaved ? "\u2605" : "\u2606"),
      ),
      React.createElement("div", { className: "ds-tickercard__price", style: { fontSize: 18 } },
        Number.isFinite(price) ? `$${price.toFixed(2)}` : "\u2014"),
      dayPct != null && React.createElement("div", {
        className: `ds-tickercard__change ds-tickercard__change--${dir}`,
        style: { fontSize: 12 },
      }, `${dir === "up" ? "\u25B2" : dir === "dn" ? "\u25BC" : "\u25C6"} ${dayPct >= 0 ? "+" : ""}${dayPct.toFixed(2)}%`),
      sparkSvg && React.createElement("div", { className: "ds-tickercard__spark", dangerouslySetInnerHTML: { __html: sparkSvg } }),
      // Bottom signal row — Score · RS · 1M · 3M
      React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: "var(--ds-space-1)", marginTop: "var(--ds-space-2)", flexWrap: "wrap", zIndex: 2, position: "relative" },
      },
        Number.isFinite(score) && score > 0 && React.createElement("span", {
          className: `ds-chip ds-chip--sm ${score >= 70 ? "ds-chip--up" : score >= 50 ? "ds-chip--accent" : ""}`,
          style: { fontFamily: "var(--tt-font-mono)" },
          title: "Composite investor score (0-100)",
        }, `S${Math.round(score)}`),
        t.rsRank != null && React.createElement("span", {
          className: `ds-chip ds-chip--sm ${Number(t.rsRank) >= 80 ? "ds-chip--up" : Number(t.rsRank) >= 50 ? "" : "ds-chip--solid"}`,
          style: { fontFamily: "var(--tt-font-mono)" },
          title: "Relative strength percentile (vs universe)",
        }, `RS ${t.rsRank}`),
        t.rs?.rs1m != null && React.createElement("span", {
          className: `ds-chip ds-chip--sm ${Number(t.rs.rs1m) >= 0 ? "ds-chip--up" : "ds-chip--dn"}`,
          style: { fontFamily: "var(--tt-font-mono)" },
          title: "1-month return vs SPY",
        }, `1M ${Number(t.rs.rs1m) >= 0 ? "+" : ""}${Number(t.rs.rs1m).toFixed(1)}%`),
        t.rs?.rs3m != null && React.createElement("span", {
          className: `ds-chip ds-chip--sm ${Number(t.rs.rs3m) >= 0 ? "ds-chip--up" : "ds-chip--dn"}`,
          style: { fontFamily: "var(--tt-font-mono)" },
          title: "3-month return vs SPY",
        }, `3M ${Number(t.rs.rs3m) >= 0 ? "+" : ""}${Number(t.rs.rs3m).toFixed(1)}%`),
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

    return React.createElement("div", { className: "flex items-stretch gap-0 mb-0.5 kanban-lane" },
      React.createElement("div", {
        className: "flex flex-col justify-center items-center min-w-[56px] w-[56px] shrink-0 border-r border-r-white/[0.04] px-1 py-2",
        style: { background: "transparent" },
        title: title,
      },
        React.createElement("span", { className: "text-[9px] font-bold uppercase tracking-widest text-[#4b5563] text-center leading-tight break-words" }, title),
        React.createElement("span", { className: `text-[11px] font-bold tabular-nums mt-0.5 ${count > 0 ? "text-[#e5e7eb]" : "text-[#2a2e35]"}` }, count),
      ),
      React.createElement("div", {
        ref: listRef,
        className: "flex-1 p-1.5 overflow-x-auto scrollbar-hide",
        style: { overflowAnchor: "none", WebkitOverflowScrolling: "touch" },
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
      accumulate: { label: "Accumulate", icon: "", color: "transparent", title: "Consider buying — price is in a favorable zone" },
      core_hold: { label: "Core Hold", icon: "", color: "transparent", title: "Keep holding — trend and strength are solid" },
      watch: { label: "Watch", icon: "", color: "transparent", title: "Wait and monitor — signals are mixed" },
      reduce: { label: "Reduce", icon: "", color: "transparent", title: "Consider selling — showing signs of weakness" },
      research_on_watch: { label: "On Watch", icon: "", color: "transparent", title: "On the radar — moderate score, worth tracking" },
      research_low: { label: "Low Conv", icon: "", color: "transparent", title: "Low conviction — not actionable yet" },
      research_avoid: { label: "Avoid", icon: "", color: "transparent", title: "Weak signals — system advises caution" },
    };
    const grouped = {};
    for (const s of stages) grouped[s] = [];
        for (const t of tickers) {
          let stage = t.stage || "research_avoid";
          if (stage === "research") stage = "research_avoid"; // backward compat: old API
          if (grouped[stage]) grouped[stage].push(t);
        }
    const renderCard = (t) => React.createElement(InvestorCard, { key: t.ticker, t, onSelect, selectedTicker, savedTickers: savedTickers || new Set(), toggleSavedTicker });

    /* V2.1 round 5 (2026-05-01) — Per user: "nothing is ever in any
       other lanes". Hide lanes that have zero tickers so the layout
       focuses on the actionable rows. Always-show core_hold + accumulate
       + reduce + watch (the "decision-making" lanes); collapse the
       research_* lanes when empty. */
    const ALWAYS_SHOW = new Set(["accumulate", "core_hold", "watch", "reduce"]);
    const visibleStages = stages.filter(s => ALWAYS_SHOW.has(s) || grouped[s].length > 0);

    return React.createElement("div", { className: "flex-1 overflow-y-auto space-y-1 min-h-0", "data-coachmark": "action-board" },
      ...visibleStages.map(stage =>
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

  function InvestorPanel({ apiBase, onSelectTicker, savedTickers, toggleSavedTicker, selectedTicker, tickerData, searchQuery, filterGroup, allowedTickerSet, pendingTickerSymbols = [] }) {
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
      const q = searchQuery && searchQuery.trim()
        ? searchQuery.trim().toUpperCase()
        : "";
      if (q) {
        list = list.filter(t => t.ticker.includes(q));
      }
      if (filterGroup === "SAVED" && savedTickers && savedTickers.size > 0) {
        list = list.filter(t => savedTickers.has(t.ticker));
      }
      if (filterGroup === "INVESTOR_ACTIONABLE") {
        list = list.filter(t => {
          const stage = String(t?.stage || "").toLowerCase();
          return stage === "accumulate" || stage === "reduce";
        });
      }
      if (allowedTickerSet instanceof Set) {
        list = list.filter(t => allowedTickerSet.has(t.ticker));
      }
      const existing = new Set(list.map(t => t.ticker));
      pendingTickerSymbols.forEach((ticker) => {
        const sym = String(ticker || "").toUpperCase().trim();
        if (!sym || existing.has(sym)) return;
        if (allowedTickerSet instanceof Set && !allowedTickerSet.has(sym)) return;
        if (q && !sym.includes(q)) return;
        if (filterGroup === "SAVED" && savedTickers && savedTickers.size > 0 && !savedTickers.has(sym)) return;
        if (filterGroup === "INVESTOR_ACTIONABLE") return;
        const mainData = tickerData?.[sym] || {};
        list.unshift({
          ticker: sym,
          companyName: mainData.companyName || mainData.name || `${sym} loading…`,
          price: mainData.price ?? mainData.close ?? mainData.c ?? mainData.last ?? null,
          _sparkline: mainData._sparkline,
          stage: "research_on_watch",
          score: 0,
          _optimistic_pending: true,
        });
      });
      return list;
    }, [scores, memberTickers, memberTickersLoaded, tickerData, searchQuery, filterGroup, savedTickers, allowedTickerSet, pendingTickerSymbols]);

    const actionCount = useMemo(() => allTickers.filter(t => t.stage && !t.stage.startsWith("research_")).length, [allTickers]);

    /* V2.1 round 5 (2026-05-01) — Investor narrative.
       Per user: "we need to provide some additional narrative, much like the
       Daily Brief". Builds a short, plain-language paragraph from
       MarketHealth + lane counts + top-conviction names so users get
       context without having to read the chart. */
    const narrative = useMemo(() => {
      if (!allTickers.length) return null;
      const counts = { accumulate: 0, core_hold: 0, watch: 0, reduce: 0, research_on_watch: 0, research_low: 0, research_avoid: 0 };
      const buyZone = [];
      const rsHigh = [];
      for (const t of allTickers) {
        const s = String(t.stage || "research_avoid");
        if (counts[s] != null) counts[s] += 1;
        if (t.accumZone?.inZone) buyZone.push(t.ticker);
        if (t.rs?.rsNewHigh3m) rsHigh.push(t.ticker);
      }
      const regimeWord = health?.regime === "RISK_ON" ? "bullish"
                       : health?.regime === "RISK_OFF" ? "bearish"
                       : "cautious";
      const score = Number(health?.score);
      const breadthPct = Number(health?.breadth?.pctAboveD200);
      const lines = [];
      lines.push(
        `Market is ${regimeWord}${Number.isFinite(score) ? ` (Health ${Math.round(score)}/100)` : ""}` +
        `${Number.isFinite(breadthPct) ? `, with ${Math.round(breadthPct)}% of stocks above their 200-day MA` : ""}.`
      );
      const actionable = counts.accumulate + counts.reduce;
      if (actionable > 0) {
        const acc = counts.accumulate, red = counts.reduce;
        lines.push(
          `${actionable} name${actionable === 1 ? " is" : "s are"} actionable — ` +
          `${acc} to accumulate, ${red} to reduce.`
        );
      } else {
        lines.push(`No accumulate / reduce signals firing right now — system suggests holding existing core positions and waiting for setups.`);
      }
      if (buyZone.length > 0) {
        lines.push(`In the buy zone: ${buyZone.slice(0, 6).join(", ")}${buyZone.length > 6 ? "…" : ""}.`);
      }
      if (rsHigh.length > 0) {
        lines.push(`Relative strength making fresh 3-month highs: ${rsHigh.slice(0, 6).join(", ")}${rsHigh.length > 6 ? "…" : ""}.`);
      }
      if (counts.core_hold > 0) {
        lines.push(`${counts.core_hold} core positions remain on the hold list — trend and strength still constructive.`);
      }
      return lines.join(" ");
    }, [allTickers, health]);

    return React.createElement("div", { className: "space-y-4" },
      React.createElement("div", { className: "flex items-center justify-between" },
        React.createElement("h2", { className: "text-sm font-semibold text-white" },
          "Action Board",
          React.createElement("span", { className: "text-[10px] text-[#4b5563] ml-2 font-normal" }, `${actionCount} ticker${actionCount !== 1 ? "s" : ""} need attention`),
        ),
        React.createElement("button", {
          onClick: fetchData,
          className: "ds-chip ds-chip--sm",
          style: { fontFamily: "var(--tt-font-mono)" },
        }, loading ? "Loading\u2026" : "\u21BB Refresh"),
      ),
      React.createElement(MarketHealthBar, { health, loading }),
      /* Narrative panel — Daily-Brief-style commentary above the lanes */
      narrative && React.createElement("div", {
        className: "ds-glass",
        style: { padding: "var(--ds-space-3) var(--ds-space-4)" },
      },
        React.createElement("div", {
          className: "ds-caption",
          style: { marginBottom: "var(--ds-space-2)", color: "var(--ds-accent)" },
        }, "Investor Brief"),
        React.createElement("p", {
          style: {
            margin: 0,
            fontSize: "var(--ds-fs-body)",
            lineHeight: 1.6,
            color: "var(--ds-text-body)",
          },
        }, narrative),
      ),
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
