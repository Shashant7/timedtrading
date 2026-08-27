# Month-End Evolve — 2026-08-31

Owner: model core (short-term equity). Trigger: August drawdown, Loop 2
day-P&L trip (−8.58%), 27% WR on last 40 closes, no material PnL uptick.

Read first: `tasks/2026-08-19-playbook-audit.md`,
`tasks/2026-08-18-movie-reframe.md`,
`tasks/2026-08-15-july-st-autopsy-feedback.md`, and the Ripster-BE lineage
in `tasks/lessons.md`.

---

## 1. What we already deployed today (2026-08-27)

- **Unconditional post-`MFE_SAFETY_TRIM` BE lock** — runner half can never
  take the full pre-trim stop (DPZ 8/24 pattern). Structure-advance stop
  still applies on top.
- **Per-setup entry quality floor** — `deep_audit_setup_min_entry_quality_json`,
  defaults `{tt_ath_breakout: 50, tt_atl_breakdown: 50, tt_cloud_pivot: 45}`.
  Blocks entry with reason `da_setup_entry_quality_floor`.
- **Setup blocklist** — `deep_audit_setup_blocklist` (CSV of normalized
  entry_paths). Operator can pause a lane without a deploy — reason
  `da_setup_blocked`.
- **LETF / day-trade email + Discord parity** (Entry / Exit / P&L) — PR
  #1369.

---

## 2. Diagnosis heading into month-end

Last 40 closed live trades:

| Slice | Value |
|-------|-------|
| Record | 10W / 28L (27% WR) |
| Sum PnL | ~−35% |
| Trimmed | 40% (16 / 40) |
| **Untrimmed losses** | **23 / 28 losses (sum ≈ −40%)** |
| Trimmed trade net $ | +$210 (banking works when it fires) |

Bleed is **entries that never reach +2%** and full-stop out (Cloud Pivot /
ATH Breakout dominate). Not "exiting winners too early." When
`MFE_SAFETY_TRIM` fires, the trade is usually net positive.

---

## 3. Immediate actions (this week, no code)

Use the Analysis Suite (`system-intelligence.html`) + `/timed/admin/model-config`.

- **Blocklist trial** — Set `deep_audit_setup_blocklist=tt_ath_breakout`
  for 3 sessions; measure delta on WR, MFE-to-stop, and dollar bleed.
  Rollback if the setup's win rate wasn't the problem.
- **Tighter Cloud Pivot EQ** — Bump
  `deep_audit_setup_min_entry_quality_json` to
  `{tt_ath_breakout: 55, tt_cloud_pivot: 50}` (defaults are conservative);
  re-baseline after 30 closes.
- **Enable Loop 1 specialization scorecard** —
  `loop1_specialization_enabled=true` (currently off). Reads
  `phase-c:scorecards`, raises rank bar +20 when combo WR<45%, blocks when
  <30%. Runs alongside blocklist; kill-switch via same flag.
- **Portfolio DD haircut enforcement (already default ON in code) —
  verify live**. `portfolio_dd_size_haircut_enabled` should tick position
  size down as equity nears 5% DD. Confirm in `/timed/portfolio-risk`.
- **`ENGINE_ENABLED` sanity** — confirm live-tick pulses (Discord
  "System Alerts" cadence). Loop 2 is tripping, so it is on; document the
  path so `loop2_pause_active` propagation is unambiguous.

---

## 4. Additional Ripster-BE follow-throughs (worth doing)

Ranked by leverage × safety.

### A. Cohort WR floor (tt-core)

`worker/pipeline/tt-core-entry.js` — `cohort_min_n=15, cohort_wr_floor=0.40`.
Currently reads defaults; needs a live overlay per setup×direction from
`phase-c:scorecards`. Blocks entry when cohort WR < 40 with enough sample.
Complements Loop 1.

### B. Bump `deep_audit_mfe_ratchet_lock_frac` during Loop 2 pause

Now `0.40` (keep 40% of peak). When Loop 2 has tripped in last 48h,
temporarily lift to `0.55` so peak-2% winners bank sooner. Restore on
regime green. One helper in `worker/pipeline/mfe-ratchet.js` reading
`env._loop2Pause`.

### C. Directional cap on long book after streak

`worker/index.js` already caps same-direction concentration at 5 open. Add
a "streak override": after 3 consecutive full-stop losses in one direction,
cap at 3 open on that side for 24h. `deep_audit_dir_streak_cap` (default
0 = off).

### D. Trim-then-defend for `POST_TRIM_ENTRY_FLOOR` deadband

`POST_TRIM_ENTRY_FLOOR` is on (`deep_audit_ja_post_trim_floor=true`). It
force-exits the remainder if pnl <= entry − 0.15%. Winners like ETN
(+0.21%) get exited too tight; losers like WAL take the full leg because
the trim was too small (10%). Tighten the buffer only on runners that
had a real MFE (`>= 1R`) and were trimmed ≥ 50%.

### E. Enable Loop 1 specialization

`loop1_specialization_enabled=true`. Log-only for a week (already
non-destructive: `raise_bar_lift` and `block_wr` are advisory unless the
gate consumer wired them to hard blocks). Then flip to enforce.

### F. Setup-scoped SL widen when EQ ≥ threshold

