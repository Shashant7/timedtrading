# Proposed tuning — 2025-09 slice

> Third data point for Phase D. Now have Jul (uptrend), Aug
> (transitional high vol), Sep (transitional low vol). First month
> where Phase-C tuning candidates have 3-month evidence.

## Current Sep baseline

| Metric | Value |
|---|---:|
| Trade count | 28 |
| WIN / LOSS | 13 / 15 |
| Win rate | **46.4 %** |
| Big winners | 3 (FIX +6.86, MTZ +5.80, RIOT +7.57) |
| Clear losers | 6 |
| Sum `pnl_pct` | +6.48 % |
| Backdrop | `transitional`, vol 6.4 %, 0 earnings clusters, dense macro (FOMC Sep 18) |

## Three-month trade log

| Month | Trades | WR | Big W | Clear L | Sum PnL |
|---|---:|---:|---:|---:|---:|
| Jul 2025 | 36 | 77.8 % | 5 | 3 | +109.06 % |
| Aug 2025 | 15 | 66.7 % | 2 | 1 | +53.82 % |
| Sep 2025 | 28 | 46.4 % | 3 | 6 | +6.48 % |

Pattern: the tt_core entry engine produces **highly variable output by
regime**. Transitional months (Aug + Sep) are thinner and noisier than
the uptrend month (Jul). Large-cap Tier-1 trades diminish across the
three months (Jul: 6/36 ≈ 17 %; Aug: 2/15 ≈ 13 %; Sep: 0/28 = 0 %).

## Phase-C carry-forwards — status updates

### T1 — Runner round-trip relaxation for rank ≥ 95

- Jul: 2 instances (ETN +0.31, GOOGL +0.22 — both rank 100).
- Aug: 2 instances (CDNS +0.01 rank 100, PH −0.09 rank 65 — the rank-65
  one argues against unconditional relaxation).
- Sep: 1 instance (PH +0.18 rank 69 — rank-69 is below the proposed
  threshold, so unaffected).

**3 months of evidence. Only 2 of 5 hits are at rank ≥ 95, both rank 100.
The PH rank-65 case shows the round-trip guard protecting against
genuine weak setups. Narrow T1 to "raise threshold for rank = 100 only"
and drop the rank ≥ 95 variant.** Still not high impact; ~0.5 % sum-pnl
upside. **Deferred.**

### T3 — Earnings-cluster entry block

- Jul: 5 clusters (Jul 28–31 peak, 8 tickers inside window).
- Aug: 1 cluster (Aug 4–7, 5 tickers).
- Sep: **0 clusters.**

Sep's zero-cluster status means T3 couldn't have fired in Sep at all
(nothing to gate). 2 out of 3 months have the signal; the third is
silent. **T3 needs 3+ cluster-heavy months.** Jul had evidence, Aug
partially confirmed (`PRE_EARNINGS_FORCE_EXIT` handles direct
participants). Wait for Oct + Nov + Dec (Nov has 5 clusters per the
Phase-B backdrop).

### T5 — `PRE_EVENT_RECOVERY_EXIT` — now has signal

**NEW IN SEP.** Phase-C said "keep as-is pending more data." Sep data:
4 `PRE_EVENT_RECOVERY_EXIT` firings, all between −0.22 % and −0.03 %
(flat or tiny losses). Not a single firing produced a positive outcome
this month.

- Jul: 2 firings (PH +0.09, GRNY −0.15).
- Aug: 1 firing (SWK −0.08).
- Sep: 4 firings (XLY −0.03, XLY −0.11, GRNY −0.10, HUBS −0.22).

7 firings across 3 months, mean PnL ≈ −0.09 %, 0 wins >+0.10 %. The
rule is consistently getting out of positions ahead of events but the
events are mostly non-impactful (CPI/PPI reports in cases with low
surprise), and the rule doesn't give the position time to recover
post-event.

**Revised T5 proposal:**
- Replace `PRE_EVENT_RECOVERY_EXIT` firing-on-pre-event-weakness with a
  narrower rule: only fire when the event is **FOMC / NFP / CPI AND**
  the position has already given back > 50 % of MFE.
- Expected impact: eliminates ~5 of 7 flat firings across Jul + Aug +
  Sep; preserves the 2 cases where pre-event exit was actually justified.
- Risk: if a position is already 50 % given back, it may just be a
  normal `max_loss` candidate anyway, so this rule may become redundant.
  Needs A/B simulation with `compare-block-chains.js` before shipping.

**Status:** candidate for DA-key experiment on a dedicated branch.
Still needs Oct data to confirm before code change.

### T6 — Joint ETF entry-gate relaxation

Sep ETF block-reason breakdown reinforces Jul + Aug:

| Ticker | Top blocker Jul | Top blocker Aug | Top blocker Sep |
|---|---|---|---|
| SPY | `tt_pullback_not_deep_enough` | `tt_pullback_not_deep_enough` | `tt_pullback_not_deep_enough` |
| QQQ | same | same | same |
| IWM | `tt_bias_not_aligned` | `tt_bias_not_aligned` | `tt_bias_not_aligned` |

