// worker-bridge/bridge-webull-options.js
//
// Webull options: preview + place single-leg long call/put (LMT).
// Docs: https://developer.webull.com/apis/docs/trade-api/options.md

import {
  ensureWebullAccessToken,
  extractWebullPositionRows,
  webullGetPositions,
  webullPostOptionsOrder,
} from "./bridge-webull-api.js";
import { WEBULL_API_PATHS, isBridgeMockMode, webullLiveEnabled } from "./bridge-webull-config.js";

function isMockMode(env) {
  return isBridgeMockMode(env) || !webullLiveEnabled(env);
}

/**
 * Translate a TT ladder play into a Webull single-leg option order.
 */
export function playToWebullOptionOrder(play, symbol) {
  if (!play || !Array.isArray(play.legs) || play.legs.length === 0) return null;
  const sym = String(symbol || play.ticker || play.legs[0]?.ticker || "").toUpperCase();
  if (play.legs.length !== 1) return null;

  const leg = play.legs[0];
  if (!leg.optionType && leg.instrument !== "OPTION") return null;

  const right = String(leg.optionType || leg.right || "").toUpperCase();
  const optionType = right.includes("P") ? "PUT" : "CALL";
  const strike = Number(leg.strike);
  const exp = leg.expiration || leg.expire_date || null;
  const qty = Number(leg.qty) || Number(play.contracts) || 1;
  const limit = Number(
    play.premium?.mid
    ?? leg.premium_mid
    ?? leg.limit_price
    ?? play.limit_price,
  );

  if (!(strike > 0) || !exp || !(limit > 0)) return null;

  return {
    type: "single",
    symbol: sym,
    action: String(leg.action || "BUY").toUpperCase(),
    qty,
    strike,
    expiration: exp,
    option_type: optionType,
    limit_price: limit,
    order_type: "LMT",
    trade_id: play.trade_id || null,
  };
}

export function buildWebullOptionOrderPayload(user, order, { preview = false } = {}) {
  const accountId = user?.webull_account_id;
  if (!accountId) throw new Error("webull_account_id_missing");

  const sym = String(order.symbol || "").toUpperCase();
  const qty = Number(order.qty) || 1;
  const strike = Number(order.strike);
  const exp = String(order.expiration || "");
  const optionType = String(order.option_type || "CALL").toUpperCase();
  const side = String(order.action || "BUY").toUpperCase();
  const limit = Number(order.limit_price);

  if (!sym || !(strike > 0) || !exp || !(limit > 0)) {
    throw new Error("incomplete_option_order");
  }

  const clientOrderId = preview
    ? `tt-opt-prev-${crypto.randomUUID().slice(0, 10)}`
    : `tt-opt-${order.trade_id || "na"}-${crypto.randomUUID().slice(0, 8)}`.slice(0, 32);

  const newOrder = {
    client_order_id: clientOrderId,
    combo_type: "NORMAL",
    order_type: "LIMIT",
    limit_price: limit.toFixed(2),
    quantity: String(qty),
    option_strategy: "SINGLE",
    side,
    time_in_force: "DAY",
    entrust_type: "QTY",
    instrument_type: "OPTION",
    market: "US",
    symbol: sym,
    legs: [{
      side,
      quantity: String(qty),
      symbol: sym,
      strike_price: strike.toFixed(2),
      option_expire_date: exp,
      instrument_type: "OPTION",
      option_type: optionType,
      market: "US",
    }],
  };

  return {
    account_id: accountId,
    new_orders: [newOrder],
  };
}

function _mockOptionsResponse(kind, order, t0) {
  const sym = String(order?.symbol || "AAPL").toUpperCase();
  return {
    ok: true,
    mock: true,
    broker: "webull",
    kind,
    latency_ms: Math.max(20, Date.now() - t0),
    response: {
      preview_status: kind === "review" ? "ok" : undefined,
      order_id: kind === "place" ? `mock_wb_opt_${crypto.randomUUID().slice(0, 8)}` : undefined,
      symbol: sym,
      qty: Number(order?.qty) || 1,
      limit_price: order?.limit_price,
      option_type: order?.option_type,
      strike: order?.strike,
      expiration: order?.expiration,
    },
  };
}

