# Investor Mode — Accuracy Report

_Generated 2026-06-28T20:13:26.605Z · window 400d · base https://timed-trading-ingest-preprod.shashant.workers.dev_

## 1. Signal-outcome loop (is grading running?)

| source | desk | n | resolved | open | win_rate |
|---|---|---:|---:|---:|---:|
| options_play | swing | 61 | 0 | 61 | — |
| investor_action | investor | 45 | 0 | 45 | — |
| options_play | investor | 45 | 0 | 45 | — |

Investor signals logged (**45**) but **0 resolved** — all younger than the 60-day horizon. They grade as they mature (resolver no longer starved per PR #878).

## 2. Realized investor record by FSD tier

_Does anchoring on the Fundstrat buy-list pay? FSD membership is current (not at-trade-time) — directional._

| cohort |    |
|---|---|
| **All closed** | n=15 · W/L 14/1 · WR 93% · ΣP&L +$6381 · payoff 1.28 |
| **FSD picks (any)** | n=0 · W/L 0/0 · WR 0% · ΣP&L +$0 · payoff 0.00 |
| — strong | n=0 · W/L 0/0 · WR 0% · ΣP&L +$0 · payoff 0.00 |
| — core | n=0 · W/L 0/0 · WR 0% · ΣP&L +$0 · payoff 0.00 |
| — light | n=0 · W/L 0/0 · WR 0% · ΣP&L +$0 · payoff 0.00 |
| **Non-FSD** | n=15 · W/L 14/1 · WR 93% · ΣP&L +$6381 · payoff 1.28 |

_Not enough closed trades per cohort for a confident split (need ≥5 each)._

---
_Re-run: `TIMED_API_KEY=… node scripts/investor-accuracy-report.mjs --days=400`_
