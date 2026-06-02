/* 2026-06-02 — Move Discovery (worker-native, COO-driven)

   What this does:
     Scans the universe's daily candles over a rolling window (default
     60 days), finds price moves >= MIN_ATR_MULT * ATR(14), and joins
     them against closed trades to compute:

       • FULL        — entered in first 30% of move, exited >= 60% in
       • PARTIAL     — single trade overlapped move but mis-timed
       • CHURNED     — 2+ overlapping trades (whipsaws inside a single move)
       • MISSED      — no overlapping trade → opportunity cost

   Why this exists:
     scripts/discover-moves.js was a CLI-only ritual: the operator had
     to SSH in, run `USE_D1=1 node scripts/discover-moves.js --upload`,
     wait, then look at the dashboard. Nothing ever ran automatically.
     The dashboard would go weeks (3+ months in the last instance)
     showing 'stale' data with no adaptation.

   The COO calls runMoveDiscovery() daily after calibration and self-
   heal. Output writes to KV `timed:move-discovery` (same shape the
   system-intelligence UI already consumes) so existing dashboard
   panels just go fresh.

   Scope intentionally narrowed for in-worker execution:
     • 60-day window (vs script's full history)
     • Skip trail_5m_facts enrichment (too many rows for worker CPU
       budget; the script averages 60-90s on a laptop)
     • Hard cap at 200 tickers (whole universe is typically <300)
     • No-op gracefully if D1 unavailable

   Designed to complete in well under the cron CPU budget. The full
   pre-existing CLI is still useful for backtests/ad-hoc deep dives. */

const DEFAULT_WINDOW_DAYS = 60;
const MIN_ATR_MULT = 3;
const WINDOWS = [5, 10, 20, 40];
const MAX_TICKERS = 200;

function computeATR(candles, period = 14) {
  const atrs = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    );
    if (i < period) atrs[i] = atrs[i - 1] + (tr - atrs[i - 1]) / i;
    else atrs[i] = atrs[i - 1] + (tr - atrs[i - 1]) / period;
  }
  return atrs;
}

function rnd(v, dp = 2) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function pct(n, d) { return d > 0 ? rnd(n / d * 100, 1) : 0; }
function dateStr(ts) { return new Date(ts > 1e12 ? ts : ts * 1000).toISOString().slice(0, 10); }

/* 2026-06-02 — Convert Discovery findings into actionable recommendations.

   Operator question: "It seems like a dead end? What can happen next?
   How can we use this info to improve?"

   This is the bridge from "we missed 540 moves" → "here's the knob
   to turn to catch the next batch of similar moves." Each
   recommendation:
     • Targets a specific miss bucket (out-of-universe, in-universe
       low-score, churn, etc.)
     • Names the model_config knob to change + current + suggested
     • Estimates expected captures (rough heuristic, NOT a backtest)
     • Confidence + tier (1=auto, 2=operator approval, 3=info)

   The UI surfaces these as a "Next Actions" panel on the Discovery
   page; the COO logs them as tier-2 actions in the audit trail. */
