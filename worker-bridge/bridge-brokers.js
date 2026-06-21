// worker-bridge/bridge-brokers.js
//
// 2026-06-15 — Broker capability registry (informal; not a plugin loader).
// Used by health/status responses and operator UIs.

export const BROKER_REGISTRY = {
  ibkr: {
    id: "ibkr",
    label: "Interactive Brokers",
    connectKind: "manual_triplet",
    connectPath: "/bridge/ibkr/connect",
    supportsOptions: true,
    supportsShorts: true,
    status: "production",
  },
  robinhood: {
    id: "robinhood",
    label: "Robinhood Agentic",
    connectKind: "oauth",
    connectPath: "/bridge/oauth/start",
    supportsOptions: false,
    supportsShorts: false,
    status: "scaffold",
  },
  webull: {
    id: "webull",
    label: "Webull",
    connectKind: "oauth_connect",
    connectPath: "/bridge/webull/oauth/start",
    disconnectPath: "/bridge/webull/oauth/disconnect",
    testPath: "/bridge/test/webull-call",
    supportsOptions: true,
    supportsShorts: false,
    status: "awaiting_credentials",
  },
};

export function listBrokers() {
  return Object.values(BROKER_REGISTRY);
}

export function brokerMeta(id) {
  return BROKER_REGISTRY[String(id || "").toLowerCase()] || null;
}
