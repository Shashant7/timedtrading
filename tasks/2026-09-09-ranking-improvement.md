# Ranking improvement — 2026-09-09

Scope: ranking only. Preserve entry-policy thresholds, exits, sizing, broker
execution and unrelated lanes. This task supersedes the earlier broad roadmap
for this branch.

## Contract before implementation

- Trace the rank actually consumed at scoring and candidate ordering.
- Implement an outcome-calibrated challenger using entry-time features, with
  explicit missing-data handling and conservative shrinkage for small samples.
- Every historical prediction may learn only from trades closed before that
  candidate's entry. Deduplicate IDs and exclude incomplete/open outcomes.
- Freeze the model family before reporting the final chronological evaluation;
  do not tune against the final holdout. Report both unit-capital return and
  recorded dollar P&L, with identical recorded exits and sizing.
- Public closed trades are a selected sample, not the full candidate universe.
  A ranking diagnostic is not a portfolio replay or proof of deployable alpha.
- Promote an outcome challenger only if the chronological evidence supports it.
  Otherwise retain the reproducible experiment offline, with no runtime import.
  Existing gates and risk rules remain authoritative.
- Add meaningful tests for temporal leakage, missing/invalid inputs, sparse
  history, deterministic ordering and ranking-path integration.

## Progress

- [x] Trace existing rank, dynamic score and candidate selection paths.
- [x] Implement canonical candidate ranking and the offline chronological evaluator.
- [x] Compare on the current closed ledger and document limits.
- [x] Verify ranking, access controls, syntax and worker bundle.
- [ ] Publish one ranking-only PR.

## Initial findings

`computeRank` is a capped additive technical score. `computeDynamicScore`
adds several correlated ingredients again and converts rank zero to 50 via
`Number(rank) || 50`. The scoring cron computes rank before attaching current
`_deepAuditConfig`, so a new formula must be applied with the correct runtime
context. The Phase-C top-N selector is a separate opt-in replay path; changing
that file alone would not improve the live rank.

## Development decision (before final holdout)

Trial 1 (side, R:R band, technical-rank band; May 1–July 31 entries) failed:
80 scored trades; rank/return correlation +0.0172 baseline versus -0.1590
challenger. Weekly top-third recorded P&L was -$1,905.04 versus -$1,883.18;
challenger mean trade return and profit factor were worse. This does not
justify activation. One setup-aware revision is evaluated on development
data, then frozen before the August 1+ holdout; no threshold search.

The shipping ranking correction will instead address demonstrated defects:
use the technical score once, preserve its pre-cap resolution for ordering,
apply freshness after all tilts, use one order on both API paths, and process
new entry candidates by that order after existing-position management.
Gate scores retain their 0–100 scale. No new admission rules or limits.

## Implemented ranking changes

| Finding | Correction | Evidence available to the next agent |
| --- | --- | --- |
| Technical signals received a second set of dynamic bonuses/penalties. | Use the technical score once, plus the existing gated theme/fair-value/harmonic/officer/macro overlays. | `worker/ranking/candidate-rank.js`; `_ranking` records base, overlay delta and final priority. |
| Technical ranks lost precision and saturated at 100. | Preserve pre-cap score in `_technical_rank`; keep bounded `rank` for admission. | 287 of the 738 closed rows with recorded rank had rank=100 in this export. Tests distinguish equal gate scores using the raw score. |
| Zero became 50, and missing phase/completion could earn bonuses. | Missing/invalid rank and true zero have zero priority; dynamic scoring no longer independently rewards missing technical inputs. | Numeric-string, zero, null, nonfinite and fully populated technical fixtures. |
| Positive tilts could lift stale candidates above their freshness cap. | Enforce freshness after overlays and place quarantined candidates behind fresh candidates. Clear an obsolete cap marker after recovery. | Stale, recovered and diagnostic-only replay freshness fixtures. |
| Cron scored before config injection and freshness reconciliation. | Score after both, before entry classification; persist ranking changes even when other payload deltas are small. | Current configured formula is used in the scoring cron; both formulas preserve raw and final scores. |
| Cached/full/D1 responses could reuse different ranking orders. | Full micro-cache, full snapshot and D1 paths use `stampCandidatePositions`; ties resolve by symbol. | Cached-score and reversed-insertion-order tests. Slim responses remain identity/price payloads. |
| The cron attempted entries in ticker-list order. | Gather the existing actionable set, manage existing positions first, then attempt entries sequentially by candidate priority. | Capacity fixture: a management exit frees one slot; a blocked higher-score candidate is rejected; the next highest eligible candidate receives the slot. No new top-N filter. |
| New rank explanations could expose proprietary scores. | Redact `_technical_rank`, `_ranking`, candidate order and rank trace with the existing score entitlement policy. | Member/anonymous redaction test; Pro/Admin access preserved. |
| Candidate ordering was not retained at entry. | Attach score/position/cohort size to the existing entry rank trace. | `__candidate_order` is included in `rankTraceJson`. |

