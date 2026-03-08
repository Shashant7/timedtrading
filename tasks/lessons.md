# Lessons Learned (Full Archive)

> **Quick refresh:** See [CONTEXT.md](../CONTEXT.md) for condensed critical lessons.
> Update after ANY correction from the user. Review at session start.

---

## Deployment & Infrastructure

- **Deploy worker to BOTH environments**: `cd worker && npx wrangler deploy && npx wrangler deploy --env production`. Both crons can fire from either. Deploying only one leaves stale code running. [2026-02-11, reinforced 2026-02-18]
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
- **Status must always follow realized P&L**: correct-exit and correct-all-exits were updating exit_price and pnl from 10m candles but not status, causing trades to show LOSS with positive P&L (or WIN with negative). Fix: all correct-* endpoints now derive and persist status from pnl (WIN/LOSS/FLAT). For already-corrected trades: POST /timed/admin/trade-autopsy/correct-exit with trade_id (reconciles status when exit price unchanged), or POST /timed/admin/trade-autopsy/reconcile-status for batch. [2026-03-05]

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
- **Missed moves are a scoring limitation, not a config problem**: 90.6% of missed moves on traded tickers had rank 0-19 (avg 5.8). The scoring engine is reactive — it rates tickers based on current signals (squeeze, EMA cross, ST flip). Breakouts that haven't started yet show no signals. Lowering the rank threshold would flood entries with noise. The correct solution is adding breakout-specific entry paths that detect daily level breaks with volume confirmation. [2026-03-02]
- **should_have_held calibration (8 trades)**: Autopsy tags showed exits too early. Loosened: MIN_MINUTES_SINCE_ENTRY_BEFORE_TRIM 10→15, PROFIT_PROTECT_TRIM threshold 2%→2.5%, RIPSTER_EXIT_DEBOUNCE_BARS 2→3. Gives more room before trim and requires slightly more profit before locking in. [2026-03-06]

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
- **RIPSTER_TUNE_V2 reduced premature cloud exits in quick replay**: Added feature-flagged tuning (`RIPSTER_TUNE_V2`) to (1) soften strict 34/50 bias alignment in strong daily trends (D+1H anchored, allow 2-of-3), (2) add reclaim entry path (`ripster_reclaim`) using 8/9 cross + ST flip confirmation, and (3) debounce cloud-loss exits with defend/trim-before-exit behavior. Quick validation replay (2025-07-01→2025-07-10, trader-only) completed cleanly: 27 trades, 20 wins, 7 losses, total realized PnL 13.94%, zero processing errors. [2026-03-04]
- **Custom ticker adds need two phases, not one**: A fast seed/score path is good for first paint, but it is not the same as "ready." The durable fix is: seed a usable card immediately, then run the full onboarding pipeline in the background and expose `timed:onboard:<ticker>` progress so the UI can distinguish "card exists" from "context/profile/history are complete." Context should be persisted worker-side from shared sources (TwelveData identity + richer profile enrichment), not reconstructed only in the UI. [2026-03-04]
