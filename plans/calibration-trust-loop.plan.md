---
name: Calibration Trust Loop
overview: 'Make System Intelligence Analysis/Calibration a trustworthy self-tune loop: scoped autopsy IDs, live vs promoted provenance, data-quality gates, and a clear Apply contract so operators know what is safe to tune.'
todos:
  - id: scoped-ids
    content: 'Scope-prefix calibration_trade_autopsy trade_id (scope::id) in promoted + live seeders; never clobber other scopes.'
    status: completed
  - id: enrich-quality
    content: 'Enrich MFE/MAE from trades/backtest_run_trades; stamp data_quality + immutable provenance on every report.'
    status: completed
  - id: apply-gates
    content: 'Apply requires live scope + quality floors (MFE/VIX/regime); block floor-default SL/TP when excursions missing.'
    status: completed
  - id: si-ui
    content: 'SI Run Analysis defaults to trusted live; Apply promotion re-run uses live scope; Trust panel surfaces coverage.'
    status: completed
  - id: kv-bind
    content: 'Fix weekly-governor + family-attribution KV binding to KV_TIMED.'
    status: completed
isProject: true
---

# Calibration Trust Loop

## Problem

Run Analysis falls back to mixed/legacy data when seed-from-promoted hits
`UNIQUE(trade_id)`. Reports recommend SL/TP floors from zero MFE ATR, regime
is unknown, and Apply/UI disagree on what "live" means. Operators cannot tell
what is safe to tune.

## Contract

| Scope | Source | Apply? |
|-------|--------|--------|
| `live-trades` | `trades` where `run_id` empty | Yes, if quality + WFO pass |
| `promoted:<run>` | `promoted_trades` + archived MFE | Challenger / diagnostic only |

Every report stamps `calibration_provenance` + `data_quality` (MFE/MAE/VIX/
regime coverage, excursion_source, apply_eligible, block_reasons).

## Explicitly not

- Flipping conviction/bleeder flags
- Blind path DISABLE from promoted challenger
- New parallel apply bus (use existing `/timed/calibration/apply` + gates)
