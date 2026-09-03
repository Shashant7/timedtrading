// worker-bridge/bridge-sizing.js
//
// 2026-07-21 — Relational position sizing for the broker mirror.
//
// The model sizes every trade against its own book (default $100k). A real
// account is usually smaller (e.g. a Webull Roth IRA ~$16.5k). Mirroring the
// model's raw share count would massively over-allocate the small account
// (17 AMZN shares = $4,399 = ~27% of a $16.5k Roth vs ~4.4% of the $100k model).
//
// computeRelationalQty scales the model qty so the SAME fraction of capital is
// deployed on the real account:
//   - If the model tells us its "% of account" (model_account_pct), apply that
//     % directly to the real account equity (most faithful to model intent).
//   - Else scale by ratio = account_equity / model_book_usd.
// Never scales UP beyond the model's own size.
//
// 2026-09-03 — Webull preference: buy whole shares when cash allows
// (1.623 → 2). Keep fractional only for high-priced names (LLY-class)
// where one share is a large slice of the account. Fractionals are
// RTH-only on Webull — callers must pass fractional=false outside RTH.
//
// Pure + deterministic — fully unit-tested.

/** Default: 1 share ≥ $400 or ≥ 8% of equity counts as "expensive". */
export const WHOLE_SHARE_HIGH_PRICE_USD = 400;
export const WHOLE_SHARE_HIGH_EQUITY_PCT = 0.08;
/** Allow round-up to spend up to 15% more than the relational target. */
export const WHOLE_SHARE_ROUND_UP_SLACK = 1.15;

/** Round a share quantity for a broker: fractional (down to precision) or whole. */
export function roundQtyForBroker(qty, { fractional = false, precision = 5 } = {}) {
  const q = Number(qty);
  if (!(q > 0)) return 0;
  if (fractional) {
    const f = Math.pow(10, Math.max(0, Math.min(9, precision)));
    return Math.floor(q * f) / f; // round DOWN — never over-allocate
  }
  return Math.floor(q);
}

/**
 * Prefer whole shares on buys. Round UP when affordable; otherwise floor
 * to a whole share. Keep a sub-share fractional only for expensive names
 * (LLY-class) when the broker allows fractionals (RTH).
 *
 * @returns {{ qty: number, mode: string, reason?: string }}
 */
export function preferWholeShareQty({
  qty,
  price,
  accountEquity = null,
  cashCeilingUsd = null,
  targetNotionalUsd = null,
  maxQty = Infinity,
  allowFractional = true,
  highPriceUsd = WHOLE_SHARE_HIGH_PRICE_USD,
  highShareEquityPct = WHOLE_SHARE_HIGH_EQUITY_PCT,
  roundUpSlack = WHOLE_SHARE_ROUND_UP_SLACK,
  precision = 5,
} = {}) {
  const q = Number(qty);
  const px = Number(price);
  if (!(q > 0)) return { qty: 0, mode: "zero" };
  if (Math.abs(q - Math.round(q)) < 1e-9) {
    return { qty: Math.round(q), mode: "already_whole" };
  }

  const ceilQ = Math.ceil(q - 1e-9);
  const floorQ = Math.floor(q + 1e-9);
  // Round-up affordability: cash ceiling (when known) + model qty cap.
  // Do NOT clamp round-up to targetNotional — 1.623 → 2 is a ~23% bump
  // that is exactly the whole-share preference. targetNotional slack is
  // only a soft hint when no cash ceiling is supplied.
  const spendCap = (() => {
    if (Number.isFinite(Number(cashCeilingUsd)) && Number(cashCeilingUsd) > 0) {
      return Number(cashCeilingUsd);
    }
    if (Number.isFinite(Number(targetNotionalUsd)) && Number(targetNotionalUsd) > 0) {
      // Wide slack so typical fractional leftovers (1.2–1.9) still round up.
      return Number(targetNotionalUsd) * Math.max(Number(roundUpSlack) || 1.15, 1.35);
    }
    return null;
  })();

  const affordable = (shares) => {
    if (!(shares > 0)) return false;
    if (Number.isFinite(Number(maxQty)) && shares > Number(maxQty) + 1e-9) return false;
    if (!(px > 0)) return true;
    if (spendCap != null) return shares * px <= spendCap + 1e-6;
    return true;
  };

  // Whole-share-only brokers (or ETH): floor, never round up past the target.
  if (!allowFractional) {
    if (floorQ >= 1 && affordable(floorQ)) {
      return { qty: floorQ, mode: "round_down" };
    }
    return {
      qty: 0,
      mode: "unaffordable",
      reason: "account_too_small_for_one_share",
    };
  }

  if (ceilQ >= 1 && affordable(ceilQ)) {
    return { qty: ceilQ, mode: "round_up" };
  }
  if (floorQ >= 1 && affordable(floorQ)) {
    return { qty: floorQ, mode: "round_down" };
  }

  // Sub-share leftover: only path left for whole shares is 0. Keep
  // fractional in RTH (Webull) — LLY-class names and tiny-cash books
  // (e.g. $92 Roth / TJX) both land here. Outside RTH callers pass
  // allowFractional=false and we reject instead of placing a fractional.
  if (allowFractional && floorQ < 1 && affordable(q)) {
    const eq = Number(accountEquity) || 0;
    const expensive = (px >= Number(highPriceUsd))
      || (eq > 0 && px / eq >= Number(highShareEquityPct));
    return {
      qty: roundQtyForBroker(q, { fractional: true, precision }),
      mode: expensive ? "fractional_expensive" : "fractional_subshare",
    };
  }

  return {
    qty: 0,
    mode: "unaffordable",
    reason: floorQ < 1 ? "account_too_small_for_one_share" : "cash_ceiling",
  };
}

