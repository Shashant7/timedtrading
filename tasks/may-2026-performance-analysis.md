# May 2026 Performance Analysis & Calibration Plan
**Generated:** 2026-05-17 (in-month, with 14 days of closed trades + ongoing)
**Window:** May 1, 2026 → May 17, 2026 (14 closed trades, 13 open)
**Method:** Trade-level extract from `/timed/ledger/trades?limit=1000` + diagnostic calibration report (generation 29, scope `phase-c-stage1-jul2025-may2026`).

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
