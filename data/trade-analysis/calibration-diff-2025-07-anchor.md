# Calibration diff — anchor vs current pre-prod

| Field | Value |
|---|---|
| Anchor run | `phase-c-slice-2025-07-v1` |
| Compare | current pre-prod `deep_audit_*` |
| Generated | 2026-06-29T11:56:42.449Z |
| Changed keys | 16 |
| Anchor-only keys | 40 |
| Current-only keys | 352 |

## Changed keys (likely WR/selectivity drivers)

| Key | Anchor | Current |
|---|---|---|
| `deep_audit_avoid_hours` | [12,13] | 12,13 |
| `deep_audit_breakeven_mfe_threshold` | 1.0 | 1 |
| `deep_audit_breakout_atr_breakout_enabled` | "1" | 1 |
| `deep_audit_breakout_daily_level_enabled` | "1" | 1 |
| `deep_audit_breakout_ema_stack_enabled` | "1" | 1 |
| `deep_audit_breakout_min_entry_quality` | "40" | 40 |
| `deep_audit_breakout_min_rr` | "1.5" | 1.5 |
| `deep_audit_max_loss_pct` | {"normal":-3,"pdz":-5} | [object Object] |
| `deep_audit_mfe_safety_trim_pct` | 2.0 | 2 |
| `deep_audit_post_trim_trail_pct` | 2.0 | 2 |
| `deep_audit_regime_size_mult` | {"LATE_BULL":0.60,"EARLY_BEAR":0.50,"BEAR":0.40} | [object Object] |
| `deep_audit_repeat_churn_guard_include_tickers` | ["GRNY","PH"] | GRNY,PH |
| `deep_audit_runner_trail_pct` | 2.0 | 2 |
| `deep_audit_td_ltf_trail_pct` | 2.0 | 2 |
| `deep_audit_ticker_blacklist` | [] |  |
| `deep_audit_tp_atr_override` | {"trim":2.5,"exit":3.5,"runner":5.0} | [object Object] |
