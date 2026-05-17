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
      z-index: 8500;
      padding: 8px 8px max(8px, env(safe-area-inset-bottom));
      background: rgba(10,12,16,0.94);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      border-top: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 -2px 16px rgba(0,0,0,0.45);
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
      color: #f5c25c;
      background: rgba(245,194,92,0.10);
    }
    .tt-bn-item .tt-bn-icon {
      width: 20px; height: 20px;
      display: flex; align-items: center; justify-content: center;
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
    @media (max-width: 720px) {
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
})();
