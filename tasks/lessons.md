# Lessons Learned (Full Archive)

> **Quick refresh:** See [CONTEXT.md](../CONTEXT.md) for condensed critical lessons.
> Update after ANY correction from the user. Review at session start.

---

## Deployment & Infrastructure

- **Deploy worker to BOTH environments**: `cd worker && npx wrangler deploy && npx wrangler deploy --env production`. Both crons can fire from either. Deploying only one leaves stale code running. [2026-02-11, reinforced 2026-02-18]
- **Frontend requires build before Pages deploy**: Source files (`index-react.source.html`, `shared-right-rail.js`) must be compiled before `wrangler pages deploy`. Never run Pages deploy directly — always use `npm run deploy:frontend` which builds, runs a freshness check, and deploys. Use `npm run deploy:all` to deploy both frontend and worker. [2026-03-12]
- **Two deployment targets — Worker (wrangler deploy) + Pages (git push)**: Static files served by Pages (auto-deploy on push). API by Worker. Changing right rail JS requires both. Always update `?v=` cache busters. [2026-02-11]
- **Pages serves simulation-dashboard.html, NOT the worker**: The worker embeds dashboard-html.js and serves it at `/` and `/dashboard`. But the Trades page link goes to `simulation-dashboard.html`, which is a static file served by Cloudflare Pages. `npm run deploy:worker` does NOT update Pages. You MUST `git commit && git push` any changes to `react-app/*.html` files to trigger Pages auto-deploy. The embed + worker deploy is only for the root `/` route. [2026-02-28]
- **Trades page JSX: single root only (App return)** — In `react-app/simulation-dashboard.html`, the App component's `return` must have exactly ONE root element. Babel throws "Adjacent JSX elements must be wrapped" if e.g. `GoProModal` and a `</div>` end up as siblings at the top level. Fix: (1) Wrap the entire return in a React fragment: `return ( <> <div className="tt-root"> ... </div> </> );` so the fragment is the single root. (2) Do NOT add an extra `</div>` between the daily-summary modal's `)}` and `<GoProModal />` — that extra close made `tt-root` close early and GoProModal a second root. After any edit, verify: count `<div` vs `</div>` in the App return block (lines ~7327–7937); they must be equal. [2026-02-28]
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
- **Never use unbounded `ROW_NUMBER() OVER (PARTITION BY ticker ...)` on large tables**: Window functions scan the entire table. On `ticker_candles` with 200+ tickers and months of data, this takes 10-30s and overloads D1. Use `GROUP BY ticker` with `max(ts)` and date-bounded `WHERE ts > cutoff` instead. [2026-02-20]
- **Heavy calibration/batch jobs must not run on same schedule as scoring cron**: Running calibration (many D1 queries) on `*/5 * * * *` alongside scoring causes D1 overload. Separate to `0 * * * *` / `30 * * * *`. [2026-02-20]
- **Calibration must load trail_5m_facts AFTER move detection, not before**: trail_5m_facts has millions of 5-min rows. Loading all upfront for ~200 tickers times out. Detect moves from daily candles first, dedup/cap at 500, then enrich only the final set with trail data for their specific tickers. [2026-02-20]
- **Use hourly candles (tf='60') for MFE/MAE in trade autopsy**: 5-min candles (~2M rows) are too heavy. Daily candles are too coarse. Hourly (`tf='60'`) gives good intraday precision at ~1/13th the data volume of 5-min. Fetch with date bound and per-ticker batch alongside daily candles. [2026-02-20]
- **NO_TRAIL_DATA often = trail_5m_facts date gap, not missing table**: diagnose-missed-moves reports NO_TRAIL_DATA when there are no trail_5m_facts rows for the move’s (ticker, start_date..end_date). After backfill, high NO_TRAIL_DATA can be because trail data exists only for a subset of that range (e.g. ETHA only from Oct 2025 if candles/replay didn’t cover earlier months). Fix: (1) Run `USE_D1=1 node scripts/debug-no-trail-data.js` to confirm per-ticker date ranges in D1. (2) Re-backfill missing ticker/date ranges or restrict move discovery to each ticker’s available trail window. Don’t run full replay for “calibration” until trail coverage is fixed. [2026-03-02]
- **Worker cron jobs can time out silently**: If a cron worker exceeds its wall-clock limit, it dies without running catch blocks. KV status gets stuck at "running". Add: (1) wall-clock timeout checks between steps, (2) stale-status detection in API (if updated_at > 2 min ago, report as timed_out), (3) auto-cleanup of stuck status at cron start. [2026-02-20]
- **Ingestion-status gaps vs backtest**: If Tickers page shows many gaps despite backfills, (1) Run `USE_D1=1 node scripts/audit-data-completeness.js` to verify actual D1 coverage. (2) ingestion-status uses `date(ts/1000,'unixepoch','-5 hours')` for NY trading days — DST (EDT=-4) can cause 1-day edge-case miscounts. (3) Backtest uses same ticker_candles; real gaps would affect replay. If audit shows full coverage but ingestion-status shows gaps, the gap calculation may need tuning. [2026-03-04]
- **SECTOR_MAP vs ticker index — use watchlist/add for new Upticks**: Adding tickers to SECTOR_MAP alone does NOT add them to `timed:tickers` or trigger backfill. POST /timed/admin/sync-universe syncs KV to CANONICAL_UNIVERSE but getActiveTickerUniverse merges D1 + KV; new SECTOR_MAP tickers may not appear until explicitly added. Use `POST /timed/watchlist/add` with `{"tickers":["BG","MRK","QXO"]}` to add to index, D1, and trigger onboarding (backfill + score). Verify with `node scripts/verify-upticks-universe.js`. [2026-03-04]

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
- **Price flicker from competing KV sources (timed:latest vs timed:prices)**: `computeServerSideScores` sets `price` from candle close and `ts: Date.now()`, making stale candle prices appear "fresh". Meanwhile `timed:prices` (Alpaca REST) has the correct live price. The scoring cron's freshness check used `result.ts` (= Date.now()) as the candle timestamp, so it always thought the candle price was newer than any live source. Fix: (1) Backend: always prefer `_livePricesCache` price when it diverges >0.2% from candle price, regardless of timestamps. (2) Frontend: if the refresh response price diverges >2% from current `_live_price`, keep the live price — the response likely has a stale candle close from KV eventual consistency. [2026-02-20]
- **Market regime should use explicit internals, not only price structure**: Trend/chop classification is necessary but not sufficient. For higher-quality regime mapping, include a dedicated internals layer: VIX risk bands, offensive-vs-defensive sector rotation, optional risk barometers like `AUDJPY`/`USDJPY`, and market-breadth style signals such as `$TICK` when available. Treat Carter-style squeeze/compression as both a setup-timing input and a regime energy signal, especially when aligned across daily + intraday timeframes. [2026-03-11]

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

## UI Approachability & Design

- **Never use "you/your" in user-facing copy**: Always reference "the system", "the model", "the portfolio", or "this stock". Important for compliance (not personalized advice) and consistency. Applies to all pages: dashboards, tooltips, legends, empty states. [2026-02-25]
- **Inline education beats hidden tooltips**: Don't hide explanations behind (i) icons or toggle buttons — users won't discover them. Weave explanations directly into the layout as subtitle text below metrics/headings. If there's no room, native `title` attributes are sufficient. The InfoTip (i) icon pattern was rejected as visual clutter. [2026-02-25]
- **Lead with a plain-English summary, then show numbers**: Every detail panel (Right Rail, deep dive) should open with a generated one-liner summarizing the bottom line (e.g., "Mixed signals. The system recommends watching for now.") derived from score + stage. Users get the answer before parsing data. [2026-02-25]
- **Raw scores need color-coded context words**: A number like "54" is meaningless without context. Always pair it with a verdict: "54 Mixed" (amber), "87 Strong" (green), "12 Weak" (red). Same for market health sub-scores. Users should never have to guess whether a number is good or bad. [2026-02-25]
- **Score breakdown rows need verdict dots**: A green/amber/red dot next to each row (based on value ÷ max > 60%/30%) lets beginners scan which factors are strong vs weak without understanding the numbers. [2026-02-25]
- **Chart legends should be a single compact line**: Keep chart legends (Bubble Chart, etc.) to one horizontal row with terse labels. Use `title` attributes for full explanations. Two-row legends with SVG samples are too heavy. [2026-02-25]
- **Technical terms: friendly label first, pro term in parentheses or title**: "Buy Zone" (not "Accumulation Zone"), "Performance vs Market" (not "Relative Strength vs SPY"), "Strength vs Market" (not "relativeStrength"). Professional term preserved in `title` or parenthetical for advanced users. [2026-02-25]
- **Each page needs its own Guide + Tour with separate localStorage keys**: Active Trader uses `timedTrading_welcomeSeen` + `tt_coachmarks_completed_v1`, Investor uses `tt_investor_welcomeSeen` + `tt_investor_coachmarks_v1`. Each page is a separate HTML file with its own script scope, so guide/tour components must be duplicated (not shared). Coachmarks auto-start after the welcome modal is dismissed (poll for the localStorage key, then 800ms delay). [2026-02-25]

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
- **Use TwelveData's native quote fields, don't recompute**: TwelveData `/quote?prepost=true` returns `change`, `percent_change`, `extended_change`, `extended_percent_change`, `extended_price` server-side. `parseTdQuote` must parse these and the price feed must prefer them over manual `price - prevClose` computation. The old code set `dailyClose = price` which made EXT change always 0. [2026-02-25]
- **Session-aware KV persistence for daily change and AH data**: After extended hours, TwelveData "rolls" the day — `previous_close = close`, zeroing out `change`/`percent_change`. Use `isNyRegularMarketOpen()` (handles holidays, weekends, early closes) to decide: **Market closed** → preserve previous `dc`/`dp`/`pc` and `ahp`/`ahdc`/`ahdp` in KV. **Market open** → let fresh values flow (including zeros that clear AH fields, hiding EXT row during RTH). Detection: `dc === 0 && dp === 0 && prev.dc != null && _marketClosed`. Applies to lightweight cron, full cron, and admin refresh-prices endpoint. [2026-02-25]
- **All frontend pages must use getDailyChange() from shared-price-utils.js**: Investor dashboard was using raw `t.dailyChgPct` from the server response instead of the shared utility. Any page showing daily change must import `shared-price-utils.js` and call `getDailyChange(t).dayPct` / `.dayChg`. Add field aliases (`prev_close`, `day_change_pct`, `day_change`) to server endpoints so getDailyChange's fallback chain works. [2026-02-25]

## Scoring Architecture (v3)

- **HTF timeframe weights: D(40%) > 4H(30%) > W(20%) > M(10%)**: Daily is the anchor (healthy rate of change). 4H catches early flips. Weekly/Monthly confirm but lag — their weight should match. The old W(50%)/D(35%)/4H(10%)/1H(5%) over-weighted lagging signals and gave 1H too little influence. [2026-02-26]
- **LTF must include 1H to reduce noise**: Old LTF was 30m(55%)/10m(30%)/5m(15%) — all sub-hour TFs made it hyper-reactive. New: 1H(35%)/30m(30%)/10m(20%)/5m(15%). The 1H stabilizes swing-level context while short TFs still handle precise timing. [2026-02-26]
- **Ichimoku is more than above/below cloud**: The old system used Ichimoku as a binary gate (block when price below cloud on D+W). The new system computes Tenkan/Kijun/Senkou/Chikou natively, scores them (±50), and blends 30% into HTF and 20% into LTF. TK Cross, cloud thickness, Chikou confirmation, and Kijun slope provide rich trend/chop discrimination that EMAs alone miss. [2026-02-26]
- **Daily 5/48 + ST slope = bias/continuation**: Calibration showed 5>48 at entry predicts winners. Daily timeframe should use 5/48 (not 13/48) for bias; LTF uses 13/48 for timing. ST sloping in trend direction = strong continuation. Worker computeTfBias: Daily gets ema5_48 (w=0.20), st_slope (w=0.15); Daily TF weight 1.5x. [2026-02-27]
- **Volume (RVOL) must be a first-class entry gate, not ±1 point**: Old system gave volRatio ±1 in HTF regime and ±3 in momentum. Enhanced with `rvol5` (5-bar trend) and `rvolSpike` (breakout detection). RVOL < 0.5 should block entries (dead zone), > 1.3 should boost confidence. [2026-02-26]
- **Chop = thin Ichimoku cloud + narrow TK spread + inside cloud**: Cloud thickness (ATR-normalized) near 0 + TK spread near 0 + priceVsCloud = "inside" is the strongest chop signal. The system should reduce trade frequency dramatically in this regime. [2026-02-26]
- **Regime classifier needs 7 factors, not just Ichimoku**: Cloud thickness + TK spread + Kijun slope + Kumo twist + EMA structure + ST stability + RVOL. Score range -15 to +15. Score >= 5 = TRENDING, 0-4 = TRANSITIONAL, < 0 = CHOPPY. Single factor is insufficient — e.g. SuperTrend can stay stable even in sideways markets (synthetic data showed stBars=201 in chop). [2026-02-26]
- **Market regime overlay is a safety net**: Even when a ticker looks trending, if SPY is choppy, override to TRANSITIONAL at best. TRENDING ticker + CHOPPY market → TRANSITIONAL. Prevents system-wide overconfidence during macro chop. [2026-02-26]
- **Regime params cascade through all gates**: Completion cap (0.60→0.30), RR minimum (1.5x→3.0x), daily entries (6→2), HTF score floor (10→25), position size (1.0x→0.5x). Each independently tightens. SHORTs blocked entirely in CHOPPY — they had negative EV in Nov-Feb 2026 backtest. [2026-02-26]
- **RVOL dead zone (< 0.4-0.5) is a hard stop**: No amount of score quality can compensate for no institutional participation. Low volume signals are unreliable regardless of technical alignment. When above dead zone but below 0.7-0.8, raise HTF score requirement by 5-10 points. [2026-02-26]
- **Consecutive loss cooldown prevents tilt**: 3+ losses in 5 days → 24h cooldown. The system was doubling down when cold (66% of entries were within 1hr of previous on same ticker, most were losers). Cooldown breaks the feedback loop. [2026-02-26]
- **Kijun-Sen is a natural SL anchor**: The Kijun-Sen (26-period midpoint) acts as dynamic support/resistance that price reverts to during healthy trends. Blending 40% Kijun + 60% ATR-based SL places stops at structurally meaningful levels rather than arbitrary multiples. Pure ATR SL is brittle in chop because ATR expands while structure hasn't changed. [2026-02-26]
- **SL and position size must be inversely linked**: Wider SL in chop (1.3x cushion) MUST be paired with smaller position (0.5x). Otherwise wider stops just mean larger losses. The math: 1.3x stop width × 0.5x position = 0.65x maximum dollar risk per trade, which is safer than the original 1.0x × 1.0x. [2026-02-26]
- **Time exits cut the tail of losers**: Backtest showed positions held 20+ days while losing had negative expected value regardless of setup quality. In chop, mean-reversion makes holding losers worse over time. 7-day max hold (3.5 if losing > 2%) forces recognition of failed thesis before SL hit. [2026-02-26]
- **Cloud boundary TP nudging > cloud boundary TP replacement**: Don't replace ATR-computed TPs with Ichimoku levels — instead, nudge TPs toward nearby cloud edges when within 15%. This preserves the existing calibrated TP logic while adding structural confluence. [2026-02-26]
- **Duplicate SL/TP logic in replay vs live is a maintenance risk**: Both paths (replay simulation ~L9100 and live ingest ~L11220) have nearly identical SL computation: GS adjustment → regime widen → Kijun blend → cushion. Should be extracted into a single `computeFinalSL()` helper in a future refactor. [2026-02-26]
- **IC computation needs closed trades with v3 columns to be meaningful**: The v3 signal IC queries `direction_accuracy` for rows with `status IN ('WIN','LOSS')` that have the new columns populated. Fresh v3 columns will be NULL for historical trades. IC signal weights will only be informative after the first replay with the new scoring populates these columns. [2026-02-26]
- **Schema migration via ALTER TABLE in batch is fragile**: D1 ALTER TABLE can fail if column already exists. Must wrap each ALTER in its own try/catch. Cannot batch multiple ALTERs in db.batch() because one failure aborts the entire batch. [2026-02-26]

