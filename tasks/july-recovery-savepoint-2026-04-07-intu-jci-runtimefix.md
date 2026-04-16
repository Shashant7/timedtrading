# July Recovery Save Point — 2026-04-07 — INTU/JCI Runtime Fix

## Save Point

- Label: `intu-jci-runtimefix`
- Run ID: `focused_replay_20260407-005334@2026-04-07T04:53:37.324Z`
- Artifact bundle: `data/backtest-artifacts/focused-intu-jci-proof-v4-runtimefix--20260407-005334`
- Config: `data/backtest-artifacts/focused-grny-july-telemetry-firsttrim-gate-v6-stall-shield-loosened--20260405-193111/model-config.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-07-03`
- Tickers: `INTU, JCI`

## Why This Save Point Matters

This is the first proof lane that cleanly resolves both of the user-identified July issues from the first full-run basket without introducing a new focused-lane regression:

- `INTU-1751388300000` is now blocked.
- `JCI-1751388300000` no longer exits via `doa_early_exit`.

The value of this save point is not just the outcome, but the fact that the runtime root causes were traced directly from deployed worker logs instead of inferred from archived snapshots.

## Runtime Root Cause Frozen Here

### `INTU`

- The bad Jul 1 `INTU` pullback was not slipping through because of a hidden EMA-cross path.
- Direct worker trace showed:
  - `pullbackTrigger=true`
  - `reclaimTrigger=false`
  - `hasStFlipBull=false`
  - `hasEmaCrossBull=false`
  - `hasSqRelease=true`
- The existing reject was too lenient because a bare squeeze release was being treated as enough bullish confirmation even while `15m/30m/1H` structure remained counter-trend.

### `JCI`

- The bad Jul 1 `JCI` loss was not mainly a missing higher-TF-support exemption.
- Direct worker trace showed two DOA evaluations for the same open trade:
  - one path saw the real `mfePct` (`0.462`)
  - another path still saw `mfePct=0`
- The stale-zero path came from replay management using a stripped `openPositionContext` that did not always carry `maxFavorableExcursion`.
- That stale branch could still win and emit `doa_early_exit` even when the trade had already proven it was not truly dead-on-arrival.

## Logic Confirmed Present

These refinements are the validated core of this save point:

- In `worker/pipeline/tt-core-entry.js`, the speculative long counter-LTF pullback reject now requires structural reclaim signals (`ST` flip or 5/12 reclaim confirmation) instead of standing down for a bare squeeze release.
- In `worker/index.js`, replay `openPositionContext` now carries the open trade's:
  - `maxFavorableExcursion`
  - `maxAdverseExcursion`
  - `trimmedPct`
  - `shares`
  - `__tradeRef`
- The live DOA check now resolves MFE from both the position shell and the trade back-reference so replay/live management passes do not disagree about whether the trade ever reached the MFE floor.

## Evidence

- Run trades: `2`
- Closed trades: `0`
- Closed losses: `0`
- Archived trades: `2`
- Archived config rows: `143`

### Trade-Level Result

- `INTU-1751388300000`
  - removed from the run
- `JCI-1751388300000`
  - remains open
  - about `+1.67%` at artifact capture
  - no `doa_early_exit`

Remaining open trades in this proof lane:

- `INTU-1751480100000`
- `JCI-1751388300000`

## Files Changed For This Save Point

- `worker/pipeline/tt-core-entry.js`
- `worker/index.js`
- `tasks/todo.md`
- `tasks/lessons.md`
- `tasks/july-recovery-iteration-log.md`

## Guardrails For The Next Step

- Treat this as a validated focused refinement, not yet a promoted full-lane result.
- Preserve the exact runtime fixes above when launching the next broader July or Jul→Apr validation lane.
- If the next broader lane regresses elsewhere, compare against this save point before altering these two fixes again.
- If `JCI` resurfaces with a DOA-style exit in a broader run, inspect whether a non-replay/live path is still bypassing the canonical MFE source.

## Recommended Next Action

Launch one authoritative Jul 1 -> Apr 3 backtest on the pinned v6 config with these refinements deployed, then diff the early-July basket against the prior candidate lane before widening the patch scope again.
