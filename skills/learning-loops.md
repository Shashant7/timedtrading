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
   PnL > 0 (Support Bounce 2026-08-27: 20 / +$312). Auto-demote still
   fires if 30d turns red again.

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
| CIO | Restore a setup when 30d n≥12 and PnL > 0. Ack a block that is still severe. Escalate mixed windows. |
| COO | Nightly tier-1 apply of whatever is still pending and auto-eligible. |

KV report: `timed:learning-desk:latest`.
Admin: `GET /timed/admin/learning/desk`, `POST /timed/admin/learning/desk/run`.

## Operator queue

```bash
../node_modules/.bin/wrangler d1 execute --env production --remote timed-trading-ledger \
  --command "SELECT id, source, config_key, proposed_value, tier, status, note
             FROM learning_proposals WHERE status='pending' ORDER BY created_at DESC;"
```

Decide leftover escalations via `POST /timed/admin/learning/proposals/decide`.
Do not hand-write `model_config` unless healing a mangled key. To restore
Support Bounce immediately after deploy, either POST the desk run or
upsert `deep_audit_setup_demotion_TT Support Bounce_long` = `"allowed"`.

## Verify

- Loop 1 rollup: `npx vitest run worker/phase-c-loops.test.js`
- Catalog + Cloud Pivot: `npx vitest run worker/foundation/play-catalog.test.js worker/pipeline/setup-demotion.test.js`
- Bus hygiene: `npx vitest run worker/learning-proposals.test.js`
- Desk + heal: `npx vitest run worker/learning-desk-review.test.js worker/pipeline/setup-demotion.test.js worker/trust-spine/weekly-governor.test.js`
- Entry explain: `GET /timed/admin/entry-explain?ticker=...` shows
  `loop1_enabled`, `loop1_combos_with_opinion`, and the combo advisory.

Full evolution review: `tasks/2026-08-27-learning-loop-evolution.md`.