## Learning Loop & Model

- **New scoring fields need backward-compatible gates**: Check `d?.field != null` before gating. Old KV data won't have new fields. [2026-02-07]
- **Pattern integration should boost, not gate**: Pattern match enhances but never blocks entries. [2026-02-08]
- **Model features must include all signal sources**: New indicators → feature vector + prediction triggers + outcome tracking. [2026-02-08]
- **Learning loop config pattern**: `model_config` key → load with TTL cache → inject into scoring → retrospective updates weights. Applied for `consensus_tf_weights`, `scoring_weight_adj`, and now `consensus_signal_weights`. [2026-02-19]
- **Signal weights flow**: `getLearnedSignalWeights(env)` → `_signalWeights` in scoring cron → `assembleTickerData` opts → `computeSwingConsensus` 4th param → `computeTfBias` applies per-signal weighting. [2026-02-19]
- **Trail data drives model analysis scripts**: `timed_trail` not `ticker_candles`. Need weeks/months of trail data for meaningful recalibration. [2026-02-10]
- **Pattern library Phase 1 findings**: Top bullish: ST Flip + Bull (64.5%), EMA Cross + Rising HTF (70.4%). Top bearish: Squeeze Release in Bear (65.5%). Most predictive: squeeze_releases (-33.7% lift toward DOWN). [2026-02-11]

## Freemium Gating & Member Experience

- **Lower AuthGate `requiredTier` to "free" on the main dashboard, gate features inline**: The old `requiredTier="pro"` blocked Members at the door with a PaywallScreen. For freemium, set `requiredTier="free"` on `index-react.html` so Members enter the dashboard, then use `window._ttIsPro` checks on individual elements (scores, SL/TP, prices, right rail tabs). Keep `requiredTier="pro"` on secondary pages (simulation-dashboard, model-dashboard) that should remain fully gated. [2026-02-26]
- **`window._ttIsPro` is a reactive getter for component-level gating**: Defined via `Object.defineProperty` with a getter reading `document.body.dataset.isPro`. Set once in AuthGate's `useEffect`. True for Pro, VIP, Admin, and manually-granted subscriptions. Safe to call at render time without stale-closure risk. Never duplicate tier logic inline — always check this single global. [2026-02-26]
- **Member ticker list is admin-configurable via `model_config`**: Stored as `member_ticker_list` key in D1 `model_config` table. Exposed via `GET /timed/member-tickers` (public), `POST /timed/admin/member-tickers` (admin), and included in `/timed/me` response. Frontend reads it and sets `window._ttMemberTickers` (array) and `window._ttMemberTickerSet` (Set for O(1) lookups). Default: `["AAPL","TSLA","NVDA","JPM","NFLX","MSFT","GOOGL","AMZN","META","XOM"]`. [2026-02-26]

- **Admin add-ticker flow: Add → Fill → Score**: watchlist/add triggers ctx.waitUntil(onboardTicker) which can timeout. Ticker Management: use Fill (alpaca-backfill) then Score (admin/onboard?skipBackfill=1) for reliable completion. admin/onboard accepts requireKeyOrAdmin (API key or CF Access admin JWT). Kijun SL display: hide when >50% from price to avoid wrong values (e.g. K754 for $394). [2026-02-26]
- **Filter tickers client-side for Members, not server-side**: The `/timed/all` endpoint returns all tickers. Members filter to `_ttMemberTickerSet` in the `useMemo` that feeds BubbleChart and KanbanColumns. Add "Go Pro" CTA cards at the end of each Kanban lane and an overlay on BubbleChart. [2026-02-26]
- **Price data gating: Members = old non-admin treatment**: Members should NOT see real-time price, daily change %, daily change $, or EXT% on cards and tables — same treatment as old `!window._ttIsAdmin` gate. Gate behind `window._ttIsPro`. Pro/VIP/Admin see everything. [2026-02-26]
- **Top Gainers/Losers and Upcoming Earnings are ungated teasers**: These sections provide verifiable value (publicly available data) that hooks Members. Market Pulse stays Pro-only because it shows real-time index/ETF prices. [2026-02-26]
- **Scores, SL/TP, R:R are the "secret sauce" — gate the whole row**: Wrapping Row 3 (Score, R:R, Alignment, SL, TP) in a single `!window._ttIsPro` check with a "Go Pro" CTA is cleaner than gating each field. Same for Row 4 (lane reason, entry block label) and progress bar. [2026-02-26]
- **Right rail Pro tabs use a `proOnly` flag, not removal**: Add `proOnly: true` to tab definitions (Technicals, Model, Journey, Trade History). Render lock icon and "Pro Feature" overlay when `!_ttIsPro && tab.proOnly`. Keeps tabs visible as teasers but content locked. [2026-02-26]
- **"Add Ticker" becomes "Go Pro" CTA for Members**: Members cannot add tickers. Search results show "Go Pro to add [TICKER]" for non-member tickers. The add button itself becomes "Go Pro to Add Tickers". [2026-02-26]
- **Blurred placeholders are better teasers than hidden sections**: For positions and trade history, render a blurred fake table (`filter: blur(6px)`, `pointer-events: none`) with a centered "Go Pro" CTA overlay. Users see the shape of data they're missing. [2026-02-26]
- **Use `CustomEvent("tt-go-pro")` for all Go Pro CTAs**: Every "Go Pro" button dispatches `window.dispatchEvent(new CustomEvent("tt-go-pro"))`. A single `GoProModal` component in the App root listens and opens. Decouples CTA placement from modal implementation — add CTAs anywhere without wiring. Easy to swap in Stripe Checkout later. [2026-02-26]
- **Investor Mode embedded via iframe with `?embedded=true`**: The Active Trader / Investor mode switcher embeds `investor-dashboard.html?embedded=true`. The iframe version hides its own nav/footer and sets transparent background. Events from iframes don't bubble to parent — use `window.parent.dispatchEvent()` if Go Pro CTAs are needed in embedded pages. [2026-02-26]
- **Dead code in Babel-transpiled files causes cryptic scope errors**: Babel's in-browser transpiler flattens `memo()` component bodies into the same scope. An unused `const Bubble = memo(...)` with variables like `borderColor`, `finalBorderColor` conflicted with the active `SVGBubble` component. Browser reports misleading line numbers. Fix: always remove dead components; search for duplicate `const` declarations when Babel reports "already declared" errors. [2026-02-26]
- **Simulation dashboard mixes JSX and htm tagged templates**: `simulation-dashboard.html` uses `type="text/babel"` but some sub-components use `html\`...\`` (htm). This works because htm produces standard React elements. JSX uses `className`/`onClick`, htm uses `class`/`onClick`. Mixing is fine but inconsistent. [2026-02-26]

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
- **`d1TickerHasCandles` must check scoring-TF candles, not just any candle**: A ticker with only 1-minute candles passes the old check but fails scoring (needs 50+ candles in D, W, 4H, 1H, 30m, 10m, 5m). Check for ≥3 distinct scoring TFs AND ≥50 daily candles. Also: scoring cron must auto-backfill user-added tickers that have insufficient data, and write scored results to D1 `ticker_latest` (not just KV) so the D1 fallback path serves correct data. [2026-02-25]
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
- **Local calibration pipeline over serverless**: Heavy D1 reads (trail_5m_facts, candles) and CPU work (move detection, MFE/MAE) must run locally via `node scripts/calibrate.js`. Worker-side cron calibration exceeded 25s wall-clock and overloaded D1. Local script has no time limit, uploads results, server runs only lightweight analysis. [2026-02-20]
- **Bulk D1 writes cause transient overload**: Uploading 18K+ moves in rapid-fire batches saturates D1, causing other endpoints to 503. Add 500ms throttle every 10 batches. [2026-02-20]
- **Per-ticker D1 queries need batching with IN clauses**: Fetching trail_5m_facts per-ticker for 300+ tickers = 300+ wrangler processes. Batch 15 tickers per query with `WHERE ticker IN (...)` reduces calls 20x and avoids transient fetch failures. [2026-02-20]
- **Retry logic for wrangler d1 execute**: Remote D1 queries via wrangler can fail transiently ("fetch failed"). Always retry 2-3 times with a small delay. Return empty array on final failure instead of crashing. [2026-02-20]

## Replay & Historical Backfill

- **Candle-replay must load candles BEFORE the replay date, not "latest"**: `d1GetCandlesAllTfs` with `ORDER BY ts DESC LIMIT 1500` returns the newest candles (e.g. Feb 2026). When replaying Jul 2025, ALL loaded candles are after the replay date, so `sliced.filter(c => c.ts <= intervalTs)` returns 0 candles → `ltf_score=0` → no trades. Fix: pass `beforeTs: marketCloseMs` to the query: `WHERE ts <= ?4 ORDER BY ts DESC LIMIT ?3`. [2026-02-23]
- **Replay must inject golden profiles, adaptive gates, and VIX**: In live mode, `qualifiesForEnter` reads `_env._goldenProfiles`, `_env._adaptiveEntryGates`, etc. from env injected by the scoring cron. The candle-replay handler originally skipped this, causing entry gates to be looser (or stricter) than live. Fix: load from `model_config` D1 + KV once per replay invocation, inject into `result._env` for each ticker. [2026-02-23]
- **ctx.waitUntil is unreliable for long-running tasks**: Even with `usage_model = "unbound"`, `ctx.waitUntil` background tasks silently die after a few minutes on bundled workers. The function reaches its CPU time limit mid-execution with no error, no "done" status update. Fix: run backfill synchronously (await in the HTTP handler) instead of `ctx.waitUntil`. With `unbound`, the HTTP handler can run for minutes. [2026-02-23]
- **Backfill before replay, not during**: The candle-replay handler reads from `ticker_candles` but does NOT fetch from Alpaca. Without historical data in D1, LTF scores are 0. The `full-backtest.sh` script must include a backfill step (Step 1.5) before the replay loop. [2026-02-23]
- **Entry price mismatch in Trade Autopsy**: When stored entry_price differs from 10m candle at entry_ts (e.g. replay used daily fallback), use "Correct entry" button. POST /timed/admin/trade-autopsy/correct-entry fetches 10m candle and updates D1. Batch: POST /timed/admin/trade-autopsy/correct-all-entries?dryRun=1 (preview) then without dryRun to apply. Replay fix: when 10m bundle missing (endIdx<50), use last 10m bar from candleCache instead of result.price. [2026-02-26]
- **Deep backfill batch size: 3 tickers × all TFs**: With `sinceDays=297`, each ticker generates ~87K candles across 8 TFs. Processing 3 tickers per synchronous API call (~60s each) is the reliable sweet spot. Larger batches risk CPU timeouts. [2026-02-23]
- **D1 batch writes: use 500 per chunk, not 100**: D1 supports up to ~500 bound statements per `db.batch()`. Using 100 means 5x more round-trips for large backfills. [2026-02-23]
- **Add AbortController timeout to external API fetches**: Alpaca API calls in `alpacaFetchAllBars` had no timeout. If Alpaca is slow, the Worker hangs. Add `AbortController` with 60s timeout per fetch. [2026-02-23]
- **US market holidays in replay scripts**: Skip July 4, Labor Day, Thanksgiving, Christmas, etc. to avoid wasted API calls on days with no data. [2026-02-23]
- **Day-roll preservation must not depend on prev.dc !== 0**: The cron's day-roll guard `prev.dc !== 0` meant one missed cycle permanently lost daily change data until next market open. Fix: detect day-roll purely from `_marketClosed && dc === 0 && dp === 0`, then prefer `prev.dc` if available, else recompute from `prev.pc + displayPrice`. [2026-02-25]
- **Map ALL timed:prices fields in every frontend merge path**: The initial /timed/all merge, usePriceFeed() polling, and WS price_batch handler must all map `pc` → `_live_prev_close` and `ahp/ahdc/ahdp` → `_ah_price/_ah_change/_ah_change_pct`. Missing mappings cause ext hours data to go stale when WebSocket drops, and prev_close to be absent on first load. [2026-02-25]
- **Never use `dayPct !== 0` as a rendering guard**: A stock that didn't move or a day-rolled 0 value should show `+0.00%`, not hide the field entirely. Use `Number.isFinite(dayPct)` alone. [2026-02-25]
- **Always run `npm run build:rail` after editing shared-right-rail.js**: The site loads `shared-right-rail.compiled.js`, not the source file. Editing only the `.js` file has no effect until `build:rail` compiles it. Also run this before `deploy`. [2026-02-25]
- **`close-replay-positions` must also close `positions` table, not just `trades`**: The `account-summary` endpoint reads unrealized P&L from `positions WHERE status='OPEN'`, not `trades`. If `close-replay-positions` only updates `trades`, 293 positions stay OPEN and show massive phantom unrealized P&L. Fix: add positions table sync to the endpoint. Also fix the `trail_5m_facts` query (columns are `price_close` and `bucket_ts`, not `close`/`day_key`/`bucket_start`) and add `ticker_candles` daily close as a fallback price source. [2026-02-26]
- **After replay, set replay lock BEFORE calling close-replay-positions**: The live cron runs every minute. If the lock isn't set, the cron will pick up open positions from the replay and manage them with current market prices, contaminating historical backtest results. KV propagation across Cloudflare's edge network can take 30-60 seconds, so set the lock well before the replay ends. [2026-02-26]
- **Trade Autopsy entry price mismatch**: Replay can store wrong entry_price (e.g. daily fallback instead of 10m). Trade Autopsy fetches 10m candle at entry_ts; when it differs from stored, use "Correct entry" to fix D1. POST /timed/admin/trade-autopsy/correct-entry updates entry_price from candle and recalculates pnl/pnl_pct. [2026-02-26]
- **Status must always follow realized P&L**: correct-exit and correct-all-exits were updating exit_price and pnl from 10m candles but not status, causing trades to show LOSS with positive P&L (or WIN with negative). Fix: all four correct-* endpoints now derive and persist status from recalculated pnl (WIN/LOSS/FLAT). When exit price is already correct, correct-exit still reconciles status if it disagrees with pnl. Batch fix: POST /timed/admin/trade-autopsy/reconcile-status?dryRun=1 (preview) then without dryRun. [2026-03-05]
- **Trade Autopsy granular classification**: Added Entry Grade (Chasing, Move Stretched, Not Enough Confirmation, Fake Out, Good Entry) and Trade Management (Should Have Trimmed, Should Have Held, Should Have Cut Early, Should Protect Gains Better, SL Too Tight, SL Too Loose) as multi-select tags. Stored in trade_autopsy_annotations.entry_grade and trade_management (JSON arrays). Calibration batch-load includes them for learning. Migration: add-autopsy-entry-grade-trade-mgmt.sql; d1EnsureLearningSchema also adds columns on first request. [2026-03-05]
- **Trade Autopsy granular classification**: Entry Grade (Chasing, Move Stretched, Not Enough Confirmation, Fake Out, Good Entry) and Trade Management (Should Have Trimmed, Should Have Held, Should Have Cut Early, etc.) are multi-select. Stored in trade_autopsy_annotations.entry_grade and trade_management (JSON arrays). Use for calibration: distinguish 10m weight tuning vs ticker personality. Migration: add-autopsy-entry-grade-trade-mgmt.sql; d1EnsureLearningSchema adds columns on first request. [2026-03-05]
- **Trade Autopsy granular classification**: Entry Grade (Chasing, Move Stretched, Not Enough Confirmation, Fake Out, Good Entry) and Trade Management (Should Have Trimmed, Should Have Held, etc.) are multi-select tags. Additive to primary classification. Stored in trade_autopsy_annotations.entry_grade and trade_management (JSON arrays). Migration: add-autopsy-entry-grade-trade-mgmt.sql; d1EnsureLearningSchema also adds columns on first deploy. [2026-03-05]
- **Historical run restores need explicit run-scoped annotation import**: Runs UI can show classification counts from imported metrics even when Trade Autopsy has no per-trade labels. Saved artifacts use mixed formats: some embed `annotation_*` fields in `trade-autopsy-trades.json`, others store a separate `trade-autopsy-annotations.json`. Import code must normalize both and persist them into `backtest_run_trade_autopsy`; Trade Autopsy save requests must include `run_id` so edits update the archived run row, not only the live `trade_autopsy_annotations` table. [2026-03-11]
- **Status must always follow realized P&L**: correct-exit and correct-all-exits were updating exit_price and pnl from 10m candles but not status, causing trades to show LOSS with positive P&L (or WIN with negative). Fix: all correct-* endpoints now derive and persist status from pnl (WIN/LOSS/FLAT). For already-corrected trades: POST /timed/admin/trade-autopsy/correct-exit with trade_id (reconciles status when exit price unchanged), or POST /timed/admin/trade-autopsy/reconcile-status for batch. [2026-03-05]
- **Trade Autopsy intraday charts should default to RTH for equities**: Several July 2025 autopsy charts showed giant 15m spikes, but the bad bars were isolated after-hours candles (for example NVDA at 4:45 PM ET and WMT at 5:15 PM ET). These distorted the chart scale without helping trade classification. Fix: in `react-app/trade-autopsy.html`, filter intraday candles to 9:30 AM-4:00 PM ET for equity-style tickers; keep extended-session data for futures/crypto/macros (`*USD`, `*USDT`, `*1!`, `SPX`, `US500`, `DXY`, `GOLD`, `SILVER`, `USOIL`). [2026-03-10]
- **Calibration should segment by active execution profile, not just regime/path**: Once the engine selects named profiles like `trend_riding` or `choppy_selective`, the learning loop must persist and analyze that exact choice with its market-state context. Otherwise the report can tell us a regime or path underperformed without proving whether the wrong execution profile was active for that backdrop. Persist `execution_profile_*` lineage at entry time and surface `execution_profile x market_state` metrics in calibration reports before promoting overrides. [2026-03-11]

