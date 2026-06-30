# Preprod replay runbook

Single-page operator guide for backtests on **`timed-trading-ingest-preprod`**
only. Merges March 2026 lessons, `docs/backtest-mode.md`, and
`docs/investor-training-regimen.md`.

> **Never run historical replays on the live worker.** March 2026 learned this
> the hard way — old code deploys break the dashboard and wipe live state.
> Preprod D1/KV are isolated by design.

---

## Golden rules

1. **One writer** — trader OR investor replay at a time. Same
   `timed:replay:lock`, same D1 ledger. Parallel lanes corrupt results
   ([2026-03-25 lesson](tasks/lessons.md)).
2. **Trader before investor** — investor reads `timed:replay:daystate:{date}`
   written by trader `candle-replay`. Seed `monthly_bundle` after trader,
   before investor slice.
3. **Smaller batches when CPU fails** — `503 / error code: 1102` = worker CPU
   limit. March used **15–20** tickers per batch; default 24 often needs
   retries. Drop `--ticker-batch` before adding parallel lanes.
4. **Resume, don't restart** — mid-month stalls: checkpoint → release lock →
   `--resume`. Completed days survive in D1.
5. **One config change per iteration** — otherwise deltas are unattributable
   (trader v8–v14 trap).

---

## Which driver?

| Goal | Script | Notes |
|---|---|---|
| Single-month config iteration (Jul v6–v15) | `scripts/monthly-slice.sh` | Phase D standard; direct per-day loop |
| Long multi-month campaign (Jul→Mar) | `scripts/full-backtest.sh` | March golden baseline; use `--sequence` |
| Investor month slice | `scripts/investor-slice.sh` | After trader daystate + seed |
| Isolated A/B (e.g. post890 vs v12) | `scripts/run-investor-post890-diff-rerun.sh` | Still serial vs trader |

Prefer **`monthly-slice.sh`** for monthly tuning. Prefer **`full-backtest.sh
--sequence`** only when the investor lane must walk the same long window as
trader in one campaign (`tasks/archive/2026-pre-may/GOLDEN_BASELINE_2026-03-25.md`).

Do **not** use the BacktestRunner DO for multi-session months — it stalls
reliably; the direct loop is the workaround ([2026-04-17 lesson](tasks/lessons.md)).

---

## Pre-flight (every campaign)

Run once before the first slice of a tuning cycle — not before every `--resume`.

```bash
export TIMED_API_KEY=…
export PREPROD_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev

# 1. Queue status (lock, DO, local tmux, checkpoints)
scripts/preprod-replay-status.sh

# 2. Kill stale local drivers (March lesson)
pkill -f 'monthly-slice.sh|full-backtest.sh|investor-slice.sh' 2>/dev/null || true
# Confirm no zombie tmux still curling preprod

# 3. Lock + DO must be free for a FRESH run
curl -sS -H "X-API-Key: $TIMED_API_KEY" \
  "$PREPROD_BASE/timed/admin/replay-lock?key=$TIMED_API_KEY" | jq '{locked,lock}'
curl -sS -H "X-API-Key: $TIMED_API_KEY" \
  "$PREPROD_BASE/timed/admin/backtests/status?key=$TIMED_API_KEY" | jq '{active,job}'

# 4. Candle coverage (stale-bundle failure mode)
node scripts/audit-candle-coverage.js   # gap cells → backfill-full-universe.sh

# 5. Push / pin config for this iteration
node scripts/push-july-vN-config.mjs    # or sync-model-config-to-preprod.mjs

# 6. Optional: earnings coverage for slice universe
# See docs/backtest-mode.md §Pre-flight
```

If starting **fresh** (not `--resume`), delete wrong checkpoints so you don't
accidentally resume the wrong run-id:
`data/trade-analysis/<run_id>/slice.checkpoint.json`.

---

## Trader monthly slice (Phase D)

Full flag reference: `docs/backtest-mode.md`.

```bash
# tmux recommended for long runs
SESSION=v15-july
tmux new-session -d -s "$SESSION" -c /workspace
tmux send-keys -t "$SESSION" \
  'TIMED_API_KEY=… scripts/run-v15-july.sh' C-m

# Or directly:
scripts/monthly-slice.sh \
  --month=2025-07 \
  --run-id=phase-d-slice-2025-07-v15 \
  --watchdog-seconds=300 \
  --api-base="$PREPROD_BASE" \
  --api-key="$TIMED_API_KEY"
```

**Watch for in logs:**

| Line | Meaning |
|---|---|
| `day YYYY-MM-DD ok intervals=79 scored=… trades=…` | Day succeeded |
| `WARN: … 503 … error code: 1102` | CPU limit — retries 5×; normal on preprod |
| `WATCHDOG: … exceeded …s` | Day hung — use `--resume` |
| `Reset replay state:` | Fresh run cleared replay ledger (first day only) |

**Artifacts:** `data/trade-analysis/<run_id>/`
(`trades.json`, `slice.checkpoint.json`, `slice.progress.log`).

