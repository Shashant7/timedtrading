// ═══════════════════════════════════════════════════════════════════════════
// trajectory-cells.js — bubble-map state-space discretization (S0)
// ═══════════════════════════════════════════════════════════════════════════
//
// Foundation for the trajectory research program
// (tasks/2026-05-18-stochastic-research-program.md, Phase 1).
//
// PURPOSE
// -------
// Map any trail_5m_facts row (or live ticker payload) to a discrete bubble-map
// cell label so trajectories can be compared, counted, transitioned over
// (Markov), and matched (k-NN). The bubble map is already a state space; this
// module formalizes the discretization.
//
// v0 SCHEMA (640 cells before signal-flag overlay)
//   state            (4) — B (HTF_BULL_LTF_BULL), Bp (HTF_BULL_LTF_PULLBACK),
//                          R (HTF_BEAR_LTF_BEAR), Rp (HTF_BEAR_LTF_PULLBACK)
//   rank_decile      (10) — 0..9 by ascending rank percentile (0 = best rank,
//                           9 = worst). NULL rank → decile 9 (worst).
//   completion_band  (4) — 0..3 over [0,25), [25,50), [50,75), [75,100]
//   phase_band       (4) — 0..3 over [0,25), [25,50), [50,75), [75,100]
//
// SIGNAL-FLAG OVERLAY (optional, NOT in base cell key)
//   had_squeeze_release → +sq
//   had_ema_cross       → +ec
//   had_st_flip         → +st
//   had_momentum_elite  → +me
//
// Why 640 and not finer? With ~600K trail_5m_facts snapshots + 598 closed
// trades all-time, finer discretization would push most cohorts below
// the n>=15 floor the owner locked in. 640 cells is coarse enough that
// most active cells will hit n>=15 across a 30-day window, fine enough
// that trajectories show structural differences (per the chop-vs-trend
// motivating example in the program doc §0.2).
//
// All functions in this module are PURE — no I/O, no env access. Safe to
// import from worker code, scripts, and tests.
// ═══════════════════════════════════════════════════════════════════════════

// ── State codes ───────────────────────────────────────────────────────────
// trail_5m_facts.state values seen in production:
//   HTF_BULL_LTF_BULL, HTF_BULL_LTF_PULLBACK,
//   HTF_BEAR_LTF_BEAR, HTF_BEAR_LTF_PULLBACK,
//   NEUTRAL_*, FLAT, etc. We collapse to four canonical buckets; any
//   unrecognized state maps to "N" (neutral) which is excluded from the
//   640-cell count and treated as a sparse zone.

export const STATE_CODES = Object.freeze({
  HTF_BULL_LTF_BULL:     "B",   // aligned bull
  HTF_BULL_LTF_PULLBACK: "Bp",  // bull with intraday pullback
  HTF_BEAR_LTF_BEAR:     "R",   // aligned bear (R = "red")
  HTF_BEAR_LTF_PULLBACK: "Rp",  // bear with intraday pullback
});

export const NEUTRAL_STATE_CODE = "N";

/**
 * Collapse a raw trail_5m_facts.state string into the 4-letter canonical
 * code. Anything not in the matrix → "N". Caller can decide whether to
 * include or skip neutral cells when building trajectories.
 */
export function stateCode(rawState) {
  if (!rawState || typeof rawState !== "string") return NEUTRAL_STATE_CODE;
  const upper = rawState.trim().toUpperCase();
  return STATE_CODES[upper] || NEUTRAL_STATE_CODE;
}

// ── Rank decile ───────────────────────────────────────────────────────────
//
// Rank in the trail_5m_facts row is the ticker's ABSOLUTE rank in the
// scored universe at that bucket. To bucket into deciles we need the
// universe size at that moment. For simplicity (and because universe size
// hovers around 230-260) we use a fixed proxy: assume a 250-ticker
// universe and bucket by absolute rank position. Caller can override by
// passing universeSize when known (e.g. when computing cells live from a
// snapshot that has a known total count).
//
// Decile 0 = best (rank 1-25 in a 250 universe); decile 9 = worst.
// Unranked (NULL / 0 / negative) → decile 9 (treat as "not scored").