## Move Discovery & Analysis

- **ATR-relative move detection normalizes across tickers**: A 3x ATR move captures ~2.5% for SPY but ~40% for volatile small-caps. Use `computeATR(candles, 14)` then filter `moveAtr >= MIN_ATR_MULT`. This avoids fixed-percentage thresholds that miss small-cap breakouts or flag noise on large-caps. [2026-03-02]
- **Dedup moves by ticker:direction:5-day-bucket**: Multiple overlapping windows (5d, 10d, 20d, 40d, 60d) produce many duplicates for the same move. Sort by `move_atr` desc, keep largest per bucket, mark adjacent buckets as seen. [2026-03-02]
- **Trade data uses camelCase from /timed/trades API**: Fields are `entryPrice`, `exitPrice`, `pnlPct`, `entry_ts`/`exit_ts` (seconds), not `entry_price`/`pnl_pct`. Always normalize timestamps to ms. [2026-03-02]
- **Churning detection: >2 trades in same ticker+direction overlapping a move**: Compare sum of individual P&L vs. hold-from-first-entry-to-last-exit. The gap = "missed upside" from unnecessary exits and re-entries. [2026-03-02]
- **KV value size limit for large reports**: The full move discovery report is ~7.6 MB JSON. KV max is 25 MB, so it fits. Use POST endpoint to write and GET to read, with 90-day expiration. For even larger reports, consider trimming missed moves. [2026-03-02]

## UI Consolidation

- **Merge overlapping analysis tabs into a single unified view**: Deep Audit (live) and Calibration (uploaded report) had duplicate Entry Paths, Tickers, and Recommendations sections. Solution: single "Analysis" top-level tab with "Live Audit" / "Calibration Report" toggle. [2026-03-02]
- **Group related sub-tabs to reduce cognitive load**: 12 calibration sub-tabs reduced to 6 by grouping: Health+Apply, EntryPaths+Profiles, Oracle+Signals, SL/TP+Rank+Sizing, VIX+WFO, Repeats+Missed. Use vertical sections with headers within each group. [2026-03-02]

## Trade Management Tuning

- **SL floor is more important than SL cap**: The deep audit recommended capping SL at 1.2x ATR, but move discovery showed the real problem is stops being too TIGHT (0.47 ATR vs 10.5% avg pullback on valid moves). Added `deep_audit_sl_floor_mult` to enforce a minimum SL distance. Cap limits max risk; floor prevents noise exits. [2026-03-02]
- **Loss-aware cooldown prevents churn spiral**: 73% of churned trades start with a LOSS. After a loss on a ticker, the system re-enters too quickly and loses again. Extended cooldown from 4h to 48h after LOSS via `deep_audit_loss_cooldown_hours`. The `allTrades` array in the execution pipeline contains closed trades with status — filter by ticker and sort by exit_ts to find the most recent. [2026-03-02]
- **trail_5m_facts bucket_ts is in milliseconds**: When querying trail_5m_facts, bucket_ts values are epoch milliseconds (e.g., 1770558300000), not seconds. Always compare with ms timestamps. [2026-03-02]
- **Missed moves are primarily a rank/HTF-weight problem**: Post-backfill analysis (Mar 9) showed 98.9% miss rate. Of 2,535 missed moves with trail data, 92% had rank < 30 despite 68% having HTF >= 15. Root cause: `computeRank` HTF contribution was capped too low (max +10). Fix: increased HTF multiplier (0.4→0.5 for strong, 0.35→0.45 for medium), added +6 strong-trend bonus (HTF>=30+aligned), increased sector boosts (metals +5, semis +3). Also relaxed TT bias from strict 3/3 TF alignment to 2/3 when HTF>=25+daily agrees, and added HTF trend overrides for rank gates in `qualifiesForEnter`. [2026-03-09]
- **should_have_held calibration (8 trades)**: Autopsy tags showed exits too early. Loosened: MIN_MINUTES_SINCE_ENTRY_BEFORE_TRIM 10→15, PROFIT_PROTECT_TRIM threshold 2%→2.5%, TT_EXIT_DEBOUNCE_BARS 2→3. Gives more room before trim and requires slightly more profit before locking in. [2026-03-06]

## Breakout Detection & Entry Paths

- **Three breakout detectors in priority order**: (1) Daily level break (price > swing high or < swing low + RVOL >= 1.3), (2) ATR-relative breakout (price outside 10-day range + move >= 2x ATR + RVOL >= 1.2), (3) EMA stack breakout (3+ aligned EMAs + regime >= ±1 + RVOL >= 1.0). Priority: most specific first. All return `{ type, dir, ... }` or null. [2026-03-02]
- **Breakout paths intentionally bypass rank/completion gates**: Breakouts occur before traditional triggers mature (rank is 5.8 avg at move start). The breakout entry path in `qualifiesForEnter` skips adaptive rank minimum and completion cap but still enforces blacklist, toxic hour, minimum RR (1.5), and entry quality (40). [2026-03-02]
- **Rank boost lifts breakout tickers from invisible to visible**: `computeRank` adds +20 (daily level), +15 (ATR breakout), +12 (EMA stack) when breakout is detected. This raises typical breakout-start rank from ~5 to 25-35, above most hard gates. [2026-03-02]
- **Backfill trail_5m_facts covers the full move analysis window**: 43.5% of missed move diagnoses had NO_TRAIL_DATA. Root cause: trail data only existed from Oct 2025. Backfill from Jul 2025 covers the move discovery lookback. The pipeline is: ticker_candles → candle-replay (trailOnly=1) → timed_trail → run-lifecycle → trail_5m_facts. [2026-03-02]
- **All breakout config keys gated via model_config**: `deep_audit_breakout_daily_level_enabled`, `deep_audit_breakout_atr_breakout_enabled`, `deep_audit_breakout_ema_stack_enabled`, `deep_audit_breakout_min_rr`, `deep_audit_breakout_min_entry_quality` — all can be toggled without redeployment. [2026-03-02]

## Calibration & Self-Learning Loop

- **Calibration outputs must be wired to trading logic**: `calibrated_sl_atr`, `calibrated_tp_tiers`, `calibrated_rank_min` were written to `model_config` by `/calibration/apply` but never read by scoring/trading. Fixed: SL fallback chain is per-state adaptive → `_default` adaptive → calibrated global → 1.5x ATR. TP tiers load from `_default` state → `calibrated_tp_tiers` global. `calibrated_rank_min` is used as fallback when `adaptive_entry_gates` has no gate for current state. [2026-03-02]
- **Per-state adaptive_sl_tp is a nested object, not flat**: `_adaptiveSLTP` has structure `{ "HTF_BULL_LTF_PULLBACK": { sl_atr, tp_trim_atr, ... }, "_default": { ... } }`. Must look up by `[state]` then `["_default"]`, not by `.sl_atr` directly. [2026-03-02]
- **Calibration versioning prevents destructive apply**: Every `/calibration/apply` now snapshots all calibrated model_config keys to `model_config_history` with an incrementing version number. `/calibration/rollback` restores the previous version. Enables safe auto-apply in the learning loop. [2026-03-02]
- **Automated learning loop**: `scripts/learn-from-backtest.sh` runs: backtest → calibrate → apply → discover-moves → diagnose → measure before/after → save metrics → auto-rollback if SQN degrades >20%. Metrics appended to `data/learning-metrics.json` for trend tracking. [2026-03-02]
- **Data completeness is prerequisite for everything**: Before running any backtest or calibration, verify: (1) candle completeness via `scripts/audit-data-completeness.js`, (2) trail_5m_facts coverage via same script or `diagnose-missed-moves`. TwelveData has limited intraday depth (~6 months for 60m/30m/10m) so some gaps are inherent. D/W/M/240 go deep. [2026-03-02]
- **Split NO_TRAIL_DATA into coverage sub-causes before changing strategy**: A large `NO_TRAIL_DATA` bucket can hide three different realities: the ticker has no `trail_5m_facts` rows at all, the move happened before trail coverage started, or the move happened after coverage ended. On 2026-03-08 the current diagnosis was 203 `NO_TRAIL_DATA`, but that decomposed into 128 pre-coverage moves, 66 no-row tickers, 9 post-coverage moves, and 0 true internal gaps. Treat this as a coverage/backfill problem first, not an entry-signal problem. [2026-03-08]

## Follow-Up: Post-Replay Evaluation (after learning loop completes)

- **RESOLVED: Zero SHORT trades**: Root cause was `deep_audit_short_min_rank=80` (too high). The `ema_regime_confirmed_short` path already existed but was blocked upstream. Fix: lowered to 65 via model_config. Bear regime data shows positive EV (EARLY_BEAR: 46.7% WR, LATE_BEAR: 48% WR). [2026-03-02 → fixed 2026-03-03]
- **UPDATED: Low ticker diversity (54 of 128 tradeable)**: Initial fix lowered min_rank to 55 + max_completion to 0.55. But deeper analysis revealed the TRUE root cause: the 74 missing tickers were **never processed during replay** because `ingest_receipts` lacked historical data for them. The multi-ticker replay skips `timed_trail` rows with `payload_json=NULL` (all scoring-cron rows). Meanwhile, `timed_trail` shows these tickers at rank=99, kanban_stage="enter" — the system WANTED to trade them. Move discovery found **1,421 valid moves** (avg 6.4 ATR, 21.6%) across all 74 tickers. Fix: the next replay must use current `ingest_receipts` data (now available for all tickers since Feb 2026). For full historical replay, the replay engine needs to handle null payload_json by constructing payloads from `timed_trail` columns. [2026-03-02 → updated 2026-03-03]

## Trade Autopsy Analysis — March 2026

Based on manual classification of 373 trades (140 bad_trade, 131 bad_exit, 85 good_trade, 17 data_error):

- **SL too tight was the #1 problem**: SL at 0.21 ATR caused 165 sl_breached exits (33% WR, -$1,283). Meanwhile SOFT_FUSE_RSI exits had 83% WR and +$12,868. Widened SL from 0.21 to 0.55 ATR (between winner MAE p75=0.385 and p90=0.76). TP tiers adjusted: trim 1.5, exit 2.5, runner 3.5 ATR. [2026-03-03]
- **gold_long disabled**: 0% win rate across 8 trades, -$542 PnL. Calibration flagged DISABLE. Every trade classified as bad_trade or bad_exit. Commented out the entire pullback corridor entry block. [2026-03-03]
- **EARLY_BULL regime blocked**: 143 trades, 39.2% WR, -0.17 expectancy — the only regime with negative EV. Applied `block_entries=true` via adaptive_regime_gates. [2026-03-03]
- **24h loss cooldown activated**: 64 max_loss exits had 5% WR and -$12,029 PnL. The churn pattern: enter → SL hit → re-enter same ticker → SL hit again. `deep_audit_loss_cooldown_hours=24` enforces cooldown after losing exits. [2026-03-03]
- **Key insight: the edge is ema_regime_confirmed_long**: 357 trades, 41.2% WR, SQN=2.02. When SL stops killing winners and bad entries are filtered by regime gates, this path is solidly profitable (out-of-sample: 50.5% WR, 1.58 PF). [2026-03-03]
- **Config changes are hot-reloadable**: All 8 model_config keys update live without redeployment. Only code change was gold_long disable (requires worker deploy). [2026-03-03]
- **Post-trim SL tightening was killing runners**: After a trim, Phase 4c (1x ATR trail), DEFEND (breakeven), 3-tier protect (exact breakeven), and Daily EMA cloud boundary all competed to tighten the SL. Runners exited on normal pullbacks instead of riding the trend. Fix: skip Phase 4c, DEFEND, and cloud boundary for trimmed trades; use entry ± 0.5 ATR buffer instead of exact breakeven. H trade improved from $81 to $370. [2026-03-03]
- **Entry gate changes cause butterfly effects in replay**: Adding an LTF RSI alignment gate (block LONG when 10m RSI < 40 AND 30m RSI < 45) unintentionally changed which trades were open, which changed soft fuse evaluation timing, which prevented a trim from firing on an unrelated trade. Entry gates must be tested in isolation before combining with exit logic changes. Reverted for now. [2026-03-03]
- **Higher-TF RSI is stale during candle replay**: tf_tech RSI for 30m/1H/4H/D only updates when those bars close (every 30m/1h/4h/1d). Between closes, the OB gate sees stale values. A trade can enter when 30m RSI is actually 81 but tf_tech still shows 55 from the previous bar. Fix: include 10m RSI in the OB count — it updates every 5 minutes and catches intraday exhaustion the higher TFs miss. [2026-03-03]
- **SuperTrend gate via stDir**: Added stDir field to tf_tech bundles in indicators.js (was missing). Gate: block LONG when both 10m+30m stDir > 0, or 10m stDir > 0 AND 10m RSI < 45. Catches BWXT (both ST bearish, neutral RSI), GE (10m ST bearish + RSI 40.5). More targeted than wide RSI thresholds. [2026-03-03]
- **Daily Brief hallucination from stale ES/NQ data**: Scoring payloads (`timed:latest:ES1!`, `timed:latest:NQ1!`) go stale during backtests because replay overwrites KV. The AI then fabricated -6.52% drops and geopolitical narratives. Fix: (1) cross-reference all market data with `timed:prices` (TwelveData cron, reliable); (2) when ES/NQ data is stale or absurd (>5% change), copy daily change % from SPY/QQQ but NOT the literal price (different scale: SPY~$680, ES~$6800); (3) added anti-hallucination rules to system prompt — never fabricate %, use only provided data, flag anomalies; (4) lowered temperature from 0.5 to 0.35; (5) added cross-asset tickers (XLE, XLK, GLD, TLT) to price feed cross-reference. [2026-03-03]

