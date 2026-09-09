# Setup audit and improvement plan — 2026-09-09

## Outcome and scope

The setup layer has real definition and attribution defects, not just badly
chosen weights. This PR fixes six classes of defect and adds an entry-evaluation
trace. It does **not** claim demonstrated PnL uplift, delete setups on thin
samples, change priority, or tune new numeric thresholds on old selected trades.

Audited base: 14c7c2e on main, following merged ranking PR #1442. Rebased for
publication onto 84e0619; the intervening commit changes only Pine Seeds data.
Separate feature PR.
No deployment, production replay, model-config write, broker action, sizing
change or exit-policy change was performed. Existing configured volume and
momentum requirements now enforce their stated requirements; this can change the
admitted trade set. Existing learning-proposals remains the policy-application bus.

Evidence: [2026-09-09-setup-audit.json](evidence/2026-09-09-setup-audit.json).
Reusable procedure: [setup-audit/SKILL.md](../skills/setup-audit/SKILL.md).

## 1. Findings and disposition

| ID | Finding and source | Disposition |
|---|---|---|
| S01 | canonicalPlayId let an explicit noncatalog path fall back to a core display label. The public export misgroups **50** direction-stamped Cloud Pivot paper rows as core Cloud Pivot and **3** momentum_score rows as tt_momentum. | **Fixed.** Executed path owns identity. Display fallback is only for unstamped history. Catalog admission and outcome cohorts use the same identity. No historical rows rewritten. |
| S02 | ATH/ATL uses daily high/low excursions: the flag stays true after price retreats through the level. Follow-through reads ctx.bundles.D or ctx.daily.pxPrev, neither supplied by normal TradeContext. | **Fixed.** Producer supplies prior high/low and two preceding closes; entry requires price still beyond the level. When the existing follow-through flag is on, the preceding completed session must move in the proposed direction. Missing required evidence does not pass. Both sides tested. |
| S03 | ATH/range/gap/n-test volume guards allow zero; TradeContext supplies 1.0 for missing 30m/1H data. Measured 0.5× 30m with missing hourly becomes 1.0× and can pass a 1.0× floor. Momentum's enabled floor bypassed absent/zero volume. | **Fixed for these entry guards.** Use observed volume with provenance; zero stays zero. Legacy defaults for unrelated consumers are unchanged. No numeric floor increased. Explicit structural floor 0 still disables the requirement. |
| S04 | Momentum's configured candle-position check reads m10.latest/currentBar, but normalized indicators contain neither. The guard silently skips. | **Fixed.** Carry the actual bar into tf_tech. An enabled check rejects missing, flat, incoherent or insufficiently strong bars; an unconfigured check stays off. |
| S05 | Per-setup diagnostics and forced-short markers survive ticker-object reuse when early returns prevent resets. Gap's anti-knife guard expects rawBars/bundles absent from normal assembly. Including today's bounce can also erase the preceding decline. | **Fixed on the normal producer path.** Reset per-pass state. Emit preceding completed-session decline statistics and consume them in the existing flag-gated check. Retain raw-bar fallback for old inputs. This remains gap-specific, not a new global ban. |
| S06 | Cloud Pivot conviction adds **+1** for a generic catalyst label, including upcoming earnings or event_risk. This can promote a one-cloud setup from 1 to the paper floor of 2 without directional evidence. | **Removed the automatic +1.** Keep catalyst session plans/if-then levels, leader confirmation, magnets, budgets and exits. Positive catalyst weight requires timestamped, directional outcome validation. |
| S07 | Later structural detectors are skipped once an earlier one fires. Old snapshot comments incorrectly claim all alternatives were evaluated. Missing can mean skipped, not failed. | **Instrumented, not reprioritized.** Bounded core trace records independent raw shapes, visited/disabled/preempted/not-reached checks, initial cloud triggers, attempted path, final core result and reason. Raw shape matches are not independent admissions. |
| S08 | Momentum/pullback/reclaim reuse nearby EMA clouds. Ordinary reclaim is largely a subset of pullback; lagging-H1 exceptions differ. Momentum's R5 rule can relabel overlap as pullback. Recorded performance depends on routing/gates. | **Retain IDs pending overlap and management-equivalence tests.** Do not count related cloud conditions as independent confluence or delete families based on correlated labels. |
| S09 | N-test counts near-level bars, not necessarily independent visits separated by a move away. Held means current price above/below the average cluster. Range also counts touch bars; valid range needs repeats on either edge, not both. | **Definition change pending.** Test independent visits, level integrity and actual rejection/reclaim. Range remains paused. Raising touch counts alone does not fix this. |
| S10 | Five-bar base tightness includes the breakout bar. “ATH” is a near-rolling-high setup with a prior-day-high excursion; history can be 60 bars, not necessarily 252. Momentum-elite can relax the base requirement. | **Retest before changing.** Separate prior-bar contraction from expansion/held break. Preserve thresholds and canonical ID; do not call every near-high print a new ATH. |
| S11 | N-test confirmation is a same-snapshot OR of ST flip / EMA cross / squeeze / LTF recovery. Recovery includes a score threshold, not necessarily a new event. General freshness accepts missing timestamps; squeeze confirmation is not uniformly side-qualified. | **Sequence-contract work pending.** Require event IDs, direction, availability time and invalidation. Compare location-only against actual ordered confirmation, not simultaneous flags. |
| S12 | Mean-reversion's FVG reclaim accepts being in/holding any active FVG. Its liquidity fallback can infer a sweep from an inventory count without zone objects. Neither proves an actual reclaim/sweep. No tt_mean_revert outcomes are present here. | **Do not promote or add points.** Pin producer semantics and replace inventory proxies with explicit directional events before evaluating this family. |
| S13 | Current public rows lack component-level entry snapshots; versions are missing/legacy. Old rich v10b snapshots are mostly pullbacks. Catalyst and ordered-sequence evidence are absent. | **Explicit measurement limit.** No claim of successful current calibration, catalyst effect or weekend-upgrade uplift. Obtain authorized current entry/candidate exports next. |

