# Timed Trading System Hardening Execution Plan

**Date:** 2026-04-05
**Depends on:** `tasks/system-architecture-stabilization-plan-2026-04-05.md`
**Purpose:** Convert the architecture plan into a concrete execution sequence with sprint scope, module-level deliverables, validation gates, and task ordering.

---

## Mission

Restore trust in the platform by hardening the trading-engine spine before doing further broad strategy iteration.

This execution plan is designed to answer four questions clearly:

1. what gets done first
2. where the work lands in the codebase
3. how each phase is verified
4. what is explicitly out of scope until the spine is stable

---

## Sprint Goal

The first sprint is a **hardening sprint**, not a feature sprint.

### Primary outcome

At the end of the sprint, the system should be able to:

- launch a clean run with a frozen manifest
- isolate replay state from stale/live contamination
- explain which engine/config/profile/regime inputs were active
- validate a small sentinel basket before broader reruns

### Non-goals

The following are intentionally out of scope for this sprint:

- broad new strategy ideas
- large UI redesigns
- new product surfaces
- broad calibration promotion
- full refactor of every worker route

---

## Priority Order

The execution order is:

1. **Contracts and invariants**
2. **Replay/backtest determinism**
3. **Lifecycle extraction seam**
4. **Adaptive contract unification**
5. **Stable read models for key admin/operator surfaces**

If a later phase becomes blocked by an earlier one, stop and re-plan instead of pushing through.

---

## Workstream A: Contracts And Invariants

**Why first:** The system cannot be stabilized if basic terms such as regime, profile, lifecycle decision, and run identity remain ambiguous.

### Deliverables

1. Define canonical contracts for:
   - `MarketContext`
   - `TradeContext`
   - `EntryDecision`
   - `TradePlan`
   - `LifecycleDecision`
   - `RunManifest`
   - `RunArtifact`
2. Document authoritative sources for:
   - ticker profiles
   - regime resolution
   - model config snapshots
   - replay/live parity rules
3. Create a system glossary that maps old names to canonical names.

### Files / modules

- `tasks/system-architecture-stabilization-plan-2026-04-05.md`
- new docs under `docs/` or `tasks/` for contract definitions
- `worker/pipeline/trade-context.js`
- `worker/index.js`
- `worker/indicators.js`
- `worker/onboard-ticker.js`

### Validation gate

- A reviewer can trace a trade from market data to lifecycle exit using the named contracts alone.
- Each contract has an owner file and an authoritative source defined.

### Exit evidence

- A written contract doc exists.
- A mapping table exists for old runtime names versus canonical names.

---

## Workstream B: Replay / Backtest Determinism

**Why second:** Replay integrity is the foundation for every later decision, including strategy tuning and user trust.

### Deliverables

1. Introduce a `RunManifest` that freezes:
   - code revision
   - config snapshot
   - dataset window
   - engine selection
   - enabled overlays / flags
   - replay mode settings
2. Separate fresh replay state from live and stale run state.
3. Eliminate implicit rehydration for clean validation lanes unless explicitly requested.
4. Make one route/source authoritative for the currently active run.
5. Add a deterministic validation checklist for each run.

### Sentinel basket

The first sentinel basket should include:

- `RIOT`
- `GRNY`
- `FIX`
- `SOFI`
- `CSCO`
- `SWK`

These are not just examples. They are operator-grade probes for different failure classes:

- entry drift
- premature trim
- missing deferral
- over-aggressive breakeven / stop behavior
- structural exit mismatch
- event/earnings protection failure

### Files / modules

- `worker/index.js`
- `scripts/full-backtest.sh`
- `scripts/replay-focused.sh`
- run registry and archival code paths in `worker/index.js`
- any replay state helpers that should be split from `worker/index.js`

### Validation gate

- A fresh validation lane can run without stale trades leaking in.
- The manifest and archive can explain exactly what was run.
- Sentinel diff is generated before any candidate is considered promotable.

### Exit evidence

- Run manifest persisted and fetchable.
- Sentinel comparison artifact generated for at least one controlled run.

---

## Workstream C: Lifecycle Extraction Seam

**Why third:** Lifecycle drift has been one of the most expensive sources of regressions.

### Deliverables

1. Extract lifecycle decision logic behind a named boundary.
2. Reduce dual-path TT Core behavior where lifecycle logic exists both in:
   - `worker/pipeline/tt-core-exit.js`
   - inline management code in `worker/index.js`
3. Make lifecycle outputs explicit:
   - `hold`
   - `defend`
   - `trim`
   - `trail_update`
   - `exit`
4. Standardize reason attribution and lifecycle state mutation.

### Files / modules

