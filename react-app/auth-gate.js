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
            maxWidth: "400px",
            padding: "40px",
            textAlign: "center",
          },
        },
        // Logo / Title
        React.createElement(
          "div",
          { style: { marginBottom: "40px" } },
          React.createElement(
            "div",
            {
              style: {
                width: "64px",
                height: "64px",
                borderRadius: "16px",
                background: "linear-gradient(135deg, #00c853 0%, #00e676 100%)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                margin: "0 auto 20px",
                boxShadow: "0 8px 32px rgba(0, 200, 83, 0.3)",
              },
            },
            React.createElement(
              "svg",
              {
                width: "32",
                height: "32",
                viewBox: "0 0 24 24",
                fill: "none",
                stroke: "white",
                strokeWidth: "2",
                strokeLinecap: "round",
                strokeLinejoin: "round",
              },
              React.createElement("polyline", {
                points: "22 7 13.5 15.5 8.5 10.5 2 17",
              }),
              React.createElement("polyline", {
                points: "16 7 22 7 22 13",
              }),
            ),
          ),
          React.createElement(
            "h1",
            {
              style: {
                fontSize: "24px",
                fontWeight: "700",
                color: "#e5e7eb",
                margin: "0 0 8px",
                letterSpacing: "-0.02em",
              },
            },
            "Timed Trading",
          ),
          React.createElement(
            "p",
            {
              style: {
                fontSize: "14px",
                color: "#6b7280",
                margin: "0",
              },
            },
            "Sign in to access your trading dashboard",
          ),
        ),
        // Login card
        React.createElement(
          "div",
          {
            style: {
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "16px",
              padding: "32px",
            },
          },
          error &&
            React.createElement(
              "div",
              {
                style: {
                  background: "rgba(255, 82, 82, 0.1)",
                  border: "1px solid rgba(255, 82, 82, 0.2)",
                  borderRadius: "8px",
                  padding: "12px",
                  marginBottom: "20px",
                  fontSize: "13px",
                  color: "#ff5252",
                },
              },
              error,
            ),
          // Google SSO button (triggers Cloudflare Access)
          React.createElement(
            "button",
            {
              onClick: onRetry,
              disabled: loading,
              style: {
                width: "100%",
                padding: "12px 20px",
                borderRadius: "10px",
                border: "1px solid rgba(255,255,255,0.1)",
                background: loading
                  ? "rgba(255,255,255,0.03)"
                  : "rgba(255,255,255,0.05)",
                color: loading ? "#6b7280" : "#e5e7eb",
                fontSize: "14px",
                fontWeight: "500",
                cursor: loading ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "10px",
                transition: "all 0.15s",
                fontFamily: "inherit",
              },
              onMouseEnter: (e) => {
                if (!loading) {
                  e.target.style.background = "rgba(255,255,255,0.08)";
                  e.target.style.borderColor = "rgba(255,255,255,0.15)";
                }
              },
              onMouseLeave: (e) => {
                e.target.style.background = loading
                  ? "rgba(255,255,255,0.03)"
                  : "rgba(255,255,255,0.05)";
                e.target.style.borderColor = "rgba(255,255,255,0.1)";
              },
            },
            // Google icon
            !loading &&
              React.createElement(
                "svg",
                { width: "18", height: "18", viewBox: "0 0 24 24" },
                React.createElement("path", {
                  d: "M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z",
                  fill: "#4285F4",
                }),
                React.createElement("path", {
                  d: "M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z",
                  fill: "#34A853",
                }),
                React.createElement("path", {
                  d: "M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z",
                  fill: "#FBBC05",
                }),
                React.createElement("path", {
                  d: "M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z",
                  fill: "#EA4335",
                }),
              ),
            loading
              ? React.createElement(
                  "span",
                  {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    },
                  },
                  React.createElement("span", {
                    style: {
                      width: "16px",
                      height: "16px",
                      border: "2px solid rgba(255,255,255,0.1)",
                      borderTopColor: "#00c853",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    },
                  }),
                  "Authenticating...",
                )
              : "Sign in with Google",
          ),
          // Divider
          React.createElement(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: "12px",
                margin: "20px 0",
              },
            },
            React.createElement("div", {
              style: {
                flex: 1,
                height: "1px",
                background: "rgba(255,255,255,0.06)",
              },
            }),
            React.createElement(
              "span",
              { style: { fontSize: "11px", color: "#4b5563" } },
              "Secured by Cloudflare Access",
            ),
            React.createElement("div", {
              style: {
                flex: 1,
                height: "1px",
                background: "rgba(255,255,255,0.06)",
              },
            }),
          ),
          React.createElement(
            "p",
            {
              style: {
                fontSize: "12px",
                color: "#4b5563",
                margin: "0",
                lineHeight: "1.5",
              },
            },
            "Your session will be remembered on this device for 7 days.",
          ),
        ),
      ),
    );
  }

  // ── Access Denied Screen ──────────────────────────────────────────────────
  function AccessDeniedScreen({ user, requiredTier }) {
    const tierLabels = { free: "Free", pro: "Pro", admin: "Admin" };
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
      // Reload the page — Cloudflare Access (on the Pages domain) will
      // intercept and redirect to Google SSO. After login, the page reloads
      // with a valid CF-Access-JWT-Assertion header on all requests.
      window.location.reload();
    }, []);

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

    // Authenticated (and tier-authorized) — render children with user context
    return typeof children === "function" ? children(user) : children;
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
      window.location.reload();
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
                  user.tier,
                ),
            ),
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
              "Sign out",
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
