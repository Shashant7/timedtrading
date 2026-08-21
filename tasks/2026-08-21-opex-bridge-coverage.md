# OpEx bridge coverage + flat-book DD shadow trip (2026-08-21)

## Alerts (09:00 ET)

1. **Sanity Sweep fail** — `investor_signal_bridge_coverage`
   2 model-side investor SELLs in 6h with no matching `bridge:client:recent`
   entry: `PLTR(PRE_OPEX_RISK_REDUCTION)`, `PNC(PRE_OPEX_RISK_REDUCTION)`.
2. **Portfolio risk breaker — SHADOW trip** — 28.26% DD from a $139,392.28
   20-day high, equity $100,000, 0 open positions. Not enforcing.

Today is monthly OpEx Friday. Auto-rebalance wrote 17 PRE_OPEX SELLs at
10:04 ET; the last two (PLTR, PNC) never reached `pushRing`.

## Root causes

- Event-risk **does** call `_bridgeMirrorInvestor` (not the KO 2026-07-27
  missing-call bug). 17 parallel `waitUntil` mirrors (up to 28s, Webull
  2 req / 2s) — isolate teardown dropped PLTR + PNC before the ring write.
- Ring stored only `parsed.rh_order_id`. Live Webull successes often have
  `order_id` / null `rh_order_id`, so catch-up `lotAlreadyMirrored` missed
  already-ok trims, filled `max_ops: 8` with retries, and never reached PLTR.
- Coverage is ±15 min, no last-signal-wins. PNC's 17:05 invalidation flatten
  did hit the ring; the 14:04 PRE_OPEX lot still paged.
- DD shadow trip is working on the math (20-day high vs start-cash equity)
  but pages a breaker that has nothing to cut when the book is flat at
  start cash. Do **not** enable `portfolio_dd_breaker_enabled`.

## Fixes

- Enqueue auto-rebalance mirrors; drain in one `waitUntil` at concurrency 2.
- Parse + persist `order_id` / `broker_order_id` / `deduped` on the ring.
- Catch-up: real place = ok + broker id, or legacy ok+200 without `deduped`.
  Sort sells/exits first; raise COO/hourly `max_ops` 8 → 24.
- Coverage: last-signal-wins per position; later catch-up ring heals.
- `RING_MAX` 50 → 200.
- Portfolio DD: no trip / no Discord page when `open_count===0` and equity
  is within 2% of start cash (`flat_book_at_start_cash`).
- Live remediations: force catch-up PLTR only. PNC already flattened.

## Files

- `worker/broker-bridge-client.js`
- `worker/investor-catchup-run.js`
- `worker/sanity-sweep.js`
- `worker/portfolio-risk.js`
- `worker/index.js` (auto-rebalance drain + hourly max_ops)
- `worker/coo/coo-orchestrator.js`
- tests + `skills/broker-bridge.md` + CONTEXT / lessons
