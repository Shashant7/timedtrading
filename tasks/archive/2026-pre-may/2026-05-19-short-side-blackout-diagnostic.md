# 2026-05-19 — SHORT-side blackout diagnostic
**Owner question (Option B item 3, PR #203 strategy diagnostic, re-affirmed in Phase 4 enable):**
> "Zero historical short trades in 30 days while gap_reversal_short is PF 8.86 all-time. Why?"

This doc ships as a planning artifact. No live code change. Concrete remediation paths ranked at the bottom.

---

## TL;DR

**It is not a regime problem. It is a code problem.**

Production trail_5m_facts over the last 30 days:

| State family | Buckets | % |
|---|---|---|
| BULL family (`HTF_BULL_*`) | 256,802 | **68.7%** |
| BEAR family (`HTF_BEAR_*`) | 116,783 | **31.3%** |

Almost 1-in-3 buckets is bear-state. That's 116,783 candidate moments where a SHORT setup could have been a valid candidate. Yet `trade_trajectories` shows **zero** SHORT entries in the same window.

The structural cause is upstream of every SHORT gate we've calibrated: **direction is assigned LONG from state/consensus BEFORE setup triggers fire.** Counter-trend setups like `gap_reversal_short` (gap-up + fade — the highest-PF setup in the book at 8.86) are inherently designed to fire on bull-state names during exhaustion. They can never be evaluated because by the time the trigger code runs, `side === "LONG"` is already locked in.

The Phase 4 admission gates we just enabled (G1 pause `gap_reversal_long` + G2 cohort-fail block) will reduce LONG bleed but will not produce a single SHORT trade. That requires a separate fix to the direction-resolution chain.

---

## Evidence — where shorts die

### 1. Direction is resolved before trigger evaluation

`worker/pipeline/trade-context.js:250` and `worker/index.js:10811` both implement `inferSide()` with the same precedence:

```250:260:worker/pipeline/trade-context.js
function inferSide(d, state) {
  const consensusDir = d.swing_consensus?.direction;
  if (consensusDir === "LONG" || consensusDir === "SHORT") return consensusDir;
  if (state.includes("BULL")) return "LONG";
  if (state.includes("BEAR")) return "SHORT";
  const h = Number(d.htf_score);
  if (Number.isFinite(h)) {
    if (h > 0) return "LONG";
    if (h < 0) return "SHORT";
  }
  return null;
```

Order of precedence:
1. **`swing_consensus.direction`** — set to `"LONG"` when `avgBias > 0.3 && regimeDaily !== "downtrend"` per `worker/indicators.js:3241`.
2. **`state.includes("BULL")`** → `"LONG"`.
3. **`state.includes("BEAR")`** → `"SHORT"`.
4. **`htf_score` sign**.
5. `null` (hard reject: `worker/pipeline/tt-core-entry.js:505` returns `rejectEntry("no_inferred_side")`).

For a bull-state ticker that just gapped up and faded — the textbook `gap_reversal_short` candidate — steps 1 and 2 both lock in LONG before the gap-reversal trigger block ever sees the candidate. The trigger requires `side === "SHORT"`:

```1604:1611:worker/pipeline/tt-core-entry.js
      if (side === "LONG" && _gr.long_setup_active && !_grBlockedFallingKnife
          && Math.abs(_gr.gap_pct) >= _grMinGap
          && (_grRvol === 0 || _grRvol >= _grMinRvol)) {
        gapReversalTrigger = true;
      } else if (side === "SHORT" && _gr.short_setup_active
          && Math.abs(_gr.gap_pct) >= _grMinGap
          && (_grRvol === 0 || _grRvol >= _grMinRvol)) {
        gapReversalTrigger = true;
```

`short_setup_active` itself has **no state restriction** — `worker/indicators.js:1755`:

```1755:1758:worker/indicators.js
        long_setup_active: reclaimedFromDown || partialReclaimDown,
        // Setup #5 SHORT: gap-up + (full fade OR strong partial)
        short_setup_active: fadedFromUp || partialFadeUp,
```

So the indicator says "short setup is active on this gap-up fade." But `side === "LONG"` means the `else if` branch never runs. The trigger fires `long_setup_active=false` path (no setup) instead of `short_setup_active=true` path. **Engine concludes "no trigger."**

### 2. Admission matrix is restrictive but downstream

SHORT entries in `worker/phase-c-setup-admission.js`:

```78:91:worker/phase-c-setup-admission.js
  "tt_gap_reversal_short:SHORT:Prime": {
    allow_only_in: ["LATE_BEAR", "STRONG_BEAR", "EARLY_BEAR", "COUNTER_TREND_BULL"],
    reason: "shorts only in bear or bull-exhaustion regimes",
  },
  "tt_gap_reversal_short:SHORT:Confirmed": {
    block_when: "always",
  },
  "tt_gap_reversal_short:SHORT:Speculative": {
    block_when: "always",
  },
```

`COUNTER_TREND_BULL` is permitted — exactly the regime we'd want for bull-tape gap fades. So the admission matrix is *not* what's blocking us. The Prime SHORT is welcome in 4 regimes. But it never gets to admission because the trigger doesn't fire (see §1).

### 3. SHORT-side gates exist but only matter post-trigger

| Gate | File | Side asymmetry | Active on TT-Core? |
|---|---|---|---|
| `da_short_rank_too_low` (`min_rank=80`) | `worker/pipeline/gates.js:31` | SHORT-only | Yes (universal gate) |
| `phase_i_short_no_spy_downtrend` | `tt-core-entry.js:979` | SHORT-only | Default ON in code, disabled in v15 (set to `"false"`) |
| `h3_short_blocked_in_uptrend` | `tt-core-entry.js:1069` | SHORT-only mirror has LONG counterpart | Yes |
| `ctx_short_*` gates | `worker/index.js:4374` | Partial LONG mirror | Yes |
| Tape-unlock for blocked SHORT (`rr ≥ 3.0`) | `tt-core-entry.js:419` | Carve-out, not gate | Yes |

These add friction for bear-state shorts but **only run after a trigger fires**. They're not the reason for 30 zero-short days.

### 4. Setup snapshot diagnostic confirms gap-up-fades are happening

`tt-core-entry.js:1614-1625` stamps `__gap_reversal_diag` on every scoring pass. Key fields: `side`, `long_setup_active`, `short_setup_active`, `fired`. The forensic signal is when `short_setup_active: true && fired: false && side: "LONG"` — those are the moments a gap-up-fade existed on a bull-state ticker and the engine refused to look at the SHORT side.

We can't query this retroactively (it's only persisted in the setup snapshot JSON, not D1-queryable), but the structural code path is clear.

