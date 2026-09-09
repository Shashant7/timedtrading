// Economic ranking challenger. A score is an ordering signal, NOT a win probability.
// Only canonical setup, legacy technical rank, quoted R:R and side are inputs. No grade, ticker,
// MFE, trim or exit field can enter a prediction. Fits are strictly as-of.
// Offline experiment only; this module is deliberately not imported by runtime.
import { canonicalPlayId, resolvePlay } from "../foundation/play-catalog.js";
export const OUTCOME_RANK_VERSION = "outcome-rank-v2-setup";
export const OUTCOME_RANK_DEFAULTS = Object.freeze({
  lookbackDays: 180, halfLifeDays: 60, priorWeight: 20, minSamples: 30,
  returnClipPct: 10, roundTripCostBps: 10,
});
const DAY = 86400000;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const finite = v => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) &&
  Number.isFinite(Number(v)) ? Number(v) : null;

export function rankFeatures(input = {}) {
  const rank = finite(input.legacy_rank ?? input.rank);
  const rr = finite(input.rr);
  const side = String(input.direction || "").toUpperCase();
  if (rank === null || rank < 0 || rank > 100 || rr === null || rr < 0 ||
      !["LONG", "SHORT"].includes(side)) return null;
  const play = canonicalPlayId(input.entry_path, input.setup_name, side);
  return {
    rank, rr, side,
    play: resolvePlay(play, side)?.id || "unknown",
    rankBand: rank < 60 ? "low" : rank < 80 ? "mid" : rank < 100 ? "high" : "saturated",
    rrBand: rr < 1.5 ? "low" : rr < 3 ? "medium" : rr < 5 ? "high" : "very_high",
  };
}

function keys(f) { return [f.side, `${f.side}|${f.play}`, `${f.side}|${f.play}|${f.rrBand}|${f.rankBand}`]; }
const empty = () => ({ n: 0, weight: 0, weight2: 0, sum: 0, sum2: 0 });
function add(s, y, w) {
  s.n++; s.weight += w; s.weight2 += w * w; s.sum += w * y; s.sum2 += w * y * y;
}

export function isUsableOutcome(r) {
  const entered = finite(r?.entry_ts), exited = finite(r?.exit_ts);
  return !!r?.trade_id && !!rankFeatures(r) && finite(r?.pnl_pct) !== null &&
    entered !== null && entered > 0 && exited !== null && exited >= entered &&
    ["WIN", "LOSS", "FLAT"].includes(r.status) && r.exit_reason !== "replay_end_close" &&
    r.data_quality_invalid !== true && ![true, 1, "true", "1"].includes(r.is_replay);
}

export function fitOutcomeRank(rows, asOf, overrides = {}) {
  const cfg = { ...OUTCOME_RANK_DEFAULTS, ...overrides };
  if (!Number.isFinite(asOf) || asOf <= 0) throw new Error("rank_asof_required");
  for (const k of ["lookbackDays", "halfLifeDays", "priorWeight", "minSamples", "returnClipPct"]) {
    if (!Number.isFinite(cfg[k]) || cfg[k] <= 0) throw new Error(`invalid_rank_config:${k}`);
  }
  if (!Number.isFinite(cfg.roundTripCostBps) || cfg.roundTripCostBps < 0) throw new Error("invalid_rank_cost");
  const groups = {}, total = empty(), seen = new Set();
  const exclusions = { invalid: 0, duplicate: 0, notYetClosed: 0, outsideWindow: 0 };
  let latestExit = null;
  // Stable selection of duplicate IDs; conflicting duplicates are excluded altogether.
  const counts = new Map();
  for (const r of rows || []) if (r?.trade_id) counts.set(r.trade_id, (counts.get(r.trade_id) || 0) + 1);
  for (const r of rows || []) {
    const id = r?.trade_id, entered = finite(r?.entry_ts), exited = finite(r?.exit_ts);
    const y = finite(r?.pnl_pct), f = rankFeatures(r);
    if (!isUsableOutcome(r)) {
      exclusions.invalid++; continue;
    }
    if (counts.get(id) > 1 || seen.has(id)) { exclusions.duplicate++; continue; }
    seen.add(id);
    if (exited >= asOf) { exclusions.notYetClosed++; continue; }
    if (exited < asOf - cfg.lookbackDays * DAY) { exclusions.outsideWindow++; continue; }
    const w = 2 ** (-(asOf - exited) / (cfg.halfLifeDays * DAY));
    const target = clamp(y, -cfg.returnClipPct, cfg.returnClipPct) - cfg.roundTripCostBps / 100;
    add(total, target, w);
    for (const k of keys(f)) add(groups[k] ||= empty(), target, w);
    latestExit = Math.max(latestExit || 0, exited);
  }
  return { version: OUTCOME_RANK_VERSION, asOf, latestExit, cfg, total, groups, exclusions };
}

export function scoreOutcomeRank(input, model, asOf) {
  const f = rankFeatures(input);
  const base = { version: OUTCOME_RANK_VERSION, available: false, score: null, features: f };
  if (!f) return { ...base, reason: "missing_rank_inputs" };
  if (!model || model.version !== OUTCOME_RANK_VERSION) return { ...base, reason: "missing_rank_model" };
  if (!Number.isFinite(asOf) || model.asOf > asOf || model.latestExit >= asOf) return { ...base, reason: "future_rank_model" };
  if (asOf - model.asOf > DAY) return { ...base, reason: "stale_rank_model" };
  if (model.total.n < model.cfg.minSamples) return { ...base, reason: "insufficient_rank_history", samples: model.total.n };
  // Hierarchical shrinkage: side -> setup -> R:R/technical-rank band. Each level
  // borrows its parent's mean; sparse cohorts cannot acquire an extreme score.
  let mean = 0, variance = 4, chosen = null;
  const lineage = [];
  for (const k of keys(f)) {
    const s = model.groups[k];
    if (!s?.n) continue;
    const prior = model.cfg.priorWeight;
    const rawMean = s.sum / s.weight;
    const rawVariance = Math.max(0, s.sum2 / s.weight - rawMean * rawMean);
    mean = (s.sum + prior * mean) / (s.weight + prior);
    variance = (s.weight * rawVariance + prior * variance) / (s.weight + prior);
    chosen = s;
    lineage.push({ cohort: k, samples: s.n, weight: s.weight, mean_pct: mean });
  }
  if (!chosen) return { ...base, reason: "unseen_direction" };
  const effectiveN = chosen.weight * chosen.weight / chosen.weight2;
  // Uncertainty penalty is a ranking heuristic, not a confidence interval:
  // trades overlap and are not independent draws.
  const uncertainty = Math.sqrt(variance / Math.max(1, effectiveN));
  const utility = mean - uncertainty;
  return {
    ...base, available: true, reason: "calibrated",
    score: Math.round(clamp(50 + 10 * utility, 0, 100) * 100) / 100,
    expected_return_pct: mean, uncertainty_pct: uncertainty, utility_pct: utility,
    samples: chosen.n, effective_samples: effectiveN, lineage,
    trained_as_of: model.asOf, latest_training_exit: model.latestExit,
    training_samples: model.total.n, round_trip_cost_bps: model.cfg.roundTripCostBps,
  };
}
