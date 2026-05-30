# Variable Runtime Policy Map

Date: 2026-04-11

## Purpose

Map the approved evidence outputs onto the runtime surfaces that already exist in the engine.

This document exists to prevent two bad outcomes:

- creating a parallel adaptive system when the current engine already has policy seams
- pushing evidence into the wrong layer and creating hard-to-explain behavior drift

## Runtime Precedence

Use this precedence when more than one policy surface could apply:

1. exact reference execution
2. ticker/date-window reference execution
3. ticker learning policy
4. scenario execution policy
5. dynamic engine rules by regime / direction / sector
6. regime params and adaptive gates
7. global engine defaults

This matches the actual resolution order already present in:

- `worker/index.js`

## Primary Runtime Surfaces

### 1. `reference_execution_map`

Code surface:

- `_resolveReferenceExecution()` in `worker/index.js`

Best use:

- exact replay parity
- specific ticker/date-window playbooks
- narrow high-confidence exception windows

Good for:

- reproducible reference behavior
- exact or near-exact entry windows
- preserving known important historical paths

Not ideal for:

- broad regime intelligence
- general month-wide adaptation logic

## 2. ticker learning runtime policy

Code surface:

- `_resolveTickerLearningPolicy()` in `worker/index.js`
- `_applyTickerLearningPolicyGuard()` in `worker/index.js`
- `ticker_profiles.learning_json.runtime_policy`

Best use:

- early ticker-specific policies
- ticker-specific guard bundles
- per-ticker entry/management recommendations when evidence is strong enough

Good for:

- explicit ticker behavior differences
- attaching policy choice to learned ticker personality
- reversible early ticker-specific experimentation

Guardrail:

- use only when the evidence matrix says a ticker-specific rule is stronger than regime/profile explanations

## 3. `scenario_execution_policy`

Code surface:

- `_resolveScenarioExecutionPolicy()` in `worker/index.js`

Best use:

- context-aware recommendations driven by:
  - ticker
  - direction
  - entry path
  - regime
  - VIX bucket
  - RVOL bucket
  - market state

Good for:

- mapping a variable-aware matrix row into recommended:
  - `entry_engine`
  - `management_engine`
  - `guard_bundle`
  - `exit_style`

This should be the main runtime target for v1 policy promotion.

## 4. dynamic engine rules

Code surface:

- `resolveEntryEngine()` in `worker/index.js`
- `rules.regime_direction_sector_rules`

Best use:

- broad entry-engine routing by:
  - regime
  - direction
  - sector

Good for:

- regime/sector-level engine selection
- broad context shifts without going ticker-specific

Guardrail:

- reserve this for evidence that generalizes beyond one or two symbols

## 5. `regime_params`

Code surface:

- populated in `worker/indicators.js`
- consumed in `worker/index.js`
- exposed in `worker/pipeline/trade-context.js`

Best use:

- scalar behavior changes rather than engine swaps

Good targets:

- `minHTFScore`
- `minRR`
- `maxCompletion`
- `positionSizeMultiplier`
- `requireSqueezeRelease`
- `defendWinnerBias`
- `slCushionMultiplier`
- `rvolDeadZone`

This is the right surface for:

- hold shorter / hold longer
- wider or tighter SL cushion
- more or less aggressive defer behavior
- size adjustments by regime

## 6. profile resolution context

Code surface:

- `resolveTickerProfileContext()` in `worker/profile-resolution.js`
- `buildTradeContext()` in `worker/pipeline/trade-context.js`

Best use:

- providing the context that downstream policies read

Important outputs:

- `staticBehaviorProfile`
- `profile`
- `profileResolution`
- `ticker_character` lineage

Use this layer to explain behavior, not to carry most policy branching by itself.

## Recommended Policy Routing

### Baseline fix

Route into:

- core engine logic
- shared guards
- shared lifecycle logic

### Regime overlay

Route into:

- `scenario_execution_policy`
- dynamic engine rules
- `regime_params`

### Profile overlay

Route into:

- `scenario_execution_policy`
- `ticker_profiles.learning_json.runtime_policy`
- `regime_params` when the effect is scalar rather than categorical

### Ticker-specific exception

Route into:

- `ticker_profiles.learning_json.runtime_policy`
- `reference_execution_map` for narrow windows only

Avoid pushing ticker-specific early work into broad dynamic engine rules.

## What Not To Use As The Main Policy Layer

### Static behavior profile map

Code surface:

- `STATIC_BEHAVIOR_PROFILE_MAP` in `worker/profile-resolution.js`

Use as:

- fallback characterization only

Do not use as:

- the main evolving policy engine

### Direct ad hoc config mutation

Do not scatter new behavior across unrelated deep-audit keys before the policy target is classified.

First decide:

- is this an engine-selection question
- a context recommendation question
- or a scalar-threshold question

Then place it in the correct surface.

## Practical Examples

### Example A: fresh HTF EMA cross vs mature continuation

Likely routing:

- context recognition through `buildTradeContext()`
- recommendation through `scenario_execution_policy`
- holding bias and exit-defer style through `regime_params.defendWinnerBias` or `exit_style`

### Example B: ticker respects 200 EMA loosely and sweeps often

Likely routing:

- evidence stored in ticker profile / learning policy
- ticker-specific management recommendation through `ticker_profiles.learning_json.runtime_policy`
- only promote if cumulative reruns keep July and September intact

### Example C: high-VIX hostile month favors shorter holds

Likely routing:

- regime / VIX bucket in `scenario_execution_policy`
- supporting scalar changes in `regime_params`

## Immediate Working Rule

For the next implementation cycle:

- use the evidence matrix to classify the policy layer first
- use `scenario_execution_policy` as the main v1 carrier for variable-aware recommendations
- use ticker learning policy for early ticker-specific exceptions
- use `reference_execution_map` only when the rule truly belongs to a narrow historical reference window
