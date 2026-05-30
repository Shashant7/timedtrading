# August Pressure Zone First Pass [2026-04-11]

## Purpose

Turn the active `Jul -> Sep` savepoint into the first concrete August pressure-zone classification so the next refinement goes through the approved promotion ladder: `baseline` -> `regime` -> `profile` -> `ticker`.

## Inputs

- Savepoint package: `tasks/jul-sep-savepoint-2026-04-11-postdeploy.md`
- Evidence matrix artifact: `data/regime-config-decision/jul-sep-savepoint-regime-evidence-20260411.json`
- Evidence matrix summary: `data/regime-config-decision/jul-sep-savepoint-regime-evidence-20260411.md`
- Trade archive: `data/backtest-artifacts/focused-jul-sep-mainline-deterministic-postdeploy-v1-20260411--20260411-082805/trade-autopsy-trades.json`

## Headline Facts

- The savepoint remains profitable overall: `61` closed trades, `60.7%` win rate, `+$5,396.41`.
- August is the only red month: `18` closed trades, `10W / 8L`, `-$348.10`, profit factor `0.72`.
- The evidence matrix already recommends `regime_overlay` as the first promotion layer.
- Profile overlays and symbol exceptions remain secondary because the August damage is concentrated in one context cluster before it is concentrated in one name.

## August Loss Board

Largest August losers from the savepoint archive:

- `AGQ` `-$503.50` `tt_pullback` `HARD_LOSS_CAP`
- `FIX` `-$252.10` `tt_pullback` `STALL_FORCE_CLOSE`
- `AGQ` `-$236.34` `tt_pullback` `below_trigger,sl_breached`
- `CDNS` `-$101.01` `tt_momentum` `SMART_RUNNER_SUPPORT_BREAK_CLOUD`
- `PH` `-$57.70` `tt_momentum` `SMART_RUNNER_SUPPORT_BREAK_CLOUD`
- `SWK` `-$43.06` `tt_momentum` `SMART_RUNNER_SUPPORT_BREAK_CLOUD`
- `IESC` `-$41.59` `tt_pullback` `SMART_RUNNER_SUPPORT_BREAK_CLOUD`

Per-ticker August net PnL confirms that the damage is led by `AGQ`, with a secondary cluster in `CDNS`, `PH`, `FIX`, `SWK`, and `IESC`.

## Classification Evidence

### 1. Baseline

Not the first target.

- August `tt_pullback` is negative (`10` trades, `-$560.82`), but `tt_pullback` is strongly positive across the full savepoint (`32` trades, `+$4,686.52`, PF `4.17`).
- August `tt_momentum` is still positive in aggregate (`8` trades, `+$212.71`), even though several individual losses exist.
- This does not support a global baseline downgrade of either setup family.

### 2. Regime

Primary candidate bucket.

- August `TRANSITIONAL` trades: `9` trades, `-$750.86`, `3W / 6L`
- August `TRENDING` trades: `7` trades, `+$190.66`, `5W / 2L`
- Full-savepoint regime matrix: `TRANSITIONAL` is the only negative execution regime bucket with usable sample size (`21` closed, `-$433.37`, PF `0.73`).

The strongest August concentration is not just ticker regime alone, but the adaptive execution-profile cluster already being selected at runtime:

- `choppy_selective + TRANSITIONAL + balanced + VOLATILE_RUNNER`: `4` trades, `-$824.48`
- `choppy_selective + TRANSITIONAL + balanced + PULLBACK_PLAYER`: `1` trade, `-$57.70`

That is the clearest evidence that the next refinement belongs on the regime/profile behavior surface instead of on the universal baseline.

### 3. Profile

Secondary, diagnostic-only for now.

- August learned-profile cluster `VOLATILE_RUNNER`: `12` trades, `-$422.96`
- August learned-profile cluster `PULLBACK_PLAYER`: `2` trades, `-$158.71`

These are meaningful, but the engine is already routing many of those names into the same `choppy_selective` capital-protection profile. That makes profile a useful lens, not yet the first promotion surface.

### 4. Ticker-Specific

Hold as diagnostic until the regime pass is tested.

- `AGQ` remains the single largest August outlier at `-$567.82`.
- `FIX`, `CDNS`, `PH`, `SWK`, and `IESC` are meaningful follow-up names, but they do not yet justify leading with symbol exceptions.
- The matrix itself rates symbol exceptions as `diagnostic_only`.

## Decision

The first August refinement should be treated as a `regime_overlay` candidate with profile-aware interpretation, not as:

- a universal baseline change
- a pure profile promotion
- a ticker-exception package

## Promotion Order

1. Prepare one narrow runtime candidate on the `choppy_selective` / `TRANSITIONAL` protection surface.
2. Validate it first on the August pressure board rather than widening immediately.
3. Only if that fails to explain `AGQ`-led damage should the next pass split into profile or ticker-specific exceptions.

## Immediate Follow-Up

The first prepared runtime candidate is captured in:

- `tasks/first-variable-runtime-policy-candidate-2026-04-11.md`
- `data/regime-config-decision/august-transitional-choppy-selective-candidate-v1-20260411.json`
