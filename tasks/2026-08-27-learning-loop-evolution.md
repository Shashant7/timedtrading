# Learning-loop evolution (Jul 27 – Aug 27 2026)

This is **not** a first-time analysis of the book. It is a review of
what the last month of merged PRs actually built, what the live loops
are already doing, and the few wires that were still open.

Companion (static floors shipped yesterday):
`tasks/2026-08-31-monthend-evolve.md`. Treat that file as the Ripster-BE
patch note. Adaptation lives here.

---

## 1. What last month's PRs were

~200 merges since 2026-07-27. Rough cut by title:

| Bucket | n | What it means |
|---|---|---|
| Index / options / lotto | 45 | New vehicles (Index Day-Trade, Index Swings LETF, lotto, earnings-prep). Product surface, not the ST equity learner. |
| Broker / mirror | 32 | Webull / IBKR / RH follow-through, trim %, Roth, fractional. Execution fidelity. |
| UI / Today / rail | 25 | Strips, cards, nav, EXT prices. Operator can *see* the book. |
| Notify / brief | 13 | Discord / email / digest parity so a fill is visible. |
| Feed / prices | 11 | TwelveData freshness, stream ownership. |
| **Engine / learning** | **32** | Real model work — see below. |
| Ops / cron | 4 | Health, secrets, self-heal. |
| Other | 38 | Auth, FSD, investor, checkout, etc. |

The month was mostly **product completion** (index vehicles, broker,
Today). Engine work was real, but it was a stack of **human patches**
on top of loops that were already running.

### Engine / learning lineage (the useful ones)

| When | PR | What shipped | Still true? |
|---|---|---|---|
| Jul 27 | #1187 | Block Speculative ATH; tighten N-test | Admission still leaks when grade is empty unless wildcard is on |
| Jul 29–Aug 4 | #1199, #1203 | Calibration "trusted live analysis"; COO D1 storm | Calibration applies through `model_config`. Operator rarely hits Apply All. |
| Aug 4–15 | #1254, #1255, #1259, #1262 | July autopsy gates, HTF Reclaim, capture floor, LTF structure | Working. HTF Reclaim is the 30d winner (+$42 on n=5). |
| Aug 15–17 | #1264–#1274 | Trade Review Agent + auto-apply + History | **Running.** 100+ reviews. Almost no `source=trade_review` proposals. |
| Aug 18–19 | playbook audit (ops, not a PR) | ATH / Support / Range stay blocked; movie Phase 2 off | Governor still heals that list every night |
| Aug 19–26 | #1295–#1352 | Cloud Pivot desk, magnet, no-open-chase, profit-lock | **Live book family.** Catalog did not list it. |
| Aug 26–27 | #1368–#1370 | Notify parity; LETF email PnL; BE lock + static EQ floors | BE lock is a real management fix. Static floors duplicate Loop 1 / governor |

---

## 2. What is already on (do not "enable" these)

Live `model_config` on 2026-08-27 — not the code defaults, not CONTEXT
guesses:

| Flag | Live | Since | Effect |
|---|---|---|---|
| `loop1_specialization_enabled` | **true** | 2026-05-06 | Scorecards update on close; entry consults them |
| `loop1_min_samples` | **3** | 2026-05-06 | Code default is 8; live is looser |
| `loop2_circuit_breaker_enabled` | **true** | 2026-05-06 | Today's pause (`today_pnl_-8.58`) was valid |
| `loop3_personality_management_enabled` | **true** | 2026-05-06 | Personality exits |
| `trade_review_enabled` / `auto_run` / `auto_apply` / `github` | **true** | 2026-08-17–20 | Reviews fire; C-grades wait |
| `ai_cio_enabled` + not shadow | **true** | May / Jun | CIO is live |
| `COO_AUTO_APPLY_TIER1` | **true** (wrangler) | — | Tier-1 numeric nudges apply nightly |
| `deep_audit_setup_demotion_TT ATH Breakout_long` | **blocked** | governor auto-demote | tt-core-entry rejects `setup_demotion_blocked` |
| `…_TT Support Bounce_long` | **blocked** | governor heal | Same |
| `…_TT Range Reversal (Long)_long` | **blocked** | governor heal | Same |
| `deep_audit_mfe_safety_trim_pct` | 2.0 | long-standing | Trims that fire are +EV |
| `deep_audit_ja_post_trim_floor` | true | 2026-08-16 | Post-trim floor |
| `deep_audit_mfe_ratchet_enabled` | true | Jun | Ratchet on |

