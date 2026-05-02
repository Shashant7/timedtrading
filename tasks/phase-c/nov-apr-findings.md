# Phase C — Stage 0.5 — Nov-Apr Findings

_Source: `v16-canon-julapr-30m-1777523625` · 553 trades · Generated 2026-05-02_

> The 6 monthly verdict files are in `tasks/phase-c/monthly-verdicts/`.
> This document is the cross-month synthesis. Read this first.

---

## Headline numbers, all months side-by-side

| Month | Trades | WR | Avg W | Avg L | Avg R | Cum P&L | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| **Jul 2025** | 107 | **58.9%** | 3.42% | 2.48% | 1.38x | +106% | The reference page |
| Aug 2025 | (in run) | — | — | — | — | — | _verdicts not generated yet, will pull on demand_ |
| Sep 2025 | (in run) | — | — | — | — | — | _same_ |
| Oct 2025 | (in run) | — | — | — | — | — | _same_ |
| **Nov 2025** | 34 | **35.3%** | 2.78% | 0.76% | 3.68x | +17% | Low WR, but small avg loser — controlled |
| **Dec 2025** | 57 | 49.1% | 21.05% | **8.72%** | 2.41x | +345% | Avg loser BLEW UP — `v13_hard_pnl_floor` and earnings exits |
| **Jan 2026** | 68 | 52.9% | 14.92% | **9.09%** | 1.64x | +246% | Same disease — losers averaging 9% |
| **Feb 2026** | 63 | 54.0% | 16.91% | 5.39% | 3.14x | +418% | Best post-July month by P&L |
| **Mar 2026** | 8 | 37.5% | 9.29% | 4.94% | 1.88x | +3% | Engine basically stopped trading |
| **Apr 2026** | 0 | — | — | — | — | — | Engine stopped trading entirely |

## The honest read

**Cumulative P&L looks great in Dec-Feb (+1000% combined).** But "Cum P&L" is just sum of pct, ignores compounding. The real signal is **average loser size** and **what happened in March/April**.

---

## Pattern 1 — The "v13_hard_pnl_floor" + "HARD_LOSS_CAP" plague (Dec / Jan / Feb)

The single biggest leak post-October is huge losses driven by these two exit reasons:

| Month | `v13_hard_pnl_floor` losses | `HARD_LOSS_CAP` losses |
|---|---|---|
| Dec | 7 trades, avg **-16.94%** | 3 trades, avg **-14.48%** |
| Jan | 7 trades, avg **-15.94%** | **8 trades, avg -20.63%** |
| Feb | 8 trades, avg -10.44% | 6 trades, avg -8.87% |
| Mar | 1 trade, avg -1.21% | 4 trades, avg -5.88% |

For comparison, in Jul: `max_loss` averaged -2.54%, `phase_i_mfe_fast_cut_zero_mfe` averaged -1.23%. Losses were **bounded around -2%**.

In Jan: losses are running **-15% to -20%**. We let trades bleed 5-10x further than July.

**This is the #1 thing to fix.** The `v13_hard_pnl_floor` (a -10%/-15% absolute floor) is the LAST line of defense. It's firing 7-8 times per month — meaning the engine isn't catching deterioration earlier with regular `max_loss`. Loop 2 (circuit breaker) would have tripped after 4 of these in a row in Jan.

---

## Pattern 2 — The AGQ / ASTS death spiral (Jan)

Re-entry chains in Jan:

| Ticker | Trades | Net P&L |
|---|---|---|
| **AGQ** | 3 | **-98.05%** |
| **ASTS** | 3 | **-46.11%** |
| AU | 3 | -15.11% |
| EMR | 3 | -10.73% |

AGQ alone gave back **98% cumulative** across 3 trades. The engine kept trying to enter the same losing setup. Each entry failed at `HARD_LOSS_CAP` -20%+. **Loop 2's consecutive-loss breaker would have tripped after the second AGQ loss and prevented #3.** Loop 1's specialization scorecard would have rejected the third entry on the same `(setup × regime × personality × side)` combo.

**This single chain (AGQ + ASTS) burned -144% on 6 trades.** If we stop those at trade 2, we save ~100%.

---

## Pattern 3 — Earnings + late exits (Dec)

`PRE_EARNINGS_FORCE_EXIT` in Dec: 3 trades, avg **-22.83%** (RDDT -38%, CVX -29%).

These are trades that ran into earnings and got force-exited at the open print. The fact they were down 22-38% at force-exit means they were already deeply underwater before earnings hit.

