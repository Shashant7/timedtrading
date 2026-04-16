# Timed Trading — Consolidated Plan

**Last updated:** 2026-04-08

Single reference for current status and next steps. Read this first each session.

---

## Session Context (Quick Refresh)

- **API**: `https://timed-trading-ingest.shashant.workers.dev`
- **API Key**: `AwesomeSauce` (for scripts)
- **Deploy**: `npm run deploy:worker` (both envs); Pages auto-deploy on `git push main`
- **Key paths**: `worker/index.js`, `worker/indicators.js`, `react-app/shared-price-utils.js`, `tasks/todo.md`

---

## Primary Operating References

Read these in order:

1. `tasks/jul-apr-recovery-and-promotion-plan-2026-04-08.md`
2. `tasks/jul-apr-validation-contract-2026-04-08.md`
3. `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md`
4. `tasks/month-compounding-operating-model-2026-04-11.md`
5. `tasks/variable-evidence-matrix-contract-2026-04-11.md`
6. `tasks/variable-runtime-policy-map-2026-04-11.md`
7. `tasks/ticker-focused-learning-loop-2026-04-11.md`
8. `data/regime-config-decision/jul-apr-promotion-learnings-20260408.md`
9. `tasks/todo.md`
10. `CONTEXT.md`

These now supersede the older "hardening sprint only" view as the day-to-day recovery path.

---

## Current Objective

Produce one full `2025-07-01 -> 2026-04-03` backtest package that is:

- anchored to the proven July recovery package
- reproducible from a frozen manifest and pinned config
- validated month-by-month before widening scope
- promotion-eligible under one explicit go/no-go standard
- preserved as a durable artifact bundle for future comparisons

Before any new implementation or widening work, treat the latest Jul-Sep postdeploy lane as the current cumulative savepoint:

- savepoint artifact:
  `data/backtest-artifacts/focused-jul-sep-mainline-deterministic-postdeploy-v1-20260411--20260411-082805`
- savepoint run:
  `focused_replay_20260411-082805@2026-04-11T15:28:57.408Z`
- savepoint note:
  `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md`

---

## Authoritative Baseline Package

- **Behavior anchor SHA**: `422b606d85178c2b862b3606ebd4457462ff32d3`
- **Pinned config artifact**:
  `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006/model-config.json`
- **Base savepoint run**:
  `focused_replay_20260405-021006@2026-04-05T06:10:07.510Z`
- **Approved later overlay**:
  validated `GRNY` lifecycle refinements plus the focused `INTU/JCI` runtime fixes

Working rule:

- keep hardening-safe `main` work
- validate behavior-sensitive trading surfaces
- do not trust current `HEAD` trading behavior by default

---

## Recovery Path

### Step 1: Freeze the package

Use only the authoritative baseline package plus the approved overlay.

### Step 2: Freeze the validation contract

No new run launches without the gate in `tasks/jul-apr-validation-contract-2026-04-08.md`.

### Step 3: Validate in strict order

1. July focused control
2. July broad equal-scope validation
3. August validation
4. September through April widening
5. Full `Jul -> Apr` promotion candidate

### Step 4: Classify every new fix before implementation

- baseline behavior fix
- regime overlay
- profile overlay
- rare symbol exception

### Step 5: Promote only after the full blocker gate passes

Use `docs/promotion-checklist-v1.md` as the hard go/no-go gate.

---

## Hardening Status

The hardening sprint remains important background context, but its main gates are already in place:

- frozen run manifests
- replay isolation foundations
- sentinel validation artifacts
- lifecycle cohesion seam
- adaptive attribution
- stable operator read models

Those foundations are now inputs to the Jul->Apr recovery path, not the primary plan by themselves.

---

## Current Working Rules

- One authoritative replay/backtest lane at a time.
- No promotion call from contaminated or narrowed evidence.
- Equal-scope reruns are required before promotion.
- `Analysis` is allowed early when the lane is trustworthy.
- `Calibration` is diagnostic-only until July and August controls pass.

---

## Historical Context

The sections below remain as historical planning context. They are no longer the primary execution path, but they may still be useful for provenance.

## Clear Next Steps (Pending Review)

### Step 1: Finish APP-Fix 15m Compare
**Goal:** Finish the current APP-fix rerun and compare it against the classified 15m baseline.

**Current state:**
- the long-window 15m run is already complete and became the practical baseline
- the first 15m vs 10m comparison was already completed and 15m looked better
- the current open run is the APP-fix rerun, meant to validate the Sep 30 APP long fix against the classified 15m baseline
- run-scoped archives preserve both the challenger and baseline trade sets for analysis

**Compare anchor:**
- baseline: `backtest_2025-07-01_2026-03-04@2026-03-07T17:28:03.147Z`
- challenger: `15m-app-narrow-fix-jul1-mar4`

**Compare work:**
1. Wait for the APP-fix rerun to finalize cleanly
2. Compare headline metrics vs the classified 15m baseline
3. Review APP Sep 30 and any collateral trade deltas
4. Decide whether the APP-fix variant replaces the current 15m baseline or remains a selective branch

