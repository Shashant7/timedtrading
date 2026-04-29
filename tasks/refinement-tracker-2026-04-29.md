# V15 Refinement Tracker — Living Fix List

**Live savepoint:** `v16-fix4-jul-30m-1777446799` (was: v16-fix6-jul-30m-1777437995)
**Started:** 2026-04-29
**Cadence:** 30m (live + backtest, validated against 5m/10m comparison)

---

## Live baseline (July 2025) — current at v16-fix4

**Headline:** 104 trades, **WR 64.4%**, **PnL +456.88%**, **PF 7.24**

**Organic-exit-only** (excluding 13 replay_end_close artifacts which are positions still open at Jul 31):
- 91 trades, **WR 61.5%**, **PnL +123.38%**, **PF 3.80**, Avg WIN +2.99%, Avg LOSS -1.26%

The headline numbers are inflated by month-end runners that won't exit at the same prices in longer windows. Organic-exit metrics are the truer measure. Either way:
- WR jumped from 54.9% (pre-fixes) to 64.4% (full sample) / 61.5% (organic only)
- The fix sequence is genuinely improving entry/exit decisions

### Iteration history (July 2025 baseline)
| Run | Trades | WR | PnL | PF | Notes |
|---|---|---|---|---|---|
| Pre-fixes (v16-fix1-p716) | 113 | 54.9% | +304.13% | 5.01 | After P0.7.13-17 (orphan + cadence fixes) |
| FIX 6 (TP1 floor) | 114 | 54.4% | +305.50% | 5.04 | Minor uplift, no regression |
| FIX 2 (winner-protect) | 114 | 54.4% | +300.90% | 4.98 | ❌ rejected (-4.6pp) |
| **FIX 4 (late-day block)** | **104** | **64.4%** | **+456.88%** | **7.24** | ✅ Big win; org-only +123% |

### Insights from regime analysis

| Cohort | N | WR | PnL | PF |
|---|---|---|---|---|
| **vol_drop days (VIXY ≤-3% to +1%)** | 22 | **73%** | **+186.02%** | **14.2** |
| vol_calm | 78 | 53% | +84.13% | 2.5 |
| vol_up | 13 | 38% | +33.98% | 6.8 |
| **risk_on rotation** | 47 | **60%** | **+216.00%** | **7.1** |
| risk_off | 42 | 57% | +68.70% | 5.5 |
| balanced | 24 | 42% | +19.42% | 1.8 |
| **TRENDING regime** | 86 | 56% | +216.62% | 5.3 |
| TRANSITIONAL | 23 | 56% | +98.57% | 8.4 |
| CHOPPY | 4 | 25% | -11.06% | 0.1 |

### Insights from MTF concordance

| Bucket | N | WR | PnL |
|---|---|---|---|
| **misaligned (<50% TFs agree)** | 103 | 53% | **+249.66%** | ⚠ Counterintuitive — most trades classified as "misaligned" still produce most of the PnL. Likely a snapshot data issue. Investigate. |
| mostly_aligned (75-100%) | 5 | 40% | +47.96% |
| half_aligned (50-74%) | 5 | 100% | +6.50% |

### Cross-asset spread (winners vs losers)

| Asset | Win avg | Loss avg | Spread |
|---|---|---|---|
| Energy | +0.32% | -0.05% | **+0.36pp** ← Strong winners on energy strength |
| BTC | -0.56% | -0.06% | **-0.50pp** ← Strong winners on BTC weakness (risk-off rotation) |
| Oil | +0.60% | +1.04% | -0.44pp |

---

## Areas of Opportunity (ranked by recoverable PnL impact)

### Status legend
- 🟢 **VALIDATED** — fix shipped, smoke run confirmed improvement, no regression
- 🟡 **IN PROGRESS** — being implemented or in smoke validation
- ⚪ **PLANNED** — identified but not started
- 🔴 **DEFERRED** — known-broken but waiting for higher-priority fix
- ❌ **REJECTED** — investigated but data didn't support the fix

### Validated fixes (already in live savepoint)

| ID | Fix | Status | Impact |
|---|---|---|---|
| **P0.7.13** | D1 reconciliation re-enabled on clean-lane runs | 🟢 | Eliminates orphan-trade bug |
| **P0.7.14** | D1 reconciliation uses run_id, not lock value | 🟢 | Same |
| **P0.7.15** | SMART_RUNNER cloud-hold uses TOTAL trade PnL | 🟢 | -7.51% → -1.01% on this rule |
| **P0.7.16** | Live cron isolated from backtest trades | 🟢 | Zero wall-clock anomalies (was 12) |
| **P0.7.17** | Live exits gate on 30m cadence | 🟢 | Live behaves like 30m backtest |
| **P0.7.18 (FIX 6)** | TP1 floor: max(1.5x ATR, 1.5% price) | 🟢 | +1.37pp PnL, +0.03 PF, no regression |
| **P0.7.20 (FIX 4)** | Block entries 15:30-16:00 ET (last 30min before close) | 🟢 | **+151pp PnL, +10pp WR, +2.20 PF** |

