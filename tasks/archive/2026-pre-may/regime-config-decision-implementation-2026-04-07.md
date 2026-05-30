# Regime Config Decision Implementation

Date: 2026-04-07

## Scope

This document records the concrete implementation of the approved regime/ticker config plan without editing the plan file itself.

Deliverables completed in this pass:

- authoritative regime and ticker-policy axis defined for tuning work
- reusable evidence builder added in `scripts/build-regime-evidence-matrix.js`
- current live-run evidence artifact generated under `data/regime-config-decision/`
- explicit promotion rules written for baseline vs regime vs profile vs symbol-exception changes

## 1. Authoritative Policy Axis

The codebase already had several competing regime surfaces. For tuning and promotion decisions, use this hierarchy:

1. Primary tuning axis: `MarketContext.regime.executionClass`
2. Secondary context: `MarketContext.vix.tier`
3. Diagnostic-only context: `swingCombined` and `marketBackdropClass`
4. Ticker adaptation axis: static behavior profile first, learned personality second

This aligns with the canonical contract in `tasks/system-contract-package-2026-04-05.md` and keeps tuning anchored on the decision-time contract rather than month-only proxies.

### Runtime-to-policy mapping

| Source | Policy use |
|---|---|
| `signal_snapshot_json.lineage.regime_class` and related `regime.*` fields | `executionClass` |
| VIX-at-entry in lineage/snapshot | `vix.tier` |
| `signal_snapshot_json.regime.combined` and backdrop labels | diagnostic-only |
| `ticker_character.static_behavior_profile.key` | primary ticker adaptation bucket |
| `ticker_character.learned_profile.personality` | secondary profile overlay bucket |

### Files that remain authoritative

- `worker/regime-vocabulary.js`
- `worker/profile-resolution.js`
- `worker/onboard-ticker.js`
- `worker/index.js`
- `tasks/system-contract-package-2026-04-05.md`

## 2. Evidence Matrix Implementation

Added:

- `scripts/build-regime-evidence-matrix.js`

What it does:

- fetches either the active live run (`--live`) or archived run IDs (`--run-ids`)
- reads the run-scoped trade autopsy endpoint
- normalizes each trade into one policy record
- groups performance by:
  - month
  - `executionClass`
  - `vix.tier`
  - static behavior profile
  - learned personality / policy profile class
  - setup grade
  - entry path
  - ticker loss concentration
- emits both JSON and Markdown artifacts
- produces a first-pass overlay assessment and promotion-rule bundle

The script intentionally uses the worker APIs rather than direct ad hoc D1 shell queries so it can be rerun consistently during live monitoring.

### Generated artifact for the current run

Generated from:

```bash
node scripts/build-regime-evidence-matrix.js \
  --live \
  --output-json data/regime-config-decision/live-run-regime-evidence-20260407.json \
  --output-md data/regime-config-decision/live-run-regime-evidence-20260407.md
```

Artifacts:

- `data/regime-config-decision/live-run-regime-evidence-20260407.json`
- `data/regime-config-decision/live-run-regime-evidence-20260407.md`

## 3. Current Live-Run Evidence

Source artifact: `data/regime-config-decision/live-run-regime-evidence-20260407.json`

### Headline stats

- Run: `full-jul-apr-v6-intu-jci-runtimefix-v1`
- Closed trades: `91`
- Wins / losses: `39 / 52`
- Win rate: `42.9%`
- Realized PnL: `$5,278.65`
- Profit factor: `1.78`
- Coverage:
  - `executionClass`: `100%`
  - `vix.tier`: `100%`
  - `swingCombined`: `0%`

### Month stability

- `2025-07`: `+$4,296.80`, `66.7%` WR
- `2025-08`: `+$871.96`, `23.1%` WR
- `2025-09`: `-$729.04`, `40.0%` WR
- `2025-10`: `+$2,396.95`, `57.9%` WR
- `2025-11`: `-$1,558.03`, `0.0%` WR

Conclusion:

- universal-only is not stable enough
- month behavior remains environment-sensitive
- the run is still profitable because winners are materially larger than losers

### Execution-regime evidence

- `TRENDING`: `43` closed, `46.5%` WR, `+$3,451.04`
- `TRANSITIONAL`: `38` closed, `39.5%` WR, `+$1,222.60`
- `CHOPPY`: `10` closed, `40.0%` WR, `+$605.00`

