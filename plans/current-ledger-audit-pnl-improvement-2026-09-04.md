# Current Ledger Audit and PnL Improvement Plan — 2026-09-04

**Status:** Audit complete; expanded finding-to-action plan; implementation not started  
**Scope:** Active Trader paper ledger and the model paths that select, size, manage, and attribute trades  
**Safety:** Read-only production review. No model, flag, configuration, ledger, broker, or deployment state was changed.  
**Primary snapshot:** Public ledger generated 2026-09-04 01:23:52 UTC; latest closed trade 2026-09-03 19:29:40 UTC.

**Canonical evidence snapshot:** all dollar/PF figures in this document refer to
the 2026-09-04 01:23:52 UTC pull above. Later work must not "refresh" these
numbers in place; new evidence goes in the execution log with its own snapshot
stamp so cohort claims stay reproducible.

**Out of scope:** the index day-trade options lane (SPY/QQQ/IWM/DIA 0/1 DTE)
and the index trend LETF lane. Those books have their own entry-timing doctrine
(`skills/index-dt-entry-timing.md`; trigger-pierce fix merged in PR #1414) and
must not be governed by this plan's ST-equity cohort gates.

## Execution charter — first slice (2026-09-04 addendum)

This plan authorizes ONE slice at a time. Everything not listed here is
**parked** — reading it is fine, building it is not.

**Slice 1 (now):**

1. **Packet A** — reconcile the $142.44 account/ledger gap to $0.01 and pin the
   status state machine (OPEN / TP_HIT_TRIM / FLAT / WIN / LOSS).
2. **Packet B** — canonical_play_id + provenance fields; backfill the ATH
   aliases; quarantine ambiguous rows.
3. **F24 fix (pulled forward from G)** — a validation PASS must be impossible
   with zero decision rows, duplicate-trade evidence, or `reset_ok=false`.
   This is a P0 promotion blocker, not later scorecard polish: no shadow
   challenger may promote through a scorecard that can green-light on empty
   evidence.
4. **Packet I** — single mandatory admission seam + fail-closed missing-input
   handling + bypass contract tests.

**Slice 2 (only after Slice 1 acceptance):** Packet C shadow demotion of the
ATH aliases (110 trades, PF 0.55) and Cloud Pivot (22 trades, PF 0.30), using
the canonical IDs from B and the seam from I.

**Slice discipline:** one behavioral lever per experiment still applies inside
a slice. If two packets need the same file, they land sequentially, not as one
combined PR.

**Gap Reversal stance:** protect, do not dilute. F03's concentration risk is
managed with per-setup caps and current-regime validation of Gap Reversal
Long — never by pushing capital into weaker setups to "diversify." Demoting
ATH/Cloud Pivot must not implicitly re-rank capital into unproven cohorts.

**Opportunity-capture guardrail (H):** the 4.8% capture figure is a
denominator problem to *measure*, not a number to maximize. The acceptance
metric is net opportunity value after costs; "correct reject" counts as a
success outcome. Any experiment whose only win is more executed trades fails.

## Executive conclusion

The account remains profitable since inception, but the recent book has lost its edge. The main problem is not simply “a few bad trades.” It is a combination of:

1. **Edge concentration:** historical profit is dominated by Gap Reversal Long.
2. **Recent negative expectancy:** the 30-day book is losing, and one winner materially masks the weakness.
3. **Admission quality:** untrimmed trades are overwhelmingly negative; this is consistent with entries that never develop enough favorable excursion to earn a trim.
4. **Unreliable attribution:** setup aliases, status semantics, account/ledger reconciliation gaps, sparse validation artifacts, and multiple exit authorities make it difficult for learning loops to act on the right evidence.
5. **Too many interacting levers:** rankings, grades, conviction, focus tiers, loops, sizing multipliers, and exit families are not yet governed by one calibrated expected-value contract.

The next improvement cycle should begin with ledger truth and canonical attribution, then test stricter admissions for demonstrably negative cohorts. Exit and sizing changes should follow only after entry-quality experiments are isolated.

## Current ledger snapshot

### Account

| Metric | Current value |
|---|---:|
| Starting cash | $100,000.00 |
| Account value | $136,632.24 |
| Total P&L | +$36,632.24 (+36.63%) |
| Realized P&L reported by account summary | +$36,905.47 |
| Unrealized P&L | -$273.23 |
| Open positions reported by account summary | 18 |
| Closed WIN/LOSS rows | 743 |
| Closed results | 357 wins / 386 losses |
| All-time win rate | 48.0% |
| All-time profit factor, recomputed | 1.80 |
| Average win / average loss | $233.75 / $120.21 |
| Payoff ratio | 1.94 |
| All-time expectancy | +$49.86 per closed trade |

The public proof page reports a 2.81 annualized Sharpe ratio and -3.51% maximum drawdown from its daily equity series. Those headline figures describe the full history and should not be used as evidence that the current strategy mix is healthy.

### Rolling performance

| Window | Trades | Win rate | Net P&L | Profit factor | Expectancy/trade | Trade-sequence drawdown |
|---|---:|---:|---:|---:|---:|---:|
| 7 days | 13 | 38.5% | -$148.04 | 0.26 | -$11.39 | -$148.04 |
| 14 days | 27 | 40.7% | -$108.06 | 0.71 | -$4.00 | -$281.83 |
| 30 days | 64 | 34.4% | -$285.97 | 0.79 | -$4.47 | -$973.08 |
| 60 days | 95 | 33.7% | +$367.31 | 1.11 | +$3.87 | -$1,441.51 |
| 90 days | 110 | 32.7% | -$369.65 | 0.93 | -$3.36 | -$1,441.51 |
| 180 days | 202 | 37.6% | +$93.60 | 1.01 | +$0.46 | -$3,743.86 |

The 180-day result is effectively flat despite large gross wins and losses. Recent growth is therefore stalled even though the inception curve remains strongly positive.

### Outlier sensitivity

The 30-day result depends heavily on one RTX Support Bounce winner:

| 30-day view | Net P&L | Profit factor | Expectancy/trade |
|---|---:|---:|---:|
| Reported 64 trades | -$285.97 | 0.79 | -$4.47 |
| Excluding top winner (+$647.21) | -$933.18 | 0.33 | -$14.81 |
| Excluding top five winners | -$1,237.72 | 0.11 | -$20.98 |

Support Bounce appears profitable over 30 days (+$442.49, PF 2.31), but excluding the RTX trade it becomes -$204.72 with PF 0.39. Do not promote this cohort from its untrimmed headline result.

## Setup, direction, grade, and trim findings

### Canonical setup findings

| Setup | Sample | Win rate | Net P&L | Profit factor | Assessment |
|---|---:|---:|---:|---:|---|
| Gap Reversal Long | 357 | 57.1% | +$38,088.14 | 2.68 | Proven historical engine; also creates concentration risk |
| ATH Breakout, aliases combined | 110 | 39.1% | -$2,756.57 | 0.55 | Strong demotion/shadow-only candidate |
| N Test Support | 74 | 37.8% | +$201.82 | 1.04 | No reliable edge after costs |
| Pullback | 63 | 47.6% | -$508.06 | 0.90 | Negative before costs |
| Support Bounce | 31 | 29.0% | -$365.40 | 0.73 | Negative overall; recent “edge” is one-trade dependent |
| Cloud Pivot | 22 | 36.4% | -$160.17 | 0.30 | All observations are recent; poor initial evidence |
| Gap Reversal Short | 11 | 63.6% | +$2,078.43 | 10.38 | Promising but too small for unrestricted promotion |

The public ledger contains at least two ATH aliases: **TT Tt Ath Breakout** and **TT ATH Breakout**. The proof UI displays them as separate rows, obscuring the combined 110-trade, -$2,756.57 result. Similar prefix/parenthesis variants exist elsewhere. Canonical play ID must be the grouping key.

### Recent cohort findings

- Last 30 days: ATH Breakout lost $478.13 on 19 trades, PF 0.15.
- Last 30 days: Cloud Pivot lost $160.17 on 22 trades, PF 0.30.
- Last 60 days: ATH Breakout lost $920.87, PF 0.22.
- Last 60 days: Range Reversal Long variants lost $547.74 in one displayed alias, with only one small win.
- Longs were 55 of 64 recent trades and lost $312.43, PF 0.77.
- Shorts were 9 of 64 and earned $26.46, PF 1.65; the sample is too small to infer that direction should be flipped.

### Grade calibration drift

All-time, Prime is useful (408 trades, PF 2.38, +$39,233), Confirmed is flat (222, PF 1.02), and Speculative is negative (113, PF 0.54, -$2,379). In the last 30 days, however, grades do not order outcomes: Prime has only five observations, Confirmed is PF 0.26, and Speculative is PF 1.03 only because it contains the large RTX winner. Recalibrate grades by configuration epoch and remove outlier dependence before using them for size.

### Trim diagnostic

| 30-day cohort | Trades | Win rate | Net P&L | Profit factor |
|---|---:|---:|---:|---:|
| Trimmed | 24 | 75.0% | +$761.75 | 3.41 |
| Untrimmed | 40 | 10.0% | -$1,047.72 | 0.02 |

All-time, trimmed rows earned +$69,851.76 while untrimmed rows lost -$32,803.85. This is **diagnostic, not causal**: trades earn a trim because they first move favorably. The actionable hypothesis is that admission quality is poor for trades that never reach the trim trigger, not that forcing more trims will create edge.

## Ledger and validation integrity findings

1. **Account reconciliation gap:** WIN + LOSS + FLAT row P&L totals +$37,047.91, which is $142.44 above the account summary’s +$36,905.47 realized P&L. This must reconcile to the cent or have an explicit adjustment/event explanation.
2. **Status semantics:** the ledger returns 766 rows: 357 WIN, 386 LOSS, 5 FLAT, 17 OPEN, and 1 TP_HIT_TRIM. The account summary reports 18 open positions, implying TP_HIT_TRIM is operationally open. Public closed-trade KPIs exclude FLAT rows.
3. **Setup alias fragmentation:** the UI groups display strings instead of a stable canonical play ID.
4. **Missing audit fields in public rows:** decision ID, config hash, regime, personality, entry path, candidate rank, calibrated probability/EV, MFE/MAE, fees/slippage, and bar-validation results are absent.
5. **Execution realism:** public results exclude broker fees, slippage, and taxes.
6. **Historical data-quality evidence:** the July autopsy documented stale/phantom entry and exit prices, duplicate bars, and tape-range violations. The current public rows cannot prove these have been fully eliminated.
7. **Validation artifacts are not decision-grade:** the latest CIO validation artifact contains zero decision/outcome rows; the validation matrix contains two identical losing trades, a failed reset flag, zero delta, and still records PASS.
8. **Attribution is diluted by architecture:** tt_core lifecycle decisions can be annotations while inline fallback continues; several exit families can own the final action. A trade outcome needs one authoritative decision lineage.
9. **Calibrated edge is not yet the selector contract:** calibrated probability/EV exists in trust-spine code, while focus rank remains a static feature sum and selector RR is only a tiebreaker. The live caller/config could not be verified without authenticated access.
10. **Learning-loop visibility is incomplete:** exact setup × regime × personality × side cohorts are sparse and the loops fail open. Setup aliases and missing catalog entries further divide evidence.


## Complete finding-to-action register

This register is the controlling checklist. A finding is not considered covered merely because it resembles a broad work packet; each row must receive a disposition, test evidence, and PR or issue reference.

| ID | Finding and evidence | Why it matters | Required disposition |
|---|---|---|---|
| F01 | Current edge is negative: 7d PF 0.26, 30d PF 0.79, 90d PF 0.93, and 180d PF 1.01. | Inception metrics conceal current stagnation. | A, G: epoch-aware rolling scorecard and explicit current-edge state. |
| F02 | One $647.21 RTX winner changes 30d P&L from -$285.97 to -$933.18 when removed. | Mean P&L and setup promotion are outlier-dependent. | G: top-1/top-5 sensitivity and median/bootstrap intervals are mandatory gates. |
| F03 | Gap Reversal Long produced +$38,088.14, more than total closed-ledger net; the rest of the book is net negative in aggregate. | Historical performance is one-engine concentration, not broad model quality. | F, G: setup concentration limits and current-regime validation. |
| F04 | ATH aliases: 110 trades, -$2,756.57, PF 0.55. Cloud Pivot: 22 trades, PF 0.30. Several other setups are at or below break-even before costs. | The system continues allocating attempts to cohorts with demonstrated negative expectancy. | C: shadow reject/demotion policy with cohort-specific recovery gates. |
| F05 | Recent longs: 55 trades, -$312.43, PF 0.77; shorts: 9 trades, +$26.46, PF 1.65. | Direction may be informative, but the short sample is insufficient to flip bias. | D, G: include side in calibration and uncertainty; no side promotion from n=9. |
| F06 | All-time Prime is strong, Confirmed is flat, Speculative is negative; recent grade ordering collapses and is outlier-sensitive. | Grade is not a stationary probability estimate and should not directly determine size. | D, F, L: epoch-calibrate grade and reconcile grade definitions. |
| F07 | 30d trimmed rows: +$761.75, PF 3.41; untrimmed: -$1,047.72, PF 0.02. Month-end review similarly found 23/28 losses untrimmed. | Entries that never develop are the main bleed, but trim status is post-treatment and cannot be used as a causal input. | H, J: model probability/time to first favorable excursion; do not “force trims.” |
| F08 | Closed WIN/LOSS/FLAT P&L exceeds account realized P&L by $142.44. | No trustworthy optimization is possible without financial reconciliation. | A: event-level P&L reconciliation to $0.01. |
| F09 | Ledger has WIN, LOSS, FLAT, OPEN, and TP_HIT_TRIM; account open count treats TP_HIT_TRIM as open while public KPIs omit FLAT. | Status-dependent denominators can silently change metrics. | A: one documented state machine and common metric view. |
| F10 | Setup aliases split identical plays, including TT Tt Ath Breakout vs TT ATH Breakout. | Learning samples and UI attribution are fragmented. | B: canonical_play_id backfill and API/UI grouping. |
| F11 | Public rows lack decision_id, config_hash, regime, personality, calibrated EV, MFE/MAE, candidate context, and exit owner. | Outcomes cannot be attributed to the logic/config that produced them. | B, G: provenance completeness contract and exclusion flags. |
| F12 | Results exclude fees and slippage. | Near-break-even cohorts likely become negative after realistic execution. | A, D, G: explicit cost model and sensitivity bands. |
| F13 | July autopsy found stale entry prints, exits at prices that never traded, degenerate bars, and duplicated daily bars. | Some historical “losses” and signals may be artifacts; training on them corrupts the loop. | B: tape-range, freshness, duplicate-bar, and quarantine checks. |
| F14 | July entries clustered in 30–90 second scan bursts, often just after the open; several were opening chases. | Correlated admissions amplify one bad market state and bypass evidence accumulation. | I, J: opening-window policy, batch correlation cap, and per-cycle exposure limit. |
| F15 | Cohorts marked always-blocked still entered; suspected causes are missing-input default allow or bypass of tt-core admission. | A correct policy is useless if not enforced on every path. | I: one mandatory admission seam, fail-closed reasons, and bypass tests. |
| F16 | Slow/range-bound tickers consumed short-term slots; there is no reliable expected-move-versus-risk-and-hold-time screen. | Capital is spent on trades unable to pay for risk or opportunity cost. | J: ATR/ADR expected-move and horizon-fit gate. |
| F17 | The system often catches part of a move, exits, then has no level-aware re-entry doctrine; liquidity zones are largely stop inputs rather than entry memory. | Valid theses are abandoned while later reclaim legs are missed. | J: shadow re-entry state machine keyed to thesis, sweep, level, and reclaim. |
| F18 | Support-bounce stops can be ATR/dollar fallbacks rather than the support that justified entry; clock/force exits have fired into mapped support or flushes. | Risk and exit logic can contradict the trade thesis. | K, E: structural invalidation first, dollar caps as disaster bounds, support-aware exit tests. |
| F19 | Protection stage can dissolve when P&L falls below zero; some trimmed runners skip breakeven protection; a losing liquidation was labeled as a trim. | Profit protection and analytics semantics can both fail at the point of need. | K, A: persistent monotonic protection stage and event-level trim semantics. |
| F20 | Self-calibration review reported only 57 captured moves versus 662 qualifying opportunities, about 4.8%. | Optimizing only executed trades cannot distinguish selectivity from missed edge. | H: candidate/opportunity funnel with resolved counterfactuals. |
| F21 | Confirm-stack filtering improved OOS win rate (57.1% vs 52.7%), while conviction sizing degraded OOS SQN (+0.58 IS to -0.26 OOS); the proposed flip reduced losses but remained negative. | Signal gating has evidence; size amplification does not. | C, F: test confirmation as admission evidence; do not promote conviction sizing without new OOS proof. |
| F22 | Focus-rank correlation was approximately +0.002 in V11; entry selector defaults are off and RR is only a tiebreaker; calibrated-edge fallback uses fixed probabilities and is not clearly the live selector source of truth. | The ranking stack is not demonstrably ordering economic outcomes. | D: calibration/reliability curves, rank monotonicity test, and a single consumed EV contract. |
| F23 | Phase-C loops use sparse exact cohorts and fail open; Cloud Pivot was missing from the catalog; trade-review C labels did not automatically mutate policy. | “Learning” can observe losses without changing admission behavior. | B, C, G: catalog completeness, hierarchical shrinkage, explicit review-to-policy workflow, safe fallback. |
| F24 | CIO validation had zero decision/outcome rows; another matrix used two identical losses, reset_ok=false, zero delta, yet recorded PASS. Closed-loop readiness can be reached with two epochs and only five closes. | Promotion status can be green without meaningful evidence. | G: hard invalidation on reset/evidence/reconciliation failures and stronger sample policy. |
| F25 | tt_core lifecycle output can be advisory while inline fallback continues; multiple exit families may act. | Outcome attribution and replay equivalence are ambiguous. | E: exactly one authoritative owner per lot/action and parity tests. |
| F26 | Sizing composes many multipliers with a floor; minimum notional can weaken a low-conviction haircut. | Risk can increase after the model expresses low confidence. | F: monotonic sizing invariant and floor-after-haircut tests. |
| F27 | MFE-ratchet autopsy on 55 trades estimated -$2,602 actual versus +$436 counterfactual and a 34.5% to 41.8% WR change. | There is meaningful management upside, but only if the ratchet actually fires and the counterfactual uses valid prices. | E: reproduce on quarantined-clean data, verify live firing and authority, then shadow test. |
| F28 | Edge scorecard covers rolling outcomes but omits the full candidate denominator, missed opportunities, costs, confidence intervals, and robust outlier views. | The scorecard cannot judge selection quality or statistical reliability. | G, H: complete the scorecard contract. |
| F29 | The codebase contains many overlapping flags, exceptions, and setup carve-outs; recent work has not produced a clean isolated alpha cycle. | Interactions make causal learning and rollback difficult. | M: active-config manifest, dependency graph, one-lever experiment rule, dead-flag retirement. |
| F30 | Product narrative says Prime/Confirmed/Early and grade-aware 72h/36h management, while the current ledger uses Prime/Confirmed/Speculative and shows much faster exits in some cohorts. It also claims eight-timeframe alignment and a CIO gate. | User-facing claims, ledger taxonomy, and actual enforcement may have drifted. | L: claim-to-code-to-ledger contract tests and corrected product language where needed. |

### Historical evidence that must remain visible

- Baseline self-calibration report: 646 trades, 50.5% WR, PF 1.89, +$58/trade, +$37.4K; only about 4.8% of qualifying moves captured.
- Month-end last-40 review: 10 wins / 28 losses, about 27% WR; 23 of 28 losses were untrimmed and totaled about -40%, while trimmed trades were net positive.
- Aug 13–19 review: 25 closes, 4W / 19L / 2F, -$817; 20 were Speculative and lost $598; CIO usually adjusted size rather than rejecting.
- July short-term autopsy: 32 trades, 8W / 22L / 2 open; only one trade trimmed; 12 reached at least +1.5% MFE and many round-tripped.
- Ratchet counterfactual: 55-trade sample improved from approximately -$2,602 actual to +$436 counterfactual, subject to clean-price reproduction.
- Confirm-stack evidence is more promising as an admission filter than conviction sizing is as a capital multiplier.


## Prioritized plan

### P0 — Establish ledger truth before changing behavior

**Work packet A: Reconciliation contract**

- Build one event-level reconciliation for entries, trims, closes, realized adjustments, and open mark-to-market.
- Make account realized P&L equal the sum of realized ledger events within $0.01.
- Define OPEN, TP_HIT_TRIM, FLAT, WIN, and LOSS semantics in code and API documentation.
- Add an automated check for account open count versus operationally open statuses.
- Include costs as separate fields even while paper values are zero or estimated.

**Acceptance:** CI/replay fails on unexplained reconciliation drift; proof and internal scorecards consume the same canonical totals.

**Work packet B: Canonical attribution**

- Require canonical_play_id, decision_id, config_hash, entry_path, and authoritative_exit_owner on every new trade.
- Backfill aliases where deterministic; quarantine ambiguous rows.
- Group proof/scorecards by canonical_play_id, with display names as labels only.
- Record data-quality flags for stale bars, entry/exit outside bar range, duplicate daily bars, and missing market data.

**Acceptance:** no setup is split by capitalization/prefix; every scored trade can be traced to one decision/config epoch; invalid rows are excluded from promotion evidence but retained for audit.

### P1 — Stop paying for cohorts with demonstrated negative expectancy

**Work packet C: Admission shadow policy**

Create a shadow-only challenger that rejects or severely reduces admission for:

- ATH Breakout until a narrower cohort demonstrates positive net expectancy; current evidence is 110 trades, PF 0.55.
- Cloud Pivot while its initial sample remains PF 0.30.
- Confirmed/Speculative combinations whose lower confidence bound remains below zero.
- High-chop Speculative candidates identified in the August reviews.
- Any candidate with no valid canonical setup, stale evidence, or non-positive expected value after estimated costs.

Do not immediately mutate the production policy. Log accepted/rejected candidate sets and counterfactual outcomes first.

**Acceptance:** minimum 30 resolved shadow candidates per changed cohort (or a documented sequential/Bayesian equivalent), positive expectancy after estimated costs, PF target at least 1.20, no worse drawdown, and robustness after removing the top winner.

**Work packet D: One calibrated selector contract**

- Produce one calibrated probability and expected-value object from setup, side, regime, personality, trend alignment, risk distance, and data-quality state.
- Make the selector consume that object as a gate, not merely annotate it downstream.
- Replace static rank/grade thresholds with epoch-calibrated bands.
- Keep uncertainty explicit; sparse cohorts should shrink toward a conservative prior rather than fail open.
- Log the entire candidate set so missed-opportunity rate can be measured alongside executed-trade quality.

**Acceptance:** every admission/rejection has a reproducible feature snapshot, calibrated probability, EV after costs, uncertainty, config hash, and reason code.

### P2 — Improve management only after entry cohorts are isolated

**Work packet E: MFE/MAE and exit ownership**

- Capture MFE, MAE, time-to-MFE, time-to-trim, giveback, and attainable target for all trades.
- Verify the MFE ratchet fires in live paper execution and that its exit is authoritative.
- Normalize exit outcomes so a post-trim stop is separated into trim realization and remaining-lot realization.
- Compare current exits with clock-, level-, and ratchet-based counterfactuals using the same price-validation rules.

**Acceptance:** one exit owner per lot; no contradictory lifecycle/fallback action; replay and live decision lineage match; exit experiments improve capture without admitting weaker entries.

### P3 — Size only proven, stable edge

**Work packet F: Sizing guardrails**

- Keep conviction sizing off or capped for cohorts without positive out-of-sample expectancy.
- Remove minimum-notional behavior that can overpower a low-conviction haircut.
- Cap setup/config-epoch concentration; report P&L with and without the largest winner.
- Do not scale Gap Reversal merely because it owns all historical profit; validate current-regime performance separately.
- Treat promising Gap Reversal Short results as exploratory because n=11.

**Acceptance:** sizing is monotonic with calibrated edge, cannot be increased by a floor after a risk haircut, and passes out-of-sample drawdown and concentration gates.

### P4 — Make the loop governable

**Work packet G: Champion/challenger scorecard**

For each config epoch and cohort, publish:

- candidate count, executions, rejects, missed winners;
- win rate, expectancy, PF, gross win/loss, maximum drawdown;
- median and confidence interval, not only mean;
- top-1/top-5 winner sensitivity;
- costs/slippage sensitivity;
- MFE/MAE capture and trim reach rate;
- reconciliation/data-quality exclusions;
- source decision/config hashes.

Use one changed lever per challenger. Promotion requires an out-of-sample holdout and a rollback-ready flag. A PASS is invalid when reset, evidence count, reconciliation, or data-quality checks fail.


### P5 — Measure the opportunity funnel, not only executed trades

**Work packet H: Candidate capture and missed-opportunity ledger**

- Persist every qualifying candidate, admission decision, rejection reason, score/EV snapshot, and later path outcome.
- Define the denominator behind the reported 57 captured versus 662 qualifying moves and make it reproducible.
- Measure capture rate by setup, side, regime, ticker personality, hour, opening window, and config epoch.
- Label counterfactual outcomes using the same price-validity and cost rules as executed trades.
- Separate “correct reject,” “missed winner,” “avoided loser,” and “unresolved” rather than optimizing raw capture upward.

**Acceptance:** every scan cycle reconciles candidate counts to decisions; missed-opportunity metrics are reproducible; promotion optimizes net opportunity value, not trade count.

### P6 — Guarantee admission policy enforcement

**Work packet I: Single mandatory gate and correlated-entry controls**

- Route every tt_core entry path through one admission seam.
- Replace missing-input default allow with an explicit safe outcome and observable reason code.
- Add contract tests proving an always-blocked setup/side/grade cannot enter through HTTP, cron, queue, replay, or fallback paths.
- Add opening-window and scan-burst controls in shadow: batch exposure, sector correlation, and maximum new risk per cycle.
- Confirm that CIO REJECT can stop a trade; distinguish REJECT from ADJUST in decision records.

**Acceptance:** zero bypasses in path coverage tests; every admission names the gate result; blocked cohorts generate shadow records but no paper order when enforcement is enabled.

### P7 — Align timing, ticker opportunity, and re-entry

**Work packet J: Expected-move, timing, and thesis-memory experiments**

- Add a shadow horizon-fit screen comparing ATR/ADR, distance to targets, stop distance, expected holding window, spread/cost, and opportunity cost.
- Test opening-window confirmation requirements and reject stale/pre-market prices for regular-session entries.
- Record leg maturity: distance/time from HTF reclaim, proximity to prior swing high, premium/discount zone, and trend age.
- Build a shadow re-entry watch after a valid exit when HTF thesis remains intact; require mapped support/sweep plus reclaim confirmation.
- Consume liquidity zones as decision context and thesis memory, not only stop anchors.

**Acceptance:** horizon-fit score orders realized opportunity; stale/opening chases fail deterministic tests; re-entry is independently measured and cannot duplicate live exposure.

### P8 — Make risk and protection thesis-aware

**Work packet K: Structural stop and persistent protection state**

- Anchor setup stops to the level that invalidates the setup; retain dollar/percentage caps only as disaster limits.
- Persist protection stage monotonically per lot so breakeven/runner protection cannot disappear when price crosses entry.
- Remove blanket exemptions that leave trimmed runners without an entry floor unless a tested structural alternative is active.
- Define a trim as a profitable partial realization; loss liquidations must be CLOSE/REDUCE_LOSS events.
- Prevent clock/force exits from firing directly into valid mapped support without an explicit structural-break reason.

**Acceptance:** replay invariants cover stage persistence, event semantics, and structural anchors; clean-data shadow results improve capture/drawdown before any live-paper promotion.

### P9 — Reconcile product claims with executable behavior

**Work packet L: Claim-to-code-to-ledger contract**

- Choose and document one grade vocabulary: Prime/Confirmed/Speculative or Prime/Confirmed/Early.
- Verify whether grade truly changes maximum hold windows, stop width, and management; publish the actual rules.
- Trace the claimed eight-timeframe alignment and CIO gate to mandatory decision fields and enforcement tests.
- Ensure every public explanation can be reproduced from ledger/decision data; revise claims that are descriptive rather than guaranteed.
- Add documentation/version metadata to config epochs so historical trades are interpreted under the rules active at entry.

**Acceptance:** each material product claim maps to a test, field, and current code path; UI, API, docs, and ledger use the same taxonomy.

### P10 — Reduce configuration and flag interaction risk

**Work packet M: Active behavior manifest**

- Generate a versioned manifest of active flags, defaults, D1 overrides, dependencies, and the final behavior each path sees.
- Identify duplicate/obsolete gates and carve-outs; retire only after parity tests.
- Require one behavioral lever per experiment and record its config delta.
- Block PASS when an experiment changes admission, exit, and sizing simultaneously or cannot identify the active config hash.
- Produce a rollback recipe alongside every promoted flag.

**Acceptance:** an agent can reproduce the live-paper behavior from one manifest; no unknown override wins; each promoted result has an isolated causal delta.

## Multi-agent execution board

| Track | Primary scope | Depends on | Deliverable |
|---|---|---|---|
| Ledger truth | A, B, K event semantics | None | Reconciled event view, canonical IDs, quarantine rules |
| Config/enforcement | I, M | B provenance schema | Mandatory gate tests and active behavior manifest |
| Selection research | C, D, H | A, B, G foundation | Shadow admission challenger and calibrated EV contract |
| Timing/re-entry | J | B, H | Expected-move and re-entry shadow reports |
| Exit management | E, K | A, B clean data | Authoritative exit owner and clean ratchet replay |
| Validation/governance | G | A, B | Epoch scorecard and non-bypassable promotion gates |
| Product contract | L | B, I, M | Claim-to-code-to-ledger matrix and taxonomy alignment |

Each track must append its issue/PR, config hash, evidence window, and verdict to this document or a linked execution log. Parallel work is allowed only where dependencies are satisfied; no track may silently change another track’s lever.

## Global acceptance and stop rules

A behavior-changing promotion is blocked when any of the following is true:

- account and ledger do not reconcile or the cohort contains unquarantined invalid-price rows;
- candidate denominator or active config hash is unknown;
- reset/parity checks fail;
- the result depends on one winner or loses significance after reasonable costs;
- in-sample improves while holdout expectancy, SQN, or drawdown worsens;
- more than one of admission, management, and sizing changed;
- the changed path can be bypassed or another exit owner remains active;
- rollback is not immediate and tested.

A cohort can move from shadow to limited paper only with a predeclared sample policy, positive after-cost expectancy, PF at least 1.20, acceptable drawdown, outlier robustness, and a clean holdout. These are minimum governance gates, not guarantees of live profitability.


## Recommended execution order

> The **Execution charter** at the top of this document supersedes this list
> for slicing: only Slice 1 (A, B, F24 fix, I) is authorized now. The order
> below remains the long-run sequence once slices unlock.

1. **A + B:** reconciliation, status definitions, canonical IDs, price quarantine, and traceability.
2. **M + I:** active behavior manifest and proof that every admission path obeys the same gate.
3. **G + H foundation:** epoch-aware scorecard, candidate denominator, missed opportunities, and hard validation gates.
4. **C:** shadow admissions for ATH, Cloud Pivot, high-chop Speculative, and weak grade/regime cohorts.
5. **D:** selector consumes calibrated after-cost EV with uncertainty; verify rank monotonicity.
6. **J:** expected-move, opening-window, leg-maturity, and re-entry shadow experiments.
7. **E + K:** clean-data ratchet replay, structural stops, persistent protection, and one exit owner.
8. **L:** reconcile public claims and grade/holding taxonomy with executable behavior.
9. **F:** revisit sizing only after stable out-of-sample selection edge; do not reuse the failed conviction-sizing evidence as a promotion basis.

No agent should combine admission, exit, and sizing changes in one experiment.

## Private read-only follow-up required

A fully authoritative audit still needs authenticated read-only access to:

- current D1 trade-event and decision rows;
- active model_config and flag values;
- config epoch history;
- candidate/rejection logs;
- MFE/MAE and price-validation records;
- current play catalog/canonical IDs;
- live exit-owner traces.

When access is available, reconcile this plan’s public snapshot against those sources before any production change. Do not paste credentials into an issue, PR, document, or chat.

## Source map

### Live public sources

- `/timed/account-summary?mode=trader`
- `/timed/ledger/trades?status=WIN&limit=500`
- `/timed/ledger/trades?status=LOSS&limit=500`
- `/timed/ledger/trades?limit=1000`
- `react-app/proof.html`

### Repository evidence

- `docs/self-calibrating-loop.md`
- `tasks/2026-08-31-monthend-evolve.md`
- `tasks/2026-08-27-learning-loop-evolution.md`
- `tasks/2026-08-19-recent-book-review.md`
- `tasks/2026-08-15-july-st-autopsy-feedback.md`
- `data/reference-intel/cio-validation-v1.json`
- `data/reference-intel/validation-matrix-v1.json`
- `worker/pipeline/entry-selector.js`
- `worker/focus-tier.js`
- `worker/trust-spine/calibrated-edge.js`
- `worker/trust-spine/routes.js`
- `worker/edge-scorecard.js`
- `worker/trust-spine/scorecard.js`
- `worker/pipeline/lifecycle-seam.js`
- `worker/pipeline/tt-core-exit.js`
- `worker/pipeline/mfe-ratchet.js`
- `worker/pipeline/sizing.js`
- `worker/phase-c-loops.js`

## Execution log

Every packet PR appends one row here (or to a linked log) before merge. A
packet without a row is not done, regardless of code state. This file is the
tracking surface — there is no separate issue tracker for this program.

| Date (UTC) | Packet / Finding | PR | Config hash | Evidence window + snapshot | Verdict |
|---|---|---|---|---|---|
| 2026-09-04 | Plan authored + charter added | #1413, this PR | n/a (docs) | 2026-09-04 01:23:52 UTC pull | Plan accepted; Slice 1 = A, B, F24 fix, I |

## Financial and audit caveat

This is an engineering and model-governance analysis of a paper-traded ledger, not financial advice or a promise of future returns. Recent samples are small, correlated, and not adjusted for execution costs. All proposed policy changes are experiments with explicit evidence and rollback gates.
