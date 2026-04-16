# Timed Trading Canonical Contract Package

**Date:** 2026-04-05
**Status:** Initial contract package for Workstream A
**Purpose:** Define the canonical engine and run contracts that the hardening sprint will use as the source of truth.

**Primary references**
- `tasks/system-architecture-stabilization-plan-2026-04-05.md`
- `tasks/system-hardening-execution-plan-2026-04-05.md`

---

## Why This Exists

Timed Trading already has rich engine behavior, but the same concepts are currently represented by different names and shapes across:

- `worker/index.js`
- `worker/indicators.js`
- `worker/pipeline/trade-context.js`
- `worker/onboard-ticker.js`
- D1 run/archive tables

This package defines:

1. the canonical contract names
2. the authoritative constructor or source for each contract
3. required fields and invariants
4. the mapping from current runtime names to canonical names

This document is meant to reduce ambiguity before further extraction or hardening.

---

## Contract Ownership Rules

### Rule 1: Canonical names win

When a runtime field and a canonical name differ, the canonical name is the design source of truth.

### Rule 2: Constructors are explicit

Every contract must have one authoritative constructor or persistence source.

### Rule 3: Raw inputs are not contracts

Raw worker payloads, KV blobs, and mixed D1 rows are inputs. They do not count as stable contracts unless named here.

### Rule 4: Replay and live use the same contract names

Differences in sourcing are allowed. Differences in contract meaning are not.

---

## Canonical Contract List

The hardening sprint will use these canonical contracts:

1. `MarketContext`
2. `TradeContext`
3. `EntryDecision`
4. `TradePlan`
5. `LifecycleDecision`
6. `RunManifest`
7. `RunArtifact`

---

## 1. MarketContext

### Purpose

Represents the non-position market environment required by the engine at decision time.

### Canonical owner

**Current authoritative constructor:** `buildTradeContext(tickerData, asOfTs)` in `worker/pipeline/trade-context.js`

**Current raw feeders:**
- `assembleTickerData()` in `worker/indicators.js`
- runtime env fields on `tickerData._env`
- replay/live enrichments added in `worker/index.js`

### Canonical shape

```ts
type MarketContext = {
  asOfTs: number
  isReplay: boolean
  internals: object | null
  vix: {
    value: number
    tier: "low" | "elevated" | "high" | "extreme" | "unknown"
  }
  spy: object | null
  cryptoLead: object | null
  eventRisk: object | null
  regime: {
    executionClass: string
    swingMarket: string
    swingSector: string
    swingCombined: string
  }
}
```

### Required invariants

- `asOfTs` must be the effective decision timestamp, not "now by accident."
- `isReplay` must be explicit.
- `vix.tier` must always be derived from an explicit numeric `vix.value` when available.
- `eventRisk` belongs to `MarketContext`, even if currently assembled inside `TradeContext`.

### Current runtime mapping

| Current runtime field | Canonical field |
|---|---|
| `ctx.asOfTs` | `MarketContext.asOfTs` |
| `ctx.isReplay` | `MarketContext.isReplay` |
| `ctx.market.internals` | `MarketContext.internals` |
| `ctx.market.vix` | `MarketContext.vix.value` |
| `ctx.market.vixTier` | `MarketContext.vix.tier` |
| `ctx.market.spy` | `MarketContext.spy` |
| `ctx.market.cryptoLead` | `MarketContext.cryptoLead` |
| `ctx.eventRisk` | `MarketContext.eventRisk` |
| `ctx.regime.class` | `MarketContext.regime.executionClass` |
| `ctx.regime.market` | `MarketContext.regime.swingMarket` |
| `ctx.regime.sector` | `MarketContext.regime.swingSector` |
| `ctx.regime.swing` | `MarketContext.regime.swingCombined` |

### Notes

There is not yet a dedicated `buildMarketContext()` function. For now, `buildTradeContext()` is the authoritative constructor for the canonical `MarketContext`.

---

## 2. TradeContext

### Purpose

Represents the fully normalized decision-time engine input for entry and lifecycle logic.

### Canonical owner

**Authoritative constructor:** `buildTradeContext(tickerData, asOfTs)` in `worker/pipeline/trade-context.js`

### Canonical shape