Interpretation:

- the current run does not show a regime bucket that is outright net-negative
- but the large month-to-month instability still points to environment sensitivity
- regime overlays are justified, but they should be tuned to improve consistency rather than to rescue one obviously broken bucket

### Profile evidence

Static profile classes:

- `DEFAULT`: `71` closed, `39.4%` WR, `+$3,077.23`
- `HIGH_VOL`: `5` closed, `80.0%` WR, `+$1,904.03`
- `CHURNER`: `5` closed, `80.0%` WR, `+$442.56`
- `CATASTROPHIC`: `4` closed, `0.0%` WR, `-$390.43`

Learned/profile overlay classes:

- `LEARNED_VOLATILE_RUNNER`: `59` closed, `42.4%` WR, `+$4,917.06`
- `LEARNED_PULLBACK_PLAYER`: `26` closed, `30.8%` WR, `-$1,272.94`
- `LEARNED_MODERATE`: `5` closed, `100%` WR, `+$708.36`

Interpretation:

- profile-class evidence is real, especially `LEARNED_PULLBACK_PLAYER`
- ticker adaptation should stay profile-based before turning into symbol-specific config branches

### Setup-grade evidence

- `SPECULATIVE`: `56` closed, `46.4%` WR, `+$5,232.82`
- `CONFIRMED`: `21` closed, `33.3%` WR, `-$448.01`
- `PRIME`: `14` closed, `42.9%` WR, `+$493.83`

Interpretation:

- the current `CONFIRMED` bucket is weaker than it should be
- this is a baseline logic warning, not a reason to create symbol-specific config branches

### Symbol concentration

Top current loss concentration:

- `TEM`: `-$845.80`
- `B`: `-$512.21`
- `SWK`: `-$418.35`
- `SLV`: `-$397.40`
- `UTHR`: `-$380.52`

Interpretation:

- symbol exceptions can be reviewed diagnostically
- they are not yet the right primary tuning layer

## 4. Overlay Model Decision

### Universal baseline only

Decision: reject as the sole strategy

Why:

- two monthly buckets are net negative
- the strategy is profitable, but not stable enough month to month

### Baseline plus regime overlays

Decision: promote as the next tuning layer

Why:

- current run is profitable but regime-sensitive
- month instability is too large to treat as noise
- the canonical regime axis is now aligned and measurable from live/autopsy evidence

### Baseline plus regime plus profile overlays

Decision: keep as the second adaptive layer, after regime overlays

Why:

- profile evidence is meaningful, especially for `LEARNED_PULLBACK_PLAYER`
- it is more defensible than symbol-specific tuning
- it still needs to preserve crown-jewel winners in `TRENDING` / volatile-runner buckets

### Symbol exceptions

Decision: diagnostic-only until broader layers fail

Why:

- current outliers are visible, but not yet strong enough to justify a config branch explosion
- symbol rules should remain rare and evidence-backed

## 5. Promotion Rules

Use these rules for future changes:

### Baseline change

Promote to baseline when:

- the failure mode appears across multiple months or across at least two profile classes
- the fix improves stability without cutting top-decile winners

### Regime overlay

Promote to regime overlay when:

- the issue clusters in one canonical `executionClass` or `vix.tier`
- it reproduces across at least two windows
- the overlay improves profit factor or net PnL
- crown-jewel winners remain intact

### Profile overlay

Promote to profile overlay when:

- the issue remains after baseline and regime tuning
- it clusters in a profile class with enough closed trades to avoid one-symbol overfitting
- the behavior belongs to the class, not just one ticker

### Symbol exception

Promote to a symbol exception only when:

- the ticker remains an outlier after profile treatment
- the failure mode is repeated and durable
- the issue cannot be explained better by baseline, regime, or profile logic

## 6. Operational Next Use

For future comparison lanes:

1. Generate a regime evidence artifact for the candidate run.
2. Compare it against the protected baseline or current live lane.
3. Decide whether the next refinement belongs in:
   - baseline
   - regime overlay
   - profile overlay
   - diagnostic-only symbol review

This keeps the engine from drifting into a large, unprovable matrix of bespoke configs while still acknowledging that market environment and ticker personality materially affect outcomes.
