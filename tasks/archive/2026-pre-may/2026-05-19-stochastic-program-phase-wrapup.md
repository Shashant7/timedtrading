# Stochastic Research Program — Phases 1–5 Wrap-up

**Date:** 2026-05-19
**Status:** Phases 1–5 shipped to production. Phase 6 (cell-Markov / divergence-aware admission) gated on signal-quality verification.
**Owner doc for the original program:** `tasks/2026-05-18-stochastic-research-program.md`

---

## 1. What we set out to build

Three user-asked questions framed the program:

1. **Dependencies** — does RSI confirm price (divergence detection)? What other multi-signal dependencies hold and break?
2. **Long-term probability** — how often does a given setup work, conditioned on ticker / regime / universe / recent history?
3. **Extremes** — when does the dependency break, what is the impact, and what caused it?

Plus the cross-cutting question: how do EMA cross / SuperTrend flip triggers actually perform vs. random?

The program decomposed into six phases:

| Phase | Theme | Layer | Behavior change? |
|------:|-------|-------|------------------|
| 1 | Trajectory data foundation + cohort calibration | data | no (read-only) |
| 2 | Trigger hit-rates + stage-Markov visibility | calibration | no (read-only) |
| 3 | Random-walk null hypothesis | calibration | no (read-only) |
| 4 | Cohort-gated admission (G1 pause, G2 cohort-fail block) | live engine | **YES** |
| 5 R3 | Chop-regime sizing haircut | live engine | **YES** |
| 6 | Cell-Markov divergence-aware admission | live engine | not yet |

This doc summarizes what landed, what's measurable, what's still pending verification, and the entry criteria for Phase 6.

---

## 2. What shipped per phase

### Phase 1 — Trajectory data foundation (PR #205, #206, #207)

- New D1 table `trade_trajectories` stores bubble-map cell sequences for every historical trade (`cell_entry`, `cell_pre_json`, `cell_during_json`, `cell_exit`).
- New module `worker/lib/trajectory-cells.js` discretizes each `trail_5m_facts` row into a 640-cell key: `{stateCode}|D{decile}|C{completionBand}|P{phaseBand}`.
- New module `worker/lib/trade-trajectories.js` backfills historical trades into the table and exposes `findCohortByTrajectory()` for live-candidate cohort lookup.
- Backfill endpoint: `POST /timed/admin/trajectory/backfill`. Stats: `GET /timed/admin/trajectory/stats`. Live cohort lookup: `GET /timed/calibration/cohort`.
- **Hotfix in #207:** `trail_5m_facts` aggregation was silently failing for 22 days due to D1 CPU timeout from correlated subqueries. Replaced with `worker/lib/trail-facts-light.js` — per-ticker, no correlated subqueries. Backfilled the gap; aggregation now current.
- **Bug fix in #206:** new endpoints were 404ing because routes weren't registered in the `ROUTES` allowlist.

### Phase 2 — Trigger hit-rates + stage-Markov (PR #208, #211)

- `worker/lib/trigger-hitrate.js` computes hit rates for ST flips, EMA crosses, and squeeze releases per ticker + per regime. Surfaces via `GET /timed/calibration/trigger-hitrate`.
- `worker/lib/stage-markov.js` builds the kanban-stage transition matrix (watch → setup → in_review → enter → defend → trim → exit) and recovery probabilities. Surfaces via `GET /timed/calibration/stage-markov`.
- Trajectory-cohort calibration: `POST /timed/calibration/trajectory-cohort` for live what-if scoring.
- **Bug fix in #211:** trigger direction was always classified as 'continuation' because `inferFlipDirection` used state transition instead of state at the event bucket. Fixed.

### Phase 3 — Random-walk null hypothesis (PR #209)

- `worker/lib/random-walk-null.js` implements a simple random-walk null test: shuffle entry timestamps within a ticker × regime cell and compare realized PnL distribution vs. our actual trades.
- Surfaces via `GET /timed/calibration/random-walk-null`.
- This is the "is our edge real or are we just trading noise?" check that gates Phase 4 going live.

### Phase 4 — Cohort-gated admission, live (PR #210, #214, #215, #216)

