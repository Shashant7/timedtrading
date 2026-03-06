# Timed Trading — Consolidated Plan

**Last updated:** 2026-03-06

Single reference for current status and next steps. Read this first each session.

---

## Session Context (Quick Refresh)

- **API**: `https://timed-trading-ingest.shashant.workers.dev`
- **API Key**: `AwesomeSauce` (for scripts)
- **Deploy**: `npm run deploy:worker` (both envs); Pages auto-deploy on `git push main`
- **Key paths**: `worker/index.js`, `worker/indicators.js`, `react-app/shared-price-utils.js`, `tasks/todo.md`

---

## What We Just Completed

1. **H LONG bug** — Status now derived from P&L; correct-exit/correct-all-exits/reconcile-status fixed
2. **Trade Autopsy** — Entry Grade + Trade Management multi-select (chasing, move_stretched, SL too tight, etc.)
3. **Trade Autopsy** — Fixed redeclaration errors (var for options, removed duplicate state hooks)
4. **Runs UI** — Run Date column, Show archived, Hide running (no metrics), description editing, Compare modal, Create Variant flow
5. **Phase 3** — July validation completed (71.43% WR, +$2,481); promoted to live baseline; deleted 6 old unfinalized runs
6. **Mark-live fix** — Removed erroneous .run() from D1 batch in mark-live endpoint

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
| 7 | ⏳ Next | Create Variant / Review Variant Config flow |

---

## Clear Next Steps (In Order)

### Step 1: Phase 7 — Create Variant Flow
**Goal:** Add "Create Variant" from a baseline run; "Review Variant Config" before launch.

**Done:** Create Variant button + modal (rule snapshot, env flags, backtest command).
**Remaining:** Copy command button; optionally wire backtest launch (runs locally via full-backtest.sh).

---

### Step 2: Calibrate From Autopsy Tags
**Goal:** Use Entry Grade + Trade Management tags to tune logic.

**Current summary (11 tagged trades):**
- Entry Grade: chasing (4), good_entry (4), move_stretched (1)
- Trade Management: should_have_held (8), should_have_cut_early (1), should_have_trimmed (1)

**Calibration actions:**
1. **Exits too early** (should_have_held=8) → ✅ Done: MIN_TRIM_AGE 10→15min, PROFIT_PROTECT 2%→2.5%, RIPSTER_EXIT_DEBOUNCE 2→3
2. **Chasing** (4) → keep/tighten anti-chase gates (RSI heat, ST conflict)
3. **Good entry** (4) → preserve entry path for these; avoid over-gating

---

### Step 3: Experiment Workflow Remainder
**From** `~/.cursor/plans/run_experiment_workflow_a459a54d.plan.md`:
- [ ] variant-review-ui: Review Variant Config modal (rule deltas before launch)
- [ ] historical-import: Import strong July artifacts as named runs
- [ ] First structured experiment: **15m vs 10m** `leading_ltf` (baseline=10m, variant=15m)

---

### Step 4: Trade Autopsy Mobile Layout
- Fix classification buttons visibility / overlap on mobile

---

### Step 5: Variant v2 Hardening
- Mitigate bad exits and chasing from classified trades
- **Note:** 15m vs 10m is a separate experiment (leading_ltf); Variant v2 = exit/entry logic fixes from autopsy

---

### Step 6: Mean Reversion TD9
- Implement primitives per `docs/MEAN_REVERSION_TD9_ALIGNMENT_PLAN.md`
- Add `mean_revert_td9_aligned` flag (feature-flagged)

---

## Workflow Rules (From CONTEXT)

- Plan first; write to `tasks/todo.md` for non-trivial work
- Stop on sideways; re-plan
- Verify before done
- Lessons → `tasks/lessons.md` after corrections
- Simplicity; minimal impact

---

## Files to Edit First

- `tasks/todo.md` — current tasks, phase checkboxes
- `react-app/system-intelligence.html` — Runs tab, Create Variant
- `worker/index.js` — run endpoints, variant launch logic

---

## Commands to Run

```bash
# List runs
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs?key=AwesomeSauce" | jq .

# Reconcile status (batch fix)
TIMED_API_KEY=AwesomeSauce node scripts/reconcile-status.js

# Full backtest (July)
./scripts/full-backtest.sh --trader-only --low-write --keep-open-at-end 2025-07-01 2025-07-31 15 --label=phase3-july-validation
```
