---
name: Confirm-stack EMA21 Thin Slice
overview: 'Stop treating "flip flags after n≥30" as the path to 100%. Build one instrument end-to-end: Confirm-stack EMA21 runners under the unified lifecycle + play vehicle UI. Prove capture + MFE keep on this family before widening.'
todos:
  - id: slice-contract
    content: 'Name the family + decision contract; demote experts to inputs (sequence/character/RIDE/conviction = chips, not modes).'
    status: completed
  - id: slice-today-ui
    content: 'Surface Confirm-stack runners on Today via /timed/plays/today; lifecycle + play + confirm/runway chips; click → Right Rail.'
    status: in_progress
  - id: slice-sequence-propose
    content: 'Allow sequence entry_ready to propose Queued (tiny/paper size) for this family only — still not capital-scale.'
    status: pending
  - id: slice-options-first
    content: 'Tier-A RIDE on this family prefers options play_vehicle; stamp executed intent even while sim fill stays gated.'
    status: pending
  - id: slice-attribution
    content: 'Per-entry attribution join: decision_records + MFE keep + move capture label for confirm-stack family only.'
    status: pending
  - id: slice-widen
    content: 'Widen only if thin slice beats ~4.8% capture baseline and holds OOS; else autopsy which layer lied.'
    status: pending
isProject: true
---

# Confirm-stack EMA21 Thin Slice — Build the Instrument

## The reframe (carried through)

Flipping `deep_audit_conviction_fusion_enabled` after n≥30 is how you safely turn on a **dial**. It is not how you build the **instrument**.

Modes are gone as product identity (see `unified-model-lifecycle.plan.md`). The UI job is:

> Is the model doing something with this ticker, and WHY — or is it not, and WHY.

This slice is the first family that must answer that end-to-end.

## Family definition

**Confirm-stack EMA21 runner** when:

| Input | Role |
|-------|------|
| `setup_gates.stack_full_confirm.fires` | Admission atom (ST flip + squeeze + EMA21 reclaim/reject) |
| Daily EMA21 structure holds | Structure input (not a separate mode) |
| `_model_lifecycle.state` ∈ watching / queued / bought / held | Unified process surface |
| `_model_play.play_vehicle` | Expression: shares \| letf \| options |
| Confluence `RIDE` + conviction Tier A | Options-first bias on expression |
| Sequence `entry_ready` / posture | Context chip — may propose Queued, does not own capital |
| Business character | Interpretation chip — changes how levels read |
| `decision_records` | Full provenance at every decision |

Experts demoted to **inputs**, not competing products.

## What we measure (attribution)

For every entry in this family:

1. **Did we take it?** (queued → bought)
2. **Did we capture the move?** (vs discover-moves / coverage-gaps labels)
3. **Did we keep the MFE?** (exit PnL vs peak MFE)
4. **Which play?** (shares / letf / options) — dogfood even if sim fill gated

North-star baseline: ~**4.8%** capture of qualifying moves (`docs/self-calibrating-loop.md`). Thin slice must beat that on this family before widening.

## Explicitly not this slice

- Flipping conviction fusion / bleeder shield / model-play-sim as the primary milestone
- Dual AT vs Investor UX
- Full sequence→live capital gate across the universe
- Waiting months for a conviction gate that fails discrimination

## Implementation sequence

1. **UI proof surface (this PR)** — Today strip from `/timed/plays/today` with lifecycle + play + confirm/runway. No capital behavior change.
2. **Sequence may propose Queued** — family-only, tiny/paper, provenance stamped.
3. **Options-first expression** — Tier-A RIDE stamps options as model play; sim fill stays gated until D1 persistence.
4. **Attribution loop** — weekly join decision_records → trades → capture/MFE for this family.
5. **Widen or autopsy** — if OOS fails, name the lying layer.

## Done looks like

Open Today → see Confirm-stack runners as one composition (state + play + why chips) → click → Right Rail sequence/provenance → ledger shows the same WHY. Capture/MFE report for this family is queryable without reading five expert panels.
