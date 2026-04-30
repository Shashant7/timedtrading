# Phase C Validation Results — V1 (default weights) FAILS

**Date:** 2026-04-29  
**Run:** `v16-pc-on-jul-30m-1777501782` (full July, default weights)  
**Result:** **FAILS validation gate** — WR -5.6pp, PnL -136.67pp

## Outcome

| | Baseline | Phase C V1 | Δ |
|---|---|---|---|
| N | 101 | 102 | +1 |
| **WR** | **67.3%** | **61.8%** | **-5.6pp** ✗ |
| **PnL** | +427.12% | +290.45% | **-136.67pp** ✗ |
| **PF** | 8.14 | 4.92 | -3.22 |
| Best WIN | +49.63% | +43.00% | -6.63 |

## Key insight: the score doesn't discriminate at decision time

**The kicker**: Phase C reshuffled 27/28 trades — same scale of cascade as V3/V4 — and the **rejected trades had 70% WR** while **new entries had 46% WR**.

| Group | N | WR | PnL |
|---|---|---|---|
| **Rejected by PC** (would-be entries skipped) | 27 | **70%** | **+104.11%** |
| **New entries** (replacements) | 28 | **46%** | **+18.90%** |
| Net swap | | | **-85.21%** |

We're systematically replacing winners with losers. The composite score's average is **138.4 for rejected** vs **135.9 for new** — virtually identical. The score is NOT discriminating between candidates that compete for slots in real execution.

## Specific examples of pathology

**AVGO +49.63% (rejected)** — scored 130, the lower edge of the rejected band.  
**META +0.35% (new)** — scored 157.5, the highest in new entries cohort. Entered, made +0.35%.

**Same ticker, different outcome via cascade**:
- AVGO in baseline: tt_pullback (PUL path) → +49.63%
- AVGO in Phase C: tt_gap_reversal_long (GR path) → +0.09% (entered at different bar via different path)

The score happened to rank GR-AVGO at 155.5 (because gap_reversal historically scores higher) but the actual outcome was vastly worse. **Path-level entry timing matters more than the composite score captures.**

## Why my structural fix didn't fix the structural problem

Phase C's logic:
1. Score every eligible candidate
2. Take top N by score
3. Reject the rest

The cascade still happened because:
- **Phase C added candidates that the baseline never even saw.** The baseline's iteration entered LITE-pullback at 11:30 and AVGO-pullback at 13:30 — by the time those slots were used, GR-AVGO at a different timestamp wasn't an option (slots full).
- **In Phase C, the buffer collected GR-AVGO at the alternate timestamp** (where it wasn't competing with baseline's iteration order). It scored 155.5, beat AVGO-pullback's 130, won the slot, and lost money.
- **The score was DIFFERENT for the same ticker depending on entry timing.** Path-specific quality variance overwhelmed the score's discrimination ability.

## What this means structurally

**Post-hoc filters fail because of slot reshuffle. Score-based selection ALSO fails when:**
1. The same ticker can score very differently at different bars (path-dependent score)
2. The "alternative" candidates that surface in a buffered system weren't candidates in the iteration-order system
3. The score is influenced by features (rank, conviction) that already get computed greedily — meaning Phase C is adding signals on top of signals that already roughly do this work

**The honest conclusion**: Phase C as currently designed does NOT eliminate the cascade. It changes WHO drives reshuffling but doesn't eliminate the underlying problem.

## What might actually work

Three possibilities, none guaranteed:

### Option A: Much tighter selection
Run Phase C with `quality_score_min=130`, `fill_factor=0.05`, `hard_cap=2`. This would skip the 8 lowest-scored candidates (the ~10% bottom that the counterfactual showed) and let everything else through unchanged. **But:** this is essentially the original "drop bottom 10%" hypothesis — and we've now shown that the rejection criterion isn't actually picking losers reliably.

### Option B: Path-aware scoring
Instead of one composite score, score each (ticker, path) pair independently AND require the BEST-scoring path for each ticker to be the one we accept. This eliminates the "same ticker scores differently per bar" pathology.

### Option C: Accept the cascade is unfixable, focus on per-trade management
The data has been telling us this for 3 sessions:
- FIX 9 (post-hoc trim) — cascade
- FIX 12 V3 (post-hoc filter) — cascade
- FIX 12 V4 (refined filter) — cascade
- Phase C (structural rebuild) — cascade

**The real lever is Phase 1: per-ticker personality runner protection.** Modify EXIT logic per ticker character. Don't try to filter at entry. Let the engine enter what it enters and use the captured TD/PDZ/Divergence data for **management decisions on specific trades**.

## Recommendation

**STOP entry-side filtering experiments.** The cascade is structural and we've proven it persists across four different approaches with increasing sophistication.

**Pivot to Phase 1**: per-ticker personality runner protection. Use the TD/PDZ/Divergence data we captured as inputs to **how each individual trade is managed**, not whether it enters.

Specifically, on entry, store these signals on the trade record. Then:
- If trade has F4 severe divergence at entry → tighter SL, faster cut on first adverse 30m bar close
- If ticker is VOLATILE_RUNNER personality → wider trail, later TP1 trim, longer min-hold
- If trade entered with PDZ premium-stack → confidence boost, trail looser
- If TD bear_prep on Daily was high → tighter SL

These are management modulations on trades that already entered. **No cascade is possible** because we're not changing which tickers fill which slots.

## Phase C status: REJECTED (V1)

- DA flag `deep_audit_phase_c_enabled=false` (disabled)
- Code retained for reference but not promoted
- Tag PR #48 as failed validation
- Plan to revisit post Phase 1 with path-aware scoring (Option B)
