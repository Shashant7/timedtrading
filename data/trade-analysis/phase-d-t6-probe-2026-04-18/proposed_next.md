# Proposed next step — unentered-candidates analyzer

Follow-up to `finding.md`. The Phase-C → T6 sequence failed because the
diagnostic input was an aggregated `blockReasons` counter, not an ordered
block chain. Before running another single-gate DA-key experiment, build
the analyzer that would have surfaced T6's futility *before* deploying.

## Scope

Extend the Phase-C per-slice artifacts with an "unentered candidates"
analyzer that produces, for every rejected bar:

```json
{
  "ticker": "SPY",
  "ts": 1752082500000,
  "datetime": "2025-07-09T18:15:00Z",
  "stage": "in_review",
  "score": 100,
  "block_reason": "tt_no_trigger",
  "block_chain": ["tt_bias_ok", "tt_trigger_missing"],
  "next_gate_if_relaxed": "tt_pullback_5_12_not_reclaimed",
  "kanban_stage": "in_review",
  "state": "HTF_BULL_LTF_BULL",
  "session_minute": 390
}
```

Key property: `next_gate_if_relaxed` answers "if we relaxed
`block_reason`, what would fire next?" — the question the Phase-C counter
couldn't answer.

Emit as `data/trade-analysis/<run_id>/block_chain.jsonl` (one line per
rejected bar) plus a summary in `report.md`:

- Top-5 block reasons per ticker cohort (Tier-1 ETFs / Tier-1 large-caps /
  Tier-2 stocks).
- For each top block reason, the top-5 `next_gate_if_relaxed` distribution.
- Total bars that would survive to trade if the top-5 gates were each
  relaxed in isolation, and — more importantly — combinations of two or
  three gates.

## Implementation options

### Option A — Worker-side instrumentation (invasive)

Add a `blockChainTrace: true` query param to `candle-replay` that
causes the entry pipeline to emit the full ordered block chain per bar
to the response. Preserve the top-line `blockReasons` counter for
backward compatibility.

Cost: 5–10 points of worker code changes (entry pipeline runs ~100 gates
in sequence; need to thread a trace collector through). Risk:
performance (the pipeline fast-paths on early rejection today; a
`trace-all` mode has to run every gate). Benefit: authoritative chain.

### Option B — Replay-side synthesis (lighter, probabilistic)

Keep the worker as-is; build `scripts/analyze-block-chain.js` that
replays the 5-minute interval data offline (reading
`ticker_intervals` from D1) and evaluates the entry gate chain in pure
JS using the same thresholds as the worker. Slow (~few minutes per
ticker-month) but reproducible and doesn't touch worker code.

Cost: ~15–20 points of JS porting from `worker/pipeline/tt-core-entry.js`
gate-by-gate. Risk: drift — the offline evaluator must stay in sync with
the worker. Benefit: zero production impact, arbitrary what-if analysis.

### Option C — Hybrid: targeted `blockReasons` expansion (cheap, partial)

Accept a truncated block chain. Add a minimal trace to the worker that
records, for each rejected bar, the **gate index at which it was
rejected** (0=bias, 1=trigger, 2=depth, 3=rank, 4+=structure/RSI). Emit
as `blockReasonIndex` alongside the existing counter. Then `report.md`
can compute "if we relax gate N, distribution of where those bars go
next" from the replay by re-running with that gate overridden and
diff'ing the histograms.

Cost: ~2 points of worker code. Risk: tiny. Benefit: answers the core
"redistribution" question without porting the full gate chain.

## Recommendation

**Option C**, then iterate to Option A if needed. The Phase-D T6
misdiagnosis cost ~1 run, not 10 — the analyzer doesn't have to be
perfect to prevent the next misdiagnosis, it just has to surface the
redistribution question.

Specifically:

1. Add a `blockReasonIndex` field to the `candle-replay` response, one
   per rejected bar, pointing at the gate's position in the chain (0–N).
2. Add a one-shot replay comparison script
   `scripts/compare-block-chains.js` that runs the same month twice
   (default vs proposed DA-key change) and emits a matrix of
   `(block_reason_old, block_reason_new)` transitions.
3. When a DA-key proposal is made, run the comparison first; accept only
   if the proposal moves ≥ 50 % of the currently-rejected bars into
   `block_reason_new == null` (i.e. pass all gates) or into a
   still-acceptable downstream gate.

## Exit criteria for this diagnostic

This doc is closed when:

1. The `phase-d/unentered-candidates-analyzer-*` branch lands Option C
   (+ `compare-block-chains.js`) and is merged.
2. The re-evaluation of the ETF question produces a **specific** gate
   chain proposal (not a single DA key) grounded in the analyzer's
   output.
3. That proposal passes the full-coverage replay on all 10 training
   months per the plan's anti-overfit budget (WR regression ≤ 2 pp, PnL
   regression ≤ 10 % per month).

Until then, ETFs stay under the Phase-A base config — no new ETF-scoped
DA keys are activated in `model_config`.
