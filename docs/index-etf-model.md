# Index ETF Model (SPY / QQQ / IWM)

Index tickers use a **dedicated entry model**, not stock `tt_core` paths.

## Routing

When `deep_audit_index_model_enabled=true` (default):

1. `evaluateEntry()` detects SPY/QQQ/IWM and calls `evaluateIndexEtfModelEntry()`.
2. Only **`tt_index_etf_swing`** may qualify.
3. Stock paths (`tt_pullback`, `tt_ath_breakout`, `tt_n_test_support`, etc.) are
   rejected via `index_model_stock_path_blocked`.

Legacy Phase-E `indexEtfSwingTrigger` bypass is disabled
(`deep_audit_index_etf_swing_enabled=false`).

## Entry criteria (LONG defaults)

| Gate | Default |
|---|---|
| State | `HTF_BULL_LTF_PULLBACK` only (`pullback_state_only=true`) |
| Rank | ≥ 95 |
| RVOL | ≥ 1.0 |
| Daily | bull stack, above E200 |
| Extension | pct_above_e48 ∈ [1.5%, 4.5%] |
| Slope | e21_slope ∈ [0.4%, 2.0%] |
| LTF | m30 8/9 cloud **above** + 10m 8/9 above/in cloud |

SHORT mirrors with bear stack / bounce state.

## Config keys

See `worker/replay-runtime-setup.js` (`deep_audit_index_model_*`) and
`scripts/push-july-v3-config.mjs`.

## Admission matrix

`tt_index_etf_swing:LONG:Prime` in `phase-c-setup-admission.js` — Confirmed
grade blocked.

## Exit handling

Index swing trades skip `tape_capitulation_force_exit` when
`deep_audit_tape_capitulation_skip_index_swing=true`.

## Module

`worker/pipeline/index-etf-model.js`
