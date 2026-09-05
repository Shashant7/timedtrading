# Execution Discipline — from "40 tickets that cancel out" to 5 convicted trades

Date: 2026-09-04 / 09-05. Branch `cursor/execution-discipline-plan-dbdd`,
PR #1426. Trigger: the operator's review of the W36 book (UDOW +4.4% MFE
closed +1.79% at 19:01 ET with the broker still holding; TSLA good entry,
bad exit; DELL never entered; 12 Cloud Pivot tickets opened in 3 minutes;
25 of 28 open books were 0.1x paper tickets).

This document is the plan AND the ledger of what landed. Everything under
"Landed" is deployed to monolith + tt-engine (default + production) and the
bridge worker.

---

## 1. Diagnosis (from four architecture maps + D1)

| Finding | Evidence | Consequence |
|---|---|---|
| **Every smart entry gate has been dead since 2026-06-26.** `nyDayString` was referenced inside the smart-gate `try` (calibration guards) but never defined; the `ReferenceError` was swallowed by `catch (e) { console.error("[SMART_GATE] Error checking gates") }`. | `rg nyDayString worker/` showed 6 call sites, zero definitions; `git log -S` dates the first call to 06-26 (`9b1218f72`). | Position cap (35), sector cap, direction cap (25), daily cap (999), loss-streak cooldown, calibration guards: none ran for ten weeks. |
| Cloud Pivot paper tickets force `isEnter` and skip the core qualify / cluster throttle. | `resolvePaperFamilyStandaloneEntry` in `processTradeSimulation` (~L20160). | Burst opens: 12 in 3 min on 09-04 15:07-15:11 ET, 6 in 2 min on 08-26. |
| Cloud Pivot profit lock was a one-shot full exit at 50% of MFE from a 1.2% arm. | `evaluateTtCloudPivotExit`. | +1.3% blips banked at +0.65% (dust); +12% runs allowed to give back 6 points. |
| Index-trend LETF lane classified profit exits on the `*/15` operating-hours tick after the 19:00 ET broker cutoff. | UDOW `trail_giveback` at 19:01 ET; `resolveTraderEquityEthMirror` → `equity_ah_too_late_for_broker`; no exit re-fire once the book is closed. | Paper "+1.79% (filled)"; broker still long. |
| Suppressed / orphaned sleeves that still held shares were filtered out of reducers twice: `manifestAwareReducerCheck` (guards) and `rowHoldsReducerQty` (fan-out). | DPZ 09-04 EXIT → `no_manifest_for_trade`. | Shares stranded at the broker after the model closed. |
| MFE could be poisoned by a bad `day_high` / `_live_daily_high` print. | TJX `max_favorable_excursion` 20.06 on a 1.15% move. | Profit locks / ratchets keyed off a fantasy peak. |
| Broker dispatch is fire-and-forget. | `forwardOrderToBridge` returns a skip; nothing re-queues an `it:` or family exit. | Any skip/reject outside RTH is a manual catch-up. |

## 2. Doctrine (what "convicted" means in code)

1. **A share order is only placed when the broker can take it.** Entries
   09:45-15:30 ET. Profit management RTH only (skip the 09:30 print).
   Hard stops until 19:00 ET (17:00 early close). Never close a paper book
   while the broker cannot act on it. (`worker/execution-window.js`)
2. **Peak-anchored protection escalates with the peak.** +1R never goes
   red; +1.5R keeps half; +2R keeps 60%; +3R keeps 70% (index trend,
   `peakGivebackFloor`). Cloud Pivot: 40/50/60/70% keep by MFE tier,
   trim-then-trail rather than one-shot exit (`cloudPivotKeepFrac`).
3. **Holdings truth beats manifest state.** `broker_remaining_qty > 0`
   means the sleeve holds; suppression explains why the model stopped
   mirroring, not whether shares exist. Reducers always reach a holder.
4. **Few, ranked, budgeted.** Core book: 12 open / 8 same direction /
   6 new a day. Paper families: 4 open / 3 a day / conviction >= 2 (both
   34/50 clouds aligned with the trade). Best few take the capital.
5. **Peaks come from sane prints.** `spikeTol` applies to every high/low
   source that feeds MFE/MAE.

## 3. Landed (deployed)