async function _postOptionOrder(env, user, order, { preview }) {
  const tok = await ensureWebullAccessToken(env, user);
  if (!tok.ok) return tok;

  const body = buildWebullOptionOrderPayload(user, order, { preview });
  const path = preview ? WEBULL_API_PATHS.orderPreview : WEBULL_API_PATHS.orderPlace;
  return webullPostOptionsOrder(env, { path, body, accessToken: tok.access_token, user });
}

export async function reviewOptionsOrder(env, user, order) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockOptionsResponse("review", order, t0);
  const res = await _postOptionOrder(env, user, order, { preview: true });
  return { ...res, latency_ms: Math.max(1, Date.now() - t0) };
}

export async function placeOptionsOrder(env, user, order) {
  const t0 = Date.now();
  if (isMockMode(env)) return _mockOptionsResponse("place", order, t0);
  const res = await _postOptionOrder(env, user, order, { preview: false });
  return { ...res, latency_ms: Math.max(1, Date.now() - t0) };
}

/** OCC equity option root: SPY260920C00777000 */
const OCC_RE = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/;

export function parseOccOptionSymbol(symbol) {
  const sym = String(symbol || "").toUpperCase();
  const m = sym.match(OCC_RE);
  if (!m) return null;
  const yy = m[2].slice(0, 2);
  const mm = m[2].slice(2, 4);
  const dd = m[2].slice(4, 6);
  const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`;
  return {
    underlying: m[1],
    expiration: `${year}-${mm}-${dd}`,
    option_type: m[3] === "P" ? "PUT" : "CALL",
    strike: Number(m[4]) / 1000,
  };
}

function looksLikeOptionRow(p) {
  const t = String(
    p?.instrument_type || p?.instrumentType || p?.asset_type || p?.assetType || "",
  ).toUpperCase();
  if (t === "OPTION" || t === "OPTIONS" || t.includes("OPTION")) return true;
  if (p?.option_expire_date || p?.optionExpireDate || p?.option_type || p?.optionType) return true;
  if ((p?.strike_price != null || p?.strikePrice != null)
      && (p?.underlying_symbol || p?.underlyingSymbol || p?.underlying)) {
    return true;
  }
  if (Array.isArray(p?.legs) && p.legs.some(looksLikeOptionRow)) return true;
  return !!parseOccOptionSymbol(p?.symbol || p?.ticker);
}

/**
 * CALL / PUT, or null when the source said nothing recognizable.
 *
 * Never guess. A row whose right cannot be read must not be foldable onto a
 * contract key at all — defaulting to CALL is how a held PUT stopped
 * matching its own SELL (see normalizeWebullOptionsPositions).
 */
function normalizeOptionRight(raw) {
  const r = String(raw || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (r === "P" || r.startsWith("PUT")) return "PUT";
  if (r === "C" || r.startsWith("CALL")) return "CALL";
  if (r.includes("PUT")) return "PUT";
  if (r.includes("CALL")) return "CALL";
  return null;
}

function optionSide(raw) {
  const s = String(raw || "").toUpperCase();
  if (s.includes("SELL") || s.includes("SHORT")) return "SELL";
  if (s.includes("BUY") || s.includes("LONG")) return "BUY";
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** OCC root for a contract Webull only describes in fields. */
function occFromParts(underlying, expiration, right, strike) {
  const und = String(underlying || "").toUpperCase();
  const m = String(expiration || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const k = Number(strike);
  const r = right === "PUT" ? "P" : right === "CALL" ? "C" : null;
  if (!und || !m || !r || !(k > 0)) return null;
  return `${und}${m[1].slice(2)}${m[2]}${m[3]}${r}${String(Math.round(k * 1000)).padStart(8, "0")}`;
}

/**
 * Flatten a Webull options position into one row per contract.
 *
 * Webull returns an option holding as a COMBO row: the contract itself
 * (`option_type`, `option_expire_date`, `option_exercise_price`) lives on
 * `legs[]`, and the top level carries only the underlying symbol and the
 * combo quantity. Reading the top level alone yields strike `null`,
 * expiration `null` and an unknown right for every position, which is why
 * the 2026-09-24 IWM 279P stop-out was rejected `no_held_position` by the
 * SELL guard while the contract sat long in the account. Flat rows (other
 * brokers, OCC symbols) still pass through unchanged.
 */
function optionRowsFromPosition(p) {
  const legs = Array.isArray(p?.legs) ? p.legs.filter(looksLikeOptionRow) : [];
  if (!legs.length) return [{ row: p, leg: null, comboLegs: 1 }];
  return legs.map((leg) => ({ row: p, leg, comboLegs: legs.length }));
}

export function normalizeWebullOptionsPositions(positionsResp) {
  // Must use extractWebullPositionRows — Webull often returns
  // `{ position_list: [...] }`. The equity path already handled that;
  // options previously only checked `.positions` and silently dropped
  // every option row (SPY 777C missing from Broker Connections).
  const rows = extractWebullPositionRows(positionsResp);
  return rows
    .filter(looksLikeOptionRow)
    .flatMap(optionRowsFromPosition)
    .map(({ row: p, leg, comboLegs }) => {
      const src = leg || p;
      const occ = parseOccOptionSymbol(src.symbol || src.ticker)
        || parseOccOptionSymbol(p.symbol || p.ticker);
      const right = normalizeOptionRight(
        src.option_type ?? src.optionType ?? p.option_type ?? p.optionType ?? occ?.option_type,
      );
      const strike = num(
        src.option_exercise_price ?? src.optionExercisePrice
        ?? src.strike_price ?? src.strikePrice ?? src.strike
        ?? p.option_exercise_price ?? p.strike_price ?? p.strikePrice ?? p.strike
        ?? occ?.strike,
      );
      const expiration = src.option_expire_date || src.optionExpireDate || src.expiration
        || p.option_expire_date || p.optionExpireDate || p.expiration
        || occ?.expiration || null;
      const underlyingRaw = src.underlying_symbol || src.underlyingSymbol || src.underlying
        || p.underlying_symbol || p.underlyingSymbol || p.underlying
        || occ?.underlying
        || (parseOccOptionSymbol(src.symbol) ? null : src.symbol)
        || p.symbol || p.ticker || "";
      const underlying = String(underlyingRaw).toUpperCase();

      const magnitude = num(src.quantity ?? src.qty ?? p.quantity ?? p.qty);
      const side = optionSide(src.side ?? src.action ?? p.side ?? p.action);
      const qty = magnitude == null ? null : (side === "SELL" ? -Math.abs(magnitude) : magnitude);

      const symbol = String(
        (parseOccOptionSymbol(src.symbol) ? src.symbol : null)
        || (parseOccOptionSymbol(p.symbol) ? p.symbol : null)
        || occFromParts(underlying, expiration, right, strike)
        || p.symbol || p.ticker || "",
      ).toUpperCase();

      return {
        symbol,
        underlying: underlying || String(occ?.underlying || "").toUpperCase(),
        qty,
        option_type: right,
        strike,
        expiration,
        avg_cost: Number(src.cost_price ?? src.avg_cost ?? src.avgCost
          ?? p.cost_price ?? p.avg_cost ?? p.avgCost) || null,
        unrealized_pnl: Number(src.unrealized_profit_loss ?? src.unrealized_pnl ?? src.unrealizedPnl
          ?? p.unrealized_profit_loss ?? p.unrealized_pnl ?? p.unrealizedPnl) || null,
        market_value: Number(src.market_value ?? src.marketValue
          ?? p.market_value ?? p.marketValue) || null,
        // A multi-leg combo does not say which legs are long and which are
        // short. Selling a leg we are already short of is the one mistake
        // this whole guard exists to prevent, so such a row is marked
        // unusable for holdings math rather than assumed long.
        direction_unknown: comboLegs > 1 && !side,
        raw: p,
      };
    })
    .filter((p) => p.symbol || p.underlying);
}

export async function getOptionsPositions(env, user) {
  const t0 = Date.now();
  if (isMockMode(env)) return { ok: true, positions: [], latency_ms: Date.now() - t0 };
  const tok = await ensureWebullAccessToken(env, user);
  if (!tok.ok) return tok;
  const raw = await webullGetPositions(env, user, tok.access_token);
  if (raw && raw.ok === false) {
    return {
      ok: false,
      error: raw.error || "positions_unavailable",
      positions: [],
      latency_ms: Date.now() - t0,
    };
  }
  const parsed = normalizeWebullOptionsPositions(raw);
  return { ok: true, positions: parsed, latency_ms: Date.now() - t0 };
}
