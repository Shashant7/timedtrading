// ═══════════════════════════════════════════════════════════════════════════
// Auth Gate — shared authentication wrapper for all Timed Trading pages.
//
// Usage (in each page's <script type="text/babel">):
//   const AuthGate = window.TimedAuthGate;
//   // Wrap your app root:
//   <AuthGate apiBase={API_BASE}>{(user) => <YourApp user={user} />}</AuthGate>
//
// Behavior:
//   1. Checks localStorage for a cached session (device remembering).
//   2. If no cached session or expired, calls GET /timed/me to verify auth.
//   3. If authenticated, caches user info + access timestamp in localStorage.
//   4. If not authenticated, shows a login screen.
//   5. Backend automatically records email + access time on /timed/me.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  // VAPID public key for Web Push notifications
  window.__TIMED_VAPID_PUBLIC_KEY = "BA9AZ2w5_qm9sSSSwV-pYn1-mBvMd9oFTdA1Rc-LPW-wZDgpXe273vNzENhqHcV-WV-7j1EiRdWU1aUXR_Jb7OA";

  // ── Mobile bottom-nav self-injector ───────────────────────────────────
  // 2026-06-01 (v3) — Operator reported "still missing the mobile tab nav
  // bar" for the third time. Root cause was that tt-bottom-nav.js was only
  // included via <script> tag on 8 of ~20 user-facing pages. The main
  // trades dashboard (index-react.html) plus screener / simulation /
  // mission-control / faq / system-intelligence / etc. all loaded
  // auth-gate.js (this file) but NOT tt-bottom-nav.js, so the mobile nav
  // never rendered there.
  //
  // Bootstrap fix: auth-gate.js is the one script on EVERY user-facing
  // page. So we self-inject tt-bottom-nav.js here. Idempotent: the nav
  // script itself short-circuits if its own DOM nodes already exist, so
  // multiple injections collapse to one.
  //
  // Cache-bust pulled from the auth-gate's own URL so a single deploy
  // bump propagates everywhere without touching each page's script tag.
  (function ensureBottomNav() {
    try {
      // Skip in non-browser contexts (SSR, tests).
      if (typeof document === "undefined" || typeof window === "undefined") return;
      // Skip when an existing tag is already on the page — the page-
      // level include wins (it has the canonical cache-bust).
      const existing = document.querySelector('script[src*="tt-bottom-nav.js"]');
      if (existing) return;
      // Skip when the nav DOM is already present (extremely unlikely but
      // belt-and-suspenders against double-load).
      if (document.getElementById("tt-bottom-nav")) return;
      // We inject on EVERY viewport — the script handles its own
      // @media gating to display:block on mobile only. Injecting on
      // desktop is a no-op (the nav stays display:none) but means the
      // script is already in cache if the user rotates / resizes to
      // mobile width.
      const s = document.createElement("script");
      // Derive cache-bust from this very auth-gate script's URL so a
      // single deploy bump cascades. Falls back to a fixed marker so
      // the script always loads even if the lookup fails.
      let cb = "20260601-ios-urlbar";
      try {
        const me = document.currentScript || document.querySelector('script[src*="auth-gate.js"]');
        const m = me?.src?.match(/[?&]v=([^&]+)/);
        if (m && m[1]) cb = m[1];
      } catch (_) {}
      s.src = `tt-bottom-nav.js?v=${encodeURIComponent(cb)}`;
      s.defer = true;
      s.dataset.injectedBy = "auth-gate-bootstrap";
      (document.head || document.documentElement).appendChild(s);
    } catch (e) {
      // Never block auth on a nav-injection error.
      try { console.warn("[auth-gate] bottom-nav inject failed:", String(e?.message || e).slice(0, 120)); } catch (_) {}
    }
  })();

  // PWA / home-screen / pinned-tab branding — injected on every auth-gated page.
  (function ensurePwaHead() {
    try {
      if (typeof document === "undefined") return;
      const head = document.head || document.documentElement;
      if (!head) return;

      function link(rel, href, extra) {
        if (document.querySelector(`link[rel="${rel}"][href="${href}"]`)) return;
        const el = document.createElement("link");
        el.rel = rel;
        el.href = href;
        if (extra) Object.assign(el, extra);
        head.appendChild(el);
      }

      function meta(name, content) {
        if (document.querySelector(`meta[name="${name}"]`)) return;
        const el = document.createElement("meta");
        el.name = name;
        el.content = content;
        head.appendChild(el);
      }

      link("icon", "/logo.svg", { type: "image/svg+xml" });
      link("apple-touch-icon", "/apple-touch-icon.png", { sizes: "180x180" });
      link("manifest", "/site.webmanifest");
      meta("theme-color", "#000000");
      meta("apple-mobile-web-app-capable", "yes");
      meta("apple-mobile-web-app-title", "Timed Trading");
      meta("mobile-web-app-capable", "yes");
    } catch (e) {
      try { console.warn("[auth-gate] pwa-head inject failed:", String(e?.message || e).slice(0, 120)); } catch (_) {}
    }
  })();

  // Offline app shell — register SW for caching (push flow also registers).
  (function ensureServiceWorker() {
    try {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
    } catch (_) {}
  })();

  // Subtle offline banner when connectivity drops (live prices need network).
  (function ensureOfflineBanner() {
    try {
      if (typeof window === "undefined" || typeof document === "undefined") return;
      let banner = null;
      const show = () => {
        if (banner || navigator.onLine !== false) return;
        banner = document.createElement("div");
        banner.id = "tt-offline-banner";
        banner.textContent = "Offline — cached view only. Live prices refresh when reconnected.";
        banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99998;padding:8px 14px;text-align:center;font:600 11px/1.4 Inter,system-ui,sans-serif;color:#fcd34d;background:rgba(120,53,15,0.92);border-bottom:1px solid rgba(251,191,36,0.35);padding-top:max(8px,env(safe-area-inset-top));";
        document.body.appendChild(banner);
      };
      const hide = () => {
        if (banner) {
          banner.remove();
          banner = null;
        }
      };
      window.addEventListener("offline", show);
      window.addEventListener("online", hide);
      if (!navigator.onLine) show();
    } catch (_) {}
  })();

  // Unified signal grammar — shared chip/lane helpers for activity strip,
  // kanban cards, and notification bell tags.
  (function injectSignalGrammar() {
    try {
      if (typeof document === "undefined") return;
      if (document.querySelector('script[src*="shared-signal-grammar.js"]')) return;
      const s = document.createElement("script");
      s.src = "shared-signal-grammar.js?v=20260623d";
      s.async = true;
      s.dataset.injectedBy = "auth-gate-bootstrap";
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {}
  })();

  const { useState, useEffect, useCallback } = React;

  const STORAGE_KEY = "timed_auth_session";
  const BOOTSTRAP_KEY = "timed_auth_bootstrap";
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  function scheduleIdleWork(fn, timeout = 1200) {
    if (typeof fn !== "function") return () => {};
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(() => fn(), { timeout });
      return () => {
        try {
          window.cancelIdleCallback(id);
        } catch (_) {}
      };
    }
    const id = window.setTimeout(fn, Math.min(timeout, 400));
    return () => window.clearTimeout(id);
  }

  function getStoredSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const session = JSON.parse(raw);
      if (!session || !session.email || !session.cachedAt) return null;
      // Check TTL
      if (Date.now() - session.cachedAt > SESSION_TTL_MS) {
        localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return session;
    } catch {
      return null;
    }
  }

  function storeSession(user) {
    try {
      const session = {
        ...user,
        cachedAt: Date.now(),
        lastAccess: new Date().toISOString(),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
      return session;
    } catch {
      return user;
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  function getStoredBootstrap() {
    try {
      const raw = localStorage.getItem(BOOTSTRAP_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.cachedAt) return null;
      if (Date.now() - data.cachedAt > SESSION_TTL_MS) {
        localStorage.removeItem(BOOTSTRAP_KEY);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  function storeBootstrap(data) {
    try {
      const bootstrap = {
        saved_tickers: Array.isArray(data?.saved_tickers) ? data.saved_tickers : [],
        member_tickers: Array.isArray(data?.member_tickers) ? data.member_tickers : [],
        unread_trade_alert_count: Number(data?.unread_trade_alert_count) || 0,
        cachedAt: Date.now(),
      };
      localStorage.setItem(BOOTSTRAP_KEY, JSON.stringify(bootstrap));
      return bootstrap;
    } catch {
      return null;
    }
  }

  function clearBootstrap() {
    try {
      localStorage.removeItem(BOOTSTRAP_KEY);
    } catch {
      // ignore
    }
  }

  // ── Login Screen ─────────────────────────────────────────────────────────
  function LoginScreen({ onRetry, error, loading }) {
    // Detect logout redirect (via sessionStorage flag set by handleLogout)
    const [showLogoutMsg, setShowLogoutMsg] = React.useState(() => {
      try {
        const flag = sessionStorage.getItem("tt_logout");
        if (flag) { sessionStorage.removeItem("tt_logout"); return true; }
        return new URLSearchParams(window.location.search).has("logout");
      } catch { return false; }
    });
    React.useEffect(() => {
      if (showLogoutMsg) {
        const t = setTimeout(() => setShowLogoutMsg(false), 5000);
        // Clean URL if ?logout param present
        try { window.history.replaceState(null, "", window.location.pathname + window.location.hash); } catch {}
        return () => clearTimeout(t);
      }
    }, [showLogoutMsg]);

    const h = React.createElement;
    const font = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    // Keyframes for subtle glow animation
    const styleTag = h("style", null, `
      @keyframes tt-glow { 0%,100%{box-shadow:0 0 40px rgba(0,200,83,0.15),0 0 80px rgba(0,200,83,0.05)} 50%{box-shadow:0 0 60px rgba(0,200,83,0.25),0 0 120px rgba(0,200,83,0.08)} }
      @keyframes tt-fade-in { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      @keyframes spin { to{transform:rotate(360deg)} }
      @keyframes tt-pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
    `);

    // Google icon SVG
    const googleIcon = h("svg", { width: "18", height: "18", viewBox: "0 0 24 24" },
      h("path", { d: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z", fill: "#4285F4" }),
      h("path", { d: "M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z", fill: "#34A853" }),
      h("path", { d: "M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z", fill: "#FBBC05" }),
      h("path", { d: "M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z", fill: "#EA4335" }),
    );

    const logoIcon = h("svg", { width: "48", height: "48", viewBox: "0 0 48 48", fill: "none" },
      h("defs", null,
        h("linearGradient", { id: "tt-auth-ring", x1: "6", y1: "42", x2: "42", y2: "6" },
          h("stop", { offset: "0%", stopColor: "#34d399" }),
          h("stop", { offset: "100%", stopColor: "#67e8f9" }),
        ),
        h("radialGradient", { id: "tt-auth-glow", cx: "24", cy: "24", r: "6" },
          h("stop", { offset: "0%", stopColor: "#34d399", stopOpacity: "0.18" }),
          h("stop", { offset: "100%", stopColor: "#34d399", stopOpacity: "0" }),
        ),
      ),
      h("rect", { width: "48", height: "48", rx: "11", fill: "#000" }),
      h("circle", { cx: "24", cy: "24", r: "17", stroke: "url(#tt-auth-ring)", strokeWidth: "2", fill: "none" }),
      h("circle", { cx: "24", cy: "24", r: "8", fill: "url(#tt-auth-glow)" }),
      h("line", { x1: "24", y1: "7.5", x2: "24", y2: "10.5", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.6" }),
      h("line", { x1: "40.5", y1: "24", x2: "37.5", y2: "24", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.4" }),
      h("line", { x1: "24", y1: "40.5", x2: "24", y2: "37.5", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.4" }),
      h("line", { x1: "7.5", y1: "24", x2: "10.5", y2: "24", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.6" }),
      h("text", { x: "24", y: "36.5", textAnchor: "middle", fontFamily: "Inter, -apple-system, sans-serif", fontSize: "5.5", fontWeight: "700", fill: "#34d399", opacity: "0.22", letterSpacing: "0.8" }, "TT"),
      h("line", { x1: "18.5", y1: "18", x2: "15.5", y2: "15", stroke: "#636366", strokeWidth: "1", strokeLinecap: "round" }),
      h("line", { x1: "24", y1: "24", x2: "18.5", y2: "18", stroke: "#636366", strokeWidth: "3.2", strokeLinecap: "round" }),
      h("line", { x1: "29.5", y1: "16", x2: "32", y2: "12.4", stroke: "#30d158", strokeWidth: "1", strokeLinecap: "round" }),
      h("line", { x1: "24", y1: "24", x2: "29.5", y2: "16", stroke: "#30d158", strokeWidth: "3.5", strokeLinecap: "round" }),
      h("circle", { cx: "24", cy: "24", r: "2.8", fill: "#30d158" }),
      h("circle", { cx: "24", cy: "24", r: "1.1", fill: "#000" }),
    );

    return h("div", { style: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at 50% 0%, #111820 0%, #0b0e11 60%)", fontFamily: font, position: "relative", overflow: "hidden" } },
      styleTag,
      // Subtle background grid
      h("div", { style: { position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.015) 1px, transparent 0)", backgroundSize: "40px 40px", pointerEvents: "none" } }),

      // Main card
      h("div", { style: { position: "relative", zIndex: 1, width: "100%", maxWidth: "420px", padding: "24px", animation: "tt-fade-in 0.5s ease-out" } },

        // Logout confirmation banner
        showLogoutMsg && h("div", { style: { marginBottom: "16px", padding: "12px 16px", borderRadius: "12px", background: "rgba(0,200,83,0.08)", border: "1px solid rgba(0,200,83,0.2)", textAlign: "center", fontSize: "13px", color: "#4ade80", animation: "tt-fade-in 0.3s ease-out" } },
          "You have been signed out successfully."
        ),

        // Logo + branding
        h("div", { style: { textAlign: "center", marginBottom: "32px" } },
          h("div", { style: { width: "72px", height: "72px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px", animation: "tt-glow 4s ease-in-out infinite" } }, logoIcon),
          h("h1", { style: { fontSize: "28px", fontWeight: "700", color: "#f0f2f5", margin: "0 0 8px", letterSpacing: "-0.03em" } }, "Timed Trading"),
          h("p", { style: { fontSize: "14px", color: "#6b7280", margin: "0", lineHeight: "1.5" } }, "Active trading and investing intelligence"),
        ),

        // Card
        h("div", { style: { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "32px", backdropFilter: "blur(12px)" } },
          // Error
          error && h("div", { style: { background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: "10px", padding: "12px 16px", marginBottom: "20px", fontSize: "13px", color: "#f87171", lineHeight: "1.4" } }, error),

          // Google SSO button
          h("button", {
            onClick: onRetry, disabled: loading,
            style: { width: "100%", padding: "14px 20px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.1)", background: loading ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)", color: loading ? "#6b7280" : "#e5e7eb", fontSize: "14px", fontWeight: "600", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", transition: "all 0.2s", fontFamily: "inherit", letterSpacing: "-0.01em" },
            onMouseEnter: (e) => { if (!loading) { e.currentTarget.style.background = "rgba(255,255,255,0.07)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)"; e.currentTarget.style.transform = "translateY(-1px)"; } },
            onMouseLeave: (e) => { e.currentTarget.style.background = loading ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.04)"; e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; e.currentTarget.style.transform = "none"; },
          },
            loading
              ? h("span", { style: { display: "flex", alignItems: "center", gap: "8px" } },
                  h("span", { style: { width: "16px", height: "16px", border: "2px solid rgba(255,255,255,0.1)", borderTopColor: "#00c853", borderRadius: "50%", animation: "spin 0.8s linear infinite" } }),
                  "Authenticating...")
              : h(React.Fragment, null, googleIcon, "Continue with Google"),
          ),

          // Session note
          h("p", { style: { fontSize: "11px", color: "#374151", margin: "20px 0 0", lineHeight: "1.5", textAlign: "center" } },
            "Your session will be remembered on this device for 7 days."
          ),
        ),

        // Footer
        h("div", { style: { textAlign: "center", marginTop: "24px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" } },
          h("svg", { width: "14", height: "14", viewBox: "0 0 24 24", fill: "none", stroke: "#374151", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
            h("rect", { x: "3", y: "11", width: "18", height: "11", rx: "2", ry: "2" }),
            h("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }),
          ),
          h("span", { style: { fontSize: "11px", color: "#374151" } }, "Secured by Cloudflare Access"),
        ),
      ),
    );
  }

  // ── Access Denied Screen ──────────────────────────────────────────────────
  function AccessDeniedScreen({ user, requiredTier }) {
    const tierLabels = { free: "Member", pro: "Pro", vip: "VIP", admin: "Admin" };
    return React.createElement(
      "div",
      {
        style: {
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0b0e11",
          fontFamily:
            '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      },
      React.createElement(
        "div",
        {
          style: {
            width: "100%",
            maxWidth: "420px",
            padding: "40px",
            textAlign: "center",
          },
        },
        // Lock icon
        React.createElement(
          "div",
          {
            style: {
              width: "64px",
              height: "64px",
              borderRadius: "16px",
              background: "rgba(255, 82, 82, 0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              margin: "0 auto 20px",
            },
          },
          React.createElement(
            "svg",
            {
              width: "28",
              height: "28",
              viewBox: "0 0 24 24",
              fill: "none",
              stroke: "#ff5252",
              strokeWidth: "2",
              strokeLinecap: "round",
              strokeLinejoin: "round",
            },
            React.createElement("rect", {
              x: "3",
              y: "11",
              width: "18",
              height: "11",
              rx: "2",
              ry: "2",
            }),
            React.createElement("path", {
              d: "M7 11V7a5 5 0 0 1 10 0v4",
            }),
          ),
        ),
        React.createElement(
          "h1",
          {
            style: {
              fontSize: "20px",
              fontWeight: "700",
              color: "#e5e7eb",
              margin: "0 0 8px",
            },
          },
          "Access Restricted",
        ),
        React.createElement(
          "p",
          {
            style: {
              fontSize: "14px",
              color: "#6b7280",
              margin: "0 0 24px",
              lineHeight: "1.5",
            },
          },
          "This page requires ",
          React.createElement(
            "span",
            { style: { color: "#a78bfa", fontWeight: "600" } },
            tierLabels[requiredTier] || requiredTier,
          ),
          " access. Your current tier is ",
          React.createElement(
            "span",
            { style: { color: "#9ca3af", fontWeight: "600" } },
            tierLabels[user?.tier] || user?.tier || "free",
          ),
          ".",
        ),
        React.createElement(
          "div",
          {
            style: {
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "12px",
              padding: "16px",
              marginBottom: "20px",
            },
          },
          React.createElement(
            "p",
            {
              style: {
                fontSize: "13px",
                color: "#6b7280",
                margin: "0 0 4px",
              },
            },
            "Signed in as",
          ),
          React.createElement(
            "p",
            {
              style: {
                fontSize: "14px",
                color: "#e5e7eb",
                fontWeight: "500",
                margin: "0",
              },
            },
            user?.email || "Unknown",
          ),
        ),
        React.createElement(
          "a",
          {
            href: "/today.html",
            style: {
              display: "inline-block",
              padding: "10px 24px",
              borderRadius: "10px",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.1)",
              color: "#e5e7eb",
              fontSize: "13px",
              fontWeight: "500",
              textDecoration: "none",
              transition: "all 0.15s",
            },
          },
          "Open Today",
        ),
      ),
    );
  }

  // ── Paywall Screen ────────────────────────────────────────────────────────
  // Shown when user.tier === "free" and no active subscription.
  function PaywallScreen({ user, apiBase }) {
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    const h = React.createElement;
    const font = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    const handleStartTrial = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/timed/stripe/create-checkout`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            success_url: window.location.origin + "/today.html?stripe=success",
            cancel_url: window.location.origin + "/today.html?stripe=cancel",
          }),
        });
        const json = await res.json();
        if (json.ok && json.url) {
          window.location.href = json.url;
        } else {
          setError(json.error === "stripe_not_configured"
            ? "Payments are not yet configured. Please contact support."
            : (json.details || json.error || "Failed to create checkout session"));
          setLoading(false);
        }
      } catch (e) {
        setError("Network error. Please try again.");
        setLoading(false);
      }
    };

    const features = [
      "Active Trader + Investor modes (full platform)",
      "Real-time multi-timeframe scoring across 200+ tickers",
      "Kanban pipeline with automated trade signals",
      "AI-powered daily market briefs (pre-market + evening)",
      "Precise SL + multi-tier TP on every setup",
      "Full historical trail & time travel replay",
      "Browser push & in-app notifications",
    ];

    return h("div", {
      style: {
        // 2026-05-31 — Mobile bottom nav was being captured into the
        // paywall card's containing block on iOS because the wrapping
        // div used overflow: hidden + min-height which can create a
        // local positioning context with some Safari builds. Bumped
        // padding-bottom so the paywall card never overlaps the
        // bottom-nav strip on mobile.
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#0b0e11", fontFamily: font,
        padding: "24px 12px max(96px, env(safe-area-inset-bottom)) 12px",
      },
    },
      h("div", {
        style: {
          width: "100%", maxWidth: "520px", padding: "36px 28px 28px", textAlign: "center",
          background: "linear-gradient(180deg, rgba(0,200,83,0.04) 0%, rgba(255,255,255,0.025) 60%)",
          border: "1px solid rgba(0,200,83,0.22)", borderRadius: "20px",
          boxShadow: "0 0 40px rgba(0,200,83,0.04)", position: "relative", overflow: "hidden",
        },
      },
        h("div", { style: { position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: "linear-gradient(90deg, #34d399, #67e8f9)" } }),
        h("h1", { style: { fontSize: "22px", fontWeight: "800", color: "#e5e7eb", margin: "0 0 4px", letterSpacing: "-0.02em" } },
          "Timed Trading Pro"),
        h("p", { style: { fontSize: "13px", color: "#9ca3af", margin: "0 0 18px", lineHeight: "1.5" } },
          "Full platform access. Active Trader + Investor modes."),
        h("div", {
          style: { display: "flex", alignItems: "baseline", justifyContent: "center", marginBottom: "8px" },
        },
          h("span", { style: { fontSize: "48px", fontWeight: "900", color: "#fff", letterSpacing: "-0.03em", lineHeight: "1" } },
            "$60", h("span", { style: { fontSize: "16px", color: "#9ca3af", fontWeight: "400" } }, "/month")),
        ),
        h("p", { style: { fontSize: "12px", color: "#6b7280", margin: "0 0 24px", lineHeight: "1.6" } },
          "14-day free trial \u00b7 Cancel anytime"),
        h("div", { style: { textAlign: "left", marginBottom: "20px" } },
          h("div", {
            style: { fontSize: "10.5px", fontWeight: "700", letterSpacing: "0.10em", color: "#6b7280",
              textTransform: "uppercase", marginBottom: "10px", paddingTop: "16px",
              borderTop: "1px solid rgba(255,255,255,0.06)" },
          }, "What every member gets"),
          ...features.map((f) =>
            h("div", { key: f, style: { display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "8px" } },
              h("span", { style: { color: "#00c853", fontSize: "13px", lineHeight: "20px", flexShrink: 0, fontWeight: 700 } }, "\u2713"),
              h("span", { style: { fontSize: "12.5px", color: "#9ca3af", lineHeight: "1.5" } }, f),
            ),
          ),
        ),
        h("button", {
          onClick: handleStartTrial,
          disabled: loading,
          style: {
            width: "100%", padding: "14px 24px", borderRadius: "10px", fontSize: "15px", fontWeight: "700",
            color: "#fff", background: loading ? "#374151" : "linear-gradient(135deg, #00c853, #00a844)",
            border: "none", cursor: loading ? "wait" : "pointer", transition: "all 0.15s",
          },
        }, loading ? "Redirecting to Stripe..." : "Start 14-day free trial"),
        error && h("p", { style: { color: "#ff5252", fontSize: "13px", marginTop: "12px" } }, error),
        h("a", {
          href: "/learn.html",
          style: {
            display: "inline-flex", alignItems: "center", gap: "6px", marginTop: "14px",
            fontSize: "13px", color: "#67e8f9", textDecoration: "none", fontWeight: "600",
          },
        },
          "Not sure how it works? Read the 10-minute guide \u2192",
        ),
        h("p", { style: { fontSize: "12px", color: "#374151", marginTop: "16px" } },
          "Signed in as ", h("span", { style: { color: "#6b7280" } }, user?.email || "Unknown")),
        // 2026-05-31 — Three navigation escape hatches for a paywalled
        // user:
        //   • Back to home → splash (public marketing)
        //   • Switch account → /logout.html (clears CF + Google session,
        //     forces account picker on next sign-in)
        //   • Sign out → /logout.html (same flow, neutral label)
        // Without these, a free user who chose the wrong Google account
        // had no way out except clearing cookies manually.
        h("div", {
          style: {
            display: "flex", flexWrap: "wrap", justifyContent: "center",
            gap: "14px", marginTop: "10px",
          },
        },
          h("a", {
            href: "/splash.html",
            style: { fontSize: "12px", color: "#4b5563", textDecoration: "underline" },
          }, "Back to home"),
          h("a", {
            href: "/logout.html?switch=1",
            style: { fontSize: "12px", color: "#67e8f9", textDecoration: "underline", fontWeight: 600 },
          }, "Sign in with a different account"),
        ),
      ),
    );
  }

  // ── Terms Gate Screen ────────────────────────────────────────────────────
  // Shown after authentication, before dashboard access.
  // User must accept Terms of Use to continue.
  function TermsGateScreen({ user, apiBase, onAccepted }) {
    const [agreed, setAgreed] = React.useState(false);
    const [submitting, setSubmitting] = React.useState(false);
    const [error, setError] = React.useState(null);
    const h = React.createElement;
    const font = '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

    const handleAccept = async () => {
      if (!agreed || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch(`${apiBase}/timed/accept-terms`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (json.ok && json.terms_accepted_at) {
          onAccepted(json.terms_accepted_at);
        } else {
          setError(json.error || "Failed to record acceptance. Please try again.");
          setSubmitting(false);
        }
      } catch (e) {
        setError("Network error. Please check your connection and try again.");
        setSubmitting(false);
      }
    };

    const handleSignOut = async () => {
      clearSession();
      window.location.href = "/logout.html";
    };

    const logoIcon = h("svg", { width: "48", height: "48", viewBox: "0 0 48 48", fill: "none" },
      h("defs", null,
        h("linearGradient", { id: "tt-tou-ring", x1: "6", y1: "42", x2: "42", y2: "6" },
          h("stop", { offset: "0%", stopColor: "#34d399" }),
          h("stop", { offset: "100%", stopColor: "#67e8f9" }),
        ),
        h("radialGradient", { id: "tt-tou-glow", cx: "24", cy: "24", r: "6" },
          h("stop", { offset: "0%", stopColor: "#34d399", stopOpacity: "0.18" }),
          h("stop", { offset: "100%", stopColor: "#34d399", stopOpacity: "0" }),
        ),
      ),
      h("rect", { width: "48", height: "48", rx: "11", fill: "#000" }),
      h("circle", { cx: "24", cy: "24", r: "17", stroke: "url(#tt-tou-ring)", strokeWidth: "2", fill: "none" }),
      h("circle", { cx: "24", cy: "24", r: "8", fill: "url(#tt-tou-glow)" }),
      h("line", { x1: "24", y1: "7.5", x2: "24", y2: "10.5", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.6" }),
      h("line", { x1: "40.5", y1: "24", x2: "37.5", y2: "24", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.4" }),
      h("line", { x1: "24", y1: "40.5", x2: "24", y2: "37.5", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.4" }),
      h("line", { x1: "7.5", y1: "24", x2: "10.5", y2: "24", stroke: "#34d399", strokeWidth: "1.2", strokeLinecap: "round", opacity: "0.6" }),
      h("text", { x: "24", y: "36.5", textAnchor: "middle", fontFamily: "Inter, -apple-system, sans-serif", fontSize: "5.5", fontWeight: "700", fill: "#34d399", opacity: "0.22", letterSpacing: "0.8" }, "TT"),
      h("line", { x1: "18.5", y1: "18", x2: "15.5", y2: "15", stroke: "#636366", strokeWidth: "1", strokeLinecap: "round" }),
      h("line", { x1: "24", y1: "24", x2: "18.5", y2: "18", stroke: "#636366", strokeWidth: "3.2", strokeLinecap: "round" }),
      h("line", { x1: "29.5", y1: "16", x2: "32", y2: "12.4", stroke: "#30d158", strokeWidth: "1", strokeLinecap: "round" }),
      h("line", { x1: "24", y1: "24", x2: "29.5", y2: "16", stroke: "#30d158", strokeWidth: "3.5", strokeLinecap: "round" }),
      h("circle", { cx: "24", cy: "24", r: "2.8", fill: "#30d158" }),
      h("circle", { cx: "24", cy: "24", r: "1.1", fill: "#000" }),
    );

    return h("div", { style: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at 50% 0%, #111820 0%, #0b0e11 60%)", fontFamily: font, position: "relative", overflow: "hidden", padding: "24px" } },
      h("style", null, `
        @keyframes tt-glow { 0%,100%{box-shadow:0 0 40px rgba(0,200,83,0.15),0 0 80px rgba(0,200,83,0.05)} 50%{box-shadow:0 0 60px rgba(0,200,83,0.25),0 0 120px rgba(0,200,83,0.08)} }
        @keyframes tt-fade-in { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes spin { to{transform:rotate(360deg)} }
      `),
      // Background grid
      h("div", { style: { position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.015) 1px, transparent 0)", backgroundSize: "40px 40px", pointerEvents: "none" } }),

      h("div", { style: { position: "relative", zIndex: 1, width: "100%", maxWidth: "520px", animation: "tt-fade-in 0.5s ease-out" } },
        // Logo
        h("div", { style: { textAlign: "center", marginBottom: "24px" } },
          h("div", { style: { width: "64px", height: "64px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", animation: "tt-glow 4s ease-in-out infinite" } }, logoIcon),
          h("h1", { style: { fontSize: "24px", fontWeight: "700", color: "#f0f2f5", margin: "0 0 4px", letterSpacing: "-0.03em" } }, "Terms of Use Agreement"),
          h("p", { style: { fontSize: "13px", color: "#6b7280", margin: 0 } }, "Signed in as ", h("span", { style: { color: "#9ca3af", fontWeight: "500" } }, user?.email || "Unknown")),
        ),

        // Card
        h("div", { style: { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "20px", padding: "28px", backdropFilter: "blur(12px)" } },
          h("p", { style: { fontSize: "14px", color: "#9ca3af", lineHeight: "1.6", margin: "0 0 20px" } },
            "Before accessing the Timed Trading platform, you must review and accept our Terms of Use. By accepting, you acknowledge that this platform is for ",
            h("strong", { style: { color: "#e5e7eb" } }, "entertainment and educational purposes only"),
            " and does not constitute financial advice.",
          ),

          // Key points box
          h("div", { style: { background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "12px", padding: "20px", marginBottom: "20px", maxHeight: "220px", overflowY: "auto" } },
            h("p", { style: { fontSize: "12px", color: "#6b7280", margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: "600" } }, "Key Terms Summary"),
            ...[
              "Timed Trading is NOT a registered investment advisor, broker-dealer, or financial institution.",
              "All scores, signals, and analytics are for entertainment and educational purposes only.",
              "You are solely responsible for your own investment decisions and any resulting gains or losses.",
              "Past performance does not guarantee or predict future results.",
              "All investments carry substantial risk of loss, including loss of principal.",
              "You must consult a qualified financial professional before making investment decisions.",
              "The service is provided \"as is\" without warranties of any kind.",
            ].map((text, i) => h("div", { key: i, style: { display: "flex", gap: "8px", marginBottom: "10px", alignItems: "flex-start" } },
              h("span", { style: { color: "#00c853", fontSize: "14px", lineHeight: "1.4", flexShrink: 0 } }, "\u2022"),
              h("p", { style: { fontSize: "13px", color: "#9ca3af", margin: 0, lineHeight: "1.5" } }, text),
            )),
          ),

          // Link to full terms
          h("div", { style: { textAlign: "center", marginBottom: "20px" } },
            h("a", {
              href: "/terms.html",
              target: "_blank",
              rel: "noopener noreferrer",
              style: { fontSize: "13px", color: "#00c853", textDecoration: "none", fontWeight: "500", borderBottom: "1px solid rgba(0,200,83,0.3)" },
            }, "Read the full Terms of Use \u2192"),
          ),

          // Error
          error && h("div", { style: { background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: "10px", padding: "12px 16px", marginBottom: "16px", fontSize: "13px", color: "#f87171", lineHeight: "1.4" } }, error),

          // Checkbox
          h("label", {
            style: { display: "flex", alignItems: "flex-start", gap: "12px", cursor: "pointer", padding: "12px 16px", borderRadius: "12px", border: agreed ? "1px solid rgba(0,200,83,0.2)" : "1px solid rgba(255,255,255,0.06)", background: agreed ? "rgba(0,200,83,0.04)" : "transparent", transition: "all 0.2s", marginBottom: "20px" },
          },
            h("input", {
              type: "checkbox",
              checked: agreed,
              onChange: (e) => setAgreed(e.target.checked),
              style: { marginTop: "2px", width: "18px", height: "18px", accentColor: "#00c853", cursor: "pointer", flexShrink: 0 },
            }),
            h("span", { style: { fontSize: "13px", color: agreed ? "#e5e7eb" : "#9ca3af", lineHeight: "1.5", transition: "color 0.2s" } },
              "I have read and agree to the ",
              h("a", { href: "/terms.html", target: "_blank", rel: "noopener noreferrer", style: { color: "#00c853", textDecoration: "underline" } }, "Terms of Use"),
              " and Disclaimer. I understand that Timed Trading is for entertainment and educational purposes only and does not provide financial advice.",
            ),
          ),

          // Buttons
          h("div", { style: { display: "flex", gap: "12px" } },
            h("button", {
              onClick: handleAccept,
              disabled: !agreed || submitting,
              style: {
                flex: 1, padding: "14px 20px", borderRadius: "12px", border: "none",
                background: agreed && !submitting ? "linear-gradient(135deg, #00c853, #00e676)" : "rgba(255,255,255,0.04)",
                color: agreed && !submitting ? "#0b0e11" : "#6b7280",
                fontSize: "14px", fontWeight: "700", cursor: agreed && !submitting ? "pointer" : "not-allowed",
                transition: "all 0.2s", fontFamily: "inherit", letterSpacing: "-0.01em",
              },
            },
              submitting
                ? h("span", { style: { display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" } },
                    h("span", { style: { width: "16px", height: "16px", border: "2px solid rgba(11,14,17,0.3)", borderTopColor: "#0b0e11", borderRadius: "50%", animation: "spin 0.8s linear infinite" } }),
                    "Recording...")
                : "Accept & Continue",
            ),
            h("button", {
              onClick: handleSignOut,
              style: { padding: "14px 20px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.06)", background: "transparent", color: "#9ca3af", fontSize: "13px", fontWeight: "500", cursor: "pointer", transition: "all 0.2s", fontFamily: "inherit", whiteSpace: "nowrap" },
              onMouseEnter: (e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.12)"; e.currentTarget.style.color = "#e5e7eb"; },
              onMouseLeave: (e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.06)"; e.currentTarget.style.color = "#9ca3af"; },
            }, "Sign Out"),
          ),
        ),

        // Footer
        h("div", { style: { textAlign: "center", marginTop: "20px" } },
          h("p", { style: { fontSize: "11px", color: "#374151" } }, "\u00a9 2026 Timed Trading. All rights reserved."),
        ),
      ),
    );
  }

  // ── Auth Gate Component ──────────────────────────────────────────────────
  // Props:
  //   apiBase     - API base URL
  //   requiredTier - optional: "admin", "pro", "free". If set, blocks users below this tier.
  //   children    - render prop: (user) => ReactElement
  function AuthGate({ apiBase, requiredTier, children }) {
    const [state, setState] = useState("checking"); // checking | authenticated | unauthenticated | blocked
    const [user, setUser] = useState(null);
    const [error, setError] = useState(null);
    const [serverVerified, setServerVerified] = useState(false); // true only after /timed/me confirms auth
    const [stripeActivating, setStripeActivating] = useState(false); // true when waiting for Stripe webhook
    const [memberTickers, setMemberTickers] = useState(null); // freemium gate ticker list from /timed/me

    const TIER_ORDER = { free: 0, pro: 1, vip: 1, admin: 2 };

    const verifyAuth = useCallback(
      async (showError) => {
        setState("checking");
        setError(null);
        try {
          const res = await fetch(`${apiBase}/timed/me`, {
            credentials: "include",
            cache: "no-store",
          });
          if (res.ok) {
            const json = await res.json();
            // 2026-05-31 — Hard-blocked accounts surface as a dedicated
            // state. Without this, the auth-gate fell through to the
            // unauthenticated branch, showed the LoginScreen, the user
            // clicked Sign In, CF Access re-attached the same JWT, and
            // /timed/me returned blocked again → infinite loop.
            if (json.ok && json.authenticated && json.blocked) {
              clearSession();
              clearBootstrap();
              setUser(json.user || null);
              setServerVerified(true);
              setState("blocked");
              return;
            }
            if (json.ok && json.authenticated && json.user) {
              if (json.user.auth_d1_unavailable) {
                const cached = getStoredSession();
                if (cached) {
                  setUser(cached);
                  setState("authenticated");
                  setServerVerified(false);
                  return;
                }
              }
              const session = storeSession(json.user);
              const bootstrap = storeBootstrap({
                saved_tickers: json.saved_tickers,
                member_tickers: json.member_tickers,
                unread_trade_alert_count: json.unread_trade_alert_count,
              });
              setUser(session);
              setState("authenticated");
              setServerVerified(true);
              if (Array.isArray(json.member_tickers)) setMemberTickers(json.member_tickers);
              try {
                window.dispatchEvent(new CustomEvent("tt-auth-bootstrap-updated", {
                  detail: bootstrap || {
                    saved_tickers: Array.isArray(json.saved_tickers) ? json.saved_tickers : [],
                    member_tickers: Array.isArray(json.member_tickers) ? json.member_tickers : [],
                    unread_trade_alert_count: Number(json.unread_trade_alert_count) || 0,
                  },
                }));
              } catch (_) {}
              return;
            }
          }
          /* 2026-06-02 — Not authenticated. CRITICAL: must clear the
             React `user` state in addition to localStorage. Operator
             bug report: "When the access token expires, I see the
             sign in screen but then I see the switch user screen
             and then the signed out screen and then finally signed
             in." Root cause: when verifyAuth() ran in the background
             and got 401, it cleared localStorage via clearSession()
             but the React user state still held the cached user
             object. So handleLogin() saw `!!user = true` and routed
             through CASE A (switch-account flow) instead of CASE B
             (fresh SSO) — sending the user through the entire
             logout-clear-cookies-show-switch-card detour before
             finally re-signing them in. Setting user=null here
             makes handleLogin see we're truly logged out and route
             straight to fresh SSO. */
          clearSession();
          clearBootstrap();
          setUser(null);
          setServerVerified(false);
          if (showError) {
            setError(
              "Authentication required. Click below to sign in.",
            );
          }
          setState("unauthenticated");
        } catch (e) {
          // Cross-origin CORS error or network failure.
          // This is EXPECTED when CF Access blocks an unauthenticated cross-origin
          // fetch (Pages → Worker). The user simply needs to login.
          const cached = getStoredSession();
          if (cached) {
            setUser(cached);
            setState("authenticated");
          } else {
            // Same fix as above — clear React user state too.
            clearBootstrap();
            setUser(null);
            setServerVerified(false);
            if (showError) {
              setError("Unable to connect. Please check your network and retry.");
            }
            setState("unauthenticated");
          }
        }
      },
      [apiBase],
    );

    useEffect(() => {
      // Clean up ?_auth= cache-buster from login redirect (keep URL tidy)
      try {
        const u = new URL(window.location.href);
        if (u.searchParams.has("_auth")) {
          u.searchParams.delete("_auth");
          window.history.replaceState(null, "", u.pathname + u.search + u.hash);
        }
      } catch (_) {}

      // First check localStorage cache
      const cached = getStoredSession();
      if (cached) {
        setUser(cached);
        setState("authenticated");
        // Background refresh to update last_login_at on backend + sync tier,
        // but defer it so the first page paint is not blocked on auth extras.
        const cancel = scheduleIdleWork(() => {
          verifyAuth(false).catch(() => {});
        }, 1600);
        return cancel;
      } else {
        verifyAuth(false);
      }
    }, [verifyAuth]);

    // Stripe success redirect: poll /timed/me until tier updates from webhook
    useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("stripe") || params.get("stripe") !== "success") return;
      if (!user || (user.tier !== "free" && user.tier)) return; // Already upgraded

      setStripeActivating(true);
      let cancelled = false;
      let attempts = 0;
      const maxAttempts = 20; // 20 * 2s = 40s max wait

      const poll = async () => {
        while (!cancelled && attempts < maxAttempts) {
          attempts++;
          await new Promise(r => setTimeout(r, 2000));
          if (cancelled) return;
          try {
            const res = await fetch(`${apiBase}/timed/me`, { credentials: "include", cache: "no-store" });
            if (res.ok) {
              const json = await res.json();
              if (json.ok && json.authenticated && json.user) {
                const u = json.user;
                if (u.tier === "pro" || u.tier === "vip" || u.tier === "admin" ||
                    u.subscription_status === "trialing" || u.subscription_status === "active") {
                  const session = storeSession(u);
                  setUser(session);
                  setStripeActivating(false);
                  const cleanUrl = new URL(window.location.href);
                  cleanUrl.searchParams.delete("stripe");
                  window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search);
                  return;
                }
              }
            }
          } catch { /* retry */ }
        }
        if (cancelled) return;
        // Webhook still hasn't arrived — force a full page reload so the user
        // doesn't stay stuck on the spinner forever.
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete("stripe");
        cleanUrl.searchParams.set("_ts", Date.now());
        window.location.replace(cleanUrl.href);
      };
      poll();
      return () => { cancelled = true; };
    }, [user, apiBase, verifyAuth]);

    // After SSO, reopen any shared-link rail target (ticker + tab).
    useEffect(() => {
      if (state !== "authenticated") return;
      const cancel = scheduleIdleWork(() => {
        try { window.ttApplyPendingRailDeepLink?.(); } catch (_) {}
      }, 600);
      return cancel;
    }, [state]);

    const [signingIn, setSigningIn] = useState(false);
    const handleLogin = useCallback(() => {
      /* 2026-06-01 — Reworked to use the same proven top-level
         /cdn-cgi/access/logout flow as logout.html.

         CASE A (already authenticated — wants to switch account):
           Route through /logout.html?switch=1 which top-level
           navigates to CF Access logout, then renders the manual
           Google-sign-out card.

         CASE B (NOT authenticated — fresh login):
           Straight to the protected URL, let CF Access drive SSO.

         2026-06-02 — Bug fix: must require BOTH `user` set AND
         `serverVerified=true` to consider this a switch-account
         scenario. Without the serverVerified gate, a stale
         localStorage cache after token expiry would mis-route
         through CASE A — sending the operator through the
         switch-account screen → signed-out screen → signed-in
         flash chain instead of a clean re-SSO. With this gate,
         when the server says we're not signed in, we take CASE B
         regardless of whatever React still holds in `user`. */
      const isReallyLoggedIn = !!user && serverVerified;
      setSigningIn(true);

      if (isReallyLoggedIn) {
        clearSession();
        /* Attempt client-side cookie deletion (best-effort — the CF
           cookie is HttpOnly so this is a no-op for it, but clears
           any non-HttpOnly cookies we may have set). */
        try {
          const d = window.location.hostname;
          document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
          document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=" + d;
          document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=." + d;
        } catch (_) {}
        window.location.href = "/logout.html?switch=1";
        return;
      }

      /* CASE B — fresh SSO. Always top-level navigate to the protected
         entry point (see lessons.md + _worker.js). Reloading the current
         page (e.g. today.html LoginScreen) only refreshed in place and
         never re-drove CF Access; the nav logo worked because it did a
         clean navigation to /today.html. _auth defeats CDN cache. */
      clearSession();
      window.location.href = "/today.html?_auth=" + Date.now();
    }, [user, serverVerified]);

    // Set user role on body for CSS-based admin gating of nav links
    // Expose _ttIsPro and _ttMemberTickers for freemium gating
    // MUST be before any conditional returns to obey Rules of Hooks
    useEffect(() => {
      if (user) {
        const isAdmin = user.role === "admin" || user.tier === "admin";
        // 2026-05-31 — Keep this in lockstep with the requiredTier
        // paywall check above. `canceling` (user still in paid period
        // after canceling) and `past_due` within `expires_at` grace
        // both count as Pro so the chrome (activity strip, bell, pro
        // gating) matches the actual access state.
        const subStatus = user.subscription_status;
        const isPastDueInGrace =
          subStatus === "past_due" &&
          Number.isFinite(Number(user.expires_at)) &&
          Number(user.expires_at) > Date.now();
        const isPro = isAdmin ||
          user.tier === "pro" || user.tier === "vip" ||
          subStatus === "active" ||
          subStatus === "trialing" ||
          subStatus === "manual" ||
          subStatus === "canceling" ||
          isPastDueInGrace;
        document.body.dataset.userRole = isAdmin ? "admin" : (user.role || "member");
        document.body.dataset.userTier = user.tier || "free";
        document.body.dataset.isPro = isPro ? "true" : "false";
        document.body.dataset.isAdmin = isAdmin ? "true" : "false";
        document.body.dataset.isAuthenticated = "true";

        // Expose globals for component-level gating
        Object.defineProperty(window, '_ttIsPro', { get() { return document.body.dataset.isPro === "true"; }, configurable: true });
        Object.defineProperty(window, '_ttIsAdmin', { get() { return document.body.dataset.isAdmin === "true"; }, configurable: true });
        Object.defineProperty(window, '_ttIsAuthenticated', { get() { return document.body.dataset.isAuthenticated === "true"; }, configurable: true });

        // Let nav extras (badges + admin dropdown) re-run after auth.
        try {
          window.dispatchEvent(new CustomEvent("tt-auth-bootstrap-updated", {
            detail: { user, isAdmin, isPro, isAuthenticated: true },
          }));
        } catch (_) {}
      } else {
        // 2026-06-06 — Clear stale Pro/Admin flags on logout. Previously
        // dataset.isPro lingered after setUser(null), so tt-activity-strip
        // kept polling /timed/activity on the LoginScreen.
        document.body.dataset.isPro = "false";
        document.body.dataset.isAdmin = "false";
        document.body.dataset.isAuthenticated = "false";
        delete document.body.dataset.userRole;
        delete document.body.dataset.userTier;
        Object.defineProperty(window, '_ttIsPro', { get() { return false; }, configurable: true });
        Object.defineProperty(window, '_ttIsAdmin', { get() { return false; }, configurable: true });
        Object.defineProperty(window, '_ttIsAuthenticated', { get() { return false; }, configurable: true });
        try {
          window.dispatchEvent(new CustomEvent("tt-auth-bootstrap-updated", {
            detail: { user: null, isAdmin: false, isPro: false, isAuthenticated: false },
          }));
        } catch (_) {}
      }
    }, [user]);

    // Expose member ticker list from /timed/me response
    useEffect(() => {
      const DEFAULT_MEMBER_TICKERS = ["AAPL","TSLA","NVDA","JPM","NFLX","MSFT","GOOGL","AMZN","META","XOM"];
      const tickers = (Array.isArray(memberTickers) && memberTickers.length > 0)
        ? memberTickers
        : DEFAULT_MEMBER_TICKERS;
      window._ttMemberTickers = tickers;
      window._ttMemberTickerSet = new Set(tickers.map(t => String(t).toUpperCase()));
    }, [memberTickers]);

    // Register push notifications once authenticated AND server-verified.
    // Placed here (before conditional returns) to obey Rules of Hooks.
    // Only fires after /timed/me confirms the session is valid server-side,
    // preventing 401s from stale cached sessions (e.g. after sign-out).
    // Fully wrapped in catch — must never crash the app.
    useEffect(() => {
      if (user && serverVerified) {
        const cancel = scheduleIdleWork(() => {
          try { registerPushNotifications(apiBase).catch(() => {}); } catch (_) {}
        }, 2500);
        return cancel;
      }
    }, [user, serverVerified, apiBase]);

    // Session heartbeat for admin analytics — every authenticated page.
    // Previously only index-react.html called this, so the sessions table
    // stayed empty and Analytics showed all zeros.
    useEffect(() => {
      if (user && state === "authenticated") {
        let stop = null;
        const cancel = scheduleIdleWork(() => {
          try { stop = startSessionHeartbeat(apiBase); } catch (_) {}
        }, 800);
        return () => {
          cancel();
          if (typeof stop === "function") stop();
        };
      }
    }, [user, state, apiBase]);

    if (state === "checking" && !user) {
      // Show minimal loading state
      return React.createElement(
        "div",
        {
          style: {
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#0b0e11",
          },
        },
        React.createElement(
          "div",
          { style: { textAlign: "center" } },
          React.createElement("div", {
            style: {
              width: "32px",
              height: "32px",
              border: "2px solid rgba(255,255,255,0.06)",
              borderTopColor: "#00c853",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
              margin: "0 auto 12px",
            },
          }),
          React.createElement(
            "p",
            {
              style: {
                fontSize: "13px",
                color: "#6b7280",
                fontFamily: '"Inter", sans-serif',
              },
            },
            "Verifying session...",
          ),
        ),
      );
    }

    if (state === "unauthenticated") {
      /* Show login screen so user can trigger Cloudflare Access SSO.
         loading=true while the SSO redirect chain runs so the user
         sees "Authenticating..." instead of an active button that
         looks unresponsive. */
      return React.createElement(LoginScreen, {
        onRetry: handleLogin,
        error: error,
        loading: signingIn,
      });
    }

    if (state === "blocked") {
      // 2026-05-31 — Dedicated screen for hard-blocked accounts. Different
      // from "unauthenticated" — Sign In would loop the user back here, so
      // we surface a clear support contact path instead of any login CTA.
      const blockedEmail = user?.email || "your account";
      return React.createElement("div", {
        style: {
          minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
          background: "#0b0e11", padding: "24px",
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      },
        React.createElement("div", {
          style: {
            maxWidth: "480px", width: "100%", padding: "40px 32px", textAlign: "center",
            background: "#13171D", border: "1px solid rgba(248,113,113,0.18)",
            borderRadius: "14px",
          },
        },
          React.createElement("div", {
            style: { fontSize: "32px", marginBottom: "12px", color: "#f87171" },
          }, "⛔"),
          React.createElement("h1", {
            style: { fontSize: "22px", margin: "0 0 12px", color: "#fff", fontWeight: 700 },
          }, "Account suspended"),
          React.createElement("p", {
            style: { fontSize: "14px", lineHeight: 1.6, color: "#9ca3af", margin: "0 0 8px" },
          },
            "Sign-in succeeded for ",
            React.createElement("code", { style: { color: "#fbbf24" } }, blockedEmail),
            ", but this account is currently blocked from accessing Timed Trading.",
          ),
          React.createElement("p", {
            style: { fontSize: "13px", lineHeight: 1.6, color: "#6b7280", margin: "0 0 24px" },
          },
            "If you believe this is a mistake, contact ",
            React.createElement("a", {
              href: "mailto:support@timed-trading.com",
              style: { color: "#67e8f9", textDecoration: "underline" },
            }, "support@timed-trading.com"),
            ".",
          ),
          React.createElement("a", {
            href: "/cdn-cgi/access/logout",
            style: {
              display: "inline-block", padding: "10px 18px", fontSize: "13px",
              color: "#e5e7eb", background: "transparent",
              border: "1px solid rgba(255,255,255,0.12)", borderRadius: "8px",
              textDecoration: "none", fontWeight: 600,
            },
          }, "Sign out"),
        ),
      );
    }

    // Stripe activation in progress: show loading screen instead of paywall
    if (stripeActivating) {
      return React.createElement("div", {
        style: {
          minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
          background: "#0b0e11", flexDirection: "column", gap: "16px",
        },
      },
        React.createElement("div", {
          style: {
            width: "40px", height: "40px", border: "3px solid rgba(255,255,255,0.06)",
            borderTopColor: "#00c853", borderRadius: "50%", animation: "spin 0.8s linear infinite",
          },
        }),
        React.createElement("p", {
          style: { fontSize: "16px", color: "#e5e7eb", fontWeight: "600" },
        }, "Setting up your account..."),
        React.createElement("p", {
          style: { fontSize: "13px", color: "#6b7280", maxWidth: "300px", textAlign: "center" },
        }, "Your payment was received. We're activating your subscription. This usually takes a few seconds."),
      );
    }

    // Tier gating: if requiredTier is set, check the user has sufficient access
    // VIP users have the same access as Pro users (explicit check for robustness).
    // Users with subscription_status "manual" (admin-granted) bypass the paywall.
    //
    // 2026-05-31 — Subscription-state matrix tightened:
    //   trialing | active | manual                → PASS  (Pro features)
    //   canceling                                  → PASS  (still in paid period; tier=pro until period_end)
    //   past_due (within 3-day grace)              → PASS  (matches webhook + email promise)
    //   past_due (after expires_at)                → PAYWALL
    //   canceled | (null/none)                     → PAYWALL
    //
    // Without the past_due grace, users got an email saying "3-day
    // grace" while the auth-gate locked them out immediately.
    if (requiredTier && user) {
      const effectiveTier = user.tier === "vip" ? "pro" : user.tier;
      const required = TIER_ORDER[requiredTier] ?? 0;
      const current = TIER_ORDER[effectiveTier] ?? 0;
      if (current < required) {
        // For pro-tier pages: show paywall if user is free with no active subscription
        if (requiredTier === "pro" && (effectiveTier === "free" || !effectiveTier)) {
          const subStatus = user.subscription_status;
          const isPaidStatus =
            subStatus === "trialing" ||
            subStatus === "active" ||
            subStatus === "manual" ||
            subStatus === "canceling";
          const isPastDueInGrace =
            subStatus === "past_due" &&
            Number.isFinite(Number(user.expires_at)) &&
            Number(user.expires_at) > Date.now();
          if (!isPaidStatus && !isPastDueInGrace) {
            return React.createElement(PaywallScreen, {
              user: user,
              apiBase: apiBase,
            });
          }
        }
        return React.createElement(AccessDeniedScreen, {
          user: user,
          requiredTier: requiredTier,
        });
      }
    }

    // Terms acceptance gate: user must accept Terms of Use before accessing the platform
    if (serverVerified && user && !user.terms_accepted_at) {
      return React.createElement(TermsGateScreen, {
        user: user,
        apiBase: apiBase,
        onAccepted: (ts) => {
          // Update user state with accepted timestamp so the gate passes
          const updated = { ...user, terms_accepted_at: ts };
          setUser(updated);
          storeSession(updated);
        },
      });
    }

    // Authenticated, tier-authorized, and terms accepted — render children with user context
    const appContent = typeof children === "function" ? children(user) : children;

    // V15 P0.7.117 (2026-05-09) — Restored the full legal disclaimer
    // sentence per user request. Now that P0.7.116 made the footer
    // inline (scrolls with page, not position:fixed), the full text
    // can wrap freely on narrow viewports without eating any viewport
    // real estate. Two-line layout: full disclaimer on top, action
    // links underneath. Twelve Data attribution kept (rule: "Footer
    // MUST include 'Market data powered by Twelve Data'"). data-tt-
    // auth-footer attribute preserved for any external measurement.
    const linkStyle = {
      color: "#6b7280",
      textDecoration: "underline",
      textUnderlineOffset: "2px",
      transition: "color 0.2s",
    };
    const sepStyle = { color: "#374151" };
    const onLinkHover = (e) => { e.currentTarget.style.color = "#9ca3af"; };
    const onLinkLeave = (e) => { e.currentTarget.style.color = "#6b7280"; };
    return React.createElement(React.Fragment, null,
      appContent,
      React.createElement("style", null, `
        [data-tt-auth-footer] { padding: 10px 16px; font-size: 11px; line-height: 1.5; color: #6b7280; }
        [data-tt-auth-footer] .tt-foot-disclaimer { max-width: 980px; margin: 0 auto; text-align: center; }
        [data-tt-auth-footer] .tt-foot-links { margin-top: 6px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
        @media (max-width: 768px) {
          [data-tt-auth-footer] { padding: 8px 12px; font-size: 10px; line-height: 1.45; }
          [data-tt-auth-footer] .tt-foot-links { gap: 8px; font-size: 10px; }
        }
      `),
      React.createElement("div", {
        "data-tt-auth-footer": "1",
        style: {
          width: "100%",
          background: "rgba(11,14,17,0.92)",
          borderTop: "1px solid rgba(255,255,255,0.04)",
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          pointerEvents: "auto",
          paddingBottom: "max(8px, env(safe-area-inset-bottom))",
          marginTop: "16px",
        },
      },
        React.createElement("div", { className: "tt-foot-disclaimer" },
          "For informational and educational purposes only. Not investment advice. Past performance does not guarantee future results. All trading involves risk of loss."
        ),
        React.createElement("div", { className: "tt-foot-links" },
          React.createElement("span", { style: { color: "#4b5563" } }, "\u00a9 2026 Timed Trading"),
          React.createElement("span", { style: sepStyle }, "\u00b7"),
          React.createElement("a", {
            href: "/terms.html", target: "_blank", rel: "noopener noreferrer", style: linkStyle,
            onMouseEnter: onLinkHover, onMouseLeave: onLinkLeave,
          }, "Full Terms"),
          React.createElement("span", { style: sepStyle }, "\u00b7"),
          React.createElement("a", {
            href: "/faq.html", target: "_blank", rel: "noopener noreferrer", style: linkStyle,
            onMouseEnter: onLinkHover, onMouseLeave: onLinkLeave,
          }, "FAQ"),
          React.createElement("span", { style: sepStyle }, "\u00b7"),
          React.createElement("a", {
            href: "mailto:support@timed-trading.com", style: linkStyle,
            onMouseEnter: onLinkHover, onMouseLeave: onLinkLeave,
          }, "Contact"),
          React.createElement("span", { style: sepStyle }, "\u00b7"),
          React.createElement("span", null,
            "Market data powered by ",
            React.createElement("a", {
              href: "https://twelvedata.com", target: "_blank", rel: "noopener noreferrer",
              style: linkStyle, title: "Market data powered by Twelve Data",
              onMouseEnter: onLinkHover, onMouseLeave: onLinkLeave,
            }, "Twelve Data"),
          ),
        ),
      ),
    );
  }

  // ── User Badge (for nav bars) ────────────────────────────────────────────
  function UserBadge({ user, compact }) {
    const [showMenu, setShowMenu] = useState(false);
    const menuRef = React.useRef(null);

    React.useEffect(() => {
      if (!showMenu) return;
      const handler = (e) => {
        if (menuRef.current && !menuRef.current.contains(e.target)) {
          setShowMenu(false);
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [showMenu]);

    if (!user) return null;

    const initial = (user.display_name || user.email || "?")
      .charAt(0)
      .toUpperCase();
    const displayName = user.display_name || user.email?.split("@")[0] || "User";

    const handleLogout = async () => {
      clearSession();
      window.location.href = "/logout.html";
    };

    if (compact) {
      /* V15 P0.7.115 (2026-05-09) — Avatar "vertically stretched" fix.
         The previous P0.7.113 used <button> with aspectRatio + min/max
         width/height. The user still reported the avatar rendering tall.
         Root cause hypothesis: <button> elements inherit user-agent
         default styling (Safari/iOS in particular adds vertical padding
         + line-height that survives `padding: 0`). Switching to <div>
         with role="button" + tabIndex + keyboard handlers removes ALL
         browser button defaults. We also use `lineHeight: "28px"` to
         exactly match the height (so the inline text "S" can't push the
         box taller via line-height inflation), `verticalAlign: middle`
         to lock vertical centering, and keep all the dimension locks. */
      const onActivate = () => setShowMenu(!showMenu);
      return React.createElement(
        "div",
        { ref: menuRef, style: { position: "relative", flexShrink: 0, display: "inline-flex", alignItems: "center" } },
        React.createElement(
          "div",
          {
            onClick: onActivate,
            onKeyDown: (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onActivate();
              }
            },
            role: "button",
            tabIndex: 0,
            "aria-label": `${displayName} menu`,
            style: {
              width: "28px",
              minWidth: "28px",
              maxWidth: "28px",
              height: "28px",
              minHeight: "28px",
              maxHeight: "28px",
              flex: "0 0 28px",
              aspectRatio: "1 / 1",
              borderRadius: "50%",
              background:
                "linear-gradient(135deg, #00c853 0%, #00e676 100%)",
              border: "none",
              color: "white",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: "inherit",
              padding: 0,
              margin: 0,
              lineHeight: "28px",
              textAlign: "center",
              verticalAlign: "middle",
              boxSizing: "border-box",
              overflow: "hidden",
              userSelect: "none",
              WebkitUserSelect: "none",
            },
            title: `${displayName} (${user.email})`,
          },
          initial,
        ),
        showMenu &&
          React.createElement(
            "div",
            {
              style: {
                position: "absolute",
                right: 0,
                top: "36px",
                width: "220px",
                background: "#1a1d23",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "10px",
                padding: "8px",
                zIndex: 9999,
                boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
              },
            },
            React.createElement(
              "div",
              {
                style: {
                  padding: "8px 12px",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                  marginBottom: "4px",
                },
              },
              React.createElement(
                "div",
                {
                  style: {
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "#e5e7eb",
                  },
                },
                displayName,
              ),
              React.createElement(
                "div",
                {
                  style: {
                    fontSize: "11px",
                    color: "#6b7280",
                    marginTop: "2px",
                  },
                },
                user.email,
              ),
              user.tier &&
                React.createElement(
                  "span",
                  {
                    style: {
                      display: "inline-block",
                      marginTop: "6px",
                      fontSize: "10px",
                      fontWeight: "500",
                      padding: "2px 8px",
                      borderRadius: "4px",
                      background:
                        user.tier === "admin"
                          ? "rgba(139, 92, 246, 0.15)"
                          : user.tier === "vip"
                            ? "rgba(251, 191, 36, 0.15)"
                            : user.tier === "pro"
                              ? "rgba(0, 200, 83, 0.15)"
                              : "rgba(255,255,255,0.06)",
                      color:
                        user.tier === "admin"
                          ? "#a78bfa"
                          : user.tier === "vip"
                            ? "#fbbf24"
                            : user.tier === "pro"
                              ? "#00c853"
                              : "#6b7280",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    },
                  },
                  user.tier === "free" ? "MEMBER" : user.tier === "vip" ? "VIP" : user.tier,
                ),
            ),
            // Trial days remaining badge
            user.subscription_status === "trialing" && user.trial_end &&
            (() => {
              const daysLeft = Math.max(0, Math.ceil((Number(user.trial_end) - Date.now()) / (24 * 60 * 60 * 1000)));
              return React.createElement("div", {
                style: {
                  padding: "8px 12px", borderRadius: "8px",
                  background: daysLeft <= 7 ? "rgba(251,191,36,0.08)" : "rgba(0,200,83,0.06)",
                  border: daysLeft <= 7 ? "1px solid rgba(251,191,36,0.2)" : "1px solid rgba(0,200,83,0.15)",
                  fontSize: "12px", color: daysLeft <= 7 ? "#fbbf24" : "#00c853",
                  fontWeight: "500", textAlign: "center",
                },
              },
                React.createElement("span", { style: { fontSize: "16px", fontWeight: "700", display: "block" } }, String(daysLeft)),
                daysLeft === 1 ? "day left in trial" : "days left in trial",
              );
            })(),
            // My Account button (Stripe Customer Portal for subscription management)
            // VIP users don't have Stripe subscriptions, so hide this for them
            user.tier !== "vip" && (user.tier === "pro" || user.subscription_status === "trialing" || user.subscription_status === "active") &&
            React.createElement(
              "button",
              {
                onClick: async () => {
                  setShowMenu(false);
                  try {
                    const res = await fetch("/timed/stripe/portal", {
                      method: "POST",
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ return_url: window.location.href }),
                    });
                    const json = await res.json();
                    if (json.ok && json.url) {
                      window.location.href = json.url;
                    } else {
                      const msg = json.error === "stripe_not_configured"
                        ? "Account management is not available yet. Please contact support."
                        : "Unable to open account management. Please try again.";
                      alert(msg);
                    }
                  } catch (e) {
                    alert("Unable to connect. Please check your network and try again.");
                  }
                },
                style: {
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "none",
                  background: "transparent",
                  color: "#00c853",
                  fontSize: "13px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                },
                onMouseEnter: (e) =>
                  (e.currentTarget.style.background = "rgba(0, 200, 83, 0.06)"),
                onMouseLeave: (e) =>
                  (e.currentTarget.style.background = "transparent"),
              },
              React.createElement("svg", {
                width: "14", height: "14", viewBox: "0 0 24 24", fill: "none",
                stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
              },
                React.createElement("path", { d: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" }),
                React.createElement("circle", { cx: "12", cy: "7", r: "4" }),
              ),
              "My Account",
            ),
            // 2026-05-31 — Switch account button (above Sign Out).
            // Sign Out alone only clears CF Access + our local
            // session; the user's Google session in the browser
            // persists, so the next sign-in silently auto-completes
            // with the same account. "Switch account" routes through
            // /logout.html?switch=1 which additionally clears the
            // browser's Google session, forcing the account picker
            // on the next sign-in. (Sign Out kept underneath for the
            // simple "just log me out" case.)
            React.createElement(
              "button",
              {
                onClick: () => {
                  clearSession();
                  window.location.href = "/logout.html?switch=1";
                },
                style: {
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "none",
                  background: "transparent",
                  color: "#67e8f9",
                  fontSize: "13px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                },
                onMouseEnter: (e) =>
                  (e.currentTarget.style.background = "rgba(103, 232, 249, 0.10)"),
                onMouseLeave: (e) =>
                  (e.currentTarget.style.background = "transparent"),
              },
              React.createElement(
                "svg",
                {
                  width: "14", height: "14", viewBox: "0 0 24 24", fill: "none",
                  stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
                },
                React.createElement("path", { d: "M17 1l4 4-4 4" }),
                React.createElement("path", { d: "M3 11V9a4 4 0 0 1 4-4h14" }),
                React.createElement("path", { d: "M7 23l-4-4 4-4" }),
                React.createElement("path", { d: "M21 13v2a4 4 0 0 1-4 4H3" }),
              ),
              "Switch account",
            ),
            // Sign Out button
            React.createElement(
              "button",
              {
                onClick: handleLogout,
                style: {
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "none",
                  background: "transparent",
                  color: "#ef4444",
                  fontSize: "13px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                },
                onMouseEnter: (e) =>
                  (e.currentTarget.style.background = "rgba(239, 68, 68, 0.1)"),
                onMouseLeave: (e) =>
                  (e.currentTarget.style.background = "transparent"),
              },
              React.createElement(
                "svg",
                {
                  width: "14", height: "14", viewBox: "0 0 24 24", fill: "none",
                  stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round",
                },
                React.createElement("path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" }),
                React.createElement("polyline", { points: "16 17 21 12 16 7" }),
                React.createElement("line", { x1: "21", y1: "12", x2: "9", y2: "12" }),
              ),
              "Sign Out",
            ),
          ),
      );
    }

    return React.createElement(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: "8px",
        },
      },
      React.createElement(
        "span",
        {
          style: {
            fontSize: "12px",
            color: "#6b7280",
          },
        },
        displayName,
      ),
      React.createElement(
        "div",
        {
          style: {
            width: "28px",
            height: "28px",
            borderRadius: "50%",
            background:
              "linear-gradient(135deg, #00c853 0%, #00e676 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontSize: "12px",
            fontWeight: "600",
          },
        },
        initial,
      ),
    );
  }

  // ── Notification Center (Bell Icon + Dropdown) ───────────────────────────
  function NotificationCenter({ apiBase }) {
    const h = React.createElement;
    const [open, setOpen] = React.useState(false);
    const [notifications, setNotifications] = React.useState([]);
    const [unreadCount, setUnreadCount] = React.useState(() => {
      const cached = getStoredBootstrap();
      return Number(cached?.unread_trade_alert_count) || 0;
    });
    const [loading, setLoading] = React.useState(false);
    const [selectedNotification, setSelectedNotification] = React.useState(null); // modal
    const [filter, setFilter] = React.useState("all"); // "all" | "trade_alerts" | "investor_alerts"
    const bellRef = React.useRef(null);

    const isActionableNotif = React.useCallback((n) => {
      const SG = window.TimedSignalGrammar;
      if (SG && typeof SG.isActionableNotification === "function") {
        return SG.isActionableNotification(n);
      }
      const t = String(n?.type || "").toLowerCase();
      if (t === "trade_entry" || t === "trade_exit" || t === "trade_trim") return true;
      if (t === "investor_signal") {
        const title = String(n?.title || "").toUpperCase();
        if (title.includes("ON RADAR") || title.includes("WATCH") || title.includes("INFO")) return false;
        return true;
      }
      if (t === "kanban") {
        const title = String(n?.title || "").toUpperCase();
        if (title.startsWith("SETUP:")) return false;
        return true;
      }
      return false;
    }, []);

    const TRADE_ALERT_TYPES = ["trade_entry", "trade_exit", "trade_trim"];
    const INVESTOR_ALERT_TYPES = ["investor_signal"];
    // 2026-06-22 — scope tag (Investor vs Active Trader) so the feed reads
    // unambiguously. Investor notifications carry an investor_* type or an
    // investor link; trade_*/kanban are trader-lane; brief/system are neither.
    const notifScope = (n) => {
      const t = String(n?.type || "").toLowerCase();
      const link = String(n?.link || "").toLowerCase();
      if (t.startsWith("investor") || /investor/.test(link)) return "investor";
      if (t.startsWith("trade_") || t === "kanban") return "trader";
      return null;
    };
    const notifMode = (n) => {
      const cls = String(n?.alert_class || n?.mode || "").toLowerCase();
      if (cls === "doing" || cls === "watching") return cls;
      const exec = String(n?.exec_state || "").toLowerCase();
      if (exec === "recommended" || exec === "done") return "doing";
      const t = String(n?.type || "").toLowerCase();
      if (t.startsWith("trade_")) return "doing";
      if (t === "kanban") return "watching";
      return null;
    };
    const actionableNotifications = notifications.filter(isActionableNotif);
    const scopeFiltered = filter === "trade_alerts"
      ? actionableNotifications.filter(n => TRADE_ALERT_TYPES.includes(n.type))
      : filter === "investor_alerts"
        ? actionableNotifications.filter(n => INVESTOR_ALERT_TYPES.includes(n.type))
        : actionableNotifications;
    const filteredNotifications = React.useMemo(() => {
      return [...scopeFiltered].sort((a, b) => Number(b.created_at) - Number(a.created_at));
    }, [scopeFiltered]);
    const tradeAlertsCount = actionableNotifications.filter(n => TRADE_ALERT_TYPES.includes(n.type)).length;
    const investorAlertsCount = actionableNotifications.filter(n => INVESTOR_ALERT_TYPES.includes(n.type)).length;

    React.useEffect(() => {
      const handler = (event) => {
        const next = Number(event?.detail?.unread_trade_alert_count);
        if (Number.isFinite(next)) setUnreadCount(next);
      };
      window.addEventListener("tt-auth-bootstrap-updated", handler);
      return () => window.removeEventListener("tt-auth-bootstrap-updated", handler);
    }, []);

    // Type-to-icon color mapping
    const typeColors = {
      trade_entry: "#00c853",
      trade_exit: "#ff5252",
      trade_trim: "#ff9800",
      investor_signal: "#3b82f6",
      daily_brief: "#42a5f5",
      system: "#6b7280",
      kanban: "#a78bfa",
    };
    const typeLabels = {
      trade_entry: "Enter",
      trade_exit: "Exit",
      trade_trim: "Trim",
      investor_signal: "Investor",
      daily_brief: "Daily Brief",
      system: "System",
      kanban: "Update",
    };

    const cleanNotifTitle = (title) => String(title || "")
      .replace(/^\[(?:TRADER|INVESTOR)\s*·\s*(?:DOING|WATCHING)(?:\s*·\s*\w+)?\]\s*/i, "")
      .replace(/^\[(?:TRADER|INVESTOR)\s*·\s*\w+\]\s*/i, "")
      .trim();

    const notifActionChip = (n) => {
      const t = String(n?.type || "").toLowerCase();
      const exec = String(n?.exec_state || "").toLowerCase();
      if (exec === "recommended") {
        return { label: "WARNING", color: "#fde68a", bg: "rgba(250,204,21,0.14)", border: "rgba(250,204,21,0.35)" };
      }
      if (t === "trade_exit") {
        return { label: "EXIT", color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.30)" };
      }
      if (t === "trade_trim") {
        return { label: "TRIM", color: "#fdba74", bg: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.30)" };
      }
      if (t === "trade_entry") {
        return { label: "ENTER", color: "#38F2A1", bg: "rgba(56,242,161,0.10)", border: "rgba(56,242,161,0.28)" };
      }
      if (t === "investor_signal") {
        return { label: "INVESTOR", color: "#c4b5fd", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.30)" };
      }
      return { label: "UPDATE", color: "#8AA39A", bg: "rgba(255,255,255,0.04)", border: "rgba(255,255,255,0.10)" };
    };

    const fetchNotifications = React.useCallback(async () => {
      try {
        const res = await fetch(`${apiBase}/timed/notifications?limit=50`, { credentials: "include" });
        if (res.ok) {
          const json = await res.json();
          if (json.ok) {
            setNotifications(json.notifications || []);
            // Bell badge = trader executions + investor signals (not Daily Brief / system)
            setUnreadCount(json.unread_trade_alert_count ?? json.unread_count ?? 0);
          }
        }
      } catch {}
    }, [apiBase]);

    // Poll while authenticated so opening the bell shows fresh trade signals (not only on open).
    React.useEffect(() => {
      fetchNotifications();
      const iv = setInterval(fetchNotifications, 60000);
      return () => clearInterval(iv);
    }, [fetchNotifications]);

    React.useEffect(() => {
      if (!open) return undefined;
      fetchNotifications();
      const iv = setInterval(fetchNotifications, 30000);
      return () => clearInterval(iv);
    }, [fetchNotifications, open]);

    // Close dropdown on outside click (but not when modal is open)
    React.useEffect(() => {
      const handler = (e) => {
        if (selectedNotification) return; // modal handles its own clicks
        if (bellRef.current && !bellRef.current.contains(e.target)) setOpen(false);
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [selectedNotification]);

    const markAllRead = React.useCallback(async () => {
      try {
        await fetch(`${apiBase}/timed/notifications/read`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: "{}",
        });
        setUnreadCount(0);
        setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || Date.now() })));
      } catch {}
    }, [apiBase]);

    const clearAll = async () => {
      try {
        await fetch(`${apiBase}/timed/notifications/clear`, {
          method: "POST", credentials: "include",
        });
        setNotifications([]);
        setUnreadCount(0);
      } catch {}
    };

    const markSingleRead = async (n) => {
      if (!n.read_at) {
        try {
          await fetch(`${apiBase}/timed/notifications/read`, {
            method: "POST", credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: n.id }),
          });
          setUnreadCount(prev => Math.max(0, prev - 1));
          setNotifications(prev => prev.map(x => x.id === n.id ? { ...x, read_at: Date.now() } : x));
        } catch {}
      }
    };

    const handleClick = async (n) => {
      await markSingleRead(n);
      setOpen(false);
      setSelectedNotification(null);
      if (typeof window.ttOpenNotificationInRail === "function") {
        await window.ttOpenNotificationInRail(n, { scope: notifScope(n) });
        return;
      }
      setSelectedNotification(n);
    };

    const formatTime = (ts) => {
      if (!ts) return "";
      const d = new Date(ts);
      const diff = Date.now() - d.getTime();
      if (diff < 60000) return "Just now";
      if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
      if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    };

    const formatFullTime = (ts) => {
      if (!ts) return "";
      return new Date(ts).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      });
    };

    // ── Notification Detail Modal ──
    const modal = selectedNotification && h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 50000, display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      },
      onClick: (e) => { if (e.target === e.currentTarget) setSelectedNotification(null); },
    },
      h("div", {
        style: {
          width: "90%", maxWidth: "520px", maxHeight: "80vh", background: "#141720",
          border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px",
          overflow: "hidden", display: "flex", flexDirection: "column",
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      },
        // Modal header
        h("div", {
          style: {
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)",
          },
        },
          h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
            h("div", {
              style: {
                width: "10px", height: "10px", borderRadius: "50%",
                background: typeColors[selectedNotification.type] || "#6b7280",
              },
            }),
            h("span", { style: { fontSize: "11px", color: "#6b7280", fontWeight: "600", textTransform: "uppercase", letterSpacing: "0.04em" } },
              typeLabels[selectedNotification.type] || selectedNotification.type || "Notification"),
          ),
          h("button", {
            onClick: () => setSelectedNotification(null),
            style: { background: "none", border: "none", cursor: "pointer", fontSize: "18px", color: "#6b7280", padding: "4px" },
          }, "\u2715"),
        ),
        // Modal body
        h("div", { style: { padding: "20px", overflowY: "auto", flex: 1 } },
          h("h3", { style: { fontSize: "16px", fontWeight: "700", color: "#E8F5EE", margin: "0 0 8px", lineHeight: "1.35" } },
            cleanNotifTitle(selectedNotification.title)),
          h("div", { style: { fontSize: "11px", color: "#374151", marginBottom: "16px" } },
            formatFullTime(selectedNotification.created_at)),
          selectedNotification.body && h("div", {
            style: {
              fontSize: "13px", color: "#9ca3af", lineHeight: "1.7", whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            },
          }, selectedNotification.body),
        ),
        // Modal footer
        h("div", {
          style: {
            padding: "12px 20px", borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          },
        },
          selectedNotification.link
            ? h("button", {
                type: "button",
                onClick: async () => {
                  if (typeof window.ttOpenNotificationInRail === "function") {
                    await window.ttOpenNotificationInRail(selectedNotification, { scope: notifScope(selectedNotification) });
                    setSelectedNotification(null);
                    return;
                  }
                  window.location.href = selectedNotification.link;
                },
                style: {
                  fontSize: "12px", color: "#00c853", background: "none", border: "none",
                  cursor: "pointer", fontWeight: "500", padding: 0, fontFamily: "inherit",
                },
              }, "View Details \u2192")
            : h("span"),
          h("button", {
            onClick: () => setSelectedNotification(null),
            style: {
              padding: "8px 16px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.04)", color: "#e5e7eb", fontSize: "12px",
              fontWeight: "500", cursor: "pointer", fontFamily: "inherit",
            },
          }, "Close"),
        ),
      ),
    );

    return h("div", { ref: bellRef, style: { position: "relative", display: "inline-flex" } },
      // Bell button — opening the dropdown marks all as read so badge clears
      h("button", {
        onClick: () => {
          const next = !open;
          setOpen(next);
          if (next) {
            fetchNotifications();
            markAllRead(); // Mark all read when user opens modal so badge doesn't linger
          }
        },
        style: {
          position: "relative", background: "none", border: "none", cursor: "pointer",
          padding: "4px 6px", borderRadius: "6px", display: "flex", alignItems: "center",
        },
        title: "Alerts",
      },
        h("svg", {
          width: "18", height: "18", viewBox: "0 0 24 24", fill: "none",
          stroke: unreadCount > 0 ? "#00c853" : "#6b7280", strokeWidth: "2",
          strokeLinecap: "round", strokeLinejoin: "round",
        },
          h("path", { d: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" }),
          h("path", { d: "M13.73 21a2 2 0 0 1-3.46 0" }),
        ),
        // Badge (trade-alert unread count only)
        unreadCount > 0 && h("span", {
          style: {
            position: "absolute", top: "0", right: "2px", minWidth: "16px", height: "16px",
            borderRadius: "8px", background: "#ff5252", color: "#fff", fontSize: "10px",
            fontWeight: "700", display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 4px", lineHeight: "1",
          },
        }, unreadCount > 9 ? "9+" : unreadCount),
      ),
      // Dropdown
      open && h("div", {
        style: {
          position: "absolute", top: "calc(100% + 8px)", right: "0", width: "360px", maxHeight: "440px",
          background: "#0B1410", border: "1px solid rgba(56,242,161,0.14)", borderRadius: "14px",
          boxShadow: "0 20px 56px rgba(0,0,0,0.55)", zIndex: 10000, overflow: "hidden",
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      },
        // Header
        h("div", {
          style: {
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "14px 16px", borderBottom: "1px solid rgba(56,242,161,0.10)",
            background: "linear-gradient(180deg, rgba(56,242,161,0.06) 0%, transparent 100%)",
          },
        },
          h("span", { style: { fontSize: "13px", fontWeight: "700", color: "#E8F5EE", letterSpacing: "-0.01em" } }, "Notifications"),
          h("div", { style: { display: "flex", gap: "10px" } },
            unreadCount > 0 && h("button", {
              onClick: markAllRead,
              style: { background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "#38F2A1", fontWeight: "600" },
            }, "Mark read"),
            notifications.length > 0 && h("button", {
              onClick: clearAll,
              style: { background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "#6E867D" },
            }, "Clear all"),
          ),
        ),
        // Alert filter tabs
        h("div", {
          style: {
            display: "flex", gap: "6px", padding: "10px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.05)",
          },
        },
          h("button", {
            onClick: () => setFilter("all"),
            style: {
              padding: "5px 12px", borderRadius: "999px", fontSize: "11px", fontWeight: "600",
              background: filter === "all" ? "rgba(56,242,161,0.12)" : "transparent",
              color: filter === "all" ? "#38F2A1" : "#6E867D",
              border: filter === "all" ? "1px solid rgba(56,242,161,0.22)" : "1px solid transparent",
              cursor: "pointer",
            },
          }, "All"),
          h("button", {
            onClick: () => setFilter("trade_alerts"),
            style: {
              padding: "5px 12px", borderRadius: "999px", fontSize: "11px", fontWeight: "600",
              background: filter === "trade_alerts" ? "rgba(56,242,161,0.12)" : "transparent",
              color: filter === "trade_alerts" ? "#38F2A1" : "#6E867D",
              border: filter === "trade_alerts" ? "1px solid rgba(56,242,161,0.22)" : "1px solid transparent",
              cursor: "pointer",
            },
          }, "Trader" + (tradeAlertsCount > 0 ? " (" + tradeAlertsCount + ")" : "")),
          h("button", {
            onClick: () => setFilter("investor_alerts"),
            style: {
              padding: "5px 12px", borderRadius: "999px", fontSize: "11px", fontWeight: "600",
              background: filter === "investor_alerts" ? "rgba(167,139,250,0.12)" : "transparent",
              color: filter === "investor_alerts" ? "#c4b5fd" : "#6E867D",
              border: filter === "investor_alerts" ? "1px solid rgba(167,139,250,0.22)" : "1px solid transparent",
              cursor: "pointer",
            },
          }, "Investor" + (investorAlertsCount > 0 ? " (" + investorAlertsCount + ")" : "")),
        ),
        // List
        h("div", { style: { overflowY: "auto", maxHeight: "360px" } },
          filteredNotifications.length === 0
            ? h("div", { style: { padding: "32px 16px", textAlign: "center" } },
                h("p", { style: { fontSize: "13px", color: "#4b5563" } },
                  filter === "trade_alerts" ? "No trader alerts"
                    : filter === "investor_alerts" ? "No investor signals"
                    : "No model actions yet"),
              )
            : filteredNotifications.map(n =>
                h("div", {
                  key: n.id,
                  onClick: () => handleClick(n),
                  style: {
                    display: "flex", alignItems: "flex-start", gap: "10px", padding: "12px 16px",
                    cursor: "pointer",
                    background: n.read_at ? "transparent" : "rgba(56,242,161,0.04)",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    transition: "background 0.15s",
                  },
                  onMouseEnter: (e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = n.read_at ? "transparent" : "rgba(56,242,161,0.04)"; },
                },
                  // Type indicator dot
                  h("div", {
                    style: {
                      width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0, marginTop: "6px",
                      background: typeColors[n.type] || "#6E867D",
                    },
                  }),
                  h("div", { style: { flex: 1, minWidth: 0 } },
                    (() => {
                      const scope = notifScope(n);
                      const action = notifActionChip(n);
                      const chips = [];
                      if (scope === "investor" || scope === "trader") {
                        chips.push(h("span", {
                          key: "scope",
                          style: {
                            display: "inline-block", fontSize: "8px", fontWeight: "800",
                            letterSpacing: "0.06em", textTransform: "uppercase",
                            padding: "2px 6px", borderRadius: "999px", marginRight: "5px",
                            color: scope === "investor" ? "#c4b5fd" : "#67e8f9",
                            background: scope === "investor" ? "rgba(167,139,250,0.12)" : "rgba(103,232,249,0.10)",
                            border: `1px solid ${scope === "investor" ? "rgba(167,139,250,0.30)" : "rgba(103,232,249,0.28)"}`,
                          },
                        }, scope === "investor" ? "INVESTOR" : "TRADER"));
                      }
                      chips.push(h("span", {
                        key: "action",
                        style: {
                          display: "inline-block", fontSize: "8px", fontWeight: "800",
                          letterSpacing: "0.06em", textTransform: "uppercase",
                          padding: "2px 6px", borderRadius: "999px", marginBottom: "4px",
                          color: action.color,
                          background: action.bg,
                          border: `1px solid ${action.border}`,
                        },
                      }, action.label));
                      return h("div", { style: { marginBottom: "4px" } }, chips);
                    })(),
                    h("div", {
                      style: {
                        fontSize: "12px", fontWeight: n.read_at ? "500" : "600",
                        color: n.read_at ? "#8AA39A" : "#E8F5EE", marginBottom: "2px",
                        lineHeight: "1.35",
                      },
                    }, cleanNotifTitle(n.title)),
                    n.body && h("div", {
                      style: { fontSize: "11px", color: "#6b7280", lineHeight: "1.4", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap" },
                    }, n.body),
                    (() => {
                      const stage = String(n?.kanban_stage || n?.meta?.kanban_stage || "").toLowerCase();
                      const VUI = window.TimedVerdictUI;
                      if (!stage || !VUI?.LifecycleStrip || !VUI.lifecycleFromStage) return null;
                      const hasPos = String(n?.type || "").toLowerCase().startsWith("trade_")
                        && String(n?.type || "").toLowerCase() !== "trade_entry";
                      return h(VUI.LifecycleStrip, { current: VUI.lifecycleFromStage(stage, hasPos) });
                    })(),
                    h("div", { style: { fontSize: "10px", color: "#374151", marginTop: "2px" } }, formatTime(n.created_at)),
                  ),
                  // Unread dot
                  !n.read_at && h("div", {
                    style: { width: "6px", height: "6px", borderRadius: "50%", background: "#38F2A1", flexShrink: 0, marginTop: "7px" },
                  }),
                ),
              ),
        ),
        // "View All Alerts" footer link
        h("a", {
          href: "/alerts.html",
          style: {
            display: "block", textAlign: "center", padding: "10px 16px",
            borderTop: "1px solid rgba(255,255,255,0.06)", fontSize: "12px",
            fontWeight: "500", color: "#14b8a6", textDecoration: "none",
            transition: "background 0.15s",
          },
          onMouseEnter: (e) => { e.currentTarget.style.background = "rgba(20,184,166,0.06)"; },
          onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
        }, "View All Alerts \u2192"),
      ),
      // Notification Detail Modal — rendered via portal to document.body
      // so it's not clipped by parent overflow/transform/backdrop-filter.
      modal && ReactDOM.createPortal(modal, document.body),
    );
  }

  // ── VIP Admin Panel ──────────────────────────────────────────────────────
  // Modal panel for managing users (admin-only). Fetches from GET /timed/admin/users
  // and allows Set VIP, Revoke, Set Admin actions.
  function VIPAdminPanel({ apiBase, onClose }) {
    const h = React.createElement;
    const [users, setUsers] = React.useState([]);
    const [loading, setLoading] = React.useState(true);
    const [filter, setFilter] = React.useState("");
    const [actionLoading, setActionLoading] = React.useState(null);
    const [message, setMessage] = React.useState(null);

    const fetchUsers = React.useCallback(async () => {
      setLoading(true);
      try {
        const res = await fetch(`${apiBase}/timed/admin/users`, { credentials: "include" });
        if (res.ok) {
          const json = await res.json();
          if (json.ok) setUsers(json.users || []);
        }
      } catch {} finally { setLoading(false); }
    }, [apiBase]);

    React.useEffect(() => { fetchUsers(); }, [fetchUsers]);

    const setTier = async (email, tier, expiresAt) => {
      setActionLoading(email);
      setMessage(null);
      try {
        const params = new URLSearchParams({ tier });
        if (expiresAt) params.set("expires_at", expiresAt);
        const res = await fetch(`${apiBase}/timed/admin/users/${encodeURIComponent(email)}/tier?${params}`, {
          method: "POST", credentials: "include",
        });
        const json = await res.json();
        if (json.ok) {
          setMessage({ type: "success", text: `${email} → ${tier}` });
          fetchUsers();
        } else {
          setMessage({ type: "error", text: json.error || "Failed" });
        }
      } catch (e) {
        setMessage({ type: "error", text: String(e.message || e) });
      } finally { setActionLoading(null); }
    };

    const filtered = users.filter(u =>
      !filter || (u.email || "").toLowerCase().includes(filter.toLowerCase())
      || (u.display_name || "").toLowerCase().includes(filter.toLowerCase())
    );

    const formatDate = (ts) => {
      if (!ts) return "—";
      return new Date(ts).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
    };

    const tierBadge = (tier) => {
      const colors = { admin: "#a78bfa", pro: "#00c853", free: "#6b7280" };
      return h("span", {
        style: {
          display: "inline-block", padding: "2px 8px", borderRadius: "4px", fontSize: "11px",
          fontWeight: "600", color: colors[tier] || "#6b7280",
          background: `${colors[tier] || "#6b7280"}15`, border: `1px solid ${colors[tier] || "#6b7280"}30`,
        },
      }, (tier || "free").toUpperCase());
    };

    return h("div", {
      style: {
        position: "fixed", inset: 0, zIndex: 50000, display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)",
      },
      onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
    },
      h("div", {
        style: {
          width: "90%", maxWidth: "900px", maxHeight: "85vh", background: "#141720",
          border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px",
          display: "flex", flexDirection: "column", overflow: "hidden",
        },
      },
        // Header
        h("div", {
          style: {
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)",
          },
        },
          h("div", null,
            h("h2", { style: { fontSize: "16px", fontWeight: "700", color: "#e5e7eb", margin: 0 } }, "VIP Admin Panel"),
            h("p", { style: { fontSize: "12px", color: "#6b7280", margin: "4px 0 0" } },
              `${users.length} users total`),
          ),
          h("button", {
            onClick: onClose,
            style: { background: "none", border: "none", cursor: "pointer", fontSize: "18px", color: "#6b7280", padding: "4px" },
          }, "\u2715"),
        ),
        // Search
        h("div", { style: { padding: "12px 20px", borderBottom: "1px solid rgba(255,255,255,0.04)" } },
          h("input", {
            type: "text", placeholder: "Search by email or name...",
            value: filter, onChange: (e) => setFilter(e.target.value),
            style: {
              width: "100%", padding: "8px 12px", borderRadius: "8px", fontSize: "13px",
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
              color: "#e5e7eb", outline: "none",
            },
          }),
          message && h("div", {
            style: {
              marginTop: "8px", padding: "6px 12px", borderRadius: "6px", fontSize: "12px",
              color: message.type === "success" ? "#00c853" : "#ff5252",
              background: message.type === "success" ? "rgba(0,200,83,0.08)" : "rgba(255,82,82,0.08)",
            },
          }, message.text),
        ),
        // Table
        h("div", { style: { overflowY: "auto", flex: 1, padding: "0 20px 20px" } },
          loading
            ? h("div", { style: { textAlign: "center", padding: "40px", color: "#6b7280" } }, "Loading users...")
            : h("table", {
                style: { width: "100%", borderCollapse: "collapse", fontSize: "12px" },
              },
                h("thead", null,
                  h("tr", { style: { borderBottom: "1px solid rgba(255,255,255,0.06)" } },
                    ["Email", "Name", "Tier", "Sub Status", "Last Login", "Created", "Actions"].map(col =>
                      h("th", {
                        key: col,
                        style: { padding: "8px 6px", textAlign: "left", color: "#6b7280", fontWeight: "600", fontSize: "11px", whiteSpace: "nowrap" },
                      }, col),
                    ),
                  ),
                ),
                h("tbody", null,
                  filtered.map(u =>
                    h("tr", {
                      key: u.email,
                      style: { borderBottom: "1px solid rgba(255,255,255,0.03)" },
                    },
                      h("td", { style: { padding: "8px 6px", color: "#e5e7eb", maxWidth: "200px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, u.email),
                      h("td", { style: { padding: "8px 6px", color: "#9ca3af" } }, u.display_name || "—"),
                      h("td", { style: { padding: "8px 6px" } }, tierBadge(u.tier)),
                      h("td", { style: { padding: "8px 6px", color: "#6b7280" } }, u.subscription_status || "none"),
                      h("td", { style: { padding: "8px 6px", color: "#6b7280", whiteSpace: "nowrap" } }, formatDate(u.last_login_at)),
                      h("td", { style: { padding: "8px 6px", color: "#6b7280", whiteSpace: "nowrap" } }, formatDate(u.created_at)),
                      h("td", { style: { padding: "8px 6px", whiteSpace: "nowrap" } },
                        h("div", { style: { display: "flex", gap: "4px" } },
                          u.tier !== "vip" && u.tier !== "pro" && h("button", {
                            onClick: () => setTier(u.email, "vip", null),
                            disabled: actionLoading === u.email,
                            style: {
                              padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "600",
                              background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.2)",
                              color: "#fbbf24", cursor: "pointer",
                            },
                          }, "Set VIP"),
                          u.tier !== "free" && h("button", {
                            onClick: () => setTier(u.email, "free", String(Date.now())),
                            disabled: actionLoading === u.email,
                            style: {
                              padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "600",
                              background: "rgba(255,82,82,0.1)", border: "1px solid rgba(255,82,82,0.2)",
                              color: "#ff5252", cursor: "pointer",
                            },
                          }, "Revoke"),
                          u.tier !== "admin" && u.role !== "admin" && h("button", {
                            onClick: () => setTier(u.email, "admin", null),
                            disabled: actionLoading === u.email,
                            style: {
                              padding: "3px 8px", borderRadius: "4px", fontSize: "10px", fontWeight: "600",
                              background: "rgba(167,139,250,0.1)", border: "1px solid rgba(167,139,250,0.2)",
                              color: "#a78bfa", cursor: "pointer",
                            },
                          }, "Set Admin"),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
        ),
      ),
    );
  }

  // ── Push Notification Registration ──────────────────────────────────────
  // Register service worker and request push subscription.
  // Called on page load after auth. Progressive: prompts after 3rd visit,
  // but re-tries if a previous attempt failed (no active subscription).
  // CRITICAL: This function must NEVER throw — any error crashes the React tree.
  async function registerPushNotifications(apiBase) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const reg = await navigator.serviceWorker.register("/service-worker.js");
      const vapidKey = window.__TIMED_VAPID_PUBLIC_KEY;
      if (!vapidKey) { console.warn("[PUSH] No VAPID public key configured"); return; }

      // Helper: send subscription to backend (fire-and-forget, never throws)
      const syncSubscription = (subJson) => {
        try {
          const payload = { endpoint: subJson.endpoint, keys: subJson.keys };
          fetch(`${apiBase}/timed/push/subscribe`, {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          }).then(async (r) => {
            if (r.ok) console.log("[PUSH] Subscription synced to backend");
            else {
              const body = await r.text().catch(() => "");
              console.warn("[PUSH] Backend returned", r.status, body,
                "payload:", JSON.stringify({ endpoint: (payload.endpoint || "").slice(0, 60), hasKeys: !!payload.keys, p256dh: !!(payload.keys?.p256dh), auth: !!(payload.keys?.auth) }));
            }
          }).catch(e => console.warn("[PUSH] Sync failed:", e));
        } catch (_) {}
      };

      // Check if we already have an active push subscription
      const existingSub = await reg.pushManager.getSubscription();
      if (existingSub) {
        const subJson = existingSub.toJSON();
        // Validate the subscription has proper keys (old subscriptions
        // created before VAPID was configured may lack p256dh/auth)
        if (subJson.keys?.p256dh && subJson.keys?.auth) {
          syncSubscription(subJson);
          return;
        }
        // Stale subscription without keys — unsubscribe and re-create below
        console.log("[PUSH] Stale subscription (missing keys), re-subscribing...");
        await existingSub.unsubscribe().catch(() => {});
      }

      // No subscription yet. Check if we should prompt.
      const permission = Notification.permission;
      if (permission === "denied") return; // User blocked — don't nag

      if (permission === "granted") {
        // Permission was granted before but no subscription (e.g. VAPID key
        // wasn't set yet on a previous attempt). Subscribe now.
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey,
        });
        syncSubscription(sub.toJSON());
        console.log("[PUSH] Subscribed (permission was already granted)");
        return;
      }

      // Permission is "default" — need to ask. Wait until 3rd page visit.
      const visits = Number(localStorage.getItem("tt_visit_count") || 0) + 1;
      localStorage.setItem("tt_visit_count", String(visits));
      if (visits < 3) return;

      const result = await Notification.requestPermission();
      if (result !== "granted") return;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });
      syncSubscription(sub.toJSON());
      console.log("[PUSH] Subscribed (new permission grant)");
    } catch (e) {
      console.warn("[PUSH] Registration failed:", e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Waitlist CTA Button + Modal (replaces Discord Connect pre-launch)
  //
  // Rationale: with a small user base, Discord would be a lonely room.
  // Instead show a "Join Waitlist" CTA that captures email for launch
  // notifications. POSTs to /timed/waitlist/join (D1-backed).
  // ═══════════════════════════════════════════════════════════════════

  function WaitlistButton({ apiBase }) {
    const h = React.createElement;
    const [open, setOpen] = React.useState(false);
    const [email, setEmail] = React.useState("");
    const [loading, setLoading] = React.useState(false);
    const [success, setSuccess] = React.useState(false);
    const [error, setError] = React.useState(null);
    const btnRef = React.useRef(null);
    const inputRef = React.useRef(null);

    // Pre-fill from stored session if we have one
    React.useEffect(() => {
      try {
        const session = getStoredSession();
        if (session?.email) setEmail(session.email);
      } catch {}
    }, []);

    // Persisted "already joined" state so the button shows "You're in" on return
    const [joined, setJoined] = React.useState(() => {
      try { return localStorage.getItem("tt_waitlist_joined") === "1" || localStorage.getItem("tt_discord_linked") === "1"; } catch { return false; }
    });

    // 2026-06-05 — Capture the Discord link result from BOTH flows:
    //   • popup: callback posts {type:'discord-connected'} to window.opener
    //   • same-tab: callback redirects back with ?discord=linked
    React.useEffect(() => {
      const markLinked = () => {
        setJoined(true); setSuccess(true); setError(null);
        try { localStorage.setItem("tt_discord_linked", "1"); } catch {}
      };
      const onMsg = (e) => {
        const t = e?.data?.type;
        if (t === "discord-connected") markLinked();
        else if (t === "discord-error") setError("Discord linking failed — try again.");
      };
      window.addEventListener("message", onMsg);
      try {
        const params = new URLSearchParams(window.location.search || "");
        const d = params.get("discord");
        if (d === "linked") {
          markLinked(); setOpen(true);
          params.delete("discord"); params.delete("reason");
          const qs = params.toString();
          window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
        } else if (d === "error") {
          setError("Discord linking failed — try again."); setOpen(true);
          params.delete("discord"); params.delete("reason");
          const qs = params.toString();
          window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash);
        }
      } catch (_) {}
      // 2026-06-05 — Cross-device truth: the linked state lives on the account
      // (users.discord_id), not localStorage, so a second browser/Mac shows
      // "Link Discord" even when already linked. Ask the server.
      (async () => {
        try {
          const r = await fetch(`${apiBase}/timed/discord/status`, { credentials: "include" });
          const j = await r.json().catch(() => null);
          if (j?.ok && j.connected) {
            setJoined(true);
            try { localStorage.setItem("tt_discord_linked", "1"); } catch {}
          }
        } catch (_) {}
      })();
      return () => window.removeEventListener("message", onMsg);
    }, []);

    // Click outside to close
    React.useEffect(() => {
      if (!open) return;
      const handler = (e) => {
        if (btnRef.current && !btnRef.current.contains(e.target)) setOpen(false);
      };
      document.addEventListener("mousedown", handler);
      // Focus the email input when the panel opens
      setTimeout(() => { try { inputRef.current?.focus(); } catch {} }, 40);
      return () => document.removeEventListener("mousedown", handler);
    }, [open]);

    const handleSubmit = async (e) => {
      if (e?.preventDefault) e.preventDefault();
      const clean = String(email || "").trim().toLowerCase();
      if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(clean)) {
        setError("Enter a valid email");
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const source = (window.location?.pathname || "").replace(/^\//, "").replace(/\.html$/, "") || "app";
        const res = await fetch(`${apiBase}/timed/waitlist/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ email: clean, source, referrer: document.referrer || "" }),
        });
        const json = await res.json().catch(() => ({}));
        if (json?.ok) {
          setSuccess(true);
          setJoined(true);
          try { localStorage.setItem("tt_waitlist_joined", "1"); localStorage.setItem("tt_waitlist_email", clean); } catch {}
        } else {
          setError(json?.error === "invalid_email" ? "Enter a valid email" : "Could not save your spot — try again");
        }
      } catch (_) {
        setError("Network error — try again");
      }
      setLoading(false);
    };

    const panelStyle = {
      position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 1000,
      width: 340, background: "#0d1117", border: "1px solid rgba(245,158,11,0.35)",
      borderRadius: 12, boxShadow: "0 10px 34px rgba(0,0,0,.55)",
      padding: "18px", color: "#e5e7eb",
    };

    const buttonBg = joined
      ? "linear-gradient(135deg, rgba(52,211,153,0.18), rgba(16,185,129,0.12))"
      : "linear-gradient(135deg, rgba(245,158,11,0.22), rgba(234,88,12,0.18))";
    const buttonBorder = joined
      ? "1px solid rgba(52,211,153,0.4)"
      : "1px solid rgba(245,158,11,0.45)";
    const buttonColor = joined ? "#6ee7b7" : "#fbbf24";

    return h("div", { ref: btnRef, style: { position: "relative" } },
      h("button", {
        onClick: () => { setOpen(v => !v); if (!open) { setSuccess(false); setError(null); } },
        title: joined ? "You're on the waitlist" : "Join the waitlist",
        style: {
          background: buttonBg,
          border: buttonBorder,
          cursor: "pointer",
          padding: "5px 11px",
          color: buttonColor,
          fontSize: 12,
          fontWeight: 600,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          borderRadius: 8,
          letterSpacing: "0.01em",
          transition: "transform .15s, filter .15s",
        },
        onMouseEnter: (e) => { e.currentTarget.style.filter = "brightness(1.12)"; e.currentTarget.style.transform = "translateY(-1px)"; },
        onMouseLeave: (e) => { e.currentTarget.style.filter = ""; e.currentTarget.style.transform = ""; },
      },
        h("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2.5", strokeLinecap: "round", strokeLinejoin: "round" },
          joined
            ? h("polyline", { points: "20 6 9 17 4 12" })
            : h(React.Fragment, null,
                h("path", { d: "M22 2L11 13" }),
                h("polygon", { points: "22 2 15 22 11 13 2 9 22 2" }),
              ),
        ),
        /* 2026-06-01 — Button label changed from "Discord Waitlist"
           → "Link Discord" now that the OAuth + auto-add-to-server
           flow is open to all signed-in members. Operator: "Lets also
           open up Discord Access, so the UI should now say link
           Discord and that should kick off the user add flow with the
           welcome email to discord." */
        // 2026-05-04 — Wrapped in span so mobile CSS can icon-collapse the label.
        h("span", { className: "tt-waitlist-label" }, joined ? "Discord linked" : "Link Discord"),
      ),
      open && h("div", { style: panelStyle },
        h("div", { style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 10 } },
          h("div", { style: { width: 30, height: 30, borderRadius: 8, background: "linear-gradient(135deg, #5865F2, #404eed)", display: "flex", alignItems: "center", justifyContent: "center" } },
            h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "white" },
              h("path", { d: "M20.317 4.369A19.79 19.79 0 0 0 16.558 3a14.86 14.86 0 0 0-.68 1.39 18.27 18.27 0 0 0-5.487 0A14.86 14.86 0 0 0 9.71 3 19.79 19.79 0 0 0 5.952 4.369C2.49 9.524 1.555 14.55 2.023 19.5a19.9 19.9 0 0 0 6.072 3.063 14.6 14.6 0 0 0 1.224-1.96 12.94 12.94 0 0 1-1.926-.917c.161-.118.319-.241.471-.366a14.21 14.21 0 0 0 12.262 0c.155.125.313.248.471.366-.612.36-1.262.673-1.93.92.36.682.77 1.34 1.227 1.964a19.9 19.9 0 0 0 6.073-3.063c.55-5.736-.937-10.717-3.939-15.137zM8.02 16.49c-1.183 0-2.157-1.085-2.157-2.42 0-1.333.954-2.42 2.157-2.42 1.21 0 2.18 1.092 2.157 2.42 0 1.335-.954 2.42-2.157 2.42zm7.974 0c-1.184 0-2.157-1.085-2.157-2.42 0-1.333.954-2.42 2.157-2.42 1.21 0 2.18 1.092 2.157 2.42 0 1.335-.948 2.42-2.157 2.42z" }),
            ),
          ),
          h("div", null,
            h("div", { style: { fontWeight: 700, fontSize: 14 } }, success || joined ? "Discord linked" : "Link your Discord"),
            h("div", { style: { fontSize: 11, color: "#9ca3af", marginTop: 1 } }, success || joined ? "You're in the Timed Trading server." : "One click — sign in, get added, jump straight in."),
          ),
        ),
        success || joined ? h("div", null,
          h("div", { style: { fontSize: 12, color: "#d1d5db", lineHeight: 1.55, marginTop: 6, padding: "10px 12px", background: "rgba(88,101,242,0.10)", border: "1px solid rgba(88,101,242,0.30)", borderRadius: 8 } },
            "You're in the Timed Trading Discord. Check your inbox for the welcome email with the community rules and channel guide.",
          ),
          h("a", {
            href: "https://discord.com/app",
            target: "_blank",
            rel: "noopener noreferrer",
            style: { display: "block", textAlign: "center", marginTop: 12, padding: "10px 16px", borderRadius: 8, background: "#5865F2", color: "white", fontSize: 13, fontWeight: 700, textDecoration: "none" },
          }, "Open Discord →"),
          h("button", {
            onClick: () => setOpen(false),
            style: { marginTop: 8, width: "100%", padding: "8px 14px", borderRadius: 8, background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "#9ca3af", fontSize: 12, cursor: "pointer" },
          }, "Close"),
        ) : h("div", null,
          h("p", { style: { fontSize: 12, color: "#9ca3af", lineHeight: 1.55, margin: "8px 0 12px" } },
            "Click below to sign in with Discord. We'll add you to the Timed Trading server automatically and email you a quick guide with the community rules + which channel to start in.",
          ),
          /* 2026-06-01 — Single-click flow: hit /timed/discord/oauth-start
             to get the Discord OAuth URL, then redirect (or popup-window
             if signed-in via CF Access). The callback at
             /timed/discord/callback handles everything else: exchanges
             code for token, adds user to the guild with the subscriber
             role, sends the welcome email. */
          h("button", {
            onClick: async () => {
              setLoading(true); setError(null);
              try {
                const r = await fetch(`${apiBase}/timed/discord/oauth-start`, { credentials: "include" });
                const j = await r.json().catch(() => null);
                if (j?.ok && j.url) {
                  // Open in same tab — the callback responds with HTML that
                  // signals the parent window to refresh, but the simpler UX
                  // is just a direct navigation + return to the app.
                  window.location.href = j.url;
                } else if (j?.error === "auth_required") {
                  setError("Sign in first, then click Link Discord again.");
                } else {
                  setError(j?.error || "Could not start Discord linking");
                }
              } catch (_) {
                setError("Network error — try again");
              }
              setLoading(false);
            },
            disabled: loading,
            style: {
              marginTop: 0,
              width: "100%",
              padding: "11px 16px",
              borderRadius: 8,
              background: "#5865F2",
              color: "white",
              fontSize: 13,
              fontWeight: 700,
              border: "none",
              cursor: loading ? "wait" : "pointer",
              opacity: loading ? 0.7 : 1,
              letterSpacing: "0.01em",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            },
          },
            h("svg", { width: 16, height: 16, viewBox: "0 0 24 24", fill: "currentColor" },
              h("path", { d: "M20.317 4.369A19.79 19.79 0 0 0 16.558 3a14.86 14.86 0 0 0-.68 1.39 18.27 18.27 0 0 0-5.487 0A14.86 14.86 0 0 0 9.71 3 19.79 19.79 0 0 0 5.952 4.369C2.49 9.524 1.555 14.55 2.023 19.5a19.9 19.9 0 0 0 6.072 3.063 14.6 14.6 0 0 0 1.224-1.96 12.94 12.94 0 0 1-1.926-.917c.161-.118.319-.241.471-.366a14.21 14.21 0 0 0 12.262 0c.155.125.313.248.471.366-.612.36-1.262.673-1.93.92.36.682.77 1.34 1.227 1.964a19.9 19.9 0 0 0 6.073-3.063c.55-5.736-.937-10.717-3.939-15.137zM8.02 16.49c-1.183 0-2.157-1.085-2.157-2.42 0-1.333.954-2.42 2.157-2.42 1.21 0 2.18 1.092 2.157 2.42 0 1.335-.954 2.42-2.157 2.42zm7.974 0c-1.184 0-2.157-1.085-2.157-2.42 0-1.333.954-2.42 2.157-2.42 1.21 0 2.18 1.092 2.157 2.42 0 1.335-.948 2.42-2.157 2.42z" }),
            ),
            loading ? "Opening…" : "Link with Discord",
          ),
          error && h("div", { style: { fontSize: 11.5, color: "#fca5a5", marginTop: 8 } }, error),
          h("div", { style: { fontSize: 10, color: "#6b7280", marginTop: 10, lineHeight: 1.5 } },
            "By linking, you agree to be respectful, no spam or promotion, maintain integrity, and keep discussion on markets. Full rules in the welcome email.",
          ),
        ),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Session Heartbeat
  // ═══════════════════════════════════════════════════════════════════

  let _heartbeatCleanup = null;
  function startSessionHeartbeat(apiBase) {
    if (_heartbeatCleanup) return _heartbeatCleanup;
    let sessionId = null;
    try { sessionId = sessionStorage.getItem("tt_session_id"); } catch {}
    if (!sessionId) {
      sessionId = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      try { sessionStorage.setItem("tt_session_id", sessionId); } catch {}
    }

    const sendHeartbeat = () => {
      try {
        const body = JSON.stringify({
          session_id: sessionId,
          screen_width: window.screen?.width || window.innerWidth,
          path: window.location.pathname,
        });
        // fetch+credentials is required so CF Access cookies reach the worker.
        // sendBeacon omits credentials on cross-origin and is unreliable for auth.
        fetch(`${apiBase}/timed/session/heartbeat`, {
          method: "POST",
          body,
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          keepalive: true,
        }).catch(() => {});
      } catch {}
    };

    sendHeartbeat();
    const intervalId = setInterval(sendHeartbeat, 60000);
    _heartbeatCleanup = () => {
      clearInterval(intervalId);
      _heartbeatCleanup = null;
    };
    return _heartbeatCleanup;
  }

  // Export to window
  window.TimedAuthGate = AuthGate;
  window.TimedUserBadge = UserBadge;
  window.TimedNotificationCenter = NotificationCenter;
  window.TimedWaitlistButton = WaitlistButton;
  // Backwards compat: existing pages still reference TimedDiscordButton.
  // Render the waitlist CTA in its place until those references are
  // updated (or removed) in a future pass.
  window.TimedDiscordButton = WaitlistButton;
  window.TimedVIPAdminPanel = VIPAdminPanel;
  window.TimedSessionHeartbeat = startSessionHeartbeat;
  window.TimedAuthHelpers = {
    getStoredSession,
    storeSession,
    clearSession,
    getStoredBootstrap,
    storeBootstrap,
    clearBootstrap,
  };
  window.TimedPushRegister = registerPushNotifications;
})();

// cache-bust:1783310386864:790790195
