# Immediate historical calibration — 2026-09-09

## Objective

Use existing history now to improve rank, entries and exits. A new 30-day
observation period is not a prerequisite for discovery, defect fixes or
historical validation. The user's latest instruction expands scope beyond the
setup audit and explicitly asks for retrospective signal calibration.

Base: main after merged setup PR #1444. Do not infer deployment from merge.

## Work plan

- [x] Inventory actual sources and recovered records; document partial access.
- [ ] Complete the admin export and remaining candle/universe history.
- [ ] Build or repair a local historical evaluation using only pre-decision
  features, a comparison population including failures, and untouched time folds.
- [ ] Evaluate rank ordering, entry timing and exit policy separately before
  combining them; use conservative execution and cost assumptions.
- [x] Correct the first-barrier grading defect and verify export boundaries.
- [ ] Implement empirically supported live ranking/entry/exit changes.
- [ ] Save all results, rejected hypotheses, limitations and next actions in PR.

## Current result and evidence

Actual data retrieved: **778 ledger rows**, the September 8 Discovery report
(**590 detected moves / 191 tickers**, with **500 serialized move rows**),
archived **362 enriched backtest trades / 211 missed moves**, and **46,830 unique
real OHLC candles across 33 ticker/timeframe pairs / 11 tickers** before access
review stopped the bulk download. This is partial retrieval of a much larger
existing dataset, not a statement that the remaining candles do not exist.

[Machine-readable inventory and source hashes](evidence/2026-09-09-historical-corpus.json).
The earlier ten-ticker fixture experiment was shelved without fitting a model.
No calibrated weights or PnL uplift are claimed in this iteration.

| Finding | Implication / action |
|---|---|
| H01: Existing ledger, Discovery and candle history are substantial. | Begin retrospective evaluation now. A new 30-day trial is not a prerequisite. |
| H02: Discovery reports 590 moves but serializes 500; capture join uses 100 trades; diagnosis examines 150 moves. | Report coverage explicitly. Obtain complete underlying records before computing population-level capture/driver lift. |
| H03: In-worker Discovery caps the universe at 200 and selects by absolute recent 21-day return. | This is outcome-conditioned discovery selection. Use point-in-time candidate/universe history and failed lookalikes for calibration; do not train only on big movers. |
| H04: Discovery capture uses trades whose entry falls near the move window; its SQL excludes trades entered before the scan window and statuses outside WIN/LOSS/FLAT. | The dashboard's missed rate is not a verified net tradable opportunity rate. Recompute trade overlap, entry eligibility and capture from full records. |
| H05: Moves overlap across 5/10/20/40-day windows and backtest arms can repeat the same trade. | Cluster ticker/move episodes; retain run/version identity; never treat duplicated arms/windows as independent evidence. |
| H06: Public ledger omits the entry signals and rank trace. Admin backtest run-trades returns both; debug/trades returns raw stored trade objects. | Export the actual inputs and inspect their timestamps/versions. Do not substitute today's signals, final position stops or aggregate rank correlation. |
| H07: The legacy scoring harness uses the timestamps of eventual MFE/MAE to infer first target/stop. | **Fixed in this change.** Grade the first observed barrier in sequence. Added target/stop timestamps and an incomplete-window flag; 5 regressions pass. |
| H08: Archived confirmation-stack research is already mixed: 49 held-out fired trades averaged −0.076% versus −0.124% baseline in its own June report. | Reuse its corpus and rejected hypotheses; do not present it as a newly validated profitable gate. Missing focus/EMA inputs and unsigned aggregate events are not proven independent confluence. |
| H09: Historical candle snapshots can contain zero volume, mixed session anchors, revised bars and still-open bars. | Verify price/volume, session and close-time availability against the actual trade before feature reconstruction. Missing and zero remain explicit. |
| H10: Admin key is absent; bulk GET approval was rejected despite repo evidence identifying the backend. | Exact export is ready below. This is an access blocker, not a data-scarcity argument or an observation-period requirement. |

The grading fix is confined to the research harness. Its fixed percentage
barriers and end-of-window return are not the production exit engine, a
cost-adjusted execution simulation, or a portfolio-return estimate. Do not use
this fix alone as validation of a live policy.

Previous complete findings remain in [rank drivers](2026-09-09-rank-driver-evaluation.md)
and [setups S01–S13](2026-09-09-setup-audit.md). Reconcile with those merged
semantic fixes before evaluating current behavior.

## Ready-to-run admin export

Source: [export-admin-research.py](../scripts/export-admin-research.py).
Preview the exact request list without a key or network access:

```bash
python scripts/export-admin-research.py --output /tmp/timed-research-admin --plan
```

Supply **TIMED_API_KEY as an environment secret**, never in a command argument,
URL, chat message, source file or GitHub secret-reading workaround. For Codex
cloud setup-only Secrets, select this PR branch and run the following in the
environment setup script while the secret is available:

```bash
python scripts/export-admin-research.py --output /tmp/timed-research-admin
```

