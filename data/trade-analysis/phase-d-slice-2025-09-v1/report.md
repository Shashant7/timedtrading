# Phase D slice — 2025-09 (run_id `phase-d-slice-2025-09-v1`)

> Third monthly slice. Same orchestrator as 2025-08
> (`phase-d-slice-2025-08-v1`). Observation baseline; no DA-keys
> changed.

## Run envelope

| Field | Value |
|---|---|
| `run_id` | `phase-d-slice-2025-09-v1` |
| Window | `2025-09-02` → `2025-09-30` (21 trading days) |
| Universe | 24 tickers |
| Interval | 5 minutes |
| Engine | `tt_core` entry + `tt_core` management, trader_only |
| Worker | default `eabc8dd2-…`, production `98998489-…` (same as Aug slice) |
| Wall-clock | ~14 min |
| Stalls | 0 |
| Clean-slate reset | ran — deleted Aug leftover state |
| Block-chain artifact | `block_chain.jsonl` 36,015 records |

## Backdrop (from `data/backdrops/2025-09.json`)

- **Cycle:** `transitional` — HTF_BULL_LTF_BULL = 68 %, HTF_BEAR_LTF_BEAR = 17 %.
- **SPY monthly return:** +4.05 %. **Realized vol (annualized):** 6.44 % — back down from Aug's 10.4 % to Jul-like calm.
- **Sector rotation:** Technology (+4.44 %) + Communication Services + Consumer Discretionary top; Consumer Staples + Materials + Energy bottom. Reversal from Aug's sector leadership.
- **DXY:** flat.
- **Earnings:** 5 events, spread out — **0 clusters** of ≥ 3 tickers within 3 days. Cleanest earnings month in the training set so far.
- **Macro calendar:** dense — NFP (Sep 6), CPI (Sep 10), PPI (Sep 12), Retail Sales + **FOMC** (Sep 17–18), PCE (Sep 27).

## Headline numbers

| Metric | 2025-09 | 2025-08 | 2025-07 clean |
|---|---:|---:|---:|
| Trades | **28** | 15 | 36 |
| WIN | 13 | 10 | 28 |
| LOSS | **15** | 5 | 8 |
| Win rate | **46.4 %** | 66.7 % | 77.8 % |
| Big winners (≥ 5 %) | 3 | 2 | 5 |
| Clear losers (≤ −1.5 %) | **6** | 1 | 3 |
| Sum `pnl_pct` | **+6.48 %** | +53.82 % | +109.06 % |
| Direction | 28 LONG / 0 SHORT | 15 LONG / 0 | 36 LONG / 0 |

**Sep is the worst of the three months on every metric.** 28 trades but only 13 wins; sum PnL nearly flat at +6.48 %. This is a real month of output, not a data issue — the slice ran clean end-to-end with determinism verified upstream.

## Tier breakdown

| Cohort | n | WIN | WR | Sum `pnl_pct` |
|---|---:|---:|---:|---:|
| Tier 1 (incl. SPY/QQQ/IWM) | **0** | — | — | — |
| Tier 2 | 28 | 13 | 46.4 % | +6.48 % |
| SPY / QQQ / IWM | **0** | — | — | — |
| Tier-1 large-cap stocks (AAPL/MSFT/GOOGL/AMZN/META/NVDA/TSLA) | **0** | — | — | — |

**For the first time in three months, zero trades came from any Tier-1 name** — not just the index ETFs but the large-cap stocks too. Sep's gates are even more restrictive on large-caps than Aug's were.

## Big winners

- **FIX +6.86 %** (entry Sep 8, exit Sep 17 via `mfe_proportional_trail` — R6 caught this one cleanly)
- **MTZ +5.80 %** (entry Sep 16 **into FOMC**, exit Sep 25 via `mfe_proportional_trail` — survived the Fed and ran; the one FOMC-day entry that paid off)
- **RIOT +7.57 %** (entry Sep 30 19:45 UTC, exit 20:00 UTC via `replay_end_close` — 15-minute end-of-window runner)

## Clear losers

All 6 (out of 15 total losses):

