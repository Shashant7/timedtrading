// worker-bridge/bridge-webull-sign.js
//
// 2026-06-15 — Webull OpenAPI HMAC-SHA1 request signing.
// Algorithm: https://developer.webull.com/apis/recipes_us/ (US recipe)

import { createHash, createHmac } from "node:crypto";

function isoTimestampUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function randomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function md5Upper(str) {
  return createHash("md5").update(str, "utf8").digest("hex").toUpperCase();
}

/**
 * Build signed headers for a Webull OpenAPI request.
 *
 * @param {object} opts
 * @param {string} opts.path - URI path only, e.g. /openapi/assets/balance
 * @param {string} opts.method - GET | POST
 * @param {string} opts.host - Host header value (no scheme)
 * @param {string} opts.appKey
 * @param {string} opts.appSecret
 * @param {object} [opts.query] - query string params
 * @param {object|string|null} [opts.body] - JSON object or raw form string
 * @param {string} [opts.accessToken] - OAuth access token (x-access-token)
 */
export function buildWebullSignedHeaders(opts) {
  const {
    path,
    host,
    appKey,
    appSecret,
    query = {},
    body = null,
    accessToken = "",
  } = opts;

  const timestamp = isoTimestampUtc();
  const nonce = randomNonce();

  const signingHeaders = {
    "x-app-key": appKey,
    "x-timestamp": timestamp,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-version": "1.0",
    "x-signature-nonce": nonce,
    host,
  };

  const params = { ...query, ...signingHeaders };
  const sortedKeys = Object.keys(params).sort();
  const paramString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&");

  let bodyMd5 = "";
  if (body != null && body !== "") {
    const bodyStr = typeof body === "string"
      ? body
      : JSON.stringify(body);
    bodyMd5 = md5Upper(bodyStr);
  }

  const signString = bodyMd5
    ? `${path}&${paramString}&${bodyMd5}`
    : `${path}&${paramString}`;

  const encodedSignString = percentEncode(signString);
  const secretKey = `${appSecret}&`;
  const signature = createHmac("sha1", secretKey)
    .update(encodedSignString, "utf8")
    .digest("base64");

  return {
    "x-app-key": appKey,
    "x-timestamp": timestamp,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-version": "1.0",
    "x-signature-nonce": nonce,
    "x-version": "v2",
    "x-access-token": accessToken || "",
    "x-signature": signature,
    host,
  };
}

export { isoTimestampUtc, randomNonce };