`learning_proposals`: 9 applied, 10 pending. Last operator decision
wave was **2026-06-26**. August pending rows are mostly "please block
ATH / Support / Gap Reversal" **after those keys were already blocked**.

Trade Review (approx): ~55 approved, ~21 rejected, ~22 reviewed, 6
pending. Dominant grades: **C / LOCATION_WRONG** and **C / PREMATURE_EXIT**.
Auto-apply only handles A/B wins and D/F losses — so the August pattern
never reaches the apply bus.

---

## 3. What is working

- **Loop 2.** Day-PnL breaker tripped on a real −8.58% session (DE/PH/TJX
  Cloud Pivot). Hourly Discord repeats are the designed alarm, not a bug.
- **Weekly governor heal / auto-demote.** ATH, Support Bounce, and Range
  Reversal longs are blocked in `model_config` and loaded via the
  `deep_audit_setup_demotion_` prefix pass-through
  (`worker/decision-records.js`).
- **Trim when it fires.** Last-40: trimmed trades net ~+$210. Bleed is
  the untrimmed full stops, not early winner exits.
- **HTF Reclaim / LTF structure / July autopsy gates.** The families we
  actually refined in early August are the ones that are not the problem.
- **Cloud Pivot management patches** (#1319 wait-for-close, #1352
  profit-lock). These are real; they do not fix admission of a losing
  family.
