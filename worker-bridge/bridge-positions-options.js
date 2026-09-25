/**
 * Helpers for surfacing option holdings on GET /bridge/positions and
 * GET /bridge/portfolio. Equity normalize filters OPTION rows out; this
 * formats them for Broker Connections and Mission Control (e.g. SPY 777C 09/20).
 */

export function formatOptionHoldingLabel(op) {
  const und = String(op?.underlying || op?.symbol || "").toUpperCase();
  if (!und) return null;
  const rightRaw = String(op?.option_type || op?.right || "").toUpperCase().replace(/[^A-Z]/g, "");
  // Explicit CALL/PUT — do not use includes("P") on "CALL" (safe today) or
  // fuzzy matching that could flip rights on odd broker strings. An
  // unreadable right reads "?" rather than quietly rendering every holding
  // as a call, which is what hid the unparsed Webull puts.
  let right = "?";
  if (rightRaw === "P" || rightRaw === "PUT" || rightRaw.startsWith("PUT")) right = "P";
  else if (rightRaw === "C" || rightRaw === "CALL" || rightRaw.startsWith("CALL")) right = "C";
  else if (rightRaw.includes("PUT")) right = "P";
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
  const qty = Number(op?.qty ?? op?.quantity ?? op?.broker_qty ?? op?.position);
  const mv = Number(op?.market_value);
  const avg = Number(op?.avg_cost);
  const upl = Number(op?.unrealized_pnl);
  let last = Number(op?.last_price ?? op?.price);
  // US equity options: market_value is usually premium × 100 × contracts.
  if (!(Number.isFinite(last) && last > 0) && Number.isFinite(mv) && Math.abs(qty) > 0) {
    const perContract = mv / Math.abs(qty);
    last = Math.abs(perContract) >= 50 ? perContract / 100 : perContract;
  }
  const rightRaw = String(op?.option_type || "").toUpperCase().replace(/[^A-Z]/g, "");
  let optionType = null;
  if (rightRaw === "P" || rightRaw === "PUT" || rightRaw.startsWith("PUT") || rightRaw.includes("PUT")) {
    optionType = "PUT";
  } else if (rightRaw === "C" || rightRaw.startsWith("CALL")) {
    optionType = "CALL";
  }
  // Number(null/undefined) === 0 — only keep avg_cost when the source set it.
  const avgCost = (op?.avg_cost != null && op?.avg_cost !== "" && Number.isFinite(avg)) ? avg : null;
  const uplOut = (op?.unrealized_pnl != null && op?.unrealized_pnl !== "" && Number.isFinite(upl)) ? upl : null;
  const mvOut = (op?.market_value != null && op?.market_value !== "" && Number.isFinite(mv)) ? mv : null;
  return {
    ticker: label,
    underlying: String(op?.underlying || "").toUpperCase() || null,
    instrument: "option",
    option_type: optionType,
    strike: Number.isFinite(Number(op?.strike)) ? Number(op.strike) : null,
    expiration: op?.expiration || null,
    managed: false,
    sync_state: "broker_only",
    broker_qty: Number.isFinite(qty) ? qty : null,
    avg_cost: avgCost,
    last_price: Number.isFinite(last) && last > 0 ? last : null,
    price: Number.isFinite(last) && last > 0 ? last : null,
    market_value: mvOut,
    unrealized_pnl: uplOut,
    unrealized_pnl_pct: null,
    day_pnl: null,
  };
}

/** True when a broker row is an option contract, not a share lot. */
export function looksLikeOptionPosition(p) {
  if (!p || typeof p !== "object") return false;
  if (String(p.instrument || "").toLowerCase() === "option") return true;
  if (p.option_type || p.optionType || p.putOrCall) return true;
  const strike = Number(p.strike ?? p.strike_price ?? p.strikePrice);
  if (Number.isFinite(strike) && strike > 0 && (p.expiration || p.expiry || p.option_expire_date)) {
    return true;
  }
  const ac = String(p.assetClass || p.asset_class || p.secType || p.sec_type || "").toUpperCase();
  return ac === "OPT" || ac === "OPTION" || ac === "FOP";
}

function ibkrishToOptionPosition(p) {
  if (!p || typeof p !== "object") return null;
  const und = String(p.ticker || p.symbol || p.underlying || "").toUpperCase();
  return {
    symbol: String(p.contractDesc || p.contract_desc || p.symbol || p.ticker || "").toUpperCase() || und,
    underlying: und || null,
    qty: p.position ?? p.qty ?? p.quantity ?? p.broker_qty,
    option_type: p.option_type || p.optionType || p.putOrCall || p.right || null,
    strike: p.strike ?? p.strike_price ?? p.strikePrice ?? null,
    expiration: p.expiration || p.expiry || p.option_expire_date || p.lastTradingDay || null,
    avg_cost: p.avg_cost ?? p.avgCost ?? p.average_cost ?? null,
    unrealized_pnl: p.unrealized_pnl ?? p.unrealizedPnl ?? p.unrealized_profit_loss ?? null,
    market_value: p.market_value ?? p.mktValue ?? p.marketValue ?? null,
    last_price: p.last_price ?? p.price ?? p.lastPrice ?? null,
  };
}

/**
 * Pull option holdings off a getEquityPositions result (Webull bundles
 * them as `.options` on the same GET) or a getOptionsPositions result
 * (`.positions` are already option rows). IBKR keeps options inside
 * `response` with assetClass OPT.
 */
export function extractOptionsFromPositionsResult(res) {
  if (!res || typeof res !== "object" || Array.isArray(res)) return [];
  if (Array.isArray(res.options)) return res.options;
  if (Array.isArray(res.options_positions)) return res.options_positions;
  // Dedicated options fetch: { ok, positions: optionRows } and no .options.
  // Require every row to look like an option so an equity book is never
  // re-labelled as contracts.
  if (Array.isArray(res.positions)
      && res.positions.length
      && res.positions.every(looksLikeOptionPosition)) {
    return res.positions;
  }
  if (Array.isArray(res.response)) {
    return res.response.filter(looksLikeOptionPosition).map((row) => (
      row.underlying && (row.option_type || row.qty != null)
        ? row
        : ibkrishToOptionPosition(row)
    ));
  }
  return [];
}

/**
 * Stamp options_positions + options_count onto a /bridge/portfolio user
 * row. Mission Control merges these into the per-account Open positions
 * table. Does not change positions_count (that stays equity-only).
 */
export function attachPortfolioOptions(summary, positionsResult) {
  const target = summary && typeof summary === "object" ? summary : {};
  const raw = extractOptionsFromPositionsResult(positionsResult);
  const seen = new Set();
  const items = [];
  for (const op of raw) {
    const item = optionPositionToHoldingItem(op);
    if (!item) continue;
    const key = optionHoldingKey(op) || `OPT:${item.ticker}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  target.options_positions = items;
  target.options_count = items.length;
  return target;
}