async function buildRecommendations({
  env, missedDetails, inUnivMissed, outUnivMissed,
  churnDetails, capturedFull, capturedPartial, missedCount, churned, totalMoves,
}) {
  const recs = [];
  if (totalMoves === 0) return recs;

  /* Read current knob values from model_config so the recommendations
     are framed as deltas from the live config, not hardcoded defaults. */
  async function readKnob(key, defaultVal) {
    try {
      const db = env?.DB;
      if (!db) return defaultVal;
      const row = await db.prepare(`SELECT config_value FROM model_config WHERE config_key = ?1`)
        .bind(key).first().catch(() => null);
      if (!row) return defaultVal;
      const num = Number(row.config_value);
      return Number.isFinite(num) ? num : defaultVal;
    } catch { return defaultVal; }
  }

  /* Rec A — Lots of OUT-OF-UNIVERSE missed moves. Tells us the
     screener bar is too high or the cadence too slow. */
  if (outUnivMissed.length >= 5 && outUnivMissed.length / Math.max(1, missedCount) >= 0.20) {
    const bigOut = outUnivMissed.filter((m) => Math.abs(m.move_pct) >= 8).length;
    recs.push({
      id: "lower_screener_threshold",
      tier: 2,
      type: "knob_change",
      title: `Lower screener auto-promote threshold (${outUnivMissed.length} misses outside universe)`,
      rationale: `${outUnivMissed.length} missed moves happened on tickers not in our universe. ${bigOut} of them were ≥8% — major opportunity cost. Lowering the COO's auto-promote score floor would surface candidate tickers earlier.`,
      knob_path: "COO_SCREENER_AUTO_SCORE",
      current_value: Number(env?.COO_SCREENER_AUTO_SCORE) || 70,
      suggested_value: Math.max(60, (Number(env?.COO_SCREENER_AUTO_SCORE) || 70) - 5),
      expected_captures: Math.round(outUnivMissed.length * 0.35),
      confidence: outUnivMissed.length >= 20 ? "high" : "medium",
      example_tickers: outUnivMissed.slice(0, 5).map((m) => `${m.ticker} ${m.move_pct}%`),
    });
  }

  /* Rec B — Lots of IN-UNIVERSE missed moves. The ticker WAS being
     watched but no entry fired. Likely score threshold too strict. */
  if (inUnivMissed.length >= 10) {
    const big = inUnivMissed.filter((m) => Math.abs(m.move_pct) >= 8).length;
    const cur = await readKnob("deep_audit_investor_accumulate_strong_score_min", 70);
    recs.push({
      id: "lower_investor_accumulate_strong_score",
      tier: 2,
      type: "knob_change",
      title: `Relax investor accumulate score floor ${cur} → ${Math.max(60, cur - 5)}`,
      rationale: `${inUnivMissed.length} missed moves were on tickers already in our universe — we watched them but didn't enter. ${big} were ≥8% moves. The accumulate score threshold is likely too strict for the current regime.`,
      knob_path: "deep_audit_investor_accumulate_strong_score_min",
      current_value: cur,
      suggested_value: Math.max(60, cur - 5),
      expected_captures: Math.round(inUnivMissed.length * 0.40),
      confidence: inUnivMissed.length >= 25 ? "high" : "medium",
      example_tickers: inUnivMissed.slice(0, 5).map((m) => `${m.ticker} ${m.move_pct}%`),
    });
  }

  /* Rec C — High churn rate. We're entering AND exiting within the
     same move, leaving upside on the table. Recommend widening
     trailing-stop or TP1 distance. */
  if (churned >= 3 && churnDetails.length > 0) {
    const totalMissedUpside = churnDetails.reduce((s, c) => s + (c.missed_upside || 0), 0);
    recs.push({
      id: "widen_trailing_stop",
      tier: 2,
      type: "knob_change",
      title: `Widen trailing stop to reduce ${churned} churn events`,
      rationale: `${churned} moves were entered AND exited prematurely — leaving ~${rnd(totalMissedUpside)}% combined upside on the table. The trailing-stop multiplier may be too tight for the current regime.`,
      knob_path: "deep_audit_trail_atr_mult",
      current_value: await readKnob("deep_audit_trail_atr_mult", 2.0),
      suggested_value: await readKnob("deep_audit_trail_atr_mult", 2.0) + 0.5,
      expected_captures: 0,
      expected_impact: `+${rnd(totalMissedUpside * 0.5)}% reclaimed upside`,
      confidence: churned >= 8 ? "high" : "medium",
      example_tickers: churnDetails.slice(0, 5).map((c) => `${c.ticker} (${c.trade_count} trades, ${c.missed_upside}% missed)`),
    });
  }

  /* Rec D — Capture rate is critically low. Suggest running
     calibration analysis. Tier 1 (auto-runnable) since calibration
     is bounded. */
  const captureRate = pct(capturedFull + capturedPartial, totalMoves);
  if (captureRate < 5 && totalMoves >= 50) {
    recs.push({
      id: "run_calibration_analysis",
      tier: 1,
      type: "action",
      title: `Run calibration analysis — capture rate ${captureRate}% is below floor`,
      rationale: `Only ${capturedFull + capturedPartial} of ${totalMoves} moves were captured. Calibration will analyze recent trade autopsies and propose parameter nudges. Auto-applicable (tier 1).`,
      action_endpoint: "/timed/calibration/run-analysis",
      expected_impact: "tier-1 deltas applied automatically; tier-2 surfaced for review",
      confidence: "high",
    });
  }

  /* Rec E — Information-only summary always present (so the panel
     never looks empty). */
  recs.push({
    id: "info_summary",
    tier: 3,
    type: "info",
    title: `Window summary: ${missedCount} missed · ${capturedFull + capturedPartial} captured · ${churned} churned`,
    rationale: `${inUnivMissed.length} of the misses were in-universe (engine gap); ${outUnivMissed.length} were out-of-universe (screener gap). Top 3 missed: ${missedDetails.slice(0, 3).map((m) => `${m.ticker} ${m.move_pct}%`).join(", ") || "(none)"}.`,
    confidence: "high",
  });

  return recs;
}

