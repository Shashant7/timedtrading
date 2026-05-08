# Phase C — Cohort Segmentation (Jul 2025 → May 2026)

**Universe:** `configs/backtest-universe-phase-c-stage1.txt` (238 symbols)
**Analysis window:** 2025-07-01 → 2026-05-08 (cache truncates per-ticker; most series end **2026-04-17**, ~3 weeks short of May 8 — acceptable for cohort labeling)
**Source:** locally-cached daily candles at `/workspace/data/universe-cache/` (fetched via `scripts/cohort-segmentation.js`, no network calls).
**SPY benchmark return over window:** 14.97%

## Coverage

- Cache present for **230** of 238 tickers.
- Excluded with no candle data: **8** — `CL1!, ES1!, GC1!, NQ1!, RTY1!, SI1!, VX1!, YM1!` (futures contracts and rotated-out tickers).
- Excluded with <20 bars in window (post-window IPOs etc.): **1** — `P`.
- Final analysed set: **229** tickers.

## Cohort thresholds (return % over window)

| cohort | rule | n | % of analysed |
|---|---|---:|---:|
| **WINNERS** | >= +30% | 88 | 38.4% |
| **MODERATE** | +10% .. +30% | 55 | 24.0% |
| **STAGNANT** | -10% .. +10% | 45 | 19.7% |
| **LOSERS** | <= -10% | 41 | 17.9% |

**Trend integrity is measured on CLOSES ONLY** (per user direction): wicks below an EMA mid-bar do NOT count toward a "broken trend" call. Three close-discipline trend filters in the system, each operative at a different layer:

| filter | timeframe | role | where used |
|---|---|---|---|
| **Weekly EMA-21** | weekly | macro / structural trend | cohort gate (this file) + Trend-Hold demotion |
| **Daily 5/12 cloud** | daily | fast trend confirm | per-trade decisions: entry confirm, DCA reclaim, exit |
| **4H EMA-21** | 4H | tactical trend filter | per-trade decisions: entry confirm, exit |

At the **cohort level** the only hard gate is the macro filter: longest consecutive weekly-close-below-EMA-21 streak ≤ 2 (i.e. trend can dip below for 1-2 weeks but must recover). Daily 5/12 cloud streak is captured as a column and used as a CLEAN-vs-RESILIENT *sub-classifier*, not a hard cut — high-vol mega-runners (SNDK, BE, MU, SOXL, GOOGL) routinely close below the daily cloud for 10-22 days during consolidation phases yet never break the macro weekly trend.

> **Note on 4H EMA-21:** the 4H trend filter is operative inside the Trend-Hold module (per-trade entry confirm, DCA, exit) but cannot be computed from the daily-only candle cache here. It is folded into per-ticker forensics (Phase 1.2) via `direction_accuracy.signal_snapshot_json` for traded names + targeted 4H fetch for non-traded TH candidates.

**Trend-Hold-Candidate sub-cohort** (within WINNERS, weekly EMA-21 streak ≤ 2) → **50** tickers, split by daily-cloud / DD profile:
- **CLEAN_TREND** (low-vol grinders): max DD ≥ -25%, weekly streak ≤ 1, daily-cloud streak ≤ 10 → **8** tickers.
- **RESILIENT_TREND** (high-vol mega-runners): weekly streak ≤ 2 regardless of DD or daily-cloud streak → **42** tickers.

The split matters for the Trend-Hold management profile: CLEAN_TREND tickers tolerate a tight weekly-EMA-21 trail and a strict daily-cloud DCA trigger; RESILIENT_TREND tickers need a looser trail (probably weekly-EMA-21 with a 1.5×ATR buffer) and treat daily-cloud reclaim as a *DCA-the-dip* signal rather than a stop trigger because intra-week DDs run -30% to -45% before the weekly close recovers.

## Trend-Hold candidates — CLEAN_TREND (low-vol grinders)

| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % |
|---|---:|---:|---:|---:|---:|---:|
| **WDC** | 483.5 | 483.5 | -20.6 | 0 | 8 | 468.6 |
| **STX** | 277.6 | 277.6 | -21.0 | 0 | 10 | 262.7 |
| **FIX** | 216.4 | 216.4 | -13.8 | 0 | 10 | 201.4 |
| **LRCX** | 176.4 | 181.4 | -20.1 | 0 | 10 | 161.4 |
| **LSCC** | 133.5 | 133.5 | -19.3 | 0 | 10 | 118.5 |
| **ENS** | 124.2 | 124.2 | -18.3 | 0 | 8 | 109.3 |
| **LIT** | 115.8 | 116.7 | -13.1 | 0 | 4 | 100.8 |
| **CAT** | 103.3 | 103.3 | -13.9 | 0 | 10 | 88.3 |

## Trend-Hold candidates — RESILIENT_TREND (high-vol mega-runners)

| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % |
|---|---:|---:|---:|---:|---:|---:|
| **SNDK** | 1948.5 | 2018.5 | -31.3 | 0 | 10 | 1933.5 |
| **LITE** | 877.2 | 880.8 | -28.7 | 0 | 8 | 862.3 |
| **BE** | 839.3 | 889.7 | -45.9 | 0 | 12 | 824.3 |
| **SATS** | 369.7 | 369.7 | -19.9 | 0 | 16 | 354.7 |
| **SOXL** | 283.2 | 283.2 | -43.5 | 2 | 14 | 268.2 |
| **MU** | 276.4 | 285.2 | -30.3 | 0 | 16 | 261.5 |
| **ALB** | 214.4 | 242.8 | -20.1 | 0 | 16 | 199.4 |
| **INTC** | 199.8 | 199.8 | -24.2 | 0 | 18 | 184.8 |
| **RKLB** | 147.0 | 180.5 | -43.0 | 2 | 30 | 132.0 |
| **FN** | 138.6 | 138.6 | -20.6 | 0 | 12 | 123.7 |
| **AU** | 138.3 | 180.0 | -37.6 | 2 | 16 | 123.3 |
| **SLV** | 125.0 | 222.6 | -42.5 | 2 | 12 | 110.0 |
| **MTZ** | 120.5 | 120.5 | -14.1 | 0 | 14 | 105.5 |
| **AA** | 117.3 | 142.8 | -15.8 | 0 | 14 | 102.3 |
| **UTHR** | 102.3 | 103.8 | -10.6 | 0 | 20 | 87.3 |
| **KLAC** | 99.3 | 99.8 | -22.4 | 0 | 12 | 84.3 |
| **GEV** | 98.2 | 98.2 | -17.5 | 1 | 18 | 83.2 |
| **WFRD** | 96.3 | 105.0 | -20.3 | 0 | 14 | 81.3 |
| **GOOGL** | 94.3 | 95.5 | -20.4 | 2 | 22 | 79.3 |
| **NXT** | 93.7 | 126.7 | -23.3 | 0 | 12 | 78.7 |
| **GDX** | 92.8 | 122.6 | -30.8 | 2 | 16 | 77.8 |
| **ASTS** | 89.6 | 170.7 | -47.0 | 2 | 18 | 74.6 |
| **IESC** | 85.8 | 88.1 | -21.8 | 1 | 12 | 70.8 |
| **CCJ** | 68.3 | 87.1 | -25.7 | 2 | 12 | 53.4 |
| **BWXT** | 68.0 | 69.8 | -22.1 | 1 | 16 | 53.0 |
| **TSM** | 64.9 | 72.6 | -18.4 | 0 | 12 | 49.9 |
| **CRS** | 64.0 | 64.0 | -19.1 | 0 | 14 | 49.0 |
| **PWR** | 61.7 | 61.7 | -11.7 | 1 | 16 | 46.7 |
| **HII** | 60.3 | 84.2 | -18.7 | 0 | 12 | 45.3 |
| **ON** | 54.9 | 54.9 | -28.1 | 2 | 18 | 39.9 |
| **CW** | 54.3 | 55.8 | -13.0 | 0 | 12 | 39.4 |
| **RGLD** | 51.0 | 71.3 | -29.3 | 2 | 16 | 36.0 |
| **BK** | 49.0 | 49.0 | -10.2 | 2 | 12 | 34.1 |
| **BG** | 48.6 | 61.3 | -12.5 | 1 | 12 | 33.6 |
| **MRK** | 45.5 | 51.5 | -11.2 | 0 | 15 | 30.6 |
| **IAU** | 45.2 | 61.4 | -19.2 | 2 | 14 | 30.2 |
| **GLD** | 45.0 | 61.2 | -19.2 | 2 | 14 | 30.0 |
| **ITT** | 38.1 | 39.8 | -13.3 | 2 | 16 | 23.2 |
| **RTX** | 36.2 | 47.1 | -11.8 | 1 | 14 | 21.3 |
| **JCI** | 34.6 | 39.0 | -13.0 | 1 | 14 | 19.6 |
| **XOM** | 34.0 | 57.0 | -14.6 | 0 | 12 | 19.1 |
| **NOC** | 32.1 | 52.5 | -14.5 | 1 | 22 | 17.1 |

