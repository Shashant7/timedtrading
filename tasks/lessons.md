# Lessons Learned

> Update after ANY correction from the user.
> Review at session start. Ruthlessly iterate until mistake rate drops.

---

## Deployment & Infrastructure

- **Deploy worker to BOTH environments**: `cd worker && npx wrangler deploy && npx wrangler deploy --env production`. Both crons can fire from either. Deploying only one leaves stale code running. [2026-02-11, reinforced 2026-02-18]
- **Two deployment targets — Worker (wrangler deploy) + Pages (git push)**: Static files served by Pages (auto-deploy on push). API by Worker. Changing right rail JS requires both. Always update `?v=` cache busters. [2026-02-11]
- **Always recompile shared-right-rail.js after editing**: Run `node scripts/compile-right-rail.js` from project root. Update cache buster on `<script>` tags afterward. [2026-02-18, 2026-02-19]
- **Worker routes go through `/timed/*` prefix on custom domain**: New endpoints (including WebSocket) must use `/timed/` prefix. [2026-02-11]
- **Worker ROUTES array must include new endpoints**: Add to both `ROUTES` array AND handler section, else `not_found`. [2026-02-11]
- **CF Access blocks WebSocket upgrades on custom domains**: Connect WS to `workers.dev` subdomain to bypass Access. Safe for broadcast-only data. [2026-02-11]

## D1 / Database

- **D1 has 1000 subrequests per Worker invocation**: Use `db.batch()` (max 500 per call) for bulk reads and writes. [2026-02-09]
- **D1 batch reads save 10x subrequests in scoring crons**: Batch all TFs per ticker in one call. Also batch trail writes. [2026-02-09]
- **D1 schema migrations need fallback handling**: ALTER TABLE can be throttled. SELECT/INSERT must not reference new columns until confirmed. Use fallback INSERT without the column. [2026-02-07]
- **D1 schema throttle (24h KV cache) can prevent table creation**: Probe with `SELECT 1 FROM table LIMIT 1` before relying on throttle. If fails, force creation. [2026-02-12]
- **ALTER TABLE for new columns alongside CREATE TABLE**: New column in CREATE TABLE only helps fresh DBs. Existing DBs need ALTER TABLE fallback (wrapped in try/catch for "column already exists"). [2026-02-19]

## Alpaca API

- **Alpaca uses BRK.B not BRK-B**: Dot format. One bad symbol fails entire batch. [2026-02-08]
- **Alpaca multi-symbol `limit` is TOTAL not per-symbol**: Use `limit=10000` + pagination. [2026-02-09]
- **One bad symbol fails entire Alpaca batch**: Filter out futures, indices, dashes before API calls. [2026-02-09]
- **Alpaca multi-symbol bar pagination can truncate later tickers**: Verify coverage dates per ticker, re-run short ones with smaller batches. [2026-02-11]
- **Alpaca prevDailyBar.c = priority 1 for prev_close**: Always correct. D1 candles only fallback for non-Alpaca tickers (futures). [2026-02-18]
- **Alpaca latestTrade can be stale AH trade**: If >5min old and >0.5% from quote midpoint, use midpoint instead. [2026-02-10]
- **Alpaca `1Month` timeframe gives accurate monthly OHLCV**: No need to derive from daily candles. [2026-02-08]
- **Validate custom tickers via Alpaca snapshot before adding**: Check SECTOR_MAP first, then probe Alpaca — 404 = doesn't exist. [2026-02-19]

## Price Feed & Data Pipeline

