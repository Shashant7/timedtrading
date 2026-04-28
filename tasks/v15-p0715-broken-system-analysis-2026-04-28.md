# V15 P0.7.15 — Broken-System Analysis from v16-ctx4 Jul-Oct Run

**Date:** 2026-04-28
**Status:** Active (targeted fixes)
**Source data:** `v16-ctx4-jul-oct-1777398500` (final state pending; analysis at day 70/87)

---

## TL;DR

The v16-ctx4 run produced **264 closed trades, WR 53%, PnL +197.97%, PF 2.19, +19.8% account equity, -0.69% max drawdown**. Healthy on the surface, but the data screams about specific broken pieces:

1. **`SMART_RUNNER_SUPPORT_BREAK_CLOUD` is the worst exit rule** — 26 trades, WR 27%, PnL -7.53%. **Root cause identified, fix shipped (P0.7.15).**
2. **21%+ MFE giveback** on 12+ winners — JOBY +33% peak / +12% kept, AEHR +42% / +21%, APP +32% / +14%, APLD +30% / +11%. Need a winner-protect anchor.
3. **3 net-negative Ripster setups**: `tt_n_test_support` (-4.15%), `tt_ath_breakout` (-3.43%), `tt_n_test_resistance` (-7.39%). Need significance filter or temporary disable.
4. **Only 10 short trades (3.8%)** in 4 months. Either regime gates too restrictive or short-side logic too conservative.
5. **Loss cluster of 44 trades** at 0% WR (max_loss, max_loss_time_scaled, phase_i_mfe_*) accounting for ~67% of total losses.
6. **3 trades had `exit_ts = Date.now()`** (force-closed via "unknown" path) — minor data integrity issue (1.1%).

---

## 1. SMART_RUNNER_SUPPORT_BREAK_CLOUD — Fix shipped (P0.7.15)

### Forensic data

| Ticker | Trim% | Realized | Runner | Total | MFE | Conclusion |
|---|---|---|---|---|---|---|
| ALB | 50% | +0.88% | +0.79% | **+0.83%** | **+12.1%** | Profitable trade killed at small runner red |
| KTOS | 50% | +1.10% | +0.90% | **+1.00%** | **+11.5%** | Profitable trade killed at small runner red |
| AEHR | 50% | +0.70% | -2.24% | -0.77% | +5.8% | Net negative but on a trade with peak +5.8% |
| AVAV | 50% | +1.29% | -1.57% | -0.14% | +4.2% | Almost flat but had +4% peak |

**19 of 26 trades had TOTAL PnL > 0 when the close fired.** They were profitable trades being killed by runner-only PnL math.

### Root cause

`evaluateRunnerExit()` returns `action: "close"` with `reason: "support_break_cloud"` when:
- Price is below 1H EMA34/50 cloud LOW
- 30m SuperTrend has flipped against the trade
- No 15m support is holding

V15 P0.6.3 had added a daily-cloud-hold deferral that let `__peak_lock_cloud_hold` rescue these trades **but gated the deferral on `_srePnlPct > 0`** — runner-only PnL.

After a 50% trim with a small pullback, runner PnL is usually slightly negative (-0.5% to -2%) even when total trade is solidly profitable. So the deferral was disabled exactly when it was most needed.

### Fix (P0.7.15)

Replace runner-only deferral gate with **total-trade PnL** (realized trim contribution + runner contribution):

```js
const _sreTotalTradePnlPct = trimFrac > 0
  ? (realizedTrimPnlPct * trimFrac) + (runnerPnlPct * (1 - trimFrac))
  : runnerPnlPct;

const _sreCanDeferSafetyNet = !cancelDef && !trimThenReassess && _sreTotalTradePnlPct > 0 && (...)
```

Keeps the same daily-cloud-hold safety net but applies it correctly to trimmed runners.

**Expected impact**: ~19/26 trades that closed at -0.05% to -2.24% on the runner half should now defer to peak_lock_exit, which would either let them run further (capturing more of the MFE) or close them at the structural daily-cloud break. Net PnL impact: -7.53% → estimated -2 to +3% (+10pp swing) on this cohort alone.

### TF & interval analysis