## WINNERS (n=88)

| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % | TH |
|---|---:|---:|---:|---:|---:|---:|:---:|
| SNDK | 1948.5 | 2018.5 | -31.3 | 0 | 10 | 1933.5 | R |
| LITE | 877.2 | 880.8 | -28.7 | 0 | 8 | 862.3 | R |
| BE | 839.3 | 889.7 | -45.9 | 0 | 12 | 824.3 | R |
| AEHR | 494.3 | 494.3 | -42.3 | 3 | 16 | 479.4 |  |
| WDC | 483.5 | 483.5 | -20.6 | 0 | 8 | 468.6 | C |
| SATS | 369.7 | 369.7 | -19.9 | 0 | 16 | 354.7 | R |
| SOXL | 283.2 | 283.2 | -43.5 | 2 | 14 | 268.2 | R |
| STX | 277.6 | 277.6 | -21.0 | 0 | 10 | 262.7 | C |
| MU | 276.4 | 285.2 | -30.3 | 0 | 16 | 261.5 | R |
| UUUU | 256.4 | 382.1 | -51.3 | 3 | 15 | 241.4 |  |
| HL | 227.3 | 432.8 | -46.0 | 4 | 12 | 212.3 |  |
| APLD | 223.1 | 323.7 | -50.3 | 8 | 18 | 208.1 |  |
| FIX | 216.4 | 216.4 | -13.8 | 0 | 10 | 201.4 | C |
| IREN | 216.0 | 401.7 | -58.6 | 10 | 16 | 201.0 |  |
| ALB | 214.4 | 242.8 | -20.1 | 0 | 16 | 199.4 | R |
| NBIS | 212.3 | 231.5 | -45.5 | 4 | 16 | 197.4 |  |
| INTC | 199.8 | 199.8 | -24.2 | 0 | 18 | 184.8 | R |
| AGQ | 192.5 | 748.5 | -76.2 | 5 | 12 | 177.6 |  |
| LRCX | 176.4 | 181.4 | -20.1 | 0 | 10 | 161.4 | C |
| CLS | 165.9 | 165.9 | -29.2 | 4 | 14 | 151.0 |  |
| GOLD | 155.8 | 23730.9 | -99.4 | 4 | 26 | 140.9 |  |
| RKLB | 147.0 | 180.5 | -43.0 | 2 | 30 | 132.0 | R |
| FN | 138.6 | 138.6 | -20.6 | 0 | 12 | 123.7 | R |
| AU | 138.3 | 180.0 | -37.6 | 2 | 16 | 123.3 | R |
| LSCC | 133.5 | 133.5 | -19.3 | 0 | 10 | 118.5 | C |
| SLV | 125.0 | 222.6 | -42.5 | 2 | 12 | 110.0 | R |
| ENS | 124.2 | 124.2 | -18.3 | 0 | 8 | 109.3 | C |
| MTZ | 120.5 | 120.5 | -14.1 | 0 | 14 | 105.5 | R |
| AA | 117.3 | 142.8 | -15.8 | 0 | 14 | 102.3 | R |
| LIT | 115.8 | 116.7 | -13.1 | 0 | 4 | 100.8 | C |
| STRL | 108.3 | 108.7 | -31.0 | 3 | 24 | 93.4 |  |
| B | 107.7 | 154.1 | -29.9 | 4 | 16 | 92.7 |  |
| AMD | 104.5 | 104.5 | -27.8 | 8 | 12 | 89.6 |  |
| CAT | 103.3 | 103.3 | -13.9 | 0 | 10 | 88.3 | C |
| UTHR | 102.3 | 103.8 | -10.6 | 0 | 20 | 87.3 | R |
| KLAC | 99.3 | 99.8 | -22.4 | 0 | 12 | 84.3 | R |
| GEV | 98.2 | 98.2 | -17.5 | 1 | 18 | 83.2 | R |
| WFRD | 96.3 | 105.0 | -20.3 | 0 | 14 | 81.3 | R |
| GOOGL | 94.3 | 95.5 | -20.4 | 2 | 22 | 79.3 | R |
| MP | 93.7 | 213.3 | -53.8 | 9 | 18 | 78.7 |  |
| NXT | 93.7 | 126.7 | -23.3 | 0 | 12 | 78.7 | R |
| GDX | 92.8 | 122.6 | -30.8 | 2 | 16 | 77.8 | R |
| ASTS | 89.6 | 170.7 | -47.0 | 2 | 18 | 74.6 | R |
| IESC | 85.8 | 88.1 | -21.8 | 1 | 12 | 70.8 | R |
| SANM | 76.8 | 85.3 | -32.7 | 5 | 14 | 61.8 |  |
| TNA | 73.8 | 73.8 | -32.6 | 5 | 14 | 58.9 |  |
| CCJ | 68.3 | 87.1 | -25.7 | 2 | 12 | 53.4 | R |
| BWXT | 68.0 | 69.8 | -22.1 | 1 | 16 | 53.0 | R |
| DELL | 66.9 | 66.9 | -32.6 | 11 | 14 | 51.9 |  |
| ANET | 66.0 | 66.0 | -28.3 | 5 | 18 | 51.1 |  |
| TSM | 64.9 | 72.6 | -18.4 | 0 | 12 | 49.9 | R |
| KTOS | 64.8 | 203.5 | -50.1 | 8 | 16 | 49.9 |  |
| CRS | 64.0 | 64.0 | -19.1 | 0 | 14 | 49.0 | R |
| DY | 63.5 | 75.9 | -24.4 | 4 | 14 | 48.5 |  |
| LMND | 62.5 | 121.2 | -47.7 | 9 | 18 | 47.5 |  |
| PWR | 61.7 | 61.7 | -11.7 | 1 | 16 | 46.7 | R |
| RIOT | 60.7 | 104.1 | -48.6 | 5 | 28 | 45.7 |  |
| HII | 60.3 | 84.2 | -18.7 | 0 | 12 | 45.3 | R |
| USO | 57.0 | 87.9 | -18.4 | 8 | 9 | 42.0 |  |
| ON | 54.9 | 54.9 | -28.1 | 2 | 18 | 39.9 | R |
| CW | 54.3 | 55.8 | -13.0 | 0 | 12 | 39.4 | R |
| AVGO | 53.6 | 56.0 | -28.9 | 11 | 20 | 38.6 |  |
| IBP | 52.9 | 76.8 | -25.2 | 4 | 26 | 37.9 |  |
| EXPE | 52.8 | 73.1 | -37.4 | 5 | 12 | 37.8 |  |
| EME | 51.8 | 53.4 | -25.1 | 5 | 18 | 36.9 |  |
| RGLD | 51.0 | 71.3 | -29.3 | 2 | 16 | 36.0 | R |
| BK | 49.0 | 49.0 | -10.2 | 2 | 12 | 34.1 | R |
| MLI | 48.8 | 69.6 | -22.6 | 5 | 16 | 33.8 |  |
| BG | 48.6 | 61.3 | -12.5 | 1 | 12 | 33.6 | R |
| MRK | 45.5 | 51.5 | -11.2 | 0 | 15 | 30.6 | R |
| IAU | 45.2 | 61.4 | -19.2 | 2 | 14 | 30.2 | R |
| GLD | 45.0 | 61.2 | -19.2 | 2 | 14 | 30.0 | R |
| APP | 41.7 | 117.9 | -50.0 | 14 | 18 | 26.8 |  |
| PH | 40.6 | 45.5 | -15.8 | 3 | 13 | 25.6 |  |
| ITT | 38.1 | 39.8 | -13.3 | 2 | 16 | 23.2 | R |
| IBB | 37.8 | 39.2 | -9.7 | 3 | 10 | 22.8 |  |
| RTX | 36.2 | 47.1 | -11.8 | 1 | 14 | 21.3 | R |
| SPHB | 36.0 | 36.0 | -10.9 | 4 | 8 | 21.1 |  |
| DINO | 35.7 | 51.4 | -18.3 | 5 | 12 | 20.8 |  |
| JCI | 34.6 | 39.0 | -13.0 | 1 | 14 | 19.6 | R |
| XOM | 34.0 | 57.0 | -14.6 | 0 | 12 | 19.1 | R |
| TSLA | 33.2 | 62.9 | -29.9 | 10 | 18 | 18.3 |  |
| NOC | 32.1 | 52.5 | -14.5 | 1 | 22 | 17.1 | R |
| NVDA | 31.6 | 35.1 | -20.2 | 6 | 12 | 16.6 |  |
| GS | 31.1 | 38.1 | -19.8 | 5 | 12 | 16.1 |  |
| HALO | 30.9 | 53.5 | -24.1 | 7 | 16 | 16.0 |  |
| TLN | 30.5 | 59.2 | -32.0 | 6 | 16 | 15.5 |  |
| AAPL | 30.0 | 37.7 | -13.8 | 5 | 17 | 15.1 |  |

