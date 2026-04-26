# V15 P0.6 — Exit Engine Root Cause Analysis

**Date:** 2026-04-26
**Status:** Diagnostic complete. Fix requires touching MFE propagation during replay.

## Symptom

LITE Jul 14 trade peaked at +13.15% (per persisted `max_favorable_excursion`)
but exited at +4.87% via `mfe_proportional_trail`. Multiple V15 P0.6 fix
attempts (peak_lock rule, mfe_proportional_trail suppression with daily
EMA5/EMA12 awareness) had no effect on this outcome.

## Root cause

**During replay, `openPosition.maxFavorableExcursion` does NOT track the
actual cumulative MFE.** Wrangler tail captured the live values seen by
the gate during the LITE replay:

```
[MFE_PROP_TRAIL_GATE] LITE pnl=3.73% mfe=3.60% distE12=4.58 ...
[MFE_PROP_TRAIL_GATE] LITE pnl=4.58% mfe=3.69% distE12=4.58 ...
[MFE_PROP_TRAIL_GATE] LITE pnl=3.90% mfe=4.32% distE12=4.58 ...
```

The persisted trade record shows `max_favorable_excursion = 13.15`. But
during replay, the in-memory position only reaches `mfe = 4.32` before
the exit fires. The MFE plumbing in the replay path is not updating the
`openPosition.maxFavorableExcursion` field correctly.

The MFE update happens at line 15422 in `processTradeSimulation`:

```js
if (_curPnlPct > prevMfe) openTrade.maxFavorableExcursion = ...
```

But `classifyKanbanStage` reads from a different reference. The
`openPosition` object passed to the stage classifier is held in
`replayCtx.allTrades`, and the update at 15422 mutates it correctly.
But somehow MFE caps around 4-5% during the replay and never reaches
the eventual 13.15%.

## What WORKS in V15 P0.6

The daily 5/12 EMA suppression IS firing correctly:

```
distE12=4.58 healthy=true
```

This confirms:
- daily_structure.pct_above_e12 IS being computed (e5/e12 fields work)
- The suppression logic IS evaluated
- Suppression correctly says "don't exit, healthy pullback in trend"

So when MFE plumbing is fixed, the EMA-aware logic will correctly
hold LITE through the Jul 22 EMA5 test, then catch it on Jul 29 close
when daily EMA12 finally breaks (or the next stretch peaks).

## What DOES NOT work

- `peak_lock_e5_test_post_stretch` requires MFE >= 4.0% (the stretched
  threshold). With replay MFE capped at 4.32%, this rarely fires.
- `peak_lock_ema12_break` works in theory but rarely tested because the
  full move never reaches the system's view.

## Next steps to fix

1. Trace the MFE update path during replay end-to-end:
   - `processTradeSimulation` line 15422 update
   - How `openTrade` reference relates to `replayCtx.allTrades` items
   - Whether `classifyKanbanStage` reads from the same reference

2. Possible cause: replay is recreating openPosition each bar from a
   stale cache instead of reading the live mutated state.

3. Once MFE plumbing is fixed:
   - Run the LITE Jul 14 probe again
   - Confirm peak_lock_e5_test_post_stretch fires on Jul 22
   - Confirm exit captures 60-80% of peak (vs current 37%)

## Side benefit found

The daily EMA5/EMA12 cloud signal IS now properly exposed on
tickerData.daily_structure (added in P0.6). This unlocks a whole
class of structure-aware logic beyond just peak detection:

- Entry filter: don't enter LONG if price > +5% above EMA5 (overstretched)
- Trim trigger: trim 30% when price stretched > +3% above EMA5
- Re-entry: enter on EMA5 test (price returns to EMA5 with EMA12 holding)

These should be V15 P0.7 add-ons once MFE plumbing is fixed.
