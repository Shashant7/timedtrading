# Timed Trading System Architecture Stabilization Plan

**Date:** 2026-04-05
**Intent:** Review the platform end to end and define a deliberate plan that makes the trading engine reliable, explainable, and safe to evolve.

---

## Executive Summary

Timed Trading already has many of the right ingredients:

- a rich multi-timeframe trading engine
- adaptive configuration and regime concepts
- ticker profiles, AI CIO, and memory
- strong product surfaces around the engine
- replay, runs, autopsy, and calibration infrastructure

The problem is not lack of capability. The problem is that the system spine is too coupled.

Today, the trading engine, replay/backtest orchestration, adaptive intelligence, and multiple UI/admin surfaces all depend on overlapping logic inside a monolithic worker. That makes the platform powerful, but fragile. A fix in one area can unintentionally alter another area because the contracts are not strict enough.

The right move is **not** a blind full rewrite and **not** more endless patching on an unstable base. The right move is a **bounded hardening + extraction plan**:

1. freeze and document the engine contracts
2. make replay/backtest deterministic and trustworthy
3. extract the trading spine into explicit modules
4. unify regime/profile/memory contracts
5. make product surfaces consume stable read models instead of ad hoc engine internals

---

## System Map

### Core Spine

The core spine is:

1. market data + events + context
2. indicator assembly and multi-timeframe analysis
3. entry qualification
4. trade plan creation (`direction`, `size`, `SL`, `TP`, trim plan)
5. lifecycle management (defend, trim, trail, exit)
6. persistence, replay, and run archival
7. UI/admin surfaces that read the outputs

### Major Subsystems

**Trading engine**
- `worker/index.js`
- `worker/indicators.js`
- `worker/pipeline/trade-context.js`
- `worker/pipeline/entry-engine.js`
- `worker/pipeline/exit-engine.js`
- `worker/pipeline/tt-core-entry.js`
- `worker/pipeline/tt-core-exit.js`
- `worker/execution.js`

**Adaptive intelligence**
- `worker/onboard-ticker.js`
- `worker/model.js`
- `worker/cio/cio-service.js`
- `worker/cio/cio-memory.js`
- `worker/cio/cio-reference.js`
- `scripts/calibrate.js`
- `scripts/deep-system-tune.js`

**Product surfaces**
- `react-app/index-react.html`
- `react-app/shared-right-rail.js`
- `react-app/simulation-dashboard.html`
- `react-app/daily-brief.html`
- `react-app/alerts.html`
- `react-app/investor-dashboard.html`
- `react-app/trade-autopsy.html`
- `react-app/system-intelligence.html`

**Platform state**
- D1: trades, trade events, candles, runs, archived run tables, profiles, model config, calibration/intelligence tables
- KV: latest snapshots, prices, fast-path runtime state, cached profiles

---

## Key Findings

### 1. The trading engine is the true platform kernel

Every important surface depends on the engine either directly or indirectly:

- Analysis and Bubble Map depend on ranked/snapshotted ticker state
- Right Rail depends on the same scoring payloads plus trail, candles, profile, and ledger data
- Daily Brief depends on live market state, open trades, sectors, and event context
- Investor Mode depends on the same indicator family with different time-horizon presentation
- Alerts, Trades, Trade Autopsy, and System Intelligence all depend on trade lifecycle correctness

If the engine or replay contracts drift, the whole product loses trust.

### 2. `worker/index.js` is carrying too many responsibilities

It currently mixes:

- route handling
- entry orchestration
- lifecycle management
- replay/backtest logic
- run registry logic
- adaptive config loading
- CIO wiring
- UI/admin payload composition

That is the main source of fragility.

### 3. The engine contract is split between pipeline modules and inline logic

TT Core exists, but lifecycle behavior still depends on both:

- pipeline exit logic in `worker/pipeline/tt-core-exit.js`
- large inline management and exit flows in `worker/index.js`

This makes it easy to "fix the engine" in one place while behavior still differs somewhere else.

### 4. There are multiple overlapping sources of truth

Current examples:

- static ticker behavior profiles vs D1 learned ticker profiles
- multiple regime definitions
- live vs replay inputs
- D1 vs KV trade/read models
- archived run config vs current model config

This is survivable in exploration mode, but dangerous in a production system.

### 5. Replay/backtest integrity is a first-class product requirement

Backtests are not just internal experiments. They are the evidence chain for:

- strategy trust
- trade autopsy
- calibration
- system intelligence
- future user-facing claims

That means replay determinism is not a tooling detail. It is core product infrastructure.

### 6. The adaptive layer is promising but not yet fully governed

You already have:

- ticker profiles
- path performance
- regime-aware config
- calibration
- AI CIO
- episodic memory