### 5. Universe is not the problem

```36748:36750:worker/index.js
// SECTOR_MAP — Active Ticker Universe (229 tickers)
const SECTOR_MAP = {
```

NFLX (`36881`) and APD (`36894`) — both known-bearish names — are in-universe. The May calibration blocklist removed them from universal gates (`worker/pipeline/gates.js:72`), but that's a post-trigger gate, not a universe filter. Inverse ETFs (`SQQQ`, `SDOW`) are blocklisted (`worker/index.js:12677`) so the universe is structurally long-vehicle-only, but that's an entry-vehicle issue, not a SHORT-direction issue.

For SHORT trades to fire we don't need inverse ETFs — we need to recognize when long-side names are short-setup candidates.

---

## Root cause ranking

### 1. `inferSide()` precedence locks in LONG before reversal triggers (highest impact)
Trade-context's direction resolver puts state/consensus first. For ~70% of bucket-moments the state is BULL, so direction is LONG. Reversal setups (gap, range, n-test) can never test their SHORT path.

**Evidence:** §1 above. `trade_trajectories` 30/30 LONG over 30 days. `swing_consensus` LONG bias kicks in at `avgBias > 0.3` (worker/indicators.js:3242).

### 2. Phase 4 G1+G2 don't help SHORT side (secondary)
Just enabled (PR #210). Both gates fire AFTER direction is resolved. They reject LONG candidates but don't create SHORT candidates. Will reduce LONG bleed; won't move SHORT count off zero.

### 3. Even if direction worked, rank floor 80 + admission allow-list narrow the window (tertiary)
`deep_audit_short_min_rank=80` (set in `scripts/v15-activate.sh:184`). Bear-state ticker with rank 60-79 gets dropped. Admission additionally requires one of 4 regimes. These would matter once direction is fixed; they're not the primary suppressor today.

---

## Remediation options (ranked smallest blast radius first)

### Option A — Setup-driven direction for reversal paths only (recommended)

**Change:** In `worker/pipeline/tt-core-entry.js` gap-reversal block (~`1547-1612`), evaluate `_gr.short_setup_active` independently. If a candidate has `short_setup_active === true` AND `long_setup_active === false`, treat as SHORT candidate for `tt_gap_reversal_short` regardless of the state-inferred `side`. Pass the resulting SHORT through the existing admission matrix (which already allows `COUNTER_TREND_BULL`).

**File:** `worker/pipeline/tt-core-entry.js:1604-1640` (trigger block), `3637-3640` (qualifyEntry call site)

**Expected behavior change:** Gap-up-fade shorts fire on bull-state names during pullbacks/chop. The exact May miss the owner described.

**Risk:** Counter-trend shorts in bull tape are historically risky (`tasks/lessons.md:175-180`). Mitigation: keep the existing admission matrix gate — `gap_reversal_short:Prime` only allowed in 4 regimes including `COUNTER_TREND_BULL`. Layer the new Phase 4 G2 cohort gate too — if the SHORT cohort historically failed, it'll be blocked.

**Blast radius:** SMALL. Affects only the gap-reversal trigger block (~30 lines), feature-flag-able behind `daCfg.gates.short_direction_setup_driven = true` for graduated rollout.

### Option B — Widen `gap_reversal_short:Prime` admission regimes (also small)

**Change:** Add `"NEUTRAL"` and `"LATE_BULL"` to `allow_only_in` at `worker/phase-c-setup-admission.js:79`.

**Expected behavior change:** More shorts pass admission if/when triggers fire.

**Risk:** Low.

**Caveat:** Useless without Option A. The trigger doesn't fire today, so widening admission has nothing to admit.

### Option C — Lower `deep_audit_short_min_rank` 80 → 65 (medium)

**Change:** Update `model_config` row or code default at `worker/pipeline/gates.js:31`.

**Expected behavior change:** Bear-state shorts with rank 65-79 become eligible.

**Risk:** Admits lower-quality bear shorts across ALL paths (momentum, pullback, ATL, gap), not just gap reversal.

**Caveat:** Useless for bull-state gap-up-fade candidates because `state.includes("BEAR")` is false for them, so the rank floor never fires. Solves a different problem (bear-state shorts that ARE being correctly inferred but blocked by rank).

### Option D — Decouple direction from state globally (largest blast radius)

**Change:** Refactor `inferSide()` so reversal setups (gap, range, n-test) declare their own direction; state/consensus only applies to continuation setups (momentum, pullback, ATH).

**Files:** `worker/pipeline/trade-context.js:250`, `worker/pipeline/tt-core-entry.js` trigger section, `worker/index.js:10811`

**Risk:** Highest — changes entry semantics globally. Requires replay validation across Jul–May windows before live.

---

## Recommended sequencing

1. **Ship Option A** as a feature-flagged PR (default OFF in code; owner enables via `daCfg.gates.short_direction_setup_driven = true`).
2. **Watch admission_cohort_log** (Phase 4 PR #210 infrastructure) for SHORT-direction decisions. Expect SHORT trades to start flowing within 1-2 RTH sessions of enabling.
3. After 5+ SHORT trades close, run `GET /timed/calibration/random-walk-null?setup=TT%20Tt%20Gap%20Reversal%20Short&direction=SHORT&lookback_days=180` to see if the SHORT-side actually has edge in the current regime (vs the historical PF 8.86 — that's all-time and may be regime-fitted).
4. **If SHORT cohort is favorable**, consider lowering rank floor (Option C) to widen the funnel.
5. Skip Option B unless triggers fire and admission gets in the way.

---

## Open questions for owner

1. **Counter-trend SHORT philosophy**: Are tactical bull-tape SHORTs back on the table? `tasks/lessons.md:175-180` previously warned against this. The Phase 3 RW-null verdict on the LONG side (BELOW_RANDOM_5TH, percentile 1.6%) materially changes the risk math — the alternative to taking SHORTs is taking LONGs that are objectively worse than coin flips.
2. **Admission policy**: Keep the current 4-regime `allow_only_in` for `gap_reversal_short:Prime`, or widen to include `NEUTRAL` / `LATE_BULL`?
3. **Rank floor reset**: Lower `deep_audit_short_min_rank` from 80 toward the all-time-optimal range, or hold the line until SHORT cohort data accumulates from Option A?

---

## Cross-references
- `tasks/may-2026-performance-analysis.md` §2C — "Direction bias" — first surfaced the 0-shorts pattern.
- `tasks/2026-05-18-chop-regime-defense-diagnostic.md` G7 — included in defensive plan.
- `tasks/2026-05-18-stochastic-research-program.md` §0.6 phase 4 Option B item 3 — owner explicitly picked.
- PR #210 — Phase 4 cohort gates enabled 2026-05-19 (LONG-side defense).
