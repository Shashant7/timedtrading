// One ordering contract for discovery and the live cron's candidate batch.
// Technical rank remains a 0–100 admission input. Priority is an unbounded
// score, not a probability; retaining pre-cap precision separates rank=100s.
import { isQuarantinedByFreshness } from "../freshness.js";

export const CANDIDATE_RANK_VERSION = "candidate-rank-v3";
export const FRESHNESS_RANK_CAP = 10;
const MANAGEMENT_STAGES = new Set(["defend", "trim", "exit", "just_entered", "hold"]);
const finite = v => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) &&
  Number.isFinite(Number(v)) ? Number(v) : null;
const round = v => Math.round(v * 100) / 100;

export function capRankByFreshness(payload, score) {
  const safe = Math.max(0, finite(score) ?? 0);
  const quarantined = isQuarantinedByFreshness(payload);
  if (payload && typeof payload === "object") {
    if (quarantined) payload._rank_freshness_capped = true;
    else delete payload._rank_freshness_capped;
  }
  return quarantined ? Math.min(safe, FRESHNESS_RANK_CAP) : safe;
}

export function stampTechnicalRank(payload, rawScore, formula) {
  const raw = finite(rawScore) ?? 0;
  const gate = capRankByFreshness(payload, Math.round(Math.max(0, Math.min(100, raw))));
  payload._technical_rank = {
    version: CANDIDATE_RANK_VERSION, formula, raw_score: raw, gate_score: gate,
  };
  return gate;
}

export function candidateBaseScore(payload = {}) {
  const gate = finite(payload.rank);
  // Missing is not average, and a valid zero must never turn into 50.
  if (gate === null || gate <= 0) return 0;
  const c = payload._technical_rank;
  // Do not use a prior snapshot's raw score after the gate score was replaced.
  const raw = c?.version === CANDIDATE_RANK_VERSION && c.gate_score === gate
    ? finite(c.raw_score) : null;
  return capRankByFreshness(payload, raw ?? gate);
}

export function finalizeCandidateScore(payload, score, baseScore) {
  const final = candidateBaseScore(payload) === 0 ? 0 : capRankByFreshness(payload, score);
  const rounded = round(final);
  const parts = [{ label: "technical_base", delta: baseScore }];
  for (const [label, field] of [["theme", "_theme_tilt"], ["fair_value", "_fv_tilt"],
    ["harmonic", "_harmonic_tilt"], ["officer", "_officer_tilt"], ["macro", "_macro_wire_tilt"]]) {
    const active = finite(payload[field]), shadow = finite(payload[field + "_shadow"]);
    parts.push({ label, delta: active ?? 0, shadow_delta: shadow,
      status: active !== null ? "applied" : shadow !== null ? "shadow" : "not_applied" });
  }
  parts.push({ label: "score_cap", delta: final - score });
  parts.push({ label: "rounding", delta: rounded - final });
  payload._ranking = {
    version: CANDIDATE_RANK_VERSION,
    base_score: baseScore,
    overlay_delta: round((finite(score) ?? 0) - baseScore),
    final_score: rounded,
    quarantined: isQuarantinedByFreshness(payload),
    parts,
  };
  return rounded;
}

