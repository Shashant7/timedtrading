# Freshness Doctrine — the Data Age Contract

**WHEN to use:** Any work touching candle freshness, stale scores, quarantine
behavior, the `timed:freshness:summary` KV key, or "why is ticker X not
ranking / not entering / excluded from investor zones?". Read BEFORE adding
any new staleness check anywhere — the contract already exists; extend it,
don't fork it.

## The principle

**A stale input can never silently become a fresh-looking output.**

Before 2026-06-11, freshness was checked in spots (`__candle_data_stale` for
open positions, `trigger_stale`, sanity sweep) but a score computed from old
candles still wrote to `timed:latest`, still ranked, still fed investor
zones — the stale-investor-zone incident class. Now every scored payload
carries a graded `_freshness` block and downstream consumers act on it.

## The contract

- **Source of truth:** `worker/freshness.js` (leaf module, no circular deps).
  SLO table, grading, `isQuarantinedByFreshness()`, `buildFreshnessSummary()`.
- **Stamped where:** `computeServerSideScores()` (worker/indicators.js)
  attaches `_freshness` to every payload it assembles. Replay callers pass
  `{ asOfTs }` as the 5th arg → block is `mode: "replay", enforced: false`
  (diagnostic only — replay parity is never affected by quarantine).
- **Grades:** FRESH / AGING (soft SLO breach — usable, heal running) /
  STALE (hard breach = 2x SLO on a critical TF, or D/60 missing → quarantined).
- **Critical TFs:** D + 60 always; 30 + 10 during RTH. W/M/240/15/5 are
  recorded but only ever drive AGING.
- **SLOs are session-aware** (mirror the battle-tested open-position
  thresholds): RTH 10m≤30min / 30m≤45min / 60m≤2h / D≤48h-weekday;
  out-of-session intraday TFs relax to 96h (overnight + weekend +
  Monday-holiday gaps are NOT staleness — see tasks/lessons.md).

## What quarantine (live STALE) does

| Consumer | Behavior |
|---|---|
| `computeRank` (v1+v2) | capped at 10 (`_rank_freshness_capped`) |
| `qualifiesForEnter` | hard block, reason `freshness_stale` (not skippable) |
| `processTradeSimulation` | refuses to act (`__candle_data_stale` set on live STALE) |
| `POST /timed/investor/compute` | ticker excluded, reported in `skipped_stale_candles`, tombstone at >=25% |
| Scoring cron | targeted backfill in the SAME tick (budget 8/tick) |

## Heal + escalation chain

1. Scoring tick detects live-STALE → queues ticker for in-tick
   `DataProvider.backfill(env, [ticker], "all")` (max 8/tick, open positions
   naturally first since they score first).
2. Attempt counter `timed:freshness:heal:{ticker}` (TTL 6h). At >=2 attempts
   still stale → tombstone `freshness_quarantine_{ticker}` (skipDiscord;
   surfaces via watchdog/cron-status).
3. Recovery (stale last tick, not stale now) → counter deleted +
   `recordCronSuccess` heals the tombstone.

## One pane of glass

- Scoring cron writes `timed:freshness:summary` each tick
  (counts, p50/p95 ages per TF, stale list, worst offender, `slo_ok`).
- `/timed/health` exposes it as `freshness` — watchdog
  (`.github/workflows/watchdog.yml`, pages at >10 quarantined during RTH),
  `status.html` ("Data freshness" tile), and Mission Control
  ("FRESHNESS SLO" tile via `data_coverage.freshness`) all read this ONE
  block. Do NOT add bespoke freshness endpoints.

## Inspecting / debugging

```bash
# Universe summary
curl -s https://timed-trading.com/timed/health | jq .freshness

# Per-ticker block
curl -s "https://timed-trading.com/timed/latest?ticker=DELL" | jq ._freshness

# Heal attempt counter (see skills/kv-inspection.md)
wrangler kv key get "timed:freshness:heal:DELL" --binding KV_TIMED
```

## Rules when extending

1. New freshness check needed? Add the TF/threshold to `worker/freshness.js`
   and its test (`worker/freshness.test.js`) — never an inline age check.
2. New downstream consumer? Call `isQuarantinedByFreshness(payload)` —
   never read `_freshness.grade` directly (the helper owns the
   enforced/replay semantics).
3. Changing an SLO? Update the module AND the pinned test AND this skill.
4. Replay must stay parity-safe: anything acting on freshness MUST go
   through the helper so `enforced: false` blocks are ignored.
