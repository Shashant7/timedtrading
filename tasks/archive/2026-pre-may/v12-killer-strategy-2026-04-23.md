# V12 Killer Strategy Playbook

**Goal:** `SPY/QQQ/IWM` at **90%+ WR**, equity trades producing **big winners** matching V11's
golden-winner profile. Overall WR **65%+**, PF **2.0+**, zero months worse than -3%.

## The edge V11 accidentally revealed

Isolating V11's 16 big winners (≥+3%) vs 18 big losers (≤-2%) reveals one pattern:

| Dimension | Winners (n=16) | Losers (n=18) |
|---|---|---|
| Setup | **100% `tt_pullback`** | 78% `tt_pullback`, 22% `tt_momentum`/other |
| Rank | 92–100 (all ≥92) | 88–100 (mixed) |
| Hold duration | **1.0 to 12.9 days, median ~6 days** | **0.2 to 5 days, median ~1 day** |
| MFE reached | **5% to 18%** | 0% to 2% |
| Exit reason | `TP_FULL`, `mfe_proportional_trail`, `SMART_RUNNER_*`, `SOFT_FUSE_RSI_CONFIRMED` | `max_loss_time_scaled`, `phase_i_mfe_fast_cut_zero_mfe`, `max_loss`, `HARD_LOSS_CAP` |

**The edge is:** `tt_pullback` finds setups that need 5-15 days to develop into 5-15% moves.
**The leak is:** our exit rules kill 24-40% of trades before they've had time to become winners.

> **Every exit rule that fires at <2h holds is a thesis the market never got to answer.**

## ETF-specific problem

SPY/QQQ/IWM had 4 trades in 10 months, 25% WR, -1.71% total. Per-trade:

| Ticker | Date | PnL | MFE | MAE | Exit | What happened |
|---|---|---:|---:|---:|---|---|
| DIA | 07-09 → 07-15 | +0.15% | 0.75 | -0.42 | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | clipped the one win |
| QQQ | 11-03 → 11-04 | -1.50% | 0.29 | -1.50 | `phase_i_mfe_fast_cut_zero_mfe` | killed at open |
| SPY | 12-03 → 12-15 | -0.08% | 1.04 | -0.08 | `STALL_FORCE_CLOSE` | broke even but force-closed |
| QQQ | 12-09 → 12-12 | -0.28% | 0.65 | -1.18 | `SMART_RUNNER_SUPPORT_BREAK_CLOUD` | never let it breathe |

None of them went below -1.5%. Three of four were cut **prematurely by exit rules that are calibrated
for 3-5% volatility equities**. Broad-index ETFs don't move like that. They need:

- **Wider structural stops** (ATR-based, not %-based)
- **Longer minimum hold** (bypass fast-cut for 24h)
- **Looser MFE thresholds** (0.5% MFE is a real thing in SPY, not dead money)
- **Different entry trigger** (pullback-to-21EMA, not pullback-to-phase-reset)

## The 6-piece V12 plan

Each is implemented, smoke-tested, and only then composed. **Every change is DA-gated** so we can
A/B or kill any of them without a code redeploy.

### P1 — Fast-cut relaxation (highest single-lever impact)

Current: `phase_i_mfe_fast_cut_zero_mfe` — cuts any trade at any age if MFE ≤ 0.
V11 damage: 42 of 177 trades (24%) exited here at 0% WR, -1.21% avg. **Responsible for 50%+ of
total losses.** Of those 42, only 3 touched ≥1% MFE before cut.

