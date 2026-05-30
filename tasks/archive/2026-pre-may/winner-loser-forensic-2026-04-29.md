# Winner-vs-Loser Forensic — FIX 4 Baseline (107 trades, 62.6% WR)

**Date:** 2026-04-29  
**Goal:** Identify statistical separators between winners and losers to push WR ≥ 70% without killing big winners.

## TL;DR — Key Insights Found

| # | Finding | Impact |
|---|---|---|
| 1 | **`tt_gap_reversal_long` is 75% WR across all extension levels** — the workhorse path | Don't filter it |
| 2 | **`tt_pullback` 0-3% above EMA21: 38% WR** — but contains AVGO +50% and other big winners (statistically inseparable) | Tricky; reject naive filter |
| 3 | **HTF=HOT(>=70 RSI) + LTF=NEUT(50-60 RSI): 78% WR** — classic pullback-in-trend pattern | Boost weight |
| 4 | **HTF=WARM(60-70) + LTF=WARM(60-70): 43% WR** — middling/late zone | Strong block candidate |
| 5 | **e21_slope_5d 2-3%: 42% WR, -15.72% PnL** — steep but not parabolic = stuck zone | Strong block candidate |
| 6 | **Tuesday 70% WR / Wednesday 76% WR**; Mon/Thu < 55% | Day-of-week bias |
| 7 | **`pct_above_e21 >= 5%`: 74% WR** | Confirms momentum follows momentum |
| 8 | **`pct_above_e21 < 0%` (below E21): 80% WR** | Mean-reversion buyers — strong |

## Confirmed: 30m beats 5m/10m

The user is right — we already validated this on 2026-04-28. From the same fix smoke (FIX 1 + P0.7.16 baseline):

| Interval | Trades | WR | PnL | PF |
|---|---|---|---|---|
| **30m** | **113** | **54.9%** | **+304.13%** | **5.01** |
| 5m | 85 (closed 59) | 42.4% | +36.05% | 2.03 |
| 10m | 83 (closed 57) | 42.1% | +35.18% | 1.99 |

30m beats 5m/10m by **4-6× PnL on matching trades**. 5m/10m kill runners on noise wicks. **No further interval work needed.**

## Forensic Methodology

Pulled all 107 closed trades from `v16-fix4-jul-30m-1777446799`. For each, parsed `rank_trace_json.setup_snapshot` for ~30 captured fields. Computed per-cohort WR/PnL/PF and looked for clean separators.

### Continuous metrics — ranked by separation power

| Metric | Win avg | Loss avg | Delta | Sig |
|---|---|---|---|---|
| `pct_above_e48` | 9.17 | 6.72 | **+2.45pp** | ★ |
| `pct_above_e21` | 5.00 | 3.58 | **+1.42pp** | ★ |
| `e21_slope_5d` | 2.20 | 1.52 | +0.68 | ★ |
| `oil_pct` (cross-asset) | 0.20 | 0.49 | -0.29 | ★ |

Winners were on average:
- **+1.42pp further above EMA21** than losers
- **+2.45pp further above EMA48** than losers  
- Trading on days with **lower oil moves** (-0.29pp cross-asset)

Other signals (rank, conviction, focus_conviction_score, RSI, RVol, RR) were **statistically indistinguishable** between cohorts.

### Sweet/sour zones

```
pct_above_e21 distribution:
  <0%       :  5/4   80% WR  +22.36%  ★
  0-1%      :  8/4   50% WR  +103.98%
  1-2%      : 26/16  62% WR  +134.09%
  2-3%      : 13/6   46% WR  +5.79%   ✗
  3-5%      : 23/14  61% WR  +123.46%
  5-10%     : 20/14  70% WR  +37.70%  ★
  10-20%    :  7/5   71% WR  +3.32%   ★
  >20%      :  4/4  100% WR  +17.79%  ★

e21_slope_5d distribution:
  <0%/d     :  6/4   67% WR  +21.56%
  0-0.5%/d  : 13/10  77% WR  +134.24% ★
  0.5-1%/d  : 25/13  52% WR  +111.86%
  1-2%/d    : 32/21  66% WR  +129.68%
  2-3%/d    : 12/5   42% WR  -15.72%  ✗
  >3%/d     : 18/14  78% WR  +66.86%  ★
```

The pattern: **either nearly-flat or near-vertical slopes work; the "moderate but not strong" middle is dangerous**.

### RSI MTF Concordance — strongest pattern

```
D=HOT   h1=NEUT     N=  9 WR= 78% PnL= +47.12%   ★ pullback in hot trend
D=WARM  h1=NEUT     N= 15 WR= 73% PnL= +59.88%   ★ early lift in warm trend
D=HOT   h1=HOT      N= 28 WR= 68% PnL= +32.19%   acceptable but dangerous
D=HOT   h1=WARM     N= 21 WR= 62% PnL= +46.65%
D=NEUT  h1=NEUT     N= 10 WR= 60% PnL=+197.66%   contains LITE +111
D=WARM  h1=WARM     N= 14 WR= 43% PnL= +42.64%   ✗ middling — strong block
D=WARM  h1=HOT      N=  3 WR= 33% PnL=  +1.41%   ✗ overheated LTF in mid-trend
```

## Filter Candidates Tested

### F1 — Late-stage extension (NARROW)
Block `tt_pullback`/`tt_ath_breakout` when `0 ≤ pct_above_e21 < 3` AND `e21_slope_5d ≥ 1.5`.
- Blocks: 3 (all losers)  
- Net WR: +1.8pp → 64.4% | Net PnL: **+3.22pp**