Sources: worker/foundation/play-catalog.js; worker/pipeline/admission-seam.js,
tt-core-entry.js and trade-context.js; worker/indicators.js;
worker/foundation/tt-cloud-pivot.js; the saved evidence.

## 2. What is redundant, and what is not?

The catalog contains 16 identities, not 16 independent sources of edge.
Historical display labels and engine paths for a core play are aliases.
Conversely, an explicit paper/legacy-engine path must not be collapsed into a
core cohort because its label looks similar.

| Family | Distinguishing trigger/location; source defaults | Overlap / recommendation |
|---|---|---|
| Gap Reversal Long/Short | Gap ≥1.5%; full reversal or >0.5% recovery from open; RVOL 1.2×. Long knife filter: 3 prior declining sessions and cumulative drop ≤−5%. | Can also touch support/cross clouds. Preserve event-conditioned identity; compare full vs partial reclaim and post-event vs ordinary gaps. |
| Support Bounce / Resistance Fade | 30-bar clustering within 0.75% of price; ≥3 touch bars; latest ≤5 bars ago; within 1.5% of held level; RVOL 1×. | Overlaps range/mean reversion/cloud bounce. Validate independent tests and response sequences. Restricted catalog status. |
| Range Reversal Long/Short | 12-bar range, 3–15% width, repeated touches, reversal/day-direction near an edge. | Candidate location subtype of support/resistance rejection. Already paused; stays paused. |
| ATH Breakout / ATL Breakdown | Near rolling high/low, prior-day level break, five-bar range, state filter; stock RVOL 1× / hardcoded ETF-cohort 1.5×. Near-high default 5% with momentum-early, otherwise 3%; base <5%. | Not necessarily literal ATH. ETF regex includes stock exceptions; not authoritative instrument metadata. Separate contraction, break and extension. Restricted admission remains. |
| Momentum / Pullback / Reclaim | 10m 5/12 trend/cross; 8/9 cloud proximity+slope+confirmation; 8/9 reclaim+ST flip. | Related execution states, not three independent confirmations. Evaluate a shared cloud family with subtypes before merging. |
| HTF Reclaim / Forming Pair | Daily EMA21 location/freshness+LTF response; complementary fast/slow timeframe formation. | HTF thesis versus LTF timing. Forming Pair may preempt other detectors. Keep separate measurement until incremental value is known. |
| Mean Reversion | PDZ + RSI extremes on ≥2 TFs + phase/TD + FVG/liquidity proxy. | Inventory/state is sometimes confused with events. Separate from the shadow TD sequence detector. |
| Index Swing / dedicated index model | SPY/QQQ/IWM-specific routing and structural requirements. | Keep index/ETF regime constraints separate from single-stock event setups. |
| Cloud Pivot / Confirm-stack / Continuation paper | Standalone family proposal when no canonical core ticket owns the entry; Cloud Pivot uses session-specific curls, clouds, magnets and event context. | Separate program, side and size cohorts. A coincident family stamp does not redefine a core ticket. Catalog tt_cloud_pivot remains core/legacy identity; no qualifyEntry("tt_cloud_pivot") was found inside TT Core. Current standalone paths have side suffixes. |
| Armed movie playbooks / TD-phase sequences | Existing observation/playbook systems: daily EMA21 reclaim, weekly breakout/retest, staged mean reversion. | Shadow diagnostics are not additional live setups. Do not create another near-identical EMA detector or equate shadow outcomes with live entries. |

