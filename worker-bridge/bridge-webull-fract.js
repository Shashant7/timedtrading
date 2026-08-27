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
 * @returns {{ isFractAgreementError: boolean, isFractHoursError: boolean,
 *   agreementUrl: string|null, errorCode: string|null }}
 */
export function classifyWebullFractError(placeResult) {
  if (!placeResult || placeResult.ok) {
    return {
      isFractAgreementError: false,
      isFractHoursError: false,
      agreementUrl: null,
      errorCode: null,
    };
  }
  const response = placeResult.response || {};
  const errorCode = response.error_code || response.errorCode || null;
  const message = String(response.message || response.msg || placeResult.error || "");
  const codeMatch = errorCode && FRACT_ERROR_CODES.has(String(errorCode).toUpperCase());
  const messageMatch = message.includes(AGREEMENT_URL_HINT);
  // Webull ETH/overnight: "Fractional shares trading is only available
  // during regular trading hours: 9:30 a.m. - 4:00 p.m. ET"
  const hoursMatch = /fractional share orders at this moment/i.test(message)
    || /fractional shares trading is only available during regular trading hours/i.test(message);
  if (!codeMatch && !messageMatch && !hoursMatch) {
    return {
      isFractAgreementError: false,
      isFractHoursError: false,
      agreementUrl: null,
      errorCode,
    };
  }
  // Extract the sign-up URL when present so the operator alert / audit
  // surfaces the exact link they need to visit.
  const urlMatch = message.match(/https?:\/\/[^\s"']+/);
  return {
    isFractAgreementError: !!(codeMatch || messageMatch),
    isFractHoursError: !!hoursMatch && !(codeMatch || messageMatch),
    agreementUrl: urlMatch ? urlMatch[0] : null,
    errorCode: errorCode
      || (hoursMatch ? "FRACTIONAL_OUTSIDE_RTH" : "OPENAPI_FRACT_VERSION2_ACCOUNT_NOT_TRADE"),
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

/** NY regular session (9:30–16:00 ET, weekdays). Holidays are the calendar's job. */
export function isNyRegularSession(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const dow = String(map.weekday || "").toLowerCase();
  if (dow === "sat" || dow === "sun") return false;
  const hh = Number(map.hour);
  const mm = Number(map.minute);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  const mins = hh * 60 + mm;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

export function isWebullEthSession(session) {
  return ["ALL", "NIGHT", "ALL_DAY"].includes(String(session || "").toUpperCase());
}

/**
 * Webull fills fractional equity only in RTH. After the cash close, floor
 * to whole shares so an AH trim (TSLA 1.359 → 1) still lands. Sub-share
 * leftovers wait for the next open — they cannot fill in ETH.
 */
export function adaptWebullEquityQtyForSession({ qty, session, now = new Date() } = {}) {
  const n = Number(qty);
  const eth = isWebullEthSession(session) || !isNyRegularSession(now);
  if (!eth || !Number.isFinite(n) || n <= 0) {
    return { qty: Number.isFinite(n) && n > 0 ? n : 0, adapted: false, deferred: false, reason: null };
  }
  if (Math.abs(n - Math.round(n)) < 1e-9) {
    return { qty: Math.round(n), adapted: false, deferred: false, reason: null };
  }
  const whole = Math.floor(n + 1e-9);
  if (whole >= 1) {
    return { qty: whole, adapted: true, deferred: false, original: n, reason: null };
  }
  return {
    qty: 0,
    adapted: true,
    deferred: true,
    original: n,
    reason: "fractional_trim_deferred_to_rth",
  };
}

/**
 * Webull ETH equity must be LIMIT + ALL + GTC. CORE+MARKET after 16:00 ET
 * is rejected even for whole shares. Fill any missing session fields when
 * NY is closed and a usable price is present.
 */
export function ensureWebullEthOrderFields(order, now = new Date()) {
  if (!order || isNyRegularSession(now)) return order;
  const px = Number(order.limit_price) || Number(order.entry) || Number(order.price) || 0;
  if (!(px > 0)) return order;
  const side = String(order.side || "").toLowerCase();
  const isReducer = side === "trim" || side === "exit" || side === "sell" || side === "close";
  const explicitLimit = Number(order.limit_price) > 0;
  const slack = isReducer ? 0.03 : 0.015;
  const limit = explicitLimit
    ? Math.round(Number(order.limit_price) * 100) / 100
    : Math.round(px * (isReducer ? (1 - slack) : (1 + slack)) * 100) / 100;
  return {
    ...order,
    order_kind: "limit",
    order_type: "limit",
    limit_price: limit,
    tif: order.tif || "GTC",
    support_trading_session: order.support_trading_session || "ALL",
  };
}
