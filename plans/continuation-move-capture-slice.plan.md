---
name: Continuation + Weekly Move Capture
overview: 'Stop optimizing gates in isolation. Ship (1) a weekly ≥10% move-capture autopsy as the scoreboard, and (2) a momentum-continuation thin slice parallel to confirm-stack — paper Queued, provenance, Today surface, attribution. Capture + MFE keep decide widen; no capital-scale flip.'
todos:
  - id: weekly-autopsy
    content: 'Weekly ≥10% move autopsy — module + CLI + admin API + KV summary; canary NBIS/BE/DELL/MU/CRDO.'
    status: completed
  - id: continuation-detect
    content: 'Define momentum_continuation family; paper Queued stamp (0.1×); do not change ATH capital admission.'
    status: completed
  - id: continuation-surface
    content: 'Today /timed/plays/today slices + SetupFamiliesStrip chip; ENTRY provenance slice_family.'
    status: completed
  - id: continuation-attrib
    content: 'Family attribution + widen_ready for momentum_continuation; CLI reuse.'
    status: completed
  - id: freeze-gates
    content: 'Document freeze on net-new defensive gates without capture/MFE before-after.'
    status: completed
isProject: true
---

# Continuation + Weekly Move Capture — Leap Slice

## Why

Live capture of ATR-qualified moves is ~**4.8%**. Mega weeks (NBIS/BE/DELL/MU
±10–40%) are mostly **MISS** on the trader book. Confirm-stack is the right
structure family; it is not the continuation/momentum family those weeks need.

Progress scoreboard becomes:

> Of in-universe weeks with |move| ≥ 10%, how many did we TOUCH / PARTIAL /
> MISS — and which layer blocked the miss?

## Family: `momentum_continuation`

Paper-only admission (no kanban `in_review`, no ATH matrix unlock):

| Input | Role |
|-------|------|
| Aligned state (`HTF_*_LTF_*` match dir) or confluence `RIDE` | Structure |
| Rank ≥ 75 **or** `|htf_score|≥15` **or** `momentum_elite` | Strength |
| Impulse: `|dayPct|≥2.5` **or** rvol≥1.5 **or** squeeze release | Timing |
| Daily EMA21 on side of trade | Structure hold |
| `_sequence_queue_proposal.family=momentum_continuation` | Paper Queued |
| Confirm-stack wins if both fire | Priority |

## Weekly autopsy contract

For each Mon–Fri NY week in lookback:

1. Detect weeks with open→close **or** high–low ≥ **10%**
2. Join trader `trades` overlapping the week
3. Label: `TOUCHED` / `PARTIAL` / `MISSED`
4. Miss reason (best-effort): `low_rank` / `late_bull_block` / `wrong_state` /
   `no_setup` / `confirm_lag` / `not_scored` / `unknown`
5. Canary set always reported: NBIS, BE, DELL, MU, CRDO (+ OKLO)

## Explicitly not this slice

- Flipping ATH Speculative/Confirmed capital admission
- Flipping conviction fusion / model-play-sim
- Net-new defensive gates without capture before/after

## Done looks like

Admin can `GET` weekly autopsy (KV + live). Today shows continuation runners
alongside confirm-stack. ENTRY rows can stamp `slice_family=momentum_continuation`.
Attribution CLI reports family keep/widen. Canary miss rate is visible weekly.
