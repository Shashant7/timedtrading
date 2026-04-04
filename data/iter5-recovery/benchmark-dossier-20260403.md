# Benchmark Dossier

Generated: 2026-04-03

## Purpose

This dossier defines the benchmark contract for the recovery program so future work can be judged against explicit anchors instead of memory, screenshots, or mixed experimental runs.

It separates three things that had previously been conflated:

1. historical provenance
2. reproducible golden trade target
3. preserved current safety-net variant

## Benchmark Hierarchy

### 1. Historical Provenance Anchor

- Source: `tasks/GOLDEN_BASELINE_2026-03-25.md`
- Label: `iter5-full-baseline-sequence-ai-cio-off-keep-open`
- Run ID: `backtest_2025-07-01_2026-03-25@2026-03-25T15:28:40.740Z`
- Git SHA: `88a8af67b8d0c03b89149997482721355577a803`
- Date range: `2025-07-01 -> 2026-03-25`
- Mode: `sequence`
- Purpose in recovery:
  - preserve the documented system state that was considered golden
  - anchor system intent, launch shape, and provenance
  - define what the user means by "getting back to where we were"

### 2. Reproducible Golden Trade Target

- Source: `data/iter5-recovery/recovery-anchor-20260402.md`
- Golden Jul/Aug run:
  - Run ID: `backtest_2025-07-01_2025-08-08@2026-03-31T13:20:22.786Z`
  - Artifact bundle: `data/backtest-artifacts/candidate-tsm-gdx-julaug-v6-v4b-rankrecompute-export-20260402`
  - Summary:
    - `24` trades
    - `22` wins / `2` losses
    - realized PnL `4513.611471157675`
- Historical apples-to-apples full-run reference:
  - Run ID: `backtest_2025-07-01_2026-03-31@2026-03-31T21:26:48.269Z`
  - Artifact bundle: `data/backtest-artifacts/iter5-jul1-apr1-mar31-fullrun-export-20260402`
  - Reported parity:
    - basket parity `1.0`
    - entry timing parity `1.0`
    - path parity `1.0`
    - lifecycle parity `0.9166666666666666`
- Purpose in recovery:
  - primary trade-level benchmark
  - proves the target behavior is reproducible from historical evidence
  - serves as the main acceptance contract for trader reruns

### 3. Preserved Safety-Net Variant

- Source: `data/backtest-artifacts/jul1-apr2-seeded-parity-rerun-v2-safety-net-20260403-1048/preservation-manifest.md`
- Label: `jul1-apr2-seeded-parity-rerun-v2`
- Run ID: `backtest_2025-07-01_2026-04-02@2026-04-03T13:50:12.590Z`
- Repo HEAD at preservation: `0799690fe59c5626c8e17b64cbf4055ece269933`
- Worker deployments immediately preceding the lane:
  - top-level: `699729f4-f01d-4ff5-a592-13a788c6c0e9`
  - production: `f1b563f8-6efc-4ecb-9858-b759d6af3226`
- Launch shape:
  - `trader-only`
  - `--skip-market-events`
  - config file `configs/julaug-golden-parity-v2-20260402.json`
  - ticker batch `15`
  - interval `5m`
- Partial preservation snapshot:
  - `33` trades
  - `26` closed
  - closed PnL `1880.01188000086`
- Purpose in recovery:
  - safety-net branch
  - source of positive examples and selective learnings
  - not the default promotion target unless later evidence proves it superior

## Jul 1 Fingerprint Contract

Primary source: `tasks/option-a-parity-spec-2026-03-22.md`

The earliest Jul 1 fingerprint contract is:

1. `CDNS` LONG @ `2025-07-01 13:30 UTC`
   - `entry_path`: `ripster_momentum`
2. `ORCL` LONG @ `2025-07-01 13:45 UTC`
   - `entry_path`: `ripster_momentum`
