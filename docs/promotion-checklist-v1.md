# Promotion Checklist v1 (Hard Go/No-Go)

Use this checklist before accepting any new baseline.

## 1) Parity (Blockers)
- [ ] Protected journey parity passes (CSX-class references included).
- [ ] No unresolved live vs replay divergence in gate trace artifacts.
- [ ] Entry/exit class parity for protected references is within accepted bounds.

## 2) Performance/Risk (Blockers)
- [ ] Candidate meets minimum PnL and win-rate vs control.
- [ ] Drawdown and loss-cluster limits are not breached.
- [ ] No material regression in protected sectors/regime buckets.

## 3) CIO Calibration (Blockers)
- [ ] `cio-eval-loop-v1.json` shows approve/adjust quality above threshold.
- [ ] Reject counterfactual win-rate does not exceed approve/adjust win-rate.
- [ ] Confidence buckets are monotonic or improving vs prior cycle.

## 4) Explainability + UI Proof (Blockers)
- [ ] Trade proof payload completeness target met.
- [ ] One-run/one-trade proof panel acceptance checks pass.
- [ ] Operator audit receipt is published and reviewable.

## 5) Release Hygiene (Blockers)
- [ ] Versioned artifacts are published and linked:
  - validation go/no-go
  - CIO validation
  - policy explanation
  - promotion report
- [ ] Drift monitor baseline is captured for post-promotion comparison.

## Decision
- **GO** only if all blocker items pass in same candidate cycle.
- **NO-GO** if any blocker item fails.
