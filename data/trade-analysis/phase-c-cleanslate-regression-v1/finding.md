# Phase C clean-slate fix — regression on 2025-07

> **Status.** `scripts/monthly-slice.sh` now performs a canonical
> `POST /timed/admin/reset?resetLedger=1&skipTickerLatest=1&replayOnly=1`
> before the first session of a fresh run, and passes `cleanSlate=1` on
> the first `candle-replay` POST. Two back-to-back re-runs of 2025-07
> with the fix produced **identical** 36-trade ledgers. Monthly slices
> are now deterministic. The Phase-C anchor's prior 25-trade count was
> itself state-contaminated; the true clean baseline for 2025-07 on
> the 24-ticker universe is **36 trades, 77.8 % WR, 5 big winners, sum
> `pnl_pct` +109.06 %**.

## Timeline

- **2026-04-18 13:15 UTC.** Added `reset_replay_state()` helper to
  `scripts/monthly-slice.sh` plus a `--no-reset` escape hatch for
  diagnostic probes that intentionally share state. Wired `cleanSlate=1`
  into `replay_day()` and have the main loop pass it on `i ==
  START_INDEX && !RESUME` only.
- **13:15 UTC.** Launched v1 regression on 2025-07 with `--block-chain`.
  Reset log showed worker archived 1 trade, cleared 5 KV keys, and
  deleted 3 rows from `trades` + 3 from `positions` + 2 from
  `account_ledger` — exactly the ghost state the previous run had left
  behind.
- **13:33 UTC.** v1 completed. 36 trades finalized.
- **13:37 UTC.** Launched v2 (determinism sanity check). Same inputs,
  same flags.
- **13:56 UTC.** v2 completed. 36 trades finalized — **identical** to
  v1 on every field (ticker, entry_ts, exit_ts, status, pnl_pct
  rounded to 4 dp).

## Deterministic parity

Per-session comparison (trade count, blocked_bars count):

| session | date | v1 trades | v1 blocked | v2 trades | v2 blocked |
|---:|---|---:|---:|---:|---:|
| 1 | 2025-07-01 | 5 | 1567 | 5 | 1567 |
| 2 | 2025-07-02 | 2 | 1407 | 2 | 1407 |
| 3 | 2025-07-03 | 0 | 1501 | 0 | 1501 |
| 4 | 2025-07-07 | 0 | 1501 | 0 | 1501 |
| 5 | 2025-07-08 | 2 | 1486 | 2 | 1486 |
| 6 | 2025-07-09 | 5 | 1144 | 5 | 1144 |
| … | (identical through session 22) | … | … | … | … |
| 22 | 2025-07-31 | 1 | 1567 | 1 | 1567 |

Trade-level diff (v1 vs v2): **0** trades only in v1, **0** only in v2,
**36** shared. Full determinism.

## Phase-C anchor vs clean baseline

| Metric | Phase C anchor (dirty) | Clean-slate baseline |
|---|---:|---:|
| Trades | 25 | **36** |
| WIN | 19 | 28 |
| LOSS | 6 | 8 |
| WR | 76.0 % | **77.8 %** |
| Big winners (≥ 5 %) | 2 | **5** |
| Sum `pnl_pct` | +26.05 % | **+109.06 %** |

Set diff at trade-key level (`(ticker, entry_ts)`):

- **7 Phase-C trades are absent from the clean run.** These were
  artefacts of ghost OPEN positions that survived into Phase C's replay
  scope from an earlier crashed run — they were entered-without-matching
  candles.
- **18 clean-run trades were missing from Phase C** for the mirror-image
  reason: those entries couldn't fire in Phase C because ghost OPEN
  positions were already sitting in the replay trade scope for the same
  tickers, and the entry path suppresses duplicates.
- **18 trades overlap exactly.**

## What the clean baseline looks like

| Exit reason | Count |
|---|---:|
| `mfe_proportional_trail` (R6) | 10 |
| `max_loss` | 4 |
| `replay_end_close` | 4 |
| `TP_FULL` | 4 |
| `hard_max_hold_168h` | 2 |
| `eod_trimmed_underwater_flatten` | 2 |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | 2 |
| `SOFT_FUSE_RSI_CONFIRMED`, `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`, `HARD_FUSE_RSI_EXTREME`, `PRE_EVENT_RECOVERY_EXIT`, `ST_FLIP_4H_CLOSE`, `PROFIT_GIVEBACK_STAGE_HOLD`, `sl_breached`, `PROFIT_GIVEBACK_COOLING_HOLD` | 1 each |

Note the **4 `replay_end_close`** trades: NVDA +43.82 %, PH +28.94 %,
GRNY +7.52 %, AMZN −11.21 %. These are real positions that stayed open
past Jul 31 and were force-closed by `close-replay-positions` at the
run boundary. They're not errors — they're the R6 MFE trail holding
runners longer than one month. Three out of four are big winners.

## Implication for Phase C artifacts on main

The Phase-C slice's `report.md` and `proposed_tuning.md` should be
treated as **diagnostic documents**, not numerical anchors. The actual
Phase-C parity baseline for 2025-07 going forward is
`phase-c-cleanslate-regression-v1`:

- **36 trades / 28 WIN / 8 LOSS / 77.8 % WR**
- **5 big winners (≥ 5 % pnl_pct):** AGQ +10.33, CDNS +5.61 (same as
  Phase C), **plus** NVDA +43.82, PH +28.94, GRNY +7.52.
- **Sum `pnl_pct` +109.06 %** (vs Phase C's reported +26.05).

This shifts several of the T-proposals in
`data/trade-analysis/phase-c-slice-2025-07-v1/proposed_tuning.md`:

- **T3 (block entries on ≥ 4-ticker earnings clusters):** the
  clean-run loss set still has RIOT, SGI, and the Jul 31 CDNS from
  the earnings-cluster anchor, plus **one additional** clear loser
  (AMZN −11.21 % via `replay_end_close`). T3 is still a legitimate
  candidate but the evidence is now stronger: 4 of 8 losses trace
  to the Jul 28–31 earnings window.
- **T6 (ETF pullback-depth relaxation):** unchanged. Still 1 XLY
  trade and 0 SPY/QQQ/IWM in this clean baseline, same structural
  problem documented in PR #7 / PR #6.
- **T1, T2, T5:** unchanged in direction; magnitudes need
  recomputation against the clean baseline before any proposal
  ships.

## Scope boundary

This PR lands only the orchestrator fix + the regression evidence. It
does NOT:

- Amend `data/trade-analysis/phase-c-slice-2025-07-v1/report.md` or
  `proposed_tuning.md`. Those stay as the historical Phase-C artifacts
  because they match the state produced by the then-deployed
  orchestrator. A follow-up can add a deprecation note pointing at
  this finding if desired.
- Re-run any other month. With 2025-07 now deterministic, Phase D can
  start the 2025-08 slice on the fixed orchestrator; all subsequent
  monthly baselines will be clean by construction.

## Provenance

- Branch: `phase-c/cleanslate-first-session-2e87`.
- Worker Version IDs at the time of both regression runs: default
  `eabc8dd2-d8db-4b45-9a79-282b360a49b5`, production
  `98998489-5a8b-455a-bb1c-44c8903f269c` (PR #8's deploy; worker code
  unchanged by this PR).
- Artifacts (git-ignored raw): `trades.json`, `trades.csv`,
  `slice.checkpoint.json`, `slice.progress.log`, `block_chain.jsonl`
  for both v1 and v2 runs.
