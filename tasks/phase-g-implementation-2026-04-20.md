# Phase G — Implementation summary

**Date**: 2026-04-20  
**Status**: Implemented. 2-week Mar-25 to Apr-10 smoke test in flight.

## Three refinements shipped

### G.2 — ATR Level TP Ladder (probability-weighted, cohort-aware)

Implemented in `worker/index.js` `classifyKanbanStage()` after the R6
MFE trail block. Uses `tickerData.atr_levels.day.disp` as the primary
signal (Day horizon because our 10m trigger maps to Day mode).

**Probability evidence** (from v6b Golden Gate matrix, Day horizon):
- 0.382 → 0.618: **79%** favorable continuation
- 0.618 → 1.0: **75%**
- 1.0 → 1.618: **65%**
- Week 0.618 is the real ceiling (only 23% past it)

**Cohort-specific trim percentages**:

| Cohort | 0.382 | 0.618 | 1.0 | 1.236 | 1.618 |
|---|---:|---:|---:|---:|---:|
| Index_ETF | 25% | 35% | 30% | 10% | 0% |
| MegaCap | 20% | 25% | 20% | 20% | 15% |
| Industrial | 25% | 35% | 30% | 10% | 0% |
| Speculative | 15% | 20% | 20% | 20% | 25% |
| Semi | 20% | 30% | 25% | 15% | 10% |
| default | 25% | 30% | 25% | 15% | 5% |

Index_ETF and Industrial weight heavily at TP2 (0.618) because P(0.618→1.0)
is lower for them; Speculative and MegaCap let runners breathe because
extended ratios have high continuation rates.

**Tier tracking is stateless** — inferred from `currentTrimPct` against
cumulative cohort trim sums (with 5% fuzz band to coexist with other
trim sources like the smart-runner lane).

**Week +0.618 = FULL EXIT** regardless of tier — only 23% of trades go
past this level, so taking the full profit is correct.

### G.3 — Early Dead-Money Flatten

At 4h market-min, if MFE < +0.5% AND pnl <= -1%, flatten. Targets the
38 `never_worked` trades in v6b that rode to −2.5% avg with MFE < 1%.
Existing F4 dead-money detector fires at 24h+; this is the earlier
catcher for "immediate red, never recovered" pattern.

Exit reason: `early_dead_money_flatten`.

### G.4 — Adverse Day -0.382 ATR Cut

Once price crosses adverse -0.382 × Day ATR from prev close, 73% of the
time it continues to -0.618. So cut HERE rather than waiting for -0.618
or the full stop. Only fires when pnl is also ≤ -0.5% (prevents clipping
on small noise).

Exit reason: `atr_day_adverse_382_cut`.

## Deploy version IDs

- Default env: `63d27484-8d39-4f43-bae5-561352b3f7f8`
- Production env: `f5d9ccf5-2adc-4cb6-a886-a33f278b265f`

## DA keys activated

```
deep_audit_atr_tp_ladder_enabled = true
deep_audit_atr_tp_ladder_week_exit_threshold = 0.618
deep_audit_early_dead_money_enabled = true
deep_audit_early_dead_money_age_min = 240
deep_audit_early_dead_money_mfe_max_pct = 0.5
deep_audit_early_dead_money_pnl_max_pct = -1.0
deep_audit_atr_adverse_cut_enabled = true
deep_audit_atr_adverse_cut_threshold = -0.382
deep_audit_atr_adverse_cut_pnl_min_pct = -0.5
```

## Expected impact (from v6b baseline)

From v6b forensics tags:
- 77 leaky_winner with +4.0% avg MFE-exit gap: TP ladder should capture ~50-60% of the leaked PnL
- 75 runner_give_back with +4.4% avg gap: Week +0.618 full exit should lock ~50% of the peak
- 38 never_worked with +3.0% gap: G.3 should cut these at -1% instead of -2.5%
- 48 clear_loser: G.4 (-0.382 cut) should trim the average loss from -2.9% to -1.5%

**Projected v7 uplift**: +150-200pp over v6b +92% → target ~+250%

## Validation sequence

1. ✅ Deploy + activate (done)
2. 🔄 2-week targeted probe (Mar 25 - Apr 10, bearish regime): verify
   TP ladder fires on the Mar SHORT trades
3. Targeted single-day probes on known days (Jul 1, Sep 15, Dec 17)
4. 40-ticker v7 continuous validation run
5. 215-ticker v8 full universe
