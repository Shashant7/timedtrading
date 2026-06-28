# Investor Mode — Accuracy Report

_Generated 2026-06-28T03:32:10.735Z · window 120d · base https://timed-trading-ingest.shashant.workers.dev_

## 1. Signal-outcome loop (is grading running?)

| source | desk | n | resolved | open | win_rate |
|---|---|---:|---:|---:|---:|
| cto_level | research | 4418 | 670 | 3748 | 100 |
| investor_action | investor | 73 | 0 | 73 | — |
| fsd_tactical | research | 40 | 3 | 37 | 66.7 |
| options_play | swing | 5 | 3 | 2 | 0 |
| vehicle_counterfactual | swing | 5 | 3 | 2 | 0 |
| vehicle_counterfactual | swing | 3 | 2 | 1 | 0 |

Investor signals logged (**73**) but **0 resolved** — all younger than the 60-day horizon. They grade as they mature (resolver no longer starved per PR #878).

## 2. Realized investor record by FSD tier

_Does anchoring on the Fundstrat buy-list pay? FSD membership is current (not at-trade-time) — directional._

| cohort |    |
|---|---|
| **All closed** | n=205 · W/L 124/81 · WR 60% · ΣP&L +$22689 · payoff 1.37 |
| **FSD picks (any)** | n=130 · W/L 81/49 · WR 62% · ΣP&L +$14066 · payoff 1.20 |
| — strong | n=71 · W/L 45/26 · WR 63% · ΣP&L +$4251 · payoff 0.93 |
| — core | n=59 · W/L 36/23 · WR 61% · ΣP&L +$9815 · payoff 1.49 |
| — light | n=0 · W/L 0/0 · WR 0% · ΣP&L +$0 · payoff 0.00 |
| **Non-FSD** | n=75 · W/L 43/32 · WR 57% · ΣP&L +$8623 · payoff 1.76 |

**FSD vs non-FSD:** WR 62% vs 57% (+5pts), avg P&L/trade $108 vs $115. Anchoring on the FSD buy-list is supported by the realized record.

---
_Re-run: `TIMED_API_KEY=… node scripts/investor-accuracy-report.mjs --days=120`_