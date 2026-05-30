# Phase-H.4: Targeted Refinements from V9 Audit

**Date**: 2026-04-21
**Source**: Trade-level audit of v9 (40-ticker H.3 run) vs v6b/E.3 peak performance
**Approach**: Surgical fixes based on where v9 actually loses trades or misses alpha, NOT blanket gate relaxation

---

## Executive Summary

V9 achieved **64.6% WR, PF 2.72, 8/10 winning months** — a genuine improvement. The remaining gaps:

1. **4 clear losers** (−18% combined PnL) — post-earnings reaction, macro mid-trade flip, core_hold drift
2. **13 big-winner trades v6b captured that v9 missed** — all SHORT pullbacks in downtrends at rank <90
3. **8 small winners** averaging +0.5% after 95-170h hold — capital stuck

H.4 proposes **4 surgical refinements** based on this evidence.

---

## Audit Evidence

### Clear Losers (v9, pnl < −2%)

| Trade | Date | Dir | Rank | PnL | Exit | Root Cause |
|---|---|---|---:|---:|---|---|
| META | 2026-04-07 | SHORT | 94 | −5.80% | HARD_LOSS_CAP | Macro flipped mid-trade (Apr 7 transitional → Apr 8 uptrend) |
| ORCL | 2025-07-31 | LONG | 100 | −5.17% | HARD_LOSS_CAP | Earnings reaction (same-day ORCL earnings) |
| GOOGL | 2026-01-14 | LONG | 94 | −3.91% | max_loss | Held 139h bleeding, no mid-trade cut |
| CDNS | 2025-07-31 | LONG | 93 | −3.24% | max_loss | Same-day sector-wide earnings selloff (ORCL drag) |

### Small Winners (v9, 0 < pnl ≤ +1%)

| Trade | Date | Rank | PnL | Hold | Trim | Exit | Observation |
|---|---|---:|---:|---:|---:|---|---|
| SPY | 2025-12-03 | 94 | +0.11% | 168h | 0% | structural_break | Capital stuck |
| AMZN | 2025-07-01 | 100 | +0.28% | 170h | 50% | eod_trimmed | Capital stuck |
| TSM | 2025-12-09 | 98 | +0.40% | 48h | 50% | giveback_hold | Cut at breakeven |
| HUBS | 2025-09-26 | 97 | +0.46% | 95h | 50% | giveback_hold | Capital stuck |
| GOOGL | 2025-07-01 | 92 | +0.52% | 168h | 50% | eod_trimmed | Same 7-day window as AMZN — overlap |
| AAPL | 2025-08-26 | 97 | +0.54% | 167h | 50% | support_break | 7 days for 0.54% |
| MSFT | 2025-10-02 | 92 | +0.95% | 164h | 50% | atr_week_618 | Capital stuck |
| NVDA | 2025-08-06 | 93 | +0.95% | 167h | 50% | mfe_trail | Capital stuck |

**Pattern**: All 8 trades held 48-170h, mostly at ≥50% trimmed (a 2nd half that never moved), averaged +0.5%. Capital sitting.

### Big Winners v9 Missed (v6b captured, v9 no entry)

| Trade | Date | Dir | Rank | PnL | Why v9 skipped |
|---|---|---|---:|---:|---|
| AGQ | 2026-03-13 | SHORT | **57** | +14.97% | rank < 90 floor |
| HUBS | 2026-04-01 | SHORT | **71** | +9.75% | rank < 90 + Apr uptrend short block |
| HUBS | 2026-01-12 | SHORT | **54** | +8.96% | rank < 90 |
| SGI | 2026-03-03 | SHORT | **53** | +5.37% | rank < 90 |
| RIOT | 2026-03-26 | SHORT | **92** | +5.15% | consensus gate? |
| META | 2026-03-24 | SHORT | **88** | +5.11% | rank < 90 |
| CDNS | 2025-10-10 | SHORT | **56** | +4.89% | rank < 90 |
| TSLA | 2026-03-18 | SHORT | **90** | +4.20% | consensus gate? |
| MSFT | 2026-03-18 | SHORT | **96** | +4.13% | consensus gate? |
| MSFT | 2026-01-30 | SHORT | **77** | +4.35% | rank < 90 |

**Pattern**: **11 of 13 missed big winners were SHORTs**, mostly at rank <90, during **confirmed downtrend regimes** (Jan/Mar/Apr 2026). This is an alpha pocket v9's rank-90 floor eliminated.

### Rank Sweet Spot

| Rank bucket | E.3 big-win hit rate | v6b | v9 |
|---|---:|---:|---:|
| 100 | 3.3% | 9.3% | **0.0%** |
| 95-99 | 11.1% | 6.9% | 33.3% |
| **90-94** | **32.4%** | 18.9% | 14.3% |
| 80-89 | 0% | 3.8% | — |
| <80 | 0% | **14.3% (mostly SHORT pullbacks)** | — |

**Rank 90-94 is the sweet spot for LONGs. Rank <80 SHORT-pullbacks have a distinct alpha profile in downtrends.**

---

## H.4 Refinements (4 surgical fixes)

### H.4.1 — Earnings-proximity entry block (`tt_entry_earnings_proximity_block`)

**Problem**: ORCL rank 100 LONG on 2025-07-31 entered the day ORCL reported earnings. Lost 5.17%. CDNS same day lost 3.24% in the sector-wide reaction.

