// One ordering contract for discovery and the live cron's candidate batch.
// Technical rank remains a 0–100 admission input. Priority is an unbounded
// score, not a probability; retaining pre-cap precision separates rank=100s.
import { isQuarantinedByFreshness } from "../freshness.js";
import { resolvePlaySide } from "./play-side.js";

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
  resolveSide = d => d?.__rank_trace?.side
    || resolvePlaySide(d)
    || (Number(d.htf_score) > 0 ? "LONG" : Number(d.htf_score) < 0 ? "SHORT" : null),
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
//
// Never holds more than one payload.
//
// 2026-09-23: the live batch is 268 tickers, not the ~45 this pass was long
// assumed to handle — most of the universe classifies as `hold`, which is a
// management stage. A `timed:latest` payload is ~165 KB of JSON and several
// times that parsed, so materialising the batch to rank it is by itself
// more than the 128 MB isolate, and the `*/5` engine tick died on every
// pass for six days.
//
// Ranking needs every score before it can order anything, but it does not
// need every payload: a score is a number. The scan keeps the numbers and
// drops each payload, then the entry pass re-reads them one at a time.
//
// Management is not ranked, so it is processed on the scan itself and never
// read twice. Priority and original order are unchanged either way — every
// management candidate is still processed before any entry.
//
// `deadlineAt` (ms, optional) bounds the ENTRY pass only. The whole point of
// ranking is that the order is meaningful, so when the tick runs out of time
// the candidates to drop are the ones at the bottom of it. Without this the
// engine tick simply overran: at market ramp the pass went from ~200s to
// ~480s (`processTradeSimulation` is ~1.75s a candidate and D1 slows down
// under load), scoring ahead of it takes ~220s, and the whole invocation hit
// Cloudflare's 900s wall — which kills the deferred tail and position
// reconcile too, so nothing downstream of the pass ran at all. Management is
// never deferred: it is open risk, not a new position. `now` is injectable
// so the deadline can be tested without touching the clock.
//
// `loadPayload(ticker, phase)` is called with `"scan"` and, for entry
// candidates only, again with `"entry"`. A caller that counts rejections
// counts them on the scan. Returning a falsy payload drops the ticker.
//
// The reads are overlapped, the work is not. The scan reads in windows of
// `scanConcurrency` and then walks the window in order; the entry pass
// reads one candidate ahead of the one it is processing. Peak retention is
// therefore `scanConcurrency` payloads, not the batch. This matters because
// the second read is a cold one: the tail that used to warm every
// `timed:latest` key alongside this pass now runs after it, and 536
// sequential cold reads cost the engine tick ~190s.
//
// Returns `{ processed, management, entries, deferred }` — the log line that
// reports this pass is the only view anyone has of it, and `deferred` is the
// one number that says the tick is over budget.
export async function processRankedCandidates(tickers, {
  loadPayload, scoreCandidate, processCandidate, onError, scanConcurrency = 6,
  deadlineAt = 0, now = Date.now,
}) {
  const entries = [];
  let processed = 0;
  let managed = 0;

  const read = async (ticker, phase) => {
    try {
      const payload = await loadPayload(ticker, phase);
      return payload && typeof payload === "object" ? payload : null;
    } catch (error) {
      if (onError) onError(error, { ticker, payload: null });
      else throw error;
      return null;
    }
  };

  const window = Math.max(1, Math.floor(scanConcurrency) || 1);
  for (let w = 0; w < tickers.length; w += window) {
    const batch = tickers.slice(w, w + window);
    const loaded = await Promise.all(batch.map((t) => read(t, "scan")));
    for (let b = 0; b < batch.length; b++) {
      const ticker = batch[b];
      let payload = loaded[b];
      loaded[b] = null;
      if (!payload) continue;

      if (!MANAGEMENT_STAGES.has(String(payload.kanban_stage || "").toLowerCase())) {
        entries.push({
          ticker,
          score: capRankByFreshness(payload, scoreCandidate(payload)),
          quarantined: isQuarantinedByFreshness(payload),
        });
        payload = null;
        continue;
      }

      managed++;
      try {
        await processCandidate({ ticker, payload });
        processed++;
      } catch (error) {
        if (onError) onError(error, { ticker, payload });
        else throw error;
      } finally {
        payload = null;
      }
    }
  }
  entries.sort(compareCandidateRanks);

  // One read in flight ahead of the candidate being processed. Processing
  // stays strictly sequential -- a later entry must still observe the
  // earlier entry's capacity usage -- but it no longer waits on KV.
  let ahead = entries.length ? read(entries[0].ticker, "entry") : null;
  let deferred = 0;
  for (let i = 0; i < entries.length; i++) {
    const item = entries[i];
    let payload = await ahead;
    ahead = i + 1 < entries.length ? read(entries[i + 1].ticker, "entry") : null;
    if (deadlineAt && now() >= deadlineAt) {
      // Everything from here down is lower-ranked than everything already
      // attempted, and the next tick is five minutes away.
      deferred = entries.length - i;
      break;
    }
    if (!payload) continue;
    try {
      // The scan stamped `_ranking` / `_technical_rank` / the tilts onto a
      // payload that has since been dropped, so stamp this copy too. The
      // recorded score stays the scan's — that is the one that decided the
      // order.
      scoreCandidate(payload);
      capRankByFreshness(payload, item.score);
      payload.__candidate_order = {
        version: CANDIDATE_RANK_VERSION,
        score: item.score,
        position: i + 1,
        total: entries.length,
      };
      await processCandidate({ ticker: item.ticker, payload });
      processed++;
    } catch (error) {
      if (onError) onError(error, { ticker: item.ticker, payload });
      else throw error;
    } finally {
      payload = null;
    }
  }
  return { processed, management: managed, entries: entries.length, deferred };
}
