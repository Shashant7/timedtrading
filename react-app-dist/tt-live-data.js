// tt-live-data.js — shared live-data hooks for today / active-trader / investor
//
// Until 2026-05-26 the modern pages (today.html, active-trader.html,
// investor.html) loaded /timed/all exactly ONCE on mount and never refreshed.
// Prices, kanban stages, scores — all frozen until the user reloaded. The
// legacy index-react.source.html had a usePriceFeed + 3-min full-refresh
// loop; this module ports both as ~75-line shared hooks the three pages can
// drop in without restructuring their existing data state.
//
// Exports (on window.TimedLiveData):
//   usePriceFeed(data, setData, opts?)
//     - polls /timed/prices every 30s (default; opts.intervalMs overrides)
//     - merges price-only updates per ticker without touching kanban_stage,
//       htf_score, ltf_score, sl, tp, etc.
//     - writes _live_price, _live_prev_close, _price_updated_at,
//       _ah_price, _ah_change, _ah_change_pct, plus refreshes
//       day_change / day_change_pct.
//
//   useTickerRefresh(data, setData, opts?)
//     - polls /timed/all every 90s (default; opts.intervalMs overrides)
//     - merges refreshed scoring rows (kanban_stage, htf_score, ltf_score,
//       sl, tp, ts, rank, ...) per ticker into the existing data object.
//     - preserves _live_* + _ah_* fields written by usePriceFeed so a
//       polling collision doesn't roll back live prices.
//     - skips writes when nothing meaningful changed (cheap identity
//       check on ts + kanban_stage + scores + rank) so React's downstream
//       useMemo derivatives don't invalidate unnecessarily.
//
// Both hooks are no-ops until `data` is non-null + non-empty (so they
// don't race the initial /timed/all load).