## Ticker Learning System — Phase 0: Indicator Sanity Check

- **Local indicators match TwelveData with zero divergence**: Ran `scripts/indicator-sanity-check.js` comparing RSI(14), SuperTrend(3.0/10), ATR(14), EMA(21) across 5 tickers (AAPL, CAT, KO, SMCI, GLD) on both Daily and 30m timeframes. Result: 50/50 checks PASS, 0% mean error on all. Our `rsiSeries`, `superTrendSeries`, `atrSeries`, `emaSeries` in `worker/indicators.js` produce identical values to TwelveData's API endpoints when given the same candle data. This means we can safely use TwelveData's pre-computed indicators for historical data and trust that signal fingerprints will match what we compute at entry time. [2026-03-04]
- **Intraday timestamp format difference**: TwelveData returns daily datetimes as `YYYY-MM-DD` but intraday as `YYYY-MM-DD HH:MM:SS` (space, not `T`). Must normalize with `.replace(" ", "T")` before parsing as ISO. Initial run showed 25/25 daily PASS but 0/0 for 30m due to timestamp mismatch. [2026-03-04]

## Ticker Learning System — Phases 1-9

- **Full pipeline**: 546K daily candles (2020-present) → 54,221 moves → 269,905 lifecycle signals → 320 ticker profiles with personality, entry_params, long/short directional analysis → integrated into entry scoring + trade management + UI. [2026-03-04]
- **Personality classifications**: VOLATILE_RUNNER (146), PULLBACK_PLAYER (122), MODERATE (34), SLOW_GRINDER (17), TREND_FOLLOWER (1). Each drives trail_style (wide/adaptive/tight/standard) and SL/TP multipliers. [2026-03-04]
- **LTF signal drilldown (30m)**: 10m/30m candle data available from Feb 2024 for all 320 tickers. `build-ticker-learning.js` enriches origin+completion signals with 30m RSI and SuperTrend. 25,843 signals enriched. `build-ticker-profiles.js` incorporates `ltf_30m_rsi_mean_long`, `ltf_30m_st_aligned_pct` into entry_params. [2026-03-04]
- **Continuous learning loop**: `d1UpdateLearningOnClose()` fires on every trade close — appends outcome to rolling `recent_outcomes` (cap 50), incrementally adjusts SL/TP multipliers via 5% decay factor, computes rolling win rate, invalidates KV profile cache. [2026-03-04]
- **D1 bulk write optimization**: Direct `execD1` per-batch = 2s overhead each → 90min estimated. Solution: write SQL to chunk files (30 stmts/file, 20 move rows/INSERT, 40 signal rows/INSERT), execute via `wrangler d1 execute --file`. Reduced to ~15 min. `SQLITE_TOOBIG` if single file too large. [2026-03-04]
- **Candle loading optimization**: `OFFSET`-based pagination on 546K rows = 465s. Fix: query `DISTINCT ticker` first, then batch 15 tickers with `WHERE ticker IN (...)`. Reduced to ~55s. [2026-03-04]
- **LTF enrichment OOM**: Loading all 30m candles (2.5M rows) into memory caused OOM. Fix: process per-ticker-batch (load → compute indicators → enrich signals → free), never hold all 30m data at once. [2026-03-04]
- **ticker_profiles schema**: `learning_json` TEXT column stores the full learning profile. `personality` column does NOT exist as standalone — always extract from `learning_json`. Check existing rows before UPDATE vs INSERT to avoid missing non-nullable columns. [2026-03-04]

## Trail Style Integration

- **Personality-based trailing stops**: `_getTrailStyleMults(tickerData)` returns ATR multipliers by `__learning_trail_style`. Applied at 3 locations: Phase 4c pre-trim trail, 3-tier runner ATR trail, 3-tier non-runner post-trim buffer. Values: wide (1.5/0.75/3.5x), adaptive (1.0/0.5/2.5x), tight (1.0/0.4/2.0x), standard (1.0/0.5/2.5x). Tight floor raised from 0.75 to 1.0 to prevent premature stops. [2026-03-04]

## Early Exit Prevention

- **Phase 4c needs minimum hold time**: Without a hold guard, trailing and trim can fire on brand-new positions (1-2% spike → trail → normal pullback → stopped out). Added 15-min minimum hold before Phase 4c can activate, plus `trimMinAgeOk` (10 min) before PROFIT_PROTECT_TRIM. [2026-03-04]
- **DEFEND needs minimum hold time**: At pnl ≥ 3%, DEFEND was moving SL to breakeven regardless of position age. A 15-min-old position at 3.5% could be tightened and stopped on a normal pullback. Added `_posAgeMin >= 30` guard. [2026-03-04]
- **SuperTrend gate now applies to pullbacks too**: Previously, pullback entries (`HTF_BULL_LTF_PULLBACK`) were exempt from the LTF ST gate — allowed LONG when both 10m+30m ST were bearish. This let "breakdown, not dip" entries through. Removed the exemption: require at least one LTF ST aligned for all entries. [2026-03-04]

## Daily Brief Accuracy

- **Multi-Day Change Summary section**: Added explicit "Today" vs "5-day" values for ES/NQ/SPY/QQQ to both morning and evening AI prompts. The AI was mixing single-day and multi-day figures because `structureContext.fiveDayChangePct` was buried in nested JSON. Now surfaced as a first-class section with "NEVER estimate or calculate percentages yourself" instruction. [2026-03-04]
- **Anti-hallucination rule strengthened**: Rule #2 now directs the model to use "Multi-Day Change Summary" fields for all percentage statements. Previously just said "use dayChangePct values" which was ambiguous for multi-day narratives. [2026-03-04]

## Ticker-Level Learning System — Full Implementation [2026-03-04]

- **9-phase pipeline**: (1a) Backfill 546K daily candles 2020-present, (1b) local indicators match TwelveData exactly, (2) discovered 54K moves across 320 tickers via ATR-relative detection, (3) extracted 270K lifecycle signals (origin/growth/maturity/shakeout/completion), (4) computed signal precision per ticker (RSI zones, EMA alignment, ST precision), (5) built 320 personality-classified profiles (VOLATILE_RUNNER, PULLBACK_PLAYER, SLOW_GRINDER, MODERATE, TREND_FOLLOWER), (6) integrated into `qualifiesForEnter` (RSI zone + EMA alignment boosts), (7) integrated into trade management (SL widening for volatile runners, trail_style hint), (8) UI: Ticker Profiles sub-tab + Trade Autopsy learning card, (9) continuous learning loop on trade close.
- **Personality-based trail styles**: `_getTrailStyleMults()` returns ATR multipliers per personality. Wide (VOLATILE_RUNNER): 1.5x preTrim, 3.5x runner. Adaptive (PULLBACK_PLAYER): 1.0x/2.5x. Tight (SLOW_GRINDER): 0.75x/1.75x. Applied at Phase 4c pre-trim, 3-tier runner, 3-tier non-runner post-trim buffer.
- **LTF signal drilldown (30m)**: `build-ticker-learning.js` loads 30m candles for moves since Feb 2024, computes RSI-14 and SuperTrend at origin+completion phases. Stored in `rsi_30m`/`st_dir_30m` columns of `ticker_move_signals`. Profiles include `ltf_30m_rsi_mean_long/short` and `ltf_30m_st_aligned_pct`.
- **Continuous learning loop**: `d1UpdateLearningOnClose()` fires on every trade close. Appends outcome to rolling `recent_outcomes` (cap 50). Incrementally adjusts `sl_atr_mult` when MAE > SL on losses (5% decay), `tp_atr_mult` when MFE > TP on wins. Tracks `recent_win_rate`. Invalidates KV profile cache.
- **Optimized D1 writes**: Chunked SQL files (20 moves / 40 signals per INSERT, 30 statements per file) to avoid SQLITE_TOOBIG. Candle loading by batched ticker IN-clauses instead of OFFSET scans (55s vs 465s). Per-ticker-batch LTF enrichment to avoid OOM.
- **Daily Brief fix**: Added "Multi-Day Change Summary" section to both morning and evening prompts with explicit Today vs 5-day labels. Strengthened anti-hallucination rule #2: "NEVER compute percentages yourself — use ONLY the provided numbers."

## Entry/Exit Logic Gaps Identified [2026-03-04]

- **Pullback exemption bypasses ST gate**: When `state === "HTF_BULL_LTF_PULLBACK"`, the SuperTrend gate (block LONG when both 10m+30m bearish) is skipped. This can allow LONG entries into breakdowns mistaken for pullbacks. Fix: apply a weaker version of the gate even for pullbacks — require at least ONE of 10m/30m ST to be bullish.
- **Phase 4c has no minimum hold time**: Trail at pnl 1-2% and PROFIT_PROTECT_TRIM at pnl > 2% can fire immediately after entry. A quick spike to 1.2% triggers trailing; a normal pullback then hits the stop. Fix: require `trimMinAgeOk` (10min) before Phase 4c can fire.
- **DEFEND has no minimum hold time**: At pnl >= 3%, DEFEND tightens SL to breakeven even on 15-minute-old positions. A new position at 3.5% profit gets breakeven SL, then stops out on a normal pullback. Fix: add 30min minimum hold before DEFEND can tighten.
- **Tight trail style (0.75x ATR) too close**: SLOW_GRINDER personality uses 0.75x ATR pre-trim trail, which is very tight for volatile names. Floor at 1.0x ATR to prevent noise exits.

## Pre-Backtest CMT Enhancements [2026-03-04]

- **Replay now loads ticker_profiles from D1**: The candle-replay handler queries `ticker_profiles` at batch start and injects `_tickerProfile` into each ticker's existing state before `assembleTickerData`. Without this, backtest ran without personality-based SL/TP, trail styles, and entry boosts — making it diverge from live behavior. [2026-03-04]
- **Completion cap relaxed for regime-confirmed trends**: When `ema_regime_daily >= 1` (moderate-to-strong trend) aligned with entry direction, non-pullback `maxCompletion` raised from 0.40 to 0.55. Valid re-entries after a pullback often show 40-55% completion but still have room to run. Pullback cap unchanged at 0.60. [2026-03-04]
- **21 EMA gate relaxed from ±2 to ±1**: The 10m price-vs-21-EMA gate now bypasses when `ema_regime_daily >= 1` (was ±2). In a trending environment, healthy pullbacks dip below the 10m 21 EMA before bouncing — blocking at ±2 was too strict and excluded valid pullback entries. [2026-03-04]
- **TRANSITIONAL time exit extended 12d → 16d**: Swing trades in mixed environments need 2-3 weeks to develop. The 12-day loser exit for TRANSITIONAL regime was cutting valid trades short. Extended to 16 days to match typical swing trade duration. CHOPPY (7d) and TRENDING (20d) unchanged. [2026-03-04]
- **RSI Divergence detection added**: `detectRsiDivergence()` in indicators.js detects bullish/bearish RSI divergence via swing pivot comparison over 30-bar lookback. Wired into: (1) `computeTfBundle` as `rsiDiv` field on every TF, (2) `computeEntryQualityScore` as confirmation boost (+5 pts aligned, -3 pts counter), (3) `qualifiesForEnter` as LTF recovery confirmation alongside ST flip/EMA cross/squeeze release, (4) `computeRank` as rank boost (+3-7 pts aligned, -3 pts counter on 30m/1H), (5) `enrichResult` as confidence upgrade for pullback paths with aligned divergence. [2026-03-04]
- **Data completeness audit + Alpaca gap backfill**: Originally 184/274 tickers had complete candles (TwelveData intraday depth limit ~6 months for 5m/10m). Resolved by adding `?provider=alpaca` override to the worker's backfill endpoint and running targeted Alpaca backfill for 90 gap tickers across TF 10/30/60/240 — **2,500,941 bars** ingested. Post-backfill audit: 274/274 tickers have complete candle data (3 audit false positives: BRK.B stored as BRK-B per normTicker, FIG IPO'd Jul 2025, GOLD monthly timestamp parse artifact). Trail_5m_facts gaps (272 tickers starting Oct 2025) don't affect replay. Backtest can now start from **2025-07-01** with full coverage. [2026-03-04]
- **TT_TUNE_V2 reduced premature cloud exits in quick replay**: Added feature-flagged tuning (`TT_TUNE_V2`) to (1) soften strict 34/50 bias alignment in strong daily trends (D+1H anchored, allow 2-of-3), (2) add reclaim entry path (`tt_reclaim`) using 8/9 cross + ST flip confirmation, and (3) debounce cloud-loss exits with defend/trim-before-exit behavior. Quick validation replay (2025-07-01→2025-07-10, trader-only) completed cleanly: 27 trades, 20 wins, 7 losses, total realized PnL 13.94%, zero processing errors. [2026-03-04]
- **Custom ticker adds need two phases, not one**: A fast seed/score path is good for first paint, but it is not the same as "ready." The durable fix is: seed a usable card immediately, then run the full onboarding pipeline in the background and expose `timed:onboard:<ticker>` progress so the UI can distinguish "card exists" from "context/profile/history are complete." Context should be persisted worker-side from shared sources (TwelveData identity + richer profile enrichment), not reconstructed only in the UI. [2026-03-04]
- **tdBarToAlpacaBar silently dropped ALL intraday bars**: `tdBarToAlpacaBar()` in `worker/twelvedata.js` appended `"T00:00:00Z"` to space-separated intraday datetimes like `"2025-07-07 09:30:00"`, producing `"2025-07-07 09:30:00T00:00:00Z"` (unparseable → NaN). `_batchUpsertBars` skipped any bar where `!Number.isFinite(ts)`, so every intraday REST-sourced bar was silently lost (0 upserted, 0 errors). Daily/weekly/monthly bars worked because their datetime has no space (`"2025-07-07"` → `"2025-07-07T00:00:00Z"`). Existing intraday data came solely from the PriceStream WebSocket path, which uses `d1UpsertCandle` with pre-formed timestamps. Fix: replace space with `"T"` for intraday datetimes (`dt.replace(" ", "T") + "Z"`). [2026-03-09]
- **onboard-ticker.js must use TwelveData backfill, not alpacaBackfill**: `onboardTicker()` was hardcoded to call `alpacaBackfill()` from `indicators.js`, bypassing the provider-aware `backfill()` in `data-provider.js`. While `index.js` already had `if (_usesTwelveData(env))` guards elsewhere, onboard-ticker never checked the provider. Fix: import `backfill as tdBackfill` from `data-provider.js`, call it first, fall back to `alpacaBackfill` only when it returns null (Alpaca provider). [2026-03-09]

## Baseline Recovery & Backtest Archaeology [2026-03-10]

