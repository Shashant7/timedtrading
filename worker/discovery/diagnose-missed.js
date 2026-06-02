/* worker/discovery/diagnose-missed.js — worker-native diagnosis pass.

   Operator question: "How do we run the diagnosis directly through
   System Intelligence?"

   This is the worker port of scripts/diagnose-missed-moves.js. For
   each missed move on a ticker we've actually traded, it queries
   trail_5m_facts during the move window and classifies the miss:

     LOW_RANK             — rank < 60 during move
     LOW_HTF              — htf_score < 15
     WRONG_STATE          — state didn't match move direction
     LOW_COMPLETION       — pattern completion < 50%
     NO_SIGNALS           — no squeeze/ema/st/momentum_elite fired
     NO_TRAIL_DATA        — no trail rows in window (coverage gap)
     SHOULD_HAVE_ENTERED  — everything looked good, real mystery

   The result is added to the existing Discovery report on KV
   (`timed:move-discovery.diagnosis`) so the dashboard's "Miss
   Buckets" tab populates automatically.

   Scope notes for worker execution:
     • Cap at top 200 missed moves (sorted by ATR magnitude) to
       fit the D1 + CPU budget.
     • Group queries by ticker so each ticker is a single trail_5m_
       facts SELECT, not one query per move.
     • Defensive on schema differences (older facts may lack newer
       columns — we only SELECT the core set). */

const DEFAULT_LIMIT = 200;
const MS_PER_DAY = 86400000;

function rnd(v, dp = 1) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }
function pct(n, d) { return d > 0 ? rnd(n / d * 100) : 0; }
function dateStr(ts) { return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : null; }

