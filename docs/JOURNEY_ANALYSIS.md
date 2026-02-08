# Journey Analysis Report

Generated: 2026-02-06T22:42:50.176Z

Tickers analyzed: 268
Sustained moves found: 874
Detailed journeys analyzed: 28

## Move Archetypes Found

- **run_and_hold**: 20 moves
- **short_candidate**: 6 moves
- **run_and_peak**: 2 moves

## Top Sustained Moves

| Ticker | Dir | Duration | Move% | MaxRetrace% | Archetype |
|--------|-----|----------|-------|-------------|-----------|
| MU | SHORT | >1W | 6.28% | 2.82% | short_candidate |
| AAPL | SHORT | >1M | 14.02% | 4.41% | short_candidate |
| AXON | LONG | >1W | 6.12% | 2.92% | run_and_peak |
| DIS | LONG | >1M | 37.02% | 4.32% | run_and_hold |
| TT | LONG | >1M | 33.91% | 4.43% | run_and_hold |
| PYPL | SHORT | >1M | 33.55% | 4.33% | short_candidate |
| GE | LONG | >1M | 32.25% | 4.95% | run_and_hold |
| IBKR | LONG | >1M | 30.13% | 4.82% | run_and_hold |
| B | LONG | >1M | 28.5% | 4.77% | run_and_hold |
| GOOGL | LONG | >1M | 28.16% | 4.23% | run_and_hold |
| MSFT | LONG | >1M | 27.98% | 3.69% | run_and_hold |
| GOOG | LONG | >1M | 27.95% | 4.18% | run_and_hold |
| PATH | LONG | >1M | 27.7% | 4.98% | run_and_hold |
| ADBE | SHORT | >1M | 26.58% | 4.2% | short_candidate |
| CMG | SHORT | >1M | 26.02% | 3.66% | short_candidate |
| CRM | LONG | >1M | 25.31% | 3.88% | run_and_hold |
| GDXJ | LONG | >1M | 25.09% | 4.47% | run_and_hold |
| GILD | LONG | >1M | 24.91% | 4.04% | run_and_hold |
| CAT | LONG | >1M | 24.79% | 4.87% | run_and_hold |
| IAU | LONG | >1M | 24.4% | 3.59% | run_and_peak |
| LULU | LONG | >1M | 24.31% | 4.94% | run_and_hold |
| GRNY | LONG | >1M | 24.16% | 3.64% | run_and_hold |
| RBLX | SHORT | >1M | 23.93% | 4.68% | short_candidate |
| SANM | LONG | >1M | 23.74% | 4.38% | run_and_hold |
| PSX | LONG | >1M | 22.92% | 4.71% | run_and_hold |
| ADBE | LONG | >1M | 22.88% | 3.85% | run_and_hold |
| ABNB | LONG | >1M | 22.87% | 4.28% | run_and_hold |
| C | LONG | >1M | 22.82% | 4.9% | run_and_hold |

## Entry Signal Consensus

Signals most frequently present at the start of sustained moves:

- **fvg_bear_nearby**: 20/3 (667%)
- **fvg_bull_nearby**: 18/3 (600%)
- **ema_stacked_bull**: 6/3 (200%)
- **price_extended_above_ema21**: 5/3 (167%)
- **ema_stacked_bear**: 3/3 (100%)
- **rsi_oversold**: 3/3 (100%)
- **price_extended_below_ema21**: 3/3 (100%)
- **rsi_overbought**: 3/3 (100%)
- **rsi_bullish_momentum**: 3/3 (100%)
- **atr_expanding**: 2/3 (67%)
- **supertrend_flip_bear**: 1/3 (33%)
- **ema8_cross_below_ema21**: 1/3 (33%)
- **ema21_cross_below_ema50**: 1/3 (33%)
- **supertrend_flip_bull**: 1/3 (33%)
- **ema8_cross_above_ema21**: 1/3 (33%)

## Pullback Profile

Total pullbacks analyzed: 103

| Metric | P25 | Median | P75 | P90 |
|--------|-----|--------|-----|-----|
| Depth (%) | 0.60 | 1.22 | 2.20 | 3.29 |
| Depth (ATR) | 1.53 | 2.53 | 4.52 | 6.18 |
| Duration (bars) | 1 | 3 | 8 | 23 |

### What Held as Support During Pullbacks

- **fvg_bear**: 392/103 (381%)
- **fvg_bull**: 333/103 (323%)
- **ema8**: 22/103 (21%)
- **ema21**: 9/103 (9%)
- **supertrend**: 6/103 (6%)
- **ema50**: 5/103 (5%)
- **none**: 4/103 (4%)

