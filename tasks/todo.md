# Site-Wide Cleanup — D1 Cost Optimization

## Phase 1: Remove Sparklines — DONE (2026-02-17)
- [x] Remove all sparkline backend code (routes, handlers, cron sections) from worker/index.js
- [x] Remove all sparkline frontend code (helpers, components, state, props) from index-react.html
- [x] Clean up sparkline references in shared-right-rail.js, brand-kit.html, faq.html, etc.
- [ ] Delete `timed:sparklines` KV key post-deployment: `wrangler kv key delete --namespace-id=e48593af3ef74bf986b2592909ed40cb 'timed:sparklines'`

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

## Phase 4: Retention Audit — PENDING
- [ ] Review and adjust retention for model training (6-12 months)
- [ ] Purge stale D1 tables
- [ ] Clean up unused KV keys

## Phase 5: User-Added Tickers — PENDING
- [ ] `user_tickers` D1 table
- [ ] Add/remove API endpoints with Alpaca validation
- [ ] Cron universe expansion (merge user tickers into scoring)
- [ ] Dashboard visibility and tier-based limits
- [ ] Immediate price display on add (pending state)

## Phase 6: Action Queue (Extended Hours) — PENDING
- [ ] `queued_actions` D1 table
- [ ] PM/AH signal capture
- [ ] RTH open drain logic
- [ ] Dashboard notifications for queued actions
