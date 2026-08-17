// worker/review/trade-review-capture.js
//
// Deterministic trade forensics. Everything the reviewer says about "how
// much of the move did we capture" is computed HERE, from the tape, and
// handed to the model as fact. The model grades and explains; it never
// invents a number.
//
// Pure functions — no D1, no env — so the math is unit-testable and the
// same code can run over live trades, archived books, or replay rows.

const MS_PER_DAY = 86_400_000;

function num(v) {
  // Number(null) === 0 and Number("") === 0, which would silently turn a
  // missing exit price into a $0 fill. Reject non-numeric inputs first.
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Move in the direction of the trade, always expressed as a percentage of
 * the REFERENCE price (entry for excursions, the swing anchor for the big
 * move). Shorts are not simply "negative longs": a fall from 106 to 90 is a
 * 15.1% gain on the 106 basis, not 17.8% on the 90 basis.
 */
function favPct(reference, price, isLong) {
  const a = num(reference);
  const b = num(price);
  if (a == null || b == null || a === 0) return null;
  return (isLong ? (b - a) / a : (a - b) / a) * 100;
}

function round(n, p = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const m = 10 ** p;
  return Math.round(n * m) / m;
}

/**
 * Largest single favourable swing inside the window — the "big move" the
 * trade was trying to catch. For LONG this is the maximum (high - prior
 * low) drawup; for SHORT the mirror. Returns the anchor and the extreme so
 * the UI can draw it on the chart.
 */
export function findBigMove(bars, direction) {
  const list = Array.isArray(bars) ? bars.filter((b) => num(b?.h) != null && num(b?.l) != null) : [];
  if (list.length < 2) return null;
  const isLong = String(direction || "LONG").toUpperCase() !== "SHORT";

  let anchorIdx = 0;
  let anchorPx = isLong ? num(list[0].l) : num(list[0].h);
  let best = null;

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const extreme = isLong ? num(b.h) : num(b.l);
    const swing = favPct(anchorPx, extreme, isLong);
    if (swing != null && (best == null || swing > best.pct)) {
      best = {
        from_ts: list[anchorIdx].ts ?? null,
        from_price: round(anchorPx, 4),
        to_ts: b.ts ?? null,
        to_price: round(extreme, 4),
        pct: swing,
      };
    }
    const anchorCandidate = isLong ? num(b.l) : num(b.h);
    if (anchorCandidate != null && (isLong ? anchorCandidate < anchorPx : anchorCandidate > anchorPx)) {
      anchorPx = anchorCandidate;
      anchorIdx = i;
    }
  }
  if (!best || !(best.pct > 0)) return null;
  return { ...best, pct: round(best.pct, 2) };
}

/**
 * Excursions measured from the entry price over the bars the position was
 * actually open, plus the heat taken before the payoff arrived.
 */
export function computeExcursions(bars, entryPrice, direction) {
  const ep = num(entryPrice);
  const list = Array.isArray(bars) ? bars : [];
  if (ep == null || list.length === 0) return { mfe_pct: null, mae_pct: null };
  const isLong = String(direction || "LONG").toUpperCase() !== "SHORT";

  let mfe = null;
  let mfeTs = null;
  let mae = null;
  let maeTs = null;
  for (const b of list) {
    const hi = num(b?.h);
    const lo = num(b?.l);
    if (hi == null || lo == null) continue;
    const fav = favPct(ep, isLong ? hi : lo, isLong);
    const adv = favPct(ep, isLong ? lo : hi, isLong);
    if (fav != null && (mfe == null || fav > mfe)) { mfe = fav; mfeTs = b.ts ?? null; }
    if (adv != null && (mae == null || adv < mae)) { mae = adv; maeTs = b.ts ?? null; }
  }

  // Heat before payoff: the worst adverse excursion suffered BEFORE the
  // favourable extreme was reached. A trade that went straight up is a
  // different animal from one that bled 4% first.
  let heat = null;
  if (mfeTs != null) {
    for (const b of list) {
      if ((b?.ts ?? 0) > mfeTs) break;
      const adv = favPct(ep, isLong ? num(b?.l) : num(b?.h), isLong);
      if (adv != null && (heat == null || adv < heat)) heat = adv;
    }
  }

  return {
    mfe_pct: round(mfe, 2),
    mfe_ts: mfeTs,
    mae_pct: round(mae, 2),
    mae_ts: maeTs,
    heat_before_payoff_pct: round(heat, 2),
  };
}

/**
 * Full capture picture for one trade.
 *
 * @param {object} p
 * @param {object} p.trade    trade row (entry/exit price + ts, direction, shares…)
 * @param {Array}  p.bars     candles covering entry → exit + lookahead, ascending ts
 * @param {number} p.lookaheadDays  how far past the exit to look for the move we left behind
 */
