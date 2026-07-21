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
// Never scales UP beyond the model's own size. Rounds to whole shares unless
// the broker supports fractional shares (Webull), in which case it keeps the
// fractional quantity down to `precision` decimals.
//
// Pure + deterministic — fully unit-tested.

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

  const qty = roundQtyForBroker(targetQty, { fractional, precision });
  const notional = qty * px;

  if (!(qty > 0) || notional < Number(minNotionalUsd)) {
    return {
      ok: false,
      reason: fractional ? "below_min_notional" : "account_too_small_for_one_share",
      qty: 0,
      model_qty: mq,
      target_qty: targetQty,
      target_notional: targetNotional,
      ratio,
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
  };
}
