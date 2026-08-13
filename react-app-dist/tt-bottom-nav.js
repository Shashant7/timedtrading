// tt-bottom-nav.js — Mobile bottom navigation
//
// Mobile-only thumb-friendly nav that pins to the bottom of the screen.
// Mirrors the top nav's primary destinations so users have one-tap access
// no matter where they are on the page (especially important on long
// scrolling pages like /portfolio + /insights).
//
// Hidden on screens ≥ 768px (desktop has the sticky top nav already).
//
// Admin users get a 6th "Admin" tab. Tap opens a bottom sheet (overflow
// menu) with the same destinations as the desktop Admin dropdown in
// tt-nav-extras.js — easier thumb reach than the top-nav caret menu.
//
// Usage: <script src="tt-bottom-nav.js?v=…"></script> after body
// content. The script auto-injects markup + styles, detects current page
// from window.location.pathname, and highlights the matching tab.

(function () {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  // Idempotent — multiple script loads won't double-inject.
  if (document.getElementById("tt-bottom-nav")) return;
  if (document.getElementById("tt-bottom-nav-style")) return;

  // ── Inject styles ───────────────────────────────────────────
  const style = document.createElement("style");
  style.id = "tt-bottom-nav-style";
  style.textContent = `
    .tt-bn {
      display: none;
      position: fixed !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      top: auto !important;
      width: 100% !important;
      /* 2026-07-23 — never use transform or backdrop filter (iOS detaches
         the compositor layer). v7 tried per-frame visualViewport top
         writes; that fought Safari chrome and caused jump-then-snap.
         v8 stays on CSS bottom:0 and only re-settles after scroll ends. */
      z-index: 2147483000;
      padding: 8px 8px max(24px, env(safe-area-inset-bottom));
      background: rgba(11,20,16,0.97);
      border-top: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 -2px 16px rgba(0,0,0,0.45);
      box-sizing: border-box;
    }
    .tt-bn.is-keyboard-hidden {
      visibility: hidden;
      pointer-events: none;
    }
    .tt-bn-row {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 4px;
      max-width: 720px;
      margin: 0 auto;
    }
    .tt-bn-row.tt-bn-row--admin {
      grid-template-columns: repeat(6, 1fr);
      gap: 2px;
    }
    .tt-bn-row.tt-bn-row--admin .tt-bn-label {
      font-size: 9px;
    }
    .tt-bn-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 6px 4px 4px;
      border-radius: 10px;
      text-decoration: none;
      color: rgba(229,231,235,0.55);
      transition: background 120ms ease, color 120ms ease;
      min-height: 50px;
      background: transparent;
      border: none;
      cursor: pointer;
      font: inherit;
      -webkit-appearance: none;
      appearance: none;
      width: 100%;
    }
    .tt-bn-item:active { background: rgba(255,255,255,0.06); }
    .tt-bn-item.active {
      color: #38F2A1;
      background: rgba(56,242,161,0.10);
    }
    .tt-bn-item .tt-bn-icon {
      width: 20px; height: 20px;
      display: flex; align-items: center; justify-content: center;
      position: relative;
    }
    .tt-bn-badge {
      position: absolute;
      top: -6px;
      right: -10px;
      min-width: 16px;
      height: 14px;
      padding: 0 4px;
      border-radius: 999px;
      font-size: 9.5px;
      font-weight: 800;
      line-height: 14px;
      text-align: center;
      background: rgba(52,211,153,0.18);
      color: #34d399;
      border: 1px solid rgba(52,211,153,0.32);
      display: none;
      pointer-events: none;
      letter-spacing: 0.02em;
    }
    .tt-bn-badge.show { display: inline-block; }
    .tt-bn-item.active .tt-bn-badge {
      background: rgba(52,211,153,0.28);
      color: #6ee7b7;
    }
    .tt-bn-item .tt-bn-icon svg {
      width: 18px; height: 18px;
      stroke: currentColor; fill: none;
      stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
    }
    .tt-bn-item .tt-bn-label {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      font-family: "Inter", system-ui, sans-serif;
      white-space: nowrap;
    }

    /* Admin bottom sheet (overflow menu) */
    .tt-bn-sheet-root {
      display: none;
      position: fixed;
      inset: 0;
      z-index: 2147483600;
    }
    .tt-bn-sheet-root.open { display: block; }
    .tt-bn-sheet-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0,0,0,0.55);
    }
    .tt-bn-sheet {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      max-height: min(72vh, 560px);
      overflow: auto;
      background: #0B1410;
      border-top: 1px solid rgba(255,255,255,0.12);
      border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 32px rgba(0,0,0,0.5);
      padding: 10px 12px max(20px, env(safe-area-inset-bottom));
      box-sizing: border-box;
      -webkit-overflow-scrolling: touch;
    }
    .tt-bn-sheet-handle {
      width: 36px;
      height: 4px;
      border-radius: 999px;
      background: rgba(255,255,255,0.18);
      margin: 2px auto 12px;
    }
    .tt-bn-sheet-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #51635A;
      padding: 0 8px 8px;
      font-family: "Inter", system-ui, sans-serif;
    }
    .tt-bn-sheet-link {
      display: block;
      padding: 14px 12px;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 500;
      color: #E8F2EC;
      text-decoration: none;
      font-family: "Inter", system-ui, sans-serif;
    }
    .tt-bn-sheet-link:active {
      background: rgba(255,255,255,0.06);
    }
    .tt-bn-sheet-link.active {
      color: #38F2A1;
      background: rgba(56,242,161,0.10);
      font-weight: 600;
    }

    @media (max-width: 768px) {
      .tt-bn { display: block; }
      #legal-footer { bottom: 56px !important; }
      body { padding-bottom: 64px; }
    }
  `;
  document.head.appendChild(style);

  const icons = {
    today: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0"/><path d="M12 6v6l4 2"/></svg>',
    trader: '<svg viewBox="0 0 24 24"><path d="M3 18l5-6 4 3 5-7 4 5"/><path d="M3 21h18"/></svg>',
    investor: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M5 8h14"/><path d="M5 16h14"/></svg>',
    portfolio: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M8 6V4h8v2"/></svg>',
    insights: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/><path d="M3 12h2M19 12h2M12 3v2M12 19v2"/></svg>',
    learn: '<svg viewBox="0 0 24 24"><path d="M4 6h13a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3z"/><path d="M4 6a2 2 0 0 1 2-2h11"/></svg>',
    admin: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  };

  // Keep in sync with ADMIN_LINKS in tt-nav-extras.js (desktop dropdown).
  // Prefer window.TT_ADMIN_NAV_LINKS when nav-extras has already mounted.
  const ADMIN_LINKS_FALLBACK = [
    { href: "/screener.html",              label: "Screener" },
    { href: "/ticker-management.html",     label: "Tickers" },
    { href: "/trade-autopsy.html",         label: "Trade Autopsy" },
    { href: "/admin-clients.html",         label: "Admin Clients" },
    { href: "/model-performance.html",     label: "Model Performance" },
    { href: "/system-intelligence.html",   label: "System Intelligence" },
    { href: "/mission-control.html",       label: "Mission Control" },
    { href: "/research-desk.html",         label: "Research Desk" },
    { href: "/brand-kit.html",             label: "Brand Kit" },
  ];

  function getAdminLinks() {
    const shared = typeof window !== "undefined" ? window.TT_ADMIN_NAV_LINKS : null;
    if (Array.isArray(shared) && shared.length) return shared;
    return ADMIN_LINKS_FALLBACK;
  }

  // 2026-07-22 — model-first: Trader + Investor → one Model tab.
  const items = [
    { id: "today",     href: "/today.html",          label: "Today" },
    { id: "trader",    href: "/active-trader.html",  label: "Model",     matches: ["active-trader", "index-react", "investor", "investor-dashboard"] },
    { id: "portfolio", href: "/portfolio.html",      label: "Portfolio" },
    { id: "insights",  href: "/insights.html",       label: "Insights" },
    { id: "learn",     href: "/learn.html",          label: "Learn" },
  ];

  const currentPath = (window.location.pathname || "")
    .replace(/^\//, "")
    .replace(/\.html$/, "")
    .toLowerCase() || "today";

  function pathFromHref(href) {
    return String(href || "")
      .replace(/^\//, "")
      .replace(/\.html$/, "")
      .toLowerCase();
  }

  function isAdminPath() {
    return getAdminLinks().some((link) => pathFromHref(link.href) === currentPath);
  }

  function isActive(item) {
    if (item.id === currentPath) return true;
    if (Array.isArray(item.matches) && item.matches.includes(currentPath)) return true;
    return false;
  }

  function isAdminUser() {
    try { if (window._ttIsAdmin === true) return true; } catch (_) {}
    try {
      const ds = document.body && document.body.dataset;
      if (ds && (ds.isAdmin === "true" || ds.tier === "admin" || ds.userRole === "admin")) return true;
    } catch (_) {}
    return false;
  }

  const nav = document.createElement("nav");
  nav.id = "tt-bottom-nav";
  nav.className = "tt-bn";
  nav.setAttribute("aria-label", "Primary mobile navigation");
  // Diagnostic: document.getElementById("tt-bottom-nav").dataset
  //   ttBnState: "pinned" | "keyboard"
  nav.dataset.ttBnMounted = "1";
  nav.dataset.ttBnBuiltAt = "2026-08-02-v9";
  nav.dataset.ttBnState = "pinned";

  const row = document.createElement("div");
  row.className = "tt-bn-row";

  for (const item of items) {
    const a = document.createElement("a");
    a.href = item.href;
    a.className = "tt-bn-item" + (isActive(item) ? " active" : "");
    a.dataset.ttBnId = item.id;
    if (isActive(item)) a.setAttribute("aria-current", "page");

    const iconWrap = document.createElement("span");
    iconWrap.className = "tt-bn-icon";
    iconWrap.innerHTML = icons[item.id] || "";

    if (item.id === "trader") {
      const badge = document.createElement("span");
      badge.className = "tt-bn-badge";
      badge.dataset.for = item.id;
      badge.textContent = "";
      iconWrap.appendChild(badge);
    }

    const labelEl = document.createElement("span");
    labelEl.className = "tt-bn-label";
    labelEl.textContent = item.label;

    a.appendChild(iconWrap);
    a.appendChild(labelEl);
    row.appendChild(a);
  }

  nav.appendChild(row);

  // ── Admin sheet ─────────────────────────────────────────────
  const sheetRoot = document.createElement("div");
  sheetRoot.id = "tt-bn-admin-sheet";
  sheetRoot.className = "tt-bn-sheet-root";
  sheetRoot.setAttribute("aria-hidden", "true");

  const backdrop = document.createElement("div");
  backdrop.className = "tt-bn-sheet-backdrop";
  sheetRoot.appendChild(backdrop);

  const sheet = document.createElement("div");
  sheet.className = "tt-bn-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "Admin pages");

  const handle = document.createElement("div");
  handle.className = "tt-bn-sheet-handle";
  handle.setAttribute("aria-hidden", "true");
  sheet.appendChild(handle);

  const sheetTitle = document.createElement("div");
  sheetTitle.className = "tt-bn-sheet-title";
  sheetTitle.textContent = "Admin";
  sheet.appendChild(sheetTitle);

  const sheetLinks = document.createElement("div");
  sheetLinks.className = "tt-bn-sheet-links";
  sheet.appendChild(sheetLinks);
  sheetRoot.appendChild(sheet);

  function populateSheetLinks() {
    sheetLinks.innerHTML = "";
    for (const item of getAdminLinks()) {
      if (!item || !item.href || !item.label) continue;
      const a = document.createElement("a");
      a.href = item.href;
      a.className = "tt-bn-sheet-link";
      a.textContent = item.label;
      if (pathFromHref(item.href) === currentPath) {
        a.classList.add("active");
        a.setAttribute("aria-current", "page");
      }
      sheetLinks.appendChild(a);
    }
  }

  function closeAdminSheet() {
    sheetRoot.classList.remove("open");
    sheetRoot.setAttribute("aria-hidden", "true");
    const adminBtn = row.querySelector('[data-tt-bn-id="admin"]');
    if (adminBtn) adminBtn.setAttribute("aria-expanded", "false");
  }

  function openAdminSheet() {
    populateSheetLinks();
    sheetRoot.classList.add("open");
    sheetRoot.setAttribute("aria-hidden", "false");
    const adminBtn = row.querySelector('[data-tt-bn-id="admin"]');
    if (adminBtn) adminBtn.setAttribute("aria-expanded", "true");
  }

  function toggleAdminSheet(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (sheetRoot.classList.contains("open")) closeAdminSheet();
    else openAdminSheet();
  }

  backdrop.addEventListener("click", closeAdminSheet);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetRoot.classList.contains("open")) closeAdminSheet();
  });

  function ensureAdminTab() {
    if (!isAdminUser()) return;
    if (row.querySelector('[data-tt-bn-id="admin"]')) return;

    row.classList.add("tt-bn-row--admin");
    nav.dataset.ttBnAdmin = "1";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tt-bn-item" + (isAdminPath() ? " active" : "");
    btn.dataset.ttBnId = "admin";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", "Admin pages");
    if (isAdminPath()) btn.setAttribute("aria-current", "page");

    const iconWrap = document.createElement("span");
    iconWrap.className = "tt-bn-icon";
    iconWrap.innerHTML = icons.admin;

    const labelEl = document.createElement("span");
    labelEl.className = "tt-bn-label";
    labelEl.textContent = "Admin";

    btn.appendChild(iconWrap);
    btn.appendChild(labelEl);
    btn.addEventListener("click", toggleAdminSheet);
    row.appendChild(btn);

    if (!sheetRoot.parentNode && document.body) {
      document.body.appendChild(sheetRoot);
    }
  }

  function mountNav() {
    if (!document.body) return;
    if (nav.parentNode !== document.body) {
      document.body.appendChild(nav);
    }
    if (sheetRoot.parentNode !== document.body && isAdminUser()) {
      document.body.appendChild(sheetRoot);
    }
    ensureAdminTab();
  }

  let _settleTimer = 0;

  /**
   * Keep the bar a direct body child on CSS bottom:0.
   *
   * v7 wrote `top` from visualViewport on every scroll/rAF. Safari also
   * moves fixed bars while the URL chrome animates, so our correction
   * looked like jump-up-then-snap-back. v8 does not touch geometry during
   * an active scroll — only re-assert bottom:0 after the gesture settles.
   */
  function pinNavToViewport() {
    const navEl = document.getElementById("tt-bottom-nav");
    if (!navEl || !document.body) return;
    if (navEl.parentNode !== document.body) {
      document.body.appendChild(navEl);
    }
    navEl.style.setProperty("position", "fixed", "important");
    navEl.style.setProperty("left", "0px", "important");
    navEl.style.setProperty("right", "0px", "important");
    navEl.style.setProperty("width", "100%", "important");
    navEl.style.setProperty("bottom", "0px", "important");
    navEl.style.setProperty("top", "auto", "important");
    navEl.style.removeProperty("transform");
    navEl.style.removeProperty("-webkit-transform");
    delete navEl.dataset.ttBnTop;
  }

  /** Debounced settle — runs after scroll/chrome animation finishes. */
  function scheduleSettle(delayMs) {
    const ms = Number.isFinite(delayMs) ? delayMs : 140;
    if (_settleTimer) clearTimeout(_settleTimer);
    _settleTimer = setTimeout(() => {
      _settleTimer = 0;
      pinNavToViewport();
    }, ms);
  }

  if (document.body) {
    mountNav();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      mountNav();
      pinNavToViewport();
    });
  }
  pinNavToViewport();

  // Auth resolves async (auth-gate → tt-auth-bootstrap-updated). Re-try
  // Admin tab injection when role flags land after first paint.
  window.addEventListener("tt-auth-bootstrap-updated", () => {
    ensureAdminTab();
  });
  // Brief poll for hard-refresh where session is in localStorage before
  // the auth event fires (mirrors tt-nav-extras).
  (function pollForAdmin() {
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      if (isAdminUser()) {
        ensureAdminTab();
        clearInterval(id);
        return;
      }
      if (tries > 20) clearInterval(id);
    }, 150);
  })();

  function setBottomBadge(id, value) {
    const el = nav.querySelector(`.tt-bn-badge[data-for="${id}"]`);
    if (!el) return;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
      el.textContent = n > 99 ? "99+" : String(n);
      el.classList.add("show");
    } else {
      el.textContent = "";
      el.classList.remove("show");
    }
  }

  function apiBase() {
    if (typeof window !== "undefined" && window.TT_API_BASE) return String(window.TT_API_BASE);
    if (typeof API_BASE !== "undefined" && API_BASE) return String(API_BASE);
    return typeof window !== "undefined" ? window.location.origin : "";
  }

  async function fetchOpenTradeCount() {
    try {
      const r = await fetch(`${apiBase()}/timed/trades?source=positions`, {
        credentials: "include", cache: "no-store",
      });
      if (!r.ok) return null;
      const j = await r.json();
      const trades = Array.isArray(j?.trades) ? j.trades : (Array.isArray(j) ? j : []);
      // Match tt-nav-extras: unique open tickers (not raw row count).
      const seen = new Set();
      let open = 0;
      for (const t of trades) {
        const sym = String(t?.ticker || "").toUpperCase();
        if (!sym || seen.has(sym)) continue;
        const status = String(t?.status || "").toUpperCase();
        const exitTs = Number(t?.exit_ts ?? t?.exitTs ?? 0);
        if (exitTs > 0) continue;
        if (status === "WIN" || status === "LOSS" || status === "FLAT" || status === "CLOSED") continue;
        seen.add(sym);
        open += 1;
      }
      return open;
    } catch { return null; }
  }

  async function fetchInvestorOwnedCount() {
    try {
      const r = await fetch(`${apiBase()}/timed/investor/scores`, {
        credentials: "include", cache: "no-store",
      });
      if (!r.ok) return null;
      const j = await r.json();
      const arr = Array.isArray(j?.tickers) ? j.tickers
                : Array.isArray(j?.scores)  ? j.scores
                : Array.isArray(j)          ? j
                : [];
      if (typeof window.TTCountInvestorOwnedForModelBadge === "function") {
        return window.TTCountInvestorOwnedForModelBadge(arr);
      }
      if (typeof window.TTModelLaneCounts?.countInvestorOwnedForModelBadge === "function") {
        return window.TTModelLaneCounts.countInvestorOwnedForModelBadge(arr);
      }
      return arr.filter(s => {
        const stage = String(s?.stage || s?.investor_stage || s?.verdict || "").toLowerCase();
        if (stage === "exited") return false;
        return !!(s?.position && s.position.owned);
      }).length;
    } catch { return null; }
  }

  async function applyBadges() {
    const [trader, investor] = await Promise.all([
      fetchOpenTradeCount(),
      fetchInvestorOwnedCount(),
    ]);
    const total = (Number(trader) || 0) + (Number(investor) || 0);
    setBottomBadge("trader", total > 0 ? total : null);
  }
  applyBadges();
  setInterval(applyBadges, 60 * 1000);
  window.addEventListener("tt-nav-badges-updated", (ev) => {
    const d = ev && ev.detail;
    if (!d || typeof d !== "object") return;
    const total = (Number(d.trader) || 0) + (Number(d.investor) || 0);
    setBottomBadge("trader", total > 0 ? total : null);
  });

  function isTextInputFocused() {
    const ae = document.activeElement;
    if (!ae) return false;
    const tag = String(ae.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (ae.isContentEditable) return true;
    return false;
  }

  function syncNavKeyboardState() {
    const navEl = document.getElementById("tt-bottom-nav");
    if (!navEl) return;
    pinNavToViewport();
    if (isTextInputFocused()) {
      navEl.classList.add("is-keyboard-hidden");
      navEl.dataset.ttBnState = "keyboard";
      // Hide sheet with keyboard so it doesn't float over inputs.
      if (sheetRoot.classList.contains("open")) closeAdminSheet();
    } else {
      navEl.classList.remove("is-keyboard-hidden");
      navEl.dataset.ttBnState = "pinned";
    }
  }

  window.addEventListener("focusin", syncNavKeyboardState, true);
  window.addEventListener("focusout", () => setTimeout(syncNavKeyboardState, 50), true);
  // Do NOT pin on every scroll tick — that caused jump/snap with v7.
  // scrollend (where supported) + debounced fallback after scroll.
  window.addEventListener("scrollend", () => pinNavToViewport(), { passive: true });
  window.addEventListener("scroll", () => scheduleSettle(160), { passive: true, capture: true });
  window.addEventListener("resize", () => scheduleSettle(100), { passive: true });
  window.addEventListener("orientationchange", () => scheduleSettle(280), { passive: true });
  // visualViewport resize = chrome finished changing. Skip vv *scroll*
  // (fires continuously while the URL bar animates → jitter).
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => scheduleSettle(120), { passive: true });
  }
  syncNavKeyboardState();
  setTimeout(pinNavToViewport, 150);
  setTimeout(pinNavToViewport, 400);
})();

// cache-bust:1786613090658:646906729
