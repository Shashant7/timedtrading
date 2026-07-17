/* tt-global-search.js
 *
 * Global ticker search — present on every page via the top nav. Opens a
 * command-palette-style overlay where the user types and picks a ticker
 * from the live universe; the chosen ticker opens in the right rail
 * (when the host page has a rail) or navigates to /active-trader.html
 * with ?ticker=… (when it doesn't).
 *
 * Cross-page contract — two surfaces talk to host pages:
 *
 *   1. CustomEvent `tt-open-ticker`
 *        detail: { ticker: "AAPL", source: "global-search" }
 *      Pages that mount the right rail listen for this and call their
 *      own setRailTicker(sym). See react-app/today.html (TodayApp),
 *      react-app/active-trader.html, react-app/investor.html,
 *      react-app/portfolio.html — each registers a single addEventListener
 *      inside the React app's mount effect.
 *
 *   2. URL ?ticker=AAPL
 *      Pages without a rail (insights, learn, faq, …) catch the event
 *      below and window.location to /active-trader.html?ticker=AAPL.
 *      Rail-enabled pages also read ?ticker= on first paint so the
 *      handoff works.
 *
 * Auth: gated to authenticated users (pro/vip/admin). On free-tier
 * accounts the widget hides itself — there is no ticker rail to open.
 *
 * Auto-mount: mirrors tt-nav-extras.js. Finds `nav.topnav .nav-row`
 * and injects the trigger button before `.tt-nav-widgets`. Idempotent
 * (skips if `#tt-global-search-btn` already exists).
 *
 * Keyboard:
 *   /       focus search (when not typing in another input)
 *   Cmd+K   same
 *   Esc     close overlay
 *   ↑ ↓     navigate results
 *   Enter   open highlighted ticker
 */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (document.getElementById("tt-global-search-btn")) return;

  const API_BASE = window.TT_API_BASE || "";

  // ── Styles (one-shot, idempotent) ───────────────────────────────
  function ensureStyles() {
    if (document.getElementById("tt-global-search-styles")) return;
    const el = document.createElement("style");
    el.id = "tt-global-search-styles";
    el.textContent = `
      .tt-gs-trigger {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        height: 34px;
        padding: 0 12px;
        border-radius: 999px;
        background: rgba(255,255,255,0.04);
        border: 1px solid var(--tt-border, rgba(255,255,255,0.08));
        color: var(--tt-text-muted, #8AA39A);
        font-size: 12.5px;
        font-family: var(--tt-font, 'Inter', sans-serif);
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
        flex-shrink: 0;
      }
      .tt-gs-trigger:hover {
        background: rgba(255,255,255,0.06);
        border-color: var(--tt-border-hi, rgba(255,255,255,0.14));
        color: var(--tt-text, #E8F2EC);
      }
      .tt-gs-trigger svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .tt-gs-trigger .tt-gs-label { line-height: 1; }
      .tt-gs-trigger .tt-gs-kbd {
        font-family: var(--tt-font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
        font-size: 10px;
        padding: 2px 5px;
        border-radius: 4px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.10);
        color: var(--tt-text-dim, #6E867D);
        letter-spacing: 0.04em;
      }
      @media (max-width: 767px) {
        /* On mobile compress to an icon-only round button so it fits next
           to the existing nav widgets without crowding. */
        .tt-gs-trigger .tt-gs-label,
        .tt-gs-trigger .tt-gs-kbd { display: none; }
        .tt-gs-trigger { width: 34px; padding: 0; justify-content: center; }
      }
      .tt-gs-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 9000;
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding: 80px 16px 16px;
        animation: tt-gs-fade 120ms ease;
      }
      @keyframes tt-gs-fade { from { opacity: 0 } to { opacity: 1 } }
      .tt-gs-panel {
        width: 100%;
        max-width: 520px;
        background: var(--tt-bg-canvas, #0B1410);
        border: 1px solid var(--tt-border-hi, rgba(255,255,255,0.14));
        border-radius: 14px;
        box-shadow: 0 22px 60px rgba(0,0,0,0.55);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        max-height: calc(100vh - 96px);
      }
      .tt-gs-input-wrap {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 16px;
        border-bottom: 1px solid var(--tt-border, rgba(255,255,255,0.06));
      }
      .tt-gs-input-wrap svg {
        width: 16px; height: 16px; flex-shrink: 0;
        stroke: var(--tt-text-muted, #8AA39A); fill: none;
        stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
      }
      .tt-gs-input {
        flex: 1 1 auto;
        background: transparent;
        border: 0;
        outline: 0;
        color: var(--tt-text, #E8F2EC);
        font-size: 16px;
        font-family: var(--tt-font, 'Inter', sans-serif);
      }
      .tt-gs-input::placeholder { color: var(--tt-text-dim, #6E867D); }
      .tt-gs-close {
        background: none;
        border: 0;
        color: var(--tt-text-muted, #8AA39A);
        font-size: 18px;
        cursor: pointer;
        padding: 0 4px;
        line-height: 1;
      }
      .tt-gs-results {
        list-style: none;
        margin: 0;
        padding: 4px 0;
        overflow-y: auto;
        max-height: 60vh;
        -webkit-overflow-scrolling: touch;
      }
      .tt-gs-result {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 16px;
        cursor: pointer;
        color: var(--tt-text, #E8F2EC);
        font-size: 13px;
        font-family: var(--tt-font, 'Inter', sans-serif);
        transition: background 80ms ease;
      }
      .tt-gs-result.is-active,
      .tt-gs-result:hover { background: rgba(255,255,255,0.05); }
      .tt-gs-result .tt-gs-sym {
        font-family: var(--tt-font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
        font-weight: 700;
        letter-spacing: 0.02em;
        color: var(--tt-text, #E8F2EC);
        font-size: 13px;
        min-width: 64px;
      }
      .tt-gs-result .tt-gs-name {
        color: var(--tt-text-muted, #8AA39A);
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1 1 auto;
      }
      .tt-gs-result .tt-gs-sector {
        color: var(--tt-text-dim, #6E867D);
        font-size: 10.5px;
        flex-shrink: 0;
        padding: 2px 7px;
        background: rgba(255,255,255,0.04);
        border-radius: 999px;
      }
      .tt-gs-empty, .tt-gs-loading {
        padding: 24px 16px;
        text-align: center;
        color: var(--tt-text-dim, #6E867D);
        font-size: 13px;
      }
      .tt-gs-section {
        padding: 8px 16px 4px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--tt-text-dim, #6E867D);
        list-style: none;
        pointer-events: none;
      }
      .tt-gs-footer {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 16px;
        border-top: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        background: rgba(255,255,255,0.015);
        font-size: 10.5px;
        color: var(--tt-text-dim, #6E867D);
        font-family: var(--tt-font, 'Inter', sans-serif);
      }
      .tt-gs-footer .tt-gs-kbd {
        font-family: var(--tt-font-mono, ui-monospace, 'SF Mono', Menlo, monospace);
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 4px;
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.10);
        color: var(--tt-text-muted, #8AA39A);
        margin: 0 4px;
      }
      /* ── My Tickers section (2026-05-22 user-add UX) ─────────────── */
      .tt-gs-mytickers {
        padding: 10px 16px 8px;
        border-bottom: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        background: rgba(255,255,255,0.015);
      }
      .tt-gs-mytickers-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        margin: 0 0 6px;
      }
      .tt-gs-mytickers-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.10em;
        color: var(--tt-text-dim, #6E867D);
      }
      .tt-gs-mytickers-quota {
        font-size: 10.5px;
        color: var(--tt-text-muted, #8AA39A);
        font-family: var(--tt-font-mono, ui-monospace, monospace);
      }
      .tt-gs-mytickers-quota.full { color: var(--tt-warn, #fbbf24); }
      .tt-gs-mytickers-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 4px 0 0;
      }
      .tt-gs-mychip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 4px 3px 9px;
        border-radius: 999px;
        background: rgba(56,242,161,0.10);
        border: 1px solid rgba(56,242,161,0.22);
        color: var(--tt-text, #E8F2EC);
        font-size: 11.5px;
        font-family: var(--tt-font-mono, ui-monospace, monospace);
        font-weight: 700;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease;
      }
      .tt-gs-mychip:hover { background: rgba(56,242,161,0.15); }
      .tt-gs-mychip.held { opacity: 0.55; cursor: default; }
      .tt-gs-mychip .tt-gs-mychip-x {
        display: inline-flex; align-items: center; justify-content: center;
        width: 16px; height: 16px;
        border-radius: 50%;
        background: rgba(255,255,255,0.06);
        color: var(--tt-text-muted, #8AA39A);
        font-size: 12px;
        line-height: 1;
        border: 0;
        padding: 0;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
      }
      .tt-gs-mychip .tt-gs-mychip-x:hover {
        background: rgba(248,113,113,0.20);
        color: rgb(248,113,113);
      }
      .tt-gs-mytickers-empty {
        font-size: 11px;
        color: var(--tt-text-dim, #6E867D);
        font-style: italic;
        margin: 2px 0 0;
      }
      /* ── Add-ticker CTA when query doesn't match the universe ─── */
      .tt-gs-add-cta {
        margin: 8px 12px;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(52,211,153,0.08);
        border: 1px dashed rgba(52,211,153,0.35);
        color: var(--tt-text, #E8F2EC);
        font-size: 12.5px;
        font-family: var(--tt-font, 'Inter', sans-serif);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .tt-gs-add-cta .tt-gs-add-btn {
        background: rgba(52,211,153,0.18);
        color: var(--tt-up, #34d399);
        border: 1px solid rgba(52,211,153,0.40);
        border-radius: 999px;
        padding: 5px 14px;
        font-size: 11.5px;
        font-weight: 700;
        font-family: var(--tt-font-mono, ui-monospace, monospace);
        cursor: pointer;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        transition: background 120ms ease;
      }
      .tt-gs-add-cta .tt-gs-add-btn:hover { background: rgba(52,211,153,0.30); }
      .tt-gs-add-cta .tt-gs-add-btn:disabled { opacity: 0.5; cursor: progress; }
      .tt-gs-add-cta .tt-gs-add-meta {
        font-size: 10.5px;
        color: var(--tt-text-muted, #8AA39A);
        font-family: var(--tt-font-mono, ui-monospace, monospace);
      }
      .tt-gs-add-error {
        margin-top: 6px;
        font-size: 11px;
        color: var(--tt-dn, #f87171);
      }
    `;
    document.head.appendChild(el);
  }

  // ── Auth detection ──────────────────────────────────────────────
  // We allow pro/vip/admin to use the global search. Free tier hides
  // it entirely — there is no rail to open for them on the gated pages.
  function isAuthorizedUser() {
    try {
      const ds = document.body && document.body.dataset;
      const isPro = window._ttIsPro === true || ds?.isPro === "true";
      const isAdmin = window._ttIsAdmin === true || ds?.isAdmin === "true";
      const tier = String(ds?.userTier || "").toLowerCase();
      return isPro || isAdmin || tier === "pro" || tier === "vip" || tier === "admin";
    } catch { return false; }
  }

  // ── Universe loader (localStorage cache + deferred enrichment) ───
  // Tickers change infrequently; avoid hammering /timed/all on every
  // page load — that payload competes with Today and made search feel
  // hung. Symbol list is cached 6h; name/sector enrichment is cached
  // separately and refreshed in the background via requestIdleCallback.
  const UNIVERSE_CACHE_KEY = "tt-gs-universe-v2";
  const UNIVERSE_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  function readUniverseCache() {
    try {
      const raw = window.localStorage?.getItem(UNIVERSE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const at = Number(parsed?.at) || 0;
      const items = Array.isArray(parsed?.items) ? parsed.items : null;
      if (!items?.length || !at || Date.now() - at > UNIVERSE_CACHE_TTL_MS) return null;
      return items;
    } catch (_) {
      return null;
    }
  }

  function writeUniverseCache(items) {
    try {
      window.localStorage?.setItem(UNIVERSE_CACHE_KEY, JSON.stringify({
        at: Date.now(),
        items: items.map((it) => ({
          ticker: it.ticker,
          name: it.name || null,
          sector: it.sector || null,
        })),
      }));
    } catch (_) {}
  }

  function universeFromSymbols(syms) {
    return syms
      .map((s) => String(s || "").trim().toUpperCase())
      .filter(Boolean)
      .map((sym) => ({ ticker: sym, name: null, sector: null }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  async function fetchTickerSymbols() {
    const r = await fetch(`${API_BASE}/timed/tickers`, { credentials: "include" });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.tickers) ? j.tickers : [];
  }

  async function enrichUniverse(items) {
    const out = new Map(items.map((it) => [it.ticker, { ...it }]));
    try {
      const r = await fetch(`${API_BASE}/timed/all`, { credentials: "include" });
      if (!r.ok) return [...out.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
      const j = await r.json();
      const data = j?.data || j || {};
      for (const [key, v] of Object.entries(data)) {
        const sym = String(key).toUpperCase();
        if (!sym) continue;
        const ctx = v?.context || {};
        const name = v?.companyName || v?.name || ctx.name || null;
        const sector = ctx.sector || v?.sector || null;
        if (!out.has(sym)) out.set(sym, { ticker: sym, name, sector });
        else {
          const cur = out.get(sym);
          if (!cur.name && name) cur.name = name;
          if (!cur.sector && sector) cur.sector = sector;
        }
      }
    } catch (_) { /* symbol-only search still works */ }
    return [...out.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  let _universeP = null;
  let _universeRefreshing = false;

  function applyUniverse(items) {
    const sorted = [...items].sort((a, b) => a.ticker.localeCompare(b.ticker));
    _universe = sorted;
    if (_overlay) onInput();
    return sorted;
  }

  function refreshUniverseInBackground() {
    if (_universeRefreshing) return;
    _universeRefreshing = true;
    const run = async () => {
      try {
        const syms = await fetchTickerSymbols();
        if (!syms.length) return;
        let items = universeFromSymbols(syms);
        items = await enrichUniverse(items);
        writeUniverseCache(items);
        applyUniverse(items);
        _universeP = Promise.resolve(items);
      } catch (e) {
        console.warn("[GLOBAL-SEARCH] universe refresh failed:", e);
      } finally {
        _universeRefreshing = false;
      }
    };
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => { run(); }, { timeout: 8000 });
    } else {
      setTimeout(run, 2500);
    }
  }

  function loadUniverse() {
    if (_universeP) return _universeP;

    const cached = readUniverseCache();
    if (cached?.length) {
      _universeP = Promise.resolve(cached);
      refreshUniverseInBackground();
      return _universeP;
    }

    _universeP = (async () => {
      try {
        const syms = await fetchTickerSymbols();
        if (!syms.length) return [];
        let items = universeFromSymbols(syms);
        writeUniverseCache(items);
        // Return symbols immediately; enrich without blocking first open.
        refreshUniverseInBackground();
        return items;
      } catch (e) {
        console.warn("[GLOBAL-SEARCH] universe fetch failed:", e);
        return [];
      }
    })();
    return _universeP;
  }

  // ── Score function — exact > prefix > substring(ticker) > substring(name) ──
  // Recently opened tickers (global search pick / rail open). Most-recent first.
  const RECENT_STORAGE_KEY = "tt-gs-recent-v1";
  const RECENT_MAX = 10;

  function readRecent() {
    try {
      const raw = window.localStorage?.getItem(RECENT_STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(arr)) return [];
      return arr.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean).slice(0, RECENT_MAX);
    } catch (_) {
      return [];
    }
  }

  function pushRecent(sym) {
    const ticker = String(sym || "").trim().toUpperCase();
    if (!ticker) return;
    try {
      const prev = readRecent().filter((s) => s !== ticker);
      const next = [ticker, ...prev].slice(0, RECENT_MAX);
      window.localStorage?.setItem(RECENT_STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
  }

  function recentRankBoost(ticker, recentList) {
    const idx = recentList.indexOf(String(ticker || "").toUpperCase());
    if (idx < 0) return 0;
    return Math.max(1, RECENT_MAX - idx);
  }

  function rank(item, qUp) {
    if (!qUp) return 0;
    const t = item.ticker;
    if (t === qUp) return 1000;
    if (t.startsWith(qUp)) return 800 - (t.length - qUp.length); // shorter prefix wins
    if (t.includes(qUp)) return 500;
    const n = String(item.name || "").toUpperCase();
    if (n.startsWith(qUp)) return 400;
    if (n.includes(qUp)) return 200;
    return -1;
  }

  function search(universe, q) {
    const qUp = String(q || "").trim().toUpperCase();
    const byTicker = new Map(universe.map((it) => [it.ticker, it]));
    const recentSyms = readRecent().filter((sym) => byTicker.has(sym));
    if (!qUp) {
      const recentItems = recentSyms.map((sym) => byTicker.get(sym)).filter(Boolean);
      const recentSet = new Set(recentSyms);
      const rest = universe.filter((it) => !recentSet.has(it.ticker));
      return recentItems.concat(rest).slice(0, 30);
    }
    const scored = [];
    for (const it of universe) {
      const s = rank(it, qUp);
      if (s >= 0) scored.push({ it, s: s + recentRankBoost(it.ticker, recentSyms) });
    }
    scored.sort((a, b) => b.s - a.s || a.it.ticker.localeCompare(b.it.ticker));
    return scored.slice(0, 50).map(x => x.it);
  }

  // ── Overlay UI ───────────────────────────────────────────────────
  let _overlay = null;
  let _input = null;
  let _resultsEl = null;
  let _activeIdx = 0;
  let _currentResults = [];
  let _universe = [];

  // ── My Tickers state (PR 2026-05-22) ──────────────────────────────
  //
  // The legacy /index-react.html dashboard had a "+ Add Ticker" button
  // with slot count + active-list + remove × buttons. The new app
  // shell never exposed it. We now plumb the same backend
  // (GET /timed/user-tickers + POST + DELETE) through the global
  // search overlay so the user can:
  //   1. See their custom tickers + quota at the top of the palette
  //   2. Remove any of them inline
  //   3. Add a new one when the search query is a ticker shape not
  //      already in the universe
  //
  // Pro tier required by backend (free tier returns slots_max=3 but
  // the UI shows "Go Pro" affordance instead of the add button).
  let _myTickers = null;            // { tickers: [...], slots_used, slots_max, tier }
  let _myTickersLoading = false;
  let _addingTicker = null;          // SYM currently being POSTed
  let _addError = null;              // last error string from add attempt

  async function refreshMyTickers() {
    if (!isAuthorizedUser()) return;
    _myTickersLoading = true;
    try {
      const r = await fetch(`${API_BASE}/timed/user-tickers?_t=${Date.now()}`, {
        cache: "no-store",
        credentials: "include",
      });
      if (r.ok) {
        const j = await r.json();
        if (j?.ok) {
          _myTickers = j;
          // Active user-added tickers should also appear in the search
          // universe immediately (not wait for /timed/tickers cache).
          try {
            const active = (j.tickers || []).filter(t => t.active || t.held);
            for (const row of active) {
              const sym = String(row.ticker || "").toUpperCase();
              if (sym && !_universe.find(u => u.ticker === sym)) {
                _universe.push({ ticker: sym, name: null, sector: null });
              }
            }
            _universe.sort((a, b) => a.ticker.localeCompare(b.ticker));
          } catch (_) {}
        }
      } else if (r.status === 401) {
        _myTickers = null; // not authenticated, hide section
      }
    } catch (e) {
      console.warn("[GLOBAL-SEARCH] /timed/user-tickers failed:", e);
    } finally {
      _myTickersLoading = false;
      renderMyTickers();
    }
  }

  async function addTicker(sym) {
    const ticker = String(sym || "").trim().toUpperCase();
    if (!ticker) return;
    _addingTicker = ticker;
    _addError = null;
    renderResults();
    try {
      const r = await fetch(`${API_BASE}/timed/user-tickers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ticker }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) {
        _addError = j?.detail || j?.error || `HTTP ${r.status}`;
        _addingTicker = null;
        renderResults();
        return;
      }
      _addingTicker = null;
      _addError = null;
      // Refresh quota then open the freshly-added ticker.
      await refreshMyTickers();
      pick(ticker);
    } catch (e) {
      _addError = String(e?.message || e).slice(0, 200);
      _addingTicker = null;
      renderResults();
    }
  }

  async function removeTicker(sym) {
    const ticker = String(sym || "").trim().toUpperCase();
    if (!ticker) return;
    if (!confirm(`Remove ${ticker} from your tickers? (slot held for 7 days before it frees)`)) return;
    try {
      const r = await fetch(`${API_BASE}/timed/user-tickers/${encodeURIComponent(ticker)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Failed to remove ${ticker}: ${j?.error || r.status}`);
        return;
      }
      await refreshMyTickers();
    } catch (e) {
      alert(`Failed to remove ${ticker}: ${e?.message || e}`);
    }
  }

  function closeOverlay() {
    if (_overlay) {
      _overlay.remove();
      _overlay = null;
      _input = null;
      _resultsEl = null;
      _myTickersEl = null;
      _activeIdx = 0;
      _currentResults = [];
      _addingTicker = null;
      _addError = null;
    }
  }

  function renderResults() {
    if (!_resultsEl) return;
    _resultsEl.innerHTML = "";

    // Determine if the current query looks like a ticker symbol that
    // is NOT in our universe — in that case offer "Add SYM" at the top
    // of the results section. Pattern: 1-5 letters, optional -A class.
    const qRaw = (_input && _input.value) ? _input.value.trim().toUpperCase() : "";
    const looksLikeTicker = qRaw && /^[A-Z]{1,5}(-[A-Z]{1,2})?$/.test(qRaw);
    const universeHasIt = looksLikeTicker && _universe.some(u => u.ticker === qRaw);
    const showAddCta = looksLikeTicker && !universeHasIt && _myTickers && isAuthorizedUser();

    if (showAddCta) {
      const cta = document.createElement("li");
      cta.className = "tt-gs-add-cta";
      const isAdding = _addingTicker === qRaw;
      const slotsUsed = Number(_myTickers?.slots_used) || 0;
      const slotsMax  = Number(_myTickers?.slots_max)  || 0;
      const slotsLeft = Math.max(0, slotsMax - slotsUsed);
      const canAdd = slotsLeft > 0 && !isAdding;
      cta.innerHTML = `
        <div>
          <div>Not in our universe yet — <strong>${qRaw}</strong></div>
          <div class="tt-gs-add-meta">${slotsLeft} of ${slotsMax} slots free · 7-day hold after removal</div>
          ${_addError && _addingTicker == null ? `<div class="tt-gs-add-error">${escapeHtml(_addError)}</div>` : ""}
        </div>
        <button type="button" class="tt-gs-add-btn" ${canAdd ? "" : "disabled"}>
          ${isAdding ? "Adding…" : slotsLeft <= 0 ? "Full" : `+ Add ${qRaw}`}
        </button>
      `;
      const btn = cta.querySelector(".tt-gs-add-btn");
      if (btn && canAdd) btn.addEventListener("click", () => addTicker(qRaw));
      _resultsEl.appendChild(cta);
    }

    if (_currentResults.length === 0 && !showAddCta) {
      const empty = document.createElement("li");
      empty.className = "tt-gs-empty";
      empty.textContent = qRaw
        ? `No tickers match "${qRaw}".`
        : "No tickers in the universe yet.";
      _resultsEl.appendChild(empty);
      return;
    }

    const recentSet = !qRaw ? new Set(readRecent()) : new Set();
    let insertedRecentHdr = false;
    let insertedAllHdr = false;

    _currentResults.forEach((it, idx) => {
      if (!qRaw && recentSet.size > 0) {
        if (recentSet.has(it.ticker) && !insertedRecentHdr) {
          insertedRecentHdr = true;
          const hdr = document.createElement("li");
          hdr.className = "tt-gs-section";
          hdr.textContent = "Recent";
          _resultsEl.appendChild(hdr);
        }
        if (!recentSet.has(it.ticker) && insertedRecentHdr && !insertedAllHdr) {
          insertedAllHdr = true;
          const hdr = document.createElement("li");
          hdr.className = "tt-gs-section";
          hdr.textContent = "All tickers";
          _resultsEl.appendChild(hdr);
        }
      }
      const li = document.createElement("li");
      li.className = "tt-gs-result" + (idx === _activeIdx ? " is-active" : "");
      li.setAttribute("role", "option");
      li.setAttribute("data-ticker", it.ticker);
      li.innerHTML =
        `<span class="tt-gs-sym">${it.ticker}</span>` +
        `<span class="tt-gs-name">${it.name ? escapeHtml(it.name) : ""}</span>` +
        (it.sector ? `<span class="tt-gs-sector">${escapeHtml(it.sector)}</span>` : "");
      li.addEventListener("mouseenter", () => {
        if (_activeIdx !== idx) { _activeIdx = idx; updateActive(); }
      });
      li.addEventListener("click", () => pick(it.ticker));
      _resultsEl.appendChild(li);
    });
  }

  // ── My Tickers section — rendered into a dedicated container above
  // the results list. Refreshed independently when the user adds /
  // removes a ticker.
  let _myTickersEl = null;
  function renderMyTickers() {
    if (!_myTickersEl) return;
    if (!isAuthorizedUser() || !_myTickers) {
      _myTickersEl.style.display = "none";
      _myTickersEl.innerHTML = "";
      return;
    }
    _myTickersEl.style.display = "";
    const slotsUsed = Number(_myTickers.slots_used) || 0;
    const slotsMax  = Number(_myTickers.slots_max)  || 0;
    const tier      = String(_myTickers.tier || "").toLowerCase();
    const tickers   = Array.isArray(_myTickers.tickers) ? _myTickers.tickers : [];
    const active    = tickers.filter(t => t.active || t.held);
    const quotaCls  = slotsUsed >= slotsMax ? "full" : "";

    const chipsHtml = active.length === 0
      ? `<div class="tt-gs-mytickers-empty">No custom tickers yet — search for one above and add it.</div>`
      : `<div class="tt-gs-mytickers-list">` + active.map(t => {
          const sym = String(t.ticker).toUpperCase();
          const isHeld = !!t.held;
          const title = isHeld
            ? `${sym} · slot held until ${new Date(Number(t.held_until)).toLocaleString()}`
            : `Open ${sym}`;
          return `<span class="tt-gs-mychip${isHeld ? " held" : ""}" data-sym="${sym}" data-held="${isHeld ? "1" : "0"}" title="${escapeHtml(title)}">
            ${sym}
            <button type="button" class="tt-gs-mychip-x" data-sym="${sym}" aria-label="Remove ${sym}" title="Remove ${sym}">×</button>
          </span>`;
        }).join("") + `</div>`;

    _myTickersEl.innerHTML = `
      <div class="tt-gs-mytickers-head">
        <span class="tt-gs-mytickers-title">My Tickers · ${tier ? tier.toUpperCase() : ""}</span>
        <span class="tt-gs-mytickers-quota ${quotaCls}">${slotsUsed} / ${slotsMax}</span>
      </div>
      ${chipsHtml}
    `;

    // Click handlers — chip click opens ticker, × button removes it.
    _myTickersEl.querySelectorAll(".tt-gs-mychip-x").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const sym = btn.getAttribute("data-sym");
        if (sym) removeTicker(sym);
      });
    });
    _myTickersEl.querySelectorAll(".tt-gs-mychip").forEach(chip => {
      chip.addEventListener("click", () => {
        const sym = chip.getAttribute("data-sym");
        const held = chip.getAttribute("data-held") === "1";
        if (sym && !held) pick(sym);
      });
    });
  }

  function updateActive() {
    if (!_resultsEl) return;
    const items = _resultsEl.querySelectorAll(".tt-gs-result");
    items.forEach((el, i) => el.classList.toggle("is-active", i === _activeIdx));
    const el = items[_activeIdx];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function onInput() {
    if (!_input) return;
    _currentResults = search(_universe, _input.value);
    _activeIdx = 0;
    renderResults();
  }

  function onKey(e) {
    if (!_overlay) return;
    if (e.key === "Escape") { e.preventDefault(); closeOverlay(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (_currentResults.length === 0) return;
      _activeIdx = (_activeIdx + 1) % _currentResults.length;
      updateActive();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (_currentResults.length === 0) return;
      _activeIdx = (_activeIdx - 1 + _currentResults.length) % _currentResults.length;
      updateActive();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const r = _currentResults[_activeIdx];
      if (r) pick(r.ticker);
      return;
    }
  }

  /**
   * Fire the open-ticker event. Pages that mount the right rail listen
   * and call setRailTicker(); pages that don't fall back to redirect.
   * Also push ?ticker=… onto the URL so reloads keep the rail open.
   */
  function pick(sym) {
    const ticker = String(sym || "").toUpperCase();
    if (!ticker) return;
    // 2026-06-03 — Track recently-picked tickers so the default-state
    // results list ranks them above the alphabetical universe.
    pushRecent(ticker);
    closeOverlay();
    try {
      // Update URL so reload preserves the open ticker. Use replaceState
      // (not pushState) — we don't want every search to clutter history.
      const u = new URL(window.location.href);
      u.searchParams.set("ticker", ticker);
      window.history.replaceState({ ttTicker: ticker }, "", u.toString());
    } catch (_) { /* best-effort */ }
    // Page apps subscribe to this event and call their own setRailTicker.
    const ev = new CustomEvent("tt-open-ticker", {
      detail: { ticker, source: "global-search" },
      bubbles: true,
    });
    window.dispatchEvent(ev);
    // Fallback: if no listener handled it within 250ms (e.g. on a page
    // without the rail), navigate to /active-trader.html which does.
    setTimeout(() => {
      if (window._ttGlobalSearchLastHandled !== ticker) {
        const next = `/active-trader.html?ticker=${encodeURIComponent(ticker)}`;
        if (window.location.pathname.endsWith("/active-trader.html")) {
          // Already on AT — the React app should be listening; if it
          // isn't (page mid-mount, etc.) the URL change above will be
          // picked up on the next bootstrap pass.
          return;
        }
        window.location.href = next;
      }
    }, 250);
  }

  // Pages that handle the event should mark it as handled so the
  // fallback redirect doesn't fire over the top of a successful open.
  window.addEventListener("tt-open-ticker", (ev) => {
    // Default mark — pages listening BEFORE us will set last_handled
    // themselves. This handler runs last (capture:false, attached
    // here at script-load time, which is before page apps mount).
    // Actually pages mount AFTER us (their effects run after defer),
    // so they'll set this when they call setRailTicker.
    if (ev?.detail?.handled === true) {
      window._ttGlobalSearchLastHandled = String(ev.detail.ticker || "").toUpperCase();
    }
  });
  // Convenience exposed for journey-page React effects: pages can call
  // this in their tt-open-ticker handler to suppress the fallback nav.
  window.ttGlobalSearchMarkHandled = function (sym) {
    window._ttGlobalSearchLastHandled = String(sym || "").toUpperCase();
  };

  function openOverlay() {
    if (_overlay) {
      // Already open — refocus the input.
      if (_input) _input.focus();
      return;
    }
    _overlay = document.createElement("div");
    _overlay.className = "tt-gs-overlay";
    _overlay.setAttribute("role", "dialog");
    _overlay.setAttribute("aria-modal", "true");
    _overlay.setAttribute("aria-label", "Search tickers");
    _overlay.addEventListener("click", (e) => {
      if (e.target === _overlay) closeOverlay();
    });

    const panel = document.createElement("div");
    panel.className = "tt-gs-panel";

    const inputWrap = document.createElement("div");
    inputWrap.className = "tt-gs-input-wrap";
    inputWrap.innerHTML = `
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input class="tt-gs-input" type="text" placeholder="Search tickers — try AAPL, NVDA, sector name…" autocomplete="off" autocapitalize="characters" spellcheck="false" />
      <button class="tt-gs-close" aria-label="Close">&times;</button>
    `;
    panel.appendChild(inputWrap);

    // 2026-05-22 — My Tickers section. Sits between the input and the
    // results list. Renders the user's custom tickers (with × remove)
    // + slots-used / slots-max quota. Hidden when user isn't
    // authenticated (free tier still sees it once /timed/user-tickers
    // resolves — backend determines tier).
    _myTickersEl = document.createElement("div");
    _myTickersEl.className = "tt-gs-mytickers";
    _myTickersEl.style.display = "none";
    panel.appendChild(_myTickersEl);

    _resultsEl = document.createElement("ul");
    _resultsEl.className = "tt-gs-results";
    _resultsEl.setAttribute("role", "listbox");
    panel.appendChild(_resultsEl);

    const footer = document.createElement("div");
    footer.className = "tt-gs-footer";
    footer.innerHTML = `
      <span><span class="tt-gs-kbd">↑</span><span class="tt-gs-kbd">↓</span> navigate · <span class="tt-gs-kbd">↵</span> open</span>
      <span><span class="tt-gs-kbd">esc</span> close</span>
    `;
    panel.appendChild(footer);

    _overlay.appendChild(panel);
    document.body.appendChild(_overlay);

    _input = inputWrap.querySelector(".tt-gs-input");
    const closeBtn = inputWrap.querySelector(".tt-gs-close");
    closeBtn.addEventListener("click", closeOverlay);
    _input.addEventListener("input", onInput);
    _input.addEventListener("keydown", onKey);
    document.addEventListener("keydown", onKey);

    // 2026-05-22 — Refresh My Tickers list whenever the overlay opens.
    // Cheap (one /timed/user-tickers GET) and we want fresh quota
    // after any background mutations.
    refreshMyTickers();

    // Render a placeholder while universe loads, then default list.
    if (_universe.length === 0) {
      const loading = document.createElement("li");
      loading.className = "tt-gs-loading";
      loading.textContent = "Loading universe…";
      _resultsEl.appendChild(loading);
      loadUniverse().then((u) => {
        _universe = u;
        // Only render if overlay is still open
        if (_overlay) onInput();
      });
    } else {
      onInput();
    }

    // Pre-warm focus so typing starts immediately.
    setTimeout(() => { try { _input.focus(); } catch (_) {} }, 0);
  }

  // ── Global keyboard shortcut (/ and Cmd+K / Ctrl+K) ─────────────
  function onGlobalKey(e) {
    if (!isAuthorizedUser()) return;
    const t = e.target;
    const isInputLike = t && (
      t.tagName === "INPUT" || t.tagName === "TEXTAREA" ||
      t.isContentEditable === true
    );
    // Cmd+K / Ctrl+K always works (standard command-palette shortcut).
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      openOverlay();
      return;
    }
    // "/" only when not typing in an input.
    if (!isInputLike && e.key === "/") {
      e.preventDefault();
      openOverlay();
    }
  }
  document.addEventListener("keydown", onGlobalKey);

  // ── Inject the trigger button into the top nav ──────────────────
  function injectTrigger() {
    if (document.getElementById("tt-global-search-btn")) return true;
    const navRow = document.querySelector("nav.topnav .nav-row");
    if (!navRow) return false;
    if (!isAuthorizedUser()) {
      // User not authorized — bail. We re-run on auth-bootstrap below.
      return false;
    }
    ensureStyles();
    const btn = document.createElement("button");
    btn.id = "tt-global-search-btn";
    btn.type = "button";
    btn.className = "tt-gs-trigger";
    btn.setAttribute("aria-label", "Search tickers");
    btn.title = "Search tickers (press / or Cmd+K)";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <span class="tt-gs-label">Search</span>
      <span class="tt-gs-kbd">/</span>
    `;
    btn.addEventListener("click", openOverlay);
    // Insert before the right-side widgets (Discord / Bell / Avatar)
    // injected by tt-nav-extras.js. If they aren't there yet (race),
    // just append to the row.
    const widgets = navRow.querySelector(".tt-nav-widgets");
    if (widgets) {
      navRow.insertBefore(btn, widgets);
    } else {
      navRow.appendChild(btn);
    }
    // Defer universe prefetch so Today / Active Trader critical fetches
    // win the network first. Cache makes the first open instant anyway.
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(() => { loadUniverse(); }, { timeout: 5000 });
    } else {
      setTimeout(() => { loadUniverse(); }, 2000);
    }
    return true;
  }

  function mount() {
    if (injectTrigger()) return;
    // Retry — the nav may not be in the DOM yet (e.g. React rebuild) or
    // auth might not have resolved. Poll briefly + listen for the
    // auth bootstrap event.
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (injectTrigger() || tries >= 40) clearInterval(t);
    }, 150);
    window.addEventListener("tt-auth-bootstrap-updated", () => {
      injectTrigger();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  // ── Cross-page deep-link handoff ────────────────────────────────
  // If we landed on this page via /active-trader.html?ticker=AAPL
  // (or similar), surface the ticker via the same custom event so
  // the page's React app opens the rail without each page needing
  // its own bootstrap. Pages that don't listen will simply ignore
  // it. The page's own event listener should remove the ?ticker=
  // param after handling to keep the URL clean — we don't strip it
  // here in case the user actually wants to share the URL.
  function emitFromUrl() {
    try {
      const u = new URL(window.location.href);
      const t = String(u.searchParams.get("ticker") || "").trim().toUpperCase();
      if (!t) return;
      if (!isAuthorizedUser()) return;
      // Defer so React apps that mount on DOMContentLoaded have a tick
      // to subscribe before we fire.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("tt-open-ticker", {
          detail: { ticker: t, source: "deep-link" },
          bubbles: true,
        }));
      }, 50);
    } catch (_) {}
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", emitFromUrl);
  } else {
    emitFromUrl();
  }
})();

// cache-bust:1784321787947:238357818
