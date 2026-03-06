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

### Step 2: Use New Autopsy Tags
**Goal:** Classify trades to drive calibration decisions.

**Actions:**
1. Tag ~20–50 trades with Entry Grade + Trade Management
2. Summarize: chasing vs move_stretched vs fake_out; SL too tight vs should have held
3. Decide: 10m weight, confirmation gates, or ticker personality tuning

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