The cloud break uses **1H EMA34/50 + 30m SuperTrend** to detect the break, gated by **15m supports**. The deferral consults the **Daily 5/12 EMA cloud** via `__peak_lock_cloud_hold`.

Whether we run replay at 30m or 5m **doesn't change which TFs are read** — the same per-TF bundles are computed at every tick. What changes is HOW OFTEN we re-evaluate the rule (13×/day at 30m vs 78×/day at 5m). With 6× more checks at 5m, a noisy 1H wick has 6× more chances to trigger the close. **30m is actually safer for this rule** unless we tighten the cloud-break thresholds at 5m (e.g., require 2 consecutive 5m bars below the 1H cloud, not just 1).

---

## 2. MFE giveback on winners — TODO (FIX 2)

### The data

| Ticker | Setup | MFE | Kept | Giveback | Exit |
|---|---|---|---|---|---|
| JOBY | gap_reversal_long | +33.5% | +12.4% | **21.1pp** | TP_FULL |
| AEHR | gap_reversal_long | +42.0% | +21.2% | **20.8pp** | atr_week_618_full_exit |
| APLD | gap_reversal_long | +30.1% | +11.4% | **18.7pp** | sl_breached |
| APP | gap_reversal_long | +31.7% | +13.6% | **18.1pp** | TP_FULL |
| BE | gap_reversal_long | +19.9% | +2.5% | **17.5pp** | mfe_decay_structural_flatten |
| APLD | gap_reversal_long | +24.3% | +12.4% | **11.9pp** | TP_FULL |
| IREN | gap_reversal_long | +21.7% | +10.2% | **11.5pp** | sl_breached |

These trades hit **30%+ peaks** and we walked away with under half. That's enormous.

### Root cause hypothesis

The current trail rules use **ATR-based SL anchored to the trim point**. So after a 50% trim at +5%, the SL trails up to ~entry+3% (entry + 0.6 × ATR). When MFE keeps growing to +30%, the SL stays loosely anchored to the **trim point**, not the **MFE peak**. A 5-10% pullback from peak still triggers the SL because we never "ratcheted" the SL up as MFE grew.

### Proposed fix (FIX 2 — DA-keyed)

When MFE >= 15% AND trade has been trimmed:
- **Floor SL at `entry + 0.6 × MFE`** (locks in 60% of peak as worst case)
- This converts a +30% MFE / +12% kept outcome into a +30% MFE / +18% kept outcome (50% improvement)
- Still allows wide enough swing room (40% from peak) for normal pullbacks

DA keys to add:
- `deep_audit_winner_protect_min_mfe_pct = 15`
- `deep_audit_winner_protect_lock_pct = 0.60`

---

## 3. Net-negative Ripster setups — TODO (FIX 3)

### Data

| Setup | N | WR | PnL | PF | Avg MFE | Notes |
|---|---|---|---|---|---|---|
| **tt_gap_reversal_long** | 157 | 59% | **+196.59%** | 3.2 | 5.3% | Crown jewel |
| tt_pullback | 23 | 57% | +7.57% | 1.8 | 2.4% | OK |
| tt_range_reversal_long | 15 | 53% | +10.86% | 2.3 | 3.6% | OK |
| tt_gap_reversal_short | 5 | 60% | +11.77% | 9.2 | 5.2% | Small N but strong |
| **tt_n_test_support** | 28 | 39% | **-4.15%** | 0.8 | **1.4%** | Avg MFE only 1.4% — barely moves |
| **tt_ath_breakout** | 26 | 42% | **-3.43%** | 0.8 | **1.3%** | Same — entries don't follow through |
| **tt_n_test_resistance** | 5 | **0%** | **-7.39%** | 0.0 | **0.2%** | 0/5 wins, MFE almost zero — SHORTS in bull market |

### Diagnosis

- **`tt_n_test_support`**: 82% bull-stack at entry, regime mix is mostly TRANSITIONAL/CHOPPY. Avg MFE only +1.4% means entries are catching exhaustion, not new moves. The "Nth test of support" thesis works in choppy regimes BUT the structural support tested often breaks in our universe (high-beta growth names that move fast).
- **`tt_ath_breakout`**: 88% bull-stack at entry, regime mix is mostly TRENDING. But avg MFE only +1.3% — the entries are firing AT the breakout level itself, not after a confirmation. Many entries get the +0.5% follow-through then reverse. The follow-through filter (added in P0.7.13) wasn't strong enough.
- **`tt_n_test_resistance`**: 5 trades, 0/5 winners, all entered when bull_stack was OFF (0% bull stack) which is correct for shorts — but the regime was wrong-signaling (TRENDING in bullish backdrop is not a good time for shorts). The structural setup detected a resistance test, but the BROADER market was still rising.

