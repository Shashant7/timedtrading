# Phase C — Post-Fix Jul-Aug Deep Analysis (2026-05-03)

Run: `phase-c-stage1-jul2025-may2026` legs Jul + Aug 2025
Closed trades analyzed: **156** (Jul=92, Aug=64; 5 still OPEN, 12 partials).

> All counts come from the live `/timed/admin/backtests/run-trades` archive
> snapshot at 2026-05-03 18:30Z. Raw breakdowns in
> `data/trade-analysis/phase-c-stage1-jul2025-may2026/analysis/analyze.out`.

---

## Executive summary — top 5 levers ranked by expected impact

The pattern that dominates everything in Jul-Aug is the **`tt_gap_reversal_long
× VOLATILE_RUNNER`** workhorse: 49 trades, 67 % WR, +$7,877 net. It is also the
source of every top-15 MFE trade, all 33 winners that gave back >40 % of their
peak, and the single source of the ~100 pp of "left-on-table" capture loss
(`mfe_decay_structural_flatten` + `PROFIT_GIVEBACK_STAGE_HOLD` +
`SMART_RUNNER_SUPPORT_BREAK_CLOUD` together fired 23 times on MFE≥5 % runners
with average 21–32 % capture). Three of the five levers below are exit-side
tweaks that target this cohort. The other two close the largest hole on the
loser-side (`is_f4_severe` + `has_adverse_phase_div`) and the worst Loop 1
combo we still allow at min_samples=3.

