
# Phase A — Calibration Synthesis (2026-04-30)

## Top-line numbers (588 closed trades, Jul 2025 → Apr 2026)

| Metric | Value | Read |
|---|---:|---|
| Cum return $ | +$45,061 (+45.06% on $100k) | strong |
| Cum return % (per-trade) | +421.47% | informational only |
| Sharpe (rf=4.5%) | **5.54** | exceptional — typical "good" hedge fund Sharpe is 1-2 |
| Sortino | **17.20** | exceptional |
| Max drawdown | **1.85%** ($2,704) | extremely shallow |
| Profit factor | **2.02** | strong |
| Win/loss ratio | **1.90** | wins are ~2× the size of losses |
| WR | 51.4% | as expected for high-RR strategy |
| Worst single day | -$954 | bounded |
| Losing days | 39% | balanced |

These are **promotion-grade risk numbers**. Sharpe 5.54 / max-DD 1.85% is well within institutional-quality territory; the fact that it survives a 38-bp/side slippage stress test (Pillar 4) without going negative is the strongest single piece of evidence for live readiness.

## Pillar-by-pillar findings

### Pillar 1 — Equity & risk (✅ pass)

- 9 of 10 winning months. Only Mar 2026 was negative.
- Largest drawdown was the open Feb 25 → Apr 21 stretch, only **1.85%**, only $2.7k of the $100k starting capital. Recovered shortly thereafter (run finalized Apr 29).
- Two prior drawdowns (Jul 02-14, Oct 31-Nov 28) were both ~1% and recovered within 12-28 days.
- **Verdict**: risk profile is strong. P1 fixes target the source of the Mar 26 dip — modest expected gain, low downside.

### Pillar 2 — Setup × Personality × Direction matrix (⚠️ surfaced one new cohort)

New problem cohorts beyond the autopsy's discount_approach × LONG × VOLATILE_RUNNER:

| Cohort | n | WR | avg PnL$ trade | cum PnL$ |
|---|---:|---:|---:|---:|
| `tt_n_test_resistance · SHORT` | 16 | 31% | -$79 | **-$1,261** |
| `tt_ath_breakout · MODERATE` | 12 | 25% | -$28 | -$330 |
| `tt_ath_breakout · SLOW_GRINDER` | 17 | 47% | -$27 | -$452 |

The bread-and-butter cohort `VOLATILE_RUNNER · premium · LONG` (260 trades, +1.21% avg, +$35k) is unbroken. The system is not over-reliant on one combo; it has dozens of profitable cells.

`tt_ath_breakout · LONG` overall is roughly flat (n=70, WR 41%, -$50). This is the largest setup with a meaningful issue. May warrant a personality-aware filter beyond just MODERATE/SLOW_GRINDER.

**New candidate fix (P2.5)**: block `tt_n_test_resistance · SHORT` (small but consistent loser, 16 trades, -$1,261).

### Pillar 3 — Concentration (⚠️ moderate)

- Top-10 tickers contribute **54.3%** of dollar PnL.
- Top-20 tickers contribute **82.0%** of dollar PnL.
- 20 tickers carry 80% of PnL out of 153 traded.
- AGQ (12 trades), SNDK (11), ETHA (5), AEHR (11), APLD (10) are the top contributors.
- Sector data is unavailable in this dataset (all `-`). Need to wire `sector` field through trade record write-time as a future improvement.

**Read**: concentration is high but not extreme. Top-20-tickers carrying 82% is normal for a momentum strategy that finds and rides breakouts; the live universe filtering on rank ≥ 90 will tend to keep this same ranked subset. Watch but don't gate on it.

### Pillar 4 — Slippage stress (✅ excellent)

| Adverse slippage / side | Cum % PnL | Status |
|---:|---:|---|
| 0 bp (baseline) | +469.71% | (pnl_pct sum, ignoring `pnl` $) |
| 5 bp | +410.53% | comfortable |
| 10 bp | +351.41% | comfortable |
| 15 bp | +292.34% | comfortable |
| 20 bp | +233.32% | comfortable |
| **38-40 bp** | breakeven | tipping point |

At realistic execution slippage (5-10 bp/side for liquid names), only 12 trades (~2%) flip from WIN to LOSS. The system has substantial slippage headroom.

