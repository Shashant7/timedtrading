# Rank Signal Calibration — Empirical Findings

**Date:** 2026-04-22  
**Dataset:** v10b 101 closed trades (215-ticker universe)  
**Base rate:** WR 50.5%, avg PnL +0.20%  
**Cross-check runs:** v9 (48 trades), v7 (229 trades), v6b (205 trades)

---

## 1. The headline problem

**The current rank formula has essentially zero correlation with trade outcomes.**

| Run | Pearson(rank, pnl_pct) |
|---|---|
| v9 (40T, Phase-H.3) | **-0.185** (slightly inverse!) |
| v7 (40T, Phase-G) | +0.099 |
| v6b (40T, Phase-F) | -0.105 |

Looking at v7's bucket distribution — 229 trades:
- rank **95-100**: 56.6% WR, +0.46% avg
- rank **90-94**: **61.5% WR**, +1.01% avg ← beats top bucket
- rank **80-84**: 31.2% WR, -0.78% avg
- rank **70-79**: **60.7% WR**, +0.58% avg ← on par with top!
- rank **<70**: 50.9% WR, -0.03% avg

**The "elite rank" signal is noise.** Raising the rank floor doesn't improve quality — it just reduces sample size.

---

## 2. Empirical signal lift (from v10b snapshots, base WR 50.5%)

### 2.1 Signals that WORK (positive lift)

| Signal | n_on | WR_on | PnL_on | WR lift | Current weight | Recommendation |
|---|---|---|---|---|---|---|
| **rvol_30m < 1.2x** | 5 | **80.0%** | +0.80% | **+29.5** | 0 | ADD (but small sample) |
| **rvol_30m 2.0x+ is BAD** | 42 | 45.2% | +0.24% | -5.3 | 0 | Negative weight? |
| RSI bull divergence | 20 | 60.0% | +0.55% | +9.5 | +3 to +5 | **Increase to +10** |
| setup_grade=Confirmed | 23 | **60.9%** | +0.26% | +10.4 | 0 (downstream) | **Boost grade=Confirmed path** |
| regime_class=TRENDING | 65 | 56.9% | +0.38% | +6.4 | 0 | Add +6 |
| supertrend_30 aligned | 85 | 54.1% | +0.48% | +3.6 | (indirect via state) | Keep |
| 4H bias aligned | 89 | 52.8% | +0.22% | +2.3 | (implicit HTF) | Minimal signal |

### 2.2 Signals that are NEUTRAL (no lift)

| Signal | n_on | WR_on | WR lift | Current weight | Recommendation |
|---|---|---|---|---|---|
| HTF_D bias aligned | 101 | 50.5% | 0.0 | +4 to +10 | **Remove** — everyone has it |
| Ripster clouds D/4H/1H | 101 | 50.5% | 0.0 | embedded in state | **Remove** — non-discriminating |
| phase_30_v < 30 | 89 | 49.4% | -1.1 | +3 | **Remove** |
| aligned_state | 101 | 50.5% | 0.0 | **+12** | **REMOVE** — everyone is aligned by the time they enter |
| supertrend_4H aligned | 27 | 48.1% | -2.3 | (indirect) | Neutral |
| rvol_30m 1.2-2.0x | 54 | 51.9% | +1.4 | 0 | Weak, skip |
| RSI bear divergence | 38 | 52.6% | +2.1 | -3 | **Remove penalty** |

### 2.3 Signals that are INVERTED (negative lift — currently rewarded but shouldn't be)

| Signal | n_on | WR_on | PnL_on | WR lift | Current weight | Recommendation |
|---|---|---|---|---|---|---|
| **LTF_30m bias aligned** | 68 | 44.1% | -0.16% | **-6.4** | (implicit) | **REVERSE: penalize** |
| **ALL 3 TFs aligned** | 61 | 47.5% | -0.12% | -3.0 | (implicit) | **REVERSE: over-alignment = late** |
| **ATR_day displacement aligned** | 13 | **30.8%** | -0.50% | **-19.7** | 0 | **Add -10 penalty** |
| **ATR_week displacement aligned** | 24 | **16.7%** | -1.28% | **-33.8** | 0 | **Add -20 penalty** |
| **phase_1H_v > 70 (over-extended)** | 6 | 16.7% | -1.89% | **-33.8** | phase penalty ok | **Increase penalty** |
| **phase_D_zone LOW** | 51 | 45.1% | -0.17% | -5.4 | 0 | Small negative |
| **phase_1H_zone HIGH** | 8 | 37.5% | -0.49% | -13.0 | 0 | **Add -8 penalty** |
| **regime_class=TRANSITIONAL** | 35 | 40.0% | -0.08% | **-10.5** | 0 | **Add -8 penalty** |
| **Phase bear divergence** | 59 | 45.8% | -0.02% | -4.7 | bear div -3 | OK as-is |
| **SHORT direction** | 10 | **40.0%** | -1.00% | -10.5 | 0 | Strongly penalize SHORT in non-downtrend |