- **The "live protected" baseline was commit 2e55564 (Mar 4), NOT d59e258 (Mar 7)**: d59e258 was previously assumed to be the baseline because it was "the last known good commit." But the successful 60% WR backtest was run on March 5-6, with code deployed from 2e55564 ("fix: early exit prevention + ST gate for pullbacks"). Commit d59e258 introduced breaking changes (15m TF + leading_ltf overhaul). The code uses the **legacy entry engine** — no `ENTRY_ENGINE`, `RIPSTER_TUNE_V2`, or `resolveEngineMode` at all. ALWAYS verify the actual run timestamp against git log to identify the correct code version. [2026-03-10]
- **Backtest reset does NOT clear model_config**: `POST /timed/trades/reset` deletes trades, trade_events, direction_accuracy, calibration_trade_autopsy, positions, execution_actions, account_ledger, and KV trade caches. But `model_config` (consensus weights, deep audit configs, calibrated thresholds, adaptive gates) is preserved. This means each successive backtest run inherits learned state from prior runs. The live protected result (CSX/H/WMT/AMZN/HII/CAT on Jul 1) was the product of code + accumulated model_config from multiple learning iterations. Running the same code with empty model_config produces different trades because scoring weights and rank gates differ. [2026-03-10]
- **wrangler.toml ENTRY_ENGINE must match what the code reads**: Commit 2e55564 has no `resolveEngineMode()` and doesn't read `ENTRY_ENGINE`. Later commits (d59e258+) read `ENTRY_ENGINE` and return `"ripster_core"` or `"tt_core"`. If the deployed code doesn't recognize the engine name, it falls through to `"legacy"`, completely disabling TT-Core bias/cloud gates. Similarly, `RIPSTER_TUNE_V2` vs `TT_TUNE_V2` must match — the baseline reads `RIPSTER_TUNE_V2`, HEAD reads `TT_TUNE_V2`. [2026-03-10]
- **ripster → tt key rename requires both sides**: `indicators.js` stores cloud data under a key name (`ripster:` or `tt:`), and `index.js` reads from `?.ripster?.` or `?.tt?.`. If one side is renamed without the other, all cloud data reads return `undefined`, making TT-Core bias alignment fail 100% of the time → zero trades. The baseline (2e55564) uses `ripster:` / `?.ripster?.` consistently. HEAD renamed `indicators.js` output to `tt:` but left `index.js` reads as `?.ripster?.` — causing the zero-trade bug. [2026-03-10]
- **Golden profiles gate bypass needed for clean backtests**: `_goldenProfiles` from KV `timed:calibration:golden-profiles` enforces HTF/LTF score floors from a hindsight oracle. Stale golden profile data from prior calibration runs can block all entries. For clean backtests, bypass with `const _gp = null;` at line ~2643. Re-enable for production. [2026-03-10]
- **Kill ALL stale backtest processes before restarting**: `pkill -f full-backtest.sh` is essential. Zombie processes from prior killed runs hold replay locks, make D1 writes, and cause "D1 DB is overloaded" errors. Also delete `data/replay-checkpoint.txt` to prevent unintended `--resume` behavior. [2026-03-10]
- **2-pass calibration cycle needed for reproducible results**: The successful baseline was produced by: (1) seed backtest → (2) calibrate → (3) apply recommendations → (4) reset trades (preserving model_config) → (5) re-run backtest. A single-pass clean-slate run will produce different trades because the scoring weights and rank gates haven't been calibrated. To reproduce, either reconstruct the model_config or repeat the 2-pass cycle. [2026-03-10]
- **Deploying old code for backtesting breaks the live UI**: The backtest worker (`timed-trading-ingest`) and the live dashboard share the SAME deployment. Checking out an old commit (e.g., 2e55564 from March 4) and deploying it to run a historical backtest also replaces the live production code. Result: sparklines disappear, LTF scores show 0 (field name mismatch: `ripster` vs `tt`), and any post-baseline UI features vanish. **Prevention**: (1) Never deploy old code to production for backtesting — use a separate staging environment or `--env staging` in wrangler. (2) If old code must be deployed, document it as a temporary state and redeploy HEAD immediately after. (3) Long-term: create a dedicated `backtest` wrangler environment with its own worker name so backtests never touch the live deployment. [2026-03-10]
- **Never lose the working baseline — tag it in git**: The entire multi-day debugging session (Mar 9-10) stemmed from not having a clear record of which code + config produced the 57% WR live protected result. **Prevention**: (1) After any successful backtest promoted to live, `git tag baseline-YYYYMMDD` at that exact commit. (2) Export `model_config` to a JSON file (`data/model-config-snapshots/baseline-YYYYMMDD.json`) alongside the tag. (3) Document the full reproduction recipe (commit hash + wrangler.toml vars + model_config state) in a `BASELINE.md` file. This makes recovery a 5-minute operation instead of a multi-day archaeology project. [2026-03-10]

## Leading LTF Replay Parity [2026-03-11]

- **`LEADING_LTF` must flow through the whole scoring path, not just data fetch**: The 15m experiment had support in some candle-fetch paths, but `qualifiesForEnter()` and several scoring helpers still hard-coded `10m` fields. That let a nominal `LEADING_LTF=15` replay keep entering/exiting off `10m` alignment. Fix: propagate `leading_ltf` into the assembled ticker payload, prefer `15m` bundles in consensus/entry-quality/support-map logic when present, and make entry gates read the resolved leading TF instead of literal `"10"`. [2026-03-11]
- **Replay env overrides were being recorded, but not actually applied**: `full-backtest.sh --env-override LEADING_LTF=15` appended query params and stored them in run metadata, but `/timed/admin/candle-replay` never copied those values into the replay env. That meant the run registry claimed a 15m replay while the worker still scored with its default config. Fix: explicitly lift selected query params (`LEADING_LTF`, engine/tune overrides) into a replay-scoped env object and use that object for replay candle selection + `assembleTickerData()`. [2026-03-11]
- **`trigger_breached_5pct` was too eager for developing winners**: Management logic treated trigger-noise breaches as effectively critical even when the move was young, in a favorable PDZ, or already in profit. That produced the "exited too quickly" pattern seen in ITT/BABA. Fix: handle trigger-noise before the generic critical branch, routing profitable developing trades to `trim` and otherwise to `defend` unless the stop was truly breached. [2026-03-11]
- **Post-trim stop protection should scale with move maturity**: A first trim should prevent a winner from becoming an overall loser, but the exact stop should depend on how much of the target move has already traveled and how long the trade has been open. Fix: after trim, anchor the stop at breakeven-or-better, then progressively ratchet tighter using nearby structure plus a fraction of realized move only when the trade is older or materially through its runner path. [2026-03-11]

## Code Hygiene & Deployment [2026-03-12]

- **Always check for git merge conflict markers after merges**: Commit `aab433a` ("Merge branch 'main'") committed unresolved merge conflict markers (`<<<<<<<`, `========`, `>>>>>>>`) into `react-app/index-react.compiled.084ed3bfce.js`. This broke the entire homepage with `Uncaught SyntaxError: Unexpected token '<<'`. Prevention: after any `git merge` or `git pull`, run `grep -r '<<<<<<<' react-app/ worker/` before committing. If markers are found, resolve them manually. [2026-03-12]
- **Git-connected Pages deploys only via `git push`, not `wrangler pages deploy`**: When the Pages project has `Git Provider: Yes`, `wrangler pages deploy` creates a preview deployment but does NOT update production. Production only updates on `git push main`. The `wrangler pages deploy` output ("0 files already uploaded") is misleading — it uploads content but doesn't promote to production. Always use `git commit && git push` for production frontend changes. [2026-03-12]
- **Runs handler routes dropped by "restore" commits**: Commit `bac97f8` ("Restore Ripster baseline") accidentally removed all `/timed/admin/runs/*` route handlers from `worker/index.js`. The D1 data (`backtest_runs` table) survived because schema persists across deploys. Prevention: when restoring old code, diff the ROUTES array and handler sections to verify no endpoints were dropped. Also, runs handlers must use `requireKeyOrAdmin` (not `requireKeyOr401`) so that both API-key callers (scripts) and CF Access JWT callers (frontend UI) can authenticate. [2026-03-12]
- **Run metrics must be scoped by run_id, never global**: The finalize/refresh-metrics handler must query `WHERE run_id = ?1`, not `SELECT * FROM trades WHERE status IN (...)`. Without the run_id filter, every run gets identical metrics — whatever trades are currently in the `trades` table from the most recent backtest. The `summarizeRunMetrics(db, runId)` function first checks `backtest_run_trades` (archived trade copies for historical runs) then falls back to `trades WHERE run_id = ?1`. [2026-03-12]
- **Duplicate UI components cause overlay bugs**: The `system-intelligence.html` Runs tab had two `{detailRunId && (...)}` modal blocks — an old one and a new replacement. Both rendered simultaneously when `detailRunId` was set, creating a confusing stacked overlay. Prevention: search the file for the state variable name (`detailRunId`) before adding a replacement component, and remove the old one. [2026-03-12]
- **Admin endpoints called from frontend must use `requireKeyOrAdmin`, not `requireKeyOr401`**: The frontend sends CF Access JWT cookies via `credentials: "include"`. `requireKeyOr401` only checks the `?key=` query param, rejecting cookie-based auth with 401. `requireKeyOrAdmin` (async) tries API key first, then falls back to JWT validation. All `/timed/admin/*` endpoints accessed from the browser UI must use the latter. [2026-03-12]

## Run Data Archival & Sync [2026-03-12]

- **Finalize MUST archive trades, not just metrics**: Before this fix, `POST /timed/admin/runs/finalize` only computed metrics from the `trades` table and stored them in `backtest_run_metrics`. It never copied the individual trades. When the next backtest ran `reset` with `resetLedger=1`, all trades were `DELETE FROM trades`'d — gone forever. Fix: finalize now copies trades → `backtest_run_trades`, direction_accuracy → `backtest_run_direction_accuracy`, annotations → `backtest_run_annotations`, and model_config → `backtest_run_config` using `INSERT...SELECT`. This means every run's full dataset survives subsequent resets. [2026-03-12]
- **sync-d1.sh must use dynamic columns, not hardcoded**: The sync script had hardcoded column lists (12 for trades, 8 for DA). When D1 gained new columns via ALTER TABLE (e.g., `execution_profile_name`, `run_id`, `trim_price`), the local SQLite never got them. This caused `calibrate.js` to crash with `no such column`. Fix: use `SELECT *` and derive column names from the D1 response JSON. Also run `ALTER TABLE ... ADD COLUMN` on local DB for any missing columns. [2026-03-12]
- **Archive tables are the single source of truth for historical runs**: After a backtest completes, the live `trades` table only holds current-run data. Historical run data lives in `backtest_run_trades` / `backtest_run_direction_accuracy` / `backtest_run_annotations` / `backtest_run_config`. The `summarizeRunMetrics` function and `calibrate.js --run-id` both check archive tables first. [2026-03-12]
- **D1 reset wipes trades but NOT backtest_runs or archive tables**: `POST /timed/admin/reset?resetLedger=1` deletes from `trades`, `direction_accuracy`, `trade_events`, etc. But `backtest_runs`, `backtest_run_metrics`, `backtest_run_trades`, and other archive tables are NOT touched. This is by design — run history persists across resets. [2026-03-12]

## Replay Data Fidelity [2026-03-12]

- **VIX was static during replay — now uses historical candles**: Replay loaded VIX once from KV (`timed:latest:VIX`) at startup and used that single value for the entire backtest period. A Jul-Mar backtest used today's VIX for all 8 months. Fix: load VIX daily candles from D1 and binary-search for the correct VIX close per replay interval. Falls back to static KV if no candles available. Requires VIX daily candles to be backfilled via TwelveData. [2026-03-12]
- **Ticker profiles were never loaded during replay**: The live scoring path loads profiles from KV (`timed:profile:{ticker}`) and injects `_tickerProfile` into existing data. The replay handler never did this — `stateMap[ticker]` starts as `{}` with no profile. Fix: load all `ticker_profiles` from D1 once at replay start and inject `_tickerProfile` into existing data before `assembleTickerData`. This enables personality-aware SL/TP, entry threshold adjustments, and personality in signal snapshots. [2026-03-12]
- **Config snapshot must happen at register, not just finalize**: The plan requires recording the config snapshot at the START of a run for reproducibility. Previously, `backtest_run_config` was only populated at finalize (end of run). Fix: register handler now also runs `INSERT OR IGNORE INTO backtest_run_config SELECT ... FROM model_config`. Uses IGNORE so finalize's `INSERT OR REPLACE` can update if config changed mid-run. [2026-03-12]
- **`buildTradeLineageSnapshot` now captures ticker character and VIX**: Added `ticker_character` (personality, sl_mult, tp_mult, entry_threshold_adj, atr_pct_p50, trend_persistence) and `vix_at_entry` to the lineage object in `signal_snapshot_json`. This enables `trade-intelligence.js` to analyze personality × outcome and VIX × outcome without needing a join to `ticker_profiles`. [2026-03-12]
- **`model_config` can be empty**: All `deep_audit_*` gates use `Number(...) || 0` or check for null/empty arrays, so an empty `model_config` table means all gates are disabled (default values). Discovered during variant prep that no deep_audit configs had ever been written. [2026-03-12]

## Trade Autopsy UI [2026-03-12]

- **Chart TF switch race condition**: When user clicks a different TF button (e.g. 15m → 60m), the useEffect cleanup destroys the old chart, but the old in-flight fetch still resolves. It calls `candleSeries.setData()` on a destroyed series → throws → `.catch()` sets `setError("Failed to load chart")`, clobbering the new TF's chart. Fix: add a `cancelled` flag set in the cleanup; all `.then()` and `.catch()` handlers bail early if cancelled. Also reset `error` to null at the start of each effect run. [2026-03-12]
- **Same-ticker loss cooldown needed**: FIX was entered LONG three times in 24h (Jul 1–Jul 2). The thesis was correct but first two entries were premature — no bullish EMA cross, then SL too tight. A `deep_audit_loss_cooldown_hours` parameter should enforce a cooldown after a loss on the same ticker to prevent whipsaw re-entries. [2026-03-12]

## Variant B Analysis — Data-Driven Guards [2026-03-12]

- **15m EMA Cross direction is NOT predictive of win/loss**: Counterintuitive finding — 15m Bearish cross at entry had 60% WR (30 trades) vs 49.2% for Bullish (130 trades). The "both bearish" 15m+30m combo was the best at 72.2% WR. The system buys pullbacks into HTF trend, not LTF momentum. Do NOT add a "require bullish LTF cross" guard — it would hurt performance. [2026-03-12]
- **15m RSI < 45 on LONGs is a kill zone**: 21.4% WR (14 trades, 3W/11L). This is the strongest negative signal found. Added `deep_audit_ltf_rsi_floor` guard (DA-9). [2026-03-12]
- **15m EMA Depth < 5 is a weak signal**: 36.4% WR (11 trades, 4W/7L). No established trend depth = premature entry. Added `deep_audit_min_ltf_ema_depth` guard (DA-10). [2026-03-12]
- **SOFT_FUSE_RSI_CONFIRMED is the best exit**: 100% WR (14/14), avg PnL +5.75%. Only 2/14 classified as bad_exit. Defer logic should be very conservative — only when 1H+4H+D SuperTrend all aligned AND 1H EMA depth >= threshold. Added `deep_audit_soft_fuse_defer_min_1h_depth`. [2026-03-12]
- **28 trimmed trades gave back gains — but breakeven floor is too blunt**: 75 total trimmed trades; 46% of successful runners went below entry before recovering. A breakeven floor would kill nearly half the best trades. The real problem is SL-breached exits destroy runner value (-0.98% per trade vs trim), while SOFT_FUSE exits add value (+0.91% per trade). Solution: post-trim peak trailing stop (2% from high-water mark) improves total runner PnL by +54% (361.98% vs 234.79%) in simulation. Added `deep_audit_runner_trail_pct`. Breakeven floor (`deep_audit_post_trim_breakeven`) kept as secondary safety net. [2026-03-12]
- **43 trades held 24h+ with < 3% PnL = capital drag**: Compression/stall trades tie up capital without progress. Added `deep_audit_stall_max_hours` + `deep_audit_stall_breakeven_pnl_pct` to tighten SL to breakeven after extended stall. [2026-03-12]
- **Early entries (14) are NOT distinguishable by LTF signals**: 10/14 had bullish 15m cross, good depth, and reasonable RSI. The pattern is timing (entering at local extremes) and market-wide adverse moves, not poor signal quality. The RSI floor and depth floor guards catch the worst cases; the rest need structural/timing improvements. [2026-03-12]
- **Classification breakdown**: bad_trade (48): 1W/47L — nearly all losses. bad_exit (37): 25W/12L — wins that left money on the table. good_trade (29): 29W/0L. ok_trade (25): 24W/1L. early_entry (14): 1W/13L. The highest-impact improvements target bad_exit (post-trim protection) and bad_trade (entry guard tightening). [2026-03-12]
- **Squeeze Hold Guard has zero empirical basis**: Analyzed 133 SOFT_FUSE_RSI_CONFIRMED exits — 0 had sq30_on active at exit. The proposed guard (defer soft fuse when squeeze is on) would not have impacted a single historical trade. Decision: capture exit-time flags (sq30_on, sq30_release, fuel_status, swing_consensus_dir) for future data collection instead of implementing blind logic. [2026-03-12]
- **Lazy-load secondary UI modules for faster first paint**: Bubble Chart, Top Movers, and Upcoming Events are expensive to render. Deferring them via requestIdleCallback until after cards paint gives perceived 800ms+ improvement on initial load. [2026-03-12]

