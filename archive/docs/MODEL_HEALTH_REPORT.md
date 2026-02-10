# Model Health Report — Weekly Retrospective

> Generated: 2026-02-08T17:51:35.991Z
> Full window: 90 days (2025-11-10 → 2026-02-08)
> Recent window: 30 days (2026-01-09 → now)
> Moves analyzed: 663 with trail data (166 recent)

## Market Regime

| Period | Moves | UP% | DOWN% |
|--------|-------|-----|-------|
| Full 90d | 663 | 65% | 35% |
| Recent 30d | 166 | 32% | 68% |

## Pattern Performance

| Pattern | Seed HR | All N | All UP% | Recent N | Recent UP% | Regime |
|---------|---------|-------|---------|----------|------------|--------|
| Bear State + Squeeze + Multi-Signal | 50% | 23 | 13% | 21 | 9.5% | Stable |
| Squeeze Release (Bear) | 0% | 23 | 17.4% | 20 | 15% | Stable |
| Bull State Dominance | 75% | 299 | 71.2% | 59 | 39% | ⬇ Degrading |
| ST Flip 1H + Bull State | 75% | 195 | 63.6% | 88 | 33% | ⬇ Degrading |
| ST Flip + Bull State | 75% | 187 | 63.1% | 86 | 33.7% | ⬇ Degrading |
| EMA Cross + Rising HTF | 70% | 23 | 60.9% | 9 | 33.3% | ⬇ Degrading |
| Bull State + Momentum Elite | 50% | 87 | 65.5% | 41 | 36.6% | ⬇ Degrading |
| HTF Bull + Pullback State | 72% | 43 | 67.4% | 11 | 36.4% | ⬇ Degrading |
| HTF Collapse | 57% | 110 | 58.2% | 43 | 23.3% | ⬇ Degrading |
| High Momentum Elite | 67% | 208 | 56.3% | 105 | 27.6% | ⬇ Degrading |
| Multi-Signal Cluster | 36% | 97 | 30.9% | 89 | 27% | ⬇ Degrading |
| HTF/LTF Divergence (Bear) | 13% | 34 | 23.5% | 31 | 16.1% | Stable |
| ST Flip + Bear State | 29% | 56 | 35.7% | 29 | 6.9% | ⬇ Degrading |
| Bear State Dominance | 42% | 65 | 40% | 24 | 4.2% | ⬇ Degrading |
| Strong HTF Surge | 67% | — | — | — | — | Stable |
| LTF Recovery + High HTF | 50% | — | — | — | — | Stable |
| High Completion Exhaustion | 50% | — | — | — | — | Stable |

## Regime Changes Detected

- ⬇ **Bull State Dominance**: Recent 30d UP% = 39% vs Historical 79% (-40pp shift)
- ⬇ **ST Flip + Bull State**: Recent 30d UP% = 34% vs Historical 88% (-54pp shift)
- ⬇ **ST Flip 1H + Bull State**: Recent 30d UP% = 33% vs Historical 89% (-56pp shift)
- ⬇ **EMA Cross + Rising HTF**: Recent 30d UP% = 33% vs Historical 79% (-45pp shift)
- ⬇ **High Momentum Elite**: Recent 30d UP% = 28% vs Historical 85% (-58pp shift)
- ⬇ **HTF Bull + Pullback State**: Recent 30d UP% = 36% vs Historical 78% (-42pp shift)
- ⬇ **Bull State + Momentum Elite**: Recent 30d UP% = 37% vs Historical 91% (-55pp shift)
- ⬇ **Bear State Dominance**: Recent 30d UP% = 4% vs Historical 61% (-57pp shift)
- ⬇ **ST Flip + Bear State**: Recent 30d UP% = 7% vs Historical 67% (-60pp shift)
- ⬇ **HTF Collapse**: Recent 30d UP% = 23% vs Historical 81% (-57pp shift)
- ⬇ **Multi-Signal Cluster**: Recent 30d UP% = 27% vs Historical 75% (-48pp shift)

## New Pattern Candidates

Feature combinations with directional edge not covered by existing patterns:

| Combo | N | Dir | UP% | EV | Status |
|-------|---|-----|-----|-----|--------|
| htf_low + had_bull_bull | 275 | UP | 66.2% | +18.6 | Candidate |
| scores_aligned + had_bull_bull | 106 | UP | 65.1% | +17.2 | Candidate |
| htf_rising + htf_low | 73 | UP | 67.1% | +16.3 | Candidate |
| had_bull_bull + had_bear_pullback | 17 | DOWN | 29.4% | -11.7 | Candidate |
| scores_aligned + had_bear_bear | 33 | DOWN | 27.3% | -10.3 | Candidate |
| htf_low + had_bear_bear + scores_aligned | 33 | DOWN | 27.3% | -10.3 | Candidate |
| htf_rising + ltf_rising | 12 | DOWN | 33.3% | -10.2 | Candidate |
| had_bear_bear + ema_crosses | 27 | DOWN | 33.3% | -9.9 | Candidate |
| htf_rising + had_bear_bear + st_flips | 10 | DOWN | 30% | -9.9 | Candidate |
| scores_aligned + had_bear_pullback | 26 | DOWN | 34.6% | -9.2 | Candidate |
| had_bear_bear + had_bear_pullback | 37 | DOWN | 24.3% | -7.6 | Candidate |
| ltf_rising + had_bear_bear | 22 | DOWN | 18.2% | -6.5 | Candidate |
| had_bear_bear + st_flips | 63 | DOWN | 34.9% | -3.2 | Candidate |
| ltf_rising + had_bear_pullback | 19 | DOWN | 21.1% | -2.6 | Candidate |