## MODERATE (n=55)

| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % | TH |
|---|---:|---:|---:|---:|---:|---:|:---:|
| WMT | 29.8 | 36.3 | -11.1 | 0 | 14 | 14.8 |  |
| CSX | 29.4 | 29.4 | -12.2 | 1 | 20 | 14.5 |  |
| XLE | 28.8 | 46.4 | -12.1 | 2 | 14 | 13.8 |  |
| TJX | 28.4 | 31.8 | -6.8 | 0 | 16 | 13.4 |  |
| DTM | 27.9 | 35.7 | -8.0 | 0 | 12 | 12.9 |  |
| MDB | 27.8 | 113.8 | -48.7 | 9 | 14 | 12.9 |  |
| INFL | 27.0 | 30.8 | -8.4 | 1 | 6 | 12.0 |  |
| IWM | 26.5 | 26.5 | -11.2 | 4 | 13 | 11.5 |  |
| CVX | 26.4 | 45.0 | -12.9 | 6 | 14 | 11.4 |  |
| DCI | 26.2 | 56.5 | -25.3 | 8 | 32 | 11.3 |  |
| CSCO | 24.8 | 25.6 | -13.6 | 0 | 20 | 9.8 |  |
| BABA | 23.7 | 66.1 | -36.8 | 10 | 27 | 8.8 |  |
| GILD | 23.2 | 39.4 | -13.8 | 1 | 16 | 8.2 |  |
| VMI | 23.1 | 42.6 | -19.6 | 5 | 17 | 8.1 |  |
| XLK | 23.0 | 23.0 | -16.2 | 9 | 14 | 8.0 |  |
| AMGN | 22.3 | 33.6 | -12.4 | 0 | 12 | 7.3 |  |
| GE | 22.1 | 38.8 | -21.0 | 4 | 14 | 7.2 |  |
| SGI | 22.0 | 40.6 | -29.2 | 6 | 15 | 7.0 |  |
| PSTG | 21.3 | 78.7 | -42.3 | 10 | 18 | 6.3 |  |
| GLXY | 21.3 | 101.1 | -60.7 | 10 | 16 | 6.3 |  |
| MNST | 20.7 | 36.4 | -17.7 | 3 | 10 | 5.8 |  |
| WTS | 20.6 | 34.0 | -15.6 | 3 | 16 | 5.6 |  |
| SN | 20.5 | 32.4 | -30.2 | 5 | 34 | 5.5 |  |
| TWLO | 19.5 | 22.9 | -30.3 | 5 | 16 | 4.5 |  |
| LLY | 19.5 | 43.0 | -23.0 | 7 | 16 | 4.5 |  |
| H | 18.6 | 18.6 | -18.9 | 5 | 14 | 3.7 |  |
| RPG | 18.6 | 18.6 | -11.1 | 4 | 7 | 3.7 |  |
| TPL | 18.6 | 51.5 | -30.0 | 7 | 20 | 3.7 |  |
| QQQ | 18.6 | 18.6 | -12.2 | 6 | 14 | 3.6 |  |
| QXO | 18.0 | 27.8 | -32.7 | 5 | 16 | 3.1 |  |
| ARRY | 17.9 | 80.1 | -44.3 | 8 | 20 | 3.0 |  |
| GRNY | 17.3 | 17.3 | -11.6 | 5 | 18 | 2.3 |  |
| XLI | 17.2 | 20.9 | -12.5 | 2 | 15 | 2.3 |  |
| ULTA | 16.9 | 49.3 | -27.8 | 6 | 18 | 1.9 |  |
| FSLR | 16.9 | 74.6 | -35.1 | 8 | 14 | 1.9 |  |
| PNC | 16.8 | 25.9 | -17.2 | 5 | 22 | 1.8 |  |
| SPX | 16.6 | 16.6 | -9.1 | 5 | 8 | 1.7 |  |
| SHOP | 16.4 | 58.9 | -38.2 | 12 | 18 | 1.4 |  |
| DE | 16.1 | 30.3 | -16.3 | 3 | 15 | 1.2 |  |
| US500 | 15.9 | 15.9 | -9.3 | 5 | 9 | 1.0 |  |
| XLB | 15.2 | 19.1 | -12.4 | 1 | 18 | 0.2 |  |
| SPY | 15.0 | 15.0 | -9.1 | 5 | 12 | 0.0 |  |
| IONQ | 14.9 | 104.7 | -67.6 | 21 | 14 | -0.0 |  |
| CVNA | 14.6 | 41.4 | -41.2 | 9 | 14 | -0.4 |  |
| ETN | 14.4 | 14.4 | -19.6 | 10 | 14 | -0.6 |  |
| AMZN | 13.7 | 15.2 | -21.7 | 9 | 18 | -1.3 |  |
| ALLY | 12.8 | 17.0 | -23.6 | 11 | 22 | -2.2 |  |
| XLU | 12.7 | 16.5 | -9.9 | 6 | 20 | -2.3 |  |
| EWBC | 12.6 | 16.9 | -15.7 | 6 | 16 | -2.4 |  |
| PLTR | 12.0 | 58.5 | -38.2 | 14 | 16 | -3.0 |  |
| DIA | 11.1 | 12.8 | -10.1 | 5 | 18 | -3.9 |  |
| MTB | 10.8 | 20.5 | -17.6 | 4 | 22 | -4.2 |  |
| XLC | 10.5 | 11.5 | -10.9 | 5 | 18 | -4.5 |  |
| XLY | 10.3 | 14.1 | -15.2 | 10 | 14 | -4.6 |  |
| SOFI | 10.2 | 82.6 | -53.0 | 14 | 22 | -4.8 |  |