- `worker/pipeline/tt-core-exit.js`
- `worker/pipeline/exit-engine.js`
- `worker/index.js`
- possible new module such as `worker/pipeline/lifecycle-engine.js`

### Validation gate

- Focused lifecycle tests can run without needing the full worker route stack.
- A trade’s trim/runner/exit sequence can be explained by one lifecycle decision flow.

### Exit evidence

- Lifecycle seam introduced with minimal parity drift.
- At least one previous regression class has a focused test/probe.

---

## Workstream D: Adaptive Contract Unification

**Why fourth:** Adaptation is useful only when it is bounded, attributable, and safe.

### Deliverables

1. Unify profile resolution so runtime clearly distinguishes:
   - static defaults
   - learned profile
   - context/regime overlay
2. Define a single regime vocabulary or an explicit mapping between regime systems.
3. Introduce overlay precedence:
   - hard block
   - sizing adjustment
   - SL/TP adjustment
   - lifecycle bias
   - informational
4. Record adaptive influence on each trade decision.

### Files / modules

- `worker/onboard-ticker.js`
- `worker/indicators.js`
- `worker/model.js`
- `worker/cio/cio-service.js`
- `worker/cio/cio-memory.js`
- `worker/index.js`

### Validation gate

- A trade can explain whether its behavior came from base engine logic, a learned profile, a regime overlay, CIO advice, or some combination.
- No ambiguity remains between static ticker behavior and learned ticker profile usage.

### Exit evidence

- Resolver flow documented and wired in one place.
- Trade lineage contains explicit adaptive-source metadata.

---

## Workstream E: Stable Read Models

**Why fifth:** Surfaces should become consumers of stable truth, not accidental side effects of engine internals.

### Deliverables

1. Define stable read models for:
   - runs/system intelligence
   - trade autopsy
   - live replay status
   - analysis snapshot
2. Identify which surfaces require engine-truth parity first.
3. Normalize timestamps, lineage fields, and reason labels across payloads.

### First surfaces to harden

1. `react-app/system-intelligence.html`
2. `react-app/trade-autopsy.html`
3. live replay / active run payloads

These are the operator surfaces that must be trustworthy before broader UI refinement.

### Files / modules

- `worker/index.js`
- `react-app/system-intelligence.html`
- `react-app/trade-autopsy.html`
- read-model helper modules if introduced

### Validation gate

- The active run, archived run, and autopsy detail views agree on the same truth for run identity and trade lineage.

### Exit evidence

- Operator surfaces show one authoritative run and consistent trade metadata.

---

## Suggested Sprint Breakdown

## Week 1

### Day 1-2

- finalize contract definitions
- define canonical naming and glossary
- decide where contract docs live

### Day 2-4

- implement `RunManifest`
- wire manifest persistence into run registration/finalization
- isolate clean replay state

### Day 4-5

- produce first deterministic sentinel run
- compare sentinel basket
- document drift classes

## Week 2

### Day 6-7

- extract lifecycle seam
- reduce duplicate lifecycle decision paths

### Day 7-8

- unify profile/regime/adaptive-source resolution
- record adaptive influence into lineage

### Day 9-10

- harden operator read models
- verify `System Intelligence`, `Trade Autopsy`, and live replay truth alignment
- publish sprint summary and next-step recommendation

---

## Validation Gates

Every workstream should pass a gate before the next one becomes primary.

### Gate 1: Contract Readiness

- canonical contracts written
- canonical naming table written
- authoritative sources identified

### Gate 2: Deterministic Replay

- fresh run starts cleanly
- run manifest persisted
- sentinel diff generated
- active run ownership unambiguous

### Gate 3: Lifecycle Cohesion

- lifecycle decision seam exists
- focused probe passes for at least one known prior regression

### Gate 4: Adaptive Attribution

- profile/regime/CIO influence is explicit in lineage
- no unresolved naming collisions in active paths

### Gate 5: Operator Surface Truth

- runs view, autopsy, and live replay agree on run identity and trade truth

---

## Definition Of Done For The Sprint

The sprint is done when all of the following are true:

1. a run can be launched from a frozen manifest
2. a clean validation lane is isolated from stale state
3. sentinel names can be compared automatically
4. lifecycle behavior is traceable through one primary seam
5. operator surfaces agree on active run and run-scoped trade truth

If those five conditions are not met, the sprint is not done.

---

## What Resumes After This Sprint

Only after the sprint passes should the team resume:

- broader July/Aug recovery iteration
- December and monthly regime validation
- calibration promotion
- regime-aware overlay tuning
- user-facing strategy claims

---

## Immediate Next Tasks

The next concrete actions should be:

1. add the hardening sprint items to `tasks/todo.md`
2. update `tasks/PLAN.md` so the sprint becomes the mainline plan
3. start with the contract package and run-manifest work

