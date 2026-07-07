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
        background: var(--tt-accent-dim, rgba(56,242,161,0.16));
        color: var(--tt-accent, #38F2A1);
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
        font-weight: 500;
        color: var(--tt-text-muted, #8AA39A);
        background: transparent;
        border: none;
        padding: 6px 11px;
        border-radius: 7px;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: inherit;
        transition: background 120ms ease, color 120ms ease;
      }
      .nav-admin-toggle:hover {
        color: var(--tt-text, #E8F2EC);
        background: var(--tt-bg-surface, rgba(255,255,255,0.025));
      }
      .nav-admin.open .nav-admin-toggle {
        color: var(--tt-text, #E8F2EC);
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
        background: var(--tt-bg-base, #0B1410);
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
        color: var(--tt-text-muted, #8AA39A);
        text-decoration: none;
        transition: background 120ms ease, color 120ms ease;
      }
      .nav-admin-menu a:hover {
        color: var(--tt-text, #E8F2EC);
        background: var(--tt-bg-elev, rgba(255,255,255,0.04));
      }
      .nav-admin-menu .nav-admin-group {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tt-text-faint, #51635A);
        padding: 8px 14px 4px;
      }

      /* Right-edge widgets — Discord / Alerts / Avatar. */
      .tt-nav-widgets {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-left: 12px;
      }
      .tt-nav-widget {
        display: inline-flex;
        align-items: center;
      }
      .tt-nav-widget-fallback {
        font-size: 12px;
        color: var(--tt-text-muted, #8AA39A);
        text-decoration: none;
        padding: 6px 10px;
        border-radius: 8px;
        border: 1px solid var(--tt-border, rgba(255,255,255,0.06));
      }
      .tt-nav-widget-fallback:hover {
        color: var(--tt-text, #E8F2EC);
        background: var(--tt-bg-surface, rgba(255,255,255,0.025));
      }

      /* Journey-nav strip prepended on admin pages */
      .tt-journey-strip {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 10px 16px;
        border-bottom: 1px solid var(--tt-border, rgba(255,255,255,0.06));
        background: rgba(11,20,16,0.65);
        flex-wrap: wrap;
      }
      .tt-journey-link {
        font-size: 12.5px;
        font-weight: 500;
        color: var(--tt-text-muted, #8AA39A);
        text-decoration: none;
        padding: 5px 10px;
        border-radius: 7px;
        transition: background 120ms ease, color 120ms ease;
      }
      .tt-journey-link:hover {
        color: var(--tt-text, #E8F2EC);
        background: var(--tt-bg-surface, rgba(255,255,255,0.025));
      }
      .tt-journey-link.active {
        color: var(--tt-accent, #38F2A1);
        background: var(--tt-accent-dim, rgba(56,242,161,0.14));
        font-weight: 600;
      }
      .tt-journey-link--learn { color: var(--tt-up-soft, #34d399); }
      .tt-journey-link--faq   { color: var(--tt-cyan, #A6F7CF); }
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
  // 2026-06-22 — Badge consistency fix. The counts were fetched once in
  // init() and applied immediately, but shared-nav.js mounts the <nav>
  // markup asynchronously (and admin pages mount it via React). When the
  // fetch resolved before the nav existed, setBadge found no target and
  // the badge silently never appeared — so the Investor badge showed on
  // some page loads but not others. Cache the last-known counts and
  // RE-APPLY them whenever the nav (re)mounts or auth resolves.
  const _badgeCounts = Object.create(null);

  function applyBadge(linkText, value, kind) {
    const links = Array.from(document.querySelectorAll(".nav-links .nav-link"));
    const target = links.find((a) => {
      const tx = (a.textContent || "").trim().replace(/\s+/g, " ");
      // Strip any existing badge digits before comparing
      return tx.replace(/\s*\d+$/, "") === linkText;
    });
    if (!target) return false;
    let badge = target.querySelector(".nav-badge");
    if (value == null || value <= 0) {
      if (badge) badge.remove();
      return true;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "nav-badge";
      target.appendChild(badge);
    }
    badge.className = "nav-badge" + (kind ? " " + kind : "");
    badge.textContent = String(value);
    return true;
  }

  function setBadge(linkText, value, kind) {
    // Remember the intent so a later nav mount can re-apply it.
    _badgeCounts[linkText] = { value, kind };
    applyBadge(linkText, value, kind);
  }

  // Re-apply every cached badge — called whenever the nav markup may have
  // (re)appeared (nav poll, auth bootstrap, journey-link injection).
  function reapplyBadges() {
    for (const linkText in _badgeCounts) {
      const c = _badgeCounts[linkText];
      if (c) applyBadge(linkText, c.value, c.kind);
    }
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
      // V15 P0.7.181 (2026-05-17) — /timed/investor/scores returns
      // { ok, count, computedAt, tickers: [...] }. Previous code looked
      // for `j.scores` (which doesn't exist) and fell through to
      // iterating the response object itself, which never matched a
      // stage and left the Investor nav badge blank. Pull the array
      // explicitly and count stages.
      const list = Array.isArray(j?.tickers)
        ? j.tickers
        : Array.isArray(j?.scores)
        ? j.scores
        : Array.isArray(j?.data)
        ? j.data
        : (j?.scores && typeof j.scores === "object" ? Object.values(j.scores) : []);
      // Execution-ready accumulate (act_now/ready) + all reduce — matches
      // INVESTOR_ACTIONABLE filter and kanban lanes (not raw monitor-tier
      // accumulate names that sit in On Radar).
      if (typeof window.TTCountInvestorNavBadge === "function") {
        return window.TTCountInvestorNavBadge(list);
      }
      let n = 0;
      for (const v of list) {
        if (!v || typeof v !== "object") continue;
        const stage = String(v.stage || v.investor_stage || "").toLowerCase();
        if (stage === "reduce") { n++; continue; }
        if (stage === "accumulate") {
          const tier = String(v.actionTier || "").toLowerCase();
          if (tier === "act_now" || tier === "ready") n++;
        }
      }
      return n;
    } catch (_) { return null; }
  }

  // ── Admin dropdown ────────────────────────────────────────────
  // 2026-05-28 — Curated to 7 user-specified items. Dropped (relegated
  // to operator-only direct URL access): Model Dashboard, Calibration,
  // Simulation Dashboard, Debug Dashboard, Legacy Dashboard. Group
  // headers also dropped — small list reads cleaner as a flat menu.
  const ADMIN_LINKS = [
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

  // ── Right-side widgets: Discord / Alerts / Avatar ────────────
  //
  // Mount React widgets (`window.TimedWaitlistButton`,
  // `window.TimedNotificationCenter`, `window.TimedUserBadge`) into a
  // host container at the right of the nav-row. The host appears
  // *after* the .nav-links container so it sits on the far right
  // (matches the layout of /index-react.html's top nav).
  // Mounted React roots so we can update them in place when auth
  // resolves (e.g. show the avatar + alerts bell after login).
  const _navRoots = new Map();

  // V15 P0.7.183 (2026-05-17) — Inject the journey-page primary nav
  // (Today / Active Trader / Investor / Portfolio / Insights / Learn
  // / FAQ) at the start of any admin page's <nav> so users on
  // /system-intelligence, /screener, /ticker-management, /trade-
  // autopsy etc. can navigate back to the user-facing surfaces
  // without falling into the legacy /index-react.html.
  // Admin-only links (System Intelligence, Screener, …) stay where
  // they were — we just prepend the journey row.
  const JOURNEY_LINKS = [
    { href: "/today.html",         label: "Today",         match: ["/today"] },
    { href: "/active-trader.html", label: "Active Trader", match: ["/active-trader"] },
    { href: "/investor.html",      label: "Investor",      match: ["/investor"] },
    { href: "/portfolio.html",     label: "Portfolio",     match: ["/portfolio"] },
    { href: "/insights.html",      label: "Insights",      match: ["/insights"] },
    { href: "/learn.html",         label: "Learn",         match: ["/learn"], extraCls: "learn" },
    { href: "/faq.html",           label: "FAQ",           match: ["/faq"],   extraCls: "faq" },
  ];

  function injectJourneyLinks() {
    // Only run on admin pages — journey pages already have these
    // links in their HTML, no need to duplicate.
    //
    // V15 P0.7.185 (2026-05-17) — Cloudflare Pages serves journey
    // pages WITHOUT the .html extension (`/today` not
    // `/today.html`). The earlier strict-match check missed those
    // URLs and ended up injecting the strip ON journey pages too,
    // which created a redundant nav row above the brand. Normalize
    // by stripping the .html suffix before comparing.
    const rawPath = (window.location?.pathname || "").toLowerCase();
    const path = rawPath.replace(/\.html$/, "").replace(/\/$/, "") || "/";
    const JOURNEY_PATHS = new Set([
      "/today",
      "/active-trader",
      "/investor",
      "/portfolio",
      "/insights",
      "/daily-brief",
      "/opportunities",
      "/learn",
      "/faq",
      // 2026-05-29 — B3: admin pages render their own full
      // .nav-links container (journey links + admin items via
      // mission-control-style scaffold). Injecting the strip on
      // top duplicates the row in the user's view ("stacked
      // navigation"). Skip injection for every admin surface
      // here. tt-nav-extras still injects the Admin dropdown +
      // right-side widgets on these pages — only the
      // duplicate-strip injection above the existing nav is
      // suppressed.
      "/analysis",
      "/trades",
      "/system-intelligence",
      "/screener",
      "/tickers",
      "/ticker-management",
      "/trade-autopsy",
      "/admin-clients",
      "/mission-control",
      "/model-dashboard",
      "/model-performance",
      "/move-discovery",
      "/calibration",
      "/debug-dashboard",
      "/brand-kit",
      "/simulation-dashboard",
      "/alerts",
    ]);
    if (JOURNEY_PATHS.has(path)) {
      // If a prior version of this script injected the strip on a
      // journey page (cached old code or stale tab), clean it up so
      // the user sees only the page's native nav.
      document.querySelectorAll(".tt-journey-strip").forEach((el) => el.remove());
      return;
    }

    // Find the first <nav> on the page (admin pages render their nav
    // through React but the rendered DOM has a top-level <nav>).
    const nav = document.querySelector("nav");
    if (!nav) return;
    if (nav.querySelector(".tt-journey-strip")) return; // already injected

    // Skip splash / standalone pages where injecting nav makes no sense.
    if (path === "/" || path === "/splash") return;

    const strip = document.createElement("div");
    strip.className = "tt-journey-strip";
    strip.setAttribute("aria-label", "Primary navigation");

    for (const link of JOURNEY_LINKS) {
      const a = document.createElement("a");
      a.href = link.href;
      a.textContent = link.label;
      a.className = "tt-journey-link" + (link.extraCls ? " tt-journey-link--" + link.extraCls : "");
      const matches = (link.match || []).some((m) => path.startsWith(m));
      if (matches) a.classList.add("active");
      strip.appendChild(a);
    }

    // Insert at the very top of the nav, before any existing children.
    nav.insertBefore(strip, nav.firstChild);
  }

  function getCurrentUser() {
    // V15 P0.7.182 (2026-05-17) — getStoredSession returns the user
    // object directly (the user fields are top-level — email,
    // display_name, role, tier — and cachedAt is added as a sibling).
    // The earlier nav-extras read `session?.user` which is always
    // undefined for valid sessions, so the Avatar + Alerts widgets
    // never received a user prop and silently rendered null.
    const session = window.TimedAuthHelpers?.getStoredSession?.();
    if (!session || typeof session !== "object") return null;
    if (!session.email) return null;
    return session;
  }

  function injectRightWidgets() {
    const navRow = document.querySelector("nav.topnav .nav-row");
    if (!navRow) return;
    let host = navRow.querySelector(".tt-nav-widgets");
    if (!host) {
      host = document.createElement("div");
      host.className = "tt-nav-widgets";
      navRow.appendChild(host);
    }

    const user = getCurrentUser();
    const apiBase = window.TT_API_BASE || "";

    if (typeof React === "undefined" || typeof ReactDOM === "undefined") {
      if (!host.querySelector(".tt-nav-widget-fallback")) {
        const a = document.createElement("a");
        a.href = "https://discord.gg/timedtrading";
        a.target = "_blank";
        a.rel = "noopener";
        a.className = "tt-nav-widget-fallback";
        a.textContent = "Discord";
        host.appendChild(a);
      }
      return;
    }

    // 2026-05-31 — The notification bell streams live model alerts
    // (entries, trims, exits, investor zone enters). On a free /
    // not-yet-trialing account that is identical to giving away the
    // signal feed for free. Gate the alerts slot on Pro/Admin/Trialing
    // — for non-Pro users the bell is suppressed entirely (no mount,
    // no API polling). The user still sees Discord + avatar.
    const isPro =
      window._ttIsPro === true ||
      document.body?.dataset?.isPro === "true" ||
      window._ttIsAdmin === true ||
      document.body?.dataset?.isAdmin === "true";
    const slots = [
      { key: "discord",  Factory: window.TimedWaitlistButton    || window.TimedDiscordButton },
      { key: "alerts",   Factory: window.TimedNotificationCenter, requiresUser: true, requiresPro: true },
      { key: "avatar",   Factory: window.TimedUserBadge,          requiresUser: true },
    ];

    for (const slot of slots) {
      if (typeof slot.Factory !== "function") continue;
      const hasUser = !!user;

      // Find or create the mount node for this slot.
      let mount = host.querySelector(`.tt-nav-widget--${slot.key}`);
      if (!mount) {
        mount = document.createElement("div");
        mount.className = `tt-nav-widget tt-nav-widget--${slot.key}`;
        host.appendChild(mount);
      }

      // Slots that require a user stay empty (but mounted) until auth
      // resolves. When the user finally arrives we render into the
      // same root so the layout doesn't reshuffle.
      if (slot.requiresUser && !hasUser) continue;

      // Pro-gated slot (notification bell): when the user is not Pro,
      // unmount any existing root and skip rendering. Re-evaluated on
      // every tt-auth-bootstrap-updated so a Stripe trial activation
      // upgrades the UI without a hard reload.
      if (slot.requiresPro && !isPro) {
        const existing = _navRoots.get(slot.key);
        if (existing) {
          try { existing.unmount(); } catch (_) {}
          _navRoots.delete(slot.key);
        }
        if (mount) mount.innerHTML = "";
        continue;
      }

      try {
        let root = _navRoots.get(slot.key);
        if (!root && ReactDOM.createRoot) {
          root = ReactDOM.createRoot(mount);
          _navRoots.set(slot.key, root);
        }
        const props =
          slot.key === "avatar"  ? { user, compact: true } :
          slot.key === "alerts"  ? { apiBase } :
          /* discord */            { apiBase };
        const el = React.createElement(slot.Factory, props);
        if (root) {
          root.render(el);
        } else if (ReactDOM.render) {
          ReactDOM.render(el, mount);
        }
      } catch (e) {
        console.warn(`[nav-extras] ${slot.key} mount failed:`, e?.message || e);
      }
    }
  }

  // 2026-05-31 — Brand link smart-routing.
  //
  // The page's top-nav brand logo (<a class="nav-brand" href="/today.html">)
  // is hard-coded to point at the authenticated dashboard. For a user who
  // is signed in but on the paywall (free / past-paywall / not yet trialing),
  // clicking the logo re-loads the paywall — no way back to splash. For a
  // user with a stale session showing the LoginScreen, same problem.
  //
  // This helper rewrites the brand link to /splash.html whenever the user
  // is NOT Pro. Pro users keep the dashboard link. Re-evaluated on every
  // tt-auth-bootstrap-updated so a successful Stripe trial activation
  // restores the dashboard link automatically.
  function wireBrandLink() {
    const brands = document.querySelectorAll("a.nav-brand, .nav-brand[href]");
    if (!brands.length) return;
    const isPro =
      window._ttIsPro === true ||
      document.body?.dataset?.isPro === "true" ||
      window._ttIsAdmin === true ||
      document.body?.dataset?.isAdmin === "true";
    for (const a of brands) {
      // Preserve the original href the first time we see this link so we
      // can restore it if the user upgrades to Pro mid-session.
      if (!a.dataset.ttBrandHrefOriginal) {
        a.dataset.ttBrandHrefOriginal = a.getAttribute("href") || "/today.html";
      }
      const original = a.dataset.ttBrandHrefOriginal;
      a.setAttribute("href", isPro ? original : "/splash.html");
    }
  }

  // ── Init ──────────────────────────────────────────────────────
  async function init() {
    ensureStyles();
    injectAdminMenu();
    injectRightWidgets();
    injectJourneyLinks();
    wireBrandLink();

    refreshBadges();
  }

  // Fetch both nav counts and apply them. Safe to call repeatedly.
  function refreshBadges() {
    Promise.all([fetchOpenTradeCount(), fetchInvestorActionableCount()]).then(([traderN, investorN]) => {
      setBadge("Active Trader", traderN, "up");
      setBadge("Investor", investorN, "up");
      try {
        window.dispatchEvent(new CustomEvent("tt-nav-badges-updated", {
          detail: { trader: traderN, investor: investorN },
        }));
      } catch (_) {}
    });
  }

  window.TTRefreshNavBadges = refreshBadges;
  setInterval(refreshBadges, 60 * 1000);
  window.addEventListener("pageshow", (ev) => {
    if (ev && ev.persisted) refreshBadges();
  });

  // Admin pages render their nav through React, so the <nav> element
  // may not exist when init() first fires. Re-attempt journey-link
  // injection every 200ms for the first 3s in case React was still
  // mounting.
  (function pollForNav() {
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      const nav = document.querySelector("nav");
      if (nav && !nav.querySelector(".tt-journey-strip")) {
        injectJourneyLinks();
      }
      // The nav markup may have only just mounted (shared-nav.js / React
      // admin nav). Re-apply any cached badge so it isn't lost to the race.
      if (nav) reapplyBadges();
      if (tries > 15) clearInterval(id);
    }, 200);
  })();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Re-run when auth-gate finishes (sets _ttIsAdmin via body.dataset).
  // Auth-gate dispatches `tt-auth-bootstrap-updated` with the user
  // profile; admin status is reflected in body.dataset.isAdmin /
  // window._ttIsAdmin shortly after that fires. We re-inject both the
  // admin menu AND the right-side widgets so Avatar + Alerts mount
  // once the user is known (they were always hidden on first load
  // because the session wasn't read yet).
  window.addEventListener("tt-auth-bootstrap-updated", () => {
    injectAdminMenu();
    injectRightWidgets();
    wireBrandLink();
    // Re-apply cached badges (nav may have just mounted) AND re-fetch the
    // counts now that the user/session is known — the actionable Investor
    // count and open-trade count are user-scoped.
    reapplyBadges();
    refreshBadges();
  });

  // Also poll briefly during the first ~3s in case the user is
  // present in localStorage already but the auth event hasn't fired
  // yet (which happens on a hard refresh — the session cache is hot
  // but the React auth gate is still booting).
  (function pollForUser() {
    let tries = 0;
    const id = setInterval(() => {
      tries += 1;
      const u = getCurrentUser();
      if (u || tries > 20) {
        injectRightWidgets();
        if (u || tries > 20) clearInterval(id);
      }
    }, 150);
  })();

  // ── Speculation rules: prerender journey pages on link hover ──────────
  // 2026-06-10 PERF — page switches are full MPA navigations. With
  // `eagerness: "moderate"` Chrome prerenders the target page when the
  // user hovers/touch-starts its nav link, so the actual click swaps in a
  // fully-rendered page (~instant). Safe because:
  //   - moderate = only fires on hover intent, not for every link on load,
  //     so API cost is one speculative page load the user was about to
  //     trigger anyway;
  //   - unsupported browsers ignore the script type entirely;
  //   - admin/marketing pages are excluded — only the 5 core journey
  //     pages users actually flip between.
  (function injectSpeculationRules() {
    try {
      if (!HTMLScriptElement.supports || !HTMLScriptElement.supports("speculationrules")) return;
      if (document.getElementById("tt-speculation-rules")) return;
      const here = window.location.pathname;
      const pages = [
        "/today.html",
        "/active-trader.html",
        "/investor.html",
        "/portfolio.html",
        "/insights.html",
      ].filter((p) => p !== here);
      const el = document.createElement("script");
      el.type = "speculationrules";
      el.id = "tt-speculation-rules";
      el.textContent = JSON.stringify({
        prerender: [{ urls: pages, eagerness: "moderate" }],
      });
      document.head.appendChild(el);
    } catch (_) { /* speculation is purely progressive */ }
  })();
})();

// cache-bust:1783448042015:286974805