### Signals Before Pullbacks (TRIM timing)

- **st_flip**: 22/103 (21%)
- **atr_spike**: 14/103 (14%)
- **rsi_overbought**: 4/103 (4%)
- **rsi_extreme**: 3/103 (3%)

## Peak/Exhaustion Signal Consensus

- **fvg_bear_near_peak**: 29/7 (414%)
- **fvg_bull_near_peak**: 25/7 (357%)
- **rsi_overbought**: 4/7 (57%)
- **price_overextended_above_ema21**: 4/7 (57%)
- **rsi_extreme_overbought**: 3/7 (43%)
- **rsi_oversold**: 2/7 (29%)
- **rsi_extreme_oversold**: 2/7 (29%)
- **price_overextended_below_ema21**: 2/7 (29%)
- **rsi_bearish_divergence**: 2/7 (29%)
- **st_flip_to_bull**: 1/7 (14%)
- **rejected_at_ema8**: 1/7 (14%)
- **st_flip_to_bear**: 1/7 (14%)
- **ema8_cross_below_ema21**: 1/7 (14%)
- **atr_spike_exhaustion**: 1/7 (14%)

## Archetype Case Studies

### run_and_peak: IAU (LONG, 24.4% over >1M)

- Start: 2025-12-29 @ $81.61
- Peak: 2026-01-28 @ $101.52
- Max retrace during move: 3.59%
- Pullbacks during journey: 1
  - PB1: -1.2% (0.93 ATR), 4 bars, held at: fvg_bull+fvg_bull+fvg_bear+fvg_bear+fvg_bear
- Entry signals: supertrend_flip_bull, ema_stacked_bull, rsi_overbought, ema8_cross_above_ema21, atr_expanding, fvg_bull_nearby, price_extended_above_ema21
- Peak signals: rsi_overbought, rsi_extreme_overbought, fvg_bull_near_peak, fvg_bear_near_peak, price_overextended_above_ema21, rsi_bearish_divergence

### run_and_hold: DIS (LONG, 37.02% over >1M)

- Start: 2025-04-16 @ $82.77
- Peak: 2025-05-14 @ $113.41
- Max retrace during move: 4.32%

### short_candidate: PYPL (SHORT, 33.55% over >1M)

- Start: 2026-01-07 @ $58.51
- Peak: 2026-02-05 @ $38.88
- Max retrace during move: 4.33%
- Pullbacks during journey: 34
  - PB1: -3.09% (8.06 ATR), 310 bars, held at: ema8+ema50+fvg_bear+fvg_bear+fvg_bull+fvg_bull+fvg_bull+fvg_bull+fvg_bull+fvg_bull+fvg_bull+fvg_bull+fvg_bull+fvg_bull
  - PB2: -1.016% (3.81 ATR), 2 bars, held at: fvg_bear+fvg_bear+fvg_bear+fvg_bear+fvg_bear+fvg_bear
  - PB3: -0.504% (2.24 ATR), 1 bars, held at: fvg_bull+fvg_bull+fvg_bull
- Entry signals: supertrend_flip_bear, ema_stacked_bear, rsi_oversold, ema8_cross_below_ema21, ema21_cross_below_ema50, atr_expanding, fvg_bear_nearby, price_extended_below_ema21, fvg_bull_nearby
- Peak signals: fvg_bear_near_peak, fvg_bull_near_peak


## Derived Rules (Data-Backed)

### Entry

Top entry signal cluster (present at move origin):

1. fvg_bear_nearby (667%)
1. fvg_bull_nearby (600%)
1. ema_stacked_bull (200%)
1. price_extended_above_ema21 (167%)
1. ema_stacked_bear (100%)

### Stop Loss

- Initial SL: Set below median pullback depth (1.22%) + buffer = **2.42%** from entry
- In ATR terms: **3.04 ATR** below entry

### TRIM

TRIM before pullbacks when these signals appear:
- st_flip (preceded 21% of pullbacks)
- atr_spike (preceded 14% of pullbacks)
- rsi_overbought (preceded 4% of pullbacks)

### Final Exit

Exit when these peak signals appear:
- fvg_bear_near_peak (present at 414% of peaks)
- fvg_bull_near_peak (present at 357% of peaks)
- rsi_overbought (present at 57% of peaks)
- price_overextended_above_ema21 (present at 57% of peaks)
- rsi_extreme_overbought (present at 43% of peaks)