### F2 — Middling RSI MTF (D-WARM × h1-WARM)  
Block when `60 ≤ rsi_D < 70` AND `60 ≤ rsi_h1 < 70`.
- Blocks: 14 (43% WR cohort)
- Loses BWXT +39.25% (false positive)
- Net WR: +3.0pp → 65.6% | Net PnL: **-42.64pp** (sacrifices upside)

### F2-tight — Narrow middling (63<rsi_D<69 AND 62<rsi_h1<68)
Block tighter band that excludes BWXT.
- Blocks: 7 (29% WR cohort)
- Net WR: +2.4pp → 65% | Net PnL: -28.72pp

### F3 — e21_slope dead zone (2 ≤ slope < 3)
- Blocks: 12 (42% WR, **-15.72% PnL** cohort) ✗
- Net WR: +2.7pp → 65.3% | Net PnL: **+15.72pp**

### F4 — Late afternoon (13:30-15:00 ET)
- Blocks: 19 (47% WR cohort)
- Loses 9 winners totaling +129pp ✗
- Net PnL: -94.28pp — **REJECT**

## Recommended Combined Filter — V3 (gap_rev exempt)

**Logic:**
```
def quality_block(t):
    if t.entry_path in ("tt_gap_reversal_long","tt_gap_reversal_short"):
        return False  # never block our best-performing path
    
    rsi_d = setup_snapshot.rsi.D or 0
    rsi_h1 = setup_snapshot.rsi.h1 or 0
    pct_e21 = setup_snapshot.pct_above_e21 or 0
    slope = setup_snapshot.e21_slope_5d or 0
    
    F1 = (0 <= pct_e21 < 3) and (slope >= 1.5) and \
         t.entry_path in ("tt_pullback","tt_ath_breakout")
    F2 = (63 < rsi_d < 69) and (62 < rsi_h1 < 68)
    F3 = (2 <= slope < 3)
    
    return F1 or F2 or F3
```

**Counterfactual on FIX 4 baseline (107 trades):**

| | Before | After V3 |
|---|---|---|
| Trades | 107 | 99 (blocks 8) |
| **WR** | **62.6%** | **66.7% (+4.1pp)** |
| **PnL** | **+430.63%** | **+438.04% (+7.41pp)** ⬆ |
| **PF** | **5.33** | **5.80 (+0.47)** ⬆ |
| Top-15 winners blocked | - | **0** ★ |

**Strictly improves all metrics. No big winner blocked.**

### V2 (more aggressive, hits 70%)

If we want to push to 70% WR, V2 (without gap_rev exemption):

| | Before | After V2 |
|---|---|---|
| Trades | 107 | 86 |
| **WR** | 62.6% | **70.5% (+7.9pp)** |
| **PnL** | +430.63% | **+419.15%** (-11.48pp) |
| **PF** | 5.33 | **8.16 (+2.83)** ⬆⬆ |
| Top-15 winners blocked | - | 1 (BWXT +39.25%) |

V2 sacrifices ~11pp of PnL for **WR jumping to 70.5% and PF doubling**.

## Newly-captured fields (P0.7.22 deployment)

The user identified that these signals exist but weren't captured for analysis:

- **TD Sequential count per TF** — `td_seq.{10,30,60,240,D,W}.{bull_prep, bear_prep, bull_leadup, bear_leadup, td9_*, td13_*}`
- **PDZ zones per TF** — `pdz.{D, h4, h1}` ∈ {premium, premium_approach, equilibrium, discount_approach, discount}
- **Divergence flags** — `divergence.{adverse_rsi, adverse_phase, bull_rsi, bear_rsi}`

The system already computes all three at qualify-time but never stamped them on the snapshot. Now stamped (V15 P0.7.22, deployed mid-flight on canonical Jul-Apr 30m run). The remaining ~187 days of the run will carry the new fields, enabling deeper analysis post-completion.

## Proposed FIX 12 — V3 Quality Composite Block

Implement the V3 filter as a hard-block in entry path with a DA flag:

- `deep_audit_quality_block_enabled` (default `false` until validated)
- `deep_audit_quality_block_exempt_paths` (default `tt_gap_reversal_long,tt_gap_reversal_short`)
- `deep_audit_quality_block_f2_rsi_d_min` (default 63)
- `deep_audit_quality_block_f2_rsi_d_max` (default 69)
- `deep_audit_quality_block_f2_rsi_h1_min` (default 62)
- `deep_audit_quality_block_f2_rsi_h1_max` (default 68)
- `deep_audit_quality_block_f3_slope_min` (default 2.0)
- `deep_audit_quality_block_f3_slope_max` (default 3.0)
- `deep_audit_quality_block_f1_ext_max` (default 3.0)
- `deep_audit_quality_block_f1_slope_min` (default 1.5)

Validate on July smoke first. If it preserves the +438pp PnL and lifts WR to 67%, promote.

## Future hunts (post-canonical baseline)

Once the Jul→Apr canonical run completes with TD/PDZ/divergence fields:

1. **TD9 exhaustion fade**: Are entries against an active TD9 ceiling losers?
2. **PDZ premium block for LONG**: Does buying in `premium_approach` cause more failures?
3. **Active adverse RSI divergence**: Does an active D-bear divergence kill LONG WR?
4. **TD prep count >= 7 on entry TF**: Is the trend nearing exhaustion?
5. **Cross-asset hedges** (gold up + dollar up + oil up = risk-off): Lower WR?

These are testable as soon as the canonical run finishes with the new fields.