**Post-slice:** verify trade count vs `runs/detail`; spot-check top winner/loser.
See `docs/backtest-mode.md` §Post-slice verification.

---

## Stall recovery

```bash
# 1. Confirm checkpoint last completed date
jq . data/trade-analysis/<run_id>/slice.checkpoint.json

# 2. Kill local driver (if hung)
tmux send-keys -t <session> C-c

# 3. Release lock ONLY if no driver is running
curl -X DELETE -H "X-API-Key: $TIMED_API_KEY" \
  "$PREPROD_BASE/timed/admin/replay-lock?key=$TIMED_API_KEY"

# 4. Resume from next day
RESUME=1 TIMED_API_KEY=… scripts/run-v15-july.sh
# or: scripts/monthly-slice.sh … --resume
```

If **1102 dominates** (>3 attempts per day routinely), next resume pass add
`--ticker-batch=12` (half batches). March `full-backtest.sh` used batch **20**
for the same reason.

---

## Investor lane (after trader completes)

**Do not start** until `scripts/preprod-replay-status.sh` shows lock free and
trader slice for that month is complete (or daystate exists through month-end).

```bash
# 1. Trader month already replayed (skipInvestor=1) → daystate in KV

# 2. Seed monthly_bundle (required — without this, 0 opens)
TIMED_API_KEY=… scripts/seed-investor-daystate.sh \
  --month=2025-07 \
  --api-base="$PREPROD_BASE"
# Seed errors on one day: retry that day; --allow-errors to continue variants

# 3. Investor slice (fresh run resets investor ledger only)
TIMED_API_KEY=… scripts/investor-slice.sh \
  --month=2025-07 \
  --run-id=investor-slice-2025-07-v1 \
  --api-base="$PREPROD_BASE"

# 4. Compare vs anchor report in data/trade-analysis/<run_id>/report.md
```

Details: `docs/investor-training-regimen.md`.

**March `--sequence` equivalent:** trader `monthly-slice` finishes → seed →
investor `investor-slice`. Never both tmux sessions active.

---

## Long campaigns (`full-backtest.sh`)

For Jul 2025 → Mar 2026 style runs (March golden baseline):

```bash
API_BASE=https://timed-trading-ingest-preprod.shashant.workers.dev \
TIMED_API_KEY=… \
./scripts/full-backtest.sh --sequence --trader-only \
  --label="my-campaign" \
  2025-07-01 2026-03-25 20
```

- **`--sequence`** — trader phase, then investor phase (same dates).
- **Batch 15–20** — stay under CPU limits (3rd arg).
- **`--trader-only`** — skip investor when tuning Active Trader only.
- Local PID lock: `data/.locks/full-backtest.lock`.

Reproduction recipe: `tasks/archive/2026-pre-may/GOLDEN_BASELINE_2026-03-25.md`.

---

## Iteration discipline (trader)

| Step | Action |
|---|---|
| 1 | Hypothesis → **one** `deep_audit_*` or setup change |
| 2 | `push-*-config.mjs` to preprod |
| 3 | Fresh `--run-id=…-vN` (or resume if same run interrupted) |
| 4 | Scorecard vs anchor (`phase-c-slice-2025-07-v1`) |
| 5 | Beat anchor on WR **and** selectivity (trade count)? → hold. Else revert or pivot |

If config-only iterations plateau (~48% WR despite good gates), stop config
sweeps — engine/admission parity is the next axis (`docs/july-v13-phase-a-iteration.md`).

Holdout months **2026-03** and **2026-04**: observation only until Phase G
(`docs/backtest-mode.md` §Holdout discipline).

---

## Quick reference

| Command | Purpose |
|---|---|
| `scripts/preprod-replay-status.sh` | Lock holder, DO, tmux, checkpoints |
| `scripts/monthly-slice.sh` | One trader month |
| `scripts/investor-slice.sh` | One investor month |
| `scripts/seed-investor-daystate.sh` | Patch daystate for investor gate |
| `scripts/full-backtest.sh --sequence` | Long trader→investor campaign |

| Error | Meaning | Fix |
|---|---|---|
| `1102` / `503` | Worker CPU limit | Retries; reduce `--ticker-batch` |
| Exit 3 from monthly-slice | Foreign lock or DO active | Wait; status script |
| Exit 4 | Watchdog timeout | `--resume` |
| Exit 5 | Day failed 5× | Check worker logs; smaller batch |
| Investor 0 opens | Missing `monthly_bundle` | Run seed after trader slice |

---

## Related docs

- `docs/backtest-mode.md` — Phase D flags, holdout, universe reference
- `docs/investor-training-regimen.md` — investor knobs and metrics
- `docs/july-v15-anchor-recovery.md` — current trader north star (v15)
- `tasks/lessons.md` — §Baseline Recovery [2026-03-10], §Run Data Archival [2026-03-12]
- `skills/kv-inspection.md` — inspect `timed:replay:*` keys
- `skills/backfill-candles.md` — backfill before replay
