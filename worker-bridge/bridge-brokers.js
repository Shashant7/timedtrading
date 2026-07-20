// worker-bridge/bridge-brokers.js
//
// 2026-06-15 — Broker capability registry.
// 2026-07-20 — Expanded into the broker-AGNOSTIC capability contract.
//
// This registry is the single source of truth the agnostic order planner
// (`bridge-order-plan.js`) consults to translate a model signal into a
// concrete order for ANY broker while respecting how that broker handles
// market / limit / OCO / bracket orders.
//
// Two capability tiers per broker:
//   - `native`  : what the broker's API is capable of (the roadmap target).
//   - `adapter` : what OUR adapter code can actually send TODAY.
// The planner targets `adapter` for execution and surfaces the gap vs
// `native` as a warning, so protective stops are never silently dropped —
// they downgrade to engine-managed (synthetic) protection instead.

/** Order-kind capability shape (per instrument class). */
function orderKinds({ market = false, limit = false, stop = false, stop_limit = false, trailing = false } = {}) {
  return { market, limit, stop, stop_limit, trailing };
}

export const BROKER_REGISTRY = {
  ibkr: {
    id: "ibkr",
    label: "Interactive Brokers",
    connectKind: "manual_triplet",
    connectPath: "/bridge/ibkr/connect",
    supportsOptions: true,
    supportsShorts: true,
    status: "production",
    accountField: "ibkr_account_id",
    multiAccount: false,
    capabilities: {
      // IBKR Client Portal supports rich order types + native brackets/OCO.
      native: {
        equity: orderKinds({ market: true, limit: true, stop: true, stop_limit: true, trailing: true }),
        options: orderKinds({ market: true, limit: true }),
        options_multi_leg: true,
        bracket: true,       // parent + attached SL/TP children
        oco: true,           // one-cancels-other groups
        replace: true,
        fractional: false,
        list_accounts: true,
        read_positions: true,
        read_fills: true,
        tif: ["DAY", "GTC"],
      },
      // What bridge-ibkr.js actually sends today.
      // 2026-07-20: equity limit + native bracket (placeBracketOrder) wired.
      adapter: {
        equity: orderKinds({ market: true, limit: true }),
        options: orderKinds({ limit: true, market: true }),
        options_multi_leg: true,
        bracket: true,
        oco: false,
        replace: false,
        fractional: false,
        list_accounts: false,
        read_positions: true,
        read_fills: false,
        cancel: true,
        tif: ["DAY", "GTC"],
      },
    },
  },
  robinhood: {
    id: "robinhood",
    label: "Robinhood Agentic",
    connectKind: "oauth",
    connectPath: "/bridge/oauth/start",
    supportsOptions: false,
    supportsShorts: false,
    status: "scaffold",
    accountField: "rh_account_number",
    multiAccount: false,
    capabilities: {
      native: {
        equity: orderKinds({ market: true, limit: true, stop: true, stop_limit: true, trailing: true }),
        options: orderKinds({}),
        options_multi_leg: false,
        bracket: false,      // RH brackets are UI-only; agentic API is market-first
        oco: false,
        replace: false,
        fractional: true,
        list_accounts: true,
        read_positions: true,
        read_fills: true,
        tif: ["DAY", "GTC"],
      },
      adapter: {
        equity: orderKinds({ market: true }),
        options: orderKinds({}),
        options_multi_leg: false,
        bracket: false,
        oco: false,
        replace: false,
        fractional: false,
        list_accounts: false,
        read_positions: true,
        read_fills: false,
        cancel: true,
        tif: ["DAY"],
      },
    },
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
    accountField: "webull_account_id",
    multiAccount: true,
    capabilities: {
      native: {
        equity: orderKinds({ market: true, limit: true, stop: true, stop_limit: true }),
        options: orderKinds({ limit: true }),
        options_multi_leg: false,
        bracket: false,      // Webull OpenAPI: no native attached bracket in one call
        oco: false,
        replace: false,
        fractional: true,    // entrust_type AMOUNT (not wired in adapter)
        list_accounts: true,
        read_positions: true,
        read_fills: true,
        tif: ["DAY", "GTC"],
      },
      // 2026-07-20: equity limit + stop wired; OCO via emulated SL/TP children
      // (place-after-entry + cancel-sibling-on-fill), gated by BROKER_OCO_ENABLED.
      adapter: {
        equity: orderKinds({ market: true, limit: true, stop: true, stop_limit: true }),
        options: orderKinds({ limit: true }),
        options_multi_leg: false,
        bracket: false,
        oco: true,
        replace: false,
        fractional: false,
        list_accounts: true,
        read_positions: true,
        read_fills: true,
        cancel: true,
        tif: ["DAY", "GTC"],
      },
    },
  },
};

export function listBrokers() {
  return Object.values(BROKER_REGISTRY);
}

export function brokerMeta(id) {
  return BROKER_REGISTRY[String(id || "").toLowerCase()] || null;
}

/** Structured capabilities for a broker. tier: "adapter" (default) | "native". */
export function brokerCapabilities(id, tier = "adapter") {
  const meta = brokerMeta(id);
  if (!meta?.capabilities) return null;
  return meta.capabilities[tier] || meta.capabilities.adapter || null;
}

/**
 * Broker-agnostic account id resolver. The bridge stores account ids under
 * different fields per broker (`webull_account_id` was previously omitted
 * from the manifest/audit chain → Webull rows collapsed to "default"). One
 * resolver keeps the ledger, manifest, audit, and reconciler consistent.
 */
export function resolveBrokerAccountId(user) {
  if (!user || typeof user !== "object") return "default";
  const id = user.webull_account_id
    ?? user.ibkr_account_id
    ?? user.rh_account_number
    ?? user.account_id
    ?? user.broker_account_id
    ?? null;
  const s = id == null ? "" : String(id).trim();
  return s || "default";
}

/** Infer the broker id from a stored user row. */
export function resolveBrokerId(user) {
  if (!user || typeof user !== "object") return null;
  if (user.broker) return String(user.broker).toLowerCase();
  if (user.webull_account_id || user.owner_email) return "webull";
  if (user.ibkr_account_id) return "ibkr";
  if (user.rh_account_number) return "robinhood";
  return null;
}
