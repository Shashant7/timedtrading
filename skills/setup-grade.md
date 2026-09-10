# Setup grade (0–10 admission)

**WHEN to use:** A core name looks “ready” but did not enter, or someone
wants a Ticker Grader-style 0–10 confluence score. Also when changing
entry volume after 2026-09-09.

Timed already had the pillars. This skill is the **live floor**, not a
scanner clone and not PR #1446’s export/holdout loop.

## The rule

Five observed pillars, **2 points each**, floor **6** (three of five).
Missing is **0**, not a pass. No fitted weights. No Form 4. No exit
when the grade later falls.

| Pillar | Pass (2 pts) | Fail-closed |
|---|---|---|
| Structure | Candidate-side HTF state (`HTF_BULL_*` / `HTF_BEAR_*`) **or** daily `bull_stack` / `bear_stack` **or** armed Cloud Pivot / weekly ST hold on this side | Opposing HTF with no armed play (e.g. `HTF_BEAR_LTF_BULL` for a LONG). Empty state and stack |
| Tape | Observed rvol ≥ 1.2 **or** squeeze release **and** 10/15/30 ST dir matches side | TradeContext’s fake 1.0× rvol. Release with no / opposed ST |
| Macro | `_theme_tilt` or `_macro_wire_tilt` (or `_shadow`) > 0 — already side-applied. LONG also passes on **theme membership + quality A/B or compounder** when today's breadth tilt is flat | Both missing, or ≤ 0, and no membership+quality |
| Value | `_fv_tilt` or `_fv_tilt_shadow` > 0, **or** unsigned `_fair_value.tilt` re-signed to this play side | Missing / 0 / opposed |
| Officer | `_officer_tilt` > 0 **or** sector OW (LONG) / UW (SHORT) | Neutral rating with no officer tilt |

## Where it lives

| Piece | File |
|---|---|
| Pure grade | `worker/pipeline/setup-grade.js` |
| TT Core | `qualifyEntry` in `worker/pipeline/tt-core-entry.js` |
| Legacy enter | `qualifiesForEnter` in `worker/index.js` |
| Stamp | `d.__setup_grade` + `__setup_evaluation.setup_grade` |
| Version | `SCORING_VERSION` `2.1.10-2026-09-10` |
| Paper families | `resolvePaperFamilyStandaloneEntry` — same floor |

`deep_audit_setup_grade_enabled` default **true**. Floor
`deep_audit_setup_grade_floor` (6). Rvol `deep_audit_setup_grade_rvol`
(1.2). Disable only via DA / `learning_proposals`.

Exempt paths (own engines): `index_etf`, `index_dt`, `day_trade` only.
`cloud_pivot` / `confirm_stack` / `momentum_continuation` are **not**
exempt — they are the open book. `momentum_score` is not exempt.

Support Bounce (`tt_n_test_support`) is catalog **paused** (90d PF 0.79;
proposals #68 / #70). Demotion `blocked` is already live. Do not unpause
from a 30d-green CIO restore.

## Do not

- Copy Ticker Grader insider/Form 4 or a <5 exit trapdoor
- Turn on `conviction_fusion` / focus-tier as the whole answer
- Fit weights on the 778-row ledger or Discovery movers
- Lower the floor to restore trade count
- Treat PR #1446 first-passage export as this policy

## Verify

```bash
node node_modules/vitest/vitest.mjs run \
  worker/pipeline/setup-grade.test.js \
  worker/foundation/paper-family-entry.test.js \
  worker/foundation/play-catalog.test.js \
  worker/pipeline/admission-seam.test.js
```

After deploy, a sentinel rescore should show `scoring_version` `2.1.10`
and `__setup_grade` on rejected/qualified core **and** paper-family
attempts. Members/anon must not see the stamp (`redactTickerSnapshot`).
A thin Cloud Pivot proposal must not open. Support Bounce explain must
be `play_catalog_paused` or `setup_demotion_blocked`.
