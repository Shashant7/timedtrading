# CIO Reference Integration v1

## Goal
Inject reference-trade intelligence into CIO memory as priors without breaking existing CIO behavior.

## Runtime Integration
- Feature flag key: `ai_cio_reference_enabled` (loaded from `model_config` into deep-audit config).
- Source key: `cio_reference_features` (JSON payload in `model_config`).
- Live path:
  - scoring-cycle CIO memory cache loads `cio_reference_features` when flag is enabled.
- Replay path:
  - replay CIO memory preloader loads `cio_reference_features` when flag is enabled.

## CIO Memory Additions
- New memory field: `reference_priors`.
- Contents:
  - `ticker`
  - `ticker_direction`
  - `entry_path_direction`
  - `sector_direction`
  - `merged_confidence_prior` (weighted aggregate for prompt guidance)

## Artifact Builder
- Script: `scripts/reference-cio-feature-pack.py`
- Outputs:
  - `data/reference-intel/cio-memory-features-v1.json`
  - `data/reference-intel/cio-eval-loop-v1.json`

## Operator Workflow
1. Build artifacts:
   - `python3 scripts/reference-cio-feature-pack.py`
2. Load feature payload into `model_config` key `cio_reference_features`.
3. Enable `ai_cio_reference_enabled=true` in `model_config`.
4. Run replay validation and compare CIO approve/reject calibration before live use.

## Safety Notes
- If payload is missing/invalid, CIO memory construction falls back safely.
- Reference priors are additive context only; they do not force hard approves/rejects.
