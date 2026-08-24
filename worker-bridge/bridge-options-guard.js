// worker-bridge/bridge-options-guard.js
//
// Defense-in-depth for options SELL mirrors. The mothership already
// caps close qty to the mirrored remainder; this rejects a SELL that
// would exceed the live broker holding for that contract (naked short).
//
// Pure. No I/O — caller fetches positions and passes them in.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function rightFlag(v) {
  const s = String(v || "").toUpperCase();
  return s.startsWith("P") ? "P" : "C";
}

function expIso(v) {
  const s = String(v || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // IBKR expiry YYYYMMDD
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
}

/**
 * Canonical contract key: QQQ:2026-08-25:710.00:C
 */
export function optionContractKey({ ticker, expiration, strike, optionType } = {}) {
  const sym = String(ticker || "").toUpperCase().replace(/\s+/g, "");
  const exp = expIso(expiration);
  const k = num(strike);
  if (!sym || !exp || !(k > 0)) return null;
  return `${sym}:${exp}:${k.toFixed(2)}:${rightFlag(optionType)}`;
}

/** Fold Webull / IBKR / OCC-ish rows onto the same key. */
export function positionContractKey(p, fallbackTicker = null) {
  if (!p) return null;
  const fromFields = optionContractKey({
    ticker: p.underlying || p.underlying_symbol || p.ticker || p.symbol || fallbackTicker,
    expiration: p.expiration || p.option_expire_date || p.exp || p.expiry,
    strike: p.strike ?? p.strike_price,
    optionType: p.option_type || p.optionType || p.putOrCall || p.right || p.type,
  });
  if (fromFields) {
    // Prefer underlying for index ETFs (Webull `symbol` is often the OCC).
    if (p.underlying || p.underlying_symbol || p.ticker) return fromFields;
    const occish = String(p.symbol || "").replace(/\s+/g, "");
    if (occish.length >= 15 && /\d{6}[CP]\d{8}$/.test(occish)) {
      const parsed = parseOccSymbol(occish);
      if (parsed) return optionContractKey(parsed);
    }
    return fromFields;
  }
  return parseOccKey(p.symbol || p.occ_symbol || p.contract_symbol || p.contractDesc);
}

function parseOccSymbol(raw) {
  const m = String(raw || "").trim().toUpperCase().replace(/\s+/g, "")
    .match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const yymmdd = m[2];
  return {
    ticker: m[1],
    expiration: `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`,
    strike: Number(m[4]) / 1000,
    optionType: m[3],
  };
}

function parseOccKey(raw) {
  const parsed = parseOccSymbol(raw);
  return parsed ? optionContractKey(parsed) : null;
}

export function heldQtyForOption(positions, spec) {
  const want = optionContractKey(spec);
  if (!want) return 0;
  let held = 0;
  for (const p of Array.isArray(positions) ? positions : []) {
    const key = positionContractKey(p, spec.ticker);
    if (key !== want) continue;
    const q = num(p.qty ?? p.quantity ?? p.position ?? p.size);
    if (q != null) held += q;
  }
  return held;
}

/**
 * Guard a single-leg options SELL against live holdings.
 * BUY and non-single structures pass through.
 *
 * @returns {{ ok: true } | { ok: false, reason: string, held_qty?: number, requested_qty?: number }}
 */
export function guardOptionsSellQty({
  action,
  qty,
  positions,
  ticker,
  expiration,
  strike,
  optionType,
} = {}) {
  const side = String(action || "").toUpperCase();
  if (side !== "SELL") return { ok: true };

  const requested = Math.max(0, Math.round(Number(qty) || 0));
  if (!(requested > 0)) return { ok: false, reason: "invalid_sell_qty", requested_qty: requested };

  if (positions == null) {
    return { ok: false, reason: "positions_unavailable", requested_qty: requested };
  }

  const held = heldQtyForOption(positions, { ticker, expiration, strike, optionType });
  if (!(held > 0)) {
    return { ok: false, reason: "no_held_position", held_qty: 0, requested_qty: requested };
  }
  if (requested > held + 1e-9) {
    return {
      ok: false,
      reason: "sell_qty_exceeds_held",
      held_qty: held,
      requested_qty: requested,
    };
  }
  return { ok: true, held_qty: held, requested_qty: requested };
}

/** Apply the guard to a translated broker order (IBKR or Webull single-leg). */
export function applyOptionsSellGuard(brokerOrder, positions) {
  if (!brokerOrder || String(brokerOrder.type || "single") !== "single") {
    return { ok: true };
  }
  return guardOptionsSellQty({
    action: brokerOrder.action,
    qty: brokerOrder.qty,
    positions,
    ticker: brokerOrder.symbol,
    expiration: brokerOrder.expiration,
    strike: brokerOrder.strike,
    optionType: brokerOrder.option_type || brokerOrder.right,
  });
}
