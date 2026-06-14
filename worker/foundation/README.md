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

## What Phase 0 does NOT include

- No candle-chain implementation (resample, DO-per-ticker, retention) — that is
  Phase 1.
- No change to the current scoring/exit logic.
- No new freshness guard — the whole point is to design freshness in (Phase 1+).
