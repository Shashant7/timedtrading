# Self-learning loops (do not re-analyze from scratch)

**WHEN to use:** Operator asks why the book is not adapting, why Loop 2
paused, whether to "enable learning", or a plan starts treating the
engine as if no feedback exists. Read live flags **before** writing a
new analysis checklist.

## The rule

The loops already exist. `learning_proposals` is the only apply bus.
Do not add a fourth apply path. Do not ship another static floor that
duplicates Loop 1 / the weekly governor.

## Live flags (query these, do not assume CONTEXT defaults)

```bash
cd worker
../node_modules/.bin/wrangler d1 execute --env production --remote timed-trading-ledger \
  --command "SELECT config_key, config_value, updated_by FROM model_config
    WHERE config_key LIKE 'loop%'
       OR config_key LIKE 'trade_review%'
       OR config_key LIKE 'deep_audit_setup_demotion%'
       OR config_key LIKE 'deep_audit_weekly_governor%'
    ORDER BY config_key;"
```

As of 2026-08-27 these were **ON** in production (May–Aug, not off):

| Loop | Flag | What it actually does |
|---|---|---|
| Loop 1 | `loop1_specialization_enabled=true` | Last-20 combo scorecard; now also a **setup × side** rollup (`__setup__:path:L`) because 4-way combos rarely hit `loop1_min_samples` (live=3). |
| Loop 2 | `loop2_circuit_breaker_enabled=true` | Hourly pulse; day-PnL / WR / consec-loss pause. Today's −8.58% trip was valid. |
| Loop 3 | `loop3_personality_management_enabled=true` | Personality-aware flat-cut / peak-lock / TP1 trim. |
| Trade Review | `trade_review_enabled=true` + auto_run + auto_apply | Grades closes. Auto-apply is only A/B wins and D/F losses. Grade C (LOCATION_WRONG / PREMATURE_*) waits. |
| Weekly governor | default ON | Heals + auto-demotes `SEVERE_BLEEDER_PATHS`. Writes `deep_audit_setup_demotion_*`. |
| Learning bus | `COO_AUTO_APPLY_TIER1=true` in wrangler | Tier-1 numeric ±10% nightly. Tier-2 waits. |

## Sensors → bus → gates (already built)

```
closed trade
  → Loop 1 KV scorecards (phase-c:scorecards)
  → Trade Review rows (trade_reviews)
  → nightly edge scorecard (timed:edge:scorecard)
  → weekly governor (heal plumbing / auto-demote / CIO restore)
  → submitProposal() → learning_proposals
  → learning desk (hourly CIO/CRO/CTO triage)
  → processProposals() (tier-1 auto / leftover pending only)
  → model_config → qualifiesForEnter / tt-core-entry
```

Sources that already `submitProposal`: edge_scorecard, weekly_governor,
discovery, autopsy_live, cio_authority, reversal_trim_advisor,
trade_review (only when a finding is `kind=config` and the review is
approved).

## Why a new family can bleed while "learning is on"

1. **Catalog-blind.** Governor + demotion keys come from
   `worker/foundation/play-catalog.js`. A live `setup_name` that is not
   a catalog id cannot be auto-demoted. Cloud Pivot was the Aug hole.
   **Sibling paths were the Sep hole (2026-09-20).** The scorecard rolls
   up by `canonicalPlayId`, which deliberately keeps
   `tt_cloud_pivot_long` distinct from `tt_cloud_pivot` so Loop 1 scores
   the paper leg on its own — but the sibling resolved to *no play*, so
   `isCalibrationPlay` was false (guard never fired), the key title-cased
   to `…_TT Cloud Pivot Long_long` (a key `checkSetupDemotion` never
   reads), and `parseDemotionKey` returned `play_id: null` (every
   high-confidence desk verdict is guarded on having an id). Result: two
   block proposals a week that were unprotected, inert **and**
   untriageable. Fix: `sibling_paths` on the play +
   `resolveGovernancePlay()`. **Use `resolveGovernancePlay` for role /
   auto-demote / demotion keys; `resolvePlay` only where scoring identity
   matters** — `findSetupStats` must stay on `resolvePlay`, or the long
   and short legs merge and hide which one is weak.
