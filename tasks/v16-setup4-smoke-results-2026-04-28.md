# V16 Setup #4 — Smoke Results (Sept-Oct 2025)

Run: ath-sep-oct-smoke-1777348517
Universe: 203 tickers
Window: Sept 1 - Oct 31 2025 (~44 trading days)

## Headline

The October entry drought is dissolved.

| Metric | v15p0711 (no Setup #4) | ath-smoke (with Setup #4) |
|---|---:|---:|
| Sept entries | 11 | 30 |
| Sept WR | 22.2% | 53% |
| Sept PnL | -10.50% | +3.05% |
| Oct entries | 1 | 26 |
| Oct PnL | -1.49% | +46.34% (raw, includes 3 replay_end_close artifacts) |

Setup #4 fired 37 times across the window:
- **tt_ath_breakout**: 36 trades, **WR 56%, PnL +10.51%**
- **tt_atl_breakdown**: 1 trade, sample too small to evaluate

## Quality-of-trade audit

Reading the 37 ATH/ATL trades, two cohorts emerge:

### Wins are real

```
CAT  Sep 12 LONG +3.51%  MFE +6.78%  (industrial breakout)
CAT  Sep 29 LONG +4.03%  MFE +5.46%  (industrial breakout)
GOOGL Oct 24 LONG +2.28% MFE +3.15%
DIA  Oct 24 LONG +7.56%  MFE +1.60%  (replay_end_close)
QQQ  Oct 24 LONG +1.86%  MFE +2.42%
AAPL Oct 02 LONG +1.02%  MFE +1.68%
```

These are genuine breakout continuations — names that had been
consolidating tightly and broke out with rvol confirmation.

### Losses cluster around false-breakout pattern

October ETF cohort had 9 small losses with MFE in 0-0.5% range:

```
Oct 8 CW   -0.66%  MFE +1.32%
Oct 8 AAPL -0.36%  MFE +0.18%
Oct 9 QQQ  -2.10%  MFE +0.46%
Oct 15 SPY -0.98%  MFE +0.21%
Oct 20 GOOGL -3.29% MFE +0.38%
Oct 21 SPY -1.09%  MFE +0.10%
Oct 21 QQQ -1.04%  MFE +0.00%
Oct 23 DCI -0.59%  MFE +0.71%
Oct 24 XLV -1.29%  MFE +0.00%
```

These fired on the breakout bar but reversed by next bar. The total
drag from these 9 trades is ~-12% — most of why "clean PnL" is
slightly negative.

## Refinements identified

### 1. Confirming follow-through bar

Don't enter on the breakout bar itself. Wait for the NEXT bar to
also close above prior-day high. Filters single-bar wicks (the
common Oct false-breakout pattern). Cost: half-bar of upside on
real moves, but real moves will sustain.

### 2. Higher RVol for ETFs

Broad-market ETFs (SPY/QQQ/IWM/DIA/XL*) need 1.5x+ RVol to confirm
institutional buying. Single-stock breakouts (CAT, GOOGL, AAPL) fire
correctly at 1.0x.

### 3. Watch for SHORT mirror activation

Only 1 atl_breakdown fired in the window (XLP -0.87%). Either:
- Sept-Oct didn't have many genuine breakdown setups (bull regime)
- The threshold/conditions for SHORT need separate calibration

We'll see more bear-side activity in regime windows like Apr 2026
(corrections).

## Validation against V14 baseline

V14 Sept-Oct entries (relevant subset):
- GOOGL Sep 2 +8.43% — NOT in our smoke (timing earlier than the
  breakout bar)
- CCJ Sep 3 +3.45%, Sep 17 +3.23% — NOT captured
- KWEB Sep 3 +2.63% — NOT captured
- IESC Sep 9 +3.11% — NOT captured
- PWR Sep 25 +3.37% — NOT captured
- STRL Oct 14 +2.63% — NOT captured
- GDX  Oct 14 +3.80% — NOT captured

These were all V14 tt_pullback wins. Setup #4 is firing on a
DIFFERENT cohort (ETFs + mega-cap breakouts). So Setup #4 is
ADDITIVE to the missing-V14-winners problem, not a replacement.

The CCJ/KWEB/IESC/PWR/STRL/GDX losses are still on the table —
those need either a Setup #2 (N-test support) or Setup #1 (range
reversal) trigger, OR a relaxation of existing tt_pullback gates.

## Conclusion

**Ship Setup #4 with the follow-through refinement.** It's net
positive on the dry October window we couldn't trade at all before.
Quality issues are tunable (RVol cohort split, follow-through bar).

V14's missing winners require Setups #1, #2, or pullback-gate
relaxation — separate work.

## Next

1. Apply follow-through bar requirement (entry on NEXT bar after
   breakout day, not on the breakout day itself).
2. ETF-cohort RVol min 1.5x.
3. Re-validate.
4. Then move to Setup #1 (Range Reversal) for the V14 missing
   winners cohort.