These are code defaults, **not verified production config values**. The Aug 19
playbook audit is useful history, but its grade-wildcard/Cloud Pivot state is
superseded by later code. Learning loops already exist; do not add another apply
bus or assume more fixed floors solve the measurement problem.

### Actual priority and overlapping gates

Early Forming Pair can return before standard trigger evaluation; the dedicated
index model can route away. Structural evaluation is **ATH/ATL → Range → Gap →
N-test**. Their final return order differs, but earlier trigger exclusions
determine which can fire. Later Forming Pair and HTF Reclaim may return ahead of
standard selection. Standard selection favors momentum, then pullback, reclaim
and mean reversion, subject to R5's momentum-to-pullback fallback.

Many rejection gates act on momentumTrigger or pullbackTrigger before the final
path is returned. A co-firing incidental cloud signal can therefore affect a
structural setup. Changing the final return order alone would not isolate
setups. Refactor with decision-parity tests and explicit global versus
family-specific gates, preserving execution policy first.

## 3. What the available outcomes say

### Evidence boundaries

| Source | Coverage | Suitable use |
|---|---|---|
| Public ledger export read this pass | 778 rows, no further page; 765 closed as of 2026-09-09 23:59:59Z. 763 observed dollar PnLs, 762 percentage returns. Entries Jul 1, 2025–Sep 4, 2026; exits through Sep 9. Zero entry signal snapshots/rank traces. 519 closed versions missing; 246 labelled alpaca_server_v2.0. | Canonical cohort summaries, not attribution to current scoring or weekend changes. |
| Repository v10b final snapshot | 116 selected rows, 101 closed with rich lineage; Jul–Nov 2025. Dominated by 79 long and 10 short pullbacks. No actual rank traces. | Exploratory within-setup contrasts; not current validation or a rejected-candidate universe. |

Current source: https://timed-trading-ingest.shashant.workers.dev/timed/ledger/trades?limit=1000

Historical source:
data/trade-analysis/phase-h-v10b-1776787446/final-snapshot/trades-live-premortem.json

Input SHA-256 digests are in the evidence file. Sources were not combined into an
independent sample. Unlike the earlier WIN/LOSS-only count, this audit also
recognizes FLAT/CLOSED, keeping missing PnL separate.

### Trailing 30 days, by exit time

