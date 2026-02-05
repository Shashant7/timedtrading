# Documentation Index

## Getting Started

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) - Full deployment walkthrough (Worker, TradingView, UI)
- [DEPLOYMENT_QUICK_START.md](DEPLOYMENT_QUICK_START.md) - Quick reference
- [tradingview/README.md](../tradingview/README.md) - Indicator setup, webhook URL, alert config
- [worker/README.md](../worker/README.md) - Worker setup, KV, D1, secrets

## Architecture & Core

- [../ARCHITECTURE.md](../ARCHITECTURE.md) - System architecture, data flow, scoring logic
- [SCORING_ARCHITECTURE.md](SCORING_ARCHITECTURE.md) - Scoring details, Worker calculations
- [D1_LEDGER_SOURCE_OF_TRUTH.md](D1_LEDGER_SOURCE_OF_TRUTH.md) - D1 ledger, positions, trade history
- [WORKER_BASED_CALCULATIONS.md](WORKER_BASED_CALCULATIONS.md) - Worker-side scoring and Kanban

## Kanban, Alerts & Trading

- [ALERT_AND_KANBAN_REVIEW.md](ALERT_AND_KANBAN_REVIEW.md) - **Dual-mode Kanban, 3-tier TP, exit/trim rules**
- [ALERT_DEBUGGING.md](ALERT_DEBUGGING.md) - Debugging alerts and Discord
- [TIME_TRAVEL_AND_RAIL_PARITY.md](TIME_TRAVEL_AND_RAIL_PARITY.md) - Time Travel replay, rail parity
- [RR_AND_TP_MAX.md](RR_AND_TP_MAX.md) - Risk/reward, TP levels
- [TP_ENHANCEMENT_INTEGRATION.md](TP_ENHANCEMENT_INTEGRATION.md) - TP system integration details

## Deployment & Ops

- [REVIEWING_WORKER_LOGS.md](REVIEWING_WORKER_LOGS.md) - Log debugging
- [MONITOR_DEPLOYMENT.md](MONITOR_DEPLOYMENT.md) - Deployment monitoring
- [FIND_KV_NAMESPACE_ID.md](FIND_KV_NAMESPACE_ID.md) - KV namespace lookup
- [RESTORE_VARIABLES.md](RESTORE_VARIABLES.md) - Variable restoration
- [SET_CORS_ORIGIN.md](SET_CORS_ORIGIN.md) - CORS configuration

## Reference

- [../SECRETS_MANAGEMENT.md](../SECRETS_MANAGEMENT.md) - Secrets (TIMED_API_KEY, Discord)
- [../TESTING.md](../TESTING.md) - Test approach
- [../PERFORMANCE_OPTIMIZATIONS.md](../PERFORMANCE_OPTIMIZATIONS.md) - Performance notes
- [VERSIONING_AND_MIGRATION.md](VERSIONING_AND_MIGRATION.md) - Script versioning, migrations

## Feature Docs

- [MOMENTUM_ELITE_IMPLEMENTATION.md](MOMENTUM_ELITE_IMPLEMENTATION.md) - Momentum Elite feature
- [SELF_LEARNING_MODULE.md](SELF_LEARNING_MODULE.md) - Self-learning module
- [MULTI_USER_ARCHITECTURE.md](MULTI_USER_ARCHITECTURE.md) - Multi-user plan
- [AI_AGENT_QUICK_START.md](AI_AGENT_QUICK_START.md) - AI agent integration

## Analysis Outputs

Script-generated files (GOLD_PATTERNS_ANALYSIS.json, HISTORICAL_MOVERS_*.json, TOP_MOVERS_ANALYSIS.*, historical-movers/) are data outputs from analysis scripts, not living docs.

## Archived

Completed fixes, dated status reports, and superseded plans: [archive/docs/](../archive/docs/)
