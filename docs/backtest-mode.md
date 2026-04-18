# Backtest mode — operator guide

How to run a Phase D monthly slice end-to-end on a deterministic
orchestrator with clean data. Applies to all months Jul 2025 → Apr 2026.

## Pre-flight checklist

Every fresh backtest cycle (not per-month, but per-campaign) should
start with:

1. **Deploy the latest worker.** Record both Version IDs.
   ```
   cd worker && npx wrangler deploy --env='' && npx wrangler deploy --env production
   ```

2. **Confirm no active DO run or replay lock.** Must both be clean
   before any slice starts, else the single-writer guard aborts.
   ```
   curl -sS "$API_BASE/timed/admin/backtests/status?key=$KEY"
   curl -sS "$API_BASE/timed/admin/replay-lock?key=$KEY"
   ```
   Expected: `active: null` and `locked: false`.

3. **Run the candle-coverage audit** (`scripts/audit-candle-coverage.js`)
   to confirm D1 has the bars the slice needs. Gap cells > 0 %
   usually means we're about to hit the stale-bundle failure mode.
   If so, run `scripts/backfill-full-universe.sh`.

4. **Run the earnings-coverage probe** against the slice's universe.
   ```
   TICKERS=$(paste -sd, configs/backtest-universe-phase-d-40.txt)
   curl -sS "$API_BASE/timed/admin/market-events/coverage?startDate=2025-07-01&endDate=2026-04-17&tickers=$TICKERS&key=$KEY"
   ```
   Any missing tickers → seed via
   `POST /timed/admin/backfill-market-events?ticker=<T>&earningsOnly=1`.

5. **Confirm DA-key activation matches expectations.** If T6A is
   active, these three `model_config` keys must be set:
   ```
   deep_audit_pullback_min_bearish_count_index_etf_tickers = "SPY,QQQ,IWM"
   deep_audit_pullback_min_bearish_count_index_etf = "1"
   deep_audit_pullback_non_prime_min_rank_index_etf = "85"
   ```
   If inactive, all three should be empty strings. Never leave them
   half-set.

## Running a single month

```
export TIMED_API_KEY=<admin-key>

# 24-ticker universe (Phase-B anchor baseline — preserves continuity
# with the pre-cleanup observation anchors):
scripts/monthly-slice.sh \
  --month=2025-07 \
  --run-id=phase-d-slice-2025-07-v2 \
  --label=phase-d-slice-2025-07-v2 \
  --tickers=tier1-tier2 \
  --block-chain

# 40-ticker universe (Phase D go-forward standard):
scripts/monthly-slice.sh \
  --month=2025-07 \
  --run-id=phase-d40-slice-2025-07-v1 \
  --label=phase-d40-slice-2025-07-v1 \
  --tickers=phase-d-40 \
  --ticker-batch=40 \
  --block-chain
```

Flags:

- `--month=YYYY-MM` — required. Must be 01..12.
- `--run-id=...` — ideally include the universe prefix (`phase-d`,
  `phase-d40`) and a `-vN` so reruns are unambiguous. Defaults to
  `phase-c-slice-<month>@<iso>` if unset.
- `--tickers=...` — universe selection. Options:
  - `tier1` — 10 Tier-1 tickers (SPY/QQQ/IWM + Mag 7).
  - `tier2` — 14 Tier-2 tickers (Phase-B locked list).
  - `tier1-tier2` (default) — 24-ticker Phase-B anchor universe.
  - `phase-d-40` — 40-ticker go-forward universe (see
    `configs/backtest-universe-phase-d-40.txt`).
  - `@<path>` — read from file, one ticker per line.
  - Any CSV — explicit list.
- `--ticker-batch=N` — worker-side batching. 24 is the default; for
  the 40-ticker universe pass `--ticker-batch=40` so the slice
  completes in a single batch per session.
- `--block-chain` — emit per-bar rejected-entry trace to
  `data/trade-analysis/<run_id>/block_chain.jsonl`. Required for any
  month whose report will be compared against another slice via
  `scripts/compare-block-chains.js`.
- `--resume` — skip the clean-slate reset + run registration; pick
  up from the checkpoint file. Use only when a prior run was
  interrupted mid-month.
- `--dry-run` — print the plan, make no HTTP calls. Good for
  verifying the trading-day calendar before a long run.

