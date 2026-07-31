// Weekly ≥10% move-capture autopsy — the scoreboard for breadth.
// plans/continuation-move-capture-slice.plan.md
//
// For each Mon–Fri NY week, find |open→close| or high–low ≥ 10%, join
// trader trades, label TOUCHED / PARTIAL / MISSED + best-effort miss reason.

export const WEEKLY_MOVE_MIN_PCT = 10;
export const WEEKLY_AUTOPSY_KV = "timed:discovery:weekly-move-autopsy";
export const CANARY_TICKERS = ["NBIS", "BE", "DELL", "MU", "CRDO", "OKLO"];

const DAY_MS = 86400000;

export function nyWeekKey(ms) {
  // Monday 00:00 America/New_York → YYYY-MM-DD of that Monday (UTC date string).
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = Number(get("year"));
  const m = Number(get("month"));
  const day = Number(get("day"));
  const wd = String(get("weekday") || "");
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = wdMap[wd] ?? 1;
  // Days since Monday
  const sinceMon = dow === 0 ? 6 : dow - 1;
  const utcNoon = Date.UTC(y, m - 1, day, 12, 0, 0);
  const mon = new Date(utcNoon - sinceMon * DAY_MS);
  return mon.toISOString().slice(0, 10);
}

export function weekBoundsMs(weekKey) {
  // weekKey is Monday YYYY-MM-DD; treat as NY session Mon open → Fri close.
  const [y, m, d] = String(weekKey).split("-").map(Number);
  if (!y || !m || !d) return null;
  // Approximate: Monday 00:00 ET ≈ Monday 05:00 UTC (EDT) / 04:00 (EST).
  // Use UTC Monday 00:00 → Saturday 00:00 for overlap; trades use ms anyway.
  const start = Date.UTC(y, m - 1, d, 0, 0, 0);
  const end = start + 5 * DAY_MS; // through Friday
  return { start, end };
}

/**
 * Pure: detect weekly moves ≥ minPct from daily candles (chronological).
 * @returns {Array<{week_key, direction, oc_pct, range_pct, move_pct, open, high, low, close, days}>}
 */
export function detectWeeklyMoves(dailyCandles = [], opts = {}) {
  const minPct = Number(opts.minPct) > 0 ? Number(opts.minPct) : WEEKLY_MOVE_MIN_PCT;
  const byWeek = new Map();
  for (const c of dailyCandles || []) {
    const ts = Number(c.ts ?? c.t);
    const o = Number(c.o ?? c.open);
    const h = Number(c.h ?? c.high);
    const l = Number(c.l ?? c.low);
    const cl = Number(c.c ?? c.close);
    if (!Number.isFinite(ts) || !(o > 0) || !(cl > 0)) continue;
    const wk = nyWeekKey(ts);
    if (!wk) continue;
    let g = byWeek.get(wk);
    if (!g) {
      g = { week_key: wk, open: o, high: h, low: l, close: cl, days: 0, first_ts: ts, last_ts: ts };
      byWeek.set(wk, g);
    } else {
      if (Number.isFinite(h)) g.high = Math.max(g.high, h);
      if (Number.isFinite(l)) g.low = Math.min(g.low, l);
      g.close = cl;
      g.last_ts = ts;
    }
    g.days += 1;
  }

  const out = [];
  for (const g of byWeek.values()) {
    if (g.days < 2) continue;
    const ocPct = ((g.close - g.open) / g.open) * 100;
    const rangePct = ((g.high - g.low) / g.open) * 100;
    const movePct = Math.max(Math.abs(ocPct), rangePct);
    if (movePct < minPct) continue;
    out.push({
      week_key: g.week_key,
      direction: ocPct >= 0 ? "LONG" : "SHORT",
      oc_pct: Math.round(ocPct * 100) / 100,
      range_pct: Math.round(rangePct * 100) / 100,
      move_pct: Math.round(movePct * 100) / 100,
      open: g.open,
      high: g.high,
      low: g.low,
      close: g.close,
      days: g.days,
      first_ts: g.first_ts,
      last_ts: g.last_ts,
    });
  }
  out.sort((a, b) => (a.week_key < b.week_key ? 1 : -1));
  return out;
}

function tradeOverlapsWeek(trade, bounds) {
  if (!trade || !bounds) return false;
  const entry = Number(trade.entry_ts);
  const exit = Number(trade.exit_ts) || Date.now();
  if (!Number.isFinite(entry)) return false;
  return entry < bounds.end && exit >= bounds.start;
}

function sameDir(tradeDir, moveDir) {
  const a = String(tradeDir || "LONG").toUpperCase();
  const b = String(moveDir || "LONG").toUpperCase();
  return a === b;
}

/**
 * Classify one weekly move vs overlapping trades.
 * PARTIAL = touched same direction but |pnl| < 30% of move_pct (or MFE < 40% of move).
 */