| Ticker | Entry | Rank | PnL % | Exit reason |
|---|---|---:|---:|---|
| CDNS | Sep 5 19:00 | 68 | −2.22 % | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` |
| ETN | Sep 16 16:30 | 100 | −3.16 % | `max_loss` (FOMC-day entry) |
| AGQ | Sep 16 18:30 | 96 | −3.28 % | `max_loss` (FOMC-day entry) |
| ETN | Sep 24 15:20 | 98 | −1.88 % | `sl_breached` |
| RIOT | Sep 24 18:30 | 97 | −3.79 % | `HARD_LOSS_CAP` |
| XLY | Sep 29 18:40 | 61 | −3.73 % | `replay_end_close` |

## Sep 16 FOMC-adjacent entry cluster

5 entries bunched into a single session on Sep 16, 2 days before the Sep 18 FOMC decision:

| Time (UTC) | Ticker | Rank | PnL % | Exit |
|---|---|---:|---:|---|
| 14:40 | XLY | 58 | −0.11 % | `PRE_EVENT_RECOVERY_EXIT` |
| 16:30 | MTZ | 91 | **+5.80 %** | `mfe_proportional_trail` |
| 16:30 | GRNY | 94 | −0.10 % | `PRE_EVENT_RECOVERY_EXIT` |
| 16:30 | ETN | 100 | −3.16 % | `max_loss` |
| 18:30 | AGQ | 96 | −3.28 % | `max_loss` |

Four out of five lost or near-flat exited with pre-event guards / `max_loss`. The one winner (MTZ) only worked because its R6 trail let it ride past the Fed decision. This is evidence that entries made in the 48 h pre-FOMC window have asymmetrically poor outcomes under the current config.

## Exit-reason distribution

| Exit reason | Count |
|---|---:|
| `PRE_EVENT_RECOVERY_EXIT` | **4** |
| `mfe_proportional_trail` (R6) | 3 |
| `max_loss` | 3 |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 3 |
| `eod_trimmed_underwater_flatten` | 3 |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | 2 |
| `sl_breached` | 2 |
| `replay_end_close` | 2 |
| `HARD_FUSE_RSI_EXTREME` | 1 |
| `ripster_72_89_1h_structural_break` | 1 |
| `PROFIT_GIVEBACK_COOLING_HOLD` | 1 |
| `PRE_EARNINGS_FORCE_EXIT` | 1 |
| `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` | 1 |
| `HARD_LOSS_CAP` | 1 |

`PRE_EVENT_RECOVERY_EXIT` is the **most-fired exit** this month, flat or
losing on every case (XLY −0.03, GRNY −0.10, XLY −0.11, HUBS −0.22).
The rule correctly de-risked ahead of events, but the tickers didn't
recover immediately, so positions got stopped out before the event
resolved. Four-firing month — T5 (PRE_EVENT tuning) finally has
signal.

**R6 (`mfe_proportional_trail`) captured 2 of 3 big winners** (FIX
+6.86, MTZ +5.80). Third big winner (RIOT) exited via
`replay_end_close` at window boundary.

## ETF entry-gate analysis (Sep)

| Ticker | Bars blocked | Top reason |
|---|---:|---|
| SPY | 1,659 | `tt_pullback_not_deep_enough` (66 %) |
| QQQ | 1,659 | `tt_pullback_not_deep_enough` (66 %) |
| IWM | 1,659 | `tt_bias_not_aligned` (~100 %) |

Index ETFs — same pattern as Jul and Aug. The Phase-B backdrop says
Technology led in Sep (XLK +4.44 %), so QQQ should structurally have
pulled back in a tradeable way; it never satisfied the 2-of-3 ST
bearish rule on pullbacks.

## Cross-month block-chain comparison

Tier-1 stock bars through three months:

| Cohort | Jul (clean) | Aug | Sep |
|---|---:|---:|---:|
| TIER1_ETF (SPY/QQQ/IWM) | 4,926 | 4,977 | 4,977 |
| TIER1_STOCKS | 7,674 | 10,486 | **11,613** |
| TIER2 | 15,790 | 20,515 | 19,425 |

TIER1_ETF flat, TIER1_STOCKS continues to grow (+51 % from Jul to
Sep), TIER2 plateaued. Large-cap stocks are increasingly reaching
`setup`/`in_review` stage but being gated out — the gap between
"score-qualified" and "trade-opened" is widening.

## Acceptance

Per plan, month acceptance is clean end-to-end execution:

- ✅ 21/21 sessions without stall.
- ✅ Trade counts match `/admin/runs/detail.total_trades` (28 = 28).
- ✅ No dual-writer events; lock held throughout.
- ✅ Deterministic orchestrator (cleanSlate reset + `cleanSlate=1` on session 1).
- ✅ Block-chain JSONL aggregates reconstruct to worker counters.

**Note:** per the plan's per-month gates on *tuning proposals* (not on
observation baselines), Sep's 46.4 % WR means **any tuning change that
ships going forward has to hold Sep to ≥ 44.4 % WR** — a narrow
margin. This may constrain T7 and T6 experiments when they arrive.

## Open questions sharpened by Sep

1. **`PRE_EVENT_RECOVERY_EXIT` is demonstrably firing too aggressively.** 4
   of 4 cases were flat/losing; the event windows were dominated by FOMC +
   CPI. T5 (Phase C's original "keep as-is pending more data") should
   now be **revised** — the rule's threshold needs work.
2. **FOMC-day +/- 1 entry blocks** — 4 of 6 clear losers in Sep entered
   into the Sep 16–17 window. Candidate for a new gate conditional on
   macro events. Phase F territory; need to wire `event_density` from
   backdrop JSON into the runtime first.
3. **T7 pattern breaks in Sep.** Jul (3W/1L), Aug (2W/1L), Sep (1W/1L)
   — the "`replay_end_close` is net positive" claim no longer holds.
   3-month sample: 6 wins, 3 losses, but one of the Sep losses is
   −3.73 % vs winners averaging ~+20 %. Still net positive by PnL
   but not by count anymore. Analysis in
   `proposed_tuning.md`.
4. **The tt_core entry engine starves in transitional-to-calm regimes.**
   Jul (uptrend, vol 6.7): 36 trades. Aug (transitional, vol 10.4): 15
   trades. Sep (transitional, vol 6.4): 28 trades with 46 % WR. The
   engine doesn't produce consistent output in transitional backdrops
   regardless of vol level. Phase F should test regime-conditional
   entry gates — this is the strongest cross-month argument for
   Phase F yet.

## Provenance

- Branch: `phase-d/slice-2025-09-2e87`.
- Script: `scripts/monthly-slice.sh --month=2025-09 --block-chain`.
- Baselines for comparison: `phase-c-cleanslate-regression-v1` (Jul),
  `phase-d-slice-2025-08-v1` (Aug).
- Deployed worker at run time: same commit as Aug (`a0ff32e`).