Runtime scope: the shared discovery score and the scheduled cron's actionable
candidate batch. Admission policy, risk limits, position sizing, trade exits,
broker submission and independent replay selectors are not redesigned here.

## Chronological evidence — no profitability claim

Source: read-only public `/timed/ledger/trades?limit=1000` export from
`timed-trading-ingest.shashant.workers.dev`, retrieved 2026-09-09, 778 rows,
`hasMore=false`.

SHA-256: `4c9b66f047dbd5550891b60bb1e73ed430a681b0262463c60227fbb9550cf3f9`.

Trial 2 is the frozen setup-aware challenger, `outcome-rank-v2-setup`.
It uses side, canonical setup, R:R band and legacy-rank band. No ticker,
post-entry grade, MFE, trim or exit attributes enter a prediction. At each
entry it fits only valid unique trades with `exit_ts < entry_ts`, using a
180-day history, 60-day half-life, 20 prior-weight units, minimum 30 trades,
clipped ±10% returns, and an assumed 10 bps round-trip cost. Its uncertainty
penalty is a heuristic, not a statistical confidence bound.

Within each calendar week with at least three eligible closed trades, select
the same number (top third, rounded up) under either score. Dollar totals
retain the recorded trades' exits and notionals. This is a diagnostic on
already selected trades arriving at different times, not a portfolio replay.

| Window / metric | Legacy rank | Setup-aware challenger |
| --- | ---: | ---: |
| Development: May 1–July 31; selected trades | 28 | 28 |
| Development: recorded P&L | -$1,905.04 | -$1,696.05 |
| Development: mean trade return | -1.0065% | -1.4589% |
| Holdout: August 1–export; selected trades | 23 | 23 |
| Holdout: recorded P&L | -$354.34 | -$201.35 |
| Holdout: P&L less assumed cost | -$411.38 | -$247.88 |
| Holdout: gross profit factor | 0.2627 | 0.5018 |
| Holdout: mean trade return | -0.7417% | -0.1612% |
| Holdout: recorded P&L without best winner | -$396.93 | -$281.73 |
| Holdout: score/return correlation, all 65 scored trades | +0.0460 | +0.0171 |

Decision: **do not activate the outcome challenger**. Both selections lose
money; development mean returns worsened and holdout score/return correlation
did not improve. The smaller holdout loss is insufficient to establish an
edge. After these two development trials there is no further parameter search.
The outcome module has no runtime import and cannot alter live ranks.

Material limits: selected-book bias; open trades censored at export; historical
config versions; no market-bar quality validation; and ledger R:R may have
been recomputed after stop selection. Mean trade return is a unit-capital
diagnostic, not account return. The mechanics correction has no measured P&L
lift yet; its verification establishes correct ordering, not profitable picks.

Reproduce with the matching complete export (verify SHA before comparing):

```sh
node scripts/evaluate-outcome-rank.mjs ledger.json 2026-05-01 2026-08-01
node scripts/evaluate-outcome-rank.mjs ledger.json 2026-08-01 2026-09-10
npm test -- --maxWorkers=2
node scripts/check-scoring-version-bump.mjs --base origin/main
node scripts/embed-dashboard.js
npx esbuild worker/index.js --bundle --format=esm --outfile=/dev/null
```

## Verification and release boundary

Rebased onto `52c36027c30bd9d78c4cf475324de599e6bbdfa7` (main, PR #1441).
Ranking regression coverage includes 15 new candidate/calibration tests and
one access-control test. Worker bundle, worker/API/bridge/Pages syntax checks,
and the scoring-version guard pass. The bundler reports the pre-existing
duplicate `KWEB` key in `sector-mapping.js`; that file is unchanged.

The corrected order can change which entries receive scarce capacity. The
cron also now honors `deep_audit_rank_formula` from current config, so confirm
that configured formula when reviewing a deployment. This branch changes no
live config or ledger and performs no deploy/merge. To measure P&L impact,
use complete contemporaneous candidate snapshots with the shared comparator
and the same admission/capacity/execution rules; the public closed-trade export
cannot supply that counterfactual. Rollback is a revert of this ranking PR.
