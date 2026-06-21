// worker-bridge/bridge-webull-config.js
//
// 2026-06-15 — Webull Connect API env + URL resolution.
// Docs: https://developer.webull.com/apis/docs/connect-api/about-connect-api/

export const WEBULL_API_PATHS = {
  authorizeLogin: "/oauth2/authenticate/login",
  token: "/openapi/oauth2/token",
  accountList: "/oauth-openapi/account/list",
  balance: "/openapi/assets/balance",
  positions: "/openapi/assets/positions",
  orderPreview: "/openapi/trade/order/preview",
  orderPlace: "/openapi/trade/order/place",
  orderCancel: "/openapi/trade/order/cancel",
};

export function webullEnvironment(env) {
  return String(env?.WEBULL_ENVIRONMENT || "uat").toLowerCase() === "prod" ? "prod" : "uat";
}

export function webullApiHost(env) {
  return webullEnvironment(env) === "prod"
    ? "us-oauth-open-api.webull.com"
    : "us-oauth-open-api.uat.webullbroker.com";
}

export function webullApiBaseUrl(env) {
  return `https://${webullApiHost(env)}`;
}

export function webullConnectScope(env) {
  return String(env?.WEBULL_CONNECT_SCOPE || "user:trade:wr").trim() || "user:trade:wr";
}

export function webullTokenRefreshSkewMs(env) {
  const n = Number(env?.WEBULL_TOKEN_REFRESH_SKEW_MS);
  return Number.isFinite(n) && n >= 0 ? n : 5 * 60 * 1000;
}

/** True when all four Connect partner credentials are present. */
export function webullConnectConfigured(env) {
  return !!(
    env?.WEBULL_CONNECT_CLIENT_ID
    && env?.WEBULL_CONNECT_CLIENT_SECRET
    && env?.WEBULL_APP_KEY
    && env?.WEBULL_APP_SECRET
  );
}

export function webullRedirectUri(env, req) {
  const explicit = env?.WEBULL_OAUTH_REDIRECT_URI;
  if (explicit) return explicit;
  const url = new URL(req.url);
  return `${url.origin}/bridge/webull/oauth/callback`;
}

export function isBridgeMockMode(env) {
  return String(env?.BROKER_BRIDGE_MOCK || "true").toLowerCase() !== "false";
}

/** Live Webull HTTPS calls only when creds exist and mock mode is off. */
export function webullLiveEnabled(env) {
  return webullConnectConfigured(env) && !isBridgeMockMode(env);
}
