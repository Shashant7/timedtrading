# Documentation Index

> **New agents:** start at [`../AGENTS.md`](../AGENTS.md), then
> [`../CONTEXT.md`](../CONTEXT.md). This folder is for **long-form
> architectural docs and operational runbooks**, not day-to-day
> playbooks. For copy-paste-ready playbooks see
> [`../skills/`](../skills/).

---

## Context

- [CONTEXT.md](CONTEXT.md) — pointer to the root [`../CONTEXT.md`](../CONTEXT.md). Read first.

## Design

- Root [`../DESIGN.md`](../DESIGN.md) — **the normative UI spec** for everything currently shipped.
- [`../design/verda/`](../design/verda/README.md) — incoming Verda design-system bundle (audited; migration via [`../skills/verda-ui-migration.md`](../skills/verda-ui-migration.md)). Design bundles live under `design/<name>/`, never in this folder.

## Getting started / Deployment

- [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) — full deployment walkthrough
- [DEPLOYMENT_QUICK_START.md](DEPLOYMENT_QUICK_START.md) — quick reference
- [CLOUDFLARE_ACCESS_SETUP.md](CLOUDFLARE_ACCESS_SETUP.md) — CF Access JWT auth
- [SECURITY_DEPLOYMENT.md](SECURITY_DEPLOYMENT.md) — security & deployment hardening
- [SET_CORS_ORIGIN.md](SET_CORS_ORIGIN.md) — CORS configuration

## Architecture & core

- [SCORING_ARCHITECTURE.md](SCORING_ARCHITECTURE.md) — scoring details + worker calculations
- [active-trader-information-hardening-plan.md](active-trader-information-hardening-plan.md) — signal parity, event ledger, path forecast, and sequence-aware Trader diagnosis plan
- [signal-family-catalog-v1.md](signal-family-catalog-v1.md) — signal-family map: code paths, payload fields, consumers, and awareness mode
- [WORKER_BASED_CALCULATIONS.md](WORKER_BASED_CALCULATIONS.md) — server-side scoring + Kanban
- [MODEL_PIPELINE.md](MODEL_PIPELINE.md) — model pipeline
- [D1_LEDGER_SOURCE_OF_TRUTH.md](D1_LEDGER_SOURCE_OF_TRUTH.md) — D1 ledger + positions
- [D1_RETENTION_POLICY.md](D1_RETENTION_POLICY.md) — retention policy

## Live operations

- [RUNBOOK.md](RUNBOOK.md) — on-call / triage runbook
- [REVIEWING_WORKER_LOGS.md](REVIEWING_WORKER_LOGS.md) — log inspection via `wrangler tail`
- [REPLAY_AND_BACKTEST.md](REPLAY_AND_BACKTEST.md) — replay + backtest tooling
- [REFERENCE_INTEL_AUTOMATION.md](REFERENCE_INTEL_AUTOMATION.md) — reference intel refresh cron
- [VERSIONING_AND_MIGRATION.md](VERSIONING_AND_MIGRATION.md) — script versioning + DB migrations
- [backtest-mode.md](backtest-mode.md) — backtest-mode operational notes
- [2026-05-26-operator-runbook.md](2026-05-26-operator-runbook.md) — Mission-Control-era operator runbook
- [2026-05-23-progress-recap.md](2026-05-23-progress-recap.md) — May 2026 progress recap

## Specs / contracts (v1)

- [reference-score-rubric-v1.md](reference-score-rubric-v1.md) — investor/trader scoring rubric
- [reference-intel-contract-v1.md](reference-intel-contract-v1.md) — reference-intel data contract
- [context-intel-contract-v1.md](context-intel-contract-v1.md) — context-intel data contract
- [cio-reference-integration-v1.md](cio-reference-integration-v1.md) — AI CIO reference integration
- [live-replay-parity-contract-v1.md](live-replay-parity-contract-v1.md) — live ↔ replay parity contract
- [trade-proof-contract-v1.md](trade-proof-contract-v1.md) — trade-proof contract
- [go-no-go-gates-v1.md](go-no-go-gates-v1.md) — go/no-go gates
- [promotion-checklist-v1.md](promotion-checklist-v1.md) — promotion checklist
- [2026-05-26-adaptive-scoring-spec.md](2026-05-26-adaptive-scoring-spec.md) — adaptive scoring spec

## Marketing / GTM

- [GTM_CHECKLIST.md](GTM_CHECKLIST.md) — go-to-market checklist
- [outreach-templates.md](outreach-templates.md) — operator outreach templates

## Reference material

- [reference-pdfs/](reference-pdfs/) — Fundstrat decks, Moonshot PDF,
  third-party research used as input for the model
- [openapi.json](openapi.json) — auto-generated worker API schema
- [SECTOR_WATCHLIST_GUIDE.md](SECTOR_WATCHLIST_GUIDE.md) — sector watchlist editor

## Archive

[archive/](archive/) — completed one-shot analyses, superseded plans, and
historical reports. Includes BIG_MOVERS_ANALYSIS, GOLD_PATTERNS_ANALYSIS,
HISTORICAL_MOVERS, MOMENTUM_ELITE_IMPLEMENTATION, SIGNAL_OUTCOME_ANALYSIS,
SECURITY_INSIGHTS_REVIEW_2026-05-10, etc.

---

## Where else to look

| Need | Where |
|---|---|
| Onboarding | [`../AGENTS.md`](../AGENTS.md) |
| One-page context refresh | [`../CONTEXT.md`](../CONTEXT.md) |
| Copy-paste playbooks (backfill, deploy, rescore, ...) | [`../skills/`](../skills/) |
| Live work plan | [`../tasks/todo.md`](../tasks/todo.md) |
| Lessons / post-mortems | [`../tasks/lessons.md`](../tasks/lessons.md) |
| Pre-May 2026 historical plans | [`../tasks/archive/2026-pre-may/`](../tasks/archive/2026-pre-may/) |