## STAGNANT (n=45)

| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % | TH |
|---|---:|---:|---:|---:|---:|---:|:---:|
| TT | 9.7 | 9.7 | -20.3 | 10 | 26 | -5.3 |  |
| XLV | 8.8 | 17.2 | -10.6 | 7 | 16 | -6.1 |  |
| AWI | 8.4 | 23.0 | -21.6 | 8 | 25 | -6.6 |  |
| EMR | 8.0 | 19.3 | -23.7 | 5 | 18 | -7.0 |  |
| U | 8.0 | 106.0 | -65.4 | 12 | 24 | -7.0 |  |
| RDDT | 7.6 | 77.8 | -55.0 | 12 | 14 | -7.4 |  |
| JPM | 6.8 | 15.2 | -15.5 | 6 | 12 | -8.1 |  |
| XLRE | 6.7 | 6.7 | -8.9 | 6 | 16 | -8.3 |  |
| ARM | 6.7 | 14.3 | -41.5 | 17 | 30 | -8.3 |  |
| UNP | 6.6 | 13.3 | -12.3 | 2 | 14 | -8.4 |  |
| BA | 6.5 | 20.2 | -25.0 | 5 | 16 | -8.5 |  |
| KO | 5.7 | 13.8 | -8.4 | 2 | 14 | -9.3 |  |
| PKG | 5.3 | 21.5 | -17.7 | 6 | 14 | -9.7 |  |
| MCD | 4.7 | 14.7 | -11.1 | 5 | 20 | -10.3 |  |
| XHB | 4.5 | 18.2 | -21.3 | 6 | 27 | -10.5 |  |
| XYZ | 4.4 | 18.8 | -39.5 | 7 | 24 | -10.6 |  |
| OKE | 3.1 | 16.0 | -22.9 | 2 | 20 | -11.9 |  |
| EXEL | 2.9 | 6.8 | -25.2 | 4 | 14 | -12.1 |  |
| AXP | 2.8 | 19.3 | -24.1 | 9 | 14 | -12.1 |  |
| APD | 2.2 | 4.8 | -22.9 | 7 | 16 | -12.8 |  |
| UPS | 1.9 | 14.9 | -21.8 | 6 | 15 | -13.1 |  |
| COST | 1.4 | 4.7 | -14.5 | 7 | 24 | -13.6 |  |
| SWK | 1.3 | 30.6 | -26.9 | 7 | 16 | -13.7 |  |
| ETHA | 1.0 | 101.2 | -61.7 | 22 | 14 | -13.9 |  |
| XLP | 0.6 | 9.8 | -9.9 | 5 | 20 | -14.4 |  |
| CDNS | 0.5 | 20.6 | -28.9 | 13 | 18 | -14.5 |  |
| PI | 0.2 | 116.0 | -62.2 | 14 | 28 | -14.7 |  |
| PCI | -0.0 | 2.9 | -3.5 | 6 | 11 | -15.0 |  |
| XLF | -0.4 | 7.1 | -15.2 | 9 | 12 | -15.4 |  |
| UNH | -0.5 | 13.4 | -30.0 | 10 | 18 | -15.4 |  |
| PPG | -1.3 | 13.0 | -26.1 | 7 | 24 | -16.3 |  |
| HOOD | -1.7 | 65.1 | -57.3 | 16 | 18 | -16.7 |  |
| WAL | -2.0 | 18.6 | -30.6 | 8 | 18 | -17.0 |  |
| WM | -2.1 | 7.7 | -17.0 | 3 | 14 | -17.1 |  |
| VRTX | -2.4 | 10.4 | -23.6 | 5 | 18 | -17.4 |  |
| AR | -2.6 | 19.9 | -20.7 | 2 | 26 | -17.6 |  |
| J | -2.8 | 24.0 | -25.3 | 11 | 12 | -17.8 |  |
| BRK-B | -3.1 | 4.9 | -8.8 | 6 | 18 | -18.0 |  |
| JD | -3.4 | 10.6 | -29.8 | 20 | 32 | -18.3 |  |
| UHS | -3.5 | 29.2 | -27.6 | 8 | 20 | -18.4 |  |
| FLR | -3.5 | 12.8 | -30.2 | 7 | 16 | -18.4 |  |
| META | -4.3 | 9.8 | -33.5 | 10 | 24 | -19.2 |  |
| AYI | -4.5 | 22.9 | -31.6 | 15 | 12 | -19.5 |  |
| JOBY | -6.0 | 107.8 | -61.1 | 13 | 22 | -21.0 |  |
| TEM | -6.0 | 73.7 | -59.0 | 19 | 22 | -21.0 |  |

