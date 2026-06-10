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

## Step 2 — `tt-research`

**v1 SHIPPED 2026-06-10 (nightly mega-batch).** The three heaviest lanes
— AI COO daily cycle, CRO/CTO full cycle, discovery batch — moved
VERBATIM from the monolith's `0 22 * * *` gate into
`worker/research/nightly-batch.js` (fully self-contained module; both
hosts call the same function). New `worker-research/` worker
(`tt-research`) runs it on its own `0 22 * * *` cron with `cpu_ms =
120000`, gated by `RESEARCH_ENABLED` (default false) with
`POST /research/run-once` + `GET /research/health` for verification;
the monolith side no-ops behind `RESEARCH_EXTERNAL`. COO admin-route
dispatch maps `env._selfDispatch` onto a `MAIN` service binding
(no CF-1042 class). CI: `deploy-research.yml`. The CIO nightly chain
(outcome backfill → authority → learning bus) STAYS in the monolith —
cheap D1 work, monolith-local helpers.

Cutover (operator): deploy → set secrets (TIMED_API_KEY,
OPENAI_API_KEY, FINNHUB_API_KEY, FSD creds, Discord webhooks) →
`/research/run-once` verify → flip `RESEARCH_ENABLED=true` then
`RESEARCH_EXTERNAL=true` (both monolith envs). Overlap = idempotent
daily jobs run twice (wasteful, not harmful); rollback = unset both.

**v2 SHIPPED 2026-06-10 — role split (supersedes the v1 thin worker).**
Following Step 3's pattern, `worker-research/` now deploys the SAME
bundle (`main = ../worker/index.js`) with `WORKER_ROLE="research"` and
owns ALL research slots: `0 * * * *`, `30 * * * *`, `0 22 * * *` —
every hourly/daily arm (briefs, CRO intraday, investor hourly,
freshness heal, earnings, ETF sync, data lifecycle, retros, COO
screener, CIO nightly chain) moves with the slots, no per-arm
extraction needed. The monolith hands the slots over via
`RESEARCH_SLOTS_EXTERNAL=true`. The v1 thin worker (research-index.js)
is deleted; `worker/research/nightly-batch.js` remains the shared
module both hosts execute. The v1 partial flag `RESEARCH_EXTERNAL` is
superseded — leave it unset and use the slot-level flag.

**Cutover (gap-preferred — investor hourly/rebalance must never run
twice in one hour):** deploy → secrets (full monolith set) → verify
tt-research `/timed/health` → `RESEARCH_SLOTS_EXTERNAL=true` on the
monolith FIRST → `RESEARCH_ENABLED=true` on tt-research → watch the
next hourly tick's tombstones + brief/CRO freshness.

**Flag persistence (all workers):** `keep_vars = true` everywhere +
cutover flags unpinned from `[vars]` — wrangler otherwise WIPES
dashboard-set vars on every CI deploy, silently undoing a cutover.
Flags are set once via the CF Dashboard (Secret type also works) and
persist.

**End state:** after the three cutovers the monolith runs NO cron work —
it degenerates to `tt-api` (HTTP only) by configuration. A code-level
api split becomes unnecessary; optionally remove the monolith's
`[triggers]` once the split has soaked.

The `0 22 * * *` registration bug found in the audit was fixed
separately (PR #551).

## Step 3 — `tt-engine` (*/5 scoring + trade management + CIO)

**SHIPPED 2026-06-10 as a ROLE SPLIT (no code movement).** The */5 trade
path is too entangled with index.js locals for a verbatim extraction to
be mechanically safe — so tt-engine deploys the SAME bundle
(`worker-engine/wrangler.toml`, `main = ../worker/index.js`) under its
own name with ONLY the `*/5` trigger and its own `cpu_ms = 300000`
budget. `scheduled()` gates on role:
- tt-engine (`WORKER_ROLE="engine"`): only */5; no-ops until
  `ENGINE_ENABLED=true`.
- monolith: */5 invocations no-op when `ENGINE_EXTERNAL="true"`.

This achieves the actual goal of Step 3 — **stop-losses get a CPU budget
nothing else can starve** — with zero behavior change and a var-flip
cutover. DO classes stay monolith-owned (script_name stubs). The full
[vars] block is mirrored in worker-engine/wrangler.toml (KEEP IN SYNC).
CI: `deploy-engine.yml` (runs tests + dashboard embed like
deploy-worker). Watchdog gains a scoring-staleness check (>30 min during
RTH) because the monolith's */1 keeps the generic heartbeat fresh — a
dead engine must page on scoring age, not tick age.

**Cutover order (OVERLAP IS WORSE THAN A GAP — dual scoring = concurrent
KV writes = kanban oscillation, a documented incident class):**
1. Deploy + set the full monolith secret set on tt-engine.
2. Verify `https://tt-engine.shashant.workers.dev/timed/health` ok:true.
3. `ENGINE_EXTERNAL=true` on the monolith (both envs) — scoring stops.
4. `ENGINE_ENABLED=true` on tt-engine. Watch `minutesSinceScoring < 6`
   for two ticks. Rollback = inverse order.

Code-level extraction (true `tt-api` split) remains possible later, but
the role split delivers the failure-domain isolation now. Note: the */5
slot's siblings (bar cron, fast sanity sweep, options prewarm, bridge
drain, FRED, regime bootstrap) move WITH the slot — all trade-path-
adjacent by design.

## Invariants (all steps)

- Stop-losses must never share a CPU budget with research synthesis.
- One worker writes `timed:prices` at a time (dual-writer guard above).
- DO classes keep a single owner; cross-worker access via `script_name`.
- Every step is a separate PR, gated by `npm test` + the MC smoke-test
  skill + 24h of freshness-monitor observation before the next step.
