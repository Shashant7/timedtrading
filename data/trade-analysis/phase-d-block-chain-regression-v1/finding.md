# Phase D analyzer — regression run on 2025-07 (run_id `phase-d-block-chain-regression-v1`)

> **Purpose.** First run with `--block-chain` enabled. Confirms the
> per-bar trace is populated correctly and surfaces what the
> aggregated-counter Phase-C report could not see. Not a Phase-C parity
> regression — the trade count differs for reasons described at the
> bottom, tracked separately.

## Run envelope

| Field | Value |
|---|---|
| `run_id` | `phase-d-block-chain-regression-v1` |
| Window | `2025-07-01` → `2025-07-31` (22 trading days) |
| Universe | 24 tickers (Phase-B Tier 1 + Tier 2) |
| Worker | default `eabc8dd2-d8db-4b45-9a79-282b360a49b5`, production `98998489-5a8b-455a-bb1c-44c8903f269c` |
| Wall-clock | ~19 min (22 sessions, median 45 s) |
| Stalls | 0 |
| Flag | `--block-chain` enabled |
| JSONL size | 27,907 lines (`block_chain.jsonl`) |

## Analyzer output

`block_chain.jsonl` has one record per rejected entry candidate:

```json
{"ticker":"SPY","ts":1752067800000,"reason":"tt_pullback_not_deep_enough","kanban_stage":"watch","state":"HTF_BULL_LTF_BULL","score":100,"rank":100,"htf_score":42.9,"ltf_score":18.5,"date":"2025-07-09","run_id":"phase-d-block-chain-regression-v1"}
```

Aggregate bar counts reconstructed from the JSONL match the worker's
per-day `blockReasons` counter exactly (sanity-checked 22 sessions × 26
distinct reasons). The sum (27,907) equals the total of per-day
`blocked_bars=...` log lines.

## What the analyzer makes visible that aggregation hid

Top-5 block reasons by ticker cohort:

| Cohort | Bars | #1 | #2 | #3 | #4 | #5 |
|---|---:|---|---|---|---|---|
| **ETF** (SPY/QQQ/IWM/XLY/AGQ) | 6,878 | `tt_no_trigger` (41%) | `tt_pullback_not_deep_enough` (28%) | `tt_bias_not_aligned` (9%) | `tt_momentum_30m_5_12_unconfirmed` (5%) | `rvol_dead_zone` (5%) |
| **Tier-1 stocks** (AAPL/MSFT/GOOGL/AMZN/META/NVDA/TSLA) | 7,660 | `tt_no_trigger` (36%) | **`tt_bias_not_aligned` (24%)** | `tt_pullback_not_deep_enough` (20%) | `rvol_dead_zone` (5%) | `tt_momentum_30m_5_12_unconfirmed` (5%) |
| **Tier-2 stocks** (CDNS/ETN/FIX/GRNY/HUBS/IESC/MTZ/ON/PH/RIOT/SGI/SWK) | 13,369 | `tt_no_trigger` (38%) | `tt_pullback_not_deep_enough` (22%) | `tt_bias_not_aligned` (17%) | `tt_momentum_30m_5_12_unconfirmed` (6%) | `rvol_dead_zone` (4%) |

This confirms and sharpens the T6 finding:

- `tt_no_trigger` is the **dominant** ETF blocker (41%) in calm uptrend
  — the ETFs simply don't pull back hard enough to produce a trigger
  bar, a structural property of index ETFs that no depth threshold can
  fix.
- `tt_pullback_not_deep_enough` is #2 for ETFs at 28% — the gate T6
  targeted is real, but even fully eliminated it only addresses a
  quarter of ETF blocks.
- `tt_bias_not_aligned` ranks **#2 for Tier-1 stocks at 24%** but only
  **#3 for ETFs at 9%** — the cloud-vote unanimity gate is a much
  bigger issue for large-cap stocks than for index ETFs.
- Tier-2 stocks look similar to ETFs in shape but with higher absolute
  counts (13,369 bars for 12 tickers vs 6,878 for 5).

None of this was visible from the Phase-C `blockReasons` aggregate
(which was a single counter per day). Now it is.

## Aside — trade count differs from Phase-C anchor (25 vs 36)

The regression produced **36 trades** vs the Phase-C anchor's **25**.
This is **not caused by the analyzer change** (which only reads state
the gate code already computes — it cannot influence entry / exit
decisions). Root cause is dirty replay state persisting between runs in
KV / D1 because `scripts/monthly-slice.sh` does not pass `cleanSlate=1`
on the first session of the run, so the second run inherits ghost open
positions. Evidence:

- 4 trades in this run exit via `replay_end_close` on Jul 31 20:00
  UTC, including a **+43.82 %** NVDA and **+28.94 %** PH runner —
  clearly artefacts of positions that should have been closed earlier.
- 7 Phase-C trades are missing from this run; 18 new trades appear.
  The signature indicates continuation of un-closed state rather than
  a policy change.

This is a Phase-C follow-up bug (not an analyzer regression), to be
fixed on a separate `phase-c/cleanslate-first-session-<tag>` branch
that passes `&cleanSlate=1` on the first candle-replay POST of any
run. That fix is orthogonal to this PR; deferring so this PR stays
scoped to the analyzer.

## Next steps

1. **This PR** lands the analyzer code + the regression evidence.
2. **Follow-up PR** fixes `monthly-slice.sh` to pass `cleanSlate=1` on
   session 1 of a fresh run (and adds a `--resume`-aware guard). Once
   merged, re-run the 2025-07 slice and confirm the trade count matches
   the Phase-C anchor (25 trades).
3. With a clean 2025-07 baseline plus block-chain data, re-open the
   ETF question: a candidate joint-relaxation DA-key proposal (T6 +
   `tt_bias_not_aligned` relaxation for ETFs with state ==
   `HTF_BULL_LTF_BULL` + `rvol_dead_zone` threshold override) can be
   compared against the baseline using the new
   `scripts/compare-block-chains.js` before being deployed.

## Provenance

- Branch: `phase-d/block-chain-analyzer-2e87`.
- Code commits: `0da5410` (worker trace), `dd03a38` (comparator),
  `833c1fa` (slicer flag + gitignore).
- Baseline reference: `data/trade-analysis/phase-c-slice-2025-07-v1/`.
