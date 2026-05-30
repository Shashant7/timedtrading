# Fix A Validation — REJECTED (same paper-gain bias as Fix B)

**Date:** 2026-04-30  
**Run:** `v16-fixa-jul-30m-1777516153` (104 trades)  
**Result:** **REJECTED** — TD9 LTF cohort itself REGRESSED -7.70pp; net "win" is paper-gain-at-run-end artifact (LITE +109pp swing same as Fix B)

## Headline numbers

| | Baseline | Fix A | Δ |
|---|---|---|---|
| Trades | 101 | 104 | +3 |
| **WR** | **67.3%** | **64.4%** | **-2.9pp** ✗ |
| **PnL** | +427.12% | +456.88% | +29.76pp |
| **PF** | 8.14 | 7.24 | -0.90 |
| Best WIN | +49.63% | +111.11% | (LITE same paper gain as Fix B) |

## TD9 LTF cohort (the target of Fix A) — REGRESSED

| Ticker | Baseline | Fix A | Δ |
|---|---|---|---|
| INTC | -3.54% | -3.23% | +0.31 |
| **IBP** | +3.66% | **+1.98%** | **-1.68** |
| AYI | -0.08% | -0.09% | -0.01 |
| **CLS** | -0.16% | **+0.14%** | **+0.29** |
| RBLX | +2.11% | +2.65% | +0.54 |
| **ASTS** | **+6.90%** | **0.00%** | **-6.90** |
| APLD | +1.91% | +1.91% | 0 |
| AVGO | -1.44% | -1.44% | 0 |
| GLXY | +0.69% | +0.69% | 0 |
| MSFT | +0.25% | 0.00% | -0.25 |
| **TOTAL** | **+10.30%** | **+2.60%** | **-7.70** ✗ |

The fix HURTS the cohort it was designed to help. Hot ASTS run that captured +6.9% baseline shows 0% in Fix A — likely cascade-altered or different exit timing.

## "Big winner" gains are paper artifacts

Same pattern as Fix B:
- LITE: +45.81% → +111.11% (LITE held open past July, 412h hold via `replay_end_close`)
- PLTR: 0% → +36.85% (different entry, run-end snapshot)
- AEHR: +4.83% → +20.38% (held longer)
- UTHR: 0% → +14.07% (different trade entered)
- U: 0% → +12.50% (different trade entered)

Vs realized-during-July regressions:
- **GEV: +34.35% → +1.77%** (-32.58pp realized loss)
- **JOBY: +41.16% → +13.15%** (-28.02pp realized loss)
- IREN: +21.40% → +10.21% (-11.19pp)
- NVDA: +18.38% → +12.18% (-6.20pp)
- AMD: +16.92% → +12.85% (-4.07pp)

**Realized-during-July net effect: NEGATIVE.** The +29pp headline is purely from LITE/PLTR/UTHR/U/AEHR being open at July 31 with paper gains.

## Why Fix A didn't help its target

**0 trades exited via `TD9_FRAGILE_TRIM_BE_LOCK`** in the smoke. The flag mechanism (`entrySignals.td9_bear_ltf_active` carried through to trim-time logic) likely didn't fire because:
1. The BE-lock condition only triggers when remainder price is BELOW entry at the moment of TRIM. With +3.5% TP1 distance, the trim hits when price is well above entry.
2. The intended scenario ("trim hit, then runner reverses below entry") is rare.
3. So in practice the rule never engages.

What Fix A actually did: **subtle path/state changes at entry** caused different ticker reshuffling — same cascade pattern as everything else.

## Verdict

REJECTED. Same paper-gain bias as Fix B masked the real cohort-level damage. We're confirming **a third time** that engine modifications on July alone are unreliable validation.

DA flag set to `false`. Code retained for reference.

## What I'm taking from this round

1. **July smoke alone cannot validate runner-protection rules** — they always look good due to paper-gain-at-run-end on the trades that get held longer. We need a multi-month smoke that has settled outcomes.
2. **TD9 LTF as a fragile signal is real** (counterfactual showed it) but the engine's existing trim/SL machinery already gives short fragile trades little room to breathe. Adding a BE-lock gate in this code path is essentially a no-op.
3. **The structural "give runners more rope" instinct keeps being wrong** at the July-only resolution.

## Recommendation

Stop iterating on engine. Go to Phase 2 deployment + Phase 3 UI work. Run a final canonical Jul→Apr at v16-fix4 (no engine changes from today's failed iterations) to get the realistic 9-month performance.
