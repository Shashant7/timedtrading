# Setup Mining Tier A+B Verdict — 2026-06-21

Preprod shadow replay complete. This document is the go/no-go read for
awakening sequence-aware entry signals.

## Cohort

| Metric | Value |
|---|---:|
| Total missed moves replayed | 211 |
| Tier A (`move_atr >= 8`) | 75 |
| Tier B (one move per ticker) | 136 |
| With active sequence at anchor | 202 (96%) |
| Payload health | 100% |

Artifacts: `data/setup-mining/tiered-reliability/aggregate-2026-06-21T21-15-35.{json,md}`

## Alignment verdict (missed moves)

After fixing UP/DOWN vs LONG/SHORT mapping and using **realized `move_pct` sign**
as ground truth (stored `direction` was stale on down moves):

| Bucket | N | Aligned | Opposed | No sequence | Alignment rate |
|---|---:|---:|---:|---:|---:|
| All | 211 | 132 | 70 | 9 | 65% |
| Tier A (`move_atr >= 8`) | 75 | ~47 | ~24 | 4 | ~66% |
| Tier B (`move_atr < 8`) | 136 | ~85 | ~46 | 5 | ~65% |

Dominant pattern: **`td_phase_mean_reversion_long` @ forming (stages 1–4)** —
195/202 sequenced moves. Of those, **129 aligned before up moves** and **66 opposed
before down moves** (MR-long leaning long into a down move = wrong-way tell).

Confirmed stage (5–7): 7 moves — 3 aligned, 4 opposed (mixed, small N).

Artifacts: `data/setup-mining/tiered-reliability/aggregate-2026-06-21T22-25-14.{json,md}`

### Captured vs missed (live trades, 2026-06-21)

`scripts/compare-captured-vs-missed.mjs` — 75 recent live trades vs 211 missed moves:

| Cohort | N | With sequence | Aligned | Opposed | Alignment rate | Win rate |
|---|---:|---:|---:|---:|---:|---:|
| Live captured | 75 | 12 (16%) | 12 | 0 | 100%* | 40% |
| Discovery missed | 211 | 202 (96%) | 132 | 70 | 65% | — |

\*All 12 sequenced captures were trade-direction-aligned (expected — entries are
directional). **63/75 captures had no sequence at entry** (sparse trail_5m / no
setup_events window). Among forming MR-long captures: **9 trades, 33% win rate**
(3W/6L) vs 129 aligned misses on up moves (awareness, not proof of edge).

Artifact: `data/setup-mining/captured-vs-missed/compare-2026-06-21T22-27-37.{json,md}`

### Interpretation for entry awakening

1. **Infrastructure is ready.** Trail snapshots, event derivation, sequence
   detection, and replay mining all work at scale (96% sequence yield on misses).
2. **Forming MR-long is ubiquitous before big moves** — both captured and missed.
   On misses it splits ~65/35 aligned/opposed with realized direction; on the
   small captured sample it always aligns with trade direction but **does not
   predict win rate** (33% WR on forming MR-long entries).
3. **Do not promote forming MR-long to entry** on missed-move evidence alone.
   Next test: **forward shadow + backtest harness lane** — replay discovery
   anchors through scoring and compare gate-fire rate on WIN vs LOSS trades.
4. **Watch / fade research lane:** forming MR-long opposed to HTF trend may
   become a "setup awareness" input (trim risk, delay entry, counter-trend
   watch) rather than a direct entry trigger.

## No-sequence moves (9)

| Ticker | move_atr | Notes |
|---|---:|---|
| ALLY | 5.31 | Sparse event window |
| GRNJ | 5.45 | Thin liquidity / trail |
| AVGO | 5.86 | Replay ok; sequence gap at anchor |
| IOT | 5.90 | Same |
| INTU | 7.17 | Near Tier A threshold |
| VSXY | 8.14 | Tier A boundary |
| ETHUSD | 8.06 / 9.0 / 11.41 | Crypto — 3 moves, no MR sequence |

## Promotion ladder status

| Step | Status |
|---|---|
| L2 fixture parity | Offline fixtures **pass**. Live gate **pending deploy** — `trail_snapshot_pairs: 0` on prod until `SETUP_SHADOW_STAMP` + */5 scoring ticks; raw trail backfill seeded D1 events locally (`--trail-source raw`) |
| Shadow payload on scoring | `SETUP_SHADOW_STAMP=1` stamps `setup_sequences` on D1/KV payload |
| UI Sequence (shadow) panel | Right rail SNAPSHOT + SETUP tabs (admin-gated) |
| Forward discovery validation | **In progress** — captured vs missed comparison run; backtest harness extension next |
| `SEQUENCE_ENTRY_GATE=1` | **Blocked** until L2 + forward pass |

Non-negotiable: no production entry or sizing from sequences until L2 +
forward shadow validates aligned capture.

## Commands

```bash
# Re-aggregate after new replay batches (refreshes alignment from move_pct sign)
node scripts/aggregate-tier-replay.mjs --out-dir data/setup-mining/tiered-reliability

# Captured vs missed comparison
node scripts/compare-captured-vs-missed.mjs \
  --missed-file data/setup-mining/tiered-reliability/aggregate-2026-06-21T22-25-14.json \
  --wrangler-d1 production --live --limit 75 --trail-source 5m --analysis-mode combined

# L2 backfill + gate
node scripts/backfill-setup-events.mjs --cohort fixtures --wrangler-d1 production --limit 30
TIMED_API_KEY=... node scripts/run-setup-parity-gate.mjs --live

# Dedupe replay summaries
node scripts/cleanup-move-replay-summaries.mjs
```
