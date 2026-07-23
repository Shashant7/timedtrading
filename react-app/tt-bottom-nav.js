// tt-bottom-nav.js — Mobile bottom navigation
//
// Mobile-only thumb-friendly nav that pins to the bottom of the screen.
// Mirrors the top nav's primary destinations so users have one-tap access
// no matter where they are on the page (especially important on long
// scrolling pages like /portfolio + /insights).
//
// Hidden on screens ≥ 768px (desktop has the sticky top nav already).
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
  };

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

  function isActive(item) {
    if (item.id === currentPath) return true;
    if (Array.isArray(item.matches) && item.matches.includes(currentPath)) return true;
    return false;
  }

  const nav = document.createElement("nav");
  nav.id = "tt-bottom-nav";
  nav.className = "tt-bn";
  nav.setAttribute("aria-label", "Primary mobile navigation");
  // Diagnostic: document.getElementById("tt-bottom-nav").dataset
  //   ttBnState: "pinned" | "keyboard"
  nav.dataset.ttBnMounted = "1";
  nav.dataset.ttBnBuiltAt = "2026-07-23-v8";
  nav.dataset.ttBnState = "pinned";

  const row = document.createElement("div");
  row.className = "tt-bn-row";

  for (const item of items) {
    const a = document.createElement("a");
    a.href = item.href;
    a.className = "tt-bn-item" + (isActive(item) ? " active" : "");
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

  function mountNav() {
    if (!document.body) return;
    if (nav.parentNode !== document.body) {
      document.body.appendChild(nav);
    }
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
      return trades.filter(t => {
        const s = String(t?.status || "").toUpperCase();
        return s === "OPEN" || s === "TP_HIT_TRIM" || !s;
      }).length;
    } catch { return null; }
  }

  async function fetchInvestorActionableCount() {
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
      if (typeof window.TTCountInvestorNavBadge === "function") {
        return window.TTCountInvestorNavBadge(arr);
      }
      return arr.filter(s => {
        const stage = String(s?.stage || s?.investor_stage || s?.verdict || "").toLowerCase();
        if (stage === "reduce") return true;
        if (stage === "accumulate") {
          const tier = String(s?.actionTier || "").toLowerCase();
          return tier === "act_now" || tier === "ready";
        }
        return false;
      }).length;
    } catch { return null; }
  }

  async function applyBadges() {
    const [trader, investor] = await Promise.all([
      fetchOpenTradeCount(),
      fetchInvestorActionableCount(),
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