export function computeCapture({ trade, bars, lookaheadDays = 10 } = {}) {
  const direction = String(trade?.direction || "LONG").toUpperCase();
  const isLong = direction !== "SHORT";
  const entryPx = num(trade?.entry_price);
  const entryTs = num(trade?.entry_ts);
  const exitPx = num(trade?.exit_price);
  const exitTs = num(trade?.exit_ts);
  const all = (Array.isArray(bars) ? bars : [])
    .filter((b) => num(b?.ts) != null)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  const inTrade = all.filter((b) => (
    (entryTs == null || b.ts >= entryTs) && (exitTs == null || b.ts <= exitTs)
  ));
  const afterExit = exitTs == null ? [] : all.filter((b) => b.ts > exitTs);
  const windowEnd = exitTs == null ? null : exitTs + lookaheadDays * MS_PER_DAY;
  const overlay = all.filter((b) => (
    (entryTs == null || b.ts >= entryTs) && (windowEnd == null || b.ts <= windowEnd)
  ));

  const excursions = computeExcursions(inTrade, entryPx, direction);
  const realizedPct = favPct(entryPx, exitPx, isLong);

  // What the tape did after we were out — the "we exited at 81 and it ran
  // to 100" number.
  let postExitPct = null;
  let postExitTs = null;
  if (exitPx != null && afterExit.length) {
    for (const b of afterExit) {
      const move = favPct(exitPx, isLong ? num(b?.h) : num(b?.l), isLong);
      if (move != null && (postExitPct == null || move > postExitPct)) {
        postExitPct = move;
        postExitTs = b.ts ?? null;
      }
    }
  }

  const bigMove = findBigMove(overlay.length ? overlay : inTrade, direction);
  const captureRatio = (realizedPct != null && excursions.mfe_pct)
    ? realizedPct / excursions.mfe_pct
    : null;
  const bigMoveCapture = (realizedPct != null && bigMove?.pct)
    ? realizedPct / bigMove.pct
    : null;

  const shares = num(trade?.shares);
  const realizedUsd = num(trade?.pnl);

  return {
    direction,
    lookahead_days: lookaheadDays,
    bars_in_trade: inTrade.length,
    bars_after_exit: afterExit.length,
    entry: { ts: entryTs, price: round(entryPx, 4) },
    exit: exitTs == null ? null : { ts: exitTs, price: round(exitPx, 4), reason: trade?.exit_reason || null },
    ...excursions,
    realized_pct: round(realizedPct, 2),
    realized_usd: round(realizedUsd, 2),
    shares: round(shares, 4),
    capture_ratio: round(captureRatio, 3),
    post_exit_pct: round(postExitPct, 2),
    post_exit_extreme_ts: postExitTs,
    big_move: bigMove,
    big_move_capture_ratio: round(bigMoveCapture, 3),
    // Stored engine values, kept alongside so the reviewer can flag a
    // mismatch between what the engine believed and what the tape shows.
    stored_mfe_pct: round(num(trade?.max_favorable_excursion), 2),
    stored_mae_pct: round(num(trade?.max_adverse_excursion), 2),
  };
}

/**
 * Entry-specific geometry: is the stop and target structurally sane, and
 * did we buy the top of the bar.
 */
export function computeEntryGeometry({ entryPrice, stopLoss, takeProfit, direction, entryBar } = {}) {
  const ep = num(entryPrice);
  const sl = num(stopLoss);
  const tp = num(takeProfit);
  const isLong = String(direction || "LONG").toUpperCase() !== "SHORT";
  if (ep == null) return null;

  // Both distances are risk/reward as a percentage of the entry basis.
  const slDist = sl == null ? null : -favPct(ep, sl, isLong);
  const tpDist = tp == null ? null : favPct(ep, tp, isLong);
  const rr = (slDist && tpDist && slDist !== 0) ? tpDist / slDist : null;

  let barPosition = null;
  const hi = num(entryBar?.h);
  const lo = num(entryBar?.l);
  if (hi != null && lo != null && hi > lo) {
    const raw = (ep - lo) / (hi - lo);
    barPosition = round(isLong ? raw : 1 - raw, 3);
  }

  return {
    stop_loss: round(sl, 4),
    take_profit: round(tp, 4),
    sl_distance_pct: round(slDist, 2),
    tp_distance_pct: round(tpDist, 2),
    rr: round(rr, 2),
    // 1.0 = filled at the worst end of the entry bar (bought the high on a
    // long). Chasing shows up here before it shows up in the P&L.
    entry_in_bar_range: barPosition,
  };
}
