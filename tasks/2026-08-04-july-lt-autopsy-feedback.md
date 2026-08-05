# July 2026 Long-Term Autopsy Feedback (operator)

Source: Trade Autopsy grading of `live-long-term-2026-07`, first 5 trades.

## Shared theme

Entries are mistimed. Investor deploy was not using:

- 10m SuperTrend (direction + slope)
- 10m Ripster 5-12 cloud (establish above / curl)
- Fair value gaps (hourly/daily) as balance / momentum confluence
- Mid-bearish / bear-prep context on the hourly

Long-term horizon does **not** excuse rushing the first print — wait for stabilization.

## Per-trade

| Date | Ticker | Verdict | Notes |
|---|---|---|---|
| Jul 1 | NBIS | Bad entry; late exit | Hourly bear FVG held; ST flip+slope dn; 10m bear; no 5-12 curl. Prefer Daily ATR −100 exit over −161.8. |
| Jul 1 | AMD | Bad entry; late exit | Hourly bear prep; 4H phase leaving + ST flip; no 5-12 curl; mid-bearish count. |
| Jul 1 | IESC | Bad entry | Bearish on nearly all TFs. |
| Jul 2 | TWLO | Entry OK; manage better | Trim when failed swing high and breached well beyond entry. |
| Jul 2 | MU | Bad entry; exit nuance | Gap down; no 5-12 establish/curl; ST bear+slope. Failed 233 EMA — 10m 233 reject as exit vs waiting for support. |

## Engine response

1. **Done (this PR)**: `investorLtfEntryStabilizationBlock` on auto-rebalance admit.
   - **Correction 2026-08-05**: ST veto is **slope-down only**. Bearish-but-flat
     ST is allowed (incl. bearish-flat 30m into most reversals). Do not require
     30m bullish. Confluence remains 5-12 curl + opposing daily FVG reclaim.
2. **Open**: Prefer Daily ATR −100 as tactical invalidation when in-band (NBIS).
3. **Open**: Swing-high failure trim for investor (TWLO).
4. **Open**: 10m 233 EMA reject as optional early exit / management cue (MU).
5. **Open**: Continue grading remaining July LT trades for more themes.
