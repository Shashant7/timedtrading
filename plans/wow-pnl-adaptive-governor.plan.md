---
name: Week-over-week PnL adaptive governor
overview: >-
  Stop live bleed from inert demotions and soft exits, measure confirm-stack
  capture/MFE keep, and close the Discovery → Calibration → capital loop so
  the model adapts weekly without regressing.
todos:
  - id: demotion-heal
    content: >-
      Load dynamic demotion_* keys into daCfg; honor blocked for all tickers;
      heal mangled TT Tt keys; expand enforce_paths for ATH/Support/Range.
    status: completed
  - id: bleeder-shield-on
    content: Enable deep_audit_bleeder_shield so soft fast-cuts stop manufacturing losses when HTF structure holds.
    status: completed
  - id: family-attribution
    content: GET /timed/admin/trust-spine/family-attribution — confirm-stack capture + MFE keep vs 4.8% baseline.
    status: completed
  - id: weekly-governor
    content: Nightly/weekly governor artifact + auto-demote severe bleeders (PF<0.5, n>=10); tier2 proposals otherwise.
    status: completed
  - id: slice-stamp
    content: Stamp slice_family=confirm_stack_ema21 on ENTRY decision_records when stack_full_confirm fires.
    status: completed
  - id: wow-guard
    content: Governor flags WoW PnL regression vs prior week and emits learning proposals (no silent widen).
    status: completed
  - id: next-sequence-queued
    content: Sequence entry_ready may propose Queued (tiny/paper) for confirm-stack family only.
    status: completed
  - id: next-move-ending
    content: Flag-gated move-ending enforce after family keep-rate clears floor.
    status: completed
  - id: next-conviction-flip
    content: Flip conviction fusion only after forward n>=30 with positive OOS keep-rate.
    status: completed
  - id: next-options-first
    content: Tier-A RIDE on confirm-stack stamps options play_vehicle (intent; sim fill gated).
    status: completed
isProject: true
---

# Week-over-week PnL — Adaptive Governor

## Diagnosis (2026-07-23)

Live capital still underperforms because the “movie” stack is shadow while the
rule book keeps bleeding:

| Gap | Evidence |
|---|---|
| Demotion inert | `deep_audit_setup_demotion_TT Tt Ath Breakout_long=blocked` never loads (dynamic keys filtered out of `REPLAY_DA_KEYS`); `index_only=true` would still skip single names |
| Soft exits bleed | `atr_day_adverse_382_cut`, `phase_i_mfe_fast_cut_*` still fire; `deep_audit_bleeder_shield_enabled` unset/OFF |
| MFE ratchet on but unused | 0 `mfe_ratchet_giveback` exits since June — soft cuts often exit first |
| Confirm-stack unfinished | Today strip exists; no family attribution join; sequence does not propose Queued |
| Adaptive loop fragmented | Discovery gameplan + edge scorecard propose; nothing closes the week with pause/keep/widen + rollback |

Trader entries since 2026-06-01: ~28% WR, PF ~0.12, −$2.3k. Capture still ~4–5%.

## North star

Improve **closed PnL week-over-week** without widening until attribution proves
the family beats the ~4.8% capture baseline **and** keeps MFE.

## Architecture

```
Discovery (moves + coverage gaps + gameplan)
    ↓
Edge scorecard (7/30/90d) + family attribution (confirm-stack)
    ↓
Weekly governor (KV timed:weekly-governor:latest)
    ├─ auto-demote severe bleeders (flag-gated)
    ├─ tier2 proposals (admission / knobs) via learning bus
    └─ WoW regression flag → block widen, prefer pause
    ↓
Capital path: demotion + bleeder shield + MFE ratchet (already on)
    ↓
decision_records (slice_family stamped) → next week's scorecard
```

## Ship order (this PR)

1. **Demotion heal** — load `deep_audit_setup_demotion_*`; blocked ⇒ all tickers;
   heal mangled keys; set enforce_paths for ATH / Support Bounce / Range Reversal.
2. **Bleeder shield ON** in `model_config` (structure-intact soft exits only).
3. **Family attribution API** + **weekly governor** (artifact + auto-demote severe).
4. **Stamp `slice_family`** on ENTRY provenance when confirm-stack fires.
5. Tests + deploy smoke.

## Thin-slice capital path (r2 — 2026-07-23)

- Sequence `entry_ready` + `stack_full_confirm` → `_sequence_queue_proposal`
  (Queued, paper, size_mult 0.1). Lifecycle shows Queued; does **not** set
  kanban `in_review`. If a normal entry still fires, size is capped.
- Options-first: Tier-A RIDE stamps `_model_play.play_vehicle=options`.
- Move-ending enforce + conviction fusion: code wired; weekly governor
  auto-enables only when family `closed≥30` and `avg_mfe_keep_rate≥0.35`
  and WoW not regressing / block_widen off.

## Guardrails

- Hard SL / max-loss / HARD_LOSS_CAP never shielded
- Auto-demote only when `n≥10` and `PF<0.5` (severe); milder → proposal only
- No universe-wide sequence entry gate until family attribution clears baseline
- Every capital-facing change writes `model_config_history` / learning proposal note
