# SuperTrend test-and-hold (M / W / D / 4H)

Scanned **316** tickers. Detector is the live one (`detectSupertrendHoldFromSeries`, SuperTrend 10,3). Walked every bar.

A hold is a test of the ST line (low within +0.15/−0.50 ATR of a bull line, or high of a bear line) plus a close that holds. Stacked = hold events of the same side on multiple TFs inside 40 calendar days.

## Headline

- **All four TFs (M+W+D+4H):** 10 names / 13 setups. Closed higher +20d **3/12**, +60d **2/12**. Avg +20d -7.97%, +60d -11.75%.
- **HTF (M+W plus D or 4H):** 14 names / 17 setups. Closed higher +20d **8/17**, +60d **8/17**.
- **Any three TFs:** 108 names / 187 setups.
- Per-TF hold events: M 481 on 241 names; W 1202 / 302; D 5609 / 313; 4H 5252 / 316.

## Names — all four TFs

AAOI, AGQ, ALAB, BMNR, CF, LUNR, ORCL, SMR, STX, TTMI

## Names — HTF (M+W + D or 4H)

AGQ, BMNR, CIBR, CRDO, DRIV, LEU, LUNR, MRVL, MSTR, SHOP, SMR, SOC, TTMI, TWLO

## TSLA this week

Live snapshot (2026-08-21): price **364.66**, kanban **watch**, investor **research_low / 35**, confluence **WAIT 16/100** (2 long / 2 short). `st_hold_setup` is **null**. Only 30m carries `st_pierce_held`. Monthly ST bull **216.7** (flat, $148 below). Weekly ST bear **426.54** (flat, $62 above). Daily ST bull **310.26** (sloping, $54 below). 4H ST bull **340.9** (sloping, $24 below).

RIDE needs 6 of 8 layers. A SuperTrend hold only upgrades READY→RIDE when those layers are already there. TSLA has 2.

### M

Last-bar detector: **null** (no test / hold / extended flip in the 12-bar lookback).

| Date | H | L | C | ST | Dir | Dist ATR | Test? |
|---|---:|---:|---:|---:|---|---:|---|
| 2026-06-01 | 453.4 | 368.6 | 420.6 | 123.77 | BULL | 2.48 |  |
| 2026-07-01 | 433.6 | 297.38 | 311.21 | 123.77 | BULL | 1.71 |  |
| 2026-08-01 | 432.86 | 297.38 | 345.13 | 123.77 | BULL | 1.67 |  |

### W

Last-bar detector: **null** (no test / hold / extended flip in the 12-bar lookback).

| Date | H | L | C | ST | Dir | Dist ATR | Test? |
|---|---:|---:|---:|---:|---|---:|---|
| 2026-06-29 | 432.86 | 368.6 | 393.45 | 324.25 | BULL | 1.04 |  |
| 2026-07-06 | 432.86 | 379.3 | 407.76 | 324.25 | BULL | 1.27 |  |
| 2026-07-13 | 420 | 377.22 | 380.84 | 324.25 | BULL | 1.22 |  |
| 2026-07-20 | 406.59 | 306.51 | 313.03 | 473.49 | BEAR | -3.53 |  |
| 2026-07-27 | 386.61 | 297.38 | 311.21 | 473.49 | BEAR | -3.5 |  |
| 2026-08-03 | 333.73 | 297.38 | 328.58 | 469.2 | BEAR | -3.48 |  |
| 2026-08-10 | 351.26 | 310.43 | 342.27 | 469.2 | BEAR | -3.26 |  |
| 2026-08-17 | 351.62 | 331.12 | 345.13 | 469.2 | BEAR | -2.95 |  |

### D

Last-bar detector: **null** (no test / hold / extended flip in the 12-bar lookback).

| Date | H | L | C | ST | Dir | Dist ATR | Test? |
|---|---:|---:|---:|---:|---|---:|---|
| 2026-08-17 | 345.45 | 337.48 | 339.3 | 356.78 | BEAR | -1.28 |  |
| 2026-08-18 | 345.45 | 331.12 | 336.87 | 356.78 | BEAR | -1.71 |  |
| 2026-08-19 | 351.62 | 335.7 | 351.12 | 356.78 | BEAR | -1.4 |  |
| 2026-08-20 | 347.49 | 338.96 | 345.13 | 356.78 | BEAR | -1.2 |  |
| 2026-08-21 | 364.56 | 345.13 | 363.37 | 310.04 | BULL | 2.31 |  |

### 4H

Last-bar detector: **null** (no test / hold / extended flip in the 12-bar lookback).

Holds in/near this window: 2026-08-04 st_hold SHORT @ 328.3.

| Date | H | L | C | ST | Dir | Dist ATR | Test? |
|---|---:|---:|---:|---:|---|---:|---|
| 2026-08-18 | 339.85 | 335.42 | 336.38 | 322.24 | BULL | 2.04 |  |
| 2026-08-18 | 337.63 | 335.17 | 336.89 | 322.24 | BULL | 2.1 |  |
| 2026-08-19 | 347.86 | 336.87 | 346.88 | 322.73 | BULL | 2.17 |  |
| 2026-08-19 | 349.19 | 335.7 | 346.89 | 322.73 | BULL | 1.85 |  |
| 2026-08-19 | 349.45 | 346.36 | 349.45 | 327.43 | BULL | 2.81 |  |
| 2026-08-19 | 351.62 | 346.09 | 351.11 | 328.77 | BULL | 2.61 |  |
| 2026-08-20 | 351.12 | 340.14 | 345.7 | 328.77 | BULL | 1.63 |  |
| 2026-08-20 | 347.49 | 338.96 | 342.37 | 328.77 | BULL | 1.44 |  |
| 2026-08-20 | 345.86 | 341.83 | 343.49 | 328.77 | BULL | 1.91 |  |
| 2026-08-20 | 345.36 | 341.52 | 345.28 | 328.77 | BULL | 1.92 |  |
| 2026-08-21 | 363.52 | 345.13 | 362.72 | 330.91 | BULL | 1.9 |  |
| 2026-08-21 | 364.56 | 361.33 | 363.37 | 340.9 | BULL | 2.85 |  |