But these are not yet operating under one explicit contract for how adaptation is selected, applied, audited, and promoted.

---

## Architectural Principles

The next phase should follow these rules:

1. **One authoritative contract per concern**
   - one profile contract
   - one regime vocabulary
   - one run/config snapshot contract
   - one lifecycle state machine

2. **Replay parity is mandatory**
   - no hidden live-only shortcuts for replay unless explicitly labeled and disabled by default

3. **Engine first, surfaces second**
   - UI/admin surfaces should consume stable read models, not engine internals

4. **Explicit versioned artifacts**
   - configs, runs, datasets, and validation results should all be versioned and attributable

5. **Small extraction, not rewrite theater**
   - pull coherent modules out of the monolith in slices
   - prove parity at each step

6. **Promotion by evidence**
   - new adaptive rules or engine changes only promote after replay sentinel validation

---

## Target End State

The target architecture should look like this:

### A. Market Context Layer

Responsible for:

- historical and live candles
- market events
- market internals
- sector context
- ticker profile context

Output:

- a stable `MarketContext` contract used by both live and replay

### B. Analysis Layer

Responsible for:

- multi-timeframe indicator assembly
- LTF/HTF structure
- divergence, phase, exhaustion, cloud state, ST state, ATR ladders
- regime classification

Output:

- a stable `TradeContext` contract

### C. Entry Engine

Responsible for:

- selective entry gating
- path selection
- confirmation checks
- anti-chase / anti-exhaustion / anti-divergence logic

Output:

- `EntryDecision`

### D. Trade Planning Layer

Responsible for:

- position sizing
- SL assignment
- TP tiers
- trim intent
- runner intent

Output:

- `TradePlan`

### E. Lifecycle Engine

Responsible for:

- defend
- trim
- trail
- runner protection
- exit sequencing
- state transitions and reason attribution

Output:

- `LifecycleDecision`

### F. Run / Replay Orchestrator

Responsible for:

- dataset freeze
- config freeze
- run registration
- replay state isolation
- checkpointing
- archival
- deterministic metrics

Output:

- `RunArtifact`

### G. Intelligence Layer

Responsible for:

- ticker profiles
- regime profiles
- path performance
- calibration
- AI CIO
- memory and reference priors

Output:

- explicit advisory overlays, not implicit mutation everywhere

### H. Product Read Models

Responsible for:

- analysis snapshot
- right rail detail model
- active trader kanban model
- daily brief model
- investor model
- autopsy model
- runs/system intelligence model

Output:

- stable UI payloads decoupled from engine internals

---

## Phased Plan

## Phase 1: Freeze The Truth

**Goal:** establish authoritative contracts before more tuning.

### Deliverables

- Write a system contract document for:
  - `MarketContext`
  - `TradeContext`
  - `EntryDecision`
  - `TradePlan`
  - `LifecycleDecision`
  - `RunArtifact`
- Define one canonical regime vocabulary and mapping table
- Define one canonical ticker profile contract and explicitly separate static defaults from learned data
- Define replay/live parity rules:
  - allowed differences
  - forbidden differences
  - required snapshots
- Define authoritative run identity:
  - dataset version
  - config version
  - code version
  - engine version

### Why first

Without this, every "fix" is still ambiguous because the system does not have a strict definition of what each layer owns.

### Exit criteria

- a new engineer can explain the trading flow without reverse-engineering `worker/index.js`
- replay and live can be compared against the same named contracts

---

## Phase 2: Harden Replay And Backtest Infrastructure

**Goal:** make backtests deterministic, isolated, and trustworthy.

### Deliverables

- Introduce a run manifest that freezes:
  - code revision
  - config snapshot
  - dataset window
  - enabled overlays
  - engine selection
- Separate replay state from live state completely
- Eliminate stale KV/archive rehydration in fresh validation lanes
- Add sentinel regression suite for named trades and months:
  - `RIOT`
  - `GRNY`
  - `FIX`
  - `SOFI`
  - `CSCO`
  - `SWK`
- Create deterministic validation commands and operator flow
- Make "current active run" authoritative in one place only

### Why second

There is no value in tuning strategy or extracting modules if the validation harness itself is unreliable.

### Exit criteria

- a fresh run can be launched without hidden state contamination
- the same run manifest produces materially identical results
- sentinel trades can be checked automatically before promotion

---

## Phase 3: Extract The Trading Spine From The Monolith

**Goal:** reduce fragility by moving engine responsibilities into strict modules.

### Deliverables

- Extract a dedicated lifecycle service from `worker/index.js`
- Remove dual-path TT Core lifecycle behavior where possible
- Make entry and lifecycle decisions pure-function oriented wherever practical
- Create a formal engine boundary:
  - input contract
  - decision contract
  - side-effect adapter contract