const DEFAULT_UNIVERSE_SIZE = 250;

export function rankDecile(rank, universeSize = DEFAULT_UNIVERSE_SIZE) {
  const r = Number(rank);
  if (!Number.isFinite(r) || r <= 0) return 9;
  const size = Number.isFinite(universeSize) && universeSize > 0 ? universeSize : DEFAULT_UNIVERSE_SIZE;
  const pct = Math.min(1, Math.max(0, (r - 1) / size));
  const dec = Math.min(9, Math.floor(pct * 10));
  return dec;
}

// ── Completion band & phase band ───────────────────────────────────────────
//
// trail_5m_facts.completion and trail_5m_facts.phase_pct are both 0..1
// fractions (the production aggregator stores them that way — see
// worker/index.js INSERT). If a caller passes already-scaled values (0..100)
// we detect and normalize. Anything non-finite → band 0.

function bandOfFraction(rawValue) {
  let v = Number(rawValue);
  if (!Number.isFinite(v)) return 0;
  // Normalize 0..100 → 0..1 if needed
  if (v > 1.0 && v <= 100.0) v = v / 100.0;
  if (v < 0) v = 0;
  if (v > 1) v = 1;
  // Bands: [0, 0.25), [0.25, 0.50), [0.50, 0.75), [0.75, 1.0]
  if (v < 0.25) return 0;
  if (v < 0.50) return 1;
  if (v < 0.75) return 2;
  return 3;
}

export const completionBand = bandOfFraction;
export const phaseBand = bandOfFraction;

// ── Signal-flag overlay ────────────────────────────────────────────────────

const FLAG_TAGS = [
  { key: "had_squeeze_release", tag: "+sq" },
  { key: "had_ema_cross",       tag: "+ec" },
  { key: "had_st_flip",         tag: "+st" },
  { key: "had_momentum_elite",  tag: "+me" },
];

export function flagOverlay(fact) {
  if (!fact || typeof fact !== "object") return "";
  const tags = [];
  for (const { key, tag } of FLAG_TAGS) {
    if (Number(fact[key]) === 1) tags.push(tag);
  }
  return tags.join("");
}

// ── Cell key ───────────────────────────────────────────────────────────────
//
// Compact, sortable, human-debuggable: "B|D7|C2|P1" reads as
// "Bull-aligned, rank decile 7, completion band 2 (50-75%), phase band 1 (25-50%)".
// With +flags: "B|D7|C2|P1+sq+ec"
//
// The base key (no flags) is what we use for the 640-cell Markov transition
// matrix in S6. The +flags variant is used for richer cohort matching in
// S2.5 when the trajectory recorder captures the full snapshot.

export function cellOfFact(fact, opts = {}) {
  if (!fact || typeof fact !== "object") return null;
  const sc = stateCode(fact.state);
  if (sc === NEUTRAL_STATE_CODE && opts.skipNeutral !== false) {
    // Neutral cells are sparse and not useful for trajectory matching by
    // default. Caller can opt in via opts.skipNeutral = false.
    return null;
  }
  const dec = rankDecile(fact.rank, opts.universeSize);
  const cb = completionBand(fact.completion);
  const pb = phaseBand(fact.phase_pct);
  return `${sc}|D${dec}|C${cb}|P${pb}`;
}

export function cellOfFactWithFlags(fact, opts = {}) {
  const base = cellOfFact(fact, opts);
  if (!base) return null;
  return base + flagOverlay(fact);
}

// ── Cell key parser (for analytics + UI) ───────────────────────────────────

const CELL_KEY_RE = /^(B|Bp|R|Rp|N)\|D(\d)\|C(\d)\|P(\d)((?:\+[a-z]{2})*)$/;

export function parseCellKey(key) {
  if (!key || typeof key !== "string") return null;
  const m = CELL_KEY_RE.exec(key);
  if (!m) return null;
  const flagSegment = m[5] || "";
  const flags = flagSegment ? flagSegment.split("+").filter(Boolean) : [];
  return {
    state: m[1],
    decile: Number(m[2]),
    completionBand: Number(m[3]),
    phaseBand: Number(m[4]),
    flags,
  };
}

