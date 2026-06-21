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

On **missed** big moves, sequence detection fires reliably but **opposes**
the realized move direction in virtually every case:

| Bucket | N | Aligned | Opposed | No sequence |
|---|---:|---:|---:|---:|
| All | 211 | 0 | 202 | 9 |
| Tier A (`move_atr >= 8`) | 75 | 0 | 71 | 4 |
| Tier B (`move_atr < 8`) | 136 | 0 | 131 | 5 |

Dominant pattern: **`td_phase_mean_reversion_long` @ forming (stages 1–4)** —
195/202 sequenced moves. Confirmed stage (5–7) still 0% aligned (7 moves).

### Interpretation for entry awakening

1. **Infrastructure is ready.** Trail snapshots, event derivation, sequence
   detection, and replay mining all work at scale (96% sequence yield).
2. **Forming MR-long on misses is a counter-move tell, not a capture signal.**
   The model often sees early reversal energy *before* a large trend move —
   opposed to the direction that ultimately played out.
3. **Do not promote forming MR-long to entry** on missed-move evidence alone.
   Next test: **forward shadow** — did an *aligned* sequence appear before
   moves the system *did* catch or before fresh discovery anchors?
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
| Forward discovery validation | **Next** — not started |
| `SEQUENCE_ENTRY_GATE=1` | **Blocked** until L2 + forward pass |

Non-negotiable: no production entry or sizing from sequences until L2 +
forward shadow validates aligned capture.

## Commands

```bash
# Re-aggregate after new replay batches
node scripts/aggregate-tier-replay.mjs --out-dir data/setup-mining/tiered-reliability

# L2 backfill + gate
node scripts/backfill-setup-events.mjs --cohort fixtures --wrangler-d1 production --limit 30
TIMED_API_KEY=... node scripts/run-setup-parity-gate.mjs --live

# Dedupe replay summaries
node scripts/cleanup-move-replay-summaries.mjs
```
