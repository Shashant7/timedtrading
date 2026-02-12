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
          h("p", { style: { fontSize: "14px", color: "#6b7280", margin: "0", lineHeight: "1.5" } }, "Swing and position trading intelligence"),
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

          // Separator
          h("div", { style: { display: "flex", alignItems: "center", gap: "12px", margin: "20px 0" } },
            h("div", { style: { flex: 1, height: "1px", background: "rgba(255,255,255,0.06)" } }),
            h("span", { style: { fontSize: "11px", color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" } }, "or"),
            h("div", { style: { flex: 1, height: "1px", background: "rgba(255,255,255,0.06)" } }),
          ),

          // One-time login code button
          h("button", {
            onClick: onRetry, disabled: loading,
            style: { width: "100%", padding: "12px 20px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.06)", background: "transparent", color: "#9ca3af", fontSize: "13px", fontWeight: "500", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", transition: "all 0.2s", fontFamily: "inherit" },
            onMouseEnter: (e) => { if (!loading) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.color = "#d1d5db"; } },
            onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#9ca3af"; },
          },
            h("svg", { width: "16", height: "16", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" },
              h("rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }),
              h("polyline", { points: "3 7 12 13 21 7" }),
            ),
            "Sign in with email code",
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
    const tierLabels = { free: "Member", pro: "Pro", admin: "Admin" };
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

    const handleSignOut = () => {
      clearSession();
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = "https://timedtrading.cloudflareaccess.com/cdn-cgi/access/logout";
      document.body.appendChild(iframe);
      setTimeout(() => {
        try { document.body.removeChild(iframe); } catch {}
        window.location.href = "/splash.html";
      }, 1500);
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

    const TIER_ORDER = { free: 0, pro: 1, admin: 2 };

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
              return;
            }
          }
          // Not authenticated
          clearSession();
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

    const handleLogin = useCallback(() => {
      // Navigate to the exact path protected by Cloudflare Access.
      // CF Access policies are configured for specific paths WITH the .html
      // extension (e.g., /index-react.html). If the browser is on /index-react
      // (without .html), CF Access won't intercept and auth won't trigger.
      // Always redirect to the .html path to ensure CF Access kicks in.
      window.location.href = "/index-react.html";
    }, []);

    // Set user role on body for CSS-based admin gating of nav links
    // MUST be before any conditional returns to obey Rules of Hooks
    useEffect(() => {
      if (user) {
        document.body.dataset.userRole = (user.role === "admin" || user.tier === "admin") ? "admin" : (user.role || "member");
        document.body.dataset.userTier = user.tier || "free";
      }
    }, [user]);

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

    // Tier gating: if requiredTier is set, check the user has sufficient access
    if (requiredTier && user) {
      const required = TIER_ORDER[requiredTier] ?? 0;
      const current = TIER_ORDER[user.tier] ?? 0;
      if (current < required) {
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

    const handleLogout = () => {
      clearSession();
      // Clear the CF Access JWT cookie via a hidden iframe, then redirect
      // back to the splash page (public landing page).
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = "https://timedtrading.cloudflareaccess.com/cdn-cgi/access/logout";
      document.body.appendChild(iframe);
      // Give the iframe time to clear the cookie, then redirect to splash
      setTimeout(() => {
        try { document.body.removeChild(iframe); } catch {}
        window.location.href = "/splash.html";
      }, 1500);
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
                          : user.tier === "pro"
                            ? "rgba(0, 200, 83, 0.15)"
                            : "rgba(255,255,255,0.06)",
                      color:
                        user.tier === "admin"
                          ? "#a78bfa"
                          : user.tier === "pro"
                            ? "#00c853"
                            : "#6b7280",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    },
                  },
                  user.tier === "free" ? "MEMBER" : user.tier,
                ),
            ),
            // Switch Account button
            React.createElement(
              "button",
              {
                onClick: () => {
                  clearSession();
                  // Robustly clear CF Access session using both fetch and iframe,
                  // then redirect to the app. CF Access will intercept (no valid JWT)
                  // and show the "Sign in with: Google" page for a fresh OAuth flow.
                  // Google should then show the account chooser (if multiple accounts).
                  try {
                    fetch("https://timedtrading.cloudflareaccess.com/cdn-cgi/access/logout", {
                      credentials: "include",
                      mode: "no-cors",
                    }).catch(() => {});
                  } catch (_) {}
                  const iframe = document.createElement("iframe");
                  iframe.style.display = "none";
                  iframe.src = "https://timedtrading.cloudflareaccess.com/cdn-cgi/access/logout";
                  document.body.appendChild(iframe);
                  // Also attempt to clear the CF_Authorization cookie directly
                  try {
                    const domain = window.location.hostname;
                    document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
                    document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=" + domain + ";";
                    document.cookie = "CF_Authorization=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=." + domain + ";";
                  } catch (_) {}
                  // Wait 2s for logout to propagate, then redirect to app
                  // CF Access will intercept → show login page → user clicks Google → fresh OAuth
                  setTimeout(() => {
                    try { document.body.removeChild(iframe); } catch {}
                    window.location.href = "/index-react.html";
                  }, 2000);
                },
                style: {
                  width: "100%",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: "none",
                  background: "transparent",
                  color: "#9ca3af",
                  fontSize: "13px",
                  textAlign: "left",
                  cursor: "pointer",
                  fontFamily: "inherit",
                },
                onMouseEnter: (e) =>
                  (e.target.style.background = "rgba(255, 255, 255, 0.04)"),
                onMouseLeave: (e) =>
                  (e.target.style.background = "transparent"),
              },
              "Switch Account",
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
                  (e.target.style.background = "rgba(239, 68, 68, 0.1)"),
                onMouseLeave: (e) =>
                  (e.target.style.background = "transparent"),
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

  // Export to window
  window.TimedAuthGate = AuthGate;
  window.TimedUserBadge = UserBadge;
  window.TimedAuthHelpers = { getStoredSession, storeSession, clearSession };
})();
