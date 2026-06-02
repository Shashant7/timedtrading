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

  // ── usePriceFeed ─────────────────────────────────────────────────────
  function usePriceFeed(data, setData, opts) {
    const intervalMs = Number(opts?.intervalMs) || 30000;
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
          if (!prev || typeof prev !== "object" || Object.keys(prev).length === 0) return prev;
          const next = { ...prev };
          let changed = false;
          for (const [sym, p] of Object.entries(json.prices)) {
            const key = String(sym).toUpperCase();
            const existing = next[key];
            const feedP = Number(p?.p);
            if (!existing || !(feedP > 0)) continue;
            // No-op when nothing changed
            if (existing._live_price === feedP && existing._price_updated_at === feedTs) continue;
            // Don't roll back a more recent push (WebSocket or in-flight fetch)
            if (existing._price_updated_at && existing._price_updated_at > feedTs) continue;

            const feedPc = Number(p.pc);
            const feedPcUsable = Number.isFinite(feedPc) && feedPc > 0
              && (Math.abs(feedPc - feedP) / feedP * 100) > 0.05;
            const bestPc = feedPcUsable
              ? feedPc
              : (existing._live_prev_close || existing.prev_close || undefined);

            const feedDc = Number(p.dc);
            const feedDp = Number(p.dp);
            const ahp = Number(p.ahp);
            const ahdc = Number(p.ahdc);
            const ahdp = Number(p.ahdp);

            // 2026-05-27 (PR #319) — Market-closed RTH/EXT mixing fix.
            //
            // User report (2026-05-27 13:18 UTC): Kanban cards flicker
            // between two prices (e.g. MU $895.88 → $957.50 → $895.88
            // every 30-90s) and the RTH GAINERS row sometimes shows
            // MU at $961 +28% (EXT-inflated) and sometimes $895 +19%
            // (correct RTH-only).
            //
            // Root cause: `/timed/prices` `p.p` is the LATEST TICK,
            // which after RTH close includes extended-hours moves.
            // We were unconditionally overwriting `existing.price` with
            // feedP → next refresh of `/timed/all` (90s cycle) puts
            // RTH price back → bouncing.
            //
            // Backend already preserves `dc/dp/pc` correctly across
            // session boundaries (per .cursor/rules/price-data-pipeline.mdc),
            // so the bouncing is specifically `p` (price) when market
            // is closed.
            //
            // Fix: when market is CLOSED, keep `existing.price` = RTH
            // close (from the bundle); only write `_live_price` + the
            // dedicated AH fields. Consumers that want the live tick
            // for any reason can read `_live_price` directly.
            //
            // When market is OPEN, the existing behavior is correct
            // (feedP IS the canonical price during RTH).
            const marketOpen = (() => {
              try { return window.TimedPriceUtils?.isNyRegularMarketOpen?.() ?? true; }
              catch (_) { return true; }
            })();

            next[key] = {
              ...existing,
              // Only overwrite the canonical price field DURING RTH.
              // When market is closed, keep the RTH close (existing.price)
              // intact; the live tick goes to _live_price only.
              ...(marketOpen ? { price: feedP } : {}),
              _live_price: feedP,
              _price_updated_at: feedTs,
              _market_open_at_feed: marketOpen,
              ...(bestPc > 0 ? { _live_prev_close: bestPc } : {}),
              // dc/dp are session-close values; backend preserves them
              // across the close (see rule). Safe to apply in both states.
              ...(Number.isFinite(feedDp) ? { day_change_pct: feedDp, change_pct: feedDp } : {}),
              ...(Number.isFinite(feedDc) ? { day_change: feedDc, change: feedDc } : {}),
              ...(Number.isFinite(ahp) && ahp > 0 ? { _ah_price: ahp } : {}),
              ...(Number.isFinite(ahdc) ? { _ah_change: ahdc } : {}),
              ...(Number.isFinite(ahdp) ? { _ah_change_pct: ahdp } : {}),
            };
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
      const firstPoll = setTimeout(fetchPrices, 2500);
      const id = setInterval(fetchPrices, intervalMs);
      return () => {
        clearTimeout(firstPoll);
        clearInterval(id);
      };
    }, [ready, fetchPrices, intervalMs]);

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
          if (!prev || typeof prev !== "object") return incoming;
          const next = { ...prev };
          let changed = false;
          for (const [sym, row] of Object.entries(incoming)) {
            if (!row || typeof row !== "object") continue;
            const key = String(sym).toUpperCase();
            const existing = next[key];
            // Cheap identity check — skip when nothing material changed
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
            // Merge: replace scoring fields with the fresh ones but keep
            // ephemeral live-price overlays from usePriceFeed.
            const merged = { ...row };
            if (existing) {
              if (existing._live_price !== undefined) merged._live_price = existing._live_price;
              if (existing._live_prev_close !== undefined) merged._live_prev_close = existing._live_prev_close;
              if (existing._price_updated_at !== undefined) merged._price_updated_at = existing._price_updated_at;
              if (existing._ah_price !== undefined) merged._ah_price = existing._ah_price;
              if (existing._ah_change !== undefined) merged._ah_change = existing._ah_change;
              if (existing._ah_change_pct !== undefined) merged._ah_change_pct = existing._ah_change_pct;
              // If the live-price overlay is newer than the snapshot it overrides
              // the snapshot's stale price + dollar/pct change. The merge above
              // already wrote row.price; if usePriceFeed has a more-recent
              // value we restore it.
              if (existing._price_updated_at && existing._price_updated_at > (row.ts || 0)) {
                if (existing._live_price !== undefined) merged.price = existing._live_price;
                if (existing.day_change !== undefined) merged.day_change = existing.day_change;
                if (existing.day_change_pct !== undefined) merged.day_change_pct = existing.day_change_pct;
              }
            }
            next[key] = merged;
            changed = true;
          }
          if (changed) setLastTickerRefresh(Date.now());
          return changed ? next : prev;
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

  window.TimedLiveData = { usePriceFeed, useTickerRefresh };
})();

// cache-bust:1780377864691:531985315