Winners in the last 40 had wider MFE (LLY +8.6%, AXON +2.4%, USO +2.2%).
Losers had SL clustered at exactly −2%. If EQ ≥ 65, allow SL to be
1.7×ATR instead of 1.2×ATR — captures more of the good ones. Config:
`deep_audit_sl_atr_mult_high_eq` (default 1.7, gated by
`deep_audit_setup_min_entry_quality_json` matching).

---

## 5. Analysis / calibration / paper mode surfaces to run

### A. Analysis Suite (System Intelligence)

- **Analysis → Calibration → Health** — run "Analyze Now" now; if WFO
  PASS, hit **Apply All** to promote `calibrated_sl_atr`,
  `calibrated_tp_tiers`, `adaptive_entry_gates`. Requires ≥80 trades,
  VIX coverage ≥80% — we probably meet both.
- **Analysis → Calibration → Entries** — inspect entry-path performance.
  Confirm Cloud Pivot / ATH Breakout live scoreboard, promote or veto per
  path.
- **Runs tab** — pick the most recent WFO PASS backtest and promote its
  ledger via `/timed/admin/promoted-trades/promote`. Cross-check with SI
  Apply All so we don't clobber Bayesian priors.

### B. Paper-mode experiments

Three families in paper (all `paper_mult=0.1`): `tt_cloud_pivot`,
`confirm_stack_ema21`, `momentum_continuation`.
Look at `/timed/admin/trust-spine/family-attribution?family=all&days=30`
for `widen_ready` (avg MFE-keep ≥ 0.35, PF ≥ 1, expectancy > 0). Promotion
lever: bump `deep_audit_confirm_stack_sequence_paper_size_mult` (or
equivalent per family) from 0.1 → 0.3 for a two-week paper widening
before a live vote.

Also verify **index day-trade options** and **index trend LETF** rings
(paper lanes, separate from families) — new PR #1369 makes their alerts
first-class; give the emails a week and check bank / exit hit rate.

### C. Frame-by-frame narrative gates

`_frames` + `_armed_playbooks` currently **shadow only**. Phase 2 (feed
armed playbooks into entry) stays off. But **investor movies are live**
(`resolvePrimaryInvalidationMovie`, `resolveInvestorFailedEntryReclaim`).

Month-end task: read `GET /timed/admin/context/shadow-report` and grade
armed playbooks (`weekly_breakout_retest`, `daily_ema21_reclaim`) against
5-day forward. If a playbook has ≥ 60% capture on 20+ arms, propose a
narrow live-fire — e.g. a rank boost of +5 when armed. Not a full
Phase 2.

### D. Calibration

- **Full deep-audit run** — `POST /timed/calibration/deep-audit`. Produces
  the full autopsy scoreboard. Land the top 3 recommendations via
  `/timed/admin/model-config` (skip narrative-only).
- **Adaptive SL/TP** — verify `adaptive_sl_tp` is populated after Apply
  All; roll out for the next week; measure R:R capture.
- **Ticker-character personalities** — spot-check that CPER / ATH
  Breakout tickers are being tagged VOLATILE_RUNNER vs mean-reverting;
  incorrect tags feed the wrong exit doctrine.

---

## 6. Month-end evolve program (Aug 31 → Sep 15)

| Week | Focus | Success signal |
|------|-------|----------------|
| Aug 27–Aug 30 | Apply the 3 fixes shipped today; blocklist trial; enable Loop 1 log-only | Blocklist reduces daily bleed by ≥ 30% |
| Aug 30–Sep 1 | Month-end calibration Apply All; verify DD haircut | WFO PASS; adaptive SL/TP live |
| Sep 1–Sep 7 | Turn on Loop 1 enforce, cohort WR floor overlay | WR floor + PF floor per combo respected |
| Sep 7–Sep 12 | Ratchet lock overlay, dir-streak cap | Runners bank sooner; drawdown flattens |
| Sep 12–Sep 15 | Paper family attribution → propose first widen (0.1 → 0.3) | One family reaches `widen_ready` for 14d |

Each Friday: log net PnL delta vs prior Friday, WR (last 30), best
setup, worst setup. If any weekly delta is < 0, roll back to prior config
snapshot via `POST /timed/calibration/rollback`.

---

## 7. Guardrails

- **Never** turn on `deep_audit_big_mfe_trim_enabled` — rejected in FIX 9;
  killed BE-class winners.
- **Never** flip Phase 2 movie without first grading shadow report ≥ 20
  arms per playbook.
- **Never** widen entry gates while WR is < 40%; only tighten or move to
  paper.
- **Loop 2 auto-clears at session open** — don't manually unpause during
  the same day, even if the number "looks fine."

---

## 8. Open questions to close before Sep 1

1. Is `MFE_SAFETY_TRIM` firing on 100% of trades that reach +2%? Sample
   the last 40 with `execution_actions` join — if not, investigate the
   stale-price / RTH-gate paths that block the trim.
2. Do sector caps have any bite when we're 27:3 long-vs-short? Cap trip
   log for the past 30 days.
3. Cloud Pivot vs ATH Breakout — which one's WR is worse? Blocklist the
   correct one, not both.
4. Are we still admitting entries during the first 30 min RTH after the
   opening-window veto shipped? Shadow says yes; entry gate says no. Check.
