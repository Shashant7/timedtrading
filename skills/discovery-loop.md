# Discovery Loop (move discovery → gameplan → officers)

**WHEN to use:** Anything touching Move Discovery, miss diagnosis, the
Discovery tab (`system-intelligence.html?tab=moves`), or the question
"why didn't the system catch move X / why is capture rate low?".

## The loop (nightly, 22:00 UTC inside the COO daily cycle)

```
runMoveDiscovery        worker/discovery/move-discovery.js
  → KV timed:move-discovery   (moves, capture/miss/churn, patterns, recs)
runDiagnosis (AUTO)     worker/discovery/diagnose-missed.js
  → report.diagnosis          (LOW_RANK / NO_SIGNALS / WRONG_STATE /
                               SHOULD_HAVE_ENTERED ... miss buckets)
buildDiscoveryGameplan  worker/discovery/gameplan.js
  → KV timed:discovery:gameplan  +  report.gameplan
submitProposal(tier2)   actionable knob recs → learning_proposals bus
```

Coverage gaps (`worker/discovery/coverage-gaps.js`, separate 22:00 lane)
classifies per-DAY in-universe misses via `admission_cohort_log` into
gate_blocked / cohort_fail / setup_not_detected / low_rank / not_scored —
the gameplan merges this with the move-level diagnosis.

## The gameplan artifact (what officers consume)

| Field | Meaning |
|---|---|
| `constraint_mix` + `binding_constraint` | WHY we miss: NO_PLAY_FOR_MOVE (trigger/setup gap), GENERIC_GATE_VETO (shared gates defer valid setups), CONVICTION_TOO_LOW, WRONG_SIDE_BIAS, DATA_GAP, UNIVERSE_GAP |
| `playbook_usage` | per entry_path trades + WR in window, idle plays, `one_play_offense` flag |
| `miss_archetypes` | repeated miss patterns (direction × state / magnitude) = candidate new plays |
| `actions` | vetted knob recs + structural insights |
| `narrative` | ≤700-char paragraph injected into officer prompts |

Consumers:
- **CRO** `collectDiscoveryPulse()` (cro-service.js) → daily synthesis →
  Daily Brief / Research Desk. (Pre-2026-06-10 it read a dead KV key.)
- **CIO** memory Layer 9 `discovery_context.gameplan` (cio-memory.js,
  preloaded by cio-memory-loader.js) + prompt guidance in cio-prompts.js
  (GENERIC_GATE_VETO → don't double-filter; idle-play diversification).
- **COO** audit trail + Discord alerts + learning-bus proposals.
- **UI** Gameplan card on the Discovery tab.

## Setup/trigger taxonomy (the "plays" question)

Triggers are PER-SETUP booleans in `worker/pipeline/tt-core-entry.js`
(qualifyEntry priority stack, ~12 `tt_*` paths — canonical list in
`KNOWN_PLAYS`, gameplan.js). But ~20 GENERIC gates can veto any setup:
admission matrix (phase-c-setup-admission.js), cohort gates, rank/regime
floors, loop1 scorecards, loop2 circuit breaker, RVOL dead zone. The
gameplan's `constraint_mix` measures which side is binding.

## Commands

```bash
# Refresh the whole chain manually (admin key or admin session):
curl -X POST https://timed-trading.com/timed/admin/discovery/run      -H "X-API-Key: $KEY"
curl -X POST https://timed-trading.com/timed/admin/discovery/diagnose -H "X-API-Key: $KEY"   # auto-chains gameplan
curl -X POST https://timed-trading.com/timed/admin/discovery/gameplan -H "X-API-Key: $KEY"   # gameplan only

# Inspect:
curl -s https://timed-trading.com/timed/move-discovery | jq '.summary, .gameplan.narrative'
# KV key for officers: timed:discovery:gameplan (skills/kv-inspection.md)

# Pending discovery proposals on the bus:
#   SELECT * FROM learning_proposals WHERE source='discovery' AND status='pending'
```

## Gotchas

- `COO_SCREENER_AUTO_SCORE` is hot-reloaded from model_config (override)
  with env fallback since 2026-06-10 — Apply on the screener rec is live
  without a redeploy.
- Discovery knob recs have a per-knob safety envelope (`KNOB_SAFETY` in
  move-discovery.js): cooldown 7-14d, hard floors, max drift from
  default. Blocked recs render as tier-3 "blocked — cooldown" info rows;
  that is by design (anti-runaway), not a bug.
- The gameplan is deterministic (no LLM). The officers' LLMs interpret
  it; keep it that way so it stays testable (gameplan.test.js).
- Worker report `patterns` has move-level aggregates only; trail-backed
  HTF/LTF/rank comparisons exist only on CLI deep-dive reports
  (`scripts/discover-moves.js`).
