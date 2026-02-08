# Lessons Learned

> Update after ANY correction from the user.
> Review at session start. Ruthlessly iterate until mistake rate drops.

## Patterns to Avoid

- **Don't block gold_short entries with direction mismatch checks**: Gold SHORT is an intentional mean-reversion play on HTF_BULL_LTF_BULL blow-off tops. 82.7% of big DOWN moves start from BULL state. The fix should only block entries WITHOUT a recognized entry path. [2026-02-06]
- **Don't use below_trigger exit on tiny price dips**: A 0.04% dip below anchor price is noise, not a signal. Require at least 0.3% adverse move before flagging trigger invalidation. Winner median gain is 1.0%, so sub-0.3% dips are normal. [2026-02-06]
- **Don't use 30-minute recent trade window**: Too aggressive for replay and prevents re-entry after quick exits. 10 minutes is sufficient to prevent churning. [2026-02-06]
- **Always check purge-ticker cleans BOTH KV and D1**: KV trades and D1 positions/lots/events must be cleaned together, otherwise dashboard shows stale cards. [2026-02-06]

## Rules to Prevent Mistakes

- When modifying trade direction logic: verify gold_short and gold_long entry paths are preserved
- When modifying exit triggers: ensure minimum adverse move thresholds prevent noise exits
- When cleaning up trades: always purge from both KV and D1 (use /timed/debug/purge-ticker)
- After any trade simulation changes: reset + replay to verify with clean data
- **Always deploy worker with `--env production`**: Bindings (KV, D1, vars, crons) live under `[env.production]` in wrangler.toml. Deploying without `--env production` creates a naked worker with no bindings. [2026-02-06]
- **Keep backfill script tickers in sync with SECTOR_MAP**: Use `require('../worker/sector-mapping.js')` instead of a hardcoded list to avoid drift. [2026-02-06]
- **D1 schema migrations need fallback handling**: When adding columns (e.g., `session`) via ALTER TABLE, the throttle can prevent the migration from running. SELECT and INSERT queries must not reference the new column until migration confirms. Use a fallback INSERT without the column, and SELECT only core columns. [2026-02-07]
- **New scoring fields need backward-compatible gates**: When adding new precision scoring fields (fuel gauge, ST support, etc.) to `qualifiesForEnter()` and `classifyKanbanStage()`, always check if the data exists before gating on it. Old KV data won't have the fields. Use `d?.field != null` checks. [2026-02-07]
- **Use `enrichResult()` wrapper for cross-cutting entry enrichments**: Rather than modifying every `return { qualifies: true }` individually, use a wrapper function that applies Golden Gate boosts, precision metrics, etc. to all qualifying entries consistently. [2026-02-07]
- **Use daily candles for price performance, not trail data**: For 5D/15D/30D/90D price change calculations, use `ticker_candles` (tf='D') — actual market close prices with 400+ days of history. Trail data (timed_trail/trail_5m_facts) is for scoring snapshots, not price lookbacks. Mixing them causes gaps, dedup complexity, and inaccurate prices from intraday snapshots. [2026-02-08]
- **Alpaca uses BRK.B not BRK-B**: Alpaca API rejects `BRK-B` (HTTP 400). The correct symbol format is `BRK.B` with a dot. A single bad symbol in a batch request fails the entire batch. [2026-02-08]
- **CORS wildcard needs explicit handling**: When `CORS_ALLOW_ORIGIN = "*"`, splitting by comma gives `["*"]` which is length 1, not 0. The `allowedOrigins.includes(origin)` check doesn't match `"*"` against `"http://localhost:8765"`. Must explicitly check `allowedOrigins.includes("*")` as an early exit to `allowed = "*"`. [2026-02-08]
- **Pattern matching in hot path needs in-memory cache**: D1 queries on every ingest (270+ tickers × every minute) would be too expensive. Cache the 17 active patterns in memory with a 5-minute TTL. Pattern matching itself is synchronous and fast — it's the D1 read that needs caching. [2026-02-08]
- **Pattern integration should boost, not gate**: Pattern matching enhances Kanban decisions but never overrides them. A "pattern boost" upgrades entry confidence or promotes watch→setup, but a pattern mismatch never blocks an entry that the rule-based system qualifies. This preserves system stability while the model learns. [2026-02-08]
- **Compiled JS must match source format**: If `shared-right-rail.compiled.js` is loaded via `<script>`, it must be pre-transpiled (no JSX). If the source uses JSX, change the script tag to `type="text/babel"` so Babel standalone processes it at runtime. [2026-02-08]
- **Snap intraday candle timestamps to timeframe boundaries**: Raw candle timestamps from the DB may not align cleanly to timeframe intervals (e.g., a 10m candle at 9:33 instead of 9:30). Snap with `Math.floor(ts / intervalMs) * intervalMs` and re-aggregate duplicates. [2026-02-08]
- **Compute technical overlays client-side from candle data**: EMAs, SuperTrend, ATR — all computable from OHLC candle arrays in the browser. No need for additional API calls. EMA: seed with SMA, then apply exponential smoothing. SuperTrend: ATR-based with directional flips. [2026-02-08]
- **Right rail overlay must use opaque background**: When the right rail slides over the main content, its container must use an opaque background (e.g., `bg-[#0b0e11]`) not a transparent one (e.g., `bg-white/[0.02]`). Transparent overlays let the underlying dashboard bleed through and are unreadable. [2026-02-08]
- **Bulk sed color replacements need syntax verification**: When doing bulk `sed` replacements across large JSX files (e.g., `bg-[#161922]` → `bg-white/[0.02]`), verify no broken syntax results. Tailwind arbitrary values with `/` (opacity) inside JSX strings are valid, but context matters. Also: Babel takes longer on files >500KB — the render timeout may fire before transpilation finishes. [2026-02-08]
- **Server-side TD Sequential replaces TradingView webhook dependency**: Computing DeMark Sequential (TD9/TD13) from D/W/M candles in the worker removes the dependency on TradingView Pine Script webhooks. Alpaca's `1Month` timeframe gives accurate monthly OHLCV without needing to derive from daily candles. The `normalizeTfKey` function must handle "M" without colliding with "1M" (which maps to 1-minute). [2026-02-08]
- **Model features should include all signal sources**: When adding new indicator computations (like TD Sequential), always integrate them into the self-learning model's feature vector (`flags_json`), prediction triggers (`shouldLogPrediction`), and outcome tracking. Without this, the model can't learn from the new signals. [2026-02-08]