- **DO should own the price pipeline, not the cron**: AlpacaStream DO seeds from REST on `/start`, subscribes to trades, computes changes inline, flushes via alarm. Cron becomes ~50 lines. [2026-02-19]
- **DO wildcard trades corrupt KV daily-change data**: Only full-update seeded symbols (those with prevClose). Partial (price-only) update for non-seeded. Shrink guard to prevent data loss. [2026-02-19]
- **Stream freshness must be checked by timestamp, not count**: Check newest `t` timestamp. If >10min stale, skip stream, use REST snapshot. [2026-02-18]
- **pcEqP guard must merge prices, not skip the write**: Merge fresh `p`/`dh`/`dl`/`dv` while preserving old `pc`/`dc`/`dp`. Always push via WS. [2026-02-18]
- **KV price objects use short keys (`p`, `pc`, `dp`, `dc`)**: Not `price`, `prevClose`. Common source of bugs. [2026-02-12]
- **Every price source should build candles**: TV, Alpaca, heartbeats — all upsert 1m candles with merge semantics. [2026-02-09]
- **Single source of truth: getDailyChange in shared-price-utils.js**: All pages use the shared utility. Never inline stale versions. [2026-02-10, 2026-02-11]
- **Enrich /timed/all with timed:prices KV for consistent initial load**: Read timed:prices after heartbeat overlay, merge _live_* fields. [2026-02-10]
- **Price feed fallback for tickers missing from Alpaca**: Backfill from D1 latest 1m candle or KV `timed:latest`. [2026-02-10]
- **Scoring cron "no change" skip must still refresh ingest_ts**: On skip path, update `ingest_ts` and `ingest_time` on existing object. [2026-02-18]
- **Scoring skip path must update ingest_ts**: Set on both skip and success paths so UI shows "last checked" not stale date. [2026-02-12]
- **Guaranteed freshness via freshness heartbeat**: Price feed merges `price`/`prev_close`/`day_change`/`ingest_ts` into `timed:latest` every minute. [2026-02-12]
- **prev_close from D1: use trading-day cutoff and row-with-max-ts**: Don’t use “second row” or “last 2 calendar days” from daily candles — gaps/UTC vs ET can pick the wrong bar (e.g. AEHR showing prior day’s close). Use `ts < nyWallTimeToUtcMs(currentTradingDayKey(), 0, 0, 0)` and select the close from the row with `MAX(ts)` per ticker (CTE with `ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC)`). Same for KV snapshot overlay, D1 gap-fill, and heartbeat pcCache. [2026-02-19]
- **Price flicker during RTH: AlpacaStream + frontend**: AlpacaStream DO was flushing to PriceHub every 1s → UI updated every second. Fix: (1) AlpacaStream alarm interval 5s during RTH/AH/PRE (was 1s). (2) Frontend only apply WS price update if change ≥ 0.05% to ignore tick noise. [2026-02-20]

## Trade Simulation & Execution

- **Don't block gold_short entries with direction mismatch**: Gold SHORT is intentional mean-reversion. 82.7% of big DOWN moves start from BULL state. [2026-02-06]
- **Don't use below_trigger exit on tiny price dips**: Require >=0.3% adverse move. Sub-0.3% is noise. [2026-02-06]
- **Live entries MUST use current market price**: Not stale `tickerData.entry_price` from hours/days ago. Log warnings when divergence >1%. [2026-02-10]
- **RTH entry cutoff is 3:59 PM, not 4:00 PM**: `mins < 960` (exclusive). [2026-02-09]
- **Trade management needs RTH guards, not just weekend guards**: Only SL breach, max-loss, and TP-hit trims allowed outside RTH. [2026-02-11]
- **Set `exit_ts` on ALL exit code paths**: Both main EXIT handler and `closeTradeAtPrice`. [2026-02-09]
- **$0 P&L trades should be FLAT, not WIN**: Use `> 0 ? "WIN" : < 0 ? "LOSS" : "FLAT"`. Add flat-price exit guard (>0.1% move required). [2026-02-10]
- **Trades with $0 exit price must not count P&L**: Detect `isClosed && rawExitPrice <= 0` → show "ERROR" badge. [2026-02-19]
- **trimTradeToPct zombie prevention**: Early exit if `oldTrim >= 0.9999`. Check after accumulation. Guard all management paths. Auto-fix in `processTradeSimulation`. [2026-02-18]
- **Indicator completion != position completion for TRIM**: Use position-aware `(currentPrice - entryPrice) / (TP - entryPrice)`. 30-min + <3% guard for new positions. [2026-02-10]
- **Replay must enforce same cooldowns as live mode**: In-memory `execStates` Map via `replayBatchContext`. Check `exit_ts` not just `entry_ts`. [2026-02-10]
- **Replay cleanSlate must purge D1, not just KV**: `db.batch()` DELETEs for all trade-related tables. [2026-02-10]
- **Candle-replay trades must persist to D1, not just KV**: KV is overwritten by next scoring cron. Always `d1UpsertTrade`. [2026-02-09]
- **TP/SL must use same direction as trade direction**: Use `swingConsensus.direction` not `htfScore >= 0 ? 1 : -1`. Compute consensus early in `assembleTickerData`. [2026-02-19]
- **Smart concentration gates > hard position limits**: Sector cap (5/sector), directional cap (12/dir), correlation guard. Daily entry limit (10) as safety net. [2026-02-10]