3. `CSX` LONG @ `2025-07-01 13:45 UTC`
   - `entry_path`: `ripster_momentum`
4. `ITT` LONG @ `2025-07-01 14:15 UTC`
   - `entry_path`: `ripster_momentum`

Operational parity claim for the first Jul 1 window requires:

- same side: `LONG`
- same path family: `ripster_momentum`
- timestamp tolerance within one interval
- no early substitution of unrelated names replacing the entire window

## Benchmark Behavior Contract

### Trade Intent

- The target product is a selective swing-trade engine.
- Improvement is not defined by more trades.
- Improvement is defined by:
  - stronger selectivity
  - higher PnL per trade
  - healthier multi-day hold profile
  - lower noise/churn

### Management Intent

- First exhaustion is not an automatic forced exit.
- The system must support context-aware management:
  - `exit now`
  - `trim + defend`
  - `defer + tighten stop`
- Defer/defend decisions must consider:
  - structure health
  - sponsorship / RVOL
  - TICK and volatility context
  - premium / equilibrium / discount positioning
  - ticker and macro event proximity
  - progression of the move across more than one snapshot

### Accounting Intent

- Every trade must expose authoritative lifecycle fields:
  - entry datetime, raw entry price, shares, notional risk
  - trim datetime, raw trim price, trimmed shares, cumulative realized
  - exit datetime, raw exit price, exited shares, total trade PnL
- Derived or inferred prices may exist for diagnostics, but never as the primary displayed lifecycle price.

### Short-Side Intent

- The system is opportunity-agnostic.
- Valid SHORT opportunities should be taken when the conditions warrant them.
- A long-only outcome is only acceptable if frozen market context genuinely produced no valid shorts.

## Known Validation Examples

These examples must remain attached to the benchmark program:

- `ANET`
  - accounting mismatch between displayed lifecycle prices and chart context
  - useful for raw entry/trim/exit normalization
- `SLV`
  - `FLAT` accounting despite favorable development
  - useful for realized-PnL accounting and defer/defend review
- `LRN`
  - spurious trade that the golden system did not take
  - useful for entry-parity and event-risk validation

## Known Constraints And Gaps

- `option-a-rank-overhaul` is a curated imported blend, not a single native run.
- Some historical artifacts do not contain a full canonical `backtest_run_config`.
- The current runtime architecture differs materially from older tags such as `95417ae`:
  - dispatcher/pipeline routing now exists
  - dynamic engine rules can alter ticker-level selection
  - replay-specific gates and pre-pipeline behavior changed
- Therefore recovery cannot rely on "checkout old code and rerun" alone.

## Operator Rules

- Only one active replay/backtest process should be trusted at a time during recovery validation.
- The frozen recovery config remains:
  - `configs/julaug-golden-parity-v2-20260402.json`
- The golden evidence/report pair remains:
  - `data/iter5-recovery/golden-julaug-evidence.json`
  - one comparison report per new run under `data/iter5-recovery/`
- The current safety-net lane remains preserved and allowed to continue unless major drift or runtime failure invalidates it.

## Acceptance Checklist For Future Phases

- benchmark anchors are referenced by run id, SHA, and artifact path
- Jul 1 fingerprint contract is explicit
- management intent is explicit
- accounting intent is explicit
- short-side intent is explicit
- safety-net lane is preserved separately from the main golden target

## Referenced Sources

- `tasks/GOLDEN_BASELINE_2026-03-25.md`
- `tasks/scoring-overhaul.plan.md`
- `tasks/LIQUIDITY_AND_SIGNALS_PLAN.md`
- `tasks/option-a-parity-spec-2026-03-22.md`
- `tasks/BACKTEST_REFINEMENT_VALIDATION_PLAN.md`
- `data/iter5-recovery/recovery-anchor-20260402.md`
- `data/backtest-artifacts/jul1-apr2-seeded-parity-rerun-v2-safety-net-20260403-1048/preservation-manifest.md`
