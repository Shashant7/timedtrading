# Weekend Readiness — Juneteenth 2026 (markets closed)

Parallel work while **Tier A/B preprod replay** runs in tmux `move-replay-preprod`.

---

## Goal

When tier batching finishes, **immediately** aggregate reliability → L2 already passing on prod → shadow posture on payloads → Monday open validates forward path.

Downstream (post-shadow): Day Trader, Active Trader, Investor posture, levels, options context.

---

## Parallel tracks (this weekend)

| Track | Status | Action |
|---|---|---|
| **Tier replay** | Running (preprod) | `tail -f data/setup-mining/move-replay/run-tiered-preprod-*.log` |
| **L2 live wiring** | **Fix shipped** | Batch D1 sync now calls `maybePersistSetupEventsFromTick`; trail cadence 5m |
| **Deploy** | Required | tt-engine + monolith production after merge |
| **Fixture backfill** | Weekend | Seed `setup_events` from trail for parity tickers (markets closed) |
| **Aggregate script** | Ready | `node scripts/aggregate-tier-replay.mjs` after tiers done |
| **Shadow UI** | Next | Attach `trader_posture` / sequences to diagnostics + Today detail (no entry) |

---

## L2 fix (root cause)

Scoring cron wrote `ticker_latest` via **batch SQL** and skipped `d1UpsertTickerLatest`, so `setup_events` never persisted despite `SETUP_EVENTS_WRITE=1`.

**Fixed in** `worker/index.js`: batch sync now persists setup events before each D1 upsert. Trail cadence **10m → 5m** so two snapshot pairs fit the 15m parity window.

**Vars** (already in wrangler for production + tt-engine):

- `SETUP_EVENTS_WRITE=1`
- `SETUP_TRAIL_SNAPSHOT=1`

---

## After deploy — verify (weekend, no RTH needed for backfill)

```bash
# Backfill parity tickers from existing trail snapshots
node scripts/backfill-setup-events.mjs \
  --cohort fixtures \
  --wrangler-d1 production \
  --limit 30

# Or per ticker via API
# POST /timed/admin/setup-events/backfill?ticker=SPY&since=...&until=...&trailSource=snap

# L2 gate (Monday after 2+ scoring ticks, or after backfill)
TIMED_API_KEY=... node scripts/run-setup-parity-gate.mjs --live
```

---

## When tiers finish

```bash
node scripts/aggregate-tier-replay.mjs \
  --out-dir data/setup-mining/tiered-reliability
```

Review:

- Sequence stage at anchor (target: active sequence on high-ATR Tier A)
- Direction alignment (fix UP→LONG mapping if still misleading)
- Per-ticker / sector buckets for L4 cohorts

---

## Promotion ladder (Monday → live influence)

1. **L2 pass** on fixture tickers (SPY, QQQ, IWM, USO, GLD, XLE, NVDA, TSLA)
2. **Shadow payload** — `setup_sequences` + `trader_posture` on scoring output (read-only for entry)
3. **UI** — Today / Active Trader detail panel “Sequence (shadow)”
4. **Forward** — next Discovery export: flagged before move anchor?
5. **Entry gate** — `SEQUENCE_ENTRY_GATE=1` half-size on aligned high-ATR archetypes
6. **Horizons** — map posture to Day Trader cards, Active Trader lanes, Investor trim hints, level targets, options structure context

Non-negotiable: **no production entry/sizing from sequences until L2 + forward shadow pass.**

---

## D1 hygiene

- Tier replay on **preprod** only (not production marathon)
- Post-mining: optional purge `historical_replay` events + null old replay `payload_json` on prod if needed
