# Conviction Fusion — Corpus Validation (Slice E)

Backtest corpus: 362 trades (362 enriched). Missed corpus: 211 (Tier A move_atr>=8: 75).
Caveat: focus_conviction + daily-EMA21 not in cache => neutral here (lower bound on selectivity).

## Backtest outcomes
```
BASELINE (all)             n=362  WR= 57.7%  meanPnl= -0.025  SQN= -0.18
confirm_stack FIRED        n=212  WR= 59.9%  meanPnl=  0.079  SQN=  0.44
confirm_stack NOT fired    n=150  WR= 54.7%  meanPnl= -0.172  SQN= -0.82
conviction Tier A          n=  2  WR=   50%  meanPnl= -2.012  SQN= -1.01
conviction Tier B          n=210  WR=   60%  meanPnl=  0.099  SQN=  0.55
conviction Tier C          n=150  WR= 54.7%  meanPnl= -0.172  SQN= -0.82
```

## Walk-forward (75/25 by entry_ts)
```
in-sample  BASELINE        n=271  WR= 59.4%  meanPnl=  0.009  SQN=  0.05
in-sample  confirm FIRED   n=163  WR= 60.7%  meanPnl=  0.126  SQN=  0.58
out-sample BASELINE        n= 91  WR= 52.7%  meanPnl= -0.124  SQN= -0.58
out-sample confirm FIRED   n= 49  WR= 57.1%  meanPnl= -0.076  SQN= -0.26
```

## What-if: conviction-weighted sizing applied to the corpus (sum of pnl_pct)
```
all:        base Σ=-8.97  sized Σ=0.35  Δ=103.9%  sizedSQN=0.01
in-sample:  base Σ=2.33  sized Σ=8.62  Δ=269.3%  sizedSQN=0.22
out-sample: base Σ=-11.31  sized Σ=-8.27  Δ=26.8%  sizedSQN=-0.5
(Caveat: focus_conviction + EMA21 absent in cache => tiers collapse to gate/no-gate; lower bound.)
```

## Missed-move capture opportunity
```
all misses confirm_stack would flag:    130 / 211 (61.6%)
Tier-A misses confirm_stack would flag: 51 / 75 (68.0%)
```

## Verdict vs promotion gates
```
PASS  gate_fired_n_oos             value=49 want >=30
PASS  confirm_beats_baseline_wr    value=59.9 want > baseline 57.7%
PASS  confirm_positive_expectancy  value=0.079 want > 0
FAIL  oos_sqn_holds_70pct          value=-0.45 want >= 0.70 of in-sample
FAIL  tierA_beats_tierC_wr         value=[50,54.7] want Tier A WR > Tier C WR

OVERALL: PARTIAL — do NOT flip live yet; see failing checks
```