## Log lines worth watching

- `Reset replay state: …` — first session only. Confirms the cleanSlate
  reset cleared any residual state.
- `day <date> ok intervals=79 scored=<n> trades=<k>` — per-session
  success.
- `[CANDLE_STALE_GUARD]` in worker logs (`wrangler tail`) — the
  intraday bundle pricing diverged from the freshest TF close by > 5 %
  and was patched. Indicates a coverage gap in the most recent
  intraday TF for that ticker. Not a failure; worth flagging if it
  fires > 20 times in a slice.
- `[ENTRY_PRICE_DIVERGENT]` in worker logs — a trade was refused
  because `entryPx` diverged from the most recent daily close by
  > 10 %. This should NEVER fire in a post-hydration run; if it
  does, re-audit the affected ticker before interpreting the slice.

## Post-slice verification

After `=== Phase C slice <month> complete ===` appears in the
progress log:

1. `curl -sS "$API_BASE/timed/admin/runs/detail?run_id=<run_id>&key=$KEY" | jq '.total_trades // .run.total_trades'`
   — must match the `trades.json` count.
2. Spot-check the top winner and top loser against actual price
   history via TwelveData's `/time_series` endpoint. If entry_price
   or exit_price looks bizarre (e.g. flat entry/exit, exit_reason =
   `RUNNER_STALE_FORCE_CLOSE`), treat the slice as suspect and
   re-audit candle coverage for that ticker.
3. `block_chain.jsonl` line count should equal
   `sum(blockReasons)` per day summed across the month. If it
   diverges you have a serialisation bug in the analyzer — log a
   ticket, don't just re-run.

## Cycling through months

For a clean re-run of all 10 months:

```
for m in 2025-07 2025-08 2025-09 2025-10 2025-11 2025-12 \
         2026-01 2026-02 2026-03 2026-04; do
  scripts/monthly-slice.sh \
    --month="$m" \
    --run-id="phase-d-slice-$m-v2" \
    --label="phase-d-slice-$m-v2" \
    --tickers=tier1-tier2 \
    --block-chain
done
```

Each slice is ~15–20 min wall-time. Total ~3 hours for all 10
months, plus ~20 min for writeup + analysis per month. Budget
~8 hours per full cycle.

## Troubleshooting

- **`[CANDLE_STALE_GUARD]` fires frequently**: run the audit
  (`scripts/audit-candle-coverage.js`) and then the full backfill
  (`scripts/backfill-full-universe.sh`) before retrying.
- **Slice stalls at a session for > 180 s**: watchdog will auto-kill
  and write a checkpoint. Clear the replay lock
  (`curl -X DELETE "$API_BASE/timed/admin/replay-lock?key=$KEY"`)
  and re-invoke with `--resume`.
- **Ghost trades from a prior run show up**: shouldn't happen on
  `main` post PR #9 cleanSlate fix. If it does, manually run
  `POST /timed/admin/reset?resetLedger=1&replayOnly=1&key=$KEY`
  and re-invoke from scratch (no `--resume`).
- **Trade count differs between two back-to-back runs of the same
  month**: orchestrator bug. Log a ticket; do not use the
  non-deterministic results for any tuning decision.

## Holdout discipline

`2026-03` and `2026-04` are Phase G holdout months. You may **run
slices on them for observation**, but:

- No DA-key change is permitted to use Mar / Apr slice results as
  part of its evidence base before Phase G validation.
- The cross-month synthesis PR always flags Mar / Apr artifacts as
  `holdout: true` in `tuning_proposal.json`.
- Any proposed DA-key change that ships pre-Phase-G is required to
  hold the Mar / Apr holdouts to ≤ 3 pp WR regression and ≤ 10 %
  PnL regression at Phase G validation. Violations abort the
  proposal.

## Universe reference

- `configs/backfill-universe-2026-04-18.txt` — the 215-ticker
  hydrated universe (SECTOR_MAP minus futures / crypto pairs / TV-only
  symbols). Used by `scripts/backfill-full-universe.sh`.
- `configs/backtest-universe-phase-d-40.txt` — the 40-ticker go-forward
  universe for Phase D synthesis work.
- `scripts/build-monthly-backdrop.js` — 24-ticker Phase-B universe.
  Keep in sync with `monthly-slice.sh`'s `tier1-tier2` default.
