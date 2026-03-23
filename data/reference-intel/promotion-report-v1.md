# Reference-Intel Promotion Report v1

Generated: 2026-03-22 (UTC)

## Artifact Lineage
- Canonical dataset: `trade-intel-canonical-v1.jsonl` (6488 rows, 136 runs with data)
- Reference selection: `reference-selection-v1.json` (250 selected references)
- Coverage/gaps: `coverage-gap-report-v1.json`
- Context intelligence: `context-intel-snapshot-v1.json` + `context-intel-quality-v1.json`
- Journey blueprints: `journey-blueprints-v1.json` (121 clusters)
- Dynamic policy artifact: `configs/dynamic-engine-rules-reference-v1.json` (27 rules)
- Validation gates: `validation-gates-v1.json`

## Gate Outcome
- Overall readiness: PASS (`8/8` gates)
- Lineage thresholds: PASS
- Reference breadth thresholds: PASS
- Context-intel completeness thresholds: PASS
- Policy artifact threshold: PASS

## Notes
- This report validates the reference-intel build stack and gate contract readiness.
- It does not replace candidate-vs-control replay outcome validation for live promotion.
