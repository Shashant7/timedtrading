# Self-Learning Model: Phase 1 Findings

> Generated: 2026-02-12T00:52:02.002Z
> Dataset: 717 significant moves with trail data (Oct 2025 – Feb 2026)
> Baseline: 61.1% UP / 38.9% DOWN

## Executive Summary

This report identifies the scoring patterns, signals, and state transitions that
most reliably precede significant price moves (≥5%) in our ticker universe.

## Key Findings

### Strongest Bullish Patterns

| Pattern | N | UP% | Avg UP | EV | Dir Acc |
|---------|---|-----|--------|-----|---------|
| **ST Flip + Bull State** | 166 | 64.5% | +49.9% | +21.1 | 64.5% |
| **EMA Cross + Rising HTF** | 27 | 70.4% | +44.4% | +20.8 | 70.4% |
| **Strong HTF Surge** | 11 | 81.8% | +30.9% | +17.6 | 81.8% |
| **Bull State Dominance** | 352 | 63.9% | +42.2% | +15.7 | 63.9% |
| **Multiple ST Flips** | 286 | 57.7% | +51.8% | +15.6 | —% |

- **ST Flip + Bull State**: SuperTrend flip while in or transitioning to bull state
- **EMA Cross + Rising HTF**: EMA crossover combined with rising HTF scores — trend confirmation
- **Strong HTF Surge**: HTF score delta > +15 — rapid HTF strengthening
- **Bull State Dominance**: Final state is HTF_BULL_LTF_BULL — already in bullish quadrant
- **Multiple ST Flips**: 2+ SuperTrend flips — high volatility, potential reversal/breakout

### Strongest Bearish Patterns

| Pattern | N | DOWN% | Avg DOWN | EV | Dir Acc |
|---------|---|-------|----------|-----|---------|
| **Squeeze Release (Bear)** | 29 | 65.5% | -36.5% | -14.4 | 65.5% |
| **HTF Bear + Pullback Fail** | 18 | 66.7% | -33.6% | -11.6 | 66.7% |
| **Squeeze Release (Bull)** | 57 | 70.2% | -31.6% | -10.6 | 29.8% |
| **Bull Alignment** | 12 | 58.3% | -35.3% | -5.7 | 41.7% |
| **ST Flip + Bear State** | 63 | 61.9% | -38.2% | -5.5 | 61.9% |

- **Squeeze Release (Bear)**: Squeeze release without bull state — expansion into weakness
- **HTF Bear + Pullback Fail**: HTF falling with a bear pullback — failed recovery attempt
- **Squeeze Release (Bull)**: Squeeze release with HTF bull state — volatility expansion in trend direction
- **Bull Alignment**: HTF & LTF both rising, scores aligned — strong trend continuation setup
- **ST Flip + Bear State**: SuperTrend flip while in or transitioning to bear state

### Best Compound Patterns (2-archetype combos)

| Pattern Combo | N | Bias | Bias% | EV |
|---------------|---|------|-------|-----|
| ▲ Bull State Dominance + EMA Cross + Rising HTF | 9 | BULLISH | 100% | +56.4 |
| ▼ ST Flip + Bear State + HTF Bear + Pullback Fail | 9 | BEARISH | 100% | -34.9 |
| ▼ ST Flip + Bear State + HTF/LTF Divergence (Bear) | 5 | BEARISH | 100% | -34.6 |
| ▼ HTF Bear + Pullback Fail + HTF/LTF Divergence (Bear) | 5 | BEARISH | 100% | -34.6 |
| ▼ HTF Bear + Pullback Fail + Multiple ST Flips | 11 | BEARISH | 100% | -34.4 |
| ▼ High Momentum Elite + HTF Bear + Pullback Fail | 8 | BEARISH | 100% | -32.1 |
| ▼ HTF Bear + Pullback Fail + Multi-Signal Cluster | 6 | BEARISH | 100% | -32 |
| ▲ ST Flip + Bull State + EMA Cross + Rising HTF | 10 | BULLISH | 80% | +30 |
| ▲ ST Flip + Bull State + Multiple ST Flips | 165 | BULLISH | 64.8% | +21.4 |
| ▲ Bull State Dominance + ST Flip + Bull State | 101 | BULLISH | 65.3% | +21.3 |

## Feature Importance

How much each feature shifts the probability of an UP move vs baseline:

| Feature | When Present UP% | When Absent UP% | Lift | Direction |
|---------|------------------|-----------------|------|-----------|
| squeeze_releases | 31.4% | 65.1% | -33.7% | BEARISH |
| flip_watches | 93.8% | 60.3% | +33.4% | BULLISH |
| htf_ltf_diverging | 34.3% | 62.5% | -28.2% | BEARISH |
| ltf_rising | 43.4% | 63.4% | -20% | BEARISH |
| had_bear_bear | 48% | 63.2% | -15.2% | BEARISH |
| ltf_falling | 49% | 62% | -13% | BEARISH |
| had_bear_pullback | 52.7% | 62.3% | -9.6% | BEARISH |
| had_bull_bull | 64.4% | 56.1% | +8.2% | BULLISH |
| htf_falling | 54.7% | 62.6% | -7.8% | BEARISH |
| ema_crosses | 55.7% | 62.3% | -6.6% | BEARISH |
| htf_rising | 66.7% | 60.3% | +6.3% | BULLISH |
| st_flips | 57.5% | 63.5% | -6% | BEARISH |
| had_bull_pullback | 58.2% | 63.5% | -5.3% | BEARISH |
| had_q4_to_q1 | 57.6% | 62% | -4.3% | BEARISH |
| momentum_elite | 60.1% | 61.4% | -1.3% | BEARISH |
| scores_aligned | 60.4% | 61.2% | -0.8% | BEARISH |

## State Analysis

Which scoring state (before the move) correlates with UP vs DOWN:

| State | N | UP% | DOWN% | Avg UP Mag | Avg DOWN Mag |
|-------|---|-----|-------|------------|-------------|
| HTF_BULL_LTF_BULL | 352 | 63.9% | 36.1% | +42.2% | -31.3% |
| HTF_BULL_LTF_PULLBACK | 238 | 60.1% | 39.9% | +48.6% | -31.9% |
| HTF_BEAR_LTF_BEAR | 70 | 50% | 50% | +37.1% | -36.7% |
| HTF_BEAR_LTF_PULLBACK | 57 | 61.4% | 38.6% | +65.2% | -37% |

## Sector Analysis

| Sector | Moves | UP% | Avg Magnitude |
|--------|-------|-----|--------------|
| Information Technology | 246 | 60.2% | 38.6% |
| Industrials | 116 | 56.9% | 40% |
| Healthcare | 85 | 55.3% | 62% |
| Basic Materials | 59 | 86.4% | 35.1% |
| Precious Metals | 54 | 83.3% | 44.6% |
| Consumer Discretionary | 44 | 56.8% | 29.1% |
| Crypto | 41 | 43.9% | 38.6% |
| Financials | 22 | 13.6% | 30.9% |
| ETF | 17 | 64.7% | 40.9% |
| Communication Services | 16 | 56.3% | 30.6% |
| Energy | 9 | 100% | 27.6% |
| Real Estate | 7 | 85.7% | 35.9% |
| Utilities | 1 | 0% | 26% |

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
*Analysis based on 717 significant moves across 13 sectors*