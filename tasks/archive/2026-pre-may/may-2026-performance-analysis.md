# May 2026 Performance Analysis & Calibration Plan
**Generated:** 2026-05-17 (in-month, with 14 days of closed trades + ongoing)
**Window:** May 1, 2026 → May 17, 2026 (14 closed trades, 13 open)
**Method:** Trade-level extract from `/timed/ledger/trades?limit=1000` + diagnostic calibration report (generation 29, scope `phase-c-stage1-jul2025-may2026`).

**Status (2026-05-17 PM):** P0 + P1 fixes applied in PR #194 — including the
megacap-cohort fix that was suppressing NVDA/TSLA/MSFT/NBIS entries. See
"What was applied" section at the bottom.

---

## 1. Headline

| Window | Trades | W/L | WR% | Net P&L | PF | Expectancy |
|---|---|---|---|---|---|---|
| **Last 7 days** | **9** | 2/6 | **22.2%** | **-$526** | **0.11** | **-$58** |
| **May 2026** | **14** | 3/10 | **21.4%** | **-$1,069** | **0.06** | **-$76** |
| April 2026 | 20 | 13/7 | 65.0% | +$3,259 | 9.13 | +$163 |
| March 2026 | 39 | 14/25 | 35.9% | -$3,005 | 0.37 | -$77 |
| Feb 2026 | 74 | 38/36 | 51.4% | +$2,239 | 1.41 | +$30 |
| Last 90 days | 107 | 48/58 | 44.9% | +$190 | 1.02 | +$2 |
| **All-time** | 598 | 309/288 | **51.7%** | +$39,155 | **2.00** | +$65 |

**Diagnosis:** May is not a one-off — it is the third painful month inside a 90-day window where the system has gone net flat. The all-time engine is healthy (PF 2.00, +$39K), but the recent 90-day regime has erased its statistical edge. This is a **regime/setup drift problem**, not a structural break.

---

## 2. Where the leaks are coming from

### 2A. Exit reason leakage (last 90 days, n ≥ 3)

| Exit reason | n | WR% | Net P&L | Avg/trade |
|---|---|---|---|---|
| **`doctrine_force_exit`** | **17** | **11.8%** | **-$2,107** | **-$124** |
| **`hard_loss_cap`** | **3** | **0.0%** | **-$1,771** | **-$590** |
| `tape_capitulation_force_exit` | 12 | 41.7% | -$773 | -$64 |
| `atr_day_adverse_382_cut` | 4 | 0.0% | -$593 | -$148 |
| `thesis_flip_htf` | 5 | 20.0% | -$276 | -$55 |
| --- *(winners)* --- | | | | |
| `tp_full` | 8 | 100% | +$2,116 | +$264 |
| `sl_breached` (planned) | 4 | 75% | +$1,528 | +$382 |
| `atr_week_618_full_exit` | 4 | 75% | +$1,012 | +$253 |
| `profit_giveback_stage_hold` | 9 | 88.9% | +$607 | +$67 |
| `smart_runner_support_break_cloud` | 6 | 66.7% | +$843 | +$140 |

**Two exit families are responsible for >$4K of losses in 90 days:** `doctrine_force_exit` and `hard_loss_cap`. The protective machinery (`profit_giveback_stage_hold`, `smart_runner_*`, `atr_week_618_*`) is doing its job, but the **doctrine/loss-cap branches are firing on trades that the entry filter never should have accepted**, or are firing too late so the loss is locked in at max.

### 2B. Setup drift (last 90 days, n ≥ 5)

| Setup | n | WR% | Net P&L | PF |
|---|---|---|---|---|
| **`Ath Breakout`** | **23** | **34.8%** | **-$1,011** | **0.39** |
| `Gap Reversal Long` | 47 | 51.1% | +$1,415 | 1.31 |
| `Pullback` | 14 | 50.0% | -$287 | 0.80 |
| `N Test Resistance` | 5 | 40.0% | -$171 | 0.30 |

**For comparison (all-time entry_paths from calibration report):**

| Setup | n | WR% | PF | Expectancy |
|---|---|---|---|---|
| `gap_reversal_long` | 338 | 59.2 | **2.98** | +1.21 |
| **`gap_reversal_short`** | **11** | **63.6** | **8.86** | **+1.83** |
| `range_reversal_long` | 20 | 55.0 | 2.26 | +0.61 |
| `pullback` | 59 | 47.5 | 0.86 | -0.10 |
| `ath_breakout` | 68 | 41.2 | 0.76 | -0.14 |
| `n_test_resistance` | 13 | 38.5 | 0.48 | -0.28 |