**Historical note:**
- the earlier 10m comparison baseline remains useful as reference:
  - `backtest_2025-07-01_2026-03-04@2026-03-05T05:04:37.588Z`
- but it is no longer the primary open comparison question

**Classified 15m baseline settings:**
- `LEADING_LTF=15`
- `TT_TUNE_V2=true`
- `TT_EXIT_DEBOUNCE_BARS=3`
- `deep_audit_short_min_rank=65`
- `deep_audit_swing_checklist_v1=false`
- `deep_audit_swing_require_squeeze_build=false`
- `deep_audit_variant_guardrails_v3=false`
- `calibrated_rank_min=70`
- `calibrated_sl_atr=0.57`
- `calibrated_tp_tiers={ trim: 0.62, exit: 1.29, runner: 7.75 }`
- latest March 7 `consensus_signal_weights` and `consensus_tf_weights`

---

### Step 2: Regime-Linked Profile Framework
**Goal:** Turn the run evidence into a first diagnostic profile system before enabling adaptive overrides.

**Now defined:**
- `trend_riding`
- `correction_transition`
- `choppy_selective`

**Current implementation status:**
- canonical ticker profile contract is live
- context-aware ticker diagnostics are live
- durable market / sector context history is live
- first regime-profile mapping endpoint is live
- System Intelligence and Trade Autopsy already expose the diagnostic layer

**Remaining profile work:**
1. validate current API/UI profile surfaces with smoke checks
2. keep override activation disabled until evidence quality is proven

---

### Step 3: Smaller Next-Cycle Matrix
**Goal:** Replace broad exploratory reruns with a short, interpretable matrix.

**Proposed matrix:**
1. `trend_riding-control`
   - classified 15m baseline as control
2. `correction_transition-app-fix`
   - APP-fix rerun vs classified 15m baseline
3. `choppy_selective-guardrails`
   - strict guardrail candidate on a choppy / high-VIX window
4. `override-evidence-ablation`
   - diagnostic-only evidence surfacing, no live adaptive rule activation

**Rule:** every run must state:
- control or challenger
- intended regime
- whether calibration changes are included
- whether it is diagnostic-only or promotion-eligible

---

### Step 4: Performance Enhancements
**Goal:** Reduce first meaningful paint time on Analysis and Tickers without changing behavior.

**Analysis / Home Page**
1. Split `/timed/all` into a slim first-paint payload and deferred detail hydration.
2. Precompute/cache the rank+kanban snapshot server-side so page load does not rebuild everything on demand.
3. Defer non-critical enrichments and secondary surfaces until after the first render.
4. Avoid full-object client merges on first paint where a smaller delta payload is sufficient.

**Tickers Page**
1. Stop using a full `/timed/all` sweep just to build context on page load.
2. Create a narrow ticker-context payload or include the needed fields in `ingestion-status`.
3. Precompute/cache the expensive ingestion-status summary so the page is not waiting on a cold full rebuild.
4. Keep prices/context enrichment secondary to the canonical ticker list and coverage table.

**Priority order**
- P0: Tickers backend summary caching
- P0: Analysis slim first-paint payload
- P1: Tickers narrow context endpoint
- P1: Analysis deferred enrichment / lazy secondary modules

---

### Step 5: Remaining Strategy Hardening
- Variant v2 hardening
- focused replay validations
- mean reversion TD9
- squeeze hold guard

---

## Workflow Rules (From CONTEXT)

- Plan first; write to `tasks/todo.md` for non-trivial work
- Stop on sideways; re-plan
- Verify before done
- Lessons → `tasks/lessons.md` after corrections
- Simplicity; minimal impact

---

## Files To Edit First

- `tasks/todo.md` — current tasks, phase checkboxes
- `react-app/system-intelligence.html` — Runs tab, experiment review UX
- `worker/index.js` — replay logic, run endpoints, archive-backed analysis

---

## Commands to Run

```bash
# List runs
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs?key=AwesomeSauce" | jq .

# Reconcile status (batch fix)
TIMED_API_KEY=AwesomeSauce node scripts/reconcile-status.js

# Full backtest (July baseline)
./scripts/full-backtest.sh --trader-only --low-write --keep-open-at-end 2025-07-01 2025-07-31 15 --label=phase3-july-validation

# 15m variant rerun
./scripts/full-backtest.sh --trader-only --low-write --keep-open-at-end 2025-07-01 2025-07-31 15 --label=15m-leading-ltf-rerun --env-override LEADING_LTF=15

# 15m best-foot-forward long-window candidate
./scripts/full-backtest.sh --trader-only --low-write --keep-open-at-end 2025-07-01 2026-03-04 15 --label=15m-best-foot-forward-jul1-mar4 --desc="Best-foot-forward Jul-Mar 15m candidate with March 7 calibrated stack and explicit env override capture" --env-override LEADING_LTF=15

# Run archive-backed ledger lookup
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/ledger/trades?run_id=<RUN_ID>&key=AwesomeSauce" | jq .
```