- Move order sizing, SL/TP planning, and lifecycle reason attribution behind explicit interfaces

### Suggested extraction order

1. lifecycle state machine
2. trade planning
3. replay/run orchestration helpers
4. engine dispatch/bootstrap

### Why this order

Lifecycle drift has been one of the biggest sources of backtest pain and winner fragmentation.

### Exit criteria

- entry and lifecycle can be tested without booting the entire worker
- changing lifecycle logic no longer requires touching route orchestration

---

## Phase 4: Unify Intelligence And Adaptive Controls

**Goal:** make regime/profile/memory/CIO adaptation coherent and auditable.

### Deliverables

- Unify static and learned ticker profile usage behind one resolver
- Create one regime-resolution service used by:
  - engine
  - CIO
  - calibration
  - autopsy
  - investor mode
- Define advisory overlay precedence:
  - hard guard
  - sizing adjustment
  - SL/TP adjustment
  - lifecycle bias
  - informational only
- Require every adaptive decision to record:
  - source
  - reason
  - confidence
  - affected fields
- Treat AI CIO as a governed advisory layer, not a hidden alternate engine

### Why this matters

You want the system to adapt by market regime and ticker character, but that only works if the adaptation logic is traceable and bounded.

### Exit criteria

- any trade can explain which adaptive layers influenced it
- calibration outputs map cleanly into runtime behavior

---

## Phase 5: Build Stable Product Read Models

**Goal:** decouple user-facing surfaces from engine implementation details.

### Deliverables

- Define stable backend payloads for:
  - Analysis snapshot
  - Bubble Map
  - Right Rail
  - Active Trader Kanban
  - Alerts
  - Investor Mode
  - Trade Autopsy
  - System Intelligence
  - Daily Brief
- Replace ad hoc payload stitching with explicit read-model builders
- Ensure each surface reads from archived run data or live state intentionally, not incidentally
- Standardize lineage, timestamps, and reason fields across surfaces

### Why this matters

If read models are stable, UI/admin development becomes safer and the engine can evolve without repeatedly breaking the surfaces.

### Exit criteria

- UI surfaces no longer rely on incidental worker-side state shape
- autopsy, runs, alerts, and live mode agree on the same trade truth

---

## Phase 6: Introduce A Controlled Regime-Aware Optimization Loop

**Goal:** resume intelligent iteration only after the platform can support it safely.

### Deliverables

- Define official regime buckets and promotion criteria
- Build regime-specific validation packs
- Use calibration and deep-system-tune outputs as candidate overlays, not auto-truth
- Add promotion workflow:
  - candidate generated
  - sentinel validated
  - monthly validated
  - archived
  - promoted
- Create a comparison console in System Intelligence for run-to-run evidence

### Why this is last

You already have strong ideas and signal coverage. What is missing is the reliable framework to iterate without losing trust or progress.

### Exit criteria

- you can evolve July behavior without accidentally breaking December
- regime overlays can be introduced and rolled back safely

---

## Priority Order

If we do this correctly, the priorities should be:

1. replay/backtest determinism
2. lifecycle and engine contract extraction
3. unified profile/regime/adaptation contract
4. stable read models for product surfaces
5. regime-aware optimization and automation

This means **no broad new feature expansion** until Phases 1 and 2 are materially complete.

---

## Immediate Workstream Recommendation

The next active workstream should be:

### Workstream A: Platform Truth And Replay Integrity

This is the shortest path to restoring confidence.

#### Scope

- define contracts
- freeze run manifest
- isolate replay state
- add sentinel validations
- fix authoritative run ownership

#### Explicitly not in scope

- broad new strategy experiments
- broad UI redesign
- new intelligence features
- major investor-mode expansion

#### Success signal

You can run a clean validation lane and trust the result enough to use it for promotion and further tuning.

---

## Risks If We Do Not Do This

- strategy iteration remains slow and emotionally expensive
- replay/backtest outcomes remain disputable
- adaptive logic becomes harder to reason about over time
- UI/admin surfaces will continue exposing inconsistent truths
- onboarding users before hardening increases regression risk and operational stress

---

## Recommendation

Proceed with a **bounded hardening sprint**, not a full rewrite and not more unstructured iteration.

The trading engine should remain the core of the product, but it needs to be surrounded by stricter contracts, deterministic replay infrastructure, and stable read models. Once that spine is hardened, the rest of the platform becomes much easier to improve with confidence.

---

## Proposed Next Planning Step

Turn this architecture plan into an execution plan with:

1. phase owners
2. concrete deliverables by file/module
3. validation gates for each phase
4. a first 1-2 week hardening sprint focused only on Phases 1 and 2
