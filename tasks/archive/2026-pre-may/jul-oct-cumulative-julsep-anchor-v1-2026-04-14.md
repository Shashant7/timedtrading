# Jul-Oct Cumulative - 2026-04-14 - Jul-Sep Anchor v1

## Lane

- Label: `jul-oct-cumulative-julsep-anchor-v1`
- Artifact bundle:
  `data/backtest-artifacts/focused-jul-oct-cumulative-julsep-anchor-v1--20260413-233052`
- Run id:
  `focused_replay_20260413-233052@2026-04-14T06:30:56.359Z`
- Git SHA:
  `d2e6f343ac0615b6ed4a9999fb609469f74076ac`
- Config artifact:
  `data/backtest-artifacts/july-equalscope-deterministic-parity-v1-config-20260410.json`
- Dataset manifest:
  `data/replay-datasets/july-october-2025-equalscope-focused/manifest.json`
- Interval: `5m`
- Window: `2025-07-01` -> `2025-10-31`
- Tickers:
  `XLY, PH, GRNY, MTZ, ETN, SWK, RIOT, ON, IESC, FIX, AGQ, SGI, CDNS, HUBS, ABT, KWEB`

## Headline Summary

- Total trades: `79`
- Wins / losses / flats: `52 / 26 / 1`
- Closed PnL: `+$7,265.78`

Reference cumulative checkpoint:

- `tasks/jul-sep-cumulative-julaug-anchor-v3-livefix-2026-04-14.md`
- headline `Jul -> Sep` PnL: `+$7,366.83`

Net cumulative delta after adding October:

- `Jul -> Sep`: `+$7,366.83`
- `Jul -> Oct`: `+$7,265.78`
- widening delta: about `-$101.05`

## Gate Result

This lane completed cleanly, but it does **not** pass the month-compounding
gate.

Reason:

- October isolation was positive on its own (`+$443.58`)
- but the October slice inside the cumulative lane turned negative (`-$107.04`)
- therefore October does **not** compose cleanly on top of the accepted
  `Jul -> Sep` checkpoint

Under the current operating model, this is the point where widening stops and
month-specific refinement begins.

## October Composition Check

Reference isolation lane:

- `tasks/october-isolation-julsep-anchor-v1-2026-04-14.md`
- isolation headline: `14` trades, `7 / 7`, `+$443.58`

Cumulative October slice (`2025-10-01` -> `2025-10-31`):

- `18` trades, `10 / 8`, `-$107.04`

Interpretation:

- October did not just weaken a little; it flipped from positive isolation to
  negative cumulative composition.
- The blocker is not broad basket collapse. It is concentrated in a few names
  whose October behavior becomes materially worse once the prior months are
  carried forward.

## Blocker Classification

### 1. Primary blocker: `RIOT`

Isolation:

- `3` trades
- net `+$96.65`
- included a large `2025-10-01` winner:
  `RIOT-1759345200000`, `+$508.71`, exit `sl_breached`

Cumulative October slice:

- `2` trades
- net `-$440.46`
- the `2025-10-01` winner disappears entirely
- the two surviving losses worsen:
  - `RIOT-1760550000000`: `-202.42` -> `-216.32`
  - `RIOT-1761058200000`: `-209.64` -> `-224.14`

Classification:

- `ticker-specific`
- `composition blocker`
- first refinement candidate

Why first:

- largest net October degradation versus isolation
- not just lifecycle noise; one important winner is absent and the two losses
  that remain both get worse

Focused diagnostic result:

- fresh `RIOT`-only October replay reproduces the expected three-trade October
  shape, including the `2025-10-01` winner
- `RIOT`-only `Jul -> Oct` carryforward replay already shows
  `2025-10-01: trades=0`

Interpretation:

- the missing `RIOT` winner is **not** caused by cross-ticker basket
  competition
- the drift is already present in ticker-local carryforward state across the
  widened window
