# Lessons Learned (Full Archive)

> **Quick refresh:** See [CONTEXT.md](../CONTEXT.md) for condensed critical lessons.
> Update after ANY correction from the user. Review at session start.

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
- **Never use unbounded `ROW_NUMBER() OVER (PARTITION BY ticker ...)` on large tables**: Window functions scan the entire table. On `ticker_candles` with 200+ tickers and months of data, this takes 10-30s and overloads D1. Use `GROUP BY ticker` with `max(ts)` and date-bounded `WHERE ts > cutoff` instead. [2026-02-20]
- **Heavy calibration/batch jobs must not run on same schedule as scoring cron**: Running calibration (many D1 queries) on `*/5 * * * *` alongside scoring causes D1 overload. Separate to `0 * * * *` / `30 * * * *`. [2026-02-20]
- **Calibration must load trail_5m_facts AFTER move detection, not before**: trail_5m_facts has millions of 5-min rows. Loading all upfront for ~200 tickers times out. Detect moves from daily candles first, dedup/cap at 500, then enrich only the final set with trail data for their specific tickers. [2026-02-20]
- **Use hourly candles (tf='60') for MFE/MAE in trade autopsy**: 5-min candles (~2M rows) are too heavy. Daily candles are too coarse. Hourly (`tf='60'`) gives good intraday precision at ~1/13th the data volume of 5-min. Fetch with date bound and per-ticker batch alongside daily candles. [2026-02-20]
- **Worker cron jobs can time out silently**: If a cron worker exceeds its wall-clock limit, it dies without running catch blocks. KV status gets stuck at "running". Add: (1) wall-clock timeout checks between steps, (2) stale-status detection in API (if updated_at > 2 min ago, report as timed_out), (3) auto-cleanup of stuck status at cron start. [2026-02-20]

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