export async function runDiagnosis(env, opts = {}) {
  const t0 = Date.now();
  const db = env?.DB;
  const KV = env?.KV_TIMED;
  if (!db) return { ok: false, error: "no_db" };
  if (!KV) return { ok: false, error: "no_kv" };

  const raw = await KV.get("timed:move-discovery", "text").catch(() => null);
  if (!raw) {
    return { ok: false, error: "no_discovery_report", hint: "Run /timed/admin/discovery/run first" };
  }
  let report;
  try { report = JSON.parse(raw); }
  catch (e) { return { ok: false, error: "discovery_report_parse_failed" }; }

  /* All missed moves (UP and DOWN). The CLI restricted to
     "traded_tickers only" to focus on real engine gaps, but the
     operator UI shows ALL misses, so we diagnose all of them. */
  const allMoves = Array.isArray(report.moves) ? report.moves : [];
  let missedMoves = allMoves.filter((m) => m?.capture === "MISSED");
  missedMoves.sort((a, b) => Number(b.move_atr || 0) - Number(a.move_atr || 0));
  const limit = Math.max(20, Math.min(500, Number(opts.limit) || DEFAULT_LIMIT));
  if (missedMoves.length > limit) missedMoves = missedMoves.slice(0, limit);
  if (missedMoves.length === 0) {
    return {
      ok: true,
      elapsed_ms: Date.now() - t0,
      diagnosis: {
        total_diagnosed: 0,
        breakdown: {},
        coverage_breakdown: {},
        coverage_examples: {},
        should_have_entered: [],
        limit_applied: limit,
        note: "no_missed_moves",
      },
    };
  }

  /* Group missed moves by ticker; one batched query per ticker. */
  const byTicker = {};
  for (const m of missedMoves) {
    const sym = String(m.ticker || "").toUpperCase();
    if (!sym) continue;
    (byTicker[sym] = byTicker[sym] || []).push(m);
  }
  const tickers = Object.keys(byTicker);

  const diagnosis = {
    low_rank: 0,
    low_htf: 0,
    wrong_state: 0,
    low_completion: 0,
    no_signals: 0,
    no_trail_data: 0,
    should_have_entered: 0,
  };
  const coverageBreakdown = {
    no_rows_for_ticker: 0,
    move_before_coverage: 0,
    move_after_coverage: 0,
    gap_inside_coverage: 0,
  };
  const coverageExamples = {
    no_rows_for_ticker: [], move_before_coverage: [],
    move_after_coverage: [], gap_inside_coverage: [],
  };
  const shouldHaveEntered = [];

  for (const ticker of tickers) {
    const moves = byTicker[ticker];
    const earliestTs = Math.min(...moves.map((m) => new Date(m.start_date + "T00:00:00Z").getTime()));
    const latestTs = Math.max(...moves.map((m) => new Date(m.end_date + "T23:59:59Z").getTime()));

    /* Two queries per ticker — bounded scan + coverage range. Each
       is bound-parameterized to defend against any odd ticker chars. */
    let trailRows = [];
    let coverageRow = null;
    try {
      const r = await db.prepare(
        `SELECT bucket_ts, htf_score_avg, ltf_score_avg, state, rank,
                completion, phase_pct, had_squeeze_release, had_ema_cross,
                had_st_flip, had_momentum_elite, kanban_stage_end
           FROM trail_5m_facts
          WHERE ticker = ?1
            AND bucket_ts >= ?2
            AND bucket_ts <= ?3
          ORDER BY bucket_ts`,
      ).bind(ticker, earliestTs, latestTs).all().catch(() => ({ results: [] }));
      trailRows = (r && r.results) || [];
    } catch (_) { trailRows = []; }
    try {
      const c = await db.prepare(
        `SELECT MIN(bucket_ts) AS min_ts, MAX(bucket_ts) AS max_ts, COUNT(*) AS total_rows
           FROM trail_5m_facts
          WHERE ticker = ?1`,
      ).bind(ticker).first().catch(() => null);
      coverageRow = c || {};
    } catch (_) { coverageRow = {}; }
    const tickerTrailRows = Number(coverageRow?.total_rows) || 0;
    const coverageStart = Number(coverageRow?.min_ts) || null;
    const coverageEnd = Number(coverageRow?.max_ts) || null;

    for (const move of moves) {
      const moveStartMs = new Date(move.start_date + "T00:00:00Z").getTime();
      const moveEndMs = new Date(move.end_date + "T23:59:59Z").getTime();
      const during = trailRows.filter((r) => {
        const ts = Number(r.bucket_ts);
        return ts >= moveStartMs && ts <= moveEndMs;
      });

      if (during.length === 0) {
        diagnosis.no_trail_data++;
        let coverageReason = "gap_inside_coverage";
        if (tickerTrailRows === 0 || !coverageStart || !coverageEnd) coverageReason = "no_rows_for_ticker";
        else if (moveEndMs < coverageStart) coverageReason = "move_before_coverage";
        else if (moveStartMs > coverageEnd) coverageReason = "move_after_coverage";
        coverageBreakdown[coverageReason]++;
        if (coverageExamples[coverageReason].length < 5) {
          coverageExamples[coverageReason].push({
            ticker: move.ticker, direction: move.direction,
            start_date: move.start_date, end_date: move.end_date,
            move_pct: move.move_pct, move_atr: move.move_atr,
            coverage_start: dateStr(coverageStart), coverage_end: dateStr(coverageEnd),
            ticker_trail_rows: tickerTrailRows,
          });
        }
        continue;
      }

      const n = during.length;
      const avgRank = during.reduce((s, r) => s + (Number(r.rank) || 0), 0) / n;
      const avgHtf = during.reduce((s, r) => s + (Number(r.htf_score_avg) || 0), 0) / n;
      const avgLtf = during.reduce((s, r) => s + (Number(r.ltf_score_avg) || 0), 0) / n;
      const avgCompletion = during.reduce((s, r) => s + (Number(r.completion) || 0), 0) / n;
      const hadSqueeze = during.some((r) => r.had_squeeze_release);
      const hadEmaCross = during.some((r) => r.had_ema_cross);
      const hadStFlip = during.some((r) => r.had_st_flip);
      const hadMomentumElite = during.some((r) => r.had_momentum_elite);
      const signalCount = (hadSqueeze ? 1 : 0) + (hadEmaCross ? 1 : 0) + (hadStFlip ? 1 : 0) + (hadMomentumElite ? 1 : 0);
      const states = during.map((r) => r.state || "unknown");
      const stateFreq = {};
      states.forEach((s) => stateFreq[s] = (stateFreq[s] || 0) + 1);
      const dominantState = Object.entries(stateFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
      const kanbanStages = during.map((r) => r.kanban_stage_end || "unknown");
      const kanbanFreq = {};
      kanbanStages.forEach((s) => kanbanFreq[s] = (kanbanFreq[s] || 0) + 1);
      const dominantKanban = Object.entries(kanbanFreq).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";

      const wantedDir = move.direction === "UP" ? "BULL" : "BEAR";
      let reason = "UNKNOWN";
      let detail = "";
      if (avgRank < 60) {
        reason = "LOW_RANK"; detail = `avg rank=${rnd(avgRank, 0)} (need >=60)`;
        diagnosis.low_rank++;
      } else if (avgHtf < 15) {
        reason = "LOW_HTF"; detail = `avg htf=${rnd(avgHtf)} (need >=15)`;
        diagnosis.low_htf++;
      } else if (!dominantState.includes(wantedDir)) {
        reason = "WRONG_STATE"; detail = `state=${dominantState} but move=${move.direction}`;
        diagnosis.wrong_state++;
      } else if (avgCompletion < 50) {
        reason = "LOW_COMPLETION"; detail = `avg completion=${rnd(avgCompletion)}% (need >=50)`;
        diagnosis.low_completion++;
      } else if (signalCount === 0) {
        reason = "NO_SIGNALS"; detail = "no squeeze/ema_cross/st_flip/momentum_elite fired";
        diagnosis.no_signals++;
      } else {
        reason = "SHOULD_HAVE_ENTERED";
        detail = `rank=${rnd(avgRank, 0)} htf=${rnd(avgHtf)} completion=${rnd(avgCompletion)}% signals=${signalCount} kanban=${dominantKanban}`;
        diagnosis.should_have_entered++;
        if (shouldHaveEntered.length < 25) {
          shouldHaveEntered.push({
            ticker: move.ticker, direction: move.direction,
            start_date: move.start_date, end_date: move.end_date,
            move_pct: move.move_pct, move_atr: move.move_atr,
            avg_rank: rnd(avgRank, 0), avg_htf: rnd(avgHtf), avg_ltf: rnd(avgLtf),
            avg_completion: rnd(avgCompletion), dominant_state: dominantState,
            dominant_kanban: dominantKanban, signal_count: signalCount,
          });
        }
      }
    }
  }

  const totalDiagnosed = Object.values(diagnosis).reduce((s, v) => s + v, 0);
  const diagOut = {
    total_diagnosed: totalDiagnosed,
    limit_applied: limit,
    breakdown: { ...diagnosis },
    coverage_breakdown: { ...coverageBreakdown },
    coverage_examples: coverageExamples,
    should_have_entered: shouldHaveEntered,
    diagnosed_at: new Date().toISOString(),
  };

  /* Merge into the existing Discovery report on KV so the dashboard's
     "Miss Buckets" tab + the Current Read panel populate automatically.
     Preserve all other fields. */
  report.diagnosis = diagOut;
  await KV.put("timed:move-discovery", JSON.stringify(report), { expirationTtl: 86400 * 90 }).catch(() => {});

  return { ok: true, elapsed_ms: Date.now() - t0, diagnosis: diagOut };
}