| Setup / side | Closed | Observed PnL rows | Reported PnL | Win rate on observed PnL | Mean trade return |
|---|---:|---:|---:|---:|---:|
| ATH Breakout / LONG | 14 | 14 | −$477.52 | 28.6% | −0.749% |
| Support Bounce / LONG | 17 | 17 | −$132.96 | 29.4% | −0.191% |
| Cloud Pivot paper / LONG | 23 | 22 | −$186.93 | 36.4% | −1.006% |
| Cloud Pivot paper / SHORT | 16 | 15 | +$32.97 | 60.0% | +0.150% |
| HTF Reclaim / LONG | 5 | 5 | +$41.80 | 40.0% | +0.035% |
| Range Reversal / LONG | 1 | 1 | −$120.94 | 0.0% | −1.866% |

These are reported realized outcomes under mixed entry dates, sizing and exits,
not a controlled test of present definitions. Small positives are fragile:
all-history HTF Reclaim mean turns negative without its top-dollar-PnL ticker;
paper-short Cloud Pivot does too. Gap Reversal Long accounts for much of
all-time profit, but only two closes occur in the trailing 90-day slice here.
Neither historical dominance nor recent inactivity supports automatic promotion
or disabling. No entries after Sep 4 are in this export.

### Same long-pullback setup, different context (old v10b only)

Equal-trade-weighted means, **not portfolio returns**:

| Entry context | n | Mean return | Without bucket's top-dollar-PnL ticker |
|---|---:|---:|---:|
| PULLBACK_PLAYER personality | 31 | +0.938% | +0.590% |
| VOLATILE_RUNNER personality | 38 | +0.045% | −0.327% |
| TRENDING execution regime | 55 | +0.675% | +0.446% |
| TRANSITIONAL execution regime | 24 | +0.083% | −0.255% |
| Daily and hourly ST both aligned | 27 | +0.746% | +0.473% |
| Only one aligned | 48 | +0.385% | +0.210% |
| RVOL 1× to <2× | 43 | +0.595% | +0.296% |
| RVOL ≥2× | 35 | +0.358% | +0.136% |

Setup/side/entry-month matched contrasts (minimum three entries per comparison
arm/cell) retain a +0.654 percentage-point association for PULLBACK_PLAYER vs
other personalities across three usable months; TRENDING vs TRANSITIONAL is
+0.772 pp across four. Both-ST-aligned vs others is +0.373 pp across four.
Ticker selection, profile calibration, management, event timing and unmeasured
regime conditions still confound these comparisons.

This is **not** evidence for adding a generic confluence sum. Larger RVOL is not
better here; adverse-RSI flag presence even has a positive association in the
selected long-pullback sample, while adverse phase differs. The ten short
pullbacks show different personality results. Small cells and multiple
comparisons raise the chance of attractive coincidences. All bins, missingness,
matched cells and top-ticker sensitivities are saved, not just the winners.

There is **zero verified as-of catalyst or ordered preceding-sequence coverage**
in these exports. A news label, upcoming-risk event and favorable observed
reaction are different features. Today's narrative must not be attached to an
old winner and called its entry catalyst.

## 4. Ordered improvement plan

