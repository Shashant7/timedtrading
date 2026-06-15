# `worker/foundation/` — rebuild contracts (Phase 0)

Phase 0 of [`tasks/2026-06-14-foundation-rebuild-plan.md`](../../tasks/2026-06-14-foundation-rebuild-plan.md).

These modules define the **typed seams** the rebuild is organized around. They
are **pure, additive scaffolding** — nothing in the live worker imports them, so
they change **zero runtime behavior**. They exist to (a) lock the contracts in
code, (b) be unit-tested now, and (c) be the interfaces the Phase 1+ services
implement.

## The contracts

| File | Layer | What it guarantees |
|---|---|---|
| `series-contract.js` | L1 — candle chain | The single `SeriesView` shape every candle consumer reads. Carries explicit `coverage` + a `complete` flag computed against a calendar-supplied `expectedTimestamps` grid. `checkSeries()` is the consumer guard that REFUSES on an incomplete / too-short window. |
| `indicator-contract.js` | L2 — indicators | An indicator is a pure `bars[] -> value` + a declared `requires:{tf,minBars}`. `runIndicator()` enforces the SeriesView contract first and returns `{available:false, reason}` instead of computing on a short/gappy window. Never throws into the caller. |
| `score-contract.js` | L4 — score | `evaluateScore()` makes the score a formula with a **critical-input gate**: a missing/stale critical input ⇒ `UNSCORABLE` (value `null`), never a silent number. Non-critical bad input ⇒ `DEGRADED` (value still emitted, flagged). |
| `parity.js` | cross-cutting | `computeParityReport()` — the pure diff core that proves live ≡ replay on a golden day. Reused by the baseline runner and (later) the CI parity gate. |

## The parity baseline (the Phase 0 deliverable that needs real data)

The contracts + harness ship here and are tested with a synthetic golden-day
fixture (`__fixtures__/golden-day-sample.json`). The actual **baseline number**
— today's live-vs-replay divergence — must be produced against real data, which
should be done on **pre-prod or a local replay** so nothing touches live state:

```bash
node scripts/parity-baseline.js \
  --live   data/parity/2026-05-08-live.json \
  --replay data/parity/2026-05-08-replay.json \
  --date   2026-05-08
```

Each input is a map `{ "<TICKER>": { status, value, tier, components? }, ... }`
for the same as-of timestamp. The runner writes `data/parity/<date>-baseline.json`
and exits non-zero on divergence (so it can gate CI once the rebuild lands).

See the header of `scripts/parity-baseline.js` for how to export the two sides
without any live writes.

## Phase 1 — candle chain core (pure, tested; not yet wired live)

The chain's logic, built on the Phase 0 contracts. Pure and storage-agnostic —
a Durable Object wraps these with persistence later (see "staged" below).

| File | Role |
|---|---|
| `trading-calendar.js` | The "what bar SHOULD exist" source. US RTH sessions (DST-correct via `Intl`), holiday + half-day tables, and `expectedBuckets({tf,startMs,endMs})` — the calendar grid that feeds the SeriesView `coverage`/`complete` contract. This is what makes freshness *computable* instead of guarded. |
| `resample.js` | Deterministic OHLCV resampling: one 5m base → 10/15/30/60/240 (session-anchored), daily base → W/M. `o=first,h=max,l=min,c=last,v=sum`. Collapses 8 independent freshness points to 2; a 30m bar is always exactly its constituent 5m bars. |
| `candle-chain.js` | Ties it together: `ingestBase` (idempotent merge), `checkBaseIntegrity` (computed gaps + exact heal ranges — the single freshness point), `deriveAllTimeframes` (every TF as a SeriesView with an honest `complete` flag), `nextExpectedBucketMs` (calendar-driven ingestion cursor), `hotWindowStartMs` (bounded retention per §3.6). |

28 unit tests (calendar 12, resample 7, chain 9). Full suite green.

### Phase 1b — shadow reconcile + per-shard DO (done; DORMANT)

- **Shadow reconciler** (`scripts/candle-chain-shadow-reconcile.js`, read-only):
  validated on real pre-prod data that `resample(5m base)` reproduces the
  provider's bars — **100% OHLC match for 10/15/30m**; 60/240m differ only by
  anchor convention. See `tasks/2026-06-15-phase1b-shadow-reconcile-result.md`.
- **`candle-chain-shard.js`** — pure, storage-injected per-shard core: stable
  `shardForTicker`, session-chunked 5m + daily base, ingest/derive/integrity,
  and bounded `retentionSweep` (drops old session chunks → constant footprint).
- **`candle-chain-do.js`** — the `CandleChainShard` Durable Object (per-shard,
  single-writer), a thin adapter over the core using DO storage. Bound in
  `wrangler.toml` (migration v6, `new_sqlite_classes`). **DORMANT** — nothing
  schedules it; reachable only via `POST /timed/admin/candle-chain` (admin) or
  the `candleShardStub` helper. Validated end-to-end on pre-prod: ingest 78 real
  5m bars → derive complete 30m view → clean integrity.

### Staged next (needs operator review; touches the live ingestion path)
- R2 cold-storage offload for retention-swept 5m chunks.
- Calendar-driven ingestion scheduler feeding the DO from the live feed (behind
  the worker-role flag pattern), run in **shadow** beside the current per-TF
  store; prove zero gaps for K weeks via the chain's coverage report, then
  re-run the parity baseline and watch score/conviction divergence collapse.
- Pin the canonical 60m/240m anchor (shadow-reconcile follow-up).

## What this layer does NOT do yet

- No live wiring — nothing in `worker/index.js` imports these; runtime behavior is unchanged.
- No change to the current scoring/exit logic.
- No new freshness guard — the whole point is to design freshness in.
