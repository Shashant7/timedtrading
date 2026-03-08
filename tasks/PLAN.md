# Timed Trading — Consolidated Plan

**Last updated:** 2026-03-07

Single reference for current status and next steps. Read this first each session.

---

## Session Context (Quick Refresh)

- **API**: `https://timed-trading-ingest.shashant.workers.dev`
- **API Key**: `AwesomeSauce` (for scripts)
- **Deploy**: `npm run deploy:worker` (both envs); Pages auto-deploy on `git push main`
- **Key paths**: `worker/index.js`, `worker/indicators.js`, `react-app/shared-price-utils.js`, `tasks/todo.md`

---

## What Is Live

1. **Runs UI + promotion flow** — Run Date, Show archived, Hide running, description editing, Compare modal, Create Variant, Promote Live
2. **Phase 3 July baseline** — completed, promoted to live, and pushed/deployed
3. **15m `LEADING_LTF` experiment infrastructure** — 15m replay/backfill support, variant env overrides, and rerun completed
4. **Run-scoped trade retention** — completed runs now snapshot into archive tables so future resets do not destroy trade-by-run analysis
5. **Historical import** — archived July artifacts imported into the run registry/run archive store so older runs remain reviewable

---

## Experiment Workflow Phases — Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | ✅ Done | Trail facts → baseline + experiment storage; Delete Run |
| 2 | ✅ Done | Two July candidates as protected baselines |
| 3 | ✅ Done | July validation completed; promoted to live (71.43% WR, +$2,481) |
| 4 | ✅ Done | Rule snapshot storage + run detail APIs |
| 5 | — | (Not in scope) |
| 6 | ✅ Done | Runs UI with protected/archive/delete |
| 7 | ✅ Done | Create Variant + rule levers + env override backtest |
| 8 | ✅ Done | Run-scoped trade archive retention + historical artifact import |

---

## Clear Next Steps (Pending Review)

### Step 1: Review 15m vs 10m Decision
**Goal:** Decide whether `LEADING_LTF=15` should stay experimental or become a stronger candidate.

**Current state:**
- 15m infrastructure is live
- rerun completed
- run-scoped archives preserve both the 15m rerun and baseline trade sets for analysis
- next run should use the March 7 calibrated stack as the reproducible candidate base

**Review work:**
1. Run the Jul 1, 2025 to Mar 4, 2026 15m best-foot-forward candidate with explicit snapshot capture
2. Compare 15m vs long-window 10m baseline trade-by-trade and by day
3. Decide whether the extra open trades are genuine upside or risk masking
4. Optionally run a forced-EOM-close apples-to-apples comparison before promotion

**Best-foot-forward candidate settings:**
- `LEADING_LTF=15`
- `RIPSTER_TUNE_V2=true`
- `RIPSTER_EXIT_DEBOUNCE_BARS=3`
- `deep_audit_short_min_rank=65`
- `deep_audit_swing_checklist_v1=false`
- `deep_audit_swing_require_squeeze_build=false`
- `deep_audit_variant_guardrails_v3=false`
- `calibrated_rank_min=70`
- `calibrated_sl_atr=0.57`
- `calibrated_tp_tiers={ trim: 0.62, exit: 1.29, runner: 7.75 }`
- latest March 7 `consensus_signal_weights` and `consensus_tf_weights`

**Baseline comparison target:**
- `backtest_2025-07-01_2026-03-04@2026-03-05T05:04:37.588Z` (long-window 10m baseline)

---

### Step 2: Calibrate From Autopsy Tags
**Goal:** Use Entry Grade + Trade Management tags to tune logic.

**Current summary:**
- Exits too early (`should_have_held`) → ✅ already loosened and deployed
- Chasing (`chasing`) → still pending review/tightening
- Good entry preservation → still pending as part of Variant v2 hardening

---

### Step 3: Variant v2 Hardening
- Mitigate bad exits and chasing from classified trades
- Keep this separate from the `leading_ltf` experiment so entry/exit logic changes stay attributable

---

### Step 4: Focused Replay Validations
- WMT loss guard replay: verify WMT blocked while CSX still passes
- RSI extreme guard replay: compare blocked vs kept trades against baseline
- Swing Checklist A/B: run control + variant and compare outcome mix

---

### Step 5: Mean Reversion TD9 + Squeeze Hold
**Mean Reversion TD9** (`docs/MEAN_REVERSION_TD9_ALIGNMENT_PLAN.md`):
- Primitives: `countRecentGapsDown`, `td9AlignedLong`, `phaseLeavingDotBullish`, `isNearPsychLevel`
- Add `mean_revert_td9_aligned` flag (feature-flagged)

**Squeeze Hold Guard:**
- Management-only squeeze/compression hold guard to reduce premature exits during consolidation

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
