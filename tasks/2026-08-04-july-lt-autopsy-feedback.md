# July 2026 Long-Term Autopsy Feedback (operator)

Source: Trade Autopsy grading of `live-long-term-2026-07`, first 5 trades.

## Shared theme

Entries are mistimed. Investor deploy was not using:

- 10m SuperTrend (direction + slope)
- 10m Ripster 5-12 cloud (establish above / curl)
- Fair value gaps (hourly/daily) as balance / momentum confluence
- Mid-bearish / bear-prep context on the hourly
- LTF price vs **EMA-233** (near/below = short territory; want reclaim + gaining)

Long-term horizon does **not** excuse rushing the first print — wait for stabilization.

**Management (movie):** after a bad entry goes underwater then nearly recovers to breakeven and rejects, exit on that sequence — do not wait for Weekly ATR support.

## Per-trade

| Date | Ticker | Verdict | Notes |
|---|---|---|---|
| Jul 1 | NBIS | Bad entry; late exit | Hourly bear FVG held; ST flip+slope dn; 10m bear; no 5-12 curl. Prefer Daily ATR −100 exit over −161.8. |
| Jul 1 | AMD | Bad entry; late exit | Hourly bear prep; 4H phase leaving + ST flip; no 5-12 curl; mid-bearish count. |
| Jul 1 | IESC | Bad entry | Bearish on nearly all TFs. |
| Jul 2 | TWLO | Entry OK; manage better | Trim when failed swing high and breached well beyond entry. |
| Jul 2 | MU | Bad entry; exit nuance | Gap down; no 5-12 establish/curl; ST bear+slope. Failed 233 EMA — 10m 233 reject as exit vs waiting for support. |
| Jul 2 | MTZ | Bad entry; late exit (movie) | Same under-233 / bad LTF entry. Hard drop → nearly BE → reject at 233/clouds — should exit on reject, not wait for Weekly ATR support. |
| Jul 6–16 | ANET | Entry OK theme / bad manage | Entered Jul 6 ~$171 (slightly chasing open peak). Daily 21 EMA had tested night-before + held — solid signal; stamp to ticker memory. Rallied ~190 with no profit trim. Jul 16 `PRIMARY_INVALIDATION_BREACH` at 2:02pm below Weekly ATR $167.85 was a **wick/frame** — support reclaimed and held by 2pm; still exited. Held = PLTR path (earnings rally); ANET cut = missed ~10% move. |

## Engine response

1. **Done (this PR)**: `investorLtfEntryStabilizationBlock` on auto-rebalance admit.
   - **Correction 2026-08-05**: ST veto is **slope-down only**. Bearish-but-flat
     ST is allowed (incl. bearish-flat 30m into most reversals). Do not require
     30m bullish. Confluence remains 5-12 curl + opposing daily FVG reclaim.
2. **Open**: Prefer Daily ATR −100 as tactical invalidation when in-band (NBIS).
3. **Open**: Swing-high failure trim for investor (TWLO) — related to ANET 190 peak.
4. **Open**: 10m 233 EMA reject as optional early exit / management cue (MU).
5. **Done**: LTF EMA-233 reclaim/break-through as leading timing (IESC Jul 2, AMD Jul 1).
6. **Done**: Failed entry-reclaim exit (MTZ movie — underwater → near BE → reject).
7. **Done (ANET)**: Primary invalidation **movie** — arm on live breach; fire only on
   session/daily close below floor, prior close already below + still below, or
   sustained hold-below without reclaim. Reclaim clears the arm.
8. **Done (ANET)**: Daily EMA(21) test/reclaim signal in accum zone +
   `INVESTOR_STRUCTURAL_ANCHORS.ANET.daily_ema21_respect` memory.
9. **Done (ANET)**: MFE extension trim (≥10% peak, bank ~25%) so 171→190 is not
   a zero-bank ride.
10. **Open**: Continue grading remaining July LT trades for more themes.
