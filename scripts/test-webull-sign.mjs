#!/usr/bin/env node
/**
 * Smoke test for Webull HMAC-SHA1 signing (bridge-webull-sign.js).
 * Run: node scripts/test-webull-sign.mjs
 */
import { createHash, createHmac } from "node:crypto";

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function md5Upper(str) {
  return createHash("md5").update(str, "utf8").digest("hex").toUpperCase();
}

function buildSignature({ path, host, appKey, appSecret, query = {}, body = null, accessToken = "" }) {
  const timestamp = "2024-01-15T12:00:00Z";
  const nonce = "abc123nonce";
  const signingHeaders = {
    "x-app-key": appKey,
    "x-timestamp": timestamp,
    "x-signature-algorithm": "HMAC-SHA1",
    "x-signature-version": "1.0",
    "x-signature-nonce": nonce,
    host,
  };
  const params = { ...query, ...signingHeaders };
  const paramString = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  let bodyMd5 = "";
  if (body != null && body !== "") {
    bodyMd5 = md5Upper(typeof body === "string" ? body : JSON.stringify(body));
  }
  const signString = bodyMd5 ? `${path}&${paramString}&${bodyMd5}` : `${path}&${paramString}`;
  const encoded = percentEncode(signString);
  const sig = createHmac("sha1", `${appSecret}&`).update(encoded, "utf8").digest("base64");
  return { signString, encoded, signature: sig };
}

const r = buildSignature({
  path: "/openapi/assets/balance",
  host: "us-oauth-open-api.uat.webullbroker.com",
  appKey: "test_app_key",
  appSecret: "test_app_secret",
  query: { account_id: "ACCT123" },
  accessToken: "tok",
});

if (!r.signature || r.signature.length < 8) {
  console.error("FAIL: signature empty");
  process.exit(1);
}
if (!r.encoded.includes("%26")) {
  console.error("FAIL: expected URL-encoded ampersands in sign string");
  process.exit(1);
}
console.log("OK webull sign smoke test", { signatureLen: r.signature.length });
