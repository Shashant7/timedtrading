# Holistic Review — Synthesis (2026-04-30)

## Headline finding

**The biggest opportunity in this system is not "fix Mar 2026" — it's "stop chopping ourselves out of trends we correctly identify."** Every analytical lens points the same direction.

| Lens | Evidence |
|---|---|
| Capture efficiency | Best setup (`tt_gap_reversal_long`, +$36k) captures only **20%** of the average MFE it generates. Avg MFE is +5.27%, avg realized is +1.05%. |
| Re-entry chains | 92 chains where we exited and re-entered the same ticker / direction within 7 days. **Holding the first entry through to the last exit instead of chopping = +$67,766** (more than the entire portfolio's realized $45k). |
| Loser MFE distribution | 60% of all losses had MFE ≥ 0.5%. **51 losses had MFE ≥ 1% AND MFE > \|MAE\|** — i.e., they went green first, then reversed. A simple lock-in rule on these saves +$12,791. |
| Exit-reason capture | The "smart" management exits (`PROFIT_GIVEBACK_STAGE_HOLD`, `SMART_RUNNER_SUPPORT_BREAK_CLOUD`) have **5–12% capture efficiency**. They give back **+$34,013** in total dollar terms across 65+45 trades. |
| TP_FULL early-fire | 68% of TP_FULL trades had MFE more than 1.5× the final realized PnL. Avg "left on the table" for those: **+5.45%** per trade. |

The model is **finding** the right tickers and directions. The exits are **destroying the edge**.

## Pillar-by-pillar findings

### Pillar 1 — Setup-level deep dive

| Setup | n | WR | avg pnl% | avg MFE% | capture% | $ |
|---|---:|---:|---:|---:|---:|---:|
| `tt_gap_reversal_long` | 332 | 56% | +1.05 | +5.27 | **20%** | +$36,059 |
| `tt_pullback` | 55 | 51% | +0.68 | +3.05 | 22% | +$4,685 |
| `tt_gap_reversal_short` | 12 | 67% | +2.37 | +7.09 | 33% | +$4,006 |
| `tt_n_test_support` | 64 | 42% | +0.22 | +2.00 | 11% | +$1,390 |
| `tt_range_reversal_long` | 26 | 46% | +0.36 | +2.48 | 14% | +$703 |
| `tt_atl_breakdown` | 7 | 43% | +0.20 | +2.97 | 7% | +$120 |
| `tt_ath_breakout` | 70 | 41% | -0.02 | +1.66 | -1% | -$50 |
| `tt_n_test_resistance` | 16 | 31% | -0.87 | +1.20 | -73% | -$1,261 |

**Every** profitable setup has capture efficiency ≤ 33%. The two losing setups (`tt_ath_breakout`, `tt_n_test_resistance`) have negative capture — meaning even when they go favorable, we exit underwater.

### Pillar 2 — Re-entry chains (the smoking gun)

| | |
|---|---:|
| Chains found (same ticker/dir, < 7d gap) | 92 |
| Sum realized $ | +$19,456 |
| Sum hold-thru $ | **+$87,221** |
| Delta (holdthru − realized) | **+$67,766** (+348%) |
| Chains where holding would have won | 81 of 92 (88%) |
| Chains where re-entry actually saved capital | 11 of 92 (12%) |

Top examples (where holding the first entry instead of chopping would have made an extra few thousand each):

| Ticker | dir | chain | days | realized% | holdthru% | delta$ |
|---|:---:|:---:|---:|---:|---:|---:|
| SNDK | LONG | 3 | 14.8 | +8.70 | +73.58 | +$8,848 |
| JOBY | LONG | 2 | 14.1 | +13.15 | +68.18 | +$6,634 |
| APLD | LONG | 2 | 17.0 | +14.55 | +53.75 | +$5,717 |
| AGQ | LONG | 3 | 14.9 | +11.34 | +39.58 | +$3,679 |
| FN | LONG | 2 | 7.9 | -4.10 | +18.35 | +$2,673 |

The first SNDK chain captured 8.7% of a 73.6% move. We were 100% right about the direction; the exit logic literally subtracted $8,848 of realized PnL. Across the whole portfolio: **−$67,766 from chopping ourselves out of correctly-called moves**.

### Pillar 3 — Held-longer counterfactual on losses

Loser MFE distribution:

| MFE bucket | n | % of losses | avg final pnl% | avg MAE% |
|---|---:|---:|---:|---:|
| no MFE | 116 | 41% | -2.00 | -1.99 |
| 0–0.5% | 0 | 0% | — | — |
| 0.5–1% | 59 | 21% | -1.10 | -1.76 |
| 1–2% | 53 | 19% | -0.93 | -2.08 |
| 2–5% | 47 | 16% | -0.96 | -2.94 |
| 5%+ | 10 | 4% | -1.05 | -3.66 |

**59% of losses (169 of 285) had MFE ≥ 0.5%.** They went green at some point. The position was right, briefly. Then we let them round-trip into MAE territory and exit at SL.

51 losses (18% of all losses) had MFE ≥ 1% AND MFE > |MAE|: the favorable move came BEFORE the adverse one. A simple "lock 0.5% on any 1% MFE" rule turns each into a small win or scratch.

**Counterfactual: a 50%-trim-at-half-MFE rule on MFE-≥-1% losses saves +$12,791 — a 28% improvement on the portfolio.**

### Pillar 4 — Best 20 / Worst 20 trade pattern

| | TOP 20 | BOT 20 |
|---|---|---|
| Avg pnl% | +12.21 | -5.29 |
| Avg duration | 232.8h (~9.7 days) | 79.9h (~3.3 days) |
| Avg MFE | +24.82% | +1.02% |
| Avg MAE | -0.47% | -6.19% |
| Personality | VOLATILE_RUNNER 18 | VOLATILE_RUNNER 17 |
| Setup | `tt_gap_reversal_long` 17 | `tt_gap_reversal_long` 16 |
| Direction | LONG 19 | LONG 19 |
| Grade | Prime 20 | Prime 17 |
| PDZ daily | premium_approach 12 / premium 5 | premium_approach 12 / **discount_approach 4** |
| Top exit | TP_FULL, RSI extreme | HARD_LOSS_CAP, max_loss |

**Same personality, same setup, same grade, same direction.** What separates winners from losers is:

1. **Duration**: winners hold ~3× longer.
2. **Drawdown tolerance during the trade**: winners survive a -0.47% adverse excursion, losers hit -6.19% MAE.
3. **PDZ context**: 4 of 20 worst trades were `discount_approach LONG` (the autopsy cohort) — confirms but doesn't dominate.

The bottom 20 are not "wrong setups" — they're **right setups stopped out by tight SLs / fast cuts during normal volatility before the move materialized**.

### Pillar 5 — Exit-timing capture matrix (the indictment)

Capture efficiency by exit reason (sorted; bigger = better):

| Exit reason | n | capture | avg pnl% | avg MFE% |
|---|---:|---:|---:|---:|
| SOFT_FUSE_RSI_CONFIRMED | 14 | 64% | +1.46 | +2.29 |
| HARD_FUSE_RSI_EXTREME | 26 | 61% | +4.02 | +6.55 |
| TP_FULL | 47 | 51% | +4.17 | +8.10 |
| peak_lock_ema12_deep_break | 22 | 43% | +3.39 | +7.88 |
| ST_FLIP_4H_CLOSE | 28 | 43% | +3.30 | +7.68 |
| atr_week_618_full_exit | 25 | 39% | +2.76 | +7.10 |
| sl_breached | 22 | 38% | +3.72 | +9.71 |
| mfe_decay_structural_flatten | 26 | 32% | +2.10 | +6.52 |
| **PROFIT_GIVEBACK_STAGE_HOLD** | 65 | **12%** | +0.60 | +5.02 |
| **SMART_RUNNER_SUPPORT_BREAK_CLOUD** | 45 | **5%** | +0.20 | +4.06 |
| **runner_drawdown_cap** | 14 | -35% | -0.63 | +1.78 |
| **phase_i_mfe_dead_money_24h** | 17 | -52% | -0.40 | +0.77 |
| **atr_day_adverse_382_cut** | 36 | -112% | -0.96 | +0.86 |
| **max_loss_time_scaled** | 37 | -99% | -1.33 | +1.35 |
| **HARD_LOSS_CAP** | 12 | -384% | -5.86 | +1.53 |
| phase_i_mfe_fast_cut_zero_mfe | 30 | -3142% | -1.43 | +0.05 |

The capture matrix splits cleanly:
- **Conviction-based exits** (RSI fuses, TP_FULL, peak_lock, ST flip, ATR week 61.8): capture 38–64%.
- **"Defensive trim" exits** (PROFIT_GIVEBACK, SMART_RUNNER_SUPPORT_BREAK): capture 5–12% — they fire while the move still has 4-5% MFE remaining.
- **Time-based / fast-cut exits**: capture is *negative*, meaning they fire after the move has already gone adverse and we exit on red.

**The defensive trim exits are leaving most of the money on the table. The fast cuts are killing salvageable trades.**

## Specific high-impact PROFIT_GIVEBACK_STAGE_HOLD analysis

- 65 trades, WR 74%, avg pnl 0.60%, avg MFE 5.02%, **avg giveback 4.50%**.
- 71 of 65 had giveback > 2%.
- **Total dollar giveback from peak: ~$34,013** across this single exit reason.

This single exit reason is responsible for ~75% of the entire $45k portfolio PnL being foregone vs. peak. Rebuilding the giveback rule alone is worth more than every other proposed fix combined.

## Re-prioritized fix list (post-holistic)

The original autopsy fixes (P1-P3) targeted **Mar 2026** specifically. The holistic review surfaces **structural** opportunities that dwarf the Mar issue. Re-rank:

### Tier S — exit-side structural changes (massive PnL upside)

**S1 — Rebuild PROFIT_GIVEBACK_STAGE_HOLD threshold per personality + setup**
- 65 trades, $34k of giveback from peak, current capture 12%.
- Hypothesis: the giveback threshold (% retracement from MFE that triggers the trim) is calibrated for moderate-volatility names. On VOLATILE_RUNNER, normal pullbacks within an uptrend are flagged as "giveback" and we trim the runner.
- Action: tune giveback threshold widening for VOLATILE_RUNNER, narrowing for MODERATE/SLOW_GRINDER.
- **Expected impact: $5-15k recovery (range, not promise).**

**S2 — Implement "lock 0.5% at any 1% MFE" floor on losses**
- 51 trades had MFE ≥ 1% before MAE killed them.
- Counterfactual: 50%-trim-at-half-MFE saves ~$12,791.
- Action: new exit rule. When MFE ≥ MIN_LOCK_THRESHOLD (default 1%) and price retraces by 50% of MFE while still > 0, lock in 50% of the position at +0.5×MFE_peak.
- **Expected impact: +$5-12k.** Lower bound because half the MFE-≥1% losses were structurally going to hit SL anyway.

**S3 — Loosen `phase_i_mfe_fast_cut_zero_mfe` and `phase_i_mfe_fast_cut_2h`**
- 30 + 15 trades, capture −3142% / −1084%, total cost −$5,250 ish.
- These cuts fire when MFE is essentially zero (avg MFE +0.05% on the 30-trade cohort).
- Hypothesis: they fire too aggressively on slow-grinding setups in the first 2-4h.
- Action: gate by personality. VOLATILE_RUNNER: keep tight. PULLBACK_PLAYER + SLOW_GRINDER: relax to 4-6h. (Aligns with autopsy P3.)
- **Expected impact: +$3-6k.**

### Tier A — re-entry / runner-protect (covered by P1a-P3 plus a new layer)

**A1 — Don't re-enter a trade we just exited from on the same ticker/direction within X hours unless conviction increased.**
- 81 of 92 chains lose money to chopping.
- Action: "re-entry tax" — require a +5 conviction-score delta (or new setup type) to re-enter within 24h of an exit. Otherwise stay flat.
- **Expected impact: hard to estimate**, because not all re-entries are bad — but capping the worst ones is real. Likely +$3-8k.

**A2 — Runner-protect with clean-entry gate (P1a from autopsy).** Same as before. The holistic confirms it: 32 trades killed by dead-money cuts had no adverse divergence at entry. Estimated +$5-10k.

### Tier B — entry-side filters (covered by autopsy P1b/P2/P2.5)

**B1 — Block strong adverse RSI div (strength ≥ 30) at entry.** P1b.
**B2 — Block `discount_approach LONG` on VOLATILE_RUNNER + PULLBACK_PLAYER.** P2.
**B3 — Block `tt_n_test_resistance · SHORT`.** P2.5 (new from Pillar 1).
**B4 — Block `tt_ath_breakout · MODERATE` and `· SLOW_GRINDER`.** New from Pillar 1, n=29 combined, both 25-47% WR with negative capture.

Combined Tier B impact: ~+$2-3k from skipping concentrated losers.

### Tier C — TP/SL recalibration

**C1 — Tier the TP_FULL trigger.**
- 68% of TP_FULL fires were "early" (MFE > 1.5× final pnl). Avg left on table: +5.45% per trade.
- Action: convert TP_FULL into a 50%-trim-at-target + 50%-runner-trail on the remainder.
- **Expected impact: hard to model on backtest data alone, but the structural problem is clear.**

## What this means for the walk-forward backtest

The autopsy-driven P1+P2+P2.5 fixes (~$3-5k expected) are still worth doing, but the **bigger lever is the exit-timing rebuild (S1-S3)**.

I'd recommend reorganizing Phase B as:

1. **Phase B-1**: P4 (entrySignals plumbing) + S2 (lock 0.5% at 1% MFE) + S3 (relax fast cuts on PULLBACK/SLOW_GRINDER). These are the cleanest, most analytically-justified changes. All implementable behind DA flags.
2. **Phase B-2**: S1 (giveback per personality) + B1-B4 (entry blocks). Higher-uncertainty, run a focused replay first.
3. **Phase B-3**: P1a (runner-protect with clean-entry gate). The autopsy's flagship fix; complementary to S2.
4. **Phase B-4**: A1 (re-entry tax) + C1 (TP tier). Higher-risk; needs its own A/B replay.

Phase C (walk-forward) takes the union of B-1 + B-2 + B-3 (skipping B-4 unless the others reach the promotion gate without it).

## Stop-and-think check

**The conventional version of this finding is overstatement.** Two cautions:

1. **MFE/MAE are bookkeeping highs/lows over the trade life.** "MFE ≥ 1%" doesn't mean we could have actually exited at the +1% peak — the price had to actually visit that level on a 30m bar close (which is what the simulator records), but liquidity and slippage on a +1% spike on a thin name is real.
2. **Holding-thru chains assumes infinite patience and infinite capital.** In reality, the 81-chain "+$67k delta" includes some chains where holding through the trough would have meant a worse experienced drawdown than realized — even if the final $ would have been higher.

**Both of these reinforce why we need walk-forward validation, not just same-data replay.** A real-data, out-of-sample test is the only honest way to know which of these "found gains" are real vs artifacts of the analysis.

## Decision

The autopsy-driven P1 batch was right but undersized. The holistic review surfaces a **2-3x larger** opportunity in exit-side structural changes (S1-S3) than was visible from a single-month deep dive.

**Recommendation**: implement Phase B-1 (S2 + S3 + P4) as the next concrete step. These are the most analytically-grounded changes and the lowest-risk to validate. Do NOT bundle S1 (giveback rebuild) with them — S1 is bigger but more speculative; it deserves its own A/B replay.

The walk-forward backtest in Phase C still happens, but with a much wider bundle to validate, and a more rigorous expectation of what "passing" means.