- the concrete suppressor is a prior `RIOT` winner carried from
  `2025-09-26` through `2025-10-09`
  (`RIOT-1758904200000`, `sl_breached`), which occupies the ticker during the
  `2025-10-01` opportunity window and prevents the October isolation winner from
  opening
- versus the accepted `Jul -> Sep` checkpoint, this is an actual lifecycle
  mutation on the same trade id:
  - `Jul -> Sep`: forced close on `2025-09-30`, `trimmed_pct=0.5`,
    `exit_reason=replay_end_close`, `+$281.60`
  - `Jul -> Oct`: extends to `2025-10-09`, `trimmed_pct=0.9`,
    `exit_reason=sl_breached`, `+$472.73`
- that extension improves the September trade itself, but it suppresses the
  separate October `RIOT-1759345200000` winner that isolation was able to open
- the worsened October `RIOT` losses are partly sizing/state effects as well:
  they keep the same entry/exit prices between isolation and cumulative but
  realize worse PnL in the widened lane

### 2. Secondary blocker: `MTZ`

Isolation:

- `3` trades
- net `-$22.25`

Cumulative October slice:

- `4` trades
- net `-$266.03`

Key cumulative-only damage:

- isolation late-month branch:
  `MTZ-1761676800000`, `-11.48`, `PRE_EARNINGS_FORCE_EXIT`
- cumulative introduces a different large late-month loser:
  `MTZ-1761831000000`, `-326.42`, `replay_end_close`

Classification:

- `ticker-specific`
- secondary refinement candidate after `RIOT`

Why not first:

- very large deterioration, but smaller total damage than `RIOT`
- the pattern looks more like a late-month branch substitution plus end-window
  hold behavior than a broad October identity shift

### 3. Tertiary blocker / monitor: `ON`

Isolation:

- `1` loss, `-$121.39`

Cumulative:

- same trade family remains
- worsens only modestly to `-$129.78`

Classification:

- `ticker-specific`
- real October watch item, but not the main reason cumulative widening failed

### 4. Improvement / non-blockers

- `IESC` improves materially at the month level (`-$98.11` isolation -> `-$19.60`
  cumulative) despite extra trades
- `AGQ`, `FIX`, and `GRNY` all remain net positive and do not justify direct work

## Decision

- Freeze this lane as the failed October composition gate.
- Do not widen to November yet.
- Start October-specific refinement from `RIOT`.
- Keep `MTZ` as the second targeted branch once `RIOT` is understood.

## Next Step

Run focused October `RIOT` forensics to explain:

- why the prior `RIOT-1758904200000` lifecycle remains open through
  `2025-10-09` and suppresses the isolation winner `RIOT-1759345200000`
- why the two October `RIOT` losers degrade further in the cumulative lane

Only after the `RIOT` branch is understood should we decide whether October
needs just one targeted fix or a second follow-up pass on `MTZ`.

## Diagnostic Note

Two narrow exit-side experiments were tested against focused `RIOT` carryforward
replays after this gate was written:

- a trimmed-runner recycle variant
- an earlier untrimmed stale/winner recycle variant

Outcome:

- neither restored the missing `2025-10-01` `RIOT` trade
- replay logs did not emit the expected `RUNNER_STALE_FORCE_CLOSE` or
  `STALL_FORCE_CLOSE` evidence before the blocked window
- the speculative worker changes were reverted rather than carried forward

Proof gathered after the revert:

- focused replay artifacts now capture per-day replay payloads
- `2025-10-01` day payload from
  `focused-sep-oct-riot-window-diagnostic-v6-daydebug--20260414-124501`
  shows:
  - `tradesCreated=0`
  - `storedStage=in_review`
  - recomputed execution `stage=trim`
  - `openTrade=true`
  - `openTradeId=RIOT-1758904200000`
- this proves the October branch is not failing a normal entry-quality gate on
  that bar; the ticker is being routed into management mode because the prior
  `RIOT` position is still active
