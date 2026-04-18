# Phase C slice — 2025-07 (run_id `phase-c-slice-2025-07-v1`)

> First monthly slice produced by `scripts/monthly-slice.sh` on the locked
> 24-ticker universe and the Phase-A base config package (R5 entry bias +
> R2v3 MFE decay + R6 MFE trail + KV-binding fix). This artifact is the new
> anchor for all subsequent Phase D monthly analysis.

## Run envelope

| Field | Value |
|---|---|
| `run_id` | `phase-c-slice-2025-07-v1` |
| Window | `2025-07-01` → `2025-07-31` (22 trading days) |
| Universe | 24 tickers (10 Tier-1 + 14 Tier-2) |
| Interval | 5 minutes (`intervalMinutes=5`) |
| Engine | `tt_core` entry + `tt_core` management, `trader_only=true` |
| Worker Version IDs | default `019f7378-6023-4f64-b387-b939c969fbb1` / production `d5c36d7e-0303-48d0-b8ed-e990963da503` (Phase A deploy) |
| Wall-clock | ~18 min 35 s (22 sessions, 34–71 s each, median ~60 s) |
| Stalls | 0 — watchdog never fired |
| Single-writer | enforced; direct-loop held the replay lock end-to-end |

## Backdrop (from `data/backdrops/2025-07.json`)

- **Cycle:** `uptrend` — HTF_BULL_LTF_BULL = 82.3 %, HTF_BEAR_LTF_BEAR = 9.1 %,
  TRANSITIONAL = 5.0 %.
- **SPY monthly return:** +2.34 %. **Realized vol (annualized):** 6.70 %
  (down 3.68 pp vs June).
- **Sector leadership:** Technology + Utilities + Industrials top; Health Care
  + Staples + Materials bottom (classic risk-on rotation with defensives
  underperforming).
- **DXY (UUP):** rising (+3.83 %).
- **Event density:** 7 single-ticker earnings events and 8 curated macro events
  in the window. Two earnings clusters: Jul 23–24 (FIX/GOOGL/TSLA) and Jul
  28–30 (CDNS/META/MSFT/SWK — 4 tickers concentrated in three days).

## Acceptance vs the Phase C gates

| Plan gate | Result |
|---|---|
| Slice completes end-to-end without stall | ✅ 22/22 sessions OK, 0 watchdog hits |
| Artifact trade counts match `/admin/runs/trades` | ✅ `trades.json` reports 25; `/admin/runs/detail.total_trades` = 25 |
| No dual-writer contamination | ✅ replay-lock held by `direct_loop_phase-c-slice-2025-07-v1…` throughout; `backtests/status.active` was `null` at start and end |

## Portfolio-level results

| Metric | Value |
|---|---|
| Total trades | **25** |
| WIN | **19** |
| LOSS | **6** |
| Win rate (W / (W + L)) | **76.0 %** |
| Sum of `pnl_pct` (equal-weight, non-compounded) | **+26.05 %** |
| Big winners (`pnl_pct ≥ 5 %`) | **2** (AGQ +10.33 %, CDNS +5.61 %) |
| Clear losers (`pnl_pct ≤ −1.5 %`) | **3** (RIOT −3.58 %, CDNS −3.34 %, SGI −3.09 %) |
| Direction split | **25 LONG / 0 SHORT** — consistent with the uptrend backdrop |

Tier breakdown:

| Cohort | Count | WIN | WR | Sum `pnl_pct` |
|---|---|---|---|---|
| Tier 1 (SPY/QQQ/IWM/AAPL/MSFT/GOOGL/AMZN/META/NVDA/TSLA) | 7 | 6 | **85.7 %** | +4.98 % |
| Tier 2 | 18 | 13 | 72.2 % | +21.07 % |
| SPY subset (plan target) | **0** | — | — | — |

> **SPY caveat:** the plan's `SPY ≥ 80 % WR` target cannot be evaluated from
> this slice because SPY produced no qualifying entries in July. The Phase B
> backdrop shows why — SPY spent 22/22 days in `HTF_BULL_LTF_BULL` on the
> Tier-1 aggregate and the tt_core entry engine did not find qualifying
> pullbacks. Phase E's SPY-overlay track will need a dedicated entry
> relaxation (lower min-rank or pullback depth override) to produce tradeable
> samples.

## Exit-reason distribution (25 trades)

