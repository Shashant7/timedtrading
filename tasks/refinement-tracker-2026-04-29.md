# V15 Refinement Tracker — Living Fix List

**Live savepoint:** `v16-fix1-p716-jul-30m-1777422817`
**Started:** 2026-04-29
**Cadence:** 30m (live + backtest, validated against 5m/10m comparison)

---

## Live baseline (July 2025)

113 trades, **WR 54.9%**, **PnL +304.13%**, **PF 5.01**, **+12.15% account**, **max DD -1.65%**

Best WIN: +49.26% · Worst LOSS: -8.65% · Avg WIN: +6.13% · Avg LOSS: -1.49%

Status mix: 62 WIN / 51 LOSS (no OPEN, all positions closed at Jul 31).

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

### Active queue

#### FIX 6 — Fast-trim TP1 floor 🟡 IN PROGRESS
- **Source:** v16-ctx4 + v16-fix1-p716 autopsy
- **Issue:** TP1 set at 0.618× swingATR, often microscopic (KTOS +0.25%, LITE +0.18%)
- **Affected trades:** ~23 trimmed within first 30m bar at avg +0.96%
- **Fix:** enforce minimum trim distance: `max(1.5× ATR, 1.5% of price, current TP1)` in `build3TierTPArray`
- **Expected uplift:** +1-2pp avg trim PnL → fewer noise trims, more meaningful first locks
- **Validation:** July smoke vs live baseline (113 trades, 304% PnL) — no winner regression, instant_30m cohort N drops

#### FIX 2 — Winner-protect anchor (highest absolute upside)
- **Source:** Autopsy section 4
- **Issue:** Winners gave back 156.3pp combined MFE. Top examples:
  - JOBY: MFE 33.5% kept 12.4% (gave back 21pp)
  - AEHR: MFE 42% kept 21% (gave back 21pp)
  - U: MFE 28.4% kept 12.1% (gave back 16pp)
  - BE, RIOT, IREN, APLD all >9pp giveback
- **Affected trades:** 15 winners with MFE >5pp giveback
- **Fix:** when MFE ≥15%, lock SL at `entry + 0.6 × (peak - entry)` (capture 60% of peak as floor)
- **Recoverable PnL:** **+78.17%** (across 15 trades)
- **Validation:** July smoke. Top winners' kept-PnL increases without hurting WR

#### FIX 4 — Rapid stop-out cohort (entry quality)
- **Source:** Autopsy section 5
- **Issue:** 27 trades with MFE <0.5% (never went green). Combined PnL -53.93%
- **Pattern from v16-ctx4 deeper dive:**
  - 74% had bull_stack=true (not regime mismatch)
  - 31% in TRENDING regime (not regime mismatch)
  - 28 of 61 had rank ≥100 (high-quality scores still failed)
  - 8 of 51 entered BELOW EMA21 (questionable structural position)
  - 11 of 51 entered MORE THAN +5% above EMA21 (extended)
- **Fix candidates:**
  - (a) Block entries when `pct_above_e21 > 4%` (extension cap)
  - (b) Require RVol >= 1.2× for new entries
  - (c) Require closing 30m bar to be in same direction as setup (e.g., LONG only on bullish 30m close)
- **Recoverable PnL:** **-53.93%** if we eliminate the cohort
- **Validation:** July smoke — N drops 27→<10, no top winners blocked

#### FIX 7 — Friday last-hour entry block
- **Source:** weekend overnight risk analysis
- **Issue:** Friday entries ≥3pm ET have 29% WR vs Friday early 71% WR
- **Affected trades:** 7 in Jul-Oct (small sample)
- **Fix:** block new entries Friday after 3:00 PM ET except on strong same-bar gap reversals
- **Recoverable PnL:** ~+2pp (small but clean)
- **Validation:** July smoke — Friday-late entry count drops, no winner regression

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
