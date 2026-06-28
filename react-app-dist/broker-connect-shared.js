// broker-connect-shared.js
//
// 2026-06-15 — Shared broker connect helpers for Mission Control + account pages.
// Proxies through main worker admin routes (never calls bridge directly from browser).

(function (root) {
  const BROKERS = {
    webull: {
      id: "webull",
      label: "Webull",
      blurb: "Connect via Webull Connect API. OAuth + signed REST for equity mirror.",
      registrationEmail: "connect.api@webull-us.com",
      statusKey: "webull_connect_configured",
    },
    ibkr: {
      id: "ibkr",
      label: "Interactive Brokers",
      blurb: "Operator posts OAuth triplet via Mission Control or /bridge/ibkr/connect.",
      statusKey: null,
    },
    robinhood: {
      id: "robinhood",
      label: "Robinhood",
      blurb: "Agentic MCP — awaiting published OAuth endpoints.",
      statusKey: null,
    },
  };

  async function postJson(apiBase, path, body) {
    const r = await fetch(`${apiBase}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j?.ok !== false, status: r.status, json: j };
  }

  async function connectWebull(apiBase, userId) {
    return postJson(apiBase, "/timed/admin/broker-bridge/webull/connect", { user_id: userId });
  }

  async function disconnectWebull(apiBase, userId) {
    return postJson(apiBase, "/timed/admin/broker-bridge/webull/disconnect", { user_id: userId });
  }

  async function testWebull(apiBase, userId, action) {
    return postJson(apiBase, "/timed/admin/broker-bridge/webull/test", {
      user_id: userId,
      action: action || "get_portfolio",
    });
  }

  function findUserByBroker(users, brokerId) {
    return (users || []).find((u) => String(u?.broker || "").toLowerCase() === brokerId) || null;
  }

  root.TimedBrokerConnect = {
    BROKERS,
    connectWebull,
    disconnectWebull,
    testWebull,
    findUserByBroker,
  };
})(typeof window !== "undefined" ? window : globalThis);

// cache-bust:1782679546630:94435560
