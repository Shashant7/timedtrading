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

---

## Experiment Workflow Phases — Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1 | ✅ Done | Trail facts → baseline + experiment storage; Delete Run |
| 2 | ✅ Done | Two July candidates as protected baselines |
| 3 | 🔄 In progress | Validate July baseline; compare to protected runs |
| 4 | ✅ Done | Rule snapshot storage + run detail APIs |
| 5 | — | (Not in scope) |
| 6 | ✅ Done | Runs UI with protected/archive/delete |
| 7 | ⏳ Next | Create Variant / Review Variant Config flow |

---

## Clear Next Steps (In Order)

### Step 1: Phase 3 — Validate July Baseline
**Goal:** Confirm validation run completed; compare metrics to protected baselines.

**Status (2026-03-06):**
- **API:** `GET /timed/admin/runs?key=AwesomeSauce&limit=60` — works
- **Phase 3 runs:** 3× `phase3-july-validation` in registry, all `status: "running"`, `metrics_json: null` — **not finalized**
- **Protected baselines:**
  | Run | WR | Closed | Open | Realized P&L |
  |-----|-----|--------|------|--------------|
  | Baseline A (pre-reset) | 68.75% | 16 | 5 | $1,728 |
  | Baseline B (RSI post-trim) | 63.16% | 38 | 0 | $3,567 |

- **Local artifact** `phase3-july-validation--20260306-120313`: 22 trades, 15 closed, 7 open, 40% WR, -$361 P&L (snapshot from before/during run)

**Actions:**
1. If a replay is still running, wait for it to finish; then `POST /timed/admin/runs/finalize` with the run_id
2. If replays failed or were never completed, run a fresh full backtest: `./scripts/full-backtest.sh --trader-only --low-write --keep-open-at-end 2025-07-01 2025-07-31 15 --label=phase3-july-validation`
3. After finalize, compare validation metrics to Baseline A and B
4. Choose official July baseline (B has higher P&L and no open overhang; A has higher WR but 5 open)

---

### Step 2: Phase 7 — Create Variant Flow
**Goal:** Add "Create Variant" from a baseline run; "Review Variant Config" before launch.

**Actions:**
1. Add Create Variant button in Runs UI (from protected baseline row)
2. Modal: show rule snapshot diff, allow config edits (or link to config)
3. Wire to run a new backtest with variant config
4. Add Review Variant Config step before marking live

---

### Step 3: Use New Autopsy Tags
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