### Active queue

#### FIX 6 — Fast-trim TP1 floor 🟢 VALIDATED (P0.7.18)
- **Source:** v16-ctx4 + v16-fix1-p716 autopsy
- **Issue:** TP1 set at 0.618× swingATR, often microscopic (KTOS +0.25%, LITE +0.18%)
- **Fix:** enforce minimum trim distance: `max(1.5× ATR, 1.5% of price)` in `build3TierTPArray`
- **DA keys:** `deep_audit_min_trim_atr_mult=1.5`, `deep_audit_min_trim_pct=0.015`
- **Validated July smoke (`v16-fix6-jul-30m-1777437995`):**
  - 114 trades vs 113 (+1)
  - WR 54.4% vs 54.9% (-0.5pp; within tolerance)
  - **PnL +305.50% vs +304.13% (+1.37pp)**
  - **PF 5.04 vs 5.01 (+0.03)**
  - All top 10 winners preserved (GEV +2pp, others identical)
  - instant_30m cohort: 7 vs 6 (avg trim dist 1.13% vs 1.32%)
- **Note:** P0.7.16 already cleaned up most tiny trims. The remaining instant_30m cohort had legitimate moves > 1.5%. The floor is in place as a safety net for future low-vol scenarios.
- **Promoted live:** 2026-04-29 05:48 UTC

#### FIX 5 — max_loss hard cap at -2.0% ❌ REJECTED (design-time, no smoke run)
- **Hypothesis:** Tighten max_loss from -3% to -2% to save 7pp on 8 max_loss trades.
- **Validation FAILED (counterfactual analysis on FIX 4 baseline):**
  - 19 trades hit -2% MAE during their lifetime
  - 3 of them were WINNERS that recovered: **LITE +111.11%, IREN +10.21%, CLS +0.14%**
  - Cap at -2% would lose **+121.46pp** in winners to save **+44.53pp** in losers
  - **Net: -76.93pp** ← catastrophic
- **Conclusion:** REJECTED. The current -3% threshold protects the long-tail winners that drive the entire system. The 8 max_loss exits are a necessary price to pay.

#### FIX 11 — Pullback rapid-stop entry filter ❌ REJECTED (design-time)
- **Hypothesis:** tt_pullback path has 40% WR and 4 rapid stops in 15 trades. Find an entry-time signal to filter losers but spare the 2 huge winners (LITE +111, AVGO +50).
- **Investigation findings:**
  - Rank: rapid stops 98.3 vs winners 97.4 (no diff)
  - Conviction: rapid stops 88.4 vs winners 90.6 (no diff)
  - SuperTrend alignment: similar across cohorts
  - bull_stack: 100% True for both wins and losses
  - state: 100% HTF_BULL_LTF_BULL for both cohorts
  - rsi_m30: wins 45-62 (avg 55), losses 49-65 (avg 57) — no clean separator
  - rvol30: wins avg 5.59, losses avg 3.34 — overlap is large
  - e21_slope: wins +0.81, losses +1.15 (counterintuitive — losers have STEEPER slope)
- **Conclusion:** REJECTED. Pullback losers are statistically indistinguishable from winners at entry. Without a clean discriminator, any filter risks killing LITE +111% and AVGO +50% (which collectively make tt_pullback profitable). The existing `phase_i_mfe_fast_cut_*` tiers already do post-entry work. Accept the cohort variance.

#### FIX 9 — Progressive partial trim ❌ REJECTED (P0.7.21)
- **Source:** Replacement attempt for FIX 2 — trim more, don't move SL
- **Hypothesis:** When MFE >= 15% and >= TP1 trimmed, trim ANOTHER 25% to lock profit. SL untouched.
- **Validation FAILED (`v16-fix9-jul-30m-1777466081`):**
  - Trades 101 vs 107 (-6)
  - **WR 56.4% vs 62.6% (-6.2pp)** ← regression
  - **PnL +325.06% vs +430.63% (-105.57pp)** ← big regression
  - PF 6.90 vs 5.33 (+1.57; some confidence in remaining trades)
  - **Catastrophic winner regressions:**
    - PLTR +36.85% → 0.00%
    - PSTG +25.70% → -0.53%
    - BK +22.19% → 0.00%
    - UTHR +14.07% → 0.00%
    - AEHR +20.38% → +4.28% (-16pp)
    - BE +6.10% → 0.00%
    - FN +40.65% → +18.01% (-22pp)