### Why it was not caught

1. **No stacked M/W/D/4H hold this week.** Monthly bull ST is far below (~$124 reconstructed / $217 live). Weekly is **bear** far above (~$469 / $427). Cash traded the $330s–$360s and never tagged either HTF line.
2. **Daily was a Friday flip, not a hold.** Mon–Thu daily ST was bear at **$356.78**. Highs were $345 / $345 / $351.62 / $347 — they approached from below (~1.2–1.7 ATR away) and never entered the 0.15 ATR test band. Friday close $363 flipped daily ST to bull at ~$310. That is a stretch-through flip, not a flat-line test-and-hold.
3. **4H this week rode above a rising bull ST** (line $322→$341, lows $335–$345, +1.4 to +2.8 ATR). No test. The only nearby 4H hold was a **SHORT** on 2026-08-04.
4. **Live detector is last-bar + 12 bars**, so a 4H test two days ago expires. After the Friday flip it returns **null** on M/W/D/4H (not even `st_flip_extended` — distance to the 21 EMA did not clear the 1.5 ATR chase flag). Only 30m shows `st_pierce_held`.
5. **Confluence is WAIT 16/100.** RIDE needs 6 of 8 layers; TSLA has 2. A hold cannot ignite RIDE below that. Investor is research_low / 35; last investor book is exited; last tape trade was a May gap-reversal loss from $441.
6. **What the desk did publish** (2026-08-17): CTO magnets from $339 — upside P $342.95, downside S1 $334.65. Cash is now $364. Level note, not an ST-hold entry.

## Stacked holds

| Ticker | Date | Tier | Side | TFs | +20d | +60d |
|---|---|---|---|---|---:|---:|
| MSTR | 2022-02-24 | htf | LONG | M,W,D | 21.9% | -48.9% |
| TWLO | 2022-03-14 | htf | LONG | M,W,D | 16.1% | -13.4% |
| MRVL | 2024-01-01 | htf | SHORT | M,W,D | 16.4% | 21.8% |
| MRVL | 2024-01-01 | htf | SHORT | M,W,D | 16.4% | 21.8% |
| SHOP | 2024-11-01 | htf | SHORT | M,W,D | 40.5% | 31.3% |
| CRDO | 2025-04-01 | htf | LONG | M,W,D | 3.2% | 124.1% |
| TTMI | 2025-04-01 | htf | LONG | 240,M,W | -3.3% | 94.4% |
| TTMI | 2025-04-01 | htf | LONG | 240,M,W | -3.3% | 94.4% |
| CF | 2025-06-01 | all4 | SHORT | 240,M,W,D | -0.5% | -7.1% |
| CF | 2025-06-01 | all4 | SHORT | 240,M,W,D | -0.5% | -7.1% |
| BMNR | 2025-07-28 | htf | LONG | M,W,D | 48.3% | 68.6% |
| BMNR | 2025-08-27 | all4 | LONG | 240,M,W,D | 20.9% | -11.7% |
| LEU | 2025-09-01 | htf | LONG | M,W,D | 52.1% | 22.1% |
| SMR | 2025-12-01 | htf | LONG | M,W,D | -11.1% | -7.4% |
| SMR | 2025-12-11 | all4 | LONG | 240,M,W,D | 2.4% | -31.3% |
| CIBR | 2026-02-01 | htf | LONG | 240,M,W | -8.2% | -2.5% |
| AGQ | 2026-03-02 | all4 | LONG | 240,M,W,D | -19.0% | -24.4% |
| AGQ | 2026-03-02 | htf | LONG | 240,M,W | -19.0% | -24.4% |
| SOC | 2026-06-22 | htf | LONG | 240,M,W | -55.3% | -43.9% |
| LUNR | 2026-07-01 | all4 | LONG | 240,M,W,D | -43.6% | -8.4% |
| LUNR | 2026-07-01 | htf | LONG | M,W,D | -43.6% | -8.4% |
| ORCL | 2026-07-01 | all4 | LONG | 240,M,W,D | -17.4% | 3.6% |
| DRIV | 2026-07-06 | htf | LONG | 240,M,W | -9.9% | -7.7% |
| TTMI | 2026-07-06 | all4 | LONG | 240,M,W,D | -22.7% | -26.3% |
| AAOI | 2026-07-13 | all4 | LONG | 240,M,W,D | 18.7% | 11.6% |
| ALAB | 2026-07-13 | all4 | LONG | 240,M,W,D | -12.4% | -22.4% |
| STX | 2026-07-13 | all4 | LONG | 240,M,W,D | -5.6% | -1.6% |
| DRIV | 2026-08-04 | htf | LONG | 240,M,W | -0.5% | -0.5% |
| ALAB | 2026-08-06 | all4 | LONG | 240,M,W,D | -15.9% | -15.9% |
| ALAB | 2026-08-11 | all4 | LONG | 240,M,W,D | -11.8% | -11.8% |

## Caveats

- 4H history is short (~late 2025). Monthly 233/ST needs a long sample; most names have it.
- The walk emits a hold on the first bar the last-bar detector flips to held. Consecutive holds are one event.
- Forward returns use daily closes after the last TF in the stack.