export function computeCandidateScore(ticker, {
  themeMap = null, officerMap = null, macroMap = null,
  lookupOfficerTilt = () => null, lookupMacroRiskTilt = () => null,
  resolveSide = d => d?.__rank_trace?.side || (Number(d.htf_score) > 0 ? "LONG" : Number(d.htf_score) < 0 ? "SHORT" : null),
} = {}) {
  // A rescore must not retain an active/shadow tilt from an earlier snapshot.
  for (const field of ["_theme_tilt", "_theme_tilt_shadow", "_theme_tilt_theme",
    "_fv_tilt", "_fv_tilt_shadow", "_harmonic_tilt", "_harmonic_tilt_shadow",
    "_officer_tilt", "_officer_tilt_shadow", "_cto_tilt", "_cro_note_tilt",
    "_macro_wire_tilt", "_macro_wire_tilt_shadow", "_macro_wire_risk_tone"]) delete ticker[field];
  const baseScore = candidateBaseScore(ticker);
  const candidateSide = resolveSide(ticker);
  // Lookups consume only the sign. Use the same side that earned technical
  // rank, including forming-pair turns against the older HTF state.
  const htf = candidateSide === "LONG" ? 1 : candidateSide === "SHORT" ? -1 : 0;
  // computeRank already accounts for technical alignment, triggers, R:R,
  // phase, completion and move status. Apply only independent overlays here.
  let dynamicScore = baseScore;

  // 2026-06-10 — CRO theme-tilt overlay (worker/theme-tilt.js). Bounded
  // ±6, DIRECTION-AWARE: a hot theme helps a LONG-side candidate and
  // hurts a SHORT-side candidate on the same ticker. The side is shared
  // with technical rank. The map is preloaded by the scoring cron preamble and
  // the /timed/all handler (themeMap below); when the gate
  // (model_config cro_theme_rank_boost_enabled) is OFF the tilt is
  // still attached as _theme_tilt_shadow so the effect stays
  // measurable, but the score is untouched.
  try {
    const sym = String(ticker.ticker || "").toUpperCase();
    const tiltEntry = sym ? themeMap?.by_ticker?.[sym] : null;
    if (tiltEntry && finite(tiltEntry.tilt) !== null) {
      const side = htf > 0 ? 1 : htf < 0 ? -1 : 0;
      const applied = Math.round(tiltEntry.tilt * side * 10) / 10;
      if (themeMap.enabled) {
        dynamicScore += applied;
        ticker._theme_tilt = applied;
      } else {
        ticker._theme_tilt_shadow = applied;
      }
      ticker._theme_tilt_theme = tiltEntry.theme;
    }
  } catch (_) { /* tilt must never break scoring */ }

  // B6 (2026-06-11) — Fair Value & Quality tilt (worker/fair-value.js).
  // Bounded ±5, DIRECTION-AWARE like the theme tilt: a quality business
  // trading below fair value is a tailwind for LONG-side candidates and a
  // headwind for SHORT-side ones. The signed magnitude (+favors-LONG) was
  // computed at scoring time onto _fair_value.tilt; gate
  // fair_value_rank_boost_enabled controls whether it moves the score or
  // attaches as shadow only. Never an admission gate.
  try {
    const fv = ticker._fair_value;
    const fvTilt = Number(fv?.tilt);
    if (fv && Number.isFinite(fvTilt) && fvTilt !== 0) {
      const side = htf > 0 ? 1 : htf < 0 ? -1 : 0;
      const appliedFv = Math.round(fvTilt * side * 10) / 10;
      if (appliedFv !== 0) {
        if (fv.tilt_enabled) {
          dynamicScore += appliedFv;
          ticker._fv_tilt = appliedFv;
        } else {
          ticker._fv_tilt_shadow = appliedFv;
        }
      }
    }
  } catch (_) { /* tilt must never break scoring */ }

  // Harmonic Wave rank tilt (worker/harmonic-modifiers.js). Bounded ±4
  // (calibration-weighted on payload), direction-aware like theme tilt.
  try {
    const hc = ticker.harmonic_cycle;
    const hTilt = Number(hc?.rank_tilt);
    if (hc && Number.isFinite(hTilt) && hTilt !== 0) {
      const side = htf > 0 ? 1 : htf < 0 ? -1 : 0;
      const applied = Math.round(hTilt * side * 10) / 10;
      if (hc.tilt_enabled !== false) {
        dynamicScore += applied;
        ticker._harmonic_tilt = applied;
      } else {
        ticker._harmonic_tilt_shadow = applied;
      }
    }
  } catch (_) { /* tilt must never break scoring */ }

  // 2026-06-11 — Officer rank overlay (CTO probabilistic levels + CRO note
  // sector nudge). Bounded ±5 total, direction-aware like theme tilt.
  try {
    const symOff = String(ticker.ticker || "").toUpperCase();
    if (symOff && officerMap) {
      // Sector hint from the payload skips a per-ticker strategy lookup.
      const _offSector = ticker.sector || ticker._ticker_profile?.sector || null;
      const entry = lookupOfficerTilt(officerMap, symOff, htf, _offSector);
      if (entry) {
        const gates = officerMap.gates || {};
        const applied = finite(entry.tilt) ?? 0;
        if ((gates.cto !== false || gates.cro !== false) && applied !== 0) {
          dynamicScore += applied;
          ticker._officer_tilt = applied;
          if (entry.cto) ticker._cto_tilt = entry.cto;
          if (entry.cro) ticker._cro_note_tilt = entry.cro;
        } else if (applied !== 0) {
          ticker._officer_tilt_shadow = applied;
        }
        if (entry.cto_upside || entry.cto_downside) {
          ticker._cto_levels = {
            top_upside: entry.cto_upside,
            top_downside: entry.cto_downside,
          };
        }
      }
    }
  } catch (_) { /* officer tilt must never break scoring */ }

  // 2026-07-09 — Macro wire rank tilt (DeItaone LLM-classified pulse).
  // Bounded ±4, direction-aware like theme tilt.
  try {
    const symMw = String(ticker.ticker || "").toUpperCase();
    if (symMw && macroMap) {
      const entry = lookupMacroRiskTilt(macroMap, symMw, htf);
      if (entry) {
        const applied = finite(entry.tilt) ?? 0;
        if (macroMap.enabled && applied !== 0) {
          dynamicScore += applied;
          ticker._macro_wire_tilt = applied;
          ticker._macro_wire_risk_tone = entry.risk_tone;
        } else if (applied !== 0) {
          ticker._macro_wire_tilt_shadow = applied;
        }
      }
    }
  } catch (_) { /* macro wire tilt must never break scoring */ }

  // Freshness is enforced after every overlay; stale data cannot regain rank.
  return finalizeCandidateScore(ticker, dynamicScore, baseScore);
}