- **Notify / vehicle parity** (#1368, #1369). Operator can see paper
  LETF / day-trade the same way as ST. Not a PnL loop, but the desk
  can now supervise those books.
- **Post-safety-trim BE lock** (#1370). Closes the DPZ runner-gives-back
  hole. Management, not admission.

---

## 4. What is not working

### 4a. The learner cannot see the family that is bleeding

30d closed ST book (live D1):

| Setup | n | W/L | $ |
|---|---|---|---|
| TT Support Bounce | 20 | 6/12 | **+$312** (blocked, still printed earlier in the window) |
| TT ATH Breakout | 20 | 7/13 | **−$586** (blocked; still the 30d hole) |
| **TT Cloud Pivot** | **12** | **3/8** | **−$140** |
| TT HTF Reclaim | 5 | 2/3 | +$42 |
| TT Range Reversal (Long) | 2 | 0/2 | −$130 |

Cloud Pivot is a **live** `setup_name` (Aug desk + paper promotion).
It was **not** in `CORE_PLAYS`, so:

- `SEVERE_BLEEDER_PATHS` could not auto-demote it
- `catalogDemotionNameMap()` had no `TT Cloud Pivot` key
- Edge scorecard grouped the display name, but governor `allowPaths`
  ignored it
- #1370 then added a **static** EQ floor for `tt_cloud_pivot` — a
  human stand-in for the governor

That is the August failure mode: we taught the system to pause last
month's bleeders, then invented a new family and left it off the list.

### 4b. Loop 1 is on but silent

Combo key = setup × regime × personality × side. A Cloud Pivot long in
CHOP vs TRENDING_UP vs two personalities is four rings. None of them
reach a useful sample, so `loop1ComputeAdvisoryMap` returns no opinion
and `qualifiesForEnter` allows the entry. The **setup** has 12 samples
and a 25% WR — plenty for a block if we roll up.

### 4c. The apply bus is clogged, not empty

Pending as of 2026-08-27 includes ATH / Support Bounce demotions whose
live value is already `blocked`. The nightly processor left them for
the operator. Last human decide pass: June 26. So the desk sees "10
things to approve" that are already true, and does not see Cloud Pivot
at all.

### 4d. Trade Review grades; it does not steer

C / LOCATION_WRONG is the modal August review. `shouldAutoApplyReview`
correctly refuses to auto-mutate on a C. Nothing else aggregates those
C's into a setup-level proposal. The reviews are a diary, not a loop.

### 4e. Governor used to not restore (fixed 2026-08-27 desk)

Support Bounce 30d is +$312 at 30% WR (fat winners). Heal used to
re-write `blocked` for the Aug 19 severe list every night. Heal is now
plumbing only; the learning desk / governor CIO restore writes
`allowed` when 30d n≥12 and PnL > 0. ATH stays blocked (30d −$586).
Un-block is no longer a human-only tier-2.

### 4f. Yesterday's plan repeated the pattern

`tasks/2026-08-31-monthend-evolve.md` said "enable Loop 1" and "run
Analysis Suite." Loop 1 has been on since May. The missing work was
**wiring the new family into the catalog the governor already uses**.

---

## 5. The adapting mechanism (what we are wiring)

No new apply bus. Three missing connections:

```
Cloud Pivot live name
   → play catalog (restricted) + SEVERE_BLEEDER_PATHS
   → weekly governor can heal / auto-demote it tonight
   → tt-core-entry checkSetupDemotion()

Loop 1 combo rings
   → setup × side rollup (__setup__:tt_cloud_pivot:L)
   → qualifiesForEnter fallback when the exact combo has no opinion

learning_proposals pending
   → processProposals marks already-matching rows applied
     (decided_by=already_in_effect)
   → operator queue is only real decisions

edge scorecard
   → group by canonicalPlayId (TT Cloud Pivot == tt_cloud_pivot)
   → demotion_candidates use the same id the governor allow-list has
```

What we are **not** doing:

- Another month-end calibration checklist
- A fourth apply path
- Auto-unblocking Support Bounce
- Turning on movie Phase 2
- Re-enabling `big_mfe_trim` (FIX 9, rejected)
- Treating `ENGINE_ENABLED=false` on the monolith as "engine off"
  (`ENGINE_EXTERNAL=true`; scoring is tt-engine)

---

## 6. What still needs a human (tier-2)

Decide the pending rows that are **not** already-in-effect:

- `deep_audit_weekly_governor_block_widen=true` (WoW −$269) — yes if
  we do not want conviction/sequence widen while Loop 2 is hot
- Discovery knobs (trail ATR 3→3.5, investor accumulate 60→55) —
  unrelated to ST bleed
- Gap Reversal Long demotion (90d PF 0.76) — **do not** blindly block
  the workhorse; play-catalog skill says so

Trade Review C-cluster: if the same setup prints LOCATION_WRONG ≥ 8
times in 14d, file **one** tier-2 EQ-floor or demotion proposal from
the review desk. That aggregator is the next wire; it is not in this
change.

---

## 7. How to verify after deploy

1. `GET /timed/admin/entry-explain?ticker=<a Cloud Pivot candidate>`
   — `loop1_enabled=true`; if the setup rollup is blocked, reason is
   `phase_c_loop1_setup_blocked`.
2. Next nightly governor log: `severe=` includes Cloud Pivot or heal
   writes `deep_audit_setup_demotion_TT Cloud Pivot_long=blocked`.
3. `learning_proposals` pending count drops as ATH/Support rows mark
   `already_in_effect`.
4. Edge scorecard `per_setup` shows `tt_cloud_pivot`, not a split
   display-name row.

---

## 8. Files

- `worker/foundation/play-catalog.js` — `tt_cloud_pivot` restricted
- `worker/pipeline/setup-demotion.js` — severe list
- `worker/phase-c-loops.js` — setup × side rollup
- `worker/index.js` — Loop 1 fallback
- `worker/edge-scorecard.js` — canonical grouping
- `worker/learning-proposals.js` — already-in-effect
- `skills/learning-loops.md` — so the next agent does not start over
