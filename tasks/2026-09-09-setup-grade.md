# Setup grade admission (2026-09-09)

Live policy, not a 30-day observation. PR #1446 remains research hygiene
(first-passage grading + admin export). Ticker Grader’s 0–10 shape is
mapped onto Timed signals that already exist.

## Policy

- `worker/pipeline/setup-grade.js` — five pillars × 2 points, floor 6
- Fail-closed: missing ≠ pass
- Default ON: `deep_audit_setup_grade_enabled`
- Core + legacy enter only. Index / paper-family paths exempt
- Stamp `__setup_grade`. No exit trapdoor. No Form 4. No new apply bus
- `SCORING_VERSION` `2.1.7-2026-09-09`

## Pillars

1. Structure — side-aligned HTF state or daily stack
2. Tape — observed rvol ≥ 1.2 or directional squeeze release
3. Macro — theme or macro-wire tilt > 0 (applied or shadow)
4. Value — FV tilt > 0
5. Officer — officer tilt > 0 or sector OW/UW matching side

## Out of scope

- Enabling `conviction_fusion` (prior holdout negative)
- Fitting weights on the 778-row ledger / Discovery movers
- Demoting ATH / Support Bounce from n=14–17 samples
- Open-position exits when grade < 5
