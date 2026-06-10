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

## Phase 2 — measure (operator + next sessions)

- Watch advisories for 2-4 weeks of tape. For each advisory, the
  counterfactual is mechanical: pnl at advisory time vs pnl at actual
  exit. A nightly job (or calibration script) can compute
  "advisory-followed P&L delta" from `timed:reversal-trim:advisory`
  snapshots + the ledger. Promote to enforcement only if the advisor
  shows positive saved-PnL with acceptable false-positive cost (winners
  trimmed that kept running).

## Phase 3 — guarded enforcement (separate PR, operator-gated)

Options, in increasing autonomy (all default OFF):
1. `reversal_trim_advisor_enforce="true"`: advisory → engine trims the
   suggested 25/33% through the EXISTING trim path (so CIO lifecycle
   review, manifests, alerts all apply). Strong advisories only.
2. Include `timing_overlay` + FSD overlay in `buildCIOLifecycleProposal`
   payloads so the CIO sees reversal context on every TRIM/HOLD veto
   decision (closes gap #5 cheaply).
3. S4 regime-shock de-risk: when INDEX EXTENSION WATCH flips active AND
   the portfolio DD breaker is within 1% of tripping, trim the weakest
   quartile of open winners by 25% (portfolio coordinator — the
   review's S4 item).

## Related defaults worth revisiting at enforcement time

`deep_audit_ripster_5_12_trim_min_pnl_pct` (1.5%),
`smart_runner_td_exhaustion_support_hold_enabled` (defers exhaustion
exits), `_suppressWeakTrim` structure shield, trim guard
(`positionAgeMin < 30 && pnlPct < 3`). Each is a "let winners run"
bias that the measured Phase-2 data should confirm or loosen.
