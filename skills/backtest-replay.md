# Backtest / candle replay

How to run a model change against historical tape and get a number you can
actually trust. Every item below cost at least one wasted run to learn.

---

## 1. Where replays run

**Preprod only.** `--env=preprod`
(`https://timed-trading-ingest-preprod.shashant.workers.dev`), own D1
(`timed-trading-ledger-preprod`) and own KV.

Replays write `ticker_candles`, `trades`, `account_ledger` and `/timed/all`
state. Running one against prod poisons live data and burns the D1 read
budget. There is no dry-run mode that avoids the writes.

## 2. The runner

```bash
scripts/monthly-slice.sh \
  --month=2026-07 \
  --run-id=my-arm-jul26 \
  --label=my-arm-jul \
  --tickers="PKG,BRK-B,XLI,..." \
  --ticker-batch=24 \
  --interval-minutes=30 \
  --watchdog-seconds=900 \
  --api-base=https://timed-trading-ingest-preprod.shashant.workers.dev
```

Direct loop, one trading day per POST. Never use the BacktestRunner DO for
this — the two fight over the same replay lock.

Run it under tmux; a month takes 20–90 minutes depending on cadence.

## 3. Traps

### `--ticker-batch` TRUNCATES the universe, it does not chunk it

The direct loop sends `tickerBatch` but never advances `tickerOffset`, so
**only the first N tickers of `--tickers` are ever scored.** With
`--tickers=<28 names> --ticker-batch=24`, four names are silently ignored:
they produce no entries, no blocks, nothing in the block chain.

Verify against the log line, which is unambiguous:
`scored = intervals x tickers_actually_scored`
(`intervals=40 scored=960` → 24 tickers, not 28).

Keep `--ticker-batch` >= the ticker count, or accept the truncation and
describe the universe by what was actually scored. Comparisons across arms
stay valid as long as every arm uses the same batch size.

### New config keys need the replay allowlist

`REPLAY_DA_KEYS` in `worker/replay-runtime-setup.js` filters which
`deep_audit_*` keys reach the replay runtime. A key missing from that list
is silently dropped and the arm runs with the flag OFF — producing a run
byte-identical to baseline, which looks like "the change did nothing".

Add the key, redeploy preprod, then run.

### Cadence vs the Workers CPU limit

Per-day work is `intervals x tickers`. Around ~1900 scored ticker-intervals
per request the worker starts returning **HTTP 503 `error code: 1102`**
(exceeded resource limits) and retries do not help on busy days.

| Cadence | Intervals/day | Safe ticker batch |
|---|---|---|
| 30m | 40 | 24 |
| 10m | 79 | 24 (occasional retry) |
| 5m | 79+ | ~10 |

5m is the live cadence and is worth running, but only on a reduced ticker
set. When you cut the batch for a 5m run, re-run the control arm at the
same batch — an arm at batch 10 is not comparable to one at batch 24.

### A killed run keeps the replay lock

Ctrl-C or `tmux kill-session` can leave `timed:replay:lock` held, and the
next run aborts with `worker replay lock is already held by ...`. Clear it
after confirming nothing else is writing:

```bash
curl -s -X DELETE "$API_BASE/timed/admin/replay-lock" -H "X-API-Key: $TIMED_API_KEY"
curl -s "$API_BASE/timed/admin/backtests/status" -H "X-API-Key: $TIMED_API_KEY"
```

`status` must show `locked:false` before relaunching. It sometimes needs
two DELETEs (the status read itself can re-arm a stale entry).

### Config lives in preprod `model_config`

Columns are `config_key` / `config_value` (NOT `key` / `value`). Flip flags
per arm with an UPDATE; never send `config_override` in the replay body.

```sql
UPDATE model_config SET config_value='true'
 WHERE config_key IN ('deep_audit_...');
```

### Candle depth

Tickers outside the original preprod clone have no daily history, so
`daily_structure` is null and every daily-EMA / regime feature silently
goes blind. Backfill 2y of D plus W/M and the year's 4H before trusting
any daily-structure-dependent rule. Dedupe duplicate D bars on copy.

## 4. Reading the results — do not quote sum-of-percent

`backtest_run_trades` has both `pnl` (dollars) and `pnl_pct`.

**`SUM(pnl_pct)` is not a portfolio return.** It weights a $1k position the
same as a $12k one and happily reports "+84%" for a month that moved the
book 1.7%. The replay book is `PORTFOLIO_START_CASH = 100000`, so **dollar
P&L is the portfolio return** and is the only number worth quoting.

Always split realized from open marks:

```sql
SELECT run_id,
       COUNT(*) trades,
       ROUND(SUM(pnl),0) total_usd,
       ROUND(SUM(CASE WHEN exit_reason='replay_end_close' THEN pnl ELSE 0 END),0) open_mark_usd,
       ROUND(SUM(CASE WHEN exit_reason='replay_end_close' THEN 0 ELSE pnl END),0) realized_usd
  FROM backtest_run_trades WHERE run_id LIKE 'arm-%' GROUP BY run_id;
```

`replay_end_close` rows are positions still open at the window edge, marked
at last close. They are unrealized and highly path-dependent — a change
that merely leaves more positions open at the boundary will look like it
made money. In recent arms these carried 40–60% of total P&L. **Judge arms
on realized dollars first.**

(Historical note: before 2026-08-16 those rows were also mis-sized — the
open leg was booked on a legacy $1,000 nominal while the trim carry used
the real position, understating dollars ~10x and inflating `pnl_pct`.
Fixed in `worker/replay-admin-helpers.js`; results produced before that
date need restating from `shares`/`notional`.)

## 5. Path dependence — the reshuffle cascade

Blocking one entry frees a slot, which lets a *different* trade in, which
changes every downstream slot decision. Arm-vs-arm diffs therefore mix the
rule's direct effect with cascade noise.

Always measure the rule directly as well: diff the trade sets and sum what
the rule actually removed.

```sql
SELECT a.ticker, a.pnl FROM backtest_run_trades a
 WHERE a.run_id='arm-b'
   AND NOT EXISTS (SELECT 1 FROM backtest_run_trades b
                    WHERE b.run_id='arm-a' AND b.ticker=a.ticker
                      AND ABS(b.entry_ts-a.entry_ts)<3600000);
```

A rule whose direct effect is positive but whose headline is negative is
usually a cascade artifact, not a bad rule (and vice versa).

## 6. Universe scaling — replay is not live

The replay universe is a couple of dozen tickers; live scans ~314. For any
rule with a context pre-filter, measure candidate density on both before
believing the entry rate will carry over. The HTF-reclaim family surfaced
~5 candidates/day in the replay universe and ~40/day live (~8x).

At that ratio the position/sector caps become binding in live even though
the no-limits experiment showed them non-binding in replay, and whichever
ticker the scoring cycle reaches first wins the slot.

## 7. Checklist

1. Preprod deployed from the branch under test.
2. New config keys added to `REPLAY_DA_KEYS`.
3. Flags set in preprod `model_config` for this arm.
4. Candles backfilled for the window + warm-up.
5. `backtests/status` shows `locked:false`.
6. Cadence and ticker-batch identical across every arm being compared.
7. Read results in dollars, realized split out.
8. Diff the trade sets to separate the rule from the cascade.