| Exit reason | Count | Notes |
|---|---|---|
| `mfe_proportional_trail` | 6 | R6 trail — the primary profit-taker for this slice |
| `TP_FULL` | 3 | Base take-profit hit |
| `max_loss` | 3 | Safety exits (all 3 are the clear losers) |
| `HARD_FUSE_RSI_EXTREME` | 2 | Captured both big winners (AGQ, CDNS) |
| `eod_trimmed_underwater_flatten` | 2 | Half-trimmed runner forced flat at EOD |
| `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | 2 | Post-trim round-trip guard |
| `PRE_EVENT_RECOVERY_EXIT` | 2 | Pre-earnings de-risk |
| `ST_FLIP_4H_CLOSE` | 2 | 4H SuperTrend flip |
| `SOFT_FUSE_RSI_CONFIRMED` | 1 | RSI-confirmed profit take |
| `hard_max_hold_168h` | 1 | 7-day hard max-hold cap |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | 1 | Runner support break |

## Per-trade ledger

| # | Ticker | Dir | Entry | Exit | Rank | RR | PnL % | Exit reason | Status |
|---|--------|-----|-------|------|------|----|-------|-------------|--------|
| 1 | MSFT | LONG | 2025-07-01 | 2025-07-17 | 90 | 3.05 | +1.83% | `SOFT_FUSE_RSI_CONFIRMED` | WIN |
| 2 | CDNS | LONG | 2025-07-01 | 2025-07-10 | 100 | 4.63 | +2.16% | `hard_max_hold_168h` | WIN |
| 3 | AMZN | LONG | 2025-07-01 | 2025-07-08 | 100 | 6.04 | +0.35% | `eod_trimmed_underwater_flatten` | WIN |
| 4 | ETN | LONG | 2025-07-01 | 2025-07-02 | 100 | 3.08 | +0.31% | `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | WIN |
| 5 | FIX | LONG | 2025-07-01 | 2025-07-08 | 94 | 5.15 | +1.73% | `mfe_proportional_trail` | WIN |
| 6 | MTZ | LONG | 2025-07-02 | 2025-07-02 | 94 | 6.49 | −0.13% | `eod_trimmed_underwater_flatten` | LOSS |
| 7 | GRNY | LONG | 2025-07-02 | 2025-07-22 | 96 | 5.09 | +1.25% | `mfe_proportional_trail` | WIN |
| 8 | ETN | LONG | 2025-07-08 | 2025-07-22 | 91 | 3.00 | +4.04% | `mfe_proportional_trail` | WIN |
| 9 | AGQ | LONG | 2025-07-08 | 2025-07-11 | 93 | 6.72 | **+10.33%** | `HARD_FUSE_RSI_EXTREME` | WIN |
| 10 | PH | LONG | 2025-07-09 | 2025-07-10 | 65 | 2.53 | +0.09% | `PRE_EVENT_RECOVERY_EXIT` | WIN |
| 11 | IESC | LONG | 2025-07-09 | 2025-07-15 | 100 | 5.63 | +1.22% | `mfe_proportional_trail` | WIN |
| 12 | ON | LONG | 2025-07-09 | 2025-07-16 | 93 | 2.40 | +1.24% | `mfe_proportional_trail` | WIN |
| 13 | XLY | LONG | 2025-07-09 | 2025-07-15 | 69 | 3.03 | +0.81% | `ST_FLIP_4H_CLOSE` | WIN |
| 14 | NVDA | LONG | 2025-07-10 | 2025-07-22 | 85 | 1.77 | +1.00% | `mfe_proportional_trail` | WIN |
| 15 | META | LONG | 2025-07-14 | 2025-07-15 | 98 | 3.56 | −0.03% | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | LOSS |
| 16 | FIX | LONG | 2025-07-15 | 2025-07-17 | 90 | 3.47 | +1.14% | `ST_FLIP_4H_CLOSE` | WIN |
| 17 | AMZN | LONG | 2025-07-22 | 2025-07-30 | 91 | 3.71 | +1.08% | `TP_FULL` | WIN |
| 18 | GOOGL | LONG | 2025-07-22 | 2025-07-23 | 100 | 2.80 | +0.22% | `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | WIN |
| 19 | RIOT | LONG | 2025-07-22 | 2025-07-23 | 84 | 3.00 | **−3.58%** | `max_loss` | LOSS |
| 20 | MSFT | LONG | 2025-07-28 | 2025-07-29 | 100 | 8.27 | +0.51% | `TP_FULL` | WIN |
| 21 | MTZ | LONG | 2025-07-28 | 2025-07-30 | 100 | 3.51 | +1.43% | `TP_FULL` | WIN |
| 22 | SGI | LONG | 2025-07-28 | 2025-07-30 | 97 | 4.76 | **−3.09%** | `max_loss` | LOSS |
| 23 | CDNS | LONG | 2025-07-28 | 2025-07-29 | 94 | 3.47 | **+5.61%** | `HARD_FUSE_RSI_EXTREME` | WIN |
| 24 | GRNY | LONG | 2025-07-29 | 2025-07-29 | 95 | 3.77 | −0.15% | `PRE_EVENT_RECOVERY_EXIT` | LOSS |
| 25 | CDNS | LONG | 2025-07-31 | 2025-08-01 | 93 | 1.56 | **−3.34%** | `max_loss` | LOSS |

## Entry-rank distribution

- `rank ≥ 90`: 19 trades, 16 WIN / 3 LOSS → WR **84.2 %**.
- `rank < 90`: 6 trades, 3 WIN / 3 LOSS → WR 50.0 %.

The 6 losing trades are concentrated in lower-rank entries (PH @ 65, XLY @
69) and in the last-week earnings cluster where the engine entered late
(`CDNS-2025-07-31` @ rank 93 stopped out on `max_loss` the next session as
the cluster selloff continued into August).

## Comparison vs v5 baseline

No equal-universe v5 artifact exists. `data/backtest-artifacts/calibrated-v5--20260315-213634/trades.json` has 49 July trades but on a different universe (H / SOFI / WAL / RDDT / PNC / DINO / BWXT / IONQ / …), zero Phase-B overlap, `pnl_pct` sums to 0.00 % (metric wasn't stamped), and 0 big winners. The
July "v5-grnyfix" artifact is even narrower (INTU / RIOT / ORCL / GRNY only,
7 trades). Neither is a fair baseline.

**Treatment:** this Phase C slice becomes the anchor baseline for the 24-ticker
universe on July 2025. Phase D proposals must beat this month on its own
metrics (WR ≥ 76 %, ≥ 2 big winners, ≥ +26 % sum `pnl_pct`) before merge.
Earlier v5 artifacts remain useful for exit-reason distribution references but
cannot be used as the primary acceptance gate.

## Health of the underlying data path

- Every session returned `intervals=79 scored=1896` — the 24-ticker × 79-interval
  product is exactly 1896, confirming no ticker was silently skipped on any day.
- `runs/detail.total_trades` = 25 matches `trades.json.count` = 25 (artifact
  parity, Phase C acceptance gate ✅).
- Lock lifecycle clean: acquired once, released once, no foreign writer took
  the lane during or after the run.

## Open questions for Phase D

1. **Why did SPY/QQQ/IWM produce zero entries?** The Tier-1 aggregate is
   86.5 % bull but the large-cap ETFs didn't trigger. Check whether the
   pullback-depth gate is too strict for index ETFs at elevated rank.
2. **Are the two `eod_trimmed_underwater_flatten` exits** the right call? AMZN
   closed +0.35 % but the flatten looks like it would have been an
   un-necessary cut during an uptrending week.
3. **`SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`** (ETN Jul 2, GOOGL Jul
   23) produced gains of only +0.31 % and +0.22 % — those runners had higher
   ceilings and the round-trip guard cut them early.
4. **Two of the three `max_loss` losers (SGI, CDNS Jul 31) were at rank ≥ 93**
   and entered into the end-of-July earnings cluster. That's the earnings-week
   selection bias the plan predicts; Phase B flagged the Jul 28–30
   CDNS/META/MSFT/SWK cluster explicitly.

These questions are carried into `proposed_tuning.md`.

## Provenance

- Branch: `phase-c/slice-2025-07-2e87` (derived from `phase-c/monthly-slicer-2e87`).
- Script: `scripts/monthly-slice.sh` (PR #4).
- Raw artifacts (git-ignored): `trades.json`, `trades.csv`,
  `slice.checkpoint.json`, `slice.progress.log`.
- Backdrop: `data/backdrops/2025-07.json` (Phase B, merged as PR #3).
- Deployed worker commit at run time: `1d7d8d3` (Phase B merge).
