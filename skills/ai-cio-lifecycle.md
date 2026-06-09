# Skill — AI CIO Lifecycle Gate

## When to use this skill

You're adding a new "CIO consults on every X" hook (entry skip, trim, SL move,
exit, defend, etc.), OR an operator wants to flip a CIO lifecycle toggle
without redeploying, OR a CIO call site is misbehaving (timeouts, spend
overrun, bad overrides).

**Never call `evaluateCIOLifecycle()` directly from a hot path.** Always go
through `worker/cio/cio-lifecycle-gate.js` so you inherit the three
guardrails (latency cap, monthly $ cap, dedup, fallback, override logging).

## Prerequisites

- `OPENAI_API_KEY` set on the worker.
- `KV_TIMED` binding (used for spend counter + per-type stats).
- Operator with `model_config` write access for per-type flips.

## Add a new lifecycle hook (≤ 10 lines at the call site)

```js
import { cioReviewSlMove as _cioReviewSlMove } from "./cio/cio-lifecycle-gate.js";

// At the decision site (after the engine has made its proposal but BEFORE
// the side-effect fires):
const _cioRev = await _cioReviewRebalanceTrim(env, {
  sym: pos.ticker,
  direction: "LONG",
  currentPrice: price,
  position: pos,
  scoreData: data,
  bucket: "auto_reduce_score_drop",  // any short label for stats grouping
  getTickerProfile: (s) => getTickerProfile(s) || { profileKey: "?", label: "?" },
});
if (!_cioRev.proceed) {
  // CIO returned HOLD with edge_remaining above the threshold — skip the trim
  cioDeferredTrims.push({ ticker: pos.ticker, reason: "cio_hold", ... });
  continue;
}
```

The gate handles: timeout, spend tracking, dedup, fallback, override log
line, KV counter bump for `/timed/admin/ai-cio/lifecycle-stats`. You DO NOT
need to add any of that yourself.

### Helper functions (all in `worker/cio/cio-lifecycle-gate.js`)

| Helper | Engine default | CIO override condition |
|---|---|---|
| `cioReviewEntrySkip()`        | SKIP        | `cio_decision === "OVERRIDE"` AND `edge_remaining >= ai_cio_entry_skip_min_edge` (default 0.7) |
| `cioReviewRebalanceTrim()`    | PROCEED     | `cio_decision === "HOLD"` AND `edge_remaining >= ai_cio_rebalance_min_hold_edge` (default 0.6) |
| `cioReviewInvestorAccumulate()` | PROCEED   | same HOLD gate as rebalance trim — skips auto-rebalance add/open |
| `cioRecordInvestorLaneChange()` | RECORD_ONLY | audit when stage moves to accumulate/reduce |
| `cioReviewSlMove()`           | PROCEED     | `cio_decision === "HOLD"` (record-only by default — flip `ai_cio_sl_move_authoritative` to enforce) |
| `cioRecordDefend()`           | RECORD_ONLY | n/a — pure audit dataset |
| `cioLifecycleGate()`          | per-type    | generic wrapper if you need a new decision type |

When adding a new decision type, add it to `ENGINE_DEFAULT` in the gate
file, and to `getLifecycleGateConfig().types`, and to the MC card row list
in `mission-control.html` `CioLifecycleStatsCard`.

## Flip a toggle without redeploying

All toggles are `model_config` keys. Set them via:

```bash
curl -sX POST "$WORKER_URL/timed/admin/deep-audit-config?key=$ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"config":{"ai_cio_sl_move_enabled":"false"}}'
```

Effective on the next CIO call (per-isolate cache TTL is 5 min). For
emergency rollback flip the master:

```json
{"config":{"ai_cio_lifecycle_all_in_enabled":"false"}}
```

### All keys

