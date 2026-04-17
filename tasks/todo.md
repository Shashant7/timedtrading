# Current Tasks

> **Plan:** Start with `tasks/PLAN.md`, then use `tasks/jul-apr-recovery-and-promotion-plan-2026-04-08.md` as the authoritative recovery path and `tasks/jul-apr-validation-contract-2026-04-08.md` as the launch gate for every future lane.
>
> **Active holistic plan (2026-04-17):** `tasks/holistic-regime-calibration-plan-2026-04-17.md` — monthly backdrop + monthly slicing + SPY ≥ 80 % track + dynamic regime calibration, executed by a Cloud Agent against feature branches (one PR per phase). This supersedes any open R6 / widen-v7 / v6-full-universe sub-items below once Phase A lands.

## Holistic Regime Calibration [2026-04-17]
- [ ] **Phase A — Foundation freeze** (branch `phase-a/foundation-freeze`): commit R5 + R6 + KV-binding fix as one reviewable PR; lock `R5 ON + R2v3 ON + R6 ON` as the base package; redeploy worker and record Version ID; append orchestrator / dual-writer / Bug E lessons to `tasks/lessons.md` (done on this plan branch).
- [ ] **Phase B — Monthly backdrop framework** (branch `phase-b/monthly-backdrop`): build `scripts/build-monthly-backdrop.js` emitting per-month JSON with cycle / sector / regime / cross-asset-vol / event density; commit 10 backdrop JSONs for `2025-07 … 2026-04`.
- [ ] **Phase C — Monthly slicer + first slice** (branch `phase-c/monthly-slicer`): ship `scripts/monthly-slice.sh` with dual-writer guard + stall watchdog; run `2025-07` end-to-end; commit `report.md` + `proposed_tuning.md`.
- [ ] **Phase D — Per-month slices + reports** (branch template `phase-d/slice-<YYYY-MM>`): one PR per month for the 24-ticker universe, gated by WR / big-winner / PnL parity rules in the plan.
- [ ] **Phase E — SPY optimization track** (branch template `phase-e/spy-track-<YYYY-MM>`): SPY-only overlay tightening to reach ≥ 80 % WR across all 10 months; finalize `configs/spy-overlay.json` + `spy-acceptance-report.md`.
- [ ] **Phase F — Dynamic regime calibration** (branch `phase-f/regime-calibration`): translate Phase D + E insights into regime-conditional DA keys for setup favoring / risk sizing / management; full 10-month replay parity gate before merge.
- [ ] **Phase G — Walk-forward holdout** (branch `phase-g/walkforward-holdout`): hold out `2026-03` and `2026-04`; validate Phase F config against holdout; gate merge on holdout WR within 3 pp of training.
- [ ] **Phase H — Cloud Agent runner** (branch `phase-h/cloud-agent-runner`): ship `scripts/cloud-agent-monthly.sh` so the Cloud Agent can drive Phase D / E slices without human intervention; dry-run on `2025-07`.