- richer replay tracing from
  `focused-sep-oct-riot-window-diagnostic-v7-runnertrace--20260414-131110`
  shows the carried trade is being intentionally held by
  `evaluateRunnerExit()`:
  - early `2025-10-01`: repeated `action=hold`, `reason=compression_active`
  - later `2025-10-01`: repeated `action=hold`, `reason=no_exit_signal`
  - throughout that sequence the runner remains half-trimmed
    (`trimmedPct=0.5`), still strongly profitable (`~+8%` to `+10%` current
    leg PnL), and repeatedly below the 15m `5/12` cloud hard threshold
    (`c512Hard=true`, `c512Count` climbing)

Additional narrowing proof:

- current-runtime one-day isolation
  `focused-riot-oct01-isolation-current-runtime-v1--20260414-153108`
  still opens the expected `RIOT-1759345200000` branch on `2025-10-01`
  (`tradesCreated=1`, entry `18.755`, replay-end close because the lane ends
  the same day)
- restored narrow carry window
  `focused-riot-carry-window-sep26-oct01-v1--20260414-153524`
  reproduces the suppression with the pinned 144-key config:
  - `2025-09-26`: opens a prior `RIOT` winner
    (`RIOT-1758916200000`, path `tt_momentum`)
  - `2025-10-01`: `tradesCreated=0`, `totalTrades=1`
  - the day payload no longer reaches `in_review`; it stays in `setup`
    with score `87` instead of the isolation score `100`
  - the active `2025-09-26` trade is still being managed through
    repeated smart-runner `compression_active` holds on `2025-10-01`
- this sharpens the blocker classification:
  - local October logic is still capable of opening the winner in isolation
  - the widened lane failure is specifically carry-state dependent
  - after the carry trade remains alive, the `2025-10-01` opportunity is
    degraded before entry review rather than merely blocked at the final
    open-position gate

Failed refinement note:

- a speculative `compression_active` exit override was tested after the
  runner-trace proof
- it produced broader replay drift, including a zero-trade RIOT carry lane in
  `focused-sep-oct-riot-window-diagnostic-v9-compressionfix2--20260414-151248`
- that behavior change was reverted; only the diagnostic instrumentation and
  per-day replay payload capture were retained

Validated root cause correction:

- the apparent `2025-10-01` score/stage drift was caused by replay stage
  classification, not by a real carry-dependent entry-rank mutation
- `classifyKanbanStage()` only treated `status === "OPEN"` as position-backed
  management, but replay runners often remain open with status `TP_HIT_TRIM`
- that let a still-open RIOT runner fall back into discovery scoring on
  `2025-10-01`, producing the misleading `87/setup` +
  `tt_pullback_non_prime_rank_selective` artifact while the same trade was
  simultaneously being managed by `processTradeSimulation()`
- after changing `classifyKanbanStage()` to respect `isOpenTradeStatus()`,
  the focused carry replay
  `focused-riot-carry-window-sep26-oct01-stagefix-v1--20260414-185445`
  revalidated the lane with:
  - `2025-10-01 tradesCreated=0`, `totalTrades=1`
  - `stageCounts={trim:29, defend:50}`
  - `blockReasons={}` and `blockedEntryGates={}`
  - last snapshot `kanban_stage="trim"` instead of `setup`
- this proves the prior selectivity drift was a replay classification bug;
  the remaining October composition issue is the still-open `9/26` RIOT runner
  itself, not a degraded `10/01` entry candidate

Updated next move:

- keep the replay stage-classification fix in place as the corrected baseline
- stop using the prior `87/setup` selectivity artifact as the blocker model for
  October
- resume October refinement from the true remaining seam: why the `9/26` RIOT
  runner legitimately stays alive through `10/01` under current lifecycle
  policy, and whether that policy should be narrowed for composition safety
- keep the diagnostic replay payload capture and runner tracing in place, but
  avoid speculative smart-runner behavior changes until the intended lifecycle
  release condition is explicitly defined
