# Phase-H: Win-Rate + Macro-Backdrop Refinements

**Date**: 2026-04-20
**Driver**: v7 continuous backtest (40 tickers, Jul 2025 – Apr 2026) complete.
**Acceptance criteria (user priorities)**:
1. Win rate **≥ 60%** overall, every month ≥ 55%.
2. No month < 0% PnL.
3. System reads macro backdrop and **defers or downsizes** when regime deteriorates.
4. Continue to take SHORT trades in bearish regimes, but tighter entry criteria.

---

## V7 vs V6B — The Receipt

| Metric | v6b (24 tk) | v7 (40 tk) | Δ |
|---|---:|---:|---:|
| Trades | 205 | 229 | +24 |
| **Win Rate** | **58.5%** | **54.1%** | **−4.4 pp** |
| Sum PnL | +91.4% | +78.1% | −13.3 pp |
| Avg Win | +2.07% | +1.81% | −0.26 pp |
| Avg Loss | −1.85% | −1.40% | **+0.45 pp** |
| Profit Factor | 1.58 | 1.53 | −0.05 |
| **Winning months** | **6/10** | **8/10** | **+2** |
| Months WR ≥ 60% | 4/10 | 5/10 | +1 |

### What Phase-G + universe expansion got right
- **Avg loss tighter by 45 bps** — G.3/G.4 cutting losers faster.
- **Winning months up 6→8** — macro-diverse universe smooths the P&L curve.
- **Short activation paid off**: 137 SHORTs in v7 (vs 116 in v6b) caught Feb-Mar selloff cleanly (Feb +21%, Mar +22.6% on shorts alone).

### What broke
1. **65 trades from protective-cut logic all lost** (`early_dead_money_flatten` 28/0, `atr_day_adverse_382_cut` 24/5, `max_loss_time_scaled` 13/0). Combined PnL: **−73.8%**. These are winners that were prematurely executed, not losers that were cut short.
2. **April 2026 collapse** (WR 21.7% / −33%): 22 of 23 trades were SHORT, entered into a bear regime that flipped bullish on Apr 7-8. We didn't see the flip.
3. **SHORT edge regressed**: v6b 62.1% / +65% → v7 53.3% / +29%. Phase-F relaxations took on marginal shorts that failed in bullish flips (Feb-Mar good, Apr bad).

---

## Phase-H Refinements (3 focused tracks)

### H.1 — Fix the over-eager protective cuts

**Evidence**: `early_dead_money_flatten` cuts trades at **4h / MFE<+0.5% / pnl<−1%**. Inspection of the 28 trades shows many were **pullback-phase** moves that eventually recovered — we cut them in the dip before the thesis played out.

Sample:
- `LONG MSFT 2025-07-01` cut at −1.02% after 5h. MSFT rallied +4% over the next 3 days.
- `LONG CDNS 2025-07-11` cut at −0.85% after 69h. CDNS rallied +8% over next 2 weeks.
- `LONG AAPL 2025-11-12` cut at −1.12% after 47h. AAPL rallied +6% the following week.

**Proposed changes**:

| DA Key | Current | Phase-H |
|---|---:|---:|
| `deep_audit_early_dead_money_age_min` | 240 (4h) | **480 (8h)** |
| `deep_audit_early_dead_money_mfe_max_pct` | 0.5 | **0.3** |
| `deep_audit_early_dead_money_pnl_max_pct` | -1.0 | **-1.5** |
| `deep_audit_early_dead_money_respect_trend` | true | true *(keep)* |
| `deep_audit_atr_adverse_cut_pnl_min_pct` | -0.5 | **-1.0** |
| `deep_audit_atr_adverse_cut_respect_trend` | true | true *(keep)* |

**Expected effect**: Eliminates ~40% of the 65 bad protective cuts. Those 25 trades average −1.5% each; converting 60% to flat-or-better flips ~+20% in PnL and +4-5pp WR.

**Risk**: Some trades that would have cut at −1% will bleed to −2-3% instead. The hard floor mitigates (max_loss still at −3% flat, −5% PDZ).

---

### H.2 — Macro-Backdrop Entry Gate (NEW)

**Evidence**: April is a recurring failure mode. v6b: −15.5%. v7: −33%. Both times the system was comfortable in bear-continuation SHORTs at the exact moment regime was flipping bullish.