export function classifyWeeklyCapture(move, trades = [], opts = {}) {
  const bounds = weekBoundsMs(move.week_key);
  const overlapping = (trades || []).filter((t) => tradeOverlapsWeek(t, bounds));
  const aligned = overlapping.filter((t) => sameDir(t.direction, move.direction));
  if (!aligned.length) {
    return {
      label: "MISSED",
      trades_n: overlapping.length,
      aligned_n: 0,
      best_pnl_pct: null,
      best_mfe_pct: null,
      trade_ids: [],
    };
  }
  let bestPnl = null;
  let bestMfe = null;
  const ids = [];
  for (const t of aligned) {
    ids.push(t.trade_id || t.id);
    const pnl = Number(t.pnl_pct);
    const mfe = Number(t.max_favorable_excursion ?? t.mfe_pct);
    if (Number.isFinite(pnl) && (bestPnl == null || pnl > bestPnl)) bestPnl = pnl;
    if (Number.isFinite(mfe) && (bestMfe == null || mfe > bestMfe)) bestMfe = mfe;
  }
  const moveAbs = Math.abs(Number(move.move_pct) || 0);
  const pnlKeep = bestPnl != null && moveAbs > 0 ? bestPnl / moveAbs : null;
  const mfeKeep = bestMfe != null && moveAbs > 0 ? bestMfe / moveAbs : null;
  const partialThresh = Number(opts.partialPnlFrac) || 0.3;
  const partialMfe = Number(opts.partialMfeFrac) || 0.4;
  const isPartial = (pnlKeep != null && pnlKeep < partialThresh)
    && (mfeKeep == null || mfeKeep < partialMfe);
  return {
    label: isPartial ? "PARTIAL" : "TOUCHED",
    trades_n: overlapping.length,
    aligned_n: aligned.length,
    best_pnl_pct: bestPnl != null ? Math.round(bestPnl * 100) / 100 : null,
    best_mfe_pct: bestMfe != null ? Math.round(bestMfe * 100) / 100 : null,
    pnl_vs_move: pnlKeep != null ? Math.round(pnlKeep * 1000) / 1000 : null,
    mfe_vs_move: mfeKeep != null ? Math.round(mfeKeep * 1000) / 1000 : null,
    trade_ids: ids.filter(Boolean),
  };
}

/** Best-effort miss reason from scored payload snapshot. */
export function classifyMissReason(payload = {}, move = {}) {
  if (!payload || typeof payload !== "object" || !Object.keys(payload).length) {
    return "not_scored";
  }
  const rank = Number(payload.rank ?? payload.rank_position);
  const regime = String(payload.regime_class || payload._monthly_cycle?.phase || "").toUpperCase();
  const state = String(payload.state || "").toUpperCase();
  const dir = String(move.direction || "LONG").toUpperCase();
  const wantBull = dir === "LONG";
  const aligned = wantBull
    ? state === "HTF_BULL_LTF_BULL" || state === "HTF_BULL_LTF_PULLBACK"
    : state === "HTF_BEAR_LTF_BEAR" || state === "HTF_BEAR_LTF_PULLBACK";

  if (regime.includes("LATE_BULL") && wantBull) return "late_bull_block";
  if (Number.isFinite(rank) && rank > 0 && rank < 65) return "low_rank";
  if (!aligned) return "wrong_state";
  const stage = String(payload.kanban_stage || "").toLowerCase();
  if (["watch", "setup", "setup_watch", "watching"].includes(stage)) return "confirm_lag";
  if (!payload.setup_name && !payload.entry_path && !payload.setup_gates) return "no_setup";
  return "unknown";
}

/**
 * Pure aggregator for one universe pass.
 */
export function buildWeeklyAutopsyReport({
  tickerMoves = [], // [{ticker, moves: detectWeeklyMoves(...), trades, payload}]
  minPct = WEEKLY_MOVE_MIN_PCT,
  weeks = 8,
  canary = CANARY_TICKERS,
} = {}) {
  const rows = [];
  for (const tm of tickerMoves || []) {
    const ticker = String(tm.ticker || "").toUpperCase();
    if (!ticker) continue;
    for (const move of tm.moves || []) {
      const cap = classifyWeeklyCapture(move, tm.trades || []);
      const missReason = cap.label === "MISSED"
        ? classifyMissReason(tm.payload || {}, move)
        : null;
      rows.push({
        ticker,
        ...move,
        capture: cap.label,
        miss_reason: missReason,
        best_pnl_pct: cap.best_pnl_pct,
        best_mfe_pct: cap.best_mfe_pct,
        pnl_vs_move: cap.pnl_vs_move,
        mfe_vs_move: cap.mfe_vs_move,
        trade_ids: cap.trade_ids,
        canary: canary.includes(ticker),
      });
    }
  }

  // Keep newest N distinct week_keys
  const weekKeys = [...new Set(rows.map((r) => r.week_key))].sort().reverse().slice(0, weeks);
  const weekSet = new Set(weekKeys);
  const filtered = rows.filter((r) => weekSet.has(r.week_key));

  const totals = { moves: filtered.length, TOUCHED: 0, PARTIAL: 0, MISSED: 0 };
  const byReason = {};
  for (const r of filtered) {
    totals[r.capture] = (totals[r.capture] || 0) + 1;
    if (r.miss_reason) byReason[r.miss_reason] = (byReason[r.miss_reason] || 0) + 1;
  }
  const captureRate = totals.moves > 0
    ? Math.round(((totals.TOUCHED + totals.PARTIAL) / totals.moves) * 1000) / 10
    : null;

  const canaryRows = filtered.filter((r) => r.canary);
  const canaryMissed = canaryRows.filter((r) => r.capture === "MISSED").length;

  return {
    ok: true,
    min_pct: minPct,
    weeks: weekKeys.length,
    week_keys: weekKeys,
    summary: {
      moves: totals.moves,
      touched: totals.TOUCHED || 0,
      partial: totals.PARTIAL || 0,
      missed: totals.MISSED || 0,
      capture_rate_pct: captureRate,
      miss_reasons: byReason,
      canary_moves: canaryRows.length,
      canary_missed: canaryMissed,
      canary_miss_rate_pct: canaryRows.length
        ? Math.round((canaryMissed / canaryRows.length) * 1000) / 10
        : null,
    },
    canary: canaryRows.slice(0, 40),
    top_missed: filtered
      .filter((r) => r.capture === "MISSED")
      .sort((a, b) => b.move_pct - a.move_pct)
      .slice(0, 25),
    sample: filtered.slice(0, 40),
    generated_at: Date.now(),
  };
}