- `worker/execution-window.js` (+ tests): `shareLaneExecutionWindow`,
  `peakGivebackFloor`. Wired into `worker/index-trend-paper.js`
  (`can_enter` / `can_reduce` / `can_stop` / `can_ratchet`; the post-2R
  `trail_giveback` replaced by the escalating floor).
- `worker/index.js` `bumpOpenTradeExcursions`: `spikeTol` on
  `_live_daily_high` / `day_high` paths. TJX D1 MFE repaired 20.06 -> 1.15.
- `worker-bridge/bridge-guards.js` `manifestAwareReducerCheck`:
  `held_override` when `broker_remaining_qty > 0`.
  `worker-bridge/bridge-manifest.js` `rowHoldsReducerQty`: same rule for
  fan-out holder selection.
- `worker/index.js`: `nyDayString` defined (smart gates live again); core
  caps 12 / 8 / 6 (DA overrides `deep_audit_max_open_positions`,
  `deep_audit_max_same_direction`, `deep_audit_max_daily_entries`); counts
  read from `trades` and exclude paper-family paths.
- `worker/foundation/paper-family-entry.js`: `paperFamilyBudgetAllows`
  (4 open / 3 daily / conviction >= 2; DA overrides
  `deep_audit_paper_family_max_open` / `_max_daily` / `_min_conviction`).
  Wired at the standalone open with the 09:45-15:30 entry window; held
  opens log `[PAPER_FAMILY_ENTRY] ... held: <reason>`.
- `worker/foundation/tt-cloud-pivot.js`: `cloudPivotConviction` stamped on
  the proposal; profit lock trim-then-trail with escalating keep.

## 4. Packet 3 — landed (deployed 2026-09-05 02:00 UTC)

- **Durable order-intent ledger** (`worker/broker-intents.js`, D1
  `broker_intents`). Every trader SELL/TRIM/EXIT on equities/LETFs that does
  not come back placed from `forwardOrderToBridge` is a pending intent
  (deferred: after 19:00 ET, sub-share outside RTH; transient: fetch error,
  5xx, throttle). Terminal rejects (`no_manifest`, `naked_short`, config)
  close it. The `*/5` cron drains pending rows while the broker can act
  (whole shares until 19:00 ET, sub-share RTH only), fresh
  `client_order_id` per attempt, max 12 attempts / 3 days, Discord summary
  when anything is attempted. A placed reducer settles a pending intent for
  the same trade/side, so a manual catch-up cannot double-fire (bridge
  position guard clamps qty regardless). Entries and options are excluded
  on purpose: a deferred entry re-qualifies, it does not chase.
  Admin: `GET /timed/admin/broker-intents?status=pending|all`,
  `POST /timed/admin/broker-intents/drain`.
- **Notification honesty.** Trader exit/entry subjects and bodies say
  "model fill", not "filled". Broker mirror state lives in the mirror log
  and `broker_intents`.
- **DELL audit -> compounder patience override.** `decision_records` show
  the Investor engine scored DELL 86-100 in `accumulate` with
  `compounder_dip_override_exhaustion:growth_elite:timing_bottom` from
  Aug 11 to Sep 4 and rejected EVERY hourly admit on the LTF stabilize gate
  (`ltf_st_sloping_down` / `ltf_5_12_cloud_not_curled`). The trader engine
  only ever saw DELL as a `daily_ema21_reclaim` CONTEXT_SHADOW (08-21,
  08-28, 08-31) — shadow, never live. The blocker was not the earnings
  blackout; it was demanding a 10m curl on a dip whose whole point is a
  bearish LTF. `investorCompounderPatienceOverride`: after 3+ hourly LTF
  rejects on a growth-elite compounder dip scored >= 85, admit a 34%
  starter tranche when the name is not still breaking (1H ST not sloping
  down, no fresh 10m 5-12 cross-down, not majority-below LTF 233).
  Structural vetoes are never overridden. Records `ADMIT_OVERRIDE`.
- **ST ratchet through the shared window.** Reviewed, no code change: ST
  soft exits (ratchet, runner extension, profit locks) already execute RTH
  only and queue outside; hard stops already stop at the 19:00 ET
  follow-through cutoff. The index-trend lane was the outlier and is fixed.
- **Paper shorts — decision.** Cloud Pivot SHORT tickets share the
  paper-family budget. A short slot is model conviction the paper book (the
  member-facing product) should show; the broker not being able to short is
  a broker limitation, not a signal-quality one. Revisit only if shorts
  crowd out mirrorable longs at the 4-open cap.

