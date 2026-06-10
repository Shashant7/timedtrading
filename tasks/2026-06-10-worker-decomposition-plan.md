# Worker decomposition (P2 / R1) — execution plan (2026-06-10)

Context: `tasks/2026-06-09-full-system-review.md` §2 (R1–R3) and §6. Target
topology: `tt-feed` (*/1) → `tt-engine` (*/5) → `tt-research`
(hourly/daily) → `tt-api` (HTTP), Service Bindings between them. Order of
extraction: **tt-feed first** (lowest risk, clearest boundary), then
tt-research, then tt-engine.

## Step 0 — feed module extraction (THIS PR; no topology change)

`worker/feed/price-feed-cron.js` now owns the */1 price-feed pipeline +
the PriceStream/Tradovate keep-alives, extracted VERBATIM from
`worker/index.js scheduled()` (~640 lines) behind a dependency-injection
seam. The monolith calls it with its own helpers — behavior is unchanged
(diff-verified against the original block; only the intended
`deps.`-prefix renames differ). The seam exists so the future `tt-feed`
worker can run the same pipeline with thin deps.

Injected deps (still live in index.js because they carry monolith-local
state): `isNyRegularMarketOpen` (cron calendar), `d1GetActiveUserTickersCached`
(in-process cache + D1 schema guard), `dataFetchSnapshots`
(provider routing), `notifyPriceHub`, `mergeFreshnessIntoLatest`,
`syncLivePricesToChartCandles`, stream wrappers.

What stayed in `scheduled()` on purpose (NOT feed-domain): backtest
orchestrator tick, `d1SyncLatestBatchFromKV` (scoring/D1 bootstrap),
integrity guard, calendar load.

## Step 1 — `tt-feed` worker (SCAFFOLD SHIPPED in this PR; operator deploy required)

Status (2026-06-10): `worker-feed/feed-index.js` + `worker-feed/wrangler.toml`
are implemented and bundle-verified (~100 KB vs the 5.8 MB monolith). The
worker is SAFE TO DEPLOY at any time: its cron no-ops until
`FEED_ENABLED=true`, and `/feed/run-once` (X-API-Key-guarded) lets the
operator verify a full forced tick before flipping anything. Remaining
operator actions: deploy, set secrets (`TIMED_API_KEY`,
`TWELVEDATA_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`),
run-once verify, flip `FEED_ENABLED=true` then `PRICE_FEED_EXTERNAL=true`
on the monolith (both envs), watch `/feed/health` + freshness monitor 24h.
CI deploy wiring (a `deploy-feed` job mirroring `deploy-bridge.yml`) lands
once the first manual deploy is verified.

Design as implemented — package `worker-feed/` (sibling of `worker-bridge/`):

1. **Entry** (`worker-feed/feed-index.js`) imports `runPriceFeedCron` /
   `runFeedStreamKeepAlives` from `../worker/feed/price-feed-cron.js`,
   `computeFeedWindow` from `../worker/feed/feed-window.js` (pure
   replication of the monolith's */1 window registration — unit-tested in
   `worker/feed/feed-window.test.js`; KEEP IN SYNC with the monolith's
   `vc` registration), and provides thin deps:
   - `isNyRegularMarketOpen` / `isWithinOperatingHours` — calendar-aware
     from `worker/market-calendar.js` (`loadCalendar` once per tick) with
     the monolith's static fallbacks.
   - `dataFetchSnapshots` — `DataProvider.fetchLatestQuotes` (TD primary)
     + `alpacaFetchSnapshots` from `worker/indicators.js` (tree-shakes to
     a ~100 KB bundle).
   - `d1GetActiveUserTickersCached` — same 60s-cached D1 read, same SQL.
   - `notifyPriceHub` + stream wrappers — local DO-stub helpers against
     the script_name bindings.
   - `mergeFreshnessIntoLatest` + `syncLivePricesToChartCandles` — lifted
     into `worker/feed/feed-outputs.js` (monolith now delegates to the
     same module, so there is exactly ONE implementation).
   - Routes: `GET /feed/health` (prices age / source / enablement) and
     `POST /feed/run-once` (X-API-Key, forced full tick for cutover
     verification — works while FEED_ENABLED=false by design).
