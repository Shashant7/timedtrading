// worker/review/trade-review-legs.js
//
// Turn a trade into the ordered list of LEGS the reviewer grades.
//
// Preferred source is `trade_events` (one row per executed action). Older
// trades — and every row in the archived monthly autopsy books — predate
// that ledger or lost it in a replay reset, so we synthesize legs from the
// summary columns on `trades` when events are missing. A synthesized leg is
// marked so the reviewer knows it is reading a summary, not a receipt.

const LEG_ORDER = { ENTRY: 0, SCALE_IN: 1, TRIM: 2, EXIT: 3 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeEventType(raw) {
  const t = String(raw || "").toUpperCase();
  if (t === "ENTRY" || t === "ENTRY_CORRECTION") return "ENTRY";
  if (t === "SCALE_IN" || t === "ADD_ENTRY") return "SCALE_IN";
  if (t === "TRIM" || t === "TP_HIT_TRIM") return "TRIM";
  if (t === "EXIT" || t === "CLOSE" || t === "STOP" || t === "SL_HIT") return "EXIT";
  return "";
}

/**
 * @param {object} trade  row from `trades` / `backtest_run_trades`
 * @param {Array}  events rows from `trade_events` (may be empty)
 * @returns {Array<{leg_kind,leg_seq,event_id,ts,price,qty_pct,reason,synthesized}>}
 */
export function extractLegs(trade, events = []) {
  const list = Array.isArray(events) ? events : [];
  const mapped = [];
  for (const ev of list) {
    const kind = normalizeEventType(ev?.type);
    if (!kind) continue;
    const ts = num(ev?.ts);
    if (ts == null) continue;
    mapped.push({
      leg_kind: kind === "SCALE_IN" ? "ENTRY" : kind,
      is_scale_in: kind === "SCALE_IN",
      event_id: ev?.event_id || null,
      ts,
      price: num(ev?.price),
      qty_pct: num(ev?.qty_pct_delta),
      pnl_realized: num(ev?.pnl_realized),
      reason: ev?.reason || null,
      synthesized: false,
    });
  }

  if (mapped.length === 0) return synthesizeLegs(trade);

  // A trade whose events lost the exit (replay reset, partial ledger) still
  // needs an exit leg when the trade row says it closed.
  const hasExit = mapped.some((l) => l.leg_kind === "EXIT");
  const exitTs = num(trade?.exit_ts);
  const closed = !["OPEN", "TP_HIT_TRIM"].includes(String(trade?.status || "").toUpperCase());
  if (!hasExit && closed && exitTs != null) {
    mapped.push({
      leg_kind: "EXIT",
      is_scale_in: false,
      event_id: null,
      ts: exitTs,
      price: num(trade?.exit_price),
      qty_pct: null,
      pnl_realized: num(trade?.pnl),
      reason: trade?.exit_reason || null,
      synthesized: true,
    });
  }
  return sequence(mapped);
}

function synthesizeLegs(trade) {
  const out = [];
  const entryTs = num(trade?.entry_ts);
  if (entryTs != null) {
    out.push({
      leg_kind: "ENTRY",
      is_scale_in: false,
      event_id: null,
      ts: entryTs,
      price: num(trade?.entry_price),
      qty_pct: 100,
      pnl_realized: null,
      reason: trade?.setup_name || trade?.entry_path || null,
      synthesized: true,
    });
  }
  const trimTs = num(trade?.trim_ts);
  if (trimTs != null) {
    const pct = num(trade?.trimmed_pct);
    out.push({
      leg_kind: "TRIM",
      is_scale_in: false,
      event_id: null,
      ts: trimTs,
      price: num(trade?.trim_price),
      // trades.trimmed_pct is stored as a fraction (0.5) in some lanes and a
      // percent (50) in others; normalize to percent for the reviewer.
      qty_pct: pct == null ? null : (pct > 0 && pct <= 1 ? pct * 100 : pct),
      pnl_realized: null,
      reason: "trim",
      synthesized: true,
    });
  }
  const exitTs = num(trade?.exit_ts);
  if (exitTs != null) {
    out.push({
      leg_kind: "EXIT",
      is_scale_in: false,
      event_id: null,
      ts: exitTs,
      price: num(trade?.exit_price),
      qty_pct: null,
      pnl_realized: num(trade?.pnl),
      reason: trade?.exit_reason || null,
      synthesized: true,
    });
  }
  return sequence(out);
}

function sequence(legs) {
  const sorted = legs.slice().sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return (LEG_ORDER[a.leg_kind] ?? 9) - (LEG_ORDER[b.leg_kind] ?? 9);
  });
  const counters = { ENTRY: 0, TRIM: 0, EXIT: 0 };
  return sorted.map((leg) => {
    const seq = counters[leg.leg_kind] ?? 0;
    counters[leg.leg_kind] = seq + 1;
    return { ...leg, leg_seq: seq };
  });
}

export function reviewIdFor(tradeId, legKind, legSeq) {
  return `${String(tradeId)}::${String(legKind)}::${Number(legSeq) || 0}`;
}

export function parseReviewId(reviewId) {
  const parts = String(reviewId || "").split("::");
  if (parts.length < 3) return null;
  const seq = Number(parts[parts.length - 1]);
  const legKind = parts[parts.length - 2];
  const tradeId = parts.slice(0, parts.length - 2).join("::");
  if (!tradeId || !legKind || !Number.isFinite(seq)) return null;
  return { tradeId, legKind, legSeq: seq };
}