---

## 3. The counter-intuitive findings

### "Golden Gate" ATR expansion is a LATE-MOVE signal

The data shows:
- **ATR_week displacement aligned** (ge=true, d >0 for LONG): **16.7% WR** — literally worse than a coin flip
- **ATR_day displacement aligned**: **30.8% WR**

We've been adding +10 to +15 to rank when these fire. That's backwards. **When ATR has already expanded in your direction, you're late.** The rewarded rank is a mean-reversion setup that fades.

### "Over-aligned" trades underperform

- **ALL 3 TFs (D+4H+30m) aligned**: 47.5% WR vs 55.0% when less aligned
- When everything is bullish across all TFs, the move is mature. We're entering pullbacks in an exhausted trend.

### Low rvol trades outperform (small sample caveat)

- **rvol_30m < 1.2x**: 80% WR on 5 trades
- These are "quiet setups before the move" — our system has been ADDING weight to high-rvol entries (which are often climactic tops).

### SHORT is broken in bull markets (already known, now quantified)

- 10 shorts, 40% WR, -1.00% avg
- We already have gates for this (H.3 regime-adaptive, the new I.2) but they're not catching all cases.

### Confirmed grade outperforms Prime grade

- Confirmed: 60.9% WR
- Prime: 48.1% WR
- **The engine's own "highest quality" label is misleading.** Deserves a separate investigation.

---

## 4. Proposed computeRankV2 weights

Approach: **Drop the non-discriminating signals. Keep the real discriminators. Reverse the inverted ones.**

```
BASE: 50   (centered at 50 so we can add/subtract)

POSITIVE SIGNALS (add):
  +10  setup_grade=Confirmed              (10.4% WR lift)
  +8   RSI bull divergence                (9.5% WR lift on 20 trades)
  +6   regime_class=TRENDING              (6.4% WR lift)
  +4   supertrend_30 aligned              (3.6% WR lift)

NEGATIVE SIGNALS (subtract):
  -20  ATR_week displacement aligned      (16.7% WR — major penalty)
  -10  ATR_day displacement aligned       (30.8% WR)
  -10  regime_class=TRANSITIONAL          (40.0% WR)
  -8   phase_1H_zone HIGH                 (37.5% WR)
  -6   LTF_30m bias aligned               (44.1% WR - inverse)
  -5   phase_D_zone LOW                   (45.1% WR)

DROP (no discrimination):
  - State alignment bonuses (+12/+4) — everyone has them
  - Completion bonus/phase penalty — marginal
  - Momentum elite (+15) — never meaningfully different on our sample
  - Squeeze bonuses — too specific to old data
  - Breakout bonuses (+12 to +20) — need re-validation
  - ORB bonuses — need re-validation
  - Sector bias — too broad

DIRECTION ADJUSTMENT:
  -10  side=SHORT and SPY not in downtrend   (already blocked by H.3/I.2)

CLAMP: max(0, min(100, score))
```

Expected calibration on v10b: rank-vs-pnl correlation should move from ~0 to +0.3 or better.

---

## 5. Validation approach

1. **Back-test V2 formula** against v6b + v7 + v9 closed trades:
   - For each trade, recompute what V2 rank would have been
   - Correlate V2 rank with actual pnl_pct
   - Target: Pearson > +0.25

2. **Smoke test V2 on Aug-Nov 2025 (v10b replay window)**:
   - Register a new run with `deep_audit_rank_formula=v2`
   - Compare V2's trade set vs v10b's: do the low-quality entries get filtered out while the high-quality ones stay?

3. **Lock V2 if it improves PF by >0.5 and WR by >5%**.

---

## 6. Notes + caveats

- **Sample sizes are small** for some signals (RSI bull div: 20 trades, rvol<1.2: 5 trades). We should cross-validate on v7's 229 trades before committing.
- **V10b's distribution is bull-biased** (91 LONG, 10 SHORT) so signals here reflect a bull market. V2 should be re-validated across bear/choppy periods (Oct 2025, Mar 2026 if available).
- **Some signals feed into state classification** (ripster clouds, supertrend) so "non-discriminating" doesn't mean "useless" — it means they're already expressed upstream. Removing their direct rank bonus is safe; removing them from the engine entirely is not.
- The V2 formula **keeps the underlying indicator computation**. We only change how their values map to the rank score.
