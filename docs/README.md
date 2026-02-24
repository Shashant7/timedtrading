# Documentation Index

**Consolidated.** Analysis outputs and superseded plans live in [archive/docs/](../archive/docs/).

## Context

- [CONTEXT.md](CONTEXT.md) - Project context, stack, and key decisions (start here)

## Getting Started

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) - Full deployment (Worker, TradingView, UI)
- [DEPLOYMENT_QUICK_START.md](DEPLOYMENT_QUICK_START.md) - Quick reference
- [CLOUDFLARE_ACCESS_SETUP.md](CLOUDFLARE_ACCESS_SETUP.md) - CF Access JWT auth for dashboard
- [tradingview/README.md](../tradingview/README.md) - Indicator setup, webhook, alerts
- [worker/README.md](../worker/README.md) - Worker setup, KV, D1, secrets

## Architecture & Core

- [SCORING_ARCHITECTURE.md](SCORING_ARCHITECTURE.md) - Scoring details, Worker calculations
- [D1_LEDGER_SOURCE_OF_TRUTH.md](D1_LEDGER_SOURCE_OF_TRUTH.md) - D1 ledger, positions, trade history
- [WORKER_BASED_CALCULATIONS.md](WORKER_BASED_CALCULATIONS.md) - Worker-side scoring and Kanban
- [MODEL_PIPELINE.md](MODEL_PIPELINE.md) - Model pipeline and analysis

## Deployment & Ops

- [REVIEWING_WORKER_LOGS.md](REVIEWING_WORKER_LOGS.md) - Log debugging
- [MONITOR_DEPLOYMENT.md](MONITOR_DEPLOYMENT.md) - Deployment monitoring
- [SET_CORS_ORIGIN.md](SET_CORS_ORIGIN.md) - CORS configuration
- [SECURITY_DEPLOYMENT.md](SECURITY_DEPLOYMENT.md) - Security and deployment
- [VERSIONING_AND_MIGRATION.md](VERSIONING_AND_MIGRATION.md) - Script versioning, migrations

## Feature & Reference

- [REPLAY_AND_BACKTEST.md](REPLAY_AND_BACKTEST.md) - Full backtest replay, gap-based backfill, Replay Control UI
- [MOMENTUM_ELITE_IMPLEMENTATION.md](MOMENTUM_ELITE_IMPLEMENTATION.md) - Momentum Elite feature
- [SECTOR_WATCHLIST_GUIDE.md](SECTOR_WATCHLIST_GUIDE.md) - Sector watchlist and ticker management

## Archived

Completed fixes, analysis outputs, and superseded plans: [archive/docs/](../archive/docs/) (including historical-movers/, analysis JSON/MD, and old implementation plans).