## 5. Packet 4 — landed (deployed 2026-09-05 02:25 UTC)

### 5.1 Context playbooks: kept in shadow (evidence)

`GET /timed/admin/context/shadow-report?days=30`, sliced by the set of
tickers the Investor engine tagged `compounder_dip_override` in the last
45 days:

| playbook | slice | n | fwd median | positive |
|---|---|---|---|---|
| `daily_ema21_reclaim` | all | 154 | -0.31% | 45% |
| `daily_ema21_reclaim` | compounders (DELL class) | 31 | -0.95% | 39% |
| `daily_ema21_reclaim` | later-session (>= 11:30 ET) | 122 | -0.65% | 39% |
| `weekly_breakout_retest` | all | 99 | -0.33% | 42% |
| `weekly_breakout_retest` | compounders | 20 | +0.47% | 55% |

The "DELL saw it three times" observation was survivorship: the same
trigger on the same class of name is the worst slice in the table. No
promotion. Weekly retest on compounders is the only positive cell and is
n=20; re-read at n>=50 before deciding anything. `playbooks.js` unchanged.

### 5.2 Convexity ticket ledger (`worker/convexity-tickets.js`)

The lotto strip was a scan with no owner. A CONFLUENT, live-chain-priced
card inside the options entry window now becomes a `convexity_tickets`
row (paper + Discord "model fill"), 2/day, 4 open, estimates never. The
`*/5` RTH cron marks open tickets off the chain and closes by rule:

- `premium_stop` at 50% of entry
- `take_3x`
- `peak_giveback` after 2x: keep 60% of the peak gain
- `pre_print_exit` at 15:45 ET on the crush block's exit-by date, only
  when it said `EXIT_BEFORE_PRINT` / `TIGHT_HOLD` (a `CAN_HOLD_THROUGH`
  ticket rides the print, which is what the DELL call needed)
- `expiry`

Every 15 min inside the entry window the cron self-fetches the scan with
`_nocache=1` so tickets open without a page view.
`GET /timed/admin/convexity-tickets` is the report card; the broker
mirror for this desk is decided from that table, not from one screenshot.

### 5.3 Options desk mirror, gated on the grade (`worker/convexity-mirror.js`)

The broker leg exists in code and is off until the evidence is there:

- `convexityMirrorDecision(report, env)`: >= 20 graded tickets, positive
  median, win rate >= 40%. `CONVEXITY_MIRROR=true` forces on (operator
  judgment), `false` forces off. Reported on every
  `GET /timed/admin/convexity-tickets` call (`mirror.enabled`, `mirror.reason`).
- Vehicle `lotto` in the options auto-mirror prefs (Mission Control row
  "Convexity Ticket", off by default, $250/order). Sizing never buys a lot
  the cap cannot cover; buy limit = mid + 3% (min one tick), capped at ask.
- Every ticket close with a broker leg is a SELL that places or becomes a
  `broker_intents` row of kind `options_close`. The intent ledger windows
  those to the options sell window (09:30-16:15 ET) and the drain routes
  them through `forwardOptionsClose`.

### 5.4 Paper-close-on-fill: decided against

The paper book is model truth: it is the member product and the model's
own grade. Holding a paper close until the broker fills would write broker
latency into the model's P&L (the UDOW 19:01 ET skip would have graded as
a worse model exit, not as a broker miss). Broker truth already has its
own ledger for the operator: `mirror_trade_manifest`, `bridge_audit`,
`broker_intents`, and the drain's Discord summary. Notifications say
"model fill" so nobody reads one as the other. No change.

## 6. Grade so far (2026-09-05, `GET /timed/admin/execution/report-card?days=42`)

Honest answer to "did this improve trade selection": not yet provable.
Every change above landed on 2026-09-04/05; there are zero sessions of
post-change trades to grade. What the 42-day ledger before the changes
says, and what each change does to it:

| slice (closed, 42d) | n | win | sum |
|---|---|---|---|
| all | 73 | 30% | -45.3pp |
| core | 47 | 28% | -29.1pp |
| paper family (cloud pivot) | 26 | 35% | -16.2pp |
| core entered 09:30-12:00 ET | 11 | 45% | -0.5pp |
| core entered 12:00-16:00 ET | 36 | 22% | -28.5pp |
| core entered 15:00-16:00 ET | 12 | 17% | -12.9pp |
| cloud pivot LONG / SHORT | 15 / 9 | 20% / 67% | -22.3 / +6.1pp |
| entries the new caps would have blocked | 27 | 33% | -18.3pp |
| entries the caps keep | 46 | 28% | -27.0pp |

