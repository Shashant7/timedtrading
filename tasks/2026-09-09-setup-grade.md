# Setup grade admission (2026-09-10)

Live policy, not a 30-day observation. PR #1446 remains research hygiene
(first-passage grading + admin export). Ticker Grader’s 0–10 shape is
mapped onto Timed signals that already exist.

The first ship (2.1.7) only gated new core entries and exempted paper
families. The open book is Cloud Pivot paper — that exemption was the
reason nothing changed overnight. 2.1.8 applies the same floor there
and catalog-pauses Support Bounce.

## Policy

- `worker/pipeline/setup-grade.js` — five pillars × 2 points, floor 6
- Fail-closed: missing ≠ pass
- Default ON: `deep_audit_setup_grade_enabled`
- Core + legacy enter + paper-family standalone (`resolvePaperFamilyStandaloneEntry`)
- Exempt: `index_etf` / `index_dt` / `day_trade` only
- Support Bounce catalog **paused** (90d PF 0.79; proposals #68 / #70)
- Stamp `__setup_grade`. No exit trapdoor. No Form 4. No new apply bus
- `SCORING_VERSION` `2.1.8-2026-09-10`

## Pillars

1. Structure — side-aligned HTF state or daily stack
2. Tape — observed rvol ≥ 1.2 or directional squeeze release
3. Macro — theme or macro-wire tilt > 0 (applied or shadow)
4. Value — FV tilt > 0
5. Officer — officer tilt > 0 or sector OW/UW matching side

## Out of scope

- Enabling `conviction_fusion` (prior holdout negative)
- Fitting weights on the 778-row ledger / Discovery movers
- Catalog-pausing all Cloud Pivot (shorts were +EV; longs take the grade)
- Open-position exits when grade < 5
- Unpausing Support Bounce because a 30d window printed green