- **Why it failed:** Trimming from 50% to 75% pushed trades into "near-fully-trimmed" state (>= 0.95 in some downstream rules). SMART_RUNNER and atr_week_618 paths treat heavy-trimmed runners differently — they close the residual earlier on the next signal. The smaller runner size also gets killed by noise faster.
- **Conclusion:** REJECTED. Code committed under DA flag (default `false`). To revisit: would need to also gate downstream "trimmed_pct >= X" threshold rules, or use a much smaller add (e.g., 10% instead of 25%), or fire only AFTER atr_week_618 has already triggered its partial.

#### FIX 2 — Winner-protect anchor ❌ REJECTED (P0.7.19)
- **Source:** Autopsy section 4
- **Hypothesis:** when MFE ≥15%, lock SL at `entry + 0.6 × MFE_peak` to capture 60% of peak.
- **Validation FAILED (`v16-fix2-jul-30m-1777442345`):**
  - Trades 114 (same)
  - WR 54.4% (same)
  - **PnL +300.90% vs +305.50% (-4.60pp)** ← regression
  - PF 4.98 vs 5.04 (-0.06)
  - **IREN regressed -3.94pp** (+10.21% → +6.28%): the new SL anchor caused an earlier exit on a legitimate pullback
  - Other high-MFE winners (JOBY, AEHR, U, BE, RIOT) — IDENTICAL (fix didn't fire on them because they exit via TP_FULL/atr_week_618 paths that don't read SL)
- **Why it failed:** The fix only affected SL-bound trades and made the SL TIGHTER than the existing trailing logic on a runner that subsequently retraced. The "winner-protect" idea conflicts with letting runners breathe.
- **Conclusion:** REJECTED. Code still committed under DA-flag (default `false`). To revisit, would need:
  - Either much higher threshold (e.g., MFE ≥25% before locking)
  - Or a much smaller lock pct (e.g., 0.30 — only protect against catastrophic round-trips)
  - Or a different mechanism entirely (e.g., trim a third partial when MFE >= 15%, not move SL)
- **Promoted live:** NO. Live savepoint remains v16-fix6.