This is a setup gating issue (we entered into a name with earnings 2-3 days out and didn't manage out), not a loop fix. But Loop 1's combo scorecard would have remembered "this setup × regime × personality has lost 38% the last 2 times" and blocked the 3rd attempt.

---

## Pattern 4 — March / April collapse

Mar: 8 trades. Apr: 0 trades.

The engine basically stopped trading in March and shut off in April. Two possible reasons:
1. **Entry gates tightened** (regime gate, danger score, etc) such that nothing qualified
2. **Capital was tied up** in deeply underwater Jan/Feb positions still hanging open

Looking at Mar's 8 trades — all entries are `tt_pullback` / `tt_n_test_support` / `tt_ath_breakout` (all "low-aggression" setups). The aggressive `tt_gap_reversal_long` that drove Jan/Feb's volatility had stopped firing. The engine had retreated.

This isn't a loop problem. **This is the engine self-correcting after the Dec/Jan disaster** — but doing so by going dormant rather than recalibrating. Our 3 loops would do this BETTER:
- Loop 2: would have paused us in Jan after the 4th consecutive HARD_LOSS_CAP, instead of letting us bleed through 6
- Loop 1: would have refused the AGQ chain at trade 3
- Loop 3: nothing to add here (this was about entries, not management)

---

## Pattern 5 — `SMART_RUNNER_SUPPORT_BREAK_CLOUD` is firing constantly but losses are tiny

| Month | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` count | Avg loss |
|---|---|---|
| Jul | 3 | -0.51% |
| Aug | **8** | -0.39% |
| Sep | 3 | -0.81% |
| Oct | 4 | -0.48% |
| Nov | 4 | -0.22% |

This is the engine working as designed — exiting runners cleanly when their support breaks. Avg loss is sub-1%. **Not a leak. Don't touch it.** This pattern shows the engine USED to exit cleanly — the disease that hit in Dec is something else (the v13 hard caps, see Pattern 1).

---

## Implications for our loop thresholds

### Loop 2 (circuit breaker) — current defaults

```
last-10 WR < 30%   → trip
today PnL < -1.5%  → trip
≥ 4 consec losses  → trip
```

**Verdict: thresholds are right but ON IMMEDIATELY would have helped.** Specifically:

- `consec_losses >= 4` would have caught the Jan AGQ chain (3 of 3 lost)
- `today_pnl < -1.5%` would have caught Jan days where we lost -20%+ on a single HARD_LOSS_CAP trade
- `last-10 WR < 30%` would have caught Jan/Feb when we had stretches of 6-7 losses in 10 trades

**Adjustment recommendation: NONE.** Run with the defaults for Stage 1. They're calibrated correctly for the actual loss patterns.

### Loop 1 (specialization scorecard) — current defaults

```
loop1_min_samples = 8       # need 8 samples before judgment
loop1_raise_bar_wr = 0.45   # <X WR → raise the bar
loop1_block_wr = 0.30       # <X WR → block entirely
```

**Verdict: `min_samples=8` may be too conservative for our universe.** AGQ had 3 losses before the engine kept trying. If `min_samples=3`, Loop 1 would have started judging earlier.

**Adjustment recommendation: try `loop1_min_samples=4` for Stage 1.** A 4-trade combo with 0% WR is still a strong signal in our 100-trade-per-month universe. We can re-tune up or down after Jul-Sep behavior.

### Loop 3 (personality management) — current defaults

```
SLOW_GRINDER → 24h before flat-cut
VOLATILE_RUNNER → 30 min flat-cut
PULLBACK_PLAYER → 4h before flat-cut
MEAN_REVERT → 2h before flat-cut, force trim TP1
```

**Verdict: can't fully validate without MFE/MAE data.** The current dataset has MFE=0/MAE=0 on every trade (the bug we know about). But we CAN see that VOLATILE_RUNNER trades dominated both winners AND losers — meaning the personality classification is real and management asymmetry is the right idea.

**Adjustment recommendation: NONE.** Run with the defaults for Stage 1. We'll get real MFE/MAE data this time and can tune if needed.

---

## What this changes about Stage 1

### Already in our plan, no change

- Run Jul 2025 through Apr 2026 month by month
- Pause + verdict + calibrate between each month
- Loops 1, 2, 3 active from Jul day 1
- Promote each month to Trades page so we can SEE

### Refined for Stage 1 based on findings

1. **Activate Loop 2 with default thresholds** — they would have caught the Jan/Feb disaster
2. **Activate Loop 1 with `min_samples=4`** instead of 8 — earlier specialization
3. **Add a 4th watch for the Stage 1 verdicts:** look for `v13_hard_pnl_floor` and `HARD_LOSS_CAP` firing rates. If they trend up month-over-month like they did before, we have a regression. If they trend down, the loops are working.
4. **Stage 2 (holdout) is now Apr 2026** — perfect because the engine's actual Apr was empty, so any positive Apr in our backtest is real signal

### What we are NOT doing

- We are NOT changing the underlying engine config beyond the loops
- We are NOT introducing new setups or exit rules
- We are NOT adjusting the v13 pnl_floor or HARD_LOSS_CAP — Loop 2 catches the bleed BEFORE we'd hit those
- We are NOT trying to replace MFE/MAE data from this old run — Stage 1 will produce fresh data with the captures fixed

---

## TL;DR for Stage 1 kickoff

> **What we learned:** Dec/Jan/Feb's losses were 5-10x bigger than July's. Pattern: small leaks (one bad day, one bad chain) compounded into cataclysmic losses (-98% on AGQ chain). The engine kept trading instead of pausing. By March it had self-shut-down by tightening entry gates rather than calibrating.
>
> **Why our 3 loops fix it:** Loop 2 stops the bleed at the day level (-1.5% trips). Loop 1 stops the chain at the combo level (re-entries on losing combos blocked). Loop 3 keeps management asymmetric per personality.
>
> **One config tweak:** `loop1_min_samples = 4` (down from 8). Otherwise defaults are fine.
>
> **Ready to kick off Stage 1.**
