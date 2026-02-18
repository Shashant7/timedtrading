# Site-Wide Cleanup — D1 Cost Optimization

## Phase 1: Remove Sparklines — DONE (2026-02-17)
- [x] Remove all sparkline backend code (routes, handlers, cron sections) from worker/index.js
- [x] Remove all sparkline frontend code (helpers, components, state, props) from index-react.html
- [x] Clean up sparkline references in shared-right-rail.js, brand-kit.html, faq.html, etc.
- [x] Delete `timed:sparklines` KV key from production

## Phase 2: Stop 1m Candle Writes — DONE (2026-02-17)
- [x] Delete the 1m candle D1 write block from the price feed cron (worker/index.js)
- [x] Update RTH price sanity check to use tf='5' instead of tf='1' (wider 15min lookback)
- [x] Update prev_close fallback to use tf='5' instead of tf='1'
- [x] Update missing-ticker fallback to use d1GetCandles(env, sym, "5", 1)
- [x] Remove "1" and "3m" from CANDLE_RETENTION_DAYS, increase 5m/10m to 90d, 60m to 180d, 240m to 365d
- [x] Disable AlpacaStream 1m bar buffer and D1 flush (alpaca-stream.js)
- [x] Remove "1" from CRON_FETCH_TFS, TD_SEQ_TFS, crypto TF_GROUPS, stock TF_LOOKBACK_MS, backfill startDates (indicators.js)
- [x] Remove 1m from chart TF dropdowns in shared-right-rail.js and shared-right-rail.compiled.js
- [x] Remove 1m from ticker-management.html TFS and TF_LABELS
- [x] Add one-time purge loop for all tf='1' and tf='3m' rows in data lifecycle cron
- [x] Update scoring comments to reflect 8 TFs (not 9)

## Phase 3: Optimize Bar Cron — DONE (2026-02-18)
- [x] Move bar cron from */1 to */5 virtual cron (index.js cron dispatch)
- [x] Extend bar cron to unified 4AM-8PM ET window via */5 9-23 + */5 0-1 virtual crons
- [x] D/W/M fetch gated to top-of-hour only in alpacaCronFetchLatest and alpacaCronFetchCrypto
- [x] Skip unchanged bars: conditional WHERE clause on D1 upserts (stock + crypto)
- [x] Crypto bar fetching moved before operating-hours gate for true 24/7 coverage
- [x] Tiered TF refresh: 5m/10m/30m/60m/240m every tick, D/W/M hourly only

## Phase 4: Retention Audit — DONE (2026-02-18)
- [x] Tiered candle retention: 5m/10m/30m=90d, 1h=180d, 4h=365d, D/W/M=forever
- [x] ingest_receipts: 7-day purge
- [x] timed_trail: 48h aggregate-then-purge
- [x] alerts: 90-day purge
- [x] model_predictions (resolved): 180-day purge
- [x] model_outcomes: 180-day purge
- [x] ml_v1_queue: 30-day purge
- [x] user_notifications (read): 60-day purge
- [x] trail_5m_facts: 180-day purge (rolls up into permanent trail_daily_summary)
- [x] Removed-ticker D1 purge across all tables (driven by timed:removed blocklist)
- [x] Expanded per-ticker KV cleanup: 25 key prefixes cleaned on removal + lifecycle cron
- [x] Deleted timed:sparklines KV key
- [x] Removed 14 tickers from SECTOR_MAP, restored GRNY

## Phase 5: User-Added Tickers — PENDING
- [ ] `user_tickers` D1 table
- [ ] Add/remove API endpoints with Alpaca validation
- [ ] Cron universe expansion (merge user tickers into scoring)
- [ ] Dashboard visibility and tier-based limits
- [ ] Immediate price display on add (pending state)

## Phase 6: Action Queue + Execution Visibility — DONE (2026-02-18)
- [x] Fixed `isNyRegularMarketOpen()` to delegate to calendar-aware version (holiday bug)
- [x] Fixed cron execution gate to use `isWithinOperatingHours` (holiday-aware)
- [x] `queued_actions` D1 table with schema + unique index
- [x] `d1QueueAction` / `d1ResolveQueuedAction` helper functions
- [x] PM/AH signal capture: entry, exit, trim, fuse-exit signals queued when blocked
- [x] `drainQueuedActions()` — re-evaluates pending actions at first RTH cycle
- [x] Drain wired into cron (runs once per day at market open, throttled by KV)
- [x] GET `/timed/queued-actions` API endpoint
- [x] `queued_actions` retention: 7d resolved, 24h stale pending
- [x] "New" kanban lane (between Enter and Hold) for `just_entered` tickers
- [x] Execution badges on cards: Entered $X / Trimmed Y% / Exited +/-Z%
- [x] "Blocked" badge on Enter/Setup lane cards (cooldown, smart gate, sector full, etc.)
- [x] Queued actions count in account summary row with hover tooltip
- [x] `useQueuedActions()` React hook for frontend
- [x] Discord notification on queue drain summary