## LOSERS (n=41)

| ticker | return % | peak % | max DD % | wk EMA-21 streak | dly 5/12 streak | vs SPY % | TH |
|---|---:|---:|---:|---:|---:|---:|:---:|
| NEU | -10.1 | 23.7 | -33.0 | 22 | 20 | -25.1 |  |
| KWEB | -11.3 | 25.0 | -35.3 | 22 | 18 | -26.3 |  |
| VST | -11.7 | 17.7 | -34.6 | 14 | 16 | -26.7 |  |
| ISRG | -12.8 | 10.2 | -24.0 | 14 | 18 | -27.8 |  |
| CRWD | -13.8 | 13.3 | -37.2 | 18 | 16 | -28.8 |  |
| MSFT | -14.1 | 10.2 | -34.2 | 21 | 16 | -29.1 |  |
| PANW | -15.1 | 12.1 | -36.0 | 22 | 18 | -30.0 |  |
| SPGI | -16.4 | 6.6 | -30.7 | 11 | 28 | -31.4 |  |
| PEGA | -16.9 | 26.9 | -43.1 | 14 | 18 | -31.9 |  |
| CARR | -17.5 | 8.7 | -37.6 | 10 | 20 | -32.4 |  |
| ETHUSD | -17.5 | 100.8 | -62.2 | 16 | 15 | -32.5 |  |
| PATH | -18.0 | 52.0 | -51.4 | 14 | 28 | -32.9 |  |
| DPZ | -18.7 | 6.1 | -28.3 | 17 | 20 | -33.6 |  |
| IGV | -20.0 | 8.8 | -36.6 | 24 | 10 | -35.0 |  |
| ORCL | -20.1 | 50.0 | -58.4 | 21 | 32 | -35.0 |  |
| IOT | -21.8 | 15.5 | -46.4 | 11 | 18 | -36.8 |  |
| CELH | -23.4 | 41.0 | -48.1 | 7 | 16 | -38.3 |  |
| AVAV | -24.2 | 62.4 | -56.8 | 12 | 34 | -39.1 |  |
| NFLX | -24.8 | 0.3 | -41.5 | 14 | 18 | -39.8 |  |
| CRWV | -25.1 | 5.9 | -60.9 | 11 | 30 | -40.0 |  |
| SPOT | -25.7 | 2.2 | -44.1 | 15 | 18 | -40.7 |  |
| ABT | -28.9 | 0.3 | -30.1 | 22 | 20 | -43.9 |  |
| LRN | -30.5 | 20.0 | -64.1 | 19 | 16 | -45.4 |  |
| LULU | -32.1 | 1.0 | -41.1 | 14 | 26 | -47.1 |  |
| CRM | -33.0 | 0.6 | -39.7 | 14 | 20 | -48.0 |  |
| ACN | -34.7 | 0.7 | -41.1 | 12 | 28 | -49.7 |  |
| BTCUSD | -35.3 | 18.0 | -49.6 | 16 | 15 | -50.3 |  |
| NKE | -37.3 | 7.9 | -46.2 | 22 | 22 | -52.3 |  |
| COIN | -38.5 | 25.2 | -66.4 | 22 | 30 | -53.4 |  |
| HIMS | -39.9 | 38.0 | -78.1 | 21 | 36 | -54.9 |  |
| RBLX | -40.0 | 40.6 | -63.3 | 22 | 22 | -55.0 |  |
| VIXY | -40.3 | 0.1 | -46.7 | 15 | 16 | -55.3 |  |
| AGYS | -40.8 | 22.5 | -55.9 | 16 | 20 | -55.7 |  |
| QLYS | -42.4 | 6.5 | -50.5 | 17 | 30 | -57.4 |  |
| DKNG | -45.6 | 14.9 | -57.0 | 22 | 28 | -60.6 |  |
| ELF | -47.3 | 15.8 | -59.5 | 13 | 36 | -62.2 |  |
| AXON | -48.0 | 12.3 | -60.3 | 15 | 32 | -63.0 |  |
| INTU | -49.6 | 3.6 | -56.5 | 22 | 18 | -64.5 |  |
| BMNR | -50.1 | 193.5 | -87.1 | 22 | 14 | -65.1 |  |
| MSTR | -55.4 | 22.1 | -76.5 | 21 | 22 | -70.4 |  |
| HUBS | -60.1 | 0.5 | -65.7 | 22 | 24 | -75.1 |  |

