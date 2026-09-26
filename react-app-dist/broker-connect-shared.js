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
        // /bridge/portfolio used to drop option lots; keep them on the
        // merged row so Mission Control can render them next to shares.
        options_positions: Array.isArray(p?.options_positions) ? p.options_positions : null,
        options_count: Number.isFinite(Number(p?.options_count)) ? Number(p.options_count) : null,
        equity_usd: p?.equity_usd ?? null,
        cash_usd: p?.cash_usd ?? null,
        buying_power_usd: p?.buying_power_usd ?? null,
        account_id: p?.account_id || brokerAccountId(u),
      };
    });
  }

  // Keep in sync with worker-bridge/bridge-positions-options.js.
  function formatOptionHoldingLabel(op) {
    const und = String(op?.underlying || op?.symbol || "").toUpperCase();
    if (!und) return null;
    const rightRaw = String(op?.option_type || op?.right || "").toUpperCase().replace(/[^A-Z]/g, "");
    let right = "?";
    if (rightRaw === "P" || rightRaw === "PUT" || rightRaw.startsWith("PUT")) right = "P";
    else if (rightRaw === "C" || rightRaw === "CALL" || rightRaw.startsWith("CALL")) right = "C";
    else if (rightRaw.includes("PUT")) right = "P";
    const strike = Number(op?.strike);
    const strikeStr = Number.isFinite(strike)
      ? (Math.abs(strike - Math.round(strike)) < 1e-6 ? String(Math.round(strike)) : strike.toFixed(2))
      : null;
    let exp = "";
    const expRaw = op?.expiration || op?.expiry || null;
    if (expRaw) {
      const d = String(expRaw).slice(0, 10);
      const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
      exp = m ? `${m[2]}/${m[3]}` : d;
    }
    const core = strikeStr ? `${und} ${strikeStr}${right}` : `${und} ${right}`;
    return exp ? `${core} ${exp}` : core;
  }

  function looksLikeOptionRow(p) {
    if (!p || typeof p !== "object") return false;
    if (String(p.instrument || "").toLowerCase() === "option") return true;
    if (p.option_type || p.optionType || p.putOrCall) return true;
    const strike = Number(p.strike ?? p.strike_price ?? p.strikePrice);
    if (Number.isFinite(strike) && strike > 0 && (p.expiration || p.expiry)) return true;
    const ac = String(p.assetClass || p.asset_class || p.secType || "").toUpperCase();
    return ac === "OPT" || ac === "OPTION" || ac === "FOP";
  }

  function normalizeMcOptionRow(op) {
    const rightRaw = String(op?.option_type || op?.right || op?.putOrCall || "").toUpperCase();
    let optionType = null;
    if (rightRaw === "P" || rightRaw === "PUT" || rightRaw.startsWith("PUT") || rightRaw.includes("PUT")) optionType = "PUT";
    else if (rightRaw === "C" || rightRaw === "CALL" || rightRaw.startsWith("CALL")) optionType = "CALL";
    const label = (op?.instrument === "option" && op?.ticker)
      ? op.ticker
      : (formatOptionHoldingLabel(op) || String(op?.symbol || op?.ticker || op?.contractDesc || "—").toUpperCase());
    return {
      ...op,
      instrument: "option",
      option_type: optionType || op?.option_type || null,
      ticker: label,
      qty: op?.qty ?? op?.quantity ?? op?.broker_qty ?? op?.position,
      avg_cost: op?.avg_cost ?? op?.avgCost ?? op?.average_cost ?? op?.cost_price,
      market_value: op?.market_value ?? op?.mktValue ?? op?.marketValue,
      unrealized_pnl: op?.unrealized_pnl ?? op?.unrealizedPnl ?? op?.unrealized_profit_loss,
    };
  }

  /**
   * Equity first, then option contracts, for Mission Control's per-account
   * Open positions table. Prefers /bridge/portfolio options_positions;
   * falls back to getEquityPositions().options so the table still fills
   * before tt-broker-bridge is redeployed.
   */
  function collectOpenPositionRows(account) {
    const equitySrc = Array.isArray(account?.positions?.positions)
      ? account.positions.positions
      : Array.isArray(account?.positions) ? account.positions
      : [];
    const equity = equitySrc.filter((p) => !looksLikeOptionRow(p));
    const attached = Array.isArray(account?.options_positions) ? account.options_positions : [];
    const bundled = Array.isArray(account?.positions?.options) ? account.positions.options : [];
    const optSrc = attached.length ? attached : bundled;
    const options = optSrc.map(normalizeMcOptionRow);
    return [
      ...equity.map((p) => ({ ...p, instrument: p.instrument || "equity" })),
      ...options,
    ];
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
    formatOptionHoldingLabel,
    looksLikeOptionRow,
    collectOpenPositionRows,
    connectWebull,
    disconnectWebull,
    testWebull,
    findUserByBroker,
    findUsersByBroker,
  };
})(typeof window !== "undefined" ? window : globalThis);

// cache-bust:1790384013513:513595761
