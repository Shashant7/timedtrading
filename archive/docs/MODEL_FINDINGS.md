# Self-Learning Model: Phase 1 Findings

> Generated: 2026-02-08T14:19:06.181Z
> Dataset: 342 significant moves with trail data (Oct 2025 – Feb 2026)
> Baseline: 68.7% UP / 31.3% DOWN

## Executive Summary

This report identifies the scoring patterns, signals, and state transitions that
most reliably precede significant price moves (≥5%) in our ticker universe.

## Key Findings

### Strongest Bullish Patterns

| Pattern | N | UP% | Avg UP | EV | Dir Acc |
|---------|---|-----|--------|-----|---------|
| **HTF/LTF Divergence (Bull)** | 1 | 100% | +84.5% | +84.5 | 100% |
| **ST Flip + Bull State** | 87 | 74.7% | +64% | +38.5 | 74.7% |
| **EMA Cross + Rising HTF** | 10 | 70% | +67% | +35.1 | 70% |
| **Multiple ST Flips** | 142 | 66.2% | +69.3% | +32.8 | —% |
| **Pullback Entry (Q4→Q1)** | 67 | 68.7% | +63.5% | +31.5 | 68.7% |

- **HTF/LTF Divergence (Bull)**: HTF rising while LTF falling — bullish divergence, LTF may snap back
- **ST Flip + Bull State**: SuperTrend flip while in or transitioning to bull state
- **EMA Cross + Rising HTF**: EMA crossover combined with rising HTF scores — trend confirmation
- **Multiple ST Flips**: 2+ SuperTrend flips — high volatility, potential reversal/breakout
- **Pullback Entry (Q4→Q1)**: HTF_BULL_LTF_PULLBACK → HTF_BULL_LTF_BULL transition — classic dip-buy

### Strongest Bearish Patterns

| Pattern | N | DOWN% | Avg DOWN | EV | Dir Acc |
|---------|---|-------|----------|-----|---------|
| **Squeeze Release (Bear)** | 9 | 100% | -40.7% | -40.7 | 100% |
| **Squeeze Release (Bull)** | 22 | 72.7% | -37.6% | -12.4 | 27.3% |
| **HTF Bear + Pullback Fail** | 8 | 62.5% | -34.2% | -7.7 | 62.5% |
| **Multi-Signal Cluster** | 36 | 63.9% | -37.6% | -6.7 | —% |
| **Bull Alignment** | 2 | 50% | -49.8% | -5.6 | 50% |

- **Squeeze Release (Bear)**: Squeeze release without bull state — expansion into weakness
- **Squeeze Release (Bull)**: Squeeze release with HTF bull state — volatility expansion in trend direction
- **HTF Bear + Pullback Fail**: HTF falling with a bear pullback — failed recovery attempt
- **Multi-Signal Cluster**: 3+ different signal types firing — convergence of indicators
- **Bull Alignment**: HTF & LTF both rising, scores aligned — strong trend continuation setup

### Best Compound Patterns (2-archetype combos)

| Pattern Combo | N | Bias | Bias% | EV |
|---------------|---|------|-------|-----|
| ▼ Bear State Dominance + Squeeze Release (Bear) | 6 | BEARISH | 100% | -43.7 |
| ▼ Squeeze Release (Bear) + ST Flip + Bear State | 8 | BEARISH | 100% | -41.6 |
| ▼ Bear State Dominance + Multi-Signal Cluster | 7 | BEARISH | 100% | -41.5 |
| ▼ High Momentum Elite + Squeeze Release (Bear) | 7 | BEARISH | 100% | -41.3 |
| ▼ Squeeze Release (Bear) + Multiple ST Flips | 9 | BEARISH | 100% | -40.7 |
| ▼ Squeeze Release (Bear) + Multi-Signal Cluster | 8 | BEARISH | 100% | -40.6 |
| ▼ Bull State Dominance + Squeeze Release (Bull) | 7 | BEARISH | 100% | -40 |
| ▼ ST Flip + Bear State + Multi-Signal Cluster | 10 | BEARISH | 100% | -39.3 |
| ▲ Bull State Dominance + ST Flip + Bull State | 51 | BULLISH | 76.5% | +39.1 |
| ▲ Bull State Dominance + Multiple ST Flips | 51 | BULLISH | 76.5% | +39.1 |

