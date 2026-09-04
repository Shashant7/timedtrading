# Current Ledger Audit and PnL Improvement Plan — 2026-09-04

**Status:** Audit complete; implementation not started  
**Scope:** Active Trader paper ledger and the model paths that select, size, manage, and attribute trades  
**Safety:** Read-only production review. No model, flag, configuration, ledger, broker, or deployment state was changed.  
**Primary snapshot:** Public ledger generated 2026-09-04 01:23:52 UTC; latest closed trade 2026-09-03 19:29:40 UTC.

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

## Recommended execution order

1. **A + B:** reconciliation, status definitions, canonical IDs, and traceability.
2. **G foundation:** epoch-aware scorecard and hard validation gates.
3. **C:** shadow admissions for ATH, Cloud Pivot, and weak grade/regime cohorts.
4. **D:** selector consumes calibrated EV with uncertainty.
5. **E:** verify ratchet/exit ownership and capture metrics.
6. **F:** revisit sizing only after stable out-of-sample selection edge.

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

## Financial and audit caveat

This is an engineering and model-governance analysis of a paper-traded ledger, not financial advice or a promise of future returns. Recent samples are small, correlated, and not adjusted for execution costs. All proposed policy changes are experiments with explicit evidence and rollback gates.
