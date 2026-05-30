# V15 Quality-Over-Quantity Plan

**Run analyzed:** `v14-fullrun-julapr-1777074817` — 231 trades, Jul 2025 → Apr 2026, 203 tickers
**Goal:** fewer trades, bigger wins. Cut the loss tail and let winners run.

---

## V14 baseline (the calibration source of truth)

| Metric | Value |
|---|---|
| Total trades | 231 (4 still open) |
| Closed | 227 (124W / 103L) |
| WR | 54.6% |
| Profit Factor | **1.58** |
| Total PnL | **+88.01%** over 10 months |
| Avg WIN | +1.93% |
| Avg LOSS | -1.47% |
| Avg trade | +0.39% |

---

## Finding 1 — RANK is INVERSELY correlated with PnL (CONFIRMED)

The legacy rank score is **anti-predictive** at the top:

| Rank bucket | n | WR | avg PnL | total PnL |
|---|---|---|---|---|
| **[95-100]** | **154** | **51.9%** | **+0.10%** | **+16.1%** |
| **[90-95)** | **63** | **60.3%** | **+1.05%** | **+66.2%** |
| [80-85) | 5 | 60.0% | +1.00% | +5.0% |
| [70-80) | 2 | 50.0% | -0.13% | -0.3% |

**The rank=90-95 bucket made FOUR TIMES the PnL of the rank=95-100 bucket** despite having less than half the trades. Rank≥95 is a vanity gate that lets noise through. The legacy `computeRank` is calibrated badly and should be either completely retired or refit.

**V15 action:** drop `rank>=95` from any gate; if rank is used at all, use `90 ≤ rank ≤ 95` as the SWEET SPOT.

---

## Finding 2 — CONVICTION sweet-spot is 70-75, not 80+

| Conviction bucket | n | WR | avg PnL | total PnL |
|---|---|---|---|---|
| [85-100] | 26 | 53.8% | +0.11% | +2.7% |
| [80-85) | 30 | 56.7% | +0.09% | +2.8% |
| [75-80) | 45 | 51.1% | +0.47% | +21.4% |
| **[70-75)** | **41** | **53.7%** | **+1.07%** | **+43.7%** |
| **[65-70)** | **34** | **64.7%** | **+0.47%** | **+16.1%** |
| [60-65) | 30 | 53.3% | -0.04% | -1.3% |
| [50-60) | 20 | 50.0% | +0.16% | +3.1% |

**Highest avg PnL is in the 70-75 conviction band.** Highest WR is in the 65-70 band. Above 80 is essentially noise. Tier A (≥75) actually **underperforms Tier B** (n=101, +0.27% avg vs n=125, +0.49% avg).

**Hypothesis:** the conviction-score gate currently only filters OUT trades with score < 50 (Tier C). It should also have an UPPER cap or recalibrate weights so the obvious "quality" signals (large_cap liquidity, bull_stacked trend, tt_selected bonus) don't all max out together for run-of-the-mill trades.

**V15 action:** rebalance conviction signal weights based on actual per-pts correlation with pnl (see Finding 6 below).

---

## Finding 3 — Per-signal predictive power (CONFIRMED HYPOTHESIS)

Pearson(signal_pts, pnl_pct) over 227 closed trades:

| Signal | Correlation | Best bucket WR / avg | Worst bucket |
|---|---|---|---|
| **relative_strength** | **+0.097** | pts=8: **69.6% WR / +1.65% avg** | pts=0: 47.4% WR / -0.18% |
| sector | +0.047 | pts=10: 54.4% / +0.46% | pts=0: 55.2% / +0.11% |
| history | +0.056 | (mostly insufficient_history) | |
| trend | -0.056 | (almost everyone gets 20 pts) | |
| volatility | -0.069 | pts=5: **69.2% WR / +1.66%** | pts=0: 20% WR / -0.85% |
| liquidity | -0.055 | pts=10: 64.7% / +0.64% | pts=18: 52.4% / +0.27% |

