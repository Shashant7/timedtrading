/**
 * Investor Panel — inline component for main dashboard (replaces iframe embed).
 * Fetches /timed/investor/scores, market-health; renders Action Kanban lanes.
 */
(function () {
  if (typeof React === "undefined") return;
  const { useState, useEffect, useCallback, useMemo, useRef } = React;
  const getDailyChange = window.TimedPriceUtils?.getDailyChange || (() => ({ dayPct: null, dayChg: null }));

  /* 2026-06-06 — Investor action tier (server: computeInvestorActionTier).
     act_now = buy zone + SuperTrend alignment; ready = simEligible or
     in-zone strong score; monitor = lane label only; stale = signal >7d. */
  const ACTION_TIER_ORDER = { act_now: 0, ready: 1, monitor: 2, stale: 3 };
  const ACTION_TIER_META = {
    act_now: { label: "REBALANCE", color: "#22c55e", title: "Execution-ready — the model portfolio would open or add this name at the next scheduled rebalance. Independent of whether this account buys manually." },
    ready: { label: "READY", color: "#4ade80", title: "Structural alignment or in-zone — rebalance candidate" },
    monitor: { label: "MONITOR", color: "#6E867D", title: "Accumulate lane signal — not execution-ready yet" },
    stale: { label: "STALE", color: "#f59e0b", title: "Signal active >7d without a matching lot action" },
  };
  function isExecuteReady(t) {
    const tier = deriveActionTier(t);
    return tier === "act_now" || tier === "ready";
  }

  /** Model has an investor lot from a prior rebalance (ate its own dog food). */
  function isAccumulateEntered(t) {
    const pos = t?.position;
    if (!pos?.owned || !(Number(pos.shares) > 0)) return false;
    const lastType = String(pos.last_action_type || "").toUpperCase();
    if (["BUY", "DCA_BUY", "ADD"].includes(lastType)) return true;
    return (Number(pos.first_entry_ts) || 0) > 0;
  }

  function investorRsFields(t) {
    const rs1m = t?.rs?.rs1m ?? t?.rs1m;
    const rs3m = t?.rs?.rs3m ?? t?.rs3m;
    return {
      rs1m: rs1m != null && Number.isFinite(Number(rs1m)) ? Number(rs1m) : null,
      rs3m: rs3m != null && Number.isFinite(Number(rs3m)) ? Number(rs3m) : null,
    };
  }

  /* 2026-06-06 — Kanban lane placement. Accumulate means buy-now only:
     stage accumulate + act_now/ready tier. Monitor/stale demote to
     On Radar (unowned) or Hold & Watch (owned) so lane matches detail. */
  function resolveKanbanStage(t) {
    let stage = String(t?.stage || "research_avoid");
    if (stage === "research") stage = "research_avoid";
    // Full exit — hold in the Exited lane for the post-close cooldown window.
    if (stage === "exited" || (t?.recentlyExited && typeof t.recentlyExited === "object")) {
      return "exited";
    }
    const owned = !!(t?.position?.owned);
    if (!owned) {
      if (stage === "core_hold" || stage === "watch") stage = "research_on_watch";
      else if (stage === "reduce") stage = "research_low";
    }
    if (stage === "accumulate" && !isExecuteReady(t)) {
      stage = owned ? "watch" : "research_on_watch";
    } else if (stage === "accumulate" && isExecuteReady(t)) {
      stage = isAccumulateEntered(t) ? "accumulate_entered" : "accumulate_queued";
    }
    return stage;
  }

  function deriveActionTier(t) {
    if (t?.actionTier && ACTION_TIER_META[t.actionTier]) return t.actionTier;
    const stage = String(t?.stage || "");
    if (stage !== "accumulate" && stage !== "reduce") return null;
    const owned = !!(t?.position?.owned);
    const simEligible = t?.simEligible === true;
    const inZone = !!(t?.accumZone?.inZone);
    const score = Number(t?.score) || 0;
    const lastTs = Number(t?.position?.last_action_ts) || 0;
    const lastType = String(t?.position?.last_action_type || "");
    const agoMs = lastTs > 0 ? Date.now() - lastTs : 0;
    const stale = owned && lastTs > 0 && agoMs > 7 * 86400000 && (
      (stage === "reduce" && lastType !== "SELL") ||
      (stage === "accumulate" && !["BUY", "DCA_BUY"].includes(lastType))
    );
    if (stale) return "stale";
    if (stage === "accumulate") {
      if (inZone && simEligible) return "act_now";
      if (simEligible || (inZone && score >= 65)) return "ready";
      return "monitor";
    }
    if (simEligible) return "act_now";
    if (owned) return "ready";
    return "monitor";
  }

  // 2026-06-22 — A position is "freshly signaled" if the model acted on it
  // (BUY / DCA_BUY / SELL) within the last 72h. Used to surface the card at
  // the front of its lane + flag it so a just-fired signal is easy to find.
  const FRESH_SIGNAL_WINDOW_MS = 72 * 60 * 60 * 1000;
  function hasFreshSignal(t) {
    const lastTs = Number(t?.position?.last_action_ts) || 0;
    if (lastTs <= 0) return false;
    if (Date.now() - lastTs > FRESH_SIGNAL_WINDOW_MS) return false;
    const lastType = String(t?.position?.last_action_type || "").toUpperCase();
    return ["BUY", "DCA_BUY", "SELL", "TRIM", "ADD"].includes(lastType);
  }

  // 2026-06-23 — "entered today" = position opened during the current ET
  // session. Surfaces a TODAY chip so a same-day entry is obvious at a glance
  // (operator: "add a chip for anything entered on the present day").
  function _etDateKey(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    try {
      return new Date(ts).toLocaleDateString("en-US", { timeZone: "America/New_York" });
    } catch (_) { return null; }
  }
  function isEnteredToday(t) {
    const firstTs = Number(t?.position?.first_entry_ts) || 0;
    if (firstTs <= 0) return false;
    const today = _etDateKey(Date.now());
    return !!today && _etDateKey(firstTs) === today;
  }

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
     RS HIGH badge. Stage + lane convey intent; no standalone BUY chip.
     Logo + monogram + 1H spark
     borrowed from window.DS just like DsCompactCard. */
  function InvestorCard({ t, onSelect, selectedTicker, savedTickers, toggleSavedTicker, entryPosture }) {
    const sym = String(t?.ticker || "").toUpperCase();
    const stage = t.stage || "research_avoid";
    const score = Number(t.score) || 0;
    const rank = Number(t?.rank_position ?? t?.rp) || null;
    const liveStagePending = t._live_stage_pending && typeof t._live_stage_pending === "object"
      ? t._live_stage_pending : null;
    const _dc = getDailyChange(t);
    const dayPct = Number.isFinite(_dc?.dayPct) ? Number(_dc.dayPct) : null;
    const dayChg = Number.isFinite(_dc?.dayChg) ? Number(_dc.dayChg) : null;
    const price = Number(window.TimedPriceUtils?.getHeadlinePrice?.(t) ?? t?.price ?? t?.close) || null;
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
    const recentlyExited = t.recentlyExited && typeof t.recentlyExited === "object" ? t.recentlyExited : null;
    const isExitedCard = String(t?.stage || "").toLowerCase() === "exited" || !!recentlyExited;
    const lastActionType = isOwned
      ? String(pos?.last_action_type || "")
      : (recentlyExited?.last_action_type ? String(recentlyExited.last_action_type) : "");
    const lastActionTs = isOwned
      ? Number(pos?.last_action_ts) || 0
      : Number(recentlyExited?.last_action_ts) || 0;
    const lastActionShares = isOwned
      ? Number(pos?.last_action_shares) || 0
      : Number(recentlyExited?.last_action_shares) || 0;
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
    const lastActionLabel = (() => {
      const raw = String(lastActionType || "").toUpperCase();
      if (!raw) return "";
      if (isExitedCard && raw === "SELL") return "EXIT";
      if (raw === "DCA_BUY") return "DCA";
      return raw;
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
    const isFreshSignal = hasFreshSignal(t);
    const STALE_DAYS = 7;
    const isAccumulateOrReduce = stage === "reduce" || stage === "accumulate";
    const isStaleSignal = isOwned
      && !isExitedCard
      && isAccumulateOrReduce
      && lastActionTs > 0
      && lastActionAgoMs > STALE_DAYS * 24 * 3600 * 1000
      && (
        (stage === "reduce" && lastActionType !== "SELL") ||
        (stage === "accumulate" && !["BUY", "DCA_BUY"].includes(lastActionType))
      );
    const actionTier = deriveActionTier(t);
    // 2026-06-16 — Pre-event pause: when the model is holding new entries ahead
    // of a macro event (FOMC/CPI/…), an Accumulate name that's normally ACT NOW
    // is NOT buy-now right now — show "PAUSED · <event>" + the model's reasoning
    // so the UI doesn't push users to enter into a name the model is standing
    // down on. Same gate the auto-rebalance add path uses (event_risk_window).
    const _entryPaused = !!(entryPosture && entryPosture.holdNewEntries
      && stage === "accumulate"
      && (actionTier === "act_now" || actionTier === "ready"));
    const tierMeta = _entryPaused
      ? { label: `PAUSED · ${entryPosture.eventKey || "EVENT"}`, color: "#f59e0b", title: entryPosture.guidance || "The model is holding new entries ahead of a macro event." }
      : (actionTier ? ACTION_TIER_META[actionTier] : null);
    const watchingLabel = (() => {
      if (!isOwned) return null;
      // Execution-ready names should not read "monitoring for trigger"
      // when the lane badge already says ACT NOW / READY.
      if (actionTier === "act_now" || actionTier === "ready") return null;
      if (isExitedCard) return null;
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

    /* Daily sparkline: same shared cache the Active Trader cards use. */
    const cachedSparkEntry = (typeof window !== "undefined" && typeof window._dsEnsureSparkline === "function")
      ? window._dsSparklineCache?.[sym] : null;
    if (typeof window !== "undefined" && typeof window._dsEnsureSparkline === "function") {
      window._dsEnsureSparkline(sym);
    }
    const cachedSpark = window.TTSparklineConfig?.sparkClosesFromCacheEntry?.(cachedSparkEntry)
      || (Array.isArray(cachedSparkEntry) ? cachedSparkEntry : cachedSparkEntry?.closes);
    const sparkPoints = (cachedSpark && cachedSpark.length >= 2)
      ? cachedSpark
      : (Array.isArray(t._sparkline) && t._sparkline.length >= 2 ? t._sparkline : [price || 0, price || 0]);
    const sparkSvg = (typeof window !== "undefined" && window.DS && Number.isFinite(price) && price > 0)
      ? window.DS.sparklineSvg(sparkPoints, { width: 280, height: 44, direction: dir, strokeWidth: 1.4 })
      : "";
    const patternChips = (() => {
      const candles = window.TTSparklineConfig?.sparkCandlesFromCacheEntry?.(cachedSparkEntry);
      const detect = window.TimedPatternDetect?.detectCandlePatterns;
      if (!candles || !detect) return [];
      return detect(candles).slice(0, 2);
    })();

    /* TT Selected highlight — same gold accent as DsCompactCard. */
    const isTTSel = (typeof window !== "undefined" && typeof window.isTickerTTSelected === "function")
      ? window.isTickerTTSelected(sym) : false;

    /* Earnings badge — same lookup as DsCompactCard. */
    const earnings = (typeof window !== "undefined" && window._ttEarningsMap) ? window._ttEarningsMap[sym] : null;
    const earnDays = earnings && Number.isFinite(earnings._daysAway) ? earnings._daysAway : null;
    const earnLabel = earnDays === 0 ? "Today" : earnDays === 1 ? "Tomorrow"
                    : earnDays != null && earnDays > 0 ? `${earnDays}d` : null;

    const cardStyle = {
      width: "100%",
      textAlign: "left",
      padding: "var(--ds-space-3)",
      // 2026-06-06 — execution-ready accumulate cards get a green left rail.
      // Suppressed during a pre-event pause (amber, not green — the model isn't
      // buying right now).
      ...(actionTier === "act_now" && !isSelected && !_entryPaused ? {
        borderLeft: "3px solid rgba(34,197,94,0.85)",
        boxShadow: "inset 3px 0 0 rgba(34,197,94,0.25)",
      } : {}),
      ...(actionTier === "ready" && !isSelected && actionTier !== "act_now" && !_entryPaused ? {
        borderLeft: "3px solid rgba(74,222,128,0.55)",
      } : {}),
      ...(_entryPaused && !isSelected ? {
        borderLeft: "3px solid rgba(245,158,11,0.7)",
        boxShadow: "inset 3px 0 0 rgba(245,158,11,0.18)",
      } : {}),
      // Owned positions get a violet halo (matches the Investor mode accent dot
      // on the section header). Selected / TT Selected take precedence.
      ...(isOwned && !isSelected && !isTTSel ? {
        borderColor: "rgba(167,139,250,0.55)",
        boxShadow: "inset 0 0 0 1px rgba(167,139,250,0.22), 0 0 0 1px rgba(167,139,250,0.08)",
        background: "linear-gradient(180deg, rgba(167,139,250,0.05) 0%, transparent 35%)",
      } : {}),
      ...(isSelected ? { borderColor: "var(--ds-text-display)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.2)" } : {}),
      ...(isTTSel && !isSelected ? { borderColor: "var(--ds-accent-dim)", boxShadow: "inset 0 0 0 1px rgba(56,242,161,0.18)" } : {}),
      // 2026-06-22 — Fresh-signal glow. A position the model acted on within
      // the last 72h gets a cyan ring so a just-fired signal is easy to spot
      // even in a wide lane (operator: "the card is hard to find").
      ...(isFreshSignal && !isSelected ? {
        boxShadow: "inset 0 0 0 1px rgba(103,232,249,0.45), 0 0 0 1px rgba(103,232,249,0.30), 0 0 14px rgba(103,232,249,0.18)",
      } : {}),
    };

    const LC = window.TTLaneCard;
    const extLine = LC?.extLineFromTicker ? LC.extLineFromTicker(t) : null;

    const midBody = (isOwned || isExitedCard) && React.createElement(React.Fragment, null,
      isOwned && React.createElement("div", {
        className: "tt-lane-card__pos",
        title: posShares > 0 && posAvg > 0 && livePnlPct != null
          ? `Open position: ${posShares.toFixed(posShares >= 10 ? 1 : 4)} sh @ $${posAvg.toFixed(2)} → live $${(price ?? 0).toFixed(2)} (${livePnlPct >= 0 ? "+" : ""}${livePnlPct.toFixed(2)}%)`
          : "Open investor position",
      },
        React.createElement("span", { className: "tt-lane-card__pos-label" }, "POS"),
        React.createElement("span", { className: "tt-lane-card__pos-muted" },
          posShares > 0 ? `${posShares >= 10 ? posShares.toFixed(1) : posShares.toFixed(4)} sh` : "—"),
        React.createElement("span", { className: "tt-lane-card__pos-muted" },
          posAvg > 0 ? `@ $${posAvg.toFixed(2)}` : ""),
        livePnlPct != null && React.createElement("span", {
          className: `tt-lane-card__pos-pnl tt-lane-card__pos-pnl--${pnlDir}`,
        }, `${livePnlPct >= 0 ? "+" : ""}${livePnlPct.toFixed(1)}%`),
      ),
      React.createElement("div", { className: "tt-lane-card__trace" },
        watchingLabel && React.createElement("div", {
          className: `tt-lane-card__trace-row tt-lane-card__trace-row--watch${isStaleSignal ? " tt-lane-card__trace-row--stale" : ""}`,
          title: `Model recommends "${stage}" \u2014 watching for the trigger condition. Last lot action was ${lastActionType || "none"}${lastActionTs ? ` on ${new Date(lastActionTs).toLocaleDateString()}` : ""}.${isStaleSignal ? " Signal is stale (>7d) — trailing-stop / consecutive-day trigger has not yet fired." : ""}`,
        },
          React.createElement("span", { className: "tt-lane-card__trace-label" }, isStaleSignal ? "STALE" : "WATCHING"),
          React.createElement("span", { className: "tt-lane-card__trace-text" }, watchingLabel),
        ),
        lastActionAgoLabel && React.createElement("div", {
          className: "tt-lane-card__trace-row tt-lane-card__trace-row--last",
          title: `Last model action: ${lastActionType} ${lastActionShares > 0 ? lastActionShares.toFixed(2) + " sh" : ""} on ${new Date(lastActionTs).toLocaleString()}.`,
        },
          React.createElement("span", { className: "tt-lane-card__trace-label" }, "LAST"),
          React.createElement("span", { className: "tt-lane-card__trace-text" },
            `${lastActionLabel}${lastActionShares > 0 ? " " + lastActionShares.toFixed(lastActionShares >= 10 ? 1 : 2) + "sh" : ""}`),
          React.createElement("span", { className: "tt-lane-card__trace-ago" }, lastActionAgoLabel),
        ),
      ),
    );

    const displayStage = resolveKanbanStage(t);
    const cardStatusChip = (() => {
      if (_entryPaused) {
        return {
          label: `PAUSED · ${entryPosture.eventKey || "EVENT"}`,
          color: "#f59e0b",
          title: entryPosture.guidance || "The model is holding new entries ahead of a macro event.",
        };
      }
      if (recentlyExited || displayStage === "exited") {
        const closedTs = Number(recentlyExited?.closed_at) || lastActionTs || 0;
        const hrs = closedTs > 0 ? Math.max(1, Math.round((Date.now() - closedTs) / 3600000)) : null;
        return {
          label: hrs != null ? `EXIT ${hrs}h` : "EXIT",
          color: "#f87171",
          title: "The model closed the full position. Held in Exited through the cooldown window before re-entry is considered.",
        };
      }
      if (isStaleSignal) {
        return { label: "STALE", color: "#f59e0b", title: "Signal active >7d without a matching lot action" };
      }
      if (displayStage === "accumulate_queued") {
        return {
          label: "QUEUED",
          color: "#94a3b8",
          title: "Execution-ready accumulate — the model has not entered yet. It opens on the next rebalance if still qualified. New entries are tranched (max 3 new positions per day), so a queued name may wait for the next session.",
        };
      }
      if (displayStage === "accumulate_entered") {
        return {
          label: "ENTERED",
          color: "#22c55e",
          title: "Model opened or added this position on a prior rebalance.",
        };
      }
      if (displayStage === "reduce" && tierMeta) {
        return { label: tierMeta.label, color: tierMeta.color, title: tierMeta.title };
      }
      return null;
    })();

    return LC.create({
      sym,
      button: {
        onClick: () => onSelect && onSelect(sym),
        onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect && onSelect(sym); } },
        style: cardStyle,
        className: isOwned ? "tt-lane-card--owned" : "",
      },
      isTTSel,
      chipRow: [
        cardStatusChip && React.createElement("span", {
          className: "ds-chip ds-chip--sm",
          style: {
            fontFamily: "var(--tt-font-mono)",
            color: cardStatusChip.color,
            background: `${cardStatusChip.color}18`,
            borderColor: `${cardStatusChip.color}55`,
            fontWeight: 700,
            letterSpacing: "0.04em",
          },
          title: cardStatusChip.title,
        }, cardStatusChip.label),
        // TT Weighting — published weight in the TT universe buy-list (not entry P&L).
        t.fsd?.isPick && React.createElement("span", {
          className: "ds-chip ds-chip--sm",
          style: {
            fontFamily: "var(--tt-font-mono)",
            color: t.fsd.tier === "strong" ? "rgb(56,242,161)" : "var(--tt-text-muted)",
            background: t.fsd.tier === "strong" ? "rgba(56,242,161,0.16)" : "rgba(56,242,161,0.07)",
            borderColor: "rgba(56,242,161,0.45)",
            fontWeight: 800,
            letterSpacing: "0.04em",
          },
          title: t.fsd.maxWeight
            ? `TT Weighting — ${t.fsd.maxWeight}% weight in the TT universe model portfolio. Investor entries anchor on this published weighting.`
            : "TT Weighting — on the TT universe buy-list. Investor entries anchor on this published weighting.",
        }, t.fsd.maxWeight ? `TT ${t.fsd.maxWeight}%` : "TT"),
        isOwned && isEnteredToday(t) && React.createElement("span", {
          className: "ds-chip ds-chip--sm",
          style: {
            fontFamily: "var(--tt-font-mono)",
            color: "rgb(134,239,172)",
            background: "rgba(34,197,94,0.16)",
            borderColor: "rgba(34,197,94,0.5)",
            fontWeight: 800,
            letterSpacing: "0.05em",
          },
          title: "The model opened this position today.",
        }, "TODAY"),
        t.rs?.rsNewHigh3m && React.createElement("span", {
          className: "ds-chip ds-chip--sm ds-chip--accent",
          style: { fontFamily: "var(--tt-font-mono)" },
          title: "Relative strength made a new 3-month high",
        }, "RS HI"),
        earnLabel && React.createElement("span", {
          className: "ds-chip ds-chip--sm ds-chip--accent",
          style: { fontFamily: "var(--tt-font-mono)" },
          title: `Earnings ${earnings?.date || ""} ${earnings?.hour || ""}`,
        }, `EPS ${earnLabel}`),
        ...patternChips.map((p) => React.createElement("span", {
          key: p.type,
          className: "ds-chip ds-chip--sm",
          style: {
            fontFamily: "var(--tt-font-mono)",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.04em",
            color: p.bias === "bullish" ? "var(--tt-up-soft, #34d399)" : p.bias === "bearish" ? "var(--tt-dn-soft, #f87171)" : "var(--tt-text-muted)",
            borderColor: p.bias === "bullish" ? "rgba(56,242,161,0.35)" : p.bias === "bearish" ? "rgba(248,113,113,0.35)" : undefined,
          },
          title: p.tooltip,
        }, `${p.icon} ${p.type}`)),
      ].filter(Boolean),
      quote: { price, dayPct, dayChg, dir, extLine },
      midBody: isOwned ? midBody : null,
      sparkSvg,
      metrics: LC?.rankScoreMetricChips
        ? LC.rankScoreMetricChips({
          rank,
          score: Number.isFinite(score) && score > 0 ? Math.round(score) : null,
          scoreUpAt: 70,
          scoreAccentAt: 50,
          scoreTitle: "Composite investor score (0-100)",
        })
        : [],
      isSaved,
      onToggleSaved: toggleSavedTicker,
    });
  }

  function InvestorKanbanBandHeader({ band, label, hint }) {
    return React.createElement("div", {
      className: `at-kanban-band at-kanban-band--${band}`,
      style: { margin: "12px 0 6px", padding: "0 4px" },
    },
      React.createElement("span", {
        style: {
          fontSize: 10, fontWeight: 800, letterSpacing: "0.14em", textTransform: "uppercase",
          color: band === "doing" ? "#fdba74" : "#6E867D",
        },
      }, label),
      hint && React.createElement("span", {
        style: { fontSize: 11, color: "#51635A", marginLeft: 10 },
      }, hint),
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

    // 2026-05-30 — Responsive layout. On mobile (<md / 768px) the lane
    // stacks: gutter sits on TOP as a full-width header row, cards
    // scroll horizontally BELOW with the full viewport width. Mirrors
    // the Active Trader pattern (active-trader.html .lane media query
    // at line ~274) and frees ~88px of width per card on phones.
    // Desktop unchanged — gutter on the left.
    return React.createElement("div", { className: "flex flex-col md:flex-row items-stretch gap-0 mb-2 md:mb-0.5 kanban-lane inv-kanban-lane", "data-lane": laneKey },
      // V15 P0.7.144/.152 — gutter shows lane title + action chip +
      // count. On desktop: vertical column on the left. On mobile:
      // horizontal strip on top so the cards below get the full width.
      React.createElement("div", {
        className: "flex flex-row md:flex-col items-center justify-between md:justify-center w-full md:w-[88px] md:min-w-[88px] md:shrink-0 border-b md:border-b-0 md:border-r border-white/[0.04] px-2.5 md:px-1.5 py-1.5 md:py-2 gap-2 md:gap-0",
        style: { background: "transparent" },
        title: hint || title,
      },
        React.createElement("span", { className: "text-[10px] md:text-[9px] font-bold uppercase tracking-wider text-[#94a3b8] md:text-[#51635A] md:text-center leading-tight break-words" }, title),
        React.createElement("div", { className: "flex flex-row md:flex-col items-center gap-2 md:gap-1" },
          action && React.createElement("span", {
            className: "text-[9px] md:text-[8px] font-bold tabular-nums md:mt-1 px-1.5 md:px-1 py-[1px] rounded",
            style: {
              color: actionColor,
              background: `${actionColor}14`,
              border: `1px solid ${actionColor}30`,
              letterSpacing: "0.04em",
              fontFamily: "var(--tt-font-mono)",
            },
          }, action),
          React.createElement("span", {
            className: `text-[12px] md:text-[11px] font-bold tabular-nums md:mt-1 ${(typeof count === "number" ? count > 0 : String(count || "").length > 0 && String(count) !== "0" && String(count) !== "0/0") ? "text-[#E8F2EC]" : "text-[#51635A] md:text-[#2a2e35]"}`,
            title: typeof count === "string" && count.includes("/") ? `${count.split("/")[0]} owned of ${count.split("/")[1]} in lane` : undefined,
          }, count),
        ),
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
          ? React.createElement("div", { className: "flex gap-1.5 items-stretch inv-kanban-cards" },
              items.slice(0, 80).map(t => React.createElement("div", { key: t.ticker, className: "kanban-card inv-kanban-card shrink-0" }, renderCard(t))),
            )
          : React.createElement("div", { className: "text-[10px] text-[#51635A] italic flex items-center h-full px-2 min-h-[80px]" },
              laneKey === "accumulate_queued"
                ? "No queued accumulate names — monitor-tier signals sit in On Radar or Hold & Watch"
                :               laneKey === "accumulate_entered"
                ? "No entered accumulate positions yet this cycle"
                : laneKey === "exited"
                ? "No exits today — full closes appear here for the session"
                : "No tickers"),
      ),
    );
  }

  function ActionKanban({ tickers, onSelect, selectedTicker, savedTickers, toggleSavedTicker, entryPosture }) {
    const laneScrollRef = useRef({});
    const _entryHold = !!(entryPosture && entryPosture.holdNewEntries);
    /* V15 P0.7.152 (2026-05-14) — lane order follows the action arc.
       User spec: "We need to present the lanes in order of action:
       On Radar → Accumulate → Core Hold → Hold & Watch → Reduce →
       Exited → Low Conviction → Avoid."
       The reasoning: the user reads top-down and the lanes should
       trace the lifecycle of a name from "I'm watching this"
       through "I own it and the model is managing it" through "the
       model has cooled off on this".
    */
    const stages = ["research_on_watch", "accumulate_queued", "accumulate_entered", "core_hold", "watch", "reduce", "exited", "research_low", "research_avoid"];
    /* V15 P0.7.144/.152 — lane labels + per-lane action chip.
       The action chip ("BUY NOW" / "HOLDING" / etc.) sits next to
       the lane title so a new user can answer "what should I do
       with this lane?" in 1 second without reading the tooltip.
    */
    const stageMeta = {
      research_on_watch: { label: "On Radar", band: "watching", action: "WAIT", actionColor: "#8AA39A", title: "Not owned — moderate score. Worth tracking; revisit if it moves into Accumulate." },
      accumulate_queued: { label: "Queued", band: "doing", action: "NEXT REBAL", actionColor: "#94a3b8", title: "Execution-ready accumulate — model has not entered yet. Waits for the next rebalance if still qualified." },
      accumulate_entered: { label: "Entered", band: "doing", action: "HELD", actionColor: "#22c55e", title: "Model opened or added this position on a prior rebalance." },
      core_hold:         { label: "Core Hold", band: "doing", action: "HOLDING", actionColor: "#60a5fa", title: "Owned core position — trend and strength remain solid. Model says: do nothing, let it run." },
      watch:             { label: "Hold & Watch", band: "doing", action: "HOLDING", actionColor: "#60a5fa", title: "Owned — signals are mixed. Model says: stay with current position, don't add or trim." },
      reduce:            { label: "Reducing", band: "doing", action: "TRIM SOON", actionColor: "#fb923c", title: "Owned — showing weakness. Model says: trim when the trigger condition fires (partial size reduction)." },
      exited:            { label: "Exited", band: "doing", action: "CLOSED", actionColor: "#f87171", title: "Full position closed today — held here through the cooldown window. Not an open trim." },
      research_low:      { label: "Low Conviction", band: "watching", action: "WAIT", actionColor: "#8AA39A", title: "Not owned — low conviction. Not actionable yet." },
      research_avoid:    { label: "Avoid", band: "watching", action: "SKIP", actionColor: "#6E867D", title: "Not owned — weak signals. System advises caution." },
    };
    const grouped = {};
    for (const s of stages) grouped[s] = [];
    for (const t of tickers) {
      const stage = resolveKanbanStage(t);
      if (grouped[stage]) grouped[stage].push(t);
    }
    // Phase 3.9l — within each lane, push owned positions to the front so
    // user's actual portfolio is the first thing they see horizontally.
    // 2026-06-06 — Accumulate/Reduce: sort by action tier (act_now first)
    // then score DESC so execution-ready names surface in wide lanes.
    for (const s of stages) {
      grouped[s].sort((a, b) => {
        // 2026-06-22 — Fresh-signal first. Operator: when a signal fires on
        // a recently opened position, its card was hard to find buried in a
        // wide lane. A position actioned within the last 72h jumps to the
        // front of its lane so the just-fired signal is the first card.
        const aFresh = hasFreshSignal(a);
        const bFresh = hasFreshSignal(b);
        if (aFresh !== bFresh) return aFresh ? -1 : 1;
        if (s === "accumulate_queued" || s === "accumulate_entered" || s === "reduce") {
          const aTier = ACTION_TIER_ORDER[deriveActionTier(a)] ?? 9;
          const bTier = ACTION_TIER_ORDER[deriveActionTier(b)] ?? 9;
          if (aTier !== bTier) return aTier - bTier;
        }
        const aOwned = !!(a?.position?.owned);
        const bOwned = !!(b?.position?.owned);
        if (aOwned !== bOwned) return aOwned ? -1 : 1;
        return (Number(b?.score) || 0) - (Number(a?.score) || 0);
      });
    }
    const renderCard = (t) => React.createElement(InvestorCard, { key: t.ticker, t, onSelect, selectedTicker, savedTickers: savedTickers || new Set(), toggleSavedTicker, entryPosture });

    /* V2.1 round 5 (2026-05-01) — Per user: "nothing is ever in any
       other lanes". Hide lanes that have zero tickers so the layout
       focuses on the actionable rows. Always-show core_hold + accumulate
       + reduce + watch (the "decision-making" lanes); collapse the
       research_* lanes when empty. */
    const ALWAYS_SHOW = new Set(["research_on_watch", "accumulate_queued", "accumulate_entered", "core_hold", "watch", "reduce", "exited"]);
    const visibleStages = stages.filter(s => ALWAYS_SHOW.has(s) || grouped[s].length > 0);

    /* 2026-06-01 — owned-aware lane counts.
       For HOLDING lanes (core_hold, watch, reduce) the gutter shows the
       OWNED count so "HOLDING N" actually means "you own N positions in
       this lane". If a lane contains items that aren't owned (e.g.
       research signals showing alongside holdings — currently rare after
       the demote fix above, but defense-in-depth) the gutter shows
       "owned/total". For non-HOLDING lanes the count is the lane total
       (semantics unchanged). */
    const HOLDING_LANES = new Set(["core_hold", "watch", "reduce"]);
    const laneCount = (stage) => {
      const items = grouped[stage] || [];
      if (stage === "accumulate_queued" || stage === "accumulate_entered" || stage === "reduce") {
        const act = items.filter((t) => {
          const tier = deriveActionTier(t);
          return tier === "act_now" || tier === "ready";
        }).length;
        if (act > 0 && act < items.length) return `${act} act / ${items.length}`;
        if (act > 0) return `${act} act`;
        return items.length;
      }
      if (!HOLDING_LANES.has(stage)) return items.length;
      const owned = items.filter(t => !!(t?.position?.owned)).length;
      if (owned === items.length) return owned;
      return `${owned}/${items.length}`;
    };
    const renderLaneColumn = (stage) => React.createElement(InvestorKanbanColumn, {
      key: stage,
      laneKey: stage,
      title: stageMeta[stage].label,
      hint: (stage === "accumulate_queued" && _entryHold) ? (entryPosture.guidance || stageMeta[stage].title) : stageMeta[stage].title,
      action: (stage === "accumulate_queued" && _entryHold) ? `PAUSED · ${entryPosture.eventKey || "EVENT"}` : stageMeta[stage].action,
      actionColor: (stage === "accumulate_queued" && _entryHold) ? "#f59e0b" : stageMeta[stage].actionColor,
      icon: stageMeta[stage].icon,
      color: stageMeta[stage].color,
      count: laneCount(stage),
      items: grouped[stage],
      renderCard,
      laneScrollRef,
    });
    return React.createElement("div", { className: "flex-1 overflow-y-auto space-y-1 min-h-0", "data-coachmark": "action-board" },
      visibleStages.map(renderLaneColumn),
    );
  }

  function MarketHealthBar({ health, loading }) {
    if (!health) return React.createElement("div", { className: "card p-4 mb-4" },
      React.createElement("div", { className: "text-[#6E867D] text-sm" }, loading ? "Loading market health…" : "Market health data hasn't been calculated yet. It updates automatically during market hours.")
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
        React.createElement("div", { className: "text-[10px] text-[#6E867D] uppercase tracking-wide" }, label),
        React.createElement("div", { className: "flex items-baseline justify-center gap-1" },
          React.createElement("span", { className: "text-base font-semibold text-white" }, typeof v === "number" ? v : v),
          (typeof v === "number" && label !== "Long-Term") && React.createElement("span", { className: "text-[10px] font-semibold", style: { color: c } }, w),
        ),
        React.createElement("div", { className: "text-[9px] text-[#51635A] mt-0.5" }, desc),
      );
    };
    return React.createElement("div", { className: "card p-4 mb-4 fade-in" },
      React.createElement("div", { className: "flex items-center justify-between mb-1" },
        React.createElement("div", { className: "flex items-center gap-3" },
          /* 2026-06-10 — Verda unification: Manrope section headline. */
          React.createElement("h2", {
            className: "tt-sec-h",
            style: { margin: 0, fontFamily: "var(--tt-font-display)", fontSize: 15 },
          }, "Market Health"),
          React.createElement(RegimeBadge, { regime }),
        ),
        React.createElement("div", { className: "flex items-center gap-2" },
          React.createElement("span", { className: "text-2xl font-bold", style: { color } }, Number.isFinite(score) ? score : "—"),
          React.createElement("span", { className: "text-[#6E867D] text-xs" }, "/ 100"),
        ),
      ),
      React.createElement("div", { className: "text-[11px] text-[#6E867D] mb-2" }, "How healthy is the overall stock market right now? Combines breadth, regime, trend strength, and sector participation."),
      React.createElement(ScoreBar, { score, color }),
      React.createElement("div", { className: "grid grid-cols-2 sm:grid-cols-5 gap-3 mt-3" },
        MetricCell("Participation", components?.breadth, "Stocks above key EMAs", (v) => v >= 20 ? "#00e676" : v >= 10 ? "#fbbf24" : "#f87171"),
        MetricCell("Market Mode", components?.regimeScore, "SPY/QQQ swing regime", (v) => v >= 20 ? "#00e676" : v >= 10 ? "#fbbf24" : "#f87171"),
        MetricCell("Trend Strength", components?.trendMomentum, "Weekly structure avg", (v) => v >= 20 ? "#00e676" : v >= 10 ? "#fbbf24" : "#f87171"),
        MetricCell("Sector Health", components?.sectorHealth, "Bullish sectors count", (v) => v >= 10 ? "#00e676" : v >= 5 ? "#fbbf24" : "#f87171"),
        React.createElement("div", { key: "lt", className: "text-center" },
          React.createElement("div", { className: "text-[10px] text-[#6E867D] uppercase tracking-wide" }, "Long-Term"),
          React.createElement("div", { className: "flex items-baseline justify-center gap-1" },
            React.createElement("span", { className: "text-base font-semibold text-white" }, breadth?.pctAboveW200 != null ? `${breadth.pctAboveW200}%` : "—"),
            breadth?.pctAboveW200 != null && React.createElement("span", {
              className: "text-[10px] font-semibold",
              style: { color: (breadth.pctAboveW200 >= 60 ? "#00e676" : breadth.pctAboveW200 >= 40 ? "#fbbf24" : "#f87171") },
            }, breadth.pctAboveW200 >= 60 ? "Healthy" : breadth.pctAboveW200 >= 40 ? "Fair" : "Weak"),
          ),
          React.createElement("div", { className: "text-[9px] text-[#51635A] mt-0.5" }, "Above 200-week avg"),
        ),
      ),
      computedAt && React.createElement("div", { className: "text-[9px] text-[#51635A] mt-2" }, "Updated ", fmtTime(computedAt)),
    );
  }

  /* Search + filter row — rendered directly above the kanban lanes so
     operators can narrow the board without scrolling past account stats. */
  const INVESTOR_RECENT_DAYS = 5;
  const INVESTOR_RECENT_WINDOW_MS = INVESTOR_RECENT_DAYS * 86400000;

  function formatInvestorActionAgo(ms) {
    const d = Math.floor(ms / 86400000);
    if (d >= 1) return `${d}d ago`;
    const h = Math.floor(ms / 3600000);
    if (h >= 1) return `${h}h ago`;
    const m = Math.floor(ms / 60000);
    return m >= 1 ? `${m}m ago` : "just now";
  }

  function filterRecentInvestorActions(actions, nowMs, windowMs) {
    return (actions || []).filter((a) => nowMs - Number(a.ts) <= windowMs);
  }

  function isInvestorBuySideLotAction(actionType) {
    const act = String(actionType || "").toUpperCase();
    return act === "BUY" || act === "DCA_BUY" || act === "ADD";
  }

  function BriefStripTickerLogo({ sym, size = 18 }) {
    const ref = useRef(null);
    const SYM = String(sym || "").toUpperCase();
    const mono = SYM.slice(0, 2) || "?";
    const bg = useMemo(() => {
      let hash = 0;
      for (let i = 0; i < SYM.length; i++) hash = ((hash << 5) - hash) + SYM.charCodeAt(i);
      return `hsl(${Math.abs(hash) % 360}, 35%, 28%)`;
    }, [SYM]);
    useEffect(() => {
      const el = ref.current;
      if (!el || el.dataset.dsInit) return;
      el.dataset.dsInit = "1";
      const url = SYM && window.DS
        ? window.DS.tickerLogoUrl(SYM)
        : (SYM ? `/timed/logo/${encodeURIComponent(SYM)}.png` : null);
      if (!url) return;
      const img = new Image();
      img.src = url;
      img.alt = SYM;
      img.style.width = "100%";
      img.style.height = "100%";
      img.style.borderRadius = "50%";
      img.style.objectFit = "cover";
      img.onload = () => {
        while (el.firstChild) el.removeChild(el.firstChild);
        el.style.background = "#ffffff";
        el.style.color = "transparent";
        el.appendChild(img);
      };
    }, [SYM]);
    return React.createElement("span", {
      ref,
      className: "tt-trow__logo",
      style: {
        width: size,
        height: size,
        background: bg,
        fontSize: Math.max(8, Math.round(size * 0.38)),
        color: "#fff",
      },
    }, mono);
  }

  function InvestorBriefStrip({ title, children }) {
    if (!children || (Array.isArray(children) && children.length === 0)) return null;
    return React.createElement("div", { className: "tt-investor-brief-strip", style: { marginTop: "var(--ds-space-2)" } },
      React.createElement("div", { className: "tt-sec-title", style: { marginBottom: 6 } }, title),
      React.createElement("div", { className: "tt-strip-scroll" }, children),
    );
  }

  function InvestorBriefTickerChip({ sym, sub, title, onClick, borderColor }) {
    const SYM = String(sym || "").toUpperCase();
    if (!SYM) return null;
    return React.createElement("button", {
      type: "button",
      className: "tt-strip-chip",
      title: title || SYM,
      onClick: () => onClick && onClick(SYM),
      style: borderColor ? { borderColor } : undefined,
    },
      React.createElement(BriefStripTickerLogo, { sym: SYM, size: 18 }),
      React.createElement("span", {
        style: { fontWeight: 700, fontSize: 12, fontFamily: "var(--tt-font-mono)" },
      }, SYM),
      sub && React.createElement("span", { style: { fontSize: 10, color: "var(--tt-text-dim)" } }, sub),
    );
  }

  function InvestorSearchRow({ searchQuery, onSearchQueryChange, filterGroup, onFilterGroupChange, chipCounts, savedCount }) {
    const q = searchQuery || "";
    return React.createElement("section", { className: "tt-row inv-controls", style: { marginTop: 8, marginBottom: 12 } },
      React.createElement("div", { className: "inv-search-wrap" },
        React.createElement("svg", {
          width: 14, height: 14, viewBox: "0 0 24 24", fill: "none",
          stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
          className: "inv-search-icon",
        },
          React.createElement("circle", { cx: 11, cy: 11, r: 8 }),
          React.createElement("line", { x1: 21, y1: 21, x2: 16.65, y2: 16.65 }),
        ),
        React.createElement("input", {
          type: "text",
          className: "inv-search",
          placeholder: "Search tickers (e.g. NVDA or NVDA, MSFT, TSLA)",
          value: q,
          onChange: (e) => onSearchQueryChange && onSearchQueryChange(e.target.value),
          "aria-label": "Search Investor tickers",
        }),
        q && React.createElement("button", {
          className: "inv-search-clear",
          onClick: () => onSearchQueryChange && onSearchQueryChange(""),
          "aria-label": "Clear search",
          title: "Clear",
        }, "\u00D7"),
      ),
      React.createElement("div", { className: "inv-filter-chips" },
        React.createElement("button", {
          className: "inv-chip" + (filterGroup === null ? " active" : ""),
          onClick: () => onFilterGroupChange && onFilterGroupChange(null),
        }, "All"),
        React.createElement("button", {
          className: "inv-chip" + (filterGroup === "INVESTOR_ACTIONABLE" ? " active" : ""),
          onClick: () => onFilterGroupChange && onFilterGroupChange("INVESTOR_ACTIONABLE"),
          title: "Tickers in Accumulate or Reduce — the model has an active recommendation",
        }, `Actionable${chipCounts.actionable > 0 ? ` (${chipCounts.actionable})` : ""}`),
        React.createElement("button", {
          className: "inv-chip" + (filterGroup === "EXECUTE_READY" ? " active" : ""),
          onClick: () => onFilterGroupChange && onFilterGroupChange("EXECUTE_READY"),
          title: "Accumulate/Reduce names the model would prioritize — ACT NOW or READY",
        }, `Execute-ready${chipCounts.executeReady > 0 ? ` (${chipCounts.executeReady})` : ""}`),
        React.createElement("button", {
          className: "inv-chip" + (filterGroup === "SIM_ELIGIBLE" ? " active" : ""),
          onClick: () => onFilterGroupChange && onFilterGroupChange("SIM_ELIGIBLE"),
          title: "Subset of Actionable the simulator would buy — Monthly SuperTrend bullish + \u22652 of (D, W, M) bullish",
        }, `Sim-eligible${(chipCounts.simEligible + chipCounts.simUnknown) > 0 ? ` (${chipCounts.simEligible}${chipCounts.simUnknown > 0 ? `+${chipCounts.simUnknown}?` : ""})` : ""}`),
        React.createElement("button", {
          className: "inv-chip" + (filterGroup === "SAVED" ? " active" : ""),
          onClick: () => onFilterGroupChange && onFilterGroupChange("SAVED"),
          title: "Saved tickers (star icon on any card)",
          disabled: !savedCount,
        }, `Saved${savedCount > 0 ? ` (${savedCount})` : ""}`),
      ),
    );
  }

  function InvestorPanel({ apiBase, onSelectTicker, savedTickers, toggleSavedTicker, selectedTicker, tickerData, searchQuery, filterGroup, onSearchQueryChange, onFilterGroupChange, allowedTickerSet, pendingTickerSymbols = [] }) {
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

    /* 2026-06-01 — position reconciliation INSIDE the 60 s polling loop.
       Previously this merge lived in investor.html's one-shot useEffect and
       was never passed to the panel (the panel ran its own fetchData every
       60 s and overwrote scores with /timed/investor/scores ONLY, losing
       the position metadata). Net effect: a position opened by auto-
       rebalance at 11:00 AM showed in Discord but the kanban cards stayed
       "not owned" forever because the scoring cron's cached payload
       predated the fill, and the 60 s refresh kept replaying that cached
       payload without merging the fresh /positions row.

       Now: every 60 s the panel also fetches /timed/investor/positions
       (compact mode) and stitches OPEN positions into the scores list. If
       a position's ticker is not in the scores payload (e.g. ETF outside
       the SECTOR_MAP, or a brand-new symbol), we synthesize an entry with
       the right stage so the kanban shows it as held. */
    const reconcileWithPositions = useCallback((scoresResp, positionsResp) => {
      if (!scoresResp?.ok) return scoresResp;
      const tickers = Array.isArray(scoresResp.tickers) ? [...scoresResp.tickers] : [];
      const seenOwned = new Set(
        tickers
          .filter(t => (t?.position || {}).owned)
          .map(t => String(t?.ticker || "").toUpperCase())
      );
      const positions = (positionsResp?.ok && Array.isArray(positionsResp.positions))
        ? positionsResp.positions : [];
      for (const p of positions) {
        const sym = String(p?.ticker || "").toUpperCase();
        if (!sym) continue;
        if (String(p?.status || "").toUpperCase() !== "OPEN") continue;
        if (!(Number(p?.total_shares) > 0)) continue;
        if (seenOwned.has(sym)) continue;
        const mark = Number(p?.currentPrice) || Number(p?.price) || 0;
        const avgEntry = Number(p?.avg_entry) || 0;
        const unrealizedPct = (mark > 0 && avgEntry > 0)
          ? ((mark - avgEntry) / avgEntry) * 100 : null;
        const defaultStage = (unrealizedPct == null || unrealizedPct >= -10)
          ? "core_hold" : "watch";
        const posBlock = {
          owned: true,
          shares: Number(p?.total_shares) || 0,
          avg_entry: avgEntry,
          cost_basis: Number(p?.cost_basis) || 0,
          first_entry_ts: Number(p?.first_entry_ts) || null,
          last_entry_ts: Number(p?.last_entry_ts) || null,
          unrealized_pct: unrealizedPct,
          last_action_type: p?.last_action_type || null,
          last_action_ts: Number(p?.last_action_ts) || null,
          last_action_shares: Number(p?.last_action_shares) || null,
          last_action_price: Number(p?.last_action_price) || null,
        };
        const existingIdx = tickers.findIndex(t => String(t?.ticker || "").toUpperCase() === sym);
        if (existingIdx >= 0) {
          tickers[existingIdx] = {
            ...tickers[existingIdx],
            position: posBlock,
            stage: tickers[existingIdx].stage === "research_on_watch"
              ? defaultStage : tickers[existingIdx].stage,
            _reconciled: true,
          };
        } else {
          tickers.push({
            ticker: sym,
            stage: defaultStage,
            stageReason: "Open position not in scored universe — reconciled from /timed/investor/positions",
            score: null,
            position: posBlock,
            sector: p?.sector || null,
            _reconciled_synthetic: true,
          });
        }
      }
      return { ...scoresResp, tickers };
    }, []);

    const fetchData = useCallback(async () => {
      setLoading(true);
      try {
        const [scoresResp, healthResp, positionsResp] = await Promise.all([
          fetch(`${base}/timed/investor/scores`, { credentials: "include" }).then(r => r.json()).catch(() => null),
          fetch(`${base}/timed/investor/market-health`).then(r => r.json()).catch(() => null),
          fetch(`${base}/timed/investor/positions?status=OPEN&compact=true`, { credentials: "include" }).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (scoresResp?.ok) setScores(reconcileWithPositions(scoresResp, positionsResp));
        if (healthResp?.ok) setHealth(healthResp);
      } catch (_) {}
      finally { setLoading(false); }
    }, [base, reconcileWithPositions]);

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
      const q = searchQuery && searchQuery.trim() ? searchQuery.trim() : "";
      const matchSearch = window.TTBubbleSearchUtils?.matchesTickerSearchQuery
        || ((sym, query) => !query || String(sym || "").toUpperCase().includes(String(query || "").trim().toUpperCase()));
      if (q) {
        list = list.filter((t) => matchSearch(t.ticker, q));
      }
      if (filterGroup === "SAVED" && savedTickers && savedTickers.size > 0) {
        list = list.filter(t => savedTickers.has(t.ticker));
      }
      if (filterGroup === "INVESTOR_ACTIONABLE") {
        list = list.filter((t) => {
          const raw = String(t?.stage || "").toLowerCase();
          if (raw === "reduce") return true;
          if (raw === "accumulate") return isExecuteReady(t);
          return false;
        });
      }
      // 2026-06-01 — Sim-eligible: Actionable + D/W/M SuperTrend
      // alignment matching the simulator's gate
      // (worker/index.js:36692-36698). Required: Monthly bullish AND
      // ≥2 of (D, W, M) bullish. stDir Pine convention: -1 = bullish.
      //
      // The scoring cron pre-computes `simEligible` + `_stDirD/W/M` on
      // each row of /timed/investor/scores. The /scores endpoint also
      // backfills these fields on the read path when the underlying
      // KV blob predates the field (returns `simEligible: null` to
      // mark "unknown — data not yet populated").
      //
      // Filter semantics:
      //   - simEligible === true  → INCLUDE
      //   - simEligible === false → EXCLUDE (gate explicitly failed)
      //   - simEligible === null  → INCLUDE as "unknown" (operator sees
      //     these so the lane doesn't go silently empty when the cron
      //     hasn't re-run since the field was added — the underlying
      //     simulator may or may not pick them up; better to surface
      //     than to hide). Operator clears the unknown bucket by
      //     POSTing /timed/investor/compute.
      if (filterGroup === "EXECUTE_READY") {
        list = list.filter((t) => {
          const stage = String(t?.stage || "").toLowerCase();
          if (stage !== "accumulate" && stage !== "reduce") return false;
          const tier = deriveActionTier(t);
          return tier === "act_now" || tier === "ready";
        });
      }
      if (filterGroup === "SIM_ELIGIBLE") {
        list = list.filter(t => {
          const stage = String(t?.stage || "").toLowerCase();
          if (stage !== "accumulate" && stage !== "reduce") return false;
          if (t?.simEligible === true) return true;
          if (t?.simEligible === false) return false;
          // null / undefined → unknown; keep visible but the panel
          // can render an indicator.
          // Try one more fallback before bailing — perhaps tickerData
          // has the structural fields even if the score row didn't.
          const td = tickerData?.[t.ticker] || {};
          const dStBull = (t?._stDirD ?? td?.tf_tech?.D?.stDir) === -1;
          const wStBull = (t?._stDirW ?? td?.tf_tech?.W?.stDir) === -1;
          const mStBull = (t?._stDirM ?? td?.monthly_bundle?.supertrend_dir) === -1;
          if (mStBull) {
            const bullCount = (dStBull ? 1 : 0) + (wStBull ? 1 : 0) + (mStBull ? 1 : 0);
            return bullCount >= 2;
          }
          // Treat as unknown — keep visible.
          return true;
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
        if (filterGroup === "SIM_ELIGIBLE") return;
        if (filterGroup === "EXECUTE_READY") return;
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

    const actionCount = useMemo(() => allTickers.filter((t) => {
      const s = resolveKanbanStage(t);
      return s === "accumulate_queued" || s === "accumulate_entered" || s === "reduce" || s === "core_hold" || s === "watch";
    }).length, [allTickers]);

    const chipCounts = useMemo(() => {
      let actionable = 0, simEligible = 0, simUnknown = 0, executeReady = 0;
      const list = Array.isArray(scores?.tickers) ? scores.tickers : [];
      const countNav = window.TTCountInvestorNavBadge;
      if (typeof countNav === "function") actionable = countNav(list);
      for (const row of list) {
        const stage = String(row?.stage || row?.investor_stage || "").toLowerCase();
        if (stage !== "accumulate" && stage !== "reduce") continue;
        if (typeof countNav !== "function") {
          if (stage === "reduce") actionable++;
          else if (stage === "accumulate") {
            const tier = String(row?.actionTier || "").toLowerCase();
            if (tier === "act_now" || tier === "ready") actionable++;
          }
        }
        const tier = row?.actionTier;
        if (tier === "act_now" || tier === "ready") executeReady++;
        if (row?.simEligible === true) simEligible++;
        else if (row?.simEligible == null) simUnknown++;
      }
      return { actionable, simEligible, simUnknown, executeReady };
    }, [scores]);

    /* V2.1 round 5 (2026-05-01) — Investor narrative.
       Per user: "we need to provide some additional narrative, much like the
       Daily Brief". Builds a short, plain-language paragraph from
       MarketHealth + lane counts + top-conviction names so users get
       context without having to read the chart. */
    /* V15 P0.7.144 (2026-05-13) — split the Investor Brief into:
       - Market summary (one sentence on regime + breadth)
       - Action summary (lane counts in plain English)
       - Recent actions (model lot actions across owned positions)
       - Watchlist highlights (buy zone + RS new highs)
       Returned as a structured object so the UI can render each piece
       in its own block (previous single-string layout was getting cut
       off at narrow widths). */
    const narrative = useMemo(() => {
      if (!allTickers.length) return null;
      const counts = { accumulate_queued: 0, accumulate_entered: 0, core_hold: 0, watch: 0, reduce: 0, exited: 0, research_on_watch: 0, research_low: 0, research_avoid: 0 };
      const buyZone = [];
      const rsHigh = [];
      const recentActions = [];
      for (const t of allTickers) {
        const s = resolveKanbanStage(t);
        if (counts[s] != null) counts[s] += 1;
        // Buy Zone strip — same universe as Today Ready Setups investor lane:
        // raw accumulate thesis (On Radar + Queued), excluding Avoid.
        const _buyZoneRow = window.TimedRailHelpers?.normalizeInvestorScoreRow?.(t, t.ticker) || t;
        if (window.TimedRailHelpers?.isInvestorBuyZoneThesis?.(_buyZoneRow, t.ticker)) {
          buyZone.push({ ticker: t.ticker, score: Number(t.score) || 0 });
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
      const recentBuys = filterRecentInvestorActions(recentActions, Date.now(), INVESTOR_RECENT_WINDOW_MS);
      const regimeWord = health?.regime === "RISK_ON" ? "bullish"
                       : health?.regime === "RISK_OFF" ? "bearish"
                       : "cautious";
      const score = Number(health?.score);
      const breadthPct = Number(health?.breadth?.pctAboveD200);
      const marketLine = `Market is ${regimeWord}${Number.isFinite(score) ? ` (Health ${Math.round(score)}/100)` : ""}` +
        `${Number.isFinite(breadthPct) ? `, with ${Math.round(breadthPct)}% of stocks above their 200-day MA` : ""}.`;
      buyZone.sort((a, b) => (b.score - a.score) || String(a.ticker).localeCompare(String(b.ticker)));
      const buyZoneTickers = buyZone.map((x) => x.ticker);
      const accumulateTotal = counts.accumulate_queued + counts.accumulate_entered;
      const actionable = accumulateTotal + counts.reduce;
      const actionLine = actionable > 0
        ? `${actionable} ${actionable === 1 ? "name is" : "names are"} actionable — ${counts.accumulate_queued} queued for rebalance, ${counts.accumulate_entered} entered, ${counts.reduce} flagged for Reduce. ${counts.core_hold} core hold${counts.core_hold === 1 ? "" : "s"}.`
        : buyZoneTickers.length > 0
          ? `${buyZoneTickers.length} ${buyZoneTickers.length === 1 ? "name has" : "names have"} an active accumulate / buy-zone thesis — model is monitoring for execution alignment. No rebalance queue or Reduce flags this pass.`
          : `No actionable Buy Zone or Reduce signals right now — model is letting current positions run.`;
      return {
        marketLine,
        actionLine,
        recentBuys,
        buyZone: buyZoneTickers,
        rsHigh,
      };
    }, [allTickers, health]);

    return React.createElement("div", { className: "space-y-4" },
      /* 2026-06-10 — Verda unification: eyebrow + Manrope headline pattern
         (matches today.html section headers). */
      React.createElement("div", { className: "flex items-center justify-between" },
        React.createElement("div", null,
          React.createElement("div", { className: "tt-sec-title" }, "ACTION BOARD"),
          React.createElement("h2", { className: "tt-sec-h", style: { margin: 0, fontFamily: "var(--tt-font-display)" } },
            `${actionCount} ticker${actionCount !== 1 ? "s" : ""} need attention`),
        ),
        React.createElement("button", {
          onClick: fetchData,
          className: "ds-chip ds-chip--sm",
          style: { fontFamily: "var(--tt-font-mono)" },
        }, loading ? "Loading\u2026" : "\u21BB Refresh"),
      ),
      React.createElement(MarketHealthBar, { health, loading }),
      /* 2026-06-16 — Pre-event ENTRY PAUSE banner. When the model is holding new
         entries ahead of a binary macro event (FOMC/CPI/…), explain WHY at the
         top of the page (model voice) so the Accumulate "PAUSED" badges have
         context and users aren't nudged to enter into a name the model is
         standing down on. Surfaces scores.entryPosture from /timed/investor/scores. */
      (() => {
        const ep = scores?.entryPosture;
        if (!ep || !ep.holdNewEntries) return null;
        const until = Number(ep.untilTs);
        const untilLabel = Number.isFinite(until) && until > 0
          ? new Date(until).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET"
          : null;
        return React.createElement("div", {
          style: {
            padding: "12px 16px", marginBottom: "var(--ds-space-3)", borderRadius: 10,
            border: "1px solid rgba(245,158,11,0.35)", background: "rgba(245,158,11,0.08)",
          },
        },
          React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" } },
            React.createElement("span", { style: { fontSize: 14 } }, "\u23F8"),
            React.createElement("span", { style: { fontWeight: 800, fontSize: 13, color: "#fbbf24", letterSpacing: "0.02em" } },
              `Model is holding new entries${ep.eventLabel ? ` ahead of ${ep.eventLabel}` : ""}`),
            untilLabel && React.createElement("span", { style: { fontSize: 11, color: "var(--ds-text-muted)", fontFamily: "var(--tt-font-mono)" } }, untilLabel),
          ),
          React.createElement("div", { style: { fontSize: 12.5, color: "var(--ds-text-body)", lineHeight: 1.5 } },
            ep.guidance || "The model is pausing new entries ahead of a macro event; Accumulate candidates stay queued and open once it clears."),
          React.createElement("div", { style: { fontSize: 10.5, color: "var(--ds-text-muted)", marginTop: 5 } },
            "Accumulate names show PAUSED until the event clears — this is guidance, not a buy signal right now."),
        );
      })(),
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
          className: "tt-sec-title",
          style: { marginBottom: "var(--ds-space-2)" },
        }, "INVESTOR BRIEF"),
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
          React.createElement(InvestorBriefStrip, { title: "RECENT BUYS" },
            narrative.recentBuys.map((a, i) => {
              const lbl = a.action === "DCA_BUY" ? "DCA" : a.action;
              const sh = a.shares > 0 ? `${a.shares.toFixed(a.shares >= 10 ? 1 : 2)}sh` : "";
              const ago = formatInvestorActionAgo(Date.now() - a.ts);
              const sub = [lbl, sh, ago].filter(Boolean).join(" \u00b7 ");
              const isBuy = isInvestorBuySideLotAction(a.action);
              return React.createElement(InvestorBriefTickerChip, {
                key: `${a.ticker}-${a.ts}-${i}`,
                sym: a.ticker,
                sub,
                title: `${lbl} ${a.ticker}${sh ? ` ${sh}` : ""} \u00b7 ${ago}`,
                onClick: onSelectTicker,
                borderColor: isBuy ? "rgba(52,211,153,0.4)" : "rgba(244,63,94,0.35)",
              });
            }),
          ),
          React.createElement(InvestorBriefStrip, { title: "FRESH 3M RS" },
            narrative.rsHigh.map((sym, i) => React.createElement(InvestorBriefTickerChip, {
              key: `rs${sym}-${i}`,
              sym,
              title: `${sym} \u00b7 fresh 3-month RS high`,
              onClick: onSelectTicker,
              borderColor: "rgba(59,130,246,0.4)",
            })),
          ),
          React.createElement(InvestorBriefStrip, { title: "BUY ZONE" },
            narrative.buyZone.map((sym, i) => React.createElement(InvestorBriefTickerChip, {
              key: `bz${sym}-${i}`,
              sym,
              title: `${sym} \u00b7 accumulate / buy-zone thesis`,
              onClick: onSelectTicker,
              borderColor: "rgba(52,211,153,0.4)",
            })),
          ),
        ),
      ),
      (onSearchQueryChange || onFilterGroupChange) && React.createElement(InvestorSearchRow, {
        searchQuery,
        onSearchQueryChange,
        filterGroup,
        onFilterGroupChange,
        chipCounts,
        savedCount: savedTickers?.size || 0,
      }),
      allTickers.length > 0
        ? React.createElement(ActionKanban, {
            tickers: allTickers,
            onSelect: onSelectTicker,
            selectedTicker,
            savedTickers: savedTickers || new Set(),
            toggleSavedTicker,
            entryPosture: scores?.entryPosture,
          })
        : React.createElement("div", { className: "card p-8 text-center text-[#6E867D]" },
            React.createElement("div", { className: "text-lg mb-2" }, "No investor data yet"),
            React.createElement("div", { className: "text-sm" }, "Stock scores are calculated every hour while the market is open. Check back soon."),
          ),
    );
  }

  /* Nav badge + chip counts: execution-ready accumulate + all reduce.
     Raw stage=accumulate monitor-tier names (e.g. GLD, DCI) are On Radar,
     not buy-now — they must not inflate the tab badge. */
  function countInvestorNavBadge(list) {
    let n = 0;
    const rows = Array.isArray(list) ? list : [];
    for (const t of rows) {
      if (!t || typeof t !== "object") continue;
      const stage = String(t.stage || t.investor_stage || "").toLowerCase();
      if (stage === "exited") continue;
      // Owned holdings count (mirrors the Trader tab badge = open-trade count)
      // so entering a position lights the Investor tab. Each ticker counts
      // once; unowned rows still count when actionable (reduce / buy-ready).
      if (t.position && t.position.owned) { n++; continue; }
      if (stage === "reduce") { n++; continue; }
      if (stage === "accumulate" && isExecuteReady(t)) n++;
    }
    return n;
  }

  window.InvestorPanel = InvestorPanel;
  window.TTInvestorLane = Object.assign({}, window.TTInvestorLane, {
    deriveActionTier,
    isExecuteReady,
    isAccumulateEntered,
    resolveKanbanStage,
    countInvestorNavBadge,
    filterRecentInvestorActions,
    isInvestorBuySideLotAction,
    INVESTOR_RECENT_DAYS,
    INVESTOR_RECENT_WINDOW_MS,
    formatInvestorActionAgo,
  });
  window.TTCountInvestorNavBadge = countInvestorNavBadge;
})();

// cache-bust:1783448042015:286974805
