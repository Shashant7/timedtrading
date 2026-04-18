# Proposed tuning — 2025-08 slice

> Second data point for Phase D. Per the plan, no DA-key change ships
> until it survives full-coverage replay across all 10 training months.
> This doc records observations from Aug that either **sharpen** an
> existing Phase-C proposal or **open** a new candidate — but ships
> no config change.

## Current 2025-08 baseline (set by this slice)

| Metric | Value |
|---|---:|
| Trade count | 15 |
| WIN / LOSS | 10 / 5 |
| Win rate | 66.7 % |
| Big winners (≥ 5 %) | 2 (AGQ +35.47 %, SGI +18.16 %) |
| Clear losers (≤ −1.5 %) | 1 (XLY −7.23 %) |
| Sum `pnl_pct` | +53.82 % |
| Backdrop | `transitional`, realized vol 10.4 %, Aug 4–7 earnings cluster |

Any DA-key proposal must hold this anchor at ≥ 65 % WR, ≥ 2 big
winners, ≥ +48 % sum-pnl-pct (plan's regression budget: 2 pp WR,
10 % PnL) when replayed on Aug.

## Carry-forward proposals from Phase C

Phase C's `proposed_tuning.md` listed T1–T6. Aug evidence:

### T1 — Runner round-trip guard relaxation for high-rank runners

Aug has 2 `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` exits: CDNS
2025-08-04 (rank 100, +0.01 %) and PH 2025-08-13 (rank 65, −0.09 %).
Same exit type cut 2 rank-100 runners in Jul. Pattern holds: **high
rank + round-trip failure = symptomatic cut**. T1's "raise round-trip
threshold for rank ≥ 95" proposal now has cross-month evidence.
Deferred still — single-slice impact remains in the ~1 % sum-pnl range.

### T2 — Relax `eod_trimmed_underwater_flatten` in uptrend cycles

Aug has 2 of these (META +0.52 %, SWK +0.60 %). Both are flat-ish
wins / losses, not clean evidence either way. **Aug's cycle is
`transitional`, not `uptrend`** — this proposal's regime condition
wouldn't have triggered for Aug anyway, so no new signal. Proposal
unchanged.

### T3 — Block entries on ≥ 4-ticker earnings clusters

Aug 4–7 earnings cluster: 5 tickers (ETN/HUBS/ON/PH/SGI) across 4
days. Trades that entered during/adjacent to this cluster:

| Ticker | Entry | PnL | Status |
|---|---|---:|---|
| SGI | 2025-08-05 16:30 | −0.72 % | LOSS (PRE_EARNINGS_FORCE_EXIT) |
| META | 2025-08-06 15:20 | −0.04 % | LOSS |
| GRNY | 2025-08-06 15:40 | +0.25 % | WIN |

3 entries across the cluster; 2 losses + 1 breakeven win. **One
`PRE_EARNINGS_FORCE_EXIT` fired correctly on SGI** — the existing
pre-earnings rule handled its own ticker cleanly. The two marginal
trades (META, GRNY) weren't reporting earnings themselves but
entered during the cluster window and exited near-flat.

**Revised T3 proposal:** instead of a blanket cluster-day entry
block, restrict T3 to **entries on the anchor day ± 1 where the
ticker is _in_ the cluster** (i.e., reports earnings within the 3-day
window). This is a narrower, more defensible rule than Phase C's
broad "any cluster day for any ticker" proposal. Aug evidence:
`PRE_EARNINGS_FORCE_EXIT` already handles the direct-participant
case (SGI). T3's real remaining job is to prevent **late-cluster
entries like CDNS Jul 28 +5.61 % (WIN) vs CDNS Jul 31 −3.34 %
(LOSS)** — same ticker entered 3 days apart, one before its
earnings, one after; both inside the cluster but only one profitable.
Needs deeper per-ticker analysis to define "late in cluster" cleanly.

### T4 / T5 — Unentered candidates diagnostic + `PRE_EVENT_RECOVERY_EXIT`

