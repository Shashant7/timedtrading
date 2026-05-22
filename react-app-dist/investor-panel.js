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

    /* Phase 3.9l (2026-05-11) — owned-position treatment.
       Position metadata flows from /timed/investor/scores via the worker
       (Phase 3.9i added the `position` field). When `owned=true` we:
         1) draw a violet border (matches the Investor mode accent)
         2) show an OWNED chip in the head row
         3) render a position-stat strip with shares · avg entry · live PnL%
       Live PnL is computed from the latest `t.price` (which the panel's
       merge-prices effect refreshes every 30 s) so the % is always fresh
       even when the cached `position.unrealized_pct` is stale. */
    const pos = t.position;
    const isOwned = !!(pos && pos.owned);
    const posShares = isOwned ? Number(pos.shares) || 0 : 0;
    const posAvg = isOwned ? Number(pos.avg_entry) || 0 : 0;
    const livePnlPct = (isOwned && posAvg > 0 && Number.isFinite(price) && price > 0)
      ? ((price - posAvg) / posAvg) * 100
      : null;
    const livePnlAbs = (livePnlPct != null && posShares > 0)
      ? (price - posAvg) * posShares
      : null;
    const pnlDir = livePnlPct == null
      ? "flat"
      : livePnlPct > 0.05 ? "up" : livePnlPct < -0.05 ? "dn" : "flat";

    /* V15 P0.7.143 (2026-05-13) — Last-action trace for owned positions.
       Shows the user when (and what) the model last did, so a "Reduce"
       lane card with no recent SELL is visibly different from one where
       the model already trimmed yesterday. Prevents the "GOOGL has been
       in Reduce for 7 days, did anything happen?" confusion. */
    const lastActionType = isOwned ? String(pos?.last_action_type || "") : "";
    const lastActionTs = isOwned ? Number(pos?.last_action_ts) || 0 : 0;
    const lastActionShares = isOwned ? Number(pos?.last_action_shares) || 0 : 0;
    const lastActionAgoMs = lastActionTs > 0 ? (Date.now() - lastActionTs) : 0;
    const lastActionAgoLabel = (() => {
      if (!lastActionTs) return null;
      const days = Math.floor(lastActionAgoMs / (24 * 3600 * 1000));
      const hours = Math.floor(lastActionAgoMs / (3600 * 1000));
      const mins = Math.floor(lastActionAgoMs / 60000);
      if (days >= 1) return `${days}d ago`;
      if (hours >= 1) return `${hours}h ago`;
      if (mins >= 1) return `${mins}m ago`;
      return "just now";
    })();
    /* V15 P0.7.144 (2026-05-13) — "Watching" = stage signal active but
       no matching lot action in the last 24h. The previous label
       ("PENDING Awaiting trim 29d ago") read like a system failure;
       the model hasn't failed, it's MONITORING for the right trigger
       condition. Reword as a neutral wait state and lose the "29d ago"
       (the user reads that as "this trim has been broken for 29d"
       when really it's just the time since the BUY entry).

       V15 P0.7.152 (2026-05-14) — additionally surface a STALE chip
       when an Accumulate / Reduce signal has been active for more
       than 7 days without firing. Catches the GOOGL-style case
       (Reduce since April 6, no SELL fired in 37 days) so the user
       can see at a glance that the model's recommendation hasn't
       executed and may need attention.
    */
    const STALE_DAYS = 7;
    const isAccumulateOrReduce = stage === "reduce" || stage === "accumulate";
    const isStaleSignal = isOwned
      && isAccumulateOrReduce
      && lastActionTs > 0
      && lastActionAgoMs > STALE_DAYS * 24 * 3600 * 1000
      && (
        (stage === "reduce" && lastActionType !== "SELL") ||
        (stage === "accumulate" && !["BUY", "DCA_BUY"].includes(lastActionType))
      );
    const watchingLabel = (() => {
      if (!isOwned) return null;
      if (stage === "reduce") {
        if (lastActionType !== "SELL" || lastActionAgoMs > 24 * 3600 * 1000) {
          return isStaleSignal
            ? `Trim signal active ${Math.floor(lastActionAgoMs / 86400000)}d — trigger not yet hit`
            : "Trim signal — monitoring for trigger";
        }
      }
      if (stage === "accumulate") {
        if (!["BUY", "DCA_BUY"].includes(lastActionType) || lastActionAgoMs > 24 * 3600 * 1000) {
          return isStaleSignal
            ? `Buy signal active ${Math.floor(lastActionAgoMs / 86400000)}d — trigger not yet hit`
            : "Buy signal — monitoring for trigger";
        }
      }
      return null;
    })();

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
      // Owned positions get a violet halo (matches the Investor mode accent dot
      // on the section header). Selected / TT Selected take precedence.
      ...(isOwned && !isSelected && !isTTSel ? {
        borderColor: "rgba(167,139,250,0.55)",
        boxShadow: "inset 0 0 0 1px rgba(167,139,250,0.22), 0 0 0 1px rgba(167,139,250,0.08)",
        background: "linear-gradient(180deg, rgba(167,139,250,0.05) 0%, transparent 35%)",
      } : {}),
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
        // OWNED badge — system has an open investor position in this ticker
        // (Phase 3.9l). Violet to match the Investor mode accent.
        isOwned && React.createElement("span", {
          className: "ds-chip ds-chip--sm",
          style: {
            fontFamily: "var(--tt-font-mono)", marginLeft: 4,
            color: "rgb(196,181,253)",
            background: "rgba(167,139,250,0.15)",
            borderColor: "rgba(167,139,250,0.45)",
          },
          title: posShares > 0 && posAvg > 0
            ? `Open position: ${posShares.toFixed(posShares >= 10 ? 1 : 4)} shares @ avg $${posAvg.toFixed(2)}`
            : "Open investor position",
        }, "OWNED"),
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
      // Phase 3.9l — owned-position stat strip. Shares · avg entry · live PnL.
      // Sits between sparkline and the signal row so it's visually adjacent
      // to the live price (the user's eye reads down: live price → "vs my
      // cost" → "open PnL"). Only renders when isOwned.
      isOwned && React.createElement("div", {
        style: {
          display: "flex", alignItems: "center", gap: "var(--ds-space-1)",
          marginTop: "var(--ds-space-2)",
          padding: "4px 6px",
          borderRadius: "4px",
          background: "rgba(167,139,250,0.07)",
          border: "1px solid rgba(167,139,250,0.18)",
          fontFamily: "var(--tt-font-mono)",
          fontSize: 11,
          flexWrap: "wrap",
        },
        title: posShares > 0 && posAvg > 0 && livePnlPct != null
          ? `Open position: ${posShares.toFixed(posShares >= 10 ? 1 : 4)} sh @ $${posAvg.toFixed(2)} → live $${(price ?? 0).toFixed(2)} (${livePnlPct >= 0 ? "+" : ""}${livePnlPct.toFixed(2)}%)`
          : "Open investor position",
      },
        React.createElement("span", {
          style: { color: "rgb(196,181,253)", fontWeight: 600, letterSpacing: "0.04em" },
        }, "POS"),
        React.createElement("span", { style: { color: "var(--ds-text-muted)" } },
          posShares > 0 ? `${posShares >= 10 ? posShares.toFixed(1) : posShares.toFixed(4)} sh` : "—"),
        React.createElement("span", { style: { color: "var(--ds-text-muted)" } },
          posAvg > 0 ? `@ $${posAvg.toFixed(2)}` : ""),
        livePnlPct != null && React.createElement("span", {
          style: {
            marginLeft: "auto",
            color: pnlDir === "up" ? "var(--ds-up, rgb(74,222,128))"
                 : pnlDir === "dn" ? "var(--ds-dn, rgb(248,113,113))"
                 : "var(--ds-text-muted)",
            fontWeight: 700,
          },
        }, `${livePnlPct >= 0 ? "+" : ""}${livePnlPct.toFixed(1)}%`),
        livePnlAbs != null && Math.abs(livePnlAbs) >= 1 && React.createElement("span", {
          style: {
            color: pnlDir === "up" ? "var(--ds-up, rgb(74,222,128))"
                 : pnlDir === "dn" ? "var(--ds-dn, rgb(248,113,113))"
                 : "var(--ds-text-muted)",
            opacity: 0.85,
          },
        }, `(${livePnlAbs >= 0 ? "+" : ""}$${Math.abs(livePnlAbs).toFixed(0)})`),
      ),
      // V15 P0.7.143/.144 — Last-action trace for owned positions.
      //
      // Two stacked lines when both apply:
      //   Line 1: WATCHING — "Trim signal — monitoring for trigger"
      //           (only when stage recommends action with no recent lot)
      //   Line 2: LAST — actual most-recent lot ("Bought 17sh · 28d ago")
      //
      // The wording deliberately does NOT use "PENDING" or "Awaiting"
      // (which the user read as "the model failed to act"). The model
      // is doing exactly what it should: waiting for the trigger
      // condition. The age-since-last-action stays on the LAST line, not
      // the watching line, so it reads as factual context rather than
      // an alarm clock.
      isOwned && (watchingLabel || lastActionAgoLabel) && React.createElement("div", {
        style: { marginTop: 4, display: "flex", flexDirection: "column", gap: 2 },
      },
        watchingLabel && React.createElement("div", {
          style: {
            display: "flex", alignItems: "center", gap: 6,
            padding: "3px 6px",
            borderRadius: "4px",
            background: isStaleSignal ? "rgba(245,158,11,0.10)" : "rgba(96,165,250,0.06)",
            border: `1px solid ${isStaleSignal ? "rgba(245,158,11,0.30)" : "rgba(96,165,250,0.18)"}`,
            fontFamily: "var(--tt-font-mono)",
            fontSize: 10,
            color: isStaleSignal ? "rgb(252,211,77)" : "rgb(147,197,253)",
            lineHeight: 1.2,
          },
          title: `Model recommends "${stage}" \u2014 watching for the trigger condition. Last lot action was ${lastActionType || "none"}${lastActionTs ? ` on ${new Date(lastActionTs).toLocaleDateString()}` : ""}.${isStaleSignal ? " Signal is stale (>7d) — trailing-stop / consecutive-day trigger has not yet fired." : ""}`,
        },
          React.createElement("span", { style: { fontWeight: 700, letterSpacing: "0.04em" } }, isStaleSignal ? "STALE" : "WATCHING"),
          React.createElement("span", { style: { opacity: 0.95 } }, watchingLabel),
        ),
        lastActionAgoLabel && React.createElement("div", {
          style: {
            display: "flex", alignItems: "center", gap: 6,
            padding: "3px 6px",
            borderRadius: "4px",
            background: "rgba(167,139,250,0.05)",
            border: "1px solid rgba(167,139,250,0.14)",
            fontFamily: "var(--tt-font-mono)",
            fontSize: 10,
            color: "var(--ds-text-muted)",
            lineHeight: 1.2,
          },
          title: `Last model action: ${lastActionType} ${lastActionShares > 0 ? lastActionShares.toFixed(2) + " sh" : ""} on ${new Date(lastActionTs).toLocaleString()}.`,
        },
          React.createElement("span", { style: { fontWeight: 700, letterSpacing: "0.04em" } }, "LAST"),
          React.createElement("span", { style: { opacity: 0.95 } },
            `${lastActionType === "DCA_BUY" ? "DCA" : lastActionType}${lastActionShares > 0 ? " " + lastActionShares.toFixed(lastActionShares >= 10 ? 1 : 2) + "sh" : ""}`),
          React.createElement("span", { style: { marginLeft: "auto", opacity: 0.75 } }, lastActionAgoLabel),
        ),
      ),
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

  function InvestorKanbanColumn({ laneKey, title, hint, action, actionColor, icon, color, count, items, renderCard, laneScrollRef }) {
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
      // V15 P0.7.144/.152 — gutter shows lane title + action chip +
      // count. The action chip ("BUY NOW" / "HOLDING" / "TRIM SOON" /
      // "WAIT" / "SKIP") is the one-glance answer to "what do I do
      // with this lane?". Color-coded so the user's eye lands on
      // green BUY-NOW and amber TRIM-SOON without reading.
      React.createElement("div", {
        className: "flex flex-col justify-center items-center min-w-[88px] w-[88px] shrink-0 border-r border-r-white/[0.04] px-1.5 py-2",
        style: { background: "transparent" },
        title: hint || title,
      },
        React.createElement("span", { className: "text-[9px] font-bold uppercase tracking-wider text-[#4b5563] text-center leading-tight break-words" }, title),
        action && React.createElement("span", {
          className: "text-[8px] font-bold tabular-nums mt-1 px-1 py-[1px] rounded",
          style: {
            color: actionColor,
            background: `${actionColor}14`,
            border: `1px solid ${actionColor}30`,
            letterSpacing: "0.04em",
            fontFamily: "var(--tt-font-mono)",
          },
        }, action),
        React.createElement("span", { className: `text-[11px] font-bold tabular-nums mt-1 ${count > 0 ? "text-[#e5e7eb]" : "text-[#2a2e35]"}` }, count),
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
    /* V15 P0.7.152 (2026-05-14) — lane order follows the action arc.
       User spec: "We need to present the lanes in order of action:
       On Radar → Accumulate → Core Hold → Hold & Watch → Reduce →
       Low Conviction → Avoid."
       The reasoning: the user reads top-down and the lanes should
       trace the lifecycle of a name from "I'm watching this"
       through "I own it and the model is managing it" through "the
       model has cooled off on this".
    */
    const stages = ["research_on_watch", "accumulate", "core_hold", "watch", "reduce", "research_low", "research_avoid"];
    /* V15 P0.7.144/.152 — lane labels + per-lane action chip.
       The action chip ("BUY NOW" / "HOLDING" / etc.) sits next to
       the lane title so a new user can answer "what should I do
       with this lane?" in 1 second without reading the tooltip.
    */
    const stageMeta = {
      research_on_watch: { label: "On Radar", action: "WAIT", actionColor: "#9ca3af", title: "Not owned — moderate score. Worth tracking; revisit if it moves into Accumulate." },
      accumulate:        { label: "Accumulate", action: "BUY NOW", actionColor: "#22c55e", title: "Owned or on radar — price entered a favorable zone. Model says: consider buying or adding here." },
      core_hold:         { label: "Core Hold", action: "HOLDING", actionColor: "#60a5fa", title: "Owned core position — trend and strength remain solid. Model says: do nothing, let it run." },
      watch:             { label: "Hold & Watch", action: "HOLDING", actionColor: "#60a5fa", title: "Owned — signals are mixed. Model says: stay with current position, don't add or trim." },
      reduce:            { label: "Reduce", action: "TRIM SOON", actionColor: "#fb923c", title: "Owned — showing weakness. Model says: trim or exit when the trigger condition fires." },
      research_low:      { label: "Low Conviction", action: "WAIT", actionColor: "#9ca3af", title: "Not owned — low conviction. Not actionable yet." },
      research_avoid:    { label: "Avoid", action: "SKIP", actionColor: "#6b7280", title: "Not owned — weak signals. System advises caution." },
    };
    const grouped = {};
    for (const s of stages) grouped[s] = [];
        for (const t of tickers) {
          let stage = t.stage || "research_avoid";
          if (stage === "research") stage = "research_avoid"; // backward compat: old API
          if (grouped[stage]) grouped[stage].push(t);
        }
    // Phase 3.9l — within each lane, push owned positions to the front so
    // user's actual portfolio is the first thing they see horizontally.
    // Stable secondary sort by score (DESC) preserves intra-group ranking.
    for (const s of stages) {
      grouped[s].sort((a, b) => {
        const aOwned = !!(a?.position?.owned);
        const bOwned = !!(b?.position?.owned);
        if (aOwned !== bOwned) return aOwned ? -1 : 1;
        return (Number(b?.score) || 0) - (Number(a?.score) || 0);
      });
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
          hint: stageMeta[stage].title,
          action: stageMeta[stage].action,
          actionColor: stageMeta[stage].actionColor,
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

    // Phase 3.9j (2026-05-11) — defense-in-depth: filter futures + index
    // proxies on the client even though /timed/investor/compute also
    // excludes them. Catches stale cache responses that pre-date the
    // server-side filter.
    const isInvestorEligibleTicker = (ticker) => {
      if (!ticker) return false;
      const t = String(ticker).toUpperCase();
      if (/[!]$/.test(t)) return false; // ES1!, NQ1!, RTY1!, YM1!, GC1!, etc.
      if (t === "US500" || t === "US100" || t === "US30" || t === "US2000") return false;
      return true;
    };

    const allTickers = useMemo(() => {
      if (!scores?.tickers) return [];
      let list = scores.tickers
        .filter(t => isInvestorEligibleTicker(t?.ticker))
        .map(t => {
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
    /* V15 P0.7.144 (2026-05-13) — split the Investor Brief into:
       - Market summary (one sentence on regime + breadth)
       - Action summary (lane counts in plain English)
       - Recent actions (last 3 model lot actions across all owned positions)
       - Watchlist highlights (buy zone + RS new highs)
       Returned as a structured object so the UI can render each piece
       in its own block (previous single-string layout was getting cut
       off at narrow widths). */
    const narrative = useMemo(() => {
      if (!allTickers.length) return null;
      const counts = { accumulate: 0, core_hold: 0, watch: 0, reduce: 0, research_on_watch: 0, research_low: 0, research_avoid: 0 };
      const buyZone = [];
      const rsHigh = [];
      const recentActions = [];
      for (const t of allTickers) {
        const s = String(t.stage || "research_avoid");
        if (counts[s] != null) counts[s] += 1;
        // V15 P0.7.155 (2026-05-14) — align "Buy Zone" in the brief with
        // the Accumulate lane in the kanban. Previously listed any ticker
        // with t.accumZone?.inZone === true, which is a pure technical
        // signal (price-action accumulation pattern) decoupled from the
        // stage classifier — so a ticker could land in the Brief's Buy
        // Zone while sitting in the Avoid lane (HIMX example reported by
        // the user). The user-facing contract is "Brief Buy Zone =
        // Accumulate lane", so gate on stage. Also exclude owned
        // positions — model handles adds via auto-rebalance, suggesting
        // them as fresh buys is misleading.
        const _isOwned = !!t.position?.owned;
        if (s === "accumulate" && t.accumZone?.inZone && !_isOwned) {
          buyZone.push(t.ticker);
        }
        // RS-new-high stays as-is (pure technical watchlist signal,
        // independent of lane), but exclude Avoid lane so we don't
        // surface "watch" tickers the model has flagged as caution.
        if (t.rs?.rsNewHigh3m && s !== "research_avoid") rsHigh.push(t.ticker);
        const lat = Number(t.position?.last_action_ts) || 0;
        const lact = String(t.position?.last_action_type || "");
        if (lat > 0 && lact && t.position?.owned) {
          recentActions.push({
            ticker: t.ticker, action: lact,
            shares: Number(t.position.last_action_shares) || 0,
            ts: lat,
          });
        }
      }
      recentActions.sort((a, b) => b.ts - a.ts);
      const regimeWord = health?.regime === "RISK_ON" ? "bullish"
                       : health?.regime === "RISK_OFF" ? "bearish"
                       : "cautious";
      const score = Number(health?.score);
      const breadthPct = Number(health?.breadth?.pctAboveD200);
      const marketLine = `Market is ${regimeWord}${Number.isFinite(score) ? ` (Health ${Math.round(score)}/100)` : ""}` +
        `${Number.isFinite(breadthPct) ? `, with ${Math.round(breadthPct)}% of stocks above their 200-day MA` : ""}.`;
      const actionable = counts.accumulate + counts.reduce;
      const actionLine = actionable > 0
        ? `${actionable} ${actionable === 1 ? "name is" : "names are"} actionable — ${counts.accumulate} in Buy Zone, ${counts.reduce} flagged for Reduce. ${counts.core_hold} core hold${counts.core_hold === 1 ? "" : "s"}.`
        : `No actionable Buy Zone or Reduce signals right now — model is letting current positions run.`;
      const formatAgo = (ms) => {
        const d = Math.floor(ms / 86400000);
        if (d >= 1) return `${d}d ago`;
        const h = Math.floor(ms / 3600000);
        if (h >= 1) return `${h}h ago`;
        const m = Math.floor(ms / 60000);
        return m >= 1 ? `${m}m ago` : "just now";
      };
      const recentText = recentActions.slice(0, 3).map((a) => {
        const lbl = a.action === "DCA_BUY" ? "DCA" : a.action;
        const sh = a.shares > 0 ? ` ${a.shares.toFixed(a.shares >= 10 ? 1 : 2)}sh` : "";
        return `${lbl} ${a.ticker}${sh} ${formatAgo(Date.now() - a.ts)}`;
      });
      return {
        marketLine,
        actionLine,
        recentActions: recentText,
        buyZone: buyZone.slice(0, 8),
        buyZoneOverflow: Math.max(0, buyZone.length - 8),
        rsHigh: rsHigh.slice(0, 8),
        rsHighOverflow: Math.max(0, rsHigh.length - 8),
      };
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
      /* Narrative panel — Daily-Brief-style commentary above the lanes.
         V15 P0.7.144 — multi-line layout so nothing gets cut off.
         Order: Market summary → Actionable counts → Recent model actions
         → Watchlist highlights. Each block is its own line so width
         constraints don't truncate the others. */
      narrative && React.createElement("div", {
        className: "ds-glass",
        style: { padding: "var(--ds-space-3) var(--ds-space-4)" },
      },
        React.createElement("div", {
          className: "ds-caption",
          style: { marginBottom: "var(--ds-space-2)", color: "var(--ds-accent)" },
        }, "Investor Brief"),
        React.createElement("div", {
          style: {
            display: "flex", flexDirection: "column", gap: "var(--ds-space-2)",
            fontSize: "var(--ds-fs-body)",
            lineHeight: 1.55,
            color: "var(--ds-text-body)",
          },
        },
          React.createElement("div", null, narrative.marketLine),
          React.createElement("div", null, narrative.actionLine),
          narrative.recentActions.length > 0 && React.createElement("div", {
            style: {
              display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--ds-space-2)",
              fontSize: "var(--ds-fs-meta)",
              fontFamily: "var(--tt-font-mono)",
              color: "var(--ds-text-muted)",
              padding: "6px 8px",
              borderLeft: "2px solid rgba(167,139,250,0.4)",
              background: "rgba(167,139,250,0.04)",
              borderRadius: "0 4px 4px 0",
            },
          },
            React.createElement("span", { style: { color: "rgb(196,181,253)", fontWeight: 700 } }, "RECENT"),
            ...narrative.recentActions.map((line, i) => React.createElement("span", { key: `ra${i}`, style: { color: "var(--ds-text-body)" } }, line)),
          ),
          (narrative.buyZone.length > 0 || narrative.rsHigh.length > 0) && React.createElement("div", {
            style: {
              display: "flex", flexDirection: "column", gap: 4,
              fontSize: "var(--ds-fs-meta)",
              color: "var(--ds-text-muted)",
            },
          },
            narrative.buyZone.length > 0 && React.createElement("div", null,
              React.createElement("span", { style: { color: "var(--ds-up)", fontWeight: 700 } }, "Buy Zone: "),
              `${narrative.buyZone.join(", ")}${narrative.buyZoneOverflow > 0 ? ` +${narrative.buyZoneOverflow} more` : ""}.`,
            ),
            narrative.rsHigh.length > 0 && React.createElement("div", null,
              React.createElement("span", { style: { color: "var(--ds-accent)", fontWeight: 700 } }, "Fresh 3M-high RS: "),
              `${narrative.rsHigh.join(", ")}${narrative.rsHighOverflow > 0 ? ` +${narrative.rsHighOverflow} more` : ""}.`,
            ),
          ),
        ),
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

// cache-bust:1779477059987:40419089