#### FIX 4 — Late-day entry block 🟢 VALIDATED (P0.7.20)
- **Source:** Half-hour bucket analysis on FIX 6 baseline
- **Issue:** 3:30 PM ET (last 30min before close) entries had 24% WR / -10.40% PnL across 17 trades
- **Fix:** block new entries when `ET_minute_of_day >= (16*60 - 30)` i.e., 15:30 ET to close
- **DA key:** `deep_audit_late_day_entry_block_min` default 30
- **Validated July smoke (`v16-fix4-jul-30m-1777446799`):**
  - 104 trades vs 114 (-10, expected — that's the blocked cohort)
  - **WR 64.4% vs 54.4% (+10.0pp)** ✓
  - **PnL +456.88% vs +305.50% (+151.38pp)** ✓ (caveat: partially inflated by replay_end_close holds)
  - **PF 7.24 vs 5.04 (+2.20)** ✓
  - Best WIN +111% vs +49% (new monster: LITE held to month-end)
  - Some winner regressions: GEV +28% → +1.77% (different setup picked), APLD took a -20% loss (separate trade), AEHR took a -0.8% extra loss before its big win
  - Net winner-side trade-offs heavily positive
- **This SUBSUMES FIX 7** (Friday-late block) — every-day late entries are bad, not just Fridays
- **Promoted live:** 2026-04-29 ~08:09 UTC

#### FIX 7 — Friday last-hour entry block ✅ SUBSUMED by FIX 4
- Original target (Friday 3pm ET) was a subset of FIX 4's all-days 3:30pm block. Closed.

#### FIX 3 — Net-negative Ripster setups
- **Source:** Autopsy section 2
- **Issue (live July baseline):**
  - tt_ath_breakout: 14 trades, 50% WR, +5.20%, PF 1.4 — marginal
  - tt_n_test_support: 8 trades, 38% WR, +0.20%, PF 1.0 — barely positive
  - tt_n_test_resistance: 1 trade, 0% WR, -1.19% — too small to evaluate
- **Note:** Better than v16-ctx4 (-7.39%/-5.07% on those setups). The previous fixes (P0.7.15/16/17) already cleaned up some.
- **Decision:** monitor in next smoke. If still net-negative, tighten significance filters or disable.

#### Late-exit breakeven-stop
- **Source:** Autopsy section 5
- **Issue:** 1 loser had MFE ≥3% (was profitable then went negative). Only -0.04% PnL.
- **Note:** much smaller than v16-ctx4 had (15 trades). Most cleaned up by P0.7.15.
- **Decision:** monitor. If recurs at scale in next smoke, add breakeven-stop rule.

#### Exit-rule cluster: max_loss + phase_i_mfe_*
- **Source:** Autopsy section 3
- **Issue:** 
  - max_loss: 10 trades, 0% WR, -23.27% PnL
  - phase_i_mfe_fast_cut_zero_mfe: 11 trades, 0% WR, -13.34%
  - atr_day_adverse_382_cut: 6 trades, 0% WR, -5.82%
- **These ARE doing their job** (cutting losers fast). The underlying problem is **entry quality** (FIX 4 above). If entry quality improves, these fire less often.
- **Action:** Don't tighten exit rules. Fix entry quality first, then re-evaluate.

#### MTF concordance "misaligned" data issue
- **Source:** Autopsy section 9
- **Issue:** 103 of 113 trades (91%) classified as "misaligned" — likely the snapshot is missing st_dir fields
- **Investigation:** check if `setup_snapshot.st_dir` is being populated correctly during entry
- **Decision:** investigate after FIX 6 ships. May reveal entry filter opportunities.

### Deferred / Rejected

#### CHOPPY regime
- 4 trades, 25% WR, -11.06%
- Sample too small (4 trades) for now. Track in next smoke.

#### Counter-trend weekend exposure
- ❌ ZERO counter-trend trades held over weekend in any run. Engine already filters them. No fix needed.

#### Non-bull-stack entries
- ❌ Most losers WERE bull_stack=true at entry. Bull-stack alone isn't a useful filter — we need finer structural gates (FIX 4).

---

## Validation Methodology (per-fix)

Each fix follows this 5-step protocol:

1. **Pre-shipping baseline**: capture July metrics from `v16-fix1-p716-jul-30m-1777422817` (saved as `baseline-july.json`)
2. **Implement** in worker with comment block citing exact data evidence
3. **Deploy** + **activate DA keys**
4. **Smoke run**: July at 30m, single-fix isolation (`v16-fixN-jul-30m-<ts>`)
5. **Validate**:
   - Total trades count: ±10% of baseline (113)
   - WR: ≥ 54.9% (or within 2pp; expected up if fix is correct)
   - PnL %: ≥ +304% (or within 5%; expected up)
   - PF: ≥ 5.01 (expected up)
   - Top 5 winners: must not regress (AEHR, BE, JOBY, AVGO, BWXT, etc.)
   - Specific cohort affected: behavior change matches the hypothesis
6. **Promote** the smoke run to live_config_slot=1 if validation passes
7. **Update this tracker**: status → 🟢, add validation summary

If validation FAILS:
- Revert the code change (keep DA-key off)
- Document what went wrong in lessons.md
- Status → ❌ REJECTED with reason

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-28 | Adopt 30m for both live + backtest | Empirical 30m vs 10m vs 5m on identical July smoke: 30m beat both by 4-6× PnL on matching trades; 10m and 5m killed runners on noise wicks |
| 2026-04-28 | Mark v16-fix1-p716 as live savepoint | First validated config with all 4 critical fixes (P0.7.15-17) |
| 2026-04-28 | Defer 5m/Apr-2026 comparison until all fixes stable | Per user direction: validate fix-by-fix at 30m first |
| 2026-04-29 | Sequence: FIX 6 → FIX 7 → FIX 2 → FIX 4 → re-eval rest | Order by clarity-of-fix and cumulative compound benefit |

#### FIX 12 V3 — Quality Composite Block (P0.7.23) — VALIDATION RESULTS
- **Smoke:** `v16-fix12-jul-30m-1777477370` (92 trades vs 107 baseline)
- **Direct blocks (8 trades, -7.41% PnL):** Exactly as predicted (FIX, ETN, EME, PLTR, IWM, PH, CAT, SGI)
- **Net result:**
  - WR 67.4% vs 62.6% baseline (+4.8pp) ✓
  - PF 9.85 vs 5.33 (+4.52) ✓✓
  - Avg loss -1.48% vs -2.49% (-1.01pp) ✓
  - PnL +393.10% vs +430.63% (-37.53pp) ✗
- **Cascade effect (47 trades reshuffled, butterfly):**
  - Cascade-lost wins: LITE +111→+42, PLTR +38, PSTG +25, UTHR +14, NVDA +12, U +12 (~+233pp)
  - Cascade-dodged losses: APLD -20, CSX -18, SPY -9, ORCL -5 (~-66pp)
- **Decision pending:** trade-off between consistency (PF doubled) vs upside capture (LITE-class jackpots reshuffled)