### Proposed fixes (FIX 3)

**For `tt_n_test_support` (LONG)**:
- Require `regime_class === "TRENDING"` OR `bull_stack === true` (currently allowed in transitional)
- Require RVol >= 1.2x (currently lower)
- Require minimum daily SuperTrend bullish

**For `tt_ath_breakout` (LONG)**:
- Tighten follow-through: require **2 consecutive bars** above breakout level (not just 1)
- Require RVol >= 1.5x (currently 1.0 for stocks, 1.5 for ETFs)
- For mega-caps (CAT, JPM, GS — frequent losers in this dataset), maybe disable entirely until V16 proves stronger setup

**For `tt_n_test_resistance` (SHORT)**:
- Require `regime_class === "RANGING"` OR `bear_stack === true` (currently fires in any regime)
- Require SPY/QQQ daily ST = -1 (broader market confirmation)
- Require sector ETF for that ticker also showing weakness (sector_alignment === "bearish")

---

## 4. Short underrepresentation — TODO (FIX 4)

3.8% short trades over 4 months with 17 down-trend days isn't enough. Either:
- Regime gates require too many confirmations for SHORT
- Short setups fire too cautiously
- Or the universe is too long-biased (many growth/momentum names)

Needs deeper analysis:
- How often did SPY close < 5d EMA in Jul-Oct? Those are short-trade windows.
- How many BEAR stack signals were available across our 203 tickers? If 50+ tickers were bear-stacked on a given day and we took 0 shorts, that's a gate problem.

---

## 5. Loss cluster — TODO (FIX 5)

44 trades concentrated in protective exits at 0% WR:
- `max_loss` (14 trades, -41.29% combined)
- `max_loss_time_scaled` (16 trades, -20.42%)
- `phase_i_mfe_fast_cut_zero_mfe` (9 trades, -13.86%)
- `phase_i_mfe_fast_cut_2h` (7 trades, -10.07%)
- `phase_i_mfe_cut_4h` (6 trades, -10.69%)
- `atr_day_adverse_382_cut` (7 trades, -6.41%)
- `runner_drawdown_cap` (7 trades, -4.67%)

These rules ARE doing their job (cutting losers fast), but the **entry quality** is the bigger lever — if the n_test/ath setups fix above reduces entries that go straight to max_loss, this cluster drops accordingly.

---

## Validation methodology (per workflow rules)

Before promoting any of these fixes:

1. **Pre-shipping baseline**: extract Jul WR/PnL/PF from current v16-ctx4 run (will be done after run completes).
2. **Run July at 30m post-fix**: `v16-fix1-30m-jul`. Compare:
   - Total trades (expect ~equal — fixes don't change entry rate)
   - WR (expect +1-3pp from rescued runners)
   - PnL (expect +5-10pp from holding 19 SMART_RUNNER trades)
   - PF (expect higher)
   - Top 10 winners NOT regressed (no winners lost)
3. **Run July at 5m post-fix**: `v16-fix1-5m-jul`. Compare:
   - Same baseline metrics
   - Setup-mix distribution
   - Confirm: more trades from intra-bar entries? Different exit timing?
4. **Decide cadence**: based on 3 vs 2.

If P0.7.15 alone improves Jul-Oct results (less broken-runner pollution), proceed with FIX 2 (winner-protect) next iteration.

---

## Decision log

| Decision | Rationale |
|---|---|
| FIX 1 ships first (SMART_RUNNER cloud-hold) | Highest ROI: 26 trades, ~10pp PnL upside, surgical change to existing deferral |
| FIX 2-5 deferred | Need to see FIX 1's effect first; FIX 1 may absorb some of the giveback (held runners exit at structural break, not arbitrary cloud break) |
| 5m comparison comes AFTER FIX 1 validation | Ensures we're comparing apples-to-apples (fixed system) at both cadences |
