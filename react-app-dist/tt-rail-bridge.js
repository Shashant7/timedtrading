/* tt-rail-bridge.js — activity strip / notifications → right rail handoff */
(function () {
  if (typeof window === "undefined") return;

  const API_BASE = window.TT_API_BASE || "";

  function parseUrlRailContext() {
    try {
      const u = new URL(window.location.href);
      const ticker = String(u.searchParams.get("ticker") || "").trim().toUpperCase();
      const initialRailTab = String(u.searchParams.get("railTab") || "").trim().toUpperCase() || null;
      const tradeId = String(u.searchParams.get("trade_id") || "").trim() || null;
      const evType = String(u.searchParams.get("ev") || "").trim().toUpperCase();
      const openAutopsy =
        u.searchParams.get("autopsy") === "1" ||
        (tradeId && (evType === "EXIT" || evType === "TRIM" || evType === "TRADE_EXIT" || evType === "TRADE_TRIM"));
      return { ticker, initialRailTab, tradeId, openAutopsy, evType };
    } catch (_) {
      return {};
    }
  }

  const DEEPLINK_KEY = "tt_rail_deeplink";
  const DEEPLINK_TTL_MS = 30 * 60 * 1000;

  function persistRailDeepLink(ctx) {
    if (!ctx?.ticker) return;
    try {
      sessionStorage.setItem(DEEPLINK_KEY, JSON.stringify({
        ticker: ctx.ticker,
        railTab: ctx.initialRailTab || null,
        tradeId: ctx.tradeId || null,
        openAutopsy: !!ctx.openAutopsy,
        evType: ctx.evType || null,
        ts: Date.now(),
      }));
    } catch (_) {}
  }

  function readPersistedRailDeepLink() {
    try {
      const raw = sessionStorage.getItem(DEEPLINK_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (!p?.ticker) return null;
      if (Date.now() - Number(p.ts || 0) > DEEPLINK_TTL_MS) {
        sessionStorage.removeItem(DEEPLINK_KEY);
        return null;
      }
      return p;
    } catch (_) {
      return null;
    }
  }

  function clearPersistedRailDeepLink() {
    try { sessionStorage.removeItem(DEEPLINK_KEY); } catch (_) {}
  }

  /** Persist URL params on load so login redirects can restore the rail target. */
  (function captureRailDeepLinkFromUrl() {
    const ctx = parseUrlRailContext();
    if (ctx.ticker) persistRailDeepLink(ctx);
  })();

  window.ttApplyPendingRailDeepLink = function ttApplyPendingRailDeepLink() {
    const urlCtx = parseUrlRailContext();
    // Only open from URL ?ticker= (or sessionStorage left by a login redirect
    // before the URL was restored). Never resurrect a ticker after the rail
    // was closed — ttClearRailUrlParams clears sessionStorage.
    const persisted = urlCtx.ticker ? null : readPersistedRailDeepLink();
    const ticker = urlCtx.ticker || persisted?.ticker;
    if (!ticker) return false;

    const initialRailTab = urlCtx.initialRailTab || persisted?.railTab || null;
    const tradeId = urlCtx.tradeId || persisted?.tradeId || null;
    const openAutopsy = urlCtx.openAutopsy || persisted?.openAutopsy || false;
    const evType = urlCtx.evType || persisted?.evType || null;

    window.ttOpenTickerInRail({
      ticker,
      initialRailTab,
      tradeId,
      openAutopsy,
      evType: evType || undefined,
      source: "deeplink",
    });
    clearPersistedRailDeepLink();
    return true;
  };

  window.ttActivityScopeOf = function ttActivityScopeOf(ev) {
    const mode = String(ev?.mode || "").toLowerCase();
    if (mode === "investor") return "investor";
    if (mode === "trader") return "trader";
    const t = String(ev?.type || "").toUpperCase();
    if (t === "INVESTOR_SIGNAL" || ev?.investor_alert_type) return "investor";
    const desk = String(ev?.desk || "").toLowerCase();
    if (desk === "investor") return "investor";
    return "trader";
  };

  window.ttResolveActivityRailTab = function ttResolveActivityRailTab(ev, opts) {
    const scope = opts?.scope || window.ttActivityScopeOf(ev);
    const evType = String(opts?.evType || ev?.type || "").toUpperCase();
    const invType = String(ev?.investor_alert_type || "").toLowerCase();

    if (scope === "investor") {
      if (invType === "position_close" || evType === "EXIT") return "HISTORY";
      if (ev?.position_open === false) return "HISTORY";
      if (ev?.position_open === true) return "INVESTOR";
      if (invType === "position_trim" || invType === "position_add") return "INVESTOR";
      return "HISTORY";
    }

    if (evType === "EXIT" || evType === "TRADE_EXIT" || evType === "SL_HIT") return "HISTORY";
    if (ev?.trade_open === false) return "HISTORY";
    if (ev?.trade_open === true) return "SNAPSHOT";
    if (evType === "TRIM" || evType === "TRADE_TRIM") return "SNAPSHOT";
    if (evType === "ENTRY" || evType === "ADD" || evType === "ADD_ENTRY" || evType === "TRADE_ENTRY") {
      return "SNAPSHOT";
    }
    return "HISTORY";
  };

  window.ttFetchPositionOpenState = async function ttFetchPositionOpenState(ticker, scope) {
    const sym = String(ticker || "").toUpperCase();
    if (!sym) return false;
    try {
      if (scope === "investor") {
        const r = await fetch(`${API_BASE}/timed/investor/ticker?ticker=${encodeURIComponent(sym)}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return false;
        const j = await r.json();
        return !!(j?.position?.owned && Number(j?.position?.shares) > 0);
      }
      const r = await fetch(`${API_BASE}/timed/trades?source=positions`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!r.ok) return false;
      const j = await r.json();
      const trades = Array.isArray(j?.trades) ? j.trades : [];
      return trades.some((t) => {
        if (String(t?.ticker || "").toUpperCase() !== sym) return false;
        try {
          return window.TimedPriceUtils?.isTradeOpen?.(t) ?? false;
        } catch (_) {
          const st = String(t?.status || "").toUpperCase();
          return st === "OPEN" || st === "TP_HIT_TRIM";
        }
      });
    } catch (_) {
      return false;
    }
  };

  window.ttOpenActivityInRail = async function ttOpenActivityInRail(opts) {
    const ticker = String(opts?.ticker || "").toUpperCase();
    if (!ticker) return;
    const ev = opts?.activityEvent || opts?.ev || null;
    const scope = opts?.scope || window.ttActivityScopeOf(ev);
    const evType = String(opts?.evType || "").toUpperCase() || null;
    let tab = opts?.initialRailTab ? String(opts.initialRailTab).toUpperCase() : null;

    if (!tab) tab = window.ttResolveActivityRailTab(ev, { scope, evType });

    const hasOpenFlag = ev && (ev.trade_open != null || ev.position_open != null);
    if (!hasOpenFlag) {
      const isOpen = await window.ttFetchPositionOpenState(ticker, scope);
      tab = isOpen ? (scope === "investor" ? "INVESTOR" : "SNAPSHOT") : "HISTORY";
    } else if (scope === "investor") {
      tab = ev.position_open ? "INVESTOR" : "HISTORY";
    } else {
      tab = ev.trade_open ? "SNAPSHOT" : "HISTORY";
    }

    const tradeId = opts?.tradeId || ev?.trade_id || ev?.tradeId || null;
    const closedEv = evType === "EXIT" || evType === "TRADE_EXIT" || evType === "SL_HIT"
      || String(ev?.investor_alert_type || "").toLowerCase() === "position_close";
    const openAutopsy = tab === "HISTORY" && (closedEv || evType === "TRIM" || evType === "TRADE_TRIM");

    window.ttOpenTickerInRail({
      ticker,
      initialRailTab: tab,
      tradeId,
      evType: evType || undefined,
      openAutopsy,
      activityEvent: ev,
      source: opts?.source || "activity",
    });

    persistRailDeepLink({
      ticker,
      initialRailTab: tab,
      tradeId,
      openAutopsy,
      evType,
    });

    setTimeout(() => {
      try {
        if (typeof window.ttGlobalSearchMarkHandled === "function") {
          window.ttGlobalSearchMarkHandled(ticker);
        }
      } catch (_) {}
      const p = String(window.location.pathname || "").toLowerCase();
      const onJourney = p.includes("active-trader") || p.includes("today")
        || p.includes("investor") || p.includes("portfolio");
      if (onJourney) return;
      if (window._ttGlobalSearchLastHandled === ticker) return;
      const q = new URLSearchParams({ ticker, railTab: tab });
      if (tradeId) q.set("trade_id", tradeId);
      if (openAutopsy) q.set("autopsy", "1");
      if (evType) q.set("ev", evType);
      window.location.href = `/active-trader.html?${q.toString()}`;
    }, 400);
  };

  window.ttOpenTickerInRail = function ttOpenTickerInRail(opts) {
    const ticker = String(opts?.ticker || "").toUpperCase();
    if (!ticker) return;
    const initialRailTab = opts?.initialRailTab != null
      ? (String(opts.initialRailTab || "").trim().toUpperCase() || null)
      : (opts?.tradeId || opts?.trade_id ? "HISTORY" : null);
    const tradeId = opts?.tradeId || opts?.trade_id || null;
    const evType = String(opts?.evType || opts?.type || "").toUpperCase();
    const openAutopsy =
      opts?.openAutopsy === true ||
      evType === "EXIT" ||
      evType === "TRIM" ||
      evType === "TRADE_EXIT" ||
      evType === "TRADE_TRIM";

    try {
      const u = new URL(window.location.href);
      u.searchParams.set("ticker", ticker);
      if (initialRailTab) u.searchParams.set("railTab", initialRailTab);
      else u.searchParams.delete("railTab");
      if (tradeId) u.searchParams.set("trade_id", tradeId);
      else u.searchParams.delete("trade_id");
      if (openAutopsy) u.searchParams.set("autopsy", "1");
      else u.searchParams.delete("autopsy");
      if (evType) u.searchParams.set("ev", evType);
      else u.searchParams.delete("ev");
      window.history.replaceState({ ttTicker: ticker }, "", u.toString());
    } catch (_) {}

    persistRailDeepLink({
      ticker,
      initialRailTab,
      tradeId,
      openAutopsy,
      evType,
    });

    window.dispatchEvent(
      new CustomEvent("tt-open-ticker", {
        detail: {
          ticker,
          initialRailTab,
          tradeId,
          openAutopsy,
          activityEvent: opts?.activityEvent || null,
          source: opts?.source || "rail-bridge",
          handled: true,
        },
        bubbles: true,
      }),
    );
    try {
      if (typeof window.ttGlobalSearchMarkHandled === "function") {
        window.ttGlobalSearchMarkHandled(ticker);
      }
    } catch (_) {}
  };

  window.ttParseRailOpenDetail = function ttParseRailOpenDetail(evOrDetail) {
    const d = evOrDetail?.detail || evOrDetail || {};
    const url = parseUrlRailContext();
    const ticker = String(d.ticker || url.ticker || "").toUpperCase();
    const initialRailTab = d.initialRailTab || url.initialRailTab || null;
    const tradeId = d.tradeId || d.trade_id || url.tradeId || null;
    const openAutopsy = d.openAutopsy === true || url.openAutopsy === true;
    const evType = String(d.evType || url.evType || "").trim().toUpperCase() || null;
    return { ticker, initialRailTab, tradeId, openAutopsy, evType, source: d.source || null };
  };

  window.ttClearRailUrlParams = function ttClearRailUrlParams() {
    try {
      clearPersistedRailDeepLink();
      const u = new URL(window.location.href);
      u.searchParams.delete("ticker");
      u.searchParams.delete("railTab");
      u.searchParams.delete("trade_id");
      u.searchParams.delete("autopsy");
      u.searchParams.delete("ev");
      window.history.replaceState({}, "", u.toString());
    } catch (_) {}
  };

  window.ttBuildAutopsyStubFromActivity = function ttBuildAutopsyStubFromActivity(ev, ticker) {
    const sym = String(ticker || ev?.ticker || "").toUpperCase();
    if (!sym) return null;
    const type = String(ev?.type || "").toUpperCase();
    return {
      ticker: sym,
      trade_id: ev?.trade_id || ev?.tradeId || null,
      direction: ev?.direction || null,
      entry_price: type === "ENTRY" || type === "ADD_ENTRY" || type === "TRADE_ENTRY" ? Number(ev?.price) : undefined,
      exit_price: type === "EXIT" || type === "TRADE_EXIT" ? Number(ev?.price) : undefined,
      trim_price: type === "TRIM" || type === "TRADE_TRIM" ? Number(ev?.price) : undefined,
      pnl: Number(ev?.pnl) || 0,
      pnl_pct: Number(ev?.pnl_pct ?? ev?.pnlPct) || 0,
      reason: ev?.reason || null,
      setup_grade: ev?.setup_grade || null,
      setup_name: ev?.setup_name || null,
    };
  };

  window.ttConsumeRailOpenForReact = function ttConsumeRailOpenForReact(evDetail) {
    const p = window.ttParseRailOpenDetail({ detail: evDetail });
    if (!p.ticker) return null;
    const initialRailTab = p.initialRailTab || (p.tradeId ? "HISTORY" : null);
    let openAutopsyForTrade = null;
    if (p.openAutopsy && p.tradeId) {
      openAutopsyForTrade =
        window.ttBuildAutopsyStubFromActivity(
          p.activityEvent || { trade_id: p.tradeId, ticker: p.ticker },
          p.ticker,
        ) || { ticker: p.ticker, trade_id: p.tradeId };
    }
    return {
      ticker: p.ticker,
      initialRailTab,
      highlightTradeId: p.tradeId,
      openAutopsyForTrade,
      railOpenSource: evDetail?.source || p.source || null,
    };
  };

  window.ttParseNotificationTicker = function ttParseNotificationTicker(n) {
    const link = String(n?.link || "");
    try {
      const u = new URL(link, window.location.origin);
      const t = u.searchParams.get("ticker");
      if (t) return String(t).toUpperCase();
    } catch (_) {}
    const title = String(n?.title || "");
    const m = title.match(/:\s*([A-Z][A-Z0-9.\-]{0,12})\s*$/);
    return m ? m[1].toUpperCase() : "";
  };

  window.ttOpenNotificationInRail = async function ttOpenNotificationInRail(n, opts) {
    if (!n) return;
    const ticker = window.ttParseNotificationTicker(n);
    if (!ticker) return;
    const scope = opts?.scope || (String(n?.type || "").startsWith("investor") || /investor/.test(String(n?.link || ""))
      ? "investor"
      : "trader");
    const nType = String(n?.type || "").toLowerCase();
    let evType = null;
    let invType = null;
    if (scope === "investor") {
      evType = "INVESTOR_SIGNAL";
      const title = String(n?.title || "").toLowerCase();
      if (/exit|closed/.test(title)) invType = "position_close";
      else if (/trim/.test(title)) invType = "position_trim";
      else invType = "position_add";
    } else if (nType === "trade_exit") evType = "EXIT";
    else if (nType === "trade_trim") evType = "TRIM";
    else if (nType === "trade_entry") evType = "ENTRY";
    const ev = scope === "investor"
      ? { type: "INVESTOR_SIGNAL", investor_alert_type: invType, mode: "investor" }
      : { type: evType, mode: "trader" };
    await window.ttOpenActivityInRail({
      ticker,
      scope,
      evType,
      activityEvent: ev,
      source: "notification",
    });
  };
})();

// cache-bust:1783489875799:768522958
