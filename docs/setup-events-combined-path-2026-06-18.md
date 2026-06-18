# Setup Events Combined Path (2026-06-18)

Implements Tier 1 (legacy entry snapshots), Tier 2B (`setup_events` ledger),
and Tier 3 (backfill cohorts) from the Active Trader hardening plan.

---

## Tier 1 — Legacy `rank_trace_json` (exploratory only)

**Module:** `worker/foundation/setup-entry-snapshot.js`

- Parses `rank_trace_json.setup_snapshot` at trade entry
- Emits static entry events (TD prep, td9, PDZ, RSI extremes)
- Infers partial stage at entry (`promotion_safe: false`)

```bash
node scripts/mine-setup-sequences.mjs \
  --wrangler-d1 production \
  --analysis-mode legacy \
  --limit 50 \
  --out-dir data/setup-mining/prod-legacy-50
```

**Combined mode** (default with `--wrangler-d1`): legacy when `setup_snapshot`
exists, else `setup_events` D1, else `trail_5m_facts`.

```bash
node scripts/mine-setup-sequences.mjs \
  --wrangler-d1 production \
  --analysis-mode combined \
  --limit 50
```

---

## Tier 2B — `setup_events` ledger

**Modules:**

- `worker/foundation/setup-events-store.js` — schema, persist, load
- `worker/foundation/setup-events-route.js` — admin routes
- Migration: `worker/migrations/add-setup-events-table.sql`

**Enable writes** (shadow-only; no scoring/trade behavior change):

```bash
# wrangler secret or var on tt-engine / main worker
SETUP_EVENTS_WRITE=1
```

Events are appended from `d1UpsertTickerLatest` on each scoring tick when
the ticker payload changes (`deriveSetupEvents(prev, current)`).

**Admin routes:**

| Route | Purpose |
|---|---|
| `GET /timed/admin/setup-events?ticker=SPY&since=&until=` | Read event stream |
| `POST /timed/admin/setup-events/backfill?ticker=&since=&until=&dryRun=1` | Backfill one window from trail |

---

## Tier 3 — Backfill cohorts

**Script:** `scripts/backfill-setup-events.mjs`

| Cohort | Purpose |
|---|---|
| `fixtures` | Parity tickers (SPY, QQQ, IWM, USO, …) — signal truth validation |
| `trades` | Closed trade entry windows |
| `discovery` | MISSED moves from Discovery export — action-gap analysis |

```bash
# Parity fixtures (7-day trail window, local D1 insert)
node scripts/backfill-setup-events.mjs \
  --cohort fixtures \
  --wrangler-d1 production \
  --dry-run

# Discovery missed moves (export timed:move-discovery JSON first)
node scripts/backfill-setup-events.mjs \
  --cohort discovery \
  --discovery-file data/move-discovery.json \
  --wrangler-d1 production \
  --limit 50

# Mine missed-move sequences
node scripts/mine-setup-sequences.mjs \
  --cohort discovery \
  --discovery-file data/move-discovery.json \
  --wrangler-d1 production \
  --trail-source 5m \
  --limit 50 \
  --out-dir data/setup-mining/discovery-missed-50
```

Discovery misses have **no** `rank_trace_json` — trail/events backfill is required.

---

## Promotion gate

| Source | `promotion_safe` | Use for calibration |
|---|---|---|
| `legacy_entry_snapshot` | **false** | Exploratory cohort tables only |
| `trail_window` / `discovery_missed_trail` | **false** | Join coverage + coarse buckets |
| `setup_events_d1` (post parity) | **true** | Reliability + calibration after parity gate |

---

## Apply D1 migration (once per env)

```bash
cd worker
npx wrangler d1 execute timed-trading-ledger --env production --remote \
  --file=migrations/add-setup-events-table.sql
```