export function compareCandidateRanks(a, b) {
  return Number(a.quarantined) - Number(b.quarantined) || b.score - a.score ||
    (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0);
}

export function rankCandidateBatch(candidates, scoreCandidate) {
  return candidates.map(({ ticker, payload }) => ({
    ticker, payload,
    score: capRankByFreshness(payload, scoreCandidate(payload)),
    quarantined: isQuarantinedByFreshness(payload),
  })).sort(compareCandidateRanks);
}

export function stampCandidatePositions(data, scoreCandidate) {
  const ranked = rankCandidateBatch(Object.entries(data)
    .filter(([, payload]) => payload && typeof payload === "object")
    .map(([ticker, payload]) => ({ ticker, payload })), scoreCandidate);
  ranked.forEach(({ payload, score }, i) => {
    payload.dynamicScore = score;
    payload.rank_score = score;
    payload.rank_position = payload.position = i + 1;
    payload.rank_total = ranked.length;
    // Backward compatibility: score is still the bounded admission rank.
    payload.score = finite(payload.rank) ?? 0;
  });
  return ranked;
}

// No top-N filter or new gates. Every existing candidate is attempted, in
// order, and the existing admission/capacity checks still decide each entry.
// Management has priority and retains its original order. Processing stays
// sequential so a later entry observes the earlier entry's capacity usage.
export async function processRankedCandidates(candidates, { scoreCandidate, processCandidate, onError }) {
  const management = [], entries = [];
  for (const candidate of candidates) {
    (MANAGEMENT_STAGES.has(String(candidate.payload?.kanban_stage || "").toLowerCase())
      ? management : entries).push(candidate);
  }
  const ranked = rankCandidateBatch(entries, scoreCandidate);
  ranked.forEach(({ payload, score }, i) => {
    payload.__candidate_order = {
      version: CANDIDATE_RANK_VERSION, score, position: i + 1, total: ranked.length,
    };
  });
  let processed = 0;
  for (const candidate of [...management, ...ranked]) {
    try {
      await processCandidate(candidate);
      processed++;
    } catch (error) {
      if (onError) onError(error, candidate);
      else throw error;
    }
  }
  return processed;
}
