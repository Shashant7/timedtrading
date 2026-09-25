# Current Tasks

> **Workflow:** Plan first → commit before testing → push every iteration →
> open/update the PR → update lessons after any user correction.
> See [AGENTS.md](../AGENTS.md) for the full onboarding.
>
> **Skills first:** Before inventing a new method, check [`../skills/`](../skills/).
> If you do something new that's reusable, write a skill before exiting.

---

## Completed programs (do not reopen)

- **Jul→Apr recovery (2025-07 → 2026-04)** — Backtest validation and
  promotion to live are **done**. Historical plans live in
  [`archive/2026-pre-may/`](archive/2026-pre-may/README.md). Only start a
  new replay lane if you intentionally define a fresh contract in this file.

---

## Open work — Mission Control + Today + UX polish

### Active
## Active — Conviction-aware management for Short Term (2026-09-25)

Prime trades held to their structural stop and trailed wider
(`worker/conviction-management.js`, all `deep_audit_conviction_*`, default
OFF). Replay first: two live cases (P, INTC) cannot validate it.

- [x] Policy module + inline (`classifyKanbanStage`) and pipeline
      (`tt-core-exit`) wiring; grade carried onto live + replay positions
- [x] Unit tests; keys in `REPLAY_DA_KEYS`
- [x] Preprod: model_config synced to prod, candles to 2026-09-24
- [ ] Arms `cv-base-2026{07,08,09}` vs `cv-conv-2026{07,08,09}` (24 tickers,
      10m, batch 24); realized dollars + trade-set diff
- [ ] Decide enable / tune / drop; record the result

## Active — Broker mirroring buttoned up for scale (2026-09-24)