## Bug C: Silent Pinned-Config Fallback [2026-04-17]
- [x] Root-cause identified: `loadRunConfigSubset` in `worker/replay-runtime-setup.js` binds ~170 parameters in `config_key IN (…)`, exceeds Cloudflare D1's ~100 bind-param cap, throws inside a silent `try/catch`, so `resolveReplayPinnedConfig` returns `{config: null, source: "live_fallback"}` and every pinned run-snapshot value (blacklist, short_min_rank, dynamic_engine_rules, reference_execution_map, scenario_execution_policy, all deep-audit toggles) silently falls back to live `model_config`. Masked Bugs A + B entirely; explains the 24 SHORT / 6 ABT divergence in widen v3.
- [x] Fix: drop the `IN` filter from both `loadRunConfigSubset` and the `deepAuditConfig` fallback query; read all rows for the run (or all of `model_config`) and post-filter in JS. Deployed as worker version `ae26a975-1a29-4f67-870a-2cc62ad17f10`.
- [x] Silent-catch audit: converted ~15 `} catch {}` sites across `worker/replay-runtime-setup.js`, `worker/backtest-runner-do.js`, `worker/replay-candle-batches.js`, `worker/replay-interval-step.js` to tagged `console.warn` so future silent fallbacks surface in `wrangler tail`.
- [x] Reverted the temporary `[UG_CALL]/[UG_ABT_ENTRY]/[GATE_DEBUG_ABT]/[GATES_MODULE_LOAD]` debug probes in `worker/pipeline/gates.js`; retained the Bug B string/CSV blacklist parser.
- [x] Validation ladder passed: focused `focused-bugc-validate-v1` (0 ABT trades, `[REPLAY] Using pinned run config from archive … (144 keys)` fires); Jul-Nov widen `refinement-jul-nov-widen-bugc-fixed-v4` (71 LONG trades, 0 SHORT, 0 ABT, 62% win rate vs widen v3's 56/24/6/42.9%). Bug C alone explains the full divergence; no residual code-drift hunt needed.
- [ ] Jul-Apr full run `jul2025-apr2026-full-bugc-fixed-v1` inheriting widen v4 pinned config (launched 2026-04-17, ~2-3 hr runtime). Monitoring for completion.
- [ ] Refinement queue from widen v4 inspection:
  - **R1**: SGI Jul 28 LONG held 4 days through invalidation (stage=DEFEND within 80 min of entry, rank collapsed 99->49, yet no mgmt exit fired). Root cause = parity flags `deep_audit_parity_skip_sl_breach` + `deep_audit_parity_skip_stall_force_close` + 6-hour `deep_audit_min_hold_before_mgmt_exit_min` together disable all management exits between entry and `HARD_LOSS_CAP`. Options: honor `deep_audit_max_loss_pct:-3` as a hard floor that bypasses parity skips; re-enable sl_breach on rank-collapse signal; enable `deep_audit_peak_reaction_lock_enabled`.
  - **R2**: RIOT Sep 24 LONG trimmed 50% within 10 min at breakeven, held remainder overnight, gapped down into `HARD_LOSS_CAP` pre-market on Sep 25. Not a RIOT earnings date (actual: Jul 31, Oct 30, Feb 25). Add overnight-exposure guard: for trades in DEFEND at end of RTH with <30 min to close, auto-flatten remainder.
  - **R3**: `deep_audit_pre_earnings_entry_block_enabled` is currently `None` (off). Enable for the model-wide catalog (RIOT Oct 30, ETN Sep 29, etc.). Doesn't explain RIOT Sep 24 but still valuable.
- [x] Bug D (2026-04-17): `BacktestRunner.runSessions()` was re-sending `config_override` as the replay POST body, which the runtime treated as a `directConfigOverride` and used to REPLACE the full pinned snapshot. Net effect: any `config_override` field on `/timed/admin/backtests/start` silently collapsed the 146-key pinned snapshot to only the override keys at runtime. Fix: `buildSessionReplayUrl` already passes `runId`, snapshotConfig already wrote the merged snapshot into `backtest_run_config`, so the replay body must be empty — D1 is the single source of truth. Diagnostic log to look for in tails: `[REPLAY] Using pinned run config from direct override … (N keys)` with N much smaller than expected.
- [ ] Prepare single review-ready commit for Bugs A + B + C + D + silent-catch audit + debug-log revert (message: "fix: route pinned backtest config through D1 without bind-param overflow and surface silent config-load failures"). Pending user review.


## Jul->Apr Promotion Path [2026-04-08]
- [x] Freeze the current postdeploy `Jul -> Sep` deterministic lane as the active cumulative savepoint before beginning variable-aware recovery work *(saved as `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md` with artifact `focused-jul-sep-mainline-deterministic-postdeploy-v1-20260411--20260411-082805`, run `focused_replay_20260411-082805@2026-04-11T15:28:57.408Z`, git SHA `d2e6f343ac0615b6ed4a9999fb609469f74076ac`, and the working interpretation that July is the anchor, September is promising, and August is the active pressure zone.)*
- [x] Formalize the month-compounding workflow around the active Jul->Sep savepoint, including isolation-first month validation, mandatory cumulative reruns, and revert rules *(captured in `tasks/month-compounding-operating-model-2026-04-11.md`; the active working rule is now August isolation first, then `Jul -> Sep` rerun before any widening.)*
- [x] Define the first durable variable evidence matrix contract for ticker / sector / regime / setup policy decisions *(captured in `tasks/variable-evidence-matrix-contract-2026-04-11.md`, including required dimensions, metrics, evidence levels, promotion order, and anti-overfit rules.)*
- [x] Map the variable evidence outputs onto the existing runtime policy surfaces instead of creating a parallel adaptive system *(captured in `tasks/variable-runtime-policy-map-2026-04-11.md`; v1 routing now prefers `scenario_execution_policy`, ticker learning runtime policy, `reference_execution_map` for narrow windows, and `regime_params` for scalar behavior changes.)*
- [x] Define the one-ticker `Jul -> Apr` learning loop as an evidence-generation tool with explicit anti-overfit guardrails *(captured in `tasks/ticker-focused-learning-loop-2026-04-11.md`; one-ticker replays now feed the matrix and month-control loops rather than acting as direct promotion evidence.)*
- [x] Generate the first variable evidence matrix from the frozen `Jul -> Sep` savepoint, focused on August as the active pressure zone *(saved to `data/regime-config-decision/jul-sep-savepoint-regime-evidence-20260411.json` and `.md`; the first pass confirms August is the only red month and that `regime_overlay` is the preferred promotion layer.)*
- [x] Classify the main August pressure cluster into baseline, regime, profile, or ticker-specific buckets before changing runtime behavior *(captured in `tasks/august-pressure-zone-first-pass-2026-04-11.md`; conclusion: not baseline-first, primary `regime_overlay`, profile secondary, ticker exceptions still diagnostic-only.)*
- [x] Prepare the first narrow variable-aware runtime policy candidate on the approved routing surface *(captured in `tasks/first-variable-runtime-policy-candidate-2026-04-11.md` and `data/regime-config-decision/august-transitional-choppy-selective-candidate-v1-20260411.json`; the prepared candidate tightens the existing `choppy_selective` protection profile rather than introducing a new adaptive layer.)*
- [x] Design the next August policy candidate now that AGQ lifecycle parity is fixed *(captured in `tasks/second-august-policy-candidate-2026-04-12.md`; conclusion: the broad `choppy_selective` regime/profile tightening path should not be retried after the v1 no-op, and the next prepared candidate is a narrow `AGQ` pullback exception because the real August damage survives parity repair while the Aug 25 winner cleanly separates from the two losing AGQ branches.)*
- [x] Write the second candidate analysis and machine-readable artifact once the active surface is identified *(stored in `tasks/second-august-policy-candidate-2026-04-12.md` and `data/regime-config-decision/agq-august-pullback-exception-v2-20260412.json`; the active surface is the existing `tt_core` pullback guard family in `worker/pipeline/tt-core-entry.js`, not `scenario_execution_policy` or ticker `runtime_policy`, because the current approved runtime carriers are too coarse to express the required AGQ entry block.)*
- [x] Freeze the completed `Jul -> Sep` AGQ-exception cumulative rerun as the active challenger package *(captured in `tasks/jul-sep-challenger-agq-exception-v2-2026-04-12.md`; challenger artifact `focused-julsep-mainline-agq-exception-v2-20260412--20260411-225718`, run `focused_replay_20260411-225718@2026-04-12T05:58:06.895Z`, same code SHA `d2e6f343ac0615b6ed4a9999fb609469f74076ac` as the frozen savepoint, and headline delta `+$348.72` vs the frozen cumulative lane.)*
- [x] Audit the `RIOT` path drift between the frozen `Jul -> Sep` savepoint and the AGQ-exception challenger *(captured in `tasks/riot-drift-audit-agq-challenger-2026-04-12.md`; conclusion: the early-July `RIOT` timestamp substitution is the same known residual mismatch seen before this candidate, while the large Sep 4 PnL giveback is a sizing/path drift on the same trade ID rather than a new semantic entry/exit failure, so the challenger is acceptable to keep but not yet a zero-drift promotion package.)*
- [x] Publish one concrete runtime decision-flow diagram for how scenario-aware behavior is resolved in the live engine *(captured in `tasks/runtime-decision-flow-2026-04-12.md`; documents the actual order from enrichment through engine selection, scenario/ticker overlays, gates, sizing, and lifecycle bias, and notes that current live adaptation is driven more by execution-profile / regime overlays than by frequent `scenario_execution_policy` hits.)*
- [x] Publish one practical runtime debug playbook for tracing why a trade fired, how it was sized, and why it exited *(captured in `tasks/runtime-debug-playbook-2026-04-12.md`; provides a concrete operator sequence for reading autopsy artifacts and separating entry logic, management overlays, sizing drift, and lifecycle drift when diagnosing a single trade.)*
- [x] Patch `scripts/replay-focused.sh` to honor `keep_open_at_end=false` by calling replay close-out before finalizing, then rerun the July v1 equal-scope lane and re-check the `SMART_RUNNER_SUPPORT_BREAK_CLOUD` loser set *(verified in `focused-july-mainline-equalscope-agq-fixed-rerun-20260412--20260412-082312`: manifest and finalized run both record `keep_open_at_end=false`, Step 2b closed `2` open positions before Step 3 finalize, archive counts landed at `25` closed trades / `144` config rows, and the July loser set improved from `8` to `6` with `SMART_RUNNER_SUPPORT_BREAK_CLOUD` losses reduced from `4` to `3` vs deterministic parity `v12`.)*
- [x] Apply and verify the narrow `ON` post-trim roundtrip-management fix before widening back to the July equal-scope lane *(single-ticker proof `focused-focused-on-giveback-cluster-v10-20260412--20260412-091301` moved `ON-1752516600000` from Jul 24 `SMART_RUNNER_SUPPORT_BREAK_CLOUD` at `-$150.44` to Jul 23 `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE` at `-$21.98`; equal-scope verification `focused-july-mainline-equalscope-on-roundtrip-v1-20260412--20260412-091738` preserved `25` trades / no missing or extra trade IDs and lifted July closed PnL from `+$4,751.77` to `+$4,882.65`, with `ON` as the only material lifecycle change.)*
- [x] Apply and verify the narrow `RIOT` same-day fragile earnings-entry block on top of the accepted `ON` control *(focused proof `focused-focused-riot-earnings-day-block-v1-20260412--20260412-102425` removed the bad `RIOT-1753977600000` Jul 31 `HARD_LOSS_CAP` branch while still leaving a winning RIOT trade in the wider focused window, and the isolated post-earnings proof `focused-focused-riot-postearnings-window-v1-20260412--20260412-103009` confirmed the change blocks the earnings-day entry without inventing a replacement trade in `Jul 30 -> Aug 8`. Compared against the prior `ON`-fixed equal-scope control, `focused-july-mainline-equalscope-on-riot-v1-20260412--20260412-103307` removed `RIOT-1753977600000`, introduced one `FIX` portfolio-path substitution (`FIX-1754588400000` -> `FIX-1754057400000`), and lifted July closed PnL from `+$4,882.65` to `+$5,248.68`.)*
- [x] Freeze the accepted July equal-scope `ON` + `RIOT` challenger package before continuing toward the full backtest path *(captured in `tasks/july-challenger-on-riot-v1-2026-04-12.md`; active July challenger artifact `focused-july-mainline-equalscope-on-riot-v1-20260412--20260412-103307`, run `focused_replay_20260412-103307@2026-04-12T17:33:40.322Z`, same pinned equal-scope config and dataset as the prior controls, headline July delta `+$366.03` vs the accepted `ON`-only control, and remaining meaningful July cloud-break losers narrowed to `CDNS-1754326800000` and `GRNY-1753889400000`.)*
- [x] Freeze the accepted July equal-scope `ON` + `RIOT` + `GRNY` challenger package before continuing toward the full backtest path *(captured in `tasks/july-challenger-on-riot-grny-v1-2026-04-13.md`; active July challenger artifact `focused-july-mainline-equalscope-grny-first-trim-floor-v2b-20260413--20260413-071043`, run `focused_replay_20260413-071043@2026-04-13T14:11:28.162Z`, same pinned equal-scope config and dataset as the prior controls, headline July delta `+$49.86` vs the accepted `ON` + `RIOT` challenger, and remaining meaningful July cloud-break work now concentrated in `CDNS-1754326800000`.)*
- [x] Reconcile the live trace lane with the accepted July challenger artifact before attempting any new `CDNS` lifecycle fix *(resolved: the hand-built trace lane was not artifact-equivalent. Re-running the same July basket through the focused-run launcher with the frozen dataset manifest reproduced `CDNS-1754326800000` on the accepted control, and rerunning the rejected `CDNS` candidate through that same launcher proved the basket keeps the exact same `24` trade ids while improving `CDNS-1754326800000` from `-101.47` to `+32.75` via `SMART_RUNNER_TRIM_REASSESS_ROUNDTRIP_FAILURE`. The replay-shape mismatch, not hidden early basket drift, was the reason the earlier manual traces looked contradictory.)*
- [x] Freeze the accepted July equal-scope `ON` + `RIOT` + `GRNY` + `CDNS` challenger package before continuing toward the next July loss branch *(captured in `tasks/july-challenger-on-riot-grny-cdns-v1-2026-04-13.md`; active July challenger artifact `focused-artifact-repro-candidate-cdns-v1--20260413-134230`, run `focused_replay_20260413-134230@2026-04-13T20:43:23.007Z`, same pinned config and frozen dataset manifest as the prior accepted lane, identical `24` trade ids versus the prior challenger, and headline July delta `+$134.28` via the in-place `CDNS-1754326800000` improvement.)*
- [x] Publish one authoritative recovery and promotion plan that defines the baseline package, the ordered monthly recovery path, and the preservation requirements
- [x] Publish one explicit validation contract so every future replay/backtest lane launches from the same preflight gate
- [x] Publish one concise learnings digest that clarifies when a fix belongs in baseline, regime, profile, or reject
- [x] Reconstruct and freeze the exact July recovery package on `main`: savepoint `422b606...`, pinned config artifact, approved `GRNY` lifecycle overlay, and focused `INTU/JCI` runtime-fix learnings
- [x] Run July focused control first on the frozen package and inspect sentinel names `RIOT`, `GRNY`, `FIX`, `SOFI`, `CSCO`, `SWK`
- [ ] Run July broad equal-scope validation before claiming any candidate is promotable *(post-deploy rerun complete: `focused_replay_20260408-073613@2026-04-08T14:36:16.059Z` / `focused-july-mainline-equalscope-v3-postdeploy`; after deploying the current frozen worker package to both environments, the clean equal-scope lane improved again from `13` trades to `18`, and the isolated `XLY` Jul 1 probe no longer emitted the excluded `tt_weak_context_rank_inflation_guard`. That proves stale deployed-runtime drift was a real ingredient. The next `XLY` proofs then ruled out multiple candidate blocker families: the pinned config and a one-key variant with `deep_audit_pullback_selective_enabled=false` both still finished with `0` `XLY` trades, so the selective non-prime pullback rank gate is not the dominant missing-trade ingredient; after making `tt_pullback_not_deep_enough` configurable, the first depth-threshold proof had to be corrected because replay was not yet loading `deep_audit_pullback_min_bearish_count` from the pinned config, but after wiring that key into `REPLAY_DA_KEYS`, redeploying, and rerunning the exact same full-window proof with `deep_audit_pullback_min_bearish_count=1`, `XLY` still finished with `0` trades; and a final chart-guided continuation-trigger proof, scoped only to `XLY` using the user's 30m bullish/bearish windows and conservative rank/completion/phase limits, also still finished with `0` trades. Full-route `candle-replay` forensics across the five July golden `XLY` dates therefore still point to a real remaining blocker family led by `tt_pullback_not_deep_enough` (`146` hits before the threshold proof), then `tt_no_trigger` (`118`), `tt_pullback_non_prime_rank_selective` (`79`), and `tt_momentum_30m_5_12_unconfirmed` (`46`), but the latest proofs show that neither raw pullback depth nor simple continuation recognition alone is enough to reopen the branch. July still remains well below the archived focused-golden basket's `66` trades, so the next blocker is now true strategy/path sparsity under the intended July package, not invalid data-readiness or stale worker provenance. Current step: rerunning the same equal-scope July basket from the AGQ-fixed candidate using the seeded v7 config as the direct control.)*
- [ ] Counter the recurring July loss patterns from the `riot-rollback-v4` lane: stop large post-trim givebacks like `ON` and reduce shallow-trim weak-starter losses like `AGQ` / late `RIOT`, then rerun focused validation before another broad lane *(in progress: the RIOT Jul 7 runner was restored by re-tightening trimmed-stop movement back to `runner_protect`, and the AGQ Jul 14 refinement now has replay-side `overnight_gap` context wired plus a narrow AGQ-only weak-gap/weak-ORB pullback guard. Focused validation `agq-jul14-narrow-guard-v2-20260410` originally blocked Jul 14 while preserving the Jul 15 winner (`AGQ-1752599400000`), but the latest deterministic-focused rerun `focused-focused-entry-loss-cluster-v2-20260410--20260410-121017` showed the newer include-ticker weak-gap/weak-ORB guard was still too broad: it removed the bad `AGQ-1752510600000` loser and improved the cluster from `-$162.51` to `+$153.27`, yet it also displaced the Jul 15 AGQ winner and replaced it with a later AGQ win (`AGQ-1752677400000`). The current refinement pass tightens that guard again by requiring the open gap to remain unreclaimed (`!fullGapFilled`) so Jul 14 stays blocked without clipping the reclaimed Jul 15 branch. On the management side, the first narrow `ON` giveback attempt was a no-op (`focused-focused-on-giveback-cluster-v2/v3` both still produced `ON-1752516600000` at `-$146.50`, exit `SMART_RUNNER_SUPPORT_BREAK_CLOUD`), so the current pass moves the refinement into the smart-runner cloud-break defer path itself: `trim_then_reassess` volatile runners with a large prior winner now lose the safety-net defer once retention has already materially collapsed. Collateral sentinel probes restored `FIX-1751387400000` and `GRNY-1751387400000`, and the full equal-scope rerun `july-mainline-equalscope-agq-narrow-v9-20260410` recovered most of the blunt-v8 collateral names (`ETN`, `FIX`, `GRNY`, `IESC`, `RIOT`, `SGI`) while keeping the bad AGQ Jul 14 loser (`AGQ-1752510600000`) absent. v9 still finished below seeded v7 overall (`20` trades / `14W` / `6L` / `+$3,036.31` vs `25` / `17W` / `8L` / `+$3,474.10`), but it materially improved on the blunt v8 lane (`22` / `15W` / `7L` / `+$1,919.22`) and now looks like a viable narrow branch rather than a basket-wide regression. Follow-up status: the historical pre-AGQ worktree snapshot (`0799690...`) was deployed and a frozen equal-scope parity lane was attempted, but the rerun proved non-comparable because the older worker lacks newer replay support endpoints and repeatedly degraded day execution (`2025-07-02`, `2025-07-08`) into retry-driven `0`-score / `0`-trade days. The current worker deployment was restored afterward. Latest parity/loss follow-up: the deterministic parity lane (`v12`) proved the baseline loss basket matches seeded `v7` almost exactly, so the next focused validation step is to keep probing the weak-gap/weak-ORB pullback losers (`AGQ`, `IESC`, `GRNY`) and the post-trim giveback loser (`ON`) on top of the stable deterministic config until both fixes hold cleanly.)*
- [x] Trace why the `SWK` Jul 25 and `RIOT` Jul 23 earnings-adjacent losses still bypass the pre-earnings entry block in the Jul->Sep deterministic lane, then classify whether the gap is in market-event seeding, schedule inference, or block policy *(resolved: replay-side instrumentation and a fresh worker deploy showed the current code already sees the seeded earnings rows and enforces the gates. `RIOT` now blocks the bad `2025-07-30` pre-earnings entry via `pre_earnings_entry:2025-07-31:unknown`, while the `SWK` path now exits via `PRE_EVENT_RECOVERY_EXIT` near flat before earnings. The earlier failing artifacts were produced against a stale deployed worker/runtime rather than a newly identified policy bug.)*
- [ ] Investigate the `jul1_fingerprint` drift in the latest post-deploy July equal-scope lane and classify each miss as intentional path evolution vs regression *(in progress: post-deploy validation lane `focused-july-mainline-equalscope-trade-mgmt-v1-closeout-v3-20260409` closed cleanly with `34` trades / `26W` / `8L` / `+$3,797.50`, and the `FIX` Jul 1 plus `RIOT` Jul 7 proof trades were reconfirmed as wins, but `jul1_fingerprint_matched` still remained `0/4`; next step is to compare the contract targets (`CDNS`, `ORCL`, `CSX`, `ITT`) against the new early-window trades and blocker traces before treating the lane as promotable. Deterministic parity follow-up: the frozen July equal-scope basket rerun `july-mainline-equalscope-deterministic-parity-v12-20260410` using seeded `v7` config plus stripped overlays (`dynamic_engine_rules`, `reference_execution_map`, `scenario_execution_policy`, and adaptive gate packs blanked) finished with `25` trades / `17W` / `8L` / `+$3,602.04`. Versus seeded `v7`, parity tightened dramatically: the only remaining trade-ID mismatch was the same early `RIOT` substitution (`RIOT-1751902200000` missing, `RIOT-1751900400000` extra), and common-ID P&L drift collapsed to `+$0.05`. That strongly suggests the residual `v10` drift was primarily coming from those runtime/adaptive overlays rather than the AGQ revert path itself.)*
- [ ] Install `oxlint` at the repo root and enforce it from a git `pre-commit` hook without linting generated frontend bundles
- [ ] Publish an updated system architecture review and diagram that reflects the actual Pages worker, API worker, storage, realtime, and replay/backtest flows
- [ ] Carry only proven July refinements into August and repeat the same control workflow
- [ ] Widen month-by-month through Sep->Apr only if July and August stay trustworthy
- [ ] Run the full `Jul -> Apr` candidate only after the monthly path holds and the lane is still reproducible
- [ ] Promote only when the candidate clears the full blocker gate in `docs/promotion-checklist-v1.md`
- [ ] Preserve the promoted package as a named artifact bundle with manifest, pinned config, monthly diffs, sentinel diff artifact, promotion report, and archived run-scoped evidence

## Live Replay Autopsy Repair [2026-04-14]
- [ ] Trace why the active `Jul -> Sep` cumulative replay reports created trades but `Trade Autopsy` live mode still returns zero rows
- [ ] Patch the worker so live replay truth stays aligned between the replay runner, active-run read model, and `Trade Autopsy`
- [ ] Deploy the repaired worker to both default and production environments
- [ ] Re-run the `Jul -> Sep` cumulative lane on the repaired runtime and verify live trades appear during execution

## System Hardening Sprint [2026-04-05]
- [x] Redesign `System Intelligence -> Runs` into a remote backtest operations console with launch drawer, active-run console, logs, queue/history, and preserved archive/promotion workflows
- [x] Publish the canonical contract package for `MarketContext`, `TradeContext`, `EntryDecision`, `TradePlan`, `LifecycleDecision`, `RunManifest`, and `RunArtifact`, including a glossary that maps current runtime names to the canonical terms
- [x] Define one authoritative run-manifest contract and wire it into run registration/finalization so each validation lane freezes code revision, config snapshot, dataset window, engine selection, and replay mode
- [x] Isolate fresh replay/backtest state from stale live/archive state for clean validation lanes, and disable implicit rehydration unless explicitly requested
- [x] Make one route/payload authoritative for the active run so `System Intelligence`, `Trade Autopsy`, and Live Replay no longer disagree about what is currently running
- [x] Build the first sentinel validation basket (`RIOT`, `GRNY`, `FIX`, `SOFI`, `CSCO`, `SWK`) and require a generated diff artifact before promoting any candidate run
- [x] Extract a dedicated lifecycle seam from `worker/index.js` so trim/defend/trail/exit decisions flow through one primary engine path instead of split inline vs pipeline behavior
- [x] Unify ticker profile resolution so static behavior defaults, learned profile data, and regime/context overlays are resolved explicitly and attributed in trade lineage
- [x] Define a single regime vocabulary or explicit mapping layer shared by engine, CIO, calibration, autopsy, and investor flows
- [x] Record adaptive influence in trade lineage for regime overlays, profile overlays, CIO adjustments, and other runtime advisory layers
- [x] Define stable operator read models for active run status, run detail, live replay, and autopsy truth so admin surfaces consume explicit backend contracts instead of incidental worker state
- [x] Gate resumption of broad July/Aug recovery and month-by-month tuning on completion of the hardening sprint validation gates in `tasks/system-hardening-execution-plan-2026-04-05.md`

## Cloud Backtest Runner [2026-04-16]
- [x] Design and implement the first `BacktestRunner` Durable Object with durable single-flight state, lifecycle checkpoints, bounded logs, and replay-lock coordination.
- [x] Add admin endpoints for remote backtest start, cancel, status, and logs, reusing the current run registry/archive model instead of creating a parallel control plane.
- [x] Extract replay execution into shared internal steps so the coordinator can drive real backtests without routing through shell-owned HTTP choreography.
- [x] Move market-event seeding, clean-slate prep, artifact generation, and session-by-session replay execution into the cloud workflow so laptop scripts become optional thin clients.
- [x] Repoint the redesigned `Runs` console from the temporary validation runner to the cloud-runner API surface once the coordinator is live.
- [x] Remove the last route-shaped replay seam by letting `BacktestRunner` instantiate the candle replay executor directly instead of cloud-to-cloud fetching the admin route.
- [x] Deploy the cloud backtest runner worker update to both default and production environments, then smoke-test the live `/timed/admin/backtests/*` surface *(deployed on 2026-04-16 via `npm run deploy:worker`; both default and production worker deploys succeeded with `BACKTEST_RUNNER` bound, and smoke run `deploy_smoke_20260416_v1` completed end-to-end through `runner_complete`, archive snapshot, and replay-lock release.)*
- [x] Record the exact rollback target commit and any post-deploy smoke findings before widening to a larger coordinated lane *(rollback target for a code-only revert is committed baseline `ccaf231b4c1eaf18c18f2914b1df70f13eae55a1`; note that the deployed cloud-runner changes themselves are still an uncommitted dirty-tree revision, so a future re-roll-forward should be captured in git before relying on SHA-based recovery.)*
- [x] Run one trade-producing focused cloud validation lane on the deployed runner and verify archived trades, metrics, artifacts, and active-run read-model behavior end to end *(validated on 2026-04-16 with `deploy_validate_trades_20260416_v2`: active read models converged on the real run during execution (`runs/live` and `trade-autopsy/trades?live=1` surfaced `deploy_validate_trades_20260416_v2` with live trade counts), finalization archived `18` trades / `18` direction-accuracy rows / `144` config rows, and completed run detail persisted `18` trades with `9` wins / `9` losses and `$3349.40` realized PnL. Follow-up smoke `deploy_marker_cleanup_smoke_20260416_v1` confirmed the coordinator now clears both `timed:replay:lock` and `timed:replay:running`, so post-run `runs/live` returns to the intended `live_config_slot` baseline instead of a stale historical replay row.)*

## Backtest Skill Productization [2026-04-16]
- [x] Package the cloud-native backtest launch / monitor / validate / refine loop into a project skill with explicit-use instructions, concrete payload templates, and helper scripts for coordinated run scaffolding and monitoring.
- [x] Extend the project skill with a direct coordinated-run launch helper and concrete end-to-end examples so the workflow is executable without hand-written API calls.
- [x] Run an apples-to-apples cloud-vs-laptop backtest comparison on the same pinned lane, then summarize trade-count, PnL, archive truth, and orchestration drift differences *(2026-04-16 comparison used the same July/Aug focused 16-ticker lane, frozen dataset manifest, `5m` interval, clean-slate replay, closeout behavior, and the cloud run’s exact archived 144-key config snapshot. The coordinated cloud runner run `deploy_validate_trades_20260416_v2` completed cleanly with `18` archived trades, `9` wins / `9` losses, and `$3349.40` realized PnL. The legacy laptop-orchestrated leg `focused_replay_20260416-114723@2026-04-16T15:48:01.329Z` registered the same contract but immediately hit repeated `1101` failures on the route-based replay path starting on `2025-07-01`, produced `0` archived trades, and had to be interrupted and cleaned up manually. This confirms the remaining gap is orchestration-path reliability, not evidence that the cloud runner changed the trading result set.)*
- [x] Freeze `refinement-savepoint-reproduction-20260416-v4` as the new protected cloud baseline after the clean Jul->Oct reproduction *(protected in the run registry on 2026-04-16 with `69` trades, `42` wins / `26` losses / `1` flat, and `$8007.86` realized PnL; this outperformed the prior laptop savepoint `focused_replay_20260415-201911@2026-04-16T03:20:16.810Z` by `+4` trades and `+$1515.36` while using the same 16-ticker basket, frozen dataset, and 144-key config artifact.)*
- [ ] Investigate the September drag cluster on the new cloud baseline before widening to November *(month buckets are all positive through October, but September is the weakest composition month on `refinement-savepoint-reproduction-20260416-v4` with `22` trades, `9W / 12L / 1 flat`, `+$1169.94`; net ticker damage is led by `ABT` (`-$288.94` across two losses), then `ETN` (`-$214.24`), `HUBS` (`-$140.98`), `SWK` (`-$100.63`), and `CDNS` (`-$74.18`). The largest single September loser is `RIOT-1758738600000` at `-$478.26`, but the first narrow refinement target should prefer the repeatable `ABT` cluster over a one-off branch unless deeper evidence says otherwise.)*
- [ ] Launch the `Jul -> Nov` cloud continuation lane from `refinement-savepoint-reproduction-20260416-v4` after the September target is classified

## Jul/Aug Recovery Incident [2026-04-02]
- [x] Document the pinned Jul→Apr 2 full-backtest contract (frozen config, TD deferral included, replay semantics, monitoring checkpoints)
- [x] Launch the full Jul→Apr 2 recovery backtest from the pinned bundle and keep the run healthy through completion or controlled recovery
- [ ] Monitor the active full backtest for replay-lock issues, stale checkpoints, batch failures, and parity-break symptoms; intervene before the lane breaks down *(in progress: the prior `full-jul-apr-v6-current-worker-v2` lane is now confirmed aborted in the run registry; the `INTU/JCI` focused proof `focused-intu-jci-proof-v4-runtimefix--20260407-005334` is saved and green, and the next clean single authoritative Jul 1→Apr 3 trader-only relaunch on the pinned v6 config is being started from that runtime-fix savepoint)*
- [ ] Freeze the current Jul→Apr 2 run as Iteration 1 evidence: stop safely, snapshot live trades/ledger/run state, and preserve the exact early-July basket
- [ ] Diff Iteration 1 early-July trades against `focused-golden-julaug-focused-recovery-v1` and isolate the first high-confidence regression set (`CELH`, `INTU`, `CSX`, `SWK`, missing `RIOT` quality)
- [ ] Turn the Iteration 1 diff into the smallest next patch or config adjustment, then relaunch the next controlled recovery lane
- [ ] Test an anchor-only same-ticker repeat-entry guard that preserves the early `RIOT` July sequence while blocking late overtrade churn, then rerun the focused recovery lane and compare *(in progress: focused clean-lane replay is still allowing overlapping same-ticker entries (`GRNY`) that should be blocked by the replay/open-trade guard; tightening the replay path first so same-ticker behavior can be validated on trustworthy artifacts)*
- [x] Build a July trade-forensics scoreboard against the golden benchmark: trade count, win rate, avg pnl/trade, and named loser patterns; freeze the 2026-04-05 save point in `tasks/july-recovery-savepoint-2026-04-05.md` and begin the append-only iteration log in `tasks/july-recovery-iteration-log.md`
- [ ] Validate each named July loser against trade snapshots/autopsy evidence and map it to an avoid / defend / exit-earlier refinement bucket *(in progress: expanded this into a Jul-Dec forensic board using the authoritative `full-jul-apr-v6-intu-jci-runtimefix-v1` run plus the unstamped December live supplement, now layering in `direction_accuracy` MFE/MAE evidence to separate true bad entries from management givebacks)*
- [ ] Patch the smallest July-specific entry/management regressions first, then rerun July and compare against the golden benchmark before extending into August *(in progress: widened HTF-bull LTF-conflict reject + added divergence-aware bull-entry reject in `tt-core-entry`; deployed a mirrored short-side selective-rank guard that blocks the `HALO` Jul 1 speculative short replay on the pinned v6 config; the direct `INTU/JCI` runtime trace is now closed out and the proof lane is green: `INTU-1751388300000` is blocked, and `JCI-1751388300000` stays open instead of closing via `doa_early_exit` after replay management was fixed to carry canonical MFE state into `openPositionContext`)*
- [ ] Carry the proven July refinements forward into August and repeat the same monthly audit process before moving beyond August
- [ ] Expand divergence telemetry so both RSI divergence and phase divergence are computed and exposed for all supported timeframes
- [ ] Integrate all-timeframe divergence and ATR-horizon context into July/Aug entry and exit diagnostics before the next month-specific rerun
- [ ] Run focused loss forensics on the latest Jul→Apr candidate lane: big losses, immediate-MAE / DOA trades, and spurious entries
- [ ] Convert the forensics into a minimal entry-selectivity patch (rank / entry-quality / confirmation / correlation only where evidence is clear)
- [ ] Re-run the full Jul→Apr candidate after the selectivity patch and compare loss basket, trade count, and winner retention
- [ ] Stop all concurrent replay/backtest processes and verify only one clean recovery lane can run at a time
- [ ] Freeze the exact "working 1.5 days ago" recovery anchor: deployed worker version, local code diff, config snapshot, and artifact bundle
- [ ] Reconstruct the canonical July recovery candidate package from the 2026-04-05 savepoint artifact plus the later `GRNY` lifecycle refinements before launching any new validation lane *(in progress: candidate package documented in `tasks/july-recovery-candidate-package-2026-04-06.md`; now reconciling that package back onto `main` without relying on side worktrees)*
- [ ] Reconcile `main` into one authoritative trunk by classifying post-savepoint changes into `keep` (hardening/refactor-safe), `validate` (trading-behavior-sensitive), and `ignore/archive` before any new July rerun *(in progress: building a mainline reconciliation plan and merge matrix from `422b606` savepoint -> current `main`)* 
- [x] Map the promising focused-fix ladder (`focused-golden-julaug-focused-recovery-v1`, `path1-first5`, `RIOT/GRNY flat-fix`, `RGI lifecycle`) to concrete code surfaces vs config-only drift
- [x] Choose the nearest current resume bundle for the next backtest: already-on-`main` behavior vs artifact-only lessons that still need to be re-applied
- [ ] Build a deterministic replay harness that disables stale archive/KV trade rehydration for fresh runs and records the active replay inputs *(in progress: investigating remaining focused-replay contamination where non-window / non-sentinel trades are still being stamped into clean-lane runs despite pre-run reset and fresh-run registration)*
- [ ] Disable reference-execution replay assists for fresh validation lanes so TT-core loser blocks (for example `WMT`) are validated without seeded trade resurrection
- [ ] Audit parity-critical live/replay inputs against the Jul/Aug lane: market_events, divergence/exhaustion state, HTF candle coverage, and engine routing
- [ ] Re-run a single clean Jul/Aug validation lane from the frozen anchor and produce a missing/spurious trade diff against the golden evidence *(in progress: v6 `july-mainline-reanchor-v6-snappeakfix` is now frozen as the current best post-snapshot July checkpoint; basket trade rows matched v5 while snapshot persistence/read-model behavior was repaired and separately verified on the `RIOT` `TP_FULL` path)*
- [ ] Run a RIOT-only forensic diff across the golden Jul/Aug artifact, the Apr 5 anchor repeat-guard replay, and the latest focused validation lane; turn the first high-confidence RIOT loser pattern into the smallest entry/lifecycle patch
- [ ] Run a pushed-checkpoint Jul/Aug regression lane in interval-first mode and confirm `WMT` stays absent in the actual validation lane
- [ ] If Jul/Aug regression holds, continue the same checkpointed lane into September and audit only newly introduced regressions before broadening further
- [ ] Build a UI-driven validation console so monthly replays/backtests can be launched, monitored, compared, and retried without shell scripts
- [ ] Harden replay/backtest orchestration so config-pinned validation no longer depends on fragile global reset / stale lock / shell wrapper behavior *(in progress: fixing stale `timed:replay:running` / live-autopsy fallback behavior so completed runs do not masquerade as active replay state)*
- [ ] Replace the current July regression launcher with a deterministic backend validation-run flow and verify the golden-entry-restored config boots cleanly
- [ ] Relaunch the full July validation lane on the deployed deterministic runner and keep only one authoritative active run in the registry
- [ ] Patch only the highest-confidence regression points and repeat until the golden basket/timestamps materially recover

## Replay Accounting + Iter-5 Reset [2026-03-25]
- [ ] Patch live `tt_core` management dispatch so inline lifecycle exits (`PHASE_LEAVE_*`, `PROFIT_GIVEBACK`, `RUNNER_STALE_FORCE_CLOSE`) can fire again, then validate on a focused live replay lane
- [ ] Reconstruct the exact historical iter-5 baseline config/sizing state before further refinement comparisons
- [ ] Pin focused replay/backtest runs to the recovered iter-5 config snapshot instead of live `model_config`
- [ ] Fix `/timed/admin/runs/finalize` archived-count reporting so completed focused runs show total archived trades/config consistently
- [ ] Restore July 2025 local higher-timeframe coverage (at minimum `30m` for `FIX`/`RBLX`) or build a replay dataset that can reproduce those TFs without stale carry-forward
- [ ] Restore stronger `30m` reference-TF entry confirmation, not just higher-TF alignment fallback
- [ ] Reintroduce multi-TF peak-exhaustion checks using PDZ, TD exhaustion, RSI overheating, phase, and ATR expansion context *(in progress: dedicated July A/B proof is now complete (`july-peak-ab-control-off` vs `july-peak-ab-variant-on`) and the runs were identical: `8` trade rows, `6` closed, about `$1,174.99` closed PnL, no `PEAK REACTION` log hits, and no closed-trade giveback deltas versus `v5`; next pass should instrument trigger eligibility or retune the lock thresholds before treating peak-reaction ratcheting as a validated improvement)*
- [ ] Re-anchor management to `30m` + `1h` structure so winners can ride trend without low-TF churn
- [ ] Build a shared move-phase profile from ATR displacement, phase, PDZ, TD, and Elliott Wave context
- [ ] Gate late-stage momentum/reclaim entries with replay-visible move-phase diagnostics before changing loss controls
- [ ] Trace live-vs-golden state/bias construction drift for `IREN` and `GDX` before `tt_bias_not_aligned` fires
- [ ] Relax parity-breaking `PANW`/`AYI` `tt_core` entry blockers (`tt_pullback_not_deep_enough`, `tt_momentum_30m_5_12_unconfirmed`, `tt_reference_30m_not_participating`, `tt_entry_support_weak`) using focused live replay evidence
- [x] Instrument `tt_core` replay decisions for surviving `FIX`/`RBLX` July entries so runtime trigger/reject state can be compared directly against autopsy artifacts
- [ ] Fix focused replay config archival so pinned config-file runs persist all config keys, not just top-level wrapper rows
- [ ] Forensically compare `FIX`, `CELH`, and `RBLX` July losers against surviving winners to isolate blockable peak/fakeout signatures
- [ ] Sweep July/Aug earnings-adjacent losers (opened within one trading day of earnings), verify the new pre-earnings entry block covers them, and isolate any remaining pre-event gaps requiring a second refinement *(in progress: strict clean-lane proofs are now green for `RIOT`, `MSFT` same-day, `CAT`, `ANET`, `NVDA`, `CSCO`, and `PWR/AMZN/FSLR`; remaining follow-up is optional cleanup only, such as tightening reporting around Step 1.25 seed counts or extending the same robustness to any other event sources if new mismatches appear)* 
- [ ] Sweep July/Aug macro-event-adjacent losers (CPI/PPI/FOMC/PCE/NFP windows), verify current pre-macro de-risk logic is sufficient, and isolate any cases that warrant an entry-time macro block similar to earnings *(in progress: clean canaries are green for `NKE` on FOMC day, `UNP` before CPI, and `WMT` before PPI; the one canary that still opened (`RIOT` over Jul 14-15 PPI) entered after the release, so there is not yet evidence for a missing pre-event macro block)* 
- [ ] Audit divergence detection and determine whether bearish/bullish divergence signals are missing, stale, or not being consumed in `tt_core`
- [x] Compare the full run against `iter5-validation-recovered-20260325` and isolate the highest-confidence trade-quality deltas
- [x] Apply only data-supported refinements on top of `configs/iter5-runtime-recovered-20260325.json`
- [x] Run a clean pinned July iter-5 focused validation and compare directly to the recovered baseline target
- [ ] Decide whether to promote `focused-iter5-full-baseline-current-guard--20260325-105601` as the new protected July baseline / live reference lane
- [x] Trace why mixed focused replays downgrade preserved `RBLX` winners from `Confirmed/0.01` to `Speculative/0.005` while isolated `RBLX` replays keep full sizing
- [x] Fix multi-day focused replay regression so created trades persist through completion and archive correctly
- [x] Trace why focused replay reports created trades but archives only a subset under the replay run_id
- [x] Fix the replay/run_id accounting path so focused replay artifacts and archive counts match
- [x] Re-run a minimal focused replay probe and verify created-trade events and archived run-scoped trade counts are both surfaced correctly
- [x] Restore the refinement code path to the iter-5 baseline before attempting a new challenger
- [ ] Use repaired replay accounting to identify the next data-validated refinement candidate from iter-5 (July slice rerun in progress)

## Paragon Run Audit + Relaunch [2026-03-22]
- [x] Forensic audit: identify exact JUL→AUG archived run with full per-trade annotations/classifications and verify annotation count mismatch root cause
- [x] Cross-run comparison: include both `15m-calibration-only-jul1-mar4` runs and rank best engine/path/regime combos by win quality (high MFE, low MAE, trend hold)
- [x] Produce "Paragon" model_config + dynamic engine profile from archived evidence (run-scoped, replay-safe)
- [ ] Launch clean full backtest with paragon config and monitor to stable progression/completion
- [ ] Write summary + operator notes to `tasks/lessons.md` and `CONTEXT.md` if new pitfalls are discovered

## Reference-Trade Intelligence Roadmap Execution [2026-03-22]
- [x] Phase 0: Publish contracts (`reference-intel`, scoring rubric, gates, parity, proof, context-intel)
- [x] Phase 1: Implement canonical full-history dataset builder (`scripts/reference-intel-build.py`)
- [x] Phase 1: Generate initial artifacts (`trade-intel-canonical-v1.jsonl`, summary, lineage-quality audit)
- [x] Phase 2: Implement hybrid reference trade selector and first ranked output
- [x] Phase 3: Generate first coverage map + scenario gap report
- [x] Phase 3b: Build context-intel snapshot v1 (ticker profile + Daily Brief + SPY/QQQ hyper state)
- [x] Phase 4: Build journey blueprint extraction clusters from selected references
- [x] Phase 5: Generate first versioned dynamic policy artifact from blueprint clusters
- [x] Phase 6: Run first strict gate evaluation artifact (`data/reference-intel/validation-gates-v1.json`)
- [x] Phase 7: Publish first promotion-readiness report (`data/reference-intel/promotion-report-v1.md`)
- [x] Phase 8: Seed drift monitoring artifact (`data/reference-intel/drift-monitor-v1.json`)
- [x] Phase 5b: Build CIO feature pack + eval loop artifacts (`cio-memory-features-v1.json`, `cio-eval-loop-v1.json`) and integration doc
- [x] Phase 5c: Wire feature-flagged CIO reference priors into live/replay CIO memory cache (`ai_cio_reference_enabled`)
- [x] Add hard go/no-go promotion checklist (`docs/promotion-checklist-v1.md`)
- [x] Phase 7b: Run first control-vs-candidate behavioral validation matrix (`validation-matrix-v1.json`, `validation-go-no-go-v1.json`, `cio-validation-v1.json`)
- [x] Phase 10: Implement refresh automation loop (`scripts/reference-intel-refresh.py`) with drift + CIO drift + revalidation trigger artifact
- [x] Phase 10: Add CIO drift monitor (`scripts/cio-drift-monitor.py`) and generate `data/reference-intel/cio-drift-monitor-v1.json`
- [x] Phase 10: Run first automated refresh cycle with trigger output (`data/reference-intel/revalidation-trigger-v1.json`)

## Reference Execution Mapping + Drift Guard [2026-03-23]
- [x] Build cross-run coverage artifact by ticker/date-range with entry/exit engine + model_config lineage
- [x] Generate runtime reference execution map (ticker+date-range primary, date-bucket fallback)
- [x] Wire runtime map into engine resolution for replay/live scoring
- [x] Capture reference parity drift during backtests (expected-vs-actual reference entries)
- [x] Expose drift summary artifact and run-level diagnostics for operator review

## Scenario Policy V1 (Context + Volatility + Setup) [2026-03-23]
- [x] Build scenario policy artifact from reference trades (`ticker + setup + regime + vol + context`)
- [x] Apply policy to `model_config` as runtime memory (`scenario_execution_policy`)
- [x] Wire runtime scenario resolution during in-review and persist on trade lineage
- [x] Apply scenario-guided SL/TP multipliers and management style (`tp_full_bias` vs `smart_exit_bias`)
- [x] Add replay diagnostics for scenario-policy match/miss and blocker reasons

## Scenario Coverage Expansion V2 [2026-03-23]
- [x] Expand reference selection breadth (higher per-ticker/per-sector caps) and regenerate map/policy artifacts
- [x] Promote expanded reference execution map + scenario policy to `model_config`
- [x] Run policy fit/generalization hit-rate report and identify weak tickers dominated by global fallback

## Locked Validation Backtest + Runtime Verification [2026-03-23]
- [x] Clear stale replay/backtest state and archive current run snapshot
- [x] Launch new locked validation backtest on expanded map/policy
- [x] Monitor progression and collect runtime diagnostics during run
- [x] Verify signal snapshot completeness and execution field integrity from API payloads
- [x] Verify dynamic scenario/reference policy selection appears in entry diagnostics and lineage

## Locked Validation Closeout + Weak-Reference Expansion [2026-03-23]
- [x] Finalize current locked-validation-v2 run and persist immutable archive metrics/config snapshot
- [x] Generate weak-reference gap artifact (fallback-heavy tickers/scenarios + quality deltas)
- [x] Propose targeted reference map + scenario policy additions for weak buckets

## Lineage Attribution Hardening (Execution + Scenario) [2026-03-23]
- [x] Persist explicit lineage attribution fields (`selected_engine`, `selected_management_engine`, `engine_source`, `scenario_policy_source`)
- [x] Deploy worker and run focused replay probe to create fresh attributed trades
- [x] Rebuild weak-reference report from attributed run data and verify non-unknown source distribution

## Targeted Promotion Cycle (Weak-Reference Uplift) [2026-03-23]
- [x] Apply targeted reference/scenario upgrades for `B`, `CSCO`, `CVNA`
- [x] Run short focused validation replay and archive results
- [x] Compare before/after attribution + weak-rate metrics and decide full-run promotion

## Drift v2 Semantic Parity (Reference Intelligence Hardening) [2026-03-23]
- [x] Extend reference map artifacts to persist per-trade execution intent (`entry_path`, `engine_source`, `scenario_policy_source`)
- [x] Add and persist `criteria_fingerprint` for each exact reference entry and ticker window cluster
- [x] Upgrade replay drift checks to validate semantic parity (not just timestamp match) and emit mismatch reasons
- [x] Validate on CSX/CDNS/ITT behavioral references and publish a drift v2 evidence artifact

## Drift v2b Semantic Tolerance Profile [2026-03-23]
- [x] Add map-level semantic tolerance profile (execution vs drift modes, field-level compare scope)
- [x] Wire runtime reference resolution to use configurable mismatch budget (instead of hardcoded semantics)
- [x] Wire drift reporting to use strict/diagnostic mode from profile
- [x] Regenerate/apply map + deploy worker + validate with focused interval replay

## Option-A Parity Spec [2026-03-22]
- [x] Build a deterministic parity spec for `option-a-rank-overhaul` using entry-time signal snapshots from artifact trades
- [x] Compare historical tag `95417ae` engine/runtime behavior vs current worker code for Jul 1 entry divergence
- [x] Write operator-ready replication contract (constraints + required gates/config + known non-repro causes)
- [x] Add scripted interval replay diagnostic for target Jul 1 tickers and capture runtime gate/debug traces

## Journey Parity Comparator [2026-03-22]
- [x] Add a script that compares full trade journey parity (entry window, hold duration, exit class, and pnl quality) against the screenshot reference trade set
- [x] Run comparator once and persist a baseline report artifact for mission-control gating

## CSX Forensic Iteration-1 [2026-03-22]
- [x] Build ticker/date-window forensic evidence for CSX (reference trade vs overlapping runs)
- [x] Test a feature-flagged momentum-precedence entry iteration in legacy engine
- [x] Validate iteration in interval replay and capture pass/fail against CSX parity target
- [x] Add entry-time diagnostics and complete Iteration-2 CSX entry-path parity adjustment

## CSX Forensic Iteration-3 (Runner/Exit Path) [2026-03-22]
- [x] Isolate exit-path divergence (BREAKEVEN_STOP after trim causing lifecycle fragmentation)
- [x] Add replay-safe management guard to skip breakeven stop for trimmed runners in parity lane
- [ ] Validate runner-completion parity against reference (`TP_FULL`-like completion timing)
- [ ] Audit TP tier construction for reference-vs-current mismatch (trim threshold and runner target spacing)

## CSX Parity Stabilization — Mode Lock + Diff Trace [2026-03-22]
- [x] Step 1: Lock canonical full-run parity mode in backtest orchestration (interval-first path)
- [x] Step 2: Add focused candle-vs-interval CSX trace artifact around Jul 1 with interval-level trade mutation evidence
- [x] Step 3: Patch only the identified mutation point and re-validate focused CSX window behavior

## TT Tune V2 [2026-03-04]
- [x] Add `TT_TUNE_V2` feature flag plumbing and keep legacy-safe fallback
- [x] Relax TT entry gating (bias + trigger) in strong daily regime
- [x] Tune TT exits to reduce early exits (debounce + defend-before-exit)
- [x] Deploy and run quick validation replay sample

## Next Sprint (Prioritized) [2026-03-06]
- [x] Calibrate from autopsy tags: loosen exits (should_have_held=8) — done
- [x] Trade Autopsy mobile layout: fix classification buttons visibility/overlap
- [x] Review Variant Config modal (rule deltas before launch)
- [x] Historical import: strong July artifacts as named runs
- [x] Experiment infra: 15m vs 10m `leading_ltf` support, rerun, and archive retention
- [ ] Review 15m vs 10m `leading_ltf` results and decide promote/reject
- [ ] Calibrate: keep anti-chase gates (chasing=4)
- [ ] Variant v2 hardening: mitigate bad exits and chasing from classified trades
- [ ] Mean reversion TD9: implement primitives per docs/MEAN_REVERSION_TD9_ALIGNMENT_PLAN.md

## Launch Calibration Build [2026-03-11]
- [x] Define the Active Trader and Investor prediction product contract from the current splash-page promise
- [ ] Refactor calibration storage/reporting to be run-scoped and block partial-run apply to shared `model_config`
- [x] Add a diagnostic-only calibration/report path for the active run
- [ ] Add Carter-style market internals to regime evidence: VIX bands, risk barometers (`AUDJPY`/`USDJPY` when available), sector offense/defense rotation, and TICK support when data exists
- [ ] Promote squeeze/compression from a local setup flag into a first-class regime/timing input with multi-timeframe evidence
- [x] Formalize regime-orchestration inputs and profile selection hooks
- [x] Persist ticker-character and market-context evidence with run/trade lineage
- [ ] Keep Carter/profile overlays diagnostic-only until a fresh post-deploy replay proves they improve the protected baseline
- [ ] Re-anchor the next trader replay on `15m-best-foot-forward-jul1-mar4` plus the recent Ripster trade-management patches
- [ ] Reconcile Fundstrat deck tickers/sectors into `SECTOR_MAP` and queue new universe additions through `watchlist/add`
- [ ] Audit user-facing prediction surfaces so they can show reasoning, levels, regime, and management proof cleanly

## Run-Scoped Trade Retention [2026-03-07]
- [x] Preserve completed backtest trades per `run_id` even after replay reset clears live tables
- [x] Archive Trade Autopsy rows by run so historical run analysis remains available
- [x] Re-snapshot the current `15m-leading-ltf-rerun` trades into the new per-run store
- [x] Add archive-backed ledger lookup for historical `run_id` analysis
- [x] Import saved July artifacts into the run archive store
- [x] Fix Trade Autopsy run picker to default to the latest completed archived run and compare the newest 15m rerun vs the March 7 reference

## Ticker Profile V2 [2026-03-08]
- [x] Unify ticker profile output into a canonical merged contract (legacy profile + learning_json + context stats)
- [x] Add context-aware ticker profile diagnostics segmented by VIX/regime/side/path
- [x] Persist durable market and sector context history for future ticker/regime joins
- [x] Add a first regime-profile mapping endpoint using completed runs and existing regime infrastructure
- [x] Group surviving useful runs into candidate market profiles using dynamic VIX and regime signals
- [x] Define the smaller next-cycle backtest matrix from the regime/profile learnings
- [x] Define the runtime `profile evidence` contract for future adaptive overrides
- [x] Define the first named regime-linked profiles: `trend_riding`, `correction_transition`, `choppy_selective`
- [x] Wire the named execution-profile selector into live scoring so regime + internals + ticker character can pick the active profile at runtime
- [x] Persist execution-profile lineage into `direction_accuracy` and calibration autopsy rows for downstream replay/calibration traceability
- [x] Surface stored market/sector context history in System Intelligence
- [x] Surface richer ticker profiles and regime-profile mapping in System Intelligence
- [x] Surface canonical ticker context evidence inside Trade Autopsy
- [ ] Validate with lint and API/UI smoke checks

## Custom Ticker Add Flow Hardening [2026-03-08]
- [x] Persist worker-side ticker context from shared enrichment sources
- [x] Add background onboarding progress for custom ticker adds
- [x] Add Analysis-page processing modal and subtle post-add loading state
- [x] Deploy worker + Pages changes
- [x] Browser-test custom ticker add flow end to end in production

## Performance Enhancements [2026-03-08]
- [x] Analysis page: reuse cached snapshot across same-tab page navigations and revalidate in background
- [ ] Fix stale market-pulse futures/index updates (`ES1!`, `NQ1!`, `SI1!`) when heartbeat data lags
- [ ] Analysis page: split `/timed/all` into slim first-paint payload + deferred hydration
- [ ] Analysis page: precompute/cache rank + kanban snapshot server-side
- [ ] Tickers page: stop using full `/timed/all` sweep for context on first load
- [ ] Tickers page: add narrow context payload or include context in `ingestion-status`
- [ ] Tickers page: precompute/cache expensive ingestion-status summary

## Tickers Candle Gap Audit [2026-03-08]
- [x] Run production D1 completeness audit for `ticker_candles`
- [x] Compare audit output vs `/timed/admin/ingestion-status` gap reporting
- [x] Determine whether gaps are real missing data or a reporting/calculation issue
- [x] Summarize impact on backtests and define corrective action

## Replay Dataset Freeze [2026-03-10]
- [ ] Add a dedicated script to build and freeze a canonical replay-ready dataset window
- [ ] Add `full-backtest.sh` support for using a frozen dataset manifest and skipping Step 1.5
- [ ] Verify the July 2025 frozen dataset workflow and document the operator commands

## TradingView 15m Export Import [2026-03-08]
- [ ] Verify new `TV Exports` 15m CSV files and import path
- [ ] Update CSV auto-detection for new futures/index export prefixes
- [ ] Import the new TradingView `15m` CSV exports
- [ ] Verify `15m` candle coverage for the imported symbols

## Trail Coverage Repair [2026-03-08]
- [ ] Confirm the current `trail_5m_facts` repair path and narrow it to only missing coverage windows/tickers
- [ ] Backfill missing trail history for the recoverable ticker/date ranges
- [ ] Rebuild / flush `trail_5m_facts` from repaired trail history
- [ ] Re-run missed-move diagnosis and verify `NO_TRAIL_DATA` drops materially
- [ ] Pause the resumed 15m backtest before running trail repair so replay state does not collide
- [ ] Resume the 15m backtest after trail repair completes

## Sparkline Hardening [2026-03-08]
- [ ] Harden `/timed/all` so missing card sparklines are backfilled symbol-by-symbol instead of only when most are absent
- [ ] Preserve prior card sparklines in the Analysis UI when a refresh returns partial ticker payloads
- [ ] Validate the Analysis cards keep sparklines across refresh/poll cycles

## Variant v2 Hardening [2026-03-04]
- [ ] Mitigate bad exits and upstream/chasing entries from classified variant trades
- [x] Fix Trade Autopsy mobile layout overlap (classification buttons visibility)
- [ ] Fix Evening Daily Brief ES close-source mismatch bug
- [ ] Improve Home initial-load latency on first render
- [ ] Validate with lint + quick replay/UI smoke checks

## UI Polish Pass [2026-03-10]
- [ ] Rework homepage top rows so Upcoming Events has its own row and movers wrap cleanly
- [ ] Keep Trade Autopsy mobile footer actions visible above safe-area cutoff
- [ ] Confirm right rail Journey and Technicals ordering/copy changes in production
- [ ] Push only Pages/UI commits after isolating accidental non-UI git changes

## Run Integrity Repair [2026-03-11]
- [x] Trace historical run import path for run -> trades -> classifications linkage
- [ ] Restore/import per-trade autopsy annotations for imported protected/reference runs when artifact data exists
- [x] Make Trade Autopsy-from-Runs load run-scoped classifications instead of only relying on summary metrics
- [ ] Define/archive run lifecycle semantics so calibration only uses runs with linked trade outcomes + annotations
- [ ] Verify protected baseline run opens in Trade Autopsy with its saved classifications

## Replay Follow-ups [2026-03-04]
- [ ] Harden 10m entry gates (strict EMA21 + ST direction)
- [ ] Fix trimmed-trade P&L consistency in replay/autopsy path
- [ ] Re-run focused replay and verify WMT/H outcomes

## WMT Loss Guard Focused Replay [2026-03-05]
- [x] Add TT momentum anti-chase RSI heat gate (30m/1H)
- [x] Add Daily ST conflict gate for TT momentum LONG entries
- [ ] Run focused replay (Jul 1-3) and verify WMT blocked while CSX still passes

## July Variant Guardrails V3 [2026-03-06]
- [x] Exclude replay_forced_eod_close trades and analyze loser clusters
- [x] Implement feature-flagged variant guardrails (entry + early-defend)
- [x] Enable variant and run July backtest
- [x] Compare control vs variant and summarize win-rate/PnL impact

## RSI Extreme Guard (Good-Trade Referenced) [2026-03-05]
- [x] Analyze classified good trades vs bad trades for multi-timeframe RSI extremes
- [x] Add feature-flagged all-timeframe RSI extreme guard with data-driven exception path
- [x] Emit explicit autopsy reason codes for new guard decisions
- [ ] Run focused replay and compare blocked/kept trades vs current baseline

## Backtest Cost Controls [2026-03-05]
- [x] Add low-write replay mode to skip timed_trail writes during backtests
- [x] Add `--low-write` flag to full-backtest orchestration and skip lifecycle in that mode

## Squeeze Hold Guard [2026-03-05]
- [ ] Add management-only squeeze/compression hold guard to reduce premature exits during consolidation
- [ ] Run July replay with keep-open-at-end and compare win-rate + exit-reason mix

## Overnight Auto-Tune + Re-Backtest [2026-03-06]
- [x] Analyze completed July run (loss reasons, trim-giveback, chase blocks, open-position mix)
- [x] Apply targeted calibration/logic adjustments for highest-impact failure modes
- [x] Deploy updated worker logic
- [x] Run fresh full backtest with latest patches and collect final metrics
- [x] Summarize before/after deltas and recommended default settings

## Swing Checklist A/B [2026-03-06]
- [x] Add feature-flagged swing checklist gate (4H EMA stack + daily EMA5 + phase reset near zero + optional squeeze build)
- [ ] Run control replay with swing checklist disabled
- [ ] Run variant replay with swing checklist enabled
- [ ] Compare win rate, realized PnL, loss reasons, and open-trade mix

## Run Registry + Live Baseline [2026-03-06]
- [x] Add D1 run registry tables and metrics persistence (`backtest_runs`, `backtest_run_metrics`)
- [x] Add run endpoints (`register`, `finalize`, `mark-live`, `live`, `list`) and summary view payload
- [x] Add full-backtest orchestration hooks for register/finalize lifecycle
- [x] Fix JSON body parsing in run endpoints (readBodyAsJSON compatibility)
- [x] Validate on fresh control+variant runs and choose baseline `run_id` — Phase 3 promoted to live

## Run Tracking UI + Promotion [2026-03-06]
- [x] Add System Intelligence Runs tab (live run + historical summaries)
- [x] Add Promote Live action wired to `/timed/admin/runs/mark-live`
- [x] Deploy worker + Pages and verify run tracking/promotion flow

## Mean Reversion: TD9 Alignment Setup [2026-03-06]
- [ ] Add primitives: countRecentGapsDown, td9AlignedLong (D+W+60), phaseLeavingDotBullish, isNearPsychLevel
- [ ] Add mean_revert_td9_aligned flag and wire to entry path (feature-flagged)
- [ ] Validate on INTU-style setups (gap-down → TD9 alignment → support confluence → RSI extremes)
- **Plan:** `docs/MEAN_REVERSION_TD9_ALIGNMENT_PLAN.md`

## Experiment Workflow Phases [2026-03-06]
- [x] Phase 1: Convert trail facts to rolling baseline + active experiment storage
- [x] Phase 1: Add Delete Run cleanup semantics for non-protected experiment runs
- [x] Phase 2: Preserve the two July candidates as protected baseline save points
- [x] Phase 3: Re-run and validate official July baseline — completed; promoted to live (71.43% WR, +$2,481)
- [x] Phase 4: Add immutable rule snapshot storage and run detail APIs
- [x] Phase 5: Historical run import + run-scoped trade retention
- [x] Phase 6: Expand Runs UI with protected/archive/delete controls
- [x] Phase 7: Add Create Variant / Review Variant Config flow (Config vs Live deltas)

## 22 Losing Trades Fixes [2026-02-27] ✅
- [x] 1. Stop replay (released lock)
- [x] 2. Apply entry guards: 21 EMA on 10m (LONG: price above, SHORT: price below)
- [x] 3. CAT fix: replay entry price now uses 10m candle close (not "freshest" across TFs)
- [x] 4. Re-run replay for GE, CAT, BABA (July 1, 2025): 0 trades created (guards blocked bad entries)

## Admin Add/Remove/Update Tickers [2026-02-26] ✅
- [x] Fix SL/TP display: hide Kijun when >50% from price
- [x] Backfill reliability: run onboard after Fill Gaps; admin/onboard via requireKeyOrAdmin
- [x] Member ticker save: unsaved indicator, 401 feedback, Save disabled when no changes
- [x] Add-ticker UX: Fill → Score flow, Score button, clearer success message

## Polish Phase [2026-02-26]
- [x] Fix placeholder XXXX in simulation-dashboard (blurred teaser)
- [x] Standardize empty states (contextual messages kept)
- [ ] Consolidate ScoreBar/MarketHealthBar if beneficial
- [ ] Card/spacing consistency pass
- [ ] Verify getDailyChange usage everywhere

## Backtest Exit Management Fix [2026-03-18]
- [x] Diagnose root cause: 65 TP_HIT_TRIM trades at 66% trimmed shielded indefinitely by pullback support with no time limit
- [x] Add `RUNNER_STALE_FORCE_CLOSE` fuse exit for trimmed trades (120 market-hours default, configurable)
- [x] Add time-decaying ATR buffer to `evaluateRunnerExit` pullback shield (full→0 over 48h)
- [x] Add time-decaying ATR buffer to EXIT lane `_exitPullbackShield` (matches Smart Runner)
- [x] Add continuous `runnerPeakPrice` tracking so drawdown circuit breaker works on actual peak
- [x] Add exit reason map entries for `RUNNER_STALE_FORCE_CLOSE`
- [x] Deploy worker and verify in production (deployed 2026-03-18, commit 185550d)
- [ ] Re-run backtest with all improvements and confirm all trades properly managed

## Phase 4: ORB Detector + Scoring Integration [2026-03-18] ✅
- [x] 4.1: Analyze existing breakout detectors + candle data structure
- [x] 4.2: Build `computeORB()` for multiple TFs (5m, 15m, 30m, 60m opening ranges) in `indicators.js`
- [x] 4.3: Integrate ORB levels into scoring pipeline — rank boost for confirmed breakouts, penalty for fakeouts
- [x] 4.4: Wire ORB into entry gates (DA-14 fakeout gate, `__orb_confirmed` confirmation), exit logic (SL anchor at ORL/ORH), and rank boost
- [x] 4.5: Add ORB data to signal snapshot lineage (`buildTradeLineageSnapshot`)
- [x] Pass intraday bars (10m/15m) into replay `rawBars` so ORB works during backtests
- [x] Pass `asOfTs = intervalTs` in replay for correct session-relative ORB computation

## Phase 5: AI CIO Agent-in-the-Loop [2026-03-18] ✅
- [x] 5.1: Map trade entry flow — injection point identified at post-sizing, pre-trade-creation
- [x] 5.2: Build AI CIO evaluation prompt + OpenAI call with 8s timeout/fallback
- [x] 5.3: Wire AI CIO into trade entry pipeline (live only — skipped during replay for cost/perf)
- [x] 5.4: Persist AI CIO decisions in D1 `ai_cio_decisions` table with trade outcome backfill
- [x] 5.5: Add configurable toggle (`ai_cio_enabled` in model_config) + Discord notifications
- [x] Admin API: `GET /timed/admin/ai-cio/decisions` and `GET /timed/admin/ai-cio/accuracy`
- [x] CIO data attached to trade object (`trade.aiCIO`) and Discord entry embed
- [x] REJECT: blocks trade, persists for accuracy tracking, sends Discord alert
- [x] ADJUST: modifies SL/TP/position size with sanity checks (SL correct side, TP correct side, size 0.25x-1.5x)
- [x] APPROVE (incl. fallback): proceeds with model's original intent

## Phase 5b: AI CIO Memory Service [2026-03-18] ✅
- [x] New D1 tables: `daily_market_snapshots` (structured macro signals per date) + `market_events` (individual CPI/FOMC/NFP/earnings results)
- [x] `persistDailyMarketSnapshot()` + `persistMarketEvents()` called from `generateDailyBrief()` after each brief
- [x] `TICKER_PROXY_MAP` in `sector-mapping.js`: peer groups, ETF proxies, earnings-correlated groups (NVDA->AMD/SOXL, etc.)
- [x] `buildCIOMemory()` — 7 memory layers: ticker history, regime context, entry path track record, personality/franchise, CIO self-accuracy, episodic market backdrop, event-driven context (macro + earnings + proxy behavior)
- [x] `findSimilarEpisodes()` — macro condition matching (VIX state, oil direction, sector rotation, regime); requires 3/4 match
- [x] `findRelevantEvents()` — 5-day lookback for macro events, direct earnings, and proxy earnings via `TICKER_PROXY_MAP`
- [x] Updated CIO system prompt: memory-first evaluation priorities (ticker blacklist, event risk, regime alignment, then technicals)
- [x] Updated CIO user template: includes MEMORY section alongside proposal
- [x] `evaluateWithAICIO()` now accepts and passes memory context
- [x] Timeout increased from 8s to 15s (scoring cycles are 5 min, plenty of room)
- [x] `ai_cio_replay_enabled` toggle: CIO now runs during replay when both `ai_cio_enabled` and `ai_cio_replay_enabled` are "true"
- [x] D1 pre-load at replay start: path_performance, market snapshots, market events, ticker profiles, franchise config → `replayCtx.cioMemoryCache`
- [x] Live scoring pre-load: path_performance, last 30 snapshots, last 50 events → `env._cioMemoryCache`
- [x] In-memory CIO decision accumulation during replay with outcome backfill on trade close
- [x] Crypto leading indicator: BTC/ETH trailing 2-4wk trend as forward signal for equities (BTC→SPY/QQQ, ETH→IWM/XLF)
- [x] `btc_pct` + `eth_pct` columns in `daily_market_snapshots` + backfilled 180 trading days
- [x] BTC/ETH added to Daily Brief cross-asset context + `TICKER_PROXY_MAP`
- [x] `findSimilarEpisodes()` uses crypto trend as 5th matching dimension
- [x] Model config toggles set: `ai_cio_enabled = true`, `ai_cio_replay_enabled = true`
- [x] `market_events` backfill: 65 curated macro events (CPI/PPI/FOMC/PCE/NFP/GDP/Retail/ISM/Jobless) + 301 earnings from TwelveData for 89 tickers
- [x] SPY reaction cross-referenced from `daily_market_snapshots` for each event date

## Phase 6: Optimized Model Config [2026-03-18] ✅
- [x] Blacklist expanded: added AMZN, META, RKLB, RDDT, NVDA to `deep_audit_ticker_blacklist` (-$16,912 combined drag)
- [x] CIO franchise/blacklist: `cio_franchise_blacklist` with franchise (PH, AVGO, APP, LITE, AU, CAT, RGLD, HII, ANET, TJX) and blacklist (AMZN, META, RKLB, RDDT, NVDA, LRN, IESC, BG, WMT, ETN)
- [x] Tighter loss controls: `max_loss_pct` normal -2 → -1.5, pdz -5 → -3; `hard_loss_cap` $500 → $350
- [x] Higher entry quality floor: `min_entry_quality` 45 → 55
- [x] ORB fakeout sizing bug fixed: `__da_orb_size_mult` now wired into `_rawCombinedMult` in sizing chain
- [x] Regime size multipliers expanded: added `EARLY_BEAR: 0.50`, `BEAR: 0.40`
- [x] SHORT min rank lowered: 55 → 50
- [x] Tighter runner protection: `post_trim_trail_pct` 2 → 1.5, `runner_trail_pct` 2.5 → 2.0
- [x] Stall force-close reduced: 36h → 24h
- [x] All configs verified in D1, worker deployed

## UI Improvements [2026-03-18] ✅
- [x] Added `TYPICAL_DAILY_RANGE` + `getNormalizedIntensity()` to `shared-price-utils.js` — hybrid per-type bands with ATR override
- [x] Updated `getCardSkin()` and `SVGBubble` color logic to use volatility-normalized intensity (SPY +0.7% now looks as intense as TSLA +3%)
- [x] Ported S/R levels, trend lines, pattern detection (double top/bottom, triangles, flags, ranges), and TF-specific scaling from Daily Brief charts to right-rail `LWChart`
- [x] Added IWM to Daily Brief: backend candle fetch (D, 1H, 5m, 4H), `iwmTechnical` summary, SMC/ATR levels, prompt data; frontend chart symbol in both admin and user lists
- [x] Condensed Daily Brief prompt: merged Risk Factors + Cross-Asset into "Market Context", merged Sector + Almanac into "Sector & Themes", added per-section word limits (~800 words target), removed "Swing Trader Takeaway", reduced `max_completion_tokens` 6000→4000
- [x] Restructured Day Trader Levels to "Key Levels & Game Plan" — SMC support/resistance primary, ATR secondary, ORB context noted
- [x] Fixed all bare `catch {}` in `shared-right-rail.js` for Babel compatibility
- [x] Rebuilt compiled assets (`index-react.compiled.*.js`, `shared-right-rail.compiled.js`), deployed worker + Pages

## Backlog

### Earnings Verification (pre-secondary-check)
- [ ] **Finnhub debug** — Hit `GET /timed/earnings/upcoming?debug=1` to see raw Finnhub response for NFLX, TSLA, AAPL. Compare with public calendars.
- [ ] **TwelveData secondary** — Debug response now includes TwelveData earnings_calendar for same range. Compare `check_tickers_finnhub` vs `check_tickers_twelvedata`. If Finnhub has false positives, gate bubble-chart dashed ring on TwelveData confirmation.

### Emails
- [ ] **Contact Emails** — Centralize support@timed-trading.com, legal@timed-trading.com, and any others (Terms §17, VAPID subject, footer/nav). Ensure consistency across all surfaces.
- [ ] **Welcome Email** — Trigger on signup/subscription.
- [ ] **Reminder Emails** — Re-engagement (e.g., unused features, inactive users).
- [ ] **Transactional / Alert Notifications** — Email delivery for trade alerts, system notifications, etc.
- **Plan:** See `tasks/EMAIL_PLAN.md` for sending (Resend/SendGrid/etc.) and receiving (support/legal + optional inbound parsing).

### Daily Brief
- [ ] **News feed** — Extend beyond `fetchAlpacaEconNews` (economic/macro); add general market news section or broader news source for brief enrichment.
- [ ] **Move profiling + engine matching** — Build Jul 2025 → Mar 23 ticker-by-ticker move profiling (high MFE, low MAE, 1-2+ day span), classify moves by regime/volatility/context, map best-fit engine/setup/guard behavior, and feed results back into backtest selection/guard logic.
- [ ] **Weekly + Ichimoku context** — Add weekly timeframe coverage and multi-timeframe Ichimoku cloud reference to move profiling, reference-intel, and engine/guard policy generation.
- [ ] **CAT focused runtime rule** — Add CAT pullback-long preference with weekly ST/Ichimoku support, harden CAT short-entry guards when weekly context is unsupportive, then run focused replay/backtest validation.
- [ ] **NBIS mapping + CAT replay validation** — Fix duplicate NBIS sector mapping key, redeploy worker, then run additional CAT replay dates to confirm weekly-context fallback behavior remains correct.
- [x] **Active-universe profile enrichment orchestrator** — Added `scripts/enrich-active-ticker-profiles.js` to pull the active universe, run per-ticker learning/profile rebuilds, and write resumable manifest reports.
- [ ] **Batch enrichment validation** — After each active-universe batch, verify weekly/Ichimoku fields landed in `ticker_profiles` and `ticker_move_signals`, then run focused replay checks on a small ticker sample.
- [ ] **Phase 1: enrichment closeout** — Finish the active-universe enrichment manifest, repair failed tickers, and document any irreducible symbol/data exceptions before downstream rollout.
- [ ] **Phase 2: canonical move-profiler** — Expand ticker move snapshots into a canonical multi-phase, multi-timeframe schema with move quality/context buckets and durable JSON payloads.
- [ ] **Phase 3: move archetype classifier** — Classify canonical moves into explicit archetypes and persist engine / management / guard recommendations in `learning_json`.
- [ ] **Phase 4: runtime + Investor policy wiring** — Feed archetype/context priors into worker engine selection, scenario policy, and Investor-facing recommendation flows, then validate with replay/backtest runs.

## SPX Enrichment Repair [2026-03-24]
- [x] Reproduce the `SPX` learning timeout with exact manifest/orchestrator parameters and compare candle counts/ranges against nearby symbols that validated
- [x] Determine whether `SPX` is an outlier because of effective date range, duplicate/manual-import coverage, or script/orchestrator timeout budget
- [x] Implement the smallest safe fix so `SPX` can complete enrichment without regressing the rest of the repair pipeline
- [x] Re-run `SPX` enrichment + profile validation and document the root cause / mitigation in `tasks/lessons.md` and `CONTEXT.md` if warranted

## Canonical Move Policy Phase 5 [2026-03-24]
- [x] Sync tracker state so canonical move policy Phases 1-4 are treated as implemented baseline, with Phase 5 as the active step
- [x] Validate canonical payload + weekly/Ichimoku fields for `CAT`, `AXON`, `BABA`, `TSLA`, `ORCL`, `SPY`, `QQQ`, and `IWM`
- [x] Run focused replay checks for the Phase 5 starting set and capture runtime-policy evidence / blocker behavior
- [x] Review archetype plausibility across continuation, fragile-impulse, and ETF/index-context names before broader rollout
- [x] Decide promote / iterate / repair for broader backtest rollout based on the focused validation batch

## Canonical Move Policy Follow-ups [2026-03-24]
- [x] Repair schema gaps for `AXON`, `BABA`, and `IWM` (`move_json` missing, no archetype/runtime-policy fields landed in `learning_json`)
- [x] Investigate why `SPY` sampled intervals only show `dynamic_engine_blacklisted` and no policy-bearing diagnostic signal in the first Phase 5 pass
- [x] Re-run the Phase 5 validation artifact after the repair subset to decide whether broader rollout is justified
- [ ] Decide whether ETF/index names blacklisted by `dynamic_engine_rules` (`SPY`, `IWM`) should remain excluded from the Phase 5 “policy signal observed” pass criteria or be validated through a different lane

---

## Recently Completed
- **Trade Autopsy v2** [2026-02-26] — Backend: D1 `trade_autopsy_annotations` table, GET/POST `/timed/admin/trade-autopsy/annotations`, GET `/timed/admin/trade-autopsy/trades` (with direction_accuracy). Frontend: filtering (ticker, classification, date range), signal snapshots at entry (signal_snapshot_json, tf_stack_json) and exit context (exit_reason, MFE, MAE) in modal.
- **Trade Autopsy** [2026-02-26] — New `trade-autopsy.html` page: table of all closed trades, click row → modal with TradingView chart (asOfTs for historical candles), notes textarea, classification dropdown (Bad Trade, Valid Loss/Win, Improvement Opportunity, Data Error, Edge Case, Execution Issue, Good Trade). Annotations stored in localStorage. Nav link added (admin-only) to index-react, simulation-dashboard, daily-brief. GET /timed/candles now supports optional `asOfTs` for historical chart data.
- **Backfill for Backtest** [2026-02-27] — alpaca-backfill now accepts startDate/endDate to target the backtest range. full-backtest.sh backfills from 60 days before start (EMA warm-up) through end. Gap check uses same extended range. Fixes "0 candles" when backtest range was misaligned with sinceDays.
- **Losing Trades Report** [2026-02-27] — GET /timed/admin/losing-trades-report endpoint + scripts/losing-trades-report.js for manual review (ticker, dates, P&L, signals at entry). Deploy worker before use.
- **Daily 5/48 EMA + ST Slope Priority** [2026-02-27]
