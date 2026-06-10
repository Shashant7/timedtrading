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

## Step 1 — `tt-feed` worker (next PR; operator deploy required)

New top-level package `worker-feed/` (sibling of `worker-bridge/`):

1. **Entry** imports `runPriceFeedCron` / `runFeedStreamKeepAlives` from
   `../worker/feed/price-feed-cron.js` and provides thin deps:
   - `isNyRegularMarketOpen` / `isWithinOperatingHours` — from
     `worker/market-calendar.js` (`loadCalendar` + `_calIsNyRegularMarketOpen`
     / `_calIsWithinOH`), loaded once per tick.
   - `dataFetchSnapshots` — `DataProvider.fetchLatestQuotes` (TD primary);
     Alpaca REST fallback comes with `alpacaFetchSnapshots` from
     `worker/indicators.js` (importable; verify tree-shaking keeps the
     bundle sane, otherwise lift that one function into
     `worker/feed/`).
   - `d1GetActiveUserTickersCached` — same 60s-cached D1 read (bind the
     SAME D1 database; read-only usage).
   - `notifyPriceHub` — 14-line DO POST helper (duplicate in entry).
   - `mergeFreshnessIntoLatest` + `syncLivePricesToChartCandles` — v1
     keeps these in the deps surface; lift them into `worker/feed/` in
     the same PR (they are feed-output concerns: `timed:latest` ingest_ts
     patch + forming-bar upsert).
   - stream wrappers — same DO-stub helpers against script_name bindings.
2. **wrangler.toml** (`name = "tt-feed"` + `[env.production]`):
   - `triggers.crons = ["*/1 * * * *"]`
   - KV `KV_TIMED` — SAME namespace id `e48593af3ef74bf986b2592909ed40cb`
   - D1 `DB` — same database (read paths + chart-candle upsert)
   - DO bindings **via `script_name = "timed-trading-ingest"`** (and the
     production script name for that env): `PRICE_STREAM`, `PRICE_HUB`,
     `ALPACA_STREAM`, `TRADOVATE_STREAM`. The monolith REMAINS the DO
     owner — no DO migrations, no class moves.
   - vars: `DATA_PROVIDER`, `TWELVEDATA_PLAN`, `ALPACA_ENABLED`,
     `TRADOVATE_ENABLED`; secrets: `TWELVEDATA_API_KEY`,
     `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY` (both envs).
3. **Dual-writer guard (cutover order matters):**
   1. Deploy tt-feed with crons **disabled** (`triggers.crons = []`),
      smoke via `wrangler dev`/manual fetch route that runs one tick.
   2. Enable tt-feed crons.
   3. Set `PRICE_FEED_EXTERNAL=true` on the monolith (both envs) — the
      monolith's `isPriceFeedCron` arm + keep-alives no-op behind this
      env check (add the check in the Step-1 PR; one-line gate at the
      Step-0 seam).
   4. Watch `timed:prices._source` + freshness monitor for 24h; rollback
      = unset the var (monolith resumes on the next tick).
4. **CI**: extend `deploy-worker.yml` (or a sibling workflow, mirroring
   `deploy-bridge.yml`) to deploy `worker-feed/` to both envs + post-deploy
   smoke (`timed:prices` age < 3 min via `/timed/health`).
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