## Variant D Evaluation — Tier Sizing + All Guards [2026-03-12]

- **50.6% WR, PF 0.90, -$603 P&L on 85 closed trades** (Jul 2025 – Mar 2026). Not promotion-ready.
- **TRANSITIONAL regime is the kill zone**: 29% WR (7/24 trades). TRENDING regime is 60% WR (34/57). The system should avoid or heavily reduce size in TRANSITIONAL regime.
- **All trades entered in risk_off market state**: 82 of 82 closed trades. The entire backtest period was high-VIX risk-off. Execution profile was uniformly `choppy_selective`. Entry gating by market internals was not strict enough.
- **HIGH_VIX (>25) was present on 100% of losing trades** in the 8 worst tickers. VIX ranged 25.8–30.9 at entry. The system entered full-sized LONG trades during elevated VIX — needs a VIX ceiling guard.
- **max_loss exits are pure destruction**: 12 trades, 0% WR, -$1,963. These are trades that blew through SL and kept running. Seven of the 8 worst-ticker losses were max_loss or SL-breached. Tighter position sizing or VIX-gated entry would have avoided most.
- **SGI -$1,397 single trade (SOFT_FUSE exit)**: Entered TRENDING/BULL with 0.68 bias and VIX 26.1. The soft fuse fired but by then the trade was already -11.7%. This is a sizing problem — a single trade lost more than 1% of account value.
- **DPZ, ELF, TSLA all flagged TRANSITIONAL + HIGH_VIX**: Combined 10 trades, 1 win, 9 losses. These are textbook "don't trade in transition during risk-off" scenarios.
- **Setup tier system barely triggered**: Only 3 trades used the new Prime/Confirmed tiers. 79 of 82 used the legacy letter grades (B+, A-, A). The tier system needs to be the primary sizing path.
- **Focused replay script should skip backfill when candles exist**: Added `--skip-backfill` flag. Candle data persists in D1 from the full backtest; re-backfilling is redundant and wastes 2+ min per ticker. [2026-03-12]
- **Key action items**: (1) TRANSITIONAL regime gate — reduce size to 0.25x or skip, (2) VIX ceiling guard at 28 or entry size reduction above VIX 25, (3) Ensure 3-tier sizing is the primary path for all new trades.

## Saty Phase & ATR Exits — Bug Fixes [2026-03-13]

- **Phase exit "leaving" flags are instantaneous, not sticky**: `satyPhaseSeries()` compares `osc[last-1]` vs `osc[last]` to detect zone-leaving. This fires for ONE bar only. For 1H candles, the signal window is a single hour-long bar. If `processTradeSimulation` doesn't check during that exact interval, the signal is missed permanently. Fix: replaced instantaneous `leaving` detection with persistent **peak-decline tracking** in `execState`. Track `satyPhasePeak1H` and `satyPhasePeak30` (max directional oscillator value during the trade). Fire trim when peak was >= threshold AND current value has declined by a configurable amount. Configurable via `deep_audit_phase_peak_extreme` (80), `deep_audit_phase_decline_extreme` (30), `deep_audit_phase_peak_distrib` (50), `deep_audit_phase_decline_distrib` (25). [2026-03-13]
- **ATR Range Exhaustion thresholds were too strict**: Weekly displacement >= 1.0 ATR (full weekly ATR move) is very rare for intraday trades. Combined with dRangeOfATR >= 90% and PnL > 1.0%, the signal never fired in 421 trades. Fix: (1) Lowered weekly displacement from 1.0 to 0.786, secondary threshold from 0.618 to 0.500, dRangeOfATR from 90% to 70%. (2) Added daily horizon as independent signal source (dDisp >= 0.786 + dRange >= 70%, or dGateCompleted + dRange >= 80%). (3) Lowered PnL floor from 1.0% to 0.5%. [2026-03-13]
- **Backtest open positions bug — `<` vs `<=` comparison**: `full-backtest.sh` used `[[ "$END_DATE" < "$TODAY_KEY" ]]` to decide whether to close positions at end. When END_DATE equals today (the default when no end date specified), the comparison is false, and positions are kept open. This caused 37 phantom open positions in the saty-phase-atr-v1 backtest. Fix: always close positions at replay end unless `--keep-open-at-end` is explicitly set. [2026-03-13]

## RVOL Analysis & Multi-Factor Danger Score [2026-03-13]

- **RVOL was computed but never captured in trade artifacts**: `volRatio`, `rvol5`, `rvolSpike` computed per-TF in `computeTfBundle()`. `rvol_best` stored as column in `direction_accuracy`, but NOT included in trade-autopsy export, NOT in `signal_snapshot_json` lineage, NOT in `backtest_run_direction_accuracy` archive. All 86 prior backtest artifacts have zero RVOL data. Fix: added `rvol_best` + `entry_quality_score` to trade-autopsy query (both live and D1 paths), lineage snapshot (`rvol: { "30m", "1H", "D" }`), and backtest archival. [2026-03-13]
- **Retroactive RVOL analysis via TwelveData API**: Fetched 30m bars for 108 tickers, computed RVOL at each of 1,630 trade entries. Key finding: **RVOL 1.0–1.3 is the goldilocks zone (65.2% WR, +1.65% PnL)** — 9pp above overall 56.1%. High RVOL hurts: >1.3 = 50.7%, >1.8 = 49.3%, >2.5 = 51.6% WR. SHORTs with RVOL ≥1.3 had only 42.2% WR vs 58.6% for low-RVOL shorts. Correlation is weakly negative (r=-0.069). [2026-03-13]
- **RVOL ceiling gate (DA-11)**: System had a floor (dead zone) but no ceiling. Added `deep_audit_rvol_ceiling` (2.5 for LONGs) and `deep_audit_rvol_ceiling_short` (1.8 for SHORTs). RVOL between `high_threshold` (1.5) and ceiling reduces position to 50%. Verified: 13 blocks on July 1 replay. [2026-03-13]
- **Multi-factor danger score (DA-12)**: Composite of 7 factors from deep analysis of 431 trades. 0–1 danger signals = 73.9% WR; 3+ = 45.8% WR. Factors: Daily ST against (-25pp), 30m ST flat (-18.7pp), 1H EMA depth < 5 (-17pp), 4H ST against (-16.5pp), LTF ST flat (-16pp), VIX > 25 (-7.4pp), ST momentum < 3/5 TFs (-6.2pp). Trades exceeding `danger_max_signals` (3) are blocked; 2+ signals reduce size to 50%. Verified: 28 blocks on July 1 replay. [2026-03-13]
- **Danger score and RVOL are additive size reducers**: Both `__da_rvol_high_size_mult` and `__da_danger_size_mult` multiply against regime position size. A trade with high RVOL (0.5x) and 2 danger signals (0.5x) gets 0.25x size — preserving optionality while limiting risk. [2026-03-13]

## RSI Divergence + TD Sequential Awareness [2026-03-13]

- **TD Sequential counts captured in trade lineage**: Added `td_counts` to `buildTradeLineageSnapshot` with compact format `{ "15": { bp, bl, xp, xl }, "30": ..., "60": ..., "240": ..., "D": ... }`. Enables retroactive analysis of whether entries happen at exhaustion counts.
- **Retroactive TD count analysis (82 trades)**: LONGs entering when bearish prep count is 4-6 (building) have 26.3% WR vs 62.7% when fresh (0-3). LONGs aligned with bullish prep 4-6 have 71.4% WR. TD9 completion during trade shows modest improvement (52.9% vs 49.2% WR). Key insight: counter-exhaustion at entry is a strong negative signal.
- **RSI Divergence indicator (`detectRsiDivergence`)**: Uses `findSwingPivots` (existing function) + `rsiSeries` to detect bearish divergence (price higher-high + RSI lower-high) and bullish divergence (price lower-low + RSI higher-low). Returns `strength` (RSI gap in points) and `barsSince` (freshness). Only flagged `active` if `barsSince <= maxAge`. Exposed per-TF in `tf_tech.rsiDiv` and top-level `rsi_divergence` in `assembleTickerData`.
- **Divergence as danger score factor (DA-12 Factor 8)**: If LONG and bearish divergence active on 1H or 30m, increments `dangerCount`. If SHORT and bullish divergence active, same. Gated by `deep_audit_danger_div_enabled` config key.
- **RSI_DIVERGENCE fuse exit in trade management**: Sticky flag (`execState.rsiDivSeen`) — once divergence detected against open trade, it stays flagged. If untrimmed+profitable, trims to standard tier. If post-trim runner, tightens trailing stop to `deep_audit_div_runner_trail_pct` (1% default). Prevents the common pattern of entering on a pullback, trimming at the peak, then holding through the divergence-driven reversal to exit near BE.
- **Config keys**: `deep_audit_danger_div_enabled` (true), `deep_audit_div_exit_enabled` (true), `deep_audit_div_exit_min_strength` (3), `deep_audit_div_pivot_lookback` (5), `deep_audit_div_max_age_bars` (10), `deep_audit_div_runner_trail_pct` (0.01).
- **Mean Reversion TD9 Aligned entry path**: Implemented `detectMeanReversionTD9()` in `indicators.js` — fires when D+W+1H TD9 bullish aligned, Phase leaving accumulation/ext-down, RSI daily <= 30 + 1H <= 40, and at least 2/3 support conditions (daily FVG, weekly SSL, psych level). Feature-flagged via `deep_audit_mean_revert_td9_enabled` (default: false). Counter-trend sizing at 0.5x. Direction forced to LONG regardless of state. Helper primitives: `isNearPsychLevel()`, `td9AlignedLong/Short()`, `countRecentBearishFVGs()`.

## TD Sequential Entry Guard & Yield Optimization [2026-03-13]

- **Multi-TF TD analysis (82 trades, 5 TFs)**: Fetched 30m/1H/4H/D/W bars for all trade tickers. Key findings: (1) LTF bearish 4-6 at LONG entry → 26%/25% WR (counter-momentum), (2) D/W bearish 7-9 → 61%/58% WR (seller exhaustion = good for longs), (3) D+W both high prep ≥5 → 63.2% WR, (4) D TD9 bearish at entry → 80% WR (n=5), (5) Winners exit at D bearish prep avg=4.9 vs losses at 2.2.
- **Entry guard rewrite**: Original guard penalized D/W bearish exhaustion identically to LTF — this blocked exactly the trades that win most. Rewritten to: (a) only count 1H/4H as LTF exhaustion (block at 2+ TFs), (b) preserve D/W exemption for LONGs since seller exhaustion is favorable, (c) add panic guard at 4+ TFs all showing counter-prep ≥5 (41.2% WR, -1.05% avg PnL observed).
- **TD_EXHAUSTION_EXIT yield optimization**: Three-signal system wired into `processTradeSimulation`: (1) **D/W buyer exhaustion (bearish prep=9)** → trim if untrimmed+profitable, tighten trail to `deep_audit_td_exit_trail_pct` (1.5%) if post-trim. This is the INTU topping signal. (2) **LTF counter-prep building (30m/1H bearish ≥6 for LONG)** → tighten post-trim trail to `deep_audit_td_ltf_trail_pct` (2.0%). Early warning that selling pressure is building. (3) **4H favorable prep golden zone (4-6)** → HOLD signal tracked in `execState.td4hGoldenZone`. When active, momentum fade threshold raised from 2 to 3 signals, preventing premature exit during high-conviction moves (75% WR, +0.88% avg PnL).
- **Config keys**: `deep_audit_td_exit_enabled` (true), `deep_audit_td_exit_trail_pct` (1.5), `deep_audit_td_ltf_trail_pct` (2.0).

## TD Sequential Label Corrections & Candle Quality Insight [2026-03-13]

- **Label corrections in investor.js**: Several human-readable strings had bullish/bearish exhaustion labels swapped. Fixed: `bullish_prep` (price falling) = **seller exhaustion** (bounce potential). `bearish_prep` (price rising) = **buyer exhaustion** (drop potential). Scoring logic was already correct — only display strings were wrong.
- **TD9 candle quality on LTFs (observation)**: When a TD9 fires (prep count = 9), the quality of the completing candle matters — especially on 15m/30m. If in a LONG and 15m bearish TD9 fires but the candle is **bullish** (close > open), the exhaustion signal is weak — likely a recycled count that will reset for another countdown. If the candle is **bearish** (close < open), the exhaustion is confirmed by price action — more likely to see a pullback or mean reversion. This pattern is most observable on LTFs. **Future work**: capture candle polarity (close vs open) at TD9 completion and use it to weight signal strength in exit logic.

## Backtest Trade Autopsy: "Perfect Entry → Perfect Trim → Exit Too Late" Pattern [2026-03-13]

### Data (60 classified trades from October backtest)

**Entry evaluation breakdown:**
- `perfect_timing`: 31 trades, 90.3% WR, $58.71 avg PnL — **entry engine is working**
- `late_entry`: 26 trades, 46.2% WR, -$9.60 avg PnL — chasing hurts
- `chasing`: 13 trades, 38.5% WR, -$13.41 avg PnL — worst entry type
- `not_enough_confirmation`: 9 trades, 11.1% WR — almost always loses

**Trade management breakdown:**
- `perfect_trim`: 33 trades, 78.8% WR, $37.80 avg — **trim logic is working**
- `perfect_exit`: 10 trades, 90% WR, $48.71 avg — gold standard
- `exited_too_late`: 24 trades (40% of all!), 62.5% WR, $20.44 avg — **#1 problem**
- `exited_too_early`: 11 trades, 90.9% WR, $65.92 avg — early exit still profitable

### The Core Problem
24/60 trades (40%) classified as "exited too late." Even when trades win, they only capture a fraction of the available move:
- **Avg MFE capture: 31.4%** on perfect-entry + perfect-trim + exited-too-late trades
- **Avg time from trim to exit: 83.5 hours** (3.5 days!)
- **21/24 exited via `sl_breached`** — the stop eventually gets hit after giving back most gains
- Trades like AWI: MFE=2.21%, final PnL=+0.08% (4% capture). FIX: MFE=5.17%, final PnL=-0.12% (negative capture!)

### Root Cause
After the first trim, the "runner" portion sits with:
1. `deep_audit_runner_trail_pct = 2.0%` trailing from peak — too wide for small-cap swing trades
2. `deep_audit_post_trim_trail_pct = 2.0%` — same problem for pre-runner trimmed positions
3. **`deep_audit_stale_runner_bars = 0` (DISABLED!)** — the stale runner timer that would snap SL tight when the move stalls is completely off
4. No mechanism to recognize the new swing high after trim as a natural exit point

