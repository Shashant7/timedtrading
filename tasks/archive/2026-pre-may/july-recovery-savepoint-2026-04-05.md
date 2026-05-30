# July Recovery Save Point — 2026-04-05

## Save Point

- Label: `july-core-iter1-entrytrim`
- Run ID: `focused_replay_20260405-021006@2026-04-05T06:10:07.510Z`
- Artifact bundle: `data/backtest-artifacts/focused-july-core-iter1-entrytrim--20260405-021006`
- Git SHA: `422b606d85178c2b862b3606ebd4457462ff32d3`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-08-05`
- Tickers: `UNP, INTU, SANM, RIOT, B, ORCL, GRNY`

## Why This Is A Save Point

This is the first recovered July-focused lane that restored the intended "hold and let the move develop" behavior strongly enough to produce the large `RIOT` runner again while still keeping the rest of the lane analyzable.

This save point should be treated as the base branch of the current recovery effort, not as a final promotion candidate.

## Evidence

- Closed trades: `22`
- Wins: `16`
- Losses: `6`
- Win rate: `72.73%`
- Realized PnL: `$1,943.00`
- Archived trades: `29`
- Archived config rows: `144`

## Logic Confirmed Present

These behaviors are part of the working baseline and must be preserved unless a later iteration proves a materially better result:

- Runner-hold / move-development behavior is restored enough to recover the large `RIOT` winner shape.
- `execState` position-scoped fields are reset on new entries so same-ticker trade state does not leak across replay trades.
- `TD exhaustion` runner deferral support is wired in the worker.
- `PHASE_LEAVE` runner trail uses the configurable ATR multiplier path.
- Early completion trims require real profit (`deep_audit_completion_trim_min_pnl_pct`) instead of allowing cosmetic trims on flat trades.
- Lower-timeframe bearish-bias conflict guard is enabled in config for speculative bull-side TT entries.
- Trade Autopsy replay timestamps now prefer lifecycle history events when available, so live replay timestamps are less likely to drift from actual execution events.
- Soft-fuse fresh-entry grace is now respected instead of allowing an immediate "entered then exited" soft-fuse path to bypass normal minimum-age behavior.

## Key Recovered Signal

- `RIOT` regained the high-value runner behavior that the recovery was targeting.
- The user-confirmed target outcome was visible in Trade Autopsy: a `RIOT` winner around `$1,018`.

## Current Open Problems In This Save Point

These are the remaining high-confidence July issues still visible in the archived run and aligned with the manual notes:

- `UNP`
  - Still a loser.
  - Entered as a speculative momentum long with hot higher-timeframe context.
  - Trim happened almost immediately.
  - Action bucket: `avoid-entry` or `suppress-early-trim`.

- `INTU`
  - Still the clearest multi-trade pathology.
  - One loss entered with daily bearish RSI divergence and later exited as `PRE_PPI_RISK_REDUCTION`.
  - Another loss still shows the bad "quick trim then poor outcome" pattern.
  - Action bucket: `avoid-entry`, `suppress-early-trim`, `exit-earlier`.

- `ORCL`
  - Still has bearish lower-timeframe structure at entry in trades that should have been filtered.
  - One loser was an `sl_breached`; another decayed into `SMART_RUNNER_SUPPORT_BREAK_CLOUD`.
  - Action bucket: `avoid-entry`.

- `RIOT`
  - The large winner is back, but one bad `RIOT` loser still exists.
  - That loser remains a useful regression sentinel because it entered with opposed lower-timeframe structure and later hit `HARD_LOSS_CAP`.
  - Action bucket: `avoid-entry`.

- `SWK`
  - Not a loser in this specific run, but it remains an event-parity audit item because the original failure mode was earnings exposure.
  - Action bucket: `data/event-parity`.

- `HOOD`
  - Not in this focused ticker set.
  - Still remains a separate session-model / extended-hours parity audit item.
  - Action bucket: `data/session-parity`.

## Guardrails For Future Iterations

- Preserve the recovered `RIOT` runner behavior unless a new run shows a better July basket overall.
- Prefer small entry-quality patches before changing runner exits again.
- Avoid broad changes to trend-hold logic until the remaining bad entries are filtered more cleanly.
- Every new iteration must record:
  - exact files changed
  - short rationale
  - run ID
  - artifact path
  - summary outcome
  - whether `RIOT` large-runner behavior was preserved

## Next Patch Priority

1. Tighten bull-side entry rejection for trades that still enter with opposed `15m` and `30m` structure in `HTF_BULL_*` states.
2. Add a divergence-aware bull-side reject for momentum/pullback entries where adverse daily divergence is already present and lower-timeframe confirmation is weak.
3. Re-run July-focused validation and compare against this save point before touching event/session parity work.