## AI Chat, Market Pulse & Discord (Compliance & Plain Language)

- **AI prompts must include legal/compliance guidance**: System and Market Pulse prompts include a LEGAL & COMPLIANCE section: no personalized investment advice, no buy/sell recommendations, frame as educational only, include or imply "Not financial advice. For informational and educational purposes only. Past performance does not guarantee future results. All trading involves risk of loss." [2026-02-20]
- **Plain language for limited-technical users**: Prompts instruct the model to translate jargon (Rank → setup quality score, RR → potential gain vs. risk, Phase/Completion → where the move is in its cycle / how much has already happened). Lead with a short thesis, then simple analysis and guidance. Market Pulse format: thesis first, then opportunities/warnings in natural language, not canned templates. [2026-02-20]
- **Trading Assistant UI disclaimer**: Chat panel shows a small italic line under the input: "Not financial advice. For informational and educational purposes only. All trading involves risk." [2026-02-20]
- **Discord embeds**: All trade/kanban/investor digest embeds use a footer that includes "Not financial advice". Descriptions already use human-readable phrasing (e.g. "Hit the stop loss", "Entry Signal", "Taking Profit"). [2026-02-20]

## Kanban & UI

- **Kanban lanes must separate signal quality from execution readiness**: `qualifiesForEnter()` = signal quality. Execution gates = Stage 2. Show SETUP (not ENTER) when blocked. [2026-02-10]
- **Read-time recompute must CLEAR stale block reasons**: Delete `__entry_block_reason` and `__execution_block_reason` when no block. [2026-02-11]
- **/timed/all must re-classify "enter" stages**: Don't short-circuit — always run through `classifyKanbanStage`. [2026-02-10]
- **Trade lifecycle: pass open position context to classifyKanbanStage**: Frontend AND server read-time recompute need position awareness. [2026-02-10]
- **Execution badges only for open trades**: Guard with `hasOpenTrade` check. [2026-02-18]
- **Exit badges must expire**: Only show if exited within 48 hours. [2026-02-19]
- **Block reasons irrelevant on Setup cards**: Only show on Enter/Enter Now cards. [2026-02-18]
- **System Guidance: kanban-stage-first, not price-level-first**: Check stage before price conditions. Use `kanban_meta.reason`. [2026-02-12]
- **Card entry_price priority**: Prefer `openTrade.entryPrice` (trail-corrected) over `t?.entry_price` from scoring snapshot. [2026-02-10]
- **Right rail overlay must use opaque background**: No transparent overlays over dashboard. [2026-02-08]
- **Admin-gate live market data for legal compliance**: Hide prices/changes from non-admin users. [2026-02-19]

## Learning Loop & Model

- **New scoring fields need backward-compatible gates**: Check `d?.field != null` before gating. Old KV data won't have new fields. [2026-02-07]
- **Pattern integration should boost, not gate**: Pattern match enhances but never blocks entries. [2026-02-08]
- **Model features must include all signal sources**: New indicators → feature vector + prediction triggers + outcome tracking. [2026-02-08]
- **Learning loop config pattern**: `model_config` key → load with TTL cache → inject into scoring → retrospective updates weights. Applied for `consensus_tf_weights`, `scoring_weight_adj`, and now `consensus_signal_weights`. [2026-02-19]
- **Signal weights flow**: `getLearnedSignalWeights(env)` → `_signalWeights` in scoring cron → `assembleTickerData` opts → `computeSwingConsensus` 4th param → `computeTfBias` applies per-signal weighting. [2026-02-19]
- **Trail data drives model analysis scripts**: `timed_trail` not `ticker_candles`. Need weeks/months of trail data for meaningful recalibration. [2026-02-10]
- **Pattern library Phase 1 findings**: Top bullish: ST Flip + Bull (64.5%), EMA Cross + Rising HTF (70.4%). Top bearish: Squeeze Release in Bear (65.5%). Most predictive: squeeze_releases (-33.7% lift toward DOWN). [2026-02-11]

## Account & Auth

