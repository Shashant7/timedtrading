/**
 * Join helpers for GET /timed/broker/day-actions.
 *
 * Equity rows already match model account_ledger.position_id to
 * broker_account_ledger.model_trade_id. Options day-trades live in a
 * KV paper book + /bridge/options/order — they must use the same
 * trade_id (= signal_id) so a SELL is tied to the BUY, not an orphan
 * "MIRROR / REJECTED" extra with no reason.
 */

export function extraActionFromLedger(b, accountLabel) {
  const status = String(b?.status || "").toLowerCase();
  const ok = status === "ok" || status === "filled";
  const rec = {
    account: accountLabel || null,
    qty: Number(b?.qty) || 0,
    price: Number(b?.price) || 0,
    value: Number(b?.value) || 0,
    status: b?.status || null,
    reject_reason: b?.reject_reason || null,
    ts: b?.ts,
  };
  return {
    ts: b?.ts,
    mode: "mirror",
    event: String(b?.side || b?.event_type || "ORDER").toUpperCase(),
    ticker: String(b?.ticker || "").toUpperCase(),
    qty: rec.qty,
    price: rec.price,
    value: rec.value,
    mirror: ok ? "mirrored" : "rejected",
    mirror_reason: b?.reject_reason || null,
    fills: ok ? [rec] : [],
    rejects: ok ? [] : [rec],
    account: accountLabel || null,
  };
}

export function modelRowFromDayTradeAction(a) {
  const ev = String(a?.event || "").toUpperCase();
  const event_type = ev === "BUY" ? "ENTRY" : (ev === "TRIM" ? "TRIM" : "EXIT");
  return {
    mode: "trader",
    ts: a?.ts,
    event_type,
    position_id: a?.signal_id || null,
    ticker: String(a?.ticker || "").toUpperCase(),
    qty: Number(a?.contracts) || 1,
    price: Number(a?.premium) || 0,
    cash_delta: 0,
    realized_pnl: 0,
    note: a?.reason || `options_day_trade:${ev}`,
  };
}
