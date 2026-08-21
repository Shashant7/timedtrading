# SuperTrend test-and-hold scan + TSLA this week

Operator (2026-08-21): how many names tested Monthly, Weekly, Daily, and
4H SuperTrend and held? And why was TSLA this past week not caught?

## TSLA this week

Not an ETH-style hold. Friday Aug 21 was a **daily SuperTrend flip**
through bear ST at $356.78 (close $363 → new bull line ~$310). Mon–Thu
highs never entered the 0.15 ATR test band of that bear line.

- Monthly bull ST far below (~$124 reconstructed / $217 live)
- Weekly **bear** far above (~$469 / $427)
- 4H rode +1.4 to +2.8 ATR above a rising bull ST
- Live `st_hold_setup` **null**; confluence **WAIT 16/100** (2 of 8
  layers). RIDE needs 6. Investor research_low / 35.
- Desk published CTO magnets Aug 17 from $339 (P $342.95 / S1 $334.65).
  The rideable movie (Aug 13 21-reclaim + Aug 14 $349/$358/$363 ladder)
  is in `tasks/2026-08-21-tsla-week-movie.md`.

## Book (316 names)

Hold = live detector (`detectSupertrendHoldFromSeries`, ST 10/3).
Stacked = same-side holds on multiple TFs inside 40 calendar days.

| Cut | Names | Setups | Closed +20d | Closed +60d | Avg +20d | Avg +60d |
|---|---:|---:|---:|---:|---:|---:|
| All four (M+W+D+4H) | 10 | 13 | 3/12 | 2/12 | −8.0% | −11.8% |
| HTF (M+W + D or 4H) | 14 | 17 | 8/17 | 8/17 | +3.6% | +18.9% |
| Any three TFs | 108 | 187 | 79/171 | 90/171 | −1.9% | +3.0% |

Per-TF holds are common (D 5609, 4H 5252, W 1202, M 481). The four-TF
stack is rare **and a losing cohort**. ETHUSD is in the three-TF list,
not all-four. TSLA has never stacked M+W+D+4H in this store.

All-four names: AAOI, AGQ, ALAB, BMNR, CF, LUNR, ORCL, SMR, STX, TTMI.

Script: `scripts/scan-st-hold-stack.mjs`.
Report: `data/st-hold-scan/report.md`.