- **Account values from single server-side ledger**: `account_ledger` D1 table. `GET /timed/account-summary` for all dashboards. [2026-02-12]
- **Role-based access: page-level vs feature-level**: `requiredTier="admin"` on AuthGate vs `user.role === "admin"` conditionals. [2026-02-12]
- **CF Access sign out requires redirect to logout endpoint**: Not just `clearSession()` + reload. [2026-02-10]
- **Never redirect to `/cdn-cgi/access/login` from client-side**: Use cache-busted page navigation instead. [2026-02-12]
- **Stale admin roles need demotion**: Demote in `/timed/me` if email doesn't match `ADMIN_EMAIL`. [2026-02-19]

## Ticker Management

- **Keep SECTOR_MAP in sync across files**: Worker inline SECTOR_MAP (index.js) AND sector-mapping.js. Add to both. [2026-02-10]
- **timed:removed blocklist persists after manual SECTOR_MAP additions**: Must clean via watchlist/add endpoint or manual KV cleanup. [2026-02-11]
- **Backfill scripts should filter to active tickers**: Fetch `/timed/tickers` at startup, not full SECTOR_MAP. [2026-02-11]
- **Backfill default for new tickers: 30 days**: `sinceDays=30` for watchlist add. [2026-02-10]
- **Re-added tickers need ticker_latest row**: Upsert minimal row so `/timed/all` returns it. [2026-02-10]
- **Ingestion-status must include all watchlist tickers**: Build from canonical list, include 0% coverage rows. [2026-02-10]
- **Coverage metrics must check data QUALITY, not just row count**: Factor freshness, gap detection, count. [2026-02-09]

## Frontend / Build

- **Compiled JS must match source format**: Pre-transpile for `<script>`, or use `type="text/babel"` for JSX. [2026-02-08]
- **Batch KV reads with Promise.all**: Never sequential awaits in loops. Collect then `Promise.all` in batches of 50. [2026-02-12]
- **React onWheel is passive — use native addEventListener**: `el.addEventListener("wheel", handler, { passive: false })`. [2026-02-11]
- **Drag-to-pan needs window-level mouse tracking**: Attach `mousemove`/`mouseup` on `window`. [2026-02-11]
- **SVG non-scaling-stroke unreliable with preserveAspectRatio="none"**: Use HTML `<div>` overlays for reference lines. [2026-02-12]
- **Guide and UI copy: match file encoding**: File uses curly apostrophes (U+2019). Use exact character. [2026-02-10]
- **Snap intraday candle timestamps to timeframe boundaries**: `Math.floor(ts / intervalMs) * intervalMs`. [2026-02-08]

## Price Freshness

- **Scoring cron derives prices from D1 candles, which can be a day+ old**: The scoring pipeline (`computeServerSideScores`) produces a price from the latest D1 daily candle. When that candle is from yesterday, the scored result overwrites `timed:latest:{sym}` with a stale price, erasing the fresher value from the price feed. Fix: always compare the scored price timestamp against the existing `_price_updated_at` and the live `timed:prices` cache — keep the freshest. [2026-02-20]
- **Snapshot must overlay live prices before writing to KV**: The `timed:all:snapshot` is built from `timed:latest:` entries (which may have stale prices from scoring). Always overlay `timed:prices` onto the snapshot before writing, so even the cached fast-path serves fresh prices. [2026-02-20]
- **Price freshness requires timestamps at every layer**: Every price write must include `_price_updated_at`. Every reader must compare timestamps before overwriting. Without this, "last writer wins" causes stale data to replace fresh data. [2026-02-20]

## Architecture Decisions (Reference)

- **Use `enrichResult()` wrapper for cross-cutting entry enrichments**: Rather than modifying every `return { qualifies: true }`. [2026-02-07]
- **Use daily candles for price performance, not trail data**: `ticker_candles` tf='D' for 5D/15D/30D/90D changes. [2026-02-08]
- **Server-side TD Sequential replaces TradingView webhook dependency**: Compute from D/W/M candles in worker. [2026-02-08]
- **Pattern matching in hot path needs in-memory cache**: 5-min TTL. D1 query per ingest = too expensive. [2026-02-08]
- **Auto-rebalance position sizing by stage**: Accumulate 5-7%, Watch 2%, Max 8%/ticker, Max 20 positions. Reduce 25%/cycle. [2026-02-12]
- **Durable Object WebSocket Hibernation API**: `state.acceptWebSocket(ws, tags)` for $0 duration charges. Tags persist, in-memory props don't. [2026-02-11]