- **Caps** cut exposure to a losing process (blocked set is worse than
  kept), they do not make the kept set a winner. Selection is not fixed by
  counting.
- **Exits were the bigger leak than entries.** Of real winners with MFE
  >= 1.5%: core 17 of 21 and family 10 of 13 closed below 40% of peak.
  The cloud pivot lock counterfactual alone (+~60pp on a -16pp lane) flips
  the family positive, with the caveat that it assumes a fill at the floor.
  The core ratchet (armed 2.0%, 40% lock) fired 3 times in 42 days.
- **Late-day core entries are the loss engine.** After 12:00 ET: 36
  trades, 22% win, -28.5pp; the 15:00 bucket alone -12.9pp. Mechanism:
  entry at 15:0x, overnight gap, `sl_breached`/`max_loss` before 10:00.
- **MFE integrity**: 3 of 73 recorded peaks (GEV 14.25% vs a 4.9% candle
  ceiling, TJX, CAT) were physically impossible; the spike guard from
  packet 2 stops new ones. The report card flags and excludes them.

### 6.1 Config corrections applied (model_config, hot)

- `deep_audit_max_daily_entries` 999 -> **6**. The packet-2 code default
  of 6 was being overridden by this DA row; the core daily cap was NOT in
  effect until now.
- `deep_audit_late_day_entry_block_min` 30 -> **120**: core entries blocked
  14:00-16:00 ET (momentum-breakout bypass still applies). July evidence
  had the 15:00 bucket profitable; Aug-Sep reversed it. Revisit when the
  14:00-15:00 bucket is positive over 30d.
- `deep_audit_mfe_ratchet_activation_pct` 2.0 -> **1.5**: a +1.5% winner
  gets the 40% floor.

### 6.2 How the system grades itself from here

- `GET /timed/admin/execution/report-card?days=N` -- baseline by lane,
  entry-hour buckets, setup/direction, MFE integrity + giveback, caps
  replay. Read weekly; compare the post-09-05 window to the table above.
- `GET /timed/admin/convexity-tickets` -- options desk grade; mirror gate
  flips itself when earned.
- `GET /timed/admin/context/shadow-report?days=30` -- playbooks.
- `GET /timed/admin/broker-intents?status=all` -- broker follow-through.
- Pass condition for "selection improved": core win rate >= 40% and
  core sum > 0 over >= 30 closed trades, with the 12:00+ buckets no
  longer the dominant loss; family LONG win rate >= 35%.

## 6.3 Packet 6 — the ratchet was firing and being blocked (2026-09-05, deployed)

The report card said 17 of 21 real core winners (peak >= 1.5%) closed
below 40% of peak. Only 3 of those were below the old 2.0% arm and 2 were
next-day gap stops. The other 12 (CF, JCI, SNOW, FLR, AXON, CSX, WAL ...)
sat under their floor for hours of RTH and still died at `max_loss` /
`sl_breached`. FLR 08-20: peak +2.77%, floor +1.11%, below the floor from
09:40 to the 15:50 max_loss at -1.74%.

tt-engine logs 2026-09-04 show why. The ratchet fires (`[MFE_RATCHET] TSLA
LONG peak=10.59% floor=8.47% pnl=8.38% -> exit`, 12 times overnight and
at the open) and the live execution layer then re-gates it as a soft
signal exit:

- `[EXIT SHIELD] TSLA runner EXIT blocked: c7289_15,c3450_15,c7289_30
  reason=mfe_ratchet_giveback` (also TJX, ELF, SWK, J, DKNG, TSM) -- the
  trimmed-runner pullback shield holds the runner while price is above a
  15m/30m ripster cloud, i.e. the exact "suppression web" the ratchet was
  written to be immune to.
- the 30-minute management cadence (`LIVE_MANAGE_INTERVAL_MIN`) -- the
  three fires that did close (DE, RTX, SN) landed a full bucket below
  their floors (SN floor +0.86%, exit -0.54%).
- min-age gate, bleeder shield, CIO HOLD -- same soft-exit class.