```ts
type TradeContext = {
  ticker: string
  side: "LONG" | "SHORT" | null
  price: number
  state: string
  asOfTs: number
  isReplay: boolean
  tf: Record<string, object>
  leadingLtf: "10" | "15" | "30"
  leadingLtfLabel: "10m" | "15m" | "30m"
  scores: {
    htf: number
    ltf: number
    rank: number
    rr: number
    completion: number
    phase: number
    fuelLead: number
    fuel30: number
    fuel10: number
    fuelD: number
    primaryFuel: number
  }
  ema: object
  support: object
  flags: object
  tdSequential: object
  patterns: object | null
  regime: object
  market: MarketContext
  profile: LearnedTickerProfile | null
  rvol: object
  divergence: {
    rsi: object | null
    phase: object | null
  }
  pdz: object
  movePhase: object | null
  structureHealth: object | null
  progression: object | null
  fvg: object
  liq: object
  config: {
    engine: "tt_core" | "ripster_core" | "legacy"
    managementEngine: "tt_core" | "ripster_core" | "legacy"
    deepAudit: object
    ripsterTuneV2: boolean
    exitDebounceBars: number
    leadingLtf: string
    cioEnabled: boolean
  }
  raw: object
}
```

### Required invariants

- `TradeContext` is the only pipeline input contract for entry and lifecycle decisions.
- `TradeContext.raw` may exist for compatibility, but business logic should prefer canonical fields first.
- `profile` means learned/runtime-enriched ticker profile only, not static profile defaults.
- `market` must be treated as a nested canonical contract, not a loose bag of env fields.

### Current runtime mapping

The current implementation in `worker/pipeline/trade-context.js` already closely matches the intended canonical contract and should be treated as the current source of truth.

### Notes

This is the most mature contract in the system today and should be the anchor for later extraction work.

---

## 3. EntryDecision

### Purpose

Represents the engine’s entry verdict after evaluating a `TradeContext`.

### Canonical owner

**Current authoritative producers:**
- `evaluateEntry(ctx)` dispatcher in `worker/pipeline/entry-engine.js`
- engine-specific producers such as `worker/pipeline/tt-core-entry.js`

### Canonical shape

```ts
type EntryDecision = {
  qualifies: boolean
  engine: "tt_core" | "ripster_core" | "legacy"
  path: string | null
  reason: string
  confidence: number | null
  direction: "LONG" | "SHORT" | null
  sizing: object | null
  metadata: object
}
```

### Required invariants

- `qualifies` is mandatory.
- `reason` is mandatory on both qualify and reject paths.
- `engine` is mandatory.
- `path` may be null on rejection but must be explicit on qualification.
- `metadata` should hold diagnostics, not replace first-class fields.

### Current runtime mapping

In `worker/pipeline/tt-core-entry.js`, the current shape already aligns well:

| Current runtime field | Canonical field |
|---|---|
| `qualifies` | `EntryDecision.qualifies` |
| `engine` | `EntryDecision.engine` |
| `path` | `EntryDecision.path` |
| `reason` | `EntryDecision.reason` |
| `confidence` | `EntryDecision.confidence` |
| `direction` | `EntryDecision.direction` |
| `sizing` | `EntryDecision.sizing` |
| `metadata` | `EntryDecision.metadata` |

### Notes

The main hardening need is not the decision shape. It is ensuring all engines honor the same contract and that downstream orchestration does not add ambiguous side channels.

---

## 4. TradePlan

### Purpose

Represents the execution-ready plan produced after an `EntryDecision` qualifies.

### Canonical owner

**Current provisional owner:** trade-creation and order-planning flow inside `worker/index.js`

**Current raw feeders:**
- `assembleTickerData()` in `worker/indicators.js`
- entry decision output
- sizing and profile adjustments in `worker/index.js`

### Canonical shape

```ts
type TradePlan = {
  ticker: string
  direction: "LONG" | "SHORT"
  entryPrice: number
  size: {
    shares: number | null
    notional: number | null
    riskBudget: number | null
    sizingSource: string | null
  }
  stop: {
    initial: number
    source: string
  }
  targets: {
    trim: number | null
    exit: number | null
    runner: number | null
    tiers: object | null
  }
  managementIntent: {
    trimModel: string | null
    runnerBias: string | null
    breakevenPolicy: string | null
  }
  lineage: {
    engine: string
    entryPath: string | null
    executionProfile: string | null
    scenarioPolicySource: string | null
    referenceSource: string | null
  }
}
```

### Required invariants

- `TradePlan` must exist before a trade is persisted or submitted.
- initial stop and target geometry must be attributable to a named source.
- execution lineage must be attached at planning time, not reconstructed later if avoidable.

### Current runtime mapping

Current pieces are spread across:

- `tickerData.sl`
- `tickerData.tp`
- `tickerData.tp_trim`
- `tickerData.tp_exit`
- `tickerData.tp_runner`
- `build3TierTPArray(...)`
- `computeDirectionAwareSL(...)`
- sizing fields generated during trade creation in `worker/index.js`

### Notes

`TradePlan` does not yet exist as a dedicated explicit object. Defining it is a hardening priority because this is where many implicit mutations currently happen.

---