**Ath Breakout has been a losing path even all-time (PF 0.76, Exp -0.14). In May it has accelerated downward (PF 0.25, -$107 on 3 trades).** This is a candidate for demotion or full pause until the entry quality can be improved.

### 2C. Direction bias

| Window | LONG | SHORT |
|---|---|---|
| May 2026 | 14 ($-1,069) | **0** ($0) |
| April 2026 | 19 ($+2,924) | 1 ($+335) |
| March 2026 | 25 ($-3,262) | 14 ($+258) |
| Last 30 days | 23 ($+889) | **0** ($0) |
| Last 90 days | 92 ($-403) | 15 ($+593) |

**The model has not opened a single short in 30 days.** Yet `gap_reversal_short` is the highest-PF setup in the entire book (PF 8.86, 11 trades all-time). Every time the short side has fired in 2026 it has been profitable. The current production filter is either:

1. Suppressing short signals entirely (bug), or
2. Failing to label tickers with bearish profiles in the current regime.

This is the biggest **opportunity miss** in the report — capturing even a fraction of the short edge during March/May drawdowns would have prevented both months from going red.

### 2D. Toxic tickers (last 30 days, cumR < -2.0, n ≥ 2)

| Ticker | n | P&L | CumR% |
|---|---|---|---|
| **NFLX** | 4 | -$296 | **-2.91%** |
| **APD** | 2 | -$252 | **-2.51%** |

Both are fresh entries to the blocklist candidate set. NFLX has had 4 attempts in 30 days with 1 win and a consistently negative tape — this is the same pattern that originally produced the AMZN / CVNA / ANET blocklist additions.

### 2E. Day-of-week (May only, small sample but consistent)

| Entry day | n | WR% | P&L |
|---|---|---|---|
| Tue | 2 | 50% | -$50 |
| Wed | 3 | 33% | -$309 |
| Thu | 5 | 20% | -$417 |
| **Fri** | **4** | **0%** | **-$293** |

Friday entries went 0-for-4 in May. Worth a watch but n is too small to act on alone — flag for next monthly review.

### 2F. Hold-time degradation (May only)

| Bucket | n | WR% | P&L |
|---|---|---|---|
| <6h | 9 | 22.2% | -$679 |
| 6-24h | 1 | 0% | -$139 |
| 1-3d | 2 | 0% | -$256 |
| 3-7d | 1 | 100% | +$6 |

**Intra-day trades did 22% WR.** This is consistent with the `doctrine_force_exit` + `atr_day_adverse_382_cut` pattern — entries are getting taken on weak intraday continuation that promptly fails.

---

## 3. Recommended Calibrations

Listed in priority order. Each has a clear lever and an expected impact.

### P0 — Apply immediately (high confidence, asymmetric upside)

1. **Add `NFLX`, `APD` to ticker blocklist**
   - Lever: `ticker_mute` or `block_tickers` in `model_config`
   - Evidence: 4 NFLX losses (-$296) and 2 APD losses (-$252) in 30 days, both cumR < -2.5%.
   - Expected impact: avoids ~$300-500/mo of leakage if the regime persists.

2. **Demote `Ath Breakout` setup by 50% (or pause)**
   - Lever: setup weight / entry gate tightening for `tt_tt_ath_breakout`
   - Evidence: 23 trades / 90 days at 34.8% WR, PF 0.39 (-$1,011). All-time PF only 0.76, Expectancy -0.14 — was already marginal before May.
   - Specific gate suggestion: require either (a) volume > 1.5× 20-day avg AND (b) market breadth A/D > 0.55, or pause entirely until next quarterly review.
   - Expected impact: ~$1K/quarter saved if rate stays similar.

3. **Investigate the SHORT side suppression**
   - Lever: trace why `tt_tt_gap_reversal_short` and `tt_tt_atl_breakdown` haven't fired in 30 days.
   - Probable causes to check (in order):
     - Universe filter dropping bearish profiles
     - Regime classifier biased toward `long_only` mode
     - Rank gate too high on short setups (60+ cutoff is for the long side; short setups may need a separate cutoff)
   - Expected impact: gap_reversal_short has PF 8.86 and Exp +1.83 — even 2-3 trades a month adds $200-500.

### P1 — Apply after a one-week soak