// ── Enumerate the full 640-cell space (used by Markov matrix init) ─────────

export function enumerateAllCells() {
  const states = ["B", "Bp", "R", "Rp"];
  const cells = [];
  for (const s of states) {
    for (let d = 0; d < 10; d++) {
      for (let c = 0; c < 4; c++) {
        for (let p = 0; p < 4; p++) {
          cells.push(`${s}|D${d}|C${c}|P${p}`);
        }
      }
    }
  }
  return cells;
}

// ── Hamming distance between two cell sequences (for S2.5 k-NN in Phase 2) ─
//
// Sequences are arrays of cell-key strings. Distance = count of positions
// where the cell keys differ. Sequences of unequal length are aligned to
// the shorter and the length-diff is added to the score (so a candidate
// trajectory of length 5 compared to a historical of length 12 isn't
// artificially "close" just because positions 1-5 happen to match).
//
// Returned distance is INTEGER ≥ 0. Lower = more similar.

export function hammingDistance(seqA, seqB) {
  if (!Array.isArray(seqA) || !Array.isArray(seqB)) return Infinity;
  const minLen = Math.min(seqA.length, seqB.length);
  const lenDiff = Math.abs(seqA.length - seqB.length);
  let d = lenDiff;
  for (let i = 0; i < minLen; i++) {
    if (seqA[i] !== seqB[i]) d += 1;
  }
  return d;
}

// ── Self-test (run with `node worker/lib/trajectory-cells.js`) ─────────────
//
// Not a real test runner — just a smoke harness that confirms the cell
// space enumerates correctly and known production-shape rows map sensibly.
// Wrapped in an ESM main-detect for Node CLI use.

const __isMainModule = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      process?.argv?.[1] &&
      /trajectory-cells\.js$/.test(process.argv[1])
    );
  } catch { return false; }
})();

if (__isMainModule) {
  const cells = enumerateAllCells();
  console.log(`[trajectory-cells] enumerated cells: ${cells.length} (expect 640)`);
  if (cells.length !== 640) { process.exit(1); }

  // Production-shape row examples
  const samples = [
    { state: "HTF_BULL_LTF_BULL",     rank: 5,   completion: 0.18, phase_pct: 0.12 },
    { state: "HTF_BULL_LTF_BULL",     rank: 80,  completion: 0.55, phase_pct: 0.42, had_squeeze_release: 1 },
    { state: "HTF_BEAR_LTF_PULLBACK", rank: 200, completion: 0.92, phase_pct: 0.88, had_st_flip: 1, had_ema_cross: 1 },
    { state: "FLAT",                  rank: 240, completion: 0.30, phase_pct: 0.30 },
    { state: "HTF_BULL_LTF_BULL",     rank: null, completion: null, phase_pct: null },
  ];
  for (const s of samples) {
    const key = cellOfFactWithFlags(s);
    const parsed = key ? parseCellKey(key) : null;
    console.log(`  ${JSON.stringify(s).padEnd(110)} -> ${key} ${parsed ? JSON.stringify(parsed) : ""}`);
  }

  // Distance smoke
  const seqA = ["B|D2|C0|P0", "B|D2|C0|P0", "B|D3|C1|P1", "B|D4|C2|P2"];
  const seqB = ["B|D2|C0|P0", "B|D3|C0|P0", "B|D3|C1|P1", "B|D4|C2|P2"];
  console.log(`[trajectory-cells] hammingDistance(seqA, seqB) = ${hammingDistance(seqA, seqB)} (expect 1)`);
  console.log(`[trajectory-cells] hammingDistance(seqA, seqA) = ${hammingDistance(seqA, seqA)} (expect 0)`);
  console.log(`[trajectory-cells] hammingDistance(seqA.slice(0,3), seqB) = ${hammingDistance(seqA.slice(0,3), seqB)} (expect 1 length diff + 1 mismatch = 2)`);
}