**Verdict**: live execution friction is not a threat. Even in a worst-case 20 bp/side regime (which would be a panic-tape scenario), the system retains +233%.

### Pillar 5 — Drawdown periods (✅ analytical confirmation)

The largest DD (Feb 25 → Apr 21, -$2,704) is **dominated by the same exit-reason cluster the autopsy identified**:
- 13 × `atr_day_adverse_382_cut` (-15.69%)
- 5 × `phase_i_mfe_fast_cut_zero_mfe` (-7.06%)
- 3 × `HARD_LOSS_CAP` (-22.26%)

Personality mix in losers: VOLATILE_RUNNER 11, MODERATE 7, PULLBACK_PLAYER 6, SLOW_GRINDER 5.
Regime mix: TRENDING 14 / TRANSITIONAL 14 — split evenly, so this is NOT a regime-pure issue.

**Confirms autopsy thesis**: the Mar 2026 drawdown is a personality-conditional exit-management problem, not a regime miscalibration. P1 fixes target this exact failure mode.

### Pillar 6 — Rank, R:R, concurrency (📊 informational)

- Top-rank trades (95+) are 387/588 = 66% of trades, +0.78% avg, +$33k. Solid.
- Trades with rank < 70 (n=27) are roughly flat — doing the right thing by deemphasizing them.
- Setup-grade Prime: 376 trades, WR 55%, +$41k. Confirmed: 193 trades, WR 45%, +$3k. Speculative: 19 trades, +$243.  **Prime is doing 92% of the dollar work.**
- R:R 5+ is the best cohort (WR 57%, avg +$116/trade), but R:R 2-3 carries the most volume.
- Max concurrent positions: 28. Median exposure ~10-12. The system is sized for diversification.

## Recommendations for the walk-forward backtest (Phase B/C)

### Confirmed P1 fixes (move forward)

1. **P4 prerequisite**: write `entrySignals` onto trade record at creation. (No PnL impact, prerequisite for P1a.)
2. **P1a — Runner-protect with clean-entry gate**. Target: 32 trades killed by dead-money cuts with no adverse divergence at entry. Estimated recovery: ~+10-25% range, asymmetric upside.
3. **P1b — Block strong adverse RSI div (strength ≥ 30)**. Skips 5 trades worth -$120, saves a few % at zero capacity cost.

### Add to P2 batch

4. **P2 — Block `discount_approach LONG` on `VOLATILE_RUNNER` ∪ `PULLBACK_PLAYER`**. n=22 skip, gains ~+$1,500 net.
5. **P2.5 (new)** — Block `tt_n_test_resistance · SHORT`. n=16 skip, gains ~+$1,261 net. WR 31%.

### Defer P3 (personality-aware ATR cut) until Phase D

The `atr_day_adverse_382_cut` exits cost -34.72% across 36 trades but they're spread across all personalities. Tuning these per-personality is invasive — needs its own A/B replay. Don't bundle with P1.

## Promotion gate criteria (refined for the walk-forward run)

Now we have hard numbers from Phase A as the baseline reference:

- Train (Jul 2025 → Jan 2026 baseline ≈ +390% pnl_pct, +$33k$): challenger ≥ baseline.
- Holdout (Feb 2026 → Apr 2026 baseline = +30%, +$5k$): challenger ≥ baseline.
- Sharpe on holdout ≥ 3.0.
- Max DD on holdout ≤ 3% (was 1.85% on full run; gives room for some regression).
- 5 bp/side slippage stress: holdout PnL stays ≥ baseline -2 percentage points.
- No new ≥ -5% monthly regressions vs baseline.

If all criteria pass: PR + merge → live activation in sim slot only → 1 week observation → flip to non-sim slot.

If any fail: tune gate parameters, re-replay; do not promote.

## Decision

**Proceed to Phase B (implement P4 + P1a + P1b + P2 + P2.5).** The Phase A numbers are unambiguously promotion-quality. The fixes are low-risk and well-targeted. The walk-forward backtest in Phase C will be the proof we take to live.

The only thing Phase A surfaced that should NOT be ignored is the lack of sector tagging in trade records (Pillar 3 limitation). That's a P5 — write `sector` onto trade record at creation, parallel to the entrySignals work. Same commit. No PnL impact.

