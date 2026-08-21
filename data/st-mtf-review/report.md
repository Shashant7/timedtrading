# SuperTrend MTF review — closed book (2026-08-21)

Reconstructed Pine SuperTrend(10, 3) at each close (`-1` bull / `+1` bear)
across 10m, 30m, 1H, 4H, D, W, M plus synthesized **6.5H** (one NYSE RTH
session) and **9H** (00/09/18 America/New_York).

Universe: **719** short-term closes (48.4% WR, +0.50% avg) + **127**
closed investor lots (40.2% WR). 191 tickers. Replay:
`node scripts/analyze-st-mtf-trades.mjs`.

LTF/session rows are thin on older names (10m/30m history does not reach
July 2025), so those classes are reported only when `n ≥ 10` on the ST
book. HTF (D/W/M) coverage is good.

## Did we observe test-the-ST, hold, and reverse?

**Almost never as the entry print.** Flip-retest / pierce-held at entry
is n&lt;8 on every TF. What the book actually entered:

| State at entry (ST book) | What it means | Result |
|---|---|---|
| **M sloping-agree** | Monthly ST rising with the trade | **n=278 · 54.7% WR · +6.3pp** |
| **W sloping-agree** | Weekly ST rising with the trade | **n=250 · 52.0% WR · +3.6pp** |
| **D sloping-agree** | Daily ST rising with the trade | **n=157 · 51.6% WR · +3.2pp** |
| W hold (flat line tested) | Weekly test-and-hold | n=64 · 51.6% WR · +3.2pp |
| 4H hold | 4H test-and-hold | n=64 · 48.4% WR · flat |
| D hold | Daily test-and-hold | n=83 · 47.0% WR · −1.4pp |
| M hold | Monthly test-and-hold | n=28 · 42.9% WR · −5.5pp |
| D / W / M **flat, no test** | Line agrees but price has not tagged it | 42.9–46.2% WR · −2 to −6pp |
| **D against** | Daily ST is the other way | **n=68 · 33.8% WR · −14.6pp** |
| **9H against** | Session-plus chart against | **n=32 · 18.8% WR · −29.7pp** |
| **6.5H against** | Cash-session chart against | n=14 · 21.4% WR · −27.0pp |
| 10m / 30m against | Intraday ST against | 21.6% / 23.1% WR |
| 6.5H hold | Cash-session hold as entry | n=12 · 16.7% WR · **avoid** |
| 10m / 30m / 1H hold | LTF hold as entry | 23–38% WR · **avoid** |

A later HTF hold *after* entry did print (78 trades: 4H/D/9H). Those
trades went on to **26.9% WR**. That is not “wait for the retest” edge —
it is the cohort that already entered early and then finally tagged the
line on the way to a loss.

The ETHUSD monthly “flat ST tested and held” movie is real and stays the
defined-risk *playbook* for that shape. It is not the dominant entry in
this ST book (357 of 719 are Gap Reversal Long). On this book, **slope
on W/M/D is the ignition**, and **against on D/9H/6.5H/LTF is the veto**.

## How to treat each SuperTrend event

| Event | Treatment |
|---|---|
| **Flip and slope** on W or M (and D if not against) | Ignition. Highest closed-book lift. |
| **Fresh flip + pullback to test** (`st_flip_retest`) | Still the defined-risk entry when it prints. Too rare here to measure lift. Prefer it over a stretch flip. |
| **Flat ST, no test** | READY. Not an entry. Underperforms on every HTF. |
| **Stretch flip off the 21 EMA** | READY. Do not chase. Sample on D is n=11 (do not overfit the 82% WR). |
| **Hold on 10m / 30m / 6.5H** | Not RIDE. Those holds lost. |
| **Against on 10m / 30m / 6.5H / 9H / D / 4H** | Hard veto unless weekly or monthly slope still agrees. |
| **Against on W/M** | Soft. Monthly slope can lead a daily that has not flipped yet. |

## Setup mix (ST book)

Gap Reversal Long is the only large path above water (n=357, 57.1% WR).
ATH breakout, N-test support, and support bounce are below 42%. Those
losers cluster with **against** and **flat-no-test**, not with W/M slope.

Investor closes (n=127) are a different clock: 40.2% WR, +2.04% avg when
they win. HTF-held vs not does not separate that book. Do not tune
investor invalidation off the ST gap-reversal sample.

## 6.5H and 9H

Both are unique views and now exist in scoring (synthesized from 30m/60m,
no extra candle fetch):

- **6.5H** = one bar per NYSE cash session. Useful as “was the session
  SuperTrend with or against the trade?” Against is lethal; hold is not
  an entry.
- **9H** = 00:00 / 09:00 / 18:00 America/New_York. The 09:00–18:00 bar
  is RTH + first two hours of after-hours. Against is the strongest
  session veto in the sample (18.8% WR). Slope n=11 is too small to
  promote as ignition.

They are **not** added to `assembleStHoldSetup` / `flags.st_hold`. They
are on `tf_tech` and they participate in the hard-against veto.

## Live changes from this review

1. Swing slope trigger is now **1H / 4H / D / W / M** (W and M were missing).
2. Hard-against veto on **4H / 6.5H / 9H / D** unless W or M slope agrees.
3. Session TFs computed in `computeServerSideScores` from bars already fetched.
4. Flip-retest / pierce still outrank a plain hold; stretch flip stays READY.
5. 6.5H / 9H holds do **not** set RIDE.

`SCORING_VERSION` → `2.1.0-2026-08-21`.
