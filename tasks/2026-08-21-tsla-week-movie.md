# TSLA last week into this week — the rideable movie

Operator (2026-08-21): what did TSLA do from last week into this week
that could have been observed and ridden up?

Not a SuperTrend hold. The ride was a **daily 21 EMA reclaim after a
TD9-bear wash**, on a **4H SuperTrend that had already flipped bull**,
toward a **CTO golden-gate / daily-ST ladder** the desk published on
Aug 14. Friday's daily ST flip was the late stamp, not the entry.

## The tape

Last Monday open **$326.60** → this Friday close **$363.37** (**+11.3%**).

| Window | Range | Close |
|---|---|---|
| Last week (Aug 10–14) | $323.64–$351.26 | $342.27 (+4.8%) |
| This week (Aug 17–21) | $331.12–$364.56 | $363.37 (+6.7% from Mon open) |

## Observable sequence

1. **Fri Aug 7 — 4H SuperTrend flipped bull** (close $332, stretch
   1.75 ATR above the 4H 21). 1H had flipped bull Aug 3. From here
   the 4H line rose $308 → $322 → $341 and **never got tested**.
   Closest approach was Wed Aug 12 (low $323.64, line $317, +1.03 ATR).
2. **Wed Aug 12 — the wash.** Daily TD9 bear at $327.51. Low $323.64
   (last week's low). Phase had healed from −71 (Aug 3) to −24.
3. **Thu Aug 13 — daily 21 EMA reclaim.** Close $339.96 vs 21 at
   $338.75. 1H flipped back to bull after a one-session bear dip.
   Trail: +4.0% day, still scored `HTF_BEAR_LTF_PULLBACK`.
4. **Fri Aug 14 — first target map published.** Close $342. CTO
   golden-gate-up 77–78% toward Fib 38.2% **$349**, then R2 $352,
   +1.5 ATR **$358** (the daily bear ST), R3 / +2 ATR **$362–$363**,
   Fib 50% $365. That is the entire this-week ladder, printed last
   Friday from $342.
5. **Mon Aug 17 — hold the 21.** Close $339 on the daily 21. CTO
   magnets P $342.95 / S1 $334.65. 4H printed a TD9 bear (TV
   continuation count while above the 21).
6. **Tue Aug 18 — dip that held last week's low.** Low $331.12, close
   $336.87 (lost the daily 21 by 14 cents of ATR). 1H printed **TD9
   bull** at $337 — the only bullish TD9 in the window.
7. **Wed Aug 19 — reclaim + tag last week's high.** Close $351.12
   back above the 21; high $351.62 tagged $351.26. 1H tagged the 233.
   Setup shadow opened `td_phase_mean_reversion_long` that night
   (stage 1, confidence 0.39). First close through last week's high
   waited until Friday.
8. **Thu Aug 20 — hold.** Low $338.96 (still above last week's low
   and the 4H ST). Close $345 above the 21.
9. **Fri Aug 21 — through the daily ST.** High $364.56, close $363.37.
   Daily ST flipped bull to ~$311. Dist to daily 21 = +1.41 ATR
   (chase). Cloud-pivot paper queue at 14:39 UTC (10:39 ET) — after
   the break.

## What was rideable (without waiting for the Friday flip)

From the Aug 13 21-reclaim (or the Aug 14 close above it):

- **Thesis:** mean-revert toward the daily bear ST / Fib gate while
  4H ST is already bull and rising.
- **Invalidation:** last week's low $323.64, or a 4H close back under
  ST (~$322).
- **T1** Fib 38.2% $349 (Wed this week).
- **T2** daily ST $357 / +1.5 ATR $358 (Friday).
- **T3** R3 / +2 ATR $363 (Friday close).

That is a +$10 / +$16 / +$21 ladder from $342, all on the Aug 14 CTO
card.

## What the book did with it

Trail `HTF_BEAR_*` every session Aug 3–20. **Zero `enter_now`.**
Weekly ST stayed bear ~$469. Confluence stayed WAIT (2 of 8; L7
trend still short on the weekly). `st_hold_setup` null.

It *saw* pieces: gap-reversal-long selected, 4H ST bull, CTO
golden-gate rising 24% → 78%, Wed night mean-reversion sequence
forming. It would not graduate them because HTF was still bear.
Last live tape trade was the May 28 gap-reversal loss from $441.

Friday's 10am cloud-pivot (`5_12_open_hold` + 10m/1H 34/50 long) is
the first queue of the move — paper 0.1x, after cash had already
cleared $357.

## Scripts

- Movie walk: `scripts/tsla-week-movie.mjs`
- Report: `data/tsla-week-movie/report.md`
- Related: `tasks/2026-08-21-st-hold-scan.md`
