# 2026-06-10 — Discovery Blindspot: close the loop into the officer suite

## Operator framing

"What we miss is what we don't know. If I only knew how to run one play in
football, I'd be successful only when the env aligns for that play. We may
need to consider: are the triggers specific to those setups, or are they
generic where certain setups may defer them. Discovery should be feeding
AI CTO, CRO, CIO to create a gameplan around valid setups and moves we
are ignorant to, or adjust existing setups to apply the learnings."

## Audit findings (2 deep audits, 2026-06-10)

1. **CRO reads a dead key** — `collectDiscoveryPulse` reads
   `timed:discovery:move-summary` which is never written. CRO's
   "Discovery layer" input has been empty since it shipped.
2. **Diagnosis is manual-only** — Miss Buckets / miss reasons absent
   unless operator clicks Run Diagnosis after every nightly scan.
3. **Discovery recs bypass the learning_proposals bus** — direct
   model_config writes, no rollback row; `COO_SCREENER_AUTO_SCORE` is
   read from env only, so applying that rec is a no-op until redeploy.
4. **No setup-level attribution** — discovery never answers "which play
   would have caught this move and which generic gate vetoed it".
   (Answer to the trigger question: triggers ARE per-setup booleans in
   tt-core-entry.js, but ~20 GENERIC gates — admission matrix, cohort,
   rank floors, regime floors, loop1/2 — can veto any setup. Coverage
   gaps already classifies per-day misses into gate_blocked /
   cohort_fail / setup_not_detected / low_rank etc. but nothing joins
   that to the move-discovery lane or the officers.)
5. **UI zeros** — worker report never emits `patterns` (CLI-only field);
   UI defaults to 0. Current Read reads `capture_rate_pct` but worker
   writes `capture_rate`.
6. **Plays-concentration is invisible** — nothing measures which entry
   paths actually fired in the window vs sat idle.

## Design — the Discovery Gameplan loop

```
nightly 22:00 (COO cycle)
  runMoveDiscovery            → KV timed:move-discovery (+patterns now)
  runDiagnosis (AUTO now)     → report.diagnosis (miss buckets)
  buildDiscoveryGameplan NEW  → KV timed:discovery:gameplan + report.gameplan
  submit knob recs → learning_proposals bus (tier-2, source=discovery)
       ↓                                      ↓
  CRO daily synthesis        CIO memory L9     COO audit + Discord
  (real keys now)            (gameplan layer)
       ↓
  Daily Brief / Research Desk / Discovery tab Gameplan card
```

`buildDiscoveryGameplan` (worker/discovery/gameplan.js, deterministic,
no LLM) merges: move-discovery summary + diagnosis buckets +
coverage-gaps reason mix + per-path usage from direction_accuracy →

- `constraint_mix`: misses classified into NO_PLAY_FOR_MOVE /
  GENERIC_GATE_VETO / CONVICTION_TOO_LOW / WRONG_SIDE_BIAS / DATA_GAP /
  UNIVERSE_GAP + `binding_constraint`
- `playbook_usage`: per entry_path trades+WR in window, idle plays,
  concentration pct ("we only ran one play" detector)
- `miss_archetypes`: repeated miss patterns (direction × magnitude ×
  dominant state) with examples — candidate new plays / trigger gaps
- `actions` + `narrative` (≤ 700 chars) for officer prompts

## Tasks

- [x] 1. `worker/discovery/gameplan.js` + unit tests (pure classifiers)
- [x] 2. move-discovery.js: emit `patterns` (computeMovePatterns helper)
- [x] 3. COO cycle: auto-diagnose → gameplan → submit tier-2 proposals
      to learning bus (dedup per source+key built into submitProposal)
- [x] 4. COO screener: read COO_SCREENER_AUTO_SCORE from model_config
      first (hot-reload), env fallback — makes the Apply real
- [x] 5. CRO: fix dead key; pulse reads timed:move-discovery +
      timed:discovery:gameplan; prompt nudge re: missing plays
- [x] 6. CIO: memory-loader fetches gameplan KV; cio-memory Layer 9
      gains gameplan global + per-ticker missed-move context;
      cio-prompts guidance
- [x] 7. Routes: POST /timed/admin/discovery/gameplan (manual rebuild)
- [x] 8. UI: fix capture_rate_pct + zeros; Gameplan card in Discovery
      tab overview
- [x] 9. Tests green (193), bundle check, docs (CONTEXT bullets +
      skills/discovery-loop.md + skills/README row)
