/* worker/discovery/gameplan.js — the Discovery → officer-suite bridge.
 *
 * 2026-06-10 — Operator: "What we miss is what we don't know. If I only
 * knew how to run one play in football, I'd be successful only when the
 * env aligns for that play. Discovery should be feeding AI CTO, CRO,
 * CIO to create a gameplan around valid setups and moves we are
 * ignorant to, or adjust existing setups to apply the learnings."
 *
 * Before this module, Move Discovery was a dead end: the nightly scan
 * found 500+ missed moves, produced knob recommendations nobody
 * auto-consumed, and NONE of it reached the officer prompts (the CRO
 * even read a KV key that was never written). This module is the
 * deterministic synthesizer that turns the three discovery lanes into
 * ONE compact artifact officers can reason over:
 *
 *   inputs:
 *     KV timed:move-discovery                  (moves + diagnosis + recs)
 *     KV timed:discovery:coverage-gaps-summary (per-day miss reason mix)
 *     D1 direction_accuracy                    (which plays actually ran)
 *
 *   output (KV timed:discovery:gameplan + merged report.gameplan):
 *     constraint_mix   — WHY we miss: no play / generic gate veto /
 *                        conviction too low / wrong side / data gap /
 *                        universe gap. Answers "are triggers per-setup
 *                        or are generic gates deferring valid setups?"
 *                        with measured counts instead of vibes.
 *     playbook_usage   — which entry paths fired in the window vs sat
 *                        idle + concentration ("one-play offense"
 *                        detector).
 *     miss_archetypes  — repeated miss patterns (direction × magnitude
 *                        × dominant state) = candidate new plays or
 *                        trigger gaps in existing plays.
 *     actions          — vetted knob recs + structural insights.
 *     narrative        — ≤ 700 chars officers inject into prompts.
 *
 * Consumers:
 *   CRO  collectDiscoveryPulse()         (daily synthesis → Brief/Desk)
 *   CIO  cio-memory Layer 9              (entry + lifecycle decisions)
 *   COO  runMoveDiscoveryCycle()         (submits tier-2 proposals)
 *   UI   system-intelligence ?tab=moves  (Gameplan card)
 *
 * Deliberately NO LLM here: this is the evidence layer. The officers'
 * LLMs interpret it; this module must stay deterministic and testable.
 */

const GAMEPLAN_KV_KEY = "timed:discovery:gameplan";
const MOVE_DISCOVERY_KV_KEY = "timed:move-discovery";
const COVERAGE_GAPS_KV_KEY = "timed:discovery:coverage-gaps-summary";

/* Canonical TT-core play list (worker/pipeline/tt-core-entry.js
 * qualification stack). Used to detect idle plays — a path with zero
 * trades in the window is a play we KNOW but did not RUN. Keep in sync
 * with the qualifyEntry priority stack; harmless if a path is retired
 * (it just reports idle). */
export const KNOWN_PLAYS = [
  "tt_gap_reversal_long",
  "tt_gap_reversal_short",
  "tt_n_test_support",
  "tt_n_test_resistance",
  "tt_range_reversal_long",
  "tt_range_reversal_short",
  "tt_ath_breakout",
  "tt_atl_breakdown",
  "tt_momentum",
  "tt_pullback",
  "tt_reclaim",
  "tt_mean_revert",
];

function rnd(v, dp = 1) { return Math.round(v * Math.pow(10, dp)) / Math.pow(10, dp); }

/* ── Constraint mix ──────────────────────────────────────────────────
 * Merge the two miss-classification lanes into one answer to "what is
 * the binding constraint on capture rate?".
 *
 *   diagnosis breakdown   (move-discovery diagnosis, multi-day moves):
 *     low_rank/low_htf      → CONVICTION_TOO_LOW
 *     wrong_state           → WRONG_SIDE_BIAS
 *     qualification_gap     → CONVICTION_TOO_LOW (early move, signals, floor gap)
 *     late_stage            → tracked separately (move already extended)
 *     low_completion        → legacy alias (still counted if present)
 *     no_signals            → NO_PLAY_FOR_MOVE  (no trigger we own fired)
 *     should_have_entered   → GENERIC_GATE_VETO (signals + scores were
 *                             there; something downstream blocked it)
 *     no_trail_data         → DATA_GAP
 *
 *   coverage-gap reason mix (per-day, admission_cohort_log-backed):
 *     setup_not_detected    → NO_PLAY_FOR_MOVE
 *     gate_blocked          → GENERIC_GATE_VETO
 *     cohort_fail           → GENERIC_GATE_VETO
 *     low_rank              → CONVICTION_TOO_LOW
 *     short_gate_too_tight  → GENERIC_GATE_VETO
 *     event_risk_blocked    → GENERIC_GATE_VETO
 *     capital_blocked       → GENERIC_GATE_VETO
 *     not_scored            → DATA_GAP
 *
 *   out-of-universe misses  → UNIVERSE_GAP
 */
