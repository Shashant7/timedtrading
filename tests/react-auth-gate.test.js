// tests/react-auth-gate.test.js
//
// Regression tests for the auth-gate sign-in flow bug:
//
//   "When the access token expires, I see the sign in screen but
//    then I see the switch user screen and then the signed out
//    screen and then finally signed in."
//
// Root cause: when verifyAuth() got 401 in the background, it
// cleared localStorage via clearSession() but NEVER called
// setUser(null). React state still held the cached user object.
// On LoginScreen, clicking "Continue with Google" called
// handleLogin() which checked `!!user` — true (stale) — and routed
// through CASE A (switch-account flow) instead of CASE B (fresh
// SSO). The user got bounced through CF Access logout, the manual
// Google-sign-out card, and the signed-out card before finally
// landing back signed in.
//
// Fix: setUser(null) in both unauthenticated paths AND require
// `user && serverVerified` to route through switch-account.
//
// These tests pin both halves of the fix.
//
// @vitest-environment jsdom

import { describe, it, expect, beforeAll } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import React, { useState, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

/* Mirror the AuthGate routing logic exactly. If you change
   auth-gate.js handleLogin, update this mirror or the test will
   silently pass while production breaks. */
function decideLoginRoute({ user, serverVerified }) {
  const isReallyLoggedIn = !!user && serverVerified;
  return isReallyLoggedIn ? "/logout.html?switch=1" : "/today.html?_auth=NOW";
}

/* Mirror the verifyAuth(unauthenticated) state-clearing as a pure
   transformation, so we can assert that the user state goes to null
   when verifyAuth() sees a 401. */
function applyVerifyAuthResult({ prevUser, result }) {
  if (result.authenticated && result.user) {
    return { user: result.user, serverVerified: true, state: "authenticated" };
  }
  /* Critical: must clear React user state on 401 too. Previously this
     only cleared localStorage and React user remained set. */
  return { user: null, serverVerified: false, state: "unauthenticated" };
}

/* Tiny stand-in component that wires the two pieces together, so
   we can drive the bug scenario end-to-end via React rendering. */
function AuthGateLite({ initialUser = null, onRouteDecision }) {
  const [user, setUser] = useState(initialUser);
  const [serverVerified, setServerVerified] = useState(false);
  const [lastRoute, setLastRoute] = useState(null);

  const handleVerify = useCallback((result) => {
    const next = applyVerifyAuthResult({ prevUser: user, result });
    setUser(next.user);
    setServerVerified(next.serverVerified);
  }, [user]);

  const handleLogin = useCallback(() => {
    const route = decideLoginRoute({ user, serverVerified });
    setLastRoute(route);
    if (onRouteDecision) onRouteDecision(route);
  }, [user, serverVerified, onRouteDecision]);

  return React.createElement("div", null,
    React.createElement("div", { "data-testid": "user-state" }, user ? user.email : "null"),
    React.createElement("div", { "data-testid": "server-verified" }, String(serverVerified)),
    React.createElement("div", { "data-testid": "last-route" }, lastRoute || ""),
    React.createElement("button", {
      "data-testid": "trigger-401",
      onClick: () => handleVerify({ authenticated: false }),
    }, "trigger_401"),
    React.createElement("button", {
      "data-testid": "trigger-200",
      onClick: () => handleVerify({ authenticated: true, user: { email: "user@x.com" } }),
    }, "trigger_200"),
    React.createElement("button", {
      "data-testid": "sign-in",
      onClick: handleLogin,
    }, "sign_in"),
  );
}

describe("decideLoginRoute — switch-account vs fresh-SSO routing", () => {
  it("routes to fresh SSO (/today.html) when not server-verified", () => {
    expect(decideLoginRoute({ user: null, serverVerified: false }))
      .toBe("/today.html?_auth=NOW");
  });

  it("routes to fresh SSO even when user is set but NOT server-verified", () => {
    /* This is the bug scenario. A stale localStorage cache puts a
       user object in React state, but verifyAuth() set serverVerified
       to false on its 401. Must route through CASE B (fresh SSO). */
    expect(decideLoginRoute({ user: { email: "x@y.com" }, serverVerified: false }))
      .toBe("/today.html?_auth=NOW");
  });

  it("routes to switch-account only when both user AND serverVerified", () => {
    expect(decideLoginRoute({ user: { email: "x@y.com" }, serverVerified: true }))
      .toBe("/logout.html?switch=1");
  });

  it("never routes to switch-account when user is null", () => {
    expect(decideLoginRoute({ user: null, serverVerified: true }))
      .toBe("/today.html?_auth=NOW");
  });
});

describe("applyVerifyAuthResult — clears React user on 401", () => {
  it("clears user to null when server returns not-authenticated", () => {
    const result = applyVerifyAuthResult({
      prevUser: { email: "cached@x.com" },
      result: { authenticated: false },
    });
    expect(result.user).toBeNull();
    expect(result.serverVerified).toBe(false);
    expect(result.state).toBe("unauthenticated");
  });

  it("sets user when server returns authenticated", () => {
    const result = applyVerifyAuthResult({
      prevUser: null,
      result: { authenticated: true, user: { email: "fresh@x.com" } },
    });
    expect(result.user).toEqual({ email: "fresh@x.com" });
    expect(result.serverVerified).toBe(true);
    expect(result.state).toBe("authenticated");
  });
});

describe("AuthGate state machine — token-expiry recovery flow", () => {
  let container;
  let root;
  beforeAll(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  it("clears user state on background 401 (token expiry), then routes to fresh SSO not switch-account", () => {
    let lastRoute = null;
    act(() => {
      root.render(React.createElement(AuthGateLite, {
        initialUser: { email: "cached@x.com" },
        onRouteDecision: (r) => { lastRoute = r; },
      }));
    });
    /* Step 1: cached user is present (the localStorage path on first mount). */
    expect(container.querySelector('[data-testid=user-state]').textContent).toBe("cached@x.com");
    expect(container.querySelector('[data-testid=server-verified]').textContent).toBe("false");

    /* Step 2: background verifyAuth() returns 401. */
    act(() => {
      container.querySelector('[data-testid=trigger-401]').click();
    });
    expect(container.querySelector('[data-testid=user-state]').textContent).toBe("null");
    expect(container.querySelector('[data-testid=server-verified]').textContent).toBe("false");

    /* Step 3: user clicks "Continue with Google". MUST go to fresh
       SSO, NOT switch-account. */
    act(() => {
      container.querySelector('[data-testid=sign-in]').click();
    });
    expect(lastRoute).toBe("/today.html?_auth=NOW");
    expect(lastRoute).not.toBe("/logout.html?switch=1");
  });

  it("routes to switch-account when truly signed in and clicks Switch User", () => {
    let lastRoute = null;
    act(() => {
      root.render(React.createElement(AuthGateLite, {
        initialUser: null,
        onRouteDecision: (r) => { lastRoute = r; },
      }));
    });
    act(() => {
      container.querySelector('[data-testid=trigger-200]').click();
    });
    expect(container.querySelector('[data-testid=server-verified]').textContent).toBe("true");
    act(() => {
      container.querySelector('[data-testid=sign-in]').click();
    });
    /* Authenticated + server-verified → switch flow. */
    expect(lastRoute).toBe("/logout.html?switch=1");
  });
});
