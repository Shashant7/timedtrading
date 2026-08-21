# ETHUSD-like TD 13→9 + 233 reclaim

Operator question (2026-08-21): how many tracked tickers did something
similar to ETHUSD — flashed a TD 13 and a TD 9 on Monthly or Weekly or
Daily or 4H, reclaimed the 233 on 4H or above, then at least
mean-reverted or went higher.

**Phase Leaving is not a signal** (operator, same day). Official Saty
leave never printed on ETH monthly (June 2026 trough −33). It is not
in the gate or the clock.

**Answer:** the ETH July template — monthly TD13→9 plus a 233 reclaim
on 4H+ — printed on **one name: ETHUSD**. Weekly TD13→9 plus 233
printed on **11 other names**. Any-TF TD13→9 plus 233 is common (197
names) and is not the ETH movie.

Full tables: `data/eth-stack-scan/report.md`.
Script: `scripts/scan-eth-td-phase-233.mjs`.

## Reconstruction

- TD Sequential: TD9 = prep 9 (`close < close[4]`), TD13 = lead-up 13
  (`close < low[2]` after a TD9). Pair = 9 after 13 within 12 bars.
- 233 reclaim: close crosses from below EMA 233 on 4H / D / W.
- Signal clock = later of the TD9 and the 233 reclaim.
- Outcome: closed-higher +20d / +60d.

## ETHUSD July (confirmed)

- Monthly TD13 2026-05-01, TD9 2026-07-01
- 4H 233 reclaim 2026-07-04
- Then **+4.5% / 20d**, **+34.9% / 60d**

## Counts (316 tickers)

| Cut | Names | Setups | Closed +20d | Closed +60d | Avg +20d | Avg +60d |
|---|---:|---:|---:|---:|---:|---:|
| Monthly TD13→9 + 233 | 1 | 1 | 1 | 1 | +4.5% | +34.9% |
| Weekly TD13→9 + 233 | 11 | 11 | 6 | 7 | −0.1% | +8.0% |
| HTF (M or W) + 233 | 12 | 12 | 7 | 8 | +0.3% | +10.3% |
| Any TF TD13→9 + 233 | 197 | 343 | 176/326 | 192/326 | +1.5% | +7.5% |

## HTF names

Monthly: **ETHUSD**

Weekly: ADBE, AG, BE, BMNR, COIN, JETS, SEDG, SRAD, TSM, UTHR, VX1!

| Ticker | Date | TD13 → TD9 | 233 | +20d | +60d |
|---|---|---|---|---:|---:|
| ETHUSD | 2026-07-04 | 2026-05-01 → 2026-07-01 (M) | 4H | +4.5% | +34.9% |
| TSM | 2023-09-11 | 2023-07-31 → 2023-09-11 (W) | D | −0.7% | +7.9% |
| UTHR | 2024-02-23 | 2024-01-22 → 2024-02-12 (W) | D | +5.4% | +14.7% |
| JETS | 2024-07-30 | 2024-06-10 → 2024-07-15 (W) | D | −4.0% | +18.3% |
| ADBE | 2024-11-13 | 2024-10-21 → 2024-11-04 (W) | D | −10.9% | −13.1% |
| AG | 2024-12-30 | 2024-12-23 → 2024-12-30 (W) | D | +4.1% | +13.9% |
| BE | 2025-05-13 | 2025-03-24 → 2025-04-28 (W) | D | +13.7% | +72.5% |
| VX1! | 2026-01-20 | 2025-12-28 → 2026-01-18 (W) | 4H | +7.9% | +6.6% |
| COIN | 2026-03-04 | 2026-02-09 → 2026-02-16 (W) | 4H | −17.2% | −12.8% |
| SRAD | 2026-06-08 | 2026-04-20 → 2026-05-18 (W) | W | +3.9% | −16.1% |
| BMNR | 2026-07-27 | 2026-06-22 → 2026-07-06 (W) | 4H | +26.5% | n/a (short) |
| SEDG | 2026-08-03 | 2026-07-27 → 2026-07-29 (W) | 4H+D | −30.0% | n/a (short) |

Eight names printed a monthly TD13→9 at some point (ETHUSD, NKE, OKTA,
SWK, UNG, VIXY, VX1!, WULF). Only ETHUSD also reclaimed the 233 on 4H+
inside the same window.

## Caveats

- 4H history is short (~Aug 2024; ETHUSD 4H from Aug 2025).
- BMNR and SEDG are too recent for a full 60d.
- Crypto, vol (VX1!), and equity are mixed in the HTF average.
