// tt-bottom-nav.js — Mobile bottom navigation
//
// Mobile-only thumb-friendly nav that pins to the bottom of the screen.
// Mirrors the top nav's primary destinations so users have one-tap access
// no matter where they are on the page (especially important on long
// scrolling pages like /portfolio + /insights).
//
// Hidden on screens ≥ 720px (desktop has the sticky top nav already).
//
// Usage: <script src="tt-bottom-nav.js?v=20260517a"></script> after body
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
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      /* 2026-05-31 — User report: bottom nav was appearing mid-page on
         iOS Safari instead of pinned to the viewport. Root cause was
         the PaywallScreen wrapper using transform translate3d (and
         some legacy callers using transform translateZ(0) to force
         GPU layers) — when ANY ancestor of a position:fixed element
         has a transform, filter, or perspective, the fixed element's
         containing block becomes that ancestor instead of the
         viewport. So the nav appeared at the bottom of the paywall
         card, not the bottom of the screen.

         Re-parent the nav DIRECTLY under body via document.body
         .appendChild() (already in code below) AND bump z-index so
         it always wins. The translate3d inside the nav itself is
         fine (it doesn't affect its own positioning context) — it's
         ancestor transforms that break fixed positioning.

         2026-06-01 (v3) — CRITICAL: removed inline backticks around
         transform keywords (was 'transform: translate3d' etc with
         backticks). Those backticks were INSIDE the outer JS template
         literal that defines this CSS, so they terminated the literal
         early and the entire script body after this point was parsed
         as bare JavaScript identifiers — guaranteed SyntaxError on
         every load. The script silently never ran in any browser for
         ~2 weeks. Never use backticks inside a template literal's CSS
         body, even in comments. */
      z-index: 2147483000;
      /* 2026-06-01 (v2) — Bumped floor 14px → 24px AND added a
         visualViewport-driven translateY adjustment (see JS at the
         bottom of this file). On iOS Safari (which is the primary
         victim of this class of bug), env(safe-area-inset-bottom)
         covers ONLY the Home Indicator (~34px on Face ID phones).
         It does NOT include the compact bottom URL bar that Safari
         renders below the page content — that bar is ~50-60px tall
         and the only way to detect it is via visualViewport.height
         being less than window.innerHeight. The JS adds an inline
         transform on the nav element when that delta is non-zero so
         the nav floats above the URL bar instead of disappearing
         behind it. The 24px CSS floor below stops the nav being
         flush with the screen edge on Android / desktop where the
         visualViewport delta is always 0. */
      padding: 8px 8px max(24px, env(safe-area-inset-bottom));
      background: rgba(11,20,16,0.94);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-top: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 -2px 16px rgba(0,0,0,0.45);
      /* Bug 2026-05-20: iOS Safari momentum-scroll fixed-position quirk.
         Force GPU compositing so the nav stays in its own layer.
         The visualViewport JS below mutates this transform property at
         runtime — preserve translate3d(0,0,0) as the resting state. */
      transform: translate3d(0, 0, 0);
      -webkit-transform: translate3d(0, 0, 0);
      will-change: transform;
      -webkit-backface-visibility: hidden;
      backface-visibility: hidden;
      /* Smooth out the URL-bar push when iOS Safari toggles the
         compact bar (typical case: user scrolls up and bar appears,
         scrolls down and bar collapses). 120ms feels native, longer
         feels laggy. */
      transition: transform 120ms ease-out;
    }
    .tt-bn-row {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
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
    /* Bug 2 — bottom-nav badge (mirrors the desktop top-nav .nav-badge
       styling used by tt-nav-extras.js). Hidden until populated. */
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
      /* Push the legal footer up out of the bottom-nav's way so they don't overlap. */
      #legal-footer { bottom: 56px !important; }
      body { padding-bottom: 64px; }
    }
  `;
  document.head.appendChild(style);

  // ── SVG icon registry (minimal, currentColor) ───────────────
  const icons = {
    today: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0"/><path d="M12 6v6l4 2"/></svg>',
    trader: '<svg viewBox="0 0 24 24"><path d="M3 18l5-6 4 3 5-7 4 5"/><path d="M3 21h18"/></svg>',
    investor: '<svg viewBox="0 0 24 24"><path d="M12 3v18"/><path d="M5 8h14"/><path d="M5 16h14"/></svg>',
    portfolio: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M8 6V4h8v2"/></svg>',
    insights: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/><path d="M3 12h2M19 12h2M12 3v2M12 19v2"/></svg>',
    learn: '<svg viewBox="0 0 24 24"><path d="M4 6h13a3 3 0 0 1 3 3v11H7a3 3 0 0 1-3-3z"/><path d="M4 6a2 2 0 0 1 2-2h11"/></svg>',
  };

  // ── Items definition ───────────────────────────────────────
  const items = [
    { id: "today",     href: "/today.html",          label: "Today" },
    { id: "trader",    href: "/active-trader.html",  label: "Trader",    matches: ["active-trader", "index-react"] },
    { id: "investor",  href: "/investor.html",       label: "Investor",  matches: ["investor", "investor-dashboard"] },
    { id: "portfolio", href: "/portfolio.html",      label: "Portfolio" },
    { id: "insights",  href: "/insights.html",       label: "Insights" },
    { id: "learn",     href: "/learn.html",          label: "Learn" },
  ];

  // ── Determine active item from URL ─────────────────────────
  const currentPath = (window.location.pathname || "")
    .replace(/^\//, "")
    .replace(/\.html$/, "")
    .toLowerCase() || "today";

  function isActive(item) {
    if (item.id === currentPath) return true;
    if (Array.isArray(item.matches) && item.matches.includes(currentPath)) return true;
    return false;
  }

  // ── Build nav element ──────────────────────────────────────
  const nav = document.createElement("nav");
  nav.id = "tt-bottom-nav";
  nav.className = "tt-bn";
  nav.setAttribute("aria-label", "Primary mobile navigation");
  // 2026-06-01 (v3) — Diagnostic attributes so the next "where's the
  // nav?" report can be triaged in 5 seconds via DevTools instead of a
  // round-trip:
  //   data-tt-bn-mounted   — proves the script ran + appendChild fired
  //   data-tt-bn-built-at  — script vintage (lines up with cache-bust)
  //   data-tt-bn-state     — updated by syncNavToVisualViewport:
  //                          "settled"            no URL bar push
  //                          "url-bar-<N>px"      pushed N px up
  //                          "keyboard"           hidden (keyboard open)
  // Devtools (Mobile Safari Inspector):
  //   document.getElementById("tt-bottom-nav").dataset
  nav.dataset.ttBnMounted = "1";
  nav.dataset.ttBnBuiltAt = "2026-06-01-v3";
  nav.dataset.ttBnState = "init";

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

    // Bug 2 (2026-05-19) — badge support on bottom nav. Desktop top
    // nav already shows badges via tt-nav-extras.js for Active Trader
    // (open-trade count) and Investor (actionable count). Mobile bottom
    // nav previously had no badge DOM at all. Stub badges for trader /
    // investor here; populated by the helpers below on mount + every 60s.
    if (item.id === "trader" || item.id === "investor") {
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

  // ── Inject when DOM ready ──────────────────────────────────
  if (document.body) {
    document.body.appendChild(nav);
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      if (!document.getElementById("tt-bottom-nav")) {
        document.body.appendChild(nav);
      }
    });
  }

  // ── Bug 2: bottom-nav badges ────────────────────────────────
  // Mirror of tt-nav-extras.js setBadge() but targets the mobile
  // bottom nav's .tt-bn-badge slots. Same data sources (open trade
  // count + investor actionable count) so the two navs stay in sync.
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
      // 2026-05-21 — Bug: /timed/investor/scores returns
      //   { ok, count, computedAt, tickers: [...] }
      // The original code read `j.scores` (never present) so the list was
      // always empty and the Investor badge never lit up. The endpoint
      // accepts an optional ?stage= filter — pass `accumulate` first to
      // count the "BUY NOW" lane, then a second call for `reduce`. Two
      // tiny GETs (KV-backed, cached) and the badge total matches the
      // count chips on the Investor page.
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
    setBottomBadge("trader", trader);
    setBottomBadge("investor", investor);
  }
  applyBadges();
  setInterval(applyBadges, 60 * 1000);
  window.addEventListener("tt-nav-badges-updated", (ev) => {
    const d = ev && ev.detail;
    if (!d || typeof d !== "object") return;
    setBottomBadge("trader", d.trader);
    setBottomBadge("investor", d.investor);
  });

  // ── iOS Safari compact URL bar — keep nav above it ──────────
  // 2026-06-01 (v2) — Root cause of "bottom nav missing on mobile":
  // iOS Safari's compact (collapsed) bottom URL bar is ~50-60px tall
  // and renders BELOW the layout viewport. env(safe-area-inset-bottom)
  // does NOT include it (that constant only covers the Home Indicator,
  // typically ~34px). So a `position: fixed; bottom: 0;` element with
  // only safe-area padding renders behind the URL bar and is invisible.
  //
  // visualViewport.height shrinks when the URL bar shows; the delta vs
  // window.innerHeight equals the URL-bar height. We push the nav up by
  // that delta via inline transform (the CSS keeps translate3d for GPU
  // compositing — JS overrides it with translate3d(0, -Npx, 0) so the
  // GPU layer is preserved). When the user scrolls down and Safari
  // collapses the URL bar, delta returns to 0 and the nav settles back
  // to bottom: 0. The CSS transition makes the move smooth.
  //
  // Browsers without visualViewport (older Android Firefox / Safari 12-)
  // just see the CSS padding and live with the 24px floor.
  function syncNavToVisualViewport() {
    const navEl = document.getElementById("tt-bottom-nav");
    if (!navEl) return;
    const vv = window.visualViewport;
    if (!vv) {
      navEl.style.transform = "translate3d(0, 0, 0)";
      return;
    }
    // visualViewport.height < window.innerHeight when iOS Safari
    // shows its bottom URL bar; offsetTop accounts for any keyboard
    // push (we want to subtract that too — a focused input shifts
    // the visual viewport up).
    const innerH = window.innerHeight;
    const vvH = vv.height;
    const vvOffsetTop = vv.offsetTop || 0;
    const delta = Math.max(0, Math.round(innerH - vvH - vvOffsetTop));

    // 2026-06-01 (v3) — User report: nav still hidden on today.html with
    // iOS Safari URL bar EXPANDED. Root cause: the previous "delta > 120
    // = keyboard" sanity floor was too aggressive. On iPhone Pro Max
    // with the fully-expanded bottom URL bar (refresh / back / forward
    // visible), delta = ~175px — well past the 120 threshold, so the
    // nav was getting hidden as a false-positive "keyboard open".
    //
    // New keyboard detection: keyboards take 35%+ of the screen height
    // (typical iOS keyboard ≈ 340px / 932px = 36%). URL bars never take
    // more than ~15% (88px / 932px). Use a height-ratio check that's
    // much harder to misfire on URL-bar transitions.
    const isKeyboardOpen = vvH > 0 && vvH < innerH * 0.65;
    if (isKeyboardOpen) {
      // Hide the nav while the keyboard is up — pushing it would land
      // mid-page and overlap content the user is typing into.
      navEl.style.transform = "translate3d(0, 200%, 0)";
      navEl.dataset.ttBnState = "keyboard";
    } else {
      navEl.style.transform = `translate3d(0, -${delta}px, 0)`;
      navEl.dataset.ttBnState = delta > 0 ? `url-bar-${delta}px` : "settled";
    }
  }
  // Initial pass + listen to every viewport change (resize, scroll, and
  // also a one-shot after the DOM is fully wired so we catch the
  // post-paint viewport settle on iOS).
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", syncNavToVisualViewport, { passive: true });
    window.visualViewport.addEventListener("scroll", syncNavToVisualViewport, { passive: true });
  }
  window.addEventListener("orientationchange", () => setTimeout(syncNavToVisualViewport, 250), { passive: true });
  // First sync after layout settles. iOS Safari's URL bar typically
  // animates in over ~300ms; sync at 0/150/400 so we catch every
  // intermediate state.
  syncNavToVisualViewport();
  setTimeout(syncNavToVisualViewport, 150);
  setTimeout(syncNavToVisualViewport, 400);
})();

// cache-bust:1783862931351:783680311
