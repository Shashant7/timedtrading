# Policy Explanation v1

Generated: 2026-03-22 (UTC)

## Source
- Policy artifact: `configs/dynamic-engine-rules-reference-v1.json`
- Blueprint source: `data/reference-intel/journey-blueprints-v1.json`
- Selection source: `data/reference-intel/reference-selection-v1.json`

## Rule Set Summary
- Version: `reference_v1`
- Total rules: `27`
- Selection thresholds:
  - `min_count = 3`
  - `min_score = 0.7`
  - `max_rules = 80`

## Rule Semantics
- Each rule encodes a context bucket:
  - sector
  - direction
  - entry path
  - hold bucket
- Each recommendation contains:
  - policy bias (`promote` or `cautious`)
  - preferred exit class
  - confidence estimate
  - expected win-rate / expected pnl%

## Explainability Contract
- Every rule includes `evidence`:
  - cluster count
  - average hybrid score
  - representative tickers
- This keeps recommendations auditable back to clustered reference journeys.

## Runtime Note
- Current runtime integration is gated and additive.
- The artifact is ready for policy-routing integration in validation cycles before live promotion.