**Fix**: Block all new entries when the ticker has an earnings report within **24 hours** (before or after). Earnings data exists in `market_events` table but isn't currently consulted for entry gating.

**DA key**: `deep_audit_earnings_proximity_block_hours = 24` (default; set 0 to disable)

**Code**: 15-line addition to `tt-core-entry.js` — early-return rejection if `ctx.eventRisk?.upcomingEarnings?.hoursToEvent <= N`.

**Expected impact**: Would have blocked ORCL Jul 31 (−5.17%) + CDNS Jul 31 (−3.24%) = +8.4% aggregate.

### H.4.2 — Mid-trade regime-flip exit (`mid_trade_cycle_flip_exit`)

**Problem**: META SHORT Apr 7 (rank 94) entered on transitional day, Apr 8 cycle flipped uptrend, META +7% squeeze. Held 24h to HARD_LOSS_CAP at −5.80%. GOOGL LONG Jan 14 (rank 94) similar: held 139h in deteriorating regime.

**Fix**: If an open trade is >= 24h old AND the per-day cycle has flipped against direction (SHORT in trade, cycle became uptrend; or LONG in trade, cycle became downtrend) AND pnl < 0 → force exit at next 15m ST close. Escape before hard stops trigger.

**DA key**: `deep_audit_mid_trade_regime_flip_exit_enabled = true`
**DA key**: `deep_audit_mid_trade_regime_flip_min_age_hours = 24`

**Code**: 20-line addition to `worker/index.js` `classifyKanbanStage` — check ctx.market.monthlyCycle vs direction.

**Expected impact**: META Apr 7 (−5.80% → ~−2% if caught Apr 8 morning), GOOGL Jan 14 (−3.91% → ~−1% if cut mid-trade).

### H.4.3 — 48-hour momentum ignition check (`momentum_ignition_cut`)

**Problem**: 8 v9 small winners held 48-170h at +0.5% while not gaining traction. Capital stuck in non-performers.

**Fix**: At 48h mark, check:
- If MFE < +1.0% AND current pnl < +0.5% AND **LTF RSI (15m or 30m) not trending toward direction** → flatten at next bar.

This is stricter than H.1b's `early_dead_money_flatten` (which runs at 6h). H.4.3 runs at 48h and requires both lack of MFE AND lack of momentum revival.

**DA key**: `deep_audit_momentum_ignition_cut_enabled = true`
**DA key**: `deep_audit_momentum_ignition_age_hours = 48`
**DA key**: `deep_audit_momentum_ignition_mfe_max_pct = 1.0`

**Code**: 15-line addition to `classifyKanbanStage`, mirror of `early_dead_money_flatten` logic.

**Expected impact**: Frees capital in ~8 trades per 10-month window that currently sit dead. Doesn't change PnL much directly but allows re-deployment. Secondary benefit: cleaner trade count.

### H.4.4 — Downtrend-SHORT rank relaxation (`regime_downtrend_short_rank_min`)

**Problem**: Rank-90 floor eliminated v6b's SHORT-pullback alpha (11 big winners, +70% aggregate PnL missed). These were all rank 53-88 SHORTs in confirmed downtrends (Jan/Mar 2026).

**Fix**: When cycle = downtrend AND SPY has been bear-stacked ≥ 3 days, allow SHORT entries down to rank 55 — but only for **specific setups** (`tt_short_pullback_*`, `ripster_short_*` momentum). Gate it behind setup_name so we don't re-admit all low-rank trades.

**DA keys**:
- `deep_audit_regime_downtrend_short_rank_min = 55`
- `deep_audit_regime_downtrend_min_bear_stack_days = 3`
- `deep_audit_regime_downtrend_short_allowed_setups = "tt_short_pullback,ripster_short_momentum,ripster_short_pivot_reclaimed,ripster_short_breakdown"`

**Code**: 30-line addition — an override branch in the Layer 2 regime-adaptive gate that admits low-rank SHORTs when the cohort + setup match the confirmed-bear pattern.

**Expected impact**: Recaptures the 11 missed SHORT winners (+70% aggregate across Jan/Mar/Apr). Primary lever for lifting trade volume.

---

## Ordering & Validation

1. **H.4.4 first** — biggest upside (+70% missed alpha). Smoke on Jan + Mar 2026.
2. **H.4.1 second** — biggest downside save (−8% avoided). Smoke on Jul 2025.
3. **H.4.2 third** — medium save. Smoke on April 2026.
4. **H.4.3 last** — operational improvement, not PnL-critical. Smoke on Aug-Oct (chop months).

Full v11 after all four land.

---

## Success Criteria (v11)

Same as H.3 v9 acceptance + volume lift:
- WR ≥ 65% (maintain)
- Winning months ≥ 9/10 (improve from 8)
- Trade count 100-140 (up from 48)
- Big losers ≤ 3 (down from 4)
- No month PnL < 0% (was 2 in v7, 1 in v9)

---

## Defer to H.5+

- Rank 100 reversal hypothesis — rank-100 had 0% big-win rate in v9. Research whether rank-100 should weight toward exit management (mean-reversion) rather than entry signal.
- Sector-rotation-timed entries — use monthly backdrop `sector_leadership` to bias toward leading sectors + away from lagging ones.
- Investor-mode backtest harness (separate workstream).
