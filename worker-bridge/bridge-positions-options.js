/**
 * Helpers for surfacing option holdings on GET /bridge/positions.
 * Equity normalize filters OPTION rows out; this formats them for the
 * Broker Connections holdings list (e.g. SPY 777C 09/20).
 */

export function formatOptionHoldingLabel(op) {
  const und = String(op?.underlying || op?.symbol || "").toUpperCase();
  if (!und) return null;
  const rightRaw = String(op?.option_type || op?.right || "").toUpperCase();
  const right = rightRaw.includes("P") ? "P" : "C";
  const strike = Number(op?.strike);
  const strikeStr = Number.isFinite(strike)
    ? (Math.abs(strike - Math.round(strike)) < 1e-6 ? String(Math.round(strike)) : strike.toFixed(2))
    : null;
  let exp = "";
  const expRaw = op?.expiration || op?.expiry || null;
  if (expRaw) {
    const d = String(expRaw).slice(0, 10);
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    exp = m ? `${m[2]}/${m[3]}` : d;
  }
  const core = strikeStr ? `${und} ${strikeStr}${right}` : `${und} ${right}`;
  return exp ? `${core} ${exp}` : core;
}

export function optionHoldingKey(op) {
  const sym = String(op?.symbol || "").toUpperCase();
  if (sym) return `OPT:${sym}`;
  const label = formatOptionHoldingLabel(op);
  return label ? `OPT:${label}` : null;
}

/** Map a normalized options position into a /bridge/positions item. */
export function optionPositionToHoldingItem(op) {
  const label = formatOptionHoldingLabel(op);
  const key = optionHoldingKey(op);
  if (!label || !key) return null;
  const qty = Number(op?.qty ?? op?.quantity);
  const mv = Number(op?.market_value);
  const avg = Number(op?.avg_cost);
  const upl = Number(op?.unrealized_pnl);
  let last = Number(op?.last_price ?? op?.price);
  // US equity options: market_value is usually premium × 100 × contracts.
  if (!(Number.isFinite(last) && last > 0) && Number.isFinite(mv) && Math.abs(qty) > 0) {
    const perContract = mv / Math.abs(qty);
    last = Math.abs(perContract) >= 50 ? perContract / 100 : perContract;
  }
  const rightRaw = String(op?.option_type || "").toUpperCase();
  return {
    ticker: label,
    underlying: String(op?.underlying || "").toUpperCase() || null,
    instrument: "option",
    option_type: rightRaw.includes("P") ? "PUT" : "CALL",
    strike: Number.isFinite(Number(op?.strike)) ? Number(op.strike) : null,
    expiration: op?.expiration || null,
    managed: false,
    sync_state: "broker_only",
    broker_qty: Number.isFinite(qty) ? qty : null,
    avg_cost: Number.isFinite(avg) ? avg : null,
    last_price: Number.isFinite(last) && last > 0 ? last : null,
    price: Number.isFinite(last) && last > 0 ? last : null,
    market_value: Number.isFinite(mv) ? mv : null,
    unrealized_pnl: Number.isFinite(upl) ? upl : null,
    unrealized_pnl_pct: null,
    day_pnl: null,
  };
}
