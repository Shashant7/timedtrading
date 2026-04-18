# Phase D slice — 2025-12 (run_id `phase-d-slice-2025-12-v1`)

## Envelope

- Window `2025-12-01 → 2025-12-31` (22 trading days, Dec 25 correctly dropped)
- Wall-clock ~14.5 min, 0 stalls
- Worker commit `a0ff32e`

## Backdrop

- Cycle `transitional` (HTF_BULL_LTF_BULL = 67 %, HTF_BEAR_LTF_BEAR = 24 %)
- SPY **+0.24 %** (essentially flat), realized vol 8.21 %
- **Zero earnings clusters**. Sparse macro (FOMC Dec 18).

## Headline

- **4 trades / 1 WIN / 3 FLAT / +67.86 % sum_pnl**
- TSLA +67.86 % (entry Dec 19, `replay_end_close`) — **fourth consecutive month** Tier-1 big winner
- 3 FLAT `RUNNER_STALE_FORCE_CLOSE` exits (AGQ/SWK/IESC) — positions that entered early December and never moved enough to exit, force-closed at Dec 31

## Per-trade ledger

| # | Ticker | Entry | Exit | Rank | PnL | Exit reason |
|---|---|---|---|---:|---:|---|
| 1 | AGQ | 2025-12-02 20:00 | 2025-12-31 17:30 | 91 | 0.00 % | `RUNNER_STALE_FORCE_CLOSE` |
| 2 | SWK | 2025-12-04 14:30 | 2025-12-31 17:30 | 94 | 0.00 % | `RUNNER_STALE_FORCE_CLOSE` |
| 3 | IESC | 2025-12-05 17:30 | 2025-12-31 20:35 | 90 | 0.00 % | `RUNNER_STALE_FORCE_CLOSE` |
| 4 | TSLA | 2025-12-19 18:00 | 2025-12-31 21:00 | 92 | **+67.86 %** | `replay_end_close` |

## Block-chain

| Cohort | Top blocker | Share |
|---|---|---:|
| Tier-1 ETF | `tt_pullback_not_deep_enough` | 43.1 % |
| Tier-1 stocks | `tt_bias_not_aligned` | **57.7 %** |
| Tier-2 | `tt_bias_not_aligned` | 49.4 % |

Transitional + low vol (December holiday week dominates): bias-alignment is again the dominant blocker. Same pattern as Nov.

## T-proposal tracking (6 months)

- **TSLA replay_end_close pattern: now 4 months in a row** (Jul PH/GRNY/NVDA, Oct TSLA +50, Nov TSLA +39, Dec TSLA +68). **TSLA alone has caught +156 % of sum_pnl across 3 months via the R6 trail + month-boundary force-close.** If we tune for a world where R6 is the primary winner-capture mechanism, this is a critical observation.
- **T5** (PRE_EVENT narrowing): 0 firings in Dec (nothing to fire on). 5-month total still 8 firings with the same 0-wins>+0.23% pattern. Strong signal.
- **T7** (EOW protective trail): Dec replay_end_close was 1W/0L (TSLA only). 8W/4L across 6 months now. **The win column is all Tier-1 runners.** T7 reframe: protect Tier-1 runners specifically at EOW, not all positions.
- **T11 NEW — `RUNNER_STALE_FORCE_CLOSE` investigation**: 3 firings in Dec, all on valid high-rank setups (rank 90–94) that simply never moved because Dec was a flat month (SPY +0.24 %). The rule's force-closing them at break-even is correct behaviour, but worth noting: these 3 positions sat on the book for 4 weeks tying up risk budget.

Phase-F signal re-confirmed: 6-month regime pattern (Nov 2, Dec 4 are the extreme bear/flat cases).

## Provenance

Branch `phase-d/slice-2025-12-2e87`, base `main@a0ff32e`.
