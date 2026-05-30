# Phase C — Monthly Walk-Forward + Self-Adapting Loops

## The mission

Make every month look like July. Not by inventing new setups, but by teaching
the engine to **watch itself the way we watched it in July**.

## The frame

July worked because we were paying attention. We dissected each trade,
adjusted, watched. Then we shipped and walked away. The engine kept executing
but stopped *watching*. So later months drifted.

Phase C encodes the watching into the engine itself, then walks the engine
through Jul 2025 → Apr 2026 month by month. We pause after each month, look
at the verdict, calibrate, and resume. The system that goes live IS the system
that just walked through 9 months of trades with us watching together.

## The structure

### Stage 0 — Foundation (this PR)

Builds the tools. No execution yet.

- `0a` — Trades-page promotion button (system-intelligence Backtest Runs row)
- `0b` — Monthly verdict generator (`scripts/phase-c-monthly-verdict.py`)
- `0c` — Loop 1: Specialization scorecard (`worker/phase-c-loops.js`)
- `0d` — Loop 2: Circuit breaker (hourly pulse + auto-pause)
- `0e` — Loop 3: Personality-aware management
- `0f` — All 3 loops behind DA flags, default OFF in code
- This README

### Stage 1 — Monthly walk-forward (10 months)

For each month Jul 2025 → Mar 2026:
1. Run the backtest with current config + loops ON
2. Stop at month-end
3. Run `scripts/phase-c-monthly-verdict.py --run-id <id> --month YYYY-MM`
4. Read `tasks/phase-c/monthly-verdicts/{month}-{run_id}.md`
5. Mark proud trades vs disappointed trades
6. Calibrate (edit `scripts/v15-activate.sh`)
7. Commit calibration with message `phase-c: {month} calibration`
8. Resume next month

### Stage 2 — Holdout validation

Apr 2026 → live cutoff. NO calibration on this window. The engine runs with
the final flag set. This is the proof.

### Stage 3 — Final calibration capture

Snapshot the DA flag set into `tasks/phase-c/final-config.md`. Tag the worker
version. This is what goes live.

### Stage 4 — Live cutover

Hard cutover. All loops on. Discord ready. We watch the open together.

## The three loops in one paragraph

**Loop 1 — Specialization.** After every closed trade, update a scorecard
keyed on `(setup × regime × personality × side)`. At entry time, consult
the scorecard for the prospective combo. If last-20 WR < 30%, block. If
< 45%, raise the bar (require higher rank). Otherwise allow. The engine
naturally drifts toward what's working RIGHT NOW.

**Loop 2 — Circuit breaker.** Every hour, compute a pulse from recent
closed trades (last-10 WR, today's PnL%, consecutive losses). If any
threshold is tripped (< 30% WR, < -1.5% today, ≥ 4 consec losses),
set a global pause flag. New entries are blocked until the next session.
Open trades and exits are unaffected.

**Loop 3 — Personality-aware management.** SLOW_GRINDER trades get more
runway (24h before flat-cut consideration). VOLATILE_RUNNER trades get
cut at 30 min if flat. PULLBACK_PLAYER trades get a tighter peak-lock.
MEAN_REVERT forces a trim at TP1.

## How to run a month

```bash
# 1. Activate the loops + any month-specific tunes
TIMED_API_KEY=... bash scripts/v15-activate.sh

# 2. Kick off the backtest for the month
TIMED_API_KEY=... bash scripts/continuous-slice.sh \
    --start 2025-07-01 --end 2025-07-31 \
    --label "phase-c-jul-2025"

# 3. When done, generate the verdict
TIMED_API_KEY=... python3 scripts/phase-c-monthly-verdict.py \
    --run-id <run_id> \
    --month 2025-07

# 4. Read it
cat tasks/phase-c/monthly-verdicts/2025-07-*.md

# 5. Promote to Trades page so you can SEE the trades in the UI
#    (UI: System Intelligence → Backtest Runs → "Promote → Trades")

# 6. Decide on calibration; edit scripts/v15-activate.sh; commit;
#    re-activate; resume next month.
```

## DA flags

| Flag | Default | What it does |
|---|---|---|
| `loop1_specialization_enabled` | `false` | Master kill-switch for Loop 1 |
| `loop1_min_samples` | 8 | Min trades in a combo before any judgment |
| `loop1_raise_bar_wr` | 0.45 | <X WR → require higher rank |
| `loop1_block_wr` | 0.30 | <X WR → block the combo |
| `loop1_raise_bar_lift` | 20 | Score points added to rank floor when bar raised |
| `loop2_circuit_breaker_enabled` | `false` | Master kill-switch for Loop 2 |
| `loop2_breaker_wr` | 0.30 | last-10 WR < X → trip |
| `loop2_breaker_day_pnl` | -1.5 | today PnL < X% → trip |
| `loop2_breaker_consec_loss` | 4 | X consecutive losses → trip |
| `loop3_personality_management_enabled` | `false` | Master kill-switch for Loop 3 |

## Files

- `worker/phase-c-loops.js` — Pure functions for all 3 loops
- `worker/index.js` — Wired into entry gate, trade-close hook, hourly cron
- `worker/replay-runtime-setup.js` — DA flags registered for backtest
- `scripts/v15-activate.sh` — Default values written
- `scripts/phase-c-monthly-verdict.py` — Standardized monthly report

## Status

- Stage 0: in progress (this PR)
- Stage 1-4: pending
