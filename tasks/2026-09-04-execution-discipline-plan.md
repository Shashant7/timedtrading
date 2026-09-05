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

## 5. Next packets

1. **Context playbooks out of shadow.** `daily_ema21_reclaim` saw DELL
   three times as CONTEXT_SHADOW with confidence 65. Promote the playbook to
   a live entry path for compounders (the same names the Investor engine
   scores >= 85) with the options desk as the vehicle when premium is rich.
2. **Options desk follow-through.** The earnings desk called DELL 475c and
   nothing routed it. Wire earnings-lotto / day-trade options plays for
   compounders into the same intent ledger so a called play is a ticket.
3. **Intent ledger for options reducers.** Same drain, options sell window
   (09:30-16:15 ET).
4. **Paper-close-on-fill for operator lanes.** Index trend and family
   tickets could hold the paper close until the broker fills (or the intent
   expires) for the operator's own book; members keep model truth.

## 6. Verification

- `vitest run`: 317 files / 3436 tests green.
- Deploys: bridge `b346c476`, monolith default `7e972544`, production
  `15f39a08`, tt-engine `b1ed9198` / `891c31de`. `/timed/health` ok.
- Packet 3: 3451 tests green. Monolith `c7549ada` / `e7f78ed5`, tt-engine
  `6a423402` / `243af8bb`, tt-research `8ab80d58` / `c8a45bcf`.
  `GET /timed/admin/broker-intents?status=all` -> `{ok:true,count:0}`
  (table created).
- Monday 09-08 watch: `[SMART_GATE]` and `[PAPER_FAMILY_ENTRY] ... held`
  lines should appear; no more than 3 family opens; no index-trend
  EXIT/TRIM after 16:00 ET; no `no_manifest_for_trade` on a sleeve with
  `broker_remaining_qty > 0`.
