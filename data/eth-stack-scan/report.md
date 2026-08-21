# ETHUSD-like TD 13→9 + 233 reclaim

Scanned **316** tickers over stored D / W / M / 4H candles.

## What was required

Same reconstruction as scoring (`computeTDSequential`, EMA 233), walked every bar:

- **TD 13 then 9** (bullish Sequential) on Monthly, Weekly, Daily, or 4H — prep-9 after lead-up-13, within 12 bars on that TF.
- **233 reclaim** on 4H or above (4H / D / W; monthly 233 is almost never computable).
- **Outcome** from the daily close at the later of TD9 and the 233 reclaim: closed-higher +20d / +60d is the honest bar. “Went higher or mean-reverted” is kept only as a loose check.

**Phase Leaving is not a signal.** Operator confirmed 2026-08-21. Official Saty leave (`extDn` −100 / `accum` −61.8) never printed on ETH monthly (June 2026 trough −33). It is stored as context only and does not gate or clock the stack.

| Tier | Meaning |
|---|---|
| **monthly** | TD13→9 on Monthly + 233 on 4H+ |
| **weekly** | TD13→9 on Weekly (no monthly pair in-window) + 233 on 4H+ |
| **ltf** | TD13→9 only on Daily or 4H + 233 on 4H+ |

## Headline

- **Monthly TD13→9 + 233 (ETH July template):** 1 names / 1 setups. Closed higher +20d **1/1**, +60d **1/1**. Avg +20d 4.54%, +60d 34.94%.
- **Weekly TD13→9 + 233:** 11 names / 11 setups. Closed higher +20d **6/11**, +60d **7/11**. Avg +20d -0.11%, +60d 8.04%.
- **HTF (monthly or weekly) + 233:** 12 names / 12 setups. Closed higher +20d **7/12**, +60d **8/12**. Avg +20d 0.28%, +60d 10.28%.
- **Any TF TD13→9 + 233:** 197 names / 343 setups. Closed higher +20d **176/326**, +60d **192/326**. Avg +20d 1.52%, +60d 7.54%.

## ETHUSD sanity

Coverage: M 104 bars 2018-01-01→2026-08-01; W 317 bars 2020-07-27→2026-08-17; D 1694 bars 2022-01-01→2026-08-21; 240 2192 bars 2025-08-21→2026-08-21.

| Date | Tier | TD TFs | TD13 → TD9 | 233 | +20d | +60d |
|---|---|---|---|---|---:|---:|
| 2023-10-23 | ltf | D | 2023-10-10 → 2023-10-11 | D | 15.9% | 31.8% |
| 2025-11-09 | ltf | 240 | 2025-11-03 → 2025-11-03 | 240,D | -16.6% | -13.3% |
| 2026-02-06 | ltf | 240 | 2026-02-05 → 2026-02-05 | D | -1.7% | 8.7% |
| 2026-03-15 | ltf | 240 | 2026-03-05 → 2026-03-06 | 240 | -5.2% | 4.8% |
| 2026-05-16 | ltf | 240 | 2026-05-15 → 2026-05-16 | 240 | -27.5% | -12.1% |
| 2026-07-04 | monthly | M | 2026-05-01 → 2026-07-01 | 240 | 4.5% | 34.9% |

## Monthly TD13→9 + 233

| Ticker | Date | Tier | TD | TD13 → TD9 | 233 | +20d | MFE20 | +60d |
|---|---|---|---|---|---|---:|---:|---:|
| ETHUSD | 2026-07-04 | monthly | M | 2026-05-01 → 2026-07-01 | 240 | 4.5% | 8.6% | 34.9% |

## Weekly TD13→9 + 233

| Ticker | Date | Tier | TD | TD13 → TD9 | 233 | +20d | MFE20 | +60d |
|---|---|---|---|---|---|---:|---:|---:|
| TSM | 2023-09-11 | weekly | W | 2023-07-31 → 2023-09-11 | D | -0.7% | 2.1% | 7.9% |
| UTHR | 2024-02-23 | weekly | W | 2024-01-22 → 2024-02-12 | D | 5.4% | 9.9% | 14.7% |
| JETS | 2024-07-30 | weekly | W | 2024-06-10 → 2024-07-15 | D | -4.0% | -0.4% | 18.3% |
| ADBE | 2024-11-13 | weekly | W | 2024-10-21 → 2024-11-04 | D | -10.9% | 3.8% | -13.1% |
| AG | 2024-12-30 | weekly | W | 2024-12-23 → 2024-12-30 | D | 4.1% | 10.4% | 13.9% |
| BE | 2025-05-13 | weekly | W | 2025-03-24 → 2025-04-28 | D | 13.7% | 13.7% | 72.5% |
| VX1! | 2026-01-20 | weekly | 240,W | 2025-12-28 → 2026-01-18 | 240 | 7.9% | 12.7% | 6.6% |
| COIN | 2026-03-04 | weekly | 240,W,D | 2026-02-09 → 2026-02-16 | 240 | -17.2% | 0.6% | -12.8% |
| SRAD | 2026-06-08 | weekly | W | 2026-04-20 → 2026-05-18 | W | 3.9% | 11.1% | -16.1% |
| BMNR | 2026-07-27 | weekly | 240,W | 2026-06-22 → 2026-07-06 | 240 | 26.5% | 26.5% | 26.5% |
| SEDG | 2026-08-03 | weekly | 240,W,D | 2026-07-27 → 2026-07-29 | 240,D | -30.0% | 8.1% | -30.0% |

## Names — monthly

ETHUSD

## Names — HTF (monthly or weekly)

ADBE, AG, BE, BMNR, COIN, ETHUSD, JETS, SEDG, SRAD, TSM, UTHR, VX1!

## Caveats

- 4H history starts ~Aug 2024 for most names (ETHUSD 4H from Aug 2025). Monthly 233 is not in the data.
- Daily store starts 2022 for most equity names; weekly ~2019; monthly much longer.
- Phase Leaving is annotated in the raw dump only. It does not admit or reject a stack.
- Forward returns use daily closes after the later of TD9 and the 233 reclaim. Crypto / vol ETFs / equity are mixed in the averages.