## 5. LifecycleDecision

### Purpose

Represents the trade-management verdict for an already-open position.

### Canonical owner

**Current producers:**
- `evaluateExit(ctx, position)` in `worker/pipeline/exit-engine.js`
- TT Core lifecycle implementation in `worker/pipeline/tt-core-exit.js`
- inline lifecycle and management code in `worker/index.js`

### Canonical shape

```ts
type LifecycleDecision = {
  action: "hold" | "defend" | "trim" | "trail_update" | "exit" | "just_entered"
  reason: string
  family: string
  metadata?: object
}
```

### Required invariants

- every lifecycle decision must have `action`, `reason`, and `family`
- `trim` and `exit` are distinct actions
- `defend` means risk should tighten or posture should change, but not close immediately
- `hold` means no state transition besides normal trailing/metrics maintenance
- `trail_update` is canonical even if current code often mutates trailing state without returning a dedicated action

### Current runtime mapping

In `worker/pipeline/tt-core-exit.js`, decisions are currently returned via helper `result(...)` and already carry:

| Current runtime field | Canonical field |
|---|---|
| `action` | `LifecycleDecision.action` |
| `reason` | `LifecycleDecision.reason` |
| `family` | `LifecycleDecision.family` |
| `metadata` | `LifecycleDecision.metadata` |

### Notes

The contract itself is straightforward. The main issue is that lifecycle ownership is currently split between pipeline code and large inline worker flows.

---

## 6. RunManifest

### Purpose

Represents the immutable launch intent of a replay/backtest run.

### Canonical owner

**Current provisional persistence sources:**
- `backtest_runs`
- `backtest_run_config`
- request body for `POST /timed/admin/runs/register`

### Canonical shape

```ts
type RunManifest = {
  runId: string
  label: string | null
  description: string | null
  codeRevision: string | null
  engineSelection: {
    entryEngine: string
    managementEngine: string
    leadingLtf: string | null
  }
  dataset: {
    startDate: string | null
    endDate: string | null
    intervalMin: number
    tickerBatch: number
    tickerUniverseCount: number
    traderOnly: boolean
    keepOpenAtEnd: boolean
    lowWrite: boolean
  }
  replayMode: {
    isReplay: boolean
    cleanLane: boolean
    rehydrationPolicy: string
  }
  config: {
    source: "registered_snapshot" | "explicit_override"
    snapshotKeys: string[] | null
  }
  tags: string[]
  params: object | null
  createdAt: number
}
```

### Required invariants

- `RunManifest` must describe intent at launch time.
- launch intent must not be overwritten at finalize time.
- config source must be explicit.
- clean-lane versus rehydrating-lane behavior must be explicit.

### Current runtime mapping

| Current field/source | Canonical field |
|---|---|
| `backtest_runs.run_id` | `RunManifest.runId` |
| `backtest_runs.label` | `RunManifest.label` |
| `backtest_runs.description` | `RunManifest.description` |
| `backtest_runs.start_date` / `end_date` | `RunManifest.dataset.startDate` / `endDate` |
| `backtest_runs.interval_min` | `RunManifest.dataset.intervalMin` |
| `backtest_runs.ticker_batch` | `RunManifest.dataset.tickerBatch` |
| `backtest_runs.ticker_universe_count` | `RunManifest.dataset.tickerUniverseCount` |
| `backtest_runs.trader_only` | `RunManifest.dataset.traderOnly` |
| `backtest_runs.keep_open_at_end` | `RunManifest.dataset.keepOpenAtEnd` |
| `backtest_runs.low_write` | `RunManifest.dataset.lowWrite` |
| request `tags` | `RunManifest.tags` |
| request `params` / `params_json` | `RunManifest.params` |
| `backtest_run_config` rows | `RunManifest.config` snapshot |

### Notes

`RunManifest` is not fully implemented yet. The current system has most of the raw pieces but not a single immutable contract object. That is the next implementation step.

---

## 7. RunArtifact

### Purpose

Represents the finalized observed result of a run.

### Canonical owner

**Current authoritative sources:**
- `summarizeRunMetrics(db, runId)` in `worker/index.js`
- `backtest_run_metrics`
- `backtest_run_trades`
- `backtest_run_direction_accuracy`
- `backtest_run_annotations`
- `backtest_run_config`

### Canonical shape

```ts
type RunArtifact = {
  runId: string
  status: string
  summary: {
    totalTickersTraded: number
    totalTrades: number
    wins: number
    losses: number
    breakevens: number
    openTrades: number
    closedTrades: number
    winRate: number
    realizedPnl: number
    realizedPnlPct: number
    avgWinPct: number
    avgLossPct: number
  }
  classifications: Record<string, number>
  byStatus: Record<string, number>
  archivedCounts: {
    trades: number
    directionAccuracy: number
    annotations: number
    config: number
  } | null
  autopsyUrl: string | null
  finalizedAt: number | null
}
```