export async function runMoveDiscovery(env, opts = {}) {
  const t0 = Date.now();
  const db = env?.DB;
  if (!db) return { ok: false, error: "no_db" };

  const windowDays = Math.max(20, Math.min(120, Number(opts.windowDays) || DEFAULT_WINDOW_DAYS));
  const minAtr = Math.max(2, Math.min(5, Number(opts.minAtr) || MIN_ATR_MULT));
  const sinceTsMs = Date.now() - windowDays * 86400000;

  /* 1) Load daily candles in the window.

     CRITICAL: `ticker_candles.ts` is stored in MILLISECONDS (see
     worker/index.js line 31537 + the table's existing query
     patterns). An earlier version of this function bound a SECONDS
     value (`Math.floor(sinceTsMs/1000)`) which caused EVERY row
     across the full table to match the WHERE clause — the resulting
     payload OOMed the worker and crashed the request. Always bind
     ms. Unit test discovery.bindsMillisecondTimestamp asserts this.

     Use a single ranged query; the worker CPU + D1 row budget is
     fine for ~60 days * ~300 tickers = ~18k rows. */
  let candleRows = [];
  try {
    const rows = await db.prepare(
      `SELECT ticker, ts, o, h, l, c, v
         FROM ticker_candles
        WHERE tf = 'D' AND ts >= ?1
        ORDER BY ticker, ts`,
    ).bind(sinceTsMs).all();
    candleRows = (rows && rows.results) || [];
  } catch (e) {
    return { ok: false, error: `candle_query_failed: ${String(e?.message || e).slice(0, 200)}`, elapsed_ms: Date.now() - t0 };
  }

  const byTicker = {};
  for (const c of candleRows) {
    const ts = Number(c.ts);
    // Defensive: accept either ms or seconds (legacy rows). Discard
    // anything older than the window after normalization.
    const tsMs = ts > 1e12 ? ts : ts * 1000;
    if (tsMs < sinceTsMs) continue;
    const t = String(c.ticker).toUpperCase();
    if (!t) continue;
    const o = Number(c.o), h = Number(c.h), l = Number(c.l), close = Number(c.c);
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(close)) continue;
    (byTicker[t] = byTicker[t] || []).push({
      ts: tsMs, o, h, l, c: close, v: Number(c.v || 0),
    });
  }
  for (const t of Object.keys(byTicker)) byTicker[t].sort((a, b) => a.ts - b.ts);

  let tickers = Object.keys(byTicker).filter((t) => byTicker[t].length >= 20);
  if (tickers.length > MAX_TICKERS) {
    /* Sort by recent ATR magnitude so we keep the noisier names that
       are more likely to have qualifying moves. */
    const score = (t) => {
      const arr = byTicker[t];
      const last = arr[arr.length - 1];
      const ref = arr[Math.max(0, arr.length - 21)];
      if (!last || !ref || !ref.c) return 0;
      return Math.abs((last.c - ref.c) / ref.c);
    };
    tickers.sort((a, b) => score(b) - score(a));
    tickers = tickers.slice(0, MAX_TICKERS);
  }

  /* 2) Load closed trades in the window. `trades.entry_ts` is stored
        in MILLISECONDS (see worker/index.js line 28751 backfill query
        which binds `new Date(...).getTime()`). Same fix as above. */
  let trades = [];
  try {
    const rows = await db.prepare(
      `SELECT trade_id, ticker, direction, entry_ts, exit_ts,
              entry_price, exit_price, pnl_pct, status, exit_reason
         FROM trades
        WHERE status IN ('WIN','LOSS','FLAT')
          AND entry_ts >= ?1
        ORDER BY ticker, entry_ts`,
    ).bind(sinceTsMs).all();
    trades = (rows && rows.results) || [];
  } catch (e) {
    /* Trade query failure is non-fatal — Discovery still produces
       useful "missed" stats even with zero trades, because every
       move with no matching trade becomes a MISS. */
    trades = [];
  }
  const tradesByTicker = {};
  for (const t of trades) {
    const sym = String(t.ticker || "").toUpperCase();
    if (!sym) continue;
    const entry = Number(t.entry_ts);
    const exit = Number(t.exit_ts);
    if (!Number.isFinite(entry)) continue;
    (tradesByTicker[sym] = tradesByTicker[sym] || []).push({
      ...t,
      entry_ts: entry > 1e12 ? entry : entry * 1000,
      exit_ts: Number.isFinite(exit) ? (exit > 1e12 ? exit : exit * 1000) : null,
      entry_price: Number(t.entry_price),
      exit_price: Number(t.exit_price),
      pnl_pct: Number(t.pnl_pct) || 0,
    });
  }

  /* 3) Discover moves: every (ticker, window-start) where the close
        moved >= minAtr * ATR. */
  const allMoves = [];
  for (const ticker of tickers) {
    const candles = byTicker[ticker];
    const atrs = computeATR(candles);
    for (const window of WINDOWS) {
      for (let i = window; i < candles.length; i++) {
        const startIdx = i - window;
        const atr = atrs[startIdx] || atrs[Math.max(0, startIdx - 1)];
        if (!atr || atr <= 0) continue;
        const startPrice = candles[startIdx].c;
        const endPrice = candles[i].c;
        if (startPrice <= 0) continue;
        const movePct = ((endPrice - startPrice) / startPrice) * 100;
        const moveAtr = Math.abs(endPrice - startPrice) / atr;
        if (moveAtr < minAtr) continue;
        const direction = movePct > 0 ? "UP" : "DOWN";
        /* Find intra-move peak for partial-capture math. */
        let peakPrice = startPrice;
        let troughPrice = startPrice;
        for (let j = startIdx + 1; j <= i; j++) {
          if (candles[j].h > peakPrice) peakPrice = candles[j].h;
          if (candles[j].l < troughPrice) troughPrice = candles[j].l;
        }
        allMoves.push({
          ticker, direction, window,
          start_ts: candles[startIdx].ts,
          end_ts: candles[i].ts,
          start_date: dateStr(candles[startIdx].ts),
          end_date: dateStr(candles[i].ts),
          move_pct: rnd(movePct),
          move_atr: rnd(moveAtr),
          start_price: rnd(startPrice),
          end_price: rnd(endPrice),
          peak_price: rnd(direction === "UP" ? peakPrice : troughPrice),
          atr_at_start: rnd(atr),
          atr_pct: rnd(atr / startPrice * 100),
        });
      }
    }
  }

  /* 4) Dedup: keep largest move per ticker:direction per 5-day bucket. */
  allMoves.sort((a, b) => b.move_atr - a.move_atr);
  const seen = new Set();
  const moves = [];
  for (const m of allMoves) {
    const bucket = Math.floor(m.start_ts / (5 * 86400000));
    const key = `${m.ticker}:${m.direction}:${bucket}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seen.add(`${m.ticker}:${m.direction}:${bucket - 1}`);
    seen.add(`${m.ticker}:${m.direction}:${bucket + 1}`);
    moves.push(m);
  }

  /* 5) Match trades → moves. */
  let fullCapture = 0, partialCapture = 0, missedCount = 0, churned = 0;
  const churnDetails = [];
  const missedDetails = [];
  for (const move of moves) {
    const tickerTrades = tradesByTicker[move.ticker] || [];
    const moveDir = move.direction === "UP" ? "LONG" : "SHORT";
    const overlapping = tickerTrades.filter((t) => {
      const dir = String(t.direction || "").toUpperCase();
      if (dir !== moveDir && dir !== move.direction) return false;
      return t.entry_ts >= move.start_ts - 2 * 86400000 && t.entry_ts <= move.end_ts + 2 * 86400000;
    });
    if (overlapping.length === 0) {
      move.capture = "MISSED";
      missedCount++;
      missedDetails.push({
        ticker: move.ticker,
        direction: move.direction,
        move_pct: move.move_pct,
        move_atr: move.move_atr,
        start_date: move.start_date,
        end_date: move.end_date,
      });
      continue;
    }
    if (overlapping.length >= 2) {
      move.capture = "CHURNED";
      churned++;
      const individualPnl = overlapping.reduce((s, t) => s + t.pnl_pct, 0);
      const firstEntry = overlapping[0].entry_price;
      const lastExit = overlapping[overlapping.length - 1].exit_price;
      const holdPnl = moveDir === "LONG"
        ? ((lastExit - firstEntry) / firstEntry) * 100
        : ((firstEntry - lastExit) / firstEntry) * 100;
      const holdToPeakPnl = moveDir === "LONG"
        ? ((move.peak_price - firstEntry) / firstEntry) * 100
        : ((firstEntry - move.peak_price) / firstEntry) * 100;
      churnDetails.push({
        ticker: move.ticker,
        move_pct: move.move_pct,
        trade_count: overlapping.length,
        individual_pnl: rnd(individualPnl),
        hold_pnl: rnd(holdPnl),
        hold_to_peak_pnl: rnd(holdToPeakPnl),
        missed_upside: rnd(Math.max(0, holdToPeakPnl - individualPnl)),
      });
      continue;
    }
    const trade = overlapping[0];
    const moveDuration = move.end_ts - move.start_ts;
    const entryTiming = moveDuration > 0 ? (trade.entry_ts - move.start_ts) / moveDuration : 0;
    const exitTiming = moveDuration > 0 ? (trade.exit_ts - move.start_ts) / moveDuration : 1;
    if (entryTiming <= 0.3 && exitTiming >= 0.6) {
      move.capture = "FULL";
      fullCapture++;
    } else {
      move.capture = "PARTIAL";
      partialCapture++;
    }
  }

  /* 6) Aggregate missed-pattern signals so the calibration analyzer
        has something concrete to act on. Group missed moves by
        direction + magnitude bucket. */
  const missedByDir = { UP: 0, DOWN: 0 };
  const missedBigByDir = { UP: 0, DOWN: 0 };
  for (const m of missedDetails) {
    missedByDir[m.direction] = (missedByDir[m.direction] || 0) + 1;
    if (Math.abs(m.move_pct) >= 10) {
      missedBigByDir[m.direction] = (missedBigByDir[m.direction] || 0) + 1;
    }
  }

  const totalMoves = moves.length;
  /* 7) Universe membership classification — for each missed move,
        was the ticker actually in our universe (timed:tickers KV)
        at scan time? Misses on out-of-universe tickers are a
        screener problem (lower screener threshold or run more
        often); misses on in-universe tickers are an engine /
        score-threshold problem. Different fixes. */
  let universeSet = new Set();
  try {
    const KV = env?.KV_TIMED;
    if (KV) {
      const list = (await KV.get("timed:tickers", "json")) || [];
      if (Array.isArray(list)) universeSet = new Set(list.map((t) => String(t).toUpperCase()));
    }
  } catch (_) { /* universe unknown — skip classification */ }
  const inUnivMissed = missedDetails.filter((m) => universeSet.has(m.ticker));
  const outUnivMissed = missedDetails.filter((m) => !universeSet.has(m.ticker));

  /* 8) Recommendations — turn discovery findings into concrete,
        applicable knob changes. Each recommendation includes:
        { id, title, rationale, knob_path, current_value,
          suggested_value, expected_captures, confidence, tier }
        Tier 2 = operator approval required (these are aggressive
        changes; we won't auto-apply). The Discovery UI surfaces
        these with a 1-click Apply that POSTs to
        /timed/admin/discovery/apply. */
  const recommendations = await buildRecommendations({
    env,
    missedDetails,
    inUnivMissed,
    outUnivMissed,
    churnDetails,
    capturedFull: fullCapture,
    capturedPartial: partialCapture,
    missedCount,
    churned,
    totalMoves,
  });

  const report = {
    generated: new Date().toISOString(),
    source: "worker_coo",
    since_days: windowDays,
    min_atr_mult: minAtr,
    windows: WINDOWS,
    summary: {
      total_moves: totalMoves,
      unique_tickers: new Set(moves.map((m) => m.ticker)).size,
      tickers_scanned: tickers.length,
      candles_scanned: candleRows.length,
      trades_scanned: trades.length,
      full_capture: fullCapture,
      partial_capture: partialCapture,
      missed: missedCount,
      missed_in_universe: inUnivMissed.length,
      missed_out_of_universe: outUnivMissed.length,
      churned,
      capture_rate: pct(fullCapture + partialCapture, totalMoves),
      missed_rate: pct(missedCount, totalMoves),
      churn_rate: pct(churned, totalMoves),
      total_missed_upside_from_churn: rnd(churnDetails.reduce((s, c) => s + c.missed_upside, 0)),
    },
    recommendations,
    missed_signals: {
      total_missed: missedCount,
      up_missed: missedByDir.UP,
      down_missed: missedByDir.DOWN,
      up_missed_big: missedBigByDir.UP,
      down_missed_big: missedBigByDir.DOWN,
      top_missed: missedDetails
        .sort((a, b) => Math.abs(b.move_pct) - Math.abs(a.move_pct))
        .slice(0, 25),
    },
    churning: churnDetails.sort((a, b) => b.missed_upside - a.missed_upside).slice(0, 25),
    moves: moves.slice(0, 500).map((m) => ({
      ticker: m.ticker,
      direction: m.direction,
      window: m.window,
      start_date: m.start_date,
      end_date: m.end_date,
      move_pct: m.move_pct,
      move_atr: m.move_atr,
      start_price: m.start_price,
      end_price: m.end_price,
      peak_price: m.peak_price,
      capture: m.capture,
    })),
  };

  /* 7) Persist for the dashboard. Same key the existing system-
        intelligence MoveDiscovery tab reads from. */
  try {
    const KV = env?.KV_TIMED;
    if (KV) {
      await KV.put("timed:move-discovery", JSON.stringify(report), { expirationTtl: 86400 * 90 });
    }
  } catch (e) {
    console.warn("[discovery] KV put failed:", String(e?.message || e).slice(0, 120));
  }

  return {
    ok: true,
    elapsed_ms: Date.now() - t0,
    summary: report.summary,
    missed_signals: report.missed_signals,
    churning_count: churnDetails.length,
    recommendations: report.recommendations,
  };
}