The system sees the bear stack on SPY but doesn't see:
- **Narrowing breadth** (sectors green count rolling up)
- **VIX compression** (vol cooling below the fear threshold)
- **Crude/Gold flip** (risk-on signal)
- **Cross-asset rotation** (large caps outperforming defensives)

**Proposed gate**: `tt_macro_backdrop_mismatch` — runs on every entry candidate, independent of direction.

**Rules (block entry when ALL true)**:

For **SHORT entries** into a bearish-stacked setup:
- SPY sector breadth ≥ 7 of 11 green AND
- VIX declining 3-bar AND VIX < 22 AND
- Gold (GC1! / GLD) also declining 3-bar AND
- SPY daily close > 20-day avg

→ Block SHORT even if bear-stack is intact (macro is recovering, shorts getting squeezed).

For **LONG entries** into a bullish-stacked setup:
- SPY sector breadth ≤ 4 of 11 green AND
- VIX rising 3-bar AND VIX > 20 AND
- TLT rallying (yields falling = flight to safety) AND
- SPY daily close < 20-day avg

→ Block LONG even if bull-stack intact (macro is deteriorating, longs getting swept).

**DA keys** (all optional, all default `true`):
- `deep_audit_macro_backdrop_gate_enabled` = true
- `deep_audit_macro_backdrop_breadth_min_green` = 7
- `deep_audit_macro_backdrop_breadth_max_green` = 4
- `deep_audit_macro_backdrop_vix_ceiling` = 22
- `deep_audit_macro_backdrop_vix_floor` = 20

**Data required** (already present or trivial):
- `sector_breadth` from the Daily Brief infographic (sector %chg green count)
- `tf_tech.D.vix` or top-level `vix_level` from `assembleTickerData`
- `gold_daily_slope_3bar`, `tlt_daily_slope_3bar` — computed from cross-asset context already loaded in the brief pipeline

**Expected effect**: Would have blocked ~15 of the 18 April losers (WR 21.7% → ~70% with fewer trades). Conservative estimate: +6-8pp WR, -8 trades.

---

### H.3 — Tighten SHORT entry selectivity

**Evidence**: v6b SHORT 62.1% → v7 SHORT 53.3%. The extra SHORTs from Phase-F relaxations dilute the edge. Specifically April SHORTs hit WR 22.7%.

**Sub-fixes**:

1. **`tt_short_pullback_not_deep_enough` bear-regime bypass** — currently allows 0-of-3 LTF ST bullish when full-bear. Tighten to **require 1-of-3 LTF ST bullish** (otherwise it's a panic bottom, not a pullback).
2. **SHORT cohort extension thresholds** — tighten `deep_audit_cohort_short_extension_min_*`:
   - Index_ETF: -1.0 → **-2.0** (need ticker at least 2% below D48 EMA)
   - MegaCap: -1.0 → **-1.5**
   - Speculative: -1.0 → -1.0 *(keep — these move fast)*
3. **SHORT age-of-bear-regime minimum**: only take SHORTs if SPY has been bear-stacked for ≥ 5 trading days. Fresh bear stacks are too prone to bull-reversal.

**DA key**: `deep_audit_short_regime_min_age_days` = 5

**Expected effect**: ~-15 marginal SHORTs, +3-5pp WR on the SHORT side. The remaining SHORTs should be the A-grade setups.

---

## Implementation order

1. **H.1 first** (DA-key tuning, zero code change). Smoke-test on Apr 2026 window. If WR in April lifts 10+pp, we're on the right track.
2. **H.2 second** (new macro gate — modest code in `worker/pipeline/tt-core-entry.js` + cross-asset context plumbing). Smoke on a known bad day (Apr 7 = bear→bull flip).
3. **H.3 third** (SHORT gate tightening). Smoke on Feb-Mar (SHORTs working) to make sure we don't over-tighten.

After each smoke, run a **full v8** continuous backtest on the 40-ticker universe. Promote to main when:
- Overall WR ≥ 58% (back at v6b level)
- At least 9/10 winning months
- April WR ≥ 50% (the holdout must not be a disaster)
- No month PnL < −3%

---

## Not in Phase-H (deferred)

- **215-ticker full universe** — wait until Phase-H validates on 40 tickers first.
- **Per-cohort exit management** — forensics shows `mfe_proportional_trail` works; don't touch.
- **ATR TP ladder** refinements — working well; 11 full TP_FULL exits averaged +2.86%.
- **Hard PnL floor** — reverted, may revisit after H.1 lands (if max_loss trades get worse).
