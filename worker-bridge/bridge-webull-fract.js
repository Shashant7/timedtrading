// worker-bridge/bridge-webull-fract.js
//
// 2026-07-22 — Detect the Webull "fractional agreement not signed" error and
// classify it as a distinct condition the bridge can auto-fall-back on.
//
// Live example (HALO 2026-07-22 19:02):
//   error_code: OAUTH_OPENAPI_OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE
//   message:    https://sp.webull.com/agreement/third-party?bizTypes=TRADE_FRACT_PRO&secAccountId=<id>&hl=en
//
// The URL is the operator's agreement to sign. Until they do, every
// fractional-qty order for that account will place-fail post-preview. Our
// mitigation: detect this error, round the qty DOWN to whole shares, and
// retry once. Persist a flag on the user record so future preflights skip
// fractional up-front (avoids the wasted preview + place round-trip).
//
// This module is a pure classifier so it's fully unit-testable.

const AGREEMENT_URL_HINT = "bizTypes=TRADE_FRACT_PRO";
const FRACT_ERROR_CODES = new Set([
  "OAUTH_OPENAPI_OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE",
  "OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE",
]);

/**
 * @param {object} placeResult  { ok, response?, error?, ... } from placeOrder
 * @returns {{ isFractAgreementError: boolean, agreementUrl: string|null, errorCode: string|null }}
 */
export function classifyWebullFractError(placeResult) {
  if (!placeResult || placeResult.ok) {
    return { isFractAgreementError: false, agreementUrl: null, errorCode: null };
  }
  const response = placeResult.response || {};
  const errorCode = response.error_code || response.errorCode || null;
  const message = String(response.message || response.msg || placeResult.error || "");
  const codeMatch = errorCode && FRACT_ERROR_CODES.has(String(errorCode).toUpperCase());
  const messageMatch = message.includes(AGREEMENT_URL_HINT);
  if (!codeMatch && !messageMatch) {
    return { isFractAgreementError: false, agreementUrl: null, errorCode };
  }
  // Extract the sign-up URL when present so the operator alert / audit
  // surfaces the exact link they need to visit.
  const urlMatch = message.match(/https?:\/\/[^\s"']+/);
  return {
    isFractAgreementError: true,
    agreementUrl: urlMatch ? urlMatch[0] : null,
    errorCode: errorCode || "OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE",
  };
}

/**
 * Round a fractional qty DOWN to whole shares so we can retry after the
 * fractional-agreement rejection. Returns 0 when the caller would need a
 * fractional share to have any position (e.g. scaled qty was 0.5).
 * @param {number} qty
 * @returns {number}
 */
export function roundToWholeShares(qty) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