(function () {
  if (typeof window === "undefined") return;
  if (window.TimedLiveData) return; // idempotent
  const React = window.React;
  if (!React?.useEffect) return; // React not yet loaded; consumers can include this anyway

  const { useEffect, useRef, useState, useCallback } = React;
  const API_BASE = window.location.origin;

  function readMs(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function useDataReady(data) {
    const [ready, setReady] = useState(false);
    useEffect(() => {
      if (ready) return;
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        setReady(true);
      }
    }, [data, ready]);
    return ready;
  }

  function readMarketOpen() {
    try { return window.TimedPriceUtils?.isNyRegularMarketOpen?.() ?? true; }
    catch (_) { return true; }
  }

  /** Vendor quote receipt — max(q_ts, p_ts, lastTs). Never poll `t` (GS zombie). */
  function quoteReceiptTs(p) {
    const q = Number(p?.q_ts) || 0;
    const pt = Number(p?.p_ts) || Number(p?.lastTs) || 0;
    if (q > 0 && pt > 0) return Math.max(q, pt);
    return q > 0 ? q : pt;
  }

  function applyPriceFeedOverlay(existing, p, marketOpen) {
    try {
      return window.TimedPriceUtils?.applyPriceFeedOverlay?.(existing, p, marketOpen) ?? null;
    } catch (_) {
      return null;
    }
  }

  function shouldApplyDayChangeFromTick(p, marketOpen) {
    try {
      return window.TimedPriceUtils?.shouldApplyDayChangeFromTick?.(p, marketOpen) ?? true;
    } catch (_) {
      return true;
    }
  }

  function priceReceiptMaxAgeMs(marketOpen) {
    return marketOpen ? 10 * 60 * 1000 : 26 * 60 * 60 * 1000;
  }

  /** Merge fresh /timed/all rows into prev while preserving live-price + EXT overlays. */
  function mergeTimedAllRefresh(prev, incoming) {
    if (!incoming || typeof incoming !== "object") return prev;
    if (!prev || typeof prev !== "object") return incoming;
    const next = { ...prev };
    let changed = false;
    const marketOpen = readMarketOpen();

    for (const [sym, row] of Object.entries(incoming)) {
      if (!row || typeof row !== "object") continue;
      const key = String(sym).toUpperCase();
      const existing = next[key];
      if (existing
          && existing.ts === row.ts
          && existing.kanban_stage === row.kanban_stage
          && existing.htf_score === row.htf_score
          && existing.ltf_score === row.ltf_score
          && existing.rank === row.rank
          && existing.sl === row.sl
          && existing.tp === row.tp) {
        continue;
      }
      const merged = { ...row };
      if (existing) {
        const overlayKeys = [
          "_live_price", "_live_prev_close", "_price_updated_at",
          "_price_value_ts", "_quote_receipt_ts",
          "_rth_session_close",
          "_ah_price", "_ah_change", "_ah_change_pct",
          "extended_price", "extended_percent_change", "extended_change",
        ];
        for (const k of overlayKeys) {
          if (existing[k] !== undefined) merged[k] = existing[k];
        }
        if (existing._price_updated_at && existing._price_updated_at > (row.ts || 0)) {
          if (existing._live_price !== undefined) {
            merged._live_price = existing._live_price;
            merged.price = existing._live_price;
          }
          if (!marketOpen) {
            if (existing.close !== undefined) merged.close = existing.close;
            else if (existing._live_price !== undefined) merged.close = existing._live_price;
          }
          if (existing.day_change !== undefined) merged.day_change = existing.day_change;
          if (existing.day_change_pct !== undefined) merged.day_change_pct = existing.day_change_pct;
          if (existing.change !== undefined) merged.change = existing.change;
          if (existing.change_pct !== undefined) merged.change_pct = existing.change_pct;
        } else if (!marketOpen && existing._ah_price !== undefined) {
          // Keep RTH headline separate from extended print after snapshot refresh.
          const rth = existing.close ?? existing._live_price ?? existing.price;
          if (rth > 0) {
            merged.price = rth;
            merged.close = rth;
            if (existing._live_price !== undefined) merged._live_price = existing._live_price;
          }
        }
      }
      next[key] = merged;
      changed = true;
    }
    return changed ? next : prev;
  }

  function shouldPausePageLiveUpdates() {
    return !!window.__ttRailOpenSym;
  }

  function usePriceFeed(data, setData, opts) {
    const intervalMs = Number(opts?.intervalMs) || 30000;
    const firstPollMs = opts?.firstPollMs != null
      ? Number(opts.firstPollMs)
      : 2500;
    const ready = useDataReady(data);
    const setterRef = useRef(setData);
    setterRef.current = setData;
    const [lastPriceUpdate, setLastPriceUpdate] = useState(0);

    const fetchPrices = useCallback(async () => {
      try {
        const res = await fetch(`${API_BASE}/timed/prices?_t=${Date.now()}`, {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!json?.ok || !json.prices) return;
        const feedTs = readMs(json.updated_at) || Date.now();
        setLastPriceUpdate(feedTs);

        const setter = setterRef.current;
        if (typeof setter !== "function") return;

        setter((prev) => {
          if (shouldPausePageLiveUpdates()) return prev;
          if (!prev || typeof prev !== "object" || Object.keys(prev).length === 0) return prev;
          const next = { ...prev };
          let changed = false;
          for (const [sym, p] of Object.entries(json.prices)) {
            const key = String(sym).toUpperCase();
            const existing = next[key];
            const feedP = Number(p?.p);
            if (!existing || !(feedP > 0)) continue;
            const symTs = quoteReceiptTs(p);
            if (!(symTs > 0)) continue;
            const marketOpen = readMarketOpen();
            const maxAgeMs = priceReceiptMaxAgeMs(marketOpen);
            if (symTs > 0 && (Date.now() - symTs) > maxAgeMs) continue;
            // No-op when nothing changed
            if (existing._live_price === feedP && existing._price_updated_at === symTs) continue;
            // Don't roll back a more recent push (WebSocket or in-flight fetch)
            if (existing._price_updated_at && existing._price_updated_at > symTs) continue;

            const feedPc = Number(p.pc);
            const feedPcUsable = Number.isFinite(feedPc) && feedPc > 0
              && (Math.abs(feedPc - feedP) / feedP * 100) > 0.05;
            const bestPc = feedPcUsable
              ? feedPc
              : (existing._live_prev_close || existing.prev_close || undefined);

            const feedDc = Number(p.dc);
            const feedDp = Number(p.dp);
            const priceOverlay = applyPriceFeedOverlay(existing, p, marketOpen);
            if (!priceOverlay) continue;
            const applyDay = shouldApplyDayChangeFromTick(p, marketOpen);

            const updated = {
              ...existing,
              ...priceOverlay,
              _price_updated_at: symTs,
              _price_value_ts: Number(p?.p_ts) || symTs,
              ...(Number(p?.q_ts) > 0 ? { _quote_receipt_ts: Number(p.q_ts) } : {}),
              _market_open_at_feed: marketOpen,
              ...(bestPc > 0 ? { _live_prev_close: bestPc } : {}),
              // dc/dp are session-close values; backend preserves them
              // across the close (see rule). Safe to apply in both states.
              ...(applyDay && Number.isFinite(feedDp) ? { day_change_pct: feedDp, change_pct: feedDp } : {}),
              ...(applyDay && Number.isFinite(feedDc) ? { day_change: feedDc, change: feedDc } : {}),
            };
            next[key] = updated;
            changed = true;
          }
          return changed ? next : prev;
        });
      } catch (_) {
        // Background poll — never throw
      }
    }, []);

    useEffect(() => {
      if (!ready) return;
      const firstPoll = setTimeout(fetchPrices, firstPollMs);
      const id = setInterval(fetchPrices, intervalMs);
      return () => {
        clearTimeout(firstPoll);
        clearInterval(id);
      };
    }, [ready, fetchPrices, intervalMs, firstPollMs]);

    return { lastPriceUpdate };
  }

  // ── useTickerRefresh ─────────────────────────────────────────────────
  function useTickerRefresh(data, setData, opts) {
    const intervalMs = Number(opts?.intervalMs) || 90000;
    const ready = useDataReady(data);
    const setterRef = useRef(setData);
    setterRef.current = setData;
    const [lastTickerRefresh, setLastTickerRefresh] = useState(0);

    const fetchAll = useCallback(async () => {
      try {
        const res = await fetch(`${API_BASE}/timed/all?_t=${Date.now()}`, {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) return;
        const json = await res.json();
        const incoming = (json?.ok && json.data) || null;
        if (!incoming || typeof incoming !== "object") return;
        const setter = setterRef.current;
        if (typeof setter !== "function") return;

        setter((prev) => {
          if (shouldPausePageLiveUpdates()) return prev;
          if (!prev || typeof prev !== "object") return incoming;
          const next = mergeTimedAllRefresh(prev, incoming);
          if (next !== prev) setLastTickerRefresh(Date.now());
          return next;
        });
      } catch (_) {
        // Background poll — never throw
      }
    }, []);

    useEffect(() => {
      if (!ready) return;
      const id = setInterval(fetchAll, intervalMs);
      return () => clearInterval(id);
    }, [ready, fetchAll, intervalMs]);

    return { lastTickerRefresh };
  }

  // ── usePriceWebSocket ────────────────────────────────────────────────
  // Sub-second live price ticks via the Durable Object WebSocket (/timed/ws).
  // ADDITIVE to usePriceFeed: the 30s poll remains the safety net, so if the
  // WS can't connect (tier/network) prices still refresh on the poll. Restores
  // the live-tick behavior the retired index-react monolith had — the journey
  // pages (Today/AT/Investor) had regressed to poll-only, which read as a
  // laggy/"stale" price during fast moves. Render-safe: all logic in effects.
  function usePriceWebSocket(data, setData, opts) {
    const enabled = opts?.enabled !== false;
    const ready = useDataReady(data);
    const setterRef = useRef(setData);
    setterRef.current = setData;
    const wsRef = useRef(null);
    const reconnectTimer = useRef(null);
    const reconnectDelay = useRef(1000);
    const closedRef = useRef(false);
    const [wsConnected, setWsConnected] = useState(false);

    // Apply a batch of { sym, p:{p,pc,dc,dp,ahp,...} } ticks — same overlay
    // shape usePriceFeed writes, so getHeadlinePrice/getDailyChange see live.
    const applyTicks = useCallback((entries, wsTs) => {
      const setter = setterRef.current;
      if (typeof setter !== "function" || !entries || !entries.length) return;
      const marketOpen = readMarketOpen();
      setter((prev) => {
        if (shouldPausePageLiveUpdates()) return prev;
        if (!prev || typeof prev !== "object") return prev;
        let next = prev;
        let changed = false;
        for (const { sym, p } of entries) {
          const key = String(sym).toUpperCase();
          const existing = next[key];
          const feedP = Number(p?.p);
          if (!existing || !(feedP > 0)) continue;
          const symTs = quoteReceiptTs(p);
          if (!(symTs > 0)) continue;
          const maxAgeMs = priceReceiptMaxAgeMs(marketOpen);
          if (symTs > 0 && (Date.now() - symTs) > maxAgeMs) continue;
          if (existing._live_price === feedP && existing._price_updated_at === symTs) continue;
          if (existing._price_updated_at && existing._price_updated_at > symTs) continue;
          if (!changed) { next = { ...prev }; changed = true; }
          const feedPc = Number(p.pc);
          const feedPcUsable = Number.isFinite(feedPc) && feedPc > 0
            && (Math.abs(feedPc - feedP) / feedP * 100) > 0.05;
          const bestPc = feedPcUsable ? feedPc : (existing._live_prev_close || existing.prev_close || undefined);
          const feedDc = Number(p.dc);
          const feedDp = Number(p.dp);
          const priceOverlay = applyPriceFeedOverlay(existing, p, marketOpen);
          if (!priceOverlay) continue;
          const applyDay = shouldApplyDayChangeFromTick(p, marketOpen);
          const updated = {
            ...existing,
            ...priceOverlay,
            _price_updated_at: symTs,
            _price_value_ts: Number(p?.p_ts) || symTs,
            ...(Number(p?.q_ts) > 0 ? { _quote_receipt_ts: Number(p.q_ts) } : {}),
            _market_open_at_feed: marketOpen,
            ...(bestPc > 0 ? { _live_prev_close: bestPc } : {}),
            ...(applyDay && Number.isFinite(feedDp) ? { day_change_pct: feedDp, change_pct: feedDp } : {}),
            ...(applyDay && Number.isFinite(feedDc) ? { day_change: feedDc, change: feedDc } : {}),
          };
          next[key] = updated;
        }
        return changed ? next : prev;
      });
    }, []);

    useEffect(() => {
      if (!enabled || !ready) return;
      if (typeof WebSocket === "undefined") return;
      closedRef.current = false;

      const scheduleReconnect = () => {
        if (closedRef.current) return;
        const delay = reconnectDelay.current;
        reconnectDelay.current = Math.min(delay * 2, 30000);
        reconnectTimer.current = setTimeout(connect, delay);
      };

      const connect = async () => {
        if (closedRef.current) return;
        // Ticket via same-origin proxy (carries CF Access auth); CF Access
        // blocks WS upgrades on the custom domain so we connect to workers.dev.
        let ticket = null;
        try {
          const tRes = await fetch(`${API_BASE}/timed/ws-ticket`, { credentials: "include", cache: "no-store" });
          const tJson = await tRes.json().catch(() => null);
          if (tJson?.ok && tJson.ticket) ticket = tJson.ticket;
        } catch (_) { /* fall through */ }
        if (!ticket || closedRef.current) { scheduleReconnect(); return; }
        let ws = null;
        try {
          ws = new WebSocket(`wss://timed-trading-ingest.shashant.workers.dev/timed/ws?ticket=${encodeURIComponent(ticket)}`);
          wsRef.current = ws;
        } catch (_) { scheduleReconnect(); return; }
        ws.onopen = () => { setWsConnected(true); reconnectDelay.current = 1000; };
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "prices" && msg.data) {
              applyTicks(Object.entries(msg.data).map(([sym, p]) => ({ sym, p })), readMs(msg.updated_at) || Date.now());
            } else if (msg.type === "tick_batch" && Array.isArray(msg.updates)) {
              applyTicks(msg.updates.map((u) => ({
                sym: u.s,
                p: {
                  p: u.last,
                  lastTs: u.lastTs,
                  dc: u.dayChg,
                  dp: u.dayChgPct,
                  ahChg: u.ahChg,
                  ahChgPct: u.ahChgPct,
                  session: u.session,
                },
              })), readMs(msg.ts) || Date.now());
            }
          } catch (_) { /* ignore malformed frame */ }
        };
        ws.onclose = () => { setWsConnected(false); wsRef.current = null; scheduleReconnect(); };
        ws.onerror = () => { /* onclose fires next → reconnect */ };
      };

      connect();
      return () => {
        closedRef.current = true;
        clearTimeout(reconnectTimer.current);
        try { wsRef.current?.close(); } catch (_) {}
        wsRef.current = null;
      };
    }, [enabled, ready, applyTicks]);

    return { wsConnected };
  }

  window.TimedLiveData = { usePriceFeed, useTickerRefresh, usePriceWebSocket, mergeTimedAllRefresh };
})();

// cache-bust:1784779576207:539495545