## Feature Importance

How much each feature shifts the probability of an UP move vs baseline:

| Feature | When Present UP% | When Absent UP% | Lift | Direction |
|---------|------------------|-----------------|------|-----------|
| squeeze_releases | 19.4% | 73.6% | -54.3% | BEARISH |
| htf_ltf_diverging | 22.2% | 70% | -47.7% | BEARISH |
| had_bear_pullback | 41.2% | 71.8% | -30.6% | BEARISH |
| had_bear_bear | 44.7% | 72.5% | -27.9% | BEARISH |
| ltf_rising | 45.2% | 71.1% | -25.9% | BEARISH |
| had_bull_bull | 75% | 59.4% | +15.6% | BULLISH |
| ema_crosses | 58.8% | 70.4% | -11.6% | BEARISH |
| ltf_falling | 59.1% | 69.4% | -10.3% | BEARISH |
| htf_rising | 73.7% | 68.1% | +5.6% | BULLISH |
| htf_falling | 64.3% | 69.6% | -5.3% | BEARISH |
| st_flips | 66.2% | 70.5% | -4.3% | BEARISH |
| had_bull_pullback | 67.3% | 69.9% | -2.6% | BEARISH |
| momentum_elite | 67.1% | 69.3% | -2.2% | BEARISH |
| scores_aligned | 67.7% | 69% | -1.3% | BEARISH |
| had_q4_to_q1 | 68.7% | 68.7% | -0.1% | BEARISH |

## State Analysis

Which scoring state (before the move) correlates with UP vs DOWN:

| State | N | UP% | DOWN% | Avg UP Mag | Avg DOWN Mag |
|-------|---|-----|-------|------------|-------------|
| HTF_BULL_LTF_BULL | 165 | 75.2% | 24.8% | +53.9% | -38.6% |
| HTF_BULL_LTF_PULLBACK | 121 | 70.2% | 29.8% | +62.9% | -38% |
| HTF_BEAR_LTF_BEAR | 36 | 41.7% | 58.3% | +51.2% | -40.6% |
| HTF_BEAR_LTF_PULLBACK | 20 | 55% | 45% | +148.8% | -41.1% |

## Sector Analysis

| Sector | Moves | UP% | Avg Magnitude |
|--------|-------|-----|--------------|
| Information Technology | 130 | 72.3% | 47.5% |
| Industrials | 56 | 67.9% | 52.9% |
| Healthcare | 41 | 53.7% | 98.6% |
| Precious Metals | 36 | 83.3% | 53.2% |
| Basic Materials | 27 | 88.9% | 44.5% |
| Crypto | 20 | 30% | 47% |
| ETF | 10 | 70% | 49.9% |
| Consumer Discretionary | 8 | 75% | 41.8% |
| Financials | 5 | 20% | 35.8% |
| Real Estate | 4 | 100% | 43.7% |
| Communication Services | 4 | 50% | 36.3% |
| Energy | 1 | 100% | 36.7% |

## Actionable Recommendations

### For Kanban Lane Classification:
1. **ENTER_NOW threshold**: Prioritize tickers matching the top bullish archetypes
2. **EXIT signals**: Flag tickers matching bearish archetypes in active positions
3. **WATCH list**: Tickers showing early-stage bullish patterns (HTF rising but not yet aligned)

### For Trade Simulation:
1. Entry trigger: Compound patterns with highest directional accuracy
2. Confidence weighting: Use archetype EV as position sizing signal
3. Stop-loss calibration: Use avg adverse excursion from matched archetypes

### Next Steps (Phase 2):
1. **Track decisions**: Log which archetypes trigger entries/exits
2. **Measure outcomes**: Compare predicted vs actual results
3. **Feedback loop**: Adjust archetype thresholds based on live outcomes

---
*Analysis based on 342 significant moves across 12 sectors*