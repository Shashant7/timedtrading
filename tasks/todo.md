# Tasks / Todo

> Plan first. Verify plan. Track progress. Document results.
> See [WORKFLOW_ORCHESTRATION.md](WORKFLOW_ORCHESTRATION.md) for full workflow.

## Current Focus

- **Worker as source of truth & execution history** — See [worker-ledger-execution-plan.md](worker-ledger-execution-plan.md) for the full plan.

<!-- Add other active tasks here with [ ] checkboxes -->

## Simulation Dashboard Cleanup (2026-02-04)

- [x] Renamed to "Simulated Account", added paper-trading badge
- [x] Account chart: larger (120px), time range pills (1D/5D/10D/30D/1Y)
- [x] Account summary stats row: Total P&L, Today, Open P&L, Closed count
- [x] Holdings section (LONG | SHORT) with action badges (HOLD/TRIM/NEW)
- [x] Trade History: by day and by ticker (clickable to open detail)

## UI Updates (2026-02-04)

- [x] ReferenceError guards for Right Rail deps (fmtUsd, computeHorizonBucket, TRADE_SIZE)
- [x] Time Travel moved above Action Center in its own row
- [x] Search bar narrowed (280px → 200px)
- [x] Horizon filter removed from OpportunitiesPanel
- [x] Kanban lanes: min 190px, max 260px (from 170/240)
- [x] Daily trade summary in Action Center (today's trades, W/L, P&L)
- [x] P&L $ display for open positions in Kanban cards

## Completed

- [x] **Alerts & API module extraction** (2026-02-04)
  - Created worker/api.js (sendJSON, corsHeaders, ackJSON, readBodyAsJSON, requireKeyOr401, checkRateLimit, checkRateLimitFixedWindow) and worker/alerts.js (notifyDiscord, shouldSendDiscordAlert, generateProactiveAlerts).
- [x] **Trading module extraction** (2026-02-04)
  - Created worker/trading.js with KANBAN_STAGE_ORDER, enforceStageMonotonicity, getTradeDirection.
- [x] **Ingest module extraction** (2026-02-04)
  - Created worker/ingest.js with normTicker, isNum, normalizeTfKey, validateTimedPayload, validateCapturePayload, validateCandlesPayload.
- [x] **Storage module extraction** (2026-02-04)
  - Created worker/storage.js with kvGetJSON, kvPutJSON, kvPutText, kvPutJSONWithRetry, stableHash, d1InsertTrailPoint, d1InsertIngestReceipt.
- [x] **Route table in worker** (2026-02-03)
  - Added ROUTES array and getRouteKey(); replaced 50+ if (pathname && method) with if (routeKey === "..."); early 404 for unknown routes.
- [x] **Data lifecycle cron** (2026-02-03)
  - Added `0 4 * * *` (4 AM UTC daily) to wrangler.toml; scheduled handler invokes `runDataLifecycle(env)` when that cron fires (aggregate timed_trail → trail_5m_facts, purge old raw + ingest_receipts).
- [x] **Doc consolidation & workflow setup** (2026-02-02)
  - Created tasks/ with WORKFLOW_ORCHESTRATION.md, todo.md, lessons.md
  - Added .cursor/rules/workflow-orchestration.mdc (alwaysApply)
  - Archived 23 one-off/dated docs to archive/docs/
  - Moved ops & reference docs to docs/, created docs/README.md index
  - Root: README, ARCHITECTURE, SECRETS_MANAGEMENT, TESTING, PERFORMANCE_OPTIMIZATIONS only