## Sector Regime Shifts

- ⬇ **Information Technology**: Recent 30d UP% = 34% vs Historical 70%
- ⬇ **Industrials**: Recent 30d UP% = 25% vs Historical 85%
- ⬇ **Healthcare**: Recent 30d UP% = 35% vs Historical 61%
- ⬇ **Basic Materials**: Recent 30d UP% = 60% vs Historical 96%
- ⬇ **Precious Metals**: Recent 30d UP% = 46% vs Historical 97%
- ⬇ **Crypto**: Recent 30d UP% = 0% vs Historical 60%
- ⬇ **Consumer Discretionary**: Recent 30d UP% = 0% vs Historical 82%
- ⬇ **Financials**: Recent 30d UP% = 0% vs Historical 42%
- ⬆ **Real Estate**: Recent 30d UP% = 100% vs Historical 50%

## Proposals

| Type | Pattern | Description | Severity |
|------|---------|-------------|----------|
| degrade_pattern | bull_state_dominance | Pattern "Bull State Dominance" regime shift: recent 30d UP% = 39% vs historical 79% (Δ-40pp, n_recent=59, n_hist=240) | high |
| degrade_pattern | st_flip_bull_state | Pattern "ST Flip + Bull State" regime shift: recent 30d UP% = 34% vs historical 88% (Δ-54pp, n_recent=86, n_hist=101) | high |
| degrade_pattern | st_flip_bull_state_1h | Pattern "ST Flip 1H + Bull State" regime shift: recent 30d UP% = 33% vs historical 89% (Δ-56pp, n_recent=88, n_hist=107) | high |
| degrade_pattern | ema_cross_rising_htf | Pattern "EMA Cross + Rising HTF" regime shift: recent 30d UP% = 33% vs historical 79% (Δ-45pp, n_recent=9, n_hist=14) | high |
| degrade_pattern | high_momentum_elite | Pattern "High Momentum Elite" regime shift: recent 30d UP% = 28% vs historical 85% (Δ-58pp, n_recent=105, n_hist=103) | high |
| degrade_pattern | htf_bull_pullback_recovery | Pattern "HTF Bull + Pullback State" regime shift: recent 30d UP% = 36% vs historical 78% (Δ-42pp, n_recent=11, n_hist=32) | high |
| degrade_pattern | bull_momentum_elite_bull_state | Pattern "Bull State + Momentum Elite" regime shift: recent 30d UP% = 37% vs historical 91% (Δ-55pp, n_recent=41, n_hist=46) | high |
| degrade_pattern | bear_state_dominance | Pattern "Bear State Dominance" regime shift: recent 30d UP% = 4% vs historical 61% (Δ-57pp, n_recent=24, n_hist=41) | high |
| degrade_pattern | st_flip_bear_state | Pattern "ST Flip + Bear State" regime shift: recent 30d UP% = 7% vs historical 67% (Δ-60pp, n_recent=29, n_hist=27) | high |
| degrade_pattern | htf_collapse | Pattern "HTF Collapse" regime shift: recent 30d UP% = 23% vs historical 81% (Δ-57pp, n_recent=43, n_hist=67) | high |
| degrade_pattern | multi_signal_cluster | Pattern "Multi-Signal Cluster" regime shift: recent 30d UP% = 27% vs historical 75% (Δ-48pp, n_recent=89, n_hist=8) | high |
| add_pattern | — | New pattern candidate: [htf_low + had_bull_bull] — UP bias 66.2% UP, EV=+18.6, n=275 | medium |
| add_pattern | — | New pattern candidate: [scores_aligned + had_bull_bull] — UP bias 65.1% UP, EV=+17.2, n=106 | medium |
| add_pattern | — | New pattern candidate: [htf_rising + htf_low] — UP bias 67.1% UP, EV=+16.3, n=73 | medium |
| add_pattern | — | New pattern candidate: [had_bull_bull + had_bear_pullback] — DOWN bias 29.4% UP, EV=-11.7, n=17 | low |
| add_pattern | — | New pattern candidate: [scores_aligned + had_bear_bear] — DOWN bias 27.3% UP, EV=-10.3, n=33 | medium |
| sector_regime_change | — | Sector "Information Technology" regime shift: recent 30d UP% = 34% vs historical 70% (n_recent=64) | medium |
| sector_regime_change | — | Sector "Industrials" regime shift: recent 30d UP% = 25% vs historical 85% (n_recent=24) | medium |
| sector_regime_change | — | Sector "Healthcare" regime shift: recent 30d UP% = 35% vs historical 61% (n_recent=20) | medium |
| sector_regime_change | — | Sector "Basic Materials" regime shift: recent 30d UP% = 60% vs historical 96% (n_recent=5) | medium |
| sector_regime_change | — | Sector "Precious Metals" regime shift: recent 30d UP% = 46% vs historical 97% (n_recent=13) | medium |
| sector_regime_change | — | Sector "Crypto" regime shift: recent 30d UP% = 0% vs historical 60% (n_recent=13) | medium |
| sector_regime_change | — | Sector "Consumer Discretionary" regime shift: recent 30d UP% = 0% vs historical 82% (n_recent=7) | medium |
| sector_regime_change | — | Sector "Financials" regime shift: recent 30d UP% = 0% vs historical 42% (n_recent=7) | medium |
| sector_regime_change | — | Sector "Real Estate" regime shift: recent 30d UP% = 100% vs historical 50% (n_recent=3) | medium |

---
*Generated by weekly-retrospective.js — 25 proposals pending review*