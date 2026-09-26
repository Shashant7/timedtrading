// worker-bridge/bridge-etrade-config.js
//
// E*TRADE Developer Platform (Morgan Stanley) — OAuth 1.0a + REST.
// Docs: https://developer.etrade.com/getting-started/developer-guides
//
// Sandbox:  https://apisb.etrade.com
// Production: https://api.etrade.com
//
// Access tokens expire at midnight US Eastern by default and go inactive
// after ~2 hours of idle — renew via POST /oauth/renew_access_token.
// Unattended mirror requires a renew cron (not live until keys land).

export function isBridgeMockMode(env) {
  return String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
}

export function etradeLiveEnabled(env) {
  return String(env?.ETRADE_LIVE_ENABLED || "false").toLowerCase() === "true"
    && !isBridgeMockMode(env)
    && etradeConsumerConfigured(env);
}

export function etradeConsumerConfigured(env) {
  return !!(String(env?.ETRADE_CONSUMER_KEY || "").trim()
    && String(env?.ETRADE_CONSUMER_SECRET || "").trim());
}

export function etradeApiBase(env) {
  const sandbox = String(env?.ETRADE_SANDBOX || "true").toLowerCase() !== "false";
  return sandbox ? "https://apisb.etrade.com" : "https://api.etrade.com";
}

export function etradeAuthorizeUrl(env) {
  const sandbox = String(env?.ETRADE_SANDBOX || "true").toLowerCase() !== "false";
  // Authorize is always on the retail host; sandbox vs prod is the oauth host.
  return sandbox
    ? "https://us.etrade.com/e/t/etws/authorize"
    : "https://us.etrade.com/e/t/etws/authorize";
}

export function etradeCallbackUrl(env) {
  return String(env?.ETRADE_OAUTH_CALLBACK_URL
    || env?.BRIDGE_PUBLIC_ORIGIN && `${env.BRIDGE_PUBLIC_ORIGIN}/bridge/etrade/oauth/callback`
    || "").trim();
}
