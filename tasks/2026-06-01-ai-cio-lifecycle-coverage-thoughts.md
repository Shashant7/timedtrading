# AI CIO coverage — operator wants on for ALL lifecycle decisions

> Operator: *"My lean on AI CIO is to have it on for all trade lifecycle decisions, thoughts?"*

## TL;DR

**Recommended: yes, with three guardrails.** Turning CIO on for every lifecycle decision (entry + every trim + every exit + every SL/TP move + every defend / hold-vs-cut call) is a coherent next step, but needs:

1. **Latency budget**: cap each CIO call at ~1.5 s + fall back to engine default when over budget
2. **Cost ceiling**: monthly LLM spend monitor with a hard-stop env var (`AI_CIO_MONTHLY_USD_CAP`)
3. **Differential logging**: every CIO override (engine wanted A, CIO returned B) gets a tagged log line so we can see the override rate per decision-type after a week and tune the prompt

Without these guardrails the risk profile shifts from "smart sanity check at entry" to "single point of failure across the entire trade lifecycle."

## What's currently CIO-gated

| Decision | CIO gated? | Where |
|---|---|---|
| Entry (rank + tier passed, ready to fire) | ✅ since launch | `worker/cio/cio-service.js` `evaluateEntry()` |
| Trim execution (TP1 / TP2 / TP3 hits) | ✅ since PR #310-ish | `evaluateLifecycle()` PROCEED/OVERRIDE |
| Exit execution (SL hit, doctrine exit, force exit) | ✅ same path | `evaluateLifecycle()` STALL/EXIT branches |
| Defend / hold-vs-cut (DEFEND triggers) | ⚠️ partial — CIO sees the proposal but the doctrine layer can override CIO | `phase-c-exit-doctrine.js` |
| SL move (trailing, lock-in, peak-lock) | ❌ NOT currently CIO-gated | Fully mechanical |
| Auto-rebalance (Investor 11 AM + 2 PM cycles) | ❌ NOT currently CIO-gated | Pure rule-based |
| Entry skip (rank floor / doctrine block / Loop 2 trip) | ❌ NOT currently CIO-gated — engine just rejects | Pre-CIO gate |

## What "CIO on for ALL lifecycle decisions" means

In practice this means adding CIO reviews to the four currently-uncovered paths:

### A) SL moves (the biggest gap)

- Mechanical trailing stops can clip winners on whip noise. CIO sees the chart + recent action; can say "this is a healthy pullback to 21EMA, keep the stop wider."
- Cost: every SL move = ~1 LLM call per trade per management cycle. With ~10 open trades and trims every 1-2 cron ticks during RTH, that's ~50-100 calls/day on the SL-move path alone. Need a smart batching strategy — only consult CIO when the proposed SL move is > X% from the current SL (otherwise mechanical).

### B) Auto-rebalance (Investor)

- The 11 AM and 2 PM rebalance cycles open new positions and trim existing ones based on the scoring snapshot. CIO already runs on each NEW entry; what's missing is the TRIM half of the rebalance (when score drops a held position out of the Accumulate / Core Hold lane).
- Adding CIO here means: on each rebalance trim, CIO reviews "does the score drop reflect a real thesis change or a temporary regime shift?". Same prompt structure as Trader exit reviews; cheap.

### C) Defend / hold-vs-cut

- Currently the doctrine layer wins when CIO and doctrine disagree. Per PR #285, doctrine has the macro context to make this call. But CIO has the per-ticker memory.
- "CIO on for ALL" should mean **CIO opinion is recorded alongside doctrine** even when doctrine wins — so we can audit the disagreement rate and identify cases where CIO was right and doctrine was wrong (or vice versa).

### D) Entry skip / Loop 2 trip

- Engine rejects without consulting CIO. Adding CIO here means: when the engine WANTS to skip an entry, CIO gets a "review the rejection" call — should the engine have entered anyway?
- This is the highest-value addition because it directly addresses the "Loop 2 false alarm" failure mode. PR #428 made Loop 2 duration-bias-aware; adding CIO as a final override could catch the cases where even the duration-bias view misses something the LLM sees in the chart.

## Risks of going all-in

1. **Latency** — each CIO call is 800-2000 ms. Stacking them across SL moves + trims + exits on a single trade pushes total management latency past the worker CPU budget. The retry-with-backoff pattern in PR #433 mitigates one call; six in a row don't.
2. **Cost** — at ~$0.001 per CIO call (gpt-5.4) × ~500 calls/day across 10 open trades + entry sweeps = $0.50/day = $15/month. Cheap. BUT if we scale to 100 users with broker bridges, it's $1500/month. Need the cap.
3. **Single point of failure** — every decision through one LLM. An OpenAI outage takes down the entire lifecycle. **Hard requirement: engine default for every decision when CIO is unavailable**, with a tombstone-counter so operators see the rate.
4. **Auditability** — operator must be able to see WHY each CIO call returned what it did. The Decision Review panel in Mission Control already exists for entries; we'd extend it to every lifecycle event.

## Phased rollout proposal

If operator wants this:

**Phase 1 (next session)**: turn on CIO for **Investor auto-rebalance trim** decisions only. Low volume (twice daily), high signal-to-noise (clear "is this a real thesis change?"). Measures pattern + cost without affecting the high-frequency Trader management path.

**Phase 2**: extend to **SL moves > 1.5% of current SL distance**. Batches so we're not calling on every micro-adjustment.

**Phase 3**: extend to **entry-skip review** when Loop 2 trips. Gives the LLM a final say on the "is this a false alarm?" question.

**Phase 4**: extend to **defend / hold-vs-cut** with the rule "CIO opinion ALWAYS recorded, doctrine still wins on disagreement." Builds the audit dataset for tuning either side.

**Phase 5**: full coverage with the three guardrails (latency cap, cost cap, differential logging) in place.

Each phase is a single PR. Each is reversible via the `ai_cio_*` `model_config` keys we already have.

## What we'd need to add

- New `model_config` keys: `ai_cio_sl_move_enabled`, `ai_cio_rebalance_trim_enabled`, `ai_cio_entry_skip_review_enabled`, `ai_cio_defend_record_only`, `AI_CIO_MONTHLY_USD_CAP`
- Mission Control surface: per-decision-type CIO call count + override rate + monthly $ spend
- Slim down the CIO memory build for lifecycle calls — currently builds 16 layers; for an SL-move call we only need ~5 (ticker history, path performance, regime, ticker profile, engine pulse). Faster + cheaper.

## My recommendation

**Yes — start with Phase 1 next session.** The Investor auto-rebalance trim is the highest-value, lowest-risk addition. Measure the override rate for two weeks before committing to Phase 2. If CIO is overriding the engine more than ~20% of the time, the prompt or context needs tuning before going broader.