### The Fix: Tighter Post-Trim Exit Management
1. **Enable stale runner timer**: Set `deep_audit_stale_runner_bars` to 16 (4 hours of 15-min bars). If the post-trim peak hasn't updated in 4 hours, snap SL to 0.25x ATR from current price. This catches the exact "consolidation after swing high" pattern.
2. **Tighten post-trim trail**: Reduce `deep_audit_post_trim_trail_pct` from 2.0% to 1.5%. The data shows winners peak quickly then consolidate — 2% gives back too much.
3. **Tighten runner trail**: Reduce `deep_audit_runner_trail_pct` from 2.0% to 1.5%. Same logic — the runner phase also bleeds gains.

### Why Not Exit Earlier?
`exited_too_early` trades actually had the best avg PnL ($65.92) and 90.9% WR. The system is too cautious about locking in profits after the swing high post-trim. The data strongly says: **lock it in faster.**

## Backtest-Driven System Tuning: 6 Fixes Applied [2026-03-10]

Based on 60 classified trades from October backtest and auto-recommendation analysis (27 findings):

### 1. SOFT_FUSE_RSI — Lower Arm Threshold (code)
- **Before**: RSI 1H >= 75 (LONG), <= 25 (SHORT)
- **After**: RSI 1H >= 70 (LONG), <= 30 (SHORT)
- **Why**: SOFT_FUSE_RSI_CONFIRMED was the best exit signal (100% WR) but only triggered 5x. Lowering threshold by 5 pts catches more swing highs before they reverse. The "exit too late" pattern (40% of trades) occurs because RSI peaks at 70-74 and doesn't quite reach 75.

### 2. Multi-TF RSI Chase Gate — Tightened (code)
- **Before**: Block LONG when 2+ of (30m, 1H, 4H, D) have RSI > 68
- **After**: Block LONG when 2+ TFs have RSI > 65, SHORT when 2+ TFs have RSI < 35
- **Why**: `late_entry` (46% WR, -$9.60 avg) and `chasing` (38% WR, -$13.41 avg) are the two worst entry classifications. Tightening by 3 pts catches entries where 2+ TFs are already extended.

### 3. Investor Engine — Reduce Threshold Lowered (code)
- **Before**: `investorScore < 50` → stage "reduce" → exit
- **After**: `investorScore < 40` → stage "reduce" → exit
- **Why**: Investor engine had 17.2% WR and -$2,575 total. Positions enter at score >= 70 but score can oscillate to 49 next day, triggering immediate exit. Scores 40-50 now route to "watch" stage (existing 50-65 catch), giving positions time to recover from normal fluctuations.

### 4. VIX Ceiling — Enabled (D1 config)
- **Before**: `deep_audit_vix_ceiling = 0` (disabled)
- **After**: `deep_audit_vix_ceiling = 30`
- **Why**: Analysis showed VIX > 25 correlated with significantly worse outcomes. Size reduction already exists at VIX 25 (0.75x) and 35 (0.5x), but no hard ceiling. Now blocks all new entries when VIX > 30.

### 5. Avoid Hours — Added Noon (D1 config)
- **Before**: `deep_audit_avoid_hours = [13]` (1 PM ET only)
- **After**: `deep_audit_avoid_hours = [12,13]` (noon + 1 PM ET)
- **Why**: Midday chop (12-1 PM ET) produced the worst entries in the backtest. Both hours now blocked.

### 6. SHORT Entry Gate — Relaxed (D1 config)
- **Before**: `deep_audit_short_min_rank = 70`
- **After**: `deep_audit_short_min_rank = 60`
- **Why**: Zero SHORT trades taken in the backtest. The rank threshold of 70 was too restrictive given that most tickers don't score that high on bearish signals. Lowering to 60 allows the system to take high-confidence SHORT entries.

### Combined with previous session's exit fixes:
- `deep_audit_stale_runner_bars`: 0 → 16 (enabled)
- `deep_audit_post_trim_trail_pct`: 2.0% → 1.5%
- `deep_audit_runner_trail_pct`: 2.0% → 1.5%

## Investor Signal Integration [2026-03-10]