| Key | Default | Purpose |
|---|---|---|
| `ai_cio_lifecycle_all_in_enabled` | true | Master kill — all types off when false |
| `ai_cio_entry_skip_review_enabled` | true | Loop 2 trip → CIO override path |
| `ai_cio_rebalance_trim_enabled` | true | Investor rebalance trim → CIO HOLD path |
| `ai_cio_rebalance_add_enabled` | true | Investor auto-rebalance add/open → CIO HOLD path |
| `ai_cio_investor_lane_change_enabled` | true | Investor stage reclass → CIO audit (record-only) |
| `ai_cio_sl_move_enabled` | true | SL trail move → CIO record |
| `ai_cio_defend_record_enabled` | true | DEFEND lane → CIO audit-only opinion |
| `ai_cio_sl_move_authoritative` | false | Flip SL gate from record-only to authoritative |
| `ai_cio_entry_skip_min_edge` | 0.7 | Min CIO confidence to override a Loop 2 skip |
| `ai_cio_rebalance_min_hold_edge` | 0.6 | Min CIO confidence to skip a rebalance trim |
| `ai_cio_lifecycle_timeout_ms` | 8000 | Per-call timeout cap (Promise.race) |
| `ai_cio_entry_timeout_ms` | 20000 | Entry CIO API AbortController timeout |
| `ai_cio_monthly_usd_cap` | 50 | Hard-stop spend cap; estimated per call |

Env-var equivalents (UPPER_SNAKE_CASE) work too — model_config wins on conflict.

## Verify a hook is firing

```bash
# Stats endpoint (per-type counts + spend)
curl -s "$WORKER_URL/timed/admin/ai-cio/lifecycle-stats?key=$ADMIN_KEY" | jq

# MC visual
# Mission Control → "CIO Lifecycle Coverage" card (above CioDecisionReview)

# Worker logs — every override prints this line
wrangler tail | grep AI_CIO_GATE
# [AI_CIO_GATE] override type=rebalance_trim sym=CRS bucket=auto_reduce_score_drop engine_default=PROCEED cio=HOLD record_only=false latency_ms=812 edge_remaining=0.72 reasoning="..."
```

## Common pitfalls

1. **Calling `evaluateCIOLifecycle()` directly from a new hook**. Always use
   the gate so cost + latency + stats stay consistent.
2. **Forgetting the `bucket` label**. Without it the stats endpoint can't
   distinguish trim-vs-event-risk-vs-doctrine. Always pass a short stable
   string.
3. **Not handling the engine-default fallback**. Every helper returns the
   engine default when the gate is off / capped / timed out. Your call
   site must still proceed sensibly.
4. **Adding a hook outside processTradeSimulation**. The gate needs `env`
   with `KV_TIMED` and `OPENAI_API_KEY`. If you're in a context that only
   has `tickerData`, use `tickerData._env`.
5. **Putting a CIO consult on the SL move hot loop without dedup**. The
   gate has built-in 60s per-(sym,type,bucket) dedup; you don't need to
   add your own. But DO NOT bypass the gate by calling
   `evaluateCIOLifecycle` directly — you'll burn $$.

## Investor CIO memory (research desk)

Investor lifecycle hooks (`rebalance_add`, `rebalance_trim`, `investor_lane_change`)
build memory via `worker/cio/cio-memory-loader.js` → `buildInvestorCioMemory()`.
That loader warms the same research-desk substrate trader entry CIO uses:

- CRO daily note (`timed:cro:latest`) — Layer 15c
- FSD tactical overrides (`cro:tactical_overrides`) — Layer 15b
- Per-ticker FSD pubs (`loadFSDIntelForTicker`) — Layer 15e
- CTO levels rollup, macro snapshot, engine pulse

Auto-rebalance preloads FSD intel for the top ~24 actionable tickers once
per cycle so accumulate reviews don't cold-start without desk context.

## Related

- `worker/cio/cio-lifecycle-gate.js` — gate source
- `worker/cio/cio-memory-loader.js` — investor / off-cron memory preload
- `worker/cio/cio-service.js` — underlying `evaluateCIOLifecycle()` + proposal builders
- `worker/cio/cio-memory.js` — memory builder (use slimmed-down memory for lifecycle calls)
- `tasks/2026-06-01-ai-cio-lifecycle-coverage-thoughts.md` — original design doc
- `tasks/lessons.md` "CIO 'all in' for lifecycle decisions" — pattern rationale
