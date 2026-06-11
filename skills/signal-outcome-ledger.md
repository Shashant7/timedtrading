# Signal Outcome Ledger — nothing published goes unassessed

**WHEN to use:** Adding any new user-visible signal/call (options play,
desk call, investor action, FSD-derived signal), debugging why a published
call has no grade, or building anything that consumes per-call track
records (Edge Scorecard, Scrimmage Room, proof surfaces).

## The principle

If the system publishes a call, the system grades the call. Before
2026-06-11, `options_play` was snapshotted onto entry alerts and never
resolved — "we call out options plays but never really assess them."
The ledger closes that loop for EVERY published call type.

## Where things live

- **Module:** `worker/signal-outcomes.js` — schema, `recordSignal()`,
  `optionsPlayToSignal()` (compact-play → signal adapter), pure
  `classifyDirectionalOutcome()` + `isSignalDue()` (pinned by
  `worker/signal-outcomes.test.js`), `resolveDueSignals()` (nightly),
  `summarizeSignalOutcomes()` + `listRecentSignalOutcomes()` (read API).
- **D1 table:** `signal_outcomes` (PK `signal_id`, idempotent INSERT OR
  IGNORE — writers fire-and-forget from hot paths).
- **Resolver:** runs FIRST in the 22:00 UTC nightly chain (before the CIO
  outcome backfill) in `worker/index.js`. Tombstone op:
  `signal_outcome_resolver`. Early-resolves on target/stop touch; horizon
  verdicts wait until due. Due-but-unjudgeable rows go `invalid` after a
  7-day grace.
- **Admin API:** `GET /timed/admin/signal-outcomes?days=90&limit=50&status=open`
  (requireKeyOrAdmin). `?run_resolver=1` forces a resolver pass.

## Current writers

| Signal | signal_id pattern | Horizon |
|---|---|---|
| Trader entry options play | `optplay:{trade_id}` | option expiry (4 PM ET ≈ 21:00 UTC) |
| Investor LEAP play | `optplay:inv:{position_id}:{ts}` | expiry, else 30d |
| Investor accumulate (entry) | `invaction:entry:{position_id}:{ts}` | 60d LONG |
| Investor trim/close | `invaction:{type}:{ticker}:{ts}` | 30d SHORT (good trim = price lower after) |

## Grading semantics (pinned in tests — change deliberately)

- First touch wins, judged on daily bar H/L: target → win/A, stop → loss/F.
- Both in one bar → conservative stop (loss/F).
- Horizon reached: options use the **underlying-proxy** (close beyond
  breakeven in direction → win/B, else loss/D — `resolve_note` says
  `*_underlying_proxy`); directional calls grade ±1% bands (B/C/D).
- We do NOT store historical option marks yet. If/when Alpaca option
  snapshots are persisted, deepen the resolver and re-grade — the
  `payload_json` keeps the full leg structure for exactly this.

## Adding a new writer (rules)

1. Build the row yourself or via `optionsPlayToSignal()`; ALWAYS set either
   `expiry_ts` or `horizon_days` (no horizon = never resolved = ledger rot).
2. `signal_id` must be deterministic-enough to dedupe retries of the same
   publication, unique across republications.
3. Fire-and-forget (`.catch(() => {})` / `queueBackground`) — never block
   a notification or entry path on the ledger.
4. Set `source` + `desk` + `vehicle` thoughtfully — they are the grouping
   dimensions for every consumer downstream.