export function classifyConstraintMix({ diagnosisBreakdown, coverageReasonMix, missedOutOfUniverse } = {}) {
  const mix = {
    NO_PLAY_FOR_MOVE: 0,
    GENERIC_GATE_VETO: 0,
    CONVICTION_TOO_LOW: 0,
    WRONG_SIDE_BIAS: 0,
    DATA_GAP: 0,
    UNIVERSE_GAP: Math.max(0, Number(missedOutOfUniverse) || 0),
  };
  const d = diagnosisBreakdown || {};
  mix.CONVICTION_TOO_LOW += (Number(d.low_rank) || 0) + (Number(d.low_htf) || 0)
    + (Number(d.qualification_gap) || 0) + (Number(d.low_completion) || 0);
  mix.LATE_STAGE = Number(d.late_stage) || 0;
  mix.WRONG_SIDE_BIAS += Number(d.wrong_state) || 0;
  mix.NO_PLAY_FOR_MOVE += Number(d.no_signals) || 0;
  mix.GENERIC_GATE_VETO += Number(d.should_have_entered) || 0;
  mix.DATA_GAP += Number(d.no_trail_data) || 0;

  const c = coverageReasonMix || {};
  mix.NO_PLAY_FOR_MOVE += Number(c.setup_not_detected) || 0;
  mix.GENERIC_GATE_VETO += (Number(c.gate_blocked) || 0) + (Number(c.cohort_fail) || 0)
    + (Number(c.short_gate_too_tight) || 0) + (Number(c.event_risk_blocked) || 0)
    + (Number(c.capital_blocked) || 0);
  mix.CONVICTION_TOO_LOW += Number(c.low_rank) || 0;
  mix.DATA_GAP += Number(c.not_scored) || 0;

  const entries = Object.entries(mix).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return {
    mix,
    total_classified: total,
    binding_constraint: entries[0]?.[0] || null,
    binding_constraint_pct: total > 0 && entries[0] ? rnd(entries[0][1] / total * 100) : null,
  };
}

/* ── Playbook usage ──────────────────────────────────────────────────
 * "We end up generally not running many plays." — measure it.
 * pathRows: [{ entry_path, trades, wins }] from direction_accuracy in
 * the discovery window. Idle = a KNOWN_PLAY with zero trades.
 */
export function computePlaybookUsage(pathRows = []) {
  const byPath = [];
  let totalTrades = 0;
  const seen = new Set();
  for (const r of pathRows) {
    const path = String(r?.entry_path || "").trim();
    const trades = Number(r?.trades) || 0;
    if (!path || trades <= 0) continue;
    seen.add(path);
    totalTrades += trades;
    byPath.push({
      path,
      trades,
      wins: Number(r?.wins) || 0,
      win_rate: trades > 0 ? rnd((Number(r?.wins) || 0) / trades * 100) : null,
    });
  }
  byPath.sort((a, b) => b.trades - a.trades);
  const idle = KNOWN_PLAYS.filter((p) => !seen.has(p));
  const top = byPath[0];
  return {
    plays_run: byPath.length,
    plays_idle: idle,
    plays_known: KNOWN_PLAYS.length,
    total_trades: totalTrades,
    by_path: byPath.slice(0, 16),
    /* Concentration: share of all trades from the single most-used
       play. > 60% with idle plays = one-play offense. */
    concentration_pct: totalTrades > 0 && top ? rnd(top.trades / totalTrades * 100) : null,
    one_play_offense: totalTrades >= 10 && top
      ? (top.trades / totalTrades >= 0.6 && idle.length >= 4)
      : false,
  };
}

/* ── Miss archetypes ─────────────────────────────────────────────────
 * Group the highest-quality miss evidence (diagnosis
 * should_have_entered + top misses) into repeated patterns. An
 * archetype that recurs is either a play we don't have or a trigger
 * that is too narrow on a play we do have.
 */