Design: `docs/entangled-mirror-design.md` (PR #1498). Operator decisions:
two lots, operator is an ordinary sleeve, market-equivalent orders
(Webull refuses MARKET on options), no native stops but verify stops at
the broker, new tables.

- [x] Short Term `reduce_pct` as fraction of remaining; exit ignores pct
- [x] `listConnectedUsers` paged; token refresh reaches every account
- [x] Suppressed manifest rows observed + released (27 frozen sleeves)
- [x] Investor trims get distinct client_order_ids
- [x] Equity fan-out no longer truncates trim ids into collisions
- [x] Day trades: two lots, follow paper size, partners inside own caps
- [x] Day trades: priced through the touch, booked at the fill
- [x] Kernel tables + model legs + per-account attempts + converge
- [ ] Watch the first live session: model_leg rows, both accounts'
      sleeves, converge verifying stops in both accounts
- [ ] Phase 2: retire the KV mirror / risk ledger for day trades once the
      kernel has run clean for five sessions
- [ ] Queue-based fan-out before accounts outgrow sequential converge
- [ ] Phase 3 — converge reconciler, sharded sweeps, load test at 2,000
- [ ] Phase 4 — Short Term + index-trend onto the kernel; retire manifest
- [ ] NVDA divergence (Roth 9.28 vs target 1; partner 1 vs 9.14) — needs
      an operator call, not a code change

## Active — Index DT entry timing review / profit-lock floor (2026-09-24)

- [x] Review the scoring → entry-trigger path for "we are a step behind"
- [x] Measure it instead of reading it: MFE/MAE per round from
      `timed:opt-dt-actions` joined to `option_marks`
      (`scripts/replay-dt-profit-lock.mjs`)
- [x] Finding: entries fire on time (first BUY at 09:45:43, the first second
      of the buy window) and 7/14 scored fills reached their own +50% 1R
      trim. The loss mechanism is the exit: 9/18 rounds died
      `breakeven_stop` at a median peak of +15.9%
- [x] Root cause: the peak profit lock (`+10%`/`+$0.08`) and the breakeven a
      1R trim earns had collapsed into the same `mid <= entry` rule
- [x] `profitLockFloor` = `max(hard stop, min(entry, 0.6 × peak))`; peak lock
      reports `profit_lock_stop`, earned breakeven stays `breakeven_stop`
- [x] Counterfactual on the real marks: 4/5 moved rounds better, net +155.5
      premium pts per contract across 14 scored rounds
- [ ] **Re-measure after a week live**: first position of the day per
      underlying+side reached +50% MFE in 5/5, re-entries in 2/9. Decide
      then whether a re-entry gate is warranted — do NOT hard-code one on
      two sessions, and the floor fix removes most of the cause
- [ ] Watch `profit_lock_stop` vs `breakeven_stop` counts in the action ring;
      if profit-lock stops are now the tail rather than the mode, it worked

## Active — Index DT stop-out not mirroring / IWM 279P (2026-09-24)

- [x] Root cause: bridge SELL guard rejected `no_held_position` — Webull
      option positions are combo rows, contract is on `legs[]`
      (`option_exercise_price`, not `strike_price`), so every position
      normalized to `strike:null, expiration:null, option_type:"CALL"`
- [x] `normalizeWebullOptionsPositions` flat-maps legs + synthesizes OCC symbol
- [x] Fail closed: unreadable right → `null` (never CALL); unlabelled combo
      leg → `direction_unknown`, skipped by `heldQtyForOption`
- [x] `reconcileIndexDtMirrorPositions` — reduces reconciled on QUANTITY
      (`targetMirrorRemaining`), so TRIM is first class alongside EXIT/STOP
      (RTH cron + `POST /timed/admin/index-dt/heal-closes` + COO lane)
- [x] `ctx.max_reduce_qty` caps Stage 5b so a partially-filled trim is not
      re-sold in full
- [x] Rejected reduce pages from `recordIndexDtMirrorDecision` (deduped per
      signal+event) + self-clearing `/timed/health.indexDtReduceUnmirrored`
- [x] Regression tests from the captured live Webull payload; `npm test` green
- [ ] Live IWM 279P + 280P are still long in the Roth (0/1 DTE) — they flatten
      on the first RTH reconcile tick after this merges and deploys, or
      immediately via `POST /timed/admin/index-dt/heal-closes`

### Active
## Active — Daily Brief miss / OOM catch-up (2026-09-24)

- [x] Root cause: tt-research `exceededMemory` at 13:01 UTC on morning slot
- [x] Brief-first hourly schedule + defer heavy arms on exact 9/17 ET
- [x] Same-day catch-up (morning→15 ET, evening→20 ET, flash +1h)
- [x] Manual morning 2026-09-24 generated (live)
- [ ] Commit, push, PR

### Active
## Active — Portfolio all lanes (2026-09-24)

- [x] Open-risk panes: Short Term + Long Term + Day Trade + Index Swings
- [x] History/activity: paper-lane actions + closed trades with Lane column
- [x] Worker `source=paper_history` from opt-dt / idx-trend action rings
- [x] Build frontend, test, commit, push, PR (#1491)

## Active — Broker UI scan refine (2026-09-24)

- [x] Broker Connections: account cards with labeled lanes + nested options detail
- [x] Mission Control Bridge: face-level options summary; Global Auto-Mirror near KPIs; clearer collapse titles
- [x] Build frontend + visual QA artifacts

## Active — Options account prefs alignment (2026-09-24)

- [x] Bridge `options_prefs.daily_loss_limit_usd` (default $500) on POST /bridge/user/options-prefs
- [x] Mission Control VehicleTogglesCard: account daily loss + vehicle enables; stop leading with daily_cap / max_loss_per_order
- [x] Broker Connections: user-editable daily loss limit per account
- [x] Roth: all option vehicles ON + $500/day; Partner Cash: long_call/long_put/LETF + $500/day (live KV applied)
- [x] Sync operator auto-mirror KV daily_loss_limit_usd + vehicles from Roth save (live KV applied)
- [ ] Options day-trade multi-account fan-out (deferred — mirror state is single-fill; Roth remains pickOptionsAccount)


- [x] **Eleven day trades, zero broker positions (2026-09-23).** Not
      "disabled" — the mirror fired twice. Two Webull limit buys went out 74 s
      apart at the open (13:46:23 QQQ 741P, 13:47:00 SPY 768P), both came back
      `working`, and both counted against the 2/day `long_put` cap, which is
      right. Neither filled, neither was re-read, neither was cancelled: the
      only thing that ever re-read a pending entry was a close event for the
      SAME signal id, and that signal stops producing events. Nine later
      entries died on `vehicle_daily_cap_2_reached_for_long_put`, and both
      buys were still live hours after the paper book exited at 14:08/14:09.
      Shipped: `resolvePendingIndexDtEntry` +
      `sweepPendingIndexDtEntries` (runs per PASS, not per event),
      `releaseEntryCounters`, EXIT/STOP cancel a working buy, and a new
      `POST /bridge/options/order/cancel`. Verified in production — the
      sweep resolved both stuck mirrors (`gone`, i.e. Webull had already
      terminated them, so neither filled) and `long_put` went 2 → 0.
      33 tests; 32 of them fail without the fix. PR #1488.
- [x] **Day trades first, reconciled continuously, one loss limit
      (2026-09-23, same PR).** Operator: "I really want the day trades to be
      first priority, and always be reconciled, every second counts. Also
      there really should not be any limits, just a loss limit as a whole."
      Shipped two things. (1) `runPendingIndexDtReconcileLoop` runs FIRST in
      the cron tick on every `*/1` and `*/5`, attached to nothing — the sweep
      used to sit at the END of an options pass that only fires inside the
      sell window, so the pass that stops is also the check that stops. Cron's
      floor is 60 s, so the tick keeps polling for the rest of its minute:
      ~5 s while an order is in its first minute, 15 s after (a broker LIST
      endpoint should not be hit 12x/min for the life of every order). Free
      when idle — one KV list and return. Verified live: 9 passes/min for a
      planted pending order, then 4 → 2 → 1 as it aged past 60 s and then past
      the stale window, then silence once resolved. (2) `options-risk-budget.js`
      replaces the count caps on this lane with ONE dollar limit
      (`prefs.daily_loss_limit_usd`, default $1000, `0` = off). For a long
      option the debit IS the max loss, so `consumed = open risk + realised
      losses today`; a win gives its risk back, a loss keeps consuming.
      Commitments are a map keyed by signal id, so commit is an assignment and
      refund is a delete — the re-read idempotency guard and
      `releaseEntryCounters` are deleted because there is no longer an
      operation that can apply twice. The lane no longer bumps the SHARED day
      counters (the Trader lane still gates on them; an uncapped lane bumping
      them would have swapped one starvation for another). 64 tests.
      All three follow-ups below are now closed.
- [x] **$500 limit, DIA, marketable entries, re-entry, and a graded replay of
      2026-09-23 (2026-09-24, same PR).** Operator: "Let's make the daily loss
      limit be $500… Regarding DIA, we should include it. Let's enhance and
      refine the entries price. I want you to review today's day trades."
      Graded the session FIRST, and the tape answered three of the four asks
      and found a fourth bug.
      (1) **$500, charged on the stop not the debit.** These are managed to a
      -50% hard premium stop, so `optionStopRiskUsd` charges `debit x 0.5`
      (`DEFAULT_STOP_FRACTION`, pinned to `HARD_STOP_PCT` by test). Replayed at
      $500: charging the debit takes 9/16 rounds and blocks DIA 514P (+$194)
      and IWM 283P (+$101) for $566 vs the desk's $702; charging the stop takes
      12/16 for $801.
      (2) **DIA mirrors.** `shouldIndexAutoMirror` now allow-lists
      `DAY_TRADE_TICKERS` instead of restating it.
      (3) **Entries price marketable.** `marketableEntryLimit` =
      `max(display_buy_ceil, ask)`, chase capped at 8% of mid (session spreads:
      2.06% median / 3.75% p90 / 14.3% p99 over 3,099 marks). `premium_band.ask`
      plumbed from `resolveLiveOptionPremium` through the clock to the mirror.
      (4) **Re-entry, found by the replay.** The BUY guard read `entry_fired ||
      entry_placed`, so all three of the session's re-entries were dropped
      (SPY 766P, QQQ 737P, IWM 281P — 766P's second round was +$219). It now
      blocks a duplicate of a LIVE position only and clears the prior round's
      `trim_*`/`exit_*`. Mutation-checked.
      `scripts/replay-day-trades.mjs` + `scripts/fixtures/dt-session-2026-09-23.json`
      grade entry and management separately. 4466 tests.
      **Still open:** SPY 766P's 11:07 re-entry is correctly refused because
      the paper STOP left 1 of 3 contracts on — the mirror declines to stack
      into a position it still holds. Defensible, but worth a look at why a
      STOP sold 1 of 2 remaining rather than flattening.
- [x] **Reliability and resilience pass on the day-trade lane (2026-09-24,
      same PR).** Operator: "Are there any other improvements we can make to
      get this to be reliable and resilient?" Four holes, all the same shape —
      a failure that leaves no trace and never heals.
      (1) **The ledger is rebuilt from the mirrors every tick.** Commit and
      release are idempotent, but idempotency only protects an operation that
      RUNS: a release the isolate never reached leaves the day paying for a
      position that does not exist until midnight, which is the counter's
      one-way failure in a new shape. `reconcileRiskBudget` frees a charge
      with no position behind it, re-prices a held one off
      `contracts_remaining`, and BOOKS a close the ledger never heard about.
      (2) **A lost settle is now detectable.** The close path writes the
      mirror BEFORE it settles, so "flat mirror, charged budget" is exactly
      the state a thrown `settleRisk` leaves — and freeing it would erase a
      realised loss and LOOSEN the limit. `settleIndexDtRisk` stamps
      `risk_settled_qty`, so the reconciler can tell "already booked" from
      "booking lost" and book the lost one at the mirror's close price. It
      stamps BEFORE booking, so a failed stamp retries next tick instead of
      re-booking every minute. Anything it cannot price is left alone as
      `drift`.
      (3) **A KV lease across isolates.** `*/1` and `*/5` are separate cron
      expressions, so at minute 0/5/10 two invocations fire and a module-level
      busy flag protects neither. Fails open — an unreadable lease reconciles
      anyway.
      (4) **NY trading date + paging.** A UTC budget key rolled at 20:00 ET,
      inside the evening reconcile window. And nothing watched this lane at
      all: `recordCronFailure`/`recordCronSuccess` under `index_dt_reconcile`
      now put it on `/timed/health` and the GitHub watchdog, and an exhausted
      budget posts once per NY day to the Discord system lane.
      4498 tests; each of the five guarantees mutation-checked.
- [x] **The engine never finished a market-hours tick (2026-09-22).** DDOG's
      0.1× Cloud Pivot entry scored, wrote D1 and sent its Discord card, then
      the `tt-engine` `*/5` isolate was killed with `outcome:
      exceededMemory` 1.3 s later, taking the queued bridge forward with it —
      coverage could only report `never_attempted`. Grouping scheduled
      invocations 14:00–18:00Z by outcome gives 46–49 `exceededMemory` and
      **zero** `ok` on every trading day in the retention window, and 47 `ok`
      on Saturday. Shipped: the trader ENTRY bridge forward now runs first
      inside `if (!dedupe.deduped)`, ahead of Discord/email/activity;
      `diagnoseCronTick` reads the start heartbeat against
      `timed:scoring:last_run` so a tick that fires and never finishes is an
      anomaly. Notes in `tasks/lessons.md`. (The same commit taught
      `computeTradeRelativeQty` to forgive NBIS's cross-tenant exit as a
      non-drift — REVERTED 2026-09-23, the page was real. See below.)
- [x] **Shed per-tick memory in the `*/5` engine lane (2026-09-23).** It was
      allocation, not compute, and it was one key. `timed:all:snapshot` held
      the full scoring payload per ticker: 26,195,645 bytes on 2026-08-14
      against KV's 26,214,400-byte value ceiling, so every write since was
      rejected and the blob served 40-day-old scores; and ONE rebuild cost
      182.1 MB against a 128 MB isolate. Today's universe would need
      52,687,072 bytes, 201% of the ceiling. Shipped `worker/all-snapshot.js`
      — a slim index (1.75 MB at 333 tickers, 7.9 MB per build, peak
      retention = index + ONE payload), a byte budget that degrades instead
      of failing the write, `readAllSnapshot` with a mandatory age gate,
      `hydrateSnapshotRows` for the handful of callers that need full
      payloads, the Cloud Pivot desk ranked inside the tick instead of at
      serve time, and the `pendingTrailPoints` accumulator no longer carrying
      329 payloads into the tail. Verified on the live universe: Today queue,
      desk and `extractSliceFields` byte-identical to the full-payload path
      for all 333 tickers. See [skills/all-snapshot.md](../skills/all-snapshot.md).
- [x] **Three writers, not one — finished the OOM (2026-09-23).** The slim
      snapshot alone did not stop the kills; production logs named two more
      writers. (2) The `/timed/all` FULL micro-cache put 30,790,510 bytes
      every 5 min, riding `ctx.waitUntil` so the value stayed alive until the
      413 settled, on top of the copy `sendJSON` was stringifying. (3) The
      `*/5` pre-warm dispatched the FULL `/timed/all` TWICE per tick (admin +
      anon), ~30 MB of JSON over a ~38 MB graph each, and the anon bucket's
      `redactTickerMapForTier` copies the graph again. Shipped
      `kvPutJSONIfFits` (measure and skip, never attempt a put that cannot
      succeed) plus `estimateMapBytes` — measuring by serializing IS the
      allocation, so sample 3 rows of 330 — and a `?slim=1` pre-warm, since
      the full slot has not existed since the universe outgrew the ceiling.
      Also fixed alongside: `nocache=1` was gating the micro-cache WRITE on
      the snapshot path (so the pre-warm never warmed anything) with a 60s
      TTL against a 300s read window; an empty `watching` array is truthy, so
      a desk written before the day's first scoring run shadowed the real one
      for 6h; and the sparkline query bound 329 parameters against D1's cap
      of 100, so no ticker got a fresh `_sparkline`
      (`worker/sparkline-d1.js`). Live proof: the snapshot build against
      production KV/D1 returns 1,765,413 bytes for 329 tickers where it tried
      52,585,887 yesterday.
- [x] **Five causes, not three — the `*/5` engine tick is green (2026-09-23).**
      The three writers above were all real and all fixed, and the kills
      continued: 08:40, 08:45, 08:50 and 08:55 were consecutive
      `exceededMemory` at ~150s wall. Two more causes, neither a single
      large allocation. (4) The scoring tail — slim index build, Cloud Pivot
      desk scan, D1 batch sync — was fired into `ctx.waitUntil` the moment
      scoring finished, so it ran CONCURRENTLY with the kanban pass and
      position reconcile. Two heavy phases alive at once in one isolate is a
      sum, not a max. It is stashed in `_deferredScoringTail` now and
      awaited after reconcile, above the `isAITime` early return. (5) The
      kanban pass materialised the whole shortlist to rank it — 268
      payloads, not the ~45 anyone assumed, because most of the universe
      classifies as an actionable stage. A `timed:latest` payload is ~165 KB
      of JSON and several times that parsed, so the batch alone is past 128
      MB. `processRankedCandidates` is streaming now: it keeps the scores,
      drops the payloads, and re-reads only the entry candidates it has to
      rank, one at a time with one read in flight ahead. Plus a module-level
      per-isolate lease: the 09:00 tick ran 579s, so 09:05 started on top of
      it in the same isolate and both died one millisecond apart. Live
      proof: every `*/5` tick from 09:25 on is `ok`
      (`/opt/cursor/artifacts/engine-tick-oom-final-proof.log`), the desk
      writes 28 firing of 329 scanned, and `/timed/plays/today` serves 20
      plays in 1.29s. Residual, accepted: the tick runs 300-400s so the
      lease skips about one in three, and that ~200s is
      `processTradeSimulation` across 268 candidates — a funnel-design
      question, not an OOM one.
- [x] **The monolith had its own OOM, and it was three more lanes
      (2026-09-23).** With `tt-engine` green, `timed-trading-ingest` was
      still dying on its `*/5` — 10 of 10 consecutive ticks overnight. The
      overnight window named it: no user traffic on that isolate at 02:00
      UTC, so serve-time load was not the cause. (a) The tick fanned out
      five `ctx.waitUntil` chains at once and every one is `_selfDispatch`,
      which is `this.fetch` — same isolate, five full request graphs
      resident together. They run as one sequential chain of named steps
      now. (b) `DataProvider.cronFetchLatest` is paced, not slow: 2.5s
      between TwelveData batches across four tiers, 300-620s per pass, on a
      five-minute cron — two or three always in flight. (c) The hourly
      `runChartCandleCalendar` is the same universe-wide REST-plus-D1 work
      and fires at the same :05. (b) and (c) share one `_barCronSince`
      lease, with the calendar claiming first. Also `_batchUpsertBars`
      prepares once and flushes every 500 instead of building ~10k bound
      statements up front. Accepted trade: a bar pass every ~10 min rather
      than every 5. NOT fully closed — see the open item below.
- [x] **Then the engine started hitting the 900s wall instead (2026-09-23).**
      With the memory fixed the failure moved: `exceededWallTime` at
      cpu 91-96s on the 12:40 and 12:50 ticks. At market ramp the kanban
      pass went from ~200s to ~480s (D1 slows under load and
      `processTradeSimulation` is ~1.75s a candidate) on top of ~220s of
      scoring. A killed invocation takes the deferred tail and position
      reconcile with it, so overrunning is worse than doing less. The
      ranked ENTRY pass is deadlined against the tick now
      (`KANBAN_ENTRY_BUDGET_MS = 600s`, measured from the lease claim);
      entries are attempted in rank order so the deadline drops the bottom
      of the list, and management is never deferred. Live: `Processed 216
      actionable, DEFERRED 52 lowest-ranked, in 368s`, tail then ran in 94s
      inside a 699s tick.
- [x] **And the deadline was right while the budget was wrong (2026-09-23).**
      From the 13:30 open the tick hit 900s again even though the entry pass
      was deferring exactly as designed (`DEFERRED 92 ... in 311s`). The
      overrun was in the LAST phase — the tail's D1 `ticker_latest` sync,
      whose own comment claimed "most ticks only have ~30-80 tickers whose
      score/stage/price actually changed". Overnight that holds (`32 written,
      297 unchanged-skipped`); from the bell every price moves every tick, so
      the changed set IS the universe and the pass went from 73-132s to
      280s+. `[SCORING] deferred tail done` stopped appearing at 13:30 and
      did not return, meaning the rows were not being written at all. Fixed
      in three parts. (a) `worker/d1-latest-sync-plan.js` caps and rotates:
      open positions and this tick's stage flips sync every tick, the quiet
      remainder sweeps over the next few, and the cursor advances only over
      rows the tick actually reached. A per-tick flip has to come from the
      scoring loop's own `_stageFlip` — `prev_kanban_stage` holds the last
      transition's SOURCE lane forever and would have exempted the whole
      universe. (b) The cap is derived from the wall time actually left, so a
      tick that spends 600s upstream syncs fewer rows instead of dying with
      none written; floor 40, ceiling 120. (c) The monitoring passes behind
      the tail (`checkIngestCoverage` ~245 KV reads, proactive alerts up to
      600) are skipped with a logged reason when under 60s / 90s of wall —
      `ctx.waitUntil` in a cron handler defers nothing, and on the 14:30 tick
      those reads turned a tail that finished at 836s into a kill at 900s.
- [x] **And it was the `*/1`, measured rather than guessed (2026-09-23).**
      The monolith's remaining RTH kills were the last part of "fix the OOM
      issue properly". The previous note guessed at the hot routes and at
      splitting the `*/5`; both were wrong, and the measurement said so in
      three steps.
      1. Grouping `exceededMemory` by END instant turned 18 kills into SIX
         isolate teardowns — one at `16:52:10` took five invocations at once
         (three `*/1`, two `*/5`). The 128 MB cap is per-isolate, so most of
         the 18 were collateral: one `*/1` victim had `cpu=116ms`. Wall time
         did not correlate either (`16:15` died at 78s, a 714s tick was `ok`).
      2. Filtering the kills by `eventType` returned `scheduled` ONLY — zero
         `fetch` invocations, ever. That is what acquitted the co-resident
         page traffic and the PriceStream DO, which the old note blamed.
      3. `[PRICE FEED]` had zero log lines, because `tt-feed` already owns
         the feed (12-23s a tick, zero OOMs). With it gone the `*/1` lane's
         only real work is the candle-chain DO feed: 328 symbols of Alpaca 5m
         bars plus a DO ingest each, 132-312s against a 60-second cadence with
         no overlap guard, so three to five passes were resident together and
         each held its own parse of the 2 MB universe index. Two passes 30s
         apart both logged `fed:298 universe:328`.
      Fixed as a pair, because a lease alone only converts overlap into lost
      freshness: the 298 per-ticker DO pushes went from serial (~240ms each)
      to concurrent per sub-batch across the 16 shards, taking a pass to ~36s
      and inside its own cadence, and `_chainFeedSince` (4-min expiry,
      `finally`-released) collapses whatever still overlaps. Coverage stays
      the whole universe every pass, preserving the June starvation fix.
      Also corrected two comments on that block that had rotted the
      reassuring way: it claimed to be `AWAITED` (it is `waitUntil`) and to
      rotate a chunk of the universe (rotation was removed in June).
      PR [#1487](https://github.com/Shashant7/timedtrading/pull/1487).
      **Correction:** the full window is 19 kills in SEVEN teardowns, not
      18 in six — the first query had not yet ingested the `17:08` teardown.
- [x] **Two more monolith tenants behind the `*/1` (2026-09-23).** Killing
      the `*/1` overlap took kills from 19 to 5 and left the teardown RATE
      unchanged (1 per 15.9 min → 1 per 16.5 min). That is what removing
      COLLATERAL looks like, and it is what said to keep going.
      1. **The bar pass had always overrun the 900s wall.** Visible only
         once the `*/1` stopped dying around it: `*/5 sched 17:00:54 →
         exceededWallTime wall=900s`. `cronFetchLatest`'s tiers sum to
         ~670s off-hour (10/15/30 full universe ~360s + 5m half at 8s
         pacing ~190s + 60/240 ~120s), which is exactly what production ran
         (677/694/702/707/714s), and ~1030s at the top of the hour with
         D/W/M. `tdFetchTimeSeries` now stops at an absolute deadline
         BETWEEN batches, so what is already fetched still upserts. The
         Alpaca per-symbol fallback is skipped on a short fetch (it would
         replace a bounded stop with an unbounded heal) and
         `bar_cron_aggregated` success is withheld (or freshness reads
         healthy while D/W/M went unfetched). The tier ORDER already made
         a cutoff safe: the stream-covered 5m is dropped first.
      2. **`_d1LatestFingerprintCache` held 52 MB of the 128 MB isolate.**
         The `*/5` ticks that died were indistinguishable from the ones
         that lived (73-86s wall, 12-14.5s cpu either way) and one died
         ALONE, because the invocation was never the problem. The cache
         elides unchanged `ticker_latest` writes and stored
         `` `${stage}|${len}|${payloadJson}` `` to do it, so the VALUE was
         the payload: production is 332 rows / 52,291,932 bytes, avg 157 KB.
         The 500-ENTRY cap was real and never engaged — the universe is 332.
         `d1PayloadFingerprint()` (cyrb128 + exact length) is 52.2 MB →
         13.0 KB measured, 87 ms for a full tick against a 12-14s budget,
         0 collisions in 400k near-identical payloads. Both sites converted,
         including the batch sync whose `_bindFps` stacked full payloads.
      Verified in production: `18:52-19:37` is **0 teardowns over 7 `*/5`
      ticks**, including three 687-697s bar-lane holders — exactly the
      invocations that used to anchor one. tt-engine 8/8 `ok` over the same
      window. PR [#1487](https://github.com/Shashant7/timedtrading/pull/1487).
- [ ] **The monolith `*/5` still crosses the cap into the close.** Not
      finished, and the numbers should not be read as if it were:
      | window | | teardowns | killed | rate |
      |---|---|---|---|---|
      | baseline `15:17-17:08` | 111 min | 7 | 19 | 1/15.9m |
      | after fixes 1+2 `17:37-18:43` | 66 min | 4 | 6 | 1/16.5m |
      | after fix 3, mid `18:52-19:37` | 45 min | 0 | 0 | clean |
      | after fix 3, close `19:37-20:07` | 30 min | 6 | 7 | 1/5.0m |
      There is no 09-22 close to compare against — observability retention
      had already dropped it, and a query over that window returns zero
      events **of any kind**, so the apparent "0 teardowns yesterday" is
      missing data and not a regression signal.
      The signature is unchanged from before fix 3, so it is the same
      remaining tenant: the `*/5` dies 9-11s after its move-status block
      having spent ~46s silent between `[MIRROR COVERAGE]` and
      `[MOVE_STATUS_SL_SKIP]`, taking at most one `*/1` with it. Only the
      19:45 tick carried extra lanes (`45 19 * * 1-5`, the investor DCA
      burst) — 19:30/19:40/19:50/19:55 were ordinary two-lane ticks, so it
      is the ORDINARY tick getting heavier into the close, not a
      once-a-day job. `[MIRROR COVERAGE]` grew `actions=59 → 73` and
      `unmatched=15 → 18` over the same span.
      Next tenants, in expected order: (a) the pre-warm chain, which
      `_selfDispatch`es `/timed/all?slim=1` (x2) and `/timed/options/all`
      (x3) through `this.fetch` — five full request graphs in this isolate;
      (b) the mirror-coverage pass. Scoring is NOT a candidate: it runs on
      tt-engine (zero `[SCORING]` lines on the monolith). Also still open
      from the earlier pass: `runChartCandleCalendar` is a second
      un-deadlined paced lane (an 18:05 `*/5` that SKIPPED the bar pass
      still ran 626s because `claimBarLane()` had taken the lane first).
      Needs a live RTH session to verify, so it wants its own branch.
- [x] **Reduces now reach every mirrored tenant (2026-09-23).** Operator
      correction: every mirror-enabled account tracks the model on every
      position it held at activation, with quantity relational to account
      size. `clampExitOpsToHoldings` budgeted per TICKER against a pot filled
      from ONE account's `/bridge/positions`, so three broker accounts shared
      one number — 10 real reduces worth ~$2,656 cancelled, and one phantom
      sold against an account holding zero. Now budgets per (account, ticker)
      with `loadBrokerHeldEquityForOwners` asking every tenant and failing
      closed per owner. `/bridge/positions` also exposes `broker_account_id`,
      the only id the manifest and the broker agree on.
- [ ] **Recover the 10 stranded partner reduces (~$2,656).** DE, FLR, IYT, J,
      NBIS, RBLX, USO, WTS, XYZ in `shahpritesh206#webull#individual-cash`
      and UNP in the owner's Roth. The fixed catch-up should plan them on its
      next RTH pass — confirm it does rather than assuming.
- [ ] **Consider making `mirror-coverage.js`'s holdings read multi-tenant.**
      Line ~869 still calls the owner-only `loadBrokerHeldEquity(env, {nowMs})`.
      Deliberately deferred: coverage only reports, it does not place orders,
      so a wrong answer there pages rather than trades. Lower risk than the
      reduce path but the same blind spot.
- [x] **Cleared the four open Sanity Sweep incidents (2026-09-22).** Three
      were the sweep misreading a healthy system. `ringScaleShortfall`
      compared the bridge's account-sized fill against the MODEL qty, so
      every mirrored order looked partial (62 of 200 live ring rows,
      all with a null reason, ratios stable per ticker) — it now needs a
      cap the bridge NAMED. `isExpectedBridgeReject` knew two substrings
      while two other modules had already made `no_manifest` terminal.
      `healUnknownSectorMapKeys` read a missing KV key as an Unknown
      overlay and "deleted" 106 keys that were never there, every sweep —
      the reported list was exactly the 106 tickers with no overlay. The
      fourth was real: Webull's submit throttle looked terminal to
      `classifyBridgeOutcome`, so MU's trim was retired instead of
      retried and the broker kept the shares; it is transient now. Also
      stopped the DPZ 1e-05 sh exit that catch-up had re-offered hourly
      since 09-16 — a share epsilon cannot express a $0.01 notional floor.
- [x] **Re-delivered the blind-read fixes that a stacked merge stranded
      (2026-09-22).** PR #1479 targeted PR #1478's branch, and #1478
      merged that branch into `main` nineteen minutes before #1479 merged
      into it — so GitHub said MERGED, CI was green, the branch tip held
      every commit, and `main` had none of the five fixes. Only
      `git merge-base --is-ancestor <sha> origin/main` shows this; PR
      state cannot, and the deploy workflows never ran so there was no
      failure to notice. Cherry-picked onto `main` (byte-identical to the
      stranded branch) and taught `check-branch-merge-state.sh` to refuse
      (exit 3) when an OPEN PR from the branch targets a base whose own
      PR has already merged. Confirm deploys by ancestry, not PR state.
- [x] **Audited the rest of the broker path for the same shape and found
      the expensive one (2026-09-22).** `loadBrokerHeldEquity` is the
      module written to prevent SPYU W38 and its docblock promises "null
      — never `{}` — when the broker could not be reached"; it returned
      `{}`, because `/bridge/positions` reports success PER ACCOUNT and
      `ok` only means the bridge answered. A rate-limited read therefore
      told the index-trend catch-up the Roth was flat and it placed a
      duplicate BUY. `positions_stale` counts as not answering too (an
      hour-old snapshot can predate the fill being guarded against), and
      the unknown is no longer cached. Also: a failed claim read returned
      `[]`, which asserts "nobody owns these shares" and re-opened the
      DPZ false orphan; `sync_drift_count` never reset despite every doc
      calling it a consecutive run; adopt-position reported an unread
      account as "flat in the ticker"; the IBKR options guard did not
      fail closed like the Webull one; and `response` (IBKR's carrier)
      was not read, which the fail-closed change would have turned into
      a permanent deferral. Left alone: `verifyReducerHoldsPosition`
      fails open by design, and errs toward selling.
      `index-trend-adopt-blind-broker.test.js` mocks only the network —
      the existing suite mocked `loadBrokerHeldEquity` as
      `async () => ({})` and called it "the safe to buy case", which was
      the wrong assumption itself.
- [x] **Three inbox complaints, one shape: an unread value treated as a
      measured one (2026-09-22).** (a) Mothership Orphan pages for TQQQ /
      UDOW / TNA / NBIS / P, all five held in the Roth and `in_sync`. The
      reconciler's outage guard `(hasEquity && !equityRes.ok) &&
      (hasOptions && !optionsRes.ok)` can never fire for an equity-only
      row set, so a rate-limited Webull `/positions` call classified
      against an empty map and orphaned the account. Now fails closed per
      instrument class, and the shared `try/catch` actually catches (it
      guarded on `if (!equityRes)` against a pre-seeded `{ok:true,
      positions:[]}`). `reconcile_error` no longer bumps
      `sync_drift_count` — being blind is not drift, and counting it
      walked healthy rows toward `AUTO_SUPPRESS_AFTER_DRIFT`.
      (b) LLY + DE daily CRITICAL Execution Drift. The 6h repeat throttle
      slowed re-reporting but never ended it, and neither drift could
      heal (DE's trim was superseded by a catch-up full exit; LLY's
      ~$40 sleeve went to 0). `classifyPostExecResolution` retires both —
      `superseded_by_model_close` silently, `broker_flat_after_over-
      execution` after one final-flagged alert. Underexecution and
      replenishment deliberately stay open.
      (c) CF review found `peak_price` was never a high-water mark: the
      auto-rebalance SELECT omitted the column, so the `Math.max` scored
      the stored peak as 0 and rewrote it to spot every run. All 20 open
      Long Term rows carried a fake peak. CF ran +22.2% and closed +5.07%
      with `peak_price` 125.21 against a real 141.66.
      `worker/investor-peak-price-contract.test.js` guards the query, and
      `healInvestorPositionPeaks` rebuilds the stored peaks from daily
      candle highs since each row's own `first_entry_ts` — a `Math.max`
      can only ratchet up from a fake value, so the query fix alone would
      have left all 17 understated. 17 of 17 candled rows recover.
      Follow-ups NOT taken (policy, needs the learning loop): the MFE
      extension trim is one-shot per position, and the monthly DCA does
      not know a de-risking lane just sold — CF trimmed 11.78 sh @ 128.98
      and DCA'd 15.31 sh @ 130.63 five hours later the same session.
- [x] **Portfolio "0 positions" for Long Term was a starved fetch
      (2026-09-20).** The book was fine — `/timed/investor/positions`
      returned 18 OPEN rows at +$3,966.58 and the equity curve agreed.
      The page fetched the FULL `/timed/all` (29.85MB / 13.5s for an
      entitled user) in the same `Promise.all` as its two position
      endpoints, purely for a price overlay; `fetchPriceMap()` already
      asked for `?slim=1` (80KB) and was dead code. That transfer starves
      `/timed/investor/positions` (~170KB, 3-4s) while the 18KB trader
      endpoint survives, which is why only the Long Term pane zeroed.
      Switched the initial load to `?slim=1`, deferred the full snapshot
      to first rail open, and stopped the UI reporting a failed fetch as
      `0 positions` / `$0.00` (unknown open P&L is now `null`, so the
      equity card falls back to the curve). Also held
      `tt-global-search.js`'s universe enrichment — the full `/timed/all`
      on EVERY page load for a name + sector — until a real search.
      PR #1476. Follow-up if it ever matters: give `?slim=1` a
      name/sector so search enrichment can stop using the full blob.
- [x] **Weekend review 2026-09-20: the Cloud Pivot block proposals were
      inert, and the long leg was an exit defect.** Proposals 79
      (`edge_scorecard`) + 81 (`weekly_governor`) both asked to block
      `TT Cloud Pivot Long` on 90d PF 0.24 / −$208.77. Investigated
      instead of blocking. The family across both legs is **+$46**
      (short leg +$255 at PF 4.00), and the separator is the trim, not
      the side: 27 trades that reached a trim went 92.6% WR at PF 14.83,
      the other 19 went 0-for-19. The long leg is PF 44.67 once it trims.
      Two exit defects account for nearly all of it — 6 profit-lock
      misses (−$123, fixed by the 2026-09-05 rework) and 4 trades on
      2026-09-04 that never went green and ran to −5.1%/−6.5% (−$121),
      because the family had a profit lock above the `!c512` guard and
      nothing on the loss side. Shipped `tt_cloud_pivot_loss_cap` at
      −2.5%, gated to unproven trades. Separately, the proposals could
      not have worked: the paper sibling path resolved to no catalog
      play, so the calibration guard never fired, the key was one
      `checkSetupDemotion` never reads (the enforced key was already
      `allowed`), and `parseDemotionKey` returned a null id so the CIO
      rule could not run. Fixed with `sibling_paths` +
      `resolveGovernancePlay`; the desk then rejected both itself
      (`calibration_family`, no operator override).
      **Next weekend:** the long leg is ~−$46 net of both defects on 24
      trades — still unproven, not yet a bleeder. Re-run
      `scripts/cloud-pivot-loss-cap-calibration.mjs` once there are
      post-cap closes and revisit 2.5% vs 2.0% on evidence rather than
      on the 46-trade sample.
- [x] **Two follow-ups the sibling fix did not cover (2026-09-20).**
      Found by running the new weekend review against production rather
      than the fixture that motivated it.
      (1) **The display form was still mangled.** `sibling_paths` taught
      the catalog the *path* `tt_cloud_pivot_long`, but
      `SETUP_DEMOTION_NAME_MAP` is keyed by path, so the *display* string
      "TT Cloud Pivot Long" — the one proposals 79/81 actually stored as
      `config_key` — matched no entry and still fell to the title-case
      fallback. `demotionProposalConfigKey` now asks
      `resolveGovernancePlay` before giving up; all four spellings land
      on the enforced key, and an unknown name still passes through.
      (2) **Seven no-op proposals in the ledger.** ids 82-88, all
      `edge_scorecard`, all "block TT ATH Breakout" against a family
      blocked since the governor auto-demoted it. `submitProposal`
      dedupes only *pending* rows, and a no-op clears to
      `already_in_effect` before the next run checks. The bus now drops a
      submission whose key already holds the proposed value; the
      `already_in_effect` clearer stays for the genuine race.
      Also made the weekend review's governance cross-check mechanical
      (`--markers` → BLOCKED / CALIBRATION / LOOK per leg, plus an
      inert-marker audit that re-canonicalizes every key). It confirmed
      the three worst families are already blocked and the only unmarked
      losing legs are Pullback Reclaim (4 closes), Gap Reversal Long (1)
      and Forming Pair (2) — all bounded, worst −2.19%, so nothing else
      needs a loss rule. Deployed to main + tt-engine + tt-research;
      replaying the deployed guards against tonight's live card files 0
      proposals (was 1/night).
- [ ] **Operator action: add the Cloudflare CI secrets.** `deploy-*`
      workflows now fail loudly instead of silently skipping, but they
      still cannot deploy until `CLOUDFLARE_API_TOKEN` +
      `CLOUDFLARE_ACCOUNT_ID` exist under Settings → Secrets and
      variables → Actions. Until then every merge needs a hand-run
      `npm run deploy:worker`. The next `worker/**` merge will go RED
      as designed if they are still missing.
- [x] **The 2026-09-15 RTH open cleared all three index-trend entries.**
      The 14:04:03Z coverage heal adopted SPYU W38
      (`broker_already_holds_SPYU_9_adopted`, zero orders) and placed TNA
      W37 + UDOW W38 with real order ids. Neither came back
      `insufficient_cash` as predicted. Coverage ended the session
      `unmatched: 0, fails: 0, anomalies: 0`.
      But both placements were SHORT: the bridge's concentration ceiling
      on a $14.8k Roth scaled 31 sh → 5 and 28 sh → 5, and every layer
      recorded the request, so coverage called a 16%-filled sleeve a
      clean `mirrored` and `closeQty` would size trims off 31 against 5
      held. Fixed in #1472 (`accepted_qty` through the bridge, ring,
      mirror row and coverage).
- [x] **Index-trend sleeves were filed as OPTIONS — one cause, four
      symptoms (2026-09-15).** Chasing "the reduce path is unproven" and
      "the sleeves over-claim" separately turned out to be chasing one
      bug. `inferInstrument` called any `vehicle` other than `equity_long`
      an options structure, and the index-trend mirror tags share orders
      `vehicle: index_trend_letf`, so all 5 LETF rows landed as
      `instrument_type: options`. The reconciler then took the options
      path, found no `model_intended_legs`, and parked them at
      `untracked`/"cannot leg-compare" forever — the equity classifier
      that converges `broker_remaining_qty` never ran — while
      `claimedOpenEquityByTicker` and `_readOpenClaimRowsForUser` skipped
      them for not being equity, which is exactly why TNA W36 (closed)
      kept claiming 4 against W37's 5 on a 5-share position. 240 of 245
      live rows classified fine; the only 5 that did not were these, and
      all 5 were untracked. Fixed in #1473, with a one-shot reclassify
      for the existing rows since the entry upsert is DO NOTHING on
      conflict. Replay on the real rows: claim map nothing → 5, and W36
      goes from drifting `broker_orphan` residual 5 to `in_sync`
      residual 0. The reduce path itself was never blocked (untracked +
      held reduces via `held_override`, a full exit is in the close
      PROCEED set, and the live-position guard clamps) — now pinned by
      tests instead of left unproven.
- [x] **`post_exec_drift` flood (2026-09-15).** Not a real never-healing
      drift and not a missing cooldown: the drift path treated
      re-CHECKING and re-REPORTING as the same thing. The audit is left
      `verified:false` on purpose so a heal can still be noticed, so
      every pass re-wrote the row and re-notified. Fixed in #1473 —
      288 audit rows/day → 4, while a drift that moves past the fill
      tolerance in either direction still reports at once.
      `drift_detected_at` now means first-seen; `drift_reported_at` is
      the suppression clock.
- [x] **Audit follow-ups from 2026-09-14, all closed in #1473.**
      Per-lane cooldown for `_healModelBrokerCoverage` (the every-lane
      verdict meant one broken lane stopped ANY cooldown being written,
      so the four healthy lanes re-ran every cycle and could burn
      `catchup-*`'s `max_ops` budget — not "delays the other four" as
      first written); `lastSessionHint` and
      `_resetDeskJournalSchemaCache` deleted; the route-audit note added
      to `skills/security-auth-patterns.md` (it is 9 routes in
      `worker/trust-spine/routes.js`, not four).
- [ ] **Still watch the first real index-trend TRIM or EXIT.** The paths
      are now tested and the classification fixed, but no index-trend
      reduce has yet been observed end-to-end at the broker. Worth one
      look at the mirror log after the next weekly flip.
- [x] **Merged-PR audit + the defects it found (2026-09-14).** 47 of 66
      PRs merged 09-03 → 09-14 touched `worker/**` and did nothing until
      the 09-14 manual deploy; 14 of those ran HALF live, because their
      frontend or bridge half deploys on a different path (PR 1463
      shipped blank breakout badges for two days). Fixed the three live
      defects the blackout was hiding: the ext-trim guard was clobbered
      in the same pass so an already-trimmed runner could reach the 75%
      cap in one session instead of once per session; the FOMC purge was
      unbounded and would have deleted every real 2027 Fed meeting from
      late Dec; `_healModelBrokerCoverage` reported success on any one
      lane and took a 4h cooldown while four could have thrown. Also
      deleted the reserve-then-release cap helpers (no callers, and they
      re-implement the wedge documented directly beneath them), exposed
      `deployedSha` so a stale worker is distinguishable from a current
      one, added `deploy:crons`, and added a UI/worker field-contract
      test.
- [x] **4 unmatched trader EXITs (2026-09-14).** U and MNST were
      already flat at the broker; DPZ and KO had no manifest sleeve at
      all (their entries never mirrored — the held shares belonged to
      older DPZ lots and an `inv-KO-auto` DCA sleeve). Coverage now
      settles a reduce against the trade's own sleeve, then the
      ticker's position: live fails 6 → 4, and `catchup-trader-exits`
      dropped off the heal plan. The exit catch-up itself was about to
      sell one position per stale sleeve (30 claims → 9 real ops);
      clamped to broker holdings, newest exit first.
- [x] **Broker mirroring fail-closed (2026-09-14).** Three stacked
      faults: CI deployed nothing since 09-03; daily cap slots leaked
      on isolate death and wedged the lane at 2/2 with zero orders;
      coverage was blind to `index_trend` because the action tape died
      09-10. Replayed real prod state: 0 orders forwarded before, 2
      after (cash-scaled into the $2000 sleeve) with the cap enforced.
      Branch: `cursor/broker-mirror-failclosed-7ffc` (PR #1471).
- [x] **Index Swings Discord without broker fill (2026-09-14).** TNA
      W37 DCA_ADD (46 sh, $2975) and UDOW W38 BUY (28 sh) hit
      #trade-signals. Roth got neither. Cash-scale BUY qty to
      `max_per_order_usd`; DCA on a never-filled sleeve is an entry
      catch-up; heal never-attempted books first. Shipped in #1470 —
      but note it did NOT reach prod until 09-14 22:20Z because CI was
      deploying nothing. Branch: `cursor/index-trend-cap-scale-7ffc`.
- [x] **FOMC Today label (2026-09-13).** Sunday Today strip said
      TODAY · FOMC rate decision. Published decision is Wed Sep 16.
      Snap + D1 purge shipped. Branch: `cursor/fomc-today-label-7ffc`.
- [x] **TT Setups broadcast live (2026-09-13).** Copy is locked.
      `WEEKEND_DESK_BROADCAST=1` on ingest + tt-research. Live send
      2026-09-13: 6/6, preview false. Branch:
      `cursor/weekend-desk-live-7ffc`.
- [x] **TT Setups target + invalidation (2026-09-13).** Drop the
      up/down/sideways block — it restated the same level. Each
      card is setup, **target**, and **invalidation**. Branch:
      `cursor/weekend-target-invalidation-7ffc`. Admin preview
      sent 2026-09-13 (AU/CDNS/EXPE/AMAT featured; RBLX/H on tape).
- [x] **TT Setups report + opportunity (2026-09-13).** Each card
      states the setup, up/down/sideways paths, and the path the
      desk is watching. Branch: `cursor/weekend-setup-report-7ffc`.
- [x] **TT Setups magnet dir vs pull (2026-09-13).** GOLD chip said
      LONG while copy pulled price down to $44. Magnet dir now
      follows price vs shelf. Branch:
      `cursor/weekend-magnet-dir-7ffc`.
- [x] **TT Setups chips: last price + LONG/SHORT (2026-09-13).**
      Weekend email ticker chips show last price, setup direction,
      and day %. Branch: `cursor/weekend-cmt-prep-7ffc`. Admin
      preview resent 2026-09-13.
- [x] **TT Setups email polish (2026-09-12).** 60-day daily window;
      snap D/W writes to `canonicalDailyTs` and drop 00:00/04:00
      siblings; cap displayed R:R at 4; magnet charts on daily
      (GOLD). Branch: `cursor/weekend-cmt-prep-7ffc`. Admin preview
      sent 2026-09-12 (AU/CDNS/EXPE/AMAT featured; TSM/GOLD on tape).
- [ ] **Breakout watch upgrades (2026-09-12).** Narrow Setup to
      trendline + daily-level; 2–3 touch visual line; RVOL on fire;
      retest = look-for-entry; approaching badge on rail/Today.
      Branch: `cursor/breakout-watch-upgrades-7ffc`.
- [x] **Breakout + trendline watch (2026-09-12).** Level breaks already
      exist (`detectBreakout`). Descending/ascending trendline breaks
      were rail-only. Stamp `_breakout_watch`; fired → kanban `setup`
      ("look for a good entry"). Not a new auto-buy path. Branch:
      `cursor/breakout-trendline-watch-7ffc`. Merged #1462.
- [x] **Exit emails missing Signal Quality (2026-09-10).** TQQQ Index Swings
      close showed setup + P&L but no rank/conviction. Template was
      entry-only; paper-lane payload never stamped scores. Branch:
      `cursor/exit-email-scores-7ffc`.
- [ ] **Bottom nav scrolls mid-page on mobile (2026-09-05).** Screenshot:
      nav floats ~2/3 down Today (content above + below). v8/v9 CSS
      `bottom:0` + post-scroll settle leaves the bar detached during
      scroll on iOS. Fix: mobile scroll-shell (`#tt-mobile-scroll`) so
      nav is in-flow at viewport bottom; bump SW to `tt-shell-v10`.
      Branch: `cursor/bottom-nav-fixed-ios-5225`.
- [x] **Watchdog red on Labor Day: 301 universe orphans (2026-09-07).**
      The 9 AM ET stub monitor's flat 24h rule deleted every
      `timed:latest:*` and no session followed. Fixed with
      `sessionAwareStaleMs()` (calendar-derived horizon for the stub
      monitor and the 60m candle check); stubs re-seeded from D1
      `ticker_latest`; monolith + tt-research + tt-engine deployed.
      Branch: `cursor/holiday-aware-stub-monitor-dbdd`. Lesson in
      `lessons.md` 2026-09-07.
- [ ] **Execution discipline (2026-09-04/05).** Plan + ledger:
      [`2026-09-04-execution-discipline-plan.md`](2026-09-04-execution-discipline-plan.md).
      Landed: execution window + escalating peak floor (index trend), MFE
      spike guard, holdings-truth reducers (guards + fan-out), smart gates
      revived (`nyDayString`) with 12/8/6 core caps, paper-family budget
      4/3/conviction>=2, Cloud Pivot profit lock trim-then-trail.
      Packet 3 landed: durable `broker_intents` ledger + `*/5` drain,
      "model fill" notifications, DELL audit -> compounder patience
      override, ST window review (no change), paper-short decision.
      Packet 4 landed: context playbooks KEPT in shadow (30d report card:
      DELL-class reclaim 39% positive); convexity ticket ledger
      (`convexity_tickets`, */5 mark, admin report card).
      Options desk mirror landed behind the grade gate (`lotto` vehicle,
      options closes in the intent ledger); paper-close-on-fill decided
      against (paper book is model truth). Report card endpoint
      `/timed/admin/execution/report-card` landed; DA config corrected
      (daily cap 6 was overridden by a 999 row; late-day block 120; ratchet
      arm 1.5). Packet 6 landed: the ratchet exit was being re-gated as a
      soft exit (`[EXIT SHIELD]`, 30m cadence, CIO) -- now a hard
      profit-lock class, RTH-only; weekly execution review automated
      (Friday 17:00 ET cron, KV, operator email, Discord,
      `/execution-review.html`); member retro moved to the same slot.
      Remaining: Monday 09-08 watch list in the plan (section 8); toggle
      the Convexity Ticket vehicle when `mirror.enabled` flips.
      Branches: `cursor/execution-discipline-plan-dbdd` (PR #1426, merged),
      `cursor/execution-discipline-packet-2-dbdd` (PR #1427, merged),
      `cursor/execution-discipline-packet-3-dbdd` (PR #1428, merged),
      `cursor/execution-discipline-packet-4-dbdd` (PR #1430, merged),
      `cursor/execution-discipline-packet-5-dbdd` (PR #1431, merged),
      `cursor/execution-discipline-packet-6-dbdd`.
- [ ] **SPY options still missing on holdings (2026-09-03).** Options
      normalize ignored Webull `position_list` (equity path already read
      it), so OPTION rows never reached Broker Connections. Bundle options
      on the equity fetch, OCC fallback, cache v3, deploy bridge.
      Branch: `cursor/spy-options-manifest-fix-dbdd`.

- [x] **Webull whole-share prefer + RTH-first (2026-09-03).**
      Prefer whole shares on buys (1.623 → 2 when cash allows). Keep
      fractional only for high-priced names (LLY-class) in RTH. No
      fractional in EXT. Defer new entries to RTH; EXT only for
      stop/target reducers on major AH moves.
      Branch: `cursor/webull-whole-shares-rth-dbdd`.
- [x] **Options mirror cap + successful-entry accounting (2026-09-03).**
      Raise the operator options daily cap to 5; reserve cap slots before
      dispatch but release them on broker rejection/error; recognize
      fan-out LETF order IDs so successful entries remain trim/exit eligible.
      Add regression tests, deploy both worker environments, and verify live.
      Branch: `cursor/options-cap-success-count-dbdd`.
- [x] **Learning desk review (2026-08-27).** Pending `learning_proposals`
      are mostly stale / already-in-effect / workhorse blocks. CIO/CRO/CTO
      desk triages hourly: auto-ack, auto-reject, auto-approve protective
      widen-block, restore Support Bounce (30d +$312). Heal no longer
      re-writes `blocked` every night. Branch:
      `cursor/learning-desk-review-df0c`.
- [x] **Learning-loop evolution (2026-08-27).** Last month of merges was
      mostly product (index vehicles, broker, Today). Loops 1–3, Trade
      Review, and the weekly governor are already ON. Cloud Pivot was a
      live bleeder the catalog/governor could not see; Loop 1 combos were
      too sparse; the proposal queue was full of already-applied blocks.
      Wire catalog + setup rollup + already-in-effect. Spec:
      `tasks/2026-08-27-learning-loop-evolution.md`. Skill:
      `skills/learning-loops.md`. Branch:
      `cursor/learning-loop-adapt-df0c`.
- [x] **Index trend LETF lane (2026-08-27).** Split day-trade options from
      swing/trend SPYU/SPXU share expressions. API + paper book + mirror +
      Today strip + right-rail panel. Spec:
      `tasks/2026-08-27-index-trend-letf-lane.md`. Branch:
      `cursor/index-trend-complete-df0c`.
- [x] **Day-trade STOP OUT Discord embed (2026-08-26).** STOP/EXIT alerts reused
      the full entry playbook (Setup/Trigger/Entry/Bracket BUY limit) so a stop-out
      read like a new entry. Embed now shows Exit/Why, fill recap, and planned
      stops; reason text maps premium_stop vs breakeven_stop accurately. Branch:
      `cursor/dt-stop-out-discord-embed-dbdd`.
- [x] **Lotto: no 0 DTE + brief why (2026-08-25).** Live CVX card was
      `205C Exp Aug 25 (0 DTE)` with no reason. Convexity lotto is a
      swing/event debit, not the index day-trade product. Single-name
      `pickLottoExpiration` snaps to the next Friday weekly (≥1 DTE);
      `isConvexityPlayActionable` drops DTE < 1. Every card gets
      `shot_reason` (earnings catalyst, or floor / compression / ST hold
      / theme). Index 0/1 DTE stays on Index Day-Trade. Branch:
      `cursor/strip-stamp-earnings-lotto-dbdd`.
- [x] **Strip published stamp + lotto earnings play (2026-08-25).** Two
      operator asks on the Today strips.
      1. **Published stamp.** Index Day-Trade and Lotto cards refresh on
         their own cadence but never said when the copy was built, so a
         stale tab looked live. Server stamps `day_trade_generated_at`
         (rebuilt on every `/timed/options/all` hit, cache or not) and
         `generated_at` (convexity). Frontend renders
         `Published 11:42 AM ET · 3m ago` in the strip head, ticking
         every 60s and going amber past the refresh budget. Lotto also
         gains the 5-min visible-tab poll Index DT already had —
         without it the stamp only proves the tab is old.
      2. **Earnings play inside the lotto strip.** The earnings-prep
         lotto already existed (`shouldActivateEarningsPrepLotto`,
         1–5d window) but shipped no catalyst, no implied move, and no
         target — the operator could not tell a confluent print from a
         coin flip. New `worker/earnings-play.js` composes what the
         system already stores: implied move from the Alpaca ATM
         straddle (falls back to IV × √t, then null — never guessed),
         plus a four-pillar read (technical confluence, fundamentals
         from `timed:fundamentals_v7`, social from `ticker_social`, and
         research-desk/FSD mentions). Emits catalyst line, alignment
         verdict (CONFLUENT / MIXED / THIN), underlying target, and the
         IV-crush + `covers_print` honesty checks. Bounded to the top 3
         earnings-prep cards per scan (one chain fetch each, inside the
         10-min cache miss path). Verified by a jsdom render of the
         compiled Today page (`tests/today-strip-stamp-earnings.test.js`)
         — both stamps and the full earnings block land in the DOM. Not
         yet checked against a live earnings-prep card.
      3. **IV crush, measured (operator follow-up).** Warning copy is not
         a defence. `buildCrushBlock()` now prices the crush: post-print
         vol from the next expiration's ATM IV (term structure) or the
         ATR×√252 realized proxy, then a Black-Scholes solve for the
         underlying move needed AFTER the crush to hold the entry
         premium. Compared against the implied move that gives
         EXIT_BEFORE_PRINT / TIGHT_HOLD / CAN_HOLD_THROUGH, plus
         `exit_by` (the last session carrying event premium) and
         `premium_flat` (what the contract is worth if the stock does not
         move). No volatility reference → UNKNOWN, never a guessed
         haircut. Branch: `cursor/strip-stamp-earnings-lotto-dbdd`.
- [x] **ST share broker follow-through cutoff 7pm ET (2026-08-25).** Post-RTH (earnings) stays; 8pm Discord TSLA/DPZ cannot fill — official AH ends 8pm and overnight is select names. Live ST equity exit/trim + trader mirror stop at 19:00 ET; 16:00–19:00 uses LIMIT+ALL+GTC. Replay unchanged. Branch: `cursor/st-ah-broker-cutoff-dbdd`.
- [x] **Health watchdog 11m lockstep false page (2026-08-24).** Run 32768985744: 59 symbols all 11m (BK/BNY/CRDO…), feed/chain/scoring green. Align `/timed/health` with feed 20m page window; watchdog fails only if max age ≥20m. Branch: `cursor/watchdog-stale-grace-dbdd`.
- [x] **ST test-and-hold scan + TSLA miss (2026-08-21).** All-four TF holds: 10 names, losing cut. TSLA this week = Friday daily ST flip through $357, not a hold. Writeup: `tasks/2026-08-21-st-hold-scan.md`.
- [x] **ETHUSD-like TD13→9 + 233 scan (2026-08-21).** Phase Leaving is not a signal. Monthly TD13→9 + 233: ETHUSD only. Weekly + 233: 11 names. Writeup: `tasks/2026-08-21-eth-stack-scan.md`.
- [ ] **Investor (long-term) stop forensics (2026-08-17).** 63 positions
      opened May–Aug 2026, 47 closed. The damage is on the exit side, not
      the entry side: 44 of 47 closes were `PRIMARY_INVALIDATION_BREACH`
      for **−$11,132**, on a MEDIAN penetration of **1.29%**, on days when
      SPY was above its own 21 EMA in 11 of 12 cases. 18 of 23 saw price
      close back above the exit inside 20 sessions (median: 1 session,
      average max recovery +7.3%). Every position the stop never touched
      is profitable (+$5,820 unrealized on the 16 open). Full writeup in
      [2026-08-17-investor-stop-forensics.md](2026-08-17-investor-stop-forensics.md).
      Shipped three **default-OFF** gates in
      `worker/investor-autopsy-gates.js` (22 tests):
      `deep_audit_investor_weekly_st_dir_fix` (a real bug —
      `tf_tech.W.atr.xs` is flip-only AND sign-mirrored, so
      `trendDurability` scored 0 on all 35 recorded entries and Weekly
      SuperTrend never became an invalidation candidate),
      `deep_audit_investor_require_session_close`, and
      `deep_audit_investor_shallow_breach_score_hold`. The latter two are
      strictly widening. NOT shipped: a clamp on the floor ratchet — the
      two obvious formulations fail for opposite reasons (see §5).
      **Live risk:** 8 of 17 open positions sit inside the 4% band the
      picker itself calls minimum-actionable; PANW (score 79, +13%) and
      PLTR (score 73, +37%) are both ~2.2% from liquidation. Operator
      next: arm D4 alone first, then D3, then D2 separately. Branch:
      `cursor/investor-stop-refinement-dbdd`.
- [ ] **Trade Review Agent (2026-08-17).** Independent per-leg grading of
      every ENTRY / TRIM / EXIT, with an operator approve / modify /
      reject loop. Admin page `/trade-review.html`; design in
      [2026-08-17-trade-review-agent.md](2026-08-17-trade-review-agent.md);
      playbook in [skills/trade-review-agent.md](../skills/trade-review-agent.md).
      Built: D1 schema (`trade_reviews`, `trade_review_proposals`,
      `exec_memos`), deterministic capture math (MFE/MAE, capture ratio,
      dominant-move overlay, post-exit continuation, entry geometry),
      reviewer prompt that treats the engine's record as a CLAIM,
      validated JSON output, ledger enqueue hook + nightly drain, eight
      admin endpoints, apply pipeline (learning_proposals tier2 + exec
      memos into CIO memory and CRO synthesis + one-page GitHub issues
      with `agent-ready` label and optional Cursor agent dispatch).
      Verified end-to-end on preprod against real trades: leg extraction,
      capture math, prompt, approve → proposal + memo + one-pager.
      **All flags default OFF.** Operator next: review a dry run, then
      set `trade_review_enabled=true` (and `trade_review_auto_run=true`
      for the nightly drain). GitHub filing needs
      `trade_review_github_enabled=true`; agent dispatch needs a
      `CURSOR_API_KEY` secret. Branch:
      `cursor/trade-review-agent-dbdd`.
- [ ] **July ST autopsy — patterns batches 1+2+3 (2026-08-15).** Operator
      graded 10 short-term July trades (PKG, BRK-B, XLI×2, INTC, MTB, WAL,
      GRNY, KO, CIBR). Batch 3 (CIBR) added: reclaim-sequence entries
      missing from ST lane (Jun 26/29 EMA-21 reclaim + 4H ST break never
      fired; first entry Jul 10 = worst point of leg), no re-entry
      doctrine (+11% second leg watched from flat), leg-maturity
      blindness, SSL/liquidity as context not just stop-plumbing, and a
      NEW duplicate daily-bar bug (Jul 6–10 D candles stored twice,
      indicators double-counted). Batch 4 (GRNI/UNP/KO#2/JCI/PPG) + doc
      solidified (5 root causes). **Targeted July-2026 backtest executed
      in preprod** (gate pack flag-gated, 3 arms): tactical gates lift WR
      27%→45%; grade-empty-at-admission proven as the matrix no-op root
      cause (P0); post-trim floor saves EXEL/AMZN, costs UNP dip-recovery
      (→ needs reclaim movie). **Offense slice (2026-08-16): new
      `tt_htf_reclaim` entry family + six gate-gauntlet carve-outs +
      wildcard grade admission. Tactical config replay: July −1.95% →
      +54.54%, Aug +64.23% → +84.71%; CIBR Jul 30 reclaim +32.1% (the
      operator's meat-of-the-move trade). All flags OFF in prod. Next:
      tune reclaim (failed-reclaim cooldown, market-regime filter),
      recalibrate canon ATH policy, then operator decision on enabling.**
      Tuning pass (2026-08-16): 72h reclaim cooldown validated NEGATIVE
      in July chop (reshuffle cascade blocked JCI +18.5) → shipped as
      default-0 knob; SPY-posture market filter rejected by data (Jul 30
      winners fired with SPY below e21). **GO-LIVE STAGED**: validated
      tactical flag set written to prod model_config (inert until the new
      bundle deploys — old allowlist filters the keys). Merge → CI deploy
      → live at Monday open. Rollback = flip 5 flags false, no deploy.
      Next iterations: max_ext 2.0 validation, cooldown high-confidence
      override, canon ATH recalibration, grade-before-admission +
      tripwires. Forensics vs D1 + tape found 13 patterns: stale/phantom
      entry prints, **phantom exits (4 of 30 audited — KO×2 + JCI
      fabricated SL breaches in the opening minutes, fills booked at the
      SL level)**, opening-window chasing (no TT-setup gate), premium-zone
      + adverse-div admits, ATR/$-cap stops instead of level-anchored
      stops (levels engine is display-only), no expected-move screen
      (GRNY), liquidation-tranche "trims" polluting analytics (WAL),
      non-sticky breakeven ratchet, forced exits at lows, admission matrix
      leaks. Newton August Upticks ingested levels cross-referenced (his
      MTB/TT deletions mirror our July losses). Full analysis + proposed
      engine response:
      [2026-08-15-july-st-autopsy-feedback.md](2026-08-15-july-st-autopsy-feedback.md).
      Awaiting operator confirmation before implementing; more July
      feedback batches incoming. Branch: `cursor/july-st-autopsy-patterns-dbdd`.
      **Batch 5 (2026-08-16, merged PR #1261)**: struct stop guard +
      n-test confirm + forming divergence — armed in prod for Monday.
      **Batch 6 (2026-08-17, PR #1262)**: LTF structure confirmation
      gate (`deep_audit_ja_ltf_structure_confirm`) — blocks LONG
      ATH-breakout/support-bounce into a broken 15m+30m tape unless
      washed out (RSI ≤ 32); pinned 6/6 on DE/WM Jul + SN/PH/RTX Aug
      snapshots; replay Arm L no-harm Jul+Aug; prod flag staged (inert
      until merge). **August autopsy books loaded**:
      `live-short-term-2026-08` (31 trades) +
      `live-long-term-2026-08` (6 positions) — awaiting operator
      grading. Branch: `cursor/ltf-structure-confirm-dbdd`.
- [x] **Macro Minute YouTube ingest (2026-08-13).** PR #1232 merged; `YOUTUBE_API_KEY` live on monolith + tt-research. First run `discovered:0` because discovery used leftover `@fundstrat` (1 video). Live channel is `@Fundstrat_Direct`; last 50 uploads + search have **no current Macro Minute** (daily MM is FSD/Vimeo). PR #718 stays **closed**. Follow-up: [#1234](https://github.com/Shashant7/timedtrading/pull/1234).
- [x] **Broker Connections second pass (2026-08-13).** Operator asked for
      Robinhood-level polish + two bug fixes. Fixed: (1) AXON spurious
      "Partial Fill" email after a clean 50% trim — reconciler now honors
      the unverified post-exec audit as expected qty for 30 min
      (`pendingReducerAudit`); (2) "Too many requests" on Roth IRA/Margin
      positions — signedFetch GET retry + per-account KV positions cache
      with stale fallback. New: day timeline (model actions × mirror
      outcomes with humanized reject reasons), positions with live P&L +
      per-ticker account history + sync-health donut, scoped per-account
      `POST /timed/broker/sync-position` (RTH + flat + cooldown guards,
      single-account routing), Verda chrome + mobile grid on
      `broker-connections.html`. Manifest join fixed to match
      broker_account_id (AXON showed "untracked"). Ops debug:
      `/timed/admin/broker-bridge/day-actions` + `/owner-positions`.
      Deployed worker (both envs) + bridge; verified live against real
      Roth IRA data. Branch: `cursor/broker-page-second-pass-dbdd`.
      **v2 (same day):** sync reworked to NEVER place orders (operator:
      bound buys/sells must not fire because a sync was initiated).
      Model-yes/broker-no = AUTO-SYNC (model buys in its own DCA/catch-up
      windows); model-no/broker-yes = explain only; both-yes-untracked =
      adopt (`adoptUserPosition` manifest sleeve at model-scaled size,
      entry price ignored, excess stays user-owned — institutional
      in-kind funding). Order-placing sync path removed.
- [x] **DCA sweep retry uplevel + notification cleanup (2026-08-12).**
      Operator follow-ups to the NVDA sweep: (1) the single 15:50 shot was
      slow and a single point of failure — now an immediate post-dispatch
      pass (mirror leg off: double-order risk while the route's own mirror
      waitUntil is in flight) plus per-minute retries 15:46–16:15 ET via
      `runDcaSweepGuarded` (KV lock + daily clean-marker; mirror leg only
      while RTH open). (2) Notifications/emails focus on executed actions
      only: removed "Entered Queue" (queue digest email, Discord, bell/web
      push) and "Exit Recommended" advisories (`KANBAN_EXIT` Discord
      hard-off above the mode=all bypass, kanban exit bell insert,
      `TRADE_EXIT_SIGNAL` email). Actual buys/sells/stop-target updates
      unchanged. Deployed both envs. PR #1226,
      branch `cursor/notif-cleanup-retry-uplevel-dbdd`.
- [x] **NVDA 8/11 DCA silent side-effect loss (2026-08-12).** The 15:45 ET
      DCA invocation was hard-killed after the lot INSERT + position bump:
      no ledger row, no decision record, no bell/Discord/email, no broker
      mirror (nightly repair + daily backfill later healed ledger + bell
      only). Fix: `sweepInvestorDcaSideEffects` on a new 15:50 ET cron slot
      (+ manual `POST /timed/admin/investor/dca-sweep`) idempotently heals
      channels/ledger/decision and runs mirror catch-up; catch-up gained
      `trust_fresh_lot_ms` (RTH-elapsed) so thesis gates (`zone_exhausted`)
      cannot veto mirroring a buy the model itself just executed — the
      hourly RTH auto pass sends 60 min, which also self-heals NVDA at the
      next 10:00 ET tick. Decision record healed live; deployed both envs.
      Branch: `cursor/dca-side-effect-sweep-dbdd`.
- [x] **Keepalive overnight soft-fail (2026-08-08).** Feed keepalive emailed on `25de02e`: overnight lightweight age ~270s (normal for */5) + `/feed/run-once` `unauthorized` hard-failed the job. Soft-fail heals, 600s lightweight threshold, OH-gate heartbeat/scoring. Ops: sync GitHub `TIMED_API_KEY` ↔ tt-feed worker secret (kicks stay no-ops until then). Branch: `cursor/keepalive-softfail-df0c`.

- [x] **Cron-stall heal covers heartbeat+scoring (2026-08-07).** Watchdog at 23:39 UTC failed again: prices fresh (~67s) but `cronTickAgeMin`~35m + scoring~46m + chain scoring. Keepalive only kicked `/feed/run-once`. Expanded `feed-keepalive.yml` + watchdog self-heal to stamp `cron:last_5min_tick`, rescore SPY/QQQ/AAPL, stamp `timed:scoring:last_run`. Ops heal applied; health+chain green. Branch: `cursor/cron-stall-heal-df0c`.

- [x] **Feed cron silent stop + keepalive (2026-08-07).** CF Cron Triggers stopped dispatching ~14:53 ET (heartbeat/scoring/REST feed frozen; `/feed/run-once` still worked). Redeployed tt-feed/engine/monolith; added `feed-keepalive.yml` + watchdog self-heal. Branch: `cursor/feed-cron-selfheal-df0c`.


- [ ] **Webull second login in broker mirror (2026-08-11).** Scenario B:
      a second Webull login (own App Key/Secret) mirrored alongside the
      primary. Plan: per-account encrypted App Key/Secret wraps on the
      `#webull#` sub-user rows (same AES-GCM wrap as RH/Webull tokens);
      `signedFetch` accepts a creds override resolved from the user record
      (falls back to env `WEBULL_APP_KEY/SECRET` for the primary login);
      `POST /bridge/webull/oauth/start` accepts `app_key`+`app_secret`+
      `login_label` in personal mode — validates via account list, wraps,
      syncs sub-users as `owner#webull#<label>-<slug>` under the SAME owner
      email so fan-out/enable/status work unchanged. Round 2 (partner
      account): preferred creds storage is now worker secrets named after
      the label (`WEBULL_APP_KEY_ACCT2`/`WEBULL_APP_SECRET_ACCT2`; rotation
      = `wrangler secret put`, no re-connect; inline wrap path kept as
      fallback), and `partner_email` stamps `notify_emails` so drift +
      daily digests for those accounts go to the partner AND
      `BRIDGE_ADMIN_NOTIFY_EMAIL` (timedtrading@gmail.com). Round 3
      (self-service redesign, per operator): app users paste their own
      Webull keys. Plan: (1) bridge — cross-owner mirror participants
      (rows with `mirror_participant=true` + enabled join the order
      dispatch alongside the admin owner; label guard relaxed for a
      fresh owner's first connect), (2) worker — `users.
      broker_connections_enabled` flag (runtime ALTER), admin toggle
      endpoint + flag in `/timed/admin/users` + `/timed/me`, user-scoped
      `/timed/broker/*` proxy endpoints (accounts / webull connect +
      disconnect / enable / caps — all owner-scoped to the session
      email), (3) frontend — Clients page checkbox, avatar-menu "Broker
      Connections" item gated on the flag, new `broker-connections.html`
      self-service page (paste keys → view accounts → per-account mirror
      toggle + caps). ALL SHIPPED + deployed (bridge + worker both envs);
      endpoints smoke-tested live (auth gates + admin toggle round-trip).
      Remaining: partner does the flow end-to-end once provisioned.
      Branch: `cursor/webull-second-login-dbdd`.

- [ ] **Context-first scoring (2026-08-05/06).** Plan:
      [`2026-08-05-context-first-scoring-plan.md`](2026-08-05-context-first-scoring-plan.md).
      Phase 0 (ticker context ledger + optimal window) SHIPPED + backfilled
      (9,826 facts / 309 tickers). Phase 1 (frame digest + armed playbooks,
      SHADOW) SHIPPED — scorer stamps `_context`/`_frames`/`_armed_playbooks`,
      transitions → `decision_records` CONTEXT_SHADOW, hourly rotating ledger
      refresh, report at `GET /timed/admin/context/shadow-report`. NEXT:
      review the shadow report after 3–5 sessions, then Phase 2 (investor
      context component) behind `deep_audit_context_scoring_investor_enabled`.
      Branch: `cursor/context-first-scoring-plan-dbdd`.

- [x] **Investor Aug 5 trim mirror resync (2026-08-06, ops).** Accepted Roth broker qty as post-trim baseline for PLTR(2)/NVDA(1); released trader NVDA orphan claim. CRS/WTS/IWM/GE have **no Roth shares** → bypass (`CLOSED` + `mirror_suppressed=bypass_no_broker_position`). No model qty change, no forced sells. Skill: `skills/broker-bridge.md`.

- [x] **ETH rebuild execution — LIMIT + GTC + ALL session (2026-07-30).**
      After #1188 merge, Roth rebuild dry-run plans 12 names during ETH.
      Webull needs `order_type=LIMIT`, `time_in_force=GTC`,
      `support_trading_session=ALL`, and whole shares (fractionals are
      RTH-only). Wire rebuild → forwardInvestorMirror → bridge →
      `buildOrderBody`. Live ETH places: TWLO/PLTR/NVDA/BNY/EXEL
      (whole-share GTC LIMIT ALL). Expensive names (AMAT/LLY/…) correctly
      reject `account_too_small_for_one_share` until RTH fractionals.
      Branch: `cursor/eth-limit-gtc-rebuild-df0c` (PR #1189).

- [x] **Cron failure triage — unknown + macro SPY + D1 overload (2026-07-31).**
      Discord system-alerts: COO calibration BLOCKED (D1 overloaded),
      `Cron Failure: unknown` with empty body, `macro_cross_asset_refresh`
      `benchmark_SPY_not_loaded`. Root: D1 storm at nightly +
      `recordCronFailure(env, "op", err)` positional calls mapping to
      op=`unknown`. Fix adapter + call sites; re-run macro refresh;
      clear stale tombstones. Branch: `cursor/cron-failure-unknown-fix-df0c`.

- [x] **Roth mirror rebuild — avg_entry band + thesis (2026-07-30).**
      After orphan mark_closed, don't force expired DCA catch-up.
      Rebuild only OPEN investor positions where live is within
      ~−8%…+2% of model `avg_entry`, stage accumulate/core_hold,
      score healthy when present, not exhausted; size = one DCA slice.
      Skip chase (above entry) and deep-underwater stubborn losers.
      `POST /timed/admin/broker-bridge/rebuild-mirror`.
      Branch: `cursor/mirror-rebuild-avg-entry-df0c`.

- [x] **Speculative ATH/N-test admission + min_rr (2026-07-30).**
      DE + WM Speculative LONGs taken post-FOMC Jul 29, SL'd Jul 30.
      Root: Speculative ATH had no matrix row (default ALLOW while
      Confirmed is always blocked); Speculative N-test always allowed
      incl. LATE_BULL; WM R:R ~1.4–1.8 below Prime ATH floor.
      Fix: block Speculative ATH always; Speculative N-test → same
      allow_only_in as Prime + `min_rr: 2.5`.
      Branch: `cursor/speculative-ath-ntest-gates-df0c`.

- [x] **Auto catch-up last-signal-wins + 4h RTH TTL (2026-07-30).**
      After CRS/CW/NVDA buy+trim churn: catch-up now keeps only the
      latest lot per position (older unmatched = superseded), expires
      after 4h of NY RTH (ETH/overnight excluded), aliases trim↔sell for
      ring dedupe, Discord on forward. `BROKER_CATCHUP_AUTO_RTH=true`.
      Branch: `cursor/catchup-buy-trim-churn-df0c`.

- [x] **DE trader EXIT never placed (2026-07-30).** Model closed
      `DE-1785351897700-5d1dzat80` (`sl_breached`); bridge died after
      `review ok`. Ops catchup placed Webull exit `U7HMS3K2AUVE7VI7VM41`.
      Fix: `cursor/de-exit-bridge-abort-df0c` (early mark-closed, release
      claim, 28s reducer timeout, `catchup-exit`).

- [x] **Adaptive catch-up + DCA twin cleanup (2026-07-30).** Operator
      ask: cleanup duplicate DCA lots and only catch up when price +
      thesis still intact. Live D1: reversed 12 twin pairs
      (CRDO/CRS/CW/KO/NVDA/PLTR/TSM/TWLO/WTS); zero twins remain.
      `catchup-investor` gates buys on stage/score/exhaustion/+5% drift
      (`worker/investor-catchup-gates.js`); sells always allowed.
      `dedupe-dca-lots` admin route for future races (no ADJUSTMENT
      double-credit). DCA slot → **3:45 PM ET** (RTH-gated). Transient
      portfolio_reconcile +18.6% after twin-ledger delete cleared after
      COO back-fill (re-sweep ok). Auto RTH hourly catch-up + COO heal
      on bridge coverage (`runInvestorCatchup`, max 8 ops, gated buys).
      Branch: `cursor/investor-dca-ledger-dup-df0c`.

- [x] **Post-execution audit — verify every reducer reached the broker
      (2026-07-27).** Operator ask after the KO trim was oversold:
      "post action we must check did our action result in what we
      expected. If not, an execution signal may have been blocked or
      dropped." Every successful TRIM/EXIT/CLOSE now stamps
      `mirror_trade_manifest.sync_last_action_json` with pre-held,
      intended, and expected-post-held qtys; the next reconciler cycle
      (5 min, cadence-eligible) compares live held vs expected —
      match within 0.05 sh dust → `post_exec_verified` receipt;
      drift → `post_exec_drift` critical notification. Runtime
      `investor_signal_bridge_coverage` sanity check (fast, 15-min
      cron) pages `fail` when an `investor_lots` SELL has no matching
      `bridge:client:recent` entry — catches the "signal never left
      the monolith" case (the KO event-risk gap). Together with the
      compile-time source-contract test that stops the regression at
      PR time. 33 new tests (post-exec audit + coverage + reconciler).
      Branch: `cursor/model-broker-execution-audit-df0c`.

- [x] **Bridge full sweep — three silent bugs (2026-07-24).** Post
      NVDA/TT-trim sweep found: (1) `writeEntryManifest` wrote
      `broker_remaining_qty` as the unfilled remainder → fully-filled
      entries got `remaining=0`; (2) reconciler scanned 0 rows every
      cycle (manifest rows carry base user_id, reconcile iterates
      per-account users) — Phase C had never run; (3) Webull fill
      reconcile hit a nonexistent endpoint (`POST
      /openapi/trade/orders/list` 404) and reported it as `scanned=0` —
      verified `GET /openapi/trade/order/history`, flatten combo groups,
      map `filled_price`. All 12 roth positions verified in-sync vs
      live broker. Branch: `cursor/trim-reduce-pct-sanitize-df0c`.

- [x] **Investor DCA double ledger cash (2026-07-23).** Sanity
      portfolio_reconcile −18.9%: ledger repair matched DCA_BUY lots only
      to ENTRY and back-filled duplicates beside real DCA_BUY rows
      (−$16k cash); KO/TWLO/PLTR positions also missed a concurrent DCA
      lot (+$6k cost drift). Fix matcher + dedupe + atomic DCA update.
      Branch: `cursor/investor-dca-ledger-dup-df0c`.

- [x] **FSD rewrite stale model levels (2026-07-23).** Research notes
      cited TSLA stop $373 / tp $338 from stale `timed:all:snapshot`
      while live was ~$320. Prefer freshest payload + live price overlay;
      omit divergent plan levels; auto-refresh rewrites when px drifts;
      force-rewrite pubs 1544806/1544826. Branch:
      `cursor/fsd-rewrite-fresh-levels-df0c`.

- [x] **Sector Flow mobile h-scroll (2026-07-23).** Leader chips were
      full-width vertical stacks on mobile. Horizontal rails + denser
      cards; offense/defense meter; vs-sector on names; Wave restyle.
      Branch: `cursor/sector-flow-hscroll-df0c`.

- [x] **Mobile Tab Nav jump/snap on scroll (2026-07-23).** v7
      visualViewport top writes every frame fought Safari chrome →
      jump up then snap back. v8: CSS `bottom:0` only; settle after
      scrollend/debounce; no vv scroll listener. SW `tt-shell-v8`.
      Branch: `cursor/tab-nav-no-jitter-df0c`.

- [x] **Mobile Tab Nav still floats on scroll (2026-07-23).** v6
      `bottom:0` still shifts mid-page on iOS Safari 26 chrome collapse.
      Pin with visualViewport `top` (no transform); SW `tt-shell-v7`.
      Branch: `cursor/tab-nav-vv-pin-df0c`.

- [x] **Email setup TT brand (2026-07-23).** Setup line title-cased
      `tt_n_test_support` → "Tt N Test Support". Use formatEmailSetupName
      so it shows "TT Support Bounce" / never "Tt". Branch:
      `cursor/email-setup-tt-brand-df0c`.

- [x] **RTX double trim (2026-07-23).** Same minute: ripster_pdz_mfe_trim
      50% then RUNNER_PEAK_TRIM_LADDER +15% at same $207.98. Ladder used
      entry/stale peak as anchor. Fix: no entry fallback, max-anchor,
      5m cooldown, hydrate trim_price on getOpenPositionAsTrade, clear
      peak on entry. Branch: `cursor/rtx-trim-pct-email-df0c`.

- [x] **RTX trim email/signal % (2026-07-23).** TRADE_TRIM email Trim Status
      treated `newTrimmedPct` fraction (0.5) as percent → "Trimmed 1% /
      Remaining 100%". Normalize via `toTrimPctPoints`; fix in-app notif
      body. Branch: `cursor/rtx-trim-pct-email-df0c`.


- [x] **Nav / brief terms / AAPL BMO (2026-07-23).** (1) Tab Nav still
      scrolls mid-page on iOS — drop transform/backdrop-filter on
      `.tt-bn` and re-pin on scroll. (2) Daily Brief prompts still say
      Trader/Investor — switch to Short Term / Long Term. (3) AAPL
      07-23 BMO is wrong (real print ~07-30 AMC); stop defaulting hour
      to bmo; hide already-reported rows from upcoming chips.
      Branch: `cursor/nav-brief-earnings-df0c`.

- [x] **Mobile Tab Nav floating mid-page (2026-07-23).** After #1155 the
      bar reappeared but sits above a large gap — visualViewport URL-bar
      translate (22% cap) still pushes it up. Pin to bottom:0 + safe-area
      only; drop URL-bar transform. Branch: `cursor/mobile-tab-nav-pin-df0c`.

- [x] **Mobile Tab Nav missing (2026-07-23).** Bottom nav gone on Today
      (iPhone). Likely false-positive keyboard hide in
      `syncNavToVisualViewport` when Safari chrome expands (vvH &lt; 65%
      innerH). Gate hide on focused input; fix 5-col grid; bump SW.
      Branch: `cursor/mobile-tab-nav-df0c`.

- [x] **Rail EXT + compact movers chips (2026-07-23).** Some tickers
      (NOW reverse premkt) hide EXT on right-rail header because
      `getExtChange` still kills opposite-direction >4% AH vs RTH.
      Compact EXT movers chips also render dollar price and overflow.
      Branch: `cursor/ext-price-rail-movers-df0c`.

- [ ] **Universe orphans → hard gaps only (2026-07-23).** Watchdog paged
      at 5:29am ET on 18 soft orphans (quality/profile). Treat missing TF /
      unscored as hard; thin ETFs (SPCX/GRNI) stay soft. Fix htf_score===0
      false unscored. Branch: `cursor/orphan-hard-gaps-df0c`.

- [x] **Today strip copy simplify (2026-07-23).** Shorten Ready / Families /
      Growth / Technicals / Convexity blurbs; drop Model Queue comparisons;
      cut "Setup" overuse (READY, FAMILIES, TECHNICALS); align Growth +
      Technicals heads to `tt-ready__head`. Branch:
      `cursor/strip-copy-simplify-df0c`.

- [x] **Webull Roth next ST/LT order must place (2026-07-23).** Live
      entries reached Roth review then failed on TRADE_FRACT_PRO. Fix:
      whole-share retry with fresh `client_order_id`, stamp
      `fractional_agreement_missing` on resolved Roth user (not owner
      email), `WEBULL_DEFAULT_ACCOUNT_CLASS=ROTH_IRA`. Branch:
      `cursor/webull-roth-order-fire-df0c`.

- [x] **CF long-term capture replication (2026-07-23).** Forensic: CF
      compounder_dip_buy @ $115.90 → ~+10%; thesis null; monthly DCA only.
      Tighten confirmed dips; exhaustion-order + growth_strong override;
      persist/heal thesis on auto-open; pullback-opportunistic DCA for
      FSD/compounder/FV-discount. Plan:
      [`plans/cf-long-term-capture.plan.md`](../plans/cf-long-term-capture.plan.md).
      Branch: `cursor/cf-long-term-capture-df0c`.
      Follow-ups: Short Term pullback rank relief on quality dips; Model
      open-lane cards must not show ghost defend/trim without a live book
      row (missing POSITION bars). Convenience heal
      (`healInvestorPositionConvenience`) on compute + rebalance so D1
      thesis/invalidation/DCA never stay null.

- [x] **Action provenance for Short Term + every lifecycle event (2026-07-23).**
      Operator: provenance for the self-calibrating loop — "short term trades
      as well." Every ENTRY/TRIM/DEFEND/EXIT/SCALE_IN stamps referenceable
      technical + research inputs into `decision_records.inputs_json` via
      `worker/action-provenance.js` (`d1InsertTradeEvent` + DEFEND + execution
      adapter). Branch: `cursor/cf-long-term-capture-df0c`.

- [ ] **Model-first UX consolidation (2026-07-22).** Operator: "merge trader
      and investor … one section, model, with its own lanes … users complain
      it is hard to follow." Stages:
      1. Rail tabs: Trade→"Short Term", Invest→"Long Term" (labels only;
         internal keys unchanged).
      2. Now tab: slim to VerdictGuide (Short term + Long term + Key levels
         · live) — remove POV toggle, hero verdict cards, portfolio strip,
         "More detail" accordion. Key Levels ladder must include the OPEN
         POSITION trader SL (position_sl), not just the verdict stop.
      3. Short Term tab: keep Entry Decision (open position), Timing,
         Trade/Position/Model Plan, Reference Levels. Remove Setup, Profile,
         Sector & Market, Sequence panels (+ dead panels).
      4. Long Term tab: stop rendering VerdictGuideBlock on INVESTOR tab
         (it stays on Now only). Keep InvestorTabPanel body.
      5. Active Trader page lanes → Model lanes: Queuing Up / Bought /
         Defending / Trimming / Exited; fold investor holdings into the same
         lanes (stage mapping research_on_watch+accumulate_queued→Queuing Up,
         accumulate_entered+core_hold+watch→Bought, reduce→Trimming,
         exited→Exited) rendered with the ATCard shell.
      6. Options tab: light design uplevel (spacing/hierarchy only).
      Branch: `cursor/model-first-ux-df0c`.

- [x] **OpEx on macro calendar + entry/exit risk (2026-07-19).**
      Market-wide monthly options expiration (3rd Friday / triple witching)
      was missing from the curated macro calendar and pre-event gates.
      Generate OpEx into Today/Brief calendar; sync `market_events`; add
      `OPEX` to PRE_EVENT_RISK (8h window into 4 PM ET) for entry block +
      PRE_OPEX_RISK_REDUCTION trims. Branch: `cursor/opex-macro-risk-df0c`.

- [ ] **Confirm-stack EMA21 thin slice — build the instrument (2026-07-19).**
      Not "flip flags after n≥30". One family end-to-end under unified
      lifecycle + play UI. Plan:
      [`plans/confirm-stack-ema21-slice.plan.md`](../plans/confirm-stack-ema21-slice.plan.md).
      Today strip + `/timed/plays/today` slice fields shipping. Next: sequence
      may propose Queued (tiny/paper); Tier-A RIDE options-first stamp;
      capture/MFE attribution vs 4.8% baseline; widen only if OOS holds.

- [ ] **Unified Model Lifecycle — trust the process (2026-07-19).**
      Product reframe: Active Trader vs Investor are the same actions
      (buy/trim/sell) with different horizons — not different products.
      Canonical states: Watching → Queued → Bought → Held → Trimming → Exited.
      Plan: [`plans/unified-model-lifecycle.plan.md`](../plans/unified-model-lifecycle.plan.md).
      Contract + play vehicles + gated sim-fill on PR #1119/#1120. UI continues
      via confirm-stack thin slice (Today surface).

- [x] **Bubble map colors → design-system restrained tones (2026-07-17).**
      Alignment fills were neon (#22c55e / #b91c1c / #eab308) at ~0.92 opacity.
      Retone to `--tt-success` / `--ds-dn` / `--ds-accent-soft`, lower fill
      opacity, soften corridors + quadrant labels; legends read shared
      `ALIGN_FILL`. Branch: `cursor/bubble-map-ds-tones-df0c`.

- [x] **Today bubble Open Positions missing Investor (2026-07-17).**
      Open Positions chip / bubble map only attached Active Trader
      `useOpenTrades` (`/timed/trades?source=positions`). Investor opens from
      `/timed/investor/positions` already power the hero Open Positions strip
      and Daily Brief bubble, but not Today’s chip filter. Merge investor
      opens into allTickers (`has_open_position` + `_openInvestor`) so both
      books show. Branch: `cursor/today-bubble-investor-open-df0c`.

- [x] **Watchdog overlay false page — AAPL zombie `_live_price` (2026-07-17).**
      External watchdog red twice (14:13 / 15:58 UTC) on
      `chain-smoke: overlay AAPL:diverge≈7.3%` while feed/candles/scoring OK
      and `timed:prices` AAPL matched settled `price`/`close`. Root cause:
      `timed:latest:AAPL._live_price` stuck ~307 vs ~332; chain-smoke preferred
      `_live_price`; `mergeFreshnessIntoLatest` updated price/close but not
      `_live_price`. Fix: smoke picks closer/settled price; merge stamps
      `_live_price`. Branch: `cursor/watchdog-overlay-zombie-df0c`. PR #1115.
      Deployed monolith + tt-feed; chain overlay AAPL diverge now ~0.07%.

- [x] **UNP false early_dead_money flatten (2026-07-15).** LONG trimmed 65% green
      day 1; day 2 runner flattened at −1.25% via `early_dead_money_flatten` while
      SL 277.92 untouched; next day rallied to 297. Live `getPositionContext` lacked
      MFE/`__tradeRef` so gate saw MFE=0. Enrich context + trim-exempt dead-money.
      Branch: `cursor/unp-dead-money-mfe-df0c`.

- [x] **Daily `price_value_freshness` Discord noise (2026-07-15).** Open-ramp pages
      ≥300 overnight-stale symbols at 9:30 ET every day (Discord ≥10 vs watchdog ≥40);
      REST heal rewrote `q_ts` from aged vendor `trade_ts` so rows never cleared.
      Stamp receipt `q_ts` on REST/heal; page at ≥40; 20m RTH-open grace.
      Branch: `cursor/price-value-freshness-noise-df0c`. PR #1113. Deployed.

- [x] **Premarket warm by 9:00 ET (2026-07-15).** Stale sweep used 26h threshold
      whenever `!RTH`, so overnight ages never healed during 4 AM–9:30 despite
      REST. Use RTH-style sweep during extended session; page from 9:00 ET if still
      ≥40; shrink open grace to 5m. Same branch/PR #1113.

- [x] **Bubble legend R:R/Prob + mixed tilde (2026-07-14).** Legend shows Size=R:R
      and High Prob stroke; mixed = subtle "~" on bubble + legend (AT/Investor/
      Today/Brief). Branch: `cursor/bubble-legend-mixed-df0c`.


- [x] **LEAP premium vs live chain + health watchdog (2026-07-14).** AEHR LEAP
      was priced off the swing (~66 DTE) chain while labeled Jan LEAP. Fetch LEAP
      cycle separately; rebind leg after strike refine; intrinsic floor on mid.
      Watchdog: exclude BTC/ETH from RTH valueStale; fail threshold 40 (notice 15).
      Branch: `cursor/leap-premium-health-df0c`.


- [x] **Bubble map: fix mixed encode + zoom/pan (2026-07-14).** Map
      `HTF_BEAR_LTF_PULLBACK` → bear_mixed (bounce); soften weak aligned →
      mixed with diameter; zoom/pan controls; From=disc Lean=arrow.
      Branch: `cursor/bubble-map-mixed-zoom-df0c`.


- [x] **Bubble vector polish (2026-07-14).** Rim-anchored From/Lean markers
      (halo shaft, origin disc, cyan arrowhead) so history/lean readable on
      large bubbles. Branch: `cursor/bubble-vector-polish-df0c`.


- [x] **Stream preserves RTH `p` outside RTH (IBM Jul 14).** Real ~−23% AH
      dump was valid, but WS flush wrote AH onto `timed:prices.p` so RTH
      movers/headline also showed −23%. Session-aware `buildStreamFlushRow` +
      merge remap. Branch: `cursor/stream-ah-preserve-rth-df0c`.

- [x] **Daily Brief email position stacks (2026-07-13).** Investor Portfolio +
      Active Trader email sections now render chip — guidance per holding (parity
      with web `BriefPositionStack`), not grouped chips then grouped bullets.
      Branch: `cursor/email-brief-position-stack-df0c`.

- [x] **Bubble map encode refresh (2026-07-14).** Alignment fills (mixed =
      diameter line, Pullback = yellow); size = R:R to Target 2; stroke =
      probability (none/dotted/solid); subtle from/forecast vectors.
      Branch: `cursor/bubble-map-encode-df0c`.

- [x] **Convexity Plays row + Now tab panel (2026-06-15).** Single universe strip
      (lotto + moonshot); Snapshot panel when aligned; no suppressed list; Pro gate;
      READY lotto at floor; investor lane included. Branch: `cursor/convexity-plays-df0c`.

- [x] **Trader plan / Now tab posture alignment (2026-07-08).** When LTF lean
      conflicts with HTF contract on watch/setup (INTU), align Trade Plan +
      Now invalidation to posture; HTF template as alternate note.
      Branch: `cursor/trader-plan-posture-align-ca70`. Merged PR #1065.

- [x] **Market Pulse closed-market price hardening (2026-07-08).** Headline =
      RTH close; EXT on _ah_*; WS tick_batch must not wipe EXT or promote
      extended print to headline. Branch: `cursor/market-pulse-closed-price-ca70`.

- [x] **KO 4 AM false SL exit (2026-07-13).** Feed cron hard-closed KO at 4:01 AM
      ET with stale KV entry ($83.39) vs D1 VWAP ($80.34). Fix: feed-only SL
      checks, outside-RTH defer, authoritative entry at close/email.
      Branch: `cursor/ko-feed-sl-fix-df0c`.

- [x] **Daily Brief earnings + polish (2026-07-13).** Fix "light earnings week"
      when big banks reporting; prioritize week calendar; structured Earnings
      Watch digest. Branch: `cursor/daily-brief-earnings-polish-df0c`. PR #1099.

- [ ] **Options shadow mode (2026-07-08).** Long call/put shadow plays on
      trader + investor entry Discord/email (`OPTIONS_SHADOW_MODE=1`).
      Plan: [`2026-07-08-options-shadow-mode-plan.md`](2026-07-08-options-shadow-mode-plan.md).
      PR: `cursor/options-shadow-mode-df0c`. Next: enable on tt-engine preprod,
      forward-grade `desk:shadow` ledger rows, then MC vehicle enable + IBKR mirror.

- [ ] **TT Trust Spine — north star plan** ([`plans/tt-trust-spine.plan.md`](../plans/tt-trust-spine.plan.md)).
      Foundation merged (PR #1037). Complete wiring in progress (PR
      `cursor/tt-trust-spine-complete-dbdd`): trust-spine routes, autonomy
      ladder, scorecard CI, portfolio sector cap + DD size haircut, options-first
      tier-A RIDE, engine-snapshot `trust_spine`, decision-card provenance.
      Next: forward conviction validation, broker manifest `log`→`on`, notification
      taxonomy, SI autonomy UI.

- [x] **Harmonic Wave integration (2026-07-08).** Phase A + soft modifiers
      (rank tilt, size mult, trim advisory, investor bias) with CIO vetting on
      all paths. Branch: `cursor/harmonic-wave-integration-ca70`.

- [ ] **Bugbot fixes (#997/#998/#1001) — PR #1002 (ready for review; Bugbot pending).**
      Fixes: ReadySetupsBoard `embedded` prop, VerdictGuideBlock key levels,
      exited names in BUY ZONE strip, TimedRailHelpers investor helper wiring.
      **Process:** always wait for Bugbot + human review before merging PRs.

- [x] **NVDA feed SL hard-close (2026-07-02).** */1 price-feed now triggers
      immediate `processTradeSimulation` hard close on confirmed SL breach
      (worst-case price via `feed-sl-close.js`). TRADE UPDATE + OOH reconcile
      pass `openTrade` into `hydrateTickerDataForTradeMgmt`. Admin:
      `GET /timed/admin/feed-sl-triggers`. tt-feed relays via
      `POST /timed/internal/feed-sl-close`.

- [x] **Breaker phantom pollution fix (2026-07-01).** Loop 2 + portfolio-risk
      exclude fast hard-exit round-trips and impossible `sl_breached` rows;
      live queries scoped to `run_id IS NULL`; regime-shock suppressed when
      book is flat; admin `POST /timed/admin/portfolio-risk/reset-samples`;
      Loop 2 pause auto-clears on healthy pulse.

- [x] **Investor alert templates + candle freshness (2026-07-02).** EXIT vs
      TRIM digest fix, templated Discord/email (shares, levels, CIO, 1H chart),
      sanity sweep candle streak gate.

- [ ] **Setup sequence shadow awakening (2026-06-21).** Tier A+B replay
      complete (211 moves, 96% sequence yield). Verdict:
      `docs/setup-mining-tier-ab-verdict-2026-06-21.md`. Shipped:
      alignment section in aggregate report, `SETUP_SHADOW_STAMP` on scoring
      payload (`setup_sequences` + `setup_shadow_posture`), right-rail inline
      shadow read. L2 live gate pending trail pair depth on prod fixtures.
      **No `SEQUENCE_ENTRY_GATE` until forward shadow validates aligned capture.**

- [x] **Gate simulation + TD9 parity (2026-06-22, PR #775).** TD9 daily
      transition fix (0%→12% backtest coverage). Expanded gate sim +
      timing pass + SETUP_GATE_SHADOW on preprod/tt-engine.
      `docs/setup-mining-gate-timing-shadow-2026-06-22.md`. **Next:**
      deploy tt-engine with SETUP_GATE_SHADOW; forward shadow validation.

- [x] **D1 billing 80M threshold (2026-06-22).** Investigated + documented.
      No fix — Jun 18 mining burst + normal RTH; ENGINE_EXTERNAL cutover OK.
      `docs/d1-billing-investigation-2026-06-22.md`. Re-assess next month.

- [x] **Setup-mining Tier A sequence yield (2026-06-20).** Root cause: preprod
      `timed_trail` rows had `flags_json` only (0/3318 `payload_json` for KLAC).
      Fix: auto-write `sequence_trail` snapshots when `SETUP_TRAIL_SNAPSHOT=1`
      (preprod wrangler var), richer `snapshotFromTrailScalars`, `--force-replay`
      + payload warnings in replay script. Deploy preprod; KLAC smoke: 4→51 events,
      sequence detected with 1 day of payload backfill. Full Tier A re-run needs
      `--force-replay` on `replay-move-windows.mjs`.

- [x] **Investor compliance + model voice (2026-06-15, PR #733).** Model-voice
      copy; structural reduce bypass; sticky invalidation. Merged + deployed.

- [x] **Investor schedule + candle heal (2026-06-15, PR #735).** Primary
      rebalance 10:30 AM ET; score 4 AM–8 PM ET hourly; RTH portfolio actions
      every hour. Merged + deployed.

- [x] **Investor invalidation → auto-rebalance exit (2026-06-15, PR #729).**
      primary invalidation price breach into live auto-rebalance (full exit,
      no CIO gate). Sticky invalidation for owned positions so floors don't
      ratchet down on a drop. Branch: `cursor/investor-invalidation-exit-df0c`.
      Merged PR #729.

- [x] **Active Trader alert parity (2026-06-15).** Entry: await
      d1InsertNotification + dispatchTradeAlertEmails; rich notification
      body; full Discord parity in email (signal quality, why entered,
      scale hint, vehicle pick). Exit signal suppressed when flat-price /
      shield / min-age / Trend-Hold block close. Branch:
      `cursor/active-trader-alerts-df0c`.

- [x] **CTO universe + tiered refresh (2026-06-11).** Drop screener
      candidates from CTO focus; use scored universe (`SECTOR_MAP` +
      user-added). Hourly intraday CRO refreshes indices + open positions
      (1h cache, 45s cap); daily full CRO pass refreshes remainder (24h
      cache, 4m cap). Rollup merge preserves cached rows; D1 audit only on
      fresh compute. Branch: `cursor/cto-universe-refresh-7b37`.

- [x] **Performance tuning + journey-page design unification + docs
      (2026-06-10, PR pending).** Frontend perf pass (defer-everything,
      vendored CDN libs, immutable `?v=` caching via `_worker.js`,
      single font @import, speculation-rules prerender, CSS stamping in
      build); Active Trader + Investor restyled to Today's Verda
      language (shared `.tt-disclose`/`.tt-status` in tt-tokens.css,
      full `:root` repoints, guides collapsed by default); docs
      refreshed for new agents (CONTEXT stack/topology + perf doctrine,
      DESIGN canonical patterns, AGENTS repo map, new skills:
      `worker-topology.md`, `frontend-performance.md`). Plan:
      `tasks/2026-06-10-perf-design-docs-plan.md`.
- [x] **Accumulate lane clarity — execution-ready only (PR pending).**
      LITE/ASTS showed in ACCUMULATE (BUY NOW) but detail panel said
      WATCH. Fix: kanban demotes monitor/stale accumulate rows to On
      Radar / Hold & Watch; scores GET revalidates accumulate/reduce
      rows at read time; hide "monitoring for trigger" on act_now/ready.
- [x] **Timing plumbing — extension dump orchestration (PR #509).**
      Unified TD9/phase/RSI/Markov/VIX/FSD into `timing-signals.js`;
      fixed broken `detectExhaustionWarnings` per_tf path; L6 DeMark bear
      fix; confluence FADE SHORT overlay; index put gate; kanban trim;
      Discord INDEX EXTENSION WATCH; proactive alerts; Trader tab Timing
      panel; worker deployed default + production.
- [x] **DIA day-trade archival — canonical scenario + grading (PR pending).**
      DIA morning triggers were NULL on 2026-06-05 because archival read
      `diaTechnical` (D-candles only) instead of `buildTickerScenario`.
      Patched: `diaScenario` in gather, DIA in infographic.indices, D1
      insert prefers scenario game plan; right-rail day-trade panel includes DIA.
- [x] **Discord: link-flow button + welcome email rules (PR #438).**
- [x] **Holistic MC smoke-test skill + polish-sweep logic verdict (PR #439).**
- [x] **Investor alerts: explicit ACTION verb + chart in email (PR #440).**
- [x] **MC: editable modes + archetypes for options auto-mirror (PR #437).**
- [x] **Mobile nav + day-trade card clarity + right-rail integration (PR #441).**
- [x] **Setup-name upstream stamp fix + CIO lifecycle coverage thoughts
      (PR pending).** Operator: "I also noticed there was a setup name
      stamp issue upstream mentioned" + "My lean on AI CIO is to have
      it on for all trade lifecycle decisions, thoughts?". (a) Upstream
      stamp fix: `worker/index.js` `d1UpsertTrade` had a DUPLICATE of
      the old `formatSetupName` regex fallback that never got the
      PR #432 fix — `tt_atl_breakdown` landed in D1 as `"TT Tt Atl
      Breakdown"`. Replaced with direct `formatSetupName()` call (single
      source of truth) + new `_trimSetupNameForDir()` inline helper that
      applies the SETUP_DIRECTION_PAIRS swap at WRITE time. Logs every
      swap with trade_id + ticker + entry_path so we can identify the
      upstream caller. 5/5 smoke-test scenarios pass. (b) CIO coverage
      doc at `tasks/2026-06-01-ai-cio-lifecycle-coverage-thoughts.md`:
      recommends phased rollout (Phase 1 = Investor auto-rebalance trim
      next session; Phases 2-5 sequential) with three guardrails
      (latency cap, monthly $ cap, differential override logging).
- [x] **Day-trade options plays + Options-tab loading overlay (PR #436).**
- [x] **Calibration UX polish (PR #435).** Three additions to System
      Intelligence → Analysis tab: (a) Calibration explainer card at
      the top — plain-language "what calibration does, where it shows
      up, how to use this page" with a right-aligned freshness chip
      (FRESH <6h / OK <24h / STALE >24h based on time since last Run
      Analysis). (b) Run-status toast after Run Analysis completes —
      "✓ Analysis complete — N recs from M trades (Xs)" success or
      "✗ Analysis failed: <error> (Xs)" — auto-dismisses 6s.
      (c) Freshness chip on the Deep Audit header with the same
      colour ladder + tooltip explaining the STALE case. Operator no
      longer guesses whether Run Analysis did anything or whether
      recommendations are current.
- [x] **Setup-name display: tt_* keys mapped + direction-aware swap
      (PR #432).** Discord DIA exit embed showed "Setup: Atl Breakdown"
      for a LONG. Two bugs: (a) SETUP_NAME_MAP missed `tt_*` paths, so
      `formatSetupName` fell through to a regex that produced
      "TT Tt Ath Breakout" (phantom "Tt" word from `tt_` getting
      title-cased) — now every `tt_*` entry path is mapped explicitly
      and the fallback regex strips a leading `tt_` first; (b) some
      upstream write path stamps a stale/mis-derived setup_name —
      added a direction-aware swap in `prettySetupName(name, direction)`
      that converts a stored LONG/SHORT-mismatched setup to the
      direction-correct paired name at render time. Logs warn so we
      can trace the upstream stamp bug. Trim + exit embed call sites
      pass direction. 9/9 smoke test scenarios pass.
- [x] **Freshness monitor heals before paging + chart SVG sl=0 trap
      (PR pending).** Two polish-phase bugs in one PR. (1) `candle_
      freshness_60` paged for BK at 71.5h stale even though the auto-
      heal was about to clear it. Reordered to detect → heal → re-check
      → page only if still stale; page text now distinguishes "real
      data problem (auto-heal attempted, still stale)" from the
      transient case. (2) DIA exit email rendered an empty chart
      because `sl=0` got coerced to a real annotation
      (`Number.isFinite(Number(null))` is `true`), expanding the
      y-axis from $0 to $539 and squeezing the actual price action
      ($509-$511) into a tiny squiggle at the top. Three defenses:
      email.js skips sl/tp on EXITs entirely; URL-encode requires
      `>0`; chart-svg.js helper requires `Number.isFinite(v) && v > 0`
      AND filters annotations >30% off the price midpoint.
- [x] **Reliability sweep: investor compute retry + manifest stale-bridge
      hint + toxic-ticker safety (PR #433).** Three independent
      polish-phase fixes in one PR. (1) Investor cron now retries
      `/timed/investor/compute` 3× with 0/8/30s backoff on 5xx/408/429
      before tombstoning — single transient 503s no longer page.
      (2) MC manifest 404 surfaces actionable remediation hint
      ("redeploy worker-bridge" for 404, "key mismatch" for 401)
      instead of just raw upstream error. (3) Auto-ban toxic tickers
      now has three safety layers: min sample 3→5, open-position
      protection (any ticker with an OPEN trade is excluded — covers
      the TSM/AMZN case), recency recovery (last-10 trades SQN >= 0
      overrides historical SQN). Card discloses both banned and
      protected tickers with per-ticker context; if all candidates
      protected, the `config` payload is omitted so Apply doesn't
      clear an existing blacklist.
- [x] **ETF stagnant-exit HTF gate (DIA 2026-06-01 audit, PR pending).**
      Operator flagged a DIA LONG cut at +0.28% via `etf stagnant exit`
      while the live MTF chart showed bullish Monthly + Weekly + Daily
      and a clear 30m coil-before-break — DIA rallied minutes after the
      cut and is currently at $511.21 (vs. our $510.67 fill). The
      `etf_fast_cut_zero_mfe` branch fired correctly per its own logic
      (4h elapsed + MFE<0.05%) but didn't know the trade was sitting in
      a constructive HTF coil. Fix: optional `htfContext` parameter to
      `checkEtfStagnantExit()` defers the cut when LONG + monthly
      bullish + above D-EMA200 + LTF squeeze (mirror for SHORT). Other
      branches (dead-money, pnl-negative fast-cut) unchanged so genuine
      slow+losing trades still get cut. Smoke-tested 8 scenarios; only
      the exact "HTF-aligned coil" pattern defers. Full investigation
      writeup in `tasks/2026-06-01-dia-stagnant-exit-investigation.md`.
- [x] **Screener Promotion Queue: per-ticker decision inheritance +
      Discovery Thesis in Snapshot right rail (PR pending).** Operator
      flagged: (1) "SMCI, SNOW showed up again, I thought we already
      added those" and (2) "the justification text is money, can we
      incorporate that into Snapshot Right Rail?". Two fixes: (a)
      `worker/discovery/promotion-queue.js` `rebuildPromotionQueue` now
      looks up the most recent decision for each ticker across ALL
      candidate_ids before creating today's row — `approved`/`declined`
      decisions inherit forward so a previously-decided ticker stays
      decided. Smoke-tested prior-approved/declined/new-ticker paths.
      `IN UNIVERSE` badge added to `react-app/screener.html` cards for
      visual confirmation. (b) New `loadThesisForTicker()` helper +
      `GET /timed/screener/thesis?ticker=SYM` endpoint (CF Access, 5-min
      KV cache). New Discovery Thesis Panel in
      `react-app/shared-right-rail.js` Snapshot tab — sits between
      Today and Regime Forecast, shows status chip + score in header,
      thesis paragraph in body, red flags as inline chips. Silently
      absent for tickers without a promotion-queue record (legacy
      universe names — don't fabricate).
- [x] **Investor card: Invalidation prices + LEAP (not Straddle) for
      Investor mode (PR pending).** Operator on CRS Investor card asked
      (1) "add price reference for Monthly ST and Weekly EMA(200) in
      the Invalidation thesis" and (2) "the Options Play is a Long
      Straddle — if we are accumulating LONG, why a direction-neutral
      play?". Two fixes: (a) `worker/indicators.js` exposes new
      `weekly_bundle` (mirror of `monthly_bundle`) with `supertrend_line`
      + `ema200`; `worker/investor.js` `generateThesis` appends actual
      price (`$XXX.XX`) to ST/EMA invalidation strings and ordinal
      `(currently NNrd)` to RS-rank strings — converts
      `"Price closes below Weekly EMA(200)"` → `"Price closes below
      Weekly EMA(200) ($435.20)"`. (b) `worker/options-plays.js`
      `buildOptionsLadder` was treating the trader-side
      `confluence.mode==="WAIT"` (a short-horizon "no 1-5d direction"
      verdict) as authority to strip all directional plays — so the
      Investor LEAP was being suppressed and only the direction-neutral
      Long Straddle survived for CRS. Now `suppressDirectional` is
      gated on `!isInvestorMode`; Long Straddle is excluded entirely
      from Investor mode regardless of vol/verdict (Investor thesis is
      directional by definition). Trader mode keeps the existing
      behavior (straddle still surfaces at high vol or on WAIT verdict).
      Smoke-tested 5 scenarios across trader/investor × WAIT/RIDE/high-vol;
      CRS Investor + WAIT now yields LEAP as primary (was straddle).
- [x] **Loop 2 breaker: duration-bias-aware (PR pending).** Operator paged
      twice for `wr_20` (Last 10 WR 20%, today -1.15%) while the open
      book was up — classic survivorship bias. `loop2ComputePulse` now
      also returns `profit_factor` + `expectancy_pct`; new
      `loop2ComputeOpenBookMetrics` computes open MTM and today-delta;
      `loop2EvaluatePulse` defers any trip when EITHER PF ≥ 1.3 OR
      combined-today (realized + open delta) ≥ -0.5% (both knobs in
      `model_config`). Discord alert now shows the combined view next
      to the closed-only headline so operators see whether the trip is
      a real regime breakdown or a closed-WR headline. Tunable: PR adds
      `loop2_breaker_pf_safe` + `loop2_breaker_combined_safe_pct`.
      CIO memory gains Layer 16 `engine_pulse` (same metrics + a
      `bias_note: "closed_wr is duration-biased downward; profit_factor
      + combined_today are the unbiased view"`). CIO system prompt
      gains a DURATION-BIAS WARNING section telling the LLM to weight
      PF + combined over WR and forbids citing WR alone in reasoning.
      Backward compat: pulses without the new fields fall back to
      closed-only legacy behavior. Smoke-tested 4 scenarios (duration-
      bias case, real breakdown, no open-book data, low-PF + bad
      open-book) — all behave correctly.
- [x] **Investor cards out of sync with Discord entries (PR pending).**
      Operator screenshotted 6 fresh Discord entries (CRS, IESC, FSLR,
      WTS, ASTS, TSM LONG) at 11 AM and the matching kanban tiles
      showing NO OWNED chip. Three independent bugs collapsed into one
      complaint: (1) `InvestorPanel.fetchData` polled
      `/timed/investor/scores` alone every 60 s, wiping the
      position-reconciliation `investor.html` did at first paint —
      moved the merge of `/timed/investor/positions` INTO the panel's
      polling loop so refresh now stays in sync with newly-opened
      positions. (2) `worker/investor.js:700` classifies unowned
      tickers with moderate scores as `stage:"watch"` and the lane
      renders with action chip "HOLDING" — added panel-side demote:
      `watch`/`core_hold` + !owned → `research_on_watch`,
      `reduce` + !owned → `research_low`. (3) Lane gutter showed
      total-items, not owned-count — HOLDING lanes now compute owned
      separately and render "owned/total" when mixed. (4) Added a
      green pulsing "JUST OPENED" chip for positions whose
      `first_entry_ts` is within the last 30 min, directly anchoring
      Discord entry alerts to kanban tiles. `tt-tokens.css` gains a
      generic `tt-pulse` keyframe (respected by
      `prefers-reduced-motion`).
- [x] **Open-position freshness alert noise — streak gate + 20min
      5m RTH threshold (PR #426).** Operator paged for
      `5=16.2min` on DIA/GS/AA — a 5-15 min shared-feed blip that
      self-heals on the next cron tick. Three fixes in
      `worker/index.js`: (1) bumped `OPEN_POS_STALE_5M_RTH_MS` from
      15 → 20 min (absorbs one missed bar; 3+ missed still trips).
      (2) Added streak gate — KV key
      `timed:freshness:open_pos_streak:<sig>` (30 min TTL) requires
      ≥ 2 consecutive sweeps with the SAME `(tickers × reasons)`
      signature before paging. (3) Rewrote reason format from
      `5=16.2min` → `5m: 16min stale (>20min)` and embed description
      now explicitly states "pause auto-clears on next successful
      sweep, so no action is required unless alert recurs in 24h."
- [x] **Chart image in entry/trim/exit emails (PR #424).** New SVG chart
      renderer (`worker/chart-svg.js`) + public `GET /timed/chart-image
      ?ticker=&tf=60&bars=48&entry=X&sl=Y&tp=Z` endpoint pulls candles
      from `ticker_candles` D1 and renders an inline SVG (~3-4KB) with
      entry/SL/TP annotation lines, last 48 1H bars by default. Email
      body now embeds the chart as `<img src="https://timed-trading.com
      /timed/chart-image?...">` right under the headline — Gmail / Apple
      Mail / Outlook proxies fetch it inline. Cached 5 min CF-side so
      heavy email blasts don't pound D1. Empty-state SVG when candles
      are missing so the `<img>` never breaks.
- [x] **AI CIO ↔ Active Strategy wiring + freshness Monday-morning
      false-positive fix (PR #425).** Audit found CIO only saw per-ticker
      `strategy_stance` when a ticker actively matched a theme — and
      even then, the system prompt had no guidance on how to use it.
      The full editorial brief was Daily-Brief-only. Three fixes:
      (1) `getStrategyBrief()` injected at the top of every CIO entry
      + lifecycle prompt — same brief Daily Brief uses, so the two
      surfaces stay in lockstep. (2) `strategy_stance` is now ALWAYS
      added to memory (even for neutral stance / no theme match) so
      ~60% of the universe stops getting silently omitted from
      playbook context. New `on_thesis` boolean for fast LLM branching.
      (3) New ACTIVE STRATEGY PLAYBOOK + STRATEGY STANCE sections in
      the CIO system prompt explaining how to use overweight/under-
      weight + tier-1 themes + active risks as soft priors. Evaluation
      order elevates these above MACRO TILT and PDZ. Also: freshness
      monitor's 60m staleness threshold is now weekend-aware (72h on
      Monday 9 AM check; 24h Tue-Fri) — previously fired
      "candle_freshness_60: BRK-B 65.5h" every Monday because the
      first Monday bar hadn't completed yet.
- [x] **Universe + cohort fix — NBIS sector mismatch, ARM/MRVL/SMCI
      promoted to megacap_tech cohort (PR #423).** NBIS was tagged
      Health Care in `worker/index.js` SECTOR_MAP (sector-mapping.js
      correctly has it as Information Technology) — fixed, should
      immediately raise NBIS investor score and surface it in AI-infra
      theme runs. ARM, MRVL, SMCI added to default megacap_tech cohort
      in `worker/pipeline/tt-core-entry.js` so the slope/RSI/extension
      caps match AI-infra primary-trend behavior (was falling into the
      cyclical "other" bucket with too-tight caps). All still
      operator-tunable via `deep_audit_cohort_megacap_tickers`
      model_config key without a redeploy.
- [x] **Investor Sim-eligible filter — backfill + chip counts + tickerData
      passthrough (PR #422).** Three fixes for the operator report that
      clicking "Sim-eligible" emptied the lane while the dashboard
      still showed 90 in Accumulate.
      (1) `/timed/investor/scores` now backfills `simEligible` +
      `_stDirD/W/M` on the read path when the underlying KV scoring
      blob predates the field (returns `simEligible: null` to mark
      "unknown — data not yet populated").
      (2) Panel filter now treats `simEligible === null` as **unknown**
      (keeps visible) instead of hard-exclude, so the lane doesn't
      silently empty when the cron hasn't repopulated.
      (3) Chip label shows `Sim-eligible (N+M?)` where N = strictly
      eligible, M = unknown — so the operator always sees a number that
      matches the lane.
      (4) `investor.html` now passes `data` (from `/timed/all`) as
      `tickerData` to InvestorPanel so the fallback recompute has
      structural fields (tf_tech.D.stDir, monthly_bundle.supertrend_dir).
- [x] **MC: Run Calibration button + stale-message cleanup (PR #422).**
      The Last Calibration KPI in Mission Control now has a "Run ⚙"
      button that opens `/calibration.html?auto=run` in a new tab.
      `/timed/calibration/status` no longer claims "Waiting for next
      half-hour cron" (the cron-based pipeline was removed in April);
      now points operator at `POST /timed/calibration/run` and
      `scripts/calibrate.js`. wrangler.toml comment updated to note
      the half-hour slot is reserved/no-op.
- [x] **Investor Accumulate lane polish — tighter default + Sim-eligible
      filter.** Bumped `accumulate_strong_score_min` default 65 → 70 in
      `worker/investor.js` (the in-zone path stays permissive). Added a
      "Sim-eligible" filter chip to the Investor lane + bubble map that
      narrows Actionable to the cohort the simulator would actually buy
      (Monthly ST bullish + ≥2/3 of D/W/M ST bullish — matches
      `worker/index.js:36692-36698` exactly). Scoring cron pre-computes
      `simEligible` + `_stDirD/W/M` on each `/timed/investor/scores`
      row so the filter is a single boolean read on the client. Operator
      override (`deep_audit_investor_accumulate_strong_score_min`)
      unchanged; can flip back to 60-65 for wider Forensic-style cohort.
- [x] **Discord DM as a bonus user notification channel.**
      New `discordDmUser(env, discordUserId, payload)` helper in
      `worker/alerts.js` — two-step bot API flow (open DM channel →
      post message). Wired into the bridge-notify drain handler:
      when `BROKER_NOTIFY_DM_USER=true` and the user has linked
      Discord (`users.discord_id` from existing OAuth), the drain
      ALSO DMs them with the same compact embed alongside the email.
      Lookup is bounded (one D1 SELECT per unique email, cached in
      the drain handler). Failures (DMs disabled, no link, bot
      issues) never block the email send. Default OFF — operator
      opts in once they've verified DMs land. The drain response
      reports `dm_enabled`, `dm_sent`, `dm_skipped_no_link`,
      `dm_failed` so MC can surface DM health alongside email
      counts. Replaces / supplements the per-environment
      `BROKER_OPERATOR_DISCORD_WEBHOOK_URL` (operator can keep
      using that AS WELL for cross-team visibility, but it's no
      longer the only escalation path).
- [x] **Trade-aware mirror sync Phase E — drift notifications + MC
      Mirror Sync panel + Daily Owner Email cron.**
      New `worker-bridge/bridge-notifications.js`:
      `shouldDispatchDriftNotification()` (severity-tier dedup with
      escalation escape hatch), `buildDriftEmailContent()` /
      `postOperatorDiscord()` / `emitDriftNotification()` (queue +
      stamp manifest), `buildDailyOwnerDigest()` /
      `renderDailyOwnerDigestEmail()`, `drainNotifyQueue()`.
      Reconciler now calls `emitDriftNotification()` on warn/critical
      drift; bridge enqueues to `BRIDGE_KV` `bridge:notify:queue:*`,
      main worker `*/5` cron drains via
      `POST /timed/admin/broker-bridge/notify/drain { send: true }`
      and forwards through `sendEmail()`. New bridge cron
      `30 21 * * *` (21:30 UTC = 4:30pm ET) builds daily digests.
      New operator endpoints: `POST /bridge/manifest/action` with
      actions `suppress|unsuppress|mark_manual|mark_closed|
      force_resync_from_broker`; `POST /bridge/notify/drain`;
      `POST /bridge/notify/daily-digest`. Matching proxy routes
      on the main worker. MC manifest table extended with per-row
      action buttons (↻ resync, ⛔ Suppress / ✓ Unsuppress, ✕
      Mark Closed, ⊘ Mark Manual) + "📧 Preview daily digest"
      button in the section header. All operator actions include
      consequence text in their confirm dialogs.
- [x] **Trade-aware mirror sync Phase D — options + LEAPs + Investor + OCO.**
      Options leg-aware reconcile via `classifyOptionsDrift()`:
      canonical contract key `TICKER:YYYY-MM-DD:STRIKE.SS:[CP]`,
      per-leg expected vs broker comparison, spread leg-gap escalates
      severity to `critical`. New cadence routing: Trader equity 5min /
      Investor equity 60min / Trader & Investor options 60min / LEAPs
      daily — eligibility checked per-row via `_cadenceEligible()` so
      the 5-min cron throttles itself appropriately. LEAPs within T-30
      and other options within T-1 day get an "approaching expiration"
      note appended (Phase E will route to user notifications + emit
      auto-close once enabled). DCA tranche aggregation via
      `aggregateDcaTranches()` surfaces `N/M filled, K pending` in
      `sync_note`. New `worker-bridge/bridge-oco.js` exports
      `orchestrateOcoForReducer()` returning a structured cancel +
      replace plan for SL/TP orders; bridge audits the plan when
      `BROKER_OCO_ENABLED=true` (default off — actual cancel/place
      dispatch lands in Phase E).
- [x] **Trade-aware mirror sync Phase C — reconciler cron.**
      New `worker-bridge/bridge-reconciler.js` with
      `reconcileUser(env, user, adapter, opts)` + top-level
      `reconcileAllUsers(env, userListFn, adapterForUser, opts)`.
      `scheduled()` cron handler in bridge worker fires every 5 min
      (configurable via wrangler.toml triggers.crons), gates on NY
      regular-hours unless `BROKER_RECONCILE_24_7=true`. Compares
      `manifest.broker_remaining_qty` (fallback `model_intended_qty`)
      vs broker `getEquityPositions[ticker]` per §5.1 cadence and
      §6 mismatch taxonomy. Drift classifications: in_sync /
      partial_fill / broker_orphan (model CLOSED + broker holds) /
      mothership_orphan (model OPEN + broker = 0) / reconcile_error.
      Auto-suppress after 3+ chronic drift cycles with explicit
      `auto_suppressed_after_N_drifts:<state>` reason. Operator
      on-demand: `POST /bridge/reconcile` (single user or all) +
      `POST /timed/admin/broker-bridge/reconcile` proxy. MC "Force
      reconcile" button below the manifest table. `BROKER_RECONCILE_
      DRY_RUN` env supports observe-only mode for the first week.
- [x] **Trade-aware mirror sync Phase B — manifest-aware reducer.**
      `preflightOrder` now reads the `mirror_trade_manifest` BEFORE
      the portfolio check on every TRIM/EXIT. Decision matrix per
      §4.1: PROCEED when sync_state ∈ {in_sync, partial_fill,
      broker_orphan, untracked (close only)}; REJECT with explicit
      `no_manifest_for_trade` / `mirror_suppressed:<reason>` /
      `reducer_blocked_by_sync_state:<state>` /
      `reducer_missing_trade_id_for_manifest_lookup`. Partial-fill
      scaling supported via `BROKER_PARTIAL_FILL_MODE=scale`.
      `markManifestModelClosed()` wired on successful EXIT.
      Gated by `BROKER_MANIFEST_ENFORCE` env (on / log / off);
      starts in `log` mode in prod for a week of shadow-mode
      observation, then flips to `on`. Fail-OPEN on D1 read error
      so a degraded manifest doesn't lock the operator out
      (portfolio guard + reconciler are last-line defense).
- [x] **Trade-aware mirror sync Phase A — manifest writer.**
      New `worker-bridge/bridge-manifest.js` with `mirror_trade_manifest`
      D1 table (matches §3.1 schema exactly), `writeEntryManifest()`
      writer (called on every successful place after preflight),
      `writeRejectedEntry()` (called when preflight rejects an entry so
      Phase B can return `mirror_suppressed` on follow-on TRIM/EXIT),
      `recentManifestRows()` + `readManifestRow()` for inspector use.
      `ensureMirrorManifestSchema()` runs via `ensureBridgeSchema()` —
      idempotent + in-process cached. New `GET /bridge/manifest` +
      `GET /timed/admin/broker-bridge/manifest` operator-only endpoints.
      Mission Control renders a per-sync_state count strip + 50-row
      scrolling table with ⛔ icons on suppressed rows. Writer is
      best-effort — a manifest write failure does NOT undo a placed
      order; the reconciler (Phase C) reconstructs from the broker side.
- [x] **Options engine emits LEAPs for long-direction tickers (Investor
      primary, Trader alternative).** New `leap_call` archetype +
      `pickLeapExpiration()` (~540 DTE, snapped to 3rd Friday, floored at
      365 DTE for true LEAP status) + `buildLeapCall()` baked with the full
      stock-replacement framework (deep-ITM 0.80Δ default, PMCC follow-on
      suggestion, T-180 day roll discipline, IV-aware entry caveat,
      capital-efficiency floor warning, LEAP-aware liquidity tolerance).
      `buildOptionsLadder()` always inserts a LEAP into the long-side
      ladder for any long-direction ticker — `_investor_boost` pins it
      primary only on Investor stage; Trader stage keeps Long Call as
      primary with LEAP as an alternative below.
- [x] **Right-rail Options tab: Horizon toggle (Trader / Investor LEAP).**
      `/timed/options/ticker?mode=investor` forces `stage='investor'` +
      `direction='LONG'` so the engine pins the LEAP as primary. The
      in-panel toggle auto-detects from the host URL on mount
      (investor.html → investor) and is operator-overridable. LEAP
      metadata (roll target, PMCC suggestion, capital efficiency, IV
      assessment) renders through the existing primary-play card + notes
      bullet list — no further UI work was needed beyond the toggle.
- [x] **Trader + Investor entry alerts include the recommended options play.**
      New shared formatters `compactOptionsPlay()`, `optionsPlayDiscordField()`
      (Discord 1024-char-safe), and `optionsPlayEmailHtml()` in
      `worker/options-plays.js`. Trader entry path (kanban + trade-sim) and
      Investor entry path each call `buildEntryOptionsPlay()` which routes
      through the right mode → ladder primary, then attaches a single Discord
      field and an `options_play` payload to `sendTradeAlertEmail()`. Email
      renders a new "Options Play" section between Setup and Signals. Sample
      fixtures (`/timed/admin/send-sample-emails`) now include `trade_entry`
      (Trader long-call) and `investor_entry_leap` (Investor LEAP).
- [ ] **Investigate CF error 1042 on broker-bridge subrequests.** Worker-to-worker
      HTTPS fetch to `tt-broker-bridge.shashant.workers.dev` returns
      404 + `error code: 1042` (Cloudflare loopback rejection). Migrate
      to **Service Bindings** in `worker/wrangler.toml` per
      [skills/broker-bridge.md](../skills/broker-bridge.md) → "Cloudflare
      error 1042". Symptom: Mission Control bridge tile shows
      `bridge_responded_404` even though the bridge worker is up.
- [x] **FAQ ↔ Learn content alignment.** Rewrote `/faq.html` end-to-end
      so its 24 Q&A pairs align with `/learn.html` and the current
      product. New sections: Getting Started · Active Strategy &
      Universe · Daily Brief, AI CIO & Two Modes · Options & LEAPs ·
      Performance & Proof · Pricing & Subscription · Alerts, Community
      & Technical. Fixed: nav Sign-In → `/today.html` (was
      `/index-react.html`), Founding-member pricing terminology
      (was "Charter"), accurate Active Trader lanes (Watch → Setup →
      Enter → Hold → Defend → Trim → Exit) + Investor 4-action /
      3-research lane split, performance defers to live `/proof.html`
      instead of static backtest numbers, new questions for AI CIO,
      Active Strategy ON/OFF-THESIS, Options + LEAPs, entry-alert
      options play, sign-out-after-admin-removal flow, data sources
      (Twelve Data + Alpaca).

### Watch

- [ ] **Mission Control AI CIO Decision Review** — inline feedback now in place
      (PR after 2026-05-30). Confirm with operator that buttons feel responsive.
- [ ] **Broker bridge console noise** — `/status` + `/audit` now return 200
      with structured `error_kind` (same PR). Confirm DevTools is clean.

### Planned

- [ ] **Trade-Aware Mirror Sync (v2 design).** Manifest table +
      reconciler keeping mothership (model trade state) in lockstep
      with each spawn (user broker account). Drift detection +
      user notification + per-trade kill switch + per-vehicle
      toggles + daily owner email + user-modification handling.
      Plan: [2026-06-01-trade-aware-mirror-sync-design.md](2026-06-01-trade-aware-mirror-sync-design.md)
      (v2). **Scope:** Trader + Investor × Shares + Options
      (incl. LEAPs as 2nd-most-popular vehicle), 6 simulation
      actions mapped per cell, every action mapped to explicit
      IBKR Client Portal API calls including OCO order lifecycle
      (cancel-before-trim, modify-SL, TP/SL fill detection). **No
      naked shorts** — equity SHORT, options selling-to-open,
      cash-secured puts, covered calls all deferred to a separate
      risk-reviewed workstream. **Per-vehicle toggles**: equity_long
      defaults ON; every option archetype (long_call, long_put,
      vertical_spread, leaps, straddle, moonshot) defaults OFF.
      **Daily owner email**: per-broker-account digest (trades,
      positions, day P&L, tomorrow's outlook). **User-mod handling**:
      revert SL/TP changes by default, accept user-initiated closes.
      **Prerequisite for BYOB** — must ship before third-party
      users connect their own broker. 7 phases (A→G), ~18 days
      total before BYOB launch; Phase G polish post-launch.

- [ ] **BYOB — Bring Your Own Broker.** Multi-user broker connect flow
      (Robinhood + IBKR per-user). Plan:
      [2026-06-01-byob-broker-connect-plan.md](2026-06-01-byob-broker-connect-plan.md).
      Bridge architecture is already multi-user-ready (per-user storage,
      OAuth, encrypted tokens, risk caps, audit log all live). What's
      missing: user-facing Connect-Broker UI, Robinhood OAuth wiring,
      IBKR per-user wizard, compliance + risk controls. **Depends on
      Trade-Aware Mirror Sync (above)** — letting third-party users
      connect their own broker requires lock-tight trade-level
      isolation. 4-phase rollout estimated 4-6 weeks of focused work
      + parallel legal review.

---

## Strategic plans (one-shot, recently shipped)

| Plan | Status |
|---|---|
| [2026-05-30-ibkr-auto-execution-plan.md](2026-05-30-ibkr-auto-execution-plan.md) | Shipped (IBKR live; auto-mirror policy + audit live) |
| [2026-05-29-broker-bridge-phase1-plan.md](2026-05-29-broker-bridge-phase1-plan.md) | Phase 1 shipped |
| [2026-05-29-session-handoff.md](2026-05-29-session-handoff.md) | Historical reference |
| [2026-05-28-today-page-redesign.md](2026-05-28-today-page-redesign.md) | Shipped + refined through 2026-05-30 |
| [2026-05-28-cio-signal-enrichment-plan.md](2026-05-28-cio-signal-enrichment-plan.md) | Shipped |
| [2026-05-28-opportunity-surface-plan.md](2026-05-28-opportunity-surface-plan.md) | Shipped |
| [2026-05-28-right-rail-catalysts-tab-plan.md](2026-05-28-right-rail-catalysts-tab-plan.md) | Shipped |
| [2026-05-28-discovery-phases-2-3-4a-5-plan.md](2026-05-28-discovery-phases-2-3-4a-5-plan.md) | Shipped |
| [2026-05-28-cio-shadow-to-live-audit.md](2026-05-28-cio-shadow-to-live-audit.md) | Shipped (live + replay separation in `ai_cio_decisions`) |
| [2026-05-28-admin-nav-cleanup-plan.md](2026-05-28-admin-nav-cleanup-plan.md) | Shipped |
| [2026-05-28-dmarc-runbook.md](2026-05-28-dmarc-runbook.md) | Operational runbook (keep) |
| [2026-05-28-dell-stale-and-earnings-radar-miss.md](2026-05-28-dell-stale-and-earnings-radar-miss.md) | Fixed + lesson logged |
| [2026-05-28-robinhood-agentic-trading-research.md](2026-05-28-robinhood-agentic-trading-research.md) | Research; feeds bridge-phase2 |
| [2026-05-27-cio-candles-shortrank-plan.md](2026-05-27-cio-candles-shortrank-plan.md) | Shipped |
| [2026-05-27-three-week-live-review.md](2026-05-27-three-week-live-review.md) | Historical reference |

---

## Backlog (pull from here when current work clears)

### Operability

- [ ] Migrate main → bridge fetch to Service Bindings (resolves CF 1042 above).
- [ ] Add a "worst stale ticker" alert that wakes someone if it exceeds 24h
      (currently only surfaced in Mission Control on visit).

### Strategy

- [ ] Multi-leg combo orders end-to-end in IBKR live (currently single-leg
      autopilot; combos defined in `worker/options-plays.js` but not
      auto-mirrored yet).
- [ ] Robinhood Agentic execution as bridge target #2 (research in
      `2026-05-28-robinhood-agentic-trading-research.md`).

### UX

- [ ] Investor email digest cadence — current is per-zone-enter; consider
      morning summary roll-up.
- [ ] Replace the alert() prompts that remain in `mission-control.html`
      (auto-flipped-gate banner) with the same inline-toast pattern used
      for review feedback.

---

## How to add a new task here

1. Use the **outermost section** (Open work / Strategic plans / Backlog).
2. Active items go under "Active" with a `[ ]` checkbox.
3. Shipped one-shots get moved into the "Strategic plans" table with a
   status, not deleted (they remain useful reference).
4. When a task ships AND is fully validated by the user, mark it `[x]`
   then move to the Strategic-plans table on the next session sweep.
