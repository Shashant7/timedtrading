# V15 P0.7.11 Loss Analysis — Through Ripster Swing-Setup Lens

Created: 2026-04-28
Run: v15p0711-fullrun-1777332431 (resumed Jul 1 → Oct 13)
Trades closed: 58
Losses: 29 (total drag -31.42%)

## Setup-family attribution

**100% of losses entered via `tt_pullback` (TT Tt Pullback setup).**

Our system is mono-cultured on Setup #3 (Uptrend Bounce on EMA). Every
loss is a tt_pullback that didn't work. None are from the other 4
Ripster patterns (range reversal, n-test support, ATH breakout, gap
reversal) because **we don't have triggers for those**.

This means:
- We're missing the diversification that Ripster's framework provides
- We're paying the cost of pullback setups failing without any
  offsetting wins from setups that work in different regimes
- October 2025 (post-FOMC bull-grind, no real pullbacks) was the
  textbook "no pullback setups" environment — and we had 1 trade in
  11 trading days

## Loss pattern breakdown (29 losses)

### Pattern A — Zero-MFE losses (9 trades, -13.35%)

These entered and immediately went red, never showing 0.5% gain:

```
TT, FIX, HII, KWEB, XHB (Jul)
AXP, PLTR, NXT (Sept)
IWM (Oct)
```

**Diagnosis:** Bad timing — entry signal fired late in the move or
into a thrust that was already exhausted. These are largely small
losses (~-1% avg) that fast-cut handled correctly.

**Ripster framework would help:** Setup #4 (ATH breakout) requires
"tight base near 52w high" — these would be filtered out before
entry on names that aren't breaking out. Setup #2 (N-test support)
requires confirmed N≥3 tests of horizontal — also filters out
single-touch dip-buys that fail.

### Pattern B — MFE-then-reversed losses (12 trades, -5.75%)

These showed real MFE (0.5-3.08%) but reversed back to red:

```
ETN +1.89% MFE → -0.21%
MTZ +2.76% MFE → -0.67%
BK +3.08% MFE → -0.07%
BWXT +2.67% MFE → -0.39%
IWM +1.67% MFE → -0.74%
+ 7 smaller cases
```

**Diagnosis:** Our exit logic let the trade ride past its peak then
reverse. These ARE pullback setups that worked initially. The exits
(atr_day_adverse_382_cut, max_loss_time_scaled, runner_drawdown_cap)
fire too late or too early.

**Ripster framework would help:** Setup #1 (Range Reversal) has a
defined upper target (top of range) — we'd lock profit at the upper
edge. Setup #5 (Gap Reversal) has a defined invalidation (intraday
low) — we'd cut faster on reversal back through.

### Pattern C — Quick exits <24h (17 trades)

Most losses exit within 24 hours via fast-cut rules. That's the
intended behavior — we're not holding losers. The problem is we're
ENTERING too many of them (Pattern A overlap).

### Pattern D — Long-hold losses >72h (7 trades, -4.19%)

These are particularly painful — held for days, hit positive MFE,
ended red:

```
ETN  8.9d  MFE +1.89% → -0.21%   max_loss_time_scaled
MTZ  6.0d  MFE +2.76% → -0.67%   atr_day_adverse_382_cut  
BK   6.9d  MFE +3.08% → -0.07%   PROFIT_GIVEBACK_STAGE_HOLD
BWXT 3.8d  MFE +2.67% → -0.39%   max_loss_time_scaled
IWM  5.8d  MFE +0.13% → -0.81%   early_dead_money_flatten
IWM  7.0d  MFE +1.67% → -0.74%   SMART_RUNNER_SUPPORT_BREAK_CLOUD
```

**Diagnosis:** Trades that could have been small wins or scratches
turned into losses because we didn't lock profit at the peak.

**Ripster framework would help:** Setup #1 / #2 have defined targets
(upper range edge / next resistance after support test). We'd take
profit at those targets instead of trying to ride further.

## October drought — the bigger picture

**Oct 2 - Oct 13 in this run: 1 entry across 11 trading days.**

This is a regime where:
- SPY was grinding higher in a tight range ($658→$673)
- No deep pullbacks (Setup #3 doesn't fire)
- No clean range breakouts (we have no Setup #1/#4 triggers)
- No gap reversals (we have no Setup #5 trigger)
- No N-test confirmations (we have no Setup #2 counter)

**We have ONE entry pattern (tt_pullback). When that pattern doesn't
fire, we don't trade.** That's an existential issue for the engine.

## Comparison: V14 captured what we missed in Sept

V14 took 20 Sept trades for +7.83% PnL (50% WR).
P0.7.11 took 11 Sept trades for -10.50% PnL (22% WR).

V14 missed entries we still don't take:
- GOOGL Sep 2 +8.43%
- CCJ Sep 3 +3.45%, CCJ Sep 17 +3.23% (two clean continuations)
- KWEB Sep 3 +2.63%
- IESC Sep 9 +3.11%
- PWR Sep 25 +3.37%

**All 6 were tt_pullback in V14** (same setup family). So V14 was
catching the same setup type with different gating logic. Our gates
(conviction floor + h3_consensus + various tt_pullback-specific
filters) have evolved to filter MORE strictly — net negative when
combined with no diversification.

## The mandate from this analysis

**We need ALL 5 Ripster setup families** so we always have a working
pattern in any regime. Currently:

```
Regime                           V15 P0.7.11 coverage
----------------------------------------------
Strong uptrend with pullbacks    ✓ tt_pullback
Bull-grind, no pullbacks         ✗ NEEDS Setup #4 (ATH breakout)
Range-bound chop                 ✗ NEEDS Setup #1 (range reversal)
Range with multiple support tests ✗ NEEDS Setup #2 (n-test support)
Volatile / gap reversals         ✗ NEEDS Setup #5 (gap reversal)
Strong downtrend with bounces    ⚠ tt_pullback works for SHORTs
```

Without these, we will:
- Continue having dry spells in non-pullback regimes (Sept/Oct)
- Be forced to over-relax pullback gates to capture trades, which
  admits low-quality losses (Pattern A)
- Miss winners that fire on other patterns (V14 GOOGL/CCJ/KWEB pattern
  was likely "ATH breakout" or "n-test support" disguised as
  tt_pullback)

## Implementation priority

Per `tasks/v16-ripster-swing-setups-spec-2026-04-27.md`:

1. **Setup #4 (ATH/52w breakout)** — simplest add, affects bull-grind
   regime where we currently die. Just a gate boost on existing
   tt_momentum.
2. **Setup #1 (Range Reversal)** — medium complexity. Catches
   range-bound chop entries we currently miss.
3. **Setup #5 (Gap Reversal)** — medium-complex. Has carve-outs
   needed for existing gap-related blocks.
4. **Setup #2 (N-Test Support)** — most data-infrastructure work.
   Requires rolling support cluster tracking.

## Next session

Build Setup #4 first (smallest scope, highest impact on October
drought). Validate against this run's blocked-bar data: which trades
WOULD it admit in October? Show would-pass cohort >= 60% WR
expectation before shipping.

Then iterate to #1, #5, #2.

V14 already proved these patterns work in our universe. We just need
to route them as named triggers with their own gates.