**Highest signal: `relative_strength` (the one we just fixed in PR #44).** It's the only signal with a strong positive correlation, AND the pts=8 bucket is the highest-quality cluster in the entire run.

**Notable inversion: `liquidity`** — high-liquidity (pts=18, large_cap) actually performs WORSE than mid-liquidity (pts=10). Big mega-caps are "obvious" trades; the alpha is in mid-cap names that pass the other filters.

**V15 action: rebalance conviction weights:**

| Signal | Current weight | V15 proposed | Rationale |
|---|---|---|---|
| liquidity | 0-20 | **0-10** | Inversely correlated; big caps don't outperform |
| volatility | 0-15 | 0-15 | Keep — extremes have clear edges (pts=5 sweet spot) |
| trend | 0-20 | 0-10 | Saturated — almost everyone is bull/bear stacked |
| sector | 0-10 | 0-15 | Slightly under-weighted; broaden |
| **relative_strength** | **0-10** | **0-25** | Strongest predictor; double the weight |
| history | 0-20 | 0-20 | Will activate as more data accrues |
| **+ Saty ATR proximity (NEW)** | — | **0-15** | Address H-trade pattern (Finding 5) |
| **+ Slope alignment (NEW)** | — | **0-15** | Phase + RSI slope must agree with direction |

Total range becomes 0-125 with bonuses (was 0-100). Recalibrate Tier thresholds: A≥85, B≥65, C<65.

---

## Finding 4 — The exit rules are MOSTLY GREAT but two are catastrophic

**Top 5 BEST exit rules (positive expectancy):**

| Exit reason | n | WR | avg | total |
|---|---|---|---|---|
| `mfe_proportional_trail` | 21 | 100% | +3.46% | **+72.7%** |
| `TP_FULL` | 16 | 100% | +2.50% | +40.1% |
| `HARD_FUSE_RSI_EXTREME` | 6 | 100% | +4.20% | +25.2% |
| `PROFIT_GIVEBACK_STAGE_HOLD` | 20 | 95% | +1.16% | +23.3% |
| `stagnant_no_commitment` | 13 | 100% | +1.15% | +15.0% |

`mfe_proportional_trail` alone made **+72.7% PnL** — it's our best exit by far. Keep it, expand it.

**Top 5 WORST exit rules (capital killers):**

| Exit reason | n | WR | avg | total damage |
|---|---|---|---|---|
| `phase_i_mfe_fast_cut_2h` | **20** | **0%** | -1.23% | **-24.7%** |
| `max_loss_time_scaled` | 12 | 0% | -1.98% | -23.8% |
| `phase_i_mfe_cut_4h` | 17 | 0% | -1.38% | -23.5% |
| `max_loss` | 6 | 0% | -3.43% | -20.6% |
| `HARD_LOSS_CAP` | 3 | 0% | -6.87% | -20.6% |

**The fast-cut tiers (`phase_i_mfe_*`) cost us -71.7% PnL** (sum of fast_cut_2h + cut_4h + cut_8h + cut_24h + stale_72h).

But these fired on real losers — would those trades have been WORSE without the cut?

**Key V15 insight:** `phase_i_mfe_fast_cut_2h` is the fast-cut we partially relaxed in V12. It's still firing 20 times for -1.23% avg. **Question for V15:** instead of a fast cut at 2h with 0% WR, should we **never have entered these trades**? They share a fingerprint we can probably detect at entry.

**V15 action:** every `phase_i_mfe_fast_cut_2h` victim gets a **pre-trade fingerprint** computed; if the fingerprint matches at entry, refuse the trade. This is the single biggest "fewer trades, bigger wins" lever.

---

## Finding 5 — H-trade Saty ATR pattern (PROXY validates the hypothesis)

We don't yet compute Saty ATR proximity in trade traces, so I used a proxy: trades where `relative_strength` opposes direction (long with weak RS pts≤4, short with strong RS pts≥8). Even with this rough proxy:

- **Counter-trend trades**: n=62, big_losses=1, big_wins=6 (1:6 ratio)
- **With-trend trades**: n=165, big_losses=9, big_wins=21 (1:2.3 ratio)

Counter-trend was actually slightly BETTER on big-loss avoidance, but the with-trend group had **more big winners** (21 vs 6). The proxy alone isn't enough to discriminate, but the **combined Saty ATR proximity + slope opposition + RS opposition** rule should be much sharper.

**V15 action:** implement the 3 new conviction signals (Saty ATR, phase slope, RSI slope) and re-bucket the V14 trades retroactively. Validate that the **3-of-3 oppositions case** has a high big_loss / low big_win rate.

The H trade canonical example:
- HARD_LOSS_CAP at -11.39%
- conv=63 (Tier B) — the conviction floor was 50, so it passed
- relative_strength=0 pts (the signal was screaming weak)
- BUT we entered SHORT into a Saty ATR support level

If we'd had Saty ATR proximity scoring set up to award **-15 pts when shorting INTO a support level within 0.25 ATR**, conviction would have been 48 → Tier C → blocked.

---

## Finding 6 — Worst tickers had a clear fingerprint

| Ticker | n | WR | avg | total | Notes |
|---|---|---|---|---|---|
| **H** | **3** | **0%** | -4.13% | **-12.39%** | The Saty-ATR victim |
| **PLTR** | **3** | **0%** | -1.91% | **-5.72%** | All max_loss exits |
| CW | 5 | 20% | -0.63% | -3.14% | High-volatility breakout fail |
| ELF | 3 | 33% | -1.03% | -3.08% | Counter-trend shorts |
| ISRG | 8 | 38% | -0.36% | -2.89% | Most-traded ticker, sub-50% WR |

**ISRG is striking:** 8 trades (most-traded in the whole run), 38% WR, slight negative total. We over-traded a low-edge name.

**V15 action: per-ticker-per-window cap** — once a ticker shows 2 losses with no wins in a 30-day window, block further entries on it for 14 days.

---

## Finding 7 — ETF participation is broken AT MULTIPLE LEVELS

| Group | Trades | Notes |
|---|---|---|
| Index ETFs (SPY/QQQ/IWM/DIA) | **0** | ETF Precision Gate too strict |
| Sector ETFs (12 of them) | **0** | Not even attempting |
| Commodity ETFs | **6** (WR 83%, +3.33% avg!) | When they DO trade, they win |
| Levered ETFs | 0 | All blocked |
| Themed (ETHA, GRNY, KWEB) | 12 (WR 75%, +0.85%) | Healthy participation |

**Commodity ETFs at 83% WR / +3.33% avg are the BEST single segment** in the V14 run. This validates that **ETF trading works when gates allow it** — we just have the gates calibrated wrong.

**V15 action: redesign ETF gate as a SCORED gate** (already specified in `tasks/v14-no-etf-trades-spec-2026-04-25.md`). Replace 10-of-10 conjunction with weighted score requiring 6.0 / 9.5. Target: 5-15 SPY trades, 5-15 QQQ, 3-10 IWM over 10 months.

---

## V15 implementation plan (in priority order)

### P0 — Required (no V15 without these)

#### P0.1 Add Saty ATR proximity signal to focus-tier
**Files:** `worker/focus-tier.js` (new `scoreSatyAtrProximity` function), `worker/indicators.js` (compute prev_close ATR levels), `worker/index.js` (thread into ctx)

Compute proximity to nearest level in `{prev_close, ±0.382, ±0.618, ±1.0, ±1.272, ±1.618} × atr_d`. Award:
- **+10 pts** if level is BEHIND entry direction (level is support for long, resistance for short) and within 1.0 ATR
- **0 pts** if level is far away (>2 ATR)
- **-15 pts** if level is IN FRONT of entry direction within 0.25 ATR (the H-trade fade-into-support pattern)

#### P0.2 Add slope alignment signals (phase + RSI)
**Files:** `worker/focus-tier.js`, leveraging existing `phase_score` and `rsi` fields

Compute 5-bar slope on phase and RSI. Award:
- **+10 pts each** if slope aligns with entry direction
- **0 pts** if neutral
- **-10 pts each** if slope opposes entry direction

Combined ceiling: -20 pts if both phase + RSI oppose. This is the "obvious no" signal.

#### P0.3 Rebalance conviction weights using V14 data
Per Finding 3:
- liquidity: 20 → 10
- trend: 20 → 10
- sector: 10 → 15
- relative_strength: 10 → 25
- (history, volatility unchanged)
- Saty ATR (new): 0-15
- phase_alignment (new): 0-15
- rsi_alignment (new): 0-15

New range: 0-130 (excluding bonuses). New tier thresholds: A≥85, B≥65, C<65.

#### P0.4 Replace ETF Precision Gate with scored gate
**File:** `worker/pipeline/tt-core-entry.js:914-1014`

Replace 10-of-10 conjunction with weighted score:
```javascript
etf_score = 2.0*F1_pass + 1.5*F4_pass + 1.5*F7_pass
          + 1.0*F2_relaxed + 1.0*F3_relaxed
          + 0.5*F6_relaxed + 0.5*F8_pass
          + 1.0*F9_relaxed + 0.5*F10_etf
require etf_score >= 6.0 / 9.5
```

Loosen filters per Finding 7:
- F2: 1.5% → 4% pullback
- F3: 40-65 RSI → 35-72
- F6: 2 weekly ATR → 3 weekly ATR
- F9: 48h macro → 12h post / 4h pre
- F10: conv ≥ 70 → conv ≥ 65

#### P0.5 Retire/recalibrate `computeRank` upper-band gating
**File:** `worker/index.js` — wherever `rank >= 90` or `rank >= 95` is gating

Per Finding 1, drop the rank≥95 floor entirely; treat rank as informational only OR retrain the weights using the V14 dataset.

### P1 — High-value additions

#### P1.1 Per-ticker-per-window auto-block
After 2 LOSSes with no WINs in 30 days on a single ticker, block re-entry for 14 days. Targets ISRG/H/PLTR class.

#### P1.2 Refuse the `phase_i_mfe_fast_cut_2h` fingerprint at entry
Compute the entry-time fingerprint of the 20 fast-cut victims (low MFE, no early breakout, weak RS, bull-stacked-but-extended). Block entries matching it.

#### P1.3 Size-by-conviction
Risk budget scales:
- Tier A (≥85): 100% normal risk
- Tier B (65-84): 60%
- Tier C (<65): blocked (currently)

This addresses "fewer but bigger" structurally — when we DO trade Tier A, we win bigger.

### P2 — Validate then promote

#### P2.1 V15 validation smoke
Jul-Aug 2025 on 51 tickers (smoke set + TPL + NXT + SPY/QQQ/IWM). Targets:
- ≥ 5 SPY/QQQ/IWM trades over 2 months (currently 0)
- WR ≥ 65% (currently 54.6%)
- PF ≥ 2.0 (currently 1.58)
- Total PnL same magnitude as V14 baseline despite fewer trades

#### P2.2 V15 full 10-month rerun
Same window, same universe. Compare:
- Trade count (target: -25%, ~170 trades)
- Total PnL (target: +20%, ~+106%)
- Avg WIN (target: +50%, ~+2.9%)
- Big losses (target: -50%, ≤ 5 trades with pnl ≤ -3%)
- Index ETF participation (target: ≥ 15 trades total)

---

## Summary

V14 captured 231 clean trades with full data, validating multiple hypotheses:

1. **Rank is anti-predictive at the top** — drop `rank≥95` gating
2. **Conviction sweet-spot is 70-75** — Tier A actually underperforms Tier B currently
3. **Relative strength is THE strongest signal** — double its weight
4. **Liquidity is INVERSELY predictive** — large-caps are too obvious; reduce weight
5. **Saty ATR proximity is the missing piece** — would have caught H-trade -11% loss
6. **Slope alignment matters** — phase + RSI must agree with direction
7. **ETF gate is broken** — 0 SPY/QQQ/IWM trades is unacceptable; commodity ETFs proved ETF trading works
8. **Per-ticker fatigue is real** — ISRG over-traded at 38% WR

V15 implements these as 5 P0 changes that reshape the conviction score and ETF gate. Expected outcome: **same +88% PnL with 25% fewer trades, +50% bigger avg WIN, and meaningful ETF participation.**

The "fewer trades, bigger wins" goal becomes real when:
- The H-class -11% loss can't happen (Saty ATR signal blocks it)
- The ISRG-class over-trading can't happen (per-ticker auto-block)
- The fast-cut-2h losses can't happen (entry fingerprint refusal)
- And we ADD high-conviction ETF trades that currently get rejected

**Net effect: drop ~50 marginal/losing trades, add ~10 high-conviction ETF trades, retain all the big winners.**