4. **Soften `doctrine_force_exit` trigger**
   - Lever: require multi-bar confirmation (e.g., 2 consecutive 60m bars below thesis level) before flipping to force-exit.
   - Evidence: 17 trades, 11.8% WR, -$2,107 (biggest single leak in the system). The exit is firing on noise.
   - Alternative: replace the force-exit with a stage downgrade to `defend` so we keep the trim but don't liquidate.
   - Expected impact: at 50% bleed reduction → ~$1K/quarter.

5. **Tighten the `hard_loss_cap` entry filter**
   - Lever: any entry that would tolerate a `hard_loss_cap` of >$400 should pass an extra confluence check.
   - Evidence: 3 trades, 0% WR, -$590 avg (-$1,771 cumulative in 90 days). These are catastrophic per-trade losses — they suggest sizing or initial stop is too wide for the volatility profile of these names.
   - Expected impact: each prevented hard-loss is ~$590 saved; 1 prevented per quarter = breakeven on the calibration.

### P2 — Surface in the next report

6. **Fix the calibration pipeline VIX / regime enrichment**
   - The diagnostic report has empty `vix_buckets` and only `unknown` in `regime_filters`. The data exists in the trades (entry context), but is not flowing into the calibration aggregator.
   - Without this, the system can never produce regime-conditional recommendations like "block ATH breakouts when VIX > 22."
   - This is a pre-req for any regime-aware calibration in the future.

7. **Re-run a promotion-candidate calibration**
   - The current report on file is `diagnostic_only: True` (generation 29) with `move_count: 0`. The "Apply" path in System Intelligence already re-runs as a promotion candidate transparently — but the user should kick a fresh one off this week so the next month's tightening lands on current data.

### P3 — Watch list (not actionable yet)