/**
 * Scale a model order to a real account.
 * @returns {{ok, qty, scaled, fractional_used, ratio, model_qty, target_qty,
 *            target_notional, reason}}
 */
export function computeRelationalQty({
  modelQty,
  entryPrice,
  accountEquity,
  modelBookUsd = 100000,
  modelAccountPct = null,
  fractional = false,
  precision = 5,
  minNotionalUsd = 1,
} = {}) {
  const mq = Number(modelQty);
  const px = Number(entryPrice);
  const eq = Number(accountEquity);
  const book = Number(modelBookUsd) > 0 ? Number(modelBookUsd) : 100000;

  if (!(mq > 0)) return { ok: false, reason: "invalid_model_qty", qty: 0 };
  // Without a price or account equity we can't compute a relational size —
  // signal the caller to fall back to cap-only behavior rather than guess.
  if (!(px > 0)) return { ok: false, reason: "missing_entry_price", qty: mq, scaled: false, fallback: true };
  if (!(eq > 0)) return { ok: false, reason: "missing_account_equity", qty: mq, scaled: false, fallback: true };

  const ratio = eq / book;
  let targetNotional;
  const pctRaw = Number(modelAccountPct);
  if (Number.isFinite(pctRaw) && pctRaw > 0) {
    // Accept either a fraction (0.044) or a percent (4.4).
    const pct = pctRaw > 1 ? pctRaw / 100 : pctRaw;
    targetNotional = eq * pct;
  } else {
    // Scale the model notional by the account/book ratio, capped at 1x
    // (never take more risk than the model's own sizing).
    targetNotional = mq * px * Math.min(1, ratio);
  }

  let targetQty = targetNotional / px;
  targetQty = Math.min(targetQty, mq); // never upscale past the model qty

  // Webull buys: prefer whole shares (round up when cash/target allows).
  // Outside RTH callers pass fractional=false so this path floors.
  const preferred = preferWholeShareQty({
    qty: targetQty,
    price: px,
    accountEquity: eq,
    targetNotionalUsd: targetNotional,
    maxQty: mq,
    allowFractional: fractional,
    precision,
  });
  const qty = preferred.qty;
  const notional = qty * px;

  if (!(qty > 0) || notional < Number(minNotionalUsd)) {
    return {
      ok: false,
      reason: preferred.reason
        || (fractional ? "below_min_notional" : "account_too_small_for_one_share"),
      qty: 0,
      model_qty: mq,
      target_qty: targetQty,
      target_notional: targetNotional,
      ratio,
      whole_share_mode: preferred.mode,
    };
  }

  return {
    ok: true,
    qty,
    scaled: qty < mq,
    fractional_used: fractional && !Number.isInteger(qty),
    ratio,
    model_qty: mq,
    target_qty: targetQty,
    target_notional: targetNotional,
    whole_share_mode: preferred.mode,
  };
}