/**
 * D1 loader — universe from ticker_candles daily + trades join.
 */
export async function loadWeeklyMoveAutopsy(env, opts = {}) {
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };
  const weeks = Math.min(Math.max(Number(opts.weeks) || 8, 1), 26);
  const minPct = Number(opts.minPct) > 0 ? Number(opts.minPct) : WEEKLY_MOVE_MIN_PCT;
  const lookbackDays = weeks * 7 + 14;
  const since = Date.now() - lookbackDays * DAY_MS;
  const canary = Array.isArray(opts.canary) ? opts.canary : CANARY_TICKERS;
  const limitTickers = Number(opts.limitTickers) || 320;

  let tickers = [];
  try {
    tickers = (await db.prepare(
      `SELECT DISTINCT ticker FROM ticker_candles
        WHERE tf = 'D' AND ts >= ?1
        ORDER BY ticker LIMIT ?2`,
    ).bind(since, limitTickers).all())?.results || [];
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  // Prefer canary first for early signal, then rest.
  const ordered = [
    ...canary.map((t) => ({ ticker: t })),
    ...tickers.filter((r) => !canary.includes(String(r.ticker || "").toUpperCase())),
  ];
  const seen = new Set();
  const tickerMoves = [];

  for (const row of ordered) {
    const ticker = String(row.ticker || "").toUpperCase();
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    if (seen.size > limitTickers) break;

    let candles = [];
    try {
      candles = (await db.prepare(
        `SELECT ts, o, h, l, c FROM ticker_candles
          WHERE ticker = ?1 AND tf = 'D' AND ts >= ?2
          ORDER BY ts ASC`,
      ).bind(ticker, since).all())?.results || [];
    } catch { continue; }

    const moves = detectWeeklyMoves(candles, { minPct });
    if (!moves.length && !canary.includes(ticker)) continue;

    let trades = [];
    try {
      trades = (await db.prepare(
        `SELECT trade_id, ticker, direction, status, pnl_pct, entry_ts, exit_ts,
                max_favorable_excursion
           FROM trades
          WHERE ticker = ?1 AND (run_id IS NULL OR run_id = '')
            AND entry_ts >= ?2`,
      ).bind(ticker, since - 14 * DAY_MS).all())?.results || [];
    } catch {
      try {
        trades = (await db.prepare(
          `SELECT trade_id, ticker, direction, status, pnl_pct, entry_ts, exit_ts
             FROM trades
            WHERE ticker = ?1 AND (run_id IS NULL OR run_id = '')
              AND entry_ts >= ?2`,
        ).bind(ticker, since - 14 * DAY_MS).all())?.results || [];
      } catch { trades = []; }
    }

    let payload = null;
    try {
      const prow = await db.prepare(
        `SELECT payload_json FROM ticker_latest WHERE ticker = ?1`,
      ).bind(ticker).first();
      if (prow?.payload_json) payload = JSON.parse(prow.payload_json);
    } catch { /* */ }

    if (moves.length) {
      tickerMoves.push({ ticker, moves, trades, payload });
    }
  }

  return buildWeeklyAutopsyReport({ tickerMoves, minPct, weeks, canary });
}

export async function refreshWeeklyMoveAutopsy(env, opts = {}) {
  const report = await loadWeeklyMoveAutopsy(env, opts);
  if (!report?.ok) return report;
  const kv = env.KV || env.KV_TIMED || env.TICKER_KV;
  if (kv?.put) {
    try {
      await kv.put(WEEKLY_AUTOPSY_KV, JSON.stringify(report), { expirationTtl: 14 * 86400 });
    } catch { /* */ }
  }
  return report;
}
