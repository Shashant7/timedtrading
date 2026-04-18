# Phase D slice — 2025-08 (run_id `phase-d-slice-2025-08-v1`)

> Second monthly slice. First produced on the deterministic
> orchestrator (PR #9 cleanSlate fix) with the Phase-D block-chain
> analyzer (PR #8) enabled. This is an **observation baseline** — no
> DA-keys are changed in this PR. Its acceptance gate is just
> "deterministic run completed end-to-end"; the numbers themselves
> become the locked 2025-08 anchor against which future Phase-D / F
> DA-key proposals are measured.

## Run envelope

| Field | Value |
|---|---|
| `run_id` | `phase-d-slice-2025-08-v1` |
| Window | `2025-08-01` → `2025-08-31` (21 trading days) |
| Universe | 24 tickers (10 Tier-1 + 14 Tier-2) |
| Interval | 5 minutes |
| Engine | `tt_core` entry + `tt_core` management, trader_only |
| Worker Version IDs | default `eabc8dd2-d8db-4b45-9a79-282b360a49b5`, production `98998489-5a8b-455a-bb1c-44c8903f269c` |
| Wall-clock | ~13 min 40 s |
| Stalls | 0 |
| Single-writer | enforced (direct-loop lock held end-to-end) |
| Clean-slate reset | ran — archived 1 trade + deleted 3 ghost open rows in D1 |
| Block-chain artifact | `block_chain.jsonl` 35,978 records |

## Backdrop (from `data/backdrops/2025-08.json`)

- **Cycle:** `transitional` — HTF_BULL_LTF_BULL = 63 %, HTF_BEAR_LTF_BEAR = 20 %, TRANSITIONAL = 10 %. Step down from Jul's 82 % bull fraction.
- **SPY monthly return:** +3.75 %. **Realized vol (annualized):** 10.4 % (up 3.7 pp vs Jul's 6.7 %).
- **Sector leadership:** Consumer Discretionary + Materials + Energy top; Utilities + Consumer Staples + Industrials bottom. Note the rotation — Jul's Technology leadership ceded to cyclicals.
- **DXY (UUP):** falling.
- **Earnings cluster:** 2025-08-04 → 08-07 anchor, up to 5 Phase-B tickers (ETN, HUBS, ON, PH, SGI) reporting inside a 3-day window.

## Headline numbers

| Metric | 2025-08 (this slice) | 2025-07 clean baseline | Delta |
|---|---:|---:|---:|
| Trades | **15** | 36 | −21 |
| WIN | 10 | 28 | −18 |
| LOSS | 5 | 8 | −3 |
| Win rate | **66.7 %** | 77.8 % | −11.1 pp |
| Big winners (`pnl_pct ≥ 5`) | **2** | 5 | −3 |
| Clear losers (`pnl_pct ≤ −1.5`) | 1 | 3 | −2 |
| Sum `pnl_pct` | **+53.82 %** | +109.06 % | −55.24 pp |
| Direction | 15 LONG / 0 SHORT | 36 LONG / 0 SHORT | — |

Tier breakdown:

| Cohort | n | WIN | WR | Sum `pnl_pct` |
|---|---:|---:|---:|---:|
| Tier 1 (SPY/QQQ/IWM/AAPL/MSFT/GOOGL/AMZN/META/NVDA/TSLA) | 2 | 1 | 50.0 % | +2.31 % |
| Tier 2 | 13 | 9 | 69.2 % | +51.52 % |
| SPY subset | **0** | — | — | — |
| QQQ subset | **0** | — | — | — |
| IWM subset | **0** | — | — | — |

Aug is a much thinner month: fewer entries, lower WR, fewer big winners. The backdrop (transitional cycle with +3.7 pp vol expansion) and earnings cluster are consistent with the softer output. The slice is a real, clean result.

## Big winners

- **AGQ +35.47 %** — LONG entry 2025-08-25, held through month-end, force-closed by `replay_end_close`. Silver ETF catching a metals rotation during the weakening DXY backdrop.
- **SGI +18.16 %** — LONG entry 2025-08-25, also `replay_end_close` at Jul-31. The R6 MFE trail held this runner for the final 4 sessions of Aug.

Both winners are **sector/commodity ETFs + small-cap industrials** — exactly the tickers the T6 ETF-gate probe would not help (AGQ / XLY get through current gates when volatility is elevated; SPY / QQQ / IWM still can't satisfy `tt_pullback_not_deep_enough`).

## Clear losers

- **XLY −7.23 %** — LONG entry 2025-08-28, `replay_end_close` at Jul-31 after one session. Weak-into-close entry; the runner never matured.

Only one clear loser. The other 4 LOSS trades are all in the −0.1 % to −0.75 % range — a marginal "flat-ish exit" cohort driven by `eod_trimmed_underwater_flatten`, `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`, `PRE_EARNINGS_FORCE_EXIT`, `PRE_EVENT_RECOVERY_EXIT`. These are the management layer doing its job, trimming near-breakeven setups.

## Exit-reason distribution

| Exit reason | Count |
|---|---:|
| `replay_end_close` (force-closed at window boundary) | 3 |
| `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | 2 |
| `eod_trimmed_underwater_flatten` | 2 |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | 2 |
| `max_loss` | 1 |
| `PRE_EARNINGS_FORCE_EXIT` | 1 |
| `HARD_FUSE_RSI_EXTREME` | 1 |
| `mfe_proportional_trail` (R6) | 1 |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 1 |
| `PRE_EVENT_RECOVERY_EXIT` | 1 |

R6 only fired once this month. That's a regime-specific observation — in a transitional month runners either stop out earlier (smart runner + ST flip) or need the window-boundary `replay_end_close` to realize their gains. Not enough signal to conclude R6 is under- or over-tuned in this regime; revisit once Sep + Oct + Nov are in.

## Per-trade ledger

| # | Ticker | Dir | Entry | Exit | Rank | RR | PnL % | Exit reason | Status |
|---|--------|-----|-------|------|------|----|-------|-------------|--------|
| 1 | NVDA | LONG | 2025-08-01 16:20 | 2025-08-20 13:45 | 95 | 3.34 | +2.35% | `max_loss` | WIN |
| 2 | CDNS | LONG | 2025-08-04 14:00 | 2025-08-05 14:30 | 100 | 2.91 | +0.01% | `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | WIN |
| 3 | SGI | LONG | 2025-08-05 16:30 | 2025-08-06 13:30 | 100 | 5.44 | −0.72% | `PRE_EARNINGS_FORCE_EXIT` | LOSS |
| 4 | META | LONG | 2025-08-06 15:20 | 2025-08-07 19:30 | 59 | 2.46 | −0.04% | `eod_trimmed_underwater_flatten` | LOSS |
| 5 | GRNY | LONG | 2025-08-06 15:40 | 2025-08-07 18:10 | 100 | 4.85 | +0.25% | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | WIN |
| 6 | XLY | LONG | 2025-08-12 15:50 | 2025-08-21 13:40 | 76 | 2.93 | +0.52% | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | WIN |
| 7 | SGI | LONG | 2025-08-12 17:00 | 2025-08-13 18:30 | 100 | 4.36 | +2.60% | `HARD_FUSE_RSI_EXTREME` | WIN |
| 8 | PH | LONG | 2025-08-13 16:50 | 2025-08-14 13:45 | 65 | 2.23 | −0.09% | `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | LOSS |
| 9 | SGI | LONG | 2025-08-14 19:00 | 2025-08-21 14:40 | 91 | 2.87 | +0.95% | `mfe_proportional_trail` | WIN |
| 10 | SWK | LONG | 2025-08-18 13:45 | 2025-08-20 19:30 | 87 | 2.64 | +0.60% | `eod_trimmed_underwater_flatten` | WIN |
| 11 | AGQ | LONG | 2025-08-25 13:50 | 2025-08-31 20:00 | 94 | 5.96 | **+35.47%** | `replay_end_close` | WIN |
| 12 | SGI | LONG | 2025-08-25 14:30 | 2025-08-31 20:00 | 93 | 2.09 | **+18.16%** | `replay_end_close` | WIN |
| 13 | FIX | LONG | 2025-08-25 18:30 | 2025-08-29 14:40 | 70 | 5.17 | +1.08% | `PROFIT_GIVEBACK_STAGE_HOLD` | WIN |
| 14 | SWK | LONG | 2025-08-27 18:50 | 2025-08-29 13:30 | 79 | 3.41 | −0.08% | `PRE_EVENT_RECOVERY_EXIT` | LOSS |
| 15 | XLY | LONG | 2025-08-28 19:20 | 2025-08-31 20:00 | 66 | 2.44 | **−7.23%** | `replay_end_close` | LOSS |

## ETF entry-gate analysis (answering "is SPY/QQQ/IWM actually enabled?")

**Yes, they are.** All five pinned-config blacklists are empty in this run (`deep_audit_ticker_blacklist`, `entry_ticker_blacklist`, `doa_gate_ticker_blacklist`) and the SPY directional gate is off (`tt_spy_directional_gate = "false"`). SPY reaches `kanban_stage=in_review` with `score=100` every day — it's actively being considered for entry.

The entry-gate chain blocks every SPY/QQQ/IWM candidate bar for the whole month:

| Ticker | Bars blocked | Max score | Top 3 block reasons |
|---|---:|---:|---|
| **SPY** | 1,659 | 100 | `tt_pullback_not_deep_enough` (75%), `tt_bias_not_aligned` (22%), `tt_no_trigger` (3%) |
| **QQQ** | 1,659 | 100 | `tt_pullback_not_deep_enough` (76%), `tt_bias_not_aligned` (16%), `tt_no_trigger` (7%) |
| **IWM** | 1,659 | 81 | `tt_bias_not_aligned` (90%), `da_short_rank_too_low` (10%) |
| **XLY** | 1,043 | 100 | `tt_bias_not_aligned` (31%), `tt_pullback_not_deep_enough` (23%), `tt_no_trigger` (22%) |
| **AGQ** | 1,268 | 100 | `tt_bias_not_aligned` (54%), `tt_no_trigger` (16%), `rvol_dead_zone` (14%) |

Consistent with the Jul 2025 finding and the T6 post-mortem (PR #7):

1. **`tt_pullback_not_deep_enough`** dominates SPY/QQQ — the gate requires **2 of 3** SuperTrends (15m/30m/1H) to have flipped bearish before a pullback counts as "deep enough". Large-cap index ETFs in a transitional backdrop rarely satisfy 2-of-3 simultaneously.
2. **`tt_bias_not_aligned`** dominates IWM + ranks #2 on the others — the cloud-vote unanimity gate (daily/4H/1H/10m clouds must all agree). Aug's transitional backdrop breaks the alignment frequently.
3. Everything else is tail noise. The binding constraint on ETF entries is **gates 1 and 2 together**, not either one alone.

## Cross-month block-chain deltas

From `compare-block-chains.js` (Jul cleanSlate regression → Aug slice):

| Reason | Jul | Aug | Delta |
|---|---:|---:|---:|
| `tt_bias_not_aligned` | 4,686 | 14,231 | **+9,545** |
| `tt_pullback_not_deep_enough` | 6,542 | 8,791 | +2,249 |
| `tt_no_trigger` | 10,856 | 8,630 | −2,226 |
| `rvol_dead_zone` | 1,388 | 368 | −1,020 |
| `tt_pullback_non_prime_rank_selective` | 973 | 332 | −641 |
| `tt_short_pullback_not_deep_enough` | 418 | 996 | +578 |
| `da_short_rank_too_low` | 264 | 576 | +312 |

(Note: the transition matrix section of that comparator is not meaningful month-over-month — bars are keyed on `(ticker, ts)` and timestamps don't overlap. Only the net reason deltas section is useful for cross-month reads.)

Regime-aware reading:

- **`tt_bias_not_aligned` 3× larger in Aug than Jul** — the defining feature of Aug's transitional backdrop is cloud-vote disagreement. That's ~9.5k more bars gated out on that single rule.
- **`tt_no_trigger` down 2.2k** — ETFs *did* pull back more in Aug; more trigger bars emitted. The blocker shifted from "no pullback" (Jul) to "bias disagreement on the pullback" (Aug).
- **Short-side gates up** (`tt_short_pullback_not_deep_enough` +578, `da_short_rank_too_low` +312) — Aug's mixed backdrop produced valid short-side candidates that the current (tuned-for-bull) short config rejected. This is consistent with 0 SHORT trades booked.

## Acceptance

Per the plan, the month's acceptance gate is whether the slice ran end-to-end cleanly — PASS on all counts:

- Slice completed 21/21 sessions without stall.
- Zero dual-writer events; direct-loop lock held throughout.
- Artifact trade counts match between `trades.json` (15) and `/admin/runs/detail.total_trades` (15).
- `block_chain.jsonl` aggregates reconstruct exactly to the worker's per-day `blockReasons` counters.
- Deterministic: the v2 re-run of 2025-07 on the fixed orchestrator produced bit-identical output (established in PR #9); same orchestrator version was used here.

## Open questions for later months

1. **Is Aug's 15-trade / 66.7 % WR representative of transitional months?** Need Sep to confirm — if Sep is also transitional with similar output, we have evidence that tt_core's bias-alignment + pullback-depth gates are too tight for transitional regimes specifically. If Sep is flat and Aug is the outlier, transitional months are just hard.
2. **Does R6 fire more in high-vol months?** Only 1 `mfe_proportional_trail` exit in Aug vs 10 in Jul clean. Could be a runner-preservation regime artefact (Aug runners hit earlier smart-runner exits before R6 can engage) or a realized-vol threshold issue. Needs cross-month data.
3. **Short-side configuration** — Aug booked 0 SHORT trades despite 996 `tt_short_pullback_not_deep_enough` + 576 `da_short_rank_too_low` blocks. When the backdrop rotates to `distribution` or `downtrend` (e.g. Nov 2025), do these gates structurally block the short-side entirely?
4. **SPY/QQQ/IWM joint-gate relaxation** — Aug confirms the Jul T6 finding: the binding constraint is `tt_pullback_not_deep_enough` AND `tt_bias_not_aligned` together. A coherent ETF proposal needs to address both. Candidate Phase-D/F experiment, deferred.

These get picked up in `proposed_tuning.md`.

## Provenance

- Branch: `phase-d/slice-2025-08-2e87`.
- Script: `scripts/monthly-slice.sh --month=2025-08 --run-id=phase-d-slice-2025-08-v1 --label=phase-d-slice-2025-08-v1 --block-chain`.
- Baseline reference: `data/trade-analysis/phase-c-cleanslate-regression-v1/` (Jul 2025 clean baseline) and `data/backdrops/2025-08.json` (backdrop).
- Deployed worker at run time: commit `a0ff32e` (post PR #9 merge).