- **Momentum Health scoring adjustment**: Added `momentumHealth` component (-10 to +5 pts) to `computeInvestorScore`. Penalizes: weekly bearish divergence (-8), D/W TD bearish prep ≥7 (-5), weekly Phase distribution (-3), daily EMA regime ≤-2 (-4). Rewards: weekly Phase accumulation (+5). Prevents high scores on tickers at exhaustion points.
- **Accumulation zone signal enrichment**: Enhanced `detectAccumulationZone` with weekly bullish divergence (+25 confidence), TD seller exhaustion (+15), Phase accumulation (+20), and penalties for bearish divergence (-20) and daily buyer exhaustion bounce (-15). Provides better confirmation that a dip is a buying opportunity vs the start of a larger decline.
- **Stage classification signal overrides**: `classifyInvestorStage` now downgrades to `watch` on weekly bearish divergence, weekly TD buyer exhaustion (prep ≥8), or weekly Phase leaving distribution. Upgrades `watch` → `core_hold` when weekly bullish divergence is active (selling pressure weakening — hold, don't reduce).
- **Adaptive trailing stop**: Investor exit logic tightens trail from 3x ATR to 2x ATR when topping signals fire (weekly TD bullish prep ≥7, weekly bearish divergence, or weekly Phase distribution+leaving). Protects gains as exhaustion signals mount.
- **Signal-based profit trim**: Core hold positions with ≥5% profit auto-trim 20% when topping signals fire, locking in gains before potential reversal.
- **DCA divergence gate**: Skips DCA buys when daily bearish RSI divergence is active, preventing dollar-cost averaging into deteriorating momentum.
- **Thesis enrichment**: `generateThesis` now includes dynamic sentences for divergence ("uptrend may be losing steam"), TD exhaustion ("selling pressure elevated"), Phase accumulation ("favorable entry timing"), and distribution warnings. `checkThesisHealth` detects new invalidation conditions: weekly divergence confirmed with SuperTrend breakdown, and dual D+W buyer exhaustion.
- **Key principle**: All signals are adjustments to the existing Weekly/Monthly SuperTrend + RS + Ichimoku foundation, not replacements. They refine timing (when to accumulate, trim, tighten stops) rather than changing fundamental trend assessment.

## Phase 3+4 Indicator Tuning & SHORT Enablement [2026-03-10]

### Phase 4: Entry/Exit Indicator Tuning

**TD Sequential entry block (code)**
- **Before**: Block only when BOTH 1H and 4H show exhaustion (prep >= 7 or leadup >= 8)
- **After**: Block when ANY single TF at 1H or 4H shows exhaustion
- **Why**: Backtest showed LTF (30m/1H) bearish prep at LONG entry → 25-26% WR. Even one TF signaling exhaustion is predictive.

**Phase exits expansion (code)**
- PHASE_LEAVE_100: peak threshold 80 → 70, decline threshold 30 → 25
- PHASE_LEAVE_618: peak threshold 50 → 40, decline threshold 25 → 20
- Runner close now fires after TRIM-level (33%+), was EXIT-level (66%+)
- **Why**: PHASE_LEAVE_100 was the best single trade ($252, 100% WR) but fired only once. Lower thresholds catch momentum exhaustion earlier.

**RSI divergence trim (code)**
- Added 4H timeframe to divergence scan (was only 1H + 30m)
- Lowered minimum strength from 3 to 2
- **Why**: Divergence already had correct logic but was too conservative. 4H divergence is a stronger structural signal.

**4H SuperTrend flip as exit signal (code)**
- Added `st_flip_bull` flag in indicators.js (was never set — SHORT exits broken)
- Added `st_flip_4h` flag tracking
- New fuse exit: `ST_FLIP_4H_CLOSE` — closes runner when 4H ST flips against direction post-trim
- New fuse trim: `ST_FLIP_4H_TRIM` — trims when untrimmed and 4H ST flips
- **Why**: 4H ST flip is a structural break. Previously only 30m/1H flips triggered the weaker Kanban trim. Now 4H flip is a full exit signal for runners.

### Phase 3: Enable SHORT Trades

**CHOPPY regime (indicators.js)**
- `shortsAllowed`: false → true
- `shortRvolMin`: Infinity → 1.5
- SHORTs in CHOPPY now require RVOL >= 1.5 (institutional selling visible) plus all existing quality gates (minHTFScore 25, minRR 3.0, maxCompletion 0.30)

**TRANSITIONAL regime (indicators.js)**
- `shortRvolMin`: 1.3 → 0.7
- **Why**: Old 1.3 threshold was too restrictive; most tickers don't see RVOL > 1.3 on normal bearish moves.

**Bearish momentum path (index.js)**
- `HTF_BEAR_LTF_BEAR` now uses proper bearish signals: `st_flip_bear`, `hasEmaCrossBear`, `hasSqRelease`
- **Before**: Used bullish signals (`hasStFlipBull`, `hasEmaCrossBull`) even for bearish momentum — SHORT entries were structurally broken
- New path: `momentum_score_short` with reason `momentum_bear_with_signal`

**`deep_audit_short_min_rank`** (D1 config, applied in prior session): 70 → 60

## Smart Runner Exit Engine + Danger Score Bug Fix [2026-03-10]

### CRITICAL BUG: Inverted SuperTrend danger scoring

**`dirSign` in danger scoring system (index.js line ~2541)**
- **Before**: `const dirSign = isLong ? 1 : -1;`
- **After**: `const dirSign = isLong ? -1 : 1;`
- **Impact**: Pine convention uses `stDir = -1` for bullish, `stDir = 1` for bearish. The old code used `dirSign = 1` for LONG, which caused three danger factors (Daily ST, 4H ST, ST alignment count) to fire on ALIGNED SuperTrend and MISS OPPOSED SuperTrend.
- **Evidence**: 4 of 10 losses (-$1,209, 80% of total loss) entered LONG with 4H ST bearish. The danger system was supposed to catch these but didn't because the check was inverted.
- **Affects**: Danger Factors 1 (Daily ST), 4 (4H ST), and 7 (multi-TF ST alignment count).

### Smart Runner Exit Engine (new)

**Problem**: 20 of 56 wins exited via `sl_breached` after trim, averaging $49 and dragging 41 hours. The 33% trim captured a small slice; the 67% runner gave it back.

**Part 1: Raise trim from 33% to 66% (index.js)**
- `THREE_TIER_DEFAULTS.TRIM.trimPct`: 0.33 → 0.66
- `THREE_TIER_DEFAULTS.EXIT.trimPct`: 0.66 → 0.90
- **Why**: Simulation showed 66% trim adds +3.1% total PnL by locking in more at first target. The 34% runner is now a "free lottery ticket."

**Part 2: `evaluateRunnerExit()` function (index.js)**
- Runs every bar after trim for the remaining 34% runner position.
- Returns `{ action: "hold"/"close"/"tighten", reason }`.
- Evaluates 5 price-action conditions using signals already on `tickerData`:
  1. **Squeeze detection** (checked first): If 30m or 1H squeeze is on → HOLD. Compression precedes expansion. If squeeze releases against trade direction → CLOSE.
  2. **Swing high/low failure**: Price approached previous daily swing pivot (within 0.5×ATR) but failed to break → CLOSE. Confirmed by 1H ST flip or RSI declining.
  3. **Support/resistance break**: LONG breaks below 1H Ripster c34_50 cloud AND 30m ST flips bearish → CLOSE. Replaces arbitrary trailing % with structural support.
  4. **TD Sequential exhaustion**: 1H or 4H counter-direction prep count >= 7, combined with RSI or phase declining from peak → CLOSE.
  5. **Momentum consensus flip**: `swing_consensus.direction` opposes trade AND fuel is "critical" → CLOSE.
- Fires AFTER existing fuse exits (PHASE_LEAVE, SOFT_FUSE, ST_FLIP, RSI_DIV, TD_EXHAUST) but BEFORE trailing SL.
- Gated by `smart_runner_min_bars_post_trim` (default 4 bars = 1 hour) to give runner a chance.

**Config keys added to model_config:**
- `smart_runner_exit_enabled`: true (toggle)
- `smart_runner_swing_atr_proximity`: 0.5 (ATR multiplier for swing approach detection)
- `smart_runner_min_bars_post_trim`: 4 (grace period after trim)

### Loss Autopsy Summary (backtest 2025-07 through 2025-12)

| Category | Trades | PnL | Root Cause | Fix |
|---|---|---|---|---|
| LONG w/ 4H ST bearish | 4 | -$1,209 | Inverted danger dirSign | Bug fix |
| Low R:R (< 1.5) | 3 | -$535 | R:R gate bypass | Covered by danger fix |
| Acceptable small losses | 3 | -$80 | Normal trading | N/A |

Key stat: SHORTs performed strongly (83% WR, +$2,508 PnL), validating the Phase 3 SHORT enablement.

### Follow-up: dirSign Revert — "Bug" Was a Feature

**First rerun with corrected dirSign** produced 362 trades at 57.7% WR ($978 PnL). **Second rerun** with `danger_max_signals=2` produced 298 trades at 54.4% WR (-$1,406 PnL). Both dramatically worse than baseline (49 trades, 79.6% WR, $20K PnL).

**Root cause analysis**: The "inverted" dirSign (`isLong ? 1 : -1`) was accidentally creating a powerful pullback-only entry filter. In Pine convention, bullish stDir=-1. The old code penalized entries where SuperTrend was aligned (stDir=-1 for LONG → `-1 !== 1` → danger fires). In a trending market, most LONG entries have bullish ST alignment, so the danger system blocked ~85% of entries. Only deeply pulled-back setups (where LTF ST temporarily flipped bearish) could pass with low danger counts.

**Decision: REVERT dirSign** to `isLong ? 1 : -1` (the original "bug"). The accidental pullback filter was producing 80% WR. The correct convention (`isLong ? -1 : 1`) floods the system with 6x more entries that other gates can't adequately filter. Revert `danger_max_signals` to 3 as well.

**Key lesson**: Not all "bugs" should be fixed. When an accidental behavior produces excellent results, understand WHY it works before changing it. The inverted dirSign acted as a structural pullback filter — an extremely valuable property for a swing trading system.

### Pullback Support Shield (2026-03-14)

**Problem**: Trades with good entries and trims were exiting during healthy pullbacks that tested and held the 15m SuperTrend or 72-89 Ripster cloud. The smart runner exit fired `support_break_cloud`, `swing_high_failure`, or `momentum_flip_fuel_critical` prematurely because it only checked 1H/30m structure — not the intraday support levels that actually mattered.

**Fix**: Added a pullback support shield to `evaluateRunnerExit()` that checks 4 levels before allowing any close signal:
1. **15m SuperTrend** — if still aligned with trade direction and price holds it (±0.1 ATR tolerance)
2. **15m 72-89 cloud** — if price is above cloud bottom (LONG) or below cloud top (SHORT)
3. **15m 34-50 cloud** — secondary support (tighter tolerance ±0.05 ATR)
4. **30m 72-89 cloud** — broader structural support

If ANY of these hold, close signals from conditions 1 (swing failure), 2 (1H cloud break), 3 (squeeze release against), and 5 (momentum flip) are overridden to HOLD. Condition 4 (TD exhaustion) is NOT overridden — exhaustion is structural.

Also widened trail percentages: `runner_trail_pct` 1.5% → 2.5%, `post_trim_trail_pct` 1.5% → 2.5% to give normal pullbacks room.

### Position Sizing Uplift (2026-03-14)

**Problem**: Wins and losses were miniscule despite good entries. Previous live protected run: 57% WR, $14k+ P&L. Backtest: similar WR but tiny $ amounts. Root cause: tier risk percentages too conservative (Prime=1%, Confirmed=0.5%, Speculative=0.25%).

**Fix**: Doubled all tier risk percentages — Prime=2%, Confirmed=1%, Speculative=0.5%. Updated `grade_risk_map` proportionally (A+=2000, A=1700, etc.). Raised `MIN_NOTIONAL` $500→$1000, `MAX_NOTIONAL` $8k→$20k. Position cap remains at 20% of account to prevent concentration risk.

**Baseline saved**: `data/baseline-config-snapshot.json` + git tag `baseline-good-entries-20260314`.

### B to A+ Exit Intelligence Upgrade (2026-03-15)

**Problem**: 70% WR with good entries but only capturing 56% of available MFE (avg 1.61% of 3.24% MFE). Three specific exit weaknesses:
1. CLOUD_BREAK exits at 29% capture efficiency — closing on 1H cloud + 30m ST without checking 4H structure
2. Trades reaching 1%+ MFE without trimming, then reversing into -$1,175 in losses
3. Runner blowups (RKLB -31%, HOOD -15%) with no drawdown cap from peak

**Fixes applied**:
1. **4H SuperTrend gate on CLOUD_BREAK and SQUEEZE_RELEASE**: If 4H ST still supports the trade direction, demote close → "defend" (tighten trail to 1x ATR). Only close if 4H confirms the break.
2. **MFE Safety Trim**: Force 66% trim when unrealized P&L >= 1.2% and position is untrimmed. Config: `deep_audit_mfe_safety_trim_pct = 1.2`.
3. **Runner Circuit Breaker**: Close runner immediately if drawdown from peak >= 8%. Config: `deep_audit_max_runner_drawdown_pct = 8`.
4. **Adaptive Trail**: Runner ATR multiplier is now 3.0x when 4H supports, 1.5x when 4H breaks (replaces static 2.5x).

**Results** (exit-upgrade-v1, Jul-Dec 2025):
- Win Rate: 69.3% → **71.3%** (+2 pp)
- P&L: $4,217 → **$5,356** (+27%)
- Avg Loss: -$170 → **-$159** (improved)
- Profit Factor: 1.71 → **2.08** (+22%)
- Account Uplift: 4.2% → **5.36%** (on $100k starting balance)
- CLOUD_BREAK wins: 18 → 9 (trades now hold longer, exit via PHASE_LEAVE instead)
- PHASE_LEAVE wins: 28 → 34 (+6 trades captured at higher efficiency)
- Losses: 35 → 31 (-4 fewer losses)

### Exit Upgrade v2: Bug Fixes + Safety Nets (2026-03-15)

**Problem**: RKLB trade lost -$1,088 despite circuit breaker being in place. Root cause:
1. MFE Safety Trim trimmed 66% but did NOT set a protective stop — runner bled out with no floor
2. Circuit breaker tried to set SL to current mark, but the SL-tightening guard rejected it (can't move stop "downward" for longs)
3. Low Entry Quality trades (EQ<55) net -$583 ($1,835 in losses vs $1,252 in wins)

**Fixes applied**:
1. **Circuit Breaker moved to direct-close**: Now runs before evaluateRunnerExit and calls `closeTradeAtPrice` directly instead of trying to set SL through the guard
2. **MFE Safety Trim sets protective stop**: After trimming, calls `selectPostTrimProtectiveStop()` and sets SL to at least entry price (breakeven)
3. **Entry Quality gate**: Block entries with EQ < 55. Config: `deep_audit_min_entry_quality = 55`
4. **Per-trade hard loss cap**: Close any trade losing >= $300. Config: `deep_audit_hard_loss_cap = 300`
5. **Relaxed entry gates to increase trade volume** (108 trades in 6 months was too low):
   - `calibrated_rank_min`: 55 → 40
   - `deep_audit_min_htf_score`: 0.4 → 0.25
   - `deep_audit_min_1h_bias`: 0.25 → 0.15
   - `deep_audit_min_4h_bias`: 0.25 → 0.15
   - `deep_audit_ltf_rsi_floor`: 45 → 38
   - `deep_audit_min_ltf_ema_depth`: 5 → 3
   - `deep_audit_danger_max_signals`: 3 → 4
   - Per-path rank minimums: confirmed 50→35, breakout 70→50
   - Removed redundant EQ<55 smart gate (already enforced by vol-tier EQ gate in qualifiesForEnter)
6. **Added blocked-entry diagnostics**: Replay now tracks every gate rejection reason and reports cumulative stats at backtest end

### Calibrated-v3: Signal Journey + Liquidity + SHORT Fixes (2026-03-15)

**Findings from deep analysis of 219 trades (clean-launch-v1 backtest)**:

#### Entry Quality Inversion (FIXED)
- Old EQ formula rewarded full alignment across all TFs — but best entries happen on PULLBACK RECOVERY when LTF is still recovering from bearish
- Winners: EQ avg 73.86 vs Losers: EQ avg **77.63** (inverted!)
- New formula: HTF Foundation (30 pts: 4H+D alignment), LTF Recovery (35 pts: rewards pullback recovery, penalizes full alignment), Confirmation (35 pts: regime+phase+RSI)
- Key pattern: `pullback_recovery` (1H ST bearish, 15m flipping bullish) gets highest LTF Recovery score

#### 1H SuperTrend "Late Entry" Signal (APPLIED)
- Confirmed losers: 83% entered with 1H ST already bullish vs 65% of winners
- Untrimmed trades (14% WR): 80% had 1H+30m both bullish at entry
- Fix: Downgrade confidence (affects sizing/grade) when 1H+30m fully extended

#### Stall Force-Close (ADDED)
- Untrimmed trades: 85 trades, 14.1% WR, -$10,340 P&L (the #1 drag)
- Confirmed untrimmed: 49 trades, 6.1% WR — essentially guaranteed losers
- Fix: Force-close untrimmed trades after 36 hours. Config: `deep_audit_stall_force_close_hours = 36`

#### SHORT Logic Bugs (FIXED)
1. **DA-4 HTF gate blocked ALL shorts**: `htf < daMinHtf` with daMinHtf=0.25 blocks all negative HTF (all shorts). Fixed to be direction-aware.
2. **ema_regime_early_short used `hasStFlipBull`**: Bullish ST flip as confirmation for SHORT = wrong direction. Fixed to `flags.st_flip_bear`.
3. **GOLD SHORT relaxed**: Thresholds lowered from htf>=35 to htf>=30, added RSI divergence as confirmation.

#### Setup Lead-Up Phase (ANALYSIS COMPLETE, IMPLEMENTATION PLANNED)
Current system only captures signals AT entry, not the build-up before. Missing:
- TD9 reversal in opposite direction (SP=9 before LONG = powerful reversal signal)
- RSI extreme recovery (recent extreme + bounce = ideal entry window)
- Phase oscillator completion (satyPhase leaving signal = move exhausted)
- ST flip freshness (3-15 bars since flip = recovery window)
- Per-ticker personality (base-builder vs breakout vs mean-revert)

#### Liquidity Zone Integration (IMPLEMENTED — 2026-03-15)

**Evidence** (231 trades, full 4H candle backfill — 126,263 bars, 203 tickers):
- 4H 3+ pivot zones: 74% coverage, $352/trade P&L delta (zone reached: +$219 vs NOT: -$133)
- MFE hit rate: 68% of trades had peak price reach the zone (we just exited too early)
- Congested entries (<0.5 ATR from zone): 48.5% WR vs 56.8% for entries with room
- "What if" zone-based exits: +$2,983 additional P&L on same entries

**Changes applied** (`worker/indicators.js`, `worker/index.js`):

1. **Phase 1A — Persist liquidity in snapshots**:
   - Expanded `liq_4h` to include full `buyside`/`sellside` zone arrays
   - Added `liq_W` (Weekly) to `assembleTickerData`
   - Added compact `liq` snapshot to `buildTradeLineageSnapshot` (4H/D/W distances + counts)

2. **Phase 1B — EQ congestion penalty** (`computeEntryQualityScore`):
   - New `liqData` parameter, 4H primary / Daily fallback
   - -10 pts when <0.5 ATR from zone (congested), -5 pts at 0.5-1.0 ATR
   - +5 pts when 1.5-4.0 ATR (ideal room to run)

3. **Phase 1C — Runner management** (`evaluateRunnerExit`):
   - Computes nearest 4H liquidity target (buyside for LONG, sellside for SHORT)
   - `liq_zone_approach`: tighten trail when within 0.3 ATR of zone
   - `liq_zone_swept`: tighten trail when price moves 0.5+ ATR past zone

4. **Phase 1D — Entry rejection filter** (`qualifiesForEnter`):
   - Blocks entries within 0.5 ATR of 3+ pivot zone when momentum is weak
   - Logged to `_replayBlockedEntries` for backtest diagnostics

#### Setup Lead-Up Phase / Lookback Features (IMPLEMENTED — 2026-03-15)

**Gap identified**: System only captured signals AT entry, missing the "stalking" build-up phase (TD9 reversals, RSI extreme recovery, Phase completion, ST flip freshness).

**Changes applied** (`worker/indicators.js`):

1. **Phase 2A — Lookback features in `computeTfBundle`**:
   - `rsiWasExtremeLo15` / `rsiWasExtremeHi15`: RSI hit extreme in last 15 bars + recovered
   - `stFlipFresh`: SuperTrend flipped 3-15 bars ago (ideal recovery window)
   - Returned as `lookback` object on each bundle

2. **Phase 2B — Lookback bonus in `computeEntryQualityScore`**:
   - +5 pts for TD9 opposite exhaustion (opposing setup recently completed)
   - +4 pts for RSI extreme recovery
   - +3 pts for fresh ST flip on leading TF
   - Capped at +12 pts total

#### Investor Mode Improvements (IMPLEMENTED — 2026-03-15)

**Gaps identified**: Daily ST not in scoring, peak_price reset daily, no D/W/M alignment gate.

**Changes applied** (`worker/investor.js`, `worker/index.js`):

1. **Daily SuperTrend scoring**: +5 pts when D+W both bullish, +3 pts when D only
2. **Persistent peak_price**: Schema migration (`v2`), high-water mark tracked across all scoring cycles for accurate trailing stop
3. **D/W/M SuperTrend alignment gate**: Monthly bearish = hard block on new entries, require 2/3 bullish minimum

#### TD Sequential Replay Gap (FIXED — 2026-03-16)

**Critical bug discovered**: `computeTDSequentialMultiTF()` was NEVER called during candle-replay backtests. Only the synchronous `assembleTickerData()` was used (line 3354, indicators.js), which does NOT compute TD Sequential. The async `computeServerSideScores()` (which DOES compute it) was only used in live scoring.

**Impact**:
1. TD exhaustion entry gate was completely bypassed during all backtests (always null `td_sequential.per_tf`)
2. TD-based exit logic (runner TD exhaustion, deep audit TD exit) operated on empty/stale data
3. Entry + exit snapshots had stale td_counts carried from initial KV state via `...base` spread — **this is why exit TD counts matched entry counts exactly** (user spotted this on LRN, NXT, BE trades)
4. All TD Sequential exhaustion signals were invisible to the backtest engine

**Fix**: Added `computeTDSequentialMultiTF()` call in the replay loop right after `assembleTickerData()`, using sliced candles from `candleCache`. Added endIdx-based cache to skip recomputation when candle counts haven't changed (avoids performance hit on 5min intervals where D/W/M candles don't change).

#### Same-Direction Exhaustion Gate (ADDED — 2026-03-16)

**Pattern observed**: LRN LONG (9/9/25), NXT LONG (9/11/25), BE LONG (9/29/25) all entered when XP (bearish_prep) was 5-6 on 4H/D. This means the bullish move had been running for 5-6 bars of higher closes — approaching TD9 Sell. All three reversed immediately after entry, hitting max_loss.

**Root cause**: The existing TD guard only blocked counter-direction exhaustion with threshold >= 7 on 1H/4H. LRN had XP=5 (below 7) and only 2 TFs hit (needed 4 for panic gate).

**Fix**: Added **Guard 1 (Same-direction exhaustion / move topping)**: For LONG, blocks when bearish_prep >= 5 on 2+ of 1H/4H/D. For SHORT, blocks when bullish_prep >= 5 on 2+ of 1H/4H/D. Also lowered LTF counter-momentum threshold from 7 to 6, and panic gate threshold from 4 TFs to 3.

**Key learning**: `bearish_prep_count` counts consecutive bars closing higher than 4 bars ago. High XP at LONG entry = entering late in an up move that's approaching TD9 Sell. The model must detect "topping" before entering, not just look for counter-direction signals.

#### Zero SHORT Trades — Comprehensive Fix (2026-03-16)

**Problem**: Across 6+ months of backtesting (multiple runs), the model produced ZERO short trades despite having SHORT entry paths defined.

**Root causes found (5 issues)**:
1. **BEARISH pattern boost missing**: `classifyKanbanStage` only promoted watch→setup for BULLISH patterns. Bearish patterns never got the confidence boost needed to reach "enter" stage.
2. **`deep_audit_block_regime: ["EARLY_BEAR"]`** blocked ALL entries in EARLY_BEAR regime — the exact regime where SHORT opportunities appear. Gate was direction-blind.
3. **`mean_revert_td9` hardcoded to LONG**: Direction resolution in `processTradeSimulation` forced all mean_revert paths to LONG regardless of signal direction. `detectMeanReversionTD9` also had no SHORT counterpart.
4. **Sector-specific EQ adjustments only for LONG**: SHORT entries in historically bearish sectors (Financials, Growth, Tech) got no EQ relaxation.
5. **Cumulative SHORT gates too restrictive**: RVOL ceiling, 21-EMA gate, short rank minimum all stack up.

**Fixes applied**:
- Added BEARISH pattern boost + watch→setup promotion in `classifyKanbanStage`
- Made `deep_audit_block_regime` direction-aware: bear regimes allow SHORT, block LONG
- Added `detectMeanReversionTD9Short()` in indicators.js (mirrors LONG version with RSI > 70, phase leaving ext-up, resistance confluence)
- Direction resolution now reads `mean_revert_td9.direction` instead of hardcoding LONG
- Added sector-specific EQ adjustments for SHORT entries (Financials -5, Growth/Tech -3)
- Fixed kanban meta to display bearish pattern names (was always showing `bestBull.name`)

#### SPY Directional Regime Gate (ADDED — 2026-03-16)

**Problem**: The model kept entering LONG trades during market-wide pullbacks (Oct/Nov/Dec pattern). The regime system was direction-agnostic — a strong bear trend was classified as "TRENDING" (not blocked), and SPY's swing regime direction was never checked.

**Root causes**:
1. `regime_class` only measures trend strength (TRENDING/CHOPPY), not direction
2. Three-tier gate only blocks CHOPPY, never BEAR
3. SPY's `regime.combined` (EARLY_BEAR, STRONG_BEAR) was never used to gate entries
4. VIX ceiling defaulted to 0 (disabled)

**Fixes applied**:
- Added SPY directional regime gate: blocks LONG when SPY HTF < -15, EMA regime daily <= -1, or swing combined includes "BEAR". Blocks SHORT when SPY is bullish. Gold paths exempt (counter-trend by design).
- Enriched `_marketRegime` object with SPY's `htf_score`, `ema_regime_daily`, `swing_dir`, and `combined` (both live and replay paths)
- Ensured SPY is always processed first in replay (`allTickers.unshift("SPY")`)
- Set default VIX ceiling to 32 (blocks all entries in extreme fear)

**Key learning**: A direction-agnostic regime system is fundamentally insufficient. "TRENDING" must distinguish bull vs bear. The model needs a market-level directional overlay that prevents entering LONG when the broad market is bearish, regardless of individual ticker signals.

#### Remaining (Future Phases)
- Phase 2 (Liquidity Sweep as Setup Signal): Track zone sweep + recovery events as entry catalyst
- Phase 2D (Ticker Personality Profiles): Per-ticker SL width, hold duration, preferred entry path
- Phase 3B (Investor Replay Fidelity): Compute RS ranks + market health from historical candles in replay