2. **wrangler.toml** (`worker-feed/wrangler.toml`, single deploy target —
   the monolith's default + production envs share the script name and
   KV/D1 ids, so one tt-feed serves both):
   - `triggers.crons = ["*/1 * * * *"]` — live from first deploy, but every
     tick no-ops until `FEED_ENABLED=true` (cutover = var flip, not a
     config redeploy).
   - KV `KV_TIMED` — SAME namespace id `e48593af3ef74bf986b2592909ed40cb`
   - D1 `DB` — same database (user-tickers read + chart-candle upsert)
   - DO bindings **via `script_name = "timed-trading-ingest"`**:
     `PRICE_STREAM`, `PRICE_HUB`, `ALPACA_STREAM`, `TRADOVATE_STREAM`.
     The monolith REMAINS the DO owner — no DO migrations, no class moves.
   - vars: `FEED_ENABLED="false"`, `DATA_PROVIDER`, `TWELVEDATA_PLAN`,
     `ALPACA_ENABLED`, `TRADOVATE_ENABLED`; secrets: `TIMED_API_KEY`,
     `TWELVEDATA_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`.
   - `cpu_ms = 30000` — the feed never needs the monolith's 300s budget.
3. **Dual-writer guard (cutover order matters):**
   1. `wrangler deploy --config worker-feed/wrangler.toml` + set secrets.
      Crons fire but no-op (FEED_ENABLED=false).
   2. Verify: `curl -X POST https://tt-feed.<acct>.workers.dev/feed/run-once
      -H "X-API-Key: $TIMED_API_KEY"` → expect `{ok:true, ran:true}` and a
      fresh `timed:prices` (`/feed/health` age < 60s, source
      `rest_snapshot`).
   3. Flip `FEED_ENABLED=true` on tt-feed, then `PRICE_FEED_EXTERNAL=true`
      on the monolith (both envs). A one-tick overlap is harmless (same
      data, last write wins); a gap is not — this order has no gap.
   4. Watch `timed:prices._source` + freshness monitor for 24h; rollback
      = unset both vars (monolith resumes on the next tick).
4. **CI**: after the first manual deploy is verified, add a `deploy-feed`
   job mirroring `deploy-bridge.yml` + post-deploy smoke (`/feed/health`
   age < 3 min).
5. **Watchdog**: add a `feed_tick_age` field to `/timed/health` read from
   `timed:prices.updated_at` so the external watchdog covers the new
   worker through the existing single health contract (R6).

## Step 2 — `tt-research` (after tt-feed is stable)

Everything daily/hourly that is not trade-path: CRO/CTO/COO, discovery
batch, briefs, calibration, DMARC, earnings cache, ETF sync, data
lifecycle. These arms already dispatch through `vc.has(...)` labels and
`env._selfDispatch`; the extraction is the same seam pattern as Step 0
(label-gated arms → modules → thin worker). Replace `_selfDispatch`
HTTP-path calls with Service Binding calls to `tt-api`.

Known pre-existing bug to fix in this step (from the audit): the
discovery batch gates on `vc.has("0 22 * * *")` but only
`0 22 * * 1-5` is ever registered (hourly weekday block); the dedicated
`0 22 * * *` CF trigger exits at the `!_isEvery5Min` early-return before
reaching it.

## Step 3 — `tt-engine` (*/5 scoring + trade management + CIO), last

Highest care. The pipeline modules (`worker/pipeline/`, `worker/cio/`)
are already importable; the work is extracting the */5 arm of
`scheduled()` (scoring tick, `processTradeSimulation`, proactive alerts)
plus its KV/D1 preloads. `tt-api` is whatever remains of index.js.

## Invariants (all steps)

- Stop-losses must never share a CPU budget with research synthesis.
- One worker writes `timed:prices` at a time (dual-writer guard above).
- DO classes keep a single owner; cross-worker access via `script_name`.
- Every step is a separate PR, gated by `npm test` + the MC smoke-test
  skill + 24h of freshness-monitor observation before the next step.
