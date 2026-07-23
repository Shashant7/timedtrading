// broker-connect-shared.js
//
// Shared broker connect helpers for Mission Control + account pages.
// Proxies through main worker admin routes (never calls bridge directly from browser).

(function (root) {
  const BROKERS = {
    webull: {
      id: "webull",
      label: "Webull",
      blurbPersonal: "Operator personal Trading API (App Key + App Secret on tt-broker-bridge).",
      blurbConnect: "Platform OAuth via Webull Connect API (partner credentials).",
      registrationEmail: "connect.api@webull-us.com",
      credentialsKey: "webull_credentials_configured",
    },
    ibkr: {
      id: "ibkr",
      label: "Interactive Brokers",
      blurb: "LST / OAuth triplet via bridge /bridge/ibkr/connect.",
      credentialsKey: null,
    },
    robinhood: {
      id: "robinhood",
      label: "Robinhood",
      blurb: "Agentic MCP — awaiting published OAuth endpoints.",
      credentialsKey: null,
      comingSoon: true,
    },
  };

  function webullAuthMode(status) {
    return String(status?.webull_auth_mode || "connect").toLowerCase() === "personal"
      ? "personal"
      : "connect";
  }

  function webullCredentialsReady(status) {
    return status?.webull_credentials_configured === true;
  }

  function ownerDisplayEmail(user) {
    if (!user) return "—";
    if (user.owner_email) return user.owner_email;
    const uid = String(user.user_id || "");
    const i = uid.indexOf("#webull#");
    return i > 0 ? uid.slice(0, i) : uid;
  }

  function brokerDisplayName(broker, user, status) {
    const id = String(broker || "").toLowerCase();
    if (id === "webull") {
      const mode = user?.webull_auth_mode || webullAuthMode(status);
      const base = mode === "personal" ? "Webull · Personal API" : "Webull · Connect OAuth";
      const label = user?.webull_account_label || user?.webull_account_type;
      return label ? `${base} · ${label}` : base;
    }
    return BROKERS[id]?.label || (id ? id.toUpperCase() : "Unknown");
  }

  function brokerAccountId(user) {
    if (!user) return null;
    return user.webull_account_id
      || user.ibkr_account_id
      || user.rh_account_number
      || user.account_id
      || null;
  }

  function mergeAccountRows(statusUsers, portfolioUsers) {
    const byId = {};
    (portfolioUsers || []).forEach((p) => {
      if (p?.user_id) byId[p.user_id] = p;
    });
    return (statusUsers || []).map((u) => {
      const p = byId[u.user_id] || null;
      return {
        ...u,
        portfolio: p?.portfolio || null,
        positions: p?.positions || null,
        equity_usd: p?.equity_usd ?? null,
        cash_usd: p?.cash_usd ?? null,
        buying_power_usd: p?.buying_power_usd ?? null,
        account_id: p?.account_id || brokerAccountId(u),
      };
    });
  }

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

  function findUsersByBroker(users, brokerId) {
    const id = String(brokerId || "").toLowerCase();
    return (users || []).filter((u) => String(u?.broker || "").toLowerCase() === id);
  }

  function findUserByBroker(users, brokerId) {
    return findUsersByBroker(users, brokerId)[0] || null;
  }

  root.TimedBrokerConnect = {
    BROKERS,
    webullAuthMode,
    webullCredentialsReady,
    ownerDisplayEmail,
    brokerDisplayName,
    brokerAccountId,
    mergeAccountRows,
    connectWebull,
    disconnectWebull,
    testWebull,
    findUserByBroker,
    findUsersByBroker,
  };
})(typeof window !== "undefined" ? window : globalThis);

// cache-bust:1784805926823:750824547