Fix (`isMfeRatchetExit`, `worker/pipeline/mfe-ratchet.js`; gates in the
lifecycle exit block of `worker/index.js`): the profit lock is a price
level, like a stop. It bypasses the pullback shield, the 30m cadence, the
min-age gate, the bleeder shield and the CIO exit review. It is NOT an
SL-class exit: it still waits for RTH (execution-window doctrine) and it
keeps the stale-tick guard so a re-served prev_close cannot read as a
floor breach. TSLA under the fix: runner out at the first 09:30 tick
under +8.47% instead of the 10:09 `sl_breached` at +2.73% blended.

## 6.4 Weekly execution review (automated, Friday 17:00 ET)

`worker/execution-review.js` + `GET|POST /timed/admin/execution/review` +
`react-app/execution-review.html` (Admin menu > Execution Review).
Every Friday 17:00 ET (hourly cron slot, ET day+hour gated; the member
Weekly Retrospective moved to the same slot from Sunday 18:00): grade the
week, the since-changes cohort and the 42-day pre-change baseline with
`gradeExecution`; judge the pass condition in 6.2; add the options desk
report, the 7-day broker_intents summary and the live DA knobs; store
`timed:execution:review:latest` + 12-week history; email the operator
(`sendEmail`, category `execution_review`); one Discord line (system
lane). First live run 2026-09-05 13:45Z: stored, email sent, verdict
`insufficient` (0 closed since changes; the changes landed after Friday's
session). The page reads KV and can recompute / store / run+email.

## 7. Next

- Let `convexity_tickets` grade itself. Re-read the report card at
  `closed_n >= 20`; if `mirror.enabled` flips, toggle the Convexity Ticket
  vehicle in Mission Control. Until then the desk is paper.
- Weekly retest on compounders (55% at n=20): re-read the shadow report at
  n >= 50.

## 8. Verification

- `vitest run`: 317 files / 3436 tests green (packet 6: 323 files / 3517).
- Deploys: bridge `b346c476`, monolith default `7e972544`, production
  `15f39a08`, tt-engine `b1ed9198` / `891c31de`. `/timed/health` ok.
- Packet 3: 3451 tests green. Monolith `c7549ada` / `e7f78ed5`, tt-engine
  `6a423402` / `243af8bb`, tt-research `8ab80d58` / `c8a45bcf`.
  `GET /timed/admin/broker-intents?status=all` -> `{ok:true,count:0}`
  (table created).
- Packet 4: 3471 tests green. Monolith `4e8fc416` / `eca20ded`, tt-engine
  `93ab3a12`, tt-research `1507499c`. `GET /timed/admin/convexity-tickets`
  -> `{ok:true,open:0}` (table created); `POST .../mark` -> `scanned:0`.
- Packet 4b (mirror): 3480 tests green. Monolith `896cd26e` / `bd9718f0`,
  tt-engine `b78e3e47`, tt-research `423fdcfd`. Report card shows
  `mirror: {enabled:false, reason:"graded_0_of_20"}`; D1 has the four
  `mirror_*` columns.
- Report card: 3485 tests green. Monolith `c8304210` / `5a80fd30`. Live
  `GET /timed/admin/execution/report-card?days=42` reproduces the offline
  table (73 closed, 30% win, -45.3pp; 3 corrupt MFEs).
- Packet 6: monolith `bf435d5a` / `4da9e296`, tt-engine `8cbefc6b`,
  tt-research `cb8358f7`. `GET /timed/admin/execution/review?fresh=1` ->
  `Week ending Sep 5, 2026`, baseline core n=47 28% -29.1pp (matches the
  report card); `POST ...?email=1&notify=1` -> `stored:true, email.sent:true`.
- Monday 09-08 watch (packet 6): a `[MFE_RATCHET] ... -> exit` line during
  RTH must be followed by the close, not by `[EXIT SHIELD] ... blocked
  reason=mfe_ratchet_giveback`. The open ratchet calls from Friday night
  (GE, JD, LULU, LRN, J, BABA, SWK, ELF) should close in the first ticks.
- Monday 09-08 watch: `[SMART_GATE]` and `[PAPER_FAMILY_ENTRY] ... held`
  lines should appear; no more than 3 family opens; no index-trend
  EXIT/TRIM after 16:00 ET; no `no_manifest_for_trade` on a sleeve with
  `broker_remaining_qty > 0`. `[CONVEXITY TICKET] opened` at most twice;
  first Discord "OPTIONS DESK · ticket" embed carries a live premium.