## Cohort statistics (medians)

| cohort | n | return % | max DD % | wk EMA-21 streak | dly 5/12 streak |
|---|---:|---:|---:|---:|---:|
| WINNERS | 88 | 85.8 | -22.6 | 2 | 14 |
| MODERATE | 55 | 18.6 | -17.2 | 5 | 16 |
| STAGNANT | 45 | 1.3 | -24.1 | 7 | 18 |
| LOSERS | 41 | -25.7 | -46.7 | 16 | 20 |
| **CLEAN_TREND** | 8 | 176.4 | -18.3 | 0 | 10 |
| **RESILIENT_TREND** | 42 | 92.8 | -20.1 | 1 | 14 |

## Methodology footnote

- *Return %* = (last_close − first_close) / first_close × 100, computed on the dedupe'd daily-close series clipped to the analysis window.
- *Max DD %* = deepest peak-to-trough close-to-close drawdown experienced inside the window (negative number).
- *Weekly EMA-21 break streak* = longest run of consecutive **weekly closes** below the 21-week EMA, after a 20-week EMA warmup. ISO-week aggregation; weekly close = last daily close in week.
- *Daily 5/12 cloud break streak* = longest run of consecutive **daily closes** below `min(EMA-5, EMA-12)`, after a 12-bar warmup.
- *Trend integrity is measured on closes only* — wicks below an EMA mid-bar do NOT count toward a break.
- *vs SPY %* = ticker return − SPY return over identical window. (SPY may end on a different last-bar than ticker; difference is small.)
- This file is regenerated by `node scripts/cohort-segmentation.js`.
