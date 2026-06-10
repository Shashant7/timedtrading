# Reversal-trim near highs — gap analysis + phased plan (2026-06-10)

Operator: "Will the model and system be more in tune with expected
reversals so we trim near highs (as we just observed in the last few
days with our open positions not getting trimmed before the steep
drawdown)? We had FSD warnings."

## Why FSD warned and nothing trimmed (audit findings, file:line as of main)

1. **FSD/CRO intel stops at the context layer for the trader book.**
   Bearish FSD publications flow to: CIO prompt context (explicitly
   "context, not a hard override" — `worker/cio/cio-memory.js:768-823`),
   entry confluence fades + entry-time SL/TP tightening
   (`worker/index.js` exhaustion-at-entry, `deep_audit_exhaustion_*`),
   investor-book trims, and Discord. There was NO path from an FSD
   risk-off verdict to a TRIM on an open trader position.
2. **Timing "trim winners" was alert-first.** `computeTimingOverlay`'s
   `trim_winners` flag drove a Discord line and contributed to the
   kanban `td_extension_exhaustion` trim reason only when pnl > 0.5% AND
   ≥2 warnings — and tt-core exit logic can still DEFER that trim to
   `defend` while trend structure looks intact
   (`worker/pipeline/tt-core-exit.js` exhaustion-deferral; inline
   `_suppressWeakTrim`).
3. **Near-high deferral bias.** At highs, ripster clouds / ST15 are by
   definition still supportive, so exhaustion converts to hold/defend.
   The drawdown then has to develop before cloud-break/SL rules fire —
   i.e. the system gives back gains by design ("let winners run").
4. **No portfolio-wide exit coordinator.** INDEX EXTENSION WATCH and the
   portfolio breakers exist, but the breakers only BLOCK NEW ENTRIES
   (`worker/portfolio-risk.js` → `qualifiesForEnter`); review item S4
   (auto-trim weakest quartile on regime shock) is not implemented.
5. **CIO lifecycle is veto-only.** With `ai_cio_lifecycle_enforce`, the
   CIO can HOLD an engine-proposed trim but never ORIGINATES one from
   FSD/exhaustion (`buildCIOLifecycleProposal` runs only when the engine
   already chose `target > 0`, and its proposal payload does not include
   `timing_overlay`).

## Phase 1 — SHADOW advisor (THIS PR)

`evaluateReversalTrimAdvisory()` in `worker/timing-signals.js` (pure,
unit-tested): for every open WINNER (pnl ≥ 1%, trimmed < 50%) it combines
- ticker-level signals: `trim_winners`, extension_score ≥ 55, ≥2
  exhaustion warnings (which already include `fsd_macro_risk_off`),
  mirrored via the compression side for SHORT winners, and
- market-level confirmation: broad INDEX EXTENSION WATCH breadth,
and emits `{ticker, pnl_pct, suggested_trim_pct (25%/33%), strength,
reasons[]}`. At least one ticker-level reason is required (the index
watch alone already has its own aggregate alert); single-reason
advisories need market confirmation or pnl ≥ 3%.

Wiring (scoring cron tail, next to the index watch): KV
`timed:reversal-trim:advisory` + Discord embed (4h cooldown, re-alerts on
signature change), `[REVERSAL_TRIM_ADVISOR]` log line. Kill switch:
`model_config.reversal_trim_advisor_enabled = "false"`. NO execution.

## Phase 2 — measure (SHIPPED 2026-06-10; data accrues with tape)

Implemented in `worker/reversal-trim-eval.js`:
- The scoring tick records the FIRST advisory per trade in KV
  `timed:reversal-trim:history` (anchored advisory pnl + peak).
- The nightly `0 4 * * *` lifecycle arm scores every closed trade that
  had an advisory: `saved_pct = advisory_pnl − exit_pnl` and
  `weighted_saved = suggested_trim_pct × saved_pct`, then writes the
  aggregate to `timed:reversal-trim:scorecard`.
- `GET /timed/admin/reversal-trim/scorecard` (key-or-admin) returns the
  scorecard + last-50 history + live advisory. Verdict field:
  `ENFORCEMENT_SUPPORTED` only with ≥ 20 evaluated advisories, positive
  weighted savings, and hurt-rate (winners cut that kept running) below
  one third. Until then: `INSUFFICIENT_SAMPLE`.

## Phase 3 — guarded enforcement (SHIPPED 2026-06-10, default OFF)

`model_config.reversal_trim_advisor_enforce = "true"` (whitelisted in
the deep-audit config preload) activates a new trim trigger in
`classifyKanbanStage`: open LONG winner (pnl ≥ 1%) whose own timing
overlay says `trim_winners` with extension ≥ 55 or ≥ 2 exhaustion
warnings → kanban `trim` with reason `reversal_trim_advisor`, flowing
through the NORMAL trim path (CIO lifecycle review, alerts, manifests
all apply). It deliberately overrides the favorable-zone structure
shield (`_suppressWeakTrim`) — locking gains near the high on stacked
reversal signals is the point. SHORT mirror deferred until the LONG
data is in.

**Operator rule: do not flip the flag until the scorecard reads
ENFORCEMENT_SUPPORTED.**

## Scorecard-gated flips (SHIPPED 2026-06-10; bus-governed)

The nightly evaluator now drives the flips through the learning-proposals
bus (house rule: flag flips are tier-2 → operator decides; safety
demotion is the only self-acting path):
- `ENFORCEMENT_SUPPORTED` while OFF → **tier-2 proposal**
  (`reversal_trim_advisor_enforce=true`) with the scorecard as evidence
  + Discord notice. Decide via the proposals queue.
- `ENFORCEMENT_NOT_SUPPORTED` while ON → safety demotion **auto-applies
  only when `reversal_trim_autoscale="true"`** (mirrors CIO authority
  autoscale); otherwise a tier-2 disable proposal queues.
- Pure decision logic: `decideEnforcementFlip()` (unit-tested).

## S4 enforcement path (SHIPPED 2026-06-10, default OFF)

- S4 advisory targets are now also recorded into the SAME saved-pct
  history (tagged `strength:"shock"`) so shock trims get measured by the
  nightly scorecard despite their rarity.
- `model_config.portfolio_regime_shock_enforce = "true"` → the hourly
  eval issues a **2h trim directive** (`phase-c:regime-shock-derisk:directive`);
  the */5 scoring preload loads it and the kanban trim cluster stages
  targeted open positions to `trim` (reason `regime_shock_derisk`,
  bypasses the structure shield, capped at 25% trimmed) through the
  normal path — CIO lifecycle review still applies. S4's flip stays
  operator-manual (shock events are too rare for an n≥20 scorecard);
  the measured history informs the call.

Earlier follow-ups (CIO `timing_overlay` context + S4 shadow advisory)
shipped in PR #556.

## Related defaults worth revisiting at enforcement time

`deep_audit_ripster_5_12_trim_min_pnl_pct` (1.5%),
`smart_runner_td_exhaustion_support_hold_enabled` (defers exhaustion
exits), `_suppressWeakTrim` structure shield, trim guard
(`positionAgeMin < 30 && pnlPct < 3`). Each is a "let winners run"
bias that the measured Phase-2 data should confirm or loosen.
