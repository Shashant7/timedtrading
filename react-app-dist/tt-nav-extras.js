/* tt-nav-extras.js
 *
 * Enhances the journey-page top nav with:
 *   1. Actionable-count badges on the "Active Trader" and "Investor"
 *      nav links — count of open trades / investor actionable cards
 *      so users always see what's worth opening today.
 *   2. An "Admin" dropdown for admin users (gated on body.dataset.isAdmin
 *      and the CF Access JWT cookie), surfacing the admin pages
 *      (Screener, System Intelligence, Trade Autopsy, Model Dashboard,
 *      Calibration, Ticker Management, Debug Dashboard, Brand Kit).
 *
 * No JSX — vanilla DOM patching so it can run on any page that has
 * a `.nav-links` container.
 *
 * Load order: AFTER auth-gate.js (so body.dataset.isAdmin / _ttIsPro
 * are populated), AFTER the page's own DOMContentLoaded nav render.
 * The module is idempotent — calling init() twice is safe.
 */
(function () {
  if (typeof window === "undefined") return;
  if (typeof document === "undefined") return;

  const API_BASE = window.TT_API_BASE || "";

  // ── Styles (injected once, namespaced) ────────────────────────
  function ensureStyles() {
    if (document.getElementById("tt-nav-extras-styles")) return;
    const el = document.createElement("style");
    el.id = "tt-nav-extras-styles";
    el.textContent = `
      .nav-link .nav-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        margin-left: 6px;
        border-radius: 999px;
        font-family: var(--tt-font-mono);
        font-size: 10px;
        font-weight: 700;
        background: var(--tt-accent-dim, rgba(245,194,92,0.16));
        color: var(--tt-accent, #f5c25c);
        vertical-align: middle;
      }
      .nav-link .nav-badge.up { background: var(--tt-up-bg, rgba(34,197,94,0.10)); color: var(--tt-up-soft, #34d399); }
      .nav-link .nav-badge.dn { background: var(--tt-dn-bg, rgba(244,63,94,0.10)); color: var(--tt-dn-soft, #fb7185); }

      /* Admin dropdown */
      .nav-admin {
        position: relative;
      }
      .nav-admin-toggle {
        font-size: 12.5px;
        color: var(--tt-text-muted, #9ca3af);
        background: transparent;
        border: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        padding: 6px 12px;
        border-radius: 8px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: inherit;
      }
      .nav-admin-toggle:hover {
        color: var(--tt-text, #e5e7eb);
        background: var(--tt-bg-surface, rgba(255,255,255,0.025));
      }
      .nav-admin-toggle .caret {
        display: inline-block;
        font-size: 10px;
        opacity: 0.7;
      }
      .nav-admin-menu {
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 200px;
        background: var(--tt-bg-base, #0b0e11);
        border: 1px solid var(--tt-border-hi, rgba(255,255,255,0.12));
        border-radius: 10px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.45);
        padding: 6px 0;
        z-index: 200;
        display: none;
      }
      .nav-admin.open .nav-admin-menu { display: block; }
      .nav-admin-menu a {
        display: block;
        padding: 8px 14px;
        font-size: 12.5px;
        color: var(--tt-text-muted, #9ca3af);
        text-decoration: none;
        transition: background 120ms ease, color 120ms ease;
      }
      .nav-admin-menu a:hover {
        color: var(--tt-text, #e5e7eb);
        background: var(--tt-bg-elev, rgba(255,255,255,0.04));
      }
      .nav-admin-menu .nav-admin-group {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tt-text-faint, #4b5563);
        padding: 8px 14px 4px;
      }
    `;
    document.head.appendChild(el);
  }

  // ── Auth detection ────────────────────────────────────────────
  function isAdminUser() {
    try { if (window._ttIsAdmin === true) return true; } catch (_) {}
    try {
      const ds = document.body && document.body.dataset;
      if (ds && (ds.isAdmin === "true" || ds.tier === "admin")) return true;
    } catch (_) {}
    return false;
  }

  // ── Badge helpers ─────────────────────────────────────────────
  function setBadge(linkText, value, kind) {
    const links = Array.from(document.querySelectorAll(".nav-links .nav-link"));
    const target = links.find((a) => {
      const tx = (a.textContent || "").trim().replace(/\s+/g, " ");
      // Strip any existing badge digits before comparing
      return tx.replace(/\s*\d+$/, "") === linkText;
    });
    if (!target) return;
    let badge = target.querySelector(".nav-badge");
    if (value == null || value <= 0) {
      if (badge) badge.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-badge";
      target.appendChild(badge);
    }
    badge.className = "nav-badge" + (kind ? " " + kind : "");
    badge.textContent = String(value);
  }

  // ── Fetchers ──────────────────────────────────────────────────
  async function fetchOpenTradeCount() {
    try {
      const r = await fetch(`${API_BASE}/timed/trades?source=positions`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!r.ok) return null;
      const j = await r.json();
      if (!j?.ok || !Array.isArray(j.trades)) return null;
      const seen = new Set();
      let open = 0;
      for (const t of j.trades) {
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
    } catch (_) { return null; }
  }

  async function fetchInvestorActionableCount() {
    try {
      const r = await fetch(`${API_BASE}/timed/investor/scores`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!r.ok) return null;
      const j = await r.json();
      const scores = j?.scores || j?.data || j;
      if (!scores || typeof scores !== "object") return null;
      // Actionable = Accumulate or Reduce stage (per investor-panel).
      let n = 0;
      for (const v of Object.values(scores)) {
        if (!v || typeof v !== "object") continue;
        const stage = String(v.stage || v.investor_stage || "").toLowerCase();
        if (stage === "accumulate" || stage === "reduce") n += 1;
      }
      return n;
    } catch (_) { return null; }
  }

  // ── Admin dropdown ────────────────────────────────────────────
  const ADMIN_LINKS = [
    { group: "Operations" },
    { href: "/screener.html",              label: "Screener" },
    { href: "/ticker-management.html",     label: "Ticker Management" },
    { href: "/admin-clients.html",         label: "Admin Clients" },
    { group: "Engine" },
    { href: "/system-intelligence.html",   label: "System Intelligence" },
    { href: "/model-dashboard.html",       label: "Model Dashboard" },
    { href: "/calibration.html",           label: "Calibration" },
    { group: "Analysis" },
    { href: "/trade-autopsy.html",         label: "Trade Autopsy" },
    { href: "/simulation-dashboard.html",  label: "Simulation Dashboard" },
    { href: "/debug-dashboard.html",       label: "Debug Dashboard" },
    { group: "Misc" },
    { href: "/brand-kit.html",             label: "Brand Kit" },
    { href: "/index-react.html",           label: "Legacy Dashboard" },
  ];

  function injectAdminMenu() {
    if (!isAdminUser()) return;
    const navLinks = document.querySelector(".nav-links");
    if (!navLinks) return;
    if (navLinks.querySelector(".nav-admin")) return;

    const wrap = document.createElement("div");
    wrap.className = "nav-admin";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "nav-admin-toggle";
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = "Admin <span class=\"caret\">▾</span>";
    wrap.appendChild(toggle);

    const menu = document.createElement("div");
    menu.className = "nav-admin-menu";
    for (const item of ADMIN_LINKS) {
      if (item.group) {
        const g = document.createElement("div");
        g.className = "nav-admin-group";
        g.textContent = item.group;
        menu.appendChild(g);
        continue;
      }
      const a = document.createElement("a");
      a.href = item.href;
      a.textContent = item.label;
      menu.appendChild(a);
    }
    wrap.appendChild(menu);
    navLinks.appendChild(wrap);

    const close = () => {
      wrap.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    };
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = wrap.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    ensureStyles();
    injectAdminMenu();

    // Badges — kick off in parallel; render whichever returns.
    fetchOpenTradeCount().then((n) => {
      setBadge("Active Trader", n, "up");
    });
    fetchInvestorActionableCount().then((n) => {
      setBadge("Investor", n, "up");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Re-run when auth-gate finishes (sets _ttIsAdmin via body.dataset).
  // Auth-gate dispatches `tt-auth-bootstrap-updated` with the user
  // profile; admin status is reflected in body.dataset.isAdmin /
  // window._ttIsAdmin shortly after that fires.
  window.addEventListener("tt-auth-bootstrap-updated", () => {
    injectAdminMenu();
  });
})();
