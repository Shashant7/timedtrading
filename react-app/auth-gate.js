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

  const { useState, useEffect, useCallback } = React;

  const STORAGE_KEY = "timed_auth_session";
  const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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

    // Chart icon SVG for logo
    const chartIcon = h("svg", { width: "36", height: "36", viewBox: "0 0 24 24", fill: "none", stroke: "white", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
      h("polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17" }),
      h("polyline", { points: "16 7 22 7 22 13" }),
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
          h("div", { style: { width: "72px", height: "72px", borderRadius: "20px", background: "linear-gradient(135deg, #00c853 0%, #00e676 50%, #69f0ae 100%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px", animation: "tt-glow 4s ease-in-out infinite" } }, chartIcon),
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
            href: "index-react.html",
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
          "Go to Dashboard",
        ),
      ),
    );
  }

  // ── Paywall Screen ────────────────────────────────────────────────────────
  // Shown when user.tier === "free" and no active subscription.
  // Offers Timed Trading Pro subscription with first month free trial.
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
            success_url: window.location.origin + "/index-react.html?stripe=success",
            cancel_url: window.location.origin + "/index-react.html?stripe=cancel",
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
      "Freshly updated model scoring (8 TFs, 200+ tickers)",
      "Kanban pipeline with automated trade signals",
      "Daily AI-powered morning & evening briefs",
      "Active Trader trade management (entry, trim, defend, exit)",
      "Investor: TT Simulated Portfolio with DCA automation",
      "Browser push & in-app notifications",
      "Full historical trail & time travel replay",
    ];

    return h("div", {
      style: {
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        background: "#0b0e11", fontFamily: font,
      },
    },
      h("div", { style: { width: "100%", maxWidth: "480px", padding: "40px", textAlign: "center" } },
        // Logo
        h("div", { style: { marginBottom: "24px" } },
          h("img", { src: "/logo.svg", alt: "Timed Trading", style: { height: "40px", opacity: 0.9 } }),
        ),
        // Badge
        h("span", {
          style: {
            display: "inline-block", padding: "4px 12px", borderRadius: "20px", fontSize: "11px",
            fontWeight: "600", color: "#00c853", background: "rgba(0,200,83,0.1)",
            border: "1px solid rgba(0,200,83,0.2)", marginBottom: "16px", letterSpacing: "0.5px",
          },
        }, "FIRST MONTH FREE"),
        // Title
        h("h1", { style: { fontSize: "24px", fontWeight: "700", color: "#e5e7eb", margin: "0 0 8px" } },
          "Timed Trading Pro"),
        h("p", { style: { fontSize: "32px", fontWeight: "800", color: "#ffffff", margin: "0 0 4px" } },
          "$60", h("span", { style: { fontSize: "16px", color: "#6b7280", fontWeight: "400" } }, "/month")),
        h("p", { style: { fontSize: "13px", color: "#6b7280", margin: "0 0 24px" } },
          "Cancel anytime. No refunds. Charged monthly after trial."),
        // Features
        h("div", {
          style: {
            textAlign: "left", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: "12px", padding: "20px", marginBottom: "24px",
          },
        },
          ...features.map((f) =>
            h("div", { key: f, style: { display: "flex", alignItems: "flex-start", gap: "10px", marginBottom: "10px" } },
              h("span", { style: { color: "#00c853", fontSize: "14px", lineHeight: "20px", flexShrink: 0 } }, "\u2713"),
              h("span", { style: { fontSize: "13px", color: "#9ca3af", lineHeight: "20px" } }, f),
            ),
          ),
        ),
        // CTA Button
        h("button", {
          onClick: handleStartTrial,
          disabled: loading,
          style: {
            width: "100%", padding: "14px 24px", borderRadius: "10px", fontSize: "15px", fontWeight: "600",
            color: "#fff", background: loading ? "#374151" : "linear-gradient(135deg, #00c853, #00a844)",
            border: "none", cursor: loading ? "wait" : "pointer", transition: "all 0.15s",
          },
        }, loading ? "Redirecting to Stripe..." : "Start Free Trial"),
        // Error
        error && h("p", { style: { color: "#ff5252", fontSize: "13px", marginTop: "12px" } }, error),
        // Signed in info
        h("p", { style: { fontSize: "12px", color: "#374151", marginTop: "16px" } },
          "Signed in as ", h("span", { style: { color: "#6b7280" } }, user?.email || "Unknown")),
        h("a", {
          href: "/splash.html",
          style: { fontSize: "12px", color: "#4b5563", textDecoration: "underline", display: "inline-block", marginTop: "8px" },
        }, "Back to home"),
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

    const chartIcon = h("svg", { width: "36", height: "36", viewBox: "0 0 24 24", fill: "none", stroke: "white", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
      h("polyline", { points: "22 7 13.5 15.5 8.5 10.5 2 17" }),
      h("polyline", { points: "16 7 22 7 22 13" }),
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
          h("div", { style: { width: "64px", height: "64px", borderRadius: "18px", background: "linear-gradient(135deg, #00c853 0%, #00e676 50%, #69f0ae 100%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", animation: "tt-glow 4s ease-in-out infinite" } }, chartIcon),
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
    const [state, setState] = useState("checking"); // checking | authenticated | unauthenticated
    const [user, setUser] = useState(null);
    const [error, setError] = useState(null);
    const [serverVerified, setServerVerified] = useState(false); // true only after /timed/me confirms auth
    const [stripeActivating, setStripeActivating] = useState(false); // true when waiting for Stripe webhook

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
            if (json.ok && json.authenticated && json.user) {
              const session = storeSession(json.user);
              setUser(session);
              setState("authenticated");
              setServerVerified(true);
              return;
            }
          }
          // Not authenticated
          clearSession();
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
        // Background refresh to update last_login_at on backend + sync tier
        verifyAuth(false).catch(() => {});
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
      const maxAttempts = 15; // 15 * 2s = 30s max wait

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
                  // Clean up ?stripe=success from URL
                  const cleanUrl = new URL(window.location.href);
                  cleanUrl.searchParams.delete("stripe");
                  window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search);
                  return;
                }
              }
            }
          } catch { /* retry */ }
        }
        // Timeout: webhook may be slow, show message
        setStripeActivating(false);
        // Force one more refresh
        verifyAuth(false).catch(() => {});
      };
      poll();
      return () => { cancelled = true; };
    }, [user, apiBase, verifyAuth]);

    const handleLogin = useCallback(() => {
      // Force CF Access re-authentication flow:
      // 1. Clear localStorage session so stale cached data can't bypass auth.
      // 2. Clear CF_Authorization cookie client-side (may not work if HttpOnly).
      // 3. Use hidden iframe to hit /cdn-cgi/access/logout which clears the
      //    HttpOnly CF_Authorization cookie server-side (Set-Cookie response).
      // 4. After iframe loads (cookie cleared), redirect to /index-react.html
      //    with a cache-buster query param. This forces a fresh server request
      //    that CF Access can intercept at the CDN level, showing the identity
      //    provider login page (Google SSO).
      //    NOTE: Never redirect to /cdn-cgi/access/login — it requires
      //    server-generated JWT params and breaks from client-side JS.
      clearSession();

      // Attempt client-side cookie deletion (handles non-HttpOnly cases)
      try {
        const d = window.location.hostname;
        document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
        document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=" + d;
        document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=." + d;
      } catch (_) {}

      // Use hidden iframe for server-side cookie clearing (handles HttpOnly)
      let redirected = false;
      const doRedirect = () => {
        if (redirected) return;
        redirected = true;
        // Cache-busted URL forces a fresh server request that CF Access intercepts
        window.location.href = "/index-react.html?_auth=" + Date.now();
      };
      try {
        const iframe = document.createElement("iframe");
        iframe.style.display = "none";
        iframe.onload = () => setTimeout(doRedirect, 300);
        iframe.onerror = () => doRedirect();
        iframe.src = window.location.origin + "/cdn-cgi/access/logout";
        document.body.appendChild(iframe);
      } catch (_) {
        doRedirect();
      }
      // Safety timeout: if iframe doesn't respond in 3 seconds, redirect anyway
      setTimeout(doRedirect, 3000);
    }, []);

    // Set user role on body for CSS-based admin gating of nav links
    // MUST be before any conditional returns to obey Rules of Hooks
    useEffect(() => {
      if (user) {
        document.body.dataset.userRole = (user.role === "admin" || user.tier === "admin") ? "admin" : (user.role || "member");
        document.body.dataset.userTier = user.tier || "free";
      }
    }, [user]);

    // Register push notifications once authenticated AND server-verified.
    // Placed here (before conditional returns) to obey Rules of Hooks.
    // Only fires after /timed/me confirms the session is valid server-side,
    // preventing 401s from stale cached sessions (e.g. after sign-out).
    // Fully wrapped in catch — must never crash the app.
    useEffect(() => {
      if (user && serverVerified) {
        try { registerPushNotifications(apiBase).catch(() => {}); } catch (_) {}
      }
    }, [user, serverVerified, apiBase]);

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
      // Show login screen so user can trigger Cloudflare Access SSO.
      // Previously this redirected to splash.html, but that caused a redirect
      // loop: splash → dashboard → unauthenticated → splash → ...
      return React.createElement(LoginScreen, {
        onRetry: handleLogin,
        error: error,
        loading: false,
      });
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
    if (requiredTier && user) {
      const effectiveTier = user.tier === "vip" ? "pro" : user.tier;
      const required = TIER_ORDER[requiredTier] ?? 0;
      const current = TIER_ORDER[effectiveTier] ?? 0;
      if (current < required) {
        // For pro-tier pages: show paywall if user is free with no active subscription
        if (requiredTier === "pro" && (effectiveTier === "free" || !effectiveTier)) {
          const subStatus = user.subscription_status;
          if (subStatus !== "trialing" && subStatus !== "active" && subStatus !== "manual") {
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
    if (user && !user.terms_accepted_at) {
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

    // Wrap app content with a global footer containing Terms link
    return React.createElement(React.Fragment, null,
      appContent,
      React.createElement("div", {
        style: {
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: "16px",
          padding: "6px 16px",
          background: "rgba(11,14,17,0.85)",
          backdropFilter: "blur(8px)",
          borderTop: "1px solid rgba(255,255,255,0.04)",
          zIndex: 9999,
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: "11px",
          pointerEvents: "auto",
        },
      },
        React.createElement("span", { style: { color: "#374151" } }, "\u00a9 2026 Timed Trading"),
        React.createElement("a", {
          href: "/terms.html",
          target: "_blank",
          rel: "noopener noreferrer",
          style: { color: "#4b5563", textDecoration: "none", borderBottom: "1px solid rgba(75,85,99,0.3)", transition: "color 0.2s" },
          onMouseEnter: (e) => { e.currentTarget.style.color = "#9ca3af"; },
          onMouseLeave: (e) => { e.currentTarget.style.color = "#4b5563"; },
        }, "Terms of Use"),
        React.createElement("span", { style: { color: "#1f2937" } }, "\u00b7"),
        React.createElement("a", {
          href: "/faq.html",
          target: "_blank",
          rel: "noopener noreferrer",
          style: { color: "#4b5563", textDecoration: "none", borderBottom: "1px solid rgba(75,85,99,0.3)", transition: "color 0.2s" },
          onMouseEnter: (e) => { e.currentTarget.style.color = "#9ca3af"; },
          onMouseLeave: (e) => { e.currentTarget.style.color = "#4b5563"; },
        }, "FAQ"),
        React.createElement("span", { style: { color: "#1f2937" } }, "\u00b7"),
        React.createElement("a", {
          href: "mailto:support@timed-trading.com",
          style: { color: "#4b5563", textDecoration: "none", borderBottom: "1px solid rgba(75,85,99,0.3)", transition: "color 0.2s" },
          onMouseEnter: (e) => { e.currentTarget.style.color = "#9ca3af"; },
          onMouseLeave: (e) => { e.currentTarget.style.color = "#4b5563"; },
        }, "Contact"),
        React.createElement("span", { style: { color: "#1f2937" } }, "\u00b7"),
        React.createElement("span", { style: { color: "#374151" } }, "Not financial advice"),
      ),
    );
  }

  // ── User Badge (for nav bars) ────────────────────────────────────────────
  function UserBadge({ user, compact }) {
    const [showMenu, setShowMenu] = useState(false);

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
      return React.createElement(
        "div",
        { style: { position: "relative" } },
        React.createElement(
          "button",
          {
            onClick: () => setShowMenu(!showMenu),
            style: {
              width: "28px",
              height: "28px",
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
                },
                onMouseEnter: (e) =>
                  (e.currentTarget.style.background = "rgba(239, 68, 68, 0.1)"),
                onMouseLeave: (e) =>
                  (e.currentTarget.style.background = "transparent"),
              },
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
    const [unreadCount, setUnreadCount] = React.useState(0);
    const [loading, setLoading] = React.useState(false);
    const [selectedNotification, setSelectedNotification] = React.useState(null); // modal
    const bellRef = React.useRef(null);

    // Type-to-icon color mapping
    const typeColors = {
      trade_entry: "#00c853",
      trade_exit: "#ff5252",
      trade_trim: "#ff9800",
      daily_brief: "#42a5f5",
      system: "#6b7280",
      kanban: "#a78bfa",
    };
    const typeLabels = {
      trade_entry: "Trade Entry",
      trade_exit: "Trade Exit",
      trade_trim: "Trade Trim/Defend",
      daily_brief: "Daily Brief",
      system: "System",
      kanban: "Kanban Update",
    };

    const fetchNotifications = React.useCallback(async () => {
      try {
        const res = await fetch(`${apiBase}/timed/notifications?limit=20`, { credentials: "include" });
        if (res.ok) {
          const json = await res.json();
          if (json.ok) {
            setNotifications(json.notifications || []);
            setUnreadCount(json.unread_count || 0);
          }
        }
      } catch {}
    }, [apiBase]);

    // Poll every 60s for new notifications
    React.useEffect(() => {
      fetchNotifications();
      const iv = setInterval(fetchNotifications, 60000);
      return () => clearInterval(iv);
    }, [fetchNotifications]);

    // Close dropdown on outside click (but not when modal is open)
    React.useEffect(() => {
      const handler = (e) => {
        if (selectedNotification) return; // modal handles its own clicks
        if (bellRef.current && !bellRef.current.contains(e.target)) setOpen(false);
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [selectedNotification]);

    const markAllRead = async () => {
      try {
        await fetch(`${apiBase}/timed/notifications/read`, {
          method: "POST", credentials: "include",
          headers: { "Content-Type": "application/json" }, body: "{}",
        });
        setUnreadCount(0);
        setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || Date.now() })));
      } catch {}
    };

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
      // Always open the detail modal — never navigate away on click.
      // If the notification has a link, it's shown as a button inside the modal.
      setSelectedNotification(n);
      setOpen(false);
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
          h("h3", { style: { fontSize: "16px", fontWeight: "700", color: "#e5e7eb", margin: "0 0 8px" } },
            selectedNotification.title),
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
            ? h("a", {
                href: selectedNotification.link,
                style: { fontSize: "12px", color: "#00c853", textDecoration: "none", fontWeight: "500" },
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
      // Bell button
      h("button", {
        onClick: () => { setOpen(!open); if (!open) fetchNotifications(); },
        style: {
          position: "relative", background: "none", border: "none", cursor: "pointer",
          padding: "4px 6px", borderRadius: "6px", display: "flex", alignItems: "center",
        },
        title: "Notifications",
      },
        h("svg", {
          width: "18", height: "18", viewBox: "0 0 24 24", fill: "none",
          stroke: unreadCount > 0 ? "#00c853" : "#6b7280", strokeWidth: "2",
          strokeLinecap: "round", strokeLinejoin: "round",
        },
          h("path", { d: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" }),
          h("path", { d: "M13.73 21a2 2 0 0 1-3.46 0" }),
        ),
        // Badge
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
          position: "absolute", top: "calc(100% + 8px)", right: "0", width: "340px", maxHeight: "420px",
          background: "#141720", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px",
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)", zIndex: 10000, overflow: "hidden",
          fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        },
      },
        // Header
        h("div", {
          style: {
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.06)",
          },
        },
          h("span", { style: { fontSize: "13px", fontWeight: "600", color: "#e5e7eb" } }, "Notifications"),
          h("div", { style: { display: "flex", gap: "8px" } },
            unreadCount > 0 && h("button", {
              onClick: markAllRead,
              style: { background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "#00c853" },
            }, "Mark All Read"),
            notifications.length > 0 && h("button", {
              onClick: clearAll,
              style: { background: "none", border: "none", cursor: "pointer", fontSize: "11px", color: "#6b7280" },
            }, "Clear All"),
          ),
        ),
        // List
        h("div", { style: { overflowY: "auto", maxHeight: "360px" } },
          notifications.length === 0
            ? h("div", { style: { padding: "32px 16px", textAlign: "center" } },
                h("p", { style: { fontSize: "13px", color: "#4b5563" } }, "No notifications yet"),
              )
            : notifications.map(n =>
                h("div", {
                  key: n.id,
                  onClick: () => handleClick(n),
                  style: {
                    display: "flex", alignItems: "flex-start", gap: "10px", padding: "10px 16px",
                    cursor: "pointer",
                    background: n.read_at ? "transparent" : "rgba(0,200,83,0.03)",
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    transition: "background 0.15s",
                  },
                  onMouseEnter: (e) => { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; },
                  onMouseLeave: (e) => { e.currentTarget.style.background = n.read_at ? "transparent" : "rgba(0,200,83,0.03)"; },
                },
                  // Type indicator dot
                  h("div", {
                    style: {
                      width: "8px", height: "8px", borderRadius: "50%", flexShrink: 0, marginTop: "5px",
                      background: typeColors[n.type] || "#6b7280",
                    },
                  }),
                  h("div", { style: { flex: 1, minWidth: 0 } },
                    h("div", {
                      style: {
                        fontSize: "12px", fontWeight: n.read_at ? "500" : "600",
                        color: n.read_at ? "#9ca3af" : "#e5e7eb", marginBottom: "2px",
                      },
                    }, n.title),
                    n.body && h("div", {
                      style: { fontSize: "11px", color: "#6b7280", lineHeight: "1.4", overflow: "hidden",
                        textOverflow: "ellipsis", whiteSpace: "nowrap" },
                    }, n.body),
                    h("div", { style: { fontSize: "10px", color: "#374151", marginTop: "2px" } }, formatTime(n.created_at)),
                  ),
                  // Unread dot
                  !n.read_at && h("div", {
                    style: { width: "6px", height: "6px", borderRadius: "50%", background: "#00c853", flexShrink: 0, marginTop: "6px" },
                  }),
                ),
              ),
        ),
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

  // Export to window
  window.TimedAuthGate = AuthGate;
  window.TimedUserBadge = UserBadge;
  window.TimedNotificationCenter = NotificationCenter;
  window.TimedVIPAdminPanel = VIPAdminPanel;
  window.TimedAuthHelpers = { getStoredSession, storeSession, clearSession };
  window.TimedPushRegister = registerPushNotifications;
})();
