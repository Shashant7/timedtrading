# Phase-F v6b — 10-month continuous backtest headline

**Run ID**: `phase-f-continuous-v6b`
**Window**: 2025-07-01 → 2026-04-30 (210 trading days)
**Universe**: 24-ticker tier1-tier2 (SPY/QQQ/IWM + Mag 7 + 14 tier-2)
**Active rules**: Phase-E.2 (management fixes F1-F4) + Phase-E.3 (cohort overlay) + Phase-F (SHORT activation F8-F12)

## Overall totals

| Metric | Value |
|---|---:|
| Trades | 213 |
| Wins / Losses | 120 / 85 |
| WR | 58.5% |
| Big winners (≥5%) | 10 |
| Clear losers (≤-1.5%) | 48 |
| Sum pnl_pct | **+92.82%** |
| SHORT trades | **120** |
| SPY/QQQ/IWM | 38 |

## By month

| Month | Scope | n | WR | Big W | Clear L | Sum PnL | ETF | SHORT |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 2025-07 | training | 32 | 64.5% | 1 | 8 | +11.66% | 7 | 3 |
| 2025-08 | training | 16 | 53.8% | 0 | 4 | +3.89% | 4 | 3 |
| 2025-09 | training | 16 | 43.8% | 1 | 3 | +1.80% | 5 | 4 |
| 2025-10 | training | 20 | 50.0% | 0 | 5 | +0.03% | 6 | 8 |
| 2025-11 | training | 23 | 60.9% | 2 | 3 | +20.70% | 2 | 19 |
| 2025-12 | training | 18 | 38.9% | 0 | 6 | -4.93% | 3 | 8 |
| 2026-01 | training | 16 | 62.5% | 1 | 2 | +22.37% | 3 | 6 |
| 2026-02 | training | 11 | 45.5% | 0 | 3 | -2.99% | 2 | 8 |
| 2026-03 | holdout | 45 | 80.0% | 4 | 7 | +58.07% | 6 | 45 |
| 2026-04 | holdout | 16 | 33.3% | 1 | 7 | -17.78% | 0 | 16 |

**Training total (Jul 2025 - Feb 2026)**: +52.52%

## Direction × cohort

| Cohort | Direction | n | WR | Sum PnL |
|---|---|---:|---:|---:|
| Index_ETF | LONG | 30 | 58.6% | +5.34% |
| Index_ETF | SHORT | 8 | 75.0% | +7.65% |
| MegaCap | LONG | 26 | 61.5% | +16.24% |
| MegaCap | SHORT | 47 | 54.3% | +10.87% |
| Industrial | LONG | 16 | 50.0% | +3.44% |
| Industrial | SHORT | 14 | 61.5% | +2.53% |
| Speculative | LONG | 12 | 54.5% | +14.44% |
| Speculative | SHORT | 17 | 68.8% | +15.99% |
| Other | LONG | 9 | 14.3% | -9.38% |
| Other | SHORT | 34 | 66.7% | +25.72% |

## Observations

**Wins:**
- Phase-F SHORT activation worked: 120 SHORTs (0 in v5)
- Mar 2026 holdout +58% / 80% WR with 45 SHORTs
- Nov 2025 +20.7% / 60.9% WR with 19 SHORTs

**Regressions:**
- Training months total +52.5% (was +226.91% in v5)
- Clear losers 2× v5 (25 → 48)
- Apr 2026 holdout -17.78%: shorts run over by regime flip

**Diagnosis target for forensics:**
- Which SHORT gates are firing on marginal setups during transition periods?
- MFE-vs-exit gap on losing SHORTs — would tighter ATR ladder TP cap losses?
- Which MTF indicator first called the reversal on Apr losers?