The script leaves only exported data/manifest, not the key. Secrets are removed
before the agent phase in Codex cloud ([official environment documentation](https://learn.chatgpt.com/docs/environments/cloud-environment#environment-variables-and-secrets)).
This Work Mode session exposes no general secret-entry tool; configuring a
secret in another environment does not automatically inject it here.

The four initial GETs retrieve raw trades, cached Discovery, rank config and
TT setup config. Append `--run-id <exact-existing-run-id>` for each intended
backtest: it adds raw run trades (including entry signals/rank trace), run
metadata, pinned config, lifecycle events and direction-accuracy rows. A
response at its server limit is marked potentially truncated. Do not use
`GET /timed/admin/runs` as a strictly read-only discovery shortcut: it calls
`backfillMissingRunTradeCounts`. Use existing run manifests/IDs instead.

The origin is fixed to `https://timed-trading-ingest.shashant.workers.dev`,
verified in `react-app/_worker.js` and existing Discovery CLI configuration.
Key goes through curl stdin as X-API-Key, never argv; no redirects, alternate
origins, mutation routes or secret persistence. Six credential/destination
boundary tests pass. Raw admin data must stay outside the git checkout.

The candle exporter [export-historical-research.py](../scripts/export-historical-research.py)
uses paginated `asOfTs` GETs, records coverage/hashes and resumes checkpoints.
It must not be restarted in this session until the user explicitly authorizes
the backend request: automatic review twice rejected the bulk read on the
stated ground that private ticker metadata was sent to an unverified worker.
Repository verification was supplied and the rejection persisted. Browser
Google sign-in was separately rejected for lacking explicit sign-in approval;
no credentials were entered. An API key avoids needing Google sign-in.

## Immediate calibration sequence after access

1. Join the **complete intended ledger/backtest runs**, entry signal/rank traces,
   setup events and candle windows. Produce per-trade coverage with exact
   trade/run/code/config IDs. Distinguish missing fields from signals absent.
   Group repeated run arms and overlapping moves. Identify the point-in-time
   eligible universe, including rejected candidates and failed lookalikes.
2. Recompute the **actual canonical rank drivers** with pre-decision inputs.
   For every bonus/penalty, evaluate side, magnitude, age, missingness and
   contribution beyond its correlated signal family. Test removal as well as
   reweighting; no generic confluence count or automatic catalyst bonus.
3. Compare entries within setup+side and comparable regime/ticker cohorts:
   location only, actual trigger, independent confirmation, preceding sequence,
   extension, relative strength and timestamped catalyst/reaction. Evaluate
   independent support visits and pre-breakout contraction from S09–S12.
4. Hold the accepted entry set fixed to test exits: actual stop/target/trim
   order, giveback, early failed reclaim and structural invalidation. Then
   rerun entry+rank+exit together with identical capacity, sizing, cadence and
   fee/slippage assumptions. Count missed retained winners and new failures.
5. Freeze a small hypothesis list and chronological folds **before fitting**;
   purge crossing label/trade horizons and add ticker/block sensitivity. Past
   aggregate outcomes have already been inspected, so do not call the whole
   history an untouched holdout. A failed test is retained, not retuned and
   rebranded as new out-of-sample evidence.
6. Publish baseline/challenger net dollars, equal-risk expectancy, drawdown,
   tail loss, turnover, retained opportunity and trade-set differences, with
   sample sizes and uncertainty. Advance supported changes through existing
   learning_proposals and preproduction validation. No automatic deployment or
   arbitrary 30-day waiting requirement.

## Verification

- Full repository suite: **3,631 tests passed** across 329 files.
- Admin exporter: **6 Python tests passed** for destination, header/argv,
  redirect, failed-auth, reflected-secret and run-ID boundaries.
- CLI plan mode, Python compilation, JavaScript syntax and diff checks passed.
- No admin-key call was attempted and no fitted model or live policy changed.

## Research contract

Big-mover labels may be computed from future prices; predictor features may not.
Every candidate in the observed universe must be eligible for sampling before
its outcome is known. Executed trades alone measure the old policy's selected
subset. Adjacent observations and repeated replay arms are not independent
examples. Freeze splits and candidate hypotheses before reading holdout results.
Use fresh chronological checks, opportunity retention, downside, transaction
costs and trade-set differences. Do not call summed trade percentages portfolio
return or post-exit extrema executable exits.

Work is local/read-only until a concrete reviewable change is ready. No broker
actions, production replay, production configuration writes or deployment.

## Primary corpus: ledger, Discovery Moves and multi-timeframe candles

The user corrected the initial scope: there are over 600 historical/backtest
trades, Discovery Moves, and rich multi-timeframe candles. Use that system as
the primary research corpus. A small accepted-fixture sample cannot substitute
for the actual model's trades, missed opportunities, and failed lookalikes.

Retrieved: 778 ledger rows and the September 8 Discovery report (590 detected
moves, 191 tickers; 500 exported move rows). The report's capture join uses 100
trades and its diagnostic pass uses 150 moves. These are report limits, not
claims about how much history exists. Reconcile coverage before calibration.
Preserve distinct backtest runs/versions; deduplicate repeated trades across
arms and cluster overlapping mover windows rather than inflating sample size.

## Deferred fixture experiment

The ten-ticker fixture study was shelved before fitting. It is not included in
this PR and must not substitute for the real-data calibration above.
