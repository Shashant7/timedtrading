# Phase D slice — 2025-11 (run_id `phase-d-slice-2025-11-v1`)

> Fifth observation baseline. The **R3 drought month** per lessons.md.
> Clean confirmation of the pattern that motivated Phase B.

## Envelope

| Field | Value |
|---|---|
| Window | `2025-11-03 → 2025-11-28` (19 trading days) |
| Wall-clock | ~11.5 min, 0 stalls |
| Worker | commit `a0ff32e` |
| Block-chain artifact | 33,780 records |

## Backdrop

- Cycle `downtrend` per Phase-B (HTF_BEAR_LTF_BEAR = 50 %)
- SPY +0.01 %, realized vol 15.79 %
- Defensive rotation (Health Care / Materials / Staples top; Technology/Consumer Discretionary bottom)
- Heavy earnings cluster Nov 3–7 (up to 8 tickers)
- FOMC Nov 7

## Headline

| Metric | Nov | Oct | Sep | Aug | Jul |
|---|---:|---:|---:|---:|---:|
| Trades | **2** | 16 | 28 | 15 | 36 |
| WIN / LOSS / FLAT | 1 / 0 / 1 | 8 / 7 | 13 / 15 | 10 / 5 | 28 / 8 |
| Big winners | 1 | 2 | 3 | 2 | 5 |
| Sum `pnl_pct` | **+38.65 %** | +56.42 | +6.48 | +53.82 | +109.06 |

**Both trades:**

| Ticker | Entry | Exit | Rank | PnL | Status | Reason |
|---|---|---|---:|---:|---|---|
| TSLA | 2025-11-06 14:45 | 2025-11-30 21:00 | 55 | **+38.65 %** | WIN | `replay_end_close` |
| AGQ | 2025-11-11 18:30 | 2025-11-28 15:00 | 90 | 0.00 % | FLAT | `HARD_FUSE_RSI_EXTREME` |

## Confirms the R3 drought

The Phase-B plan explicitly predicted Nov would be a drought: the combination of pre-earnings entry block + post-event 8h re-entry lockout compounds when 6+ tickers in the universe have clustered earnings dates (the Oct 28 → Nov 14 window). Exactly played out:

- Nov 3–7 cluster: 5 tickers (ETN/HUBS/ON/PH/SGI) reporting
- FOMC Nov 7
- **19 sessions produced only 2 entries** that weren't gated out.

## Why — block-chain cohort breakdown

The dominant blocker shifts from Jul/Aug/Sep/Oct (`tt_pullback_not_deep_enough`) to **`tt_bias_not_aligned`** across every cohort:

| Cohort | Bars | Top blocker | Share |
|---|---:|---|---:|
| Tier-1 ETF | 4,427 | `tt_bias_not_aligned` | **61.2 %** |
| Tier-1 stocks | 9,246 | `tt_bias_not_aligned` | 44.7 % |
| Tier-2 | 20,107 | `tt_bias_not_aligned` | 44.6 % |

Makes sense: in a downtrend/transitional bear regime, the daily/4H/1H/10m cloud vote almost never aligns (long setup + mixed clouds because the daily is bearish). The `tt_bias_not_aligned` gate was designed for bull-regime confirmation and becomes a blanket veto in bear months.

## T-proposal tracking (5 months)

### T5 — `PRE_EVENT_RECOVERY_EXIT` narrowing

Nov: 0 firings (only 2 trades, neither hit the pre-event guard). 5-month total still 8 firings, strong signal. **Ready for experiment.**

### T7 — EOW protective trail

TSLA +38.65 % is the third month in a row where `replay_end_close` produces a Tier-1 runner. AGQ 0.00 % is technically a FLAT not replay_end_close. Only 1 replay_end_close firing in Nov; cross-month total now 7W/4L on replay_end_close, **with all the wins being high-magnitude**. The "cut losers tighter at EOW" reframe stays alive.

### T3 — Earnings-cluster entry block

Only 2 Nov trades. One of them (AGQ Nov 11) was inside the Nov 3–7 cluster aftermath; it exited FLAT. Nov confirms that even with T3 in place, the drought would persist — T3 is solving the wrong problem for bear-regime months.

### T8 — Pre-FOMC block

FOMC was Nov 7. Neither of the 2 Nov trades entered in the pre-FOMC window (TSLA Nov 6 at 14:45 UTC is ~6h before pre-FOMC cutoff if we use 48h, or inside if we use 24h). Single data point too thin to extract signal — basically no trades to gate.

### T9 — Regime-conditional entry gates (**Phase F**)

**Nov is now the clearest evidence yet** for Phase F:

- Downtrend/bear-regime months: Nov (2 trades) is the extreme case.
- Transitional: Aug (15), Sep (28), Oct (16)
- Uptrend: Jul (36)

The engine's bias-alignment rule is the binding constraint in bear regimes (61 % of ETF blocks), the pullback-depth rule is binding in transitional/uptrend (28–66 % depending on cohort). **A regime-conditional relaxation of `tt_bias_not_aligned`** (e.g. allow 3-of-4 cloud vote instead of 4-of-4 when cycle = downtrend) could unlock meaningful Nov trade flow. Deferred to Phase F.

## New proposal — T10

### T10 — `HARD_FUSE_RSI_EXTREME` FLAT-status investigation

AGQ Nov 11 exited via `HARD_FUSE_RSI_EXTREME` with `status=FLAT` and `pnl_pct=0.00`. That's an unusual combination — most HARD_FUSE exits are WINs (Jul had 2 big HARD_FUSE wins: AGQ +10.33 %, CDNS +5.61 %). Nov's 0 % hit suggests the AGQ runner briefly hit extreme-RSI then reverted to entry before the exit could realize the gain.

Low-priority, but worth a look once we have more cross-month data on FLAT-status exits. Not acting on it.

## Provenance

Branch `phase-d/slice-2025-11-2e87`, base `main@a0ff32e`.
