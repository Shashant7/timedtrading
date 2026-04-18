# Phase D slice — 2025-10 (run_id `phase-d-slice-2025-10-v1`)

> Fourth observation baseline. No DA-keys changed. Compact format
> going forward — depth goes into the cross-month synthesis PR once
> all 10 months are in.

## Envelope

| Field | Value |
|---|---|
| Window | `2025-10-01 → 2025-10-31` (23 trading days) |
| Wall-clock | ~14 min, 0 stalls, 0 dual-writer events |
| Worker | commit `a0ff32e` (default `eabc8dd2`, production `98998489`) |
| Block-chain artifact | 40,461 records |

## Backdrop

- Cycle `transitional` (HTF_BULL_LTF_BULL = 63 %, HTF_BEAR_LTF_BEAR = 22 %).
- SPY +2.04 %, realized vol **14.07 %** (highest so far).
- Sector leadership: Technology only (XLK +3.6 %); everything else red vs SPY.
- **Heaviest earnings month so far:** 15 events, 5 clusters. Oct 29 is an 8-ticker mega-cluster (AAPL/AMZN/CDNS/GOOGL/META/MSFT/MTZ/RIOT) with 7 overlapping on Oct 30.
- Macro: NFP / CPI / PPI / GDP Q3 Advance / PCE. **No FOMC** (next FOMC is Nov 7).

## Headline

| Metric | 2025-10 | 2025-09 | 2025-08 | 2025-07 clean |
|---|---:|---:|---:|---:|
| Trades | **16** | 28 | 15 | 36 |
| WIN / LOSS | 8 / 7 | 13 / 15 | 10 / 5 | 28 / 8 |
| Win rate | **53.3 %** | 46.4 % | 66.7 % | 77.8 % |
| Big winners (≥ 5 %) | **2** | 3 | 2 | 5 |
| Clear losers (≤ −1.5 %) | 2 | 6 | 1 | 3 |
| Sum `pnl_pct` | **+56.42 %** | +6.48 % | +53.82 % | +109.06 % |

Oct recovers from Sep's collapse. 2 big winners — notably **TSLA +50.14 %** (the first Tier-1 stock big winner in four months; entered Oct 27 via TT pullback, held through month-end via `replay_end_close`). AGQ contributed a second +9.41 %.

## Cohort

| Cohort | n | WR | Sum PnL |
|---|---:|---:|---:|
| Tier 1 stocks | 2 (AAPL 0.0 %, **TSLA +50.14 %**) | 100 % | +50.14 % |
| Tier 1 ETF (SPY/QQQ/IWM) | 0 | — | — |
| Tier 2 | 14 | 50.0 % | +6.28 % |

First Tier-1 stock trades since July. SPY/QQQ/IWM continue to produce zero (same structural block).

## Big winners & clear losers

| Category | Ticker | Entry | PnL | Exit |
|---|---|---|---:|---|
| Big | TSLA | 2025-10-27 | **+50.14 %** | `replay_end_close` |
| Big | AGQ | 2025-10-21 | +9.41 % | `ST_FLIP_4H_CLOSE` |
| Clear | FIX | 2025-10-22 | −2.69 % | `max_loss` |
| Clear | GRNY | 2025-10-28 | −1.95 % | `replay_end_close` |

## T-proposal tracking (4 months of data)

### T5 — `PRE_EVENT_RECOVERY_EXIT` narrowing

Oct only fired 1 time (AGQ Oct 30, +0.23 %). Still the "tiny-profit exit on minor event" pattern.

4-month total: **8 firings**, cumulative PnL ≈ −0.09 %. No wins > +0.23 %. **Signal is strong.** Candidate ready for `phase-d/t5-preevent-narrow-*` experiment on a dedicated branch.

### T7 — EOW protective trail

4-month `replay_end_close`:
- Jul 3W/1L (clean)
- Aug 2W/1L
- Sep 1W/1L
- Oct 1W/1L (TSLA +50.14 / GRNY −1.95)

7 wins / 4 losses total. TSLA +50 dominates by PnL (avg win pulled up by the outlier). **Pattern moved from "obvious net positive" to "pnl-positive but evenly split on count."** T7 is losing viability as a pure EOW rule; the signal now is more "protect winners late in the window" than "block all EOW exposure."

### T3 — Earnings-cluster entry block

Oct finally has **heavy cluster evidence** (5 clusters inc. the 8-ticker Oct 29). Trades that entered during/adjacent to clusters:

- Oct 22 FIX (cluster anchor): +0.28 % SMART_RUNNER exit
- Oct 22 FIX (day 2 of cluster): **−2.69 % max_loss** ← T3 target
- Oct 28 MTZ (day before Oct 29 mega-cluster): −0.34 % PRE_EARNINGS_FORCE_EXIT
- Oct 28 GRNY: **−1.95 % replay_end_close** ← T3 target
- Oct 30 MTZ: −1.23 % max_loss
- Oct 30 AGQ: +0.23 % PRE_EVENT_RECOVERY_EXIT

**3 of 6 cluster-window entries lost or flat.** T3 signal remains consistent with Jul/Aug — entries during cluster windows are asymmetrically bad.

### T8 — Pre-FOMC block

Oct had no FOMC. Next data point is Nov (FOMC Nov 7).

### T9 — Regime-conditional entry engine

Oct adds to the pattern: high-vol transitional → 16 trades, 53 % WR. Consistent with Aug (high-vol transitional, 15/66). The trade count is low in transitional months regardless of vol. Phase F candidate.

## Provenance

Branch `phase-d/slice-2025-10-2e87`, base `main@a0ff32e`.
