# Phase-G — Refinement design from v6b forensics

**Date**: 2026-04-20
**Evidence source**: `data/trade-analysis/phase-f-continuous-v6b/forensics/`
**Trades analyzed**: 213 with full ATR Level + MTF payloads

## Core finding: the leak is exit management, not entry

v6b produced +92.82% over 10 months but ran +227% in v5 (lower SHORT count). The difference is almost entirely:

| Leak | Trades | Avg MFE | Avg pnl | MFE-exit gap | Leaked PnL |
|---|---:|---:|---:|---:|---:|
| leaky_winner | 77 | +6.14% | +2.15% | **+4.00%** | ~+308% |
| runner_give_back | 75 | +7.16% | +2.77% | +4.39% | ~+329% |
| never_worked | 38 | +0.45% | −2.56% | +3.01% | −97% avoidable |

If we'd captured 60% of MFE on leaky_winners alone, we'd have added ~150pp of PnL.

## Critical insight: Weekly ATR +0.236 to +0.618 is the modal reach

From the ATR reach tables per cohort:

| Cohort | Weekly reach modal | Max Weekly reach | Insight |
|---|---|---|---|
| Index_ETF | 0.236 (11 trades) | 0.618-1.0 (5) | Clear ceiling at +0.618 |
| MegaCap | 0.236 (16) | 0.618-1.618 (7) | Often reach +0.5-0.618, rarely beyond |
| Industrial | 0.236-0.5 | 0.618-1.0 (4) | Steady climbers but capped |
| Speculative | 0.5-0.786 (8) | 1.236 (1) | Wider range, need runners |
| Semi | 0.236-0.786 | 1.236 (1) | Midway between Industrial/Speculative |

User's "+1.0 Weekly = weekly peak" hypothesis **confirmed** — +1.0 is rare (2-3% of trades per cohort). **The real target is +0.618.**

## Refinement 1: ATR Level TP ladder (Phase-G.2)

Replace the current ATR-override TP logic with an explicit Fib-Weekly ladder.

**Universal TP ladder on Weekly ATR anchor (Multiday mode, 30m scoring TF)**:
```
TP1 at +0.236 × Weekly ATR from prev weekly close  → trim 30% (trigger hit)
TP2 at +0.382 × Weekly ATR from prev weekly close  → trim 30% (gate entry)
TP3 at +0.618 × Weekly ATR from prev weekly close  → trim 25% (key target)
Runner target at +1.000                             → trail stop, no forced exit
Hard exit at +1.618 OR HARD_FUSE_RSI_EXTREME
```

SHORT mirror on `levels_dn` (from prev weekly close DOWN).

**Cohort weight overrides** (based on reach distribution):

| Cohort | TP1 (23.6%) | TP2 (38.2%) | TP3 (61.8%) | Runner | Rationale |
|---|---:|---:|---:|---:|---|
| Index_ETF | 40% | 35% | 20% | 5% | Rare to exceed 0.618, take heavy early |
| MegaCap | 30% | 30% | 25% | 15% | Extended trends, let runner breathe |
| Industrial | 35% | 35% | 25% | 5% | Similar to ETF |
| Speculative | 20% | 25% | 30% | 25% | Let it ride — reaches +1.236 occasionally |
| Semi | 30% | 30% | 25% | 15% | Midway |

**DA keys**:
```
deep_audit_atr_tp_ladder_enabled = true
deep_audit_atr_tp_ladder_horizon = week  (Multiday mode)
deep_audit_atr_tp_ladder_tp1_ratio = 0.236
deep_audit_atr_tp_ladder_tp2_ratio = 0.382
deep_audit_atr_tp_ladder_tp3_ratio = 0.618
deep_audit_atr_tp_ladder_runner_ratio = 1.000
deep_audit_atr_tp_ladder_trim_{index_etf,megacap,industrial,speculative,semi}_{tp1,tp2,tp3,runner}_pct
```

## Refinement 2: "Never worked" flatten (Phase-G.3)

38 trades with MFE <1% that bled to −2.5% avg. F4 dead-money detector was supposed to catch these at 24h+ market minutes + MFE<1% + pnl≤-1%. Clearly not firing often enough — likely because many of these trades close before hitting 24h market minutes (mid-day stop-outs at 2h-4h).

Tighten to "early dead money":
- At **4 hours market minutes**, if MFE < 0.5% AND pnl ≤ −1%, flatten
- This catches the "trade went immediately red and never recovered" pattern

**DA keys**:
```
deep_audit_early_dead_money_enabled = true
deep_audit_early_dead_money_age_min = 240   # 4h market minutes
deep_audit_early_dead_money_mfe_max_pct = 0.5
deep_audit_early_dead_money_pnl_max_pct = -1.0
```

## Refinement 3: MFE-giveback protection (Phase-G.4)

75 runner_give_back trades ran +7% then gave back to +2.7%. Need tighter trail once MFE peaks in cohort-specific bands.

**MFE-giveback trail (cohort-aware)**:
- Index_ETF: once MFE ≥ +2%, trail stop at 40% of MFE (locks +0.8%)
- MegaCap: once MFE ≥ +3%, trail at 50% (locks +1.5%)
- Industrial: once MFE ≥ +3%, trail at 40% (locks +1.2%)
- Speculative: once MFE ≥ +5%, trail at 60% (locks +3%)

**DA keys**:
```
deep_audit_mfe_giveback_trail_enabled = true
deep_audit_mfe_giveback_trail_{cohort}_min_mfe_pct
deep_audit_mfe_giveback_trail_{cohort}_trail_ratio
```

## Non-goals for Phase-G

- **NO new entry gates** — the entries are finding valid setups; "clear_loser" avg MFE +0.72% means they never worked, not that entry was wrong. The fix is exit-side.
- **NO SHORT gate tightening** — v6b 120 SHORTs were the right count; we just need to manage them better.
- **NO ATR Level entry filter changes** — `entry_extended_below_e48` tag is actually profitable on SHORTs.

## Implementation order

1. Phase-G.3 (early dead money) — smallest change, highest expected impact on the 38 never_worked trades
2. Phase-G.4 (MFE-giveback trail) — protect the 75 runner_give_back trades
3. Phase-G.2 (ATR Level TP ladder) — biggest architectural change, most upside on leaky_winners

Ship in that order, smoke-test each, then run 40-ticker v7 validation.

## Expected impact

Applying all three refinements to v6b trades retrospectively (estimated):
- Never_worked cut by ~60% → save ~60pp
- Runner_give_back MFE capture 30% → 60% → gain ~100pp
- Leaky_winner MFE capture 35% → 55% → gain ~60pp
- Total expected uplift: **+200pp** over v6b → target v7 training pnl ≈ +250%+