- **G1 gate:** `pause_gap_reversal_long` — `tt_gap_reversal_long` triggers fail at entry when the feature flag is on. Validated against backtest: this trigger has the worst cohort PF in the universe.
- **G2 gate:** cohort-fail block — when a live candidate's nearest cohort (by trajectory cell + regime) has PF < threshold and WR < threshold, the entry is rejected with reason `cohort_fail_block`.
- **Decision logging:** `worker/lib/admission-cohort-log.js` writes every admission decision (accept/reject) with cohort metrics to a new D1 table `admission_cohort_log`. Exposed via `GET /timed/admin/cohort-admission/{gates,log,summary}`.
- **Bug fix in #214:** `processTradeSimulation`'s lazy-load path for `_deepAuditConfig` had a hardcoded `_daKeys` list that omitted `"gates"`. Phase 4 G1/G2 were silently bypassed on HTTP/queue-triggered invocations. Added `"gates"` to the lazy-load list and to `REPLAY_DA_KEYS`.
- **SHORT-side Option A (#214):** setup-driven direction for `tt_gap_reversal` trigger. `effectiveDir` is derived from the setup card (not the bundle's `state`), so gap-reversal-SHORT routes through the correct admission matrix rather than being blackholed.
- **Traceability fix (#215):** engine-layer G1 rejections were happening before `admission_cohort_log` write. Fixed so even pre-cohort rejections are logged for full audit.

### Phase 5 R3 — Chop-regime sizing haircut (PR #216)

- New `__chop_size_mult` stamped by `_p5ChopHaircutPlan` in `processTradeSimulation`.
- `gatherSizingMultipliers` in `worker/pipeline/sizing.js` now includes `chop` in `rawCombined` and `breakdown` so position size is reduced when the regime is choppy (per the give-back diagnostic in `tasks/2026-05-18-chop-regime-defense-diagnostic.md`).
- Tunables live in `model_config` under the chop-haircut prefix; default config is conservative.

### Phase 6 prep (PR #212)

- `worker/lib/cell-markov.js` builds outcome-split cell-Markov transition matrices (WIN cells → next-state distribution vs. LOSS cells → next-state distribution). The divergence between these two distributions is the input signal for Phase 6's planned divergence-aware admission. Surfaces via `GET /timed/calibration/cell-markov`.
- **Not yet wired into live admission.** See Phase 6 entry criteria below.

---

## 3. Cross-cutting fixes shipped alongside the program

### P0: stop-loss leak (PR #217, #218, #220, #221)

A user-reported P0 surfaced four trades (IWM, DE, DIA, MLI) trading 0.7%–3.4% past their stop loss without closing. Multi-layer hotfix:

| # | Layer | Fix |
|---|-------|-----|
| #217 | regex | Extended `isSLExit` and `_exitIsHard` regexes to match `sl_breached` |
| #218 | safety net | Independent check: if `pxNow` past `positions.stop_loss`, override `exitReasonRaw='sl_breached'` regardless of what `classifyKanbanStage` set |
| #220 | gate flags | Safety-net also clears `fuseExitFired = false` and `tickerData.__force_defend_stage = false` so soft-fuse / cloud-expanding / phase-leave defer paths can't shadow an actual SL breach |
| #221 | diagnostics | `[SL_SAFETY_NET_TRACE]` + `[SL_GATE_TRACE]` log every guard/gate value when an SL breach is detected, so the next residual blocker (if any) is immediately visible in worker logs |

Additionally, `deep_audit_parity_skip_sl_breach` was flipped from `true` → `false` in production `model_config`. This was a historical backtest-parity crutch from Iter5/July recovery that suppressed `sl_breached` exits for `momentum_score / ripster_momentum / *_confirmed_long` paths. No currently-open trades are on parity-eligible paths so impact is zero today, but it removes a forward-looking SL-leak vector.

### Today-page UX (PR #200, #201, #202, #219)

- Daily Brief summary truncation fixed (`extractClosingLine` now requires terminal punctuation).
- SPY/QQQ/IWM Predictions language unified with Game Plan card.
- Pre-market/extended-hours prices on `MarketPulseTile` and `FocusRail`.
- Recent Activity strip uses admin feed for admin users; classifies new event types.
- Mobile bottom-nav badges for trader/investor tabs.
- Empty-state copy improved.
- `BriefPlaceholder` replaces empty skeleton while the brief loads.

### CI/CD (PR #196, #197, #198, #199)

- Node.js 22 in the deploy workflow (wrangler 4.x requires it).
- `npm install` + `build:frontend` + `embed-dashboard` baked into the deploy steps.
- `wrangler-action` argument quoting fixed (`--env=` not `--env=''`).
- Path filter expanded so frontend changes actually trigger a deploy.

---

## 4. What's measurable today

Live D1 + KV give us the following dashboards / signals out of the box:

| Surface | Source | Useful for |
|---------|--------|------------|
| `GET /timed/admin/cohort-admission/summary` | `admission_cohort_log` | Per-day count of G1/G2 rejections, accept rate by trigger, reject reason histogram |
| `GET /timed/admin/cohort-admission/log` | same | Drill-down per ticker / per trade decision with cohort metrics |
| `GET /timed/calibration/trigger-hitrate` | `trail_5m_facts` | Hit rate of ST flips / EMA crosses / squeeze releases by regime |
| `GET /timed/calibration/stage-markov` | trade history + kanban transitions | Stage transition matrix; "recovery from defend" probability |
| `GET /timed/calibration/random-walk-null` | trade history | Null test — does our edge beat shuffled-entry baseline |
| `GET /timed/admin/trajectory/stats` | `trade_trajectories` | Backfill coverage, freshness, cell distribution |
| `GET /timed/calibration/cohort` | `trade_trajectories` + live candidate | Live what-if cohort lookup |
| `GET /timed/calibration/cell-markov` | `trade_trajectories` | Outcome-split state transition divergence (Phase 6 input) |

For trader-facing UX, the Today page now exposes daily-brief summary, EXT prices on cards + FOCUS rail, activity strip, and nav badges.

---

## 5. What's still pending verification

| Item | Owner of next action | Blocker |
|------|----------------------|---------|
| SL safety-net + defer-flag clearing + diagnostic traces | `[SL_SAFETY_NET_TRACE]` + `[SL_GATE_TRACE]` in worker logs on next `*/5` cron | Need to tail post-PR-#221 deploy and identify which guard/gate value is still falsy for IWM/DE/DIA/MLI. Likely candidates: `exitCooldownOk` (5-min cooldown after any prior exit attempt), or the safety-net IF is being skipped because `tickerData.__sl_safety_net` mutation isn't persisted (only proves "no log" not "didn't fire") |
| Phase 4 G1/G2 actual rejection rate vs. backtest | `admission_cohort_log` summary | Need 3–5 trading days of live data to compare reject rate + accepted-trade quality vs. shadow-mode baseline |
| Phase 5 R3 chop haircut impact on give-back | open-trade R-multiple distribution by `__chop_size_mult` | Need 2–3 weeks of chop-regime trades to measure |
| SHORT-side Option A — does setup-driven direction reopen the SHORT lane? | trade count by direction, post #214 | Track weekly SHORT-trade count; pre-fix was ~0 |

---

## 6. Phase 6 entry criteria (proposed)

Phase 6 wires cell-Markov outcome-split divergence into live admission (G3 gate). Before flipping it on, the following must be true:

### Data prerequisites

- [ ] `trade_trajectories` backfill coverage ≥ 90% of historical trades with ≥ 1 cell.
- [ ] `cell_markov` outcome-split matrix has ≥ 50 trades per cell for at least the top 30 cells.
- [ ] Divergence between WIN and LOSS next-state distributions is statistically significant (KL-divergence > 0.3 or chi-square p < 0.05) for at least 10 cells.

### Engine prerequisites

- [ ] Phase 4 G2 cohort-fail block has been live for ≥ 5 trading days with no false-positive rejections of high-quality setups (manual spot-check via `admission_cohort_log`).
- [ ] SL leak is fully diagnosed and closed (PR #221 trace evidence → targeted fix shipped → 0 trades past SL for 1 trading day).

### Behavioral prerequisites

- [ ] Phase 4 + Phase 5 R3 combined effect: chop-regime give-back trades show ≥ 30% reduction in average R lost vs. pre-program baseline.
- [ ] Random-walk null test (`GET /timed/calibration/random-walk-null`) confirms our cohort edge is > 2 standard deviations above shuffled-entry baseline.

### Phase 6 rollout plan (when criteria met)

1. **Shadow mode first** (≥ 5 trading days): G3 evaluates every candidate but doesn't reject; decisions written to `admission_cohort_log` with `mode='shadow'`.
2. **Comparison report:** shadow-mode rejections vs. actual trade outcomes — confirm G3 would have improved expectancy.
3. **Live with one-flag rollback:** flip `gates.cell_markov_divergence_enabled = true`. Engine reads this every cron, so disable is one D1 UPDATE away.
4. **Watch for 1 week:** monitor reject rate + accepted-trade quality. If reject rate > 20% or accepted-trade WR drops, flip back.

---

## 7. File index (where each thing lives)

| File | Role |
|------|------|
| `worker/lib/trajectory-cells.js` | 640-cell discretization |
| `worker/lib/trade-trajectories.js` | Backfill + live cohort lookup |
| `worker/lib/admission-cohort-log.js` | D1 write of every admission decision |
| `worker/lib/trigger-hitrate.js` | ST/EMA/squeeze trigger hit-rate analyzer |
| `worker/lib/stage-markov.js` | Kanban stage transition matrix |
| `worker/lib/random-walk-null.js` | Simple random-walk null hypothesis test |
| `worker/lib/cell-markov.js` | Outcome-split cell-Markov (Phase 6 input) |
| `worker/lib/trail-facts-light.js` | Per-ticker D1-friendly trail aggregation (CPU-budget hotfix) |
| `worker/pipeline/tt-core-entry.js` | G1 + G2 + SHORT Option A admission logic |
| `worker/pipeline/sizing.js` | Chop multiplier integration |
| `worker/replay-runtime-setup.js` | `REPLAY_DA_KEYS` (includes `"gates"`) |
| `worker/migrations/add-trade-trajectories-table.sql` | `trade_trajectories` schema |
| `worker/index.js` | ROUTES allowlist; lazy-load `_deepAuditConfig`; SL safety-net (parts 1–4) |
| `tasks/2026-05-18-stochastic-research-program.md` | Original program spec |
| `tasks/2026-05-18-chop-regime-defense-diagnostic.md` | Phase 5 R3 motivation |
| `tasks/2026-05-19-short-side-blackout-diagnostic.md` | SHORT Option A motivation |
| `tasks/2026-05-19-stochastic-program-phase-wrapup.md` | **(this doc)** |

---

## 8. Lessons (for `tasks/lessons.md` if/when updated)

1. **Lazy-load lists must be exhaustive.** Adding a new `gates` blob to `_deepAuditConfig` silently broke G1/G2 for all non-cron invocations until the lazy-load `_daKeys` array was updated. The fix is to make `REPLAY_DA_KEYS` the single source of truth and import it everywhere, not duplicate the list inline.
2. **Hard exits must be unconditional.** The SL leak (PR #217 → #218 → #220 → #221) shows how many soft-defer paths (doctrine, soft-fuse, cloud-expanding, phase-leave, parity-skip, trim-shield) can shadow an actual SL breach. SL is a hard ceiling and must not be overridable by any signal-based defer. The safety-net pattern (independent recheck at the gate, force the hard-exit reason, clear any defer flags) is the structural fix.
3. **D1 CPU budget kills correlated subqueries.** The trail-facts aggregation silently failed for 22 days because the INSERT statement had 10+ correlated subqueries. Per-ticker loops with simple aggregates are slower per query but stay under the budget.
4. **Routes allowlist is a hidden coupling.** Adding new endpoints requires touching `ROUTES` in `worker/index.js` even when the handler is registered. Easy to miss; verify with a `curl` smoke test before declaring "deployed."
5. **Phased rollouts pay off.** Splitting the program into read-only data → visibility → null-test → live admission → sizing kept the blast radius small and made each phase independently measurable. P0 hotfixes were able to land in parallel without backing out research progress.
