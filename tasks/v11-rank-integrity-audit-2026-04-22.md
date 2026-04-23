# V11 Rank Integrity Audit — Stage 0 of the Analysis Pipeline

**Status:** PLANNING (addition to v11-analysis-pipeline)  
**Date:** 2026-04-22  
**Prerequisite for:** IDENTIFY stage results to be trustworthy.

---

## Why this matters (and why the original plan missed it)

The original pipeline plan starts at univariate signal lift. But it
assumes the signals we're measuring are **computed correctly**. For
computeRank specifically we've never audited:

1. Whether each component signal (htf_score, ltf_score, tf_summary.score,
   trigger_summary.score, move_status, rsi_divergence, phase_divergence,
   atr_disp, ripster_clouds alignment, etc.) is computed consistently
   with its own spec.
2. Whether the composite signals upstream of computeRank are
   self-consistent (e.g., `htf_score > 25` should correlate with the
   multi-TF state being HTF_BULL_*).
3. Whether the final rank number returned actually equals the sum of
   the component deltas stored in `__rank_trace`.
4. Whether the rank we SEE on a trade row (persisted in `trades.rank`)
   matches the rank the entry pipeline actually USED to gate the entry.

Until we verify these, "rank has zero correlation with outcomes"
could mean any of three different things:
- The weights are wrong. (tune them)
- The components are broken. (fix them)
- The persistence/reading path is broken. (fix plumbing)

Stage 0 tells us which. Then the identify/translate/apply stages work
on a trusted foundation.

---

## What Stage 0 does

### 0.1 Component-level integrity tests

For each component that feeds computeRank, write a small Python test
that takes raw tickerData (from `signal_snapshot_json` we now persist)
and recomputes the component independently. Compare to the stored
value in the snapshot.

Components to audit:
- `htf_score`, `ltf_score` — aggregations of tf_tech bundles
- `tf_summary.score` — tfTechAlignmentSummary output
- `trigger_summary.score` — triggerSummaryAndScore output
- `completion` — completionForSize output
- `phase_pct` — derived from saty/phase indicators
- `rr` — (tp - entry) / (entry - sl), direction-aware
- `move_status.status` — computeMoveStatus output
- `rsi_divergence` — presence/strength by TF
- `phase_divergence` — same
- `atr_disp` — daily/weekly/monthly displacement signals
- `data_completeness.score` — computeDataCompleteness output

**Method:**
Take ~50 random trades' `signal_snapshot_json`, re-derive each
component from the raw sub-signals (tf arrays, ripster, phase values),
compare against the stored value. Flag any delta > 5%.

Output: `stage-0/component-integrity.csv` with columns per component,
count of agreements vs disagreements, distribution of deltas.

### 0.2 Composite self-consistency tests

Verify relationships that SHOULD hold:

| Relationship | Test |
|---|---|
| state="HTF_BULL_LTF_BULL" → htf_score > 0 AND ltf_score > 0 | Flag violations |
| tf_summary.score == Σ(per-TF alignment scores) | Sum check |
| trigger_summary.score == Σ(active trigger values) | Sum check |
| move_status="INVALIDATED" → specific failure reason present | Flag |
| rank == Σ(rank_trace.parts[].delta) + base | Only if rank_trace captured |

Output: `stage-0/composite-consistency.txt` — list of violation cases
(ticker, ts, field A value, field B value, expected relationship).

### 0.3 Rank formula replay

Re-implement `computeRank` in Python using the same inputs that were
fed to the worker (from `signal_snapshot_json`). For a sample of 100
trades, verify:

- Python rank = stored `trades.rank` (±1 for rounding)

If they disagree systematically, the persistence or the scoring path
has a bug. We find it before tuning weights.

### 0.4 Rank-trace coverage audit

We have `shouldTraceRankBreakdown` for 4 hardcoded (ticker, ts) pairs.
That's 4 rank_traces total. Not enough for this audit.

Option: in the worker, enable rank-trace for ANY entry that enters a
trade (not just the hardcoded 4). Store the trace in the trade record
(new `rank_trace_json` column). Makes the stage-0 audit self-serving:
every V11 trade has its own breakdown attached.