2. **Loop 1 too sparse.** Combo = setup × regime × personality × side.
   Exact keys rarely reach min samples. Use the setup rollup.
3. **Queue rot.** Edge scorecard re-proposes blocks that the governor
   already wrote. The hourly **learning desk** acks those
   (`already_in_effect`) so the operator queue is only low-confidence
   / debatable rows.
4. **Trade Review C-grades do not mutate.** Most Aug reviews are C /
   LOCATION_WRONG or PREMATURE_*. Those never reach `learning_proposals`.
5. **Heal used to re-block recovered setups.** Nightly heal now writes
   `enforce_paths` only. CIO restore writes `allowed` when 30d n≥12 and
   PnL > 0. Support Bounce is catalog **paused** (2026-09-10; 90d PF
   0.79) — a 30d-green restore must not unpause it. Auto-demote still
   fires if other mature bleeders turn red.
6. **New paper families are not mature bleeders.** Cloud Pivot's first
   print was 2026-08-24 at 0.1× paper. Auto-demote after ~10 closed
   losers is too blunt — the open book was still green. Catalog role
   `calibration` keeps Loop 1 / Trade Review / profit-lock on and
   keeps the governor off the pause button. The first refinement is
   making profit-lock see the ticket: live identity is `entry_path` /
   `setup_name` on the trade, never the current card score.

## Learning desk (CIO / CRO / CTO)

`worker/learning-desk-review.js` reviews pending `learning_proposals`
every hour on tt-research and again at 22:00 UTC **before**
`processProposals`. High-confidence verdicts execute on the existing
bus (`decideProposal` + demotion upsert). Only low-confidence rows
stay pending.

| Desk | High-confidence action |
|---|---|
| CTO | Ack already-live values. Reject mangled `TT Tt …` keys and recycled discovery notes (digit-stripped templates; ignore restamped `created_at`). |
| CRO | Reject / restore workhorse demotions (Gap Reversal). Approve `block_widen` when WoW is red. |
| CIO | Restore a setup when 30d n≥12 and PnL > 0. Restore a `calibration` family (Cloud Pivot) if someone wrote `blocked`. Ack a mature bleeder that is still severe. Escalate mixed windows. |
| COO | Nightly tier-1 apply of whatever is still pending and auto-eligible. |

KV report: `timed:learning-desk:latest`.
Admin: `GET /timed/admin/learning/desk`, `POST /timed/admin/learning/desk/run`.
Discord: `lane=system` (`#system-alerts`), title **Learning desk — operator
review**. Human setup names + next action (approve = pause, reject = keep
live). Routine noise (`recycled_discovery_note`, `already_in_effect`) is
omitted. Unchanged escalate sets are fingerprinted in
`timed:learning-desk:last-discord-fp` and not re-posted hourly. D1 apply
failures are infra retries, not trade escalates. If
`DISCORD_SYSTEM_WEBHOOK_URL` is unset on tt-research, notify falls back
to `#trade-signals` — set the system secret.

## Operator queue

```bash
../node_modules/.bin/wrangler d1 execute --env production --remote timed-trading-ledger \
  --command "SELECT id, source, config_key, proposed_value, tier, status, note
             FROM learning_proposals WHERE status='pending' ORDER BY created_at DESC;"
```

Decide leftover escalations via `POST /timed/admin/learning/proposals/decide`.
Do not hand-write `model_config` unless healing a mangled key. Do not
unpause Support Bounce from a 30d-green CIO restore (catalog status is
the hard stop). Cloud Pivot paper takes the 0–10 setup-grade floor;
do not catalog-pause the whole family to "act."

**Before deciding a block proposal by hand, check whether the desk can
decide it.** If a row is pending only because the key does not resolve,
fix the resolution and run `POST /timed/admin/learning/desk/run` — the
policy is already written (CIO rejects a block against a calibration
family). Both 2026-09-19 Cloud Pivot rows cleared that way, with no
operator override.

**And read the trades before accepting the verdict.** A per-leg PF is
not a per-family PF: those proposals quoted the long leg's PF 0.24 /
−$208.77, while the family across both legs was **+$46** and the short
leg +$255. The separator was not the side — it was whether the trim
fired: 27 trades that reached a trim were 92.6% WR at PF 14.83, the 19
that never did were 0-for-19. A leg that is PF 44.67 once it trims does
not have a setup problem, it has an exit problem. Sweep the counter-
factual with `scripts/cloud-pivot-loss-cap-calibration.mjs` (it reports
a worst case next to the modelled one, because the ledger stores no
price path and MFE/MAE ordering is therefore unknowable).