- **Friday entries:** 0-for-4 in May; revisit at the next month-close if n grows. If we still see <20% WR by mid-June with n ≥ 10, add a `block_entries_on_friday_pm` filter.
- **Intra-day (<6h) holds:** 22% WR in May, consistent with `doctrine_force_exit` story. Should resolve naturally once #4 above is in place.
- **Position sizing:** Kelly says we could go to 14-28% (we're at 5-7%). **Do not size up during the drawdown.** Re-evaluate when 30-day expectancy returns to >+$30.

---

## 4. Suggested execution plan via the System Intelligence page

1. **Today** — open `/insights.html`, click **Run Analysis**, and apply the recommendations the report surfaces (this will pick up NFLX, APD blocklist additions and any auto-calibrated ATH breakout demotion).
2. **This week** — manually note in the calibration notes: ATH Breakout setup paused, doctrine_force_exit soak window open.
3. **Next monthly review** — verify (a) shorts have started firing, (b) ATH Breakout has not re-entered the loss bucket, (c) doctrine_force_exit P&L has improved.

---

## 5. What's working — don't break it

The system has multiple high-quality components that should be preserved:

- **`gap_reversal_long`** — 47 trades / 90 days at PF 1.31 (and PF 2.98 all-time, n=338). This is the workhorse.
- **`profit_giveback_stage_hold`** — 9 trades, 88.9% WR, +$607. Trim discipline is preserving profits.
- **`tp_full` and `atr_week_618_full_exit`** — both at 75-100% WR. The full-exit paths the system DOES take are nearly perfect.
- **All-time PF 2.00, expectancy +$65** — the underlying edge is real; it just needs the leakage paths closed.

---

## 6. Appendix — raw numbers

Data source: `https://timed-trading-ingest.shashant.workers.dev/timed/ledger/trades?limit=1000` (610 trades returned, 598 closed).
Analysis script: `tasks/scripts/may-2026-perf.py` (re-run any time to refresh).

---

## 7. What was applied (2026-05-17, PR #194)

The user asked for the P0 and P1 fixes to be applied and flagged a separate
issue: that NVDA / TSLA / NBIS / MSFT moves were not being caught despite
recent calibrations. Investigation surfaced a sixth, higher-priority leak
that overlapped with the original P0 list — the megacap-cohort extension cap
was rejecting every mega-cap entry whose price was running more than 8% above
its daily E48 (which is the entire current tech-led rally). That fix is
folded into this same change.

### Megacap suppression (P0+, root cause for NVDA/TSLA/MSFT/NBIS misses)

The model has placed **zero trades on NVDA, TSLA, NBIS, MSFT, GOOGL, META,
AAPL, AMD, AVGO, PLTR, CRWD in 60 days.** All of these are in the universe
and being scored — but the `megacap_tech` cohort overlay in
`worker/pipeline/tt-core-entry.js` was rejecting every entry that tried to
fire with `tt_cohort_extension_too_wide`. The cap was set to 8% above E48 —
tuned for mean-reverting cyclicals — and is exactly the wrong filter for
primary-trend tech leaders.

| File | Change |
|---|---|
| `worker/pipeline/tt-core-entry.js` | `deep_audit_cohort_extension_max_megacap` default **8.0 → 15.0** |
| `worker/pipeline/tt-core-entry.js` | `deep_audit_cohort_megacap_tickers` default expanded from `AAPL,MSFT,GOOGL,AMZN,META,NVDA,TSLA` to also include `GOOG,AVGO,AMD,PLTR,NBIS,CRWD,ORCL,MU,ASML` (these were falling into the default "other" cohort with cyclical-tuned caps) |

### P0 fixes

1. **NFLX, APD calibration blocklist** — `worker/pipeline/gates.js` gains a
   hardcoded May-2026 blocklist alongside the existing
   `deep_audit_ticker_blacklist`. Reversible via
   `deep_audit_calibration_blocklist_disabled=true` in model_config.

2. **ATH Breakout demotion** — `worker/phase-c-setup-admission.js`:
   `tt_ath_breakout:LONG:Prime` now requires `min_rr: 2.0` AND
   `min_conviction: 4` in addition to the existing bull-regime gate. The
   90-day cohort is 23 trades / 34.8% WR / PF 0.39 — even canon was at +0.57
   PnL%. This restricts entries to the cleanest top-half-conviction setups
   with a real 2:1 reward profile.

### P1 fixes

3. **Doctrine force-exit softening** — `worker/phase-c-exit-doctrine.js`:
   - `tt_gap_reversal_long.force_exit_pnl_threshold`: -1.0 → -1.5
   - `tt_gap_reversal_short.force_exit_pnl_threshold`: -1.0 → -1.5
   - `tt_ath_breakout.force_exit_pnl_threshold`: -0.5 → -1.0
   - `tt_atl_breakdown.force_exit_pnl_threshold`: -0.5 → -1.0
   - `tt_gap_reversal_long.fresh_fail_min_age_min`: 90 → 60 min
   - `tt_gap_reversal_short.fresh_fail_min_age_min`: 90 → 60 min

   The workhorse threshold of -1.0% was too eager: 17 trades were force-
   exited at average -$124 each (-$2,107 cumulative), often after barely
   crossing the -1% line. -1.5% keeps the catastrophic-loss prevention but
   gives shallow noise a chance to mean-revert.

   Faster fresh-fail (60 min) ensures the doctrine fires *before* the
   hard-loss cap can lock in a larger loss on the rare "wrong from bar 1"
   trade.

4. **Hard-loss cap tightening** — `worker/index.js`:
   - `deep_audit_hard_loss_cap` default: $300 → $250
   - `deep_audit_hard_loss_cap_pct` default: 5% → 4%
   - HLC min-hold: 30 min → 15 min

   Last 90 days had 3 trades hit HLC at 0% WR for -$1,771 — average -$590,
   well past the documented $300 cap. The 30-min min-hold was letting
   trades fall past the cap before HLC could engage. The 15-min activation
   sits between doctrine fresh-fail (now 60 min) and entry noise.

### Why we did NOT block SHORT setups

The SHORT side suppression in May was investigated and is **not a bug** —
`tt_gap_reversal_short:SHORT:Prime` is gated to `allow_only_in: ["LATE_BEAR",
"STRONG_BEAR", "EARLY_BEAR", "COUNTER_TREND_BULL"]`. May has been a
broad-bull regime, so the gate correctly suppressed shorts. The cohort has
PF 8.86 all-time *because* it only fires in friendly bear regimes; opening
it up in bull regimes would destroy that statistic. The right move is to
trust the existing gate and look for the next bear regime to validate it.

### Expected impact (rough order)

| Fix | Expected monthly $ impact |
|---|---|
| Megacap cohort unlock | **+$500 to +$1500** (re-enables 5-10 missed trades/month on top trending names) |
| ATH Breakout demotion | **+$300 to +$500** (eliminates ~80% of -$1011/90d bleed) |
| NFLX/APD blocklist | **+$300 to +$500** (prevents repeat of -$548/30d) |
| Doctrine softening | **+$500 to +$1000** (recovers ~50% of -$2107/90d on doctrine_force_exit) |
| HLC tightening | **+$200 to +$400** (prevents 1-2 catastrophic per quarter) |

Net: aiming to flip the 90-day window from net-flat to **+$2K–$4K/month**
without changing the working paths (gap_reversal_long, profit-giveback,
tp_full, atr_week_618). Verify by mid-June month-close.