export function buildMissArchetypes({ shouldHaveEntered = [], topMissed = [] } = {}) {
  const groups = new Map();
  const add = (key, label, example, fields) => {
    if (!groups.has(key)) groups.set(key, { archetype: label, count: 0, examples: [], ...fields });
    const g = groups.get(key);
    g.count++;
    if (g.examples.length < 4 && example) g.examples.push(example);
  };

  for (const m of shouldHaveEntered) {
    const dir = m.direction === "UP" ? "LONG" : "SHORT";
    const state = String(m.dominant_state || "unknown");
    const key = `she:${dir}:${state}`;
    add(key,
      `${dir} moves from ${state} — scores/signals were valid but no entry fired`,
      `${m.ticker} ${m.move_pct}% (${m.start_date})`,
      { kind: "gate_or_trigger_gap", direction: dir, dominant_state: state });
  }
  for (const m of topMissed) {
    const dir = m.direction === "UP" ? "LONG" : "SHORT";
    const mag = Math.abs(Number(m.move_pct) || 0) >= 15 ? "mega(≥15%)" : "large(8-15%)";
    if (Math.abs(Number(m.move_pct) || 0) < 8) continue;
    const key = `miss:${dir}:${mag}`;
    add(key,
      `Missed ${mag} ${dir} moves`,
      `${m.ticker} ${m.move_pct}% (${m.start_date || ""})`.trim(),
      { kind: "missed_magnitude", direction: dir, magnitude: mag });
  }

  return [...groups.values()]
    .filter((g) => g.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

/** CTO universe coverage — candle gaps that block probabilistic levels. */
export function summarizeCTOCoverage(ctoRollup) {
  const results = Array.isArray(ctoRollup?.results) ? ctoRollup.results : [];
  let insufficient = 0;
  let lowSample = 0;
  let ok = 0;
  for (const r of results) {
    if (r.ok) { ok++; if (r.low_sample) lowSample++; }
    else if (r.error_kind === "insufficient_candles") insufficient++;
  }
  return {
    tickers_processed: results.length,
    tickers_ok: ok,
    insufficient_candles: insufficient,
    low_sample: lowSample,
    pct_insufficient: results.length ? rnd(insufficient / results.length * 100) : null,
  };
}

/** Cross-ref idle plays with live CRO tactical overlay themes. */
export function crossRefTacticalOverlay(usage, tacticalBlob) {
  const signals = Array.isArray(tacticalBlob?.tactical_signals) ? tacticalBlob.tactical_signals : [];
  const hotThemes = new Set();
  for (const sig of signals) {
    for (const th of (sig.affected_tier1_themes || [])) hotThemes.add(th);
  }
  return {
    tactical_title: tacticalBlob?.tactical_title || null,
    hot_themes: [...hotThemes].slice(0, 8),
    idle_plays: usage?.plays_idle || [],
    idle_while_tactical_live: (usage?.plays_idle?.length || 0) > 0 && signals.length > 0,
  };
}

/** Top promotion-queue candidates awaiting operator review. */
export async function loadPromotionPipeline(db, { limit = 5 } = {}) {
  if (!db) return { needs_review: [], ready: 0 };
  try {
    const rows = await db.prepare(
      `SELECT ticker, total_score, status, thesis_text
         FROM discovery_promotion_queue
        WHERE status IN ('needs_review', 'ready_to_add')
        ORDER BY total_score DESC
        LIMIT ?1`,
    ).bind(limit).all();
    const list = (rows?.results || []).map((r) => ({
      ticker: r.ticker,
      total_score: r.total_score,
      status: r.status,
      thesis_preview: String(r.thesis_text || "").slice(0, 120),
    }));
    const ready = list.filter((x) => x.status === "ready_to_add").length;
    return { needs_review: list.filter((x) => x.status === "needs_review"), ready, top: list };
  } catch (_) {
    return { needs_review: [], ready: 0 };
  }
}

/* ── Narrative ───────────────────────────────────────────────────────
 * One compact paragraph the officer prompts can carry verbatim.
 */
export function buildGameplanNarrative({ capture, constraint, usage, archetypes, ctoCoverage, tacticalCross, promotionPipeline } = {}) {
  const bits = [];
  if (capture) {
    bits.push(`Capture ${capture.capture_rate ?? "?"}% of ${capture.total_moves ?? "?"} ATR-qualified moves over ${capture.window_days ?? "?"}d (${capture.missed_in_universe ?? "?"} in-universe misses, ${capture.missed_out_of_universe ?? "?"} out-of-universe).`);
  }
  if (constraint?.binding_constraint) {
    const labels = {
      NO_PLAY_FOR_MOVE: "no play in the arsenal fired (trigger/setup gap)",
      GENERIC_GATE_VETO: "generic gates vetoed otherwise-valid setups",
      CONVICTION_TOO_LOW: "conviction thresholds (rank/HTF) sat below the bar",
      WRONG_SIDE_BIAS: "the model was positioned on the wrong side",
      DATA_GAP: "data/scoring coverage gaps",
      UNIVERSE_GAP: "tickers were outside the universe (screener gap)",
    };
    bits.push(`Binding constraint: ${labels[constraint.binding_constraint] || constraint.binding_constraint} (${constraint.binding_constraint_pct}% of ${constraint.total_classified} classified misses).`);
  }
  if (usage) {
    if (usage.one_play_offense) {
      bits.push(`One-play offense: ${usage.by_path?.[0]?.path || "top play"} accounts for ${usage.concentration_pct}% of ${usage.total_trades} trades while ${usage.plays_idle.length} of ${usage.plays_known} known plays sat idle (${usage.plays_idle.slice(0, 4).join(", ")}).`);
    } else if (usage.plays_idle?.length > 0) {
      bits.push(`${usage.plays_run} plays ran (${usage.total_trades} trades); idle plays: ${usage.plays_idle.slice(0, 5).join(", ")}.`);
    }
  }
  if (archetypes?.length > 0) {
    bits.push(`Top repeated miss archetype: ${archetypes[0].archetype} (×${archetypes[0].count}).`);
  }
  if (ctoCoverage && ctoCoverage.insufficient_candles >= 3) {
    bits.push(`CTO blocked on ${ctoCoverage.insufficient_candles} tickers (insufficient D-candles) — backfill candles before officers lean on probabilistic levels.`);
  }
  if (tacticalCross?.idle_while_tactical_live) {
    bits.push(`CRO tactical overlay live (${(tacticalCross.tactical_title || "active").slice(0, 60)}) while ${tacticalCross.idle_plays.length} playbook plays sat idle — review whether gates or triggers are deferring valid setups in hot themes.`);
  }
  if (promotionPipeline?.needs_review?.length > 0) {
    bits.push(`Promotion pipeline: ${promotionPipeline.needs_review.length} screener candidate(s) need review (top: ${promotionPipeline.needs_review.slice(0, 2).map((x) => x.ticker).join(", ")}).`);
  }
  return bits.join(" ").slice(0, 700);
}

/* ── Orchestrator ──────────────────────────────────────────────────── */
export async function buildDiscoveryGameplan(env, opts = {}) {
  const t0 = Date.now();
  const KV = env?.KV_TIMED;
  const db = env?.DB;
  if (!KV) return { ok: false, error: "no_kv" };

  /* 1. Move-discovery report (must exist — produced by the same
        nightly cycle moments before us). */
  let report = null;
  try { report = JSON.parse(await KV.get(MOVE_DISCOVERY_KV_KEY, "text") || "null"); } catch (_) {}
  if (!report || !report.summary) {
    return { ok: false, error: "no_move_discovery_report" };
  }

  /* 2. Coverage gaps (independent nightly lane; tolerate absence). */
  let gapsSummary = null;
  try { gapsSummary = JSON.parse(await KV.get(COVERAGE_GAPS_KV_KEY, "text") || "null"); } catch (_) {}

  /* 3. Per-play usage in the discovery window from direction_accuracy
        (same source path_performance aggregates from, but windowed). */
  const windowDays = Number(report.since_days) || 60;
  let pathRows = [];
  if (db) {
    try {
      const sinceMs = Date.now() - windowDays * 86400000;
      const r = await db.prepare(
        `SELECT entry_path,
                COUNT(*) AS trades,
                SUM(CASE WHEN status = 'WIN' THEN 1 ELSE 0 END) AS wins
           FROM direction_accuracy
          WHERE status != 'OPEN' AND entry_path IS NOT NULL AND ts > ?1
          GROUP BY entry_path`,
      ).bind(sinceMs).all().catch(() => ({ results: [] }));
      pathRows = (r && r.results) || [];
    } catch (_) { pathRows = []; }
  }

  const s = report.summary || {};
  const capture = {
    window_days: windowDays,
    total_moves: s.total_moves ?? null,
    capture_rate: s.capture_rate ?? null,
    missed: s.missed ?? null,
    missed_in_universe: s.missed_in_universe ?? null,
    missed_out_of_universe: s.missed_out_of_universe ?? null,
    churned: s.churned ?? null,
    churn_missed_upside_pct: s.total_missed_upside_from_churn ?? null,
  };

  const constraint = classifyConstraintMix({
    diagnosisBreakdown: report.diagnosis?.breakdown || null,
    coverageReasonMix: gapsSummary?.universe_reason_mix || null,
    missedOutOfUniverse: s.missed_out_of_universe,
  });

  const usage = computePlaybookUsage(pathRows);

  const archetypes = buildMissArchetypes({
    shouldHaveEntered: report.diagnosis?.should_have_entered || [],
    topMissed: report.missed_signals?.top_missed || [],
  });

  /* Actions = the already-vetted knob recommendations + structural
     insights this synthesis adds on top. */
  const actions = [];
  for (const rec of (report.recommendations || [])) {
    if (rec?.type !== "knob_change") continue;
    actions.push({
      kind: "knob_change",
      id: rec.id,
      title: rec.title,
      knob_path: rec.knob_path,
      current_value: rec.current_value,
      suggested_value: rec.suggested_value,
      confidence: rec.confidence,
    });
  }
  if (constraint.binding_constraint === "NO_PLAY_FOR_MOVE" && constraint.binding_constraint_pct >= 30) {
    actions.push({
      kind: "structural",
      id: "review_trigger_specificity",
      title: "Dominant miss reason is 'no play fired' — review trigger coverage for the top miss archetypes; the arsenal may need a new play or wider triggers on an existing one.",
    });
  }
  if (constraint.binding_constraint === "GENERIC_GATE_VETO" && constraint.binding_constraint_pct >= 30) {
    actions.push({
      kind: "structural",
      id: "review_generic_gates",
      title: "Dominant miss reason is generic-gate vetoes — valid setups are being deferred by shared gates (admission matrix / cohort / rank floors), not by missing triggers. Review gate evidence before adding new plays.",
    });
  }
  if (usage.one_play_offense) {
    actions.push({
      kind: "structural",
      id: "one_play_offense",
      title: `Play concentration: ${usage.by_path?.[0]?.path} is ${usage.concentration_pct}% of trades with ${usage.plays_idle.length} idle plays. Investigate why idle plays never qualify (triggers vs gates).`,
    });
  }

  let ctoCoverage = null;
  let tacticalCross = null;
  let promotionPipeline = null;
  try {
    const ctoRaw = await KV.get("timed:cto:latest");
    const ctoRollup = ctoRaw ? JSON.parse(ctoRaw) : null;
    ctoCoverage = summarizeCTOCoverage(ctoRollup);
    if (ctoCoverage.insufficient_candles >= 5) {
      actions.push({
        kind: "structural",
        id: "cto_candle_backfill",
        title: `${ctoCoverage.insufficient_candles} universe tickers lack D-candles for CTO levels — run candle backfill before officers rely on probabilistic targets.`,
      });
    }
  } catch (_) {}
  try {
    const tacRaw = await KV.get("cro:tactical_overrides");
    const tacBlob = tacRaw ? JSON.parse(tacRaw) : null;
    tacticalCross = crossRefTacticalOverlay(usage, tacBlob);
    if (tacticalCross.idle_while_tactical_live) {
      actions.push({
        kind: "structural",
        id: "tactical_vs_idle_plays",
        title: "Live CRO tactical overlay favors specific themes while multiple TT-core plays sat idle — align trigger coverage with the tactical rotation.",
      });
    }
  } catch (_) {}
  try {
    promotionPipeline = await loadPromotionPipeline(db, { limit: 5 });
  } catch (_) {}

  const gameplan = {
    generated: new Date().toISOString(),
    source: "discovery_gameplan_v1",
    capture,
    constraint_mix: constraint.mix,
    binding_constraint: constraint.binding_constraint,
    binding_constraint_pct: constraint.binding_constraint_pct,
    total_classified_misses: constraint.total_classified,
    diagnosis_present: !!report.diagnosis,
    playbook_usage: usage,
    miss_archetypes: archetypes,
    cto_coverage: ctoCoverage,
    tactical_cross: tacticalCross,
    promotion_pipeline: promotionPipeline,
    actions: actions.slice(0, 10),
    narrative: buildGameplanNarrative({ capture, constraint, usage, archetypes, ctoCoverage, tacticalCross, promotionPipeline }),
  };

  /* 4. Persist: standalone KV blob for officers (small, cheap to load
        in prompt-building paths) AND merged into the move-discovery
        report so the Discovery tab renders it with zero extra fetches
        (same pattern diagnosis uses). */
  try {
    await KV.put(GAMEPLAN_KV_KEY, JSON.stringify(gameplan), { expirationTtl: 86400 * 14 });
  } catch (_) {}
  try {
    report.gameplan = gameplan;
    await KV.put(MOVE_DISCOVERY_KV_KEY, JSON.stringify(report), { expirationTtl: 86400 * 90 });
  } catch (_) {}

  return { ok: true, elapsed_ms: Date.now() - t0, gameplan };
}

export { GAMEPLAN_KV_KEY };