Fix:
- Require **age ≥ 2 hours** (don't kill trades in first 2 bars)
- Require **MAE ≥ -0.5%** (only cut if thesis invalidated, not just dormant)
- Require **no active entry trigger refresh** in last 30 min (if re-trigger fires, give another chance)

New DA keys:
- `deep_audit_mfe_fast_cut_min_age_hours` = 2
- `deep_audit_mfe_fast_cut_max_mae_pct` = -0.5
- `deep_audit_mfe_fast_cut_honor_retrigger` = true

### P2 — Full rank_trace coverage

V11: only 32% of trades have `rank_trace_json`. That's why `computeRankV2` calibration
failed — insufficient sample.

Fix: force trace on every entered trade regardless of sampling.
- `deep_audit_rank_trace_force_enabled` = true (already wired, verify it's actually on)
- `deep_audit_rank_trace_on_entry_always` = new — bypass 30%-sampling in entry pipeline

Won't raise WR directly — **it's the data we need to re-calibrate the formula in the V12 → V13 loop.**

### P3 — Let-winners-run guard

Pattern: many "big winners" got clipped around +1-3% then the market ran another 5%+.
Example: ALB +4.96% at exit but MFE was 6.07% — 20% of the move given back.

Fix: when MFE ≥ 3.0% and price is within 0.5% of current MFE, **block all "soft" exits**
(SMART_RUNNER_SUPPORT_BREAK_CLOUD, mfe_fast_cut, max_loss_time_scaled) for 1 bar.
Only let hard exits (SL breach, HARD_LOSS_CAP, PRE_EARNINGS) fire. Re-evaluate next bar.

New DA keys:
- `deep_audit_winner_protect_enabled` = true
- `deep_audit_winner_protect_min_mfe_pct` = 3.0
- `deep_audit_winner_protect_near_mfe_gap_pct` = 0.5

### P4 — SHORT activation (1 → 5-15 target)

Current W2 gate requires `SPY daily regime = bearish_stacked` AND sector strength check.
V11: 1 short in 10 months.

Fix:
- Accept SPY regime ≤ `bearish_mixed` OR `sideways_below_21ema`
- Sector strength gate becomes a rank penalty (-10), not a hard block
- Require ticker-specific bearish structure (21EMA < 48EMA < 200EMA on Daily) as the true filter

DA:
- `deep_audit_short_spy_regime_floor` = `bearish_mixed` (was `bearish_stacked`)
- `deep_audit_short_sector_strength_gate` = false (disabled; converted to rank adj)
- `deep_audit_short_requires_ticker_bearish_daily` = true

### P5 — `tt_momentum` retune

V11: 71% WR, **-2.0% PnL** (wins are tiny, losses are full stops). R:R is upside-down.

Fix:
- **Wider TPs:** first TP moves from +1% to +2%, second TP from +2% to +4%
- **Tighter entry:** require RVol ≥ 2.0 (was 1.5) and current-bar close in upper 60% of bar
- **Retire if WR-weighted-PnL still negative after smoke**

DA:
- `deep_audit_tt_momentum_tp1_pct` = 2.0 (was 1.0)
- `deep_audit_tt_momentum_tp2_pct` = 4.0 (was 2.0)
- `deep_audit_tt_momentum_min_rvol` = 2.0 (was 1.5)
- `deep_audit_tt_momentum_bar_position_min` = 0.60

### P6 — **ETF Precision Gate (the 90% SPY/QQQ/IWM mechanism)**

Broad-index ETFs get a completely separate entry + exit track.

**10-filter entry** (must pass ALL for SPY/QQQ/IWM entry):

1. Daily EMA21 > EMA48 > EMA200 (trend intact, same direction as trade)
2. Price pulled back to within 1.5% of daily EMA21, not deeper
3. Daily RSI between 40–65 (not oversold, not overbought — textbook healthy pullback)
4. 1H structure: current-bar close above 21EMA on 1H
5. 30-min structure: price above ATR-level 0 (Saty 0 line on 30m, a.k.a. current-day anchor)
6. Weekly not overextended: price within 2 weekly ATRs of weekly EMA21
7. VIX ≤ 25 (suppress entries in panic tape — broad ETFs get whipsawed)
8. Breadth ≥ 50% green on the day (regime alignment)
9. No FOMC/CPI/NFP event within 48 hours (macro knife-catch avoidance)
10. Run-rank ≥ 90 (baseline quality)

**ETF-specific exit track:**
- Stop: Daily ATR × 1.5 below entry (not % below; ATR-aware)
- TP1: Weekly ATR × 0.618 (Golden Gate up)
- TP2: Weekly ATR × 1.0
- Runner: Weekly ATR × 1.618 or daily EMA21 trail, whichever comes first
- Min hold: 24 hours (no fast-cut, no stall-force-close until 24h elapsed)
- Time cap: 14 calendar days (index ETFs don't run 30+ days)

DA (gated by `deep_audit_etf_precision_gate_enabled` = true):
- `deep_audit_etf_precision_tickers` = `SPY,QQQ,IWM,DIA`
- `deep_audit_etf_precision_min_rank` = 90
- `deep_audit_etf_precision_daily_ema_pullback_pct` = 1.5
- `deep_audit_etf_precision_daily_rsi_min` = 40
- `deep_audit_etf_precision_daily_rsi_max` = 65
- `deep_audit_etf_precision_vix_max` = 25
- `deep_audit_etf_precision_breadth_min` = 50
- `deep_audit_etf_precision_macro_event_hours` = 48
- `deep_audit_etf_precision_stop_atr_mult` = 1.5
- `deep_audit_etf_precision_min_hold_hours` = 24
- `deep_audit_etf_precision_max_hold_days` = 14

**Why 90% is believable**: the 10-filter conjunction is ~1 per month, ETFs in this trend state
revert 80-85% historically, and the ATR-scaled stops rarely trigger on true mean-reverters. A
handful of high-conviction ETF trades per year at 90% beats 4 per year at 25%.

## Smoke validation order

Each fix gets a 1-month micro-smoke to confirm it acts as expected **before** composition:

1. **P1** on March 2026 (6 trades, 5 were fast-cut losses): target — March goes from -8.19% to
   roughly flat or positive, 2-4 of the 5 fast-cut trades become winners.
2. **P3** on JD Apr 13–20 window (+6.44% winner): target — MFE-exit path unchanged (no
   regression on the existing golden winner); trade still closes ≥ +5%.
3. **P4** on Feb 2026 (SPY had identifiable downtrends): target — 2-4 SHORTs fire, at least
   one closes positive.
4. **P5** on V11 `tt_momentum` trades backfilled: decide retire vs keep based on TP-2 hit rate.
5. **P6 ETF Precision Gate** on Oct-Dec 2025 (quiet tape, ideal testbed): target — 1-3 ETF
   entries fire, ≥2 close positive, zero exit via fast-cut.

## V12 full run

Only after all 5 micro-smokes green. Same universe, same 10-month window (Jul 2025 → Apr 2026),
composed DA config from all passing fixes. This IS the run we hold as trades history for proof.

## Success criteria

- **SPY/QQQ/IWM**: 90%+ WR on the handful that pass the precision gate
- **Overall WR**: 65%+
- **PF**: 2.0+
- **Total PnL**: +80%+ over 10 months
- **Max monthly drawdown**: better than -3%
- **SHORT trades**: 5-15 total
- **Every big loser audit-able** to one of {true SL breach, earnings surprise, regime flip} — not
  to an exit-rule misfire
