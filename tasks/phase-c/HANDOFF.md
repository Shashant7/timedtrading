# Phase C Stage 1 — Backtest Driver Handoff

**Last updated:** 2026-05-04 (UTC)
**Branch:** `cursor/phase-c-stage1-jul-verdict-2e87`
**Run ID:** `phase-c-stage1-jul2025-may2026`
**Active PR:** [#67](https://github.com/Shashant7/timedtrading/pull/67)

---

## TL;DR — Current State

The previous agent ran extensive UI work + 4-5 separate backtest restarts, calibrating between months. The **most recent run is corrupted** because 11 trades closed at wall-clock timestamps (May 4, 2026) instead of simulated time, via `v13_hard_age_cap` and `v13_hard_pnl_floor`. This needs:

1. **Root-cause fix to V13** so it can NEVER fire with wall-clock during replay
2. **Fresh July → May 2026 backtest** with all the V15 P0.7.50–P0.7.56 fixes baked in
3. **Sequential monthly verdict + calibration** between each leg
4. **Promote final run** to live engine + Trades page

User wants this completed **today (May 4)** so the live engine can take over for the rest of the week.

---

## Priority Order

### 1. AUDIT + FIX V13 hard exits (MUST be first)

The corruption: 11 trades from Jul/Oct 2025 closed at "2026-05-04 10:19-12:24 UTC" (today's wall-clock) via:
- `v13_hard_age_cap` (8 trades) — fires when trade age > 30 days. Ours: age computed with wall-clock vs Jul/Oct entry = 6-9 months, well past 30 days.
- `v13_hard_pnl_floor` (3 trades) — fires when pnl_pct < -4.5%. Triggered when wall-clock close price was very different from entry.

**Code locations:**
- `worker/index.js:6848-6878` — V13 safety nets in `classifyKanbanStage`
- The function takes optional `asOfTs` parameter (line 6792). When called with `asOfTs`, `now` (line 6810) uses simulated time. When called without, `now = Date.now()`.
- **Multiple callers don't pass `asOfTs`**: lines 30600, 36160, 38602, 39510, 40372, 40484. These are read-time paths (e.g. `/timed/all`, `/timed/prediction-contract`) that compute kanban_stage cosmetically but don't write back.
- BUT the live cron at `index.js:25627` calls `processTradeSimulation` for queued actions WITHOUT `asOfTs`. If that fires on a backtest trade, it would force-close it.

**Filter that should protect us:** `d1LoadTradesForSimulation` at `worker/index.js:32660` filters with:
```sql
WHERE t.run_id IS NULL
   OR t.run_id IN (SELECT run_id FROM backtest_runs WHERE live_config_slot = 1)
```
Our run has `live_config_slot = 0`, so live cron should skip our trades — but **corruption still happened**. Investigate:
1. Is there ANOTHER trades-loader that doesn't filter by `live_config_slot`?
2. Does the kv `timed:trades:all` (fallback in `processTradeSimulation` line 14631) leak our trades?
3. Check `worker/replay-runtime-setup.js loadReplayScopedTrades` rescue from `backtest_run_trades` — does that path push trades back into KV `timed:trades:all` somewhere?

**Recommended fix:**
1. Defense in depth — make V13 short-circuit if no `asOfTs` passed AND trade has `run_id != null`:
   ```js
   if (!asOfTs && openPosition?.run_id) {
     // Replay trade evaluated at read-time; defer to actual replay engine
     return null;
   }
   ```
2. Find the actual leak path. Grep for any code that writes our run's trades into `kv timed:trades:all`.
3. Verify the live cron's `processTradeSimulation` filters by `run_id IS NULL` everywhere it reads trades.

### 2. WIPE + RELAUNCH Backtest

Once V13 is hardened:

```bash
# Stop any running tmux session
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "phase-c-leg:0.0" C-c

# Wait for clean exit
sleep 30
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/replay-lock?key=$TIMED_API_KEY"

# Delete the run
curl -sS -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs/delete?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"phase-c-stage1-jul2025-may2026"}'

# Wipe KV state
cd /workspace/worker
npx wrangler kv key put --remote --namespace-id=e48593af3ef74bf986b2592909ed40cb 'phase-c:scorecards' '{}'
npx wrangler kv key delete --remote --namespace-id=e48593af3ef74bf986b2592909ed40cb 'phase-c:engine-paused'

# Wipe local artifacts + verdicts
cd /workspace
rm -rf data/trade-analysis/phase-c-stage1-jul2025-may2026/
rm -f tasks/phase-c/monthly-verdicts/2025-0[789]-phase-c-stage1.md \
      tasks/phase-c/monthly-verdicts/2025-1*-phase-c-stage1.md \
      tasks/phase-c/monthly-verdicts/2026-*-phase-c-stage1.md

# Push v15 config to live model_config (registers all DA flags)
bash scripts/v15-activate.sh

# Launch July (FIRST leg, no --resume)
mkdir -p data/trade-analysis/phase-c-stage1-jul2025-may2026
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "phase-c-leg:0.0" \
  "INTERVAL_MINUTES=30 TIMED_API_KEY=\$TIMED_API_KEY bash scripts/continuous-slice.sh \
    --start=2025-07-01 --end=2025-07-31 \
    --manifest-start=2025-07-01 --manifest-end=2026-05-01 \
    --run-id=phase-c-stage1-jul2025-may2026 \
    --tickers=@configs/backtest-universe-phase-c-stage1.txt \
    --watchdog-seconds=600 \
    --no-finalize \
    2>&1 | tee data/trade-analysis/phase-c-stage1-jul2025-may2026/leg-Jul2025.log" C-m
```

ETA per leg: ~70 min (22 trading days × 3 min/day average).

### 3. PER-LEG WORKFLOW

After each leg finishes (lock releases, tmux returns to prompt):

```bash
# Generate verdict
cd /workspace
python3 scripts/phase-c-monthly-verdict.py \
  --run-id=phase-c-stage1-jul2025-may2026 \
  --month=2025-07 \
  --output-dir=tasks/phase-c/monthly-verdicts

# Move to canonical name
mv -f tasks/phase-c/monthly-verdicts/2025-07-phase-c-stage1-jul2025-may2026.md \
      tasks/phase-c/monthly-verdicts/2025-07-phase-c-stage1.md

# Inspect verdict — look for warning signs:
head -32 tasks/phase-c/monthly-verdicts/2025-07-phase-c-stage1.md
```

**Warning signs requiring calibration:**
- WR drops by > 10pp vs prior month
- A specific exit reason fires > 10 times with WR < 30% (use `phase-c-monthly-verdict.py` Loop Firing Log section)
- Cumulative DD > 5% in a single month
- Suspicious `v13_hard_age_cap` or `v13_hard_pnl_floor` exit reasons (= corruption returned)

**To apply a calibration tweak between legs:**
```bash
# Patch the active run's pinned config (so the change takes effect mid-stream)
curl -sS -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs/config-patch?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"phase-c-stage1-jul2025-may2026","updates":[{"key":"<DA_FLAG>","value":"<NEW_VALUE>"}]}'

# Also push to live model_config (so future runs / re-pins inherit)
# Edit scripts/v15-activate.sh and run:
bash scripts/v15-activate.sh
```

**Then launch the next month:**
```bash
# Aug (with --resume so open positions carry forward)
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "phase-c-leg:0.0" \
  "INTERVAL_MINUTES=30 TIMED_API_KEY=\$TIMED_API_KEY bash scripts/continuous-slice.sh \
    --start=2025-08-01 --end=2025-08-31 \
    --manifest-start=2025-07-01 --manifest-end=2026-05-01 \
    --run-id=phase-c-stage1-jul2025-may2026 \
    --tickers=@configs/backtest-universe-phase-c-stage1.txt \
    --watchdog-seconds=600 \
    --resume --no-finalize \
    2>&1 | tee data/trade-analysis/phase-c-stage1-jul2025-may2026/leg-Aug2025.log" C-m
```

Repeat for Sept, Oct, Nov, Dec, Jan, Feb, Mar, Apr.

### 4. FINAL LEG (May 2026) — drop `--no-finalize`

The May leg is the LAST one. Drop `--no-finalize` so:
- `close-replay-positions` runs (closes any remaining open positions)
- `runs/finalize` flips `status='completed'` and computes metrics

```bash
# May leg (FINAL — no --no-finalize)
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "phase-c-leg:0.0" \
  "INTERVAL_MINUTES=30 TIMED_API_KEY=\$TIMED_API_KEY bash scripts/continuous-slice.sh \
    --start=2026-05-01 --end=2026-05-04 \
    --manifest-start=2025-07-01 --manifest-end=2026-05-04 \
    --run-id=phase-c-stage1-jul2025-may2026 \
    --tickers=@configs/backtest-universe-phase-c-stage1.txt \
    --watchdog-seconds=600 \
    --resume \
    2>&1 | tee data/trade-analysis/phase-c-stage1-jul2025-may2026/leg-May2026.log" C-m
```

### 5. PROMOTE TO TRADES + LIVE

After May leg finalizes (status=completed):

**A. Promote to Trades page** (always works, no validation gate):
```bash
curl -sS -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/promoted-trades/promote?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"phase-c-stage1-jul2025-may2026","activate":true,"promoted_by":"agent"}'
```

**B. Promote to Live engine** (requires sentinel validation OR `force=true`):
```bash
# Option 1: Validate first
curl -sS -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs/validate-sentinels?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"phase-c-stage1-jul2025-may2026","reference_run_id":"v16-canon-julapr-30m-1777523625"}'

# Then promote
curl -sS -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs/mark-live?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"phase-c-stage1-jul2025-may2026"}'

# Option 2: Force-promote (if user accepts)
curl -sS -X POST "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs/mark-live?key=$TIMED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"phase-c-stage1-jul2025-may2026","force":true}'
```

---

## All Active Calibration Levers

These are baked into `scripts/v15-activate.sh` and pushed to live model_config + the active run's pinned config. Worker version `b64a34b0` (most recent deploy).

### V15 P0.7.50 — Orphan rescue (DO NOT TOUCH)
Critical bug fix. `loadReplayScopedTrades` now reads `backtest_run_trades` archive AND live `trades` per batch, unioned by trade_id. Without this, silent `d1UpsertTrade` failures leave open positions invisible to the engine on resume.

### V15 P0.7.51 — HARD_FUSE setup-aware split
- `deep_audit_hard_fuse_default_rsi1h = 85`, `rsi4h = 80` (everything else)
- `deep_audit_hard_fuse_volrunner_gap_long_rsi1h = 88`, `rsi4h = 83` (workhorse cohort: lets winners ride)

### V15 P0.7.52 — Big-winner extension (analysis levers 1+2)
- `deep_audit_winner_protect_big_mfe_threshold_pct = 8.0` (was 15.0)
- `deep_audit_winner_protect_big_mfe_lock_pct = 0.55` (was 0.60)
- `deep_audit_mfe_decay_giveback_pct_max_volrunner_gap_long = 0.75` (cohort-only override of 0.60 base)

### V15 P0.7.53 — Extend lever 1 to PROFIT_GIVEBACK + SMART_RUNNER
- `deep_audit_profit_giveback_pct_max_volrunner_gap_long = 0.85`
- `deep_audit_profit_giveback_min_mfe_volrunner_gap_long = 5.0`
- `deep_audit_smart_runner_volrunner_gap_long_defer_pnl_floor = -0.5`

### V15 P0.7.55 — Momentum Buffer (SNDK Sep-18 case)
- Uses existing `flags.momentum_elite` (the 🚀 flag) as primary qualifier
- `deep_audit_momentum_buffer_enabled = true`
- `deep_audit_momentum_buffer_min_signals = 3` (of 5 structural)
- `deep_audit_momentum_buffer_max_loss_pct = -5.0`
- `deep_audit_momentum_buffer_time_scaled_expand_pct = 1.0`

### V15 P0.7.56 — Anti-chase + Thesis-flip (CALIBRATED Oct autopsy)
- `deep_audit_anti_chase_enabled = true`
- `deep_audit_anti_chase_vwap_30m_dist_pct = 40` (raised from 25 after Oct over-vetoed)
- `deep_audit_anti_chase_vwap_1h_dist_pct = 80` (raised from 60)
- `deep_audit_thesis_flip_enabled = true`
- `deep_audit_thesis_flip_min_age_min = 180` (raised from 60 — was firing too early)
- `deep_audit_thesis_flip_min_pnl_pct = -1.5` (raised from -0.5 — was firing on micro-wiggles)

### Loops (Phase C Stage 1)
- `loop1_specialization_enabled = true`, `loop1_min_samples = 3`
- `loop2_circuit_breaker_enabled = true`
- `loop3_personality_management_enabled = true`

### Misc
- `deep_audit_time_scaled_max_loss_4h_pct = -2.0`

---

## Key File References

| File | Purpose |
|---|---|
| `worker/index.js` | Core engine. ~67k lines. Search for `classifyKanbanStage` (line 6792) for management logic. |
| `worker/replay-runtime-setup.js` | Replay scaffolding. `loadReplayScopedTrades` (~line 858) reconciles trades. `REPLAY_DA_KEYS` (~line 285) lists all DA flags loaded for runs. |
| `worker/replay-candle-batches.js` | Per-batch replay loop. Calls `processTradeSimulation` per ticker per bar. |
| `worker/replay-candle-step.js` | One simulated day's batch invocation. Pre-fetches Loop 1/2 state from KV. |
| `worker/pipeline/tt-core-entry.js` | Entry decision pipeline. `evaluateEntry` (line 112). Anti-chase guard at ~line 390. |
| `worker/pipeline/tt-core-exit.js` | Exit decision pipeline. Mirrors `mfe_decay` from index.js. |
| `worker/phase-c-loops.js` | Loop 1 (specialization) / Loop 2 (circuit breaker) / Loop 3 (personality-aware) implementations. |
| `scripts/v15-activate.sh` | Pushes all DA flag values to live model_config. **Edit + run after every calibration change.** |
| `scripts/continuous-slice.sh` | Runs one leg of a backtest. Supports `--resume`, `--no-finalize`, `--manifest-start/end`, `--watchdog-seconds`. |
| `scripts/phase-c-monthly-verdict.py` | Generates the per-month verdict markdown (read by user + agent for calibration decisions). |
| `tasks/phase-c/monthly-verdicts/` | Verdict markdowns named `YYYY-MM-phase-c-stage1.md`. |
| `tasks/phase-c/post-fix-jul-aug-deep-analysis.md` | The 5-lever analysis from earlier in the project. Useful reference for next calibration ideas. |
| `tasks/phase-c/HANDOFF.md` | This file. |
| `tasks/system-intelligence-revamp/audit.md` | System Intelligence page redesign notes. |
| `tasks/phase-c/orphaned-open-positions-investigation.md` | The bug investigation that led to V15 P0.7.50 orphan rescue fix. |
| `tasks/phase-c/universe-benchmark/` | The "oracle vs system" benchmark (10-day forward windows, 8% threshold). Used to identify capture efficiency issues. |
| `configs/backtest-universe-phase-c-stage1.txt` | The 238-ticker universe used for Stage 1. |

---

## Cumulative History (legs run so far this session — all corrupted)

| Run iteration | Date started | Outcome |
|---|---|---|
| #1 (Path A: resume Sept) | 2026-05-03 ~21h | Sept finished, then bugs identified |
| #2 (Path B: fresh July) | 2026-05-03 ~22h | July only, then various calibrations applied |
| #3 (Multi-month, calibration cycle) | 2026-05-04 ~04:31 | Jul+Aug+Sept ran clean. **Oct corrupted via V13 wall-clock force-close (11 trades exited at "May 4 10-12 UTC").** |

### Oct corruption trades (proof of bug)
```
CDNS   entry=2025-07-31 13:40  exit=2026-05-04 10:19  status=LOSS   pnl=$ -973.18  v13_hard_pnl_floor
CSX    entry=2025-07-31 14:00  exit=2026-05-04 10:19  status=WIN    pnl=$+1859.11  v13_hard_age_cap
ORCL   entry=2025-07-31 17:00  exit=2026-05-04 10:19  status=LOSS   pnl=$-4055.02  v13_hard_pnl_floor
RGLD   entry=2025-10-08 15:30  exit=2026-05-04 12:24  status=WIN    pnl=$+1063.89  v13_hard_age_cap
CAT    entry=2025-10-08 17:00  exit=2026-05-04 12:23  status=WIN    pnl=$+9342.90  v13_hard_age_cap   ← bogus inflation
AAPL   entry=2025-10-08 17:00  exit=2026-05-04 12:23  status=WIN    pnl=$ +708.03  v13_hard_age_cap
AA     entry=2025-10-08 17:00  exit=2026-05-04 12:24  status=WIN    pnl=$+5752.41  v13_hard_age_cap   ← bogus inflation
ETN    entry=2025-10-08 18:00  exit=2026-05-04 12:23  status=WIN    pnl=$+1586.90  v13_hard_age_cap
FIX    entry=2025-10-08 19:00  exit=2026-05-04 12:23  status=WIN    pnl=$+9584.00  v13_hard_age_cap   ← bogus inflation
AWI    entry=2025-10-08 19:00  exit=2026-05-04 19:00  status=LOSS   pnl=$-1388.85  v13_hard_pnl_floor
SPY    entry=2025-10-22 14:30  exit=2026-05-04 12:24  status=WIN    pnl=$ +488.32  v13_hard_age_cap
```

These ALL must NOT recur in the next run.

---

## Active Backtest Universe

`configs/backtest-universe-phase-c-stage1.txt` — 238 tickers (combined `canon-200.txt` + current live `/timed/tickers` registry, excluding synthetic feeds GRNI/GRNJ).

---

## Operational Notes

### tmux session
- The backtest orchestrator runs in tmux session `phase-c-leg:0.0`.
- To send commands: `tmux -f /exec-daemon/tmux.portal.conf send-keys -t "phase-c-leg:0.0" "COMMAND" C-m`
- To capture output: `tmux -f /exec-daemon/tmux.portal.conf capture-pane -t "phase-c-leg:0.0" -p | tail -N`
- To stop: `tmux -f /exec-daemon/tmux.portal.conf send-keys -t "phase-c-leg:0.0" C-c` then wait 30s

### Replay lock
- Always check before launching: `curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/replay-lock?key=$TIMED_API_KEY"`
- Should return `{"ok":true,"locked":false,"lock":null}` to be safe to launch

### Worker deployment
- Deploy via `cd /workspace/worker && npx wrangler deploy --env='' && npx wrangler deploy --env production`
- **Don't deploy mid-leg** unless absolutely necessary (interrupts in-flight requests)
- Frontend deploy is always safe: `cd /workspace && bash scripts/deploy-frontend.sh`

### Run inspection
```bash
# Get all trades for the run
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/backtests/run-trades?run_id=phase-c-stage1-jul2025-may2026&key=$TIMED_API_KEY&limit=2000" -o /tmp/trades.json

# Quick stats
python3 -c "import json; ts=json.load(open('/tmp/trades.json'))['trades']; print(f'total={len(ts)} wins={sum(1 for t in ts if t.get(\"status\")==\"WIN\")} losses={sum(1 for t in ts if t.get(\"status\")==\"LOSS\")} open={sum(1 for t in ts if t.get(\"status\") in (\"OPEN\",\"TP_HIT_TRIM\"))}')"

# Run state
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs?key=$TIMED_API_KEY" | python3 -c "import sys,json; r=[r for r in json.load(sys.stdin)['runs'] if 'phase-c-stage1' in str(r.get('run_id',''))][0]; print(f'status={r[\"status\"]} live_slot={r[\"live_config_slot\"]} active_slot={r[\"active_experiment_slot\"]}')"
```

### Pinned config inspection
```bash
curl -s "https://timed-trading-ingest.shashant.workers.dev/timed/admin/runs/config?run_id=phase-c-stage1-jul2025-may2026&key=$TIMED_API_KEY" | python3 -c "
import sys,json; cfg=json.load(sys.stdin)['config']
for k in sorted(cfg):
    if 'momentum_buffer' in k or 'anti_chase' in k or 'thesis_flip' in k or 'volrunner_gap_long' in k or 'hard_fuse' in k or k.startswith('loop'):
        print(f'{k}={cfg[k]!r}')
"
```

---

## What NOT to do

- **Don't promote the corrupted run** (current state). Wipe it first.
- **Don't deploy worker mid-leg** unless replay-lock is free.
- **Don't change the orphan-rescue logic** in `loadReplayScopedTrades` (V15 P0.7.50). Critical infrastructure.
- **Don't loosen the entry gate** without clear evidence — user explicitly rejected the volatility-expansion carve-out in earlier session: "I want to prioritize Big Winners and WR. It's ok to miss moves, lets be wise on how we tune."
- **Don't change v15-activate.sh defaults** without thinking through implications. Each lever has been calibrated based on actual trade autopsies.

---

## Known UI bugs (low priority, do AFTER backtest is done)

These are deferred frontend issues — **don't let them block the backtest work**:

1. **Fundamentals tab font size** — user has flagged 3 times that fonts are still too big (worker version `b64a34b0` shipped a 3rd reduction pass; user feedback after that not yet captured).
2. **Mobile bubble map fullscreen modal** — added in last commit, not yet user-verified.
3. **Right Rail tabs horizontal scroll on mobile** — added, not yet user-verified.
4. **Top header breathing room** — added safe-area-inset padding, not yet user-verified.

Contact human user for these before working on them.

---

## Success Criteria

The user wants:
1. **Clean Jul → May 2026 backtest** with 0 wall-clock force-closes (= 0 V13 trades with `exit_ts >= 2026-05-04`).
2. **All 11 monthly verdicts** in `tasks/phase-c/monthly-verdicts/`.
3. **Cumulative final equity** showing real, defensible P&L (not inflated by corruption).
4. **Run promoted to live engine** so the worker uses these calibrations going forward.
5. **Trades page populated** so the user can review the full history.
6. **Done by end of May 4, 2026** so the rest of the week can be live evaluation.

If you cannot complete in one day:
- At minimum, get the V13 fix in + a clean July leg (proof the bug is gone)
- Document where you stopped + what's blocking