## Weekend review cadence

`npx vite-node scripts/weekend-trim-split-review.mjs --trades <d1-json>`
(query in the file header). Splits the 90d book by whether the trim
fired — the lens the nightly scorecard's single PF per family cannot
show. 2026-09-20 baseline: trimmed n=61 77% WR PF 3.27 (+$1,515),
untrimmed n=68 **5.9%** WR PF 0.01 (−$3,809), and every family the same
shape.

Read it as a diagnostic, not a verdict — "trimmed" partly means
"worked". The actionable half is its last section: **are the untrimmed
losses bounded?** Book-wide they are (median −1.99%, matching
`deep_audit_max_loss_pct normal:-2`), so do NOT ship a book-wide floor;
it would duplicate a cap that already works. A family clustered in the
past-−5% tail is the one missing a loss rule. On 2026-09-20 that tail was
5 trades: 4 Cloud Pivot (now capped) and 1 Range Reversal (already
blocked).

Always cross-check PnL against the live markers before proposing
anything. That weekend the three worst families (ATH Breakout −$945,
Range Reversal −$846, Support Bounce −$272) were **already blocked**, and
the only positive-PnL family with a real sample was Cloud Pivot (+$46) —
the one both proposals wanted to block.

Pass `--markers <d1-json>` (second query in the file header) and the
script does that cross-check itself instead of printing advice. Each
family/direction leg comes back as one of:

| Verdict | Meaning |
|---|---|
| `BLOCKED` | a live marker already holds it — do not re-propose |
| `CALIBRATION` | protected by role; PF is not a verdict here |
| `LOOK` | losing money with no marker — the actionable row |

It then runs an **inert-marker audit**: every marker is re-canonicalized
through `demotionProposalConfigKey`, and any key that does not
canonicalize onto itself is reported. That is the mechanical form of both
historical mangled-key bugs ("TT Tt Ath Breakout" in July, "TT Cloud
Pivot Long" in September). Production audited clean on 2026-09-20.

### Two follow-ups that came out of running it (2026-09-20)

**A display name could still mangle the key.** The sibling fix taught the
catalog the *path* `tt_cloud_pivot_long`, but the name map is keyed by
path, so the *display* string "TT Cloud Pivot Long" — which is what both
proposals actually stored as their `config_key` — still matched no entry
and fell through to the title-case fallback. `demotionProposalConfigKey`
now asks `resolveGovernancePlay` before giving up, so all four spellings
(path, display, sibling path, sibling display) land on the enforced key.

**A no-op proposal is still noise.** `submitProposal` dedupes *pending*
rows per (source, key), but a no-op applies immediately and leaves
`pending`, so the next run inserts a fresh one. The scorecard had stacked
seven identical "block TT ATH Breakout" rows (ids 82-88) against a family
already blocked. The bus now drops a proposal whose key already holds the
proposed value. The downstream `already_in_effect` clearer stays — it
still handles the race where the world changes after a row is filed.

## Verify

- Loop 1 rollup: `npx vitest run worker/phase-c-loops.test.js`
- Catalog + Cloud Pivot: `npx vitest run worker/foundation/play-catalog.test.js worker/pipeline/setup-demotion.test.js`
- Bus hygiene: `npx vitest run worker/learning-proposals.test.js`
- Weekend review: `npx vitest run scripts/weekend-trim-split-review.test.js`
- Sibling governance: `npx vitest run worker/foundation/play-catalog.test.js worker/pipeline/setup-demotion.test.js`
- Desk + heal: `npx vitest run worker/learning-desk-review.test.js worker/pipeline/setup-demotion.test.js worker/trust-spine/weekly-governor.test.js`
- Entry explain: `GET /timed/admin/entry-explain?ticker=...` shows
  `loop1_enabled`, `loop1_combos_with_opinion`, and the combo advisory.

Full evolution review: `tasks/2026-08-27-learning-loop-evolution.md`.
