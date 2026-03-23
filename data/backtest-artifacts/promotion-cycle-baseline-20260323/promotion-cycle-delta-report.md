# Promotion Cycle Delta Report (B/CVNA/CSCO)

## Before (short validation baseline)
- Closed trades: **5**
- Win rate: **60.0%**
- Avg pnl% (closed): **0.14336599072676687**
- Engine source counts: `{'reference_date_bucket': 5}`
- Scenario source counts: `{'scenario_policy_default': 5}`

## Post upgrade (v3 / v3b short validations)
- v3 closed trades: **6**, win rate: **66.67%**, avg pnl%: **0.6291613437778464**
- v3b closed trades: **6**, win rate: **66.67%**, avg pnl%: **0.6291613437778464**

## Post upgrade attribution proof (v3c interval diagnostics)
- Probe rows: **84**
- Engine source counts: `{'reference_ticker_window': 42, 'reference_date_bucket': 41, 'unknown': 1}`
- Scenario source counts: `{'scenario_policy_default': 44, 'scenario_policy': 39, 'unknown': 1}`

## Decision
- **Conditional GO** for a guarded full run (`locked-validation-v3-targeted-promotion`) with promotion configs in place.
- Validate full-run attribution + weak-rate deltas before broad promotion.

## Caveats
- Short replay trade metrics are directional only; rely primarily on interval diagnostics for routing shifts.