| Priority | Work packet | Completion / promotion criterion |
|---|---|---|
| P0 — this PR | Fix S01–S06; instrument S07 without changing priority. | Unit and real producer→TradeContext→entry tests; preserve identity, flags, sizing/exits and redaction. Version bump included. |
| P1 — current evidence | Obtain authorized admin entry snapshots/decision records and all candidates, including rejected/preempted decisions. Verify runtime flags, versions and trail coverage. | Per record: trade/run/decision ID, play+side, code/config/profile versions, as-of, observed/missing inputs, policy and net fill/fee outcomes. No current-quote substitution or nearest-trail joins that reach after entry. |
| P1 — contracts | Address S09–S12: independent tests, prior-base contraction, direction/freshness, actual reclaim/sweep events. | Synthetic positives/negatives, missing-data tests and no future-bar leakage. Price location alone cannot masquerade as a temporal event. |
| P1 — overlap/parity | Split global vetoes from family requirements; keep old selection as baseline; independently evaluate eligible sets in shadow. | Attribute every old/new decision difference. Report A∩B/A∪B, unique candidates, selected/preempted and holding/cost behavior. Merge only if unique contribution is negligible on holdouts and management is equivalent. |
| P2 — context tuning | Per setup+side, preregister a small set: personality/volatility/liquidity; market+sector+relative strength; HTF thesis/LTF trigger; event/reaction; sequence age/invalidation. | Chronological train/validation/test, purge overlapping trade/event horizons, ticker holdouts, leave-best-ticker/day-out and block-bootstrap uncertainty. First hold sizing/exits/costs constant. No universal confluence sum. |
| P2 — catalysts | Separate scheduled risk, reported event, directional reaction, surprise and post-publication relative volume/strength. | Event ID, source, publication/first-available time, expiry, reaction horizon and side. Unknown is not no-catalyst. Add points only for incremental out-of-sample value within the setup. |
| P2 — preceding signals | Reuse existing events/sequences. Compare location-only → trigger → independently confirmed trigger, with side and elapsed time. | Strictly pre-decision available observations. Audit missing 10m coverage, timestamp fallback and simultaneous-stage behavior before treating shadow output as chronology. |
| P3 — controlled validation | Approved replay in preproduction only, full intended universe and current flags/cadence; then shadow/canary through existing proposals. | Net realized dollars, equal-risk expectancy, drawdown, tails, turnover, slippage and retained opportunity. Separate entry effects from capacity cascades and forced replay-end marks. Locked holdouts and uncertainty; small-cell wins do not authorize promotion. |

Target simplification: **location/thesis → trigger → independent confirmation →
context → admission**, with canonical subtypes for different execution events.
This does not mean every current detector can safely be merged now. A catalyst
is not mandatory for every setup; measure it against comparable no-event and
unknown-context cases.

## 5. Trace, rollout and verification handoff

The reset-per-pass __setup_evaluation (setup-evidence-v1) records raw shapes
separately from short-circuited checks. cloud_triggers are initial post-quality
states, not guaranteed final admissions. Qualified core result is not a fill.
A standalone paper ticket can correctly carry a rejected core trace because a
different proposal path supplied the ticket; scope is explicit.

Trace is attached to both existing entry snapshots, retained in minimal D1
payloads and the existing sequence-trail serializer, and removed by member/anon
redaction. The existing trail enable flag still applies. This PR does not claim
the trail is enabled or complete in production. Raw-shape overlap is not an
independent eligibility overlap rate.

New indicator fields require a coherent rescore after approved deployment. Old
ATH snapshots lack required prior levels and will not pass the new check. Do not
lower floors to compensate. Use the normal approved deploy/rescore workflow,
including scoring producers/engine, not only the API worker.
SCORING_VERSION: **2.1.6-2026-09-09**. No new runtime config keys.

Reproduce without service writes:

    node scripts/audit-setups.mjs --as-of 2026-09-09T23:59:59Z \
      /path/to/setups-ledger-20260909.json \
      /path/to/rank-driver-history-v10b.json
    node node_modules/vitest/vitest.mjs run worker/pipeline/setup-evidence.test.js \
      worker/foundation/play-catalog.test.js worker/pipeline/admission-seam.test.js \
      worker/foundation/tt-cloud-pivot.test.js scripts/audit-setups.test.js

The audit requires an explicit as-of, deduplicates by trade/run, preserves
unknown outcomes, excludes future exits and explicitly later snapshots, and
exports all context bins. It does not fit or apply a policy.

### Work checklist

- [x] Inventory identities, thresholds, routing and shadow layers.
- [x] Audit current export and historical context separately.
- [x] Implement supported corrections and regression tests.
- [x] Save complete findings, evidence and ordered follow-up plan.
- [x] Full suite: **3,626 tests across 328 files passed**.
- [x] Syntax/bundle/version checks and skill validation passed; unchanged KWEB duplicate-key bundle warning.

Publication and GitHub CI status are recorded in the PR. No deployment was performed.

Task-local checklist avoids the shared tasks/todo.md conflict hotspot under
CONTEXT.md's feature-PR rule.
