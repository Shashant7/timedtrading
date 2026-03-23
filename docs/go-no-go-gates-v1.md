# Go/No-Go Gates v1

## Purpose
Define release gates for validation cycles and baseline promotion.

## Gate Families

### 1) Journey Parity Gates
- Required reference set match coverage: no missing critical references.
- Minimum journey score threshold for target comparators.
- Exit-class parity on protected references (must match class, not necessarily exact string).

### 2) Performance/Risk Gates
- Aggregate PnL and win-rate floors relative to control.
- Drawdown and loss-cluster caps.
- No material degradation in protected sectors/regimes.

### 3) Coverage Gates
- Validate results across wide scenario map:
  - ticker families
  - sectors/industries
  - directional bias
  - volatility buckets

### 4) Parity Gates (Live vs Replay)
- Engine/config inputs must match parity contract.
- No unresolved divergence in gate traces for protected references.

### 5) Explainability/Proof Gates
- Trade-proof payload completeness target met.
- Run-level audit receipt generated and reviewable.

## Promotion Rule
Only promote baseline when all gate families pass in the same candidate cycle.
