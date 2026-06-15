# Freshness + coherence closeout (2026-06-15)

Closes the operator's 4-part request ("verify everything fresh; brief uses
pre-market prices; investor rebalance is coherent; PML refreshed hourly") plus
the TradingView webhook 401. All shipped to LIVE on branch
`cursor/track-b-active-trader-validation-cbcd`.

Deployed workers: monolith `timed-trading-ingest` (owns research slots today),
`tt-research` + `tt-engine` (share `../worker/index.js`, kept in sync per the
BINDING-PARITY rule). Full suite: **526/526 green**.

---

## q1 — Everything scored + up to date (DONE earlier this session)
Live freshness `stale 0 / 253`, `slo_ok:true`; scoring ~0.4 min old for 244
tickers; investor lane 257 scored. Active Trader + Investor lanes operate on
fresh chain-derived candles. Root cause of the prior entry stall (freshness
quarantine from a tt-engine binding gap + a cron read-overload) is fixed and
documented in `2026-06-15-entry-stall-root-cause.md`.

## q2 — Daily Brief / Predictions / Content uses fresh pre-market prices
Core indices were already session-aware; this pass fixed the remaining surfaces
(`worker/daily-brief.js`):
- **index-card % badge** read a non-existent field (`changePct`/`dp`) and
  silently dropped — now reads validateMarketData's `day_change_pct`.
- **open-position rows** (trader + investor) use `liveSpot/liveDayPct` (extended
  print outside RTH) via a new `marketOpen` arg; web read-time refresh computes
  `marketOpen` too.
- **cross-asset narrative** (crude/gold/TLT/VIX-futures) is session-aware so the
  AI prose doesn't anchor on yesterday's close pre-market.
Known residual (low priority): the earnings-watch ticker prices + the VIX-index
badge still read RTH close; the tradeable pre-market vol signal (VX1! futures)
IS now session-aware in both the macro strip and cross-asset.

## q3 — Investor Rebalance coherence
Added an **add-after-trim guard** (`worker/index.js` auto-rebalance): reads
`timed:investor:last-action` (written by the prior cycle) and skips an ADD on any
ticker trimmed within a cooldown (default 24h). This closes the cross-cycle
oscillation the same-run watch+exhaustion guard didn't cover (11am-trim →
2pm-add, and across days). Reversible via `INVESTOR_ADD_AFTER_TRIM_GUARD=off`;
window via `INVESTOR_ADD_AFTER_TRIM_COOLDOWN_H`.

## q4 — PML (CTO level map) extended-session hourly refresh
The map only refreshed nightly (22:00 UTC) + an FSD-coupled intraday lane
(~9am-7pm ET, indices + open positions only), so a surfaced mover that gapped
overnight kept a 24h-stale anchor until tonight. Shipped:
- New **`session` mode** in `cto-universe.js` = indices + open positions +
  currently-surfaced PML feed movers (≤`MAX_TICKERS_SESSION`=64). Surfaced names
  are flagged `extra` so they get the 1h TTL (refresh hourly) instead of 24h.
- `runCTOUniverse` accepts `surfaced[]`, uses the extra set for per-ticker TTL +
  a `session` wall-clock budget (90s), and still rebuilds the public feed.
- **Dedicated, ADDITIVE hourly lane** in `index.js` gated purely on ET hour
  (4am-8pm ET weekdays) — independent of the shared `0 14-23` virtual cron (which
  also gates the investor-rebalance + flash lanes), so widening the window cannot
  disturb those lanes. Reads the prior feed for the surfaced set; the 1h cache
  makes the overlap with the FSD lane near-free. Reversible via
  `PML_SESSION_REFRESH=off`. The `admin/cto/universe/refresh` route also accepts
  `mode=session` for manual triggering.
- Verified on LIVE: session refresh ran (8 indices + positions + 7 explicit
  movers = 18 tickers, merged 92, recomputed the movers, ~10s, no early stop).

Note on semantics: pivots/Fib/ATR magnets are PRIOR-DAY-anchored by design (they
don't move intraday until the next daily close); the session refresh re-anchors
the **current price + distance/hit tags** on the pre-/post-market print and keeps
the surfaced movers off the 24h cache. A deeper "blend live price into the daily
anchor" change was scoped but not shipped (it changes level math, not freshness).

## PML "computed date shows yesterday" (follow-up, 2026-06-15 ~22:40 UTC)
Two distinct issues behind the operator's report:

1. **Display bug** (`shared-rail-helpers.js` `resolveFeedAsOfLabel` + `shared-right-rail.js`):
   the daily anchor (`bar_as_of_ms` = 00:00 UTC of the trading day) was rendered in
   Eastern time, shifting a Jun-15 close to "Jun 14, 8:00 PM ET". Fixed: render the
   trading-day DATE in UTC via `formatAsOfDate` → "Jun 15, 2026 (daily close)".

2. **Real staleness — today's daily bar wasn't ingested after the close.** Daily
   levels (CTO/PML) AND scoring anchor on the latest CLOSED `tf='D'` bar in
   `ticker_candles`. The freshness monitor only heals daily bars **>5 days stale**
   (`STALE_D_DAYS=5`), runs only 9 AM + 3 PM ET, and nothing else fetched today's
   bar post-close. Verified at the data layer: at 6:30 PM ET Monday, live D1 had **no
   Jun-15 daily bar** for SPY/QQQ/IWM/DIA — the whole universe carried Friday's
   anchor. Recomputing levels hourly cannot advance the anchor without a fresh daily
   bar (pivots/Fib/ATR are prior-session structure — one set per trading day).

   **Fix** (`worker/index.js`): a post-close daily-`D` universe ingest lane — once
   per weekday session, 5–8 PM ET (bar is final), self-dispatches the same
   `alpaca-backfill` the Sunday W/M deep-refresh uses; verifies today's bar landed
   (SPY max D == ET date) before tombstoning (so a not-yet-final bar retries next
   hour); then force-refreshes the CTO session set so the map re-anchors immediately.
   The `*/5` scoring cron picks up the fresh D on its next tick. Idempotent per ET
   date; reversible via `POST_CLOSE_DAILY_INGEST=off`. One-time backfill run for
   tonight: **781 daily bars / 267 tickers, 0 errors**; indices now anchor on Jun 15.

## TradingView webhook 401 (shipped earlier this session)
`requireIngestKey()` (`worker/api.js`) accepts `TIMED_API_KEY` OR a dedicated,
independently-rotatable `TV_INGEST_KEY`, and ALWAYS allows `?key=` (TV can't send
headers). Swapped the TV ingest endpoints (`/timed/ingest`, `/timed/heartbeat`,
`/timed/ingest-capture`, `/timed/ingest-candles`). Operator action: update the TV
alert URL `?key=` to the current `TIMED_API_KEY`, or set `TV_INGEST_KEY` in the
dashboard and use that.