### Required invariants

- `RunArtifact` must reflect observed results, not launch intent.
- archived counts and summary metrics must refer to the same run identity.
- once finalized, archived results are immutable evidence.

### Current runtime mapping

| Current field/source | Canonical field |
|---|---|
| `summary.run_id` | `RunArtifact.runId` |
| `backtest_runs.status` | `RunArtifact.status` |
| `backtest_run_metrics.*` | `RunArtifact.summary.*` |
| `classifications_json` | `RunArtifact.classifications` |
| `by_status_json` | `RunArtifact.byStatus` |
| archive counts during finalize | `RunArtifact.archivedCounts` |
| `buildTradeAutopsyRunUrl(runId)` | `RunArtifact.autopsyUrl` |
| `backtest_runs.ended_at` | `RunArtifact.finalizedAt` |

---

## Canonical Profile Vocabulary

### 1. StaticBehaviorProfile

This is the static code-defined profile used for coarse defaults.

**Current runtime sources**
- `TICKER_BEHAVIOR_PROFILES`
- `TICKER_PROFILE_MAP`
- `getTickerProfile(sym)` in `worker/index.js`

**Do not call this simply `ticker profile` in docs or contracts.**

### 2. LearnedTickerProfile

This is the D1/KV-loaded profile with calibration and learning data.

**Current runtime sources**
- `loadTickerProfile(env, ticker)` in `worker/onboard-ticker.js`
- `d._tickerProfile`
- `ctx.profile`
- `ticker_profiles.learning_json`

**Canonical rule**
- `TradeContext.profile` means `LearnedTickerProfile`
- static defaults must be referred to as `StaticBehaviorProfile`

---

## Canonical Regime Vocabulary

One of the current confusion points is that "regime" refers to more than one thing.

### Canonical split

1. `ExecutionRegimeClass`
   - trade/ticker regime used by the engine
   - current source: `d.regime_class`, `ctx.regime.class`

2. `SwingRegimeSnapshot`
   - market/sector/combined swing labels carried on ticker payload
   - current source: `d.regime.market`, `d.regime.sector`, `d.regime.combined`

3. `MarketVolatilityRegime`
   - VIX-derived environment label
   - current source: `classifyVixRegime()` / `classifyMarketRegime()` in `worker/index.js`

### Canonical rule

Until a full unification is implemented, these three regime concepts must be referred to separately in code reviews, docs, and lineage.

---

## Canonical Naming Glossary

| Current name | Canonical name | Notes |
|---|---|---|
| `d._tickerProfile` | `LearnedTickerProfile` | runtime-enriched learned profile |
| `ctx.profile` | `LearnedTickerProfile` | canonical profile in pipeline context |
| `getTickerProfile(sym)` | `StaticBehaviorProfileResolver` | static code defaults, not learned profile |
| `d.__ticker_profile` | `StaticBehaviorProfile` | current ambiguous name, should not remain long-term |
| `d.regime_class` | `ExecutionRegimeClass` | engine-facing regime |
| `d.regime.market` | `SwingRegimeSnapshot.market` | swing layer |
| `d.regime.sector` | `SwingRegimeSnapshot.sector` | swing layer |
| `d.regime.combined` | `SwingRegimeSnapshot.combined` | swing layer |
| `classifyVixRegime()` result | `MarketVolatilityRegime` | VIX environment |
| `backtest_runs` row | `RunManifest` + run status shell | mixed today |
| `backtest_run_config` | `RunManifest.config snapshot` | immutable intent snapshot |
| `backtest_run_metrics` | `RunArtifact.summary` | observed metrics |
| `backtest_run_trades` | `RunArtifact.trade archive` | immutable run evidence |

---

## Immediate Implementation Consequences

This contract package implies the following near-term rules:

1. New engine code should prefer canonical names in comments, docs, and helper names.
2. New replay/run work should target `RunManifest` and `RunArtifact` explicitly.
3. New lifecycle extraction work should preserve `LifecycleDecision` as the sole decision contract.
4. Any code path that mixes `StaticBehaviorProfile` and `LearnedTickerProfile` without naming both explicitly should be treated as risky.

---

## Completion Status For Workstream A

### Completed in this package

- canonical contract names defined
- authoritative sources identified
- profile/regime ambiguity documented
- initial glossary written

### Still to do in Workstream A

- implement the contract docs as close-to-code comments or module docs where helpful
- introduce `RunManifest` as an actual persisted object shape, not just a conceptual contract
- clean up the most ambiguous runtime names in implementation code over time