T4 is satisfied by the analyzer landed in PR #8.
T5 has 1 `PRE_EVENT_RECOVERY_EXIT` in Aug (SWK −0.08 %). Two-month
sample is still too thin; wait for Sep + Oct.

### T6 — Joint ETF entry-gate relaxation

Aug strongly reinforces the Jul finding. The `tt_pullback_not_deep_enough`
+ `tt_bias_not_aligned` gate pair is still the binding constraint on
SPY/QQQ/IWM, and Aug's `tt_bias_not_aligned` count **tripled** to
14,231 — so the single-gate T6 relaxation remains wrong in isolation
but the analysis framework for a multi-gate proposal is now stronger.

**No change** — still need Sep data plus `compare-block-chains.js`
simulation of a joint-relaxation challenger before proposing.

## New observation from Aug

### T7 — `replay_end_close` is doing real work on runners

Aug: 3 `replay_end_close` exits — 2 of which are the big winners
(AGQ +35.47 %, SGI +18.16 %). 1 is the clear loser (XLY −7.23 %).

In Jul: 4 `replay_end_close` exits, 3 of which were big winners
(NVDA +43.82 %, PH +28.94 %, GRNY +7.52 %); 1 clear loser (AMZN
−11.21 %).

Pattern across two months: `replay_end_close` is **net positive** —
the R6 MFE trail + smart-runner framework is letting winners run
past the replay window but not protecting against a last-day
reversal on losers.

**Candidate T7:** add an `end_of_window_protective_trail` — in the
final 2 sessions of a replay window, tighten the stop on every OPEN
position to `entry_price + max(0, 0.5 * mfe_peak_pct)` so the
force-close-at-boundary event either realizes most of the peak or
stops out above entry. Would have:

- Preserved AGQ +35 % (MFE peak high above 35 % at entry-close), SGI
  +18 %, NVDA +43 %, PH +29 %, GRNY +7 % — all big winners
  untouched.
- Stopped XLY out at ~entry (+0 %) instead of −7.23 %.
- Stopped AMZN out at ~entry instead of −11.21 %.

Net estimated cross-month impact (2 months): −1 clear loser per
month (~+9 % sum_pnl in Jul, +7 % in Aug) with no loss of big
winners. **Needs validation** on the other 7 training months before
any code change.

This is the first concrete Phase-D candidate with two-month evidence.
If Sep / Oct data reinforces, T7 becomes the first
`phase-d/tuning-experiment-*` worth running.

## What's NOT proposed

- **R6 band widths / MFE decay thresholds** — Aug has only 1 `mfe_proportional_trail`
  exit and no `MFE_DECAY_*` exits. Too thin to tune.
- **Short-side gates** — Aug blocked 996 `tt_short_pullback_not_deep_enough`
  + 576 `da_short_rank_too_low` bars, produced 0 short trades.
  Wait for a backdrop with legitimate short-side setups (Nov 2025,
  Feb / Mar 2026) before touching.
- **Max-loss defaults / early-guard favorable zone** — the deferred
  Bugbot PR #2 findings. Aug data neither confirms nor refutes;
  they remain on ice until a month with meaningful `max_loss` exits
  (Aug had 1: NVDA +2.35 %, which is a misleading WIN-stamped
  `max_loss` — the `max_loss` ratchet stopped it out at a small
  profit, not a loss).

## Next step

Next Phase-D slice: 2025-09 on the same orchestrator. Goals:

1. Book Sep as a third observation baseline.
2. See whether Sep holds Aug's high `tt_bias_not_aligned` rate
   (evidence of persistent regime-driven cloud-vote gating) or
   reverts to Jul's lower rate.
3. Accumulate cluster data for T3's refinement.
4. If T7's `replay_end_close` pattern holds for a third consecutive
   month, open `phase-d/t7-eow-trail-*` as the first DA-key
   experiment on the block-chain analyzer.

Until 3+ months of consistent evidence exist for any single
proposal, no DA-keys ship.