| # | Lever | DA flag (file:line) | Now → Proposed | Expected gain (Jul-Aug counterfactual) |
|---|---|---|---|---|
| **1** | Slow `mfe_decay_structural_flatten` for `gap_reversal_long × VOLATILE_RUNNER` | `deep_audit_mfe_decay_giveback_pct_max` `worker/index.js:8338` & `worker/pipeline/tt-core-exit.js:142` | **0.60 → 0.75** (cohort-only override; safest path is a new `_volrunner_gap_long` variant key, identical to the `HARD_FUSE` pattern from V15 P0.7.51) | 7 of 10 fires were on `gap_reversal_long × VOLATILE_RUNNER`; avg captured 31 %, gave back 69 %. Letting them run another 25 pp recovers ≈ **+$1,200–$1,800** without changing any losers (the rule has *zero* losing trades — n=10 W=11 L=0 over Jul-Aug). |
| **2** | Lift `winner_protect_big_mfe_threshold_pct` floor down + raise lock | `deep_audit_winner_protect_big_mfe_threshold_pct` `worker/index.js:7362` and `_lock_pct` line 7365 | threshold **15 % → 8 %**, lock **0.60 → 0.55** | Top-10 MFE trades averaged MFE 18.0 % / pnl 7.0 %, capture 38 %. Lower threshold puts a floor on JOBY-class (33 % MFE → 12 % captured) AND on the medium-MFE 8-14 % bucket where every fire today gives back > 65 %. Estimate **+$1,000–$1,500** by anchoring SL at 0.55× peak before the structural-flatten can fire. |
| **3** | Soft entry-veto on `is_f4_severe` LONG (severe = adverse RSI div *AND* adverse phase div together) | New flag `deep_audit_v15_negative_veto_*` already exists at `worker/replay-runtime-setup.js:284` (`deep_audit_v15_negative_veto_enabled`). Currently no scoped predicate — propose adding a one-line clause: block when `is_f4_severe && direction==='LONG'` AND `personality !== 'VOLATILE_RUNNER'` AND `entry_path !== 'tt_gap_reversal_long'` | enabled (cohort-scoped) | F4-severe LONG: 18 trades, 7W/11L, **WR 39 %**, net = +$15. The 11 losses sum to **−$1,545**; the 7 wins sum to +$1,360 (mostly from `gap_reversal_long × VOLATILE_RUNNER` which we'd carve out). Skipping non-carved-out F4-severe longs ≈ **+$700–$900** with no entry-gate loosening (this is a *tightening* veto, not a new entry). |
| **4** | Pre-block worst Loop 1 combo (`tt_ath_breakout × PULLBACK_PLAYER × LONG`, n=10, 30 % WR) by manual blacklist before scorecard catches it | `deep_audit_ticker_blacklist`-style mechanism is the wrong knob — better fit is a one-line addition to the existing `loop1` advisory map seed (Phase C loops, `worker/phase-c-loops.js:82-98`): pre-seed a "block" entry for known-bad combos at run-config time. **Or** simpler: lower `loop1_min_samples` from 3 to 2 only when the combo's W=0/n>=3 in the prior month's archive. | Pre-seed `tt_ath_breakout:trending:pullback_player:L = block` | This combo is 3W/7L over Jul-Aug (PnL −$324); 0W/3L in Aug alone (−$126). Removing all 10 trades = **+$324** and clears the worst Loop 1 dot on the scorecard. |
| **5** | Eliminate Monday's edge tax with hour-12 trim | `deep_audit_avoid_hours` `worker/replay-runtime-setup.js:2` (already a configured key — current value not enforced for Mondays) | Block new entries Mondays 12:00-12:59 ET only | Monday WR is 44 % overall (vs Tue 76 %, Wed 66 %). Hour-12 alone is 37 % WR (n=30, net +$505). Combined Monday+12h slice is ~9 trades, ~25 % WR, net negative. Removing them ≈ **+$300–$500** with no impact on any other slice. Conservative move, easily reversible. |

Cumulative expected lift across Jul-Aug if all 5 ship: **+$3,500 to +$5,000**
(roughly +3.5 to +5.0 pp on the $100K base), with Monthly WR stepping from
50 → 56-60 % in August. None of these loosen the entry gate; #1, #2, #5 are
exit/entry timing tweaks; #3 is a *tighter* gate; #4 is a Loop 1 seed.

---

## Section-by-section findings

### A. Big-winner extension

**Top 10 by MFE — every single one is `tt_gap_reversal_long × VOLATILE_RUNNER`.**

| # | Ticker | MFE % | pnl % | cap % | Exit reason |
|---|---|---|---|---|---|
| 1 | JOBY | 33.5 | 12.4 | 37 % | `TP_FULL` |
| 2 | ASTS | 22.0 | 6.0 | 27 % | `peak_lock_ema12_deep_break` |
| 3 | IREN | 21.7 | 10.2 | 47 % | `sl_breached` (post-trim) |
| 4 | ETHA | 18.6 | 9.5 | 51 % | `HARD_FUSE_RSI_EXTREME` |
| 5 | AGQ | 16.0 | 7.5 | 47 % | `sl_breached` |
| 6 | BE | 15.4 | 6.0 | 39 % | `ST_FLIP_4H_CLOSE` |
| 7 | RBLX | 14.1 | 4.8 | 34 % | `sl_breached` |
| 8 | AMD | 13.7 | 6.7 | 49 % | `mfe_decay_structural_flatten` |
| 9 | IESC | 12.8 | 5.8 | 45 % | `TP_FULL` |
| 10 | ANET | 12.3 | 2.9 | 23 % | `mfe_decay_structural_flatten` |

Average capture for top 10 = **38 %** (i.e. 62 % of the runner is left on the
table). JOBY at 37 % capture *was* the trade that hit `TP_FULL` cleanly — the
other nine all gave back materially more than the trim profit.

**MFE ≥ 5 % cohort (n=46) — exit-reason giveback table:**

| Exit rule | n | avg MFE % | avg pnl % | avg capture % | giveback % |
|---|---:|---:|---:|---:|---:|
| `mfe_decay_structural_flatten` | 10 | 8.98 | 2.80 | 31 % | **69 %** |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 9 | 7.27 | 1.54 | 22 % | **78 %** |
| `peak_lock_ema12_deep_break` | 6 | 9.71 | 2.77 | 29 % | **71 %** |
| `sl_breached` | 5 | 12.64 | 5.84 | 49 % | 51 % |
| `TP_FULL` | 5 | 13.99 | 6.15 | 49 % | 51 % |
| `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | 4 | 8.33 | 1.04 | **14 %** | **86 %** |
| `ST_FLIP_4H_CLOSE` | 2 | 10.87 | 4.28 | 40 % | 60 % |
| `HARD_FUSE_RSI_EXTREME` | 1 | 18.55 | 9.53 | 51 % | 49 % |

**Three rules — `mfe_decay_structural_flatten`, `PROFIT_GIVEBACK_STAGE_HOLD`,
`SMART_RUNNER_SUPPORT_BREAK_CLOUD` — together fired 23 of the 46 MFE≥5 % exits
and averaged 22-31 % capture.** That is the high-leverage exit-side fix.

**Trades that gave back > 40 % of MFE (MFE≥3 %): 63 winners.** The 20 worst
gave back 74-98 % of their peak. Top of the list:

| Ticker | MFE % | pnl % | giveback % | Exit |
|---|---:|---:|---:|---|
| WDC | 4.84 | 0.07 | 98 % | `max_loss_time_scaled` |
| CLS | 3.39 | 0.14 | 96 % | `PROFIT_GIVEBACK_STAGE_HOLD` |
| CLS | 4.48 | 0.20 | 96 % | `PROFIT_GIVEBACK_COOLING_HOLD` |
| AEHR | 7.70 | 0.55 | 93 % | `PROFIT_GIVEBACK_STAGE_HOLD` |
| KTOS | 11.48 | 0.90 | 92 % | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` |
| AVAV | 8.77 | 1.38 | 84 % | `peak_lock_ema12_deep_break` |
| GEV | 7.73 | 1.49 | 81 % | `mfe_decay_structural_flatten` |

The pattern is ALWAYS the same: a `gap_reversal_long × VOLATILE_RUNNER` trade
peaks 5-12 %, fades back, and one of the structural-flatten rules cuts at the
fade rather than the next bounce. The current `mfe_decay_giveback_pct_max =
0.60` (line 8338, `index.js`) means as soon as 60 % of MFE is given back the
rule fires. For VOLATILE_RUNNERs this is too tight: their characteristic
behavior is exactly the 60-70 % retrace before the next leg.

**Cross-tab `entry_path × personality`, MFE≥5 % only:**

| Combo | n | avg cap % | Top exit reasons |
|---|---:|---:|---|
| `tt_gap_reversal_long × VOLATILE_RUNNER` | 32 | **32 %** | mfe_decay(7), peak_lock_e12(5), sl_breached(4) |
| `tt_gap_reversal_long × PULLBACK_PLAYER` | 6 | 35 % | mfe_decay(2), profit_giveback(2), ST_FLIP_4H(1) |
| `tt_pullback × PULLBACK_PLAYER` | 2 | 40 % | mfe_decay(1), TP_FULL(1) |
| `tt_pullback × VOLATILE_RUNNER` | 2 | 27 % | profit_giveback(2) |

→ **Lever #1 confirmed: scope a giveback-relax to `gap_reversal_long ×
VOLATILE_RUNNER` only**, exactly mirroring the V15 P0.7.51
`HARD_FUSE_RSI_EXTREME` pattern. Other personalities/setups keep the tight 60 %
giveback.

### B. Loser deepening — worst 10 by $

| # | Ticker | Side | Setup | Pers | Regime | $loss | %loss | MFE % | Entry-time flags |
|---|---|---|---|---|---|---:|---:|---:|---|
| 1 | INTC | LONG | gap_reversal_long | VOLATILE_RUNNER | TRENDING | −387.94 | −3.23 | 0.4 | pdz_d=premium_approach |
| 2 | CVNA | LONG | gap_reversal_long | VOLATILE_RUNNER | TRANSITIONAL | −369.34 | −2.51 | 0.0 | **APdiv**, pdz_d=discount_approach |
| 3 | MDB | LONG | gap_reversal_long | VOLATILE_RUNNER | TRANSITIONAL | −360.11 | −4.01 | 0.9 | pdz_d=premium_approach |
| 4 | CSX | LONG | tt_pullback | PULLBACK_PLAYER | TRENDING | −355.94 | −2.75 | 0.4 | **F4sev**, APdiv, ARdiv, pdz_d=premium_approach |
| 5 | ALB | LONG | gap_reversal_long | VOLATILE_RUNNER | TRANSITIONAL | −323.13 | −3.46 | 0.0 | pdz_d=premium_approach |
| 6 | SN | LONG | gap_reversal_long | VOLATILE_RUNNER | TRANSITIONAL | −308.49 | −3.07 | 0.8 | pdz_d=premium_approach |
| 7 | NVDA | LONG | tt_n_test_support | VOLATILE_RUNNER | TRENDING | −268.43 | −2.01 | 0.3 | pdz_d=premium_approach |
| 8 | EME | LONG | tt_range_reversal_long | PULLBACK_PLAYER | TRENDING | −246.64 | −1.87 | 1.0 | **F4sev**, APdiv, ARdiv |
| 9 | STX | LONG | gap_reversal_long | VOLATILE_RUNNER | TRENDING | −230.59 | −2.59 | 0.8 | APdiv, pdz_d=premium |
| 10 | JD | SHORT | tt_n_test_resistance | VOLATILE_RUNNER | TRENDING | −207.76 | −1.57 | 0.0 | pdz_d=discount_approach |

**Single-flag entry-veto candidates (LONG only):**

| Flag | n | W | L | WR | net $ | avg pnl % |
|---|---:|---:|---:|---:|---:|---:|
| `has_adverse_phase_div` | 74 | 42 | 32 | 57 % | +$4,428 | +0.71 % |
| `has_adverse_rsi_div` | 25 | 10 | 15 | **40 %** | +$1,566 | +0.63 % |
| `is_f4_severe` (= APdiv ∧ ARdiv) | 18 | 7 | 11 | **39 %** | +$15 | +0.16 % |

`has_adverse_phase_div` alone is too noisy to veto on (74 trades, 57 % WR — and
it's actually net +$4.4K, partly because `tt_gap_reversal_long × VOLATILE_RUNNER`
is so dominant). `has_adverse_rsi_div` alone is sharper but still too broad.

**`is_f4_severe` is the right surface — it's the intersection (both ARdiv AND
APdiv at entry), already computed in `entry_signals` at `worker/index.js:19808`
and `worker/index.js:30802`.** Net +$15 over 18 trades = the universe is *exactly*
break-even on this slice, but it is highly bimodal:

- 11 losses summing **−$1,545**.
- 7 wins summing +$1,560 (4 of them are `tt_gap_reversal_long × VOLATILE_RUNNER`
  worth +$946 alone — ALB, FIX, IBP, MP).

→ Recommended scoped veto:
```
block when is_f4_severe && side==LONG
            && entry_path != 'tt_gap_reversal_long'
            && personality != 'VOLATILE_RUNNER'
```

That carves out the proven workhorse and removes every loser except FIX
(which broke even). Counterfactual on the 9 carved-out losers: avg
loss = −$172, total saved ≈ **+$1,545**. Of the 7 wins it would also block,
3 (ALB +$510, FIX_pull +$264, MP +$130) would be blocked under the strict
predicate above; the other 4 (gap_reversal_long winners) would remain. Net
expected lift ≈ **+$700–$900** *after* foregoing those 3 winners. Very
small downside risk because 38 % WR is the worst single-flag bucket we've
identified.

**Regime breakdown** — no actionable pattern. CHOPPY (n=6) wins everything
(83 % WR, +$576) but the sample is too small to overweight. TRENDING (n=108)
and TRANSITIONAL (n=42) are within 5 pp of each other (57 % vs 62 % WR).

### C. Loop 1 effectiveness

Combos at n≥3 sorted by WR:

| Combo (`setup:regime:personality:side`) | n | W | L | WR | $pnl |
|---|---:|---:|---:|---:|---:|
| `tt_ath_breakout:trending:pullback_player:L` | 10 | 3 | 7 | **30 %** | −$324 |
| `tt_range_reversal_long:transitional:volatile_runner:L` | 3 | 1 | 2 | 33 % | +$425 |
| `tt_range_reversal_long:trending:pullback_player:L` | 3 | 1 | 2 | 33 % | −$343 |
| `tt_ath_breakout:trending:volatile_runner:L` | 4 | 2 | 2 | 50 % | +$59 |
| `tt_gap_reversal_long:transitional:volatile_runner:L` | 18 | 9 | 9 | 50 % | −$87 |
| `tt_pullback:trending:pullback_player:L` | 6 | 3 | 3 | 50 % | +$132 |
| `tt_gap_reversal_long:trending:pullback_player:L` | 15 | 9 | 6 | 60 % | +$879 |
| `tt_gap_reversal_long:choppy:volatile_runner:L` | 3 | 2 | 1 | 67 % | +$198 |
| `tt_pullback:trending:volatile_runner:L` | 3 | 2 | 1 | 67 % | +$371 |
| **`tt_gap_reversal_long:trending:volatile_runner:L`** | **49** | **33** | **16** | **67 %** | **+$7,877** |
| `tt_gap_reversal_long:transitional:pullback_player:L` | 7 | 7 | 0 | 100 % | +$900 |
| `tt_gap_reversal_long:trending:moderate:L` | 4 | 4 | 0 | 100 % | +$1,176 |

Loop 1 BLOCK threshold is `wr ≤ 0.30` — `tt_ath_breakout:trending:pullback_player:L`
sits exactly on the line. End-of-Aug scorecard already has it as BLOCK. But
all 10 of those trades **already happened** before the scorecard accumulated
enough samples to start blocking (Loop 1 needs 3 samples). They are pure
cost. **Pre-seed Loop 1 with this combo as block** for September. Same
treatment for `tt_range_reversal_long:trending:pullback_player:L` (3W/7L
prediction with cross-month evidence).

**Combos at n=2 with both losses (under min_samples=3):**

- `tt_n_test_support:trending:volatile_runner:L` — n=2, both L, −$342

If Loop 1's `min_samples` were 2 instead of 3 this would be flagged as RAISE_BAR
already. Recommendation: **leave `loop1_min_samples` at 3** for stability; just
pre-seed scorecards with the prior month's verdict.

### D. Loop 2 effectiveness

The fresh API archive has 177 captured Loop 2 events embedded in
`entry_signals.loop_events`. Distribution by reason:

| reason | count |
|---|---:|
| `consec_5` | 86 |
| `today_pnl_-2.32` | 70 |
| `today_pnl_-3.36` | 6 |
| `today_pnl_-1.67` | 9 |
| `today_pnl_-1.84` | 3 |
| `wr_20` | 3 |

These are all replay-time blocks (no new entry attempted). The breaker
absolutely fires when it should — but most of the trips are `consec_5`
and `today_pnl_-2.32` which trigger only after the day is mostly lost.

**Identifiable losing days (n>=3 trades, pnl<−$1500 OR WR<30 %):**

- **2025-08-18**: 7 trades, WR 14 %, net **−$1,305**

That's the only day in the two-month run that meets the bar. Loop 2 *did*
fire on this day (`today_pnl_-2.32` and `consec_5` events both come from this
day's tail). The breaker correctly stopped further entries — there is no
visible day where the breaker tripped and the rest of the day would have been
green ("false-positive cost"); recovery days simply don't show up in the
monthly cohort.

**Threshold tuning verdict:** thresholds are fine. The only refinement worth
considering is making `loop2_breaker_consec_loss` cohort-aware (different
defaults for VOLATILE_RUNNER days) but that adds complexity for modest gain.

### E. PDZ usage

Long entries by daily PDZ:

| side : pdz_d | n | W | L | WR | $net |
|---|---:|---:|---:|---:|---:|
| LONG : `premium_approach` | 90 | 54 | 36 | 60 % | +$6,966 |
| LONG : `premium` | 60 | 37 | 23 | 62 % | +$5,167 |
| LONG : `discount_approach` | 3 | 2 | 1 | 67 % | +$173 |
| **SHORT : `discount_approach`** | **3** | **0** | **3** | **0 %** | **−$499** |

Long entries by 4h PDZ:

| side : pdz_4h | n | W | L | WR | $net |
|---|---:|---:|---:|---:|---:|
| LONG : `premium_approach` | 100 | 56 | 44 | 56 % | +$7,562 |
| LONG : `premium` | 46 | 33 | 13 | **72 %** | +$4,234 |
| LONG : `discount_approach` | 6 | 4 | 2 | 67 % | +$631 |
| SHORT : `discount_approach` | 2 | 0 | 2 | 0 % | −$318 |

**Two findings:**

1. The "premium = bad for longs" intuition does **not** hold. LONG entries at
   daily `premium` (60 trades, 62 % WR, +$5.2K) outperform `premium_approach`
   on WR. At 4h, `premium` LONGs hit 72 % WR — the cleanest pocket in the
   table. Don't add a "block long at premium" rule.
2. **SHORTs at `discount_approach` are 0/3 (Jul) and 0/2 (Aug 4h-window) —
   100 % L, net −$499 over 5 trades.** Sample is small but the directionality
   is unambiguous: shorting into discount is fading the obvious bounce zone.
   Worth a *targeted* SHORT-side veto:
   `block SHORT entries when pdz_4h ∈ {discount, discount_approach}`. Net
   expected lift +$300–$500 with no LONG-side impact.

### F. VWAP behavior

LONG entries by daily-VWAP distance:

| dist range | n | W | L | WR | $net | avg pnl % |
|---|---:|---:|---:|---:|---:|---:|
| [−10, −5)% | 3 | 2 | 1 | 67 % | −$155 | −0.38 % |
| [−2, 0)% | 5 | 4 | 1 | **80 %** | +$973 | +1.62 % |
| [0, +2)% | 3 | 1 | 2 | 33 % | −$45 | 0.00 % |
| [+2, +5)% | 5 | 3 | 2 | 60 % | +$469 | +0.92 % |
| [+5, +10)% | 16 | 9 | 7 | 56 % | +$148 | +0.23 % |
| [+10, +30)% | 47 | 28 | 19 | 60 % | +$2,962 | +0.74 % |
| [+30, +100)% | 65 | 39 | 26 | 60 % | **+$6,390** | +1.06 % |

**Counterintuitive but consistent:** LONG entries that are *very far above*
daily VWAP (+30 % or more — these are extended, multi-day runners) are the
single best $pnl bucket. The "extreme oversold catch" bucket (LONG far below
D-VWAP) is too thin to act on (n=3). **Do nothing here** — there is no
"VWAP overextension veto" worth adding.

LONG by daily-VWAP slope:

| slope | n | W | L | WR |
|---|---:|---:|---:|---:|
| [−0.10, +0.00) | 7 | 6 | 1 | **86 %** |
| [+0.00, +0.05) | 10 | 4 | 6 | 40 % |
| [+0.05, +0.10) | 10 | 8 | 2 | 80 % |
| [+0.10, +0.20) | 46 | 24 | 22 | 52 % |
| [+0.20, +0.50) | 45 | 24 | 21 | 53 % |
| [+0.50, +5.00) | 31 | 24 | 7 | **77 %** |

The [+0.00, +0.05) bucket (mid-flat slope, n=10, 40 % WR) is suspicious — but
n=10 is too small to scope a veto on. Mark it as **research more** for the
Sep+Oct rerun.

SHORT VWAP buckets are all 0 % WR but n=1 each — no signal.

### G. Time-of-day / day-of-week

Hour-of-day (NY EDT, approximated UTC-4):

| hour | n | W | L | WR | $net |
|---|---:|---:|---:|---:|---:|
| 09 | 9 | 8 | 1 | **89 %** | +$1,078 |
| 10 | 25 | 17 | 8 | 68 % | +$3,669 |
| 11 | 31 | 21 | 10 | 68 % | +$2,628 |
| **12** | **30** | **11** | **19** | **37 %** | +$505 |
| 13 | 35 | 21 | 14 | 60 % | +$2,272 |
| 14 | 15 | 10 | 5 | 67 % | +$1,241 |
| 15 | 11 | 5 | 6 | 45 % | +$414 |

Hour 12 (lunch) is a clear WR outlier — **30 trades at 37 % WR**.

Day-of-week:

| dow | n | W | L | WR | $net |
|---|---:|---:|---:|---:|---:|
| **Monday** | **39** | **17** | **22** | **44 %** | +$97 |
| Tuesday | 45 | 34 | 11 | 76 % | +$6,602 |
| Wednesday | 38 | 25 | 13 | 66 % | +$2,156 |
| Thursday | 13 | 7 | 6 | 54 % | +$1,666 |
| Friday | 21 | 10 | 11 | 48 % | +$1,285 |

Monday is a 30 pp drag vs Tuesday. Friday is also weak.

**Lever #5 candidate**: avoid hour 12 entries on Monday only. The intersection
slice is small (≈9 trades) but every dimension agrees. Wider Monday-block is
too aggressive — Monday gross is still positive (+$97), just very low WR.

---

## Aug 2025 standalone — what changed vs July?

| Exit reason | Jul n | Jul $ | Aug n | Aug $ |
|---|---:|---:|---:|---:|
| `mfe_decay_structural_flatten` | 11 | +2,404 | 2 | +420 |
| `TP_FULL` | 10 | +3,972 | 3 | +542 |
| `peak_lock_ema12_deep_break` | 7 | +1,705 | 3 | +472 |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 12 | +1,703 | 7 | +253 |
| **`SMART_RUNNER_SUPPORT_BREAK_CLOUD`** | **3** | **+74** | **9** | **+12** |
| **`max_loss_time_scaled`** | **6** | **−763** | **7** | **−1,356** |
| `max_loss` | 4 | −1,042 | 3 | −716 |
| `phase_i_mfe_fast_cut_zero_mfe` | 7 | −814 | 4 | −620 |

The **new pattern in Aug** is `SMART_RUNNER_SUPPORT_BREAK_CLOUD` going from
3 → 9 fires, and `max_loss_time_scaled` going from −$763 → −$1,356. Both are
exit-side:

- `SMART_RUNNER_SUPPORT_BREAK_CLOUD` averaged 14 % capture over 4 MFE≥5 %
  fires (worst rule in the run). Already protected by the `winner_protect`
  marker (`worker/index.js:7311`) but the protection only triggers when MFE
  is within 0.5 % of peak — most fires are after the 50 %+ retrace already
  happened.
- `max_loss_time_scaled` is the time-decaying SL. Under VOLATILE_RUNNER
  conditions it shrinks too fast: 9 of the 13 Jul-Aug fires came on
  VOLATILE_RUNNER trades that had MFE ≥ 1 % at some point (the trade was
  briefly working, then a normal pullback ate the budget).

A small follow-up lever (Priority 2 below) is to gate `max_loss_time_scaled`'s
4h tightening on `personality !== 'VOLATILE_RUNNER'`. Worth ~$700 in Aug
counterfactual, but harder to reason about than the 5 P1 levers above.

---

## Recommendation priority

### Priority 1 — apply now (September leg)

1. **Cohort-scoped `mfe_decay_giveback_pct_max` relax** (lever #1).
   Add new keys mirroring V15 P0.7.51 pattern:
   - `deep_audit_mfe_decay_giveback_pct_max_volrunner_gap_long = 0.75`
   - Plumb through `worker/index.js:8336-8338` and
     `worker/pipeline/tt-core-exit.js:141-143`.
2. **Lower `winner_protect_big_mfe_threshold_pct` 15 → 8 %**, raise lock
   0.60 → 0.55 (lever #2). One-line DA changes; no code changes needed.
3. **Add scoped `is_f4_severe` LONG veto** (lever #3) via new flag
   `deep_audit_f4_severe_long_block_enabled`. Carve-out:
   `entry_path == 'tt_gap_reversal_long' || personality == 'VOLATILE_RUNNER'`.

### Priority 2 — apply if P1 succeeds

4. **Pre-seed Loop 1 scorecard** for `tt_ath_breakout:trending:pullback_player:L`
   (lever #4) at the start of each new leg. This is a small change to the
   walk-forward orchestrator (carry-forward of Loop 1 state already exists
   in checkpoint).
5. **Block Monday × hour-12 entries** (lever #5). Use existing
   `deep_audit_avoid_hours` flag with day-of-week predicate; one DA value
   change.

### Priority 3 — research more, don't ship blind

6. SHORT-side `pdz_4h ∈ {discount, discount_approach}` veto. Only 5 trades
   in two months — directionally sound but needs Sep-Oct sample.
7. Cohort-aware `max_loss_time_scaled` 4h tightening (skip for VOLATILE_RUNNER).
   Higher-leverage but interacts with multiple other rules; needs forensic
   on each fire to confirm no second-order regressions.
8. VWAP daily-slope [+0.00, +0.05) bucket (40 % WR / n=10). Mark for
   tracking — could become a quality-block predicate if Sep confirms.

---

## Stuff NOT to change

1. **`tt_gap_reversal_long × VOLATILE_RUNNER`** — 49 trades, 67 % WR,
   +$7,877. The single most important cohort in the run. Every entry-side
   change must preserve this surface.
2. **HARD_FUSE_RSI_EXTREME 88/83 carve-out (V15 P0.7.51)** — only fired
   3 times in two months and all 3 were wins (avg $128/trade). The fix is
   working; don't tighten back to 85/80.
3. **Loop 2 thresholds** (`consec_5`, `today_pnl_-1.5`, `wr_<30 %` over
   last 10) — all three fired exactly once on the only catastrophic day
   (Aug 18). No false-positives observed. Leave alone.
4. **Loop 3 personality flat-cuts** — 924 fires across Jul-Aug with **zero
   profit-giveback trades** (MFE ≥ 1 % closed flat-or-worse). The dead-money
   reaping is working correctly; do not loosen.
5. **PDZ at premium for LONG** — counterintuitive but the data is
   unambiguous: 60 trades / 62 % WR / +$5.2K at daily-`premium`, 46 trades /
   72 % WR / +$4.2K at 4h-`premium`. Adding a "no longs at premium" veto
   would actively destroy edge.

---

## Appendix — analysis artifacts

- Raw API export: `data/trade-analysis/phase-c-stage1-jul2025-may2026/analysis/trades-fresh.json`
  (173 trades, 1.6 MB).
- Full numerical breakdown: `data/trade-analysis/phase-c-stage1-jul2025-may2026/analysis/analyze.out`.
- Reproducible analysis script: `data/trade-analysis/phase-c-stage1-jul2025-may2026/analysis/analyze.py`.