**Code change:** in `worker/replay-candle-batches.js` right before
trade creation, set `result.__rank_trace_force = true` and ensure
`computeRank` emits the trace into `result.__rank_trace` when that
flag is present. Persist via `d1UpsertTrade`.

Weight: ~1-2 KB per trade × 500-800 trades = 1-2 MB for the full V11.
Negligible (vs the ~900 MB we just reclaimed).

### 0.5 Rank-vs-weight-rebuild

Once 0.1-0.4 pass, run a controlled experiment:

For each rank_trace we capture:
- Record the component deltas
- For each trade outcome (win/loss), correlate each delta individually
  with outcome
- Do univariate regression and then multivariate with all deltas as features

Compare against the hand-tuned weights in the existing formula.
Output a **weight correction table**: current weight, data-implied weight,
suggested new weight, confidence interval.

This is the **honest, data-backed rank-V2 recalibration** that
rank-V2's first attempt failed at (because we calibrated on a biased
sample).

---

## What we commit to BEFORE tuning anything

1. Every component computes what it says it computes (0.1)
2. Composite signals agree with their sub-components (0.2)
3. The stored rank matches the formula output for a given input (0.3)
4. Every V11 trade carries its own rank_trace for later analysis (0.4)
5. The weight corrections come from the trace data, not from outputs-vs-outcomes (0.5)

Only then do we proceed to IDENTIFY → TRANSLATE → APPLY.

---

## Implementation order

1. **Right now (while V11 runs):** add the `rank_trace_force` code
   change so EVERY V11 trade gets its trace. This is a 20-line diff:
   - `shouldTraceRankBreakdown` gets a new branch: if
     `d.__rank_trace_force` is true, return true.
   - `replay-candle-batches.js` sets the flag on a ticker that's
     about to enter.
   - `d1UpsertTrade` persists `trade.rank_trace_json` to a new column.
   - Schema migration adds `rank_trace_json TEXT` to trades +
     backtest_run_trades.

2. **After V11 completes:**
   - Run 0.1 (component integrity) — ~30 min of Python
   - Run 0.2 (composite consistency) — ~15 min
   - Run 0.3 (rank formula replay) — ~30 min (includes re-implementing
     computeRank in Python, which is also useful for future local testing)
   - Run 0.4 audit — ~15 min (just queries the captured traces)
   - Run 0.5 weight correction — ~1 hour of analysis

3. **Then** proceed to IDENTIFY (§3 in the pipeline plan).

---

## Honest limitations

- Re-implementing computeRank in Python is a maintenance burden
  (two sources of truth). We'll accept that for now; the Python
  version lives in `scripts/rank-reference-impl.py` and is version-
  stamped against the JS source. It's NOT executed in production —
  only used for audit.

- Per-component integrity tests have thresholds that are judgment
  calls (e.g., "flag deltas > 5%"). We'll document these.

- We're still vulnerable to bugs in the SNAPSHOT capture — if
  signal_snapshot_json doesn't accurately reflect what the pipeline
  saw at entry time, the audit is measuring the wrong thing. Mitigate
  by cross-checking against raw tf_tech fields where they're
  preserved.

---

## Deliverables

At the end of Stage 0:

- [ ] `scripts/rank-reference-impl.py` — Python port of computeRank
- [ ] `scripts/v11-stage-0-audit.py` — runs all 5 checks, outputs reports
- [ ] `tasks/v11-findings/stage-0/component-integrity.csv`
- [ ] `tasks/v11-findings/stage-0/composite-consistency.txt`
- [ ] `tasks/v11-findings/stage-0/rank-replay-mismatches.csv`
- [ ] `tasks/v11-findings/stage-0/weight-corrections.csv`
- [ ] Summary doc: "for each component, is it correct? for each
      weight, is it properly tuned?"

Only after we have these do we start tuning.

---

## Why this matters for the golden master

You asked: "will the rank accuracy check come from this run?"

Answer: **partially, but not enough.** The run gives us the outcomes
to correlate against. But without Stage 0, a "rank has low correlation"
finding leaves us guessing whether to fix weights, fix components, or
fix plumbing. Stage 0 eliminates that guesswork.

For the golden master we're promoting to live, we owe it to the
system to know the rank formula is internally correct before we trust
its outputs. Stage 0 is that check.