Consistent 3-month pattern. T6's joint-relaxation proposal is now
well-supported. **Still deferred** — needs `compare-block-chains.js`
simulation of a joint SPY/QQQ relaxation showing which bars pass all
downstream gates vs just fall through to the next block.

### T7 — End-of-window protective trail

Three-month `replay_end_close` data:

| Month | Firings | Wins | Losses | Mean win | Mean loss |
|---|---:|---:|---:|---:|---:|
| Jul | 4 | 3 | 1 | +26.8 % | −11.2 % |
| Aug | 3 | 2 | 1 | +26.8 % | −7.2 % |
| Sep | 2 | 1 | 1 | +7.6 % | −3.7 % |

Pattern weakening in Sep. **Still net positive in PnL** (avg win × wins
>> avg loss × losses), **but count is now even 6 wins vs 3 losses, not
the 5:1 Jul showed**. T7's original pitch ("tight protective trail
converts losers to breakeven at zero cost to winners") still holds on
PnL math, but the evidence is softening.

**Status:** hold. Reassess after Oct. The key test: does Oct's
`replay_end_close` look like Sep (balanced) or Jul/Aug (win-heavy)?
If Oct matches Sep, T7 is probably not worth the code change.

## New proposals from Sep

### T8 — Pre-FOMC entry block (48h window)

Sep 16 cluster: 5 entries bunched in one session, 4 of them into the
48h pre-FOMC window. 4 out of 5 lost or flat-exited (MTZ +5.80 %
being the sole winner, saved by R6).

Specifically:
- ETN rank 100 → −3.16 % `max_loss` (48h pre-FOMC)
- AGQ rank 96 → −3.28 % `max_loss` (45h pre-FOMC)
- GRNY rank 94 → −0.10 % `PRE_EVENT_RECOVERY_EXIT` (48h pre-FOMC)
- XLY rank 58 → −0.11 % `PRE_EVENT_RECOVERY_EXIT` (50h pre-FOMC)

Proposed rule:
- Block **non-Prime** entries in the 48h pre-FOMC window.
- Let Prime grade through (high-conviction setups can still fire).
- Not applied to other macro events (CPI / NFP / PCE) — Sep had
  multiple CPI/PPI dates and the engine traded through them fine.

**Expected impact (Sep):**
- Removes ~4 of 6 clear losers.
- Preserves MTZ +5.80 big winner if Prime-graded, or loses ~5.8 %
  otherwise. Needs grade check from the raw trade record.
- Rough estimate: Sep sum_pnl goes from +6.48 % to +16–21 %.

**Status:** single-month evidence only. Nov has FOMC Nov 7 per
backdrop — will be the next data point. Defer until at least 2
FOMC months observed.

### T9 — Transitional-regime entry-engine relaxation

Cross-month evidence is now clear:

| Month | Cycle | Trade count | WR | PnL |
|---|---|---:|---:|---:|
| Jul | uptrend | 36 | 77.8 % | +109 % |
| Aug | transitional | 15 | 66.7 % | +54 % |
| Sep | transitional | 28 | 46.4 % | +6 % |

**Transitional backdrops produce inconsistent output.** The entry
engine is tuned for uptrend-style pullbacks (2-of-3 ST flip required)
which doesn't always manifest in transitional regimes.

Proposed rule (Phase F candidate — needs backdrop JSON wiring into
runtime):
- When `backdrop.cycle == "transitional"` AND SPY realized vol < 8 %,
  drop `deep_audit_pullback_min_bearish_count` from 2 to 1 for
  Tier-1 Prime setups.
- When `backdrop.cycle == "transitional"` AND SPY realized vol > 10 %,
  raise `deep_audit_confirmed_min_rank` from 65 to 75 (tighten the
  confirmed bucket since Aug's transitional + high vol was the worst
  output).

**Status:** Phase F territory. Requires Phase-B backdrop JSON wiring
into the runtime. On hold until Phase F starts.

## What's ready to ship

**Nothing yet.** Three months of evidence sharpens T1 / T3 / T5 / T6 /
T7 / T8 / T9, but no single candidate has both 3+ month evidence AND
low-risk impact AND a clear A/B simulation path.

Closest candidate to shipping: **revised T5** (narrow
`PRE_EVENT_RECOVERY_EXIT` to FOMC/NFP/CPI + MFE-giveback >50%). Good
3-month evidence, isolated code change, low-risk (more permissive →
fewer false exits, big winners preserved). Would ship as
`phase-d/t5-preevent-narrow-<tag>` after Oct data.

## Next step

Next Phase-D slice: 2025-10 on a new branch, same orchestrator.
Goals:
1. Fourth observation month — critical for T5 and T8 validation.
2. Oct has 5 earnings clusters per the Phase-B backdrop — a heavy
   cluster month. T3 will have much more signal.
3. Oct has FOMC Oct 29 — second FOMC for T8 evidence.
4. Check whether Tier-1 stock trade count recovers from Sep's zero.
